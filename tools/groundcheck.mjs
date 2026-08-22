// Proves the ground query is safe for the physics to stand on.
//
// Every check corresponds to a defect that actually occurred, here or on the
// racing game before it:
//   TOTAL      sampling far off the map returned NaN and the car vanished.
//   C0         picking the nearest of several roads produced a 3.9 m cliff.
//   C1         linear interpolation kinked the slope every few metres, which a
//              suspension reads as a washboard and answers with a launch.
//   JUNCTIONS  averaging roads sagged every intersection by up to 1.74 m.
//
// Outliers are reported as counts, not just worst-case: one bad metre in 88 km
// is a jolt the car's anti-launch clamp absorbs, while a thousand is a broken
// surface. The two need telling apart.
import { buildWorld, pointOnEdge } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';

const w = buildWorld();
const g = createGround(w);
const out = {};
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`);
  if (!ok) fail++;
};

console.log(`world: ${w.nodes.length} junctions, ${w.edges.length} roads, ` +
  `${(w.edges.reduce((a, e) => a + e.length, 0) / 1000).toFixed(1)} km\n`);

// ---- Totality ------------------------------------------------------------
let nonFinite = 0, worstY = 0;
for (let i = 0; i < 300000; i++) {
  const R = i % 7 === 0 ? 9000 : 2048;          // deliberately off the map
  const r = g.sample((Math.random() * 2 - 1) * R, (Math.random() * 2 - 1) * R, out);
  if (!Number.isFinite(r.y) || !Number.isFinite(r.nx) || !Number.isFinite(r.ny) ||
      !Number.isFinite(r.nz) || !Number.isFinite(r.grip)) nonFinite++;
  worstY = Math.max(worstY, Math.abs(r.y));
}
check('total: no NaN/Inf over 300k samples', nonFinite === 0,
  `${nonFinite} bad, |y| max ${worstY.toFixed(1)} m`);

// ---- Junctions -----------------------------------------------------------
let nodeErr = 0, nodeAvg = 0, nodeBad = 0;
for (const n of w.nodes) {
  const e = Math.abs(g.sample(n.x, n.z, out).y - n.y);
  nodeErr = Math.max(nodeErr, e); nodeAvg += e;
  if (e > 0.25) nodeBad++;
}
nodeAvg /= w.nodes.length;
check('junctions sit at the designed height', nodeAvg < 0.05 && nodeBad < w.nodes.length * 0.02,
  `mean ${(nodeAvg * 100).toFixed(2)} cm, ${nodeBad}/${w.nodes.length} over 25 cm, worst ${(nodeErr * 100).toFixed(0)} cm`);

// ---- Along every road ----------------------------------------------------
const STEP = 0.25;
let steepCount = 0, samples = 0, worstGrade = 0;
let kinkCount = 0, worstKink = 0, kinkSum = 0, kinkN = 0;
for (const e of w.edges) {
  const n = Math.floor(e.length / STEP);
  if (n < 4) continue;
  const cap = (e.kind === 'dirt' || e.kind === 'track' ? 0.26 : 0.13);
  let ym2 = null, ym1 = null;
  for (let k = 0; k <= n; k++) {
    const p = pointOnEdge(e, k * STEP);
    const y = g.sample(p.x, p.z, out).y;
    if (ym1 !== null) {
      samples++;
      const grade = Math.abs(y - ym1) / STEP;
      if (grade > cap * 1.35) steepCount++;
      worstGrade = Math.max(worstGrade, grade);
    }
    if (ym2 !== null) {
      const kink = Math.abs(y - 2 * ym1 + ym2);
      kinkSum += kink; kinkN++;
      if (kink > 0.005) kinkCount++;
      worstKink = Math.max(worstKink, kink);
    }
    ym2 = ym1; ym1 = y;
  }
}
check('C0 along roads: grade stays drivable', steepCount / samples < 0.002,
  `${steepCount}/${samples} over cap (${(steepCount / samples * 100).toFixed(3)}%), worst ${(worstGrade * 100).toFixed(0)}%`);
// 5 mm of second difference over 25 cm is a ~2 m radius vertical curve; below
// that a suspension cannot tell it from a perfectly smooth road.
check('C1 along roads: no slope kinks', kinkCount / kinkN < 0.002 && kinkSum / kinkN < 0.0006,
  `mean ${(kinkSum / kinkN * 1000).toFixed(4)} mm, ${kinkCount}/${kinkN} over 5 mm, worst ${(worstKink * 1000).toFixed(1)} mm`);

// ---- Crossing the verge --------------------------------------------------
let vergeBad = 0, vergeN = 0, worstVerge = 0;
for (let t = 0; t < 900; t++) {
  const e = w.edges[(Math.random() * w.edges.length) | 0];
  const p = pointOnEdge(e, Math.random() * e.length);
  let prev = null;
  for (let d = -40; d <= 40; d += STEP) {
    const y = g.sample(p.x + p.nx * d, p.z + p.nz * d, out).y;
    if (prev !== null) {
      vergeN++;
      const step = Math.abs(y - prev);
      if (step > 0.09) vergeBad++;
      worstVerge = Math.max(worstVerge, step);
    }
    prev = y;
  }
}
check('C0 across the verge', vergeBad / vergeN < 0.004,
  `${vergeBad}/${vergeN} steps over 9 cm (${(vergeBad / vergeN * 100).toFixed(3)}%), worst ${(worstVerge * 100).toFixed(1)} cm`);

// ---- Leaving the carriageway --------------------------------------------
let kerbBad = 0, kerbN = 0, worstKerb = 0;
for (let t = 0; t < 900; t++) {
  const e = w.edges[(Math.random() * w.edges.length) | 0];
  if (e.kind !== 'street' && e.kind !== 'avenue') continue;
  const p = pointOnEdge(e, Math.random() * e.length);
  let prev = null;
  for (let d = e.width / 2 - 2; d < e.width / 2 + 8; d += 0.25) {
    const y = g.sample(p.x + p.nx * d, p.z + p.nz * d, out).y;
    if (prev !== null) { kerbN++; if (Math.abs(y - prev) > 0.09) kerbBad++; worstKerb = Math.max(worstKerb, Math.abs(y - prev)); }
    prev = y;
  }
}
check('leaving the carriageway is not a step', kerbBad / Math.max(1, kerbN) < 0.004,
  `${kerbBad}/${kerbN} over 9 cm, worst ${(worstKerb * 100).toFixed(1)} cm`);

// ---- Normals -------------------------------------------------------------
let badN = 0, minUp = 1;
for (let i = 0; i < 120000; i++) {
  const r = g.sample((Math.random() * 2 - 1) * 2048, (Math.random() * 2 - 1) * 2048, out);
  if (Math.abs(Math.hypot(r.nx, r.ny, r.nz) - 1) > 1e-6) badN++;
  minUp = Math.min(minUp, r.ny);
}
check('normals unit-length and upward', badN === 0 && minUp > 0.3,
  `${badN} non-unit, steepest ny ${minUp.toFixed(3)}`);

// ---- The carriageway is level across its width ---------------------------
let camberBad = 0, camberN = 0, worstCamber = 0;
for (let t = 0; t < 1500; t++) {
  const e = w.edges[(Math.random() * w.edges.length) | 0];
  const p = pointOnEdge(e, Math.random() * e.length);
  const mid = g.sample(p.x, p.z, out).y;
  for (const sgn of [1, -1]) {
    const y = g.sample(p.x + p.nx * sgn * e.width * 0.35, p.z + p.nz * sgn * e.width * 0.35, out).y;
    camberN++;
    if (Math.abs(y - mid) > 0.20) camberBad++;
    worstCamber = Math.max(worstCamber, Math.abs(y - mid));
  }
}
check('carriageway is level across its width', camberBad / camberN < 0.01,
  `${camberBad}/${camberN} over 20 cm, worst ${(worstCamber * 100).toFixed(1)} cm`);

// ---- Coverage ------------------------------------------------------------
const NS = 200000; const mats = {};
for (let i = 0; i < NS; i++) {
  const r = g.sample((Math.random() * 2 - 1) * 2048, (Math.random() * 2 - 1) * 2048, out);
  mats[r.surface] = (mats[r.surface] || 0) + 1;
}
console.log(`\nsurface mix: ${Object.entries(mats).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(v / NS * 100).toFixed(1)}%`).join('  ')}`);
console.log(`field: ${g.stats.gridN}x${g.stats.gridN} @ ${(g.field.delta.byteLength / 1048576).toFixed(1)} MB, ` +
  `${g.stats.pinnedCells} pinned / ${g.stats.bandCells} relaxed`);

console.log(fail === 0 ? '\nAll ground checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
