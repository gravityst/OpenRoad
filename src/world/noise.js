// Deterministic value noise.
//
// Everything in this world — terrain, road jitter, building heights, tree
// placement — comes from here, so a given seed always rebuilds the identical
// world. That matters for two reasons: the headless test harnesses must see the
// same map the browser does, and a player who reloads should not find the city
// rearranged.
//
// Interpolation is quintic (6t^5 - 15t^4 + 10t^3), whose first AND second
// derivatives vanish at the cell boundaries. Cheaper smoothstep leaves a
// curvature discontinuity at every integer coordinate, which a car's suspension
// reads as a washboard every few metres. That exact mistake cost days on the
// last project; it is not repeated here.

const F32 = new Float32Array(1);

export function hash2(ix, iz, seed) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // → [0,1)
  return (h >>> 0) / 4294967296;
}

export function hash1(i, seed) {
  let h = (i | 0) * 2654435761 + (seed | 0) * 40503;
  h = (h ^ (h >>> 15)) * 2246822519;
  h = (h ^ (h >>> 13)) * 3266489917;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function quintic(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [-1,1], C2 continuous. */
export function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const u = quintic(fx), v = quintic(fz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Fractal sum. `lacunarity` 2 and `gain` 0.5 give classic pink-ish terrain. */
export function fbm(x, z, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, z * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — sharper crests, good for the hill spines out in the country. */
export function ridged(x, z, seed, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + o * 7717));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (sum / norm) * 2 - 1;
}

function hash3(ix, iy, iz, seed) {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (iz | 0) * 2147483647 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/**
 * 3D value noise in [-1,1], same quintic fade as the 2D one. Only generation
 * code uses it — boulder shapes are a function of DIRECTION, so a 2D field
 * would put a seam round every rock's equator.
 */
export function valueNoise3(x, y, z, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const u = quintic(x - x0), v = quintic(y - y0), w = quintic(z - z0);
  let acc = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    acc += wt * hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  }
  return acc * 2 - 1;
}

// ---------------------------------------------------------------------------
// Tileable noise, for textures
// ---------------------------------------------------------------------------
// The functions above run on an infinite lattice, and a detail texture has to
// WRAP — a seam every 1.15 m is the one artefact you would see from the
// driver's seat before anything else. These are the same quintic value noise
// and the same hash, with the lattice index taken modulo the period.
//
// The period is per-axis rather than a single number, because a grass blade is
// not round: a lattice that is wide in X and short in Z produces features that
// are long in X and thin in Z, which is the only cheap way to draw something
// blade-shaped out of value noise.

function tileHash(ix, iz, px, pz, seed) {
  ix -= Math.floor(ix / px) * px;
  iz -= Math.floor(iz / pz) * pz;
  return hash2(ix, iz, seed);
}

/** Wrapping value noise in [-1,1] with integer periods px, pz. */
export function tileNoise(x, z, px, pz, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const u = quintic(x - x0), v = quintic(z - z0);
  const a = tileHash(x0, z0, px, pz, seed), b = tileHash(x0 + 1, z0, px, pz, seed);
  const c = tileHash(x0, z0 + 1, px, pz, seed), d = tileHash(x0 + 1, z0 + 1, px, pz, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Fractal sum in [-1,1]. Periods must be integers; every octave doubles them. */
export function tileFbm(x, z, px, pz, seed, octaves) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(x * f, z * f, px * f, pz * f, seed + o * 1013) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

/**
 * Worley cells, wrapped the same way. d1/d2 give the distance to the nearest
 * and second-nearest feature point; d2 - d1 is small only on the boundary
 * between two cells, which is what draws the dark gap between two gravel chips
 * or the crack between two dried clods. `tone` is the winning cell's own
 * brightness, so no two chips are the same shade.
 */
export function tileCells(x, z, p, seed, out) {
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

/** Small, fast, seedable PRNG for one-shot generation decisions. */
export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Keeps float math identical between Node and the browser for the harnesses.
export function f32(v) { F32[0] = v; return F32[0]; }
