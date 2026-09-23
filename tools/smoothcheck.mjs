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
import { createVehicle } from '../src/physics/vehicle.js';
import { createAdaptiveQuality, ladderFor } from '../src/core/adaptive.js';

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
// 5. main.js really runs this loop.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
  const has = (s) => src.includes(s);
  const loopAt = src.indexOf('while (accumulator >= PHYS_DT && steps < MAX_SUBSTEPS) {');
  const firstInLoop = loopAt >= 0 ? src.slice(loopAt, loopAt + 120) : '';
  check('main.js captures the pose first thing in every physics step',
    /\{\s*carPose\.capture\(car\);/.test(firstInLoop), loopAt >= 0 ? 'found' : 'loop header not found');
  check('main.js blends after the step loop with the settled accumulator',
    has('accumulator = settleAccumulator(accumulator, steps, MAX_SUBSTEPS, PHYS_DT);') &&
    has('pose = carPose.blend(car, blendFactor(accumulator, PHYS_DT));'), 'both lines present');
  check('main.js steps at the rate and cap this harness assumes',
    has(`const PHYS_HZ = ${PHYS_HZ};`) && has(`const MAX_SUBSTEPS = ${MAX_SUBSTEPS};`), `${PHYS_HZ} Hz, ${MAX_SUBSTEPS} steps`);
  check('the car is drawn from the blended pose',
    has('carRoot.position.set(pose.x, pose.y, pose.z);') && has('carModel.setWheelSpin(pose.spin);'), '');
  const cam = src.slice(src.indexOf('function updateCamera('), src.indexOf('// ---- prime the streaming layers'));
  const leaks = cam.match(/\bcar\.(x|y|z|yaw|roll)\b/g) || [];
  check('the camera follows the drawn car, never the simulated one',
    cam.includes('const p = pose;') && leaks.length === 0,
    leaks.length ? `updateCamera reads ${[...new Set(leaks)].join(', ')}` : 'no car.x/y/z/yaw/roll in updateCamera');
  // Exactly once: the spring and the lags advance by dt on every call, so a
  // second call in a frame would move the camera twice as fast as the car.
  const camCalls = (src.match(/\bupdateCamera\(dt, driving\);/g) || []).length;
  check('the camera is updated exactly once a frame', camCalls === 1, `${camCalls} call(s) in main.js`);
}

// ---------------------------------------------------------------------------
// 6. Automatic quality, against simulated machines.
// ---------------------------------------------------------------------------
// A machine is a CPU time and a GPU time per frame. The GPU part shrinks with
// the resolution (a fixed 15% that does not, e.g. the shadow map, and the rest
// with the pixel count) and with the post tier, by the costs measured for
// adaptive.js. The frame takes the longer of the two, plus 4% noise, and on a
// 60 Hz screen waits for the next vsync; the timestamp it is measured by then
// wobbles by up to +-1.5 ms, as requestAnimationFrame's do. Every so often a
// hitch lands on top: a 300 ms stall and a burst of streaming frames, which
// must never move it.
{
  const POST = { off: 0.6, low: 0.65, medium: 1, high: 1.65 };
  function machine({ cpu, gpu, chosen = 'medium', vsync = true, hitches = true, timing = true, level = 0 }) {
    const q = createAdaptiveQuality({ post: chosen, level });
    let t = 0, frame = 0, slowFrames = 0, drawnFrames = 0, below = 0, wobble = 0;
    const levels = [];
    return {
      q,
      run(seconds) {
        const end = t + seconds * 1000;
        while (t < end) {
          const r = q.rung;
          const g = gpu * (0.15 + 0.85 * r.scale * r.scale) * POST[r.post] / POST[chosen];
          let ms = Math.max(cpu, g) * (0.98 + rnd() * 0.04);
          if (hitches && frame % 300 === 150) ms += 300;                 // every ~5 s
          if (hitches && frame % 600 >= 400 && frame % 600 < 410) ms += 22;   // streaming burst
          if (vsync) ms = Math.ceil(ms / (1000 / 60) - 0.02) * (1000 / 60);
          const w = (rnd() * 2 - 1) * 1.5;
          q.sample(ms + w - wobble, timing ? g * (0.97 + rnd() * 0.06) : NaN);
          wobble = w;
          t += ms; frame++;
          if (t > 15000) {             // judged after the first 15 s
            drawnFrames++;
            if (ms > 19 && ms < 250) slowFrames++;
            if (q.level > 0) below += ms;
          }
          if (!levels.length || levels[levels.length - 1][1] !== q.level) levels.push([Math.round(t / 1000), q.level]);
        }
      },
      get slowShare() { return drawnFrames ? slowFrames / drawnFrames : 0; },
      get belowShare() { return below / Math.max(1, t - 15000); },
      levels,
    };
  }
  const trace = (m) => m.levels.map(([s, l]) => `${s}s:${l}`).join(' ');

  {
    const m = machine({ cpu: 6, gpu: 9 });
    m.run(300);
    check('a fast machine is left alone for five minutes, hitches and all', m.q.changes === 0,
      `${m.q.changes} changes, level ${m.q.level}`);
  }
  {
    // An integrated GPU that needs 28 ms for the full picture.
    const m = machine({ cpu: 7, gpu: 28 });
    m.run(300);
    // The last step DOWN is when it stopped juddering; a later step back up
    // (it can overshoot by one when it drops two at a time) is a refinement.
    let lastDown = 0;
    for (let i = 1; i < m.levels.length; i++) if (m.levels[i][1] > m.levels[i - 1][1]) lastDown = m.levels[i][0];
    check('a GPU-bound laptop steps down until it holds 60 fps',
      m.slowShare < 0.03 && m.q.level > 0,
      `level ${m.q.level} (${m.q.rung.scale} res, ${m.q.rung.post}), ${(m.slowShare * 100).toFixed(1)}% slow frames after 15 s`);
    check('...gets there within ten seconds and then stays put',
      lastDown <= 10 && m.q.changes <= 4, `last step down at ${lastDown} s, ${m.q.changes} changes in 5 min: ${trace(m)}`);
  }
  for (const timing of [true, false]) {
    // On the edge: one level holds 60, the level above it does not, quite.
    // Without GPU timing it has to try; the back-off keeps the trying rare.
    const m = machine({ cpu: 6, gpu: 22.4, timing });
    m.run(600);
    check(`a machine on the edge does not flicker between levels (GPU timing ${timing ? 'on' : 'off'})`,
      m.q.changes <= (timing ? 3 : 16) && m.slowShare < 0.05,
      `${m.q.changes} changes in 10 min, ${(m.slowShare * 100).toFixed(1)}% slow frames: ${trace(m).slice(0, 110)}`);
  }
  for (const timing of [true, false]) {
    // Slow because of the CPU. Fewer pixels would only blur the picture.
    const m = machine({ cpu: 24, gpu: 6, timing });
    m.run(600);
    check(`a CPU-bound machine is not blurred for nothing (GPU timing ${timing ? 'on' : 'off'})`,
      timing ? m.q.changes === 0 : m.belowShare < 0.12,
      `${(m.belowShare * 100).toFixed(0)}% of 10 min below full quality, ${m.q.changes} changes, now level ${m.q.level}`);
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
    // Remembered at the bottom, and the pixels were never the problem. With no
    // GPU timer and no baseline, it has to go and look.
    const m = machine({ cpu: 24, gpu: 6, timing: false, level: 5 });
    m.run(120);
    const w = machine({ cpu: 6, gpu: 70, timing: false, level: 5 });
    w.run(120);
    check('remembered at the bottom: a CPU-bound machine finds its way back up',
      m.q.level === 0 && w.belowShare > 0.85,
      `CPU-bound now level ${m.q.level} (${trace(m)}); a GPU-bound one stays down ${(w.belowShare * 100).toFixed(0)}% of the time`);
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

console.log(fail === 0 ? '\nSmooth at every frame rate.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
