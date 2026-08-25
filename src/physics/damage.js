// Damage.
//
// This is the model every other damage system binds to: the renderer asks it
// which panels are dented and how far, the particle system asks it whether the
// engine is smoking or alight, the audio asks it what just broke, and the
// vehicle asks it how much of its power, grip and steering it still has.
//
// Two principles, both learned the hard way on the previous project.
//
// FIRST: damage may only ever take capability away. There is no path here that
// returns more power, more grip or more brake than the undamaged car. That is
// asserted by tools/damagecheck.mjs over thousands of random impacts, because a
// damage model that can accidentally *help* is a physics exploit, and players
// find those in minutes.
//
// SECOND: every consequence is continuous. A tyre does not switch from fine to
// blown; it loses pressure, the car starts pulling, and the pull grows. Binary
// damage states read as bugs — the car is fine, then on the next frame it is
// undriveable and nobody knows why. Only the *events* are discrete: the bang
// when a tyre finally lets go, the sheet of glass leaving the frame.

import { clamp, lerp, smoothstep } from '../world/noise.js';

/** Where an impact landed, in the car's own frame. */
export const ZONE = {
  FRONT: 'front', REAR: 'rear', LEFT: 'left', RIGHT: 'right',
  FL: 'fl', FR: 'fr', RL: 'rl', RR: 'rr', ROOF: 'roof',
};

/** Panels that can dent, in the order the renderer expects them. */
export const PANELS = [
  'bonnet', 'roof', 'boot', 'frontBumper', 'rearBumper',
  'wingFL', 'wingFR', 'wingRL', 'wingRR', 'doorL', 'doorR',
];

/** Parts that can detach and become debris. */
export const DETACHABLE = [
  'mirrorL', 'mirrorR', 'frontBumper', 'rearBumper', 'bonnet', 'boot',
  'doorL', 'doorR', 'exhaust', 'spoiler',
];

/** Glass that can craze and then go. */
export const GLASS = ['windscreen', 'rear', 'sideL', 'sideR'];

/** Lights that can be smashed. */
export const LIGHTS = ['headL', 'headR', 'tailL', 'tailR'];

const WHEELS = 4;

// How much of an impact each zone delivers to each mechanical system. A nose-on
// hit wrecks the radiator and does nothing to the exhaust; a rear-ender is the
// reverse. This table is the whole reason a crash feels specific rather than
// generic.
const ZONE_TO_SYSTEM = {
  front: { radiator: 1.00, engine: 0.55, steering: 0.30, gearbox: 0.15 },
  fl:    { radiator: 0.55, engine: 0.30, steering: 0.55, gearbox: 0.10 },
  fr:    { radiator: 0.55, engine: 0.30, steering: 0.55, gearbox: 0.10 },
  left:  { steering: 0.20, gearbox: 0.10, engine: 0.08 },
  right: { steering: 0.20, gearbox: 0.10, engine: 0.08 },
  rl:    { gearbox: 0.35, exhaust: 0.60, engine: 0.10 },
  rr:    { gearbox: 0.35, exhaust: 0.60, engine: 0.10 },
  rear:  { gearbox: 0.45, exhaust: 1.00, engine: 0.12 },
  roof:  { engine: 0.05 },
};

// Which suspension corner an impact zone loads.
const ZONE_TO_CORNER = {
  front: [0, 1], fl: [0], fr: [1], left: [0, 2], right: [1, 3],
  rl: [2], rr: [3], rear: [2, 3], roof: [],
};

export function createDamage(spec = {}) {
  const d = {
    // --- mechanical systems, 1 = perfect, 0 = destroyed -------------------
    engine: 1, radiator: 1, gearbox: 1, steering: 1, exhaust: 1,
    suspension: [1, 1, 1, 1],

    // --- tyres: pressure, not a boolean ----------------------------------
    tyre: [1, 1, 1, 1],
    blown: [false, false, false, false],

    // --- cosmetic --------------------------------------------------------
    panel: {},        // 0..1 dent depth per panel
    glass: {},        // 0 = clear, 0.5 = crazed, 1 = gone
    light: {},        // 0 = fine, 1 = smashed
    attached: {},     // false once a part has fallen off

    // --- thermal ---------------------------------------------------------
    coolant: 1,       // leaks away once the radiator is holed
    temp: 0.35,       // 0 = cold, 1 = boiling
    onFire: 0,        // 0..1, spreads once alight
    burntFor: 0,

    // --- readouts the rest of the game uses -------------------------------
    integrity: 1,
    events: [],       // discrete things that just happened, drained per frame
    totalImpacts: 0,
    worstImpact: 0,
  };

  for (const p of PANELS) d.panel[p] = 0;
  for (const g of GLASS) d.glass[g] = 0;
  for (const l of LIGHTS) d.light[l] = 0;
  for (const a of DETACHABLE) d.attached[a] = true;

  const toughness = spec.toughness ?? 1;      // trucks shrug off what a coupe does not
  const glassStrength = spec.glassStrength ?? 1;

  function emit(type, detail) {
    // Bounded: a car being ground along a wall generates events every frame and
    // nothing downstream should have to cope with an unbounded queue.
    if (d.events.length < 24) d.events.push(detail ? { type, ...detail } : { type });
  }

  /**
   * Which zone an impact in the car's local frame belongs to.
   * @param {number} lx  metres right of centre (+ = right)
   * @param {number} lz  metres forward of centre (+ = forward)
   */
  function zoneOf(lx, lz, halfW, halfL) {
    const fx = lx / Math.max(0.1, halfW);
    const fz = lz / Math.max(0.1, halfL);
    if (fz > 0.45) return Math.abs(fx) > 0.55 ? (fx > 0 ? ZONE.FR : ZONE.FL) : ZONE.FRONT;
    if (fz < -0.45) return Math.abs(fx) > 0.55 ? (fx > 0 ? ZONE.RR : ZONE.RL) : ZONE.REAR;
    return fx > 0 ? ZONE.RIGHT : ZONE.LEFT;
  }

  const PANELS_BY_ZONE = {
    front: ['frontBumper', 'bonnet'], fl: ['frontBumper', 'wingFL', 'bonnet'],
    fr: ['frontBumper', 'wingFR', 'bonnet'], left: ['doorL', 'wingFL', 'wingRL'],
    right: ['doorR', 'wingFR', 'wingRR'], rl: ['rearBumper', 'wingRL', 'boot'],
    rr: ['rearBumper', 'wingRR', 'boot'], rear: ['rearBumper', 'boot'],
    roof: ['roof'],
  };
  const GLASS_BY_ZONE = {
    front: ['windscreen'], fl: ['windscreen', 'sideL'], fr: ['windscreen', 'sideR'],
    left: ['sideL'], right: ['sideR'], rl: ['rear', 'sideL'], rr: ['rear', 'sideR'],
    rear: ['rear'], roof: ['windscreen', 'rear'],
  };
  const LIGHTS_BY_ZONE = {
    front: ['headL', 'headR'], fl: ['headL'], fr: ['headR'],
    rear: ['tailL', 'tailR'], rl: ['tailL'], rr: ['tailR'],
    left: [], right: [], roof: [],
  };
  const DETACH_BY_ZONE = {
    front: ['frontBumper', 'bonnet'], fl: ['frontBumper', 'mirrorL', 'bonnet'],
    fr: ['frontBumper', 'mirrorR', 'bonnet'], left: ['mirrorL', 'doorL'],
    right: ['mirrorR', 'doorR'], rl: ['rearBumper', 'exhaust'],
    rr: ['rearBumper', 'exhaust'], rear: ['rearBumper', 'boot', 'exhaust', 'spoiler'],
    roof: [],
  };

  /**
   * Record an impact.
   *
   * @param {number} severity 0..1, from the collision solver
   * @param {number} lx,lz    where it landed in the car's frame, metres
   * @param {number} halfW,halfL  the car's half-extents, metres
   * @param {number} closingSpeed m/s into the surface
   */
  function impact(severity, lx, lz, halfW, halfL, closingSpeed = 0) {
    if (!(severity > 0)) return null;
    const s = clamp(severity, 0, 1) / toughness;
    const zone = zoneOf(lx, lz, halfW, halfL);
    d.totalImpacts++;
    d.worstImpact = Math.max(d.worstImpact, s);

    // --- mechanical ---
    const sys = ZONE_TO_SYSTEM[zone] || {};
    for (const k of Object.keys(sys)) {
      const before = d[k];
      d[k] = clamp(d[k] - s * sys[k] * 0.9, 0, 1);
      if (before > 0.5 && d[k] <= 0.5) emit('system-failing', { system: k });
      if (before > 0 && d[k] <= 0) emit('system-dead', { system: k });
    }
    for (const c of ZONE_TO_CORNER[zone] || []) {
      d.suspension[c] = clamp(d.suspension[c] - s * 0.7, 0, 1);
    }

    // --- panels: dents accumulate but saturate, so a wall you are grinding
    //     along does not eventually fold the car into a point ---
    for (const p of PANELS_BY_ZONE[zone] || []) {
      d.panel[p] = clamp(d.panel[p] + s * (1 - d.panel[p] * 0.7), 0, 1);
    }

    // --- glass: crazes first, then goes. A windscreen that vanishes on a
    //     kerb strike looks like a bug; one that spiders and then blows out
    //     two hits later reads as glass ---
    if (s > 0.16) {
      for (const g of GLASS_BY_ZONE[zone] || []) {
        const before = d.glass[g];
        d.glass[g] = clamp(before + (s - 0.12) * 1.5 / glassStrength, 0, 1);
        if (before < 0.5 && d.glass[g] >= 0.5) emit('glass-crack', { glass: g });
        if (before < 1 && d.glass[g] >= 1) emit('glass-shatter', { glass: g });
      }
    }

    // --- lights ---
    if (s > 0.10) {
      for (const l of LIGHTS_BY_ZONE[zone] || []) {
        const before = d.light[l];
        d.light[l] = clamp(before + s * 1.8, 0, 1);
        if (before < 1 && d.light[l] >= 1) emit('light-smash', { light: l });
      }
    }

    // --- parts leaving the car ---
    // A mirror goes early and easily; a bonnet needs a real hit. The threshold
    // scales with how battered the panel behind it already is, so the tenth
    // scrape can take a bumper the first one only marked.
    for (const part of DETACH_BY_ZONE[zone] || []) {
      if (!d.attached[part]) continue;
      const base = part.startsWith('mirror') ? 0.24
        : part.endsWith('Bumper') ? 0.42
        : part === 'exhaust' ? 0.38
        : part === 'spoiler' ? 0.40
        : 0.62;                                   // bonnet, boot, doors
      const wear = zone in PANELS_BY_ZONE
        ? (d.panel[PANELS_BY_ZONE[zone][0]] || 0) * 0.30 : 0;
      // Wear lowers the bar but can never remove it. Without the floor, a
      // dented wing drove the mirror's threshold negative and forty gentle
      // scrapes stripped a car that should have been merely scuffed.
      if (s > Math.max(base * 0.55, base - wear)) {
        d.attached[part] = false;
        emit('detach', { part, zone, lx, lz, speed: closingSpeed });
      }
    }

    // --- tyres: a hard corner strike can burst one outright ---
    for (const c of ZONE_TO_CORNER[zone] || []) {
      if (s > 0.45 && !d.blown[c]) burstTyre(c, 'impact');
      else d.tyre[c] = clamp(d.tyre[c] - s * 0.35, 0, 1);
    }

    // --- fluids ---
    if (d.radiator < 0.75) emit('coolant-leak');

    recompute();
    return { zone, severity: s };
  }

  function burstTyre(i, cause) {
    if (d.blown[i]) return;
    d.blown[i] = true;
    d.tyre[i] = 0;
    emit('tyre-burst', { wheel: i, cause });
  }

  /**
   * Wear from the surface itself, rather than from hitting anything: kerbs and
   * sharp gravel chew tyres, and a car driven flat out on rims will eventually
   * lose the wheel. Called every physics step.
   */
  function abrade(dt, wheelSurfaces, speed, slip) {
    if (speed < 1) return;
    for (let i = 0; i < WHEELS; i++) {
      if (d.blown[i]) continue;
      const surf = wheelSurfaces[i];
      const sharp = surf === 'gravel' ? 0.9 : surf === 'rock' ? 1.4 : surf === 'dirt' ? 0.35 : 0.05;
      // Sliding is what actually destroys a tyre, not rolling.
      const wear = sharp * (0.6 + slip * 3.2) * (speed / 40) * dt * 0.0045;
      d.tyre[i] = clamp(d.tyre[i] - wear, 0, 1);
      if (d.tyre[i] <= 0) burstTyre(i, 'wear');
    }
  }

  /**
   * Thermal and fire. Damage to the radiator loses coolant; without coolant the
   * engine cooks under load; a cooked engine smokes and can catch. Once alight
   * the fire grows on its own and takes the engine with it.
   */
  function step(dt, load, speed) {
    if (d.radiator < 1) {
      d.coolant = clamp(d.coolant - (1 - d.radiator) * 0.055 * dt, 0, 1);
    }
    // THERMAL. The governing rule: an undamaged car can never overheat.
    //
    // Cooling used to scale with airflow, so at a standstill it was tiny while
    // heating was full — and a perfectly healthy car held on the handbrake at
    // full throttle caught fire in 4.2 seconds, with power collapsing to 2%
    // first. That is what "the engine is burning on startup" and "acceleration
    // is so slow" both were: one bug wearing two hats.
    //
    // So the fan alone out-cools the maximum the engine can put in. Ram air on
    // top of it is a bonus, not the mechanism. Overheating is now strictly a
    // CONSEQUENCE of losing coolant, which is the only thing that can take the
    // cooling capacity below what the engine produces.
    const heatIn = 0.10 + load * 0.30;                 // max 0.40 at full load
    const fan = 0.62;                                  // alone, already beats it
    const ram = Math.min(speed, 60) * 0.016;
    const heatOut = (fan + ram) * (0.10 + 0.90 * d.coolant) * (0.35 + 0.65 * d.temp);
    d.temp = clamp(d.temp + (heatIn - heatOut) * dt * 0.6, 0.18, 1.4);

    if (d.temp > 0.86 && d.onFire <= 0) {
      // Cooking, not yet alight: this is the smoke stage.
      d.engine = clamp(d.engine - (d.temp - 0.86) * 0.09 * dt, 0, 1);
    }
    const ignitable = d.temp > 1.0 || (d.engine < 0.15 && d.temp > 0.8);
    if (ignitable && d.onFire <= 0) {
      d.onFire = 0.05;
      emit('fire-start');
    }
    if (d.onFire > 0) {
      d.burntFor += dt;
      // Airflow fights the fire, and for a SMALL one it can win — driving it
      // out is meant to be a real option, so the suppression term has to
      // actually exceed the growth term rather than merely slow it. Once the
      // fire is established, speed barely helps.
      const airflow = clamp((speed - 14) / 45, 0, 1);
      const suppress = airflow * (d.onFire < 0.55 ? 1 : 0.22);
      const before = d.onFire;
      d.onFire = clamp(d.onFire + (0.055 - suppress * 0.160) * dt, 0, 1);
      d.engine = clamp(d.engine - d.onFire * 0.10 * dt, 0, 1);
      d.temp = clamp(d.temp + dt * 0.05 * (1 - suppress * 0.6), 0, 1.4);
      if (before > 0 && d.onFire <= 0) emit('fire-out');
    }
    recompute();
  }

  // ---- what the rest of the game reads ------------------------------------

  const out = {
    powerScale: 1, brakeScale: 1, steerPull: 0, dragAdd: 0,
    gripScale: [1, 1, 1, 1], rideDrop: [0, 0, 0, 0],
    smoke: 0, fire: 0, sparks: 0, wobble: 0, dead: false,
  };

  function recompute() {
    // Engine: a dying engine loses power; a burning one loses it fast.
    out.powerScale = clamp(
      (0.18 + 0.82 * d.engine) * (1 - d.onFire * 0.75) * (d.temp > 1.05 ? 0.45 : 1), 0, 1);

    // Brakes survive most things but a wrecked corner takes its own brake with it.
    let brake = 1;
    for (let i = 0; i < WHEELS; i++) brake -= (1 - d.suspension[i]) * 0.11;
    out.brakeScale = clamp(brake, 0.35, 1);

    // Tyres and suspension both cost grip, per corner.
    for (let i = 0; i < WHEELS; i++) {
      const t = d.blown[i] ? 0.34 : lerp(0.62, 1, d.tyre[i]);
      out.gripScale[i] = clamp(t * lerp(0.70, 1, d.suspension[i]), 0.2, 1);
      out.rideDrop[i] = (1 - d.suspension[i]) * 0.06 + (d.blown[i] ? 0.11 : 0);
    }

    // A blown tyre drags and pulls toward its own side. Front blowouts pull far
    // harder than rear ones, which is what makes them frightening rather than
    // merely slow.
    let pull = 0, drag = 0;
    if (d.blown[0]) { pull -= 0.9; drag += 0.10; }
    if (d.blown[1]) { pull += 0.9; drag += 0.10; }
    if (d.blown[2]) { pull -= 0.3; drag += 0.07; }
    if (d.blown[3]) { pull += 0.3; drag += 0.07; }
    // Bent steering pulls on its own, and never straightens out.
    pull += (1 - d.steering) * (spec.steerBiasSeed ?? 0.5 > 0.5 ? 0.55 : -0.55);
    out.steerPull = clamp(pull, -1.4, 1.4);
    out.dragAdd = drag;

    out.smoke = clamp(
      Math.max((d.temp - 0.72) * 2.4, (1 - d.engine) * 0.55, d.onFire * 1.4), 0, 1);
    out.fire = d.onFire;
    out.sparks = clamp(
      (d.blown[0] || d.blown[1] || d.blown[2] || d.blown[3]) ? 0.5 : 0, 0, 1);
    out.wobble = clamp((1 - d.steering) * 0.6 + (1 - Math.min(...d.suspension)) * 0.4, 0, 1);

    // Overall condition, for the HUD and for scoring.
    const mech = (d.engine * 2 + d.radiator + d.gearbox + d.steering * 1.5) / 5.5;
    const corners = (d.suspension[0] + d.suspension[1] + d.suspension[2] + d.suspension[3]) / 4;
    const rubber = (d.tyre[0] + d.tyre[1] + d.tyre[2] + d.tyre[3]) / 4;
    let body = 0;
    for (const p of PANELS) body += d.panel[p];
    body = 1 - body / PANELS.length;
    d.integrity = clamp(mech * 0.45 + corners * 0.2 + rubber * 0.2 + body * 0.15, 0, 1);

    // "Dead" means undriveable, not destroyed — the player still steers a
    // coasting wreck to the side of the road, which is far better than a
    // cut to a menu.
    out.dead = d.engine <= 0.02 && d.onFire > 0.75;
  }

  function drainEvents(into) {
    const list = into || [];
    list.length = 0;
    for (let i = 0; i < d.events.length; i++) list.push(d.events[i]);
    d.events.length = 0;
    return list;
  }

  function reset() {
    d.engine = d.radiator = d.gearbox = d.steering = d.exhaust = 1;
    for (let i = 0; i < WHEELS; i++) { d.suspension[i] = 1; d.tyre[i] = 1; d.blown[i] = false; }
    for (const p of PANELS) d.panel[p] = 0;
    for (const g of GLASS) d.glass[g] = 0;
    for (const l of LIGHTS) d.light[l] = 0;
    for (const a of DETACHABLE) d.attached[a] = true;
    d.coolant = 1; d.temp = 0.35; d.onFire = 0; d.burntFor = 0;
    d.totalImpacts = 0; d.worstImpact = 0;
    d.events.length = 0;
    recompute();
  }

  recompute();

  return {
    state: d, effects: out,
    impact, abrade, step, burstTyre, drainEvents, reset, recompute,
    get integrity() { return d.integrity; },
  };
}
