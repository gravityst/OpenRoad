// Party games: three friends race, play tag and hunt coins, and nobody else
// notices.
//
// Runs the REAL room (server/worker.js around roomcore.js and modes.js), the
// REAL client transport (src/net/net.js) and the REAL game controller
// (src/game/modes.js) for every player, on the real world and its real races.
// Each player is a kinematic driver: it sits still when the game holds it on a
// grid, drives the race line when released, and chases or flees in tag.
//
// Two ways to run it:
//
//   node tools/modescheck.mjs                   in-process, on a simulated clock
//                                               (what checkall runs: ~10 s)
//   node tools/modescheck.mjs --url ws://127.0.0.1:8790
//                                               the same script, in real time,
//                                               against a real local server
//                                               (`npx wrangler dev --port 8790`
//                                               in server/, or node-server.js)
//
// Alongside the whole thing, two protocol-1 clients — the frozen copy of the
// code every cached page in the wild is running — keep driving in their own
// room, and must neither see nor hear a thing.

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const imp = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

const NET = await imp('src/net/net.js');
const NET1 = await imp('tools/fixtures/net-v1/net.js');
const MODES = await imp('src/game/modes.js');
const SMODES = await imp('server/modes.js');
const CORE = await imp('server/roomcore.js');
const PROTO = await imp('src/net/protocol.js');
const { buildWorld } = await imp('src/world/layout.js');
const { createGround } = await imp('src/world/ground.js');
const { generateChallenges } = await imp('src/game/challenges.js');
const { createParty } = await imp('src/game/party.js');

const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : '';
const LIVE = !!argUrl;
const verbose = process.argv.includes('-v') || LIVE;
let failures = 0;
function check(ok, what, detail = '') {
  if (!ok) failures++;
  if (!ok || verbose) console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? '  — ' + detail : ''}`);
  return ok;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log(`modescheck — race your friends, tag, coin rush and emotes${LIVE ? ` (LIVE against ${argUrl})` : ''}`);

// ---------------------------------------------------------------------------
// The world and its races
// ---------------------------------------------------------------------------

const world = buildWorld();
const ground = createGround(world);
const gen = generateChallenges(world, { ground });
const races = gen.list.filter((c) => c.kind === 'race');
const goalsStub = { list: gen.list, byId: gen.byId, nav: null };

// ---- 1. the grid and the coins, on every race in the world -----------------
{
  const bad = [];
  let n = 0;
  for (const c of races) {
    const spots = [];
    for (let s = 0; s < SMODES.MAX_RACERS; s++) {
      const p = MODES.gridSpot(c, s, {});
      n++;
      const r = ground.roadAt(p.x, p.z, {});
      const q = c.route.at(p.d, {});
      const along = Math.cos(p.yaw - Math.atan2(-q.tx, -q.tz));
      if (!r.onRoad) bad.push(`${c.id}#${s} off the road`);
      if (along < 0.99) bad.push(`${c.id}#${s} not facing along the race`);
      if (!c.lap && p.d >= c.start.d) bad.push(`${c.id}#${s} over the start line`);
      for (const o of spots) if (Math.hypot(o.x - p.x, o.z - p.z) < 3.5) bad.push(`${c.id}#${s} on top of another slot`);
      spots.push(p);
    }
  }
  check(bad.length === 0, 'every race has an eight-car grid: on the road, facing the race, behind the line, no two slots touching',
    bad.length ? bad.slice(0, 4).join('; ') : `${races.length} races, ${n} slots`);

  const rng = mulberry(3);
  const bad2 = [];
  for (let k = 0; k < 20; k++) {
    const e = world.edges[(rng() * world.edges.length) | 0];
    const p = e.pts[(e.pts.length / 2) | 0];
    const pts = MODES.pickCoinSpots(world, p.x, p.z, rng);
    if (pts.length < 8) bad2.push(`#${k} only ${pts.length}`);
    for (let i = 0; i < pts.length; i++) {
      if (!ground.roadAt(pts[i][0], pts[i][1], {}).onRoad) bad2.push(`#${k} coin ${i} off the road`);
      for (let j = 0; j < i; j++) if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < 69) bad2.push(`#${k} coins ${i},${j} bunched`);
    }
  }
  check(bad2.length === 0, 'coin rush scatters its coins on roads near the players, spread out',
    bad2.length ? bad2.slice(0, 4).join('; ') : '20 fields of 8-12 coins, every one on a road');
}

// ---- 2. the referee, on its own ------------------------------------------------
//
// Tag decided from positions alone: a car alongside and closing is tagged; a car
// parked six metres away is not; a car that was just put there is not; the new
// IT cannot tag straight back.
{
  let t = 1.7e12;
  const core = CORE.createRoomCore({ proto: 2, now: () => t, rng: () => 0 });
  const got = [];
  const sock = (name) => ({ name, send(d) { if (typeof d === 'string') got.push({ to: name, m: JSON.parse(d) }); }, close() {} });
  const S = { a: sock('a'), b: sock('b'), c: sock('c') };
  for (const k of 'abc') { core.open(S[k]); core.message(S[k], JSON.stringify({ t: 'join', proto: 2, name: k.toUpperCase() + 'ee' })); }
  const id = (k) => core.peerOf(S[k]).id;
  const seq = { a: 0, b: 0, c: 0 };
  const state = (k, x, z, vx = 0, vz = 0) => {
    core.message(S[k], PROTO.encodeState({ x, z, vx, vz, respawnSeq: seq[k] }, (t - 1.7e12) | 0));
  };
  const step = (ms, fn) => { for (let k = 0; k < ms; k += 50) { t += 50; if (fn) fn(); core.tick(); } };
  const last = (kk) => { for (let i = got.length - 1; i >= 0; i--) if (got[i].m.t === 'mode' && (!kk || (got[i].m.ev && got[i].m.ev.k === kk))) return got[i].m; return null; };
  core.message(S.a, JSON.stringify({ t: 'mode', a: 'tag' }));
  core.message(S.b, JSON.stringify({ t: 'mode', a: 'join' }));
  core.message(S.c, JSON.stringify({ t: 'mode', a: 'join' }));
  // Everyone is in: the lobby closes in 3 s, not 10.
  const pos = { a: [0, 0], b: [6, 0], c: [200, 0] };
  const hold = () => { for (const k of 'abc') state(k, pos[k][0], pos[k][1]); };
  step(3100, hold);
  const g = core.modes.game;
  const itFirst = g.it;
  check(g.phase === 'run' && itFirst === id('a'), 'tag starts when everyone is in, 3 s after the last join, with somebody IT',
    `phase ${g.phase}, IT ${itFirst}`);
  // A parked 6 m from B: nothing, however long.
  step(3000, hold);
  const quiet = g.it === id('a');
  // A drives at B at 5 m/s: tagged once inside 4.6 m.
  let tagAt = -1, tagT = 0;
  for (let k = 0; k < 60 && tagAt < 0; k++) {
    step(50, () => { pos.a[0] += 5 * 0.05; state('a', pos.a[0], 0, 5, 0); state('b', 6, 0); state('c', 200, 0); });
    if (g.it === id('b')) { tagAt = pos.a[0]; tagT = t; }
  }
  const gap = 6 - tagAt;
  check(quiet && g.it === id('b') && gap > 3.9 && gap < 4.7,
    'a tag is a car alongside and closing, decided by the room from the positions it relays',
    `parked 6 m away for 3 s: not tagged; driving in at 5 m/s: tagged at ${gap.toFixed(2)} m`);
  // B (now IT) sits right against A: no tag-back for 4 s, then yes.
  let backT = 0;
  const against = () => { state('a', pos.a[0], 0); state('b', 6, 0, -2, 0); state('c', 200, 0); if (!backT && g.it === id('a')) backT = t; };
  while (t < tagT + 5000 && !backT) step(50, against);
  const backAfter = backT - tagT;
  check(backT && backAfter >= 4000 && backAfter < 4200, 'no tag-backs: the new IT cannot tag whoever just tagged them for 4 s, then can',
    backT ? `tagged back ${(backAfter / 1000).toFixed(2)} s later, not before` : 'never tagged back');
  // C respawns right next to A (IT again): a cut is never a tag, for 1.5 s.
  step(2000, () => { state('a', pos.a[0], 0); state('b', 60, 0); state('c', 200, 0); });
  seq.c++;
  const cutT = t;
  let cTag = 0;
  const beside = () => { state('a', pos.a[0], 0); state('b', 60, 0); state('c', pos.a[0] + 1.5, 0); if (!cTag && g.it === id('c')) cTag = t; };
  while (t < cutT + 2500 && !cTag) step(50, beside);
  check(cTag && cTag - cutT >= 1500, 'a car that was just put somewhere (a respawn, Go) cannot be tagged or tag for 1.5 s',
    cTag ? `respawned 1.5 m from IT: tagged ${((cTag - cutT) / 1000).toFixed(2)} s later` : 'never tagged');
  // Scores: time NOT IT.
  const fr = [...g.ps.values()].map((e) => e.free);
  const el = t - 1.7e12;
  check(fr.every((f) => f >= 0 && f <= el) && g.ps.get(id('c')).free > g.ps.get(id('a')).free,
    'the score is time not being IT, counted by the room', `free ${fr.map((f) => (f / 1000).toFixed(1) + ' s').join(', ')}`);
  // The IT player leaves: somebody else is IT at once and the game goes on.
  const itNow = g.it;
  const who = Object.keys(S).find((k) => id(k) === itNow);
  core.close(S[who]);
  step(100, hold);
  check(g.kind === 'tag' && g.phase === 'run' && g.it >= 0 && g.it !== itNow && last('newit'),
    'if IT leaves mid-game, somebody else is IT and the game goes on', `IT ${itNow} left, now ${g.it}`);
  // Down to one: the game ends on a podium.
  const other = Object.keys(S).find((k) => k !== who && id(k) !== g.it) || Object.keys(S).find((k) => k !== who);
  core.message(S[other], JSON.stringify({ t: 'mode', a: 'leave' }));
  step(100);
  check(g.phase === 'done', 'and when only one is left, it ends on a podium', `phase ${g.phase}`);

  // Emotes: presets only, one every 1.2 s, never to yourself.
  got.length = 0;
  const e1 = Object.keys(S).find((k) => core.peerOf(S[k]));
  core.message(S[e1], JSON.stringify({ t: 'emote', e: 2 }));
  core.message(S[e1], JSON.stringify({ t: 'emote', e: 3 }));
  core.message(S[e1], JSON.stringify({ t: 'emote', e: 9 }));
  core.message(S[e1], JSON.stringify({ t: 'emote', e: 'hello' }));
  core.message(S[e1], JSON.stringify({ t: 'emote', e: 1.5 }));
  const heard = got.filter((x) => x.m.t === 'emote');
  check(heard.length === 1 && heard[0].m.e === 2 && heard[0].to !== e1,
    'an emote is one of four presets, rate-limited, and nothing else gets through', `${heard.length} delivered of 5 sent (one valid, one too soon, three malformed)`);

  // Nothing a player typed: a race id that is not an id, a coin field of junk.
  const before = got.length;
  t += 20000;
  core.message(S[e1], JSON.stringify({ t: 'mode', a: 'race', race: 'meet me at the barn', n: 5 }));
  core.message(S[e1], JSON.stringify({ t: 'mode', a: 'race', race: 'stage-0', n: 900 }));
  core.message(S[e1], JSON.stringify({ t: 'mode', a: 'coins', pts: [['a', 1], [2, 3], [4, 5]] }));
  core.message(S[e1], JSON.stringify({ t: 'mode', a: 'coins', pts: [[1e9, 1], [2, 3], [4, 5]] }));
  core.message(S[e1], JSON.stringify({ t: 'mode', a: 'chat', text: 'hi' }));
  check(got.length === before, 'a game can only be started with a real race id or real coin spots: junk is ignored', `${got.length - before} messages out`);

  // A protocol-1 room has no games at all.
  const v1 = CORE.createRoomCore({ proto: 1, now: () => t });
  const o1 = []; const s1 = { send(d) { o1.push(d); }, close() {} };
  v1.open(s1);
  v1.message(s1, JSON.stringify({ t: 'join', name: 'Old' }));
  o1.length = 0;
  v1.message(s1, JSON.stringify({ t: 'mode', a: 'tag' }));
  v1.message(s1, JSON.stringify({ t: 'emote', e: 1 }));
  v1.tick();
  check(v1.modes === null && o1.every((d) => typeof d !== 'string'), 'a protocol-1 room has no party games and says nothing about them');
}

// ---------------------------------------------------------------------------
// The whole thing: players on the real transport, on a clock
// ---------------------------------------------------------------------------

function createSim() {
  const heap = [];
  let seq = 0, now = 0;
  const less = (a, b) => (a.t < b.t || (a.t === b.t && a.s < b.s));
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
    }
    return top;
  };
  return {
    get t() { return now; },
    at(t, fn) { const e = { t: Math.max(t, now), s: seq++, fn, dead: false }; push(e); return e; },
    async run(until) {
      while (heap.length && heap[0].t <= until) { const e = pop(); now = e.t; if (e.dead) continue; const r = e.fn(); if (r && typeof r.then === 'function') await r; }
      now = until;
    },
  };
}

function createRealClock() {
  const t0 = performance.now();
  return {
    get t() { return performance.now() - t0; },
    at(t, fn) { const h = setTimeout(fn, Math.max(0, t - (performance.now() - t0))); return { set dead(v) { if (v) clearTimeout(h); } }; },
    run(until) { return new Promise((r) => setTimeout(r, Math.max(0, until - (performance.now() - t0)))); },
  };
}

const sim = LIVE ? createRealClock() : createSim();
const realDateNow = Date.now, realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
const realResponse = globalThis.Response;
let worker = null, env = null;

if (!LIVE) {
  // A fake Cloudflare runtime around the real Worker, on the simulated clock.
  Date.now = () => Math.floor(1.7e12 + sim.t);
  globalThis.setInterval = (fn, ms) => {
    const h = { dead: false, ev: null };
    const next = () => { h.ev = sim.at(sim.t + ms, () => { if (h.dead) return; next(); fn(); }); };
    next();
    return h;
  };
  globalThis.clearInterval = (h) => { if (h && h.ev) { h.dead = true; h.ev.dead = true; } };
  globalThis.Response = class { constructor(body, init = {}) { this.status = init.status || 200; this.webSocket = init.webSocket || null; } };
  globalThis.WebSocketPair = function () { const s = new ServerEnd(); return { 0: { server: s }, 1: s }; };
  worker = await imp('server/worker.js');
  const rooms = new Map();
  env = {
    rooms,
    ROOM: {
      idFromName: (name) => ({ name }),
      get(idn) {
        let r = rooms.get(idn.name);
        if (!r) {
          const list = [];
          const ctx = { acceptWebSocket(ws) { list.push(ws); ws.room = r; }, getWebSockets() { return list.filter((w) => !w.closed); } };
          r = new worker.Room(ctx, {});
          rooms.set(idn.name, r);
        }
        return r;
      },
    },
  };
}

class ServerEnd {
  constructor() { this.client = null; this.closed = false; this.att = null; }
  send(d) { if (!this.closed && this.client) this.client._from(d); }
  close() { if (this.closed) return; this.closed = true; if (this.client) this.client._closed(); }
  serializeAttachment(v) { this.att = JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this.att; }
}

/** A browser WebSocket, as net.js sees one: 18-30 ms each way, in order. */
function simSocketFactory(salt, heard) {
  const rng = mulberry(salt);
  return (url) => {
    let lastUp = 0, lastDown = 0;
    const lat = () => 18 + rng() * 12;
    const sock = {
      readyState: 0, binaryType: 'blob', onopen: null, onmessage: null, onclose: null, onerror: null, server: null, room: null,
      send(d) {
        if (sock.readyState !== 1) throw new Error('not open');
        const copy = typeof d === 'string' ? d : d.slice(0);
        lastUp = Math.max(lastUp, sim.t + lat());
        sim.at(lastUp, () => { if (sock.server && !sock.server.closed) sock.room.webSocketMessage(sock.server, copy); });
      },
      close() {
        if (sock.readyState === 3) return;
        sock.readyState = 3;
        sim.at(sim.t + lat(), () => { if (sock.server && !sock.server.closed) { sock.server.closed = true; sock.room.webSocketClose(sock.server); } });
      },
      _from(d) {
        if (heard) heard(d);
        lastDown = Math.max(lastDown, sim.t + lat());
        sim.at(lastDown, () => { if (sock.readyState === 1 && sock.onmessage) sock.onmessage({ data: d }); });
      },
      _closed() { sim.at(sim.t + lat(), () => { sock.readyState = 3; if (sock.onclose) sock.onclose({}); }); },
    };
    sim.at(sim.t + lat(), async () => {
      const req = { url, headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? 'websocket' : null) } };
      const res = await worker.default.fetch(req, env);
      if (!res || res.status !== 101) { sock.readyState = 3; if (sock.onclose) sock.onclose({}); return; }
      const server = res.webSocket.server;
      server.client = sock; sock.server = server; sock.room = server.room;
      sim.at(sim.t + lat(), () => { sock.readyState = 1; if (sock.onopen) sock.onopen({}); });
    });
    return sock;
  };
}

/** A real WebSocket that also reports every text message it hears. */
function liveSocketFactory(heard) {
  return (url) => {
    const ws = new WebSocket(url);
    if (heard) ws.addEventListener('message', (ev) => heard(ev.data));
    return ws;
  };
}

// ---- the players --------------------------------------------------------------

const URL0 = LIVE ? argUrl : 'wss://room.test/';
const players = [];

function roadStart(k) {
  // Spread over the map: every player starts somewhere different.
  const es = world.edges.filter((q) => q.kind !== 'track' && q.pts.length > 6);
  const e = es[(k * 37) % es.length];
  const a = e.pts[2], b = e.pts[3];
  return { x: a.x, z: a.z, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) };
}

function addPlayer(name, k, opts = {}) {
  const s = roadStart(k);
  const P = {
    name, x: s.x, z: s.z, yaw: s.yaw, vx: 0, vz: 0, seq: 0, tele: false,
    drive: null, events: [], heard: [], alive: true, holdTrail: [], placed: 0, v1: !!opts.v1,
  };
  const heard = (d) => { if (typeof d === 'string') { try { P.heard.push(JSON.parse(d)); } catch { /* binary */ } } };
  const now = () => sim.t * (1 + (k - 2) * 20e-6) + 1000 * k;       // every clock its own origin and drift
  const factory = LIVE ? liveSocketFactory(heard) : simSocketFactory(100 + k, heard);
  if (opts.v1) {
    P.net = NET1.createNet({ url: URL0, name, now, socketFactory: factory, keepalive: false });
  } else {
    P.net = NET.createNet({ url: URL0, name, carId: 'kaida', colour: k % 5, now, socketFactory: factory, keepalive: false });
    const party = createParty({ net: P.net, world, ground, place: (x, z, yaw) => place(P, x, z, yaw) });
    P.party = party;
    P.modes = MODES.createModes({
      net: P.net, goals: () => goalsStub, world, rng: mulberry(k + 11),
      place: (x, z, yaw) => { place(P, x, z, yaw); P.placed++; },
      colourOf: party.colourFor, goTo: (id) => party.goTo(id),
      self: () => ({ name, carId: 'kaida', colour: k % 5 }),
    });
  }
  const rec = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, wheelSpin: 0, integrity: 1, flags: 0, respawnSeq: 0 };
  let last = sim.t;
  const frame = () => {
    if (!P.alive) return;
    const dt = Math.min(0.1, (sim.t - last) / 1000);
    last = sim.t;
    if (P.modes && P.modes.hold) { P.vx = 0; P.vz = 0; P.holdTrail.push(sim.t); }
    else if (P.drive) P.drive(dt);
    else { P.vx = 0; P.vz = 0; }
    rec.x = P.x; rec.z = P.z; rec.y = ground.heightAt(P.x, P.z) + 0.5; rec.yaw = P.yaw; rec.vx = P.vx; rec.vz = P.vz;
    rec.flags = P.tele ? 64 : 0; rec.respawnSeq = P.seq & 0xff; P.tele = false;
    P.net.update(dt, rec);
    if (P.modes) {
      P.modes.update(dt, P, true);
      for (const e of P.modes.events) P.events.push({ t: sim.t, ...e });
      P.modes.events.length = 0;
      if (P.party) P.party.update(dt, P, null);
    }
    sim.at(sim.t + 16.7, frame);
  };
  sim.at(sim.t + 16.7, frame);
  P.quit = () => { P.alive = false; P.net.dispose(); };
  players.push(P);
  return P;
}

function place(P, x, z, yaw) { P.x = x; P.z = z; P.yaw = yaw; P.seq++; P.tele = true; P.vx = 0; P.vz = 0; }

/** Drive along a route from wherever the car is, at `speed`, keeping its lane offset. */
function raceDriver(P, c, speed) {
  let d = -1, lat = 0;
  const q = {};
  return (dt) => {
    if (d < 0) {
      const pr = c.route.project(P.x, P.z, -1, 0, {});
      d = pr.d;
      c.route.at(d, q);
      lat = (P.x - q.x) * -q.tz + (P.z - q.z) * q.tx;
    }
    d = Math.min(c.route.length + 30, d + speed * dt);
    c.route.at(Math.min(d, c.route.length), q);
    P.x = q.x + -q.tz * lat; P.z = q.z + q.tx * lat;
    P.yaw = Math.atan2(-q.tx, -q.tz);
    P.vx = q.tx * speed; P.vz = q.tz * speed;
    if (d >= c.route.length + 29) { P.vx = 0; P.vz = 0; }
  };
}

/** Straight at (tx, tz) at `speed`, stopping on arrival. */
function towards(P, tx, tz, speed) {
  return (dt) => {
    const dx = tx() - P.x, dz = tz() - P.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { P.vx = 0; P.vz = 0; return; }
    const s = Math.min(speed, d / Math.max(dt, 1e-3));
    P.vx = dx / d * s; P.vz = dz / d * s;
    P.x += P.vx * dt; P.z += P.vz * dt;
    P.yaw = Math.atan2(-dx, -dz);
  };
}

const T = () => sim.t;
const until = async (fn, max, step = 50) => { const end = sim.t + max; while (sim.t < end) { if (fn()) return true; await sim.run(sim.t + step); } return !!fn(); };
const byName = (n) => players.find((p) => p.name === n);
const idOf = (n) => byName(n).net.id;

try {
  const A = addPlayer('Ace', 1), B = addPlayer('Bee', 2), C = addPlayer('Cee', 3);
  const O1 = addPlayer('Old One', 4, { v1: true }), O2 = addPlayer('Old Two', 5, { v1: true });
  O1.drive = towards(O1, () => O1.x + 50, () => O1.z, 10);
  O2.drive = towards(O2, () => O2.x - 50, () => O2.z, 10);
  const ok = await until(() => [A, B, C].every((p) => p.net.serverProto === 2 && p.net.people.size === 2) && O1.net.id > 0 && O2.net.id > 0, 8000);
  check(ok, 'three new pages meet in one room and two old pages in theirs',
    `${[A, B, C].map((p) => `${p.name}#${p.net.id}/${p.net.people.size}`).join(' ')}; old ${O1.net.id}, ${O2.net.id}`);
  await sim.run(sim.t + 1500);            // clocks sync (six quick pings)

  // ==== RACE ===============================================================
  const c = gen.byId[races.find((r) => r.rookie).id] || races[0];
  check(A.modes.startRace(c.id), `Ace starts a race: ${c.name}`, `${(c.length / 1000).toFixed(1)} km, ${c.gates.length} gates`);
  await until(() => B.modes.view.invite && C.modes.view.invite, 1000);
  const inv = B.events.find((e) => e.k === 'invite');
  check(!!inv && inv.id === A.net.id && B.modes.view.name === c.name && B.modes.view.hostName === 'Ace' && C.modes.view.invite,
    'the others get an invite naming who started it and which race', inv ? `Bee: "${B.modes.view.hostName} — ${B.modes.view.name}", ${(B.modes.view.lobbyLeft / 1000).toFixed(1)} s to join` : 'no invite');
  await sim.run(sim.t + 900);
  B.modes.join();
  await sim.run(sim.t + 700);
  C.modes.join();
  await until(() => [A, B, C].every((p) => p.modes.hold), 1500);
  const grid = [A, B, C].map((p) => ({ p, e: p.net.mode.ps.find((q) => q.id === p.net.id) }));
  const slots = grid.map((x) => x.e && x.e.slot);
  let gridBad = [];
  for (const { p, e } of grid) {
    const s = MODES.gridSpot(c, e.slot, {});
    if (Math.hypot(p.x - s.x, p.z - s.z) > 0.01) gridBad.push(`${p.name} not on slot ${e.slot}`);
  }
  check(gridBad.length === 0 && new Set(slots).size === 3 && [A, B, C].every((p) => p.modes.hold),
    'everyone who joins is put on their own grid slot and held there', gridBad.join('; ') || `slots ${slots.join(', ')}`);

  // Bee creeps forward on the grid (as if the hold were not wired): put back.
  const s1 = MODES.gridSpot(c, grid[1].e.slot, {});
  place(B, s1.x - Math.sin(s1.yaw) * 6, s1.z - Math.cos(s1.yaw) * 6, s1.yaw);
  await sim.run(sim.t + 100);
  check(Math.hypot(B.x - s1.x, B.z - s1.z) < 0.01 && B.events.some((e) => e.k === 'jumpstart'),
    'a car that leaves its slot before GO is put straight back on it');

  // GO: the same moment on every screen.
  A.drive = raceDriver(A, c, 31); B.drive = raceDriver(B, c, 27); C.drive = raceDriver(C, c, 23);
  const released = {};
  await until(() => { for (const p of [A, B, C]) if (!p.modes.hold && released[p.name] == null) released[p.name] = sim.t; return Object.keys(released).length === 3; }, 12000, 5);
  const gameGo = A.net.mode.go;
  const goWall = gameGo - A.net.serverNow() + sim.t;      // the room's GO, on the sim clock
  const spread = Math.max(...Object.values(released)) - Math.min(...Object.values(released));
  const offGo = Math.max(...Object.values(released).map((x) => Math.abs(x - goWall)));
  check(spread < 60 && offGo < 80 && A.net.mode.phase === 'run',
    'GO is the room\'s clock: every car is released within a frame or two of the others',
    `released within ${spread.toFixed(0)} ms of each other, ${offGo.toFixed(0)} ms of the room's GO; held ${Object.keys(released).map((n) => n + ' ' + ((released[n] - byName(n).holdTrail[0]) / 1000).toFixed(1) + ' s').join(', ')}`);

  // A late arrival: watches this one, is in the next.
  const D = addPlayer('Dee', 6);
  await until(() => D.net.serverProto === 2 && D.net.mode, 4000);
  D.modes.join();
  await until(() => D.modes.view.watching, 1500);
  check(D.modes.view.watching && !D.modes.view.inGame && D.placed === 0,
    'someone who joins after the start watches this race (and is not dropped onto the grid)', `Dee watching: ${D.modes.view.watching}`);

  // Mid-race: the running order is the same on every screen, and right.
  await sim.run(sim.t + 14000);
  const orders = [A, B, C, D].map((p) => p.modes.view.rows.map((r) => r.name).join('>'));
  check(orders.every((o) => o === 'Ace>Bee>Cee'), 'the live running order is right, and the same on every screen (spectators too)', orders.join(' | '));
  const gates = [A, B, C].map((p) => p.net.mode.ps.find((q) => q.id === p.net.id).g);
  check(gates[0] >= gates[1] && gates[1] >= gates[2] && gates[0] >= 1, 'the room confirms each car\'s gates as it drives through them', `gates ${gates.join('/')} of ${c.gates.length}`);

  // Cee's connection dies mid-race.
  C.quit();
  await until(() => !A.net.mode.ps.some((q) => q.name === 'Cee') && A.net.mode.ps.length === 2 && B.net.mode.ps.length === 2, 12000);
  check(A.net.mode.ps.length === 2 && A.net.mode.phase === 'run', 'a racer who disconnects mid-race drops out; the race goes on', `entrants ${A.net.mode.ps.length}, phase ${A.net.mode.phase}`);

  await until(() => A.net.mode && A.net.mode.phase === 'done', 120000, 100);
  const m = A.net.mode;
  const fin = (p) => m.ps.find((q) => q.id === p.net.id);
  const expectA = (c.length - MODES.gridSpot(c, fin(A).slot, {}).d + 0) / 31 * 1000;
  const ta = fin(A).fin, tb = fin(B).fin;
  check(m.phase === 'done' && fin(A).place === 1 && fin(B).place === 2,
    'the finishing order is the room\'s, and it ends on a podium', `Ace P${fin(A).place} ${MODES.fmtRaceTime(ta)}, Bee P${fin(B).place} ${MODES.fmtRaceTime(tb)}`);
  const podium = [A, B, D].map((p) => p.modes.view.rows.map((r) => `${r.pos}.${r.name}`).join(' '));
  check(podium.every((x) => x === podium[0]) && podium[0].startsWith('1.Ace 2.Bee'), 'every screen shows the same podium', podium[0]);
  const lastGate = c.gates[c.gates.length - 1];
  const truthA = ((lastGate.d - (MODES.gridSpot(c, fin(A).slot, {}).d)) / 31) * 1000;
  check(Math.abs(ta - truthA) < 120, 'race times are true to a tenth, off the synced clock', `Ace ${ta} ms, truth ${truthA.toFixed(0)} ms`);
  void expectA;

  // ==== EMOTES ===============================================================
  B.modes.emote(1);
  await sim.run(sim.t + 300);
  B.modes.emote(3);                      // too soon: the room drops it
  await sim.run(sim.t + 300);
  check(A.modes.say(B.net.id) === 'Follow me!' && D.modes.say(B.net.id) === 'Follow me!' && B.modes.say(B.net.id) === 'Follow me!',
    'an emote shows over the sender\'s car on every screen, their own included', `Ace sees "${A.modes.say(B.net.id)}"`);
  const bubbles = A.heard.filter((x) => x.t === 'emote').length;
  check(bubbles === 1, 'and one every 1.2 s is all a player can send', `${bubbles} heard`);
  await sim.run(sim.t + 3500);
  check(A.modes.say(B.net.id) === '', 'the bubble goes after a few seconds');

  // ==== TAG ================================================================
  for (const p of [A, B, D]) p.drive = null;
  await sim.run(sim.t + 12000);          // the podium clears
  check(!A.net.mode, 'the podium clears by itself', A.net.mode ? A.net.mode.phase : 'idle');
  B.modes.startTag();
  await until(() => A.modes.view.invite && D.modes.view.invite, 1500);
  A.modes.join(); D.modes.join();
  await until(() => [A, B, D].every((p) => p.modes.view.inGame), 2000);
  // Joining from across the map takes you to the host.
  const far = [A, D].map((p) => Math.hypot(p.x - B.x, p.z - B.z));
  check(far.every((d) => d < 60), 'joining tag from far away takes you to the host', far.map((d) => d.toFixed(0) + ' m').join(', '));
  await until(() => A.net.mode && A.net.mode.phase === 'run', 6000);
  await sim.run(sim.t + 50);
  const it0 = A.net.mode.it;
  const itP = [A, B, D].find((p) => p.net.id === it0);
  const badges = [A, B, D].map((p) => p.modes.badge(it0));
  check(it0 > 0 && badges.every((b) => b === 'IT') && itP.modes.view.iAmIt,
    'someone is IT, and every screen knows who', `${itP.name} is IT; badges ${badges.join(',')}`);
  // IT counts to three while everyone else scatters; nobody can be tagged yet.
  const flee = [A, B, D].filter((p) => p !== itP);
  for (const p of flee) {
    const ang = Math.atan2(p.x - itP.x, p.z - itP.z) || (p === flee[0] ? 0 : Math.PI);
    p.drive = towards(p, () => itP.x + Math.sin(ang) * 40, () => itP.z + Math.cos(ang) * 40, 14);
  }
  await sim.run(sim.t + 2800);
  check(A.net.mode.it === it0, 'IT counts to three at the start: nobody can be tagged while they scatter',
    `still ${itP.name} after 2.8 s`);
  for (const p of flee) p.drive = null;
  await sim.run(sim.t + 400);
  // IT chases the nearest and tags them.
  const prey = flee.sort((a, b) => Math.hypot(a.x - itP.x, a.z - itP.z) - Math.hypot(b.x - itP.x, b.z - itP.z))[0];
  itP.drive = towards(itP, () => prey.x, () => prey.z, 9);
  const tagged = await until(() => A.net.mode && A.net.mode.it === prey.net.id, 15000);
  const tagEv = prey.events.find((e) => e.k === 'tag');
  check(tagged && tagEv && tagEv.to === prey.net.id && tagEv.from === itP.net.id,
    'IT drives up to someone and tags them: the pass reaches every screen', tagEv ? `${itP.name} tagged ${prey.name}` : 'no tag');
  itP.drive = null;
  // The new IT turns straight round: no tag-back.
  prey.drive = towards(prey, () => itP.x, () => itP.z, 6);
  await sim.run(sim.t + 2500);
  check(A.net.mode.it === prey.net.id, 'the new IT cannot tag straight back');
  prey.drive = null;
  // The one who is IT now disconnects: someone else is IT, the game goes on.
  const other = [A, B, D].find((p) => p !== prey && p !== itP);
  const preyId = prey.net.id;
  prey.quit();
  await until(() => itP.net.mode && itP.net.mode.it !== preyId && itP.net.mode.it > 0, 3000);
  await sim.run(sim.t + 100);            // events reach a player's log on its next frame
  const gm = itP.net.mode;
  check(gm && gm.kind === 'tag' && gm.phase === 'run' && [itP, other].some((p) => p.net.id === gm.it) &&
    itP.events.some((e) => e.k === 'newit'),
  'IT disconnects mid-game: someone else is IT at once, and the game goes on', gm ? `${prey.name} left; now ${[itP, other].find((p) => p.net.id === gm.it)?.name} is IT` : 'no game');
  // Two left; one leaves: podium.
  other.modes.leave();
  await until(() => itP.net.mode && itP.net.mode.phase === 'done', 2000);
  await sim.run(sim.t + 100);
  check(itP.net.mode && itP.net.mode.phase === 'done' && itP.modes.view.rows.length === 1, 'down to one player, the game ends on its podium');

  // ==== COINS ================================================================
  await until(() => !itP.net.mode, 14000);
  const E = addPlayer('Eff', 7);
  await until(() => E.net.serverProto === 2 && E.net.people.size >= 2, 4000);
  await sim.run(sim.t + 1500);
  const host = itP, rival = other;
  host.modes.startCoins(host);
  await until(() => rival.modes.view.invite && E.modes.view.invite, 1500);
  rival.modes.join(); E.modes.join();
  await until(() => host.net.mode && host.net.mode.phase === 'run', 6000);
  const pts = host.net.mode.pts;
  check(pts.length >= 8 && E.modes.view.inGame && Math.hypot(E.x - host.x, E.z - host.z) < 60,
    'coin rush: the host scatters coins on nearby roads, and joiners are brought to them', `${pts.length} coins; Eff ${Math.hypot(E.x - host.x, E.z - host.z).toFixed(0)} m from the host`);
  // Rival and Eff both go for coin 0; Rival gets there first.
  const d0r = Math.hypot(pts[0][0] - rival.x, pts[0][1] - rival.z), d0e = Math.hypot(pts[0][0] - E.x, pts[0][1] - E.z);
  rival.drive = towards(rival, () => pts[0][0], () => pts[0][1], Math.max(20, d0r / 4));
  E.drive = towards(E, () => pts[0][0], () => pts[0][1], Math.max(20, d0e / 4) * 0.6);
  await until(() => host.net.mode && host.net.mode.taken[0], 15000);
  const firstBy = host.net.mode.taken[0];
  await sim.run(sim.t + 8000);
  check(firstBy === rival.net.id && host.net.mode.taken[0] === rival.net.id && E.modes.view.taken[0] === rival.net.id,
    'a coin goes to whoever reaches it first, and stays theirs', `coin 0: ${players.find((p) => p.net.id === firstBy)?.name}`);
  // Sweep the rest with Eff.
  let k = 1;
  E.drive = (dt) => {
    while (k < pts.length && host.net.mode && host.net.mode.taken[k]) k++;
    if (k >= pts.length) return;
    towards(E, () => pts[k][0], () => pts[k][1], 120)(dt);
  };
  rival.drive = null;
  await until(() => host.net.mode && host.net.mode.phase === 'done', 100000, 100);
  const rows = host.modes.view.rows.map((r) => `${r.pos}.${r.name}:${r.stat}`).join(' ');
  check(host.net.mode && host.net.mode.phase === 'done' && host.modes.view.rows[0].name === 'Eff',
    'when the last coin goes the game ends, most coins on top', rows);

  // ==== the old pages ============================================================
  const oldHeard = [...O1.heard, ...O2.heard].filter((x) => x.t === 'mode' || x.t === 'emote');
  const seen = O1.net.room.cars.find((q) => q.active && q.id === O2.net.id);
  check(oldHeard.length === 0 && seen && O1.net.players === 1 && O2.net.players === 1,
    'meanwhile two protocol-1 pages drove on in their own room, seeing each other and hearing nothing of any game',
    `${oldHeard.length} game messages heard; Old One sees Old Two at ${seen ? seen.x.toFixed(0) + ', ' + seen.z.toFixed(0) : 'nowhere'}`);
} finally {
  for (const p of players) { try { p.alive = false; p.net.dispose(); } catch { /* fine */ } }
  if (!LIVE) {
    Date.now = realDateNow; globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
    globalThis.Response = realResponse; delete globalThis.WebSocketPair;
  }
}

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll party-game checks passed.');
if (LIVE) process.exit(0);
