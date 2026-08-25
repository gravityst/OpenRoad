// The ground query.
//
// Given any (x, z) this returns the height, normal, material and grip of
// whatever the car is standing on. Every wheel calls it every physics step, so
// it is the hottest function in the game and the one most able to ruin it.
//
// HOW IT WORKS, AND WHY
//
// The two obvious implementations both fail, and both failures were measured
// rather than guessed (tools/groundcheck.mjs):
//
//   * Picking the single nearest road makes the surface jump by metres the
//     instant a different road wins the contest — a 3.9 m cliff in practice,
//     wherever a dirt track runs alongside a lane.
//   * Averaging nearby roads by weight instead sags every junction, because two
//     roads meeting at a node each claim the other's carriageway. 1.74 m at the
//     worst node.
//
// The problem is that "height" was being derived at runtime from a set of
// overlapping curves that can disagree. So it is not derived at runtime at all.
// At load, the road network is STAMPED into a height field: carriageway cells
// are pinned to their road's exact profile, and the corridor out to open ground
// is filled by relaxing Laplace's equation between them. A harmonic membrane is
// the smoothest surface meeting every fixed boundary, which is precisely what a
// graded verge is. The result is single-valued by construction, so nothing can
// disagree with anything.
//
// The field stores the DIFFERENCE from bare terrain, not absolute height, so it
// is zero almost everywhere and only the corridor near roads has to be solved.
// Sampling is bicubic, giving a C1 surface — no slope kinks for the suspension
// to hammer on.

import { smoothstep, clamp, lerp } from './noise.js';

// Grip multiplies the tyre's peak friction; roughness drives suspension noise,
// dust and tyre sound; rolling is rolling resistance.
export const SURFACES = {
  asphalt:  { grip: 1.00, roughness: 0.03, rolling: 0.014, dust: 0.0,  colour: 0x2e3033 },
  concrete: { grip: 0.97, roughness: 0.05, rolling: 0.015, dust: 0.0,  colour: 0x3a3c40 },
  sidewalk: { grip: 0.93, roughness: 0.10, rolling: 0.020, dust: 0.0,  colour: 0x54565c },
  dirt:     { grip: 0.68, roughness: 0.34, rolling: 0.045, dust: 1.0,  colour: 0x6b573c },
  gravel:   { grip: 0.62, roughness: 0.46, rolling: 0.060, dust: 0.9,  colour: 0x736c60 },
  grass:    { grip: 0.52, roughness: 0.30, rolling: 0.075, dust: 0.35, colour: 0x46592c },
  sand:     { grip: 0.44, roughness: 0.38, rolling: 0.115, dust: 1.0,  colour: 0x9a8a63 },
  rock:     { grip: 0.70, roughness: 0.62, rolling: 0.055, dust: 0.5,  colour: 0x5c5a55 },
};
const MAT_NAMES = ['asphalt', 'concrete', 'sidewalk', 'dirt', 'gravel', 'grass', 'sand', 'rock'];
const MAT_ASPHALT = 0, MAT_SIDEWALK = 2, MAT_DIRT = 3, MAT_GRAVEL = 4;
const MAT_NONE = 255;   // "ask the terrain"

//  0 ax 1 az 2 ay 3 bx 4 bz 5 by 6 halfW 7 shoulder 8 dirt 9 edge 10 s0 11 len 12 mA 13 mB
const STRIDE = 14;
const CELL = 48;      // spatial hash for the road-identity query
const NEAR = 3;       // metres past the shoulder that roads pin directly
const BLEND = 26;     // width of the graded verge beyond that
const SIDEWALK_W = 4.2;
// Roads are pinned against a membrane stiffness of 1. Stiff enough that the
// carriageway keeps its designed profile; not infinite, so that where two
// carriageways genuinely overlap the result is a weighted mean rather than a step.
const PIN = 2600;

export function createGround(world, opts = {}) {
  const terrain = world.terrain;
  const half = world.half;
  const RES = opts.res ?? 3.0;
  const N = Math.round((half * 2) / RES) + 1;

  // =========================================================================
  // Road segments, flattened
  // =========================================================================
  let count = 0;
  for (const e of world.edges) count += e.pts.length - 1;
  const seg = new Float64Array(count * STRIDE);
  const meta = new Array(count);
  let si = 0;

  for (const e of world.edges) {
    const pts = e.pts, n = pts.length - 1;

    // Per-vertex slope dy/ds by central difference in ARC LENGTH, then
    // Fritsch-Carlson limited so the interpolant cannot overshoot the vertices
    // it passes through and invent bumps that are not in the road.
    const m = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      if (k === 0) m[k] = (pts[1].y - pts[0].y) / Math.max(1e-4, pts[1].s - pts[0].s);
      else if (k === n) m[k] = (pts[n].y - pts[n - 1].y) / Math.max(1e-4, pts[n].s - pts[n - 1].s);
      else m[k] = (pts[k + 1].y - pts[k - 1].y) / Math.max(1e-4, pts[k + 1].s - pts[k - 1].s);
    }
    for (let k = 0; k <= n; k++) {
      const dPrev = k > 0 ? (pts[k].y - pts[k - 1].y) / Math.max(1e-4, pts[k].s - pts[k - 1].s) : m[k];
      const dNext = k < n ? (pts[k + 1].y - pts[k].y) / Math.max(1e-4, pts[k + 1].s - pts[k].s) : m[k];
      if (dPrev * dNext <= 0) m[k] = 0;
      else {
        const lim = 3 * Math.min(Math.abs(dPrev), Math.abs(dNext));
        if (Math.abs(m[k]) > lim) m[k] = Math.sign(m[k]) * lim;
      }
    }

    // The carriageway material comes from the road's OWN surface, not from a
    // dirt/not-dirt flag. When gravel roads were added they inherited the
    // "not dirt" branch and came out as tarmac underfoot — 21 km of rally
    // stage with full asphalt grip, which is the one thing a rally stage must
    // not have.
    const loose = e.surface === 'dirt' || e.surface === 'gravel';
    const carriageMat = e.surface === 'dirt' ? MAT_DIRT
      : e.surface === 'gravel' ? MAT_GRAVEL
      : MAT_ASPHALT;
    // A loose road's verge is the same loose stuff; a paved road's is gravel.
    const shoulderMat = loose ? carriageMat : MAT_GRAVEL;
    // Shoulder WIDTH is a physical property of the road, not of its material,
    // and it is load-bearing here for a non-obvious reason: it sets how wide
    // the pinned band is in the height field. Narrowing it for gravel — which
    // seemed harmless, since only the material was meant to change — left a
    // 7.5 m road with under two pinned cells at 3 m resolution, and the
    // centreline started picking up the membrane between them. Slope kinks on
    // loose roads went from 0.84% to 2.38% on that one edit.
    const shoulder = e.surface === 'dirt' ? 1.6 : e.kind === 'highway' ? 3.5 : 2.4;
    const city = e.kind === 'street' || e.kind === 'avenue' || e.kind === 'link';
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[k + 1], o = si * STRIDE;
      seg[o] = a.x; seg[o + 1] = a.z; seg[o + 2] = a.y;
      seg[o + 3] = b.x; seg[o + 4] = b.z; seg[o + 5] = b.y;
      seg[o + 6] = e.width / 2; seg[o + 7] = shoulder;
      seg[o + 8] = carriageMat * 16 + shoulderMat; seg[o + 9] = e.i;
      seg[o + 10] = a.s; seg[o + 11] = Math.max(1e-4, b.s - a.s);
      seg[o + 12] = m[k]; seg[o + 13] = m[k + 1];
      meta[si] = { edge: e, city };
      si++;
    }
  }

  function hermite(o, t) {
    const y0 = seg[o + 2], y1 = seg[o + 5];
    const h = seg[o + 11], mA = seg[o + 12], mB = seg[o + 13];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * mA +
           (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * mB;
  }

  const build = new Map();
  const hkey = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const pad = seg[o + 6] + seg[o + 7] + BLEND;
    for (let cx = Math.floor((Math.min(seg[o], seg[o + 3]) - pad) / CELL); cx <= Math.floor((Math.max(seg[o], seg[o + 3]) + pad) / CELL); cx++) {
      for (let cz = Math.floor((Math.min(seg[o + 1], seg[o + 4]) - pad) / CELL); cz <= Math.floor((Math.max(seg[o + 1], seg[o + 4]) + pad) / CELL); cz++) {
        const k = hkey(cx, cz);
        let L = build.get(k);
        if (!L) build.set(k, (L = []));
        L.push(i);
      }
    }
  }
  const cells = new Map();
  for (const [k, L] of build) cells.set(k, Int32Array.from(L));
  build.clear();
  const EMPTY = new Int32Array(0);

  // =========================================================================
  // Stamp the height field
  // =========================================================================
  const delta = new Float32Array(N * N);   // road surface MINUS bare terrain
  const mat = new Uint8Array(N * N).fill(MAT_NONE);
  const Wt = new Float32Array(N * N);      // accumulated pin weight
  const Tg = new Float32Array(N * N);      // accumulated weight * target
  const idx = (i, j) => j * N + i;

  for (let sI = 0; sI < count; sI++) {
    const o = sI * STRIDE;
    const ax = seg[o], az = seg[o + 1], bx = seg[o + 3], bz = seg[o + 4];
    const halfW = seg[o + 6], shoulder = seg[o + 7];
    const carriageMat = (seg[o + 8] / 16) | 0;
    const shoulderMat = seg[o + 8] % 16;
    const city = meta[sI].city;
    const pad = halfW + shoulder + NEAR;
    const inner = halfW * 0.85, outer = halfW + shoulder;

    const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - pad + half) / RES));
    const i1 = Math.min(N - 2, Math.ceil((Math.max(ax, bx) + pad + half) / RES));
    const j0 = Math.max(1, Math.floor((Math.min(az, bz) - pad + half) / RES));
    const j1 = Math.min(N - 2, Math.ceil((Math.max(az, bz) + pad + half) / RES));

    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;

    for (let j = j0; j <= j1; j++) {
      const z = j * RES - half;
      for (let i = i0; i <= i1; i++) {
        const x = i * RES - half;
        let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (d > pad) continue;
        const c = idx(i, j);

        const w = PIN * (1 - smoothstep(inner, outer, d));
        if (w > 0) {
          Wt[c] += w;
          Tg[c] += w * (hermite(o, t) - terrain.height(x, z));
        }
        // Material is a hard choice, unlike height: nearest road wins.
        if (d <= halfW) mat[c] = carriageMat;
        else if (mat[c] === MAT_NONE || mat[c] === MAT_GRAVEL) {
          if (city && d < halfW + SIDEWALK_W) mat[c] = MAT_SIDEWALK;
          else if (d <= outer) mat[c] = shoulderMat;
        }
      }
    }
  }

  // ---- Find the blend band by distance transform --------------------------
  // Stamping the full 26 m verge per segment would cost 14 million cell visits.
  // A two-pass chamfer over the grid costs two, and gives the same band.
  const BIG = 1e9;
  const dist = new Float32Array(N * N).fill(BIG);
  for (let c = 0; c < Wt.length; c++) if (Wt[c] > 0) dist[c] = 0;
  const D1 = 1, D2 = Math.SQRT2;
  for (let j = 1; j < N; j++) {
    for (let i = 1; i < N - 1; i++) {
      const c = j * N + i;
      let d = dist[c];
      const a = dist[c - 1] + D1, b = dist[c - N] + D1;
      const e = dist[c - N - 1] + D2, f = dist[c - N + 1] + D2;
      if (a < d) d = a; if (b < d) d = b; if (e < d) d = e; if (f < d) d = f;
      dist[c] = d;
    }
  }
  for (let j = N - 2; j >= 0; j--) {
    for (let i = N - 2; i >= 1; i--) {
      const c = j * N + i;
      let d = dist[c];
      const a = dist[c + 1] + D1, b = dist[c + N] + D1;
      const e = dist[c + N + 1] + D2, f = dist[c + N - 1] + D2;
      if (a < d) d = a; if (b < d) d = b; if (e < d) d = e; if (f < d) d = f;
      dist[c] = d;
    }
  }

  // ---- Solve the weighted membrane ----------------------------------------
  // Each cell settles toward a blend of its neighbours' average (the membrane)
  // and its pinned target, in proportion to how hard it is pinned. Cells beyond
  // the band keep delta = 0, which is exactly "bare terrain", so the corridor
  // fairs out into open country on its own.
  const R = BLEND / RES;
  const solveList = [];
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const c = j * N + i;
      if (dist[c] <= R) solveList.push(c);
    }
  }
  const solve = Int32Array.from(solveList);
  for (let n = 0; n < solve.length; n++) {
    const c = solve[n];
    if (Wt[c] > 0) delta[c] = Tg[c] / Wt[c];   // start close to the answer
  }
  const OMEGA = 1.86;
  for (let it = 0; it < 160; it++) {
    for (let n = 0; n < solve.length; n++) {
      const c = solve[n];
      const avg = 0.25 * (delta[c - 1] + delta[c + 1] + delta[c - N] + delta[c + N]);
      const w = Wt[c];
      delta[c] += OMEGA * ((w > 0 ? (avg + Tg[c]) / (1 + w) : avg) - delta[c]);
    }
  }

  let pinnedCells = 0;
  for (let c = 0; c < Wt.length; c++) if (Wt[c] > 0) pinnedCells++;
  const bandCells = solve.length - pinnedCells;

  // =========================================================================
  // Sampling
  // =========================================================================
  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                  (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  function crD(p0, p1, p2, p3, t) {
    const t2 = t * t;
    return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t +
                  3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
  }
  const rowV = new Float64Array(4), rowD = new Float64Array(4);
  const dOut = { v: 0, dx: 0, dz: 0 };

  /** Bicubic delta and its gradient. C1 everywhere. */
  function sampleDelta(x, z) {
    const fx = (x + half) / RES, fz = (z + half) / RES;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    if (i0 < 1 || j0 < 1 || i0 > N - 3 || j0 > N - 3) {
      dOut.v = 0; dOut.dx = 0; dOut.dz = 0;   // off the field: bare terrain
      return dOut;
    }
    const tx = fx - i0, tz = fz - j0;
    for (let r = 0; r < 4; r++) {
      const base = (j0 - 1 + r) * N + (i0 - 1);
      const p0 = delta[base], p1 = delta[base + 1], p2 = delta[base + 2], p3 = delta[base + 3];
      rowV[r] = cr(p0, p1, p2, p3, tx);
      rowD[r] = crD(p0, p1, p2, p3, tx) / RES;
    }
    dOut.v = cr(rowV[0], rowV[1], rowV[2], rowV[3], tz);
    dOut.dz = crD(rowV[0], rowV[1], rowV[2], rowV[3], tz) / RES;
    dOut.dx = cr(rowD[0], rowD[1], rowD[2], rowD[3], tz);
    return dOut;
  }

  function materialAt(x, z, ny) {
    const i = Math.round((x + half) / RES), j = Math.round((z + half) / RES);
    if (i >= 0 && j >= 0 && i < N && j < N) {
      const m = mat[idx(i, j)];
      if (m !== MAT_NONE) return MAT_NAMES[m];
    }
    return terrain.cover(x, z, ny);
  }

  function blank() {
    return {
      y: 0, nx: 0, ny: 1, nz: 0,
      surface: 'grass', grip: 0.52, roughness: 0.3, rolling: 0.075, dust: 0.35,
    };
  }
  const result = blank();

  /** Height, normal and material at (x, z). Total over the whole plane. */
  function sample(x, z, out) {
    const r = out || result;
    const d = sampleDelta(x, z);
    r.y = terrain.height(x, z) + d.v;

    const e = 1.5;
    const gx = (terrain.height(x + e, z) - terrain.height(x - e, z)) / (2 * e) + d.dx;
    const gz = (terrain.height(x, z + e) - terrain.height(x, z - e)) / (2 * e) + d.dz;
    const inv = 1 / Math.hypot(gx, 1, gz);
    r.nx = -gx * inv; r.ny = inv; r.nz = -gz * inv;

    const m = materialAt(x, z, r.ny);
    const sp = SURFACES[m] || SURFACES.grass;
    r.surface = m; r.grip = sp.grip; r.roughness = sp.roughness;
    r.rolling = sp.rolling; r.dust = sp.dust;
    return r;
  }

  function heightAt(x, z) { return terrain.height(x, z) + sampleDelta(x, z).v; }

  const roadOut = {
    onRoad: false, dist: Infinity, edge: null, s: 0, tx: 0, tz: 0,
    speedLimit: 0, width: 0, kind: '',
  };

  /**
   * Which road is underneath, for traffic, speed limits and the map. Separate
   * from sample() because it is needed once per car, not once per wheel.
   */
  function roadAt(x, z, out) {
    const r = out || roadOut;
    const list = cells.get(hkey(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY;
    let bd = Infinity, bi = -1, bt = 0;
    for (let n = 0; n < list.length; n++) {
      const i = list[n], o = i * STRIDE;
      const ax = seg[o], az = seg[o + 1];
      const dx = seg[o + 3] - ax, dz = seg[o + 4] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t)) / (seg[o + 6] || 1);
      if (d < bd) { bd = d; bi = i; bt = t; }
    }
    if (bi < 0) {
      r.onRoad = false; r.dist = Infinity; r.edge = null;
      r.s = 0; r.tx = 0; r.tz = 0; r.speedLimit = 0; r.width = 0; r.kind = '';
      return r;
    }
    const o = bi * STRIDE;
    const ax = seg[o], az = seg[o + 1];
    const dx = seg[o + 3] - ax, dz = seg[o + 4] - az;
    const invL = 1 / Math.max(1e-6, Math.hypot(dx, dz));
    r.dist = Math.hypot(x - (ax + dx * bt), z - (az + dz * bt));
    r.onRoad = r.dist <= seg[o + 6];
    r.edge = meta[bi].edge;
    r.s = seg[o + 10] + bt * seg[o + 11];
    r.tx = dx * invL; r.tz = dz * invL;
    r.speedLimit = r.edge.speed; r.width = seg[o + 6] * 2; r.kind = r.edge.kind;
    return r;
  }

  /** Nearest road within `maxR`, for spawning and for recovering a lost car. */
  function nearestRoad(x, z, maxR = 220, filter = null) {
    let best = null, bd = maxR;
    const rc = Math.ceil(maxR / CELL);
    const cx0 = Math.floor(x / CELL), cz0 = Math.floor(z / CELL);
    for (let cx = cx0 - rc; cx <= cx0 + rc; cx++) {
      for (let cz = cz0 - rc; cz <= cz0 + rc; cz++) {
        const list = cells.get(hkey(cx, cz));
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          const i = list[n], o = i * STRIDE;
          if (filter && !filter(meta[i].edge)) continue;
          const ax = seg[o], az = seg[o + 1];
          const dx = seg[o + 3] - ax, dz = seg[o + 4] - az;
          const len2 = dx * dx + dz * dz;
          let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < bd) {
            const inv = 1 / Math.max(1e-6, Math.hypot(dx, dz));
            bd = d;
            best = {
              x: px, z: pz, y: hermite(o, t), dist: d, edge: meta[i].edge,
              s: seg[o + 10] + t * seg[o + 11], tx: dx * inv, tz: dz * inv,
            };
          }
        }
      }
    }
    return best;
  }

  return {
    sample, heightAt, roadAt, nearestRoad, SURFACES,
    // The terrain mesh is built from this same field, so what you drive on and
    // what you see are guaranteed to be the same surface.
    field: { delta, N, res: RES, half, heightAt },
    stats: { segments: count, pinnedCells, bandCells, gridN: N },
  };
}
