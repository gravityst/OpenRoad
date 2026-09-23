// Checks the goals: that everything a player is sent to is on a real road,
// that every race can be driven gate by gate and won, that the clock and the
// medals are right, and that progress survives a reload.
//
// The failure this exists to prevent is the one the play-test found: ten
// seconds after pressing Drive the car was in a field. A challenge placed off
// the road, a GPS line drawn across a hill, or a gate that can only be reached
// by cutting across a farm is that same failure with extra steps. So nothing
// here is checked against the generator's own idea of where roads are — every
// position is put to ground.roadAt(), the same query the HUD's speed-limit sign
// and the traffic use.
//
// And medals are not checked against arithmetic alone. The REAL vehicle model
// is driven through every race by an autopilot, through the goals runtime
// itself — ring, countdown, gates, finish, save — so if the physics ever
// changes enough to make a medal table unwinnable, this is where it shows.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { CARS, specFor } from '../src/vehicles/catalog.js';
import {
  raceMedal, scoreMedal, formatTime, REWARDS, MEDAL_NONE, MEDAL_BRONZE, MEDAL_SILVER, MEDAL_GOLD,
} from '../src/game/challenges.js';
import { createProgress, sanitize, PROGRESS_KEY, CAR_PRICES, levelFor } from '../src/game/progress.js';
import { rampProfile } from '../src/game/ramps.js';
import { createGoals } from '../src/game/goals.js';

const COUNTDOWN_S = 3;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  if (!ok) fail++;
};

/** localStorage, in memory. */
function memoryStorage(seed) {
  const m = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const world = buildWorld();
const ground = createGround(world);
const origHeight = ground.heightAt;
const origSample = ground.sample;

// Probe heights BEFORE the ramps go in, for the bit-identical check later.
const probes = [];
for (let i = 0; i < 3000; i++) {
  const x = Math.sin(i * 1.7) * 1900, z = Math.cos(i * 0.9) * 1900;
  probes.push([x, z, origHeight(x, z)]);
}

const car = createVehicle({ ground, spec: specFor('kaida2'), isPlayer: true });
car.reset(0, -260, 0);
const store = memoryStorage();
const t0 = performance.now();
const goals = createGoals({ world, ground, car, cars: CARS, storage: store, sfx: false, drift: { state: { banked: 0, pending: 0 } } });
const genMs = performance.now() - t0;
const list = goals.list;
const road = {};

/** Distance off the nearest road's edge, 0 when on the carriageway. */
function offRoad(x, z) {
  ground.roadAt(x, z, road);
  if (!road.edge) return Infinity;
  return Math.max(0, road.dist - road.width * 0.5);
}

// ---------------------------------------------------------------------------
console.log('\n-- what exists --');
const kinds = {};
for (const c of list) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
check('there is plenty to do', list.length >= 16 && (kinds.race || 0) >= 5,
  `${kinds.race || 0} races, ${kinds.trap || 0} speed traps, ${kinds.jump || 0} jumps, ${kinds.drift || 0} drift zones, ${goals.tokens.length} tokens`);
check('generation is cheap enough to do at boot', genMs < 900, `${genMs.toFixed(0)} ms for the whole set (the world itself takes ~1.4 s)`);
const w2 = buildWorld();
const again = createGoals({ world: w2, ground: createGround(w2), car: createVehicle({ ground, spec: specFor('kaida2') }), cars: CARS, storage: memoryStorage(), sfx: false, drift: { state: {} } });
const same = again.list.length === list.length && again.list.every((c, i) => c.id === list[i].id && Math.abs(c.x - list[i].x) < 1e-6);
check('same seed, same challenges (saves stay valid)', same, `${again.list.length} vs ${list.length}, ids and positions ${same ? 'identical' : 'DIFFER'}`);
again.dispose();
// With the drift scorer's layer missing, a drift zone could never pay out,
// so there must not be any rather than four that cannot be won.
const noDrift = createGoals({ world: w2, ground: createGround(w2), car: createVehicle({ ground, spec: specFor('kaida2') }), cars: CARS, storage: memoryStorage(), sfx: false, drift: null });
const zonesLeft = noDrift.list.filter((c) => c.kind === 'drift').length;
check('no drift scorer, no drift zones', zonesLeft === 0 && noDrift.list.length === list.length - (kinds.drift || 0),
  `${zonesLeft} drift zones offered, ${noDrift.list.length} other challenges kept`);
noDrift.dispose();

// ---------------------------------------------------------------------------
console.log('\n-- everything is on a road --');
let worst = 0, worstWhat = '', points = 0;
const onRoad = (x, z, what) => {
  points++;
  const d = offRoad(x, z);
  if (d > worst) { worst = d; worstWhat = what; }
};
for (const c of list) {
  onRoad(c.start.x, c.start.z, `${c.id} start`);
  if (c.gates) c.gates.forEach((g, k) => onRoad(g.x, g.z, `${c.id} gate ${k}`));
  if (c.kind === 'trap') onRoad(c.x, c.z, `${c.id} camera line`);
  if (c.end) onRoad(c.end.x, c.end.z, `${c.id} end`);
}
for (const t of goals.tokens) onRoad(t.x, t.z, `token ${t.i}`);
check('every start, gate, camera, zone and token', worst < 0.01, `${points} points, worst ${worst.toFixed(2)} m off the carriageway${worst > 0 ? ' at ' + worstWhat : ''}`);

let rampWorst = 0;
for (const r of goals.ramps) {
  // All four corners of the deck and the lip, not just the middle.
  for (const [u, v] of [[0, -r.halfW], [0, r.halfW], [r.L, -r.halfW], [r.L, r.halfW], [r.L + r.B, 0]]) {
    const x = r.x + r.tx * u + r.nx * v, z = r.z + r.tz * u + r.nz * v;
    rampWorst = Math.max(rampWorst, offRoad(x, z));
  }
}
check('every ramp sits wholly on the road', rampWorst < 0.01, `${goals.ramps.length} ramps, 5 corners each, worst ${rampWorst.toFixed(2)} m over the edge`);

let gateY = 0;
for (const c of list) if (c.gates) for (const g of c.gates) gateY = Math.max(gateY, Math.abs(g.y - origHeight(g.x, g.z)));
check('gates stand on the surface, not in it', gateY < 0.05, `worst ${gateY.toFixed(3)} m between gate base and ground`);

// ---------------------------------------------------------------------------
console.log('\n-- races can be driven gate by gate --');
let orderBad = 0, shortcut = 0, gateCountBad = 0, worstRatio = Infinity, lapBad = 0;
for (const c of list) {
  if (c.kind !== 'race') continue;
  if (c.gates.length < 5 || c.gates.length > 8) gateCountBad++;
  const pts = [c.start, ...c.gates];
  for (let k = 1; k < pts.length; k++) {
    if (!(pts[k].d > pts[k - 1].d)) orderBad++;
    const A = goals.graph.locate(pts[k - 1].x, pts[k - 1].z, 30, null, {});
    const B = goals.graph.locate(pts[k].x, pts[k].z, 30, null, {});
    const pc = A && B ? goals.graph.pathPieces(A.edge, A.s, B.edge, B.s) : null;
    if (!pc) { shortcut++; continue; }
    let len = 0;
    for (const p of pc) len += Math.abs(p.s1 - p.s0);
    const ratio = len / (pts[k].d - pts[k - 1].d);
    worstRatio = Math.min(worstRatio, ratio);
    if (ratio < 0.9) shortcut++;
  }
  if (c.lap) {
    const f = c.gates[c.gates.length - 1];
    if (Math.hypot(f.x - c.start.x, f.z - c.start.z) > 15) lapBad++;
  }
}
check('5 to 8 gates per race', gateCountBad === 0, `${gateCountBad} races outside that`);
check('gates run in order along the route', orderBad === 0, `${orderBad} out of order`);
check('each gate is reachable from the last, no shortcut', shortcut === 0,
  `shortest road path between consecutive gates is at least ${(worstRatio * 100).toFixed(0)}% of the race line (floor 90%)`);
check('a lap finishes where it started', lapBad === 0, `${lapBad} laps with the finish more than 15 m from the start`);

// ---------------------------------------------------------------------------
console.log('\n-- the clock and the medals --');
const tg = [0, 60, 50, 40];
check('race medals: faster is better, boundaries inclusive',
  raceMedal(40, tg) === MEDAL_GOLD && raceMedal(40.01, tg) === MEDAL_SILVER && raceMedal(50, tg) === MEDAL_SILVER
  && raceMedal(60, tg) === MEDAL_BRONZE && raceMedal(60.01, tg) === MEDAL_NONE && raceMedal(NaN, tg) === MEDAL_NONE && raceMedal(0, tg) === MEDAL_NONE,
  '40 gold, 40.01 silver, 60 bronze, 60.01 none, NaN and 0 none');
const st = [0, 100, 150, 200];
check('score medals: higher is better',
  scoreMedal(200, st) === MEDAL_GOLD && scoreMedal(199, st) === MEDAL_SILVER && scoreMedal(100, st) === MEDAL_BRONZE && scoreMedal(99, st) === MEDAL_NONE && scoreMedal(Infinity, st) === MEDAL_NONE,
  '200 gold, 199 silver, 100 bronze, 99 none, Infinity none');
check('times print the way a stopwatch does',
  formatTime(0) === '0:00.0' && formatTime(59.96) === '0:59.9' && formatTime(61.25) === '1:01.2' && formatTime(-1) === '--:--.-',
  `${formatTime(0)} ${formatTime(59.96)} ${formatTime(61.25)} ${formatTime(-1)}`);
let tableBad = 0;
for (const c of list) {
  const t = c.targets;
  const ok = c.kind === 'race' ? t[3] < t[2] && t[2] < t[1] : t[3] > t[2] && t[2] > t[1] && t[1] > 0;
  if (!ok) tableBad++;
}
check('every medal table is strictly ordered', tableBad === 0, `${tableBad} tables out of order`);

// Synthetic gate crossings through the runtime: skipping a gate must not
// count, a wrong-way crossing must not count, and the time must interpolate.
{
  const fake = { x: 0, z: 0, y: 0, yaw: 0, speed: 0, vx: 0, vz: 0, airborne: false, airTime: 0, spec: { rideHeight: 0.3 },
    reset(x, z, yaw) { this.x = x; this.z = z; this.yaw = yaw; this.speed = 0; } };
  const g2 = createGoals({ world, ground, car: fake, cars: CARS, storage: memoryStorage(), sfx: false, drift: { state: {} } });
  const race = g2.list.find((c) => c.kind === 'race' && !c.lap);
  g2.setTarget(race.id);
  const drive = (x, z, dt = 1 / 60) => { fake.x = x; fake.z = z; g2.update(dt, { driving: true }); };
  drive(race.start.x, race.start.z);            // into the ring
  const counting = g2._race.phase === 'countdown';
  for (let i = 0; i < 200 && g2._race.phase === 'countdown'; i++) g2.update(1 / 60, { driving: true });
  const running = g2._race.phase === 'running';
  const at = (g, off) => [g.x + g.tx * off, g.z + g.tz * off];
  const g0 = race.gates[0], g1 = race.gates[1];
  // Skip gate 0: cross gate 1 first.
  drive(...at(g1, -3)); drive(...at(g1, 3));
  const skipped = g2._race.next === 0;
  // Wrong way through gate 0.
  drive(...at(g0, 3)); drive(...at(g0, -3));
  const wrongWay = g2._race.next === 0;
  // Right way, crossing exactly one third of the way through a 60 Hz frame.
  drive(...at(g0, -1));
  const tBefore = g2._race.t;
  drive(...at(g0, 2));
  const split = g2._race.splits[0];
  const interp = Math.abs(split - (tBefore + (1 / 60) / 3)) < 1e-6;
  check('the ring starts a countdown, the countdown starts the clock', counting && running, `countdown ${counting}, running after ${COUNTDOWN_S}s ${running}`);
  check('a skipped gate does not count', skipped, `crossed gate 2 before gate 1: next gate still ${g2._race.next + 1}`);
  check('a gate crossed the wrong way does not count', wrongWay, 'reversed through gate 1: not counted');
  check('the split is interpolated inside the frame', interp, `split ${split.toFixed(4)} s, expected ${(tBefore + 1 / 180).toFixed(4)} s`);
  // Through the rest in order, then the result lands in progress.
  for (let k = 1; k < race.gates.length; k++) { const g = race.gates[k]; drive(...at(g, -2)); drive(...at(g, 2)); }
  const rec = g2.progress.result(race.id);
  check('finishing records the time and the medal', !!rec && Math.abs(rec.best - g2._race.splits[g2._race.splits.length - 1]) < 1e-9,
    rec ? `best ${formatTime(rec.best)}, medal ${rec.medal}, ${rec.splits ? rec.splits.length : 0} splits saved` : 'nothing recorded');
  // A lap finishes on its own start line. Stopping there afterwards must not
  // start the race again, however long the car sits there.
  {
    const lap = g2.list.find((c) => c.kind === 'race' && c.lap);
    g2.setTarget(lap.id);
    drive(lap.start.x, lap.start.z);
    for (let i = 0; i < 200 && g2._race.phase === 'countdown'; i++) g2.update(1 / 60, { driving: true });
    for (let k = 0; k < lap.gates.length; k++) { const g = lap.gates[k]; drive(...at(g, -2)); drive(...at(g, 2)); }
    const finished = !g2.activeRace;
    fake.speed = 0;
    g2.setTarget(lap.id);                 // even with it targeted again
    for (let i = 0; i < 60 * 12; i++) g2.update(1 / 60, { driving: true });
    const stayed = !g2.activeRace;
    drive(lap.start.x + 60, lap.start.z); drive(lap.start.x + 61, lap.start.z);
    drive(lap.start.x, lap.start.z);
    const rearmed = !!g2.activeRace;
    check('stopping on the line after a lap does not start it again', finished && stayed && rearmed,
      `finished ${finished}, still free after 12 s parked in the ring ${stayed}, re-arms once the car has left ${rearmed}`);
    g2.abandon();
  }
  g2.dispose();
}
// Drift zones, with a scripted drift scorer: only points earned INSIDE the
// zone count, a chain still pending at the end banner counts, and leaving the
// road cancels the zone rather than paying for a slide in a field.
{
  const fake = { x: 0, z: 0, y: 0, yaw: 0, speed: 15, vx: 0, vz: 0, airborne: false, airTime: 0, spec: { rideHeight: 0.3 },
    reset(x, z, yaw) { this.x = x; this.z = z; this.yaw = yaw; } };
  const dstate = { banked: 5000, pending: 0 };
  const g6 = createGoals({ world, ground, car: fake, cars: CARS, storage: memoryStorage(), sfx: false, drift: { state: dstate } });
  const z = g6.list.find((c) => c.kind === 'drift');
  g6.setTarget(z.id);
  const step = (x, zz) => { fake.x = x; fake.z = zz; g6.update(1 / 60, { driving: true }); };
  const walk = (route, d0, d1, each) => {
    const p = {};
    for (let d = d0; d <= d1; d += 3) { route.at(d, p); step(p.x, p.z); if (each) each(d); }
  };
  // Through the zone: 600 banked on the way, 350 still pending at the end.
  walk(z.lead, Math.max(0, z.lead.length - z.overrun - 40), z.lead.length - z.overrun - 1);
  let banked = false, pended = false, began = false;
  walk(z.zone, 0, z.zone.length - 6, (d) => {
    if (d >= 20 && d < 23) began = !!g6._zone.c;
    if (d >= 60 && !banked) { banked = true; dstate.banked += 600; }
    if (d >= 200 && !pended) { pended = true; dstate.pending = 350; }
  });
  const e = z.end;
  step(e.x - e.tx * 3, e.z - e.tz * 3); step(e.x + e.tx * 3, e.z + e.tz * 3);
  const rec = g6.progress.result(z.id);
  check('a drift zone scores only what was earned inside it', began && !!rec && rec.best === 950,
    rec ? `5000 banked before the zone ignored; 600 banked + 350 pending inside = ${rec.best} pts (${['no medal', 'bronze', 'silver', 'gold'][rec.medal]})` : `began ${began}, nothing recorded`);
  // In again (after the zone's 3 s re-trigger guard), then off into a field.
  dstate.pending = 0;
  for (let i = 0; i < 240; i++) g6.update(1 / 60, { driving: false });
  walk(z.lead, Math.max(0, z.lead.length - z.overrun - 40), z.lead.length - z.overrun - 1);
  walk(z.zone, 0, 30);
  const inAgain = !!g6._zone.c;
  const p = z.zone.at(80, {});
  step(p.x + p.tz * 20, p.z - p.tx * 20);
  step(p.x + p.tz * 60, p.z - p.tx * 60);
  dstate.banked += 5000;
  step(p.x + p.tz * 70, p.z - p.tx * 70);
  check('leaving the road cancels a drift zone', inAgain && !g6._zone.c && g6.progress.result(z.id).best === 950,
    `zone re-entered ${inAgain}, cancelled ${!g6._zone.c}, a 5000-point slide in a field paid nothing`);
  g6.dispose();
}

// ---------------------------------------------------------------------------
console.log('\n-- saves --');
{
  const s = memoryStorage();
  const p = createProgress({ storage: s, cars: CARS });
  const race = list.find((c) => c.kind === 'race');
  const trap = list.find((c) => c.kind === 'trap');
  const r1 = p.record(race, race.targets[MEDAL_BRONZE] - 0.1, MEDAL_BRONZE);
  const r2 = p.record(race, race.targets[MEDAL_GOLD] - 0.1, MEDAL_GOLD);
  const r3 = p.record(race, race.targets[MEDAL_GOLD] - 0.05, MEDAL_GOLD);    // slower gold again
  const t1 = p.takeToken(3), t2 = p.takeToken(3);
  p.record(trap, 190, scoreMedal(190, trap.targets));
  const paid = r1.cash + r2.cash + r3.cash;
  check('an improved medal pays only the difference', paid === REWARDS.race.cash[MEDAL_GOLD] && r3.cash === 0,
    `bronze $${r1.cash} then gold $${r2.cash} then gold again $${r3.cash} = $${paid}, gold outright is $${REWARDS.race.cash[MEDAL_GOLD]}`);
  check('a slower run keeps the best time', p.result(race.id).best === race.targets[MEDAL_GOLD] - 0.1 && !r3.newBest, `best ${formatTime(p.result(race.id).best)}`);
  check('a token pays once', !!t1 && t2 === null && p.tokenCount === 1, `first pickup ${t1 ? '$' + t1.cash : 'nothing'}, second ${t2 === null ? 'nothing' : 'PAID AGAIN'}`);
  const cheapest = CARS.filter((c) => !p.owns(c.id)).sort((a, b) => p.price(a.id) - p.price(b.id))[0];
  const before = p.cash;
  const bought = p.buy(cheapest.id);
  check('buying a car costs its price and keeps it', bought && p.owns(cheapest.id) && p.cash === before - p.price(cheapest.id),
    `${cheapest.id} for $${p.price(cheapest.id)}: $${before} -> $${p.cash}`);
  const broke = CARS.filter((c) => !p.owns(c.id)).sort((a, b) => p.price(b.id) - p.price(a.id))[0];
  check('a car you cannot afford stays in the showroom', !p.buy(broke.id) && !p.owns(broke.id), `${broke.id} at $${p.price(broke.id)} with $${p.cash}`);

  const dump = s.dump()[PROGRESS_KEY];
  const p2 = createProgress({ storage: memoryStorage({ [PROGRESS_KEY]: dump }), cars: CARS });
  check('save -> load round trip is exact', p2.serialize() === p.serialize(),
    `${dump.length} bytes, cash $${p2.cash}, xp ${p2.xp}, ${Object.keys(p2.data.results).length} results, ${p2.tokenCount} tokens, ${p2.data.owned.length} cars`);

  const corrupt = createProgress({ storage: memoryStorage({ [PROGRESS_KEY]: '{not json' }), cars: CARS });
  check('a corrupt save starts fresh instead of crashing', corrupt.cash === 0 && corrupt.owns('kaida2'), `cash $${corrupt.cash}, starter owned ${corrupt.owns('kaida2')}`);
  const hostile = sanitize({ cash: 'lots', xp: -50, owned: [1, 'kaida2', null], results: { a: { best: NaN, medal: 3 }, b: { best: 12, medal: 9 } }, tokens: [1, 1, -4, 2.5, 7], flags: { x: 'yes', y: true } });
  check('hostile values are cleaned, not trusted',
    hostile.cash === 0 && hostile.xp === 0 && hostile.owned.length === 1 && !hostile.results.a && hostile.results.b.medal === 3 && hostile.tokens.join() === '1,7' && !hostile.flags.x && hostile.flags.y,
    `cash ${hostile.cash}, xp ${hostile.xp}, owned [${hostile.owned}], medal 9 -> ${hostile.results.b.medal}, tokens [${hostile.tokens}]`);
  const noStore = createProgress({ storage: null, cars: CARS });
  noStore.takeToken(1);
  check('no storage at all (private mode) still plays', noStore.tokenCount === 1, 'progress kept for the session');
  const grant = createProgress({ storage: memoryStorage(), cars: CARS, grant: ['corsara'] });
  check('a returning player keeps the car they already drive', grant.owns('corsara'), 'corsara granted, not locked behind $' + CAR_PRICES.corsara);
}

// ---------------------------------------------------------------------------
console.log('\n-- the economy --');
{
  let onOffer = goals.tokens.length * REWARDS.token.cash;
  for (const c of list) onOffer += REWARDS[c.kind].cash[MEDAL_GOLD];
  let garage = 0, free = 0;
  for (const c of CARS) { const p = CAR_PRICES[c.id] ?? 0; garage += p; if (!p) free++; }
  check('winning everything can buy everything', onOffer >= garage, `$${onOffer} on offer at all-gold, garage costs $${garage}`);
  check('there is a choice from the start', free >= 3, `${free} cars free`);
  const firstRace = list.find((c) => c.rookie) || list[0];
  const early = REWARDS.race.cash[MEDAL_BRONZE] + 2 * REWARDS.token.cash;
  const cheapestPaid = Math.min(...CARS.map((c) => CAR_PRICES[c.id] ?? 0).filter((p) => p > 0));
  check('first upgrade within reach of one race', early >= cheapestPaid, `bronze on ${firstRace.name} + 2 tokens = $${early}, cheapest car $${cheapestPaid}`);
  const lv = levelFor(onOffer ? 7000 : 0);
  check('levels keep coming', lv.level >= 7, `all-gold XP reaches level ${lv.level}`);
}

// ---------------------------------------------------------------------------
console.log('\n-- ramps --');
{
  // Outside car.step() the ground is the ground: what the terrain and road
  // meshes stream from must never see a ramp.
  let idle = 0;
  for (const [x, z, y] of probes) if (ground.heightAt(x, z) !== y) idle++;
  const idleFns = ground.heightAt === origHeight && ground.sample === origSample;
  // Inside it, only the footprints change.
  goals.preStep();
  let diffs = 0, inside = 0;
  for (const [x, z, y] of probes) {
    let on = false;
    for (const r of goals.ramps) {
      const ox = x - r.x, oz = z - r.z;
      if (rampProfile(r, ox * r.tx + oz * r.tz, ox * r.nx + oz * r.nz) > 0) on = true;
    }
    if (on) inside++;
    else if (ground.heightAt(x, z) !== y) diffs++;
  }
  const r0 = goals.ramps[0];
  const lipH = r0 ? ground.heightAt(r0.x + r0.tx * (r0.L - 0.01), r0.z + r0.tz * (r0.L - 0.01)) - origHeight(r0.x + r0.tx * (r0.L - 0.01), r0.z + r0.tz * (r0.L - 0.01)) : 0;
  goals.step(1 / 120);
  check('between physics steps the ground has no ramps in it', idle === 0 && idleFns, `${idle} of ${probes.length} samples differ, original functions ${idleFns ? 'in place' : 'REPLACED'}`);
  check('during a step, only the ramp footprints change', diffs === 0 && lipH > 1.3, `${diffs} samples off the ramps differ, bit for bit; the lip stands ${lipH.toFixed(2)} m proud`);
}

// ---------------------------------------------------------------------------
// The autopilot. A Stanley controller: steer to the road's heading a little
// ahead plus the cross-track error, and drive at a fraction of the reference
// speed, braking early for what the reference brakes for.
function pilotStep(c, route, prof, scale, pr, la, np, extraV = Infinity) {
  route.project(car.x, car.z, pr.i >= 0 ? pr.i : -1, pr.i >= 0 ? 30 : 0, pr);
  route.at(Math.min(route.length, pr.d + 2 + car.speed * 0.25), la);
  const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw), rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
  const psi = Math.atan2(la.tx * rx + la.tz * rz, la.tx * fx + la.tz * fz);
  route.at(pr.d, np);
  const e = (np.x - car.x) * rx + (np.z - car.z) * rz;
  const v = Math.max(2, car.speed);
  const delta = psi + Math.atan(1.2 * e / (v + 3));
  car.input.steer = Math.max(-1, Math.min(1, delta / 0.25 * 1.6));
  const k = Math.min(prof.n - 1, Math.floor(pr.d / prof.step));
  const kb = Math.min(prof.n - 1, k + Math.ceil((car.speed * 0.6) / prof.step));
  let want = Math.min(prof.v[k] * scale, prof.v[kb] * scale + 2, extraV);
  want = Math.max(want, 8);
  const err = want - car.speed;
  car.input.throttle = err > 0 ? Math.min(1, err * 0.5) : 0;
  car.input.brake = err < -0.8 ? Math.min(1, -err * 0.25) : 0;
  car.input.handbrake = 0;
}

import { speedProfile } from '../src/game/challenges.js';
const heights = (x, z) => ground.heightAt(x, z);

console.log('\n-- the real car, through the real runtime --');
{
  const rows = [];
  let unfinished = 0, noMedal = 0, heldOk = true;
  for (const c of list.filter((q) => q.kind === 'race')) {
    const prof = speedProfile(c.route, { heights, v0: 0 });
    goals.setTarget(c.id);
    // Arrive at the ring from 60 m back along the race line (or the lap).
    goals.travelTo(c.id);
    let pr = { i: -1 };
    const la = {}, np = {};
    let steps = 0, sawCountdown = false, crept = 0, lastRoute = null, gpsProf = null;
    const PH = 1 / 120;
    while (steps < 120 * 240) {
      if (goals.hold) {
        sawCountdown = true;
        car.input.throttle = 1; car.input.brake = 1; car.input.steer = 0;   // a kid holding W
        // main.js's rule: the countdown holds the brakes, whatever the pedals say.
        car.input.throttle = 0; car.input.brake = 1;
      } else if (goals.activeRace) {
        if (lastRoute !== c.route) { lastRoute = c.route; pr = { i: -1 }; }
        pilotStep(c, c.route, prof, 0.85, pr, la, np);
      } else {
        // Drive to the ring along the GPS line.
        const r = goals.nav.route;
        if (r && lastRoute !== r) { lastRoute = r; pr = { i: -1 }; gpsProf = speedProfile(r, { v0: 5 }); }
        if (r) pilotStep(c, r, gpsProf, 0.5, pr, la, np, 12);
      }
      const x0 = car.x, z0 = car.z;
      goals.preStep();
      car.step(PH);
      goals.step(PH);
      if (goals.hold) crept = Math.max(crept, Math.hypot(car.x - x0, car.z - z0) / PH);
      steps++;
      if (steps % 2 === 0) goals.update(PH * 2, { driving: true });
      if (sawCountdown && !goals.activeRace) break;
      if (!goals.activeRace && !sawCountdown && steps > 120 * 60) break;
    }
    if (crept > 0.5) heldOk = false;
    const rec = goals.progress.result(c.id);
    if (!rec) unfinished++;
    else if (rec.medal < MEDAL_BRONZE) noMedal++;
    rows.push(`${c.name.padEnd(24)} ${rec ? formatTime(rec.best) : 'DNF   '}  ${rec ? ['none', 'BRONZE', 'SILVER', 'GOLD'][rec.medal] : ''}   (gold ${formatTime(c.targets[3])}, silver ${formatTime(c.targets[2])}, bronze ${formatTime(c.targets[1])})`);
  }
  for (const r of rows) console.log('      ' + r);
  check('every race finishes, every gate in order', unfinished === 0, `${unfinished} did not finish`);
  check('an 85%-pace autopilot medals in every race', noMedal === 0, `${noMedal} finished without a medal`);
  check('the countdown really holds the car', heldOk, 'under 0.5 m/s of creep with the throttle held');
}

console.log('\n-- jumps, flown by the real car --');
{
  const rows = [];
  let grounded = 0, offLanding = 0, goldTooFast = 0;
  for (const c of list.filter((q) => q.kind === 'jump')) {
    const results = [];
    for (const kmh of [55, 110]) {
      goals.travelTo(c.id);
      const route = c.lead;
      const prof = speedProfile(route, { heights, v0: 0, flying: true });
      const pr = { i: -1 }, la = {}, np = {};
      let air = 0, landed = null, steps = 0, took = false;
      const r = goals.ramps[c.rampIndex];
      while (steps < 120 * 60) {
        pilotStep(c, route, prof, 1.0, pr, la, np, kmh / 3.6);
        goals.preStep();
        car.step(1 / 120);
        goals.step(1 / 120);
        if (steps % 2 === 0) goals.update(1 / 60, { driving: true });
        steps++;
        if (car.airborne) { took = true; air = Math.max(air, car.airTime); }
        // Let the runtime see the landing before leaving, as a real frame would.
        else if (took) { landed = { x: car.x, z: car.z }; goals.update(1 / 120, { driving: true }); break; }
        const u = (car.x - r.x) * r.tx + (car.z - r.z) * r.tz;
        if (u > r.L + 120) break;
      }
      const dist = landed ? Math.hypot(landed.x - r.lipX, landed.z - r.lipZ) : 0;
      if (landed && offRoad(landed.x, landed.z) > 0.5) offLanding++;
      results.push({ kmh, air, dist });
    }
    const [slow, fast] = results;
    if (slow.air < 0.5 || fast.air < 0.9) grounded++;
    const rec = goals.progress.result(c.id);
    if (!rec || rec.medal < MEDAL_GOLD) goldTooFast++;
    rows.push(`${c.name.padEnd(12)} 55 km/h: ${slow.air.toFixed(2)} s ${slow.dist.toFixed(0)} m   110 km/h: ${fast.air.toFixed(2)} s ${fast.dist.toFixed(0)} m   (medals ${c.targets.slice(1).join('/')} m, best ${rec ? rec.best : '-'} m ${rec ? ['none', 'bronze', 'silver', 'gold'][rec.medal] : ''})`);
  }
  for (const r of rows) console.log('      ' + r);
  check('every ramp launches the real car', grounded === 0, `${grounded} ramps gave under 0.5 s of air at 55 km/h or 0.9 s at 110`);
  check('every landing is on the road', offLanding === 0, `${offLanding} landings off the carriageway`);
  check('110 km/h off the ramp is gold', goldTooFast === 0, `${goldTooFast} jumps where it was not`);
}

// ---------------------------------------------------------------------------
console.log('\n-- onboarding and the GPS --');
{
  const fresh = memoryStorage();
  const c2 = createVehicle({ ground, spec: specFor('kaida2'), isPlayer: true });
  c2.reset(0, -260, 0);
  const g3 = createGoals({ world, ground, car: c2, cars: CARS, storage: fresh, sfx: false, drift: { state: {} } });
  g3.placeInitial();
  ground.roadAt(c2.x, c2.z, road);
  const near = ground.nearestRoad(c2.x, c2.z, 20);
  const fwdX = -Math.sin(c2.yaw), fwdZ = -Math.cos(c2.yaw);
  const along = near ? Math.abs(fwdX * near.tx + fwdZ * near.tz) : 0;
  const first = g3.target;
  g3.update(1 / 60, { driving: true });
  const r = g3.nav.route;
  check('a new player starts on a road, facing along it', road.onRoad && along > 0.94,
    `${road.kind} road, ${road.dist.toFixed(1)} m from its centre, heading within ${(Math.acos(Math.min(1, along)) * 57.3).toFixed(0)} deg of it`);
  check('and the first objective is the rookie race', !!first && first.rookie && /first race/i.test(g3.ui.objective.title),
    `target "${first ? first.name : 'none'}", banner "${g3.ui.objective.title}"`);
  check('a short drive away', !!r && r.length < 400, r ? `${r.length.toFixed(0)} m of road to the start ring` : 'no route');
  g3.dispose();

  // Starting over (settings -> Start over) brings the world back, not just the save.
  {
    const c5 = createVehicle({ ground, spec: specFor('kaida2') });
    const g5 = createGoals({ world, ground, car: c5, cars: CARS, storage: memoryStorage(), sfx: false, drift: { state: {} } });
    const rk = g5.list.find((c) => c.rookie);
    g5.progress.takeToken(0);
    g5.progress.record(rk, rk.targets[MEDAL_GOLD] - 1, MEDAL_GOLD);
    g5.progress.setFlag('rookieDone');
    g5.progress.buy('haulier');
    g5.resync();                // progress written behind the runtime's back
    g5.update(1 / 60, { driving: true });
    const before = g5.nav.tokens.taken[0] === 1 && g5.target !== rk;
    g5.progress.reset();
    g5.resync();
    const m = g5.nav.markers.find((k) => k.id === rk.id);
    check('starting over brings the tokens and the rookie race back',
      before && g5.nav.tokens.taken[0] === 0 && g5.target === rk && m.medal === 0 && g5.progress.cash === 0 && !g5.progress.owns('haulier'),
      `token back ${g5.nav.tokens.taken[0] === 0}, next up "${g5.target && g5.target.name}", medal ring cleared ${m.medal === 0}, cash $${g5.progress.cash}`);
    g5.dispose();
  }

  // From 40 places on the map to every challenge: every point on a road.
  let routes = 0, bad = 0, worstOff = 0, endMiss = 0;
  const prng = (i) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  const c3 = createVehicle({ ground, spec: specFor('kaida2') });
  const g4 = createGoals({ world, ground, car: c3, cars: CARS, storage: memoryStorage(), sfx: false, drift: { state: {} } });
  for (let i = 0; i < 40; i++) {
    const n = world.nodes[Math.floor(prng(i) * world.nodes.length)];
    for (const c of g4.list) {
      c3.reset(n.x, n.z, prng(i + 99) * 6.28);
      c3.speed = 20;              // rolling, so no ring mistakes this for a stop
      g4.setTarget(c.id);
      g4.update(1 / 60, { driving: false });
      g4.update(1 / 60, { driving: true });
      if (g4.activeRace) { g4.abandon(); continue; }
      const route = g4.nav.route;
      if (!route) { bad++; continue; }
      routes++;
      for (let k = 0; k < route.n; k += 3) worstOff = Math.max(worstOff, offRoad(route.xs[k], route.zs[k]));
      const end = route.at(route.length, {});
      const goal = c.kind === 'race' ? c.start : (c.end || c.gate);
      if (Math.hypot(end.x - goal.x, end.z - goal.z) > 70) endMiss++;
    }
  }
  check('the GPS finds a road route to everything, from anywhere', bad === 0, `${routes} routes planned, ${bad} failed`);
  check('every GPS route runs on roads', worstOff < 0.01, `worst point ${worstOff.toFixed(2)} m off the carriageway`);
  check('every GPS route ends at its challenge', endMiss === 0, `${endMiss} routes end more than 70 m from where they were going`);

  // The distance on the banner is to the challenge, not to the end of the
  // GPS line (which runs on through a drift zone, past a camera, over a ramp).
  let distBad = 0, distWorst = '';
  for (const c of g4.list) {
    g4.travelTo(c.id);
    c3.speed = 20;
    g4.update(1 / 60, { driving: true });
    const goal = c.kind === 'race' ? c.start : c.gate;
    const crow = Math.hypot(goal.x - c3.x, goal.z - c3.z);
    const shown = g4.ui.objective.dist;
    if (g4.activeRace) { g4.abandon(); continue; }
    if (!(shown >= crow - 5 && shown <= crow * 2.5 + 40)) { distBad++; distWorst = `${c.name}: banner ${shown.toFixed(0)} m, ${crow.toFixed(0)} m as the crow flies`; }
  }
  check('the banner distance is to the challenge itself', distBad === 0, distBad ? distWorst : `all ${g4.list.length} within road-distance bounds of the real gap`);

  // Cost per frame, driving about with a target set.
  c3.reset(list[0].start.x, list[0].start.z, 0);
  g4.setTarget(list[3].id);
  const T = performance.now();
  for (let i = 0; i < 2000; i++) {
    c3.x += Math.sin(i * 0.01) * 0.3; c3.z += Math.cos(i * 0.013) * 0.3;
    g4.update(1 / 60, { driving: true });
  }
  const per = (performance.now() - T) / 2000;
  check('the goals cost little per frame', per < 0.25, `${(per * 1000).toFixed(0)} us per frame, averaged over 2000 (budget 250 us)`);
  g4.dispose();
}

goals.dispose();
check('dispose puts the ground back', ground.heightAt === origHeight && ground.sample === origSample, 'original sample() and heightAt() restored');

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll goal checks passed.');
process.exit(fail ? 1 : 0);
