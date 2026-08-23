// Proves buildings are solid and that hitting one can never make you faster.
//
// The previous project shipped a collision response that computed its
// restitution impulse from the already-corrected velocity, so grinding along a
// barrier ACCELERATED the car — the wall became a rail gun. That is the single
// assertion this file exists to make, and it is checked over thousands of
// impacts from every angle rather than the one case someone happened to try.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createCollision } from '../src/physics/collision.js';
import { specFor } from '../src/vehicles/catalog.js';

const w = buildWorld();
const g = createGround(w);
w.buildLots(g);
const col = createCollision(w, { ground: g });
const dt = 1 / 120;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) fail++;
};

console.log(`${col.count} buildings, ${w.lots.length} lots\n`);

// ---- 1. A collision may only ever REMOVE energy -------------------------
{
  let worstGain = 0, gains = 0, impacts = 0, worstAt = null;
  const car = createVehicle({ ground: g, spec: specFor('kaze') });

  for (let trial = 0; trial < 4000; trial++) {
    const lot = w.lots[(Math.random() * w.lots.length) | 0];
    // Start just outside the building, aimed into it from a random angle so
    // glancing blows and square-on hits are both covered.
    const a = Math.random() * Math.PI * 2;
    const r = Math.max(lot.w, lot.d) * 0.5 + 3.5;
    const speed = 2 + Math.random() * 40;
    car.reset(lot.x + Math.cos(a) * r, lot.z + Math.sin(a) * r, Math.atan2(-Math.cos(a) * -1, -Math.sin(a) * -1));
    car.vx = -Math.cos(a) * speed;
    car.vz = -Math.sin(a) * speed;
    car.yaw = Math.atan2(-car.vx, -car.vz);

    for (let i = 0; i < 40; i++) {
      const before = Math.hypot(car.vx, car.vz);
      car.step(dt);
      const afterStep = Math.hypot(car.vx, car.vz);
      const hit = col.resolve(car, dt);
      const after = Math.hypot(car.vx, car.vz);
      if (hit.hit) {
        impacts++;
        // Compare against the speed going INTO resolve(), so the engine's own
        // acceleration during the step is not mistaken for a collision gain.
        const gain = after - afterStep;
        if (gain > 0.02) {
          gains++;
          if (gain > worstGain) { worstGain = gain; worstAt = `${before.toFixed(1)} -> ${after.toFixed(1)} m/s`; }
        }
      }
    }
  }
  check('a collision never increases speed', gains === 0,
    `${impacts} impacts, ${gains} added energy${worstGain ? `, worst +${worstGain.toFixed(2)} m/s (${worstAt})` : ''}`);
}

// ---- 2. Buildings are actually solid ------------------------------------
{
  let through = 0, trials = 0;
  const car = createVehicle({ ground: g, spec: specFor('haulier') });   // the heaviest
  for (let trial = 0; trial < 700; trial++) {
    const lot = w.lots[(Math.random() * w.lots.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const r = Math.max(lot.w, lot.d) * 0.5 + 14;
    car.reset(lot.x + Math.cos(a) * r, lot.z + Math.sin(a) * r, 0);
    car.yaw = Math.atan2(-(-Math.cos(a)), -(-Math.sin(a)));
    const speed = 28;
    car.vx = -Math.cos(a) * speed;
    car.vz = -Math.sin(a) * speed;
    trials++;
    let stuck = 0;
    for (let i = 0; i < 240; i++) {
      car.input.throttle = 0.6;
      car.step(dt);
      col.resolve(car, dt);
      // A frame or two of overlap during a violent impact is invisible and
      // resolves itself. Staying inside is the actual defect.
      stuck = col.insideBuilding(car.x, car.z, -0.4) ? stuck + 1 : 0;
      if (stuck > 150) { through++; break; }   // 1.25 s, past the recovery window
    }
  }
  check('the car never gets stuck inside a building', through === 0,
    `${through}/${trials} runs left the car stuck inside a wall`);
}

// ---- 3. Nothing diverges -------------------------------------------------
{
  let bad = 0, maxYaw = 0, maxSpeed = 0;
  const car = createVehicle({ ground: g, spec: specFor('corsara') });
  for (let trial = 0; trial < 200; trial++) {
    const lot = w.lots[(Math.random() * w.lots.length) | 0];
    car.reset(lot.x + 12, lot.z + 12, Math.random() * 6.283);
    for (let i = 0; i < 900; i++) {
      car.input.throttle = 1;
      car.input.steer = Math.sin(i * 0.03) * 0.9;
      car.step(dt);
      col.resolve(car, dt);
      if (!Number.isFinite(car.x) || !Number.isFinite(car.z) || !Number.isFinite(car.yaw)) { bad++; break; }
      maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
      maxSpeed = Math.max(maxSpeed, car.speed);
    }
  }
  check('driving into the city does not diverge', bad === 0 && maxSpeed < 130,
    `${bad} diverged, peak yaw ${maxYaw.toFixed(2)} rad/s, peak speed ${(maxSpeed * 3.6).toFixed(0)} km/h`);
}

// ---- 4. Roads stay clear -------------------------------------------------
{
  let blocked = 0, tested = 0;
  for (const e of w.edges) {
    for (let s = 0; s < e.length; s += 11) {
      const t = s / Math.max(1e-3, e.length);
      const k = Math.min(e.pts.length - 1, Math.floor(t * (e.pts.length - 1)));
      tested++;
      if (col.insideBuilding(e.pts[k].x, e.pts[k].z, 0)) blocked++;
    }
  }
  check('no building sits on a road', blocked / tested < 0.002,
    `${blocked}/${tested} road samples inside a building`);
}

console.log(fail === 0 ? '\nAll collision checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
