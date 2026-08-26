/**
 * Fireballs.
 *
 * The old explode() was ninety sparks, some smoke and a toast — which reads as
 * "you scraped something", not as a detonation. A crash that ends your run
 * should be the loudest thing on screen. What was missing is everything that
 * makes an explosion legible: a bright core that blows out the exposure, a
 * light that throws itself onto the road and the cars around it, a shockwave,
 * and a plume that hangs around afterwards as evidence.
 *
 * THE BLOOM THRESHOLD IS THE WHOLE TRICK. effects.js runs UnrealBloom with a
 * threshold of 2.10-2.40 in LINEAR light, then ACES tone mapping. A colour
 * clamped to 1.0 can never cross that, so it tone-maps down to a dull orange
 * and looks like painted cardboard. These materials are given HDR colours well
 * above 1 so the core genuinely blows out and blooms, exactly as a real
 * over-exposed highlight does. Everything else here is timing.
 */

import * as THREE from 'three';

const POOL = 6;                 // concurrent blasts; past this the oldest is reused
const LIFE = 1.35;              // seconds for the whole event
const FLASH = 0.13;             // the light is almost instantaneous

export function createExplosions(scene, opts = {}) {
  const quality = opts.quality || 'medium';
  const wantLight = quality !== 'low';

  const group = new THREE.Group();
  group.name = 'explosions';
  scene.add(group);

  // One shared geometry per shape. A blast allocates nothing.
  const ballGeo = new THREE.IcosahedronGeometry(1, quality === 'high' ? 3 : 2);
  const ringGeo = new THREE.RingGeometry(0.55, 1, 40);

  const shots = [];
  for (let i = 0; i < POOL; i++) {
    // additive + depthWrite:false so overlapping layers accumulate into a hot
    // core instead of z-fighting into flat plates.
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const core = new THREE.Mesh(ballGeo, coreMat);
    const shellMat = new THREE.MeshBasicMaterial({
      color: 0xff7a1e, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const shell = new THREE.Mesh(ballGeo, shellMat);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;

    const light = wantLight ? new THREE.PointLight(0xffb060, 0, 90, 2) : null;

    const s = { core, shell, ring, light, coreMat, shellMat, ringMat, t: -1, power: 1, x: 0, y: 0, z: 0 };
    core.visible = shell.visible = ring.visible = false;
    group.add(core, shell, ring);
    if (light) { light.visible = false; group.add(light); }
    shots.push(s);
  }

  let next = 0;
  let shake = 0;

  /** power 0..1. Returns the camera-shake impulse the caller should apply. */
  function fire(x, y, z, power) {
    const p = Math.max(0.15, Math.min(1, power));
    const s = shots[next];
    next = (next + 1) % POOL;
    s.t = 0; s.power = p; s.x = x; s.y = y; s.z = z;
    s.core.position.set(x, y, z);
    s.shell.position.set(x, y, z);
    // Lifted a touch so the ring does not z-fight with the road surface.
    s.ring.position.set(x, y - 0.35, z);
    if (s.light) { s.light.position.set(x, y + 0.6, z); s.light.visible = true; }
    s.core.visible = s.shell.visible = s.ring.visible = true;
    // Random orientation, so two blasts in the same place never look stamped
    // from the same die.
    s.shell.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    s.core.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    shake = Math.max(shake, p);
    return p;
  }

  function update(dt) {
    shake *= Math.exp(-6 * dt);
    for (const s of shots) {
      if (s.t < 0) continue;
      s.t += dt;
      const k = s.t / LIFE;
      if (k >= 1) {
        s.t = -1;
        s.core.visible = s.shell.visible = s.ring.visible = false;
        if (s.light) { s.light.visible = false; s.light.intensity = 0; }
        continue;
      }
      const p = s.power;

      // Core: very fast expansion, then gone. This is the part that blooms.
      const ck = Math.min(1, s.t / 0.20);
      const cr = (0.5 + 5.2 * p) * (0.25 + ck * 0.75);
      s.core.scale.setScalar(cr);
      // HDR: 6x white at the peak is far above the 2.1 bloom threshold, so the
      // centre genuinely blows out rather than tone-mapping to grey.
      const cI = Math.max(0, 1 - s.t / 0.26);
      s.coreMat.opacity = cI;
      s.coreMat.color.setRGB(6 * cI, 4.4 * cI, 2.6 * cI);

      // Shell: slower, cooler, lingers — the orange body of the fireball.
      const sk = Math.min(1, s.t / 0.55);
      s.shell.scale.setScalar((0.7 + 7.4 * p) * (0.2 + sk * 0.8));
      const sI = Math.max(0, 1 - s.t / 0.62);
      s.shellMat.opacity = sI * 0.92;
      // Ramps white-hot -> orange -> deep red as it cools, which is what sells
      // it as burning rather than as a coloured balloon.
      s.shellMat.color.setRGB(3.4 * sI, 1.5 * sI * sI, 0.32 * sI * sI * sI);

      // Shockwave: a flat ring racing outward along the ground.
      const rk = Math.min(1, s.t / 0.45);
      s.ring.scale.setScalar((2 + 15 * p) * rk);
      s.ringMat.opacity = Math.max(0, 1 - rk) * 0.55;

      // Flash: near-instant, and short. A long one looks like a floodlight.
      if (s.light) {
        const f = Math.max(0, 1 - s.t / FLASH);
        s.light.intensity = f * f * 260 * p;
        s.light.distance = 40 + 70 * p;
      }
    }
  }

  return {
    group, fire, update,
    /** Decaying 0..1, for the camera rig to shake by. */
    get shake() { return shake; },
    dispose() {
      scene.remove(group);
      ballGeo.dispose(); ringGeo.dispose();
      for (const s of shots) { s.coreMat.dispose(); s.shellMat.dispose(); s.ringMat.dispose(); }
      shots.length = 0;
    },
  };
}
