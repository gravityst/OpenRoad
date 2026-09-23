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
//   * One set of textures for the whole network, so a region is one draw call
//     however many kinds of road run through it.
//
// The ribbon sits 4 cm above ground.heightAt() with polygon offset as well.
// 4 cm is well inside the suspension's own travel so nothing reads as floating,
// and the height comes from the same field the physics stands on — what you see
// and what you drive on cannot disagree.
//
// WHY THE ROADS USED TO LOOK LIKE A PIXEL MOSAIC
//
// Measured, not guessed. Every road style, the kerb, the pavement and the
// junction fills were stacked as rows of ONE 512 px wide canvas no taller than
// 2048 px, so each row got a slice of that height: 150 to 304 texels to cover
// 24 m of road. That is 8 to 16 cm per texel ALONG the road against 1.5 to
// 2.3 cm across it — texels five to nine times longer than they were wide. The
// stone and crack noise was then generated right at that texel scale. Near the
// car a screen pixel covers about a centimetre of road, so every one of those
// long texels was magnified into a visible rectangle, and the thresholded stone
// field became a chequerboard of them. That is the mosaic. At range the other
// half of the design bit: the atlas was 1790 px tall (not a power of two) with
// an 8 px guard between rows, so by the third mip level, and much earlier
// under anisotropic filtering, a road was being averaged with whichever surface
// happened to sit next to it in the stack.
//
// WHAT REPLACED IT
//
//   * A TEXTURE ARRAY, one layer per surface, every layer the same 256 x 1024.
//     24 m of road now gets 1024 texels: 2.3 cm along, 3 to 5 cm across, so the
//     texels are near-square. Layers cannot bleed into each other at any mip
//     level, the sampler wraps V by itself, and the guard bands and hand-rolled
//     wrap are gone.
//
//   * A DETAIL LAYER for everything smaller than that — asphalt chippings,
//     loose gravel, earth, concrete grain — tiled every 1.6 m in WORLD space at
//     3 mm per texel. It is what the eye reads as "road" at the bottom of the
//     screen, and it is continuous across junctions because it does not care
//     which ribbon it is on. Its albedo is mean-neutral, so it adds grain
//     without moving the colour the macro layer chose.
//
//   * VARIANTS. A 24 m tile with a pothole in it is a pothole every 24 m, and
//     at 30 m/s that is a rhythm the eye locks onto inside a second. Each road
//     kind is painted twice with different repairs, holes and sealed cracks,
//     and each tile picks one by hash. Everything within SEAM metres of a tile
//     end is shared by every variant, so any sequence of them is seamless.
//
//   * A real surface model. The material is PBR: polished wheel paths, bled
//     binder and crack sealant are glossier than the chippings around them, so
//     a low sun picks the wheel tracks out the way it does on a real lane. Rain
//     darkens the surface and fills the ruts and potholes first. The sky the
//     road reflects is the sky the sky module draws, handed over each frame.
//
//   * A ragged edge. A country road does not stop in a ruled line: the last
//     handspan of tarmac breaks up into chippings and the gravel shoulder. A
//     narrow fringe strip either side does that by alpha test, so the edge
//     blends into the verge instead of sitting on it like a sheet of paper.
//
// All of it is still generated from the seed at load, and none of it needs a
// canvas, which means the headless harness builds the exact textures the
// browser does and can measure them.

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

// Layer size. 1024 along 24 m is 2.3 cm per texel, which is about what a
// screen pixel covers five metres ahead of the car; finer than that is the
// detail layer's job. Across, 256 texels spans the widest road in this world
// (12 m) at under 5 cm. A world with a 26 m highway gets 512 automatically.
const LAYER_H = 1024;
const LAYER_W_NARROW = 256;
const LAYER_W_WIDE = 512;

// Every variant of a kind is identical within this many metres of either tile
// end, which is what lets any variant follow any other without a seam.
const SEAM = 1.6;

// Detail layer: 512 texels over 1.6 m of world, so 3.1 mm per texel.
const DETAIL_PX = 512;
const DETAIL_M = 1.6;
const DETAIL = { asphalt: 0, gravel: 1, dirt: 2, concrete: 3, none: -1 };

// How far the ragged edge reaches past the carriageway, in metres. A circuit's
// edge is a built edge and stays crisp.
const FRINGE = { paved: 0.85, loose: 0.75, circuit: 0 };

// How hard a road has been used, which is the one number the whole wear model
// hangs off: it drives binder oxidation (old asphalt is grey, not black), how
// far the markings have faded, how much cracking and patching there is, and
// whether there are potholes at all. Highways get resurfaced; a country lane
// gets patched until it is more patch than road. A circuit is resurfaced every
// few seasons and swept before every meeting.
const AGE = {
  highway: 0.30, avenue: 0.46, link: 0.52, street: 0.64, rural: 0.80,
  circuit: 0.10, gravel: 0.70, dirt: 0.80, track: 0.92, rallyx: 0.95,
};

// How many differently-worn copies of each kind to paint. Every copy costs a
// 256 x 1024 layer in each of two textures (1.4 MB each with mips).
const VARIANTS = {
  rural: 2, street: 2, avenue: 2, link: 2, highway: 2,
  // A circuit has no repairs, holes or sealed cracks, so a second copy of it
  // would differ only in where its few hairline cracks run. Not worth a layer.
  circuit: 1,
  gravel: 2, dirt: 2, track: 2, rallyx: 2,
};

// The unpaved kinds are different roads, not one drawn at different widths.
// `stony` is how much of the surface is loose stone rather than earth, and
// `used` is how completely traffic has claimed it — the pair decides the
// dressing, the depth of the ruts and whether anything grows down the middle.
// The rallycross is stone over hardpack and is driven flat out lap after lap,
// so it has no crown of grass and the racing line is scoured bare.
const LOOSE = {
  gravel: { stony: 1.00, used: 0.90 },
  dirt:   { stony: 0.42, used: 0.70 },
  track:  { stony: 0.26, used: 0.28 },
  rallyx: { stony: 0.88, used: 1.00 },
};

// Cull distances, NOT the engine's raw tier draw distances. Culling a region
// the player can still see is worse than drawing it: sky.js does not close its
// fog until drawDistance * 1.55 in clear weather, so a road dropped at the raw
// tier figure vanishes over bare terrain while it is still well over half
// visible. Costs nothing here — every region shares one material, and the
// frustum still throws away everything behind the camera.
//
// `normals` drops the normal and detail relief on the lowest tier. That is a
// shader-program change, so it may only ever happen on a quality switch.
const QUALITY = {
  low:    { anisotropy: 2,  drawDistance: 2170, normals: false },
  medium: { anisotropy: 8,  drawDistance: 3410, normals: true },
  high:   { anisotropy: 12, drawDistance: 4960, normals: true },
  ultra:  { anisotropy: 16, drawDistance: 6980, normals: true },
};

/** SURFACES stores 0xRRGGBB; every colour in this file is a 0..255 triple. */
function surfaceRGB(name, gain = 1) {
  const c = SURFACES[name].colour;
  return [((c >> 16) & 255) * gain, ((c >> 8) & 255) * gain, (c & 255) * gain];
}

function mix3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** sRGB 0..255 to linear 0..1, for colours handed to the shader as uniforms. */
function lin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * A row's own seed, keyed on the road KIND as well as its width.
 *
 * The width alone is not enough: layout.js gives `gravel` and `dirt` the same
 * 7.5 m, so a width-derived seed handed both of them the SAME RNG stream and
 * the same noise seed — identical stones, identical blotches, and potholes in
 * identical places on the two roads whose whole point is that they are not the
 * same road.
 */
function rowSeed(kind, width) {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (Math.imul(h, 31) + kind.charCodeAt(i)) | 0;
  return width * 17 + (h & 0xffff);
}

const quinticT = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// ---------------------------------------------------------------------------
// Lattice noise
// ---------------------------------------------------------------------------

/**
 * Value noise in METRE space that repeats exactly every TILE metres along the
 * road and is clamped across it, returned as a function (m, mz) -> [-1, 1].
 *
 * The random lattice is built once up front instead of hashed per sample, which
 * is four array reads against four integer hashes and makes the 1024-texel
 * layers affordable at load. Periodicity is exact: the lattice index along the
 * road is taken modulo the period, so the cell at the end of the tile shares
 * its corners with the cell at the start and there is no seam and no blend.
 *
 * `sx` and `sz` are deliberately different: tarmac grain IS streaked along the
 * direction of travel by tyre polish and water runoff. `sz` is snapped to a
 * whole number of cells per tile, and every octave doubles both frequency and
 * period. Octaves stop once a cell would be under `minTexels` texels long,
 * because noise finer than the texel grid is not detail, it is moire.
 */
function makeField(width, sx, sz, seed, oct, texPerTile, minTexels = 2.6) {
  const pmax = Math.max(2, Math.floor(texPerTile / minTexels));
  const levels = [];
  let p = Math.min(pmax, Math.max(1, Math.round(TILE / sz)));
  let fx = 1 / sx, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    const nx = Math.ceil(width * fx) + 2;
    const a = new Float32Array(nx * p);
    const s = seed + o * 1013;
    for (let j = 0; j < p; j++) for (let i = 0; i < nx; i++) a[j * nx + i] = hash2(i, j, s) * 2 - 1;
    levels.push({ a, nx, p, fx, fz: p / TILE, amp });
    norm += amp; amp *= 0.5; fx *= 2; p *= 2;
    if (p > pmax) break;
  }
  const inv = 1 / norm, n = levels.length;
  return function field(m, mz) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const L = levels[k];
      const x = m * L.fx, z = mz * L.fz;
      let x0 = Math.floor(x), z0 = Math.floor(z);
      const u = quinticT(x - x0), v = quinticT(z - z0);
      if (x0 < 0) x0 = 0; else if (x0 > L.nx - 2) x0 = L.nx - 2;
      z0 %= L.p; if (z0 < 0) z0 += L.p;
      const z1 = z0 + 1 === L.p ? 0 : z0 + 1;
      const ra = z0 * L.nx + x0, rb = z1 * L.nx + x0;
      const A = L.a[ra], B = L.a[ra + 1], C = L.a[rb], D = L.a[rb + 1];
      const top = A + (B - A) * u, bot = C + (D - C) * u;
      sum += (top + (bot - top) * v) * L.amp;
    }
    return sum * inv;
  };
}

/** 1 in the middle of a tile, 0 within SEAM of either end. */
function seamWeight(mz) {
  return smoothstep(0, SEAM, mz) * smoothstep(0, SEAM, TILE - mz);
}

// ---------------------------------------------------------------------------
// Marking layouts
// ---------------------------------------------------------------------------

/**
 * Longitudinal stripes for one road style, in metres from the left edge.
 * `dash`/`gap` cycles are chosen to divide TILE exactly (3+9 and 2+4 both do),
 * otherwise the dash pattern would visibly stutter at every texture repeat.
 * Every plan is symmetric about the centre line, which is what lets a whole
 * road be mirrored across its width for variety without the paint noticing.
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
    // Dashed centre line and solid edge lines 35 cm in. The edge lines are the
    // single strongest cue that a strip of tarmac is a ROAD rather than a path:
    // they give the eye the road's width at a glance, even at night.
    line(c, 0.14, 3, 9);
    line(0.35, 0.10); line(width - 0.35, 0.10);
  } else if (markings === 'circuit') {
    // Track limits: a solid white line along each edge, and nothing down the
    // middle, because a circuit has no oncoming traffic to separate.
    line(0.28, 0.12); line(width - 0.28, 0.12);
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
// Wear features, drawn from each variant's own seed
// ---------------------------------------------------------------------------
//
// Every one of these is placed clear of the tile ends by SEAM plus its own
// half-length, which is the other half of the seamless-variant guarantee.

function placeAlong(rnd, halfLen) {
  const lo = SEAM + halfLen + 0.1, hi = TILE - SEAM - halfLen - 0.1;
  return hi > lo ? lo + rnd() * (hi - lo) : TILE / 2;
}

/**
 * Patch repairs, as boxes in (across, along) metres with a sealed overband.
 *
 * Two shapes, because real roads have two: a trench reinstatement that crosses
 * the whole carriageway where a service was laid, and a squarish pothole repair
 * a metre or two across.
 */
function makePatches(rnd, width, age, full) {
  const out = [];
  const n = Math.round(0.4 + 3.6 * age * age);
  for (let i = 0; i < n; i++) {
    const trench = rnd() < full;
    const hm = trench ? width * 0.52 : 0.35 + rnd() * 1.30;
    const hz = trench ? 0.50 + rnd() * 0.85 : 0.45 + rnd() * 1.45;
    out.push({
      mc: trench ? width * 0.5 : hm + rnd() * Math.max(0.1, width - 2 * hm),
      hm, hz, zc: placeAlong(rnd, hz + 0.1),
      // A fresh repair is darker than the road around it, but only by about a
      // quarter — pushed further it stops reading as asphalt and starts reading
      // as a hole. One in five is an older repair that has itself gone grey.
      tone: rnd() < 0.2 ? 1.05 + rnd() * 0.10 : 0.76 + rnd() * 0.14,
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
      m: 0.45 + rnd() * Math.max(0.1, width - 0.9), z: placeAlong(rnd, rz * 1.4),
      rx, rz, irx2: 1 / (rx * rx), irz2: 1 / (rz * rz),
      depth: deep * (0.45 + rnd() * 0.75),
    });
  }
  return out;
}

/**
 * Transverse cracks, most of them sealed with a bead of black bitumen.
 *
 * Old asphalt cracks ACROSS the road from thermal contraction, every few
 * metres, and on a country lane the council runs a bead of sealant down each
 * one. These wandering glossy black lines — "tar snakes" — are one of the most
 * recognisable things about a real rural road, and nothing else in the texture
 * runs across the direction of travel.
 */
function makeTransverse(rnd, width, age) {
  const out = [];
  const n = Math.round(age * age * 4.2);
  for (let i = 0; i < n; i++) {
    out.push({
      z: placeAlong(rnd, 0.35),
      amp: 0.06 + rnd() * 0.20,           // m of wander either side
      k: 1.4 + rnd() * 2.2,               // wander wavenumber per metre across
      ph: rnd() * 6.283,
      sealed: rnd() < 0.8,
      w: 0.012 + rnd() * 0.012,           // half-width of the crack itself
      seal: 0.028 + rnd() * 0.020,        // half-width of the sealant bead
      from: rnd() < 0.5 ? 0 : rnd() * width * 0.45,
      to: rnd() < 0.5 ? width : width * (0.55 + rnd() * 0.45),
    });
  }
  return out;
}

/** Rubber smears and chipped corners on a kerb, in (along m, face 0..1). */
function makeScuffs(rnd, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const chip = rnd() < 0.3;
    const hz = chip ? 0.05 + rnd() * 0.09 : 0.12 + rnd() * 0.40;
    out.push({
      z: placeAlong(rnd, hz), hz,
      u: chip ? 0.80 + rnd() * 0.18 : 0.12 + rnd() * 0.55,
      hu: chip ? 0.07 + rnd() * 0.07 : 0.10 + rnd() * 0.22,
      chip, k: 0.35 + rnd() * 0.5,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Specifications
// ---------------------------------------------------------------------------
//
// A spec describes a FAMILY: everything its variants share (colours, the
// profile across the road, the noise fields) plus a `variant(i)` function that
// returns the discrete features only that copy has.

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
  const age = AGE[kind] ?? 0.5;
  const city = kind === 'street' || kind === 'avenue' || kind === 'link';
  const circuit = kind === 'circuit';
  const tracks = wheelTracks(markings, width, lanes);

  const spec = {
    paint: 'paved', kind: 'road', surface: 'asphalt', width, seed, age,
    variants: VARIANTS[kind] ?? 1,
    // Fresh asphalt is near-black; oxidised binder turns it grey, and that is
    // the difference between a motorway and a lane that was last surfaced a
    // generation ago far more than any amount of cracking is.
    base: mix3([44, 45, 48], [92, 92, 94], age),
    agg: [132, 131, 128],                  // exposed chippings, slightly warm
    tar: [18, 17, 17],                     // bleed, sealant, crack shadow
    ink: [236, 233, 222],                  // marking paint
    // The verge outside a country road is the MAT_GRAVEL shoulder the ground
    // query hands the physics, so the last handspan of tarmac ravels toward it
    // and the ribbon edge does not meet the shoulder as a colour step.
    edgeCol: surfaceRGB('gravel', 1.15),
    edgeMix: city || circuit ? 0.0 : 0.30 + 0.35 * age,

    stripes: markingPlan(circuit ? 'circuit' : markings, width, lanes),
    markAlpha: 0.97 - 0.50 * age,
    tracks, trackW: circuit ? 1.10 : 0.62,
    // A circuit's "wheel tracks" are the rubbered-in racing line: much darker
    // and wider than a lane's polish, which is how a real track reads from the
    // grandstand.
    trackCut: circuit ? 0.20 : 0.055 + 0.065 * age,
    aggLift: 0.065 + 0.075 * age,          // how much lighter the untrodden rest is
    aggMix: 0.10 + 0.16 * age,
    rutH: circuit ? 0 : 0.004 + 0.008 * age,   // m of dish worn into each wheel path
    crownH: 0.055,                         // m of camber, normal map only

    gutter: city ? 0.42 : 0,
    joint: kind === 'highway' ? 6 : 0,     // m between expansion joints; divides TILE
    grime: 0.20 + 0.16 * age,

    gx: 0.16, gz: 0.30, grainAmt: 0.05 + 0.04 * age, grainH: 0.0008 + 0.0008 * age,
    // The blotch has to vary SLOWLY along the road. At 5.5 m it beat against
    // the 2.6 m across and the pair read as wood grain.
    bx: 3.4, bz: 13.0, blotchAmt: 0.035 + 0.040 * age,
    bleedAmt: circuit ? 0 : 0.10 + 0.42 * age,
    // Cracking is very non-linear in age: a road is sound, then suddenly it is
    // not. Squaring the age is what keeps highways clean and lanes broken.
    crackAmt: age * age,
    crackW: 0.040 + 0.055 * age,
    gloss: circuit ? 0.30 : 0.20,
  };

  spec.variant = (v) => {
    const rnd = mulberry((Math.imul(seed + v * 7919, 2654435761) ^ 0x9e37) >>> 0);
    return {
      seed: seed + v * 7919,
      patches: circuit ? [] : makePatches(rnd, width, age, city ? 0.12 : 0.26),
      holes: kind === 'rural' ? makeHoles(rnd, width, v === 0 ? 2 : 3, 0.055) : [],
      transverse: circuit ? [] : makeTransverse(rnd, width, age),
    };
  };
  return spec;
}

/**
 * An unpaved lane. They are not the same road.
 *
 * kind 'gravel' is a dressed lane: loose stone over a compacted formation, well
 * used, so the stones are swept out of the ruts and banked either side. kind
 * 'dirt' is the same road without the dressing — mostly earth, some stone.
 * kind 'track' is the least-used, and it is the one that grows the raised line
 * of grass down the middle, because a road only keeps that where nothing
 * straddles it.
 *
 * The colours come straight out of SURFACES so the surface agrees with the
 * material the physics reports on it: the earth is SURFACES.dirt and the stone
 * dressing and the dust film over it are SURFACES.gravel, which is also what
 * the shoulders either side are made of and what the wheels throw up.
 */
function looseSpec(kind, width, seed) {
  const L = LOOSE[kind] ?? LOOSE.dirt;
  const stony = L.stony, used = L.used;
  const age = AGE[kind] ?? 0.8;
  const earth = surfaceRGB('dirt', 1.10);
  const dust = surfaceRGB('gravel', 1.16);

  const spec = {
    paint: 'loose', kind: 'road', surface: stony > 0.6 ? 'gravel' : 'dirt', width, seed, age,
    variants: VARIANTS[kind] ?? 1,
    base: mix3(earth, dust, stony * 0.72),
    dust,                                   // the fine film that settles on top
    stoneLo: mix3(dust, [44, 41, 37], 0.42),
    stoneHi: mix3(dust, [232, 228, 218], 0.30),
    grass: [70, 84, 46],

    rut: kind === 'rallyx' ? [width * 0.5 - 1.1, width * 0.5 + 1.1] : [width * 0.5 - 0.82, width * 0.5 + 0.82],
    rutW: lerp(0.44, 0.60, used),
    // The wheel paths are compacted to a dark, fine, almost sealed surface;
    // that pair of darker tracks is the first thing that says "gravel road".
    rutCut: lerp(0.34, 0.26, used),
    rutH: lerp(0.078, 0.028, used),        // m — a track's ruts are real ruts
    bermH: lerp(0.030, 0.014, used) + 0.014 * stony,   // material pushed aside
    crownH: lerp(0.048, 0.010, used),      // the untouched strip between them

    // A dressed lane keeps a thin fringe; a track is being taken back.
    grassCrown: 0.98 * (1 - used) * (1 - 0.40 * stony),
    grassEdge: lerp(0.46, 0.14, used),

    // Near-isotropic and gentle: at 0.10 x 0.30 m this streaked the whole lane
    // along its length and read as a brushed-metal smear rather than as earth.
    gx: 0.12, gz: 0.18, grainAmt: 0.05 + 0.03 * stony, grainH: 0.003 + 0.003 * stony,
    bx: 2.0, bz: 4.2, blotchAmt: 0.08,
    // Stone CLUSTERS at a scale the macro layer can hold; the individual stones
    // are the detail layer's. Kept soft, because a thresholded field at this
    // scale is exactly what used to turn into a chequerboard.
    stoneS: lerp(0.34, 0.24, stony), stoneAmt: 0.06 + 0.14 * stony,
    stoneH: 0.006 + 0.008 * stony,
    // Corrugation. 24/44 m divides TILE a whole number of times, so the
    // washboard wraps; anything else beats against the tile and reads as a
    // rhythm change every 24 m. It only forms where traffic is regular.
    washL: 24 / 44, washH: (0.004 + 0.008 * stony) * used,
    dustFilm: 0.10 + 0.14 * stony,
    gloss: 0.04,
  };
  spec.variant = (v) => {
    const rnd = mulberry((Math.imul(seed + v * 6007, 40503) ^ 0x51ed) >>> 0);
    return { seed: seed + v * 6007, holes: makeHoles(rnd, width, 3 + Math.round(3 * age), 0.085) };
  };
  return spec;
}

/** Concrete paving, 4.2 m across, jointed every 1.2 m so it tiles into TILE. */
function walkSpec(seed) {
  return {
    paint: 'walk', kind: 'walk', surface: 'concrete', width: WALK_W, seed, variants: 1,
    base: [118, 120, 126], agg: [158, 160, 165], grass: [78, 92, 54],
    slab: 1.2, jointH: 0.006,
    gx: 0.16, gz: 0.24, grainAmt: 0.06, grainH: 0.0008,
    bx: 1.4, bz: 1.8, blotchAmt: 0.05,
    // Grit and grime collect against the kerb, which is the road-side edge.
    kerbGrime: 0.15, crackRate: 0.16, gloss: 0.12,
    variant: () => ({ seed }),
  };
}

/** The 8.5 cm kerb face. U runs up the face, so `width` here is the face param. */
function kerbSpec(seed) {
  return {
    paint: 'kerb', kind: 'kerb', surface: 'none', width: KERB, seed, variants: 1,
    base: [132, 133, 137], agg: [168, 169, 172], tar: [26, 25, 25],
    slab: 1.2, jointH: 0.008,
    // A kerb is not a flat face: there is a chamfered arris at the top that
    // catches every light in the city, and a shadow line at the bottom where
    // the gutter meets it. Those two edges are the whole reason a kerb reads as
    // an object rather than a painted stripe.
    arris: 0.86, arrisH: 0.009, gutterLine: 0.10,
    gx: 0.9, gz: 0.22, grainAmt: 0.09, grainH: 0.0012,
    bx: 3.0, bz: 1.9, blotchAmt: 0.05, gloss: 0.14,
    variant: () => {
      const rnd = mulberry((Math.imul(seed, 374761393) ^ 0x2b7) >>> 0);
      return { seed, scuffs: makeScuffs(rnd, 14) };
    },
  };
}

/** Junction fill: no markings, worn smooth by everything that turns on it. */
function patchSpec(surface, seed) {
  if (surface !== 'asphalt') {
    const s = looseSpec(surface === 'gravel' ? 'gravel' : 'dirt', 20, seed);
    s.kind = 'patch'; s.variants = 1;
    // Nothing tracks a junction the same way twice, so it has no ruts.
    s.rut = []; s.grassCrown = 0; s.grassEdge = 0; s.washH = 0;
    return s;
  }
  const s = pavedSpec('street', 'none', 20, 1, seed);
  s.kind = 'patch'; s.variants = 1;
  s.stripes = []; s.tracks = []; s.gutter = 0; s.joint = 0;
  s.edgeMix = 0; s.grime = 0.06; s.crownH = 0;
  // A junction is scrubbed by every car that turns across it, so it is darker
  // and more polished than the roads feeding it, and it cracks in the middle.
  s.base = mix3(s.base, [40, 42, 46], 0.35);
  s.aggLift = 0.05; s.aggMix = 0.07; s.crackAmt = 0.5; s.bleedAmt = 0.2; s.gloss = 0.28;
  return s;
}

// ---------------------------------------------------------------------------
// Painters
// ---------------------------------------------------------------------------
//
// Each painter fills one layer: RGBA albedo (A = gloss), RELIEF IN METRES in
// `H`, the relief that holds water in `Hw`, and painted-line coverage in `Pm`.
// finishLayer() turns the last three into the second texture.
//
//   * anything that depends only on the metre ACROSS the row is hoisted into a
//     column table, and anything that depends only on the metre ALONG it into a
//     row table. The inner loop then costs a handful of lookups.
//
//   * the per-pixel noise fields are computed ONCE per family into `F` and
//     shared by its variants, which is both why two variants cost barely more
//     than one and why they agree exactly near the tile ends.

function fieldsFor(spec, w, h) {
  const n = w * h;
  const mPerX = spec.width / w, mPerY = TILE / h;
  const F = { g: new Float32Array(n), bn: new Float32Array(n), c1: null, c2: null };
  const seed = spec.seed;
  const W = spec.width;
  // The kerb's U runs up an 8.5 cm face, so its across-scales are given as a
  // fraction of that face rather than in metres.
  const kx = spec.paint === 'kerb' ? W : 1;
  // One octave of grain is enough now: everything finer is the detail layer's.
  const grain = makeField(W, spec.gx * kx, spec.gz, seed, 1, h);
  const blotch = makeField(W, spec.bx * kx, spec.bz, seed + 91, 2, h);
  let f1 = null, f2 = null;
  // Which columns the second field is ever read in. Fatigue crazing only grows
  // in the wheel paths and grass only on the crown and the edges, so the rest
  // of the layer never pays for it.
  const need2 = new Uint8Array(w);
  if (spec.paint === 'paved') {
    if (spec.crackAmt > 0.002) {
      F.c1 = new Float32Array(n);
      f1 = makeField(W, 0.22, 14.0, seed + 55, 2, h);
      if (spec.age > 0.55) {
        F.c2 = new Float32Array(n);
        f2 = makeField(W, 0.30, 0.40, seed + 311, 2, h);
        for (let px = 0; px < w; px++) {
          const m = (px + 0.5) * mPerX;
          let p = 0;
          for (const t of spec.tracks) { const q = (m - t) / spec.trackW; p += Math.exp(-q * q); }
          need2[px] = p > 0.19 ? 1 : 0;
        }
      }
    }
  } else if (spec.paint === 'loose') {
    F.c1 = new Float32Array(n);
    F.c2 = new Float32Array(n);
    f1 = makeField(W, spec.stoneS, spec.stoneS * 1.5, seed + 77, 2, h);
    f2 = makeField(W, 0.7, 2.4, seed + 7, 2, h);
    const c = W / 2;
    for (let px = 0; px < w; px++) {
      const m = (px + 0.5) * mPerX;
      const cq = (m - c) / 0.62;
      const gk = spec.grassCrown * Math.exp(-cq * cq) + spec.grassEdge * (1 - smoothstep(0, 1.1, Math.min(m, W - m)));
      need2[px] = gk > 0.002 ? 1 : 0;
    }
  }

  // The blotch varies over metres, so it is sampled on a grid four texels
  // apart and interpolated. Measured against the full-rate field the largest
  // difference is under 0.3% of its range, and it is a fifth of the cost.
  const S = 4;
  const cw = Math.ceil(w / S) + 2, ch = Math.ceil(h / S);
  const coarse = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    const mz = (j * S + 0.5) * mPerY;
    for (let k = 0; k < cw; k++) coarse[j * cw + k] = blotch(Math.min(W, (k * S + 0.5) * mPerX), mz);
  }

  for (let py = 0, i = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const j0 = Math.floor(py / S), fj = (py - j0 * S) / S;
    const j1 = j0 + 1 === ch ? 0 : j0 + 1;               // wraps with the tile
    const r0 = j0 * cw, r1 = j1 * cw;
    for (let px = 0; px < w; px++, i++) {
      const m = (px + 0.5) * mPerX;
      F.g[i] = grain(m, mz);
      const k0 = Math.floor(px / S), fk = (px - k0 * S) / S;
      const a = coarse[r0 + k0] + (coarse[r0 + k0 + 1] - coarse[r0 + k0]) * fk;
      const b = coarse[r1 + k0] + (coarse[r1 + k0 + 1] - coarse[r1 + k0]) * fk;
      F.bn[i] = a + (b - a) * fj;
      if (f1) F.c1[i] = f1(m, mz);
      if (f2 && need2[px]) F.c2[i] = f2(m, mz);
    }
  }
  return F;
}

/**
 * For each row of a layer, the features whose along-road extent touches it.
 * Most rows touch none, so the per-pixel loops over repairs and potholes
 * collapse to nothing on most of the layer.
 */
function rowLists(h, mPerY, items, halfAlong) {
  const lists = new Array(h);
  for (let py = 0; py < h; py++) lists[py] = null;
  for (const it of items) {
    const [z, r] = halfAlong(it);
    const a = Math.max(0, Math.floor((z - r) / mPerY)), b = Math.min(h - 1, Math.ceil((z + r) / mPerY));
    for (let py = a; py <= b; py++) (lists[py] || (lists[py] = [])).push(it);
  }
  return lists;
}

/** Sealed surfaces: asphalt carriageways and asphalt junction fills. */
function paintPaved(spec, V, F, out, w, h) {
  const d = out.rgba, H = out.H, Hw = out.Hw, Pm = out.Pm;
  const mPerX = spec.width / w, mPerY = TILE / h;
  const pmax = Math.max(2, Math.floor(h / 2.6));
  const width = spec.width, c = width / 2;
  const S = spec.stripes, ns = S.length;
  const rowP = rowLists(h, mPerY, V.patches, (q) => [q.zc, q.hz + q.seal + 0.15]);
  const rowH = rowLists(h, mPerY, V.holes, (q) => [q.z, q.rz * 1.7 + 0.05]);
  const rowT = rowLists(h, mPerY, V.transverse, (q) => [q.z, q.amp + 0.12]);

  // ---- column tables ----
  const tone = new Float32Array(w), poli = new Float32Array(w);
  const rel0 = new Float32Array(w), relw = new Float32Array(w), bled = new Float32Array(w);
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

    // The gutter is a dished channel, permanently damp and full of silt.
    if (spec.gutter > 0) {
      const g = Math.max(0, 1 - edge / spec.gutter);
      t *= 1 - 0.34 * g * g;
      rel -= 0.019 * g * (2 - g);
    }
    // Water collects in everything above EXCEPT the camber, which exists to
    // shed it. So the water relief is taken before the crown is added.
    relw[px] = rel;

    // Camber lives in the normal map alone: the ribbon is flat across because
    // the height field it is built from is, and bending the geometry to fake a
    // crown would put the visible surface off the one the wheels stand on.
    if (spec.crownH) { const q = (m - c) / Math.max(0.5, c); rel -= spec.crownH * q * q; }

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

    // Stripe coverage, antialiased over a texel: a hard edge shimmers at range
    // even with anisotropy on, which is exactly where lane lines live.
    let best = 0, bi = -1;
    for (let i = 0; i < ns; i++) {
      const a = 1 - smoothstep(S[i].w * 0.5 - mPerX * 0.5, S[i].w * 0.5 + mPerX * 0.5, Math.abs(m - S[i].m));
      if (a > best) { best = a; bi = i; }
    }
    salp[px] = best; strp[px] = bi;
    tone[px] = t; rel0[px] = rel;
  }

  // ---- row tables ----
  const shearB = new Int16Array(h), gate = new Float32Array(h);
  const jb = new Float32Array(h), js = new Float32Array(h);
  // The gate decides which stretches of the tile have cracks at all. It is the
  // one place variants differ in the CRACKS rather than in discrete repairs, so
  // it is blended back to a shared gate near the tile ends.
  const gShared = makeField(1, 1, 13, spec.seed + 7, 2, h);
  const gOwn = makeField(1, 1, 11, V.seed + 13, 2, h);
  const wander = makeField(4, 1, 9, spec.seed + 401, 2, h);
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    // Bleed lines wander; shifting the column table by whole texels is a shear,
    // which costs one clamped index instead of an exp per line per pixel.
    // 10 cm of wander: any more and every bleed line snakes in step.
    shearB[py] = Math.round(wander(3.5, mz) * 0.10 / mPerX);
    const sw = seamWeight(mz);
    gate[py] = clamp(0.30 + 1.7 * lerp(gShared(0.5, mz), gOwn(0.5, mz), sw), 0, 1);
    if (spec.joint > 0) {
      const f = Math.abs(mz / spec.joint - Math.round(mz / spec.joint)) * spec.joint;
      // The sealed overband is ~18 cm wide, drawn at the width it really has
      // rather than the hairline the sealant slot is.
      jb[py] = 1 - smoothstep(0.06, 0.10, f);
      js[py] = 1 - smoothstep(0.015, 0.045, f);
    }
  }

  // ---- pixels ----
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const sb = shearB[py], gt = gate[py], jbv = jb[py], jsv = js[py];
    const row = py * w;
    const P = rowP[py], np = P ? P.length : 0;
    const Hl = rowH[py], nh = Hl ? Hl.length : 0;
    const T = rowT[py], nt = T ? T.length : 0;
    for (let px = 0; px < w; px++) {
      const i = row + px;
      const m = (px + 0.5) * mPerX;
      const p = poli[px];
      let t = tone[px], rel = rel0[px], wrel = relw[px];
      let gloss = spec.gloss + 0.24 * p;
      let paint = 0;
      // Macro relief (camber, ruts, gutter, cracks, holes) and grain are kept
      // apart because tar bleed floods the second and not the first.
      const g = F.g[i], bn = F.bn[i];
      let fine = g * spec.grainH * (1 - 0.75 * p);
      t *= 1 + g * spec.grainAmt * (1 - 0.70 * p);
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
        gloss *= 1 - ek;
      }

      // Tar bleed. Bled binder is a flooded, glassy surface, so as well as
      // going black it flattens the relief it covers — that loss of texture is
      // most of what makes a bleeding wheel path readable at speed.
      const bd = bled[clamp(px + sb, 0, w - 1)] * spec.bleedAmt;
      if (bd > 0.003) {
        r = lerp(r, spec.tar[0], bd); gr = lerp(gr, spec.tar[1], bd); b = lerp(b, spec.tar[2], bd);
        fine *= 1 - 0.72 * bd;
        gloss += 0.45 * bd;
      }

      // Longitudinal cracking. |noise| near zero gives filaments; stretching
      // the sample 60:1 along the road turns them into longitudinal cracks, and
      // a second, near-isotropic field inside the wheel paths gives the fatigue
      // crazing an old road grows there.
      if (F.c1) {
        let ck = (1 - smoothstep(0, spec.crackW, Math.abs(F.c1[i]))) * ckm[px] * gt * spec.crackAmt;
        if (F.c2 && p > 0.20) {
          const fk = (1 - smoothstep(0, 0.045, Math.abs(F.c2[i]))) * p * (spec.age - 0.55) * 2.0 * gt;
          if (fk > ck) ck = fk;
        }
        if (ck > 0.004) {
          r = lerp(r, spec.tar[0], ck); gr = lerp(gr, spec.tar[1], ck); b = lerp(b, spec.tar[2], ck);
          rel -= ck * 0.007; wrel -= ck * 0.007;
        }
      }

      // Transverse cracks and their sealant. The crack wanders; the bead of
      // sealant laid over it is wider, glossy, and stands a millimetre proud.
      for (let k = 0; k < nt; k++) {
        const q = T[k];
        if (m < q.from || m > q.to) continue;
        const dz = Math.abs(mz - q.z - q.amp * Math.sin(m * q.k + q.ph) - 0.03 * bn);
        if (dz > 0.09) continue;
        const ends = smoothstep(q.from, q.from + 0.25, m) * (1 - smoothstep(q.to - 0.25, q.to, m));
        if (q.sealed) {
          const s = (1 - smoothstep(q.seal * 0.6, q.seal, dz)) * ends;
          if (s > 0.003) {
            r = lerp(r, spec.tar[0] * 0.9, s * 0.92); gr = lerp(gr, spec.tar[1] * 0.9, s * 0.92); b = lerp(b, spec.tar[2] * 0.9, s * 0.92);
            rel += s * 0.0012; gloss = lerp(gloss, 0.62, s); fine *= 1 - 0.8 * s;
          }
        } else {
          const s = (1 - smoothstep(q.w * 0.4, q.w, dz)) * ends;
          if (s > 0.003) {
            r = lerp(r, spec.tar[0], s); gr = lerp(gr, spec.tar[1], s); b = lerp(b, spec.tar[2], s);
            rel -= s * 0.008; wrel -= s * 0.008;
          }
        }
      }

      // Patch repairs. The blotch noise doubles as the edge wobble, so a repair
      // has a ragged boundary without costing another sample.
      for (let k = 0; k < np; k++) {
        const q = P[k];
        const dm = Math.abs(m - q.mc) - q.hm;
        if (dm > q.seal) continue;
        const dzz = Math.abs(mz - q.zc) - q.hz;
        if (dzz > q.seal) continue;
        // A cut edge is ragged at two scales, so the wobble takes one from the
        // blotch and one from the grain.
        const dIn = (dm > dzz ? dm : dzz) + bn * 0.09 + g * 0.05;
        const ins = 1 - smoothstep(-0.03, 0.01, dIn);
        if (ins > 0.002) {
          const tt = lerp(1, q.tone, ins);
          r *= tt; gr *= tt; b *= tt;
          rel -= ins * 0.005; wrel -= ins * 0.005;          // a repair always settles
          gloss += ins * (q.tone < 1 ? 0.08 : -0.04);
        }
        const band = 1 - smoothstep(q.seal * 0.35, q.seal, Math.abs(dIn));
        if (band > 0.004) {
          const kk = band * 0.55;
          r = lerp(r, spec.tar[0], kk); gr = lerp(gr, spec.tar[1], kk); b = lerp(b, spec.tar[2], kk);
          rel += band * 0.005;                     // the overband stands proud
          gloss = lerp(gloss, 0.55, band * 0.8);
        }
      }

      // Potholes.
      for (let k = 0; k < nh; k++) {
        const q = Hl[k];
        const dm = m - q.m;
        if (dm > q.rx * 1.6 || dm < -q.rx * 1.6) continue;
        const dz = mz - q.z;
        // The rim has to break up WITHIN the hole, so the raggedness comes off
        // the grain; the blotch varies over metres and merely moves the ellipse.
        const q2 = dm * dm * q.irx2 + dz * dz * q.irz2 + g * 0.40 + bn * 0.25;
        if (q2 > 1.9) continue;
        const core = 1 - smoothstep(0.30, 0.95, q2);
        const spoil = (1 - smoothstep(0.95, 1.8, q2)) * (1 - core);
        r = lerp(r, spec.tar[0] * 1.3, core * 0.78); gr = lerp(gr, spec.tar[1] * 1.3, core * 0.78); b = lerp(b, spec.tar[2] * 1.35, core * 0.78);
        r = lerp(r, spec.agg[0], spoil * 0.30); gr = lerp(gr, spec.agg[1], spoil * 0.30); b = lerp(b, spec.agg[2], spoil * 0.30);
        rel -= core * q.depth; wrel -= core * q.depth;
        rel += spoil * q.depth * 0.16;
        gloss *= 1 - core * 0.5;
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
            ? smoothstep(0, 0.10, ph) * smoothstep(0, 0.10, st.dash - ph)   // square-cut ends
            : 0;
        }
        if (on > 0.004) {
          // Paint wears off fastest where it is driven over, so a centre line
          // in a wheel path is a ghost while a shoulder line beside it is not.
          let a = salp[px] * on * spec.markAlpha * (1 - 0.70 * p);
          a *= clamp(0.55 + 0.60 * (g * 0.5 + 0.5) + 0.45 * bn, 0, 1);
          if (a > 0.004) {
            r = lerp(r, spec.ink[0], a); gr = lerp(gr, spec.ink[1], a); b = lerp(b, spec.ink[2], a);
            rel += a * 0.0012;                    // fresh paint sits proud
            fine *= 1 - 0.5 * a;                  // and fills the texture
            gloss = lerp(gloss, 0.34, a);
            paint = a;
          }
        }
      }

      const o = i * 4;
      d[o] = clamp(r, 0, 255); d[o + 1] = clamp(gr, 0, 255); d[o + 2] = clamp(b, 0, 255);
      d[o + 3] = clamp(gloss, 0, 1) * 255;
      H[i] = rel + fine;
      Hw[i] = wrel;
      Pm[i] = paint;
    }
  }
}

/** Unpaved surfaces: the gravel lane, the dirt track, and their junctions. */
function paintLoose(spec, V, F, out, w, h) {
  const d = out.rgba, H = out.H, Hw = out.Hw, Pm = out.Pm;
  const mPerX = spec.width / w, mPerY = TILE / h;
  const width = spec.width, c = width / 2;
  const rowH = rowLists(h, mPerY, V.holes, (q) => [q.z, q.rz * 1.7 + 0.05]);

  // ---- column tables ----
  const tone = new Float32Array(w), rel0 = new Float32Array(w), relw = new Float32Array(w);
  const rutk = new Float32Array(w), grass = new Float32Array(w);
  const loose = new Float32Array(w), bermk = new Float32Array(w);

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
    relw[px] = rel;
    if (spec.rut.length) {
      let berm = 0;
      for (let i = 0; i < spec.rut.length; i++) {
        for (let s = -1; s <= 1; s += 2) {
          const q = (m - spec.rut[i] - s * spec.rutW * 1.55) / (spec.rutW * 0.8);
          berm += Math.exp(-q * q);
        }
      }
      rel += spec.bermH * Math.min(1, berm) * (1 - k);
      bermk[px] = Math.min(1, berm) * (1 - k);
    }
    // The strip between the ruts is never touched, so it stands proud and, on a
    // road nothing straddles, it grows a line of grass down the middle.
    const cq = (m - c) / 0.62;
    const crown = Math.exp(-cq * cq);
    rel += spec.crownH * crown;
    const gk = spec.grassCrown * crown + spec.grassEdge * (1 - smoothstep(0, 1.1, edge));
    grass[px] = gk > 1 ? 1 : gk;
    loose[px] = clamp(1 - 1.15 * k, 0, 1);        // where stones can still sit
    t *= 1 + 0.14 * (1 - smoothstep(width * 0.30, width * 0.5, Math.abs(m - c)));
    tone[px] = t; rel0[px] = rel;
  }

  // ---- row tables ----
  // Corrugation: a real washboard is a standing wave, not noise, so it is a
  // sine whose amplitude a slow noise turns on and off along the road.
  const wash = new Float32Array(h);
  const envF = makeField(3, 1, 11, spec.seed + 613, 2, h);
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const env = clamp(0.25 + 1.5 * envF(1.5, mz), 0, 1);
    wash[py] = Math.sin((mz / spec.washL) * Math.PI * 2) * env;
  }

  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const wv = wash[py];
    const row = py * w;
    const Hl = rowH[py], nh = Hl ? Hl.length : 0;
    for (let px = 0; px < w; px++) {
      const i = row + px;
      const m = (px + 0.5) * mPerX;
      const k = rutk[px];
      let t = tone[px], rel = rel0[px], wrel = relw[px];
      let gloss = spec.gloss + 0.10 * k;           // compacted ruts are smoother

      const g = F.g[i], bn = F.bn[i];
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;

      // A fine pale film of dust settles on everything that is not a rut.
      const df = spec.dustFilm * loose[px] * clamp(0.4 + 0.8 * bn, 0, 1);
      r = lerp(r, spec.dust[0], df); gr = lerp(gr, spec.dust[1], df); b = lerp(b, spec.dust[2], df);

      // Stone clusters: the top of the field is a heap, the shoulder below it
      // the shadow it casts. Soft thresholds — the individual stones are in the
      // detail layer, and a hard threshold here is what made the old mosaic.
      const sn = F.c1[i];
      // Traffic sweeps the loose stone out of the wheel paths into windrows
      // beside them, so the berms are where the stone lies thickest.
      const st = smoothstep(0.05, 0.55, sn) * spec.stoneAmt * loose[px] * (1 + 1.4 * bermk[px]);
      if (st > 0.004) {
        r = lerp(r, spec.stoneHi[0], st); gr = lerp(gr, spec.stoneHi[1], st); b = lerp(b, spec.stoneHi[2], st);
        rel += st * spec.stoneH;
      }
      const sd = smoothstep(-0.10, -0.55, sn) * spec.stoneAmt * 0.35;
      if (sd > 0.004) {
        r = lerp(r, spec.stoneLo[0], sd); gr = lerp(gr, spec.stoneLo[1], sd); b = lerp(b, spec.stoneLo[2], sd);
        rel -= sd * spec.stoneH * 0.5;
      }

      rel += wv * spec.washH * k;

      for (let q = 0; q < nh; q++) {
        const hq = Hl[q];
        const dm = m - hq.m;
        if (dm > hq.rx * 1.7 || dm < -hq.rx * 1.7) continue;
        const dz = mz - hq.z;
        const q2 = dm * dm * hq.irx2 + dz * dz * hq.irz2 + g * 0.45 + bn * 0.25;
        if (q2 > 1.9) continue;
        const core = 1 - smoothstep(0.25, 0.95, q2);
        const spoil = (1 - smoothstep(0.95, 1.75, q2)) * (1 - core);
        // A hole in an unpaved road holds water, so its floor is dark and
        // smooth and the spoil thrown out of it is the palest thing around.
        const wet = core * 0.38;
        r = lerp(r, spec.stoneLo[0] * 0.7, wet); gr = lerp(gr, spec.stoneLo[1] * 0.7, wet); b = lerp(b, spec.stoneLo[2] * 0.7, wet);
        r = lerp(r, spec.stoneHi[0], spoil * 0.42); gr = lerp(gr, spec.stoneHi[1], spoil * 0.42); b = lerp(b, spec.stoneHi[2], spoil * 0.42);
        rel -= core * hq.depth; wrel -= core * hq.depth;
        rel += spoil * hq.depth * 0.22;
        gloss += core * 0.12;
      }

      const gk = clamp(grass[px] * (0.78 + 0.85 * F.c2[i]), 0, 1);
      if (gk > 0.004) {
        r = lerp(r, spec.grass[0], gk); gr = lerp(gr, spec.grass[1], gk); b = lerp(b, spec.grass[2], gk);
        rel += gk * 0.020;
        gloss *= 1 - gk;
      }

      const o = i * 4;
      d[o] = clamp(r, 0, 255); d[o + 1] = clamp(gr, 0, 255); d[o + 2] = clamp(b, 0, 255);
      d[o + 3] = clamp(gloss, 0, 1) * 255;
      H[i] = rel;
      Hw[i] = wrel;
      Pm[i] = 0;
    }
  }
}

/** Concrete paving slabs. U runs from the kerb outward. */
function paintWalk(spec, V, F, out, w, h) {
  const d = out.rgba, H = out.H, Hw = out.Hw, Pm = out.Pm;
  const mPerX = spec.width / w, mPerY = TILE / h;
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

  // A slab joint is about a texel wide, so it is INTEGRATED over the texel
  // rather than point-sampled: `jrow` is the exact fraction of the texel a
  // groove of half-width `jhw` covers, which sums to the same total for every
  // joint whatever its phase against the texel grid.
  const jrow = new Float32Array(h), slabT = new Float32Array(h), crackA = new Float32Array(h);
  const crackB = new Float32Array(h);
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
    const jv = jrow[py], sv = slabT[py];
    const row = py * w;
    for (let px = 0; px < w; px++) {
      const i = row + px;
      const m = (px + 0.5) * mPerX;
      let t = tone[px] * sv * (1 - 0.32 * jv);
      let rel = rel0[px] - spec.jointH * jv;

      const g = F.g[i], bn = F.bn[i];
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
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

      const o = i * 4;
      d[o] = clamp(r, 0, 255); d[o + 1] = clamp(gr, 0, 255); d[o + 2] = clamp(b, 0, 255);
      d[o + 3] = spec.gloss * 255;
      H[i] = rel; Hw[i] = rel; Pm[i] = 0;
    }
  }
}

/** The kerb face. U runs UP the face: 0 is the gutter, 1 the pavement edge. */
function paintKerb(spec, V, F, out, w, h) {
  const d = out.rgba, H = out.H, Hw = out.Hw, Pm = out.Pm;
  const mPerY = TILE / h;
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

  // Same integrated-joint rule as the pavement; this is where it bites
  // hardest, because a 1.2 m unit joint is the kerb's only lengthwise feature.
  const jrow = new Float32Array(h), unitT = new Float32Array(h);
  const jhw = Math.max(0.006, 0.5 * mPerY);
  const jspan = 1 / mPerY;
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const f = Math.abs(mz / spec.slab - Math.round(mz / spec.slab)) * spec.slab;
    jrow[py] = clamp(Math.min(2 * jhw, mPerY, jhw + mPerY * 0.5 - f) * jspan, 0, 1);
    unitT[py] = 0.955 + hash1(Math.floor(mz / spec.slab), spec.seed) * 0.09;
  }

  const SC = V.scuffs, nsc = SC.length;
  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    const jv = jrow[py], uv = unitT[py];
    const row = py * w;
    for (let px = 0; px < w; px++) {
      const i = row + px;
      const u = (px + 0.5) / w;
      let t = tone[px] * uv * (1 - 0.42 * jv);
      let rel = rel0[px] - spec.jointH * jv;

      const g = F.g[i], bn = F.bn[i];
      t *= 1 + g * spec.grainAmt;
      rel += g * spec.grainH;
      t *= 1 + bn * spec.blotchAmt;

      let r = spec.base[0] * t, gr = spec.base[1] * t, b = spec.base[2] * t;
      const ak = 0.14 * bright[px] * clamp(0.4 + 0.9 * g, 0, 1);
      r = lerp(r, spec.agg[0], ak); gr = lerp(gr, spec.agg[1], ak); b = lerp(b, spec.agg[2], ak);

      for (let k = 0; k < nsc; k++) {
        const q = SC[k];
        const du = Math.abs(u - q.u) - q.hu;
        if (du > 0.02) continue;
        const dzz = Math.abs(mz - q.z) - q.hz;
        if (dzz > 0.02) continue;
        const kk = (1 - smoothstep(-0.03, 0.01, (du > dzz ? du : dzz) + bn * 0.02)) * q.k;
        if (kk < 0.004) continue;
        if (q.chip) {
          // A chipped arris shows the pale aggregate inside the concrete.
          r = lerp(r, spec.agg[0] * 1.12, kk); gr = lerp(gr, spec.agg[1] * 1.12, kk); b = lerp(b, spec.agg[2] * 1.12, kk);
          rel -= kk * 0.007;
        } else {
          r = lerp(r, spec.tar[0], kk * 0.8); gr = lerp(gr, spec.tar[1], kk * 0.8); b = lerp(b, spec.tar[2], kk * 0.8);
        }
      }

      const o = i * 4;
      d[o] = clamp(r, 0, 255); d[o + 1] = clamp(gr, 0, 255); d[o + 2] = clamp(b, 0, 255);
      d[o + 3] = spec.gloss * 255;
      H[i] = rel; Hw[i] = rel; Pm[i] = 0;
    }
  }
}

/**
 * Relief to the second texture: tangent-space normal in RG, standing water in
 * B, painted line in A.
 *
 * Central differences in METRES, not texels, so a 2 cm stone tilts the normal
 * by the same angle on every row whatever its texel size. Y wraps with the tile
 * and X clamps, matching the sampler. Z is not stored — it is rebuilt in the
 * shader — which frees B for water.
 *
 * Water is how far a texel sits below the surface around it, measured on the
 * relief WITHOUT the camber, fine grain or proud features: ruts, potholes,
 * settled repairs and open cracks. 12 mm of depression is a full puddle.
 */
function finishLayer(out, w, h, mPerX, mPerY, nrm, o4) {
  const Hb = out.H, Hw = out.Hw, Pm = out.Pm;
  const sx = 1 / (2 * mPerX), sz = 1 / (2 * mPerY);
  // The reference the water is measured against: the mean water relief of the
  // layer, so a road whose every texel is a little low is not all puddle.
  let mean = 0;
  for (let i = 0; i < Hw.length; i++) mean += Hw[i];
  mean /= Hw.length;
  for (let py = 0; py < h; py++) {
    const up = (py === 0 ? h - 1 : py - 1) * w;
    const dn = (py === h - 1 ? 0 : py + 1) * w;
    const cur = py * w;
    for (let px = 0; px < w; px++) {
      const xl = px > 0 ? px - 1 : 0, xr = px < w - 1 ? px + 1 : w - 1;
      const du = (Hb[cur + xr] - Hb[cur + xl]) * ((px > 0 && px < w - 1) ? sx : sx * 2);
      const dv = (Hb[dn + px] - Hb[up + px]) * sz;
      const inv = 1 / Math.sqrt(du * du + dv * dv + 1);
      const o = o4 + (cur + px) * 4;
      nrm[o] = clamp((0.5 - du * inv * 0.5) * 255 + 0.5, 0, 255);
      nrm[o + 1] = clamp((0.5 - dv * inv * 0.5) * 255 + 0.5, 0, 255);
      nrm[o + 2] = clamp((mean - Hw[cur + px] - 0.0015) / 0.012, 0, 1) * 255;
      nrm[o + 3] = Pm[cur + px] * 255;
    }
  }
}

/**
 * Paints every family into two texture arrays and returns, per family, the
 * index of its first layer. Variants of a family occupy consecutive layers.
 */
function buildLayers(specs, w, defer) {
  const h = LAYER_H;
  let layers = 0;
  const first = [];
  for (const s of specs) { first.push(layers); layers += s.variants; }
  const per = w * h * 4;
  const alb = new Uint8Array(per * layers);
  const nrm = new Uint8Array(per * layers);
  const out = {
    rgba: null,
    H: new Float32Array(w * h), Hw: new Float32Array(w * h), Pm: new Float32Array(w * h),
  };
  const paint = { paved: paintPaved, loose: paintLoose, walk: paintWalk, kerb: paintKerb };
  const paintOne = (f, v, F) => {
    const spec = specs[f], L = first[f] + v;
    out.rgba = alb.subarray(L * per, (L + 1) * per);
    paint[spec.paint](spec, spec.variant(v), F, out, w, h);
    finishLayer(out, w, h, spec.width / w, TILE / h, nrm, L * per);
    return L;
  };
  // Deferred variants start life as copies of the first, so every tile has a
  // correct surface from the first frame and the second copy's own repairs
  // and potholes simply arrive a moment later.
  const later = [];
  for (let f = 0; f < specs.length; f++) {
    const spec = specs[f];
    const F = fieldsFor(spec, w, h);
    paintOne(f, 0, F);
    for (let v = 1; v < spec.variants; v++) {
      if (defer) {
        const L0 = first[f] * per, L = (first[f] + v) * per;
        alb.copyWithin(L, L0, L0 + per);
        nrm.copyWithin(L, L0, L0 + per);
        later.push({ f, v });
      } else {
        paintOne(f, v, F);
      }
    }
  }
  // One deferred variant per call, fields recomputed: holding every family's
  // fields until the idle queue drains would keep 30 MB alive for a second.
  const paintLater = (job) => paintOne(job.f, job.v, fieldsFor(specs[job.f], w, h));
  return { alb, nrm, first, layers, width: w, height: h, later, paintLater };
}

// ---------------------------------------------------------------------------
// Detail layers
// ---------------------------------------------------------------------------
//
// Four tiles, 512 texels over 1.6 m of WORLD space: asphalt chippings, loose
// gravel, earth, concrete. RG is a normal in world X/Z, B an albedo multiplier
// centred on 0.5 (x2 in the shader, so 0.5 changes nothing), A how exposed the
// texel is — 1 on top of a stone, 0 down in the gaps — which the shader uses
// for where water sits first and where the verge edge breaks up.
//
// The stones are cells of a periodic Worley pattern. Crushed aggregate is
// angular, and Voronoi cells are angular for free; the distance to the cell
// border gives each stone a dome and the binder or dust between them.

function worley(N, cells, seed) {
  // Feature points on a grid padded by one cell all round, with the wrap
  // already applied to the padding — so the 3x3 search needs no modulo and no
  // branch, which is most of what makes a million of them affordable at load.
  const P = cells + 2;
  const fx = new Float32Array(P * P), fy = new Float32Array(P * P), id = new Float32Array(P * P);
  for (let j = 0; j < P; j++) {
    const sj = (j - 1 + cells) % cells;
    for (let i = 0; i < P; i++) {
      const si = (i - 1 + cells) % cells;
      const k = j * P + i;
      fx[k] = (i - 1) + hash2(si, sj, seed);
      fy[k] = (j - 1) + hash2(si, sj, seed + 1);
      id[k] = hash2(si, sj, seed + 2);
    }
  }
  const F1 = new Float32Array(N * N), E = new Float32Array(N * N), ID = new Float32Array(N * N);
  const s = cells / N;
  for (let py = 0; py < N; py++) {
    const y = (py + 0.5) * s, cy = Math.floor(y) + 1;
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) * s, cx = Math.floor(x) + 1;
      let d1 = 9, d2 = 9, best = 0;
      for (let jy = cy - 1; jy <= cy + 1; jy++) {
        const row = jy * P;
        for (let jx = cx - 1; jx <= cx + 1; jx++) {
          const k = row + jx;
          const ddx = fx[k] - x, ddy = fy[k] - y;
          const dd = ddx * ddx + ddy * ddy;
          if (dd < d1) { d2 = d1; d1 = dd; best = k; } else if (dd < d2) d2 = dd;
        }
      }
      const i = py * N + px;
      const r1 = Math.sqrt(d1);
      F1[i] = r1;
      E[i] = Math.sqrt(d2) - r1;                 // 0 on a cell border
      ID[i] = id[best];
    }
  }
  return { F1, E, ID };
}

/** Periodic value noise on the detail tile, `cells` lattice cells per side. */
function tileNoise(N, cells, seed, oct) {
  const out = new Float32Array(N * N);
  let amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    const c = cells << o, s = c / N, sd = seed + o * 131;
    const L = new Float32Array((c + 1) * (c + 1));
    for (let j = 0; j <= c; j++) for (let i = 0; i <= c; i++) L[j * (c + 1) + i] = hash2(i % c, j % c, sd) * 2 - 1;
    for (let py = 0; py < N; py++) {
      const y = (py + 0.5) * s, y0 = Math.floor(y), v = quinticT(y - y0);
      const ra = y0 * (c + 1), rb = ra + c + 1;
      for (let px = 0; px < N; px++) {
        const x = (px + 0.5) * s, x0 = Math.floor(x), u = quinticT(x - x0);
        const a = L[ra + x0], b = L[ra + x0 + 1], cc = L[rb + x0], dd = L[rb + x0 + 1];
        const top = a + (b - a) * u, bot = cc + (dd - cc) * u;
        out[py * N + px] += (top + (bot - top) * v) * amp;
      }
    }
    norm += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function buildDetail(seed, want, defer) {
  const N = DETAIL_PX, texel = DETAIL_M / N;
  const per = N * N * 4;
  const data = new Uint8Array(per * 4);
  const hgt = new Float32Array(N * N), alb = new Float32Array(N * N), top = new Float32Array(N * N);
  const cellsFor = (metres) => Math.max(2, Math.round(DETAIL_M / metres));

  const recipes = [
    // Asphalt: 6-14 mm chippings bound in bitumen, the tops worn flat and the
    // odd pale quartz stone that catches the light.
    () => {
      const W = worley(N, cellsFor(0.0105), seed + 11);
      const sand = tileNoise(N, 256, seed + 12, 1);
      for (let i = 0; i < N * N; i++) {
        const e = W.E[i], id = W.ID[i];
        const stone = smoothstep(0.04, 0.24, e);
        // One stone in eighty is a pale quartz chip. More than that and the
        // road glitters like a pavement in a cartoon.
        const quartz = id < 0.012 ? 1 : 0;
        hgt[i] = stone * (0.55 + 0.45 * id) * 0.0016 + sand[i] * 0.00015;
        alb[i] = lerp(0.72 + 0.06 * sand[i], 0.84 + 0.46 * id * id + quartz * 0.45, stone);
        top[i] = stone * (0.6 + 0.4 * id);
      }
    },
    // Gravel: 12-40 mm stones lying loose on each other. What makes loose
    // stone read as loose stone under a high sun is not the relief — a noon
    // sun barely shades it — but the TONE: every stone is a slightly different
    // rock, and the voids between them are deep enough to be in shadow.
    () => {
      const B = worley(N, cellsFor(0.028), seed + 21);
      const S = worley(N, cellsFor(0.010), seed + 22);
      const tint = tileNoise(N, 12, seed + 23, 2);
      for (let i = 0; i < N * N; i++) {
        const id = B.ID[i];
        const r = 0.36 + 0.26 * id;
        const big = smoothstep(r, r * 0.62, B.F1[i]) * smoothstep(0.015, 0.09, B.E[i]);
        const dome = Math.sqrt(clamp(1 - (B.F1[i] / r) * (B.F1[i] / r), 0, 1));
        const grit = smoothstep(0.03, 0.18, S.E[i]) * (1 - big);
        // Mostly one pale stone, a tenth of it a darker rock, the odd white one.
        const h2 = (id * 7.31) % 1;
        const tone = id < 0.10 ? 0.52 + 0.2 * h2 : id > 0.94 ? 1.30 : 0.84 + 0.34 * h2;
        const voidDark = 0.40 + 0.25 * S.ID[i];
        hgt[i] = big * dome * (0.007 + 0.009 * id) + grit * 0.0014 * (0.5 + S.ID[i]);
        alb[i] = lerp(lerp(voidDark, 0.78 + 0.22 * S.ID[i], grit), tone * (0.86 + 0.14 * dome), big)
          * (1 + 0.08 * tint[i]);
        top[i] = Math.max(big * dome, grit * 0.45);
      }
    },
    // Earth: fine crumb and a scatter of small pebbles, with the faint
    // hairline cracking of a surface that has dried out since it last rained —
    // only in patches, because a whole road of it reads as crazy paving.
    () => {
      const crumb = tileNoise(N, 96, seed + 31, 3);
      const P = worley(N, cellsFor(0.024), seed + 32);
      const C = worley(N, cellsFor(0.30), seed + 33);
      const mask = tileNoise(N, 4, seed + 34, 2);
      for (let i = 0; i < N * N; i++) {
        const r = 0.30;
        const peb = P.ID[i] < 0.34 ? smoothstep(r, r * 0.5, P.F1[i]) : 0;
        const crack = (1 - smoothstep(0.0, 0.022, C.E[i])) * smoothstep(0.10, 0.45, mask[i]);
        hgt[i] = crumb[i] * 0.0011 + peb * 0.004 - crack * 0.0008;
        alb[i] = (0.95 + 0.16 * crumb[i]) * (1 - 0.14 * crack) + peb * (0.08 + 0.34 * (P.ID[i] - 0.17));
        top[i] = clamp(0.5 + crumb[i] * 0.6 + peb * 0.5 - crack, 0, 1);
      }
    },
    // Concrete: fine exposed aggregate and pinholes.
    () => {
      const A = worley(N, cellsFor(0.006), seed + 41);
      const pores = tileNoise(N, 160, seed + 42, 2);
      for (let i = 0; i < N * N; i++) {
        const stone = smoothstep(0.05, 0.25, A.E[i]);
        const pore = smoothstep(0.55, 0.75, pores[i]);
        hgt[i] = stone * 0.0004 - pore * 0.0006;
        alb[i] = (0.92 + 0.16 * stone * A.ID[i]) * (1 - 0.35 * pore);
        top[i] = clamp(stone - pore, 0, 1);
      }
    },
  ];

  const means = [1, 1, 1, 1];
  // Every layer starts flat and neutral — which the shader reads as "no
  // detail" — and a layer some road uses is filled in by build(L), now or
  // shortly after load.
  data.fill(128);
  const build = (L) => {
    recipes[L]();
    // Normalise the albedo multiplier to a mean of exactly 1, so the detail
    // adds grain without moving the colour the macro layer chose.
    let mean = 0;
    for (let i = 0; i < N * N; i++) mean += alb[i];
    mean /= N * N;
    means[L] = mean;
    const o0 = L * per;
    for (let py = 0; py < N; py++) {
      const up = ((py + N - 1) % N) * N, dn = ((py + 1) % N) * N, cur = py * N;
      for (let px = 0; px < N; px++) {
        const xl = (px + N - 1) % N, xr = (px + 1) % N;
        // Relief is exaggerated about 0.6x of true slope: real chippings are
        // steeper than this, but at a texel of 3 mm the full slope reads as
        // noise under a low sun rather than as stone.
        const dx = (hgt[cur + xr] - hgt[cur + xl]) / (2 * texel) * 0.6;
        const dz = (hgt[dn + px] - hgt[up + px]) / (2 * texel) * 0.6;
        const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        const o = o0 + (cur + px) * 4;
        data[o] = clamp((0.5 - dx * inv * 0.5) * 255 + 0.5, 0, 255);
        data[o + 1] = clamp((0.5 - dz * inv * 0.5) * 255 + 0.5, 0, 255);
        data[o + 2] = clamp((alb[cur + px] / mean) * 0.5 * 255 + 0.5, 0, 255);
        data[o + 3] = clamp(top[cur + px], 0, 1) * 255;
      }
    }
    return L;
  };
  const later = [];
  for (let L = 0; L < recipes.length; L++) {
    if (want && !want.has(L)) continue;       // never sampled in this world
    if (defer) later.push(L); else build(L);
  }
  return { data, size: N, layers: recipes.length, means, later, build };
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------
//
// Patched into a MeshStandardMaterial rather than written as a ShaderMaterial,
// so the roads keep three's lights, shadows, fog and tone mapping without any
// of it being reimplemented here.

const V_PARS = /* glsl */`
attribute vec3 aRoad;        // x macro layer, y detail layer (-1 none), z fringe 0..1
uniform vec2 uPull;          // x fraction of distance, y cap in metres
varying vec3 vRoad;
varying vec2 vRoadUv;
varying vec2 vRoadXZ;
`;


const V_MAIN = /* glsl */`
vRoad = aRoad;
vRoadUv = uv;
vRoadXZ = ( modelMatrix * vec4( position, 1.0 ) ).xz;
`;

// Appended after <project_vertex>: draw the road a little nearer the eye in
// DEPTH only. Scaling the view-space position toward the camera leaves x/z
// and y/z untouched, so nothing moves on screen; only the depth test sees it.
//
// The terrain mesh is a linear interpolation of the same field between
// vertices 1.3-16 m apart, and where a flat carriageway meets a rising verge
// the interpolation rides above the true surface by more than the 4 cm the
// road is drawn at — worst on the low tier, whose near grid is 2.7 m. Polygon
// offset cannot help: its units are depth-buffer steps, which are fractions of
// a millimetre near the car. A pull of 0.4% of the distance does, and it is
// capped at 15 cm so a road behind the crest of a hill can never show through
// it: the only thing the cap lets the road win against is something within
// 15 cm of lying on it.
const V_PULL = /* glsl */`
{
  float roadLen = length( mvPosition.xyz );
  float roadPull = min( uPull.x * roadLen, uPull.y );
  mvPosition.xyz *= 1.0 - roadPull / max( roadLen, 1e-3 );
  gl_Position = projectionMatrix * mvPosition;
}
`;

const F_PARS = /* glsl */`
uniform sampler2DArray uRoadAlb;
uniform sampler2DArray uRoadNrm;
uniform sampler2DArray uRoadDet;
uniform float uDetScale;
uniform float uWet;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uVerge;
varying vec3 vRoad;
varying vec2 vRoadUv;
varying vec2 vRoadXZ;
vec4 roadAlb;
vec4 roadNrm;
vec4 roadDet;
float roadPuddle;

// The tangent frame from screen-space derivatives, as three builds it for its
// own normal maps. A copy, because three only defines it when a material has
// a normalMap, and this one samples an array texture three does not know about.
mat3 roadFrame( vec3 eye, vec3 n, vec2 uv ) {
  vec3 q0 = dFdx( eye ), q1 = dFdy( eye );
  vec2 st0 = dFdx( uv ), st1 = dFdy( uv );
  vec3 q1perp = cross( q1, n ), q0perp = cross( n, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, n );
}
`;

// Replaces <map_fragment>.
const F_MAP = /* glsl */`
roadAlb = texture( uRoadAlb, vec3( vRoadUv, vRoad.x ) );
roadNrm = texture( uRoadNrm, vec3( vRoadUv, vRoad.x ) );
{
  float hasDet = step( -0.5, vRoad.y );
  roadDet = mix( vec4( 0.5, 0.5, 0.5, 0.6 ),
    texture( uRoadDet, vec3( vRoadXZ * uDetScale, max( vRoad.y, 0.0 ) ) ), hasDet );
}
// The ragged edge. Across the fringe the surface thins out into the verge: a
// coarse blotch sets where the edge bulges and the detail's own stones decide
// which texels survive at the boundary, so the break-up happens stone by stone.
if ( vRoad.z > 0.0 ) {
  float coarse = textureLod( uRoadDet, vec3( vRoadXZ * 0.085, 2.0 ), 3.0 ).b;
  float keep = 0.55 + ( coarse - 0.5 ) * 1.4 + ( roadDet.a - 0.5 ) * 0.55 - vRoad.z * 1.25;
  if ( keep < 0.0 ) discard;
  roadAlb.rgb = mix( roadAlb.rgb, uVerge, smoothstep( 0.0, 0.9, vRoad.z ) * 0.8 );
  roadAlb.a *= 1.0 - vRoad.z;
}
diffuseColor.rgb *= roadAlb.rgb * ( roadDet.b * 2.0 );
`;

// Replaces <roughnessmap_fragment>. Wetness is applied here because it has to
// change the albedo and the roughness together.
const F_ROUGH = /* glsl */`
float roughnessFactor = mix( 0.94, 0.40, roadAlb.a );
roughnessFactor = clamp( roughnessFactor + ( 0.55 - roadDet.a ) * 0.10, 0.08, 1.0 );
// Standing water fills the lowest relief first: ruts, potholes, open cracks,
// and the gaps between stones before the stones themselves.
roadPuddle = uWet * smoothstep( 0.30, 0.70,
  roadNrm.b * 1.15 + ( uWet - 1.0 ) * 0.55 + ( 0.5 - roadDet.a ) * 0.35 );
// A wet porous surface darkens by about 40%; a polished one much less.
diffuseColor.rgb *= mix( 1.0, 0.60, uWet * ( 1.0 - 0.5 * roadAlb.a ) );
diffuseColor.rgb *= 1.0 - 0.18 * roadPuddle;
roughnessFactor = mix( roughnessFactor, 0.32, uWet * 0.85 );
roughnessFactor = mix( roughnessFactor, 0.045, roadPuddle );
`;

// Replaces <normal_fragment_maps>.
const F_NORMAL = /* glsl */`
#ifdef ROAD_NORMALS
{
  vec3 mapN = vec3( roadNrm.xy * 2.0 - 1.0, 0.0 );
  mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );
  mat3 tbn = roadFrame( - vViewPosition, normal, vRoadUv );
  tbn[ 0 ] *= faceDirection;
  tbn[ 1 ] *= faceDirection;
  normal = normalize( tbn * mapN );
  // The detail normal is in world X/Z, and roads are near enough horizontal
  // that adding it in world space and rotating into view is exact to within
  // the grade. Water is flat, so a puddle loses both.
  vec2 dn = ( roadDet.rg * 2.0 - 1.0 ) * ( 1.0 - roadPuddle );
  normal = normalize( normal + ( viewMatrix * vec4( dn.x, 0.0, dn.y, 0.0 ) ).xyz );
  normal = normalize( mix( normal, nonPerturbedNormal, roadPuddle ) );
}
#endif
`;

// Appended after <lights_fragment_maps>: the sky, as the road sees it.
//
// There is no environment map in this game, so without this the only specular
// a road gets is the sun's highlight, and a wet road reflects nothing at all.
// The sky module hands over its zenith and horizon radiance every frame; this
// looks the reflected ray up in that gradient, blurred toward the average sky
// as the surface gets rougher. three's own split-sum Fresnel then decides how
// much of it a road at this angle actually returns — which is why dry tarmac
// goes pale and silvery far ahead of the car, exactly as it does in life.
const F_ENV = /* glsl */`
#if defined( RE_IndirectSpecular )
{
  vec3 rw = inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
  vec3 skyRad = mix( uSkyHorizon, uSkyZenith, smoothstep( 0.0, 0.55, rw.y ) );
  skyRad = mix( skyRad, ( uSkyHorizon * 0.6 + uSkyZenith * 0.4 ), roughnessFactor * roughnessFactor );
  // Below the horizon the reflection is the ground, which is dark.
  skyRad *= mix( 0.18, 1.0, smoothstep( -0.12, 0.02, rw.y ) );
  radiance += skyRad;
}
#endif
`;

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

// The layer, detail and fringe values every vertex pushed next will carry.
// Set once per strip rather than threaded through every call.
const cur = { layer: 0, detail: 0, fringe: 0 };

/** Appends one vertex and returns its index in the bucket. */
function vert(bk, x, y, z, nx, ny, nz, u, v, t, fringe = 0) {
  const i = bk.pos.length / 3;
  bk.pos.push(x, y, z);
  bk.nor.push(nx, ny, nz);
  bk.uv.push(u, v);
  bk.col.push(t, t, t);
  bk.road.push(cur.layer, cur.detail, fringe);
  return i;
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
  bk.idx.push(
    vert(bk, p.x, p.y, p.z, nx, ny, nz, p.u, p.v, p.t),
    vert(bk, q.x, q.y, q.z, nx, ny, nz, q.u, q.v, q.t),
    vert(bk, r.x, r.y, r.z, nx, ny, nz, r.u, r.v, r.t));
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

  // ---- families -----------------------------------------------------------
  // Registered in a fixed pass over the world so the layout is deterministic
  // and the textures hold nothing the map does not actually use. The key
  // carries the road KIND as well as its dimensions, because two kinds that
  // happen to share a profile do not share a history.
  const specs = [];
  const famOf = new Map();
  function family(key, make) {
    let f = famOf.get(key);
    if (f === undefined) { f = specs.length; specs.push(make()); famOf.set(key, f); }
    return f;
  }

  const edgeFam = new Int16Array(world.edges.length);
  let anyCity = false, maxWidth = 0;
  for (const e of world.edges) {
    const key = `${e.kind}|${e.markings}|${e.width}|${e.lanes}|${e.surface}`;
    // Anything layout.js does not call asphalt is an unpaved lane, so a surface
    // added to ROAD later gets the loose painter by default rather than being
    // silently drawn as tarmac.
    edgeFam[e.i] = family(key, () => (e.surface === 'asphalt'
      ? pavedSpec(e.kind, e.markings, e.width, e.lanes, seed + rowSeed(e.kind, e.width))
      : looseSpec(e.kind, e.width, seed + rowSeed(e.kind, e.width))));
    if (CITY[e.kind] === 1) anyCity = true;
    if (e.width > maxWidth) maxWidth = e.width;
  }
  const walkFam = anyCity ? family('walk', () => walkSpec(seed + 311)) : -1;
  const kerbFam = anyCity ? family('kerb', () => kerbSpec(seed + 733)) : -1;

  // A junction takes the surface most of its arms are made of; a gravel lane
  // meeting a dirt one gives a gravel fill, because the dressing is what gets
  // dragged across the mouth.
  const junctions = world.nodes.filter((n) => n.edges.length >= 3);
  const patchFam = new Map();
  const patchKind = new Map();
  for (const n of junctions) {
    let loose = 0, gravel = 0;
    for (const ei of n.edges) {
      const sf = world.edges[ei].surface;
      if (sf !== 'asphalt') { loose++; if (sf === 'gravel') gravel++; }
    }
    const s = loose * 2 > n.edges.length ? (gravel * 2 > loose ? 'gravel' : 'dirt') : 'asphalt';
    patchKind.set(n.i, s);
    if (!patchFam.has(s)) patchFam.set(s, family('patch:' + s, () => patchSpec(s, seed + 977)));
  }

  // LOAD TIME. Painting every layer and the detail up front made the roads
  // the slowest stage of loading. In a browser only what the first frame needs
  // is painted now: the first copy of every surface. The detail layers and the
  // second copies follow one at a time in idle time over the next second or
  // so, while the player is still on the title screen. Headless (the
  // harnesses) everything is built synchronously, so what is measured is
  // exactly what is drawn.
  const defer = opts.defer ?? (typeof window !== 'undefined');
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const tPaint = now();
  const layerW = maxWidth > 13 ? LAYER_W_WIDE : LAYER_W_NARROW;
  const atlas = buildLayers(specs, layerW, defer);
  const tDetail = now();
  // Only the detail layers some road actually uses are generated; the rest are
  // left neutral, which the shader reads as "no detail".
  const wantDetail = new Set(specs.map((s) => DETAIL[s.surface]).filter((d) => d >= 0));
  const detail = buildDetail(seed + 5021, wantDetail, defer);
  const tDone = now();
  const paintMs = tDetail - tPaint, detailMs = tDone - tDetail;

  const detailOf = (spec) => DETAIL[spec.surface] ?? DETAIL.none;

  // ---- buckets ----------------------------------------------------------
  const buckets = new Map();
  function bucket(x, z) {
    const i = clamp(Math.floor((x + half) / REGION), 0, GRID - 1);
    const j = clamp(Math.floor((z + half) / REGION), 0, GRID - 1);
    const k = j * GRID + i;
    let bk = buckets.get(k);
    if (!bk) {
      bk = { cx: (i + 0.5) * REGION - half, cz: (j + 0.5) * REGION - half, pos: [], nor: [], uv: [], col: [], road: [], idx: [] };
      buckets.set(k, bk);
    }
    return bk;
  }

  // Low-frequency patchiness in world space. The texture repeats every 24 m;
  // this does not, which is what stops the eye locking onto the tile.
  const tseed = (seed + 4021) | 0;
  const tint = (x, z) => 1 + fbm(x * 0.0143, z * 0.0143, tseed, 2) * 0.06;

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

  // ---- carriageway ribbons, fringes, kerbs and sidewalks -----------------
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
        // Fringe outer points, left and right.
        lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0,
        // The row of vertices this station last emitted, and for which bucket
        // and tile, so the next quad can share it instead of repeating it.
        rowBk: null, rowTile: -1, row: 0,
      };
    }
    return s;
  }

  /**
   * Splits any 8 m quad whose chord strays from the height field.
   *
   * The ribbon is linear between stations, and on a crest a straight chord
   * runs BELOW the curved surface: the sagitta of an 8 m chord over a 100 m
   * vertical curve is 8 cm, twice the clearance the road is drawn with. The
   * terrain mesh is 1.6 m between vertices near the car, so it follows the
   * crest and came up THROUGH the tarmac mid-quad — the dark hexagons that sat
   * in the middle of country roads on every brow. Halving a quad quarters its
   * sagitta, so a quad is split until the field rises no more than 2.2 cm
   * above its midpoint at the centre line or either edge, down to 1 m. That
   * leaves 1.8 cm of the 4 cm clearance for the terrain mesh's own error.
   */
  const TOL = 0.022;
  const refined = [];
  function refine(e, list) {
    const hw = e.width / 2;
    refined.length = 0;
    refined.push(list[0]);
    let ya = cross3(e, hw, list[0], [0, 0, 0]);
    for (let i = 0; i + 1 < list.length; i++) {
      const yb = cross3(e, hw, list[i + 1], [0, 0, 0]);
      split(e, hw, list[i], list[i + 1], ya, yb, 0);
      ya = yb;
    }
    list.length = 0;
    for (const x of refined) list.push(x);
  }
  /** Field heights at the left edge, the centre line and the right edge. */
  function cross3(e, hw, s, out) {
    const p = pointOnEdge(e, s);
    for (let k = -1; k <= 1; k++) out[k + 1] = ground.heightAt(p.x + p.nx * k * hw, p.z + p.nz * k * hw);
    return out;
  }
  /**
   * Quarter points as well as the middle: the height field is stamped on a
   * 3 m grid, so it carries bumps shorter than the quad, and a midpoint alone
   * can land on the one sample that happens to agree. The endpoint heights
   * are handed down, so each test costs nine field samples, not fifteen.
   */
  function split(e, hw, a, b, ya, yb, depth) {
    if (depth < 3 && b - a > 1.9) {
      const q1 = cross3(e, hw, a + (b - a) * 0.25, [0, 0, 0]);
      const q2 = cross3(e, hw, (a + b) * 0.5, [0, 0, 0]);
      const q3 = cross3(e, hw, a + (b - a) * 0.75, [0, 0, 0]);
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        // Only a surface ABOVE the chord matters: that is the terrain coming
        // up through the road. A chord above a sag just floats a centimetre
        // or two, which the drawn clearance already allows for.
        worst = Math.max(worst,
          q1[k] - (ya[k] * 0.75 + yb[k] * 0.25),
          q2[k] - (ya[k] + yb[k]) * 0.5,
          q3[k] - (ya[k] * 0.25 + yb[k] * 0.75));
      }
      if (worst > TOL) {
        const m = (a + b) * 0.5;
        split(e, hw, a, m, ya, q2, depth + 1);
        split(e, hw, m, b, q2, yb, depth + 1);
        return;
      }
    }
    refined.push(b);
  }

  const arcs = [];
  const cols = [];
  let quads = 0, fringeQuads = 0;
  const variantUse = new Map();

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
    // a little past 1, which the sampler's own wrap handles.
    if (rem > 0.4) arcs.push(s1); else arcs[arcs.length - 1] = s1;
    if (arcs.length < 2) continue;
    refine(e, arcs);

    const h = e.width / 2;
    const fam = edgeFam[e.i];
    const spec = specs[fam];
    const layer0 = atlas.first[fam];
    // Columns across the road, as fractions of the half-width. There is always
    // one at 70% each side: the ground is flat across the carriageway but its
    // outer 15% blends toward the verge, so a vertex where the flat part ends
    // keeps the chord from cutting under it.
    cols.length = 0;
    cols.push(-1);
    if (e.width >= 5) {
      const inner = Math.max(1, Math.ceil((1.4 * h) / MAX_STRIP));
      for (let k = 0; k <= inner; k++) cols.push(-0.7 + (1.4 * k) / inner);
    } else {
      const inner = Math.max(1, Math.ceil(e.width / MAX_STRIP));
      for (let k = 1; k < inner; k++) cols.push(-1 + (2 * k) / inner);
    }
    cols.push(1);
    const strips = cols.length - 1;
    const walk = walkFam >= 0 && CITY[e.kind] === 1;
    const fw = walk ? 0 : e.kind === 'circuit' ? FRINGE.circuit
      : spec.paint === 'loose' ? FRINGE.loose : FRINGE.paved;
    // Mirror the whole road across its width on half the edges. Every marking
    // plan is symmetric, so the paint does not notice, and it doubles the
    // number of distinct-looking roads for nothing. Per edge, never per tile:
    // the noise is not symmetric, so mirroring mid-edge would open a seam.
    const flip = hash1(e.i, seed + 17) < 0.5;
    const U = (u) => (flip ? 1 - u : u);

    for (let i = 0; i < arcs.length; i++) {
      const p = pointOnEdge(e, arcs[i]);
      const st = station(i);
      st.ax = p.nx; st.az = p.nz;                 // right-hand normal of the road
      for (let k = 0; k <= strips; k++) {
        const f = cols[k] * h;
        const x = p.x + p.nx * f, z = p.z + p.nz * f;
        st.X[k] = x; st.Z[k] = z;
        st.Y[k] = ground.heightAt(x, z) + LIFT;
        st.T[k] = tint(x, z);
      }
      st.cx = p.x; st.cz = p.z; st.cy = (st.Y[0] + st.Y[strips]) * 0.5;
      if (fw > 0) {
        const lx = p.x - p.nx * (h + fw), lz = p.z - p.nz * (h + fw);
        const rx = p.x + p.nx * (h + fw), rz = p.z + p.nz * (h + fw);
        st.lx = lx; st.lz = lz; st.ly = ground.heightAt(lx, lz) + LIFT;
        st.rx = rx; st.rz = rz; st.ry = ground.heightAt(rx, rz) + LIFT;
      }
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

    const fu = fw / e.width;                      // fringe width in U
    for (let i = 0; i <= last; i++) pool[i].rowBk = null;
    // One station's row of vertices, emitted at most once per bucket and tile.
    // U continues past the carriageway for the fringe; the sampler clamps it
    // back to the edge column, so the ravelled edge of the texture is what
    // breaks up into the verge.
    const rowFor = (st, bk, tile, v) => {
      if (st.rowBk === bk && st.rowTile === tile) return st.row;
      const base = bk.pos.length / 3;
      for (let k = 0; k <= strips; k++) {
        vert(bk, st.X[k], st.Y[k], st.Z[k], st.nx, st.ny, st.nz, U((cols[k] + 1) * 0.5), v, st.T[k], 0);
      }
      if (fw > 0) {
        vert(bk, st.lx, st.ly, st.lz, st.nx, st.ny, st.nz, U(-fu), v, st.T[0], 1);
        vert(bk, st.rx, st.ry, st.rz, st.nx, st.ny, st.nz, U(1 + fu), v, st.T[strips], 1);
      }
      st.rowBk = bk; st.rowTile = tile; st.row = base;
      return base;
    };
    for (let i = 0; i < last; i++) {
      const A = pool[i], B = pool[i + 1];
      const bk = bucket((A.cx + B.cx) * 0.5, (A.cz + B.cz) * 0.5);
      // V restarts at every tile boundary, and every boundary is a station,
      // so no quad ever straddles two tiles. The last quad of an edge may run
      // a little past 1, which the sampler's own wrap handles.
      const tileIdx = Math.floor((arcs[i] - s0 + 1e-6) / TILE);
      const tileStart = s0 + tileIdx * TILE;
      const va = (arcs[i] - tileStart) / TILE;
      const vb = (arcs[i + 1] - tileStart) / TILE;
      // Which worn copy this 24 m tile uses. Hashed on the edge and the tile,
      // so it is fixed for the life of the world and different on every road.
      const variant = spec.variants > 1 ? Math.floor(hash2(e.i, tileIdx, seed + 29) * spec.variants) : 0;
      cur.layer = layer0 + variant;
      cur.detail = detailOf(spec);
      variantUse.set(cur.layer, (variantUse.get(cur.layer) || 0) + 1);

      // Winding verified against forward = -Z, right = +X: index 0 is the left
      // kerb, index `strips` the right, and (left, right, right') faces up.
      // Vertex rows are shared between consecutive quads of the same tile and
      // bucket, so a station costs its vertices once rather than twice.
      const a = rowFor(A, bk, tileIdx, va), b = rowFor(B, bk, tileIdx, vb);
      const I = bk.idx;
      for (let k = 0; k < strips; k++) {
        I.push(a + k, a + k + 1, b + k + 1, a + k, b + k + 1, b + k);
        quads++;
      }
      if (fw > 0) {
        // Row layout: strips + 1 carriageway vertices, then the left and the
        // right fringe outer points. The fringe's inner edge IS the
        // carriageway's edge vertex — same position, same U, fringe 0.
        const aL = a + strips + 1, aR = a + strips + 2, bL = b + strips + 1, bR = b + strips + 2;
        I.push(aL, a, b, aL, b, bL);
        I.push(a + strips, aR, bR, a + strips, bR, b + strips);
        fringeQuads += 2;
      }

      if (!walk) continue;
      const R = strips;
      const kl = atlas.first[kerbFam], wl = atlas.first[walkFam];

      // Left side, then right. The kerb face points away from the carriageway.
      cur.layer = kl; cur.detail = DETAIL.none;
      quad(bk,
        V(_a, A.X[0], A.Y[0], A.Z[0], 0, va, A.T[0]),
        V(_b, A.X[0], A.Y[0] + KERB, A.Z[0], 1, va, A.T[0]),
        V(_c, B.X[0], B.Y[0] + KERB, B.Z[0], 1, vb, B.T[0]),
        V(_d, B.X[0], B.Y[0], B.Z[0], 0, vb, B.T[0]),
        -A.ax, 0, -A.az);
      quad(bk,
        V(_a, A.X[R], A.Y[R], A.Z[R], 0, va, A.T[R]),
        V(_b, A.X[R], A.Y[R] + KERB, A.Z[R], 1, va, A.T[R]),
        V(_c, B.X[R], B.Y[R] + KERB, B.Z[R], 1, vb, B.T[R]),
        V(_d, B.X[R], B.Y[R], B.Z[R], 0, vb, B.T[R]),
        A.ax, 0, A.az);
      cur.layer = wl; cur.detail = DETAIL.concrete;
      quad(bk,
        V(_a, A.X[0], A.Y[0] + KERB, A.Z[0], 0, va, A.T[0]),
        V(_b, A.ox, A.oy, A.oz, 1, va, A.T[0]),
        V(_c, B.ox, B.oy, B.oz, 1, vb, B.T[0]),
        V(_d, B.X[0], B.Y[0] + KERB, B.Z[0], 0, vb, B.T[0]),
        0, 1, 0);
      quad(bk,
        V(_a, A.X[R], A.Y[R] + KERB, A.Z[R], 0, va, A.T[R]),
        V(_b, A.qx, A.qy, A.qz, 1, va, A.T[R]),
        V(_c, B.qx, B.qy, B.qz, 1, vb, B.T[R]),
        V(_d, B.X[R], B.Y[R] + KERB, B.Z[R], 0, vb, B.T[R]),
        0, 1, 0);
      quads += 4;
    }
  }

  // ---- junction patches and kerb returns ---------------------------------
  const arms = [];
  let patches = 0;

  /**
   * One triangle of a junction fan, split into four while the ground bulges
   * through it. A junction is where several graded roads are blended into one
   * surface, so it is the least planar ground in the network, and a fan of
   * flat 15 m triangles sank under it — measured, one fan sample in eight was
   * within 1.5 cm of the surface. Heights are ground heights; LIFT is added
   * when the vertex is written.
   */
  function fan(bk, ax, ay, az, bx, by, bz, cx, cy2, cz, uvP, depth) {
    const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
    const bulge = ground.heightAt(mx, mz) - (ay + by + cy2) / 3;
    const size = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - ax, cz - az), Math.hypot(cx - bx, cz - bz));
    if (depth < 3 && size > 2.5 && bulge > LIFT - 0.022) {
      const abx = (ax + bx) / 2, abz = (az + bz) / 2, aby = ground.heightAt(abx, abz);
      const bcx = (bx + cx) / 2, bcz = (bz + cz) / 2, bcy = ground.heightAt(bcx, bcz);
      const cax = (cx + ax) / 2, caz = (cz + az) / 2, cay = ground.heightAt(cax, caz);
      fan(bk, ax, ay, az, abx, aby, abz, cax, cay, caz, uvP, depth + 1);
      fan(bk, abx, aby, abz, bx, by, bz, bcx, bcy, bcz, uvP, depth + 1);
      fan(bk, cax, cay, caz, bcx, bcy, bcz, cx, cy2, cz, uvP, depth + 1);
      fan(bk, abx, aby, abz, bcx, bcy, bcz, cax, cay, caz, uvP, depth + 1);
      return;
    }
    tri(bk, uvP(_a, ax, ay + LIFT, az), uvP(_b, bx, by + LIFT, bz), uvP(_c, cx, cy2 + LIFT, cz), 0, 1, 0);
  }

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
    const pf = patchFam.get(patchKind.get(n.i));
    cur.layer = atlas.first[pf];
    cur.detail = detailOf(specs[pf]);

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
      clamp(0.5 + (z - n.z) * inv, 0, 1), tint(x, z));

    for (let k = 0; k < arms.length * 2; k++) {
      const m0 = arms[(k >> 1) % arms.length], m1 = arms[((k + 1) >> 1) % arms.length];
      const x0 = (k & 1) ? m0.bx : m0.ax, z0 = (k & 1) ? m0.bz : m0.az;
      const x1 = (k & 1) ? m1.ax : m1.bx, z1 = (k & 1) ? m1.az : m1.bz;
      fan(bk, n.x, cy - LIFT, n.z, x0, ground.heightAt(x0, z0), z0,
        x1, ground.heightAt(x1, z1), z1, uvP, 0);
    }
    patches++;

    if (walkFam < 0) continue;
    // Kerb returns. Without them every city intersection has a four-way gap in
    // the pavement, which is far more noticeable than the corners themselves.
    for (let k = 0; k < arms.length; k++) {
      const m0 = arms[k], m1 = arms[(k + 1) % arms.length];
      if (!m0.city || !m1.city) continue;
      const chord = Math.hypot(m1.ax - m0.bx, m1.az - m0.bz);
      if (chord < 0.4) continue;
      const vv = Math.min(1, chord / TILE);
      const y0 = ground.heightAt(m0.bx, m0.bz) + LIFT;
      const y1 = ground.heightAt(m1.ax, m1.az) + LIFT;
      // The face has to look away from the junction, whichever way round the
      // wedge happens to be wound.
      const mx = (m0.bx + m1.ax) * 0.5 - n.x, mz = (m0.bz + m1.az) * 0.5 - n.z;

      const t0v = tint(m0.bx, m0.bz), t1v = tint(m1.ax, m1.az);
      cur.layer = atlas.first[kerbFam]; cur.detail = DETAIL.none;
      quad(bk,
        V(_a, m0.bx, y0, m0.bz, 0, 0, t0v), V(_b, m0.bx, y0 + KERB, m0.bz, 1, 0, t0v),
        V(_c, m1.ax, y1 + KERB, m1.az, 1, vv, t1v), V(_d, m1.ax, y1, m1.az, 0, vv, t1v),
        mx, 0, mz);
      cur.layer = atlas.first[walkFam]; cur.detail = DETAIL.concrete;
      quad(bk,
        V(_a, m0.bx, y0 + KERB, m0.bz, 0, 0, t0v),
        V(_b, m0.qx, ground.heightAt(m0.qx, m0.qz) + LIFT + KERB, m0.qz, 1, 0, tint(m0.qx, m0.qz)),
        V(_c, m1.ox, ground.heightAt(m1.ox, m1.oz) + LIFT + KERB, m1.oz, 1, vv, tint(m1.ox, m1.oz)),
        V(_d, m1.ax, y1 + KERB, m1.az, 0, vv, t1v),
        0, 1, 0);
    }
  }

  // ---- textures and material ----------------------------------------------
  // Both macro textures are the same stack of layers. V wraps in the sampler;
  // U clamps, which is also what turns the fringe's out-of-range U into the
  // ravelled edge column.
  function arrayTex(data, w, h, d, space, wrapS) {
    const t = new THREE.DataArrayTexture(data, w, h, d);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = space;
    t.wrapS = wrapS;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = opts.anisotropy ?? QUALITY.medium.anisotropy;
    t.needsUpdate = true;
    return t;
  }
  const albedoTex = arrayTex(atlas.alb, atlas.width, atlas.height, atlas.layers, THREE.SRGBColorSpace, THREE.ClampToEdgeWrapping);
  const normalTex = arrayTex(atlas.nrm, atlas.width, atlas.height, atlas.layers, THREE.NoColorSpace, THREE.ClampToEdgeWrapping);
  const detailTex = arrayTex(detail.data, detail.size, detail.size, detail.layers, THREE.NoColorSpace, THREE.RepeatWrapping);
  const textures = [albedoTex, normalTex, detailTex];

  // The idle queue: detail first, because it is what the camera sits on, then
  // the second copies. One job per idle slot, each 10-40 ms; only the layer
  // that changed is re-uploaded.
  //
  // A partial upload is only safe onto storage that already holds every other
  // layer. The FIRST upload allocates the storage, and so does any upload
  // after a sampler change (anisotropy is part of three's texture cache key,
  // so changing it makes a new GL texture) — a layer update riding either of
  // those uploads every layer but one as black. Measured: switching quality
  // while the queue was still running blacked out every road but one. So a
  // texture waiting on a full upload takes no layer updates; the data array
  // is shared, and the full upload carries the new layer anyway.
  const fullPending = new Set();
  const expectFull = (tex) => {
    tex.clearLayerUpdates();
    fullPending.add(tex);
    tex.onUpdate = () => fullPending.delete(tex);
  };
  const touch = (tex, L) => {
    if (!fullPending.has(tex)) tex.addLayerUpdate(L);
    tex.needsUpdate = true;
  };
  for (const tex of textures) expectFull(tex);
  const jobs = [];
  for (const L of detail.later) {
    jobs.push(() => touch(detailTex, detail.build(L)));
  }
  for (const job of atlas.later) {
    jobs.push(() => {
      const L = atlas.paintLater(job);
      touch(albedoTex, L);
      touch(normalTex, L);
    });
  }
  let disposed = false;
  const idle = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 40);
  const pump = () => {
    if (disposed || !jobs.length) return;
    jobs.shift()();
    if (jobs.length) idle(pump);
  };
  if (jobs.length) idle(pump);
  /** Runs whatever is still queued, now. For harnesses and captures. */
  function finishNow() { while (jobs.length && !disposed) jobs.shift()(); }

  const verge = surfaceRGB('gravel', 1.0);
  const uniforms = {
    uRoadAlb: { value: albedoTex },
    uRoadNrm: { value: normalTex },
    uRoadDet: { value: detailTex },
    uDetScale: { value: 1 / DETAIL_M },
    uWet: { value: 0 },
    // A clear late-morning sky until the sky module says otherwise; linear.
    uSkyZenith: { value: new THREE.Color(0.30, 0.52, 0.95) },
    uSkyHorizon: { value: new THREE.Color(0.95, 1.10, 1.25) },
    uVerge: { value: new THREE.Color(lin(verge[0]), lin(verge[1]), lin(verge[2])) },
    uPull: { value: new THREE.Vector2(0.004, 0.15) },
  };

  let normalsOn = true;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
    // Belt and braces with the 4 cm lift: the terrain mesh is built from the
    // same height field, so at grazing angles a metre away the two surfaces are
    // within a depth-buffer step of each other.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + V_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + V_MAIN)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + V_PULL);
    shader.fragmentShader = (normalsOn ? '#define ROAD_NORMALS\n' : '') + shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + F_PARS)
      .replace('#include <map_fragment>', F_MAP)
      .replace('#include <roughnessmap_fragment>', F_ROUGH)
      .replace('#include <normal_fragment_maps>', F_NORMAL)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n' + F_ENV);
  };
  // The program key has to carry the normals switch, or three reuses whichever
  // variant happened to compile first.
  material.customProgramCacheKey = () => 'openroad-roads-v2' + (normalsOn ? '-n' : '');

  const group = new THREE.Group();
  group.name = 'roads';
  group.matrixAutoUpdate = false;

  const meshes = [];
  const centreX = new Float32Array(buckets.size);
  const centreZ = new Float32Array(buckets.size);
  let triangles = 0, vertices = 0;

  for (const bk of buckets.values()) {
    if (bk.idx.length < 3) continue;
    const g = new THREE.BufferGeometry();
    const nv = bk.pos.length / 3;
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(bk.idx, 1) : new THREE.Uint16BufferAttribute(bk.idx, 1));
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bk.col, 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(bk.road, 3));
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
    vertices += nv;
    triangles += bk.idx.length / 3;
  }
  group.updateMatrix();
  buckets.clear();

  // ---- runtime ------------------------------------------------------------
  let cullDist = opts.drawDistance ?? QUALITY.high.drawDistance;
  const regionRadius = REGION * Math.SQRT1_2;
  let acc = 1;                               // forces a pass on the first frame

  /**
   * Reads what the sky published this frame — the colours the road reflects
   * and how wet the world is — off the scene the roads were added to. The
   * contract is a plain object on scene.userData, so there is no import and
   * no ordering between the modules: with no sky it stays a dry clear day.
   * The sky already lags wetness behind the rain (half a minute to wet, some
   * minutes to dry), so a shower that has passed leaves the road glistening.
   */
  function readSky() {
    const scene = group.parent;
    const sky = scene && scene.userData ? scene.userData.sky : null;
    if (!sky) return;
    if (sky.zenith) uniforms.uSkyZenith.value.copy(sky.zenith);
    if (sky.horizon) uniforms.uSkyHorizon.value.copy(sky.horizon);
    uniforms.uWet.value = clamp(sky.wetness ?? sky.rain ?? 0, 0, 1);
  }

  /**
   * Distance culling — the roads never move, so there is nothing else to do
   * here. Re-evaluated at 20 Hz rather than every frame: a region's visibility
   * cannot change meaningfully in 50 ms at any speed the car can reach, and
   * toggling on the frame boundary makes the horizon flicker.
   */
  function update(cameraPos, dt) {
    readSky();
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
    if (t.anisotropy !== undefined && t.anisotropy !== albedoTex.anisotropy) {
      // Sampler state is set on upload, so this re-uploads — on a settings
      // change, never per frame — and it is a full upload into new storage.
      for (const tex of textures) { tex.anisotropy = t.anisotropy; expectFull(tex); tex.needsUpdate = true; }
    }
    if (t.normals !== undefined && t.normals !== normalsOn) {
      normalsOn = t.normals;
      material.needsUpdate = true;
    }
    acc = 1;
  }

  function dispose() {
    disposed = true;
    for (const m of meshes) m.geometry.dispose();
    group.clear();
    meshes.length = 0;
    material.dispose();
    for (const t of textures) t.dispose();
  }

  const layerBytes = atlas.width * atlas.height * 4 * atlas.layers * 2;
  const detailBytes = detail.size * detail.size * 4 * detail.layers;

  return {
    group, update, setQuality, dispose, material, uniforms, finishNow,
    get pending() { return jobs.length; },
    stats: {
      drawCalls: meshes.length,
      triangles, vertices, quads, fringeQuads, patches,
      families: specs.length,
      layers: atlas.layers,
      layer: `${atlas.width}x${atlas.height}`,
      // Texels per metre along the road, which is the resolution that decides
      // whether a pothole or a joint can read at all — 43, up from 6 to 13.
      alongTexelsPerMetre: atlas.height / TILE,
      // Megabytes of texture, mips included.
      textureMB: +(((layerBytes + detailBytes) * 4 / 3) / 1048576).toFixed(1),
      paintMs: Math.round(paintMs),
      detailMs: Math.round(detailMs),
      buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    },
    // For the harness: exactly what was painted, and what every family is.
    debug: {
      specs, atlas, detail, variantUse,
      layerOfEdge: (ei) => atlas.first[edgeFam[ei]],
      familyOfEdge: (ei) => specs[edgeFam[ei]],
    },
  };
}
