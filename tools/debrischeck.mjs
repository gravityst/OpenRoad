// Proves that a torn-off part is a body, not a special effect.
//
// The assertion this file exists to make is the same one collisioncheck.mjs
// makes about walls, for the same reason: a bounce may only ever REMOVE energy.
// The previous project computed its restitution impulse from the corrected
// velocity and turned barriers into rail guns; a debris system with that bug
// gives you a bumper that gains a metre per second every time it touches the
// road and eventually leaves the map. So the energy rule is checked twice —
// once from the module's own contact bookkeeping, and once independently from
// the outside, by reading every piece's velocity before and after every step
// and asserting it can never have risen by more than gravity could account for.
//
// The other three things it checks are the ones that make debris either
// furniture or litter: nothing ends up under the ground it landed on, nothing
// diverges when it is left running, and a pool that is being hammered stays
// inside its cap and stays cheap.
import * as THREE from 'three';
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createDebris } from '../src/physics/debris.js';
import { mulberry } from '../src/world/noise.js';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) fail++;
};

// ---------------------------------------------------------------------------
// A cheap analytic ground with real slopes and an exact normal, so the heavy
// loops below are measuring debris rather than measuring the height field. The
// last section runs against the real world's ground as well.
// ---------------------------------------------------------------------------
const hills = {
  heightAt(x, z) {
    return 3.0 * Math.sin(x * 0.12) + 1.4 * Math.cos(z * 0.07) + 0.6 * Math.sin((x + z) * 0.031);
  },
  sample(x, z, out) {
    const r = out || {};
    r.y = hills.heightAt(x, z);
    const dx = 0.36 * Math.cos(x * 0.12) + 0.0186 * Math.cos((x + z) * 0.031);
    const dz = -0.098 * Math.sin(z * 0.07) + 0.0186 * Math.cos((x + z) * 0.031);
    const inv = 1 / Math.hypot(dx, 1, dz);
    r.nx = -dx * inv; r.ny = inv; r.nz = -dz * inv;
    // Alternating hard and soft ground, so both ends of the restitution and
    // friction range get exercised rather than just tarmac.
    const soft = ((Math.floor(x * 0.05) + Math.floor(z * 0.05)) & 1) === 1;
    r.surface = soft ? 'grass' : 'asphalt';
    r.grip = soft ? 0.52 : 1.0;
    r.roughness = soft ? 0.30 : 0.03;
    r.rolling = soft ? 0.075 : 0.014;
    r.dust = soft ? 0.35 : 0;
    return r;
  },
};

const rnd = mulberry(20260825);
const slab = new THREE.BoxGeometry(1, 1, 1);
const mat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8 });

/** A test piece. Sized like a real bumper so the numbers mean something. */
function makeMesh(w = 1.7, h = 0.2, d = 0.34) {
  const m = new THREE.Mesh(slab, mat);
  m.scale.set(w, h, d);
  return m;
}

const dt = 1 / 120;

// ===========================================================================
// 1. A contact may only ever REMOVE energy
// ===========================================================================
{
  const d = createDebris(hills, { max: 40, life: 4000, cullDistance: 1e9 });
  const pool = [];
  for (let i = 0; i < 40; i++) pool.push(makeMesh());

  // Thrown hard, from height, in every direction: the point is to generate as
  // many contacts as possible, including glancing ones onto slopes.
  for (let i = 0; i < 40; i++) {
    const a = rnd() * 6.2832;
    d.spawn(pool[i], (rnd() - 0.5) * 90, 14 + rnd() * 10, (rnd() - 0.5) * 90,
      Math.cos(a) * 26, 6 + rnd() * 16, Math.sin(a) * 26,
      (rnd() - 0.5) * 22, (rnd() - 0.5) * 22, (rnd() - 0.5) * 22);
  }
  const startCount = d.count;

  const before = new Array(40);
  const after = new Array(40);
  for (let i = 0; i < 40; i++) { before[i] = {}; after[i] = {}; }

  const bound = d.gravity * dt;            // the only thing that may add speed
  let worstGain = -Infinity, worstSpin = -Infinity, steps = 0, dropped = 0;

  for (let k = 0; k < 10000; k++) {
    const live = d.count;
    if (live !== startCount) { dropped++; break; }
    for (let i = 0; i < live; i++) d.probe(i, before[i]);
    d.update(dt);
    for (let i = 0; i < live; i++) {
      const b = before[i], a = d.probe(i, after[i]);
      const sb = Math.hypot(b.vx, b.vy, b.vz), sa = Math.hypot(a.vx, a.vy, a.vz);
      const wb = Math.hypot(b.wx, b.wy, b.wz), wa = Math.hypot(a.wx, a.wy, a.wz);
      if (sa - sb - bound > worstGain) worstGain = sa - sb - bound;
      if (wa - wb > worstSpin) worstSpin = wa - wb;
    }
    steps++;
  }

  check('no step adds more speed than gravity can', worstGain <= 1e-9 && dropped === 0,
    `${steps} steps x ${startCount} pieces, worst overshoot ${(worstGain).toExponential(2)} m/s ` +
    `(gravity budget ${bound.toFixed(4)} m/s/step)`);
  check('no contact ever adds spin', worstSpin <= 1e-9,
    `worst spin change ${worstSpin.toExponential(2)} rad/s`);
  check('the module agrees it never added energy',
    d.stats.worstBounceGain <= 0 && d.stats.worstSpinGain <= 0 && d.stats.bounces > 500,
    `${d.stats.bounces} contacts, worst gain ${d.stats.worstBounceGain.toExponential(2)} m/s, ` +
    `${d.stats.worstSpinGain.toExponential(2)} rad/s`);
  d.dispose();
}

// ===========================================================================
// 1b. ...even when the ground itself is lying about its numbers
// ===========================================================================
// The restitution algebra assumes a unit normal and a grip in 0..1, and both
// arrive from an object the caller supplied. A ground that hands back a normal
// three times too long and a grip of four must not be able to turn a bounce
// into a launch.
{
  const hostile = {
    heightAt: () => 0,
    sample(x, z, out) {
      out.y = 0;
      out.nx = 0.6; out.ny = 3.0; out.nz = -0.9;      // length 3.2
      out.grip = 4;                                    // off the end of the scale
      return out;
    },
  };
  const d = createDebris(hostile, { max: 20, life: 4000, cullDistance: 1e9 });
  const pool = [];
  for (let i = 0; i < 20; i++) pool.push(makeMesh());
  for (let i = 0; i < 20; i++) {
    d.spawn(pool[i], (rnd() - 0.5) * 30, 8 + rnd() * 6, (rnd() - 0.5) * 30,
      (rnd() - 0.5) * 30, rnd() * 10, (rnd() - 0.5) * 30,
      (rnd() - 0.5) * 18, (rnd() - 0.5) * 18, (rnd() - 0.5) * 18);
  }
  const before = new Array(20);
  for (let i = 0; i < 20; i++) before[i] = {};
  const after = {};
  const bound = d.gravity * dt;
  let worst = -Infinity;
  for (let k = 0; k < 3000; k++) {
    const live = d.count;
    for (let i = 0; i < live; i++) d.probe(i, before[i]);
    d.update(dt);
    for (let i = 0; i < live; i++) {
      const b = before[i], a = d.probe(i, after);
      const sb = Math.hypot(b.vx, b.vy, b.vz), sa = Math.hypot(a.vx, a.vy, a.vz);
      if (sa - sb - bound > worst) worst = sa - sb - bound;
    }
  }
  check('a lying ground cannot break the energy rule',
    worst <= 1e-9 && d.stats.worstBounceGain <= 0 && d.stats.bounces > 100,
    `${d.stats.bounces} contacts on a 3.2-long normal at grip 4, worst gain ` +
    `${d.stats.worstBounceGain.toExponential(2)} m/s`);
  d.dispose();
}

// ===========================================================================
// 2. Nothing falls through the ground, and everything ends up lying on it
// ===========================================================================
{
  const d = createDebris(hills, { max: 40, life: 4000, cullDistance: 1e9 });
  const pool = [];
  for (let i = 0; i < 40; i++) pool.push(makeMesh(0.6 + rnd() * 1.4, 0.06 + rnd() * 0.3, 0.2 + rnd() * 1.2));
  for (let i = 0; i < 40; i++) {
    const a = rnd() * 6.2832;
    d.spawn(pool[i], (rnd() - 0.5) * 120, 20 + rnd() * 14, (rnd() - 0.5) * 120,
      Math.cos(a) * 30, rnd() * 8, Math.sin(a) * 30,
      (rnd() - 0.5) * 26, (rnd() - 0.5) * 26, (rnd() - 0.5) * 26);
  }

  const p = {};
  let worstSink = 0, sinkAt = '';
  for (let k = 0; k < 3600; k++) {         // 30 s
    d.update(dt);
    for (let i = 0; i < d.count; i++) {
      d.probe(i, p);
      // The lowest point of the oriented box, against the ground under its
      // centre. Anything below zero is a piece inside the terrain.
      const sink = (hills.heightAt(p.x, p.z)) - (p.y - p.support);
      if (sink > worstSink) { worstSink = sink; sinkAt = `piece ${i} at t=${(k * dt).toFixed(1)}s`; }
    }
  }
  check('no piece ever sinks into the ground', worstSink < 1e-3,
    `worst penetration ${(worstSink * 1000).toFixed(3)} mm${worstSink > 1e-3 ? `, ${sinkAt}` : ''}`);

  // Everything thrown at t=0 should be lying still 30 s later, and lying FLAT:
  // the piece's own up axis within a few degrees of the surface normal.
  let asleep = 0, worstTilt = 0;
  const nrm = {};
  const up = new THREE.Vector3();
  for (let i = 0; i < d.count; i++) {
    d.probe(i, p);
    if (p.asleep) asleep++;
    const mesh = d.group.children[i];
    up.set(0, 1, 0).applyQuaternion(mesh.quaternion);
    hills.sample(p.x, p.z, nrm);
    const dot = Math.abs(up.x * nrm.nx + up.y * nrm.ny + up.z * nrm.nz);
    const tilt = Math.acos(Math.min(1, dot)) * 180 / Math.PI;
    if (tilt > worstTilt) worstTilt = tilt;
  }
  check('everything settles flat on the surface', asleep === d.count && worstTilt < 4,
    `${asleep}/${d.count} asleep, worst tilt off the surface normal ${worstTilt.toFixed(2)} deg`);
  d.dispose();
}

// ===========================================================================
// 3. Nothing diverges over 10k steps of constant abuse
// ===========================================================================
{
  const d = createDebris(hills, { max: 40, life: 9, cullDistance: 400 });
  const pool = [];
  for (let i = 0; i < 64; i++) pool.push(makeMesh());
  const cam = { x: 0, y: 3, z: 0 };
  const p = {};
  let bad = 0, overCap = 0, mismatched = 0, maxSpeed = 0, maxDist = 0, spawned = 0;

  for (let k = 0; k < 10000; k++) {
    // Three pieces a step is about thirty times the worst a real crash can
    // produce, which is the point: the cap has to hold under nonsense.
    for (let j = 0; j < 3; j++) {
      const m = pool[spawned++ % pool.length];
      const a = rnd() * 6.2832;
      d.spawn(m, cam.x + (rnd() - 0.5) * 40, 6 + rnd() * 6, cam.z + (rnd() - 0.5) * 40,
        Math.cos(a) * 40, rnd() * 20, Math.sin(a) * 40,
        (rnd() - 0.5) * 30, (rnd() - 0.5) * 30, (rnd() - 0.5) * 30);
    }
    cam.x += 14 * dt;                       // the camera drives away
    d.update(dt, cam);

    if (d.count > d.limit) overCap++;
    if (d.group.children.length !== d.count) mismatched++;
    for (let i = 0; i < d.count; i++) {
      d.probe(i, p);
      const s = Math.hypot(p.vx, p.vy, p.vz);
      if (![p.x, p.y, p.z, p.vx, p.vy, p.vz, p.wx, p.wy, p.wz].every(Number.isFinite)) bad++;
      if (s > maxSpeed) maxSpeed = s;
      const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      if (dist > maxDist) maxDist = dist;
    }
  }
  check('nothing diverges over 10k steps', bad === 0,
    `${spawned} pieces thrown, peak speed ${maxSpeed.toFixed(1)} m/s, ${bad} non-finite`);
  check('the pool never exceeds its cap', overCap === 0 && mismatched === 0,
    `cap ${d.limit}, ${overCap} over-cap frames, ${mismatched} frames out of step with the scene graph`);
  check('nothing outlives the camera cull', maxDist < 420,
    `furthest live piece ${maxDist.toFixed(0)} m from a camera culling at 400 m`);
  d.dispose();
}

// ===========================================================================
// 3b. A full pool must not eat the piece that just came off
// ===========================================================================
// The pool relieves pressure by ageing its OLDEST pieces faster. Done
// uniformly that also shortens the life of the part the player is watching
// come off the car, which is the one thing the cap must never do.
{
  const d = createDebris(hills, { max: 40, life: 24, cullDistance: 1e9 });
  const pool = [];
  for (let i = 0; i < 41; i++) pool.push(makeMesh());
  for (let i = 0; i < 40; i++) {
    d.spawn(pool[i], (rnd() - 0.5) * 40, 6, (rnd() - 0.5) * 40, 0, 0, 0, 2, 2, 2);
  }
  // 4 s of settling. Not much more: a pool this full is deliberately clearing
  // itself, and by 9 s the hurry has taken all forty of these away.
  for (let k = 0; k < 480; k++) d.update(dt);
  const full = d.count;
  const fresh = pool[40];
  d.spawn(fresh, 0, 8, 0, 4, 2, 0, 6, 6, 6);
  let survived = 0;
  for (let k = 0; k < 3600; k++) {
    d.update(dt);
    if (fresh.parent !== d.group) break;
    survived = (k + 1) * dt;
  }
  check('a full pool does not eat the newest piece', full === 40 && survived > 15,
    `pool was ${full}/40 full; the new piece lived ${survived.toFixed(1)} s of its 24 s`);
  d.dispose();
}

// ===========================================================================
// 4. update() is cheap with a full pool, and allocates nothing
// ===========================================================================
{
  const d = createDebris(hills, { max: 40, life: 4000, cullDistance: 1e9 });
  const pool = [];
  for (let i = 0; i < 40; i++) pool.push(makeMesh());
  const cam = { x: 0, y: 4, z: 0 };

  function relaunch() {
    for (let i = 0; i < 40; i++) {
      const a = rnd() * 6.2832;
      d.spawn(pool[i], (rnd() - 0.5) * 60, 12 + rnd() * 8, (rnd() - 0.5) * 60,
        Math.cos(a) * 24, 8 + rnd() * 10, Math.sin(a) * 24,
        (rnd() - 0.5) * 20, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20);
    }
  }

  // Warm the JIT before measuring, or the first batch is measuring the compiler.
  relaunch();
  for (let k = 0; k < 2000; k++) d.update(dt, cam);

  const BATCH = 240, ROUNDS = 50;
  let flying = 0;
  for (let r = 0; r < ROUNDS; r++) {
    relaunch();                              // untimed: keeps every piece airborne
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < BATCH; k++) d.update(dt, cam);
    flying += Number(process.hrtime.bigint() - t0);
  }
  const usFlying = flying / (BATCH * ROUNDS) / 1000;

  // The other regime: a full pool of pieces that have already settled, which is
  // what the road behind a bad crash actually looks like a few seconds later.
  for (let k = 0; k < 1200; k++) d.update(dt, cam);
  const t1 = process.hrtime.bigint();
  for (let k = 0; k < 12000; k++) d.update(dt, cam);
  const usRest = Number(process.hrtime.bigint() - t1) / 12000 / 1000;

  check('update() is cheap with a full pool', usFlying < 60,
    `${usFlying.toFixed(2)} us/frame with ${d.limit} pieces in flight ` +
    `(${(usFlying / d.limit * 1000).toFixed(0)} ns/piece), ${usRest.toFixed(2)} us/frame at rest`);

  // Allocation proxy. A single object literal per piece per frame would be
  // 40 x 20000 = 800k objects and would show up here as tens of megabytes.
  // Best of three, because heapUsed is a live number: an unrelated collection
  // landing inside the window moves it either way, and this check failed once
  // in four runs under the load of the full suite while passing every time on
  // its own. Code that really allocates fails all three; code that does not
  // passes at least one, so the retry costs nothing in sensitivity.
  let grew = Infinity;
  for (let attempt = 0; attempt < 3 && grew >= 8; attempt++) {
    relaunch();
    for (let k = 0; k < 4000; k++) d.update(dt, cam);    // settle the heap
    if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 20000; k++) d.update(dt, cam);
    grew = Math.min(grew, (process.memoryUsage().heapUsed - h0) / 1048576);
  }
  check('update() allocates nothing per frame', grew < 8,
    `heap moved ${grew >= 0 ? '+' : ''}${grew.toFixed(2)} MB over 20k updates (best of 3)`);
  d.dispose();
}

// ===========================================================================
// 5. spawnPart on the real ground: a bumper torn off at speed goes down the road
// ===========================================================================
{
  const w = buildWorld();
  const g = createGround(w);
  const d = createDebris(g, { max: 40, life: 4000, cullDistance: 1e9 });

  // A stand-in for the car's model group: the same transform and the same
  // userData.dims contract main.js will wire up.
  const car = new THREE.Object3D();
  car.userData.dims = { length: 4.42, width: 1.82, height: 1.44, front: -2.0, rear: 2.42 };
  const start = g.nearestRoad(0, 0, 600) || { x: 0, z: 0, tx: 0, tz: 1 };
  const yaw = Math.atan2(-start.tx, -start.tz);
  car.position.set(start.x, g.heightAt(start.x, start.z) + 0.28, start.z);
  car.rotation.y = yaw;
  car.updateMatrixWorld(true);

  // 120 km/h along the road: forward = (-sin yaw, 0, -cos yaw).
  const speed = 120 / 3.6;
  const vel = { x: -Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed };
  const mesh = d.spawnPart('frontBumper', car, vel);
  check('spawnPart builds a part from a detach event', !!mesh && d.count === 1,
    mesh ? `${mesh.name}, ${mesh.scale.x.toFixed(2)} x ${mesh.scale.y.toFixed(2)} x ${mesh.scale.z.toFixed(2)} m` : 'nothing spawned');

  const x0 = mesh.position.x, z0 = mesh.position.z;
  const p = {};
  let peakY = -Infinity, turns = 0, prevUpY = 1;
  const up = new THREE.Vector3();
  for (let k = 0; k < 720; k++) {           // 6 s
    d.update(dt);
    if (!d.count) break;
    d.probe(0, p);
    peakY = Math.max(peakY, p.y - g.heightAt(p.x, p.z));
    up.set(0, 1, 0).applyQuaternion(mesh.quaternion);
    if (up.y < 0 && prevUpY >= 0) turns++;   // counts half-cartwheels
    prevUpY = up.y;
  }
  d.probe(0, p);
  const travel = Math.hypot(p.x - x0, p.z - z0);
  const along = ((p.x - x0) * vel.x + (p.z - z0) * vel.z) / speed;
  check('a bumper torn off at 120 km/h cartwheels away', travel > 20 && along > 20 && turns >= 2,
    `${travel.toFixed(1)} m travelled, ${along.toFixed(1)} m of it down the road, ` +
    `${turns} half-turns, peaked ${peakY.toFixed(2)} m up`);

  // A vehicle carries x,y,z (where it is) AND vx,vy,vz (how fast it is going).
  // Handed one of those, spawnPart must read the velocity — reading the
  // position instead launches a bumper upward at the car's altitude in m/s.
  {
    const car2 = new THREE.Object3D();
    car2.userData.dims = car.userData.dims;
    car2.position.set(start.x, 90, start.z);      // parked on a 90 m hill
    car2.updateMatrixWorld(true);
    const d2 = createDebris({ heightAt: () => 0 }, { max: 4, life: 4000, cullDistance: 1e9 });
    d2.spawnPart('frontBumper', car2, { x: 400, y: 90, z: -300, vx: 0, vy: 0, vz: 0 });
    const q = d2.probe(0, {});
    const launched = Math.hypot(q.vx, q.vz);
    check('spawnPart reads velocity, not position', launched < 6 && q.vy < 6,
      `stationary car on a 90 m hill threw its bumper at ${launched.toFixed(1)} m/s, ${q.vy.toFixed(1)} m/s up`);
    d2.dispose();
  }

  // Every detachable part the damage model can emit has to produce something.
  const PARTS = ['mirrorL', 'mirrorR', 'frontBumper', 'rearBumper', 'bonnet', 'boot',
    'doorL', 'doorR', 'exhaust', 'spoiler'];
  d.clear();
  let built = 0;
  for (const part of PARTS) if (d.spawnPart(part, car, vel)) built++;
  check('every detachable part has a body', built === PARTS.length && d.count === PARTS.length,
    `${built}/${PARTS.length} parts built, ${d.count} live`);

  // And they all land on the real terrain rather than in it.
  let worstSink = 0;
  for (let k = 0; k < 2400; k++) {
    d.update(dt);
    for (let i = 0; i < d.count; i++) {
      d.probe(i, p);
      const sink = g.heightAt(p.x, p.z) - (p.y - p.support);
      if (sink > worstSink) worstSink = sink;
    }
  }
  let asleep = 0;
  for (let i = 0; i < d.count; i++) { d.probe(i, p); if (p.asleep) asleep++; }
  check('parts settle on the real terrain', worstSink < 1e-3 && asleep === d.count,
    `worst penetration ${(worstSink * 1000).toFixed(3)} mm, ${asleep}/${d.count} at rest`);

  // clear() and dispose() must leave the scene graph empty.
  d.clear();
  check('clear() empties the pool and the group', d.count === 0 && d.group.children.length === 0,
    `${d.count} live, ${d.group.children.length} children`);
  d.dispose();
}

console.log(fail === 0 ? '\nAll debris checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
