/**
 * What happens after the fireball.
 *
 * A crash that ends the run should have an aftermath, not a puff of sparks and
 * a car that drives away. The sequence, and roughly what it costs in seconds:
 *
 *   blast    0.0-0.6   panels tear off and land as real debris
 *   burning  0.6-28    sustained flame, rising plume, paint cooking to black
 *   responding         an engine is dispatched and drives to you on real roads
 *   dousing            water arcs onto the fire, flame drops, steam replaces it
 *   charred            a black husk sitting in a wet patch, smoking gently
 *
 * Almost none of this is new machinery. damage.js already models onFire and
 * burntFor, carDamage.js already cooks paint toward black from those, and
 * debris.js already throws panels. This module is the director: it decides what
 * happens when, and adds the one thing genuinely missing — someone turning up
 * to put it out.
 */

import * as THREE from 'three';

const BURN_MIN = 9;             // never douse before the fire has been a fire
const BURN_MAX = 26;            // and never let it outstay its welcome
const RESPOND_SPEED = 22;       // m/s the engine travels while off-screen
const DOUSE_TIME = 7.5;
const PARK_DIST = 9.5;          // how close the engine stops

// The panels that leave the car, in the order they go. Roof and doors first
// because they are the silhouette — losing them is what makes the shape read
// as wrecked from a distance.
const SHED = ['bonnet', 'doorL', 'doorR', 'boot', 'bumperF', 'bumperR', 'spoiler'];

export function createWreck(opts = {}) {
  const scene = opts.scene;
  const ground = opts.ground;
  const particles = opts.particles;
  const debris = opts.debris || null;
  const makeCar = opts.createCarModel || null;
  const onToast = opts.onToast || (() => {});

  let phase = 'idle';           // idle|blast|burning|responding|dousing|charred
  let t = 0;                    // seconds in the current phase
  let shed = 0;                 // how many panels have gone
  let wx = 0, wy = 0, wz = 0;   // where the wreck is
  let burnFor = 0;
  let truck = null;             // {group, x, z, yaw, route, at}
  let truckT = 0;
  let doused = 0;               // 0..1

  // Sparks and smoke alone read as "something is smouldering". A fire needs a
  // body of light. These are the same trick explosion.js uses: additive meshes
  // with HDR colours above the bloom threshold, so they genuinely glow rather
  // than tone-mapping down to flat orange. Three of them at different sizes and
  // flicker rates, because one pulsing blob reads as a lamp, not a fire.
  const flameGeo = new THREE.IcosahedronGeometry(1, 1);
  const flameMats = [];
  const flameMesh = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.MeshBasicMaterial({
      color: 0xff7a1e, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const mesh = new THREE.Mesh(flameGeo, m);
    mesh.visible = false;
    mesh.frustumCulled = false;
    flameMats.push(m);
    flameMesh.push(mesh);
    if (scene) scene.add(mesh);
  }
  const fireLight = new THREE.PointLight(0xff8828, 0, 46, 2);
  fireLight.visible = false;
  if (scene) scene.add(fireLight);
  let flick = 0;

  /** Drives the flame body. `k` is 0..1 — dousing takes it to nothing. */
  function flameBody(dt, k) {
    flick += dt;
    const on = k > 0.02;
    fireLight.visible = on;
    if (!on) { for (const m of flameMesh) m.visible = false; return; }
    for (let i = 0; i < flameMesh.length; i++) {
      const mesh = flameMesh[i];
      mesh.visible = true;
      // Each blob has its own rate and phase, so they never pulse in unison.
      const f = 0.62 + 0.38 * Math.sin(flick * (7.5 + i * 3.1) + i * 2.2);
      const g = 0.75 + 0.25 * Math.sin(flick * (13.0 + i * 4.7) + i);
      const r = (0.75 + i * 0.42) * k * f;
      mesh.scale.set(r, r * (1.5 + 0.35 * g), r);
      mesh.position.set(wx + rnd(0.35), wy + 0.7 + i * 0.62 * k, wz + rnd(0.35));
      const I = k * f * (1 - i * 0.22);
      flameMats[i].opacity = Math.min(1, I * 1.1);
      // White-hot at the base, deep orange at the top — the colour ramp is what
      // makes it read as burning rather than as a glowing balloon.
      flameMats[i].color.setRGB(3.6 * I, (1.35 - i * 0.3) * I * I, 0.22 * I * I);
    }
    fireLight.position.set(wx, wy + 1.5, wz);
    fireLight.intensity = (24 + 26 * Math.sin(flick * 9.3)) * k;
  }

  function ignite(car, carDamage, power) {
    if (phase !== 'idle' && phase !== 'charred') return false;
    phase = 'blast';
    t = 0; shed = 0; burnFor = 0; doused = 0;
    wx = car.x; wy = car.y; wz = car.z;
    // The fire is set here rather than waiting for damage.js to cook up to it,
    // because a blast that leaves the car not-burning reads as a near miss.
    if (car.damage) {
      car.damage.state.onFire = Math.max(car.damage.state.onFire, 0.55 + 0.4 * power);
      car.damage.state.temp = 1;
    }
    onToast('Wrecked', 2.2);
    return true;
  }

  /** Tear one more panel off and throw it. Spread over the first half second
   *  so the car comes apart rather than all popping in a single frame. */
  function shedPanel(car, carDamage) {
    if (shed >= SHED.length) return;
    const part = SHED[shed++];
    if (car.damage && car.damage.state.attached) {
      if (car.damage.state.attached[part] === false) return;
      car.damage.state.attached[part] = false;
    }
    const ev = [{ type: 'detach', part, zone: 'front', lx: 0, lz: 0, speed: 12 }];
    if (carDamage && carDamage.applyEvents) carDamage.applyEvents(ev);
    if (debris && debris.spawnPart && opts.carGroup) {
      // Thrown outward from the blast rather than inheriting the car's motion:
      // the car is stopped, so the only energy available is the explosion's.
      const a = Math.random() * Math.PI * 2;
      debris.spawnPart(part, opts.carGroup(), {
        x: Math.cos(a) * (5 + Math.random() * 7),
        y: 4 + Math.random() * 5,
        z: Math.sin(a) * (5 + Math.random() * 7),
      });
    }
  }

  function dispatch() {
    if (truck || !makeCar) return;
    // An engine is a big red van. Spawned back down the road so it arrives
    // rather than appearing, which is the whole point of the delay.
    let sx = wx + 140, sz = wz + 140;
    const near = ground && ground.nearestRoad ? ground.nearestRoad(wx, wz, 900) : null;
    if (near) { sx = near.x + 150; sz = near.z + 150; }
    let g = null;
    try {
      g = makeCar({ body: 'van', colour: 0xc8102e, wheelbase: 3.1, track: 1.8 });
    } catch (err) { console.error('[open road] fire engine model failed:', err); return; }
    scene.add(g.group);
    truck = { m: g, x: sx, z: sz, yaw: 0, arrived: false, flash: 0 };
    truckT = 0;
    onToast('Fire crew dispatched', 2.4);
  }

  function moveTruck(dt) {
    if (!truck) return;
    const dx = wx - truck.x, dz = wz - truck.z;
    const d = Math.hypot(dx, dz);
    truck.yaw = Math.atan2(-dx, -dz);
    if (d > PARK_DIST) {
      const step = Math.min(RESPOND_SPEED * dt, d - PARK_DIST);
      truck.x += (dx / d) * step;
      truck.z += (dz / d) * step;
    } else if (!truck.arrived) {
      truck.arrived = true;
      onToast('Putting it out', 2.2);
    }
    const gy = ground && ground.heightAt ? ground.heightAt(truck.x, truck.z) : wy;
    truck.m.group.position.set(truck.x, gy + 0.32, truck.z);
    truck.m.group.rotation.set(0, truck.yaw, 0);
    // Beacons. Two lamps alternating is more legible at distance than one.
    truck.flash += dt;
    const on = (truck.flash % 0.7) < 0.35;
    if (truck.m.setIndicator) truck.m.setIndicator(on ? 1 : -1);
    if (truck.m.setHeadlights) truck.m.setHeadlights(true);
  }

  function update(dt, car, carDamage) {
    if (phase === 'idle') return;
    t += dt;
    const st = car && car.damage ? car.damage.state : null;

    if (phase === 'blast') {
      // Roughly one panel every 70 ms.
      while (shed < SHED.length && t > shed * 0.07) shedPanel(car, carDamage);
      if (t > 0.6) { phase = 'burning'; t = 0; }
      return;
    }

    if (phase === 'burning') {
      burnFor += dt;
      // Hold the fire up. damage.js suppresses fire with airflow, and a
      // stationary wreck has none, but the player may still be rolling.
      if (st) {
        st.onFire = Math.min(1, Math.max(st.onFire, 0.5 + burnFor * 0.02));
        st.temp = 1;
      }
      flames(dt, 1);
      flameBody(dt, 1);
      if (burnFor > BURN_MIN) dispatch();
      if (truck) moveTruck(dt);
      if (truck && truck.arrived) { phase = 'dousing'; t = 0; }
      else if (burnFor > BURN_MAX) { phase = 'dousing'; t = 0; }
      return;
    }

    if (phase === 'dousing') {
      if (truck) moveTruck(dt);
      doused = Math.min(1, t / DOUSE_TIME);
      // The flame recedes as the water lands, and steam takes its place.
      flames(dt, 1 - doused);
      flameBody(dt, 1 - doused);
      water(dt);
      if (st) st.onFire = Math.max(0, (0.5 + burnFor * 0.02) * (1 - doused));
      if (doused >= 1) {
        phase = 'charred'; t = 0;
        if (st) { st.onFire = 0; st.temp = 0.35; }
        onToast('Out. What is left of it.', 3);
      }
      return;
    }

    if (phase === 'charred') {
      flameBody(dt, 0);
      // A wreck does not stop smoking the moment the fire is out.
      if (Math.random() < dt * 7) particles.emitSmoke(wx + rnd(0.8), wy + 0.9 + Math.random(), wz + rnd(0.8), 2);
      if (truck) {
        // The crew leaves after a while.
        truckT += dt;
        if (truckT > 14) { removeTruck(); }
        else moveTruck(dt);
      }
    }
  }

  const rnd = (k) => (Math.random() * 2 - 1) * k;

  /** Flame and plume. Scaled by `k` so dousing visibly wins. */
  function flames(dt, k) {
    if (k <= 0.02) return;
    const n = dt * 60;
    if (Math.random() < n * 0.9 * k) {
      particles.emitSparks(wx + rnd(0.7), wy + 0.6 + Math.random() * 0.8, wz + rnd(0.7),
        4 + 6 * k, 0, 0);
    }
    // The plume: hotter and tighter low, wider and slower as it climbs.
    if (Math.random() < n * 0.7 * k) particles.emitSmoke(wx + rnd(0.6), wy + 1.2, wz + rnd(0.6), 3);
    if (Math.random() < n * 0.5 * k) particles.emitSmoke(wx + rnd(1.1), wy + 2.9, wz + rnd(1.1), 3);
    if (Math.random() < n * 0.35 * k) particles.emitSmoke(wx + rnd(1.8), wy + 5.0, wz + rnd(1.8), 2);
  }

  /** The jet, thrown in an arc from the engine to the fire. */
  function water(dt) {
    if (!truck || !particles.emitDust) return;
    const n = dt * 60;
    for (let i = 0; i < n * 2; i++) {
      const f = Math.random();
      const x = truck.x + (wx - truck.x) * f;
      const z = truck.z + (wz - truck.z) * f;
      // Parabolic: peaks in the middle of the throw.
      const y = wy + 2.2 + Math.sin(f * Math.PI) * 3.4;
      particles.emitDust(x + rnd(0.5), y, z + rnd(0.5), 1, 0xdfeaf2);
    }
    if (Math.random() < n * 0.6) {
      particles.emitSmoke(wx + rnd(1.2), wy + 0.8, wz + rnd(1.2), 2);   // steam
    }
  }

  function removeTruck() {
    if (!truck) return;
    scene.remove(truck.m.group);
    if (truck.m.dispose) truck.m.dispose();
    truck = null;
  }

  function reset() {
    phase = 'idle'; t = 0; shed = 0; burnFor = 0; doused = 0;
    for (const m of flameMesh) m.visible = false;
    fireLight.visible = false;
    fireLight.intensity = 0;
    removeTruck();
  }

  return {
    ignite, update, reset,
    get phase() { return phase; },
    get burning() { return phase === 'burning' || phase === 'dousing'; },
    get truckPos() { return truck ? { x: truck.x, z: truck.z } : null; },
    dispose() {
      reset();
      for (const m of flameMesh) if (scene) scene.remove(m);
      if (scene) scene.remove(fireLight);
      flameGeo.dispose();
      for (const m of flameMats) m.dispose();
    },
  };
}
