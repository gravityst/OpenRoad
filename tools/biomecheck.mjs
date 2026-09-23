// Proves the biomes are what they claim to be, and cost what they say.
//
// Headless, so it cannot see the canyon walls or the snow; the owner's visual
// checklist says what to look at for that. What it measures is everything a
// player would otherwise find the hard way:
//
//   SAME WORLD   every multiplayer client must build the identical map, so the
//                same seed must give the same weights, relief, sea and plants
//                to the bit — and a different seed a different map.
//   PLACES       every biome exists, is big enough to be somewhere, has road
//                through it, and can be driven to from the spawn.
//   NO SEAMS     weights change over hundreds of metres, never in a step; the
//                ground never steps between neighbouring metres.
//   ROADS SAFE   no relief moves a road (except the deliberate alpine rise),
//                no road is under the sea, no cliff is past the normal bound.
//   SURFACES     each biome lays its ground (snow, sand, hardpan, water), and
//                the new surfaces carry grip for the physics.
//   NAMES        the HUD names the biome, and says "entering" once per border
//                crossed — never flickering along one.
//   PLANTS       cacti in the desert, palms on the coast, nothing in the sea,
//                nothing on a road.
//   AIR          each biome has its own air, the snow falls only on the pass,
//                leaves only in the woods, heat only in the canyon, and
//                nothing the sky does goes non-finite.
//   LANDFORMS    a biome is not a colour swap: the pass runs between
//                mountains, the canyon between walls, the woods over hills.
//   LANDMARKS    the arches span their roads with room to drive under, the
//                hoodoos and the lighthouse stand where they should, the
//                snow poles line the pass, and every client places the same.
//   BUDGET       draw calls and triangles at the heart of each biome, per
//                quality tier — the numbers the frame budget is judged on.
import * as THREE from 'three';
import { buildWorld, pointOnEdge } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { BIOME, BIOMES, BIOME_COUNT, activeBiomes } from '../src/world/biomes.js';
import { mulberry } from '../src/world/noise.js';
import { createProps } from '../src/render/props.js';
import { createTerrain } from '../src/render/terrain.js';
import { createSky } from '../src/render/sky.js';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  if (!ok) fail++;
};
const now = () => performance.now();

let t0 = now();
const w = buildWorld();
const buildMs = now() - t0;
const g = createGround(w);
w.buildLots(g);
w.buildProps(g);
const B = w.biomes;
console.log(`world built in ${(buildMs / 1000).toFixed(2)} s (biome field ${B.stats.buildMs} ms), ` +
  `sea level ${B.seaLevel} m, ${B.stats.seaKm2} km2 of sea, ${B.stats.canyons} canyon tablelands\n`);

const wq = new Float64Array(BIOME_COUNT);
const dominant = (x, z) => B.dominant(x, z);
const HALF = w.half;

// ---- Same world ------------------------------------------------------------
{
  const w2 = buildWorld();
  const g2 = createGround(w2);
  w2.buildLots(g2);
  w2.buildProps(g2);
  const B2 = w2.biomes;
  const rnd = mulberry(7001);
  const w2q = new Float64Array(BIOME_COUNT);
  let diff = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() * 2 - 1) * 3000, z = (rnd() * 2 - 1) * 3000;
    B.weightsAt(x, z, wq); B2.weightsAt(x, z, w2q);
    for (let b = 0; b < BIOME_COUNT; b++) if (wq[b] !== w2q[b]) diff++;
    if (B.relief(x, z) !== B2.relief(x, z)) diff++;
    if (B.seaAt(x, z) !== B2.seaAt(x, z)) diff++;
    if (w.terrain.height(x, z) !== w2.terrain.height(x, z)) diff++;
  }
  const ex = (W) => W.props.filter((p) => p.type === 'cactus' || p.type === 'palm');
  const e1 = ex(w), e2 = ex(w2);
  let pd = e1.length === e2.length ? 0 : 1;
  for (let i = 0; !pd && i < e1.length; i++) {
    if (e1[i].x !== e2[i].x || e1[i].z !== e2[i].z || e1[i].type !== e2[i].type || e1[i].scale !== e2[i].scale) pd++;
  }
  const L1 = w.landmarks || [], L2 = w2.landmarks || [];
  let ld = L1.length === L2.length ? 0 : 1;
  for (let i = 0; !ld && i < L1.length; i++) {
    const a = L1[i], b = L2[i];
    if (a.type !== b.type || a.x !== b.x || a.z !== b.z || a.y !== b.y || a.rot !== b.rot || a.scale !== b.scale) ld++;
  }
  check('the same seed builds the same biomes, to the bit', diff === 0 && pd === 0 && ld === 0 && B2.seaLevel === B.seaLevel,
    `${diff} differences over 20,000 points (weights, relief, sea, height); ${e1.length} cacti and palms and ${L1.length} landmarks identical: ${pd === 0 && ld === 0}`);

  const w3 = buildWorld(20260821);
  let moved = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (rnd() * 2 - 1) * 2000, z = (rnd() * 2 - 1) * 2000;
    if (Math.abs(w3.biomes.relief(x, z) - B.relief(x, z)) > 1) moved++;
  }
  check('a different seed builds a different landscape', moved > 100,
    `${moved}/2000 points' relief differs by over 1 m on seed 20260821`);
}

// ---- Places ------------------------------------------------------------------
const area = new Array(BIOME_COUNT).fill(0);
{
  let n = 0;
  for (let z = -HALF + 8; z < HALF; z += 16) {
    for (let x = -HALF + 8; x < HALF; x += 16) { area[dominant(x, z)]++; n++; }
  }
  for (let b = 0; b < BIOME_COUNT; b++) area[b] /= n;
  check('every biome is a real place (10%+ of the map)', Math.min(...area) >= 0.10,
    BIOMES.map((q, b) => `${q.key} ${(area[b] * 100).toFixed(0)}%`).join(', '));
  let worst = 1;
  for (let b = 0; b < BIOME_COUNT; b++) worst = Math.min(worst, B.weightsAt(BIOMES[b].at[0], BIOMES[b].at[1], wq)[b]);
  check('every map label stands in its own biome', worst > 0.95, `lowest weight at a label ${worst.toFixed(3)}`);
  const sp = w.districts.filter((d) => d.biome !== undefined);
  check('every biome is named on the maps', sp.length === BIOME_COUNT && sp.every((d) => d.name === BIOMES[d.biome].name),
    sp.map((d) => d.name).join(', '));
}

{
  // Road length per biome, and whether each biome's roads connect to the
  // spawn's (the game spawns the player near (0, -260)).
  const km = new Array(BIOME_COUNT).fill(0);
  const edgeBiome = new Int8Array(w.edges.length);
  for (const e of w.edges) {
    const cnt = new Array(BIOME_COUNT).fill(0);
    for (let k = 1; k < e.pts.length; k++) {
      const p = e.pts[k];
      const b = dominant(p.x, p.z);
      const d = Math.hypot(p.x - e.pts[k - 1].x, p.z - e.pts[k - 1].z);
      km[b] += d / 1000; cnt[b] += d;
    }
    edgeBiome[e.i] = cnt.indexOf(Math.max(...cnt));
  }
  check('road runs through every biome (5+ km each)', Math.min(...km) >= 5,
    BIOMES.map((q, b) => `${q.key} ${km[b].toFixed(1)} km`).join(', '));

  const start = g.nearestRoad(0, -260, 400).edge;
  const seen = new Uint8Array(w.nodes.length);
  const stack = [start.a];
  seen[start.a] = 1;
  const reached = new Array(BIOME_COUNT).fill(0);
  while (stack.length) {
    const n = stack.pop();
    for (const ei of w.nodes[n].edges) {
      const e = w.edges[ei];
      reached[edgeBiome[ei]]++;
      const o = e.a === n ? e.b : e.a;
      if (!seen[o]) { seen[o] = 1; stack.push(o); }
    }
  }
  check('every biome can be driven to from the spawn', reached.every((v) => v > 0),
    BIOMES.map((q, b) => `${q.key} ${reached[b] > 0 ? 'yes' : 'NO'}`).join(', '));
}

// ---- No seams ----------------------------------------------------------------
{
  const rnd = mulberry(7003);
  let worstW = 0, worstStep = 0, whereStep = null;
  const prev = new Float64Array(BIOME_COUNT);
  for (let line = 0; line < 400; line++) {
    const x0 = (rnd() * 2 - 1) * HALF, z0 = (rnd() * 2 - 1) * HALF;
    const a = rnd() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let hPrev = null;
    for (let s = 0; s < 400; s += 2) {
      const x = x0 + dx * s, z = z0 + dz * s;
      if (Math.abs(x) > HALF || Math.abs(z) > HALF) break;
      B.weightsAt(x, z, wq);
      if (s > 0) for (let b = 0; b < BIOME_COUNT; b++) worstW = Math.max(worstW, Math.abs(wq[b] - prev[b]) / 2);
      prev.set(wq);
      const h = g.heightAt(x, z);
      if (hPrev !== null && Math.abs(h - hPrev) / 2 > worstStep) { worstStep = Math.abs(h - hPrev) / 2; whereStep = [x | 0, z | 0]; }
      hPrev = h;
    }
  }
  // 1/100 per metre: a biome takes at least 100 m to hand over to the next.
  check('borders are gradual, never a line', worstW < 0.01,
    `narrowest handover anywhere on the map ${(1 / Math.max(worstW, 1e-9)).toFixed(0)} m (limit 100 m)`);
  check('the ground never steps between neighbouring metres', worstStep < 3.4,
    `steepest 2 m step ${(worstStep * 100).toFixed(0)}% grade at ${JSON.stringify(whereStep)} (a 73 degree cliff is 330%)`);
}

// ---- Roads safe -----------------------------------------------------------------
{
  // The relief is baked as exactly zero within 38 m of a carriageway edge and
  // read back bicubically, whose support is two 8 m cells: so from the road's
  // centre out to 16 m past its edge the ground must be the base terrain to
  // the bit. Everything the elevation solver, the stamped field and the
  // verge blend see is inside that. The broad alpine rise is the one
  // deliberate exception, and is graded by the solver like any hill.
  let touched = 0, n = 0, worst = 0;
  for (const e of w.edges) {
    for (let k = 0; k < e.pts.length; k += 3) {
      const p = e.pts[k];
      B.weightsAt(p.x, p.z, wq);
      if (wq[BIOME.alpine] > 1e-3) continue;
      const q = e.pts[Math.min(e.pts.length - 1, k + 1)], r = e.pts[Math.max(0, k - 1)];
      let tx = q.x - r.x, tz = q.z - r.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const edge = e.width * 0.5;
      for (const off of [0, edge + 8, -edge - 8, edge + 16, -edge - 16]) {
        const x = p.x - tz * off, z = p.z + tx * off;
        const rel = Math.abs(B.relief(x, z));
        n++;
        if (rel !== 0) { touched++; worst = Math.max(worst, rel); }
      }
    }
  }
  check('no mesa, cliff or sea floor within 16 m of a road edge', touched === 0,
    `${touched}/${n} samples on or beside a road moved at all (worst ${worst.toFixed(3)} m); the alpine rise excepted`);

  let under = 0, lowest = Infinity;
  for (const e of w.edges) {
    for (const p of e.pts) {
      const y = g.heightAt(p.x, p.z);
      lowest = Math.min(lowest, y - B.seaLevel);
      if (y < B.seaLevel + 2 || B.seaAt(p.x, p.z) > 0) under++;
    }
  }
  check('no road is under, or within 2 m of, the sea', under === 0,
    `${under} road points in or near the water; lowest road ${lowest.toFixed(1)} m above sea level`);

  const rnd = mulberry(7005);
  const o = {};
  let minNy = 1, at = null;
  for (let i = 0; i < 200000; i++) {
    const x = (rnd() * 2 - 1) * (HALF + 1200), z = (rnd() * 2 - 1) * (HALF + 1200);
    const r = g.sample(x, z, o);
    if (r.ny < minNy) { minNy = r.ny; at = [x | 0, z | 0]; }
  }
  check('no cliff steeper than the ground can hold', minNy > 0.3,
    `steepest normal y ${minNy.toFixed(3)} at ${JSON.stringify(at)}, a kilometre past the map edge included (groundcheck floor 0.25)`);
}

// ---- Surfaces --------------------------------------------------------------------
{
  const S = g.SURFACES;
  const okGrip = ['snow', 'water'].every((k) => S[k] && Number.isFinite(S[k].grip) && S[k].grip > 0.3 && Number.isFinite(S[k].rolling));
  check('snow and water carry grip for the physics', okGrip,
    `snow grip ${S.snow && S.snow.grip} rolling ${S.snow && S.snow.rolling}; water grip ${S.water && S.water.grip} rolling ${S.water && S.water.rolling}`);

  const mix = BIOMES.map(() => ({}));
  const cnt = new Array(BIOME_COUNT).fill(0);
  const rnd = mulberry(7007);
  const o = {};
  for (let i = 0; i < 120000; i++) {
    const x = (rnd() * 2 - 1) * HALF, z = (rnd() * 2 - 1) * HALF;
    B.weightsAt(x, z, wq);
    const b = dominant(x, z);
    if (wq[b] < 0.9) continue;
    const r = g.sample(x, z, o);
    mix[b][r.surface] = (mix[b][r.surface] || 0) + 1;
    cnt[b]++;
  }
  const f = (b, ...k) => k.reduce((a, s) => a + (mix[b][s] || 0), 0) / Math.max(1, cnt[b]);
  const snow = f(BIOME.alpine, 'snow', 'rock'), desert = f(BIOME.desert, 'sand', 'dirt', 'rock');
  const coast = f(BIOME.coast, 'water', 'sand'), farm = f(BIOME.farm, 'snow', 'water');
  check('each biome lays its own ground', snow > 0.8 && desert > 0.8 && coast > 0.2 && farm === 0,
    `pass snow/rock ${(snow * 100).toFixed(0)}%, canyon sand/hardpan/rock ${(desert * 100).toFixed(0)}%, ` +
    `bay water/sand ${(coast * 100).toFixed(0)}%, farmland snow/water ${(farm * 100).toFixed(1)}%`);

  // A beach: sand within 60 m of open water somewhere along the coast.
  let beach = 0;
  for (let x = -1500; x <= 1500; x += 50) {
    for (let z = 1300; z < 2000; z += 4) {
      if (B.seaAt(x, z) > 0.5) {
        if (g.sample(x, z - 20, o).surface === 'sand' || g.sample(x, z - 40, o).surface === 'sand') beach++;
        break;
      }
    }
  }
  check('the sea has beaches', beach >= 20, `${beach} of 61 coast sections reach the water over sand`);
}

// ---- Names -------------------------------------------------------------------------
{
  // Straight drives through all four borders, then a wobble along one border.
  const legs = [[0, -200, -1700, 0], [-1700, 0, 0, 1650], [0, 1650, 1700, 0], [1700, 0, 0, -1600], [0, -1600, 0, -200]];
  const names = [];
  let entered = 0;
  B.track(legs[0][0], legs[0][1]);
  for (const [ax, az, bx, bz] of legs) {
    for (let s = 0; s <= 1; s += 0.002) {
      const t = B.track(ax + (bx - ax) * s, az + (bz - az) * s);
      if (t.entered) { entered++; names.push(t.name); }
    }
  }
  const distinct = new Set(names).size;
  check('the HUD says "entering" once per border crossed', entered >= 5 && entered <= 9 && distinct === BIOME_COUNT,
    `${entered} entries on a tour of the map: ${names.join(' -> ')}`);

  // Along the farm/canyon border, as a road that follows it would: tracking
  // the 50% line and wandering 40 m either side of it every 200 m.
  let flicker = 0;
  let x = -900;
  for (let i = 0; i < 3000; i++) {
    const z = -600 + i * 0.4;
    B.weightsAt(x, z, wq);
    x += (wq[BIOME.desert] - 0.5) * 20;
    const t = B.track(x + Math.sin(i * 0.4 * Math.PI * 2 / 200) * 40, z);
    if (t.entered) flicker++;
  }
  check('driving along a border never flickers the name', flicker <= 2,
    `${flicker} name changes over 1.2 km wandering 40 m either side of the farm/canyon border`);
}

// ---- Plants ---------------------------------------------------------------------------
{
  const cacti = w.props.filter((p) => p.type === 'cactus');
  const palms = w.props.filter((p) => p.type === 'palm');
  const wrong = cacti.filter((p) => B.weightsAt(p.x, p.z, wq)[BIOME.desert] < 0.45).length +
                palms.filter((p) => B.weightsAt(p.x, p.z, wq)[BIOME.coast] < 0.4).length;
  check('cacti grow in the canyon, palms on the coast', cacti.length > 300 && palms.length > 200 && wrong === 0,
    `${cacti.length} cacti, ${palms.length} palms, ${wrong} outside their biome`);

  let wet = 0;
  for (const p of w.props) if (B.seaAt(p.x, p.z) > 0.3 && p.y < B.seaLevel + 0.25) wet++;
  check('nothing grows in the sea', wet === 0, `${wet} props standing in the water`);

  const road = {};
  let close = 0, off = 0;
  for (const p of [...cacti, ...palms]) {
    g.roadAt(p.x, p.z, road);
    if (road.edge && road.dist - road.width * 0.5 < 4) close++;
    if (Math.abs(p.y - g.heightAt(p.x, p.z)) > 0.05) off++;
  }
  check('no cactus or palm on a road, all on the ground', close === 0 && off === 0,
    `${close} within 4 m of a carriageway, ${off} more than 5 cm off the ground`);

  let snowTrees = 0, deserts = 0;
  for (const p of w.props) {
    if (p.type !== 'tree') continue;
    B.weightsAt(p.x, p.z, wq);
    if (wq[BIOME.desert] > 0.9) deserts++;
    if (wq[BIOME.alpine] > 0.9) snowTrees++;
  }
  check('forest on the pass, none in the canyon', snowTrees > 5000 && deserts === 0,
    `${snowTrees} trees deep in the mountains, ${deserts} deep in the desert`);
}

// ---- Air -------------------------------------------------------------------------------
{
  const scene = new THREE.Scene();
  const sky = createSky(scene, null);
  sky.setDrawDistance(960);
  sky.setWeather('clear', 0);
  sky.setTime(11);
  const cam = new THREE.Vector3();
  const air = [];
  let bad = 0;
  for (let b = 0; b < BIOME_COUNT; b++) {
    cam.set(BIOMES[b].at[0], 0, BIOMES[b].at[1]);
    for (let i = 0; i < 400; i++) sky.update(1 / 60, cam);
    const st = sky.state;
    const snowing = scene.children.some((c) => c.name === 'snowfall' && c.visible);
    const leaves = scene.children.some((c) => c.name === 'leaffall' && c.visible);
    const bm = scene.children.find((c) => c.name === 'birds');
    air.push({ b, turb: st.turbidity, vis: st.visibility, snowing, leaves, heat: st.heatHaze || 0,
      birds: bm && bm.visible, gulls: st.biome.gulls, raptors: st.biome.raptors, geese: st.biome.geese });
    for (const v of [st.turbidity, st.visibility, st.fogColour.r, st.fogColour.g, st.fogColour.b, sky.sun.intensity]) {
      if (!Number.isFinite(v) || v < 0) bad++;
    }
  }
  const dusty = air[BIOME.desert].vis < air[BIOME.farm].vis * 0.7;
  const clear = air[BIOME.alpine].vis > air[BIOME.farm].vis * 1.2;
  const snowOnly = air.every((a) => a.snowing === (a.b === BIOME.alpine));
  const leavesOnly = air.every((a) => a.leaves === (a.b === BIOME.autumn));
  const heatOnly = air.every((a) => (a.heat > 0.5) === (a.b === BIOME.desert));
  check('each biome has its own air, and snow falls only on the pass', dusty && clear && snowOnly && bad === 0,
    air.map((a) => `${BIOMES[a.b].key} vis ${(a.vis / 1000).toFixed(0)} km${a.snowing ? ' +snow' : ''}`).join(', ') +
    `; ${bad} non-finite`);
  check('leaves fall only in the woods, heat shimmers only in the canyon', leavesOnly && heatOnly,
    air.map((a) => `${BIOMES[a.b].key}${a.leaves ? ' +leaves' : ''} heat ${a.heat.toFixed(2)}`).join(', '));
  // Birds: gulls over the bay, raptors over the canyon and the pass, geese
  // over the woods (and, fewer, the farmland), and none after dark.
  const bird = (b, k) => air[b][k];
  const birdsRight = bird(BIOME.coast, 'gulls') > 0.9 && bird(BIOME.desert, 'raptors') > 0.9 && bird(BIOME.alpine, 'raptors') > 0.9 &&
    bird(BIOME.autumn, 'geese') > 0.9 && bird(BIOME.farm, 'gulls') < 0.05 && bird(BIOME.coast, 'raptors') < 0.05 &&
    bird(BIOME.desert, 'geese') < 0.05 && air.every((a) => a.birds);
  cam.set(BIOMES[BIOME.coast].at[0], 0, BIOMES[BIOME.coast].at[1]);
  sky.setTime(1);
  for (let i = 0; i < 60; i++) sky.update(1 / 60, cam);
  const roost = !scene.children.find((c) => c.name === 'birds').visible;
  sky.setTime(11);
  check('birds of the right kind fly by day, and roost at night', birdsRight && roost,
    air.map((a) => `${BIOMES[a.b].key} ${['gulls', 'raptors', 'geese'].filter((k) => a[k] > 0.5).join('+') || '-'}`).join(', ') + `; at 01:00 ${roost ? 'none' : 'STILL FLYING'}`);
  check('the sky reads the world it was built with', activeBiomes() !== null, activeBiomes() ? 'registry set' : 'no field registered');

  // Travel is a cut, and the air cuts with it. Eased over 1.5 s like a
  // border, the woods' orange leaves went on falling among the pass's snowy
  // spruce for 5 s after map travel. Driven, it still eases.
  const at = (b) => cam.set(BIOMES[b].at[0], 0, BIOMES[b].at[1]);
  at(BIOME.autumn);
  for (let i = 0; i < 400; i++) sky.update(1 / 60, cam);
  at(BIOME.alpine);
  sky.update(1 / 60, cam);
  const cut = { leaves: sky.state.biome.leaves, snow: sky.state.biome.snow, geese: sky.state.biome.geese };
  at(BIOME.autumn);
  for (let i = 0; i < 400; i++) sky.update(1 / 60, cam);
  cam.x += 8;                                    // a frame at 480 km/h: driving
  sky.update(1 / 60, cam);
  const eased = sky.state.biome.leaves;
  check('travel lands in the new place\'s air at once', cut.leaves < 0.01 && cut.snow > 0.99 && cut.geese < 0.01 && eased > 0.9,
    `one frame after travel from the woods to the pass: leaves ${cut.leaves.toFixed(2)}, snow ${cut.snow.toFixed(2)}, ` +
    `geese ${cut.geese.toFixed(2)}; 8 m driven keeps leaves ${eased.toFixed(2)}`);

  // The canyon's mirage (terrain.js) is drawn by the sun's heat on the ground,
  // which sky.js publishes: a high sun on dry sand. Drawn by daylight alone,
  // the pools shimmered at sunrise and through a downpour.
  // (A weather set with no blend dries the road at once; the showers here
  // clear over 2 s, so the ground has to dry for itself.)
  const heat = (hours, weather, seconds = 0.05, blend = 0) => {
    if (weather) sky.setWeather(weather, blend);
    sky.setTime(hours);
    for (let t = 0; t < seconds; t += 1 / 60) sky.update(1 / 60, cam);
    return scene.userData.sky.heat;
  };
  const hNoon = heat(11, 'clear'), hDawn = heat(6, 'clear'), hSeven = heat(7, 'clear'), hNight = heat(23, 'clear');
  const hOver = heat(11, 'overcast'), hRain = heat(11, 'rain', 60), hAfter = heat(11, 'clear', 3, 2);
  const hDry = heat(11, null, 600);
  check('the mirage waits for a high sun on dry sand', hNoon > 0.95 && hDawn < 0.05 && hSeven > 0.3 && hSeven < 0.9 &&
    hNight === 0 && hOver < 0.05 && hRain === 0 && hAfter < 0.2 && hDry > 0.9,
    `11:00 ${hNoon.toFixed(2)}, 06:00 ${hDawn.toFixed(2)}, 07:00 ${hSeven.toFixed(2)}, 23:00 ${hNight.toFixed(2)}, ` +
    `overcast ${hOver.toFixed(2)}, rain ${hRain.toFixed(2)}, just after ${hAfter.toFixed(2)}, dry 10 min on ${hDry.toFixed(2)}`);
  sky.setWeather('clear', 0);
  sky.setTime(11);
  sky.dispose();
}

// ---- Landforms -----------------------------------------------------------------------------
{
  // From the road, every 50 m: the highest ground 60 to 250 m off to either
  // side, above the road itself. Measured on this seed before the landforms
  // went in: pass median 24 m (21% of samples over 40 m), canyon 26 m, woods
  // 8 m, farmland 7 m — the pass and the woods were the farmland's ground.
  const rise = (b) => {
    const out = [];
    for (const e of w.edges) {
      if (e.kind === 'circuit' || e.kind === 'rallyx') continue;
      for (let s = 10; s < e.length; s += 50) {
        const p = pointOnEdge(e, s);
        if (B.weightsAt(p.x, p.z, wq)[b] < 0.9) continue;
        const y0 = g.heightAt(p.x, p.z);
        let best = 0;
        for (const side of [-1, 1]) {
          for (let d = 60; d <= 250; d += 10) best = Math.max(best, g.heightAt(p.x + p.nx * d * side, p.z + p.nz * d * side) - y0);
        }
        out.push(best);
      }
    }
    out.sort((a, c) => a - c);
    return { n: out.length, med: out[out.length >> 1] || 0, over: (m) => out.filter((v) => v >= m).length / Math.max(1, out.length) };
  };
  const farm = rise(BIOME.farm), alp = rise(BIOME.alpine), des = rise(BIOME.desert), aut = rise(BIOME.autumn);
  check('the pass runs between mountains', alp.med >= 35 && alp.over(40) >= 0.4,
    `ground beside the pass rises a median ${alp.med.toFixed(0)} m, over 40 m at ${(alp.over(40) * 100).toFixed(0)}% of ${alp.n} road samples (farmland: ${farm.med.toFixed(0)} m)`);
  check('the canyon runs between walls', des.med >= 18 && des.over(15) >= 0.5,
    `median ${des.med.toFixed(0)} m, over 15 m at ${(des.over(15) * 100).toFixed(0)}% of ${des.n} road samples`);
  check('the woods roll over hills of their own', aut.med >= farm.med * 1.6 && aut.over(15) >= 0.35,
    `median ${aut.med.toFixed(0)} m against the farmland's ${farm.med.toFixed(0)}; over 15 m at ${(aut.over(15) * 100).toFixed(0)}%`);

  // Away from the roads the mountains are mountains: tall, and steep enough
  // for the rock to come through the snow (the shader shows it from ~29
  // degrees on a rib).
  const rnd = mulberry(7011);
  const o = {};
  const hs = [];
  let steep = 0, n = 0;
  while (n < 20000) {
    const x = (rnd() * 2 - 1) * HALF, z = -800 - rnd() * (HALF - 800);
    if (B.weightsAt(x, z, wq)[BIOME.alpine] < 0.9 || B.roadDist(x, z) < 300) continue;
    const r = g.sample(x, z, o);
    hs.push(B.relief(x, z));
    if (r.ny < 0.875) steep++;
    n++;
  }
  hs.sort((a, c) => a - c);
  check('the mountains stand tall, with rock showing', hs[Math.floor(n * 0.9)] > 200 && steep / n > 0.3,
    `relief p50 ${hs[n >> 1].toFixed(0)} m, p90 ${hs[Math.floor(n * 0.9)].toFixed(0)} m; ${(steep / n * 100).toFixed(0)}% of the range steeper than 29 degrees`);
}

// ---- Landmarks ------------------------------------------------------------------------------
{
  const L = w.landmarks || [];
  const of = (t) => L.filter((l) => l.type === t);
  const arches = of('arch'), hoodoos = of('hoodoo'), lights = of('lighthouse'), poles = of('snowpole');
  check('every biome that has landmarks has them', arches.length >= 2 && hoodoos.length >= 20 && lights.length === 1 && poles.length >= 100,
    `${arches.length} arches, ${hoodoos.length} hoodoos, ${lights.length} lighthouse, ${poles.length} snow poles`);

  // An arch must span its road: the road passes under its middle, square to
  // it, with both feet well off the carriageway and the crown high overhead.
  const road = {};
  let badArch = 0;
  const archNote = [];
  for (const a of arches) {
    g.roadAt(a.x, a.z, road);
    const acrossX = Math.cos(a.rot), acrossZ = -Math.sin(a.rot);
    const square = road.edge ? Math.abs(road.tx * acrossX + road.tz * acrossZ) : 1;
    const feet = a.span * 0.5 - (road.width || 0) * 0.5;
    const clear = a.height - (g.heightAt(a.x, a.z) - a.y);
    if (!road.edge || road.dist > 3 || square > 0.1 || feet < 10 || clear < 14 || B.weightsAt(a.x, a.z, wq)[BIOME.desert] < 0.9) badArch++;
    archNote.push(`${feet.toFixed(0)} m to each foot, ${clear.toFixed(0)} m clear`);
  }
  check('each arch spans its road, with room to drive under', badArch === 0 && arches.length > 0,
    `${badArch} wrong; ${archNote.join('; ')}`);

  let badHoodoo = 0;
  for (const h of hoodoos) {
    g.roadAt(h.x, h.z, road);
    const edge = road.edge ? road.dist - road.width * 0.5 : Infinity;
    const infield = (w.circuits || []).some((c) => (c.x - h.x) ** 2 + (c.z - h.z) ** 2 < (c.r * 1.3) ** 2);
    if (edge < 18 || infield || B.weightsAt(h.x, h.z, wq)[BIOME.desert] < 0.85 || Math.abs(h.y - g.heightAt(h.x, h.z)) > 0.05) badHoodoo++;
  }
  check('hoodoos stand in the canyon, off every road and infield', badHoodoo === 0,
    `${badHoodoo} of ${hoodoos.length} too near a road, in an infield, outside the canyon or off the ground`);

  let lightNote = 'none';
  let lightOk = false;
  for (const l of lights) {
    let sea = Infinity;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      for (let d = 10; d <= 200; d += 10) if (B.seaAt(l.x + Math.cos(a) * d, l.z + Math.sin(a) * d) > 0.5) { sea = Math.min(sea, d); break; }
    }
    const rd = g.nearestRoad(l.x, l.z, 400);
    const up = l.y - B.seaLevel;
    lightOk = sea <= 150 && up >= 7 && rd && rd.dist < 250;
    lightNote = `sea ${sea} m away, ${up.toFixed(0)} m above it, ${rd ? rd.dist.toFixed(0) : '-'} m from a road`;
  }
  check('the lighthouse stands over the sea, in sight of a road', lightOk, lightNote);

  let badPole = 0;
  for (const p of poles) {
    g.roadAt(p.x, p.z, road);
    const edge = road.edge ? road.dist - road.width * 0.5 : Infinity;
    if (edge < 1.2 || edge > 4 || B.weightsAt(p.x, p.z, wq)[BIOME.alpine] < 0.55) badPole++;
  }
  check('snow poles line the pass, off the carriageway', badPole === 0,
    `${badPole} of ${poles.length} on the road, too far from it, or off the pass`);

  // Named on the maps, so they are somewhere to drive to and to meet.
  const named = w.districts.filter((d) => d.kind === 'landmark');
  const unique = new Set(named.map((d) => d.name)).size === named.length;
  const onIt = named.every((d) => L.some((l) => l.x === d.cx && l.z === d.cz));
  check('the landmarks are named on the maps', named.length >= arches.length + lights.length + 1 && unique && onIt,
    named.map((d) => d.name).join(', '));

  // Invented, and not only by brandcheck's list: the first names were a
  // superhero's and a line-calling system's mark ("Hawkeye") and two real
  // rock formations ("Keyhole Arch", "The Chimneys"). The words of famous
  // real arches, stacks and hoodoo fields; whole words, case-insensitive.
  // (Brand names stay in brandcheck, which scans this file too.)
  const REAL = ['hawkeye', 'hawk-eye', 'keyhole', 'chimneys', 'chimney rock', 'delicate', 'landscape arch',
    'double arch', 'mesa arch', 'corona arch', 'rainbow bridge', 'toadstool', 'goblin', 'fairy chimneys',
    'needles', 'pinnacles', 'bryce'];
  const borrowed = named.filter((d) => REAL.some((b) => new RegExp(`(^|[^a-z])${b}([^a-z]|$)`).test(d.name.toLowerCase())));
  check('no landmark borrows a real formation or a mark', borrowed.length === 0,
    borrowed.length ? borrowed.map((d) => d.name).join(', ') : `${named.length} names, none on the list of ${REAL.length}`);

  // Each says its name (main.js districtAt) the first time a car comes within
  // r of it: from the road, where kids drive and where map travel lands. The
  // stand first named sat 60.1 m from the nearest centreline with r = 60, so
  // its name could never be said. A car anywhere across a 20 m carriageway
  // at its nearest point has to be inside r.
  let deaf = 0, slack = Infinity;
  const reachNote = [];
  for (const d of named) {
    const rd = g.nearestRoad(d.cx, d.cz, 600);
    const s = rd ? d.r - (rd.dist + 10) : -Infinity;
    if (s < 0) deaf++;
    slack = Math.min(slack, s);
    reachNote.push(`${d.name} ${rd ? rd.dist.toFixed(0) : '-'}/${d.r.toFixed(0)} m`);
  }
  check('every landmark says its name from the road', deaf === 0,
    `${deaf} out of earshot (road/radius): ${reachNote.join(', ')}; least slack ${slack.toFixed(0)} m`);
}

// ---- Budget ------------------------------------------------------------------------------
{
  const props = createProps(w, g);
  const terrain = createTerrain(w, g);
  const cam = new THREE.Vector3();
  // The water and the canopy recolour both patch three's own shaders; check
  // they found their anchors in this three.js.
  const ws = { uniforms: {}, vertexShader: THREE.ShaderLib.phong.vertexShader, fragmentShader: THREE.ShaderLib.phong.fragmentShader };
  terrain.water.material.onBeforeCompile(ws);
  const cm = props.group.children.find((m) => m.name === 'oak.near').material;
  const cs = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  cm.onBeforeCompile(cs);
  check('the sea and the canopy colour find their shader anchors', ws.fragmentShader.includes('orSea') && cs.fragmentShader.includes('orBiomeLeaf'),
    `sea ${ws.fragmentShader.includes('orSea')}, canopy ${cs.fragmentShader.includes('orBiomeLeaf')} (r${THREE.REVISION})`);

  // At each biome's label (beside the loop road, where a kid first arrives),
  // and at the densest wood of each: what one frame submits, per tier.
  const LIMIT = { high: 600000, medium: 400000, low: 160000 };
  console.log('\n  where               tier    prop calls  chunks  sea  prop tris   ground tris  grass tris');
  let over = 0;
  for (let b = 0; b < BIOME_COUNT; b++) {
    for (const tier of ['high', 'medium', 'low']) {
      props.setQuality(tier); terrain.setQuality(tier);
      const [x, z] = BIOMES[b].at;
      cam.set(x, g.heightAt(x, z) + 2, z);
      props.update(cam, 0); terrain.update(cam, 0);
      // Drained, so the table is what stands there once streaming has
      // caught up, not whatever the per-frame budget had built by then.
      for (let i = 0; i < 60 || (terrain.stats.pending > 0 && i < 4000); i++) { props.update(cam, 1 / 60); terrain.update(cam, 1 / 60); }
      const d = props.drawn();
      const sea = terrain.water && terrain.water.visible;
      if (d.triangles > LIMIT[tier]) over++;
      console.log(`  ${BIOMES[b].name.padEnd(20)}${tier.padEnd(8)}${String(d.calls).padStart(6)}    ${String(terrain.stats.chunks).padStart(6)}   ${sea ? ' 1 ' : ' - '} ${String(d.triangles).padStart(8)}    ${String(terrain.stats.triangles).padStart(8)}    ${String(terrain.stats.grass.triangles).padStart(8)}`);
    }
  }
  console.log('');
  // Tumbleweeds roll only in the canyon, and never out of bounds or into
  // the air: after 20 s at each biome's heart, how many are drawn and how
  // far off the ground the lowest point of any can be.
  const tw = props.group.children.find((m) => m.name === 'tumbleweeds');
  const rolling = [];
  let floating = 0;
  for (let b = 0; b < BIOME_COUNT; b++) {
    const [x, z] = BIOMES[b].at;
    cam.set(x, g.heightAt(x, z) + 2, z);
    for (let i = 0; i < 1200; i++) props.update(cam, 1 / 60);
    rolling.push(tw ? tw.count : 0);
    const a = tw.instanceMatrix.array;
    for (let i = 0; i < tw.count; i++) {
      const s0 = Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]);
      const bottom = a[i * 16 + 13] - 0.55 * s0 * 0.92;
      const gy = g.heightAt(a[i * 16 + 12], a[i * 16 + 14]);
      if (!Number.isFinite(bottom) || bottom - gy > 0.5 * s0 + 0.05 || bottom < gy - 0.05) floating++;
    }
  }
  check('tumbleweeds roll in the canyon and nowhere else, on the ground', rolling[BIOME.desert] >= 4 && floating === 0 &&
    rolling.every((n, b) => b === BIOME.desert || n === 0),
    BIOMES.map((q, b) => `${q.key} ${rolling[b]}`).join(', ') + `; ${floating} off the ground or airborne past a hop`);
  check('every biome fits the per-tier prop budget at its heart', over === 0,
    `${over} biome-tier cases over ${LIMIT.high}/${LIMIT.medium}/${LIMIT.low} triangles (the nature harness's densest-wood limits)`);
  props.dispose(); terrain.dispose();
}

console.log(fail === 0 ? '\nAll biome checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
