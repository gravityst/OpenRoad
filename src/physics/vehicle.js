// Road-car dynamics.
//
// COORDINATE CONVENTION — read this before touching anything below.
//
//   forward = -Z      right = +X      up = +Y
//
// This is three.js's own convention (a default camera looks down -Z), and it
// has the property that right = forward x up works out to +X with no sign
// surprises. The previous project used forward = +Z, which puts the car's right
// at -X, and that single inconsistency caused reversed steering twice. Every
// direction here is derived from these three lines and nothing negates a
// steering input on the way in or out. tools/vehiclecheck.mjs asserts that
// pressing right actually moves the car toward +X.
//
//   yaw grows counter-clockwise seen from above, so increasing yaw turns LEFT.
//   forward = (-sin yaw, 0, -cos yaw)
//   right   = ( cos yaw, 0, -sin yaw)
//
// WHY THE CAR CANNOT LAUNCH
//
// The chassis is not a free six-degree-of-freedom rigid body. Position and yaw
// are integrated in the ground plane; height is a suspension state that follows
// the surface; pitch and roll are derived from the ground normal and load
// transfer. There is no integrator that can wind up and throw the car into the
// sky, because vertical motion is not an integrator at all while grounded.
//
// Jumps are still real: when the ground falls away faster than gravity can pull
// the car down, it switches to an explicit airborne state and integrates a
// proper ballistic arc, then lands and hands control back. That is a state
// change with a clear entry and exit condition, not an emergent accident.
//
// WHY THE CAR USED TO BE HARD TO DRIVE — five faults, all measured, all fixed
// here, and all of them physics rather than feel:
//
//   1. The yaw moment put both axles half a wheelbase from the centre of mass
//      while the LOADS used the real weight split. A nose-heavy car therefore
//      needed equal cornering force from a lightly loaded rear axle, so the
//      rear always ran out first: every car in the garage was oversteer-biased
//      at the limit, whatever its tyres said. The arms now come from cgBias.
//   2. Yaw inertia came from a uniform box, which is about half what a real
//      car carries (engine and axles sit at the ends). The car rotated twice as
//      eagerly as it should, which is most of "twitchy".
//   3. Drive force never shared the tyres' friction budget with cornering. A
//      car sliding sideways at 18 degrees with the wheel straight still got its
//      full thrust, and was measured accelerating from 81 to 121 km/h in the
//      slide. Each axle now has one friction circle, shared by everything.
//   4. A key is full lock or nothing, and full lock was 16 degrees at 81 km/h:
//      far past the front tyres' peak. Lock now follows what a driver would
//      actually use at the speed — see STEERING below.
//   5. A driver lets the wheel go and it straightens itself: caster pulls the
//      front wheels round to where the car is actually going. A key has no
//      caster, so a released key held the wheels dead straight in a slide and
//      the car carried on round. See the countersteer assist below.

import { clamp, lerp, smoothstep } from '../world/noise.js';
import { createDamage } from './damage.js';

const G = 9.81;

export const DRIVE = { FWD: 'fwd', RWD: 'rwd', AWD: 'awd' };

/** A sensible mid-size road car; the catalog overrides what it needs to. */
export const DEFAULT_SPEC = {
  name: 'Generic',
  mass: 1420,               // kg
  wheelbase: 2.68,          // m
  track: 1.58,              // m
  cgHeight: 0.52,           // m above the contact patches
  cgBias: 0.53,             // fraction of weight on the front axle at rest
  wheelRadius: 0.34,        // m
  rideHeight: 0.28,         // m from contact patch to chassis underside
  drive: DRIVE.RWD,
  awdFront: 0.42,           // share of drive to the front axle, AWD only

  power: 209000,            // W at peak (about 280 hp)
  peakRpm: 6200,
  redline: 6900,
  idleRpm: 850,
  gears: [3.55, 2.05, 1.42, 1.05, 0.84, 0.68],
  finalDrive: 3.46,
  reverseRatio: 3.30,
  // A modern automatic changes gear in a tenth and a half with the drive only
  // partly interrupted. 0.22 s at 6% torque was a manual driver fumbling the
  // lever, and it was felt as a stall at every change.
  shiftTime: 0.15,          // s of reduced torque

  brakeTorque: 3400,        // N·m per axle at full pedal
  brakeBias: 0.63,          // fraction to the front
  handbrakeTorque: 2600,    // N·m, rear only

  maxSteer: 0.62,           // rad at the road wheel, full lock at a standstill
  steerRate: 3.4,           // rad/s the road wheels can be turned
  dragArea: 0.68,           // Cd * A, m^2
  downforce: 0.22,          // N per (m/s)^2, mild road-car lift compensation

  gripFront: 1.06,          // peak tyre friction, dry asphalt
  gripRear: 1.08,
  // Izz = mass * a * b * yawIndex, where a and b are the axle distances from
  // the centre of mass. Road cars measure 0.85-1.05; a uniform box is ~0.45.
  yawIndex: 0.92,
  springRate: 34000,        // N/m per corner
  damping: 4200,            // N·s/m per corner
};

// ---- tyres -----------------------------------------------------------------
// Simplified Pacejka, D * sin(C * atan(B * slip)). B is the stiffness and sets
// where the peak falls. It was 9.2, which peaks at 11.5 degrees of slip — a
// soft, sidewall-heavy tyre — and made every other number in this file larger
// than a real car's: 16 degrees of lock at 80 km/h, 7 degrees of body slip in
// an ordinary fast corner. 12 puts the peak at 8.9 degrees and the cornering
// stiffness at 17 per radian of load, which is a road tyre. D (the peak) is
// unchanged, so the car corners no harder than it did — it just gets there
// with the wheels and the body pointing where a real one would.
const TYRE_BF = 12.0, TYRE_CF = 1.45;
const TYRE_BR = 12.5, TYRE_CR = 1.42;
/** Slip angle (rad) at which the tyre makes `frac` of its peak force. */
const slipFor = (B, C, frac) => Math.tan(Math.asin(frac) / C) / B;
const PEAK_F = slipFor(TYRE_BF, TYRE_CF, 1);   // 0.155 rad, 8.9 deg
const PEAK_R = slipFor(TYRE_BR, TYRE_CR, 1);   // 0.160 rad, 9.2 deg

function tyreCurve(slip, B, C, D) {
  return D * Math.sin(C * Math.atan(B * slip));
}

// ---- steering ---------------------------------------------------------------
// STEERING. The road-wheel angle a key asks for is the angle a competent
// driver would actually use at this speed to corner at the limit, and never
// more: the geometric angle for the tightest radius the tyres can hold, plus
// the slip the front tyres need to make LOCK_GRIP of their peak.
//
// That is 36 degrees parking, 9 at 80 km/h and 7.6 at 120 on the starter car —
// the angles a real driver reaches at the limit, where the old fixed allowance
// of 1.15x the peak slip gave 16 at 81 km/h. Everything past the front tyre's
// peak is pure understeer and scrub (measured last time: MORE lock gave a
// WIDER line), and on a key it is worse than useless because every tap
// delivered all of it.
// An analogue stick or a phone wheel scales the same range, so full deflection
// means the limit and half means half; they have the whole range to work in.
const LOCK_GRIP = 0.93;
const LOCK_SLIP = slipFor(TYRE_BF, TYRE_CF, LOCK_GRIP);   // 0.091 rad, 5.2 deg
const MIN_LOCK = 0.07;                                    // rad; never less than 4 deg

// COUNTERSTEER ASSIST. When the rear axle's slip passes CS_ON the front wheels
// start following the direction the front axle is actually travelling, and by
// CS_FULL they follow it entirely. That is what caster does to a real steering
// wheel held lightly — it spins into the slide on its own — and it is why a
// real car that steps out comes back when the driver relaxes. The driver's own
// input is added on top, so a slide can still be steered. Keyed to the REAR
// slip, not body slip: at walking pace the body slips 10+ degrees in any tight
// turn with the tyres not sliding at all.
//
// Measured, the rear axle works at 5-6 degrees when the car is cornering at
// its limit, so the assist stays out of the way of a fast corner and only
// takes over once the tail is genuinely past its peak.
const CS_ON = 0.10;        // rad, 5.7 deg — just past a car cornering at the limit
const CS_FULL = 0.19;      // rad, 10.9 deg — past the rear tyre's 9.2 degree peak

// ELECTRONIC STABILITY. See the long note in step().
// Tuned by sweeping the brief's step test (80 and 120 km/h, cruise, full
// throttle and lift-off) across the whole garage: weaker gains let a lift-off
// at 120 reach 8 degrees of slip; a tighter slip threshold trims the turn-in
// a driver needs, because at 120 km/h heading and body slip are the same
// degrees — the car cannot turn its path any faster than the tyres allow.
const ESC_YAW_GAIN = 8.0;          // 1/s on unwanted yaw rate
const ESC_YAW_DEADBAND = 0.05;     // rad/s of unwanted yaw ignored outright...
const ESC_YAW_SLACK = 0.2;         // ...plus this share of what was asked for
const ESC_SLIP_ON = 0.095;         // rad of rear slip before the slip term acts
const ESC_SLIP_GAIN = 40;          // 1/s^2 per rad past it
const ESC_CUT = 0.85;              // throttle removed at full intervention

// ---- driveline --------------------------------------------------------------
export const DRIVELINE = 0.88;   // share of crank power that reaches the tyres
const WHEEL_INERTIA = 4.4;       // kg·m², four road wheels with tyres and discs

/**
 * The engine speed the clutch (or converter) holds a combustion engine at
 * while the car pulls away with the throttle open. See the launch note in
 * step(). Exported so the garage's estimate can launch the way the car does.
 */
export function launchRpm(spec, throttle = 1) {
  if (spec.cylinders === 0) return 0;
  return lerp(spec.idleRpm, spec.launchRpm ?? spec.peakRpm * 0.55, clamp(throttle * 1.4, 0, 1));
}

/**
 * The engine and wheels, expressed as extra mass the car carries while they
 * are geared to the road: flywheel inertia times the square of the overall
 * ratio, so it is large in first and close to nothing in top.
 */
export function rotatingMass(spec, ratio) {
  return ((spec.engineInertia ?? 0.18) * ratio * ratio + WHEEL_INERTIA) /
    (spec.wheelRadius * spec.wheelRadius);
}

/**
 * The share of the engine's torque at the wheels that accelerates the car
 * while pulling away in a gear of overall ratio `ratio`. Exported so the
 * garage can quote the same 0-100 the car does: menus.js estimates it
 * analytically, and without this its figures run up to two seconds kind.
 */
export function driveEfficiency(spec, ratio) {
  return DRIVELINE * spec.mass / (spec.mass + rotatingMass(spec, ratio));
}

// ---- ground -----------------------------------------------------------------
// OFF-ROAD DRAG, as a fraction of weight per m/s. Rolling resistance on grass
// is only about six times asphalt's, which on its own leaves a 280 hp car doing
// 250 km/h across a field — measured, and the reason the roads did not matter.
// What actually stops a car in a field is the ground's unevenness: every bump
// is a damper stroke, damper energy per metre rises with speed, so the loss is
// a force proportional to speed — and more than proportional above ROUGH_KNEE,
// where the wheels start leaving the ground (see step()). Tuned so the starter
// car tops out at under half its road speed on grass (122 against 261 km/h),
// which is about what a driver would dare. Gravel and dirt ROADS are graded;
// they cost a little, not a lot.
const ROUGH_DRAG = {
  asphalt: 0, concrete: 0, sidewalk: 0.0004,
  gravel: 0.0010, dirt: 0.0020, rock: 0.0080,
  grass: 0.0075, sand: 0.0110,
};
const ROUGH_KNEE = 18;     // m/s, ~65 km/h

/**
 * The driving aids a player's settings give the car.
 *
 * One function, used by main.js for the player and by every harness that
 * wants "the car people actually drive", so the two cannot drift apart —
 * which they had: the vehicle's own defaults, main.js's applyAssists and the
 * drift harness each carried their own copy of these numbers.
 *
 * Switching stability off relaxes traction control to a sport setting rather
 * than leaving it at full strength. That is what the button does on a real car,
 * and it is the difference between "ESC off" meaning a car you can drift and a
 * car whose rear tyres are still being starved of torque by a second nanny —
 * measured, a handbrake slide held for ten seconds by the same driver ends at
 * 13 km/h with TC at full strength and at 92 km/h with it relaxed; and on keys,
 * flick-then-hold-D-and-W keeps the drift-school coupe sideways for 5.3 s at
 * 0.2 against 1.5 s at 0.35. Turning TC off by name still means off.
 */
export function aidsFor(s = {}) {
  const esc = s.esc !== false;
  return {
    abs: s.abs === false ? 0 : 0.95,
    tc: s.tc === false ? 0 : esc ? 0.85 : 0.2,
    stability: esc ? 0.8 : 0,
    // Not a setting. Speed-sensitive lock only leaves room to countersteer a
    // slide because the lock is measured from where the car is going once it
    // slides; without this a slide at speed cannot be caught by anyone.
    countersteer: 1,
    autoGear: true,
  };
}

export function createVehicle(opts = {}) {
  const spec = { ...DEFAULT_SPEC, ...(opts.spec || {}) };
  const ground = opts.ground;
  // Damage is part of the car, not something bolted on beside it: every force
  // below is scaled by it, so a wrecked car is slow and wayward in the physics
  // rather than merely in the paintwork.
  const damage = opts.damage === false ? null : createDamage(spec);
  const dmg = damage ? damage.effects : null;

  const car = {
    spec,
    isPlayer: !!opts.isPlayer,

    // --- state ---
    x: 0, y: 0, z: 0,
    yaw: 0,
    vx: 0, vz: 0,            // world-frame planar velocity
    vy: 0,                   // only meaningful while airborne
    yawRate: 0,

    // suspension / attitude
    height: spec.rideHeight, // chassis above the support plane
    heightVel: 0,
    pitch: 0, roll: 0,
    groundNx: 0, groundNy: 1, groundNz: 0,
    groundY: 0,

    airborne: false,
    airTime: 0,
    landedAt: 0,

    // drivetrain
    gear: 1,                 // 0 = reverse, 1..n forward
    rpm: spec.idleRpm,
    shiftTimer: 0,
    wheelSpin: 0,            // rad/s of the driven wheels, for slip ratio

    // per-wheel telemetry (FL, FR, RL, RR)
    wheels: [
      { name: 'FL', comp: 0, load: 0, slip: 0, slipAngle: 0, surface: 'asphalt', grip: 1, spin: 0 },
      { name: 'FR', comp: 0, load: 0, slip: 0, slipAngle: 0, surface: 'asphalt', grip: 1, spin: 0 },
      { name: 'RL', comp: 0, load: 0, slip: 0, slipAngle: 0, surface: 'asphalt', grip: 1, spin: 0 },
      { name: 'RR', comp: 0, load: 0, slip: 0, slipAngle: 0, surface: 'asphalt', grip: 1, spin: 0 },
    ],

    steerAngle: 0,           // current road-wheel angle, rad, + = right
    steerLock: spec.maxSteer,// the lock available at this speed, rad
    input: { throttle: 0, brake: 0, steer: 0, handbrake: 0 },
    // Defaults are what main.js applies for a new player (aidsFor of the
    // default settings), so the headless harnesses measure the car people
    // actually drive.
    //   countersteer: 0..1, how fully the front wheels follow a slide
    aids: aidsFor(),

    // Live steering dial, 0.5..2.5, 1 = stock. Scales how fast the wheel moves
    // and how far toward (and past) the front tyres' peak a full input goes,
    // which between them are what "sensitivity" actually means from the seat.
    feel: { steer: 1 },

    // readouts
    speed: 0,                // m/s along the ground
    lonG: 0, latG: 0,
    // The acceleration the suspension has caught up with. Weight moves through
    // springs and dampers, not instantly; fed straight from lonG, a driver
    // flicking between brake and throttle made the axle loads flip at 120 Hz.
    loadG: 0, loadLatG: 0,
    surface: 'asphalt',
    slipping: 0,             // 0..1, how far past the grip limit the tyres are
    bodySlip: 0,             // rad, velocity against heading at the centre of mass
    rearSlip: 0,             // rad, the rear axle's slip angle
    esc: 0,                  // 0..1, how hard the stability aid is working
    tcCut: 0,                // 0..1, drive the traction control is holding back
    assist: 0,               // 0..1, how much the countersteer assist is steering
    offroad: 0,              // 0..1, share of the wheels on unmade ground
    // Per-axle force budget, newtons: what each axle could give (cap) and what
    // it is giving along (x) and across (y) its own heading. For diagnosis —
    // "why won't it turn" is almost always answered by one of these six.
    axles: { capF: 0, capR: 0, fxF: 0, fyF: 0, fxR: 0, fyR: 0 },
    yawInertia: 0,           // kg·m², for energy accounting
    odometer: 0,
    time: 0,
  };

  const gsample = {};
  const wheelG = [{}, {}, {}, {}];
  const wheelSurf = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  const offs = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const axleOut = { x: 0, y: 0, spin: 0 };
  let hbHold = 0;            // s the stability aid stays stood down after the handbrake

  function forwardX() { return -Math.sin(car.yaw); }
  function forwardZ() { return -Math.cos(car.yaw); }
  function rightX() { return Math.cos(car.yaw); }
  function rightZ() { return -Math.sin(car.yaw); }

  /** Places the car on the road at (x, z) facing `yaw`, at rest. */
  function reset(x, z, yaw) {
    car.x = x; car.z = z; car.yaw = yaw ?? 0;
    car.vx = 0; car.vz = 0; car.vy = 0; car.yawRate = 0;
    car.gear = 1; car.rpm = spec.idleRpm; car.shiftTimer = 0; car.wheelSpin = 0;
    car.airborne = false; car.airTime = 0;
    car.steerAngle = 0;
    car.esc = 0; car.tcCut = 0; car.assist = 0;
    car.lonG = 0; car.latG = 0; car.loadG = 0; car.loadLatG = 0;
    hbHold = 0;
    if (damage && opts.repairOnReset !== false) damage.reset();
    const g = ground.sample(x, z, gsample);
    car.groundY = g.y;
    car.height = spec.rideHeight;
    car.heightVel = 0;
    car.y = g.y + spec.rideHeight;
    car.pitch = 0; car.roll = 0;
    car.speed = 0;
  }

  /** Throttle torque (N·m) at the crank. Never negative except at the limiter. */
  function engineTorque(rpm, throttle) {
    const r = clamp(rpm, spec.idleRpm, spec.redline);
    const peak = spec.power / (spec.peakRpm * 2 * Math.PI / 60);

    // An electric motor is not a small engine — it makes peak torque from a
    // standstill and then holds constant power. Running one through the
    // combustion curve below gives it a torque hole at zero rpm, which is the
    // exact opposite of what makes an EV feel quick.
    if (spec.cylinders === 0) {
      const flat = r <= spec.peakRpm ? 1 : spec.peakRpm / r;   // constant power above base
      let t = peak * flat * throttle;
      if (r >= spec.redline - 200) t *= 0.1;
      return t;
    }
    // Torque peaks below the power peak and tails off toward the limiter, which
    // is what makes a gearbox worth having.
    const n = r / spec.peakRpm;
    const shape = clamp(1.12 - 0.42 * (n - 0.85) * (n - 0.85) * 3.2, 0.25, 1.12);
    let t = peak * shape * throttle;
    if (r >= spec.redline - 60) t *= 0.15;                 // limiter
    return t;
  }

  /** Engine braking (N·m at the crank, a magnitude) with the throttle closed. */
  function engineDrag(rpm, throttle) {
    const peak = spec.power / (spec.peakRpm * 2 * Math.PI / 60);
    if (spec.cylinders === 0) return (1 - throttle) * peak * 0.09;   // regeneration
    return (1 - throttle) * peak * 0.11 * (clamp(rpm, spec.idleRpm, spec.redline) / spec.peakRpm);
  }

  function gearRatio() {
    if (car.gear === 0) return -spec.reverseRatio;
    return spec.gears[clamp(car.gear - 1, 0, spec.gears.length - 1)];
  }

  function autoShift(dt, vLong) {
    if (!car.aids.autoGear) return;
    if (car.shiftTimer > 0) return;
    // Selecting a direction at rest is a lever, not a gear change: nothing is
    // turning, so there is no torque to interrupt. Charging a full shift for it
    // was a quarter of a second of nothing every time the player pulled away.
    const atRest = car.speed < 0.6;

    // Reverse is a deliberate selection, never something the box does for you
    // while the player is asking for forward. This was a real bug last time:
    // the car would silently select reverse and pull away backwards.
    if (car.gear === 0) {
      if (car.input.throttle > 0.05 && vLong > -0.2 && car.input.brake < 0.05) {
        car.gear = 1; car.shiftTimer = atRest ? 0 : spec.shiftTime;
      }
      return;
    }
    if (vLong < 0.4 && car.input.brake > 0.55 && car.speed < 1.2) {
      car.gear = 0; car.shiftTimer = atRest ? 0 : spec.shiftTime;
      return;
    }

    const ratio = Math.abs(gearRatio()) * spec.finalDrive;
    const wheelRps = Math.abs(vLong) / spec.wheelRadius;
    const rpmNow = wheelRps * ratio * 60 / (2 * Math.PI);
    if (rpmNow > spec.redline * 0.93 && car.gear < spec.gears.length) {
      car.gear++; car.shiftTimer = spec.shiftTime;
    } else if (car.gear > 1) {
      const lower = spec.gears[car.gear - 2] * spec.finalDrive;
      const rpmLower = wheelRps * lower * 60 / (2 * Math.PI);
      if (rpmLower < spec.peakRpm * 0.72) { car.gear--; car.shiftTimer = spec.shiftTime; }
    }
  }

  /**
   * One axle's friction circle. Everything the axle is asked for — cornering,
   * drive, brakes — comes out of the same `cap` newtons, and asking for more
   * than that spins or locks the wheels, at which point the tyre is sliding and
   * its force points mostly along the direction it is being dragged. That last
   * part is what makes a spinning rear end step out and a locked front refuse
   * to steer. Writes into axleOut; allocates nothing.
   */
  function frictionCircle(fx, fy, cap) {
    const need = Math.hypot(fx, fy);
    // `spin` is the wheels genuinely spinning or locked: demand past the limit.
    // The blend below starts a little earlier, at 85%, which is where the force
    // starts to bend toward a sliding tyre's — but traction control holds an
    // axle at 95% all the way through a hard launch, and calling that a spin
    // put smoke under every car that was simply accelerating.
    axleOut.spin = cap > 0 ? smoothstep(1.0, 1.35, Math.abs(fx) / cap) : 0;
    if (need <= cap || cap <= 0) { axleOut.x = fx; axleOut.y = fy; return; }
    // Proportional share while the wheels are still rolling...
    const k = cap / need;
    let x = fx * k, y = fy * k;
    // ...blending to a sliding tyre as the longitudinal demand alone passes
    // the limit: most of the force along the slip, very little across it.
    const over = Math.abs(fx) / cap;
    const s = smoothstep(0.85, 1.25, over);
    if (s > 0) {
      const sx = Math.sign(fx) * cap * 0.96;
      const sy = Math.sign(fy) * Math.min(Math.abs(fy), cap * 0.28);
      x = lerp(x, sx, s); y = lerp(y, sy, s);
    }
    axleOut.x = x; axleOut.y = y;
  }

  /**
   * One physics step. `dt` should be a fixed 1/120 s; the caller is responsible
   * for accumulating real time into fixed steps.
   */
  function step(dt) {
    car.time += dt;
    if (car.shiftTimer > 0) car.shiftTimer = Math.max(0, car.shiftTimer - dt);

    const fx = forwardX(), fz = forwardZ();
    const rx = rightX(), rz = rightZ();

    // Body-frame velocity.
    const vLong = car.vx * fx + car.vz * fz;
    const vLat = car.vx * rx + car.vz * rz;
    const planarSpeed = Math.hypot(car.vx, car.vz);
    car.speed = planarSpeed;
    const dir = vLong < 0 ? -1 : 1;

    // Axle positions from the centre of mass. The static load split and the
    // moment arms MUST come from the same number; see fault 1 at the top.
    const L = spec.wheelbase;
    const aF = L * (1 - spec.cgBias);           // centre of mass to front axle
    const bR = L * spec.cgBias;                 // centre of mass to rear axle
    const Izz = spec.mass * aF * bR * (spec.yawIndex ?? 0.92);
    car.yawInertia = Izz;

    // ---- Sample the ground under each wheel ------------------------------
    const hw = spec.track / 2;
    offs[0][0] = -hw; offs[0][1] = aF;
    offs[1][0] = hw; offs[1][1] = aF;
    offs[2][0] = -hw; offs[2][1] = -bR;
    offs[3][0] = hw; offs[3][1] = -bR;
    let sumY = 0, sumNx = 0, sumNy = 0, sumNz = 0, gripSum = 0, roughSum = 0, rollSum = 0, dragSum = 0;
    for (let i = 0; i < 4; i++) {
      const ox = offs[i][0], oz = offs[i][1];
      const wxp = car.x + rx * ox + fx * oz;
      const wzp = car.z + rz * ox + fz * oz;
      const g = ground.sample(wxp, wzp, wheelG[i]);
      const w = car.wheels[i];
      w.surface = g.surface; w.grip = g.grip;
      sumY += g.y; sumNx += g.nx; sumNy += g.ny; sumNz += g.nz;
      gripSum += g.grip; roughSum += g.roughness; rollSum += g.rolling;
      dragSum += ROUGH_DRAG[g.surface] ?? 0.006;
    }
    const planeY = sumY / 4;
    let nx = sumNx / 4, ny = sumNy / 4, nz = sumNz / 4;
    const nl = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
    nx *= nl; ny *= nl; nz *= nl;
    car.groundNx = nx; car.groundNy = ny; car.groundNz = nz;
    car.groundY = planeY;

    const surfGrip = gripSum / 4;
    const rough = roughSum / 4;
    const rollRes = rollSum / 4;
    const roughDrag = dragSum / 4;
    car.surface = car.wheels[2].surface;
    car.offroad = clamp(roughDrag / ROUGH_DRAG.grass, 0, 1);

    // Ground slope resolved into the body frame: this is what makes hills pull.
    const pitchFromGround = Math.asin(clamp(-(nx * fx + nz * fz), -1, 1));
    const rollFromGround = Math.asin(clamp(-(nx * rx + nz * rz), -1, 1));
    const slopeAccelLong = -G * (nx * fx + nz * fz);
    const slopeAccelLat = -G * (nx * rx + nz * rz);

    // ---- Slip, measured before anything acts on it -----------------------
    // Below walking pace the slip angle is a ratio of two tiny numbers, and an
    // explicit step at 120 Hz overshoots it into a buzz. A 2 m/s floor keeps
    // the lateral dynamics inside what the integrator can resolve.
    const absLong = Math.max(2.0, Math.abs(vLong));
    // Direction each axle is actually travelling, relative to the nose,
    // right-positive. A textbook bicycle model with a LEFT-positive axis writes
    //     af = atan((vy + a*r)/vx) - d        ar = atan((vy - b*r)/vx)
    // Mirroring vy, r and d to right-positive flips the sign of the yaw-rate
    // term in BOTH, which is easy to miss and expensive to get wrong: with the
    // signs the other way the rear tyre pushes the car further into the turn
    // instead of resisting it, the model loses its natural yaw damping, and the
    // car spins on the spot at any real steering angle.
    const frontTravel = Math.atan2(vLat - car.yawRate * aF, absLong);
    const rearSlip = Math.atan2(vLat + car.yawRate * bR, absLong);
    car.rearSlip = rearSlip;
    car.bodySlip = planarSpeed > 1.5 ? Math.atan2(vLat, Math.abs(vLong)) : 0;

    // ---- Steering -------------------------------------------------------
    const feel = clamp(car.feel?.steer ?? 1, 0.5, 2.5);
    const muFront = surfGrip * spec.gripFront;
    const v2 = Math.max(1, planarSpeed * planarSpeed);
    // See STEERING at the top. atan(L / R) for the tightest radius this surface
    // can hold at this speed, plus the slip the front tyre needs to deliver it.
    const lock = clamp(Math.atan(L * muFront * G / v2) + LOCK_SLIP * feel, MIN_LOCK, spec.maxSteer);
    car.steerLock = lock;
    const command = clamp(car.input.steer, -1, 1);
    // Part-lock means part of the GRIP, not part of the angle. Grip saturates
    // within a few degrees at speed, so a straight share of the angle put 0.7 g
    // on a quarter of a stick at 80 km/h and made analogue steering twitchy.
    // In a steady corner the front and rear tyres slip by nearly the same
    // angle, so the wheel angle for a given lateral g is essentially the
    // geometric one; the slip allowance in `lock` is only needed to drive the
    // front to its peak at the very end of the range. So: the geometric angle
    // for `ask` of the grip, plus that allowance faded in as ask cubed. Full
    // input is still exactly `lock`, and at parking speeds the plain share of
    // the angle is the smaller and wins.
    const ask = Math.abs(command);
    const geo1 = Math.atan(L * muFront * G / v2);
    const byGrip = Math.atan(L * ask * muFront * G / v2) + Math.max(0, lock - geo1) * ask * ask * ask;
    const commandAngle = Math.sign(command) * Math.min(ask * lock, byGrip);

    // See COUNTERSTEER ASSIST at the top. Faded in with speed, because below
    // ~20 km/h nothing slides that a driver would want caught.
    const csAid = car.aids.countersteer ?? 0;
    const assist = csAid > 0 && !car.airborne
      ? csAid * smoothstep(CS_ON, CS_FULL, Math.abs(rearSlip)) * smoothstep(4, 9, planarSpeed) * (vLong > 0 ? 1 : 0)
      : 0;
    car.assist = assist;
    const wanted = clamp(commandAngle + assist * frontTravel, -spec.maxSteer, spec.maxSteer);
    // The wheels move at a finite rate, faster on the way back to centre.
    const rate = spec.steerRate * feel * (command === 0 ? 1.8 : 1) * dt;
    car.steerAngle += clamp(wanted - car.steerAngle, -rate, rate);
    // A blown tyre or bent steering pulls the ROAD WHEELS, not the input. The
    // player keeps full authority and simply has to hold against it, which is
    // the difference between a damaged car and a car that fights you.
    const delta = dmg ? car.steerAngle + dmg.steerPull * 0.055 * Math.min(1, planarSpeed / 14) : car.steerAngle;

    // ---- Airborne handling ----------------------------------------------
    const targetY = planeY + spec.rideHeight;
    if (!car.airborne) {
      // Leaving the ground requires the surface to drop away faster than the
      // suspension can extend AND the car to be moving quickly enough for that
      // to matter. Both conditions, so a pothole is not a jump.
      const drop = car.y - targetY;
      if (drop > 0.42 && planarSpeed > 7) {
        car.airborne = true;
        car.airTime = 0;
        car.vy = Math.max(0, car.heightVel);
      }
    }

    if (car.airborne) {
      car.airTime += dt;
      car.vy -= G * dt;
      car.y += car.vy * dt;
      // Only mild aero yaw damping in the air; no grip, so no steering.
      car.yawRate *= Math.exp(-0.6 * dt);
      car.pitch = lerp(car.pitch, clamp(-car.vy * 0.035, -0.35, 0.35), 1 - Math.exp(-2.2 * dt));
      car.roll = lerp(car.roll, 0, 1 - Math.exp(-2.0 * dt));
      const drag = 0.5 * 1.225 * spec.dragArea * planarSpeed / spec.mass;
      car.vx -= car.vx * drag * dt;
      car.vz -= car.vz * drag * dt;
      car.x += car.vx * dt; car.z += car.vz * dt;
      car.yaw += car.yawRate * dt;
      car.esc = 0; car.tcCut = 0;

      if (car.y <= targetY) {
        car.y = targetY;
        car.airborne = false;
        car.landedAt = car.time;
        // The landing goes into the springs, not into a bounce.
        car.heightVel = clamp(car.vy, -9, 0);
        car.vy = 0;
      }
      finishTelemetry(dt, vLong, vLat, 0, 0, 0);
      return;
    }

    // ---- Weight and load transfer ---------------------------------------
    const weight = spec.mass * G;
    const aeroLoad = spec.downforce * planarSpeed * planarSpeed;
    const totalLoad = weight + aeroLoad;
    // m * a * h / L, and lonG is in g, so a is lonG * G. The G used to be
    // missing, which made every weight shift a tenth of its real size: 0.9 g of
    // braking moved 240 N onto the front of a 1400 kg car instead of 2400.
    // That is why trail braking "was too subtle to use deliberately" and was
    // faked with a flat cut to rear grip — the real mechanism was switched off.
    const lonTransfer = clamp(car.loadG * G * spec.mass * spec.cgHeight / L, -weight * 0.42, weight * 0.42);
    const latTransfer = clamp(car.loadLatG * G * spec.mass * spec.cgHeight / spec.track, -weight * 0.42, weight * 0.42);

    const frontStatic = totalLoad * spec.cgBias;
    const rearStatic = totalLoad * (1 - spec.cgBias);
    const frontLoad = Math.max(120, frontStatic - lonTransfer);
    const rearLoad = Math.max(120, rearStatic + lonTransfer);

    // Load sensitivity: a tyre carrying twice the load gives less than twice
    // the grip, which is what makes weight transfer matter.
    const loadSens = (Fz, Fz0) => Math.pow(Fz0 / Math.max(200, Fz), 0.12);
    // Per-corner damage is averaged onto its own axle. A single blown front
    // tyre therefore halves front grip rather than the car's, which is what
    // makes it pull and understeer instead of simply going slower.
    const dmgF = dmg ? (dmg.gripScale[0] + dmg.gripScale[1]) * 0.5 : 1;
    const dmgR = dmg ? (dmg.gripScale[2] + dmg.gripScale[3]) * 0.5 : 1;
    const capF = surfGrip * spec.gripFront * dmgF * loadSens(frontLoad, weight * spec.cgBias) * frontLoad;
    const capR = surfGrip * spec.gripRear * dmgR * loadSens(rearLoad, weight * (1 - spec.cgBias)) * rearLoad;

    // ---- Electronic stability -------------------------------------------
    //
    // A real ESC brakes individual wheels to KILL yaw the driver did not ask
    // for, and cuts the engine while it does. Three rules, each learned:
    //
    // It may only ever oppose. The first version chased a target of mu*g/v,
    // which grows as the car slows: once the car began to slide the aid
    // demanded more yaw, which cost speed, which raised the target again. With
    // ESC on the car sat at 80 degrees of slip. The aid was spinning it.
    //
    // It must know what the driver ASKED for. The second version only acted
    // on yaw beyond what the surface could hold, which meant it did nothing at
    // all to a car sliding at 0.4 rad/s with the wheel dead straight — that is
    // within the limit, and it is also not what anybody wants. The reference
    // here is the yaw the COMMANDED steering would give (the countersteer
    // assist is excluded, since that is the car correcting, not the driver
    // asking), capped at what the surface can deliver.
    //
    // It is not free. Braking one front wheel is what makes the moment, so the
    // same brake force is charged to the front axle below and the car slows as
    // it is caught — which is how a real one feels, and why it can never add
    // energy. The moment is capped at what one side's brakes can make.
    let escMoment = 0, escBrake = 0, escLevel = 0;
    const handbrake = clamp(car.input.handbrake, 0, 1);
    // The handbrake is the one thing a player uses precisely to make the tail
    // come round; the aid stands aside while it is held and for a moment after,
    // then catches whatever the player has made.
    hbHold = handbrake > 0.1 ? 0.45 : Math.max(0, hbHold - dt);
    const stab = (car.aids.stability || 0) * (1 - smoothstep(0, 0.45, hbHold));
    if (stab > 0 && planarSpeed > 4) {
      const vRef = Math.max(6, Math.abs(vLong));
      const yawMax = (surfGrip * Math.min(spec.gripFront, spec.gripRear) * G) / vRef;
      const rWant = clamp(-vLong * Math.tan(commandAngle) / L, -yawMax, yawMax);
      const r = car.yawRate;
      let excess = r * rWant > 0 ? Math.abs(r) - Math.abs(rWant) : Math.abs(r);
      excess -= ESC_YAW_DEADBAND + ESC_YAW_SLACK * Math.abs(rWant);
      if (excess > 0) escMoment -= Math.sign(r) * excess * Izz * ESC_YAW_GAIN;
      // Rear slip past what an ordinary corner uses: turn the nose back toward
      // the direction of travel.
      const overSlip = Math.abs(rearSlip) - ESC_SLIP_ON;
      if (overSlip > 0 && vLong > 0) escMoment -= Math.sign(rearSlip) * overSlip * Izz * ESC_SLIP_GAIN;
      escMoment *= stab;
      const mMax = 0.5 * capF * spec.track;          // one front wheel at its limit
      escMoment = clamp(escMoment, -mMax, mMax);
      escBrake = Math.abs(escMoment) / (spec.track * 0.5);
      escLevel = mMax > 0 ? Math.abs(escMoment) / mMax : 0;
    }
    // Smoothed so the engine cut does not chatter at the edge of the threshold.
    car.esc += (escLevel - car.esc) * Math.min(1, dt * 18);

    // ---- Drivetrain ------------------------------------------------------
    autoShift(dt, vLong);
    const ratio = gearRatio() * spec.finalDrive;
    let throttle = clamp(car.input.throttle, 0, 1);
    if (car.shiftTimer > 0) throttle *= 0.35;
    throttle *= 1 - ESC_CUT * clamp(car.esc * 2, 0, 1);

    // Engine speed. Below the road speed at which the engine would be turning
    // at its launch rpm in this gear, the clutch (or converter) slips and holds
    // it there: nobody pulls away with the engine lugging at idle. Driving it
    // through the torque curve at 850 rpm made every launch a stall — the car
    // crept at 0.6 g-and-falling until the road speed dragged the engine up to
    // where it makes torque.
    const wheelRpm = Math.abs((vLong / spec.wheelRadius) * ratio) * 60 / (2 * Math.PI);
    let engineRpm = wheelRpm;
    if (throttle > 0.02) engineRpm = Math.max(engineRpm, launchRpm(spec, throttle));
    car.rpm = clamp(engineRpm, spec.idleRpm, spec.redline);

    // The driveline is not free. About an eighth of the crank's output is lost
    // in the gearbox and differentials — and see massLong below. Leaving both
    // out put a 280 hp hatch through 0-100 in 2.97 s, supercar territory, and
    // a 113 hp city car through it in 8.0.
    let driveForce = (engineTorque(car.rpm, throttle) * ratio) / spec.wheelRadius * DRIVELINE;
    // Engine braking opposes motion, and fades out below walking pace where the
    // clutch would be open. Computed as signed torque it used to push a car
    // sitting still in gear gently backwards.
    const engBrake = (engineDrag(car.rpm, throttle) * Math.abs(ratio) / spec.wheelRadius) *
      smoothstep(0.5, 2.5, Math.abs(vLong)) * (car.shiftTimer > 0 ? 0.3 : 1);
    if (dmg) driveForce *= dmg.powerScale;

    const shareF = spec.drive === DRIVE.FWD ? 1 : spec.drive === DRIVE.RWD ? 0 : (spec.awdFront ?? 0.42);
    let driveF = (driveForce - dir * engBrake) * shareF;
    let driveR = (driveForce - dir * engBrake) * (1 - shareF);

    // ---- Tyre forces -----------------------------------------------------
    const frontSlip = frontTravel - delta * dir;
    const fyF = tyreCurve(-frontSlip, TYRE_BF, TYRE_CF, capF);
    const fyR = tyreCurve(-rearSlip, TYRE_BR, TYRE_CR, capR);

    // Traction control: hold each driven axle's drive to what its friction
    // circle has left over after cornering. A key is full throttle or none, so
    // on a keyboard this is the only thing standing between "accelerate out of
    // the corner" and "spin in the corner".
    const tc = car.aids.tc || 0;
    let tcCut = 0;
    if (tc > 0) {
      const leftF = Math.sqrt(Math.max(0, capF * capF - fyF * fyF)) * 0.95;
      const leftR = Math.sqrt(Math.max(0, capR * capR - fyR * fyR)) * 0.95;
      if (driveF * dir > leftF) { const n = dir * lerp(Math.abs(driveF), leftF, tc); tcCut = Math.max(tcCut, 1 - Math.abs(n / driveF)); driveF = n; }
      if (driveR * dir > leftR) { const n = dir * lerp(Math.abs(driveR), leftR, tc); tcCut = Math.max(tcCut, 1 - Math.abs(n / driveR)); driveR = n; }
    }
    car.tcCut = tcCut;

    // Brakes. The pedal is split by bias; ABS holds each axle just under the
    // longitudinal limit, which leaves the tyre some cornering force — the
    // entire point of ABS is that you can still steer.
    const brakePedal = clamp(car.input.brake, 0, 1);
    let brakeForce = (brakePedal * spec.brakeTorque * 2) / spec.wheelRadius;
    if (dmg) brakeForce *= dmg.brakeScale;
    let brakeF = brakeForce * spec.brakeBias;
    let brakeR = brakeForce * (1 - spec.brakeBias);
    const abs = car.aids.abs || 0;
    if (abs > 0 && planarSpeed > 2) {
      brakeF = lerp(brakeF, Math.min(brakeF, capF * 0.9), abs);
      brakeR = lerp(brakeR, Math.min(brakeR, capR * 0.9), abs);
    }
    // The handbrake bypasses ABS on every real car, which is why it locks.
    const handForce = handbrake * spec.handbrakeTorque / spec.wheelRadius;

    const fxF = driveF - dir * (brakeF + escBrake);
    const fxR = driveR - dir * (brakeR + handForce);

    frictionCircle(fxF, fyF, capF);
    const FxF = axleOut.x, FyF = axleOut.y, slideF = axleOut.spin;
    frictionCircle(fxR, fyR, capR);
    const FxR = axleOut.x, FyR = axleOut.y, slideR = axleOut.spin;
    const ax0 = car.axles;
    ax0.capF = capF; ax0.capR = capR; ax0.fxF = FxF; ax0.fyF = FyF; ax0.fxR = FxR; ax0.fyR = FyR;

    // The front tyres push along and across THEIR heading, not the body's.
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const frontLong = FxF * cd - FyF * sd;
    const frontLat = FxF * sd + FyF * cd;

    // ---- Integrate the planar body --------------------------------------
    const dragForce = 0.5 * 1.225 * (spec.dragArea + (dmg ? dmg.dragAdd : 0)) * planarSpeed * planarSpeed;
    // Off-road losses scale with the suspension's travel: a lifted 4x4 floats
    // over ground that shakes a low sports car to pieces. Above ROUGH_KNEE the
    // wheels start leaving the ground between bumps and every landing is a
    // hit, so the loss grows faster than speed from there — which is what
    // stops a 280 hp car simply out-powering a field.
    const suspension = clamp(0.30 / spec.rideHeight, 0.6, 1.8) ** 0.7;
    const knee = 1 + Math.max(0, planarSpeed - ROUGH_KNEE) / ROUGH_KNEE;
    const rollingForce = rollRes * totalLoad * (1 + rough * 0.6) +
      spec.mass * G * roughDrag * suspension * planarSpeed * knee;

    // In gear, the engine and wheels have to be spun up (or down) with the car,
    // which in first is like carrying a quarter as much again. Only while the
    // driven wheels grip, though: in a power slide they already turn at steady
    // revs and the torque goes into the road. Charging it there as well cut a
    // held drift from eight seconds to four, measured.
    const drivenSlide = spec.drive === DRIVE.FWD ? slideF
      : spec.drive === DRIVE.RWD ? slideR : Math.max(slideF, slideR);
    const geared = car.shiftTimer > 0 ? 0 : 1 - drivenSlide;
    const massLong = spec.mass + rotatingMass(spec, ratio) * geared;
    let aLong = (frontLong + FxR - dir * (dragForce + rollingForce)) / massLong + slopeAccelLong;
    const aLat = (frontLat + FyR) / spec.mass + slopeAccelLat;

    // Brakes, rolling resistance and drag can stop the car. They cannot start
    // it the other way: they are friction, and friction only ever opposes.
    // Left to integrate, a car held on the brake at rest was pushed gently
    // backwards by its own brakes, which is energy from nowhere.
    //
    // So when this step would carry the car through zero, or it is already at
    // rest, the question is what would MOVE it — the engine and the hill —
    // against what HOLDS it — brakes, handbrake, rolling resistance. Asked in
    // terms of the direction of travel instead, reverse gear pulling away from
    // a standstill reads as a brake pushing the car backwards, and it was held
    // there: a tenth of the long-drive harness spent parked in reverse on sand.
    const vNext = vLong + aLong * dt;
    if (vNext * vLong < 0 || Math.abs(vLong) < 0.05) {
      const push = driveForce + spec.mass * slopeAccelLong;
      const hold = brakeForce + handForce + escBrake + rollingForce;
      if (Math.abs(push) <= hold) aLong = -vLong / dt;                        // at rest, and staying there
      else if (vNext * vLong < 0 && push * vNext <= 0) aLong = -vLong / dt;   // stops now, pulls away next step
    }

    // Integrate velocity in the WORLD frame.
    //
    // Integrating vLong/vLat in the body frame and then rebuilding world
    // velocity from the UPDATED heading silently rotates the velocity vector
    // along with the car — which is the same as dropping the centripetal terms
    //     dv_long/dt = a_long + r*v_lat      dv_lat/dt = a_lat - r*v_long
    // With those missing the car can yaw as fast as the moment allows without
    // ever developing a slip angle, so no lateral force is ever demanded: it
    // pirouettes at 2 rad/s while the accelerometer reads 0.01 g. Converting
    // the accelerations here, with the heading the forces were computed in,
    // gets the coupling right without needing the correction terms at all.
    const ax = fx * aLong + rx * aLat;
    const az = fz * aLong + rz * aLat;
    car.vx += ax * dt;
    car.vz += az * dt;

    // A RIGHTWARD force ahead of the centre of mass yaws the car clockwise seen
    // from above, and yaw grows counter-clockwise here — hence the minus on the
    // front term. Textbook bicycle models write `a*Fyf - b*Fyr` because their
    // lateral axis points LEFT; this one points right, and dropping that
    // distinction is what once made full right lock steer the car left.
    const yawMoment = -frontLat * aF + FyR * bR + escMoment;
    car.yawRate += (yawMoment / Izz) * dt;
    // A little extra yaw damping as the tyres scrub. A tyre dragged sideways
    // soaks up rotational energy through its carcass, which the slip curve
    // alone does not capture; without any, a car that spins does so like a
    // top. Dissipative by construction — it can only ever slow the rotation.
    const scrubAngle = Math.max(Math.abs(frontSlip), Math.abs(rearSlip));
    car.yawRate *= Math.exp(-(0.25 + Math.min(1.2, scrubAngle * 2.4)) * dt);
    car.yawRate = clamp(car.yawRate, -3.2, 3.2);
    car.yaw += car.yawRate * dt;

    car.lonG = aLong / G;
    car.latG = aLat / G;
    // A car held on the brakes is not accelerating, whatever the stop clamp
    // above had to do to keep it that way — and lonG feeds the load transfer.
    if (Math.abs(car.lonG) > 3) car.lonG = Math.sign(car.lonG) * 3;
    // The weight follows through the springs in ~60 ms: a road car's pitch
    // mode, first order.
    const kLoad = 1 - Math.exp(-dt / 0.06);
    car.loadG += (car.lonG - car.loadG) * kLoad;
    car.loadLatG += (car.latG - car.loadLatG) * kLoad;

    // A stationary car should stay put rather than creep down a slope.
    if (planarSpeed < 0.35 && throttle < 0.05) { car.vx *= 0.72; car.vz *= 0.72; }

    car.x += car.vx * dt;
    car.z += car.vz * dt;
    car.odometer += planarSpeed * dt;

    // ---- Suspension: height, pitch and roll -----------------------------
    // A critically damped spring toward the ride height. This is the ONLY
    // vertical dynamic while grounded, and it is bounded, so no combination of
    // inputs can throw the car upward.
    const err = (planeY + spec.rideHeight) - car.y;
    const omega = Math.sqrt(spec.springRate * 4 / spec.mass);
    const zeta = spec.damping * 4 / (2 * Math.sqrt(spec.springRate * 4 * spec.mass));
    car.heightVel += (err * omega * omega - car.heightVel * 2 * zeta * omega) * dt;
    car.heightVel = clamp(car.heightVel, -14, 14);
    car.y += car.heightVel * dt;
    // Hard clamp. Belt and braces: even if the spring misbehaves the chassis
    // stays within a hand's width of where it belongs.
    car.y = clamp(car.y, planeY + spec.rideHeight - 0.22, planeY + spec.rideHeight + 0.30);
    car.height = car.y - planeY;

    const dive = clamp(-car.lonG * 0.055, -0.09, 0.09);
    const lean = clamp(car.latG * 0.070, -0.12, 0.12);
    const k = 1 - Math.exp(-9 * dt);
    car.pitch = lerp(car.pitch, pitchFromGround + dive, k);
    car.roll = lerp(car.roll, rollFromGround + lean, k);

    finishTelemetry(dt, vLong, vLat, frontSlip, rearSlip, Math.max(slideF, slideR));

    if (damage) {
      for (let i = 0; i < 4; i++) wheelSurf[i] = car.wheels[i].surface;
      damage.abrade(dt, wheelSurf, planarSpeed, car.slipping);
      damage.step(dt, clamp(Math.abs(throttle) * 0.7 + Math.abs(car.lonG) * 0.5, 0, 1.4), planarSpeed);
    }

    // Per-wheel readouts for the renderer and HUD.
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const axleLoad = i < 2 ? frontLoad : rearLoad;
      w.load = Math.max(60, axleLoad * 0.5 + (i % 2 === 0 ? -0.5 : 0.5) * latTransfer);
      w.slipAngle = i < 2 ? frontSlip : rearSlip;
      w.slip = i < 2 ? slideF : slideR;
      w.comp = clamp((car.height - spec.rideHeight) * -1 + (i < 2 ? dive : -dive), -0.12, 0.12);
      w.spin += (vLong / spec.wheelRadius) * dt;
    }
  }

  function finishTelemetry(dt, vLong, vLat, frontSlip, rearSlip, wheelSlide) {
    car.speed = Math.hypot(car.vx, car.vz);
    // Smoke, skids and tyre squeal. Starts just short of the tyre's peak, and
    // a spinning or locked axle counts as much as a sideways one — a burnout
    // should smoke.
    const slipMag = Math.max(Math.abs(frontSlip) / PEAK_F, Math.abs(rearSlip) / PEAK_R);
    car.slipping = Math.max(clamp((slipMag - 0.85) / 1.6, 0, 1), clamp(wheelSlide, 0, 1) * 0.8);
    car.vLong = vLong; car.vLat = vLat;
  }

  car.damage = damage;
  car.reset = reset;
  car.step = step;
  /** Apply a player's settings (esc, tc, abs, steerFeel) through aidsFor(). */
  car.setAssists = (s = {}) => {
    Object.assign(car.aids, aidsFor(s));
    car.feel.steer = clamp(s.steerFeel ?? 1, 0.5, 2.5);
  };
  car.forward = () => ({ x: forwardX(), y: 0, z: forwardZ() });
  car.right = () => ({ x: rightX(), y: 0, z: rightZ() });
  return car;
}
