// The ground mesh.
//
// COORDINATES: X east, Z south, Y up — the physics frame, unchanged. A chunk's
// vertices are (x, height, z) with x/z local to the chunk and y absolute, and
// every quad is wound so its face normal is +Y. Nothing here mirrors or negates
// an axis, so a car standing on a visible slope is standing on the slope it
// looks like it is standing on.
//
// WHY IT IS BUILT THIS WAY
//
// This is the largest mesh in the game and therefore the one that decides the
// frame rate, so both of its costs are capped by construction.
//
//   TRIANGLES are capped by concentric LOD rings. Chunks are a fixed 128 m
//   square at EVERY level — only the vertex spacing changes (1.33 / 4 / 8 / 16 m
//   at 'high'). Uniform chunk size is the whole trick: chunks tile exactly, so
//   two LOD levels can never overlap and z-fight, which is the failure mode of
//   the more obvious scheme where distant chunks are made bigger to save draw
//   calls. The price is a seam wherever two different LODs meet, and that is
//   paid with skirts instead.
//
//   BUILD TIME is capped by a per-frame millisecond budget. A cold ring is
//   ~184 000 terrain samples plus a lighter height probe at each interior
//   vertex, so chunks are queued nearest-first and drained against a deadline.
//   One innermost chunk alone is ~15 ms, which is most of a frame and then
//   some, so a fill is resumable a row at a time rather than atomic — the
//   budget is honoured at row granularity, and driving across a border at
//   155 km/h was measured at a 3.3 ms worst frame against a 3.0 ms budget.
//
// Height comes from ground.sample(), not from world.terrain — roads are carved
// into ground's height field, and a mesh built from bare terrain would show a
// hillside where the car is driving through a cutting. Sampling the same
// function the wheels sample makes that class of bug impossible rather than
// unlikely; the harness measures the agreement at 6e-8 m.
//
// SKIRTS. Each chunk is a (G+3)^2 vertex grid whose outer ring is clamped back
// onto the border and dropped a few metres, forming a vertical apron. It costs
// one ring of vertices and hides LOD cracks completely, which matters because a
// crack is not a subtle artefact — you see sky through the ground. The apron is
// 1.25 x the vertex spacing deep (never less than 3 m); the largest gap any LOD
// boundary can open was measured at 1.70 m, where the two coarsest levels meet
// and the apron is 20 m.
//
// WHERE THE DETAIL COMES FROM
//
// Vertices are metres apart, so everything smaller than a metre has to be a
// texture. Two procedural RGBA maps carry it, and between them they hold FOUR
// material masks plus two tangent-space normals, in eight channels:
//
//   detailFine   (1.15 m tile)  R gravel chips   G sand ripple   BA their normal
//   detailCoarse (3.70 m tile)  R grass blades   G soil clods    BA their normal
//
// Two textures rather than one per material, because the blend weights are
// already known ON THE CPU: fillRows() classifies every vertex through
// ground.sample() to pick its colour, so it can just as cheaply write a
// four-channel weight attribute. The rasteriser interpolates it for free, the
// fragment shader spends one dot product on it, and a grass-to-gravel border
// comes out as a gradient instead of the hard step the surface classification
// actually is. No per-pixel reclassification, no texture array, no atlas seams.
//
// The fine map is sampled triplanar (three taps) and the coarse map from above
// only (one tap). That asymmetry is not laziness: cover() turns anything
// steeper than 0.62 rad into rock, so grass and soil only ever live on ground
// gentle enough that a top-down projection stretches by at most 1.23x, while
// gravel and rock are exactly what a cliff face is made of. Four taps total.
//
// The two tile sizes are deliberately incommensurate (1.15 and 3.70), so the
// combined pattern does not visibly repeat until the two periods realign, which
// is a long way further out than the distance at which the detail has faded to
// nothing anyway.
//
// FADING. Mipmaps stop the ALBEDO aliasing on their own. Normals are the
// problem: averaging a normal map down a mip chain loses variance rather than
// converging to it, so distant ground keeps a full-strength wobble that
// scintillates as the car moves. Hence the explicit distance fade — it exists
// for the normal term, and the albedo just comes along with it.

import * as THREE from 'three';
import { fbm, valueNoise, hash2, clamp, lerp, smoothstep } from '../world/noise.js';

// rings[l] is the largest Chebyshev chunk distance still drawn at level l;
// grids[l] is that level's quad count per chunk edge. 128 / grid = vertex
// spacing. fade is where the per-pixel detail starts and finishes fading, in
// metres of view distance.
//
// Only the INNERMOST grid was raised when the detail pass went in (64 -> 96 at
// high, 64 -> 80 at medium). Measured: that buys 2 m -> 1.33 m spacing on the
// nine chunks the player is actually inside, for 251 144 -> 345 608 triangles
// and 35% more terrain samples, and it leaves levels 1..3 — the other half of
// the triangles and all of the far field — untouched, so the fog match, the
// skirt depths and the streaming behaviour out at the horizon are all exactly
// as they were. Raising level 1 to 48 as well was tried and rejected: another
// 108 000 triangles spread over forty chunks that are mostly past the fade.
const QUALITY = {
  low:    { rings: [0, 2, 4, 6], grids: [48, 24, 12,  6], budgetMs: 2.0, fade: [34,  82] },
  medium: { rings: [1, 2, 4, 7], grids: [80, 32, 16,  8], budgetMs: 2.5, fade: [55, 132] },
  high:   { rings: [1, 3, 5, 8], grids: [96, 32, 16,  8], budgetMs: 3.0, fade: [72, 172] },
};

// Materials whose colour is stamped on by a road rather than grown by the terrain.
const PAVED = { asphalt: 1, concrete: 1, sidewalk: 1, gravel: 1 };

// Grass endpoints, hand-picked rather than taken from SURFACES.grass: one flat
// green over four square kilometres reads as painted plastic at any speed.
const LUSH = [0.19, 0.33, 0.12];
const DRY  = [0.47, 0.44, 0.22];
const SOIL = [0.34, 0.26, 0.16];
// Wet churned earth, for the fringe where tyres have dragged a dirt road out
// onto the verge. Darker than SOIL and much less saturated — mud is soil with
// the light gone out of it.
const MUD  = [0.23, 0.175, 0.125];

// How much of each packed detail mask a surface shows, in the attribute's own
// order: (gravel chips, sand ripple, grass blades, soil clods). These do NOT
// sum to one — the sum is the strength, which is why asphalt gets a little
// chip and a little clod rather than a full share of something.
const DETAIL = {
  asphalt:  [0.34, 0.00, 0.00, 0.12],
  concrete: [0.24, 0.00, 0.00, 0.09],
  sidewalk: [0.28, 0.00, 0.00, 0.11],
  dirt:     [0.30, 0.00, 0.08, 0.95],
  gravel:   [0.95, 0.06, 0.02, 0.32],
  grass:    [0.05, 0.00, 0.95, 0.20],
  sand:     [0.14, 0.95, 0.00, 0.10],
  rock:     [0.90, 0.00, 0.04, 0.16],
};

// Surfaces as small integers, so the mud fringe can test a vertex's neighbours
// with array lookups instead of string comparisons. 0 means "not sampled".
const MCODE = { asphalt: 1, concrete: 2, sidewalk: 3, dirt: 4, gravel: 5, grass: 6, sand: 7, rock: 8 };
// How muddy a neighbour makes you. A dirt road is the real source; the gravel
// shoulder of a sealed road gets a weaker version of the same treatment.
const MUDDY = new Float32Array([0, 0, 0, 0, 1.0, 0.35, 0, 0, 0]);
// ...and which surfaces will take mud at all. Tarmac does not.
const TAKES_MUD = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0.8, 0.5]);

// Detail texture geometry. 512 square at a 1.15 m tile is 2.2 mm per texel,
// which is finer than a screen pixel at the closest the bonnet camera ever gets
// to the ground, and 1 MB before mips.
const TEX = 512;
const FINE_TILE = 1.15;
const COARSE_TILE = 3.70;

// three.js treats a colour attribute as already being in the working (linear)
// space, but the palette above and SURFACES[..].colour are authored as sRGB.
// A 257-entry LUT converts for the price of one lerp instead of a pow per channel.
const S2L = new Float32Array(257);
for (let i = 0; i <= 256; i++) {
  const c = i / 256;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function toLinear(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  const t = c * 256, i = t | 0;
  return S2L[i] + (S2L[i + 1] - S2L[i]) * (t - i);
}

function preset(q, fallback) {
  if (typeof q === 'number') return q < 0.34 ? 'low' : q < 0.75 ? 'medium' : 'high';
  return QUALITY[q] ? q : fallback;
}

const clock = typeof performance !== 'undefined' && performance.now ? performance : Date;

// ===========================================================================
// Tileable noise
// ===========================================================================
// noise.js is used everywhere else, but its lattice is infinite and a detail
// texture has to WRAP — a seam every 1.15 m is the one artefact you would see
// from the driver's seat before anything else. These are the same quintic value
// noise and the same hash, with the lattice index taken modulo the period.

// The period is per-axis rather than a single number, because a grass blade is
// not round: a lattice that is wide in X and short in Z produces features that
// are long in X and thin in Z, which is the only cheap way to draw something
// blade-shaped out of value noise.

function quintic(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function tileHash(ix, iz, px, pz, seed) {
  ix -= Math.floor(ix / px) * px;
  iz -= Math.floor(iz / pz) * pz;
  return hash2(ix, iz, seed);
}

function tileNoise(x, z, px, pz, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const u = quintic(x - x0), v = quintic(z - z0);
  const a = tileHash(x0, z0, px, pz, seed), b = tileHash(x0 + 1, z0, px, pz, seed);
  const c = tileHash(x0, z0 + 1, px, pz, seed), d = tileHash(x0 + 1, z0 + 1, px, pz, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Fractal sum in [-1,1]. Periods must be integers; every octave doubles them. */
function tileFbm(x, z, px, pz, seed, octaves) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(x * f, z * f, px * f, pz * f, seed + o * 1013) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// Worley cells, wrapped the same way. d1/d2 give the distance to the nearest
// and second-nearest feature point; d2 - d1 is small only on the boundary
// between two cells, which is what draws the dark gap between two gravel chips
// or the crack between two dried clods. `tone` is the winning cell's own
// brightness, so no two chips are the same shade.
const cellOut = { d1: 0, d2: 0, tone: 0 };
function tileCells(x, z, p, seed, out) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let d1 = 9, d2 = 9, tone = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cz = zi + dz;
      const ex = cx + tileHash(cx, cz, p, p, seed) * 0.92 + 0.04 - x;
      const ez = cz + tileHash(cx, cz, p, p, seed + 733) * 0.92 + 0.04 - z;
      const d = ex * ex + ez * ez;
      if (d < d1) { d2 = d1; d1 = d; tone = tileHash(cx, cz, p, p, seed + 4441); }
      else if (d < d2) d2 = d;
    }
  }
  out.d1 = Math.sqrt(d1); out.d2 = Math.sqrt(d2); out.tone = tone;
  return out;
}

/**
 * Pack a tiling height field into a texture's B and A channels as a
 * tangent-space normal.
 *
 * The gradient is normalised by its own RMS rather than by a hand-picked
 * constant, because the two maps are built from completely different recipes
 * and there is no reason their raw slopes should be comparable. Normalising
 * here means the `relief` uniform is a single artistic dial that means the same
 * thing for both. Central differences wrap, exactly as the noise does, so the
 * normal map tiles wherever the height did.
 */
function packNormal(h, W, px, target) {
  const gx = new Float32Array(W * W), gz = new Float32Array(W * W);
  let acc = 0;
  for (let j = 0; j < W; j++) {
    const jm = ((j + W - 1) % W) * W, jp = ((j + 1) % W) * W, jc = j * W;
    for (let i = 0; i < W; i++) {
      const im = (i + W - 1) % W, ip = (i + 1) % W;
      // For a surface y = h(x,z) the normal is (-dh/dx, 1, -dh/dz), so the
      // tangent-space xy IS the negated gradient — hence [i-1] minus [i+1].
      const a = h[jc + im] - h[jc + ip];
      const b = h[jm + i] - h[jp + i];
      gx[jc + i] = a; gz[jc + i] = b;
      acc += a * a + b * b;
    }
  }
  const rms = Math.sqrt(acc / (W * W * 2)) || 1;
  const k = target / rms;
  for (let c = 0; c < W * W; c++) {
    px[c * 4 + 2] = (clamp(gx[c] * k, -1, 1) * 0.5 + 0.5) * 255;
    px[c * 4 + 3] = (clamp(gz[c] * k, -1, 1) * 0.5 + 0.5) * 255;
  }
}

/**
 * Mean of one channel, 0..1.
 *
 * The shader modulates a vertex colour by (mask - midpoint), and 0.5 is the
 * right midpoint only for a mask that happens to be symmetric. The grass one is
 * not — it is mostly dark ground with bright filaments through it, mean 0.39 —
 * so assuming 0.5 would darken every blade of grass in the world by 7% and pull
 * against a palette that was tuned without it. Measuring costs one pass over a
 * texture that has just been written anyway.
 */
function midOf(px, k) {
  let s = 0;
  const n = px.length >> 2;
  for (let i = 0; i < n; i++) s += px[i * 4 + k];
  return s / (n * 255);
}

function makeTexture(px, W) {
  const t = new THREE.DataTexture(px, W, W, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // Masks and normals, not pigment: leaving this as NoColorSpace keeps the
  // renderer from applying an sRGB decode to numbers that were never colours.
  t.colorSpace = THREE.NoColorSpace;
  // Clamped by the renderer to whatever the GPU actually supports. Ground is
  // seen at grazing angles almost all the time, which is the one case trilinear
  // filtering handles worst.
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Gravel chips and sand ripple, at the scale of a few centimetres. */
function fineTexture(seed) {
  const px = new Uint8Array(TEX * TEX * 4);
  const h = new Float32Array(TEX * TEX);
  for (let j = 0; j < TEX; j++) {
    const v = j / TEX;
    for (let i = 0; i < TEX; i++) {
      const u = i / TEX, c = j * TEX + i;
      const k = tileCells(u * 26, v * 26, 26, seed + 1, cellOut);
      const border = Math.min(1, (k.d2 - k.d1) / 0.14);
      const grain = tileFbm(u * 96, v * 96, 96, 96, seed + 2, 2);
      const chip = k.tone * border;
      // Ripples are a plain sine with INTEGER wave numbers so it closes on
      // itself, phase-warped by a tiling noise so it is not a corduroy. The 0.6
      // power sharpens the crests and flattens the troughs, because wind-blown
      // sand is a sawtooth in profile and nothing like a sine.
      const warp = tileFbm(u * 6, v * 6, 6, 6, seed + 5, 3);
      const s = Math.sin(6.2831853 * (u * 11 + v * 4) + warp * 4.2)
              + 0.45 * Math.sin(6.2831853 * (u * 5 - v * 14) + warp * 2.6);
      const ripple = Math.sign(s) * Math.pow(Math.abs(s) / 1.45, 0.6);
      const grit = tileFbm(u * 150, v * 150, 150, 150, seed + 6, 2);
      px[c * 4] = clamp(0.26 + chip * 0.52 + grain * 0.12, 0, 1) * 255;
      px[c * 4 + 1] = clamp(0.5 + ripple * 0.15 + grit * 0.20 +
                            tileFbm(u * 13, v * 13, 13, 13, seed + 7, 2) * 0.09, 0, 1) * 255;
      // One normal for both masks. Gravel and sand never share ground, so the
      // worst case is that a gravel shoulder carries a trace of ripple in its
      // relief, which is invisible; the alternative was a fifth texture fetch.
      h[c] = chip * 0.8 + grain * 0.2 + ripple * 0.2;
    }
  }
  packNormal(h, TEX, px, 0.30);
  return px;
}

/** Grass blades and dried soil clods, at the scale of a hand's width. */
function coarseTexture(seed) {
  const px = new Uint8Array(TEX * TEX * 4);
  const h = new Float32Array(TEX * TEX);
  for (let j = 0; j < TEX; j++) {
    const v = j / TEX;
    for (let i = 0; i < TEX; i++) {
      const u = i / TEX, c = j * TEX + i;
      // Blades. Ridged noise (1 - |n|) makes filaments rather than blobs, and a
      // lattice stretched 6:1 makes those filaments about 23 cm long and 4 cm
      // wide at this tile size — a blade, not a smudge. The sixth power is what
      // thins them; without it the field is a uniform grey mush, which is
      // exactly what the first attempt looked like.
      //
      // FOUR of them, at 0, 90, 45 and 135 degrees, because two axis-aligned
      // sets alone came out as an unmistakable woven plaid. The diagonal pair
      // is evaluated at (u+v, u-v), which still wraps: one step in u moves that
      // coordinate by exactly one lattice period on both axes. On top of that
      // the whole domain is warped by a low-frequency noise, so no blade in the
      // texture is quite straight and the remaining grid is invisible.
      const wu = u + tileFbm(u * 4, v * 4, 4, 4, seed + 31, 2) * 0.055;
      const wv = v + tileFbm(u * 4, v * 4, 4, 4, seed + 32, 2) * 0.055;
      const du = wu + wv, dv = wu - wv;
      const b0 = 1 - Math.abs(tileNoise(wu * 15, wv * 90, 15, 90, seed + 12));
      const b1 = 1 - Math.abs(tileNoise(wu * 90, wv * 15, 90, 15, seed + 13));
      const b2 = 1 - Math.abs(tileNoise(du * 15, dv * 90, 15, 90, seed + 14));
      const b3 = 1 - Math.abs(tileNoise(du * 90, dv * 15, 90, 15, seed + 15));
      let blade = b0 > b1 ? b0 : b1;
      if (b2 > blade) blade = b2;
      if (b3 > blade) blade = b3;
      const b2p = blade * blade;
      blade = b2p * b2p * blade * blade;
      const clump = tileFbm(u * 5, v * 5, 5, 5, seed + 11, 3) * 0.5 + 0.5;
      const thin = tileNoise(u * 19, v * 19, 19, 19, seed + 16) * 0.5 + 0.5;
      const grass = blade * (0.30 + 0.70 * clump);
      // Clods, cracked apart. Smaller cells than the blades are long, so a dirt
      // road reads as broken crust rather than as cobbles.
      const k = tileCells(u * 22, v * 22, 22, seed + 21, cellOut);
      const crack = Math.min(1, (k.d2 - k.d1) / 0.10);
      const soil = k.tone * crack;
      const gr = tileFbm(u * 80, v * 80, 80, 80, seed + 15, 2);
      px[c * 4] = clamp(0.19 + grass * 0.78 + (clump - 0.5) * 0.20 - thin * 0.07, 0, 1) * 255;
      px[c * 4 + 1] = clamp(0.30 + soil * 0.42 + gr * 0.18, 0, 1) * 255;
      h[c] = grass * 0.55 + soil * 0.45;
    }
  }
  packNormal(h, TEX, px, 0.30);
  return px;
}

// ===========================================================================
// Shader
// ===========================================================================
// Injected into whatever material the mesh uses, rather than replacing it with
// a ShaderMaterial, so the terrain keeps three's fog, shadows and tone mapping
// without any of it being reimplemented here. Every replacement is guarded: a
// material that does not contain the anchor is simply left alone and the mesh
// falls back to flat vertex colours.

const V_PARS = `
attribute vec4 detailWeight;
uniform vec2 orFade;
varying vec4 vOrPos;      // xyz world position, w detail fade
varying vec4 vOrWeight;
varying vec3 vOrNormal;
`;

const V_MAIN = `
vec4 orWorld = modelMatrix * vec4( transformed, 1.0 );
vOrPos = vec4( orWorld.xyz, 1.0 - smoothstep( orFade.x, orFade.y, length( mvPosition.xyz ) ) );
vOrNormal = normalize( mat3( modelMatrix ) * objectNormal );
vOrWeight = detailWeight;
`;

const F_PARS = `
uniform sampler2D orFine;
uniform sampler2D orCoarse;
uniform vec2 orTile;        // 1 / tile size, fine and coarse
uniform vec4 orMid;         // each mask's measured mean
uniform vec4 orContrast;    // albedo swing per mask
uniform vec2 orRelief;      // normal strength, fine and coarse
uniform float orWarmth;
varying vec4 vOrPos;
varying vec4 vOrWeight;
varying vec3 vOrNormal;
`;

const F_MAIN = `
{
  float orF = vOrPos.w;
  vec3 orN = normalize( vOrNormal );
  // ^4 rather than ^2, so the crossfade between projections is confined to
  // genuinely steep ground: at 20 degrees of slope the up plane still holds 98%
  // of the weight, where ^2 would already have given a side plane 12% and put a
  // faint double image over every field in the world.
  vec3 orA = abs( orN );
  orA *= orA; orA *= orA;
  orA /= ( orA.x + orA.y + orA.z );

  vec4 fY = texture2D( orFine, vOrPos.xz * orTile.x );
  vec4 fX = texture2D( orFine, vOrPos.zy * orTile.x );
  vec4 fZ = texture2D( orFine, vOrPos.xy * orTile.x );
  vec4 fT = fY * orA.y + fX * orA.x + fZ * orA.z;
  vec4 cT = texture2D( orCoarse, vOrPos.xz * orTile.y );

  vec4 orM = vec4( fT.r, fT.g, cT.r, cT.g ) - orMid;
  vec4 orW = vOrWeight;
  float orL = dot( orM, orW * orContrast ) * orF;
  // Blade tips and ripple crests are sun-dried and read warm; the shade down in
  // a soil crack reads cold. One free tilt out of taps already paid for.
  float orT = ( orM.z * orW.z + orM.y * orW.y - orM.w * orW.w ) * orWarmth * orF;
  diffuseColor.rgb *= max( vec3( 0.0 ), vec3( 1.0 + orL + orT, 1.0 + orL, 1.0 + orL - orT ) );

  vec2 orNF = ( fT.ba - 0.5 ) * ( ( orW.x + orW.y ) * orRelief.x * orF );
  vec2 orNC = ( cT.ba - 0.5 ) * ( ( orW.z + orW.w ) * orRelief.y * orF );
  // Each plane's tangent-space xy is put back on the two world axes it was
  // projected from. The coarse map only has an up projection, so it only ever
  // perturbs through the up plane.
  vec3 orP = vec3( orNF.x, 0.0, orNF.y ) * orA.y
           + vec3( 0.0, orNF.y, orNF.x ) * orA.x
           + vec3( orNF.x, orNF.y, 0.0 ) * orA.z
           + vec3( orNC.x, 0.0, orNC.y );
  normal = normalize( ( viewMatrix * vec4( normalize( orN + orP ), 0.0 ) ).xyz );
}
`;

export function createTerrain(world, ground, opts = {}) {
  const CHUNK = opts.chunk ?? 128;
  const SURFACES = ground.SURFACES;
  const terrain = world.terrain;
  const tintSeed = ((terrain.seed ?? 0) | 0) + 5501;
  const shadows = opts.shadows ?? false;
  const managed = !!(THREE.ColorManagement && THREE.ColorManagement.enabled);

  const group = new THREE.Group();
  group.name = 'terrain';
  group.matrixAutoUpdate = false;

  // Lambert, not Standard: this mesh covers most of the screen, and a per-vertex
  // diffuse term over a quarter-million triangles is a great deal cheaper than a
  // per-pixel BRDF for ground with no specular character. Pass opts.material to
  // match the rest of the scene if that trade ever stops being worth it.
  const material = opts.material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
  const ownsMaterial = !opts.material;

  let quality = preset(opts.quality, 'high');
  let rings = QUALITY[quality].rings;
  let grids = QUALITY[quality].grids;
  let budgetMs = opts.budgetMs ?? QUALITY[quality].budgetMs;

  // =========================================================================
  // Detail maps
  // =========================================================================

  let detail = null;
  if (opts.detail !== false) {
    const seed = ((terrain.seed ?? 0) | 0) + 811;
    const relief = opts.relief ?? 1;
    const contrast = opts.contrast ?? 1;
    const finePx = fineTexture(seed);
    const coarsePx = coarseTexture(seed + 3301);
    detail = {
      fine: makeTexture(finePx, TEX),
      coarse: makeTexture(coarsePx, TEX),
      uniforms: null,
      bytes: Math.round(2 * TEX * TEX * 4 * 4 / 3),   // both maps, mip chain included
    };
    detail.uniforms = {
      orFine: { value: detail.fine },
      orCoarse: { value: detail.coarse },
      orTile: { value: new THREE.Vector2(1 / FINE_TILE, 1 / COARSE_TILE) },
      orMid: { value: new THREE.Vector4(midOf(finePx, 0), midOf(finePx, 1),
                                        midOf(coarsePx, 0), midOf(coarsePx, 1)) },
      // Picked so that one standard deviation of each mask lands within a
      // percent or two of a 10% albedo swing — measured, not guessed, because
      // the four recipes have nothing like the same natural contrast.
      orContrast: { value: new THREE.Vector4(0.75, 0.75, 0.70, 0.80).multiplyScalar(contrast) },
      orRelief: { value: new THREE.Vector2(0.42 * relief, 0.30 * relief) },
      orFade: { value: new THREE.Vector2(QUALITY[quality].fade[0], QUALITY[quality].fade[1]) },
      orWarmth: { value: opts.warmth ?? 0.10 },
    };

    const prevCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) prevCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, detail.uniforms);
      let v = shader.vertexShader, f = shader.fragmentShader;
      // <project_vertex> is where `transformed` and `mvPosition` both exist, and
      // <normal_fragment_maps> is the last place three itself writes `normal`.
      if (v.indexOf('#include <project_vertex>') < 0 ||
          f.indexOf('#include <normal_fragment_maps>') < 0) return;
      shader.vertexShader = v
        .replace('#include <common>', `#include <common>\n${V_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${V_MAIN}`);
      shader.fragmentShader = f
        .replace('#include <common>', `#include <common>\n${F_PARS}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${F_MAIN}`);
    };
    // Every parameter three hashes into a program key is identical between this
    // material and any other vertex-coloured Lambert in the scene, so without a
    // key of its own the terrain would be handed a shader with none of the
    // injection in it — or worse, hand its own to something else.
    material.customProgramCacheKey = () => 'openroad-terrain-detail';
    material.needsUpdate = true;
  }

  const stats = {
    quality, chunks: 0, triangles: 0, pending: 0,
    viewDistance: (rings[rings.length - 1] + 0.5) * CHUNK,
    nearSpacing: CHUNK / grids[0],
    detail: !!detail,
    textureBytes: detail ? detail.bytes : 0,
  };

  // Scratch, reused for every vertex of every chunk, forever.
  const gs = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', grip: 0, roughness: 0, rolling: 0, dust: 0 };
  const rgb = [0, 0, 0], rgb2 = [0, 0, 0];
  let hgrid = new Float32Array(0);   // heights, including the ring outside the chunk
  let mgrid = new Uint8Array(0);     // and their surfaces, for the mud fringe

  const trisFor = (G) => (G + 2) * (G + 2) * 2;

  // =========================================================================
  // Colour
  // =========================================================================

  /**
   * Base colour of a surface at a point, before mottle, creases and occlusion.
   *
   * `crest` is +1 on a convex brow and -1 in a concave hollow; `y` is absolute
   * height, which out in the country is a direct proxy for moisture because the
   * river valley IS the low corridor — it is cut by makeTerrain as a Gaussian
   * trough down to -18 m and nothing else on the map goes anywhere near that.
   */
  function palette(surface, x, z, ny, y, crest, out) {
    if (surface === 'grass') {
      // A slow wet/dry sweep at field scale, pulled toward lush down in the
      // valley and toward straw on the sunlit brows, then bare soil wherever
      // the ground is too steep to hold turf.
      const moist = smoothstep(4, -14, y);
      const dry = clamp(fbm(x * 0.0042, z * 0.0042, tintSeed, 3) * 0.62 + 0.5
                        - moist * 0.50 + crest * 0.22, 0, 1);
      const bare = smoothstep(0.14, 0.55, 1 - ny) * 0.7;
      out[0] = lerp(lerp(LUSH[0], DRY[0], dry), SOIL[0], bare);
      out[1] = lerp(lerp(LUSH[1], DRY[1], dry), SOIL[1], bare);
      out[2] = lerp(lerp(LUSH[2], DRY[2], dry), SOIL[2], bare);
      return;
    }
    const hex = (SURFACES[surface] || SURFACES.grass).colour;
    out[0] = ((hex >> 16) & 255) / 255;
    out[1] = ((hex >> 8) & 255) / 255;
    out[2] = (hex & 255) / 255;
  }

  /**
   * `fine` fades the short-wavelength mottle out on coarse chunks, where a 34 m
   * pattern sampled every 16 m aliases into blotches rather than reading as
   * texture. `roadMix` does the same job for road materials: a street is
   * narrower than a far chunk's vertex spacing, so the stamped asphalt lands on
   * scattered vertices and scatters grey measles over the countryside. Pulling
   * it back toward the ground it sits on costs nothing that matters — the road
   * renderer draws the real carriageway, and at that range there is fog.
   *
   * The crest term is applied to every surface, not just grass: rock and gravel
   * bleach in the sun too, and a hollow is in shadow whatever is lying in it.
   */
  function tint(surface, x, z, ny, y, crest, fine, roadMix, out) {
    palette(surface, x, z, ny, y, crest, out);
    if (roadMix > 0 && PAVED[surface] === 1) {
      palette(terrain.cover(x, z, ny), x, z, ny, y, crest, rgb2);
      out[0] = lerp(out[0], rgb2[0], roadMix);
      out[1] = lerp(out[1], rgb2[1], roadMix);
      out[2] = lerp(out[2], rgb2[2], roadMix);
    }
    const amp = PAVED[surface] === 1 ? 0.06 : 0.17;
    const lum = valueNoise(x * 0.0091, z * 0.0091, tintSeed + 7);
    const mot = fine > 0 ? valueNoise(x * 0.029, z * 0.029, tintSeed + 31) : 0;
    const k = 1 + lum * amp * 0.62 + mot * amp * 0.45 * fine;
    out[0] *= k; out[1] *= k; out[2] *= k;
    if (crest > 0) {
      // Sun-bleached: the pigment washes out toward its own luminance and the
      // whole tone lifts, which is what a season of light does to a brow.
      const g = (out[0] * 0.30 + out[1] * 0.59 + out[2] * 0.11) * 1.14 + 0.045;
      const t = crest * 0.30;
      out[0] = lerp(out[0], g, t); out[1] = lerp(out[1], g, t); out[2] = lerp(out[2], g, t);
    } else {
      const t = 1 + crest * 0.24;
      out[0] *= t; out[1] *= t; out[2] *= t;
    }
  }

  /**
   * Write a vertex's four detail-mask weights as normalised bytes.
   *
   * Grass on ground too steep to hold turf is painted as bare soil by
   * palette(); the masks have to follow it, or the colour says soil while the
   * texture is still growing blades out of it.
   */
  function weigh(surface, ny, o, out) {
    const w = DETAIL[surface] || DETAIL.grass;
    let g = w[0], sa = w[1], gr = w[2], so = w[3];
    if (gr > 0.5) {
      const bare = smoothstep(0.14, 0.55, 1 - ny) * 0.7;
      g = lerp(g, 0.30, bare); gr = lerp(gr, 0.08, bare); so = lerp(so, 0.95, bare);
    }
    out[o] = g * 255; out[o + 1] = sa * 255; out[o + 2] = gr * 255; out[o + 3] = so * 255;
  }

  // =========================================================================
  // Geometry pool
  // =========================================================================
  // Keyed by grid resolution rather than LOD index, because setQuality() changes
  // which resolution a level uses. Every chunk of a given resolution has an
  // identical index buffer, so one is built and shared by all of them.

  const pools = new Map();
  const indices = new Map();

  function indexFor(G) {
    let attr = indices.get(G);
    if (attr) return attr;
    const D = G + 3, n = G + 2;
    const arr = new Uint16Array(n * n * 6);   // 99^2 verts at the finest grid, still Uint16
    let w = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        // (a,b) -> (a,b+1) -> (a+1,b+1) crosses to +Y. Check it by hand before
        // changing it; a flipped ground plane is invisible until it is backfacing.
        const A = a * D + b, B = A + 1, C = A + D + 1, E = A + D;
        arr[w++] = A; arr[w++] = B; arr[w++] = C;
        arr[w++] = A; arr[w++] = C; arr[w++] = E;
      }
    }
    attr = new THREE.BufferAttribute(arr, 1);
    indices.set(G, attr);
    return attr;
  }

  function acquire(G) {
    const pool = pools.get(G);
    if (pool && pool.length) return pool.pop();
    const V = (G + 3) * (G + 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    // Normalised bytes: four weights need a quarter of the bandwidth of four
    // floats, and a mask blend has nothing like 24 bits of meaning in it.
    if (detail) geom.setAttribute('detailWeight', new THREE.BufferAttribute(new Uint8Array(V * 4), 4, true));
    geom.setIndex(indexFor(G));
    geom.boundingSphere = new THREE.Sphere();
    return geom;
  }

  function release(G, geom) {
    // A resolution the current preset no longer asks for would never be popped
    // again, so it goes back to the driver rather than sitting in a pool.
    if (grids.indexOf(G) < 0) { geom.dispose(); return; }
    let pool = pools.get(G);
    if (!pool) pools.set(G, (pool = []));
    pool.push(geom);
  }

  // =========================================================================
  // Chunk fill, resumable
  // =========================================================================
  // Exactly one fill is ever in flight, which is what lets them all share the
  // one scratch height grid. Nothing is shown until the fill completes: a new
  // chunk has no mesh yet, and a chunk changing LOD keeps its old one, so the
  // player never sees a hole where the ground is being rebuilt.

  const job = {
    active: false, rec: null, geom: null,
    G: 0, D: 0, last: 0, step: 0, ox: 0, oz: 0,
    fine: 0, roadMix: 0, aoW: 0, mud: 0, probeR: 0, ringMat: false,
    skirt: 0, row: 0, minY: 0, maxY: 0,
  };

  function beginFill(rec) {
    const G = grids[rec.want], step = CHUNK / G, D = G + 3;
    if (hgrid.length < D * D) { hgrid = new Float32Array(D * D); mgrid = new Uint8Array(D * D); }
    job.active = true; job.rec = rec; job.geom = acquire(G);
    job.G = G; job.D = D; job.last = G + 2; job.step = step;
    job.ox = rec.cx * CHUNK; job.oz = rec.cz * CHUNK;
    job.fine = smoothstep(12, 4, step);
    job.roadMix = smoothstep(4, 13, step) * 0.75;
    job.aoW = smoothstep(11, 3, step) * 0.24;
    job.mud = smoothstep(10, 3, step);
    // The crest/hollow probe reaches a fixed 9 m, except on chunks so coarse
    // that 9 m falls between two vertices — measuring relief the mesh cannot
    // draw only turns it into per-vertex noise.
    job.probeR = Math.max(9, step * 0.9);
    // Sampling the outer ring's MATERIAL as well as its height costs a full
    // ground.sample() instead of a heightAt(), and it is only ever read by the
    // mud fringe, so it is skipped on chunks too coarse to draw one.
    job.ringMat = job.mud > 0;
    job.skirt = Math.max(3, step * 1.25);
    job.row = 0; job.minY = Infinity; job.maxY = -Infinity;
  }

  function cancelFill() {
    if (!job.active) return;
    release(job.G, job.geom);
    job.active = false; job.rec = null; job.geom = null;
  }

  /**
   * Sample rows until the deadline; true when the last row is done. The ring one
   * cell OUTSIDE the chunk is sampled too — those heights are what let the
   * border vertices get the same occlusion treatment as interior ones, so chunk
   * seams do not show up as a faint lattice of unshaded ground, and its
   * materials are what let the mud fringe run across a chunk border unbroken.
   */
  function fillRows(deadline) {
    const D = job.D, last = job.last, step = job.step;
    const ox = job.ox, oz = job.oz, fine = job.fine, roadMix = job.roadMix;
    const probeR = job.probeR, ringMat = job.ringMat;
    const pos = job.geom.attributes.position.array;
    const nrm = job.geom.attributes.normal.array;
    const col = job.geom.attributes.color.array;
    const dtl = detail ? job.geom.attributes.detailWeight.array : null;
    let minY = job.minY, maxY = job.maxY;
    do {
      const a = job.row;
      const lx = (a - 1) * step, x = ox + lx;
      const rim = a === 0 || a === last;
      for (let b = 0; b <= last; b++) {
        const lz = (b - 1) * step, z = oz + lz;
        const v = a * D + b;
        if (rim || b === 0 || b === last) {
          // Outside the chunk proper: this point exists only to give the border
          // vertices a neighbour, so height and material are all anyone reads.
          if (ringMat) {
            const s = ground.sample(x, z, gs);
            hgrid[v] = s.y; mgrid[v] = MCODE[s.surface] || 0;
          } else {
            hgrid[v] = ground.heightAt(x, z); mgrid[v] = 0;
          }
          continue;
        }
        const s = ground.sample(x, z, gs);
        const y = s.y, nx = s.nx, ny = s.ny, nz = s.nz, surface = s.surface;
        hgrid[v] = y; mgrid[v] = MCODE[surface] || 0;
        const o = v * 3;
        pos[o] = lx; pos[o + 1] = y; pos[o + 2] = lz;
        // Normals straight from the height field's own gradient. Averaging face
        // normals on a 16 m grid would facet every hill in the countryside.
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;

        // Crest or hollow, from ONE extra height probe taken straight uphill.
        //
        // The normal's horizontal part points downhill, so -(nx,nz) is the way
        // up and |(nx,nz)|/ny is the slope here. Compare that against the mean
        // slope over the next probeR metres: less means the ground is flattening
        // into a brow, more means it is steepening into a gully. Measured this
        // way the answer is a pure function of (x,z), so it cannot disagree
        // across a chunk border the way anything read off the local grid would.
        const hl = Math.hypot(nx, nz);
        let crest = 0;
        if (hl > 1e-5) {
          const inv = 1 / hl;
          const up = ground.heightAt(x - nx * inv * probeR, z - nz * inv * probeR);
          const bend = ((up - y) / probeR - hl / ny) * smoothstep(0, 0.03, hl);
          crest = clamp(-bend * 4.5, -1, 1);
        }

        tint(surface, x, z, ny, y, crest, fine, roadMix, rgb);
        col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2];
        if (dtl) weigh(surface, ny, v * 4, dtl);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      job.row++;
    } while (job.row <= last && clock.now() < deadline);
    job.minY = minY; job.maxY = maxY;
    return job.row > last;
  }

  function endFill() {
    const rec = job.rec, geom = job.geom;
    const D = job.D, last = job.last, step = job.step, skirt = job.skirt;
    const aoW = job.aoW, mudW = job.mud;
    const warmW = aoW * 0.35;
    const pos = geom.attributes.position.array;
    const nrm = geom.attributes.normal.array;
    const col = geom.attributes.color.array;
    const dtl = detail ? geom.attributes.detailWeight.array : null;

    // Creases, then mud, then the colour space.
    //
    // The grid Laplacian is the fine end of the same measurement the uphill
    // probe makes at landform scale: a point sitting below its four neighbours
    // is in a crease and sees less sky. It is normalised by `step` rather than
    // by `step^2` because fractal terrain keeps roughly constant SLOPE across
    // scales, not constant curvature, and it is faded out on coarse chunks
    // where the measurement radius is too wide for the answer to mean anything.
    for (let a = 1; a < last; a++) {
      for (let b = 1; b < last; b++) {
        const v = a * D + b, o = v * 3;
        const lap = hgrid[v] * 4 - hgrid[v - D] - hgrid[v + D] - hgrid[v - 1] - hgrid[v + 1];
        const k = clamp(lap / (step * 1.6), -1, 1);
        const kk = 1 + k * aoW;
        let r = col[o] * (kk + k * warmW);
        let g = col[o + 1] * kk;
        let b2 = col[o + 2] * (kk - k * warmW);

        // Mud, where a dirt road has been dragged out onto the verge beside it.
        // The eight-neighbourhood rather than four, so the fringe is a band and
        // not a plus sign, and only ever one vertex wide — which is 1.33 m of
        // world on the chunks the player is standing in and interpolates out to
        // roughly twice that.
        if (mudW > 0) {
          const takes = TAKES_MUD[mgrid[v]];
          if (takes > 0) {
            const n = MUDDY[mgrid[v - 1]] + MUDDY[mgrid[v + 1]] +
                      MUDDY[mgrid[v - D]] + MUDDY[mgrid[v + D]] +
                      MUDDY[mgrid[v - D - 1]] + MUDDY[mgrid[v - D + 1]] +
                      MUDDY[mgrid[v + D - 1]] + MUDDY[mgrid[v + D + 1]];
            if (n > 0) {
              const t = Math.min(1, n * 0.42) * mudW * takes;
              r = lerp(r, MUD[0], t); g = lerp(g, MUD[1], t); b2 = lerp(b2, MUD[2], t);
              if (dtl) {
                const o4 = v * 4;
                const so = t * 240;
                if (dtl[o4 + 3] < so) dtl[o4 + 3] = so;
                dtl[o4 + 2] *= 1 - t * 0.8;
              }
            }
          }
        }

        if (managed) { r = toLinear(r); g = toLinear(g); b2 = toLinear(b2); }
        col[o] = r; col[o + 1] = g; col[o + 2] = b2;
      }
    }

    // The skirt: outer ring clamped back onto the border and dropped, so a
    // neighbour at a coarser LOD has something to hide its crack behind.
    for (let a = 0; a <= last; a++) {
      const rim = a === 0 || a === last;
      const ca = a === 0 ? 1 : a === last ? last - 1 : a;
      for (let b = 0; b <= last; b++) {
        if (!rim && b !== 0 && b !== last) continue;
        const cb = b === 0 ? 1 : b === last ? last - 1 : b;
        const src = (ca * D + cb) * 3, dst = (a * D + b) * 3;
        pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - skirt; pos[dst + 2] = pos[src + 2];
        nrm[dst] = nrm[src]; nrm[dst + 1] = nrm[src + 1]; nrm[dst + 2] = nrm[src + 2];
        col[dst] = col[src]; col[dst + 1] = col[src + 1]; col[dst + 2] = col[src + 2];
        if (dtl) {
          const s4 = (ca * D + cb) * 4, d4 = (a * D + b) * 4;
          dtl[d4] = dtl[s4]; dtl[d4 + 1] = dtl[s4 + 1];
          dtl[d4 + 2] = dtl[s4 + 2]; dtl[d4 + 3] = dtl[s4 + 3];
        }
      }
    }

    geom.attributes.position.needsUpdate = true;
    geom.attributes.normal.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    if (dtl) geom.attributes.detailWeight.needsUpdate = true;

    // Set by hand rather than computeBoundingSphere(): the extents are already
    // known from the sampling pass, and this runs for every chunk built.
    geom.boundingSphere.center.set(CHUNK * 0.5, (job.minY + job.maxY) * 0.5, CHUNK * 0.5);
    geom.boundingSphere.radius = Math.hypot(CHUNK * 0.7072, (job.maxY - job.minY) * 0.5 + skirt);

    if (rec.mesh) {
      release(rec.grid, rec.mesh.geometry);
      stats.triangles -= trisFor(rec.grid);
      rec.mesh.geometry = geom;
    } else {
      const mesh = new THREE.Mesh(geom, material);
      mesh.position.set(rec.cx * CHUNK, 0, rec.cz * CHUNK);
      mesh.matrixAutoUpdate = false;   // a chunk never moves once placed
      mesh.updateMatrix();
      mesh.castShadow = false;
      rec.mesh = mesh;
      group.add(mesh);
      stats.chunks++;
    }
    // Only the two near rings bother receiving shadows; past ~400 m a cascade
    // has nothing to say and the extra depth pass is pure cost.
    rec.mesh.receiveShadow = shadows && rec.want <= 1;
    rec.grid = job.G;
    stats.triangles += trisFor(job.G);

    job.active = false; job.rec = null; job.geom = null;
  }

  // =========================================================================
  // Streaming
  // =========================================================================

  const chunks = new Map();
  const queue = [];
  let qi = 0;
  let stamp = 0;
  let lastCx = NaN, lastCz = NaN;
  let primed = false;

  const byNear = (a, b) => a.d - b.d;
  const keyOf = (cx, cz) => (cx + 1024) * 4096 + (cz + 1024);

  function levelFor(d) {
    for (let l = 0; l < rings.length; l++) if (d <= rings[l]) return l;
    return -1;
  }

  function drop(rec) {
    if (!rec.mesh) return;
    group.remove(rec.mesh);
    release(rec.grid, rec.mesh.geometry);
    stats.chunks--;
    stats.triangles -= trisFor(rec.grid);
    rec.mesh = null;
  }

  /** Re-plan the whole ring. Runs when the camera changes chunk, not per frame. */
  function replan(ccx, ccz) {
    stamp++;
    queue.length = 0;
    qi = 0;
    const R = rings[rings.length - 1];
    for (let dx = -R; dx <= R; dx++) {
      const ax = dx < 0 ? -dx : dx;
      for (let dz = -R; dz <= R; dz++) {
        const az = dz < 0 ? -dz : dz;
        const d = ax > az ? ax : az;
        const lod = levelFor(d);
        if (lod < 0) continue;
        const cx = ccx + dx, cz = ccz + dz, key = keyOf(cx, cz);
        let rec = chunks.get(key);
        if (rec) { rec.d = d; rec.want = lod; rec.seen = stamp; }
        else chunks.set(key, (rec = { key, cx, cz, d, want: lod, grid: 0, mesh: null, seen: stamp }));
        if (rec.grid !== grids[lod]) queue.push(rec);
      }
    }
    for (const rec of chunks.values()) {
      if (rec.seen !== stamp) { drop(rec); chunks.delete(rec.key); }
    }
    // Nearest first: the ground the player is about to drive onto is worth more
    // than the ground on the horizon, and the horizon is in fog anyway.
    queue.sort(byNear);
    if (job.active && (!chunks.has(job.rec.key) || grids[job.rec.want] !== job.G)) cancelFill();
  }

  function drain(ms) {
    // Most frames have nothing to build. Bailing before touching the clock keeps
    // the steady-state cost of this module at literally nothing.
    if (!job.active && qi >= queue.length) return;
    const deadline = clock.now() + ms;
    for (;;) {
      if (!job.active) {
        let next = null;
        while (qi < queue.length) {
          const rec = queue[qi++];
          if (rec.mesh === null && !chunks.has(rec.key)) continue;   // dropped since queued
          if (rec.grid !== grids[rec.want]) { next = rec; break; }
        }
        if (!next) break;
        beginFill(next);
      }
      if (fillRows(deadline)) endFill();
      if (clock.now() >= deadline) break;
    }
    stats.pending = queue.length - qi + (job.active ? 1 : 0);
  }

  function update(cameraPos, dt) {
    const ccx = Math.floor(cameraPos.x / CHUNK);
    const ccz = Math.floor(cameraPos.z / CHUNK);
    let jumped = false;
    if (ccx !== lastCx || ccz !== lastCz) {
      // More than one chunk in a single update is not driving, it is the map
      // screen putting the car somewhere else, and it invalidates the whole
      // ring rather than a strip of it. Dribbling that out at the streaming
      // budget leaves the player looking at open sky for over a second, so it
      // is rebuilt in one go: there is no frame rate to protect during a jump
      // nobody could have driven. lastCx is NaN before the first update and
      // after setQuality(), and NaN fails both comparisons, which is what keeps
      // those two cases on the ordinary path — a quality change never leaves a
      // hole, because a chunk keeps its old mesh until the new one is ready.
      jumped = Math.abs(ccx - lastCx) > 1 || Math.abs(ccz - lastCz) > 1;
      lastCx = ccx; lastCz = ccz;
      replan(ccx, ccz);
    }
    if (!primed || jumped) {
      // The ring has to exist before the first frame is worth showing, so the
      // opening drain gets a much larger budget. Call update() once from the
      // loading screen and the player never watches the world assemble itself.
      primed = true;
      drain(opts.primeMs ?? 520);
      return;
    }
    // Streaming stutter is exactly what you notice from a moving car, so frames
    // that are already late get less of the budget, not the same amount.
    const step = dt === undefined ? 1 / 60 : dt;
    drain(budgetMs * (step > 0.026 ? 0.4 : step < 0.015 ? 1.5 : 1));
  }

  /** 'low' | 'medium' | 'high', or a 0..1 number so one knob can drive them all. */
  function setQuality(q) {
    const name = preset(q, quality);
    if (name === quality) return;
    quality = name;
    rings = QUALITY[name].rings;
    grids = QUALITY[name].grids;
    budgetMs = opts.budgetMs ?? QUALITY[name].budgetMs;
    stats.quality = name;
    stats.viewDistance = (rings[rings.length - 1] + 0.5) * CHUNK;
    stats.nearSpacing = CHUNK / grids[0];
    // The detail has to fade out inside the ring it is drawn on, or a low
    // preset spends its whole texture budget on ground it then fogs out.
    if (detail) detail.uniforms.orFade.value.set(QUALITY[name].fade[0], QUALITY[name].fade[1]);
    // Pooled geometries at a resolution the new preset never asks for would sit
    // in memory unreachable, so they go back to the driver now.
    for (const [G, pool] of pools) {
      if (grids.indexOf(G) >= 0) continue;
      for (const geom of pool) geom.dispose();
      pools.delete(G);
    }
    lastCx = NaN;   // force a full re-plan on the next update
  }

  function dispose() {
    cancelFill();
    for (const rec of chunks.values()) {
      if (rec.mesh) { group.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh = null; }
    }
    chunks.clear();
    for (const pool of pools.values()) for (const geom of pool) geom.dispose();
    pools.clear();
    indices.clear();
    queue.length = 0;
    qi = 0;
    if (detail) { detail.fine.dispose(); detail.coarse.dispose(); }
    if (ownsMaterial) material.dispose();
    stats.chunks = 0; stats.triangles = 0; stats.pending = 0;
  }

  return { group, update, setQuality, dispose, stats, material };
}
