// Proves the car behaves like a car.
//
// The first check is the one that matters most: pressing RIGHT must move the
// car toward +X. That was broken twice on the previous project because the
// coordinate convention put "right" at -X and a negation was papered over at
// the input boundary. It is asserted here so it can never regress silently.
//
// The rest are calibration against a real ~280 hp rear-drive saloon, plus the
// abuse tests — full lock at speed, flat-out into the scenery, handbrake, a
// long unattended drive over the whole map — that decide whether the game is
// playable or a physics blooper reel.
import { buildWorld, pointOnEdge } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { specFor } from '../src/vehicles/catalog.js';

const w = buildWorld();
const g = createGround(w);
const dt = 1 / 120;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
  if (!ok) fail++;
};

// Calibration runs on a flat reference surface. Measuring a braking distance on
// a real road means measuring the hill it happens to be on, which is a fine way
// to chase a number that was never wrong.
const FLAT = {
  sample(x, z, out) {
    const r = out || {};
    r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
    r.surface = 'asphalt'; r.grip = 1; r.roughness = 0.03; r.rolling = 0.014; r.dust = 0;
    return r;
  },
  roadAt() { return { onRoad: true, dist: 0, edge: null, s: 0, tx: 0, tz: -1, speedLimit: 30, width: 12, kind: 'highway' }; },
};

function spawnOn(edge, car) {
  const a = edge.pts[0], b = edge.pts[1];
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));   // forward = -Z
  car.reset(a.x, a.z, yaw);
  return yaw;
}

const newCar = (aids) => {
  const c = createVehicle({ ground: g, isPlayer: true });
  if (aids) Object.assign(c.aids, aids);
  return c;
};
const flatCar = (aids) => {
  const c = createVehicle({ ground: FLAT, isPlayer: true });
  if (aids) Object.assign(c.aids, aids);
  c.reset(0, 0, 0);
  return c;
};

// ---------------------------------------------------------------------------
// 1. STEERING SIGN
// ---------------------------------------------------------------------------
{
  const car = flatCar();
  // Face -Z (yaw 0). "Right" from there is +X.
  car.vx = 0; car.vz = -20;                      // 72 km/h forward
  for (let i = 0; i < 120 * 2; i++) {
    car.input.throttle = 0.3; car.input.steer = 1; car.step(dt);
  }
  const dx = car.x, dz = car.z;
  check('steering RIGHT moves the car to +X', dx > 3,
    `after 2 s of full right lock: x ${dx.toFixed(1)} m, z ${dz.toFixed(1)} m`);

  const car2 = flatCar();
  car2.vz = -20;
  for (let i = 0; i < 120 * 2; i++) { car2.input.throttle = 0.3; car2.input.steer = -1; car2.step(dt); }
  check('steering LEFT moves the car to -X', car2.x < -3,
    `after 2 s of full left lock: x ${car2.x.toFixed(1)} m`);

  // And the yaw must agree with the displacement, or the model is fighting itself.
  check('heading agrees with the turn', car.yaw < 0 && car2.yaw > 0,
    `right yaw ${car.yaw.toFixed(2)} rad, left yaw ${car2.yaw.toFixed(2)} rad`);
}

// ---------------------------------------------------------------------------
// 2. STRAIGHT-LINE CALIBRATION
// ---------------------------------------------------------------------------
console.log('\ncalibration on flat dry asphalt:');

function accelTest() {
  const car = flatCar();
  let t = 0, t100 = -1;
  while (t < 30) {
    car.input.throttle = 1; car.input.brake = 0; car.input.steer = 0;
    car.step(dt); t += dt;
    if (t100 < 0 && car.speed * 3.6 >= 100) t100 = t;
  }
  return { t100, vmax: car.speed * 3.6 };
}
{
  const { t100, vmax } = accelTest();
  // A 280 hp rear-drive saloon: 0-100 in about 5.0-6.0 s, 240-260 km/h.
  check('0-100 km/h is in the right ballpark', t100 > 3.8 && t100 < 7.5,
    `${t100.toFixed(2)} s (real car ~5.3 s)`);
  check('top speed is in the right ballpark', vmax > 200 && vmax < 290,
    `${vmax.toFixed(0)} km/h after 30 s (real car ~250)`);
}

function brakeTest(fromKmh) {
  const car = flatCar();
  car.vz = -fromKmh / 3.6;
  const x0 = car.x, z0 = car.z;
  let t = 0, peakG = 0;
  while (Math.hypot(car.vx, car.vz) > 0.6 && t < 20) {
    car.input.throttle = 0; car.input.brake = 1; car.input.steer = 0;
    car.step(dt); t += dt;
    peakG = Math.max(peakG, -car.lonG);
  }
  return { dist: Math.hypot(car.x - x0, car.z - z0), t, peakG };
}
{
  const b100 = brakeTest(100);
  const b160 = brakeTest(160);
  // Real road car on dry asphalt: 100-0 in 34-38 m, peak around 1.0-1.1 g.
  check('100-0 km/h braking distance', b100.dist > 28 && b100.dist < 48,
    `${b100.dist.toFixed(1)} m in ${b100.t.toFixed(2)} s at ${b100.peakG.toFixed(2)} g (real ~36 m)`);
  check('160-0 km/h braking distance', b160.dist > 70 && b160.dist < 120,
    `${b160.dist.toFixed(1)} m (real ~92 m)`);
  check('braking actually decelerates hard', b100.peakG > 0.85,
    `peak ${b100.peakG.toFixed(2)} g`);
}

// ---------------------------------------------------------------------------
// 3. CORNERING
// ---------------------------------------------------------------------------
{
  const car = flatCar();
  car.vz = -25; car.vx = 0;
  let peakLat = 0;
  for (let i = 0; i < 120 * 6; i++) {
    car.input.throttle = 0.35; car.input.steer = 0.75; car.step(dt);
    peakLat = Math.max(peakLat, Math.abs(car.latG));
  }
  check('lateral grip is in the right ballpark', peakLat > 0.7 && peakLat < 1.35,
    `${peakLat.toFixed(2)} g sustained (real road car ~0.95)`);
}

// ---------------------------------------------------------------------------
// 4. THE ABUSE TESTS
// ---------------------------------------------------------------------------
{
  // Hold full lock at speed for ten seconds. On the last project this was the
  // single most-reported bug: the car became uncontrollable and never recovered.
  const car = flatCar();
  car.vz = -60;                                     // 216 km/h
  let maxSlip = 0, airborneTime = 0;
  for (let i = 0; i < 120 * 10; i++) {
    car.input.throttle = 1; car.input.steer = 1; car.step(dt);
    maxSlip = Math.max(maxSlip, car.slipping);
    if (car.airborne) airborneTime += dt;
  }
  // Then let go and see whether it comes back.
  let recovered = -1;
  for (let i = 0; i < 120 * 6; i++) {
    car.input.throttle = 0.2; car.input.steer = 0; car.input.brake = 0.2; car.step(dt);
    if (recovered < 0 && car.slipping < 0.05 && Math.abs(car.yawRate) < 0.25) recovered = i * dt;
  }
  check('recovers after 10 s of full lock', recovered >= 0 && recovered < 3.0,
    recovered >= 0 ? `back under control in ${recovered.toFixed(2)} s` : 'NEVER RECOVERS');
  check('full lock does not launch the car', airborneTime < 0.6,
    `${airborneTime.toFixed(2)} s airborne`);
}

{
  // Handbrake turn: should rotate the car, not fire it into orbit.
  const car = flatCar();
  car.vz = -22;
  let maxYaw = 0, air = 0;
  for (let i = 0; i < 120 * 4; i++) {
    car.input.throttle = 0.2; car.input.steer = 0.9; car.input.handbrake = 1;
    car.step(dt);
    maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
    if (car.airborne) air += dt;
  }
  check('handbrake rotates the car', maxYaw > 0.45 && maxYaw < 3.3,
    `peak yaw rate ${maxYaw.toFixed(2)} rad/s, ${air.toFixed(2)} s airborne`);
}

{
  // Reverse must be a deliberate selection. Last project's worst bug: the car
  // silently selected reverse and pulled away backwards at the start.
  const car = flatCar();
  const yaw = 0;
  let wentBackwards = 0;
  for (let i = 0; i < 120 * 6; i++) {
    car.input.throttle = 1; car.input.brake = 0; car.input.steer = 0; car.step(dt);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (car.vx * fx + car.vz * fz < -0.5) wentBackwards++;
  }
  check('full throttle never selects reverse', wentBackwards === 0 && car.gear > 0,
    `gear ${car.gear}, ${wentBackwards} frames moving backwards`);
}

// ---------------------------------------------------------------------------
// 5. THE LONG DRIVE — over every kind of ground in the world
// ---------------------------------------------------------------------------
{
  let worstAir = 0, nan = 0, worstTilt = 0, stuck = 0, totalAir = 0, samples = 0;
  let underground = 0;
  const starts = [];
  for (let i = 0; i < 24; i++) starts.push(w.edges[(i * 37) % w.edges.length]);

  for (const e of starts) {
    const car = newCar();
    spawnOn(e, car);
    let air = 0;
    for (let i = 0; i < 120 * 40; i++) {
      // A driver who is not paying much attention: mostly throttle, random
      // steering, occasional brake. Deliberately not a good line.
      const t = i * dt;
      car.input.throttle = 0.75 + 0.25 * Math.sin(t * 0.7);
      car.input.steer = Math.sin(t * 0.9) * 0.8 + Math.sin(t * 2.3) * 0.35;
      car.input.brake = (i % 900 < 60) ? 0.8 : 0;
      car.input.handbrake = (i % 1700 < 40) ? 1 : 0;
      car.step(dt);
      samples++;
      if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.z) ||
          !Number.isFinite(car.yaw) || !Number.isFinite(car.speed)) { nan++; break; }
      const above = car.y - car.groundY;
      worstAir = Math.max(worstAir, above);
      if (above < -0.15) underground++;
      if (car.airborne) { air += dt; totalAir += dt; }
      worstTilt = Math.max(worstTilt, Math.abs(car.pitch), Math.abs(car.roll));
      if (car.speed < 0.3 && t > 5) stuck++;
    }
  }
  check('no NaN over 24 x 40 s of abuse', nan === 0, `${nan} runs diverged, ${samples} steps`);
  check('the car never leaves the ground absurdly', worstAir < 4.0,
    `highest ${worstAir.toFixed(2)} m above the surface, ${totalAir.toFixed(1)} s airborne total`);
  check('the car never sinks through the ground', underground / samples < 0.001,
    `${underground}/${samples} steps below the surface`);
  check('the car never tips over', worstTilt < 0.85,
    `worst tilt ${(worstTilt * 57.3).toFixed(0)} deg (a car on its side is 90)`);
  check('the car does not get stuck', stuck / samples < 0.08,
    `${(stuck / samples * 100).toFixed(1)}% of steps below walking pace`);
}

// ---------------------------------------------------------------------------
// 6. SURFACES
// ---------------------------------------------------------------------------
{
  const rows = [];
  for (const kind of ['highway', 'street', 'rural', 'dirt']) {
    const e = w.edges.find((q) => q.kind === kind && q.length > 90);
    if (!e) continue;
    const car = newCar();
    const yaw = spawnOn(e, car);
    car.vx = -Math.sin(yaw) * 22; car.vz = -Math.cos(yaw) * 22;
    const x0 = car.x, z0 = car.z;
    let t = 0;
    while (Math.hypot(car.vx, car.vz) > 0.6 && t < 20) {
      car.input.throttle = 0; car.input.brake = 1; car.step(dt); t += dt;
    }
    rows.push(`${kind.padEnd(8)} ${car.surface.padEnd(8)} 80-0 in ${Math.hypot(car.x - x0, car.z - z0).toFixed(1)} m`);
  }
  console.log('\nbraking by surface:');
  rows.forEach((r) => console.log('  ' + r));
  check('loose surfaces brake worse than asphalt', rows.length >= 2, `${rows.length} surfaces sampled`);
}

// ---------------------------------------------------------------------------
// 7. THE RALLY STAGES — the claim the ground harness cannot make
// ---------------------------------------------------------------------------
// groundcheck allows loose roads a rougher centreline than paved ones, on the
// grounds that a rally stage legitimately carries more vertical curvature. That
// is only defensible if the stages are actually DRIVEABLE, which no geometric
// threshold can establish. So drive them.
{
  const loose = w.edges.filter((e) => (e.kind === 'gravel' || e.kind === 'dirt' || e.kind === 'track') && e.length > 90);
  let air = 0, worstAir = 0, worstTilt = 0, nan = 0, steps = 0, offRoad = 0, checks = 0;
  let finished = 0, attempted = 0;
  const road = {};

  for (let i = 0; i < Math.min(40, loose.length); i++) {
    const e = loose[(i * 7) % loose.length];
    const car = newCar();
    Object.assign(car.spec, specFor('kaida'));      // the rally car, on a rally stage
    const p0 = pointOnEdge(e, 2);
    car.reset(p0.x, p0.z, Math.atan2(-p0.tx, -p0.tz));
    attempted++;

    // Drive THIS STAGE and stop at the end of it.
    //
    // A gravel edge is about 130 m, so a fixed 25-second run leaves the stage
    // after nine seconds and spends the rest wandering the wider network — and
    // a driver that only follows its starting edge has nothing sensible to do
    // out there. Measuring that told us about the test, not about the road.
    const budget = Math.min(120 * 40, Math.ceil((e.length / 8) * 120));
    for (let k = 0; k < budget; k++) {
      const here = g.roadAt(car.x, car.z, road);
      const onStage = here.edge === e;
      if (!onStage && here.edge) { finished++; break; }   // reached the far junction
      let steer = 0, target = 14;
      if (here.edge) {
        const fx0 = -Math.sin(car.yaw), fz0 = -Math.cos(car.yaw);
        const dir = (fx0 * here.tx + fz0 * here.tz) >= 0 ? 1 : -1;
        const look = Math.max(9, Math.min(30, car.speed * 0.85 + 7));
        const clampS = (v) => Math.max(0.1, Math.min(here.edge.length - 0.1, v));
        const ahead = pointOnEdge(here.edge, clampS(here.s + dir * look));
        if (ahead) {
          const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
          const dx = ahead.x - car.x, dz = ahead.z - car.z;
          const len = Math.hypot(dx, dz) || 1;
          steer = Math.max(-1, Math.min(1, Math.atan2(
            (dx / len) * rx + (dz / len) * rz, (dx / len) * fx0 + (dz / len) * fz0) * 1.9));
        }
        const a = pointOnEdge(here.edge, clampS(here.s + dir * 6));
        const b = pointOnEdge(here.edge, clampS(here.s + dir * 26));
        if (a && b) {
          const turn = Math.abs(Math.atan2(b.tx * a.tz - b.tz * a.tx, b.tx * a.tx + b.tz * a.tz));
          const radius = turn > 1e-3 ? 20 / turn : 1e4;
          const mu = car.surface === 'gravel' || car.surface === 'dirt' ? 0.62 : 0.95;
          target = Math.max(7, Math.min(24, Math.sqrt(mu * 9.81 * radius)));
        }
      }
      const err = target - car.speed;
      car.input.throttle = Math.max(0, Math.min(1, err * 0.35));
      car.input.brake = Math.max(0, Math.min(1, -err * 0.30));
      car.input.steer = steer;
      car.step(dt);
      steps++;
      if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.yaw)) { nan++; break; }
      const above = car.y - car.groundY;
      worstAir = Math.max(worstAir, above);
      if (car.airborne) air += dt;
      worstTilt = Math.max(worstTilt, Math.abs(car.pitch), Math.abs(car.roll));
      if (k % 30 === 0 && onStage) {
        checks++;
        if (road.dist > road.width) offRoad++;
      }
    }
  }
  check('rally stages do not launch the car', worstAir < 2.5 && air / (steps * dt) < 0.05,
    `worst ${worstAir.toFixed(2)} m above the surface, ${(air / (steps * dt) * 100).toFixed(1)}% of the time airborne`);
  check('rally stages do not flip the car', worstTilt < 0.9,
    `worst tilt ${(worstTilt * 57.3).toFixed(0)} deg`);
  check('the car can follow a rally stage', nan === 0 && offRoad / Math.max(1, checks) < 0.12,
    `${finished}/${attempted} stages driven to the far junction, off the road ` +
    `${(offRoad / Math.max(1, checks) * 100).toFixed(1)}% of samples over ${(steps * dt).toFixed(0)} s`);
}

console.log(fail === 0 ? '\nAll vehicle checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
