// The world's data model.
//
// Everything downstream — terrain mesh, buildings, traffic, minimap, and the
// ground query the physics stands on — is generated from what this file
// returns. Nothing here touches three.js or the DOM, so the headless harnesses
// build the exact same world the browser does.
//
//   world.nodes      intersections            {i, x, z, y, kind, edges[]}
//   world.edges      road segments            {i, a, b, kind, width, pts[], length}
//   world.blocks     city blocks              {cx, cz, hx, hz, rot, district, kind}
//   world.lots       building footprints      {x, z, w, d, rot, kind, height, seed}
//   world.props      street furniture, trees  {type, x, z, y, rot, scale}
//
// Coordinates: X east, Z south, Y up. The world spans [-half, half] on X and Z.
//
// The elevation solver is the fussy part, and it is fussy for a reason: a road
// network draped over rolling ground produces junctions that are ramps, lanes
// that are walls, and — worst of all — pairs of roads that occupy the same
// ground while claiming different heights. Each of those was measured, not
// guessed, and each has a pass here that fixes it.

import { fbm, ridged, valueNoise, mulberry, smoothstep, clamp, lerp } from './noise.js';

export const ROAD = {
  highway: { width: 26.0, lanes: 2, speed: 39, surface: 'asphalt', markings: 'highway' },
  avenue:  { width: 21.0, lanes: 2, speed: 22, surface: 'asphalt', markings: 'avenue' },
  link:    { width: 17.0, lanes: 1, speed: 25, surface: 'asphalt', markings: 'avenue' },
  street:  { width: 13.5, lanes: 1, speed: 15, surface: 'asphalt', markings: 'street' },
  rural:   { width: 9.5,  lanes: 1, speed: 25, surface: 'asphalt', markings: 'rural' },
  gravel:  { width: 7.5,  lanes: 1, speed: 18, surface: 'gravel',  markings: 'none' },
  dirt:    { width: 7.5,  lanes: 1, speed: 15, surface: 'dirt',    markings: 'none' },
  track:   { width: 5.5,  lanes: 1, speed: 11, surface: 'dirt',    markings: 'none' },
};

// Loose-surface roads are held to a different standard than paved ones: they
// follow the ground rather than being graded onto it, and they are allowed to
// be twice as steep. That is the entire appeal — a gravel stage that has been
// flattened into a 13% ramp is just a rural lane with worse grip.
const LOOSE = { gravel: 1, dirt: 1, track: 1 };

// The gradient the elevation solver holds a road's polyline to. Loose surfaces
// get 26% against tarmac's 13%.
//
// tools/groundcheck.mjs keeps its own copy of this table and tests the stamped
// height field against it with 35% of headroom. That copy lists 'dirt' and
// 'track' but not 'gravel', so until it does, gravel is graded against tarmac's
// figure and the C0 check reports 1.15% against its 0.20% limit. Add 'gravel'
// to the harness's table and the same world reports 0.096%.
//
// The harness's C1 kink check is a separate and harder problem, and it is NOT
// a stale table: it has no per-kind budget and there was never any headroom.
// Removing this whole gravel block scores 698/349716 = 0.19959% against its
// 0.200% limit — 1.4 samples of margin before a metre of gravel exists. Per
// kind the kink rate tracks the cross-slope the road is stamped across, not its
// surface: street 0.003%, rural 0.327%, gravel 0.835%, dirt 0.696%, track
// 1.162%. For the total to land under 0.200% gravel would have to come in below
// 0.27% — smoother than the paved rural lanes. It cannot: stripped of every
// rally characteristic (follow 0, tarmac's 13% cap, 40 smoothing passes instead
// of 5) gravel still floors at 0.440% and the total at 0.2344%. The residue is
// the 3 m height-field grid and the Hermite knots in ground.js, not the route.
// At this character the check admits about 2.4 km of gravel; the brief asked
// for twenty. Passing it needs a loose-surface kink threshold in the harness,
// which is a call for whoever owns the physics, not for this file.
export const GRADE_CAP = { gravel: 0.26, dirt: 0.26, track: 0.26 };
/** The steepest gradient a road of this kind is shaped to. Exported so the
 *  harness measures against the same table the solver enforces — when the two
 *  drifted apart, 21.5 km of legitimately steep gravel read as a violation. */
export const gradeCap = (kind) => GRADE_CAP[kind] ?? 0.13;
/** True for loose surfaces, which are allowed a rougher centreline. */
export const isLoose = (kind) => kind === 'gravel' || kind === 'dirt' || kind === 'track';

// The junction-to-junction cap, which must sit BELOW the polyline cap rather
// than merely near it. capGrade leaves both ends of a polyline pinned, so
// whatever gradient the two end nodes imply is the one gradient it is not
// allowed to redistribute — set the two equal and the polyline cap silently
// stops meaning anything.
const NODE_CAP = { gravel: 0.24, dirt: 0.24, track: 0.24 };
const nodeCap = (kind) => NODE_CAP[kind] ?? 0.115;

// How closely a road's surface chases the bare terrain between its junctions.
// City roads are graded onto a shelf; country roads keep hugging the ground,
// which is what keeps the cut-and-fill small enough to blend away later.
const FOLLOW = { rural: 0.92, dirt: 0.92, track: 0.92, gravel: 0.92 };

const HALF = 2048;
const CITY_R = 1180;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Bare ground elevation before roads flatten anything. Pure function of (x,z)
 * and the seed, C2 continuous, cheap enough to call every physics step.
 */
export function makeTerrain(seed) {
  const s = seed | 0;

  function height(x, z) {
    const d = Math.hypot(x, z);
    // 0 deep in the city, 1 out in open country.
    const out = smoothstep(CITY_R * 0.55, CITY_R + 620, d);

    // The city sits on a gently tilted shelf, kept deliberately shallow: a flat
    // street grid laid over big relief ends up metres in the air, and the
    // embankment needed to hide that is worse than the hill it replaced.
    const shelf = fbm(x / 1900, z / 1900, s + 3, 2) * 2.0 - 0.5;

    // Open country: broad rolling farmland...
    const rolling = fbm(x / 780, z / 780, s + 17, 4) * 30;
    // ...with ridged spines growing into hills toward the map edge.
    const far = smoothstep(0.25, 1.0, out) * smoothstep(900, 2000, d);
    const spines = ridged(x / 1500, z / 1500, s + 91, 3) * 62 * far;

    // Fine relief, heavily damped inside the city so streets stay drivable.
    const detail = fbm(x / 145, z / 145, s + 5, 3) * 2.2 * (0.10 + 0.90 * out);

    // A river valley carves a low corridor through the countryside.
    const rv = valueNoise(x / 2600, z / 2600, s + 404);
    const valley = -18 * Math.exp(-Math.pow((z * 0.6 + x * 0.32) / 520 - rv * 1.6 - 1.35, 2)) * out;

    return lerp(shelf, shelf * 0.35 + rolling + spines, out) + detail + valley;
  }

  // Central-difference normal. 1.5 m is small enough to catch real slope, large
  // enough that fine detail noise does not make the normal jitter.
  function normal(x, z, out) {
    const e = 1.5;
    const hx = height(x + e, z) - height(x - e, z);
    const hz = height(x, z + e) - height(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const inv = 1 / Math.hypot(nx, ny, nz);
    if (out) { out.set(nx * inv, ny * inv, nz * inv); return out; }
    return { x: nx * inv, y: ny * inv, z: nz * inv };
  }

  function slope(x, z) {
    return Math.acos(clamp(normal(x, z).y, -1, 1));
  }

  /** Natural ground cover, before roads are stamped on top. */
  function cover(x, z, ny) {
    // `ny` is the caller's already-computed normal Y. Recomputing the slope here
    // costs four extra height evaluations, and this runs per wheel per step.
    const sl = ny === undefined ? slope(x, z) : Math.acos(clamp(ny, -1, 1));
    if (sl > 0.62) return 'rock';
    const d = Math.hypot(x, z);
    if (d < CITY_R * 0.9) return 'grass';
    const h = height(x, z);
    const n = fbm(x / 320, z / 320, s + 77, 3);
    // Sand belongs to the river valley, not to the farmland. The old threshold
    // (h < -9) caught more than a quarter of the map, because the valley cuts
    // to -18 over a wide corridor — the countryside read as desert rather than
    // as country.
    if (h < -12.5 && n < 0.10) return 'sand';
    if (n > 0.40 && h > 16) return 'dirt';
    return 'grass';
  }

  return { height, normal, slope, cover, seed: s, half: HALF, cityRadius: CITY_R };
}

// ---------------------------------------------------------------------------
// Graph primitives
// ---------------------------------------------------------------------------

function addNode(world, x, z, kind) {
  const n = { i: world.nodes.length, x, z, y: 0, kind, edges: [], stop: false };
  world.nodes.push(n);
  return n;
}

function addEdge(world, a, b, kind, pts) {
  if (!a || !b || a === b) return null;
  for (const ei of a.edges) {
    const e = world.edges[ei];
    if (e.a === b.i || e.b === b.i) return e;
  }
  const spec = ROAD[kind];
  const e = {
    i: world.edges.length, a: a.i, b: b.i, kind,
    width: spec.width, lanes: spec.lanes, speed: spec.speed,
    surface: spec.surface, markings: spec.markings,
    pts: pts || null, length: 0,
  };
  world.edges.push(e);
  a.edges.push(e.i);
  b.edges.push(e.i);
  return e;
}

// ---------------------------------------------------------------------------
// Districts: rotated lattices of streets
// ---------------------------------------------------------------------------

function buildDistrict(world, rnd, spec) {
  const { id, name, cx, cz, rot, cols, rows, cell, kind } = spec;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const jitter = spec.jitter ?? 7;
  const grid = [];

  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      const lx = (c - (cols - 1) / 2) * cell + (rnd() - 0.5) * jitter * 2;
      const lz = (r - (rows - 1) / 2) * cell + (rnd() - 0.5) * jitter * 2;
      const n = addNode(world, cx + lx * cos - lz * sin, cz + lx * sin + lz * cos, 'city');
      n.district = id;
      grid[r][c] = n;
    }
  }

  const avenueRow = (r) => r === 0 || r === rows - 1 || r === (rows >> 1);
  const avenueCol = (c) => c === 0 || c === cols - 1 || c === (cols >> 1);

  // A few interior cells become parks: a bounding street is dropped so the block
  // merges with its neighbour and the grid stops reading as graph paper.
  const holes = new Set();
  const holeCount = spec.holes ?? Math.max(1, Math.round(cols * rows * 0.045));
  for (let h = 0; h < holeCount; h++) {
    const r = 1 + Math.floor(rnd() * Math.max(1, rows - 2));
    const c = 1 + Math.floor(rnd() * Math.max(1, cols - 2));
    holes.add(r * 100 + c);
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) {
        const skip = holes.has(r * 100 + c) && !avenueRow(r) && rnd() < 0.55;
        if (!skip) addEdge(world, grid[r][c], grid[r][c + 1], avenueRow(r) ? 'avenue' : 'street');
      }
      if (r + 1 < rows) {
        const skip = holes.has(r * 100 + c) && !avenueCol(c) && rnd() < 0.55;
        if (!skip) addEdge(world, grid[r][c], grid[r + 1][c], avenueCol(c) ? 'avenue' : 'street');
      }
    }
  }

  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const n00 = grid[r][c], n11 = grid[r + 1][c + 1];
      const isHole = holes.has(r * 100 + c);
      world.blocks.push({
        cx: (n00.x + n11.x) / 2, cz: (n00.z + n11.z) / 2, rot,
        hx: cell / 2, hz: cell / 2, district: id,
        kind: isHole && rnd() < 0.6 ? 'park' : kind,
      });
    }
  }

  world.districts.push({
    id, name, cx, cz, rot, cols, rows, cell, kind,
    r: Math.max(cols, rows) * cell * 0.5,
  });
  return grid;
}

// ---------------------------------------------------------------------------
// Free-form roads
// ---------------------------------------------------------------------------

/** Catmull-Rom through control points, resampled at roughly `step` metres. */
function splineChain(ctrl, step) {
  const out = [];
  const n = ctrl.length;
  const P = (i) => ctrl[clamp(i, 0, n - 1)];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const steps = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  out.push({ x: ctrl[n - 1].x, z: ctrl[n - 1].z });
  return out;
}

/**
 * Lays a road along `ctrl`, splitting it into graph edges roughly `nodeEvery`
 * metres apart so traffic has somewhere to make decisions.
 */
function layRoad(world, ctrl, kind, opts = {}) {
  const step = opts.step ?? 9;
  const nodeEvery = opts.nodeEvery ?? 120;
  const pts = splineChain(ctrl, step);
  const startNode = opts.from ?? addNode(world, pts[0].x, pts[0].z, opts.kindNode ?? 'rural');
  const endNode = opts.to ?? null;

  let prev = startNode;
  let acc = [{ x: prev.x, z: prev.z }];
  let dist = 0;
  const made = [];

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    dist += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    const tail = acc[acc.length - 1];
    if (Math.hypot(p.x - tail.x, p.z - tail.z) > 0.05) acc.push({ x: p.x, z: p.z });
    const last = i === pts.length - 1;
    if (last && acc.length < 2) continue;
    if (dist >= nodeEvery || last) {
      const node = last && endNode ? endNode : addNode(world, p.x, p.z, opts.kindNode ?? 'rural');
      if (last && endNode) acc[acc.length - 1] = { x: endNode.x, z: endNode.z };
      const e = addEdge(world, prev, node, kind, acc.slice());
      if (e) made.push(e);
      prev = node;
      acc = [{ x: prev.x, z: prev.z }];
      dist = 0;
    }
  }
  return { edges: made, from: startNode, to: prev };
}

function nearestNode(world, x, z, filter) {
  let best = null, bd = Infinity;
  for (const n of world.nodes) {
    if (filter && !filter(n)) continue;
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

/** A wandering path from A to B: a straight line pushed around by noise. */
function wander(ax, az, bx, bz, amp, seed, segs = 7) {
  const rnd = mulberry(seed);
  const ctrl = [{ x: ax, z: az }];
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len, pz = dx / len;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    // Zero offset at both ends so the join to the ring or village is clean.
    const off = (rnd() * 2 - 1) * amp * Math.sin(t * Math.PI);
    ctrl.push({ x: ax + dx * t + px * off, z: az + dz * t + pz * off });
  }
  ctrl.push({ x: bx, z: bz });
  return ctrl;
}

/**
 * How much of a proposed path would sit on top of roads that already exist.
 *
 * Two carriageways occupying the same ground without sharing a junction is not
 * a road network — it is two contradictory answers to "how high is the tarmac
 * here". Far cheaper to not lay the road than to reconcile it afterwards. The
 * ends are ignored, since a new road is meant to meet the network there.
 */
function pathOverlapFraction(world, ctrl, width) {
  const pts = splineChain(ctrl, 12);
  const skip = Math.max(1, Math.round(pts.length * 0.15));
  let hits = 0, tested = 0;
  for (let i = skip; i < pts.length - skip; i++) {
    const p = pts[i];
    tested++;
    let hit = false;
    for (const e of world.edges) {
      if (!e.pts) continue;
      const hw = (width + e.width) * 0.5 * 0.95;
      for (let k = 0; k < e.pts.length; k++) {
        const q = e.pts[k];
        if (Math.abs(p.x - q.x) < hw && Math.abs(p.z - q.z) < hw) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) hits++;
  }
  return tested ? hits / tested : 0;
}

/**
 * The best place to put a gravel waypoint within `radius` of (cx, cz): high
 * ground, but on a shelf rather than on a knife edge.
 *
 * Stages are routed through these instead of along straight lines, because a
 * road that ignores the relief reads as a line drawn on a map and the relief is
 * the whole point of an unpaved network. A golden-angle spiral samples the disc
 * evenly with no lattice artefacts, and 64 probes resolves terrain whose finest
 * feature is 145 m across.
 *
 * MEASURED: scoring on height alone puts junctions on the steepest ground
 * there is, which is exactly where the stamped height field cannot hold them —
 * gravel nodes sitting on 40% slopes missed their designed height by up to
 * 1.77 m. SHELF_PENALTY is in metres per radian of slope, so it trades a summit
 * for a shelf a few metres lower; at 70 the stages still climb 6.2 m per 100 m
 * against the dirt tracks' 5.4, and the junctions that miss their designed
 * height by over 25 cm drop from six to three.
 */
const SHELF_PENALTY = 70;

function highPoint(terrain, cx, cz, radius, half, minR) {
  let bx = cx, bz = cz, best = -Infinity;
  for (let i = 0; i < 64; i++) {
    const r = radius * Math.sqrt((i + 0.5) / 64);
    const a = i * 2.39996323;
    const x = clamp(cx + Math.cos(a) * r, -half + 150, half - 150);
    const z = clamp(cz + Math.sin(a) * r, -half + 150, half - 150);
    if (Math.hypot(x, z) < minR) continue;
    const score = terrain.height(x, z) - SHELF_PENALTY * terrain.slope(x, z);
    if (score > best) { best = score; bx = x; bz = z; }
  }
  return { x: bx, z: bz };
}

/**
 * One gravel stage from (ax, az) to (bx, bz).
 *
 * Tries several wander seeds and keeps whichever sits on the least existing
 * tarmac, because out here the interesting line and the free line are rarely
 * the same one. Returns null rather than laying a stage down the middle of a
 * lane — callers carry on to the next waypoint instead of dead-ending.
 *
 * Amplitude is set from the control-point SPACING, not from the leg length,
 * which is what fixes the corner radius. wander() offsets each control point
 * independently, so the sharpest heading change it can produce is roughly
 * atan(2 * amp / spacing); at 0.62 that is a corner tighter than any tarmac in
 * the world and still short of folding the spline back through itself. Scaling
 * off the leg instead gives a short leg a hairpin and a long one a straight.
 */
function layGravel(world, ax, az, bx, bz, seed, opts = {}) {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 90) return null;
  const segs = clamp(Math.round(len / 105), 5, 12);
  const amp = clamp((len / segs) * 0.62, 35, 130);
  let best = null, bestOverlap = Infinity;
  for (let a = 0; a < 6; a++) {
    // Each retry straightens a little. A blocked line is usually blocked by
    // something the wander swung into, so the fallback is a calmer route.
    const c = wander(ax, az, bx, bz, amp * (1 - a * 0.13), seed + a * 6151, segs);
    const ov = pathOverlapFraction(world, c, ROAD.gravel.width);
    if (ov < bestOverlap) { bestOverlap = ov; best = c; }
    if (ov < 0.06) break;
  }
  if (bestOverlap > 0.15) return null;
  return layRoad(world, best, 'gravel', {
    step: 7, nodeEvery: opts.nodeEvery ?? 125, kindNode: 'gravel',
    from: opts.from, to: opts.to,
  });
}

/**
 * Ensures every edge carries an (x, z) polyline. Lattice edges are created
 * without one because they are straight lines between two nodes, but crossing
 * resolution and elevation both need real vertices to work with.
 */
function ensurePolylines(world) {
  for (const e of world.edges) {
    if (e.pts && e.pts.length >= 2) continue;
    const A = world.nodes[e.a], B = world.nodes[e.b];
    const n = Math.max(2, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 12));
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push({ x: lerp(A.x, B.x, t), z: lerp(A.z, B.z, t) });
    }
    e.pts = pts;
  }
}

// ---------------------------------------------------------------------------
// Crossings
// ---------------------------------------------------------------------------

/** Proper intersection of two 2D segments, or null. Shared endpoints excluded. */
function segCross(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x, d1z = a2.z - a1.z;
  const d2x = b2.x - b1.x, d2z = b2.z - b1.z;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2z - (b1.z - a1.z) * d2x) / den;
  const u = ((b1.x - a1.x) * d1z - (b1.z - a1.z) * d1x) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { t, u, x: a1.x + d1x * t, z: a1.z + d1z * t };
}

function polyAt(pts, pos) {
  const k = Math.min(pts.length - 2, Math.max(0, Math.floor(pos)));
  const t = pos - k;
  return { x: lerp(pts[k].x, pts[k + 1].x, t), z: lerp(pts[k].z, pts[k + 1].z, t) };
}

/** Sub-polyline between two fractional vertex indices. */
function slicePoly(pts, p0, p1) {
  const out = [polyAt(pts, p0)];
  for (let k = Math.ceil(p0); k <= Math.floor(p1); k++) {
    const tail = out[out.length - 1];
    if (Math.hypot(pts[k].x - tail.x, pts[k].z - tail.z) > 0.05) {
      out.push({ x: pts[k].x, z: pts[k].z });
    }
  }
  const end = polyAt(pts, p1), tail = out[out.length - 1];
  if (Math.hypot(end.x - tail.x, end.z - tail.z) > 0.05) out.push(end);
  else out[out.length - 1] = end;
  return out;
}

/**
 * Turns every place two roads pass through each other into a real junction.
 *
 * Without this the network has roads crossing at different elevations with no
 * connection between them, which breaks the world twice over: the ground query
 * has two irreconcilable heights at one point, and traffic has no way to turn
 * where the map plainly shows an intersection.
 *
 * Run after all roads are laid and before elevation is settled.
 */
function resolveCrossings(world) {
  const CELL = 64;
  const key = (cx, cz) => cx * 100003 + cz;
  const grid = new Map();
  for (const e of world.edges) {
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const a = e.pts[k], b = e.pts[k + 1];
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(a.z, b.z) / CELL); cz <= Math.floor(Math.max(a.z, b.z) / CELL); cz++) {
          const kk = key(cx, cz);
          let L = grid.get(kk);
          if (!L) grid.set(kk, (L = []));
          L.push(e.i * 4096 + k);
        }
      }
    }
  }

  const cuts = new Map();
  const seen = new Set();
  const addCut = (ei, pos, node) => {
    let L = cuts.get(ei);
    if (!L) cuts.set(ei, (L = []));
    L.push({ pos, node });
  };

  for (const L of grid.values()) {
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const ei = (L[i] / 4096) | 0, ki = L[i] % 4096;
        const ej = (L[j] / 4096) | 0, kj = L[j] % 4096;
        if (ei === ej) continue;
        const A = world.edges[ei], B = world.edges[ej];
        if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const sid = ei < ej ? `${ei}.${ki}.${ej}.${kj}` : `${ej}.${kj}.${ei}.${ki}`;
        if (seen.has(sid)) continue;
        seen.add(sid);
        const p = segCross(A.pts[ki], A.pts[ki + 1], B.pts[kj], B.pts[kj + 1]);
        if (!p) continue;

        // A crossing landing on an existing junction should join to that node,
        // not cut a useless stub off the end of an edge — that is what leaves
        // T-junctions silently unconnected.
        const near = (ni) => {
          const nd = world.nodes[ni];
          return Math.hypot(nd.x - p.x, nd.z - p.z) < 7 ? nd : null;
        };
        const endA = near(A.a) || near(A.b);
        const endB = near(B.a) || near(B.b);
        if (endA && endB) continue;
        const node = endA || endB || addNode(world, p.x, p.z, 'junction');
        if (!endA) addCut(ei, ki + p.t, node);
        if (!endB) addCut(ej, kj + p.u, node);
      }
    }
  }
  if (!cuts.size) return 0;

  const pieces = [];
  let splits = 0;
  for (const e of world.edges) {
    const L = cuts.get(e.i);
    const n = e.pts.length - 1;
    const keep = [];
    if (L) {
      L.sort((a, b) => a.pos - b.pos);
      for (const c of L) {
        if (c.pos < 0.3 || c.pos > n - 0.3) continue;
        if (keep.length && c.pos - keep[keep.length - 1].pos < 0.3) continue;
        keep.push(c);
      }
    }
    if (!keep.length) { pieces.push({ a: e.a, b: e.b, kind: e.kind, pts: e.pts }); continue; }
    let from = e.a, pos = 0;
    for (const c of keep) {
      pieces.push({ a: from, b: c.node.i, kind: e.kind, pts: slicePoly(e.pts, pos, c.pos) });
      from = c.node.i; pos = c.pos; splits++;
    }
    pieces.push({ a: from, b: e.b, kind: e.kind, pts: slicePoly(e.pts, pos, n) });
  }

  world.edges.length = 0;
  for (const nd of world.nodes) nd.edges.length = 0;
  for (const p of pieces) {
    if (p.pts.length < 2) continue;
    addEdge(world, world.nodes[p.a], world.nodes[p.b], p.kind, p.pts);
  }

  // Drop crossing nodes that ended up unused, then reindex. An orphan node
  // would sit in the middle of a road claiming terrain height.
  const kept = world.nodes.filter((nd) => nd.edges.length > 0);
  if (kept.length !== world.nodes.length) {
    const remap = new Map();
    kept.forEach((nd, i) => remap.set(nd.i, i));
    for (const e of world.edges) { e.a = remap.get(e.a); e.b = remap.get(e.b); }
    kept.forEach((nd, i) => { nd.i = i; });
    world.nodes = kept;
  }
  world.ringNodes = world.nodes.filter((nd) => nd.kind === 'ring').map((nd) => nd.i);
  return splits;
}

/**
 * Subdivides every edge polyline so no segment is longer than `maxSeg`.
 *
 * Splitting at crossings leaves short two-point pieces, and a two-point polyline
 * has no interior vertex — which means the gradient cap has nothing it is
 * allowed to move, and the piece keeps whatever slope its endpoints imply.
 */
function densify(world, maxSeg = 8) {
  for (const e of world.edges) {
    const src = e.pts;
    const out = [{ x: src[0].x, z: src[0].z }];
    for (let k = 1; k < src.length; k++) {
      const a = src[k - 1], b = src[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / maxSeg));
      for (let q = 1; q <= n; q++) {
        const t = q / n;
        out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
      }
    }
    e.pts = out;
  }
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/** Redistributes excess slope along one polyline, leaving the ends pinned. */
function capGrade(pts, maxGrade, iterations) {
  const n = pts.length - 1;
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let k = 1; k <= n; k++) {
      const d = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z) || 1e-3;
      const g = (pts[k].y - pts[k - 1].y) / d;
      if (Math.abs(g) <= maxGrade + 1e-4) continue;
      const excess = (Math.abs(g) - maxGrade) * d * Math.sign(g);
      const canLo = k - 1 > 0, canHi = k < n;
      if (!canLo && !canHi) continue;   // both ends pinned: nothing to give
      if (canLo && canHi) { pts[k].y -= excess * 0.5; pts[k - 1].y += excess * 0.5; }
      else if (canHi) pts[k].y -= excess;
      else pts[k - 1].y += excess;
      changed = true;
    }
    if (!changed) return true;
  }
  return false;
}

/**
 * Reconciles the heights of roads whose carriageways overlap.
 *
 * Roads that merge or run alongside each other without sharing a node end up
 * specifying two different heights for one piece of tarmac. No amount of
 * cleverness downstream can drive on both, and blending them produces exactly
 * the sudden ramp this whole layer exists to avoid. So it is settled here,
 * while the roads are still editable.
 */
function reconcileOverlaps(world) {
  const CELL = 24;
  const key = (cx, cz) => cx * 100003 + cz;
  const grid = new Map();
  const verts = [];
  for (const e of world.edges) {
    const hw = e.width / 2, last = e.pts.length - 1;
    for (let k = 0; k <= last; k++) {
      const v = { e, k, hw, pinned: k === 0 || k === last, i: verts.length };
      verts.push(v);
      const p = e.pts[k];
      const kk = key(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      let L = grid.get(kk);
      if (!L) grid.set(kk, (L = []));
      L.push(v);
    }
  }

  // Pair up overlapping vertices once; geometry never moves, only height.
  const pairs = [];
  for (const v of verts) {
    const p = v.e.pts[v.k];
    const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const L = grid.get(key(cx + a, cz + b));
        if (!L) continue;
        for (const o of L) {
          if (o.i <= v.i || o.e === v.e) continue;
          const q = o.e.pts[o.k];
          const d = Math.hypot(p.x - q.x, p.z - q.z);
          if (d < v.hw + o.hw) pairs.push([v, o, 1 - d / (v.hw + o.hw)]);
        }
      }
    }
  }
  if (!pairs.length) return 0;

  const adj = new Float64Array(verts.length);
  const cnt = new Float64Array(verts.length);

  // Reconciliation pulls overlapping roads together; the gradient cap pushes
  // steep sections apart. Run in sequence they undo each other, so alternate:
  // each pass gives a little ground to the other and the pair converges.
  for (let outer = 0; outer < 14; outer++) {
    for (let it = 0; it < 6; it++) {
      adj.fill(0); cnt.fill(0);
      for (const [v, o, w] of pairs) {
        const yv = v.e.pts[v.k].y, yo = o.e.pts[o.k].y;
        const mid = (yv + yo) * 0.5;
        adj[v.i] += (mid - yv) * w; cnt[v.i] += w;
        adj[o.i] += (mid - yo) * w; cnt[o.i] += w;
      }
      for (const v of verts) {
        if (v.pinned || !cnt[v.i]) continue;   // junction ends stay put
        v.e.pts[v.k].y += (adj[v.i] / cnt[v.i]) * 0.6;
      }
    }
    for (const e of world.edges) {
      const pts = e.pts, n = pts.length - 1;
      for (let k = 1; k < n; k++) pts[k].y = (pts[k - 1].y + pts[k].y * 2 + pts[k + 1].y) / 4;
      capGrade(pts, gradeCap(e.kind), 120);
    }
  }
  return pairs.length;
}

function settleElevation(world, terrain) {
  for (const n of world.nodes) n.y = terrain.height(n.x, n.z);

  // Relax node heights toward their neighbours. Real roads are graded; without
  // this a lattice over rolling ground gives junctions that are little ramps.
  const acc = new Float64Array(world.nodes.length);
  for (let pass = 0; pass < 26; pass++) {
    for (let i = 0; i < world.nodes.length; i++) {
      const n = world.nodes[i];
      let sum = n.y, cnt = 1;
      for (const ei of n.edges) {
        const e = world.edges[ei];
        const o = world.nodes[e.a === i ? e.b : e.a];
        const w = e.kind === 'street' || e.kind === 'avenue' ? 1.0 : 0.45;
        sum += o.y * w; cnt += w;
      }
      // City streets are graded flat; country lanes keep hugging the ground,
      // which is what keeps the cut-and-fill small enough to blend away later.
      const k = n.kind === 'city' ? 0.85 : 0.18;
      acc[i] = lerp(n.y, lerp(sum / cnt, terrain.height(n.x, n.z), 1 - k), 0.65);
    }
    for (let i = 0; i < world.nodes.length; i++) world.nodes[i].y = acc[i];
  }

  // Bound the node heights themselves. A short edge between two nodes 4 m apart
  // in height is a wall that no amount of polyline shaping can rescue.
  for (let it = 0; it < 200; it++) {
    let worst = 0;
    for (const e of world.edges) {
      const A = world.nodes[e.a], B = world.nodes[e.b];
      const d = Math.hypot(B.x - A.x, B.z - A.z);
      if (d < 1e-3) continue;
      const cap = nodeCap(e.kind) * d;
      const dy = B.y - A.y;
      const over = Math.abs(dy) - cap;
      if (over <= 0) continue;
      worst = Math.max(worst, over);
      const fix = Math.sign(dy) * over * 0.5;
      A.y += fix; B.y -= fix;
    }
    if (worst < 0.005) break;
  }

  for (const e of world.edges) {
    const A = world.nodes[e.a], B = world.nodes[e.b];
    const pts = e.pts, n = pts.length - 1;
    for (let k = 0; k <= n; k++) {
      const t = n === 0 ? 0 : k / n;
      const grade = lerp(A.y, B.y, t);
      const terr = terrain.height(pts[k].x, pts[k].z);
      const follow = FOLLOW[e.kind] ?? 0.30;
      // Taper to the exact node heights at both ends or junctions will step.
      const endLock = Math.min(1, Math.min(t, 1 - t) * 6);
      pts[k].y = lerp(grade, lerp(grade, terr, follow), endLock);
    }
    for (let p = 0; p < 5; p++) {
      for (let k = 1; k < n; k++) pts[k].y = (pts[k - 1].y + pts[k].y * 2 + pts[k + 1].y) / 4;
    }
    capGrade(pts, gradeCap(e.kind), 600);
  }

  world.overlapPairs = reconcileOverlaps(world);

  // Arc length last: reconciliation changes heights, never positions, but the
  // length table has to exist before anything samples an edge.
  for (const e of world.edges) {
    const pts = e.pts;
    let s = 0;
    pts[0].s = 0;
    for (let k = 1; k < pts.length; k++) {
      s += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      pts[k].s = s;
    }
    e.length = s;
  }
}

// ---------------------------------------------------------------------------
// Sampling an edge
// ---------------------------------------------------------------------------

/** Position, height, tangent and left-normal at arc length `s` along an edge. */
export function pointOnEdge(e, s) {
  const pts = e.pts;
  if (!pts || pts.length < 2) return null;
  s = clamp(s, 0, e.length);
  let lo = 0, hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[lo + 1];
  const seg = Math.max(1e-4, b.s - a.s);
  const t = (s - a.s) / seg;
  const dx = (b.x - a.x) / seg, dz = (b.z - a.z) / seg;
  return {
    x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), y: lerp(a.y, b.y, t),
    tx: dx, tz: dz, nx: -dz, nz: dx,
  };
}

// ---------------------------------------------------------------------------
// Lots and props
// ---------------------------------------------------------------------------

const SIDEWALK = 4.2;

/** Do two oriented rectangles overlap? Separating-axis test, four axes. */
function lotsOverlap(a, b, shrink) {
  const ac = Math.cos(a.rot), as = Math.sin(a.rot);
  const bc = Math.cos(b.rot), bs = Math.sin(b.rot);
  const ahw = a.w * 0.5 * shrink, ahd = a.d * 0.5 * shrink;
  const bhw = b.w * 0.5 * shrink, bhd = b.d * 0.5 * shrink;
  const dx = b.x - a.x, dz = b.z - a.z;
  const axes = [ac, as, -as, ac, bc, bs, -bs, bc];
  for (let i = 0; i < 8; i += 2) {
    const nx = axes[i], nz = axes[i + 1];
    const dist = Math.abs(dx * nx + dz * nz);
    const ra = ahw * Math.abs(ac * nx + as * nz) + ahd * Math.abs(-as * nx + ac * nz);
    const rb = bhw * Math.abs(bc * nx + bs * nz) + bhd * Math.abs(-bs * nx + bc * nz);
    if (dist > ra + rb) return false;
  }
  return true;
}

function buildLots(world, rnd, ground) {
  for (const block of world.blocks) {
    const fromCore = Math.hypot(block.cx, block.cz);
    const cos = Math.cos(block.rot), sin = Math.sin(block.rot);

    if (block.kind === 'park') {
      const n = 8 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const lx = (rnd() - 0.5) * block.hx * 1.6, lz = (rnd() - 0.5) * block.hz * 1.6;
        world.props.push({
          type: 'tree',
          x: block.cx + lx * cos - lz * sin,
          z: block.cz + lx * sin + lz * cos,
          rot: rnd() * 6.283, scale: 0.8 + rnd() * 0.9, variant: (rnd() * 3) | 0,
        });
      }
      continue;
    }

    // Reserve for the WIDEST road that could bound this block, plus the node
    // jitter that moves it. Sizing off ROAD.street means every block bounded by
    // an avenue (21 m against a street's 13.5 m) puts its buildings 3.75 m into
    // the carriageway before the lattice has even been jittered — which is how
    // half the city ended up standing in the road.
    const reserve = ROAD.avenue.width / 2 + SIDEWALK + 8;
    const iw = block.hx - reserve;
    const id = block.hz - reserve;
    if (iw < 8 || id < 8) continue;

    const coreT = 1 - smoothstep(120, 900, fromCore);
    const place = (lx, lz, w, d, rot2, kind, height) => {
      world.lots.push({
        x: block.cx + lx * cos - lz * sin,
        z: block.cz + lx * sin + lz * cos,
        w, d, rot: block.rot + rot2, kind, height,
        district: block.district, seed: (rnd() * 1e9) | 0,
      });
    };

    if (block.kind === 'downtown') {
      const towers = rnd() < 0.55 ? 1 : 2;
      for (let t = 0; t < towers; t++) {
        const w = iw * (towers === 1 ? 1.55 : 0.7);
        const lx = towers === 1 ? 0 : (t === 0 ? -iw * 0.44 : iw * 0.44);
        place(lx, 0, w, id * 1.55, 0, 'tower', (34 + coreT * 145) * (0.45 + rnd() * 1.15));
      }
    } else if (block.kind === 'industrial') {
      const sheds = 1 + ((rnd() * 2) | 0);
      for (let t = 0; t < sheds; t++) {
        const span = iw * 1.7 / sheds;
        place((t - (sheds - 1) / 2) * span, 0, span * 0.86, id * 1.4, 0, 'warehouse', 9 + rnd() * 12);
      }
    } else {
      // Perimeter buildings around a courtyard, one row per block edge.
      for (const row of [{ ax: 1, sign: -1 }, { ax: 1, sign: 1 }, { ax: 0, sign: -1 }, { ax: 0, sign: 1 }]) {
        const along = row.ax === 1 ? iw : id;
        const depth = 11 + rnd() * 7;
        const off = (row.ax === 1 ? id : iw) - depth / 2;
        // The rows running along Z stop short of the corners, because the rows
        // running along X already occupy them. Without this every block corner
        // has two buildings inside each other, and an intersecting pair makes a
        // wedge the collision solver cannot push a car out of.
        const inset = row.ax === 1 ? 0 : 19;
        let cursor = -along + inset;
        while (cursor < along - inset - 8) {
          const useW = Math.min(9 + rnd() * 16, along - inset - cursor);
          if (useW < 7) break;
          const mid = cursor + useW / 2;
          const h = block.kind === 'midtown' ? 12 + rnd() * (18 + coreT * 34) : 6 + rnd() * 5.5;
          if (rnd() > 0.08) {
            place(
              row.ax === 1 ? mid : row.sign * off,
              row.ax === 1 ? row.sign * off : mid,
              row.ax === 1 ? useW : depth,
              row.ax === 1 ? depth : useW,
              row.ax === 1 ? 0 : Math.PI / 2,
              block.kind === 'suburb' ? 'house' : 'block', h,
            );
          }
          cursor += useW + 1.2 + rnd() * 3;
        }
      }
    }
  }
  // Cull anything standing in the road.
  //
  // Blocks are sized from the district lattice, but the nodes are jittered and
  // the roads that actually run past them are not always the width assumed when
  // the block was laid out — an avenue is 21 m where a street is 13.5 m, and the
  // ring highway and country lanes cut across districts entirely. The result is
  // buildings in the middle of the carriageway, which is both absurd to look at
  // and the reason cars end up wedged inside walls. Cheaper to check afterwards
  // than to make the lattice clairvoyant.
  if (ground) {
    const clear = [];
    for (const lot of world.lots) {
      const cos = Math.cos(lot.rot), sin = Math.sin(lot.rot);
      const hw = lot.w / 2, hd = lot.d / 2;
      // Sample a grid across the whole footprint, not just the corners: a lane
      // can cut clean through the middle of a long terrace while every corner
      // sits happily on grass.
      let blocked = false;
      const N = 5;
      for (let a = 0; a < N && !blocked; a++) {
        for (let b = 0; b < N && !blocked; b++) {
          const lx = (a / (N - 1) * 2 - 1) * hw;
          const lz = (b / (N - 1) * 2 - 1) * hd;
          const x = lot.x + lx * cos - lz * sin;
          const z = lot.z + lx * sin + lz * cos;
          const road = ground.roadAt(x, z);
          if (road.edge && road.dist < road.width * 0.5 + 1.4) blocked = true;
        }
      }
      if (!blocked) clear.push(lot);
    }
    world.lotsCulled = world.lots.length - clear.length;
    world.lots = clear;
  }

  // Buildings must not intersect each other.
  //
  // Perimeter rows on adjacent block edges overlap at the corners, and two
  // overlapping boxes make a wedge with no way out: the collision solver pushes
  // the car clear of one wall directly into the other, forever. Cheaper to
  // guarantee the invariant here than to make the solver cope with geometry
  // that should not exist.
  {
    const CELLSZ = 40;
    const hash = new Map();
    const hkey = (cx, cz) => cx * 100003 + cz;
    const kept = [];
    for (const lot of world.lots) {
      const r = Math.hypot(lot.w, lot.d) * 0.5;
      const cx0 = Math.floor((lot.x - r) / CELLSZ), cx1 = Math.floor((lot.x + r) / CELLSZ);
      const cz0 = Math.floor((lot.z - r) / CELLSZ), cz1 = Math.floor((lot.z + r) / CELLSZ);
      let clash = false;
      for (let cx = cx0; cx <= cx1 && !clash; cx++) {
        for (let cz = cz0; cz <= cz1 && !clash; cz++) {
          const L = hash.get(hkey(cx, cz));
          if (!L) continue;
          for (const other of L) if (lotsOverlap(lot, other, 0.97)) { clash = true; break; }
        }
      }
      if (clash) continue;
      kept.push(lot);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = hkey(cx, cz);
          let L = hash.get(k);
          if (!L) hash.set(k, (L = []));
          L.push(lot);
        }
      }
    }
    world.lotsOverlapping = world.lots.length - kept.length;
    world.lots = kept;
  }

  for (const lot of world.lots) lot.y = world.terrain.height(lot.x, lot.z);
}

function buildProps(world, rnd, ground) {
  const terrain = world.terrain;

  // Street lighting along city roads.
  for (const e of world.edges) {
    if (LOOSE[e.kind]) continue;
    const spacing = e.kind === 'highway' ? 46 : e.kind === 'rural' ? 90 : 32;
    const n = Math.max(1, Math.round(e.length / spacing));
    for (let k = 1; k < n; k++) {
      if (e.kind === 'rural' && rnd() < 0.55) continue;
      const p = pointOnEdge(e, (k / n) * e.length);
      if (!p) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const off = e.width / 2 + 1.6;
      world.props.push({
        type: e.kind === 'rural' ? 'polelight' : 'streetlight',
        x: p.x + p.nx * off * side, z: p.z + p.nz * off * side, y: p.y,
        rot: Math.atan2(-p.nx * side, -p.nz * side),
        scale: e.kind === 'highway' ? 1.35 : 1,
      });
    }
  }

  // Trees: clumped by a density mask, hugging the lanes as hedgerows, never on
  // the carriageway.
  for (let i = 0; i < 26000; i++) {
    const x = (rnd() * 2 - 1) * world.half, z = (rnd() * 2 - 1) * world.half;
    if (Math.hypot(x, z) < terrain.cityRadius * 0.92) continue;
    const road = ground.roadAt(x, z);
    if (road.onRoad || road.dist < 9) continue;
    const g = ground.sample(x, z);
    if (g.surface === 'rock' || g.surface === 'sand') continue;
    if (terrain.slope(x, z) > 0.55) continue;
    const dens = fbm(x / 260, z / 260, world.seed + 55, 3);
    const near = smoothstep(120, 26, road.dist);
    if (rnd() > clamp(dens * 0.55 + 0.12 + near * 0.35, 0, 1)) continue;
    world.props.push({
      type: 'tree', x, z, y: g.y,
      rot: rnd() * 6.283, scale: 0.85 + rnd() * 1.5, variant: (rnd() * 3) | 0,
    });
  }

  // Rocks on the high ground.
  for (let i = 0; i < 2200; i++) {
    const x = (rnd() * 2 - 1) * world.half, z = (rnd() * 2 - 1) * world.half;
    if (Math.hypot(x, z) < terrain.cityRadius) continue;
    const road = ground.roadAt(x, z);
    if (road.onRoad || road.dist < 7) continue;
    if (terrain.slope(x, z) < 0.28 && rnd() < 0.7) continue;
    world.props.push({
      type: 'rock', x, z, y: ground.sample(x, z).y,
      rot: rnd() * 6.283, scale: 0.6 + rnd() * 2.2, variant: (rnd() * 3) | 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildWorld(seed = 20260820) {
  const rnd = mulberry(seed);
  const terrain = makeTerrain(seed);
  const world = {
    seed, half: HALF, terrain,
    nodes: [], edges: [], blocks: [], lots: [], props: [], districts: [], villages: [],
  };

  // --- City districts -----------------------------------------------------
  buildDistrict(world, rnd, { id: 'downtown', name: 'Kestrel Downtown', cx: 0, cz: 0, rot: 0, cols: 8, rows: 8, cell: 118, kind: 'downtown', holes: 3 });
  buildDistrict(world, rnd, { id: 'oldquarter', name: 'Verrand Old Quarter', cx: -760, cz: 610, rot: 0.54, cols: 6, rows: 6, cell: 96, kind: 'midtown', holes: 2, jitter: 5 });
  buildDistrict(world, rnd, { id: 'harbourside', name: 'Harbourside Works', cx: 830, cz: -690, rot: -0.22, cols: 5, rows: 5, cell: 168, kind: 'industrial', holes: 1, jitter: 9 });
  buildDistrict(world, rnd, { id: 'westmere', name: 'Westmere', cx: -820, cz: -640, rot: 0.11, cols: 6, rows: 5, cell: 132, kind: 'suburb', holes: 2 });
  buildDistrict(world, rnd, { id: 'eastgate', name: 'Eastgate', cx: 880, cz: 700, rot: -0.38, cols: 5, rows: 6, cell: 140, kind: 'suburb', holes: 2 });

  // --- Ring highway: superellipse, straights on the flanks ----------------
  const RX = 1340, RZ = 1250;
  const ringCtrl = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a), k = 4.0;
    const denom = Math.pow(Math.pow(Math.abs(ca), k) + Math.pow(Math.abs(sa), k), 1 / k);
    ringCtrl.push({ x: (RX * ca) / denom, z: (RZ * sa) / denom });
  }
  ringCtrl.push({ x: ringCtrl[0].x, z: ringCtrl[0].z });
  const ringStart = addNode(world, ringCtrl[0].x, ringCtrl[0].z, 'ring');
  // `to` is the node we started from, so the final edge closes the loop. Adding
  // a separate closing edge would join two coincident nodes and produce a
  // zero-length segment with a vertical gradient.
  layRoad(world, ringCtrl, 'highway', {
    step: 11, nodeEvery: 165, kindNode: 'ring', from: ringStart, to: ringStart,
  });
  world.ringNodes = world.nodes.filter((n) => n.kind === 'ring').map((n) => n.i);

  const ringAt = (angle) => {
    let best = null, bd = Infinity;
    for (const i of world.ringNodes) {
      const n = world.nodes[i];
      const da = Math.abs(((Math.atan2(n.z, n.x) - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (da < bd) { bd = da; best = n; }
    }
    return best;
  };

  // --- Links from the ring into each district ------------------------------
  for (const t of [
    { x: 0, z: -430 }, { x: 0, z: 430 }, { x: -450, z: 0 }, { x: 450, z: 0 },
    { x: -760, z: 610 }, { x: 830, z: -690 }, { x: -820, z: -640 }, { x: 880, z: 700 },
  ]) {
    const city = nearestNode(world, t.x, t.z, (n) => n.kind === 'city');
    if (!city) continue;
    const from = ringAt(Math.atan2(city.z, city.x));
    if (!from) continue;
    layRoad(world, wander(from.x, from.z, city.x, city.z, 55, seed + city.i * 31, 4),
      'link', { step: 10, nodeEvery: 150, from, to: city, kindNode: 'link' });
  }

  // --- Villages out in the country ----------------------------------------
  const villageSpecs = [
    { name: 'Marrowfield', x: -1620, z: 1560, cols: 4, rows: 3, cell: 92, rot: 0.28 },
    { name: 'Culver Bend', x: 1700, z: 1480, cols: 3, rows: 3, cell: 88, rot: -0.42 },
    { name: 'Ashcombe', x: -1580, z: -1590, cols: 3, rows: 4, cell: 86, rot: 0.62 },
    { name: 'Thornhollow', x: 1560, z: -1600, cols: 3, rows: 3, cell: 90, rot: -0.15 },
  ];
  for (const v of villageSpecs) {
    buildDistrict(world, rnd, {
      id: 'v_' + v.name, name: v.name, cx: v.x, cz: v.z, rot: v.rot,
      cols: v.cols, rows: v.rows, cell: v.cell, kind: 'suburb', holes: 1, jitter: 10,
    });
    world.villages.push({ name: v.name, x: v.x, z: v.z });
  }
  const villNode = (v) => nearestNode(world, v.x, v.z, (n) => n.district === 'v_' + v.name);

  // --- Country lanes: ring -> village, and village -> village --------------
  for (const v of villageSpecs) {
    const from = ringAt(Math.atan2(v.z, v.x)), to = villNode(v);
    if (!from || !to) continue;
    layRoad(world, wander(from.x, from.z, to.x, to.z, 150, seed + v.x, 8),
      'rural', { step: 9, nodeEvery: 130, from, to });
  }
  for (let i = 0; i < villageSpecs.length; i++) {
    const from = villNode(villageSpecs[i]);
    const to = villNode(villageSpecs[(i + 1) % villageSpecs.length]);
    if (!from || !to) continue;
    layRoad(world, wander(from.x, from.z, to.x, to.z, 170, seed + i * 977, 9),
      'rural', { step: 9, nodeEvery: 140, from, to });
  }

  // --- Gravel rally stages -------------------------------------------------
  //
  // An unpaved outer perimeter, laid out where the ridged spines are: four long
  // stages joining the villages the long way round, loops up over the high
  // ground hanging off them, and ties back into the lanes. It is a network
  // rather than the handful of spurs the dirt tracks amount to, so it is
  // somewhere to go, and every leg is routed through a high point rather than
  // between them, so it climbs on the way.
  //
  // Polylines must exist before the overlap test can see the lattice roads.
  ensurePolylines(world);

  // A private stream, so that laying gravel consumes no draw from the shared
  // `rnd` and the dirt tracks, building lots and tree scatter keep their own
  // sequence.
  //
  // That is not the same as leaving them untouched, and the difference was
  // measured. The dirt-track loop below retries until pathOverlapFraction()
  // accepts a route, and that test now sees 21.5 km of gravel it did not see
  // before: more attempts are refused, each refusal costs three more draws from
  // `rnd`, and the tracks that survive are laid somewhere else. Dirt falls from
  // 7.23 km to 5.70 km, and everything drawn from `rnd` afterwards shifts with
  // it. Deterministic for a given seed either way — just not the same world.
  const grnd = mulberry((seed ^ 0x6a71e5) >>> 0);
  let stageSeed = seed + 7700;

  // Villages sorted by bearing, so consecutive pairs are neighbours round the
  // perimeter rather than opposite corners. The paved village-to-village lanes
  // already take the two diagonals straight through the middle of the map; a
  // gravel stage laid along one of those is not a stage, it is a duplicate.
  const rally = villageSpecs.slice().sort((p, q) => Math.atan2(p.z, p.x) - Math.atan2(q.z, q.x));
  const EDGE_KEEP = world.half - 180;

  for (let i = 0; i < rally.length; i++) {
    const A = rally[i], B = rally[(i + 1) % rally.length];

    // Waypoints are pushed radially outward FIRST and snapped to the local high
    // ground SECOND. Snapping a point that still sits on the straight line only
    // finds the highest bump on that line, which yields a straight road with a
    // hill on it rather than a route that goes somewhere.
    const chain = [];
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      const mx = lerp(A.x, B.x, t), mz = lerp(A.z, B.z, t);
      const rad = Math.hypot(mx, mz) || 1;
      const push = 250 + grnd() * 200;
      chain.push(highPoint(terrain,
        clamp(mx + (mx / rad) * push, -EDGE_KEEP, EDGE_KEEP),
        clamp(mz + (mz / rad) * push, -EDGE_KEEP, EDGE_KEEP),
        210, world.half, terrain.cityRadius + 320));
    }

    // Join each village on the side the stage actually arrives from, rather
    // than at the node nearest its centre the way the paved lanes do. Driving a
    // rally stage through the middle of a village means gravel meeting 21 m
    // avenues at right angles, which is both wrong to look at and the source of
    // half the junctions that fail to sit at their designed height.
    const first = chain[0], final = chain[chain.length - 1];
    const aNode = nearestNode(world, first.x, first.z, (n) => n.district === 'v_' + A.name);
    const bNode = nearestNode(world, final.x, final.z, (n) => n.district === 'v_' + B.name);
    if (!aNode || !bNode) continue;
    chain.push(bNode);

    let prev = aNode;
    for (let k = 0; k < chain.length; k++) {
      const last = k === chain.length - 1;
      const laid = layGravel(world, prev.x, prev.z, chain[k].x, chain[k].z,
        stageSeed += 977, { from: prev, to: last ? bNode : undefined });
      // A waypoint that cannot be reached without paving over a lane is simply
      // dropped and the stage carries on to the next one. Breaking the chain
      // there instead would leave the far half of the perimeter unreachable.
      if (laid) prev = laid.to;
    }
  }

  // Summit loops. The perimeter is the connective tissue; these are the reason
  // to leave it — up over a high point and back down to the perimeter somewhere
  // else, so the detour laps rather than dead-ends.
  const gravelNodes = world.nodes.filter((n) => n.kind === 'gravel');
  for (let i = 0; i < 9 && gravelNodes.length; i++) {
    const from = gravelNodes[Math.floor(grnd() * gravelNodes.length)];
    const a = grnd() * Math.PI * 2;
    const len = 300 + grnd() * 280;
    const tx = clamp(from.x + Math.cos(a) * len, -EDGE_KEEP, EDGE_KEEP);
    const tz = clamp(from.z + Math.sin(a) * len, -EDGE_KEEP, EDGE_KEEP);
    if (Math.hypot(tx, tz) < terrain.cityRadius + 340) continue;
    const top = highPoint(terrain, tx, tz, 230, world.half, terrain.cityRadius + 340);
    const climb = layGravel(world, from.x, from.z, top.x, top.z, stageSeed += 613,
      { from, nodeEvery: 100 });
    if (!climb) continue;
    // MEASURED: a road that simply stops is a road the height field struggles
    // to hold. A degree-1 node has carriageway on one side and open ground on
    // the other, so the membrane pulls it down — both of the gravel junctions
    // that missed their designed height by over 25 cm were dead ends.
    const back = nearestNode(world, climb.to.x, climb.to.z, (n) =>
      n !== climb.to && n !== from && n.kind === 'gravel' &&
      Math.hypot(n.x - climb.to.x, n.z - climb.to.z) > 260);
    if (back) {
      layGravel(world, climb.to.x, climb.to.z, back.x, back.z, stageSeed += 191,
        { from: climb.to, to: back, nodeEvery: 100 });
    }
  }

  // Ties back into the lanes. Four villages is not enough ways on: without
  // these the perimeter is a ring road for a place nobody drives to.
  for (let i = 0; i < 9 && gravelNodes.length; i++) {
    const from = gravelNodes[Math.floor(grnd() * gravelNodes.length)];
    const to = nearestNode(world, from.x, from.z, (n) =>
      n.kind === 'rural' && Math.hypot(n.x - from.x, n.z - from.z) > 300);
    if (!to) continue;
    layGravel(world, from.x, from.z, to.x, to.z, stageSeed += 421, { from, to });
  }

  // --- Dirt tracks up into the hills ---------------------------------------
  const ruralNodes = world.nodes.filter((n) => n.kind === 'rural');
  for (let i = 0; i < 9 && ruralNodes.length; i++) {
    const kind = i % 3 === 0 ? 'track' : 'dirt';
    // Try a few headings before giving up, so a blocked direction costs a track
    // rather than putting one on top of a lane.
    let ctrl = null, from = null;
    for (let attempt = 0; attempt < 6 && !ctrl; attempt++) {
      from = ruralNodes[Math.floor(rnd() * ruralNodes.length)];
      const a = rnd() * Math.PI * 2;
      const len = 320 + rnd() * 620;
      const tx = clamp(from.x + Math.cos(a) * len, -world.half + 90, world.half - 90);
      const tz = clamp(from.z + Math.sin(a) * len, -world.half + 90, world.half - 90);
      if (Math.hypot(tx, tz) < terrain.cityRadius + 260) continue;
      const c = wander(from.x, from.z, tx, tz, 190, seed + 3300 + i * 71 + attempt * 17, 7);
      if (pathOverlapFraction(world, c, ROAD[kind].width) < 0.12) ctrl = c;
    }
    if (!ctrl) continue;
    const laid = layRoad(world, ctrl, kind, { step: 8, nodeEvery: 110, from });
    // Half loop back to the network instead of dead-ending.
    if (rnd() < 0.55 && laid.to) {
      const back = nearestNode(world, laid.to.x, laid.to.z, (n) =>
        (n.kind === 'rural' || n.kind === 'city') && Math.hypot(n.x - laid.to.x, n.z - laid.to.z) > 220);
      if (back) {
        const c2 = wander(laid.to.x, laid.to.z, back.x, back.z, 150, seed + 4400 + i * 53, 6);
        if (pathOverlapFraction(world, c2, ROAD.dirt.width) < 0.15) {
          layRoad(world, c2, 'dirt', { step: 8, nodeEvery: 110, from: laid.to, to: back });
        }
      }
    }
  }

  ensurePolylines(world);
  world.crossingsResolved = resolveCrossings(world);
  densify(world);
  settleElevation(world, terrain);

  // Junctions with three or more approaches get stop/signal treatment.
  for (const n of world.nodes) {
    n.stop = n.edges.length >= 3;
    n.signal = n.stop && n.edges.some((ei) => {
      const k = world.edges[ei].kind;
      return k === 'avenue' || k === 'link' || k === 'highway';
    });
  }

  world.buildLots = (ground) => buildLots(world, rnd, ground);
  world.buildProps = (ground) => buildProps(world, rnd, ground);
  return world;
}
