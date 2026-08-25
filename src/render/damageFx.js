// Smoke, fire, sparks and fluid — everything a broken car leaks, throws or
// burns.
//
// COORDINATE CONVENTION — restated because every emitter below places itself in
// the car's own frame and a sign error puts the fire behind the boot:
//
//   forward = -Z      right = +X      up = +Y      yaw grows counter-clockwise
//   forward = (-sin yaw, 0, -cos yaw)      right = (cos yaw, 0, -sin yaw)
//
// Local offsets in this file are written the way physics/damage.js writes them:
// `f` metres FORWARD of the car's centre and `r` metres RIGHT of it. That is the
// opposite sign to the model's own z (models are built facing -Z), which is
// exactly why damage.js's `lz` is converted rather than copied.
//
// WHAT THIS REUSES AND WHAT IT DOES NOT
//
// render/particles.js already owns the two pools this module would otherwise
// have to invent twice, and the SPARK pool fits perfectly: additive
// velocity-aligned streaks with a white-hot-to-ember ramp and a floor they
// skitter along is precisely what a rim grinding on tarmac throws. So rim and
// drag sparks, and the grit kicked up by a bursting tyre, are delegated to a
// createParticles handle passed in as opts.particles.
//
// Its BILLOW pool does not fit, for one measured reason: billowSpawn() picks the
// puff's velocity itself, from a fixed per-kind table. Engine smoke has to leave
// the car carrying the CAR's velocity — that is the whole difference between a
// plume that trails fifteen metres behind a burning car at 30 m/s and a column
// of grey that sits on the bonnet like a hat. There is no way to inject that
// through emitDust/emitSmoke, and nothing in particles.js does additive animated
// flame at all. So smoke, fire and the ground decals are pooled here, on the
// same principles: typed arrays sized once, a live count, swap-remove on death,
// and a full pool drops the request rather than growing.
//
// EARLY OUT
//
// An undamaged car costs six compares and one branch. Three meshes exist, and
// all three go invisible the moment their pools empty, so a clean session pays
// three visibility flags a frame and nothing else.

import * as THREE from 'three';
import { clamp, lerp, fbm } from '../world/noise.js';

// sRGB hex -> linear, by hand. Same reasoning as particles.js: these values are
// constants, so converting them once at module scope beats routing every puff
// through THREE.Color's colour-management path.
function srgb(c) {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

// Smoke changes character with what is actually wrong, and these are the three
// ends it interpolates between. Merely hot is a thin warm-grey wisp; a lost
// coolant charge boils off near-white; a destroyed engine burns its own oil and
// goes black. Blending between them rather than switching is what makes a car
// that is slowly cooking look different from one that is finished.
const SMOKE_GREY = [srgb(0.62), srgb(0.63), srgb(0.66)];
const SMOKE_WHITE = [srgb(0.94), srgb(0.95), srgb(0.97)];
const SMOKE_BLACK = [srgb(0.055), srgb(0.052), srgb(0.050)];
const SMOKE_RUBBER = [srgb(0.13), srgb(0.125), srgb(0.13)];
const SMOKE_STEAM = [srgb(0.90), srgb(0.93), srgb(0.96)];

// Glass is not white. A shard catches the sky, so it reads cold; sparks from the
// same crash read warm, and having both on screen at once is what tells you a
// window went rather than a wing.
const SHARD_GLASS = [srgb(0.78), srgb(0.90), srgb(1.00)];
const SHARD_LAMP = [srgb(1.00), srgb(0.97), srgb(0.88)];

// The flame ramp. Tongues are drawn from between these two, so a fire is never
// one flat orange.
const FIRE_HOT = [srgb(1.00), srgb(0.88), srgb(0.56)];
const FIRE_COOL = [srgb(1.00), srgb(0.34), srgb(0.07)];
const FIRE_GLOW = [srgb(1.00), srgb(0.42), srgb(0.13)];

/**
 * Two 128x128 cells in one 256x128 atlas: a flame teardrop and a ragged radial
 * puff. One texture means one draw call for the additive layer even though it
 * carries flames, glass shards and ground glow at the same time.
 *
 * The RED channel is a CORE MASK, not colour — the fragment shader mixes toward
 * white by it, which is how a flame gets a white-hot heart without a second
 * texture or a second colour attribute. ALPHA is the shape. Both cells fade to
 * zero alpha at their own edges, so the mip chain may bleed them together at the
 * coarse levels without anything being visible.
 */
function makeAtlas(seed, anisotropy) {
  if (typeof document === 'undefined') return null;   // tools/ measures this in Node
  const W = 256, H = 128, C = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;

  for (let y = 0; y < H; y++) {
    // CanvasTexture flips Y, so canvas row 0 is v = 1 — the top of the quad,
    // which is where a flame's tip belongs.
    const v = 1 - (y + 0.5) / H;
    for (let x = 0; x < C; x++) {
      const cx = (x + 0.5) / C * 2 - 1;
      // Half width tapers to the tip with a slight bulge low down, and the rim
      // is chewed by noise so the silhouette is never a smooth cone.
      const taper = Math.pow(Math.max(0, 1 - v), 0.55);
      // 0.60, not the 0.46 this started at: the alpha falls off over the whole
      // half width, so only about the inner 80% of it is visible and a 0.46
      // coefficient put a 37%-wide tongue inside a square quad. Fires read
      // better chunky than wispy, and the wasted fill was the majority of it.
      let hw = 0.60 * taper * (0.72 + 0.28 * Math.sin(v * Math.PI)) * (1 + 0.35 * Math.pow(1 - v, 3));
      hw *= 1 + 0.30 * fbm(cx * 2.2, v * 4.6, seed, 3);
      const t = Math.abs(cx) / Math.max(1e-3, hw);
      let a = clamp(1 - t, 0, 1);
      a = a * a * (3 - 2 * a);
      // Soften the very bottom edge so the quad's own boundary never shows.
      a *= clamp(v / 0.06, 0, 1) * clamp((1 - v) / 0.10, 0, 1);
      const core = clamp(1 - t * 1.5, 0, 1) * clamp(1 - v * 1.35, 0, 1);
      const o = (y * W + x) * 4;
      data[o] = Math.round(core * core * 255);
      data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
    for (let x = 0; x < C; x++) {
      const dx = (x + 0.5) / C * 2 - 1;
      const dy = -(v * 2 - 1);
      const r = Math.hypot(dx, dy);
      const rim = clamp(r * 1.5, 0, 1);
      const warped = clamp(r * (1 + fbm(dx * 3.1, dy * 3.1, seed + 4409, 4) * 0.30 * rim), 0, 1);
      let a = clamp(1 - warped, 0, 1);
      a = a * a * (3 - 2 * a);
      a *= 0.62 + 0.38 * (0.5 + 0.5 * fbm(dx * 6.3 + 11, dy * 6.3 - 4, seed + 7717, 3));
      const o = (y * W + C + x) * 4;
      data[o] = Math.round(clamp(1 - r * 2.1, 0, 1) * 255);
      data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;      // red is a mask, alpha is a shape
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Unit quad in XY, billboarded or laid flat per instance. */
function quadBase() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Fog uniforms the renderer refreshes for us; these values are placeholders. */
function fogUniforms(u) {
  u.fogColor = { value: new THREE.Color(0xffffff) };
  u.fogDensity = { value: 0.00025 };
  u.fogNear = { value: 1 };
  u.fogFar = { value: 2000 };
  return u;
}

export function createDamageFx(scene, opts = {}) {
  const density = clamp(opts.density ?? 1, 0.12, 1);
  const MAX_SMOKE = Math.max(64, Math.round((opts.maxSmoke ?? 520) * density));
  const MAX_GLOW = Math.max(48, Math.round((opts.maxGlow ?? 384) * density));
  const MAX_WET = Math.max(32, Math.round((opts.maxWet ?? 256) * density));

  const CULL = opts.cullDistance ?? 260;
  const CULL_SQ = CULL * CULL;
  // A puff wider than this is mostly overdraw. Four cars alight put ~230 puffs
  // on screen, and at the 6 m the growth curve reaches unaided they each cover
  // a large fraction of the frame — twenty layers of that is where the frame
  // rate actually goes, long before the JS costs anything.
  const SIZE_CAP = 4.5;
  const WIND_X = opts.windX ?? 0.5;
  const WIND_Z = opts.windZ ?? 0.3;
  const WET_LIFE = opts.wetLife ?? 24;      // s until a coolant trail has dried
  const WET_STEP = 0.34;                    // m between trail stamps at a crawl
  const RO = opts.renderOrder ?? 10;
  const particles = opts.particles || null;
  const ground = opts.ground || null;

  // Night only scales the fire's ground pool of light. It defaults to half so
  // the effect is visible before anything wires setNight() up, rather than
  // silently absent — the same reasoning as a stubbed layer in main.js.
  let night = clamp(opts.night ?? 0.5, 0, 1);

  const group = new THREE.Group();
  group.name = 'damageFx';
  group.matrixAutoUpdate = false;
  group.updateMatrix();

  const atlas = makeAtlas(opts.seed ?? 20260825, opts.anisotropy ?? 4);
  let now = 0;

  // =========================================================================
  // Smoke — alpha-blended billboards that carry the car's velocity out with them
  // =========================================================================
  const mPos = new Float32Array(MAX_SMOKE * 3);
  const mCol = new Float32Array(MAX_SMOKE * 3);
  const mSize = new Float32Array(MAX_SMOKE);
  const mAlpha = new Float32Array(MAX_SMOKE);
  const mRot = new Float32Array(MAX_SMOKE);
  // Simulation state; never reaches the GPU.
  const nVel = new Float32Array(MAX_SMOKE * 3);
  const nAge = new Float32Array(MAX_SMOKE);
  const nLife = new Float32Array(MAX_SMOKE);
  const nSize0 = new Float32Array(MAX_SMOKE);
  const nGrow = new Float32Array(MAX_SMOKE);
  const nAlpha0 = new Float32Array(MAX_SMOKE);
  const nDrag = new Float32Array(MAX_SMOKE);
  const nRise = new Float32Array(MAX_SMOKE);
  const nSpin = new Float32Array(MAX_SMOKE);
  const nFloor = new Float32Array(MAX_SMOKE);
  let smokeAlive = 0;

  const smokeGeo = quadBase();
  const aSmokePos = new THREE.InstancedBufferAttribute(mPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aSmokeCol = new THREE.InstancedBufferAttribute(mCol, 3).setUsage(THREE.DynamicDrawUsage);
  const aSmokeSize = new THREE.InstancedBufferAttribute(mSize, 1).setUsage(THREE.DynamicDrawUsage);
  const aSmokeAlpha = new THREE.InstancedBufferAttribute(mAlpha, 1).setUsage(THREE.DynamicDrawUsage);
  const aSmokeRot = new THREE.InstancedBufferAttribute(mRot, 1).setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute('iPos', aSmokePos);
  smokeGeo.setAttribute('iCol', aSmokeCol);
  smokeGeo.setAttribute('iSize', aSmokeSize);
  smokeGeo.setAttribute('iAlpha', aSmokeAlpha);
  smokeGeo.setAttribute('iRot', aSmokeRot);
  smokeGeo.instanceCount = 0;

  const smokeMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({ uAtlas: { value: atlas } }),
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
        // Right-hand cell of the atlas: the ragged radial puff.
        vUv = vec2((position.x + 0.5) * 0.5 + 0.5, position.y + 0.5);
        vCol = iCol;
        vAlpha = iAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
        float s = sin(iRot), c = cos(iRot);
        vec2 q = position.xy * iSize;
        mvPosition.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float a = texture2D(uAtlas, vUv).a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });

  const smokeMesh = new THREE.Mesh(smokeGeo, smokeMat);
  smokeMesh.name = 'damageSmoke';
  smokeMesh.frustumCulled = false;          // instance offsets live in the shader
  smokeMesh.renderOrder = RO + 3;
  smokeMesh.visible = false;
  group.add(smokeMesh);

  // =========================================================================
  // Glow — one additive pool for flames, glass shards and the fire's ground pool
  // =========================================================================
  // iFlick doubles as the fire flag. Anything with iFlick > 0 flickers, cools
  // toward red as it ages, and draws the flame cell of the atlas; anything at
  // zero is an inert glint or decal and draws the radial cell. One attribute
  // instead of three, and the two meanings never disagree because a flame is
  // exactly the thing that flickers.
  const gPos = new Float32Array(MAX_GLOW * 3);
  const gCol = new Float32Array(MAX_GLOW * 3);
  const gSize = new Float32Array(MAX_GLOW);
  const gAlpha = new Float32Array(MAX_GLOW);
  const gRot = new Float32Array(MAX_GLOW);
  const gFlick = new Float32Array(MAX_GLOW);
  const gFlat = new Float32Array(MAX_GLOW);
  const gAgeN = new Float32Array(MAX_GLOW);
  const hVel = new Float32Array(MAX_GLOW * 3);
  const hAge = new Float32Array(MAX_GLOW);
  const hLife = new Float32Array(MAX_GLOW);
  const hSize0 = new Float32Array(MAX_GLOW);
  const hGrow = new Float32Array(MAX_GLOW);
  const hAlpha0 = new Float32Array(MAX_GLOW);
  const hDrag = new Float32Array(MAX_GLOW);
  const hRise = new Float32Array(MAX_GLOW);
  const hSpin = new Float32Array(MAX_GLOW);
  const hFloor = new Float32Array(MAX_GLOW);
  const hBounce = new Float32Array(MAX_GLOW);
  let glowAlive = 0;

  const glowGeo = quadBase();
  const aGlowPos = new THREE.InstancedBufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aGlowCol = new THREE.InstancedBufferAttribute(gCol, 3).setUsage(THREE.DynamicDrawUsage);
  const aGlowSize = new THREE.InstancedBufferAttribute(gSize, 1).setUsage(THREE.DynamicDrawUsage);
  const aGlowAlpha = new THREE.InstancedBufferAttribute(gAlpha, 1).setUsage(THREE.DynamicDrawUsage);
  const aGlowRot = new THREE.InstancedBufferAttribute(gRot, 1).setUsage(THREE.DynamicDrawUsage);
  const aGlowFlick = new THREE.InstancedBufferAttribute(gFlick, 1).setUsage(THREE.DynamicDrawUsage);
  const aGlowFlat = new THREE.InstancedBufferAttribute(gFlat, 1).setUsage(THREE.DynamicDrawUsage);
  const aGlowAge = new THREE.InstancedBufferAttribute(gAgeN, 1).setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('iPos', aGlowPos);
  glowGeo.setAttribute('iCol', aGlowCol);
  glowGeo.setAttribute('iSize', aGlowSize);
  glowGeo.setAttribute('iAlpha', aGlowAlpha);
  glowGeo.setAttribute('iRot', aGlowRot);
  glowGeo.setAttribute('iFlick', aGlowFlick);
  glowGeo.setAttribute('iFlat', aGlowFlat);
  glowGeo.setAttribute('iAge', aGlowAge);
  glowGeo.instanceCount = 0;

  const glowMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({ uAtlas: { value: atlas }, uTime: { value: 0 } }),
    fog: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    // The flat instances lie ON the road. Without a depth bias they z-fight the
    // tarmac at grazing angles, which reads as the fire strobing.
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
    vertexShader: `
      attribute vec3 iPos;
      attribute vec3 iCol;
      attribute float iSize;
      attribute float iAlpha;
      attribute float iRot;
      attribute float iFlick;
      attribute float iFlat;
      attribute float iAge;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vBright;
      varying float vFire;
      varying float vAge;
      #include <fog_pars_vertex>
      void main() {
        // Flames take the left cell, everything else the right one.
        float cell = iFlick > 0.0 ? 0.0 : 0.5;
        vUv = vec2((position.x + 0.5) * 0.5 + cell, position.y + 0.5);
        vCol = iCol;
        vFire = iFlick;
        vAge = iAge;

        // Two incommensurate rates so the flicker never finds a beat, phased off
        // iRot so no two tongues pulse together.
        float ph = iRot * 6.0;
        float f = 1.0 - iFlick * 0.45 * (0.5 + 0.5 * sin(uTime * 17.0 + ph) * sin(uTime * 7.3 + ph * 1.7));
        vBright = iAlpha * f;

        float s = sin(iRot), c = cos(iRot);
        vec2 q = position.xy * (iSize * (1.0 + iFlick * (f - 1.0) * 0.5));
        vec4 mvPosition;
        if (iFlat > 0.5) {
          // Ground decal: build the quad in world space on the XZ plane. This is
          // the cheap stand-in for the light a fire throws on the road — a real
          // point light per burning car would cost a shadow-free forward pass
          // each, for something the player reads as a warm pool and nothing more.
          vec3 w = iPos + vec3(q.x * c - q.y * s, 0.0, q.x * s + q.y * c);
          mvPosition = modelViewMatrix * vec4(w, 1.0);
        } else {
          mvPosition = modelViewMatrix * vec4(iPos, 1.0);
          mvPosition.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
        }
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vBright;
      varying float vFire;
      varying float vAge;
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        float a = t.a * vBright;
        if (a < 0.004) discard;
        // Red is the core mask: mix toward white-hot in the heart of the flame.
        vec3 c = mix(vCol, vec3(1.0, 0.94, 0.82), t.r * t.r * 0.85);
        // A tongue cools as it climbs. Green and blue fall away faster than red,
        // which is what turns the tip of a flame orange and then smoky.
        c *= vec3(1.0, 1.0 - 0.50 * vFire * vAge, 1.0 - 0.82 * vFire * vAge);
        gl_FragColor = vec4(c, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Additive light must be ATTENUATED by fog, not tinted toward it —
        // mixing an additive colour toward the fog colour makes a distant fire
        // brighter than a near one.
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

  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.name = 'damageGlow';
  glowMesh.frustumCulled = false;
  glowMesh.renderOrder = RO + 6;            // after the smoke, so flames read through it
  glowMesh.visible = false;
  group.add(glowMesh);

  // =========================================================================
  // Wet trail — the coolant a holed radiator lays down behind the car
  // =========================================================================
  // A ring buffer of flat instances that never move. The fade is a function of
  // (uTime - birth) evaluated in the vertex shader, so a trail that stretches a
  // kilometre costs one uniform write a frame and no buffer traffic at all;
  // buffers are only touched on the frames a stamp is actually laid.
  const wPos = new Float32Array(MAX_WET * 3);
  const wSize = new Float32Array(MAX_WET);
  const wRot = new Float32Array(MAX_WET);
  const wBirth = new Float32Array(MAX_WET).fill(-1e6);   // born long ago = invisible
  let wetCursor = 0, wetHigh = 0, wetDirty = false;
  // When the most recent stamp was laid. The layer may only be switched off
  // once THIS one has dried — see the note in update().
  let wetNewest = -1e6;

  const wetGeo = quadBase();
  const aWetPos = new THREE.InstancedBufferAttribute(wPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aWetSize = new THREE.InstancedBufferAttribute(wSize, 1).setUsage(THREE.DynamicDrawUsage);
  const aWetRot = new THREE.InstancedBufferAttribute(wRot, 1).setUsage(THREE.DynamicDrawUsage);
  const aWetBirth = new THREE.InstancedBufferAttribute(wBirth, 1).setUsage(THREE.DynamicDrawUsage);
  wetGeo.setAttribute('iPos', aWetPos);
  wetGeo.setAttribute('iSize', aWetSize);
  wetGeo.setAttribute('iRot', aWetRot);
  wetGeo.setAttribute('iBirth', aWetBirth);
  wetGeo.instanceCount = 0;

  const wetMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({
      uAtlas: { value: atlas },
      uTime: { value: 0 },
      uLife: { value: WET_LIFE },
      uColour: { value: new THREE.Color(opts.wetColour ?? 0x11161a) },
      uAlpha: { value: opts.wetAlpha ?? 0.34 },
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
      attribute vec3 iPos;
      attribute float iSize;
      attribute float iRot;
      attribute float iBirth;
      uniform float uTime;
      uniform float uLife;
      uniform float uAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        float age = (uTime - iBirth) / uLife;
        if (age < 0.0 || age > 1.0) {
          // Degenerate: every corner lands on one clip point, so the triangle
          // has no area and never reaches the rasteriser.
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        // Coolant holds its colour while it is wet and then dries off quickly,
        // rather than dimming from the instant it hits the road.
        vAlpha = uAlpha * (1.0 - smoothstep(0.55, 1.0, age));
        vUv = vec2((position.x + 0.5) * 0.5 + 0.5, position.y + 0.5);
        float s = sin(iRot), c = cos(iRot);
        vec2 q = position.xy * iSize;
        vec3 w = iPos + vec3(q.x * c - q.y * s, 0.0, q.x * s + q.y * c);
        vec4 mvPosition = modelViewMatrix * vec4(w, 1.0);
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      uniform vec3 uColour;
      varying vec2 vUv;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float a = texture2D(uAtlas, vUv).a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColour, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });

  const wetMesh = new THREE.Mesh(wetGeo, wetMat);
  wetMesh.name = 'coolantTrail';
  wetMesh.frustumCulled = false;            // the trail spans as far as the car drove
  wetMesh.renderOrder = RO;                 // on the road, under everything else
  wetMesh.visible = false;
  group.add(wetMesh);

  if (scene) scene.add(group);

  // =========================================================================
  // Spawning
  // =========================================================================
  // Both spawners read a module-scope parameter block rather than taking a
  // dozen positional arguments. Seventeen-argument calls are unreadable and an
  // options literal per puff is an allocation per puff — this is neither.
  const SP = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1,
    life: 1, size0: 0.3, grow: 1, alpha0: 0.2, drag: 2, rise: 1.5,
    spin: 0.6, floor: -1e9, jitter: 0.12,
  };

  function smokeSpawn() {
    if (smokeAlive >= MAX_SMOKE) return;
    const i = smokeAlive++;
    const i3 = i * 3;
    const rnd = Math.random;
    const j = SP.jitter;
    mPos[i3] = SP.x + (rnd() - 0.5) * j;
    mPos[i3 + 1] = SP.y + (rnd() - 0.5) * j;
    mPos[i3 + 2] = SP.z + (rnd() - 0.5) * j;
    nVel[i3] = SP.vx; nVel[i3 + 1] = SP.vy; nVel[i3 + 2] = SP.vz;
    mCol[i3] = SP.r; mCol[i3 + 1] = SP.g; mCol[i3 + 2] = SP.b;
    mRot[i] = rnd() * 6.2832;
    nAge[i] = 0;
    nLife[i] = SP.life;
    nSize0[i] = SP.size0;
    nGrow[i] = SP.grow;
    nAlpha0[i] = SP.alpha0;
    nDrag[i] = SP.drag;
    nRise[i] = SP.rise;
    nSpin[i] = (rnd() - 0.5) * SP.spin;
    nFloor[i] = SP.floor;
    mSize[i] = SP.size0;
    mAlpha[i] = 0;
  }

  function smokeKill(i) {
    const last = --smokeAlive;
    if (i === last) return;
    const a = i * 3, b = last * 3;
    mPos[a] = mPos[b]; mPos[a + 1] = mPos[b + 1]; mPos[a + 2] = mPos[b + 2];
    mCol[a] = mCol[b]; mCol[a + 1] = mCol[b + 1]; mCol[a + 2] = mCol[b + 2];
    nVel[a] = nVel[b]; nVel[a + 1] = nVel[b + 1]; nVel[a + 2] = nVel[b + 2];
    mSize[i] = mSize[last]; mAlpha[i] = mAlpha[last]; mRot[i] = mRot[last];
    nAge[i] = nAge[last]; nLife[i] = nLife[last];
    nSize0[i] = nSize0[last]; nGrow[i] = nGrow[last]; nAlpha0[i] = nAlpha0[last];
    nDrag[i] = nDrag[last]; nRise[i] = nRise[last];
    nSpin[i] = nSpin[last]; nFloor[i] = nFloor[last];
  }

  const GP = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1,
    life: 0.5, size0: 0.3, grow: 1, alpha0: 0.6, drag: 3, rise: 4,
    spin: 0.4, floor: -1e9, jitter: 0.1, flick: 1, flat: 0, bounce: 0,
  };

  function glowSpawn() {
    if (glowAlive >= MAX_GLOW) return;
    const i = glowAlive++;
    const i3 = i * 3;
    const rnd = Math.random;
    const j = GP.jitter;
    gPos[i3] = GP.x + (rnd() - 0.5) * j;
    // A flat instance takes no vertical jitter. It lies ON the road, and half a
    // metre of scatter would put the fire's pool of light under the tarmac as
    // often as above it.
    gPos[i3 + 1] = GP.flat > 0.5 ? GP.y : GP.y + (rnd() - 0.5) * j;
    gPos[i3 + 2] = GP.z + (rnd() - 0.5) * j;
    hVel[i3] = GP.vx; hVel[i3 + 1] = GP.vy; hVel[i3 + 2] = GP.vz;
    gCol[i3] = GP.r; gCol[i3 + 1] = GP.g; gCol[i3 + 2] = GP.b;
    // Flames barely rotate — a tongue that spins reads as a leaf. Flat decals
    // take a full random spin so the noise in the atlas never tiles visibly.
    gRot[i] = GP.flat > 0.5 ? rnd() * 6.2832 : (rnd() - 0.5) * 0.5;
    gFlick[i] = GP.flick;
    gFlat[i] = GP.flat;
    gAgeN[i] = 0;
    hAge[i] = 0;
    hLife[i] = GP.life;
    hSize0[i] = GP.size0;
    hGrow[i] = GP.grow;
    hAlpha0[i] = GP.alpha0;
    hDrag[i] = GP.drag;
    hRise[i] = GP.rise;
    hSpin[i] = (rnd() - 0.5) * GP.spin;
    hFloor[i] = GP.floor;
    hBounce[i] = GP.bounce;
    gSize[i] = GP.size0;
    gAlpha[i] = 0;
  }

  function glowKill(i) {
    const last = --glowAlive;
    if (i === last) return;
    const a = i * 3, b = last * 3;
    gPos[a] = gPos[b]; gPos[a + 1] = gPos[b + 1]; gPos[a + 2] = gPos[b + 2];
    gCol[a] = gCol[b]; gCol[a + 1] = gCol[b + 1]; gCol[a + 2] = gCol[b + 2];
    hVel[a] = hVel[b]; hVel[a + 1] = hVel[b + 1]; hVel[a + 2] = hVel[b + 2];
    gSize[i] = gSize[last]; gAlpha[i] = gAlpha[last]; gRot[i] = gRot[last];
    gFlick[i] = gFlick[last]; gFlat[i] = gFlat[last]; gAgeN[i] = gAgeN[last];
    hAge[i] = hAge[last]; hLife[i] = hLife[last];
    hSize0[i] = hSize0[last]; hGrow[i] = hGrow[last]; hAlpha0[i] = hAlpha0[last];
    hDrag[i] = hDrag[last]; hRise[i] = hRise[last];
    hSpin[i] = hSpin[last]; hFloor[i] = hFloor[last]; hBounce[i] = hBounce[last];
  }

  function wetStamp(x, y, z, size) {
    const i = wetCursor;
    wetCursor = (wetCursor + 1) % MAX_WET;
    // High water is a COUNT, not the cursor: taking it from the cursor leaves
    // the last slot of the ring permanently outside instanceCount, so one stamp
    // in every MAX_WET is written and never drawn.
    if (i + 1 > wetHigh) wetHigh = i + 1;
    const i3 = i * 3;
    wPos[i3] = x; wPos[i3 + 1] = y; wPos[i3 + 2] = z;
    wSize[i] = size;
    wRot[i] = Math.random() * 6.2832;
    wBirth[i] = now;
    wetNewest = now;
    wetDirty = true;
  }

  // =========================================================================
  // Per-car bookkeeping
  // =========================================================================
  // One slot per car. Fractional emission debt lives here so a car asking for
  // 0.4 of a puff a frame gets a steady trickle rather than nothing, and so two
  // cars never share an accumulator.
  //
  // Keyed by the car OBJECT rather than by its index in the array. The index is
  // cheaper, but applyEvents() is handed a car and no index — a bare index
  // scheme leaves it unable to find the debt it needs, and the coolant plume's
  // ration then either leaks or never arms. A WeakMap costs one hash lookup per
  // DAMAGED car per frame (the early out runs first, so an intact one never
  // reaches this) and lets a recycled traffic slot's dead car fall out on its
  // own. reset() throws the whole map away rather than walking it.
  let slots = new WeakMap();

  function slotFor(car) {
    let s = slots.get(car);
    if (s === undefined) {
      s = {
        smokeDebt: 0, fireDebt: 0, glowDebt: 0,
        sparkDebt: [0, 0, 0, 0], dragDebt: 0,
        steamCool: 0,               // s until another coolant plume is allowed
        wetX: 0, wetZ: 0, wetSeen: false,
      };
      slots.set(car, s);
    }
    return s;
  }

  // Where things are on a car, as multiples of its own dimensions. These come
  // from the style table in render/carModel.js — a sedan's bonnet meets the
  // windscreen at 0.14 x wheelbase ahead of centre and 1.82 x wheelRadius above
  // the chassis datum — averaged across the seven body styles. A van's bonnet is
  // shorter and a sports car's is lower, but the smoke leaves through the shut
  // line either way and nobody can see ten centimetres of error inside a plume.
  const F_SHUT = 0.15, Y_SHUT = 1.85;       // bonnet shut line
  const F_NOSE = 0.80, Y_NOSE = 1.50;       // front bumper top
  const Y_SCREEN = 1.95;                    // glass, above the chassis datum
  const R_GLASS = 0.46;                     // side glass, x track
  const Y_LAMP_F = 1.28, Y_LAMP_R = 1.42;
  const R_LAMP_F = 0.33, R_LAMP_R = 0.36;
  const F_EXHAUST = 0.78, R_EXHAUST = 0.30;

  // Where the things that drag are, gathered per frame. Two fixed arrays rather
  // than a list of pairs, because this sits inside the per-frame path.
  const DRAG_F = new Float64Array(3), DRAG_R = new Float64Array(3);

  // Scratch for the local -> world transform, refilled per car per frame.
  let cfx = 0, cfz = -1, crx = 1, crz = 0;
  let cwb = 2.68, ctr = 1.58, cwr = 0.34, crh = 0.28;
  let cGroundY = 0, cvx = 0, cvz = 0, cSpeed = 0;

  function bindCar(car) {
    const spec = car.spec || null;
    cwb = (spec && spec.wheelbase) || 2.68;
    ctr = (spec && spec.track) || 1.58;
    cwr = (spec && spec.wheelRadius) || 0.34;
    crh = (spec && spec.rideHeight) || 0.28;
    cfx = -Math.sin(car.yaw); cfz = -Math.cos(car.yaw);
    crx = Math.cos(car.yaw); crz = -Math.sin(car.yaw);
    cGroundY = car.groundY !== undefined ? car.groundY : car.y - crh;
    // The velocity is what everything here is advected by. Traffic and replay
    // cars may only carry a scalar speed, in which case heading is the best
    // available direction and is right whenever the car is not sideways.
    if (car.vx !== undefined && car.vz !== undefined) { cvx = car.vx; cvz = car.vz; }
    else { const s = car.speed || 0; cvx = cfx * s; cvz = cfz * s; }
    cSpeed = car.speed !== undefined ? car.speed : Math.hypot(cvx, cvz);
  }

  const localX = (car, f, r) => car.x + cfx * f + crx * r;
  const localZ = (car, f, r) => car.z + cfz * f + crz * r;

  // =========================================================================
  // Continuous emitters
  // =========================================================================

  /**
   * Engine smoke out of the bonnet shut line.
   *
   * The puff leaves with a fraction of the car's own velocity and then decays
   * toward the ambient wind. That fraction is 0.72 rather than 1.0 because the
   * bow wave over a bonnet is already slower than the car; at 1.0 the plume
   * hangs level with the car for half a second before it lets go, which looks
   * like the smoke is being towed.
   */
  function emitEngineSmoke(car, d, slot, dt) {
    const smoke = d.effects.smoke;
    if (smoke <= 0.02) return;
    const st = d.state;

    const wWhite = clamp(1 - st.coolant, 0, 1);
    const wBlack = clamp(Math.max((1 - st.engine) * 1.1, st.onFire * 0.85), 0, 1);

    // 18.6 puffs a second at the very worst. Measured rather than guessed: the
    // first pass ran at 27 and four burning cars held 386 live puffs, three
    // quarters of the pool, with nothing left for the glass and tyre bursts that
    // arrive during the crash that set them alight in the first place.
    const rate = smoke * (5 + 7 * smoke) * (0.70 + 0.40 * wWhite + 0.45 * wBlack);
    slot.smokeDebt += rate * dt;
    let n = slot.smokeDebt | 0;
    slot.smokeDebt -= n;
    if (n > 8) n = 8;
    if (n <= 0) return;

    // Interpolate the whole character in one pass: grey -> white as the coolant
    // goes, then -> oily black as the engine dies. Black wins, because an engine
    // burning its own oil produces smoke you cannot see through whatever else is
    // wrong with it.
    SP.r = lerp(lerp(SMOKE_GREY[0], SMOKE_WHITE[0], wWhite), SMOKE_BLACK[0], wBlack);
    SP.g = lerp(lerp(SMOKE_GREY[1], SMOKE_WHITE[1], wWhite), SMOKE_BLACK[1], wBlack);
    SP.b = lerp(lerp(SMOKE_GREY[2], SMOKE_WHITE[2], wWhite), SMOKE_BLACK[2], wBlack);
    SP.alpha0 = lerp(lerp(0.085, 0.26, wWhite), 0.30, wBlack);
    SP.size0 = 0.22 + wBlack * 0.16 + wWhite * 0.06;
    SP.grow = 1.0 + wWhite * 0.7 + wBlack * 0.9;
    SP.rise = 1.4 + wWhite * 0.9 + wBlack * 1.1;
    SP.drag = 2.4;
    SP.spin = 1.0;
    SP.jitter = 0.16;
    SP.floor = cGroundY + 0.10;

    const y = car.y + Y_SHUT * cwr;
    const halfW = ctr * 0.40;
    const rnd = Math.random;
    for (let k = 0; k < n; k++) {
      const r = (rnd() * 2 - 1) * halfW;
      SP.x = localX(car, F_SHUT * cwb, r);
      SP.z = localZ(car, F_SHUT * cwb, r);
      SP.y = y;
      SP.life = lerp(1.5, 2.6, Math.max(wWhite, wBlack)) + rnd() * 0.8;
      SP.vx = cvx * 0.72 + (rnd() - 0.5) * 1.4;
      SP.vy = 0.8 + rnd() * 1.2;
      SP.vz = cvz * 0.72 + (rnd() - 0.5) * 1.4;
      smokeSpawn();
    }
  }

  /**
   * Fire. It starts as a flicker at the trailing edge of the bonnet, where the
   * heat is, and walks forward and outward as it takes hold until it is coming
   * off the whole nose. The ground decal goes down at a fixed rate rather than
   * one per car, so a bigger fire lights more road by being wider, not by
   * stacking brighter — additive discs stacked on one spot clip to white.
   */
  function emitFire(car, d, slot, dt) {
    const fire = d.effects.fire;
    if (fire <= 0.01) return;
    const rnd = Math.random;

    slot.fireDebt += fire * (12 + 34 * fire) * dt;
    let n = slot.fireDebt | 0;
    slot.fireDebt -= n;
    if (n > 12) n = 12;

    if (n > 0) {
      const f = lerp(F_SHUT, F_NOSE, fire) * cwb;
      const y = car.y + lerp(Y_SHUT, Y_NOSE + 0.45, fire) * cwr;
      const halfW = ctr * (0.16 + 0.40 * fire);
      const halfF = cwb * (0.04 + 0.22 * fire);
      GP.flick = 1; GP.flat = 0; GP.bounce = 0;
      GP.drag = 3.2;
      GP.rise = 5.5 + fire * 3.2;
      GP.spin = 0.3;
      GP.jitter = 0.10;
      GP.floor = cGroundY;
      GP.grow = 1.4 + fire * 0.8;
      for (let k = 0; k < n; k++) {
        const t = rnd();
        GP.r = lerp(FIRE_COOL[0], FIRE_HOT[0], t);
        GP.g = lerp(FIRE_COOL[1], FIRE_HOT[1], t);
        GP.b = lerp(FIRE_COOL[2], FIRE_HOT[2], t);
        const rr = (rnd() * 2 - 1) * halfW;
        const ff = f + (rnd() * 2 - 1) * halfF;
        GP.x = localX(car, ff, rr);
        GP.z = localZ(car, ff, rr);
        GP.y = y;
        GP.life = 0.30 + rnd() * 0.34;
        GP.size0 = 0.20 + fire * 0.34 + rnd() * 0.12;
        GP.alpha0 = (0.42 + rnd() * 0.34) * (0.45 + 0.55 * fire);
        // Flames are dragged back over the car at speed, which is why a burning
        // car at 40 m/s streams fire down its own flank instead of upward.
        GP.vx = cvx * 0.55 + (rnd() - 0.5) * 1.2;
        GP.vy = 1.4 + rnd() * 1.8;
        GP.vz = cvz * 0.55 + (rnd() - 0.5) * 1.2;
        glowSpawn();
      }
    }

    slot.glowDebt += 12 * dt;
    let m = slot.glowDebt | 0;
    slot.glowDebt -= m;
    if (m > 3) m = 3;
    if (m > 0) {
      GP.flick = 0; GP.flat = 1; GP.bounce = 0;
      GP.r = FIRE_GLOW[0]; GP.g = FIRE_GLOW[1]; GP.b = FIRE_GLOW[2];
      GP.vx = 0; GP.vy = 0; GP.vz = 0;
      GP.drag = 8; GP.rise = 0; GP.spin = 0.4; GP.jitter = 0.5;
      GP.life = 0.42;
      GP.grow = 0.6;
      GP.floor = -1e9;
      // Kept under SIZE_CAP on purpose: the cap exists to bound smoke overdraw,
      // and letting it clip the ground decal instead would silently stop the
      // pool of light growing with the fire at exactly the point it matters.
      GP.size0 = 2.2 + fire * 1.8;
      GP.alpha0 = fire * 0.18 * (0.35 + 0.65 * night);
      const f = lerp(F_SHUT, F_NOSE, fire) * cwb;
      for (let k = 0; k < m; k++) {
        GP.x = localX(car, f, 0);
        GP.z = localZ(car, f, 0);
        GP.y = cGroundY + 0.05;
        glowSpawn();
      }
    }
  }

  /**
   * Sparks. Two sources, both of them metal on tarmac.
   *
   * A blown tyre is read per corner from damage.state.blown rather than from
   * effects.sparks, because effects.sparks is a single aggregate flag and this
   * needs to know WHICH corner is on its rim. A part that has torn off leaves
   * its mounting behind, and that is what drags — the exhaust and both bumpers
   * hang low enough to reach the road once their hangers have gone.
   */
  function emitGroundSparks(car, d, slot, dt) {
    if (!particles) return;
    const st = d.state;
    const rnd = Math.random;
    // The shower goes BACKWARDS relative to travel: the rim is dragging the
    // sparks off itself, so they leave against the direction of motion.
    const inv = cSpeed > 0.1 ? -1 / cSpeed : 0;
    const bx = cvx * inv, bz = cvz * inv;

    if (cSpeed > 3.5) {
      for (let i = 0; i < 4; i++) {
        if (!st.blown[i]) continue;
        slot.sparkDebt[i] += Math.min(26, (cSpeed - 3.5) * 1.4) * dt;
        let n = slot.sparkDebt[i] | 0;
        slot.sparkDebt[i] -= n;
        if (n > 6) n = 6;
        if (n <= 0) continue;
        const f = (i < 2 ? 0.5 : -0.5) * cwb;
        const r = (i % 2 ? 0.5 : -0.5) * ctr;
        particles.emitSparks(
          localX(car, f, r), cGroundY + 0.02, localZ(car, f, r), n, bx, bz);
      }
    }

    if (cSpeed > 5) {
      let dragging = 0;
      if (!st.attached.exhaust) { DRAG_F[dragging] = -F_EXHAUST * cwb; DRAG_R[dragging++] = R_EXHAUST * ctr * 0.5; }
      if (!st.attached.rearBumper) { DRAG_F[dragging] = -F_NOSE * cwb; DRAG_R[dragging++] = 0; }
      if (!st.attached.frontBumper) { DRAG_F[dragging] = F_NOSE * cwb; DRAG_R[dragging++] = 0; }
      if (dragging > 0) {
        slot.dragDebt += Math.min(14, (cSpeed - 5) * 0.55 * dragging) * dt;
        let n = slot.dragDebt | 0;
        slot.dragDebt -= n;
        if (n > 6) n = 6;
        if (n > 0) {
          // One shower per frame, from a point picked at random among whatever
          // is dragging. Emitting from all of them at once would triple the rate
          // the debt above was sized for; always emitting from the last one
          // found means a car that has lost its exhaust AND its front bumper
          // only ever sparks at the front, which reads as a bug.
          const k = Math.min(dragging - 1, (rnd() * dragging) | 0);
          // Jittered across the car's width, because a bumper mounting scrapes
          // over a hand's breadth of road rather than through one point.
          const jr = DRAG_R[k] + (rnd() - 0.5) * ctr * 0.5;
          particles.emitSparks(
            localX(car, DRAG_F[k], jr), cGroundY + 0.02, localZ(car, DRAG_F[k], jr), n, bx, bz);
        }
      }
    }
  }

  /**
   * The wet trail a holed radiator leaves.
   *
   * Gated on distance travelled, not on time: a car standing still with a split
   * radiator makes a puddle, not a trail, and stacking stamps on one spot would
   * darken it toward black.
   *
   * The spacing GROWS with speed, which is the part that was wrong first time
   * round. Coolant drips at a rate set by the hole, not by the road, so a fixed
   * 0.34 m gap meant 70 stamps a second at 24 m/s — the ring buffer wrapped
   * every 3.6 s and the trail was 87 m long against a 24 s fade. Spacing it by
   * (0.34 + 0.10 x speed) gives about nine stamps a second at any speed, which
   * fills 700 m of road and reads as separated splashes rather than a smear
   * that would be mistaken for a skid mark.
   */
  function emitCoolantTrail(car, d, slot) {
    const st = d.state;
    if (st.radiator > 0.92 || st.coolant <= 0.02) return;
    const f = F_SHUT * cwb * 0.4;
    const x = localX(car, f, 0), z = localZ(car, f, 0);
    if (!slot.wetSeen) { slot.wetSeen = true; slot.wetX = x; slot.wetZ = z; return; }
    const dx = x - slot.wetX, dz = z - slot.wetZ;
    const step = WET_STEP + cSpeed * 0.10;
    if (dx * dx + dz * dz < step * step) return;
    slot.wetX = x; slot.wetZ = z;
    const y = ground ? ground.heightAt(x, z) + 0.03 : cGroundY + 0.03;
    // Wider as more of the charge is coming out at once, and it thins to nothing
    // as the last of it goes.
    wetStamp(x, y, z, 0.34 + (1 - st.radiator) * 0.30 * Math.min(1, st.coolant * 3));
  }

  // =========================================================================
  // One-shots, driven by the event queue
  // =========================================================================

  function burstSmoke(x, y, z, n, col, life, size0, alpha0, rise, spread, advect) {
    SP.r = col[0]; SP.g = col[1]; SP.b = col[2];
    SP.size0 = size0; SP.alpha0 = alpha0;
    SP.grow = 1.6; SP.drag = 2.6; SP.rise = rise; SP.spin = 1.4; SP.jitter = 0.18;
    SP.floor = cGroundY + 0.05;
    SP.x = x; SP.y = y; SP.z = z;
    const rnd = Math.random;
    for (let k = 0; k < n; k++) {
      SP.life = life + rnd() * life * 0.5;
      SP.vx = cvx * advect + (rnd() - 0.5) * spread;
      SP.vy = 0.6 + rnd() * spread * 0.6;
      SP.vz = cvz * advect + (rnd() - 0.5) * spread;
      smokeSpawn();
    }
  }

  /**
   * A one-shot spray of shards. Inert glints, not flames — iFlick stays at zero,
   * so they take the radial cell of the atlas and never cool toward red. They
   * are given the car's velocity almost in full and real gravity, so at speed
   * the spray hangs in the air where the car was and the car drives out from
   * under it, which is what a broken window actually looks like from behind.
   */
  function burstShards(x, y, z, n, col, outX, outZ, speed) {
    const rnd = Math.random;
    GP.r = col[0]; GP.g = col[1]; GP.b = col[2];
    GP.flick = 0; GP.flat = 0; GP.bounce = 0.28;
    GP.grow = 0; GP.drag = 0.55; GP.rise = -13; GP.spin = 3;
    GP.jitter = 0.12; GP.floor = cGroundY + 0.02;
    GP.x = x; GP.y = y; GP.z = z;
    for (let k = 0; k < n; k++) {
      GP.life = 0.55 + rnd() * 0.75;
      GP.size0 = 0.030 + rnd() * 0.050;
      GP.alpha0 = 0.55 + rnd() * 0.45;
      GP.vx = cvx * 0.9 + outX * speed * (0.4 + rnd()) + (rnd() - 0.5) * 2.6;
      GP.vy = 1.2 + rnd() * 3.0;
      GP.vz = cvz * 0.9 + outZ * speed * (0.4 + rnd()) + (rnd() - 0.5) * 2.6;
      glowSpawn();
    }
  }

  /** Where a pane of glass sits, in forward/right metres. Filled per call. */
  const GLASS_AT = { f: 0, r: 0, y: 0, ox: 0, oz: 0 };

  function glassPlace(car, which) {
    if (which === 'windscreen') {
      GLASS_AT.f = F_SHUT * cwb; GLASS_AT.r = 0; GLASS_AT.y = Y_SCREEN;
      GLASS_AT.ox = cfx; GLASS_AT.oz = cfz;
    } else if (which === 'rear') {
      GLASS_AT.f = -0.30 * cwb; GLASS_AT.r = 0; GLASS_AT.y = Y_SCREEN;
      GLASS_AT.ox = -cfx; GLASS_AT.oz = -cfz;
    } else if (which === 'sideL') {
      GLASS_AT.f = -0.02 * cwb; GLASS_AT.r = -R_GLASS * ctr; GLASS_AT.y = Y_SCREEN;
      GLASS_AT.ox = -crx; GLASS_AT.oz = -crz;
    } else {
      GLASS_AT.f = -0.02 * cwb; GLASS_AT.r = R_GLASS * ctr; GLASS_AT.y = Y_SCREEN;
      GLASS_AT.ox = crx; GLASS_AT.oz = crz;
    }
  }

  /**
   * Consume one car's drained event queue.
   *
   * The queue is drained by whoever owns the damage model — main.js — and handed
   * here, because drainEvents() empties itself and exactly one consumer may call
   * it. Passing the array in is what lets audio, the renderer and this module
   * all see the same bang.
   */
  function applyEvents(events, car) {
    if (!events || !events.length || !car || !car.damage) return;
    bindCar(car);
    const slot = slotFor(car);
    const rnd = Math.random;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'glass-shatter': {
          glassPlace(car, e.glass);
          const x = localX(car, GLASS_AT.f, GLASS_AT.r);
          const z = localZ(car, GLASS_AT.f, GLASS_AT.r);
          burstShards(x, car.y + GLASS_AT.y * cwr, z, 16,
            SHARD_GLASS, GLASS_AT.ox, GLASS_AT.oz, 3.4);
          break;
        }
        case 'light-smash': {
          const front = e.light === 'headL' || e.light === 'headR';
          const left = e.light === 'headL' || e.light === 'tailL';
          const f = (front ? F_NOSE : -F_NOSE) * cwb;
          const r = (left ? -1 : 1) * (front ? R_LAMP_F : R_LAMP_R) * ctr;
          const ox = front ? cfx : -cfx, oz = front ? cfz : -cfz;
          burstShards(localX(car, f, r), car.y + (front ? Y_LAMP_F : Y_LAMP_R) * cwr,
            localZ(car, f, r), 7, SHARD_LAMP, ox, oz, 2.4);
          break;
        }
        case 'tyre-burst': {
          const w = e.wheel | 0;
          const f = (w < 2 ? 0.5 : -0.5) * cwb;
          const r = (w % 2 ? 0.5 : -0.5) * ctr;
          const x = localX(car, f, r), z = localZ(car, f, r);
          // Rubber smoke first: a carcass letting go dumps hot rubber dust that
          // hangs where the tyre was, so it is advected only lightly.
          burstSmoke(x, cGroundY + 0.22, z, 10, SMOKE_RUBBER, 0.55, 0.16, 0.24, 2.2, 3.2, 0.45);
          // Then the kick — grit and shredded tread thrown along the road.
          if (particles) {
            particles.emitDust(x, cGroundY + 0.05, z, 9, 0x171719);
            const inv = cSpeed > 0.1 ? -1 / cSpeed : 0;
            particles.emitSparks(x, cGroundY + 0.02, z, 5, cvx * inv, cvz * inv);
          }
          break;
        }
        case 'coolant-leak': {
          // damage.js emits this on EVERY impact once the radiator is holed, so
          // a car being ground along a wall would otherwise steam continuously.
          // The trail keeps running regardless; only the plume is rationed.
          if (slot.steamCool > 0) break;
          slot.steamCool = 2.5;
          const f = F_NOSE * cwb * 0.85;
          burstSmoke(localX(car, f, 0), cGroundY + 0.30 + cwr * 0.4, localZ(car, f, 0),
            14, SMOKE_STEAM, 0.75, 0.13, 0.17, 3.4, 2.4, 0.55);
          break;
        }
        case 'fire-start': {
          const f = lerp(F_SHUT, F_NOSE, 0.3) * cwb;
          const x = localX(car, f, 0), z = localZ(car, f, 0);
          const y = car.y + Y_SHUT * cwr;
          GP.flick = 1; GP.flat = 0; GP.bounce = 0;
          GP.drag = 3.0; GP.rise = 7.0; GP.spin = 0.3; GP.jitter = 0.30;
          GP.floor = cGroundY; GP.grow = 1.8;
          GP.x = x; GP.y = y; GP.z = z;
          for (let k = 0; k < 18; k++) {
            const t = rnd();
            GP.r = lerp(FIRE_COOL[0], FIRE_HOT[0], t);
            GP.g = lerp(FIRE_COOL[1], FIRE_HOT[1], t);
            GP.b = lerp(FIRE_COOL[2], FIRE_HOT[2], t);
            GP.life = 0.30 + rnd() * 0.40;
            GP.size0 = 0.22 + rnd() * 0.26;
            GP.alpha0 = 0.55 + rnd() * 0.35;
            GP.vx = cvx * 0.5 + (rnd() - 0.5) * 3.4;
            GP.vy = 2.4 + rnd() * 3.0;
            GP.vz = cvz * 0.5 + (rnd() - 0.5) * 3.4;
            glowSpawn();
          }
          burstSmoke(x, y + 0.2, z, 8, SMOKE_BLACK, 1.6, 0.30, 0.28, 2.6, 2.2, 0.7);
          break;
        }
        case 'fire-out': {
          // Airflow blowing a fire out leaves a big trailing wisp of steam and
          // half-burnt oil, which is the only signal the player gets that the
          // gamble of driving faster actually worked.
          const f = lerp(F_SHUT, F_NOSE, 0.4) * cwb;
          burstSmoke(localX(car, f, 0), car.y + Y_SHUT * cwr, localZ(car, f, 0),
            20, SMOKE_STEAM, 1.3, 0.28, 0.20, 2.8, 2.6, 0.8);
          break;
        }
        case 'detach': {
          // lz is metres FORWARD in damage.js's frame, which is what `f` is here.
          const f = e.lz || 0, r = e.lx || 0;
          const x = localX(car, f, r), z = localZ(car, f, r);
          if (particles) {
            const inv = cSpeed > 0.1 ? -1 / cSpeed : 0;
            particles.emitSparks(x, cGroundY + 0.10, z,
              4 + Math.min(14, (e.speed || cSpeed) * 0.5), cvx * inv, cvz * inv);
          }
          burstSmoke(x, cGroundY + 0.35, z, 3, SMOKE_GREY, 0.45, 0.14, 0.13, 1.8, 2.4, 0.6);
          break;
        }
        default:
          // glass-crack, system-failing, system-dead and the rest are for the
          // renderer, the HUD and the audio; nothing here throws particles at
          // them, and inventing something would only add noise to a real crash.
          break;
      }
    }
  }

  // =========================================================================
  // Update
  // =========================================================================
  const stats = { smoke: 0, glow: 0, wet: 0, cars: 0, active: 0 };

  function update(dt, cars, cameraPos) {
    // Infinity survives `dt > 0` and would pin `now` there forever, which makes
    // every wet stamp infinitely old and kills the whole trail layer for good.
    if (!(dt > 0) || dt === Infinity) dt = 0;
    now += dt;

    const cx = cameraPos ? cameraPos.x : 0;
    const cy = cameraPos ? cameraPos.y : 0;
    const cz = cameraPos ? cameraPos.z : 0;

    // ---- emission -----------------------------------------------------------
    let active = 0;
    const n = cars ? cars.length : 0;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (!car || !car.damage) continue;
      const d = car.damage;
      const st = d.state;
      const eff = d.effects;

      // The early out. An undamaged car reaches the end of this test and stops,
      // which is a handful of loads and compares — cheaper than the function
      // call that would otherwise wrap it, and it runs before anything touches
      // a slot, so an intact car never even costs a map lookup.
      const leaking = st.radiator < 0.92 && st.coolant > 0.02;
      const rimming = st.blown[0] || st.blown[1] || st.blown[2] || st.blown[3];
      const dragging = !st.attached.exhaust || !st.attached.frontBumper || !st.attached.rearBumper;
      if (eff.smoke <= 0.02 && eff.fire <= 0.01 && !leaking && !rimming && !dragging) continue;

      const slot = slotFor(car);
      if (slot.steamCool > 0) slot.steamCool -= dt;

      const ddx = car.x - cx, ddz = car.z - cz;
      if (ddx * ddx + ddz * ddz > CULL_SQ) continue;
      active++;

      bindCar(car);
      emitEngineSmoke(car, d, slot, dt);
      emitFire(car, d, slot, dt);
      if (rimming || dragging) emitGroundSparks(car, d, slot, dt);
      if (leaking) emitCoolantTrail(car, d, slot);
    }

    // ---- smoke --------------------------------------------------------------
    for (let i = 0; i < smokeAlive;) {
      const age = nAge[i] + dt;
      const life = nLife[i];
      if (age >= life) { smokeKill(i); continue; }
      nAge[i] = age;

      const i3 = i * 3;
      // Implicit drag — divide rather than subtract — so a large dt can never
      // overshoot into negative damping and fling a puff backwards.
      const dr = nDrag[i];
      const f = 1 / (1 + dr * dt);
      nVel[i3] = (nVel[i3] + WIND_X * dr * dt) * f;
      nVel[i3 + 1] = (nVel[i3 + 1] + nRise[i] * dt) * f;
      nVel[i3 + 2] = (nVel[i3 + 2] + WIND_Z * dr * dt) * f;

      const px = mPos[i3] + nVel[i3] * dt;
      let py = mPos[i3 + 1] + nVel[i3 + 1] * dt;
      const pz = mPos[i3 + 2] + nVel[i3 + 2] * dt;
      if (py < nFloor[i]) { py = nFloor[i]; nVel[i3 + 1] = 0; }
      mPos[i3] = px; mPos[i3 + 1] = py; mPos[i3 + 2] = pz;

      const dx = px - cx, dy = py - cy, dz = pz - cz;
      if (dx * dx + dy * dy + dz * dz > CULL_SQ) { smokeKill(i); continue; }

      let s = nSize0[i] + nGrow[i] * age;
      if (s > SIZE_CAP) s = SIZE_CAP;
      mSize[i] = s;

      const tail = 1 - age / life;
      const fadeIn = Math.min(1, age / 0.12);
      mAlpha[i] = nAlpha0[i] * fadeIn * tail * tail;
      mRot[i] += nSpin[i] * dt;
      i++;
    }

    // ---- glow ---------------------------------------------------------------
    for (let i = 0; i < glowAlive;) {
      const age = hAge[i] + dt;
      const life = hLife[i];
      if (age >= life) { glowKill(i); continue; }
      hAge[i] = age;

      const i3 = i * 3;
      const dr = hDrag[i];
      const f = 1 / (1 + dr * dt);
      let vx = hVel[i3] * f;
      let vy = (hVel[i3 + 1] + hRise[i] * dt) * f;
      let vz = hVel[i3 + 2] * f;

      let px = gPos[i3] + vx * dt;
      let py = gPos[i3 + 1] + vy * dt;
      let pz = gPos[i3 + 2] + vz * dt;

      const floor = hFloor[i];
      if (py < floor) {
        py = floor;
        const b = hBounce[i];
        if (b > 0) { vy = -vy * b; vx *= 0.6; vz *= 0.6; if (vy < 0.4) vy = 0; }
        else vy = 0;
      }
      gPos[i3] = px; gPos[i3 + 1] = py; gPos[i3 + 2] = pz;
      hVel[i3] = vx; hVel[i3 + 1] = vy; hVel[i3 + 2] = vz;

      const dx = px - cx, dy = py - cy, dz = pz - cz;
      if (dx * dx + dy * dy + dz * dz > CULL_SQ) { glowKill(i); continue; }

      const t = age / life;
      gAgeN[i] = t;
      let s = hSize0[i] + hGrow[i] * age;
      if (s > SIZE_CAP) s = SIZE_CAP;
      gSize[i] = s;
      const tail = 1 - t;
      gAlpha[i] = hAlpha0[i] * Math.min(1, age / 0.05) * tail * tail;
      gRot[i] += hSpin[i] * dt;
      i++;
    }

    // ---- upload -------------------------------------------------------------
    // Full re-uploads of the instanced pools. At 520 and 384 instances these are
    // tens of kilobytes, and skipping update ranges keeps this path free of the
    // { start, count } objects addUpdateRange() would allocate every frame.
    smokeGeo.instanceCount = smokeAlive;
    if (smokeAlive > 0) {
      aSmokePos.needsUpdate = true;
      aSmokeCol.needsUpdate = true;
      aSmokeSize.needsUpdate = true;
      aSmokeAlpha.needsUpdate = true;
      aSmokeRot.needsUpdate = true;
    }
    smokeMesh.visible = smokeAlive > 0;

    glowGeo.instanceCount = glowAlive;
    if (glowAlive > 0) {
      aGlowPos.needsUpdate = true;
      aGlowCol.needsUpdate = true;
      aGlowSize.needsUpdate = true;
      aGlowAlpha.needsUpdate = true;
      aGlowRot.needsUpdate = true;
      aGlowFlick.needsUpdate = true;
      aGlowFlat.needsUpdate = true;
      aGlowAge.needsUpdate = true;
    }
    glowMat.uniforms.uTime.value = now;
    glowMesh.visible = glowAlive > 0;

    wetMat.uniforms.uTime.value = now;
    if (wetDirty) {
      wetGeo.instanceCount = wetHigh;
      aWetPos.needsUpdate = true;
      aWetSize.needsUpdate = true;
      aWetRot.needsUpdate = true;
      aWetBirth.needsUpdate = true;
      wetDirty = false;
      wetMesh.visible = true;
    } else if (wetMesh.visible && wetHigh > 0 && now - wetNewest > WET_LIFE) {
      // The whole trail eventually dries, and only then may the layer go dark.
      // This tested the OLDEST slot first time round, which is exactly backwards:
      // a car that leaks for the eighteen seconds it takes a holed radiator to
      // empty lays stamps over eighteen seconds, so when the first one dried
      // there was still up to eighteen seconds — four hundred metres at 24 m/s —
      // of perfectly wet trail behind it, and all of it vanished in one frame.
      // The newest stamp is the last to dry, so once IT has gone, every stamp
      // has. Resetting the ring here is safe for the same reason.
      wetMesh.visible = false;
      wetHigh = 0;
      wetCursor = 0;
    }

    stats.smoke = smokeAlive;
    stats.glow = glowAlive;
    stats.wet = wetHigh;
    stats.cars = n;
    stats.active = active;
  }

  function setNight(n) { night = clamp(n ?? 0, 0, 1); }

  function reset() {
    smokeAlive = 0;
    glowAlive = 0;
    wetCursor = 0; wetHigh = 0; wetDirty = false;
    wetNewest = -1e6;
    wBirth.fill(-1e6);
    smokeGeo.instanceCount = 0;
    glowGeo.instanceCount = 0;
    wetGeo.instanceCount = 0;
    smokeMesh.visible = false;
    glowMesh.visible = false;
    wetMesh.visible = false;
    slots = new WeakMap();
    now = 0;
    stats.smoke = stats.glow = stats.wet = stats.cars = stats.active = 0;
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    smokeGeo.dispose(); smokeMat.dispose();
    glowGeo.dispose(); glowMat.dispose();
    wetGeo.dispose(); wetMat.dispose();
    if (atlas) atlas.dispose();
  }

  return {
    group,
    update, applyEvents, reset, dispose, setNight,
    stats,
    limits: { smoke: MAX_SMOKE, glow: MAX_GLOW, wet: MAX_WET, cull: CULL },
  };
}
