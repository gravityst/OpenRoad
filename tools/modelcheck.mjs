// Proves the glTF pipeline is safe to leave switched on with no assets on disk.
//
// There are no .glb files in this repo and none can be fetched, so the ONLY
// path a player exercises today is the failure path. That makes this harness
// the thing standing between "imported cars are not wired up yet" and "the game
// white-screens because a loader that was never vendored threw on import". Two
// things are asserted above all else:
//
//   1. A missing asset, a missing loader, a corrupt file and an unrigged model
//      all end at null. None of them throw, and absence in particular is
//      SILENT — a game that logs a warning per traffic car per session for a
//      file nobody ever added is a game whose console nobody reads.
//   2. The rig convention is internally consistent. Every key damage.js
//      indexes has a node name, no node name is a prefix of another (which is
//      what makes tolerant matching unambiguous), and the object loadCar()
//      returns has the same shape as the one createCarModel() returns — because
//      main.js and the damage renderer are not allowed to tell them apart.
//
// The pipeline itself is driven through an INJECTED loader and fetch. The
// "files" really are fetched, really are handed to a parser, and really do come
// back as a scene graph; only the glTF binary decode is stubbed, since the
// decoder is the one piece that is not on disk. Everything downstream of it —
// name matching, facing, scale, datum, wheel pivots, materials, cloning — is
// the production code path.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createModelLibrary, RIG } from '../src/render/models.js';
import { createCarModel } from '../src/render/carModel.js';
import { GLASS, LIGHTS, DETACHABLE } from '../src/physics/damage.js';
import { specFor } from '../src/vehicles/catalog.js';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  if (!ok) fail++;
};

const SPEC = specFor('kaze');                       // 2.57 m wheelbase, 0.24 ride
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// A fake filesystem and a fake decoder.
//
// A "file" is a JSON description of a car. The stub loader turns it into a
// three.js scene named to the rig convention, which is exactly what GLTFLoader
// would hand back for a properly authored .glb.
// ---------------------------------------------------------------------------

const FILES = new Map();
let fetches = 0, parses = 0;

function writeFile(url, desc) {
  FILES.set(url, new TextEncoder().encode(JSON.stringify(desc)).buffer);
}

function fakeFetch(url) {
  fetches++;
  const buf = FILES.get(url);
  if (!buf) return Promise.resolve({ ok: false, status: 404 });
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(buf) });
}

const fakeLoader = {
  parse(buffer, path, onLoad, onError) {
    parses++;
    try {
      onLoad({ scene: buildScene(JSON.parse(new TextDecoder().decode(buffer))) });
    } catch (err) {
      onError(err);
    }
  },
};

/**
 * A car in the artist's own space: ground at y = 0, and — unless the
 * description says otherwise — facing -Z at real-world size.
 */
function buildScene(d) {
  const wb = d.wheelbase ?? 2.6;
  const tr = d.track ?? 1.55;
  const R = d.wheelRadius ?? 0.32;
  const k = d.unitScale ?? 1;                      // 100 == authored in cm
  // A model that faces +Z is the -Z one yawed by 180 degrees, which negates
  // both x and z. Doing it by negating positions keeps the boxes axis-aligned.
  const s = d.facing === '+Z' ? -1 : 1;
  const omit = new Set(d.omit || []);

  const scene = new THREE.Group();
  scene.name = d.rootName || 'Scene';

  const paint = new THREE.MeshStandardMaterial({ name: 'paint', color: 0x808080 });
  // Deliberately mislabelled colour spaces: a base colour tagged as data and a
  // normal map tagged as colour is the single most common export mistake, and
  // fixMaterials() is supposed to put both right.
  paint.map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  paint.map.colorSpace = THREE.NoColorSpace;
  paint.normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  paint.normalMap.colorSpace = THREE.SRGBColorSpace;

  const mats = { paint };
  const matFor = (name) => (mats[name] || (mats[name] = new THREE.MeshStandardMaterial({ name })));

  function part(name, w, h, dp, x, y, z, matName = 'paint') {
    if (omit.has(name)) return null;
    // `empties: true` names every node correctly but hangs no geometry off any
    // of them — an armature-only export, or one whose meshes never came across.
    const mesh = d.empties
      ? new THREE.Object3D()
      : new THREE.Mesh(new THREE.BoxGeometry(w * k, h * k, dp * k), matFor(matName));
    mesh.name = d.suffix ? `${name}${d.suffix}` : name;
    mesh.position.set(x * s * k, y * k, z * s * k);
    scene.add(mesh);
    return mesh;
  }

  const nose = -(wb * 0.5 + 0.75), tail = wb * 0.5 + 0.72;
  part('body', tr * 1.16, 1.30, wb + 1.47, 0, 0.75, 0);
  for (let i = 0; i < 4; i++) {
    const x = (i % 2 ? 0.5 : -0.5) * tr, z = (i < 2 ? -0.5 : 0.5) * wb;
    part(RIG.wheel[i], 0.22, R * 2, R * 2, x, R, z, 'rubber');
  }
  part(RIG.glass.windscreen, tr * 0.9, 0.5, 0.1, 0, 1.25, -0.35, 'glass');
  part(RIG.glass.rear, tr * 0.9, 0.45, 0.1, 0, 1.25, 0.72, 'glass');
  part(RIG.glass.sideL, 0.06, 0.4, 1.1, -tr * 0.52, 1.25, 0.15, 'glass');
  part(RIG.glass.sideR, 0.06, 0.4, 1.1, tr * 0.52, 1.25, 0.15, 'glass');
  part(RIG.light.headL, 0.3, 0.16, 0.12, -tr * 0.4, 0.78, nose + 0.05, 'lensHead');
  part(RIG.light.headR, 0.3, 0.16, 0.12, tr * 0.4, 0.78, nose + 0.05, 'lensHead');
  part(RIG.light.tailL, 0.3, 0.16, 0.12, -tr * 0.4, 0.88, tail - 0.05, 'lensTail');
  part(RIG.light.tailR, 0.3, 0.16, 0.12, tr * 0.4, 0.88, tail - 0.05, 'lensTail');
  part(RIG.optional.brakeL, 0.3, 0.06, 0.1, -tr * 0.4, 0.98, tail - 0.05, 'lensBrake');
  part(RIG.optional.brakeR, 0.3, 0.06, 0.1, tr * 0.4, 0.98, tail - 0.05, 'lensBrake');
  part(RIG.optional.reverseL, 0.12, 0.08, 0.1, -tr * 0.2, 0.82, tail - 0.05, 'lensRev');
  part(RIG.optional.reverseR, 0.12, 0.08, 0.1, tr * 0.2, 0.82, tail - 0.05, 'lensRev');
  part(RIG.optional.indL, 0.1, 0.1, 0.1, -tr * 0.56, 0.82, nose + 0.06, 'lensIndL');
  part(RIG.optional.indR, 0.1, 0.1, 0.1, tr * 0.56, 0.82, nose + 0.06, 'lensIndR');
  part(RIG.detach.mirrorL, 0.12, 0.1, 0.16, -tr * 0.62, 1.16, -0.28, 'trim');
  part(RIG.detach.mirrorR, 0.12, 0.1, 0.16, tr * 0.62, 1.16, -0.28, 'trim');
  part(RIG.detach.frontBumper, tr * 1.1, 0.3, 0.24, 0, 0.5, nose + 0.1);
  part(RIG.detach.rearBumper, tr * 1.1, 0.3, 0.24, 0, 0.5, tail - 0.1);
  part(RIG.detach.bonnet, tr * 0.98, 0.06, 0.9, 0, 1.02, -0.95);
  part(RIG.detach.boot, tr * 0.98, 0.06, 0.7, 0, 1.06, 1.02);
  part(RIG.detach.doorL, 0.06, 0.6, 1.05, -tr * 0.58, 0.85, 0.1);
  part(RIG.detach.doorR, 0.06, 0.6, 1.05, tr * 0.58, 0.85, 0.1);
  part(RIG.detach.exhaust, 0.09, 0.09, 0.3, -tr * 0.35, 0.3, tail - 0.02, 'trim');
  part(RIG.detach.spoiler, tr * 1.0, 0.05, 0.28, 0, 1.28, tail - 0.35);
  part(RIG.optional.seat, 0.02, 0.02, 0.02, -tr * 0.24, 1.05, 0.2, 'trim');
  return scene;
}

function newLibrary(extra = {}) {
  const warnings = [];
  const lib = createModelLibrary({
    loader: fakeLoader, fetch: fakeFetch,
    warn: (msg) => warnings.push(msg), ...extra,
  });
  return { lib, warnings };
}

const said = (warnings, needle) => warnings.filter((w) => w.includes(needle)).length;

// ---------------------------------------------------------------------------
// 1. The rig convention is self-consistent with the damage model
// ---------------------------------------------------------------------------
{
  const same = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  check('RIG.glass keys are exactly damage.js GLASS',
    same(Object.keys(RIG.glass), GLASS), Object.keys(RIG.glass).join(', '));
  check('RIG.light keys are exactly damage.js LIGHTS',
    same(Object.keys(RIG.light), LIGHTS), Object.keys(RIG.light).join(', '));
  check('RIG.detach keys are exactly damage.js DETACHABLE',
    same(Object.keys(RIG.detach), DETACHABLE), `${DETACHABLE.length} parts`);
  check('RIG.wheel is [FL, FR, RL, RR], the damage index order',
    RIG.wheel.length === 4 && RIG.wheel.every((n, i) => n.endsWith(['FL', 'FR', 'RL', 'RR'][i])),
    RIG.wheel.join(' '));
  check('the model faces -Z, like every other car in the game', RIG.facing === '-Z', RIG.facing);

  const names = RIG.names;
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check('every rig node name is unique', dupes.length === 0,
    dupes.length ? dupes.join(', ') : `${names.length} names`);

  // This is the property tolerant matching rests on. `boot_lid` may resolve to
  // `boot` precisely because no OTHER rig name starts with `boot`; the day one
  // does, a prefix match becomes a coin toss between two parts.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefixes = [];
  for (const a of names) {
    for (const b of names) {
      if (a !== b && norm(b).startsWith(norm(a))) prefixes.push(`${a} < ${b}`);
    }
  }
  check('no rig name is a prefix of another', prefixes.length === 0, prefixes.join(', '));

  check('RIG is frozen, so a car cannot rename the convention',
    Object.isFrozen(RIG) && Object.isFrozen(RIG.detach) && Object.isFrozen(RIG.wheel));

  // The convention only works if the page an artist reads says the same thing
  // as the constant the code matches against. A rig name renamed in one place
  // and not the other is silent: the model loads, and one part is just missing.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const docPath = join(ROOT, 'assets/cars/README.md');
  if (!existsSync(docPath)) {
    check('assets/cars/README.md exists', false, 'nobody can author to a convention nobody wrote down');
  } else {
    const doc = readFileSync(docPath, 'utf8');
    const undocumented = names.filter((n) => !doc.includes(n));
    check('every rig name is documented for artists', undocumented.length === 0,
      undocumented.length ? undocumented.join(', ') : `all ${names.length} in assets/cars/README.md`);
    check('the README states the facing convention',
      doc.includes(RIG.facing) && doc.includes(RIG.paintMaterial),
      `${RIG.facing}, material "${RIG.paintMaterial}"`);
  }
}

// ---------------------------------------------------------------------------
// 2. Every failure ends at null, and absence is silent
// ---------------------------------------------------------------------------
{
  const { lib, warnings } = newLibrary();
  const missing = await lib.loadCar('nothing', 'nothing.glb');
  check('an absent asset resolves to null', missing === null, 'loadCar -> null');
  check('an absent asset says nothing', warnings.length === 0,
    warnings.length ? warnings[0] : 'no warnings');
  check('an absent asset leaves has() false', lib.has('nothing') === false && lib.get('nothing') === null);
  check('the 404 really was fetched', fetches > 0, `${fetches} fetch(es)`);

  writeFile('assets/cars/broken.glb', 'not-a-car');
  FILES.set('assets/cars/broken.glb', new TextEncoder().encode('{{{').buffer);
  const broken = await lib.loadCar('broken', 'broken.glb');
  check('a corrupt file resolves to null', broken === null);
  check('a corrupt file DOES complain', said(warnings, 'broken.glb') === 1,
    warnings[warnings.length - 1] || '');

  lib.dispose();
}

// ---------------------------------------------------------------------------
// 3. No vendored loader is also just null
// ---------------------------------------------------------------------------
// vendor/three/addons/ has no loaders/ directory, so this exercises the real
// dynamic import failing for the real reason a player would hit.
{
  const { lib, warnings } = newLibrary({ loader: null, fetch: fakeFetch });
  writeFile('assets/cars/lark.glb', { wheelbase: 2.51 });
  const car = await lib.loadCar('lark');
  check('with no GLTFLoader on disk, loadCar is null', car === null);
  check('the missing loader is named once, not once per car',
    said(warnings, 'no glTF loader') === 1, warnings[0] ? warnings[0].slice(0, 76) : '');
  await lib.loadCar('kaze', 'kaze.glb');
  check('a second car does not repeat the loader warning',
    said(warnings, 'no glTF loader') === 1, `${warnings.length} warning(s) total`);
  lib.dispose();
}

// ---------------------------------------------------------------------------
// 4. The whole pipeline, end to end
// ---------------------------------------------------------------------------
const box = new THREE.Box3();
const vec = new THREE.Vector3();
const worldZ = (node) => box.setFromObject(node).getCenter(vec).z;

{
  const { lib, warnings } = newLibrary();
  // Authored in centimetres, five metres between the axles, facing the wrong
  // way, and missing a spoiler: everything wrong at once, on purpose.
  writeFile('assets/cars/messy.glb', {
    wheelbase: 5.0, track: 2.4, wheelRadius: 0.5, unitScale: 100,
    facing: '+Z', suffix: '.001', omit: [RIG.detach.spoiler],
  });
  const parsesBefore = parses;
  const car = await lib.loadCar('messy', 'messy.glb', SPEC, { colour: 0x123456 });
  check('a messy but rigged model loads', car !== null && !!car.group);
  if (!car) { console.log('\ncannot continue without a car'); process.exit(1); }

  // --- interface parity ---------------------------------------------------
  const proc = createCarModel(SPEC);
  const missingKeys = Object.keys(proc).filter((k) => typeof car[k] !== typeof proc[k]);
  check('loadCar matches createCarModel key for key', missingKeys.length === 0,
    missingKeys.length ? missingKeys.join(', ') : `${Object.keys(proc).length} keys`);
  const dimsA = Object.keys(proc.dims).sort().join(','), dimsB = Object.keys(car.dims).sort().join(',');
  check('dims carries the same fields', dimsA === dimsB, dimsB);
  proc.dispose();

  // --- facing, scale, datum ------------------------------------------------
  check('a +Z model is turned around',
    worldZ(car.rig.detach.frontBumper) < 0 && worldZ(car.rig.detach.rearBumper) > 0,
    `bumper z ${worldZ(car.rig.detach.frontBumper).toFixed(2)} / ${worldZ(car.rig.detach.rearBumper).toFixed(2)}`);
  check('turning it around was announced', said(warnings, 'faces +Z') === 1);
  check('centimetres and a 5 m wheelbase normalise to the spec',
    near(car.dims.wheelbase, SPEC.wheelbase, 0.01),
    `${car.dims.wheelbase.toFixed(3)} m vs spec ${SPEC.wheelbase.toFixed(2)} m`);
  box.setFromObject(car.group);
  check('the contact patches sit rideHeight below the origin',
    near(box.min.y, -SPEC.rideHeight, 0.01),
    `lowest y ${box.min.y.toFixed(3)}, rideHeight ${SPEC.rideHeight}`);
  check('the axle midpoint is the origin',
    near((car.wheels[0].position.z + car.wheels[2].position.z) * 0.5, 0, 0.01) &&
    near((car.wheels[0].position.x + car.wheels[1].position.x) * 0.5, 0, 0.01));

  // --- wheel pivots --------------------------------------------------------
  const [fl, fr, rl] = car.wheels;
  check('wheels[0] is front-left: -x, -z', fl.position.x < 0 && fl.position.z < 0,
    `(${fl.position.x.toFixed(2)}, ${fl.position.z.toFixed(2)})`);
  check('the pivots are one wheelbase apart',
    near(Math.abs(rl.position.z - fl.position.z), SPEC.wheelbase, 0.01),
    `${Math.abs(rl.position.z - fl.position.z).toFixed(3)} m`);
  check('the wheel node is centred on its own pivot',
    near(box.setFromObject(fl).getCenter(vec).distanceTo(fl.getWorldPosition(new THREE.Vector3())), 0, 1e-6));

  // --- the per-frame setters ----------------------------------------------
  car.setSteer(0.3);
  check('setSteer turns the fronts the right way, and only the fronts',
    near(fl.rotation.y, -0.3, 1e-9) && near(fr.rotation.y, -0.3, 1e-9) && rl.rotation.y === 0,
    'right-positive steer is a negative yaw');
  car.setWheelSpin(2);
  const scalarOk = car.wheels.every((w) => near(w.rotation.x, -2, 1e-9));
  car.setWheelSpin([1, 2, 3, 4]);
  const arrayOk = car.wheels.every((w, i) => near(w.rotation.x, -(i + 1), 1e-9));
  check('setWheelSpin takes a scalar or four', scalarOk && arrayOk);

  const rest = fl.position.y;
  car.setSuspension([0.02, 0, 0, 0]);
  const moved = near(fl.position.y, rest + 0.02, 1e-9);
  car.setSuspension([99, -99, 0, 0]);
  const capped = fl.position.y < rest + car.dims.wheelRadius &&
    fr.position.y > rest - car.dims.wheelRadius;
  car.setSuspension([0, 0, 0, 0]);
  check('setSuspension moves the wheel and is bounded', moved && capped,
    `rest ${rest.toFixed(3)} m, travel capped inside the arch`);

  const lamp = (key) => car.rig.node[key].material.emissiveIntensity;
  car.setHeadlights(true);
  check('headlights light, and the tails come on with them',
    lamp('lightHeadL') > 2 && lamp('lightTailL') > 0.3,
    `head ${lamp('lightHeadL')}, tail ${lamp('lightTailL')}`);
  car.setBrakeLights(1);
  check('braking lights the brake lamps hardest',
    lamp('brakeL') > lamp('lightTailL') && lamp('lightTailL') > 0.4,
    `brake ${lamp('brakeL')}, tail ${lamp('lightTailL')}`);
  car.setBrakeLights(0);
  car.setHeadlights(false);
  check('everything goes out again', lamp('lightHeadL') === 0 && lamp('lightTailL') === 0 && lamp('brakeL') === 0);
  car.setReverseLights(true);
  check('reverse lights light', lamp('reverseL') > 2);
  car.setIndicator(2, true);
  const hazard = lamp('indL') > 2 && lamp('indR') > 2;
  car.setIndicator(-1, true);
  const leftOnly = lamp('indL') > 2 && lamp('indR') === 0;
  car.setIndicator(0, true);
  check('indicators do left, right and hazard',
    hazard && leftOnly && lamp('indL') === 0 && lamp('indR') === 0);

  // --- materials -----------------------------------------------------------
  const paintMat = car.rig.body.material;
  check('the requested colour was painted on', paintMat.color.getHex() === 0x123456,
    `#${paintMat.color.getHexString()}`);
  check('a base colour map is put back into sRGB',
    paintMat.map.colorSpace === THREE.SRGBColorSpace, paintMat.map.colorSpace);
  check('a normal map is put back into linear',
    paintMat.normalMap.colorSpace === THREE.NoColorSpace, paintMat.normalMap.colorSpace);
  check('glass and lamp lenses cast no shadow',
    car.rig.glass.windscreen.castShadow === false && car.rig.node.lightHeadL.castShadow === false &&
    car.rig.body.castShadow === true);

  // --- the missing part ----------------------------------------------------
  check('a missing node is null rather than an exception', car.rig.detach.spoiler === null);
  check('the missing node was named, once', said(warnings, RIG.detach.spoiler) === 1,
    (warnings.find((w) => w.includes(RIG.detach.spoiler)) || '').slice(0, 76));
  check('exporter suffixes still match (wheel_FL.001)', car.rig.node.wheelFL !== null);

  // --- two cars from one file ---------------------------------------------
  const asset = lib.get('messy');
  const twin = asset.create(SPEC, { colour: 0xff0000 });
  check('get(id).create builds another car without another parse',
    twin !== null && parses - parsesBefore === 1, `${parses - parsesBefore} parse(s)`);
  check('two cars do not share paint',
    twin.rig.body.material.color.getHex() === 0xff0000 && paintMat.color.getHex() === 0x123456);
  twin.setHeadlights(true);
  check('two cars do not share lamps',
    twin.rig.node.lightHeadL.material.emissiveIntensity > 2 && lamp('lightHeadL') === 0);
  check('but they DO share geometry', twin.rig.body.geometry === car.rig.body.geometry);

  await lib.loadCar('messy2', 'messy.glb', SPEC);
  check('the same url is never loaded twice', parses - parsesBefore === 1,
    `${fetches} fetches total, ${parses} parses total`);

  twin.dispose();
  car.dispose();
  car.dispose();
  check('dispose is idempotent and detaches the car', car.group.parent === null);
  lib.dispose();
}

// ---------------------------------------------------------------------------
// 5. A model with no rig at all is refused, so the procedural car wins
// ---------------------------------------------------------------------------
{
  const { lib, warnings } = newLibrary();
  writeFile('assets/cars/blob.glb', { rootName: 'Blob', omit: [RIG.body, ...RIG.wheel] });
  const car = await lib.loadCar('blob', 'blob.glb', SPEC);
  check('an unrigged model is refused', car === null);
  check('and it says exactly why', said(warnings, 'assets/cars/README.md') > 0,
    (warnings[0] || '').slice(0, 76));

  // A correctly NAMED rig with no geometry under it measures as an empty Box3,
  // and an empty Box3 has min +Infinity. Left alone that becomes a NaN chassis
  // position and a dims of +/-Infinity, which reaches the camera rig and the
  // HUD — far worse than a car that simply does not appear.
  writeFile('assets/cars/ghost.glb', { empties: true });
  const ghost = await lib.loadCar('ghost', 'ghost.glb', SPEC);
  check('a named rig with no geometry is refused too', ghost === null,
    'an empty Box3 would otherwise become a NaN chassis position');
  check('and nothing infinite escaped', lib.get('ghost') === null && lib.has('ghost') === false);
  lib.dispose();
}

// ---------------------------------------------------------------------------
// 6. preload, and a car with no wheels but a body
// ---------------------------------------------------------------------------
{
  const { lib, warnings } = newLibrary();
  writeFile('assets/cars/solid.glb', { omit: RIG.wheel.slice() });
  writeFile('assets/cars/good.glb', { wheelbase: 2.6 });
  const summary = await lib.preload([
    { id: 'good', url: 'good.glb', spec: SPEC },
    { id: 'solid', url: 'solid.glb', spec: SPEC },
    'absent.glb',
  ]);
  check('preload reports what it got', summary.total === 3 && summary.loaded === 2 && summary.missing === 1,
    JSON.stringify(summary));
  check('preload registers ids', lib.has('good') && lib.has('solid') === true);

  const solid = lib.get('solid').create(SPEC);
  check('a body with no wheel nodes still drives', solid !== null && solid.wheels.length === 4);
  solid.setSteer(0.2);
  solid.setSuspension([0.01, 0, 0, 0]);
  solid.setWheelSpin(1);
  check('and its empty pivots take input without throwing',
    near(solid.wheels[0].rotation.y, -0.2, 1e-9));
  check('a wheel-less model warns about the guessed scale',
    said(warnings, 'guessed from overall length') === 1);
  solid.dispose();

  // One .glb is one car. Handing the same file to a car of a different size
  // silently reuses a body scaled for the first one, which is the kind of bug
  // that gets blamed on the artist, so it is called out.
  await lib.load('good.glb', specFor('bastion'));
  check('reusing one file for a differently sized car is called out',
    said(warnings, 'give the second car its own file') === 1,
    (warnings.find((w) => w.includes('own file')) || '').slice(0, 76));
  lib.dispose();
}

console.log(`\n${fail ? `${fail} check(s) failed` : 'The glTF pipeline is safe with or without assets.'}`);
process.exit(fail ? 1 : 0);
