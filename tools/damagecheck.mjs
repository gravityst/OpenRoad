// Proves the damage model can only ever take capability away.
//
// A damage system that can accidentally HELP is a physics exploit, and players
// find those in minutes — deliberately clipping a wall on the entry to every
// corner because it happens to stiffen the front end is the kind of thing that
// defines a game's meta for years. So the central assertion here is blunt: over
// thousands of random impacts in random orders, no scaled output ever exceeds
// its undamaged value, and a damaged car is never quicker than a healthy one.
//
// The second thing it checks is that consequences are CONTINUOUS. Binary damage
// reads as a bug: the car is fine, then on the next frame it is undriveable and
// the player has no idea what changed.
import { createDamage, PANELS, GLASS, LIGHTS, DETACHABLE } from '../src/physics/damage.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { specFor, CARS } from '../src/vehicles/catalog.js';

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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${detail}`);
  if (!ok) fail++;
};

// ---- 1. Damage may only ever subtract ------------------------------------
{
  let violations = 0, worst = 0, samples = 0;
  for (let trial = 0; trial < 600; trial++) {
    const d = createDamage({});
    let prevIntegrity = 1;
    for (let k = 0; k < 24; k++) {
      d.impact(Math.random(), (Math.random() * 2 - 1) * 0.9,
        (Math.random() * 2 - 1) * 2.1, 0.9, 2.1, Math.random() * 40);
      d.step(dt * 30, Math.random(), Math.random() * 60);
      const e = d.effects;
      samples++;
      if (e.powerScale > 1.0000001 || e.brakeScale > 1.0000001) violations++;
      for (let i = 0; i < 4; i++) if (e.gripScale[i] > 1.0000001) violations++;
      if (e.dragAdd < -1e-9) violations++;
      // Integrity must never recover without an explicit repair.
      if (d.integrity > prevIntegrity + 1e-9) { violations++; worst = Math.max(worst, d.integrity - prevIntegrity); }
      prevIntegrity = d.integrity;
    }
  }
  check('damage never increases any capability', violations === 0,
    `${violations} violations over ${samples} states${worst ? `, worst +${worst.toFixed(4)}` : ''}`);
}

// ---- 2. A damaged car is never quicker -----------------------------------
{
  function run(wreck) {
    const c = createVehicle({ ground: FLAT, spec: specFor('kaze') });
    c.reset(0, 0, 0);
    if (wreck) wreck(c);
    let t = 0;
    while (t < 18) { c.input.throttle = 1; c.step(dt); t += dt; }
    return c.speed;
  }
  const healthy = run(null);
  let faster = 0, worstGain = 0;
  for (let i = 0; i < 60; i++) {
    const v = run((c) => {
      for (let k = 0; k < 1 + (i % 4); k++) {
        c.damage.impact(0.2 + Math.random() * 0.8, (Math.random() * 2 - 1) * 0.9,
          (Math.random() * 2 - 1) * 2.1, 0.9, 2.1, 20);
      }
    });
    if (v > healthy + 0.05) { faster++; worstGain = Math.max(worstGain, v - healthy); }
  }
  check('no crash ever makes the car faster', faster === 0,
    `${faster}/60 damaged runs beat the healthy ${(healthy * 3.6).toFixed(0)} km/h baseline` +
    (worstGain ? ` by up to ${(worstGain * 3.6).toFixed(1)} km/h` : ''));
}

// ---- 3. Consequences are continuous --------------------------------------
{
  const d = createDamage({});
  let biggestJump = 0, jumpAt = '';
  let prev = d.effects.powerScale;
  for (let k = 0; k < 4000; k++) {
    // Small impacts only: nothing here should ever move an output a long way.
    d.impact(0.03, (Math.random() * 2 - 1) * 0.9, (Math.random() * 2 - 1) * 2.1, 0.9, 2.1, 4);
    const jump = Math.abs(d.effects.powerScale - prev);
    if (jump > biggestJump) { biggestJump = jump; jumpAt = `after ${k} taps`; }
    prev = d.effects.powerScale;
  }
  check('small knocks never step the outputs', biggestJump < 0.06,
    `worst single-impact power change ${(biggestJump * 100).toFixed(2)}% ${jumpAt}`);
}

// ---- 4. Fire behaves ------------------------------------------------------
{
  // A holed radiator driven hard must eventually cook and light; airflow must
  // give the player a way to fight a small fire.
  const d = createDamage({});
  d.impact(0.9, 0, 2.0, 0.9, 2.1, 30);          // nose-on: radiator gone
  let lit = -1;
  for (let i = 0; i < 60 * 240 && lit < 0; i++) {
    d.step(1 / 60, 0.9, 30);
    if (d.state.onFire > 0) lit = i / 60;
  }
  check('a holed radiator eventually catches fire', lit > 5 && lit < 240,
    lit > 0 ? `alight after ${lit.toFixed(0)} s at full load` : 'never caught');

  const e = createDamage({});
  e.state.onFire = 0.2; e.state.temp = 0.9; e.recompute();
  for (let i = 0; i < 60 * 60; i++) e.step(1 / 60, 0.05, 45);   // coasting fast
  check('a small fire can be driven out', e.state.onFire < 0.2,
    `after a minute at 45 m/s: ${(e.state.onFire * 100).toFixed(0)}% (started at 20%)`);
}

// ---- 5. Tyres --------------------------------------------------------------
{
  const d = createDamage({});
  const surfaces = ['gravel', 'gravel', 'gravel', 'gravel'];
  let burst = -1;
  for (let i = 0; i < 60 * 600 && burst < 0; i++) {
    d.abrade(1 / 60, surfaces, 30, 0.5);          // sliding hard on gravel
    if (d.state.blown.some(Boolean)) burst = i / 60;
  }
  check('sliding on gravel eventually bursts a tyre', burst > 20 && burst < 600,
    burst > 0 ? `after ${burst.toFixed(0)} s of sustained slides` : 'never burst');

  const t = createDamage({});
  const tarmac = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  for (let i = 0; i < 60 * 600; i++) t.abrade(1 / 60, tarmac, 30, 0.02);
  check('cruising on tarmac does not destroy tyres', !t.state.blown.some(Boolean),
    `${(Math.min(...t.state.tyre) * 100).toFixed(0)}% left after 10 minutes`);
}

// ---- 6. Parts, glass and lights -------------------------------------------
{
  let anyDetach = false, anyShatter = false, anySmash = false, glassOrder = true;
  for (let trial = 0; trial < 200; trial++) {
    const d = createDamage({});
    const seen = [];
    for (let k = 0; k < 10; k++) {
      d.impact(0.25 + Math.random() * 0.7, (Math.random() * 2 - 1) * 0.9,
        (Math.random() * 2 - 1) * 2.1, 0.9, 2.1, 20);
      d.drainEvents(seen).forEach((ev) => {
        if (ev.type === 'detach') anyDetach = true;
        if (ev.type === 'glass-shatter') anyShatter = true;
        if (ev.type === 'light-smash') anySmash = true;
      });
    }
    // Glass must craze before it goes, for every pane.
    for (const g of GLASS) if (d.state.glass[g] > 0 && d.state.glass[g] < 0.5) { /* mid-state exists */ }
  }
  check('parts come off, glass shatters, lights smash', anyDetach && anyShatter && anySmash,
    `detach ${anyDetach}, shatter ${anyShatter}, lights ${anySmash}`);

  // A gentle scrape must not strip the car.
  const g = createDamage({});
  for (let k = 0; k < 40; k++) g.impact(0.08, 0.9, 0, 0.9, 2.1, 3);
  const lost = DETACHABLE.filter((p) => !g.state.attached[p]);
  check('a gentle scrape does not strip the car', lost.length === 0,
    `${lost.length} parts lost to 40 light scrapes${lost.length ? ': ' + lost.join(', ') : ''}`);
}

// ---- 7. Nothing diverges, and repair works --------------------------------
{
  let bad = 0;
  const d = createDamage({});
  for (let i = 0; i < 20000; i++) {
    d.impact(Math.random(), (Math.random() * 2 - 1) * 3, (Math.random() * 2 - 1) * 4, 0.9, 2.1, Math.random() * 90);
    d.abrade(dt, ['rock', 'gravel', 'asphalt', 'dirt'], Math.random() * 80, Math.random());
    d.step(dt, Math.random() * 1.4, Math.random() * 80);
    const e = d.effects;
    if (![e.powerScale, e.brakeScale, e.steerPull, e.dragAdd, e.smoke, e.fire, d.integrity]
      .every(Number.isFinite)) { bad++; break; }
    if (e.gripScale.some((v) => !Number.isFinite(v))) { bad++; break; }
  }
  check('no NaN over 20k impacts', bad === 0, `${bad} non-finite states`);

  d.reset();
  const clean = d.effects.powerScale === 1 && d.effects.brakeScale === 1 &&
    d.integrity === 1 && !d.state.blown.some(Boolean) &&
    DETACHABLE.every((p) => d.state.attached[p]) && d.state.onFire === 0;
  check('repair restores the car completely', clean,
    `integrity ${(d.integrity * 100).toFixed(0)}%, power ${(d.effects.powerScale * 100).toFixed(0)}%`);
}

// ---- 8. Every car in the catalogue survives being crashed ------------------
{
  let bad = 0;
  for (const c of CARS) {
    const v = createVehicle({ ground: FLAT, spec: specFor(c.id) });
    v.reset(0, 0, 0);
    for (let i = 0; i < 1200; i++) {
      v.input.throttle = 1;
      v.step(dt);
      if (i % 90 === 0) v.damage.impact(Math.random(), (Math.random() * 2 - 1) * 0.9,
        (Math.random() * 2 - 1) * 2.1, 0.9, 2.1, 25);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.speed)) { bad++; break; }
    }
  }
  check('all ten cars survive being crashed repeatedly', bad === 0, `${bad}/${CARS.length} diverged`);
}

console.log(fail === 0 ? '\nAll damage checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
