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
import { createCollision, createCarCollision } from './physics/collision.js';
// DAMAGE is the one switch for crashes: off, a crash is a harmless bump. See
// physics/damage.js for everything it turns off.
import { createDamage, DAMAGE } from './physics/damage.js';
import { createControls } from './input/controls.js';
import { CARS, CAR_BY_ID, STARTER, specFor } from './vehicles/catalog.js';
// Pure, dependency-free and tiny, so it is imported directly rather than through
// layer(): there is nothing in it that can fail at load time.
import { roomUrl } from './net/config.js';
import { loadSettings, saveSettings, suggestName } from './game/settings.js';
// Pure arithmetic, no three.js and no DOM, so imported directly for the same
// reason as roomUrl above. See the render-interpolation note in the loop.
import { createPoseBuffer, settleAccumulator, blendFactor, springAngleStep, followLinear } from './core/interp.js';
import { createAdaptiveQuality } from './core/adaptive.js';

const BUILD = '2026-08-22';
const PHYS_HZ = 120;
const PHYS_DT = 1 / PHYS_HZ;
// Enough steps to cover the 0.1 s the frame clamp allows, so a machine running
// at 10-20 fps still runs the game at real speed. At 6 (50 ms) a 15 fps frame
// lost a quarter of its time, and the accumulator was zeroed as well, so the
// car drove in slow motion AND twitched. A whole step (car, collisions, goals)
// measured 9-18 us on an M2, so even ten times slower, 12 of them are cheap.
const MAX_SUBSTEPS = 12;

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

/**
 * Yield to the browser so the boot bar actually paints between stages.
 *
 * Falls back to a timer, because a background tab does not fire
 * requestAnimationFrame at all — and a boot sequence that awaits one would sit
 * on the loading screen forever until the tab is looked at. Opening the game in
 * a new tab and switching away while it loads is entirely normal behaviour.
 */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 60);
});

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

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

  await stage(0.30, 'zoning the city', () => world.buildLots(ground));
  await stage(0.38, 'planting', () => world.buildProps(ground));

  const collision = await stage(0.44, 'making the world solid', () => createCollision(world, { ground }));
  const carHits = createCarCollision();

  // Settings are needed before the layers, because traffic density and draw
  // distance are constructor arguments, not things you can set afterwards.
  const settingsEarly = loadSettings();

  // ---- layers -------------------------------------------------------------
  // APPEND ONLY. This destructures positionally, so inserting a layer into the
  // middle of the array below silently shifts every module after it onto the
  // wrong variable — the kind of bug that looks like six unrelated bugs.
  const [mTerrain, mRoads, mCity, mProps, mCar, mSky, mFx, mParticles, mTraffic, mHud, mMenus, mAudio, mTouch,
         mCarDamage, mDebris, mDamageFx, mDrift, mModels, mNet, mTags, mBoom, mWreck,
         mGoals, mGates, mObjectives] =
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
      // SOUND IS OFF. Not muted — not loaded.
      //
      // The engine synthesiser runs oscillators straight into the destination
      // and start() fires on the first user gesture, so it came up at whatever
      // the system volume happened to be and stayed there. Muting by default
      // leaves that one toggle away, so the module is disconnected entirely.
      // Re-enable by restoring this line; src/game/audio.js is untouched.
      Promise.resolve(null),
      layer('./input/touch.js', 'touch controls'),
      // The damage layers load only with DAMAGE on (physics/damage.js). Off,
      // each is the null its slot was always allowed to be — about 4,000 lines
      // the browser no longer fetches — and every use below already copes.
      DAMAGE ? layer('./render/carDamage.js', 'car damage') : Promise.resolve(null),
      DAMAGE ? layer('./physics/debris.js', 'debris') : Promise.resolve(null),
      DAMAGE ? layer('./render/damageFx.js', 'damage effects') : Promise.resolve(null),
      layer('./game/drift.js', 'drift scoring'),
      layer('./render/models.js', 'model library'),
      layer('./net/net.js', 'multiplayer'),
      layer('./render/nameTags.js', 'name tags'),
      DAMAGE ? layer('./render/explosion.js', 'explosions') : Promise.resolve(null),
      DAMAGE ? layer('./game/wreck.js', 'wreck sequence') : Promise.resolve(null),
      layer('./game/goals.js', 'goals'),
      layer('./render/gates.js', 'goal markers'),
      layer('./game/objectives.js', 'objectives'),
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

  /**
   * Fog has to end where the ground ends.
   *
   * The terrain streams a finite ring of chunks; beyond it there is nothing.
   * Fog is what hides that boundary, so if the fog reaches further than the
   * chunks do, the player watches the world stop dead in mid-air against the
   * sky. Left to their defaults these two disagreed badly — fog out to 4960 m
   * against terrain that stops at 1088 m, roughly 3% opacity where the ground
   * ran out. They are tied together here and re-tied on every quality change,
   * since changing quality changes the ring size.
   */
  function matchFogToTerrain() {
    const d = terrain.stats && terrain.stats.viewDistance;
    if (d && sky.setDrawDistance) sky.setDrawDistance(d);
  }
  matchFogToTerrain();

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
    mParticles ? mParticles.createParticles(scene, { maxBillow: 4200, maxSpark: 900 }) : null) ||
    stub(['emitDust', 'emitSmoke', 'emitSparks', 'addSkid', 'splash', 'setRain', 'update', 'dispose']);

  const effects = await stage(0.93, 'post-processing', () =>
    mFx ? mFx.createEffects(renderer, scene, camera) : null) ||
    stub(['setSize', 'setQuality', 'setSpeedBlur', 'dispose'], {
      render: () => renderer.render(scene, camera),
    });

  const debris = (mDebris && safe(() => mDebris.createDebris(ground))) ||
    stub(['spawn', 'spawnPart', 'update', 'clear', 'dispose'], { group: new THREE.Group(), count: 0 });
  scene.add(debris.group);

  const damageFx = (mDamageFx && safe(() => mDamageFx.createDamageFx(scene))) ||
    stub(['update', 'applyEvents', 'reset', 'dispose']);

  const drift = (mDrift && safe(() => mDrift.createDrift())) ||
    stub(['update', 'reset', 'dispose', 'onCollision'],
      { state: { active: false, score: 0, angle: 0, multiplier: 1, banked: 0, best: 0 } });

  const models = (mModels && safe(() => mModels.createModelLibrary())) ||
    stub(['preload', 'dispose'],
      { load: async () => null, loadCar: async () => null, has: () => false, get: () => null });

  const traffic = await stage(0.95, 'putting traffic on the road', () =>
    mTraffic ? mTraffic.createTraffic(world, ground,
      { density: Math.round((settingsEarly.traffic != null ? settingsEarly.traffic : 0.55) * 80) }) : null) ||
    stub(['update', 'dispose'], { cars: [], count: 0 });

  // ---- player -------------------------------------------------------------
  const settings = settingsEarly;
  // Everyone has a name from the first frame. A player who never opens settings
  // still shows up as somebody rather than as a blank plate.
  if (!settings.name) { settings.name = suggestName(); saveSettings(settings); }
  let chosenCar = settings.car && CAR_BY_ID[settings.car] ? settings.car : STARTER;
  let chosenColour = settings.colour | 0;

  // damage: DAMAGE — off, the car carries no damage model at all (car.damage
  // is null), so no crash can cost it power, grip, brakes or steering.
  const car = createVehicle({ ground, spec: specFor(chosenCar, chosenColour), isPlayer: true, damage: DAMAGE });
  applyAssists(car, settings);

  const carRoot = new THREE.Group();
  scene.add(carRoot);
  let carModel = null;

  let carDamage = null;
  function fitCarModel(id, colourIndex) {
    if (carDamage) { carDamage.dispose && carDamage.dispose(); carDamage = null; }
    if (carModel) { carRoot.remove(carModel.group); carModel.dispose && carModel.dispose(); carModel = null; }
    if (!mCar) return;
    const spec = specFor(id, colourIndex);
    try {
      carModel = mCar.createCarModel(spec);
      carRoot.add(carModel.group);
    } catch (err) {
      console.error('[open road] car model failed:', err);
      return;
    }
    // The damage rig binds to whatever model it was given, procedural or
    // imported — models.js wires an imported car to the same interface, so
    // nothing downstream can tell the difference.
    if (mCarDamage) {
      try { carDamage = mCarDamage.createCarDamage(carModel, spec); }
      catch (err) { console.error('[open road] damage rig failed:', err); }
    }
  }
  fitCarModel(chosenCar, chosenColour);

  // Traffic models: one per POOL SLOT.
  //
  // traffic.cars is a fixed-length pool, not a live list — a slot keeps the same
  // spec, body and colour for the whole session and is recycled by flipping
  // `active`. So the mesh is built once per slot and only its visibility is
  // toggled. Keying models by car object instead (and pruning with `includes`)
  // never prunes anything, because the objects are never replaced.
  const trafficModels = [];
  // Visual damage for traffic, one per slot, built on first contact like the
  // damage state itself. Low detail: a traffic car is seen from further away
  // and more briefly than the player's, so it gets dents and scuffs but not
  // the full cavity treatment.
  const trafficDamage = [];
  const trafficRespawn = [];
  // ---- other drivers ------------------------------------------------------
  //
  // Remote cars are GHOSTS: drawn, named, findable, but not in the collision
  // set. That is what lets the whole thing work at any ping — nothing another
  // player does can alter your physics, so nothing has to agree. Add collision
  // here and every number in the netcode has to be re-derived.
  let net = null;
  if (mNet) {
    try {
      const url = roomUrl();
      if (url) {
        net = mNet.createNet({
          url, name: settings.name || '', seed: world.seed,
          // The car and paint everyone else sees, and this client's ground,
          // which remote cars are laid on between samples (net/room.js).
          carId: chosenCar, colour: chosenColour, maxPlayers: 16,
          heightAt: ground.heightAt,
        });
        // Off in Settings means off from the first frame — it used to connect
        // anyway and only let go once the settings screen was touched.
        if (settings.multiplayer === false) net.disable();
      }
    } catch (err) {
      console.error('[open road] multiplayer unavailable:', err);
      net = null;
    }
  }

  const tags = mTags
    ? mTags.createNameTags(document.body, { showTags: settings.nameTags !== false })
    : null;
  if (tags) tags.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight);

  // Finding each other: the friends list (Tab), a beacon over everyone,
  // starting next to a friend, Go and Guide. Loaded here rather than in the
  // layer list above, which destructures by position and is shared with every
  // other part of the game; each of these may be null, and the game without
  // them is the game with multiplayer and no way to find anybody.
  //
  // And playing together: race your friends, tag, coin rush, emotes
  // (game/modes.js, refereed by the room in server/modes.js), drawn on screen
  // by game/modesUi.js and in the world by render/modeFx.js. Same rules: any
  // of them may be null and the game carries on without it.
  const [mParty, mRoster, mBeacons, mModes, mModesUi, mModeFx] = net ? await Promise.all([
    layer('./game/party.js', 'friends'),
    layer('./game/roster.js', 'friends list'),
    layer('./render/beacons.js', 'player beacons'),
    layer('./game/modes.js', 'party games'),
    layer('./game/modesUi.js', 'party games screen'),
    layer('./render/modeFx.js', 'party games world'),
  ]) : [null, null, null, null, null, null];
  const party = mParty ? safe(() => mParty.createParty({
    net, world, ground,
    // The goals layer already built the road graph; borrow it. Read at the
    // first Guide, long after `goals` exists.
    graph: () => (goals ? goals.graph : null),
    place: (x, z, yaw) => placeCar(x, z, yaw),
  })) : null;
  const colourOf = party ? party.colourFor : null;
  const modes = mModes && party ? safe(() => mModes.createModes({
    net, world,
    // Read at the first game, long after `goals` exists: its races.
    goals: () => goals,
    place: (x, z, yaw) => placeCar(x, z, yaw),
    abandonGoals: () => { if (goals) goals.abandon(); },
    colourOf,
    self: () => ({ name: settings.name || '', carId: chosenCar, colour: chosenColour }),
    goTo: (id) => party.goTo(id),
  })) : null;
  const roster = mRoster && party ? safe(() => mRoster.createRoster({
    party, net, modes, onGo: goToFriend, onGuide: guideToFriend,
    onStopGuide: () => party.stopGuide(),
  })) : null;
  if (net && roster) net.onEvent = (e) => roster.onNetEvent(e);
  const beacons = mBeacons && party ? safe(() => mBeacons.createBeacons(scene, {
    quality: settings.quality || 'medium', heightAt: ground.heightAt,
  })) : null;
  const modesUi = mModesUi && modes ? safe(() => mModesUi.createModesUi({
    modes, toast: (t, css) => { if (roster) roster.toast(t, css); }, online: () => party.online,
  })) : null;
  const modeFx = mModeFx && modes ? safe(() => mModeFx.createModeFx(scene, {
    quality: settings.quality || 'medium', heightAt: ground.heightAt,
  })) : null;

  /** "Go": onto the road right behind them, facing their way. */
  function goToFriend(id) {
    if (!party) return;
    // Mid-race or mid-tag, Go would be a teleport past everyone.
    if (modes && modes.blocksGo) { if (roster) roster.toast(modes.blocksGo); return; }
    if (goals && goals.activeRace) goals.abandon();
    const s = party.goTo(id);
    if (!s) { if (roster) roster.toast('They are not on the road yet — try again in a moment'); return; }
    if (mode !== 'driving') startDriving();
    if (roster) roster.toast(`You're right behind ${s.name}!`, colourOf(net.room.car(id) || { id }).css);
  }

  /** "Guide": a route along the roads that keeps pointing at them. */
  function guideToFriend(id) {
    if (!party) return;
    if (modes && modes.blocksGo) { if (roster) roster.toast(modes.blocksGo); return; }
    if (goals && goals.activeRace) {
      if (roster) roster.toast('Finish the race first — or press Backspace to leave it');
      return;
    }
    if (!party.startGuide(id, car)) {
      if (roster) roster.toast('Could not find a road to them yet — try Go instead');
      return;
    }
    if (mode !== 'driving') startDriving();
    const g = party.guide;
    if (roster) roster.toast(`Follow the arrows on the road to ${g.name}`, g.css);
  }

  /** The guide says you got there, or that they went. */
  function announceGuide(ev) {
    if (!roster) return;
    const g = party.guide;
    if (ev === 'arrived') roster.toast(`You found ${g.name}!`, g.css);
    else if (ev === 'lost') roster.toast(`Lost ${g.name} — they left or went quiet`, g.css);
  }

  // One model per remote SLOT, built lazily and kept — same reasoning as the
  // traffic pool above. A slot that goes quiet hides its mesh rather than
  // disposing it, because the same slot is usually reused within seconds.
  const boom = mBoom
    ? mBoom.createExplosions(scene, { quality: settings.quality || 'medium' })
    : null;

  // The aftermath director. Given the wreck it sheds panels, keeps the fire
  // alive, and calls someone to come and put it out.
  const wreck = mWreck ? mWreck.createWreck({
    scene, ground, particles,
    debris: mDebris ? debris : null,
    createCarModel: mCar ? mCar.createCarModel : null,
    carGroup: () => (carModel ? carModel.group : null),
    onToast: (msg, secs) => hud.toast(msg, secs),
  }) : null;

  // Per slot: { m: model, rev: the room's infoRev it was built for, spec,
  // spin }. Each player is drawn in the car and paint they chose (sent at
  // join and on every garage change); a slot is rebuilt only when that
  // changes or a different player takes it over.
  const remoteModels = [];
  function syncRemoteModels(night, dt) {
    if (!net || !mCar) return;
    const list = net.room.cars;
    let built = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let r = remoteModels[i];
      if (!c.active || c.fade <= 0) { if (r && r.m) r.m.group.visible = false; continue; }
      if (!r || r.rev !== c.infoRev) {
        // One build per frame at most. A body style nobody has driven yet costs
        // tens of milliseconds the first time, and a room filling up at once
        // must not stack those into one visible hitch.
        if (built > 0) { if (r && r.m) r.m.group.visible = false; continue; }
        built++;
        if (r && r.m) r.m.dispose();
        const known = !!CAR_BY_ID[c.carId];
        const spec = specFor(known ? c.carId : STARTER, c.colour);
        // An old server sends no car: the starter, in the old per-id colour.
        if (!known) spec.colour = remoteColour(c.id);
        let m = null;
        try {
          m = mCar.createCarModel(spec);
          scene.add(m.group);
        } catch (err) {
          console.error('[open road] remote car model failed:', err);
          m = null;
        }
        // A paint from the shop rides on the colour index (party.js,
        // wireColour): the model is built in the factory colour and painted.
        const sp = m && mParty ? mParty.specialPaint(c.colour) : null;
        if (sp != null) m.setPaint(sp);
        r = remoteModels[i] = { m, rev: c.infoRev, spec, spin: 0 };
      }
      const m = r.m;
      if (!m) continue;
      m.group.visible = true;
      m.group.position.set(c.x, c.y, c.z);
      m.group.rotation.set(0, c.yaw, 0);
      if (c.pitch) m.group.rotateX(c.pitch);
      // -roll, as the player's own car and the traffic do. With +roll every
      // remote car leaned OUT of its corners.
      if (c.roll) m.group.rotateZ(-c.roll);
      // Same calls the traffic pool makes — createCarModel has no setWheels or
      // setLights, so guessing those names would have failed silently behind an
      // `if`, which is exactly how a car ends up sliding on frozen wheels.
      m.setSteer(c.steer * (r.spec.maxSteer || 0.6));
      // Wheels turn at the speed the car is DRAWN moving. The angle on the
      // wire is sampled at 20 Hz, and a wheel turning 90 rad/s sampled that
      // slowly aliases into one creeping backwards.
      r.spin += c.speed / (r.spec.wheelRadius || 0.34) * dt;
      m.setWheelSpin(r.spin);
      m.setBrakeLights(c.brake ? 1 : 0);
      m.setHeadlights(c.lights || night > 0.35);
      m.setReverseLights(c.speed < -0.5);
      const ind = c.indL ? -1 : c.indR ? 1 : 0;
      m.setIndicator(ind === 0 ? 0 : (indicatorPhase % 0.9 < 0.45 ? ind : 0));
    }
  }

  /** A stable colour per player id, for a player whose car we were not told. */
  function remoteColour(id) {
    const h = (id * 47) % 360;
    return new THREE.Color().setHSL(h / 360, 0.62, 0.48).getHex();
  }

  function syncTrafficModels(night, dt) {
    const list = traffic.cars || [];
    if (!mCar) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      let m = trafficModels[i];
      if (m === undefined) {
        try {
          m = mCar.createCarModel({ ...t.spec, body: t.body, colour: t.colour });
          scene.add(m.group);
        } catch (err) {
          console.error('[open road] traffic model failed:', err);
          m = null;
        }
        trafficModels[i] = m;
      }
      if (!m) continue;

      // A recycled slot is a different car. Without this it drives away wearing
      // the last one's dents. (With DAMAGE off there are no dents and nothing
      // burns: onTrafficHit() never records a slot, and neither block runs.)
      if (DAMAGE && trafficRespawn[i] !== undefined && trafficRespawn[i] !== t.respawnId) {
        trafficRespawn[i] = t.respawnId;
        // Disposed, not reset. reset() restores the paint but keeps every mesh
        // the split produced and leaves the full-body scuff overlay visible at
        // zero alpha, so a recycled slot kept paying for a transparent pass it
        // no longer needed. The rig is rebuilt lazily if this car is hit too.
        if (trafficDamage[i]) { trafficDamage[i].dispose(); trafficDamage[i] = undefined; }
        if (t.damage) t.damage.reset();
        t.wrecked = false;
        t.exploded = false;
        t.written = false;
        t.burning = 0;
        t.speedCap = undefined;
      }
      if (trafficDamage[i] && t.damage) trafficDamage[i].update(t.damage.state, dt);

      // A written-off car burns where it stands. Keeps its own fire alive too:
      // traffic damage is never stepped, so nothing else would sustain it.
      if (DAMAGE && t.burning > 0 && t.active) {
        t.burning -= dt;
        if (t.damage) {
          t.damage.state.onFire = t.burning > 3 ? 0.85 : Math.max(0, t.burning / 3.5);
          t.damage.state.temp = 1;
        }
        const k = Math.min(1, t.burning / 3);
        if (Math.random() < dt * 42 * k) {
          particles.emitSparks(t.x + (Math.random() * 2 - 1) * 0.6,
            t.y + 0.7 + Math.random() * 0.7, t.z + (Math.random() * 2 - 1) * 0.6, 5, 0, 0);
        }
        if (Math.random() < dt * 34 * k) particles.emitSmoke(t.x, t.y + 1.3, t.z, 3);
        if (Math.random() < dt * 22 * k) particles.emitSmoke(t.x, t.y + 3.2, t.z, 2);
        if (t.burning <= 0 && t.damage) t.damage.state.onFire = 0;
      }

      if (!t.active) { m.group.visible = false; continue; }
      m.group.visible = true;
      m.group.position.set(t.x, t.y, t.z);
      m.group.rotation.set(0, t.yaw, 0);
      if (t.pitch) m.group.rotateX(t.pitch);
      if (t.roll) m.group.rotateZ(-t.roll);
      m.setSteer(t.steerAngle || 0);
      m.setWheelSpin(t.wheelSpin || 0);
      m.setBrakeLights(t.braking ? 1 : 0);
      m.setHeadlights(night > 0.35);
      m.setIndicator(t.indicator ? (indicatorPhase % 0.9 < 0.45 ? t.indicator : 0) : 0);
    }
  }

  // ---- UI -----------------------------------------------------------------
  const hud = (mHud && safe(() => mHud.createHUD(document.getElementById('hud'), { world }))) ||
    stub(['update', 'setVisible', 'toast', 'setMinimapZoom', 'dispose']);

  const menus = (mMenus && safe(() => mMenus.createMenus(document.getElementById('menus'),
    // handleEscape, because while a screen is open the menu consumes keys at
    // capture phase — controls.js is a bubble-phase window listener and never
    // sees them, so without this Escape opens the pause screen and nothing
    // closes it. The menu emits 'resume' instead.
    { world, settings, handleEscape: true }))) ||
    stub(['show', 'hide', 'on', 'setCars', 'dispose'], { current: null });

  const audio = (mAudio && safe(() => mAudio.createAudio())) ||
    stub(['start', 'update', 'playCollision', 'playSkid', 'playHorn', 'playIndicator',
      'setMuted', 'setVolume', 'setEngineProfile', 'applyDamageEvents', 'dispose']);

  const touch = (mTouch && safe(() => mTouch.createTouchControls(document.getElementById('touch')))) ||
    stub(['read', 'setVisible', 'setLayout', 'dispose'], { isTouch: false });

  const controls = createControls({ settings: { sensitivity: settings.sensitivity || 1 } });

  // ---- place the car ------------------------------------------------------
  // Declared before the first spawnOnRoad() below, which runs during boot and
  // writes them — a `let` read above its declaration is a dead-zone throw, not
  // an undefined, so this ordering is load-bearing.
  //
  // A respawn is a cut, not a move: the other clients snap rather than
  // interpolating, or your car streaks the width of the map at 400 m/s.
  // True while a menu text field has focus; see menus.onTyping below.
  let typing = false;
  let respawnSeq = 0;
  let teleported = false;

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
    // Tell the other clients this was a cut, not a drive. They snap instead of
    // interpolating; without it your car streaks across the map at 400 m/s.
    respawnSeq = (respawnSeq + 1) & 0xff;
    teleported = true;
    if (wreck) wreck.reset();
  }

  // ---- goals: races, traps, jumps, drift zones, tokens, GPS ---------------
  // One layer (src/game/goals.js) with two optional faces: the world markers
  // (render/gates.js) and the on-screen objectives (game/objectives.js). Any of
  // the three may be null; with goals null this is the free-roam it was.
  function placeCar(x, z, yaw) {
    car.reset(x, z, yaw);
    if (carDamage) carDamage.reset();
    damageFx.reset();
    respawnSeq = (respawnSeq + 1) & 0xff;
    teleported = true;
    if (wreck) wreck.reset();
  }
  // The drift scorer counts only if it really built: when createDrift()
  // throws, `drift` is the stub, whose bank never moves, and every drift zone
  // would be on the map and impossible to score. The stub is the one whose
  // update is NOOP.
  const driftLive = drift.update !== NOOP;
  const goals = mGoals ? safe(() => mGoals.createGoals({
    world, ground, car, settings, place: placeCar,
    drift: driftLive ? drift : null, particles, cars: CARS, audio,
    grant: settings.car ? [settings.car] : [],
    toast: (m, secs) => hud.toast(m, secs),
    scene, root: document.getElementById('hud'),
    createView: mGates ? mGates.createGoalGates : null,
    createOverlay: mObjectives ? mObjectives.createObjectives : null,
    // Skill chains read the traffic pool for near misses and the slipstream,
    // and punch the camera's FOV on big moments (setFov eases it back).
    traffic, camera,
    // No chimes: the game is silent by the owner's standing choice, and the
    // goal chimes were the one sound still playing.
    sfx: false,
  })) : null;
  if (goals) {
    // Boot straight onto a road 200 m short of whatever is next, facing it —
    // so the title screen shows its beacon and Drive has somewhere to go.
    goals.placeInitial();
    if (menus.setGoals) menus.setGoals(goals);
    menus.on('drive', (p) => goals.onDrive(!!(p && p.fresh)));
    menus.on('goal-travel', (id) => { if (goals.travelTo(id)) startDriving(); });
    menus.on('goal-target', (id) => goals.setTarget(id));
    menus.on('goal-restart', () => { goals.restart(); startDriving(); });
    menus.on('goal-abandon', () => { goals.abandon(); startDriving(); });
    menus.on('teleport', () => goals.abandon());
    menus.on('quit-to-title', () => goals.abandon());
  }
  // Other drivers: everyone sees the car you take out, and pressing Play
  // while friends are online starts you on the road right behind one of them
  // — whoever you picked on the title screen, or else the nearest. Registered
  // after goals.onDrive, so the challenge GPS is set up either way.
  // The paint goes too: a special paint from the shop as well as a factory one.
  const wireColourOf = (index, paintId) => (mParty ? mParty.wireColour(index, paintId) : index | 0);
  if (net && goals) net.setCar(chosenCar, wireColourOf(chosenColour, goals.progress.livery(chosenCar)));
  menus.on('drive', (p) => {
    if (net && p && p.id) net.setCar(p.id, wireColourOf(p.colour, p.paint));
    if (!party || !p || !p.fresh) return;
    // A friend's game is inviting (the title said "Press Play to join in"):
    // Play joins it, and the game puts you where it wants you.
    if (modes && modes.view.invite && modes.join()) return;
    const s = party.onPlay(car);
    if (s && roster) roster.toast(`You're right behind ${s.name}!`, colourOf(net.room.car(s.id) || { id: s.id }).css);
  });
  if (roster) { roster.attach(menus); roster.setWorldHalf(world.half); }
  // menus.js saves the car a Drive takes out. This object is the one main.js
  // saves back (the steering keys, the settings screen), and it still holds
  // the car read at boot — so keep it in step, or the next save puts the old
  // car back on disk and the next visit starts in it.
  menus.on('drive', (p) => { if (p && p.id) { settings.car = p.id; settings.colour = p.colour | 0; } });
  // Handed to goals.update() every frame; one object, not one per frame.
  const goalsFrame = { driving: false, model: null };

  // ---- state --------------------------------------------------------------
  const MODES = ['chase', 'chaseFar', 'bonnet', 'bumper', 'orbit'];
  let cameraMode = 0;
  let mode = 'title';            // 'title' | 'garage' | 'driving' | 'paused' | 'map'
  let clockHours = settings.time != null ? settings.time : 9.5;
  let indicator = 0;             // -1 left, 0 off, 1 right
  let indicatorPhase = 0;
  // One reused object for the outgoing record — allocating this every frame
  // would produce garbage 20 times a second for the whole session.
  const wire = {
    id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0,
    yawRate: 0, steer: 0, wheelSpin: 0, integrity: 1, flags: 0, respawnSeq: 0,
  };
  let headlights = false;

  sky.setTime(clockHours);
  sky.setWeather(settings.weather || 'clear', 0);
  effects.setQuality(settings.post || 'medium');

  // ---- automatic quality ----
  // Steps the render resolution, then the post tier, down on a machine that
  // cannot hold 60 fps and back up when it can (src/core/adaptive.js). Never
  // above what the player picked, never the shadows or the draw distance.
  // The level it reaches is remembered, so a slow laptop starts the next
  // session where it left off instead of juddering for its first few seconds.
  // settings.autoQuality === false turns it off.
  const AUTO_KEY = 'openroad.autoquality.v1';
  const autoOn = () => settings.autoQuality !== false;
  let autoPost = settings.post || 'medium';
  const auto = createAdaptiveQuality({ post: autoPost, level: autoRemembered(autoPost) });
  if (effects.setGpuTiming) effects.setGpuTiming(autoOn());
  function autoRemembered(post) {
    try {
      const v = JSON.parse(localStorage.getItem(AUTO_KEY));
      return v && v.post === post && Number.isFinite(v.level) ? v.level : 0;
    } catch { return 0; }
  }
  function applyAuto(save) {
    const on = autoOn();
    const r = auto.rung;
    if (effects.setResolutionScale) effects.setResolutionScale(on ? r.scale : 1);
    effects.setQuality(on ? r.post : autoPost);
    if (save) {
      try { localStorage.setItem(AUTO_KEY, JSON.stringify({ post: autoPost, level: auto.level })); }
      catch { /* private browsing: it just forgets */ }
    }
  }
  terrain.setQuality(settings.quality || 'medium');
  city.setQuality(settings.quality || 'medium');
  props.setQuality(settings.quality || 'medium');
  matchFogToTerrain();
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
    const hadName = settings.name;
    Object.assign(settings, s);
    saveSettings(settings);
    applySettings();
    if (net) {
      if (settings.name !== hadName) net.rename(settings.name || suggestName());
      if (settings.multiplayer === false) net.disable();
      else net.enable();
    }
    if (tags) {
      tags.setShowTags(settings.nameTags !== false);
      tags.setShowArrows(settings.nameTags !== false);
    }
  });

  // While a menu text field has focus the keyboard belongs to it, not the car.
  // controls.js reads key state directly, so typing "Wade" would otherwise
  // steer and accelerate.
  menus.onTyping = (on) => {
    typing = on;
    if (on && controls.reset) controls.reset();
  };
  menus.on('resume', () => startDriving());
  menus.on('quit-to-title', () => { mode = 'title'; hud.setVisible(false); touch.setVisible(false); menus.show('title'); });
  menus.on('teleport', (p) => { if (p) { spawnOnRoad(p.x, p.z); startDriving(); } });

  function applySettings() {
    // A new post tier (or auto quality switched) is a new ladder, from the top.
    // Anything else — a new name, the weather — leaves the level alone, or a
    // kid renaming themselves would put a slow laptop back to juddering.
    const post = settings.post || 'medium';
    if (post !== autoPost || !autoOn()) { autoPost = post; auto.reset(post, 0); }
    if (effects.setGpuTiming) effects.setGpuTiming(autoOn());
    applyAuto(true);
    terrain.setQuality(settings.quality || 'medium');
    city.setQuality(settings.quality || 'medium');
    props.setQuality(settings.quality || 'medium');
    matchFogToTerrain();                 // the ring size changes with quality
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
    if (tags) tags.setSize(window.innerWidth, window.innerHeight);
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    effects.setSize(w, h);
  };
  // Dragging orbits the car while inspecting, and does nothing otherwise —
  // a driving game that grabs the pointer during play is a driving game you
  // cannot alt-tab out of.
  const onDown = (e) => {
    if (mode !== 'inspect') return;
    orbit.dragging = true; orbit.px = e.clientX; orbit.py = e.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!orbit.dragging || mode !== 'inspect') return;
    orbit.yaw -= (e.clientX - orbit.px) * 0.008;
    orbit.pitch = clampNum(orbit.pitch + (e.clientY - orbit.py) * 0.006, -0.25, 1.15);
    orbit.px = e.clientX; orbit.py = e.clientY;
  };
  const onUp = () => { orbit.dragging = false; };
  const onWheel = (e) => {
    if (mode !== 'inspect') return;
    e.preventDefault();
    orbit.dist = clampNum(orbit.dist * (1 + Math.sign(e.deltaY) * 0.12), 3.0, 22);
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

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
  // RENDER INTERPOLATION. The physics runs at a fixed 120 Hz and the car used
  // to be drawn wherever the last step left it, which judders at any frame
  // rate that is not a multiple of 60: a 144 Hz frame gets 1 step or 0, a
  // 45 fps frame 2 or 3. The pose before the last step is kept as well, and
  // the car, its wheels and the camera are drawn `alpha` of the way between
  // the two, alpha being the time the physics still owes as a fraction of a
  // step. Everything visual reads `pose`; physics, collisions, the network
  // and the HUD keep reading `car`. See src/core/interp.js.
  const carPose = createPoseBuffer();
  let pose = carPose.view;
  // Inspection orbit. Kept out of the camera-mode list because it is a game
  // STATE, not a view: the car is parked and the physics is idle while it runs.
  const orbit = { yaw: 0.7, pitch: 0.28, dist: 7.5, dragging: false, px: 0, py: 0 };
  const damageEvents = [];
  // Repair shops. Progress is deliberately not instant: pulling onto a
  // forecourt and waiting is a beat, and a car that snaps back to perfect the
  // moment a trigger fires reads as a cheat rather than as a repair.
  let repairIn = null, repairT = 0;
  const fxCars = [null];
  let driftState = drift.state;
  let inputOverride = null;
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
    const raw = dt;
    if (!(dt > 0)) dt = 0.016;
    // A tab that was in the background hands back a dt of several seconds.
    // Clamping is what stops the car teleporting across the city on return.
    dt = Math.min(dt, 0.1);
    stepFrame(dt);
    // Judged on the real interval between frames, and only while driving: the
    // menus draw over the world and cost differently, and a harness calling
    // frame() directly is not a frame rate at all.
    if (mode === 'driving' && autoOn() && auto.sample(raw * 1000, effects.gpuMs)) applyAuto(true);
  }

  // The R key's bookkeeping: a scratch road record and how long the car has
  // been off the road or stuck, for the one-time hint.
  const resetHint = { road: {}, offRoad: 0, stuck: 0 };
  const CAMERA_NAMES = {
    chase: 'Chase camera', chaseFar: 'Far chase camera', bonnet: 'Hood camera',
    bumper: 'Bumper camera', orbit: 'Orbit camera',
  };

  /**
   * One frame: input, physics, streaming, camera, render.
   *
   * Split out from the rAF callback so a harness can drive the game a frame at
   * a time with a fixed dt. Rendering by calling renderer.render() directly
   * instead shows a world where nothing has streamed and the sun has never been
   * positioned — which looks exactly like a broken renderer, and is not.
   */
  function stepFrame(dt) {
    fpsSmooth += (1 / Math.max(1e-3, dt) - fpsSmooth) * 0.05;

    // ---- input ----
    touch.read(touchState);
    const input = controls.update(dt, touch.isTouch ? touchState : null);
    // A focused text field owns the keyboard. Zeroing here rather than skipping
    // the physics keeps the car settling naturally instead of freezing mid-slide.
    if (typing) { input.throttle = 0; input.brake = 0; input.steer = 0; input.handbrake = 0; }
    // Mid-race, R goes back to the last gate, not the nearest road — which may
    // be one the race never uses, facing the wrong way. Taken here, ahead of
    // the plain reset below, so nothing in that block (placing, turning, its
    // toast) ever runs on top of a race respawn. The repairs match it.
    if (input.reset && mode === 'driving' && goals && goals.respawn()) {
      if (car.damage) car.damage.reset();
      drift.reset();
      input.reset = false;
    }

    if (input.pause && mode !== 'inspect') {
      if (mode === 'driving') { mode = 'paused'; menus.show('pause'); hud.setVisible(false); controls.reset(); }
      else if (mode === 'paused') startDriving();
    }
    if (input.map && mode === 'driving') { mode = 'paused'; menus.show('map'); controls.reset(); }
    // Steering feel, dialled from the seat. Guessing at this from a harness has
    // cost two rounds already; a key that changes it mid-corner settles it in
    // one. Persisted, so it survives a reload.
    if (input.steerDown || input.steerUp) {
      const step = input.steerUp ? 0.1 : -0.1;
      car.feel.steer = Math.max(0.5, Math.min(2.5, +(car.feel.steer + step).toFixed(2)));
      settings.steerFeel = car.feel.steer;
      saveSettings(settings);
      hud.toast(`Steering ${car.feel.steer.toFixed(1)}x  ( - / = to adjust )`, 1.6);
    }
    if (input.inspect) {
      if (mode === 'driving') {
        mode = 'inspect';
        orbit.yaw = car.yaw + 0.7; orbit.pitch = 0.28; orbit.dist = 7.5;
        controls.reset();
        hud.toast(damageSummary(), 6);
      } else if (mode === 'inspect') {
        startDriving();
      }
    }
    // Escape leaves inspection too, rather than opening the pause menu behind it.
    if (input.pause && mode === 'inspect') startDriving();
    if (input.camera) {
      cameraMode = (cameraMode + 1) % MODES.length;
      if (mode === 'driving') hud.toast(CAMERA_NAMES[MODES[cameraMode]] || '', 1.2);
    }
    if (input.reset && mode === 'driving') {
      // Back onto the nearest road, FACING THE WAY YOU WERE GOING. The road's
      // own direction is an accident of how it was drawn, so half of all resets
      // used to turn the car round and point it back where it had come from.
      // Flipping also moves it across to the lane for that direction.
      const wasYaw = car.yaw;
      spawnOnRoad(car.x, car.z);
      if (Math.cos(car.yaw - wasYaw) < 0) {
        const rd = ground.roadAt(car.x, car.z, resetHint.road);
        const across = rd && rd.width ? rd.width * 0.5 : 0;   // one lane over, both lanes' centres
        car.reset(car.x - Math.cos(car.yaw) * across, car.z + Math.sin(car.yaw) * across, car.yaw + Math.PI);
      }
      // Respawning repairs. Leaving a wreck wrecked after a reset strands the
      // player with no route back to a working car.
      if (car.damage) car.damage.reset();
      if (carDamage) carDamage.reset();
      damageFx.reset();
      drift.reset();
      resetHint.offRoad = 0; resetHint.stuck = 0;
      hud.toast('Back on the road', 1.6);
    }
    // The first time the car is plainly off the road, or going nowhere with the
    // throttle down, say how to get back. Once: tutorial() remembers. A kid in a
    // field with no idea R exists is a kid who closes the tab.
    if (mode === 'driving') {
      const here = ground.roadAt(car.x, car.z, resetHint.road);
      resetHint.offRoad = !here.onRoad && car.speed > 2 ? resetHint.offRoad + dt : 0;
      resetHint.stuck = car.speed < 1.5 && input.throttle > 0.5 ? resetHint.stuck + dt : 0;
      if (resetHint.offRoad > 2 || resetHint.stuck > 2.5) {
        tutorial('reset', touch.isTouch ? 'Off the road? Tap Road to get back on it'
          : 'Off the road? Press R to get back on it', 5);
      }
    }
    if (input.lights) headlights = !headlights;
    if (input.indLeft) indicator = indicator === -1 ? 0 : -1;
    if (input.indRight) indicator = indicator === 1 ? 0 : 1;
    if (input.horn) audio.playHorn();

    // ---- physics ----
    const driving = mode === 'driving';
    if (driving) {
      // An override lets a harness or a demo drive the car through the REAL
      // frame — physics, streaming, camera, effects and all. Setting car.input
      // directly does not work, because this line runs every frame and would
      // stamp the live controls straight back over it.
      const src = inputOverride || input;
      car.input.throttle = src.throttle || 0;
      car.input.brake = src.brake || 0;
      car.input.steer = src.steer || 0;
      car.input.handbrake = src.handbrake || 0;
      // A race countdown holds the car on the brakes, whatever is pressed.
      if (goals && goals.hold) { car.input.throttle = 0; car.input.brake = 1; }
    } else {
      car.input.throttle = 0; car.input.brake = 1; car.input.steer = 0; car.input.handbrake = 1;
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYS_DT && steps < MAX_SUBSTEPS) {
      carPose.capture(car);
      // The jump ramps exist in the ground only for the length of car.step():
      // preStep() puts them in, step() fires the lips and takes them out.
      if (goals) goals.preStep();
      car.step(PHYS_DT);
      if (goals) goals.step(PHYS_DT);
      if (collision) {
        const hit = collision.resolve(car, PHYS_DT);
        if (goals && hit.hit) goals.onCrash(hit.severity);
        if (hit.hit && hit.severity > 0.04) {
          audio.playCollision(hit.severity);
          // hit.n points out of the wall: the way the car was shoved.
          if (DAMAGE) particles.emitSparks(hit.x, car.y + 0.4, hit.z, hit.severity * 14, hit.nx, hit.nz);
          else impactCue(hit.x, hit.z, hit.severity, hit.nx, hit.nz);
        }
        if (hit.recovered) hud.toast('Recovered to the road', 2.5);
        if (hit.severity > 0.05 && drift.onCollision) drift.onCollision(hit.severity);
        if (hit.severity > 0.55) explode(hit.x, car.y + 0.5, hit.z, hit.severity);
      }

      // Traffic is solid too. Without this you drive straight through the one
      // thing sharing the road with you, which undoes the world faster than any
      // missing texture.
      const bump = carHits.resolve(car, traffic.cars, PHYS_DT, onTrafficHit);
      if (goals && bump.hit) goals.onCrash(bump.severity);
      if (bump.hit) {
        if (drift.onCollision) drift.onCollision(bump.severity);
        if (bump.severity > 0.05) {
          // bump.n points from the player TO the other car, so the shove is -n.
          if (DAMAGE) particles.emitSparks(bump.x, car.y + 0.45, bump.z, bump.severity * 16, bump.nx, bump.nz);
          else impactCue(bump.x, bump.z, bump.severity, -bump.nx, -bump.nz);
        }
        // A head-on at speed, or anything hard enough, goes up — with DAMAGE
        // on. Off, explode() returns at once.
        if (bump.closing > 21 || (bump.headOn && bump.closing > 15)) {
          explode(bump.x, car.y + 0.6, bump.z, Math.min(1, bump.closing / 30));
        }
      }
      accumulator -= PHYS_DT;
      steps++;
    }
    // Never let the debt spiral — but keep the fraction, or the blend below
    // jumps back to zero and the car twitches backwards.
    accumulator = settleAccumulator(accumulator, steps, MAX_SUBSTEPS, PHYS_DT);
    pose = carPose.blend(car, blendFactor(accumulator, PHYS_DT));

    // ---- time of day ----
    if (settings.timeFlow !== false && driving) {
      clockHours = (clockHours + dt * (settings.timeScale || 0.02)) % 24;
      sky.setTime(clockHours);
    }
    const night = sky.state ? sky.state.nightFactor : 0;
    city.setNight(night);
    props.setNight(night);

    // ---- damage ----
    // With DAMAGE off (physics/damage.js) car.damage is null and none of this
    // block runs: no fire, coolant or tyre toasts, no "press V to see the
    // damage", no garage prompts.
    //
    // drainEvents() EMPTIES the queue, so exactly one caller may use it. That
    // caller is here and everything else is handed the array. A second consumer
    // would silently starve the first, and the bug would present as "sometimes
    // the glass does not shatter".
    if (car.damage) {
      car.damage.drainEvents(damageEvents);
      if (damageEvents.length) {
        // Tell the player what just broke and what to do about it.
        //
        // Everything needed to deal with damage already existed — an
        // inspection camera on V, six repair shops, and the fact that speed
        // blows a small fire out — and none of it was discoverable. Asked
        // outright how to inspect the damage, the honest answer was that
        // nothing in the game says so. It says so now, once each, at the moment
        // it becomes relevant.
        for (let i = 0; i < damageEvents.length; i++) {
          const t = damageEvents[i].type;
          if (t === 'fire-start') {
            tutorial('fire', 'ENGINE FIRE — get your speed up to blow it out, or reach a garage', 6);
          } else if (t === 'coolant-leak') {
            tutorial('coolant', 'Coolant leaking. It will overheat and catch — ease off, or find a garage', 5);
          } else if (t === 'tyre-burst') {
            tutorial('tyre', 'Tyre blown. It will pull to that side until you get it repaired', 4);
          }
        }
        if (carDamage) carDamage.applyEvents(damageEvents);
        damageFx.applyEvents(damageEvents, car);
        if (audio.applyDamageEvents) audio.applyDamageEvents(damageEvents);
        for (let i = 0; i < damageEvents.length; i++) {
          const ev = damageEvents[i];
          if (ev.type === 'detach' && carModel) {
            // Thrown with the car's own velocity, so a bumper torn off at speed
            // cartwheels down the road instead of dropping straight down.
            // One object, not three loose numbers: the third parameter is the
            // whole velocity. Passing car.vx bound carVelocity to a Number, so
            // every component read back as 0 and the bumper dropped straight
            // down — the exact failure the line above claims to prevent.
            debris.spawnPart(ev.part, carModel.group, car);
          }
        }
      }
      if (carDamage) carDamage.update(car.damage.state, dt);

      // The first time the car is properly hurt, say how to look at it and
      // where to get it fixed.
      if (car.damage.integrity < 0.92) {
        tutorial('inspect', 'Press V to walk around the car and see the damage', 5);
        const ng = nearestGarage(car.x, car.z);
        if (ng) {
          tutorial('garage',
            `Repairs: ${ng.g.name}, ${(ng.dist / 1000).toFixed(1)} km away — it is marked on the map (M)`, 6);
        }
      }
    }
    pumpHints(dt);

    driftState = drift.update(dt, car) || drift.state;
    if (goals) {
      // Not driving while any menu is up, whatever `mode` says: the goals
      // overlay — and the medal card in it — must never show over a menu.
      goalsFrame.driving = driving && !menus.current;
      goalsFrame.model = carModel;
      goals.update(dt, goalsFrame);
      hudState.nav = goals.nav;
    }

    // ---- car visuals ----
    // From the interpolated pose, not the car: see carPose above.
    carRoot.position.set(pose.x, pose.y, pose.z);
    carRoot.rotation.set(0, pose.yaw, 0);
    // Pitch and roll are applied inside the yaw frame, which is what makes a car
    // lean INTO the camber rather than about the world axes.
    carRoot.rotateX(pose.pitch);
    carRoot.rotateZ(-pose.roll);
    if (carModel) {
      carModel.setSteer(pose.steer);
      carModel.setWheelSpin(pose.spin);
      for (let i = 0; i < 4; i++) suspension[i] = pose.comp[i];
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
    // Consume the shove a collision gave each traffic car. traffic.js steers
    // itself and knows nothing about being hit, so the knock is applied here
    // and decays — which is what lets a car be shoved bodily out of its lane
    // and then find its way back.
    const tl = traffic.cars || [];
    for (let i = 0; i < tl.length; i++) {
      const o = tl[i];
      if (!o || !o.kvx) continue;
      o.x += o.kvx * dt;
      o.z += o.kvz * dt;
      const decay = Math.exp(-2.6 * dt);
      o.kvx *= decay; o.kvz *= decay;
      if (Math.abs(o.kvx) + Math.abs(o.kvz) < 0.02) { o.kvx = 0; o.kvz = 0; }
    }

    traffic.update(dt, car.x, car.z, car.speed, car.yaw);
    if (boomCooldown > 0) boomCooldown -= dt;
    stepImpactCue(dt);
    if (boom) boom.update(dt);
    if (wreck) wreck.update(dt, car, carDamage);

    syncTrafficModels(night, dt);

    // ---- other drivers ----
    // The record is built here rather than handing `car` straight to the net
    // layer, because the wire format is a contract and the vehicle is not: the
    // day someone renames car.steerAngle, this line should break loudly rather
    // than start shipping undefined.
    if (net) {
      wire.x = car.x; wire.y = car.y; wire.z = car.z;
      wire.yaw = car.yaw; wire.pitch = car.pitch; wire.roll = car.roll;
      wire.vx = car.vx; wire.vz = car.vz; wire.yawRate = car.yawRate;
      wire.steer = car.spec.maxSteer ? car.steerAngle / car.spec.maxSteer : 0;
      wire.wheelSpin = car.wheels && car.wheels[0] ? car.wheels[0].spin : 0;
      wire.integrity = car.damage ? car.damage.integrity : 1;
      wire.flags =
        (input.brake > 0.02 || input.handbrake > 0.02 ? 1 : 0) |
        (indicator < 0 ? 2 : 0) | (indicator > 0 ? 4 : 0) |
        (input.handbrake > 0.02 ? 8 : 0) |
        (headlights || night > 0.35 ? 16 : 0) |
        (car.airborne ? 32 : 0) |
        (teleported ? 64 : 0);
      wire.respawnSeq = respawnSeq & 0xff;
      teleported = false;
      net.update(dt, wire);
      syncRemoteModels(night, dt);
      // Everything here that is fastened to YOUR car on screen — the guide's
      // chevrons start 10 m ahead of it, the list measures from it — reads
      // `pose`, where the car is drawn, not `car`, which runs up to a physics
      // step ahead: the chevrons snapped back 0.28 m every sixth frame.
      if (party) {
        const ev = party.update(dt, pose, goals ? goals.nav : null);
        if (ev) announceGuide(ev);
        // While guiding, the minimap's GPS line leads to the friend instead.
        if (party.nav && driving) hudState.nav = party.nav;
      }
      // Party games. The race line (or the coins) take over the minimap, and
      // while a game or a Guide leads, the challenge GPS stands down — a
      // party race holding its grid also holds the car, through goals.hold.
      const onRoad = mode === 'driving' && !menus.current;
      if (modes) {
        modes.update(dt, pose, onRoad);
        if (modes.nav && driving) hudState.nav = modes.nav;
        if (modesUi) modesUi.update(dt, onRoad, pose);
        if (modeFx) modeFx.update(dt, camera, modes, pose, net.room);
      }
      if (goals) goals.setExternalGuide(modes && modes.hold ? 'hold' : !!(modes && modes.owns) || !!(party && party.guide.id >= 0));
      if (beacons) {
        beacons.setVisible(settings.nameTags !== false);
        beacons.update(dt, camera, net.room.cars, colourOf,
          (modes && modes.raceGuide) || (party ? party.guide : null), driving, modes ? modes.view.it : -1);
      }
      if (roster) roster.update(dt, pose, mode);
    }
    debris.update(dt, camera.position);
    fxCars[0] = car;
    damageFx.update(dt, fxCars, camera.position);

    // ---- camera ----
    updateCamera(dt, driving);
    // Name tags and edge arrows go through THIS frame's camera, after it has
    // moved. Projected before it, through last frame's matrices, every tag
    // trailed its car by a frame and swam against it at speed.
    if (net && tags) {
      // Only on the road: over a menu they are clutter on top of its text.
      tags.setVisible(mode === 'driving');
      camera.updateMatrixWorld();
      tags.update(camera, net.room.cars, pose, colourOf, party ? party.guide.id : -1, modes, net.id);
    }

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
      hudState.damage = car.damage ? car.damage.state : null;
      hudState.damageEffects = car.damage ? car.damage.effects : null;
      hudState.drift = driftState;
      const ng2 = car.damage && car.damage.integrity < 0.97 ? nearestGarage(car.x, car.z) : null;
      hudState.garageName = ng2 ? ng2.g.name : '';
      hudState.garageDist = ng2 ? ng2.dist : 0;
      hudState.repairing = repairIn ? Math.min(1, repairT / 4) : 0;
      const road = ground.roadAt(car.x, car.z);
      hudState.speedLimit = road.onRoad ? road.speedLimit : 0;
      hudState.players = net ? net.room.cars : null;
      hud.update(hudState);
    }

    // The map screen draws a 'you are here' arrow; it no-ops when closed.
    if (menus.setPlayer) menus.setPlayer(car.x, car.z, car.yaw);

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
    audioState.damage = car.damage ? car.damage.state : null;
    audioState.damageEffects = car.damage ? car.damage.effects : null;
    audio.update(audioState, dt);

    // ---- render ----
    // A fraction of what this car can actually do, so the van feels fast at
    // its own limit rather than never triggering the effect at all.
    const vMax = Math.max(30, (car.spec.power / 700) ** 0.5 * 9);
    effects.setSpeedBlur(Math.min(1, Math.max(0, (car.speed / vMax - 0.35) / 0.65)));
    effects.render(dt);
  }

  // --- helpers used by the loop, defined here so they close over the world ---

  const skidCooldown = [0, 0, 0, 0];
  function emitTyreEffects(dt) {
    // Laid where the wheels are DRAWN (the interpolated pose), or a skid mark
    // starts up to a step ahead of the tyre that is supposed to be making it.
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
    const rx = Math.cos(pose.yaw), rz = -Math.sin(pose.yaw);
    const hw = car.spec.track / 2, hb = car.spec.wheelbase / 2;
    for (let i = 0; i < 4; i++) {
      const ox = i % 2 === 0 ? -hw : hw;
      const oz = i < 2 ? hb : -hb;
      const wx = pose.x + rx * ox + fx * oz;
      const wz = pose.z + rz * ox + fz * oz;
      const w = car.wheels[i];
      const surf = ground.SURFACES[w.surface];
      if (!surf) continue;

      const working = car.slipping > 0.12 || car.input.handbrake > 0.5;
      if (surf.dust > 0.1 && car.speed > 3) {
        // Dust is emitted from four wheels every frame, so the per-call amount
        // has to be small. At the first tuning it scaled with speed AND with
        // sliding AND ran at 240 emissions a second, which put the car inside
        // an opaque cloud the moment it reached a gravel road — you could not
        // see the thing you were steering. It should trail, not blind.
        //
        // Rear wheels throw far more than fronts, which is most of what makes
        // a dust plume read as a car rather than as fog.
        // Dust is the best thing about a gravel road, so it wants to be BIG —
        // it just must not sit on top of the car. The first version emitted
        // from four wheels every frame and scaled with speed and slide at once,
        // which put the player inside an opaque cloud; the correction went too
        // far the other way and there was barely a plume at all.
        //
        // What makes it read is a rooster tail from the REAR wheels that grows
        // hard when the car is sideways, thrown often enough to be continuous
        // but not so often it fills the frame.
        // A rooster tail, thrown mostly by the driven rear wheels and hugely
        // more when the car is sideways. This has been tuned three times: the
        // first version blinded the player, the correction left barely a wisp.
        // What it wants is VOLUME behind the car and clear air in front of it,
        // which is a matter of where it comes from and how fast it falls
        // behind — not of emitting less.
        const rear = i >= 2 ? 1 : 0.55;
        skidCooldown[i] -= dt;
        if (skidCooldown[i] <= 0) {
          const slide = working ? 4.8 : 1;
          // Spawn BEHIND the wheel, further back the faster you are going.
          //
          // Dust carries no velocity of its own — it hangs where it is made and
          // the car drives out of it. Made at the wheel it therefore billows
          // over the car before the car can leave, and the chase camera looks
          // straight into it: the plume was enormous and you could not see the
          // thing you were steering. Laying it down a couple of metres back
          // puts the whole cloud behind the rear bumper, where a rooster tail
          // belongs, and costs nothing in volume.
          const back = 1.1 + Math.min(car.speed, 32) * 0.075;
          particles.emitDust(wx - fx * back, pose.y - car.spec.rideHeight + 0.02, wz - fz * back,
            surf.dust * rear * (0.85 + Math.min(car.speed, 40) * 0.060) * slide,
            surf.colour);
          skidCooldown[i] = 0.013;
        }
      } else if (working && car.speed > 4) {
        particles.emitSmoke(wx, pose.y - car.spec.rideHeight + 0.05, wz, car.slipping * 2.4);
        skidCooldown[i] -= dt;
        if (skidCooldown[i] <= 0) {
          particles.addSkid(wx, pose.y - car.spec.rideHeight + 0.02, wz, pose.yaw, car.slipping);
          skidCooldown[i] = 0.02;
        }
      }
    }
    if (car.slipping > 0.3) audio.playSkid(car.slipping);
  }

  /** What is actually wrong with the car, in words. */
  function damageSummary() {
    // No damage model (DAMAGE off): V is just a good look at your car.
    if (!car.damage) return 'Looking round your car — drag or arrow keys to turn, scroll to zoom, V to drive';
    const d = car.damage.state;
    const bits = [];
    const lost = [];
    for (const k in d.attached) if (!d.attached[k]) lost.push(k);
    if (lost.length) bits.push(`lost ${lost.join(', ')}`);
    const gone = [];
    for (const k in d.glass) if (d.glass[k] >= 1) gone.push(k);
    if (gone.length) bits.push(`${gone.length} pane${gone.length > 1 ? 's' : ''} out`);
    const blown = d.blown.filter(Boolean).length;
    if (blown) bits.push(`${blown} tyre${blown > 1 ? 's' : ''} blown`);
    if (d.radiator < 0.7) bits.push('radiator holed');
    if (d.onFire > 0) bits.push('ON FIRE');
    else if (d.temp > 0.85) bits.push('overheating');
    if (d.engine < 0.6) bits.push(`engine ${Math.round(d.engine * 100)}%`);
    const head = `${Math.round(car.damage.integrity * 100)}% intact`;
    return bits.length ? `${head} — ${bits.join(', ')}` : `${head} — no damage`;
  }

  /**
   * Damage on the OTHER car.
   *
   * Traffic gets its own damage model, built on first contact rather than at
   * spawn: most traffic is never touched, and sixty unused models is sixty
   * models nobody looks at.
   */
  const npcEvents = [];
  function onTrafficHit(other, severity, lx, lz, closing) {
    // DAMAGE off: the struck car keeps only the shove and spin collision.js
    // already gave it, and drives on. No damage model, no speed cap, never
    // written off, never alight. Measured, 60 m/s head-on into a car doing
    // 16 m/s: it used to sit at speedCap 0, burning, for the full 10 s watched;
    // now it pulls away at its own pace and is back to 13.1 m/s 9 s later.
    if (!DAMAGE) return;
    if (!other.damage) other.damage = createDamage(other.spec || {});
    const hw = (other.spec ? other.spec.track : 1.6) * 0.5;
    const hl = other.halfLen != null ? other.halfLen : 2.2;
    other.damage.impact(severity, lx, lz, hw, hl, closing);
    // Show it. The damage state was already tracked here and then thrown away,
    // so traffic took damage nobody could see.
    npcEvents.length = 0;
    other.damage.drainEvents(npcEvents);
    const mi = other.id;
    // Tracked whether or not the renderer exists. Keying this off the visual
    // rig meant that with the car-damage layer unavailable — which it is
    // designed to be, layer() returns null rather than throwing — the respawn
    // reset below never fired for any slot, and every car in the pool
    // eventually came back from a recycle still carrying the last one's wreck.
    if (mi != null && trafficRespawn[mi] === undefined) trafficRespawn[mi] = other.respawnId;

    if (mi != null && trafficModels[mi] && trafficDamage[mi] === undefined && mCarDamage) {
      try {
        // EVERY flag is named explicitly, because detail:'low' is not a
        // quality hint — it is `wantX = opts.X ?? !low`, so it switches dents,
        // scuffs AND cavities off unless each is asked for by name. Omitting a
        // key does not mean "default"; it means off.
        //
        // Cavities matter because carving a panel away and opening the hole
        // behind it are two steps and only the second is optional: without
        // them a car that sheds its bonnet is carved through to nothing, and
        // the paint is FrontSide so there is not even a backface to stop the
        // eye. They are built lazily, only for a car that actually shed a
        // panel, so sixty untouched traffic cars pay nothing for them.
        trafficDamage[mi] = mCarDamage.createCarDamage(
          trafficModels[mi], other.spec || {},
          { detail: 'low', dents: true, scuffs: true, cavities: true });
      } catch (err) {
        console.error('[open road] traffic damage failed:', err);
        trafficDamage[mi] = null;
      }
    }
    if (trafficDamage[mi] && npcEvents.length) trafficDamage[mi].applyEvents(npcEvents);

    // A panel that comes off a traffic car should hit the road, not blink out.
    if (npcEvents.length && debris && trafficModels[mi]) {
      const tvx = -Math.sin(other.yaw) * other.speed;
      const tvz = -Math.cos(other.yaw) * other.speed;
      for (let i = 0; i < npcEvents.length; i++) {
        const ev = npcEvents[i];
        if (ev.type === 'detach') {
          debris.spawnPart(ev.part, trafficModels[mi].group, { x: tvx, y: 0, z: tvz });
        }
      }
    }

    // A badly hurt traffic car stops being traffic and starts being an
    // obstacle: it slows, limps, and if it is wrecked it stays where it is.
    //
    // Capped rather than assigned. onTrafficHit runs from inside the collision
    // solver's substep loop, and writing the velocity the solver just computed
    // undoes the separation that lets the contact resolve — the closing speed
    // never goes negative, so the next substep fires a second full impulse and
    // a second impact. A 30 m/s rear-end became six impulses in one frame.
    // A genuinely violent crash writes the car off, full stop. One impact()
    // call could only ever take a pristine car to about 0.75 no matter how fast
    // you hit it, so a head-on at 70 m/s closing left traffic driving away
    // FASTER than before, with a cap that never applied because 0.75 > 0.7.
    // Catastrophic means catastrophic: the structure is gone, not dented.
    if (closing > 24 && !other.written) {
      other.written = true;
      for (let k = 0; k < 5; k++) {
        other.damage.impact(1, lx * 0.6, lz * (k % 2 ? 0.8 : -0.8), hw, hl, closing);
      }
      other.damage.state.onFire = Math.max(other.damage.state.onFire, 0.7);
      other.damage.state.temp = 1;
      other.damage.drainEvents(npcEvents);
      if (trafficDamage[mi] && npcEvents.length) trafficDamage[mi].applyEvents(npcEvents);
    }

    const integ = other.damage.integrity;
    // A wreck STOPS. It does not limp away at walking pace with its roof off.
    if (other.written || integ < 0.3) { other.wrecked = true; other.speedCap = 0; }
    else if (integ < 0.55) { other.wrecked = true; other.speedCap = 2; }
    else if (integ < 0.75) other.speedCap = Math.min(other.speedCap ?? Infinity, 8);

    // Rising edge. This used to be a level test, so once a car was under the
    // threshold every subsequent substep of every subsequent contact detonated
    // it again — 135 explosions in 90 frames, measured.
    if ((other.written || integ < 0.3) && !other.exploded) {
      other.exploded = true;
      other.burning = 14 + Math.random() * 10;   // seconds it stays alight
      explode(other.x, other.y + 0.6, other.z, 0.9);
    }
  }

  /**
   * An explosion. Composed from the effects that already exist rather than a
   * new system: a flash of sparks thrown outward, a swelling ball of smoke,
   * and debris. Deliberately brief — a fireball that lingers reads as a bug.
   */
  // Collision resolution runs up to MAX_SUBSTEPS times per frame and every one
  // of those substeps can report a hit, so without a cooldown a single crash
  // detonates six times — which was survivable when this was a spark shower and
  // is not now that it is a fireball with a light on it.
  let boomCooldown = 0;
  function explode(x, y, z, power) {
    // DAMAGE off: nothing explodes, ever. The layers this drives were never
    // loaded, and the crash that called it has already had its impactCue().
    if (!DAMAGE) return;
    if (boomCooldown > 0) return;
    boomCooldown = 0.35;
    const p = Math.max(0.2, Math.min(1, power));
    // The fireball, the flash and the shockwave. Everything below is the
    // dressing around it — on its own the particle work reads as a scrape.
    if (boom) boom.fire(x, y + 0.35, z, p);

    particles.emitSparks(x, y, z, 150 * p, 0, 0);
    particles.emitSmoke(x, y + 0.3, z, 40 * p);
    particles.emitSmoke(x, y + 1.4, z, 34 * p);
    // A column, not a puff. Smoke that only ever appears at wheel height reads
    // as tyre smoke; a plume that climbs reads as something burning.
    particles.emitSmoke(x, y + 2.8, z, 22 * p);
    particles.emitSmoke(x, y + 4.4, z, 14 * p);

    // Sparks thrown outward in a full ring rather than a single puff, so the
    // blast has a direction wherever you happen to be standing.
    const arms = Math.max(6, Math.round(14 * p));
    for (let i = 0; i < arms; i++) {
      const a = (i / arms) * Math.PI * 2 + Math.random() * 0.4;
      const r = 1.1 + Math.random() * 1.6;
      particles.emitSparks(x + Math.cos(a) * r, y + 0.3 + Math.random() * 1.2, z + Math.sin(a) * r,
        30 * p, Math.cos(a), Math.sin(a));
    }
    // Dust kicked off the ground, which is what gives the blast a floor.
    if (particles.emitDust) particles.emitDust(x, y - 0.2, z, 30 * p, 0xb9a582);

    // Past this the crash is terminal and the aftermath takes over. The bar was
    // p > 0.7, but explode() itself only fires above 0.55, so there was a band
    // where the car detonated and then drove away undamaged — which is exactly
    // the "it blew up but nothing happened" case. An already-battered car goes
    // up on a smaller hit, because it should.
    const spent = car.damage ? car.damage.integrity : 1;
    if (wreck && (p > 0.6 || spent < 0.45)) wreck.ignite(car, carDamage, p);
    else hud.toast('Impact', 1.4);
  }

  /**
   * What a crash looks like with DAMAGE off: a bump.
   *
   * It still has to be FELT — a knock nobody can see reads as driving through a
   * ghost — but as a bump, not a disaster: a puff of pale dust where the car
   * touched, and a short nod of the camera, both scaled to the hit. No sparks:
   * the spark pool ramps white-hot to ember red, which is fire by another name,
   * and fire is what the kids asked to lose.
   *
   * (pushX, pushZ) is the way the car was shoved, a unit vector.
   */
  const cue = {
    touch: 1,       // s since the last contact impactCue() was told about
    last: 0,        // severity of the last full puff
    t: 1,           // s since the camera was knocked
    amp: 0,         // rad, that knock's size
    pitch: 0, roll: 0,
  };
  function impactCue(x, z, sev, pushX, pushZ) {
    // Collision runs at 120 Hz and a car held against a wall reports a hit on
    // every substep, so a whole puff is only for a fresh knock: the first
    // contact after a quarter of a second clear, or one clearly harder than the
    // last. Staying in contact gets a thin trickle metered in TIME, not per
    // substep: 6 billows a second for a brush, up to 30 for a full shove. It
    // was 0.3 + 2*sev per substep plus a whole puff every 0.18 s: in contact on
    // every substep that came to 153 billows a second at severity 0.3 and 384
    // at 1.0 (calmcheck), and a billow lives 1.1-2 s, so ~600 on screen.
    const fresh = cue.touch > 0.25 || sev > cue.last * 1.6;
    cue.touch = 0;
    // Pale concrete dust, dimmed at night: the billow shader is unlit, and a
    // full-bright puff in the dark reads as a flash of light.
    const night = sky.state ? sky.state.nightFactor || 0 : 0;
    const k = 1 - 0.7 * clampNum(night, 0, 1);
    const col = (((0xd8 * k) | 0) << 16) | (((0xd2 * k) | 0) << 8) | ((0xc6 * k) | 0);
    // Out from the surface into open air. A wall is drawn at its full lot size
    // but is solid at 94% of it (collision.js), so the contact point on a big
    // warehouse sits up to a metre INSIDE the rendered wall, and a puff made
    // there was depth-tested away completely.
    const ox = x + pushX * 0.9, oz = z + pushZ * 0.9;
    const y = ground.heightAt(ox, oz) + 0.35;
    if (!fresh) {
      particles.emitDust(ox, y, oz, (6 + 24 * clampNum(sev, 0, 1)) * PHYS_DT, col);
      return;
    }
    // 4 puffs for a brush, 24 for anything past 18 m/s into the surface
    // (severity saturates there), in three clouds: one at the contact and one
    // either side of the car, spread along the surface that was hit. From the
    // chase camera a head-on's contact point is hidden behind the car's own
    // body; a single cloud there was seen only as a glint through the glass.
    const n = 4 + 20 * sev;
    const tx = -pushZ, tz = pushX;
    const mid = (car.x - ox) * tx + (car.z - oz) * tz;    // the car's centre, along it
    const cx = ox + tx * mid, cz = oz + tz * mid;
    particles.emitDust(ox, y + 0.3, oz, n * 0.34, col);
    particles.emitDust(cx + tx * 1.6, y, cz + tz * 1.6, n * 0.33, col);
    particles.emitDust(cx - tx * 1.6, y, cz - tz * 1.6, n * 0.33, col);
    cue.last = sev;
    // The camera nods the way the car was shoved: forward into a wall, sideways
    // off a door. Amplitude 0.005 rad for a brush and 0.025 for the hardest hit,
    // and the nod peaks at 70% of that — about one degree at most, against the
    // landing thump's 0.012 — and is gone in a third of a second. A knock
    // already running is only replaced by a harder one.
    const amp = 0.005 + 0.020 * clampNum(sev, 0, 1);
    if (amp > cue.amp * Math.exp(-9 * cue.t)) {
      const along = pushX * -Math.sin(car.yaw) + pushZ * -Math.cos(car.yaw);
      const across = pushX * Math.cos(car.yaw) - pushZ * Math.sin(car.yaw);
      cue.t = 0;
      cue.amp = amp;
      cue.pitch = amp * along;
      cue.roll = amp * across * 0.7;
    }
  }
  function stepImpactCue(dt) {
    if (cue.touch < 1) cue.touch += dt;
    if (cue.t < 1) cue.t += dt;
  }

  /**
   * One-shot hints, queued so two never land on top of each other.
   *
   * A toast that replaces the previous toast half a second later is not a
   * tutorial, it is a flicker — and these fire in bursts, because a single
   * crash emits a coolant leak, a burst tyre and a detached bumper in the same
   * frame.
   */
  const hintsShown = new Set();
  const hintQueue = [];
  let hintTimer = 0;
  function tutorial(key, text, seconds) {
    if (hintsShown.has(key)) return;
    hintsShown.add(key);
    hintQueue.push({ text, seconds });
  }
  function pumpHints(dt) {
    hintTimer -= dt;
    if (hintTimer > 0 || !hintQueue.length) return;
    const h = hintQueue.shift();
    hud.toast(h.text, h.seconds);
    hintTimer = Math.min(h.seconds, 4.5);
  }

  /** Nearest repair shop, for the damage prompt and the HUD. */
  function nearestGarage(x, z) {
    let best = null, bd = Infinity;
    const list = world.garages || [];
    for (let i = 0; i < list.length; i++) {
      const g2 = list[i];
      const d = Math.hypot(g2.x - x, g2.z - z);
      if (d < bd) { bd = d; best = g2; }
    }
    return best ? { g: best, dist: bd } : null;
  }

  function districtAt(x, z) {
    let best = '', bd = Infinity;
    for (const d of world.districts) {
      // Biomes are listed as districts so the maps label them, but they are
      // regions, not places: world.biomes answers for them below.
      if (d.biome !== undefined) continue;
      const dist = Math.hypot(d.cx - x, d.cz - z);
      if (dist < d.r + 120 && dist < bd) { bd = dist; best = d.name; }
    }
    if (best) return best;
    for (const v of world.villages) {
      const dist = Math.hypot(v.x - x, v.z - z);
      if (dist < 320 && dist < bd) { bd = dist; best = v.name; }
    }
    // Which biome, with hysteresis (world/biomes.js track()): the name only
    // changes once the new country holds 62% of the ground, and crossing into
    // it says so once, in the middle of the screen, where a kid will see it.
    const bio = world.biomes;
    if (bio && bio.track) {
      const t = bio.track(x, z);
      if (t.entered) hud.toast(`Entering ${t.name}`, 2.6);
      return best || t.name;
    }
    return best || 'Open country';
  }

  // ---- the camera ---------------------------------------------------------
  // State for the chase camera, kept between frames on one object so the frame
  // path allocates nothing.
  const chase = {
    yaw: 0,                     // azimuth the camera sits behind
    spring: { x: 0, v: 0 },     // ...and its spring state: angle, rate
    wantYaw: 0,                 // the azimuth asked for last frame
    dist: 6, height: 2.2,       // smoothed framing
    baseY: 0,                   // car height with the suspension's bounce filtered out
    carY: 0,                    // the car height baseY was chasing last frame
    lookPrimed: false,          // camLookPrev holds last frame's look target
    shakeT: 0,
    live: false,                // false = snap next frame (first frame, respawn)
  };
  const camLookPrev = new THREE.Vector3();
  const hoodEye = new THREE.Vector3();
  const hoodAim = new THREE.Vector3();
  const carUp = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  /** Small smooth wobble, -1..1. Sines, not Math.random: noise at frame rate
   *  reads as a broken camera, a few hertz reads as a road. */
  function wobble(t, a, b) { return Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4; }

  /**
   * Rotation-only shake, after lookAt (which would overwrite it), so it can
   * never push the camera into the road or the car. Speed gives a whisper of
   * it on tarmac; unmade ground gives a lot — that and the drag in
   * vehicle.js are what make a field feel like a field.
   */
  function applyShake(dt, scale) {
    const v = car.speed;
    const surf = ground.SURFACES ? ground.SURFACES[car.surface] : null;
    const rough = surf ? surf.roughness : 0.03;
    const speedT = Math.min(1, v / 60);
    let amp = 0.0010 * speedT * speedT +
      (car.offroad * 0.0055 + rough * 0.0035) * Math.min(1, v / 14);
    // A landing is a single thump, not a rumble.
    const sinceLanding = car.time - car.landedAt;
    if (car.landedAt > 0 && sinceLanding < 0.35) amp += 0.012 * (1 - sinceLanding / 0.35);
    amp *= scale;
    chase.shakeT += dt * (5 + v * 0.35);
    if (amp > 1e-5) {
      camera.rotateX(wobble(chase.shakeT, 1.7, 3.1) * amp);
      camera.rotateZ(wobble(chase.shakeT, 2.3, 4.3) * amp * 0.6);
    }
    // Blast shake from a nearby explosion.
    if (boom && boom.shake > 0.001) {
      const k = boom.shake * boom.shake * 0.05;
      camera.rotateX((Math.random() * 2 - 1) * k);
      camera.rotateY((Math.random() * 2 - 1) * k);
      camera.rotateZ((Math.random() * 2 - 1) * k * 1.4);
    }
    // The bump from a crash (see impactCue): one damped nod at about 6 Hz, a
    // sine rather than noise so it reads as a knock and not a broken camera.
    if (cue.t < 0.5) {
      const w = Math.exp(-9 * cue.t) * Math.sin(40 * cue.t) * scale;
      camera.rotateX(cue.pitch * w);
      camera.rotateZ(cue.roll * w);
    }
  }

  /**
   * `target` is the vertical field of view for a landscape screen. three.js
   * fixes the VERTICAL angle, so a phone held upright (aspect ~0.46) was seeing
   * 30 degrees across — the car filled the width and sat behind the thumb
   * controls. Narrow screens get a taller angle, so the view across stays
   * something a driver can use.
   */
  function setFov(target, rate, dt) {
    const a = camera.aspect;
    const want = a < 1
      ? 2 * Math.atan(Math.tan(target * Math.PI / 360) / Math.pow(a, 0.6)) * 180 / Math.PI
      : target;
    camera.fov += (want - camera.fov) * Math.min(1, dt * rate);
    camera.updateProjectionMatrix();
  }

  function updateCamera(dt, driving) {
    const m = MODES[cameraMode];
    // Where the car is DRAWN, not where the physics has got to: a camera hung
    // off the simulated car shakes by the difference every frame.
    const p = pose;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    const v = car.speed;
    const speedT = Math.min(1, v / 55);

    if (mode === 'inspect') {
      // Orbit the car itself. Arrow keys work as well as the pointer, because
      // a laptop trackpad is a miserable way to study a dented wing.
      if (controls.state.steer) orbit.yaw -= controls.state.steer * dt * 1.6;
      if (controls.state.throttle) orbit.pitch = clampNum(orbit.pitch + dt * 0.9, -0.25, 1.15);
      if (controls.state.brake) orbit.pitch = clampNum(orbit.pitch - dt * 0.9, -0.25, 1.15);
      const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
      camWanted.set(
        p.x + Math.sin(orbit.yaw) * orbit.dist * cp,
        p.y + 0.55 + orbit.dist * sp,
        p.z + Math.cos(orbit.yaw) * orbit.dist * cp,
      );
      // Never underground, however far the player drags the camera down.
      const gy = ground.heightAt(camWanted.x, camWanted.z) + 0.45;
      if (camWanted.y < gy) camWanted.y = gy;
      camera.position.lerp(camWanted, 1 - Math.exp(-14 * dt));
      camLook.lerp(camTarget.set(p.x, p.y + 0.45, p.z), 1 - Math.exp(-14 * dt));
      camera.up.set(0, 1, 0);
      camera.lookAt(camLook);
      setFov(38, 5, dt);
      chase.live = false;
      return;
    }

    if (mode === 'title' || mode === 'garage' || !driving) {
      // A slow orbit of the car for the menus, so the front end is never a
      // static screenshot.
      const t = performance.now() * 0.00013;
      camWanted.set(p.x + Math.cos(t) * 11, p.y + 3.4, p.z + Math.sin(t) * 11);
      camLook.set(p.x, p.y + 0.7, p.z);
      camera.position.lerp(camWanted, 1 - Math.exp(-3 * dt));
      camera.up.set(0, 1, 0);
      camera.lookAt(camLook);
      setFov(58, 4, dt);
      chase.live = false;
      return;
    }

    if (m === 'bonnet' || m === 'bumper') {
      // Mounted ON the car, so it rides the car's own pitch and roll: the nose
      // dives under braking and the horizon leans in a corner, which is most of
      // what makes an in-car view feel fast. The horizon is only half-followed,
      // because a camera bolted rigidly to a body that rolls 7 degrees reads as
      // the world tilting, not the car.
      const h = m === 'bonnet' ? 1.14 : 0.62;
      const fwd = m === 'bonnet' ? 0.45 : 1.9;
      carRoot.updateMatrixWorld();
      hoodEye.set(0, h, -fwd);
      carRoot.localToWorld(hoodEye);
      hoodAim.set(0, h - 0.35, -fwd - 40);
      carRoot.localToWorld(hoodAim);
      carUp.set(0, 1, 0).transformDirection(carRoot.matrixWorld);
      camera.position.copy(hoodEye);
      camera.up.copy(carUp).lerp(WORLD_UP, 0.5).normalize();
      camera.lookAt(hoodAim);
      applyShake(dt, m === 'bumper' ? 1.6 : 1.1);
      setFov((m === 'bumper' ? 68 : 64) + speedT * speedT * 14, 3, dt);
      chase.live = false;
      return;
    }

    if (m === 'orbit') {
      const t = performance.now() * 0.0002;
      camWanted.set(p.x + Math.cos(t) * 14, p.y + 5.5, p.z + Math.sin(t) * 14);
      camera.position.lerp(camWanted, 1 - Math.exp(-2.4 * dt));
      camLook.set(p.x, p.y + 0.8, p.z);
      camera.up.set(0, 1, 0);
      camera.lookAt(camLook);
      setFov(60, 3, dt);
      chase.live = false;
      return;
    }

    // ---- chase ----
    // Lower and closer than it was (7.4 m back and 3.0 m up, a view of the
    // roof): close enough that the car fills the lower third and you can see
    // it lean and squat, low enough that the road ahead is the biggest thing
    // on the screen. Scaled by the car, so a pickup is not framed like a coupe.
    const far = m === 'chaseFar';
    const size = car.spec.wheelbase, tall = car.spec.rideHeight;
    // An upright phone also stands a little further back and higher, so the
    // car sits above the thumb controls rather than behind them.
    const upright = camera.aspect < 1 ? Math.pow(1 / camera.aspect, 0.3) : 1;
    const wantDist = ((far ? 9.0 : 4.7) + size * 0.62 + speedT * 1.4) * upright;
    const wantHigh = ((far ? 3.3 : 1.35) + tall * 1.6 + size * 0.08 + speedT * 0.25) * upright;
    const lookBack = controls.state.lookBack > 0;

    // Trails the HEADING, not the velocity: chasing the velocity swings the
    // view wildly the moment the car steps out, exactly when a stable horizon
    // matters. But a third of the body slip is let through, so in a slide the
    // camera eases round to show where the car is actually going.
    const slip = clampNum(car.bodySlip || 0, -0.6, 0.6);
    let wantYaw = p.yaw - slip * 0.35 + (lookBack ? Math.PI : 0);

    const jumped = Math.hypot(camera.position.x - p.x, camera.position.z - p.z) > 60;
    if (!chase.live || jumped) {
      // First frame, a respawn, or a camera mode change: cut, do not swing.
      chase.spring.x = wantYaw; chase.spring.v = 0; chase.wantYaw = wantYaw;
      chase.dist = wantDist; chase.height = wantHigh; chase.baseY = p.y; chase.carY = p.y;
      chase.lookPrimed = false;
      chase.live = true;
    }
    // A critically damped angular spring. It swings round the car instead of
    // cutting the corner through it, and lags just enough to show the turn.
    // Solved exactly for the frame rather than stepped (see core/interp.js):
    // the stepped version trailed a steady bend by 0.1734-0.1750 rad with dt
    // jittering between 1/144 and 1/40, so the whole view shook by the spread.
    const w = lookBack ? 18 : 6.5;
    springAngleStep(chase.spring, chase.wantYaw, wantYaw, w, dt);
    chase.wantYaw = wantYaw;
    chase.yaw = chase.spring.x;
    chase.dist += (wantDist - chase.dist) * (1 - Math.exp(-2.5 * dt));
    chase.height += (wantHigh - chase.height) * (1 - Math.exp(-2.5 * dt));
    // The suspension bounces the car at several hertz; the camera should not.
    chase.baseY = followLinear(chase.baseY, chase.carY, p.y, 7, dt);
    chase.carY = p.y;

    const bx = -Math.sin(chase.yaw), bz = -Math.cos(chase.yaw);
    camWanted.set(p.x - bx * chase.dist, chase.baseY + chase.height, p.z - bz * chase.dist);

    // Never inside the terrain — neither the camera itself nor the line from
    // it to the car. A chase camera on a hillside otherwise ends up looking at
    // the back of a slope, or from under it.
    const ground0 = ground.heightAt(camWanted.x, camWanted.z) + 0.55;
    if (camWanted.y < ground0) camWanted.y = ground0;
    const mx = (camWanted.x + p.x) * 0.5, mz = (camWanted.z + p.z) * 0.5;
    const my = (camWanted.y + p.y + 0.9) * 0.5;
    const groundMid = ground.heightAt(mx, mz) + 0.4;
    if (my < groundMid) camWanted.y += (groundMid - my) * 2;
    camera.position.copy(camWanted);

    // Look where the car is GOING to be. The path bends by a/v^2 per metre,
    // where a is the sideways acceleration, so a point d metres down it sits
    // a*d^2/(2v^2) to the side: aim there and the camera leads into a corner
    // rather than staring at the outside of it. Taken from the acceleration,
    // not the yaw rate: in a handbrake slide the body spins far faster than
    // the path bends, and leading by the yaw rate threw the car to the edge of
    // the frame. Capped at about 14 degrees of lead.
    const lookDist = clampNum(7 + v * 0.3, 7, 20) * (lookBack ? -1 : 1);
    const reach = Math.abs(lookDist) * 0.25;
    const bend = clampNum(car.latG * 9.81 * lookDist * lookDist / (2 * Math.max(36, v * v)), -reach, reach);
    camTarget.set(
      p.x + fx * lookDist + rx * bend,
      chase.baseY + 0.75 + tall * 0.6,
      p.z + fz * lookDist + rz * bend,
    );
    // Same lag as the old lerp, exact at any frame rate: that one trailed a
    // point moving at 45 m/s by 4.57-4.69 m as dt jittered, a 12 cm shake.
    // Primed on a cut with the target standing still, so the view still eases
    // from the menu orbit onto the road rather than snapping.
    if (!chase.lookPrimed) { camLookPrev.copy(camTarget); chase.lookPrimed = true; }
    camLook.set(
      followLinear(camLook.x, camLookPrev.x, camTarget.x, 9, dt),
      followLinear(camLook.y, camLookPrev.y, camTarget.y, 9, dt),
      followLinear(camLook.z, camLookPrev.z, camTarget.z, 9, dt));
    camLookPrev.copy(camTarget);
    camera.up.set(0, 1, 0);
    camera.lookAt(camLook);
    camera.rotateZ(-p.roll * 0.22);
    applyShake(dt, far ? 0.6 : 1);

    // Wider as the speed builds, and a little more under hard acceleration:
    // the cheapest honest way to make 150 km/h look like 150 km/h.
    const kick = clampNum(car.lonG, 0, 0.8) * 3;
    setFov(60 + 15 * speedT * speedT + kick, 2.5, dt);
  }

  // ---- prime the streaming layers -----------------------------------------
  // The first update() builds the whole visible ring, which is ~170 ms of work.
  // Called from inside the frame loop that lands as a visible stall on frame
  // one; called here it lands on the loading bar, where the player expects it.
  await stage(0.97, 'first look around', () => {
    camera.position.set(car.x, car.y + 6, car.z + 12);
    terrain.update(camera.position, 0);
    roads.update(camera.position, 0);
    city.update(camera.position, 0);
    props.update(camera.position, 0);
  });

  // ---- shaders, before anything needs them --------------------------------
  // A material's shader program is compiled the first time something using it
  // is drawn, and that compile stalls the frame. A cold 60 s drive across the
  // map compiled 20 programs mid-drive, the worst frame 172 ms. So everything
  // that exists at boot is compiled here, on the loading bar, instead — the
  // same drive now compiles 8 (goal markers built on demand, a few car parts)
  // and its worst frame is 37 ms:
  //  * the traffic pool's cars are built now rather than on the first frame
  //    (they are hidden until they spawn, but a hidden car's materials still
  //    compile — that is the point);
  //  * compileAsync() compiles every material in the scene, hidden or not, in
  //    parallel where the browser can, and waits until they are ready;
  //  * one frame through every post pass compiles those, and the shadow pass.
  // Capped at 8 s, so a driver that never reports ready cannot hold the game
  // on the loading screen.
  // Each step is caught on its own: a warm-up that fails costs a hitch later,
  // which is what happened before it existed, and must not cost the level
  // below or put "Running without" on the screen.
  await stage(0.985, 'warming up the paint shop', async () => {
    try { syncTrafficModels(0, 0); } catch (err) { console.warn('[open road] traffic warm-up:', err); }
    try {
      if (renderer.compileAsync) {
        await Promise.race([
          renderer.compileAsync(scene, camera),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      }
    } catch (err) { console.warn('[open road] shader warm-up:', err); }
    try { if (effects.prewarm) effects.prewarm(); } catch (err) { console.warn('[open road] post warm-up:', err); }
    // The remembered automatic-quality level goes on AFTER the warm-up, so the
    // passes a low level switches off were still compiled.
    applyAuto(false);
  });

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
    garages: world.garages,
    // Exposed so multiplayer can be inspected without a second machine: check
    // net.status, net.players and net.rtt from the console.
    get net() { return net; },
    get tags() { return tags; },
    get boom() { return boom; },
    get goals() { return goals; },
    /** The aftermath director. Named to avoid colliding with wreck() below. */
    get aftermath() { return wreck; },
    /** The crash switch (physics/damage.js), and the bump cue it leaves. */
    damage: DAMAGE,
    get impact() { return cue; },
    /** Set off a blast at the car, for looking at one without crashing. */
    detonate: (power = 1) => {
      if (!DAMAGE) return 'nothing explodes: DAMAGE is off (physics/damage.js)';
      boomCooldown = 0;
      explode(car.x, car.y + 0.4, car.z, power);
      return 'boom';
    },
    layers: { terrain, roads, city, props, particles, effects, sky, traffic, hud, menus, audio, touch,
              collision, debris, damageFx, drift, models, get carDamage() { return carDamage; } },
    /** Wreck the car on demand, for looking at damage without crashing first. */
    wreck: (n = 6, severity = 0.7) => {
      if (!car.damage) return null;          // DAMAGE off: there is nothing to wreck
      for (let i = 0; i < n; i++) {
        car.damage.impact(severity * (0.5 + Math.random() * 0.5),
          (Math.random() * 2 - 1) * car.spec.track * 0.5,
          (Math.random() * 2 - 1) * car.spec.wheelbase * 0.6,
          car.spec.track * 0.5, car.spec.wheelbase * 0.6, 20);
      }
      return car.damage.state;
    },
    /** Steering feel, 0.5..2.5. Same dial the - and = keys drive. */
    steerFeel: (v) => {
      if (v !== undefined) { car.feel.steer = Math.max(0.5, Math.min(2.5, v)); settings.steerFeel = car.feel.steer; saveSettings(settings); }
      return car.feel.steer;
    },
    /** Drive one real frame. Everything a rAF tick does, at a dt you choose. */
    frame: (dt = 1 / 60) => stepFrame(dt),
    setMode: (m) => {
      if (m === 'driving') { startDriving(); return; }
      if (m === 'inspect') {
        // Not a menu screen — a game state with its own camera. Showing a
        // screen called 'inspect' just hid the car behind nothing.
        mode = 'inspect';
        orbit.yaw = car.yaw + 0.7; orbit.pitch = 0.28; orbit.dist = 7.5;
        controls.reset();
        return;
      }
      mode = m; menus.show(m);
    },
    /** Aim the inspection camera from code. */
    setOrbit: (yaw, pitch, dist) => {
      if (yaw != null) orbit.yaw = yaw;
      if (pitch != null) orbit.pitch = clampNum(pitch, -0.25, 1.15);
      if (dist != null) orbit.dist = clampNum(dist, 3.0, 22);
    },
    /** Drive the car from code through the real frame. null hands it back. */
    setInput: (v) => { inputOverride = v; },
    /** Set the clock. Goes through clockHours, which the frame loop owns —
     *  calling sky.setTime() alone is overwritten on the very next frame. */
    setTime: (h) => { clockHours = h % 24; settings.time = clockHours; sky.setTime(clockHours); },
    setWeather: (w) => { settings.weather = w; sky.setWeather(w, 0); },
    fps: () => Math.round(fpsSmooth),
    /**
     * Where the player's car is DRAWN this frame: x, y, z, yaw, pitch, roll,
     * steer, spin. Anything fastened to the car on screen (a marker over it, a
     * glow under it) should follow this, not `car`, which is up to one physics
     * step ahead — 37 cm at 160 km/h, and it would slide against the car.
     */
    get pose() { return pose; },
    /** The automatic quality: where it is and why. force(n) pins a level for a look. */
    get autoQuality() {
      const r = auto.rung;
      return {
        on: autoOn(), level: auto.level, of: auto.levels, scale: r.scale, post: r.post,
        gpuMs: effects.gpuMs, ...auto.stats,
        force: (n) => { auto.force(n); applyAuto(false); return auto.level; },
      };
    },
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


// The numbers live in vehicle.js (aidsFor), shared with the harnesses, so the
// car the harnesses measure is the car the player gets. They used to be
// written out here a second time, and had drifted: TC 0.55 here against the
// vehicle's own default, and no notion that switching ESC off should relax TC.
function applyAssists(car, s) {
  car.setAssists(s);
}

boot().catch((err) => {
  console.error('[open road] fatal:', err);
  if (bootStatus) {
    bootStatus.dataset.error = '1';
    bootStatus.textContent = `Failed to start: ${err && err.message ? err.message : err}`;
  }
});
