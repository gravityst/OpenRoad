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

  power: 209000,            // W at peak (about 280 hp)
  peakRpm: 6200,
  redline: 6900,
  idleRpm: 850,
  gears: [3.55, 2.05, 1.42, 1.05, 0.84, 0.68],
  finalDrive: 3.46,
  reverseRatio: 3.30,
  shiftTime: 0.22,          // s of torque interruption

  brakeTorque: 3400,        // N·m per axle at full pedal
  brakeBias: 0.63,          // fraction to the front
  handbrakeTorque: 2600,    // N·m, rear only

  maxSteer: 0.62,           // rad at the road wheel, full lock at a standstill
  steerRate: 3.4,           // rad/s of steering-wheel movement
  dragArea: 0.68,           // Cd * A, m^2
  downforce: 0.22,          // N per (m/s)^2, mild road-car lift compensation

  gripFront: 1.06,          // peak tyre friction, dry asphalt
  gripRear: 1.08,
  springRate: 34000,        // N/m per corner
  damping: 4200,            // N·s/m per corner
};

/** Simplified Pacejka: peak near 0.16 rad of slip, gentle fall-off after. */
function tyreCurve(slip, B, C, D) {
  return D * Math.sin(C * Math.atan(B * slip));
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
    input: { throttle: 0, brake: 0, steer: 0, handbrake: 0 },
    // Defaults match what main.js applies for a new player, so the headless
    // harnesses measure the car people actually drive.
    aids: { abs: 0.95, tc: 0.55, stability: 0.62, autoGear: true },

    // readouts
    speed: 0,                // m/s along the ground
    lonG: 0, latG: 0,
    surface: 'asphalt',
    slipping: 0,             // 0..1, how far past the grip limit the tyres are
    odometer: 0,
    time: 0,
  };

  const gsample = {};
  const wheelG = [{}, {}, {}, {}];
  const wheelSurf = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];

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
    if (damage && opts.repairOnReset !== false) damage.reset();
    const g = ground.sample(x, z, gsample);
    car.groundY = g.y;
    car.height = spec.rideHeight;
    car.heightVel = 0;
    car.y = g.y + spec.rideHeight;
    car.pitch = 0; car.roll = 0;
    car.speed = 0;
  }

  /** Engine torque (N·m) at the crank for a given rpm and throttle. */
  function engineTorque(rpm, throttle) {
    const r = clamp(rpm, spec.idleRpm, spec.redline);

    // An electric motor is not a small engine — it makes peak torque from a
    // standstill and then holds constant power. Running one through the
    // combustion curve below gives it a torque hole at zero rpm, which is the
    // exact opposite of what makes an EV feel quick.
    if (spec.cylinders === 0) {
      const peak = spec.power / (spec.peakRpm * 2 * Math.PI / 60);
      const flat = r <= spec.peakRpm ? 1 : spec.peakRpm / r;   // constant power above base
      let t = peak * flat * throttle;
      if (r >= spec.redline - 200) t *= 0.1;
      t -= (1 - throttle) * peak * 0.09;                       // regenerative braking
      return t;
    }
    // Torque peaks below the power peak and tails off toward the limiter, which
    // is what makes a gearbox worth having.
    const n = r / spec.peakRpm;
    const shape = clamp(1.12 - 0.42 * (n - 0.85) * (n - 0.85) * 3.2, 0.25, 1.12);
    const peakTorque = spec.power / (spec.peakRpm * 2 * Math.PI / 60);
    let t = peakTorque * shape * throttle;
    if (r >= spec.redline - 60) t *= 0.15;                 // limiter
    // Engine braking when off throttle.
    t -= (1 - throttle) * peakTorque * 0.11 * (r / spec.peakRpm);
    return t;
  }

  function gearRatio() {
    if (car.gear === 0) return -spec.reverseRatio;
    return spec.gears[clamp(car.gear - 1, 0, spec.gears.length - 1)];
  }

  function autoShift(dt, vLong) {
    if (!car.aids.autoGear) return;
    if (car.shiftTimer > 0) return;

    // Reverse is a deliberate selection, never something the box does for you
    // while the player is asking for forward. This was a real bug last time:
    // the car would silently select reverse and pull away backwards.
    if (car.gear === 0) {
      if (car.input.throttle > 0.05 && vLong > -0.2 && car.input.brake < 0.05) {
        car.gear = 1; car.shiftTimer = spec.shiftTime;
      }
      return;
    }
    if (vLong < 0.4 && car.input.brake > 0.55 && car.speed < 1.2) {
      car.gear = 0; car.shiftTimer = spec.shiftTime;
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
   * One physics step. `dt` should be a fixed 1/120 s; the caller is responsible
   * for accumulating real time into fixed steps.
   */
  function step(dt) {
    car.time += dt;
    if (car.shiftTimer > 0) car.shiftTimer = Math.max(0, car.shiftTimer - dt);

    const fx = forwardX(), fz = forwardZ();
    const rx = rightX(), rz = rightZ();

    // Body-frame velocity.
    let vLong = car.vx * fx + car.vz * fz;
    let vLat = car.vx * rx + car.vz * rz;
    const planarSpeed = Math.hypot(car.vx, car.vz);
    car.speed = planarSpeed;

    // ---- Steering -------------------------------------------------------
    // Lock is limited to roughly what the front tyres can actually use: the
    // Ackermann angle for a corner at the limit, plus the slip angle where the
    // tyre makes peak force, plus a little margin for deliberate oversteer.
    //
    // A plain 1/(1+v^2) falloff looks reasonable and is quietly wrong — it caps
    // lock BELOW the peak-slip angle at speed, so the front tyres can never
    // reach their own maximum and the car understeers no matter what the driver
    // does. Measured at 0.63 g where the tyres were good for over 1.0.
    const PEAK_SLIP = 0.20;                      // rad, where the curve peaks
    const ackermann = spec.wheelbase * spec.gripFront * G / Math.max(25, planarSpeed * planarSpeed);
    const maxSteerNow = clamp(PEAK_SLIP * 1.15 + ackermann, 0.09, spec.maxSteer);
    const wanted = clamp(car.input.steer, -1, 1) * maxSteerNow;
    const rate = spec.steerRate * (car.input.steer === 0 ? 1.8 : 1) * dt;
    car.steerAngle += clamp(wanted - car.steerAngle, -rate, rate);
    car.steerAngle = clamp(car.steerAngle, -maxSteerNow, maxSteerNow);
    // A blown tyre or bent steering pulls the ROAD WHEELS, not the input. The
    // player keeps full authority and simply has to hold against it, which is
    // the difference between a damaged car and a car that fights you.
    const pulled = dmg ? car.steerAngle + dmg.steerPull * 0.055 * Math.min(1, planarSpeed / 14) : car.steerAngle;

    // ---- Sample the ground under each wheel ------------------------------
    const hw = spec.track / 2, hb = spec.wheelbase / 2;
    const offs = [[-hw, hb], [hw, hb], [-hw, -hb], [hw, -hb]];   // x=right, z=forward
    let sumY = 0, sumNx = 0, sumNy = 0, sumNz = 0, gripSum = 0, roughSum = 0, rollSum = 0;
    let pitchFromGround = 0, rollFromGround = 0;
    for (let i = 0; i < 4; i++) {
      const [ox, oz] = offs[i];
      const wxp = car.x + rx * ox + fx * oz;
      const wzp = car.z + rz * ox + fz * oz;
      const g = ground.sample(wxp, wzp, wheelG[i]);
      const w = car.wheels[i];
      w.surface = g.surface; w.grip = g.grip;
      sumY += g.y; sumNx += g.nx; sumNy += g.ny; sumNz += g.nz;
      gripSum += g.grip; roughSum += g.roughness; rollSum += g.rolling;
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
    car.surface = car.wheels[2].surface;

    // Ground slope resolved into the body frame: this is what makes hills pull.
    pitchFromGround = Math.asin(clamp(-(nx * fx + nz * fz), -1, 1));
    rollFromGround = Math.asin(clamp(-(nx * rx + nz * rz), -1, 1));
    const slopeAccelLong = -G * (nx * fx + nz * fz);
    const slopeAccelLat = -G * (nx * rx + nz * rz);

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

      if (car.y <= targetY) {
        car.y = targetY;
        car.airborne = false;
        car.landedAt = car.time;
        // The landing goes into the springs, not into a bounce.
        car.heightVel = clamp(car.vy, -9, 0);
        car.vy = 0;
      }
      finishTelemetry(dt, vLong, vLat, 0, 0);
      return;
    }

    // ---- Weight and load transfer ---------------------------------------
    const weight = spec.mass * G;
    const aeroLoad = spec.downforce * planarSpeed * planarSpeed;
    const totalLoad = weight + aeroLoad;
    const lonTransfer = clamp(car.lonG * spec.mass * spec.cgHeight / spec.wheelbase, -weight * 0.42, weight * 0.42);
    const latTransfer = clamp(car.latG * spec.mass * spec.cgHeight / spec.track, -weight * 0.42, weight * 0.42);

    const frontStatic = totalLoad * spec.cgBias;
    const rearStatic = totalLoad * (1 - spec.cgBias);
    const loads = [
      Math.max(60, (frontStatic - lonTransfer) * 0.5 - latTransfer * 0.5),  // FL
      Math.max(60, (frontStatic - lonTransfer) * 0.5 + latTransfer * 0.5),  // FR
      Math.max(60, (rearStatic + lonTransfer) * 0.5 - latTransfer * 0.5),   // RL
      Math.max(60, (rearStatic + lonTransfer) * 0.5 + latTransfer * 0.5),   // RR
    ];

    // ---- Drivetrain ------------------------------------------------------
    autoShift(dt, vLong);
    const ratio = gearRatio() * spec.finalDrive;
    const wheelOmega = vLong / spec.wheelRadius;
    car.rpm = clamp(Math.abs(wheelOmega * ratio) * 60 / (2 * Math.PI), spec.idleRpm, spec.redline);

    let throttle = clamp(car.input.throttle, 0, 1);
    if (car.shiftTimer > 0) throttle *= 0.06;
    const crankTorque = engineTorque(car.rpm, throttle);
    let driveForce = (crankTorque * ratio) / spec.wheelRadius;
    if (dmg) driveForce *= dmg.powerScale;

    // Traction control: cut drive when the driven tyres are asking for more
    // than the surface can give.
    const drivenLoad = spec.drive === DRIVE.FWD ? loads[0] + loads[1]
      : spec.drive === DRIVE.RWD ? loads[2] + loads[3] : totalLoad;
    const gripLimit = drivenLoad * surfGrip * (spec.drive === DRIVE.FWD ? spec.gripFront : spec.gripRear);
    if (car.aids.tc > 0 && Math.abs(driveForce) > gripLimit) {
      const excess = Math.abs(driveForce) / gripLimit;
      driveForce /= lerp(1, excess, car.aids.tc);
    }

    // ---- Brakes ----------------------------------------------------------
    const brakePedal = clamp(car.input.brake, 0, 1);
    let brakeForce = (brakePedal * spec.brakeTorque * 2) / spec.wheelRadius;
    if (dmg) brakeForce *= dmg.brakeScale;
    const handbrake = clamp(car.input.handbrake, 0, 1);

    // ABS: bound total braking to what the tyres can hold, with a little
    // margin. A proportional limit, not an integrating servo — an integrator
    // here winds to full cut in three frames and strangles the brakes, which is
    // exactly what went wrong on the last project.
    const brakeGripLimit = totalLoad * surfGrip * (spec.gripFront * spec.brakeBias + spec.gripRear * (1 - spec.brakeBias));
    if (car.aids.abs > 0 && brakeForce > brakeGripLimit && planarSpeed > 2) {
      brakeForce = lerp(brakeForce, brakeGripLimit * 1.02, car.aids.abs);
    }

    // ---- Tyre forces -----------------------------------------------------
    const absLong = Math.max(1.2, Math.abs(vLong));
    // Slip angles, mirrored into this file's right-positive lateral axis.
    //
    // A textbook bicycle model with a LEFT-positive axis writes
    //     af = atan((vy + a*r)/vx) - d        ar = atan((vy - b*r)/vx)
    // Mirroring vy, r and d to right-positive flips the sign of the yaw-rate
    // term in BOTH, which is easy to miss and expensive to get wrong: with the
    // signs the other way the rear tyre pushes the car further into the turn
    // instead of resisting it, the model loses its natural yaw damping, and the
    // car spins on the spot at any real steering angle.
    const frontSlip = Math.atan2(vLat - car.yawRate * hb, absLong) - pulled * Math.sign(vLong || 1);
    const rearSlip = Math.atan2(vLat + car.yawRate * hb, absLong);

    const frontLoad = loads[0] + loads[1];
    const rearLoad = loads[2] + loads[3];
    // Load sensitivity: a tyre carrying twice the load gives less than twice
    // the grip, which is what makes weight transfer matter.
    const loadSens = (Fz, Fz0) => Math.pow(Fz0 / Math.max(200, Fz), 0.12);

    // Per-corner damage is averaged onto its own axle. A single blown front
    // tyre therefore halves front grip rather than the car's, which is what
    // makes it pull and understeer instead of simply going slower.
    const dmgF = dmg ? (dmg.gripScale[0] + dmg.gripScale[1]) * 0.5 : 1;
    const dmgR = dmg ? (dmg.gripScale[2] + dmg.gripScale[3]) * 0.5 : 1;
    const muF = surfGrip * spec.gripFront * dmgF * loadSens(frontLoad, weight * spec.cgBias);
    let muR = surfGrip * spec.gripRear * dmgR * loadSens(rearLoad, weight * (1 - spec.cgBias));
    // Handbrake breaks the rear away on purpose.
    if (handbrake > 0) muR *= lerp(1, 0.42, handbrake);

    let Fy_front = tyreCurve(-frontSlip, 9.2, 1.45, muF * frontLoad);
    let Fy_rear = tyreCurve(-rearSlip, 9.6, 1.42, muR * rearLoad);

    // Longitudinal demand shares the same friction budget as cornering.
    const netLong = driveForce - Math.sign(vLong || 1) * brakeForce
                    - Math.sign(vLong || 1) * handbrake * spec.handbrakeTorque / spec.wheelRadius;
    const longCapacity = totalLoad * surfGrip * 1.25;
    const usedLong = clamp(Math.abs(netLong) / longCapacity, 0, 1);
    const ellipse = Math.sqrt(Math.max(0, 1 - usedLong * usedLong * 0.82));
    Fy_front *= ellipse;
    Fy_rear *= ellipse;

    // Electronic stability.
    //
    // NOTE THE SIGN: lateral is right-positive and yaw grows counter-clockwise,
    // so steering right (positive) asks for NEGATIVE yaw rate.
    //
    // The reference yaw rate is the kinematic one CLAMPED BY GRIP. The kinematic
    // figure alone is what a car would rotate at if tyres were infinite, and at
    // 90 km/h it asks for about five times what the road can deliver — so the
    // controller spends the whole corner adding yaw into a slide it is supposed
    // to be catching. Clamping to mu*g/v is the standard ESC reference model and
    // is the difference between an aid and an accomplice.
    const Izz = spec.mass * (spec.wheelbase * spec.wheelbase + spec.track * spec.track) / 12;
    let stabilityMoment = 0;
    if (car.aids.stability > 0 && planarSpeed > 4) {
      const yawCeiling = (surfGrip * spec.gripRear * G) / Math.max(6, Math.abs(vLong));
      const wantYaw = clamp(-(vLong * car.steerAngle) / spec.wheelbase, -yawCeiling, yawCeiling);
      stabilityMoment = (wantYaw - car.yawRate) * Izz * 2.8 * car.aids.stability;
    }

    // ---- Integrate the planar body --------------------------------------
    const dragForce = 0.5 * 1.225 * (spec.dragArea + (dmg ? dmg.dragAdd : 0)) * planarSpeed * planarSpeed;
    const rollingForce = rollRes * totalLoad * (1 + rough * 0.6);

    const aLong = (netLong - Math.sign(vLong || 1) * (dragForce + rollingForce)) / spec.mass + slopeAccelLong;
    const aLat = (Fy_front + Fy_rear) / spec.mass + slopeAccelLat;

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

    // A RIGHTWARD force on the front axle yaws the car clockwise seen from
    // above, and yaw grows counter-clockwise here — hence the leading minus.
    // Textbook bicycle models write `a*Fyf - b*Fyr` because their lateral axis
    // points LEFT; this one points right, and dropping that distinction is what
    // made full right lock steer the car left.
    const yawMoment = -(Fy_front * hb - Fy_rear * hb) + stabilityMoment;
    car.yawRate += (yawMoment / Izz) * dt;
    // Light structural damping only. Real yaw damping comes from the rear tyre
    // building slip angle as the car rotates, which the model now produces on
    // its own; a large artificial term here would just mask the tyres.
    car.yawRate *= Math.exp(-0.35 * dt);
    car.yawRate = clamp(car.yawRate, -3.2, 3.2);
    car.yaw += car.yawRate * dt;

    car.lonG = aLong / G;
    car.latG = aLat / G;

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

    if (damage) {
      for (let i = 0; i < 4; i++) wheelSurf[i] = car.wheels[i].surface;
      damage.abrade(dt, wheelSurf, planarSpeed, car.slipping);
      damage.step(dt, clamp(Math.abs(throttle) * 0.7 + Math.abs(car.lonG) * 0.5, 0, 1.4), planarSpeed);
    }

    finishTelemetry(dt, vLong, vLat, frontSlip, rearSlip);

    // Per-wheel readouts for the renderer and HUD.
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      w.load = loads[i];
      w.slipAngle = i < 2 ? frontSlip : rearSlip;
      w.comp = clamp((car.height - spec.rideHeight) * -1 + (i < 2 ? dive : -dive), -0.12, 0.12);
      w.spin += (vLong / spec.wheelRadius) * dt;
    }
  }

  function finishTelemetry(dt, vLong, vLat, frontSlip, rearSlip) {
    car.speed = Math.hypot(car.vx, car.vz);
    const slipMag = Math.max(Math.abs(frontSlip), Math.abs(rearSlip));
    car.slipping = clamp((slipMag - 0.14) / 0.30, 0, 1);
    car.vLong = vLong; car.vLat = vLat;
  }

  car.damage = damage;
  car.reset = reset;
  car.step = step;
  car.forward = () => ({ x: forwardX(), y: 0, z: forwardZ() });
  car.right = () => ({ x: rightX(), y: 0, z: rightZ() });
  return car;
}
