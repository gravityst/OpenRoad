// Jump ramps.
//
// WHY RAMPS AND NOT CRESTS. The obvious place for a jump is a crest, and the
// map has 83 of them sharper than a 220 m vertical radius. Every one was driven
// by the real vehicle model with an autopilot that stays within a metre of the
// centreline, at 100, 120 and 140 km/h, from a 450 m run-up: total airtime
// across all of them, 0.00 s. The road grader in layout.js caps grade and
// smooths the profile on purpose, and it does its job — a car on this network
// never leaves the ground. (An earlier test that "found" 1.8 s flights had let
// the car wander off into the fields; that was the fields.)
//
// So a jump is built: a kicker ramp standing on the road.
//
// HOW IT LAUNCHES. The ramp is put into the ground query itself, so the wheels
// drive up the face like any other surface and the car pitches with it. What
// the face cannot do on its own is throw the car: vehicle.js clamps a grounded
// chassis to within 0.30 m of the road, which caps the vertical speed its
// springs can build at about 1.5 m/s (measured: glued to the deck at every
// speed to 100 km/h). So at the lip, kickRamps() hands the car the vertical
// speed the face would have given it — v * sin(lip angle), less 15% — and
// from there the flight, the landing and the springs are the vehicle's own.
// The real car then flies 9.6 m at 40 km/h, 27 m at 80 and 38 m at 100.
//
// The profile is concave — a quadratic from flat at the toe to 16 degrees at
// the lip — because a ramp that starts at its full angle is a kerb, and the
// suspension clamp turns a kerb at 100 km/h into a bump, not a launch. Behind
// the lip is a short back slope rather than a wall, so a car that arrives the
// wrong way climbs over it instead of hitting a 1.4 m step.
//
// ONLY THE PLAYER'S WHEELS SEE IT. The overlay is switched on for the length
// of car.step() and off again (see createRampOverlay), so the terrain and road
// meshes, the traffic and the camera all see the ground exactly as before.
// A ramp is 3.4 m wide on the crown of the road, so a traffic car in its lane
// (centred 2.4 m out on a 9.5 m road) passes beside it.

export const RAMP = {
  length: 11,       // toe to lip, metres
  height: 1.45,     // lip above the road
  back: 3.2,        // back slope, lip to ground
  width: 3.4,
};

/**
 * Ramp geometry for a site: toe position, direction of travel, and the base
 * height of the road under it. `def` needs x, z (the TOE), tx, tz.
 */
export function makeRamp(def) {
  const tl = Math.hypot(def.tx, def.tz) || 1;
  const tx = def.tx / tl, tz = def.tz / tl;
  const L = def.length || RAMP.length, H = def.height || RAMP.height;
  const B = def.back || RAMP.back, W = def.width || RAMP.width;
  const r = {
    x: def.x, z: def.z, tx, tz, nx: -tz, nz: tx,
    L, H, B, W, halfW: W * 0.5,
    // Lip in world space, for the jump detector.
    lipX: def.x + tx * L, lipZ: def.z + tz * L,
    // Bounding circle, for the early out.
    cx: def.x + tx * (L + B) * 0.5, cz: def.z + tz * (L + B) * 0.5,
    rad: Math.hypot((L + B) * 0.5, W * 0.5) + 0.5,
    lipSlope: (2 * H) / L,
  };
  return r;
}

/** Height of the ramp above the road at local (u along, v across). */
export function rampProfile(r, u, v) {
  if (v < -r.halfW || v > r.halfW) return 0;
  if (u <= 0) return 0;
  if (u <= r.L) { const t = u / r.L; return r.H * t * t; }
  if (u <= r.L + r.B) return r.H * (1 - (u - r.L) / r.B);
  return 0;
}

/** d(height)/du — the slope along the ramp. */
function rampSlope(r, u, v) {
  if (v < -r.halfW || v > r.halfW || u <= 0) return 0;
  if (u <= r.L) return (2 * r.H * u) / (r.L * r.L);
  if (u <= r.L + r.B) return -r.H / r.B;
  return 0;
}

/**
 * The ramps as ground, switched on only while the player's car is stepping.
 *
 * WHY NOT ALWAYS ON. The ground object is shared. terrain.js builds every
 * streamed chunk from ground.sample(), and roads.js builds its ribbon from
 * ground.heightAt(). Wrapped permanently, any chunk streamed in after boot
 * would grow a grass-and-asphalt hump under each ramp, poking through the
 * ramp's own mesh. So main.js brackets car.step() with enable() and
 * disable() (goals.preStep and goals.step), and for the rest of the frame the
 * ground is exactly what it always was. Outside that window nothing anywhere
 * can see a ramp except the ramp's mesh; inside it, only the wheels ask.
 *
 * Inside the window, off the footprints, the wrapped query returns exactly
 * what the original did, bit for bit — tools/goalscheck.mjs checks both.
 */
export function createRampOverlay(ground, ramps) {
  const list = ramps || [];
  const origSample = ground.sample;
  const origHeight = ground.heightAt;
  let on = false;

  // Index of the ramp containing (x, z), or -1. Six ramps, bounding circles
  // first: four wheels at 120 Hz is under 3000 of these a second.
  function find(x, z) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const dx = x - r.cx, dz = z - r.cz;
      if (dx * dx + dz * dz > r.rad * r.rad) continue;
      const ox = x - r.x, oz = z - r.z;
      const u = ox * r.tx + oz * r.tz;
      const v = ox * r.nx + oz * r.nz;
      if (u > 0 && u < r.L + r.B && v > -r.halfW && v < r.halfW) return i;
    }
    return -1;
  }

  /** Ramp height above the road at (x, z); 0 off every ramp. */
  function delta(x, z) {
    const i = find(x, z);
    if (i < 0) return 0;
    const r = list[i];
    const ox = x - r.x, oz = z - r.z;
    return rampProfile(r, ox * r.tx + oz * r.tz, ox * r.nx + oz * r.nz);
  }

  function sample(x, z, out) {
    const res = origSample.call(ground, x, z, out);
    const i = find(x, z);
    if (i < 0) return res;
    const r = list[i];
    const ox = x - r.x, oz = z - r.z;
    const u = ox * r.tx + oz * r.tz, v = ox * r.nx + oz * r.nz;
    res.y += rampProfile(r, u, v);
    // Tilt the normal by the ramp's slope, so the car pitches up the face.
    const s = rampSlope(r, u, v);
    if (s !== 0) {
      const ny = Math.max(1e-3, res.ny);
      const gx = -res.nx / ny + s * r.tx;
      const gz = -res.nz / ny + s * r.tz;
      const inv = 1 / Math.hypot(gx, 1, gz);
      res.nx = -gx * inv; res.ny = inv; res.nz = -gz * inv;
    }
    // A ramp deck is timber and steel with a grip coat: road grip, not grass.
    res.surface = 'asphalt'; res.grip = 1.0; res.roughness = 0.05; res.rolling = 0.015; res.dust = 0;
    return res;
  }

  function heightAt(x, z) { return origHeight.call(ground, x, z) + delta(x, z); }

  return {
    enable() {
      if (on || !list.length) return;
      ground.sample = sample;
      ground.heightAt = heightAt;
      on = true;
    },
    disable() {
      if (!on) return;
      if (ground.sample === sample) ground.sample = origSample;
      if (ground.heightAt === heightAt) ground.heightAt = origHeight;
      on = false;
    },
    /** Road height with the ramps included, for anything drawn on top of them. */
    heightAt,
    delta,
    get on() { return on; },
  };
}

/**
 * The lip. Call once per PHYSICS STEP, after car.step().
 *
 * Why this exists at all: vehicle.js holds a grounded chassis within +0.30 m
 * of the road on every step (a deliberate stability clamp — see "Hard clamp"
 * in its suspension block), which caps the vertical speed the spring can build
 * at about 1.5 m/s and means the car only goes airborne if the road drops more
 * than 0.12 m inside one 1/120 s step. Driven over the ramp with nothing else,
 * the real car stayed glued to it at every speed up to 100 km/h and at 120 km/h
 * merely rolled off the lip at deck height. A real ramp face turns forward
 * speed into vertical speed; the clamp throws that away. So at the moment the
 * car crosses the lip, this hands the vertical velocity back — v times the
 * sine of the lip angle, less 15% for what the tyres and springs soak up —
 * and from there the flight, landing and suspension are the vehicle's own.
 *
 * It only ever RAISES car.vy, so if the vehicle model one day carries that
 * speed itself, this quietly becomes a no-op instead of a double launch.
 *
 * `state` is a small per-car scratch object ({ onFace: -1 }).
 */
export function kickRamps(car, ramps, state) {
  if (!ramps || !ramps.length || !car) return -1;
  if (car.airborne) { state.onFace = -1; return -1; }
  let hit = -1;
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    const dx = car.x - r.cx, dz = car.z - r.cz;
    if (dx * dx + dz * dz > (r.rad + 4) * (r.rad + 4)) continue;
    const ox = car.x - r.x, oz = car.z - r.z;
    const u = ox * r.tx + oz * r.tz, v = ox * r.nx + oz * r.nz;
    if (v < -r.halfW - 0.3 || v > r.halfW + 0.3) { if (state.onFace === i) state.onFace = -1; continue; }
    if (u > 0.5 && u < r.L) { state.onFace = i; continue; }
    if (state.onFace === i && u >= r.L) {
      state.onFace = -1;
      const along = car.vx * r.tx + car.vz * r.tz;
      if (along < 6) continue;              // walking pace rolls over the top
      const ang = Math.atan(r.lipSlope);
      const vy = along * Math.sin(ang) * LAUNCH;
      car.airborne = true;
      car.airTime = 0;
      car.vy = Math.max(car.vy || 0, vy);
      // Lift the chassis back to deck height if a substep already carried it
      // a few centimetres down the back slope. r.lipY is the road under the
      // lip plus the ramp, set when the ramp was sited.
      if (r.lipY != null) {
        const want = r.lipY + (car.spec ? car.spec.rideHeight : 0.3);
        if (car.y < want) car.y = want;
      }
      hit = i;
    }
  }
  return hit;
}

/** Fraction of the face's vertical speed that survives the lip. */
export const LAUNCH = 0.85;

/**
 * Airtime and distance for a launch at `v` m/s off a ramp, for setting medal
 * targets. `launch` is the fraction of the lip's vertical speed the chassis
 * actually carries off it — the suspension spring lags the face a little —
 * and is calibrated against the real vehicle in tools/goalscheck.mjs.
 */
export function rampFlight(v, r = RAMP, launch = 0.8, landingDrop = 0) {
  const lip = (2 * r.height) / r.length;
  const ang = Math.atan(lip);
  const vx = v * Math.cos(ang), vy0 = v * Math.sin(ang) * launch;
  // Rise then fall back to road level (lip height + any drop beyond it).
  const h = r.height + landingDrop;
  const t = (vy0 + Math.sqrt(vy0 * vy0 + 2 * 9.81 * h)) / 9.81;
  return { air: t, dist: vx * t };
}
