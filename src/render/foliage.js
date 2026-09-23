// Trees and bushes: the procedural foliage atlas, the species, and their LODs.
//
// WHY LEAF CARDS NOW, WHEN THIS FILE'S PREDECESSOR ARGUED AGAINST THEM
//
// props.js used to make every canopy out of twenty-face icosahedra, on the
// argument that a lit solid holds its silhouette where a cross-billboard shears.
// Both halves of that are true and neither was the problem: a solid blob reads
// as a lollipop from the driver's seat whatever it is lit with, because a real
// canopy is not a surface at all. It is a few thousand small occluders with sky
// between them, and the gaps are most of what the eye uses to say "tree".
//
// What fixes the shearing is not avoiding cards, it is not using TWO of them.
// A tree here is a hundred or so small cards scattered through clumps, each
// carrying a painted spray of leaves or needles, and none of them large enough
// on its own to be seen edge-on. The shading is then taken away from the cards
// entirely: every card vertex gets the normal of the CANOPY at that point — a
// blend of "out from the crown" and "out from this clump" — so the tree is lit
// as one lumpy volume with a bright sunward side and a dark core, which is what
// a real tree does, instead of as a hundred flat planes that each flash as they
// turn. That trick is the whole difference between foliage and confetti.
//
// THE THREE LODS, AND WHY THEY ARE BUILT FROM ONE SKELETON
//
// A species is generated once as a DESCRIPTION — branch tubes and a card list —
// and every level is cut from that same description:
//
//   near  every card, every branch. ~400-600 triangles.
//   mid   about a quarter of the cards, each scaled up so the canopy keeps the
//         same area, and only the major limbs. ~120-190 triangles. Because
//         the cards it keeps are the SAME cards, in the same places, the swap
//         from near to mid changes texture density and nothing else — the
//         silhouette does not jump.
//   far   an impostor: the near mesh rasterised on the CPU, from two sides,
//         into a small atlas of albedo and canopy normal. Two triangles a tree,
//         so a hillside can carry a forest out to the fog.
//
// The impostor is rasterised here in JavaScript rather than rendered on the
// GPU because the props layer is built before anything hands it a renderer,
// and because a headless harness can then check what it produced.
//
// Nothing in this file allocates after load, and nothing here touches the DOM.

import * as THREE from 'three';
import { mulberry, clamp, lerp, smoothstep } from '../world/noise.js';

// ===========================================================================
// Atlas layout
// ===========================================================================
// 1024 x 512, eight 256 px cells. Image coordinates are GL's: row 0 is v = 0,
// and a cell's (0,0) is its bottom-left corner. A spray is painted with its
// stem at the BOTTOM centre of the cell, growing up, so a card's v axis is
// "outward along the twig".

export const ATLAS_W = 1024;
export const ATLAS_H = 512;
const CELL = 256;
const PAD = 5;   // transparent margin inside every cell, so mips do not borrow

export const CELLS = {
  oak: 0, beech: 1, birch: 2, spruce: 3,
  pine: 4, shrub: 5, fir: 6, bark: 7,
};
// The bark cell is split down the middle: rough fissured bark on the left,
// smooth birch bark with lenticels on the right.

function cellRect(cell) {
  return { x: (cell % 4) * CELL, y: Math.floor(cell / 4) * CELL };
}

// ===========================================================================
// A tiny premultiplied-alpha painter
// ===========================================================================
// Coverage is analytic (distance to the shape's edge, one pixel of ramp), so
// the atlas has real antialiased edges. That matters more than it sounds: the
// shader sharpens alpha against its own screen-space derivative, and that only
// works if the texture carries a gradient at the edge to sharpen.

function makeCanvas(W, H) {
  return { W, H, p: new Float32Array(W * H * 4) };   // r*a, g*a, b*a, a
}

function over(cv, x, y, r, g, b, a) {
  if (a <= 0) return;
  const o = (y * cv.W + x) * 4, p = cv.p, k = 1 - a;
  p[o] = r * a + p[o] * k;
  p[o + 1] = g * a + p[o + 1] * k;
  p[o + 2] = b * a + p[o + 2] * k;
  p[o + 3] = a + p[o + 3] * k;
}

/**
 * A leaf: base at (bx, by), pointing along `ang`, `len` long and `wid` wide.
 * `lobes` > 0 scallops the edge (oak), `serr` adds fine teeth (birch). The fill
 * is shaded as a shallow dome with a pale midrib and a lighter tip, because a
 * leaf the size of five screen pixels still reads as flat paint without it.
 */
function leaf(cv, clip, bx, by, ang, len, wid, rgb, lobes, serr, tone) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let hw = wid * 0.5;
  // Shrink rather than clip. A leaf cut off by the cell border is a straight
  // edge, and a straight edge on a card is exactly what gives a card away.
  const m = hw + 1.5;
  let fit = 1;
  const tx = bx + ca * len, ty = by + sa * len;
  if (tx < clip.x0 + m) fit = Math.min(fit, (bx - clip.x0 - m) / Math.max(1e-3, bx - tx));
  if (tx > clip.x1 - m) fit = Math.min(fit, (clip.x1 - m - bx) / Math.max(1e-3, tx - bx));
  if (ty < clip.y0 + m) fit = Math.min(fit, (by - clip.y0 - m) / Math.max(1e-3, by - ty));
  if (ty > clip.y1 - m) fit = Math.min(fit, (clip.y1 - m - by) / Math.max(1e-3, ty - by));
  if (fit < 0.35) return;
  if (fit < 1) { len *= fit; hw *= Math.sqrt(fit); }
  const ex = Math.abs(ca) * len + Math.abs(sa) * hw + 2;
  const ey = Math.abs(sa) * len + Math.abs(ca) * hw + 2;
  const cx = bx + ca * len * 0.5, cy = by + sa * len * 0.5;
  const x0 = Math.max(clip.x0, Math.floor(cx - ex * 0.5 - hw)), x1 = Math.min(clip.x1, Math.ceil(cx + ex * 0.5 + hw));
  const y0 = Math.max(clip.y0, Math.floor(cy - ey * 0.5 - hw)), y1 = Math.min(clip.y1, Math.ceil(cy + ey * 0.5 + hw));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - bx, dy = y + 0.5 - by;
      const u = (dx * ca + dy * sa) / len;
      if (u < -0.02 || u > 1.02) continue;
      const v = -dx * sa + dy * ca;
      const uc = clamp(u, 0, 1);
      // Widest a little below the middle, rounded at the stalk, pointed at the tip.
      let w = hw * Math.pow(4 * uc * (1 - uc), 0.62) * (1.12 - 0.28 * uc);
      if (lobes > 0) w *= 0.80 + 0.20 * Math.abs(Math.cos(uc * Math.PI * lobes));
      if (serr > 0) w *= 1 - serr * (0.5 + 0.5 * Math.sin(uc * 70));
      const d = Math.abs(v) - w;
      const cov = clamp(0.5 - d, 0, 1) * clamp((0.5 - Math.abs(u - 0.5)) * len + 0.5, 0, 1);
      if (cov <= 0) continue;
      const across = w > 0.01 ? Math.abs(v) / w : 1;
      let k = tone * (0.86 + 0.20 * (1 - across * across) + 0.10 * uc);
      if (Math.abs(v) < 0.7 && uc < 0.9) k *= 1.16;             // midrib
      over(cv, x, y, rgb[0] * k, rgb[1] * k, rgb[2] * k, cov);
    }
  }
}

/** A tapered stroke from (x0,y0) to (x1,y1), for twigs and needles. */
function stroke(cv, clip, xa, ya, xb, yb, wa, wb, rgb, tone) {
  const dx = xb - xa, dy = yb - ya, L2 = dx * dx + dy * dy || 1;
  const pad = Math.max(wa, wb) * 0.5 + 1.5;
  const x0 = Math.max(clip.x0, Math.floor(Math.min(xa, xb) - pad)), x1 = Math.min(clip.x1, Math.ceil(Math.max(xa, xb) + pad));
  const y0 = Math.max(clip.y0, Math.floor(Math.min(ya, yb) - pad)), y1 = Math.min(clip.y1, Math.ceil(Math.max(ya, yb) + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - xa, py = y + 0.5 - ya;
      const t = clamp((px * dx + py * dy) / L2, 0, 1);
      const qx = px - dx * t, qy = py - dy * t;
      const d = Math.sqrt(qx * qx + qy * qy);
      const hw = (wa + (wb - wa) * t) * 0.5;
      const cov = clamp(hw + 0.5 - d, 0, 1) * (hw < 0.5 ? hw * 2 : 1);
      if (cov <= 0) continue;
      const k = tone * (1.08 - 0.25 * (d / Math.max(0.5, hw)));
      over(cv, x, y, rgb[0] * k, rgb[1] * k, rgb[2] * k, cov);
    }
  }
}

function clipOf(cell) {
  const r = cellRect(cell);
  return { x0: r.x + PAD, y0: r.y + PAD, x1: r.x + CELL - 1 - PAD, y1: r.y + CELL - 1 - PAD, ox: r.x, oy: r.y };
}

// ---------------------------------------------------------------------------
// The sprays
// ---------------------------------------------------------------------------

/**
 * A broadleaf spray: a stem, alternating side twigs, leaves along both.
 * `leafLen` and `leafWid` are pixels; the spray fills most of the cell so that a
 * card of a metre and a half carries forty-odd leaves of four to six centimetres.
 */
function broadleafSpray(cv, cell, rnd, o) {
  const c = clipOf(cell);
  const cx = c.ox + CELL / 2;
  const stemTop = c.oy + CELL - PAD - 18;
  const stemBend = (rnd() * 2 - 1) * 18;
  const stemAt = (t) => [cx + stemBend * t * t, c.oy + PAD + 4 + (stemTop - c.oy - PAD - 4) * t];
  const leaves = [];
  // Twigs first, so leaves paint over them.
  const twigs = [];
  const nTw = o.twigs;
  for (let i = 0; i < nTw; i++) {
    const t = 0.12 + (i / nTw) * 0.78 + rnd() * 0.04;
    const side = i % 2 === 0 ? 1 : -1;
    const [sx, sy] = stemAt(t);
    // Low twigs splay almost sideways, high ones sweep up: the outline of the
    // whole spray comes out as a rounded fan that fills the cell, which is
    // what lets a card carry a real share of the canopy.
    const a = Math.PI / 2 - side * lerp(1.30, 0.55, t) * (0.85 + rnd() * 0.3);
    const L = o.twigLen * (0.62 + 0.55 * Math.sin(Math.PI * Math.min(1, 0.2 + t))) * (0.85 + rnd() * 0.3);
    const bend = side * (0.15 + rnd() * 0.3);
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6, aa = a + bend * u;
      pts.push([sx + Math.cos(aa) * L * u, sy + Math.sin(aa) * L * u]);
    }
    twigs.push({ pts, a, bend, L, side });
  }
  for (let k = 0; k < 10; k++) {
    const [xa, ya] = stemAt(k / 10), [xb, yb] = stemAt((k + 1) / 10);
    stroke(cv, c, xa, ya, xb, yb, 3.4 - k * 0.2, 3.2 - k * 0.2, o.twig, 1);
  }
  for (const tw of twigs) {
    for (let k = 0; k < 6; k++) {
      stroke(cv, c, tw.pts[k][0], tw.pts[k][1], tw.pts[k + 1][0], tw.pts[k + 1][1], 2.2 - k * 0.25, 2.0 - k * 0.25, o.twig, 1);
    }
    // A forked twiglet off the outer half, carrying its own leaves, so the
    // spray is a branching thing and not a row of combs.
    {
      const q = tw.pts[3 + Math.floor(rnd() * 2)];
      const fa = tw.a + tw.bend * 0.6 - tw.side * (0.5 + rnd() * 0.4);
      const fl = tw.L * (0.35 + rnd() * 0.2);
      const fx = q[0] + Math.cos(fa) * fl, fy = q[1] + Math.sin(fa) * fl;
      stroke(cv, c, q[0], q[1], fx, fy, 1.5, 1.0, o.twig, 1);
      const m = Math.max(2, Math.round(fl / o.spacing));
      for (let k = 1; k <= m; k++) {
        const u = k / m;
        const side = k % 2 === 0 ? 1 : -1;
        const ang = k === m ? fa + (rnd() - 0.5) * 0.3 : fa + side * (0.6 + rnd() * 0.5);
        leaves.push([q[0] + (fx - q[0]) * u, q[1] + (fy - q[1]) * u, ang,
          o.leafLen * (0.75 + rnd() * 0.35), o.leafWid * (0.8 + rnd() * 0.3)]);
      }
    }
    // Leaves alternate along the twig, angled forward, the last one terminal.
    const n = Math.max(3, Math.round(tw.L / o.spacing));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const q = tw.pts[Math.min(6, Math.round(u * 6))];
      const along = tw.a + tw.bend * u;
      const side = k % 2 === 0 ? 1 : -1;
      const ang = k === n ? along + (rnd() - 0.5) * 0.3 : along + side * (0.55 + rnd() * 0.5);
      leaves.push([q[0], q[1], ang, o.leafLen * (0.8 + rnd() * 0.4) * (1 - 0.25 * u), o.leafWid * (0.8 + rnd() * 0.35)]);
    }
  }
  // A few straight off the main stem, and a terminal cluster at its tip.
  for (let k = 0; k < o.stemLeaves; k++) {
    const t = 0.25 + (k / o.stemLeaves) * 0.75;
    const [sx, sy] = stemAt(t);
    const side = k % 2 === 0 ? 1 : -1;
    leaves.push([sx, sy, Math.PI / 2 + side * (0.4 + rnd() * 0.6), o.leafLen * (0.9 + rnd() * 0.3), o.leafWid * (0.9 + rnd() * 0.3)]);
  }
  // Painted in random order so no side of the spray is uniformly on top.
  for (let i = leaves.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = leaves[i]; leaves[i] = leaves[j]; leaves[j] = t;
  }
  for (const L of leaves) {
    const tone = 0.78 + rnd() * 0.36;
    const hue = rnd();
    const rgb = [
      o.leaf[0] * (1 + (hue - 0.5) * o.hueJitter),
      o.leaf[1],
      o.leaf[2] * (1 - (hue - 0.5) * o.hueJitter * 0.6),
    ];
    leaf(cv, c, L[0], L[1], L[2], L[3], L[4], rgb, o.lobes, o.serr, tone);
  }
}

/**
 * A conifer frond: a rachis up the middle of the cell, branchlets swept
 * forward off both sides, and needles off every branchlet. Longest in the lower
 * middle and tapering to the tip, which is the outline of a real spruce branch
 * seen from above. Branchlet tips are a lighter, yellower green — the new
 * growth, and the single cue that stops a conifer reading as a black cut-out.
 */
function coniferSpray(cv, cell, rnd, o) {
  const c = clipOf(cell);
  const cx = c.ox + CELL / 2;
  const y0 = c.oy + PAD + 2, y1 = c.oy + CELL - PAD - 6;
  const H = y1 - y0;
  const wob = (rnd() * 2 - 1) * 6;
  const rach = (t) => [cx + wob * Math.sin(t * Math.PI), y0 + H * t];
  for (let k = 0; k < 12; k++) {
    const [xa, ya] = rach(k / 12), [xb, yb] = rach((k + 1) / 12);
    stroke(cv, c, xa, ya, xb, yb, 3.2 - k * 0.2, 3.0 - k * 0.2, o.twig, 1);
  }
  const needles = [];
  const nB = o.branchlets;
  for (let i = 0; i < nB; i++) {
    const t = 0.04 + (i / nB) * 0.9;
    const [sx, sy] = rach(t);
    for (const side of [-1, 1]) {
      const reach = o.reach * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)), 0.8) * (0.8 + rnd() * 0.4);
      const a = Math.PI / 2 - side * (o.sweep + rnd() * 0.2);
      const ex = sx + Math.cos(a) * reach, ey = sy + Math.sin(a) * reach;
      stroke(cv, c, sx, sy, ex, ey, 1.8, 1.0, o.twig, 0.9);
      const steps = Math.max(3, Math.round(reach / o.needleStep));
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const px = sx + (ex - sx) * u, py = sy + (ey - sy) * u;
        const tip = smoothstep(0.55, 1.0, u) * o.tipGrowth;
        for (const ns of [-1, 1]) {
          const na = a + ns * (o.needleAng + rnd() * 0.25);
          const nl = o.needleLen * (0.75 + rnd() * 0.5) * (1 - 0.3 * u);
          needles.push([px, py, na, nl, tip, 0.75 + rnd() * 0.4]);
        }
      }
    }
  }
  // Needles straight off the rachis too, so it is not a bare stick.
  for (let k = 0; k < 60; k++) {
    const t = k / 60;
    const [sx, sy] = rach(t);
    for (const ns of [-1, 1]) {
      needles.push([sx, sy, Math.PI / 2 + ns * (0.7 + rnd() * 0.4), o.needleLen * 0.8, smoothstep(0.85, 1, t) * o.tipGrowth, 0.7 + rnd() * 0.3]);
    }
  }
  for (let i = needles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = needles[i]; needles[i] = needles[j]; needles[j] = t;
  }
  for (const n of needles) {
    const rgb = [lerp(o.needle[0], o.tip[0], n[4]), lerp(o.needle[1], o.tip[1], n[4]), lerp(o.needle[2], o.tip[2], n[4])];
    stroke(cv, c, n[0], n[1], n[0] + Math.cos(n[2]) * n[3], n[1] + Math.sin(n[2]) * n[3], o.needleW, o.needleW * 0.55, rgb, n[5]);
  }
}

/** Pine: long needles in bundles fanning out of the twig ends. */
function pineSpray(cv, cell, rnd, o) {
  const c = clipOf(cell);
  const cx = c.ox + CELL / 2;
  const base = [cx, c.oy + PAD + 4];
  const tufts = [];
  // A short forked twig carrying five or six tufts.
  // A stout twig up the middle with short side shoots, every shoot ending in a
  // dense brush of long needles. Scots pine foliage is clumped like this — dark
  // bottle-brushes with sky between them — and it is why a pine crown looks
  // nothing like a spruce even at a distance.
  const top = [cx + (rnd() - 0.5) * 12, c.oy + 150];
  stroke(cv, c, base[0], base[1], top[0], top[1], 4.0, 2.6, o.twig, 1);
  tufts.push([top[0], top[1], 1.15]);
  for (let i = 0; i < 6; i++) {
    const t = 0.22 + i * 0.12;
    const sx = base[0] + (top[0] - base[0]) * t, sy = base[1] + (top[1] - base[1]) * t;
    const side = i % 2 === 0 ? 1 : -1;
    const a = Math.PI / 2 - side * (0.75 + rnd() * 0.35);
    const L = 44 + rnd() * 24;
    const ex = sx + Math.cos(a) * L, ey = sy + Math.sin(a) * L;
    stroke(cv, c, sx, sy, ex, ey, 2.4, 1.6, o.twig, 1);
    tufts.push([ex, ey, 0.8 + rnd() * 0.2]);
  }
  const needles = [];
  for (const [tx, ty, sz] of tufts) {
    for (let k = 0; k < 120; k++) {
      const a = Math.PI / 2 + (rnd() * 2 - 1) * 1.7;
      const L = o.needleLen * sz * (0.55 + rnd() * 0.5);
      const bx = tx + (rnd() - 0.5) * 6, by = ty - rnd() * 26 * sz;
      needles.push([bx, by, a, L, rnd()]);
    }
  }
  for (let i = needles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = needles[i]; needles[i] = needles[j]; needles[j] = t;
  }
  for (const n of needles) {
    const k = 0.75 + n[4] * 0.45;
    stroke(cv, c, n[0], n[1], n[0] + Math.cos(n[2]) * n[3], n[1] + Math.sin(n[2]) * n[3], 2.0, 1.0, o.needle, k);
  }
}

/**
 * Bark. Rough bark is vertical fissures between lighter plates; birch is pale
 * with horizontal lenticels and a few dark scars. Both are painted near a mid
 * grey-brown so a species can tint them with its vertex colour.
 */
function barkCell(cv, rnd) {
  const c = cellRect(CELLS.bark);
  const HW = CELL / 2;
  // Deterministic column noise for the fissures.
  const col = new Float32Array(HW + 1);
  for (let i = 0; i <= HW; i++) col[i] = rnd();
  const smoothCol = (x) => {
    const i = Math.floor(x) % HW, f = x - Math.floor(x);
    const a = col[(i + HW) % HW], b = col[(i + 1 + HW) % HW];
    return a + (b - a) * f * f * (3 - 2 * f);
  };
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < HW; x++) {
      // Furrowed bark: ridges running up the trunk, wandering and merging,
      // with dark furrows between them. The furrow position is a smooth noise
      // of x warped by a slower noise of y, so the ridges braid rather than
      // run in parallel. An earlier version broke the plates horizontally as
      // well, and at a trunk's width that read unmistakably as brickwork.
      const warp = smoothCol(y / 37 + 3.1) * 9 + smoothCol(y / 11 + 7.7) * 2.2;
      const f = (x + warp) / 9.5;
      const fr = f - Math.floor(f);
      const ridge = Math.sin(fr * Math.PI);                 // 0 in a furrow, 1 on a ridge
      const depth = 0.55 + 0.45 * smoothCol(Math.floor(f) * 3.7 + y / 23);
      const grain = 0.92 + 0.08 * Math.sin(y * 0.9 + smoothCol(x / 3) * 6);
      const k = lerp(0.30, 0.88 + 0.12 * smoothCol(x / 5 + y / 41), Math.pow(ridge, 0.55 * depth + 0.25)) * grain;
      over(cv, c.x + x, c.y + y, 0.56 * k, 0.50 * k, 0.44 * k, 1);
    }
    for (let x = HW; x < CELL; x++) {
      const k = 0.94 - 0.05 * smoothCol((x - HW) / 9 + y * 0.01);
      over(cv, c.x + x, c.y + y, 0.86 * k, 0.85 * k, 0.81 * k, 1);
    }
  }
  // Birch lenticels and scars.
  const clip = { x0: c.x + HW, y0: c.y, x1: c.x + CELL - 1, y1: c.y + CELL - 1 };
  for (let i = 0; i < 70; i++) {
    const x = c.x + HW + 4 + rnd() * (HW - 8), y = c.y + rnd() * CELL;
    const L = 6 + rnd() * 16;
    stroke(cv, clip, x - L / 2, y, x + L / 2, y + (rnd() - 0.5) * 2, 1.4 + rnd() * 1.4, 1.0, [0.16, 0.14, 0.13], 1);
  }
  for (let i = 0; i < 7; i++) {
    const x = c.x + HW + 10 + rnd() * (HW - 20), y = c.y + rnd() * CELL;
    leaf(cv, clip, x - 8, y, (rnd() - 0.5) * 0.4, 16 + rnd() * 12, 7 + rnd() * 6, [0.10, 0.09, 0.09], 0, 0, 1);
  }
}

/**
 * Fill every transparent texel with the colour of its nearest painted
 * neighbour, cell by cell. Bilinear filtering at a leaf's edge otherwise mixes
 * in whatever colour the empty texels hold — black, by default — and every
 * leaf in the game grows a dark rim that gets worse down the mip chain.
 */
function dilate(cv, passes) {
  const { W, H, p } = cv;
  const tmp = new Float32Array(p.length);
  for (let pass = 0; pass < passes; pass++) {
    tmp.set(p);
    for (let y = 0; y < H; y++) {
      const cy = Math.floor(y / CELL);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (p[o + 3] > 0.004 || p[o + 3] < 0) continue;
        const cx = Math.floor(x / CELL);
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (Math.floor(nx / CELL) !== cx || Math.floor(ny / CELL) !== cy) continue;
          const q = (ny * W + nx) * 4;
          const a = p[q + 3];
          if (a > 0.004) { r += p[q] / a; g += p[q + 1] / a; b += p[q + 2] / a; n++; }
          else if (a < 0) { r += p[q]; g += p[q + 1]; b += p[q + 2]; n++; }
        }
        if (n > 0) {
          // Negative alpha marks "dilated colour, still transparent", which the
          // next pass reads as a source without mistaking it for coverage.
          tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n; tmp[o + 3] = -1;
        }
      }
    }
    p.set(tmp);
  }
}

function toBytes(cv) {
  const { p } = cv;
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    let r, g, b;
    if (a > 0.004) { r = p[i] / a; g = p[i + 1] / a; b = p[i + 2] / a; }
    else if (a < 0) { r = p[i]; g = p[i + 1]; b = p[i + 2]; }
    else { r = 0.2; g = 0.3; b = 0.12; }
    out[i] = clamp(r, 0, 1) * 255 + 0.5;
    out[i + 1] = clamp(g, 0, 1) * 255 + 0.5;
    out[i + 2] = clamp(b, 0, 1) * 255 + 0.5;
    out[i + 3] = clamp(a, 0, 1) * 255 + 0.5;
  }
  return out;
}

// Colours are sRGB, as painted. The texture is tagged SRGBColorSpace so the
// sampler linearises them; vertex colours on the cards are pure light (AO and
// tint), so they multiply without any further conversion.
const PAINT = {
  oak:    { twigs: 8, twigLen: 96, spacing: 15, leafLen: 34, leafWid: 19, stemLeaves: 7, lobes: 3.5, serr: 0,
            leaf: [0.23, 0.33, 0.11], twig: [0.30, 0.25, 0.18], hueJitter: 0.35 },
  beech:  { twigs: 9, twigLen: 94, spacing: 14, leafLen: 30, leafWid: 18, stemLeaves: 8, lobes: 0, serr: 0.03,
            leaf: [0.27, 0.39, 0.12], twig: [0.32, 0.27, 0.20], hueJitter: 0.30 },
  birch:  { twigs: 10, twigLen: 94, spacing: 13, leafLen: 22, leafWid: 15, stemLeaves: 6, lobes: 0, serr: 0.06,
            leaf: [0.36, 0.47, 0.15], twig: [0.28, 0.22, 0.17], hueJitter: 0.30 },
  shrub:  { twigs: 11, twigLen: 96, spacing: 11, leafLen: 22, leafWid: 14, stemLeaves: 9, lobes: 0, serr: 0.02,
            leaf: [0.22, 0.31, 0.11], twig: [0.27, 0.22, 0.16], hueJitter: 0.40 },
  spruce: { branchlets: 22, reach: 92, sweep: 0.95, needleStep: 2.6, needleAng: 0.85, needleLen: 9, needleW: 1.7,
            needle: [0.07, 0.15, 0.09], tip: [0.20, 0.33, 0.14], tipGrowth: 0.85, twig: [0.22, 0.17, 0.12] },
  fir:    { branchlets: 20, reach: 84, sweep: 1.15, needleStep: 2.4, needleAng: 1.25, needleLen: 10, needleW: 2.0,
            needle: [0.08, 0.17, 0.13], tip: [0.18, 0.30, 0.20], tipGrowth: 0.55, twig: [0.22, 0.17, 0.12] },
  pine:   { needleLen: 44, needle: [0.16, 0.25, 0.13], twig: [0.33, 0.24, 0.16] },
};

/**
 * A grass card: seventy-odd blades rising from the bottom edge, as RGBA bytes,
 * 256 x 128. The colour is a neutral MULTIPLIER (stored at 1/1.6 so it can go
 * above one), not a green: the tuft takes its actual colour from the ground
 * palette at the spot it grows, so a clump in dry grass is straw and a clump in
 * the valley is lush, and neither is a pasted-on sticker.
 */
export function paintGrassCard(seed) {
  const W = 256, H = 128;
  const cv = { W, H, p: new Float32Array(W * H * 4) };
  const rnd = mulberry(seed);
  const clip = { x0: 1, y0: 0, x1: W - 2, y1: H - 2 };
  const blades = [];
  for (let i = 0; i < 78; i++) {
    const x = 10 + rnd() * (W - 20);
    const h = (0.45 + rnd() * 0.55) * (H - 6) * (1 - 0.35 * Math.pow(Math.abs(x / W - 0.5) * 2, 2));
    const lean = (rnd() - 0.5) * 0.9 + (x / W - 0.5) * 0.7;
    blades.push({ x, h, lean, w: 2.2 + rnd() * 2.6, depth: rnd(), dry: rnd() < 0.08 });
  }
  // Back to front: the deeper blades are darker, being in their neighbours' shade.
  blades.sort((a, b) => b.depth - a.depth);
  for (const bl of blades) {
    const segs = 6;
    let px = bl.x, py = 0;
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs, t1 = (k + 1) / segs;
      // Bending over as it rises: the lean grows with height.
      const nx = bl.x + Math.sin(bl.lean * t1 * 1.4) * bl.h * t1 * 0.9;
      const ny = bl.h * t1 * Math.cos(bl.lean * t1 * 0.8);
      // Averaging close to one over the card, so a tuft seen from above is
      // the ground's own colour with texture in it rather than a dark speck.
      const shade = (0.72 + 0.55 * t1) * (1 - bl.depth * 0.22);
      const rgb = bl.dry ? [0.95 * shade, 0.85 * shade, 0.55 * shade]
        : [shade * (0.95 + 0.12 * t1), shade, shade * (0.92 - 0.12 * t1)];
      stroke(cv, clip, px, py, nx, ny, bl.w * (1 - t0 * 0.85), bl.w * (1 - t1 * 0.85) + 0.3,
        [rgb[0] / 1.6, rgb[1] / 1.6, rgb[2] / 1.6], 1);
      px = nx; py = ny;
    }
  }
  // Dilate colour into the empty texels, as for the atlas (one cell here).
  const p = cv.p;
  for (let pass = 0; pass < 6; pass++) {
    const tmp = p.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (p[o + 3] > 0.004 || p[o + 3] < 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const q = (Y * W + X) * 4, a = p[q + 3];
          if (a > 0.004) { r += p[q] / a; g += p[q + 1] / a; b += p[q + 2] / a; n++; }
          else if (a < 0) { r += p[q]; g += p[q + 1]; b += p[q + 2]; n++; }
        }
        if (n) { tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n; tmp[o + 3] = -1; }
      }
    }
    p.set(tmp);
  }
  return { px: toBytes(cv), W, H };
}

/** The foliage atlas as RGBA bytes. Deterministic in `seed`. ~150 ms. */
export function paintAtlas(seed) {
  const cv = makeCanvas(ATLAS_W, ATLAS_H);
  broadleafSpray(cv, CELLS.oak, mulberry(seed + 1), PAINT.oak);
  broadleafSpray(cv, CELLS.beech, mulberry(seed + 2), PAINT.beech);
  broadleafSpray(cv, CELLS.birch, mulberry(seed + 3), PAINT.birch);
  broadleafSpray(cv, CELLS.shrub, mulberry(seed + 6), PAINT.shrub);
  coniferSpray(cv, CELLS.spruce, mulberry(seed + 4), PAINT.spruce);
  coniferSpray(cv, CELLS.fir, mulberry(seed + 7), PAINT.fir);
  pineSpray(cv, CELLS.pine, mulberry(seed + 5), PAINT.pine);
  barkCell(cv, mulberry(seed + 8));
  dilate(cv, 10);
  return toBytes(cv);
}

// ===========================================================================
// Species descriptions
// ===========================================================================
// A description is two lists:
//
//   tubes  polylines with a radius at every point — trunk, limbs, branches.
//          `mid` says whether the limb survives into the mid LOD.
//   cards  leaf or needle cards, each with its four corners (or, for a conifer
//          frond, a folded strip), the canopy normal and ambient occlusion at
//          every corner, and a `mid` flag with the scale it takes there.
//
// Every builder draws the SAME sequence of random numbers whatever it later
// emits, so the mid LOD is cut from exactly the tree the near LOD shows.

const V = (x = 0, y = 0, z = 0) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const UP = [0, 1, 0];

function randUnit(rnd) {
  const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), z, r * Math.sin(t)];
}

/** Any unit vector perpendicular to `a`. */
function perp(a, rnd) {
  const r = randUnit(rnd);
  const p = cross(a, r);
  return len3(p) < 1e-3 ? norm(cross(a, [1, 0, 0])) : norm(p);
}

/** A limb as a polyline: starts along `d0`, curls toward `d1`, `n` segments. */
function curve(p0, d0, d1, L, n, wob, rnd) {
  const pts = [p0];
  let p = p0;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const d = norm(add(mul(d0, 1 - t), mul(d1, t)));
    p = add(p, mul(d, L / n));
    if (wob > 0 && k < n) p = add(p, [(rnd() - 0.5) * wob, (rnd() - 0.5) * wob * 0.5, (rnd() - 0.5) * wob]);
    pts.push(p);
  }
  return pts;
}

function makeDesc(kind) {
  return { kind, tubes: [], cards: [], height: 0, spread: 0, sink: 0 };
}

/**
 * Broadleaf trees and shrubs: trunk, forks, limbs, secondary branches, and
 * leaf clumps at the ends. Oak, beech, birch and the hazel-type bush are all
 * this function with different numbers.
 */
function broadleaf(rnd, P) {
  const D = makeDesc('broadleaf');
  D.sink = P.sink;
  const R0 = P.trunkR;
  const lean = [(rnd() - 0.5) * P.lean, 0, (rnd() - 0.5) * P.lean];

  // ---- trunk --------------------------------------------------------------
  const trunk = [];
  const trunkR = [];
  const nT = 5;
  for (let k = 0; k <= nT; k++) {
    const t = k / nT;
    const y = -P.sink + (P.forkH + P.sink) * t;
    const off = mul(lean, y);
    trunk.push([off[0] + (k > 0 && k < nT ? (rnd() - 0.5) * P.wobble : 0), y,
                off[2] + (k > 0 && k < nT ? (rnd() - 0.5) * P.wobble : 0)]);
    // Root flare over the bottom metre, then a slow taper.
    trunkR.push(R0 * (1 + P.flare * smoothstep(0.35, 0, t)) * (1 - 0.25 * t));
  }
  if (P.forkH > 0.3) D.tubes.push({ pts: trunk, radii: trunkR, sides: P.trunkSides, midSides: 5, bark: P.bark, rgb: P.barkRGB, mid: true });
  const fork = trunk[nT];

  // ---- leader -------------------------------------------------------------
  const tips = [];
  const limbs = [];
  let leaderPts = null;
  if (P.leader) {
    const top = [fork[0] + lean[0] * P.height * 0.5, P.height * P.leaderTop, fork[2] + lean[2] * P.height * 0.5];
    leaderPts = curve(fork, UP, norm(sub(top, fork)), len3(sub(top, fork)), 5, P.wobble * 0.8, rnd);
    const radii = leaderPts.map((_, k) => R0 * 0.75 * (1 - 0.85 * k / 5));
    D.tubes.push({ pts: leaderPts, radii, sides: Math.max(5, P.trunkSides - 2), midSides: 3, bark: P.bark, rgb: P.barkRGB, mid: true });
    tips.push({ p: leaderPts[5], r: P.clumpR * 0.9 });
  }

  // ---- limbs --------------------------------------------------------------
  const phase = rnd() * Math.PI * 2;
  for (let i = 0; i < P.limbs; i++) {
    const az = phase + (i / P.limbs) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
    const el = P.limbElev + (rnd() - 0.5) * 0.35;
    const L = P.limbLen * (0.8 + rnd() * 0.4);
    const t = P.limbStart + (i / P.limbs) * (1 - P.limbStart) * 0.85 + rnd() * 0.05;
    if (leaderPts) {
      // Birch and beech carry their limbs up a central leader, and the higher
      // ones are shorter: a crown, not a column.
      const k = Math.min(4, Math.floor(t * 5)), f = t * 5 - k;
      const base = add(mul(leaderPts[k], 1 - f), mul(leaderPts[k + 1], f));
      limbs.push({ az, el, L: L * (1 - 0.45 * t), base, baseR: R0 * 0.6 * (1 - 0.8 * t) });
    } else {
      // Oak splits at the fork.
      limbs.push({ az, el, L, base: fork, baseR: R0 * 0.62 });
    }
  }
  for (const lb of limbs) {
    const d0 = norm([Math.cos(lb.el) * Math.cos(lb.az), Math.sin(lb.el), Math.cos(lb.el) * Math.sin(lb.az)]);
    const d1 = norm([d0[0] * P.limbSpread, d0[1] + P.limbCurl, d0[2] * P.limbSpread]);
    const pts = curve(lb.base, d0, d1, lb.L, 4, P.wobble, rnd);
    const radii = pts.map((_, k) => Math.max(0.018, lb.baseR * (1 - 0.82 * k / 4)));
    D.tubes.push({ pts, radii, sides: P.limbSides, midSides: 3, bark: P.bark, rgb: P.barkRGB, mid: true });
    tips.push({ p: pts[4], r: P.clumpR * (0.9 + rnd() * 0.3) });
    // A mid-limb clump, pushed outward and up so the crown is not hollow.
    const midP = add(pts[2], add(mul(norm([d0[0], 0, d0[2]]), P.clumpR * 0.35), [0, P.clumpR * 0.3, 0]));
    tips.push({ p: midP, r: P.clumpR * (0.75 + rnd() * 0.2) });
    // Secondary branches off the outer half.
    for (let j = 0; j < P.secondary; j++) {
      const k = 2 + Math.floor(rnd() * 2);
      const sAz = lb.az + (j % 2 === 0 ? 1 : -1) * (0.7 + rnd() * 0.5);
      const sd0 = norm([Math.cos(sAz) * 0.8, 0.45 + rnd() * 0.3, Math.sin(sAz) * 0.8]);
      const sd1 = norm(add(sd0, [0, 0.5, 0]));
      const sL = lb.L * (0.42 + rnd() * 0.2);
      const sp = curve(pts[k], sd0, sd1, sL, 2, P.wobble * 0.5, rnd);
      const sr = sp.map((_, q) => Math.max(0.012, radii[k] * 0.6 * (1 - 0.8 * q / 2)));
      D.tubes.push({ pts: sp, radii: sr, sides: 4, midSides: 0, bark: P.bark, rgb: P.barkRGB, mid: false });
      tips.push({ p: sp[2], r: P.clumpR * (0.75 + rnd() * 0.25) });
    }
  }

  // ---- crown frame --------------------------------------------------------
  let cx = 0, cy = 0, cz = 0;
  for (const t of tips) { cx += t.p[0]; cy += t.p[1]; cz += t.p[2]; }
  cx /= tips.length; cy /= tips.length; cz /= tips.length;
  let rh = 0.5, top = 0, bottom = Infinity;
  for (const t of tips) {
    rh = Math.max(rh, Math.hypot(t.p[0] - cx, t.p[2] - cz) + t.r);
    top = Math.max(top, t.p[1] + t.r);
    bottom = Math.min(bottom, t.p[1] - t.r);
  }
  const rv = Math.max(0.5, (top - bottom) * 0.5);
  const C = [cx, (top + bottom) * 0.5, cz];

  // ---- cards --------------------------------------------------------------
  for (const t of tips) {
    const n = Math.round(P.cardsPerClump * (t.r / P.clumpR) * (0.85 + rnd() * 0.3));
    for (let j = 0; j < n; j++) {
      const dir = norm(add(randUnit(rnd), [0, P.upBias, 0]));
      const dist = t.r * (0.30 + 0.70 * Math.sqrt(rnd()));
      const p = add(t.p, mul(dir, dist));
      const outC = norm(sub(p, C));
      const a = norm(add(add(dir, mul(outC, 0.6)), mul(randUnit(rnd), 0.45)));
      const s = perp(a, rnd);
      const L = P.cardLen * (0.8 + rnd() * 0.4);
      const W = L * (0.85 + rnd() * 0.2);
      // The spray's stem is at the card's v = 0, so the card is shifted out
      // along its own axis: stems toward the branch, leaves toward the sky.
      const c = add(p, mul(a, L * 0.25));
      const rank = rnd();
      D.cards.push(flatCard(c, a, s, L, W, P.cell, P.leafRGB, (q) => {
        const e = [(q[0] - C[0]) / rh, (q[1] - C[1]) / rv, (q[2] - C[2]) / rh];
        const rho = len3(e);
        const k = sub(q, t.p);
        const nrm = norm(add(add(mul(norm(e), 0.62), mul(norm(k), 0.55)), [0, 0.22, 0]));
        const ao = lerp(P.aoCore, 1.0, smoothstep(0.15, 1.0, rho))
                 * lerp(P.aoLow, 1.0, clamp((q[1] - bottom) / (top - bottom), 0, 1))
                 * lerp(0.80, 1.0, clamp(len3(k) / t.r, 0, 1));
        return [nrm, ao];
      }, rank < P.midKeep, 1 / Math.sqrt(P.midKeep)));
    }
  }

  D.height = top;
  D.spread = rh;
  D.crown = { C, rh, rv, bottom, top };
  return D;
}

/** Spruce and fir: a straight stem and whorls of folded, drooping fronds. */
function conifer(rnd, P) {
  const D = makeDesc('conifer');
  D.sink = P.sink;
  const H = P.height;
  const nT = 6;
  const pts = [], radii = [];
  const lean = [(rnd() - 0.5) * P.lean, 0, (rnd() - 0.5) * P.lean];
  for (let k = 0; k <= nT; k++) {
    const t = k / nT;
    const y = -P.sink + (H + P.sink) * t;
    pts.push([lean[0] * y + (k > 0 && k < nT ? (rnd() - 0.5) * 0.08 : 0), y,
              lean[2] * y + (k > 0 && k < nT ? (rnd() - 0.5) * 0.08 : 0)]);
    radii.push(Math.max(0.02, P.trunkR * (1 + 0.5 * smoothstep(0.08, 0, t)) * (1 - 0.94 * t)));
  }
  D.tubes.push({ pts, radii, sides: 7, midSides: 5, bark: 0, rgb: P.barkRGB, mid: true });
  const stemAt = (y) => {
    const t = clamp((y + P.sink) / (H + P.sink), 0, 1);
    return [lean[0] * y, y, lean[2] * y, Math.max(0.02, P.trunkR * (1 - 0.94 * t))];
  };

  const span = H - P.crownBase;
  const nW = P.whorls;
  let az = rnd() * Math.PI * 2;
  let spread = 0;
  for (let w = 0; w < nW; w++) {
    const f = w / (nW - 1);                     // 0 at the bottom whorl
    const y = P.crownBase + span * Math.pow(f, 0.92) * 0.97 + (rnd() - 0.5) * span / nW * 0.3;
    const rel = (H - y) / span;                 // 1 at the base, 0 at the tip
    const Lw = P.minLen + (P.maxLen - P.minLen) * Math.pow(clamp(rel, 0, 1), P.profile);
    const m = w > nW - 3 ? Math.max(3, P.perWhorl - 2) : P.perWhorl;
    const s0 = stemAt(y);
    az += 2.39996;                               // golden angle, whorl to whorl
    for (let b = 0; b < m; b++) {
      const a = az + (b / m) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
      const L = Lw * (0.82 + rnd() * 0.3);
      const d = [Math.cos(a), 0, Math.sin(a)];
      const base = add([s0[0], s0[1], s0[2]], mul(d, s0[3] * 0.8));
      const droop = P.droop * lerp(1.25, 0.35, 1 - rel) * (0.8 + rnd() * 0.4);
      const rise = P.rise * (0.8 + rnd() * 0.4);
      const W = Math.max(P.minWidth, L * P.widthK);
      const fold = P.fold * (0.8 + rnd() * 0.4);
      const segs = L > 1.3 ? 2 : 1;
      const rank = rnd();
      spread = Math.max(spread, L);
      D.cards.push(frondCard(base, d, L, W, rise, droop, fold, segs, P.cell, P.leafRGB, (q) => {
        const r = Math.hypot(q[0] - s0[0], q[2] - s0[2]);
        const radial = norm([q[0] - s0[0], 0, q[2] - s0[2]]);
        const nrm = norm(add(mul(radial, 0.85), [0, 0.8, 0]));
        const ao = lerp(P.aoCore, 1.0, smoothstep(0.05, 0.9, r / Math.max(0.5, Lw)))
                 * lerp(P.aoLow, 1.0, clamp(1 - rel, 0, 1));
        return [nrm, ao];
      }, (w % 2 === 0 && b % 3 !== 2) || w >= nW - 2, [1.1, 1.75]));
    }
  }
  // The leader: two small fronds standing straight up, so the tip is a spire.
  const tip = stemAt(H);
  for (let k = 0; k < 2; k++) {
    const a = rnd() * Math.PI * 2;
    const d = norm([Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25]);
    const s = norm(cross(d, [Math.cos(a + 1.57), 0, Math.sin(a + 1.57)]));
    const L = P.minLen * 1.4;
    D.cards.push(flatCard(add([tip[0], H - L * 0.75, tip[2]], mul(d, L * 0.5)), d, s, L, L * 0.5, P.cell, P.leafRGB,
      () => [[0, 1, 0], 1.0], true, 1));
  }
  D.height = H;
  D.spread = spread;
  D.crown = { C: [0, P.crownBase + span * 0.4, 0], rh: spread, rv: span * 0.5, bottom: P.crownBase, top: H };
  return D;
}

/** Scots pine: a tall bare stem and a flat-topped crown of needle brushes. */
function pine(rnd, P) {
  const D = makeDesc('pine');
  D.sink = P.sink;
  const H = P.height;
  const lean = [(rnd() - 0.5) * P.lean, 0, (rnd() - 0.5) * P.lean];
  const pts = [], radii = [];
  const nT = 6;
  // Pines kink: the stem steps sideways once or twice on its way up.
  let kx = 0, kz = 0;
  for (let k = 0; k <= nT; k++) {
    const t = k / nT;
    const y = -P.sink + (H * 0.94 + P.sink) * t;
    if (k === 3 || k === 5) { kx += (rnd() - 0.5) * 0.5; kz += (rnd() - 0.5) * 0.5; }
    pts.push([lean[0] * y + kx, y, lean[2] * y + kz]);
    radii.push(Math.max(0.03, P.trunkR * (1 + 0.4 * smoothstep(0.08, 0, t)) * (1 - 0.8 * t)));
  }
  D.tubes.push({ pts, radii, sides: 7, midSides: 5, bark: 0, rgb: P.barkRGB, mid: true, upperRGB: P.upperBarkRGB });
  const stemAt = (y) => {
    const t = clamp((y + P.sink) / (H * 0.94 + P.sink), 0, 1);
    const k = Math.min(nT - 1, Math.floor(t * nT)), f = t * nT - k;
    return add(mul(pts[k], 1 - f), mul(pts[k + 1], f));
  };
  const tips = [];
  const phase = rnd() * Math.PI * 2;
  for (let i = 0; i < P.limbs; i++) {
    const t = i / (P.limbs - 1);
    const y = lerp(P.crownBase, H * 0.9, t);
    const base = stemAt(y);
    const az = phase + i * 2.39996 + (rnd() - 0.5) * 0.4;
    const el = lerp(0.12, 0.55, t) + (rnd() - 0.5) * 0.2;
    const L = P.limbLen * lerp(1.0, 0.45, t) * (0.8 + rnd() * 0.4);
    const d0 = norm([Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
    const d1 = norm(add(d0, [0, 0.35, 0]));
    const lp = curve(base, d0, d1, L, 3, 0.15, rnd);
    D.tubes.push({ pts: lp, radii: lp.map((_, k) => Math.max(0.015, P.trunkR * 0.35 * (1 - 0.8 * k / 3))),
      sides: 5, midSides: 0, bark: 0, rgb: P.upperBarkRGB, mid: false });
    tips.push({ p: add(lp[3], [0, P.clumpR * 0.25, 0]), r: P.clumpR * (0.85 + rnd() * 0.3) });
    tips.push({ p: add(lp[2], [0, P.clumpR * 0.2, 0]), r: P.clumpR * (0.6 + rnd() * 0.2) });
  }
  tips.push({ p: add(stemAt(H * 0.94), [0, 0.2, 0]), r: P.clumpR });
  let cx = 0, cy = 0, cz = 0;
  for (const t of tips) { cx += t.p[0]; cy += t.p[1]; cz += t.p[2]; }
  cx /= tips.length; cy /= tips.length; cz /= tips.length;
  let rh = 0.5, top = 0, bottom = Infinity;
  for (const t of tips) {
    rh = Math.max(rh, Math.hypot(t.p[0] - cx, t.p[2] - cz) + t.r);
    top = Math.max(top, t.p[1] + t.r * 0.7);
    bottom = Math.min(bottom, t.p[1] - t.r);
  }
  const rv = Math.max(0.5, (top - bottom) * 0.5);
  const C = [cx, (top + bottom) * 0.5, cz];
  for (const t of tips) {
    const n = Math.round(P.cardsPerClump * (t.r / P.clumpR));
    for (let j = 0; j < n; j++) {
      // Needle brushes point up and out, and the clump is flattened: pine
      // foliage sits on top of its branches like a cushion.
      const dir = norm(add(randUnit(rnd), [0, 0.9, 0]));
      const p = add(t.p, [dir[0] * t.r * 0.8 * Math.sqrt(rnd()), dir[1] * t.r * 0.35 * rnd(), dir[2] * t.r * 0.8 * Math.sqrt(rnd())]);
      const a = norm(add(add(dir, mul(norm([p[0] - C[0], 0, p[2] - C[2]]), 0.5)), mul(randUnit(rnd), 0.3)));
      const s = perp(a, rnd);
      const L = P.cardLen * (0.8 + rnd() * 0.4);
      const rank = rnd();
      D.cards.push(flatCard(add(p, mul(a, L * 0.2)), a, s, L, L * 0.95, P.cell, P.leafRGB, (q) => {
        const e = [(q[0] - C[0]) / rh, (q[1] - C[1]) / rv, (q[2] - C[2]) / rh];
        const nrm = norm(add(add(mul(norm(e), 0.55), mul(norm(sub(q, t.p)), 0.45)), [0, 0.45, 0]));
        const ao = lerp(P.aoCore, 1.0, smoothstep(0.1, 1.0, len3(e))) * lerp(0.8, 1.0, clamp((q[1] - bottom) / (top - bottom), 0, 1));
        return [nrm, ao];
      }, rank < P.midKeep, 1 / Math.sqrt(P.midKeep)));
    }
  }
  D.height = top;
  D.spread = rh;
  D.crown = { C, rh, rv, bottom, top };
  return D;
}

/**
 * A flat leaf card. `shade(q)` returns [normal, ao] for a corner. `mid` keeps
 * it in the mid LOD, where it is scaled by `midScale` in both directions.
 */
function flatCard(c, a, s, L, W, cell, rgb, shade, mid, midScale) {
  return { type: 'flat', c, a, s, L, W, cell, rgb, shade, mid, midScale };
}

/**
 * A conifer frond: a strip from the stem out along `d`, rising then drooping,
 * folded down either side of its midline so it has thickness from any angle.
 * `midScale` is [length, width] in the mid LOD, where it is also one segment.
 */
function frondCard(base, d, L, W, rise, droop, fold, segs, cell, rgb, shade, mid, midScale) {
  return { type: 'frond', base, d, L, W, rise, droop, fold, segs, cell, rgb, shade, mid, midScale };
}

// ===========================================================================
// Species table
// ===========================================================================
// Heights and spreads are metres at instance scale 1: a mature tree of the
// kind you pass on a country road. layout.js scales instances 0.6-1.3.

const BARK_OAK = [0.74, 0.68, 0.62];
const BARK_BEECH = [0.95, 0.95, 0.93];
const BARK_BIRCH = [0.90, 0.89, 0.86];
const BARK_SPRUCE = [0.70, 0.60, 0.52];
const BARK_PINE = [0.78, 0.62, 0.50];
const BARK_PINE_UP = [1.15, 0.78, 0.55];

export const SPECIES = [
  // 0 — oak. A short heavy trunk splitting into spreading limbs.
  { name: 'oak', kind: 'tree', build: (r) => broadleaf(r, {
    height: 12, sink: 0.4, trunkR: 0.36, flare: 0.5, forkH: 3.2, lean: 0.06, wobble: 0.30,
    trunkSides: 8, limbSides: 6, leader: false, limbStart: 0, limbs: 5, limbElev: 0.62, limbLen: 5.2, limbSpread: 0.9, limbCurl: 0.55,
    secondary: 2, clumpR: 2.0, cardsPerClump: 9, cardLen: 2.1, upBias: 0.25, cell: CELLS.oak,
    leafRGB: [1, 1, 1], bark: 0, barkRGB: BARK_OAK, aoCore: 0.36, aoLow: 0.62, midKeep: 0.27 }) },
  // 1 — Norway spruce. Tall, narrow, layered, drooping.
  { name: 'spruce', kind: 'tree', build: (r) => conifer(r, {
    height: 17, sink: 0.3, trunkR: 0.30, lean: 0.03, crownBase: 1.2, whorls: 20, perWhorl: 6,
    maxLen: 3.1, minLen: 0.5, profile: 0.95, widthK: 0.85, minWidth: 0.6, rise: 0.10, droop: 0.72, fold: 0.95,
    cell: CELLS.spruce, leafRGB: [1, 1, 1], barkRGB: BARK_SPRUCE, aoCore: 0.34, aoLow: 0.60 }) },
  // 2 — birch. Slender, white, a light open crown on a central leader.
  { name: 'birch', kind: 'tree', build: (r) => broadleaf(r, {
    height: 14, sink: 0.3, trunkR: 0.17, flare: 0.3, forkH: 3.5, lean: 0.10, wobble: 0.18,
    trunkSides: 7, limbSides: 5, leader: true, leaderTop: 0.92, limbStart: 0.05, limbs: 7, limbElev: 0.85, limbLen: 3.0,
    limbSpread: 0.8, limbCurl: -0.25, secondary: 1, clumpR: 1.25, cardsPerClump: 8, cardLen: 1.35, upBias: -0.15,
    cell: CELLS.birch, leafRGB: [1, 1, 1], bark: 1, barkRGB: BARK_BIRCH, aoCore: 0.50, aoLow: 0.72, midKeep: 0.28 }) },
  // 3 — Scots pine. A tall bare stem, orange above, and a flat-topped crown.
  { name: 'pine', kind: 'tree', build: (r) => pine(r, {
    height: 16, sink: 0.3, trunkR: 0.28, lean: 0.07, crownBase: 8.6, limbs: 9, limbLen: 3.0, clumpR: 1.7,
    cardsPerClump: 11, cardLen: 1.7, cell: CELLS.pine, leafRGB: [1, 1, 1], barkRGB: BARK_PINE, upperBarkRGB: BARK_PINE_UP,
    aoCore: 0.42, midKeep: 0.30 }) },
  // 4 — beech. Taller than the oak, smooth grey bark, a dense domed crown.
  { name: 'beech', kind: 'tree', build: (r) => broadleaf(r, {
    height: 15, sink: 0.4, trunkR: 0.30, flare: 0.4, forkH: 4.2, lean: 0.04, wobble: 0.2,
    trunkSides: 8, limbSides: 6, leader: true, leaderTop: 0.85, limbStart: 0.0, limbs: 6, limbElev: 0.95, limbLen: 4.4,
    limbSpread: 0.85, limbCurl: 0.35, secondary: 1, clumpR: 2.0, cardsPerClump: 9, cardLen: 2.1, upBias: 0.2,
    cell: CELLS.beech, leafRGB: [1, 1, 1], bark: 1, barkRGB: [0.52, 0.52, 0.50], aoCore: 0.34, aoLow: 0.62, midKeep: 0.27 }) },
  // 5 — silver fir. Denser than the spruce, branches level rather than hanging.
  { name: 'fir', kind: 'tree', build: (r) => conifer(r, {
    height: 13, sink: 0.3, trunkR: 0.26, lean: 0.03, crownBase: 0.8, whorls: 17, perWhorl: 6,
    maxLen: 2.9, minLen: 0.45, profile: 0.92, widthK: 0.9, minWidth: 0.55, rise: 0.20, droop: 0.40, fold: 0.85,
    cell: CELLS.fir, leafRGB: [1, 1, 1], barkRGB: BARK_SPRUCE, aoCore: 0.36, aoLow: 0.62 }) },
  // 6 — a hazel-type shrub: many stems, no trunk, foliage to the ground.
  { name: 'shrub', kind: 'bush', build: (r) => broadleaf(r, {
    height: 2.6, sink: 0.1, trunkR: 0.05, flare: 0, forkH: 0.05, lean: 0.1, wobble: 0.1,
    trunkSides: 4, limbSides: 4, leader: false, limbStart: 0, limbs: 6, limbElev: 1.05, limbLen: 1.6, limbSpread: 1.0, limbCurl: 0.2,
    secondary: 0, clumpR: 0.85, cardsPerClump: 7, cardLen: 1.05, upBias: 0.35, cell: CELLS.shrub,
    leafRGB: [1, 1, 1], bark: 0, barkRGB: BARK_OAK, aoCore: 0.45, aoLow: 0.55, midKeep: 0.4 }) },
  // 7 — a low juniper-type evergreen: fronds from the ground up.
  { name: 'juniper', kind: 'bush', build: (r) => conifer(r, {
    height: 2.2, sink: 0.1, trunkR: 0.06, lean: 0.05, crownBase: 0.05, whorls: 8, perWhorl: 6,
    maxLen: 1.25, minLen: 0.4, profile: 0.6, widthK: 0.85, minWidth: 0.4, rise: 0.95, droop: 0.25, fold: 0.8,
    cell: CELLS.fir, leafRGB: [1, 1, 1], barkRGB: BARK_SPRUCE, aoCore: 0.45, aoLow: 0.6 }) },
];

export const TREE_SPECIES = SPECIES.filter((s) => s.kind === 'tree').length;   // 6
export const BUSH_SPECIES = SPECIES.filter((s) => s.kind === 'bush').length;   // 2

// ===========================================================================
// Meshes
// ===========================================================================

/** Growable typed-array builder for one geometry. */
function makeBuf() {
  return { p: [], n: [], uv: [], c: [], f: [], idx: [], nv: 0 };
}
function vert(B, p, n, u, v, rgb, flutter) {
  B.p.push(p[0], p[1], p[2]); B.n.push(n[0], n[1], n[2]);
  B.uv.push(u, v); B.c.push(rgb[0], rgb[1], rgb[2]); B.f.push(flutter);
  return B.nv++;
}

function cellUV(cell, u, v) {
  const r = cellRect(cell);
  return [(r.x + PAD + u * (CELL - 2 * PAD)) / ATLAS_W, (r.y + PAD + v * (CELL - 2 * PAD)) / ATLAS_H];
}
function barkUV(sub, u, v) {
  const r = cellRect(CELLS.bark);
  const x0 = r.x + sub * (CELL / 2) + 2, w = CELL / 2 - 4;
  return [(x0 + u * w) / ATLAS_W, (r.y + 2 + v * (CELL - 4)) / ATLAS_H];
}

function emitTube(B, t, sides) {
  const pts = t.pts, n = pts.length;
  // Parallel-transport frame, so the rings do not twist along a curving limb.
  let d = norm(sub(pts[1], pts[0]));
  let nrm = Math.abs(d[1]) < 0.9 ? norm(cross(d, UP)) : norm(cross(d, [1, 0, 0]));
  let total = 0;
  for (let k = 1; k < n; k++) total += len3(sub(pts[k], pts[k - 1]));
  let acc = 0;
  const ring0 = B.nv;
  for (let k = 0; k < n; k++) {
    if (k > 0) acc += len3(sub(pts[k], pts[k - 1]));
    const dk = k < n - 1 ? norm(sub(pts[k + 1], pts[k])) : d;
    const tangent = k === 0 ? d : norm(add(d, dk));
    nrm = norm(sub(nrm, mul(tangent, dot(nrm, tangent))));
    const bin = cross(tangent, nrm);
    d = dk;
    const v = acc / Math.max(1e-3, total);
    const rgb = t.upperRGB ? [lerp(t.rgb[0], t.upperRGB[0], smoothstep(0.35, 0.7, v)),
      lerp(t.rgb[1], t.upperRGB[1], smoothstep(0.35, 0.7, v)), lerp(t.rgb[2], t.upperRGB[2], smoothstep(0.35, 0.7, v))] : t.rgb;
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nn = [nrm[0] * ca + bin[0] * sa, nrm[1] * ca + bin[1] * sa, nrm[2] * ca + bin[2] * sa];
      const p = add(pts[k], mul(nn, t.radii[k]));
      const [u, vv] = barkUV(t.bark, j / sides, v);
      // Ground contact darkens the bottom of a trunk a little.
      const ao = lerp(0.72, 1, smoothstep(-0.3, 1.2, pts[k][1]));
      vert(B, p, nn, u, vv, mul(rgb, ao), 0);
    }
  }
  for (let k = 0; k < n - 1; k++) {
    for (let j = 0; j < sides; j++) {
      const a = ring0 + k * (sides + 1) + j, b = a + 1, c = a + sides + 1, e = c + 1;
      B.idx.push(a, c, b, b, c, e);
    }
  }
}

function emitFlat(B, card, scale) {
  const L = card.L * scale, W = card.W * scale;
  const hl = mul(card.a, L * 0.5), hw = mul(card.s, W * 0.5);
  const corners = [
    [sub(sub(card.c, hw), hl), 0, 0], [sub(add(card.c, hw), hl), 1, 0],
    [add(add(card.c, hw), hl), 1, 1], [add(sub(card.c, hw), hl), 0, 1],
  ];
  const i0 = B.nv;
  for (const [q, u, v] of corners) {
    const [n, ao] = card.shade(q);
    const [uu, vv] = cellUV(card.cell, u, v);
    vert(B, q, n, uu, vv, mul(card.rgb, ao), 0.25 + 0.75 * v);
  }
  B.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
}

function emitFrond(B, card, lod) {
  const mid = lod === 'mid';
  const L = card.L * (mid ? card.midScale[0] : 1);
  const W = card.W * (mid ? card.midScale[1] : 1);
  const segs = mid ? 1 : card.segs;
  const d = card.d;
  const s = norm(cross(UP, d));
  const hw = W * 0.5;
  const cf = Math.cos(card.fold), sf = Math.sin(card.fold);
  const i0 = B.nv;
  for (let k = 0; k <= segs; k++) {
    const u = k / segs;
    // Rise, then droop: y = L(rise*u - droop*u^2), measured along the frond.
    const cy = L * (card.rise * u - card.droop * u * u);
    const c = add(card.base, add(mul(d, L * u * 0.97), [0, cy, 0]));
    const w = hw * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, 0.25 + u)));
    const left = add(c, add(mul(s, w * cf), [0, -w * sf, 0]));
    const right = add(c, add(mul(s, -w * cf), [0, -w * sf, 0]));
    for (const [q, uu] of [[left, 0], [c, 0.5], [right, 1]]) {
      const [n, ao] = card.shade(q);
      const [tu, tv] = cellUV(card.cell, uu, u);
      vert(B, q, n, tu, tv, mul(card.rgb, ao), 0.2 + 0.8 * u);
    }
  }
  for (let k = 0; k < segs; k++) {
    const a = i0 + k * 3;
    // Two quads per segment: left half and right half of the fold.
    B.idx.push(a, a + 1, a + 4, a, a + 4, a + 3);
    B.idx.push(a + 1, a + 2, a + 5, a + 1, a + 5, a + 4);
  }
}

/** Near or mid mesh for a description, as a BufferGeometry. */
export function meshFrom(desc, lod = 'near') {
  const B = makeBuf();
  const mid = lod === 'mid';
  for (const t of desc.tubes) {
    if (mid && !t.mid) continue;
    const sides = mid ? t.midSides : t.sides;
    if (sides < 3) continue;
    if (mid && t.pts.length > 3) {
      // Every other ring: at mid range a limb is a few pixels wide and its
      // curvature is invisible, but its triangle count is not.
      const keep = t.pts.map((_, k) => k).filter((k) => k % 2 === 0 || k === t.pts.length - 1);
      emitTube(B, { ...t, pts: keep.map((k) => t.pts[k]), radii: keep.map((k) => t.radii[k]) }, sides);
    } else emitTube(B, t, sides);
  }
  for (const card of desc.cards) {
    if (mid && !card.mid) continue;
    if (card.type === 'flat') emitFlat(B, card, mid ? card.midScale : 1);
    else emitFrond(B, card, lod);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
  // Wind weights, baked per vertex so one material serves every species:
  //   x  metres of sway per unit of wind. Quadratic in height, because a tree
  //      bends like a cantilever — the trunk base does not move at all and
  //      the crown carries almost all of it. 1.2% of the tree's height at
  //      the top, which is what a stiff breeze does to a real one.
  //   y  leaf flutter, 0 on wood, rising to 1 at the outer edge of a spray.
  const H = Math.max(1, desc.height);
  const wind = new Float32Array(B.nv * 2);
  for (let i = 0; i < B.nv; i++) {
    const y = Math.max(0, B.p[i * 3 + 1]);
    wind[i * 2] = 0.012 * y * y / H;
    wind[i * 2 + 1] = B.f[i];
  }
  g.setAttribute('wind', new THREE.BufferAttribute(wind, 2));
  g.setIndex(B.nv > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Build every species' description. Deterministic in `seed`. */
export function buildSpecies(seed) {
  return SPECIES.map((sp, i) => {
    const d = sp.build(mulberry(seed + 7919 * (i + 1)));
    d.name = sp.name;
    d.kind = sp.kind;
    return d;
  });
}

// ===========================================================================
// Impostors
// ===========================================================================
// Each species' near mesh, rasterised orthographically from two sides (+Z and
// +X) into a cell of a shared atlas: albedo in one texture, canopy normal in
// the other. Supersampled 2x and box-filtered, so the silhouette edge carries
// real coverage for the alpha test to cut against, then dilated like the leaf
// atlas so bilinear filtering never reaches a black texel.
//
// The normal is written in the view's own frame — x right, y up, z toward the
// viewer — which is exactly the frame of a billboard turned to face the camera,
// so the shader rebuilds a world normal from it with two cross products.

export const IMP_CELL_W = 128;
export const IMP_CELL_H = 256;

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * Rasterise every species. `geoms[i]` is species i's near geometry.
 * Returns the two atlases and, per species, the quad its impostor is drawn on.
 */
export function rasterImpostors(descs, geoms, atlas) {
  const S = descs.length;
  const CW = IMP_CELL_W, CH = IMP_CELL_H, SS = 2;
  const W = CW * S, H = CH * 2;
  const albedo = new Float32Array(W * H * 4);   // linear rgb, coverage
  const normal = new Float32Array(W * H * 4);
  const quads = [];
  const sw = CW * SS, sh = CH * SS;
  const cr = new Float32Array(sw * sh), cg = new Float32Array(sw * sh), cb = new Float32Array(sw * sh);
  const nx = new Float32Array(sw * sh), ny = new Float32Array(sw * sh), nz = new Float32Array(sw * sh);
  const zb = new Float32Array(sw * sh);

  for (let s = 0; s < S; s++) {
    const g = geoms[s];
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const UVs = g.attributes.uv.array, C = g.attributes.color.array;
    const I = g.index.array;
    let xr = 0.1, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      xr = Math.max(xr, Math.abs(P[i]), Math.abs(P[i + 2]));
      y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
    }
    xr *= 1.02;
    quads.push({ halfW: xr, y0, y1 });

    // Projected once per view into flat arrays: no closures in the loop, and
    // the loop body only ever sees Float32Array reads. The first version called
    // small helpers per pixel and ran six times slower in the browser than in
    // Node; this one runs at the same speed in both.
    const nv = P.length / 3;
    const PX = new Float32Array(nv), PY = new Float32Array(nv), PZ = new Float32Array(nv);
    const sx = sw / (2 * xr), sy = sh / (y1 - y0);
    for (let view = 0; view < 2; view++) {
      zb.fill(-Infinity);
      for (let i = 0; i < nv; i++) {
        const X = view === 0 ? P[i * 3] : -P[i * 3 + 2];
        PX[i] = (X + xr) * sx;
        PY[i] = (P[i * 3 + 1] - y0) * sy;
        PZ[i] = view === 0 ? P[i * 3 + 2] : P[i * 3];
      }
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        const ax = PX[a], ay = PY[a], bx = PX[b], by = PY[b], cx = PX[c], cy = PY[c];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (area > -1e-9 && area < 1e-9) continue;
        const inv = 1 / area;
        let minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.ceil(Math.max(ax, bx, cx));
        let minY = Math.floor(Math.min(ay, by, cy)), maxY = Math.ceil(Math.max(ay, by, cy));
        if (minX < 0) minX = 0; if (minY < 0) minY = 0;
        if (maxX > sw - 1) maxX = sw - 1; if (maxY > sh - 1) maxY = sh - 1;
        const az = PZ[a], bz = PZ[b], cz = PZ[c];
        const ua = UVs[a * 2], ub = UVs[b * 2], uc = UVs[c * 2];
        const va = UVs[a * 2 + 1], vb = UVs[b * 2 + 1], vc = UVs[c * 2 + 1];
        const a3 = a * 3, b3 = b * 3, c3 = c * 3;
        for (let py = minY; py <= maxY; py++) {
          const qy = py + 0.5;
          for (let px = minX; px <= maxX; px++) {
            const qx = px + 0.5;
            const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) * inv;
            if (w0 < 0) continue;
            const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) * inv;
            if (w1 < 0) continue;
            const w2 = 1 - w0 - w1;
            if (w2 < 0) continue;
            const o = py * sw + px;
            const z = w0 * az + w1 * bz + w2 * cz;
            if (z <= zb[o]) continue;
            let tx = ((w0 * ua + w1 * ub + w2 * uc) * ATLAS_W) | 0;
            let ty = ((w0 * va + w1 * vb + w2 * vc) * ATLAS_H) | 0;
            if (tx < 0) tx = 0; else if (tx > ATLAS_W - 1) tx = ATLAS_W - 1;
            if (ty < 0) ty = 0; else if (ty > ATLAS_H - 1) ty = ATLAS_H - 1;
            const ao = (ty * ATLAS_W + tx) * 4;
            if (atlas[ao + 3] < 128) continue;
            zb[o] = z;
            cr[o] = S2L[atlas[ao]] * (w0 * C[a3] + w1 * C[b3] + w2 * C[c3]);
            cg[o] = S2L[atlas[ao + 1]] * (w0 * C[a3 + 1] + w1 * C[b3 + 1] + w2 * C[c3 + 1]);
            cb[o] = S2L[atlas[ao + 2]] * (w0 * C[a3 + 2] + w1 * C[b3 + 2] + w2 * C[c3 + 2]);
            const mx = w0 * N[a3] + w1 * N[b3] + w2 * N[c3];
            const my = w0 * N[a3 + 1] + w1 * N[b3 + 1] + w2 * N[c3 + 1];
            const mz = w0 * N[a3 + 2] + w1 * N[b3 + 2] + w2 * N[c3 + 2];
            if (view === 0) { nx[o] = mx; ny[o] = my; nz[o] = mz; }
            else { nx[o] = -mz; ny[o] = my; nz[o] = mx; }
          }
        }
      }
      // Box filter down into the atlas cell.
      const ox = s * CW, oy = view * CH;
      for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
          let n = 0, r = 0, gg = 0, bb = 0, vx = 0, vy = 0, vz = 0;
          for (let j = 0; j < SS; j++) {
            for (let i = 0; i < SS; i++) {
              const o = (y * SS + j) * sw + x * SS + i;
              if (zb[o] === -Infinity) continue;
              n++; r += cr[o]; gg += cg[o]; bb += cb[o]; vx += nx[o]; vy += ny[o]; vz += nz[o];
            }
          }
          const d = ((oy + y) * W + ox + x) * 4;
          if (n === 0) continue;
          const l = Math.hypot(vx, vy, vz) || 1;
          albedo[d] = r / n; albedo[d + 1] = gg / n; albedo[d + 2] = bb / n; albedo[d + 3] = n / (SS * SS);
          normal[d] = vx / l; normal[d + 1] = vy / l; normal[d + 2] = vz / l; normal[d + 3] = n / (SS * SS);
        }
      }
    }
  }

  // Dilate both maps into their transparent texels, cell by cell. Written
  // without a single allocation in the loop: the first version built two small
  // arrays per texel per pass, four million of them, and spent more time in
  // the collector than the rasteriser spent drawing.
  const filled = new Uint8Array(W * H);
  const next = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = albedo[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < 8; pass++) {
    next.set(filled);
    for (let y = 0; y < H; y++) {
      const cy = (y / CH) | 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (filled[i]) continue;
        const cx = (x / CW) | 0;
        let n = 0, r = 0, gg = 0, bb = 0, vx = 0, vy = 0, vz = 0;
        for (let k = 0; k < 4; k++) {
          const X2 = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
          const Y2 = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
          if (X2 < 0 || Y2 < 0 || X2 >= W || Y2 >= H) continue;
          if (((X2 / CW) | 0) !== cx || ((Y2 / CH) | 0) !== cy) continue;
          const j = Y2 * W + X2;
          if (!filled[j]) continue;
          n++;
          r += albedo[j * 4]; gg += albedo[j * 4 + 1]; bb += albedo[j * 4 + 2];
          vx += normal[j * 4]; vy += normal[j * 4 + 1]; vz += normal[j * 4 + 2];
        }
        if (!n) continue;
        albedo[i * 4] = r / n; albedo[i * 4 + 1] = gg / n; albedo[i * 4 + 2] = bb / n;
        normal[i * 4] = vx / n; normal[i * 4 + 1] = vy / n; normal[i * 4 + 2] = vz / n;
        next[i] = 1;
      }
    }
    filled.set(next);
  }

  const A = new Uint8Array(W * H * 4), Nn = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    A[o] = clamp(l2s(albedo[o]), 0, 1) * 255 + 0.5;
    A[o + 1] = clamp(l2s(albedo[o + 1]), 0, 1) * 255 + 0.5;
    A[o + 2] = clamp(l2s(albedo[o + 2]), 0, 1) * 255 + 0.5;
    A[o + 3] = clamp(albedo[o + 3], 0, 1) * 255 + 0.5;
    let x = normal[o], y = normal[o + 1], z = normal[o + 2];
    const l = Math.hypot(x, y, z);
    if (l > 1e-4) { x /= l; y /= l; z /= l; } else { x = 0; y = 0.5; z = 0.86; }
    Nn[o] = (x * 0.5 + 0.5) * 255 + 0.5;
    Nn[o + 1] = (y * 0.5 + 0.5) * 255 + 0.5;
    Nn[o + 2] = (z * 0.5 + 0.5) * 255 + 0.5;
    Nn[o + 3] = A[o + 3];
  }
  return { albedo: A, normal: Nn, width: W, height: H, quads };
}
