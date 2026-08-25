// Road surfaces, kerbs and junctions.
//
// Everything you drive on is one mesh per region and ONE material. Both halves
// of that were forced by the problem rather than chosen for tidiness:
//
//   * Markings live in the texture, never in geometry. A painted line drawn as
//     its own quad a centimetre above the tarmac z-fights at range no matter
//     what polygon offset it is given, and the flicker is worst exactly where
//     the player is looking — down the road ahead. Baking the lines into the
//     surface and tiling by ARC LENGTH keeps a 3 m dash 3 m long whether the
//     polyline segment under it is 8 m or 80, and leaves no second surface to
//     fight with.
//
//   * One texture for the whole network. Seven road styles, sidewalk, kerb and
//     the two junction fills are stacked into a single atlas, so a region costs
//     one draw call instead of eleven. The atlas is a vertical stack: U runs
//     across the carriageway and uses the full texture width, so only V is
//     sub-ranged. Each row carries an 8 px guard band top and bottom holding a
//     copy of the opposite edge — without it the hand-rolled V wrap shows a
//     hairline seam every tile, because bilinear filtering reads whatever row
//     happens to be adjacent in the atlas.
//
// The ribbon sits 4 cm above ground.heightAt() with polygon offset as well.
// 4 cm is well inside the suspension's own travel so nothing reads as floating,
// and the height comes from the same field the physics stands on — what you see
// and what you drive on cannot disagree.
//
// SURFACE DETAIL — three decisions worth knowing before changing anything here
//
//   * There are TWO atlases, not one: albedo and a tangent-space normal map,
//     built in the same pass from the same relief buffer and stacked to the
//     IDENTICAL row layout, so one set of UVs addresses both. Everything the
//     surface has — aggregate, ruts, cracks, potholes, kerb arrises, slab
//     joints — is a height first and a colour second. Without the normal map a
//     road under a low sun or a headlight is a photograph of tarmac lying flat
//     on the ground; with it the same texels catch the light and the surface
//     has a direction. It costs no draw calls: one extra sampler on the one
//     material every region already shares.
//
//   * Row heights are shared out by NEED, not evenly. A row is 512 px across
//     the carriageway but only ~200 down 24 m of it, so the along-road axis is
//     the scarce one, and it is scarce in very different amounts: the kerb is
//     an 8.5 cm face whose only lengthwise feature is a joint every 1.2 m,
//     while a gravel lane is nothing BUT lengthwise structure. Weighting the
//     split buys the unpaved rows 40% more resolution for free.
//
//   * Noise here is periodic by construction (pvalue/pfbm below) rather than
//     cross-faded across the tile seam. The old cross-fade flattened the grain
//     toward the middle of every tile, which showed up as a soft horizontal
//     band every 24 m of road — visible in the atlas and visible in the game.
//     Exact periodicity removes the band AND halves the sample count.

import * as THREE from 'three';
import { pointOnEdge } from '../world/layout.js';
import { SURFACES } from '../world/ground.js';
import { fbm, hash1, hash2, mulberry, clamp, lerp, smoothstep } from '../world/noise.js';

const LIFT = 0.04;          // m of clearance over the physics surface
const KERB = 0.085;         // m of kerb lip — the car has no kerb to stand on
const WALK_W = 4.2;         // m of sidewalk, matching ground.js's SIDEWALK_W
const TILE = 24;            // m of road per texture repeat
const VSTEPS = 3;           // stations per tile, so V lands on exact thirds
const STEP = TILE / VSTEPS; // 8 m, which is also layout.js's densify() spacing

const ATLAS_W = 512;
const GUARD = 8;
const SLOT_MIN = 64;        // below this a row cannot hold its own joint spacing
const SLOT_MAX = 320;       // above this the extra texels buy nothing measurable
const ATLAS_MAX = 2048;     // the WebGL2 floor for MAX_TEXTURE_SIZE

// How hard a road has been used, which is the one number the whole wear model
// hangs off: it drives binder oxidation (old asphalt is grey, not black), how
// far the markings have faded, how much cracking and patching there is, and
// whether there are potholes at all. Highways get resurfaced; a country lane
// gets patched until it is more patch than road.
const AGE = {
  highway: 0.30, avenue: 0.46, link: 0.52, street: 0.64, rural: 0.86,
  gravel: 0.70, dirt: 0.80, track: 0.92,
};

// Share of the atlas height each row asks for.
//
// The along-road axis is the scarce one — a row is 512 px across the
// carriageway but only ~200 down 24 m of it — and the rows need it in very
// different amounts. Unpaved lanes are nothing BUT lengthwise structure (ruts,
// corrugation, stones); a highway needs enough to place an expansion joint
// every 6 m; a city street's wear is almost entirely longitudinal and reads off
// the width instead; a kerb's only lengthwise feature is a joint every 1.2 m,
// and a junction fill has none at all. Splitting the budget evenly, as this
// used to, spent a third of the atlas on the rows with the least to say.
const WEIGHT = {
  highway: 1.30, avenue: 0.95, link: 0.95, street: 0.95, rural: 1.20,
  gravel: 1.40, dirt: 1.40, track: 1.40, walk: 0.62, kerb: 0.60, patch: 0.55,
};

// The three unpaved kinds are three different roads, not one drawn at three
// widths. `stony` is how much of the surface is loose stone rather than earth,
// and `used` is how completely traffic has claimed it — the pair decides the
// dressing, the depth of the ruts and whether anything grows down the middle.
const LOOSE = {
  gravel: { stony: 1.00, used: 0.90 },
  dirt:   { stony: 0.42, used: 0.70 },
  track:  { stony: 0.26, used: 0.28 },
};

// Cull distances, NOT the engine's raw tier draw distances. Culling a region
// the player can still see is worse than drawing it: sky.js does not close its
// fog until drawDistance * 1.55 in clear weather, so a road dropped at the raw
// tier figure vanishes over bare terrain while it is still well over half
// visible. These are the four engine tiers carried out to where the fog
// actually hides them. Costs nothing here — every region shares one material,
// and the frustum still throws away everything behind the camera.
//
// `normals` drops the normal map on the lowest tier. That is a shader-program
// change, so it may only ever happen on a quality switch, never per frame.
const QUALITY = {
  low:    { anisotropy: 1,  drawDistance: 2170, normals: false },  // engine tier 1400
  medium: { anisotropy: 4,  drawDistance: 3410, normals: true },   // engine tier 2200
  high:   { anisotropy: 8,  drawDistance: 4960, normals: true },   // engine tier 3200
  ultra:  { anisotropy: 16, drawDistance: 6980, normals: true },   // engine tier 4500
};

/** SURFACES stores 0xRRGGBB; every colour in this file is a 0..255 triple. */
function surfaceRGB(name, gain = 1) {
  const c = SURFACES[name].colour;
  return [((c >> 16) & 255) * gain, ((c >> 8) & 255) * gain, (c & 255) * gain];
}

function mix3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * A row's own seed, keyed on the road KIND as well as its width.
 *
 * The width alone is not enough: layout.js gives `gravel` and `dirt` the same
 * 7.5 m, so a width-derived seed handed both of them the SAME RNG stream and
 * the same noise seed — identical stones, identical blotches, and potholes in
 * identical places on the two roads whose whole point is that they are not the
 * same road. Folding the kind in closes the class of collision rather than the
 * one instance of it, and costs a dozen character codes at load.
 */
function rowSeed(kind, width) {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (Math.imul(h, 31) + kind.charCodeAt(i)) | 0;
  return width * 17 + (h & 0xffff);
}

// ---------------------------------------------------------------------------
// Tileable noise
// ---------------------------------------------------------------------------

function quinticT(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/**
 * Value noise that repeats EXACTLY every `pz` lattice cells along z.
 *
 * The z lattice index is taken modulo pz before hashing, so the cell at the end
 * of the tile shares its corners with the cell at the start and the surface is
 * continuous across the seam with no blending anywhere. mz is never negative in
 * the row painters, so the plain % is safe.
 */
function pvalue(x, z, pz, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const u = quinticT(x - x0), v = quinticT(z - z0);
  const za = z0 % pz, zb = (z0 + 1) % pz;
  const a = hash2(x0, za, seed), b = hash2(x0 + 1, za, seed);
  const c = hash2(x0, zb, seed), d = hash2(x0 + 1, zb, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/**
 * Fractal sum of pvalue. Each octave doubles the frequency AND the period.
 *
 * Octaves stop once the period passes `pmax`, the finest lengthwise detail this
 * row has the texels to hold. Rows differ by a factor of three in along-road
 * resolution, so a scale that is aggregate on a gravel lane is finer than a
 * texel on a junction fill; carrying it anyway does not produce fine detail, it
 * produces a moire of hard horizontal stripes, which is exactly what the short
 * rows showed before this was added. Dropping the octave is what mipmapping
 * would do and costs less than generating it.
 */
function pfbm(x, z, pz, seed, oct, pmax) {
  let sum = 0, amp = 1, f = 1, norm = 0, p = pz;
  for (let o = 0; o < oct; o++) {
    sum += pvalue(x * f, z * f, p, seed + o * 1013) * amp;
    norm += amp; amp *= 0.5; f *= 2; p *= 2;
    if (p > pmax) break;
  }
  return sum / norm;
}

/**
 * Noise in METRE space that repeats exactly every TILE metres along the road.
 *
 * Metre space matters because a row is 512 px across a 9.5 m lane but only
 * ~200 px along 24 m of it — sampling in pixel space would smear the aggregate
 * into stripes at wildly different scales on every road kind. `sx` and `sz` are
 * deliberately different: real tarmac grain IS streaked along the direction of
 * travel by tyre polish and water runoff. `sz` is snapped to a whole number of
 * cells per tile, so the requested lengthwise scale is honoured to within that
 * rounding and not exactly — and it is clamped to `pmax`, so a row that is only
 * 74 px down 24 m of road never asks for half-metre detail it cannot hold.
 */
function nfield(m, mz, sx, sz, seed, oct, pmax) {
  const P = Math.min(pmax, Math.max(1, Math.round(TILE / sz)));
  return pfbm(m / sx, (mz / TILE) * P, P, seed, oct, pmax);
}

// ---------------------------------------------------------------------------
// Marking layouts
// ---------------------------------------------------------------------------

/**
 * Longitudinal stripes for one road style, in metres from the left edge.
 * `dash`/`gap` cycles are chosen to divide TILE exactly (3+9 and 2+4 both do),
 * otherwise the dash pattern would visibly stutter at every texture repeat.
 */
function markingPlan(markings, width, lanes) {
  const out = [];
  const c = width / 2;
  const line = (m, w, dash, gap) => out.push({ m, w, dash: dash || 0, gap: gap || 0 });

  if (markings === 'highway') {
    const sh = Math.min(3.0, width * 0.13), med = 0.55;
    line(sh, 0.22); line(width - sh, 0.22);                    // hard shoulders
    line(c - med, 0.22); line(c + med, 0.22);                  // painted median
    const run = (c - med - sh) / lanes;
    for (let k = 1; k < lanes; k++) {
      line(sh + run * k, 0.16, 3, 9);
      line(width - sh - run * k, 0.16, 3, 9);
    }
  } else if (markings === 'avenue') {
    const med = 0.17;
    line(c - med, 0.15); line(c + med, 0.15);
    // A single-lane link gets the centre line and nothing else; drawing a lane
    // divider down a one-lane carriageway would invent a lane that is not there.
    const run = (c - med) / lanes;
    for (let k = 1; k < lanes; k++) {
      line(c - med - run * k, 0.14, 3, 9);
      line(c + med + run * k, 0.14, 3, 9);
    }
  } else if (markings === 'street') {
    line(c, 0.15, 2, 4);
  } else if (markings === 'rural') {
    line(c, 0.14, 3, 9);
  }
  return out;
}

/** Where the tyres actually run, so the surface can be polished there. */
function wheelTracks(markings, width, lanes) {
  const c = width / 2, out = [];
  const sh = markings === 'highway' ? Math.min(3.0, width * 0.13) : 0;
  const med = markings === 'highway' ? 0.55 : markings === 'avenue' ? 0.17 : 0;
  const run = (c - med - sh) / lanes;
  for (let k = 0; k < lanes; k++) {
    const lc = sh + run * (k + 0.5);
    out.push(lc - 0.78, lc + 0.78, width - lc - 0.78, width - lc + 0.78);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wear features, drawn from the spec's own seed
// ---------------------------------------------------------------------------

/**
 * Patch repairs, as boxes in (across, along) metres with a sealed overband.
 *
 * Two shapes, because real roads have two: a trench reinstatement that crosses
 * the whole carriageway where a service was laid, and a squarish pothole repair
 * a metre or two across. Both are stored by centre so the along-road test can
 * wrap the tile in one subtraction.
 */
function makePatches(rnd, width, age, full) {
  const out = [];
  const n = Math.round(0.6 + 5.4 * age * age);
  for (let i = 0; i < n; i++) {
    const trench = rnd() < full;
    const hm = trench ? width * 0.52 : 0.35 + rnd() * 1.30;
    out.push({
      mc: trench ? width * 0.5 : hm + rnd() * Math.max(0.1, width - 2 * hm),
      hm,
      zc: rnd() * TILE,
      hz: trench ? 0.50 + rnd() * 0.85 : 0.45 + rnd() * 1.45,
      // A repair is newer than the road around it, so it is darker; one in five
      // is an older repair that has itself gone grey.
      // A fresh repair is darker than the road around it, but only by about a
      // quarter — pushed further it stops reading as asphalt and starts reading
      // as a hole. One in five is an older repair that has itself gone grey.
      tone: rnd() < 0.2 ? 1.05 + rnd() * 0.10 : 0.78 + rnd() * 0.15,
      seal: 0.045 + rnd() * 0.045,
    });
  }
  return out;
}

/** Potholes as ellipses. Stored with reciprocal radii so the test is two muls. */
function makeHoles(rnd, width, n, deep) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const rx = 0.16 + rnd() * 0.34;
    const rz = rx * (0.7 + rnd() * 0.9);
    out.push({
      m: 0.45 + rnd() * Math.max(0.1, width - 0.9), z: rnd() * TILE,
      rx, irx2: 1 / (rx * rx), irz2: 1 / (rz * rz),
      depth: deep * (0.45 + rnd() * 0.75),
    });
  }
  return out;
}

/** Rubber smears and chipped corners on a kerb, in (along m, face 0..1). */
function makeScuffs(rnd, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const chip = rnd() < 0.3;
    out.push({
      z: rnd() * TILE, hz: chip ? 0.05 + rnd() * 0.09 : 0.12 + rnd() * 0.40,
      u: chip ? 0.80 + rnd() * 0.18 : 0.12 + rnd() * 0.55,
      hu: chip ? 0.07 + rnd() * 0.07 : 0.10 + rnd() * 0.22,
      chip, k: 0.35 + rnd() * 0.5,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row specifications
// ---------------------------------------------------------------------------

/**
 * A sealed carriageway: base tone, wheel-track polish, wear and markings.
 *
 * The single most important term is `poli`, the tyre-polish profile computed in
 * the painter. Everything a used road looks like keys off it: the tracks are
 * darker because the binder has been worked to the top and the chippings
 * polished smooth, so away from them the aggregate is exposed and the surface
 * reads lighter and coarser — the "aggregate-rich centre and edges" you see on
 * any real two-lane road. Deriving both from one profile is what keeps them
 * consistent with the rutting in the relief buffer.
 */
function pavedSpec(kind, markings, width, lanes, seed) {
  const rnd = mulberry((Math.imul(seed, 2654435761) ^ 0x9e37) >>> 0);
  const age = AGE[kind] ?? 0.5;
  const city = kind === 'street' || kind === 'avenue' || kind === 'link';
  const tracks = wheelTracks(markings, width, lanes);

  return {
    paint: 'paved', kind: 'road', width, seed, age,
    weight: WEIGHT[kind] ?? WEIGHT.patch,
    // Fresh asphalt is near-black; oxidised binder turns it grey, and that is
    // the difference between a motorway and a lane that was last surfaced a
    // generation ago far more than any amount of cracking is.
    base: mix3([46, 48, 52], [88, 89, 92], age),
    agg: [128, 129, 133],                  // exposed chippings
    tar: [21, 20, 20],                     // bleed, sealant, crack shadow
    ink: [232, 229, 215],                  // marking paint
    // The verge outside a country road is the MAT_GRAVEL shoulder the ground
    // query hands the physics, so the last handspan of tarmac ravels toward it
    // and the ribbon edge does not meet the shoulder as a colour step.
    edgeCol: surfaceRGB('gravel', 1.15),
    edgeMix: city ? 0.0 : 0.30 + 0.35 * age,

    stripes: markingPlan(markings, width, lanes),
    markAlpha: 0.95 - 0.52 * age,
    tracks, trackW: 0.62,
    trackCut: 0.045 + 0.055 * age,         // how much darker the polished path is
    aggLift: 0.065 + 0.075 * age,          // how much lighter the untrodden rest is
    aggMix: 0.10 + 0.16 * age,
    rutH: 0.004 + 0.008 * age,             // m of dish worn into each wheel path
    crownH: 0.055,                         // m of camber, normal map only

    gutter: city ? 0.42 : 0,
    joint: kind === 'highway' ? 6 : 0,     // m between expansion joints; divides TILE
    grime: 0.20 + 0.16 * age,

    gx: 0.13, gz: 0.42, grainAmt: 0.09 + 0.06 * age, grainH: 0.0014 + 0.0013 * age,
    // The blotch has to vary SLOWLY along the road. At the 5.5 m it started on
    // it beat against the 2.6 m across and the pair read as wood grain.
    bx: 3.4, bz: 13.0, blotchAmt: 0.030 + 0.035 * age,
    bleedAmt: 0.10 + 0.42 * age,
    // Cracking is very non-linear in age: a road is sound, then suddenly it is
    // not. Squaring the age is what keeps highways clean and lanes broken.
    crackAmt: age * age,
    crackW: 0.045 + 0.065 * age,
    patches: makePatches(rnd, width, age, city ? 0.12 : 0.26),
    holes: kind === 'rural' ? makeHoles(rnd, width, 4, 0.055) : [],
  };
}

/**
 * An unpaved lane. Two of them exist and they are not the same road.
 *
 * kind 'gravel' is a dressed lane: loose stone over a compacted formation, well
 * used, so the stones are swept out of the ruts and banked either side. kind
 * 'dirt' is the same road without the dressing — mostly earth, some stone.
 * kind 'track' is the least-used of the three, and it is the one that grows
 * the raised line of grass down the middle, because a road only keeps that
 * where nothing straddles it.
 *
 * The colours come straight out of SURFACES so the surface agrees with the
 * material the physics reports on it: the earth is SURFACES.dirt and the stone
 * dressing and the dust film over it are SURFACES.gravel, which is also what
 * the shoulders either side are made of and what the wheels throw up.
 */
function looseSpec(kind, width, seed) {
  const rnd = mulberry((Math.imul(seed, 40503) ^ 0x51ed) >>> 0);
  const L = LOOSE[kind] ?? LOOSE.dirt;
  const stony = L.stony, used = L.used;
  const age = AGE[kind] ?? 0.8;
  const earth = surfaceRGB('dirt', 1.34);
  const dust = surfaceRGB('gravel', 1.30);

  return {
    paint: 'loose', kind: 'road', width, seed, age,
    weight: WEIGHT[kind] ?? WEIGHT.patch,
    base: mix3(earth, dust, stony * 0.72),
    dust,                                   // the fine film that settles on top
    stoneLo: mix3(dust, [42, 40, 36], 0.42),
    stoneHi: mix3(dust, [236, 232, 222], 0.36),
    grass: [74, 86, 50],

    rut: [width * 0.5 - 0.82, width * 0.5 + 0.82],
    rutW: lerp(0.44, 0.54, used),
    rutCut: lerp(0.34, 0.20, used),
    rutH: lerp(0.078, 0.028, used),        // m — a track's ruts are real ruts
    bermH: lerp(0.030, 0.014, used) + 0.014 * stony,   // material pushed aside
    crownH: lerp(0.048, 0.010, used),      // the untouched strip between them

    // A dressed lane keeps a thin fringe; a track is being taken back.
    grassCrown: 0.98 * (1 - used) * (1 - 0.40 * stony),
    grassEdge: lerp(0.46, 0.18, used),

    gx: 0.10, gz: 0.45, grainAmt: 0.15 + 0.07 * stony, grainH: 0.005 + 0.005 * stony,
    bx: 2.0, bz: 4.2, blotchAmt: 0.13,
    // Larger aggregate, near-isotropic in metres. At ~10 px per metre along the
    // road a stone under about 25 cm cannot be resolved lengthwise at all, so
    // the scatter is deliberately coarse and the fine grain above carries the
    // rest — streaked, which is how traffic leaves it anyway.
    stoneS: lerp(0.30, 0.21, stony), stoneAmt: 0.20 + 0.50 * stony,
    stoneH: 0.010 + 0.014 * stony,
    // Corrugation. 24/44 m divides TILE a whole number of times, so the
    // washboard wraps; anything else beats against the tile and reads as a
    // rhythm change every 24 m. It only forms where traffic is regular.
    washL: 24 / 44, washH: (0.004 + 0.008 * stony) * used,
    holes: makeHoles(rnd, width, 4 + Math.round(3 * age), 0.085),
    patches: [],
    dustFilm: 0.16 + 0.22 * stony,
  };
}

/** Concrete paving, 4.2 m across, jointed every 1.2 m so it tiles into TILE. */
function walkSpec(seed) {
  return {
    paint: 'walk', kind: 'walk', width: WALK_W, seed, weight: WEIGHT.walk,
    base: [118, 120, 126], agg: [158, 160, 165], grass: [78, 92, 54],
    slab: 1.2, jointH: 0.006, chamfer: 0.05,
    gx: 0.16, gz: 0.24, grainAmt: 0.075, grainH: 0.0011,
    bx: 1.4, bz: 1.8, blotchAmt: 0.05,
    // Grit and grime collect against the kerb, which is the road-side edge.
    kerbGrime: 0.15, crackRate: 0.16,
  };
}

/** The 8.5 cm kerb face. U runs up the face, so `width` here is the face param. */
function kerbSpec(seed) {
  const rnd = mulberry((Math.imul(seed, 374761393) ^ 0x2b7) >>> 0);
  return {
    paint: 'kerb', kind: 'kerb', width: KERB, seed, weight: WEIGHT.kerb,
    base: [132, 133, 137], agg: [168, 169, 172], tar: [26, 25, 25],
    slab: 1.2, jointH: 0.008,
    // A kerb is not a flat face: there is a chamfered arris at the top that
    // catches every light in the city, and a shadow line at the bottom where
    // the gutter meets it. Those two edges are the whole reason a kerb reads as
    // an object rather than a painted stripe.
    arris: 0.86, arrisH: 0.009, gutterLine: 0.10,
    gx: 0.9, gz: 0.22, grainAmt: 0.09, grainH: 0.0012,
    bx: 3.0, bz: 1.9, blotchAmt: 0.05,
    scuffs: makeScuffs(rnd, 14),
  };
}

/** Junction fill: no markings, worn smooth by everything that turns on it. */
function patchSpec(surface, seed) {
  if (surface !== 'asphalt') {
    const s = looseSpec(surface === 'gravel' ? 'gravel' : 'dirt', 20, seed);
    s.kind = 'patch'; s.weight = WEIGHT.patch;
    // Nothing tracks a junction the same way twice, so it has no ruts.
    s.rut = []; s.grassCrown = 0; s.grassEdge = 0; s.washH = 0;
    return s;
  }
  const s = pavedSpec('street', 'none', 20, 1, seed);
  s.kind = 'patch'; s.weight = WEIGHT.patch;
  s.stripes = []; s.tracks = []; s.gutter = 0; s.joint = 0;
  s.edgeMix = 0; s.grime = 0.06; s.crownH = 0;
  // A junction is scrubbed by every car that turns across it, so it is darker
  // and more polished than the roads feeding it, and it cracks in the middle.
  s.base = mix3(s.base, [40, 42, 46], 0.35);
  s.aggLift = 0.05; s.aggMix = 0.07; s.crackAmt = 0.5; s.bleedAmt = 0.2;
  return s;
}

// ---------------------------------------------------------------------------
// Row painters
// ---------------------------------------------------------------------------
//
// Each painter fills an ImageData with colour and a parallel Float32Array with
// RELIEF IN METRES; reliefToNormal() turns the second into the normal map. Two
// rules apply to all of them:
//
//   * anything that depends only on the metre ACROSS the row is hoisted into a
//     column table, and anything that depends only on the metre ALONG it into a
//     row table. The inner loop then costs a handful of noise samples instead
//     of re-deriving a cross-section a hundred thousand times, which is what
//     pays for the extra detail without lengthening the load.
//
//   * every along-road test wraps the tile with one subtraction of the form
//     `dz -= TILE * Math.round(dz / TILE)`. A pothole clipped by the end of the
//     row would otherwise appear as a half pothole every 24 m — the same
//     mistake the old marking scuffs had to correct for by hand.

/** Sealed surfaces: asphalt carriageways and asphalt junction fills. */
function paintPaved(spec, w, h, img, H, mPerX, mPerY) {
  const d = img.data;
  // The finest lengthwise noise period this row can hold. 2.6 texels per cell
  // is the smallest that does not visibly beat against the pixel grid.
  const pmax = Math.max(2, Math.floor(h / 2.6));
  // Aggregate sparkle, defined in TEXELS rather than metres: the relief has to
  // vary over two or three texels to tilt the normal at all, and a row's texel
  // is 5 cm on a highway and 1 cm on a lane. Sized in metres it would be flat
  // on one and aliased on the other. The amplitude scales with the texel too,
  // so the SLOPE it produces — about 7 degrees — is the same on every row; it
  // is a lighting cheat, not a claim about how deep the chippings are.
  const microS = 2.5 * mPerX, microH = 0.30 * mPerX;
  const width = spec.width, c = width / 2;
  const S = spec.stripes, ns = S.length;
  const P = spec.patches, np = P.length;
  const Hl = spec.holes, nh = Hl.length;

  // ---- column tables ----
  const tone = new Float32Array(w), poli = new Float32Array(w);
  const rel0 = new Float32Array(w), bled = new Float32Array(w);
  const ckm = new Float32Array(w), edgk = new Float32Array(w);
  const salp = new Float32Array(w), strp = new Int16Array(w);

  for (let px = 0; px < w; px++) {
    const m = (px + 0.5) * mPerX;
    const edge = Math.min(m, width - m);
    let t = 1, rel = 0;

    let p = 0;
    for (let i = 0; i < spec.tracks.length; i++) {
      const q = (m - spec.tracks[i]) / spec.trackW;
      p += Math.exp(-q * q);
    }
    if (p > 1) p = 1;
    poli[px] = p;
    // Polished dark in the wheel paths, aggregate-rich and lighter everywhere
    // else. One profile, both effects, so they can never drift apart.
    t *= 1 + spec.aggLift * (1 - p) - spec.trackCut * p;
    rel -= spec.rutH * p;

    // Camber lives in the normal map alone: the ribbon is flat across because
    // the height field it is built from is, and bending the geometry to fake a
    // crown would put the visible surface off the one the wheels stand on.
    if (spec.crownH) { const q = (m - c) / Math.max(0.5, c); rel -= spec.crownH * q * q; }

    // The gutter is a dished channel, permanently damp and full of silt.
    if (spec.gutter > 0) {
      const g = Math.max(0, 1 - edge / spec.gutter);
      t *= 1 - 0.34 * g * g;
      rel -= 0.019 * g * (2 - g);
    }

    // The last handspan of tarmac is always dirtier than the rest of it, and on
    // a country road it is also ravelling away into the gravel shoulder.
    t *= 1 - spec.grime * (1 - smoothstep(0, 0.45, edge));
    edgk[px] = spec.edgeMix * (1 - smoothstep(0.05, 0.55, edge));

    // Cracking starts where the surface is unsupported or jointed: the outer
    // edge, the construction joints under the lane lines, and the wheel paths.
    let cm = 0.60 * smoothstep(0.95, 0.12, edge);
    for (let i = 0; i < ns; i++) {
      const j = 0.55 * smoothstep(0.60, 0.07, Math.abs(m - S[i].m));
      if (j > cm) cm = j;
    }
    if (0.80 * p > cm) cm = 0.80 * p;
    ckm[px] = cm;

    // Bled binder runs as narrow glassy ribbons down the wheel paths.
    let bl = 0;
    for (let i = 0; i < spec.tracks.length; i++) {
      const q = (m - spec.tracks[i]) / 0.055;
      const e = Math.exp(-q * q);
      if (e > bl) bl = e;
    }
    bled[px] = bl;

    // Stripe coverage, antialiased over a texel: a hard fillRect edge shimmers
    // at range even with anisotropy on, which is exactly where lane lines live.
    let best = 0, bi = -1;
    for (let i = 0; i < ns; i++) {
      const a = 1 - smoothstep(S[i].w * 0.5 - mPerX, S[i].w * 0.5 + mPerX * 0.7, Math.abs(m - S[i].m));
      if (a > best) { best = a; bi = i; }
    }
    salp[px] = best; strp[px] = bi;
    tone[px] = t; rel0[px] = rel;
  }

  // ---- row tables ----
  const shearB = new Int16Array(h), gate = new Float32Array(h);
  const jb = new Float32Array(h), js = new Float32Array(h);
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    // Bleed lines wander; shifting the column table by whole texels is a shear,
    // which costs one clamped index instead of an exp per line per pixel.
    // 10 cm of wander. At the 26 cm it started on, every bleed line in the row
    // snaked in step and the pair read as a drawn curve rather than a stain.
    shearB[py] = Math.round(nfield(3.5, mz, 1, 9, spec.seed + 401, 2, pmax) * 0.10 / mPerX);
    gate[py] = clamp(0.30 + 1.7 * nfield(0.5, mz, 1, 13, spec.seed + 7, 2, pmax), 0, 1);
    if (spec.joint > 0) {
      const f = Math.abs(mz / spec.joint - Math.round(mz / spec.joint)) * spec.joint;
      // The sealed overband is ~18 cm wide, which is also about the narrowest
      // lengthwise feature this row can resolve, so the joint is drawn at the
      // width it really has rather than the hairline the sealant slot is.
      jb[py] = 1 - smoothstep(0.06, 0.10, f);
      js[py] = 1 - smoothstep(0.015, 0.045, f);
    }
  }

  // ---- pixels ----
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const sb = shearB[py], gt = gate[py], jbv = jb[py], jsv = js[py];
    for (let px = 0; px < w; px++) {
      const m = (px + 0.5) * mPerX;
      const p = poli[px];
      let t = tone[px], rel = rel0[px];
      // Macro relief (camber, ruts, gutter, cracks, holes) and micro relief are
      // kept apart because tar bleed floods the second and not the first.
      let fine = 0;

      const g = nfield(m, mz, spec.gx, spec.gz, spec.seed, 3, pmax);
      t *= 1 + g * spec.grainAmt * (1 - 0.70 * p);
      fine += g * spec.grainH * (1 - 0.75 * p);
      fine += nfield(m, mz, microS, microS * 4, spec.seed + 877, 1, pmax) * microH * (1 - 0.72 * p);
      const bn = nfield(m, mz, spec.bx, spec.bz, spec.seed + 91, 2, pmax);
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;

      // Exposed chippings, only where the tyres have not polished them over.
      const ak = spec.aggMix * (1 - p) * clamp(0.45 + 0.85 * g, 0, 1);
      r = lerp(r, spec.agg[0], ak); gr = lerp(gr, spec.agg[1], ak); b = lerp(b, spec.agg[2], ak);

      // Ravelled edge, meeting the gravel shoulder the physics reports there.
      const ek = edgk[px] * clamp(0.35 + 0.9 * bn, 0, 1);
      if (ek > 0.002) {
        r = lerp(r, spec.edgeCol[0], ek); gr = lerp(gr, spec.edgeCol[1], ek); b = lerp(b, spec.edgeCol[2], ek);
        rel += ek * 0.004 * g;
      }

      // Tar bleed. Bled binder is a flooded, glassy surface, so as well as
      // going black it flattens the relief it covers — that loss of texture is
      // most of what makes a bleeding wheel path readable at speed.
      const bd = bled[clamp(px + sb, 0, w - 1)] * spec.bleedAmt;
      if (bd > 0.003) {
        r = lerp(r, spec.tar[0], bd); gr = lerp(gr, spec.tar[1], bd); b = lerp(b, spec.tar[2], bd);
        fine *= 1 - 0.72 * bd;
      }

      // Cracking. |noise| near zero gives filaments; stretching the sample 25:1
      // along the road turns them into longitudinal cracks, and a second,
      // near-isotropic field inside the wheel paths gives the fatigue crazing
      // an old road grows there.
      if (spec.crackAmt > 0.002) {
        const cn = nfield(m, mz, 0.22, 14.0, spec.seed + 55, 2, pmax);
        let ck = (1 - smoothstep(0, spec.crackW, Math.abs(cn))) * ckm[px] * gt * spec.crackAmt;
        if (p > 0.20 && spec.age > 0.55) {
          const fn = nfield(m, mz, 0.30, 0.40, spec.seed + 311, 2, pmax);
          const fk = (1 - smoothstep(0, 0.045, Math.abs(fn))) * p * (spec.age - 0.55) * 2.0 * gt;
          if (fk > ck) ck = fk;
        }
        if (ck > 0.004) {
          r = lerp(r, spec.tar[0], ck); gr = lerp(gr, spec.tar[1], ck); b = lerp(b, spec.tar[2], ck);
          rel -= ck * 0.007;
        }
      }

      // Patch repairs. The blotch noise doubles as the edge wobble, so a repair
      // has a ragged boundary without costing another sample.
      for (let i = 0; i < np; i++) {
        const q = P[i];
        const dm = Math.abs(m - q.mc) - q.hm;
        if (dm > q.seal) continue;
        let dz = mz - q.zc; dz -= TILE * Math.round(dz / TILE);
        const dzz = Math.abs(dz) - q.hz;
        if (dzz > q.seal) continue;
        // A cut edge is ragged at two scales, so the wobble takes one from the
        // blotch and one from the aggregate grain. The blotch alone shifted the
        // whole boundary at once and the repairs stayed drawn rectangles.
        const dIn = (dm > dzz ? dm : dzz) + bn * 0.09 + g * 0.06;
        const ins = 1 - smoothstep(-0.03, 0.01, dIn);
        if (ins > 0.002) {
          const tt = lerp(1, q.tone, ins);
          r *= tt; gr *= tt; b *= tt;
          rel -= ins * 0.005;                      // a repair always settles
        }
        const band = 1 - smoothstep(q.seal * 0.35, q.seal, Math.abs(dIn));
        if (band > 0.004) {
          const k = band * 0.52;
          r = lerp(r, spec.tar[0], k); gr = lerp(gr, spec.tar[1], k); b = lerp(b, spec.tar[2], k);
          rel += band * 0.005;                     // the overband stands proud
        }
      }

      // Potholes.
      for (let i = 0; i < nh; i++) {
        const q = Hl[i];
        const dm = m - q.m;
        if (dm > q.rx * 1.6 || dm < -q.rx * 1.6) continue;
        let dz = mz - q.z; dz -= TILE * Math.round(dz / TILE);
        // The rim has to break up WITHIN the hole, so the raggedness comes off
        // the aggregate grain; the blotch varies over metres and merely moved
        // the whole ellipse, leaving it a drawn oval.
        const q2 = dm * dm * q.irx2 + dz * dz * q.irz2 + g * 0.40 + bn * 0.25;
        if (q2 > 1.9) continue;
        const core = 1 - smoothstep(0.30, 0.95, q2);
        const spoil = (1 - smoothstep(0.95, 1.8, q2)) * (1 - core);
        r = lerp(r, spec.tar[0] * 1.1, core * 0.82); gr = lerp(gr, spec.tar[1] * 1.1, core * 0.82); b = lerp(b, spec.tar[2] * 1.15, core * 0.82);
        r = lerp(r, spec.agg[0], spoil * 0.30); gr = lerp(gr, spec.agg[1], spoil * 0.30); b = lerp(b, spec.agg[2], spoil * 0.30);
        rel -= core * q.depth;
        rel += spoil * q.depth * 0.16;
      }

      // Expansion joints.
      if (jbv > 0.004) {
        const k = jbv * 0.62;
        r = lerp(r, spec.tar[0], k); gr = lerp(gr, spec.tar[1], k); b = lerp(b, spec.tar[2], k);
        rel += jbv * 0.0035 - jsv * 0.010;
      }

      // Markings, last, because a road is repainted over its own repairs.
      const si = strp[px];
      if (si >= 0 && salp[px] > 0.004) {
        const st = S[si];
        let on = 1;
        if (st.dash) {
          const ph = mz % (st.dash + st.gap);
          on = ph < st.dash
            ? smoothstep(0, 0.22, ph) * smoothstep(0, 0.30, st.dash - ph)   // scuffed ends
            : 0;
        }
        if (on > 0.004) {
          // Paint wears off fastest where it is driven over, so a centre line
          // in a wheel path is a ghost while a shoulder line beside it is not.
          let a = salp[px] * on * spec.markAlpha * (1 - 0.70 * p);
          a *= clamp(0.45 + 0.75 * (g * 0.5 + 0.5) + 0.55 * bn, 0, 1);
          if (a > 0.004) {
            r = lerp(r, spec.ink[0], a); gr = lerp(gr, spec.ink[1], a); b = lerp(b, spec.ink[2], a);
            rel += a * 0.0012;                    // fresh paint sits proud
          }
        }
      }

      const o = (py * w + px) * 4;
      d[o] = r; d[o + 1] = gr; d[o + 2] = b; d[o + 3] = 255;
      H[py * w + px] = rel + fine;
    }
  }
}

/** Unpaved surfaces: the gravel lane, the dirt track, and their junctions. */
function paintLoose(spec, w, h, img, H, mPerX, mPerY) {
  const d = img.data;
  // The finest lengthwise noise period this row can hold. 2.6 texels per cell
  // is the smallest that does not visibly beat against the pixel grid.
  const pmax = Math.max(2, Math.floor(h / 2.6));
  const width = spec.width, c = width / 2;
  const Hl = spec.holes, nh = Hl.length;

  // ---- column tables ----
  const tone = new Float32Array(w), rel0 = new Float32Array(w);
  const rutk = new Float32Array(w), grass = new Float32Array(w);
  const loose = new Float32Array(w);

  for (let px = 0; px < w; px++) {
    const m = (px + 0.5) * mPerX;
    const edge = Math.min(m, width - m);
    let t = 1, rel = 0, k = 0;

    for (let i = 0; i < spec.rut.length; i++) {
      const q = (m - spec.rut[i]) / spec.rutW;
      k += Math.exp(-q * q);
    }
    if (k > 1) k = 1;
    rutk[px] = k;
    // A rut is compacted and damp: darker, and swept clean of loose material,
    // which is pushed into berms on either side of it.
    t *= 1 - spec.rutCut * k;
    rel -= spec.rutH * k;
    if (spec.rut.length) {
      let berm = 0;
      for (let i = 0; i < spec.rut.length; i++) {
        for (let s = -1; s <= 1; s += 2) {
          const q = (m - spec.rut[i] - s * spec.rutW * 1.55) / (spec.rutW * 0.8);
          berm += Math.exp(-q * q);
        }
      }
      rel += spec.bermH * Math.min(1, berm) * (1 - k);
    }
    // The strip between the ruts is never touched, so it stands proud and, on a
    // road nothing straddles, it grows a line of grass down the middle.
    const cq = (m - c) / 0.62;
    const crown = Math.exp(-cq * cq);
    rel += spec.crownH * crown;
    let gk = spec.grassCrown * crown + spec.grassEdge * (1 - smoothstep(0, 1.1, edge));
    grass[px] = gk > 1 ? 1 : gk;
    loose[px] = clamp(1 - 1.15 * k, 0, 1);        // where stones can still sit
    t *= 1 + 0.14 * (1 - smoothstep(width * 0.30, width * 0.5, Math.abs(m - c)));
    tone[px] = t; rel0[px] = rel;
  }

  // ---- row tables ----
  // Corrugation: a real washboard is a standing wave, not noise, so it is a
  // sine whose amplitude a slow noise turns on and off along the road.
  const wash = new Float32Array(h);
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const env = clamp(0.25 + 1.5 * nfield(1.5, mz, 1, 11, spec.seed + 613, 2, pmax), 0, 1);
    wash[py] = Math.sin((mz / spec.washL) * Math.PI * 2) * env;
  }

  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const wv = wash[py];
    for (let px = 0; px < w; px++) {
      const m = (px + 0.5) * mPerX;
      const k = rutk[px];
      let t = tone[px], rel = rel0[px];

      const g = nfield(m, mz, spec.gx, spec.gz, spec.seed, 3, pmax);
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
      const bn = nfield(m, mz, spec.bx, spec.bz, spec.seed + 91, 2, pmax);
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;

      // A fine pale film of dust settles on everything that is not a rut.
      const df = spec.dustFilm * loose[px] * clamp(0.4 + 0.8 * bn, 0, 1);
      r = lerp(r, spec.dust[0], df); gr = lerp(gr, spec.dust[1], df); b = lerp(b, spec.dust[2], df);

      // Larger aggregate: the top of the field is a stone, the shoulder below
      // it the shadow it casts. Thresholding one field for both is what stops
      // the stones reading as a grey cloud.
      const sn = nfield(m, mz, spec.stoneS, spec.stoneS * 1.5, spec.seed + 77, 2, pmax);
      const st = smoothstep(0.16, 0.40, sn) * spec.stoneAmt * loose[px];
      if (st > 0.004) {
        r = lerp(r, spec.stoneHi[0], st); gr = lerp(gr, spec.stoneHi[1], st); b = lerp(b, spec.stoneHi[2], st);
        rel += st * spec.stoneH;
      }
      const sd = smoothstep(-0.12, -0.36, sn) * spec.stoneAmt * 0.7;
      if (sd > 0.004) {
        r = lerp(r, spec.stoneLo[0], sd); gr = lerp(gr, spec.stoneLo[1], sd); b = lerp(b, spec.stoneLo[2], sd);
        rel -= sd * spec.stoneH * 0.5;
      }

      rel += wv * spec.washH * k;

      for (let i = 0; i < nh; i++) {
        const q = Hl[i];
        const dm = m - q.m;
        if (dm > q.rx * 1.7 || dm < -q.rx * 1.7) continue;
        let dz = mz - q.z; dz -= TILE * Math.round(dz / TILE);
        const q2 = dm * dm * q.irx2 + dz * dz * q.irz2 + g * 0.45 + bn * 0.25;
        if (q2 > 1.9) continue;
        const core = 1 - smoothstep(0.25, 0.95, q2);
        const spoil = (1 - smoothstep(0.95, 1.75, q2)) * (1 - core);
        // A hole in an unpaved road holds water, so its floor is dark and
        // smooth and the spoil thrown out of it is the palest thing around.
        const wet = core * 0.55;
        r = lerp(r, spec.stoneLo[0] * 0.7, wet); gr = lerp(gr, spec.stoneLo[1] * 0.7, wet); b = lerp(b, spec.stoneLo[2] * 0.7, wet);
        r = lerp(r, spec.stoneHi[0], spoil * 0.42); gr = lerp(gr, spec.stoneHi[1], spoil * 0.42); b = lerp(b, spec.stoneHi[2], spoil * 0.42);
        rel -= core * q.depth;
        rel += spoil * q.depth * 0.22;
      }

      const gk = clamp(grass[px] * (0.78 + 0.85 * nfield(m, mz, 0.7, 2.4, spec.seed + 7, 2, pmax)), 0, 1);
      if (gk > 0.004) {
        r = lerp(r, spec.grass[0], gk); gr = lerp(gr, spec.grass[1], gk); b = lerp(b, spec.grass[2], gk);
        rel += gk * 0.020;
      }

      const o = (py * w + px) * 4;
      d[o] = r; d[o + 1] = gr; d[o + 2] = b; d[o + 3] = 255;
      H[py * w + px] = rel;
    }
  }
}

/** Concrete paving slabs. U runs from the kerb outward. */
function paintWalk(spec, w, h, img, H, mPerX, mPerY) {
  const d = img.data;
  // The finest lengthwise noise period this row can hold. 2.6 texels per cell
  // is the smallest that does not visibly beat against the pixel grid.
  const pmax = Math.max(2, Math.floor(h / 2.6));
  const microS = 2.5 * mPerX, microH = 0.30 * mPerX;
  const tone = new Float32Array(w), rel0 = new Float32Array(w);
  for (let px = 0; px < w; px++) {
    const m = (px + 0.5) * mPerX;
    let t = 1 - spec.kerbGrime * (1 - smoothstep(0, 0.6, m));
    let rel = 0;
    // The longitudinal joint down the middle of the pavement.
    const j = 1 - smoothstep(0.012, 0.05, Math.abs(m - spec.width * 0.5));
    t *= 1 - 0.32 * j;
    rel -= spec.jointH * j;
    tone[px] = t; rel0[px] = rel;
  }

  const jrow = new Float32Array(h), slabT = new Float32Array(h), crackA = new Float32Array(h);
  const crackB = new Float32Array(h);
  // Twenty joints have to fit into eighty-odd texels, so a joint IS about a
  // texel wide — and at that size POINT-sampling it makes the answer depend on
  // where the texel centre happens to land relative to the groove. 1.2 m is
  // not a whole number of texels, so that phase walks along the row: some
  // joints came out full strength, some half, some vanished while the slab
  // tone either side of them still stepped, and the beat between the two
  // periods crawled along the pavement.
  //
  // So the groove is INTEGRATED, not sampled. `jrow` is the exact fraction of
  // the texel a groove of half-width `jhw` covers, which sums to the same
  // total for every joint whatever its phase — measured, 0.0% spread against
  // the sampled version's 13.8%. The per-texel peak still varies, as it must
  // for anything this narrow, but that is what the mip chain averages out and
  // the integral is what it averages to.
  const jhw = Math.max(0.006, 0.5 * mPerY);
  const jspan = 1 / mPerY;
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const f = Math.abs(mz / spec.slab - Math.round(mz / spec.slab)) * spec.slab;
    jrow[py] = clamp(Math.min(2 * jhw, mPerY, jhw + mPerY * 0.5 - f) * jspan, 0, 1);
    const si = Math.floor(mz / spec.slab);
    // Each slab was poured on a different day, and one in six has cracked.
    slabT[py] = 0.955 + hash1(si, spec.seed) * 0.09;
    if (hash1(si, spec.seed + 17) < spec.crackRate) {
      const local = mz - si * spec.slab;
      crackA[py] = 1;
      crackB[py] = (0.25 + hash1(si, spec.seed + 29) * 0.5) * spec.width
        + (local / spec.slab - 0.5) * spec.width * (hash1(si, spec.seed + 31) * 1.6 - 0.8);
    } else crackA[py] = 0;
  }

  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const jv = jrow[py], sv = slabT[py];
    for (let px = 0; px < w; px++) {
      const m = (px + 0.5) * mPerX;
      let t = tone[px] * sv * (1 - 0.32 * jv);
      let rel = rel0[px] - spec.jointH * jv;

      const g = nfield(m, mz, spec.gx, spec.gz, spec.seed, 3, pmax);
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
      rel += nfield(m, mz, microS, microS * 4, spec.seed + 877, 1, pmax) * microH;
      const bn = nfield(m, mz, spec.bx, spec.bz, spec.seed + 91, 2, pmax);
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;
      const ak = 0.13 * clamp(0.4 + 0.9 * g, 0, 1);
      r = lerp(r, spec.agg[0], ak); gr = lerp(gr, spec.agg[1], ak); b = lerp(b, spec.agg[2], ak);

      if (crackA[py]) {
        const ck = 1 - smoothstep(0, 0.035, Math.abs(m - crackB[py] + bn * 0.06));
        if (ck > 0.004) { r *= 1 - 0.5 * ck; gr *= 1 - 0.5 * ck; b *= 1 - 0.5 * ck; rel -= ck * 0.004; }
      }
      // Weeds take the joints, starting at the edge away from the traffic.
      const wk = clamp((jv - 0.45) * 1.8, 0, 1) * smoothstep(0.4, 2.2, m) * (0.35 + 0.65 * bn);
      if (wk > 0.004) { r = lerp(r, spec.grass[0], wk); gr = lerp(gr, spec.grass[1], wk); b = lerp(b, spec.grass[2], wk); }

      const o = (py * w + px) * 4;
      d[o] = r; d[o + 1] = gr; d[o + 2] = b; d[o + 3] = 255;
      H[py * w + px] = rel;
    }
  }
}

/** The kerb face. U runs UP the face: 0 is the gutter, 1 the pavement edge. */
function paintKerb(spec, w, h, img, H, mPerX, mPerY) {
  const d = img.data;
  // The finest lengthwise noise period this row can hold. 2.6 texels per cell
  // is the smallest that does not visibly beat against the pixel grid.
  const pmax = Math.max(2, Math.floor(h / 2.6));
  const tone = new Float32Array(w), rel0 = new Float32Array(w), bright = new Float32Array(w);
  for (let px = 0; px < w; px++) {
    const u = (px + 0.5) / w;
    // Dark in the gutter, flat up the face, then the chamfered arris — which is
    // the edge that catches every headlight and streetlight in the city.
    let t = 0.66 + 0.30 * smoothstep(0.02, 0.55, u);
    const ar = smoothstep(spec.arris - 0.06, spec.arris + 0.02, u);
    t *= 1 + 0.34 * ar;
    t *= 1 - 0.30 * (1 - smoothstep(0, spec.gutterLine, u));
    bright[px] = ar;
    // The arris is a real chamfer: it leans back, so the relief rises across it
    // and drops again on the top sliver.
    let rel = spec.arrisH * ar * (1 - smoothstep(0.965, 1.0, u));
    rel -= 0.004 * (1 - smoothstep(0, spec.gutterLine, u));
    tone[px] = t; rel0[px] = rel;
  }

  const jrow = new Float32Array(h), unitT = new Float32Array(h);
  // Same rule as the pavement, and the kerb is where it bites hardest: this is
  // the shortest row in the atlas, so a 1.2 m unit is barely four texels and
  // the point-sampled joint aliased into a moire that crawled along the kerb.
  // The groove is integrated instead — `jrow` is the exact fraction of the
  // texel it covers, so every unit joint carries the same weight whatever its
  // phase, and the tone step between two units always has a joint under it.
  const jhw = Math.max(0.006, 0.5 * mPerY);
  const jspan = 1 / mPerY;
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const f = Math.abs(mz / spec.slab - Math.round(mz / spec.slab)) * spec.slab;
    jrow[py] = clamp(Math.min(2 * jhw, mPerY, jhw + mPerY * 0.5 - f) * jspan, 0, 1);
    unitT[py] = 0.955 + hash1(Math.floor(mz / spec.slab), spec.seed) * 0.09;
  }

  const SC = spec.scuffs, nsc = SC.length;
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const jv = jrow[py], uv = unitT[py];
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      const m = u * spec.width;
      let t = tone[px] * uv * (1 - 0.42 * jv);
      let rel = rel0[px] - spec.jointH * jv;

      const g = nfield(m, mz, spec.gx * spec.width, spec.gz, spec.seed, 3, pmax);
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
      const bn = nfield(m, mz, spec.bx * spec.width, spec.bz, spec.seed + 91, 2, pmax);
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;
      const ak = 0.14 * bright[px] * clamp(0.4 + 0.9 * g, 0, 1);
      r = lerp(r, spec.agg[0], ak); gr = lerp(gr, spec.agg[1], ak); b = lerp(b, spec.agg[2], ak);

      for (let i = 0; i < nsc; i++) {
        const q = SC[i];
        const du = Math.abs(u - q.u) - q.hu;
        if (du > 0.02) continue;
        let dz = mz - q.z; dz -= TILE * Math.round(dz / TILE);
        const dzz = Math.abs(dz) - q.hz;
        if (dzz > 0.02) continue;
        const k = (1 - smoothstep(-0.03, 0.01, (du > dzz ? du : dzz) + bn * 0.02)) * q.k;
        if (k < 0.004) continue;
        if (q.chip) {
          // A chipped arris shows the pale aggregate inside the concrete.
          r = lerp(r, spec.agg[0] * 1.12, k); gr = lerp(gr, spec.agg[1] * 1.12, k); b = lerp(b, spec.agg[2] * 1.12, k);
          rel -= k * 0.007;
        } else {
          r = lerp(r, spec.tar[0], k * 0.8); gr = lerp(gr, spec.tar[1], k * 0.8); b = lerp(b, spec.tar[2], k * 0.8);
        }
      }

      const o = (py * w + px) * 4;
      d[o] = r; d[o + 1] = gr; d[o + 2] = b; d[o + 3] = 255;
      H[py * w + px] = rel;
    }
  }
}

/**
 * Turns the relief buffer into a tangent-space normal map.
 *
 * Central differences in METRES, not texels, so a 2 cm stone on a gravel lane
 * and a 2 cm stone on a highway tilt the normal by the same angle even though
 * the two rows have different texel sizes. Y wraps with the tile and X clamps,
 * matching the sampler: V wraps by hand in the UVs, U is ClampToEdge.
 */
function reliefToNormal(Hb, nrm, w, h, mPerX, mPerY) {
  const d = nrm.data;
  const sx = 1 / (2 * mPerX), sz = 1 / (2 * mPerY);
  for (let py = 0; py < h; py++) {
    const up = (py === 0 ? h - 1 : py - 1) * w;
    const dn = (py === h - 1 ? 0 : py + 1) * w;
    const cur = py * w;
    for (let px = 0; px < w; px++) {
      const xl = px > 0 ? px - 1 : 0, xr = px < w - 1 ? px + 1 : w - 1;
      const du = (Hb[cur + xr] - Hb[cur + xl]) * ((px > 0 && px < w - 1) ? sx : sx * 2);
      const dv = (Hb[dn + px] - Hb[up + px]) * sz;
      const inv = 1 / Math.sqrt(du * du + dv * dv + 1);
      const o = (cur + px) * 4;
      d[o] = (0.5 - du * inv * 0.5) * 255;
      d[o + 1] = (0.5 - dv * inv * 0.5) * 255;
      d[o + 2] = (0.5 + inv * 0.5) * 255;
      d[o + 3] = 255;
    }
  }
}

/** Paints one atlas row's colour and normal into the two scratch contexts. */
function paintRow(ctx, nctx, w, h, spec, Hb) {
  const img = ctx.createImageData(w, h);
  const nrm = nctx.createImageData(w, h);
  const mPerX = spec.width / w, mPerY = TILE / h;
  if (spec.paint === 'paved') paintPaved(spec, w, h, img, Hb, mPerX, mPerY);
  else if (spec.paint === 'loose') paintLoose(spec, w, h, img, Hb, mPerX, mPerY);
  else if (spec.paint === 'walk') paintWalk(spec, w, h, img, Hb, mPerX, mPerY);
  else paintKerb(spec, w, h, img, Hb, mPerX, mPerY);
  reliefToNormal(Hb, nrm, w, h, mPerX, mPerY);
  ctx.putImageData(img, 0, 0);
  nctx.putImageData(nrm, 0, 0);
}

/**
 * Stacks every row into TWO canvases — albedo and normal — and returns the V
 * range of each row, which is shared by both.
 *
 * Row height is proportional to spec.weight rather than uniform, because the
 * along-road axis is the scarce one and the rows need wildly different amounts
 * of it. The proportional share is clamped at both ends and the total is scaled
 * down if the clamps push it over, so the atlas can never exceed the 2048 px
 * that WebGL2 guarantees no matter how many rows a world asks for.
 */
function buildAtlas(specs) {
  const rows = specs.length;
  let sum = 0;
  for (const s of specs) sum += s.weight;

  const slots = new Int32Array(rows);
  let H = 0;
  for (let r = 0; r < rows; r++) {
    slots[r] = clamp(Math.floor(ATLAS_MAX * specs[r].weight / sum), SLOT_MIN, SLOT_MAX);
    H += slots[r];
  }
  if (H > ATLAS_MAX) {
    // Rescale — but against a minimum that itself fits. A FIXED floor times
    // enough rows overruns 2048 again, which would break the one guarantee
    // this function exists to make, quietly, on the first world that asked for
    // more than sixty-odd rows. Nothing does today; that is exactly why it has
    // to be right here rather than noticed later.
    const floor = Math.max(GUARD * 2 + 2, Math.min(GUARD * 2 + 16, Math.floor(ATLAS_MAX / rows)));
    const k = ATLAS_MAX / H;
    H = 0;
    for (let r = 0; r < rows; r++) { slots[r] = Math.max(floor, Math.floor(slots[r] * k)); H += slots[r]; }
    // Rounding up to the floor can still leave a handful of texels over. Take
    // them off the tallest rows, which are the ones that miss them least.
    while (H > ATLAS_MAX) {
      let big = 0;
      for (let r = 1; r < rows; r++) if (slots[r] > slots[big]) big = r;
      if (slots[big] <= GUARD * 2 + 2) break;          // cannot shrink further
      slots[big]--; H--;
    }
  }
  let maxContent = 0;
  for (let r = 0; r < rows; r++) maxContent = Math.max(maxContent, slots[r] - GUARD * 2);

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ncanvas = document.createElement('canvas');
  ncanvas.width = ATLAS_W; ncanvas.height = H;
  const nctx = ncanvas.getContext('2d');

  // One scratch pair and one relief buffer at the tallest row, reused by all of
  // them — eleven rows is eleven canvases otherwise, at load, for nothing.
  const scratch = document.createElement('canvas');
  scratch.width = ATLAS_W; scratch.height = maxContent;
  const sctx = scratch.getContext('2d');
  const nscratch = document.createElement('canvas');
  nscratch.width = ATLAS_W; nscratch.height = maxContent;
  const nsctx = nscratch.getContext('2d');
  const Hb = new Float32Array(ATLAS_W * maxContent);

  const ranges = [];
  let top = 0;
  for (let r = 0; r < rows; r++) {
    const slot = slots[r], contentH = slot - GUARD * 2;
    paintRow(sctx, nsctx, ATLAS_W, contentH, specs[r], Hb);
    for (const [dst, src] of [[ctx, scratch], [nctx, nscratch]]) {
      dst.drawImage(src, 0, 0, ATLAS_W, contentH, 0, top + GUARD, ATLAS_W, contentH);
      // Guards carry the tile across the seam so bilinear filtering has the right
      // neighbours at both ends of the row.
      dst.drawImage(src, 0, contentH - GUARD, ATLAS_W, GUARD, 0, top, ATLAS_W, GUARD);
      dst.drawImage(src, 0, 0, ATLAS_W, GUARD, 0, top + GUARD + contentH, ATLAS_W, GUARD);
    }
    ranges.push({ v0: (top + GUARD) / H, v1: (top + GUARD + contentH) / H, px: contentH });
    top += slot;
  }
  return { canvas, ncanvas, ranges, width: ATLAS_W, height: H };
}

// ---------------------------------------------------------------------------
// Geometry buffers
// ---------------------------------------------------------------------------

// Scratch vertex records. Filling four reused objects keeps the builder legible
// without littering the heap with a million three-field literals at load.
const _a = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _b = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _c = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _d = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };

function V(o, x, y, z, u, v, t) {
  o.x = x; o.y = y; o.z = z; o.u = u; o.v = v; o.t = t;
  return o;
}

function vert(bk, x, y, z, nx, ny, nz, u, v, t) {
  bk.pos.push(x, y, z);
  bk.nor.push(nx, ny, nz);
  bk.uv.push(u, v);
  bk.col.push(t, t, t);
}

/**
 * One flat triangle, wound so its normal faces `up`.
 *
 * Junction fans and kerb returns are assembled from polylines whose handedness
 * depends on which end of an edge the node happens to be, and getting that
 * wrong shows up as invisible tarmac. Deciding the winding from the geometry
 * itself removes the whole class of mistake.
 */
function tri(bk, p, q, r, ux, uy, uz) {
  const ax = q.x - p.x, ay = q.y - p.y, az = q.z - p.z;
  const bx = r.x - p.x, by = r.y - p.y, bz = r.z - p.z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return;                       // collapsed; nothing to draw
  nx /= len; ny /= len; nz /= len;
  if (nx * ux + ny * uy + nz * uz < 0) {
    nx = -nx; ny = -ny; nz = -nz;
    const s = q; q = r; r = s;
  }
  vert(bk, p.x, p.y, p.z, nx, ny, nz, p.u, p.v, p.t);
  vert(bk, q.x, q.y, q.z, nx, ny, nz, q.u, q.v, q.t);
  vert(bk, r.x, r.y, r.z, nx, ny, nz, r.u, r.v, r.t);
}

function quad(bk, p, q, r, s, ux, uy, uz) {
  tri(bk, p, q, r, ux, uy, uz);
  tri(bk, p, r, s, ux, uy, uz);
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createRoads(world, ground, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const REGION = opts.region ?? 512;
  const seed = opts.seed ?? world.seed ?? 0;
  const half = world.half;
  const GRID = Math.ceil((half * 2) / REGION);
  const CITY = { street: 1, avenue: 1, link: 1 };   // kinds that get sidewalks

  // ---- atlas rows -------------------------------------------------------
  // Registered in a fixed pass over the world so the layout is deterministic
  // and the atlas holds nothing the map does not actually use. The key carries
  // the road KIND as well as its dimensions, because two kinds that happen to
  // share a profile do not share a history: wear, cracking, patching and how
  // far the paint has faded all key off the kind alone.
  const specs = [];
  const rowOf = new Map();
  function row(key, make) {
    let r = rowOf.get(key);
    if (r === undefined) { r = specs.length; specs.push(make()); rowOf.set(key, r); }
    return r;
  }

  const edgeRow = new Int16Array(world.edges.length);
  let anyCity = false;
  for (const e of world.edges) {
    const key = `${e.kind}|${e.markings}|${e.width}|${e.lanes}|${e.surface}`;
    // Anything layout.js does not call asphalt is an unpaved lane, so a surface
    // added to ROAD later gets the loose painter by default rather than being
    // silently drawn as tarmac.
    edgeRow[e.i] = row(key, () => (e.surface === 'asphalt'
      ? pavedSpec(e.kind, e.markings, e.width, e.lanes, seed + rowSeed(e.kind, e.width))
      : looseSpec(e.kind, e.width, seed + rowSeed(e.kind, e.width))));
    if (CITY[e.kind] === 1) anyCity = true;
  }
  const walkRow = anyCity ? row('walk', () => walkSpec(seed + 311)) : -1;
  const kerbRow = anyCity ? row('kerb', () => kerbSpec(seed + 733)) : -1;

  // A junction takes the surface most of its arms are made of; a gravel lane
  // meeting a dirt one gives a gravel fill, because the dressing is what gets
  // dragged across the mouth.
  const junctions = world.nodes.filter((n) => n.edges.length >= 3);
  const patchRow = new Map();
  const patchKind = new Map();
  for (const n of junctions) {
    let loose = 0, gravel = 0;
    for (const ei of n.edges) {
      const sf = world.edges[ei].surface;
      if (sf !== 'asphalt') { loose++; if (sf === 'gravel') gravel++; }
    }
    const s = loose * 2 > n.edges.length ? (gravel * 2 > loose ? 'gravel' : 'dirt') : 'asphalt';
    patchKind.set(n.i, s);
    if (!patchRow.has(s)) patchRow.set(s, row('patch:' + s, () => patchSpec(s, seed + 977)));
  }

  const atlas = buildAtlas(specs);
  const ranges = atlas.ranges;

  // ---- buckets ----------------------------------------------------------
  const buckets = new Map();
  function bucket(x, z) {
    const i = clamp(Math.floor((x + half) / REGION), 0, GRID - 1);
    const j = clamp(Math.floor((z + half) / REGION), 0, GRID - 1);
    const k = j * GRID + i;
    let bk = buckets.get(k);
    if (!bk) {
      bk = { cx: (i + 0.5) * REGION - half, cz: (j + 0.5) * REGION - half, pos: [], nor: [], uv: [], col: [] };
      buckets.set(k, bk);
    }
    return bk;
  }

  // Low-frequency patchiness in world space. The texture repeats every 24 m;
  // this does not, which is what stops the eye locking onto the tile.
  const tseed = (seed + 4021) | 0;
  const tint = (x, z) => 1 + fbm(x * 0.0143, z * 0.0143, tseed, 2) * 0.055;

  const vOf = (r, v) => ranges[r].v0 + v * (ranges[r].v1 - ranges[r].v0);

  // ---- junction setbacks ------------------------------------------------
  // Ribbons are pulled back from every junction and the gap is filled with a
  // patch. Running them all the way in instead leaves wedges of bare terrain
  // between the mouths, which is the single most obvious tell that a road
  // network was generated rather than built.
  const setback = new Float64Array(world.nodes.length);
  for (const n of junctions) {
    let maxHalf = 0, minLen = Infinity;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (e.width / 2 > maxHalf) maxHalf = e.width / 2;
      if (e.length < minLen) minLen = e.length;
    }
    setback[n.i] = Math.min(maxHalf * 1.25, minLen * 0.34, 26);
  }
  const trim = new Float64Array(world.edges.length * 2);
  for (const e of world.edges) {
    let s0 = setback[e.a], s1 = setback[e.b];
    const cap = e.length * 0.86;
    if (s0 + s1 > cap && s0 + s1 > 0) { const k = cap / (s0 + s1); s0 *= k; s1 *= k; }
    trim[e.i * 2] = s0; trim[e.i * 2 + 1] = s1;
  }

  // ---- carriageway ribbons, kerbs and sidewalks --------------------------
  // Strips are capped at 7 m across. The road profile the ground field is
  // stamped from has no camber, so a carriageway IS flat across and two
  // vertices would in principle be exact — but where two roads overlap the
  // field is a weighted mean of both and stops being flat. Measured over the
  // whole network, spanning the full width with one strip leaves 3% of the
  // surface more than 6 cm off the physics height, which is more than the
  // clearance it is drawn with; at 7 m strips that falls to 0.6%.
  const MAX_STRIP = 7;
  const MAX_CROSS = 12;

  const pool = [];
  function station(i) {
    let s = pool[i];
    if (!s) {
      pool[i] = s = {
        cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, ax: 0, az: 0,
        X: new Float64Array(MAX_CROSS), Y: new Float64Array(MAX_CROSS),
        Z: new Float64Array(MAX_CROSS), T: new Float64Array(MAX_CROSS),
        ox: 0, oy: 0, oz: 0, qx: 0, qy: 0, qz: 0,
      };
    }
    return s;
  }

  const arcs = [];
  let quads = 0;

  for (const e of world.edges) {
    if (!e.pts || e.pts.length < 2 || e.length < 0.5) continue;
    const s0 = trim[e.i * 2], s1 = e.length - trim[e.i * 2 + 1];
    const usable = s1 - s0;
    if (usable < 0.6) continue;

    arcs.length = 0;
    const nFull = Math.floor(usable / STEP);
    const rem = usable - nFull * STEP;
    for (let i = 0; i <= nFull; i++) arcs.push(s0 + i * STEP);
    // The ribbon has to end EXACTLY where the junction patch starts, so a short
    // remainder is absorbed into the last quad rather than dropped. V then runs
    // a little past 1, which is precisely what the guard band is there for.
    if (rem > 0.4) arcs.push(s1); else arcs[arcs.length - 1] = s1;
    if (arcs.length < 2) continue;

    const h = e.width / 2;
    const rr = edgeRow[e.i];
    const strips = Math.min(MAX_CROSS - 1, Math.max(1, Math.ceil(e.width / MAX_STRIP)));
    const walk = walkRow >= 0 && CITY[e.kind] === 1;

    for (let i = 0; i < arcs.length; i++) {
      const p = pointOnEdge(e, arcs[i]);
      const st = station(i);
      st.ax = p.nx; st.az = p.nz;                 // right-hand normal of the road
      for (let k = 0; k <= strips; k++) {
        const f = (2 * k / strips - 1) * h;
        const x = p.x + p.nx * f, z = p.z + p.nz * f;
        st.X[k] = x; st.Z[k] = z;
        st.Y[k] = ground.heightAt(x, z) + LIFT;
        st.T[k] = tint(x, z);
      }
      st.cx = p.x; st.cz = p.z; st.cy = (st.Y[0] + st.Y[strips]) * 0.5;
      if (walk) {
        const ox = p.x - p.nx * (h + WALK_W), oz = p.z - p.nz * (h + WALK_W);
        const qx = p.x + p.nx * (h + WALK_W), qz = p.z + p.nz * (h + WALK_W);
        st.ox = ox; st.oz = oz; st.oy = ground.heightAt(ox, oz) + LIFT + KERB;
        st.qx = qx; st.qz = qz; st.qy = ground.heightAt(qx, qz) + LIFT + KERB;
      }
    }

    // Per-station normals rather than per-face ones. Roads are the surface the
    // player stares at for the whole game; flat shading bands every 8 m quad
    // across a crest and reads as faceting on an otherwise smooth grade.
    const last = arcs.length - 1;
    for (let i = 0; i <= last; i++) {
      const a = pool[i > 0 ? i - 1 : 0], b = pool[i < last ? i + 1 : last];
      const tx = b.cx - a.cx, ty = b.cy - a.cy, tz = b.cz - a.cz;
      const st = pool[i];
      const dx = st.X[strips] - st.X[0], dy = st.Y[strips] - st.Y[0], dz = st.Z[strips] - st.Z[0];
      const nx = dy * tz - dz * ty, ny = dz * tx - dx * tz, nz = dx * ty - dy * tx;
      const len = Math.hypot(nx, ny, nz) || 1;
      st.nx = nx / len; st.ny = ny / len; st.nz = nz / len;
    }

    for (let i = 0; i < last; i++) {
      const A = pool[i], B = pool[i + 1];
      const bk = bucket((A.cx + B.cx) * 0.5, (A.cz + B.cz) * 0.5);
      const v0 = (i % VSTEPS) / VSTEPS;
      const va = vOf(rr, v0);
      const vb = vOf(rr, v0 + (arcs[i + 1] - arcs[i]) / TILE);

      // Winding verified against forward = -Z, right = +X: index 0 is the left
      // kerb, index `strips` the right, and (left, right, right') faces up.
      for (let k = 0; k < strips; k++) {
        const u0 = k / strips, u1 = (k + 1) / strips;
        vert(bk, A.X[k], A.Y[k], A.Z[k], A.nx, A.ny, A.nz, u0, va, A.T[k]);
        vert(bk, A.X[k + 1], A.Y[k + 1], A.Z[k + 1], A.nx, A.ny, A.nz, u1, va, A.T[k + 1]);
        vert(bk, B.X[k + 1], B.Y[k + 1], B.Z[k + 1], B.nx, B.ny, B.nz, u1, vb, B.T[k + 1]);
        vert(bk, A.X[k], A.Y[k], A.Z[k], A.nx, A.ny, A.nz, u0, va, A.T[k]);
        vert(bk, B.X[k + 1], B.Y[k + 1], B.Z[k + 1], B.nx, B.ny, B.nz, u1, vb, B.T[k + 1]);
        vert(bk, B.X[k], B.Y[k], B.Z[k], B.nx, B.ny, B.nz, u0, vb, B.T[k]);
        quads++;
      }

      if (!walk) continue;
      const R = strips;
      const kva = vOf(kerbRow, v0), kvb = vOf(kerbRow, v0 + (arcs[i + 1] - arcs[i]) / TILE);
      const wva = vOf(walkRow, v0), wvb = vOf(walkRow, v0 + (arcs[i + 1] - arcs[i]) / TILE);

      // Left side, then right. The kerb face points away from the carriageway.
      quad(bk,
        V(_a, A.X[0], A.Y[0], A.Z[0], 0, kva, A.T[0]),
        V(_b, A.X[0], A.Y[0] + KERB, A.Z[0], 1, kva, A.T[0]),
        V(_c, B.X[0], B.Y[0] + KERB, B.Z[0], 1, kvb, B.T[0]),
        V(_d, B.X[0], B.Y[0], B.Z[0], 0, kvb, B.T[0]),
        -A.ax, 0, -A.az);
      quad(bk,
        V(_a, A.X[0], A.Y[0] + KERB, A.Z[0], 0, wva, A.T[0]),
        V(_b, A.ox, A.oy, A.oz, 1, wva, A.T[0]),
        V(_c, B.ox, B.oy, B.oz, 1, wvb, B.T[0]),
        V(_d, B.X[0], B.Y[0] + KERB, B.Z[0], 0, wvb, B.T[0]),
        0, 1, 0);
      quad(bk,
        V(_a, A.X[R], A.Y[R], A.Z[R], 0, kva, A.T[R]),
        V(_b, A.X[R], A.Y[R] + KERB, A.Z[R], 1, kva, A.T[R]),
        V(_c, B.X[R], B.Y[R] + KERB, B.Z[R], 1, kvb, B.T[R]),
        V(_d, B.X[R], B.Y[R], B.Z[R], 0, kvb, B.T[R]),
        A.ax, 0, A.az);
      quad(bk,
        V(_a, A.X[R], A.Y[R] + KERB, A.Z[R], 0, wva, A.T[R]),
        V(_b, A.qx, A.qy, A.qz, 1, wva, A.T[R]),
        V(_c, B.qx, B.qy, B.qz, 1, wvb, B.T[R]),
        V(_d, B.X[R], B.Y[R] + KERB, B.Z[R], 0, wvb, B.T[R]),
        0, 1, 0);
      quads += 4;
    }
  }

  // ---- junction patches and kerb returns ---------------------------------
  const arms = [];
  let patches = 0;

  for (const n of junctions) {
    arms.length = 0;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (!e.pts || e.length < 0.5) continue;
      const atA = e.a === n.i;
      const p = pointOnEdge(e, atA ? trim[ei * 2] : e.length - trim[ei * 2 + 1]);
      if (!p) continue;
      // Leaving the node runs against increasing arc length whenever the node
      // is the far end of the edge, and the road's normal has to turn with it.
      const sg = atA ? 1 : -1;
      const nx = p.nx * sg, nz = p.nz * sg, h = e.width / 2;
      arms.push({
        city: CITY[e.kind] === 1,
        ang: Math.atan2(p.tz * sg, p.tx * sg),
        ax: p.x - nx * h, az: p.z - nz * h,                     // clockwise-most
        bx: p.x + nx * h, bz: p.z + nz * h,                     // anticlockwise-most
        ox: p.x - nx * (h + WALK_W), oz: p.z - nz * (h + WALK_W),
        qx: p.x + nx * (h + WALK_W), qz: p.z + nz * (h + WALK_W),
      });
    }
    if (arms.length < 3) continue;
    arms.sort((u, v) => u.ang - v.ang);

    const bk = bucket(n.x, n.z);
    const cy = ground.heightAt(n.x, n.z) + LIFT;
    const ct = tint(n.x, n.z);
    const pr = patchRow.get(patchKind.get(n.i));

    // Fan from the node out to every mouth corner in turn. Sorted by the angle
    // the road leaves at, the corners form a star-shaped ring around the node,
    // so a fan covers both the mouths and the wedges between them.
    let R = 3;
    for (const m of arms) {
      R = Math.max(R, Math.hypot(m.ax - n.x, m.az - n.z), Math.hypot(m.bx - n.x, m.bz - n.z));
    }
    const inv = 0.5 / R;
    const uvP = (o, x, y, z) => V(o, x, y, z,
      clamp(0.5 + (x - n.x) * inv, 0, 1),
      vOf(pr, clamp(0.5 + (z - n.z) * inv, 0, 1)), tint(x, z));

    for (let k = 0; k < arms.length * 2; k++) {
      const m0 = arms[(k >> 1) % arms.length], m1 = arms[((k + 1) >> 1) % arms.length];
      const x0 = (k & 1) ? m0.bx : m0.ax, z0 = (k & 1) ? m0.bz : m0.az;
      const x1 = (k & 1) ? m1.ax : m1.bx, z1 = (k & 1) ? m1.az : m1.bz;
      tri(bk,
        V(_a, n.x, cy, n.z, 0.5, vOf(pr, 0.5), ct),
        uvP(_b, x0, ground.heightAt(x0, z0) + LIFT, z0),
        uvP(_c, x1, ground.heightAt(x1, z1) + LIFT, z1),
        0, 1, 0);
    }
    patches++;

    if (walkRow < 0) continue;
    // Kerb returns. Without them every city intersection has a four-way gap in
    // the pavement, which is far more noticeable than the corners themselves.
    for (let k = 0; k < arms.length; k++) {
      const m0 = arms[k], m1 = arms[(k + 1) % arms.length];
      if (!m0.city || !m1.city) continue;
      const chord = Math.hypot(m1.ax - m0.bx, m1.az - m0.bz);
      if (chord < 0.4) continue;
      const wv = vOf(walkRow, Math.min(1, chord / TILE)), wv0 = vOf(walkRow, 0);
      const kv = vOf(kerbRow, Math.min(1, chord / TILE)), kv0 = vOf(kerbRow, 0);
      const y0 = ground.heightAt(m0.bx, m0.bz) + LIFT;
      const y1 = ground.heightAt(m1.ax, m1.az) + LIFT;
      // The face has to look away from the junction, whichever way round the
      // wedge happens to be wound.
      const mx = (m0.bx + m1.ax) * 0.5 - n.x, mz = (m0.bz + m1.az) * 0.5 - n.z;

      const t0 = tint(m0.bx, m0.bz), t1 = tint(m1.ax, m1.az);
      quad(bk,
        V(_a, m0.bx, y0, m0.bz, 0, kv0, t0), V(_b, m0.bx, y0 + KERB, m0.bz, 1, kv0, t0),
        V(_c, m1.ax, y1 + KERB, m1.az, 1, kv, t1), V(_d, m1.ax, y1, m1.az, 0, kv, t1),
        mx, 0, mz);
      quad(bk,
        V(_a, m0.bx, y0 + KERB, m0.bz, 0, wv0, t0),
        V(_b, m0.qx, ground.heightAt(m0.qx, m0.qz) + LIFT + KERB, m0.qz, 1, wv0, tint(m0.qx, m0.qz)),
        V(_c, m1.ox, ground.heightAt(m1.ox, m1.oz) + LIFT + KERB, m1.oz, 1, wv, tint(m1.ox, m1.oz)),
        V(_d, m1.ax, y1 + KERB, m1.az, 0, wv, t1),
        0, 1, 0);
    }
  }

  // ---- material and meshes -----------------------------------------------
  // buildAtlas() measures each row's v-range from the TOP of the canvas, which
  // is the only sane way to stack rows you are drawing with a 2D context. A
  // CanvasTexture flips Y by default, so without flipY = false every road
  // samples the MIRROR of its own row — asphalt streets came out as the dirt
  // patch tile and sidewalks appeared in the middle of the carriageway. Both
  // atlases are stacked identically, so both need the same treatment; a normal
  // map flipped against its albedo would light every kerb from underneath.
  function makeTex(canvas, space) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = space;
    t.flipY = false;
    // U spans the carriageway and V never leaves its row, so both axes clamp.
    // The tiling along the road is done in the UVs, not by the sampler.
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = opts.anisotropy ?? 8;
    return t;
  }
  const texture = makeTex(atlas.canvas, THREE.SRGBColorSpace);
  const normalTex = makeTex(atlas.ncanvas, THREE.NoColorSpace);

  const material = new THREE.MeshLambertMaterial({
    map: texture,
    // Lambert carries a full tangent-space normal map, and derives the tangent
    // frame from screen-space derivatives, so no tangent attribute is needed —
    // which matters, because adding one would be a fourth buffer over a hundred
    // thousand triangles for something the fragment shader can reconstruct.
    normalMap: normalTex,
    normalScale: new THREE.Vector2(1, 1),
    vertexColors: true,
    // Belt and braces with the 4 cm lift: the terrain mesh is built from the
    // same height field, so at grazing angles a metre away the two surfaces are
    // within a depth-buffer step of each other.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const group = new THREE.Group();
  group.name = 'roads';
  group.matrixAutoUpdate = false;

  const meshes = [];
  const centreX = new Float32Array(buckets.size);
  const centreZ = new Float32Array(buckets.size);
  let triangles = 0, vertices = 0;

  for (const bk of buckets.values()) {
    if (bk.pos.length < 9) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bk.col, 3));
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'roads.region';
    mesh.receiveShadow = true;
    mesh.castShadow = false;                 // a flat sheet casts nothing useful
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    centreX[meshes.length] = bk.cx;
    centreZ[meshes.length] = bk.cz;
    meshes.push(mesh);
    group.add(mesh);
    vertices += bk.pos.length / 3;
    triangles += bk.pos.length / 9;
  }
  group.updateMatrix();
  buckets.clear();

  // ---- runtime ------------------------------------------------------------
  // Defaults to the 'high' row above. main.js never calls roads.setQuality(),
  // so whatever is chosen here is what actually ships.
  let cullDist = opts.drawDistance ?? QUALITY.high.drawDistance;
  const regionRadius = REGION * Math.SQRT1_2;
  let acc = 1;                               // forces a pass on the first frame

  /**
   * Distance culling only — the roads never move, so there is nothing else to
   * do here. Re-evaluated at 20 Hz rather than every frame: a region's
   * visibility cannot change meaningfully in 50 ms at any speed the car can
   * reach, and toggling on the frame boundary makes the horizon flicker.
   */
  function update(cameraPos, dt) {
    // A caller that passes no dt (or a paused dt of 0) would otherwise never
    // reach the threshold again after the first pass and freeze the culling
    // wherever it happened to be. Re-evaluating every call instead is 55
    // compares; the 20 Hz gate is an economy, not a correctness condition.
    acc += dt > 0 ? dt : 0.05;
    if (acc < 0.05) return;
    acc = 0;
    const lim = cullDist + regionRadius;
    const limSq = lim * lim;
    for (let i = 0; i < meshes.length; i++) {
      const dx = cameraPos.x - centreX[i];
      const dz = cameraPos.z - centreZ[i];
      meshes[i].visible = dx * dx + dz * dz < limSq;
    }
  }

  /** Accepts an engine tier name or any object carrying the three fields. */
  function setQuality(q) {
    const t = typeof q === 'string' ? QUALITY[q] : q;
    if (!t) return;
    if (t.drawDistance !== undefined) cullDist = t.drawDistance;
    if (t.anisotropy !== undefined && t.anisotropy !== texture.anisotropy) {
      texture.anisotropy = t.anisotropy;
      normalTex.anisotropy = t.anisotropy;
      texture.needsUpdate = true;            // sampler state is set on upload
      normalTex.needsUpdate = true;
    }
    if (t.normals !== undefined) {
      // Attaching or removing a map recompiles the shader, so this may only
      // ever run on a quality switch. The texture itself is kept either way —
      // the player can switch back, and rebuilding the atlas would cost a
      // second of stall for a setting that is toggled in a menu.
      const want = t.normals ? normalTex : null;
      if (material.normalMap !== want) { material.normalMap = want; material.needsUpdate = true; }
    }
    acc = 1;
  }

  function dispose() {
    for (const m of meshes) m.geometry.dispose();
    group.clear();
    meshes.length = 0;
    material.dispose();
    texture.dispose();
    normalTex.dispose();
  }

  return {
    group, update, setQuality, dispose,
    stats: {
      drawCalls: meshes.length,
      triangles, vertices, quads, patches,
      atlasRows: specs.length,
      atlas: `${atlas.width}x${atlas.height}`,
      atlasMaps: 2,
      // Along-road texels per metre, which is the resolution that actually
      // limits how small a pothole or a joint can be and still read.
      rowPx: ranges.map((r) => r.px),
      buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    },
  };
}
