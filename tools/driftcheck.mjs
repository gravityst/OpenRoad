// Proves the drift scorer pays for drifting and for nothing else.
//
// Two failure modes make a drift meter worthless, and both are easy to ship.
//
// The first is FLICKER. A single angle threshold makes `active` chatter at
// frame rate on a car that is merely going round a corner, so the combo counter
// runs away and a player who never got sideways ends the session on a 6x chain.
// The number that matters is therefore not "did it see the drift" but "how many
// times did it change its mind", and over one steady slide that number is 2.
//
// The second is PAYING FOR NOTHING. A straight-line run must score exactly
// zero, and so must the version of a straight line a real driver produces —
// a car being actively held on line, which in this vehicle model is carrying a
// few degrees of slip at all times. Anything above zero there and the
// leaderboard is won by holding the throttle down.
//
// WHY EVERY DRIVER IN HERE IS A CONTROLLER, NOT A SCRIPT
//
// Open-loop inputs cannot drift this car. A sweep of thirty fixed steering and
// throttle combinations at 100 km/h spun it thirty times out of thirty. That is
// not a flaw in the scorer, it is what a car does when nobody is correcting it,
// and a harness built on scripted inputs would be measuring spins and calling
// them drifts. So the drivers below close the loop the way a person does:
// countersteer proportional to the angle being carried, damped by yaw rate,
// aiming at a target angle. Changing that one target is the only difference
// between the driver who goes straight and the driver who is sideways for a
// mile — which also makes the ESC comparison in check 4 exact, since both sides
// of it are driven by the same controller.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createDrift } from '../src/game/drift.js';

const dt = 1 / 120;
const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) fail++;
};

/** Flat dry asphalt: a slide measured on a real road measures the hill. */
const surface = (name, grip, roughness) => ({
  sample(x, z, out) {
    const r = out || {};
    r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
    r.surface = name; r.grip = grip; r.roughness = roughness;
    r.rolling = 0.014; r.dust = 0;
    return r;
  },
});
const FLAT = surface('asphalt', 1, 0.03);
const LOOSE = surface('gravel', 0.62, 0.46);

/**
 * The same geometry the module derives, written out again from the coordinate
 * convention rather than imported. If the two ever disagree, one of them is
 * wrong and this harness is the place to find out.
 */
function angleOf(c) {
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
  const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
  return Math.atan2(c.vx * rx + c.vz * rz, c.vx * fx + c.vz * fz);
}

// The real world costs about a second and a half to lay out and grade, and two
// checks below want it. Built once, shared.
let worldOnce = null;
function realWorld() {
  if (!worldOnce) {
    const world = buildWorld();
    worldOnce = { world, ground: createGround(world) };
  }
  return worldOnce;
}

function newCar(ground = FLAT, speed = 30, esc = 0) {
  const c = createVehicle({ ground, isPlayer: true });
  // ESC OFF by default in this harness, because that is what drifting is.
  //
  // It used to default to the player's 0.62, which was harmless while the
  // stability aid barely worked. Now that it is a real one — it holds the car
  // at about 13 degrees of body slip — asking for a 60 degree drift with it
  // switched on gets 8.7 degrees, and every scoring test failed. That is the
  // aid doing its job. Drifting is an aid-off activity, or a trail-braking one,
  // and the harness has to ask for it the way a player would.
  c.aids.stability = esc;
  c.reset(0, 0, 0);
  c.vz = -speed;                       // facing -Z, so this is forwards
  return c;
}

/**
 * A driver holding `target` radians of drift angle at `vTarget` m/s.
 * Gains found by sweep: K=3 settles inside a second without overshooting into
 * a spin, D=0.6 is the least damping that stops it hunting.
 */
function driver(target, vTarget) {
  return (t, c) => {
    const a = angleOf(c);
    const want = Math.abs(target);
    // Trail-brake to ROTATE the car when it is well short of the angle asked
    // for, then come off the brake and hold on the throttle.
    //
    // The old version steered alone. That was enough against a car with almost
    // no yaw damping, where any steering input eventually produced any angle
    // you liked; against one that settles — and with a stability aid that
    // actually resists — steering alone tops out around seven degrees no matter
    // what you ask for, and every angle-dependent test failed. Braking to
    // initiate is how a driver does it and how this car is built to respond.
    const short = want > 0.15 && Math.abs(a) < want * 0.75;
    c.input.brake = short && c.speed > 11 ? 0.6 : 0;
    c.input.handbrake = 0;
    c.input.throttle = clamp((short ? 0.25 : 0.45) + (vTarget - c.speed) * 0.12, 0, 1);
    c.input.steer = clamp(5.5 * (a - target) + 0.5 * c.yawRate, -1, 1);
  };
}

/** Runs the car, feeding the scorer once per physics step (the strictest rate). */
function run(car, drift, seconds, input, watch) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    input(t, car);
    car.step(dt);
    const s = drift.update(dt, car);
    if (watch) watch(t, car, s);
  }
  return drift.state;
}

/**
 * A car-shaped object driven straight from an angle, so the SCORER can be
 * measured without the vehicle in the way. Angles are ramped in from 15 deg
 * because the module refuses to start a drift that is already near the spin —
 * teleporting to 58 degrees is a spin you survived, not a drift you began.
 */
function rateAt(surfaceName, deg, speed) {
  const d = createDrift();
  const c = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed, yawRate: 0, airborne: false, surface: surfaceName };
  const set = (v) => {
    const a = v / DEG;
    c.vx = Math.sin(a) * speed;
    c.vz = -Math.cos(a) * speed;
  };
  for (let i = 0; i < 120; i++) { set(15 + (deg - 15) * (i / 120)); d.update(dt, c); }
  for (let i = 0; i < 60; i++) { set(deg); d.update(dt, c); }
  return d.state.rate;
}

// ---------------------------------------------------------------------------
// 1. A STRAIGHT LINE NEVER SCORES
// ---------------------------------------------------------------------------
{
  const car = newCar();
  const drift = createDrift();
  let everActive = false, peak = 0;
  run(car, drift, 30, (t, c) => {
    c.input.throttle = 1; c.input.brake = 0; c.input.steer = 0; c.input.handbrake = 0;
  }, (t, c, s) => {
    if (s.active) everActive = true;
    peak = Math.max(peak, Math.abs(s.angleDeg));
  });
  check('flat out in a straight line scores nothing',
    !everActive && drift.state.banked === 0 && drift.state.score === 0,
    `30 s at full throttle to ${(car.speed * 3.6).toFixed(0)} km/h: ` +
    `${drift.state.banked.toFixed(0)} pts, peak angle ${peak.toFixed(2)} deg`);
}
{
  // A driver actively holding the car straight, which is not the same thing:
  // now there is steering input every frame and the detector has to ignore it.
  const car = newCar();
  const drift = createDrift();
  let everActive = false, peak = 0;
  run(car, drift, 30, driver(0, 30), (t, c, s) => {
    if (s.active) everActive = true;
    peak = Math.max(peak, Math.abs(s.angleDeg));
  });
  check('a driver holding it straight scores nothing',
    !everActive && drift.state.banked === 0,
    `30 s of continuous correction: peak angle ${peak.toFixed(2)} deg`);
}
{
  // And a car genuinely carrying slip — a fast road-going cornering attitude,
  // settled just under the entry threshold. This is the one that catches a
  // detector whose threshold is too low to mean anything.
  const car = newCar(FLAT, 30);
  const drift = createDrift();
  let everActive = false, peak = 0, mean = 0, n = 0;
  run(car, drift, 30, driver(-0.22, 30), (t, c, s) => {
    if (s.active) everActive = true;
    peak = Math.max(peak, Math.abs(s.angleDeg));
    if (t > 2) { mean += Math.abs(s.angleDeg); n++; }
  });
  check('a fast car carrying slip scores nothing',
    !everActive && drift.state.banked === 0,
    `held ${(mean / n).toFixed(1)} deg (peak ${peak.toFixed(1)}) against a 12.0 deg entry`);
}

// ---------------------------------------------------------------------------
// 2. A SUSTAINED SLIDE SCORES, AND BANKS
// ---------------------------------------------------------------------------
// Eight seconds sideways, then straighten and let the link window run out.
let slide = null;
{
  const car = newCar(FLAT, 30);
  const drift = createDrift();
  let peak = 0, held = 0, peakRate = 0, transitions = 0, prev = false, maxCombo = 0;
  const hold = driver(-0.60, 30), straight = driver(0, 30);
  run(car, drift, 11, (t, c) => (t < 8 ? hold(t, c) : straight(t, c)), (t, c, s) => {
    peak = Math.max(peak, Math.abs(s.angleDeg));
    peakRate = Math.max(peakRate, s.rate);
    maxCombo = Math.max(maxCombo, s.combo);
    if (s.active) held += dt;
    if (s.active !== prev) { transitions++; prev = s.active; }
  });
  const st = drift.state;
  slide = { transitions, held, peak, peakRate, banked: st.banked, maxCombo };
  check('a sustained slide scores and banks',
    st.banked > 0 && held > 6 && st.combo === 0 && st.lastResult.kind === 'banked',
    `${held.toFixed(2)} s sideways at up to ${peak.toFixed(0)} deg, ` +
    `peak ${peakRate.toFixed(0)} pts/s, banked ${st.banked.toFixed(0)}`);
  check('the bank equals the chain that was pending',
    Math.abs(st.best - st.banked) < 1e-9 && st.lastResult.points === st.banked,
    `best ${st.best.toFixed(0)} = banked ${st.banked.toFixed(0)} = flash ${st.lastResult.points.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
// 3. THE DETECTOR DOES NOT FLICKER
// ---------------------------------------------------------------------------
{
  check('a steady drift is one event, not many',
    slide.transitions === 2 && slide.maxCombo === 1,
    `${slide.transitions} changes of state and combo ${slide.maxCombo} over ` +
    `${slide.held.toFixed(2)} s at ${(1 / dt).toFixed(0)} Hz (2 and 1 are correct)`);

  // The same drift over real ground, where camber and surface changes make the
  // angle genuinely wander across the dead band. That is what the band is for.
  const { world, ground } = realWorld();
  // The longest edges, spread out across the map. Picked by rank rather than by
  // an absolute length or a fixed index, because the world layout is a moving
  // target and a harness that silently samples zero roads is worse than useless
  // — it passes.
  const long = world.edges.slice().sort((p, q) => q.length - p.length).slice(0, 120);
  let worst = 0, worstCombo = 0, sampled = 0, everActive = 0;
  for (let k = 0; k < 6; k++) {
    const e = long[k * 17];
    if (!e) break;
    const a = e.pts[0], b = e.pts[1];
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    const car = createVehicle({ ground, isPlayer: true });
    car.reset(a.x, a.z, yaw);
    car.vx = -Math.sin(yaw) * 26; car.vz = -Math.cos(yaw) * 26;
    const drift = createDrift({ ground });
    let transitions = 0, prev = false;
    const hold = driver(-0.60, 26);
    run(car, drift, 8, hold, (t, c, s) => {
      if (s.active !== prev) { transitions++; prev = s.active; }
      if (s.active) everActive++;
      worstCombo = Math.max(worstCombo, s.combo);
    });
    worst = Math.max(worst, transitions);
    sampled++;
  }
  check('rough ground does not make it chatter',
    sampled >= 4 && everActive > 0 && worst <= 4,
    `worst ${worst} state changes over 8 s on ${sampled} real roads, ` +
    `highest combo ${worstCombo}`);
}

// ---------------------------------------------------------------------------
// 4. A SPIN LOSES THE CHAIN
// ---------------------------------------------------------------------------
// The identical driver with ESC switched off. It cannot hold the slide — the
// countersteer available in vehicle.js runs out — so it spins, and the chain
// that was building has to go with it.
{
  const car = newCar(FLAT, 30, 0);
  const drift = createDrift();
  let peak = 0, everChained = false, bankedBefore = 0;
  run(car, drift, 6, driver(-0.60, 30), (t, c, s) => {
    peak = Math.max(peak, Math.abs(s.angleDeg));
    if (s.combo > 0) everChained = true;
    bankedBefore = Math.max(bankedBefore, s.banked);
  });
  const st = drift.state;
  check('spinning loses the chain',
    everChained && st.lastResult.kind === 'lost' && st.lastResult.reason === 'spin' &&
    st.combo === 0 && st.score === 0 && st.pending === 0,
    `ESC off, same driver: reached ${peak.toFixed(0)} deg, ` +
    `"${st.lastResult.kind}" (${st.lastResult.reason}), ` +
    `${st.lastResult.points.toFixed(0)} pts forfeited`);
  check('a lost chain never reaches the bank',
    st.banked === 0,
    `bank still ${st.banked.toFixed(0)} pts after the spin`);
}

// ---------------------------------------------------------------------------
// 5. HITTING SOMETHING LOSES IT; A GRAZE DOES NOT
// ---------------------------------------------------------------------------
{
  const car = newCar(FLAT, 30);
  const drift = createDrift();
  run(car, drift, 3, driver(-0.60, 30));
  const chained = drift.state.combo > 0;
  const pending = drift.state.pending;
  drift.onCollision(0.01);                        // a kerb strike, essentially
  const survived = drift.state.combo > 0;
  drift.onCollision(0.6);                         // a wall
  const st = drift.state;
  check('hitting something loses the chain',
    chained && survived && st.combo === 0 && st.lastResult.reason === 'crash' && st.banked === 0,
    `graze at 0.01 kept ${pending.toFixed(0)} pts, impact at 0.60 lost them`);
}

// ---------------------------------------------------------------------------
// 6. BOGGING DOWN MID-SLIDE LOSES IT
// ---------------------------------------------------------------------------
{
  const car = newCar(FLAT, 22);
  const drift = createDrift();
  const hold = driver(-0.60, 22);
  run(car, drift, 3, hold);
  const chained = drift.state.combo > 0;
  // Anchors out while still sideways: the slide dies below the speed floor.
  run(car, drift, 5, (t, c) => {
    hold(t, c);
    c.input.throttle = 0;
    c.input.brake = 1;
  });
  const st = drift.state;
  check('bogging down mid-slide loses the chain',
    chained && st.combo === 0 && st.lastResult.kind === 'lost' && st.lastResult.reason === 'slow',
    `braked to ${(car.speed * 3.6).toFixed(0)} km/h while sideways: ` +
    `"${st.lastResult.kind}" (${st.lastResult.reason})`);
}

// ---------------------------------------------------------------------------
// 7. CHAINING: LINKED DRIFTS MULTIPLY
// ---------------------------------------------------------------------------
{
  // Sideways right, straight for 1.2 s — long enough for the drift itself to
  // end, short enough to stay inside the 1.25 s link window — then sideways
  // left. One chain, two drifts, and the second is worth more than the first
  // because of the first.
  const car = newCar(FLAT, 30);
  const drift = createDrift();
  const right = driver(-0.60, 30), left = driver(0.60, 30), straight = driver(0, 30);
  let maxCombo = 0, maxMult = 0, banks = 0, seenAge = 1e9;
  run(car, drift, 18, (t, c) => {
    if (t < 5) right(t, c);
    else if (t < 6.2) straight(t, c);
    else if (t < 12) left(t, c);
    else straight(t, c);
  }, (t, c, s) => {
    maxCombo = Math.max(maxCombo, s.combo);
    maxMult = Math.max(maxMult, s.multiplier);
    if (s.lastResult.kind === 'banked' && s.lastResult.age < seenAge) banks++;
    seenAge = s.lastResult.age;
  });
  const st = drift.state;
  check('linked drifts raise the multiplier',
    maxCombo >= 2 && maxMult >= 1.5 && st.banked > 0,
    `combo ${maxCombo} at ${maxMult.toFixed(1)}x, banked ${st.banked.toFixed(0)} pts ` +
    `in ${banks} payout(s)`);
}
{
  // And the window really does close: leave it straight for longer than the
  // link window and the next drift starts a brand new chain at 1x.
  const car = newCar(FLAT, 30);
  const drift = createDrift();
  const right = driver(-0.60, 30), straight = driver(0, 30);
  let secondChainMult = 0, banks = 0, prevAge = 1e9;
  run(car, drift, 16, (t, c) => {
    if (t < 5) right(t, c);
    else if (t < 8) straight(t, c);
    else if (t < 13) right(t, c);
    else straight(t, c);
  }, (t, c, s) => {
    if (t > 9 && s.active) secondChainMult = Math.max(secondChainMult, s.multiplier);
    if (s.lastResult.kind === 'banked' && s.lastResult.age < prevAge) banks++;
    prevAge = s.lastResult.age;
  });
  check('a chain left open too long banks and ends',
    banks === 2 && secondChainMult === 1,
    `3 s of straight running split it into ${banks} chains, ` +
    `the second restarting at ${secondChainMult.toFixed(1)}x`);
}

// ---------------------------------------------------------------------------
// 8. SURFACE
// ---------------------------------------------------------------------------
{
  const tar = rateAt('asphalt', 35, 20);
  const grv = rateAt('gravel', 35, 20);
  const tarCeil = rateAt('asphalt', 58, 20);
  const grvCeil = rateAt('gravel', 74, 20);
  const tarSpun = rateAt('asphalt', 74, 20);
  check('tarmac pays more per degree than gravel',
    grv > 0 && grv < tar,
    `at 35 deg and 72 km/h: asphalt ${tar.toFixed(0)} pts/s, gravel ${grv.toFixed(0)} pts/s ` +
    `(${((1 - grv / tar) * 100).toFixed(0)}% less)`);
  check('gravel holds a bigger angle before the spin',
    grvCeil > tarCeil && tarSpun === 0,
    `ceiling: asphalt ${tarCeil.toFixed(0)} pts/s at 58 deg, gravel ${grvCeil.toFixed(0)} at 74 deg; ` +
    `74 deg on tarmac is a spin and pays ${tarSpun.toFixed(0)}`);

  // And on the car, not the stub: given the same driver asking for the same
  // 60 degrees, gravel settles further out than asphalt ever gets. Gravel is
  // slow to build — it takes about eight seconds — so the average is taken
  // late, over the last third of a sixteen-second run.
  const measure = (ground) => {
    const car = newCar(ground, 24);
    const drift = createDrift();
    let mean = 0, n = 0;
    run(car, drift, 16, driver(-1.05, 24), (t, c, s) => {
      if (t > 10.5) { mean += Math.abs(s.angleDeg); n++; }
    });
    return mean / n;
  };
  const onTar = measure(FLAT);
  const onGrv = measure(LOOSE);
  check('the same driver carries more angle on gravel',
    onGrv > onTar + 3,
    `asking for 60 deg: ${onTar.toFixed(1)} deg settled on asphalt, ${onGrv.toFixed(1)} deg on gravel`);
}

// ---------------------------------------------------------------------------
// 9. THE SCORING CURVE, PRINTED
// ---------------------------------------------------------------------------
{
  console.log('\npoints per second on dry asphalt (spin at 60 deg):');
  console.log('   angle       54 km/h    72 km/h   108 km/h   180 km/h');
  for (const deg of [12, 15, 20, 25, 30, 35, 40, 50, 58]) {
    const row = [15, 20, 30, 50].map((v) => rateAt('asphalt', deg, v).toFixed(0).padStart(10)).join(' ');
    console.log(`   ${String(deg).padStart(2)} deg ${row}`);
  }
}

// ---------------------------------------------------------------------------
// 10. NOTHING DIVERGES, AND THE BANK ONLY EVER GROWS
// ---------------------------------------------------------------------------
{
  const { world, ground } = realWorld();
  let regressions = 0, nonFinite = 0, banks = 0, losses = 0, samples = 0;
  let worstDrop = 0, topChain = 0, topCombo = 0;

  const left = driver(0.60, 24), right = driver(-0.60, 24), straight = driver(0, 24);
  const runs = [];

  // Two on flat asphalt first, so the counts asserted below cannot be undone by
  // a change to the world layout: one chain that must link and bank, one that
  // must spin and be lost.
  runs.push({
    car: newCar(FLAT, 30), drift: createDrift(), seconds: 18,
    input: (t, c) => (t < 5 ? right(t, c) : t < 6.2 ? straight(t, c) : t < 12 ? left(t, c) : straight(t, c)),
  });
  runs.push({ car: newCar(FLAT, 30, 0), drift: createDrift(), seconds: 8, input: right });

  // Then eight over real ground, half of them with ESC off.
  for (let k = 0; k < 8; k++) {
    const e = world.edges[(k * 53) % world.edges.length];
    const a = e.pts[0], b = e.pts[1];
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    const car = createVehicle({ ground, isPlayer: true });
    if (k % 2) car.aids.stability = 0;
    car.reset(a.x, a.z, yaw);
    car.vx = -Math.sin(yaw) * 20; car.vz = -Math.cos(yaw) * 20;
    runs.push({
      car,
      // Both proximity bonuses live, including a nearest() that returns
      // negative ranges on purpose — the scorer has to survive whatever
      // main.js hands it.
      drift: createDrift({ ground, nearest: (x) => (Math.abs(x) % 11) - 1 }),
      seconds: 45,
      input: (t, c) => {
        const phase = t % 12;
        if (phase < 4) right(t, c);
        else if (phase < 4.8) straight(t, c);
        else if (phase < 8) left(t, c);
        else {
          // Deliberately trying to break it: lock, throttle and handbrake all
          // out of phase with each other.
          c.input.throttle = 0.65 + 0.35 * Math.sin(t * 0.83);
          c.input.steer = Math.sin(t * 1.31) * 0.95 + Math.sin(t * 3.7) * 0.3;
          c.input.brake = (t % 7 < 0.5) ? 0.9 : 0;
          c.input.handbrake = (t % 3.1 < 0.35) ? 1 : 0;
        }
      },
    });
  }

  for (const r of runs) {
    let prevBanked = 0, prevBest = 0, prevAge = 1e9;
    run(r.car, r.drift, r.seconds, r.input, (t, c, s) => {
      samples++;
      if (![s.angle, s.angleDeg, s.score, s.pending, s.banked, s.best, s.multiplier,
        s.rate, s.chainSeconds, s.holdRatio, s.proximity, s.linkWindow, s.flash]
        .every(Number.isFinite)) nonFinite++;
      if (s.banked < prevBanked - 1e-9 || s.best < prevBest - 1e-9) {
        regressions++;
        worstDrop = Math.max(worstDrop, prevBanked - s.banked);
      }
      prevBanked = s.banked; prevBest = s.best;
      topChain = Math.max(topChain, s.pending);
      topCombo = Math.max(topCombo, s.combo);
      if (s.lastResult.age < prevAge) {
        if (s.lastResult.kind === 'banked') banks++;
        else if (s.lastResult.kind === 'lost') losses++;
      }
      prevAge = s.lastResult.age;
      // Collisions arriving from outside, at awkward moments.
      if (Math.abs(Math.sin(t * 91.7)) > 0.9999) r.drift.onCollision(0.4);
    });
  }

  check('nothing goes non-finite', nonFinite === 0,
    `${nonFinite} bad states over ${samples} steps of abuse`);
  check('the bank never goes backwards', regressions === 0,
    `${regressions} regressions${worstDrop ? `, worst -${worstDrop.toFixed(2)}` : ''} ` +
    `over ${banks} banks and ${losses} losses`);
  check('the abuse actually banked something',
    banks > 0 && losses > 0 && topCombo >= 2,
    `${banks} banked, ${losses} lost, best chain ${topChain.toFixed(0)} pts at combo ${topCombo}`);
}

// ---------------------------------------------------------------------------
// 11. THE HYSTERESIS MARGIN, MEASURED
// ---------------------------------------------------------------------------
{
  // Walk the angle slowly up and back down and record where the state flips.
  // The gap between the two is what a twitch has to cross to be believed.
  const d = createDrift();
  const c = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 22, yawRate: 0, airborne: false, surface: 'asphalt' };
  const set = (deg) => {
    const a = deg / DEG;
    c.vx = Math.sin(a) * c.speed;
    c.vz = -Math.cos(a) * c.speed;
  };
  let onAt = -1, offAt = -1;
  for (let deg = 0; deg <= 40; deg += 0.02) { set(deg); d.update(dt, c); if (onAt < 0 && d.state.active) onAt = deg; }
  for (let deg = 40; deg >= 0; deg -= 0.02) { set(deg); d.update(dt, c); if (onAt >= 0 && offAt < 0 && !d.state.active) offAt = deg; }
  const margin = onAt - offAt;
  check('the dead band is wide enough to matter',
    onAt > 0 && offAt > 0 && margin > 3,
    `latches on at ${onAt.toFixed(1)} deg, releases at ${offAt.toFixed(1)} deg — ` +
    `${margin.toFixed(1)} deg of hysteresis`);

  // A twitch through the whole band, once per frame, must change nothing.
  const e = createDrift();
  const q = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 22, yawRate: 0, airborne: false, surface: 'asphalt' };
  let flips = 0, prev = false;
  for (let i = 0; i < 6000; i++) {
    const deg = 9.5 + (i % 2 ? 2.2 : -2.2);        // 7.3 <-> 11.7, straddling nothing
    const a = deg / DEG;
    q.vx = Math.sin(a) * q.speed; q.vz = -Math.cos(a) * q.speed;
    e.update(dt, q);
    if (e.state.active !== prev) { flips++; prev = e.state.active; }
  }
  check('a twitch inside the band changes nothing',
    flips === 0 && e.state.banked === 0 && e.state.combo === 0,
    `50 s of 7.3<->11.7 deg square wave at 120 Hz: ${flips} state changes`);
}

// ---------------------------------------------------------------------------
// 12. AIRBORNE HOLDS THE CHAIN RATHER THAN ENDING IT
// ---------------------------------------------------------------------------
{
  const d = createDrift();
  const c = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 28, yawRate: 0, airborne: false, surface: 'asphalt' };
  const set = (deg) => { const a = deg / DEG; c.vx = Math.sin(a) * c.speed; c.vz = -Math.cos(a) * c.speed; };
  set(30);
  for (let i = 0; i < 240; i++) d.update(dt, c);          // 2 s sideways
  const before = d.state.score, combo = d.state.combo;
  c.airborne = true;
  for (let i = 0; i < 180; i++) d.update(dt, c);          // 1.5 s of jump
  const during = d.state.score;
  c.airborne = false;
  for (let i = 0; i < 120; i++) d.update(dt, c);          // and back down
  check('a jump mid-drift neither scores nor ends the chain',
    combo > 0 && during === before && d.state.combo === combo && d.state.score > during,
    `${before.toFixed(0)} pts before the jump, ${during.toFixed(0)} after 1.5 s in the air, ` +
    `chain still at combo ${d.state.combo}`);
}

console.log(fail === 0 ? '\nAll drift checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
