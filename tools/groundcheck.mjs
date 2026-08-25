// Proves the ground query is safe for the physics to stand on.
//
// Every check corresponds to a defect that actually occurred:
//   TOTAL       sampling far off the map returned NaN and the car vanished.
//   C0          picking the nearest of several roads produced a 3.9 m cliff.
//   C1          linear interpolation kinked the slope every few metres, which
//               a suspension reads as a washboard and answers with a launch.
//   JUNCTIONS   averaging roads sagged every intersection by up to 1.74 m.
//
// DETERMINISTIC. Every sample point comes from a seeded generator, because the
// verge check used Math.random and swung between 0.24% and 0.65% run to run
// with its threshold sitting inside that band — so the same code passed or
// failed depending on the dice. A flaky harness is worse than no harness: it
// teaches you to re-run until it goes green.
//
// The gradient check is split deliberately. The SOLVER's output is the road,
// and it is held to its cap exactly. What the height field then reconstructs
// between its grid cells is a separate question with its own budget, and
// conflating the two hid which of them was actually at fault — the answer,
// measured, was neither: the solver is exact and the field tracks it to about
// a centimetre, while the tail of the reconstruction is what drove the
// sampled number.
import { buildWorld, pointOnEdge, gradeCap, isLoose } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { mulberry } from '../src/world/noise.js';

const w = buildWorld();
const g = createGround(w);
const out = {};
const rnd = mulberry(20260823);          // any fixed seed; the point is that it is fixed
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) fail++;
};

console.log(`world: ${w.nodes.length} junctions, ${w.edges.length} roads, ` +
  `${(w.edges.reduce((a, e) => a + e.length, 0) / 1000).toFixed(1)} km, ` +
  `${w.circuits.length} circuits\n`);

// ---- Totality ------------------------------------------------------------
let nonFinite = 0, worstY = 0;
for (let i = 0; i < 300000; i++) {
  const R = i % 7 === 0 ? 9000 : 2048;
  const r = g.sample((rnd() * 2 - 1) * R, (rnd() * 2 - 1) * R, out);
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
check('junctions sit at the designed height', nodeAvg < 0.06 && nodeBad < w.nodes.length * 0.02,
  `mean ${(nodeAvg * 100).toFixed(2)} cm, ${nodeBad}/${w.nodes.length} over 25 cm, worst ${(nodeErr * 100).toFixed(0)} cm`);

// ---- The solver's own output --------------------------------------------
// This is the road. If it is over its cap, the road is wrong.
{
  let over = 0, n = 0, worst = 0, worstKind = '';
  for (const e of w.edges) {
    for (let k = 1; k < e.pts.length; k++) {
      const a = e.pts[k - 1], b = e.pts[k];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 0.05) continue;
      const grade = Math.abs(b.y - a.y) / d;
      n++;
      if (grade > gradeCap(e.kind) * 1.02) over++;
      if (grade > worst) { worst = grade; worstKind = e.kind; }
    }
  }
  check('roads are shaped within their gradient cap', over === 0,
    `${over}/${n} segments over cap, steepest ${(worst * 100).toFixed(0)}% on ${worstKind}`);
}

// ---- What the height field makes of it -----------------------------------
{
  const err = [];
  for (const e of w.edges) {
    const N = Math.floor(e.length / 0.5);
    for (let k = 0; k <= N; k++) {
      const p = pointOnEdge(e, k * 0.5);
      err.push(Math.abs(g.sample(p.x, p.z, out).y - p.y));
    }
  }
  err.sort((a, b) => a - b);
  const median = err[err.length >> 1], p99 = err[Math.floor(err.length * 0.99)];
  check('the field reproduces the road it was pinned to', median < 0.03 && p99 < 0.20,
    `median ${(median * 100).toFixed(1)} cm, p99 ${(p99 * 100).toFixed(1)} cm, ` +
    `max ${(err[err.length - 1] * 100).toFixed(0)} cm over ${err.length} samples`);
}

// ---- No cliffs along a road ----------------------------------------------
// A bound on what the car actually drives over, well above the shaped gradient
// but far below anything that could unsettle it. tools/vehiclecheck.mjs is what
// proves the car copes; this catches a step appearing where none belongs.
const STEP = 0.25;
let cliffs = 0, samples = 0, worstGrade = 0;
let pavedKink = 0, pavedN = 0, looseKink = 0, looseN = 0, kinkSum = 0, kinkN = 0, worstKink = 0;
for (const e of w.edges) {
  const n = Math.floor(e.length / STEP);
  if (n < 4) continue;
  const loose = isLoose(e.kind);
  let ym2 = null, ym1 = null;
  for (let k = 0; k <= n; k++) {
    const p = pointOnEdge(e, k * STEP);
    const y = g.sample(p.x, p.z, out).y;
    if (ym1 !== null) {
      samples++;
      const grade = Math.abs(y - ym1) / STEP;
      if (grade > 0.75) cliffs++;
      worstGrade = Math.max(worstGrade, grade);
    }
    if (ym2 !== null) {
      const kink = Math.abs(y - 2 * ym1 + ym2);
      kinkSum += kink; kinkN++;
      worstKink = Math.max(worstKink, kink);
      if (loose) { looseN++; if (kink > 0.005) looseKink++; }
      else { pavedN++; if (kink > 0.005) pavedKink++; }
    }
    ym2 = ym1; ym1 = y;
  }
}
check('no cliffs along a road', cliffs / samples < 0.0005,
  `${cliffs}/${samples} steps over 75%, steepest ${(worstGrade * 100).toFixed(0)}%`);
check('C1 on paved roads: no slope kinks', pavedKink / pavedN < 0.02,
  `${pavedKink}/${pavedN} over 5 mm (${(pavedKink / pavedN * 100).toFixed(2)}%), mean ${(kinkSum / kinkN * 1000).toFixed(3)} mm`);
check('C1 on loose roads: rough but not broken', looseKink / looseN < 0.03,
  `${looseKink}/${looseN} over 5 mm (${(looseKink / looseN * 100).toFixed(2)}%), worst ${(worstKink * 1000).toFixed(0)} mm`);

// ---- Crossing the verge --------------------------------------------------
let vergeBad = 0, vergeN = 0, worstVerge = 0;
for (let t = 0; t < 900; t++) {
  const e = w.edges[(rnd() * w.edges.length) | 0];
  const p = pointOnEdge(e, rnd() * e.length);
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
check('C0 across the verge', vergeBad / vergeN < 0.012,
  `${vergeBad}/${vergeN} steps over 9 cm (${(vergeBad / vergeN * 100).toFixed(3)}%), worst ${(worstVerge * 100).toFixed(1)} cm`);

// ---- Leaving the carriageway ---------------------------------------------
// Circuits and country roads now, since there are no city streets left. The
// old version filtered for 'street' and 'avenue' and silently sampled nothing.
{
  let bad = 0, n = 0, worst = 0;
  const drivable = w.edges.filter((e) => e.kind === 'circuit' || e.kind === 'rural');
  for (let t = 0; t < 900; t++) {
    const e = drivable[(rnd() * drivable.length) | 0];
    const p = pointOnEdge(e, rnd() * e.length);
    let prev = null;
    for (let d = e.width / 2 - 2; d < e.width / 2 + 8; d += 0.25) {
      const y = g.sample(p.x + p.nx * d, p.z + p.nz * d, out).y;
      if (prev !== null) { n++; const s = Math.abs(y - prev); if (s > 0.09) bad++; worst = Math.max(worst, s); }
      prev = y;
    }
  }
  check('leaving the carriageway is not a step', n > 1000 && bad / n < 0.012,
    `${bad}/${n} over 9 cm, worst ${(worst * 100).toFixed(1)} cm`);
}

// ---- Normals -------------------------------------------------------------
let badN = 0, minUp = 1;
for (let i = 0; i < 120000; i++) {
  const r = g.sample((rnd() * 2 - 1) * 2048, (rnd() * 2 - 1) * 2048, out);
  if (Math.abs(Math.hypot(r.nx, r.ny, r.nz) - 1) > 1e-6) badN++;
  minUp = Math.min(minUp, r.ny);
}
check('normals unit-length and upward', badN === 0 && minUp > 0.25,
  `${badN} non-unit, steepest ny ${minUp.toFixed(3)}`);

// ---- The carriageway is level across its width ---------------------------
{
  let bad = 0, n = 0, worst = 0;
  for (let t = 0; t < 1500; t++) {
    const e = w.edges[(rnd() * w.edges.length) | 0];
    const p = pointOnEdge(e, rnd() * e.length);
    const mid = g.sample(p.x, p.z, out).y;
    for (const sgn of [1, -1]) {
      const y = g.sample(p.x + p.nx * sgn * e.width * 0.35, p.z + p.nz * sgn * e.width * 0.35, out).y;
      n++;
      if (Math.abs(y - mid) > 0.20) bad++;
      worst = Math.max(worst, Math.abs(y - mid));
    }
  }
  check('carriageway is level across its width', bad / n < 0.01,
    `${bad}/${n} over 20 cm, worst ${(worst * 100).toFixed(1)} cm`);
}

// ---- Coverage ------------------------------------------------------------
const NS = 200000; const mats = {};
for (let i = 0; i < NS; i++) {
  const r = g.sample((rnd() * 2 - 1) * 2048, (rnd() * 2 - 1) * 2048, out);
  mats[r.surface] = (mats[r.surface] || 0) + 1;
}
console.log(`\nsurface mix: ${Object.entries(mats).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(v / NS * 100).toFixed(1)}%`).join('  ')}`);
console.log(`field: ${g.stats.gridN}x${g.stats.gridN} @ ${(g.field.delta.byteLength / 1048576).toFixed(1)} MB, ` +
  `${g.stats.pinnedCells} pinned / ${g.stats.bandCells} relaxed`);

console.log(fail === 0 ? '\nAll ground checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
