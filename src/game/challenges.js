// Things to do.
//
// The play-test that started this file: a kid pressed Drive, found no goal, no
// reason to stay on the road and nothing to aim at, and ten seconds later was
// in a field. The title screen said "Nowhere to be". This module is the
// somewhere: races, speed traps, jumps, drift zones and tokens, every one of
// them laid on the REAL road graph so that following a challenge is following
// a road.
//
// Nothing here is hand-placed. The world is generated from a seed, so the
// challenges are too — from the same seed, so every player (and every player
// in the same multiplayer room) gets the same races in the same places, and a
// saved best time still means something next week.
//
// HOW THE NUMBERS ARE SET
//
// Medal targets are not guessed. Every race is timed by a REFERENCE DRIVER: a
// point-mass model of the starter car (the Group R rally hatch, 280 kW,
// 1290 kg) that brakes for every corner at the grip that surface actually has,
// accelerates at whatever its power and traction allow, and never makes a
// mistake. Gold is that time plus 12%, silver plus 30%, bronze plus 55%. A kid
// who finishes without crashing into a barn gets bronze; gold wants a clean,
// committed run. tools/goalscheck.mjs drives the REAL vehicle model through
// every race with a simple autopilot and checks the result lands inside bronze,
// so a medal table can never quietly become unwinnable.
//
// Speed traps come out of the same model: a camera sits where the reference car
// is carrying 150-215 km/h at the end of a long straight, with a straight
// run-out after it. Jumps are ramps (ramps.js explains why the crests will not
// do), sited on straights with a clear landing, and their medal distances come
// from a flight model that matches the real car to within 4%.
//
// Pure data and arithmetic: no three.js, no DOM.

import { createRoadGraph, buildRoute, LOOSE_CODE } from './routes.js';
import { mulberry } from '../world/noise.js';
import { RAMP, LAUNCH } from './ramps.js';

export const MEDAL_NONE = 0, MEDAL_BRONZE = 1, MEDAL_SILVER = 2, MEDAL_GOLD = 3;
export const MEDAL_NAMES = ['none', 'bronze', 'silver', 'gold'];

/** The starter car, as the reference driver sees it. */
export const REF_CAR = {
  power: 280000, mass: 1290, dragArea: 0.94, grip: 1.12, rolling: 0.016,
};

const G = 9.81;
const RHO = 1.225;

// Race medal factors over the reference time.
export const RACE_FACTORS = [0, 1.55, 1.30, 1.12];     // bronze, silver, gold (index = medal)
// Speed trap medal factors UNDER the reference peak.
const TRAP_FACTORS = [0, 0.74, 0.85, 0.94];

// Cash and XP for each medal, by kind. Paid as the DIFFERENCE when a medal is
// improved, so bronze-then-gold earns exactly what gold-first earns and there
// is no grinding the same bronze for money.
export const REWARDS = {
  race:  { cash: [0, 400, 800, 1500], xp: [0, 120, 240, 450] },
  trap:  { cash: [0, 150, 300, 600],  xp: [0, 40, 80, 160] },
  jump:  { cash: [0, 150, 300, 600],  xp: [0, 40, 80, 160] },
  drift: { cash: [0, 200, 400, 800],  xp: [0, 60, 120, 220] },
  token: { cash: 100, xp: 25 },
};

// Invented names. Every one — see tools/brandcheck.mjs.
const STAGE_NAMES = [
  'Rookie Run', 'Thunder Ridge Rally', 'Dustdevil Dash', 'Copperline Sprint',
  'Foxglove Stage', 'Skylark Scramble', 'Gorsewood Rally', 'Pinecrest Sprint',
];
const TRAP_NAMES = ['Long Mile', 'Flat Out Flats', 'Rocket Straight', 'Hawk Lane', 'The Runway', 'Bullet Row', 'Quarry Straight'];
const JUMP_NAMES = ['Sky Hop', 'Big Air', 'Launch Pad', 'Moon Shot', 'Hang Time', 'Kite Kicker'];
// No fire in any name a kid reads: the game has no fire in it any more
// (physics/damage.js), and 'Tyre Fire Bends' promised some.
const DRIFT_NAMES = ['Smoke Show', 'Sideways Snake', 'Hairpin Hustle', 'Slide Alley', 'The Pendulum'];

// ---------------------------------------------------------------------------
// The reference driver
// ---------------------------------------------------------------------------

/** Top speed of a car on the flat, m/s: where power meets drag. */
export function topSpeed(car = REF_CAR) {
  let lo = 5, hi = 120;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) * 0.5;
    const need = (0.5 * RHO * car.dragArea * v * v + car.rolling * car.mass * G) * v;
    if (need < car.power) lo = v; else hi = v;
  }
  return lo;
}

/**
 * Speed profile of the reference driver along `route`.
 *
 * Returns { step, n, v: Float32Array, time, peak, peakAt, kappa }. `v0` is
 * the speed at d = 0 (0 for a standing start), `flying` lets the end run free
 * instead of braking to the finish.
 *
 * Horizontal curvature is measured over a 24 m baseline, not point to point:
 * the polylines are 8 m apart and a 1 m wobble in one of them would otherwise
 * read as a hairpin. Grip is the tyre's peak times the surface's, with a 12%
 * margin, because the reference is a driver and not a tyre model.
 */
export function speedProfile(route, opts = {}) {
  const car = opts.car || REF_CAR;
  const step = opts.step || 4;
  const heights = opts.heights || null;           // optional (x, z) => y
  const n = Math.max(2, Math.floor(route.length / step) + 1);
  const xs = new Float32Array(n), zs = new Float32Array(n), ys = new Float32Array(n);
  const mu = new Float32Array(n);
  const p = {};
  for (let i = 0; i < n; i++) {
    route.at(Math.min(route.length, i * step), p);
    xs[i] = p.x; zs[i] = p.z;
    ys[i] = heights ? heights(p.x, p.z) : p.y;
    mu[i] = car.grip * (LOOSE_CODE[p.kind] ? 0.64 : 1.0) * 0.88;
  }
  // Smooth before differentiating. Consecutive edges can meet up to 6.8 m
  // apart (layout.js nudges junctions after laying polylines), and measured raw
  // those joins read as 2-5 m hairpins — which made the reference driver crawl
  // through every junction and rejected nearly every gravel stage as
  // undriveable. A +-12 m moving average removes the step and keeps any real
  // corner, which is always far longer than that.
  const W = Math.max(1, Math.round(12 / step));
  const sx = new Float32Array(n), sz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0, az = 0, c = 0;
    for (let k = -W; k <= W; k++) {
      const j = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
      ax += xs[j]; az += zs[j]; c++;
    }
    sx[i] = ax / c; sz[i] = az / c;
  }
  const B = Math.max(2, Math.round(12 / step));
  const kappa = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - B), b = Math.min(n - 1, i + B);
    // Near the ends the baseline is one-sided; curvature from a stub is noise.
    if (i - a < B || b - i < B) continue;
    const h1 = Math.atan2(sz[i] - sz[a], sx[i] - sx[a]);
    const h2 = Math.atan2(sz[b] - sz[i], sx[b] - sx[i]);
    let dh = h2 - h1;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    // The two chords' midpoints are (b - a) * step / 2 apart along the road.
    kappa[i] = Math.abs(dh) / ((b - a) * step * 0.5 + 1e-6);
  }
  const vTop = topSpeed(car);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = kappa[i] > 1e-5 ? Math.min(vTop, Math.sqrt(mu[i] * G / kappa[i])) : vTop;
  }
  // Forward: what the engine and the tyres can add.
  v[0] = Math.min(v[0], opts.v0 != null ? opts.v0 : 0);
  for (let i = 0; i < n - 1; i++) {
    const vi = Math.max(1, v[i]);
    const grade = (ys[i + 1] - ys[i]) / step;
    const drive = Math.min(mu[i] * G * 0.9, car.power / (car.mass * vi));
    const drag = (0.5 * RHO * car.dragArea * vi * vi) / car.mass + car.rolling * G;
    const a = drive - drag - G * grade;
    const next = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * a * step));
    if (next < v[i + 1]) v[i + 1] = next;
  }
  // Backward: what the brakes can take away before each corner.
  if (!opts.flying) v[n - 1] = Math.min(v[n - 1], vTop);
  for (let i = n - 2; i >= 0; i--) {
    const grade = (ys[i + 1] - ys[i]) / step;
    const b = mu[i] * G * 0.85 + G * grade;
    const lim = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * Math.max(1, b) * step));
    if (lim < v[i]) v[i] = lim;
  }
  let time = 0, peak = 0, peakAt = 0;
  for (let i = 0; i < n - 1; i++) {
    const avg = Math.max(0.5, (v[i] + v[i + 1]) * 0.5);
    time += step / avg;
    if (v[i] > peak) { peak = v[i]; peakAt = i * step; }
  }
  return { step, n, v, kappa, ys, xs, zs, time, peak, peakAt, vTop };
}

/**
 * Airtime and distance of a point mass leaving the road's vertical profile at
 * speed `v`, starting its check at index i0. Mirrors vehicle.js, which only
 * calls a car airborne once the ground has fallen 0.42 m below the chassis —
 * so the flight is measured with a 0.3 m gap, not from the first micron.
 */
export function flightAt(ys, step, i0, v, gap = 0.3) {
  const n = ys.length;
  // The car follows the road until the road curves away faster than gravity.
  let i = i0;
  let takeoff = -1;
  for (; i < Math.min(n - 2, i0 + Math.ceil(80 / step)); i++) {
    const ypp = (ys[i + 1] - 2 * ys[i] + ys[Math.max(0, i - 1)]) / (step * step);
    if (v * v * -ypp > G) { takeoff = i; break; }
  }
  if (takeoff < 0) return { air: 0, dist: 0, takeoff: -1 };
  const slope = (ys[takeoff] - ys[takeoff - 1]) / step;
  let y = ys[takeoff], vy = v * slope, t = 0;
  const dt = 0.01;
  let x = 0, airborne = 0, flightDist = 0;
  let prevGap = 0;
  for (let k = 0; k < 600; k++) {
    t += dt; x += v * dt; vy -= G * dt; y += vy * dt;
    const s = x / step + takeoff;
    const j = Math.floor(s);
    if (j >= n - 1) break;
    const f = s - j;
    const road = ys[j] + (ys[j + 1] - ys[j]) * f;
    const g2 = y - road;
    if (g2 > gap) { airborne += dt; flightDist = x; }
    if (g2 <= 0 && k > 2) break;
    prevGap = g2;
  }
  return { air: airborne, dist: flightDist, takeoff, prevGap };
}

/**
 * Where a car launched off a ramp whose toe is at profile index i0 comes back
 * down, in metres from the lip — against the real road beyond it, so a
 * downhill landing is honestly longer than a flat one.
 */
export function landingDistance(prof, i0, v, L = RAMP.length, H = RAMP.height) {
  const ang = Math.atan((2 * H) / L);
  const lipD = i0 * prof.step + L;
  const road = (d) => {
    const s = d / prof.step;
    const j = Math.min(prof.n - 2, Math.max(0, Math.floor(s)));
    const f = Math.min(1, Math.max(0, s - j));
    return prof.ys[j] + (prof.ys[j + 1] - prof.ys[j]) * f;
  };
  let y = road(lipD) + H, vy = v * Math.sin(ang) * LAUNCH;
  const vx = v * Math.cos(ang);
  let x = 0;
  for (let k = 0; k < 800; k++) {
    const dt = 0.005;
    x += vx * dt; vy -= G * dt; y += vy * dt;
    if (y <= road(lipD + x) && vy < 0) break;
  }
  return x;
}

/** Round up to the nearest half second — medal times read cleanly. */
const halfUp = (t) => Math.ceil(t * 2) / 2;
const roundTo = (v, q) => Math.round(v / q) * q;

/** Medal earned for a race time (lower is better). */
export function raceMedal(time, targets) {
  if (!(time > 0) || !Number.isFinite(time)) return MEDAL_NONE;
  if (time <= targets[MEDAL_GOLD]) return MEDAL_GOLD;
  if (time <= targets[MEDAL_SILVER]) return MEDAL_SILVER;
  if (time <= targets[MEDAL_BRONZE]) return MEDAL_BRONZE;
  return MEDAL_NONE;
}

/** Medal earned for a score (higher is better): speed, distance, points. */
export function scoreMedal(score, targets) {
  if (!(score > 0) || !Number.isFinite(score)) return MEDAL_NONE;
  if (score >= targets[MEDAL_GOLD]) return MEDAL_GOLD;
  if (score >= targets[MEDAL_SILVER]) return MEDAL_SILVER;
  if (score >= targets[MEDAL_BRONZE]) return MEDAL_BRONZE;
  return MEDAL_NONE;
}

/** m:ss.t, or ss.t under a minute. */
export function formatTime(t) {
  if (!(t >= 0) || !Number.isFinite(t)) return '--:--.-';
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const RACE_KINDS = { rural: 1, gravel: 1, dirt: 1 };

/**
 * Every challenge in the world. Deterministic in world.seed.
 *
 * opts.ground  optional; when given, heights come from the stamped surface the
 *              car actually drives on rather than the designed centreline
 *              (they differ by up to 0.9 m — enough to move a crest).
 */
export function generateChallenges(world, opts = {}) {
  const ground = opts.ground || null;
  const heights = ground ? (x, z) => ground.heightAt(x, z) : null;
  const graph = opts.graph || createRoadGraph(world);
  const rnd = mulberry((world.seed | 0) ^ 0x60a15);
  const junction = world.nodes.filter((n) => n.edges.length >= 3);
  const list = [];
  const taken = [];        // [x, z, radius] — keeps challenges from piling up

  const far = (x, z, r) => {
    for (const t of taken) if (Math.hypot(t[0] - x, t[1] - z) < Math.max(r, t[2])) return false;
    return true;
  };
  const claim = (x, z, r) => taken.push([x, z, r]);
  const junctionClear = (x, z) => {
    let bd = Infinity;
    for (const n of junction) { const d = Math.hypot(n.x - x, n.z - z); if (d < bd) bd = d; }
    return bd;
  };
  const tmp = {};

  /**
   * Gate positions for a race: `count` gates spread evenly after `d0`, each
   * nudged up to 40 m to keep it clear of a junction, where a gate's posts
   * would stand in the other road.
   */
  function placeGates(route, d0, d1, count, lapFinish = false) {
    const gates = [];
    for (let k = 1; k <= count; k++) {
      const want = d0 + (d1 - d0) * (k / count);
      let best = want, bestClear = -1;
      const last = k === count;
      // A lap's finish IS its start line; nothing moves it.
      if (last && lapFinish) { gates.push(gateAt(route, d1)); continue; }
      for (let off = -40; off <= (last ? 0 : 40); off += 4) {
        const d = want + off;
        if (d <= d0 + 30 || d > d1) continue;
        route.at(d, tmp);
        const c = junctionClear(tmp.x, tmp.z);
        const score = Math.min(c, 30) - Math.abs(off) * 0.05;
        if (score > bestClear) { bestClear = score; best = d; }
      }
      gates.push(gateAt(route, best));
    }
    return gates;
  }

  function gateAt(route, d) {
    const p = route.at(d, {});
    return {
      d, x: p.x, z: p.z, y: heights ? heights(p.x, p.z) : p.y,
      tx: p.tx, tz: p.tz, hw: p.hw, kind: p.kind,
    };
  }

  /**
   * True when no shortcut on the network beats the race route between
   * consecutive gates by more than 8%. Without this a gate pair that happens to
   * straddle a junction lets the driver cut across on a farm track and smash
   * the gold time — and the gold time stops meaning anything.
   */
  function noShortcuts(route, points) {
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1], b = points[k];
      const A = graph.locate(a.x, a.z, 30, null, {});
      const B = graph.locate(b.x, b.z, 30, null, {});
      if (!A || !B) return false;
      const pieces = graph.pathPieces(A.edge, A.s, B.edge, B.s);
      if (!pieces) return false;
      let len = 0;
      for (const pc of pieces) len += Math.abs(pc.s1 - pc.s0);
      if (len < (b.d - a.d) * 0.92) return false;
    }
    return true;
  }

  // ---- circuits -----------------------------------------------------------
  for (const c of world.circuits || []) {
    const loop = circuitLap(world, c);
    if (!loop) continue;
    // Start the lap 40 m past the circuit's start node. That node is where the
    // access road joins, and a start line on a junction stands its gantry in
    // the other road. Rotating the loop keeps start and finish on one line.
    const f0 = loop[0];
    const dir = f0.s1 >= f0.s0 ? 1 : -1;
    const cut = Math.min(40, f0.edge.length * 0.5);
    const pieces = [{ edge: f0.edge, s0: f0.s0 + dir * cut, s1: f0.s1 }, ...loop.slice(1), { edge: f0.edge, s0: f0.s0, s1: f0.s0 + dir * cut }];
    const route = buildRoute(pieces);
    if (route.length < 800) continue;
    const prof = speedProfile(route, { heights, v0: 0 });
    const count = Math.max(5, Math.min(8, Math.round(route.length / 330)));
    const d0 = 0;
    const gates = placeGates(route, d0, route.length, count, true);
    const start = gateAt(route, d0);
    list.push(makeRace({
      id: `race-${slug(c.name)}`, name: `${c.name} Lap`, venue: c.name,
      route, start, gates, prof, lap: true, surface: c.kind === 'rallyx' ? 'gravel' : 'asphalt',
    }));
    claim(start.x, start.z, 380);
  }

  // ---- point-to-point stages ---------------------------------------------
  const stageCands = [];
  const starts = world.nodes.filter((n) => n.edges.length === 2 &&
    n.edges.every((ei) => RACE_KINDS[world.edges[ei].kind]));
  for (let attempt = 0; attempt < 220 && stageCands.length < 60; attempt++) {
    const node = starts[Math.floor(rnd() * starts.length)];
    if (!node) break;
    const first = world.edges[node.edges[rnd() < 0.5 ? 0 : 1]];
    const want = 1300 + rnd() * 1300;
    const pieces = graph.walk(node.i, first, want, (e) => (RACE_KINDS[e.kind] ? undefined : false), rnd);
    let len = 0;
    for (const p of pieces) len += Math.abs(p.s1 - p.s0);
    if (len < 1100) continue;
    const route = buildRoute(pieces);
    const prof = speedProfile(route, { heights, v0: 0 });
    // Not a hairpin in sight: a reference speed under 38 km/h anywhere is a
    // corner a kid on a keyboard will not get round.
    let slowest = Infinity, loose = 0;
    for (let i = 2; i < prof.n - 2; i++) if (prof.v[i] < slowest) slowest = prof.v[i];
    for (let i = 0; i < route.n; i++) loose += LOOSE_CODE[route.kind[i]];
    const looseFrac = loose / Math.max(1, route.n);
    // Loose surfaces are slower by nature; a 30 km/h hairpin on gravel is
    // a rally stage, on tarmac it is a mistake in the road.
    if (slowest < (looseFrac > 0.5 ? 8.3 : 10.5)) continue;
    let climb = 0;
    for (let i = 1; i < prof.n; i++) climb += Math.abs(prof.ys[i] - prof.ys[i - 1]);
    stageCands.push({ route, prof, looseFrac, climb, len: route.length, slowest });
  }

  // The rookie run first: short, on tarmac, gentle, and as close to the middle
  // of the map — where a new player starts — as possible.
  const rookieScore = (c) => {
    const st = c.route.at(0, {});
    return c.looseFrac * 3 + Math.abs(c.len - 1400) / 600 + Math.hypot(st.x, st.z) / 900
      + Math.max(0, 16 - c.slowest) * 0.3;
  };
  const byRookie = stageCands.slice().sort((a, b) => rookieScore(a) - rookieScore(b));
  const chosenStages = [];
  const tryStage = (c) => {
    const st = c.route.at(0, {});
    const en = c.route.at(c.route.length, {});
    if (!far(st.x, st.z, 520) || !far(en.x, en.z, 250)) return false;
    const count = Math.max(5, Math.min(8, Math.round(c.len / 300)));
    const d0 = 30;
    const gates = placeGates(c.route, d0, c.route.length - 5, count);
    const start = gateAt(c.route, d0);
    if (!noShortcuts(c.route, [start, ...gates])) return false;
    const prof = speedProfile(c.route, { heights, v0: 0 });
    // Retime from the start line, not the start node.
    let t = 0;
    const i0 = Math.floor(d0 / prof.step);
    const sub = speedProfileFrom(prof, i0);
    t = sub;
    chosenStages.push({ c, gates, start, time: t });
    claim(st.x, st.z, 520);
    claim(en.x, en.z, 250);
    return true;
  };
  for (const c of byRookie) { if (tryStage(c)) break; }
  // Then the rest by character: gravel stages with climb first.
  const byRally = stageCands.slice().sort((a, b) => (b.looseFrac * 2 + b.climb / 120) - (a.looseFrac * 2 + a.climb / 120));
  for (const c of byRally) {
    if (chosenStages.length >= 4) break;
    tryStage(c);
  }
  chosenStages.forEach((s, i) => {
    list.push(makeRace({
      id: `stage-${i}`, name: STAGE_NAMES[i % STAGE_NAMES.length], venue: '',
      route: s.c.route, start: s.start, gates: s.gates, prof: s.c.prof,
      time: s.time, lap: false, surface: s.c.looseFrac > 0.5 ? 'gravel' : 'asphalt',
      rookie: i === 0,
    }));
  });

  // ---- runs: long straightest-continuation walks, for traps and jumps ------
  const runs = [];
  const runStarts = world.nodes.filter((n) => n.edges.length >= 2);
  for (let k = 0; k < 220; k++) {
    const node = runStarts[Math.floor(rnd() * runStarts.length)];
    const first = world.edges[node.edges[Math.floor(rnd() * node.edges.length)]];
    if (first.kind === 'track') continue;
    const pieces = graph.walk(node.i, first, 1400, (e) => (e.kind === 'track' ? false : undefined));
    let len = 0;
    for (const p of pieces) len += Math.abs(p.s1 - p.s0);
    if (len < 700) continue;
    const route = buildRoute(pieces);
    runs.push({ route, prof: speedProfile(route, { heights, v0: 14, flying: true }) });
  }
  const straightFor = (prof, i0, i1) => {
    for (let i = Math.max(0, i0); i <= Math.min(prof.n - 1, i1); i++) if (prof.kappa[i] > 0.0025) return false;
    return true;
  };

  // ---- speed traps --------------------------------------------------------
  // A camera where the reference car is going fastest — but not at top speed.
  // On the long rural straights the reference reaches 250+ km/h, and a trap
  // that asks a kid for 245 km/h in the starter car is a trap nobody gets.
  // So candidates are taken in the 150-215 km/h band, and the road must stay
  // straight for 180 m PAST the camera: the run-out is where a kid who has
  // just been told to floor it finds out whether they can stop.
  const trapCands = [];
  for (const r of runs) {
    const { prof, route } = r;
    const run = Math.ceil(300 / prof.step), out = Math.ceil(180 / prof.step);
    for (let i = run; i < prof.n - out; i += 2) {
      const kmh = prof.v[i] * 3.6;
      if (kmh < 150 || kmh > 215) continue;
      if (prof.v[i + 2] > prof.v[i] + 0.5) continue;       // still accelerating hard: move on
      if (!straightFor(prof, i - 25, i + out)) continue;
      trapCands.push({ route, prof, d: i * prof.step, v: prof.v[i] });
    }
  }
  trapCands.sort((a, b) => b.v - a.v);
  let traps = 0;
  for (const c of trapCands) {
    if (traps >= 6) break;
    const p = c.route.at(c.d, {});
    if (junctionClear(p.x, p.z) < 40 || !far(p.x, p.z, 450)) continue;
    const kmh = c.v * 3.6;
    const targets = TRAP_FACTORS.map((f) => (f ? roundTo(kmh * f, 5) : 0));
    const runupD = Math.max(0, c.d - 420);
    const at = gateAt(c.route, c.d);
    list.push({
      id: `trap-${traps}`, kind: 'trap', name: TRAP_NAMES[traps % TRAP_NAMES.length],
      x: at.x, z: at.z, y: at.y, tx: at.tx, tz: at.tz, hw: at.hw,
      gate: at, approach: subRoute(c.route, runupD, c.d + 60),
      start: gateAt(c.route, runupD),
      targets, unit: 'km/h', ref: kmh,
    });
    claim(p.x, p.z, 450);
    traps++;
  }

  // ---- jumps: ramps on straights -------------------------------------------
  // See ramps.js for why these are built and not found. A site needs 260 m of
  // straight run-up, 160 m of straight landing, a road that does not climb
  // into the landing, and a road wide enough that traffic passes the ramp.
  const jumpCands = [];
  for (const r of runs) {
    const { prof, route } = r;
    const run = Math.ceil(260 / prof.step), out = Math.ceil(160 / prof.step);
    for (let i = run; i < prof.n - out; i += 3) {
      if (!straightFor(prof, i - run, i + out)) continue;
      const here = route.at(i * prof.step, tmp);
      if (here.hw < 4.5) continue;                       // rural lanes only: 9.5 m
      const rise = prof.ys[i + Math.ceil(50 / prof.step)] - prof.ys[i];
      if (rise > 0.8) continue;
      jumpCands.push({ route, prof, i, d: i * prof.step, drop: -rise });
    }
  }
  // Downhill landings first: they are longer and softer.
  jumpCands.sort((a, b) => b.drop - a.drop);
  let jumps = 0;
  for (const c of jumpCands) {
    if (jumps >= 5) break;
    const toe = gateAt(c.route, c.d);
    if (!far(toe.x, toe.z, 420) || junctionClear(toe.x, toe.z) < 60) continue;
    // Medal distances from the flight model against THIS road's landing, at
    // launch speeds of 55, 80 and 105 km/h. The model matches the real car to
    // within 4% (tools/goalscheck.mjs flies it).
    const L = RAMP.length;
    const targets = [0, 55, 80, 105].map((kmh) => (kmh ? Math.round(landingDistance(c.prof, c.i, kmh / 3.6, L)) : 0));
    const runupD = Math.max(0, c.d - 300);
    list.push({
      id: `jump-${jumps}`, kind: 'jump', name: JUMP_NAMES[jumps % JUMP_NAMES.length],
      x: toe.x, z: toe.z, y: toe.y, tx: toe.tx, tz: toe.tz, hw: toe.hw,
      gate: toe, ramp: { x: toe.x, z: toe.z, tx: toe.tx, tz: toe.tz, y: toe.y },
      approach: subRoute(c.route, runupD, c.d + L + 40),
      start: gateAt(c.route, runupD),
      targets, unit: 'm', ref: targets[MEDAL_GOLD],
    });
    claim(toe.x, toe.z, 420);
    jumps++;
  }

  // ---- drift zones --------------------------------------------------------
  // Twisty but not tight: 300 m holding at least 150 degrees of heading change,
  // with no corner under a 22 m radius on tarmac (16 m on gravel, where the car
  // is sliding anyway). Circuits are the natural home — wide, no traffic — so
  // their laps are searched as well as the runs.
  const driftSources = runs.slice();
  for (const c of list) if (c.kind === 'race' && c.lap) driftSources.push({ route: c.route, prof: speedProfile(c.route, { heights, v0: 20, flying: true }), circuit: true });
  const driftCands = [];
  for (const r of driftSources) {
    const { prof, route } = r;
    const span = Math.ceil(300 / prof.step);
    for (let i = Math.ceil(80 / prof.step); i + span < prof.n; i += 4) {
      let turn = 0, minR = Infinity, vSum = 0;
      for (let k = i; k < i + span; k++) {
        turn += prof.kappa[k] * prof.step;
        if (prof.kappa[k] > 1e-6) minR = Math.min(minR, 1 / prof.kappa[k]);
        vSum += prof.v[k];
      }
      const pk = route.at(i * prof.step, tmp);
      const loose = LOOSE_CODE[pk.kind];
      if (minR < (loose ? 16 : 22) || turn < 2.6) continue;
      if (vSum / span < 12) continue;                     // average under 43 km/h: a crawl
      driftCands.push({ route, d0: i * prof.step, d1: (i + span) * prof.step, turn, circuit: !!r.circuit, loose });
    }
  }
  driftCands.sort((a, b) => (b.turn + (b.circuit ? 1.5 : 0)) - (a.turn + (a.circuit ? 1.5 : 0)));
  let drifts = 0;
  for (const c of driftCands) {
    if (drifts >= 4) break;
    const a = gateAt(c.route, c.d0), b = gateAt(c.route, c.d1);
    // Circuits are already claimed by their own lap race; a drift zone may
    // share one, just not sit on its start line.
    const clearOfOthers = c.circuit
      ? list.every((o) => (o.kind === 'race' ? Math.hypot(o.x - a.x, o.z - a.z) > 250 : Math.hypot(o.x - a.x, o.z - a.z) > 380))
        && list.every((o) => o.kind !== 'drift' || Math.hypot(o.x - a.x, o.z - a.z) > 600)
      : far(a.x, a.z, 380) && far(b.x, b.z, 200);
    if (!clearOfOthers) continue;
    const len = c.d1 - c.d0;
    // Points per metre, from tools/driftcheck.mjs's table: holding 25-35 deg
    // at 60-70 km/h pays 100-170 pts/s, about 6-9 pts per metre travelled.
    // Bronze asks for a few slides, gold for most of the zone sideways.
    const pay = c.loose ? 0.82 : 1;
    const targets = [0, roundTo(len * 1.0 * pay, 50), roundTo(len * 2.6 * pay, 50), roundTo(len * 5 * pay, 50)];
    const approachD = Math.max(0, c.d0 - 250);
    list.push({
      id: `drift-${drifts}`, kind: 'drift', name: DRIFT_NAMES[drifts % DRIFT_NAMES.length],
      x: a.x, z: a.z, y: a.y, tx: a.tx, tz: a.tz, hw: a.hw,
      gate: a, end: b, zone: subRoute(c.route, c.d0, c.d1),
      approach: subRoute(c.route, approachD, c.d1),
      start: gateAt(c.route, approachD),
      targets, unit: 'pts', length: len, surface: c.loose ? 'gravel' : 'asphalt',
    });
    if (!c.circuit) { claim(a.x, a.z, 380); claim(b.x, b.z, 200); }
    drifts++;
  }

  // ---- tokens -------------------------------------------------------------
  // Scattered over the whole network, tracks included: a token is a reason to
  // go down the road you would otherwise never take.
  const tokens = [];
  const order = world.edges.map((e) => e.i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const want = opts.tokens || 50;
  for (let pass = 0; pass < 3 && tokens.length < want; pass++) {
    const sep = [300, 220, 160][pass];
    for (const ei of order) {
      if (tokens.length >= want) break;
      const e = world.edges[ei];
      if (e.length < 40) continue;
      const s = e.length * (0.3 + rnd() * 0.4);
      const pts = e.pts;
      let k = 0;
      while (k < pts.length - 2 && pts[k + 1].s < s) k++;
      const a = pts[k], b = pts[k + 1];
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      let ok = true;
      for (const q of tokens) if (Math.hypot(q.x - x, q.z - z) < sep) { ok = false; break; }
      for (const c of list) if (Math.hypot(c.x - x, c.z - z) < 60) { ok = false; break; }
      if (!ok) continue;
      const y = heights ? heights(x, z) : a.y + (b.y - a.y) * t;
      tokens.push({ i: tokens.length, x, z, y, edge: e.i, kind: e.kind });
    }
  }

  return { list, tokens, graph, byId: Object.fromEntries(list.map((c) => [c.id, c])) };
}

function makeRace(o) {
  const time = o.time != null ? o.time : o.prof.time;
  const targets = RACE_FACTORS.map((f) => (f ? halfUp(time * f) : 0));
  return {
    id: o.id, kind: 'race', name: o.name, venue: o.venue, lap: !!o.lap,
    surface: o.surface, rookie: !!o.rookie,
    x: o.start.x, z: o.start.z, y: o.start.y, tx: o.start.tx, tz: o.start.tz, hw: o.start.hw,
    start: o.start, gate: o.start, gates: o.gates, route: o.route,
    length: o.route.length, targets, ref: time, unit: 's',
  };
}

/** Reference time from index i0 to the end of an existing profile. */
function speedProfileFrom(prof, i0) {
  // Re-run the forward pass from a standing start at i0; the backward limits
  // already in prof.v still apply.
  const v = prof.v;
  let vi = 0, t = 0;
  const car = REF_CAR;
  for (let i = i0; i < prof.n - 1; i++) {
    const grade = (prof.ys[i + 1] - prof.ys[i]) / prof.step;
    const vv = Math.max(1, vi);
    const drive = Math.min(car.grip * 0.88 * G * 0.9, car.power / (car.mass * vv));
    const drag = (0.5 * RHO * car.dragArea * vv * vv) / car.mass + car.rolling * G;
    const a = drive - drag - G * grade;
    let next = Math.sqrt(Math.max(0, vi * vi + 2 * a * prof.step));
    if (next > v[i + 1]) next = v[i + 1];
    t += prof.step / Math.max(0.5, (vi + next) * 0.5);
    vi = next;
  }
  return t;
}

/** The part of a route between two distances, as a Route of its own. */
export function subRoute(route, d0, d1) {
  const pieces = [];
  // Rebuild from the route's own pieces, clipped.
  let acc = 0;
  for (const p of route.pieces) {
    const len = Math.abs(p.s1 - p.s0);
    const a = acc, b = acc + len;
    acc = b;
    if (b <= d0 || a >= d1) continue;
    const lo = Math.max(d0, a) - a, hi = Math.min(d1, b) - a;
    const dir = p.s1 >= p.s0 ? 1 : -1;
    pieces.push({ edge: p.edge, s0: p.s0 + dir * lo, s1: p.s0 + dir * hi });
  }
  return buildRoute(pieces.length ? pieces : [route.pieces[0]]);
}

/**
 * The closed loop of a circuit, as pieces starting at its start node. Walks the
 * edges of the circuit's own kind, which is all a lap is: the gravel roads that
 * cross it are other kinds and the access road is rural.
 */
function circuitLap(world, c) {
  const kind = c.kind;
  const startNode = c.start.i != null ? c.start.i : c.start;
  const pieces = [];
  let node = startNode, prevEdge = -1;
  for (let guard = 0; guard < 200; guard++) {
    const n = world.nodes[node];
    let next = null;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (e.kind !== kind || e.i === prevEdge) continue;
      next = e;
      break;
    }
    if (!next) return null;
    const fwd = next.a === node;
    pieces.push({ edge: next, s0: fwd ? 0 : next.length, s1: fwd ? next.length : 0 });
    node = fwd ? next.b : next.a;
    prevEdge = next.i;
    if (node === startNode) return pieces;
  }
  return null;
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
