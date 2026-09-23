// Proves the car is a joy to drive with a KEYBOARD, and still honest.
//
// The kids who play this said it was hard to play, and they were right: the
// lead play-tested it with real key presses and measured a car that, from
// 81 km/h, left the road half a second into one second of D, carried on
// sliding with the wheel straight, never straightened itself, and then
// accelerated to 143 km/h sideways across a field. Every check below is one
// of those complaints turned into a number that has to hold.
//
// Where a KEY is involved the car is driven through the real input/controls.js
// — keydown and keyup events into the same listeners the browser uses — so the
// ramps, the reversal and the lock are the ones a player gets, not a harness's
// idea of them. Everything runs on flat reference ground so that a number
// measures the car and not the hill it happened to be on.
import { createVehicle, aidsFor } from '../src/physics/vehicle.js';
import { specFor, STARTER, CARS } from '../src/vehicles/catalog.js';
import { SURFACES } from '../src/world/ground.js';

const dt = 1 / 120;
const DEG = 180 / Math.PI;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) fail++;
};

const flat = (name = 'asphalt') => {
  const sp = SURFACES[name];
  return {
    sample(x, z, out) {
      const r = out || {};
      r.y = 0; r.nx = 0; r.ny = 1; r.nz = 0;
      r.surface = name; r.grip = sp.grip; r.roughness = sp.roughness;
      r.rolling = sp.rolling; r.dust = sp.dust;
      return r;
    },
  };
};
const ASPHALT = flat('asphalt');

function newCar(id = STARTER, ground = ASPHALT, settings = {}) {
  const c = createVehicle({ ground, spec: id ? specFor(id) : undefined, isPlayer: true });
  c.setAssists(settings);                 // exactly what main.js does for a player
  c.reset(0, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// The real keyboard. controls.js binds to window and document at construction;
// these stand-ins capture its listeners so key events can be fed straight in.
// ---------------------------------------------------------------------------
const listeners = {};
globalThis.window = { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, hidden: false };
const { createControls } = await import('../src/input/controls.js');
const keyEvent = (code) => ({ code, repeat: false, target: null, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} });
function keyboard() {
  const controls = createControls();
  controls.reset();
  return {
    controls,
    down: (code) => listeners.keydown(keyEvent(code)),
    up: (code) => listeners.keyup(keyEvent(code)),
    // One 60 Hz frame of input feeding two 120 Hz physics steps, as main.js does.
    frame(car, extra) {
      const s = controls.update(1 / 60, null);
      car.input.steer = s.steer;
      car.input.throttle = s.throttle;
      car.input.brake = s.brake;
      car.input.handbrake = s.handbrake;
      if (extra) extra(car);
      car.step(dt); car.step(dt);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. STEERING LOCK FALLS WITH SPEED
// ---------------------------------------------------------------------------
console.log('road-wheel angle at full input, starter car, dry asphalt:');
{
  const car = newCar();
  const rows = [];
  let prev = Infinity, monotone = true;
  const lockAt = {};
  for (const kmh of [0, 10, 20, 30, 50, 80, 100, 120, 160, 200]) {
    car.reset(0, 0, 0);
    car.vz = -kmh / 3.6;
    car.input.steer = 1; car.input.throttle = 0.2;
    for (let i = 0; i < 60; i++) { car.step(dt); car.vx = 0; car.vz = -kmh / 3.6; car.yaw = 0; car.yawRate = 0; }
    const deg = car.steerLock * DEG;
    lockAt[kmh] = deg;
    if (deg > prev + 1e-6) monotone = false;
    prev = deg;
    rows.push(`${String(kmh).padStart(4)} km/h ${deg.toFixed(1).padStart(5)} deg`);
  }
  console.log('  ' + rows.join('\n  '));
  check('lock is tens of degrees when parking', lockAt[0] >= 30 && lockAt[10] >= 30,
    `${lockAt[0].toFixed(1)} deg at rest, ${lockAt[10].toFixed(1)} at 10 km/h`);
  check('lock is a few degrees at speed', lockAt[80] <= 10 && lockAt[100] <= 9 && lockAt[120] <= 8.5,
    `${lockAt[80].toFixed(1)} deg at 80 km/h (was 16.3 at 81), ${lockAt[100].toFixed(1)} at 100, ${lockAt[120].toFixed(1)} at 120`);
  check('lock never grows with speed', monotone, monotone ? 'monotone from 0 to 200 km/h' : 'rises somewhere');
}

// ---------------------------------------------------------------------------
// 2. THE KEYBOARD RAMP
// ---------------------------------------------------------------------------
{
  const kb = keyboard();
  const steer = () => kb.controls.update(1 / 60, null).steer;
  const timeTo = (pred, max = 2) => { for (let t = 1 / 60; t <= max + 1e-9; t += 1 / 60) if (pred(steer())) return t; return Infinity; };
  kb.down('KeyD');
  const build = timeTo((s) => s >= 1);
  kb.up('KeyD');
  const back = timeTo((s) => s === 0);
  kb.down('KeyD'); timeTo((s) => s >= 1); kb.up('KeyD'); kb.down('KeyA');
  let through = -1, full = -1;
  for (let t = 1 / 60; t < 1; t += 1 / 60) {
    const s = steer();
    if (through < 0 && s <= 0) through = t;
    if (full < 0 && s <= -1) { full = t; break; }
  }
  kb.up('KeyA');
  check('a held key builds lock over 0.15-0.3 s', build >= 0.15 - 1e-9 && build <= 0.3,
    `full lock after ${build.toFixed(3)} s`);
  check('letting go returns faster than it builds', back < build,
    `centre after ${back.toFixed(3)} s (builds in ${build.toFixed(3)})`);
  check('a reversal unwinds at the return rate', Math.abs(through - back) < 1 / 60 + 1e-9,
    `D to A: through centre in ${through.toFixed(3)} s, full opposite lock in ${full.toFixed(3)} s`);
}

// ---------------------------------------------------------------------------
// 3. THE CAR STRAIGHTENS ITSELF — the brief's test, through the real keys
// ---------------------------------------------------------------------------
// From speed on flat asphalt, hold D (or A) for 1.0 s, then let go. The
// throttle holds the speed, as in a standard constant-speed step-steer test.
// Must still TURN (heading >= 20 deg during the input), stay composed (body
// slip <= 6 deg), and within 0.8 s of release be straight (slip < 2 deg, yaw
// rate < 0.1 rad/s) without wagging its tail (at most one sign change of slip).
function stepSteer({ id = STARTER, kmh, key, throttle = 'hold', settings = {} }) {
  const car = newCar(id, ASPHALT, settings);
  const v0 = kmh / 3.6;
  car.vz = -v0;
  // Settle into the right gear at the test speed first.
  for (let i = 0; i < 90; i++) { car.input.throttle = 0.3; car.step(dt); car.vx = 0; car.vz = -v0; car.yaw = 0; car.yawRate = 0; }
  const kb = keyboard();
  const pedal = (c) => {
    c.input.throttle = throttle === 'full' ? 1 : throttle === 'lift' ? 0
      : Math.max(0, Math.min(1, 0.35 + (v0 - c.speed) * 0.5));
  };
  kb.down(key);
  let t = 0, peak = 0, heading = 0, settle = -1, signs = 0, lastSign = 0, released = false;
  const yaw0 = car.yaw;
  for (let f = 0; f < 60 * 3; f++) {
    if (!released && t >= 1.0 - 1e-9) { heading = Math.abs(car.yaw - yaw0) * DEG; kb.up(key); released = true; }
    kb.frame(car, pedal);
    t += 1 / 60;
    const slip = car.bodySlip * DEG;
    if (t <= 1.8) peak = Math.max(peak, Math.abs(slip));
    if (released && t <= 1.8) {
      const sg = Math.abs(slip) < 0.3 ? 0 : Math.sign(slip);
      if (sg !== 0) { if (lastSign !== 0 && sg !== lastSign) signs++; lastSign = sg; }
      const calm = Math.abs(slip) < 2 && Math.abs(car.yawRate) < 0.1;
      if (calm && settle < 0) settle = t - 1.0;
      if (!calm) settle = -1;
    }
  }
  return { heading, peak, settle, signs, end: car.speed * 3.6 };
}
const verdict = (r) => r.heading >= 20 && r.peak <= 6 && r.settle >= 0 && r.settle <= 0.8 && r.signs <= 1;
const line = (r) => `heading ${r.heading.toFixed(1)} deg, peak slip ${r.peak.toFixed(1)} deg, ` +
  `straight ${r.settle < 0 ? 'NEVER' : `${r.settle.toFixed(2)} s`} after release, ${r.signs} sign change(s)`;
console.log('\nhold a key for 1.0 s, then let go (starter car, default assists):');
for (const kmh of [80, 120]) {
  for (const key of ['KeyD', 'KeyA']) {
    const r = stepSteer({ kmh, key });
    check(`${key === 'KeyD' ? 'D' : 'A'} at ${kmh} km/h turns, then straightens itself`, verdict(r), line(r));
  }
}

// The way a kid actually drives: W held the whole time, or W let go at the
// same moment as the steering key. Heading is not asserted — a car that is
// accelerating hard runs wide and one that is slowing turns tighter, and both
// are right — but it must stay composed and come back on its own.
{
  const worst = { peak: 0, settle: 0, signs: 0, where: '' };
  for (const throttle of ['full', 'lift']) {
    for (const kmh of [80, 120]) {
      const r = stepSteer({ kmh, key: 'KeyD', throttle });
      if (r.peak > worst.peak) { worst.peak = r.peak; worst.where = `${throttle} at ${kmh}`; }
      worst.settle = Math.max(worst.settle, r.settle < 0 ? 9 : r.settle);
      worst.signs = Math.max(worst.signs, r.signs);
    }
  }
  check('flat out or lifting, it still straightens itself',
    worst.peak <= 7.5 && worst.settle <= 0.8 && worst.signs <= 1,
    `worst peak slip ${worst.peak.toFixed(1)} deg (${worst.where}), ` +
    `slowest recovery ${worst.settle.toFixed(2)} s, ${worst.signs} sign change(s)`);
}

// Every car in the garage at 80 km/h, and the stability half of the test at
// 120. At 120 the heading figure is set by grip: a car good for 0.95 g cannot
// turn its path more than 16 degrees a second there, so only the cars that
// can reach 20 are asked to.
{
  const bad = [];
  let worstPeak = 0, worstSettle = 0, minHeading80 = 99;
  for (const c of CARS) {
    for (const throttle of ['hold', 'full', 'lift']) {
      const r80 = stepSteer({ id: c.id, kmh: 80, key: 'KeyD', throttle });
      const r120 = stepSteer({ id: c.id, kmh: 120, key: 'KeyA', throttle });
      minHeading80 = Math.min(minHeading80, r80.heading);
      worstPeak = Math.max(worstPeak, r80.peak, r120.peak);
      worstSettle = Math.max(worstSettle, r80.settle < 0 ? 9 : r80.settle, r120.settle < 0 ? 9 : r120.settle);
      const ok80 = r80.heading >= 20 && r80.peak <= 7.5 && r80.settle >= 0 && r80.settle <= 0.8 && r80.signs <= 1;
      const ok120 = r120.peak <= 7.5 && r120.settle >= 0 && r120.settle <= 0.8 && r120.signs <= 1;
      if (!ok80) bad.push(`${c.id} ${throttle} 80: ${line(r80)}`);
      if (!ok120) bad.push(`${c.id} ${throttle} 120: ${line(r120)}`);
    }
  }
  check('every car in the garage turns and straightens',
    bad.length === 0,
    bad.length ? bad.slice(0, 3).join(' | ') :
      `15 cars x 3 throttle styles: heading >= ${minHeading80.toFixed(1)} deg at 80 km/h, ` +
      `worst slip ${worstPeak.toFixed(1)} deg, slowest recovery ${worstSettle.toFixed(2)} s`);
}

// ---------------------------------------------------------------------------
// 4. GRIPPY AND PREDICTABLE — and still fun
// ---------------------------------------------------------------------------
{
  // Understeer-biased: cornering flat out on full lock, the FRONT tyres are the
  // ones at their limit. Every car, because a nose-heavy car whose rear let go
  // first is the car that spun the kids.
  const oversteerers = [];
  for (const c of CARS) {
    const car = newCar(c.id);
    car.vz = -80 / 3.6;
    let fs = 0, rs = 0, n = 0;
    for (let i = 0; i < 120 * 4; i++) {
      car.input.steer = 1;
      car.input.throttle = Math.max(0, Math.min(1, 0.35 + (80 / 3.6 - car.speed) * 0.5));
      car.step(dt);
      if (i > 240) { fs += Math.abs(car.wheels[0].slipAngle); rs += Math.abs(car.rearSlip); n++; }
    }
    if (rs / n >= fs / n) oversteerers.push(`${c.id} front ${(fs / n * DEG).toFixed(1)} rear ${(rs / n * DEG).toFixed(1)}`);
  }
  check('every car understeers at the limit', oversteerers.length === 0,
    oversteerers.length ? oversteerers.join(', ') : 'front slip exceeds rear slip on full lock at 80 km/h, all 15 cars');
}

/** A car already sliding: 25 deg of body slip at 80 km/h, rotating into it. */
function sliding(settings, countersteer = 1) {
  const car = newCar(STARTER, ASPHALT, settings);
  car.aids.countersteer = countersteer;
  const v = 80 / 3.6, b = 25 / DEG;
  // Travelling along -Z with the nose 25 deg to the right of it, still
  // rotating right: the tail is out to the left, a right-hand slide.
  car.vx = 0; car.vz = -v;
  car.yaw = -b; car.yawRate = -0.6;
  return car;
}
function recoverTime(car, seconds = 4) {
  for (let i = 0; i < 120 * seconds; i++) {
    car.input.steer = 0; car.input.throttle = 0.2; car.input.brake = 0; car.input.handbrake = 0;
    car.step(dt);
    if (Math.abs(car.bodySlip) < 2 / DEG && Math.abs(car.yawRate) < 0.1 && i > 12) return i * dt;
  }
  return Infinity;
}
{
  // Hands off the keys in a slide: ESC and the countersteer assist together
  // catch it. With both removed — a raw car and nobody at the wheel — it goes.
  const withAids = recoverTime(sliding({}));
  const escOff = recoverTime(sliding({ esc: false }));
  const nothing = recoverTime(sliding({ esc: false }, 0));
  check('ESC and the countersteer assist catch a slide', withAids < 1.2 && escOff < 2.5,
    `25 deg at 80 km/h, hands off: straight in ${withAids.toFixed(2)} s with ESC, ` +
    `${escOff.toFixed(2)} s with only the assist, ${Number.isFinite(nothing) ? `${nothing.toFixed(2)} s` : 'never'} with neither`);

  // The countersteer is real: with no key held, the front wheels turn toward
  // where the car is going — left, in a slide whose tail is out to the left.
  const car = sliding({});
  for (let i = 0; i < 12; i++) { car.input.steer = 0; car.input.throttle = 0.2; car.step(dt); }
  check('the front wheels follow the slide', car.steerAngle < -0.05 && car.assist > 0.5,
    `no key held, tail out left: wheels ${(-car.steerAngle * DEG).toFixed(1)} deg to the LEFT ` +
    `after 0.1 s, assist at ${(car.assist * 100).toFixed(0)}%`);
}

{
  // The handbrake still swings the tail, ESC on — and ESC then catches it.
  const car = newCar();
  car.vz = -60 / 3.6;
  const kb = keyboard();
  kb.down('KeyD'); kb.down('Space'); kb.down('KeyW');
  let peak = 0;
  for (let f = 0; f < 60 * 0.7; f++) { kb.frame(car); peak = Math.max(peak, Math.abs(car.bodySlip) * DEG); }
  kb.up('Space'); kb.up('KeyD');
  let back = -1;
  for (let f = 0; f < 60 * 4; f++) {
    kb.frame(car);
    peak = Math.max(peak, Math.abs(car.bodySlip) * DEG);
    if (back < 0 && Math.abs(car.bodySlip) < 3 / DEG && Math.abs(car.yawRate) < 0.15) back = (f + 1) / 60;
  }
  kb.up('KeyW');
  check('the handbrake swings the rear, ESC on', peak >= 20 && back > 0 && back < 2.5,
    `D + Space for 0.7 s at 60 km/h: ${peak.toFixed(0)} deg of slip, straight again ${back.toFixed(2)} s after letting go`);
}

{
  // ESC off still drifts, on keys alone: flick it with the handbrake at
  // 50 km/h, then hold D and W. That is the whole technique — the
  // countersteer assist does the countersteering a key cannot — and it is
  // the car the catalogue calls the one to learn to drift in.
  const car = newCar('kaze', ASPHALT, { esc: false });
  car.vz = -50 / 3.6;
  const kb = keyboard();
  kb.down('KeyD'); kb.down('Space');
  for (let f = 0; f < 60 * 0.45; f++) kb.frame(car);
  kb.up('Space'); kb.down('KeyW');
  let sideways = 0, peak = 0;
  for (let f = 0; f < 60 * 6; f++) {
    kb.frame(car);
    const deg = Math.abs(car.bodySlip) * DEG;
    peak = Math.max(peak, deg);
    if (deg > 15 && car.speed > 8) sideways += 1 / 60;
  }
  kb.up('KeyW'); kb.up('KeyD');
  check('with ESC off it still drifts, on keys', sideways > 3.5 && peak < 60,
    `drift-school coupe, flick then hold D and W: ${sideways.toFixed(1)} s past 15 deg ` +
    `in 6 s, never past ${peak.toFixed(0)} deg`);
}

{
  // Analogue sources scale the same range: half a stick is roughly half the
  // cornering, full stick is the key.
  const g = (steer) => {
    const car = newCar();
    car.vz = -80 / 3.6;
    let lat = 0, n = 0;
    for (let i = 0; i < 120 * 3; i++) {
      car.input.steer = steer;
      car.input.throttle = Math.max(0, Math.min(1, 0.35 + (80 / 3.6 - car.speed) * 0.5));
      car.step(dt);
      if (i > 240) { lat += Math.abs(car.latG); n++; }
    }
    return lat / n;
  };
  const quarter = g(0.25), half = g(0.5), full = g(1);
  check('a stick or a phone wheel gets a sensible range', quarter < half && half < full && half > 0.35 * full && half < 0.85 * full,
    `at 80 km/h: quarter input ${quarter.toFixed(2)} g, half ${half.toFixed(2)} g, full ${full.toFixed(2)} g`);
}

// ---------------------------------------------------------------------------
// 5. OFF-ROAD COSTS SOMETHING
// ---------------------------------------------------------------------------
function topSpeed(id, surface) {
  const car = newCar(id, flat(surface));
  for (let i = 0; i < 120 * 60; i++) { car.input.throttle = 1; car.step(dt); }
  return car.speed * 3.6;
}
{
  const tar = topSpeed(STARTER, 'asphalt');
  const grass = topSpeed(STARTER, 'grass');
  const gravel = topSpeed(STARTER, 'gravel');
  const sand = topSpeed(STARTER, 'sand');
  check('a field cannot be taken at road speed', grass / tar <= 0.6 && grass / tar >= 0.35,
    `starter flat out: asphalt ${tar.toFixed(0)}, gravel road ${gravel.toFixed(0)}, ` +
    `grass ${grass.toFixed(0)} (${(grass / tar * 100).toFixed(0)}%), sand ${sand.toFixed(0)} km/h`);
  const saloonTar = topSpeed('v340', 'asphalt'), saloonGrass = topSpeed('v340', 'grass');
  check('a road car is worse off the road than a rally car', saloonGrass / saloonTar < grass / tar,
    `rear-drive saloon: asphalt ${saloonTar.toFixed(0)}, grass ${saloonGrass.toFixed(0)} km/h ` +
    `(${(saloonGrass / saloonTar * 100).toFixed(0)}%)`);

  // And the lead's field run: off the road at road speed, sliding, W held.
  // It used to go from 81 km/h to 143 across the grass. Now the field takes
  // the speed off, however hard the throttle is pressed.
  const car = newCar(STARTER, flat('grass'));
  car.vz = -140 / 3.6;
  car.yaw = -15 / DEG; car.yawRate = -0.3;
  let peakKmh = 0;
  for (let i = 0; i < 120 * 6; i++) { car.input.throttle = 1; car.input.steer = 0; car.step(dt); peakKmh = Math.max(peakKmh, car.speed * 3.6); }
  check('off the road at road speed, the field takes the speed off', peakKmh <= 140.5 && car.speed * 3.6 < grass + 5,
    `into grass at 140 km/h, 15 deg sideways, W held for 6 s: ${(car.speed * 3.6).toFixed(0)} km/h, ` +
    `never above ${peakKmh.toFixed(0)} (grass top speed ${grass.toFixed(0)})`);
}

// ---------------------------------------------------------------------------
// 6. PULLING AWAY
// ---------------------------------------------------------------------------
function launch(id) {
  const car = newCar(id);
  // Sitting on the title screen: main.js holds brake and handbrake, which
  // selects reverse at rest. Then W, through the real keyboard.
  for (let i = 0; i < 240; i++) { car.input.brake = 1; car.input.handbrake = 1; car.step(dt); }
  const kb = keyboard();
  kb.down('KeyW');
  let t = 0, t11 = -1, t100 = -1, weakest = Infinity, prev = 0;
  for (let f = 0; f < 60 * 20; f++) {
    kb.frame(car);
    t += 1 / 60;
    const kmh = car.speed * 3.6;
    if (t11 < 0 && kmh >= 11) t11 = t;
    if (t100 < 0 && kmh >= 100) t100 = t;
    // The weakest pull on the way to 50 km/h, gear changes included.
    if (kmh < 50 && t > 1 / 30) weakest = Math.min(weakest, (kmh - prev) / 3.6 * 60 / 9.81);
    prev = kmh;
  }
  kb.up('KeyW');
  return { t11, t100, weakest };
}
{
  const s = launch(STARTER);
  check('pulling away has no dead spot', s.t11 > 0 && s.t11 < 0.5 && s.weakest > 0.2,
    `starter from the title screen: 11 km/h in ${s.t11.toFixed(2)} s (was 1 s, then a stall), ` +
    `never below ${s.weakest.toFixed(2)} g on the way to 50`);
  check('the starter is quick, for what it is', s.t100 > 3 && s.t100 < 5,
    `0-100 in ${s.t100.toFixed(2)} s — a 280 hp all-wheel-drive homologation special`);
  const h = launch('lark');
  check('a small hatch takes 8-11 s to 100', h.t100 >= 8 && h.t100 <= 11,
    `city hatch 0-100 in ${h.t100.toFixed(2)} s, 11 km/h in ${h.t11.toFixed(2)} s`);
}

// ---------------------------------------------------------------------------
// 7. INVARIANTS
// ---------------------------------------------------------------------------
{
  // Right is still right, through the keys.
  const car = newCar();
  car.vz = -20;
  const kb = keyboard();
  kb.down('KeyD'); kb.down('KeyW');
  for (let f = 0; f < 120; f++) kb.frame(car);
  kb.up('KeyD'); kb.up('KeyW');
  check('pressing D moves the car to +X', car.x > 3 && car.yaw < 0,
    `after 2 s of D at 72 km/h: x ${car.x.toFixed(1)} m, yaw ${car.yaw.toFixed(2)} rad`);
}
{
  // No energy from nowhere: coasting on the flat, every kind of slide, every
  // aid setting — translational plus rotational kinetic energy only ever falls.
  let worst = 0, cases = 0, where = '';
  for (const settings of [{}, { esc: false }, { esc: false, tc: false, abs: false }]) {
    for (const [slipDeg, yawRate, kmh] of [[0, 0, 100], [20, -0.8, 90], [60, 1.5, 70], [120, -2, 60], [-35, 0.4, 120]]) {
      for (const steer of [0, 1, -0.5]) {
        const car = newCar(STARTER, ASPHALT, settings);
        const v = kmh / 3.6, b = slipDeg / DEG;
        car.vx = Math.sin(b) * v; car.vz = -Math.cos(b) * v; car.yawRate = yawRate;
        car.step(dt);
        const energy = () => 0.5 * car.spec.mass * car.speed * car.speed + 0.5 * car.yawInertia * car.yawRate * car.yawRate;
        let e = energy();
        for (let i = 0; i < 120 * 4; i++) {
          car.input.throttle = 0; car.input.brake = 0; car.input.handbrake = 0; car.input.steer = steer;
          car.step(dt);
          const e2 = energy();
          const rise = (e2 - e) / Math.max(1, e);
          if (rise > worst) { worst = rise; where = `${slipDeg} deg at ${kmh} km/h, steer ${steer}, ${JSON.stringify(settings)}`; }
          e = e2;
        }
        cases++;
      }
    }
  }
  check('coasting never gains energy', worst < 1e-6,
    `${cases} coasting runs, worst single-step rise ${(worst * 100).toExponential(1)}%${worst > 1e-6 ? ` (${where})` : ''}`);
}

console.log(fail === 0 ? '\nAll handling checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
