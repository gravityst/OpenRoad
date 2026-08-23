// Road surfaces, kerbs and junctions.
//
// Everything you drive on is one mesh per region and ONE material. Both halves
// of that were forced by the problem rather than chosen for tidiness:
//
//   * Markings live in the texture, never in geometry. A painted line drawn as
//     its own quad a centimetre above the tarmac z-fights at range no matter
//     what polygon offset it is given, and the flicker is worst exactly where
//     the player is looking — down the road ahead. Baking the lines into the
//     surface and tiling by ARC LENGTH keeps a 3 m dash 3 m long whether the
//     polyline segment under it is 8 m or 80, and leaves no second surface to
//     fight with.
//
//   * One texture for the whole network. Seven road styles, sidewalk, kerb and
//     the two junction fills are stacked into a single atlas, so a region costs
//     one draw call instead of eleven. The atlas is a vertical stack: U runs
//     across the carriageway and uses the full texture width, so only V is
//     sub-ranged. Each row carries an 8 px guard band top and bottom holding a
//     copy of the opposite edge — without it the hand-rolled V wrap shows a
//     hairline seam every tile, because bilinear filtering reads whatever row
//     happens to be adjacent in the atlas.
//
// The ribbon sits 4 cm above ground.heightAt() with polygon offset as well.
// 4 cm is well inside the suspension's own travel so nothing reads as floating,
// and the height comes from the same field the physics stands on — what you see
// and what you drive on cannot disagree.

import * as THREE from 'three';
import { pointOnEdge } from '../world/layout.js';
import { fbm, mulberry, clamp, lerp, smoothstep } from '../world/noise.js';

const LIFT = 0.04;          // m of clearance over the physics surface
const KERB = 0.085;         // m of kerb lip — the car has no kerb to stand on
const WALK_W = 4.2;         // m of sidewalk, matching ground.js's SIDEWALK_W
const TILE = 24;            // m of road per texture repeat
const VSTEPS = 3;           // stations per tile, so V lands on exact thirds
const STEP = TILE / VSTEPS; // 8 m, which is also layout.js's densify() spacing

const ATLAS_W = 512;
const GUARD = 8;
const SLOT_MAX = 176;       // 160 px of content plus the two guard bands
const ATLAS_MAX = 2048;     // the WebGL2 floor for MAX_TEXTURE_SIZE

// Cull distances, NOT the engine's raw tier draw distances. Culling a region
// the player can still see is worse than drawing it: sky.js does not close its
// fog until drawDistance * 1.55 in clear weather, so a road dropped at the raw
// tier figure vanishes over bare terrain while it is still well over half
// visible. These are the four engine tiers carried out to where the fog
// actually hides them. Costs nothing here — every region shares one material,
// and the frustum still throws away everything behind the camera.
const QUALITY = {
  low:    { anisotropy: 1,  drawDistance: 2170 },   // engine tier 1400
  medium: { anisotropy: 4,  drawDistance: 3410 },   // engine tier 2200
  high:   { anisotropy: 8,  drawDistance: 4960 },   // engine tier 3200
  ultra:  { anisotropy: 16, drawDistance: 6980 },   // engine tier 4500
};

// ---------------------------------------------------------------------------
// Marking layouts
// ---------------------------------------------------------------------------

/**
 * Longitudinal stripes for one road style, in metres from the left edge.
 * `dash`/`gap` cycles are chosen to divide TILE exactly (3+9 and 2+4 both do),
 * otherwise the dash pattern would visibly stutter at every texture repeat.
 */
function markingPlan(markings, width, lanes) {
  const out = [];
  const c = width / 2;
  const line = (m, w, dash, gap) => out.push({ m, w, dash: dash || 0, gap: gap || 0 });

  if (markings === 'highway') {
    const sh = Math.min(3.0, width * 0.13), med = 0.55;
    line(sh, 0.22); line(width - sh, 0.22);                    // hard shoulders
    line(c - med, 0.22); line(c + med, 0.22);                  // painted median
    const run = (c - med - sh) / lanes;
    for (let k = 1; k < lanes; k++) {
      line(sh + run * k, 0.16, 3, 9);
      line(width - sh - run * k, 0.16, 3, 9);
    }
  } else if (markings === 'avenue') {
    const med = 0.17;
    line(c - med, 0.15); line(c + med, 0.15);
    // A single-lane link gets the centre line and nothing else; drawing a lane
    // divider down a one-lane carriageway would invent a lane that is not there.
    const run = (c - med) / lanes;
    for (let k = 1; k < lanes; k++) {
      line(c - med - run * k, 0.14, 3, 9);
      line(c + med + run * k, 0.14, 3, 9);
    }
  } else if (markings === 'street') {
    line(c, 0.15, 2, 4);
  } else if (markings === 'rural') {
    line(c, 0.14, 3, 9);
  }
  return out;
}

/** Where the tyres actually run, so the surface can be polished there. */
function wheelTracks(markings, width, lanes) {
  const c = width / 2, out = [];
  const sh = markings === 'highway' ? Math.min(3.0, width * 0.13) : 0;
  const med = markings === 'highway' ? 0.55 : markings === 'avenue' ? 0.17 : 0;
  const run = (c - med - sh) / lanes;
  for (let k = 0; k < lanes; k++) {
    const lc = sh + run * (k + 0.5);
    out.push(lc - 0.78, lc + 0.78, width - lc - 0.78, width - lc + 0.78);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural surface textures
// ---------------------------------------------------------------------------

/**
 * Noise in METRE space that repeats exactly every TILE metres along the road.
 *
 * Metre space matters because a row is 512 px across a 9.5 m lane but only
 * 160 px along 24 m of it — sampling in pixel space would smear the aggregate
 * into stripes at wildly different scales on every road kind. `sx` and `sz` are
 * deliberately different: real tarmac grain IS streaked along the direction of
 * travel by tyre polish and water runoff.
 */
function grain(mx, mz, sx, sz, seed, oct) {
  const a = fbm(mx / sx, mz / sz, seed, oct);
  const b = fbm(mx / sx, (mz - TILE) / sz, seed, oct);
  return lerp(a, b, mz / TILE);
}

/** A carriageway row: base tone, wheel tracks, grime at the edge, markings. */
function roadSpec(markings, width, lanes, surface, seed) {
  const dirt = surface === 'dirt';
  const c = width / 2;
  const tracks = dirt ? [c - 0.78, c + 0.78] : wheelTracks(markings, width, lanes);
  const trackDepth = dirt ? 0.18 : 0.075;
  const trackWidth = dirt ? 0.50 : 0.62;
  const edgeLight = dirt ? 0.13 : 0.10;
  const crown = dirt ? 0.08 : 0;

  return {
    kind: 'road', width, seed,
    base: dirt ? [128, 106, 76] : [62, 65, 69],
    stripes: dirt ? [] : markingPlan(markings, width, lanes),
    gx: dirt ? 0.20 : 0.13, gz: dirt ? 0.62 : 0.42, grainAmt: dirt ? 0.17 : 0.10,
    bx: dirt ? 2.0 : 2.6, bz: dirt ? 4.2 : 5.5, blotchAmt: dirt ? 0.11 : 0.05,
    cross(m) {
      let t = 1 + edgeLight * smoothstep(width * 0.34, width * 0.5, Math.abs(m - c));
      for (let i = 0; i < tracks.length; i++) {
        const q = (m - tracks[i]) / trackWidth;
        t *= 1 - trackDepth * Math.exp(-q * q);
      }
      if (crown) { const q = (m - c) / 0.9; t *= 1 + crown * Math.exp(-q * q); }
      // The last handspan of tarmac is always dirtier than the rest of it.
      t *= 1 - 0.26 * (1 - smoothstep(0, 0.45, Math.min(m, width - m)));
      return t;
    },
    // Weeds down the crown and along the verge, but only where nothing drives.
    moss: dirt ? (m) => {
      const q = (m - c) / 0.85;
      return 0.34 * Math.exp(-q * q) + 0.26 * (1 - smoothstep(0, 1.0, Math.min(m, width - m)));
    } : null,
  };
}

/** Concrete paving, 4.2 m across, jointed every 1.2 m so it tiles into TILE. */
function walkSpec(seed) {
  return {
    kind: 'walk', width: WALK_W, seed, base: [118, 120, 126], stripes: [],
    gx: 0.16, gz: 0.24, grainAmt: 0.075, bx: 1.4, bz: 1.8, blotchAmt: 0.05,
    // Grit and grime collect against the kerb, which is the road-side edge.
    cross: (m) => 1 - 0.13 * (1 - smoothstep(0, 0.6, m)),
    moss: null,
  };
}

/** The 8.5 cm kerb face. U runs up the face, so `width` here is nominal. */
function kerbSpec(seed) {
  return {
    kind: 'kerb', width: 1, seed, base: [132, 133, 137], stripes: [],
    gx: 0.9, gz: 0.22, grainAmt: 0.09, bx: 3.0, bz: 1.9, blotchAmt: 0.05,
    // Bright along the scuffed top arris, dark down in the gutter.
    cross: (u) => 0.70 + 0.42 * smoothstep(0.05, 0.85, u),
    moss: null,
  };
}

/** Junction fill: no markings, worn smooth by everything that turns on it. */
function patchSpec(surface, seed) {
  const dirt = surface === 'dirt';
  return {
    kind: 'patch', width: 20, seed, base: dirt ? [122, 101, 73] : [59, 62, 66], stripes: [],
    gx: dirt ? 0.26 : 0.17, gz: dirt ? 0.30 : 0.20, grainAmt: dirt ? 0.16 : 0.10,
    bx: dirt ? 2.4 : 3.0, bz: dirt ? 2.6 : 3.2, blotchAmt: dirt ? 0.12 : 0.07,
    cross: () => 1,
    moss: null,
  };
}

/** Paints one atlas row into `ctx`, which is `w` x `h` and owned by the caller. */
function paintRow(ctx, w, h, spec, rnd) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const mPerX = spec.width / w;
  const mPerY = TILE / h;
  const base = spec.base;

  for (let py = 0; py < h; py++) {
    const mz = (py + 0.5) * mPerY;
    for (let px = 0; px < w; px++) {
      const m = (px + 0.5) * mPerX;
      let t = spec.cross(spec.kind === 'kerb' ? (px + 0.5) / w : m);
      t *= 1 + grain(m, mz, spec.gx, spec.gz, spec.seed, 3) * spec.grainAmt;
      t *= 1 + grain(m, mz, spec.bx, spec.bz, spec.seed + 91, 2) * spec.blotchAmt;
      let r = base[0] * t, g = base[1] * t, b = base[2] * t;
      if (spec.moss) {
        const k = clamp(spec.moss(m) * (0.55 + 0.45 * grain(m, mz, 1.1, 3.0, spec.seed + 7, 2)), 0, 1);
        r = lerp(r, 74, k); g = lerp(g, 86, k); b = lerp(b, 50, k);
      }
      const o = (py * w + px) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (spec.kind === 'road') paintStripes(ctx, w, h, spec, rnd);
  else if (spec.kind === 'walk' || spec.kind === 'kerb') paintJoints(ctx, w, h, spec, rnd);
  ctx.globalAlpha = 1;
}

/** Lane lines, then enough wear that they do not read as freshly applied. */
function paintStripes(ctx, w, h, spec, rnd) {
  if (!spec.stripes.length) return;
  const pxm = w / spec.width, pym = h / TILE;

  ctx.fillStyle = 'rgb(226,224,212)';
  for (const st of spec.stripes) {
    const x0 = (st.m - st.w / 2) * pxm;
    const ww = Math.max(1.4, st.w * pxm);
    ctx.globalAlpha = 0.86;
    if (!st.dash) { ctx.fillRect(x0, 0, ww, h); continue; }
    const cyc = st.dash + st.gap;
    for (let s = 0; s < TILE - 1e-6; s += cyc) ctx.fillRect(x0, s * pym, ww, st.dash * pym);
  }

  const b = spec.base;
  ctx.fillStyle = `rgb(${b[0]},${b[1]},${b[2]})`;
  for (let i = 0; i < 110; i++) {
    const st = spec.stripes[(rnd() * spec.stripes.length) | 0];
    const y = rnd() * h;
    const hgt = (0.15 + rnd() * 0.7) * pym;
    ctx.globalAlpha = 0.10 + rnd() * 0.24;
    ctx.fillRect((st.m - st.w) * pxm, y, st.w * 2 * pxm, hgt);
    // A scuff clipped by the top of the row must reappear at the bottom, or
    // the tile shows a half-scuff every 24 m all the way down the road.
    if (y + hgt > h) ctx.fillRect((st.m - st.w) * pxm, y - h, st.w * 2 * pxm, hgt);
  }
}

/** Slab joints, laid at the same arc lengths on the walk and on the kerb. */
function paintJoints(ctx, w, h, spec, rnd) {
  const pym = h / TILE;
  const jw = Math.max(1, Math.round(0.05 * pym));
  const slabs = TILE / 1.2;

  for (let i = 0; i < slabs; i++) {
    const y = i * 1.2 * pym;
    // Each slab was poured on a different day.
    const tone = rnd() < 0.5 ? 255 : 0;
    ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
    ctx.globalAlpha = 0.015 + rnd() * 0.035;
    ctx.fillRect(0, y, w, 1.2 * pym);
    ctx.fillStyle = 'rgb(0,0,0)';
    ctx.globalAlpha = 0.34;
    ctx.fillRect(0, y, w, jw);
  }
  if (spec.kind === 'walk') {
    ctx.globalAlpha = 0.26;
    ctx.fillRect(w * 0.5 - jw * 0.5, 0, jw, h);
  }
}

/**
 * Stacks every row into one canvas and returns the V range of each.
 *
 * The slot height shrinks if a world ever needs more rows than fit, so the
 * atlas can never exceed the 2048 px that WebGL2 guarantees.
 */
function buildAtlas(specs, seed) {
  const rows = specs.length;
  const slot = Math.max(48, Math.min(SLOT_MAX, Math.floor(ATLAS_MAX / rows)));
  const contentH = slot - GUARD * 2;
  const H = slot * rows;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const scratch = document.createElement('canvas');
  scratch.width = ATLAS_W; scratch.height = contentH;
  const sctx = scratch.getContext('2d');

  const rnd = mulberry((seed ^ 0x51ed2b) >>> 0);
  const ranges = [];
  for (let r = 0; r < rows; r++) {
    paintRow(sctx, ATLAS_W, contentH, specs[r], rnd);
    const top = r * slot;
    ctx.drawImage(scratch, 0, 0, ATLAS_W, contentH, 0, top + GUARD, ATLAS_W, contentH);
    // Guards carry the tile across the seam so bilinear filtering has the right
    // neighbours at both ends of the row.
    ctx.drawImage(scratch, 0, contentH - GUARD, ATLAS_W, GUARD, 0, top, ATLAS_W, GUARD);
    ctx.drawImage(scratch, 0, 0, ATLAS_W, GUARD, 0, top + GUARD + contentH, ATLAS_W, GUARD);
    ranges.push({ v0: (top + GUARD) / H, v1: (top + GUARD + contentH) / H });
  }
  return { canvas, ranges, width: ATLAS_W, height: H };
}

// ---------------------------------------------------------------------------
// Geometry buffers
// ---------------------------------------------------------------------------

// Scratch vertex records. Filling four reused objects keeps the builder legible
// without littering the heap with a million three-field literals at load.
const _a = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _b = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _c = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };
const _d = { x: 0, y: 0, z: 0, u: 0, v: 0, t: 1 };

function V(o, x, y, z, u, v, t) {
  o.x = x; o.y = y; o.z = z; o.u = u; o.v = v; o.t = t;
  return o;
}

function vert(bk, x, y, z, nx, ny, nz, u, v, t) {
  bk.pos.push(x, y, z);
  bk.nor.push(nx, ny, nz);
  bk.uv.push(u, v);
  bk.col.push(t, t, t);
}

/**
 * One flat triangle, wound so its normal faces `up`.
 *
 * Junction fans and kerb returns are assembled from polylines whose handedness
 * depends on which end of an edge the node happens to be, and getting that
 * wrong shows up as invisible tarmac. Deciding the winding from the geometry
 * itself removes the whole class of mistake.
 */
function tri(bk, p, q, r, ux, uy, uz) {
  const ax = q.x - p.x, ay = q.y - p.y, az = q.z - p.z;
  const bx = r.x - p.x, by = r.y - p.y, bz = r.z - p.z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return;                       // collapsed; nothing to draw
  nx /= len; ny /= len; nz /= len;
  if (nx * ux + ny * uy + nz * uz < 0) {
    nx = -nx; ny = -ny; nz = -nz;
    const s = q; q = r; r = s;
  }
  vert(bk, p.x, p.y, p.z, nx, ny, nz, p.u, p.v, p.t);
  vert(bk, q.x, q.y, q.z, nx, ny, nz, q.u, q.v, q.t);
  vert(bk, r.x, r.y, r.z, nx, ny, nz, r.u, r.v, r.t);
}

function quad(bk, p, q, r, s, ux, uy, uz) {
  tri(bk, p, q, r, ux, uy, uz);
  tri(bk, p, r, s, ux, uy, uz);
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createRoads(world, ground, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const REGION = opts.region ?? 512;
  const seed = opts.seed ?? world.seed ?? 0;
  const half = world.half;
  const GRID = Math.ceil((half * 2) / REGION);
  const CITY = { street: 1, avenue: 1, link: 1 };   // kinds that get sidewalks

  // ---- atlas rows -------------------------------------------------------
  // Registered in a fixed pass over the world so the layout is deterministic
  // and the atlas holds nothing the map does not actually use.
  const specs = [];
  const rowOf = new Map();
  function row(key, make) {
    let r = rowOf.get(key);
    if (r === undefined) { r = specs.length; specs.push(make()); rowOf.set(key, r); }
    return r;
  }

  const edgeRow = new Int16Array(world.edges.length);
  let anyCity = false;
  for (const e of world.edges) {
    const key = `${e.markings}|${e.width}|${e.lanes}|${e.surface}`;
    edgeRow[e.i] = row(key, () => roadSpec(e.markings, e.width, e.lanes, e.surface, seed + e.width * 17));
    if (CITY[e.kind] === 1) anyCity = true;
  }
  const walkRow = anyCity ? row('walk', () => walkSpec(seed + 311)) : -1;
  const kerbRow = anyCity ? row('kerb', () => kerbSpec(seed + 733)) : -1;

  const junctions = world.nodes.filter((n) => n.edges.length >= 3);
  const patchRow = { asphalt: -1, dirt: -1 };
  const patchKind = new Map();
  for (const n of junctions) {
    let dirt = 0;
    for (const ei of n.edges) if (world.edges[ei].surface === 'dirt') dirt++;
    const s = dirt * 2 > n.edges.length ? 'dirt' : 'asphalt';
    patchKind.set(n.i, s);
    if (patchRow[s] < 0) patchRow[s] = row('patch:' + s, () => patchSpec(s, seed + 977));
  }

  const atlas = buildAtlas(specs, seed);
  const ranges = atlas.ranges;

  // ---- buckets ----------------------------------------------------------
  const buckets = new Map();
  function bucket(x, z) {
    const i = clamp(Math.floor((x + half) / REGION), 0, GRID - 1);
    const j = clamp(Math.floor((z + half) / REGION), 0, GRID - 1);
    const k = j * GRID + i;
    let bk = buckets.get(k);
    if (!bk) {
      bk = { cx: (i + 0.5) * REGION - half, cz: (j + 0.5) * REGION - half, pos: [], nor: [], uv: [], col: [] };
      buckets.set(k, bk);
    }
    return bk;
  }

  // Low-frequency patchiness in world space. The texture repeats every 24 m;
  // this does not, which is what stops the eye locking onto the tile.
  const tseed = (seed + 4021) | 0;
  const tint = (x, z) => 1 + fbm(x * 0.0143, z * 0.0143, tseed, 2) * 0.055;

  const vOf = (r, v) => ranges[r].v0 + v * (ranges[r].v1 - ranges[r].v0);

  // ---- junction setbacks ------------------------------------------------
  // Ribbons are pulled back from every junction and the gap is filled with a
  // patch. Running them all the way in instead leaves wedges of bare terrain
  // between the mouths, which is the single most obvious tell that a road
  // network was generated rather than built.
  const setback = new Float64Array(world.nodes.length);
  for (const n of junctions) {
    let maxHalf = 0, minLen = Infinity;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (e.width / 2 > maxHalf) maxHalf = e.width / 2;
      if (e.length < minLen) minLen = e.length;
    }
    setback[n.i] = Math.min(maxHalf * 1.25, minLen * 0.34, 26);
  }
  const trim = new Float64Array(world.edges.length * 2);
  for (const e of world.edges) {
    let s0 = setback[e.a], s1 = setback[e.b];
    const cap = e.length * 0.86;
    if (s0 + s1 > cap && s0 + s1 > 0) { const k = cap / (s0 + s1); s0 *= k; s1 *= k; }
    trim[e.i * 2] = s0; trim[e.i * 2 + 1] = s1;
  }

  // ---- carriageway ribbons, kerbs and sidewalks --------------------------
  // Strips are capped at 7 m across. The road profile the ground field is
  // stamped from has no camber, so a carriageway IS flat across and two
  // vertices would in principle be exact — but where two roads overlap the
  // field is a weighted mean of both and stops being flat. Measured over the
  // whole network, spanning the full width with one strip leaves 3% of the
  // surface more than 6 cm off the physics height, which is more than the
  // clearance it is drawn with; at 7 m strips that falls to 0.6%.
  const MAX_STRIP = 7;
  const MAX_CROSS = 12;

  const pool = [];
  function station(i) {
    let s = pool[i];
    if (!s) {
      pool[i] = s = {
        cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, ax: 0, az: 0,
        X: new Float64Array(MAX_CROSS), Y: new Float64Array(MAX_CROSS),
        Z: new Float64Array(MAX_CROSS), T: new Float64Array(MAX_CROSS),
        ox: 0, oy: 0, oz: 0, qx: 0, qy: 0, qz: 0,
      };
    }
    return s;
  }

  const arcs = [];
  let quads = 0;

  for (const e of world.edges) {
    if (!e.pts || e.pts.length < 2 || e.length < 0.5) continue;
    const s0 = trim[e.i * 2], s1 = e.length - trim[e.i * 2 + 1];
    const usable = s1 - s0;
    if (usable < 0.6) continue;

    arcs.length = 0;
    const nFull = Math.floor(usable / STEP);
    const rem = usable - nFull * STEP;
    for (let i = 0; i <= nFull; i++) arcs.push(s0 + i * STEP);
    // The ribbon has to end EXACTLY where the junction patch starts, so a short
    // remainder is absorbed into the last quad rather than dropped. V then runs
    // a little past 1, which is precisely what the guard band is there for.
    if (rem > 0.4) arcs.push(s1); else arcs[arcs.length - 1] = s1;
    if (arcs.length < 2) continue;

    const h = e.width / 2;
    const rr = edgeRow[e.i];
    const strips = Math.min(MAX_CROSS - 1, Math.max(1, Math.ceil(e.width / MAX_STRIP)));
    const walk = walkRow >= 0 && CITY[e.kind] === 1;

    for (let i = 0; i < arcs.length; i++) {
      const p = pointOnEdge(e, arcs[i]);
      const st = station(i);
      st.ax = p.nx; st.az = p.nz;                 // right-hand normal of the road
      for (let k = 0; k <= strips; k++) {
        const f = (2 * k / strips - 1) * h;
        const x = p.x + p.nx * f, z = p.z + p.nz * f;
        st.X[k] = x; st.Z[k] = z;
        st.Y[k] = ground.heightAt(x, z) + LIFT;
        st.T[k] = tint(x, z);
      }
      st.cx = p.x; st.cz = p.z; st.cy = (st.Y[0] + st.Y[strips]) * 0.5;
      if (walk) {
        const ox = p.x - p.nx * (h + WALK_W), oz = p.z - p.nz * (h + WALK_W);
        const qx = p.x + p.nx * (h + WALK_W), qz = p.z + p.nz * (h + WALK_W);
        st.ox = ox; st.oz = oz; st.oy = ground.heightAt(ox, oz) + LIFT + KERB;
        st.qx = qx; st.qz = qz; st.qy = ground.heightAt(qx, qz) + LIFT + KERB;
      }
    }

    // Per-station normals rather than per-face ones. Roads are the surface the
    // player stares at for the whole game; flat shading bands every 8 m quad
    // across a crest and reads as faceting on an otherwise smooth grade.
    const last = arcs.length - 1;
    for (let i = 0; i <= last; i++) {
      const a = pool[i > 0 ? i - 1 : 0], b = pool[i < last ? i + 1 : last];
      const tx = b.cx - a.cx, ty = b.cy - a.cy, tz = b.cz - a.cz;
      const st = pool[i];
      const dx = st.X[strips] - st.X[0], dy = st.Y[strips] - st.Y[0], dz = st.Z[strips] - st.Z[0];
      const nx = dy * tz - dz * ty, ny = dz * tx - dx * tz, nz = dx * ty - dy * tx;
      const len = Math.hypot(nx, ny, nz) || 1;
      st.nx = nx / len; st.ny = ny / len; st.nz = nz / len;
    }

    for (let i = 0; i < last; i++) {
      const A = pool[i], B = pool[i + 1];
      const bk = bucket((A.cx + B.cx) * 0.5, (A.cz + B.cz) * 0.5);
      const v0 = (i % VSTEPS) / VSTEPS;
      const va = vOf(rr, v0);
      const vb = vOf(rr, v0 + (arcs[i + 1] - arcs[i]) / TILE);

      // Winding verified against forward = -Z, right = +X: index 0 is the left
      // kerb, index `strips` the right, and (left, right, right') faces up.
      for (let k = 0; k < strips; k++) {
        const u0 = k / strips, u1 = (k + 1) / strips;
        vert(bk, A.X[k], A.Y[k], A.Z[k], A.nx, A.ny, A.nz, u0, va, A.T[k]);
        vert(bk, A.X[k + 1], A.Y[k + 1], A.Z[k + 1], A.nx, A.ny, A.nz, u1, va, A.T[k + 1]);
        vert(bk, B.X[k + 1], B.Y[k + 1], B.Z[k + 1], B.nx, B.ny, B.nz, u1, vb, B.T[k + 1]);
        vert(bk, A.X[k], A.Y[k], A.Z[k], A.nx, A.ny, A.nz, u0, va, A.T[k]);
        vert(bk, B.X[k + 1], B.Y[k + 1], B.Z[k + 1], B.nx, B.ny, B.nz, u1, vb, B.T[k + 1]);
        vert(bk, B.X[k], B.Y[k], B.Z[k], B.nx, B.ny, B.nz, u0, vb, B.T[k]);
        quads++;
      }

      if (!walk) continue;
      const R = strips;
      const kva = vOf(kerbRow, v0), kvb = vOf(kerbRow, v0 + (arcs[i + 1] - arcs[i]) / TILE);
      const wva = vOf(walkRow, v0), wvb = vOf(walkRow, v0 + (arcs[i + 1] - arcs[i]) / TILE);

      // Left side, then right. The kerb face points away from the carriageway.
      quad(bk,
        V(_a, A.X[0], A.Y[0], A.Z[0], 0, kva, A.T[0]),
        V(_b, A.X[0], A.Y[0] + KERB, A.Z[0], 1, kva, A.T[0]),
        V(_c, B.X[0], B.Y[0] + KERB, B.Z[0], 1, kvb, B.T[0]),
        V(_d, B.X[0], B.Y[0], B.Z[0], 0, kvb, B.T[0]),
        -A.ax, 0, -A.az);
      quad(bk,
        V(_a, A.X[0], A.Y[0] + KERB, A.Z[0], 0, wva, A.T[0]),
        V(_b, A.ox, A.oy, A.oz, 1, wva, A.T[0]),
        V(_c, B.ox, B.oy, B.oz, 1, wvb, B.T[0]),
        V(_d, B.X[0], B.Y[0] + KERB, B.Z[0], 0, wvb, B.T[0]),
        0, 1, 0);
      quad(bk,
        V(_a, A.X[R], A.Y[R], A.Z[R], 0, kva, A.T[R]),
        V(_b, A.X[R], A.Y[R] + KERB, A.Z[R], 1, kva, A.T[R]),
        V(_c, B.X[R], B.Y[R] + KERB, B.Z[R], 1, kvb, B.T[R]),
        V(_d, B.X[R], B.Y[R], B.Z[R], 0, kvb, B.T[R]),
        A.ax, 0, A.az);
      quad(bk,
        V(_a, A.X[R], A.Y[R] + KERB, A.Z[R], 0, wva, A.T[R]),
        V(_b, A.qx, A.qy, A.qz, 1, wva, A.T[R]),
        V(_c, B.qx, B.qy, B.qz, 1, wvb, B.T[R]),
        V(_d, B.X[R], B.Y[R] + KERB, B.Z[R], 0, wvb, B.T[R]),
        0, 1, 0);
      quads += 4;
    }
  }

  // ---- junction patches and kerb returns ---------------------------------
  const arms = [];
  let patches = 0;

  for (const n of junctions) {
    arms.length = 0;
    for (const ei of n.edges) {
      const e = world.edges[ei];
      if (!e.pts || e.length < 0.5) continue;
      const atA = e.a === n.i;
      const p = pointOnEdge(e, atA ? trim[ei * 2] : e.length - trim[ei * 2 + 1]);
      if (!p) continue;
      // Leaving the node runs against increasing arc length whenever the node
      // is the far end of the edge, and the road's normal has to turn with it.
      const sg = atA ? 1 : -1;
      const nx = p.nx * sg, nz = p.nz * sg, h = e.width / 2;
      arms.push({
        city: CITY[e.kind] === 1,
        ang: Math.atan2(p.tz * sg, p.tx * sg),
        ax: p.x - nx * h, az: p.z - nz * h,                     // clockwise-most
        bx: p.x + nx * h, bz: p.z + nz * h,                     // anticlockwise-most
        ox: p.x - nx * (h + WALK_W), oz: p.z - nz * (h + WALK_W),
        qx: p.x + nx * (h + WALK_W), qz: p.z + nz * (h + WALK_W),
      });
    }
    if (arms.length < 3) continue;
    arms.sort((u, v) => u.ang - v.ang);

    const bk = bucket(n.x, n.z);
    const cy = ground.heightAt(n.x, n.z) + LIFT;
    const ct = tint(n.x, n.z);
    const pr = patchRow[patchKind.get(n.i)];

    // Fan from the node out to every mouth corner in turn. Sorted by the angle
    // the road leaves at, the corners form a star-shaped ring around the node,
    // so a fan covers both the mouths and the wedges between them.
    let R = 3;
    for (const m of arms) {
      R = Math.max(R, Math.hypot(m.ax - n.x, m.az - n.z), Math.hypot(m.bx - n.x, m.bz - n.z));
    }
    const inv = 0.5 / R;
    const uvP = (o, x, y, z) => V(o, x, y, z,
      clamp(0.5 + (x - n.x) * inv, 0, 1),
      vOf(pr, clamp(0.5 + (z - n.z) * inv, 0, 1)), tint(x, z));

    for (let k = 0; k < arms.length * 2; k++) {
      const m0 = arms[(k >> 1) % arms.length], m1 = arms[((k + 1) >> 1) % arms.length];
      const x0 = (k & 1) ? m0.bx : m0.ax, z0 = (k & 1) ? m0.bz : m0.az;
      const x1 = (k & 1) ? m1.ax : m1.bx, z1 = (k & 1) ? m1.az : m1.bz;
      tri(bk,
        V(_a, n.x, cy, n.z, 0.5, vOf(pr, 0.5), ct),
        uvP(_b, x0, ground.heightAt(x0, z0) + LIFT, z0),
        uvP(_c, x1, ground.heightAt(x1, z1) + LIFT, z1),
        0, 1, 0);
    }
    patches++;

    if (walkRow < 0) continue;
    // Kerb returns. Without them every city intersection has a four-way gap in
    // the pavement, which is far more noticeable than the corners themselves.
    for (let k = 0; k < arms.length; k++) {
      const m0 = arms[k], m1 = arms[(k + 1) % arms.length];
      if (!m0.city || !m1.city) continue;
      const chord = Math.hypot(m1.ax - m0.bx, m1.az - m0.bz);
      if (chord < 0.4) continue;
      const wv = vOf(walkRow, Math.min(1, chord / TILE)), wv0 = vOf(walkRow, 0);
      const kv = vOf(kerbRow, Math.min(1, chord / TILE)), kv0 = vOf(kerbRow, 0);
      const y0 = ground.heightAt(m0.bx, m0.bz) + LIFT;
      const y1 = ground.heightAt(m1.ax, m1.az) + LIFT;
      // The face has to look away from the junction, whichever way round the
      // wedge happens to be wound.
      const mx = (m0.bx + m1.ax) * 0.5 - n.x, mz = (m0.bz + m1.az) * 0.5 - n.z;

      const t0 = tint(m0.bx, m0.bz), t1 = tint(m1.ax, m1.az);
      quad(bk,
        V(_a, m0.bx, y0, m0.bz, 0, kv0, t0), V(_b, m0.bx, y0 + KERB, m0.bz, 1, kv0, t0),
        V(_c, m1.ax, y1 + KERB, m1.az, 1, kv, t1), V(_d, m1.ax, y1, m1.az, 0, kv, t1),
        mx, 0, mz);
      quad(bk,
        V(_a, m0.bx, y0 + KERB, m0.bz, 0, wv0, t0),
        V(_b, m0.qx, ground.heightAt(m0.qx, m0.qz) + LIFT + KERB, m0.qz, 1, wv0, tint(m0.qx, m0.qz)),
        V(_c, m1.ox, ground.heightAt(m1.ox, m1.oz) + LIFT + KERB, m1.oz, 1, wv, tint(m1.ox, m1.oz)),
        V(_d, m1.ax, y1 + KERB, m1.az, 0, wv, t1),
        0, 1, 0);
    }
  }

  // ---- material and meshes -----------------------------------------------
  const texture = new THREE.CanvasTexture(atlas.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // buildAtlas() measures each row's v-range from the TOP of the canvas, which
  // is the only sane way to stack rows you are drawing with a 2D context. A
  // CanvasTexture flips Y by default, so without this every road samples the
  // MIRROR of its own row — asphalt streets came out as the dirt patch tile and
  // sidewalks appeared in the middle of the carriageway.
  texture.flipY = false;
  // U spans the carriageway and V never leaves its row, so both axes clamp.
  // The tiling along the road is done in the UVs, not by the sampler.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = opts.anisotropy ?? 8;

  const material = new THREE.MeshLambertMaterial({
    map: texture,
    vertexColors: true,
    // Belt and braces with the 4 cm lift: the terrain mesh is built from the
    // same height field, so at grazing angles a metre away the two surfaces are
    // within a depth-buffer step of each other.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const group = new THREE.Group();
  group.name = 'roads';
  group.matrixAutoUpdate = false;

  const meshes = [];
  const centreX = new Float32Array(buckets.size);
  const centreZ = new Float32Array(buckets.size);
  let triangles = 0, vertices = 0;

  for (const bk of buckets.values()) {
    if (bk.pos.length < 9) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bk.col, 3));
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'roads.region';
    mesh.receiveShadow = true;
    mesh.castShadow = false;                 // a flat sheet casts nothing useful
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    centreX[meshes.length] = bk.cx;
    centreZ[meshes.length] = bk.cz;
    meshes.push(mesh);
    group.add(mesh);
    vertices += bk.pos.length / 3;
    triangles += bk.pos.length / 9;
  }
  group.updateMatrix();
  buckets.clear();

  // ---- runtime ------------------------------------------------------------
  // Defaults to the 'high' row above. main.js never calls roads.setQuality(),
  // so whatever is chosen here is what actually ships.
  let cullDist = opts.drawDistance ?? QUALITY.high.drawDistance;
  const regionRadius = REGION * Math.SQRT1_2;
  let acc = 1;                               // forces a pass on the first frame

  /**
   * Distance culling only — the roads never move, so there is nothing else to
   * do here. Re-evaluated at 20 Hz rather than every frame: a region's
   * visibility cannot change meaningfully in 50 ms at any speed the car can
   * reach, and toggling on the frame boundary makes the horizon flicker.
   */
  function update(cameraPos, dt) {
    // A caller that passes no dt (or a paused dt of 0) would otherwise never
    // reach the threshold again after the first pass and freeze the culling
    // wherever it happened to be. Re-evaluating every call instead is 55
    // compares; the 20 Hz gate is an economy, not a correctness condition.
    acc += dt > 0 ? dt : 0.05;
    if (acc < 0.05) return;
    acc = 0;
    const lim = cullDist + regionRadius;
    const limSq = lim * lim;
    for (let i = 0; i < meshes.length; i++) {
      const dx = cameraPos.x - centreX[i];
      const dz = cameraPos.z - centreZ[i];
      meshes[i].visible = dx * dx + dz * dz < limSq;
    }
  }

  /** Accepts an engine tier name or any object carrying the two fields. */
  function setQuality(q) {
    const t = typeof q === 'string' ? QUALITY[q] : q;
    if (!t) return;
    if (t.drawDistance !== undefined) cullDist = t.drawDistance;
    if (t.anisotropy !== undefined && t.anisotropy !== texture.anisotropy) {
      texture.anisotropy = t.anisotropy;
      texture.needsUpdate = true;            // sampler state is set on upload
    }
    acc = 1;
  }

  function dispose() {
    for (const m of meshes) m.geometry.dispose();
    group.clear();
    meshes.length = 0;
    material.dispose();
    texture.dispose();
  }

  return {
    group, update, setQuality, dispose,
    stats: {
      drawCalls: meshes.length,
      triangles, vertices, quads, patches,
      atlasRows: specs.length,
      atlas: `${atlas.width}x${atlas.height}`,
      buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    },
  };
}
