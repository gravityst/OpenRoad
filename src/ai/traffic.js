// The other cars.
//
// Traffic here is KINEMATIC. Nothing in this file calls createVehicle: sixty
// full vehicle models, each with four wheels doing ground queries and a tyre
// solve, is a physics budget the player's own car has better uses for. A
// traffic car is a station on a lane, a speed, and a steering controller —
// which is enough, because what has to be convincing at forty metres is where
// a car is and how it behaves, not what its contact patches are doing.
//
// THREE THINGS DECIDE WHETHER THIS READS AS TRAFFIC
//
//  * Which side of the road they are on. Oncoming cars in your lane is the
//    most noticeable failure there is, so the lane offset is derived once from
//    the project's own convention and used everywhere:
//        forward = -Z, right = +X   =>   right(t) = (-tz, tx)
//    Every car drives at +width/4 along right(direction of travel). Every one.
//  * That they brake BEFORE a corner rather than in it. The speed plan walks
//    up to ~90 m forward along the real route polyline, finds the tightest
//    curvature and the lowest speed limit in there, and works backwards.
//  * That they notice the player. Traffic that drives through you is worse
//    than no traffic, so the player is an obstacle in the same car-following
//    law as everything else, with a wider margin and a longer time gap.
//
// WHY PURE PURSUIT AND NOT SNAPPING TO THE LANE
//
// Placing each car exactly on its lane polyline looks fine on a straight and
// falls apart at every junction: the lane point of the road you are leaving
// and the lane point of the road you are joining are different places, up to
// half a carriageway apart, so a snapped car jumps sideways at every
// intersection and pivots on the spot. Instead the car integrates its own
// heading and chases a point ~15 m ahead on the lane. The discontinuity
// becomes a corner, cars cut the apex slightly the way real ones do, and
// lateral error is self-correcting rather than accumulating.

import { clamp, lerp, mulberry } from '../world/noise.js';
import { CARS, specFor } from '../vehicles/catalog.js';

const TAU = Math.PI * 2;

// How attractive a road is to turn onto. Traffic prefers arterials, which is
// what keeps the ring highway busy and the dirt tracks empty without having to
// model destinations.
const RANK = {
  highway: 3.4, avenue: 2.2, link: 2.0, street: 1.0, rural: 1.5, dirt: 0.35, track: 0.2,
};

// Which classes turn up on the road, and how often. A city where every third
// car is a supercar is a car park, not a city.
const CLASS_MIX = { city: 0.30, utility: 0.25, luxury: 0.18, sport: 0.13, offroad: 0.11, super: 0.03 };

const A_LAT = 3.2;        // m/s^2 of lateral acceleration a traffic driver will accept
const B_COMF = 2.8;       // m/s^2 they will plan to brake at for something they can see
const B_MAX = 7.5;        // m/s^2 they will actually use when surprised
const GAP_MIN = 2.6;      // m of standstill gap, bumper to bumper
const SIGNAL_PERIOD = 13; // s per phase at a signalled junction
const SCAN_R = 36;        // m of forward interest in other cars

export function createTraffic(world, ground, opts = {}) {
  const rnd = mulberry(opts.seed ?? ((world.seed ^ 0x7a11c5) >>> 0));

  const density = opts.density ?? 34;
  const radius = opts.radius ?? 350;         // the band we try to keep populated
  const despawnR = opts.despawnRadius ?? radius * 1.45;
  const maxCars = Math.max(1, opts.maxCars ?? Math.ceil(density * 1.6));

  const nodes = world.nodes;
  const edges = world.edges;

  // =========================================================================
  // Scratch. Everything below runs 60 times a frame; nothing in it allocates.
  // =========================================================================
  const _pt = { x: 0, z: 0, y: 0, tx: 0, tz: 0, grade: 0 };
  const _tgt = { x: 0, z: 0, y: 0, tx: 0, tz: 0, grade: 0 };
  const _sta = { x: 0, z: 0, y: 0, tx: 0, tz: 0, grade: 0 };
  const _h1 = { tx: 0, tz: 0 };
  const _h2 = { tx: 0, tz: 0 };
  const _pick = { ei: 0, dir: 1 };
  const MAX_DEGREE = 16;
  const candW = new Float64Array(MAX_DEGREE);
  const candE = new Int32Array(MAX_DEGREE);
  const candD = new Int8Array(MAX_DEGREE);

  // =========================================================================
  // Edge geometry
  // =========================================================================

  /**
   * Position, height, unit travel tangent and road grade at native arc length
   * `sNative` on `e`, travelling in `dir`. `s` on a polyline vertex is planar
   * arc length, so (b - a) / (b.s - a.s) is already unit length in XZ.
   */
  function sampleEdge(e, sNative, dir, out) {
    const pts = e.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].s <= sNative) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[lo + 1];
    const seg = b.s - a.s > 1e-4 ? b.s - a.s : 1e-4;
    const t = clamp((sNative - a.s) / seg, 0, 1);
    const inv = 1 / seg;
    const tx = (b.x - a.x) * inv, tz = (b.z - a.z) * inv;
    const gr = (b.y - a.y) * inv;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.tx = dir > 0 ? tx : -tx;
    out.tz = dir > 0 ? tz : -tz;
    out.grade = dir > 0 ? gr : -gr;
    return out;
  }

  /** The right-hand lane point `d` metres of travel into `slot`. */
  function laneAt(slot, d, out) {
    const dc = d < 0 ? 0 : d > slot.len ? slot.len : d;
    sampleEdge(slot.e, slot.dir > 0 ? dc : slot.len - dc, slot.dir, out);
    // right(t) = (-tz, tx). Positive offset = right-hand side of the carriageway.
    out.x -= out.tz * slot.laneOff;
    out.z += out.tx * slot.laneOff;
    return out;
  }

  /** Unit travel tangent where a slot's edge meets its start or end node. */
  function endTangent(e, dir, atEnd, out) {
    const pts = e.pts, n = pts.length - 1;
    let a, b;
    if (dir > 0) {
      if (atEnd) { a = pts[n - 1]; b = pts[n]; } else { a = pts[0]; b = pts[1]; }
    } else if (atEnd) { a = pts[1]; b = pts[0]; } else { a = pts[n]; b = pts[n - 1]; }
    const dx = b.x - a.x, dz = b.z - a.z;
    const inv = 1 / Math.max(1e-6, Math.sqrt(dx * dx + dz * dz));
    out.tx = dx * inv; out.tz = dz * inv;
    return out;
  }

  // =========================================================================
  // Route: a rolling window of four edges
  // =========================================================================
  // Four is enough that the 90 m speed lookahead always has road under it even
  // where resolveCrossings has chopped an avenue into short pieces, and small
  // enough that refilling it costs one choice per junction.

  function makeSlot() {
    return { e: null, dir: 1, len: 1, laneOff: 0, speed: 10, endNode: 0, turnAtEnd: 0 };
  }

  function setSlot(slot, e, dir) {
    slot.e = e;
    slot.dir = dir;
    slot.len = Math.max(1, e.length);
    slot.laneOff = e.width * 0.25;
    slot.speed = e.speed;
    slot.endNode = dir > 0 ? e.b : e.a;
    slot.turnAtEnd = 0;
  }

  /**
   * Picks the road to take out of `node`, weighted toward carrying straight on
   * and toward bigger roads. A driver who turns at random makes the city feel
   * like a maze of one-block trips; one who never turns never leaves the ring.
   */
  function chooseNext(node, fromEdge, hx, hz) {
    const list = node.edges;
    let n = 0, total = 0;
    for (let k = 0; k < list.length && n < MAX_DEGREE; k++) {
      const e = edges[list[k]];
      const dir = e.a === node.i ? 1 : e.b === node.i ? -1 : 0;
      if (!dir) continue;
      endTangent(e, dir, false, _h2);
      const dot = _h2.tx * hx + _h2.tz * hz;
      const straight = 0.5 + 0.5 * dot;
      let w = (RANK[e.kind] ?? 1) * (0.05 + straight * straight * 1.7);
      if (e === fromEdge) w *= 0.015;      // a U-turn is a last resort, not a choice
      if (e.length < 6) w *= 0.4;          // crossing stubs are not destinations
      candW[n] = w; candE[n] = e.i; candD[n] = dir; total += w; n++;
    }
    if (!n) {                              // isolated node: turn round and go back
      _pick.ei = fromEdge.i;
      _pick.dir = fromEdge.a === node.i ? 1 : -1;
      return _pick;
    }
    let r = rnd() * total, sel = n - 1;
    for (let i = 0; i < n; i++) { r -= candW[i]; if (r <= 0) { sel = i; break; } }
    _pick.ei = candE[sel]; _pick.dir = candD[sel];
    return _pick;
  }

  /** Fills `slot` with the road taken after `prev`, and records prev's turn. */
  function fillSlot(slot, prev) {
    const node = nodes[prev.endNode];
    endTangent(prev.e, prev.dir, true, _h1);          // heading arriving at the node
    const p = chooseNext(node, prev.e, _h1.tx, _h1.tz);
    setSlot(slot, edges[p.ei], p.dir);
    endTangent(slot.e, slot.dir, false, _h2);         // heading leaving it
    // Signed turn, positive = right, because right(f) = (-fz, fx) here.
    prev.turnAtEnd = Math.atan2(
      _h2.tx * -_h1.tz + _h2.tz * _h1.tx,
      _h2.tx * _h1.tx + _h2.tz * _h1.tz,
    );
  }

  /** The lane point `ahead` metres in front of the car along its route. */
  function routeAt(car, ahead, out) {
    const r = car.route;
    let d = car.s + ahead, i = 0;
    while (i < 3 && d > r[i].len) { d -= r[i].len; i++; }
    laneAt(r[i], d, out);
    return r[i];
  }

  // =========================================================================
  // Junction priority
  // =========================================================================
  // Signalled junctions run on a clock, which is cheap and gives the city a
  // rhythm. Unsignalled ones are settled by a claim: the biggest road closest
  // to the node takes the junction and everyone else waits for it. Both are
  // deliberately coarse — the point is that cars stop for each other at all,
  // not that the rules of the road are simulated.

  const claimOwner = new Int32Array(nodes.length).fill(-1);
  const claimAge = new Float32Array(nodes.length);
  const bidNode = new Int32Array(maxCars);
  const bidCar = new Int32Array(maxCars);
  const bidScore = new Float32Array(maxCars);
  let bidCount = 0;

  function releaseClaim(car) {
    if (car.holdNode >= 0) {
      if (claimOwner[car.holdNode] === car.id) claimOwner[car.holdNode] = -1;
      car.holdNode = -1;
    }
    car.holdDist = 0;
  }

  /** Green for this approach? Amber counts as red if you cannot make the line. */
  function signalGreen(node, dNode, speed, tx, tz) {
    const t = time / SIGNAL_PERIOD + node.i * 0.37;
    const phase = Math.floor(t) & 1;
    const axis = Math.abs(tx) > Math.abs(tz) ? 1 : 0;
    if (axis !== phase) return false;
    const remain = (1 - (t - Math.floor(t))) * SIGNAL_PERIOD;
    return !(remain < 2.2 && dNode > speed * remain + 3);
  }

  // =========================================================================
  // Where to put a new car
  // =========================================================================
  // Edges bucketed on a coarse grid so a spawn can ask "what road is near this
  // point" without walking all 900 of them. Built once; the road network never
  // changes shape.

  const SCELL = 192;
  const spawnCells = new Map();
  const skey = (cx, cz) => cx * 100003 + cz;
  {
    const build = new Map();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.length < 18) continue;         // too short to be born on
      let last = -1;
      for (let k = 0; k < e.pts.length; k++) {
        const p = e.pts[k];
        const kk = skey(Math.floor(p.x / SCELL), Math.floor(p.z / SCELL));
        if (kk === last) continue;
        last = kk;
        let L = build.get(kk);
        if (!L) build.set(kk, (L = []));
        if (L[L.length - 1] !== i) L.push(i);
      }
    }
    for (const [k, L] of build) spawnCells.set(k, Int32Array.from(L));
  }

  // =========================================================================
  // The pool
  // =========================================================================
  // Slots are permanent and each one keeps the same model and paint for the
  // whole session, so the renderer can build one car mesh per slot at startup
  // and never rebuild it. Recycling a slot only moves it; `respawnId` ticks so
  // main.js can drop any interpolation it was carrying.

  // Share each class's weight between the models in it, or the classes with two
  // entries quietly end up twice as common as the ones with one.
  const perClass = {};
  for (let i = 0; i < CARS.length; i++) perClass[CARS[i].class] = (perClass[CARS[i].class] || 0) + 1;
  const mix = [];
  for (let i = 0; i < CARS.length; i++) {
    const w = Math.max(1, Math.round(((CLASS_MIX[CARS[i].class] ?? 0.1) / perClass[CARS[i].class]) * 200));
    for (let k = 0; k < w; k++) mix.push(i);
  }

  const cars = [];
  for (let i = 0; i < maxCars; i++) {
    const proto = CARS[mix[(rnd() * mix.length) | 0]];
    const spec = specFor(proto.id, (rnd() * proto.colours.length) | 0);
    const wheelbase = spec.wheelbase ?? 2.7;
    cars.push({
      id: i,
      active: false,
      respawnId: 0,

      // --- what the renderer reads ---
      x: 0, y: 0, z: 0,
      yaw: 0, pitch: 0, roll: 0,
      speed: 0,
      spec,
      body: spec.body,
      colour: spec.colour,
      braking: false,
      indicator: 0,                        // -1 left, 0 off, +1 right
      wheelSpin: 0,
      steerAngle: 0,

      // --- geometry used by the following law ---
      wheelbase,
      wheelRadius: spec.wheelRadius ?? 0.34,
      rideHeight: spec.rideHeight ?? 0.28,
      halfLen: (wheelbase * 1.55 + 0.5) * 0.5,

      // --- driver personality ---
      eager: 0.84 + rnd() * 0.28,          // fraction of the limit they aim for
      accel: 1.5 + rnd() * 1.5,            // m/s^2 they pull away at
      timeGap: 1.05 + rnd() * 0.85,        // s of headway they keep

      // --- route ---
      route: [makeSlot(), makeSlot(), makeSlot(), makeSlot()],
      s: 0,                                // travel arc length into route[0]
      kappa: 0,                            // current path curvature, rate limited
      fx: 0, fz: -1,

      // --- bookkeeping ---
      holdNode: -1,
      holdDist: 0,
      indHold: 0,
      stuck: 0,
    });
  }

  let active = 0;
  let time = 0;

  function despawn(car) {
    if (!car.active) return;
    releaseClaim(car);
    car.active = false;
    car.speed = 0;
    car.indicator = 0;
    car.braking = false;
    for (let i = 0; i < 4; i++) car.route[i].e = null;
    active--;
  }

  /** Places `car` at travel station `s` on `e`, already up to speed. */
  function place(car, e, dir, s) {
    setSlot(car.route[0], e, dir);
    for (let i = 1; i < 4; i++) fillSlot(car.route[i], car.route[i - 1]);
    car.s = clamp(s, 0, car.route[0].len);
    laneAt(car.route[0], car.s, _pt);
    car.x = _pt.x; car.z = _pt.z;
    // A car model is built facing -Z, and forward = (-sin yaw, -cos yaw), so
    // the yaw that faces (tx, tz) is atan2(-tx, -tz).
    car.yaw = Math.atan2(-_pt.tx, -_pt.tz);
    car.fx = _pt.tx; car.fz = _pt.tz;
    car.pitch = Math.atan(_pt.grade);
    car.roll = 0;
    car.y = ground.heightAt(car.x, car.z) + car.rideHeight;
    car.speed = Math.min(e.speed * car.eager, e.speed * 0.9);
    car.kappa = 0;
    car.steerAngle = 0;
    car.indicator = 0;
    car.indHold = 0;
    car.braking = false;
    car.holdNode = -1;
    car.holdDist = 0;
    car.stuck = 0;
    car.active = true;
    car.respawnId++;
    active++;
  }

  const probe = makeSlot();

  /**
   * One spawn attempt in the ring around the player. Pop-in is far more
   * noticeable ahead than behind, so the forward half of the ring is pushed out
   * to where a car arriving is a few pixels; the whole ring stays inside
   * `radius` so every successful spawn counts toward the target density.
   */
  function trySpawn(px, pz, phx, phz) {
    const ang = rnd() * TAU;
    const ax = Math.sin(ang), az = -Math.cos(ang);
    const ahead = ax * phx + az * phz;                      // -1 behind, +1 ahead
    const minR = lerp(radius * 0.50, radius * 0.80, ahead * 0.5 + 0.5);
    const r = minR + rnd() * (radius * 0.15);
    const sx = px + ax * r, sz = pz + az * r;

    const list = spawnCells.get(skey(Math.floor(sx / SCELL), Math.floor(sz / SCELL)));
    if (!list || !list.length) return false;
    const e = edges[list[(rnd() * list.length) | 0]];
    if (rnd() > (RANK[e.kind] ?? 1) / 3.4) return false;    // arterials get the traffic

    // Nearest station on that edge to the sample point.
    const pts = e.pts;
    let bs = 0, bd = Infinity;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((sx - a.x) * dx + (sz - a.z) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a.x + dx * t - sx, qz = a.z + dz * t - sz;
      const d = qx * qx + qz * qz;
      if (d < bd) { bd = d; bs = a.s + t * (b.s - a.s); }
    }
    const dir = rnd() < 0.5 ? 1 : -1;
    const travel = dir > 0 ? bs : e.length - bs;
    if (travel < 6 || travel > e.length - 6) return false;

    // Never inside the player's field of view, and never on top of anyone.
    const slot = probe;
    setSlot(slot, e, dir);
    laneAt(slot, travel, _pt);
    const ddx = _pt.x - px, ddz = _pt.z - pz;
    if (ddx * ddx + ddz * ddz < radius * radius * 0.24) return false;
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (!o.active) continue;
      const ox = o.x - _pt.x, oz = o.z - _pt.z;
      if (ox * ox + oz * oz < 576) return false;            // 24 m of elbow room
    }

    for (let i = 0; i < cars.length; i++) {
      if (!cars[i].active) { place(cars[i], e, dir, travel); return true; }
    }
    return false;
  }

  // =========================================================================
  // Driving
  // =========================================================================

  /**
   * The interaction term of an intelligent-driver model. Returns the (negative)
   * acceleration this obstacle demands; the caller keeps the harshest one.
   */
  function follow(car, gap, vLead, s0, T) {
    const v = car.speed;
    const dv = v - vLead;
    const star = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(car.accel * B_COMF)));
    const g = gap > 0.4 ? gap : 0.4;
    const q = star / g;
    return -car.accel * q * q;
  }

  /**
   * Fastest speed the road ahead allows, planned back from the tightest bend
   * and the lowest limit within the lookahead. Braking early for a corner is
   * most of what separates traffic from a conveyor belt.
   */
  function planSpeed(car) {
    const look = clamp(car.speed * 1.9 + 14, 22, 90);
    const n = Math.min(10, Math.max(3, Math.round(look / 9)));
    const step = look / n;

    let v0 = car.route[0].speed * car.eager;
    routeAt(car, 0, _pt);
    let ptx = _pt.tx, ptz = _pt.tz;

    for (let i = 1; i <= n; i++) {
      const d = i * step;
      const slot = routeAt(car, d, _pt);
      const dot = ptx * _pt.tx + ptz * _pt.tz;
      const crs = Math.abs(ptx * _pt.tz - ptz * _pt.tx);
      // |tan dtheta| / step. tan overestimates for a big turn, which is the
      // safe direction to be wrong in; atan2 per sample is not worth its cost.
      const k = dot <= 0.05 ? 0.5 : Math.min(0.5, crs / (dot * step));
      ptx = _pt.tx; ptz = _pt.tz;

      const vCorner = Math.sqrt(A_LAT / Math.max(k, 1e-4));
      const vLimit = slot.speed * car.eager;
      const vHere = vCorner < vLimit ? vCorner : vLimit;
      // Where we must already be at vHere by the time we have travelled d.
      const vAllow = Math.sqrt(vHere * vHere + 2 * B_COMF * d);
      if (vAllow < v0) v0 = vAllow;
    }
    return Math.max(v0, 2.5);
  }

  /** Everything ahead that this car has to not hit. */
  function obstacles(car, a0, px, pz, pSpeed, pfx, pfz) {
    let a = a0;
    const fx = car.fx, fz = car.fz;
    const rx = -fz, rz = fx;
    const laneHalf = Math.min(2.8, car.route[0].laneOff * 0.88);

    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (!o.active || o === car) continue;
      const dx = o.x - car.x, dz = o.z - car.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SCAN_R * SCAN_R) continue;
      const fwd = dx * fx + dz * fz;
      if (fwd <= 0.2) continue;
      const dot = o.fx * fx + o.fz * fz;
      const same = dot > 0.35;
      if (fwd > (same ? SCAN_R : 20)) continue;
      const lat = dx * rx + dz * rz;
      // Cross traffic gets a narrower but unconditional corridor: a car coming
      // through a junction sideways is still something to stop for.
      const half = same ? laneHalf : Math.min(2.2, laneHalf);
      if (lat < -half || lat > half) continue;
      // Its closing speed is its velocity along OUR heading, so a car crossing
      // our path correctly reads as an obstacle standing still in front of us.
      const vl = Math.max(0, o.speed * dot);
      const g = fwd - o.halfLen - car.halfLen;
      const q = follow(car, g, vl, GAP_MIN, car.timeGap);
      if (q < a) a = q;
    }

    // The player. Wider corridor, longer headway, bigger standstill gap: this
    // is the one obstacle that will do something unexpected.
    const dx = px - car.x, dz = pz - car.z;
    const fwd = dx * fx + dz * fz;
    if (fwd > -2.5 && fwd < 42) {
      const lat = dx * rx + dz * rz;
      const alat = lat < 0 ? -lat : lat;
      if (alat < 5.0) {
        const vl = Math.max(0, pSpeed * (pfx * fx + pfz * fz));
        const q = follow(car, fwd - car.halfLen - 2.4, vl, GAP_MIN + 2.6, car.timeGap + 0.55);
        if (q < a) a = q;
        // Player parked across the lane, or arriving faster than the following
        // law can absorb: stand on it rather than drive through them.
        if (fwd < 8 && alat < 3.6) a = Math.min(a, -B_MAX);
      }
    }
    return a;
  }

  // =========================================================================
  // Update
  // =========================================================================

  let prevPx = 0, prevPz = 0, havePrev = false, primed = false;
  let phx = 0, phz = -1;

  function update(dt, playerX, playerZ, playerSpeed, playerYaw) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;                // a tab that was in the background
    time += dt;

    // The signature does not carry a player heading, so derive one from where
    // the player actually went. main.js may pass car.yaw as a fifth argument
    // and get an exact one instead.
    if (playerYaw !== undefined) {
      phx = -Math.sin(playerYaw); phz = -Math.cos(playerYaw);
    } else if (havePrev) {
      const dx = playerX - prevPx, dz = playerZ - prevPz;
      const m = Math.sqrt(dx * dx + dz * dz);
      if (m > 0.05) {
        const k = 1 - Math.exp(-7 * dt);
        phx = lerp(phx, dx / m, k); phz = lerp(phz, dz / m, k);
        const n = Math.sqrt(phx * phx + phz * phz) || 1;
        phx /= n; phz /= n;
      }
    }
    prevPx = playerX; prevPz = playerZ; havePrev = true;

    // ---- pass 1: junction claims ------------------------------------------
    // Bids are gathered before anyone moves so the outcome does not depend on
    // the order the pool happens to be in.
    bidCount = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car.active) continue;

      if (car.holdNode >= 0) {
        claimAge[car.holdNode] += dt;
        // Deadlock guard: a car that claimed a junction and then stopped dead
        // (blocked by a queue on the far side) must eventually let go.
        if (claimAge[car.holdNode] > 9 && car.speed < 0.6) releaseClaim(car);
      }

      const slot = car.route[0];
      const node = nodes[slot.endNode];
      if (!node.stop || node.signal) continue;
      const dNode = slot.len - car.s;
      const range = Math.max(20, (car.speed * car.speed) / (2 * B_COMF) + 12);
      if (dNode > range) continue;
      if (claimOwner[node.i] !== -1) continue;

      const score = (RANK[slot.e.kind] ?? 1) * 100 - dNode;
      let seen = -1;
      for (let b = 0; b < bidCount; b++) if (bidNode[b] === node.i) { seen = b; break; }
      if (seen < 0) {
        bidNode[bidCount] = node.i; bidCar[bidCount] = i; bidScore[bidCount] = score; bidCount++;
      } else if (score > bidScore[seen]) {
        bidCar[seen] = i; bidScore[seen] = score;
      }
    }
    for (let b = 0; b < bidCount; b++) {
      const n = bidNode[b];
      if (claimOwner[n] !== -1) continue;
      const car = cars[bidCar[b]];
      releaseClaim(car);
      claimOwner[n] = car.id;
      claimAge[n] = 0;
      car.holdNode = n;
      car.holdDist = 0;
    }

    // ---- pass 2: drive ------------------------------------------------------
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car.active) continue;

      const slot = car.route[0];
      const dNode = slot.len - car.s;

      // Speed: free road, then whatever is in the way, then the junction.
      const v0 = planSpeed(car);
      const vr = car.speed / v0;
      let a = car.accel * (1 - vr * vr * vr * vr);
      a = obstacles(car, a, playerX, playerZ, playerSpeed, phx, phz);

      const node = nodes[slot.endNode];
      if (node.stop) {
        const stopLine = dNode - (slot.e.width * 0.5 + 2.0);
        const mustStop = node.signal
          ? !signalGreen(node, dNode, car.speed, car.fx, car.fz)
          : claimOwner[node.i] !== car.id;
        if (mustStop && stopLine > -2) {
          const q = follow(car, stopLine, 0, 0.6, 0.7);
          if (q < a) a = q;
        }
      }

      if (a > car.accel) a = car.accel;
      if (a < -B_MAX) a = -B_MAX;
      car.braking = a < -1.3;
      car.speed += a * dt;
      if (car.speed < 0) car.speed = 0;

      // Steering: pure pursuit onto a point ahead on the lane.
      routeAt(car, clamp(4.5 + car.speed * 0.8, 6.5, 26), _tgt);
      const dx = _tgt.x - car.x, dz = _tgt.z - car.z;
      const L2 = dx * dx + dz * dz;
      const rx = -car.fz, rz = car.fx;
      const lat = dx * rx + dz * rz;
      let want = L2 > 1e-3 ? (2 * lat) / L2 : 0;
      if (want > 0.24) want = 0.24; else if (want < -0.24) want = -0.24;
      // Rate limiting the curvature is what keeps a traffic car from snapping
      // to a new heading the instant its route crosses a junction.
      const kMax = 1.7 * dt;
      const dk = want - car.kappa;
      car.kappa += dk > kMax ? kMax : dk < -kMax ? -kMax : dk;
      // Positive curvature turns right, and yaw grows to the LEFT here.
      car.yaw -= car.kappa * car.speed * dt;
      if (car.yaw > Math.PI) car.yaw -= TAU; else if (car.yaw < -Math.PI) car.yaw += TAU;
      car.steerAngle = Math.atan(car.kappa * car.wheelbase);
      car.fx = -Math.sin(car.yaw);
      car.fz = -Math.cos(car.yaw);

      const travelled = car.speed * dt;
      car.x += car.fx * travelled;
      car.z += car.fz * travelled;

      // Station: advance at road speed, corrected by how far the car actually
      // is in front of or behind it. Without the correction, cutting corners
      // slowly walks the car off the back of its own route.
      routeAt(car, 0, _sta);
      const ex = _sta.x - car.x, ez = _sta.z - car.z;
      const el = clamp(ex * _sta.tx + ez * _sta.tz, -8, 8);
      let ds = car.speed - el * 1.8;
      if (ds < 0) ds = 0;
      car.s += ds * dt;

      let guard = 0;
      while (car.s >= car.route[0].len && guard++ < 4) {
        car.s -= car.route[0].len;
        const crossed = car.route[0];
        if (Math.abs(crossed.turnAtEnd) > 0.34) {
          car.indHold = 1.1;
          car.indicator = crossed.turnAtEnd > 0 ? 1 : -1;
        }
        if (car.holdNode === crossed.endNode) {
          car.holdDist = crossed.e.width * 0.6 + car.halfLen * 2 + 4;
        }
        const recycled = car.route[0];
        car.route[0] = car.route[1];
        car.route[1] = car.route[2];
        car.route[2] = car.route[3];
        car.route[3] = recycled;
        fillSlot(car.route[3], car.route[2]);
      }

      if (car.holdDist > 0) {
        car.holdDist -= travelled;
        if (car.holdDist <= 0) releaseClaim(car);
      }

      // Attitude. Grade comes from the lane polyline's own dy/ds, which is the
      // road's designed gradient — free, and exactly what a car on the road
      // should sit at. Carriageways are level across their width, so no roll.
      car.y = ground.heightAt(car.x, car.z) + car.rideHeight;
      car.pitch = lerp(car.pitch, Math.atan(_sta.grade), 1 - Math.exp(-6 * dt));
      car.roll = 0;

      car.wheelSpin = (car.wheelSpin + (car.speed / car.wheelRadius) * dt) % TAU;

      // Indicators: on for the approach to a real turn, and held briefly after
      // it so they do not cancel the instant the car crosses the stop line.
      if (car.indHold > 0) {
        car.indHold -= dt;
      } else {
        const turn = car.route[0].turnAtEnd;
        const dn = car.route[0].len - car.s;
        car.indicator = dn < 45 && Math.abs(turn) > 0.34 ? (turn > 0 ? 1 : -1) : 0;
      }

      // Recycling. Distance first, then the two ways a car can quietly break:
      // sitting still forever behind something that never moves, and drifting
      // so far off its lane that pure pursuit will never recover it.
      const pdx = car.x - playerX, pdz = car.z - playerZ;
      car.stuck = Math.max(0, car.stuck + (car.speed < 0.4 ? dt : -dt * 3));
      const off = (car.x - _sta.x) * (car.x - _sta.x) + (car.z - _sta.z) * (car.z - _sta.z);
      if (pdx * pdx + pdz * pdz > despawnR * despawnR || car.stuck > 25 || off > 900) {
        despawn(car);
      }
    }

    // ---- spawning -----------------------------------------------------------
    let near = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car.active) continue;
      const dx = car.x - playerX, dz = car.z - playerZ;
      if (dx * dx + dz * dz < radius * radius) near++;
    }
    // Budgeted: a few attempts a frame is enough to refill the ring within a
    // second, and it keeps the worst-case frame flat. The first call gets a
    // much bigger budget, because a road that fills up over the player's first
    // two seconds of driving reads as cars materialising out of nothing.
    const budget = primed ? 3 : 600;
    primed = true;
    for (let t = 0; t < budget && near < density && active < maxCars; t++) {
      if (trySpawn(playerX, playerZ, phx, phz)) near++;
    }
  }

  function dispose() {
    for (let i = 0; i < cars.length; i++) despawn(cars[i]);
    claimOwner.fill(-1);
    spawnCells.clear();
  }

  return {
    // A fixed-length pool, not a compacted list: slot identity is stable for
    // the session so the renderer can build one mesh per slot and only toggle
    // visibility. Skip entries whose `active` is false.
    cars,
    update,
    dispose,
    get count() { return active; },
  };
}
