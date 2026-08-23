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
  medium: { distance: 0.80, anisotropy: 4,  shadows: false },
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

  return { sides, cap, panel, slopes, ends };
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

function houseWall(v, rnd, aniso) {
  const T = TILE.house, bays = 2, floors = 2;
  const ctx = tileCtx(256, 192, T.u, T.v);
  const bw = T.u / bays, fh = T.v / floors;

  ctx.fillStyle = '#efece4';
  ctx.fillRect(0, 0, T.u, T.v);
  if (v === 0) {
    // Lap siding.
    for (let y = 0; y < T.v; y += 0.24) {
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, y, T.u, 0.05);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(0, y + 0.05, T.u, 0.04);
    }
  } else {
    // Render over a brick plinth. Houses come out one tile tall, so the plinth
    // lands at the pavement rather than halfway up the wall.
    grain(ctx, rnd, T.u, T.v, 2600, 0.20, 0.05);
    ctx.fillStyle = 'rgba(96,74,62,0.55)';
    ctx.fillRect(0, 0, T.u, 0.85);
    for (let y = 0; y < 0.85; y += 0.14) {
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, y, T.u, 0.03);
    }
  }

  for (let f = 0; f < floors; f++) {
    for (let b = 0; b < bays; b++) {
      const x = b * bw + (bw - 1.25) / 2, y = f * fh + 1.05;
      ctx.fillStyle = '#f7f5f0';
      ctx.fillRect(x - 0.11, y - 0.13, 1.47, 1.62);          // frame
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x - 0.05, y - 0.05, 1.35, 1.5);
      const g = ctx.createLinearGradient(0, y, 0, y + 1.35);
      g.addColorStop(0, '#232b30');
      g.addColorStop(1, '#5b6c76');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1.25, 1.35);
      ctx.fillStyle = '#f7f5f0';
      ctx.fillRect(x + 0.59, y, 0.08, 1.35);                 // centre mullion
      ctx.fillRect(x - 0.16, y - 0.22, 1.57, 0.11);          // sill
    }
  }
  return texture(ctx, true, aniso);
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

function wareWall(v, rnd, aniso) {
  const T = TILE.ware;
  const ctx = tileCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#dcdcd8';
  ctx.fillRect(0, 0, T.u, T.v);
  // Trapezoidal profile sheeting: a light face, a shaded return, a dark valley.
  const pitch = v === 0 ? 0.26 : 0.34;
  for (let x = 0; x < T.u; x += pitch) {
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillRect(x, 0, pitch * 0.32, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x + pitch * 0.58, 0, pitch * 0.26, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(x + pitch * 0.84, 0, pitch * 0.16, T.v);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, T.v * 0.5 - 0.05, T.u, 0.10);              // sheet lap
  ctx.fillStyle = 'rgba(60,58,54,0.5)';
  ctx.fillRect(0, 0, T.u, 0.7);                              // grubby plinth
  grain(ctx, rnd, T.u, T.v, 900, 0.14, 0.07);
  return texture(ctx, true, aniso);
}

function gableSkin(rnd, aniso) {
  const T = TILE.gable;
  const ctx = tileCtx(128, 128, T.u, T.v);
  ctx.fillStyle = '#efece4';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let y = 0; y < T.v; y += 0.24) {
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, y, T.u, 0.05);
  }
  grain(ctx, rnd, T.u, T.v, 500, 0.12, 0.06);
  return texture(ctx, true, aniso);
}

function roofTiles(rnd, aniso) {
  const T = TILE.tiles;
  const ctx = tileCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#e6e2dc';
  ctx.fillRect(0, 0, T.u, T.v);
  const course = 0.3, tile = 0.32;
  for (let y = 0, row = 0; y < T.v; y += course, row++) {
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(0, y, T.u, 0.07);                            // course shadow
    for (let x = (row % 2) * tile * 0.5; x < T.u; x += tile) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.13})`;
      ctx.fillRect(x, y, 0.035, course);                      // joint
      if (rnd() < 0.22) {
        ctx.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.1})`;
        ctx.fillRect(x + 0.04, y + 0.08, tile - 0.08, course - 0.12);
      }
    }
  }
  return texture(ctx, true, aniso);
}

function roofMetal(rnd, aniso) {
  const T = TILE.metal;
  const ctx = tileCtx(256, 256, T.u, T.v);
  ctx.fillStyle = '#d6d8d6';
  ctx.fillRect(0, 0, T.u, T.v);
  for (let x = 0; x < T.u; x += 0.24) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x, 0, 0.07, T.v);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + 0.15, 0, 0.06, T.v);
  }
  for (let i = 0; i < 14; i++) {                              // rust down a rib
    ctx.fillStyle = `rgba(122,74,42,${0.05 + rnd() * 0.12})`;
    ctx.fillRect(rnd() * T.u, rnd() * T.v, 0.07, 0.5 + rnd() * 1.6);
  }
  return texture(ctx, true, aniso);
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
  return texture(ctx, true, aniso);
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
  return texture(ctx, true, aniso);
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
function patchCity(material, windows, night, glow, emScale = 1) {
  // The cache key has to carry the scale, or three reuses one compiled program
  // for every facade type and they all inherit whichever was compiled first.
  material.customProgramCacheKey = () => (windows ? 'city-win-' + emScale : 'city');
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL +
        (windows ? 'attribute float aOccupancy;\nvarying float vOccupancy;\n' : ''))
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + VERT_UV +
        (windows ? 'vOccupancy = aOccupancy;\n' : ''));

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

  const towerMap = [0, 1, 2].map((v) => keep(towerFacade(v, trnd, aniso)));
  const towerWin = [0, 1, 2].map(() => keep(towerWindows(trnd, aniso)));
  const blockMap = [0, 1, 2].map((v) => keep(blockFacade(v, trnd, aniso)));
  const blockWin = [0, 1, 2].map(() => keep(blockWindows(trnd, aniso)));
  const shopMap = [0, 1].map((v) => keep(shopFacade(v, trnd, aniso)));
  const shopWin = [0, 1].map(() => keep(shopWindows(trnd, aniso)));
  const houseMap = [0, 1].map((v) => keep(houseWall(v, trnd, aniso)));
  const houseWin = [0, 1].map(() => keep(houseWindows(trnd, aniso)));
  const wareMap = [0, 1].map((v) => keep(wareWall(v, trnd, aniso)));
  const gableMap = keep(gableSkin(trnd, aniso));
  const tilesMap = keep(roofTiles(trnd, aniso));
  const metalMap = keep(roofMetal(trnd, aniso));
  const flatMap = keep(roofFlat(trnd, aniso));
  const trimMap = keep(trimSkin(trnd, aniso));
  const panelMap = keep(doorPanel(trnd, aniso));
  const rollerMap = keep(doorRoller(trnd, aniso));

  // ---- materials ---------------------------------------------------------
  const materials = [];
  /**
   * `emScale` dims one facade type's night glow without touching the others.
   * Shopfronts need it: their emissive map is a near-continuous strip of
   * glazing rather than a grid of separate windows, so at the same glow as a
   * tower the whole ground floor of every mid-rise blows out into one solid
   * band of light. The shared uGlow uniform cannot express that, and the
   * material's own emissive colour is not read at all — the patched shader
   * computes totalEmissiveRadiance from scratch.
   */
  function facade(map, win, shininess, specular, emScale = 1) {
    const m = new THREE.MeshPhongMaterial({
      map,
      emissiveMap: win || null,
      emissive: win ? 0xffffff : 0x000000,
      specular,
      shininess,
      fog: true,
    });
    patchCity(m, !!win, nightU, glowU, emScale);
    materials.push(m);
    return m;
  }

  // Phong rather than Standard: with no environment map a metallic workflow
  // renders glass black, and a specular highlight is exactly what sells a
  // curtain wall in daylight. It is also markedly cheaper per pixel.
  const matTower = [0, 1, 2].map((v) => facade(towerMap[v], towerWin[v], 74, 0x525a63));
  const matBlock = [0, 1, 2].map((v) => facade(blockMap[v], blockWin[v], 9, 0x14140f));
  const matShop = [0, 1].map((v) => facade(shopMap[v], shopWin[v], 46, 0x3a3f44, 0.30));
  const matHouse = [0, 1].map((v) => facade(houseMap[v], houseWin[v], 7, 0x121210));
  const matWare = [0, 1].map((v) => facade(wareMap[v], null, 26, 0x2b2e30));
  const matGable = facade(gableMap, null, 6, 0x101010);
  const matTiles = facade(tilesMap, null, 5, 0x0e0e0c);
  const matMetal = facade(metalMap, null, 30, 0x2e3134);
  const matFlat = facade(flatMap, null, 4, 0x0c0c0c);
  const matTrim = facade(trimMap, null, 6, 0x121212);
  const matPanel = facade(panelMap, null, 22, 0x24242a);
  const matRoller = facade(rollerMap, null, 24, 0x2a2d30);

  const matBeacon = new THREE.MeshBasicMaterial({ color: 0x2a0604, fog: true });
  materials.push(matBeacon);

  // ---- piles -------------------------------------------------------------
  const pTower = [makePile(), makePile(), makePile()];
  const pBlock = [makePile(), makePile(), makePile()];
  const pShop = [makePile(), makePile()];
  const pHouse = [makePile(), makePile()];
  const pWare = [makePile(), makePile()];
  const pGable = makePile();
  const pWareGable = [makePile(), makePile()];
  const pTiles = makePile();
  const pMetal = makePile();
  const pFlat = makePile();
  const pTrim = makePile();
  const pTrimCap = makePile();
  const pPanel = makePile();
  const pRoller = makePile();
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

  function emitHouse(lot, rnd, occ) {
    const v = (rnd() * 2) | 0;
    const paint = HOUSE_PAINT[(rnd() * HOUSE_PAINT.length) | 0];
    const roofCol = ROOF_PAINT[(rnd() * ROOF_PAINT.length) | 0];
    const trim = TRIM_TINT[(rnd() * TRIM_TINT.length) | 0];
    const T = TILE.house, w = lot.w, d = lot.d;
    const h = Math.max(5, lot.height);
    const roofH = clamp(h * 0.3, 1.7, 3.6);
    const wallH = h - roofH;

    put(pHouse[v], 0, wallH / 2, 0, 0, w, wallH, d, paint,
      rep4(reps(w, T.u), reps(d, T.u), reps(wallH, T.v), 1), occ, CULL.house);

    // The ridge runs along the longer side, with a 0.45 m overhang all round.
    const alongX = w >= d;
    const ridge = (alongX ? w : d) + 0.9;
    const span = (alongX ? d : w) + 0.9;
    const ry = alongX ? 0 : Math.PI / 2;
    const slope = Math.hypot(span / 2, roofH);
    put(pTiles, 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, roofCol,
      rep4(reps(ridge, TILE.tiles.u), 1, reps(slope, TILE.tiles.v), 1), 0, CULL.house);
    put(pGable, 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, paint,
      rep4(1, reps(span, TILE.gable.u), reps(roofH, TILE.gable.v), 1), 0, CULL.house);

    // Front-garden clutter, all of it on the street side.
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

    const garage = front > 10.5 && rnd() < 0.62;
    if (garage) {
      // Half-buried in the house, so it only projects as far as the front
      // garden and never over the kerb.
      const gw = 3.5, gd = 4.8, gh = 2.65;
      const along = (front / 2 - gw / 2 - 0.5) * (rnd() < 0.5 ? -1 : 1);
      const [gx, gz] = at(along, gd * 0.22);
      const [sx, sz] = boxScale(gw, gd);
      put(pHouse[v], gx, gh / 2, gz, 0, sx, gh, sz, paint,
        rep4(reps(sx, T.u), reps(sz, T.u), 1, 1), 0, CULL.house);
      put(pTrimCap, gx, gh, gz, 0, sx + 0.35, 1, sz + 0.35, trim,
        rep4(1, 1, 1, 1), 0, CULL.house);
      const [dx, dz] = at(along, gd * 0.72 + 0.03);
      put(pPanel, dx, (gh - 0.3) / 2, dz, yaw, gw - 0.5, gh - 0.3, 1, 0xdadad4,
        rep4(1, 1, 1, 1), 0, CULL.detail);
    }

    const porchY = Math.min(wallH - 0.4, 2.55);
    const [px, pz] = at(0, 0.85);
    const [psx, psz] = boxScale(2.5, 1.7);
    put(pTrim, px, porchY, pz, 0, psx, 0.22, psz, trim, rep4(1, 1, 1, 1), 0, CULL.detail);
    for (const side of [-1, 1]) {
      const [cx, cz] = at(side * 1.05, 1.5);
      put(pTrim, cx, porchY / 2, cz, 0, 0.16, porchY, 0.16, trim, rep4(1, 1, 1, 1), 0, CULL.detail);
    }
    const [fx, fz] = at(0, 0.04);
    put(pPanel, fx, 1.05, fz, yaw, 1.05, 2.1, 1, HOUSE_PAINT[(rnd() * 4) | 0],
      rep4(1, 1, 1, 1), 0, CULL.detail);

    // Garden wall only where there is no garage: the two occupy the same strip
    // of front garden, and a wall crossing a garage door looks like a mistake.
    if (!garage && rnd() < 0.7) {
      const [wx, wz] = at(0, 3.4);
      const [wsx, wsz] = boxScale(front + 1.6, 0.3);
      put(pTrim, wx, 0.28, wz, 0, wsx, 0.56, wsz, trim,
        rep4(reps(wsx, TILE.trim.u), reps(wsz, TILE.trim.u), 1, 1), 0, CULL.detail);
    }
  }

  function emitWarehouse(lot, rnd) {
    const v = (rnd() * 2) | 0;
    const tint = WARE_PAINT[(rnd() * WARE_PAINT.length) | 0];
    const T = TILE.ware, w = lot.w, d = lot.d;
    const h = Math.max(7, lot.height);
    const roofH = clamp(h * 0.16, 1.0, 2.6);
    const wallH = h - roofH;

    put(pWare[v], 0, wallH / 2, 0, 0, w, wallH, d, tint,
      rep4(reps(w, T.u), reps(d, T.u), reps(wallH, T.v), 1), 0, CULL.ware);

    const alongX = w >= d;
    const ridge = (alongX ? w : d) + 0.7;
    const span = (alongX ? d : w) + 0.7;
    const ry = alongX ? 0 : Math.PI / 2;
    const slope = Math.hypot(span / 2, roofH);
    put(pMetal, 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, tint,
      rep4(reps(ridge, TILE.metal.u), 1, reps(slope, TILE.metal.v), 1), 0, CULL.ware);
    put(pWareGable[v], 0, wallH + roofH / 2, 0, ry, ridge, roofH, span, tint,
      rep4(1, reps(span, T.u), 1, 1), 0, CULL.ware);

    // Loading docks along the street side.
    const face = frontFace(lot);
    const ox = face === 0 ? 1 : face === 1 ? -1 : 0;
    const oz = face === 2 ? 1 : face === 3 ? -1 : 0;
    const yaw = face === 0 ? Math.PI / 2 : face === 1 ? -Math.PI / 2 : face === 2 ? 0 : Math.PI;
    const sideways = ox !== 0;
    const out = sideways ? w / 2 : d / 2;
    const front = sideways ? d : w;
    const doors = clamp(Math.floor(front / 13), 1, 4);
    const dh = Math.min(4.6, wallH - 0.9);
    for (let i = 0; i < doors; i++) {
      const along = (i - (doors - 1) / 2) * (front / (doors + 0.35));
      const dx = ox * (out + 0.05) + (sideways ? 0 : along);
      const dz = oz * (out + 0.05) + (sideways ? along : 0);
      put(pRoller, dx, dh / 2, dz, yaw, 4.2, dh, 1, 0xd2d4d4, rep4(1, 1, 1, 1), 0, CULL.dock);
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
  const lots = world.lots || [];
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
  for (let v = 0; v < 2; v++) mount(shells.sides, matHouse[v], pHouse[v], `house${v}`, true);
  for (let v = 0; v < 2; v++) mount(shells.sides, matWare[v], pWare[v], `warehouse${v}`, true);
  for (let v = 0; v < 2; v++) mount(shells.ends, matWare[v], pWareGable[v], `waregable${v}`, false);
  mount(shells.ends, matGable, pGable, 'gable', false);
  mount(shells.slopes, matTiles, pTiles, 'tileroof', true);
  mount(shells.slopes, matMetal, pMetal, 'metalroof', true);
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
