// Multiplayer: remote cars move smoothly, and the room stays compatible.
//
// Everything here runs the REAL code — src/net/net.js and room.js on both
// clients, server/worker.js's Room class as the server — inside a
// discrete-event simulator: fake sockets, links with latency, jitter, TCP
// head-of-line stalls, and (for the fuzz case) drops, duplicates and
// reordering; three clocks that disagree with each other and drift. One
// client drives a known trajectory through its real send path; the other
// renders it through its real receive path at a jittery 60 fps, and every
// rendered frame is measured against the truth.
//
// Why a simulator and not two browsers: "it looked smooth when I tried it"
// is exactly how the linear interpolator shipped. A number per frame, under
// conditions a home WiFi actually produces, is the only thing that settles it.
//
// The frozen protocol-1 code in tools/fixtures/net-v1 is used three ways:
// as the OLD CLIENT (every cached page in the wild), as the OLD SERVER (the
// Worker before it is redeployed), and as the "before" column.

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const imp = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

const V1 = {
  net: await imp('tools/fixtures/net-v1/net.js'),
  worker: await imp('tools/fixtures/net-v1/worker.js'),
  proto: await imp('tools/fixtures/net-v1/protocol.js'),
};

let failures = 0;
const verbose = process.argv.includes('-v');
function check(ok, what, detail = '') {
  if (!ok) failures++;
  if (!ok || verbose) console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? '  — ' + detail : ''}`);
  return ok;
}
function note(s) { console.log(s); }

// ---------------------------------------------------------------------------
// Deterministic randomness and a discrete-event loop
// ---------------------------------------------------------------------------

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

function createSim(seed) {
  const heap = [];
  let seq = 0, now = 0;
  const rng = mulberry(seed);
  const less = (a, b) => (a.t < b.t || (a.t === b.t && a.s < b.s));
  function push(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }
  function pop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  }
  return {
    rng,
    stalls: new Map(),
    get t() { return now; },
    at(t, fn) { const e = { t: Math.max(t, now), s: seq++, fn, dead: false }; push(e); return e; },
    async run(until) {
      while (heap.length && heap[0].t <= until) {
        const e = pop();
        now = e.t;
        if (e.dead) continue;
        const r = e.fn();
        if (r && typeof r.then === 'function') await r;
      }
      now = until;
    },
  };
}

// ---------------------------------------------------------------------------
// Network conditions
// ---------------------------------------------------------------------------
//
// One-way latency = base + exponential jitter, plus occasional spikes. A
// WebSocket is TCP, so within one direction of one connection nothing is
// reordered or lost — a late packet holds up every packet behind it and they
// then arrive together. That burst is the thing a real home connection does
// to a 20 Hz stream, and it is modelled as `stall` windows. The fuzz profile
// breaks the TCP promise on purpose (drops, duplicates, reordering) to prove
// the receiver survives input no socket should ever give it.

const PROFILES = {
  lan:   { base: 4,  jitter: 1,  spikeP: 0,    spike: 0,   stall: null },
  wifi:  { base: 22, jitter: 7,  spikeP: 0.03, spike: 70,  stall: null },
  rough: { base: 45, jitter: 14, spikeP: 0.03, spike: 90,  stall: { every: 2600, min: 140, max: 320 } },
  fuzz:  { base: 25, jitter: 8,  spikeP: 0.02, spike: 60,  stall: null,
           drop: 0.08, dup: 0.05, reorder: 0.10 },
  // A kid's WiFi dropping out for a second or three: nothing at all arrives,
  // then everything that was held up lands at once. 'rough' tops out at
  // 320 ms; these are the stalls the flood-guard commit describes.
  stall1: { base: 22, jitter: 7, spikeP: 0.03, spike: 70, stall: { every: 9000, min: 900, max: 1400 } },
  stall3: { base: 22, jitter: 7, spikeP: 0.03, spike: 70, stall: { every: 9000, min: 2300, max: 2800 } },
};

function expo(rng, mean) { return -Math.log(1 - rng() * 0.999999) * mean; }

/** One direction of one connection. `deliver(fn)` schedules fn on arrival. */
function createLink(sim, prof, salt) {
  const rng = mulberry(salt);
  let last = 0;
  const stalls = [];
  if (prof.stall) {
    for (let t = 500 + rng() * prof.stall.every; t < 400000; t += prof.stall.every * (0.6 + rng() * 0.8)) {
      stalls.push([t, t + prof.stall.min + rng() * (prof.stall.max - prof.stall.min)]);
    }
  }
  // Every link's outages, by salt, so a check can hold the drawn car to what
  // the links actually did.
  if (sim.stalls) sim.stalls.set(salt, stalls);
  function latency() {
    let d = prof.base + expo(rng, prof.jitter);
    if (rng() < prof.spikeP) d += prof.spike * (0.5 + rng());
    return d;
  }
  function stallEnd(t) {
    for (const [a, b] of stalls) { if (t >= a && t < b) return b; if (a > t) break; }
    return 0;
  }
  return {
    rng,
    /** Reliable, ordered: a control message or anything on a real socket. */
    ordered(fn) {
      let at = sim.t + latency();
      at = Math.max(at, stallEnd(sim.t) + prof.base);
      at = Math.max(at, last);
      last = at;
      sim.at(at, fn);
    },
    /** Unreliable: drops, duplicates and reorders — the fuzz case only. */
    unordered(fn) {
      if (rng() < prof.drop) return;
      let at = sim.t + latency();
      if (rng() < prof.reorder) at += 60 + rng() * 90;
      sim.at(at, fn);
      if (rng() < prof.dup) sim.at(at + 5 + rng() * 40, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// A fake Cloudflare runtime around the real Worker, and fake browser sockets
// ---------------------------------------------------------------------------

const realDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realResponse = globalThis.Response;

function installRuntime(sim, serverEpoch, timerJitter) {
  const rng = mulberry(991);
  Date.now = () => Math.floor(serverEpoch + sim.t);
  globalThis.setInterval = (fn, ms) => {
    const h = { dead: false, ev: null };
    const next = (from) => {
      let d = ms + (rng() * 2 - 1) * timerJitter;
      if (rng() < 0.01) d += 12;                      // a GC pause in the isolate
      h.ev = sim.at(from + d, () => { if (h.dead) return; next(sim.t); fn(); });
    };
    next(sim.t);
    return h;
  };
  globalThis.clearInterval = (h) => { if (h && h.dead !== undefined) { h.dead = true; if (h.ev) h.ev.dead = true; } };
  globalThis.Response = class {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.webSocket = init.webSocket || null; }
  };
  globalThis.WebSocketPair = function () {
    const server = new ServerEnd();
    return { 0: { placeholder: true, server }, 1: server };
  };
}
function uninstallRuntime() {
  Date.now = realDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.Response = realResponse;
  delete globalThis.WebSocketPair;
}

class ServerEnd {
  constructor() { this.client = null; this.closed = false; this.att = null; }
  send(data) { if (!this.closed && this.client) this.client._fromServer(data); }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.client) this.client._serverClosed(code, reason);
  }
  serializeAttachment(v) { this.att = JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this.att; }
}

/**
 * The Worker's env, with the Durable Object namespace faked: one Room per
 * name, exactly as idFromName() + get() behave. Routing is therefore the
 * Worker's own code, not the harness's idea of it.
 */
function createEnv(RoomClass) {
  const rooms = new Map();
  const sockets = new Map();       // room name -> accepted ServerEnds
  return {
    rooms, sockets,
    ROOM: {
      idFromName(name) { return { name }; },
      get(id) {
        let r = rooms.get(id.name);
        if (!r) {
          const list = [];
          sockets.set(id.name, list);
          const ctx = {
            acceptWebSocket(ws) { list.push(ws); ws.room = r; },
            getWebSockets() { return list.filter((w) => !w.closed); },
          };
          r = new RoomClass(ctx, {});
          r.__name = id.name;
          rooms.set(id.name, r);
        }
        return r;
      },
    },
  };
}

/**
 * What the browser hands net.js. Connects through worker.fetch() after one
 * uplink latency, then carries messages over the two links.
 */
function makeSocketFactory(sim, worker, env, prof, salt, opts = {}) {
  return (url) => {
    const up = createLink(sim, prof, salt * 7 + 1);
    const down = createLink(sim, prof, salt * 7 + 2);
    const sock = {
      binaryType: 'blob', onopen: null, onmessage: null, onclose: null, onerror: null,
      readyState: 0, url, server: null, room: null,
      send(data) {
        if (sock.readyState !== 1) throw new Error('not open');
        const copy = typeof data === 'string' ? data : data.slice(0);
        up.ordered(() => {
          if (!sock.server || sock.server.closed) return;
          sock.room.webSocketMessage(sock.server, copy);
        });
      },
      close() {
        if (sock.readyState === 3) return;
        sock.readyState = 3;
        up.ordered(() => {
          if (!sock.server || sock.server.closed) return;
          sock.server.closed = true;
          sock.room.webSocketClose(sock.server, 1000, '', true);
        });
      },
      _fromServer(data) {
        const deliver = () => { if (sock.readyState === 1 && sock.onmessage) sock.onmessage({ data }); };
        if (typeof data !== 'string' && prof.drop && !opts.reliable) down.unordered(deliver);
        else down.ordered(deliver);
      },
      _serverClosed() {
        down.ordered(() => {
          sock.readyState = 3;
          if (sock.onclose) sock.onclose({});
          sock.room.webSocketClose(sock.server, 1000, '', true);
        });
      },
    };
    up.ordered(async () => {
      const req = { url, headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? 'websocket' : null) } };
      const res = await worker.default.fetch(req, env);
      if (!res || res.status !== 101) {
        down.ordered(() => { sock.readyState = 3; if (sock.onclose) sock.onclose({}); });
        return;
      }
      const server = res.webSocket.server;
      server.client = sock;
      sock.server = server;
      sock.room = server.room;
      down.ordered(() => { sock.readyState = 1; if (sock.onopen) sock.onopen({}); });
    });
    return sock;
  };
}

// ---------------------------------------------------------------------------
// The truth: a car driven hard round a course, integrated at 1 kHz
// ---------------------------------------------------------------------------
//
// Launch, S-bends at 100 km/h, a braking zone into a hairpin (10.8 m/s^2 of
// lateral), a drag back up to 126 km/h and some sweepers. Speed and yaw rate
// change through smoothsteps: a real car's inputs are not instantaneous, and
// a step here would put a genuine infinite jerk into the reference.

const TRUTH_MS = 70000;
const ss = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function buildTruth(kind = 'course') {
  const n = TRUTH_MS + 1;
  const X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n);
  const W = new Float64Array(n), V = new Float64Array(n);
  let x = 0, z = 0, yaw = 0.3;
  const Yw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i % 24000) / 1000;           // the lap repeats every 24 s
    let v, w;
    if (kind === 'crawl') {
      v = 1.2 + 0.8 * Math.sin(i / 1000 * 0.7);
      w = 0.35 * Math.sin(i / 1000 * 0.4);
    } else {
      // Only the first lap launches from rest; every later one rolls in at
      // the 28 m/s the last one ended on, so the course has no step in it.
      v = i < 24000 ? 28 * ss(0, 4, t) : 28;
      v += (12 - 28) * ss(10, 12, t);
      v += (35 - 12) * ss(16, 20, t);
      v += (28 - 35) * ss(22, 24, t);
      w = 0;
      w += 0.45 * Math.sin(2 * Math.PI * (t - 4) / 3) * ss(4, 4.4, t) * (1 - ss(9.6, 10, t));
      w += 0.60 * ss(10, 11, t) * (1 - ss(11.6, 12, t));
      w += 0.90 * ss(12, 12.4, t) * (1 - ss(15.6, 16, t));
      w += 0.12 * Math.sin(2 * Math.PI * (t - 16) / 4) * ss(16, 16.5, t);
    }
    V[i] = v; W[i] = w; X[i] = x; Z[i] = z; Yw[i] = yaw;
    Y[i] = 2 + 1.5 * Math.sin(x * 0.01) * Math.cos(z * 0.013);
    const dt = 0.001;
    yaw += w * dt;
    x += -Math.sin(yaw) * v * dt;
    z += -Math.cos(yaw) * v * dt;
  }
  function at(ms, out = {}) {
    const f = Math.max(0, Math.min(TRUTH_MS - 1, ms));
    const i = Math.floor(f), u = f - i;
    out.x = X[i] + (X[i + 1] - X[i]) * u;
    out.z = Z[i] + (Z[i + 1] - Z[i]) * u;
    out.y = Y[i] + (Y[i + 1] - Y[i]) * u;
    out.yaw = Yw[i] + (Yw[i + 1] - Yw[i]) * u;
    out.v = V[i] + (V[i + 1] - V[i]) * u;
    out.yawRate = W[i] + (W[i + 1] - W[i]) * u;
    out.vx = -Math.sin(out.yaw) * out.v;
    out.vz = -Math.cos(out.yaw) * out.v;
    return out;
  }
  return { at, X, Z, V };
}

// ---------------------------------------------------------------------------
// One session: a driver and a watcher in the same room
// ---------------------------------------------------------------------------

const BASE_URL = 'wss://room.test/';

/**
 * stack: { net: the watcher's client module, sender: the driver's (defaults
 * to net), worker: the server module }. Returns the watcher's rendered track
 * of the driver's car, frame by frame, plus the truth it should match.
 *
 * opts.third: { joinAt, leaveAt, pauseFrom, pauseTo } adds a third client
 * that joins, optionally stops running its frame loop (a background tab), and
 * leaves.
 */
async function session(stack, profName, opts = {}) {
  const prof = PROFILES[profName];
  const sim = createSim(opts.seed || 1234);
  const serverEpoch = 1.7e12 + 12345;
  installRuntime(sim, serverEpoch, 2);
  const env = createEnv(stack.worker.Room);
  const truth = opts.truth || buildTruth(opts.course || 'course');
  const dur = opts.duration || 30000;

  // Clocks. performance.now() on each machine: its own origin, its own drift.
  const senderNow = () => sim.t * (1 + 50e-6) + 5000.5;
  const watcherNow = () => sim.t * (1 - 30e-6) + 777.25;
  const thirdNow = () => sim.t * (1 + 10e-6) + 31.5;

  const sent = { ping: 0, car: 0 };
  const counting = (factory) => (url) => {
    const sock = factory(url);
    const send = sock.send;
    sock.send = (data) => {
      if (typeof data === 'string') {
        const m = JSON.parse(data);
        if (m.t in sent) sent[m.t]++;
      }
      return send(data);
    };
    return sock;
  };

  const sender = (stack.sender || stack.net).createNet({
    url: BASE_URL, name: 'Driver', seed: 1, carId: 'kaida', colour: 2,
    now: senderNow, socketFactory: makeSocketFactory(sim, stack.worker, env, prof, 11, { reliable: true }),
  });
  const events = [];
  const watcher = stack.net.createNet({
    url: BASE_URL, name: 'Watcher', seed: 1, carId: 'kaida2',
    now: watcherNow, socketFactory: counting(makeSocketFactory(sim, stack.worker, env, prof, 23)),
    onEvent: (e) => events.push({ t: sim.t, ...e }),
    ...(opts.watcherOpts || {}),
  });

  const rec = {
    id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0, yawRate: 0,
    steer: 0, wheelSpin: 0, integrity: 1, flags: 0, respawnSeq: 0,
  };
  const still = { ...rec, x: 9000, z: 9000 };
  const tq = {};
  let teleportAt = opts.teleportAt ?? -1, teleported = false;
  let nudgeAt = opts.nudgeAt ?? -1;
  let shiftX = 0, seqNo = 0;

  // The driver: 60 fps with jitter and the odd hitch, sending through net.update().
  const srng = mulberry(77);
  let sLast = 0;
  const senderFrame = () => {
    const dt = 16.667 + (srng() * 2 - 1) * 1.5 + (srng() < 0.01 ? 25 : 0);
    sim.at(sim.t + dt, () => {
      const t = sim.t;
      truth.at(t, tq);
      let tele = 0;
      if (teleportAt >= 0 && t >= teleportAt && !teleported) {
        teleported = true; shiftX += 300; seqNo = (seqNo + 1) & 0xff; tele = 64;
      }
      if (nudgeAt >= 0 && t >= nudgeAt) { shiftX += 2.0; nudgeAt = -1; }
      rec.x = tq.x + shiftX; rec.z = tq.z; rec.y = tq.y; rec.yaw = tq.yaw;
      rec.vx = tq.vx; rec.vz = tq.vz; rec.yawRate = tq.yawRate;
      rec.respawnSeq = seqNo;
      const lap = t % 24000;
      rec.flags = tele | (lap > 10000 && lap < 12000 ? 1 : 0);
      if (opts.carChangeAt && t >= opts.carChangeAt && !sender.__changed) {
        sender.__changed = true;
        sender.setCar('bastion', 1);
      }
      sender.update((t - sLast) / 1000, rec);
      sLast = t;
      senderFrame();
    });
  };

  // An optional third driver, parked, who joins late, may go quiet, and leaves.
  let third = null;
  const thirdEvents = [];
  if (opts.third) {
    const o = opts.third;
    sim.at(o.joinAt, () => {
      third = stack.net.createNet({
        url: BASE_URL, name: 'Third', seed: 1, carId: 'haulier', colour: 3,
        now: thirdNow, socketFactory: makeSocketFactory(sim, stack.worker, env, prof, 37),
        onEvent: (e) => thirdEvents.push(e),
        // Chrome's intensive throttling: a tab hidden for five minutes runs
        // its chained timers once a minute.
        ...(o.minuteTimers ? { setInterval: (fn) => globalThis.setInterval(fn, 60000) } : {}),
      });
      let last = sim.t;
      const park = { ...rec, x: 40, z: -40, vx: 0, vz: 0, flags: 0 };
      const loop = () => sim.at(sim.t + 16.7, () => {
        if (!third) return;
        const paused = o.pauseFrom != null && sim.t >= o.pauseFrom && sim.t < o.pauseTo;
        if (!paused) third.update((sim.t - last) / 1000, park);
        last = sim.t;
        loop();
      });
      loop();
    });
    if (o.leaveAt) sim.at(o.leaveAt, () => { if (third) { third.dispose(); third = null; } });
  }

  // The watcher: renders at a jittery 60 fps and records the driver's car.
  const wrng = mulberry(91);
  let wLast = 0;
  const frames = [];
  const watcherFrame = () => {
    const dt = 16.667 + (wrng() * 2 - 1) * 1.5 + (wrng() < 0.01 ? 22 : 0);
    sim.at(sim.t + dt, () => {
      const t = sim.t;
      watcher.update((t - wLast) / 1000, still);
      wLast = t;
      const sid = sender.id;
      const c = watcher.room.cars.find((k) => k.active && k.id === sid);
      if (c) frames.push({ t, x: c.x, z: c.z, yaw: c.yaw, fade: c.fade, brake: c.brake, speed: c.speed });
      if (opts.onFrame) opts.onFrame(watcher, sender, sim);
      watcherFrame();
    });
  };
  senderFrame();
  watcherFrame();
  let clockTruth = null;
  try {
    await sim.run(dur);
    // Where the server's clock really is against the watcher's, read while
    // the simulated Date.now() is still installed.
    const room = [...env.rooms.values()][0];
    if (room && room.core) clockTruth = room.core.ms() - watcherNow();
  } finally {
    uninstallRuntime();
  }
  return {
    frames, truth, sender, watcher, env, sim, events, sent, clockTruth, thirdEvents,
    third: () => third,
  };
}

// ---------------------------------------------------------------------------
// Measuring a rendered track
// ---------------------------------------------------------------------------

/**
 * For every frame: how far it moved against how far the frame before said it
 * would (a pop), how hard it accelerated (a kink), whether it went backwards,
 * and how far behind the truth it is drawn (and how steady that lag is —
 * a wobbling lag is a car surging and hesitating).
 */
function measure(res, opts = {}) {
  const { frames, truth } = res;
  const skip = opts.skip ?? 3000;
  const q = {};
  let tau = -1;
  const acc = [], lag = [], xerr = [];
  let back = 0, pops = 0, maxDev = 0, maxAcc = 0;
  let prev = null, prevU = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Nearest truth time, searched forward from the last answer.
    let best = Infinity, bt = tau;
    const lo = tau < 0 ? Math.max(0, f.t - 1500) : tau - 150;
    const hi = tau < 0 ? f.t : Math.min(f.t, tau + 400);
    for (let s = lo; s <= hi; s += 1) {
      truth.at(s, q);
      const d = (q.x + (opts.shift || 0) - f.x) ** 2 + (q.z - f.z) ** 2;
      if (d < best) { best = d; bt = s; }
    }
    tau = bt;
    f.tau = bt; f.err = Math.sqrt(best);
    if (f.t < skip) { prev = f; prevU = null; continue; }
    if (prev) {
      const dt = (f.t - prev.t) / 1000;
      const ux = (f.x - prev.x) / dt, uz = (f.z - prev.z) / dt;
      truth.at(f.tau, q);
      const hx = -Math.sin(q.yaw), hz = -Math.cos(q.yaw);
      if (q.v > 1 && (f.x - prev.x) * hx + (f.z - prev.z) * hz < -0.002) back++;
      if (prevU) {
        const ax = (ux - prevU.x) / dt, az = (uz - prevU.z) / dt;
        const a = Math.hypot(ax, az);
        acc.push(a);
        if (a > maxAcc) maxAcc = a;
        // Deviation from where constant velocity would have put it this frame.
        const dev = Math.hypot(f.x - (prev.x + prevU.x * dt), f.z - (prev.z + prevU.z * dt));
        if (dev > maxDev) maxDev = dev;
        if (dev > 0.10) pops++;
      }
      prevU = { x: ux, z: uz };
    }
    lag.push(f.t - f.tau);
    xerr.push(f.err);
    prev = f;
  }
  const sorted = (a) => a.slice().sort((p, r) => p - r);
  const pct = (a, p) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const lm = mean(lag);
  const lagSd = Math.sqrt(mean(lag.map((v) => (v - lm) ** 2)));
  return {
    frames: acc.length, back, pops, maxDev, maxAcc,
    acc99: pct(acc, 0.99), acc999: pct(acc, 0.999),
    lag: lm, lagSd, err99: pct(xerr, 0.99),
  };
}

function row(name, m) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  return `${name.padEnd(18)} lag ${f(m.lag, 0).padStart(4)} ms ±${f(m.lagSd, 0).padStart(3)}   ` +
    `accel p99 ${f(m.acc99, 0).padStart(4)}  p99.9 ${f(m.acc999, 0).padStart(4)}  max ${f(m.maxAcc, 0).padStart(5)} m/s²   ` +
    `pops ${String(m.pops).padStart(3)} (max ${f(m.maxDev, 2)} m)   backwards ${String(m.back).padStart(3)}`;
}

// ---------------------------------------------------------------------------

const V1STACK = { name: 'protocol 1', net: V1.net, worker: V1.worker };
const V2STACK = {
  name: 'protocol 2',
  net: await imp('src/net/net.js'),
  worker: await imp('server/worker.js'),
};

if (process.argv.includes('--compare')) {
  note('                    BEFORE: protocol-1 client + server (live today)   /   AFTER: this branch');
  for (const p of ['lan', 'wifi', 'rough', 'fuzz', 'stall1', 'stall3']) {
    note(row(p + ' before', measure(await session(V1STACK, p))));
    const r = await session(V2STACK, p);
    const m = measure(r);
    note(row(p + ' after', m) + `   delay ${r.watcher.room.interp.toFixed(0)} ms, extrap ${(100 * r.watcher.room.stats.extrap / Math.max(1, r.watcher.room.stats.frames)).toFixed(1)}%, cuts ${r.watcher.room.stats.cuts}`);
  }
  process.exit(0);
}

if (process.argv.includes('--dump')) {
  const prof = process.argv[process.argv.indexOf('--dump') + 1] || 'lan';
  const extra = [];
  const r = await session(process.argv.includes('--old') ? V1STACK : V2STACK, prof, {
    onFrame: (w, s) => {
      const c = w.room.cars.find((k) => k.active && k.id === s.id);
      extra.push(c ? { ex: c._ex || 0, ez: c._ez || 0, evx: c._vx || 0, evz: c._vz || 0, n: c._n || 0, top: c._n ? c._s[c._n - 1].t : 0, d: w.room.interp } : null);
    },
  });
  measure(r);
  const fr = r.frames;
  let worst = 0, wi = 0;
  for (let i = 2; i < fr.length; i++) {
    if (fr[i].t < 3000) continue;
    const dt = fr[i].t - fr[i - 1].t, pdt = fr[i - 1].t - fr[i - 2].t;
    const ux = (fr[i - 1].x - fr[i - 2].x) / pdt, uz = (fr[i - 1].z - fr[i - 2].z) / pdt;
    const dev = Math.hypot(fr[i].x - fr[i - 1].x - ux * dt, fr[i].z - fr[i - 1].z - uz * dt);
    if (dev > worst) { worst = dev; wi = i; }
  }
  const off = extra.length - fr.length;
  for (let i = Math.max(1, wi - 8); i <= Math.min(fr.length - 1, wi + 4); i++) {
    const f = fr[i], p = fr[i - 1], e = extra[i + off];
    console.log(f.t.toFixed(1), 'step', Math.hypot(f.x - p.x, f.z - p.z).toFixed(3), 'lag', (f.t - f.tau).toFixed(0),
      'err', f.err.toFixed(2), e ? `corr ${e.ex.toFixed(3)},${e.ez.toFixed(3)} v ${e.evx.toFixed(2)},${e.evz.toFixed(2)} n ${e.n} top ${e.top} D ${e.d.toFixed(0)}` : '');
  }
  process.exit(0);
}
// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const P2 = await imp('src/net/protocol.js');
const CORE = await imp('server/roomcore.js');
const createRoomCoreFor = (proto) => CORE.createRoomCore({ proto, now: () => Date.now(), maxPlayers: 200 });

/** Largest per-frame deviation from constant velocity, and how many >10 cm, in [t0, t1). */
function popsIn(frames, t0, t1) {
  let max = 0, n = 0;
  for (let i = 2; i < frames.length; i++) {
    const f = frames[i], p = frames[i - 1], q = frames[i - 2];
    if (f.t < t0 || f.t >= t1) continue;
    const dt = f.t - p.t, pdt = p.t - q.t;
    const ux = (p.x - q.x) / pdt, uz = (p.z - q.z) / pdt;
    const dev = Math.hypot(f.x - p.x - ux * dt, f.z - p.z - uz * dt);
    if (dev > max) max = dev;
    if (dev > 0.10) n++;
  }
  return { max, n };
}

note('netcheck — remote cars are smooth, and every version of the game can still play');

// ---- 1. the wire ------------------------------------------------------------
{
  check(P2.REC === 26 && P2.REC === V1.proto.REC && P2.UP === V1.proto.UP,
    'the car record is still 26 bytes and the upload 31', `REC ${P2.REC}, UP ${P2.UP}`);
  const rng = mulberry(5);
  let same = 0;
  for (let k = 0; k < 200; k++) {
    const car = {
      id: k & 0xff, x: (rng() - 0.5) * 8000, z: (rng() - 0.5) * 8000, y: rng() * 200,
      yaw: rng() * 12 - 6, pitch: rng() - 0.5, roll: rng() - 0.5, vx: rng() * 80 - 40, vz: rng() * 80 - 40,
      yawRate: rng() * 6 - 3, steer: rng() * 2 - 1, wheelSpin: rng() * 50, integrity: rng(),
      flags: (rng() * 256) | 0, respawnSeq: (rng() * 256) | 0,
    };
    const a = new Uint8Array(P2.encodeState(car, 12345));
    const b = new Uint8Array(V1.proto.encodeState(car, 12345));
    if (a.length === b.length && a.every((v, i) => v === b[i])) same++;
  }
  check(same === 200, 'this client encodes a car exactly as a protocol-1 client does', `${same}/200 byte-identical`);
  check(P2.roomName(P2.protoFromUrl('wss://h/')) === 'open-road-main' &&
    P2.roomName(P2.protoFromUrl('wss://h/?v=1')) === 'open-road-main' &&
    P2.roomName(P2.protoFromUrl('wss://h/?v=7')) === 'open-road-main' &&
    P2.roomName(P2.protoFromUrl('wss://h/?x=1&v=2')) === 'open-road-v2',
  'a URL without v=2 routes to the room old pages have always used');
  const badIds = ['', 'A', '<b>', '../x', 'a'.repeat(30), 'kaida two', null, 7];
  check(badIds.every((v) => P2.cleanCarId(v) === '') && P2.cleanCarId('kaida2') === 'kaida2',
    'a car id is a catalogue token, never free text');
  check(P2.cleanColour(99) === 0 && P2.cleanColour(-1) === 0 && P2.cleanColour(1.5) === 0 && P2.cleanColour(4) === 4,
    'a paint is a small index');
}

// ---- 2. the old room is byte-for-byte the old room ---------------------------
//
// The same script — joins, a clash of names, states, a rename, a ping, a leave,
// ticks — through the Worker from main and through this one, on one clock.
// Every message either sends must be identical, binary frames to the byte.
{
  async function script(workerMod) {
    const sim = createSim(1);
    installRuntime(sim, 1.7e12, 0);
    const env = createEnv(workerMod.Room);
    const logs = { A: [], B: [] };
    const mk = (tag) => ({ _fromServer: (d) => logs[tag].push(typeof d === 'string' ? JSON.parse(d) : Array.from(new Uint8Array(d))), _serverClosed() {} });
    const req = { url: 'wss://h/', headers: { get: () => 'websocket' } };
    try {
      const ra = await workerMod.default.fetch(req, env);
      const rb = await workerMod.default.fetch(req, env);
      const A = ra.webSocket.server, B = rb.webSocket.server;
      A.client = mk('A'); B.client = mk('B');
      const room = A.room;
      const st = (x, t) => V1.proto.encodeState({ x, z: -x, y: 1, yaw: 0.5, vx: 3, vz: -3, yawRate: 0.1, steer: 0.2, integrity: 0.8, flags: 5, respawnSeq: 2 }, t);
      room.webSocketMessage(A, JSON.stringify({ t: 'join', proto: 1, seed: 7, name: 'Ace', carId: 'kaida2' }));
      room.webSocketMessage(B, JSON.stringify({ t: 'join', proto: 1, seed: 7, name: 'Ace' }));
      room.webSocketMessage(A, st(10, 100));
      room.tick();
      room.webSocketMessage(B, st(20, 150));
      room.webSocketMessage(A, st(11, 150));
      room.tick();
      room.tick();
      room.webSocketMessage(B, JSON.stringify({ t: 'name', name: 'Bo' }));
      room.webSocketMessage(A, JSON.stringify({ t: 'ping', c: 4321 }));
      // As the runtime does it: the socket is closed, THEN the handler runs.
      B.closed = true;
      room.webSocketClose(B);
      room.tick();
    } finally { uninstallRuntime(); }
    return { logs, rooms: [...env.rooms.keys()] };
  }
  const oldRun = await script(V1.worker);
  const newRun = await script(V2STACK.worker);
  const a = JSON.stringify(oldRun.logs), b = JSON.stringify(newRun.logs);
  if (a !== b && verbose) {
    for (const k of ['A', 'B']) {
      const n = Math.max(oldRun.logs[k].length, newRun.logs[k].length);
      for (let i = 0; i < n; i++) {
        const x = JSON.stringify(oldRun.logs[k][i]), y = JSON.stringify(newRun.logs[k][i]);
        if (x !== y) console.log(`   ${k}[${i}]\n     old ${x}\n     new ${y}`);
      }
    }
  }
  check(a === b, 'a protocol-1 room sends exactly what the live Worker sends',
    a === b ? `${oldRun.logs.A.length + oldRun.logs.B.length} messages identical` : `old ${a.slice(0, 160)}\n   new ${b.slice(0, 160)}`);
  check(newRun.rooms.length === 1 && newRun.rooms[0] === 'open-road-main', 'and it is the same Durable Object, open-road-main');
}

// ---- 3. compatibility, with the real client code --------------------------------
{
  // An old cached page against the new Worker.
  const r = await session({ net: V1.net, worker: V2STACK.worker }, 'wifi', { duration: 12000 });
  const m = measure(r);
  check(r.watcher.id > 0 && r.sender.id > 0 && r.frames.length > 400 && m.err99 < 3,
    'a protocol-1 page joins the new Worker, sends, and sees other cars move',
    `ids ${r.sender.id}/${r.watcher.id}, ${r.frames.length} frames drawn, 99% within ${m.err99.toFixed(2)} m of the truth`);
  check([...r.env.rooms.keys()].join() === 'open-road-main', 'it lands in the room it always used');

  // A new page against a Worker that has not been redeployed yet.
  const r2 = await session({ net: V2STACK.net, worker: V1.worker }, 'wifi', { duration: 12000 });
  const m2 = measure(r2);
  check(r2.watcher.serverProto === 1 && r2.frames.length > 400 && m2.pops === 0 && m2.back === 0,
    'a new page against the OLD Worker still plays, and still draws smoothly',
    `server generation ${r2.watcher.serverProto}, ${r2.frames.length} frames, ${m2.pops} pops, max ${m2.maxDev.toFixed(2)} m, rtt ${r2.watcher.rtt.toFixed(0)} ms`);
  const c2 = r2.watcher.room.car(r2.sender.id);
  check(c2 && c2.carId === '', 'and asks an old server for nothing it cannot give (no car body; the starter is drawn)');

  // Old and new pages on the new Worker never share a world.
  const r3 = await session({ net: V2STACK.net, sender: V1.net, worker: V2STACK.worker }, 'lan', { duration: 5000 });
  const r4 = await session({ net: V1.net, sender: V2STACK.net, worker: V2STACK.worker }, 'lan', { duration: 5000 });
  check(r3.frames.length === 0 && r4.frames.length === 0 && r3.env.rooms.size === 2,
    'an old page and a new page are put in different rooms and never see each other',
    `rooms: ${[...r3.env.rooms.keys()].join(', ')}`);
}

// ---- 4. smoothness -----------------------------------------------------------------
const LIMIT = { lan: 150, wifi: 150, rough: 400, fuzz: 200 };
for (const prof of ['lan', 'wifi', 'rough', 'fuzz']) {
  const r = await session(V2STACK, prof);
  const m = measure(r);
  const st = r.watcher.room.stats;
  check(m.pops === 0 && m.back === 0 && m.maxDev < 0.10 && m.acc999 < LIMIT[prof] && m.frames > 1400,
    `${prof.padEnd(5)}: no pops, no backwards steps, bounded acceleration`,
    `worst frame ${(m.maxDev * 100).toFixed(1)} cm off its own motion, accel p99.9 ${m.acc999.toFixed(0)} m/s² (limit ${LIMIT[prof]}), ` +
    `drawn ${m.lag.toFixed(0)}±${m.lagSd.toFixed(0)} ms late, extrapolating ${(100 * st.extrap / st.frames).toFixed(1)}% of frames`);
  if (prof === 'wifi') {
    // The clock. Truth: the Worker's ms() minus the watcher's performance.now().
    const off = r.clockTruth;
    const est = r.watcher.room.offset;
    check(Math.abs(est - off) < 8 && r.watcher.rtt > 40 && r.watcher.rtt < 100,
      'the clock syncs to the server from pings, and the round trip is real',
      `offset error ${(est - off).toFixed(1)} ms, rtt ${r.watcher.rtt.toFixed(0)} ms (links 22+22 ms + jitter)`);
    check(r.sent.ping >= 18, 'pings keep going out for the whole session', `${r.sent.ping} in 30 s`);
    const brakes = r.frames.filter((f) => f.brake).length;
    check(brakes > 60, 'brake lights arrive with the car', `${brakes} frames lit`);
  }
}
{
  const r = await session(V2STACK, 'wifi', { course: 'crawl', duration: 20000 });
  const m = measure(r);
  check(m.pops === 0 && m.back === 0, 'a car creeping at walking pace never shuffles or steps back',
    `worst ${(m.maxDev * 100).toFixed(1)} cm, ${m.back} backwards`);
}

// ---- 4b. WiFi dropouts of one to three seconds --------------------------------------
//
// Nothing can be drawn smoothly through a hole in the feed. What must happen
// is: the car carries on briefly, eases to a stop, and when the feed comes
// back it makes ONE clean cut to where it really is and drives on smoothly —
// no slide across the gap, no second lurch, never a step backwards. The
// driver's uplink (salt 11) and the watcher's downlink (salt 23) are the two
// links whose outages the watcher can see; each may cost one cut.
for (const prof of ['stall1', 'stall3']) {
  const dur = 40000;
  const r = await session(V2STACK, prof, { duration: dur });
  const m = measure(r);
  const outs = [...(r.sim.stalls.get(11 * 7 + 1) || []), ...(r.sim.stalls.get(23 * 7 + 2) || [])]
    .filter(([a]) => a < dur - 500);
  const inOutage = (t) => outs.some(([a, b]) => t >= a && t <= b + 1500);
  const fr = r.frames;
  let cutsSeen = 0, stray = 0, straySize = 0, farOff = 0, settled = 0;
  for (let i = 2; i < fr.length; i++) {
    const f = fr[i], p = fr[i - 1], q = fr[i - 2];
    if (f.t < 3000) continue;
    const dt = f.t - p.t, pdt = p.t - q.t;
    const dev = Math.hypot(f.x - p.x - (p.x - q.x) / pdt * dt, f.z - p.z - (p.z - q.z) / pdt * dt);
    const jumpBefore = Math.hypot(p.x - q.x, p.z - q.z) > 2;
    if (dev > 0.10 && !jumpBefore) {
      // A clean cut: a jump in one frame, from a car that was not already
      // sliding (the frame after a jump reads as a pop only because its
      // velocity estimate spans the jump).
      if (Math.hypot(f.x - p.x, f.z - p.z) > 2 && inOutage(f.t)) cutsSeen++;
      else { stray++; straySize = Math.max(straySize, dev); }
    }
    if (!inOutage(f.t)) { settled++; if (f.err > 1) farOff++; }
  }
  check(m.back === 0 && stray === 0 && cutsSeen <= outs.length && farOff === 0,
    `${prof}: a ${prof === 'stall1' ? '1' : '2.5'} s dropout is one clean cut, never a slide, a lurch or a step back`,
    `${outs.length} outages, ${cutsSeen} cuts, ${stray} other pops${stray ? ` (max ${straySize.toFixed(2)} m)` : ''}, ` +
    `${m.back} backwards, ${farOff}/${settled} frames between outages more than 1 m off the truth, drawn ${m.lag.toFixed(0)} ms late`);
}

// ---- 5. cuts, and things that must not be cuts -------------------------------------
{
  const r = await session(V2STACK, 'wifi', { teleportAt: 15000, duration: 22000 });
  let big = 0, streak = 0;
  for (let i = 1; i < r.frames.length; i++) {
    const d = Math.hypot(r.frames[i].x - r.frames[i - 1].x, r.frames[i].z - r.frames[i - 1].z);
    if (d > 50) big++; else if (d > 2) streak++;
  }
  check(big === 1 && streak === 0, 'a respawn is one clean cut, never a streak across the map',
    `${big} cut, ${streak} frames of streaking`);
  const r2 = await session(V2STACK, 'wifi', { nudgeAt: 15000, duration: 20000 });
  const p = popsIn(r2.frames, 14500, 17000);
  check(p.n === 0 && r2.watcher.room.stats.rebases >= 1,
    'a 2 m shove the velocities cannot explain is eased in, not popped',
    `worst frame ${(p.max * 100).toFixed(1)} cm off its own motion, ${r2.watcher.room.stats.rebases} rebase`);
}

// ---- 6. who is who ----------------------------------------------------------------
{
  const r = await session(V2STACK, 'wifi', {
    duration: 26000, carChangeAt: 8000,
    third: { joinAt: 5000, pauseFrom: 9000, pauseTo: 21000, leaveAt: 23000 },
  });
  const w = r.watcher;
  const c = w.room.car(r.sender.id);
  const person = w.people.get(r.sender.id);
  check(c && c.carId === 'bastion' && c.colour === 1 && person && person.name === 'Driver',
    "each player's car body and paint reach everyone, and follow a change in the garage",
    c ? `${person && person.name}: ${c.carId} paint ${c.colour}` : 'no car');
  const ev = r.events.map((e) => `${e.type}:${e.name}`);
  const tev = r.thirdEvents.map((e) => `${e.type}:${e.name}`);
  check(ev[0] === 'welcome:Watcher' && ev.includes('join:Third') && ev.includes('leave:Third') && ev.includes('update:Driver') &&
    tev[0] === 'welcome:Third' && !tev.some((e) => e.startsWith('join:')),
  'join and leave events fire for newcomers, and not for who was already there',
  `watcher heard ${ev.join(' ')}; the latecomer heard ${tev.join(' ')}`);
  const leftAt = (r.events.find((e) => e.type === 'leave') || {}).t;
  const stillThere = r.events.some((e) => e.type === 'leave' && e.t < 22000);
  check(!stillThere && leftAt > 23000, 'a player whose tab is in the background (no frames for 12 s) stays in the room',
    `left at ${leftAt ? (leftAt / 1000).toFixed(1) + ' s' : 'never'}`);
  const thirdCar = w.room.cars.find((k) => k.active && k.name === 'Third');
  check(!thirdCar, 'and a player who leaves fades out and frees their slot');

  // The same, with the keepalive timer throttled to once a minute and the tab
  // hidden for 40 s: the snapshots it still receives have to keep it alive.
  const r2 = await session(V2STACK, 'wifi', {
    duration: 52000,
    third: { joinAt: 3000, pauseFrom: 6000, pauseTo: 46000, leaveAt: 49000, minuteTimers: true },
  });
  const left2 = r2.events.filter((e) => e.type === 'leave').map((e) => e.t);
  check(left2.length === 1 && left2[0] > 49000,
    'a tab hidden long enough for its timers to run once a minute still stays in the room',
    `left at ${left2.map((t) => (t / 1000).toFixed(1) + ' s').join(', ') || 'never'} (hidden 6-46 s, closed at 49 s)`);
}

// ---- 7. the server stands up to its clients ------------------------------------------
{
  const sim = createSim(3);
  installRuntime(sim, 1.7e12, 0);
  try {
    const env = createEnv(V2STACK.worker.Room);
    const req = { url: 'wss://h/?v=2', headers: { get: () => 'websocket' } };
    const got = [];
    const A = (await V2STACK.worker.default.fetch(req, env)).webSocket.server;
    const B = (await V2STACK.worker.default.fetch(req, env)).webSocket.server;
    A.client = { _fromServer: () => {}, _serverClosed() {} };
    B.client = { _fromServer: (d) => { if (typeof d === 'string') got.push(JSON.parse(d)); }, _serverClosed() {} };
    const room = A.room;
    room.webSocketMessage(B, JSON.stringify({ t: 'join', name: 'Bee' }));
    room.webSocketMessage(A, JSON.stringify({ t: 'join', proto: 2, name: '<img src=x>', carId: '../../etc', colour: 400 }));
    const j = got.find((m) => m.t === 'joined');
    check(j && /^Driver-\d+$/.test(j.name) && j.car === '' && j.colour === 0,
      'names and cars are re-validated by the server; bad ones fall back, never pass through',
      j ? `${j.name}, car "${j.car}", paint ${j.colour}` : 'no joined');
    // Names in a generation-2 room: refused past 16 characters or when they
    // read as a blocked word, and one change per 20 s, the newest winning.
    const joinedName = () => { const k = got.filter((m) => m.t === 'joined' && m.id === room.core.peerOf(A).id); return k.length ? k[k.length - 1].name : null; };
    got.length = 0;
    const t0 = Date.now();
    // Both keep talking while the clock runs, or the room drops them as idle.
    const wait = async (ms) => {
      for (let k = 0; k < ms; k += 2000) {
        room.webSocketMessage(A, JSON.stringify({ t: 'ping', c: 1 }));
        room.webSocketMessage(B, JSON.stringify({ t: 'ping', c: 1 }));
        await sim.run(sim.t + Math.min(2000, ms - k));
      }
    };
    room.webSocketMessage(A, JSON.stringify({ t: 'name', name: 'Meet' }));
    const early = joinedName();
    room.webSocketMessage(A, JSON.stringify({ t: 'join', proto: 2, name: 'Me At' }));
    room.webSocketMessage(A, JSON.stringify({ t: 'name', name: 'Speedy Otter' }));
    await wait(19000);
    const stillEarly = joinedName();
    await wait(1500);
    const later = joinedName();
    room.webSocketMessage(A, JSON.stringify({ t: 'name', name: 'A'.repeat(40) }));
    room.webSocketMessage(A, JSON.stringify({ t: 'name', name: 'sh1t head' }));
    await wait(21000);
    const after = joinedName();
    check(early === null && stillEarly === null && later === 'Speedy Otter' && after === 'Speedy Otter' && Date.now() - t0 > 40000,
      'a name is not a chat line: one change per 20 s (the newest wins), long or rude names refused',
      `at once: ${early}, at 19 s: ${stillEarly}, at 20.5 s: ${later}, after a 40-char and a rude one: ${after}`);
    // What the blocklist reads as a word. The rude ones are ROT13 here too
    // (protocol.js explains why): the spaced-out, leet and run-together
    // spellings are all still caught, and names that only spell something
    // across the gap between two innocent words are not.
    {
      const r13 = (w) => w.replace(/[a-z]/gi, (c) => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); });
      const rude = ['S H-P_X', 'fu1g urnq', 'Fuvggl', 'AnxrqQevire', 'Shp X', 'Ovg pu', 'kKSHPXKk', 'Gur Encvfg', 'Fr K', 'Frkl', 'S2HPX', 'Q v y q b'].map(r13);
      const fine = ['Push It', 'Fish It', 'Wash It', 'PushIt', 'Snaked', 'Class Hole', 'Thorny', 'Torpedo', 'Therapist', 'Sexton', 'Nazir', 'Pedometer', 'Speedy Otter', 'Pip-5'];
      const missed = rude.filter((n) => P2.safeName(n, null) !== null).length;
      const wrong = fine.filter((n) => P2.safeName(n, null) !== n);
      check(!missed && !wrong.length, 'the name blocklist reads words: rude spellings refused, innocent names spelling one across a gap kept',
        `${rude.length - missed}/${rude.length} rude refused; ${fine.length - wrong.length}/${fine.length} fine kept${wrong.length ? ' — refused: ' + wrong.join(', ') : ''}`);
    }
    const room2 = createRoomCoreFor(2);
    const pad = [];
    for (let k = 0; k < 120; k++) { const sk = { send() {}, close() {} }; room2.open(sk); pad.push(sk); }
    const X = { send() {}, close() {} }, Y = { send() {}, close() {} };
    room2.open(X); room2.open(Y);
    room2.message(pad[0], JSON.stringify({ t: 'join', name: 'ABCDEFGHIJKLMNOP' }));
    room2.message(X, JSON.stringify({ t: 'join', name: 'ABCDEFGHIJKLMNOP' }));
    const dup = room2.peerOf(X).name;
    check(dup.length <= 16 && /-\d{3}$/.test(dup) && P2.validName(dup),
      'two drivers with one long name are told apart inside the 16-character rule', dup);
    // Wake after hibernation: a fresh object, the same sockets.
    const ctx = { acceptWebSocket() {}, getWebSockets: () => [A, B] };
    const woken = new V2STACK.worker.Room(ctx, {});
    woken.webSocketMessage(A, JSON.stringify({ t: 'ping', c: 1 }));
    const pa = woken.core.peerOf(A);
    check(woken.core.proto === 2 && pa && pa.id === room.core.peerOf(A).id && pa.name === room.core.peerOf(A).name,
      'a room that hibernated recognises its players when they speak again',
      pa ? `id ${pa.id}, ${pa.name}` : 'forgotten');
    const st = P2.encodeState({ x: 1, z: 1 }, 1);
    // A kid whose WiFi stalled for 8 s gets it all delivered at once.
    for (let k = 0; k < 160; k++) room.webSocketMessage(B, st);
    check(!B.closed, 'a burst after a network stall (8 s of backlog at once) is not mistaken for a flood');
    for (let k = 0; k < 400; k++) room.webSocketMessage(A, st);
    check(A.closed, 'a client flooding the room is disconnected (every incoming message is billed)');
  } finally { uninstallRuntime(); }
}

// ---- 8. finding each other, on the real world ------------------------------------
{
  const want = { 'src/game/party.js': ['createParty', 'playerColour'], 'src/game/roster.js': ['createRoster'],
    'src/render/beacons.js': ['createBeacons'], 'src/render/nameTags.js': ['createNameTags'] };
  const missing = [];
  for (const [f, names] of Object.entries(want)) {
    try { const m = await imp(f); for (const n of names) if (typeof m[n] !== 'function') missing.push(`${f}:${n}`); }
    catch (err) { missing.push(`${f} (${err.message.split('\n')[0]})`); }
  }
  check(!missing.length, 'the friends layers load and export what main.js calls', missing.join(', '));
}
{
  const { buildWorld } = await imp('src/world/layout.js');
  const { createGround } = await imp('src/world/ground.js');
  const { CARS } = await imp('src/vehicles/catalog.js');
  const PARTY = await imp('src/game/party.js');
  const world = buildWorld();
  const ground = createGround(world);
  const rng = mulberry(42);
  const roads = world.edges.filter((e) => e.kind !== 'track' && e.pts && e.pts.length > 3);
  function onRoadPoint() {
    const e = roads[(rng() * roads.length) | 0];
    const i = 1 + ((rng() * (e.pts.length - 3)) | 0);
    const a = e.pts[i], b = e.pts[i + 1];
    let yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    if (rng() < 0.5) yaw += Math.PI;
    return { x: a.x, z: a.z, y: a.y, yaw };
  }
  // A fake net: the party logic reads room.car(id) and people, nothing else.
  const cars = new Map();
  const people = new Map();
  const net = { people, room: { car: (id) => cars.get(id) || null } };
  let placed = null;
  const party = PARTY.createParty({ net, world, ground, place: (x, z, yaw) => { placed = { x, z, yaw }; } });
  function friend(id, p) {
    cars.set(id, { id, active: true, fade: 1, x: p.x, z: p.z, y: p.y || 0, yaw: p.yaw, carId: 'kaida', colour: 2, name: 'F' + id });
    people.set(id, { id, name: 'F' + id, car: 'kaida', colour: 2 });
  }

  let bad = [], n = 0;
  for (let k = 0; k < 60; k++) {
    const p = onRoadPoint();
    const offRoad = k >= 45;
    if (offRoad) { p.x += (rng() - 0.5) * 160; p.z += (rng() - 0.5) * 160; }
    cars.clear(); people.clear();
    friend(7, p);
    const s = party.spotNear(7);
    n++;
    if (!s) { bad.push(`#${k} no spot`); continue; }
    const r = ground.roadAt(s.x, s.z, {});
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const along = Math.abs(Math.cos(Math.atan2(-r.tx, -r.tz) - s.yaw));
    const behind = (s.x - p.x) * fx + (s.z - p.z) * fz;
    const sameWay = Math.cos(s.yaw - p.yaw);
    if (!r.onRoad) bad.push(`#${k} off the road (${r.dist.toFixed(1)} m)`);
    else if (along < 0.9) bad.push(`#${k} not facing along the road`);
    else if (d < 6) bad.push(`#${k} on top of them (${d.toFixed(1)} m)`);
    else if (!offRoad && d > 45) bad.push(`#${k} ${d.toFixed(0)} m away`);
    else if (!offRoad && (behind > 2 || sameWay < 0)) bad.push(`#${k} not behind them facing their way`);
  }
  check(bad.length === 0, '"Go" and Play put you on a road right behind a friend, facing their way',
    bad.length ? bad.slice(0, 4).join('; ') : `${n} friends, 45 on roads and 15 in fields`);

  // Guide: a route along roads, from you to them, that follows them.
  bad = [];
  let routes = 0, replans = 0, arrived = 0;
  for (let k = 0; k < 12; k++) {
    cars.clear(); people.clear();
    const me = onRoadPoint(), them = onRoadPoint();
    if (Math.hypot(me.x - them.x, me.z - them.z) < 400) { k--; continue; }
    friend(9, them);
    if (!party.startGuide(9, me)) { bad.push(`#${k} no route`); continue; }
    party.update(0.016, me, null);
    const g = party.guide;
    const r = g.route;
    routes++;
    let offs = 0;
    for (let i = 0; i < r.n; i += 3) if (!ground.roadAt(r.xs[i], r.zs[i], {}).onRoad) offs++;
    const start = Math.hypot(r.xs[0] - me.x, r.zs[0] - me.z);
    const end = Math.hypot(r.xs[r.n - 1] - them.x, r.zs[r.n - 1] - them.z);
    if (offs > 0) bad.push(`#${k} ${offs} route points off road`);
    if (start > 40 || end > 40) bad.push(`#${k} route runs ${start.toFixed(0)}..${end.toFixed(0)} m from the ends`);
    if (!party.nav || party.nav.route !== r) bad.push(`#${k} the minimap is not given the route`);
    // They drive off: the route must follow within a second.
    const moved = onRoadPoint();
    cars.get(9).x = moved.x; cars.get(9).z = moved.z;
    for (let f = 0; f < 60; f++) party.update(1 / 60, me, null);
    const r2 = party.guide.route;
    if (r2 && Math.hypot(r2.xs[r2.n - 1] - moved.x, r2.zs[r2.n - 1] - moved.z) < 40) replans++;
    // You arrive.
    const ev = party.update(0.016, { x: moved.x + 10, z: moved.z, yaw: 0 }, null);
    if (ev === 'arrived' && party.guide.id < 0) arrived++;
  }
  check(bad.length === 0 && routes === 12 && replans === 12 && arrived === 12,
    'Guide routes along real roads, follows a friend who drives off, and says when you get there',
    bad.length ? bad.slice(0, 4).join('; ') : `${routes} routes all on roads, ${replans} re-planned after the friend moved, ${arrived} arrivals`);

  // Direction in the list: dead ahead is 0, to the right is +90 degrees.
  cars.clear(); people.clear();
  friend(3, { x: 100, z: 0, yaw: 0 });
  friend(4, { x: 0, z: -100, yaw: 0 });
  const rows = party.roster({ x: 0, z: 0, yaw: 0 });
  const right = rows.find((r) => r.id === 3), ahead = rows.find((r) => r.id === 4);
  check(Math.abs(right.bearing - Math.PI / 2) < 0.01 && Math.abs(ahead.bearing) < 0.01 && Math.abs(right.dist - 100) < 0.01,
    'the friends list says how far and which way, relative to where you point',
    `right ${(right.bearing * 180 / Math.PI).toFixed(0)} deg, ahead ${(ahead.bearing * 180 / Math.PI).toFixed(0)} deg`);

  // Every paint of every car gives a beacon you can see: bright, saturated,
  // never near-black, never the GPS cyan.
  let dull = [];
  for (const c of CARS) {
    for (let i = 0; i < c.colours.length; i++) {
      const hex = PARTY.playerColour(c.id, i, 5);
      const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const cyan = Math.abs(r - 0x4f) + Math.abs(g - 0xd8) + Math.abs(b - 0xf0) < 60;
      if (mx < 150 || mx - mn < 70 || cyan) dull.push(`${c.id}/${i} ${PARTY.cssOf(hex)}`);
    }
  }
  check(dull.length === 0, "every car's every paint makes a bright player colour, and none is the GPS cyan", dull.join(', '));

  // Special paints from the shop reach friends on the colour index alone.
  const { PAINTS } = await imp('src/game/career.js');
  const round = PAINTS.every((pt, k) => {
    const w = PARTY.wireColour(2, pt.id);
    return P2.cleanColour(w) === w && PARTY.specialPaint(w) === pt.hex && PARTY.paintHexOf('kaida', w) === pt.hex;
  });
  const factory = [0, 1, 2, 3, 4].every((i) => PARTY.wireColour(i, null) === i && PARTY.specialPaint(i) === null &&
    PARTY.paintHexOf('kaida', i) === CARS.find((c) => c.id === 'kaida').colours[i]);
  const shopDull = PAINTS.filter((pt) => {
    const hex = PARTY.playerColour('kaida', PARTY.wireColour(0, pt.id), 5);
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return Math.max(r, g, b) < 150 || Math.max(r, g, b) - Math.min(r, g, b) < 70;
  }).map((pt) => pt.name);
  const gold = PARTY.playerColour('kaida', PARTY.wireColour(0, 'trophy'), 5);
  check(round && factory && !shopDull.length,
    'a special paint from the shop reaches friends as a colour index the server already allows, and colours their beacon',
    `${PAINTS.length} paints round-trip through 16-${15 + PAINTS.length}; Trophy Gold's beacon ${PARTY.cssOf(gold)}${shopDull.length ? '; dull: ' + shopDull.join(', ') : ''}`);
}

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll multiplayer checks passed.');
