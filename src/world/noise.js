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
