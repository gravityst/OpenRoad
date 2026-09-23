// Trees, bushes, rocks and street furniture.
//
// COORDINATE CONVENTION — the same one the physics uses, stated here because
// getting it backwards has already cost this project real time:
//
//   forward = -Z      right = +X      up = +Y
//   a Y rotation of `rot` sends local -Z to world (-sin rot, -cos rot)
//
// The only prop with a front is the streetlight, and its arm is modelled along
// local +Z — i.e. pointing BACKWARD — because layout.js hands us a `rot` whose
// forward direction points away from the carriageway. Local +Z therefore lands
// over the road, which is where a lamp belongs.
//
// WHAT THE COUNTRYSIDE COSTS, AND WHY IT IS AFFORDABLE
//
// The world now carries woodland rather than a sprinkling of lollipops: about
// 90,000 trees and 44,000 shrubs (layout.js), against 8,000 trees before. None
// of that is drawn per object. Every species is three InstancedMeshes, one per
// level of detail, and the levels hand over with a screen-door crossfade:
//
//   near   the full tree — every leaf card and branch (foliage.js). Out to
//          50 m at 'high', which in the thickest forest is a couple of hundred.
//   mid    about a quarter of the cards, scaled up to cover the same canopy,
//          on the major limbs only. Out to 125 m.
//   far    a two-triangle impostor billboard, rasterised from the near mesh at
//          load. Out to 1 km, which is what puts forest on the far hillsides
//          instead of bare green.
//
// The handover is a dither, not a pop: across a band at each boundary the two
// levels draw COMPLEMENTARY halves of an interleaved-gradient screen pattern,
// so every pixel belongs to exactly one of them and the swap reads as a brief
// shimmer rather than a tree changing shape. Instances outside a level's band
// are collapsed to a point in the vertex shader and never reach the rasteriser.
//
// Culling is still the grid scheme this file always had: instances are counting
// -sorted into 32 m cells at load, so each cell owns a contiguous run of a
// precomputed matrix array, and refreshing a field is a few thousand run copies
// rather than a distance test per tree. A field's set stays valid until the
// camera has moved its rebuild step; the stalest field refreshes each frame.
//
// Draw calls: 8 species x 3 levels, 2 rock levels x 3 shapes, stones, tree
// contact shadows, lamps — 35 fields, of which 14-40 draw in a given frame
// (shadow pass included), against 6-11 before. Triangle budgets per tier are
// in the TIERS table and measured by tools/naturecheck.mjs in the densest
// block of woodland on the map.
//
// WHY THE LAMP POOLS ARE FAKE
//
// There are thousands of streetlights. Thousands of real lights is not a frame
// budget question, it is a shader-compile and uniform-limit question — the
// renderer would fall over long before the fill rate did. So a lit lamp is an
// emissive head plus an additive ground decal, and setNight() fades both.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  mulberry, clamp, lerp, smoothstep, valueNoise, valueNoise3, tileFbm, tileCells,
} from '../world/noise.js';
import {
  archGeometry, hoodooGeometry, lighthouseGeometry, beamGeometry, snowPoleGeometry, tumbleweedGeometry,
} from './landmarks.js';
import {
  paintAtlas, buildSpecies, meshFrom, rasterImpostors, SPECIES, ATLAS_W, ATLAS_H, CELLS,
} from './foliage.js';

// How far the camera may travel before a field's visible set is stale. Every
// field builds with `radius + step`, which is what makes that safe. `step` is
// 12% of the field's radius, between 8 and 24 m — every metre of margin is
// paid for all the way round the circle, and a near tree is eight hundred
// triangles. This constant is the ceiling the instance buffers are sized for.
// A frame that has already overrun defers a refresh until the field is 1.5
// steps stale — deferred, not vetoed, or a machine below 20 fps would never
// rebuild and would drive straight out of its own scenery.
const REBUILD_STEP = 34;

// One grid for everything. Cells wholly inside a field's circle are copied as
// runs; cells straddling it are filtered instance by instance, so the grid
// pitch costs refresh time rather than triangles. The far fields reach a
// kilometre, and a coarser grid would only save a loop over empty offsets.
const CELL = 32;

// Distances per quality tier, in metres from the camera (horizontal). `near`,
// `mid` and `far` are where each tree level ENDS; bushes stop sooner because a
// two-metre shrub is a pixel at 400 m. Shadows: at 'high' the mid-level trees
// cast into the sun's shadow map (the near level would cost three times the
// triangles for a shadow nobody can tell apart), and near trees receive it.
//
// 'low' has no near level at all: the mid tree starts at the bumper. It is a
// sparser tree, but at 'low' the budget is the point.
//
// The mid band is where the triangles go — it covers eight times the ground of
// the near band — so it hands over to impostors at 125 m. A seventeen-metre
// spruce at that range is about 130 px tall at 1080p, which a normal-mapped
// billboard carries. Worst case measured by tools/naturecheck.mjs, in the
// densest 64 m block of woodland on the map.
export const TIERS = {
  low:    { near: 0,  mid: 70,  far: 520,  bushFar: 220, rockNear: 22, rockFar: 240, stone: 45,  shadows: false },
  medium: { near: 38, mid: 100, far: 800,  bushFar: 300, rockNear: 36, rockFar: 330, stone: 75,  shadows: false },
  high:   { near: 50, mid: 125, far: 1000, bushFar: 380, rockNear: 50, rockFar: 420, stone: 110, shadows: true },
};
const MAX = TIERS.high;
// Crossfade width as a fraction of the boundary distance: 7 m at the near
// boundary, 17 m at mid, a gentle 140 m fade into the fog at the far edge.
const BAND = 0.14;

// The rest of the renderer takes a tier NAME and main.js passes
// settings.quality straight through, but a 0..1 number is still accepted.
function tierOf(q) {
  if (typeof q === 'number' && Number.isFinite(q)) return q < 0.34 ? 'low' : q < 0.75 ? 'medium' : 'high';
  if (q === 'ultra') return 'high';
  if (q === 'off') return 'low';
  return TIERS[q] ? q : 'high';
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------
// Injected into three's own Lambert and depth materials rather than replacing
// them, so fog, shadows, tone mapping and the hemisphere light all keep working
// without being reimplemented. Every replacement is anchored on a chunk name;
// if a future three.js renames one, that replacement silently does nothing and
// the material still draws — plainer, never broken.

const LOD_PARS = `
uniform vec4 orLod;        // inner fade start, end; outer fade start, end (m)
uniform vec3 orFocus;      // the real camera, for the shadow pass
varying vec2 vOrLod;       // x: how far in past the inner edge, y: past the outer
`;

// Horizontal distance from camera to the instance's base, and the two fades.
// A level shows a pixel when dither < inner && dither >= outer, so the next
// level out, whose INNER fade is this level's OUTER one, takes exactly the
// pixels this one gives up.
const LOD_VERT = `
vec3 orBase = vec3( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 1 ], instanceMatrix[ 3 ][ 2 ] );
float orDist = length( orBase.xz - cameraPosition.xz );
vOrLod = vec2( smoothstep( orLod.x, orLod.y, orDist ), smoothstep( orLod.z, orLod.w, orDist ) );
`;

// Collapsing the whole instance to one point outside the clip volume: its
// triangles become degenerate and are dropped before rasterisation. In the
// shadow pass `cameraPosition` is the sun's, so the test there is against the
// real camera (orFocus) and the reach of the shadow map instead: sky.js
// centres a box 110 m either side of the camera. 125 m leaves room for a
// fifteen-metre tree's shadow under a 20-degree sun; at 150 m the shadow pass
// was drawing as many triangles as the whole mid level for trees whose
// shadows land outside the map.
const LOD_COLLAPSE = `
#ifndef OR_SHADOW
if ( vOrLod.x <= 0.0 || vOrLod.y >= 1.0 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
#else
if ( length( orBase.xz - orFocus.xz ) > 125.0 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
#endif
`;

const LOD_FRAG_PARS = `
varying vec2 vOrLod;
// Interleaved gradient noise: a fixed per-pixel threshold with no visible
// structure, so the crossfade dissolves instead of drawing a checkerboard.
float orDither() {
  return fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

const LOD_FRAG = `
{
  float orH = orDither();
  if ( orH >= vOrLod.x || orH < vOrLod.y ) discard;
}
`;

// ---------------------------------------------------------------------------
// Biome colour (world/biomes.js)
// ---------------------------------------------------------------------------
// The biome field is baked into a small texture over the map (R desert, G
// snow, B autumn, A coast) and every plant reads it at its own base, in the
// vertex shader, once. What it does with it is on the FOLIAGE only — a pixel
// greener than it is red — so trunks and branches keep their bark:
//
//   autumn  each tree its own colour from gold through orange to red, by a
//           hash of where it stands, one in ten still hanging on to green;
//           brightened half as much again, because a canopy in autumn is.
//   desert  dusty grey-green: sage, not lawn.
//   snow    whatever faces up is white — leaves, branches, the tops of
//           rocks — so a spruce wears its snow in layers.
//
// Colours are LINEAR (the shader works after the sRGB decode); the snow is
// the same albedo the ground's snow is painted at.
const BIO_VERT_PARS = `
uniform sampler2D orBiome;
uniform vec2 orBiomeK;     // 1 / map span, strength (0 for palms and cacti)
varying vec4 vOrBio;
varying float vOrHue;
varying float vOrUp;
`;
const BIO_VERT = `
vOrBio = texture2D( orBiome, orBase.xz * orBiomeK.x + 0.5 ) * orBiomeK.y;
vOrHue = fract( sin( dot( orBase.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
vOrUp = normalize( mat3( instanceMatrix ) * objectNormal ).y;
`;
const BIO_FRAG_PARS = `
varying vec4 vOrBio;
varying float vOrHue;
varying float vOrUp;
vec3 orBiomeLeaf( vec3 c ) {
  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float leaf = smoothstep( 0.0, 0.03, c.g - c.r );
  vec3 aut = vOrHue < 0.4 ? mix( vec3( 1.0, 0.60, 0.07 ), vec3( 1.0, 0.30, 0.03 ), vOrHue / 0.4 )
                          : mix( vec3( 1.0, 0.30, 0.03 ), vec3( 0.85, 0.07, 0.035 ), ( vOrHue - 0.4 ) / 0.6 );
  aut *= lum * 1.7 / max( 0.05, dot( aut, vec3( 0.2126, 0.7152, 0.0722 ) ) );
  float green = step( 0.9, fract( vOrHue * 7.13 ) );
  c = mix( c, aut, vOrBio.b * leaf * ( 1.0 - green * 0.7 ) );
  c = mix( c, vec3( lum * 1.3, lum * 1.18, lum * 0.78 ), vOrBio.r * leaf * 0.8 );
  return c;
}
// The card's UV, for the snow clumps. A macro, because this block is
// injected ahead of three's own declaration of vMapUv and only expands where
// it is used, which is after it.
#ifdef USE_MAP
#define OR_UV vMapUv
#else
#define OR_UV vec2( 0.5 )
#endif
vec3 orBiomeSnow( vec3 c, float up, vec2 uv ) {
  // Snow lies along the tops of the branches, in clumps, and the needles
  // under it stay dark — a winter spruce is darker and bluer than a summer
  // one, which is what makes the white on it read as snow. A crown's normals
  // all lean upward, so facing up alone is not enough to decide: whitening
  // everything above 0.45 turned whole forests into white combs from the
  // road. The clumps are a pattern in the leaf card's own UVs, so they stay
  // put on the branch as the tree sways; trunks (red over green) take none.
  float leaf = smoothstep( 0.0, 0.03, c.g - c.r );
  float clump = smoothstep( -0.1, 0.6, sin( uv.x * 41.0 + vOrHue * 6.28 ) * sin( uv.y * 33.0 + vOrHue * 3.1 ) + ( up - 0.75 ) * 1.5 );
  c = mix( c, c * vec3( 0.70, 0.78, 0.82 ), vOrBio.g * leaf );
  return mix( c, vec3( 0.50, 0.55, 0.63 ), vOrBio.g * leaf * smoothstep( 0.5, 0.9, up ) * ( 0.15 + 0.85 * clump ) * 0.85 );
}
`;

// Alpha-tested foliage loses coverage down the mip chain — a mip averages leaf
// with sky and the alpha test then throws the average away — so a tree thins to
// a skeleton exactly as it gets far enough to need the density most. Scaling
// alpha up with the mip level puts the coverage back (the fix from
// Golus's "Anti-aliased Alpha Test"); 0.25 per level was picked by eye.
const ALPHA_MIP = `
#ifdef USE_MAP
{
  vec2 orTs = vec2( textureSize( map, 0 ) );
  vec2 orDx = dFdx( vMapUv * orTs ), orDy = dFdy( vMapUv * orTs );
  diffuseColor.a *= 1.0 + max( 0.0, 0.5 * log2( max( dot( orDx, orDx ), dot( orDy, orDy ) ) ) ) * 0.25;
}
#endif
`;

const WIND_PARS = `
attribute vec2 wind;       // x: metres of sway per unit wind, y: leaf flutter
uniform vec4 orWind;       // xy direction (world XZ), z strength, w time (s)
`;

// A tree bends as a whole — two incommensurate sines with a slow gust envelope,
// phased by position so a wood ripples rather than marching in step — and its
// leaves flutter along their own normals at a much higher rate. The sway is
// applied in WORLD space, after the instance transform, so the wind blows the
// same way through every tree whatever its rotation.
const WIND_VERT = `
float orPh = dot( orBase.xz, vec2( 0.071, 0.113 ) );
float orT = orWind.w;
float orGust = 0.6 + 0.4 * sin( orT * 0.37 + orPh * 0.13 ) * sin( orT * 0.23 + 1.3 );
float orSway = ( sin( orT * 1.07 + orPh ) * 0.7 + sin( orT * 2.31 + orPh * 1.9 ) * 0.3 ) * orGust + 0.4;
vec3 orOff = vec3( orWind.x, 0.0, orWind.y ) * ( orSway * orWind.z * wind.x );
transformed += normal * ( sin( orT * 7.3 + dot( position, vec3( 3.1, 2.3, 1.7 ) ) + orPh * 3.0 ) * 0.045 * wind.y * orWind.z );
`;

const PROJECT_WIND = `
vec4 mvPosition = instanceMatrix * vec4( transformed, 1.0 );
mvPosition.xyz += orOff;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
${LOD_COLLAPSE}
`;

const WORLDPOS_WIND = `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = instanceMatrix * vec4( transformed, 1.0 );
  worldPosition.xyz += orOff;
  worldPosition = modelMatrix * worldPosition;
#endif
`;

// Canopy lighting. Wrapped diffuse, because light scatters through a crown
// into its own shade and a hard terminator makes a tree look like a painted
// ball; plus a forward-scattering term, so a tree between the camera and a low
// sun lights up yellow-green at its edges the way real leaves do.
function canopyLambert() {
  const src = THREE.ShaderChunk.lights_lambert_pars_fragment || '';
  const anchor = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;';
  if (src.indexOf(anchor) < 0) return src;
  return src.replace(anchor,
    'float orNL = dot( geometryNormal, directLight.direction );\n' +
    '\tfloat dotNL = saturate( orNL * 0.72 + 0.28 );\n' +
    '\tfloat orBack = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), 5.0 ) * 0.45;\n' +
    '\tvec3 irradiance = ( dotNL + orBack ) * directLight.color;');
}

// Rock surface: grain and cracks from a tiling detail map, sampled three ways
// in world space so every boulder shares one texture without a single UV —
// the shape is noise-displaced, and any UV layout would stretch across the
// displaced faces. 1.9 m a tile; the map's R is grain, G is cracks, BA a
// tangent-space normal of both.
const ROCK_FRAG_PARS = `
uniform sampler2D orRockTex;
uniform sampler2D orBiome;
uniform vec2 orBiomeK;
varying vec3 vRkPos;
varying vec3 vRkN;
vec3 orRkW;
vec4 orRkT;
`;
const ROCK_FRAG_ALBEDO = `
{
  vec3 n = normalize( vRkN );
  orRkW = abs( n ); orRkW *= orRkW; orRkW *= orRkW;
  orRkW /= ( orRkW.x + orRkW.y + orRkW.z );
  vec3 p = vRkPos * ( 1.0 / 1.9 );
  orRkT = texture2D( orRockTex, p.zy ) * orRkW.x + texture2D( orRockTex, p.xz ) * orRkW.y + texture2D( orRockTex, p.xy ) * orRkW.z;
  diffuseColor.rgb *= ( 0.62 + 0.76 * orRkT.r ) * ( 1.0 - orRkT.g * 0.6 );
  // Rust-red in the canyon, snow-capped in the peaks.
  vec4 orB = texture2D( orBiome, vRkPos.xz * orBiomeK.x + 0.5 ) * orBiomeK.y;
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.32, 0.78, 0.55 ), orB.r );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.54, 0.59, 0.67 ), orB.g * smoothstep( 0.35, 0.8, n.y ) * 0.9 );
}
`;
const ROCK_FRAG_NORMAL = `
{
  vec2 d = ( orRkT.ba - 0.5 ) * 0.9;
  vec3 pw = vec3( 0.0, d.y, d.x ) * orRkW.x + vec3( d.x, 0.0, d.y ) * orRkW.y + vec3( d.x, d.y, 0.0 ) * orRkW.z;
  normal = normalize( normal + ( viewMatrix * vec4( pw, 0.0 ) ).xyz );
}
`;

/**
 * Rock detail: grain, weathering blotches, and fracture lines, packed with
 * their normal. Tiles every 256 texels.
 *
 * Fractures are the zero-crossings of a domain-warped noise — thin, long,
 * wandering lines — and only where a second noise says so, so most of the
 * surface is unbroken. The first version drew them along Worley cell borders,
 * which closes every crack into a polygon; on a boulder that reads as a
 * tortoise shell, or a football.
 */
function rockTexture(seed) {
  const W = 256;
  const px = new Uint8Array(W * W * 4);
  const h = new Float32Array(W * W);
  const cell = { d1: 0, d2: 0, tone: 0 };
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const u = i / W, v = j / W, c = j * W + i;
      const grain = tileFbm(u * 32, v * 32, 32, 32, seed + 1, 3) * 0.5 + 0.5;
      const blotch = tileFbm(u * 5, v * 5, 5, 5, seed + 2, 3) * 0.5 + 0.5;
      const wu = u + tileFbm(u * 3, v * 3, 3, 3, seed + 4, 2) * 0.12;
      const wv = v + tileFbm(u * 3, v * 3, 3, 3, seed + 5, 2) * 0.12;
      const line = Math.abs(tileFbm(wu * 4, wv * 4, 4, 4, seed + 6, 3));
      const mask = smoothstep(0.05, 0.35, tileFbm(u * 3, v * 3, 3, 3, seed + 8, 2) * 0.5 + 0.5);
      const crack = (1 - smoothstep(0.0, 0.035, line)) * mask;
      const pit = tileCells(u * 21, v * 21, 21, seed + 7, cell);
      const pits = (1 - smoothstep(0.0, 0.12, pit.d1)) * 0.35;
      px[c * 4] = clamp(grain * 0.55 + blotch * 0.45, 0, 1) * 255;
      px[c * 4 + 1] = clamp(crack + pits * 0.4, 0, 1) * 255;
      h[c] = grain * 0.35 + blotch * 0.25 - crack * 0.9 - pits * 0.3;
    }
  }
  // Tangent-space normal from the height, wrapping.
  let acc = 0;
  const gx = new Float32Array(W * W), gz = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i;
      gx[c] = h[j * W + ((i + W - 1) % W)] - h[j * W + ((i + 1) % W)];
      gz[c] = h[((j + W - 1) % W) * W + i] - h[((j + 1) % W) * W + i];
      acc += gx[c] * gx[c] + gz[c] * gz[c];
    }
  }
  const k = 0.35 / (Math.sqrt(acc / (W * W * 2)) || 1);
  for (let c = 0; c < W * W; c++) {
    px[c * 4 + 2] = (clamp(gx[c] * k, -1, 1) * 0.5 + 0.5) * 255;
    px[c * 4 + 3] = (clamp(gz[c] * k, -1, 1) * 0.5 + 0.5) * 255;
  }
  const t = new THREE.DataTexture(px, W, W, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Patch a Lambert material. `kind` is 'canopy' (leaf cards: wind, LOD, alpha
 * mip fix, canopy normals and lighting), 'impostor' (billboards) or 'rock'
 * (LOD only).
 */
function inject(material, kind, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let v = shader.vertexShader, f = shader.fragmentShader;
    if (v.indexOf('#include <project_vertex>') < 0 || v.indexOf('#include <begin_vertex>') < 0) return;

    if (kind === 'canopy') {
      v = v.replace('#include <common>', `#include <common>\n${LOD_PARS}\n${WIND_PARS}\n${BIO_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOD_VERT}\n${WIND_VERT}\n${BIO_VERT}`)
        .replace('#include <project_vertex>', PROJECT_WIND)
        .replace('#include <worldpos_vertex>', WORLDPOS_WIND);
      f = f.replace('#include <common>', `#include <common>\n${LOD_FRAG_PARS}\n${BIO_FRAG_PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${LOD_FRAG}\n${ALPHA_MIP}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = orBiomeSnow( orBiomeLeaf( diffuseColor.rgb ), vOrUp, OR_UV );')
        // The canopy normal is the normal of the crown, not of the card, so it
        // must not flip with the side of the card that happens to face us.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif')
        .replace('#include <lights_lambert_pars_fragment>', canopyLambert());
    } else if (kind === 'impostor') {
      v = v.replace('#include <common>', `#include <common>\n${LOD_PARS}\n${BIO_VERT_PARS}\nvarying vec3 vOrRight;\nvarying vec3 vOrFwd;`)
        // Two views of every species, picked per tree by a hash of its position.
        .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
vMapUv.y += step( 0.5, fract( sin( dot( vec2( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 2 ] ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) ) * 0.5;
#endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOD_VERT}\n${BIO_VERT}`)
        .replace('#include <project_vertex>', `
float orSx = length( vec3( instanceMatrix[ 0 ][ 0 ], instanceMatrix[ 0 ][ 1 ], instanceMatrix[ 0 ][ 2 ] ) );
float orSy = length( vec3( instanceMatrix[ 1 ][ 0 ], instanceMatrix[ 1 ][ 1 ], instanceMatrix[ 1 ][ 2 ] ) );
vec3 orTo = cameraPosition - orBase;
orTo.y = 0.0;
float orTl = length( orTo );
orTo = orTl > 0.001 ? orTo / orTl : vec3( 0.0, 0.0, 1.0 );
vec3 orRight = vec3( orTo.z, 0.0, - orTo.x );
vOrRight = orRight; vOrFwd = orTo;
vec4 mvPosition = modelViewMatrix * vec4( orBase + orRight * ( position.x * orSx ) + vec3( 0.0, position.y * orSy, 0.0 ), 1.0 );
gl_Position = projectionMatrix * mvPosition;
${LOD_COLLAPSE}`);
      f = f.replace('#include <common>', `#include <common>\n${LOD_FRAG_PARS}\n${BIO_FRAG_PARS}\nuniform sampler2D orNormalMap;\nvarying vec3 vOrRight;\nvarying vec3 vOrFwd;`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${LOD_FRAG}\n${ALPHA_MIP}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = orBiomeLeaf( diffuseColor.rgb );')
        // The normal map is in the billboard's own frame: x right, y up, z to
        // the camera. Rebuild it in world space, then take it to view space.
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
{
  vec3 orNT = texture2D( orNormalMap, vMapUv ).xyz * 2.0 - 1.0;
  vec3 orNW = orNT.x * vOrRight + vec3( 0.0, orNT.y, 0.0 ) + orNT.z * vOrFwd;
  normal = normalize( ( viewMatrix * vec4( orNW, 0.0 ) ).xyz );
  diffuseColor.rgb = orBiomeSnow( diffuseColor.rgb, normalize( orNW ).y, OR_UV );
}`)
        .replace('#include <lights_lambert_pars_fragment>', canopyLambert());
    } else {
      v = v.replace('#include <common>', `#include <common>\n${LOD_PARS}\nvarying vec3 vRkPos;\nvarying vec3 vRkN;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOD_VERT}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
${LOD_COLLAPSE}
vRkPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
vRkN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );`);
      f = f.replace('#include <common>', `#include <common>\n${LOD_FRAG_PARS}\n${ROCK_FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${LOD_FRAG}\n${ROCK_FRAG_ALBEDO}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${ROCK_FRAG_NORMAL}`);
    }
    shader.vertexShader = v;
    shader.fragmentShader = f;
  };
  // Every parameter three hashes into a program key is identical between these
  // and any other vertex-coloured Lambert in the scene, so without a key of
  // their own they would be handed someone else's program.
  material.customProgramCacheKey = () => 'openroad-props-' + kind;
  material.needsUpdate = true;
  return material;
}

/** A depth material for shadow casting that sways with the tree it belongs to. */
function windDepth(uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const v = shader.vertexShader;
    if (v.indexOf('#include <project_vertex>') < 0 || v.indexOf('#include <begin_vertex>') < 0) return;
    shader.vertexShader = '#define OR_SHADOW\n' + v
      .replace('#include <common>', `#include <common>\n${LOD_PARS}\n${WIND_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOD_VERT}\n${WIND_VERT}`)
      .replace('#include <project_vertex>', PROJECT_WIND);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${ALPHA_MIP}`);
  };
  m.customProgramCacheKey = () => 'openroad-props-depth';
  return m;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Scale (uniform unless told otherwise) then translate, in that order. */
function part(geo, x, y, z, sx, sy, sz) {
  if (sx !== undefined) geo.scale(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
  geo.translate(x, y, z);
  return geo;
}

/** Bakes a colour into a geometry, jittered per triangle. */
function paint(geo, hex, jitter, rnd) {
  const g = geo.index === null ? geo : geo.toNonIndexed();
  if (g !== geo) geo.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color(hex);
  for (let f = 0; f + 2 < pos.count; f += 3) {
    const k = 1 + (rnd() * 2 - 1) * jitter;
    for (let v = 0; v < 3; v++) {
      const o = (f + v) * 3;
      col[o] = base.r * k; col[o + 1] = base.g * k; col[o + 2] = base.b * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merged(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

// Rock palettes, sRGB: weathered granite, warm sandstone, dark basalt.
const ROCK_TONES = [[0.52, 0.51, 0.48], [0.58, 0.52, 0.43], [0.37, 0.37, 0.36]];

/**
 * A boulder, built as a SHAPE first and a mesh second, so the near and far
 * levels are the same stone at two resolutions.
 *
 * The shape is a sphere pushed about by 3D noise and then cut by three to five
 * random planes. The noise gives the weathered roundness; the planes give the
 * flat fracture faces that are what actually make something read as rock
 * rather than as a potato. Colour is baked per vertex: mottling, darker in the
 * hollows and at the ground line, moss on upward faces, a few lichen blotches.
 */
function rockShape(rnd, tone) {
  const planes = [];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const z = rnd() * 1.6 - 0.6, t = rnd() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
    planes.push([r * Math.cos(t), z, r * Math.sin(t), 0.62 + rnd() * 0.25]);
  }
  return {
    seed: Math.floor(rnd() * 1e6), planes, tone,
    amp: 0.22 + rnd() * 0.12, squash: 0.55 + rnd() * 0.25,
    moss: 0.3 + rnd() * 0.5,
  };
}

function rockGeometry(shape, detail) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const a = g.getAttribute('position').array;
  const rad = new Float32Array(a.length / 3);
  let rmax = 0;
  for (let i = 0; i < a.length; i += 3) {
    let x = a[i], y = a[i + 1], z = a[i + 2];
    const k = 1 + shape.amp * (valueNoise3(x * 1.3, y * 1.3, z * 1.3, shape.seed) * 0.75 +
                               valueNoise3(x * 3.4, y * 3.4, z * 3.4, shape.seed + 7) * 0.25);
    x *= k; y *= k; z *= k;
    for (const p of shape.planes) {
      const d = x * p[0] + y * p[1] + z * p[2] - p[3];
      if (d > 0) { x -= p[0] * d; y -= p[1] * d; z -= p[2] * d; }
    }
    y *= shape.squash;
    // A flat underside, buried by the placement: rocks sit IN the ground.
    if (y < -0.32) y = -0.32 + (y + 0.32) * 0.15;
    a[i] = x; a[i + 1] = y; a[i + 2] = z;
    rad[i / 3] = Math.hypot(x, y / shape.squash, z);
    rmax = Math.max(rmax, rad[i / 3]);
  }
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal').array;
  const col = new Float32Array(a.length);
  const base = new THREE.Color().setRGB(shape.tone[0], shape.tone[1], shape.tone[2], THREE.SRGBColorSpace);
  const moss = new THREE.Color().setRGB(0.27, 0.31, 0.15, THREE.SRGBColorSpace);
  const lichen = new THREE.Color().setRGB(0.66, 0.64, 0.46, THREE.SRGBColorSpace);
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    const mot = valueNoise3(x * 4.1, y * 4.1, z * 4.1, shape.seed + 11) * 0.5 +
                valueNoise3(x * 11, y * 11, z * 11, shape.seed + 12) * 0.25;
    const hollow = clamp(rad[i / 3] / rmax, 0, 1);
    const ao = lerp(0.55, 1.0, smoothstep(0.55, 0.98, hollow)) * lerp(0.6, 1.0, smoothstep(-0.32, 0.1, y));
    let r = base.r * (1 + mot * 0.28) * ao, gg = base.g * (1 + mot * 0.28) * ao, b = base.b * (1 + mot * 0.26) * ao;
    // Moss on the tops, broken up by noise.
    const up = nrm[i + 1];
    const mn = valueNoise3(x * 2.3, y * 2.3, z * 2.3, shape.seed + 21);
    const m = smoothstep(0.35, 0.8, up) * smoothstep(0.1 - shape.moss * 0.5, 0.5, mn) * shape.moss;
    r = lerp(r, moss.r * ao, m); gg = lerp(gg, moss.g * ao, m); b = lerp(b, moss.b * ao, m);
    const ln = valueNoise3(x * 6.5, y * 6.5, z * 6.5, shape.seed + 31);
    const l = smoothstep(0.55, 0.7, ln) * 0.7;
    r = lerp(r, lichen.r, l); gg = lerp(gg, lichen.g, l); b = lerp(b, lichen.b, l);
    col[i] = r; col[i + 1] = gg; col[i + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// --- Street furniture ------------------------------------------------------
// Arm and lamp head extend along local +Z. See the header.

function streetlightBody(rnd) {
  const metal = 0x4a4e54;
  const brace = new THREE.BoxGeometry(0.09, 0.95, 0.09);
  brace.rotateX(0.72);
  return merged([
    paint(part(new THREE.CylinderGeometry(0.20, 0.26, 0.34, 6), 0, 0.17, 0), metal, 0.10, rnd),
    paint(part(new THREE.CylinderGeometry(0.085, 0.135, 7.0, 6, 1, true), 0, 3.50, 0), metal, 0.10, rnd),
    paint(part(new THREE.BoxGeometry(0.10, 0.10, 1.95), 0, 7.02, 0.98), metal, 0.10, rnd),
    paint(part(brace, 0, 6.58, 0.42), metal, 0.10, rnd),
  ]);
}

function polelightBody(rnd) {
  const timber = 0x5a5148;
  return merged([
    paint(part(new THREE.CylinderGeometry(0.18, 0.24, 0.30, 6), 0, 0.15, 0), timber, 0.10, rnd),
    paint(part(new THREE.CylinderGeometry(0.10, 0.17, 6.2, 6, 1, true), 0, 3.10, 0), timber, 0.10, rnd),
    paint(part(new THREE.BoxGeometry(0.08, 0.08, 0.56), 0, 6.14, 0.26), timber, 0.10, rnd),
  ]);
}

/** Lamp heads live on their own mesh so only they can go emissive at night. */
function lampGeometry(w, h, d, x, y, z, hex, rnd) {
  return paint(part(new THREE.BoxGeometry(w, h, d), x, y, z), hex, 0.05, rnd);
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/**
 * A soft radial disc. `edgePower` shapes the falloff: the light pool wants a
 * long tail (a lamp does not stop at a rim), the contact shadow wants a tight
 * core so it reads as contact rather than as a grey plate. A DataTexture, not a
 * canvas, so this module builds headless for tools/naturecheck.mjs.
 */
function discTexture(rgb, peakAlpha, edgePower) {
  const S = 128;
  const d = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const dx = (i + 0.5) / S * 2 - 1, dy = (j + 0.5) / S * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, edgePower) * peakAlpha;
      const o = (j * S + i) * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
      d[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function dataTexture(px, w, h, srgb) {
  const t = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // Foliage is seen edge-on a great deal, and trilinear alone smears it.
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** A unit quad lying in the XZ plane, ready to be scaled to a decal radius. */
function decalGeometry() {
  const g = new THREE.PlaneGeometry(2, 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** The impostor quad for one species: its own UV cell, base at y0. */
function impostorGeometry(q, s, S) {
  const g = new THREE.BufferGeometry();
  const x = q.halfW;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-x, q.y0, 0, x, q.y0, 0, x, q.y1, 0, -x, q.y1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  const u0 = s / S, u1 = (s + 1) / S;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 0, u1, 0, u1, 0.5, u0, 0.5], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (q.y0 + q.y1) / 2, 0), Math.hypot(x, q.y1 - q.y0));
  return g;
}


// ---------------------------------------------------------------------------
// The biomes' own plants
// ---------------------------------------------------------------------------
// Written as foliage.js DESCRIPTIONS (tubes and cards), so each gets the same
// near, mid and impostor levels, wind and canopy lighting as every tree,
// without a line of foliage.js changing. Instances turn and scale them.

const n3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A coconut-type palm: a slender trunk curving away from upright, ringed
 * pale (the birch bark's horizontal marks read as a palm's leaf scars), and
 * eleven long arching fronds cut from the fir spray, brightened to a sunlit
 * yellow-green. 8.5 m to the crown.
 */
function palmDesc(rnd) {
  const D = { kind: 'palm', tubes: [], cards: [], height: 0, spread: 0, sink: 0.3 };
  const H = 8.5, n = 8;
  const pts = [], radii = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    pts.push([1.25 * t * t, -0.3 + (H + 0.3) * t, 0]);
    radii.push(0.21 * (1 - 0.32 * t) + 0.08 * smoothstep(0.18, 0, t));
  }
  D.tubes.push({ pts, radii, sides: 7, midSides: 5, bark: 1, rgb: [0.80, 0.70, 0.56], mid: true });
  const top = pts[n];
  const F = 11;
  const phase = rnd() * 6.28;
  for (let f = 0; f < F; f++) {
    const a = phase + (f / F) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
    const d = [Math.cos(a), 0, Math.sin(a)];
    const L = 4.1 + rnd() * 1.1;
    const base = [top[0] + d[0] * 0.18, top[1] - 0.12, top[2] + d[2] * 0.18];
    D.cards.push({
      type: 'frond', base, d, L, W: 1.45 + rnd() * 0.3,
      rise: 0.5 + rnd() * 0.25, droop: 1.0 + rnd() * 0.35, fold: 0.45, segs: 3,
      cell: CELLS.fir, rgb: [1.45, 1.5, 0.95],
      shade: (q) => {
        const r = [q[0] - top[0], 0, q[2] - top[2]];
        const rl = Math.hypot(r[0], r[2]);
        return [n3([r[0] * 0.8, 0.9, r[2] * 0.8]), lerp(0.62, 1.0, clamp(rl / 4, 0, 1))];
      },
      mid: f % 2 === 0, midScale: [1.05, 1.45],
    });
  }
  D.height = H + 1;
  D.spread = 4.6;
  return D;
}

/**
 * A saguaro-type cactus: a ribbed column with a domed top and two or three
 * arms that go out and turn up. The furrowed bark cell's vertical ridges,
 * tinted green, are the ribs. 5.2 m tall.
 */
function cactusDesc(rnd) {
  const D = { kind: 'cactus', tubes: [], cards: [], height: 0, spread: 0, sink: 0.2 };
  const R = 0.36;
  const rgb = [0.50, 1.22, 0.46];
  const prof = [[-0.3, 1], [0.6, 1], [1.8, 0.98], [3.0, 0.95], [4.1, 0.92], [4.7, 0.84], [5.0, 0.66], [5.15, 0.36], [5.22, 0.04]];
  D.tubes.push({ pts: prof.map((q) => [0, q[0], 0]), radii: prof.map((q) => R * q[1]),
    sides: 10, midSides: 6, bark: 0, rgb, mid: true });
  const arms = 2 + (rnd() < 0.5 ? 1 : 0);
  const phase = rnd() * 6.28;
  for (let k = 0; k < arms; k++) {
    const h = 1.8 + k * 0.7 + rnd() * 0.4;
    const a = phase + k * 2.3 + (rnd() - 0.5) * 0.5;
    const dx = Math.cos(a), dz = Math.sin(a);
    const up = 1.2 + rnd() * 1.0;
    const out = [[0.15, 0], [0.5, 0.04], [0.78, 0.22], [0.9, 0.55], [0.92, up * 0.6], [0.92, up], [0.92, up + 0.13], [0.92, up + 0.19]];
    const r = [0.2, 0.2, 0.2, 0.2, 0.19, 0.18, 0.11, 0.02];
    D.tubes.push({ pts: out.map((q) => [dx * q[0], h + q[1], dz * q[0]]), radii: r,
      sides: 8, midSides: 5, bark: 0, rgb, mid: true });
  }
  D.height = 5.2;
  D.spread = 1.2;
  return D;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProps(world, ground, opts = {}) {
  const group = new THREE.Group();
  group.name = 'props';

  const half = world.half;
  const seed = opts.seed === undefined ? world.seed : opts.seed;
  const groundY0 = (x, z) => ground.heightAt(x, z);
  const range = opts.range === undefined ? 1 : opts.range;
  const wantShade = opts.contactShadows !== false;

  // Scratch. Everything below reuses these; update() allocates nothing at all.
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _mat = new THREE.Matrix4();
  const out = { x: 0, y: 0, z: 0, rot: 0, lx: 0, lz: 0, sx: 1, sy: 1, sz: 1, r: 1, g: 1, b: 1 };

  const G = Math.ceil((half * 2) / CELL) + 1;
  const cellOf = (x, z) => {
    const i = clamp(Math.floor((x + half) / CELL), 0, G - 1);
    const j = clamp(Math.floor((z + half) / CELL), 0, G - 1);
    return j * G + i;
  };

  const fields = [];
  const disposables = [];
  const stats = {
    fields: 0, meshes: 0, instances: {}, capacity: {}, species: [],
    buildMs: { atlas: 0, species: 0, impostors: 0, stores: 0 },
  };
  const clock = typeof performance !== 'undefined' ? performance : Date;

  // -------------------------------------------------------------------------
  // Stores and fields
  // -------------------------------------------------------------------------

  /**
   * Counting-sort a subset of world.props into the shared cell grid and bake
   * one matrix (and optionally one tint) per instance. Every level of detail
   * of a species is a field over the same store, so the forest exists once in
   * memory however many ways it is drawn.
   *
   * `place(prop, out)` is called once per prop in prop order, so a shared RNG
   * stays deterministic. The cell is taken from prop.x/prop.z rather than from
   * the placed position — a lamp pool sits a couple of metres off its pole,
   * which is nothing against a 32 m cell.
   */
  function makeStore(indices, place, tint, list = world.props) {
    const n = indices.length;
    if (n === 0) return null;
    const start = new Int32Array(G * G + 1);
    for (let k = 0; k < n; k++) {
      const p = list[indices[k]];
      start[cellOf(p.x, p.z) + 1]++;
    }
    for (let c = 0; c < G * G; c++) start[c + 1] += start[c];
    const cursor = Int32Array.from(start);
    const srcM = new Float32Array(n * 16);
    const srcC = tint ? new Float32Array(n * 3) : null;
    for (let k = 0; k < n; k++) {
      const p = list[indices[k]];
      out.lx = 0; out.lz = 0;
      place(p, out);
      const slot = cursor[cellOf(p.x, p.z)]++;
      // Lean first (about X and Z, a few degrees), then the heading.
      _euler.set(out.lx, out.rot, out.lz, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(out.x, out.y, out.z);
      _scale.set(out.sx, out.sy, out.sz);
      _mat.compose(_pos, _quat, _scale);
      _mat.toArray(srcM, slot * 16);
      if (srcC) { srcC[slot * 3] = out.r; srcC[slot * 3 + 1] = out.g; srcC[slot * 3 + 2] = out.b; }
    }
    return { n, start, srcM, srcC, sat: null };
  }

  /** The most instances any disc of radius `r` can reach, over every position. */
  function capacityFor(store, r) {
    const R = Math.ceil(r / CELL);
    const W = G + 1;
    if (!store.sat) {
      const sat = new Int32Array(W * W);
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const c = j * G + i;
          sat[(j + 1) * W + i + 1] = (store.start[c + 1] - store.start[c]) +
            sat[j * W + i + 1] + sat[(j + 1) * W + i] - sat[j * W + i];
        }
      }
      store.sat = sat;
    }
    const sat = store.sat;
    let cap = 0;
    for (let j = 0; j < G; j++) {
      const j0 = Math.max(0, j - R), j1 = Math.min(G - 1, j + R) + 1;
      for (let i = 0; i < G; i++) {
        const i0 = Math.max(0, i - R), i1 = Math.min(G - 1, i + R) + 1;
        const s = sat[j1 * W + i1] - sat[j0 * W + i1] - sat[j1 * W + i0] + sat[j0 * W + i0];
        if (s > cap) cap = s;
      }
    }
    return Math.min(store.n, cap);
  }

  const offsCache = new Map();
  /** Cell offsets within R cells, nearest first. */
  function offsetsFor(R) {
    let offs = offsCache.get(R);
    if (offs) return offs;
    const tmp = [];
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        if ((Math.max(0, Math.abs(di) - 1) ** 2 + Math.max(0, Math.abs(dj) - 1) ** 2) * CELL * CELL > (R * CELL) ** 2) continue;
        tmp.push([di * di + dj * dj, di, dj]);
      }
    }
    tmp.sort((a, b) => a[0] - b[0]);
    offs = new Int16Array(tmp.length * 2);
    for (let k = 0; k < tmp.length; k++) { offs[k * 2] = tmp[k][1]; offs[k * 2 + 1] = tmp[k][2]; }
    offsCache.set(R, offs);
    return offs;
  }

  /**
   * One InstancedMesh over a store. `maxRadius` sizes the buffers (the 'high'
   * figure, so quality can change without reallocating); applyTier() sets the
   * live radius and step. The furthest a field ever reaches is its outer fade
   * band plus the largest step, and both the capacity and the cell offsets are
   * sized for that, with a cell to spare.
   */
  function makeField(store, spec) {
    if (!store) return null;
    const { name, geometry, material, maxRadius } = spec;
    const reach = maxRadius * range * (1 + BAND * 0.5) + REBUILD_STEP;
    // A store small enough to be reached whole (a lighthouse, the arches)
    // gets one slot more than it has instances: a full buffer is how
    // tools/naturecheck.mjs sees a field that has run out of room, and one
    // that holds every instance there is has not.
    const need = capacityFor(store, reach + CELL);
    if (need === 0) return null;
    const cap = need === store.n ? need + 1 : need;
    const offs = offsetsFor(Math.ceil(reach / CELL) + 1);

    const mesh = new THREE.InstancedMesh(geometry, material, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Our own distance cull already decides what exists; three's frustum test
    // would only measure a bounding sphere that spans the whole map.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (spec.depthMaterial) mesh.customDepthMaterial = spec.depthMaterial;
    if (spec.renderOrder) mesh.renderOrder = spec.renderOrder;
    const dstM = mesh.instanceMatrix.array;
    let dstC = null;
    if (store.srcC) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      dstC = mesh.instanceColor.array;
    }
    group.add(mesh);

    const { start, srcM, srcC } = store;
    const field = {
      name, mesh, extras: [], cap, total: store.n, spec,
      radius: maxRadius * range, step: REBUILD_STEP,
      atX: Infinity, atZ: Infinity, dirty: true,
      tris: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3,
    };

    /**
     * Rebuild the visible set around the camera.
     *
     * Cells wholly inside the circle are copied as runs; cells straddling it
     * are copied instance by instance with a distance test. Copying straddling
     * cells whole was fine when a tree cost sixty triangles, but at eight
     * hundred a 32 m cell of slop around a 64 m radius submitted five times the
     * trees that could be seen.
     */
    field.refresh = function refresh(camX, camZ) {
      const radius = field.radius + field.step;
      const r2 = radius * radius;
      const ci = Math.floor((camX + half) / CELL);
      const cj = Math.floor((camZ + half) / CELL);
      let w = 0;
      for (let t = 0; t < offs.length; t += 2) {
        const i = ci + offs[t], j = cj + offs[t + 1];
        if (i < 0 || j < 0 || i >= G || j >= G) continue;
        const c = j * G + i;
        const s = start[c];
        let len = start[c + 1] - s;
        if (len === 0) continue;
        // Nearest and farthest points of the cell from the camera.
        const x0 = i * CELL - half, z0 = j * CELL - half;
        const dx = camX < x0 ? x0 - camX : camX > x0 + CELL ? camX - x0 - CELL : 0;
        const dz = camZ < z0 ? z0 - camZ : camZ > z0 + CELL ? camZ - z0 - CELL : 0;
        if (dx * dx + dz * dz > r2) continue;
        const fx = Math.max(Math.abs(camX - x0), Math.abs(camX - x0 - CELL));
        const fz = Math.max(Math.abs(camZ - z0), Math.abs(camZ - z0 - CELL));
        if (fx * fx + fz * fz <= r2) {
          if (w + len > cap) len = cap - w;
          if (len <= 0) break;
          // Copied by hand rather than with dst.set(src.subarray(...)):
          // subarray allocates a view object per call.
          let sm = s * 16, dm = w * 16;
          for (let k = len * 16; k > 0; k--) dstM[dm++] = srcM[sm++];
          if (dstC) {
            let sc = s * 3, dc = w * 3;
            for (let k = len * 3; k > 0; k--) dstC[dc++] = srcC[sc++];
          }
          w += len;
        } else {
          for (let q = s; q < s + len && w < cap; q++) {
            const ex = srcM[q * 16 + 12] - camX, ez = srcM[q * 16 + 14] - camZ;
            if (ex * ex + ez * ez > r2) continue;
            let sm = q * 16, dm = w * 16;
            for (let k = 16; k > 0; k--) dstM[dm++] = srcM[sm++];
            if (dstC) { dstC[w * 3] = srcC[q * 3]; dstC[w * 3 + 1] = srcC[q * 3 + 1]; dstC[w * 3 + 2] = srcC[q * 3 + 2]; }
            w++;
          }
        }
        if (w >= cap) break;
      }
      mesh.count = w;
      for (let k = 0; k < field.extras.length; k++) field.extras[k].count = w;
      if (w > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, w * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, w * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
      field.atX = camX; field.atZ = camZ; field.dirty = false;
    };

    fields.push(field);
    stats.instances[name] = store.n;
    stats.capacity[name] = cap;
    return field;
  }

  /**
   * A second mesh riding the same instance transforms — used for lamp heads,
   * which need their own emissive material but sit exactly where the pole they
   * belong to sits. Sharing the attribute means one buffer and one upload.
   */
  function shareInstances(field, geometry, material, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, field.cap);
    mesh.name = name;
    mesh.instanceMatrix = field.mesh.instanceMatrix;
    mesh.instanceColor = null;
    mesh.count = field.mesh.count;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    field.extras.push(mesh);
    group.add(mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Sort the prop list
  // -------------------------------------------------------------------------

  const TREES = SPECIES.filter((s) => s.kind === 'tree').length;
  const BUSHES = SPECIES.length - TREES;
  const treeIdx = Array.from({ length: TREES }, () => []);
  const bushIdx = Array.from({ length: BUSHES }, () => []);
  const rockIdx = [[], [], []];
  const palmIdx = [], cactusIdx = [];
  const stoneIdx = [];
  const streetIdx = [];
  const poleIdx = [];
  const lightIdx = [];
  const shadeIdx = [];
  for (let i = 0; i < world.props.length; i++) {
    const p = world.props[i];
    if (p.type === 'tree') { treeIdx[clamp(p.variant | 0, 0, TREES - 1)].push(i); shadeIdx.push(i); }
    else if (p.type === 'bush') bushIdx[clamp(p.variant | 0, 0, BUSHES - 1)].push(i);
    else if (p.type === 'rock') rockIdx[clamp(p.variant | 0, 0, 2)].push(i);
    else if (p.type === 'stone') stoneIdx.push(i);
    else if (p.type === 'palm') palmIdx.push(i);
    else if (p.type === 'cactus') cactusIdx.push(i);
    else if (p.type === 'streetlight') { streetIdx.push(i); lightIdx.push(i); }
    else if (p.type === 'polelight') { poleIdx.push(i); lightIdx.push(i); }
  }

  // -------------------------------------------------------------------------
  // Species, atlases, materials
  // -------------------------------------------------------------------------

  let t0 = clock.now();
  const atlasPx = paintAtlas(seed | 0);
  const atlas = dataTexture(atlasPx, ATLAS_W, ATLAS_H, true);
  stats.buildMs.atlas = Math.round(clock.now() - t0);

  t0 = clock.now();
  const descs = buildSpecies(seed | 0);
  // The palm and the cactus ride on the end of the species list, after the
  // bushes, so every index foliage.js hands out is unchanged.
  const PALM = descs.length, CACTUS = descs.length + 1;
  {
    const pr = mulberry((seed | 0) + 8807);
    const palm = palmDesc(pr); palm.name = 'palm';
    const cactus = cactusDesc(pr); cactus.name = 'cactus';
    descs.push(palm, cactus);
  }
  const nearGeo = descs.map((d) => meshFrom(d, 'near'));
  const midGeo = descs.map((d) => meshFrom(d, 'mid'));
  // A cactus does not sway.
  for (const g2 of [nearGeo[CACTUS], midGeo[CACTUS]]) g2.getAttribute('wind').array.fill(0);
  stats.buildMs.species = Math.round(clock.now() - t0);

  t0 = clock.now();
  const imp = rasterImpostors(descs, nearGeo, atlasPx);
  const impAlbedo = dataTexture(imp.albedo, imp.width, imp.height, true);
  const impNormal = dataTexture(imp.normal, imp.width, imp.height, false);
  const impGeo = imp.quads.map((q, s) => impostorGeometry(q, s, descs.length));
  stats.buildMs.impostors = Math.round(clock.now() - t0);
  for (let s = 0; s < descs.length; s++) {
    stats.species.push({
      name: descs[s].name, kind: descs[s].kind, height: descs[s].height, spread: descs[s].spread,
      nearTris: nearGeo[s].index.count / 3, midTris: midGeo[s].index.count / 3, farTris: 2,
    });
  }
  disposables.push(atlas, impAlbedo, impNormal, ...nearGeo, ...midGeo, ...impGeo);

  // Wind: xz direction (the same way the clouds drift in sky.js), strength,
  // time. One uniform object shared by every material that sways.
  const windU = { value: new THREE.Vector4(0.82, 0.57, opts.wind ?? 0.7, 0) };
  const focusU = { value: new THREE.Vector3() };

  const lodU = (a, b, c, d) => ({ value: new THREE.Vector4(a, b, c, d) });
  const U = {
    near: lodU(-2, -1, 1e6, 2e6), mid: lodU(-2, -1, 1e6, 2e6), far: lodU(-2, -1, 1e6, 2e6),
    bushNear: lodU(-2, -1, 1e6, 2e6), bushMid: lodU(-2, -1, 1e6, 2e6), bushFar: lodU(-2, -1, 1e6, 2e6),
    rockNear: lodU(-2, -1, 1e6, 2e6), rockFar: lodU(-2, -1, 1e6, 2e6), stone: lodU(-2, -1, 1e6, 2e6),
    landmark: lodU(-2, -1, 1e6, 2e6),
  };

  // The biome field over the map, for the canopy, impostor and rock shaders
  // (BIO_VERT above). 256 texels over 4 km is 16 m a texel, finer than any
  // biome border by an order of magnitude. A world with no biome field gets
  // a single empty texel, and every plant stays as it was.
  const bioTex = (() => {
    const b = world.biomes;
    const k = b && b.bake ? b.bake(256, groundY0) : { px: new Uint8Array(4), size: 1 };
    const t = new THREE.DataTexture(k.px, k.size, k.size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  })();
  disposables.push(bioTex);
  const bioU = { value: bioTex };
  const bioOn = { value: new THREE.Vector2(1 / (2 * half), 1) };
  const bioOff = { value: new THREE.Vector2(1 / (2 * half), 0) };

  const canopyMat = (lod, bk = bioOn) => inject(new THREE.MeshLambertMaterial({
    vertexColors: true, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide,
  }), 'canopy', { orLod: lod, orWind: windU, orFocus: focusU, orBiome: bioU, orBiomeK: bk });
  const impostorMat = (lod, bk = bioOn) => inject(new THREE.MeshLambertMaterial({
    map: impAlbedo, alphaTest: 0.5, side: THREE.DoubleSide,
  }), 'impostor', { orLod: lod, orNormalMap: { value: impNormal }, orFocus: focusU, orBiome: bioU, orBiomeK: bk });
  const rockTex = rockTexture((seed | 0) + 77);
  disposables.push(rockTex);
  const rockMat = (lod) => inject(new THREE.MeshLambertMaterial({ vertexColors: true }), 'rock',
    { orLod: lod, orFocus: focusU, orRockTex: { value: rockTex }, orBiome: bioU, orBiomeK: bioOn });

  const mats = {
    near: canopyMat(U.near), mid: canopyMat(U.mid), far: impostorMat(U.far),
    bushNear: canopyMat(U.bushNear), bushMid: canopyMat(U.bushMid), bushFar: impostorMat(U.bushFar),
    rockNear: rockMat(U.rockNear), rockFar: rockMat(U.rockFar), stone: rockMat(U.stone),
    // The landmarks' rock carries its own bed colours (landmarks.js), so the
    // biome map does not redden it a second time.
    landmark: inject(new THREE.MeshLambertMaterial({ vertexColors: true }), 'rock',
      { orLod: U.landmark, orFocus: focusU, orRockTex: { value: rockTex }, orBiome: bioU, orBiomeK: bioOff }),
    // Palms and cacti share the trees' distances but not their recolouring:
    // a cactus is green BECAUSE it is in the desert.
    exNear: canopyMat(U.near, bioOff), exMid: canopyMat(U.mid, bioOff), exFar: impostorMat(U.far, bioOff),
  };
  // The depth pass sees the mid level's own LOD uniform only to satisfy the
  // shader's declarations; OR_SHADOW switches the collapse off, because the
  // "camera" in a shadow pass is the sun.
  const depthMat = windDepth({ orLod: U.mid, orWind: windU, orFocus: focusU });
  disposables.push(...Object.values(mats), depthMat);

  const poleMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const lampMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
    emissive: new THREE.Color(0xffb356), emissiveIntensity: 0,
  });
  const poolTex = discTexture([255, 226, 178], 1.0, 2.1);
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex, color: 0xffc98a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const shadeTex = discTexture([0, 0, 0], 1.0, 1.5);
  const shadeMat = new THREE.MeshBasicMaterial({
    map: shadeTex, color: 0x000000, transparent: true, opacity: 0.40,
    depthWrite: false, toneMapped: false,
  });
  disposables.push(poleMat, lampMat, poolMat, shadeMat, poolTex, shadeTex);

  // -------------------------------------------------------------------------
  // Build the fields
  // -------------------------------------------------------------------------

  const groundY = (x, z) => ground.heightAt(x, z);
  const propY = (p) => (p.y === undefined || p.y === null ? groundY(p.x, p.z) : p.y);

  /**
   * Per-instance tint: a random drift about white per tree, times a slow
   * spatial drift shared by a whole stand, so a hillside of spruce is subtly
   * bluer than the next one over and no two neighbours are twins.
   */
  function tintFrom(r, x, z, spread, sat, o) {
    const stand = valueNoise(x / 190, z / 190, (seed | 0) + 4242);
    const v = (0.84 + r() * 0.30) * (1 + stand * 0.10);
    const h = (r() * 2 - 1) * spread + stand * spread * 0.8;
    o.r = clamp(v * (1 + h), 0.35, 1.5);
    o.g = clamp(v * (1 + h * 0.35 * sat), 0.35, 1.5);
    o.b = clamp(v * (1 - h * 0.9), 0.35, 1.5);
  }

  t0 = clock.now();
  const treeStores = [], bushStores = [];
  for (let v = 0; v < TREES; v++) {
    const d = descs[v];
    const r = mulberry((seed | 0) + 101 + v * 977);
    const conifer = d.kind === 'conifer' || d.name === 'pine';
    treeStores.push(makeStore(treeIdx[v], (p, o) => {
      const s = p.scale || 1;
      o.x = p.x; o.z = p.z;
      o.y = propY(p) - 0.05 * s;
      o.rot = p.rot || 0;
      o.sy = s * (0.90 + r() * 0.2);
      o.sx = o.sz = s * (0.90 + r() * 0.2);
      // Conifers grow plumb; broadleaves lean toward the light, a few degrees.
      const lean = conifer ? 0.025 : 0.07;
      o.lx = (r() * 2 - 1) * lean; o.lz = (r() * 2 - 1) * lean;
      tintFrom(r, p.x, p.z, conifer ? 0.10 : 0.16, 1, o);
    }, true));
  }
  for (let v = 0; v < BUSHES; v++) {
    const r = mulberry((seed | 0) + 211 + v * 577);
    bushStores.push(makeStore(bushIdx[v], (p, o) => {
      const s = p.scale || 1;
      o.x = p.x; o.z = p.z;
      o.y = propY(p) - 0.12 * s;
      o.rot = p.rot || 0;
      o.sy = s * (0.8 + r() * 0.4);
      o.sx = o.sz = s * (0.85 + r() * 0.3);
      o.lx = (r() * 2 - 1) * 0.08; o.lz = (r() * 2 - 1) * 0.08;
      tintFrom(r, p.x, p.z, 0.18, 1, o);
    }, true));
  }
  stats.buildMs.stores = Math.round(clock.now() - t0);

  const treeFields = [];
  for (let v = 0; v < TREES; v++) {
    const st = treeStores[v];
    const name = descs[v].name;
    const near = makeField(st, { name: name + '.near', geometry: nearGeo[v], material: mats.near, maxRadius: MAX.near });
    const mid = makeField(st, { name: name + '.mid', geometry: midGeo[v], material: mats.mid, maxRadius: MAX.mid, depthMaterial: depthMat });
    const far = makeField(st, { name: name + '.far', geometry: impGeo[v], material: mats.far, maxRadius: MAX.far });
    treeFields.push({ near, mid, far });
  }
  // Palms and cacti: fields like the trees', so they cast shadows and hand
  // over between levels exactly as trees do.
  for (const [ex, idx, lean] of [[PALM, palmIdx, 0.05], [CACTUS, cactusIdx, 0.02]]) {
    const r = mulberry((seed | 0) + 131 + ex * 977);
    const st = makeStore(idx, (p, o) => {
      const s2 = p.scale || 1;
      o.x = p.x; o.z = p.z;
      o.y = propY(p) - 0.05 * s2;
      o.rot = p.rot || 0;
      o.sy = s2 * (0.92 + r() * 0.16);
      o.sx = o.sz = s2 * (0.92 + r() * 0.16);
      o.lx = (r() * 2 - 1) * lean; o.lz = (r() * 2 - 1) * lean;
      tintFrom(r, p.x, p.z, 0.07, 1, o);
    }, true);
    const name = descs[ex].name;
    treeFields.push({
      near: makeField(st, { name: name + '.near', geometry: nearGeo[ex], material: mats.exNear, maxRadius: MAX.near }),
      mid: makeField(st, { name: name + '.mid', geometry: midGeo[ex], material: mats.exMid, maxRadius: MAX.mid, depthMaterial: depthMat }),
      far: makeField(st, { name: name + '.far', geometry: impGeo[ex], material: mats.exFar, maxRadius: MAX.far }),
    });
  }

  const bushFields = [];
  for (let v = 0; v < BUSHES; v++) {
    const st = bushStores[v];
    const s = TREES + v;
    const name = descs[s].name;
    bushFields.push({
      near: makeField(st, { name: name + '.near', geometry: nearGeo[s], material: mats.bushNear, maxRadius: MAX.near }),
      mid: makeField(st, { name: name + '.mid', geometry: midGeo[s], material: mats.bushMid, maxRadius: MAX.mid }),
      far: makeField(st, { name: name + '.far', geometry: impGeo[s], material: mats.bushFar, maxRadius: MAX.bushFar }),
    });
  }

  // Rocks: three shapes, each at two resolutions.
  const rnd = mulberry((seed | 0) ^ 0x51ed2f);
  const shapes = [rockShape(rnd, ROCK_TONES[0]), rockShape(rnd, ROCK_TONES[1]), rockShape(rnd, ROCK_TONES[2])];
  const rockNearGeo = shapes.map((sh) => rockGeometry(sh, 3));
  const rockFarGeo = shapes.map((sh) => rockGeometry(sh, 1));
  disposables.push(...rockNearGeo, ...rockFarGeo);
  for (let v = 0; v < 3; v++) {
    const r = mulberry((seed | 0) + 401 + v * 613);
    const st = makeStore(rockIdx[v], (p, o) => {
      const s = p.scale || 1;
      o.x = p.x; o.z = p.z;
      // Buried by a third of its height, so a boulder sits in the hillside
      // instead of balancing on it.
      o.y = propY(p) - 0.12 * s;
      o.rot = p.rot || 0;
      o.lx = (r() * 2 - 1) * 0.22; o.lz = (r() * 2 - 1) * 0.22;
      o.sx = s * (0.85 + r() * 0.35);
      o.sy = s * (0.80 + r() * 0.40);
      o.sz = s * (0.85 + r() * 0.35);
      tintFrom(r, p.x, p.z, 0.06, 0.3, o);
    }, true);
    makeField(st, { name: 'rock' + v + '.near', geometry: rockNearGeo[v], material: mats.rockNear, maxRadius: MAX.rockNear });
    makeField(st, { name: 'rock' + v + '.far', geometry: rockFarGeo[v], material: mats.rockFar, maxRadius: MAX.rockFar });
  }
  {
    const r = mulberry((seed | 0) + 733);
    const st = makeStore(stoneIdx, (p, o) => {
      const s = p.scale || 0.3;
      o.x = p.x; o.z = p.z;
      o.y = propY(p) - 0.10 * s;
      o.rot = p.rot || 0;
      o.lx = (r() * 2 - 1) * 0.3; o.lz = (r() * 2 - 1) * 0.3;
      o.sx = s * (0.8 + r() * 0.4); o.sy = s * (0.6 + r() * 0.4); o.sz = s * (0.8 + r() * 0.4);
      tintFrom(r, p.x, p.z, 0.06, 0.3, o);
    }, true);
    makeField(st, { name: 'stones', geometry: rockFarGeo[(seed | 0) % 3 === 0 ? 1 : 0], material: mats.stone, maxRadius: MAX.stone });
  }

  // Where each lamp head actually hangs, in the pole's local +Z. Used to put
  // the light pool under the lamp rather than under the pole.
  const STREET_ARM = 1.86;
  const POLE_ARM = 0.50;
  const lrnd = mulberry((seed | 0) ^ 0x2f1a);
  const streetGeo = streetlightBody(lrnd);
  const poleGeo = polelightBody(lrnd);
  const streetLampGeo = lampGeometry(0.56, 0.16, 0.34, 0, 6.92, 1.86, 0xc4c8cc, lrnd);
  const poleLampGeo = lampGeometry(0.42, 0.14, 0.30, 0, 6.02, 0.50, 0xc4c8cc, lrnd);
  const decalGeo = decalGeometry();
  disposables.push(streetGeo, poleGeo, streetLampGeo, poleLampGeo, decalGeo);

  function lightPlace(p, o) {
    o.x = p.x; o.z = p.z;
    // The prop carries the carriageway height; the pole stands a lane and a
    // half off it, on graded verge, so ask the ground where it really is.
    o.y = groundY(p.x, p.z) - 0.05;
    o.rot = p.rot || 0;
    o.sx = o.sy = o.sz = p.scale || 1;
  }
  const fixed = (r) => ({ maxRadius: r });

  const streetField = makeField(makeStore(streetIdx, lightPlace, false),
    { name: 'streetlights', geometry: streetGeo, material: poleMat, ...fixed(330) });
  if (streetField) shareInstances(streetField, streetLampGeo, lampMat, 'streetlamps');
  const poleField = makeField(makeStore(poleIdx, lightPlace, false),
    { name: 'polelights', geometry: poleGeo, material: poleMat, ...fixed(330) });
  if (poleField) shareInstances(poleField, poleLampGeo, lampMat, 'polelamps');

  const poolField = makeField(makeStore(lightIdx, (p, o) => {
    const s = p.scale || 1;
    const arm = (p.type === 'streetlight' ? STREET_ARM : POLE_ARM) * s;
    const rot = p.rot || 0;
    // Local +Z under a Y rotation lands at (sin rot, cos rot).
    o.x = p.x + Math.sin(rot) * arm;
    o.z = p.z + Math.cos(rot) * arm;
    // Lifted a hand's width and drawn without depth writes. Streetlights
    // stand on graded verge beside a flat carriageway, so a flat quad is a
    // good enough stand-in for a projected decal and costs one triangle pair.
    o.y = groundY(o.x, o.z) + 0.10;
    o.rot = rot;
    o.sx = o.sy = o.sz = (p.type === 'streetlight' ? 7.4 : 5.6) * s;
  }, false), { name: 'lightpools', geometry: decalGeo, material: poolMat, ...fixed(260), renderOrder: 3 });
  if (poolField) poolField.mesh.visible = false;

  // ---- Landmarks (render/landmarks.js, placed by world/layout.js) ---------
  // A few big shapes seen from a kilometre, streamed and dithered out at the
  // far edge like everything else; arches and hoodoos cast shadows, because
  // driving through an arch's shadow is half of driving under it.
  const LM = world.landmarks || [];
  const archIdx = [[], []], hoodooIdx = [[], [], [], []], houseIdx = [], poleIdx2 = [];
  for (let i = 0; i < LM.length; i++) {
    const l = LM[i];
    if (l.type === 'arch') archIdx[(l.variant | 0) % 2].push(i);
    else if (l.type === 'hoodoo') hoodooIdx[(l.variant | 0) % 4].push(i);
    else if (l.type === 'lighthouse') houseIdx.push(i);
    else if (l.type === 'snowpole') poleIdx2.push(i);
  }
  const lmr = mulberry((seed | 0) + 9107);
  const ARCH_SPAN = 33.5, ARCH_H = 20;
  const lmPlace = (p, o) => {
    o.x = p.x; o.z = p.z; o.y = p.y; o.rot = p.rot || 0;
    const sc = p.scale || 1;
    o.sx = o.sz = o.sy = sc;
    if (p.type === 'arch') { o.sx = (p.span || ARCH_SPAN) / ARCH_SPAN; o.sy = (p.height || ARCH_H) / ARCH_H; o.sz = 1; }
  };
  const landmarkFields = [];
  const lmField = (idx, name, geo, mat, radius, shadow) => {
    if (!idx.length) return null;
    disposables.push(geo);
    const f = makeField(makeStore(idx, lmPlace, false, LM), { name, geometry: geo, material: mat, maxRadius: radius });
    if (f && shadow) { f.mesh.castShadow = true; f.mesh.receiveShadow = true; }
    if (f) landmarkFields.push(f);
    return f;
  };
  for (let v = 0; v < 2; v++) lmField(archIdx[v], 'arch' + v, archGeometry(lmr, ARCH_SPAN, ARCH_H), mats.landmark, 1050, true);
  for (let v = 0; v < 4; v++) lmField(hoodooIdx[v], 'hoodoo' + v, hoodooGeometry(lmr, 18), mats.landmark, 1050, true);
  lmField(poleIdx2, 'snowpoles', snowPoleGeometry(), poleMat, 240, false);
  // The lighthouse: body, a lantern that glows at dusk, and a beam that
  // sweeps round twice a minute after dark — the one moving light on the
  // coast, visible from across the bay.
  let lantern = null, beam = null, beamMat = null, lanternMat = null;
  if (houseIdx.length) {
    const lh = lighthouseGeometry(mergeGeometries);
    const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    lanternMat = new THREE.MeshBasicMaterial({ color: 0x9fb7c2, toneMapped: false, side: THREE.DoubleSide });
    disposables.push(bodyMat, lanternMat, lh.lamp);
    const bf = lmField(houseIdx, 'lighthouse', lh.body, bodyMat, 1050, true);
    const L0 = LM[houseIdx[0]];
    lantern = new THREE.Mesh(lh.lamp, lanternMat);
    lantern.name = 'lighthouse.lantern';
    lantern.position.set(L0.x, L0.y, L0.z);
    lantern.matrixAutoUpdate = false;
    lantern.updateMatrix();
    group.add(lantern);
    const bg = beamGeometry();
    beamMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: 'attribute float fade; varying float vF; void main() { vF = fade; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: 'uniform float uOpacity; varying float vF; void main() { gl_FragColor = vec4( vec3( 1.0, 0.93, 0.78 ) * vF * vF * uOpacity, 1.0 ); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    disposables.push(bg, beamMat);
    beam = new THREE.Mesh(bg, beamMat);
    beam.name = 'lighthouse.beam';
    beam.position.set(L0.x, L0.y, L0.z);
    beam.frustumCulled = false;
    beam.renderOrder = 7;
    beam.visible = false;
    group.add(beam);
    if (!bf) lantern.visible = false;
  }
  // ---- Tumbleweeds -------------------------------------------------------
  // Eight of them, only while the camera is in the canyon, rolling downwind
  // across the flats and the road and bouncing as they go — the one thing
  // in the desert that moves. Not placed props: each is launched upwind of
  // the camera, 60-140 m off, and relaunched once it has rolled 160 m away,
  // so there are always a few about. Cosmetic and local to each player,
  // like the leaves and the snow. Eight ground lookups a frame.
  const tumble = (() => {
    const bio = world.biomes;
    if (!bio) return null;
    const N = 8;
    const geo = tumbleweedGeometry(mulberry((seed | 0) + 9203));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    disposables.push(geo, mat);
    // One slot spare, so a full set never reads as a field out of room.
    const mesh = new THREE.InstancedMesh(geo, mat, N + 1);
    mesh.name = 'tumbleweeds';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    group.add(mesh);
    const x = new Float64Array(N), z = new Float64Array(N), v = new Float64Array(N);
    const roll = new Float64Array(N), hop = new Float64Array(N), sc = new Float64Array(N), age = new Float64Array(N);
    const live = new Uint8Array(N);
    const w = new Float64Array(5);
    const q = new THREE.Quaternion(), qr = new THREE.Quaternion(), ax = new THREE.Vector3();
    const p = new THREE.Vector3(), s3 = new THREE.Vector3(), m = new THREE.Matrix4();
    let amt = 0, rs = (seed | 0) ^ 0x7b1d;
    const r = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    function launch(i, cx, cz, wx, wz) {
      // Upwind of the camera and off to one side or the other.
      const d = 60 + r() * 80, side = (r() * 2 - 1) * 110;
      x[i] = cx - wx * d - wz * side; z[i] = cz - wz * d + wx * side;
      v[i] = 3 + r() * 3.5; roll[i] = r() * 6.28; hop[i] = r() * 6.28; sc[i] = 1.1 + r() * 0.7; age[i] = 0;
      live[i] = 1;
    }
    function update(cx, cz, step) {
      bio.weightsAt(cx, cz, w);
      const want = smoothstep(0.5, 0.85, w[1]);
      amt += (want - amt) * (step > 0 ? Math.min(1, step * 0.8) : 1);
      if (amt < 0.01) { mesh.count = 0; mesh.visible = false; live.fill(0); return; }
      mesh.visible = true;
      const wx = windU.value.x, wz = windU.value.y;
      let n = 0;
      for (let i = 0; i < N; i++) {
        if (!live[i] || (x[i] - cx) ** 2 + (z[i] - cz) ** 2 > 160 * 160) launch(i, cx, cz, wx, wz);
        // Rolls with the wind, gusting, and slows to a stop in the lee of
        // nothing: it only ever goes downwind.
        const gust = 0.7 + 0.3 * Math.sin(windTime * 0.6 + i * 1.7);
        const sp = v[i] * gust * windU.value.z * 1.4;
        x[i] += wx * sp * step; z[i] += wz * sp * step;
        const rad = 0.55 * sc[i];
        roll[i] += (sp * step) / rad;
        hop[i] += step * (2.2 + sp * 0.35);
        const y = ground.heightAt(x[i], z[i]) + rad * 0.92 + Math.abs(Math.sin(hop[i])) * 0.5 * sc[i];
        // Only on the canyon's own ground, faded in as the canyon is.
        bio.weightsAt(x[i], z[i], w);
        age[i] += step;
        const k = sc[i] * amt * smoothstep(0.4, 0.7, w[1]) * smoothstep(0, 1.5, age[i]);
        if (k < 0.02) continue;
        ax.set(wz, 0, -wx);
        qr.setFromAxisAngle(ax, roll[i]);
        q.setFromAxisAngle(ax.set(0, 1, 0), i * 2.39).premultiply(qr);
        p.set(x[i], y, z[i]); s3.set(k, k, k);
        m.compose(p, q, s3);
        m.toArray(mesh.instanceMatrix.array, n * 16);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    return { update, mesh };
  })();

  stats.landmarks = { arches: archIdx[0].length + archIdx[1].length, hoodoos: hoodooIdx.reduce((a, b) => a + b.length, 0),
    lighthouses: houseIdx.length, snowpoles: poleIdx2.length };

  let shadeField = null;
  if (wantShade) {
    shadeField = makeField(makeStore(shadeIdx, (p, o) => {
      const d = descs[clamp(p.variant | 0, 0, TREES - 1)];
      const s = p.scale || 1;
      o.x = p.x; o.z = p.z;
      o.y = propY(p) + 0.07;
      o.rot = p.rot || 0;
      o.sx = o.sy = o.sz = d.spread * 0.55 * s;
    }, false), { name: 'treeshadows', geometry: decalGeo, material: shadeMat, ...fixed(130), renderOrder: 2 });
  }

  // -------------------------------------------------------------------------
  // Quality
  // -------------------------------------------------------------------------

  let tier = 'high';
  let night = 0;
  let windTime = 0;
  let primed = false;

  /** Set a level's fade band: in from `a`, out at `b` (either may be absent). */
  function band(u, a, b) {
    const v = u.value;
    if (a > 0) { v.x = a * (1 - BAND * 0.5); v.y = a * (1 + BAND * 0.5); } else { v.x = -2; v.y = -1; }
    if (b > 0) { v.z = b * (1 - BAND * 0.5); v.w = b * (1 + BAND * 0.5); } else { v.z = 1e6; v.w = 2e6; }
  }

  function applyTier() {
    const T = TIERS[tier];
    const n = T.near * range, m = T.mid * range, f = T.far * range, bf = T.bushFar * range;
    band(U.near, 0, n); band(U.mid, n, m); band(U.far, m, f);
    band(U.bushNear, 0, n); band(U.bushMid, n, m); band(U.bushFar, m, bf);
    band(U.rockNear, 0, T.rockNear * range); band(U.rockFar, T.rockNear * range, T.rockFar * range);
    band(U.stone, 0, T.stone * range);
    // The landmarks fade out just inside the far edge of their field.
    band(U.landmark, 0, T.far * range * 0.98);
    // A field keeps everything out to the far side of its outer band.
    const reach = (x) => x * (1 + BAND * 0.5);
    for (const f2 of fields) {
      // Small fields rebuild more often and carry a smaller margin; a near
      // tree is eight hundred triangles and every metre of margin is paid
      // for all the way round the circle.
      f2.step = clamp(f2.spec.maxRadius * range * 0.12, 8, 24);
      const name = f2.name;
      if (name.endsWith('.near')) f2.radius = reach(name.startsWith('rock') ? T.rockNear * range : n);
      else if (name.endsWith('.mid')) f2.radius = reach(m);
      else if (name.endsWith('.far')) {
        f2.radius = reach(name.startsWith('rock') ? T.rockFar * range
          : f2.mesh.material === mats.bushFar ? bf : f);
      } else if (name === 'stones') f2.radius = reach(T.stone * range);
      else f2.radius = f2.spec.maxRadius * range * (tier === 'low' ? 0.6 : tier === 'medium' ? 0.8 : 1);
      if (f2.step > f2.radius * 0.3) f2.step = Math.max(8, f2.radius * 0.3);
      f2.dirty = true;
      // A level with no radius is switched off outright rather than drawn
      // with every instance collapsed.
      f2.mesh.visible = f2.radius > 0 && !(f2.name === 'lightpools' || f2.name === 'treeshadows');
    }
    setNight(night);   // pools and contact shadows own their own visibility
    for (const tf of treeFields) {
      if (tf.mid) tf.mid.mesh.castShadow = T.shadows;
      if (tf.near) tf.near.mesh.receiveShadow = T.shadows;
      if (tf.mid) tf.mid.mesh.receiveShadow = false;
    }
  }

  /**
   * 'low' | 'medium' | 'high' ('ultra' is 'high'), or a 0..1 number. This is
   * what main.js calls with settings.quality.
   */
  function setQuality(q) {
    tier = tierOf(q);
    applyTier();
    setNight(night);   // shadow decals are gated on quality
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  function update(cameraPos, dt) {
    if (!cameraPos) return;
    const cx = cameraPos.x, cz = cameraPos.z;
    const step = dt > 0 && dt < 0.25 ? dt : 0;
    windTime += step;
    // Wrapped well before float precision matters to a sine in the shader.
    if (windTime > 3600) windTime -= 3600;
    windU.value.w = windTime;
    if (beam && beam.visible) beam.rotation.y = (windTime * 0.21) % (Math.PI * 2);
    if (tumble) tumble.update(cx, cz, step);

    if (!primed) {
      primed = true;
      for (let i = 0; i < fields.length; i++) if (fields[i].mesh.visible) fields[i].refresh(cx, cz);
      return;
    }

    // The stalest field refreshes, and a second one too if it is already
    // past its margin — which only happens at very high speed or after a stall.
    // A frame that has already overrun defers anything short of genuinely wrong.
    const late = dt > 0.05;
    focusU.value.set(cx, cameraPos.y, cz);
    for (let pass = 0; pass < 3; pass++) {
      // Staleness in units of each field's own step: 1 means due, 1.5 means
      // its margin is nearly spent.
      let best = null, bestK = 0;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (!f.mesh.visible) continue;
        const dx = cx - f.atX, dz = cz - f.atZ;
        const k = f.dirty ? 1e9 : (dx * dx + dz * dz) / (f.step * f.step);
        if (k > bestK) { bestK = k; best = f; }
      }
      if (!best || bestK < 1) break;
      if (late && bestK < 2.25) break;
      best.refresh(cx, cz);
      if (bestK < 2.25) break;
    }
  }

  /** 0 = midday, 1 = full dark. */
  function setNight(t) {
    night = clamp(t, 0, 1);
    const lit = smoothstep(0.18, 0.72, night);
    lampMat.emissiveIntensity = lit * 2.6;
    if (lanternMat) {
      // Pale glass by day, the lamp by night (unlit, so it reads as a light).
      lanternMat.color.setRGB(lerp(0.62, 4.0, lit), lerp(0.72, 3.4, lit), lerp(0.76, 2.2, lit));
      beamMat.uniforms.uOpacity.value = smoothstep(0.35, 0.8, night) * 0.16;
      beam.visible = beamMat.uniforms.uOpacity.value > 0.002;
    }
    if (poolField) {
      poolMat.opacity = lit * 0.85;
      const on = poolMat.opacity > 0.01;
      if (on && !poolField.mesh.visible) poolField.dirty = true;
      poolField.mesh.visible = on;
    }
    if (shadeField) {
      // Sun shadows go with the sun. Leaving them on after dark would paint
      // black discs under trees lit only by a streetlight. With real shadow
      // maps at 'high' the disc is only the contact darkening under a crown.
      const k = tier === 'high' ? 0.30 : tier === 'medium' ? 0.42 : 0;
      shadeMat.opacity = (1 - lit) * k;
      const on = shadeMat.opacity > 0.01;
      if (on && !shadeField.mesh.visible) shadeField.dirty = true;
      shadeField.mesh.visible = on;
    }
  }

  /** Wind strength, 0 (still) to ~2 (a gale). main.js can tie it to weather. */
  function setWind(strength, dirX, dirZ) {
    windU.value.z = clamp(strength, 0, 3);
    if (dirX !== undefined && dirZ !== undefined) {
      const l = Math.hypot(dirX, dirZ) || 1;
      windU.value.x = dirX / l; windU.value.y = dirZ / l;
    }
  }

  /** What is drawn right now: instances and triangles, per level and in total. */
  function drawn() {
    const r = { instances: 0, triangles: 0, calls: 0, byLevel: { near: 0, mid: 0, far: 0, other: 0 } };
    for (const f of fields) {
      if (!f.mesh.visible || f.mesh.count === 0) continue;
      const tris = f.mesh.count * f.tris;
      r.instances += f.mesh.count; r.triangles += tris; r.calls++;
      const lvl = f.name.endsWith('.near') ? 'near' : f.name.endsWith('.mid') ? 'mid' : f.name.endsWith('.far') ? 'far' : 'other';
      r.byLevel[lvl] += tris;
      for (const e of f.extras) { r.triangles += e.count * f.tris; r.calls++; }
    }
    return r;
  }

  function dispose() {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      group.remove(f.mesh);
      f.mesh.dispose();
      // Extras are NOT disposed: InstancedMesh.dispose() makes the renderer
      // free whatever instanceMatrix the mesh is holding, and an extra is
      // holding its owner's. Removing it is enough.
      for (let k = 0; k < f.extras.length; k++) group.remove(f.extras[k]);
      f.extras.length = 0;
    }
    fields.length = 0;
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    group.clear();
  }

  setQuality(opts.quality === undefined ? 'high' : opts.quality);
  setNight(opts.night === undefined ? 0 : opts.night);

  stats.fields = fields.length;
  stats.meshes = group.children.length;

  return { group, update, setNight, setQuality, setWind, dispose, stats, drawn, tiers: TIERS };
}
