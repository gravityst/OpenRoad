// Drift detection and scoring.
//
// WHAT A DRIFT IS, AND WHY IT IS NOT `car.slipping`
//
// The vehicle already publishes `slipping` — how far past the peak of the tyre
// curve the worst axle is. That is the right number for smoke, skid marks and
// tyre noise, and the wrong number for scoring, because it is a property of the
// TYRES and a drift is a property of the CAR. A car understeering straight on
// at full lock has slipping near 1.0 and is not drifting; a long fourth-gear
// slide settled at 30 degrees can sit at slipping 0.3 and is the best drift the
// player will do all night. Scored on slip, the game pays out for the thing
// that feels like a mistake and ignores the thing that feels like skill.
//
// So the angle scored here is the one the player can actually see from the
// chase camera: the angle between where the nose points and where the car is
// going. HEADING against VELOCITY, nothing else.
//
//   angle = atan2(v . right, v . forward)
//
// Sign follows the coordinate convention in vehicle.js (forward = -Z,
// right = +X, yaw counter-clockwise from above): POSITIVE angle means the
// velocity vector lies to the car's right, i.e. the nose is aimed left of
// travel and the tail is hung out to the right — a left-hand slide. Negative is
// the mirror. A HUD gauge can point the needle straight at `angle`.
//
// EVERYTHING ELSE IS HYSTERESIS
//
// A drift detector without hysteresis is not a detector, it is a strobe. Any
// road car twitches across a few degrees of slip on every camber change, so a
// single threshold makes `active` chatter at frame rate, the combo counter runs
// away, and the HUD flashes "DRIFT" at a driver going straight. There are three
// separate margins below and every one of them earns its place:
//
//   * an ANGLE dead band — the twitch itself. Measured by walking the angle up
//     and back down, it latches on at 12.3 deg and releases at 6.7 deg: 5.6 deg
//     of margin, against a car that is settled at 8.0 deg while merely being
//     driven fast.
//   * a TIME hold at each edge (0.12 s in, 0.30 s out) — noise inside the band.
//     A square wave straddling the band at 120 Hz for fifty seconds changes the
//     state zero times.
//   * a LINK WINDOW after a clean exit (1.25 s) — the straight moment between
//     two halves of an S, which is part of one chain and not the end of it.
//
// Over one 8.7 s corner slide, tools/driftcheck.mjs counts exactly two
// transitions of `active`: in, and out.
//
// ELECTRONIC STABILITY MATTERS, AND NOT THE WAY YOU WOULD EXPECT
//
// The obvious assumption is that drifting wants ESC off. Measured against this
// car, the opposite is true, and it is worth knowing before tuning anything
// here. Handed the same countersteering driver asking for 34 degrees at
// 100 km/h, `settings.esc` ON (aids.stability 0.62) settles at a steady 27 deg
// and holds it for as long as there is road; the identical driver with ESC OFF
// is through 112 deg inside two seconds and never comes back.
//
// The reason is in vehicle.js: steering lock is capped near the front tyre's
// own peak slip angle, about 16 deg at speed, and 16 deg of opposite lock is
// not enough to catch a slide of 30. The ESC yaw controller is what catches it.
// Turning ESC off does not unlock drifting here, it removes the only thing
// holding the slide together — an open-loop input at a fixed steering angle
// spins the car at every throttle setting that was tried.
//
// None of that changes the scoring, which is identical either way. It is
// recorded here because the natural instinct — "make the drift scorer assume
// ESC is off" — would be tuned against a car that only ever spins.

import { clamp, smoothstep } from '../world/noise.js';

const RAD2DEG = 180 / Math.PI;

// --- detection thresholds -------------------------------------------------
const ENTER_ANGLE = 0.21;      // rad, 12.0 deg — a drift has begun
const EXIT_ANGLE = 0.13;       // rad,  7.4 deg — it is over
const ENTER_HOLD = 0.12;       // s above ENTER_ANGLE before it counts
const EXIT_HOLD = 0.30;        // s below EXIT_ANGLE before it stops counting
const ENTER_SPEED = 9;         // m/s, ~32 km/h — below this it is a car park
const FLOOR_SPEED = 6;         // m/s, ~22 km/h — the chain cannot survive here
const ANGLE_FLOOR = 1.5;       // m/s below which atan2 is reporting noise
const LINK_WINDOW = 1.25;      // s of straight running a chain survives

// --- the spin -------------------------------------------------------------
// Past this the car is not sideways, it is backwards. The threshold moves with
// the surface (see SURFACE.hold) because 70 degrees on gravel is a drift and
// 70 degrees on tarmac is a passenger looking at the scenery through the
// windscreen he came in through.
const SPIN_ANGLE = 1.05;       // rad, 60 deg on dry asphalt
const SPIN_YAW = 2.4;          // rad/s, with the car already well past sideways
const SPIN_YAW_ANGLE = 0.85;   // rad, 49 deg — the angle that qualifies the above
const SPIN_HOLD = 0.10;        // s, so one noisy frame cannot end a chain

// --- scoring --------------------------------------------------------------
// Points per second at the reference angle, on dry asphalt, at the reference
// speed. Everything else is a multiplier on this, so it is the only number to
// turn if the whole economy needs rescaling.
const BASE = 100;
const REF_DEG = 25;            // the angle worth exactly BASE
const ANGLE_EXP = 1.6;         // superlinear: 50 deg pays 3.0x what 25 deg does
const SPEED_REF = 20;          // m/s worth exactly BASE
const SPEED_CAP = 4;           // no more than 4x from speed alone
const COMBO_STEP = 0.5;        // each linked drift adds half a multiplier
const MAX_MULT = 8;
const FLASH_TIME = 1.4;        // s the bank/lost flash stays lit

// --- proximity ------------------------------------------------------------
const EDGE_BONUS = 0.35;       // at most +35% for hanging it over the white line
const EDGE_NEAR = 1.6;         // m of clearance where the bonus starts
const EDGE_TOUCH = 0.15;       // m where it is fully paid
const NEAR_BONUS = 0.50;       // at most +50% for threading past solid scenery
const NEAR_FAR = 3.0;          // m
const NEAR_CLOSE = 0.4;        // m

// `pay` scales points per degree; `hold` scales the angle at which the car is
// declared spun. Loose surfaces let the back end sit further out for longer —
// asked for 60 degrees, the same driver settles at 36 on asphalt and 50 on
// gravel — which is exactly why they are forgiving to drift on and worth less
// per degree when you are.
//
// The two terms pull against each other on purpose. At 72 km/h a 35 degree
// slide pays 171 pts/s on tarmac and 140 on gravel (18% less), but gravel's
// ceiling sits at 74 degrees against tarmac's 58, so a drift taken all the way
// to the edge pays 465 on gravel against 384 on tarmac. Loose ground is the
// bigger, more spectacular number and the slower, longer road to it; tarmac
// pays better for every degree you dare. Neither is the obvious farm.
const SURFACE = {
  asphalt:  { pay: 1.00, hold: 1.00 },
  concrete: { pay: 0.98, hold: 1.02 },
  sidewalk: { pay: 0.95, hold: 1.05 },
  dirt:     { pay: 0.86, hold: 1.22 },
  gravel:   { pay: 0.82, hold: 1.30 },
  grass:    { pay: 0.78, hold: 1.34 },
  sand:     { pay: 0.74, hold: 1.40 },
  rock:     { pay: 0.88, hold: 1.15 },
};
const DEFAULT_SURFACE = SURFACE.asphalt;

/**
 * @param {object} [opts]
 * @param {object} [opts.ground]  createGround() result; enables the road-edge
 *   proximity bonus. Omitted, that bonus is simply never paid.
 * @param {(x:number,z:number)=>number} [opts.nearest]  metres to the nearest
 *   solid thing, for the scenery-proximity bonus. Optional for the same reason.
 * @param {number} [opts.crashSeverity]  impacts softer than this do not break a
 *   chain. Default 0.05, matching the severity main.js already ignores.
 * @param {number} [opts.base]  points per second at the reference angle/speed.
 */
export function createDrift(opts = {}) {
  const ground = opts.ground || null;
  const nearest = typeof opts.nearest === 'function' ? opts.nearest : null;
  const crashSeverity = opts.crashSeverity != null ? opts.crashSeverity : 0.05;
  const base = opts.base != null ? opts.base : BASE;

  // One result object, mutated in place. A fresh literal per bank would be a
  // handful of bytes an hour and still the wrong habit in a file the frame loop
  // calls; every scratch value in here is allocated once, at construction.
  const lastResult = { kind: 'none', points: 0, combo: 0, reason: '', age: 0 };
  const roadScratch = {};

  const state = {
    // --- what the HUD draws ---
    angle: 0,          // rad, signed. + = tail out to the right (left-hand slide)
    angleDeg: 0,       // the same thing in degrees, for a gauge face
    spinAngle: SPIN_ANGLE,   // rad, where THIS surface calls it a spin
    holdRatio: 0,      // |angle| / spinAngle — 1.0 is the edge of the cliff
    active: false,     // a drift is happening right now
    rate: 0,           // points per second at this instant
    proximity: 1,      // the live proximity multiplier, 1 = no bonus

    // --- the chain ---
    score: 0,          // points earned in this chain, before the multiplier
    combo: 0,          // linked drifts in this chain; 0 = no chain
    multiplier: 1,
    pending: 0,        // score * multiplier — what banking right now would pay
    chainSeconds: 0,
    linkWindow: 0,     // 0..1 of the link window left after a clean exit

    // --- the session ---
    banked: 0,         // only ever grows
    best: 0,           // best single chain banked; only ever grows
    lastResult,        // reused; read .kind and .age for the flash
    flash: 0,          // 1 at a bank or a loss, decaying to 0
  };

  let overTimer = 0;      // s the angle has been above ENTER_ANGLE
  let underTimer = 0;     // s it has been below EXIT_ANGLE
  let spinTimer = 0;      // s the car has looked spun
  let linkTimer = 0;      // s of link window remaining
  let disposed = false;

  function multiplierFor(combo) {
    return combo < 1 ? 1 : Math.min(MAX_MULT, 1 + (combo - 1) * COMBO_STEP);
  }

  function record(kind, points, combo, reason) {
    lastResult.kind = kind;
    lastResult.points = points;
    lastResult.combo = combo;
    lastResult.reason = reason;
    lastResult.age = 0;
    state.flash = 1;
  }

  function clearChain() {
    state.score = 0;
    state.combo = 0;
    state.multiplier = 1;
    state.pending = 0;
    state.chainSeconds = 0;
    state.active = false;
    state.rate = 0;
    state.linkWindow = 0;
    overTimer = 0; underTimer = 0; spinTimer = 0; linkTimer = 0;
  }

  function bank() {
    if (state.combo <= 0) return;
    const points = state.score * state.multiplier;
    state.banked += points;
    if (points > state.best) state.best = points;
    record('banked', points, state.combo, '');
    clearChain();
  }

  function lose(reason) {
    if (state.combo <= 0) return;
    record('lost', state.score * state.multiplier, state.combo, reason);
    clearChain();
  }

  /**
   * Points multiplier for the angle held.
   *
   * Superlinear, and deliberately so: the whole tension of drifting is that the
   * angle that pays is the angle that is about to bite. Paying linearly makes
   * 20 degrees the sensible play forever, because it is nearly as good as 50
   * and can be held with one hand. At exponent 1.6, 50 degrees is worth three
   * times 25 and sits a few degrees off a spin that costs the entire chain.
   *
   * Nothing is paid past the spin threshold. Not because the angle is not real
   * but because that region is worth zero to reach for: it ends the chain.
   */
  function anglePay(absAngle, spinAngle) {
    const deg = Math.min(absAngle, spinAngle) * RAD2DEG;
    return Math.pow(deg / REF_DEG, ANGLE_EXP);
  }

  /**
   * Cheap proximity bonus.
   *
   * One road query per FRAME (not per physics substep) plus one optional
   * callback, both reusing scratch objects. The road-edge term is the honest
   * one: `ground.roadAt` already returns the distance from the centreline and
   * the carriageway width, so the clearance to the white line costs a
   * subtraction. Hanging the outside wheels over the edge of the road is the
   * cheapest thrill in the game and it is free to measure.
   */
  function proximityBonus(car) {
    let bonus = 1;
    if (ground && ground.roadAt) {
      const r = ground.roadAt(car.x, car.z, roadScratch);
      if (r && r.onRoad && r.width > 0) {
        const clearance = Math.max(0, r.width * 0.5 - r.dist);
        bonus += EDGE_BONUS * smoothstep(EDGE_NEAR, EDGE_TOUCH, clearance);
      }
    }
    if (nearest) {
      const d = nearest(car.x, car.z);
      if (Number.isFinite(d) && d >= 0) {
        bonus += NEAR_BONUS * smoothstep(NEAR_FAR, NEAR_CLOSE, d);
      }
    }
    return bonus;
  }

  /**
   * One frame. Returns the live state object — the same object every time, so
   * a HUD can hold the reference and never ask for it again.
   */
  function update(dt, car) {
    if (disposed || !car || !(dt > 0)) return state;
    // A tab returning from the background hands back several seconds at once.
    // Unclamped, that single step banks a fortune from one frame of geometry
    // the player never drove.
    const d = dt > 0.1 ? 0.1 : dt;

    lastResult.age += d;
    if (state.flash > 0) state.flash = Math.max(0, state.flash - d / FLASH_TIME);

    const speed = Number.isFinite(car.speed) ? car.speed : Math.hypot(car.vx, car.vz);

    // Heading against velocity, in the car's own frame.
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
    const vLong = car.vx * fx + car.vz * fz;
    const vLat = car.vx * rx + car.vz * rz;
    // Below walking pace atan2 is amplifying float noise into a 40-degree
    // reading, which a HUD needle would show as a seizure at the lights.
    const angle = speed > ANGLE_FLOOR ? Math.atan2(vLat, vLong) : 0;
    const abs = Math.abs(angle);

    const surf = SURFACE[car.surface] || DEFAULT_SURFACE;
    const spinAngle = SPIN_ANGLE * surf.hold;

    state.angle = angle;
    state.angleDeg = angle * RAD2DEG;
    state.spinAngle = spinAngle;
    state.holdRatio = clamp(abs / spinAngle, 0, 2);

    // Airborne freezes everything. A jump taken mid-slide is part of the drift,
    // not the end of it, and with no tyre on the ground neither the angle nor
    // the yaw rate mean what they mean anywhere else in this file. The verdict
    // is simply deferred to the landing, where it belongs.
    if (car.airborne) {
      state.rate = 0;
      return state;
    }

    // ---- the two ways a chain dies before it is banked --------------------
    // Yaw-rate runaway alone is not a spin: a handbrake turn peaks well over
    // 2 rad/s on purpose. It only counts once the car is ALSO past 49 degrees,
    // which is the point at which that much rotation is no longer being
    // steered. Angle past the surface's own limit is a spin on its own.
    const spinning = abs > spinAngle ||
      (Math.abs(car.yawRate) > SPIN_YAW && abs > SPIN_YAW_ANGLE);
    spinTimer = spinning ? spinTimer + d : 0;
    if (state.combo > 0 && spinTimer >= SPIN_HOLD) {
      lose('spin');
      return state;
    }
    if (state.active && speed < FLOOR_SPEED) {
      // Bogging down mid-slide is a failed drift and costs the chain. Crossing
      // the same floor AFTER a clean exit is just a driver slowing down, and
      // that banks instead — see below. Punishing it would mean every chain
      // that ends at a junction is lost, which is not what the floor is for.
      lose('slow');
      return state;
    }

    // ---- enter / exit, with both margins ---------------------------------
    if (!state.active) {
      // You cannot ENTER a drift that is already most of the way to a spin.
      // That is a spin you happened to survive, not a drift you initiated, and
      // without this gate a car rotating through 150 degrees trips the entry
      // test on its way round and is paid for it.
      const startMax = spinAngle * 0.9;
      const wantIn = abs > ENTER_ANGLE && abs < startMax && speed > ENTER_SPEED && vLong > 0;
      overTimer = wantIn ? overTimer + d : 0;
      if (overTimer >= ENTER_HOLD) {
        state.active = true;
        state.combo += 1;              // links onto an open chain, or starts one
        state.multiplier = multiplierFor(state.combo);
        underTimer = 0;
        linkTimer = 0;
        state.linkWindow = 0;
      }
    } else {
      const wantOut = abs < EXIT_ANGLE || speed < FLOOR_SPEED;
      underTimer = wantOut ? underTimer + d : 0;
      if (underTimer >= EXIT_HOLD) {
        state.active = false;
        overTimer = 0;
        linkTimer = LINK_WINDOW;
      }
    }

    // ---- the chain clock -------------------------------------------------
    if (state.combo > 0) state.chainSeconds += d;

    if (!state.active && state.combo > 0) {
      if (speed < FLOOR_SPEED) {
        bank();
        return state;
      }
      linkTimer -= d;
      state.linkWindow = clamp(linkTimer / LINK_WINDOW, 0, 1);
      if (linkTimer <= 0) {
        bank();
        return state;
      }
    }

    // ---- score ------------------------------------------------------------
    if (state.active) {
      const speedTerm = clamp(speed / SPEED_REF, 0, SPEED_CAP);
      const prox = proximityBonus(car);
      state.proximity = prox;
      state.rate = base * anglePay(abs, spinAngle) * speedTerm * surf.pay * prox;
      state.score += state.rate * d;
      state.linkWindow = 1;
    } else {
      state.rate = 0;
      state.proximity = 1;
    }
    // The multiplier applies to the WHOLE chain, retroactively. Linking a third
    // drift is worth more than the third drift is, which is the entire reason
    // anyone links a third drift.
    state.pending = state.score * state.multiplier;

    return state;
  }

  /**
   * Called by main.js when the collision solver reports a hit. `severity`
   * matches what collision.resolve() returns; calling it bare loses the chain
   * unconditionally, which is what a caller with no severity to offer means.
   */
  function onCollision(severity = 1) {
    if (disposed) return;
    if (!(severity >= crashSeverity)) return;
    lose('crash');
  }

  /** Back to a fresh session: the chain, the bank and the best all go. */
  function reset() {
    clearChain();
    state.banked = 0;
    state.best = 0;
    state.angle = 0; state.angleDeg = 0; state.holdRatio = 0;
    state.spinAngle = SPIN_ANGLE;
    state.proximity = 1;
    state.flash = 0;
    lastResult.kind = 'none';
    lastResult.points = 0;
    lastResult.combo = 0;
    lastResult.reason = '';
    lastResult.age = 0;
  }

  /** Nothing to release — no DOM, no GL. It stops updating, and that is all. */
  function dispose() {
    disposed = true;
  }

  return { update, state, onCollision, reset, dispose };
}
