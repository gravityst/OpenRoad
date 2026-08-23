// Post-processing, and the pipeline that owns the frame.
//
// render(dt) replaces renderer.render(). Nothing else should call the renderer
// directly, because this module also owns tone mapping, output colour space
// and the device pixel ratio, and all three have to agree with whatever path
// the frame actually took.
//
// THE CHAIN, AND WHY IT IS IN THIS ORDER
//
//   RenderPass       scene -> half-float buffer, linear, NOT tone mapped
//   UnrealBloomPass  highlights only, added in linear light
//   SpeedPass        radial blur + vignette (ours)
//   OutputPass       ACES filmic + sRGB encode
//   FXAAPass         edge antialiasing, last
//
// Two of those positions are forced rather than chosen:
//
//  * Bloom must see linear HDR. three.js only tone-maps a material when it is
//    drawing to the canvas — WebGLPrograms gates it on
//    `currentRenderTarget === null` — so the moment a RenderPass is in play the
//    buffer really is linear and OutputPass is the one and only tone map. Move
//    OutputPass earlier and bloom would be pulling "bright" pixels out of an
//    already-compressed image where nothing exceeds 1, which does not give you
//    glowing headlights, it gives you a grey haze over the entire frame.
//  * FXAA must be last. It estimates edges from perceptual luma, so it wants
//    sRGB-encoded pixels, and three's FXAAShader deliberately does no colour
//    space conversion of its own — it passes the encoded values straight to the
//    canvas. Running it before OutputPass would have it hunting for edges in
//    linear light, where a bright sky flattens the luma gradient it needs.
//
// The speed blur sits between bloom and the tone map so that it smears the
// bloom halos along with the geometry. Headlights and lit windows drawing
// streaks is the entire point of the effect; blurring after the tone map would
// smear pixels that have already had their highlights crushed.
//
// WHY 'off' TEARS THE COMPOSER DOWN INSTEAD OF DISABLING EVERY PASS
//
// An EffectComposer costs two full-screen half-float render targets plus a copy
// even with every pass disabled — at 1080p that is roughly 32 MB of VRAM and an
// extra full-screen blit per frame. On the machines that need 'off' that is
// precisely the budget which is missing. So 'off' disposes the chain and calls
// renderer.render directly; materials then tone-map themselves on the way to
// the canvas, so the picture still matches the other tiers rather than going
// flat and washed out the moment you turn effects down.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

// Speed blur is fed a normalised 0..1 and the knee is here rather than in the
// caller, so that "subtle below 120 km/h" is a property of the effect and not
// of whoever happens to be driving the slider. Feed it speed / 92 m/s (about
// 330 km/h, the fast end of the catalog) and 120 km/h lands exactly on KNEE.
const KNEE = 0.36;

// Asymmetric so that lifting off clears the frame faster than getting on the
// power fogs it. Reading the road again the instant you brake is what makes
// the effect feel like speed rather than like a dirty windscreen.
const RISE_TAU = 0.30;   // s
const FALL_TAU = 0.16;   // s

// Null-prototype on purpose. A plain object literal would answer to
// TIERS['constructor'] and TIERS['toString'] with something truthy, so a stray
// settings string would sail past the `if (!TIERS[q])` guards below and then
// read .dpr off Function.prototype — undefined, which turns the pixel ratio into
// NaN and leaves the canvas with a zero-sized drawing buffer. Unknown tiers have
// to be genuinely unknown.
const TIERS = {
  __proto__: null,
  // dpr is a per-tier ceiling; the real ratio is min(devicePixelRatio, dpr, 2).
  // bloomScale is a fraction of the framebuffer: UnrealBloomPass already halves
  // whatever it is given, so 1.0 means its first mip is quarter-area.
  off: {
    composer: false, dpr: 1.0, bloom: null, bloomScale: 0,
    fxaa: false, taps: 4, chroma: 0, vignette: 0, shift: 0,
  },
  low: {
    composer: true, dpr: 1.0, bloom: null, bloomScale: 0,
    fxaa: false, taps: 4, chroma: 0, vignette: 0.85, shift: 0.100,
  },
  medium: {
    composer: true, dpr: 1.5, bloom: { strength: 0.42, radius: 0.55, threshold: 1.00 },
    bloomScale: 0.5, fxaa: true, taps: 6, chroma: 0, vignette: 1.00, shift: 0.120,
  },
  high: {
    composer: true, dpr: 2.0, bloom: { strength: 0.58, radius: 0.72, threshold: 0.90 },
    bloomScale: 1.0, fxaa: true, taps: 8, chroma: 1, vignette: 1.10, shift: 0.145,
  },
};

const SPEED_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Radial (zoom) blur plus vignette, in linear HDR.
//
// The blur is a straight line of taps from the pixel back toward the focus
// point, which is what a camera moving forward actually records. Two details do
// most of the work: nothing near the middle of the screen is touched, because
// that is where the road the player is steering at lives, and the tap weights
// fall off so the sharp original still dominates — otherwise it reads as a
// smudge rather than as motion.
const SPEED_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2  uFocus;      // where the streaks converge, in UV
uniform float uAspect;     // width / height, so the vignette stays a circle
uniform float uAmount;     // 0..1, already shaped and smoothed on the CPU
uniform float uShift;      // longest radial displacement, in UV, at uAmount = 1
uniform float uVignette;   // resting corner darkening
varying vec2 vUv;

void main() {
  vec2 d = vUv - uFocus;
  // Aspect-corrected radius. Without it the vignette turns into an ellipse and
  // reads as a letterbox rather than as a lens.
  float r = length(vec2(d.x * uAspect, d.y));

  float amt = uAmount * smoothstep(0.18, 0.95, r);

  // Uniform-coherent branch: at town speeds the whole draw is a single tap.
  vec4 col;
  if (amt > 0.002) {
    vec3  csum = vec3(0.0);   // colour, accumulated with a per-channel weight
    vec3  wsum = vec3(0.0);   // and the matching per-channel weight totals
    float asum = 0.0;
    float awsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
      float t = float(i) / float(TAPS - 1);
      float w = 1.0 - 0.45 * t;
      vec4 s = texture2D(tDiffuse, vUv - d * (t * amt * uShift));

      // With CHROMA off this is a flat vec3(w) and the loop is the plain radial
      // average it looks like.
      vec3 cw = vec3(w);
      #if CHROMA
        // Lateral dispersion, done by moving each channel's centre of mass along
        // the streak rather than by adding displaced taps: red is weighted toward
        // the long end, blue toward the short end. Every channel is still an
        // average of every tap, so all three come out equally blurred.
        //
        // The obvious alternative — sampling tDiffuse again at a displaced UV and
        // mixing that into the blurred result — silently undoes the blur for the
        // two channels it touches, because a single fetch is sharp no matter
        // where it lands. That reads as a coloured double image sitting on top of
        // a blurred one, not as a lens. This version also costs no extra fetches.
        float bias = 0.9 * amt * (t - 0.5);   // |bias| <= 0.45, so weights stay positive
        cw.r = w * (1.0 + bias);
        cw.b = w * (1.0 - bias);
      #endif

      csum += s.rgb * cw;
      wsum += cw;
      asum += s.a * w;
      awsum += w;
    }
    col = vec4(csum / wsum, asum / awsum);
  } else {
    col = texture2D(tDiffuse, vUv);
  }

  // Vignette deepens with speed. Done in linear light so ACES rolls the falloff
  // off smoothly; darkening after the tone map would band in the corners.
  float vig = uVignette * (1.0 + 1.9 * uAmount);
  col.rgb *= 1.0 - vig * smoothstep(0.30, 1.05, r);

  gl_FragColor = col;
}`;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera  kept by reference; mutate it, do not swap it
 * @param {object} [opts]  quality, maxPixelRatio, exposure, vignette, focusX, focusY,
 *                         width, height, updateStyle
 */
export function createEffects(renderer, scene, camera, opts = {}) {
  // Clamped rather than trusted: a zero, a negative or a non-number here would
  // propagate into renderer.setPixelRatio() and size the drawing buffer to
  // nothing, which looks like a dead canvas rather than like a bad option.
  const askedRatio = Number(opts.maxPixelRatio);
  const maxPixelRatio = Math.min(2, Math.max(0.5, askedRatio > 0 ? askedRatio : 2));
  // three's setSize would write inline width/height onto the canvas. The
  // stylesheet owns the canvas box here, so leave it alone unless asked.
  const updateStyle = opts.updateStyle === true;
  const vignetteBase = opts.vignette ?? 0.20;
  const focusX = opts.focusX ?? 0.5;
  const focusY = opts.focusY ?? 0.5;

  // ACES compresses midtones noticeably. A little over unity puts daylight back
  // where the scene lighting was authored instead of leaving the world muddy.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.05;

  const size = new THREE.Vector2();
  renderer.getSize(size);
  let width = Math.max(1, Math.floor(opts.width ?? size.x));
  let height = Math.max(1, Math.floor(opts.height ?? size.y));

  let quality = TIERS[opts.quality] ? opts.quality : 'high';

  let composer = null;
  let renderPass = null, bloomPass = null, speedPass = null, outputPass = null, fxaaPass = null;

  let blur = 0;         // smoothed, what the shader sees
  let blurTarget = 0;   // shaped from the last setSpeedBlur

  function buildChain() {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio());

    renderPass = new RenderPass(scene, camera);

    // Resolution is corrected in applySize(); the constructor value only has to
    // be non-zero, since addPass immediately overwrites it anyway.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.6, 1.0);

    speedPass = new ShaderPass({
      name: 'SpeedBlurShader',
      defines: { TAPS: 8, CHROMA: 1 },
      uniforms: {
        tDiffuse: { value: null },
        uFocus: { value: new THREE.Vector2(focusX, focusY) },
        uAspect: { value: width / height },
        uAmount: { value: 0 },
        uShift: { value: 0.14 },
        uVignette: { value: vignetteBase },
      },
      vertexShader: SPEED_VERT,
      fragmentShader: SPEED_FRAG,
    });

    outputPass = new OutputPass();
    fxaaPass = new FXAAPass();

    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(speedPass);
    composer.addPass(outputPass);
    composer.addPass(fxaaPass);
  }

  function teardown() {
    if (!composer) return;
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    composer = null;
    renderPass = bloomPass = speedPass = outputPass = fxaaPass = null;
  }

  function pixelRatio() {
    const device = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(device, TIERS[quality].dpr, maxPixelRatio);
  }

  function applySize() {
    const pr = pixelRatio();
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, updateStyle);
    if (!composer) return;

    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    speedPass.uniforms.uAspect.value = width / height;

    // composer.setSize() has just resized every pass to the full framebuffer.
    // Bloom is the one pass deliberately run below that, so it is corrected
    // afterwards rather than fighting the composer for ownership. When it is
    // switched off entirely its eleven render targets are shrunk to nothing,
    // because the tier that turns bloom off is the tier with no VRAM to spare.
    const t = TIERS[quality];
    const scale = t.bloom ? t.bloomScale : 0;
    bloomPass.setSize(
      scale > 0 ? Math.max(64, Math.round(width * pr * scale)) : 64,
      scale > 0 ? Math.max(64, Math.round(height * pr * scale)) : 64,
    );
  }

  function applyTier() {
    const t = TIERS[quality];
    if (!t.composer) {
      teardown();
      applySize();
      return;
    }
    if (!composer) buildChain();

    bloomPass.enabled = t.bloom !== null;
    if (t.bloom) {
      bloomPass.strength = t.bloom.strength;
      bloomPass.radius = t.bloom.radius;
      bloomPass.threshold = t.bloom.threshold;
    }
    fxaaPass.enabled = t.fxaa;

    const defines = speedPass.material.defines;
    if (defines.TAPS !== t.taps || defines.CHROMA !== t.chroma) {
      defines.TAPS = t.taps;
      defines.CHROMA = t.chroma;
      speedPass.material.needsUpdate = true;
    }
    speedPass.uniforms.uShift.value = t.shift;
    speedPass.uniforms.uVignette.value = vignetteBase * t.vignette;

    applySize();
  }

  /** Call instead of renderer.render(). dt is seconds since the last frame. */
  function render(dt) {
    // A tab that has been in the background hands back a delta of many seconds.
    // Clamping keeps the blur from snapping to its target in a single frame.
    const d = dt > 0 && dt < 0.25 ? dt : 1 / 60;
    const tau = blurTarget > blur ? RISE_TAU : FALL_TAU;
    blur += (blurTarget - blur) * (1 - Math.exp(-d / tau));

    if (!composer) {
      renderer.render(scene, camera);
      return;
    }
    speedPass.uniforms.uAmount.value = blur;
    composer.render(d);
  }

  /** Size in CSS pixels. The device pixel ratio is applied here, not by you. */
  function setSize(w, h) {
    width = Math.max(1, Math.floor(w));
    height = Math.max(1, Math.floor(h));
    applySize();
  }

  /** 'off' | 'low' | 'medium' | 'high'. Safe to call at any time. */
  function setQuality(q) {
    if (!TIERS[q] || q === quality) return;
    quality = q;
    applyTier();
  }

  /**
   * 0..1 of top speed — feed it clamp(car.speed / 92, 0, 1). Held flat below
   * the knee so that town driving is clean and only motorway speeds streak.
   */
  function setSpeedBlur(v) {
    const n = v > 1 ? 1 : v > 0 ? v : 0;
    const s = n <= KNEE ? 0 : (n - KNEE) / (1 - KNEE);
    blurTarget = s * s * (3 - 2 * s);   // smoothstep: no kink at the knee
  }

  function dispose() {
    teardown();
  }

  applyTier();

  return {
    render, setSize, setQuality, setSpeedBlur, dispose,
    get quality() { return quality; },
  };
}
