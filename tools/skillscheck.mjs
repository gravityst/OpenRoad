// Checks the long game: the skill-chain maths and its detectors, the level
// curve and what every level pays, that the daily challenges are the same
// three for everybody on the same day, the streak across month ends, and that
// a round-one save survives the move to schema v2.
//
// The failure this exists to prevent is a quiet one. A chain that banks the
// wrong number, a daily that changes when the page reloads, a streak that
// loses a day to the clocks going forward, a migration that pays the level
// rewards twice — none of these crash, and every one of them is the kind of
// thing a kid notices before anybody else does ("it said 12,000 and I got
// 9,000"). So the arithmetic is pinned here, the detectors are driven through
// staged traffic whose geometry is known exactly, and at the end the REAL car
// is driven through REAL traffic to see what a few minutes of play pays.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createCarCollision } from '../src/physics/collision.js';
import { createTraffic } from '../src/ai/traffic.js';
import { createDrift } from '../src/game/drift.js';
import { CARS, specFor } from '../src/vehicles/catalog.js';
import {
  createSkills, chainMultiplier, chainValue, chainPayout, nearMissPoints, airPoints, CHAIN,
  SKILL_XP_PER, SKILL_CASH_PER,
} from '../src/game/skills.js';
import {
  xpForLevel, levelFor, levelReward, levelCash, PAINTS, TROPHIES, DAILY_TEMPLATES,
  pickDailies, localDay, shiftDay, parseDay, daySeed,
} from '../src/game/career.js';
import { createProgress, migrate, sanitize, PROGRESS_KEY, PROGRESS_VERSION, CAR_PRICES } from '../src/game/progress.js';
import { generateChallenges, speedProfile } from '../src/game/challenges.js';
import { createGoals } from '../src/game/goals.js';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
  if (!ok) fail++;
};

// This thread's CPU time in microseconds: time the scheduler gave the core to
// someone else is not in it. process.threadCpuUsage() is Node 23.9 and later;
// before that the whole process's figure is the nearest there is (it also
// counts V8's helper threads, so it can only read long, never short).
const CPU_CLOCK = process.threadCpuUsage ? 'thread CPU' : 'process CPU';
const cpuRead = process.threadCpuUsage ? () => process.threadCpuUsage() : () => process.cpuUsage();
const cpuNow = () => { const c = cpuRead(); return c.user + c.system; };
const cpuSince = (c0) => cpuNow() - c0;

function memoryStorage(seed) {
  const m = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get: (k) => m.get(k),
  };
}

// ---------------------------------------------------------------------------
console.log('\n-- chain maths --');
{
  const m = [0, 1, 2, 3, 10, 19, 20, 60, NaN].map(chainMultiplier);
  check('the multiplier climbs by half a link, to x10',
    m[0] === 1 && m[1] === 1 && m[2] === 1.5 && m[3] === 2 && m[4] === 5.5 && m[5] === 10 && m[6] === 10 && m[7] === 10 && m[8] === 1,
    `links 0,1,2,3,10,19,20,60,NaN -> ${m.join(', ')}`);
  check('the multiplier applies to the whole chain',
    chainValue(1000, 3) === 2000 && chainValue(1234, 1) === 1234 && chainValue(NaN, 5) === 0 && chainValue(-5, 5) === 0,
    `1,000 pts over 3 links banks ${chainValue(1000, 3)}; NaN and negative bank 0`);
  const p = chainPayout(8000), z = chainPayout(NaN);
  check('a banked chain pays XP and cash at fixed rates',
    p.xp === Math.floor(8000 / SKILL_XP_PER) && p.cash === Math.floor(8000 / SKILL_CASH_PER) && z.xp === 0 && z.cash === 0,
    `8,000 -> ${p.xp} XP and $${p.cash}; NaN -> nothing`);
  const closer = nearMissPoints(0.2, 25, false) > nearMissPoints(1.0, 25, false);
  const onc = nearMissPoints(0.8, 25, true) > nearMissPoints(0.8, 25, false);
  const faster = nearMissPoints(0.8, 38, false) > nearMissPoints(0.8, 20, false);
  check('closer, oncoming and faster near misses pay more', closer && onc && faster,
    `0.2 m ${nearMissPoints(0.2, 25)} vs 1.0 m ${nearMissPoints(1.0, 25)}; oncoming ${nearMissPoints(0.8, 25, true)} vs ${nearMissPoints(0.8, 25)}`);
  check('one big jump beats two small ones', airPoints(2) > 2 * airPoints(1) && airPoints(0.3) === 0,
    `2.0 s ${airPoints(2)} against 2 x 1.0 s ${2 * airPoints(1)}; a 0.3 s bump ${airPoints(0.3)}`);
}

// ---------------------------------------------------------------------------
// A staged car and staged traffic. The player drives straight up -Z at a
// fixed speed; each traffic car is placed so the gap between the two bodies
// is known to the centimetre (collision.js's own box sizes).
const SPEC = { track: 1.62, wheelbase: 2.58 };
const AHW = SPEC.track / 2 + 0.16;
function stagedCar(speed = 25) {
  return { x: 0, z: 0, yaw: 0, vx: 0, vz: -speed, speed, airborne: false, spec: SPEC };
}
function trafficCar(id, x, z, yaw, speed) {
  return { id, active: true, respawnId: 1, x, z, yaw, speed, halfLen: 2.3, spec: { track: 1.6 } };
}
const OHW = 1.6 / 2 + 0.16;
/** Runs `secs` of frames, moving the player and the traffic; returns every event. */
function run(sk, car, cars, secs, opts = {}) {
  const dt = 1 / 60;
  const out = [];
  for (let t = 0; t < secs; t += dt) {
    car.z += car.vz * dt; car.x += (car.vx || 0) * dt;
    for (const o of cars) { o.x += -Math.sin(o.yaw) * o.speed * dt; o.z += -Math.cos(o.yaw) * o.speed * dt; }
    if (opts.each) opts.each(t, car, cars);
    sk.update(dt, car, cars, opts.drift || null, true);
    for (let i = 0; i < sk.eventCount; i++) out.push({ ...sk.event(i) });
    sk.clearEvents();
  }
  return out;
}
const kinds = (evs) => evs.map((e) => e.kind).join(',') || 'none';

console.log('\n-- the chain, staged --');
{
  // Timer and bank.
  const sk = createSkills();
  const car = stagedCar(25);
  const o = trafficCar(0, AHW + OHW + 0.6, -40, 0, 5);            // 0.6 m of daylight, same way
  const ev = run(sk, car, [o], 3);
  const near = ev.find((e) => e.kind === 'near');
  check('a close pass is a near miss, counted once',
    ev.filter((e) => e.kind === 'near').length === 1 && !!near && near.points === nearMissPoints(0.6, 25, false),
    `events ${kinds(ev)}, ${near ? near.points : 0} pts for 0.6 m at 90 km/h`);
  const live = sk.state.live && Math.abs(sk.state.timer - (CHAIN.BANK_TIME - (3 - 1.6))) < 1.0;
  const ev2 = run(sk, car, [], CHAIN.BANK_TIME + 0.2);
  const bank = ev2.find((e) => e.kind === 'bank');
  check('a chain banks after its timer runs out, for its value', live && !!bank && bank.amount === near.points && !sk.state.live,
    `banked ${bank ? bank.amount : 'nothing'} ${CHAIN.BANK_TIME} s after the last link`);
}
{
  const sk = createSkills();
  const car = stagedCar(25);
  const far = trafficCar(0, AHW + OHW + 2.5, -40, 0, 5);
  const touch = trafficCar(1, -(AHW + OHW + 0.02), -80, 0, 5);
  const ev = run(sk, car, [far, touch], 5);
  check('2.5 m is not near, and touching is not a miss', !ev.some((e) => e.kind === 'near'), `events ${kinds(ev)}`);
}
{
  const sk = createSkills();
  const car = stagedCar(20);
  const o = trafficCar(0, AHW + OHW + 0.5, 30, 0, 32);           // coming up from behind, faster
  const ev = run(sk, car, [o], 5);
  check('being overtaken is the other driver\'s skill', !ev.some((e) => e.kind === 'near'), `events ${kinds(ev)}`);
}
{
  const sk = createSkills();
  const car = stagedCar(22);
  const o = trafficCar(0, AHW + OHW + 0.8, -120, Math.PI, 20);   // oncoming, 0.8 m
  const ev = run(sk, car, [o], 4);
  const e = ev.find((q) => q.kind === 'oncoming');
  check('an oncoming near miss pays half again', !!e && e.points === nearMissPoints(0.8, 22, true),
    `${e ? e.label + ' ' + e.points : 'none'} (same gap, same way: ${nearMissPoints(0.8, 22, false)})`);
}
{
  const sk = createSkills();
  const car = stagedCar(10);
  const o = trafficCar(0, AHW + OHW + 0.4, -30, 0, 0);
  const ev = run(sk, car, [o], 5);
  check('at 36 km/h a close pass is parking, not a skill', !ev.some((e) => e.kind === 'near'), `events ${kinds(ev)}`);
}
{
  const sk = createSkills();
  const car = stagedCar(25);
  const o = trafficCar(0, AHW + OHW + 0.5, -40, 0, 5);
  // Alongside from 1.78 s to 2.22 s (20 m/s closing over a 4.4 m half-span):
  // the slot is recycled half way through.
  const ev = run(sk, car, [o], 3, { each: (t, c, cars) => { if (t > 2.0 && t < 2.0167) cars[0].respawnId++; } });
  check('a recycled traffic slot mid-pass is forgotten', !ev.some((e) => e.kind === 'near'), `events ${kinds(ev)}`);
}
{
  // Slipstream: a car 10 m ahead in my lane, both at 25 m/s.
  const sk = createSkills();
  const car = stagedCar(25);
  const o = trafficCar(0, 0.3, -(2.3 + 1.81 + 10), 0, 25);
  const ev = run(sk, car, [o], 4.2);
  const tows = ev.filter((e) => e.kind === 'tow');
  const held = sk.state.hold && sk.state.towing;
  check('a slipstream links at 1.5 s and every 2.5 s after', tows.length === 2 && held,
    `${tows.length} tow links in 4.2 s, timer held ${held}`);
  // Pull out and pass it: the slingshot.
  car.x = 3.2; car.vz = -33; car.speed = 33;
  const ev2 = run(sk, car, [o], 3);
  check('pulling out of the tow and passing is a slingshot', ev2.some((e) => e.kind === 'sling'), `events ${kinds(ev2)}`);
}
{
  const sk = createSkills();
  const car = stagedCar(25);
  car.airborne = true;
  let ev = run(sk, car, [], 1.3);
  const holding = sk.state.hold;
  car.airborne = false;
  ev = ev.concat(run(sk, car, [], 0.1));
  const air = ev.find((e) => e.kind === 'air');
  check('1.3 s of air is BIG AIR, and holds the timer while flying',
    !!air && air.label === 'BIG AIR' && Math.abs(air.points - airPoints(1.3)) <= 30 && holding,
    `${air ? air.label + ' ' + air.points : 'none'} (${airPoints(1.3)} expected)`);
  const sk2 = createSkills();
  const c2 = stagedCar(25);
  c2.airborne = true;
  run(sk2, c2, [], 0.8);
  c2.z -= 500;                               // a cut while in the air
  c2.airborne = false;
  const ev2 = run(sk2, c2, [], 0.2);
  check('a teleport mid-air is not a jump', !ev2.some((e) => e.kind === 'air'), `events ${kinds(ev2)}`);
}
{
  const sk = createSkills();
  const car = stagedCar(145 / 3.6);
  let ev = run(sk, car, [], 10);
  const first = ev.filter((e) => e.kind === 'speed').length;
  car.speed = 110 / 3.6; car.vz = -car.speed;
  ev = run(sk, car, [], 1);
  car.speed = 145 / 3.6; car.vz = -car.speed;
  ev = run(sk, car, [], 1.5);
  const again = ev.filter((e) => e.kind === 'speed').length;
  check('a speed milestone pays once per run at it, not per second', first === 1 && again === 1,
    `ten seconds at 145 km/h: ${first} link; down to 110 and back: ${again} more`);
}
{
  // 36 km/h: under the clean-driving clock's 40, so no clean link lands in
  // the middle of this and resets the timer being measured.
  const sk = createSkills();
  const car = stagedCar(10);
  const drift = { banked: 0, active: false, combo: 0 };
  run(sk, car, [], 0.5, { drift });
  drift.active = true; drift.combo = 1;
  run(sk, car, [], 1, { drift });
  drift.banked = 1234; drift.active = false; drift.combo = 0;
  const ev = run(sk, car, [], 0.2, { drift });
  const d = ev.find((e) => e.kind === 'drift');
  check('a banked drift becomes a link, point for point', !!d && d.points === 1234, `${d ? d.points : 'none'}`);
  // Now hold the chain open with a live drift for longer than the bank time.
  drift.active = true; drift.combo = 1;
  run(sk, car, [], CHAIN.BANK_TIME + 2, { drift });
  const stillLive = sk.state.live;
  drift.active = false; drift.combo = 0;
  const ev2 = run(sk, car, [], CHAIN.BANK_TIME + 0.2, { drift });
  check('the timer waits for a drift in progress', stillLive && ev2.some((e) => e.kind === 'bank'),
    `live after ${CHAIN.BANK_TIME + 2} s sideways: ${stillLive}; banked once it ended`);
}
{
  const sk = createSkills();
  const car = stagedCar(20);
  let ev = run(sk, car, [], 15.2);
  const clean = ev.find((e) => e.kind === 'clean');
  sk.onCrash(0.1);                          // a scrape
  const scraped = sk.state.live && sk.state.cleanT === 0;
  sk.onCrash(0.03);                         // a kiss: nothing
  sk.onCrash(0.3);                          // a crash
  ev = run(sk, car, [], 0.05);
  check('15 s clean is a link; a scrape resets the clock but keeps the chain',
    !!clean && clean.points === 150 && scraped, `clean ${clean ? clean.label : 'none'}, after a scrape chain live ${sk.state.live || scraped}`);
  const lost = sk.state.last.kind === 'lost' && !sk.state.live;
  check('a real crash loses the whole chain, and banks nothing', lost, `last chain: ${sk.state.last.kind}, ${sk.state.last.value} pts lost`);
}
{
  const sk = createSkills();
  const car = stagedCar(25);
  const o = trafficCar(0, AHW + OHW + 0.6, -40, 0, 5);
  run(sk, car, [o], 3);
  const was = sk.state.value;
  car.z -= 400;
  const ev = run(sk, car, [], 0.05);
  check('a teleport banks the chain rather than losing it', ev.some((e) => e.kind === 'bank' && e.amount === was), `events ${kinds(ev)}`);
  const s2 = createSkills();
  s2.update(0, car, null, null, true);
  s2.update(NaN, car, null, null, true);
  s2.update(1 / 60, { ...car, speed: NaN, x: NaN }, null, null, true);
  const st = s2.state;
  check('dt of 0 or NaN, and a NaN car, leave no NaN behind',
    [st.value, st.timer, st.points, st.mult, st.cleanT].every(Number.isFinite), `value ${st.value}, timer ${st.timer}`);
}
{
  // Cost with a full traffic pool alongside.
  const sk = createSkills();
  const car = stagedCar(30);
  const cars = [];
  for (let i = 0; i < 88; i++) cars.push(trafficCar(i, ((i % 8) - 4) * 3.1, -((i / 8) | 0) * 9, i % 3 ? 0 : Math.PI, 20));
  for (let i = 0; i < 600; i++) sk.update(1 / 60, car, cars, null, true);
  // Five batches of 4,000 and the FASTEST batch is the figure — the same
  // 20,000 frames as before, the same 40 us budget. The review measured this
  // at 2.7-8 us on a machine shared by five engineers' harness runs: the
  // spread is the scheduler, not the detectors, and a single long batch
  // counts every time another process holds the core. The minimum of
  // repeated batches is the standard way to time code on a busy machine;
  // it is still the full per-frame cost of every frame in that batch.
  const N = 4000;
  let us = Infinity;
  for (let b = 0; b < 5; b++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { car.z -= 0.5; sk.update(1 / 60, car, cars, null, true); sk.clearEvents(); }
    us = Math.min(us, ((performance.now() - t0) / N) * 1000);
  }
  check('the detectors cost little per frame', us < 40, `${us.toFixed(1)} us a frame against 88 traffic cars (budget 40 us, fastest of 5 x 4,000)`);
}

// ---------------------------------------------------------------------------
console.log('\n-- levels and what they pay --');
{
  let steps = true, exact = true;
  for (let n = 1; n < 99; n++) {
    if (xpForLevel(n + 1) - xpForLevel(n) !== 80 * n + 40) steps = false;
    if (levelFor(xpForLevel(n)).level !== n) exact = false;
    if (n > 1 && levelFor(xpForLevel(n) - 1).level !== n - 1) exact = false;
  }
  check('each level costs 80 XP more than the last', steps, `level 2 at ${xpForLevel(2)}, 5 at ${xpForLevel(5)}, 10 at ${xpForLevel(10)}, 20 at ${xpForLevel(20)}`);
  check('levelFor is exact on every boundary', exact, 'levels 1 to 99, at and one XP under each');
  let above = true;
  for (let n = 2; n <= 99; n++) if (xpForLevel(n) >= 100 * n * (n - 1)) above = false;
  check('no one levels down from round one\'s curve', above, 'the new curve is under 100 n (n-1) at every level past 1');
  const fr = levelFor(NaN), neg = levelFor(-50), top = levelFor(1e12);
  check('garbage XP is level 1, absurd XP is the cap', fr.level === 1 && neg.level === 1 && top.level === 99 && top.frac === 1,
    `NaN -> ${fr.level}, -50 -> ${neg.level}, 1e12 -> ${top.level}`);

  // A player who levels from 1 to 70 with nothing bought: every level pays,
  // every car arrives by level 60, nothing is paid twice.
  const p = createProgress({ storage: memoryStorage(), cars: CARS, today: () => '2026-09-23' });
  p.drainEvents([]);
  p.bankChain(1, xpForLevel(70), 0);
  const evs = p.drainEvents([]).filter((e) => e.type === 'level');
  const carsGot = evs.filter((e) => e.reward.type === 'car').map((e) => e.reward.id);
  const paintsGot = evs.filter((e) => e.reward.type === 'paint').map((e) => e.reward.id);
  const paid = Object.keys(CAR_PRICES).filter((id) => CAR_PRICES[id] > 0);
  check('every level from 2 to 70 pays something', evs.length === 69 && evs.every((e) => e.reward && (e.reward.type !== 'cash' || e.reward.amount > 0)),
    `${evs.length} level rewards: ${carsGot.length} cars, ${paintsGot.length} paints, ${evs.length - carsGot.length - paintsGot.length} cash`);
  check('every paid car arrives by level 60, never twice', paid.every((id) => p.owns(id)) && new Set(carsGot).size === carsGot.length &&
    evs.filter((e) => e.reward.type === 'car').every((e) => e.level <= 60),
    `${carsGot.length} cars, cheapest first: ${carsGot.slice(0, 3).join(', ')}...`);
  check('no paint is handed out twice', new Set(paintsGot).size === paintsGot.length, `${paintsGot.length} paints`);
  const own = { car: (id) => id === 'haulier', paint: (id) => id === 'sunburst', cars: [{ id: 'haulier', name: 'H', price: 400 }, { id: 'scout', name: 'S', price: 650 }] };
  const r5 = levelReward(5, own), r3 = levelReward(3, own);
  check('a reward already owned moves on to the next one', r5.id === 'scout' && r3.id !== 'sunburst' && r3.type === 'paint',
    `level 5 with the Haulier bought gives ${r5.id}; level 3 with Sunburst bought gives ${r3.id}`);
  const next = createProgress({ storage: memoryStorage(), cars: CARS, today: () => '2026-09-23' });
  const nr = next.nextReward();
  next.bankChain(1, xpForLevel(2), 0);
  const got = next.drainEvents([]).find((e) => e.type === 'level');
  check('the reward the HUD promises is the reward that is paid', !!got && JSON.stringify(got.reward) === JSON.stringify(nr.reward),
    `promised ${JSON.stringify(nr.reward)}`);
}

// ---------------------------------------------------------------------------
console.log('\n-- daily challenges --');
{
  const d = new Date(2026, 0, 31, 23, 59, 30);
  check('the day is the player\'s LOCAL date', localDay(d) === '2026-01-31' && parseDay('2026-13-01') === null,
    `23:59 on 31 Jan local is ${localDay(d)}`);
  const cases = [['2026-02-28', 1, '2026-03-01'], ['2028-02-28', 1, '2028-02-29'], ['2026-12-31', 1, '2027-01-01'], ['2026-03-01', -1, '2026-02-28']];
  let ok = cases.every(([a, k, b]) => shiftDay(a, k) === b);
  // Every day of two years, stepped forward and back: a DST change in the
  // machine's own timezone must neither skip a day nor repeat one.
  let day = '2026-01-01', n = 0;
  for (let i = 0; i < 730; i++) {
    const nx = shiftDay(day, 1);
    if (shiftDay(nx, -1) !== day || nx === day) ok = false;
    day = nx; n++;
  }
  check('days step across month, year, leap day and DST', ok && day === '2028-01-01',
    `730 steps from 2026-01-01 land on ${day}`);

  const a = JSON.stringify(pickDailies('2026-09-23')), b = JSON.stringify(pickDailies('2026-09-23'));
  const sets = new Set(), seen = new Set();
  let shapeOk = true;
  day = '2026-01-01';
  for (let i = 0; i < 365; i++) {
    const p = pickDailies(day);
    sets.add(p.map((q) => q.id).join('+'));
    for (const q of p) seen.add(q.id);
    if (p.length !== 3 || new Set(p.map((q) => q.metric)).size !== 3 || p.some((q, t) => q.tier !== t || q.target !== DAILY_TEMPLATES.find((x) => x.id === q.id).targets[t])) shapeOk = false;
    day = shiftDay(day, 1);
  }
  check('the same day gives the same three, everywhere', a === b && daySeed('2026-09-23') === daySeed('2026-09-23'),
    pickDailies('2026-09-23').map((q) => q.text).join(' / '));
  check('three different kinds of thing, easy to hard', shapeOk, 'one per tier, three metrics, targets from the template');
  check('a year of days is a year of variety', sets.size > 250 && seen.size === DAILY_TEMPLATES.length,
    `${sets.size} different sets in 365 days, all ${seen.size} templates used`);
  let refused = true;
  day = '2026-01-01';
  for (let i = 0; i < 365; i++) {
    const p = pickDailies(day, (t) => t.metric !== 'tokens');
    if (p.some((q) => q.metric === 'tokens') || new Set(p.map((q) => q.metric)).size !== 3) refused = false;
    day = shiftDay(day, 1);
  }
  check('a daily the world cannot give is never offered', refused, 'tokens refused: a year of dailies without one, still three each');

  // The streak, walked across a month end.
  let today = '2026-09-29';
  const s = memoryStorage();
  const mk = () => createProgress({ storage: s, cars: CARS, today: () => today });
  let p = mk();
  const finishOne = (prog) => {
    const d0 = prog.daily().list.find((q) => !q.done);
    if (!d0) return;
    if (d0.metric === 'medals') prog.record({ id: 'trap-9', kind: 'trap' }, 200, 1);
    else if (d0.metric === 'tokens') for (let i = 0; i < d0.target; i++) prog.takeToken(900 + i + Math.floor(Math.random() * 90));
    else if (DAILY_TEMPLATES.find((x) => x.id === d0.id).kind === 'peak') prog.peak(d0.metric, d0.target);
    else prog.track(d0.metric, d0.target);
  };
  finishOne(p);
  const s1 = p.daily().streak;
  finishOne(p);                                        // a second one the same day
  const s1b = p.daily().streak;
  today = '2026-09-30'; p = mk(); finishOne(p);
  const s2 = p.daily().streak;
  today = '2026-10-01'; p = mk();
  const due = p.daily().streak === 2 && !p.daily().doneToday;
  finishOne(p);
  const s3 = p.daily().streak;
  today = '2026-10-03'; p = mk();                    // a day missed
  const broken = p.daily().streak;
  finishOne(p);
  const s4 = p.daily().streak;
  check('the streak counts days, not dailies, across a month end',
    s1 === 1 && s1b === 1 && s2 === 2 && due && s3 === 3 && broken === 0 && s4 === 1 && p.streak.best === 3,
    `29th ${s1} (twice ${s1b}), 30th ${s2}, 1st ${s3} (still savable that morning: ${due}), missed the 2nd: ${broken}, 3rd ${s4}, best ${p.streak.best}`);
  const rolled = p.data.daily.day === '2026-10-03';
  today = '2026-10-04';
  const r = p.rollDay();
  check('midnight rolls fresh dailies without a reload', rolled && r && p.data.daily.day === '2026-10-04' && p.daily().doneCount === 0,
    `rolled to ${p.data.daily.day}, ${p.daily().doneCount} done`);

  // All three in a day pays the sweep, once.
  today = '2026-11-11';
  const q = createProgress({ storage: memoryStorage(), cars: CARS, today: () => today });
  q.drainEvents([]);
  const cash0 = q.cash;
  for (let i = 0; i < 3; i++) finishOne(q);
  const ev = q.drainEvents([]);
  const sweeps = ev.filter((e) => e.type === 'sweep').length;
  const paidDaily = [250, 450, 800].reduce((a2, b2) => a2 + b2, 0) + 500;
  check('all three in a day pays the sweep bonus, once', sweeps === 1 && q.daily().allDone && q.cash - cash0 >= paidDaily,
    `${ev.filter((e) => e.type === 'daily').length} dailies + ${sweeps} sweep, +$${q.cash - cash0}`);
}

// ---------------------------------------------------------------------------
console.log('\n-- the save --');
{
  const v1 = {
    v: 1, cash: 1234, xp: 2000, owned: ['kaida2', 'lark', 'drover', 'haulier'],
    results: { 'race-harrowgate-circuit': { best: 90.5, medal: 3, splits: [10, 20] }, 'trap-0': { best: 170, medal: 2 }, 'jump-1': { best: 40, medal: 1 } },
    tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], flags: { rookieDone: true, controlsShown: true },
    stats: { races: 0, finishes: 3, tokens: 11, jumps: 1, bestJump: 40, topSpeed: 170 },
  };
  const s = memoryStorage({ [PROGRESS_KEY]: JSON.stringify(v1) });
  const p = createProgress({ storage: s, cars: CARS, today: () => '2026-09-23', tokensTotal: 50 });
  const ev = p.drainEvents([]);
  const welcome = ev.filter((e) => e.type === 'welcome');
  const lv = levelFor(p.xp).level;
  const levelCashPaid = (() => { let c = 0; for (let l = 2; l <= lv; l++) if (l % 5 && l % 5 !== 3) c += levelCash(l); return c; })();
  check('a round-one save keeps everything it had',
    p.version === PROGRESS_VERSION && p.migratedFrom === 1 && p.data.results['trap-0'].best === 170 && p.tokenCount === 11 &&
    p.flag('rookieDone') && ['kaida2', 'lark', 'drover', 'haulier'].every((id) => p.owns(id)) && p.xp >= 2000 &&
    JSON.stringify(p.data.results['race-harrowgate-circuit'].splits) === '[10,20]',
    `v${p.migratedFrom} -> v${p.version}: results, tokens, flags and cars kept; XP ${p.xp} (2,000 plus trophies)`);
  check('...and is paid its level rewards once, as one card',
    welcome.length === 1 && ev.filter((e) => e.type === 'level' || e.type === 'trophy').length === 0 &&
    p.data.rewardLevel === lv && p.cash === 1234 + levelCashPaid,
    welcome.length ? `level ${welcome[0].level}: ${welcome[0].levels} rewards ($${welcome[0].cash}, ${welcome[0].cars.join(', ')}, ${welcome[0].paints.join(', ')}), ${welcome[0].trophies.length} trophies` : 'no welcome');
  check('...with the medals round one never counted', p.stats.golds === 1 && p.stats.medals === 3 && p.hasTrophy('gold-1'),
    `${p.stats.medals} medals, ${p.stats.golds} gold: "Gold Rush" already won`);
  p.save();
  const again = createProgress({ storage: s, cars: CARS, today: () => '2026-09-23', tokensTotal: 50 });
  const ev2 = again.drainEvents([]);
  check('reloading the migrated save pays nothing again', ev2.length === 0 && again.serialize() === p.serialize() && again.migratedFrom === 2,
    `${ev2.length} events on the second load, saves identical`);

  // The review's case, replayed: the migrated save is loaded by a ROUND-ONE
  // build, which writes it back flattened to v1, and then by this one again.
  // roundOne() is round one's sanitize(), field for field (makeover/preview
  // src/game/progress.js): it keeps cash, xp, owned, results, tokens, the
  // `true` flags (first 64) and its six stats, and writes v:1.
  const roundOne = (raw) => {
    const out = { v: 1, cash: Math.max(0, Math.floor(raw.cash)), xp: Math.max(0, Math.floor(raw.xp)),
      owned: raw.owned.slice(0, 64), results: raw.results, tokens: raw.tokens, flags: {},
      stats: { races: 0, finishes: 0, tokens: 0, jumps: 0, bestJump: 0, topSpeed: 0 } };
    for (const k of Object.keys(raw.flags).slice(0, 64)) if (raw.flags[k] === true) out.flags[k] = true;
    for (const k of Object.keys(out.stats)) out.stats[k] = Math.max(0, raw.stats && Number.isFinite(raw.stats[k]) ? raw.stats[k] : out.stats[k]);
    return out;
  };
  {
    const s2 = memoryStorage({ [PROGRESS_KEY]: JSON.stringify(v1) });
    const a = createProgress({ storage: s2, cars: CARS, today: () => '2026-09-23', tokensTotal: 50 });
    a.drainEvents([]);
    a.bankChain(1, 0, 400);                     // enough for the Lagoon paint
    const bought = a.buyPaint('lagoon');
    a.drainEvents([]);
    const before = { cash: a.cash, xp: a.xp, owned: a.data.owned.length, paints: a.data.paints.length, trophies: Object.keys(a.data.trophies).length };
    s2.setItem(PROGRESS_KEY, JSON.stringify(roundOne(JSON.parse(s2.getItem(PROGRESS_KEY)))));
    const b = createProgress({ storage: s2, cars: CARS, today: () => '2026-09-23', tokensTotal: 50 });
    const evb = b.drainEvents([]);
    check('a v2 save flattened by a round-one build is not paid twice',
      bought && b.cash === before.cash && b.xp === before.xp && b.data.owned.length === before.owned &&
      b.data.paints.length === before.paints && b.ownsPaint('lagoon') && Object.keys(b.data.trophies).length === before.trophies &&
      evb.filter((e) => e.type === 'welcome' || e.type === 'level' || e.type === 'trophy').length === 0,
      `cash $${before.cash} -> $${b.cash}, XP ${before.xp} -> ${b.xp}, cars ${before.owned} -> ${b.data.owned.length}, ` +
      `paints ${before.paints} -> ${b.data.paints.length} (Lagoon ${b.ownsPaint('lagoon') ? 'kept' : 'lost'}), ${evb.length} events`);

    // ...and one that has lost rewardLevel (hand-edited, or a future bug),
    // which used to read as "nothing paid yet" and pay every level again.
    const noLevel = JSON.parse(s2.getItem(PROGRESS_KEY));
    noLevel.v = 2;
    delete noLevel.rewardLevel;
    const c = createProgress({ storage: memoryStorage({ [PROGRESS_KEY]: JSON.stringify(noLevel) }), cars: CARS, today: () => '2026-09-23', tokensTotal: 50 });
    const evc = c.drainEvents([]);
    check('a v2 save that has lost rewardLevel pays no level again',
      c.cash === b.cash && evc.filter((e) => e.type === 'level' || e.type === 'welcome').length === 0 && c.data.rewardLevel === levelFor(c.xp).level,
      `cash $${b.cash} -> $${c.cash}, rewardLevel ${c.data.rewardLevel} at level ${levelFor(c.xp).level}, events ${evc.map((e) => e.type).join() || 'none'}`);
  }

  // A fresh v2 round trip with everything in it.
  const f = createProgress({ storage: memoryStorage(), cars: CARS, today: () => '2026-09-23' });
  f.bankChain(20000, 250, 5000);
  f.buyPaint('lagoon');
  f.setLivery('kaida2', 'lagoon');
  f.track('near', 3);
  f.peak('speed', 188);
  const dump = f.serialize();
  const f2 = createProgress({ storage: memoryStorage({ [PROGRESS_KEY]: dump }), cars: CARS, today: () => '2026-09-23' });
  check('a v2 save round-trips exactly', f2.serialize() === dump && f2.livery('kaida2') === 'lagoon' && f2.paintHex('kaida2') === PAINTS.find((q) => q.id === 'lagoon').hex,
    `${dump.length} bytes; livery ${f2.livery('kaida2')}`);

  const hostile = sanitize({
    v: 2, cash: 5, xp: 100, paints: ['lagoon', 'lagoon', 'nope', 7], livery: { kaida2: 'trophy', lark: 'lagoon', x: 3 },
    trophies: { 'near-1': '2026-01-01', fake: '2026-01-01', 'gold-1': 'yesterday' },
    daily: { day: '2026-09-23', ids: ['near', 'bogus', 'km'], progress: [1, 2, 3] },
    streak: { count: NaN, last: 'soon', best: -4 }, rewardLevel: 50,
  });
  check('hostile v2 fields are cleaned, not trusted',
    hostile.paints.join() === 'lagoon' && Object.keys(hostile.livery).join() === 'lark' && Object.keys(hostile.trophies).join() === 'near-1' &&
    hostile.daily.day === '' && hostile.streak.count === 0 && hostile.streak.best === 0 && hostile.rewardLevel === levelFor(100).level,
    `paints ${hostile.paints}, livery ${JSON.stringify(hostile.livery)}, trophies ${Object.keys(hostile.trophies)}, rewardLevel ${hostile.rewardLevel}`);
  const future = migrate({ v: 7, cash: 10, xp: 500, paints: ['onyx'], someFutureThing: { a: 1 } });
  check('a save from a newer build still loads', future.data.cash === 10 && future.data.paints[0] === 'onyx' && future.from === 7,
    `v${future.from} read as v${future.data.v}, unknown fields dropped`);
  const empty = createProgress({ storage: null, cars: CARS, today: () => '2026-09-23' });
  check('no storage at all (private mode) still plays the long game', empty.daily().list.length === 3 && empty.nextReward().reward,
    `three dailies, next reward ${empty.nextReward().reward.type}`);
}
{
  const p = createProgress({ storage: memoryStorage(), cars: CARS, today: () => '2026-09-23' });
  p.drainEvents([]);
  const broke = p.buyPaint('trophy');
  p.bankChain(1, 0, 2000);
  const rich = p.buyPaint('lagoon');
  const cash = p.cash;
  const twice = p.buyPaint('lagoon') && p.cash === cash;
  const locked = !p.setLivery('kaida2', 'trophy') && p.livery('kaida2') === null;
  check('paints cost their price, once, and only owned ones go on a car', !broke && rich && twice && locked && p.setLivery('kaida2', 'lagoon'),
    `trophy gold unaffordable, lagoon bought for $${PAINTS.find((q) => q.id === 'lagoon').price}, livery of an unowned paint refused`);
  p.drainEvents([]);                        // "Fresh Paint" is in there; not what this is about
  p.track('near', 1);
  const t1 = p.drainEvents([]).filter((e) => e.type === 'trophy');
  const xp1 = p.xp;
  p.track('near', 1);
  const t2 = p.drainEvents([]).filter((e) => e.type === 'trophy');
  check('a trophy unlocks once and pays once', t1.length === 1 && t1[0].id === 'near-1' && t2.length === 0 && p.xp === xp1,
    `"${t1[0] && t1[0].name}" +${t1[0] && t1[0].xp} XP, then nothing on the second near miss`);
  check('every trophy has a name, a reason and a reachable target', TROPHIES.every((t) => t.name && t.desc && (typeof t.at === 'function' || t.at > 0)),
    `${TROPHIES.length} trophies`);
}

// ---------------------------------------------------------------------------
// The real car through real traffic. The autopilot follows the race stages
// and lap circuits the goals generate, at 85% of the reference pace, braking
// for the car ahead — it is not trying to near-miss anything, so what it
// earns is a floor for what a kid weaving on purpose earns.
console.log('\n-- the real car in real traffic --');
{
  const world = buildWorld();
  const ground = createGround(world);
  const gen = generateChallenges(world, { ground });
  const routes = gen.list.filter((c) => c.kind === 'race').map((c) => c.route);
  const traffic = createTraffic(world, ground, { density: 44 });
  const hits = createCarCollision();
  const car = createVehicle({ ground, spec: specFor('kaida2'), isPlayer: true });
  const drift = createDrift({ ground });
  const sk = createSkills();
  const heights = (x, z) => ground.heightAt(x, z);
  const counts = {};
  let banked = 0, lost = 0, bankedValue = 0, nan = false, frames = 0, crashes = 0;
  let wallSlow = 0, cpuSlow = 0, cpuMax = 0;
  const PH = 1 / 120;
  let skillUs = 0;
  const la = {}, np = {};
  for (const route of routes) {
    const prof = speedProfile(route, { heights, v0: 0 });
    const p0 = route.at(8, {});
    car.reset(p0.x - p0.tz * 2, p0.z + p0.tx * 2, Math.atan2(-p0.tx, -p0.tz));
    let pr = { i: -1, d: 0 };
    for (let step = 0; step < 120 * 100 && pr.d < route.length - 30; step++) {
      route.project(car.x, car.z, pr.i >= 0 ? pr.i : -1, pr.i >= 0 ? 30 : 0, pr);
      route.at(Math.min(route.length, pr.d + 2 + car.speed * 0.25), la);
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw), rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
      const psi = Math.atan2(la.tx * rx + la.tz * rz, la.tx * fx + la.tz * fz);
      route.at(pr.d, np);
      // The right-hand lane, like traffic: 2.2 m off the centreline.
      const e = (np.x - np.tz * 2.2 - car.x) * rx + (np.z + np.tx * 2.2 - car.z) * rz;
      car.input.steer = Math.max(-1, Math.min(1, (psi + Math.atan(1.2 * e / (Math.max(2, car.speed) + 3))) / 0.25 * 1.6));
      const k = Math.min(prof.n - 1, Math.floor(pr.d / prof.step));
      const kb = Math.min(prof.n - 1, k + Math.ceil((car.speed * 0.6) / prof.step));
      let want = Math.max(8, Math.min(prof.v[k] * 0.85, prof.v[kb] * 0.85 + 2));
      // Brake for a car in the lane ahead, as anyone would.
      for (const o of traffic.cars) {
        if (!o.active) continue;
        const dx = o.x - car.x, dz = o.z - car.z;
        const lon = dx * fx + dz * fz, lat = dx * rx + dz * rz;
        if (lon > 0 && lon < 40 && Math.abs(lat) < 2.2) want = Math.min(want, (o.speed || 0) + Math.max(0, lon - 12) * 0.3);
      }
      const err = want - car.speed;
      car.input.throttle = err > 0 ? Math.min(1, err * 0.5) : 0;
      car.input.brake = err < -0.8 ? Math.min(1, -err * 0.25) : 0;
      car.input.handbrake = 0;
      car.step(PH);
      const bump = hits.resolve(car, traffic.cars, PH);
      if (bump.hit) { sk.onCrash(bump.severity); if (bump.severity >= CHAIN.CRASH) crashes++; }
      if (step % 2 === 1) {
        traffic.update(PH * 2, car.x, car.z, car.speed, car.yaw);
        drift.update(PH * 2, car);
        const c0 = cpuNow();
        const t0 = performance.now();
        sk.update(PH * 2, car, traffic.cars, drift.state, true);
        const fu = (performance.now() - t0) * 1000;
        const cu = cpuSince(c0);
        // Every frame counts in the mean, however slow: a stall is exactly
        // what this is here to find. What the wall clock cannot tell apart is
        // the core being taken away from a stall in the code, so each frame's
        // own CPU time is read as well. A preempted frame is long on the wall
        // and short on the CPU; a stall in the detectors burns CPU for as
        // long as it lasts. Only the CPU-long ones fail the check below.
        skillUs += fu;
        if (fu > 1000) wallSlow++;
        if (cu > 1000) cpuSlow++;
        if (cu > cpuMax) cpuMax = cu;
        frames++;
        for (let i = 0; i < sk.eventCount; i++) {
          const ev = sk.event(i);
          counts[ev.kind] = (counts[ev.kind] || 0) + 1;
          if (ev.kind === 'bank') { banked++; bankedValue += ev.amount; }
          if (ev.kind === 'lost') lost++;
        }
        sk.clearEvents();
        if (![sk.state.value, sk.state.timer, sk.state.points].every(Number.isFinite)) nan = true;
      }
    }
  }
  sk.bank();
  for (let i = 0; i < sk.eventCount; i++) if (sk.event(i).kind === 'bank') { banked++; bankedValue += sk.event(i).amount; }
  sk.clearEvents();
  const minutes = frames / 60 / 60;
  const links = Object.entries(counts).filter(([k]) => k !== 'bank' && k !== 'lost').reduce((a, [, v]) => a + v, 0);
  const pay = chainPayout(bankedValue);
  const xpPerMin = pay.xp / minutes;
  console.log(`      ${minutes.toFixed(1)} min over ${routes.length} stages: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`      ${banked} chains banked for ${bankedValue.toLocaleString('en')} (${pay.xp} XP, $${pay.cash}), ${lost} lost, ${crashes} crashes`);
  check('driving the real car earns skills of several kinds', links >= 10 && Object.keys(counts).filter((k) => k !== 'bank' && k !== 'lost').length >= 3,
    `${links} links in ${minutes.toFixed(1)} minutes of a cautious autopilot`);
  check('the chain never goes NaN in real traffic', !nan, 'value, timer and points finite every frame');
  // Round two's check, exactly: the mean of EVERY frame under 30 us.
  // Measured 1.9-3.1 us idle, and 7.7-15.0 us with eighteen or nineteen
  // processes on twelve cores (the wall clock counts the waits), so it has
  // room to spare on a busy machine without leaving any frame out.
  const perFrame = skillUs / Math.max(1, frames);
  check('the detectors are cheap in real traffic', perFrame < 30,
    `${perFrame.toFixed(1)} us a frame over all ${frames} (budget 30 us)`);
  // A stall every few seconds hides in a mean: a mutation that spins 5 ms
  // on every 1,000th update reads 7.1 us above and passes, yet it is a hitch
  // a kid feels every seventeen seconds. So no frame may spend a millisecond
  // of CPU in the detectors (that mutation: 42 frames caught). Measured over
  // thirteen runs, idle and under that load: the longest frame is 0.18-0.49
  // ms of CPU, none over 1 ms. The wall clock in the loaded runs had 41-113
  // frames over 1 ms (27 ms the longest), every one of them short on the CPU.
  // That is why the line is drawn on CPU time: on the wall clock the same
  // line fails a busy machine, and an allowance of slow frames lets a real
  // stall through.
  check('no frame of the detectors stalls', cpuSlow === 0,
    `${cpuSlow} frames over 1 ms of ${CPU_CLOCK} time (longest ${(cpuMax / 1000).toFixed(2)} ms); ` +
    `${wallSlow} over 1 ms on the wall clock`);
  // A kid's twenty minutes: skills at this autopilot's rate, plus a medal a
  // few minutes and some tokens, should see several levels from a new save.
  const p = createProgress({ storage: memoryStorage(), cars: CARS, today: () => '2026-09-23' });
  const twenty = Math.round(xpPerMin * 20) + 4 * 120 + 8 * 25;
  p.bankChain(1, twenty, 0);
  check('twenty minutes of play is several level-ups', levelFor(p.xp).level >= 4,
    `~${Math.round(xpPerMin)} XP/min from cautious chains + 4 bronzes + 8 tokens = ${twenty} XP: level ${levelFor(p.xp).level} (round one's curve: level ${(() => { let l = 1; while (100 * (l + 1) * l <= twenty) l++; return l; })()})`);
}

// ---------------------------------------------------------------------------
// The goals layer with all of it wired in, the way main.js wires it: real
// traffic, the drift scorer, a car model to paint. No overlay (that is DOM),
// which is exactly the degraded case main.js allows for.
console.log('\n-- the goals layer, wired as main.js wires it --');
{
  const world = buildWorld();
  const ground = createGround(world);
  const car = createVehicle({ ground, spec: specFor('kaida2'), isPlayer: true });
  car.reset(0, -260, 0);
  const traffic = createTraffic(world, ground, { density: 44 });
  const drift = createDrift({ ground });
  const camera = { fov: 60 };
  const goals = createGoals({
    world, ground, car, cars: CARS, storage: memoryStorage(), sfx: false, drift, traffic, camera,
    today: () => '2026-09-23',
  });
  // A stand-in for carModel.js: the two things paintStep touches.
  const model = { group: { userData: { paint: 0xf2f4f6 } }, setPaint(hex) { this.group.userData.paint = hex; } };
  goals.progress.bankChain(1, 0, 5000);
  goals.progress.buyPaint('flamingo');
  goals.previewPaint(goals.progress.paints.find((q) => q.id === 'flamingo').hex);
  goals.placeInitial();
  const ctx = { driving: true, model };
  const PH = 1 / 120;
  let crashes = 0, frames = 0;
  for (let step = 0; step < 120 * 40; step++) {
    car.input.throttle = 0.6; car.input.brake = 0; car.input.steer = Math.sin(step * 0.004) * 0.2; car.input.handbrake = 0;
    goals.preStep();
    car.step(PH);
    goals.step(PH);
    if (step % 2 === 1) {
      traffic.update(PH * 2, car.x, car.z, car.speed, car.yaw);
      drift.update(PH * 2, car);
      goals.update(PH * 2, ctx);
      frames++;
      if (step === 120 * 20 + 1) { goals.onCrash(0.9); crashes++; }
    }
  }
  check('the goals frame runs clean with skills, traffic and drift wired in', goals.errors === 0 && frames > 2000,
    `${frames} frames, ${goals.errors} threw; chain ${goals.skills.state.live ? 'live' : 'idle'}, ${goals.progress.stats.km.toFixed(2)} km counted`);
  check('the paint shop\'s paint goes on the car main.js built', model.group.userData.paint === 0xff5fa2,
    `model painted #${model.group.userData.paint.toString(16)}`);
  model.group.userData.paint = 0x123456;            // main.js rebuilds it in a factory colour
  goals.update(1 / 60, ctx);
  check('...and back on it after main.js rebuilds the model', model.group.userData.paint === 0xff5fa2, 'repainted the same frame');
  goals.previewPaint(null);
  model.group.userData.paint = 0x123456;
  goals.update(1 / 60, ctx);
  check('...and never over a factory colour', model.group.userData.paint === 0x123456, 'factory colour left alone');
  const f0 = camera.fov;
  goals.demo('level');
  goals.update(1 / 60, ctx);
  check('a level-up punches the camera wider, never past 100 degrees', camera.fov > f0 && camera.fov <= 100,
    `${f0.toFixed(1)} -> ${camera.fov.toFixed(1)} deg (main.js's setFov eases it back)`);
  const hid = { driving: false, model };
  goals.demo('trophy');
  goals.update(1 / 60, hid);
  check('the dailies were drawn for a world with traffic and a drift scorer', goals.progress.daily().list.length === 3,
    goals.progress.daily().list.map((d) => d.text).join(' / '));
  goals.dispose();
}

console.log(fail ? `\n${fail} skill check(s) FAILED` : '\nAll skill checks passed.');
process.exit(fail ? 1 : 0);
