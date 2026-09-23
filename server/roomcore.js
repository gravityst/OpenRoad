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
  encodeSnapshot, decodeState, cleanName, cleanCarId, cleanColour,
  PROTO_V2, AGE_STALE, MAX_BURST,
} from '../src/net/protocol.js';

export const TICK_MS = 50;             // 20 Hz downstream
export const MAX_PLAYERS = 16;
export const STALE_MS = 8000;
// A real client sends 20 states and a ping or two a second. Anything past
// this is a bug or abuse, and every incoming message is metered.
const MAX_MSGS_PER_S = 90;
// How fast the per-player clock estimate may creep upwards between the
// packets that pin it: 1 ms per second, ten times any real crystal's drift.
const CREEP = 0.001;

/**
 * opts: { proto, now: () => wall ms, maxPlayers }
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
      minOff: null, lastRecv: 0, lastSample: -Infinity, winT: 0, winN: 0,
    };
  }

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
    const p = newPeer(att.id & 0xff, cleanName(att.name, 'Driver-' + att.id));
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
    if (t - p.winT > 1000) { p.winT = t; p.winN = 0; }
    if (++p.winN > MAX_MSGS_PER_S) {
      try { sock.close(1008, 'too fast'); } catch { /* gone */ }
      return;
    }

    if (typeof data === 'string') { if (data.length <= 512) control(sock, p, data); return; }

    const buf = data instanceof ArrayBuffer ? data : (data && data.buffer) || null;
    if (!buf) return;
    const st = decodeState(buf);
    if (!st) return;
    // The id on the wire is ignored. A client does not get to say who it is —
    // otherwise anyone can drive someone else's car by editing one byte.
    st.car.id = p.id;
    if (v2) stamp(p, st, t);
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
    if (p.minOff === null || recv - p.lastRecv > 2000) p.minOff = off;
    else p.minOff = Math.min(p.minOff + (recv - p.lastRecv) * CREEP, off);
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
      p.name = unique(cleanName(m.name, 'Driver-' + p.id), p.id);
      if (v2) { p.car = cleanCarId(m.carId); p.colour = cleanColour(m.colour); }
      save(sock, p);
      const players = [];
      for (const q of peers.values()) players.push(info(q));
      const welcome = { t: 'welcome', id: p.id, sendHz: rate(), serverMs: ms(), players };
      if (v2) { welcome.proto = PROTO_V2; welcome.tickMs = TICK_MS; }
      send(sock, welcome);
      broadcast({ t: 'joined', ...info(p) }, sock);
    } else if (m.t === 'name') {
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
    }
  }

  /** Two players called "Ace" is confusing at 200 km/h; disambiguate server-side. */
  function unique(name, id) {
    let taken = false;
    for (const q of peers.values()) if (q.id !== id && q.name === name) taken = true;
    return taken ? (name.slice(0, 13) + '-' + id) : name;
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
    get size() { return peers.size; },
    /** For the harness. */
    peerOf: (sock) => peers.get(sock) || null,
  };
}
