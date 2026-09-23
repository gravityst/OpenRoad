// Skill chains: the thing to do between the things to do.
//
// Challenges are places. Between them is road, and on the road the game used
// to have nothing to say — you could scrape past a truck at 150 km/h and it
// was worth exactly as much as sitting behind it. A skill chain is the game
// noticing. Near misses, slipstreams, airtime, speed, drifts and clean
// driving are each a SKILL; every skill is a LINK; links build a MULTIPLIER
// that applies to the whole chain; and the chain BANKS once nothing happens
// for a few seconds — or is LOST, all of it, the moment you crash. That last
// rule is the whole game: a fat chain is something to protect, and the longer
// it runs the harder it is to stop pushing.
//
// Nothing breaks when you crash. There is no damage any more; a crash costs
// the chain and the clean-driving clock and nothing else.
//
// WHAT COUNTS
//
//   near miss    a traffic car passed with under NEAR_GAP of daylight between
//                the two bodies, at 50 km/h or more, without touching it.
//                Oncoming is worth half as much again; under 0.35 m is RAZOR.
//   slipstream   tucked in behind a car going your way, 60 km/h or more: a
//                link after 1.5 s in the tow, and one every 2.5 s after.
//   slingshot    pulling out of a tow and passing that same car within 3 s.
//   air          0.45 s or more off the ground. Worth air^1.3, so one big
//                jump beats two small ones.
//   speed        holding 140, 170, 200 or 230 km/h for a second. Each
//                milestone once, until you drop 20 km/h below it — a straight
//                is worth a few links, not a farm.
//   drift        whatever the drift scorer banks (drift.js), point for point.
//   clean        every 15 s above 40 km/h without so much as a scrape, worth
//                more each time.
//
// The chain's timer does not run down while a drift is live, in a slipstream
// or in the air: those are skills in progress, and banking a chain in the
// middle of one would be the game interrupting the player.
//
// Pure: no DOM, no three.js. It reads the car, the traffic pool and the drift
// state it is handed and never writes to any of them. Every frame is a loop
// over the traffic pool with no allocation — the events it emits come from a
// fixed pool (see EVENT_POOL), because a skill fires at most a few times a
// second and a string built then costs nothing that matters, but the frame
// path itself must not hand the collector anything.
// tools/skillscheck.mjs checks the maths and the detectors.

const KMH = 3.6;

// ---- the chain -------------------------------------------------------------
export const CHAIN = {
  BANK_TIME: 4.5,     // s after the last link before a chain banks
  MULT_STEP: 0.5,     // each link after the first adds half a multiplier...
  MAX_MULT: 10,       // ...up to x10, reached on the 19th link
  CRASH: 0.18,        // collision severity that loses the chain: ~3 m/s into a wall
  SCRAPE: 0.06,       // severity that breaks the clean-driving clock but keeps the chain
};

// Banked value to reward. Calibrated against driving the starter car through
// traffic (tools/skillscheck.mjs, "a lap of the highway"): an ordinary chain
// of five or six links banks 4,000-6,000 and pays 50-75 XP and ~$80, a race
// bronze is 120 XP and $400, and a monster x10 chain of 40,000 pays about a
// level at level 6 and ~$650 — a paint, not the garage.
export const SKILL_XP_PER = 80;     // chain points per XP
export const SKILL_CASH_PER = 60;   // chain points per $

// ---- detectors -------------------------------------------------------------
const NEAR_GAP = 1.4;           // m of daylight, body to body, that counts as near
const RAZOR_GAP = 0.35;         // m: closer than this is RAZOR
const CONTACT_GAP = 0.05;       // m: boxes this close have touched
const NEAR_MIN_SPEED = 13.9;    // m/s, 50 km/h: below it you are parking, not weaving
const NEAR_MIN_CLOSING = 4;     // m/s along your heading: the pass has to be YOURS
const NEAR_BASE = 250;
const ONCOMING_BONUS = 1.5;
const SCAN_R = 45;              // m: nothing further away can be passed this frame

const TOW_MIN_SPEED = 16.7;     // m/s, 60 km/h
const TOW_LEAD_MIN_SPEED = 8;   // m/s: tucked behind a parked car is not a tow
const TOW_MAX_GAP = 22;         // m behind the car ahead
const TOW_LANE = 1.3;           // m either side of its centreline
const TOW_FIRST = 1.5;          // s before the first tow link
const TOW_EVERY = 2.5;          // s between later ones
const TOW_POINTS = 200;
const SLING_WINDOW = 3;         // s after leaving a tow to pass the car
const SLING_POINTS = 400;

const AIR_MIN = 0.45;           // s: under this it was a bump
const AIR_BASE = 350;           // points for one second of air
const AIR_BIG = 1.2;            // s
const AIR_HUGE = 2.0;           // s: a gold jump (110 km/h) flies 2.1-2.2 s

const SPEED_STEPS = [140, 170, 200, 230];   // km/h
const SPEED_HOLD = 1.0;         // s above a milestone before it pays
const SPEED_REARM = 20;         // km/h below a milestone before it can pay again

const CLEAN_STEP = 15;          // s of clean driving per link
const CLEAN_MIN_SPEED = 11;     // m/s, 40 km/h: the clock only runs while driving
const CLEAN_POINTS = 150;       // times the link's number, capped
const CLEAN_CAP = 10;

const TELEPORT = 25;            // m in one frame is a cut, not a drive

const EVENT_POOL = 24;

/** The multiplier a chain of `links` carries. */
export function chainMultiplier(links) {
  if (!(links >= 1)) return 1;
  return Math.min(CHAIN.MAX_MULT, 1 + (Math.floor(links) - 1) * CHAIN.MULT_STEP);
}

/** What a chain is worth: its points times its multiplier, retroactively. */
export function chainValue(points, links) {
  const p = Number.isFinite(points) && points > 0 ? points : 0;
  return Math.round(p * chainMultiplier(links));
}

/** XP and cash for a banked value. */
export function chainPayout(value) {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  return { xp: Math.floor(v / SKILL_XP_PER), cash: Math.floor(v / SKILL_CASH_PER) };
}

/** Points for a near miss with `clear` metres of daylight at `speed` m/s. */
export function nearMissPoints(clear, speed, oncoming) {
  const c = Math.max(0, Math.min(NEAR_GAP, clear));
  const closeness = 1 + 1.5 * (1 - c / NEAR_GAP);
  const pace = Math.max(0.7, Math.min(1.6, speed / 25));
  const pts = NEAR_BASE * closeness * pace * (oncoming ? ONCOMING_BONUS : 1);
  return Math.round(pts / 10) * 10;
}

/** Points for `air` seconds off the ground. */
export function airPoints(air) {
  if (!(air >= AIR_MIN)) return 0;
  return Math.round((AIR_BASE * Math.pow(air, 1.3)) / 10) * 10;
}

const SPEED_LABEL = SPEED_STEPS.map((k) => `${k}+ KM/H`);

/**
 * opts.crash   severity that loses a chain (default CHAIN.CRASH)
 * opts.bankTime seconds (default CHAIN.BANK_TIME)
 */
export function createSkills(opts = {}) {
  const crashAt = opts.crash != null ? opts.crash : CHAIN.CRASH;
  const bankTime = opts.bankTime != null ? opts.bankTime : CHAIN.BANK_TIME;

  const state = {
    live: false,       // a chain is running
    links: 0,
    points: 0,         // before the multiplier
    mult: 1,
    value: 0,          // points x mult: what banking now would pay
    timer: 0,          // s left before it banks
    timerFrac: 0,      // timer / bankTime, for the meter
    hold: false,       // the timer is paused by a skill in progress
    best: 0,           // best chain banked this session
    // The last chain to END, for the meter's bank/lost flash. `age` counts up.
    last: { kind: 'none', value: 0, links: 0, mult: 1, age: 99 },
    // Skills in progress, for the HUD.
    towing: false, towT: 0, airT: 0, cleanT: 0, kmh: 0,
  };

  // ---- events: a fixed pool, drained by the caller every frame ----
  const pool = [];
  for (let i = 0; i < EVENT_POOL; i++) {
    pool.push({ kind: '', label: '', points: 0, value: 0, mult: 1, links: 0, amount: 0 });
  }
  let evCount = 0;
  function emit(kind, label, points, amount) {
    if (evCount >= EVENT_POOL) return null;      // never happens in play: a frame emits two at most
    const e = pool[evCount++];
    e.kind = kind; e.label = label; e.points = points; e.amount = amount || 0;
    e.value = state.value; e.mult = state.mult; e.links = state.links;
    return e;
  }

  // ---- the chain ----
  function link(kind, label, points, amount) {
    const pts = Math.max(0, Math.round(points));
    state.live = true;
    state.links++;
    state.points += pts;
    state.mult = chainMultiplier(state.links);
    state.value = chainValue(state.points, state.links);
    state.timer = bankTime;
    state.timerFrac = 1;
    return emit(kind, label, pts, amount);
  }

  function endChain(kind) {
    if (!state.live) return;
    const l = state.last;
    l.kind = kind; l.value = state.value; l.links = state.links; l.mult = state.mult; l.age = 0;
    if (kind === 'bank' && state.value > state.best) state.best = state.value;
    emit(kind, kind === 'bank' ? 'BANKED' : 'CHAIN LOST', 0, state.value);
    state.live = false;
    state.links = 0; state.points = 0; state.mult = 1; state.value = 0;
    state.timer = 0; state.timerFrac = 0;
  }

  // ---- per traffic slot, grown to the pool's size once ----
  let cap = 0;
  let stage = new Uint8Array(0);       // 0 idle, 1 came alongside from ahead, 2 from behind
  let minClear = new Float32Array(0);
  let touched = new Uint8Array(0);
  let respawn = new Int32Array(0);
  function ensure(n) {
    if (n <= cap) return;
    const grow = Math.max(n, cap * 2, 32);
    const s2 = new Uint8Array(grow); s2.set(stage); stage = s2;
    const m2 = new Float32Array(grow).fill(99); m2.set(minClear); minClear = m2;
    const t2 = new Uint8Array(grow); t2.set(touched); touched = t2;
    const r2 = new Int32Array(grow).fill(-1); r2.set(respawn); respawn = r2;
    cap = grow;
  }
  function forgetTraffic() {
    stage.fill(0); minClear.fill(99); touched.fill(0);
  }

  // ---- the rest of the detector state ----
  let towCar = -1, towRun = 0, towNext = TOW_FIRST;
  let lastTow = -1, lastTowEnd = -99;
  let airborne = false;
  const speedArmed = new Uint8Array(SPEED_STEPS.length).fill(1);
  const speedHeld = new Float32Array(SPEED_STEPS.length);
  let cleanLinks = 0;
  let driftBanked = -1;
  let clock = 0;
  let px = 0, pz = 0, havePrev = false;
  // Seconds in a tow since the caller last collected them (a daily metric
  // that accrues continuously, so it is handed over in lumps, not per frame).
  const tally = { tow: 0 };

  /**
   * One frame.
   *   car      the player's vehicle (x, z, yaw, vx, vz, speed, airborne, spec)
   *   cars     the traffic pool (or null)
   *   drift    drift.js state (or null)
   *   driving  false freezes everything: menus, a race countdown
   */
  function update(dt, car, cars, drift, driving) {
    if (!(dt > 0) || !car) return state;
    const d = dt > 0.1 ? 0.1 : dt;
    state.last.age += d;
    if (!driving) { havePrev = false; return state; }
    clock += d;

    // A cut — R, the map, a race respawn — banks whatever was running and
    // forgets every car alongside: the car it was passing is not there now.
    if (havePrev && Math.abs(car.x - px) + Math.abs(car.z - pz) > TELEPORT) {
      endChain('bank');
      forgetTraffic();
      towCar = -1; towRun = 0; towNext = TOW_FIRST;
      airborne = false; state.airT = 0;
    }
    px = car.x; pz = car.z; havePrev = true;

    const speed = Number.isFinite(car.speed) ? car.speed : 0;
    const kmh = speed * KMH;
    state.kmh = kmh;
    const yaw = car.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);

    // ---- traffic: near misses and the slipstream ----
    let towing = -1;
    if (cars && cars.length) {
      ensure(cars.length);
      const spec = car.spec || {};
      const ahw = (spec.track || 1.6) * 0.5 + 0.16;           // collision.js's own box
      const ahl = (spec.wheelbase || 2.6) * 0.5 + 0.52;
      let bestTowGap = TOW_MAX_GAP;
      for (let i = 0; i < cars.length; i++) {
        const o = cars[i];
        if (!o || o.active === false) { stage[i] = 0; continue; }
        if (respawn[i] !== (o.respawnId | 0)) {
          respawn[i] = o.respawnId | 0;
          stage[i] = 0; minClear[i] = 99; touched[i] = 0;
        }
        const dx = o.x - car.x, dz = o.z - car.z;
        if (dx * dx + dz * dz > SCAN_R * SCAN_R) { stage[i] = 0; continue; }
        const lon = dx * fx + dz * fz;          // + ahead
        const lat = dx * rx + dz * rz;          // + to the right
        const dyaw = o.yaw - yaw;
        const c = Math.cos(dyaw), s = Math.sin(dyaw);
        const ac = c < 0 ? -c : c, as = s < 0 ? -s : s;
        const ohw = (o.spec && o.spec.track ? o.spec.track : 1.6) * 0.5 + 0.16;
        const ohl = o.halfLen != null ? o.halfLen : 2.2;
        // The other box's half-extents along MY axes.
        const extLat = ac * ohw + as * ohl;
        const extLon = ac * ohl + as * ohw;
        const clear = (lat < 0 ? -lat : lat) - ahw - extLat;
        const span = ahl + extLon;
        const alongside = lon < span && lon > -span;

        if (alongside) {
          if (stage[i] === 0) {
            // Which end did it come in from? Ahead means I am passing it (or it
            // is coming at me); behind means it is passing me, which is its
            // skill, not mine.
            stage[i] = lon > 0 ? 1 : 2;
            minClear[i] = 99; touched[i] = 0;
          }
          if (clear < minClear[i]) minClear[i] = clear;
          if (clear < CONTACT_GAP) touched[i] = 1;
        } else if (stage[i] !== 0) {
          if (stage[i] === 1 && lon <= -span) passed(i, o, c, speed, fx, fz);
          stage[i] = 0;
        }

        // Slipstream: the nearest car dead ahead, going my way.
        if (c > 0.9 && lon > span + 0.3 && lon < bestTowGap && (lat < 0 ? -lat : lat) < TOW_LANE &&
            speed > TOW_MIN_SPEED && (o.speed || 0) > TOW_LEAD_MIN_SPEED) {
          bestTowGap = lon;
          towing = i;
        }
      }
    }

    if (towing >= 0) {
      if (towing !== towCar) { towCar = towing; towRun = 0; towNext = TOW_FIRST; }
      towRun += d;
      tally.tow += d;
      if (towRun >= towNext) {
        link('tow', 'SLIPSTREAM', TOW_POINTS, towRun);
        towNext += TOW_EVERY;
      }
    } else if (towCar >= 0) {
      // Out of the tow — the slingshot window opens on that car.
      if (towRun >= TOW_FIRST * 0.5) { lastTow = towCar; lastTowEnd = clock; }
      towCar = -1; towRun = 0; towNext = TOW_FIRST;
    }
    state.towing = towCar >= 0;
    state.towT = towRun;

    // ---- air ----
    if (car.airborne) {
      if (!airborne) { airborne = true; state.airT = 0; }
      state.airT += d;
    } else if (airborne) {
      airborne = false;
      const air = state.airT;
      if (air >= AIR_MIN) {
        const label = air >= AIR_HUGE ? 'HUGE AIR' : air >= AIR_BIG ? 'BIG AIR' : 'AIR';
        link('air', label, airPoints(air), air);
      }
      state.airT = 0;
    }

    // ---- speed milestones ----
    for (let k = 0; k < SPEED_STEPS.length; k++) {
      const m = SPEED_STEPS[k];
      if (!speedArmed[k]) {
        if (kmh < m - SPEED_REARM) { speedArmed[k] = 1; speedHeld[k] = 0; }
        continue;
      }
      if (kmh >= m) {
        speedHeld[k] += d;
        if (speedHeld[k] >= SPEED_HOLD) {
          speedArmed[k] = 0;
          link('speed', SPEED_LABEL[k], m * 2, m);
        }
      } else speedHeld[k] = 0;
    }

    // ---- drift: bank for bank ----
    if (drift) {
      const b = Number.isFinite(drift.banked) ? drift.banked : 0;
      if (driftBanked < 0 || b < driftBanked) driftBanked = b;       // first sight, or drift.reset()
      else if (b > driftBanked + 0.5) {
        const pts = b - driftBanked;
        driftBanked = b;
        link('drift', 'DRIFT', pts, pts);
      }
    }

    // ---- clean driving ----
    if (speed > CLEAN_MIN_SPEED) {
      state.cleanT += d;
      const k = Math.floor(state.cleanT / CLEAN_STEP);
      if (k > cleanLinks) {
        cleanLinks = k;
        link('clean', `CLEAN ${k * CLEAN_STEP}s`, CLEAN_POINTS * Math.min(k, CLEAN_CAP), state.cleanT);
      }
    }

    // ---- the timer ----
    const driftLive = !!(drift && (drift.active || drift.combo > 0));
    state.hold = driftLive || state.towing || airborne;
    if (state.live && !state.hold) {
      state.timer -= d;
      if (state.timer <= 0) endChain('bank');
    }
    state.timerFrac = state.live ? Math.max(0, Math.min(1, state.timer / bankTime)) : 0;
    return state;
  }

  function passed(i, o, c, speed, fx, fz) {
    // Closing speed along my heading: mine less its component along it.
    const ovx = -Math.sin(o.yaw) * (o.speed || 0), ovz = -Math.cos(o.yaw) * (o.speed || 0);
    const closing = speed - (ovx * fx + ovz * fz);
    const was = i === lastTow && clock - lastTowEnd < SLING_WINDOW;
    if (touched[i] || speed < NEAR_MIN_SPEED || closing < NEAR_MIN_CLOSING) return;
    if (was) { lastTow = -1; link('sling', 'SLINGSHOT', SLING_POINTS, closing); }
    const clear = minClear[i];
    if (clear >= NEAR_GAP) return;
    const oncoming = c < -0.5;
    const label = clear < RAZOR_GAP ? (oncoming ? 'RAZOR ONCOMING' : 'RAZOR CLOSE')
      : oncoming ? 'ONCOMING' : 'NEAR MISS';
    link(oncoming ? 'oncoming' : 'near', label, nearMissPoints(clear, speed, oncoming), clear);
  }

  /**
   * A collision, from main.js's solver: `severity` as collision.resolve()
   * reports it (normal speed / 18 for a wall, closing / 16 for a car).
   */
  function onCrash(severity) {
    if (!(severity >= CHAIN.SCRAPE)) return;
    state.cleanT = 0;
    cleanLinks = 0;
    if (severity >= crashAt) endChain('lost');
  }

  /** Ends the chain now, paying it out — a race finishing, the player quitting. */
  function bank() { endChain('bank'); }

  /** A new session: nothing carried over. */
  function reset() {
    state.live = false; state.links = 0; state.points = 0; state.mult = 1; state.value = 0;
    state.timer = 0; state.timerFrac = 0; state.hold = false;
    state.last.kind = 'none'; state.last.age = 99;
    state.towing = false; state.towT = 0; state.airT = 0; state.cleanT = 0;
    forgetTraffic();
    towCar = -1; towRun = 0; towNext = TOW_FIRST; lastTow = -1;
    airborne = false; cleanLinks = 0; driftBanked = -1; havePrev = false;
    speedArmed.fill(1); speedHeld.fill(0);
    evCount = 0;
  }

  return {
    state,
    update, onCrash, bank, reset,
    /** Events emitted since the last clearEvents(), in order. */
    get eventCount() { return evCount; },
    event: (i) => pool[i],
    clearEvents() { evCount = 0; },
    /** Seconds of slipstream since the last call, then zeroed. */
    takeTow() { const t = tally.tow; tally.tow = 0; return t; },
  };
}
