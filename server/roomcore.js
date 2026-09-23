/**
 * One room's logic, with no host in it.
 *
 * worker.js (a Cloudflare Durable Object) and node-server.js (a plain process)
 * both wrap this, so the two hosts cannot drift apart the way two copies of the
 * same loop eventually do. It never touches a platform API: a "socket" is
 * anything with send() and close(), the clock is passed in, and the host owns
 * the timer. That is also what lets tools/netcheck.mjs drive it in bare Node.
 *
 * A room holds ONE protocol generation (see protocol.js, roomName()). For
 * generation 1 every message is byte-for-byte what the original Worker sent,
 * because cached pages from before this file existed are still out there and
 * this is the server they will reconnect to.
 */

import {
  encodeSnapshot, decodeState, cleanName, safeName, cleanCarId, cleanColour,
  PROTO_V2, AGE_STALE, MAX_BURST,
} from '../src/net/protocol.js';
import { createModes } from './modes.js';

export const TICK_MS = 50;             // 20 Hz downstream
export const MAX_PLAYERS = 16;
export const STALE_MS = 8000;
// A real client sends 20 states and a ping or two a second; every incoming
// message is metered. A token bucket, not a per-second count: after a WiFi
// stall TCP delivers everything that was held up in one burst — 5 s of it is
// 100 messages at once — and a hard 90-a-second window disconnected exactly
// the kid whose connection had just recovered. Bursts of BURST pass; a
// sustained flood above RATE a second drains the bucket and is cut off.
const BURST = 300, RATE = 45;
// How fast the per-player clock estimate may creep upwards between the
// packets that pin it: 1 ms per second, ten times any real crystal's drift.
const CREEP = 0.001;
// ... and over how much silence. Creep is there for drift, which is about
// 0.1 ms a second; over a 2.8 s WiFi dropout it added 2.8 ms, which the first
// fresh packet then took back — a 7% speed blip in one segment of the car's
// curve, a 10 cm lurch on screen. A quarter of a second of creep covers the
// normal 50 ms spacing five times over.
const CREEP_SPAN = 250;
// A name is shown to everyone in a public room of kids, so it must not work as
// a chat line. The client already waits until typing stops; the server then
// takes at most one new name per player every RENAME_MS. A name that arrives
// sooner waits, and the newest waiting one is put up when the time comes —
// a kid fixing a typo still ends up with the right name, while 'meet me',
// 'at the', 'barn' would take a minute to spell out. Generation 2 only.
const RENAME_MS = 20000;

/** Who is IT first needs a coin toss, not cryptography. Seeded from the
 *  room's own clock, so a harness on a simulated clock is repeatable. */
function seeded(seed) {
  let a = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * opts: { proto, now: () => wall ms, maxPlayers, rng }
 * Returns { open, message, close, tick, restore, has, size, rate, proto }.
 */
export function createRoomCore(opts = {}) {
  const proto = opts.proto === PROTO_V2 ? PROTO_V2 : 1;
  const v2 = proto === PROTO_V2;
  const now = opts.now || (() => Date.now());
  const maxPlayers = opts.maxPlayers || MAX_PLAYERS;
  const persist = opts.persist || null;     // (sock, info) — the Worker's hibernation hook
  const epoch = now();
  const peers = new Map();                  // sock -> peer
  let cursor = 1;
  const out = [];                           // snapshot scratch, reused every tick

  const ms = () => (now() - epoch) | 0;

  // Party games (server/modes.js): generation 2 only, so a protocol-1 room
  // never sends a byte of them.
  const modes = v2 ? createModes({
    ms,
    players: () => peers.values(),
    broadcast: (obj, exceptId) => {
      const s = JSON.stringify(obj);
      for (const [sock, q] of peers) {
        if (q.id === exceptId || !q.joined) continue;
        try { sock.send(s); } catch { /* closing */ }
      }
    },
    rng: opts.rng || seeded(epoch),
  }) : null;

  /**
   * Ids are one byte and go round. The original took `nextId++ & 0xff`, which
   * after 255 joins in one room's lifetime hands out 0 and then ids still in
   * use — two players driving one car on everybody's screen. This walks on
   * from the last one given out, so a leaver's id is not reused at once
   * either (their car is still fading out on other screens).
   */
  function allocId() {
    const used = new Set();
    for (const p of peers.values()) used.add(p.id);
    for (let k = 0; k < 255; k++) {
      const id = ((cursor - 1 + k) % 255) + 1;
      if (!used.has(id)) { cursor = (id % 255) + 1; return id; }
    }
    return -1;
  }

  function info(p) {
    return v2 ? { id: p.id, name: p.name, car: p.car, colour: p.colour } : { id: p.id, name: p.name };
  }
  function save(sock, p) {
    if (persist) {
      try { persist(sock, { id: p.id, name: p.name, car: p.car, colour: p.colour, proto }); } catch { /* best effort */ }
    }
  }

  function newPeer(id, name) {
    return {
      id, name, car: '', colour: 0, rec: null, queue: [], last: now(),
      minOff: null, lastRecv: 0, lastSample: -Infinity, tokens: BURST, tokT: now(),
      joined: false, nameAt: -Infinity, wantName: null,
    };
  }
  /** The name rule for this room's generation (see protocol.js). */
  const nameRule = v2 ? safeName : cleanName;

  /** A socket was accepted. Returns its id, or -1 if the room is full. */
  function open(sock) {
    if (peers.size >= maxPlayers) return -1;
    const id = allocId();
    if (id < 0) return -1;
    const p = newPeer(id, 'Driver-' + id);
    peers.set(sock, p);
    save(sock, p);
    return id;
  }

  /**
   * A Durable Object that hibernated comes back with an empty map and live
   * sockets. Rebuild the player from what was attached to the socket instead
   * of ignoring them until they reconnect — ignored, their car freezes on
   * everyone's screen and then vanishes.
   */
  function restore(sock, att) {
    if (peers.has(sock) || !att || typeof att.id !== 'number') return false;
    const p = newPeer(att.id & 0xff, nameRule(att.name, 'Driver-' + att.id));
    p.joined = true;
    p.car = cleanCarId(att.car);
    p.colour = cleanColour(att.colour);
    peers.set(sock, p);
    cursor = (p.id % 255) + 1;
    return true;
  }

  function send(sock, obj) {
    try { sock.send(JSON.stringify(obj)); } catch { /* closing; close() cleans up */ }
  }
  function broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const sock of peers.keys()) {
      if (sock === except) continue;
      try { sock.send(s); } catch { /* closing */ }
    }
  }

  function message(sock, data) {
    const p = peers.get(sock);
    if (!p) return;
    const t = now();
    p.last = t;
    p.tokens = Math.min(BURST, p.tokens + (t - p.tokT) * (RATE / 1000));
    p.tokT = t;
    if (p.tokens < 1) {
      try { sock.close(1008, 'too fast'); } catch { /* gone */ }
      return;
    }
    p.tokens -= 1;

    if (typeof data === 'string') { if (data.length <= 512) control(sock, p, data); return; }

    const buf = data instanceof ArrayBuffer ? data : (data && data.buffer) || null;
    if (!buf) return;
    const st = decodeState(buf);
    if (!st) return;
    // The id on the wire is ignored. A client does not get to say who it is —
    // otherwise anyone can drive someone else's car by editing one byte.
    st.car.id = p.id;
    if (v2) { stamp(p, st, t); p.recMs = ms(); }
    p.rec = st.car;
  }

  /**
   * When was this sample taken, in the server's clock?
   *
   * The client says when in ITS clock (clientMs). recv - clientMs is the two
   * clocks' offset plus this packet's trip time; the smallest value seen is
   * the offset plus the FASTEST trip, and every other packet's extra delay is
   * jitter to be thrown away. What survives is a timeline for each car that
   * is off by a constant — which nobody can see — instead of by a random
   * 0-50 ms on every sample, which everybody can.
   */
  function stamp(p, st, t) {
    const recv = t - epoch;
    const off = recv - st.clientMs;
    // Never re-anchored after a quiet spell. The client's clock is its own
    // performance.now() from this connection's open, so the true offset only
    // ever drifts, and CREEP already allows for that across any gap. The
    // version this replaces reset minOff after 2 s of silence — and silence
    // is exactly what a WiFi stall is: the first packet of the backlog set
    // the offset 2.7 s too late, every fresh sample after it was then forced
    // onto lastSample + 1 ms, and the car jumped 64 m and crept backwards.
    if (p.minOff === null) p.minOff = off;
    else p.minOff = Math.min(p.minOff + Math.min(recv - p.lastRecv, CREEP_SPAN) * CREEP, off);
    p.lastRecv = recv;
    let at = Math.round(st.clientMs + p.minOff);
    if (at <= p.lastSample) at = p.lastSample + 1;
    p.lastSample = at;
    st.car.sampleMs = at;
    if (p.queue.length >= MAX_BURST) p.queue.shift();
    p.queue.push(st.car);
  }

  function control(sock, p, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join') {
      // A second join on one socket is only ever a way round the rename
      // limit (net.js joins once per connection): treat it as a rename.
      if (v2 && p.joined) { rename(sock, p, m.name); return; }
      p.name = unique(nameRule(m.name, 'Driver-' + p.id), p.id);
      p.joined = true;
      p.nameAt = now();
      if (v2) { p.car = cleanCarId(m.carId); p.colour = cleanColour(m.colour); }
      save(sock, p);
      const players = [];
      for (const q of peers.values()) players.push(info(q));
      const welcome = { t: 'welcome', id: p.id, sendHz: rate(), serverMs: ms(), players };
      // A game already on is part of the room a late arrival walks into.
      if (v2) { welcome.proto = PROTO_V2; welcome.tickMs = TICK_MS; welcome.mode = modes.wire(); }
      send(sock, welcome);
      broadcast({ t: 'joined', ...info(p) }, sock);
    } else if (m.t === 'name') {
      if (v2) { rename(sock, p, m.name); return; }
      p.name = unique(cleanName(m.name, p.name), p.id);
      save(sock, p);
      broadcast({ t: 'joined', ...info(p) });
    } else if (m.t === 'car' && v2) {
      p.car = cleanCarId(m.car);
      p.colour = cleanColour(m.colour);
      save(sock, p);
      broadcast({ t: 'joined', ...info(p) });
    } else if (m.t === 'ping') {
      send(sock, { t: 'pong', c: m.c, s: ms() });
    } else if (v2 && (m.t === 'mode' || m.t === 'emote')) {
      modes.control(p, m);
    }
  }

  /** A new name, generation 2: refused names keep the old one, and at most
   *  one change goes out every RENAME_MS (see above). */
  function rename(sock, p, raw) {
    const n = safeName(raw, '');
    if (!n) return;
    p.wantName = n;
    flushName(sock, p, now());
  }
  function flushName(sock, p, t) {
    if (p.wantName === null || t - p.nameAt < RENAME_MS) return;
    const n = unique(p.wantName, p.id);
    p.wantName = null;
    if (n === p.name) return;
    p.name = n;
    p.nameAt = t;
    save(sock, p);
    broadcast({ t: 'joined', ...info(p) });
  }

  /** Two players called "Ace" is confusing at 200 km/h; disambiguate server-side. */
  function unique(name, id) {
    let taken = false;
    for (const q of peers.values()) if (q.id !== id && q.name === name) taken = true;
    if (!taken) return name;
    // Generation 2 keeps the result inside the 16-character rule: the old cut
    // at 13 made 'ABCDEFGHIJKLM-123' once ids passed 99. Generation 1 keeps
    // the old cut, byte for byte.
    if (!v2) return name.slice(0, 13) + '-' + id;
    return name.slice(0, 15 - String(id).length).trimEnd() + '-' + id;
  }

  /** Throttle as the room fills, so a busy room degrades smoothly instead of
   *  hitting the request ceiling and dying outright. */
  function rate() {
    const n = peers.size;
    return n <= 6 ? 20 : n <= 10 ? 15 : 10;
  }

  /** Returns true if the socket was a player (so a `left` went out). */
  function close(sock) {
    const p = peers.get(sock);
    if (!p) return false;
    peers.delete(sock);
    broadcast({ t: 'left', id: p.id });
    if (modes) modes.drop(p.id);
    return true;
  }

  /**
   * One snapshot to everyone. `socks` is the host's own list of live sockets
   * when it has one (a Durable Object's getWebSockets() survives hibernation;
   * our map does not), and a socket this room has never heard of is restored
   * from its attachment before anything else happens.
   */
  function tick(socks, attachmentOf) {
    const t = now();
    const list = socks || [...peers.keys()];
    out.length = 0;
    const snapMs = ms();
    for (const sock of list) {
      let p = peers.get(sock);
      if (!p && attachmentOf) { restore(sock, attachmentOf(sock)); p = peers.get(sock); }
      if (!p) continue;
      if (t - p.last > STALE_MS) { try { sock.close(1000, 'idle'); } catch { /* gone */ } continue; }
      if (p.wantName !== null) flushName(sock, p, t);
      if (!v2) { if (p.rec) out.push(p.rec); continue; }
      if (p.queue.length) {
        for (const r of p.queue) { r.age = Math.min(AGE_STALE, Math.max(0, snapMs - r.sampleMs)); out.push(r); }
        p.queue.length = 0;
      } else if (p.rec) {
        // Nothing new: still listed, so everyone knows the car is there, but
        // aged as what it is. The client never mistakes it for a new sample.
        p.rec.age = Math.min(AGE_STALE, Math.max(0, snapMs - p.rec.sampleMs));
        out.push(p.rec);
      }
    }
    if (modes) modes.tick();
    if (!out.length) return null;
    const frame = encodeSnapshot(out, snapMs);
    for (const sock of list) {
      if (!peers.has(sock)) continue;
      try { sock.send(frame); } catch { /* gone */ }
    }
    return frame;
  }

  return {
    proto, open, message, close, tick, restore, rate, ms,
    has: (sock) => peers.has(sock),
    /** The party games (null in a protocol-1 room). */
    get modes() { return modes; },
    get size() { return peers.size; },
    /** For the harness. */
    peerOf: (sock) => peers.get(sock) || null,
  };
}
