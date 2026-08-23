// OPEN ROAD — entry point.
//
// Builds the world, wires the layers together and runs the loop. The world,
// ground query and vehicle are the load-bearing parts and are imported
// statically; everything else is a LAYER, loaded dynamically and replaced with
// a no-op stub if it fails.
//
// That last decision is deliberate. With static imports, one broken render
// module means a white screen and no clue why. With layers, a broken sky costs
// you the sky — the car still drives, the console says exactly what failed, and
// the boot screen tells the player which part is missing.

import * as THREE from 'three';
import { buildWorld } from './world/layout.js';
import { createGround } from './world/ground.js';
import { createVehicle } from './physics/vehicle.js';
import { createCollision } from './physics/collision.js';
import { createControls } from './input/controls.js';
import { CARS, CAR_BY_ID, STARTER, specFor } from './vehicles/catalog.js';

const BUILD = '2026-08-22';
const PHYS_HZ = 120;
const PHYS_DT = 1 / PHYS_HZ;
const MAX_SUBSTEPS = 6;

// ---------------------------------------------------------------------------
// Boot plumbing
// ---------------------------------------------------------------------------

const bootEl = document.getElementById('boot');
const bootFill = document.getElementById('boot-fill');
const bootStatus = document.getElementById('boot-status');
const failures = [];

function progress(pct, label) {
  if (bootFill) bootFill.style.width = `${Math.round(pct * 100)}%`;
  if (bootStatus && label) bootStatus.textContent = label;
}

/** Yield to the browser so the boot bar actually paints between stages. */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function stage(pct, label, fn) {
  progress(pct, label);
  await nextFrame();
  try {
    return await fn();
  } catch (err) {
    console.error(`[open road] stage "${label}" failed:`, err);
    failures.push(label);
    return null;
  }
}

/**
 * Import a layer, returning null rather than throwing. A missing or broken
 * layer degrades the game; it does not stop it.
 */
async function layer(path, name) {
  try {
    return await import(path);
  } catch (err) {
    console.error(`[open road] layer "${name}" unavailable:`, err);
    failures.push(name);
    return null;
  }
}

const NOOP = () => {};
/** Fills in the methods a missing layer would have provided. */
function stub(methods, extra) {
  const o = extra || {};
  for (const m of methods) if (!o[m]) o[m] = NOOP;
  return o;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const canvas = document.getElementById('view');

  // ---- renderer -----------------------------------------------------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
  } catch (err) {
    progress(1, 'This browser could not start WebGL.');
    if (bootStatus) bootStatus.dataset.error = '1';
    console.error(err);
    return;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.35, 6000);
  camera.position.set(0, 6, 12);

  // ---- world --------------------------------------------------------------
  const world = await stage(0.05, 'laying out the world', () => buildWorld());
  if (!world) { progress(1, 'The world failed to build.'); return; }

  const ground = await stage(0.18, 'grading the roads', () => createGround(world));
  if (!ground) { progress(1, 'The ground failed to build.'); return; }

  await stage(0.30, 'zoning the city', () => world.buildLots());
  await stage(0.38, 'planting', () => world.buildProps(ground));

  const collision = await stage(0.44, 'making the city solid', () => createCollision(world));

  // ---- layers -------------------------------------------------------------
  const [mTerrain, mRoads, mCity, mProps, mCar, mSky, mFx, mParticles, mTraffic, mHud, mMenus, mAudio, mTouch] =
    await stage(0.50, 'loading modules', () => Promise.all([
      layer('./render/terrain.js', 'terrain'),
      layer('./render/roads.js', 'roads'),
      layer('./render/city.js', 'city'),
      layer('./render/props.js', 'props'),
      layer('./render/carModel.js', 'car models'),
      layer('./render/sky.js', 'sky'),
      layer('./render/effects.js', 'post-processing'),
      layer('./render/particles.js', 'particles'),
      layer('./ai/traffic.js', 'traffic'),
      layer('./game/hud.js', 'HUD'),
      layer('./game/menus.js', 'menus'),
      layer('./game/audio.js', 'audio'),
      layer('./input/touch.js', 'touch controls'),
    ])) || [];

  const sky = await stage(0.56, 'raising the sky', () =>
    mSky ? mSky.createSky(scene, renderer) : null) ||
    stub(['setTime', 'setWeather', 'update', 'dispose'], {
      sun: fallbackSun(scene), hemi: null,
      state: { nightFactor: 0, fogColour: new THREE.Color(0x9fb6cc), rainIntensity: 0 },
    });

  const terrain = await stage(0.62, 'building the ground', () =>
    mTerrain ? mTerrain.createTerrain(world, ground) : null) ||
    stub(['update', 'setQuality', 'dispose'], { group: new THREE.Group() });
  scene.add(terrain.group);

  const roads = await stage(0.72, 'surfacing the roads', () =>
    mRoads ? mRoads.createRoads(world, ground) : null) ||
    stub(['update', 'setQuality', 'dispose'], { group: new THREE.Group() });
  scene.add(roads.group);

  const city = await stage(0.80, 'putting up buildings', () =>
    mCity ? mCity.createCity(world, ground) : null) ||
    stub(['update', 'setNight', 'setQuality', 'dispose'], { group: new THREE.Group() });
  scene.add(city.group);

  const props = await stage(0.86, 'street furniture', () =>
    mProps ? mProps.createProps(world, ground) : null) ||
    stub(['update', 'setNight', 'setQuality', 'dispose'], { group: new THREE.Group() });
  scene.add(props.group);

  const particles = await stage(0.90, 'dust and smoke', () =>
    mParticles ? mParticles.createParticles(scene) : null) ||
    stub(['emitDust', 'emitSmoke', 'emitSparks', 'addSkid', 'splash', 'setRain', 'update', 'dispose']);

  const effects = await stage(0.93, 'post-processing', () =>
    mFx ? mFx.createEffects(renderer, scene, camera) : null) ||
    stub(['setSize', 'setQuality', 'setSpeedBlur', 'dispose'], {
      render: () => renderer.render(scene, camera),
    });

  const traffic = await stage(0.95, 'putting traffic on the road', () =>
    mTraffic ? mTraffic.createTraffic(world, ground, { density: 42 }) : null) ||
    stub(['update', 'dispose'], { cars: [], count: 0 });

  // ---- player -------------------------------------------------------------
  const settings = loadSettings();
  let chosenCar = settings.car && CAR_BY_ID[settings.car] ? settings.car : STARTER;
  let chosenColour = settings.colour | 0;

  const car = createVehicle({ ground, spec: specFor(chosenCar, chosenColour), isPlayer: true });
  applyAssists(car, settings);

  const carRoot = new THREE.Group();
  scene.add(carRoot);
  let carModel = null;

  function fitCarModel(id, colourIndex) {
    if (carModel) { carRoot.remove(carModel.group); carModel.dispose && carModel.dispose(); carModel = null; }
    if (!mCar) return;
    try {
      carModel = mCar.createCarModel(specFor(id, colourIndex));
      carRoot.add(carModel.group);
    } catch (err) {
      console.error('[open road] car model failed:', err);
    }
  }
  fitCarModel(chosenCar, chosenColour);

  // Traffic gets its own pool of models, attached lazily as cars spawn.
  const trafficModels = new Map();
  function modelForTraffic(t) {
    let m = trafficModels.get(t);
    if (!m && mCar) {
      try {
        m = mCar.createCarModel({ ...specFor(t.specId || 'lark', 0), body: t.body, colour: t.colour });
        scene.add(m.group);
        trafficModels.set(t, m);
      } catch { m = null; }
    }
    return m;
  }

  // ---- UI -----------------------------------------------------------------
  const hud = (mHud && safe(() => mHud.createHUD(document.getElementById('hud'), { world }))) ||
    stub(['update', 'setVisible', 'toast', 'setMinimapZoom', 'dispose']);

  const menus = (mMenus && safe(() => mMenus.createMenus(document.getElementById('menus'), { world, settings }))) ||
    stub(['show', 'hide', 'on', 'setCars', 'dispose'], { current: null });

  const audio = (mAudio && safe(() => mAudio.createAudio())) ||
    stub(['start', 'update', 'playCollision', 'playSkid', 'playHorn', 'playIndicator',
      'setMuted', 'setVolume', 'setEngineProfile', 'dispose']);

  const touch = (mTouch && safe(() => mTouch.createTouchControls(document.getElementById('touch')))) ||
    stub(['read', 'setVisible', 'setLayout', 'dispose'], { isTouch: false });

  const controls = createControls({ settings: { sensitivity: settings.sensitivity || 1 } });

  // ---- place the car ------------------------------------------------------
  spawnOnRoad(0, -260);

  function spawnOnRoad(x, z) {
    const near = ground.nearestRoad(x, z, 900, (e) => e.kind !== 'track');
    if (near) {
      // Face along the road, offset into the right-hand lane.
      const yaw = Math.atan2(-near.tx, -near.tz);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const lane = (near.edge.width * 0.25);
      car.reset(near.x + rx * lane, near.z + rz * lane, yaw);
    } else {
      car.reset(x, z, 0);
    }
  }

  // ---- state --------------------------------------------------------------
  const MODES = ['chase', 'chaseFar', 'bonnet', 'bumper', 'orbit'];
  let cameraMode = 0;
  let mode = 'title';            // 'title' | 'garage' | 'driving' | 'paused' | 'map'
  let clockHours = settings.time != null ? settings.time : 9.5;
  let indicator = 0;             // -1 left, 0 off, 1 right
  let indicatorPhase = 0;
  let headlights = false;

  sky.setTime(clockHours);
  sky.setWeather(settings.weather || 'clear', 0);
  effects.setQuality(settings.post || 'medium');
  terrain.setQuality(settings.quality || 'medium');
  city.setQuality(settings.quality || 'medium');
  props.setQuality(settings.quality || 'medium');
  renderer.shadowMap.enabled = settings.shadows !== false;

  menus.setCars(CARS);
  menus.on('drive', (payload) => {
    if (payload && payload.id) {
      chosenCar = payload.id;
      chosenColour = payload.colour | 0;
      Object.assign(car.spec, specFor(chosenCar, chosenColour));
      fitCarModel(chosenCar, chosenColour);
      audio.setEngineProfile({ cylinders: CAR_BY_ID[chosenCar].cylinders, redline: car.spec.redline });
    }
    startDriving();
  });
  menus.on('select', (payload) => {
    if (payload && payload.id) fitCarModel(payload.id, payload.colour | 0);
  });
  menus.on('settings-change', (s) => {
    Object.assign(settings, s);
    saveSettings(settings);
    applySettings();
  });
  menus.on('resume', () => startDriving());
  menus.on('quit-to-title', () => { mode = 'title'; hud.setVisible(false); touch.setVisible(false); menus.show('title'); });
  menus.on('teleport', (p) => { if (p) { spawnOnRoad(p.x, p.z); startDriving(); } });

  function applySettings() {
    effects.setQuality(settings.post || 'medium');
    terrain.setQuality(settings.quality || 'medium');
    city.setQuality(settings.quality || 'medium');
    props.setQuality(settings.quality || 'medium');
    renderer.shadowMap.enabled = settings.shadows !== false;
    if (settings.time != null) { clockHours = settings.time; sky.setTime(clockHours); }
    if (settings.weather) sky.setWeather(settings.weather, 1.5);
    audio.setVolume(settings.volume != null ? settings.volume : 0.8);
    controls.setSensitivity(settings.sensitivity || 1);
    applyAssists(car, settings);
  }

  function startDriving() {
    mode = 'driving';
    menus.hide();
    hud.setVisible(true);
    touch.setVisible(!!touch.isTouch);
    controls.reset();
    audio.start();
  }

  menus.show('title');
  hud.setVisible(false);

  // ---- resize -------------------------------------------------------------
  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    effects.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // ---- the loop -----------------------------------------------------------
  // Scratch objects, reused every frame. Allocating here is what turns a smooth
  // 60 into a stutter every couple of seconds when the collector runs.
  const camTarget = new THREE.Vector3();
  const camWanted = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const suspension = [0, 0, 0, 0];
  const touchState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, camera: false, horn: false };
  const hudState = {
    speed: 0, gear: 1, rpm: 0, redline: 7000, surface: 'asphalt', throttle: 0, brake: 0,
    handbrake: 0, time: 12, heading: 0, x: 0, z: 0, district: '', speedLimit: 0,
    airborne: false, slipping: 0, odometer: 0,
  };
  const audioState = {
    rpm: 0, redline: 7000, throttle: 0, load: 0, speed: 0, gear: 1, shifting: false,
    surface: 'asphalt', slipping: 0, airborne: false, rainIntensity: 0, nearbyCars: [],
  };

  let accumulator = 0;
  let last = performance.now();
  let fpsSmooth = 60;

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    // A tab that was in the background hands back a dt of several seconds.
    // Stepping that would teleport the car through the city.
    if (!(dt > 0)) dt = 0.016;
    dt = Math.min(dt, 0.1);
    fpsSmooth += (1 / Math.max(1e-3, dt) - fpsSmooth) * 0.05;

    // ---- input ----
    touch.read(touchState);
    const input = controls.update(dt, touch.isTouch ? touchState : null);

    if (input.pause) {
      if (mode === 'driving') { mode = 'paused'; menus.show('pause'); hud.setVisible(false); controls.reset(); }
      else if (mode === 'paused') startDriving();
    }
    if (input.map && mode === 'driving') { mode = 'paused'; menus.show('map'); controls.reset(); }
    if (input.camera) cameraMode = (cameraMode + 1) % MODES.length;
    if (input.reset && mode === 'driving') spawnOnRoad(car.x, car.z);
    if (input.lights) headlights = !headlights;
    if (input.indLeft) indicator = indicator === -1 ? 0 : -1;
    if (input.indRight) indicator = indicator === 1 ? 0 : 1;
    if (input.horn) audio.playHorn();

    // ---- physics ----
    const driving = mode === 'driving';
    if (driving) {
      car.input.throttle = input.throttle;
      car.input.brake = input.brake;
      car.input.steer = input.steer;
      car.input.handbrake = input.handbrake;
    } else {
      car.input.throttle = 0; car.input.brake = 1; car.input.steer = 0; car.input.handbrake = 1;
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYS_DT && steps < MAX_SUBSTEPS) {
      car.step(PHYS_DT);
      if (collision) {
        const hit = collision.resolve(car);
        if (hit.hit && hit.severity > 0.04) {
          audio.playCollision(hit.severity);
          particles.emitSparks(hit.x, car.y + 0.4, hit.z, hit.severity * 14, hit.nx, hit.nz);
        }
      }
      accumulator -= PHYS_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;   // never let the debt spiral

    // ---- time of day ----
    if (settings.timeFlow !== false && driving) {
      clockHours = (clockHours + dt * (settings.timeScale || 0.02)) % 24;
      sky.setTime(clockHours);
    }
    const night = sky.state ? sky.state.nightFactor : 0;
    city.setNight(night);
    props.setNight(night);

    // ---- car visuals ----
    carRoot.position.set(car.x, car.y, car.z);
    carRoot.rotation.set(0, car.yaw, 0);
    // Pitch and roll are applied inside the yaw frame, which is what makes a car
    // lean INTO the camber rather than about the world axes.
    carRoot.rotateX(car.pitch);
    carRoot.rotateZ(-car.roll);
    if (carModel) {
      carModel.setSteer(car.steerAngle);
      carModel.setWheelSpin(car.wheels[0].spin);
      for (let i = 0; i < 4; i++) suspension[i] = car.wheels[i].comp;
      carModel.setSuspension(suspension);
      carModel.setBrakeLights(Math.max(input.brake, input.handbrake));
      carModel.setHeadlights(headlights || night > 0.35);
      carModel.setReverseLights(car.gear === 0);
      indicatorPhase += dt;
      carModel.setIndicator(indicator === 0 ? 0 : (indicatorPhase % 0.9 < 0.45 ? indicator : 0));
    }

    // ---- tyre effects ----
    if (driving) emitTyreEffects(dt);

    // ---- traffic ----
    traffic.update(dt, car.x, car.z, car.speed);
    syncTrafficModels();

    // ---- camera ----
    updateCamera(dt, driving);

    // ---- streaming ----
    terrain.update(camera.position, dt);
    roads.update(camera.position, dt);
    city.update(camera.position, dt);
    props.update(camera.position, dt);
    particles.update(dt, camera.position);
    if (sky.state) particles.setRain(sky.state.rainIntensity || 0, camera.position);
    sky.update(dt, camera.position);

    // ---- HUD ----
    if (driving) {
      hudState.speed = car.speed;
      hudState.gear = car.gear;
      hudState.rpm = car.rpm;
      hudState.redline = car.spec.redline;
      hudState.surface = car.surface;
      hudState.throttle = input.throttle;
      hudState.brake = input.brake;
      hudState.handbrake = input.handbrake;
      hudState.time = clockHours;
      hudState.heading = car.yaw;
      hudState.x = car.x; hudState.z = car.z;
      hudState.district = districtAt(car.x, car.z);
      hudState.airborne = car.airborne;
      hudState.slipping = car.slipping;
      hudState.odometer = car.odometer;
      const road = ground.roadAt(car.x, car.z);
      hudState.speedLimit = road.onRoad ? road.speedLimit : 0;
      hud.update(hudState);
    }

    // ---- audio ----
    audioState.rpm = car.rpm;
    audioState.redline = car.spec.redline;
    audioState.throttle = driving ? input.throttle : 0;
    audioState.load = Math.abs(car.lonG);
    audioState.speed = car.speed;
    audioState.gear = car.gear;
    audioState.shifting = car.shiftTimer > 0;
    audioState.surface = car.surface;
    audioState.slipping = car.slipping;
    audioState.airborne = car.airborne;
    audioState.rainIntensity = sky.state ? sky.state.rainIntensity || 0 : 0;
    audio.update(audioState, dt);

    // ---- render ----
    effects.setSpeedBlur(Math.min(1, Math.max(0, (car.speed - 22) / 55)));
    effects.render(dt);
  }

  // --- helpers used by the loop, defined here so they close over the world ---

  const skidCooldown = [0, 0, 0, 0];
  function emitTyreEffects(dt) {
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
    const hw = car.spec.track / 2, hb = car.spec.wheelbase / 2;
    for (let i = 0; i < 4; i++) {
      const ox = i % 2 === 0 ? -hw : hw;
      const oz = i < 2 ? hb : -hb;
      const wx = car.x + rx * ox + fx * oz;
      const wz = car.z + rz * ox + fz * oz;
      const w = car.wheels[i];
      const surf = ground.SURFACES[w.surface];
      if (!surf) continue;

      const working = car.slipping > 0.12 || car.input.handbrake > 0.5;
      if (surf.dust > 0.1 && car.speed > 3) {
        particles.emitDust(wx, car.y - car.spec.rideHeight + 0.05, wz,
          surf.dust * (0.35 + car.speed * 0.05) * (working ? 2.2 : 1), surf.colour);
      } else if (working && car.speed > 4) {
        particles.emitSmoke(wx, car.y - car.spec.rideHeight + 0.05, wz, car.slipping * 2.4);
        skidCooldown[i] -= dt;
        if (skidCooldown[i] <= 0) {
          particles.addSkid(wx, car.y - car.spec.rideHeight + 0.02, wz, car.yaw, car.slipping);
          skidCooldown[i] = 0.02;
        }
      }
    }
    if (car.slipping > 0.3) audio.playSkid(car.slipping);
  }

  function syncTrafficModels() {
    const list = traffic.cars || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const m = modelForTraffic(t);
      if (!m) continue;
      m.group.visible = t.active !== false;
      if (!m.group.visible) continue;
      m.group.position.set(t.x, t.y, t.z);
      m.group.rotation.set(0, t.yaw, 0);
      m.setWheelSpin(t.wheelSpin || 0);
      m.setBrakeLights(t.braking ? 1 : 0);
      m.setHeadlights((sky.state ? sky.state.nightFactor : 0) > 0.35);
      m.setIndicator(t.indicator || 0);
    }
    // Retire models whose car has been recycled out of the world.
    if (trafficModels.size > list.length + 8) {
      for (const [t, m] of trafficModels) {
        if (!list.includes(t)) {
          scene.remove(m.group);
          m.dispose && m.dispose();
          trafficModels.delete(t);
        }
      }
    }
  }

  function districtAt(x, z) {
    let best = '', bd = Infinity;
    for (const d of world.districts) {
      const dist = Math.hypot(d.cx - x, d.cz - z);
      if (dist < d.r + 120 && dist < bd) { bd = dist; best = d.name; }
    }
    if (best) return best;
    for (const v of world.villages) {
      const dist = Math.hypot(v.x - x, v.z - z);
      if (dist < 320 && dist < bd) { bd = dist; best = v.name; }
    }
    return best || 'Open country';
  }

  function updateCamera(dt, driving) {
    const m = MODES[cameraMode];
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const speedT = Math.min(1, car.speed / 62);

    if (mode === 'title' || mode === 'garage' || !driving) {
      // A slow orbit of the car for the menus, so the front end is never a
      // static screenshot.
      const t = performance.now() * 0.00013;
      camWanted.set(car.x + Math.cos(t) * 11, car.y + 3.4, car.z + Math.sin(t) * 11);
      camLook.set(car.x, car.y + 0.7, car.z);
      camera.position.lerp(camWanted, 1 - Math.exp(-3 * dt));
      camera.lookAt(camLook);
      camera.fov += (58 - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
      return;
    }

    if (m === 'bonnet' || m === 'bumper') {
      const h = m === 'bonnet' ? 1.14 : 0.62;
      const fwd = m === 'bonnet' ? 0.45 : 1.9;
      camera.position.set(car.x + fx * fwd, car.y + h, car.z + fz * fwd);
      camLook.set(car.x + fx * 60, car.y + h - car.pitch * 26, car.z + fz * 60);
      camera.up.set(0, 1, 0);
      camera.lookAt(camLook);
      camera.rotateZ(-car.roll * 0.55);
      camera.fov += ((62 + speedT * 14) - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
      return;
    }

    if (m === 'orbit') {
      const t = performance.now() * 0.0002;
      camWanted.set(car.x + Math.cos(t) * 14, car.y + 5.5, car.z + Math.sin(t) * 14);
      camera.position.lerp(camWanted, 1 - Math.exp(-2.4 * dt));
      camLook.set(car.x, car.y + 0.8, car.z);
      camera.lookAt(camLook);
      return;
    }

    // Chase. The camera trails the car's HEADING, not its velocity: chasing the
    // velocity vector means the view swings wildly the moment the car steps out
    // of line, exactly when the player most needs a stable horizon.
    const far = m === 'chaseFar';
    const back = (far ? 11.5 : 7.4) + speedT * 3.4;
    const high = (far ? 4.6 : 3.0) + speedT * 0.5;
    const lookBack = controls.state.lookBack > 0 ? -1 : 1;

    camWanted.set(
      car.x - fx * back * lookBack,
      car.y + high,
      car.z - fz * back * lookBack,
    );
    // Keep the camera above the ground even when the car is in a dip.
    const gy = ground.heightAt(camWanted.x, camWanted.z) + 1.6;
    if (camWanted.y < gy) camWanted.y = gy;

    // Critically damped spring rather than a lerp, so the follow distance does
    // not depend on frame rate.
    const stiffness = 42, damping = 2 * Math.sqrt(stiffness);
    tmp.copy(camWanted).sub(camera.position).multiplyScalar(stiffness);
    camVel.addScaledVector(tmp, dt).multiplyScalar(Math.exp(-damping * dt));
    camera.position.addScaledVector(camVel, dt);

    camTarget.set(car.x + fx * 9 * lookBack, car.y + 1.25, car.z + fz * 9 * lookBack);
    camLook.lerp(camTarget, 1 - Math.exp(-11 * dt));
    camera.up.set(0, 1, 0);
    camera.lookAt(camLook);
    camera.rotateZ(-car.roll * 0.28);
    camera.fov += ((60 + speedT * 16) - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
  }

  // ---- done ---------------------------------------------------------------
  progress(1, failures.length ? `ready — ${failures.length} module(s) unavailable` : 'ready');
  await nextFrame();
  if (bootEl) {
    bootEl.classList.add('is-done');
    setTimeout(() => bootEl.remove(), 700);
  }
  if (failures.length) {
    console.warn('[open road] running without:', failures.join(', '));
    hud.toast(`Running without: ${failures.join(', ')}`, 6);
  }

  window.__OPENROAD = {
    build: BUILD, world, ground, car, controls, scene, renderer, camera,
    traffic, settings, failures,
    fps: () => Math.round(fpsSmooth),
    teleport: (x, z) => spawnOnRoad(x, z),
    /** Deterministic tick, so a headless harness drives the same code the player does. */
    tick: (n = 1, dt = PHYS_DT) => { for (let i = 0; i < n; i++) car.step(dt); return car; },
  };

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safe(fn) {
  try { return fn(); } catch (err) { console.error('[open road]', err); return null; }
}

/** A single light, so a missing sky module still leaves a visible world. */
function fallbackSun(scene) {
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
  sun.position.set(120, 220, 90);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xa8c4e0, 0x4a4436, 1.1));
  scene.background = new THREE.Color(0x9fb6cc);
  scene.fog = new THREE.Fog(0x9fb6cc, 300, 1900);
  return sun;
}

const SETTINGS_KEY = 'openroad.settings.v1';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private browsing, or a corrupt value — defaults are fine */ }
  return {
    quality: 'medium', post: 'medium', shadows: true,
    volume: 0.8, sensitivity: 1, weather: 'clear', time: 9.5, timeScale: 0.02,
    abs: true, tc: true, esc: true,
  };
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* nothing to do */ }
}

function applyAssists(car, s) {
  car.aids.abs = s.abs === false ? 0 : 0.95;
  car.aids.tc = s.tc === false ? 0 : 0.55;
  car.aids.stability = s.esc === false ? 0 : 0.62;
}

boot().catch((err) => {
  console.error('[open road] fatal:', err);
  if (bootStatus) {
    bootStatus.dataset.error = '1';
    bootStatus.textContent = `Failed to start: ${err && err.message ? err.message : err}`;
  }
});
