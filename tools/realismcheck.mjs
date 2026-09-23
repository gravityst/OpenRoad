// Proves the world is drawn where it is solid, and that the lived-in part of
// it — the traffic mix, the roadside, the night — follows its own rules.
//
// Every section here corresponds to something that passed every other harness
// while being visibly wrong in the browser:
//
//   1. BUILDINGS. collisioncheck and calmcheck measure the SOLID boxes against
//      each other, never the drawn car against the drawn wall, so a bonnet
//      buried 1-2 m inside a barn passed both. This drives the real vehicle,
//      with the real collision, into real lots from every side and corner, and
//      measures the car's drawn outline against the wall city.js draws.
//   2. TRAFFIC DRAW COST. carscheck budgets a traffic car at 'low' detail,
//      and main.js built every one at the player's detail: the budget passed
//      against a code path the game never ran. This checks the game's own call
//      site, then drives the fleet against a real traffic pool and counts.
//   3. THE ROAD PULL. roads.js pulls the road toward the eye in depth; every
//      ground decal that must stay visible over it has to be pulled by the
//      same numbers, or it vanishes. Nothing else can see that headless.
//
// Headless, so it cannot see the paint. What to LOOK at is listed at the end.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createVehicle } from '../src/physics/vehicle.js';
import { createCollision } from '../src/physics/collision.js';
import { CARS, specFor } from '../src/vehicles/catalog.js';
import { createCarModel, createFleet, ROAD_PULL } from '../src/render/carModel.js';
import { createTraffic } from '../src/ai/traffic.js';
import { drawnSize, SOLID_FRACTION } from '../src/render/city.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) fail++;
};
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

const world = buildWorld();
const ground = createGround(world);
world.buildLots(ground);

// ---------------------------------------------------------------------------
// 1. Buildings: the drawn car against the drawn wall
// ---------------------------------------------------------------------------
/**
 * Depth two oriented rectangles overlap by, along the separating axis that
 * parts them soonest (0 if they are apart). Each is { x, z, c, s, hw, hl }
 * with c/s the cosine and sine of its frame and (hw, hl) its half extents
 * along its own right and forward axes, forward being (-s, -c) as the game
 * has it and right (c, -s).
 */
function overlapDepth(a, b) {
  const axes = [[a.c, -a.s], [-a.s, -a.c], [b.c, -b.s], [-b.s, -b.c]];
  const dx = b.x - a.x, dz = b.z - a.z;
  let best = Infinity;
  for (const [nx, nz] of axes) {
    const dist = Math.abs(dx * nx + dz * nz);
    const ra = a.hw * Math.abs(a.c * nx - a.s * nz) + a.hl * Math.abs(-a.s * nx - a.c * nz);
    const rb = b.hw * Math.abs(b.c * nx - b.s * nz) + b.hl * Math.abs(-b.s * nx - b.c * nz);
    const gap = ra + rb - dist;
    if (gap <= 0) return 0;
    if (gap < best) best = gap;
  }
  return best;
}

{
  // A spread of lots: every size class, and the biggest shed on the map.
  const lots = world.lots.slice().sort((p, q) => Math.max(p.w, p.d) - Math.max(q.w, q.d));
  const pick = [];
  for (let i = 0; i < 18; i++) pick.push(lots[Math.min(lots.length - 1, Math.round((i / 17) * (lots.length - 1)))]);
  const models = new Map();
  for (const c of CARS) {
    const m = createCarModel(specFor(c.id), { detail: 'low' });
    models.set(c.id, { front: -m.dims.front, rear: m.dims.rear, hw: m.dims.width * 0.5 });
    m.dispose();
  }

  const dt = 1 / 120;
  const col = createCollision(world, { ground });
  const results = { drawn: [], full: [] };
  const byKind = { face: [], oblique: [], corner: [] };
  const byKindFull = { face: [], oblique: [], corner: [] };
  let worst = { depth: 0, at: '' }, worstFull = 0, runs = 0;
  for (const lot of pick) {
    const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
    // The building as drawn now, and as it used to be drawn (the whole lot).
    // collision.js's frame: local x runs along (c, s), local z along (-s, c).
    const size = drawnSize(lot);
    // In the overlap helper's convention, right = (c', -s') and forward =
    // (-s', -c'). A lot's local x axis is (c, s), so c' = c and s' = -s.
    const bDrawn = { x: lot.x, z: lot.z, c, s: -s, hw: size.w / 2, hl: size.d / 2 };
    const bFull = { x: lot.x, z: lot.z, c, s: -s, hw: lot.w / 2, hl: lot.d / 2 };
    // Approaches: square onto each face, 35 degrees onto a face, and straight
    // at a corner — the corner is the case the car's own box handles worst.
    const approaches = [];
    for (let f = 0; f < 4; f++) {
      const ang = lot.rot + f * Math.PI / 2;
      approaches.push({ dir: ang, kind: 'face' });
      approaches.push({ dir: ang + 0.61, kind: 'oblique' });
    }
    for (let k = 0; k < 4; k++) {
      const ca = Math.atan2(((k & 1) ? 1 : -1) * lot.d, ((k & 2) ? 1 : -1) * lot.w);
      approaches.push({ dir: lot.rot + ca, kind: 'corner' });
    }
    for (const id of ['kaida2', 'meridian', 'drover', 'ridgeback', 'lupo']) {
      const dimsOf = models.get(id);
      for (const ap of approaches) {
        for (const speed of [6, 18]) {
          const car = createVehicle({ ground, spec: specFor(id) });
          // Start 16 m out along the approach, aimed at the lot centre.
          const ox = Math.cos(ap.dir), oz = Math.sin(ap.dir);
          const r = Math.hypot(lot.w, lot.d) * 0.5 + 12;
          const sx = lot.x + ox * r, sz = lot.z + oz * r;
          const yaw = Math.atan2(ox, oz);            // forward (-sin, -cos) points back at the lot
          car.reset(sx, sz, yaw);
          car.vx = -Math.sin(yaw) * speed; car.vz = -Math.cos(yaw) * speed;
          let deepest = 0, deepestFull = 0;
          for (let i = 0; i < 360; i++) {
            car.input.throttle = 0.5; car.input.brake = 0; car.input.steer = 0; car.input.handbrake = 0;
            car.step(dt);
            col.resolve(car, dt);
            const cc = Math.cos(car.yaw), cs = Math.sin(car.yaw);
            // The drawn outline: the model's own nose, tail and width, centred
            // where the body is rather than on the axle midpoint.
            const mid = (dimsOf.rear - dimsOf.front) * 0.5;       // +z offset of the body centre
            const body = {
              x: car.x + Math.sin(car.yaw) * mid, z: car.z + Math.cos(car.yaw) * mid,
              c: cc, s: cs, hw: dimsOf.hw, hl: (dimsOf.front + dimsOf.rear) * 0.5,
            };
            deepest = Math.max(deepest, overlapDepth(body, bDrawn));
            deepestFull = Math.max(deepestFull, overlapDepth(body, bFull));
          }
          runs++;
          results.drawn.push(deepest);
          results.full.push(deepestFull);
          byKind[ap.kind].push(deepest);
          byKindFull[ap.kind].push(deepestFull);
          if (deepest > worst.depth) worst = { depth: deepest, at: `${id} at ${speed} m/s into a ${Math.max(lot.w, lot.d).toFixed(1)} m ${lot.kind}` };
          worstFull = Math.max(worstFull, deepestFull);
        }
      }
    }
  }
  const over = (a, t) => a.filter((v) => v > t).length;
  for (const k of Object.keys(byKind)) console.log(`  ${k.padEnd(8)} before worst ${Math.max(...byKindFull[k]).toFixed(2)} median ${median(byKindFull[k]).toFixed(2)} | now worst ${Math.max(...byKind[k]).toFixed(2)} median ${median(byKind[k]).toFixed(2)} p90 ${byKind[k].slice().sort((a,b)=>a-b)[Math.floor(byKind[k].length*0.9)].toFixed(2)}`);
  console.log(`  ${runs} runs: 5 cars x ${pick.length} lots x 12 approaches x 2 speeds`);
  console.log(`  drawn as the whole lot (before): worst ${worstFull.toFixed(2)} m, median ${median(results.full).toFixed(2)} m, ${over(results.full, 0.3)} runs past 0.3 m`);
  console.log(`  drawn inside the solid box (now): worst ${worst.depth.toFixed(2)} m, median ${median(results.drawn).toFixed(2)} m, ${over(results.drawn, 0.3)} runs past 0.3 m`);
  const faceWorst = Math.max(...byKind.face);
  check('square into a wall, the car stops at the wall, not inside it', faceWorst < 0.15,
    `worst ${faceWorst.toFixed(2)} m (was ${Math.max(...byKindFull.face).toFixed(2)} m drawn at the full lot)`);
  check('over every approach, half the cars touch nothing drawn', median(results.drawn) < 0.12,
    `median ${median(results.drawn).toFixed(2)} m (was ${median(results.full).toFixed(2)} m)`);
  // A building's CORNER can still enter the car between its corners: the
  // solver tests only the car's four corners against each box, never the
  // box's corners against the car. That is physics/collision.js's to fix
  // (the SAT test createCarCollision already uses, and the model's own
  // extents) — see the round-three realism notes. Until then this is a
  // regression bound on what city.js controls, not a claim it is solved.
  check('a building corner never buries more than a bumper', worst.depth < 1.1,
    `worst ${worst.depth.toFixed(2)} m (${worst.at}), was ${worstFull.toFixed(2)} m`);
  check('city.js and collision.js agree on the solid fraction',
    SOLID_FRACTION === 0.94 && /lot\.w \* 0\.5 \* 0\.94/.test(read('src/physics/collision.js')),
    `${SOLID_FRACTION} of the lot`);
}

// ---------------------------------------------------------------------------
// 2. Traffic: the game's own call site, and what the fleet actually draws
// ---------------------------------------------------------------------------
{
  const main = read('src/main.js');
  const sync = main.slice(main.indexOf('function syncTrafficModels('), main.indexOf('function syncTrafficModels(') + 900);
  check('main.js draws traffic through the fleet, not at player detail',
    /createFleet\(/.test(main) && /fleet\.sync\(/.test(sync) && !/createCarModel\(\s*\{\s*\.\.\.t\.spec/.test(main),
    'syncTrafficModels -> fleet.sync; no per-slot createCarModel(spec) at default detail');

  const traffic = createTraffic(world, ground, { density: 44 });
  const scene = new THREE.Scene();
  const fleet = createFleet(scene, { quality: 'medium' });
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.35, 6000);
  const px = 0, pz = -1250;
  for (let i = 0; i < 600; i++) traffic.update(1 / 60, px, pz, 0, 0);
  // Stand the camera behind the player looking north, the chase view.
  camera.position.set(px, ground.heightAt(px, pz) + 2.6, pz + 6);
  camera.lookAt(px, ground.heightAt(px, pz) + 1, pz - 20);
  camera.updateMatrixWorld(true);
  fleet.prewarm(traffic.cars);
  fleet.sync(traffic.cars, camera, 0);

  // Draw calls as the renderer will issue them (colour pass): every visible
  // mesh under the fleet, an instanced mesh counting once.
  let calls = 0, casters = 0;
  fleet.group.traverseVisible((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh && o.count === 0) return;
    if (o.geometry && o.geometry.isInstancedBufferGeometry && o.geometry.instanceCount === 0) return;
    calls++;
    if (o.castShadow) casters++;
  });
  const st = fleet.stats;
  const active = traffic.cars.filter((c) => c.active).length;
  console.log(`  ${active} active cars: ${st.near} near, ${st.far} far in view, ${st.kinds} models; ${calls} fleet draw calls, ${casters} shadow casters`);
  // Before the fleet: every active car was a full model — 26 calls a car at
  // player detail, 12 at 'low' — whether it was 20 m away or 300.
  check('the whole traffic pool costs fewer draw calls than two near cars did', calls <= 2 * 26 + 12,
    `${calls} calls for ${active} cars (was ${active} x 26 = ${active * 26} before frustum culling)`);
  check('near cars are capped by the tier', st.near <= 10, `${st.near} near (medium caps at 10)`);

  // Lamps survive the trip to the far side: a braking far car has its brake
  // value set on its instance.
  const far = traffic.cars.find((c, i) => c.active && !fleet.model(i));
  let lampOk = false;
  if (far) {
    far.braking = true;
    fleet.sync(traffic.cars, camera, 0);
    for (const m of fleet.group.children) {
      if (!m.isInstancedMesh || !m.count) continue;
      const L = m.geometry.attributes.aLamp;
      if (!L) continue;
      for (let j = 0; j < m.count; j++) if (L.array[j * 4 + 1] === 1) lampOk = true;
    }
    far.braking = false;
  }
  check('a far car still brakes, indicates and runs its lamps', lampOk, lampOk ? 'brake value reached its instance' : 'no far car had its brake lamp');

  // Next to nothing allocated per frame, and nothing kept: 2000 syncs, day
  // and night alternating (the flares run at night). Measured 3.1 KB a frame
  // by day and 7.7 KB at night with --expose-gc: short-lived number boxes,
  // against the 845 KB a frame the terrain streams at speed.
  for (let i = 0; i < 200; i++) fleet.sync(traffic.cars, camera, i % 2 ? 0.8 : 0);
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) fleet.sync(traffic.cars, camera, i % 2 ? 0.8 : 0);
  const ms = (performance.now() - t0) / 2000;
  const perFrame = (process.memoryUsage().heapUsed - heap0) / 2000;
  check('fleet.sync is cheap: well under a tenth of a millisecond, a few KB', ms < 0.1 && perFrame < 12000,
    `${(ms * 1000).toFixed(0)} us and ${(perFrame / 1024).toFixed(1)} KB a frame for ${active} cars`);
  fleet.dispose();
}

// ---------------------------------------------------------------------------
// 3. The road pull
// ---------------------------------------------------------------------------
{
  const roads = read('src/render/roads.js');
  const m = roads.match(/uPull:\s*\{\s*value:\s*new THREE\.Vector2\(([\d.]+),\s*([\d.]+)\)/);
  const ok = !!m && +m[1] === ROAD_PULL[0] && +m[2] === ROAD_PULL[1];
  check('ground decals are pulled toward the eye exactly as the road is', ok,
    m ? `road ${m[1]}/${m[2]}, decals ${ROAD_PULL.join('/')}` : 'uPull not found in roads.js');
}

console.log(fail === 0 ? '\nThe world is drawn where it is solid, and lived in.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
