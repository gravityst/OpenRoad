// Sky, sun, weather and the day/night cycle.
//
// WHY THIS IS AN ATMOSPHERE MODEL AND NOT A GRADIENT
//
// The previous project's sky was a vertical colour ramp with a sprite stuck on
// it for the sun, and it read as grey mush at every hour that was not exactly
// noon. The reason is structural, not a matter of picking better colours: what
// makes a sky look like a sky is that the colour in any direction is sunlight
// filtered by however much air it crossed before it scattered toward the eye,
// and that depends on TWO angles — where you are looking and where the sun is.
// A one-dimensional ramp cannot encode a two-dimensional function, so no amount
// of tuning the ramp gets there.
//
// So the sky here is a small single-scattering atmosphere, evaluated per pixel:
//
//   * Rayleigh extinction with the real coefficients, (5.8, 13.5, 33.1)e-6 /m
//     over an 8 km scale height. Blue is scattered 5.7x more strongly than red.
//     That, and nothing else, is why noon is blue overhead.
//   * Mie extinction for haze, near-grey and strongly forward-scattering, which
//     is what puts the white aureole around the sun and the pale band along the
//     horizon. Weather drives its strength.
//   * A spherical-shell air mass, so a horizon ray crosses 38x the air a zenith
//     ray does and the sun's own light crosses the same on its way in. That is
//     why sunset is orange, and it is derived, not authored.
//
// Two departures from textbook single scattering, both because single
// scattering alone is visibly wrong and both marked in the code:
//
//   * The sun path used for a given pixel shortens as the view direction rises.
//     Light scattered toward you from high overhead was scattered high in the
//     atmosphere, where the sun's slant path is still short; light from near the
//     horizon was scattered down at ground level after the full reddened
//     crossing. Using one sun path for the whole sky turns everything the same
//     shade of orange at sunset instead of leaving the zenith deep blue.
//   * A multiple-scattering term. Single scattering drives green to zero at
//     sunset and makes the sky snap to black the instant the sun sets. The
//     extra term is what gives twilight its blue-to-violet gradient.
//
// EVERYTHING ELSE HANGS OFF THE SAME MODEL
//
// Fog colour, sun light colour, hemisphere light colours and cloud shading are
// all read out of this one model rather than authored separately, because the
// moment they are authored separately they disagree, and disagreement at the
// horizon is exactly where the terrain streaming boundary shows. `skyRadiance`
// below is the CPU copy of the shader, and it is what the fog is sampled from.
//
// COORDINATE CONVENTION
//
//   forward = -Z   right = +X   up = +Y.  X is east, Z is south (world/layout.js),
//   so north is -Z. The solar azimuth code depends on that and says so.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../world/noise.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// The atmosphere, in JavaScript
//
// This is a transliteration of the GLSL in SKY_FRAG below, kept in step by
// hand. It exists because the fog colour has to be the same colour the sky
// shader produces at the horizon — sampling it any other way guarantees a seam
// there — and because reading a pixel back off the GPU to find that out would
// cost a stall every frame.
// ---------------------------------------------------------------------------

// Zenith optical depth at (680, 550, 440) nm: beta * scale height.
const BETA_R = [0.0465, 0.1082, 0.2650];
// Mie is nearly grey; the small tilt is the usual lambda^-0.8 haze slope.
const BETA_M = [0.0050, 0.0054, 0.0058];
const MIE_G = 0.76;          // Henyey-Greenstein asymmetry: strongly forward
const ATMO_R = 758.0;        // Earth radius / atmospheric scale height
// Very long sun paths are softened toward this knee. Untouched, the sunset sky
// loses green entirely and goes a flat monochrome red.
const SUN_PATH_KNEE = 34.0;
// Above this, a straight-up view stops seeing any extra sun path at all.
const HIGH_PATH = 2.2;
// Multiple scattering is bluish-white; it is what survives after the direct
// beam has been reddened away.
const MS_TINT = [0.19, 0.33, 0.62];

/**
 * Air mass along a ray leaving the ground at cos(zenith angle) `cosZ`, in units
 * of the zenith path. Exact for a uniform shell, so unlike the usual
 * Kasten-Young fit it stays finite, monotonic and sensible below the horizon —
 * which matters, because that is precisely where the sun spends the evening.
 */
function airMass(cosZ) {
  const s2 = Math.max(0, 1 - cosZ * cosZ);
  return Math.sqrt((ATMO_R + 1) * (ATMO_R + 1) - ATMO_R * ATMO_R * s2) - ATMO_R * cosZ;
}

/**
 * In-scattered sky radiance looking along (dx,dy,dz) with the sun at
 * (sx,sy,sz), written into `out` as LINEAR RGB. Both vectors must be unit
 * length. Allocation-free; `out` may be a THREE.Color or any {r,g,b}.
 *
 * `ms` is the multiple-scattering level, 0 at night and around 0.55 in full
 * daylight. Callers get it from the sky's own state so the CPU and GPU agree.
 */
export function skyRadiance(out, dx, dy, dz, sx, sy, sz, turbidity, sunI, ms) {
  const mu = dx * sx + dy * sy + dz * sz;
  const g = MIE_G;
  const phaseR = 0.75 * (1 + mu * mu);                       // 4pi * 3/(16pi)
  const hg = Math.max(1e-4, 1 + g * g - 2 * g * mu);
  const phaseM = (1 - g * g) / (hg * Math.sqrt(hg));         // 4pi * HG/(4pi)

  const viewMass = airMass(dy);
  const rawSun = airMass(sy);
  const softSun = rawSun / (1 + rawSun / SUN_PATH_KNEE);
  const lift = clamp(dy, 0, 1);
  const sunPath = lerp(softSun, Math.min(softSun, HIGH_PATH), lift * lift);
  const msLift = 0.35 + 0.65 * lift;

  for (let c = 0; c < 3; c++) {
    const bR = BETA_R[c];
    const bM = BETA_M[c] * turbidity;
    const total = bR + bM;
    const trans = 1 - Math.exp(-total * viewMass);           // 1 - view transmittance
    const inScatter = ((bR * phaseR + bM * phaseM) / total) * trans;
    const sunAtten = Math.exp(-total * sunPath);
    const v = sunI * (inScatter * sunAtten + MS_TINT[c] * ms * msLift * trans);
    if (c === 0) out.r = v; else if (c === 1) out.g = v; else out.b = v;
  }
  return out;
}

/**
 * Adds the night sky floor to `out`. It lives next to skyRadiance rather than
 * only in the shader because the fog colour has to include it too: leave it out
 * and distant terrain fades to black under a sky that is visibly not black.
 */
function addNightFloor(out, dy, night) {
  const low = Math.pow(1 - clamp(dy, 0, 1), 5);
  out.r += night * (NIGHT_ZENITH[0] + NIGHT_HORIZON[0] * low);
  out.g += night * (NIGHT_ZENITH[1] + NIGHT_HORIZON[1] * low);
  out.b += night * (NIGHT_ZENITH[2] + NIGHT_HORIZON[2] * low);
  return out;
}

/** Direct sunlight transmittance at the sun's elevation, into `out`. */
function sunTransmittance(out, sy, turbidity) {
  const m = airMass(sy);
  const soft = m / (1 + m / SUN_PATH_KNEE);
  out.r = Math.exp(-(BETA_R[0] + BETA_M[0] * turbidity) * soft);
  out.g = Math.exp(-(BETA_R[1] + BETA_M[1] * turbidity) * soft);
  out.b = Math.exp(-(BETA_R[2] + BETA_M[2] * turbidity) * soft);
  return out;
}

// ---------------------------------------------------------------------------
// Weather
//
// Every field is a plain number so that switching weather is a lerp between two
// of these and nothing has to special-case anything. `cover` is a threshold on
// the cloud noise, so LOWER means MORE cloud; `fogNear`/`fogFar` are fractions
// of the draw distance so fog stays sane when the quality tier changes it.
// ---------------------------------------------------------------------------
const WEATHER = {
  clear: {
    turbidity: 1.00, coverHi: 0.74, coverLo: 0.80, opacityHi: 0.50, opacityLo: 0.72,
    shade: 0.50, light: 1.00, ambient: 1.00, rain: 0.00,
    fogNear: 0.30, fogFar: 1.55, fogGrey: 0.00,
  },
  cloudy: {
    turbidity: 1.45, coverHi: 0.60, coverLo: 0.56, opacityHi: 0.65, opacityLo: 0.94,
    shade: 0.72, light: 0.74, ambient: 1.18, rain: 0.00,
    fogNear: 0.22, fogFar: 1.25, fogGrey: 0.16,
  },
  overcast: {
    turbidity: 2.30, coverHi: 0.42, coverLo: 0.22, opacityHi: 0.80, opacityLo: 1.00,
    shade: 0.92, light: 0.28, ambient: 1.45, rain: 0.00,
    fogNear: 0.14, fogFar: 0.95, fogGrey: 0.55,
  },
  rain: {
    turbidity: 2.90, coverHi: 0.36, coverLo: 0.14, opacityHi: 0.85, opacityLo: 1.00,
    shade: 1.00, light: 0.18, ambient: 1.30, rain: 1.00,
    fogNear: 0.08, fogFar: 0.62, fogGrey: 0.70,
  },
  fog: {
    turbidity: 5.20, coverHi: 0.52, coverLo: 0.40, opacityHi: 0.75, opacityLo: 0.95,
    shade: 0.78, light: 0.36, ambient: 1.55, rain: 0.12,
    fogNear: 0.004, fogFar: 0.075, fogGrey: 0.80,
  },
};
const WEATHER_KEYS = Object.keys(WEATHER.clear);

// Night sky floor, also added to the CPU-side samples so the fog matches it.
const NIGHT_ZENITH = [0.006, 0.010, 0.022];
// A dim sodium wash along the horizon. Every city has one, it costs nothing,
// and its absence is what makes a game night look like a switched-off screen.
const NIGHT_HORIZON = [0.038, 0.030, 0.024];

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// A cube, not a sphere, and deliberately: interpolating a vertex position
// across a planar face is exact, so normalize(vDir) in the fragment shader is
// the exact view ray. A sphere would need hundreds of triangles to get as close
// and would still be wrong in between them. gl_Position.z = w pins the whole
// thing to the far plane so the box size can never clip against camera.far.
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunLit;          // direct sunlight transmittance, linear RGB
uniform float uSunI;
uniform float uTurbidity;
uniform float uMs;             // multiple-scattering level, 0 at night

uniform vec3 uMoonDir;
uniform vec3 uMoonRight;       // tangent basis, built on the CPU so the shader
uniform vec3 uMoonUp;          // never has to handle the moon at the zenith
uniform float uMoonBright;

uniform float uNight;          // 0 day, 1 night — drives the night sky floor
uniform float uStars;          // 0 day, 1 full dark — drives stars and moon
uniform float uTime;
uniform mat3 uStarRot;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;

uniform sampler2D uCloud;
uniform vec2 uCamXZ;
uniform vec4 uDrift;           // xy = high deck, zw = low deck
uniform vec2 uCover;           // x = high deck, y = low deck (threshold: low = more)
uniform vec2 uOpacity;
uniform float uShade;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;

uniform vec3 uGroundHaze;

varying vec3 vDir;

const vec3 BETA_R = vec3(0.0465, 0.1082, 0.2650);
const vec3 BETA_M = vec3(0.0050, 0.0054, 0.0058);
const float MIE_G = 0.76;
const float ATMO_R = 758.0;
const float SUN_PATH_KNEE = 34.0;
const float HIGH_PATH = 2.2;
const vec3 MS_TINT = vec3(0.19, 0.33, 0.62);
// Angular radius of the moon disc. Life size is 0.0045 rad, which reads as a
// dot; this is the usual cinematic exaggeration.
const float MOON_R = 0.016;

// Exact for a uniform shell, and unlike the usual Kasten-Young fit it keeps
// growing smoothly once the sun is below the horizon instead of blowing up.
float airMass(float cosZ) {
  float s2 = max(0.0, 1.0 - cosZ * cosZ);
  return sqrt((ATMO_R + 1.0) * (ATMO_R + 1.0) - ATMO_R * ATMO_R * s2) - ATMO_R * cosZ;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i),                    hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

// Point stars, hashed rather than sampled from a texture. At any equirect
// resolution that fits in memory a star covers several screen pixels and reads
// as a smudge; a hashed lattice keeps them a pixel across at any resolution.
// The fwidth term sizes them to the pixel footprint, which is what stops them
// boiling into a shimmering mess when the camera turns — and it is computed
// before any branch, because derivatives inside non-uniform flow are undefined.
float starField(vec3 sd, float t) {
  vec3 p = sd * 260.0;
  float px = max(fwidth(p.x), max(fwidth(p.y), fwidth(p.z)));
  vec3 id = floor(p);
  vec3 gv = p - id - 0.5;
  vec3 h = hash33(id);
  float mag = (h.z - 0.982) / 0.018;
  if (mag <= 0.0) return 0.0;
  float d = length(gv - (h - 0.5) * 0.55);
  float r = max(0.05, px * 0.85);
  float disc = 1.0 - smoothstep(r * 0.15, r, d);
  float twinkle = 0.72 + 0.28 * sin(t * (2.0 + h.x * 5.0) + h.y * 32.0);
  return disc * pow(mag, 2.2) * twinkle;
}

// One cloud deck: x = coverage, y = optical thickness.
vec2 deck(vec2 uv, float cover, float cirrus) {
  vec4 t = texture2D(uCloud, uv);
  float n = mix(t.r, t.b, cirrus) * 0.78 + t.g * 0.22;
  return vec2(smoothstep(cover, cover + 0.15, n), clamp((n - cover) * 2.6, 0.0, 1.0));
}

// Thin edges are lit through, thick cores are not, and the rim facing the sun
// gets a silver lining. Lit and dark colours both come from the atmosphere on
// the CPU, which is why sunset clouds are pink without anyone tinting them.
vec3 shadeDeck(vec2 dens, float mu, vec3 lit, vec3 dark, float shade) {
  vec3 c = mix(lit, dark, dens.y * shade);
  return c + uSunLit * pow(max(mu, 0.0), 10.0) * (1.0 - dens.y) * 0.55;
}

void main() {
  vec3 dir = normalize(vDir);
  float mu = dot(dir, uSunDir);

  // ---- atmosphere ---------------------------------------------------------
  float phaseR = 0.75 * (1.0 + mu * mu);
  float hg = max(1e-4, 1.0 + MIE_G * MIE_G - 2.0 * MIE_G * mu);
  float phaseM = (1.0 - MIE_G * MIE_G) / (hg * sqrt(hg));

  vec3 betaM = BETA_M * uTurbidity;
  vec3 total = BETA_R + betaM;

  float rawSun = airMass(uSunDir.y);
  float softSun = rawSun / (1.0 + rawSun / SUN_PATH_KNEE);
  float lift = clamp(dir.y, 0.0, 1.0);
  // Scattering along a steep ray happens high up, where the sun's slant path is
  // still short; along a shallow ray it happens at ground level, at the end of
  // the full reddened crossing. One sun path for the whole sky would turn
  // sunset uniformly orange instead of leaving the zenith blue.
  float sunPath = mix(softSun, min(softSun, HIGH_PATH), lift * lift);

  vec3 trans = 1.0 - exp(-total * airMass(dir.y));
  vec3 inScatter = ((BETA_R * phaseR + betaM * phaseM) / total) * trans;
  vec3 sunAtten = exp(-total * sunPath);
  vec3 col = uSunI * (inScatter * sunAtten + MS_TINT * uMs * (0.35 + 0.65 * lift) * trans);

  // ---- night floor, stars, milky way, moon --------------------------------
  if (uNight > 0.002) {
    col += uNight * (uNightZenith + uNightHorizon * pow(1.0 - lift, 5.0));
  }
  if (uStars > 0.004) {
    vec3 sd = uStarRot * dir;
    // A band around a galactic plane fixed in star space, so it wheels with the
    // rest of the sky through the night. Three octaves of noise give it dust
    // lanes; the mask keeps that cost off the other 85% of the sky.
    float band = 1.0 - abs(dot(sd, vec3(0.3612, 0.8428, -0.3984)));
    float milky = pow(max(band, 0.0), 18.0);
    if (milky > 0.004) {
      float n = vnoise3(sd * 7.0) * 0.6 + vnoise3(sd * 17.0) * 0.28 + vnoise3(sd * 41.0) * 0.12;
      milky *= smoothstep(0.34, 0.78, n);
      col += vec3(0.055, 0.058, 0.078) * milky * uStars;
    }
    float s = starField(sd, uTime);
    // Cool for the many faint ones, warmer for the few bright ones, which is
    // roughly what the real magnitude/colour distribution looks like.
    col += mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.92, 0.78), s * 0.5) * s * uStars;

    float mAng = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
    col += vec3(0.62, 0.66, 0.78) * exp(-mAng * 26.0) * 0.09 * uMoonBright * uStars;
    if (mAng < MOON_R * 1.3) {
      // Reconstruct the sphere normal from the offset inside the disc. One
      // sqrt, and the terminator then tracks the real sun direction, so the
      // phase is right at every hour without anyone authoring a moon texture.
      vec3 rel = dir - uMoonDir * dot(dir, uMoonDir);
      float a = dot(rel, uMoonRight) / MOON_R;
      float b = dot(rel, uMoonUp) / MOON_R;
      float r2 = a * a + b * b;
      if (r2 < 1.0) {
        vec3 n = uMoonRight * a + uMoonUp * b - uMoonDir * sqrt(1.0 - r2);
        float lam = pow(max(dot(n, uSunDir), 0.0), 0.55);
        float maria = 0.68 + 0.32 * smoothstep(0.40, 0.62, vnoise3(n * 3.4));
        float edge = 1.0 - smoothstep(0.86, 1.0, r2);
        col += vec3(1.0, 0.97, 0.90) * lam * maria * edge * uMoonBright * uStars;
      }
    }
  }

  // ---- sun disc and aureole ----------------------------------------------
  // Both are multiplied by the sun's own transmittance, so the disc reddens and
  // then extinguishes itself as it sets. Nothing switches it off by hand.
  float ang = acos(clamp(mu, -1.0, 1.0));
  vec3 sunCol = uSunLit * uSunI;
  col += sunCol * (1.0 - smoothstep(0.0107, 0.0143, ang)) * 9.0;
  col += sunCol * (exp(-ang * 22.0) * 0.42 + exp(-ang * 3.2) * 0.07);

  // ---- cloud decks --------------------------------------------------------
  // Intersecting the view ray with a flat deck, rather than draping a texture
  // on a dome, is what makes the puffs converge toward the horizon the way a
  // real cloud deck does. A dome hangs the same-sized puff overhead and at the
  // horizon and reads as a painted ceiling.
  //
  // Sampled unconditionally rather than behind a visibility test: a
  // texture2D in non-uniform control flow has undefined derivatives, so the
  // mip level the far deck depends on would be garbage. The fade is a
  // multiply. High deck first — it is above the low one, so it is behind it.
  float above = smoothstep(0.02, 0.075, dir.y);
  float ray = 1.0 / max(dir.y, 0.012);
  vec2 hi = deck((uCamXZ + dir.xz * (3400.0 * ray)) / 6500.0 + uDrift.xy, uCover.x, 1.0);
  col = mix(col, shadeDeck(hi, mu, uCloudLit * 1.14, uCloudDark * 1.3, uShade * 0.55),
            hi.x * uOpacity.x * above);

  vec2 lo = deck((uCamXZ + dir.xz * (950.0 * ray)) / 2200.0 + uDrift.zw, uCover.y, 0.0);
  col = mix(col, shadeDeck(lo, mu, uCloudLit, uCloudDark, uShade),
            lo.x * uOpacity.y * above);

  // Below the horizon the sky becomes the fog colour, so that wherever the
  // terrain runs out the seam is between two identical colours.
  col = mix(col, uGroundHaze, 1.0 - smoothstep(-0.05, 0.035, dir.y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Cloud noise texture
//
// Tiling matters more than resolution here: the deck stretches to the horizon,
// so the texture repeats dozens of times and any seam becomes a visible grid.
// The lattice is therefore wrapped per octave, per axis.
// ---------------------------------------------------------------------------

function periodicHash(ix, iz, px, pz, seed) {
  const x = ((ix % px) + px) % px;
  const z = ((iz % pz) + pz) % pz;
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function periodicNoise(x, z, px, pz, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = periodicHash(x0, z0, px, pz, seed);
  const b = periodicHash(x0 + 1, z0, px, pz, seed);
  const c = periodicHash(x0, z0 + 1, px, pz, seed);
  const d = periodicHash(x0 + 1, z0 + 1, px, pz, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function periodicFbm(u, v, px, pz, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, fx = px, fz = pz;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u * fx, v * fz, fx, fz, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2; fz *= 2;
  }
  return sum / norm;
}

function makeCloudTexture(size, seed, anisotropy) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;
  const n = size * size;
  const field = new Float32Array(n * 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  for (let j = 0, p = 0; j < size; j++) {
    const v = j * inv;
    for (let k = 0; k < size; k++, p += 3) {
      const u = k * inv;
      // R: the cumulus coverage field. G: high-frequency detail that erodes the
      // edges, so thresholding R gives ragged clouds instead of smooth blobs.
      // B: a separate field stretched across the wind, which is what makes the
      // high deck read as sheared cirrus rather than more cumulus.
      field[p] = periodicFbm(u, v, 4, 4, 6, seed);
      field[p + 1] = periodicFbm(u, v, 13, 13, 5, seed + 7717);
      field[p + 2] = periodicFbm(u, v, 3, 14, 5, seed + 4409);
      for (let c = 0; c < 3; c++) {
        const x = field[p + c];
        if (x < lo[c]) lo[c] = x;
        if (x > hi[c]) hi[c] = x;
      }
    }
  }

  // Stretch each channel to fill 0..1. A summed-octave fbm clusters hard around
  // its mean, so without this a coverage threshold of 0.8 selects nothing at
  // all and one of 0.2 selects everything — the weather presets would have no
  // usable range to work in.
  const scale = [255 / (hi[0] - lo[0]), 255 / (hi[1] - lo[1]), 255 / (hi[2] - lo[2])];
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
    data[q] = (field[p] - lo[0]) * scale[0];
    data[q + 1] = (field[p + 1] - lo[1]) * scale[1];
    data[q + 2] = (field[p + 2] - lo[2]) * scale[2];
    data[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  // Noise, not colour. Letting three sRGB-decode it would bend the coverage
  // threshold into the wrong part of the curve.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Scratch — every one of these exists so that update() allocates nothing. A
// single Vector3 born in a per-frame path is enough to hand the collector a
// sawtooth and the player a stutter every few seconds.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _zenith = { r: 0, g: 0, b: 0 };
const _horizon = { r: 0, g: 0, b: 0 };
const _trans = { r: 0, g: 0, b: 0 };
const UP = new THREE.Vector3(0, 1, 0);
// Fallback basis reference for the two moments a year the sun or moon passes
// close enough to the zenith that cross(up, dir) degenerates.
const ALT_UP = new THREE.Vector3(0, 0, 1);

/**
 * Altitude and azimuth of a body at hour `hours`, written into `out` as a unit
 * direction. Azimuth is measured from north increasing toward east, then mapped
 * with north = -Z and east = +X per the world's convention. Returns altitude in
 * radians.
 */
function celestialDir(out, hours, latRad, decRad, lagHours) {
  const H = ((hours - lagHours - 12) / 24) * TAU;
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
  const sinAlt = clamp(sinLat * sinDec + cosLat * cosDec * Math.cos(H), -1, 1);
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.cos(alt);
  const denom = cosAlt * cosLat;
  const cosAz = denom > 1e-6 ? clamp((sinDec - sinAlt * sinLat) / denom, -1, 1) : -1;
  const az = Math.sin(H) > 0 ? TAU - Math.acos(cosAz) : Math.acos(cosAz);
  out.set(cosAlt * Math.sin(az), sinAlt, -cosAlt * Math.cos(az));
  return alt;
}

// ---------------------------------------------------------------------------

export function createSky(scene, renderer, opts = {}) {
  const latRad = (opts.latitude ?? 36) * DEG;
  const decRad = (opts.declination ?? 12) * DEG;
  // Eleven hours behind the sun: a waxing gibbous that rises about an hour
  // before sunset and is up all night, which is the only phase that actually
  // lights a night drive, while still showing enough terminator to prove the
  // phase is being computed rather than painted.
  const moonLag = opts.moonLag ?? 11.0;
  const moonDec = -(opts.declination ?? 12) * DEG;

  const skyBrightness = opts.skyBrightness ?? 3.0;
  const sunPeak = opts.sunIntensity ?? 3.2;
  const moonPeak = opts.moonIntensity ?? 0.16;
  const hemiPeak = opts.ambientIntensity ?? 1.15;
  const shadowRadius = opts.shadowRadius ?? 110;
  const shadowSize = opts.shadowMapSize ?? 2048;
  const sunDistance = opts.sunDistance ?? shadowRadius * 3;
  const windX = opts.windX ?? 0.82;
  const windZ = opts.windZ ?? 0.57;
  // 0 means the clock is frozen and main.js drives it with setTime().
  let dayLength = opts.dayLength ?? 0;
  let drawDistance = opts.drawDistance ?? 3200;

  const cloudTex = makeCloudTexture(
    opts.cloudTexSize ?? 512,
    opts.seed ?? 1337,
    renderer && renderer.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1,
  );

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunLit: { value: new THREE.Vector3(1, 1, 1) },
    uSunI: { value: skyBrightness },
    uTurbidity: { value: 1 },
    uMs: { value: 0.55 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
    uMoonUp: { value: new THREE.Vector3(0, 0, 1) },
    uMoonBright: { value: 1 },
    uNight: { value: 0 },
    uStars: { value: 0 },
    uTime: { value: 0 },
    uStarRot: { value: new THREE.Matrix3() },
    uNightZenith: { value: new THREE.Vector3().fromArray(NIGHT_ZENITH) },
    uNightHorizon: { value: new THREE.Vector3().fromArray(NIGHT_HORIZON) },
    uCloud: { value: cloudTex },
    uCamXZ: { value: new THREE.Vector2() },
    uDrift: { value: new THREE.Vector4() },
    uCover: { value: new THREE.Vector2(0.74, 0.80) },
    uOpacity: { value: new THREE.Vector2(0.5, 0.72) },
    uShade: { value: 0.5 },
    uCloudLit: { value: new THREE.Vector3(1, 1, 1) },
    uCloudDark: { value: new THREE.Vector3(0.3, 0.32, 0.36) },
    uGroundHaze: { value: new THREE.Vector3(0.5, 0.6, 0.7) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const geometry = new THREE.BoxGeometry(20, 20, 20);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);

  // ---- lights -------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, sunPeak);
  sun.castShadow = opts.shadows !== false;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -shadowRadius; sc.right = shadowRadius;
  sc.top = shadowRadius; sc.bottom = -shadowRadius;
  sc.near = 1; sc.far = sunDistance + shadowRadius * 2;
  sc.updateProjectionMatrix();
  sun.shadow.bias = opts.shadowBias ?? -0.0004;
  sun.shadow.normalBias = opts.shadowNormalBias ?? 0.08;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x8fb4dd, 0x4a4436, hemiPeak);
  scene.add(hemi);

  // ---- fog ----------------------------------------------------------------
  // Reuse whatever linear fog the engine already made, so anything holding a
  // reference to it keeps working; only build one if there is nothing usable.
  const createdFog = !(scene.fog && scene.fog.isFog);
  if (createdFog) scene.fog = new THREE.Fog(0x9dc0da, 900, drawDistance * 1.55);

  // ---- weather blending ---------------------------------------------------
  // Three copies: where we came from, where we are going, and the interpolated
  // values the frame actually uses. Setting a new weather snapshots `now` into
  // `from`, so interrupting a transition never snaps.
  const from = { ...WEATHER.clear };
  const to = { ...WEATHER.clear };
  const now = { ...WEATHER.clear };
  let blendT = 1, blendLen = 1;
  let weatherName = opts.weather && WEATHER[opts.weather] ? opts.weather : 'clear';
  Object.assign(from, WEATHER[weatherName]);
  Object.assign(to, WEATHER[weatherName]);
  Object.assign(now, WEATHER[weatherName]);

  let hours = opts.hours ?? 10;
  let elapsed = 0;
  let driftX0 = 0, driftY0 = 0, driftX1 = 0, driftY1 = 0;
  let fogX = 0, fogZ = -1;

  const state = {
    nightFactor: 0,
    fogColour: new THREE.Color(),
    sunDir: new THREE.Vector3(0, 1, 0),
    rainIntensity: 0,
    // Extras, for anyone who needs them: headlights, wipers, street lamps,
    // particle tinting, the minimap.
    moonDir: new THREE.Vector3(),
    sunElevation: 0,
    moonElevation: 0,
    daylight: 0,
    turbidity: 1,
    hours,
    weather: weatherName,
    zenithColour: new THREE.Color(),
    horizonColour: new THREE.Color(),
    sunLightColour: new THREE.Color(),
  };

  function setTime(h) {
    hours = ((h % 24) + 24) % 24;
    state.hours = hours;
  }

  function setWeather(name, blendSeconds = 8) {
    if (!WEATHER[name]) return weatherName;
    for (let i = 0; i < WEATHER_KEYS.length; i++) from[WEATHER_KEYS[i]] = now[WEATHER_KEYS[i]];
    Object.assign(to, WEATHER[name]);
    blendLen = Math.max(0.001, blendSeconds);
    blendT = blendSeconds <= 0 ? 1 : 0;
    weatherName = name;
    state.weather = name;
    return name;
  }

  function setDrawDistance(metres) {
    drawDistance = Math.max(200, metres);
  }
  function setTimeScale(secondsPerDay) {
    dayLength = Math.max(0, secondsPerDay);
  }

  function update(dt, cameraPos, cameraDir) {
    const step = Math.min(0.1, Math.max(0, dt));
    elapsed += step;
    if (dayLength > 0) setTime(hours + (step * 24) / dayLength);

    // ---- weather blend ----------------------------------------------------
    if (blendT < 1) blendT = Math.min(1, blendT + step / blendLen);
    const w = blendT * blendT * (3 - 2 * blendT);
    for (let i = 0; i < WEATHER_KEYS.length; i++) {
      const k = WEATHER_KEYS[i];
      now[k] = from[k] + (to[k] - from[k]) * w;
    }

    // ---- sun and moon -----------------------------------------------------
    const sunAlt = celestialDir(state.sunDir, hours, latRad, decRad, 0);
    const moonAlt = celestialDir(state.moonDir, hours, latRad, moonDec, moonLag);
    const sy = state.sunDir.y;
    state.sunElevation = sunAlt;
    state.moonElevation = moonAlt;

    // Twilight windows. `night` is the general "it is dark" number the rest of
    // the game reads; `stars` lags it, because stars appear well after the sky
    // stops being blue.
    const night = 1 - smoothstep(-0.12, 0.06, sy);
    const stars = 1 - smoothstep(-0.20, -0.02, sy);
    const daylight = smoothstep(-0.09, 0.30, sy);
    state.nightFactor = night;
    state.daylight = daylight;
    state.rainIntensity = now.rain;
    state.turbidity = now.turbidity;

    const ms = smoothstep(-0.16, 0.20, sy) * 0.55;
    sunTransmittance(_trans, sy, now.turbidity);

    uniforms.uSunDir.value.copy(state.sunDir);
    uniforms.uSunLit.value.set(_trans.r, _trans.g, _trans.b);
    uniforms.uTurbidity.value = now.turbidity;
    uniforms.uMs.value = ms;
    uniforms.uNight.value = night;
    uniforms.uStars.value = stars;
    uniforms.uTime.value = elapsed;
    uniforms.uMoonDir.value.copy(state.moonDir);
    uniforms.uMoonBright.value = smoothstep(-0.06, 0.10, state.moonDir.y);

    // Moon tangent basis on the CPU: the shader would otherwise need a
    // degenerate-cross guard for the nights the moon passes near the zenith.
    _right.crossVectors(Math.abs(state.moonDir.y) > 0.99 ? ALT_UP : UP, state.moonDir).normalize();
    _up.crossVectors(state.moonDir, _right);
    uniforms.uMoonRight.value.copy(_right);
    uniforms.uMoonUp.value.copy(_up);

    // Stars wheel about the celestial pole, which sits due north at an altitude
    // equal to the latitude. 15 degrees an hour, the same clock as the sun.
    _axis.set(0, Math.sin(latRad), -Math.cos(latRad)).normalize();
    _m4.makeRotationAxis(_axis, (hours / 24) * TAU);
    uniforms.uStarRot.value.setFromMatrix4(_m4);

    // ---- clouds -----------------------------------------------------------
    driftX0 += windX * step * 0.0016;
    driftY0 += windZ * step * 0.0016;
    driftX1 += windX * step * 0.0009;
    driftY1 += windZ * step * 0.0009;
    uniforms.uDrift.value.set(driftX0, driftY0, driftX1, driftY1);
    uniforms.uCover.value.set(now.coverHi, now.coverLo);
    uniforms.uOpacity.value.set(now.opacityHi, now.opacityLo);
    uniforms.uShade.value = now.shade;
    if (cameraPos) uniforms.uCamXZ.value.set(cameraPos.x, cameraPos.z);

    // ---- colours read back out of the same model --------------------------
    skyRadiance(_zenith, 0, 1, 0, state.sunDir.x, sy, state.sunDir.z,
      now.turbidity, skyBrightness, ms);
    addNightFloor(_zenith, 1, night);
    // Fog is sampled just above the horizon along the direction the camera is
    // actually looking, so driving toward a sunset gives orange fog and away
    // from it gives blue — which is what aerial perspective does in life.
    if (cameraDir) {
      const len = Math.hypot(cameraDir.x, cameraDir.z);
      if (len > 1e-4) { fogX = cameraDir.x / len; fogZ = cameraDir.z / len; }
    }
    skyRadiance(_horizon, fogX * 0.9994, 0.035, fogZ * 0.9994,
      state.sunDir.x, sy, state.sunDir.z, now.turbidity, skyBrightness, ms);
    addNightFloor(_horizon, 0.035, night);

    state.zenithColour.setRGB(_zenith.r, _zenith.g, _zenith.b);
    state.horizonColour.setRGB(_horizon.r, _horizon.g, _horizon.b);

    // Cloud tops take direct sun, bases take sky. Both from the atmosphere
    // above, which is the whole reason sunset clouds come out pink.
    const litGain = 2.1 * lerp(0.35, 1, daylight) + 0.10;
    uniforms.uCloudLit.value.set(
      _trans.r * litGain + _zenith.r * 0.85,
      _trans.g * litGain + _zenith.g * 0.85,
      _trans.b * litGain + _zenith.b * 0.85,
    );
    const darkGain = lerp(0.75, 0.42, now.shade);
    uniforms.uCloudDark.value.set(
      (_zenith.r * 0.55 + _horizon.r * 0.35) * darkGain,
      (_zenith.g * 0.55 + _horizon.g * 0.35) * darkGain,
      (_zenith.b * 0.55 + _horizon.b * 0.35) * darkGain,
    );

    // Under cloud the horizon is cloud, not clear sky, so the fog has to drift
    // toward the cloud base or distant terrain glows blue under an overcast.
    const grey = now.fogGrey;
    const cd = uniforms.uCloudDark.value;
    state.fogColour.setRGB(
      lerp(_horizon.r, cd.x * 1.35, grey),
      lerp(_horizon.g, cd.y * 1.35, grey),
      lerp(_horizon.b, cd.z * 1.35, grey),
    );
    uniforms.uGroundHaze.value.set(state.fogColour.r, state.fogColour.g, state.fogColour.b);

    // Re-asserted every frame on purpose: the engine's quality switch also
    // writes fog.far, and weather has to win that argument.
    if (scene.fog && scene.fog.isFog) {
      scene.fog.color.copy(state.fogColour);
      scene.fog.near = drawDistance * now.fogNear;
      scene.fog.far = Math.max(scene.fog.near + 20, drawDistance * now.fogFar);
    }

    // ---- light ------------------------------------------------------------
    // The one directional light follows the sun by day and the moon by night.
    // Both ramps reach zero at the same sun elevation, so the handover happens
    // while the light contributes nothing and cannot be seen.
    const lunar = (1 - smoothstep(-0.20, -0.09, sy)) * smoothstep(-0.03, 0.16, state.moonDir.y);
    const useMoon = sy <= -0.09;
    if (useMoon) {
      _v.copy(state.moonDir);
      sun.intensity = moonPeak * lunar * lerp(1, 0.35, now.fogGrey);
      state.sunLightColour.setRGB(0.55, 0.66, 0.95);
    } else {
      _v.copy(state.sunDir);
      sun.intensity = sunPeak * daylight * now.light;
      // pow(T, 0.3) rather than T itself: the raw transmittance at sunset is so
      // close to monochrome red that every surface in the world turns tomato.
      // The softened version is a warm orange, which is what low sun looks like.
      const r = Math.pow(Math.max(_trans.r, 1e-4), 0.3);
      const g = Math.pow(Math.max(_trans.g, 1e-4), 0.3);
      const b = Math.pow(Math.max(_trans.b, 1e-4), 0.3);
      const m = Math.max(r, 1e-4);
      state.sunLightColour.setRGB(
        0.94 * (r / m) + 0.06,
        0.94 * (g / m) + 0.06,
        0.94 * (b / m) + 0.06,
      );
    }
    sun.color.copy(state.sunLightColour);

    if (cameraPos) {
      mesh.position.copy(cameraPos);

      // Snap the shadow camera to whole shadow-map texels. Without it the map
      // resamples every frame as the car moves and every shadow edge crawls,
      // which at 40 m/s is far more obvious than any amount of aliasing.
      const texel = (2 * shadowRadius) / shadowSize;
      _right.crossVectors(Math.abs(_v.y) > 0.99 ? ALT_UP : UP, _v).normalize();
      _up.crossVectors(_v, _right);
      const a = Math.round(_right.dot(cameraPos) / texel) * texel;
      const b = Math.round(_up.dot(cameraPos) / texel) * texel;
      const c = _v.dot(cameraPos);
      sun.target.position.set(
        _right.x * a + _up.x * b + _v.x * c,
        _right.y * a + _up.y * b + _v.y * c,
        _right.z * a + _up.z * b + _v.z * c,
      );
      sun.position.copy(sun.target.position).addScaledVector(_v, sunDistance);
    }

    // Hemisphere sky is the zenith colour, pulled a third of the way to white:
    // fully saturated ambient makes white cars look painted. Ground is that
    // light bounced off earth, so it tracks the sun's colour, not a fixed brown.
    const zMax = Math.max(_zenith.r, _zenith.g, _zenith.b, 1e-4);
    hemi.skyColor.setRGB(
      lerp(_zenith.r / zMax, 1, 0.34),
      lerp(_zenith.g / zMax, 1, 0.34),
      lerp(_zenith.b / zMax, 1, 0.34),
    );
    hemi.groundColor.setRGB(
      state.sunLightColour.r * 0.30 + 0.06,
      state.sunLightColour.g * 0.27 + 0.06,
      state.sunLightColour.b * 0.21 + 0.07,
    );
    hemi.intensity = hemiPeak * (0.055 + 0.945 * smoothstep(-0.22, 0.16, sy)) * now.ambient;
  }

  function dispose() {
    scene.remove(mesh);
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(hemi);
    geometry.dispose();
    material.dispose();
    cloudTex.dispose();
    sun.dispose();
    if (createdFog) scene.fog = null;
  }

  setWeather(weatherName, 0);
  return {
    sun, hemi, state, mesh, material,
    setTime, setWeather, setDrawDistance, setTimeScale, update, dispose,
  };
}
