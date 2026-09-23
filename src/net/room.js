/**
 * Remote cars: a jitter buffer, cubic interpolation and smoothed correction.
 *
 * This is where "multiplayer feels laggy" is won or lost, and it has almost
 * nothing to do with who hosts the server. The rules:
 *
 *   1. YOUR car is never in here. It is simulated locally at 120 Hz against
 *      your own input and nothing from the network is ever allowed to write to
 *      it. That is what makes steering latency exactly zero at any ping.
 *   2. Remote cars are drawn DELIBERATELY IN THE PAST, on a playback clock that
 *      runs a little behind the server's — far enough that there is almost
 *      always a real sample on both sides of the moment being drawn. How far is
 *      measured, not guessed (see "the jitter buffer" below).
 *   3. Between two samples the car follows a cubic Hermite curve through both
 *      positions WITH BOTH VELOCITIES — the record carries them. A straight
 *      line between samples keeps position continuous but makes velocity jump
 *      at every sample, twenty times a second: the car visibly surges and
 *      hesitates. The cubic makes velocity continuous too.
 *   4. When the feed is late the car carries on along a constant-turn arc, and
 *      when the real sample lands the difference is not applied as a jump: it
 *      is handed to a critically damped spring that bleeds it away over a few
 *      tenths of a second. Only an impossible difference (> SNAP_DIST past what
 *      the velocities allow, a respawn, a teleport) is a cut.
 *
 * Each car keeps its own timeline. In a generation-2 room every record says
 * how long before the snapshot it was sampled (protocol.js), so a car's
 * samples sit at the instants they were actually taken, not at whichever tick
 * happened to carry them. From a generation-1 server there is no age and a
 * sample is timed by its snapshot — noisier, and still drawn smoothly.
 *
 * Imports only the protocol. No three.js, no DOM — tools/netcheck.mjs runs
 * this in bare Node against simulated links and measures every frame.
 */

import {
  decodeSnapshot, snapshotTime,
  F_BRAKE, F_INDL, F_INDR, F_LIGHTS, F_AIR, F_TELEPORT, AGE_STALE,
} from './protocol.js';

const RING = 24;                // samples kept per car: over a second at 20 Hz
const SNAP_DIST = 5.0;          // m of error past what the velocities allow: cut, don't slide
const GAP_CUT = 400;            // ms between two samples: a dropout, not a curve to follow
const REBASE = 0.25;            // m past what they allow: move the history, spring the rest
const EXTRAP_LIN = 150;         // ms extrapolated at full speed ...
const EXTRAP_SOFT = 150;        // ... then eased to a stop over about this long
const PRESENCE_MS = 3000;       // unheard this long: fade the car out
const NEEDS = 96;               // jitter-buffer observations kept, all cars pooled
const NEED_Q = 0.95;            // ... and the fraction the delay must cover
const MARGIN = 6;               // ms on top of that
const D_MIN = 35, D_MAX = 450;  // ms, the delay's bounds
const SLOW = 0.12;              // the playback clock may run up to 12% slow ...
const FAST = 0.04;              // ... or 4% fast while it catches its target,
const CLOCK_TAU = 1000;         // ... closing the gap with a 1 s time constant
const CLOCK_SNAP = 750;         // ms off target: jump the playback clock instead
const OMEGA = 9;                // rad/s, the correction spring: 95% gone in ~0.5 s
const PEND = 64;                // snapshots that may queue between two frames
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

function mkSample() {
  return {
    t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0, yawRate: 0,
    steer: 0, flags: 0, respawnSeq: 0, hOff: 0,
  };
}

/** The pose at one instant; two per room, reused. */
function mkPose() {
  return {
    ok: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0,
    steer: 0, flags: 0, respawnSeq: 0, kind: 0,
  };
}

export function createRoom(opts = {}) {
  const maxPlayers = opts.maxPlayers ?? 16;
  // Optional: the local ground. With it, a remote car's height is carried as
  // its height ABOVE the ground and re-laid on this client's ground every
  // frame, so it hugs the road between samples instead of cutting through the
  // crest of a hill on a straight line in y.
  const heightAt = typeof opts.heightAt === 'function' ? opts.heightAt : null;
  let fallbackDelay = opts.interpMs ?? 100;

  const cars = [];              // stable slots, reused; index != player id
  const byId = new Map();
  // Names and cars arrive in the `welcome`/`joined` control messages, which
  // land BEFORE the first snapshot that creates the car. Holding them here and
  // applying on slot creation is what stops every driver being "Driver-<id>".
  const names = new Map();
  const infos = new Map();
  let selfId = -1;
  let stamped = false;          // generation-2 server: records carry their age

  // Snapshots queue here as they arrive and are folded in at the next frame,
  // so a correction can compare the pose before and after at one instant.
  const pend = [];
  for (let i = 0; i < PEND; i++) pend.push({ buf: null, recv: 0 });
  let pendN = 0;
  const pool = [];              // decode scratch

  // ---- clocks --------------------------------------------------------------
  // Server clock from ping/pong. The median of the lowest-RTT half, never the
  // mean — network delay is heavy-tailed, and the fastest round trips are the
  // most symmetric, so they say the most about where the server's clock is.
  const pingRtt = new Float64Array(16), pingOff = new Float64Array(16);
  let pingN = 0, pingHead = 0;
  const sortA = new Float64Array(NEEDS), sortB = new Float64Array(16);
  let offset = null;            // server ms - local ms
  let rttMs = 0;

  // The jitter buffer. For each arrival: how far behind the server clock the
  // playback would have had to be for the car's previous newest sample to
  // still be ahead of it. That one number folds in the send interval, the
  // tick phase, every leg's jitter and any stall; keep the delay at its 95th
  // percentile and interpolation almost never runs dry. Too small a delay is
  // a car that extrapolates and corrects; too large is a car drawn late. This
  // is the smallest delay that is smooth on the link you actually have.
  const needs = new Float64Array(NEEDS);
  let needN = 0, needHead = 0;
  let delay = fallbackDelay;
  let delayAt = -Infinity;
  let play = 0, playOk = false;

  const stats = { frames: 0, extrap: 0, corrections: 0, cuts: 0, maxCorr: 0, rebases: 0 };

  const before = mkPose(), after = mkPose();
  let snapSeq = 0;

  function slotFor(id) {
    let c = byId.get(id);
    if (c) return c;
    if (byId.size >= maxPlayers) return null;
    c = cars.find((k) => !k.active);
    if (!c) {
      if (cars.length >= maxPlayers) return null;
      c = {
        id: -1, active: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
        vx: 0, vz: 0, yawRate: 0, steer: 0, wheelSpin: 0, integrity: 1,
        flags: 0, respawnSeq: 0, name: '', brake: false, indL: false, indR: false,
        lights: false, airborne: false, speed: 0,
        carId: '', colour: 0, infoRev: 0,
        lastSeen: 0, fade: 0, dist: 0, leaving: false,
        // internals
        _s: [], _n: 0, _mark: -1, _prevTop: NaN, _heard: 0, _had: false,
        _ex: 0, _ey: 0, _ez: 0, _eyaw: 0, _vx: 0, _vy: 0, _vz: 0, _vyaw: 0,
        _bx: 0, _by: 0, _bz: 0, _byaw: 0, _bvx: 0, _bvz: 0, _bseq: 0,
      };
      for (let i = 0; i < RING; i++) c._s.push(mkSample());
      cars.push(c);
    }
    c.id = id;
    c.active = true;
    c.leaving = false;
    c.fade = 0;
    c._n = 0; c._mark = -1; c._prevTop = NaN; c._had = false;
    zeroErr(c);
    c.name = names.get(id) || '';
    const inf = infos.get(id);
    c.carId = inf ? inf.car : '';
    c.colour = inf ? inf.colour : 0;
    c.infoRev++;
    byId.set(id, c);
    return c;
  }

  function release(c) {
    c.active = false;
    c.fade = 0;
    c._n = 0;
    byId.delete(c.id);
  }

  // ---- arrivals ----------------------------------------------------------

  /** A snapshot arrived. Queued, not applied: see update(). */
  function onSnapshot(buf, nowMs) {
    if (!buf || buf.byteLength < 6) return false;
    if (offset === null) offset = snapshotTime(buf) - nowMs;
    if (pendN >= PEND) {
      // Twenty snapshots a second and a frame every 16 ms: a queue this deep
      // means the tab was frozen. Keep the newest; old ones would only be
      // drawn in the past anyway.
      for (let i = 1; i < PEND; i++) { pend[i - 1].buf = pend[i].buf; pend[i - 1].recv = pend[i].recv; }
      pendN = PEND - 1;
    }
    pend[pendN].buf = buf;
    pend[pendN].recv = nowMs;
    pendN++;
    return true;
  }

  /** Insert one decoded record into its car's timeline, in time order. */
  function insert(c, rec, ts) {
    const s = c._s;
    let n = c._n;
    // Where it goes, from the newest end: nearly always it IS the newest.
    let k = n;
    while (k > 0 && s[k - 1].t > ts) k--;
    if (k > 0 && Math.abs(s[k - 1].t - ts) < 0.5) return false;       // a duplicate
    if (k < n && Math.abs(s[k].t - ts) < 0.5) return false;
    if (n === RING) {
      if (k === 0) return false;           // older than everything kept
      const spare = s[0];
      for (let i = 1; i < k; i++) s[i - 1] = s[i];
      k--;
      s[k] = spare;
      n--;
    } else {
      const spare = s[n];
      for (let i = n; i > k; i--) s[i] = s[i - 1];
      s[k] = spare;
    }
    const o = s[k];
    o.t = ts;
    o.x = rec.x; o.y = rec.y; o.z = rec.z; o.yaw = rec.yaw;
    o.pitch = rec.pitch; o.roll = rec.roll;
    o.vx = rec.vx; o.vz = rec.vz; o.yawRate = rec.yawRate;
    o.steer = rec.steer; o.flags = rec.flags; o.respawnSeq = rec.respawnSeq;
    o.hOff = heightAt ? rec.y - heightAt(rec.x, rec.z) : 0;
    c._n = n + 1;
    if (k === c._n - 1 && k > 0) rebase(c, s[k - 1], o, k);
    return true;
  }

  /**
   * The newest sample is somewhere its velocities cannot account for — a
   * collision on the sender's screen shoved the car sideways, or it clipped a
   * kerb and was put back on the road. Under SNAP_DIST that is not a cut, but
   * interpolated straight through it the whole shove happens inside one 50 ms
   * segment: a lurch. Instead the car's older samples are moved by the same
   * amount, so its history agrees with where it is now. That moves the pose
   * being drawn, which update() sees as a correction and hands to the spring:
   * the shove plays out over a few tenths of a second instead of one frame.
   */
  function rebase(c, a, b, k) {
    if ((b.flags & F_TELEPORT) || b.respawnSeq !== a.respawnSeq) return;
    const h = (b.t - a.t) / 1000;
    const dx = b.x - (a.x + (a.vx + b.vx) * 0.5 * h);
    const dz = b.z - (a.z + (a.vz + b.vz) * 0.5 * h);
    const d = Math.hypot(dx, dz);
    if (d <= REBASE || d > SNAP_DIST) return;
    const s = c._s;
    for (let i = 0; i < k; i++) {
      if (s[i].respawnSeq !== b.respawnSeq) continue;
      s[i].x += dx; s[i].z += dz;
    }
    stats.rebases++;
  }

  function sameAsTop(c, rec) {
    if (!c._n) return false;
    const o = c._s[c._n - 1];
    return o.x === rec.x && o.z === rec.z && o.yaw === rec.yaw && o.vx === rec.vx &&
      o.vz === rec.vz && o.flags === rec.flags && o.respawnSeq === rec.respawnSeq;
  }

  function drain() {
    for (let p = 0; p < pendN; p++) {
      const buf = pend[p].buf, recv = pend[p].recv;
      pend[p].buf = null;
      const n = decodeSnapshot(buf, pool);
      if (n < 0) continue;
      const snapT = snapshotTime(buf);
      const seq = ++snapSeq;
      for (let i = 0; i < n; i++) {
        const rec = pool[i];
        if (rec.id === selfId) continue;
        const c = slotFor(rec.id);
        if (!c || c.leaving) continue;
        c._heard = recv;
        c.lastSeen = recv;
        if (c._mark !== seq) { c._mark = seq; c._prevTop = c._n ? c._s[c._n - 1].t : NaN; }
        let ts;
        if (stamped) {
          // AGE_STALE: this car has sent nothing for a quarter of a second.
          // It is still here — that is all this record says.
          if (rec.age >= AGE_STALE) continue;
          ts = snapT - rec.age;
        } else {
          // A generation-1 server repeats the last record every tick until a
          // new one arrives. A repeat is presence, not a sample at a new time.
          if (sameAsTop(c, rec)) continue;
          ts = snapT;
        }
        insert(c, rec, ts);
      }
      // One observation per car per arrival, against the newest sample the
      // car had before this snapshot landed.
      //
      // Not a dropout, though. When a stalled link lets go, a second of
      // snapshots lands at once and each one reads as a need of up to that
      // second: two dozen of the 96 slots, which pinned the delay at D_MAX —
      // every friend drawn 450 ms late — for the five seconds it took them to
      // age out. No buffer bridges a WiFi dropout (that is what the cut in
      // isCut() is for), so a need past D_MAX says nothing about the jitter
      // the buffer is there to absorb.
      const arrival = recv + offset;
      for (const c of cars) {
        if (!c.active || c._mark !== seq || !(c._prevTop === c._prevTop) || !c._n) continue;
        if (c._s[c._n - 1].t <= c._prevTop) continue;
        if (arrival - c._prevTop > D_MAX) continue;
        needs[needHead] = arrival - c._prevTop;
        needHead = (needHead + 1) % NEEDS;
        if (needN < NEEDS) needN++;
      }
    }
    pendN = 0;
  }

  // ---- sampling a car's timeline ----------------------------------------

  /**
   * A cut between two samples: a respawn, a teleport, a jump no velocity
   * explains — or a hole in the feed. Two samples 2.7 s apart after a WiFi
   * dropout are not two ends of one curve: a Hermite through them invents
   * 2.7 s of driving the car never did, and since the car is drawn frozen at
   * the end of its extrapolation while it waits, the drawn car then jumps onto
   * that invented curve. Across a gap the car holds where the extrapolation
   * left it and makes ONE clean cut to the fresh samples. At 20 Hz a gap is
   * normally 50 ms; 400 ms is eight lost sends in a row.
   */
  function isCut(a, b) {
    if ((b.flags & F_TELEPORT) || b.respawnSeq !== a.respawnSeq) return true;
    if (b.t - a.t > GAP_CUT) return true;
    const h = (b.t - a.t) / 1000;
    const px = a.x + (a.vx + b.vx) * 0.5 * h, pz = a.z + (a.vz + b.vz) * 0.5 * h;
    return Math.hypot(b.x - px, b.z - pz) > SNAP_DIST;
  }

  function copyStatic(o, s) {
    o.pitch = s.pitch; o.roll = s.roll; o.steer = s.steer;
    o.flags = s.flags; o.respawnSeq = s.respawnSeq;
  }

  function groundY(x, z, hOff, fallback, air) {
    return heightAt && !air ? heightAt(x, z) + hOff : fallback;
  }

  /** Extrapolated seconds: full speed for EXTRAP_LIN ms, then eased to a
   *  stop, so running dry never stops the car dead in one frame. */
  function extrapT(ms) {
    if (ms <= EXTRAP_LIN) return ms / 1000;
    const k = (ms - EXTRAP_LIN) / EXTRAP_SOFT;
    return (EXTRAP_LIN + EXTRAP_SOFT * (1 - Math.exp(-k))) / 1000;
  }
  /** d(extrapT)/dt: how fast the extrapolated car is still moving, 1 to 0. */
  function extrapRate(ms) {
    return ms <= EXTRAP_LIN ? 1 : Math.exp(-(ms - EXTRAP_LIN) / EXTRAP_SOFT);
  }

  /**
   * The car's pose at time T (server ms). kind: 1 interpolated, 2 extrapolated,
   * 3 held at the first sample. o.ok false when the car has no samples.
   * o.vx/o.vz are the velocity OF THE CURVE being drawn (its derivative), not
   * the samples' — they differ while extrapolation is easing off, and a
   * correction has to hand the difference to the spring or the drawn car's
   * speed jumps even though its position does not.
   */
  function poseAt(c, T, o) {
    const s = c._s, n = c._n;
    o.ok = n > 0;
    if (!n) return o;
    let k = n - 1;
    while (k >= 0 && s[k].t > T) k--;
    if (k < 0) {
      const a = s[0];
      o.kind = 3;
      o.x = a.x; o.z = a.z; o.yaw = a.yaw; o.vx = 0; o.vz = 0;
      o.y = groundY(a.x, a.z, a.hOff, a.y, a.flags & F_AIR);
      copyStatic(o, a);
      return o;
    }
    const a = s[k];
    if (k < n - 1 && !isCut(a, s[k + 1])) {
      const b = s[k + 1];
      const span = b.t - a.t;
      const u = span > 0 ? (T - a.t) / span : 1;
      const h = span / 1000;
      // Hermite through both positions with both velocities as tangents,
      // tamed where they disagree with the chord (a wall, a spin): a tangent
      // pointing back along it loses that component, and tangents far longer
      // than it are scaled down (Fritsch-Carlson), so the curve can never
      // loop or run backwards between two samples.
      const cx = b.x - a.x, cz = b.z - a.z;
      const L2 = cx * cx + cz * cz;
      let m0x = a.vx * h, m0z = a.vz * h, m1x = b.vx * h, m1z = b.vz * h;
      if (L2 > 1e-4) {
        let al = (m0x * cx + m0z * cz) / L2, be = (m1x * cx + m1z * cz) / L2;
        if (al < 0) { m0x -= al * cx; m0z -= al * cz; al = 0; }
        if (be < 0) { m1x -= be * cx; m1z -= be * cz; be = 0; }
        const r = al * al + be * be;
        if (r > 9) { const q = 3 / Math.sqrt(r); m0x *= q; m0z *= q; m1x *= q; m1z *= q; }
      } else { m0x = m0z = m1x = m1z = 0; }
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = 3 * u2 - 2 * u3, h11 = u3 - u2;
      o.x = h00 * a.x + h10 * m0x + h01 * b.x + h11 * m1x;
      o.z = h00 * a.z + h10 * m0z + h01 * b.z + h11 * m1z;
      if (h > 1e-6) {
        const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = 6 * u - 6 * u2, d11 = 3 * u2 - 2 * u;
        o.vx = (d00 * a.x + d10 * m0x + d01 * b.x + d11 * m1x) / h;
        o.vz = (d00 * a.z + d10 * m0z + d01 * b.z + d11 * m1z) / h;
      } else { o.vx = b.vx; o.vz = b.vz; }
      const dy = angDelta(a.yaw, b.yaw);
      let w0 = a.yawRate * h, w1 = b.yawRate * h;
      if (Math.abs(w0) > Math.abs(dy) * 3 + 0.05) w0 = dy;
      if (Math.abs(w1) > Math.abs(dy) * 3 + 0.05) w1 = dy;
      o.yaw = a.yaw + h10 * w0 + h01 * dy + h11 * w1;
      const air = (a.flags | b.flags) & F_AIR;
      o.y = heightAt && !air
        ? heightAt(o.x, o.z) + lerp(a.hOff, b.hOff, u)
        : lerp(a.y, b.y, u);
      o.pitch = lerp(a.pitch, b.pitch, u);
      o.roll = lerp(a.roll, b.roll, u);
      o.steer = lerp(a.steer, b.steer, u);
      o.flags = a.flags; o.respawnSeq = a.respawnSeq;
      o.kind = 1;
      return o;
    }
    // Past the newest sample (or up to a cut): carry on along a constant-turn
    // arc. A car mid-corner keeps cornering; a straight-line guess visibly
    // cuts the apex and then has to be corrected back out of it.
    //
    // With the velocity's heading r (vx = s sin r, vz = s cos r) turning at w:
    // x' = s sin(r0 + wt) integrates to -s/w (cos(r0 + wt) - cos r0), and z'
    // to s/w (sin(r0 + wt) - sin r0). The version this replaced had sin and
    // cos the other way round — for any turning car it moved x by vz*t and z
    // by vx*t, throwing the guess sideways. It was hidden behind the old
    // interpolator's own noise; the netcheck harness found it at once.
    const late = Math.max(0, T - a.t);
    const te = extrapT(late), rate = extrapRate(late);
    const w = a.yawRate;
    if (Math.abs(w) > 1e-3) {
      const r0 = Math.atan2(a.vx, a.vz);
      const sp = Math.hypot(a.vx, a.vz);
      o.x = a.x - (Math.cos(r0 + w * te) - Math.cos(r0)) * sp / w;
      o.z = a.z + (Math.sin(r0 + w * te) - Math.sin(r0)) * sp / w;
      o.vx = Math.sin(r0 + w * te) * sp * rate;
      o.vz = Math.cos(r0 + w * te) * sp * rate;
    } else {
      o.x = a.x + a.vx * te;
      o.z = a.z + a.vz * te;
      o.vx = a.vx * rate; o.vz = a.vz * rate;
    }
    o.yaw = a.yaw + w * te;
    // Height is not extrapolated off the ground — guessing vertical motion
    // tilts cars into the road, which is far more obvious than 20 cm behind.
    o.y = groundY(o.x, o.z, a.hOff, a.y, a.flags & F_AIR);
    copyStatic(o, a);
    o.kind = 2;
    return o;
  }

  // ---- the frame -----------------------------------------------------------

  function quantile(src, n, q, tmp) {
    for (let i = 0; i < n; i++) {
      const v = src[i];
      let j = i - 1;
      while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; }
      tmp[j + 1] = v;
    }
    return tmp[Math.min(n - 1, Math.floor(q * n))];
  }

  function retarget(nowMs) {
    if (nowMs - delayAt < 250) return;
    delayAt = nowMs;
    if (needN < 8) { delay = fallbackDelay; return; }
    const q = quantile(needs, needN, NEED_Q, sortA);
    delay = Math.max(D_MIN, Math.min(D_MAX, q + MARGIN));
  }

  /** Critically damped spring on each error component, solved exactly, so it
   *  is stable at any frame time and never overshoots. */
  function spring(c, dt) {
    const k = Math.exp(-OMEGA * dt);
    let e = c._ex, v = c._vx;
    c._ex = (e + (v + OMEGA * e) * dt) * k; c._vx = (v - OMEGA * (v + OMEGA * e) * dt) * k;
    e = c._ez; v = c._vz;
    c._ez = (e + (v + OMEGA * e) * dt) * k; c._vz = (v - OMEGA * (v + OMEGA * e) * dt) * k;
    e = c._ey; v = c._vy;
    c._ey = (e + (v + OMEGA * e) * dt) * k; c._vy = (v - OMEGA * (v + OMEGA * e) * dt) * k;
    e = c._eyaw; v = c._vyaw;
    c._eyaw = (e + (v + OMEGA * e) * dt) * k; c._vyaw = (v - OMEGA * (v + OMEGA * e) * dt) * k;
  }

  function zeroErr(c) {
    c._ex = c._ey = c._ez = c._eyaw = 0;
    c._vx = c._vy = c._vz = c._vyaw = 0;
  }

  /**
   * Advance every remote car to the playback clock. Called once per rendered
   * frame, NOT per physics step — these are visual only.
   */
  function update(nowMs, dt) {
    if (offset === null) { fadeAll(dt); return; }
    retarget(nowMs);
    // The playback clock never jumps (short of a CLOCK_SNAP disaster): it runs
    // a little slow or a little fast until it sits `delay` behind the server.
    // A change of delay or a better clock estimate therefore shows up as a car
    // that is briefly a few percent slower, never as a car that skips.
    //
    // PROPORTIONAL, not bang-bang. The first version closed each frame's whole
    // error at once (clamped to the same -12%/+4%), so a target wobbling by a
    // millisecond either side flipped the playback rate between 0.88 and 1.04
    // frame to frame — a car at 100 km/h gaining and losing 4 m/s sixty times
    // a second. Measured on the LAN profile: 111 m/s² of per-frame
    // acceleration at the 99th percentile, from a car that never pulls 11.
    const target = nowMs + offset - delay;
    if (!playOk) { play = target; playOk = true; } else {
      const e = target - (play + dt * 1000);
      if (Math.abs(e) > CLOCK_SNAP) play = target;
      else play += dt * 1000 * (1 + Math.max(-SLOW, Math.min(FAST, e / CLOCK_TAU)));
    }
    const T = play;

    // Where every car would be drawn from what we had, then fold in the new.
    for (const c of cars) {
      c._had = false;
      if (!c.active || !c._n) continue;
      poseAt(c, T, before);
      c._bx = before.x; c._by = before.y; c._bz = before.z; c._byaw = before.yaw;
      c._bvx = before.vx; c._bvz = before.vz;
      c._bseq = before.respawnSeq;
      c._had = true;
    }
    if (pendN) drain();

    stats.frames++;
    for (const c of cars) {
      if (!c.active) continue;
      if (c._n) {
        poseAt(c, T, after);
        if (after.kind === 2 && T - c._s[c._n - 1].t > 1) stats.extrap++;
        // The error there already was ages by this frame FIRST; only then is
        // any new one added. The other way round, a correction that has just
        // arrived is aged by a frame it never lived through and the drawn car
        // lurches by (its velocity x one frame).
        spring(c, dt);
        if (c._had) {
          const dx = c._bx - after.x, dz = c._bz - after.z;
          if (dx !== 0 || dz !== 0 || c._byaw !== after.yaw) {
            const d = Math.hypot(dx, dz);
            if (d > SNAP_DIST || c._bseq !== after.respawnSeq) {
              zeroErr(c);
              stats.cuts++;
            } else {
              // New data moved where the car belongs right now. Keep drawing it
              // where it WAS, moving as it WAS, and let the spring close the gap.
              c._ex += dx; c._ez += dz; c._ey += c._by - after.y;
              c._vx += c._bvx - after.vx; c._vz += c._bvz - after.vz;
              c._eyaw += angDelta(after.yaw, c._byaw);
              if (d > 1e-4) stats.corrections++;
              if (d > stats.maxCorr) stats.maxCorr = d;
              if (Math.hypot(c._ex, c._ez) > SNAP_DIST) zeroErr(c);
            }
          }
        }
        c.x = after.x + c._ex;
        c.z = after.z + c._ez;
        c.y = after.y + c._ey;
        c.yaw = after.yaw + c._eyaw;
        c.pitch = after.pitch; c.roll = after.roll;
        c.vx = after.vx; c.vz = after.vz;
        c.steer = after.steer;
        c.flags = after.flags;
        c.respawnSeq = after.respawnSeq;
        c.brake = !!(after.flags & F_BRAKE);
        c.indL = !!(after.flags & F_INDL);
        c.indR = !!(after.flags & F_INDR);
        c.lights = !!(after.flags & F_LIGHTS);
        c.airborne = !!(after.flags & F_AIR);
        // Forward speed, signed: what the wheels should be turning at.
        c.speed = -(after.vx * Math.sin(c.yaw) + after.vz * Math.cos(c.yaw));
      }
      // Presence. A car that stops being heard fades out rather than
      // blinking away mid-frame — vanishing instantly reads as a crash.
      const gone = c.leaving || nowMs - c._heard > PRESENCE_MS;
      if (gone) {
        c.fade = Math.max(0, c.fade - dt / 0.4);
        if (c.fade <= 0) release(c);
      } else if (c._n) {
        c.fade = Math.min(1, c.fade + dt / 0.25);
      }
    }
  }

  function fadeAll(dt) {
    for (const c of cars) {
      if (!c.active) continue;
      c.fade = Math.max(0, c.fade - dt / 0.4);
      if (c.fade <= 0) release(c);
    }
  }

  function onPong(clientMs, serverMs, nowMs) {
    const rtt = nowMs - clientMs;
    if (!(rtt >= 0) || rtt > 3000) return;
    rttMs = rttMs ? rttMs * 0.8 + rtt * 0.2 : rtt;
    // Server time at the instant the server stamped it, assuming a symmetric path.
    pingRtt[pingHead] = rtt;
    pingOff[pingHead] = serverMs + rtt * 0.5 - nowMs;
    pingHead = (pingHead + 1) % 16;
    if (pingN < 16) pingN++;
    if (pingN < 3) return;
    // The lowest-RTT half, by a tiny insertion sort of indices ...
    const idx = sortB;
    for (let i = 0; i < pingN; i++) {
      let j = i - 1;
      while (j >= 0 && pingRtt[idx[j]] > pingRtt[i]) { idx[j + 1] = idx[j]; j--; }
      idx[j + 1] = i;
    }
    const half = Math.max(3, pingN >> 1);
    // ... and the median offset among them.
    for (let i = 0; i < half; i++) {
      const v = pingOff[idx[i]];
      let j = i - 1;
      while (j >= 0 && sortA[j] > v) { sortA[j + 1] = sortA[j]; j--; }
      sortA[j + 1] = v;
    }
    offset = sortA[half >> 1];
  }

  return {
    get cars() { return cars; },
    get count() { return byId.size; },
    get rtt() { return rttMs; },
    /** The current jitter-buffer delay, ms behind the server clock. */
    get interp() { return delay; },
    get offset() { return offset; },
    get stats() { return stats; },
    /** The server's clock as best this client knows it (null until known). */
    serverNow(nowMs) { return offset === null ? null : nowMs + offset; },
    car(id) { return byId.get(id) || null; },
    setSelf(id) { selfId = id; },
    /** True once the server has said its records carry their age. */
    setStamped(on) { stamped = !!on; },
    setName(id, name) {
      names.set(id, name);
      const c = byId.get(id);
      if (c) c.name = name;
    },
    /** A player's car and paint, from welcome/joined. */
    setInfo(id, car, colour) {
      const cid = car || '', col = colour | 0;
      infos.set(id, { car: cid, colour: col });
      const c = byId.get(id);
      if (c && (c.carId !== cid || c.colour !== col)) { c.carId = cid; c.colour = col; c.infoRev++; }
    },
    /** They left: fade the car now rather than waiting to stop hearing it. */
    dropName(id) {
      names.delete(id);
      infos.delete(id);
      const c = byId.get(id);
      if (c) c.leaving = true;
    },
    /** The fallback delay, before any jitter has been measured. */
    setSendHz(hz) {
      fallbackDelay = Math.max(80, Math.min(250, 2000 / Math.max(4, hz)));
      if (needN < 8) delay = fallbackDelay;
    },
    onSnapshot, onPong, update,
    reset() {
      pendN = 0;
      for (const p of pend) p.buf = null;
      pingN = 0; pingHead = 0; needN = 0; needHead = 0;
      offset = null; rttMs = 0; playOk = false; delay = fallbackDelay; delayAt = -Infinity;
      stamped = false;
      for (const c of cars) { c.active = false; c.fade = 0; c.name = ''; c._n = 0; }
      byId.clear();
      names.clear();
      infos.clear();
    },
  };
}
