// Proves the countryside is planted where it should be and costs what it says.
//
// Headless, like every harness here: the props and terrain layers build in
// Node (textures are DataTextures, nothing touches the DOM), so everything
// below is measured on the same objects the browser draws. What a harness
// cannot see is the picture; the owner's checklist in the makeover notes says
// what to look at for that.
//
// Every check maps to something that either went wrong while this was built
// or would be invisible until a player found it:
//   PLACEMENT   a tree on a carriageway, in a circuit's run-off, in a building
//               or on a garage forecourt is a wall the car drives through.
//   GROUNDED    a prop floating or buried because it took its height from the
//               wrong surface.
//   COVER       the valley was a kilometre-wide beach (20% of the map) and the
//               map had no woodland at all; both are measured now.
//   BUDGET      the densest block of forest on the map, per quality tier, in
//               triangles actually submitted — the number that decides whether
//               'high' holds on an ordinary laptop.
//   LOD BANDS   adjacent levels must hand over at the same distance or trees
//               vanish (gap) or double up (overlap) at the boundary.
//   INJECTION   every shader change is anchored on a three.js chunk name; if an
//               upgrade renames one, the material silently draws plain. This
//               compiles each patch against the real ShaderLib and checks it took.
//   GRASS       tufts only on turf, never on a road or its shoulder.
//   DETERMINISM the same seed must give the same forest, or the harnesses and
//               the browser are looking at different worlds.
import * as THREE from 'three';
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { mulberry } from '../src/world/noise.js';
import { createProps, TIERS } from '../src/render/props.js';
import { createTerrain } from '../src/render/terrain.js';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) fail++;
};
const now = () => performance.now();

let t = now();
const w = buildWorld();
const g = createGround(w);
w.buildLots(g);
const tLots = now();
w.buildProps(g);
const plantMs = now() - tLots;
console.log(`world built in ${((now() - t) / 1000).toFixed(1)} s, planting ${plantMs.toFixed(0)} ms, ${w.props.length} props\n`);

const byType = {};
for (const p of w.props) byType[p.type] = (byType[p.type] || 0) + 1;
const trees = w.props.filter((p) => p.type === 'tree');
const bushes = w.props.filter((p) => p.type === 'bush');

// ---- Determinism ---------------------------------------------------------
{
  const w2 = buildWorld();
  const g2 = createGround(w2);
  w2.buildLots(g2);
  w2.buildProps(g2);
  let same = w2.props.length === w.props.length;
  for (let i = 0; same && i < w.props.length; i += 97) {
    const a = w.props[i], b = w2.props[i];
    same = a.type === b.type && a.x === b.x && a.z === b.z && a.variant === b.variant && a.scale === b.scale;
  }
  check('the same seed plants the same forest', same, `${w.props.length} props, every 97th compared field by field`);
}

// ---- Placement ------------------------------------------------------------
{
  const road = {};
  let onRoad = 0, runoff = 0, worstEdge = Infinity, worstKind = '';
  let bushOnRoad = 0;
  for (const p of w.props) {
    if (p.type !== 'tree' && p.type !== 'bush' && p.type !== 'rock') continue;
    g.roadAt(p.x, p.z, road);
    if (!road.edge) continue;
    const edge = road.dist - road.width * 0.5;
    const need = p.type === 'tree' ? 4.0 : p.type === 'bush' ? 2.0 : 2.5;
    const circuit = road.kind === 'circuit' || road.kind === 'rallyx';
    if (edge < need) { if (p.type === 'bush') bushOnRoad++; else onRoad++; }
    if (circuit && p.type !== 'rock' && edge < 12) runoff++;
    if (p.type === 'tree' && edge < worstEdge) { worstEdge = edge; worstKind = road.kind; }
  }
  check('no tree or boulder within reach of a carriageway', onRoad === 0,
    `${onRoad} too close; nearest tree ${worstEdge.toFixed(1)} m from the edge of a ${worstKind}`);
  check('no shrub on a carriageway or its shoulder', bushOnRoad === 0, `${bushOnRoad} shrubs inside 2 m of an edge`);
  check('circuit run-off kept clear (12 m)', runoff === 0, `${runoff} trees or shrubs in a circuit's run-off`);

  let inLot = 0, onForecourt = 0;
  for (const p of w.props) {
    if (p.type !== 'tree' && p.type !== 'bush' && p.type !== 'rock') continue;
    for (const lot of w.lots) {
      const r = Math.hypot(lot.w, lot.d) * 0.5 + 2;
      if ((p.x - lot.x) ** 2 + (p.z - lot.z) ** 2 < r * r) { inLot++; break; }
    }
    for (const gar of w.garages) {
      if ((p.x - gar.x) ** 2 + (p.z - gar.z) ** 2 < 30 * 30) { onForecourt++; break; }
    }
  }
  check('nothing grows in a building', inLot === 0, `${inLot} inside a building footprint (+2 m)`);
  check('garage forecourts are clear (30 m)', onForecourt === 0, `${onForecourt} within 30 m of a garage pad`);

  let out = 0;
  for (const p of w.props) if (Math.abs(p.x) > w.half || Math.abs(p.z) > w.half) out++;
  check('everything is on the map', out === 0, `${out} outside +-${w.half} m`);
}

// ---- Grounded -------------------------------------------------------------
{
  let worst = 0, bad = 0, n = 0;
  for (const p of w.props) {
    if (p.type === 'streetlight' || p.type === 'polelight') continue;
    const e = Math.abs(p.y - g.heightAt(p.x, p.z));
    n++;
    if (e > 0.05) bad++;
    worst = Math.max(worst, e);
  }
  check('every plant and rock stands on the ground', bad === 0, `${bad}/${n} more than 5 cm off it, worst ${(worst * 100).toFixed(1)} cm`);
}

// ---- Cover ----------------------------------------------------------------
{
  const ha = new Map();
  for (const p of trees) {
    const k = Math.floor(p.x / 100) * 100000 + Math.floor(p.z / 100);
    ha.set(k, (ha.get(k) || 0) + 1);
  }
  let wooded = 0;
  for (const v of ha.values()) if (v >= 80) wooded++;
  const cells = Math.ceil(w.half * 2 / 100) ** 2;
  const woodFrac = wooded / cells;
  check('there is woodland, and it is not everywhere', woodFrac > 0.08 && woodFrac < 0.40,
    `${(woodFrac * 100).toFixed(1)}% of hectares hold 80+ trees; ${trees.length} trees, ${bushes.length} shrubs`);

  const sp = [0, 0, 0, 0, 0, 0];
  for (const p of trees) sp[p.variant]++;
  const names = ['oak', 'spruce', 'birch', 'pine', 'beech', 'fir'];
  const minShare = Math.min(...sp) / trees.length;
  const conifer = (sp[1] + sp[3] + sp[5]) / trees.length;
  check('every species is actually planted', minShare > 0.02,
    names.map((n, i) => `${n} ${(sp[i] / trees.length * 100).toFixed(0)}%`).join(' '));
  check('conifers and broadleaves both hold ground', conifer > 0.15 && conifer < 0.6, `${(conifer * 100).toFixed(0)}% conifer`);

  const mats = {};
  const o = {};
  const rnd = mulberry(4242);
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const r = g.sample((rnd() * 2 - 1) * w.half, (rnd() * 2 - 1) * w.half, o);
    mats[r.surface] = (mats[r.surface] || 0) + 1;
  }
  const sand = (mats.sand || 0) / N, grass = (mats.grass || 0) / N;
  check('the valley is a valley, not a beach', sand < 0.03 && grass > 0.8,
    `sand ${(sand * 100).toFixed(1)}% (was 20.1%), grass ${(grass * 100).toFixed(1)}% (was 72.7%)`);
}

// ---- Layers ---------------------------------------------------------------
t = now();
const props = createProps(w, g);
const propsMs = now() - t;
t = now();
const terrain = createTerrain(w, g);
const terrainMs = now() - t;
console.log(`\nprops layer ${propsMs.toFixed(0)} ms (${JSON.stringify(props.stats.buildMs)}), terrain layer ${terrainMs.toFixed(0)} ms`);
console.log('species (triangles near / mid / far):');
for (const s of props.stats.species) {
  console.log(`  ${s.name.padEnd(8)} ${String(s.nearTris).padStart(4)} / ${String(s.midTris).padStart(3)} / ${s.farTris}   ` +
    `${s.height.toFixed(1)} m tall, ${(s.spread * 2).toFixed(1)} m across`);
}
console.log('');

{
  let ok = true, worst = '';
  for (const s of props.stats.species) {
    if (!(s.midTris <= s.nearTris * 0.45)) { ok = false; worst = s.name; }
  }
  check('the mid level is a real saving over the near', ok, ok ? 'every species under 45% of its near count' : `${worst} is not`);
}

// Densest 64 m block of trees on the map — the worst place to stand.
const block = new Map();
for (const p of trees) {
  const k = `${Math.floor(p.x / 64)},${Math.floor(p.z / 64)}`;
  block.set(k, (block.get(k) || 0) + 1);
}
const [densest, dCount] = [...block.entries()].sort((a, b) => b[1] - a[1])[0];
const [bx, bz] = densest.split(',').map((v) => (Number(v) + 0.5) * 64);
const LIMIT = { high: 600000, medium: 400000, low: 160000 };
const cam = new THREE.Vector3();
const place = (x, z) => cam.set(x, g.heightAt(x, z) + 2, z);

for (const tier of ['high', 'medium', 'low']) {
  props.setQuality(tier);
  terrain.setQuality(tier);
  place(bx, bz);
  props.update(cam, 0); terrain.update(cam, 0);
  for (let i = 0; i < 90; i++) { props.update(cam, 1 / 60); terrain.update(cam, 1 / 60); }
  const d = props.drawn();
  const gr = terrain.stats.grass.triangles;
  check(`${tier}: densest wood within budget`, d.triangles <= LIMIT[tier],
    `${d.triangles} prop tris (near ${d.byLevel.near}, mid ${d.byLevel.mid}, far ${d.byLevel.far}) <= ${LIMIT[tier]}; ` +
    `${d.calls} calls; ground ${terrain.stats.triangles}, grass ${gr}`);

  // Bands: each level's outer fade must be the next level's inner fade.
  const ms = {};
  for (const m of props.group.children) ms[m.name] = m;
  const U = (name) => {
    const m = ms[name];
    let u = null;
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    m.material.onBeforeCompile(shader);
    u = shader.uniforms.orLod.value;
    return u;
  };
  const T = TIERS[tier];
  const nearU = U('oak.near'), midU = U('oak.mid'), farU = U('oak.far');
  const seamA = T.near > 0 ? Math.abs(nearU.z - midU.x) + Math.abs(nearU.w - midU.y) : 0;
  const seamB = Math.abs(midU.z - farU.x) + Math.abs(midU.w - farU.y);
  check(`${tier}: levels hand over with no gap and no overlap`, seamA < 1e-6 && seamB < 1e-6,
    T.near > 0 ? `near->mid at ${nearU.z.toFixed(1)}-${nearU.w.toFixed(1)} m, mid->far at ${midU.z.toFixed(1)}-${midU.w.toFixed(1)} m`
      : `no near level; mid->far at ${midU.z.toFixed(1)}-${midU.w.toFixed(1)} m`);
}

// ---- Driving: per-frame cost, capacity, grass ------------------------------
{
  props.setQuality('high');
  terrain.setQuality('high');
  // A kilometre at 150 km/h, in a straight line through the densest wood on
  // the map — the worst case for streaming as well as for drawing. Ground
  // clearance does not matter to either layer, so it ignores the roads.
  let frames = 0;
  let pSum = 0, pMax = 0, tSum = 0, tMax = 0, saturated = 0, bad = 0;
  const speed = 42, dt = 1 / 60;
  const x0 = Math.max(-w.half + 50, bx - 500), dir = bx > 0 ? 1 : 1;
  place(x0, bz);
  props.update(cam, 0); terrain.update(cam, 0);
  while (frames < 1430) {
    place(Math.min(w.half - 50, x0 + dir * speed * dt * frames), bz);
    let t0 = now(); props.update(cam, dt); const tp = now() - t0;
    t0 = now(); terrain.update(cam, dt); const tt = now() - t0;
    pSum += tp; pMax = Math.max(pMax, tp); tSum += tt; tMax = Math.max(tMax, tt);
    for (const m of props.group.children) {
      if (m.isInstancedMesh && m.count > 0 && m.count >= m.instanceMatrix.count) saturated++;
    }
    frames++;
  }
  check('props: per-frame cost while driving', pSum / frames < 0.25 && pMax < 6,
    `mean ${(pSum / frames).toFixed(3)} ms, worst ${pMax.toFixed(2)} ms over ${frames} frames (1 km) at 150 km/h`);
  check('terrain + grass: per-frame cost while driving', tSum / frames < 4.5,
    `mean ${(tSum / frames).toFixed(2)} ms (chunk streaming budget 3 ms + grass 0.5 ms), worst ${tMax.toFixed(1)} ms`);
  check('no field ever runs out of instance capacity', saturated === 0, `${saturated} field-frames at capacity`);

  // Every live tuft: on turf, off the road.
  const gm = terrain.group.children.find((m) => m.name === 'grass');
  const P = gm.geometry.attributes.iPos.array;
  const road = {}, o = {};
  let live = 0;
  for (let i = 0; i < P.length; i += 4) {
    if (!(P[i + 3] > 0)) continue;
    live++;
    const r = g.sample(P[i], P[i + 2], o);
    g.roadAt(P[i], P[i + 2], road);
    const edge = road.edge ? road.dist - road.width * 0.5 : Infinity;
    if (r.surface !== 'grass' || edge < 1.5 || Math.abs(P[i + 1] + 0.03 - r.y) > 0.02) bad++;
  }
  check('grass grows on turf, never on a road', bad === 0 && live > 1000,
    `${bad}/${live} live tufts on the wrong surface, within 1.5 m of a carriageway, or off the ground`);

  let nan = 0;
  for (const m of props.group.children) {
    if (!m.isInstancedMesh) continue;
    const a = m.instanceMatrix.array;
    for (let i = 0; i < m.count * 16; i++) if (!Number.isFinite(a[i])) { nan++; break; }
  }
  check('no instance matrix is non-finite', nan === 0, `${nan} fields with a NaN or Infinity`);
}

// ---- Shader injection -----------------------------------------------------
{
  const seen = new Set();
  let broken = [];
  const kinds = [];
  const mats = [];
  for (const m of props.group.children) {
    if (seen.has(m.material)) continue;
    seen.add(m.material);
    mats.push([m.name, m.material]);
    if (m.customDepthMaterial && !seen.has(m.customDepthMaterial)) {
      seen.add(m.customDepthMaterial);
      mats.push([m.name + ' (shadow)', m.customDepthMaterial]);
    }
  }
  for (const [name, mat] of mats) {
    const key = mat.customProgramCacheKey && mat.customProgramCacheKey();
    if (!key || !key.startsWith('openroad')) continue;
    const lib = mat.isMeshDepthMaterial ? THREE.ShaderLib.depth : THREE.ShaderLib.lambert;
    const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    mat.onBeforeCompile(shader);
    const took = shader.vertexShader !== lib.vertexShader && shader.vertexShader.includes('orLod');
    kinds.push(key.replace('openroad-props-', ''));
    if (!took) broken.push(name);
  }
  const tm = terrain.material;
  const ts = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  tm.onBeforeCompile(ts);
  if (!ts.fragmentShader.includes('orMacro')) broken.push('terrain');
  const gm = terrain.group.children.find((m) => m.name === 'grass');
  const gs = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  gm.material.onBeforeCompile(gs);
  if (!gs.vertexShader.includes('orGWind')) broken.push('grass');
  check('every shader patch finds its anchors in this three.js', broken.length === 0,
    broken.length ? `did not take: ${broken.join(', ')}` : `${[...new Set(kinds)].join(', ')}, terrain, grass — r${THREE.REVISION}`);
}

console.log(`\ncost per tier (triangles submitted in the densest wood; see above), draw calls ~${props.stats.fields} fields`);
console.log(fail === 0 ? '\nAll nature checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
