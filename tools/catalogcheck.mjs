// Measures every car in the catalogue.
//
// The garage quotes performance figures at the player, and a figure that is not
// the one you get when you press the throttle is a lie in a nice font. This
// runs the real physics on flat dry asphalt, so the numbers mean something, and
// asserts both that each car is physically sane and that the CLASSES actually
// mean something — otherwise the garage is decoration.
import { CARS, CLASSES, specFor } from '../src/vehicles/catalog.js';
import { createVehicle } from '../src/physics/vehicle.js';

const FLAT = {
  sample(x, z, out) {
    const r = out || {};
    r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
    r.surface = 'asphalt'; r.grip = 1; r.roughness = 0.03; r.rolling = 0.014; r.dust = 0;
    return r;
  },
};
const dt = 1 / 120;
let fail = 0;
const check = (ok, msg) => { if (!ok) { console.log('  FAIL  ' + msg); fail++; } };

function measure(spec) {
  let car = createVehicle({ ground: FLAT, spec });
  car.reset(0, 0, 0);
  let t = 0, t100 = -1;
  while (t < 60) {
    car.input.throttle = 1; car.step(dt); t += dt;
    if (t100 < 0 && car.speed * 3.6 >= 100) t100 = t;
  }
  const vmax = car.speed * 3.6;

  car = createVehicle({ ground: FLAT, spec });
  car.reset(0, 0, 0); car.vz = -100 / 3.6;
  const x0 = car.x, z0 = car.z;
  t = 0;
  while (Math.hypot(car.vx, car.vz) > 0.6 && t < 20) { car.input.brake = 1; car.step(dt); t += dt; }
  const brake = Math.hypot(car.x - x0, car.z - z0);

  car = createVehicle({ ground: FLAT, spec });
  car.reset(0, 0, 0); car.vz = -25;
  let lat = 0;
  for (let i = 0; i < 120 * 5; i++) {
    car.input.throttle = 0.35; car.input.steer = 0.8; car.step(dt);
    lat = Math.max(lat, Math.abs(car.latG));
  }
  return { t100, vmax, brake, lat };
}

console.log('car'.padEnd(23) + 'class'.padEnd(10) + 'drive  0-100     top    100-0     lat');
console.log('-'.repeat(76));
const r = {};
for (const c of CARS) {
  const m = measure(specFor(c.id));
  r[c.id] = m;
  console.log(
    `${c.brand} ${c.model}`.padEnd(23) +
    CLASSES[c.class].name.padEnd(10) +
    c.spec.drive.toUpperCase().padEnd(6) +
    (m.t100 < 0 ? '  --' : m.t100.toFixed(1) + 's').padStart(6) +
    (m.vmax.toFixed(0) + ' km/h').padStart(11) +
    (m.brake.toFixed(0) + ' m').padStart(8) +
    (m.lat.toFixed(2) + ' g').padStart(8));
}
console.log();

for (const c of CARS) {
  const m = r[c.id], n = `${c.brand} ${c.model}`;
  check(m.t100 > 0 && m.t100 < 16, `${n}: 0-100 is ${m.t100.toFixed(1)}s`);
  check(m.vmax > 140 && m.vmax < 360, `${n}: top speed ${m.vmax.toFixed(0)} km/h`);
  check(m.brake > 24 && m.brake < 50, `${n}: 100-0 in ${m.brake.toFixed(0)} m`);
  check(m.lat > 0.80 && m.lat < 1.30, `${n}: ${m.lat.toFixed(2)} g cornering`);
}

check(r.corsara.t100 < r.v340.t100, 'the supercar should out-accelerate the saloon');
check(r.arc.t100 < r.kaze.t100, 'the electric car should out-accelerate the coupe');
check(r.lark.t100 > r.kaze.t100, 'the city car should be the slower of the two');
check(r.drover.vmax < r.meridian.vmax, 'the van should not out-run the limousine');
check(r.corsara.lat > r.bastion.lat, 'the supercar should out-corner the SUV');
check(r.bastion.brake > r.corsara.brake, 'the heavy SUV should take longer to stop');
check(r.haulier.vmax < r.corsara.vmax, 'the pickup should not out-run the supercar');

const times = CARS.map((c) => r[c.id].t100);
const spread = Math.max(...times) - Math.min(...times);
check(spread > 4, `the range should feel varied: only ${spread.toFixed(1)}s between fastest and slowest`);

console.log(fail === 0 ? `All ${CARS.length} cars check out.` : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
