// Biomes: which kind of country a point is in, and what that does to the land.
//
// Until this file the whole map was one landscape — green farmland, woods and
// a dry river bed — and anywhere outside a circuit the HUD said "Open country".
// The kids asked for more, so the map is now five places a child can name from
// the first glance, arranged round a farmland heartland the way a compass is:
//
//              N   Frostpeak Pass    roads down valleys between snowy
//                                    peaks, rock through the snow, spruce
//   W  Red Canyon        Greenmeadow Farms        Amberleaf Woods  E
//      banded mesas,     the old countryside:     wooded hills in orange,
//      buttes, arches,   fields, hedges, woods    red and gold, leaf litter
//      hoodoos, cacti
//              S   Sunspray Bay      a real sea: beaches, sandstone cliffs,
//                                    palms and a lighthouse
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
// Mountains, mesas, the woods' hills and the sea floor are heights ADDED to the
// base terrain, and they are held off the road network: exactly zero within
// 41 m of a carriageway edge, and past that CAPPED — a feature may rise only so
// many metres per metre from the road (see KEEP). The elevation solver, the
// stamped height field and every harness that measures them (ground, goals)
// only ever see the ground within 40 m of a carriageway, so the roads are
// graded exactly as before and every race, jump and speed trap stays where it
// was. What the cap makes of a feature a road runs into is the point: a mesa
// that straddles a road becomes a canyon with the road down the middle of it,
// a mountain range becomes a valley with the road along its floor and the
// walls rising at 29-45 degrees, and the woods' knolls become hollows the
// lanes wind along. The one exception is the alpine uplift: a broad rise of
// up to 36 m over a kilometre, so the northern roads genuinely climb into the
// snow like a pass should. It is gentle enough (under 6% added grade) that the
// solver grades it like any hill.
//
// The relief is precomputed once into an 8 m grid and read back bicubically
// (C1, like ground.js's own field), so terrain.height() costs one grid lookup
// more than it did — 0.05 us on 0.30 — rather than another dozen noise calls.
//
// Pure data and arithmetic: no three.js, no DOM. Headless harnesses build the
// same field the browser does.

import { fbm, ridgedMF, gradNoise, valueNoise, hash2, smoothstep, clamp, lerp } from './noise.js';

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
// farm-to-outer score changes 2 per metre, so that border is 280 m deep; two
// outer biomes meet at a diagonal where the gap opens at about 1.4 per metre,
// so those borders are about 400 m deep. Where the warp below folds a border
// it can squeeze to about a third of that: tools/biomecheck.mjs holds the
// narrowest anywhere on the map to 100 m. Deep enough to read as a change in
// the country rather than a line; shallow enough that each biome is a place.
const BLEND = 280;

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
  // The borders wander by up to ~320 m: a slow warp for the big bays and
  // promontories of one biome into the next, and a faster, gentler one so no
  // border is a smooth arc. (At 70 m the fast one folded borders down to a
  // 75 m handover; at 40 m the narrowest is over 100.)
  const wx = x + fbm(x / 1700, z / 1700, s + 301, 2) * 280 + fbm(x / 430, z / 430, s + 303, 2) * 40;
  const wz = z + fbm(x / 1700, z / 1700, s + 302, 2) * 280 + fbm(x / 430, z / 430, s + 304, 2) * 40;
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
  // Across the border the noise is wider than the ramp, so the snow line
  // breaks up into fields of snow reaching out into the grass and green
  // patches melted out of the snow, over about 150 m; it is scaled by
  // w(1 - w), so the heart of the pass is white and the farmland green all
  // the same. With a fixed, small noise the line followed the biome
  // weight's contour and crossed it in 15 m: from the air, a curve where
  // the grass stopped and the snow began.
  const edge = 4 * wAlpine * (1 - wAlpine);
  const v = wAlpine + (h + 20) / 140 + (fbm(x / 180, z / 180, s + 481, 2) * 0.3
          + valueNoise(x / 43, z / 43, s + 482) * 0.1) * edge;
  return smoothstep(0.38, 0.72, v);
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
// shoulder, so nothing inside 38 m of an edge may move. Past that each
// feature is not faded in but CAPPED: it may rise at most so many metres per
// metre of distance from the road. Where the land wants to be higher than the
// cap allows, what stands beside the road is a slope at exactly that grade —
// a canyon wall, a mountainside — and where it does not, the land is simply
// itself. A fade (the first version) multiplies the feature instead, and
// its slope then adds the feature's own to the fade's: over 34 m that put
// a mesa's flank at normal y 0.248 against the 0.25 floor, and over the 210
// m it took to hold a mountain under it, it pushed every peak a quarter of a
// kilometre back from the pass and left the road on a white plain.
// KEEP_AT is KEEP plus 3 m of margin for the distance grid: read bilinearly
// at 16 m, it can put a cell a metre or two further from a road than it is,
// and without the margin that leaked 2 cm of relief onto a verge.
const KEEP = 38;
const KEEP_AT = KEEP + 3;
const WALL = 1.9;           // canyon walls: 62 degrees
const RAMP_COAST = 100;
// The distance grid is exact out to REACH and saturates there. A mountain
// wall rising at its gentlest grade must clear the highest peak before
// then, or the cap would shave the summits of a range no road goes near.
const REACH = 640;

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

  // The mountains. A ridged multifractal of gradient noise (noise.js) on a
  // warped domain, a kilometre to a wavelength: ranges that branch and
  // wander, knife-edged at the crest and smooth in the valleys between, on a
  // massif that rises toward the north edge of the map and carries on past
  // it, so the world ends in a wall of peaks rather than a drop. Up to 280 m
  // of range on up to 150 m of massif; at those numbers the steepest 1% of
  // the ground is 1.2:1 (50 degrees) and the very steepest 1.9:1 — inside
  // the 0.3 normal floor tools/biomecheck.mjs holds (measured over 100,000
  // points of the noise: gradient p99 4.2, max 6.8 per wavelength).
  //
  // Crags ride on the high ground only: a second, 210 m ridged field that
  // breaks every summit and skyline into buttresses and notches, so no peak
  // is a smooth dome — the smooth dome under snow was exactly what the first
  // version of this pass looked like from the road.
  function alpineMountains(x, z) {
    const wz = z + warpN(x, z);
    const north = smoothstep(-700, -1350, wz);
    if (north <= 0) return 0;
    // One octave of warp each way: the ridged field carries all the detail,
    // and the second octave cost 30 ms of the bake for nothing visible.
    const qx = x + valueNoise(x / 900, z / 900, s + 433) * 150;
    const qz = z + valueNoise(x / 900, z / 900, s + 434) * 150;
    const r = ridgedMF(qx / 1000, qz / 1000, s + 421, 4);
    let h = 35 + 115 * smoothstep(-1250, -2250, wz) + r * 280;
    const high = smoothstep(90, 240, h);
    if (high > 0) h += ridgedMF(qx / 210, qz / 210, s + 441, 2) * 18 * high;
    return h * north;
  }

  // How the mountains meet a road: they may rise at most `grade` metres per
  // metre from `foot` metres off the carriageway edge. Both wander along the
  // valley (a 300 m noise), between 29 and 45 degrees and 41 to 71 m out, so
  // no two stretches of the pass are walled alike and no wall is a ruled
  // line parallel to the road. The foot is eased over 24 m (C1), so where
  // the valley floor meets the wall is a curve, not a crease in the shading.
  //
  // A cap that was only a grade would make every valley wall a plane. So it
  // carries its own relief, growing with height up the wall to 30 m either
  // way at a 110 m wavelength: spurs and hollows across the face that the
  // snow, the rock and the trees can pick out. It can never pull the cap
  // below zero (at most 0.4 of the ramp against a grade of at least 0.56),
  // and it adds at most 0.7 to the grade at its steepest.
  function alpineCap(x, z, dRoad) {
    const n1 = valueNoise(x / 300, z / 300, s + 445), n2 = valueNoise(x / 300, z / 300, s + 446);
    const foot = KEEP_AT + 15 + n1 * 15;
    const grade = 0.78 + n2 * 0.22;
    const u = dRoad - foot;
    if (u <= 0) return 0;
    const ramp = u < 24 ? (u * u) / 48 : u - 12;
    const lump = ramp * 0.4 < 30 ? ramp * 0.4 : 30;
    return grade * ramp + lump * gradNoise(x / 110, z / 110, s + 447);
  }

  // Amberleaf's hills: the rounded, wooded knolls and hollows of old
  // hardwood country, up to 58 m (half that typically), crest to crest a few hundred metres apart,
  // on the same kind of cap as the mountains but gentle — 24 degrees at
  // most beside a road — so every lane winds along a wooded hollow with the
  // trees climbing away on either side. Without them the woods were the
  // farmland's rolling ground in orange.
  function autumnHills(x, z) {
    const n = fbm(x / 420, z / 420, s + 501, 3) * 0.5 + 0.5;
    return n * 58;
  }
  function autumnCap(dRoad) {
    const u = dRoad - (KEEP_AT + 8);
    if (u <= 0) return 0;
    return 0.45 * (u < 30 ? (u * u) / 60 : u - 15);
  }

  /**
   * The soft minimum of a feature's height and its cap: m.c / (m^4 + c^4)^1/4.
   * Exactly 0 where the cap is 0; within 2% of m once the cap is twice m, and
   * of c once m is twice c; and its slope never exceeds the steeper of the
   * two, so the knee where a mountainside turns into its own ridgeline is a
   * curve rather than a fold. Square roots only, which IEEE rounds exactly —
   * the same in every browser, like everything else that shapes the world.
   */
  function softCap(m, c) {
    if (m <= 0 || c <= 0) return 0;
    const m2 = m * m, c2 = c * c;
    return (m * c) / Math.sqrt(Math.sqrt(m2 * m2 + c2 * c2));
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
    const wa = w[BIOME.alpine], wd = w[BIOME.desert], wc = w[BIOME.coast], wu = w[BIOME.autumn];
    if (wu > 1e-3 && clearK > 0) {
      const c = autumnCap(dRoad) * clearK;
      if (c > 0) F += wu * softCap(autumnHills(x, z), c);
    }
    if (wa > 1e-3) {
      // The uplift is the one relief a road stands on (the solver grades it
      // like any hill), so it is gone where the alpine weight is under 5%
      // rather than trailing a few micrometres across every neighbouring
      // biome's verges (faded out at 0.3% it still left 2e-7 m on four road
      // samples, read back through the bicubic's 32 m support); the
      // mountains are capped off every road and every circuit's infield.
      const up = alpineUplift(x, z) * smoothstep(0.05, 0.15, wa);
      const c = clearK > 0 ? alpineCap(x, z, dRoad) * clearK : 0;
      F += wa * (up + (c > 0 ? softCap(alpineMountains(x, z), c) : 0));
    }
    if (wd > 1e-3 && dRoad > KEEP_AT && clearK > 0) {
      const cap = (dRoad - KEEP_AT) * WALL;
      const d = desertRelief(x, z);
      F += wd * clearK * (d < cap ? d : cap);
    }
    if (wc > 1e-3) {
      const m = smoothstep(KEEP_AT, KEEP_AT + RAMP_COAST, dRoad) * clearK;
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
      if (wq[BIOME.farm] > 0.999) continue;
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
  // The HUD asks every frame. It is answered from the weights AVERAGED OVER
  // THE LAST ~150 m DRIVEN, not from the weights under the wheels, and the
  // name changes only when that average gives another biome 60%. A road that
  // wanders along a border keeps its average near 50/50 however it weaves, so
  // it never flickers the name — on the raw weights, with a 62% threshold, a
  // road wandering 40 m either side of the farm/canyon border flipped it 13
  // times in 1.2 km, and with a 250 m lockout added on top still 5 times.
  // Crossing a border outright reports once, about 150 m after the halfway
  // line. The averaging is per metre moved, not per frame, so it behaves the
  // same at 30 fps as at 144, and parked on a border nothing changes at all.
  // A jump of more than 400 m (the map, a respawn, Go to a friend) starts
  // the average again where the car landed, and says so if that is a
  // different country.
  const tr = { index: -1, name: '', entered: false };
  const wt = new Float64Array(BIOME_COUNT);
  const wAvg = new Float64Array(BIOME_COUNT);
  const TRACK_M = 150;
  let prevX = 0, prevZ = 0;
  function track(x, z) {
    weightsAt(x, z, wt);
    tr.entered = false;
    const jx = x - prevX, jz = z - prevZ;
    const moved = Math.sqrt(jx * jx + jz * jz);
    prevX = x; prevZ = z;
    if (tr.index < 0 || moved > 400) {
      for (let b = 0; b < BIOME_COUNT; b++) wAvg[b] = wt[b];
    } else if (moved > 0) {
      // 1 - exp(-moved / TRACK_M), to within 0.2% at any step a frame takes.
      const k = moved / (TRACK_M + moved * 0.5);
      for (let b = 0; b < BIOME_COUNT; b++) wAvg[b] += (wt[b] - wAvg[b]) * k;
    }
    let best = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (wAvg[b] > wAvg[best]) best = b;
    if (tr.index < 0) {
      tr.index = best;
    } else if (best !== tr.index && (wAvg[best] > 0.6 || moved > 400)) {
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

  // Distance to the nearest open water, on a 64 m chamfer grid over the whole
  // relief extent: the water mesh draws only when there is sea within a view
  // distance, not merely somewhere south.
  const SC = 64, SN = Math.round((2 * EXT) / SC) + 1;
  const seaDist = new Float32Array(SN * SN).fill(1e9);
  for (let r = 0; r < SR; r += 4) {
    for (let i = 0; i < FN; i += 4) {
      if (!seaMask[r * FN + i]) continue;
      const x = -EXT + i * FC, z = -EXT + (sj0 + r) * FC;
      const gi = Math.min(SN - 1, Math.round((x + EXT) / SC)), gj = Math.min(SN - 1, Math.round((z + EXT) / SC));
      seaDist[gj * SN + gi] = 0;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const f = pass === 0;
    for (let jj = 0; jj < SN; jj++) {
      const j = f ? jj : SN - 1 - jj;
      for (let ii = 0; ii < SN; ii++) {
        const i = f ? ii : SN - 1 - ii, c = j * SN + i;
        let d = seaDist[c];
        const di = f ? -1 : 1, dj = f ? -1 : 1;
        if (i + di >= 0 && i + di < SN) d = Math.min(d, seaDist[c + di] + SC);
        if (j + dj >= 0 && j + dj < SN) {
          d = Math.min(d, seaDist[c + dj * SN] + SC);
          if (i + di >= 0 && i + di < SN) d = Math.min(d, seaDist[c + dj * SN + di] + SC * Math.SQRT2);
          if (i - di >= 0 && i - di < SN) d = Math.min(d, seaDist[c + dj * SN - di] + SC * Math.SQRT2);
        }
        seaDist[c] = d;
      }
    }
  }
  /** Metres to the nearest open water (to within a 64 m cell); past the grid, 0 in the south. */
  function seaDistAt(x, z) {
    const i = Math.round((x + EXT) / SC), j = Math.round((z + EXT) / SC);
    if (i < 0 || j < 0 || i >= SN || j >= SN) return z > SEA_Z0 ? 0 : 1e9;
    return Math.max(0, seaDist[j * SN + i] - SC);
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    seed, seaLevel, floorY,
    weightsAt, dominant, relief, seaAt, seaDepthAt, seaDistAt, surfaceAt, track, bake, seaTexture,
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
