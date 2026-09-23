// The buildings.
//
// COORDINATE CONVENTION — forward = -Z, right = +X, up = +Y, and yaw grows
// counter-clockwise seen from above. Nothing here faces a direction, but one
// sign matters and has bitten this project before: layout.js rotates a lot's
// local frame with the 2D form (x cos r - z sin r, x sin r + z cos r), while
// three's rotation about +Y is the OPPOSITE sense in that same plane. So every
// building's mesh yaw is -lot.rot. Get it wrong and each block sits at a
// visible angle to its own street.
//
// WHY IT IS BUILT THIS WAY
//
// A city block is not interesting geometry, it is interesting SURFACE, and
// there are a few thousand of them. Two things follow.
//
// First, the geometry is deliberately stupid: every building is a handful of
// boxes, roof planes and quads, all instanced from five unit shells. A tower is
// three stacked boxes with a crown; a house is a box, two roof slopes and some
// front-garden clutter. Nothing is modelled that a facade texture can say
// instead.
//
// Second, the facades tile, which normally means a 60 m tower and a 6 m
// bungalow get windows of wildly different sizes. That is fixed with a
// per-instance repeat count: each texture declares how much WALL one wrap
// covers (in metres), the repeat is rounded to whole windows so nothing is cut
// in half at a corner, and the vertex shader picks the right pair of counts for
// the face it is on. Windows are therefore the same size everywhere, and the
// whole city is 23 draw calls.
//
// Night is the same trick again. The emissive map does not store "lit", it
// stores a per-window random KEY, and the shader lights a window when the key
// falls under this building's occupancy. Occupancy is (per-building random) x
// (time of night), so as dusk falls the windows come on a few at a time and in
// a different pattern per building, out of one 512x512 texture and one uniform.
//
// Every business name on a shopfront is invented. That is a hard requirement.
//
// THE COUNTRY
//
// There is no city in this world any more: it is farmhouses, sheds and barns,
// seen at 30 m/s across a field. At that distance what makes a building read
// as a building is not texture detail but a handful of big cues, and the
// flat-painted boxes had none of them:
//
//   * DEPTH. Every facade is drawn twice — once in colour, once as relief in
//     the same metre space — and the relief becomes a normal map. Windows sit
//     back in their reveals, sills and lintels stand proud, boards and battens
//     and brick courses catch a low sun. It costs one texture fetch.
//   * MATERIAL. A farmhouse is lap board, render over a brick plinth, brick,
//     or stone; a barn is stained board-and-batten or profiled steel. Each is
//     its own texture rather than one texture tinted five ways.
//   * SILHOUETTE. Hip roofs as well as gables, chimneys, a fascia along the
//     eaves, barn roofs pitched like barns (27 degrees, not 9), big sliding
//     doors on a barn's gable end and a hay-loft door above them.
//   * GROUNDING. The bottom metre of every wall darkens toward the ground. It
//     is the cheapest possible ambient occlusion — computed in the vertex
//     shader from the instance's own height — and it is most of what stops a
//     box looking pasted onto the grass.
//
// Small "houses" (under 4.5 m) are sheds and are built as sheds: timber, one
// door, no windows, no porch, no garden wall, and dark at night.

import * as THREE from 'three';
import { mulberry, clamp } from '../world/noise.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// How much wall, in metres, one wrap of each texture covers. Everything else
// about facade scale is derived from these.
const TILE = {
  tower: { u: 12.8, v: 21.6 },   // 8 panes of 1.6 m, 6 floors of 3.6 m
  block: { u: 12.0, v: 13.6 },   // 4 bays of 3.0 m, 4 floors of 3.4 m
  house: { u: 8.0,  v: 5.8  },   // 2 bays of 4.0 m, 2 floors of 2.9 m
  ware:  { u: 6.0,  v: 6.0  },
  shop:  { u: 16.0, v: 4.4  },   // 3 shopfronts
  gable: { u: 4.0,  v: 4.0  },
  tiles: { u: 3.0,  v: 3.0  },
  metal: { u: 4.0,  v: 4.0  },
  trim:  { u: 4.0,  v: 4.0  },
  flat:  { u: 16.0, v: 16.0 },
  timber: { u: 4.0, v: 4.0 },    // board-and-batten, 0.22 m boards
  brick: { u: 2.0, v: 2.0 },     // plain brick for chimneys
};

// Draw distance in metres, per instance rather than per mesh, so a house's
// garden wall can vanish long before the house does. Towers are the skyline and
// are never dropped.
const CULL = {
  tower: Infinity,
  block: 2400,
  ware: 1500,
  house: 1100,
  detail: 300,     // porches, garden walls, front doors
  dock: 520,       // roller doors, roof vents
};

const QUALITY = {
  low:    { distance: 0.55, anisotropy: 1,  shadows: false },
  // Buildings cast on medium too: they are a handful of instanced boxes, and a
  // barn with no shadow on the lane beside it reads as a sticker.
  medium: { distance: 0.80, anisotropy: 4,  shadows: true  },
  high:   { distance: 1.00, anisotropy: 8,  shadows: true  },
  ultra:  { distance: 1.30, anisotropy: 16, shadows: true  },
};

// A mesh is only re-culled once the camera has moved this far since its own
// last pass, and only one mesh is re-culled per frame.
const REFRESH_MOVE = 26;

// Invented, every one of them. No real trader's name appears in this city.
const SHOP_NAMES = [
  'MARLOWE & SONS', 'TIDEWATER COFFEE', 'PELLINGTON BOOKS', 'BRACKENFORD GROCER',
  'NORTHVANE PHARMACY', 'SABLE & FERN', 'CRESSET HARDWARE', 'OKONJO BAKERY',
  'VELLA LAUNDRY', 'GRIMSBRO RECORDS', 'AMBERLING DELI', 'QUINTARO NOODLES',
  'FOXWORTH TAILORS', 'BRINDLE OPTICAL', 'LANTERNWAY DINER', 'HOLLOWAY FLORIST',
  'CINDERHILL PIZZA', 'MORROWGATE BANK', 'DUSKWATER TEA', 'ARBENTINE SHOES',
  'KETTLEMARK PRINT', 'CASTERWAY CYCLES', 'PADDOCK & VANE', 'WREXHOLM SUPPLY',
];

// Tinted textures are drawn light so the per-instance colour supplies the hue
// rather than fighting a colour already baked in.
const HOUSE_PAINT = [
  0xe9e3d6, 0xd8ccb4, 0xc7d2cd, 0xe0c9a8, 0xbfc9d4,
  0xd3bfae, 0xcbd6c4, 0xefe6e0, 0xb9a894, 0xdfd2c0,
];
const ROOF_PAINT = [0x8a6350, 0x9a7358, 0x625f5c, 0x776c66, 0xa87052, 0x53585c];
const WARE_PAINT = [0xb9bec4, 0xa7b2b8, 0xc2c0b6, 0x9aa6ae, 0xb0aca2, 0x8f9aa2];
const TRIM_TINT = [0xd8d5cf, 0xcfccc6, 0xc4c2bd, 0xdedbd4];
const GLASS_TINT = [0xffffff, 0xe8f0f4, 0xf4ece0, 0xdfe8ee];
const MASONRY_TINT = [0xffffff, 0xf2e8dc, 0xe8eaec, 0xf6eee4];
// Brick and stone carry their own colour; the tint only nudges it.
const STONE_TINT = [0xffffff, 0xf4efe8, 0xece8e2, 0xfaf4ec];
// Stained and weathered board: barn red, tar black, silvered, brown, and the
// green some farms paint everything.
const TIMBER_TINT = [0x8e3a2c, 0x7c3326, 0x3a3634, 0x2e2c2b, 0xa39c92, 0x8a8278, 0x6e5440, 0x4f5a45];
const DOOR_TINT = [0xf4f1ea, 0x3d4f3a, 0x7a2e26, 0x2e3a4a, 0x2b2927];

// Face codes carried per vertex. The vertex shader uses them to choose which
// pair of repeat counts applies to the face being drawn.
const AXIS_Z = 0;     // faces looking along +/-Z: u spans the local X extent
const AXIS_X = 1;     // faces looking along +/-X: u spans the local Z extent
const AXIS_Y = 2;     // horizontal: u and v both span the footprint
const AXIS_FIT = 3;   // one wrap exactly, whatever the size (doors)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const css = (hex) => '#' + (hex & 0xffffff).toString(16).padStart(6, '0');

/** `hex` scaled by `k` and returned as a CSS colour. */
function shade(hex, k) {
  const r = clamp((((hex >> 16) & 255) * k) | 0, 0, 255);
  const g = clamp((((hex >> 8) & 255) * k) | 0, 0, 255);
  const b = clamp(((hex & 255) * k) | 0, 0, 255);
  return `rgb(${r},${g},${b})`;
}

const reps = (metres, tile) => Math.max(1, Math.round(metres / tile));

/**
 * A 2D context whose user units are METRES of wall with +Y up.
 *
 * Facade detail is specified in real sizes — a 1.5 m window, a 0.18 m lintel —
 * so a texture can change resolution without every number in it moving. The Y
 * flip matches three's default flipY, which puts uv v = 0 at the bottom of the
 * canvas, i.e. at the pavement.
 */
function tileCtx(pxW, pxH, tileW, tileH) {
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pxW / tileW, 0, 0, -pxH / tileH, 0, pxH);
  return ctx;
}

/** Centred text, in metres, shrunk to fit `maxW`. Drawn unflipped. */
function label(ctx, text, cx, cy, maxW, capHeight, colour, sx, sy) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const font = (px) => `700 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  let px = Math.max(7, Math.round(capHeight * sy));
  ctx.font = font(px);
  const wide = ctx.measureText(text).width;
  const room = maxW * sx;
  if (wide > room) ctx.font = font(Math.max(6, Math.floor((px * room) / wide)));
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx * sx, ctx.canvas.height - cy * sy);
  ctx.restore();
}

/** Fine grain, so a flat fill does not read as plastic under headlights. */
function grain(ctx, rnd, w, h, count, amount, cell) {
  for (let i = 0; i < count; i++) {
    const a = (rnd() - 0.5) * amount;
    ctx.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    ctx.fillRect(rnd() * w, rnd() * h, cell, cell);
  }
}

function texture(ctx, srgb, anisotropy) {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  // Window maps are data, not colour: r masks the glazing, g is the random key,
  // b is lamp warmth. An sRGB decode would bend all three.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * The relief half of a facade: a second canvas in the same metre space as its
 * colour, where grey 128 is the wall face and every step of grey is `depth` /
 * 255 metres in or out. Drawing both from the same numbers is what keeps the
 * window you see and the recess it sits in in the same place.
 */
function reliefCtx(pxW, pxH, tileW, tileH) {
  const ctx = tileCtx(pxW, pxH, tileW, tileH);
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, tileW, tileH);
  return ctx;
}
const G = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

/**
 * Relief to a tangent-space normal map. Heights wrap, because every facade
 * tiles. Slopes are in metres per metre, so a 3 cm sill is the same bevel on
 * a 512 px texture and a 128 px one.
 */
function normalMap(rel, tileW, tileH, depth, aniso) {
  const w = rel.canvas.width, h = rel.canvas.height;
  const src = rel.getImageData(0, 0, w, h).data;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const k = depth / 255;
  const sx = k / (2 * tileW / w), sy = k / (2 * tileH / h);
  for (let y = 0; y < h; y++) {
    // Canvas rows run DOWN the wall and texture v runs UP it (flipY), so the
    // row above is the +v neighbour.
    const up = ((y - 1 + h) % h) * w, dn = ((y + 1) % h) * w, row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w;
      const du = (src[(row + xr) * 4] - src[(row + xl) * 4]) * sx;
      const dv = (src[(up + x) * 4] - src[(dn + x) * 4]) * sy;
      const inv = 1 / Math.sqrt(du * du + dv * dv + 1);
      const o = (row + x) * 4;
      d[o] = (0.5 - 0.5 * du * inv) * 255;
      d[o + 1] = (0.5 - 0.5 * dv * inv) * 255;
      d[o + 2] = (0.5 + 0.5 * inv) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texture(ctx, false, aniso);
}

// ---------------------------------------------------------------------------
// Unit shells
// ---------------------------------------------------------------------------

const Q = 0.5;
const UNIT_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Assembles faces (fan-triangulated) into one indexed geometry. */
function shell(faces) {
  const pos = [], nor = [], uv = [], axis = [], idx = [];
  for (const f of faces) {
    const base = pos.length / 3;
    for (let i = 0; i < f.p.length; i++) {
      pos.push(f.p[i][0], f.p[i][1], f.p[i][2]);
      nor.push(f.n[0], f.n[1], f.n[2]);
      uv.push(f.uv[i][0], f.uv[i][1]);
      axis.push(f.axis);
    }
    for (let i = 2; i < f.p.length; i++) idx.push(base, base + i - 1, base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('faceAxis', new THREE.Float32BufferAttribute(axis, 1));
  g.setIndex(idx);
  return g;
}

function buildShells() {
  // Four walls of a unit box, centred on the origin. Top and bottom are left
  // out: the bottom is buried, and the top is a separate instance so a flat
  // roof can carry its own material without a second geometry group.
  const sides = shell([
    { p: [[-Q, -Q, Q], [Q, -Q, Q], [Q, Q, Q], [-Q, Q, Q]], n: [0, 0, 1], axis: AXIS_Z, uv: UNIT_UV },
    { p: [[Q, -Q, -Q], [-Q, -Q, -Q], [-Q, Q, -Q], [Q, Q, -Q]], n: [0, 0, -1], axis: AXIS_Z, uv: UNIT_UV },
    { p: [[Q, -Q, Q], [Q, -Q, -Q], [Q, Q, -Q], [Q, Q, Q]], n: [1, 0, 0], axis: AXIS_X, uv: UNIT_UV },
    { p: [[-Q, -Q, -Q], [-Q, -Q, Q], [-Q, Q, Q], [-Q, Q, -Q]], n: [-1, 0, 0], axis: AXIS_X, uv: UNIT_UV },
  ]);

  // Roof deck, at local y = 0 so it can be placed at an absolute height.
  const cap = shell([
    { p: [[-Q, 0, Q], [Q, 0, Q], [Q, 0, -Q], [-Q, 0, -Q]], n: [0, 1, 0], axis: AXIS_Y, uv: UNIT_UV },
  ]);

  // Upright panel facing +Z, for doors.
  const panel = shell([
    { p: [[-Q, -Q, 0], [Q, -Q, 0], [Q, Q, 0], [-Q, Q, 0]], n: [0, 0, 1], axis: AXIS_FIT, uv: UNIT_UV },
  ]);

  // Pitched roof: ridge along local X at z = 0, eaves at z = +/-Q. The normals
  // are the unit shell's; three's instancing path applies the inverse-transpose
  // of the instance matrix, so a non-uniform scale still lights correctly.
  const s = 1 / Math.sqrt(1.25);
  const slopes = shell([
    { p: [[-Q, -Q, Q], [Q, -Q, Q], [Q, Q, 0], [-Q, Q, 0]], n: [0, 0.5 * s, s], axis: AXIS_Z, uv: UNIT_UV },
    { p: [[Q, -Q, -Q], [-Q, -Q, -Q], [-Q, Q, 0], [Q, Q, 0]], n: [0, 0.5 * s, -s], axis: AXIS_Z, uv: UNIT_UV },
  ]);

  const ends = shell([
    { p: [[Q, -Q, Q], [Q, -Q, -Q], [Q, Q, 0]], n: [1, 0, 0], axis: AXIS_X, uv: [[0, 0], [1, 0], [0.5, 1]] },
    { p: [[-Q, -Q, -Q], [-Q, -Q, Q], [-Q, Q, 0]], n: [-1, 0, 0], axis: AXIS_X, uv: [[0, 0], [1, 0], [0.5, 1]] },
  ]);

  // Hip roof: the ridge stops 30% of the length short of each end, and the
  // ends slope too. The inset is a fraction of the length because the shell is
  // scaled per instance; across real farmhouse proportions that gives hips
  // between 35 and 50 degrees, which is the range real ones are built at.
  const I = 0.3;
  const hn = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  const hf = [[-Q, -Q, Q], [Q, -Q, Q], [Q - I, Q, 0], [-Q + I, Q, 0]];
  const hb = [[Q, -Q, -Q], [-Q, -Q, -Q], [-Q + I, Q, 0], [Q - I, Q, 0]];
  const he = [[Q, -Q, Q], [Q, -Q, -Q], [Q - I, Q, 0]];
  const hw = [[-Q, -Q, -Q], [-Q, -Q, Q], [-Q + I, Q, 0]];
  const hips = shell([
    { p: hf, n: hn(hf[0], hf[1], hf[2]), axis: AXIS_Z, uv: [[0, 0], [1, 0], [1 - I, 1], [I, 1]] },
    { p: hb, n: hn(hb[0], hb[1], hb[2]), axis: AXIS_Z, uv: [[0, 0], [1, 0], [1 - I, 1], [I, 1]] },
    { p: he, n: hn(he[0], he[1], he[2]), axis: AXIS_X, uv: [[0, 0], [1, 0], [0.5, 1]] },
    { p: hw, n: hn(hw[0], hw[1], hw[2]), axis: AXIS_X, uv: [[0, 0], [1, 0], [0.5, 1]] },
  ]);

  return { sides, cap, panel, slopes, ends, hips };
}

// ---------------------------------------------------------------------------
// Facade textures
// ---------------------------------------------------------------------------

const TOWER_GLASS = [
  { pane: 0x36505c, sky: 0x86a8bc, mull: 0xa9b3ba, spandrel: 0x24343e },
  { pane: 0x4a3d2d, sky: 0xb59a72, mull: 0x8d7d68, spandrel: 0x33291d },
  { pane: 0x232830, sky: 0x5d6874, mull: 0xd6dade, spandrel: 0x191d23 },
];

function towerFacade(v, rnd, aniso) {
  const T = TILE.tower, cols = 8, rows = 6;
  const ctx = tileCtx(512, 512, T.u, T.v);
  const P = TOWER_GLASS[v];
  const cw = T.u / cols, ch = T.v / rows;

  ctx.fillStyle = css(P.mull);
  ctx.fillRect(0, 0, T.u, T.v);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw, y = r * ch;
      // Spandrel: the opaque panel hiding the floor slab. Real curtain walls are
      // roughly a quarter opaque, which is most of why they read as banded.
      ctx.fillStyle = css(P.spandrel);
      ctx.fillRect(x + 0.05, y + 0.06, cw - 0.10, 0.86);

      const gy = y + 0.98, gh = ch - 1.06;
      const g = ctx.createLinearGradient(0, gy, 0, gy + gh);
      const lean = 0.72 + rnd() * 0.5;
      g.addColorStop(0, shade(P.pane, lean * 0.82));
      g.addColorStop(0.62, shade(P.pane, lean));
      g.addColorStop(1, shade(P.sky, lean * 0.9));
      ctx.fillStyle = g;
      ctx.fillRect(x + 0.05, gy, cw - 0.10, gh);

      // A blind left half down, on maybe one pane in six.
      if (rnd() < 0.16) {
        ctx.fillStyle = `rgba(226,222,210,${0.28 + rnd() * 0.3})`;
        ctx.fillRect(x + 0.07, gy + gh * (0.45 + rnd() * 0.3), cw - 0.14, gh * 0.5);
      }
    }
  }

  // Vertical mullion fins, heavier every fourth bay. These are what stop a glass
  // tower reading as a mirror slab at any distance.
  for (let c = 0; c <= cols; c++) {
    const wide = c % 4 === 0;
    ctx.fillStyle = shade(P.mull, wide ? 1.12 : 0.94);
    ctx.fillRect(c * cw - (wide ? 0.09 : 0.045), 0, wide ? 0.18 : 0.09, T.v);
  }
  grain(ctx, rnd, T.u, T.v, 900, 0.10, 0.09);
  return texture(ctx, true, aniso);
}

// The window maps do not vary with the glass variant — the pattern of lit
// offices has nothing to do with what colour the glazing is — so each call just
// draws a fresh arrangement from the shared sequence.
function towerWindows(rnd, aniso) {
  const T = TILE.tower, cols = 8, rows = 6;
  const ctx = tileCtx(512, 512, T.u, T.v);
  const cw = T.u / cols, ch = T.v / rows;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T.u, T.v);

  for (let r = 0; r < rows; r++) {
    // Offices empty a floor at a time, so a floor shares most of its key.
    const floorKey = rnd();
    const floorWarm = rnd() < 0.3;
    for (let c = 0; c < cols; c++) {
      const key = clamp(floorKey * 0.66 + rnd() * 0.5, 0.05, 1);
      const warm = floorWarm ? 0.72 + rnd() * 0.28 : rnd() * 0.3;
      ctx.fillStyle = `rgb(255,${Math.round(key * 255)},${Math.round(warm * 255)})`;
      ctx.fillRect(c * cw + 0.05, r * ch + 0.98, cw - 0.10, ch - 1.06);
    }
  }
  return texture(ctx, false, aniso);
}

const BLOCK_WALL = [
  { base: 0xb08272, band: 0xc09a86, trim: 0xe8e0d2, streak: 0.06 },
  { base: 0xd8c8a4, band: 0xe4d6b6, trim: 0xf2ead6, streak: 0.05 },
  { base: 0xbcbbb4, band: 0xcbcac3, trim: 0xdedcd4, streak: 0.08 },
];

function blockFacade(v, rnd, aniso) {
  const T = TILE.block, bays = 4, floors = 4;
  const ctx = tileCtx(512, 512, T.u, T.v);
  const P = BLOCK_WALL[v];
  const bw = T.u / bays, fh = T.v / floors;

  ctx.fillStyle = css(P.base);
  ctx.fillRect(0, 0, T.u, T.v);
  // Coursing, at a spacing coarse enough to survive the mip chain rather than
  // dissolving into a grey haze two blocks away.
  for (let y = 0; y < T.v; y += 0.62) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.03})`;
    ctx.fillRect(0, y, T.u, 0.05);
  }
  grain(ctx, rnd, T.u, T.v, 2400, 0.16, 0.07);

  for (let f = 0; f < floors; f++) {
    // String course at each floor line.
    ctx.fillStyle = css(P.trim);
    ctx.fillRect(0, f * fh - 0.09, T.u, 0.18);

    for (let b = 0; b < bays; b++) {
      const x = b * bw + (bw - 1.5) / 2, y = f * fh + 0.95;
      ctx.fillStyle = css(P.trim);
      ctx.fillRect(x - 0.16, y - 0.18, 1.82, 0.16);      // sill
      ctx.fillRect(x - 0.10, y + 1.9, 1.70, 0.20);       // lintel
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(x - 0.06, y - 0.02, 1.62, 1.94);      // reveal

      const g = ctx.createLinearGradient(0, y, 0, y + 1.9);
      g.addColorStop(0, '#1d2429');
      g.addColorStop(0.75, '#2c3841');
      g.addColorStop(1, '#586b78');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1.5, 1.9);
      if (rnd() < 0.3) {
        ctx.fillStyle = `rgba(224,220,206,${0.3 + rnd() * 0.35})`;
        ctx.fillRect(x, y + 1.9 * (0.5 + rnd() * 0.28), 1.5, 1.9 * 0.5);
      }
      // Weathering below the sill — the single cheapest cue that a wall is old.
      ctx.fillStyle = `rgba(40,34,28,${P.streak})`;
      ctx.fillRect(x + 0.15, y - 1.0, 0.22, 0.85);
      ctx.fillRect(x + 1.1, y - 0.8, 0.18, 0.68);
    }
  }
  return texture(ctx, true, aniso);
}

function blockWindows(rnd, aniso) {
  const T = TILE.block, bays = 4, floors = 4;
  const ctx = tileCtx(512, 512, T.u, T.v);
  const bw = T.u / bays, fh = T.v / floors;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let f = 0; f < floors; f++) {
    for (let b = 0; b < bays; b++) {
      const key = clamp(0.08 + rnd() * 0.85, 0.05, 1);
      const warm = 0.55 + rnd() * 0.45;   // homes above shops: warm lamps
      ctx.fillStyle = `rgb(255,${Math.round(key * 255)},${Math.round(warm * 255)})`;
      ctx.fillRect(b * bw + (bw - 1.5) / 2, f * fh + 0.95, 1.5, 1.9);
    }
  }
  return texture(ctx, false, aniso);
}

const SHOP_TRIM = [0x2f3f4a, 0x6d2f2f, 0x24503f, 0x4a3a63, 0x7a5a24, 0x2c2c30];

function shopFacade(v, rnd, aniso) {
  const T = TILE.shop, shops = 3;
  const pxW = 512, pxH = 256;
  const ctx = tileCtx(pxW, pxH, T.u, T.v);
  const sx = pxW / T.u, sy = pxH / T.v;
  const sw = T.u / shops;

  // Variant 0 is a painted timber parade, variant 1 anodised metal with a
  // canopy — enough difference that two of them next to each other read as two
  // different terraces rather than one repeated asset.
  ctx.fillStyle = v === 0 ? '#3b3a37' : '#54585c';
  ctx.fillRect(0, 0, T.u, T.v);

  for (let i = 0; i < shops; i++) {
    const x = i * sw;
    const accent = SHOP_TRIM[(rnd() * SHOP_TRIM.length) | 0];
    const name = SHOP_NAMES[(rnd() * SHOP_NAMES.length) | 0];

    ctx.fillStyle = '#2a2724';                              // plinth
    ctx.fillRect(x + 0.05, 0, sw - 0.10, 0.34);

    const g = ctx.createLinearGradient(0, 0.34, 0, 3.1);
    g.addColorStop(0, '#15181b');
    g.addColorStop(0.55, '#1e242a');
    g.addColorStop(1, '#39424a');
    ctx.fillStyle = g;
    ctx.fillRect(x + 0.05, 0.34, sw - 0.10, 2.76);

    // Door at one end, glazing across the rest.
    const doorLeft = rnd() < 0.5;
    const dx = doorLeft ? x + 0.18 : x + sw - 1.28;
    ctx.fillStyle = shade(accent, 0.7);
    ctx.fillRect(dx, 0.34, 1.1, 2.5);
    ctx.fillStyle = '#20262c';
    ctx.fillRect(dx + 0.12, 0.5, 0.86, 2.16);
    ctx.fillStyle = '#c9c6bd';
    ctx.fillRect(dx + (doorLeft ? 0.86 : 0.16), 1.2, 0.08, 0.26);

    ctx.fillStyle = css(accent);                             // fascia
    ctx.fillRect(x + 0.05, 3.1, sw - 0.10, T.v - 3.1);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 0.05, 3.02, sw - 0.10, 0.12);           // shadow under it
    if (v === 1) {                                           // canopy
      ctx.fillStyle = shade(accent, 1.5);
      ctx.fillRect(x + 0.05, 2.86, sw - 0.10, 0.2);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(x + 0.05, 2.6, sw - 0.10, 0.26);
    }
    label(ctx, name, x + sw / 2, 3.75, sw - 0.5, 0.52, '#f3efe6', sx, sy);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';                       // party mullion
    ctx.fillRect(x - 0.05, 0, 0.14, T.v);
  }
  grain(ctx, rnd, T.u, T.v, 700, 0.10, 0.08);
  return texture(ctx, true, aniso);
}

function shopWindows(rnd, aniso) {
  const T = TILE.shop, shops = 3;
  const ctx = tileCtx(512, 256, T.u, T.v);
  const sw = T.u / shops;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let i = 0; i < shops; i++) {
    const x = i * sw;
    // Shops light at dusk, before the offices above them — hence the tiny keys.
    ctx.fillStyle = 'rgb(255,18,215)';
    ctx.fillRect(x + 0.09, 0.36, sw - 0.18, 2.7);            // interior
    ctx.fillStyle = `rgb(255,13,${Math.round((rnd() < 0.5 ? 0.9 : 0.2) * 255)})`;
    ctx.fillRect(x + 0.09, 3.14, sw - 0.18, T.v - 3.24);     // illuminated sign
  }
  return texture(ctx, false, aniso);
}

// The farmhouse wall. Four constructions, one window layout — the emissive
// map below lights the same rectangles whichever wall they are cut into.
//
//   0  painted lap board
//   1  render over a brick plinth
//   2  brick, with soldier-course lintels and stone sills
//   3  coursed stone, with dressed quoin-like surrounds
//
// Each is drawn in colour and in relief. The relief is what a low sun and a
// headlight actually find: the glass sits 12 cm back in its reveal, the sill
// stands out 5 cm, the boards step, the mortar is a groove.
function houseWall(v, rnd, aniso) {
  const T = TILE.house, bays = 2, floors = 2;
  const W = 512, Hp = 384;
  const ctx = tileCtx(W, Hp, T.u, T.v);
  const rel = reliefCtx(W, Hp, T.u, T.v);
  const bw = T.u / bays, fh = T.v / floors;
  const glassX = (b) => b * bw + (bw - 1.25) / 2, glassY = (f) => f * fh + 1.05;

  if (v === 0) {
    // Lap board: each board overlaps the one below, so its bottom edge stands
    // proud and throws a thin shadow line. Painted white; the instance tints it.
    ctx.fillStyle = '#efece4';
    ctx.fillRect(0, 0, T.u, T.v);
    for (let y = 0; y < T.v; y += 0.20) {
      const g = ctx.createLinearGradient(0, y, 0, y + 0.20);
      g.addColorStop(0, 'rgba(0,0,0,0.16)');
      g.addColorStop(0.18, 'rgba(0,0,0,0.02)');
      g.addColorStop(1, 'rgba(255,255,255,0.10)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, T.u, 0.20);
      const r = rel.createLinearGradient(0, y, 0, y + 0.20);
      r.addColorStop(0, G(150));
      r.addColorStop(1, G(118));
      rel.fillStyle = r;
      rel.fillRect(0, y, T.u, 0.20);
    }
    grain(ctx, rnd, T.u, T.v, 1800, 0.08, 0.04);
  } else if (v === 1) {
    // Render: a fine float-finish, with a dark brick plinth to the pavement.
    ctx.fillStyle = '#efece4';
    ctx.fillRect(0, 0, T.u, T.v);
    grain(ctx, rnd, T.u, T.v, 5200, 0.16, 0.035);
    for (let i = 0; i < 1400; i++) {
      rel.fillStyle = G(120 + rnd() * 16);
      rel.fillRect(rnd() * T.u, rnd() * T.v, 0.04, 0.04);
    }
    brickCourse(ctx, rel, rnd, 0, 0.72, T.u, [118, 74, 58], 0.85);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0.70, T.u, 0.04);                      // drip at the plinth
    rel.fillStyle = G(150);
    rel.fillRect(0, 0.72, T.u, 0.03);
  } else if (v === 2) {
    brickCourse(ctx, rel, rnd, 0, T.v, T.u, [148, 82, 60], 1);
  } else {
    stoneCourse(ctx, rel, rnd, T.u, T.v);
  }

  for (let f = 0; f < floors; f++) {
    for (let b = 0; b < bays; b++) {
      const x = glassX(b), y = glassY(f);
      // Surround: painted timber on board and render, dressed stone on brick
      // and stone. Drawn first so the reveal cuts into it.
      if (v === 2 || v === 3) {
        ctx.fillStyle = v === 2 ? '#d9d2c3' : '#cfc8b9';
        ctx.fillRect(x - 0.14, y - 0.20, 1.53, 0.14);           // sill
        ctx.fillStyle = v === 2 ? '#8a4a36' : '#bdb5a5';
        ctx.fillRect(x - 0.10, y + 1.35, 1.45, 0.22);           // lintel
        if (v === 2) {
          for (let k = 0; k < 14; k++) {                        // soldier course
            ctx.fillStyle = 'rgba(40,20,14,0.5)';
            ctx.fillRect(x - 0.10 + k * 0.104, y + 1.35, 0.012, 0.22);
          }
        }
        rel.fillStyle = G(170);
        rel.fillRect(x - 0.14, y - 0.20, 1.53, 0.14);
        rel.fillStyle = G(142);
        rel.fillRect(x - 0.10, y + 1.35, 1.45, 0.22);
      } else {
        ctx.fillStyle = '#f7f5f0';
        ctx.fillRect(x - 0.11, y - 0.13, 1.47, 1.62);           // frame
        ctx.fillRect(x - 0.16, y - 0.22, 1.57, 0.11);           // sill
        rel.fillStyle = G(146);
        rel.fillRect(x - 0.11, y - 0.13, 1.47, 1.62);
        rel.fillStyle = G(176);
        rel.fillRect(x - 0.16, y - 0.22, 1.57, 0.11);
      }
      // The reveal: the wall's thickness, lit on its sill and in shadow under
      // its head. That shadow strip is what reads as depth from a car.
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(x - 0.05, y + 1.20, 1.35, 0.15);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x - 0.05, y - 0.05, 0.08, 1.40);
      const g = ctx.createLinearGradient(0, y, 0, y + 1.35);
      g.addColorStop(0, '#1c2226');
      g.addColorStop(0.6, '#2c363d');
      g.addColorStop(1, '#5d6e79');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1.25, 1.35);
      // Sky caught in the upper panes.
      ctx.fillStyle = 'rgba(200,215,228,0.14)';
      ctx.fillRect(x + 0.05, y + 0.85, 1.15, 0.42);
      // Casement bars.
      ctx.fillStyle = v === 2 || v === 3 ? '#ece8e0' : '#f7f5f0';
      ctx.fillRect(x + 0.585, y, 0.08, 1.35);
      ctx.fillRect(x, y + 0.86, 1.25, 0.06);
      rel.fillStyle = G(96);
      rel.fillRect(x, y, 1.25, 1.35);
      rel.fillStyle = G(112);
      rel.fillRect(x + 0.585, y, 0.08, 1.35);
      rel.fillRect(x, y + 0.86, 1.25, 0.06);
      // Weather streaks under the sill corners.
      ctx.fillStyle = 'rgba(40,34,28,0.07)';
      ctx.fillRect(x - 0.1, y - 0.9, 0.12, 0.68);
      ctx.fillRect(x + 1.2, y - 0.8, 0.10, 0.58);
    }
  }
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.30, aniso) };
}

/** Stretcher-bond brick from y0 to y1, drawn into both the colour and relief. */
function brickCourse(ctx, rel, rnd, y0, y1, w, rgb, weight) {
  const bh = 0.075, bl = 0.225, mortar = 0.011;
  ctx.fillStyle = `rgb(${Math.round(rgb[0] * 1.35)},${Math.round(rgb[1] * 1.55)},${Math.round(rgb[2] * 1.6)})`;
  ctx.fillRect(0, y0, w, y1 - y0);
  rel.fillStyle = G(116);
  rel.fillRect(0, y0, w, y1 - y0);
  let row = 0;
  for (let y = y0; y < y1 - 0.01; y += bh, row++) {
    for (let x = (row % 2) * -bl * 0.5; x < w; x += bl) {
      const k = 0.78 + rnd() * 0.36;
      const burnt = rnd() < 0.08 ? 0.62 : 1;
      ctx.fillStyle = `rgba(${Math.round(rgb[0] * k * burnt)},${Math.round(rgb[1] * k * burnt)},${Math.round(rgb[2] * k * burnt)},${weight})`;
      ctx.fillRect(x + mortar * 0.5, y + mortar * 0.5, bl - mortar, Math.min(bh, y1 - y) - mortar);
      rel.fillStyle = G(132 + rnd() * 8);
      rel.fillRect(x + mortar * 0.5, y + mortar * 0.5, bl - mortar, Math.min(bh, y1 - y) - mortar);
    }
  }
}

/** Coursed rubble: stone rows of varying height, stones of varying length. */
function stoneCourse(ctx, rel, rnd, w, h) {
  ctx.fillStyle = '#9d9587';                       // lime mortar
  ctx.fillRect(0, 0, w, h);
  rel.fillStyle = G(110);
  rel.fillRect(0, 0, w, h);
  let y = 0;
  while (y < h) {
    const rh = 0.16 + rnd() * 0.22;
    let x = -rnd() * 0.4;
    while (x < w) {
      const sl = 0.25 + rnd() * 0.55;
      const t = 0.72 + rnd() * 0.32;
      const warm = rnd();
      const r = (156 + 30 * warm) * t, g = (148 + 18 * warm) * t, b = (132 + 6 * warm) * t;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x + 0.015, y + 0.015, sl - 0.03, Math.min(rh, h - y) - 0.03);
      // A stone is domed, not flat: brighter relief in its middle.
      rel.fillStyle = G(136 + rnd() * 10);
      rel.fillRect(x + 0.015, y + 0.015, sl - 0.03, Math.min(rh, h - y) - 0.03);
      rel.fillStyle = G(150 + rnd() * 10);
      rel.fillRect(x + sl * 0.2, y + rh * 0.25, sl * 0.6, rh * 0.5);
      x += sl;
    }
    y += rh;
  }
  grain(ctx, rnd, w, h, 3000, 0.10, 0.03);
}

function houseWindows(rnd, aniso) {
  const T = TILE.house, bays = 2, floors = 2;
  const ctx = tileCtx(256, 192, T.u, T.v);
  const bw = T.u / bays, fh = T.v / floors;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let f = 0; f < floors; f++) {
    for (let b = 0; b < bays; b++) {
      const key = clamp(0.05 + rnd() * 0.8, 0.05, 1);
      ctx.fillStyle = `rgb(255,${Math.round(key * 255)},${Math.round((0.82 + rnd() * 0.18) * 255)})`;
      ctx.fillRect(b * bw + (bw - 1.25) / 2, f * fh + 1.05, 1.25, 1.35);
    }
  }
  return texture(ctx, false, aniso);
}

/**
 * Board-and-batten, the barn and shed wall. Drawn pale and neutral so the
 * instance colour stains it: barn red, tar black, silvered grey.
 */
function timberWall(rnd, aniso) {
  const T = TILE.timber;
  const ctx = tileCtx(256, 256, T.u, T.v);
  const rel = reliefCtx(256, 256, T.u, T.v);
  const board = 0.22, batten = 0.06;
  for (let x = 0; x < T.u; x += board) {
    const k = 0.86 + rnd() * 0.2;
    ctx.fillStyle = `rgb(${(226 * k) | 0},${(220 * k) | 0},${(212 * k) | 0})`;
    ctx.fillRect(x, 0, board, T.v);
    // Grain runs up the board.
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = `rgba(60,48,36,${0.04 + rnd() * 0.08})`;
      ctx.fillRect(x + rnd() * board, 0, 0.008 + rnd() * 0.012, T.v);
    }
    rel.fillStyle = G(124);
    rel.fillRect(x, 0, board, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(x - 0.008, 0, 0.016, T.v);                 // the joint
    rel.fillStyle = G(96);
    rel.fillRect(x - 0.008, 0, 0.016, T.v);
    // The batten over it, proud of the boards and throwing a thin shadow.
    ctx.fillStyle = `rgb(${(236 * k) | 0},${(230 * k) | 0},${(222 * k) | 0})`;
    ctx.fillRect(x - batten / 2, 0, batten, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + batten / 2, 0, 0.02, T.v);
    rel.fillStyle = G(170);
    rel.fillRect(x - batten / 2, 0, batten, T.v);
  }
  // No splash band at the foot: this tile repeats up a barn wall and across
  // its gable, and a band would repeat with it. The foot of the wall is
  // darkened in the shader instead, once, where the ground actually is.
  grain(ctx, rnd, T.u, T.v, 1200, 0.10, 0.03);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.12, aniso) };
}

/** Plain brick, for chimneys. */
function brickPlain(rnd, aniso) {
  const T = TILE.brick;
  const ctx = tileCtx(128, 128, T.u, T.v);
  const rel = reliefCtx(128, 128, T.u, T.v);
  brickCourse(ctx, rel, rnd, 0, T.v, T.u, [140, 78, 58], 1);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.12, aniso) };
}

/**
 * A sliding barn door: a frame of rails and stiles, boards, and the Z brace
 * every farm child could draw. One wrap covers the whole leaf.
 */
function barnDoor(rnd, aniso) {
  const ctx = tileCtx(128, 128, 1, 1);
  const rel = reliefCtx(128, 128, 1, 1);
  ctx.fillStyle = '#d8cfc2';
  ctx.fillRect(0, 0, 1, 1);
  for (let x = 0; x < 1; x += 0.083) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x, 0, 0.008, 1);
    rel.fillStyle = G(100);
    rel.fillRect(x, 0, 0.008, 1);
  }
  const frame = (x, y, w, h) => {
    ctx.fillStyle = '#ece6dc'; ctx.fillRect(x, y, w, h);
    rel.fillStyle = G(172); rel.fillRect(x, y, w, h);
  };
  frame(0, 0, 1, 0.07); frame(0, 0.93, 1, 0.07); frame(0, 0.46, 1, 0.07);
  frame(0, 0, 0.07, 1); frame(0.93, 0, 0.07, 1);
  // The brace, stepped along its length because a canvas has no rotated rect
  // that survives the metre transform cleanly.
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    frame(0.07 + t * 0.82, 0.07 + t * 0.39, 0.05, 0.035);
    frame(0.07 + t * 0.82, 0.53 + t * 0.39, 0.05, 0.035);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0.985, 1, 0.015);                         // track shadow
  grain(ctx, rnd, 1, 1, 400, 0.12, 0.012);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, 1, 1, 0.08, aniso) };
}

function wareWall(v, rnd, aniso) {
  const T = TILE.ware;
  const ctx = tileCtx(256, 256, T.u, T.v);
  const rel = reliefCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#dcdcd8';
  ctx.fillRect(0, 0, T.u, T.v);
  // Trapezoidal profile sheeting: a light face, a shaded return, a dark valley.
  // The relief carries the same profile, which is what makes a steel shed
  // shimmer in stripes as the sun moves round it.
  const pitch = v === 0 ? 0.26 : 0.34;
  for (let x = 0; x < T.u; x += pitch) {
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillRect(x, 0, pitch * 0.32, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x + pitch * 0.58, 0, pitch * 0.26, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(x + pitch * 0.84, 0, pitch * 0.16, T.v);
    rel.fillStyle = G(160); rel.fillRect(x, 0, pitch * 0.32, T.v);
    rel.fillStyle = G(140); rel.fillRect(x + pitch * 0.32, 0, pitch * 0.26, T.v);
    rel.fillStyle = G(112); rel.fillRect(x + pitch * 0.58, 0, pitch * 0.26, T.v);
    rel.fillStyle = G(96); rel.fillRect(x + pitch * 0.84, 0, pitch * 0.16, T.v);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, T.v * 0.5 - 0.05, T.u, 0.10);              // sheet lap
  ctx.fillStyle = 'rgba(60,58,54,0.5)';
  ctx.fillRect(0, 0, T.u, 0.7);                              // grubby plinth
  // Rust streaks under the fixings, which is what a shed's age looks like.
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = `rgba(122,74,42,${0.04 + rnd() * 0.08})`;
    ctx.fillRect(rnd() * T.u, rnd() * T.v, 0.04, 0.4 + rnd() * 1.2);
  }
  grain(ctx, rnd, T.u, T.v, 900, 0.14, 0.07);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.06, aniso) };
}

function gableSkin(rnd, aniso) {
  const T = TILE.gable;
  const ctx = tileCtx(128, 128, T.u, T.v);
  const rel = reliefCtx(128, 128, T.u, T.v);
  ctx.fillStyle = '#efece4';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let y = 0; y < T.v; y += 0.20) {
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(0, y, T.u, 0.04);
    const r = rel.createLinearGradient(0, y, 0, y + 0.20);
    r.addColorStop(0, G(150));
    r.addColorStop(1, G(118));
    rel.fillStyle = r;
    rel.fillRect(0, y, T.u, 0.20);
  }
  grain(ctx, rnd, T.u, T.v, 500, 0.12, 0.06);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.25, aniso) };
}

function roofTiles(rnd, aniso) {
  const T = TILE.tiles;
  const ctx = tileCtx(256, 256, T.u, T.v);
  const rel = reliefCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#e6e2dc';
  ctx.fillRect(0, 0, T.u, T.v);
  const course = 0.3, tile = 0.32;
  for (let y = 0, row = 0; y < T.v; y += course, row++) {
    // Each course laps the one below: its lower edge is proud and shadowed.
    const r = rel.createLinearGradient(0, y, 0, y + course);
    r.addColorStop(0, G(168));
    r.addColorStop(1, G(112));
    rel.fillStyle = r;
    rel.fillRect(0, y, T.u, course);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(0, y, T.u, 0.07);                            // course shadow
    for (let x = (row % 2) * tile * 0.5; x < T.u; x += tile) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.13})`;
      ctx.fillRect(x, y, 0.035, course);                      // joint
      rel.fillStyle = G(100);
      rel.fillRect(x, y, 0.025, course);
      if (rnd() < 0.22) {
        ctx.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.1})`;
        ctx.fillRect(x + 0.04, y + 0.08, tile - 0.08, course - 0.12);
      }
      if (rnd() < 0.06) {                                     // lichen
        ctx.fillStyle = `rgba(92,104,66,${0.15 + rnd() * 0.2})`;
        ctx.fillRect(x + rnd() * 0.2, y + rnd() * 0.2, 0.1, 0.08);
      }
    }
  }
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.18, aniso) };
}

function roofMetal(rnd, aniso) {
  const T = TILE.metal;
  const ctx = tileCtx(256, 256, T.u, T.v);
  const rel = reliefCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#d6d8d6';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let x = 0; x < T.u; x += 0.24) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x, 0, 0.07, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + 0.15, 0, 0.06, T.v);
    rel.fillStyle = G(176); rel.fillRect(x, 0, 0.05, T.v);
    rel.fillStyle = G(150); rel.fillRect(x + 0.05, 0, 0.03, T.v);
    rel.fillStyle = G(120); rel.fillRect(x + 0.15, 0, 0.06, T.v);
  }
  for (let i = 0; i < 14; i++) {                              // rust down a rib
    ctx.fillStyle = `rgba(122,74,42,${0.05 + rnd() * 0.12})`;
    ctx.fillRect(rnd() * T.u, rnd() * T.v, 0.07, 0.5 + rnd() * 1.6);
  }
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, T.u, T.v, 0.05, aniso) };
}

function roofFlat(rnd, aniso) {
  const T = TILE.flat;
  const ctx = tileCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#5a5b58';
  ctx.fillRect(0, 0, T.u, T.v);
  grain(ctx, rnd, T.u, T.v, 5000, 0.34, 0.14);                // ballast
  for (let y = 0; y < T.v; y += 2) {                          // membrane laps
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, y, T.u, 0.09);
  }
  // Plant, drawn with a flat top and a shaded side so it reads as a box from a
  // helicopter without costing a single triangle.
  for (let i = 0; i < 7; i++) {
    const w = 1.1 + rnd() * 2.4, d = 0.9 + rnd() * 1.8;
    const x = 0.6 + rnd() * (T.u - w - 1.2), y = 0.6 + rnd() * (T.v - d - 1.2);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(x + 0.18, y - 0.22, w, d);
    ctx.fillStyle = '#9aa0a2';
    ctx.fillRect(x, y, w, d);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(x, y, w, d * 0.28);
  }
  return texture(ctx, true, aniso);
}

function trimSkin(rnd, aniso) {
  const T = TILE.trim;
  const ctx = tileCtx(128, 128, T.u, T.v);
  ctx.fillStyle = '#e2e0da';
  ctx.fillRect(0, 0, T.u, T.v);
  grain(ctx, rnd, T.u, T.v, 1400, 0.20, 0.07);
  for (let y = 0; y < T.v; y += 1.2) {
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, y, T.u, 0.045);
  }
  return texture(ctx, true, aniso);
}

/** A panelled door. One wrap covers the whole leaf, whatever its size. */
function doorPanel(rnd, aniso) {
  const ctx = tileCtx(128, 128, 1, 1);
  ctx.fillStyle = '#e0ddd6';
  ctx.fillRect(0, 0, 1, 1);
  for (let i = 0; i < 4; i++) {
    const y = 0.06 + i * 0.235;
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(0.09, y, 0.82, 0.185);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(0.11, y + 0.02, 0.78, 0.145);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0.985, 1, 0.015);
  ctx.fillRect(0.86, 0.45, 0.05, 0.09);                       // handle
  grain(ctx, rnd, 1, 1, 240, 0.10, 0.02);
  // Raised and fielded: each panel sits back in its frame.
  const rel = reliefCtx(128, 128, 1, 1);
  for (let i = 0; i < 4; i++) {
    const y = 0.06 + i * 0.235;
    rel.fillStyle = G(100); rel.fillRect(0.09, y, 0.82, 0.185);
    rel.fillStyle = G(128); rel.fillRect(0.12, y + 0.03, 0.76, 0.125);
  }
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, 1, 1, 0.06, aniso) };
}

/** A roller shutter, for loading docks. */
function doorRoller(rnd, aniso) {
  const ctx = tileCtx(128, 128, 1, 1);
  ctx.fillStyle = '#b9bcbd';
  ctx.fillRect(0, 0, 1, 1);
  for (let y = 0; y < 1; y += 0.052) {
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillRect(0.04, y, 0.92, 0.018);
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.fillRect(0.04, y + 0.03, 0.92, 0.014);
  }
  ctx.fillStyle = '#6c7073';
  ctx.fillRect(0, 0, 0.045, 1);                               // guides
  ctx.fillRect(0.955, 0, 0.045, 1);
  ctx.fillRect(0.04, 0.955, 0.92, 0.045);                     // head box
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0.04, 0, 0.92, 0.03);
  grain(ctx, rnd, 1, 1, 300, 0.14, 0.02);
  const rel = reliefCtx(128, 128, 1, 1);
  for (let y = 0; y < 1; y += 0.052) {
    rel.fillStyle = G(150); rel.fillRect(0.04, y, 0.92, 0.026);
    rel.fillStyle = G(110); rel.fillRect(0.04, y + 0.03, 0.92, 0.014);
  }
  rel.fillStyle = G(170); rel.fillRect(0, 0, 0.045, 1); rel.fillRect(0.955, 0, 0.045, 1);
  return { map: texture(ctx, true, aniso), normal: normalMap(rel, 1, 1, 0.05, aniso) };
}

// ---------------------------------------------------------------------------
// Material patch
// ---------------------------------------------------------------------------

const VERT_DECL = /* glsl */`
attribute float faceAxis;
attribute vec4 aRepeat;
`;

// aRepeat holds whole-window counts: x across the local-X faces, y across the
// local-Z faces, z up the wall, w over a roof deck.
const VERT_UV = /* glsl */`
vec2 cityRepeat =
    faceAxis < 0.5 ? vec2( aRepeat.x, aRepeat.z )
  : faceAxis < 1.5 ? vec2( aRepeat.y, aRepeat.z )
  : faceAxis < 2.5 ? vec2( aRepeat.w, aRepeat.w )
  : vec2( 1.0 );
#ifdef USE_MAP
  vMapUv *= cityRepeat;
#endif
#ifdef USE_EMISSIVEMAP
  vEmissiveMapUv *= cityRepeat;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv *= cityRepeat;
#endif
`;

// Ground occlusion. The instance matrix's Y column is the building's height in
// metres, so this is the height of the vertex above the building's own base —
// which seatY() puts 0.35 m under the lowest corner of the ground.
const VERT_AO = /* glsl */`
#ifdef USE_INSTANCING
  vCityBase = ( position.y + 0.5 ) * length( instanceMatrix[ 1 ].xyz );
#else
  vCityBase = 10.0;
#endif
`;

// Applied to the diffuse colour, so light and shadow both see it: the foot of
// a wall is where the ground and the building shade each other, and where rain
// splashes it dark. 1.4 m of falloff, to about 60% at the ground.
const FRAG_AO = /* glsl */`
diffuseColor.rgb *= mix( 0.58, 1.0, smoothstep( 0.2, 1.6, vCityBase ) );
`;

const FRAG_WINDOWS = /* glsl */`
vec4 winTex = texture2D( emissiveMap, vEmissiveMapUv );
// r masks the glazing, g is this window's random key, b is how warm the lamp is.
// Dusk raises the threshold, so a building lights a few windows at a time and
// in its own order rather than switching on all at once.
float cityLit = winTex.r * step( winTex.g, vOccupancy * uNight );
totalEmissiveRadiance = uGlow * uEmScale * cityLit *
  mix( vec3( 0.62, 0.72, 1.00 ), vec3( 1.00, 0.72, 0.40 ), winTex.b );
`;

/**
 * Adds per-instance facade scaling, and — for materials with a window map —
 * the dusk threshold. `night` and `glow` are shared uniform objects, so the
 * whole city changes hour on two writes.
 */
function patchCity(material, windows, night, glow, emScale = 1, ao = false) {
  // The cache key has to carry the scale, or three reuses one compiled program
  // for every facade type and they all inherit whichever was compiled first.
  material.customProgramCacheKey = () => (windows ? 'city-win-' + emScale : 'city') + (ao ? '-ao' : '');
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL +
        (windows ? 'attribute float aOccupancy;\nvarying float vOccupancy;\n' : '') +
        (ao ? 'varying float vCityBase;\n' : ''))
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + VERT_UV +
        (windows ? 'vOccupancy = aOccupancy;\n' : '') + (ao ? VERT_AO : ''));
    if (ao) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCityBase;\n')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_AO);
    }

    if (!windows) return;
    shader.uniforms.uNight = night;
    shader.uniforms.uGlow = glow;
    shader.uniforms.uEmScale = { value: emScale };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vOccupancy;\nuniform float uNight;\nuniform float uGlow;\nuniform float uEmScale;\n')
      .replace('#include <emissivemap_fragment>', FRAG_WINDOWS);
  };
}

// ---------------------------------------------------------------------------
// Instance piles
// ---------------------------------------------------------------------------

/**
 * A growable staging buffer for one mesh's instances.
 *
 * Instances are collected here first because the count is not known until every
 * lot has been walked, and because the live GPU buffers hold only the instances
 * that survived culling — the pile is the full set they are compacted from.
 */
function makePile() {
  let cap = 64;
  const p = {
    n: 0,
    mat: new Float32Array(cap * 16),
    col: new Float32Array(cap * 3),
    rep: new Float32Array(cap * 4),
    occ: new Float32Array(cap),
    at: new Float32Array(cap * 2),     // owning building centre, for culling
    cull: new Float32Array(cap),
    everyStatic: true,
    push,
  };

  function grow() {
    cap *= 2;
    const g = (src, stride) => {
      const out = new Float32Array(cap * stride);
      out.set(src);
      return out;
    };
    p.mat = g(p.mat, 16); p.col = g(p.col, 3); p.rep = g(p.rep, 4);
    p.occ = g(p.occ, 1); p.at = g(p.at, 2); p.cull = g(p.cull, 1);
  }

  function push(m4, colour, rep, occ, ax, az, cullR) {
    if (p.n === cap) grow();
    const i = p.n++;
    m4.toArray(p.mat, i * 16);
    p.col[i * 3] = colour.r; p.col[i * 3 + 1] = colour.g; p.col[i * 3 + 2] = colour.b;
    p.rep[i * 4] = rep[0]; p.rep[i * 4 + 1] = rep[1];
    p.rep[i * 4 + 2] = rep[2]; p.rep[i * 4 + 3] = rep[3];
    p.occ[i] = occ;
    p.at[i * 2] = ax; p.at[i * 2 + 1] = az;
    p.cull[i] = cullR;
    if (cullR !== Infinity) p.everyStatic = false;
  }

  return p;
}

// ---------------------------------------------------------------------------

const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

export function createCity(world, ground, opts = {}) {
  const shells = buildShells();
  const group = new THREE.Group();
  group.name = 'city';

  const maxAniso = opts.maxAnisotropy ?? 8;
  let tier = QUALITY[opts.quality] ? opts.quality : 'high';
  let distanceScale = QUALITY[tier].distance;
  let aniso = Math.min(maxAniso, QUALITY[tier].anisotropy);

  const nightU = { value: 0 };
  const glowU = { value: 0 };
  let night = 0;
  let clock = 0;

  // ---- textures ----------------------------------------------------------
  const trnd = mulberry(world.seed ^ 0x51ce7);
  const textures = [];
  const keep = (t) => { textures.push(t); return t; };
  const keepPair = (p) => { keep(p.map); keep(p.normal); return p; };
  // Only paint what this world builds. The town families are a quarter of a
  // second of canvas work at load for a map that has no town.
  const lots = world.lots || [];
  const has = new Set(lots.map((l) => l.kind));
  const town = has.has('tower') || has.has('block');

  const towerMap = has.has('tower') ? [0, 1, 2].map((v) => keep(towerFacade(v, trnd, aniso))) : [null, null, null];
  const towerWin = has.has('tower') ? [0, 1, 2].map(() => keep(towerWindows(trnd, aniso))) : [null, null, null];
  const blockMap = town ? [0, 1, 2].map((v) => keep(blockFacade(v, trnd, aniso))) : [null, null, null];
  const blockWin = town ? [0, 1, 2].map(() => keep(blockWindows(trnd, aniso))) : [null, null, null];
  const shopMap = town ? [0, 1].map((v) => keep(shopFacade(v, trnd, aniso))) : [null, null];
  const shopWin = town ? [0, 1].map(() => keep(shopWindows(trnd, aniso))) : [null, null];
  const houseMap = [0, 1, 2, 3].map((v) => keepPair(houseWall(v, trnd, aniso)));
  const houseWin = [0, 1, 2, 3].map(() => keep(houseWindows(trnd, aniso)));
  const wareMap = [0, 1].map((v) => keepPair(wareWall(v, trnd, aniso)));
  const timberMap = keepPair(timberWall(trnd, aniso));
  const brickMap = keepPair(brickPlain(trnd, aniso));
  const gableMap = keepPair(gableSkin(trnd, aniso));
  const tilesMap = keepPair(roofTiles(trnd, aniso));
  const metalMap = keepPair(roofMetal(trnd, aniso));
  const flatMap = keep(roofFlat(trnd, aniso));
  const trimMap = keep(trimSkin(trnd, aniso));
  const panelMap = keepPair(doorPanel(trnd, aniso));
  const rollerMap = keepPair(doorRoller(trnd, aniso));
  const barnDoorMap = keepPair(barnDoor(trnd, aniso));

  // ---- materials ---------------------------------------------------------
  const materials = [];
  /**
   * `emScale` dims one facade type's night glow without touching the others.
   * Shopfronts need it: their emissive map is a near-continuous strip of
   * glazing rather than a grid of separate windows, so at the same glow as a
   * tower the whole ground floor of every mid-rise blows out into one solid
   * band of light. The patched shader computes totalEmissiveRadiance from
   * scratch, so the material's own emissive colour is not read at all.
   *
   * `tex` is a texture or a { map, normal } pair; `ao` darkens the foot of the
   * wall, and belongs on walls only — a roof has no foot.
   */
  function facade(tex, win, shininess, specular, emScale = 1, ao = false) {
    const pair = tex && tex.map ? tex : { map: tex, normal: null };
    const m = new THREE.MeshPhongMaterial({
      map: pair.map,
      normalMap: pair.normal || null,
      emissiveMap: win || null,
      emissive: win ? 0xffffff : 0x000000,
      specular,
      shininess,
      fog: true,
    });
    patchCity(m, !!win, nightU, glowU, emScale, ao);
    materials.push(m);
    return m;
  }

  // Phong rather than Standard: with no environment map a metallic workflow
  // renders glass black, and a specular highlight is exactly what sells a
  // curtain wall in daylight. It is also markedly cheaper per pixel.
  const matTower = [0, 1, 2].map((v) => facade(towerMap[v], towerWin[v], 74, 0x525a63, 1, true));
  const matBlock = [0, 1, 2].map((v) => facade(blockMap[v], blockWin[v], 9, 0x14140f, 1, true));
  const matShop = [0, 1].map((v) => facade(shopMap[v], shopWin[v], 46, 0x3a3f44, 0.30, true));
  const matHouse = [0, 1, 2, 3].map((v) => facade(houseMap[v], houseWin[v], v === 0 ? 10 : 6, 0x151513, 1, true));
  const matWare = [0, 1].map((v) => facade(wareMap[v], null, 34, 0x3a3d40, 1, true));
  const matTimber = facade(timberMap, null, 5, 0x0c0c0a, 1, true);
  const matBrick = facade(brickMap, null, 5, 0x0e0c0a, 1, false);
  const matGable = facade(gableMap, null, 6, 0x101010);
  const matTimberGable = facade(timberMap, null, 5, 0x0c0c0a);
  const matTiles = facade(tilesMap, null, 7, 0x16140f);
  const matMetal = facade(metalMap, null, 36, 0x3c3f42);
  const matFlat = facade(flatMap, null, 4, 0x0c0c0c);
  const matTrim = facade(trimMap, null, 6, 0x121212);
  const matPanel = facade(panelMap, null, 22, 0x24242a);
  const matRoller = facade(rollerMap, null, 24, 0x2a2d30);
  const matBarnDoor = facade(barnDoorMap, null, 5, 0x0c0c0a);

  const matBeacon = new THREE.MeshBasicMaterial({ color: 0x2a0604, fog: true });
  materials.push(matBeacon);

  // ---- piles -------------------------------------------------------------
  const pTower = [makePile(), makePile(), makePile()];
  const pBlock = [makePile(), makePile(), makePile()];
  const pShop = [makePile(), makePile()];
  const pHouse = [makePile(), makePile(), makePile(), makePile()];
  const pWare = [makePile(), makePile()];
  const pTimber = makePile();
  const pBrick = makePile();
  const pGable = makePile();
  const pTimberGable = makePile();
  const pWareGable = [makePile(), makePile()];
  const pTiles = makePile();
  const pHipTiles = makePile();
  const pMetal = makePile();
  const pFlat = makePile();
  const pTrim = makePile();
  const pTrimCap = makePile();
  const pPanel = makePile();
  const pRoller = makePile();
  const pBarnDoor = makePile();
  const pBeacon = makePile();

  // ---- placement scratch --------------------------------------------------
  const UP = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);
  const _base = new THREE.Matrix4();
  const _local = new THREE.Matrix4();
  const _world = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _rot = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _colour = new THREE.Color();
  const _rep = new Float32Array(4);

  let lotX = 0, lotZ = 0;

  const rep4 = (u, s, v, c) => {
    _rep[0] = u; _rep[1] = s; _rep[2] = v; _rep[3] = c;
    return _rep;
  };

  /** Places one instance in the current lot's frame: metres, then extra yaw. */
  function put(pile, lx, ly, lz, ry, sx, sy, sz, tint, rep, occ, cullR) {
    _local.compose(_pos.set(lx, ly, lz), _rot.setFromAxisAngle(UP, ry), _scale.set(sx, sy, sz));
    _world.multiplyMatrices(_base, _local);
    pile.push(_world, _colour.setHex(tint), rep, occ, lotX, lotZ, cullR);
  }

  /**
   * The height the building sits at.
   *
   * A 40 m footprint on the city's tilted shelf leaves one corner metres in the
   * air if it is seated on its centre, so the base drops to the lowest corner
   * and the walls start below grade. Nobody sees the buried part; everybody
   * sees a floating one.
   */
  function seatY(lot) {
    const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
    let lo = ground.heightAt(lot.x, lot.z);
    for (const [ox, oz] of CORNERS) {
      const dx = ox * lot.w, dz = oz * lot.d;
      const y = ground.heightAt(lot.x + dx * c - dz * s, lot.z + dx * s + dz * c);
      if (y < lo) lo = y;
    }
    return lo - 0.35;
  }

  /**
   * Which side of the lot faces a street.
   *
   * layout.js knows — it walks each block's perimeter — but does not record it,
   * and a porch on the courtyard side looks wrong from every angle. Asking the
   * ground for the nearest road recovers it exactly, once, at load.
   * Returns 0 = +X, 1 = -X, 2 = +Z, 3 = -Z in the lot's own frame.
   */
  function frontFace(lot) {
    const road = ground.nearestRoad(lot.x, lot.z, 60);
    let fx = road ? road.x - lot.x : lot.x;
    let fz = road ? road.z - lot.z : lot.z;
    if (fx === 0 && fz === 0) fz = 1;
    const c = Math.cos(lot.rot), s = Math.sin(lot.rot);
    const lx = fx * c + fz * s;
    const lz = -fx * s + fz * c;
    if (Math.abs(lx) >= Math.abs(lz)) return lx >= 0 ? 0 : 1;
    return lz >= 0 ? 2 : 3;
  }

  // ---- families ----------------------------------------------------------

  function emitTower(lot, rnd, occ) {
    const v = (rnd() * 3) | 0;
    const tint = GLASS_TINT[(rnd() * GLASS_TINT.length) | 0];
    const trim = TRIM_TINT[(rnd() * TRIM_TINT.length) | 0];
    const T = TILE.tower;
    const h = Math.max(20, lot.height);
    const stages = h > 130 ? 4 : h > 74 ? 3 : 2;

    let y = 0, w = lot.w, d = lot.d, left = h;
    for (let s = 0; s < stages; s++) {
      const sh = s === stages - 1 ? left : left * (0.36 + rnd() * 0.22);
      put(pTower[v], 0, y + sh / 2, 0, 0, w, sh, d, tint,
        rep4(reps(w, T.u), reps(d, T.u), reps(sh, T.v), 1), occ, CULL.tower);
      put(pFlat, 0, y + sh, 0, 0, w, 1, d, 0xffffff,
        rep4(1, 1, 1, reps(Math.min(w, d), TILE.flat.u)), 0, CULL.tower);
      // A slab edge at every setback. Without it the stages read as separate
      // boxes that happen to be stacked.
      put(pTrim, 0, y + sh - 0.3, 0, 0, w + 0.7, 0.75, d + 0.7, trim,
        rep4(reps(w, TILE.trim.u), reps(d, TILE.trim.u), 1, 1), 0, CULL.tower);
      y += sh;
      left -= sh;
      const shrink = 0.78 + rnd() * 0.13;
      w *= shrink;
      d *= shrink;
    }

    // Crown: a mechanical penthouse and a mast, which is what actually gives a
    // tower a recognisable top from three kilometres away.
    const ch = 3.5 + rnd() * 5;
    put(pTrim, 0, y + ch / 2, 0, 0, w * 0.62, ch, d * 0.62, trim,
      rep4(reps(w * 0.62, TILE.trim.u), reps(d * 0.62, TILE.trim.u), 1, 1), 0, CULL.tower);
    put(pTrimCap, 0, y + ch, 0, 0, w * 0.62, 1, d * 0.62, trim,
      rep4(1, 1, 1, reps(Math.min(w, d) * 0.62, TILE.trim.u)), 0, CULL.tower);

    const mast = 5 + rnd() * 12;
    put(pTrim, 0, y + ch + mast / 2, 0, 0, 0.5, mast, 0.5, 0xb0aeaa, rep4(1, 1, 1, 1), 0, CULL.tower);
    put(pBeacon, 0, y + ch + mast + 0.4, 0, 0, 0.85, 0.85, 0.85, 0xffffff, rep4(1, 1, 1, 1), 0, CULL.tower);
  }

  function emitBlock(lot, rnd, occ) {
    const v = (rnd() * 3) | 0;
    const sv = (rnd() * 2) | 0;
    const tint = MASONRY_TINT[(rnd() * MASONRY_TINT.length) | 0];
    const trim = TRIM_TINT[(rnd() * TRIM_TINT.length) | 0];
    const T = TILE.block, w = lot.w, d = lot.d;
    const h = Math.max(9, lot.height);
    const shopH = Math.min(4.4, h * 0.34);
    const wallH = h - shopH;

    // Shopfronts wrap all four sides. On a perimeter block three of them face a
    // street and the fourth faces a courtyard; from a car the difference never
    // shows, and it saves splitting the shell into per-face groups.
    put(pShop[sv], 0, shopH / 2, 0, 0, w, shopH, d, 0xffffff,
      rep4(reps(w, TILE.shop.u), reps(d, TILE.shop.u), 1, 1), 0.95, CULL.block);
    put(pBlock[v], 0, shopH + wallH / 2, 0, 0, w, wallH, d, tint,
      rep4(reps(w, T.u), reps(d, T.u), reps(wallH, T.v), 1), occ, CULL.block);

    // Cornice: a hollow band projecting 0.4 m past the wall, which is what
    // reads as a parapet from a car.
    put(pTrim, 0, h - 0.1, 0, 0, w + 0.8, 0.9, d + 0.8, trim,
      rep4(reps(w, TILE.trim.u), reps(d, TILE.trim.u), 1, 1), 0, CULL.block);
    // The roof deck closes the top of that band. It has to BE the top: `cap` is
    // a full quad, not a ring, so the trim lid that used to sit at h + 0.35
    // buried the ballast deck 0.55 m underneath it — every midtown roof read as
    // a blank pale slab and 149 flat-roof instances drew for nothing.
    put(pFlat, 0, h + 0.35, 0, 0, w + 0.8, 1, d + 0.8, 0xffffff,
      rep4(1, 1, 1, reps(Math.min(w, d), TILE.flat.u)), 0, CULL.block);
  }

  /**
   * Where the street side of a lot is, as the helpers every family uses to put
   * things on it: `at(along, away)` is a point `away` metres in front of the
   * front wall, `along` metres across it; `boxScale` orients a footprint.
   */
  function frontal(lot) {
    const w = lot.w, d = lot.d;
    const face = frontFace(lot);
    const ox = face === 0 ? 1 : face === 1 ? -1 : 0;
    const oz = face === 2 ? 1 : face === 3 ? -1 : 0;
    const yaw = face === 0 ? Math.PI / 2 : face === 1 ? -Math.PI / 2 : face === 2 ? 0 : Math.PI;
    const sideways = ox !== 0;
    const out = sideways ? w / 2 : d / 2;      // centre to the front wall
    const front = sideways ? d : w;            // frontage width
    const at = (along, away) => [ox * (out + away) + (sideways ? 0 : along),
      oz * (out + away) + (sideways ? along : 0)];
    const boxScale = (across, deep) => (sideways ? [deep, across] : [across, deep]);
    return { face, ox, oz, yaw, sideways, out, front, at, boxScale };
  }

  /**
   * A pitched roof over a w x d footprint: gable or hip, with a fascia board
   * along every eave. The ridge runs along the longer side.
   */
  function pitchedRoof(w, d, wallH, roofH, over, hip, pile, gablePile, roofCol, gableCol, fascia, cull) {
    const alongX = w >= d;
    const ridge = (alongX ? w : d) + over * 2;
    const span = (alongX ? d : w) + over * 2;
    const ry = alongX ? 0 : Math.PI / 2;
    const slope = Math.hypot(span / 2, roofH);
    if (hip) {
      put(pHipTiles, 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, roofCol,
        rep4(reps(ridge, TILE.tiles.u), reps(span, TILE.tiles.u), reps(slope, TILE.tiles.v), 1), 0, cull);
    } else {
      put(pile, 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, roofCol,
        rep4(reps(ridge, TILE.tiles.u), 1, reps(slope, TILE.tiles.v), 1), 0, cull);
      if (gablePile) {
        // The gable sits in the plane of the end wall, under the overhang, and
        // is as wide as the roof so its edges meet the roof's underside.
        put(gablePile, 0, wallH + roofH / 2, 0, ry, ridge - over * 2 + 0.02, roofH, span, gableCol,
          rep4(1, reps(span, TILE.gable.u), reps(roofH, TILE.gable.v), 1), 0, cull);
      }
    }
    if (fascia) {
      // The fascia board is the dark line that separates roof from wall at a
      // distance; without it the roof reads as a hat sitting on a box.
      const ey = wallH - 0.08;
      const lx = alongX ? 0 : span / 2 - 0.03, lz = alongX ? span / 2 - 0.03 : 0;
      const sx = alongX ? ridge : 0.06, sz = alongX ? 0.06 : ridge;
      put(pTrim, lx, ey, lz, 0, sx, 0.24, sz, fascia, rep4(1, 1, 1, 1), 0, CULL.detail * 2);
      put(pTrim, -lx, ey, -lz, 0, sx, 0.24, sz, fascia, rep4(1, 1, 1, 1), 0, CULL.detail * 2);
      if (hip) {
        const hx = alongX ? ridge / 2 - 0.03 : 0, hz = alongX ? 0 : ridge / 2 - 0.03;
        const hsx = alongX ? 0.06 : span, hsz = alongX ? span : 0.06;
        put(pTrim, hx, ey, hz, 0, hsx, 0.24, hsz, fascia, rep4(1, 1, 1, 1), 0, CULL.detail * 2);
        put(pTrim, -hx, ey, -hz, 0, hsx, 0.24, hsz, fascia, rep4(1, 1, 1, 1), 0, CULL.detail * 2);
      }
    }
    return { alongX, ridge, span };
  }

  // Pitches, in degrees, by what the roof is made of.
  const TAN = (deg) => Math.tan(deg * Math.PI / 180);

  function emitHouse(lot, rnd, occ) {
    if (lot.height < 4.5) { emitShed(lot, rnd); return; }
    // Board and render are the commonest; brick and stone the old farmhouses.
    const pickV = rnd();
    const v = pickV < 0.30 ? 0 : pickV < 0.58 ? 1 : pickV < 0.82 ? 2 : 3;
    const masonry = v >= 2;
    const paint = masonry ? STONE_TINT[(rnd() * STONE_TINT.length) | 0] : HOUSE_PAINT[(rnd() * HOUSE_PAINT.length) | 0];
    const roofCol = ROOF_PAINT[(rnd() * ROOF_PAINT.length) | 0];
    const trim = TRIM_TINT[(rnd() * TRIM_TINT.length) | 0];
    const T = TILE.house, w = lot.w, d = lot.d;

    // Whole storeys, so the windows are the height windows are: the facade
    // tile is two floors of 2.9 m, and a bungalow shows the lower half of it.
    const storeys = lot.height >= 6.4 ? 2 : 1;
    const wallH = storeys * 2.9 + 0.12;
    const span = Math.min(w, d);
    const roofH = clamp((span / 2 + 0.45) * TAN(33 + rnd() * 12), 1.8, 4.6);
    const hip = masonry ? rnd() < 0.7 : rnd() < 0.3;

    put(pHouse[v], 0, wallH / 2, 0, 0, w, wallH, d, paint,
      rep4(reps(w, T.u), reps(d, T.u), storeys * 0.5, 1), occ, CULL.house);

    const roof = pitchedRoof(w, d, wallH, roofH, 0.45, hip, pTiles, pGable, roofCol, paint, 0x4a4642, CULL.house);

    // A chimney on most of them, on the ridge near one end: nothing says
    // "house" from half a mile away like a chimney.
    if (rnd() < 0.75) {
      const along = (hip ? roof.ridge * 0.16 : roof.ridge / 2 - 1.4) * (rnd() < 0.5 ? -1 : 1);
      const top = wallH + roofH + 0.9 + rnd() * 0.5;
      const cx = roof.alongX ? along : 0, cz = roof.alongX ? 0 : along;
      const cw = 0.55 + rnd() * 0.25;
      put(pBrick, cx, (wallH + top) / 2, cz, 0, cw, top - wallH, cw * 1.3, STONE_TINT[(rnd() * 4) | 0],
        rep4(1, 1, reps(top - wallH, TILE.brick.v), 1), 0, CULL.house);
      put(pTrimCap, cx, top + 0.05, cz, 0, cw + 0.12, 1, cw * 1.3 + 0.12, 0x6c6862,
        rep4(1, 1, 1, 1), 0, CULL.house);
    }

    // Front-garden clutter, all of it on the street side.
    const F = frontal(lot);
    const garage = F.front > 10.5 && rnd() < 0.55;
    if (garage) {
      // Half-buried in the house, so it only projects as far as the front
      // garden and never over the kerb.
      const gw = 3.5, gd = 4.8, gh = 2.65;
      const along = (F.front / 2 - gw / 2 - 0.5) * (rnd() < 0.5 ? -1 : 1);
      const [gx, gz] = F.at(along, gd * 0.22);
      const [sx, sz] = F.boxScale(gw, gd);
      put(pHouse[v], gx, gh / 2, gz, 0, sx, gh, sz, paint,
        rep4(reps(sx, T.u), reps(sz, T.u), 0.45, 1), 0, CULL.house);
      put(pTrimCap, gx, gh, gz, 0, sx + 0.35, 1, sz + 0.35, trim,
        rep4(1, 1, 1, 1), 0, CULL.house);
      const [dx, dz] = F.at(along, gd * 0.72 + 0.03);
      put(pRoller, dx, (gh - 0.3) / 2, dz, F.yaw, gw - 0.5, gh - 0.3, 1, 0xdcdcd6,
        rep4(1, 1, 1, 1), 0, CULL.detail);
    }

    const porchY = Math.min(wallH - 0.4, 2.55);
    const [px, pz] = F.at(0, 0.85);
    const [psx, psz] = F.boxScale(2.5, 1.7);
    put(pTrim, px, porchY, pz, 0, psx, 0.22, psz, trim, rep4(1, 1, 1, 1), 0, CULL.detail);
    for (const side of [-1, 1]) {
      const [cx, cz] = F.at(side * 1.05, 1.5);
      put(pTrim, cx, porchY / 2, cz, 0, 0.16, porchY, 0.16, trim, rep4(1, 1, 1, 1), 0, CULL.detail);
    }
    // A front step, so the door does not open onto grass. The base of every
    // building is 0.35 m under the ground (seatY), so the step's top is 0.15 m
    // above it and the door stands on the step.
    const [stx, stz] = F.at(0, 0.45);
    const [ssx, ssz] = F.boxScale(1.6, 0.9);
    put(pTrim, stx, 0.25, stz, 0, ssx, 0.5, ssz, 0xb8b4ac, rep4(1, 1, 1, 1), 0, CULL.detail);
    const [fx, fz] = F.at(0, 0.04);
    put(pPanel, fx, 0.5 + 1.05, fz, F.yaw, 1.0, 2.1, 1, DOOR_TINT[(rnd() * DOOR_TINT.length) | 0],
      rep4(1, 1, 1, 1), 0, CULL.detail);

    // Garden wall only where there is no garage: the two occupy the same strip
    // of front garden, and a wall crossing a garage door looks like a mistake.
    if (!garage && rnd() < 0.7) {
      const [wx, wz] = F.at(0, 3.4);
      const [wsx, wsz] = F.boxScale(F.front + 1.6, 0.3);
      put(masonry ? pBrick : pTrim, wx, 0.36, wz, 0, wsx, 0.72, wsz, masonry ? STONE_TINT[1] : trim,
        rep4(reps(wsx, masonry ? TILE.brick.u : TILE.trim.u), reps(wsz, masonry ? TILE.brick.u : TILE.trim.u), masonry ? 0.36 : 1, 1),
        0, CULL.detail);
    }
  }

  /** A shed: stained board, one door, no windows, dark at night. */
  function emitShed(lot, rnd) {
    const w = lot.w, d = lot.d;
    const tint = TIMBER_TINT[(rnd() * TIMBER_TINT.length) | 0];
    const metalRoof = rnd() < 0.6;
    const roofCol = metalRoof ? WARE_PAINT[(rnd() * WARE_PAINT.length) | 0] : ROOF_PAINT[(rnd() * ROOF_PAINT.length) | 0];
    const span = Math.min(w, d);
    const roofH = clamp((span / 2 + 0.3) * TAN(22 + rnd() * 12), 0.9, 2.4);
    const wallH = Math.max(2.3, lot.height - roofH);
    const T = TILE.timber;
    put(pTimber, 0, wallH / 2, 0, 0, w, wallH, d, tint,
      rep4(reps(w, T.u), reps(d, T.u), wallH / T.v, 1), 0, CULL.house);
    pitchedRoof(w, d, wallH, roofH, 0.3, false, metalRoof ? pMetal : pTiles, pTimberGable, roofCol, tint, 0, CULL.house);
    const F = frontal(lot);
    const [dx, dz] = F.at((rnd() - 0.5) * Math.max(0, F.front - 3), 0.04);
    put(pBarnDoor, dx, 1.1 + 0.35, dz, F.yaw, 1.7, 2.2, 1, tint, rep4(1, 1, 1, 1), 0, CULL.detail * 1.5);
  }

  function emitWarehouse(lot, rnd) {
    const w = lot.w, d = lot.d;
    const big = Math.max(w, d) > 34 || lot.height > 12.5;
    if (lot.district === 'garage' || big || rnd() < 0.35) emitSteelShed(lot, rnd);
    else emitBarn(lot, rnd);
  }

  /**
   * A barn: stained board-and-batten, a steep steel roof, big sliding doors on
   * one gable end and a hay-loft door above them.
   */
  function emitBarn(lot, rnd) {
    const w = lot.w, d = lot.d;
    const tint = TIMBER_TINT[(rnd() * 4) | 0];               // the reds and blacks
    const roofCol = [0x5a5e62, 0x6e3a30, 0x4c5a4a, 0x7c8084][(rnd() * 4) | 0];
    const span = Math.min(w, d);
    const roofH = clamp((span / 2 + 0.4) * TAN(24 + rnd() * 8), 2.2, 6.5);
    const wallH = Math.max(3.8, lot.height - roofH * 0.6);
    const T = TILE.timber;
    put(pTimber, 0, wallH / 2, 0, 0, w, wallH, d, tint,
      rep4(reps(w, T.u), reps(d, T.u), wallH / T.v, 1), 0, CULL.ware);
    const roof = pitchedRoof(w, d, wallH, roofH, 0.4, false, pMetal, pTimberGable, roofCol, tint, 0, CULL.ware);

    // Doors on the gable end nearer the road. The gable ends are the short
    // walls, across the ridge.
    const F = frontal(lot);
    const endSign = roof.alongX ? (F.ox !== 0 ? F.ox : (rnd() < 0.5 ? 1 : -1))
      : (F.oz !== 0 ? F.oz : (rnd() < 0.5 ? 1 : -1));
    const half = (roof.alongX ? w : d) / 2 + 0.05;
    const yaw = roof.alongX ? (endSign > 0 ? Math.PI / 2 : -Math.PI / 2) : (endSign > 0 ? 0 : Math.PI);
    const dw = Math.min(span - 1.2, 5.2), dh = Math.min(wallH - 0.4, 4.4);
    for (const s of [-1, 1]) {
      const off = s * dw / 4;
      const x = roof.alongX ? endSign * half : off, z = roof.alongX ? off : endSign * half;
      put(pBarnDoor, x, dh / 2 + 0.35, z, yaw, dw / 2 - 0.05, dh, 1, tint, rep4(1, 1, 1, 1), 0, CULL.dock);
    }
    if (roofH > 2.6) {
      const ly = wallH + Math.min(roofH * 0.35, 1.6);
      const x = roof.alongX ? endSign * (half + 0.01) : 0, z = roof.alongX ? 0 : endSign * (half + 0.01);
      put(pBarnDoor, x, ly + 0.35, z, yaw, 1.4, 1.5, 1, tint, rep4(1, 1, 1, 1), 0, CULL.dock);
    }
    // Ridge vents.
    const vents = clamp(Math.round(roof.ridge / 12), 1, 3);
    for (let i = 0; i < vents; i++) {
      const along = (i - (vents - 1) / 2) * (roof.ridge / (vents + 0.6));
      put(pTrim, roof.alongX ? along : 0, wallH + roofH + 0.35, roof.alongX ? 0 : along, 0, 1.1, 0.7, 1.1, 0x8c8e8e,
        rep4(1, 1, 1, 1), 0, CULL.dock);
    }
  }

  /** Portal-frame steel: profiled sheeting, a shallow roof, roller doors. */
  function emitSteelShed(lot, rnd) {
    const v = (rnd() * 2) | 0;
    const tint = WARE_PAINT[(rnd() * WARE_PAINT.length) | 0];
    const T = TILE.ware, w = lot.w, d = lot.d;
    const h = Math.max(7, lot.height);
    const span = Math.min(w, d);
    const roofH = clamp((span / 2 + 0.35) * TAN(10 + rnd() * 5), 1.0, 3.2);
    const wallH = h - roofH;

    put(pWare[v], 0, wallH / 2, 0, 0, w, wallH, d, tint,
      rep4(reps(w, T.u), reps(d, T.u), reps(wallH, T.v), 1), 0, CULL.ware);

    const alongX = w >= d;
    const ridge = (alongX ? w : d) + 0.7;
    const spanO = (alongX ? d : w) + 0.7;
    const ry = alongX ? 0 : Math.PI / 2;
    const slope = Math.hypot(spanO / 2, roofH);
    put(pMetal, 0, wallH + roofH / 2, 0, ry, ridge, roofH, spanO, tint,
      rep4(reps(ridge, TILE.metal.u), 1, reps(slope, TILE.metal.v), 1), 0, CULL.ware);
    put(pWareGable[v], 0, wallH + roofH / 2, 0, ry, ridge - 0.68, roofH, spanO - 0.68, tint,
      rep4(1, reps(spanO, T.u), 1, 1), 0, CULL.ware);

    // Loading docks along the street side.
    const F = frontal(lot);
    const doors = clamp(Math.floor(F.front / 13), 1, 4);
    const dh = Math.min(4.6, wallH - 0.9);
    for (let i = 0; i < doors; i++) {
      const along = (i - (doors - 1) / 2) * (F.front / (doors + 0.35));
      const [dx, dz] = F.at(along, 0.05);
      put(pRoller, dx, dh / 2 + 0.35, dz, F.yaw, 4.2, dh, 1, 0xd2d4d4, rep4(1, 1, 1, 1), 0, CULL.dock);
    }

    // Ridge vents.
    const vents = clamp(Math.round(ridge / 10), 2, 6);
    for (let i = 0; i < vents; i++) {
      const along = (i - (vents - 1) / 2) * (ridge / (vents + 0.4));
      const vx = alongX ? along : 0;
      const vz = alongX ? 0 : along;
      put(pTrim, vx, wallH + roofH + 0.45, vz, 0, 1.3, 0.9, 1.3, 0xc4c6c6,
        rep4(1, 1, 1, 1), 0, CULL.dock);
    }
  }

  // ---- walk the lots -----------------------------------------------------
  const counts = { tower: 0, block: 0, house: 0, warehouse: 0 };

  for (const lot of lots) {
    const rnd = mulberry(lot.seed | 0);
    lotX = lot.x;
    lotZ = lot.z;
    // See the header: layout's local frame and three's +Y rotation run opposite
    // ways round in the XZ plane, so the yaw is negated here.
    _base.compose(_pos.set(lot.x, seatY(lot), lot.z), _rot.setFromAxisAngle(UP, -lot.rot), ONE);

    // How much of this building is still awake at midnight.
    const occ = lot.kind === 'tower' ? 0.16 + rnd() * 0.4
      : lot.kind === 'block' ? 0.22 + rnd() * 0.45
        : 0.3 + rnd() * 0.45;

    if (lot.kind === 'tower') { emitTower(lot, rnd, occ); counts.tower++; }
    else if (lot.kind === 'warehouse') { emitWarehouse(lot, rnd); counts.warehouse++; }
    else if (lot.kind === 'house') { emitHouse(lot, rnd, occ); counts.house++; }
    else { emitBlock(lot, rnd, occ); counts.block++; }
  }

  // ---- meshes ------------------------------------------------------------
  const records = [];

  /**
   * One InstancedMesh per (shell, material). The shell is cloned so each mesh
   * owns the instanced attributes; the clone is a handful of vertices, so this
   * costs nothing worth measuring.
   */
  function mount(shellGeo, material, pile, name, bulk) {
    if (pile.n === 0) return;
    const n = pile.n;
    const geo = shellGeo.clone();
    const mesh = new THREE.InstancedMesh(geo, material, n);
    mesh.name = name;
    // The city spans the whole map, so three's single bounding sphere could
    // never reject it — the per-instance pass below is the real cull.
    mesh.frustumCulled = false;
    mesh.castShadow = QUALITY[tier].shadows && bulk;
    mesh.matrixAutoUpdate = false;

    const rep = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const occ = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aRepeat', rep);
    geo.setAttribute('aOccupancy', occ);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);

    mesh.instanceMatrix.array.set(pile.mat.subarray(0, n * 16));
    mesh.instanceColor.array.set(pile.col.subarray(0, n * 3));
    rep.array.set(pile.rep.subarray(0, n * 4));
    occ.array.set(pile.occ.subarray(0, n));

    if (!pile.everyStatic) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      rep.setUsage(THREE.DynamicDrawUsage);
      occ.setUsage(THREE.DynamicDrawUsage);
    }

    group.add(mesh);
    records.push({
      mesh, pile, rep, occ, bulk,
      still: pile.everyStatic, live: n, lastX: Infinity, lastZ: Infinity, dirty: true,
    });
  }

  for (let v = 0; v < 3; v++) mount(shells.sides, matTower[v], pTower[v], `tower${v}`, true);
  for (let v = 0; v < 3; v++) mount(shells.sides, matBlock[v], pBlock[v], `block${v}`, true);
  for (let v = 0; v < 2; v++) mount(shells.sides, matShop[v], pShop[v], `shop${v}`, false);
  for (let v = 0; v < 4; v++) mount(shells.sides, matHouse[v], pHouse[v], `house${v}`, true);
  for (let v = 0; v < 2; v++) mount(shells.sides, matWare[v], pWare[v], `warehouse${v}`, true);
  for (let v = 0; v < 2; v++) mount(shells.ends, matWare[v], pWareGable[v], `waregable${v}`, true);
  mount(shells.sides, matTimber, pTimber, 'timber', true);
  mount(shells.ends, matTimberGable, pTimberGable, 'timbergable', true);
  mount(shells.sides, matBrick, pBrick, 'brick', true);
  mount(shells.ends, matGable, pGable, 'gable', false);
  mount(shells.slopes, matTiles, pTiles, 'tileroof', true);
  mount(shells.hips, matTiles, pHipTiles, 'hiproof', true);
  mount(shells.slopes, matMetal, pMetal, 'metalroof', true);
  mount(shells.panel, matBarnDoor, pBarnDoor, 'barndoors', false);
  mount(shells.cap, matFlat, pFlat, 'flatroof', false);
  mount(shells.sides, matTrim, pTrim, 'trim', false);
  mount(shells.cap, matTrim, pTrimCap, 'trimcap', false);
  mount(shells.panel, matPanel, pPanel, 'doors', false);
  mount(shells.panel, matRoller, pRoller, 'rollerdoors', false);
  mount(shells.sides, matBeacon, pBeacon, 'beacons', false);

  let instances = 0;
  for (const rec of records) instances += rec.pile.n;

  // ---- culling -----------------------------------------------------------

  /**
   * Rewrites one mesh's live buffers with only the instances still in range.
   *
   * Instances carry their own radius, so a house's porch drops out at 300 m
   * while the house itself survives to 1100 m and a downtown tower never drops
   * out at all. Everything is copied element by element on purpose: a subarray
   * view per instance would allocate thousands of objects a second and hand the
   * garbage collector the frame budget.
   */
  function compact(rec, cx, cz) {
    const p = rec.pile, n = p.n;
    const mat = rec.mesh.instanceMatrix.array;
    const col = rec.mesh.instanceColor.array;
    const rep = rec.rep.array;
    const occ = rec.occ.array;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const dx = p.at[i * 2] - cx, dz = p.at[i * 2 + 1] - cz;
      const r = p.cull[i] * distanceScale;
      if (dx * dx + dz * dz > r * r) continue;
      const s = i * 16, t = k * 16;
      for (let q = 0; q < 16; q++) mat[t + q] = p.mat[s + q];
      col[k * 3] = p.col[i * 3];
      col[k * 3 + 1] = p.col[i * 3 + 1];
      col[k * 3 + 2] = p.col[i * 3 + 2];
      rep[k * 4] = p.rep[i * 4];
      rep[k * 4 + 1] = p.rep[i * 4 + 1];
      rep[k * 4 + 2] = p.rep[i * 4 + 2];
      rep[k * 4 + 3] = p.rep[i * 4 + 3];
      occ[k] = p.occ[i];
      k++;
    }
    rec.lastX = cx;
    rec.lastZ = cz;
    rec.dirty = false;
    // Nothing entered or left, and the order is unchanged, so the buffers on the
    // GPU already say this. Skipping the upload is most frames out in open
    // country, where every mesh is either wholly in range or wholly out.
    if (k === n && rec.live === n) return;
    rec.live = k;
    rec.mesh.count = k;
    rec.mesh.instanceMatrix.needsUpdate = true;
    rec.mesh.instanceColor.needsUpdate = true;
    rec.rep.needsUpdate = true;
    rec.occ.needsUpdate = true;
  }

  let cursor = 0;

  /**
   * At most one mesh is re-culled per frame. A full sweep therefore takes about
   * twenty frames, during which a car at motorway speed covers under 20 m — far
   * inside the nearest cull radius, so nothing pops in late — while the cost
   * stays a few tens of microseconds instead of a millisecond spike.
   */
  function update(cameraPos, dt) {
    clock += dt;
    if (pBeacon.n > 0) {
      const pulse = 0.72 + 0.28 * Math.sin(clock * 2.1);
      const level = glowU.value * pulse;
      matBeacon.color.setRGB(0.10 + level * 0.9, 0.012 + level * 0.10, 0.010 + level * 0.07);
    }
    if (!cameraPos || records.length === 0) return;

    for (let tries = 0; tries < records.length; tries++) {
      const rec = records[cursor];
      cursor = cursor + 1 === records.length ? 0 : cursor + 1;
      if (rec.still) continue;
      const dx = cameraPos.x - rec.lastX, dz = cameraPos.z - rec.lastZ;
      if (!rec.dirty && dx * dx + dz * dz < REFRESH_MOVE * REFRESH_MOVE) continue;
      compact(rec, cameraPos.x, cameraPos.z);
      return;
    }
  }

  /** 0 = full day, 1 = full night. */
  function setNight(t) {
    night = clamp(t, 0, 1);
    nightU.value = night;
    // Squared, so the first hint of dusk does not switch on half the city.
    glowU.value = 1.25 * night * night;
  }

  function setQuality(q) {
    const next = QUALITY[q] ? q : tier;
    const spec = QUALITY[next];
    tier = next;
    distanceScale = spec.distance;

    const wantAniso = Math.min(maxAniso, spec.anisotropy);
    if (wantAniso !== aniso) {
      aniso = wantAniso;
      // Anisotropy is a sampler parameter, and three only re-applies it on
      // upload — so this re-reads every canvas. That is fine for a settings
      // change and unacceptable per frame, which is why nothing else calls it.
      for (const t of textures) { t.anisotropy = aniso; t.needsUpdate = true; }
    }
    for (const rec of records) {
      rec.mesh.castShadow = spec.shadows && rec.bulk;
      rec.dirty = true;
    }
    return tier;
  }

  function dispose() {
    for (const rec of records) {
      rec.mesh.geometry.dispose();
      rec.mesh.dispose();
    }
    for (const s of Object.values(shells)) s.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    group.clear();
    records.length = 0;
  }

  setNight(0);

  return {
    group,
    update,
    setNight,
    setQuality,
    dispose,
    stats: {
      buildings: lots.length,
      byFamily: counts,
      instances,
      drawCalls: records.length,
      textures: textures.length,
    },
    get night() { return night; },
    get quality() { return tier; },
  };
}
