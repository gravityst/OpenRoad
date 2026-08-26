/**
 * Remote cars: buffering, interpolation and dead reckoning.
 *
 * This is where "multiplayer feels laggy" is won or lost, and it has almost
 * nothing to do with who hosts the server. The rules:
 *
 *   1. YOUR car is never in here. It is simulated locally at 120 Hz against
 *      your own input and nothing from the network is ever allowed to write to
 *      it. That is what makes steering latency exactly zero at any ping.
 *   2. Remote cars are drawn DELIBERATELY IN THE PAST — one full send interval
 *      plus a margin — so there is always a snapshot on both sides of the time
 *      being rendered and the motion is an interpolation, never a guess.
 *   3. When a packet is late we extrapolate along a constant-turn arc rather
 *      than a straight line, because a car that is turning keeps turning. A
 *      straight-line guess visibly cuts the corner and then snaps back.
 *
 * Imports only the protocol. No three.js, no DOM — the harness runs this in
 * bare Node with fake timestamps.
 */

import { decodeSnapshot, snapshotTime, F_BRAKE, F_INDL, F_INDR, F_TELEPORT } from './protocol.js';

const RING = 8;                 // snapshots kept; 8 x 50 ms = 400 ms of history
const SNAP_DIST = 5.0;          // past one car length, cut rather than slide
const MAX_EXTRAP = 0.25;        // 250 ms; 1/2*a*t^2 at 10 m/s^2 = 0.31 m of error
const IGNORE = 0.25;            // below this, corrections are invisible — don't
const TAU = Math.PI * 2;

/** Shortest signed angular difference. Without this a car crossing the +/-pi
 *  seam spins the long way round — 6.2 radians of travel to move 0.08. */
export function angDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

const lerp = (a, b, t) => a + (b - a) * t;

export function createRoom(opts = {}) {
  const maxPlayers = opts.maxPlayers ?? 16;
  // Rendered this far behind server time. Two send intervals means one packet
  // can be lost outright and there is still data on both sides of `now`.
  let interpMs = opts.interpMs ?? 100;

  const snaps = [];             // ring of {t, n, cars[]}
  let head = -1;
  const cars = [];              // stable slots, reused; index != player id
  const byId = new Map();
  let selfId = -1;

  // Clock sync. The median, never the mean — network delay is heavy-tailed and
  // a single 400 ms outlier drags a mean far enough to desync the whole room.
  const offsets = [];
  let clockOffset = null;
  let rttMs = 0;

  function slotFor(id) {
    let c = byId.get(id);
    if (c) return c;
    if (byId.size >= maxPlayers) return null;
    c = cars.find(k => !k.active);
    if (!c) {
      if (cars.length >= maxPlayers) return null;
      c = {
        id: -1, active: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
        vx: 0, vz: 0, yawRate: 0, steer: 0, wheelSpin: 0, integrity: 1,
        flags: 0, respawnSeq: 0, name: '', brake: false, indL: false, indR: false,
        lastSeen: 0, fade: 0, dist: 0,
      };
      cars.push(c);
    }
    c.id = id;
    c.active = true;
    byId.set(id, c);
    return c;
  }

  /** A snapshot arrived. Ordered by server time, so a late or duplicated
   *  packet is dropped rather than allowed to drag cars backwards. */
  function onSnapshot(buf, nowMs) {
    const t = snapshotTime(buf);
    if (head >= 0 && t <= snaps[head].t) return false;   // stale or duplicate
    head = (head + 1) % RING;
    let s = snaps[head];
    if (!s) s = snaps[head] = { t: 0, n: 0, cars: [] };
    s.t = t;
    s.n = decodeSnapshot(buf, s.cars);
    if (s.n < 0) { s.n = 0; return false; }
    // First snapshot establishes the clock; after that we only nudge.
    if (clockOffset === null) clockOffset = t - nowMs;
    return true;
  }

  function onPong(clientMs, serverMs, nowMs) {
    const rtt = nowMs - clientMs;
    if (rtt < 0 || rtt > 2000) return;
    rttMs = rttMs ? rttMs * 0.8 + rtt * 0.2 : rtt;
    // Server time at the instant we received it, assuming a symmetric path.
    offsets.push(serverMs + rtt * 0.5 - nowMs);
    if (offsets.length > 20) offsets.shift();
    const sorted = offsets.slice().sort((a, b) => a - b);
    clockOffset = sorted[sorted.length >> 1];
  }

  /**
   * Advance every remote car to the moment `nowMs` maps to. Called once per
   * rendered frame, NOT per physics step — these are visual only.
   */
  function update(nowMs, dt) {
    if (clockOffset === null || head < 0) { fadeAll(dt); return; }
    const target = nowMs + clockOffset - interpMs;

    // Find the pair of snapshots bracketing `target`, newest-first.
    let after = null, before = null;
    for (let k = 0; k < RING; k++) {
      const s = snaps[(head - k + RING * 2) % RING];
      if (!s || !s.t) continue;
      if (s.t >= target) after = s;
      else { before = s; break; }
    }

    for (const c of cars) if (c.active) c.seen = false;

    if (before && after && after !== before) {
      const span = after.t - before.t;
      const a = span > 0 ? (target - before.t) / span : 1;
      applyPair(before, after, a);
    } else if (before) {
      // Nothing newer than `target` — the feed is late. Extrapolate, briefly.
      applyExtrap(before, Math.min((target - before.t) / 1000, MAX_EXTRAP));
    } else if (after) {
      applyPair(after, after, 0);
    }

    for (const c of cars) {
      if (!c.active) continue;
      if (!c.seen) {
        // Gone from the feed: fade, then release the slot. Never yank it away
        // mid-frame — a car vanishing instantly reads as a crash, not a leave.
        c.fade = Math.max(0, c.fade - dt / 0.4);
        if (c.fade <= 0) { c.active = false; byId.delete(c.id); }
      } else {
        c.fade = Math.min(1, c.fade + dt / 0.25);
      }
    }
  }

  function fadeAll(dt) {
    for (const c of cars) {
      if (!c.active) continue;
      c.fade = Math.max(0, c.fade - dt / 0.4);
      if (c.fade <= 0) { c.active = false; byId.delete(c.id); }
    }
  }

  function applyPair(b, a, f) {
    for (let i = 0; i < a.n; i++) {
      const rec = a.cars[i];
      if (rec.id === selfId) continue;
      const c = slotFor(rec.id);
      if (!c) continue;
      let prev = null;
      for (let j = 0; j < b.n; j++) if (b.cars[j].id === rec.id) { prev = b.cars[j]; break; }
      write(c, prev || rec, rec, prev ? f : 1);
      c.seen = true;
    }
  }

  function applyExtrap(s, t) {
    for (let i = 0; i < s.n; i++) {
      const rec = s.cars[i];
      if (rec.id === selfId) continue;
      const c = slotFor(rec.id);
      if (!c) continue;
      write(c, rec, rec, 1);
      if (t > 0) {
        // Constant-turn arc. A car mid-corner keeps cornering; a straight-line
        // guess visibly cuts the apex and then snaps back when the packet lands.
        const w = rec.yawRate;
        const yaw = rec.yaw + w * t;
        if (Math.abs(w) > 1e-3) {
          const r0 = Math.atan2(rec.vx, rec.vz);
          const sp = Math.hypot(rec.vx, rec.vz);
          c.x = rec.x + (Math.sin(r0 + w * t) - Math.sin(r0)) * sp / w;
          c.z = rec.z + (Math.cos(r0 + w * t) - Math.cos(r0)) * sp / w;
        } else {
          c.x = rec.x + rec.vx * t;
          c.z = rec.z + rec.vz * t;
        }
        c.yaw = yaw;
        // y is deliberately NOT extrapolated — guessing vertical motion tilts
        // cars into the road, which is far more obvious than being 20 cm behind.
      }
      c.seen = true;
    }
  }

  function write(c, p, n, f) {
    // A teleport or a slot reuse is a cut, not a move. Interpolating across it
    // would send the car streaking across the map at 400 m/s.
    const jump = (n.flags & F_TELEPORT) || n.respawnSeq !== c.respawnSeq ||
                 Math.hypot(n.x - c.x, n.z - c.z) > SNAP_DIST;
    if (jump && c.fade > 0) {
      c.x = n.x; c.z = n.z; c.y = n.y; c.yaw = n.yaw;
    } else {
      const x = lerp(p.x, n.x, f), z = lerp(p.z, n.z, f), y = lerp(p.y, n.y, f);
      // Below a quarter of a metre nobody can tell, so don't spend a correction
      // on it — this is what stops remote cars shimmering when they sit still.
      c.x = Math.abs(x - c.x) < IGNORE && f < 1 ? c.x : x;
      c.z = Math.abs(z - c.z) < IGNORE && f < 1 ? c.z : z;
      c.y = y;
      c.yaw = p.yaw + angDelta(p.yaw, n.yaw) * f;
    }
    c.pitch = lerp(p.pitch, n.pitch, f);
    c.roll = lerp(p.roll, n.roll, f);
    c.vx = n.vx; c.vz = n.vz; c.yawRate = n.yawRate;
    c.steer = lerp(p.steer, n.steer, f);
    c.wheelSpin = n.wheelSpin;
    c.integrity = n.integrity;
    c.flags = n.flags;
    c.respawnSeq = n.respawnSeq;
    c.brake = !!(n.flags & F_BRAKE);
    c.indL = !!(n.flags & F_INDL);
    c.indR = !!(n.flags & F_INDR);
  }

  return {
    get cars() { return cars; },
    get count() { return byId.size; },
    get rtt() { return rttMs; },
    get interp() { return interpMs; },
    setSelf(id) { selfId = id; },
    setName(id, name) { const c = byId.get(id); if (c) c.name = name; },
    /** Derived from the live send rate, so smoothness degrades gracefully as
     *  the server throttles a filling room rather than falling off a cliff. */
    setSendHz(hz) { interpMs = Math.max(80, Math.min(250, 2000 / Math.max(4, hz))); },
    onSnapshot, onPong, update,
    reset() {
      head = -1; snaps.length = 0; offsets.length = 0;
      clockOffset = null; rttMs = 0;
      for (const c of cars) { c.active = false; c.fade = 0; }
      byId.clear();
    },
  };
}
