// Goals: races, speed traps, jumps, drift zones and tokens, and the GPS that
// gets you to them.
//
// This is the layer main.js loads. It owns the game's REASON TO DRIVE: which
// challenge is next, how to get there along real roads, what happens when you
// arrive, and what you earned. The pieces it composes are separate on purpose:
//
//   routes.js      shortest paths on the road graph        pure
//   challenges.js  where everything is and what wins        pure
//   ramps.js       the jumps, as ground                     pure
//   progress.js    cash, XP, medals, cars — saved           pure + storage
//   sfx.js         chimes                                   WebAudio, optional
//   gates.js       what you see in the world                three.js, OPTIONAL
//   objectives.js  what you see on screen                   DOM, OPTIONAL
//
// The last two arrive as factories from main.js, which loads each through
// layer(): if either fails to load, the goals still run — races still time,
// medals still pay, progress still saves — you just cannot see them. With
// this whole layer null the game is exactly the free-roam it was before.
//
// HOW A CHALLENGE STARTS. Nothing needs a button. Speed traps, jumps and drift
// zones are live the whole time: drive through the camera, off the ramp, into
// the zone. A race starts when the car rolls into its start ring — it is
// snapped onto the grid facing the right way, held for a 3-2-1, and released.
// That is deliberate for kids and for touch screens, where "press X to start"
// is one more thing to find.
//
// NOBODY IS EVER LOST. There is always exactly one GPS target: the challenge
// the player picked on the map, or the nearest one they have not won yet. The
// route to it is re-planned along the road graph whenever the car strays 35 m
// from it, and drawn three ways — chevrons on the road, an arrow over the car,
// and a line on the minimap.

import { createRoadGraph, buildRoute } from './routes.js';
import {
  generateChallenges, raceMedal, scoreMedal, formatTime,
  MEDAL_NAMES, MEDAL_NONE, MEDAL_BRONZE, MEDAL_GOLD,
} from './challenges.js';
import { makeRamp, createRampOverlay, kickRamps } from './ramps.js';
import { createProgress, levelFor } from './progress.js';
import { createSfx } from './sfx.js';

export const KIND_LABEL = { race: 'Race', trap: 'Speed trap', jump: 'Jump', drift: 'Drift zone' };
const KIND_VERB = {
  race: 'Drive into the ring to start',
  trap: 'Floor it through the camera',
  jump: 'Hit the ramp as fast as you dare',
  drift: 'Get sideways through the zone',
};

const COUNTDOWN = 3.0;          // s of 3-2-1 before GO
const RESULT_TIME = 7.0;        // s the result card stays up
const OFF_ROUTE = 35;           // m from the GPS line before it re-plans
const REPLAN_HOLD = 1.2;        // s off the line before it re-plans
const RACE_LOST = 60;           // m off a race route before the "press R" hint
const TOKEN_R = 5.5;            // m pickup radius, generous: a token is a gift

/**
 * opts: {
 *   world, ground, car,
 *   place(x, z, yaw)      put the car somewhere as a cut (main.js marks the
 *                         teleport for multiplayer); defaults to car.reset
 *   settings              live settings object (volume)
 *   drift                 the drift scorer's handle, or null
 *   particles             for pickup sparkles, optional
 *   toast(msg, secs)      the HUD toast, optional
 *   cars                  the catalogue, for prices
 *   grant                 car ids a returning player already drives
 *   createView            gates.js factory, optional
 *   createOverlay         objectives.js factory, optional
 *   scene, root           where those two draw
 *   storage               progress storage override (the harness uses this)
 * }
 */
export function createGoals(opts) {
  const world = opts.world, ground = opts.ground, car = opts.car;
  const place = opts.place || ((x, z, yaw) => car.reset(x, z, yaw));
  const settings = opts.settings || {};
  const drift = opts.drift || null;
  const particles = opts.particles || null;
  const toast = opts.toast || (() => {});

  // ---- the world's challenges --------------------------------------------
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const graph = createRoadGraph(world);
  // Heights are taken from the ground BEFORE the ramps go in, so no challenge
  // is ever measured off the top of a ramp.
  const baseHeight = ground.heightAt;
  const gen = generateChallenges(world, { ground, graph });
  const list = drift ? gen.list : gen.list.filter((c) => c.kind !== 'drift');
  const tokens = gen.tokens;
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  const genMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;

  const ramps = [];
  for (const c of list) {
    if (c.kind !== 'jump') continue;
    const r = makeRamp(c.ramp);
    r.id = c.id;
    r.baseY = baseHeight(c.ramp.x, c.ramp.z);
    r.lipY = baseHeight(r.lipX, r.lipZ) + r.H;
    c.rampIndex = ramps.length;
    ramps.push(r);
  }
  // Switched on around car.step() only — see createRampOverlay.
  const rampGround = createRampOverlay(ground, ramps);
  const kickState = { onFace: -1 };

  for (const c of list) {
    // Every non-race challenge has a lead-in the GPS must follow the right way
    // round: a speed trap approached from the wrong end has no run-up.
    if (c.kind !== 'race') {
      c.lead = leadFrom(c.approach);
      // The lead-in runs on past the trigger (through a drift zone to its end,
      // 60 m past a camera, over a ramp), so "how far to go" is measured to
      // the trigger, not to the end of the line: a drift zone 20 m ahead read
      // as 330 m on the first try.
      const at = c.lead.project(c.gate.x, c.gate.z, -1, 0, {});
      c.overrun = Math.max(0, c.lead.length - at.d);
    } else c.overrun = 0;
    const at = graph.locate(c.start.x, c.start.z, 60, null, {});
    c.startLoc = at ? { edge: at.edge, s: at.s } : null;
  }

  const progress = createProgress({ storage: opts.storage, cars: opts.cars || [], grant: opts.grant || [] });
  const sfx = opts.sfx === false ? null : createSfx({ volume: () => (settings.volume != null ? settings.volume : 0.8) });
  const play = (n) => { if (sfx) sfx.play(n); };

  const rookie = list.find((c) => c.rookie) || list.find((c) => c.kind === 'race') || null;

  // ---- presentation, both optional ----------------------------------------
  let view = null;
  if (opts.createView && opts.scene) {
    try {
      view = opts.createView(opts.scene, { baseHeight, heightAt: rampGround.heightAt, quality: settings.quality || 'medium' });
      view.build({ challenges: list, tokens, ramps, taken: tokenTaken() });
      for (const c of list) { const m = progress.medalOf(c.id); if (m) view.setMedal(c.id, m); }
    } catch (err) { console.error('[goals] world markers unavailable:', err); view = null; }
  }
  let overlay = null;
  if (opts.createOverlay && opts.root) {
    try {
      overlay = opts.createOverlay(opts.root, {
        onRetry: () => restart(),
        onNext: () => { lastResult = null; if (overlay) overlay.hideResult(); },
      });
    } catch (err) { console.error('[goals] objective overlay unavailable:', err); overlay = null; }
  }

  function tokenTaken() {
    const a = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) a[i] = progress.hasToken(i) ? 1 : 0;
    return a;
  }
  const taken = tokenTaken();

  // ---- state ---------------------------------------------------------------
  let driving = false;
  let clock = 0;
  let prevX = car.x, prevZ = car.z, prevValid = false;

  // The one race (or drift zone) in progress, if any.
  const race = {
    c: null, phase: '', t: 0, count: 0, next: 0, splits: [], lastGate: -1,
    hint: -1, d: 0, lost: 0, bestSplits: null, armedAgainst: '',
  };
  const zone = { c: null, base: 0, score: 0, hint: -1, t: 0 };
  let jump = null;                  // { c, x, z, t } while airborne off a ramp
  let lastResult = null;            // { c, until }
  let manualTarget = null;          // a challenge picked on the map or with G
  let target = null;
  const nav = { route: null, hint: -1, d: 0, off: 0, planFor: null, planAt: -1, dist: 0 };
  let started = false;              // first Drive of the session has happened
  let ringHint = '';
  const cooldown = Object.create(null);   // id -> clock time it may re-trigger
  // A race ring re-arms only once the car has LEFT it. A lap finishes on its
  // own start line, and with a timed cooldown alone a kid who pulls up just
  // past the finish — which is what kids do — was snapped back onto the grid
  // for a race they had just won.
  const disarmed = new Set();

  // Shared, mutated in place: read by the HUD's minimap and by the view.
  const markers = list.map((c) => ({
    id: c.id, kind: c.kind, x: c.start.x, z: c.start.z, medal: progress.medalOf(c.id), target: false,
  }));
  const tokenXs = new Float32Array(tokens.map((t) => t.x));
  const tokenZs = new Float32Array(tokens.map((t) => t.z));
  const hudNav = {
    route: null, from: 0, markers,
    tokens: { xs: tokenXs, zs: tokenZs, taken, n: tokens.length },
  };

  const vs = {
    car, time: 0, target: null, race: null, nextGate: 0, zone: null,
    route: null, routeD: 0, routeEnd: 0, arrow: false, arrowX: 0, arrowZ: 0,
    taken, driving: false,
  };

  const ui = {
    objective: { kind: '', title: '', detail: '', dist: -1 },
    race: { active: false, phase: '', name: '', time: 0, cp: 0, cpTotal: 0, delta: NaN, deltaAge: 99, targetMedal: 0, targetTime: 0, countdown: 0, lap: false },
    zone: { active: false, name: '', score: 0, targetMedal: 0, targetScore: 0, unit: 'pts' },
    wallet: { cash: progress.cash, level: 1, frac: 0 },
    hint: '',
  };

  // ---- routes --------------------------------------------------------------

  /** An approach route widened back to the node behind it, so the GPS can join it cleanly. */
  function leadFrom(route) {
    if (!route || !route.pieces || !route.pieces.length) return route;
    const ps = route.pieces.map((p) => ({ edge: p.edge, s0: p.s0, s1: p.s1 }));
    const f = ps[0];
    f.s0 = f.s1 >= f.s0 ? 0 : f.edge.length;
    return buildRoute(ps);
  }

  /** A run-in to a race's start line from 220 m back, for spawning the car. */
  function raceLead(c) {
    const first = c.route.pieces[0];
    const node = first.s1 >= first.s0 ? first.edge.a : first.edge.b;
    const n = world.nodes[node];
    // The race leaves the node along `first`; the run-in arrives along the
    // other edge most nearly opposite to it.
    const pts = first.edge.pts;
    const fwd = first.s1 >= first.s0;
    const a = fwd ? pts[0] : pts[pts.length - 1], b = fwd ? pts[Math.min(2, pts.length - 1)] : pts[Math.max(0, pts.length - 3)];
    const hx = a.x - b.x, hz = a.z - b.z;
    let best = null, bt = Infinity;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (e === first.edge || e.kind === 'track') continue;
      const cf = e.a === node, q = e.pts;
      const q0 = cf ? q[0] : q[q.length - 1], q1 = cf ? q[Math.min(2, q.length - 1)] : q[Math.max(0, q.length - 3)];
      const cx = q1.x - q0.x, cz = q1.z - q0.z;
      const turn = Math.acos(Math.max(-1, Math.min(1, (hx * cx + hz * cz) / ((Math.hypot(hx, hz) * Math.hypot(cx, cz)) || 1))));
      // Prefer tarmac for the run-in: it is the first thing a new player drives.
      const cost = turn + (e.surface === 'asphalt' ? 0 : 0.6);
      if (cost < bt) { bt = cost; best = e; }
    }
    if (!best) return null;
    const back = graph.walk(node, best, 220, (e) => (e.kind === 'track' ? false : undefined));
    const pieces = back.reverse().map((p) => ({ edge: p.edge, s0: p.s1, s1: p.s0 }));
    // Then along the race itself as far as the start line.
    let acc = 0;
    for (const p of c.route.pieces) {
      const len = Math.abs(p.s1 - p.s0);
      const want = c.start.d - acc;
      if (want <= 0) break;
      const dir = p.s1 >= p.s0 ? 1 : -1;
      pieces.push({ edge: p.edge, s0: p.s0, s1: want >= len ? p.s1 : p.s0 + dir * want });
      acc += len;
    }
    return buildRoute(pieces);
  }

  /** The GPS route from the car to challenge c. */
  function plan(c) {
    const here = graph.locate(car.x, car.z, 1500, null, {});
    if (!here) return null;
    if (c.kind === 'race') {
      if (!c.startLoc) return null;
      const pieces = graph.pathPieces(here.edge, here.s, c.startLoc.edge, c.startLoc.s);
      return pieces ? buildRoute(pieces) : null;
    }
    const lead = c.lead;
    // Already on the lead-in: just follow it from here.
    const pr = lead.project(car.x, car.z, -1, 0, {});
    if (pr.dist < 18 && pr.d < lead.length - 5) {
      const heading = lead.at(pr.d, {});
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      if (car.speed < 2 || fx * heading.tx + fz * heading.tz > 0) return clip(lead, pr.d);
    }
    const first = lead.pieces[0];
    const leadEdges = new Set(lead.pieces.map((p) => p.edge.i));
    const avoid = (e) => leadEdges.has(e.i) && e !== first.edge;
    let pieces = graph.pathPieces(here.edge, here.s, first.edge, first.s0, avoid);
    if (!pieces) pieces = graph.pathPieces(here.edge, here.s, first.edge, first.s0);
    if (!pieces) return null;
    return buildRoute([...pieces, ...lead.pieces]);
  }

  function clip(route, d0) {
    const ps = [];
    let acc = 0;
    for (const p of route.pieces) {
      const len = Math.abs(p.s1 - p.s0);
      if (acc + len <= d0) { acc += len; continue; }
      const dir = p.s1 >= p.s0 ? 1 : -1;
      const lo = Math.max(0, d0 - acc);
      ps.push({ edge: p.edge, s0: p.s0 + dir * lo, s1: p.s1 });
      acc += len;
    }
    return buildRoute(ps.length ? ps : route.pieces);
  }

  // ---- choosing what is next ------------------------------------------------

  /** The nearest thing not yet won; the rookie race until it has been run. */
  function recommend(skip) {
    if (rookie && !progress.flag('rookieDone') && skip !== rookie) return rookie;
    let best = null, bs = Infinity;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (const c of list) {
        if (c === skip) continue;
        const m = progress.medalOf(c.id);
        if (pass === 0 && m >= MEDAL_GOLD) continue;
        const d = Math.hypot(c.start.x - car.x, c.start.z - car.z);
        // Unwon beats won, races slightly beat the rest, near beats far.
        const score = d + m * 1400 + (c.kind === 'race' ? 0 : 250);
        if (score < bs) { bs = score; best = c; }
      }
    }
    return best;
  }

  function setTarget(c, manual) {
    if (manual) manualTarget = c;
    if (target === c) return;
    target = c;
    nav.planFor = null;           // forces a re-plan
    for (const m of markers) m.target = !!c && m.id === c.id;
  }

  // ---- placing the car ------------------------------------------------------

  function spawnAt(route, d) {
    jump = null;
    const p = route.at(Math.min(route.length, d), {});
    // The right-hand lane, like everyone else on this road.
    const off = Math.min(2.2, p.hw * 0.45);
    const yaw = Math.atan2(-p.tx, -p.tz);
    place(p.x - p.tz * off, p.z + p.tx * off, yaw);
    prevValid = false;
  }

  /** Where a player should appear to be 20 seconds from challenge c, facing it. */
  function spawnFor(c) {
    if (!c) return false;
    const lead = c.kind === 'race' ? (c.spawnLead || (c.spawnLead = raceLead(c))) : c.lead;
    if (!lead) return false;
    spawnAt(lead, Math.min(12, lead.length * 0.1));
    return true;
  }

  // ---- races -----------------------------------------------------------------

  function beginRace(c) {
    endZone(false);
    race.c = c; race.phase = 'countdown'; race.t = 0; race.count = COUNTDOWN;
    race.next = 0; race.splits.length = 0; race.lastGate = -1; race.lost = 0;
    const r = progress.result(c.id);
    race.bestSplits = r && r.splits ? r.splits : null;
    // On the grid: just behind the line on a stage, just past it on a lap
    // (whose line is also the finish, 2 km away).
    const d = c.lap ? 3 : Math.max(0, c.start.d - 8);
    spawnAt(c.route, d);
    const at = c.route.project(car.x, car.z, -1, 0, {});
    race.hint = at.i;
    // Progress starts from the grid, not from wherever the last race ended —
    // the gate-by-progress test compares against it on the very first frame.
    race.d = at.d;
    disarmed.add(c.id);
    lastResult = null;
    if (overlay) { overlay.hideResult(); overlay.countdown(3); }
    play('beep');
    setTarget(c, false);
    if (view && view.raceStart) view.raceStart(c);
  }

  function raceStep(dt) {
    const c = race.c;
    if (race.phase === 'countdown') {
      const before = Math.ceil(race.count);
      race.count -= dt;
      const after = Math.ceil(race.count);
      if (race.count <= 0) {
        race.phase = 'running'; race.t = 0;
        if (overlay) overlay.countdown(0);
        play('go');
      } else if (after !== before) {
        if (overlay) overlay.countdown(after);
        play('beep');
      }
      return;
    }
    if (race.phase !== 'running') return;
    const tStart = race.t;
    race.t += dt;

    const prevD = race.d;
    const pr = c.route.project(car.x, car.z, race.hint, 30, projScratch);
    // Lost the thread (a respawn, a long excursion): search the whole route.
    if (pr.dist > 25) c.route.project(car.x, car.z, -1, 0, projScratch);
    race.hint = projScratch.i;
    race.d = projScratch.d;
    const near = projScratch.dist;
    race.lost = near > RACE_LOST ? race.lost + dt : 0;

    const g = c.gates[race.next];
    if (!g || !prevValid) return;
    // Two ways through a gate, and either counts.
    //
    // Through the plane between its posts, with a generous margin: a kid who
    // runs wide onto the verge has still driven the course. Measured with the
    // autopilot, a car that ran 11.5 m wide of a 9.5 m road at a gate sailed
    // past it with the old road-plus-6 m margin, and the race was lost there
    // and then — nothing on screen said why.
    const a0 = (prevX - g.x) * g.tx + (prevZ - g.z) * g.tz;
    const a1 = (car.x - g.x) * g.tx + (car.z - g.z) * g.tz;
    const lat = Math.abs((car.x - g.x) * -g.tz + (car.z - g.z) * g.tx);
    let f = -1;
    if (a0 < 0 && a1 >= 0 && lat < g.hw + 14) f = a1 / Math.max(1e-6, a1 - a0);
    // Or by progress along the race line, for any line the plane test misses
    // (a wide slide through a corner gate). Only ever between two frames that
    // were both near the route, so a teleport or a cut across country can
    // never tick a gate off — the harness checks exactly that.
    else if (prevD < g.d && race.d >= g.d && near < 30 && race.d - prevD < 60) {
      f = (race.d - g.d) / Math.max(1e-6, race.d - prevD);
    }
    // The crossing, interpolated within the frame — at 200 km/h a frame is
    // almost a metre, and a tenth of a second is what medals turn on.
    if (f >= 0) passGate(tStart + dt * (1 - f));
  }
  const projScratch = { i: 0, d: 0, dist: 0 };

  function passGate(t) {
    const c = race.c;
    const k = race.next;
    race.splits.push(t);
    race.lastGate = k;
    race.next++;
    const g = c.gates[k];
    if (view && view.flashGate) view.flashGate(k, g);
    if (race.next >= c.gates.length) { finishRace(t); return; }
    play('gate');
    const best = race.bestSplits && race.bestSplits.length > k ? race.bestSplits[k] : NaN;
    ui.race.delta = Number.isFinite(best) ? t - best : NaN;
    ui.race.deltaAge = 0;
    if (particles && particles.emitSparks) particles.emitSparks(g.x, g.y + 5, g.z, 30, 0, 0);
  }

  function finishRace(t) {
    const c = race.c;
    const medal = raceMedal(t, c.targets);
    const splits = race.splits.slice();
    const res = progress.record(c, t, medal, splits);
    if (c === rookie) progress.setFlag('rookieDone');
    showResult(c, t, res);
    race.c = null; race.phase = '';
    cooldown[c.id] = clock + 4;
    if (view && view.raceEnd) view.raceEnd();
    afterChallenge(c);
  }

  function abandonRace(msg) {
    if (!race.c) return;
    const c = race.c;
    race.c = null; race.phase = '';
    cooldown[c.id] = clock + 3;
    if (overlay) overlay.countdown(-1);
    if (view && view.raceEnd) view.raceEnd();
    if (msg) toast(msg, 3);
  }

  function restart() {
    const c = race.c || (lastResult && lastResult.c);
    if (!c) return false;
    if (c.kind === 'race') { beginRace(c); return true; }
    // Anything else: back to the start of its run-up.
    abandonRace();
    endZone(false);
    spawnFor(c);
    setTarget(c, true);
    lastResult = null;
    if (overlay) overlay.hideResult();
    return true;
  }

  // ---- drift zones -------------------------------------------------------------

  function driftTotal() {
    const s = drift && drift.state;
    return s ? (s.banked || 0) + (s.pending || 0) : 0;
  }

  function beginZone(c) {
    zone.c = c; zone.base = driftTotal(); zone.score = 0; zone.t = 0;
    zone.hint = c.zone.project(car.x, car.z, -1, 0, {}).i;
    play('zone');
    toast(`${c.name} — get sideways!`, 2.2);
  }

  function zoneStep(dt) {
    const c = zone.c;
    zone.t += dt;
    zone.score = Math.max(0, driftTotal() - zone.base);
    const pr = c.zone.project(car.x, car.z, zone.hint, 30, projScratch);
    zone.hint = pr.i;
    if (pr.dist > 45 || zone.t > 90) { endZone(false); toast('Drift zone missed — you left the road', 2.5); return; }
    const e = c.end;
    if (prevValid) {
      const a0 = (prevX - e.x) * e.tx + (prevZ - e.z) * e.tz;
      const a1 = (car.x - e.x) * e.tx + (car.z - e.z) * e.tz;
      if (a0 < 0 && a1 >= 0) endZone(true);
    }
  }

  function endZone(scored) {
    if (!zone.c) return;
    const c = zone.c;
    zone.c = null;
    cooldown[c.id] = clock + 3;
    if (!scored) return;
    const score = Math.round(zone.score);
    const medal = scoreMedal(score, c.targets);
    const res = progress.record(c, score, medal);
    showResult(c, score, res);
    afterChallenge(c);
  }

  // ---- results -------------------------------------------------------------------

  function showResult(c, score, res) {
    // Driving through a camera or a zone you were not aiming for, without
    // earning anything, gets a quiet readout — not a fail fanfare and a card
    // over the road.
    if (res.medal === MEDAL_NONE && c !== target && c.kind !== 'race') {
      if (overlay) overlay.popup(c.kind, `${c.name}: ${Math.round(score)} ${c.unit}`, `Bronze needs ${c.targets[MEDAL_BRONZE]} ${c.unit}`);
      return;
    }
    lastResult = { c, until: clock + RESULT_TIME };
    const medal = res.medal;
    const nextMedal = Math.min(MEDAL_GOLD, medal + 1);
    const isRace = c.kind === 'race';
    const fmt = (v) => (isRace ? formatTime(v) : `${Math.round(v)} ${c.unit}`);
    if (overlay) {
      overlay.result({
        kind: c.kind, name: c.name, medal, medalName: MEDAL_NAMES[medal],
        score: fmt(score),
        best: res.prevBest != null ? fmt(res.newBest ? score : res.prevBest) : '',
        prevBest: res.prevBest != null && res.newBest ? fmt(res.prevBest) : '',
        newBest: res.newBest && res.prevBest != null,
        first: res.prevBest == null,
        cash: res.cash, xp: res.xp, levelUp: res.levelUp,
        next: medal < MEDAL_GOLD ? `${MEDAL_NAMES[nextMedal].toUpperCase()}: ${fmt(c.targets[nextMedal])}` : '',
        retry: true,
      });
    }
    play(medal >= MEDAL_GOLD ? 'gold' : medal > MEDAL_NONE ? (isRace ? 'finish' : 'medal') : 'fail');
    if (res.levelUp) setTimeout(() => play('level'), 900);
    const m = markers.find((k) => k.id === c.id);
    if (m) m.medal = progress.medalOf(c.id);
    if (view && view.setMedal) view.setMedal(c.id, progress.medalOf(c.id));
  }

  function afterChallenge(c) {
    if (manualTarget === c) manualTarget = null;
    setTarget(recommend(c), false);
  }

  // ---- tokens ----------------------------------------------------------------------

  function tokenStep() {
    for (let i = 0; i < tokens.length; i++) {
      if (taken[i]) continue;
      const t = tokens[i];
      const dx = t.x - car.x, dz = t.z - car.z;
      if (dx * dx + dz * dz > TOKEN_R * TOKEN_R) continue;
      if (Math.abs(t.y + 1.2 - car.y) > 4.5) continue;
      taken[i] = 1;
      const res = progress.takeToken(i);
      if (view && view.collect) view.collect(i);
      if (particles && particles.emitSparks) {
        particles.emitSparks(t.x, t.y + 1.3, t.z, 60, 0, 0);
      }
      play('token');
      if (res && overlay) overlay.popup('token', `TOKEN ${res.count}/${tokens.length}`, `+$${res.cash}`);
      if (res && res.levelUp) { play('level'); if (overlay) overlay.popup('level', `LEVEL ${res.levelUp}!`, 'New cars within reach in the garage'); }
    }
  }

  // ---- traps and jumps ----------------------------------------------------------------

  function trapStep() {
    if (!prevValid) return;
    for (const c of list) {
      if (c.kind !== 'trap') continue;
      const dx = car.x - c.x, dz = car.z - c.z;
      if (dx * dx + dz * dz > 60 * 60) continue;
      if (cooldown[c.id] > clock) continue;
      const a0 = (prevX - c.x) * c.tx + (prevZ - c.z) * c.tz;
      const a1 = dx * c.tx + dz * c.tz;
      const lat = Math.abs(dx * -c.tz + dz * c.tx);
      if ((a0 < 0) === (a1 < 0) || lat > c.hw + 6) continue;
      const kmh = Math.round(car.speed * 3.6);
      cooldown[c.id] = clock + 2;
      const medal = scoreMedal(kmh, c.targets);
      if (view && view.flashTrap) view.flashTrap(c.id);
      play('trap');
      const res = progress.record(c, kmh, medal);
      showResult(c, kmh, res);
      afterChallenge(c);
    }
  }

  function jumpLanded() {
    const c = jump.c;
    const r = ramps[c.rampIndex];
    const dist = Math.hypot(car.x - r.lipX, car.z - r.lipZ);
    const air = car.airTime || (clock - jump.t);
    jump = null;
    // Under 3 m is rolling off the lip; over 150 m is not a jump this ramp
    // can give (110 km/h flies 64) and means the measurement is wrong.
    if (dist < 3 || dist > 150) return;
    const m = Math.round(dist);
    const medal = scoreMedal(m, c.targets);
    play('land');
    const res = progress.record(c, m, medal);
    showResult(c, m, res);
    if (overlay) overlay.popup('jump', `${m} m`, `${air.toFixed(1)} s of air`);
    afterChallenge(c);
  }

  // ---- the GPS ----------------------------------------------------------------------

  function navStep(dt) {
    // While a race runs, the race IS the route.
    let routeC = race.c && race.phase ? race.c : zone.c;
    if (!routeC) {
      if (manualTarget && target !== manualTarget) setTarget(manualTarget, false);
      if (!target) setTarget(manualTarget || recommend(null), false);
    }
    if (routeC) {
      const r = routeC.kind === 'race' ? routeC.route : routeC.zone;
      if (nav.route !== r) { nav.route = r; nav.hint = -1; nav.planFor = routeC; }
    } else if (target && (nav.planFor !== target || (nav.off > REPLAN_HOLD && clock - nav.planAt > 1.5))) {
      nav.route = plan(target);
      nav.planFor = target;
      nav.planAt = clock;
      nav.hint = -1;
      nav.off = 0;
    }
    const r = nav.route;
    if (!r || r.n < 2) { vs.route = null; hudNav.route = null; vs.arrow = false; return; }
    const pr = r.project(car.x, car.z, nav.hint, 40, projScratch);
    if (nav.hint >= 0 && pr.dist > 25) r.project(car.x, car.z, -1, 0, projScratch);
    nav.hint = projScratch.i;
    nav.d = projScratch.d;
    nav.off = projScratch.dist > OFF_ROUTE ? nav.off + dt : 0;
    // Distance to the challenge itself — while racing, to the finish.
    const over = routeC ? 0 : (nav.planFor && nav.planFor.overrun) || 0;
    nav.dist = Math.max(0, r.length - nav.d - over);

    vs.route = r; vs.routeD = nav.d; vs.routeEnd = r.length;
    hudNav.route = r; hudNav.from = nav.hint;
    // Arrow: at the road 30 m on, or straight at the target when it is close.
    const ahead = r.at(Math.min(r.length, nav.d + 30), arrowScratch);
    vs.arrow = true;
    vs.arrowX = ahead.x; vs.arrowZ = ahead.z;
  }
  const arrowScratch = {};

  // ---- the on-screen words -------------------------------------------------------------

  // What the banner said last time, so its strings are only rebuilt when what
  // it says changes — never once a frame.
  const objWas = { c: null, mode: '', near: false, medal: -1, first: false };

  function objectiveText() {
    const o = ui.objective;
    const c = race.c || zone.c || target;
    const mode = race.c ? race.phase : zone.c ? 'zone' : 'target';
    const first = !race.c && !zone.c && c === rookie && !progress.flag('rookieDone');
    const near = !race.c && !zone.c && !!nav.route && nav.dist < 120;
    const medal = c ? progress.medalOf(c.id) : -1;
    o.dist = !c || race.c || zone.c ? -1 : nav.route ? nav.dist : Math.hypot(c.start.x - car.x, c.start.z - car.z);
    if (c === objWas.c && mode === objWas.mode && near === objWas.near && medal === objWas.medal && first === objWas.first) return;
    objWas.c = c; objWas.mode = mode; objWas.near = near; objWas.medal = medal; objWas.first = first;

    if (!c) { o.kind = ''; o.title = ''; o.detail = ''; return; }
    o.kind = c.kind;
    if (race.c) {
      o.title = c.name;
      o.detail = race.phase === 'countdown' ? 'Get ready…' : c.lap ? 'One lap — follow the gates' : 'Follow the gates to the finish';
      return;
    }
    if (zone.c) { o.title = c.name; o.detail = 'Slide it! Score counts until the end banner'; return; }
    if (first) {
      o.title = near ? 'Drive into the glowing ring!' : 'Follow the arrow to your first race';
      o.detail = c.name;
      return;
    }
    o.title = near ? KIND_VERB[c.kind] : `${KIND_LABEL[c.kind]}: ${c.name}`;
    const nm = Math.min(MEDAL_GOLD, medal + 1);
    const tgt = c.kind === 'race' ? formatTime(c.targets[nm]) : `${c.targets[nm]} ${c.unit}`;
    o.detail = medal >= MEDAL_GOLD ? 'Gold already — beat your best' : `${MEDAL_NAMES[nm][0].toUpperCase()}${MEDAL_NAMES[nm].slice(1)}: ${tgt}`;
  }

  function raceUi() {
    const r = ui.race;
    r.active = !!race.c;
    if (!race.c) { r.phase = ''; return; }
    const c = race.c;
    r.phase = race.phase; r.name = c.name; r.time = race.t; r.lap = c.lap;
    r.cp = race.next; r.cpTotal = c.gates.length; r.countdown = race.count;
    // The medal still in reach: the best one the clock has not passed yet.
    let tm = MEDAL_NONE;
    for (let m = MEDAL_GOLD; m >= MEDAL_BRONZE; m--) if (race.t <= c.targets[m]) { tm = m; break; }
    r.targetMedal = tm; r.targetTime = tm ? c.targets[tm] : 0;
  }

  function zoneUi() {
    const z = ui.zone;
    z.active = !!zone.c;
    if (!zone.c) return;
    z.name = zone.c.name; z.score = zone.score;
    let tm = MEDAL_GOLD;
    for (let m = MEDAL_BRONZE; m <= MEDAL_GOLD; m++) if (zone.score < zone.c.targets[m]) { tm = m; break; }
    z.targetMedal = tm; z.targetScore = zone.c.targets[tm];
  }

  // ---- the frame ------------------------------------------------------------------------

  function update(dt, ctx) {
    // Belt and braces: whatever happened in the physics loop, the ramps are
    // never left in the ground for the renderers to stream into chunks.
    rampGround.disable();
    clock += dt;
    driving = !!(ctx && ctx.driving);
    vs.time = clock;
    vs.driving = driving;
    const jumped = Math.hypot(car.x - prevX, car.z - prevZ) > 60;
    // A cut (R, the map, a respawn) ends any flight in progress: measured as
    // a landing, the distance to wherever the car was put reads as a 400 m
    // jump, which the harness caught before a player could.
    if (jumped) { prevValid = false; jump = null; }

    if (driving) {
      tokenStep();
      if (race.c) raceStep(dt);
      else {
        // Race start rings. The race the GPS is leading to starts the moment
        // the car touches its ring. Any OTHER ring the road happens to pass
        // through asks the player to stop in it first — otherwise a kid
        // following the arrow to a speed trap gets snapped onto a grid for a
        // race nobody asked for.
        ringHint = '';
        for (const c of list) {
          if (c.kind !== 'race') continue;
          const dx = car.x - c.start.x, dz = car.z - c.start.z;
          const r = c.start.hw + 4;
          const d2 = dx * dx + dz * dz;
          if (disarmed.has(c.id)) { if (d2 > (r + 8) * (r + 8)) disarmed.delete(c.id); continue; }
          if (d2 >= r * r) continue;
          if (c === target || car.speed < 4) { beginRace(c); break; }
          ringHint = c.ringHint || (c.ringHint = `Stop in the ring to race ${c.name}`);
        }
      }
      if (!race.c) {
        trapStep();
        if (zone.c) zoneStep(dt);
        else if (prevValid) {
          for (const c of list) {
            if (c.kind !== 'drift' || cooldown[c.id] > clock) continue;
            const g = c.gate;
            const dx = car.x - g.x, dz = car.z - g.z;
            if (dx * dx + dz * dz > 40 * 40) continue;
            const a0 = (prevX - g.x) * g.tx + (prevZ - g.z) * g.tz;
            const a1 = dx * g.tx + dz * g.tz;
            if (a0 < 0 && a1 >= 0 && Math.abs(dx * -g.tz + dz * g.tx) < g.hw + 5) { beginZone(c); break; }
          }
        }
      }
      if (jump && !car.airborne) jumpLanded();
      // A launch the lip rule did not see (step() not wired): catch it here.
      if (!jump && car.airborne) {
        for (const r of ramps) {
          const dx = car.x - r.lipX, dz = car.z - r.lipZ;
          if (dx * dx + dz * dz < 20 * 20) { jump = { c: byId[r.id], t: clock }; play('launch'); break; }
        }
      }
      navStep(dt);
      if (lastResult && clock > lastResult.until) { lastResult = null; if (overlay) overlay.hideResult(); }
    }

    // Presentation.
    objectiveText();
    raceUi();
    zoneUi();
    ui.wallet.cash = progress.cash;
    const lv = levelFor(progress.xp);
    ui.wallet.level = lv.level; ui.wallet.frac = lv.frac;
    ui.hint = race.c && race.lost > 3 ? 'Lost? Press R to jump back to the last checkpoint'
      : ringHint ? ringHint
      : nav.off > 4 && !race.c ? 'Wrong way — the arrow knows the road' : '';
    if (ui.race.deltaAge < 99) ui.race.deltaAge += dt;

    vs.target = target; vs.race = race.c; vs.nextGate = race.next; vs.zone = zone.c;
    if (view) view.update(dt, vs);
    if (overlay) { overlay.setVisible(driving); overlay.update(dt, ui); }

    prevX = car.x; prevZ = car.z; prevValid = true;
  }

  /** Once per physics step, BEFORE car.step(): the ramps become ground. */
  function preStep() { rampGround.enable(); }

  /** Once per physics step, after car.step(): the ramp lips, then the ramps go. */
  function step() {
    rampGround.disable();
    const hit = kickRamps(car, ramps, kickState);
    if (hit >= 0 && !jump) {
      jump = { c: byId[ramps[hit].id], t: clock };
      play('launch');
    }
  }

  // ---- the session ---------------------------------------------------------------------

  /** Called while booting: put the car 200 m from whatever is next, facing it. */
  function placeInitial() {
    setTarget(recommend(null), false);
    return spawnFor(target);
  }

  /** Called when the player presses Drive. */
  function onDrive(fresh) {
    if (!started || fresh) {
      started = true;
      const touch = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
      if (overlay && !progress.flag('controlsShown')) {
        overlay.controls(true, touch);
        progress.setFlag('controlsShown');
      }
      if (!target) setTarget(recommend(null), false);
    }
  }

  /** R pressed. Returns true if the goals handled it (a race respawn). */
  function respawn() {
    if (!race.c || race.phase !== 'running') return false;
    const c = race.c;
    const g = race.lastGate >= 0 ? c.gates[race.lastGate] : c.start;
    spawnAt(c.route, Math.max(0, g.d + (race.lastGate >= 0 ? 4 : 0)));
    race.hint = -1;
    race.lost = 0;
    toast('Back on track — the clock kept running', 2);
    return true;
  }

  function travelTo(id) {
    const c = byId[id];
    if (!c) return false;
    abandonRace();
    endZone(false);
    setTarget(c, true);
    return spawnFor(c);
  }

  /** G: the next suggestion after the current target. */
  function cycleTarget() {
    if (race.c) return null;
    const ranked = list.slice().sort((a, b) => {
      const sa = Math.hypot(a.start.x - car.x, a.start.z - car.z) + progress.medalOf(a.id) * 1400;
      const sb = Math.hypot(b.start.x - car.x, b.start.z - car.z) + progress.medalOf(b.id) * 1400;
      return sa - sb;
    }).slice(0, 6);
    const i = ranked.indexOf(target);
    const next = ranked[(i + 1) % ranked.length];
    setTarget(next, true);
    toast(`GPS: ${KIND_LABEL[next.kind]} — ${next.name}`, 2.2);
    return next;
  }

  // Keys this layer owns. Bubble phase on window, like controls.js, and deaf
  // unless the player is actually driving — the menus consume their own keys
  // at capture phase before these could ever see them.
  function onKey(e) {
    if (!driving || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'KeyG') cycleTarget();
    else if (e.code === 'Enter' && lastResult) restart();
    else if (e.code === 'Backspace' && race.c) abandonRace('Race abandoned');
  }
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  /**
   * Re-read everything derived from progress — after a reset from the
   * settings screen the tokens come back, the rings lose their medal colours
   * and the rookie race is next again.
   */
  function resync() {
    for (let i = 0; i < tokens.length; i++) taken[i] = progress.hasToken(i) ? 1 : 0;
    for (const m of markers) m.medal = progress.medalOf(m.id);
    if (view && view.setMedal) for (const c of list) view.setMedal(c.id, progress.medalOf(c.id));
    abandonRace();
    endZone(false);
    manualTarget = null;
    setTarget(recommend(null), false);
  }

  function dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
    rampGround.disable();
    if (view) view.dispose();
    if (overlay) overlay.dispose();
    if (sfx) sfx.dispose();
  }

  return {
    list, tokens, ramps, graph, progress, byId,
    genMs,
    /** For main.js: hold the car on the brakes (the countdown). */
    get hold() { return race.phase === 'countdown'; },
    get activeRace() { return race.c; },
    get target() { return target; },
    get nav() { return hudNav; },
    get ui() { return ui; },
    get sfx() { return sfx; },
    update, preStep, step, placeInitial, onDrive, respawn, travelTo, restart,
    abandon: () => { abandonRace('Race abandoned'); endZone(false); lastResult = null; if (overlay) overlay.hideResult(); },
    setTarget: (id) => { const c = byId[id]; if (c) setTarget(c, true); return !!c; },
    cycleTarget, resync, recommend: () => recommend(null),
    /** For the harness: the internals it needs to drive a race from code. */
    _race: race, _zone: zone,
    dispose,
  };
}
