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

import { fbm, ridged, valueNoise, hash2, mulberry, smoothstep, clamp, lerp } from './noise.js';
import { buildBiomes, setActiveBiomes, BIOMES } from './biomes.js';

export const ROAD = {
  highway: { width: 26.0, lanes: 2, speed: 39, surface: 'asphalt', markings: 'highway' },
  avenue:  { width: 21.0, lanes: 2, speed: 22, surface: 'asphalt', markings: 'avenue' },
  link:    { width: 17.0, lanes: 1, speed: 25, surface: 'asphalt', markings: 'avenue' },
  street:  { width: 13.5, lanes: 1, speed: 15, surface: 'asphalt', markings: 'street' },
  rural:   { width: 9.5,  lanes: 1, speed: 25, surface: 'asphalt', markings: 'rural' },
  gravel:  { width: 7.5,  lanes: 1, speed: 18, surface: 'gravel',  markings: 'none' },
  // Circuits. A race track has no centre line, and the speed figure here is
  // only what a traffic car would obey — traffic never routes onto one.
  circuit: { width: 12.0, lanes: 1, speed: 60, surface: 'asphalt', markings: 'none' },
  rallyx:  { width: 9.5,  lanes: 1, speed: 40, surface: 'gravel',  markings: 'none' },
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
export const GRADE_CAP = { gravel: 0.26, dirt: 0.26, track: 0.26, rallyx: 0.22, circuit: 0.12 };
/** The steepest gradient a road of this kind is shaped to. Exported so the
 *  harness measures against the same table the solver enforces — when the two
 *  drifted apart, 21.5 km of legitimately steep gravel read as a violation. */
export const gradeCap = (kind) => GRADE_CAP[kind] ?? 0.13;
/** True for loose surfaces, which are allowed a rougher centreline. */
export const isLoose = (kind) => kind === 'gravel' || kind === 'dirt' || kind === 'track' || kind === 'rallyx';

// The junction-to-junction cap, which must sit BELOW the polyline cap rather
// than merely near it. capGrade leaves both ends of a polyline pinned, so
// whatever gradient the two end nodes imply is the one gradient it is not
// allowed to redistribute — set the two equal and the polyline cap silently
// stops meaning anything.
const NODE_CAP = { gravel: 0.24, dirt: 0.24, track: 0.24, rallyx: 0.20, circuit: 0.105 };
const nodeCap = (kind) => NODE_CAP[kind] ?? 0.115;

// How closely a road's surface chases the bare terrain between its junctions.
// City roads are graded onto a shelf; country roads keep hugging the ground,
// which is what keeps the cut-and-fill small enough to blend away later.
// How closely each kind chases the bare terrain between its junctions.
//
// A circuit is BUILT, not draped. Grading it onto the landscape rather than
// letting it hug every fold is what makes a track read as engineered — and it
// is why a circuit can carry gentle, deliberate elevation change instead of
// the constant chatter a country lane picks up.
const FOLLOW = {
  rural: 0.92, dirt: 0.92, track: 0.92, gravel: 0.92,
  rallyx: 0.72, circuit: 0.66,
};

const HALF = 2048;
// There is no city. The field is kept because the HUD reads it, and zero is
// the honest value — anything else would carve a dead zone out of the middle
// of the map where nothing is allowed to grow.
const CITY_R = 0;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Bare ground elevation before roads flatten anything. Pure function of (x,z)
 * and the seed, C2 continuous, cheap enough to call every physics step.
 */
export function makeTerrain(seed) {
  const s = seed | 0;
  // The biome field (biomes.js), once buildWorld has made one: mountains,
  // mesas and the sea floor as heights added to this base, and the ground
  // cover each biome lays. Null until setRelief(), so the road layout and
  // the circuit siting see the base terrain they were tuned on.
  let field = null;

  function height(x, z) {
    const b = baseHeight(x, z);
    return field ? b + field.relief(x, z) : b;
  }

  function baseHeight(x, z) {
    const d = Math.hypot(x, z);

    // There is no city any more, and that changes the terrain more than
    // anything else here.
    //
    // The old shelf existed to keep a flat street grid from ending up metres in
    // the air, and it cost the whole middle of the map its relief. With nothing
    // but open roads, gravel stages and circuits to carry, the ground is free
    // to actually move — and the elevation solver grades the roads onto it
    // rather than the other way round.

    // Broad rolling country, everywhere, at real amplitude.
    const rolling = fbm(x / 760, z / 760, s + 17, 4) * 36;

    // Ridged spines rising into proper hills away from the middle. The basin in
    // the centre is shallow rather than flat: somewhere to put a circuit that
    // is not a hillclimb.
    const far = smoothstep(420, 1750, d);
    const spines = ridged(x / 1450, z / 1450, s + 91, 3) * 54 * far;

    // A second, tighter ridge set gives the gravel stages their crests.
    const ridges = ridged(x / 560, z / 560, s + 233, 2) * 12 * smoothstep(300, 1200, d);

    // Fine relief. No longer damped anywhere, because nothing needs a flat
    // shelf to stand on.
    const detail = fbm(x / 145, z / 145, s + 5, 3) * 3.1;

    // A river valley carves a low corridor through the countryside.
    const rv = valueNoise(x / 2600, z / 2600, s + 404);
    const valley = -22 * Math.exp(-Math.pow((z * 0.6 + x * 0.32) / 520 - rv * 1.6 - 1.35, 2));

    return rolling + spines + ridges + detail + valley;
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
    const h = height(x, z);
    // Snow, sand, hardpan and the sea, wherever a biome says so; the rules
    // below are the farmland's and still hold everywhere else.
    if (field) {
      const b = field.surfaceAt(x, z, h, sl);
      if (b) return b;
    }
    const n = fbm(x / 320, z / 320, s + 77, 3);
    // Sand belongs to the river valley, not to the farmland. The old threshold
    // (h < -9) caught more than a quarter of the map, because the valley cuts
    // to -18 over a wide corridor — the countryside read as desert rather than
    // as country.
    // Sand belongs to the river bed, and the test has to say so directly.
    // Keying it off absolute height worked only while the map sat near zero;
    // once the terrain was freed of the city shelf the mean dropped to -24 m
    // and over a third of the world went sandy. This recomputes the same
    // valley term height() uses, so sand follows the river wherever the river
    // happens to be.
    //
    // And then that was still a kilometre-wide strip of beach, a fifth of the
    // map, because "in the valley" is most of a Gaussian that wide. Sand is now
    // the dry wash itself — a few dozen metres of it meandering down the
    // bottom — and the rest of the valley floor is the lushest grass on the map.
    if (riverBed(x, z, s) > 0.5) return 'sand';
    if (n > 0.40 && h > 16) return 'dirt';
    return 'grass';
  }

  /** Attach the biome field. Everything that asks for height or cover afterwards sees it. */
  function setRelief(f) { field = f || null; }

  return { height, baseHeight, normal, slope, cover, setRelief, seed: s, half: HALF, cityRadius: CITY_R };
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
  // Rural structures, scattered along the roads.
  //
  // There is no city any more, so there are no blocks to fill — but the world
  // still needs solid things in it. Buildings are what give the collision and
  // damage systems something to hit, and a farm every so often is what stops a
  // 4 km valley reading as a golf course.
  const KINDS = [
    { kind: 'house',     w: [9, 16],  d: [8, 13],  h: [5.5, 8.5],  weight: 0.34 },
    { kind: 'house',     w: [7, 11],  d: [6, 9],   h: [3.0, 4.2],  weight: 0.16 },  // sheds
    { kind: 'warehouse', w: [16, 30], d: [11, 20], h: [6.5, 11],   weight: 0.34 },  // barns
    { kind: 'warehouse', w: [24, 44], d: [14, 26], h: [8, 14],     weight: 0.16 },  // big sheds
  ];
  const totalWeight = KINDS.reduce((t, k) => t + k.weight, 0);
  const pick = () => {
    let r = rnd() * totalWeight;
    for (const k of KINDS) { r -= k.weight; if (r <= 0) return k; }
    return KINDS[0];
  };
  const between = (r) => r[0] + rnd() * (r[1] - r[0]);

  // How many farms each biome keeps, of those the farmland would have: a
  // barn every few hundred metres is right for the heartland and the
  // autumn woods, fewer on the coast, and in the canyon and on the pass
  // only the odd homestead — a red barn and a steel shed at every bend of
  // Red Canyon made it read as farmland painted orange. The target is cut
  // by the same share (420 x 0.62), so the heartland keeps the density it
  // had rather than soaking up the buildings the wild country lost.
  const KEEP_BY_BIOME = [1.0, 0.25, 0.3, 0.75, 0.85];
  const bio = world.biomes || null;
  const bq = new Float64Array(5);
  const TARGET = bio ? 260 : 420;
  for (let attempt = 0; attempt < TARGET * 14 && world.lots.length < TARGET; attempt++) {
    const x = (rnd() * 2 - 1) * (world.half - 140);
    const z = (rnd() * 2 - 1) * (world.half - 140);
    if (bio) {
      bio.weightsAt(x, z, bq);
      let keep = 0;
      for (let b = 0; b < 5; b++) keep += bq[b] * KEEP_BY_BIOME[b];
      if (rnd() > keep) continue;
    }

    // Farms sit BESIDE a road, not in open country — a building nobody could
    // drive to looks like it was dropped there, because it was.
    const near = ground.nearestRoad(x, z, 150, (e) => e.kind !== 'circuit' && e.kind !== 'rallyx');
    if (!near) continue;
    if (near.dist < 26 || near.dist > 130) continue;
    if (world.terrain.slope(x, z) > 0.30) continue;      // not on a cliff

    const spec = pick();
    const lot = {
      x, z, y: 0,
      w: between(spec.w), d: between(spec.d),
      // Square to the road it serves, with a little slop.
      rot: Math.atan2(near.tx, near.tz) + (rnd() - 0.5) * 0.5,
      kind: spec.kind, height: between(spec.h),
      district: 'country', seed: (rnd() * 1e9) | 0,
      // The biome it stands in (biomes.js BIOME), so a renderer can build
      // it to suit the country: see the round-three notes for city.js.
      biome: bio ? bio.dominant(x, z) : 0,
    };
    world.lots.push(lot);
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

  // --- Repair shops -------------------------------------------------------
  // A wrecked car needs somewhere to go that is not the respawn key. Each shop
  // is a shed set back from the road with a forecourt in front of it: the
  // building is solid like any other, and the forecourt is the trigger. They
  // are placed on the paved network rather than on gravel, because limping a
  // holed radiator up a rally stage is not a rescue.
  if (ground) {
    const GARAGE_NAMES = [
      'Marrowfield Motor Works', 'Culver & Sons', 'Ashcombe Autos',
      'Thornhollow Garage', 'Verrand Repairs', 'Kestrel Service',
    ];
    const wanted = GARAGE_NAMES.length;
    for (let attempt = 0; attempt < 6000 && world.garages.length < wanted; attempt++) {
      const x = (rnd() * 2 - 1) * (world.half - 260);
      const z = (rnd() * 2 - 1) * (world.half - 260);
      const near = ground.nearestRoad(x, z, 90, (e) => e.kind === 'rural');
      if (!near) continue;
      if (near.dist < 30 || near.dist > 74) continue;
      if (world.terrain.slope(x, z) > 0.16) continue;          // needs flat ground
      // Not on top of another shop, and not next to one either.
      let clash = false;
      for (const g of world.garages) if (Math.hypot(g.x - x, g.z - z) < 620) { clash = true; break; }
      if (clash) continue;

      // Lay the shop out FROM THE ROAD, not from the random sample point.
      //
      // Offsetting the forecourt a fixed distance toward the road from a point
      // that was itself 30-74 m away left forecourts stranded up to 55 m out in
      // a field — you could not drive onto one. Measuring outward from the
      // carriageway instead puts the apron at a known distance every time.
      const rot = Math.atan2(near.tx, near.tz);
      let awX = x - near.x, awZ = z - near.z;
      const awL = Math.hypot(awX, awZ) || 1;
      awX /= awL; awZ /= awL;
      const halfW = (near.edge.width || 9.5) * 0.5;
      const padX = near.x + awX * (halfW + 7);
      const padZ = near.z + awZ * (halfW + 7);
      const shopX = near.x + awX * (halfW + 20);
      const shopZ = near.z + awZ * (halfW + 20);
      if (Math.abs(shopX) > world.half - 90 || Math.abs(shopZ) > world.half - 90) continue;
      if (world.terrain.slope(padX, padZ) > 0.20) continue;
      if (world.lots.some((l) => Math.hypot(l.x - shopX, l.z - shopZ) < 34)) continue;

      world.lots.push({
        x: shopX, z: shopZ, y: 0, w: 22, d: 13, rot,
        kind: 'warehouse', height: 7.5, district: 'garage',
        seed: (rnd() * 1e9) | 0, garage: true,
      });
      world.garages.push({
        name: GARAGE_NAMES[world.garages.length],
        x: padX, z: padZ, rot, radius: 16,
      });
      // The map wants them labelled.
      world.villages.push({ name: GARAGE_NAMES[world.garages.length - 1], x: padX, z: padZ });
    }
  }

  for (const lot of world.lots) lot.y = world.terrain.height(lot.x, lot.z);
}

// Species indices, matching SPECIES in src/render/foliage.js. `variant` on a
// 'tree' prop is one of these; on a 'bush' prop, 0 is a broadleaf shrub and 1
// a juniper-type evergreen.
export const TREE = { oak: 0, spruce: 1, birch: 2, pine: 3, beech: 4, fir: 5 };
export const BUSH = { shrub: 0, juniper: 1 };
// The biomes' own plants, drawn by src/render/props.js as species of their
// own: a saguaro-type cactus and a coconut-type palm. `variant` is 0 for both.
export const EXTRA_PLANTS = ['cactus', 'palm'];

/**
 * How far into the river valley (x, z) is: 1 on the valley floor, falling to 0
 * about half a kilometre out on either side. The same Gaussian makeTerrain
 * cuts the valley with, so it is where the valley actually is. Renderers use it
 * for moisture: the valley floor is the lushest ground on the map.
 */
export function valleyWeight(x, z, seed) {
  const s = seed | 0;
  const rv = valueNoise(x / 2600, z / 2600, s + 404);
  const arg = (z * 0.6 + x * 0.32) / 520 - rv * 1.6 - 1.35;
  return Math.exp(-arg * arg);
}

/**
 * The woodland mask the planting pass uses: above ~0.08 is woodland, rising
 * to full density by ~0.2. A domain-warped fbm, because plain fbm thresholds
 * into blobs that all look like each other. Exported so the ground can paint
 * a forest floor exactly where the forest is.
 */
export function woodland(x, z, seed) {
  const s = seed | 0;
  const wx = x + fbm(x / 1300, z / 1300, s + 61, 2) * 420;
  const wz = z + fbm(x / 1300, z / 1300, s + 62, 2) * 420;
  return fbm(wx / 640, wz / 640, s + 55, 4);
}

const FIELD = 230;
const FIELD_SALT = 8123;

/**
 * Land use: which field (x, z) is in, and what is growing in it.
 *
 * Open country is not one continuous lawn; it is a patchwork of fields a few
 * hundred metres across, each managed differently, and the patchwork is most
 * of what makes a view across farmland read as real. Fields are cells of a
 * jittered Voronoi lattice (~230 m), each assigned a use by a hash of its id:
 *
 *   0 pasture   grazed grass, the default, and always the valley floor
 *   1 hay       mown meadow — paler, with the mower's stripes
 *   2 cereal    a grain crop, green-gold, with tramlines
 *   3 fallow    left to rough grass and weeds, olive-brown
 *
 * `edge` is the distance to the nearest field boundary, for the grassy margin
 * every field has; `dir` is the direction the field was worked in, for
 * stripes. The surface under the wheels is 'grass' in all of them — this is
 * paint, not physics. Writes into `out` and returns it; allocates nothing.
 */
export function fieldAt(x, z, seed, out) {
  const s = (seed | 0) + FIELD_SALT;
  const fx = x / FIELD, fz = z / FIELD;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  let d1 = 1e9, d2 = 1e9, bx = 0, bz = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cz = iz + j;
      const px = cx + 0.12 + hash2(cx, cz, s) * 0.76;
      const pz = cz + 0.12 + hash2(cx, cz, s + 1) * 0.76;
      const d = (px - fx) * (px - fx) + (pz - fz) * (pz - fz);
      if (d < d1) { d2 = d1; d1 = d; bx = cx; bz = cz; } else if (d < d2) d2 = d;
    }
  }
  // Distance to the boundary, in metres: half the difference of the two
  // nearest distances is exact on a straight bisector and close elsewhere.
  out.edge = (Math.sqrt(d2) - Math.sqrt(d1)) * 0.5 * FIELD;
  const h = hash2(bx, bz, s + 2);
  out.use = h < 0.58 ? 0 : h < 0.76 ? 1 : h < 0.90 ? 2 : 3;
  out.id = bx * 7919 + bz;
  const a = hash2(bx, bz, s + 3) * Math.PI;
  out.dx = Math.cos(a); out.dz = Math.sin(a);
  out.ripe = hash2(bx, bz, s + 4);
  return out;
}

/**
 * fieldAt() with its lattice precomputed over [-extent, extent] — the same
 * answer to the last bit (tools/naturecheck.mjs compares the two), at a
 * fraction of the cost, because the eighteen hashes a call spends finding its
 * cell become array reads. The terrain paints every grass vertex through this.
 * About 1,100 cells at the terrain's reach; outside the extent it simply calls
 * fieldAt().
 */
export function fieldMap(seed, extent) {
  const s = (seed | 0) + FIELD_SALT;
  const c0 = Math.floor(-extent / FIELD) - 2;
  const n = Math.ceil((2 * extent) / FIELD) + 5;
  const px = new Float64Array(n * n), pz = new Float64Array(n * n);
  const use = new Uint8Array(n * n), ripe = new Float64Array(n * n);
  const ux = new Float64Array(n * n), uz = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = c0 + i, cz = c0 + j, k = j * n + i;
      px[k] = cx + 0.12 + hash2(cx, cz, s) * 0.76;
      pz[k] = cz + 0.12 + hash2(cx, cz, s + 1) * 0.76;
      const h = hash2(cx, cz, s + 2);
      use[k] = h < 0.58 ? 0 : h < 0.76 ? 1 : h < 0.90 ? 2 : 3;
      const a = hash2(cx, cz, s + 3) * Math.PI;
      ux[k] = Math.cos(a); uz[k] = Math.sin(a);
      ripe[k] = hash2(cx, cz, s + 4);
    }
  }
  return function fieldFast(x, z, out) {
    const fx = x / FIELD, fz = z / FIELD;
    const i0 = Math.floor(fx) - 1 - c0, j0 = Math.floor(fz) - 1 - c0;
    if (i0 < 0 || j0 < 0 || i0 + 2 >= n || j0 + 2 >= n) return fieldAt(x, z, seed, out);
    // Same visiting order and the same strict comparisons as fieldAt, so a
    // tie resolves to the same cell.
    let d1 = 1e9, d2 = 1e9, bk = 0;
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const k = (j0 + j) * n + i0 + i;
        const ex = px[k] - fx, ez = pz[k] - fz;
        const d = ex * ex + ez * ez;
        if (d < d1) { d2 = d1; d1 = d; bk = k; } else if (d < d2) d2 = d;
      }
    }
    out.edge = (Math.sqrt(d2) - Math.sqrt(d1)) * 0.5 * FIELD;
    out.use = use[bk];
    out.id = (c0 + (bk % n)) * 7919 + (c0 + ((bk / n) | 0));
    out.dx = ux[bk]; out.dz = uz[bk];
    out.ripe = ripe[bk];
    return out;
  };
}

/**
 * The dry river bed: 0 outside it, rising to 1 along a meandering thalweg in
 * the bottom of the valley makeTerrain cuts. The valley itself is a kilometre
 * wide and was all sand, which read as a desert strip across a green country;
 * what a valley floor actually has is lush grass and a stony wash a few dozen
 * metres across winding down the middle of it.
 */
export function riverBed(x, z, seed) {
  const s = seed | 0;
  const rv = valueNoise(x / 2600, z / 2600, s + 404);
  const arg = (z * 0.6 + x * 0.32) / 520 - rv * 1.6 - 1.35
            + fbm(x / 520, z / 520, s + 409, 3) * 0.055;
  // 0.0013 of `arg` per metre across the valley, so 0.03 is ~23 m either side.
  return smoothstep(0.034, 0.012, Math.abs(arg));
}

/**
 * Shoulder width beyond the carriageway edge, in metres. This is ground.js's
 * figure (the shoulder it stamps in gravel, or in dirt on a dirt road) and must
 * stay equal to it; tools/naturecheck.mjs reads the stamped surface itself, so
 * a drift between the two shows up there as shrubs on gravel.
 */
export const shoulderOf = (e) => (e.surface === 'dirt' ? 1.6 : e.kind === 'highway' ? 3.5 : 2.4);

// Clear ground a circuit keeps beyond its edge. A tree three metres off a
// racing line is a wall; this is the run-off area a real circuit would have.
const RUNOFF = { circuit: 12, rallyx: 12 };

/**
 * How far (x, z) is from the nearest carriageway EDGE, over every road segment
 * that could matter — the true nearest, by Euclidean distance.
 *
 * Not ground.roadAt(): that answers "which road am I on", so it ranks segments
 * by distance over half-width, and a narrow lane beside a wide road loses to it
 * even when its edge is metres nearer. Planting against that metric put a tree
 * 3.8 m from a dirt road's edge under a 4 m rule, and verge paint measured
 * from the wrong road. This asks the question those callers actually have.
 *
 * `query(x, z, out)` fills and returns `out`:
 *   edge      metres from the nearest carriageway edge (negative on it)
 *   clear     the same, less a circuit's run-off — what planting tests against
 *   shoulder  that nearest road's shoulder width (shoulderOf)
 *   kind      that nearest road's kind, '' when none is within `reach`
 * Both are exact wherever they come out under `reach`; beyond it they may read
 * Infinity, and every caller compares them against thresholds well inside it.
 * Built once from world.edges as flat arrays and a 32 m cell table; a query
 * allocates nothing.
 */
export function roadEdges(world, reach = 24) {
  const C = 32;
  const half = world.half;
  const lo = -half - reach - C;
  const n = Math.ceil((2 * (half + reach + C)) / C);
  let count = 0;
  for (const e of world.edges) if (e.pts && e.pts.length > 1) count += e.pts.length - 1;
  // 0 ax 1 az 2 bx 3 bz 4 halfW 5 run-off
  const seg = new Float64Array(count * 6);
  const segEdge = new Array(count);
  const cellCount = new Int32Array(n * n + 1);
  const cellsOf = (o, fn) => {
    const pad = seg[o + 4] + seg[o + 5] + reach;
    const i0 = Math.max(0, Math.floor((Math.min(seg[o], seg[o + 2]) - pad - lo) / C));
    const i1 = Math.min(n - 1, Math.floor((Math.max(seg[o], seg[o + 2]) + pad - lo) / C));
    const j0 = Math.max(0, Math.floor((Math.min(seg[o + 1], seg[o + 3]) - pad - lo) / C));
    const j1 = Math.min(n - 1, Math.floor((Math.max(seg[o + 1], seg[o + 3]) + pad - lo) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * n + i);
  };
  let k = 0;
  for (const e of world.edges) {
    if (!e.pts || e.pts.length < 2) continue;
    for (let p = 0; p < e.pts.length - 1; p++, k++) {
      const a = e.pts[p], b = e.pts[p + 1], o = k * 6;
      seg[o] = a.x; seg[o + 1] = a.z; seg[o + 2] = b.x; seg[o + 3] = b.z;
      seg[o + 4] = e.width * 0.5; seg[o + 5] = RUNOFF[e.kind] || 0;
      segEdge[k] = e;
      cellsOf(o, (c) => cellCount[c + 1]++);
    }
  }
  // Compressed rows: cell c owns list[start[c] .. start[c + 1]).
  const start = cellCount;
  for (let c = 0; c < n * n; c++) start[c + 1] += start[c];
  const list = new Int32Array(start[n * n]);
  const fillAt = Int32Array.from(start.subarray(0, n * n));
  for (let s = 0; s < count; s++) cellsOf(s * 6, (c) => { list[fillAt[c]++] = s; });

  function query(x, z, out) {
    out.edge = Infinity; out.clear = Infinity; out.shoulder = 0; out.kind = '';
    const i = Math.floor((x - lo) / C), j = Math.floor((z - lo) / C);
    if (i < 0 || j < 0 || i >= n || j >= n) return out;
    const c = j * n + i;
    let best = -1;
    for (let q = start[c], end = start[c + 1]; q < end; q++) {
      const s = list[q], o = s * 6;
      const ax = seg[o], az = seg[o + 1], dx = seg[o + 2] - ax, dz = seg[o + 3] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + dx * t), ez = z - (az + dz * t);
      const d = Math.sqrt(ex * ex + ez * ez) - seg[o + 4];
      if (d < out.edge) { out.edge = d; best = s; }
      if (d - seg[o + 5] < out.clear) out.clear = d - seg[o + 5];
    }
    if (best >= 0) {
      const e = segEdge[best];
      out.kind = e.kind; out.shoulder = shoulderOf(e);
    }
    return out;
  }

  return { query, reach, segments: count };
}

/**
 * Everything that grows or lies on the ground, and the street lighting.
 *
 * The countryside is built in layers, each a separate pass so each can be
 * tuned without disturbing the rest:
 *
 *   woodland   a domain-warped noise mask, ~22% of the map, planted on a
 *              jittered 7.2 m grid. Conifer stands on the high ground and in
 *              patches elsewhere, broadleaf in the lowlands, birch along the
 *              margins. The edge is ragged and shrubby, because a real wood
 *              edge is where the light is.
 *   hedgerows  along the lanes, where a noise says a farmer kept one: a shrub
 *              every few metres and a standard tree every dozen or so.
 *   open land  lone field trees, copses of four to nine, scattered bushes.
 *   the valley riverside birch and scrub along the dry bed, stones in it.
 *   rock       outcrops where the ground is steep or crests, as clusters of
 *              boulders with stones around them, in one rock type per area.
 *
 * Every pass asks the biome field (biomes.js) what country it is in, by
 * weight, so the change from one biome's planting to the next is a mix
 * across the border rather than a line:
 *
 *   Red Canyon       no woods and no hedges; saguaros in stands of one to
 *                    four, dry scrub, and half as many rocks again.
 *   Frostpeak Pass   spruce and fir forest, nothing above the tree line
 *                    (~60 m), juniper for scrub.
 *   Sunspray Bay     thinner woods of pine; palms along the back of the
 *                    beach and dotted over the coastal turf; nothing in the sea.
 *   Amberleaf Woods  more and denser broadleaf wood (the colour is props.js's).
 *
 * Nothing is planted on a carriageway or on anything else a road laid down
 * (shoulder, pavement), within a circuit's run-off, in a building footprint
 * or on a garage forecourt.
 */
function buildProps(world, rnd, ground) {
  const terrain = world.terrain;
  const seed = world.seed | 0;
  const half = world.half;
  const props = world.props;

  // Street lighting along the paved roads.
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
      props.push({
        type: e.kind === 'rural' ? 'polelight' : 'streetlight',
        x: p.x + p.nx * off * side, z: p.z + p.nz * off * side, y: p.y,
        rot: Math.atan2(-p.nx * side, -p.nz * side),
        scale: e.kind === 'highway' ? 1.35 : 1,
      });
    }
  }

  // ---- Exclusions ---------------------------------------------------------
  // Buildings, bucketed so the test is a handful of distance checks.
  const LC = 64;
  const lotCells = new Map();
  const lkey = (i, j) => i * 65536 + j;
  for (const lot of world.lots) {
    const r = Math.hypot(lot.w, lot.d) * 0.5 + 6;
    for (let i = Math.floor((lot.x - r) / LC); i <= Math.floor((lot.x + r) / LC); i++) {
      for (let j = Math.floor((lot.z - r) / LC); j <= Math.floor((lot.z + r) / LC); j++) {
        const k = lkey(i, j);
        let L = lotCells.get(k);
        if (!L) lotCells.set(k, (L = []));
        L.push([lot.x, lot.z, r]);
      }
    }
  }
  // Garage forecourts are somewhere you drive onto; keep 42 m of them clear.
  for (const g of world.garages) {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const kk = lkey(Math.floor(g.x / LC) + i, Math.floor(g.z / LC) + j);
        let L = lotCells.get(kk);
        if (!L) lotCells.set(kk, (L = []));
        L.push([g.x, g.z, 42]);
      }
    }
  }
  const inLot = (x, z) => {
    const L = lotCells.get(lkey(Math.floor(x / LC), Math.floor(z / LC)));
    if (!L) return false;
    for (let i = 0; i < L.length; i++) {
      const q = L[i];
      const dx = x - q[0], dz = z - q[1];
      if (dx * dx + dz * dz < q[2] * q[2]) return true;
    }
    return false;
  };

  // Clearance from the edge of the nearest road, in metres, less a circuit's
  // run-off (see roadEdges for why this is not ground.roadAt).
  const edges = roadEdges(world);
  const rq = { edge: 0, clear: 0, shoulder: 0, kind: '' };
  const clearance = (x, z) => edges.query(x, z, rq).clear;

  const g = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', grip: 0, roughness: 0, rolling: 0, dust: 0 };
  const gt = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', grip: 0, roughness: 0, rolling: 0, dust: 0 };
  const inBounds = (x, z) => Math.abs(x) < half - 6 && Math.abs(z) < half - 6;

  // Nothing grows on anything a road laid down. Distance alone cannot say
  // where that is: the ground stamps its materials on a grid (3 m) and reads
  // the nearest cell, so a 2.4 m shoulder shows as gravel out to 4.5 m in
  // places, and a 2.4 m clearance put 203 shrubs on it. So near a road the
  // surface is asked directly — stamped if it differs from the natural cover
  // at that point — and the shoulder is kept as well, for a dirt road whose
  // stamped dirt matches dirt cover. Beyond the widest stamp (a city pavement,
  // 4.2 m, plus the grid's half-diagonal) there is nothing to ask.
  const stampReach = 4.2 + (ground.field ? ground.field.res : 3) * Math.SQRT1_2 + 0.3;
  const onTurf = (x, z) => {
    const q = edges.query(x, z, rq);
    if (q.edge < q.shoulder + 0.5) return false;
    if (q.edge > stampReach) return true;
    ground.sample(x, z, gt);
    return gt.surface === terrain.cover(x, z, gt.ny);
  };

  // ---- Biomes -------------------------------------------------------------
  const bio = world.biomes || null;
  const seaY = bio ? bio.seaLevel : -Infinity;
  const bw = new Float64Array(5);
  const weights = (x, z) => {
    if (bio) return bio.weightsAt(x, z, bw);
    bw.fill(0); bw[0] = 1;
    return bw;
  };
  // How much more (or less) wood each biome grows, as an offset on the
  // woodland mask, whose planting threshold is 0.08: the desert grows none,
  // the coast much less (so its palms are seen), the autumn woods more.
  // The pass is dark with spruce below the tree line (0.10): at 0.03 its
  // valleys were a white plain with a tree every hundred metres, and nothing
  // gave the mountains their scale.
  const WOOD_BIAS = [0, -1.2, 0.10, -0.15, 0.08];
  const woodBias = (w) => w[0] * WOOD_BIAS[0] + w[1] * WOOD_BIAS[1] + w[2] * WOOD_BIAS[2] +
                          w[3] * WOOD_BIAS[3] + w[4] * WOOD_BIAS[4];
  // Above this in the mountains there is only rock and snow. The northern
  // roads climb to about +15 m and the peaks to +160, so a kid on the pass
  // sees forest round them and bare white summits above.
  const treeline = (x, z) => 58 + fbm(x / 300, z / 300, seed + 177, 2) * 14;

  // ---- Masks --------------------------------------------------------------
  // Woodland: a warped fbm, thresholded (see woodland()).
  const forest = (x, z) => woodland(x, z, seed);
  // Where conifers rather than broadleaves hold the ground: uphill, and in
  // plantation-sized patches anywhere. The map's median height is about -21 m
  // and its 95th percentile +18 m, so "uphill" is measured on that scale.
  const coniferShare = (x, z, h) =>
    clamp(smoothstep(-34, 14, h) * 0.72 + fbm(x / 900, z / 900, seed + 91, 3) * 1.1, 0, 1);

  function pickTree(x, z, h, edge, r, w) {
    const base = coniferShare(x, z, h);
    // The mountains are conifer forest, all of it — one summer-green oak in
    // a snowy spruce wood was the first thing that looked wrong from the
    // road — the autumn woods broadleaf, the coast a pinewood; farmland
    // keeps the old mix.
    const c = base * (w[0] + w[1]) + w[2] + (0.35 + base * 0.5) * w[3] + base * 0.25 * w[4];
    if (r() < c) {
      const q = r();
      // Pine takes the dry crests and the forest margins, and the coast —
      // but not the mountains, where its bare trunk and flat crown under
      // snow read as a lollipop, not a tree: spruce and fir hold the pass.
      if (q < (0.14 + edge * 0.25 + w[3] * 0.6) * (1 - w[2])) return TREE.pine;
      return q < 0.72 ? TREE.spruce : TREE.fir;
    }
    const q = r();
    if (q < 0.09 + edge * 0.22) return TREE.birch;
    return q < 0.60 ? TREE.beech : TREE.oak;
  }

  // The one door everything is planted through, so the map edge and the road
  // surfaces are enforced once rather than remembered at every call site —
  // clusters are placed around a checked centre, and their members were
  // landing past the edge. The rotation is drawn first either way, so a
  // refusal here never shifts the random stream for the plants after it.
  const plant = (type, variant, x, z, y, scale) => {
    const r = rnd() * 6.2832;
    if (!inBounds(x, z) || !onTurf(x, z)) return;
    // Nothing stands in the sea.
    if (bio && y < seaY + 0.25 && bio.seaAt(x, z) > 0.3) return;
    props.push({ type, x, z, y, rot: r, scale, variant });
  };

  // ---- Woodland -----------------------------------------------------------
  const FS = 7.2;
  const fN = Math.floor((half * 2) / FS);
  for (let j = 0; j < fN; j++) {
    for (let i = 0; i < fN; i++) {
      const x = -half + (i + 0.15 + rnd() * 0.7) * FS;
      const z = -half + (j + 0.15 + rnd() * 0.7) * FS;
      const wb = weights(x, z);
      const F = forest(x, z) + woodBias(wb);
      if (F < 0.08) continue;
      // Density ramps up over the edge band; `edge` is 1 at the margin.
      const edge = 1 - smoothstep(0.10, 0.26, F);
      const roll = rnd();
      if (roll > smoothstep(0.08, 0.20, F) * 0.92) {
        // An empty slot at the margin is where the scrub goes.
        // Not on the pass, where the scrub is under the snow: a green blob
        // on a white slope reads as a bush that fell out of summer.
        if (edge > 0.3 && roll < 0.97 - wb[2] * 0.8 && inBounds(x, z)) {
          if (clearance(x, z) < 2.4 || inLot(x, z)) continue;
          ground.sample(x, z, g);
          if (g.surface === 'sand' || g.surface === 'rock' || g.ny < 0.8) continue;
          plant('bush', rnd() < 0.2 ? BUSH.juniper : BUSH.shrub, x, z, g.y, 0.7 + rnd() * 0.7);
        }
        continue;
      }
      if (!inBounds(x, z)) continue;
      if (clearance(x, z) < 4.5 || inLot(x, z)) continue;
      ground.sample(x, z, g);
      // Conifers hold a mountainside to about 40 degrees (normal y 0.76);
      // anywhere else a wood stops at 34 (0.83).
      if (g.surface === 'sand' || g.surface === 'water' || g.ny < 0.83 - 0.07 * wb[2]) continue;
      if (g.surface === 'rock' && wb[2] < 0.5) continue;
      if (wb[2] > 0.3 && g.y > treeline(x, z)) continue;
      const v = pickTree(x, z, g.y, edge, rnd, wb);
      // Forest trees are drawn up tall by their neighbours; margin trees are
      // younger and smaller.
      const sc = (0.78 + rnd() * 0.42) * lerp(1.0, 0.72, edge * rnd());
      plant('tree', v, x, z, g.y, sc);
      // Understorey, thin inside the wood and thicker toward the light.
      if (rnd() < 0.05 + edge * 0.25) {
        const bx = x + (rnd() - 0.5) * FS, bz = z + (rnd() - 0.5) * FS;
        if (clearance(bx, bz) > 2.4 && !inLot(bx, bz)) {
          plant('bush', rnd() < 0.3 ? BUSH.juniper : BUSH.shrub, bx, bz, ground.heightAt(bx, bz), 0.6 + rnd() * 0.6);
        }
      }
    }
  }

  // ---- Hedgerows ----------------------------------------------------------
  for (const e of world.edges) {
    if (e.kind === 'circuit' || e.kind === 'rallyx') continue;
    const paved = e.kind === 'rural' || e.kind === 'street' || e.kind === 'avenue';
    for (const side of [-1, 1]) {
      let s = rnd() * 4;
      let nextTree = 6 + rnd() * 14;
      while (s < e.length) {
        const p = pointOnEdge(e, s);
        s += 2.4 + rnd() * 1.4;
        if (!p) continue;
        // Kept or grubbed out, a few hundred metres at a time, independently
        // on each side of the lane.
        const keep = fbm(p.x / 260 + side * 3.1, p.z / 260, seed + 131, 2);
        if (keep < (paved ? 0.02 : 0.18)) continue;
        // Hedges are a farmer's; nobody planted one across a canyon floor,
        // a snowfield or a dune.
        const wh = weights(p.x, p.z);
        if (wh[0] + wh[4] + wh[3] * 0.3 < 0.5) continue;
        const off = e.width * 0.5 + (paved ? 4.2 : 3.4) + rnd() * 1.6;
        const x = p.x + p.nx * off * side, z = p.z + p.nz * off * side;
        if (!inBounds(x, z) || inLot(x, z) || clearance(x, z) < 2.6) continue;
        if (forest(x, z) > 0.12) continue;          // the wood is already there
        ground.sample(x, z, g);
        if (g.surface === 'sand' || g.surface === 'rock' || g.ny < 0.8) continue;
        nextTree -= 3;
        if (nextTree <= 0 && clearance(x, z) > 4.2) {
          nextTree = 9 + rnd() * 16;
          const q = rnd();
          plant('tree', q < 0.45 ? TREE.oak : q < 0.75 ? TREE.beech : TREE.birch, x, z, g.y, 0.7 + rnd() * 0.45);
        } else {
          plant('bush', BUSH.shrub, x, z, g.y, 0.8 + rnd() * 0.6);
        }
      }
    }
  }

  // ---- Open country -------------------------------------------------------
  const OS = 44;
  const oN = Math.floor((half * 2) / OS);
  for (let j = 0; j < oN; j++) {
    for (let i = 0; i < oN; i++) {
      const cx = -half + (i + rnd()) * OS, cz = -half + (j + rnd()) * OS;
      const roll = rnd();
      if (!inBounds(cx, cz)) continue;
      const wo = weights(cx, cz);
      if (wo[1] > 0.5) {
        // The canyon floor: saguaros in stands of one to four, and dry scrub.
        if (roll < 0.22) {
          const n = 1 + Math.floor(rnd() * 4);
          for (let k = 0; k < n; k++) {
            const a = rnd() * 6.28, d = k === 0 ? 0 : 3 + rnd() * 9;
            const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
            if (clearance(x, z) < 4 || inLot(x, z)) continue;
            ground.sample(x, z, g);
            if (g.surface === 'rock' || g.surface === 'water' || g.ny < 0.86) continue;
            plant('cactus', 0, x, z, g.y, k === 0 ? 0.85 + rnd() * 0.5 : 0.4 + rnd() * 0.6);
          }
        } else if (roll < 0.5) {
          if (clearance(cx, cz) < 2.6 || inLot(cx, cz)) continue;
          ground.sample(cx, cz, g);
          if (g.surface === 'rock' || g.surface === 'water' || g.ny < 0.8) continue;
          plant('bush', rnd() < 0.5 ? BUSH.juniper : BUSH.shrub, cx, cz, g.y, 0.45 + rnd() * 0.5);
        }
        continue;
      }
      if (forest(cx, cz) + woodBias(wo) > 0.06) continue;
      const alpine = wo[2] > 0.5, coast = wo[3] > 0.5;
      if (roll < 0.075) {
        // A lone field tree, usually an oak, grown wide in the open. On the
        // pass a spruce; on the coast usually a palm.
        if (clearance(cx, cz) < 6 || inLot(cx, cz)) continue;
        ground.sample(cx, cz, g);
        if ((g.surface !== 'grass' && g.surface !== 'snow' && g.surface !== 'sand') || g.ny < 0.85) continue;
        if (alpine && g.y > treeline(cx, cz)) continue;
        if (coast && rnd() < 0.7) plant('palm', 0, cx, cz, g.y, 0.8 + rnd() * 0.4);
        else if (alpine) plant('tree', rnd() < 0.6 ? TREE.spruce : TREE.fir, cx, cz, g.y, 0.8 + rnd() * 0.4);
        else if (g.surface === 'grass') plant('tree', rnd() < 0.7 ? TREE.oak : TREE.beech, cx, cz, g.y, 0.95 + rnd() * 0.4);
        if (rnd() < 0.5) {
          // Its companion shrub gets the same checks as anything else: it
          // used to skip them, and put a bush inside a barn.
          const a = rnd() * 6.28, d = 4 + rnd() * 4;
          const bx = cx + Math.cos(a) * d, bz = cz + Math.sin(a) * d;
          if (clearance(bx, bz) > 2.4 && !inLot(bx, bz)) {
            plant('bush', alpine ? BUSH.juniper : BUSH.shrub, bx, bz, ground.heightAt(bx, bz), 0.8 + rnd() * 0.5);
          }
        }
      } else if (roll < 0.105) {
        // A copse; on the coast a palm grove, on the pass always conifers.
        const n = 4 + Math.floor(rnd() * 6);
        const conifer = alpine || rnd() < 0.3;
        const grove = coast && rnd() < 0.6;
        for (let k = 0; k < n; k++) {
          const a = rnd() * 6.28, d = Math.sqrt(rnd()) * 13;
          const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
          if (clearance(x, z) < 4.5 || inLot(x, z)) continue;
          ground.sample(x, z, g);
          if (g.surface === 'rock' || g.surface === 'water' || g.ny < 0.83) continue;
          if (g.surface === 'sand' && !grove) continue;
          if (alpine && g.y > treeline(x, z)) continue;
          if (grove) { plant('palm', 0, x, z, g.y, 0.7 + rnd() * 0.5); continue; }
          const v = conifer ? (rnd() < 0.6 ? TREE.spruce : alpine ? TREE.fir : TREE.pine) : (rnd() < 0.4 ? TREE.birch : rnd() < 0.5 ? TREE.oak : TREE.beech);
          plant('tree', v, x, z, g.y, 0.7 + rnd() * 0.45);
          if (rnd() < 0.6) {
            // Its own height, not the tree's: six metres away on a slope is
            // most of a metre up or down.
            const bx = x + (rnd() - 0.5) * 6, bz = z + (rnd() - 0.5) * 6;
            if (clearance(bx, bz) > 2.4 && !inLot(bx, bz)) plant('bush', alpine ? BUSH.juniper : BUSH.shrub, bx, bz, ground.heightAt(bx, bz), 0.7 + rnd() * 0.5);
          }
        }
      } else if (roll < 0.36 - (alpine ? 0.2 : 0)) {
        // Scrub in the grass; little of it pokes through the snow.
        if (clearance(cx, cz) < 2.6 || inLot(cx, cz)) continue;
        ground.sample(cx, cz, g);
        if (g.surface === 'sand' || g.surface === 'rock' || g.surface === 'water' || g.ny < 0.8) continue;
        const dry = alpine || (g.y > 20 && rnd() < 0.5);
        plant('bush', dry ? BUSH.juniper : BUSH.shrub, cx, cz, g.y, 0.6 + rnd() * 0.7);
      }
    }
  }

  // ---- Canyon scrub ---------------------------------------------------------
  // Real red-rock country is not bare: it is dotted all the way to the
  // horizon with sage and juniper a metre or so high, grey-green (props.js
  // dusts their foliage by the biome map), and that stipple is what gives a
  // canyon floor its scale. The open-country lattice above put one bush in
  // seven thousand square metres; this puts one in about six hundred, on
  // the flats only, thinning toward the canyon's border.
  if (bio) {
    const DS = 14;
    const dN = Math.floor((half * 2) / DS);
    for (let j = 0; j < dN; j++) {
      for (let i = 0; i < dN; i++) {
        const x = -half + (i + rnd()) * DS, z = -half + (j + rnd()) * DS;
        const roll = rnd();
        if (roll > 0.34 || !inBounds(x, z)) continue;
        const wd = weights(x, z)[1];
        if (wd < 0.55 || roll > 0.34 * smoothstep(0.55, 0.8, wd)) continue;
        if (clearance(x, z) < 3 || inLot(x, z)) continue;
        ground.sample(x, z, g);
        if (g.surface === 'rock' || g.surface === 'water' || g.ny < 0.9) continue;
        plant('bush', roll < 0.13 ? BUSH.juniper : BUSH.shrub, x, z, g.y, 0.32 + rnd() * 0.42);
      }
    }
  }

  // ---- The back of the beach ------------------------------------------------
  // Palms where the sand meets the turf, a few metres above the water, in
  // loose lines and clumps: the one thing that says "seaside" from a
  // kilometre off. A 16 m lattice over the coast band only.
  if (bio) {
    const PS = 16;
    const zs = Math.max(-half, 900);
    const pN = Math.floor((half * 2) / PS), pJ = Math.floor((half - zs) / PS);
    for (let j = 0; j < pJ; j++) {
      for (let i = 0; i < pN; i++) {
        const x = -half + (i + rnd()) * PS, z = zs + (j + rnd()) * PS;
        const roll = rnd();
        if (roll > 0.16 || !inBounds(x, z)) continue;
        const wp = weights(x, z);
        if (wp[3] < 0.45) continue;
        const y = ground.heightAt(x, z);
        if (y < seaY + 1.3 || y > seaY + 16) continue;
        if (clearance(x, z) < 4.5 || inLot(x, z)) continue;
        ground.sample(x, z, g);
        if (g.surface === 'rock' || g.surface === 'water' || g.ny < 0.88) continue;
        plant('palm', 0, x, z, g.y, 0.75 + rnd() * 0.5);
        if (roll < 0.05) {
          const a = rnd() * 6.28, d = 3 + rnd() * 4;
          const x2 = x + Math.cos(a) * d, z2 = z + Math.sin(a) * d;
          if (clearance(x2, z2) > 4.5 && !inLot(x2, z2)) plant('palm', 0, x2, z2, ground.heightAt(x2, z2), 0.6 + rnd() * 0.4);
        }
      }
    }
  }

  // ---- The valley ---------------------------------------------------------
  // Birch and scrub on the banks of the dry bed, stones in it.
  const VS = 9;
  const vN = Math.floor((half * 2) / VS);
  for (let j = 0; j < vN; j++) {
    const z0 = -half + j * VS;
    for (let i = 0; i < vN; i++) {
      const x = -half + (i + rnd()) * VS, z = z0 + rnd() * VS;
      const bed = riverBed(x, z, seed);
      const bank = riverBed(x + 26, z - 14, seed) + riverBed(x - 26, z + 14, seed) - bed * 2;
      const roll = rnd();
      if (bed > 0.5) {
        if (roll < 0.35 && inBounds(x, z) && clearance(x, z) > 1.5) {
          plant('stone', 0, x, z, ground.heightAt(x, z), 0.18 + rnd() * rnd() * 0.7);
        }
      } else if (bank > 0.4 && roll < 0.22) {
        if (!inBounds(x, z) || clearance(x, z) < 4.5 || inLot(x, z)) continue;
        if (bio && weights(x, z)[1] > 0.5) continue;      // a dry wash in the desert
        ground.sample(x, z, g);
        if (g.surface === 'rock' || g.ny < 0.83) continue;
        if (rnd() < 0.55) plant('tree', rnd() < 0.8 ? TREE.birch : TREE.oak, x, z, g.y, 0.65 + rnd() * 0.45);
        else plant('bush', BUSH.shrub, x, z, g.y, 0.8 + rnd() * 0.6);
      }
    }
  }

  // ---- Rock ---------------------------------------------------------------
  // Outcrops where the ground is steep or on a crest, one rock type per area.
  const RS = 52;
  const rN = Math.floor((half * 2) / RS);
  for (let j = 0; j < rN; j++) {
    for (let i = 0; i < rN; i++) {
      const cx = -half + (i + rnd()) * RS, cz = -half + (j + rnd()) * RS;
      const roll = rnd();
      if (!inBounds(cx, cz)) continue;
      const sl = terrain.slope(cx, cz);
      const h = terrain.height(cx, cz);
      const crest = h - 0.25 * (terrain.height(cx + 24, cz) + terrain.height(cx - 24, cz) +
                                terrain.height(cx, cz + 24) + terrain.height(cx, cz - 24));
      // This country is gentle — the 99th-percentile slope is 18 degrees — so
      // "steep" starts early, and crests do as much of the work as slope. The
      // canyon and the mountains are rock country and carry more of it.
      const wr = weights(cx, cz);
      const want = smoothstep(0.15, 0.32, sl) * 0.6 + smoothstep(0.3, 1.8, crest) * 0.45 + 0.03
                 + wr[1] * 0.28 + wr[2] * 0.12;
      if (roll > want) continue;
      // Sandstone in the canyon (props.js reddens it), granite in the peaks.
      const variant = wr[1] > 0.5 ? 1 : wr[2] > 0.5 ? (fbm(cx / 700, cz / 700, seed + 172, 2) > 0 ? 2 : 0)
        : fbm(cx / 700, cz / 700, seed + 171, 2) > 0.18 ? 1
        : fbm(cx / 700, cz / 700, seed + 172, 2) > 0.2 ? 2 : 0;
      const n = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < n; k++) {
        const a = rnd() * 6.28, d = Math.sqrt(rnd()) * (4 + n * 2);
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (clearance(x, z) < 3 || inLot(x, z)) continue;
        // One big one, the rest smaller: outcrops are not a pile of equals.
        const sc = k === 0 ? 1.4 + rnd() * 1.8 : 0.5 + rnd() * rnd() * 2.0;
        plant('rock', variant, x, z, ground.heightAt(x, z), sc);
      }
      const m = 3 + Math.floor(rnd() * 10);
      for (let k = 0; k < m; k++) {
        const a = rnd() * 6.28, d = 3 + rnd() * 14;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (clearance(x, z) < 1.5 || inLot(x, z)) continue;
        plant('stone', 0, x, z, ground.heightAt(x, z), 0.15 + rnd() * 0.35);
      }
    }
  }

  if (bio) buildLandmarks(world, ground, clearance, inLot);
}

/**
 * The biomes' landmarks (render/landmarks.js draws them), into
 * world.landmarks as { type, x, z, y, rot, scale, variant, span?, height? }.
 *
 * Their own random stream, seeded from the world's, so placing them neither
 * depends on nor disturbs the planting before them — and, like everything
 * else, every client places the same ones.
 *
 *   arch        Red Canyon: natural stone arches spanning its roads, where a
 *               road runs straight across open canyon floor away from any
 *               junction, up to three, at least 700 m apart.
 *   hoodoo      Red Canyon: stands of four to nine rock chimneys on the flat
 *               canyon floor, 45 to 260 m off a road — close enough to see,
 *               never in the way.
 *   lighthouse  Sunspray Bay: on the highest ground that stands out into
 *               the sea, within sight of a road.
 *   snowpole    Frostpeak Pass: along both edges of every road over snow,
 *               every 26 m, alternating sides.
 */
function buildLandmarks(world, ground, clearance, inLot) {
  const L = (world.landmarks = []);
  const bio = world.biomes;
  const seed = world.seed | 0;
  const r = mulberry(seed + 9001);
  const w = new Float64Array(5);
  const half = world.half;
  const inMap = (x, z) => Math.abs(x) < half - 30 && Math.abs(z) < half - 30;
  const g = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', grip: 0, roughness: 0, rolling: 0, dust: 0 };
  const junction = world.nodes.filter((n) => n.edges.length >= 3);
  const nearJunction = (x, z, d) => junction.some((n) => (n.x - x) ** 2 + (n.z - z) ** 2 < d * d);

  // ---- Arches ---------------------------------------------------------------
  {
    const cand = [];
    for (const e of world.edges) {
      if (e.kind !== 'rural' && e.kind !== 'gravel' && e.kind !== 'dirt') continue;
      // Edges run junction to junction or every 130 m, whichever is sooner,
      // so the straightness test reaches only as far as the edge does.
      for (let s = 15; s < e.length - 15; s += 18) {
        const p = pointOnEdge(e, s);
        if (!p || !inMap(p.x, p.z) || bio.weightsAt(p.x, p.z, w)[1] < 0.9) continue;
        // Straight: the heading up to 30 m either way within 0.2 rad.
        const a = pointOnEdge(e, s - 30), b = pointOnEdge(e, s + 30);
        const turn = Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
        if (turn > 0.2 || nearJunction(p.x, p.z, 160)) continue;
        const S = e.width * 0.5 + 12;
        // Both feet on open, even ground within a few metres of the road's
        // height, clear of any OTHER road and of buildings.
        let ok = true;
        for (const side of [-1, 1]) {
          const fx = p.x + p.nx * (S + 2.2) * side, fz = p.z + p.nz * (S + 2.2) * side;
          const dy = ground.heightAt(fx, fz) - p.y;
          if (dy < -5 || dy > 4 || clearance(fx, fz) < 8 || inLot(fx, fz)) { ok = false; break; }
        }
        if (!ok) continue;
        // Paved roads first (the loop through the canyon is the road most
        // players drive), then by a hash, so the choice is the seed's.
        cand.push({ e, p, S, score: (e.kind === 'rural' ? 1 : 0) + r() });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand) {
      if (L.length >= 3) break;
      if (L.some((q) => (q.x - c.p.x) ** 2 + (q.z - c.p.z) ** 2 < 700 * 700)) continue;
      L.push({
        type: 'arch', x: c.p.x, z: c.p.z, y: ground.heightAt(c.p.x, c.p.z),
        // Local X, the span, lies across the road: along its normal.
        rot: Math.atan2(-c.p.nz, c.p.nx), scale: 1, variant: L.length,
        span: c.S * 2, height: 16 + r() * 7,
      });
    }
  }

  // ---- Hoodoos --------------------------------------------------------------
  {
    const centres = [];
    for (let t = 0; t < 20000 && centres.length < 11; t++) {
      const x = (r() * 2 - 1) * (half - 60), z = (r() * 2 - 1) * (half - 60);
      if (bio.weightsAt(x, z, w)[1] < 0.9) continue;
      const c = clearance(x, z);
      if (c < 45 || c > 260 || bio.relief(x, z) > 2 || inLot(x, z)) continue;
      // Not in a circuit's infield: a kid looks across it to the next corner.
      if ((world.circuits || []).some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < (q.r * 1.3) ** 2)) continue;
      if (centres.some((q) => (q[0] - x) ** 2 + (q[1] - z) ** 2 < 260 * 260)) continue;
      if (L.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 120 * 120)) continue;
      centres.push([x, z]);
    }
    for (const [cx, cz] of centres) {
      const n = 4 + Math.floor(r() * 6);
      for (let k = 0; k < n; k++) {
        const a = r() * 6.28, d = k === 0 ? 0 : 6 + r() * 30;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (clearance(x, z) < 22 || inLot(x, z) || !inMap(x, z)) continue;
        ground.sample(x, z, g);
        if (g.ny < 0.93 || g.surface === 'water') continue;
        // The tallest in the middle of a stand, the young ones round it.
        const h = k === 0 ? 17 + r() * 7 : 8 + r() * 11;
        L.push({ type: 'hoodoo', x, z, y: g.y, rot: r() * 6.28, scale: h / 18, variant: Math.floor(r() * 4) });
      }
    }
  }

  // ---- The lighthouse -----------------------------------------------------------
  {
    let best = null, bs = -Infinity;
    for (let t = 0; t < 6000; t++) {
      const x = (r() * 2 - 1) * (half - 80), z = 1100 + r() * (half - 1180);
      if (bio.weightsAt(x, z, w)[3] < 0.85 || bio.seaAt(x, z) > 0) continue;
      const y = ground.heightAt(x, z);
      if (y < bio.seaLevel + 7) continue;
      const c = clearance(x, z);
      if (c < 30 || c > 240 || inLot(x, z)) continue;
      ground.sample(x, z, g);
      if (g.ny < 0.9) continue;
      // A headland: sea on as many sides as possible, close by.
      let sea = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (bio.seaAt(x + Math.cos(a) * 110, z + Math.sin(a) * 110) > 0.5) sea++;
      }
      if (sea < 5) continue;
      const sc = sea + (y - bio.seaLevel) * 0.08 - c * 0.01;
      if (sc > bs) { bs = sc; best = { x, z, y }; }
    }
    if (best) {
      // The cottage stands on the landward side.
      let ax = 0, az = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (bio.seaAt(best.x + Math.cos(a) * 110, best.z + Math.sin(a) * 110) > 0.5) { ax += Math.cos(a); az += Math.sin(a); }
      }
      L.push({ type: 'lighthouse', x: best.x, z: best.z, y: best.y, rot: Math.atan2(az, -ax), scale: 1, variant: 0 });
    }
  }

  // ---- Snow poles ------------------------------------------------------------------
  for (const e of world.edges) {
    if (e.kind === 'circuit' || e.kind === 'rallyx' || e.kind === 'track') continue;
    let k = 0;
    for (let s = 13; s < e.length - 13; s += 26, k++) {
      const p = pointOnEdge(e, s);
      if (!p || bio.weightsAt(p.x, p.z, w)[2] < 0.6 || nearJunction(p.x, p.z, 24)) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const off = e.width * 0.5 + 2.2;
      const x = p.x + p.nx * off * side, z = p.z + p.nz * off * side;
      if (!inMap(x, z) || clearance(x, z) < 1.4) continue;
      L.push({ type: 'snowpole', x, z, y: ground.heightAt(x, z), rot: r() * 6.28, scale: 0.9 + r() * 0.2, variant: 0 });
    }
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
    circuits: [], garages: [],
  };

  // --- The open road ------------------------------------------------------
  // One long irregular loop around the map, and the spine everything else
  // hangs off. Irregular rather than circular: a constant-radius ring is the
  // single most obvious tell that a road was generated.
  const loopCtrl = [];
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    const r = 1490 * (1 + 0.135 * Math.sin(2 * a + 0.7) + 0.085 * Math.sin(3 * a + 2.1)
                        + 0.045 * Math.sin(5 * a + 4.4));
    loopCtrl.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  loopCtrl.push({ x: loopCtrl[0].x, z: loopCtrl[0].z });
  const loopStart = addNode(world, loopCtrl[0].x, loopCtrl[0].z, 'rural');
  layRoad(world, loopCtrl, 'rural', {
    step: 10, nodeEvery: 150, kindNode: 'rural', from: loopStart, to: loopStart,
  });
  world.ringNodes = world.nodes.filter((n) => n.kind === 'rural').map((n) => n.i);

  const loopAt = (angle) => {
    let best = null, bd = Infinity;
    for (const i of world.ringNodes) {
      const n = world.nodes[i];
      const da = Math.abs(((Math.atan2(n.z, n.x) - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (da < bd) { bd = da; best = n; }
    }
    return best;
  };

  // --- Cross-country roads ------------------------------------------------
  // Chords across the middle, so the map is not one loop with nothing inside.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI + 0.31;
    const from = loopAt(a), to = loopAt(a + Math.PI);
    if (!from || !to) continue;
    layRoad(world, wander(from.x, from.z, to.x, to.z, 260, seed + 700 + i * 131, 9),
      'rural', { step: 10, nodeEvery: 150, from, to });
  }

  // --- Circuits -----------------------------------------------------------
  // Each is a closed loop with genuinely varied corners, built from a radial
  // function with a few harmonics. A radial curve cannot self-intersect, which
  // is the one failure a generated track absolutely must not have — and the
  // harmonics are what turn a circle into a lap with a character.
  const CIRCUITS = [
    { name: 'Harrowgate Circuit',  x: -880, z: -760, r: 430, kind: 'circuit', h: [0.10, 0.070, 0.040, 0.022] },
    { name: 'Vale Park',           x:  960, z:  690, r: 490, kind: 'circuit', h: [0.12, 0.055, 0.050, 0.018] },
    { name: 'Ashcombe Rise',       x: -980, z:  980, r: 360, kind: 'circuit', h: [0.09, 0.085, 0.035, 0.028] },
    { name: 'Culver Pit',          x: 1080, z: -1010, r: 340, kind: 'rallyx',  h: [0.13, 0.090, 0.055, 0.030] },
  ];
  /**
   * Nudge a circuit onto the flattest ground near where it was asked for.
   *
   * This is simply what happens in reality: you build a track where the land
   * suits it. Dropped blind, one of these landed on a ring of ground that
   * varied 123 m over a lap — and a track held to a sane gradient across that
   * needs a 55 m embankment, which no amount of blending hides. Searching a
   * few hundred metres either way costs nothing and finds ground that varies
   * by a fraction of it.
   */
  function siteCircuit(spec) {
    let best = { x: spec.x, z: spec.z, score: Infinity };
    for (let i = 0; i < 260; i++) {
      const a = (i / 260) * Math.PI * 2 * 7;
      const rad = (i / 260) * 620;
      const cx = clamp(spec.x + Math.cos(a) * rad, -HALF + spec.r + 130, HALF - spec.r - 130);
      const cz = clamp(spec.z + Math.sin(a) * rad, -HALF + spec.r + 130, HALF - spec.r - 130);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 40; k++) {
        const t = (k / 40) * Math.PI * 2;
        const h = terrain.height(cx + Math.cos(t) * spec.r, cz + Math.sin(t) * spec.r);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      // Prefer flat, and prefer staying near where the circuit was placed.
      const score = (hi - lo) + rad * 0.02;
      if (score < best.score) best = { x: cx, z: cz, score };
    }
    return best;
  }

  for (let c = 0; c < CIRCUITS.length; c++) {
    const spec = CIRCUITS[c];
    const site = siteCircuit(spec);
    spec.x = site.x; spec.z = site.z;
    const cr = mulberry(seed + 9100 + c * 37);
    const phase = [cr() * 6.283, cr() * 6.283, cr() * 6.283, cr() * 6.283];
    const ctrl = [];
    const N = 76;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const m = 1
        + spec.h[0] * Math.sin(2 * a + phase[0])
        + spec.h[1] * Math.sin(3 * a + phase[1])
        + spec.h[2] * Math.sin(5 * a + phase[2])
        + spec.h[3] * Math.sin(7 * a + phase[3]);
      ctrl.push({ x: spec.x + Math.cos(a) * spec.r * m, z: spec.z + Math.sin(a) * spec.r * m });
    }
    ctrl.push({ x: ctrl[0].x, z: ctrl[0].z });
    const start = addNode(world, ctrl[0].x, ctrl[0].z, 'circuit');
    const laid = layRoad(world, ctrl, spec.kind, {
      step: 8, nodeEvery: 260, kindNode: 'circuit', from: start, to: start,
    });
    const length = laid.edges.reduce((a, e) => a + (e.length || 0), 0);
    world.circuits.push({ name: spec.name, x: spec.x, z: spec.z, r: spec.r, kind: spec.kind, start });
    // Circuits double as the map's landmarks now that there are no districts.
    world.villages.push({ name: spec.name, x: spec.x, z: spec.z });

    // An access road, so a circuit is somewhere you can drive TO.
    const from = loopAt(Math.atan2(spec.z, spec.x));
    if (from) {
      layRoad(world, wander(from.x, from.z, ctrl[0].x, ctrl[0].z, 90, seed + 4200 + c * 53, 5),
        'rural', { step: 10, nodeEvery: 140, from, to: start });
    }
  }

  // --- Gravel stages ------------------------------------------------------
  // The point of the map. Long, connected, climbing into the hills.
  ensurePolylines(world);
  const anchors = world.nodes.filter((n) => n.kind === 'rural');
  let laidGravel = 0;
  for (let i = 0; i < 26 && anchors.length; i++) {
    const kind = i % 5 === 0 ? 'dirt' : 'gravel';
    let ctrl = null, from = null;
    for (let attempt = 0; attempt < 8 && !ctrl; attempt++) {
      from = anchors[Math.floor(rnd() * anchors.length)];
      const a = rnd() * Math.PI * 2;
      const len = 480 + rnd() * 900;
      const tx = clamp(from.x + Math.cos(a) * len, -world.half + 110, world.half - 110);
      const tz = clamp(from.z + Math.sin(a) * len, -world.half + 110, world.half - 110);
      if (Math.hypot(tx - from.x, tz - from.z) < 320) continue;
      const c = wander(from.x, from.z, tx, tz, 230, seed + 3300 + i * 71 + attempt * 17, 8);
      if (pathOverlapFraction(world, c, ROAD[kind].width) < 0.12) ctrl = c;
    }
    if (!ctrl) continue;
    const laid = layRoad(world, ctrl, kind, { step: 8, nodeEvery: 130, from });
    laidGravel++;
    // Two thirds loop back, so a stage is a route rather than a dead end.
    if (rnd() < 0.66 && laid.to) {
      const back = nearestNode(world, laid.to.x, laid.to.z, (n) =>
        n.kind === 'rural' && Math.hypot(n.x - laid.to.x, n.z - laid.to.z) > 300);
      if (back) {
        const c2 = wander(laid.to.x, laid.to.z, back.x, back.z, 200, seed + 4400 + i * 53, 7);
        if (pathOverlapFraction(world, c2, ROAD.gravel.width) < 0.15) {
          layRoad(world, c2, 'gravel', { step: 8, nodeEvery: 130, from: laid.to, to: back });
        }
      }
    }
  }
  world.gravelStages = laidGravel;

  ensurePolylines(world);
  world.crossingsResolved = resolveCrossings(world);
  densify(world);

  // --- Biomes -------------------------------------------------------------
  // After the roads are laid and before they are graded: the relief is held
  // off every carriageway by a mask built from these exact polylines, so the
  // grading below sees mountains and mesas only where no road goes — except
  // the broad alpine rise, which the northern roads are meant to climb.
  world.biomes = buildBiomes(world, terrain);
  terrain.setRelief(world.biomes);
  setActiveBiomes(world.biomes);
  // Named on the maps like districts: the HUD minimap points at them from
  // its rim when they are out of view, which is half of wanting to go there.
  for (let b = 0; b < BIOMES.length; b++) {
    const B = BIOMES[b];
    world.districts.push({
      id: 'b_' + B.key, name: B.name, cx: B.at[0], cz: B.at[1], rot: 0,
      cols: 0, rows: 0, cell: 0, kind: 'biome', biome: b, r: 240,
    });
  }

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
  world.landmarks = [];
  world.buildProps = (ground) => buildProps(world, rnd, ground);
  return world;
}
