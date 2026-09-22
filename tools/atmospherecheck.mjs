// Proves the built world and the light it sits in are what they claim to be.
//
// Headless checks cannot see the screen, so this measures the things that made
// the screen wrong, each one a defect that actually shipped:
//
//   ROADS
//   MOSAIC      a 24 m tile got 150-304 texels down the road against 512
//               across: 8-16 cm per texel along, 1.5-2.3 cm across, five to
//               nine times longer than wide. Near the car every texel became
//               a visible block. Checked: texel size and aspect, every layer.
//   WRONG ROW   roads have drawn with another surface's texture before (the
//               atlas was sampled mirrored). Checked: every edge's layer was
//               painted by the painter for its own surface.
//   SEAMS       variants exist so a pothole does not repeat every 24 m, which
//               only works if any variant can follow any other. Checked:
//               every ordered pair joins like an ordinary row step, and every
//               layer wraps onto itself.
//   HEXAGONS    on every crest the terrain came up through the middle of the
//               8 m road quads as a dark polygon. Checked: how much of the
//               drawn ribbon lies below the ground it stands on.
//   NEUTRAL     the detail layer adds grain; it must not shift the colour the
//               macro layer chose. Checked: its albedo multiplier averages 1.
//
// DETERMINISTIC: the world is built from its fixed seed and every sample point
// comes from the geometry or a seeded generator.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { mulberry } from '../src/world/noise.js';
import { createRoads } from '../src/render/roads.js';

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) fail++;
};

const world = buildWorld();
const ground = createGround(world);
const t0 = performance.now();
const roads = createRoads(world, ground);
const buildMs = performance.now() - t0;
const { specs, atlas, detail } = roads.debug;
const st = roads.stats;
console.log(`roads: ${st.families} surfaces in ${st.layers} layers of ${st.layer}, ` +
  `${st.drawCalls} draw calls, ${st.triangles} triangles, ${st.vertices} vertices, ` +
  `${st.textureMB} MB of texture, built in ${buildMs.toFixed(0)} ms\n`);

// ---------------------------------------------------------------------------
// MOSAIC — texel size and shape
// ---------------------------------------------------------------------------
{
  const TILE = 24;
  const along = TILE / atlas.height;
  let worstAcross = 0, worstAspect = 0, worstName = '';
  for (const s of specs) {
    // The kerb's U runs up an 8.5 cm face. Junction fills are mapped across
    // the whole junction in both axes, so their texel is set by the junction's
    // size, not the layer — and they carry no marking or crack fine enough to
    // alias. Both are measured by the other checks, not this one.
    if (s.paint === 'kerb' || s.kind === 'patch') continue;
    const across = s.width / atlas.width;
    const aspect = Math.max(along / across, across / along);
    if (across > worstAcross) worstAcross = across;
    if (aspect > worstAspect) { worstAspect = aspect; worstName = `${s.paint} ${s.width} m`; }
  }
  check('texels along the road are at most 3 cm', along <= 0.03,
    `${(along * 100).toFixed(2)} cm (was 7.9-16 cm)`);
  check('texels across the road are at most 5 cm', worstAcross <= 0.05,
    `worst ${(worstAcross * 100).toFixed(2)} cm`);
  check('texels are near-square, not long blocks', worstAspect <= 2.1,
    `worst ${worstAspect.toFixed(2)}:1 on ${worstName} (was 5-9:1)`);
}

// ---------------------------------------------------------------------------
// WRONG ROW — each edge samples its own surface
// ---------------------------------------------------------------------------
{
  let bad = 0, seen = 0;
  const DETAIL = { asphalt: 0, gravel: 1, dirt: 2 };
  let badDetail = 0;
  for (const e of world.edges) {
    const fam = roads.debug.familyOfEdge(e.i);
    if (!fam) continue;
    seen++;
    const want = e.surface === 'asphalt' ? 'paved' : 'loose';
    if (fam.paint !== want) bad++;
    const d = DETAIL[fam.surface];
    if (e.surface === 'asphalt' ? d !== 0 : d === 0) badDetail++;
  }
  check('every road is painted as its own surface', bad === 0, `${bad} of ${seen} edges wrong`);
  check('every road gets its own surface detail', badDetail === 0, `${badDetail} of ${seen} edges wrong`);

  // Every vertex's layer and detail index must exist, and nothing is NaN.
  let out = 0, nan = 0, verts = 0, fringeBad = 0;
  for (const m of roads.group.children) {
    const a = m.geometry.attributes;
    const r = a.aRoad.array, p = a.position.array, uv = a.uv.array;
    for (let i = 0; i < r.length / 3; i++) {
      verts++;
      if (r[i * 3] < 0 || r[i * 3] >= atlas.layers || r[i * 3] !== Math.floor(r[i * 3])) out++;
      if (r[i * 3 + 1] < -1 || r[i * 3 + 1] >= detail.layers) out++;
      if (r[i * 3 + 2] !== 0 && r[i * 3 + 2] !== 1) fringeBad++;
      if (!Number.isFinite(p[i * 3] + p[i * 3 + 1] + p[i * 3 + 2] + uv[i * 2] + uv[i * 2 + 1])) nan++;
    }
  }
  check('every vertex addresses a real layer', out === 0 && fringeBad === 0,
    `${out} out of range, ${fringeBad} bad fringe values, over ${verts} vertices`);
  check('no vertex is NaN or infinite', nan === 0, `${nan} bad`);
}

// ---------------------------------------------------------------------------
// SEAMS — variants interchangeable, every layer wraps
// ---------------------------------------------------------------------------
{
  const W = atlas.width, H = atlas.height, per = W * H * 4;
  // Any variant may follow any other, so the step from the last row of one to
  // the first row of another must look like an ordinary step between rows.
  let worstPair = 0, pairs = 0;
  const step = (La, ya, Lb, yb, tex) => {
    let s = 0;
    for (let x = 0; x < W; x++) {
      const a = La * per + (ya * W + x) * 4, b = Lb * per + (yb * W + x) * 4;
      s += Math.abs(tex[a] - tex[b]) + Math.abs(tex[a + 1] - tex[b + 1]) + Math.abs(tex[a + 2] - tex[b + 2]);
    }
    return s / W;
  };
  for (let f = 0; f < specs.length; f++) {
    const n = specs[f].variants;
    if (n < 2) continue;
    for (const tex of [atlas.alb, atlas.nrm]) {
      const L0 = atlas.first[f];
      const diffs = [];
      for (let y = 0; y + 1 < H; y += 7) diffs.push(step(L0, y, L0, y + 1, tex));
      diffs.sort((a, b) => a - b);
      const p95 = Math.max(0.5, diffs[Math.floor(diffs.length * 0.95)]);
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        if (a === b) continue;
        worstPair = Math.max(worstPair, step(L0 + a, H - 1, L0 + b, 0, tex) / p95);
        pairs++;
      }
    }
  }
  check('any variant can follow any other without a seam', worstPair <= 1.5,
    `worst joint ${worstPair.toFixed(2)}x the 95th-percentile row step, over ${pairs} ordered pairs`);

  // Wrap: the step from the last row back to the first must look like any
  // other step between neighbouring rows, in colour and in relief.
  let worstRatio = 0, worstLayer = -1;
  for (let L = 0; L < atlas.layers; L++) {
    const base = L * per;
    const rowDiff = (y0, y1, tex) => {
      let s = 0;
      for (let x = 0; x < W; x++) {
        const a = base + (y0 * W + x) * 4, b = base + (y1 * W + x) * 4;
        s += Math.abs(tex[a] - tex[b]) + Math.abs(tex[a + 1] - tex[b + 1]) + Math.abs(tex[a + 2] - tex[b + 2]);
      }
      return s / W;
    };
    for (const tex of [atlas.alb, atlas.nrm]) {
      const diffs = [];
      for (let y = 0; y + 1 < H; y += 7) diffs.push(rowDiff(y, y + 1, tex));
      diffs.sort((a, b) => a - b);
      const p95 = diffs[Math.floor(diffs.length * 0.95)];
      const seam = rowDiff(H - 1, 0, tex);
      const ratio = seam / Math.max(0.5, p95);
      if (ratio > worstRatio) { worstRatio = ratio; worstLayer = L; }
    }
  }
  check('every layer wraps onto itself without a seam', worstRatio <= 1.5,
    `worst wrap step ${worstRatio.toFixed(2)}x the 95th-percentile row step (layer ${worstLayer})`);
}

// ---------------------------------------------------------------------------
// HEXAGONS — the ribbon clears the ground it is drawn on
// ---------------------------------------------------------------------------
// The road is drawn 4 cm above the height field. Where the field rises above
// the drawn ribbon, the terrain mesh (1.6 m between vertices near the car)
// comes up through the tarmac. Measured on the old ribbon, with the same seed
// and sampling: 7.74% of the road surface lay below the field and 2.10% more
// than 4 cm below it — the dark hexagons on every crest.
//
// What is left is mostly the field itself: under the carriageway it carries
// ripples of +/-15 cm on its 3 m grid (ground.js; measured on a straight rural
// lane 68 m from any junction), which no ribbon sampled every few metres can
// follow. The gates are set against that, not against zero.
{
  const rnd = mulberry(20260922);
  const patchLayer = new Set();
  specs.forEach((s, f) => { if (s.kind === 'patch') for (let v = 0; v < s.variants; v++) patchLayer.add(atlas.first[f] + v); });
  const acc = { ribbon: [0, 0, 0, Infinity], patch: [0, 0, 0, Infinity] };
  for (const m of roads.group.children) {
    const a = m.geometry.attributes, idx = m.geometry.index.array;
    const p = a.position.array, r = a.aRoad.array;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      if (r[i0 * 3 + 2] + r[i1 * 3 + 2] + r[i2 * 3 + 2] > 0) continue;   // fringe
      const bin = patchLayer.has(r[i0 * 3]) ? acc.patch : acc.ribbon;
      for (let k = 0; k < 3; k++) {
        let u = rnd(), v = rnd();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const w = 1 - u - v;
        const x = p[i0 * 3] * w + p[i1 * 3] * u + p[i2 * 3] * v;
        const y = p[i0 * 3 + 1] * w + p[i1 * 3 + 1] * u + p[i2 * 3 + 1] * v;
        const z = p[i0 * 3 + 2] * w + p[i1 * 3 + 2] * u + p[i2 * 3 + 2] * v;
        const clear = y - ground.heightAt(x, z);
        bin[0]++;
        if (clear < 0) bin[1]++;
        if (clear < -0.04) bin[2]++;
        if (clear < bin[3]) bin[3] = clear;
      }
    }
  }
  const pct = (b, i) => (100 * b[i] / Math.max(1, b[0])).toFixed(2);
  check('the carriageway is drawn above the ground', acc.ribbon[1] / acc.ribbon[0] < 0.025,
    `${pct(acc.ribbon, 1)}% of ${acc.ribbon[0]} samples below the field (was 7.74%)`);
  check('almost none of it sinks through the clearance', acc.ribbon[2] / acc.ribbon[0] < 0.005,
    `${pct(acc.ribbon, 2)}% more than 4 cm below (was 2.10%), lowest ${(acc.ribbon[3] * 100).toFixed(1)} cm`);
  check('junction fills are drawn above the ground', acc.patch[1] / acc.patch[0] < 0.025 && acc.patch[2] / acc.patch[0] < 0.005,
    `${pct(acc.patch, 1)}% below the field, ${pct(acc.patch, 2)}% more than 4 cm below, of ${acc.patch[0]} samples`);
}

// ---------------------------------------------------------------------------
// NEUTRAL — the detail layer adds grain, not colour
// ---------------------------------------------------------------------------
{
  const N = detail.size, per = N * N * 4;
  let worstMean = 0, worstWrap = 0;
  for (let L = 0; L < detail.layers; L++) {
    let sum = 0;
    for (let i = 0; i < N * N; i++) sum += detail.data[L * per + i * 4 + 2];
    const mean = sum / (N * N) / 255;
    worstMean = Math.max(worstMean, Math.abs(mean - 0.5));
    // Periodic: the step from the last column onto the first must look like
    // the average step between any two neighbouring columns.
    let seam = 0, inner = 0;
    for (let y = 0; y < N; y++) {
      const row = L * per + y * N * 4;
      seam += Math.abs(detail.data[row + (N - 1) * 4 + 2] - detail.data[row + 2]);
      for (let x = 0; x + 1 < N; x++) inner += Math.abs(detail.data[row + x * 4 + 2] - detail.data[row + x * 4 + 6]);
    }
    worstWrap = Math.max(worstWrap, seam / Math.max(1, inner / (N - 1)));
  }
  check('the detail layer is colour-neutral on average', worstMean <= 0.01,
    `worst mean ${(0.5 + worstMean).toFixed(4)} against 0.5`);
  check('the detail layer tiles without a seam', worstWrap <= 1.4,
    `worst edge step ${worstWrap.toFixed(2)}x an interior step`);
}

// ---------------------------------------------------------------------------
// WATER — rain fills the low spots, not the whole road
// ---------------------------------------------------------------------------
// A sealed road sheds water off its camber and keeps it only in potholes,
// ruts and settled repairs; an unpaved lane's wheel ruts genuinely become
// running water in a downpour. So the two are held to different limits — and
// a worn road with NO low spots would be as wrong as one that is all puddle.
{
  const W = atlas.width, H = atlas.height, per = W * H * 4;
  const worst = { paved: null, loose: null };
  let oldPavedDry = false;
  for (let f = 0; f < specs.length; f++) {
    const s = specs[f];
    if (s.kind !== 'road') continue;
    for (let v = 0; v < s.variants; v++) {
      const L = atlas.first[f] + v;
      let wet = 0;
      for (let i = 0; i < W * H; i++) if (atlas.nrm[L * per + i * 4 + 2] > 128) wet++;
      const frac = wet / (W * H);
      const k = s.paint === 'paved' ? 'paved' : 'loose';
      if (!worst[k] || frac > worst[k].frac) worst[k] = { frac, name: `${s.paint} ${s.width} m` };
      if (k === 'paved' && s.age > 0.6 && frac < 0.002) oldPavedDry = true;
    }
  }
  if (worst.paved) {
    check('a sealed road holds water only in its low spots', worst.paved.frac < 0.08,
      `wettest ${(worst.paved.frac * 100).toFixed(1)}% puddle-prone (${worst.paved.name})`);
  }
  check('an old road has somewhere for rain to collect', !oldPavedDry, oldPavedDry ? 'a worn road is bone dry in rain' : 'every worn sealed road has low spots');
  if (worst.loose) {
    check('an unpaved lane floods its ruts, not its crown', worst.loose.frac < 0.30,
      `wettest ${(worst.loose.frac * 100).toFixed(1)}% puddle-prone (${worst.loose.name})`);
  }
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll atmosphere checks passed.');
process.exit(fail ? 1 : 0);
