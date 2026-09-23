// Proves the procedural cars are still cars the rest of the game can use.
//
// render/carModel.js builds one merged mesh per material, and
// render/carDamage.js takes those meshes apart again GEOMETRICALLY — by
// connected component, by which side of the car a piece is on, by how high the
// side glass sits. Nothing names a windscreen or a door; the damage renderer
// infers them. That makes the two files a contract enforced by nothing but
// geometry, and a body that looks better can silently stop coming apart: a
// windscreen welded to a side window, a mirror stalk left hanging off the
// door, a boot lid measured so far forward that losing it takes the roof.
//
// So this drives the REAL damage renderer against every car in the catalogue,
// at both detail levels, and checks what actually happened to the meshes:
//
//   1. The public interface is exactly what main.js, the traffic pool,
//      models.js and the damage renderer were written against.
//   2. Every pane, lamp, mirror, bumper, plate and tailpipe splits out as its
//      own part and responds when that part is broken or lost.
//   3. Carving the bonnet, boot and doors removes paint from the right place
//      and only there — never the roof, never the other side of the car.
//   4. Dents stay finite and bounded.
//   5. Wheels steer, spin and ride the suspension the right way; calipers
//      steer but do not spin; the contact shadow leaves the ground with the
//      car; the level of detail switch hides only cosmetic meshes.
//   6. The per-car budget: triangles and draw calls, player and traffic.
//
// Headless, so it cannot see the paint. What to LOOK at is listed at the end.
import * as THREE from 'three';
import { createCarModel, BODY_STYLES, prewarmCarModels } from '../src/render/carModel.js';
import { createCarDamage } from '../src/render/carDamage.js';
import { CARS, specFor } from '../src/vehicles/catalog.js';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)} ${detail}`);
  if (!ok) fail++;
};

const API = ['group', 'wheels', 'triangles', 'setSteer', 'setWheelSpin', 'setSuspension',
  'setBrakeLights', 'setHeadlights', 'setReverseLights', 'setIndicator', 'setPaint', 'dispose', 'dims'];
const DIMS = ['length', 'width', 'height', 'wheelbase', 'track', 'wheelRadius', 'front', 'rear', 'seat'];

const chassisOf = (m) => m.group.children.find((c) => c.isGroup && c.children.some((k) => k.name === 'paint'));
const byName = (m, name) => chassisOf(m).children.find((k) => k.name === name) || null;

/** Visible triangle count of a mesh, honouring a carved draw range. */
function liveTris(mesh) {
  const g = mesh.geometry;
  const n = Math.min(g.drawRange.count, g.index.count);
  return n / 3;
}

/** Centroids of the triangles a carve removed, by diffing index buffers. */
function removedCentroids(before, mesh) {
  const g = mesh.geometry, p = g.attributes.position.array;
  const after = new Set();
  const idx = g.index.array, n = Math.min(g.drawRange.count, idx.length);
  for (let t = 0; t < n; t += 3) after.add(`${idx[t]},${idx[t + 1]},${idx[t + 2]}`);
  const out = [];
  for (let t = 0; t < before.length; t += 3) {
    if (after.has(`${before[t]},${before[t + 1]},${before[t + 2]}`)) continue;
    const a = before[t] * 3, b = before[t + 1] * 3, c = before[t + 2] * 3;
    out.push([(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The interface
// ---------------------------------------------------------------------------
{
  const m = createCarModel(specFor('v340'));
  const keys = Object.keys(m).sort();
  check('createCarModel returns exactly the documented interface',
    keys.join(',') === API.slice().sort().join(','), keys.join(', '));
  check('dims carries every documented field',
    DIMS.every((k) => k in m.dims) && Object.keys(m.dims).length === DIMS.length, Object.keys(m.dims).join(', '));
  check('four wheels in FL, FR, RL, RR order',
    m.wheels.map((w) => w.name).join() === 'FL,FR,RL,RR' &&
    m.wheels[0].position.x < 0 && m.wheels[0].position.z < 0 && m.wheels[3].position.x > 0 && m.wheels[3].position.z > 0);
  check('the chassis is a Group holding the named body meshes', !!chassisOf(m));
  check('physics/debris.js can size and colour a torn-off panel',
    m.group.userData.dims === m.dims && typeof m.group.userData.paint === 'number');
  check('BODY_STYLES still lists the seven styles', BODY_STYLES.length === 7, BODY_STYLES.join(' '));

  // Prewarming builds each model once, and a car made afterwards reuses it.
  const specs = CARS.map((c) => specFor(c.id));
  const first = prewarmCarModels(specs);
  const again = prewarmCarModels(specs);
  const a = createCarModel(specFor('lark')), b = createCarModel(specFor('lark'));
  const shared = byName(a, 'paint').geometry === byName(b, 'paint').geometry;
  a.dispose(); b.dispose();
  // The v340 made above is still alive, so its geometry is already cached.
  check('prewarmCarModels builds each model once, and cars reuse it', first === CARS.length - 1 && again === 0 && shared,
    `${first} built (+1 already cached), then ${again}; two cars share one paint buffer`);
  m.dispose();
}

// ---------------------------------------------------------------------------
// 2-4. Every car in the catalogue, both detail levels, taken apart for real
// ---------------------------------------------------------------------------
const budget = [];
const problems = {};
const note = (key, msg) => { (problems[key] = problems[key] || []).push(msg); };

for (const detail of ['high', 'low']) {
  for (const c of CARS) {
    const spec = specFor(c.id);
    const tag = `${detail}:${c.id}`;
    const m = createCarModel(spec, { detail });
    const hw = m.dims.width * 0.5, wr = spec.wheelRadius;
    const chassis = chassisOf(m);

    // --- the buckets the damage renderer looks for, all indexed ---
    const want = detail === 'high'
      ? ['paint', 'glass', 'glassDark', 'chrome', 'plastic', 'plate', 'lHead', 'lTail', 'lBrake', 'lRev', 'lIndL', 'lIndR']
      : ['paint', 'glass', 'plastic', 'lHead', 'lTail', 'lIndL', 'lIndR'];
    const missing = want.filter((n) => !byName(m, n) || !byName(m, n).geometry.index);
    if (missing.length) note(tag, `missing or unindexed: ${missing.join(', ')}`);

    // --- finite, unit normals everywhere ---
    let bad = 0;
    m.group.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position.array, n = o.geometry.attributes.normal.array;
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { bad++; break; }
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
        if (!(Math.abs(l - 1) < 0.02)) { bad++; break; }
      }
    });
    if (bad) note(tag, `${bad} mesh(es) with non-finite positions or non-unit normals`);

    // --- the body fits its own dims ---
    const box = new THREE.Box3().setFromObject(byName(m, 'paint'));
    const lenOk = Math.abs(box.min.z - m.dims.front) < 0.05 && Math.abs(box.max.z - m.dims.rear) < 0.05;
    const hOk = Math.abs(box.max.y - (m.dims.height - spec.rideHeight)) < 0.06;
    if (!lenOk || !hOk) note(tag, `paint spans z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)} (dims ${m.dims.front.toFixed(2)}..${m.dims.rear.toFixed(2)}), top ${box.max.y.toFixed(2)} vs roof ${(m.dims.height - spec.rideHeight).toFixed(2)}`);

    // --- budget ---
    let calls = 0, shadowCasters = 0;
    m.group.traverseVisible((o) => { if (o.isMesh) { calls++; if (o.castShadow) shadowCasters++; } });
    budget.push({ detail, id: c.id, body: spec.body, tris: m.triangles, calls, shadowCasters });

    // --- now break it ------------------------------------------------------
    const rig = createCarDamage(m, spec, detail === 'low'
      ? { detail: 'low', dents: true, scuffs: true, cavities: true } : {});
    const paint = byName(m, 'paint');

    // Glass: every pane must come out on its own and take the damage material.
    // A bucket holding a single pane (the backlight in glassDark) is adopted
    // whole rather than split — that is carDamage's design, not a failure.
    const panes = ['windscreen', 'rear', 'sideL', 'sideR'];
    const glassMesh = byName(m, 'glass'), darkMesh = byName(m, 'glassDark');
    const clean = new Set([glassMesh && glassMesh.material, darkMesh && darkMesh.material].filter(Boolean));
    const paneMesh = (g) => chassis.children.find((k) => k.name === `glass:${g}` || k.name === `glassDark:${g}`) ||
      (g === 'rear' && darkMesh && !chassis.children.some((k) => k.name.startsWith('glassDark:')) ? darkMesh : null);
    rig.applyEvents(panes.map((g) => ({ type: 'glass-crack', glass: g })));
    for (const g of panes) {
      const split = paneMesh(g);
      if (!split) { note(tag, `no ${g} pane split out`); continue; }
      if (clean.has(split.material)) note(tag, `${g} did not craze`);
      const b = new THREE.Box3().setFromObject(split);
      // A side window lives on its own side; a screen spans the middle.
      if (g === 'sideL' && !(b.max.x < 0)) note(tag, `sideL pane crosses to x ${b.max.x.toFixed(2)}`);
      if (g === 'sideR' && !(b.min.x > 0)) note(tag, `sideR pane crosses to x ${b.min.x.toFixed(2)}`);
      if ((g === 'windscreen' || g === 'rear') && !(b.min.x < -hw * 0.3 && b.max.x > hw * 0.3)) note(tag, `${g} does not span the car`);
      if (g === 'windscreen' && !(b.max.z < 0.5 * (m.dims.front + m.dims.rear) + 0.6)) note(tag, 'windscreen is behind the middle of the car');
      if (g === 'rear' && !(b.min.z > box.min.z + m.dims.length * 0.45)) note(tag, 'rear screen is in the front half');
    }
    const ws = paneMesh('windscreen');
    const crazed = ws && ws.material;
    rig.applyEvents([{ type: 'glass-shatter', glass: 'windscreen' }]);
    if (ws && ws.material === crazed) note(tag, 'windscreen did not shatter');

    // Lamps: four tracked lamps, each its own part, going dark when smashed —
    // which carDamage does by handing the piece a different material.
    const lampMats = new Set(['lHead', 'lTail', 'lBrake', 'lRev', 'lIndL', 'lIndR'].map((n) => byName(m, n)).filter(Boolean).map((k) => k.material));
    for (const l of ['headL', 'headR', 'tailL', 'tailR']) {
      rig.applyEvents([{ type: 'light-smash', light: l }]);
      const parts = chassis.children.filter((k) => k.name.endsWith(`:${l}`));
      if (!parts.length) { note(tag, `no ${l} lamp split out`); continue; }
      if (parts.some((k) => lampMats.has(k.material))) note(tag, `${l} still wears a working lamp material after the smash`);
      const bx = new THREE.Box3();
      for (const k of parts) bx.expandByObject(k);
      const front = l.startsWith('head'), left = l.endsWith('L');
      if (front !== (bx.max.z < 0) && front !== (bx.min.z < 0)) note(tag, `${l} is at the wrong end`);
      if (left !== (bx.max.x < 0)) note(tag, `${l} is on the wrong side`);
    }

    // Detachable parts that exist as geometry.
    const wantParts = detail === 'high'
      ? ['mirrorL', 'mirrorR', 'frontBumper', 'rearBumper', 'exhaust']
      : ['mirrorL', 'mirrorR', 'frontBumper', 'rearBumper'];
    for (const part of wantParts) {
      rig.applyEvents([{ type: 'detach', part }]);
      const pieces = chassis.children.filter((k) => k.name.endsWith(`:${part}`));
      if (!pieces.length) { note(tag, `no ${part} geometry to detach`); continue; }
      if (pieces.some((k) => k.visible)) note(tag, `${part} still visible after it came off`);
      const bx = new THREE.Box3();
      for (const k of pieces) bx.expandByObject(k);
      const size = bx.getSize(new THREE.Vector3());
      if (part.startsWith('mirror')) {
        // A mirror is small, outboard and near the A-pillar. Anything bigger
        // means another plastic part (a B-pillar, a sill) was taken for one.
        if (size.x > 0.45 || size.y > 0.35 || size.z > 0.45) note(tag, `${part} grabbed too much: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m`);
        if ((part === 'mirrorL') !== (bx.max.x < 0)) note(tag, `${part} on the wrong side`);
      }
      // A bumper, with the lamp bezels and intakes that leave with it, lives
      // ahead of the front tyre (behind the rear one). Wrap-round lamps reach
      // a long way back round the corners; the axle line is the real limit —
      // a vertex past it is a projection that missed the body.
      if (part === 'frontBumper' && !(bx.max.z < m.wheels[0].position.z - wr)) note(tag, `front bumper parts reach back to z ${bx.max.z.toFixed(2)}, past the front tyre`);
      if (part === 'rearBumper' && !(bx.min.z > m.wheels[2].position.z + wr)) note(tag, `rear bumper parts reach forward to z ${bx.min.z.toFixed(2)}, past the rear tyre`);
      if (part === 'exhaust' && size.y > 0.2) note(tag, `exhaust is ${size.y.toFixed(2)} m tall — something else was taken for it`);
    }

    // Openings carved out of the shell.
    const openings = ['bonnet', 'doorL', 'doorR'];
    if (spec.body !== 'van') openings.push('boot');
    if (spec.body === 'sports') openings.push('spoiler');
    const roofY = m.dims.height - spec.rideHeight;
    for (const part of openings) {
      const before = paint.geometry.index.array.slice(0, Math.min(paint.geometry.drawRange.count, paint.geometry.index.count));
      const t0 = liveTris(paint);
      rig.applyEvents([{ type: 'detach', part }]);
      const gone = removedCentroids(before, paint);
      const frac = gone.length / Math.max(1, t0);
      if (!gone.length) { note(tag, `${part} carved nothing`); continue; }
      if (part === 'spoiler') {
        // The wing and its uprights, and nothing else: all of it behind the
        // rear glass and above the deck, none of it the tail panel below.
        const lowest = Math.min(...gone.map((g) => g[1]));
        if (gone.some(([, , z]) => z < m.dims.rear - 0.6)) note(tag, 'spoiler carve reached forward of the tail');
        if (lowest < roofY * 0.35) note(tag, `spoiler carve reached down to y ${lowest.toFixed(2)}`);
        continue;
      }
      if (frac > 0.3) note(tag, `${part} took ${(frac * 100).toFixed(0)}% of the paint`);
      if (part === 'doorL' && gone.some(([x]) => x > 0)) note(tag, 'doorL carved paint on the right');
      if (part === 'doorR' && gone.some(([x]) => x < 0)) note(tag, 'doorR carved paint on the left');
      if (part === 'bonnet' && gone.some(([, , z]) => z > 0)) note(tag, 'bonnet carve reached behind the axle midpoint');
      if (part === 'boot' && gone.some(([, y]) => y > roofY - 0.12)) {
        // The cabin is measured off the side glass; if that measurement comes
        // up short, the "boot" starts under the rear of the roof.
        note(tag, `boot carve took roof-height paint (y ${Math.max(...gone.map((g) => g[1])).toFixed(2)} vs roof ${roofY.toFixed(2)})`);
      }
      if (part === 'boot' && gone.some(([, , z]) => z < 0)) note(tag, 'boot carve reached ahead of the axle midpoint');
    }

    // Dents: heavy, all panels at once, repeatedly. Nothing may go non-finite
    // or be pushed further than the renderer's own ceiling.
    const state = {
      panel: {}, glass: {}, light: {}, attached: {}, blown: [false, true, false, false],
      tyre: [1, 0.2, 1, 1], suspension: [1, 0.4, 1, 1], onFire: 0, burntFor: 0,
    };
    for (const p of ['bonnet', 'roof', 'boot', 'frontBumper', 'rearBumper', 'wingFL', 'wingFR', 'wingRL', 'wingRR', 'doorL', 'doorR']) state.panel[p] = 1;
    rig.update(state, 1 / 60);
    const pp = paint.geometry.attributes.position.array;
    let nan = 0;
    for (let i = 0; i < pp.length; i++) if (!Number.isFinite(pp[i])) { nan++; break; }
    if (nan) note(tag, 'dented body went non-finite');
    rig.reset();
    rig.dispose();

    // --- wheels: steer, spin, ride, calipers --------------------------------
    const fl = m.wheels[0];
    if (detail === 'high') {
      if (fl.children[0].name !== 'tyre' || fl.children.length < 2) note(tag, 'wheel children are not [tyre, rim, ...]');
      m.setSteer(0.3); m.setWheelSpin(1.7);
      m.group.updateMatrixWorld(true);
      const cal = fl.children.find((k) => k.name === 'caliper');
      if (cal) {
        const q = new THREE.Quaternion();
        cal.getWorldQuaternion(q);
        const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
        if (Math.abs(e.x) > 1e-6 || Math.abs(e.y + 0.3) > 1e-6) note(tag, `caliper spins with the wheel (x ${e.x.toFixed(3)}, y ${e.y.toFixed(3)})`);
      } else note(tag, 'no caliper');
    }
    m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Beyond the catalogue: the fire engine wreck.js builds from a bare spec, and
// a seeded sweep of proportions a future car might have. The first version of
// this sweep found arch ends landing a rounding error outside the arch.
// ---------------------------------------------------------------------------
{
  let s = 0x2f6e2b1;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const sweep = [{}, { body: 'van', colour: 0xc8102e, wheelbase: 3.1, track: 1.8 }, { body: 'not-a-style' }];
  for (let i = 0; i < 70; i++) {
    sweep.push({ id: `sweep${i}`, body: BODY_STYLES[i % 7], wheelbase: 2.1 + rand() * 1.5, track: 1.35 + rand() * 0.55,
      wheelRadius: 0.27 + rand() * 0.21, rideHeight: 0.1 + rand() * 0.5 });
  }
  let broken = 0, first = '';
  for (const sp of sweep) {
    for (const detail of ['high', 'low']) {
      try {
        const m = createCarModel(sp, { detail });
        let bad = false;
        m.group.traverse((o) => {
          if (!o.isMesh || bad) return;
          const p = o.geometry.attributes.position.array, n = o.geometry.attributes.normal.array;
          for (let k = 0; k < p.length; k++) if (!Number.isFinite(p[k]) || !Number.isFinite(n[k])) { bad = true; break; }
        });
        if (bad) { broken++; first = first || `${JSON.stringify(sp)} ${detail}`; }
        m.dispose();
      } catch (err) { broken++; first = first || `${JSON.stringify(sp)} ${detail}: ${err.message}`; }
    }
  }
  check('odd specs and a sweep of proportions all build finite', broken === 0,
    broken ? `${broken} bad, first ${first}` : `${sweep.length * 2} builds`);
}

const bad = Object.keys(problems);
check('every car splits into panes, lamps, mirrors, bumpers and tailpipes',
  bad.length === 0, bad.length ? '' : `${CARS.length} cars x 2 detail levels, taken apart with the real damage renderer`);
for (const k of bad) for (const msg of problems[k]) console.log(`        ${k.padEnd(16)} ${msg}`);

// ---------------------------------------------------------------------------
// 5. Behaviour: suspension, shadow, level of detail, paint, lamps
// ---------------------------------------------------------------------------
{
  const spec = specFor('kaze');
  const m = createCarModel(spec);
  const rest = m.wheels[0].position.y;
  m.setSuspension([0.05, 0, 0, 0]);
  check('suspension compression lifts the wheel toward the arch',
    Math.abs(m.wheels[0].position.y - (rest + 0.05)) < 1e-9, `rest ${rest.toFixed(3)} m`);
  m.setSuspension([9, -9, 0, 0]);
  check('suspension travel is bounded inside the arch',
    m.wheels[0].position.y - rest < spec.wheelRadius && rest - m.wheels[1].position.y < spec.wheelRadius);

  const shadow = m.group.getObjectByName('contactShadow');
  m.setSuspension([0, 0, 0, 0]);
  const groundY = shadow ? shadow.position.y : NaN;
  check('the contact shadow sits on the road under the car',
    !!shadow && Math.abs(groundY - (-spec.rideHeight + 0.047)) < 0.005, shadow ? `y ${groundY.toFixed(3)} (ground ${(-spec.rideHeight).toFixed(3)})` : 'missing');
  const o0 = shadow ? shadow.material.opacity : 0;
  m.setSuspension([-0.12, -0.12, -0.12, -0.12]);
  check('and fades out when all four wheels hang (airborne)',
    !!shadow && shadow.material.opacity === 0, shadow ? `${o0.toFixed(2)} on the ground, ${shadow.material.opacity.toFixed(2)} in the air` : '');
  m.setSuspension([0, 0, 0, 0]);

  const lod = m.group.children[0];
  const cam = new THREE.PerspectiveCamera();
  const cosmetic = [];
  m.group.traverse((o) => { if (o.isMesh && (o.name === 'interior' || o.name === 'grille' || o.name === 'caliper')) cosmetic.push(o); });
  m.group.updateMatrixWorld(true);
  cam.position.set(0, 3, 120); cam.updateMatrixWorld(true);
  lod.update(cam);
  const hiddenFar = cosmetic.every((o) => !o.visible);
  const keptFar = ['paint', 'glass', 'plastic', 'lHead', 'lTail'].every((n) => byName(m, n).visible);
  cam.position.set(0, 3, 8); cam.updateMatrixWorld(true);
  lod.update(cam);
  check('far away, only cosmetic meshes are dropped (LOD)',
    lod.isLOD && cosmetic.length >= 6 && hiddenFar && keptFar && cosmetic.every((o) => o.visible),
    `${cosmetic.length} cosmetic meshes: dash and seats, grille infill, 4 calipers`);

  const paint = byName(m, 'paint').material;
  m.setPaint(0xf2f4f6);
  const white = paint.metalness;
  m.setPaint(0x1746a0);
  const blue = paint.metalness;
  check('white is a solid paint and colours are metallic', white < 0.1 && blue > 0.3 && paint.color.getHex() === 0x1746a0,
    `metalness ${white} white, ${blue} blue`);
  check('the paint is clearcoated', paint.clearcoat >= 0.9 && paint.clearcoatRoughness < 0.1);

  // carDamage cooks a burning car by pulling the paint colour toward soot; the
  // gloss has to follow it down, or a husk looks like a polished black car.
  const paintMesh = byName(m, 'paint');
  const scene = new THREE.Scene();
  const clean = paint.color.clone();
  paint.color.lerp(new THREE.Color(0x15161a), 0.85);
  paintMesh.onBeforeRender(null, scene);
  const charred = { cc: paint.clearcoat, r: paint.roughness };
  paint.color.copy(clean);
  paintMesh.onBeforeRender(null, scene);
  check('fire takes the shine off, and a repair puts it back',
    charred.cc < 0.3 && charred.r > 0.7 && paint.clearcoat === 1 && paint.roughness < 0.4,
    `clearcoat ${charred.cc.toFixed(2)} charred, ${paint.clearcoat.toFixed(2)} repaired`);

  // Wheel blur: invisible at a crawl, over the spokes at speed.
  const blurs = m.wheels.map((w) => w.children.find((k) => k.name === 'blur'));
  let ang = 0;
  for (let i = 0; i < 20; i++) { ang += 0.02; m.setWheelSpin(ang); }
  const slow = blurs.every((b) => b && !b.visible);
  for (let i = 0; i < 20; i++) { ang += 1.4; m.setWheelSpin(ang); }
  const fast = blurs.every((b) => b && b.visible) && blurs[0].material.opacity > 0.8;
  for (let i = 0; i < 30; i++) { ang += 0.02; m.setWheelSpin(ang); }
  check('spokes blur at speed and are sharp again at a crawl', slow && fast && blurs.every((b) => !b.visible),
    `opacity at 1.4 rad/frame ${fast ? '> 0.8' : 'too low'}; hidden at 0.02 rad/frame`);

  // The high-level brake light rides the centreline, so smashing both tail
  // lamps must leave it lit.
  {
    const rig = createCarDamage(m, spec, {});
    rig.applyEvents([{ type: 'light-smash', light: 'tailL' }, { type: 'light-smash', light: 'tailR' }]);
    // The pieces carDamage could not attribute to a tracked lamp keep the
    // working material; the centreline brake light has to be among them.
    const brakeMat = byName(m, 'lBrake').material;
    const rest = chassisOf(m).children.find((k) => k.name === 'lBrake:rest');
    const box = rest ? new THREE.Box3().setFromObject(rest) : null;
    const onCentre = !!box && box.min.x < 0 && box.max.x > 0;
    m.setBrakeLights(1);
    check('the high-level brake light survives both tail lamps being smashed',
      !!rest && rest.material === brakeMat && onCentre && brakeMat.emissiveIntensity > 2,
      rest ? `centred at x ${((box.min.x + box.max.x) / 2).toFixed(3)}, still lit at ${brakeMat.emissiveIntensity}` : 'no unattributed brake lamp');
    m.setBrakeLights(0);
    rig.dispose();
  }

  m.setHeadlights(true);
  const head = byName(m, 'lHead').material, tail = byName(m, 'lTail').material;
  check('headlights on light the tails as running lights', head.emissiveIntensity === 2.4 && tail.emissiveIntensity === 0.45);
  m.setBrakeLights(1);
  check('braking outshines the running lights', byName(m, 'lBrake').material.emissiveIntensity > tail.emissiveIntensity);
  m.dispose();
  m.dispose();
  check('dispose is idempotent', m.group.parent === null);
}

// ---------------------------------------------------------------------------
// 6. The budget
// ---------------------------------------------------------------------------
{
  const pick = (det) => budget.filter((b) => b.detail === det);
  const stat = (arr, k) => [Math.min(...arr.map((b) => b[k])), Math.max(...arr.map((b) => b[k]))];
  const hi = pick('high'), lo = pick('low');
  const [hT0, hT1] = stat(hi, 'tris'), [lT0, lT1] = stat(lo, 'tris');
  const [hC0, hC1] = stat(hi, 'calls'), [lC0, lC1] = stat(lo, 'calls');
  const [hS0, hS1] = stat(hi, 'shadowCasters'), [lS0, lS1] = stat(lo, 'shadowCasters');
  // The first version of this file cost 24 draw calls and ~1,600 triangles
  // per car at high detail, 12 and ~1,380 at low. Draw calls are what dozens
  // of traffic cars actually spend, so they must not grow; triangles are
  // cheap on any GPU from the last decade and are allowed to.
  check('player detail stays within 28 draw calls a car', hC1 <= 28, `${hC0}-${hC1} calls, ${hS0}-${hS1} shadow casters, ${hT0}-${hT1} triangles`);
  check('player detail stays under 32k triangles', hT1 < 32000);
  check('traffic detail stays within 14 draw calls a car', lC1 <= 14, `${lC0}-${lC1} calls, ${lS0}-${lS1} shadow casters, ${lT0}-${lT1} triangles`);
  check('traffic detail stays under 7k triangles', lT1 < 7000);
}

console.log(`
What a headless check cannot see — look at these in the browser:
  - a car in the chase camera at midday: the horizon line running along the flanks,
    sky pooling on the roof and boot, shut lines round the doors, boot and bonnet
  - the same car at night: the reflections go dark with the sky, lamps glow in pattern
  - the rear wheels from behind: tread, sidewall, spokes with the disc behind them
  - a red car and a white car side by side: white is solid, red is metallic
`);
console.log(fail === 0 ? 'The cars are cars, and they still come apart.' : `${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
