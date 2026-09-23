// Checks that the game moves smoothly at any frame rate, and that the
// automatic quality steps down on a slow machine and back up on a fast one
// without hunting.
//
// The physics runs at a fixed 120 Hz. Drawing the car wherever the last step
// left it looks fine at exactly 60 Hz and judders everywhere else: a 144 Hz
// screen gets 1 step, then 0, then 1; a 45 fps laptop gets 2, then 3. The car
// now draws `alpha` of the way between the poses either side of the last step
// (src/core/interp.js), and this proves the claim that fixes the judder:
//
//   with the frame time jittering anywhere between 1/144 and 1/40 s, the car
//   is drawn exactly (speed x frame time) further on every frame — no frame
//   that stands still, no frame that jumps two steps.
//
// It drives the loop main.js runs, line for line, and then reads main.js to
// make sure that IS the loop main.js runs: a harness that tests a copy proves
// nothing the day the original changes.
//
// Headless, so it cannot see the screen. What to look at in the browser is in
// the report that came with this harness; the short version is "drive at 144
// Hz and at a throttled 45 fps and watch the road markings, not the car".
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPoseBuffer, settleAccumulator, blendFactor, springAngleStep, followLinear, wrapPi,
} from '../src/core/interp.js';
import * as THREE from 'three';
import { createVehicle } from '../src/physics/vehicle.js';
import { createAdaptiveQuality, ladderFor, applyRung, createDisplayProbe } from '../src/core/adaptive.js';
import { createEffects } from '../src/render/effects.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) fail++;
};

// The same constants main.js uses; the text check at the end holds them equal.
const PHYS_HZ = 120, PHYS_DT = 1 / PHYS_HZ, MAX_SUBSTEPS = 12;

let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/**
 * main.js's frame loop, reduced to the part this is about. `physics` stands in
 * for everything inside the step loop; the four lines round it are verbatim.
 */
function makeLoop(car, physics) {
  const carPose = createPoseBuffer();
  let accumulator = 0;
  return {
    carPose,
    frame(dt, drawn) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= PHYS_DT && steps < MAX_SUBSTEPS) {
        carPose.capture(car);
        physics(PHYS_DT);
        accumulator -= PHYS_DT;
        steps++;
      }
      accumulator = settleAccumulator(accumulator, steps, MAX_SUBSTEPS, PHYS_DT);
      const pose = carPose.blend(car, blendFactor(accumulator, PHYS_DT));
      // What the OLD loop drew: the car where the last step left it.
      drawn.oldX = car.x; drawn.oldZ = car.z;
      drawn.x = pose.x; drawn.z = pose.z; drawn.yaw = pose.yaw; drawn.steps = steps;
      return pose;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. A car on a circle, stepped exactly, drawn through the loop.
// ---------------------------------------------------------------------------
// 160 km/h round an 80 m radius: fast enough that one physics step is 37 cm,
// which is the hop a 144 Hz player saw every other frame.
{
  const V = 160 / 3.6, R = 80, W = V / R;
  const car = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steerAngle: 0.1, t: 0,
    wheels: [0, 1, 2, 3].map(() => ({ spin: 0, comp: 0 })),
  };
  const place = (c, t) => {
    // Forward is (-sin yaw, -cos yaw) and yaw grows counter-clockwise, so a
    // car turning left at W rad/s from the origin, integrated exactly:
    const a = W * t;
    c.x = -R * (1 - Math.cos(a));
    c.z = -R * Math.sin(a);
    c.yaw = a;
  };
  place(car, 0);
  const physics = (h) => {
    car.t += h; place(car, car.t);
    for (const w of car.wheels) w.spin += (V / 0.33) * h;
  };

  const cases = [
    ['jittered 1/144..1/40 s', () => 1 / 144 + rnd() * (1 / 40 - 1 / 144)],
    ['144 Hz screen', () => 1 / 144],
    ['45 fps laptop', () => 1 / 45],
    ['60 Hz screen', () => 1 / 60],
  ];
  for (const [label, next] of cases) {
    car.t = 0; place(car, 0);
    for (const w of car.wheels) w.spin = 0;
    const loop = makeLoop(car, physics);
    const drawn = {};
    let t = 0, px = null, pz = null, ox = null, oz = null;
    let lo = Infinity, hi = -Infinity, oldLo = Infinity, oldHi = -Infinity;
    let still = 0, oldStill = 0, worstLag = 0, frames = 0;
    for (let i = 0; i < 2400; i++) {
      const dt = next();
      t += dt;
      loop.frame(dt, drawn);
      if (i > 20) {
        // Rendered distance this frame over the distance the car really
        // covered in the frame's time. 1.0 is perfectly smooth.
        const want = V * dt;
        const got = Math.hypot(drawn.x - px, drawn.z - pz) / want;
        const old = Math.hypot(drawn.oldX - ox, drawn.oldZ - oz) / want;
        lo = Math.min(lo, got); hi = Math.max(hi, got);
        oldLo = Math.min(oldLo, old); oldHi = Math.max(oldHi, old);
        if (got < 0.05) still++;
        if (old < 0.05) oldStill++;
        // And it is exactly where the car was one step ago — a constant lag,
        // which is what makes it invisible.
        const ref = {}; place(ref, t - PHYS_DT);
        worstLag = Math.max(worstLag, Math.hypot(drawn.x - ref.x, drawn.z - ref.z));
        frames++;
      }
      px = drawn.x; pz = drawn.z; ox = drawn.oldX; oz = drawn.oldZ;
    }
    check(`${label}: every frame moves speed x dt (0.99-1.01)`,
      lo > 0.99 && hi < 1.01,
      `now ${lo.toFixed(4)}-${hi.toFixed(4)}; drawn at the last step it was ` +
      `${oldLo.toFixed(2)}-${oldHi.toFixed(2)}, ${oldStill} of ${frames} frames standing still`);
    check(`${label}: no frame stands still`, still === 0, `${still} still frames`);
    check(`${label}: drawn exactly one step behind the physics`, worstLag < 0.005,
      `worst ${(worstLag * 1000).toFixed(2)} mm from the pose 8.3 ms ago`);
  }
}

// ---------------------------------------------------------------------------
// 2. The real car, through the real vehicle model.
// ---------------------------------------------------------------------------
// The arithmetic above is exact because the mover is. This is the same loop
// round the actual physics — pulling away, then steering into a bend — to show
// nothing in the vehicle (suspension, gear changes) upsets the blend.
{
  const FLAT = {
    sample(x, z, out) {
      const r = out || {};
      r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
      r.surface = 'asphalt'; r.grip = 1; r.roughness = 0.03; r.rolling = 0.014; r.dust = 0;
      return r;
    },
  };
  const car = createVehicle({ ground: FLAT });
  car.reset(0, 0, 0);
  const loop = makeLoop(car, (h) => car.step(h));
  const drawn = {};
  let px = 0, pz = 0, ox = 0, oz = 0, lo = Infinity, hi = -Infinity, oldLo = Infinity, oldHi = -Infinity;
  let prevSpeed = 0;
  for (let i = 0; i < 1500; i++) {
    const dt = 1 / 144 + rnd() * (1 / 40 - 1 / 144);
    car.input.throttle = 1;
    car.input.steer = i > 700 ? 0.25 : 0;
    const speedBefore = car.speed;
    loop.frame(dt, drawn);
    if (i > 300) {
      // The car's speed changes within a frame, so compare with the mean of
      // the speeds either side of it: under full throttle that is 0.5%.
      const want = 0.5 * (speedBefore + car.speed) * dt;
      const got = Math.hypot(drawn.x - px, drawn.z - pz) / want;
      const old = Math.hypot(drawn.oldX - ox, drawn.oldZ - oz) / want;
      lo = Math.min(lo, got); hi = Math.max(hi, got);
      oldLo = Math.min(oldLo, old); oldHi = Math.max(oldHi, old);
    }
    px = drawn.x; pz = drawn.z; ox = drawn.oldX; oz = drawn.oldZ;
    prevSpeed = car.speed;
  }
  check('real car, jittered dt: every frame moves speed x dt (0.9-1.1)', lo > 0.9 && hi < 1.1,
    `now ${lo.toFixed(3)}-${hi.toFixed(3)}; drawn at the last step ${oldLo.toFixed(2)}-${oldHi.toFixed(2)}` +
    ` at ${(prevSpeed * 3.6).toFixed(0)} km/h`);
}

// ---------------------------------------------------------------------------
// 3. Teleports cut; nothing turns into NaN.
// ---------------------------------------------------------------------------
{
  const car = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steerAngle: 0,
    wheels: [0, 1, 2, 3].map(() => ({ spin: 0, comp: 0 })) };
  const loop = makeLoop(car, (h) => { car.z -= 30 * h; });
  const drawn = {};
  for (let i = 0; i < 30; i++) loop.frame(1 / 60, drawn);
  // A respawn 400 m away, done between frames the way main.js's R key does.
  car.x = 400; car.z = -900; car.yaw = 2;
  loop.frame(1 / 144, drawn);
  const cutX = drawn.x;
  loop.frame(1 / 144, drawn);
  check('a respawn cuts straight to the new place', Math.abs(cutX - 400) < 1e-9 && loop.carPose.snaps === 1,
    `first frame after drawn at x=${cutX.toFixed(1)} (want 400), ${loop.carPose.snaps} cut(s)`);

  // A U-turn in place (R facing the other way) is a teleport too, even
  // though the car hardly moves.
  car.yaw += Math.PI;
  loop.frame(1 / 60, drawn);
  check('an about-turn in place cuts rather than spinning the car round',
    Math.abs(wrapPi(drawn.yaw - car.yaw)) < 1e-9, `drawn yaw off by ${Math.abs(wrapPi(drawn.yaw - car.yaw)).toFixed(3)} rad`);

  const a = blendFactor(0.004, 0), b = blendFactor(NaN, PHYS_DT), c = blendFactor(0.02, PHYS_DT);
  const buf = createPoseBuffer();
  buf.capture(car); car.z -= 0.2;
  const v = buf.blend(car, NaN);
  check('blend factors and blends never come back NaN', a === 0 && b === 0 && c === 1 && Number.isFinite(v.z),
    `blendFactor(x, 0)=${a}, (NaN)=${b}, (2.4 steps)=${c}, blend(NaN) z=${v.z.toFixed(2)}`);

  // Capped with whole steps still owed: the whole steps go, the fraction stays,
  // so the blend carries on from where it was instead of snapping to 0.
  const kept = settleAccumulator(5.37 * PHYS_DT, MAX_SUBSTEPS, MAX_SUBSTEPS, PHYS_DT);
  const normal = settleAccumulator(0.37 * PHYS_DT, 3, MAX_SUBSTEPS, PHYS_DT);
  check('a capped frame drops whole steps but keeps the fraction',
    Math.abs(kept / PHYS_DT - 0.37) < 1e-9 && Math.abs(normal / PHYS_DT - 0.37) < 1e-9,
    `kept ${(kept / PHYS_DT).toFixed(3)} of a step (was zeroed)`);
}

// ---------------------------------------------------------------------------
// 4. The camera's followers are exact at any frame rate.
// ---------------------------------------------------------------------------
// A car in a steady bend: its heading turns at a constant rate, and the chase
// camera's spring trails it by a constant angle. With the old stepped spring
// that angle depended on dt, so a ragged frame rate shook the whole view.
{
  const RATE = 0.6, W = 6.5;           // rad/s of heading; main.js's spring
  const s = { x: 0, v: RATE };
  let prev = 0, t = 0, oldYaw = 0, oldVel = RATE, y = 0, yOld = 0, prevX = 0;
  const lag = [], oldLag = [], follow = [], oldFollow = [];
  for (let i = 0; i < 4000; i++) {
    const dt = 1 / 144 + rnd() * (1 / 40 - 1 / 144);
    t += dt;
    const want = wrapPi(RATE * t);
    springAngleStep(s, prev, want, W, dt);
    prev = want;
    const err = wrapPi(want - oldYaw);
    oldVel += (err * W * W - oldVel * 2 * W) * dt;
    oldYaw = wrapPi(oldYaw + oldVel * dt);
    // The look-ahead point, running away at 45 m/s, followed at rate 9.
    const X = 45 * t;
    y = followLinear(y, prevX, X, 9, dt);
    yOld += (X - yOld) * (1 - Math.exp(-9 * dt));
    prevX = X;
    if (t > 5) {
      lag.push(wrapPi(want - s.x)); oldLag.push(wrapPi(want - oldYaw));
      follow.push(X - y); oldFollow.push(X - yOld);
    }
  }
  const spread = (a) => Math.max(...a) - Math.min(...a);
  check('chase spring trails a steady bend by the same angle at any dt', spread(lag) < 1e-9,
    `spread ${spread(lag).toExponential(1)} rad at ${lag[0].toFixed(4)} (2u/w = ${(2 * RATE / W).toFixed(4)}); ` +
    `the stepped one spread ${(spread(oldLag) * 180 / Math.PI).toFixed(3)} deg`);
  check('look target trails a moving point by the same distance at any dt', spread(follow) < 1e-6,
    `spread ${(spread(follow) * 1000).toFixed(4)} mm at ${follow[0].toFixed(3)} m; ` +
    `the exp() one spread ${(spread(oldFollow) * 100).toFixed(1)} cm`);
}

// ---------------------------------------------------------------------------
// 5. main.js really runs this loop — and this check would notice if it stopped.
// ---------------------------------------------------------------------------
// Reading the source is the only way a headless harness can see main.js, so
// the reading has to be strict enough to matter. The first version checked
// that a few lines EXISTED; a reviewer then broke main.js five ways (the
// car's yaw from the physics while its position came from the pose, pitch
// and roll likewise, the steering, and the blend moved below the camera so
// everything drew last frame's pose) and four of the five passed. So this
// audits order and completeness, and then proves itself: every one of those
// breakages, and a few more, is applied to a copy of main.js below and must
// be caught.
{
  const src = readFileSync(join(ROOT, 'src/main.js'), 'utf8');

  // Functions inside boot() are indented two spaces and close with a brace
  // at exactly that indent; anything nested is indented further.
  const body = (s, head) => {
    const at = s.indexOf(head);
    if (at < 0) return '';
    const end = s.indexOf('\n  }\n', at);
    return end < 0 ? '' : s.slice(at, end);
  };
  // The simulated car's own pose fields. Anything drawn on it reads `pose`.
  const PHYS = /\bcar\.(x|y|z|yaw|pitch|roll|steerAngle|wheels)\b/g;

  function auditMain(s) {
    const bad = [];
    const need = (ok, what) => { if (!ok) bad.push(what); };
    const loopAt = s.indexOf('while (accumulator >= PHYS_DT && steps < MAX_SUBSTEPS) {');
    need(loopAt >= 0 && /\{\s*carPose\.capture\(car\);/.test(s.slice(loopAt, loopAt + 120)),
      'the pose is captured first thing in every physics step');
    need(s.includes('accumulator = settleAccumulator(accumulator, steps, MAX_SUBSTEPS, PHYS_DT);'),
      'the accumulator is settled after the step loop');
    need(s.includes(`const PHYS_HZ = ${PHYS_HZ};`) && s.includes(`const MAX_SUBSTEPS = ${MAX_SUBSTEPS};`),
      `physics at ${PHYS_HZ} Hz, capped at ${MAX_SUBSTEPS} steps`);

    const step = body(s, 'function stepFrame(dt) {');
    need(step.length > 0, 'stepFrame() found');
    const blendAt = step.indexOf('pose = carPose.blend(car, blendFactor(accumulator, PHYS_DT));');
    need(blendAt > step.indexOf('accumulator = settleAccumulator('), 'the blend comes after the settled accumulator');
    // Everything drawn from the pose must come after the pose is made, or it
    // draws last frame's — at 144 Hz with a ragged dt, that IS the judder.
    for (const use of ['carRoot.position.set(', 'emitTyreEffects(dt)', 'updateCamera(dt, driving);']) {
      const at = step.indexOf(use);
      need(at >= 0 && blendAt >= 0 && blendAt < at, `the pose is blended before ${use.replace(/\($/, '')}`);
    }
    // Every line that places the car's body or wheels reads the pose, and
    // none reads the simulated car.
    const drawn = step.split('\n').filter((l) =>
      /carRoot\.(position|rotation|quaternion|rotate[XYZ])\b|carModel\.set(Steer|WheelSpin)\(|suspension\[i\]\s*=/.test(l));
    need(drawn.length >= 7, `all seven car placements found (${drawn.length})`);
    for (const l of drawn) {
      const leak = l.match(PHYS);
      need(!leak && /\bpose\./.test(l), `drawn from the pose: ${l.trim()}`);
    }

    const cam = body(s, 'function updateCamera(dt, driving) {');
    need(cam.includes('const p = pose;'), 'the camera is hung off the pose');
    const camLeaks = cam.match(PHYS) || [];
    need(camLeaks.length === 0, `the camera never reads the simulated car (${[...new Set(camLeaks)].join(', ')})`);
    // Exactly once: the spring and the lags advance by dt on every call, so a
    // second call in a frame would move the camera twice as fast as the car.
    need((s.match(/\bupdateCamera\(dt, driving\);/g) || []).length === 1, 'the camera is updated exactly once a frame');

    const tyres = body(s, 'function emitTyreEffects(dt) {');
    need(/const wx = pose\.x/.test(tyres) && /pose\.yaw/.test(tyres), 'tyre marks are laid where the wheels are drawn');

    // The automatic quality judges and applies BEFORE the frame is drawn. A
    // canvas resized after its frame was drawn shows the page through it for
    // one frame (effects.js also defers every resize to its next draw, which
    // section 6 checks; this is the belt to those braces).
    const fr = body(s, 'function frame(now) {');
    const sampleAt = fr.indexOf('auto.sample('), drawAt = fr.indexOf('stepFrame(dt);');
    need(sampleAt >= 0 && drawAt > sampleAt && fr.indexOf('applyAuto(', drawAt) < 0,
      'quality is judged and applied before the frame is drawn, never after');
    need(/auto\.sample\(raw \* 1000, effects\.gpuMs, scriptMs\)/.test(fr) && /scriptMs = performance\.now\(\) - t0;/.test(fr),
      'the frame\'s own script time reaches the judge');
    need(/applyRung\(effects, autoOn\(\) \? auto\.rung : AUTO_FULL, autoPost\)/.test(s),
      'a rung is applied as a fraction of the CHOSEN tier\'s pixel ratio');
    return bad;
  }

  const found = auditMain(src);
  check('main.js runs the loop this harness drives, in this order', found.length === 0,
    found.length ? `missing: ${found.join('; ')}` : 'capture, settle, blend, then car, tyres, camera; quality before the draw');

  // The self-test. Each mutation must actually change the text (or it proves
  // nothing) and must be caught.
  const swap = (a, b) => (s) => s.replace(a, b);
  const move = (line, after) => (s) => {
    const cut = s.replace(line, '');
    return cut.replace(after, after + line);
  };
  const MUTANTS = [
    ['yaw from the physics', swap('carRoot.rotation.set(0, pose.yaw, 0);', 'carRoot.rotation.set(0, car.yaw, 0);')],
    ['pitch from the physics', swap('carRoot.rotateX(pose.pitch);', 'carRoot.rotateX(car.pitch);')],
    ['roll from the physics', swap('carRoot.rotateZ(-pose.roll);', 'carRoot.rotateZ(-car.roll);')],
    ['steering from the physics', swap('carModel.setSteer(pose.steer);', 'carModel.setSteer(car.steerAngle);')],
    ['wheel spin from the physics', swap('carModel.setWheelSpin(pose.spin);', 'carModel.setWheelSpin(car.wheels[0].spin);')],
    ['suspension from the physics', swap('suspension[i] = pose.comp[i];', 'suspension[i] = car.wheels[i].comp;')],
    ['position from the physics', swap('carRoot.position.set(pose.x, pose.y, pose.z);', 'carRoot.position.set(car.x, car.y, car.z);')],
    ['blend moved below the camera', move('\n    pose = carPose.blend(car, blendFactor(accumulator, PHYS_DT));', '\n    updateCamera(dt, driving);')],
    ['camera rolls with the physics', swap('camera.rotateZ(-p.roll * 0.22);', 'camera.rotateZ(-car.roll * 0.22);')],
    ['camera pitches with the physics', swap('const p = pose;', 'const p = pose; void car.pitch;')],
    ['camera updated twice', swap('updateCamera(dt, driving);', 'updateCamera(dt, driving);\n    updateCamera(dt, driving);')],
    ['quality applied after the draw', move('\n    if (mode === \'driving\' && autoOn() && auto.sample(raw * 1000, effects.gpuMs, scriptMs)) applyAuto(true);', '\n    stepFrame(dt);')],
    ['capture after the step', swap('carPose.capture(car);', '/* moved */')],
    ['post drop cuts the resolution', swap('applyRung(effects, autoOn() ? auto.rung : AUTO_FULL, autoPost);', 'applyRung(effects, autoOn() ? auto.rung : AUTO_FULL, null);')],
  ];
  const missed = [];
  for (const [name, mutate] of MUTANTS) {
    const m = mutate(src);
    if (m === src) { missed.push(`${name} (mutation did not apply)`); continue; }
    if (auditMain(m).length === 0) missed.push(name);
  }
  check('...and that check catches every known way of breaking it', missed.length === 0,
    missed.length ? `not caught: ${missed.join(', ')}` : `${MUTANTS.length} of ${MUTANTS.length} broken copies of main.js caught`);
}

// ---------------------------------------------------------------------------
// 6. The post-processing, through a recording renderer.
// ---------------------------------------------------------------------------
// effects.js runs here for real — the composer, bloom, finish and FXAA passes
// — against a renderer that only writes down what it is asked to do. Two
// things to prove:
//
//  * a quality change never resizes the canvas between a frame being drawn and
//    the screen showing it. A resize clears a WebGL canvas, and one landing
//    after the draw showed the page through the game for a frame: a black
//    flash on every automatic quality change;
//  * on a HiDPI screen no step of the ladder cuts more than 40% of the pixels.
//    With the post tier's own pixel-ratio cap applied, (0.8, medium) to
//    (0.8, low) at devicePixelRatio 2 was a 56% cut.
const NOOP = () => {};
function recordingRenderer(log, w = 1440, h = 900) {
  let pr = 1;
  const r = {
    getSize: (v) => v.set(w, h), getPixelRatio: () => pr,
    setPixelRatio: (p) => { pr = p; log.push('resize'); },
    setSize: (a, b) => { w = a; h = b; log.push('resize'); },
    getDrawingBufferSize: (v) => v.set(Math.floor(w * pr), Math.floor(h * pr)),
    render: () => { log.push('draw'); },
    getContext: () => ({}), getClearColor: (c) => c, getClearAlpha: () => 1, getRenderTarget: () => null,
    autoClear: true, outputColorSpace: '', toneMapping: 0, toneMappingExposure: 1,
  };
  // Everything else a pass calls (setRenderTarget, clear, setClearColor...)
  // is accepted and ignored.
  return new Proxy(r, { get: (o, k) => (k in o ? o[k] : NOOP) });
}
/** effects.js on a screen of devicePixelRatio `dpr`. */
function effectsOn(dpr, quality, log = []) {
  globalThis.window = { devicePixelRatio: dpr };
  const fx = createEffects(recordingRenderer(log), new THREE.Scene(), new THREE.PerspectiveCamera(),
    { quality, width: 1440, height: 900 });
  return { fx, log };
}
{
  const { fx, log } = effectsOn(2, 'medium');
  fx.render(1 / 60);
  const rungs = ladderFor('medium', fx.basePixelRatio('medium'));
  let lateResizes = 0, drawnFirst = 0, applied = 0;
  for (const r of [...rungs, ...rungs.slice().reverse()]) {
    log.length = 0;
    applyRung(fx, r, 'medium');
    lateResizes += log.filter((e) => e === 'resize').length;   // before any draw: must be none
    fx.render(1 / 60);
    const firstDraw = log.indexOf('draw');
    if (log.lastIndexOf('resize') > firstDraw) drawnFirst++;
    applied++;
  }
  check('a quality change never resizes the canvas between a draw and the screen',
    lateResizes === 0 && drawnFirst === 0,
    `${applied} changes: ${lateResizes} resized on the spot, ${drawnFirst} resized after drawing began`);
}
{
  const rows = [];
  let worst = 1;
  for (const [dpr, chosen] of [[1, 'medium'], [2, 'medium'], [2, 'high'], [1.25, 'medium'], [2, 'low']]) {
    const { fx } = effectsOn(dpr, chosen);
    const rungs = ladderFor(chosen, fx.basePixelRatio(chosen));
    const prs = rungs.map((r) => { applyRung(fx, r, chosen); return fx.pixelRatio; });
    for (let i = 1; i < prs.length; i++) worst = Math.min(worst, (prs[i] / prs[i - 1]) ** 2);
    rows.push(`dpr ${dpr} ${chosen}: ${prs.map((p) => p.toFixed(2)).join(' ')}`);
  }
  check('no step of the ladder cuts more than 40% of the pixels, on any screen', worst >= 0.6,
    `worst step keeps ${(worst * 100).toFixed(0)}%; ${rows.join('; ')}`);
}

// ---------------------------------------------------------------------------
// 7. Automatic quality, against simulated machines.
// ---------------------------------------------------------------------------
// A machine is a CPU time and a GPU time per frame, and a screen. The GPU part
// shrinks with the pixel count — taken from what effects.js ACTUALLY renders
// at for each rung on that screen, so a ladder that cuts more than it says is
// simulated as doing so — with a fixed 15% that does not (the shadow map), and
// with the post tier by the costs measured for adaptive.js. The frame takes
// the longer of the two, plus 4% noise, and waits for the screen's next
// refresh; its timestamp wobbles by up to +-1.5 ms, as requestAnimationFrame's
// do. The script time main.js measures is the CPU part. Every ~5 s a 180 ms
// hitch lands on top (under maxGapMs, so it IS judged — an earlier version
// used 300 ms, which the judge throws away as a paused tab and so proved
// nothing), every ~15 s a 300 ms one, and every 10 s a burst of streaming
// frames. None of them may move it.
{
  const POST = { off: 0.6, low: 0.65, medium: 1, high: 1.65 };
  const HZ60 = 1000 / 60;
  function machine({
    cpu, gpu, chosen = 'medium', dpr = 1, screenMs = HZ60, hitches = true, timing = true,
    scriptTimed = true, screenKnown = true, level = 0,
  }) {
    const { fx } = effectsOn(dpr, chosen);
    const q = createAdaptiveQuality({
      post: chosen, level, dpr: fx.basePixelRatio(chosen), displayMs: screenKnown ? screenMs : NaN,
    });
    // Pixels at each rung, relative to full quality, as effects.js draws them
    // (the same rungs the controller uses: ladderFor with the same inputs).
    const px = ladderFor(chosen, fx.basePixelRatio(chosen)).map((r) => { applyRung(fx, r, chosen); return fx.pixelRatio ** 2; });
    const full = px[0];
    const startChanges = q.changes;
    let t = 0, frame = 0, slowFrames = 0, drawnFrames = 0, below = 0, wobble = 0;
    const levels = [];
    return {
      q,
      run(seconds) {
        const end = t + seconds * 1000;
        while (t < end) {
          const r = q.rung;
          const g = gpu * (0.15 + 0.85 * px[q.level] / full) * POST[r.post] / POST[chosen];
          const c = cpu * (0.98 + rnd() * 0.04);
          let ms = Math.max(c, g * (0.98 + rnd() * 0.04));
          let script = c;
          if (hitches && frame % 300 === 150) { ms += 180; script += 180; }
          if (hitches && frame % 900 === 450) { ms += 300; script += 300; }
          if (hitches && frame % 600 >= 400 && frame % 600 < 410) { ms += 22; script += 22; }
          ms = Math.ceil(ms / screenMs - 0.02) * screenMs;
          const w = (rnd() * 2 - 1) * 1.5;
          q.sample(ms + w - wobble, timing ? g * (0.97 + rnd() * 0.06) : NaN, scriptTimed ? script : NaN);
          wobble = w;
          t += ms; frame++;
          if (t > 15000) {             // judged after the first 15 s
            drawnFrames++;
            if (ms > Math.max(19, screenMs * 1.14) && ms < 250) slowFrames++;
            if (q.level > 0) below += ms;
          }
          if (!levels.length || levels[levels.length - 1][1] !== q.level) levels.push([Math.round(t / 1000), q.level]);
        }
      },
      get changes() { return q.changes - startChanges; },
      get slowShare() { return drawnFrames ? slowFrames / drawnFrames : 0; },
      get belowShare() { return below / Math.max(1, t - 15000); },
      levels,
    };
  }
  const trace = (m) => m.levels.map(([s, l]) => `${s}s:${l}`).join(' ');
  const cut = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}...` : s);

  {
    const m = machine({ cpu: 6, gpu: 9 });
    m.run(300);
    check('a fast machine is left alone for five minutes, hitches and all', m.changes === 0,
      `${m.changes} changes, level ${m.q.level}, through 60 hitches of 180 ms and 20 of 300 ms`);
  }
  for (const dpr of [1, 2]) {
    // An integrated GPU that needs 28 ms for the full picture.
    const m = machine({ cpu: 7, gpu: 28, dpr });
    m.run(300);
    // The last step DOWN is when it stopped juddering; a later step back up
    // (it can overshoot by one when it drops two at a time) is a refinement.
    let lastDown = 0;
    for (let i = 1; i < m.levels.length; i++) if (m.levels[i][1] > m.levels[i - 1][1]) lastDown = m.levels[i][0];
    check(`a GPU-bound laptop steps down until it holds 60 fps (devicePixelRatio ${dpr})`,
      m.slowShare < 0.03 && m.q.level > 0 && lastDown <= 10 && m.changes <= 4,
      `level ${m.q.level} (${m.q.rung.scale} res, ${m.q.rung.post}), ${(m.slowShare * 100).toFixed(1)}% slow frames after 15 s; ` +
      `last step down at ${lastDown} s, ${m.changes} changes in 5 min: ${trace(m)}`);
  }
  {
    // The case a reviewer found: a HiDPI laptop with a GPU timer, needing
    // 26 or 30 ms for the full picture. When the post step also cut the
    // resolution, the prediction for stepping back up was 2.25x too low, so it
    // kept stepping up into frames it could not hold. Through this model,
    // round3/base made 101 changes in 10 minutes at 26 ms, 13% of frames slow.
    const out = [];
    let worst = 0, slow = 0;
    for (const gpu of [26, 30]) {
      const m = machine({ cpu: 6, gpu, dpr: 2 });
      m.run(600);
      worst = Math.max(worst, m.changes); slow = Math.max(slow, m.slowShare);
      out.push(`${gpu} ms: ${m.changes} (${trace(m)})`);
    }
    check('a HiDPI laptop with a GPU timer settles, and does not probe again and again', worst <= 4 && slow < 0.05,
      `changes in 10 min — ${out.join('; ')}; worst ${(slow * 100).toFixed(1)}% slow frames (was 101 changes, 13%)`);
  }
  for (const timing of [true, false]) {
    // On the edge: one level holds 60, the level above it does not, quite.
    // Without GPU timing it has to try; the back-off keeps the trying rare.
    const m = machine({ cpu: 6, gpu: 22.4, timing });
    m.run(600);
    check(`a machine on the edge does not flicker between levels (GPU timing ${timing ? 'on' : 'off'})`,
      m.changes <= (timing ? 3 : 6) && m.slowShare < 0.05,
      `${m.changes} changes in 10 min, ${(m.slowShare * 100).toFixed(1)}% slow frames: ${cut(trace(m))}`);
  }
  for (const timing of [true, false]) {
    // Slow because of the CPU, which main.js measures on every browser.
    // Fewer pixels would only blur the picture.
    const m = machine({ cpu: 24, gpu: 6, timing });
    m.run(600);
    check(`a CPU-bound machine is never blurred for nothing (GPU timing ${timing ? 'on' : 'off'})`,
      m.changes === 0 && m.belowShare === 0,
      `${m.changes} changes, ${(m.belowShare * 100).toFixed(0)}% of 10 min below full quality${timing ? '' : ' (was 16 changes)'}`);
  }
  {
    // Slow for a reason neither the script time nor a GPU timer can see — a
    // busy machine. It has to try the ladder once; it must not keep trying.
    const m = machine({ cpu: 24, gpu: 6, timing: false, scriptTimed: false });
    m.run(600);
    check('slow for reasons nobody can measure: the ladder is tried once, not over and over',
      m.changes <= 6 && m.belowShare < 0.05,
      `${m.changes} changes (was 16), ${(m.belowShare * 100).toFixed(1)}% of 10 min below full quality: ${cut(trace(m))}`);
  }
  for (const [label, screenMs, was] of [
    ['a 50 Hz screen', 20, '24 changes, 12% blurred'],
    ['a 30 fps cap (Low Power Mode)', 1000 / 30, '16 changes, 4% blurred'],
  ]) {
    // A fast machine, no GPU timer (Safari), on a screen that is not 60 Hz.
    // Measured at load, the screen's rate is simply the rate; unmeasured (the
    // tab loaded in the background), it has to find out, once.
    const known = machine({ cpu: 5, gpu: 6, timing: false, screenMs });
    known.run(600);
    const blind = machine({ cpu: 5, gpu: 6, timing: false, screenMs, screenKnown: false });
    blind.run(600);
    check(`${label} is not mistaken for a slow machine`,
      known.changes === 0 && blind.changes <= 6 && blind.belowShare < 0.05,
      `rate measured: ${known.changes} changes; not measured: ${blind.changes} changes, ` +
      `${(blind.belowShare * 100).toFixed(1)}% blurred (was ${was}, either way): ${cut(trace(blind), 60)}`);
  }
  {
    // 144 Hz, and a GPU that needs 18 ms: three refreshes a frame, 48 fps.
    // One level down it makes two refreshes, 72 fps — so down it goes, and
    // no further.
    const m = machine({ cpu: 5, gpu: 18, screenMs: 1000 / 144 });
    m.run(300);
    check('a 144 Hz screen: steps down only as far as it takes to beat 60 fps',
      m.q.level > 0 && m.q.level <= 2 && m.changes <= 3 && m.slowShare < 0.03,
      `level ${m.q.level}, ${m.changes} changes, ${(m.slowShare * 100).toFixed(1)}% slow frames: ${trace(m)}`);
  }
  {
    const m = machine({ cpu: 8, gpu: 70, chosen: 'high' });
    m.run(12);
    check('a very slow machine reaches the bottom rung within 12 s', m.q.level === m.q.levels - 1,
      `level ${m.q.level} of ${m.q.levels - 1} after 12 s: ${trace(m)}`);
  }
  {
    // Remembered from a bad day; today it has room. GPU timing says so.
    const m = machine({ cpu: 6, gpu: 9, level: 4 });
    m.run(20);
    check('a remembered low level climbs back when there is room', m.q.level === 0,
      `level ${m.q.level} after 20 s: ${trace(m)}`);
  }
  {
    // Remembered at the bottom, and the pixels were never the problem.
    const m = machine({ cpu: 24, gpu: 6, timing: false, level: 5 });
    m.run(120);
    const blind = machine({ cpu: 24, gpu: 6, timing: false, scriptTimed: false, level: 5 });
    blind.run(120);
    const w = machine({ cpu: 6, gpu: 70, timing: false, level: 5 });
    w.run(120);
    check('remembered at the bottom: a CPU-bound machine finds its way back up',
      m.q.level === 0 && blind.q.level === 0 && w.belowShare > 0.85,
      `script timed: level ${m.q.level} (${cut(trace(m), 50)}); not timed: level ${blind.q.level}; ` +
      `a GPU-bound one stays down ${(w.belowShare * 100).toFixed(0)}% of the time`);
  }
  {
    const hi = ladderFor('high'), md = ladderFor('medium'), lo = ladderFor('low'), off = ladderFor('off');
    const posts = (l) => [...new Set(l.map((r) => r.post))].join(',');
    check('it never goes above the chosen post tier, or down to "off"',
      hi[0].post === 'high' && md.every((r) => r.post !== 'high') && lo.every((r) => r.post === 'low') &&
      off.every((r) => r.post === 'off') && [hi, md, lo].every((l) => l.every((r) => r.post !== 'off')),
      `high: ${posts(hi)}; medium: ${posts(md)}; low: ${posts(lo)}; off: ${posts(off)}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Measuring the screen's rate while the game loads.
// ---------------------------------------------------------------------------
// The loading screen's requestAnimationFrame intervals: a whole number of
// refreshes each, most of them one, the rest stretched by loading work. It
// has to find the screen's period even when most frames were busy, and say
// "unknown" rather than guess when there is nothing regular to find.
{
  const probe = (next, frames = 180) => {
    let now = 0, cb = null;
    const p = createDisplayProbe((f) => { cb = f; });
    for (let i = 0; i < frames && cb; i++) { const f = cb; cb = null; now += next(); f(now); }
    return p.stop();
  };
  const refreshes = (ms, busy) => () =>
    ms * (rnd() < busy ? 2 + Math.floor(rnd() * 12) : 1) + (rnd() * 2 - 1) * 0.8;
  const got = [[60, 1000 / 60], [144, 1000 / 144], [50, 20], [30, 1000 / 30]]
    .map(([hz, ms]) => [hz, ms, probe(refreshes(ms, 0.33))]);
  const busy = probe(refreshes(1000 / 60, 0.8));
  const ragged = probe(() => 5 + rnd() * 34);
  const few = probe(refreshes(1000 / 60, 0), 20);
  const none = createDisplayProbe(null).stop();
  check('the screen\'s rate is read off the loading screen, or not guessed at',
    got.every(([, ms, v]) => Math.abs(v - ms) < 0.05 * ms) && Math.abs(busy - 1000 / 60) < 0.8 &&
    [ragged, few, none].every(Number.isNaN),
    `${got.map(([hz, , v]) => `${hz} Hz -> ${v.toFixed(2)} ms`).join(', ')}; 60 Hz with 80% of frames busy -> ` +
    `${busy.toFixed(2)} ms; ragged -> ${ragged}; 20 frames -> ${few}; no frames -> ${none}`);
}

console.log(fail === 0 ? '\nSmooth at every frame rate.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
