// Proves a crash is a harmless bump.
//
// The kids who play this said they hate the burning and the damage, so it is
// switched off: DAMAGE in physics/damage.js. With it off a crash is meant to be
// exactly as SOLID as before — nothing passes through anything — and exactly as
// HARMLESS as a bump: nothing burns, explodes, dents or falls off, and no car
// loses any power, grip, brakes or steering to it. Traffic you hit is shoved,
// and then drives on.
//
// The damage modules themselves are untouched and are still tested, working, by
// damagecheck, carcrashcheck, debrischeck and carscheck. This one holds the GAME
// to the switch. The last check reads main.js, because five branches are being
// merged into it at once and a dropped hunk would bring the fire back with every
// other harness still green.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAMAGE } from '../src/physics/damage.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createCollision, createCarCollision } from '../src/physics/collision.js';
import { CARS, specFor } from '../src/vehicles/catalog.js';
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createTraffic } from '../src/ai/traffic.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) fail++;
};

// ---- 1. The switch --------------------------------------------------------
check('DAMAGE is off', DAMAGE === false,
  DAMAGE === false ? 'physics/damage.js: crashes are bumps'
    : 'physics/damage.js has DAMAGE on — the owner asked for no burning or damage (round two)');

// The player's car exactly as main.js builds it.
const playerCar = (id, ground = FLAT) =>
  createVehicle({ ground, spec: specFor(id, 0), isPlayer: true, damage: DAMAGE });

// ---- 2. A 60 m/s head-on into a wall costs the car nothing ----------------
//
// One warehouse, 30 m wide, its face 40 m ahead. Every car in the catalogue
// hits it square at 60 m/s. Then the car is parked WITHOUT reset() — reset()
// repairs a damage model, and would hide exactly what this is looking for — and
// driven through the same four tests as an identical car that never crashed:
// a 3 s pull from rest, a 1.5 s stop from there, and 1.5 s of full lock at
// 18 m/s. Anything a crash took away shows up as a difference.
const WALL = { lots: [{ x: 0, z: -55, w: 30, d: 30, rot: 0, height: 8, y: 0 }] };
const FACE = -55 + 15 * 0.94;          // collision.js shrinks a lot to 94%

function park(car) {
  car.x = 0; car.z = 400; car.yaw = 0;
  car.vx = 0; car.vz = 0; car.vy = 0; car.yawRate = 0;
  car.input.throttle = 0; car.input.brake = 1; car.input.steer = 0; car.input.handbrake = 0;
  for (let i = 0; i < 240; i++) car.step(dt);          // 2 s to settle
}

function capability(car) {
  park(car);
  car.input.brake = 0; car.input.throttle = 1;
  for (let i = 0; i < 360; i++) car.step(dt);
  const pull = car.speed;
  car.input.throttle = 0; car.input.brake = 1;
  for (let i = 0; i < 180; i++) car.step(dt);
  const stop = pull - car.speed;
  park(car);
  car.vz = -18; car.input.brake = 0; car.input.throttle = 0.4; car.input.steer = 1;
  let lat = 0;
  for (let i = 0; i < 180; i++) { car.step(dt); lat = Math.max(lat, Math.abs(car.latG)); }
  return { pull, stop, lat, yaw: car.yaw };
}

function crash(car) {
  const coll = createCollision(WALL);
  car.reset(0, 0, 0);
  car.vz = -60;
  let worst = 0, inside = 0, noseMin = Infinity;
  for (let i = 0; i < 480; i++) {
    car.input.throttle = i < 60 ? 1 : 0;
    car.input.brake = i < 60 ? 0 : 1;
    car.step(dt);
    const hit = coll.resolve(car, dt);
    if (hit.hit) worst = Math.max(worst, hit.severity);
    if (coll.insideBuilding(car.x, car.z)) inside++;
    noseMin = Math.min(noseMin, car.z);
  }
  return { worst, inside, noseMin };
}

{
  let losses = 0, worstLoss = 0, worstCar = '', hardest = 1, through = 0, models = 0;
  for (const c of CARS) {
    const twin = playerCar(c.id);
    const base = capability(twin);
    const car = playerCar(c.id);
    if (car.damage) models++;
    const hit = crash(car);
    hardest = Math.min(hardest, hit.worst);
    if (hit.inside > 0 || hit.noseMin < FACE - 1) through++;
    const after = capability(car);
    const loss = Math.max(
      (base.pull - after.pull) / base.pull,
      (base.stop - after.stop) / base.stop,
      (base.lat - after.lat) / base.lat,
      Math.abs(base.yaw - after.yaw) / Math.max(0.1, Math.abs(base.yaw)));
    if (loss > 0.002) losses++;
    if (loss > worstLoss) { worstLoss = loss; worstCar = c.id; }
  }
  check('the player\'s car carries no damage model', models === 0,
    `${models}/${CARS.length} cars built with one`);
  check('a 60 m/s head-on into a wall stays solid', through === 0 && hardest >= 0.99,
    `${through}/${CARS.length} ended up inside the building; every impact at severity ${hardest.toFixed(2)} or more`);
  check('and takes nothing away from any car', losses === 0,
    `${losses}/${CARS.length} lost pull, braking, grip or steering; ` +
    `worst difference ${(worstLoss * 100).toFixed(3)}%${worstCar ? ` (${worstCar})` : ''}`);
}

// ---- 3. The same test can see damage --------------------------------------
// A check that cannot fail proves nothing. The identical crash with a damage
// model fitted must show up in the same four numbers.
{
  const twin = createVehicle({ ground: FLAT, spec: specFor(CARS[0].id, 0) });
  const base = capability(twin);
  const car = createVehicle({ ground: FLAT, spec: specFor(CARS[0].id, 0) });
  crash(car);
  const after = capability(car);
  const loss = (base.pull - after.pull) / base.pull;
  check('with a damage model the same crash is caught', loss > 0.2,
    `${CARS[0].id}: 3 s pull ${base.pull.toFixed(2)} -> ${after.pull.toFixed(2)} m/s, ` +
    `integrity ${car.damage.integrity.toFixed(2)}`);
}

// ---- 4. Traffic you hit drives on -----------------------------------------
//
// A real road, real traffic, and a 60 m/s head-on into a moving car. main.js
// hands the collision a callback that returns at once with DAMAGE off, so
// null here is the same thing. The knock is consumed the way main.js consumes
// it (stepFrame, "Consume the shove"), and the player then pulls over, because
// traffic rightly queues behind a car stopped in its lane.
{
  const world = buildWorld();
  const ground = createGround(world);
  const traffic = createTraffic(world, ground, { density: 40 });
  const hits = createCarCollision();
  const px0 = 0, pz0 = -1250;
  for (let i = 0; i < 60 * 6; i++) traffic.update(1 / 60, px0, pz0, 0, 0);

  const road = {};
  let t = null;
  for (const c of traffic.cars) {
    if (!c.active || c.speed < 8) continue;
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    let clear = true;
    for (let r = 4; r <= 40 && clear; r += 4) {
      if (!ground.roadAt(c.x + fx * r, c.z + fz * r, road).onRoad) clear = false;
      for (const o of traffic.cars) {
        if (o !== c && o.active && Math.hypot(o.x - c.x - fx * r, o.z - c.z - fz * r) < 5) clear = false;
      }
    }
    if (clear) { t = c; break; }
  }
  if (!t) {
    check('a struck traffic car drives on', false, 'no moving traffic car with clear road ahead to hit');
  } else {
    const car = playerCar(CARS[0].id, ground);
    const fx = -Math.sin(t.yaw), fz = -Math.cos(t.yaw);
    car.reset(t.x + fx * 14, t.z + fz * 14, t.yaw + Math.PI);
    car.vx = fx * -60; car.vz = fz * -60;
    const vBefore = t.speed, respawn = t.respawnId;
    let closing = 0, contact = -1, tick = 0;
    const trace = [];
    for (let frame = 0; frame < 60 * 12; frame++) {
      const d = 1 / 60;
      // Throttle into it, then brakes; at 1 s pull 9 m aside, out of its lane.
      car.input.throttle = contact < 0 ? 1 : 0;
      car.input.brake = contact < 0 ? 0 : 1;
      if (contact >= 0 && frame === contact + 60) {
        const rx = Math.cos(t.yaw), rz = -Math.sin(t.yaw);
        car.reset(car.x - rx * 9, car.z - rz * 9, car.yaw);
      }
      for (let s = 0; s < 2; s++) {
        car.step(dt);
        const b = hits.resolve(car, traffic.cars, dt, null);
        if (b.hit && b.other === t && contact < 0) { contact = frame; closing = b.closing; }
      }
      for (const o of traffic.cars) {
        if (!o || !o.kvx) continue;
        o.x += o.kvx * d; o.z += o.kvz * d;
        const decay = Math.exp(-2.6 * d);
        o.kvx *= decay; o.kvz *= decay;
        if (Math.abs(o.kvx) + Math.abs(o.kvz) < 0.02) { o.kvx = 0; o.kvz = 0; }
      }
      traffic.update(d, car.x, car.z, car.speed, car.yaw);
      if (contact >= 0 && (frame - contact) % 60 === 0) trace.push(t.speed.toFixed(1));
      tick = frame;
    }
    const same = t.active && t.respawnId === respawn;
    check('a 60 m/s head-on into traffic makes contact', contact >= 0 && closing > 55,
      contact >= 0 ? `closing at ${closing.toFixed(1)} m/s` : `no contact in ${tick + 1} frames`);
    check('the car you hit is not damaged, capped or alight',
      !t.damage && t.speedCap === undefined && !t.wrecked && !t.written && !(t.burning > 0),
      `damage model ${t.damage ? 'yes' : 'none'}, speedCap ${t.speedCap}, ` +
      `wrecked ${!!t.wrecked}, burning ${t.burning || 0}`);
    check('and it drives on', same && t.speed > vBefore * 0.6,
      `${same ? 'same car' : 'recycled'}, ${vBefore.toFixed(1)} m/s before; each second after: ${trace.join(' ')}`);
  }
}

// ---- 5. The wiring holds --------------------------------------------------
//
// Read main.js for the four places the switch has to reach. If a merge drops
// one of these, the fire comes back and nothing else here would notice.
{
  const main = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
  const imports = /import\s*\{[^}]*\bDAMAGE\b[^}]*\}\s*from\s*'\.\/physics\/damage\.js'/.test(main);
  const vehicle = /createVehicle\(\{[^\n]*\bisPlayer:\s*true[^\n]*\bdamage:\s*DAMAGE\b/.test(main);
  const LAYERS = ['render/carDamage.js', 'physics/debris.js', 'render/damageFx.js',
    'render/explosion.js', 'game/wreck.js'];
  const ungated = LAYERS.filter((p) => {
    const at = main.indexOf(`layer('./${p}'`);
    return at < 0 || !/DAMAGE\s*\?\s*$/.test(main.slice(Math.max(0, at - 40), at));
  });
  const gatedFn = (name) => new RegExp(
    `function ${name}\\([^)]*\\)\\s*\\{(?:\\s*//[^\\n]*)*\\s*if \\(!DAMAGE\\) return;`).test(main);
  check('main.js reads the switch', imports && vehicle,
    `${imports ? 'imports DAMAGE' : 'does NOT import DAMAGE'}; ` +
    `${vehicle ? 'player car built with damage: DAMAGE' : 'player car NOT built with damage: DAMAGE'}`);
  check('the damage layers load only with DAMAGE on', ungated.length === 0,
    ungated.length ? `not gated: ${ungated.join(', ')}` : `${LAYERS.length} layers behind DAMAGE ?`);
  check('explode() and onTrafficHit() stand down', gatedFn('explode') && gatedFn('onTrafficHit'),
    `explode ${gatedFn('explode') ? 'gated' : 'NOT gated'}, onTrafficHit ${gatedFn('onTrafficHit') ? 'gated' : 'NOT gated'}`);

  // Nothing else may load them behind main.js's back.
  const offenders = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js') || p.endsWith('main.js')) continue;
      const src = readFileSync(p, 'utf8');
      for (const l of LAYERS) {
        const base = l.split('/')[1].replace('.', '\\.');
        if (new RegExp(`(import[^'"]*|import\\()\\s*['"][^'"]*${base}['"]`).test(src)) {
          offenders.push(`${relative(ROOT, p)} -> ${l}`);
        }
      }
    }
  };
  walk(join(ROOT, 'src'));
  check('nothing else imports them', offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'only main.js, and only behind the switch');
}

console.log(fail === 0 ? '\nAll calm checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
