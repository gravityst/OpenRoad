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
//                    (4x MSAA on the high tier)
//   UnrealBloomPass  highlights only, added in linear light
//   FinishPass       speed blur, vignette, exposure, ACES, sRGB, grade, dither
//   FXAAPass         edge antialiasing, last (not on high, which has MSAA)
//
// Two of those positions are forced rather than chosen:
//
//  * Bloom must see linear HDR. three.js only tone-maps a material when it is
//    drawing to the canvas, so the moment a RenderPass is in play the buffer
//    really is linear and the finish pass is the one and only tone map. Bloom
//    after a tone map pulls "bright" pixels out of an already-compressed
//    image and gives a grey haze over the frame rather than glowing lamps.
//  * FXAA must be last. It estimates edges from perceptual luma, so it wants
//    sRGB-encoded pixels, and it does no colour-space conversion of its own.
//
// The speed blur, vignette, tone map and grade used to be two passes (a
// ShaderPass and three's OutputPass). They are one now: every one of them
// is a per-pixel function of the linear buffer, and a full-screen pass is a
// full read and write of a half-float frame, which on an integrated GPU at
// 1080p is most of a millisecond for nothing.
//
// THE GRADE
//
// ACES alone makes a frame that is correct and dull: it compresses the
// midtones and leaves the whole image sitting in the same flat band, which is
// a large part of why the game read as a render rather than a picture. The
// grade is small on purpose — this is a driving game, not a music video:
//
//   * a gentle S-curve about mid-grey, so shadows have weight and highlights
//     have snap, without crushing either end;
//   * split toning by luminance: the shadows lean a touch toward the sky's
//     blue, the highlights a touch toward the sun's warmth, which is what
//     real daylight does to a photograph and what makes it read as daylight;
//   * vibrance rather than saturation, so the grass and the paintwork gain a
//     little colour and the already-saturated sunset does not go neon;
//   * 1/255 of triangular dither, because the sky and the haze are long
//     smooth gradients and 8 bits of output bands them into contour lines.
//
// EXPOSURE
//
// The eye adapts, and a game that does not reads as either a noon that is
// fine and a night you cannot drive in, or the reverse. There is no luminance
// readback here (it would stall the pipeline); the sky publishes how dark it
// is on scene.userData.sky and exposure follows that on a slow curve, opening
// up by about 0.8 EV at full night — enough to keep the road readable under
// moonlight without pretending it is day.
//
// CHANGING TIER MID-GAME COSTS NO SHADER COMPILES
//
// main.js steps the post tier down on a machine that cannot hold 60 fps (and
// back up when it can), so a tier change happens while someone is driving and
// must not stall. Two things used to make it stall. The finish shader's tap
// count and chromatic split were #defines, so every tier change compiled a new
// program and threw the old one away (switching back compiled it again). They
// are uniforms now: one program serves every tier. And the MSAA tier rebuilt
// the whole chain — new targets, new materials, every post shader compiled
// afresh — where only the scene pass differs. Now just that pass is swapped.
//
// RESOLUTION SCALE
//
// setResolutionScale() renders the frame at a fraction of the tier's pixel
// ratio and lets the canvas scale it up: at 0.8 the GPU shades 64% of the
// pixels. It is the gentlest lever there is on a GPU-bound machine — the image
// softens slightly, nothing appears or disappears — so it is the first one the
// automatic quality in main.js reaches for.
//
// Its optional second argument names the tier whose pixel-ratio CAP the scale
// applies to. The automatic quality passes the tier the player chose, so
// stepping the post tier down does not also cut the resolution. Without it, on
// a devicePixelRatio-2 laptop, medium's cap is 1.5 and low's 1.0: the ladder's
// step from (0.8, medium) to (0.8, low) went from 1.2 to 0.8 device pixels per
// CSS pixel, 44% of the pixels in one step where it expected 100%, and the
// predicted cost of stepping back up was 2.25x too low, so it kept probing up,
// failing and dropping back — 15 changes in 10 minutes, simulated.
//
// NO RESIZE EVER LANDS BETWEEN A RENDER AND THE SCREEN
//
// Changing the pixel ratio resizes the canvas, and resizing a WebGL canvas
// clears its drawing buffer. Done after the frame was drawn — which is where
// the automatic quality used to apply its decision, at the end of the frame —
// the browser composited that cleared, transparent canvas over the page: one
// fully black frame for every quality change (measured: the centre pixel read
// 218,216,187 before force(2) and 0,0,0,0 straight after it, in the same task).
// So nothing here resizes on the spot. Every change marks the size stale, and
// the next render() or prewarm() applies it immediately before drawing — the
// only moment a resize is invisible. It also coalesces: a step that changes
// both the scale and the tier reallocates the targets once, not twice.
//
// GPU TIME
//
// With setGpuTiming(true) and EXT_disjoint_timer_query_webgl2 available, one
// frame in every few is timed on the GPU and `gpuMs` holds a smoothed figure.
// The query is read back frames later, never waited on, so it costs nothing
// on the CPU. The automatic quality uses it to tell a GPU-bound machine (where
// fewer pixels help) from a CPU-bound one (where they only blur the picture).
//
// WHY 'off' TEARS THE COMPOSER DOWN INSTEAD OF DISABLING EVERY PASS
//
// An EffectComposer costs two full-screen half-float render targets plus a copy
// even with every pass disabled — at 1080p roughly 32 MB of VRAM and an extra
// blit per frame. On the machines that need 'off' that is precisely the budget
// which is missing. So 'off' disposes the chain and calls renderer.render
// directly; materials then tone-map themselves on the way to the canvas.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

// Speed blur is fed a normalised 0..1 and the knee is here rather than in the
// caller, so that "subtle below 120 km/h" is a property of the effect and not
// of whoever happens to be driving the slider.
const KNEE = 0.36;

// Asymmetric so that lifting off clears the frame faster than getting on the
// power fogs it.
const RISE_TAU = 0.30;   // s
const FALL_TAU = 0.16;   // s

// Bloom strength per second when a tier change turns it on or off, so it fades
// over about a second instead of every lamp losing its glow in one frame.
const BLOOM_FADE = 0.35;

// Exposure adaptation: seconds for the eye to follow a change in light.
const ADAPT_TAU = 2.5;
// Stops of extra exposure at full night.
const NIGHT_EV = 0.8;

// Null-prototype on purpose: a plain literal would answer TIERS['toString']
// with something truthy and send a stray settings string past the guards.
const TIERS = {
  __proto__: null,
  // dpr is a per-tier ceiling; the real ratio is min(devicePixelRatio, dpr, 2).
  //
  // Bloom is deliberately restrained, and STRENGTH is the lever that matters.
  // The pass sees LINEAR values, so the threshold sits well above anything a
  // lit surface reaches: only the sun, lamps and lit windows should clear it.
  // Measured on midday tarmac with the old sky: threshold 1.00 doubled the
  // road's brightness, 61 -> 123. At 0.24-0.30 strength the road lifts about
  // 15%, which reads as air rather than as fog.
  //
  // `grade` scales the whole look from 0 (plain ACES) to 1.
  off: {
    composer: false, dpr: 1.0, msaa: 0, bloom: null, bloomScale: 0,
    fxaa: false, taps: 4, chroma: 0, vignette: 0, shift: 0, grade: 0,
  },
  low: {
    composer: true, dpr: 1.0, msaa: 0, bloom: null, bloomScale: 0,
    fxaa: false, taps: 4, chroma: 0, vignette: 0.85, shift: 0.100, grade: 1,
  },
  medium: {
    composer: true, dpr: 1.5, msaa: 0, bloom: { strength: 0.24, radius: 0.30, threshold: 2.2 },
    bloomScale: 0.5, fxaa: true, taps: 6, chroma: 0, vignette: 1.00, shift: 0.120, grade: 1,
  },
  // MSAA instead of FXAA: four real samples on every edge rather than a blur
  // that guesses where the edges are, which is what keeps fence posts, poles
  // and the car's own silhouette from crawling at speed.
  high: {
    composer: true, dpr: 2.0, msaa: 4, bloom: { strength: 0.30, radius: 0.38, threshold: 2.0 },
    bloomScale: 1.0, fxaa: false, taps: 8, chroma: 1, vignette: 1.10, shift: 0.145, grade: 1,
  },
};

const FINISH_VERT = /* glsl */`
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The finish: radial blur and vignette in linear HDR, then exposure and ACES,
// then sRGB, then the grade in display space, then dither.
//
// The blur is a straight line of taps from the pixel back toward the focus
// point, which is what a camera moving forward records. Nothing near the
// middle of the screen is touched — that is where the road the player is
// steering at lives — and the tap weights fall off so the sharp original
// still dominates, otherwise it reads as a smudge rather than as motion.
const FINISH_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tDiffuse;
// toneMappingExposure is declared by <tonemapping_pars_fragment>.
uniform vec2  uFocus;      // where the streaks converge, in UV
uniform float uAspect;     // width / height, so the vignette stays a circle
uniform float uAmount;     // 0..1, already shaped and smoothed on the CPU
uniform float uShift;      // longest radial displacement, in UV, at uAmount = 1
uniform float uVignette;   // resting corner darkening
uniform float uGrade;      // 0 = plain ACES, 1 = the full grade
uniform float uSeed;       // changes every frame, so the dither never sits still
uniform int   uTaps;       // blur taps, 2..MAX_TAPS: a uniform, not a define, so
uniform float uChroma;     // a tier change never compiles a new program

#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>

varying vec2 vUv;

vec3 gradeDisplay(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Gentle S about mid-grey in display space: slope 1.12 in the middle,
  // easing to 1 at both ends so nothing is clipped that was not already.
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, mix(c, s, 0.30), uGrade);
  // Split tone: cool shadows, warm highlights, a percent or two each way.
  float hi = smoothstep(0.35, 0.95, l), lo = 1.0 - smoothstep(0.05, 0.45, l);
  c += uGrade * (vec3(0.012, 0.004, -0.014) * hi + vec3(-0.006, 0.000, 0.012) * lo);
  // Vibrance: lift the saturation of what is not already saturated.
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  float v = uGrade * 0.12 * (1.0 - sat);
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.0 + v);
  return clamp(c, 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 d = vUv - uFocus;
  float r = length(vec2(d.x * uAspect, d.y));
  float amt = uAmount * smoothstep(0.18, 0.95, r);

  vec4 col;
  // Uniform-coherent branch: at town speeds the whole draw is a single tap.
  if (amt > 0.002) {
    vec3 csum = vec3(0.0), wsum = vec3(0.0);
    float asum = 0.0, awsum = 0.0;
    // A constant bound with a uniform exit, because GLSL ES 1.00 only allows
    // constant loop bounds. uTaps is the same for every pixel, so the exit is
    // uniform control flow and costs nothing over a compiled-in count.
    float last = float(uTaps - 1);
    for (int i = 0; i < MAX_TAPS; i++) {
      if (i >= uTaps) break;
      float t = float(i) / last;
      float w = 1.0 - 0.45 * t;
      vec4 s = texture2D(tDiffuse, vUv - d * (t * amt * uShift));
      vec3 cw = vec3(w);
      // Lateral dispersion by moving each channel's centre of mass along the
      // streak, not by adding displaced taps: every channel is still an
      // average of every tap, so all three are equally blurred.
      float bias = uChroma * 0.9 * amt * (t - 0.5);
      cw.r = w * (1.0 + bias);
      cw.b = w * (1.0 - bias);
      csum += s.rgb * cw;
      wsum += cw;
      asum += s.a * w;
      awsum += w;
    }
    col = vec4(csum / wsum, asum / awsum);
  } else {
    col = texture2D(tDiffuse, vUv);
  }

  // Vignette in linear light, deepening with speed, so ACES rolls its falloff
  // off smoothly; darkening after the tone map bands in the corners.
  float vig = uVignette * (1.0 + 1.9 * uAmount);
  col.rgb *= 1.0 - vig * smoothstep(0.30, 1.05, r);

  col.rgb = ACESFilmicToneMapping(col.rgb);
  col = sRGBTransferOETF(col);
  col.rgb = gradeDisplay(col.rgb);

  // Triangular dither, +-1 LSB.
  float n = hash12(gl_FragCoord.xy + uSeed) + hash12(gl_FragCoord.yx * 1.37 + uSeed) - 1.0;
  col.rgb += n / 255.0;

  gl_FragColor = col;
}`;

/** The one full-screen pass between bloom and FXAA. */
class FinishPass extends Pass {
  constructor(defines, uniforms) {
    super();
    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      name: 'FinishShader',
      defines,
      uniforms,
      vertexShader: FINISH_VERT,
      fragmentShader: FINISH_FRAG,
    });
    this._quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen && this.clear) renderer.clear();
    this._quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._quad.dispose();
  }
}

/**
 * The scene render for the MSAA tier. Only the scene needs multisampling:
 * post passes are full-screen quads with no edges of their own, and running
 * them into 4x targets as well — which is what asking the composer for MSAA
 * does, since it clones one target for both buffers — spent a millisecond at
 * 720p resolving every pass. So the scene goes into its own multisampled
 * target, which resolves once, and a plain copy hands it to the chain.
 */
class MsaaRenderPass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.material);
  }

  setSize(w, h) { this.target.setSize(w, h); }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.material.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this._quad.dispose();
  }
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera  kept by reference; mutate it, do not swap it
 * @param {object} [opts]  quality, maxPixelRatio, exposure, vignette, focusX, focusY,
 *                         width, height, updateStyle
 */
export function createEffects(renderer, scene, camera, opts = {}) {
  // Clamped rather than trusted: a zero, a negative or a non-number here would
  // size the drawing buffer to nothing, which looks like a dead canvas.
  const askedRatio = Number(opts.maxPixelRatio);
  const maxPixelRatio = Math.min(2, Math.max(0.5, askedRatio > 0 ? askedRatio : 2));
  const updateStyle = opts.updateStyle === true;
  const vignetteBase = opts.vignette ?? 0.20;
  const focusX = opts.focusX ?? 0.5;
  const focusY = opts.focusY ?? 0.5;

  const baseExposure = opts.exposure ?? 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = baseExposure;
  let exposure = baseExposure;

  const size = new THREE.Vector2();
  renderer.getSize(size);
  let width = Math.max(1, Math.floor(opts.width ?? size.x));
  let height = Math.max(1, Math.floor(opts.height ?? size.y));

  let quality = TIERS[opts.quality] ? opts.quality : 'high';

  let composer = null;
  let renderPass = null, bloomPass = null, finishPass = null, fxaaPass = null;
  // The scene pass for the MSAA tier, built the first time it is asked for and
  // then kept, so stepping in and out of 'high' swaps one pass rather than
  // rebuilding the chain. Out of use, its target is shrunk to 1x1: a 4x
  // half-float target at 1080p is 66 MB nobody would be drawing into.
  let msaaPass = null;
  let activeMsaa = 0;

  // Fraction of the tier's pixel ratio actually rendered, and the tier whose
  // cap that is a fraction of (null: the current one). See setResolutionScale.
  let resScale = 1;
  let resBase = null;
  // The canvas and targets are out of date; render() fixes that before drawing.
  let sizeStale = true;

  // GPU timing: one query in flight at a time, read back when it is ready.
  let timerExt = null, timing = false, query = null, queryWait = 0;
  let gpuMs = NaN;

  // Bloom fades rather than switching. bloomNow is what is drawn, bloomWant
  // where the tier wants it; bloomScaleNow is the resolution its targets are
  // kept at, which stays up until a fade out has finished.
  let bloomNow = 0, bloomWant = 0, bloomScaleNow = 0, bloomSnap = true;

  let blur = 0;         // smoothed, what the shader sees
  let blurTarget = 0;   // shaped from the last setSpeedBlur
  let frameSeed = 0;

  const finishUniforms = {
    tDiffuse: { value: null },
    toneMappingExposure: { value: 1 },
    uFocus: { value: new THREE.Vector2(focusX, focusY) },
    uAspect: { value: width / height },
    uAmount: { value: 0 },
    uShift: { value: 0.14 },
    uVignette: { value: vignetteBase },
    uGrade: { value: 1 },
    uSeed: { value: 0 },
    uTaps: { value: 8 },
    uChroma: { value: 1 },
  };

  function buildChain(msaa) {
    const pr = pixelRatio();
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pr);

    renderPass = new RenderPass(scene, camera);
    // Resolution is corrected in applySize(); the constructor value only has
    // to be non-zero, since addPass immediately overwrites it.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.6, 1.0);
    finishPass = new FinishPass({ MAX_TAPS: 8 }, finishUniforms);
    fxaaPass = new FXAAPass();

    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(finishPass);
    composer.addPass(fxaaPass);
    activeMsaa = 0;
    useMsaa(msaa);
  }

  /**
   * The canvas's own antialias flag does nothing for a frame drawn
   * off-screen, so MSAA has to be asked for on a render target — and only on
   * the scene's (see MsaaRenderPass). Swaps the first pass; nothing else in
   * the chain is touched, so nothing is recompiled.
   */
  function useMsaa(samples) {
    if (!composer || samples === activeMsaa) return;
    const current = composer.passes[0];
    let next;
    if (samples > 0) {
      if (msaaPass && msaaPass.target.samples !== samples) { msaaPass.dispose(); msaaPass = null; }
      if (!msaaPass) msaaPass = new MsaaRenderPass(scene, camera, samples);
      next = msaaPass;
    } else {
      next = renderPass;
    }
    composer.removePass(current);
    composer.insertPass(next, 0);        // insertPass sizes it to the composer
    if (current === msaaPass && next !== msaaPass) msaaPass.setSize(1, 1);
    activeMsaa = samples;
  }

  function teardown() {
    bloomSnap = true;
    if (!composer) return;
    for (const pass of composer.passes) pass.dispose();
    // Whichever scene pass was NOT in the chain is not in passes either.
    if (msaaPass && composer.passes.indexOf(msaaPass) < 0) msaaPass.dispose();
    if (renderPass && composer.passes.indexOf(renderPass) < 0) renderPass.dispose();
    composer.dispose();
    composer = null;
    renderPass = bloomPass = finishPass = fxaaPass = msaaPass = null;
    activeMsaa = 0;
  }

  /** Device pixels per CSS pixel tier `tier` draws at full scale on this screen. */
  function capRatio(tier) {
    const device = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(device, TIERS[tier].dpr, maxPixelRatio);
  }

  function pixelRatio() {
    return capRatio(resBase || quality) * resScale;
  }

  /** The size is out of date. Applied by the next render(), just before it draws. */
  function applySize() { sizeStale = true; }

  function flushSize() {
    sizeStale = false;
    const pr = pixelRatio();
    // Only when the canvas really changes: assigning a canvas its own size
    // still reallocates the drawing buffer. Compared with the renderer's own
    // state, since main.js's resize handler also sets it.
    renderer.getSize(size);
    if (renderer.getPixelRatio() !== pr || size.x !== width || size.y !== height) {
      renderer.setPixelRatio(pr);
      renderer.setSize(width, height, updateStyle);
    }
    if (!composer) return;

    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    finishUniforms.uAspect.value = width / height;

    // composer.setSize() has just resized every pass to the full framebuffer.
    // Bloom is the one pass deliberately run below that, so it is corrected
    // afterwards. Switched off, its render targets shrink to nothing, because
    // the tier that turns bloom off is the tier with no VRAM to spare.
    sizeBloom(pr);
  }

  function sizeBloom(pr) {
    const scale = bloomScaleNow;
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
    if (!composer) { buildChain(t.msaa); bloomSnap = true; }
    else useMsaa(t.msaa);

    // Radius, threshold and target size change at once; the strength fades
    // in render(). A bloom on its way out keeps its last settings and size.
    bloomWant = t.bloom ? t.bloom.strength : 0;
    if (t.bloom) {
      bloomPass.radius = t.bloom.radius;
      bloomPass.threshold = t.bloom.threshold;
      bloomScaleNow = t.bloomScale;
    }
    if (bloomSnap) {
      // A new chain (first build, or back from 'off') has nothing on screen to
      // fade from.
      bloomNow = bloomWant;
      if (!t.bloom) bloomScaleNow = 0;
      bloomSnap = false;
    }
    bloomPass.strength = bloomNow;
    bloomPass.enabled = bloomNow > 0;
    fxaaPass.enabled = t.fxaa;

    finishUniforms.uTaps.value = t.taps;
    finishUniforms.uChroma.value = t.chroma;
    finishUniforms.uShift.value = t.shift;
    finishUniforms.uVignette.value = vignetteBase * t.vignette;
    finishUniforms.uGrade.value = t.grade;

    applySize();
  }

  /** Call instead of renderer.render(). dt is seconds since the last frame. */
  function render(dt) {
    // A tab that has been in the background hands back a delta of many seconds.
    const d = dt > 0 && dt < 0.25 ? dt : 1 / 60;
    const tau = blurTarget > blur ? RISE_TAU : FALL_TAU;
    blur += (blurTarget - blur) * (1 - Math.exp(-d / tau));

    // Adaptation, from how dark the sky says it is. Applied through the
    // renderer's own exposure, so the 'off' path — where materials tone-map
    // themselves — adapts exactly as the composer path does.
    const sky = scene.userData ? scene.userData.sky : null;
    const night = sky && Number.isFinite(sky.night) ? sky.night : 0;
    const want = baseExposure * Math.pow(2, NIGHT_EV * night);
    exposure += (want - exposure) * (1 - Math.exp(-d / ADAPT_TAU));
    renderer.toneMappingExposure = exposure;

    // Here and nowhere else: see "no resize ever lands between a render and
    // the screen" at the top.
    if (sizeStale) flushSize();
    const timed = beginTiming();
    if (!composer) {
      renderer.render(scene, camera);
    } else {
      if (bloomNow !== bloomWant) fadeBloom(d);
      finishUniforms.uAmount.value = blur;
      frameSeed = (frameSeed + 17.3) % 997;
      finishUniforms.uSeed.value = frameSeed;
      composer.render(d);
    }
    if (timed) endTiming();
  }

  function fadeBloom(d) {
    const step = BLOOM_FADE * d;
    bloomNow = bloomNow < bloomWant ? Math.min(bloomWant, bloomNow + step) : Math.max(bloomWant, bloomNow - step);
    bloomPass.strength = bloomNow;
    bloomPass.enabled = bloomNow > 0;
    // Faded all the way out: now the targets can shrink.
    if (bloomNow === 0 && bloomWant === 0 && bloomScaleNow > 0) {
      bloomScaleNow = 0;
      sizeBloom(pixelRatio());
    }
  }

  // A GPU timer query brackets one frame in every few. Reading it back is
  // polled, never waited for — waiting would stall the CPU on the GPU, which is
  // the one thing this must not do. `disjoint` means the GPU was interrupted
  // (a context switch, a power-state change) and that sample is discarded.
  function beginTiming() {
    if (!timing || !timerExt) return false;
    const gl = renderer.getContext();
    if (query) {
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return false;
      const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      if (!disjoint && ms >= 0 && ms < 1000) gpuMs = Number.isFinite(gpuMs) ? gpuMs + (ms - gpuMs) * 0.25 : ms;
      gl.deleteQuery(query);
      query = null;
      queryWait = 3;               // leave a few frames untimed between samples
    }
    if (queryWait > 0) { queryWait--; return false; }
    query = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    return true;
  }
  function endTiming() {
    renderer.getContext().endQuery(timerExt.TIME_ELAPSED_EXT);
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

  /**
   * Render at `s` (0.5..1) of the tier's pixel ratio. The canvas keeps its size
   * and the browser scales the frame up, so the picture softens a little
   * rather than changing. Reallocates the render targets, so it is for a
   * decision made every few seconds, not every frame.
   *
   * `base`, if given, is the tier whose pixel-ratio cap `s` scales ('low',
   * 'medium', ...); null goes back to following the current tier. Omitted, it
   * is left as it was.
   */
  function setResolutionScale(s, base) {
    const v = Math.min(1, Math.max(0.5, Number(s) || 1));
    const b = base === undefined ? resBase : (TIERS[base] ? base : null);
    if (v === resScale && b === resBase) return;
    const before = pixelRatio();
    resScale = v;
    resBase = b;
    // A new base with the same effective ratio (the player on 'medium' with
    // the base set to 'medium') changes nothing on screen: no reallocation.
    if (pixelRatio() !== before) applySize();
  }

  /** Start or stop timing frames on the GPU. False if the browser cannot. */
  function setGpuTiming(on) {
    timing = !!on;
    if (timing && !timerExt) {
      try { timerExt = renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2'); }
      catch { timerExt = null; }
    }
    if (!timing) {
      gpuMs = NaN;
      // A query still in flight would otherwise never be read or deleted.
      if (query) { try { renderer.getContext().deleteQuery(query); } catch { /* context gone */ } query = null; }
    }
    return !!(timing && timerExt);
  }

  /**
   * Compile every post pass now, including the ones this tier has switched
   * off, by drawing one frame with all of them on. Call it from a loading
   * screen: a pass switched on later (the automatic quality stepping back up to
   * bloom) then finds its shaders already built instead of stalling the frame
   * it first appears in.
   */
  function prewarm() {
    if (!composer) return;
    if (sizeStale) flushSize();
    const bloomWas = bloomPass.enabled, fxaaWas = fxaaPass.enabled;
    bloomPass.enabled = true;
    fxaaPass.enabled = true;
    try { composer.render(1 / 60); }
    finally { bloomPass.enabled = bloomWas; fxaaPass.enabled = fxaaWas; }
  }

  function dispose() {
    if (query) { try { renderer.getContext().deleteQuery(query); } catch { /* context gone */ } query = null; }
    teardown();
  }

  applyTier();

  return {
    render, setSize, setQuality, setSpeedBlur, dispose,
    setResolutionScale, setGpuTiming, prewarm,
    // Exposed so a harness can measure the effect rather than guess at it.
    get bloom() { return bloomPass; },
    get composer() { return composer; },
    get quality() { return quality; },
    get exposure() { return exposure; },
    get resolutionScale() { return resScale; },
    /** Smoothed GPU milliseconds per frame, or NaN when not measured. */
    get gpuMs() { return gpuMs; },
    /** The pixel ratio actually rendered at: device, tier cap and scale. */
    get pixelRatio() { return pixelRatio(); },
    /** A size change is waiting for the next render(), which applies it before drawing. */
    get sizePending() { return sizeStale; },
    /** The pixel ratio tier `tier` draws at full scale on this screen (the current tier if unknown). */
    basePixelRatio: (tier) => capRatio(TIERS[tier] ? tier : quality),
  };
}
