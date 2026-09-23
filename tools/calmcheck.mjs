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
import { DAMAGE, createDamage } from '../src/physics/damage.js';
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

// ---- main.js's own crash code ----------------------------------------------
//
// The crash handlers live inside main.js's boot() closure, which needs a
// browser. A stand-in written here could drift from them without anyone
// noticing, so these checks lift the handlers' SOURCE out of main.js by
// matching braces and run that, closed over stubs for the renderer-side names
// it touches. Every stub counts what it was asked to do, so "nothing exploded"
// is counted, not assumed.
const MAIN = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
function lift(head) {
  const at = MAIN.indexOf(head);
  if (at < 0) return null;
  let depth = 0;
  for (let i = MAIN.indexOf('{', at); i > 0 && i < MAIN.length; i++) {
    const c = MAIN[i], n = MAIN[i + 1];
    if (c === '/' && n === '/') { i = MAIN.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = MAIN.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < MAIN.length && MAIN[i] !== c; i++) if (MAIN[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return MAIN.slice(at, i + 1);
  }
  return null;
}
function fromMain(heads, returns, scope, prelude = '') {
  const parts = heads.map(lift);
  const missing = heads.filter((h, k) => !parts[k]);
  if (missing.length) return { missing };
  const body = `'use strict';\n${prelude}\n${parts.join(';\n')}\nreturn { ${returns.join(', ')} };`;
  return new Function(...Object.keys(scope), body)(...Object.values(scope));
}

// main.js's explode() and onTrafficHit(), with DAMAGE as given. `player` is the
// car explode() reads as `car`. The damage renderer, debris and wreck layers are
// the null they are in the game with DAMAGE off; the fireball, sparks, smoke,
// wreck sequence and toast are counters.
function crashHandlers(damageOn, player) {
  const did = { fireballs: 0, sparks: 0, smoke: 0, wrecks: 0, toasts: 0 };
  const fns = fromMain(['function explode(', 'function onTrafficHit('], ['explode', 'onTrafficHit'], {
    DAMAGE: damageOn, createDamage, car: player,
    trafficRespawn: [], trafficModels: [], trafficDamage: [], npcEvents: [],
    mCarDamage: null, debris: null, carDamage: null,
    boom: { fire() { did.fireballs++; } },
    wreck: { ignite() { did.wrecks++; } },
    particles: { emitSparks() { did.sparks++; }, emitSmoke() { did.smoke++; }, emitDust() {} },
    hud: { toast() { did.toasts++; } },
  }, 'let boomCooldown = 0;');
  return { ...fns, did };
}

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
// A real road, real traffic, and a 60 m/s head-on into a moving car. The
// collision is handed main.js's own onTrafficHit(), and every contact main.js
// would blow up on (stepFrame: closing past 21 m/s, or 15 head-on) goes through
// main.js's own explode(). The knock is consumed the way main.js consumes it
// (stepFrame, "Consume the shove"), and the player then pulls over, because
// traffic rightly queues behind a car stopped in its lane.
//
// Then the very same contact is replayed through the same onTrafficHit() with
// DAMAGE on, onto a copy of the car, and must write it off: that is what makes
// "not damaged" a result rather than a foregone conclusion.
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
    const main = crashHandlers(DAMAGE, car);
    let calls = 0, booms = 0, first = null;
    const onHit = (o, sev, lx, lz, closing) => {
      calls++;
      if (o === t && !first) first = [sev, lx, lz, closing];
      main.onTrafficHit(o, sev, lx, lz, closing);
    };
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
        const b = hits.resolve(car, traffic.cars, dt, main.missing ? null : onHit);
        if (b.hit && b.other === t && contact < 0) { contact = frame; closing = b.closing; }
        if (!main.missing && b.hit && (b.closing > 21 || (b.headOn && b.closing > 15))) {
          booms++;
          main.explode(b.x, car.y + 0.6, b.z, Math.min(1, b.closing / 30));
        }
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
    const d = main.did || {};
    const quiet = !d.fireballs && !d.sparks && !d.smoke && !d.wrecks && !d.toasts;
    check('the car you hit is not damaged, capped or alight',
      !main.missing && calls > 0 && quiet &&
      !t.damage && t.speedCap === undefined && !t.wrecked && !t.written && !(t.burning > 0),
      main.missing ? `main.js has no ${main.missing.join(', ')}` :
        `through main.js's onTrafficHit (${calls} calls) and explode (${booms}): ` +
        `damage model ${t.damage ? 'yes' : 'none'}, speedCap ${t.speedCap}, ` +
        `wrecked ${!!t.wrecked}, burning ${t.burning > 0 ? `${t.burning.toFixed(1)} s` : 0}, ` +
        `${d.fireballs} fireballs, ${d.sparks} spark bursts, ${d.smoke} smoke`);

    // The replay. A copy, so the car above is untouched; burning is reported
    // as yes/no because its length is Math.random().
    const armed = crashHandlers(true, playerCar(CARS[0].id, ground));
    const copy = { ...t, damage: null, speedCap: undefined, wrecked: false, written: false,
      exploded: false, burning: 0 };
    let err = '';
    try { if (first && !armed.missing) armed.onTrafficHit(copy, ...first); } catch (e) { err = e.message; }
    check('with DAMAGE on, the same contact is caught', !err && !!first && !!copy.damage &&
      copy.speedCap === 0 && copy.burning > 0 && armed.did.fireballs > 0,
      err ? `main.js's onTrafficHit threw: ${err}` : !first ? 'onTrafficHit was never called for it' :
        `integrity ${copy.damage ? copy.damage.integrity.toFixed(2) : '-'}, speedCap ${copy.speedCap}, ` +
        `written off ${!!copy.written}, burning ${copy.burning > 0 ? 'yes' : 'no'}, ` +
        `${armed.did.fireballs} fireball`);
    // Judged on the fastest it gets back to, not its speed at the twelfth
    // second: a struck car that pulls away at its own 1.5-3 m/s^2 and then
    // slows for the give-way junction ahead of it has driven on. With DAMAGE
    // on it would be capped at 0, 2 or 8 m/s (0.36 of 22), which this still
    // fails; so does a car that never pulls away at all.
    // The peak alone would pass a car that pulled away and then stalled again,
    // so where it ends up counts too: at the twelfth second it is moving, or
    // it is standing at the stop line its lane ends at, as traffic does.
    const peak = Math.max(...trace.map(Number));
    const slot = t.route && t.route[0];
    const toNode = slot ? slot.len - t.s : Infinity;
    const endOk = t.speed > 1 || toNode < 25;
    check('and it drives on', same && peak > vBefore * 0.5 && endOk,
      `${same ? 'same car' : 'recycled'}, ${vBefore.toFixed(1)} m/s before, back to ${peak.toFixed(1)}, ` +
      `${t.speed.toFixed(1)} m/s at the end ${toNode.toFixed(0)} m from its junction; each second after: ${trace.join(' ')}`);
  }
}

// ---- 5. Grinding along a wall is a thin trickle ---------------------------
//
// main.js calls impactCue() for every 120 Hz substep that reports a hit past
// severity 0.04, and a car held against a wall can report one on every
// substep. A fresh knock should get a whole puff you can see; staying in
// contact should get a trickle, not a puff on a timer plus dust on every
// substep. Run through main.js's own impactCue() and stepImpactCue(), with an
// emitDust that keeps particles.js's fractional debt and 24-per-call cap, so
// the count is the billows the game would spawn.
{
  const HZ = Number((/const PHYS_HZ = (\d+)/.exec(MAIN) || [])[1]) || 120;
  const SUB = 1 / HZ, FRAME = 2 / HZ;              // two substeps a frame at 60 fps
  const cueFor = (player) => {
    const dust = { billows: 0, debt: 0 };
    const fns = fromMain(['const cue = {', 'function impactCue(', 'function stepImpactCue('],
      ['impactCue', 'stepImpactCue'], {
        car: player, PHYS_DT: SUB,
        sky: { state: { nightFactor: 0 } },
        clampNum: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
        ground: { heightAt: () => 0 },
        particles: {
          emitDust(x, y, z, a) {
            if (!(a > 0)) return;
            dust.debt += a;
            const n = dust.debt | 0;
            dust.debt -= n;
            dust.billows += Math.min(24, n);
          },
        },
      });
    return { ...fns, dust };
  };
  const still = { x: 0, z: 0, yaw: 0 };

  // One knock, then clear air.
  const knock = (sev) => {
    const c = cueFor(still);
    if (c.missing) return -1;
    c.impactCue(0, -2, sev, 0, 1);
    for (let f = 0; f < 60; f++) c.stepImpactCue(FRAME);
    return c.dust.billows;
  };
  // In contact on every substep for 2 s, after the knock that started it.
  const held = (sev) => {
    const c = cueFor(still);
    if (c.missing) return -1;
    c.impactCue(0, -2, sev, 0, 1);
    c.stepImpactCue(FRAME);
    const b0 = c.dust.billows;
    for (let f = 1; f < 121; f++) {
      c.impactCue(0, -2, sev, 0, 1);
      c.impactCue(0, -2, sev, 0, 1);
      c.stepImpactCue(FRAME);
    }
    return (c.dust.billows - b0) / 2;
  };
  // And a real one: the player's car at 18 m/s along a warehouse face, steered
  // into it, through the real collision.
  const scrape = (() => {
    const car = playerCar(CARS[0].id);
    const c = cueFor(car);
    if (c.missing) return null;
    const coll = createCollision(WALL);
    const yaw0 = 0.3;
    car.reset(15.6, -40, yaw0);
    car.vx = -Math.sin(yaw0) * 18; car.vz = -Math.cos(yaw0) * 18;
    let touching = 0, knocks = 0;
    for (let f = 0; f < 180; f++) {
      car.input.throttle = 0.45; car.input.brake = 0; car.input.steer = -1;
      for (let k = 0; k < 2; k++) {
        car.step(SUB);
        const h = coll.resolve(car, SUB);
        if (h.hit) touching++;
        if (h.hit && h.severity > 0.04) { knocks++; c.impactCue(h.x, h.z, h.severity, h.nx, h.nz); }
      }
      c.stepImpactCue(FRAME);
    }
    return { touching: touching * SUB, knocks, billows: c.dust.billows };
  })();

  const brush = knock(0.1), hard = knock(1);
  check('a knock gets a puff you can see', brush >= 5 && hard >= 22,
    brush < 0 ? 'main.js has no impactCue()' :
      `${brush} billows for a brush (severity 0.1), ${hard} for 18 m/s into a wall`);
  const soft = held(0.3), firm = held(1);
  check('grinding along a wall is a thin trickle', soft >= 0 && soft <= 40 && firm <= 40 && !!scrape,
    `held in contact every substep: ${soft.toFixed(0)}/s at severity 0.3, ${firm.toFixed(0)}/s at 1.0; ` +
    (scrape ? `a real 18 m/s scrape: ${scrape.touching.toFixed(2)} s touching, ` +
      `${scrape.knocks} contacts past 0.04, ${scrape.billows} billows` : 'no scrape run'));
}

// ---- 6. The wiring holds --------------------------------------------------
//
// Read main.js for the four places the switch has to reach. If a merge drops
// one of these, the fire comes back and nothing else here would notice.
{
  const main = MAIN;
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
