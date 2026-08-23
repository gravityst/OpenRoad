// Dust, tyre smoke, rubber, sparks and rain.
//
// COORDINATE CONVENTION — the same one the physics uses, restated because the
// skid-mark quads depend on it and getting it wrong lays marks sideways:
//
//   forward = -Z      right = +X      up = +Y      yaw grows counter-clockwise
//   forward = (-sin yaw, 0, -cos yaw)      right = (cos yaw, 0, -sin yaw)
//
// WHY EVERYTHING IS A FIXED POOL
//
// This is the one system that runs for every wheel of every visible car on
// every frame. An object literal here is not one allocation, it is four per car
// per frame — the classic recipe for a collection pause that shows up as a hitch
// mid-corner and nowhere else. So: typed arrays sized once at construction, a
// live count, swap-remove on death, and nothing created after this factory
// returns. When a pool is full the emit call drops the request rather than
// growing; a puff you never see is cheaper than a stutter you do.
//
// WHY INSTANCED QUADS AND NOT POINT SPRITES
//
// gl_PointSize sprites are cheaper to feed but they are clipped by their CENTRE:
// a two-metre smoke puff vanishes the instant its centre crosses the edge of the
// screen, which is precisely when it is largest and most obvious. They are also
// capped at an implementation-defined maximum size, so a puff near the camera
// stops growing. Quads billboarded in view space have neither problem and cost
// one extra vec3 attribute.
//
// BLENDING AND DEPTH
//
// Nothing here writes depth, so particles never occlude one another — they only
// occlude against the solid world, which is what you want. Dust, smoke, splash
// and skid marks are alpha-blended and take the scene fog through three's own
// chunk. Sparks are additive and instead fade their ALPHA with fog distance,
// because mixing an additive colour toward the fog colour makes a distant spark
// brighter rather than dimmer. Nothing is sorted against anything else — with
// one draw call per system there is nothing to sort — which is why smoke is many
// overlapping low-alpha puffs rather than a few dense ones.

import * as THREE from '/Users/curtis/Developer/OpenRoad/vendor/three/build/three.module.js';
import { clamp, fbm } from '../world/noise.js';

const BILLOW_DUST = 0, BILLOW_SMOKE = 1, BILLOW_SPLASH = 2;

// sRGB hex -> linear working space, done by hand and cached.
//
// THREE.Color.setHex() would do this correctly but it routes through the colour
// management machinery, and emitDust() is called with the same surface colour
// thousands of times a second. One cached conversion per distinct surface costs
// nothing; the general path costs a transform per particle.
let cachedHex = -1, cachedR = 1, cachedG = 1, cachedB = 1;
function srgbChannel(c) {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
function unpackColour(hex) {
  if (hex === cachedHex) return;
  cachedHex = hex;
  cachedR = srgbChannel(((hex >> 16) & 255) / 255);
  cachedG = srgbChannel(((hex >> 8) & 255) / 255);
  cachedB = srgbChannel((hex & 255) / 255);
}

/**
 * A soft puff. The noise term is scaled by radius so it only bites near the rim:
 * a perfectly circular blob reads as an airbrushed dot no matter what you tint
 * it, but a ragged edge over a dense core reads as a clump of airborne grit.
 */
function makePuffTexture(size, seed, anisotropy) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.hypot(dx, dy);
      const rim = clamp(r * 1.5, 0, 1);
      const warped = clamp(r * (1 + fbm(dx * 3.1, dy * 3.1, seed, 4) * 0.30 * rim), 0, 1);
      let a = 1 - warped;
      a = a * a * (3 - 2 * a);
      a *= 0.62 + 0.38 * (0.5 + 0.5 * fbm(dx * 6.3 + 11, dy * 6.3 - 4, seed + 7717, 3));
      const o = (y * size + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;   // only the alpha channel is ever read
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Unit quad in the XY plane, ready to be billboarded per instance. */
function quadBase() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Fog uniforms the renderer refreshes for us; the values here are placeholders. */
function fogUniforms(u) {
  u.fogColor = { value: new THREE.Color(0xffffff) };
  u.fogDensity = { value: 0.00025 };
  u.fogNear = { value: 1 };
  u.fogFar = { value: 2000 };
  return u;
}

export function createParticles(scene, opts = {}) {
  const density = clamp(opts.density ?? 1, 0.12, 1);
  const MAX_BILLOW = Math.max(96, Math.round((opts.maxBillow ?? 1600) * density));
  const MAX_SPARK = Math.max(32, Math.round((opts.maxSpark ?? 512) * density));
  const MAX_SKID = Math.max(256, Math.round((opts.maxSkid ?? 3072) * density));
  const MAX_RAIN = Math.max(400, Math.round((opts.maxRain ?? 7000) * density));
  const LANES = Math.max(4, opts.skidLanes ?? 24);

  const SKID_LIFE = opts.skidLife ?? 26;        // s until a mark has gone
  const SKID_HALF = opts.skidWidth ?? 0.15;     // half the tyre mark, m
  const SKID_LIFT = 0.025;                      // m above the road, with polygon offset
  const SKID_STAMP = 1.2;                       // length of a lane-less stamp, m
  const SKID_MIN_STEP = 0.30;                   // shortest ribbon segment worth laying
  const SKID_MAX_STEP = 7.0;                    // longer than this, the lane restarted
  const SKID_MAX_GAP = 0.30;                    // s of silence that also restarts a lane

  const CULL = opts.cullDistance ?? 320;
  const CULL_SQ = CULL * CULL;
  const SIZE_CAP = 5.0;
  const WIND_X = opts.windX ?? 0.5;
  const WIND_Z = opts.windZ ?? 0.3;
  const ground = opts.ground || null;

  const group = new THREE.Group();
  group.name = 'particles';
  group.matrixAutoUpdate = false;
  group.updateMatrix();

  const puff = makePuffTexture(128, opts.seed ?? 20250822, opts.anisotropy ?? 4);

  // =========================================================================
  // Billows — dust, tyre smoke and splash all share one pool and one draw call
  // =========================================================================
  const aPos = new Float32Array(MAX_BILLOW * 3);
  const aCol = new Float32Array(MAX_BILLOW * 3);
  const aSize = new Float32Array(MAX_BILLOW);
  const aAlpha = new Float32Array(MAX_BILLOW);
  const aRot = new Float32Array(MAX_BILLOW);
  // Simulation state that never reaches the GPU.
  const bVel = new Float32Array(MAX_BILLOW * 3);
  const bAge = new Float32Array(MAX_BILLOW);
  const bLife = new Float32Array(MAX_BILLOW);
  const bSize0 = new Float32Array(MAX_BILLOW);
  const bGrow = new Float32Array(MAX_BILLOW);
  const bAlpha0 = new Float32Array(MAX_BILLOW);
  const bDrag = new Float32Array(MAX_BILLOW);
  const bRise = new Float32Array(MAX_BILLOW);
  const bSpin = new Float32Array(MAX_BILLOW);
  const bFade = new Float32Array(MAX_BILLOW);
  const bFloor = new Float32Array(MAX_BILLOW);
  let bAlive = 0;

  const billowGeo = quadBase();
  const attrPos = new THREE.InstancedBufferAttribute(aPos, 3).setUsage(THREE.DynamicDrawUsage);
  const attrCol = new THREE.InstancedBufferAttribute(aCol, 3).setUsage(THREE.DynamicDrawUsage);
  const attrSize = new THREE.InstancedBufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage);
  const attrAlpha = new THREE.InstancedBufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage);
  const attrRot = new THREE.InstancedBufferAttribute(aRot, 1).setUsage(THREE.DynamicDrawUsage);
  billowGeo.setAttribute('iPos', attrPos);
  billowGeo.setAttribute('iCol', attrCol);
  billowGeo.setAttribute('iSize', attrSize);
  billowGeo.setAttribute('iAlpha', attrAlpha);
  billowGeo.setAttribute('iRot', attrRot);
  billowGeo.instanceCount = 0;

  const billowMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({ uPuff: { value: puff } }),
    fog: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec3 iPos;
      attribute vec3 iCol;
      attribute float iSize;
      attribute float iAlpha;
      attribute float iRot;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vUv = position.xy + 0.5;
        vCol = iCol;
        vAlpha = iAlpha;
        // Billboard in VIEW space: adding to mvPosition.xy faces the quad at the
        // camera plane exactly, with no per-instance basis to upload.
        vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
        float s = sin(iRot), c = cos(iRot);
        vec2 q = position.xy * iSize;
        mvPosition.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D uPuff;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float a = texture2D(uPuff, vUv).a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });

  const billowMesh = new THREE.Mesh(billowGeo, billowMat);
  billowMesh.name = 'billows';
  billowMesh.frustumCulled = false;   // instance offsets live in the shader
  billowMesh.renderOrder = (opts.renderOrder ?? 10) + 1;
  group.add(billowMesh);

  // =========================================================================
  // Sparks — additive, velocity-aligned streaks
  // =========================================================================
  const sPos = new Float32Array(MAX_SPARK * 3);
  const sVel = new Float32Array(MAX_SPARK * 3);
  const sAge = new Float32Array(MAX_SPARK);      // normalised 0..1, uploaded
  const sLen = new Float32Array(MAX_SPARK);
  const sBright = new Float32Array(MAX_SPARK);
  const spSeconds = new Float32Array(MAX_SPARK);
  const spLife = new Float32Array(MAX_SPARK);
  const spFloor = new Float32Array(MAX_SPARK);
  let sAlive = 0;

  const sparkGeo = quadBase();
  const attrSPos = new THREE.InstancedBufferAttribute(sPos, 3).setUsage(THREE.DynamicDrawUsage);
  const attrSVel = new THREE.InstancedBufferAttribute(sVel, 3).setUsage(THREE.DynamicDrawUsage);
  const attrSAge = new THREE.InstancedBufferAttribute(sAge, 1).setUsage(THREE.DynamicDrawUsage);
  const attrSLen = new THREE.InstancedBufferAttribute(sLen, 1).setUsage(THREE.DynamicDrawUsage);
  const attrSBright = new THREE.InstancedBufferAttribute(sBright, 1).setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('iPos', attrSPos);
  sparkGeo.setAttribute('iVel', attrSVel);
  sparkGeo.setAttribute('iAge', attrSAge);
  sparkGeo.setAttribute('iLen', attrSLen);
  sparkGeo.setAttribute('iBright', attrSBright);
  sparkGeo.instanceCount = 0;

  const sparkMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({ uWidth: { value: 0.05 } }),
    fog: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec3 iPos;
      attribute vec3 iVel;
      attribute float iAge;
      attribute float iLen;
      attribute float iBright;
      uniform float uWidth;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vBright;
      #include <fog_pars_vertex>
      void main() {
        vUv = position.xy + 0.5;
        // Cooling ramp: white-hot, then orange, then a dull red ember.
        vec3 hot  = vec3(1.00, 0.95, 0.80);
        vec3 mid  = vec3(1.00, 0.52, 0.11);
        vec3 cold = vec3(0.72, 0.11, 0.02);
        vCol = iAge < 0.42 ? mix(hot, mid, iAge / 0.42) : mix(mid, cold, (iAge - 0.42) / 0.58);
        vBright = iBright * (1.0 - iAge) * (1.0 - iAge);

        vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
        // Stretch along the SCREEN-space velocity so the streak points where the
        // spark is actually going, whatever the camera is doing.
        vec3 mvVel = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
        float l = length(mvVel.xy);
        vec2 dir = l > 1e-4 ? mvVel.xy / l : vec2(0.0, 1.0);
        vec2 perp = vec2(-dir.y, dir.x);
        mvPosition.xy += dir * (position.y * (uWidth + iLen)) + perp * (position.x * uWidth);
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vBright;
      #include <fog_pars_fragment>
      void main() {
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float along = 1.0 - abs(vUv.y * 2.0 - 1.0) * 0.82;
        float a = across * across * along * vBright;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Additive light must be attenuated, not tinted: mixing toward the fog
        // colour would make a distant spark BRIGHTER than a near one.
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor.a *= 1.0 - fogFactor;
        #endif
      }
    `,
  });

  const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
  sparkMesh.name = 'sparks';
  sparkMesh.frustumCulled = false;
  sparkMesh.renderOrder = (opts.renderOrder ?? 10) + 2;
  group.add(sparkMesh);

  // =========================================================================
  // Skid marks — a ring buffer of ground-hugging quads
  // =========================================================================
  // Once a quad is written it is never touched again: the fade is a function of
  // (now - birth) evaluated in the vertex shader, so a hundred metres of drift
  // costs one uniform update per frame and nothing else. Expired quads collapse
  // to a degenerate clip position rather than being rasterised and discarded.
  const kPos = new Float32Array(MAX_SKID * 18);          // 6 verts x vec3
  const kAtt = new Float32Array(MAX_SKID * 18);          // 6 verts x (alpha, birth, across)
  for (let i = 1; i < kAtt.length; i += 3) kAtt[i] = -1e6;   // born long ago = invisible
  let kCursor = 0;
  let kLo = -1, kHi = -1;
  let laid = 0;                                          // quads written this frame                                // dirty span, in quads

  const skidGeo = new THREE.BufferGeometry();
  const attrKPos = new THREE.BufferAttribute(kPos, 3).setUsage(THREE.DynamicDrawUsage);
  const attrKAtt = new THREE.BufferAttribute(kAtt, 3).setUsage(THREE.DynamicDrawUsage);
  skidGeo.setAttribute('position', attrKPos);
  skidGeo.setAttribute('aSkid', attrKAtt);
  skidGeo.setDrawRange(0, MAX_SKID * 6);   // every slot is drawn; dead ones self-cull

  const skidMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({
      uTime: { value: 0 },
      uLife: { value: SKID_LIFE },
      uColour: { value: new THREE.Color(opts.skidColour ?? 0x14141a) },
    }),
    fog: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    vertexShader: `
      attribute vec3 aSkid;     // x = intensity, y = birth time, z = across (-1..1)
      uniform float uTime;
      uniform float uLife;
      varying float vAlpha;
      varying float vAcross;
      #include <fog_pars_vertex>
      void main() {
        float age = (uTime - aSkid.y) / uLife;
        // Rubber holds its colour and then goes quickly, rather than dimming
        // from the moment it is laid.
        vAlpha = aSkid.x * (1.0 - smoothstep(0.55, 1.0, age));
        vAcross = aSkid.z;
        if (age > 1.0 || vAlpha <= 0.0) {
          // Degenerate: all three corners land on the same clip point, so the
          // triangle has no area and never reaches the rasteriser.
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColour;
      varying float vAlpha;
      varying float vAcross;
      #include <fog_pars_fragment>
      void main() {
        float e = vAcross * vAcross;
        float a = vAlpha * (1.0 - e * e);   // soft shoulders, like a real smear
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColour, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });

  const skidMesh = new THREE.Mesh(skidGeo, skidMat);
  skidMesh.name = 'skidMarks';
  skidMesh.frustumCulled = false;   // the ring buffer spans the whole map
  skidMesh.renderOrder = opts.renderOrder ?? 10;
  group.add(skidMesh);

  // Per-lane ribbon state, so consecutive stamps from one tyre share an edge
  // instead of overlapping. Overlapping alpha quads double-darken and turn a
  // skid into a row of stripes.
  const laneX = new Float32Array(LANES), laneY = new Float32Array(LANES), laneZ = new Float32Array(LANES);
  const laneLX = new Float32Array(LANES), laneLY = new Float32Array(LANES), laneLZ = new Float32Array(LANES);
  const laneRX = new Float32Array(LANES), laneRY = new Float32Array(LANES), laneRZ = new Float32Array(LANES);
  const laneT = new Float32Array(LANES).fill(-1e6);
  const laneOn = new Uint8Array(LANES);

  // Preallocated upload windows.
  //
  // BufferAttribute.addUpdateRange() pushes a fresh { start, count } every call,
  // which is an allocation per attribute per frame in the one file that must not
  // allocate. updateRanges is a plain public array, so we reuse two objects and
  // push those instead. Uploading the whole 3072-quad buffer would be the other
  // option and costs about 400 kB a frame during a sustained drift.
  const kPosRange = { start: 0, count: 0 };
  const kAttRange = { start: 0, count: 0 };

  // =========================================================================
  // Rain — a camera-following volume, wrapped entirely in the vertex shader
  // =========================================================================
  // The drops are static geometry. Their fall and the wrap around the camera are
  // pure functions of uTime and uCam, so a downpour costs two uniform writes per
  // frame and no buffer traffic at all.
  const rainHalfX = opts.rainRadius ?? 30;
  const rainHalfY = opts.rainHeight ?? 22;
  const rPos = new Float32Array(MAX_RAIN * 6);
  const rTail = new Float32Array(MAX_RAIN * 2);
  const rVar = new Float32Array(MAX_RAIN * 2);
  for (let i = 0; i < MAX_RAIN; i++) {
    const x = (Math.random() * 2 - 1) * rainHalfX;
    const y = (Math.random() * 2 - 1) * rainHalfY;
    const z = (Math.random() * 2 - 1) * rainHalfX;
    const v = 0.75 + Math.random() * 0.6;
    const o = i * 6;
    rPos[o] = x; rPos[o + 1] = y; rPos[o + 2] = z;
    rPos[o + 3] = x; rPos[o + 4] = y; rPos[o + 5] = z;
    rTail[i * 2] = 0; rTail[i * 2 + 1] = 1;
    rVar[i * 2] = v; rVar[i * 2 + 1] = v;
  }

  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
  rainGeo.setAttribute('aTail', new THREE.BufferAttribute(rTail, 1));
  rainGeo.setAttribute('aVar', new THREE.BufferAttribute(rVar, 1));
  rainGeo.setDrawRange(0, 0);

  const rainMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector3(rainHalfX, rainHalfY, rainHalfX) },
      uStreak: { value: new THREE.Vector3(0, -0.5, 0) },
      uFall: { value: opts.rainFall ?? 11 },
      uAlpha: { value: 0 },
      uColour: { value: new THREE.Color(opts.rainColour ?? 0xaec4d8) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    vertexShader: `
      attribute float aTail;
      attribute float aVar;
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec3 uHalf;
      uniform vec3 uStreak;
      uniform float uFall;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.y -= mod(uTime * uFall * aVar, uHalf.y * 2.0);
        // GLSL mod() is floor-based, so this wraps correctly for negative
        // offsets and keeps the volume centred on the camera for free.
        vec3 d = mod(p - uCam + uHalf, uHalf * 2.0) - uHalf;
        vec3 world = uCam + d + aTail * uStreak * aVar;
        vec4 mv = viewMatrix * vec4(world, 1.0);
        // Drop the drops that are on the lens, and taper the rim of the volume
        // so the wrap seam never announces itself.
        float near = smoothstep(0.9, 4.0, length(mv.xyz));
        float rim = 1.0 - smoothstep(uHalf.x * 0.70, uHalf.x, length(d.xz));
        vFade = near * rim;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColour;
      uniform float uAlpha;
      varying float vFade;
      void main() {
        float a = uAlpha * vFade;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColour, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const rainMesh = new THREE.LineSegments(rainGeo, rainMat);
  rainMesh.name = 'rain';
  rainMesh.frustumCulled = false;   // placement happens in the vertex shader
  rainMesh.renderOrder = (opts.renderOrder ?? 10) + 3;
  rainMesh.visible = false;
  group.add(rainMesh);

  if (scene) scene.add(group);

  // =========================================================================
  // Emission
  // =========================================================================
  // Fractional debt, so a caller can ask for 0.4 of a puff every frame and get a
  // steady trickle instead of nothing.
  let dustDebt = 0, smokeDebt = 0, sparkDebt = 0, splashDebt = 0, rainSplashDebt = 0;

  const SMOKE_R = srgbChannel(0.855), SMOKE_G = srgbChannel(0.855), SMOKE_B = srgbChannel(0.875);
  const SPLASH_R = srgbChannel(0.78), SPLASH_G = srgbChannel(0.83), SPLASH_B = srgbChannel(0.87);

  function billowSpawn(kind, x, y, z, r, g, b) {
    if (bAlive >= MAX_BILLOW) return;
    const i = bAlive++;
    const i3 = i * 3;
    const rnd = Math.random;

    aCol[i3] = r; aCol[i3 + 1] = g; aCol[i3 + 2] = b;
    aRot[i] = rnd() * 6.2832;
    bAge[i] = 0;

    // A puff is a camera-facing disc with no thickness, so a big one whose
    // centre sits at road level is half underground and shows a hard line where
    // it intersects. Spawning a little high, drifting up rather than down, and
    // never letting the centre fall below the road keeps the disc where it can
    // be seen. bFloor is also what stops splash droplets falling through tarmac.
    if (kind === BILLOW_DUST) {
      aPos[i3] = x + (rnd() - 0.5) * 0.36;
      aPos[i3 + 1] = y + 0.10 + rnd() * 0.24;
      aPos[i3 + 2] = z + (rnd() - 0.5) * 0.36;
      bVel[i3] = (rnd() - 0.5) * 3.1;
      bVel[i3 + 1] = 0.8 + rnd() * 1.7;
      bVel[i3 + 2] = (rnd() - 0.5) * 3.1;
      bLife[i] = 1.1 + rnd() * 0.9;
      bSize0[i] = 0.45 + rnd() * 0.45;
      bGrow[i] = 1.4 + rnd() * 0.8;
      bAlpha0[i] = 0.28 + rnd() * 0.22;
      bDrag[i] = 1.7;
      bRise[i] = 0.30;                  // heavy grit, but a plume still lifts
      bSpin[i] = (rnd() - 0.5) * 2.2;
      bFade[i] = 0.07;
      bFloor[i] = y;
    } else if (kind === BILLOW_SMOKE) {
      aPos[i3] = x + (rnd() - 0.5) * 0.22;
      aPos[i3 + 1] = y + 0.16 + rnd() * 0.26;
      aPos[i3 + 2] = z + (rnd() - 0.5) * 0.22;
      bVel[i3] = (rnd() - 0.5) * 2.4;
      bVel[i3 + 1] = 1.1 + rnd() * 1.5;
      bVel[i3 + 2] = (rnd() - 0.5) * 2.4;
      bLife[i] = 1.7 + rnd() * 1.3;
      bSize0[i] = 0.55 + rnd() * 0.45;
      bGrow[i] = 2.0 + rnd() * 1.0;
      // Deliberately thin. Tyre smoke is dozens of overlapping puffs; make any
      // one of them dense and the cloud turns into a wall of grey cardboard.
      bAlpha0[i] = 0.13 + rnd() * 0.11;
      bDrag[i] = 1.9;
      bRise[i] = 1.0;
      bSpin[i] = (rnd() - 0.5) * 1.1;
      bFade[i] = 0.12;
      bFloor[i] = y + 0.05;
    } else {
      aPos[i3] = x + (rnd() - 0.5) * 0.14;
      aPos[i3 + 1] = y + 0.02 + rnd() * 0.06;
      aPos[i3 + 2] = z + (rnd() - 0.5) * 0.14;
      bVel[i3] = (rnd() - 0.5) * 3.0;
      bVel[i3 + 1] = 1.4 + rnd() * 2.2;
      bVel[i3 + 2] = (rnd() - 0.5) * 3.0;
      bLife[i] = 0.30 + rnd() * 0.35;
      bSize0[i] = 0.07 + rnd() * 0.13;
      bGrow[i] = 0.45;
      bAlpha0[i] = 0.30 + rnd() * 0.30;
      bDrag[i] = 0.4;
      bRise[i] = -9.5;                  // water falls back, it does not hang
      bSpin[i] = (rnd() - 0.5) * 3.0;
      bFade[i] = 0.02;
      bFloor[i] = y;
    }

    aSize[i] = bSize0[i];
    aAlpha[i] = 0;
  }

  function billowKill(i) {
    const last = --bAlive;
    if (i === last) return;
    const a = i * 3, b = last * 3;
    aPos[a] = aPos[b]; aPos[a + 1] = aPos[b + 1]; aPos[a + 2] = aPos[b + 2];
    aCol[a] = aCol[b]; aCol[a + 1] = aCol[b + 1]; aCol[a + 2] = aCol[b + 2];
    bVel[a] = bVel[b]; bVel[a + 1] = bVel[b + 1]; bVel[a + 2] = bVel[b + 2];
    aSize[i] = aSize[last]; aAlpha[i] = aAlpha[last]; aRot[i] = aRot[last];
    bAge[i] = bAge[last]; bLife[i] = bLife[last];
    bSize0[i] = bSize0[last]; bGrow[i] = bGrow[last]; bAlpha0[i] = bAlpha0[last];
    bDrag[i] = bDrag[last]; bRise[i] = bRise[last];
    bSpin[i] = bSpin[last]; bFade[i] = bFade[last]; bFloor[i] = bFloor[last];
  }

  function emitDust(x, y, z, amount, colourHex) {
    if (!(amount > 0)) return;
    unpackColour(colourHex === undefined ? 0x8a7a5e : colourHex | 0);
    dustDebt += amount;
    let n = dustDebt | 0;
    dustDebt -= n;
    if (n > 24) n = 24;
    // Slight per-puff value scatter so a cloud of one surface colour still has
    // some internal shape.
    for (let k = 0; k < n; k++) {
      const t = 0.82 + Math.random() * 0.36;
      billowSpawn(BILLOW_DUST, x, y, z, cachedR * t, cachedG * t, cachedB * t);
    }
  }

  function emitSmoke(x, y, z, amount) {
    if (!(amount > 0)) return;
    smokeDebt += amount;
    let n = smokeDebt | 0;
    smokeDebt -= n;
    if (n > 24) n = 24;
    for (let k = 0; k < n; k++) {
      const t = 0.90 + Math.random() * 0.18;
      billowSpawn(BILLOW_SMOKE, x, y, z, SMOKE_R * t, SMOKE_G * t, SMOKE_B * t);
    }
  }

  function splash(x, y, z, amount) {
    if (!(amount > 0)) return;
    splashDebt += amount;
    let n = splashDebt | 0;
    splashDebt -= n;
    if (n > 24) n = 24;
    for (let k = 0; k < n; k++) {
      billowSpawn(BILLOW_SPLASH, x, y, z, SPLASH_R, SPLASH_G, SPLASH_B);
    }
  }

  function emitSparks(x, y, z, amount, dirX, dirZ) {
    if (!(amount > 0)) return;
    sparkDebt += amount;
    let n = sparkDebt | 0;
    sparkDebt -= n;
    if (n > 32) n = 32;
    const dl = Math.hypot(dirX || 0, dirZ || 0);
    const ux = dl > 1e-4 ? dirX / dl : 0;
    const uz = dl > 1e-4 ? dirZ / dl : 0;
    const rnd = Math.random;
    for (let k = 0; k < n; k++) {
      if (sAlive >= MAX_SPARK) return;
      const i = sAlive++;
      const i3 = i * 3;
      const speed = 3.5 + rnd() * 9.5;
      sPos[i3] = x; sPos[i3 + 1] = y + 0.02; sPos[i3 + 2] = z;
      sVel[i3] = ux * speed + (rnd() - 0.5) * 4.5;
      sVel[i3 + 1] = 1.0 + rnd() * 3.6;
      sVel[i3 + 2] = uz * speed + (rnd() - 0.5) * 4.5;
      spSeconds[i] = 0;
      spLife[i] = 0.32 + rnd() * 0.60;
      spFloor[i] = y;
      sAge[i] = 0;
      sLen[i] = 0.05;
      sBright[i] = 0.8 + rnd() * 0.6;
    }
  }

  function sparkKill(i) {
    const last = --sAlive;
    if (i === last) return;
    const a = i * 3, b = last * 3;
    sPos[a] = sPos[b]; sPos[a + 1] = sPos[b + 1]; sPos[a + 2] = sPos[b + 2];
    sVel[a] = sVel[b]; sVel[a + 1] = sVel[b + 1]; sVel[a + 2] = sVel[b + 2];
    sAge[i] = sAge[last]; sLen[i] = sLen[last]; sBright[i] = sBright[last];
    spSeconds[i] = spSeconds[last]; spLife[i] = spLife[last]; spFloor[i] = spFloor[last];
  }

  // =========================================================================
  // Skid marks
  // =========================================================================
  let now = 0;

  function writeQuad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, intensity) {
    // Corners arrive as (prevLeft, prevRight, curRight, curLeft).
    const q = kCursor;
    kCursor = (kCursor + 1) % MAX_SKID;
    const p = q * 18;
    kPos[p] = x0; kPos[p + 1] = y0; kPos[p + 2] = z0;
    kPos[p + 3] = x1; kPos[p + 4] = y1; kPos[p + 5] = z1;
    kPos[p + 6] = x2; kPos[p + 7] = y2; kPos[p + 8] = z2;
    kPos[p + 9] = x0; kPos[p + 10] = y0; kPos[p + 11] = z0;
    kPos[p + 12] = x2; kPos[p + 13] = y2; kPos[p + 14] = z2;
    kPos[p + 15] = x3; kPos[p + 16] = y3; kPos[p + 17] = z3;

    const across0 = -1, across1 = 1;
    kAtt[p] = intensity; kAtt[p + 1] = now; kAtt[p + 2] = across0;
    kAtt[p + 3] = intensity; kAtt[p + 4] = now; kAtt[p + 5] = across1;
    kAtt[p + 6] = intensity; kAtt[p + 7] = now; kAtt[p + 8] = across1;
    kAtt[p + 9] = intensity; kAtt[p + 10] = now; kAtt[p + 11] = across0;
    kAtt[p + 12] = intensity; kAtt[p + 13] = now; kAtt[p + 14] = across1;
    kAtt[p + 15] = intensity; kAtt[p + 16] = now; kAtt[p + 17] = across0;

    if (kLo < 0 || q < kLo) kLo = q;
    if (q > kHi) kHi = q;
    laid++;
  }

  /**
   * Lay a tyre mark. Call it every frame while a tyre is marking.
   *
   * Pass a stable `lane` per wheel (0..skidLanes-1) and consecutive calls are
   * welded into a continuous ribbon whose segments share an edge — no gaps at
   * speed, no double-darkened overlaps at a crawl. Omit it and each call stamps
   * an independent oriented patch, which is fine for one-off marks but will
   * zigzag if several wheels share the default lane.
   */
  function addSkid(x, y, z, yaw, intensity, lane) {
    const a = clamp(intensity ?? 1, 0, 1);
    if (a <= 0.01) return;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);       // right = (cos, -sin)
    const yl = y + SKID_LIFT;
    const lx = x - rx * SKID_HALF, lz = z - rz * SKID_HALF;
    const px = x + rx * SKID_HALF, pz = z + rz * SKID_HALF;

    if (lane === undefined) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);    // forward = (-sin, -cos)
      const h = SKID_STAMP * 0.5;
      writeQuad(
        lx - fx * h, yl, lz - fz * h,
        px - fx * h, yl, pz - fz * h,
        px + fx * h, yl, pz + fz * h,
        lx + fx * h, yl, lz + fz * h,
        a,
      );
      return;
    }

    const li = ((lane | 0) % LANES + LANES) % LANES;
    const dx = x - laneX[li], dz = z - laneZ[li];
    const moved = Math.hypot(dx, dz);
    const stale = (now - laneT[li]) > SKID_MAX_GAP || moved > SKID_MAX_STEP;

    if (laneOn[li] && !stale) {
      if (moved < SKID_MIN_STEP) { laneT[li] = now; return; }
      writeQuad(
        laneLX[li], laneLY[li], laneLZ[li],
        laneRX[li], laneRY[li], laneRZ[li],
        px, yl, pz,
        lx, yl, lz,
        a,
      );
    }
    laneOn[li] = 1;
    laneT[li] = now;
    laneX[li] = x; laneY[li] = yl; laneZ[li] = z;
    laneLX[li] = lx; laneLY[li] = yl; laneLZ[li] = lz;
    laneRX[li] = px; laneRY[li] = yl; laneRZ[li] = pz;
  }

  // =========================================================================
  // Rain
  // =========================================================================
  let rain = 0;
  const camPos = new THREE.Vector3();
  let camKnown = false;
  let camVelX = 0, camVelZ = 0;

  function setRain(intensity, cameraPos) {
    rain = clamp(intensity ?? 0, 0, 1);
    const drops = Math.round(MAX_RAIN * rain);
    rainGeo.setDrawRange(0, drops * 2);
    rainMat.uniforms.uAlpha.value = 0.38 * rain;
    rainMesh.visible = drops > 0;
    if (cameraPos) {
      camPos.set(cameraPos.x, cameraPos.y, cameraPos.z);
      rainMat.uniforms.uCam.value.copy(camPos);
      camKnown = true;
    }
  }

  // =========================================================================
  // Update
  // =========================================================================
  const stats = { billows: 0, sparks: 0, skidsLaid: 0, rainDrops: 0 };

  function update(dt, cameraPos) {
    if (!(dt > 0)) dt = 0;
    now += dt;

    let cx = camPos.x, cy = camPos.y, cz = camPos.z;
    if (cameraPos) {
      cx = cameraPos.x; cy = cameraPos.y; cz = cameraPos.z;
      if (camKnown && dt > 1e-5) {
        // Smoothed, because a single frame of camera snap would fling the rain
        // sideways for one frame and read as a glitch.
        const k = Math.min(1, dt * 6);
        camVelX += (((cx - camPos.x) / dt) - camVelX) * k;
        camVelZ += (((cz - camPos.z) / dt) - camVelZ) * k;
      }
      camPos.set(cx, cy, cz);
      camKnown = true;
    }

    // ---- billows ----------------------------------------------------------
    for (let i = 0; i < bAlive;) {
      const age = bAge[i] + dt;
      const life = bLife[i];
      if (age >= life) { billowKill(i); continue; }
      bAge[i] = age;

      const i3 = i * 3;
      // Drag relaxes the puff toward the ambient wind. Implicit (divide rather
      // than subtract) so a large dt can never overshoot into negative damping.
      const d = bDrag[i];
      const f = 1 / (1 + d * dt);
      bVel[i3] = (bVel[i3] + WIND_X * d * dt) * f;
      bVel[i3 + 1] = (bVel[i3 + 1] + bRise[i] * dt) * f;
      bVel[i3 + 2] = (bVel[i3 + 2] + WIND_Z * d * dt) * f;

      const px = aPos[i3] + bVel[i3] * dt;
      let py = aPos[i3 + 1] + bVel[i3 + 1] * dt;
      const pz = aPos[i3 + 2] + bVel[i3 + 2] * dt;
      if (py < bFloor[i]) { py = bFloor[i]; bVel[i3 + 1] = 0; }
      aPos[i3] = px; aPos[i3 + 1] = py; aPos[i3 + 2] = pz;

      const ddx = px - cx, ddy = py - cy, ddz = pz - cz;
      if (ddx * ddx + ddy * ddy + ddz * ddz > CULL_SQ) { billowKill(i); continue; }

      let s = bSize0[i] + bGrow[i] * age;
      if (s > SIZE_CAP) s = SIZE_CAP;
      aSize[i] = s;

      // Fade in over bFade seconds so a puff does not pop into existence at
      // full strength, then fall away quadratically for the rest of its life.
      const tail = 1 - age / life;
      const fadeIn = bFade[i] > 0 ? Math.min(1, age / bFade[i]) : 1;
      aAlpha[i] = bAlpha0[i] * fadeIn * tail * tail;
      aRot[i] += bSpin[i] * dt;
      i++;
    }

    // ---- sparks -----------------------------------------------------------
    for (let i = 0; i < sAlive;) {
      const age = spSeconds[i] + dt;
      const life = spLife[i];
      if (age >= life) { sparkKill(i); continue; }
      spSeconds[i] = age;

      const i3 = i * 3;
      const f = 1 / (1 + 0.9 * dt);
      let vx = sVel[i3] * f;
      let vy = (sVel[i3 + 1] - 15.0 * dt) * f;
      let vz = sVel[i3 + 2] * f;

      let px = sPos[i3] + vx * dt;
      let py = sPos[i3 + 1] + vy * dt;
      let pz = sPos[i3 + 2] + vz * dt;

      // Sparks skitter along whatever they were struck off. The emit height is
      // the floor, which costs no ground query and is right to within a wheel.
      const floor = spFloor[i];
      if (py < floor) {
        py = floor;
        vy = -vy * 0.34;
        vx *= 0.62; vz *= 0.62;
        if (vy < 0.45) vy = 0;
      }

      sPos[i3] = px; sPos[i3 + 1] = py; sPos[i3 + 2] = pz;
      sVel[i3] = vx; sVel[i3 + 1] = vy; sVel[i3 + 2] = vz;

      const ddx = px - cx, ddy = py - cy, ddz = pz - cz;
      if (ddx * ddx + ddy * ddy + ddz * ddz > CULL_SQ) { sparkKill(i); continue; }

      sAge[i] = age / life;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      sLen[i] = clamp(sp * 0.030, 0.03, 0.55);
      i++;
    }

    // ---- rain -------------------------------------------------------------
    if (rain > 0) {
      const u = rainMat.uniforms;
      u.uTime.value = now;
      u.uCam.value.set(cx, cy, cz);
      // The streak follows APPARENT motion — the drop's fall minus the camera's
      // travel — which is why rain slants harder the faster you drive.
      const fall = u.uFall.value;
      const ax = -camVelX, ay = -fall, az = -camVelZ;
      const al = Math.hypot(ax, ay, az) || 1;
      const rel = Math.hypot(camVelX, camVelZ);
      const len = clamp(0.45 + rel * 0.040, 0.45, 3.0);
      u.uStreak.value.set(ax / al * len, ay / al * len, az / al * len);

      if (ground) {
        // Drops landing near the camera. Anywhere further and the splash is a
        // sub-pixel smudge nobody will ever resolve.
        rainSplashDebt += rain * 30 * dt;
        let n = rainSplashDebt | 0;
        rainSplashDebt -= n;
        if (n > 4) n = 4;
        for (let k = 0; k < n; k++) {
          const a = Math.random() * 6.2832;
          const r = 2 + Math.sqrt(Math.random()) * 12;
          const sx = cx + Math.cos(a) * r;
          const sz = cz + Math.sin(a) * r;
          splash(sx, ground.heightAt(sx, sz), sz, 1);
        }
      }
    }

    // ---- upload -----------------------------------------------------------
    // Full re-uploads for the instanced pools: at 1600 and 512 instances these
    // are tens of kilobytes, and skipping update ranges keeps this loop free of
    // the { start, count } objects that addUpdateRange() would allocate.
    billowGeo.instanceCount = bAlive;
    if (bAlive > 0) {
      attrPos.needsUpdate = true;
      attrCol.needsUpdate = true;
      attrSize.needsUpdate = true;
      attrAlpha.needsUpdate = true;
      attrRot.needsUpdate = true;
    }
    billowMesh.visible = bAlive > 0;

    sparkGeo.instanceCount = sAlive;
    if (sAlive > 0) {
      attrSPos.needsUpdate = true;
      attrSVel.needsUpdate = true;
      attrSAge.needsUpdate = true;
      attrSLen.needsUpdate = true;
      attrSBright.needsUpdate = true;
    }
    sparkMesh.visible = sAlive > 0;

    skidMat.uniforms.uTime.value = now;
    if (kHi >= 0) {
      const start = kLo * 18;
      const count = (kHi - kLo + 1) * 18;
      kPosRange.start = start; kPosRange.count = count;
      kAttRange.start = start; kAttRange.count = count;
      attrKPos.updateRanges.length = 0;
      attrKPos.updateRanges.push(kPosRange);
      attrKAtt.updateRanges.length = 0;
      attrKAtt.updateRanges.push(kAttRange);
      attrKPos.needsUpdate = true;
      attrKAtt.needsUpdate = true;
      kLo = -1; kHi = -1;
    }

    stats.billows = bAlive;
    stats.sparks = sAlive;
    stats.skidsLaid = laid;
    stats.rainDrops = Math.round(MAX_RAIN * rain);
    laid = 0;
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    billowGeo.dispose(); billowMat.dispose();
    sparkGeo.dispose(); sparkMat.dispose();
    skidGeo.dispose(); skidMat.dispose();
    rainGeo.dispose(); rainMat.dispose();
    puff.dispose();
  }

  return {
    group,
    emitDust, emitSmoke, emitSparks, splash,
    addSkid, setRain,
    update, dispose,
    stats,
    limits: { billows: MAX_BILLOW, sparks: MAX_SPARK, skids: MAX_SKID, rain: MAX_RAIN, lanes: LANES },
  };
}
