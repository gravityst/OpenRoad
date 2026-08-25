// Proves cars are solid against each other, and that hitting one costs both.
//
// Traffic was intangible: you drove straight through it. That is worse than a
// missing texture, because the one thing sharing the road with you turns out
// not to be there. These checks assert it is there now, that the impact hurts
// both cars, and — the rule this whole project runs on — that no collision
// ever hands out energy.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createCarCollision } from '../src/physics/collision.js';
import { createDamage } from '../src/physics/damage.js';
import { specFor } from '../src/vehicles/catalog.js';
import { mulberry } from '../src/world/noise.js';

const FLAT = {
  sample(x, z, out) {
    const r = out || {};
    r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
    r.surface = 'asphalt'; r.grip = 1; r.roughness = 0.03; r.rolling = 0.014; r.dust = 0;
    return r;
  },
};
const dt = 1 / 120;
const rnd = mulberry(4242);
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) fail++;
};

const npc = (x, z, yaw, speed) => ({
  x, y: 0, z, yaw, speed, active: true, halfLen: 2.2,
  spec: { track: 1.6, wheelbase: 2.6, mass: 1400 },
});

// ---- 1. You cannot drive through a car -----------------------------------
{
  let through = 0, trials = 0, contacts = 0;
  for (let t = 0; t < 400; t++) {
    const cc = createCarCollision();
    const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
    car.reset(0, 0, 0);
    const speed = 6 + rnd() * 34;
    car.vz = -speed;
    // A car parked squarely in the way, at a random angle.
    const other = npc(0, -30, rnd() * Math.PI * 2, 0);
    const cars = [other];
    trials++;
    let passed = false;
    for (let i = 0; i < 480; i++) {
      car.step(dt);
      const r = cc.resolve(car, cars, dt, null);
      if (r.hit) contacts++;
      // Did the player end up beyond the obstacle while it is still there?
      if (car.z < other.z - 3.2 && Math.abs(car.x - other.x) < 2.2) { passed = true; break; }
    }
    if (passed) through++;
  }
  check('you cannot drive through a car', through === 0,
    `${through}/${trials} runs passed through, ${contacts} contacts recorded`);
}

// ---- 2. A collision never adds energy ------------------------------------
{
  let gains = 0, impacts = 0, worst = 0;
  for (let t = 0; t < 600; t++) {
    const cc = createCarCollision();
    const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
    car.reset(0, 0, 0);
    const a = rnd() * Math.PI * 2, sp = 3 + rnd() * 38;
    car.vx = Math.cos(a) * sp; car.vz = Math.sin(a) * sp;
    car.yaw = Math.atan2(-car.vx, -car.vz);
    const other = npc(Math.cos(a) * 14, Math.sin(a) * 14, rnd() * 6.283, rnd() * 20);
    for (let i = 0; i < 200; i++) {
      car.step(dt);
      const before = Math.hypot(car.vx, car.vz);
      const otherBefore = other.speed;
      const knockBefore = Math.hypot(other.kvx || 0, other.kvz || 0);
      const r = cc.resolve(car, [other], dt, null);
      if (!r.hit) continue;
      impacts++;
      const after = Math.hypot(car.vx, car.vz);
      // KINETIC ENERGY, not the sum of speeds.
      //
      // The sum of speeds is not conserved even by a perfectly valid inelastic
      // collision — a fast car hitting a stationary one can leave both moving
      // at rates that add to more than it arrived with, while the energy has
      // plainly gone down. Measuring that instead flagged half of all impacts
      // as violations when the physics was correct. Energy is the invariant
      // this project actually claims, so energy is what gets measured.
      const mA = car.spec.mass, mB = other.spec.mass;
      const knockAfter = Math.hypot(other.kvx || 0, other.kvz || 0);
      const keBefore = 0.5 * mA * before * before + 0.5 * mB * (otherBefore * otherBefore + knockBefore * knockBefore);
      const keAfter = 0.5 * mA * after * after + 0.5 * mB * (other.speed * other.speed + knockAfter * knockAfter);
      const gain = keAfter - keBefore;
      if (gain > 1) { gains++; worst = Math.max(worst, gain); }
    }
  }
  check('a car-to-car impact never adds energy', gains === 0,
    `${impacts} impacts, ${gains} added energy${worst ? `, worst +${(worst / 1000).toFixed(1)} kJ` : ''}`);
}

// ---- 3. Both cars take damage --------------------------------------------
{
  const cc = createCarCollision();
  const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
  car.reset(0, 0, 0);
  car.vz = -26;
  const other = npc(0, -34, 0, 0);
  other.damage = createDamage(other.spec);
  let hits = 0;
  for (let i = 0; i < 300; i++) {
    car.step(dt);
    cc.resolve(car, [other], dt, (o, sev, lx, lz, closing) => {
      hits++;
      o.damage.impact(sev, lx, lz, 0.8, 2.2, closing);
    });
  }
  check('the car you hit takes damage too', hits > 0 && other.damage.integrity < 0.97 && car.damage.integrity < 0.97,
    `player ${(car.damage.integrity * 100).toFixed(0)}% intact, the other car ${(other.damage.integrity * 100).toFixed(0)}%, ${hits} contacts`);
}

// ---- 4. It hurts more the faster you hit ---------------------------------
{
  const run = (speed) => {
    const cc = createCarCollision();
    const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
    car.reset(0, 0, 0);
    car.vz = -speed;
    const other = npc(0, -40, 0, 0);
    other.damage = createDamage(other.spec);
    for (let i = 0; i < 400; i++) {
      car.step(dt);
      cc.resolve(car, [other], dt, (o, sev, lx, lz, c) => o.damage.impact(sev, lx, lz, 0.8, 2.2, c));
    }
    return { me: car.damage.integrity, them: other.damage.integrity };
  };
  const slow = run(7), fast = run(34);
  check('a faster impact does more damage', fast.me < slow.me && fast.them < slow.them,
    `at 25 km/h: ${(slow.me * 100).toFixed(0)}%/${(slow.them * 100).toFixed(0)}%, ` +
    `at 122 km/h: ${(fast.me * 100).toFixed(0)}%/${(fast.them * 100).toFixed(0)}%`);
}

// ---- 5. A crowd does not explode ------------------------------------------
{
  const cc = createCarCollision();
  const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
  car.reset(0, 0, 0);
  const jam = [];
  for (let i = 0; i < 12; i++) jam.push(npc((i % 4) * 2.4 - 3.6, -6 - ((i / 4) | 0) * 5, 0, 0));
  let bad = 0, maxSpeed = 0;
  for (let i = 0; i < 1800; i++) {
    car.input.throttle = 0.6;
    car.step(dt);
    cc.resolve(car, jam, dt, null);
    if (!Number.isFinite(car.x) || !Number.isFinite(car.z)) { bad++; break; }
    maxSpeed = Math.max(maxSpeed, car.speed);
    for (const o of jam) if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) { bad++; break; }
  }
  check('shoving into a queue stays stable', bad === 0 && maxSpeed < 60,
    `${bad} diverged, peak player speed ${(maxSpeed * 3.6).toFixed(0)} km/h through 12 stationary cars`);
}

// ---- 6. Cost ---------------------------------------------------------------
{
  const cc = createCarCollision();
  const car = createVehicle({ ground: FLAT, spec: specFor('kaze') });
  car.reset(0, 0, 0);
  const cars = [];
  for (let i = 0; i < 70; i++) cars.push(npc((rnd() * 2 - 1) * 300, (rnd() * 2 - 1) * 300, rnd() * 6.283, 20));
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) cc.resolve(car, cars, dt, null);
  const us = (performance.now() - t0) / 20000 * 1000;
  check('resolve() is cheap enough for 120 Hz', us < 20,
    `${us.toFixed(2)} us per step against 70 cars`);
}

console.log(fail === 0 ? '\nAll car-crash checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
