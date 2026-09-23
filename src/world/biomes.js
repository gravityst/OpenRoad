// Biomes: which kind of country a point is in, and what that does to the land.
//
// Until this file the whole map was one landscape — green farmland, woods and
// a dry river bed — and anywhere outside a circuit the HUD said "Open country".
// The kids asked for more, so the map is now five places a child can name from
// the first glance, arranged round a farmland heartland the way a compass is:
//
//              N   Frostpeak Pass    snow rising with the ground, snowy pines,
//                                    a wall of peaks along the north edge
//   W  Red Canyon        Greenmeadow Farms        Amberleaf Woods  E
//      red rock, mesas,  the old countryside:     orange, red and gold
//      buttes, cacti,    fields, hedges, woods    canopies, leaf litter
//      canyon roads
//              S   Sunspray Bay      a real sea with a beach, cliffs, palms
//
// The layout is fixed to the compass on purpose — the sea is south so the noon
// sun glitters on it, the peaks are north because nothing on the map reaches
// that strip (every road stops short of z = -1540, measured) — and everything
// else comes from the seed: where the borders wander, where the mesas stand,
// the shape of the coastline. Every multiplayer client builds the same world
// because every number here is a pure function of the seed and the road graph,
// which is itself a pure function of the seed.
//
// WEIGHTS, NOT LABELS
//
// A point is not "in" a biome; it has a weight for each of the five, summing to
// one, and everything downstream blends by weight — ground colour, relief, the
// trees, the sky. That is what makes the borders a few hundred metres of
// gradual change instead of a line where the grass turns to sand. The weights
// are a soft arg-max over five scores (below), and because the sigmoid is
// quintic they are C2: no crease in anything built from them.
//
// RELIEF, AND WHY IT NEVER TOUCHES A ROAD
//
// Mountains, mesas and the sea floor are heights ADDED to the base terrain, and
// they are held off the road network by a mask: zero within ~40 m of a road
// edge, full strength a few dozen metres further out. The elevation solver,
// the stamped height field and every harness that measures them (ground, goals)
// only ever see the ground within 40 m of a carriageway, so the roads are graded
// exactly as before and every race, jump and speed trap stays where it was.
// A mesa that straddles a road becomes a canyon with the road down the middle
// of it — which is precisely the red-canyon drive the brief asked for. The one
// exception is the alpine uplift: a broad rise of up to 36 m over a kilometre,
// so the northern roads genuinely climb into the snow like a pass should. It is
// gentle enough (under 6% added grade) that the solver grades it like any hill.
//
// The relief is precomputed once into an 8 m grid and read back bicubically
// (C1, like ground.js's own field), so terrain.height() costs one grid lookup
// more than it did — 0.05 us on 0.30 — rather than another dozen noise calls.
//
// Pure data and arithmetic: no three.js, no DOM. Headless harnesses build the
// same field the browser does.

import { fbm, ridged, valueNoise, hash2, smoothstep, clamp, lerp } from './noise.js';

export const BIOME = { farm: 0, desert: 1, alpine: 2, coast: 3, autumn: 4 };
export const BIOME_COUNT = 5;

// Invented names, every one (tools/brandcheck.mjs). `at` is where the map puts
// the label: on the biome's own axis, well inside it, beside the loop road.
// `tint` is the colour the map and HUD may use for the region.
export const BIOMES = [
  { key: 'farm',   name: 'Greenmeadow Farms', at: [160, 140],    tint: [0.44, 0.58, 0.30] },
  { key: 'desert', name: 'Red Canyon',        at: [-1520, 80],   tint: [0.78, 0.40, 0.22] },
  { key: 'alpine', name: 'Frostpeak Pass',    at: [60, -1480],   tint: [0.86, 0.92, 0.98] },
  { key: 'coast',  name: 'Sunspray Bay',      at: [-80, 1540],   tint: [0.24, 0.62, 0.78] },
  { key: 'autumn', name: 'Amberleaf Woods',   at: [1500, -60],   tint: [0.88, 0.52, 0.16] },
];

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

// The heartland's score is R_FARM - r, the outer biomes' are the projections
// of the point on their compass axis. So the farmland is a rounded diamond:
// 875 m out along an axis, about 1025 m out along a diagonal — and the spawn
// (0, -260) and the first race sit well inside it.
const R_FARM = 1750;
// Metres of score difference over which one biome hands over to the next. The
// farm-to-outer score changes 2 per metre, so that border is 190 m deep; two
// outer biomes meet at a diagonal where the gap opens at about 1.4 per metre,
// so those borders are about 270 m deep. Deep enough to read as a change in
// the country rather than a line; shallow enough that each biome is a place.
const BLEND = 190;

function sig(t) {
  const u = 0.5 + t * 0.5;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (u * (u * 6 - 15) + 10);
}

const _score = new Float64Array(BIOME_COUNT);

/**
 * The five weights at (x, z), analytically. Writes out[0..4] and returns it.
 * Arithmetic only (fbm is floor, multiply and add; the root is IEEE-exact), so
 * two browsers agree to the bit rather than to the last ulp of a Math.exp.
 * About 0.3 us; the runtime reads the baked grid instead (weightsAt).
 */
export function biomeWeights(x, z, seed, out) {
  const s = seed | 0;
  // The borders wander by up to ~350 m: a slow warp for the big bays and
  // promontories of one biome into the next, and a faster one so no border
  // is a smooth arc.
  const wx = x + fbm(x / 1700, z / 1700, s + 301, 2) * 280 + fbm(x / 430, z / 430, s + 303, 2) * 70;
  const wz = z + fbm(x / 1700, z / 1700, s + 302, 2) * 280 + fbm(x / 430, z / 430, s + 304, 2) * 70;
  const r = Math.sqrt(wx * wx + wz * wz);
  _score[BIOME.farm] = R_FARM - r;
  _score[BIOME.desert] = -wx;
  _score[BIOME.alpine] = -wz;
  _score[BIOME.coast] = wz;
  _score[BIOME.autumn] = wx;
  let sum = 0;
  for (let i = 0; i < BIOME_COUNT; i++) {
    let w = 1;
    for (let j = 0; j < BIOME_COUNT && w > 0; j++) {
      if (j !== i) w *= sig((_score[i] - _score[j]) / BLEND);
    }
    out[i] = w;
    sum += w;
  }
  // The leader's product is at least 0.5^4, so the sum can never reach zero.
  const inv = 1 / sum;
  for (let i = 0; i < BIOME_COUNT; i++) out[i] *= inv;
  return out;
}

/**
 * How much snow lies at a point, 0..1, given its alpine weight and height.
 * In the heart of the alpine biome everything is white, verges included; at
 * its margin only the high ground is, so the snow line visibly climbs the
 * hills as you leave. The two noises break the line into drifts and bare
 * patches instead of a contour.
 */
export function snowAmount(wAlpine, x, z, h, seed) {
  if (wAlpine < 0.02) return 0;
  const s = seed | 0;
  const v = wAlpine + (h + 20) / 140 + fbm(x / 260, z / 260, s + 481, 2) * 0.07
          + valueNoise(x / 31, z / 31, s + 482) * 0.035;
  return smoothstep(0.45, 0.62, v);
}

// ---------------------------------------------------------------------------
// The registry the sky reads
// ---------------------------------------------------------------------------
// The sky layer is built from (scene, renderer) and never sees the world, but
// it wants to know which biome the camera is in to tint the air and make it
// snow. One page runs one world, so the last field built is the one on screen.
let ACTIVE = null;
export function setActiveBiomes(field) { ACTIVE = field; }
export function activeBiomes() { return ACTIVE; }

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

// The baked grids reach well past the map edge (+-2048): the terrain streams a
// kilometre past the camera, and the camera can stand at the edge. Past this
// the relief is evaluated analytically, which costs more but only happens a
// kilometre and a half outside the map.
const EXT = 3456;
const WC = 16;                       // weights and road distance, metres per cell
const WN = Math.round((2 * EXT) / WC) + 1;
const FC = 8;                        // relief, metres per cell
const FN = Math.round((2 * EXT) / FC) + 1;

// How far the relief stays off a road, measured from the carriageway EDGE.
// tools/groundcheck.mjs samples the verge out to 40 m from the centreline and
// ground.js blends the carriageway into the terrain over 3 + 26 m beyond the
// shoulder, so nothing inside 38 m of an edge may move. Past that the ramps
// differ by feature. A mountain flank is faded in over 150 m (a 190 m peak
// over less would be an overhang). A canyon wall is not faded at all but
// CAPPED: the rock may rise at most WALL metres per metre of distance from
// the road, so where a mesa meets a road it stands as a straight wall at
// that slope — 62 degrees — instead of the mesa's own cliff and a fade
// adding up to something steeper than the ground can hold (a fade over 34 m
// did exactly that: normal y 0.248 against the 0.25 floor).
const KEEP = 38;
const WALL = 1.9;
const RAMP_COAST = 100;
const RAMP_PEAK = 150;
const REACH = KEEP + RAMP_PEAK + 8;
const RAMP_CANYON = 0;   // (capped, see WALL)

// Mesas and buttes: one candidate per 300 m cell. Tablelands, the big flat
// tops a canyon is cut through: one candidate per 650 m cell.
const MESA_CELL = 300;
const TABLE_CELL = 650;

/**
 * Build the field for a world whose roads are laid (XZ) but not yet graded.
 * `terrain` is makeTerrain()'s object with no relief attached yet; the caller
 * attaches the result with terrain.setRelief(field) before grading the roads.
 */
export function buildBiomes(world, terrain) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Always the BASE height: once the field is attached, terrain.height() reads
  // the relief, and the relief asking terrain.height() would ask itself.
  const baseH = terrain.baseHeight || terrain.height;
  const seed = world.seed | 0;
  const s = seed;
  const half = world.half;

  // ---- weights, 16 m ------------------------------------------------------
  const W = new Float32Array(WN * WN * BIOME_COUNT);
  const tmp = new Float64Array(BIOME_COUNT);
  for (let j = 0; j < WN; j++) {
    const z = -EXT + j * WC;
    for (let i = 0; i < WN; i++) {
      biomeWeights(-EXT + i * WC, z, seed, tmp);
      const o = (j * WN + i) * BIOME_COUNT;
      for (let b = 0; b < BIOME_COUNT; b++) W[o + b] = tmp[b];
    }
  }

  /** Bilinear weights from the 16 m grid. Writes out[0..4]. */
  function weightsAt(x, z, out) {
    let fx = (x + EXT) / WC, fz = (z + EXT) / WC;
    if (fx < 0) fx = 0; else if (fx > WN - 1.001) fx = WN - 1.001;
    if (fz < 0) fz = 0; else if (fz > WN - 1.001) fz = WN - 1.001;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const o00 = (j * WN + i) * BIOME_COUNT, o10 = o00 + BIOME_COUNT;
    const o01 = o00 + WN * BIOME_COUNT, o11 = o01 + BIOME_COUNT;
    const a = (1 - tx) * (1 - tz), b = tx * (1 - tz), c = (1 - tx) * tz, d = tx * tz;
    for (let k = 0; k < BIOME_COUNT; k++) {
      out[k] = W[o00 + k] * a + W[o10 + k] * b + W[o01 + k] * c + W[o11 + k] * d;
    }
    return out;
  }

  // ---- distance to the nearest carriageway edge, 16 m ---------------------
  // A nearest-point transform rather than a brute-force stamp. Stamping every
  // segment into every cell within reach was ten million point-to-segment
  // tests and 80 ms of boot; instead each cell within a cell or two of a road
  // gets the EXACT nearest point on it, and two sweeps hand those points on to
  // their neighbours (the 8SSEDT idea, carrying the point rather than just a
  // distance, so what arrives is a true Euclidean distance to a real point on
  // a real road). 3 ms, and the masks built from it ramp over 34 to 150 m, far
  // wider than any error it could leave.
  const D = new Float32Array(WN * WN).fill(REACH);
  const NX = new Float32Array(WN * WN), NZ = new Float32Array(WN * WN), NH = new Float32Array(WN * WN);
  const SEED = WC * 1.6;
  for (const e of world.edges) {
    const pts = e.pts;
    if (!pts || pts.length < 2) continue;
    const hw = e.width * 0.5;
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1].x, az = pts[k - 1].z, bx = pts[k].x, bz = pts[k].z;
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - SEED + EXT) / WC));
      const i1 = Math.min(WN - 1, Math.ceil((Math.max(ax, bx) + SEED + EXT) / WC));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - SEED + EXT) / WC));
      const j1 = Math.min(WN - 1, Math.ceil((Math.max(az, bz) + SEED + EXT) / WC));
      for (let j = j0; j <= j1; j++) {
        const z = -EXT + j * WC;
        for (let i = i0; i <= i1; i++) {
          const x = -EXT + i * WC;
          let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t, pz = az + dz * t;
          const ex = x - px, ez = z - pz;
          const d = Math.sqrt(ex * ex + ez * ez) - hw;
          const c = j * WN + i;
          if (d < D[c]) { D[c] = d; NX[c] = px; NZ[c] = pz; NH[c] = hw; }
        }
      }
    }
  }
  const pass = (c, n, x, z) => {
    if (D[n] >= REACH) return;
    const ex = x - NX[n], ez = z - NZ[n];
    const d = Math.sqrt(ex * ex + ez * ez) - NH[n];
    if (d < D[c]) { D[c] = d; NX[c] = NX[n]; NZ[c] = NZ[n]; NH[c] = NH[n]; }
  };
  for (let j = 0; j < WN; j++) {
    const z = -EXT + j * WC;
    for (let i = 0; i < WN; i++) {
      const c = j * WN + i, x = -EXT + i * WC;
      if (i > 0) pass(c, c - 1, x, z);
      if (j > 0) {
        pass(c, c - WN, x, z);
        if (i > 0) pass(c, c - WN - 1, x, z);
        if (i < WN - 1) pass(c, c - WN + 1, x, z);
      }
    }
    for (let i = WN - 2; i >= 0; i--) pass(j * WN + i, j * WN + i + 1, -EXT + i * WC, z);
  }
  for (let j = WN - 1; j >= 0; j--) {
    const z = -EXT + j * WC;
    for (let i = WN - 1; i >= 0; i--) {
      const c = j * WN + i, x = -EXT + i * WC;
      if (i < WN - 1) pass(c, c + 1, x, z);
      if (j < WN - 1) {
        pass(c, c + WN, x, z);
        if (i < WN - 1) pass(c, c + WN + 1, x, z);
        if (i > 0) pass(c, c + WN - 1, x, z);
      }
    }
    for (let i = 1; i < WN; i++) pass(j * WN + i, j * WN + i - 1, -EXT + i * WC, z);
  }
  for (let c = 0; c < D.length; c++) if (D[c] > REACH) D[c] = REACH;
  function roadDist(x, z) {
    let fx = (x + EXT) / WC, fz = (z + EXT) / WC;
    if (fx < 0 || fz < 0 || fx > WN - 1.001 || fz > WN - 1.001) return REACH;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const c = j * WN + i;
    return (D[c] * (1 - tx) + D[c + 1] * tx) * (1 - tz) + (D[c + WN] * (1 - tx) + D[c + WN + 1] * tx) * tz;
  }

  // Circuits keep their infields: a butte in the middle of a race track hides
  // half the lap from the grandstand, and a kid looks across the infield to
  // see where the next corner goes.
  const circuits = world.circuits || [];
  function circuitClear(x, z) {
    let k = 1;
    for (let c = 0; c < circuits.length; c++) {
      const q = circuits[c];
      const dx = x - q.x, dz = z - q.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      k *= smoothstep(q.r * 1.12, q.r * 1.42, d);
    }
    return k;
  }

  // ---- sea level ------------------------------------------------------------
  // Pinned below every road the coast holds, with four metres to spare, so no
  // carriageway anywhere is ever under water: the lowest road point south of
  // z = 1100 stands at -54.3 m on the default seed, which puts the sea at
  // -58.3 m. The coastline itself is made by the relief, not by this number.
  let lowRoad = Infinity;
  for (const e of world.edges) {
    for (const p of e.pts) {
      if (p.z < 1100) continue;
      const h = baseH(p.x, p.z);
      if (h < lowRoad) lowRoad = h;
    }
  }
  const seaLevel = Math.round((Math.min(-46, (Number.isFinite(lowRoad) ? lowRoad : -46) - 4)) * 10) / 10;
  // The sea floor the physics stands on. A car that drives into the sea wades
  // rather than sinking: the "floor" under the water is 45 cm down, which puts
  // the water over the sills and the wheels half under — and the water surface
  // (ground.SURFACES.water) drags it to a crawl. Nothing about the sea can
  // strand a car or swallow it.
  const floorY = seaLevel - 0.45;

  // ---- the features themselves --------------------------------------------
  const warpN = (x, z) => fbm(x / 1400, z / 1400, s + 411, 2) * 160;

  /** Regional alpine rise, unmasked: the northern roads climb into the snow. */
  function alpineUplift(x, z) {
    const wz = z + warpN(x, z);
    return 36 * smoothstep(-850, -1750, wz);
  }

  /** Peaks and foothills, masked off the roads. */
  function alpinePeaks(x, z) {
    const wz = z + warpN(x, z);
    let h = 0;
    const north = smoothstep(-1050, -2150, wz);
    if (north > 0) {
      const r = ridged(x / 780, z / 780, s + 421, 3);
      const k = clamp((r + 0.3) / 1.3, 0, 1);
      h += k * Math.sqrt(k) * 190 * north;
    }
    const hills = smoothstep(-600, -1250, wz);
    if (hills > 0) h += (fbm(x / 420, z / 420, s + 431, 3) * 0.5 + 0.5) * 30 * hills;
    return h;
  }

  /**
   * A mesa's section: a flat cap, a cliff of caprock, and a talus apron.
   * `t` is distance over radius. The cliff is designed to 1.7:1 (60 degrees)
   * and the talus to 0.45:1, and the ragged rim below can steepen either by
   * at most half as much again — so the steepest ground on the map stays
   * inside what ground.sample()'s normals and groundcheck (ny > 0.25) allow.
   */
  function mesaProfile(t, R, H) {
    const t1 = 0.8;
    const wc = Math.max(0.1 * R, (0.62 * H * 1.5) / 1.7);
    const t2 = t1 + wc / R;
    if (t <= t1) return H;
    if (t <= t2) return H - 0.62 * H * smoothstep(t1, t2, t);
    const wt = Math.max(0.35 * R, (0.38 * H * 1.5) / 0.45);
    const t3 = t2 + wt / R;
    if (t >= t3) return 0;
    const u = (t - t2) / (t3 - t2);
    return 0.38 * H * (1 - u) * (1 - u);
  }

  // One candidate mesa per cell, drawn once: centre, radius, height, or radius
  // 0 for an empty cell. Looked up rather than re-hashed, because the bake
  // asks nine cells for every one of 180,000 desert points. Two tables: mesas
  // and buttes (42-162 m across the top, 20-66 m high), and tablelands
  // (150-260 m, 32-46 m) — built the same way, so every cliff in the canyon
  // country is held to the same slope by the same profile.
  function mesaTable(cell, salt, occupancy, r0, r1, h0, h1, buttes) {
    const n = Math.ceil((2 * EXT) / cell) + 4;
    const o0 = Math.floor(-EXT / cell) - 2;
    const t = new Float32Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const cx = o0 + i, cz = o0 + j, o = (j * n + i) * 4;
        if (hash2(cx, cz, s + salt) > occupancy) continue;
        const R = r0 + hash2(cx, cz, s + salt + 3) * (r1 - r0);
        t[o] = (cx + 0.2 + hash2(cx, cz, s + salt + 1) * 0.6) * cell;
        t[o + 1] = (cz + 0.2 + hash2(cx, cz, s + salt + 2) * 0.6) * cell;
        t[o + 2] = R;
        t[o + 3] = h0 + hash2(cx, cz, s + salt + 4) * (h1 - h0) + (buttes && R < 80 ? 20 : 0);
      }
    }
    return { t, n, o0, cell };
  }
  const MESAS = mesaTable(MESA_CELL, 451, 0.6, 42, 162, 20, 46, true);
  const TABLES = mesaTable(TABLE_CELL, 471, 0.55, 150, 260, 32, 46, false);

  // The canyon a kid will actually drive: tablelands centred ON the desert's
  // own rural roads, a few hundred metres apart. The road mask then cuts each
  // one down to the carriageway, so the road runs along a canyon floor 76 m
  // wide between 40 m walls — Red Canyon, in so many words. Chosen in edge
  // order from the seed's own road graph, so every client picks the same.
  const anchors = [];
  {
    const aw = new Float64Array(BIOME_COUNT);
    for (const e of world.edges) {
      if (e.kind !== 'rural' || anchors.length >= 16) continue;
      for (let k = 0; k < e.pts.length; k += 6) {
        const p = e.pts[k];
        biomeWeights(p.x, p.z, seed, aw);
        if (aw[BIOME.desert] < 0.93) continue;
        let clear = true;
        for (let a = 0; a < anchors.length; a += 4) {
          const dx = anchors[a] - p.x, dz = anchors[a + 1] - p.z;
          if (dx * dx + dz * dz < 520 * 520) { clear = false; break; }
        }
        if (!clear) continue;
        anchors.push(p.x, p.z, 185 + hash2(anchors.length, 7, s + 491) * 50, 38 + hash2(anchors.length, 9, s + 492) * 8);
        if (anchors.length >= 16) break;
      }
    }
  }

  function mesaMax(tab, x, z, h) {
    const { t, n, o0, cell } = tab;
    const ix = Math.floor(x / cell) - o0, iz = Math.floor(z / cell) - o0;
    for (let j = -1; j <= 1; j++) {
      const jj = iz + j;
      if (jj < 0 || jj >= n) continue;
      for (let i = -1; i <= 1; i++) {
        const ii = ix + i;
        if (ii < 0 || ii >= n) continue;
        const o = (jj * n + ii) * 4;
        const R = t[o + 2];
        if (R === 0) continue;
        const m = mesaAt(x, z, t[o], t[o + 1], R, t[o + 3]);
        if (m > h) h = m;
      }
    }
    return h;
  }
  function mesaAt(x, z, px, pz, R, H) {
    const dx = x - px, dz = z - pz;
    const d0 = Math.sqrt(dx * dx + dz * dz);
    if (d0 > R * 2.4 + 60) return 0;
    // A ragged rim: no mesa is a circle. The wobble is measured in metres, not
    // in radii, and kept slow: its gradient adds straight onto the distance's,
    // and the first version (R x 0.14 at 42 m) stretched it up to fourfold,
    // which is a cliff four times as steep as the profile meant.
    const d = d0 + valueNoise(x / 130, z / 130, s + 456) * Math.min(R * 0.13, 18)
                 + valueNoise(x / 34, z / 34, s + 457) * 2.2;
    return mesaProfile(d / R, R, H);
  }

  /** Tablelands, mesas and buttes, masked off the roads with a steep ramp. */
  function desertRelief(x, z) {
    let h = mesaMax(TABLES, x, z, 0);
    h = mesaMax(MESAS, x, z, h);
    for (let a = 0; a < anchors.length; a += 4) {
      const m = mesaAt(x, z, anchors[a], anchors[a + 1], anchors[a + 2], anchors[a + 3]);
      if (m > h) h = m;
    }
    return h;
  }

  /** The coastline, as the z of the waterline's datum for each x. */
  function coastline(x) {
    return 1575 + fbm(x / 820, 0.37, s + 461, 2) * 130 + fbm(x / 240, 0.71, s + 462, 2) * 45;
  }
  function cliffiness(x) {
    return smoothstep(0.02, 0.26, fbm(x / 640, 0.9, s + 463, 2));
  }
  /**
   * The ground the coast wants at (x, z), given the base terrain there.
   * Offshore it falls away under the water; onshore it eases down to a sand
   * beach at 5% — where the base land is low — or holds up and drops as a cliff
   * where it is high and the cliff noise says so. Never raises land.
   */
  function coastTarget(x, z, base, line, cliffK) {
    const sd = z - line;                                   // + is offshore
    const shoreY = seaLevel + 1.5 - 0.05 * sd;
    const deep = shoreY - smoothstep(35, 420, sd) * 30;
    if (sd >= 0) return Math.min(base, deep);
    const cliff = cliffK * smoothstep(8, 24, base - seaLevel);
    // The drop is held to about 2.4:1 (67 degrees) at its steepest however
    // high the land stands: the blend is never shorter than 1.1 m per metre
    // of drop, and the power that pushes the drop toward the waterline is
    // what makes it a cliff rather than a long slope.
    const L = Math.max(lerp(260, 42, cliff), (base - seaLevel) * 1.1);
    let k = smoothstep(-L, 0, sd);
    if (cliff > 0) k = Math.pow(k, 1 + cliff * 1.2);
    return lerp(base, Math.min(base, deep), k);
  }

  const wq = new Float64Array(BIOME_COUNT);

  /**
   * Relief at a point, given its weights and road distance. The same function
   * builds the grid and, past the grid, answers directly.
   */
  function reliefRaw(x, z, w, dRoad, clearK, line, cliffK, baseKnown) {
    let F = 0;
    const wa = w[BIOME.alpine], wd = w[BIOME.desert], wc = w[BIOME.coast];
    if (wa > 1e-3) {
      const m = smoothstep(KEEP, KEEP + RAMP_PEAK, dRoad) * clearK;
      F += wa * (alpineUplift(x, z) + (m > 0 ? m * alpinePeaks(x, z) : 0));
    }
    if (wd > 1e-3 && dRoad > KEEP && clearK > 0) {
      const cap = (dRoad - KEEP) * WALL;
      const d = desertRelief(x, z);
      F += wd * clearK * (d < cap ? d : cap);
    }
    if (wc > 1e-3) {
      const m = smoothstep(KEEP, KEEP + RAMP_COAST, dRoad) * clearK;
      if (m > 0) {
        const base = baseKnown === undefined ? baseH(x, z) : baseKnown;
        F += wc * m * (coastTarget(x, z, base, line, cliffK) - base);
      }
    }
    return F;
  }

  // ---- bake the relief, 8 m -------------------------------------------------
  // The sea band is everything south of SEA_Z0: nothing north of it can be
  // sea (the coastline wanders between z = 1400 and 1750, and no ground north
  // of 960 is within 3 m of sea level). Its base heights are kept from the
  // bake, which needs them for the coast anyway, so each is computed once.
  const SEA_Z0 = 960;
  const sj0 = Math.round((SEA_Z0 + EXT) / FC);
  const SR = FN - sj0;                     // rows in the sea band
  const seaMask = new Uint8Array(SR * FN);
  const seaDepth = new Float32Array(SR * FN);
  const baseBand = new Float32Array(SR * FN);
  const F = new Float32Array(FN * FN);
  const lineCol = new Float64Array(FN), cliffCol = new Float64Array(FN);
  for (let i = 0; i < FN; i++) {
    const x = -EXT + i * FC;
    lineCol[i] = coastline(x);
    cliffCol[i] = cliffiness(x);
  }
  for (let j = 0; j < FN; j++) {
    const z = -EXT + j * FC;
    const band = j >= sj0;
    for (let i = 0; i < FN; i++) {
      const x = -EXT + i * FC;
      let base;
      if (band) { base = baseH(x, z); baseBand[(j - sj0) * FN + i] = base; }
      weightsAt(x, z, wq);
      if (wq[BIOME.farm] + wq[BIOME.autumn] > 0.999) continue;
      F[j * FN + i] = reliefRaw(x, z, wq, roadDist(x, z), circuitClear(x, z), lineCol[i], cliffCol[i], base);
    }
  }

  // ---- the sea ----------------------------------------------------------------
  // Everything in the band whose ground sits below sea level AND connects to
  // the open water at the southern edge of the grid is sea. The flood fill is
  // what keeps a low hollow inland from turning into a pond the physics does
  // not know about.
  {
    const hBand = new Float32Array(SR * FN);
    for (let r = 0; r < SR; r++) {
      for (let i = 0; i < FN; i++) hBand[r * FN + i] = baseBand[r * FN + i] + F[(sj0 + r) * FN + i];
    }
    const stack = new Int32Array(SR * FN);
    let sp = 0;
    for (let i = 0; i < FN; i++) {
      const c = (SR - 1) * FN + i;
      if (hBand[c] < seaLevel) { seaMask[c] = 1; stack[sp++] = c; }
    }
    while (sp > 0) {
      const c = stack[--sp];
      const r = (c / FN) | 0, i = c - r * FN;
      if (i > 0 && !seaMask[c - 1] && hBand[c - 1] < seaLevel) { seaMask[c - 1] = 1; stack[sp++] = c - 1; }
      if (i < FN - 1 && !seaMask[c + 1] && hBand[c + 1] < seaLevel) { seaMask[c + 1] = 1; stack[sp++] = c + 1; }
      if (r > 0 && !seaMask[c - FN] && hBand[c - FN] < seaLevel) { seaMask[c - FN] = 1; stack[sp++] = c - FN; }
      if (r < SR - 1 && !seaMask[c + FN] && hBand[c + FN] < seaLevel) { seaMask[c + FN] = 1; stack[sp++] = c + FN; }
    }
    // The floor. Stored as relief, so height() needs no special case: under
    // the sea the ground is max(true bed, floorY), and the true bed is kept
    // for the water's colour. Bicubic reading rounds the crease at the edge
    // of the shelf over one cell.
    for (let c = 0; c < SR * FN; c++) {
      if (!seaMask[c]) continue;
      const h = hBand[c];
      seaDepth[c] = seaLevel - h;
      if (h < floorY) F[sj0 * FN + c] = floorY - baseBand[c];
    }
  }

  // ---- reading the relief back ----------------------------------------------
  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                  (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  const wr = new Float64Array(BIOME_COUNT);

  /** Metres of relief at (x, z): bicubic from the grid, C1 everywhere. */
  function relief(x, z) {
    const fx = (x + EXT) / FC, fz = (z + EXT) / FC;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    if (i0 >= 1 && j0 >= 1 && i0 <= FN - 3 && j0 <= FN - 3) {
      const tx = fx - i0, tz = fz - j0;
      let b = (j0 - 1) * FN + i0 - 1;
      const r0 = cr(F[b], F[b + 1], F[b + 2], F[b + 3], tx); b += FN;
      const r1 = cr(F[b], F[b + 1], F[b + 2], F[b + 3], tx); b += FN;
      const r2 = cr(F[b], F[b + 1], F[b + 2], F[b + 3], tx); b += FN;
      const r3 = cr(F[b], F[b + 1], F[b + 2], F[b + 3], tx);
      return cr(r0, r1, r2, r3, tz);
    }
    // Past the grid: no roads out here, so unmasked, and open sea if it is
    // below the water in the south.
    biomeWeights(x, z, seed, wr);
    let v = reliefRaw(x, z, wr, REACH, 1, coastline(x), cliffiness(x));
    if (z > SEA_Z0) {
      const base = baseH(x, z);
      if (base + v < floorY) v = floorY - base;
    }
    return v;
  }

  /** 0..1, bilinear: how much of this point is connected open sea. */
  function seaAt(x, z) {
    const fz = (z + EXT) / FC - sj0;
    if (fz < 0) return 0;
    let fx = (x + EXT) / FC;
    if (fx < 0 || fx > FN - 1.001) return z > SEA_Z0 + 400 ? 1 : 0;
    if (fz > SR - 1.001) return 1;
    const i = fx | 0, r = fz | 0, tx = fx - i, tz = fz - r;
    const c = r * FN + i;
    return (seaMask[c] * (1 - tx) + seaMask[c + 1] * tx) * (1 - tz) +
           (seaMask[c + FN] * (1 - tx) + seaMask[c + FN + 1] * tx) * tz;
  }

  /**
   * Metres from the sea surface down to the TRUE bed, bilinear; 0 on land.
   * The physics stands on the 45 cm floor instead, but the terrain mesh draws
   * this, so the sea looks as deep as it is and the far bed never z-fights
   * the water.
   */
  function seaDepthAt(x, z) {
    const fz = (z + EXT) / FC - sj0;
    if (fz < 0) return 0;
    const fx = (x + EXT) / FC;
    if (fx < 0 || fx > FN - 1.001 || fz > SR - 1.001) return 30;
    const i = fx | 0, r = fz | 0, tx = fx - i, tz = fz - r;
    const c = r * FN + i;
    return (seaDepth[c] * (1 - tx) + seaDepth[c + 1] * tx) * (1 - tz) +
           (seaDepth[c + FN] * (1 - tx) + seaDepth[c + FN + 1] * tx) * tz;
  }

  // ---- surfaces ---------------------------------------------------------------
  const wc2 = new Float64Array(BIOME_COUNT);
  /**
   * What the ground is at a point, where the biome decides it: 'water',
   * 'sand', 'snow', 'dirt', or '' to let the base rules (rock on steep
   * ground, the river bed, farm dirt, grass) answer. `sl` is the slope in
   * radians, `h` the height with relief.
   */
  function surfaceAt(x, z, h, sl) {
    weightsAt(x, z, wc2);
    const wCoast = wc2[BIOME.coast], wDes = wc2[BIOME.desert], wAlp = wc2[BIOME.alpine];
    if (wCoast > 0.02 && h < seaLevel - 0.15 && seaAt(x, z) > 0.5) return 'water';
    if (sl > 0.62) return '';
    if (wCoast > 0.3 && sl < 0.32) {
      // The beach, and the dunes behind it where the ground is low and soft.
      const top = seaLevel + 2.4 + valueNoise(x / 55, z / 55, s + 491) * 1.4
                + smoothstep(0.1, 0.5, fbm(x / 180, z / 180, s + 492, 2)) * 5 * wCoast;
      if (h < top) return 'sand';
    }
    if (wAlp > 0.02 && snowAmount(wAlp, x, z, h, s) > 0.5) return 'snow';
    if (wDes > 0.5) {
      // Hardpan most of the way, which grips like a dirt road and throws a
      // plume; soft sand in the dune fields on the canyon floor, which does
      // not. The mesas themselves are hardpan, and rock where they are steep
      // (the base rule, above).
      if (relief(x, z) > 4) return 'dirt';
      return fbm(x / 210, z / 210, s + 495, 2) > 0.18 ? 'sand' : 'dirt';
    }
    return '';
  }

  // ---- which biome am I in, with hysteresis --------------------------------
  // The HUD asks every frame. The answer only changes when another biome
  // holds 62% of the ground, so driving along a border never flickers the
  // name, and entering reports once.
  const tr = { index: -1, name: '', entered: false };
  const wt = new Float64Array(BIOME_COUNT);
  function track(x, z) {
    weightsAt(x, z, wt);
    let best = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (wt[b] > wt[best]) best = b;
    tr.entered = false;
    if (tr.index < 0) {
      tr.index = best;
    } else if (best !== tr.index && wt[best] > 0.62) {
      tr.index = best;
      tr.entered = true;
    }
    tr.name = BIOMES[tr.index].name;
    return tr;
  }

  /** The biome with the largest weight at (x, z). */
  function dominant(x, z) {
    weightsAt(x, z, wt);
    let best = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (wt[b] > wt[best]) best = b;
    return best;
  }

  /**
   * RGBA bytes over the map, for the GPU: R desert, G snow, B autumn, A coast.
   * `heightAt` supplies the ground height the snow depends on. The props
   * layer tints canopies by it (autumn colours, dry desert scrub, snow).
   */
  function bake(size, heightAt) {
    const px = new Uint8Array(size * size * 4);
    const w = new Float64Array(BIOME_COUNT);
    const step = (2 * half) / size;
    for (let j = 0; j < size; j++) {
      const z = -half + (j + 0.5) * step;
      for (let i = 0; i < size; i++) {
        const x = -half + (i + 0.5) * step;
        weightsAt(x, z, w);
        const o = (j * size + i) * 4;
        const snow = w[BIOME.alpine] > 0.02 ? snowAmount(w[BIOME.alpine], x, z, heightAt(x, z), s) : 0;
        px[o] = w[BIOME.desert] * 255 + 0.5;
        px[o + 1] = snow * 255 + 0.5;
        px[o + 2] = w[BIOME.autumn] * 255 + 0.5;
        px[o + 3] = w[BIOME.coast] * 255 + 0.5;
      }
    }
    return { px, size, half };
  }

  /**
   * The water's view of the sea: R is sqrt(depth / 30 m) so the shallows,
   * where the colour changes fastest, get most of the precision; G is 255 for
   * connected sea. Covers x in [-EXT, EXT], z in [SEA_Z0, EXT] at 8 m.
   */
  function seaTexture() {
    const px = new Uint8Array(SR * FN * 4);
    for (let c = 0; c < SR * FN; c++) {
      const d = seaDepth[c];
      px[c * 4] = Math.sqrt(clamp(d / 30, 0, 1)) * 255 + 0.5;
      px[c * 4 + 1] = seaMask[c] ? 255 : 0;
      px[c * 4 + 2] = 0;
      px[c * 4 + 3] = 255;
    }
    return { px, width: FN, height: SR, x0: -EXT, z0: -EXT + sj0 * FC, x1: EXT, z1: EXT };
  }

  let seaCells = 0;
  for (let c = 0; c < seaMask.length; c++) seaCells += seaMask[c];
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    seed, seaLevel, floorY,
    weightsAt, dominant, relief, seaAt, seaDepthAt, surfaceAt, track, bake, seaTexture,
    snowAt: (x, z, h, wAlpine) => snowAmount(wAlpine, x, z, h, s),
    roadDist,
    /** The sea's rough extent, so the water mesh knows when it can be seen. */
    seaBounds: { zMin: SEA_Z0, xMin: -EXT, xMax: EXT, zMax: EXT },
    stats: {
      buildMs: Math.round(t1 - t0),
      seaKm2: Math.round(seaCells * FC * FC / 1e4) / 100,
      reliefCells: FN * FN, weightCells: WN * WN,
      canyons: anchors.length / 4,
    },
  };
}
