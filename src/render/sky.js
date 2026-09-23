// Sky, sun, weather, the day/night cycle — and the air between you and
// everything else.
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
//     Using one sun path for the whole sky turns everything the same shade of
//     orange at sunset instead of leaving the zenith deep blue.
//   * A multiple-scattering term. Single scattering drives green to zero at
//     sunset and makes the sky snap to black the instant the sun sets. The
//     extra term is what gives twilight its blue-to-violet gradient.
//
// AERIAL PERSPECTIVE, FOR EVERY MATERIAL IN THE GAME
//
// three's fog is a linear ramp in view depth toward one flat colour. That is
// what made the world look like it was sitting in milk: the whole middle
// distance lost contrast at the same rate, hills a kilometre away were no
// bluer than a barn at a hundred metres, and turning the camera slid the fog
// across the screen, because view depth is not distance. So this module
// replaces three's fog chunks, once, for every material that uses them:
//
//   * Haze is Beer-Lambert, exp(-sigma * distance), with sigma set from the
//     weather's meteorological visibility (Koschmieder: sigma = 3.9 / V). On a
//     clear day a barn at 300 m is hardly touched and a ridge at 900 m is
//     going blue — which is what makes distance READ.
//   * The air thins with height, integrated exactly along each ray, so valleys
//     hold their haze and fog pools in the low ground while hilltops stand
//     clear of it.
//   * Blue is extinguished a little faster than red, so the far hills go blue
//     rather than grey, and the in-scattered light gains a forward lobe around
//     the sun: drive into a low sun and the haze glows gold; turn away and it
//     is blue.
//   * The streamed terrain ends at a ring, so the fog is still forced to total
//     over the last quarter of that ring. main.js ties the ring to
//     setDrawDistance(); the sky below the horizon is drawn in the same haze
//     colour, so where the ground runs out there is nothing to see.
//
// The per-pixel parameters travel in three plain {x,y,z,w} uniform objects
// that are added to three's ShaderLib and are therefore SHARED BY REFERENCE by
// every built-in material that compiles afterwards (three clones ShaderLib
// uniforms per material, but copies plain objects by reference — see
// cloneUniforms). A ShaderMaterial that includes the fog chunks without those
// uniforms reads them as zero and falls back to three's own linear fog, so
// nothing anyone else wrote can break.
//
// CLOUDS
//
// The old decks thresholded plain value noise, which draws thin torn flakes —
// at a noon sky they read as scratches on the lens. Fair-weather cumulus have
// flat grey bases, rounded tops and a bright edge on the side facing the sun.
// The shape here is Perlin-Worley (noise carved by inverted cellular noise, the
// usual trick for billows), and each cloud is lit by stepping two samples
// toward the sun through the same density field: where the cloud gets thinner
// toward the sun it is the lit side, where it gets thicker it is in its own
// shadow. With a forward-scattering phase on top, a backlit cumulus gets its
// silver lining for free.
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
import { activeBiomes, BIOME } from '../world/biomes.js';

// ---------------------------------------------------------------------------
// The air of each biome
//
// Every biome gets its own air, read from where the camera is (the biome
// field in world/biomes.js, through its registry, since this module is built
// before the world is handed to anyone) and eased over a second and a half so
// a teleport never snaps. Turbidity and visibility are scaled rather than the
// fog colour repainted, because both feed the sky shader AND the haze, so the
// horizon cannot come out two colours: the canyon's air is dusty and warm,
// the pass's is thin, blue and clear enough to see the peaks, the coast's
// carries a little sea haze, the autumn woods' is soft. The light is tinted
// on top — warmer in the canyon and the woods, cooler on the snow — and the
// ground bounce follows what the light bounced off: red rock, white snow.
//
//                 turbidity  visibility  sun tint            bounce
//   farmland        1.00       1.00      —                   —
//   canyon          1.45       0.55      warm (1.04,.98,.88)  red
//   pass            0.70       1.35      cold (.93,.98,1.08)  bright
//   coast           1.12       0.80      —                   —
//   autumn          1.10       0.85      gold (1.04,.99,.90)  —
// ---------------------------------------------------------------------------
const BIO_AIR = [
  { turb: 1.00, vis: 1.00, sun: [1.00, 1.00, 1.00], fog: [1.00, 1.00, 1.00], bounce: [1.00, 1.00, 1.00] },
  { turb: 1.45, vis: 0.55, sun: [1.04, 0.98, 0.88], fog: [1.05, 0.99, 0.91], bounce: [1.25, 0.92, 0.74] },
  { turb: 0.70, vis: 1.35, sun: [0.93, 0.98, 1.08], fog: [0.95, 0.99, 1.06], bounce: [1.18, 1.22, 1.30] },
  { turb: 1.12, vis: 0.80, sun: [1.00, 1.00, 1.00], fog: [0.98, 1.01, 1.03], bounce: [1.00, 1.05, 1.08] },
  { turb: 1.10, vis: 0.85, sun: [1.04, 0.99, 0.90], fog: [1.03, 1.00, 0.94], bounce: [1.10, 0.98, 0.85] },
];

// Snow in the air on the pass: a box of flakes that travels with the camera
// and wraps, so a finite set of points is an endless gentle fall. One draw
// call, only while the camera is in the mountains.
const SNOW_VERT = `
uniform float uT;
uniform vec3 uCam;
uniform float uBox;
uniform float uAmt;
uniform float uScale;
varying float vA;
void main() {
  vec3 p = position;
  p.y -= uT * 1.15;
  p.x += uT * 0.55 + sin( uT * 0.9 + position.y * 1.3 ) * 0.45;
  p.z += uT * 0.30 + cos( uT * 0.7 + position.x * 1.1 ) * 0.45;
  p = mod( p - uCam + uBox * 0.5, uBox ) + uCam - uBox * 0.5;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float d = max( -mv.z, 0.5 );
  gl_PointSize = clamp( 0.075 * uScale / d, 1.0, 14.0 );
  vec3 q = abs( p - uCam ) / ( uBox * 0.5 );
  vA = uAmt * ( 1.0 - smoothstep( 0.65, 1.0, max( q.x, max( q.y, q.z ) ) ) ) * smoothstep( 0.6, 2.5, d );
  // Thinner snow shows fewer flakes rather than fainter ones.
  if ( fract( position.x * 7.13 + position.z * 3.71 ) > uAmt ) vA = 0.0;
}
`;
const SNOW_FRAG = `
uniform vec3 uLight;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot( c, c );
  if ( r > 0.25 || vA <= 0.0 ) discard;
  gl_FragColor = vec4( uLight, vA * ( 1.0 - r * 4.0 ) );
}
`;

// Leaves in the air in the autumn woods: the same wrapping box as the snow,
// but a leaf falls slower than a flake, swings side to side as it goes, and
// tumbles — its outline is an ellipse that spins in the view and narrows and
// widens as it turns edge-on and back. Each carries its own colour from the
// canopy's own range (gold, orange, red, and one in six already brown), in
// LINEAR light like the snow. One draw call, only while the camera is in the
// woods.
const LEAF_VERT = `
uniform float uT;
uniform vec3 uCam;
uniform float uBox;
uniform float uAmt;
uniform float uScale;
attribute vec4 leaf;      // colour pick, phase, spin, size
varying float vA;
varying vec3 vC;
varying float vRot;
void main() {
  vec3 p = position;
  float ph = leaf.y * 6.2832;
  p.y -= uT * ( 0.75 + leaf.w * 0.5 );
  p.x += uT * 0.9 + sin( uT * 1.3 + ph ) * 1.4;
  p.z += uT * 0.4 + cos( uT * 0.9 + ph * 1.7 ) * 1.0;
  // The box rides a third of its height above the camera: leaves come
  // down out of the canopy, and half a box below the road is half the
  // leaves spent where nobody can see them.
  vec3 orC = uCam + vec3( 0.0, uBox * 0.3, 0.0 );
  p = mod( p - orC + uBox * 0.5, uBox ) + orC - uBox * 0.5;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float d = max( -mv.z, 0.5 );
  gl_PointSize = clamp( ( 0.17 + leaf.w * 0.11 ) * uScale / d, 1.0, 56.0 );
  vec3 q = abs( p - orC ) / ( uBox * 0.5 );
  vA = ( 1.0 - smoothstep( 0.6, 1.0, max( q.x, max( q.y, q.z ) ) ) ) * smoothstep( 0.8, 2.5, d );
  if ( fract( leaf.x * 13.1 ) > uAmt ) vA = 0.0;
  vRot = uT * ( 1.2 + leaf.z * 3.5 ) + ph;
  vC = leaf.x < 0.30 ? vec3( 0.89, 0.34, 0.012 )
     : leaf.x < 0.62 ? vec3( 0.85, 0.11, 0.006 )
     : leaf.x < 0.84 ? vec3( 0.45, 0.014, 0.004 )
     : vec3( 0.17, 0.052, 0.010 );
}
`;
const LEAF_FRAG = `
uniform vec3 uLight;
varying float vA;
varying vec3 vC;
varying float vRot;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float cs = cos( vRot ), sn = sin( vRot );
  vec2 r = vec2( c.x * cs - c.y * sn, c.x * sn + c.y * cs );
  float w = 0.08 + 0.16 * abs( sin( vRot * 0.7 ) );
  float e = ( r.x * r.x ) / 0.2025 + ( r.y * r.y ) / ( w * w );
  if ( e > 1.0 || vA <= 0.0 ) discard;
  gl_FragColor = vec4( vC * uLight * ( 0.85 + 0.3 * abs( r.y ) / w ), vA );
}
`;

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
// Sun paths longer than this are where single scattering starts to lie, so
// their growth is softened. The softening still has to DIVERGE, or the sun
// never finishes setting.
const SUN_PATH_KNEE = 12.0;
// The sun path seen by the high-altitude air a straight-up view looks through.
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

/** Air mass with long paths compressed. Linear near zero, sqrt-slow far out. */
function softPath(m) {
  return SUN_PATH_KNEE * (Math.sqrt(1 + (2 * m) / SUN_PATH_KNEE) - 1);
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
  const softSun = softPath(airMass(sy));
  const lift = clamp(dy, 0, 1);
  // High air is still in sunlight for a few degrees after ground level has lost
  // it, and that lag IS twilight. So a steep view gets the short, barely
  // reddened sun path — but only in proportion to how much of the column above
  // it is still lit, and that proportion is what has to fall to zero, not the
  // path length. The shortening is keyed on `lift` ALONE: fading it by twilight
  // as well turned the zenith flat grey at a sun elevation of -5 degrees.
  const twilight = smoothstep(-0.26, 0.02, sy);
  const sunPath = lerp(softSun, Math.min(softSun, HIGH_PATH), lift * lift);
  const lit = lerp(1, twilight, lift * lift);
  const msLift = 0.35 + 0.65 * lift;

  for (let c = 0; c < 3; c++) {
    const bR = BETA_R[c];
    const bM = BETA_M[c] * turbidity;
    const total = bR + bM;
    const trans = 1 - Math.exp(-total * viewMass);           // 1 - view transmittance
    const inScatter = ((bR * phaseR + bM * phaseM) / total) * trans;
    const sunAtten = Math.exp(-total * sunPath) * lit;
    // Multiple-scattered light is the same sunlight and reddens with it, just
    // far more gently for having taken many shorter paths.
    const msAtten = Math.pow(sunAtten, 0.18);
    const v = sunI * (inScatter * sunAtten + MS_TINT[c] * ms * msLift * trans * msAtten);
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
  const soft = softPath(airMass(sy));
  out.r = Math.exp(-(BETA_R[0] + BETA_M[0] * turbidity) * soft);
  out.g = Math.exp(-(BETA_R[1] + BETA_M[1] * turbidity) * soft);
  out.b = Math.exp(-(BETA_R[2] + BETA_M[2] * turbidity) * soft);
  return out;
}

// ---------------------------------------------------------------------------
// Aerial perspective, as the fog chunks compute it
//
// A JS copy of FOG_FRAGMENT, for the harness: it is how "the far edge of the
// streamed ring is always hidden" and "a barn at 300 m on a clear day is not
// washed out" are measured without a GPU. Keep the two in step.
// ---------------------------------------------------------------------------

// Blue is extinguished a little faster than red, so the far hills go blue.
const HAZE_TINT = [0.82, 0.93, 1.16];

/**
 * Transmittance of the air between the camera at height `camY` and a point
 * `dist` metres away along a ray whose world direction has vertical component
 * `rayY`. `sigma` is the extinction at `refY`, `invH` one over the haze's scale
 * height. Returns the green-channel transmittance; the ring edge is forced.
 */
export function hazeTransmittance(dist, rayY, camY, sigma, invH, refY, far) {
  const dy = rayY * dist * invH;
  const od = Math.exp(-invH * (camY - refY)) * (Math.abs(dy) > 1e-3 ? (1 - Math.exp(-dy)) / dy : 1 - 0.5 * dy);
  const tau = sigma * dist * od;
  const edge = smoothstep(far * 0.72, far, dist);
  return Math.exp(-tau * HAZE_TINT[1]) * (1 - edge);
}

// ---------------------------------------------------------------------------
// Weather
//
// Every field is a plain number so that switching weather is a lerp between two
// of these and nothing has to special-case anything.
//
//   visibility  metres; the haze extinction is 3.9 / visibility (Koschmieder)
//   hazeH       metres; scale height of the haze. Low for fog, which pools.
//   cumulus     fraction of the sky the low deck covers
//   cirrus      how much high cloud there is, 0..1
//   deckDark    how grey the underside of the low deck is
//   light       direct sun, 1 = clear
//   ambient     skylight, relative to clear
//   fogGrey     how far the horizon haze is pulled toward the cloud base
// ---------------------------------------------------------------------------
const WEATHER = {
  clear: {
    turbidity: 1.00, visibility: 26000, hazeH: 900,
    cumulus: 0.18, cirrus: 0.18, deckDark: 0.42, opacity: 0.94,
    light: 1.00, ambient: 1.00, rain: 0.00, fogGrey: 0.00,
  },
  cloudy: {
    turbidity: 1.45, visibility: 14000, hazeH: 800,
    cumulus: 0.50, cirrus: 0.30, deckDark: 0.55, opacity: 0.97,
    light: 0.80, ambient: 1.08, rain: 0.00, fogGrey: 0.18,
  },
  overcast: {
    turbidity: 2.30, visibility: 7000, hazeH: 700,
    cumulus: 0.96, cirrus: 0.00, deckDark: 0.62, opacity: 1.00,
    light: 0.26, ambient: 1.30, rain: 0.00, fogGrey: 0.60,
  },
  rain: {
    turbidity: 2.90, visibility: 2600, hazeH: 500,
    cumulus: 1.00, cirrus: 0.00, deckDark: 0.80, opacity: 1.00,
    light: 0.14, ambient: 1.10, rain: 1.00, fogGrey: 0.74,
  },
  fog: {
    turbidity: 5.20, visibility: 220, hazeH: 70,
    cumulus: 0.70, cirrus: 0.00, deckDark: 0.55, opacity: 0.85,
    light: 0.40, ambient: 1.35, rain: 0.08, fogGrey: 0.82,
  },
};
const WEATHER_KEYS = Object.keys(WEATHER.clear);

// Night sky floor, also added to the CPU-side samples so the fog matches it.
const NIGHT_ZENITH = [0.006, 0.010, 0.022];
// A dim sodium wash along the horizon. Every town has one, it costs nothing,
// and its absence is what makes a game night look like a switched-off screen.
const NIGHT_HORIZON = [0.038, 0.030, 0.024];

// Shadow map per quality tier. `radius` is PCF softness in texels; the extent
// is the half-width of the square the sun's shadow camera covers, and it is
// pushed forward along the view, because nobody looks at the shadows behind
// the car.
const QUALITY = {
  low:    { size: 1024, radius: 2.0, extent: 80 },
  medium: { size: 2048, radius: 3.0, extent: 105 },
  high:   { size: 4096, radius: 3.5, extent: 130 },
};

// ---------------------------------------------------------------------------
// Aerial perspective shader chunks
// ---------------------------------------------------------------------------

const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif
`;

// mvPosition exists by now in every three vertex shader that includes this.
// vec4 * mat4 is transpose(M) * v, which for the rotation part of a view
// matrix is its inverse: the camera-to-vertex ray, in world axes.
const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
    uniform vec4 orHaze;    // x sigma at refY /m, y 1/scale height, z refY, w enabled
    uniform vec4 orHazeSun; // xyz direction toward the sun, world
    uniform vec4 orHazeGlow;// rgb forward-scattered sun colour in the haze
  #endif
#endif
`;

const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #else
    if ( orHaze.w > 0.5 ) {
      float fogDist = length( vFogRay );
      vec3 fogDir = vFogRay / max( fogDist, 1e-4 );
      // Optical depth through air thinning exponentially with height,
      // integrated exactly along the ray from the camera.
      float fogDy = vFogRay.y * orHaze.y;
      float fogOd = exp( - orHaze.y * ( cameraPosition.y - orHaze.z ) ) *
        ( abs( fogDy ) > 1e-3 ? ( 1.0 - exp( - fogDy ) ) / fogDy : 1.0 - 0.5 * fogDy );
      vec3 fogT = exp( - orHaze.x * fogDist * fogOd * vec3( 0.82, 0.93, 1.16 ) );
      // The streamed ground ends at a ring; it must be gone before it does.
      fogT *= 1.0 - smoothstep( fogFar * 0.72, fogFar, fogDist );
      float fogMu = max( dot( fogDir, orHazeSun.xyz ), 0.0 );
      vec3 fogIn = fogColor + orHazeGlow.rgb * ( 0.16 * fogMu * fogMu + pow( fogMu, 10.0 ) );
      gl_FragColor.rgb = gl_FragColor.rgb * fogT + fogIn * ( 1.0 - fogT );
    } else {
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    }
  #endif
#endif
`;

// The three shared uniform values. Plain objects on purpose — see the header.
const HAZE = { x: 0, y: 1 / 900, z: 0, w: 1 };
const HAZE_SUN = { x: 0, y: 1, z: 0, w: 0 };
const HAZE_GLOW = { x: 0, y: 0, z: 0, w: 0 };
let hazeInstalled = false;

/**
 * Swaps three's fog chunks for the aerial perspective above and adds the
 * shared uniforms to every ShaderLib entry that already carries fog. Must run
 * before the first material compiles, which it does: main.js builds the sky
 * before any other layer and nothing renders until loading ends.
 */
function installHaze() {
  if (hazeInstalled) return;
  hazeInstalled = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms;
    if (!u || !u.fogColor) continue;
    u.orHaze = { value: HAZE };
    u.orHazeSun = { value: HAZE_SUN };
    u.orHazeGlow = { value: HAZE_GLOW };
  }
}

// ---------------------------------------------------------------------------
// Sky shaders
// ---------------------------------------------------------------------------

// A cube, not a sphere, and deliberately: interpolating a vertex position
// across a planar face is exact, so normalize(vDir) in the fragment shader is
// the exact view ray. gl_Position.z = w pins the whole thing to the far plane
// so the box size can never clip against camera.far.
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
uniform vec3 uCam;             // camera position, metres
uniform vec4 uDrift;           // xy = low deck, zw = high deck, in texture units
uniform vec4 uCover;           // x cumulus threshold, y cirrus threshold, z cirrus amount
uniform float uOpacity;
uniform float uDeckDark;
uniform vec3 uCloudSun;        // sunlight on a cloud, linear
uniform vec3 uCloudAmb;        // skylight on a cloud's underside, linear
uniform float uCloudDetail;    // 1 = light the deck, 0 = flat (low tier)

uniform vec3 uHaze;            // horizon haze colour, the same as the fog's
uniform vec3 uHazeGlow;        // its forward-scattered sun lobe

varying vec3 vDir;

const vec3 BETA_R = vec3(0.0465, 0.1082, 0.2650);
const vec3 BETA_M = vec3(0.0050, 0.0054, 0.0058);
const float MIE_G = 0.76;
const float ATMO_R = 758.0;
const float SUN_PATH_KNEE = 12.0;
const float HIGH_PATH = 2.2;
const vec3 MS_TINT = vec3(0.19, 0.33, 0.62);
// Angular radius of the moon disc. Life size is 0.0045 rad, which reads as a
// dot; this is the usual cinematic exaggeration.
const float MOON_R = 0.016;

// The low deck: fair-weather cumulus bases at about 1.4 km, one texture repeat
// every 5.2 km of sky. The high deck is cirrus at 8 km.
const float DECK_LO = 1400.0;
const float REPEAT_LO = 5200.0;
const float DECK_HI = 8000.0;
const float REPEAT_HI = 14000.0;

float airMass(float cosZ) {
  float s2 = max(0.0, 1.0 - cosZ * cosZ);
  return sqrt((ATMO_R + 1.0) * (ATMO_R + 1.0) - ATMO_R * ATMO_R * s2) - ATMO_R * cosZ;
}
float softPath(float m) {
  return SUN_PATH_KNEE * (sqrt(1.0 + 2.0 * m / SUN_PATH_KNEE) - 1.0);
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

// Point stars, hashed rather than sampled from a texture, sized to the pixel
// footprint so they neither smudge nor boil when the camera turns. The fwidth
// is computed before any branch: derivatives in non-uniform flow are undefined.
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

// Cumulus density at a point on the deck. R is the billow shape, A a much
// broader field that gathers the clouds into groups and clear lanes, G the
// fine detail that erodes the thin edges only — so the cores stay round and
// the rims break up, which is the difference between a cloud and a blob.
// \`lo\` is the shape value at which cloud begins, chosen on the CPU from the
// measured distribution of the texture so that the weather's cloud fraction is
// the fraction of sky actually covered.
// Returns density in x and, in y, how far into the cloud this point is — which
// keeps varying where density has saturated, so a full overcast deck still has
// thicker and thinner patches instead of being one flat grey lid.
vec2 cumulus(vec2 uv, float lo) {
  vec4 n = texture2D(uCloud, uv);
  float shape = n.r * 0.74 + n.a * 0.26;
  float d = smoothstep(lo, lo + 0.12, shape);
  // Erode the rim with fine detail at two scales; the second fetch is five
  // times finer, and it is what turns a cut-out into a cauliflower edge.
  float fine = texture2D(uCloud, uv * 5.3 + 0.37).g;
  d = clamp(d - (1.0 - d) * (n.g * 0.8 + fine * 0.6), 0.0, 1.0);
  return vec2(d, clamp((shape - lo) * 1.6 + (n.g - 0.5) * 0.25, 0.0, 1.0));
}
// The same field for the light steps toward the sun, without the fine
// erosion: what those two samples measure is how much cloud the light
// crosses, and a rim's texture does not change that. One fetch, not two.
vec2 cumulusCoarse(vec2 uv, float lo) {
  vec4 n = texture2D(uCloud, uv);
  float shape = n.r * 0.74 + n.a * 0.26;
  float d = clamp(smoothstep(lo, lo + 0.12, shape) * (1.0 - 0.45 * n.g), 0.0, 1.0);
  return vec2(d, clamp((shape - lo) * 1.6, 0.0, 1.0));
}

float henyey(float mu, float g) {
  float h = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / (4.0 * 3.14159265 * h * sqrt(h));
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

  float softSun = softPath(airMass(uSunDir.y));
  float lift = clamp(dir.y, 0.0, 1.0);
  // Kept in step with skyRadiance() above: see there for why the sun path
  // shortens with elevation and why only lift weights it.
  float twilight = smoothstep(-0.26, 0.02, uSunDir.y);
  float sunPath = mix(softSun, min(softSun, HIGH_PATH), lift * lift);

  vec3 trans = 1.0 - exp(-total * airMass(dir.y));
  vec3 inScatter = ((BETA_R * phaseR + betaM * phaseM) / total) * trans;
  vec3 sunAtten = exp(-total * sunPath) * mix(1.0, twilight, lift * lift);
  vec3 col = uSunI * (inScatter * sunAtten
    + MS_TINT * uMs * (0.35 + 0.65 * lift) * trans * pow(sunAtten, vec3(0.18)));

  // ---- night floor, stars, milky way, moon --------------------------------
  if (uNight > 0.002) {
    col += uNight * (uNightZenith + uNightHorizon * pow(1.0 - lift, 5.0));
  }
  float starVis = 1.0;
  if (uStars > 0.004) {
    vec3 sd = uStarRot * dir;
    float band = 1.0 - abs(dot(sd, vec3(0.3612, 0.8428, -0.3984)));
    float milky = pow(max(band, 0.0), 18.0);
    if (milky > 0.004) {
      float n = vnoise3(sd * 7.0) * 0.6 + vnoise3(sd * 17.0) * 0.28 + vnoise3(sd * 41.0) * 0.12;
      milky *= smoothstep(0.34, 0.78, n);
      col += vec3(0.055, 0.058, 0.078) * milky * uStars;
    }
    float s = starField(sd, uTime);
    col += mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.92, 0.78), s * 0.5) * s * uStars;

    float mAng = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
    col += vec3(0.62, 0.66, 0.78) * exp(-mAng * 26.0) * 0.09 * uMoonBright * uStars;
    if (mAng < MOON_R * 1.3) {
      // Reconstruct the sphere normal from the offset inside the disc, so the
      // terminator tracks the real sun and the phase is right at every hour.
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

  // ---- clouds -------------------------------------------------------------
  // Intersecting the view ray with a flat deck, rather than draping a texture
  // on a dome, is what makes the clouds converge toward the horizon the way a
  // real deck does. Sampled unconditionally rather than behind a visibility
  // test: a texture fetch in non-uniform flow has undefined derivatives, so the
  // mip level would be garbage. The fades are multiplies.
  float above = smoothstep(0.015, 0.07, dir.y);
  float rayLen = 1.0 / max(dir.y, 0.012);
  // Haze between the eye and the deck: a far cloud is a pale one.
  vec3 hazeCol = uHaze + uHazeGlow * (0.16 * max(mu, 0.0) * max(mu, 0.0) + pow(max(mu, 0.0), 10.0));

  // High deck first — it is above the low one, so it is behind it.
  {
    vec2 uv = (uCam.xz + dir.xz * (DECK_HI - uCam.y) * rayLen) / REPEAT_HI + uDrift.zw;
    float c = texture2D(uCloud, uv).b;
    float ci = smoothstep(uCover.y, uCover.y + 0.22, c) * uCover.z;
    // Ice cloud is thin: it passes most of the light and glows round the sun.
    vec3 ciCol = uCloudSun * (0.55 + 3.0 * henyey(mu, 0.7)) * 0.9 + uCloudAmb * 0.45;
    float far = 1.0 - exp(-(DECK_HI * rayLen) / 90000.0);
    ciCol = mix(ciCol, hazeCol, far * 0.7);
    col = mix(col, ciCol, ci * 0.55 * above);
  }

  {
    float dist = (DECK_LO - uCam.y) * rayLen;
    vec2 uv = (uCam.xz + dir.xz * dist) / REPEAT_LO + uDrift.xy;
    float cover = uCover.x;
    vec2 c0 = cumulus(uv, cover);
    float d = c0.x;
    // Two steps toward the sun through the same field. Thinner toward the sun
    // is the lit side of the cloud; thicker is its own shadow. A low sun gets
    // longer steps, because its light crosses more of the deck to arrive.
    vec2 toSun = uSunDir.xz / max(uSunDir.y + 0.35, 0.35) * (140.0 / REPEAT_LO);
    vec2 c1 = cumulusCoarse(uv + toSun, cover);
    vec2 c2 = cumulusCoarse(uv + toSun * 2.6, cover);
    // The low tier skips the two steps and lights the deck by its own
    // density alone — flatter, but the same brightness overall.
    float depthToSun = mix(d * 0.55, (d + c0.y) * 0.3 + (c1.x + c1.y) * 0.5 + (c2.x + c2.y) * 0.3, uCloudDetail);
    float lit = exp(-depthToSun * 2.4);
    // Overhead you see a cumulus's flat base; toward the horizon you see its
    // sunlit flanks. So low in the sky the deck is whiter than it is above you.
    float flank = 1.0 - smoothstep(0.04, 0.45, dir.y);
    lit = mix(lit, max(lit, 0.8), flank * 0.75);
    // "Powder": the thinnest wisps scatter less light back out than their
    // density suggests, which is what darkens the very rims of a backlit puff.
    float powder = 1.0 - exp(-d * 5.0);
    float phase = 0.45 + 5.0 * henyey(mu, 0.62);
    // The underside is lit by the sky and darkens with the depth of cloud
    // above it; the sunlit part is what the steps toward the sun let through.
    float thick = smoothstep(0.05, 0.85, d) * (0.7 + 0.3 * c0.y);
    vec3 cCol = uCloudAmb * (1.0 - uDeckDark * thick) * (1.0 - 0.25 * d)
              + uCloudSun * lit * phase * mix(1.0, powder, 0.55);
    float far = 1.0 - exp(-dist / 34000.0);
    cCol = mix(cCol, hazeCol, far * 0.85);
    // Scattered cloud fades out toward the horizon; a closed deck does not —
    // it runs on into the haze, or the clear sky behind it shows through as a
    // bright band all the way round under every overcast.
    float closed = smoothstep(0.62, 0.92, uCover.w);
    float alpha = smoothstep(0.0, 0.42, d) * uOpacity * mix(above, 1.0, closed);
    col = mix(col, cCol, alpha);
    // Starlight does not come through a cloud.
    starVis = 1.0 - alpha;
  }

  // Below the horizon the sky becomes the haze the fog chunks draw, so that
  // wherever the terrain runs out the seam is between two identical colours.
  col = mix(col, hazeCol, 1.0 - smoothstep(-0.05, 0.035, dir.y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Cloud noise texture
//
// Built from typed arrays rather than a canvas, so the harness can build the
// sky headless exactly as the browser does. Tiling matters more than
// resolution: the deck stretches to the horizon, so the texture repeats dozens
// of times and any seam becomes a visible grid. Every field is periodic by
// construction, lattice index modulo the period.
//
//   R  cumulus billows: value noise carved by inverted cellular noise
//   G  fine detail that erodes the edges
//   B  cirrus: noise stretched along one axis, then warped
//   A  coverage: a broad field that groups the cumulus into streets and gaps
// ---------------------------------------------------------------------------

function hashP(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Periodic value noise fbm over an N x N tile, cx x cy cells at the base. */
function tileFbm(N, cx, cy, oct, seed, out, warp = null) {
  let amp = 1, norm = 0;
  out.fill(0);
  for (let o = 0; o < oct; o++) {
    const px = cx << o, py = cy << o, sd = seed + o * 1013;
    const L = new Float32Array((px + 1) * (py + 1));
    for (let j = 0; j <= py; j++) for (let i = 0; i <= px; i++) L[j * (px + 1) + i] = hashP(i % px, j % py, sd);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let u = (x + 0.5) / N, v = (y + 0.5) / N;
        if (warp) { u += warp[y * N + x] * 0.06; v += warp[y * N + x] * 0.02; }
        u = ((u % 1) + 1) % 1; v = ((v % 1) + 1) % 1;
        const fx = u * px, fy = v * py;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
        const r0 = y0 * (px + 1), r1 = r0 + px + 1;
        const a = L[r0 + x0], b = L[r0 + x0 + 1], c = L[r1 + x0], d = L[r1 + x0 + 1];
        out[y * N + x] += (a + (b - a) * sx + (c + (d - c) * sx - a - (b - a) * sx) * sy) * amp;
      }
    }
    norm += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Periodic inverted Worley (1 at a feature point, 0 at the cell border). */
function tileWorley(N, cells, seed, out) {
  const P = cells + 2;
  const fx = new Float32Array(P * P), fy = new Float32Array(P * P);
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const si = (i - 1 + cells) % cells, sj = (j - 1 + cells) % cells;
      fx[j * P + i] = i - 1 + hashP(si, sj, seed);
      fy[j * P + i] = j - 1 + hashP(si, sj, seed + 1);
    }
  }
  const s = cells / N;
  for (let y = 0; y < N; y++) {
    const py = (y + 0.5) * s, cy = Math.floor(py) + 1;
    for (let x = 0; x < N; x++) {
      const px = (x + 0.5) * s, cx = Math.floor(px) + 1;
      let d1 = 9;
      for (let jy = cy - 1; jy <= cy + 1; jy++) {
        for (let jx = cx - 1; jx <= cx + 1; jx++) {
          const k = jy * P + jx, dx = fx[k] - px, dy = fy[k] - py;
          const dd = dx * dx + dy * dy;
          if (dd < d1) d1 = dd;
        }
      }
      out[y * N + x] = 1 - Math.min(1, Math.sqrt(d1));
    }
  }
  return out;
}

function stretch(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

function buildCloudData(N, seed) {
  const n = N * N;
  const base = tileFbm(N, 4, 4, 5, seed, new Float32Array(n));
  const w1 = tileWorley(N, 6, seed + 11, new Float32Array(n));
  const w2 = tileWorley(N, 13, seed + 12, new Float32Array(n));
  const w3 = tileWorley(N, 27, seed + 13, new Float32Array(n));
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Perlin-Worley: the cellular field carves the value noise into rounded
    // cells, which is what reads as a heap of billows rather than a smear.
    const wf = w1[i] * 0.625 + w2[i] * 0.25 + w3[i] * 0.125;
    R[i] = clamp((base[i] - (wf - 1)) / (1 - (wf - 1)) , 0, 1) * 0.55 + wf * 0.45;
  }
  stretch(R);
  const G = stretch(tileFbm(N, 22, 22, 3, seed + 21, new Float32Array(n)));
  const warp = tileFbm(N, 3, 3, 2, seed + 41, new Float32Array(n));
  for (let i = 0; i < n; i++) warp[i] = warp[i] * 2 - 1;
  // Mares' tails rather than rulings: stretched about 2:1, and warped, so
  // the streaks bend and fray instead of converging on the horizon in lines.
  const B = stretch(tileFbm(N, 3, 7, 4, seed + 31, new Float32Array(n), warp));
  const A = stretch(tileFbm(N, 2, 2, 2, seed + 51, new Float32Array(n)));
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = R[i] * 255;
    data[i * 4 + 1] = G[i] * 255;
    data[i * 4 + 2] = B[i] * 255;
    data[i * 4 + 3] = A[i] * 255;
  }
  return data;
}

/**
 * Quantile tables for the two cloud fields, so a weather can ask for "16% of
 * the sky" and get it. Thresholding a noise field at a fixed number gives
 * whatever coverage that field happens to have there — which is how the old
 * clear sky came out as a few torn flakes and nothing else.
 */
function coverageTables(data, n) {
  const shape = new Float32Array(n), cirrus = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    shape[i] = (data[i * 4] * 0.74 + data[i * 4 + 3] * 0.26) / 255;
    cirrus[i] = data[i * 4 + 2] / 255;
  }
  shape.sort(); cirrus.sort();
  const q = (a) => (f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))];
  return { shape: q(shape), cirrus: q(cirrus) };
}

function makeCloudTexture(size, seed, anisotropy) {
  const data = buildCloudData(size, seed);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.userData.coverage = coverageTables(data, size * size);
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
// Scratch — every one of these exists so that update() allocates nothing.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _zenith = { r: 0, g: 0, b: 0 };
const _horizon = { r: 0, g: 0, b: 0 };
const _toward = { r: 0, g: 0, b: 0 };
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
  installHaze();

  const latRad = (opts.latitude ?? 36) * DEG;
  const decRad = (opts.declination ?? 12) * DEG;
  // Eleven hours behind the sun: a waxing gibbous that rises about an hour
  // before sunset and is up all night, which is the only phase that actually
  // lights a night drive.
  const moonLag = opts.moonLag ?? 11.0;
  const moonDec = -(opts.declination ?? 12) * DEG;

  // LIGHT BALANCE. Measured on the old numbers: sunlit mid-grey rendered five
  // to seven times darker than the sky above it, and the only fill was a
  // hemisphere light at a third of the sun. Out of doors at noon the two are
  // about equal and the sun is five or six times the skylight — which is where
  // midday shadows get their depth. So the sky is drawn dimmer, the sun
  // brighter and the fill lower, and the tone map sits the result where the
  // old picture was on average.
  const skyBrightness = opts.skyBrightness ?? 1.30;
  const sunPeak = opts.sunIntensity ?? 4.6;
  // Night is lit well above what the physics of moonlight would give: an
  // honestly moonlit road reads 3/255, which is not a dark road, it is no road.
  const moonPeak = opts.moonIntensity ?? 0.34;
  const hemiPeak = opts.ambientIntensity ?? 0.95;
  let tier = QUALITY[opts.quality] ? opts.quality : 'medium';
  let shadowRadius = opts.shadowRadius ?? QUALITY[tier].extent;
  let shadowSize = opts.shadowMapSize ?? QUALITY[tier].size;
  let sunDistance = opts.sunDistance ?? 360;
  const windX = opts.windX ?? 0.82;
  const windZ = opts.windZ ?? 0.57;
  // 0 means the clock is frozen and main.js drives it with setTime().
  let dayLength = opts.dayLength ?? 0;
  let drawDistance = opts.drawDistance ?? 1000;
  // The height the haze's density is quoted at: the valley floors of this
  // world sit around -25 m. Fixed, not following the camera, so that fog pools
  // in the low ground and a car climbing out of it drives into clear air.
  const hazeFloor = opts.hazeFloor ?? -25;

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
    uCam: { value: new THREE.Vector3() },
    uDrift: { value: new THREE.Vector4() },
    uCover: { value: new THREE.Vector4(0.8, 0.8, 0.35, 0) },
    uOpacity: { value: 0.92 },
    uDeckDark: { value: 0.3 },
    uCloudSun: { value: new THREE.Vector3(1, 1, 1) },
    uCloudAmb: { value: new THREE.Vector3(0.5, 0.55, 0.62) },
    uCloudDetail: { value: 1 },
    uHaze: { value: new THREE.Vector3(0.5, 0.6, 0.7) },
    uHazeGlow: { value: new THREE.Vector3() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
  });
  // Size is irrelevant while update() re-centres this on the camera each frame,
  // but making it larger than the world costs nothing.
  const geometry = new THREE.BoxGeometry(200000, 200000, 200000);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Drawn LAST of the opaque objects, with the depth test on, not first with
  // it off. The shader pins every sky pixel to the far plane, so the test
  // passes only where nothing else has been drawn — and the per-pixel
  // atmosphere and cloud work runs on the sky you can see instead of on the
  // whole screen, most of which is ground. Measured at 1280x720: the sky's
  // share of the frame fell from 0.29 ms to about a third of that.
  mesh.renderOrder = 1000;
  scene.add(mesh);

  // The camera is not handed to update(), but it is handed to this, once per
  // frame before anything else draws. Its forward vector steers the shadow
  // camera on the next update.
  const viewDir = new THREE.Vector3(0, 0, -1);
  mesh.onBeforeRender = (r, s, camera) => {
    if (camera && camera.getWorldDirection) camera.getWorldDirection(viewDir);
  };

  // ---- lights -------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, sunPeak);
  sun.castShadow = opts.shadows !== false;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sun.shadow.camera;
  function fitShadowCamera() {
    sc.left = -shadowRadius; sc.right = shadowRadius;
    sc.top = shadowRadius; sc.bottom = -shadowRadius;
    sc.near = 1; sc.far = sunDistance + shadowRadius * 2;
    sc.updateProjectionMatrix();
  }
  fitShadowCamera();
  sun.shadow.bias = opts.shadowBias ?? -0.0004;
  sun.shadow.normalBias = opts.shadowNormalBias ?? 0.08;
  // three's PCF takes five hardware-filtered taps on a Vogel disc this many
  // texels wide, so softness costs nothing extra. At the old radius of one
  // texel every shadow had a ruled edge, which is not what a sun 0.5 degrees
  // across casts: a car's shadow is sharp at the tyres and soft at the roof.
  sun.shadow.radius = QUALITY[tier].radius;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x8fb4dd, 0x4a4436, hemiPeak);
  scene.add(hemi);

  // ---- fog ----------------------------------------------------------------
  // Reuse whatever linear fog the engine already made, so anything holding a
  // reference to it keeps working; only build one if there is nothing usable.
  // It has to stay a THREE.Fog: FogExp2 would switch every material to the
  // FOG_EXP2 path, which has no ring edge and no height.
  const createdFog = !(scene.fog && scene.fog.isFog);
  if (createdFog) scene.fog = new THREE.Fog(0x9dc0da, 300, drawDistance);

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
  let wetness = 0;

  // The celestial pole: due north, at an altitude equal to the latitude.
  const poleAxis = new THREE.Vector3(0, Math.sin(latRad), -Math.cos(latRad));

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
    visibility: WEATHER.clear.visibility,
    wetness: 0,
  };

  // What other layers may read off the scene without importing this module:
  // roads use it for the sky they reflect and how wet they are. A plain
  // object, rewritten in place every frame.
  const published = {
    zenith: new THREE.Color(), horizon: new THREE.Color(),
    sunDir: state.sunDir, rain: 0, wetness: 0, night: 0,
  };
  scene.userData.sky = published;

  // ---- biome air -----------------------------------------------------------
  const bioW = new Float64Array(5);
  const air = { turb: 1, vis: 1, sun: [1, 1, 1], fog: [1, 1, 1], bounce: [1, 1, 1], snow: 0, leaves: 0, heat: 0, primed: false };
  state.biome = air;
  function biomeAir(cameraPos, step) {
    const field = activeBiomes();
    if (!field || !cameraPos) return;
    field.weightsAt(cameraPos.x, cameraPos.z, bioW);
    let turb = 0, vis = 0;
    const sun = [0, 0, 0], fog = [0, 0, 0], bounce = [0, 0, 0];
    for (let b = 0; b < 5; b++) {
      const A = BIO_AIR[b], w = bioW[b];
      turb += A.turb * w; vis += A.vis * w;
      for (let c = 0; c < 3; c++) { sun[c] += A.sun[c] * w; fog[c] += A.fog[c] * w; bounce[c] += A.bounce[c] * w; }
    }
    const snow = smoothstep(0.35, 0.8, bioW[BIOME.alpine]);
    const leaves = smoothstep(0.35, 0.8, bioW[BIOME.autumn]);
    const heat = smoothstep(0.35, 0.8, bioW[BIOME.desert]);
    const k = air.primed ? 1 - Math.exp(-step / 1.5) : 1;
    air.primed = true;
    air.turb += (turb - air.turb) * k;
    air.vis += (vis - air.vis) * k;
    air.snow += (snow - air.snow) * k;
    air.leaves += (leaves - air.leaves) * k;
    air.heat += (heat - air.heat) * k;
    for (let c = 0; c < 3; c++) {
      air.sun[c] += (sun[c] - air.sun[c]) * k;
      air.fog[c] += (fog[c] - air.fog[c]) * k;
      air.bounce[c] += (bounce[c] - air.bounce[c]) * k;
    }
  }

  // ---- falling snow -----------------------------------------------------------
  const SNOW_N = 2600, SNOW_BOX = 64;
  const snowPos = new Float32Array(SNOW_N * 3);
  {
    let a = 0x9e3779b9;
    const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < SNOW_N * 3; i++) snowPos[i] = r() * SNOW_BOX;
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowU = {
    uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: SNOW_BOX },
    uAmt: { value: 0 }, uScale: { value: 900 }, uLight: { value: new THREE.Color(1, 1, 1) },
  };
  const snowMat = new THREE.ShaderMaterial({
    uniforms: snowU, vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG,
    transparent: true, depthWrite: false, fog: false,
  });
  const snowPts = new THREE.Points(snowGeo, snowMat);
  snowPts.name = 'snowfall';
  snowPts.frustumCulled = false;
  snowPts.renderOrder = 6;
  snowPts.visible = false;
  scene.add(snowPts);
  let snowT = 0;

  // ---- falling leaves ---------------------------------------------------------
  const LEAF_N = 1600, LEAF_BOX = 40;
  const leafPos = new Float32Array(LEAF_N * 3), leafA = new Float32Array(LEAF_N * 4);
  {
    let a = 0x7f4a7c15;
    const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < LEAF_N * 3; i++) leafPos[i] = r() * LEAF_BOX;
    for (let i = 0; i < LEAF_N * 4; i++) leafA[i] = r();
  }
  const leafGeo = new THREE.BufferGeometry();
  leafGeo.setAttribute('position', new THREE.BufferAttribute(leafPos, 3));
  leafGeo.setAttribute('leaf', new THREE.BufferAttribute(leafA, 4));
  const leafU = {
    uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: LEAF_BOX },
    uAmt: { value: 0 }, uScale: { value: 900 }, uLight: { value: new THREE.Color(1, 1, 1) },
  };
  const leafMat = new THREE.ShaderMaterial({
    uniforms: leafU, vertexShader: LEAF_VERT, fragmentShader: LEAF_FRAG,
    transparent: true, depthWrite: false, fog: false,
  });
  const leafPts = new THREE.Points(leafGeo, leafMat);
  leafPts.name = 'leaffall';
  leafPts.frustumCulled = false;
  leafPts.renderOrder = 6;
  leafPts.visible = false;
  scene.add(leafPts);
  let leafT = 0;

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
    // A weather set with no transition is a teleport of the weather, and the
    // road surface goes with it rather than taking minutes to dry.
    if (blendSeconds <= 0) wetness = WEATHER[name].rain;
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

  /** 'low' | 'medium' | 'high': shadow resolution, softness and reach. */
  function setQuality(q) {
    if (!QUALITY[q]) return tier;
    tier = q;
    const t = QUALITY[q];
    shadowRadius = t.extent;
    sun.shadow.radius = t.radius;
    if (t.size !== shadowSize) {
      shadowSize = t.size;
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      // The map is allocated at its first render; drop it so the next frame
      // allocates it at the new size.
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    fitShadowCamera();
    // The low tier lights the cloud deck flat, saving two fetches a sky pixel.
    uniforms.uCloudDetail.value = q === 'low' ? 0 : 1;
    return tier;
  }

  function update(dt, cameraPos, cameraDir) {
    const step = Math.min(0.1, Math.max(0, dt));
    elapsed = (elapsed + step) % 1024;
    if (dayLength > 0) setTime(hours + (step * 24) / dayLength);
    if (cameraDir) viewDir.copy(cameraDir);

    // ---- weather blend ----------------------------------------------------
    if (blendT < 1) blendT = Math.min(1, blendT + step / blendLen);
    const w = blendT * blendT * (3 - 2 * blendT);
    for (let i = 0; i < WEATHER_KEYS.length; i++) {
      const k = WEATHER_KEYS[i];
      now[k] = from[k] + (to[k] - from[k]) * w;
    }
    // The biome's air, applied to local copies: `now` is snapshotted by
    // setWeather() and must stay the weather alone.
    biomeAir(cameraPos, step);
    const turbidity = now.turbidity * air.turb;
    const visibility = now.visibility * air.vis;

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
    state.turbidity = turbidity;
    state.visibility = visibility;

    const ms = smoothstep(-0.16, 0.20, sy) * 0.55;
    sunTransmittance(_trans, sy, turbidity);

    uniforms.uSunDir.value.copy(state.sunDir);
    uniforms.uSunLit.value.set(_trans.r, _trans.g, _trans.b);
    uniforms.uTurbidity.value = turbidity;
    uniforms.uMs.value = ms;
    uniforms.uNight.value = night;
    uniforms.uStars.value = stars;
    uniforms.uTime.value = elapsed;
    uniforms.uMoonDir.value.copy(state.moonDir);
    uniforms.uMoonBright.value = smoothstep(-0.06, 0.10, state.moonDir.y);

    _right.crossVectors(Math.abs(state.moonDir.y) > 0.99 ? ALT_UP : UP, state.moonDir).normalize();
    _up.crossVectors(state.moonDir, _right);
    uniforms.uMoonRight.value.copy(_right);
    uniforms.uMoonUp.value.copy(_up);

    // Stars wheel about the pole at 15 degrees an hour, the same clock the sun
    // keeps, so the night sky turns instead of hanging there like wallpaper.
    _m4.makeRotationAxis(poleAxis, (hours / 24) * TAU);
    uniforms.uStarRot.value.setFromMatrix4(_m4);

    // ---- clouds -----------------------------------------------------------
    // Wrapped to one tile: the texture repeats anyway, and an accumulator left
    // to grow all session eventually loses enough float precision to make the
    // clouds visibly stutter. 6 m/s of wind at the low deck, 14 at the high.
    driftX0 = (driftX0 + windX * step * 6 / 5200) % 1;
    driftY0 = (driftY0 + windZ * step * 6 / 5200) % 1;
    driftX1 = (driftX1 + windX * step * 14 / 14000) % 1;
    driftY1 = (driftY1 + windZ * step * 14 / 14000) % 1;
    uniforms.uDrift.value.set(driftX0, driftY0, driftX1, driftY1);
    // Cloud begins a little below the quantile, because the smoothstep and
    // the edge erosion take back roughly that much.
    // A closed deck is pushed past the minimum so no hole survives the edge
    // smoothstep and the erosion.
    const cov = cloudTex.userData.coverage;
    uniforms.uCover.value.set(
      cov.shape(clamp(1 - now.cumulus * 1.18, 0, 1)) - 0.03 - 0.45 * smoothstep(0.72, 0.98, now.cumulus),
      cov.cirrus(clamp(1 - now.cirrus * 0.5, 0, 1)),
      now.cirrus, now.cumulus);
    uniforms.uOpacity.value = now.opacity;
    uniforms.uDeckDark.value = now.deckDark;
    if (cameraPos) uniforms.uCam.value.copy(cameraPos);

    // ---- colours read back out of the same model --------------------------
    skyRadiance(_zenith, 0, 1, 0, state.sunDir.x, sy, state.sunDir.z,
      turbidity, skyBrightness, ms);
    addNightFloor(_zenith, 1, night);

    // The haze colour is the horizon at right angles to the sun; the extra
    // light toward the sun is carried separately as the glow, which the fog
    // chunks and the sky both add back per pixel along the actual view ray.
    // That is what makes driving into a sunset turn the haze gold and driving
    // away from it leave it blue — in the same frame, on either side.
    const hx = state.sunDir.x, hz = state.sunDir.z, hl = Math.hypot(hx, hz);
    const ax = hl > 1e-4 ? hx / hl : 1, az = hl > 1e-4 ? hz / hl : 0;
    skyRadiance(_horizon, -az * 0.9994, 0.035, ax * 0.9994,
      state.sunDir.x, sy, state.sunDir.z, turbidity, skyBrightness, ms);
    addNightFloor(_horizon, 0.035, night);
    skyRadiance(_toward, ax * 0.9994, 0.035, az * 0.9994,
      state.sunDir.x, sy, state.sunDir.z, turbidity, skyBrightness, ms);
    addNightFloor(_toward, 0.035, night);

    state.zenithColour.setRGB(_zenith.r, _zenith.g, _zenith.b);
    state.horizonColour.setRGB(_horizon.r, _horizon.g, _horizon.b);

    // Cloud light. Tops of the deck take the direct sun; the underside we see
    // is lit by the sky above and the ground below. Both come from the model,
    // which is the whole reason sunset clouds come out pink.
    const cloudSun = 1.7 * daylight * now.light + 0.05;
    const moonLit = uniforms.uMoonBright.value * night * 0.022;
    uniforms.uCloudSun.value.set(
      _trans.r * cloudSun + moonLit * 0.85,
      _trans.g * cloudSun + moonLit * 0.92,
      _trans.b * cloudSun + moonLit,
    );
    const ambK = 0.62 + 0.25 * now.fogGrey;
    // At night a cloud is lit from below by the glow of the ground and
    // whatever towns there are, so it is a shade LIGHTER than the clear sky
    // around it, not a black hole in the stars.
    const nf = night * 1.6;
    uniforms.uCloudAmb.value.set(
      (_zenith.r * 0.55 + _horizon.r * 0.45) * ambK + moonLit * 0.5 + nf * (NIGHT_ZENITH[0] + NIGHT_HORIZON[0]),
      (_zenith.g * 0.55 + _horizon.g * 0.45) * ambK + moonLit * 0.5 + nf * (NIGHT_ZENITH[1] + NIGHT_HORIZON[1]),
      (_zenith.b * 0.55 + _horizon.b * 0.45) * ambK + moonLit * 0.6 + nf * (NIGHT_ZENITH[2] + NIGHT_HORIZON[2]),
    );

    // Under cloud the horizon is cloud, not clear sky, so the haze drifts
    // toward the grey of the deck's underside, and the glow round the sun
    // fades with it.
    const grey = now.fogGrey;
    const ca = uniforms.uCloudAmb.value;
    const deckBase = 1 - now.deckDark * 0.6;
    state.fogColour.setRGB(
      lerp(_horizon.r, ca.x * deckBase * 1.15, grey),
      lerp(_horizon.g, ca.y * deckBase * 1.15, grey),
      lerp(_horizon.b, ca.z * deckBase * 1.15, grey),
    );
    state.fogColour.r *= air.fog[0]; state.fogColour.g *= air.fog[1]; state.fogColour.b *= air.fog[2];
    const glowK = (1 - grey) * (0.4 + 0.6 * now.light);
    HAZE_GLOW.x = Math.max(0, _toward.r - _horizon.r) * glowK;
    HAZE_GLOW.y = Math.max(0, _toward.g - _horizon.g) * glowK;
    HAZE_GLOW.z = Math.max(0, _toward.b - _horizon.b) * glowK;
    HAZE_SUN.x = state.sunDir.x; HAZE_SUN.y = state.sunDir.y; HAZE_SUN.z = state.sunDir.z;
    uniforms.uHaze.value.set(state.fogColour.r, state.fogColour.g, state.fogColour.b);
    uniforms.uHazeGlow.value.set(HAZE_GLOW.x, HAZE_GLOW.y, HAZE_GLOW.z);

    // The haze itself. Extinction from the visibility, thinning with height
    // above the ground under the camera, which is what lets valleys hold it.
    HAZE.x = 3.912 / Math.max(50, visibility);
    HAZE.y = 1 / Math.max(20, now.hazeH);
    HAZE.z = hazeFloor;
    HAZE.w = 1;

    // Re-asserted every frame on purpose: the engine's quality switch also
    // writes fog.far, and weather has to win that argument. `far` is the ring
    // edge the terrain streams to, or less in weather thick enough to hide it
    // sooner; `near` only matters to materials that fall back to linear fog.
    if (scene.fog && scene.fog.isFog) {
      scene.fog.color.copy(state.fogColour);
      const far = Math.min(drawDistance, Math.max(160, visibility * 3.2));
      scene.fog.far = far;
      scene.fog.near = Math.min(far * 0.85, visibility * 0.35);
    }

    // ---- light ------------------------------------------------------------
    // The one directional light follows the sun by day and the moon by night.
    // Both ramps reach zero at the same sun elevation, so the handover happens
    // while the light contributes nothing and cannot be seen.
    const lunarRamp = 1 - smoothstep(-0.20, -0.09, sy);
    const lunar = lunarRamp * smoothstep(-0.03, 0.16, state.moonDir.y);
    const useMoon = sy <= -0.09;
    if (useMoon) {
      _v.copy(state.moonDir);
      sun.intensity = moonPeak * lunar * lerp(1, 0.35, now.fogGrey);
    } else {
      _v.copy(state.sunDir);
      sun.intensity = sunPeak * daylight * now.light;
    }
    // The direction switches hard, which is safe because both intensity ramps
    // are zero at sy = -0.09. The COLOUR must not: hemi.groundColor is derived
    // from it and hemi is still lit at the handover, so it cross-fades.
    //
    // pow(T, 0.3) rather than T itself: the raw transmittance at sunset is so
    // close to monochrome red that every surface in the world turns tomato.
    const lr = Math.pow(Math.max(_trans.r, 1e-4), 0.3);
    const lg = Math.pow(Math.max(_trans.g, 1e-4), 0.3);
    const lb = Math.pow(Math.max(_trans.b, 1e-4), 0.3);
    const peak = Math.max(lr, 1e-4);   // red is always the least extinguished
    // Moonlight is physically slightly WARMER than sunlight. Cool blue is a
    // cinema convention the player expects, so this is a deliberate lie.
    state.sunLightColour.setRGB(
      lerp(0.94 * (lr / peak) + 0.06, 0.55, lunarRamp),
      lerp(0.94 * (lg / peak) + 0.06, 0.66, lunarRamp),
      lerp(0.94 * (lb / peak) + 0.06, 0.95, lunarRamp),
    );
    state.sunLightColour.r *= air.sun[0]; state.sunLightColour.g *= air.sun[1]; state.sunLightColour.b *= air.sun[2];
    sun.color.copy(state.sunLightColour);

    if (cameraPos) {
      mesh.position.copy(cameraPos);

      // The shadow camera is centred ahead of the camera along its view, not
      // on it: half of a square centred on the eye is behind you. Then it is
      // snapped to whole shadow-map texels, or every shadow edge crawls as the
      // car moves, which at 40 m/s is far more obvious than any aliasing.
      const fl = Math.hypot(viewDir.x, viewDir.z);
      const ahead = shadowRadius * 0.45;
      _fwd.set(cameraPos.x + (fl > 1e-4 ? viewDir.x / fl : 0) * ahead, cameraPos.y,
        cameraPos.z + (fl > 1e-4 ? viewDir.z / fl : 0) * ahead);
      const texel = (2 * shadowRadius) / shadowSize;
      _right.crossVectors(Math.abs(_v.y) > 0.99 ? ALT_UP : UP, _v).normalize();
      _up.crossVectors(_v, _right);
      const a = Math.round(_right.dot(_fwd) / texel) * texel;
      const b = Math.round(_up.dot(_fwd) / texel) * texel;
      const c = _v.dot(_fwd);
      sun.target.position.set(
        _right.x * a + _up.x * b + _v.x * c,
        _right.y * a + _up.y * b + _v.y * c,
        _right.z * a + _up.z * b + _v.z * c,
      );
      sun.position.copy(sun.target.position).addScaledVector(_v, sunDistance);
    }

    // Hemisphere sky is the zenith colour, pulled a third of the way to white:
    // fully saturated ambient makes white cars look painted. Ground is sunlight
    // bounced off earth and grass, so it follows the sun's colour and is
    // tinted by what it bounced off rather than being a fixed brown.
    const zMax = Math.max(_zenith.r, _zenith.g, _zenith.b, 1e-4);
    hemi.color.setRGB(
      lerp(_zenith.r / zMax, 1, 0.30),
      lerp(_zenith.g / zMax, 1, 0.30),
      lerp(_zenith.b / zMax, 1, 0.30),
    );
    hemi.groundColor.setRGB(
      (state.sunLightColour.r * 0.30 + 0.05) * air.bounce[0],
      (state.sunLightColour.g * 0.30 + 0.06) * air.bounce[1],
      (state.sunLightColour.b * 0.20 + 0.05) * air.bounce[2],
    );
    hemi.intensity = hemiPeak * (0.20 + 0.80 * smoothstep(-0.22, 0.16, sy)) * now.ambient;

    // ---- falling snow -----------------------------------------------------
    // Lit by the sky: bright by day, a faint grey drift under the moon.
    const amt = air.snow * (1 - now.rain) * 0.9;
    snowPts.visible = amt > 0.02 && !!cameraPos;
    if (snowPts.visible) {
      snowT = (snowT + step) % 3600;
      snowU.uT.value = snowT;
      snowU.uCam.value.copy(cameraPos);
      snowU.uAmt.value = amt;
      if (renderer && renderer.domElement) snowU.uScale.value = renderer.domElement.height * 1.0;
      const lum = 0.10 + 0.85 * daylight * now.light;
      snowU.uLight.value.setRGB(lum * 0.95, lum * 0.97, lum);
    }

    // Leaves come down in the autumn woods whatever the weather, fewer in
    // rain (a wet leaf stays on the ground). Lit a little brighter than the
    // snow, because a leaf is lit through as well as on.
    const lamt = air.leaves * (1 - now.rain * 0.6) * 0.8;
    leafPts.visible = lamt > 0.02 && !!cameraPos;
    if (leafPts.visible) {
      leafT = (leafT + step) % 3600;
      leafU.uT.value = leafT;
      leafU.uCam.value.copy(cameraPos);
      leafU.uAmt.value = lamt;
      if (renderer && renderer.domElement) leafU.uScale.value = renderer.domElement.height * 1.0;
      const ll = 0.12 + 1.35 * daylight * now.light;
      leafU.uLight.value.setRGB(ll, ll, ll);
    }
    // How much heat shimmer the air should have: the canyon, in daylight,
    // and less the more cloud. For a post pass to read (state.biome.heat);
    // nothing here draws it.
    state.heatHaze = air.heat * daylight * smoothstep(0.1, 0.5, sy) * (1 - now.rain);

    // ---- publish ------------------------------------------------------------
    // Rain wets the world in about half a minute and it takes minutes to dry;
    // this is the number roads darken and flood by.
    wetness += (now.rain - wetness) * (1 - Math.exp(-step / (now.rain > wetness ? 25 : 150)));
    state.wetness = wetness;
    published.zenith.setRGB(_zenith.r, _zenith.g, _zenith.b);
    published.horizon.copy(state.fogColour);
    published.rain = now.rain;
    published.wetness = wetness;
    published.night = night;
  }

  function dispose() {
    scene.remove(snowPts);
    snowGeo.dispose();
    snowMat.dispose();
    scene.remove(leafPts);
    leafGeo.dispose();
    leafMat.dispose();
    scene.remove(mesh);
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(hemi);
    geometry.dispose();
    material.dispose();
    cloudTex.dispose();
    sun.dispose();
    if (createdFog) scene.fog = null;
    if (scene.userData.sky === published) delete scene.userData.sky;
  }

  setWeather(weatherName, 0);
  return {
    sun, hemi, state, mesh, material, uniforms,
    setTime, setWeather, setDrawDistance, setTimeScale, setQuality, update, dispose,
    get quality() { return tier; },
  };
}

// ---------------------------------------------------------------------------
// Headlamps
//
// The car's lamps have always been emissive paint: they glow, and light
// nothing. At night that left the player driving into a black road under the
// moon, which is most of why night was unplayable rather than atmospheric.
// This is the light itself — one spot, wide enough for both lamps, aimed
// down the road from the front of the car — so the tarmac, the verges, the
// lane markings and the barn in the bend all light up as the car comes round.
//
// It lives here because the sky owns every other light in the world and sets
// how bright night is. main.js hangs it off the player's car:
//
//   const lamps = mSky && mSky.createHeadlamps ? mSky.createHeadlamps(carRoot) : null;
//   // each frame, next to carModel.setHeadlights(...):
//   if (lamps) lamps.update(dt, headlights || night > 0.35);
//
// One light, no shadow: a spot light costs every lit fragment one more term,
// which is cheap; a shadowed one costs another scene render, which is not.
// It is never removed or hidden once created, only dimmed to zero, because
// adding or removing a light recompiles every lit material in the scene —
// a stall the first time the player flicks the lights on.
// ---------------------------------------------------------------------------
/**
 * The beam pattern, projected by the spot light like a slide.
 *
 * A bare spot light is brightest on its axis and falls off to the edge, which
 * is the wrong way round for a car: light on a flat road falls off as the
 * cube of distance at grazing incidence, so an evenly lit road needs almost
 * all the intensity in a thin band just under the horizontal and very little
 * in the foreground. That is what real low beams do, and it is this: a sharp
 * cutoff at the horizon, intensity growing with the distance at which each
 * ray meets the road, and a wide dimmer spill to the sides for the verges.
 */
function beamTexture(lampHeight, halfAngle) {
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const t = Math.tan(halfAngle);
  for (let y = 0; y < N; y++) {
    // Texture v runs up; the centre row is the lamp's axis.
    const below = (0.5 - (y + 0.5) / N) * 2 * t;          // tan of the angle below the axis
    let m;
    if (below <= 0) {
      m = 0.05 + 0.95 * Math.exp(-(below / 0.012) * (below / 0.012));   // cutoff
    } else {
      const d = lampHeight / below;                       // where this ray lands
      m = Math.min(1, Math.pow(d / 24, 2.4));
    }
    for (let x = 0; x < N; x++) {
      const across = ((x + 0.5) / N - 0.5) * 2;
      const lat = 0.30 + 0.70 * Math.exp(-(across / 0.45) * (across / 0.45));
      const v = Math.max(0, Math.min(1, m * lat));
      const o = (y * N + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createHeadlamps(parent, opts = {}) {
  const front = opts.front ?? 2.05;           // m ahead of the car's origin
  const height = opts.height ?? 0.72;         // m above the ground
  // Tuned by reading back road pixels at 23:00 under a clear sky: the lane
  // 10-35 m ahead lifts from about 12/255 to 60-160/255 once night exposure
  // has opened up — enough to drive by, never daylight. A car or a wall
  // facing the lamps inside 15 m blooms white, as it does in life.
  const peak = opts.intensity ?? 36000;
  const half = 0.62;
  const group = new THREE.Group();
  group.name = 'headlamps';
  // Forward is -Z. Physical falloff: the pattern does the shaping.
  const lamp = new THREE.SpotLight(0xfff0d8, 0, 160, half, 0.25, 2);
  lamp.position.set(0, height, -front);
  lamp.target.position.set(0, height, -front - 30);   // axis level; the map dips the beam
  lamp.map = beamTexture(height, half);
  lamp.castShadow = false;
  group.add(lamp);
  group.add(lamp.target);
  if (parent) parent.add(group);

  let level = 0;
  return {
    group, lamp,
    /** `on` is whether the lamps are switched on; dt smooths the switch. */
    update(dt, on) {
      // Filament lamps take a moment to come up and a little longer to die.
      const tau = on ? 0.06 : 0.12;
      level += ((on ? 1 : 0) - level) * (1 - Math.exp(-Math.max(0, dt) / tau));
      lamp.intensity = peak * level;
    },
    dispose() {
      group.removeFromParent();
      if (lamp.map) lamp.map.dispose();
      lamp.dispose();
    },
  };
}
