// Render interpolation and frame-rate-independent smoothing.
//
// WHY THIS EXISTS
//
// The car is simulated at a fixed 120 Hz (main.js runs as many 1/120 s steps
// as the frame's time allows, carrying the remainder in an accumulator), and
// until now it was DRAWN wherever the last step left it. At exactly 60 Hz that
// is two steps every frame and looks fine. Anywhere else it is judder:
//
//   144 Hz screen   frames alternate between 1 step and 0 steps, so the car
//                   moves 8.3 ms of distance, then none, then 8.3 ms again —
//                   at 160 km/h a 37 cm hop every other frame;
//   45 fps laptop   frames get 2 or 3 steps (22 ms of frame, 16.7 or 25 ms
//                   of movement), a 50% swing in apparent speed, frame to
//                   frame, which reads as the car shuddering.
//
// The chase camera is rigidly hung off the car, so the camera judders with it
// and the whole WORLD appears to shake while the car sits still on screen.
//
// The fix is the standard one. Keep the pose from before the last physics
// step as well as the one after it, and draw the car at
//
//     alpha = accumulator / PHYS_DT
//
// of the way between them: the leftover time the physics has not simulated
// yet, as a fraction of a step. The rendered car then trails the simulation by
// a constant one step (8.3 ms), and moves by exactly (speed x frame time) every
// frame, whatever the frame time is. tools/smoothcheck.mjs proves that with the
// frame time jittering between 1/144 and 1/40 s.
//
// Everything here is plain arithmetic on plain objects: no three.js, no DOM,
// no allocation after construction. That is what lets a Node harness exercise
// the same code the browser runs.

const TAU = Math.PI * 2;
/** An angle folded into (-PI, PI]. */
export const wrapPi = (a) => a - Math.round(a / TAU) * TAU;

// A pose change bigger than this across ONE physics step is not motion, it is
// a teleport (a respawn, a race restart, R, the map's travel button, the
// collision solver's recovery). 3 m in 1/120 s is 1,300 km/h and 0.6 rad is
// 69 rad/s of yaw — neither is anything a car in this game can do — so
// interpolating across it would only draw one frame of the car streaking
// through the scenery. It snaps instead.
const TELEPORT_DIST = 3;
const TELEPORT_YAW = 0.6;

function makePose() {
  return {
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0, roll: 0,
    steer: 0,          // road-wheel angle, rad
    spin: 0,           // wheel rotation, rad, unwrapped (it only ever accumulates)
    comp: [0, 0, 0, 0],
  };
}

function readCar(car, out) {
  out.x = car.x; out.y = car.y; out.z = car.z;
  out.yaw = car.yaw; out.pitch = car.pitch || 0; out.roll = car.roll || 0;
  out.steer = car.steerAngle || 0;
  const w = car.wheels;
  if (w && w.length >= 4) {
    out.spin = w[0].spin || 0;
    for (let i = 0; i < 4; i++) out.comp[i] = w[i].comp || 0;
  }
}

function copyPose(src, dst) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll;
  dst.steer = src.steer; dst.spin = src.spin;
  for (let i = 0; i < 4; i++) dst.comp[i] = src.comp[i];
}

/**
 * The car's pose before and after the last physics step, and the blend of the
 * two that gets drawn.
 *
 *   capture(car)       call immediately BEFORE every physics step
 *   blend(car, alpha)  call once after the step loop; returns `view`
 *   snap(car)          optional: force the next blend to cut, not slide
 *
 * If a frame runs no steps at all (a 144 Hz frame often does), `before` is
 * still the pose before the most recent step and the car has not moved, so the
 * blend simply moves further along the same step — which is exactly right.
 */
export function createPoseBuffer() {
  const before = makePose();
  const after = makePose();
  const view = makePose();
  let primed = false;
  let snaps = 0;

  function capture(car) {
    readCar(car, before);
    primed = true;
  }

  function blend(car, alpha) {
    readCar(car, after);
    const a = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;   // also turns NaN into 0
    const dx = after.x - before.x, dy = after.y - before.y, dz = after.z - before.z;
    const dyaw = wrapPi(after.yaw - before.yaw);
    if (!primed || dx * dx + dy * dy + dz * dz > TELEPORT_DIST * TELEPORT_DIST ||
        Math.abs(dyaw) > TELEPORT_YAW) {
      copyPose(after, before);
      copyPose(after, view);
      if (primed) snaps++;
      primed = true;
      return view;
    }
    const b = 1 - a;
    view.x = before.x * b + after.x * a;
    view.y = before.y * b + after.y * a;
    view.z = before.z * b + after.z * a;
    // Anchored on the NEWER yaw, so the drawn heading stays on the same branch
    // as car.yaw however many turns the car has made.
    view.yaw = after.yaw - dyaw * b;
    view.pitch = before.pitch * b + after.pitch * a;
    view.roll = before.roll * b + after.roll * a;
    view.steer = before.steer * b + after.steer * a;
    view.spin = before.spin * b + after.spin * a;
    for (let i = 0; i < 4; i++) view.comp[i] = before.comp[i] * b + after.comp[i] * a;
    return view;
  }

  function snap(car) {
    readCar(car, before);
    copyPose(before, after);
    copyPose(before, view);
    primed = true;
  }

  return {
    capture, blend, snap, view,
    /** How many teleports were cut rather than blended, for the harness. */
    get snaps() { return snaps; },
  };
}

/**
 * The accumulator after a frame's steps have run. Normally untouched. If the
 * step cap was hit with whole steps still owed, the whole steps are written off
 * — a machine that cannot keep up must slow the game down rather than try to
 * catch up and fall further behind — but the FRACTION is kept, so the blend
 * factor does not jump back to zero and the car does not twitch backwards.
 */
export function settleAccumulator(acc, steps, maxSteps, stepDt) {
  if (steps >= maxSteps && acc >= stepDt) return acc % stepDt;
  return acc;
}

/** How far between the two poses to draw, 0..1. Guarded: stepDt 0 is 0, not NaN. */
export function blendFactor(acc, stepDt) {
  if (!(stepDt > 0)) return 0;
  const a = acc / stepDt;
  return a > 0 ? (a < 1 ? a : 1) : 0;
}

// ---------------------------------------------------------------------------
// Frame-rate-independent followers for the camera
// ---------------------------------------------------------------------------
//
// The chase camera smooths three things: its azimuth round the car (a spring),
// the point it looks at, and the car's height (both first-order lags). The
// usual one-liners for those — `v += (k*err - c*v) * dt` and
// `y += (x - y) * (1 - exp(-a*dt))` — are only approximately independent of
// the frame rate. The spring's error is the worse: it drifts by (dt * rate),
// so a camera trailing a car round a steady bend sits at a slightly different
// angle at 144 Hz than at 40 Hz, and when dt JITTERS between the two the
// camera shakes by that difference. The versions below are the exact solutions
// of the same equations for a target moving in a straight line across the
// frame, so a target moving steadily is followed identically at any frame rate,
// however ragged.

/**
 * Critically damped spring, exact over one frame, for an ANGLE whose target
 * moved from `prevTarget` to `target` during the frame.
 *
 * `s` is { x, v }: angle (rad) and rate (rad/s). `w` is the natural frequency
 * (1/s): the spring settles in roughly 4.7/w seconds without overshoot.
 * Returns `s`, updated in place.
 */
export function springAngleStep(s, prevTarget, target, w, dt) {
  if (!(dt > 0) || !(w > 0)) return s;
  // The target's own rate across the frame, from its two ends.
  const u = wrapPi(target - prevTarget) / dt;
  // Error from where the target WAS, then shifted by the steady lag a spring
  // chasing a target at rate u settles at (2u/w): what is left decays freely.
  const e0 = wrapPi(s.x - prevTarget);
  const f0 = e0 + 2 * u / w;
  const g0 = s.v - u;
  const k = Math.exp(-w * dt);
  const c = g0 + w * f0;
  const f1 = (f0 + c * dt) * k;
  const g1 = (g0 - w * c * dt) * k;
  s.x = wrapPi(target + f1 - 2 * u / w);
  s.v = g1 + u;
  return s;
}

/**
 * First-order lag, exact over one frame, for a value whose target moved from
 * `prevTarget` to `target` during it. `rate` is 1/time-constant. Returns the
 * new value. A target moving steadily is trailed by exactly speed/rate at any
 * frame rate — the usual exp() one-liner trails by speed * (1/rate - dt/2),
 * which moves with every change of dt.
 */
export function followLinear(y, prevTarget, target, rate, dt) {
  if (!(dt > 0) || !(rate > 0)) return y;
  const ad = rate * dt;
  // The gap to a target moving at u decays toward u/rate; over the frame it
  // goes from (prevTarget - y) to u/rate + (gap - u/rate) * exp(-ad), and
  // u * dt is the target's own move. expm1 keeps (1 - exp(-ad)) / ad exact
  // for tiny ad, where 1 - exp() would cancel to nothing.
  const k = Math.exp(-ad);
  const share = -Math.expm1(-ad) / ad;
  return target - k * (prevTarget - y) - (target - prevTarget) * share;
}
