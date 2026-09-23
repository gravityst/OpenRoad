// Landmarks: the few big, one-of-a-kind shapes each biome is remembered by.
//
// A biome a kid recognises from its colours is a place they pass through; a
// biome with a landmark is a place they drive TO. So Red Canyon has natural
// stone arches spanning its roads and stands of hoodoos, the eroded rock
// chimneys with a hard cap on top, and Sunspray Bay has a lighthouse on a
// headland whose lamp turns at night. Frostpeak Pass has its roadside snow
// poles, which are not a landmark but are the one detail every real
// mountain road has and a white landscape needs to show where the road is.
//
// Everything here is GEOMETRY only, built once from a seeded random stream:
// src/render/props.js instances it (it streams and fades these the way it
// does rocks), and src/world/layout.js decides where each one stands
// (world.landmarks). None of them is solid, the same as every tree and rock
// on the map: a kid who clips an arch's leg is not punished for it.
//
// Coordinates: local X across the road an arch spans, Y up, Z along the
// road. Colours are baked per vertex, in the working (linear) space, so the
// rock material's own grain and cracks sit on top of them.

import * as THREE from 'three';
import { valueNoise3, smoothstep, clamp, lerp } from '../world/noise.js';

const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

// The canyon's beds, the same sequence and the same sRGB colours the terrain
// shader draws its walls with (render/terrain.js, "Red rock"), so an arch
// looks cut from the cliffs around it rather than placed in front of them.
const BED_RED = lin(0.58, 0.30, 0.20);
const BED_ORANGE = lin(0.68, 0.41, 0.26);
const BED_CREAM = lin(0.80, 0.70, 0.59);
const BED_CHOC = lin(0.44, 0.27, 0.19);
const _c = new THREE.Color();

/** The bed colour at a height, into `_c`. `y` in metres; `ph` shifts the beds. */
function bedColour(y, ph) {
  const yb = y + ph;
  const t = smoothstep(0.2, 0.8, Math.sin(yb * 0.37) * 0.5 + 0.5);
  _c.copy(BED_RED).lerp(BED_ORANGE, t);
  const p = yb / 23 - Math.floor(yb / 23);
  const cap = smoothstep(0.70, 0.74, p) * (1 - smoothstep(0.86, 0.90, p));
  _c.lerp(BED_CREAM, cap * 0.85);
  const p2 = yb / 7.3 - Math.floor(yb / 7.3);
  const seam = smoothstep(0.40, 0.46, p2) * (1 - smoothstep(0.54, 0.60, p2));
  _c.lerp(BED_CHOC, seam * 0.5);
  return _c;
}

/**
 * Sweep a rounded-square section along a path and displace it with noise.
 * `path(t)` gives [x, y] in the XY plane for t in 0..1; `size(t)` the
 * section's half-extent across the path (in XY) and along Z. Returns an
 * indexed grid, `segs` along by `sides` around, not closed at the ends (both
 * ends are buried).
 */
function sweep(path, size, segs, sides, seed, amp) {
  const P = [], N = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = path(t);
    const a = path(Math.max(0, t - 0.002)), b = path(Math.min(1, t + 0.002));
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    P.push(p);
    N.push([-ty, tx]);          // the path's normal, in XY
  }
  const pos = new Float32Array((segs + 1) * sides * 3);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const [hn, hz] = size(t);
    const [px, py] = P[i], [nx, ny] = N[i];
    for (let k = 0; k < sides; k++) {
      const f = (k / sides) * Math.PI * 2;
      const cf = Math.cos(f), sf = Math.sin(f);
      // A squircle: rounder than a box, squarer than a tube — sandstone
      // breaks along its beds and joints, and a round arch looks turned.
      const u = Math.sign(cf) * Math.pow(Math.abs(cf), 0.55);
      const v = Math.sign(sf) * Math.pow(Math.abs(sf), 0.55);
      let x = px + nx * u * hn, y = py + ny * u * hn, z = v * hz;
      // Weathering: two octaves of 3D noise pushed along the section's own
      // outward direction, and a groove along every bed, where the softer
      // layers erode back between the harder ones.
      const ox = nx * u, oy = ny * u, oz = v;
      const ol = Math.hypot(ox, oy, oz) || 1;
      const groove = smoothstep(0.75, 1, Math.sin(y * 0.9)) * 0.45;
      const d = (valueNoise3(x * 0.16, y * 0.16, z * 0.16, seed) * 0.8 +
                 valueNoise3(x * 0.5, y * 0.5, z * 0.5, seed + 3) * 0.3) * amp - groove;
      x += (ox / ol) * d; y += (oy / ol) * d; z += (oz / ol) * d;
      const o = (i * sides + k) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    }
  }
  const idx = [];
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * sides + k, b = i * sides + ((k + 1) % sides);
      const c = a + sides, d = b + sides;
      // Wound so the face normal is (along the path) x (round the section),
      // which points OUT: the other way round lit the inside of the rock.
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Bake bed colours, undersides and hollows into a rock geometry's vertices. */
function paintRock(g, ph, capAbove) {
  const p = g.getAttribute('position').array, n = g.getAttribute('normal').array;
  const col = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1];
    bedColour(y, ph);
    if (capAbove !== undefined) _c.lerp(BED_CREAM, smoothstep(capAbove - 0.4, capAbove + 0.2, y) * 0.7);
    // An overhang is lit only by what bounces up off the sand; the foot is
    // darker where the talus and the shade are.
    // (Held gentle, and the beds a shade lighter than the terrain's: an
    // arch is often seen against the light, and at full strength its shaded
    // face read as a black cut-out against the sky.)
    const under = smoothstep(0.1, -0.7, n[i + 1]);
    const k = lerp(1.12, 0.78, under) * lerp(0.82, 1, smoothstep(-1.5, 4, y));
    col[i] = _c.r * k; col[i + 1] = _c.g * k; col[i + 2] = _c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * A natural arch, `span` metres between the insides of its legs and `height`
 * to the top of its opening, legs buried 10 m so it stands on any verge.
 * About 3,500 triangles: it is seen from a kilometre and driven under.
 */
export function archGeometry(rnd, span, height) {
  const seed = (rnd() * 1e6) | 0;
  const lean = (rnd() - 0.5) * 0.12;
  const S = span * 0.5;
  // Leg, arc, leg: 10 m straight down at each end, the opening a
  // semi-superellipse (exponent 0.8 on the sine: steep-sided, flat-crowned).
  const L0 = 0.12, L1 = 0.88;
  const path = (t) => {
    if (t < L0) { const u = t / L0; return [-S - 2.2, -10 + u * 10]; }
    if (t > L1) { const u = (t - L1) / (1 - L1); return [S + 2.2, -u * 10]; }
    const u = (t - L0) / (L1 - L0), th = u * Math.PI;
    const s = Math.pow(Math.sin(th), 0.8);
    return [-Math.cos(th) * (S + 2.2) + lean * s * S, s * (height + 2.4)];
  };
  // Thick at the feet, thinnest at the crown, which is what makes it look
  // as if it has been eroding for a long time and might not for much longer.
  // The span is a slab, deeper than it is thick, and the legs flare into
  // buttresses where they meet the ground, so it reads as a fin of rock
  // with a hole worn through it rather than a pipe bent into a hoop.
  const size = (t) => {
    const u = clamp((t - L0) / (L1 - L0), 0, 1);
    const crown = Math.sin(u * Math.PI);
    const leg = t < L0 || t > L1 ? 1 : 1 - crown;
    const flare = smoothstep(9, 0, path(t)[1]);
    return [lerp(2.7, 5.2, leg) + flare * 3.5, lerp(4.2, 7.5, leg) + flare * 4];
  };
  const g = sweep(path, size, 96, 20, seed, 1.6);
  return paintRock(g, rnd() * 20);
}

/**
 * A hoodoo: a chimney of soft rock under a hard, paler cap it has not yet
 * lost, narrowing to a neck just beneath it. `h` metres tall.
 */
export function hoodooGeometry(rnd, h) {
  const seed = (rnd() * 1e6) | 0;
  const r0 = 1.6 + rnd() * 1.2;
  const bulge = rnd() * 6.28;
  const sides = 14;
  // Uniform rows up the column, then the cap slab as its own rows, so its
  // underside is a real overhang rather than a slope between two rows.
  const capY = h - 1.4;
  const ys = [];
  for (let j = 0; j <= 22; j++) ys.push(-2 + (j / 22) * (capY - 0.05 + 2));
  ys.push(capY, h - 0.8, h - 0.3, h);
  const prof = ys.map((y) => {
    if (y >= capY) return [r0 * 1.22 * (1 - smoothstep(h - 0.5, h + 0.05, y) * 0.8), y];
    // Tapering, with a talus skirt at the foot and beds that bulge and
    // pinch irregularly (two incommensurate waves: one regular wave made a
    // stack of doughnuts).
    const taper = lerp(1.25, 0.74, smoothstep(-2, capY, y)) + smoothstep(2.5, -1, y) * 0.55;
    const beds = 1 + 0.07 * Math.sin(y * 1.05 + bulge) + 0.05 * Math.sin(y * 2.37 + bulge * 2) + 0.04 * Math.sin(y * 4.1 + bulge * 3);
    const neck = 1 - 0.40 * smoothstep(h - 4.2, capY, y);
    return [r0 * taper * beds * neck, y];
  });
  const R = prof.length;
  const pos = new Float32Array(R * sides * 3 + 3);
  for (let j = 0; j < R; j++) {
    const [r, y] = prof[j];
    for (let k = 0; k < sides; k++) {
      const f = (k / sides) * Math.PI * 2;
      let x = Math.cos(f) * r, z = Math.sin(f) * r;
      const d = valueNoise3(x * 0.4, y * 0.25, z * 0.4, seed) * 0.42 * r0 +
                valueNoise3(x, y * 0.6, z, seed + 5) * 0.16 * r0;
      x += Math.cos(f) * d; z += Math.sin(f) * d;
      const o = (j * sides + k) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    }
  }
  // The top is closed with a fan, so the cap reads as a slab from above.
  const c0 = R * sides;
  pos[c0 * 3] = 0; pos[c0 * 3 + 1] = h + 0.35; pos[c0 * 3 + 2] = 0;
  const idx = [];
  for (let j = 0; j < R - 1; j++) {
    for (let k = 0; k < sides; k++) {
      const a = j * sides + k, b = j * sides + ((k + 1) % sides);
      idx.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  for (let k = 0; k < sides; k++) idx.push((R - 1) * sides + ((k + 1) % sides), (R - 1) * sides + k, c0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paintRock(g, rnd() * 20, capY);
}

// ---------------------------------------------------------------------------
// The lighthouse
// ---------------------------------------------------------------------------

/**
 * A lathe whose colour is set per PROFILE POINT, so a band can start and end
 * exactly where the profile says: two points at one height, one of each
 * colour, make a crisp line. `colourAt(y, j)` gets the point's height and
 * index. (Three's lathe lays vertices out segment by segment, each segment a
 * copy of the whole profile.)
 */
function lathe(profile, sides, colourAt) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, sides);
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count, P = pts.length;
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const j = v % P;
    const c = colourAt(profile[j][1], j);
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function box(w, h, d, x, y, z, c) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.deleteAttribute('uv');
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * A 24 m lighthouse: a white tapered tower with two red bands, a black
 * gallery and lantern, on a plinth, with the keeper's cottage beside it.
 * Returns the body and the lamp (drawn with its own glowing material) as
 * separate geometries sharing one origin.
 */
export function lighthouseGeometry(mergeGeometries) {
  const WHITE = lin(0.92, 0.91, 0.87), RED = lin(0.70, 0.13, 0.10), IRON = lin(0.10, 0.11, 0.12);
  const STONE = lin(0.62, 0.60, 0.55), ROOF = lin(0.36, 0.20, 0.16), COTTAGE = lin(0.90, 0.88, 0.82);
  // The shaft tapers 3.3 m -> 2.35 m over 1..20.2 m; two red bands, each
  // edge a doubled profile point so the paint line is sharp.
  const shaftR = (y) => lerp(3.3, 2.35, (y - 1) / 19.2);
  const tp = [[0.01, -3, STONE], [4.4, -3, STONE], [4.4, 0.8, STONE], [3.3, 1.0, WHITE]];
  for (const [y0, y1] of [[6.5, 9], [13.5, 16]]) {
    tp.push([shaftR(y0), y0, WHITE], [shaftR(y0), y0, RED], [shaftR(y1), y1, RED], [shaftR(y1), y1, WHITE]);
  }
  tp.push([2.35, 20.2, WHITE], [0.01, 20.2, WHITE]);
  const tower = lathe(tp.map(([r, y]) => [r, y]), 20, (y, j) => tp[j][2]);
  const gallery = lathe([[0.01, 20.1], [3.3, 20.1], [3.3, 20.5], [0.01, 20.5]], 20, () => IRON);
  const rail = lathe([[3.15, 20.5], [3.2, 21.5], [3.15, 21.5]], 20, () => IRON);
  const roof = lathe([[0.01, 23.3], [2.05, 23.3], [1.2, 24.4], [0.25, 25.2], [0.12, 26.2], [0.01, 26.2]], 16, () => IRON);
  // Glazing bars round the lantern: the lamp shows between them.
  const bars = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    bars.push(box(0.14, 2.8, 0.14, Math.cos(a) * 1.72, 21.9, Math.sin(a) * 1.72, IRON));
  }
  const cottage = [
    box(8, 4.2, 6, 8.5, 2.1 - 1, 0, COTTAGE),
    box(0.9, 1.9, 0.08, 8.5, 0.95 - 1, 3.04, IRON),
  ];
  // A pitched roof: a stretched, rotated box is enough at this size.
  const rf = new THREE.BoxGeometry(8.6, 0.35, 4.2).toNonIndexed();
  rf.deleteAttribute('uv');
  const rf2 = rf.clone();
  rf.rotateX(0.62); rf.translate(8.5, 4.35 - 1, 1.55);
  rf2.rotateX(-0.62); rf2.translate(8.5, 4.35 - 1, -1.55);
  for (const g of [rf, rf2]) {
    const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = ROOF.r; col[i * 3 + 1] = ROOF.g; col[i * 3 + 2] = ROOF.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const parts = [tower, gallery, rail, roof, ...bars, ...cottage, rf, rf2].map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) if (!g.getAttribute('normal')) g.computeVertexNormals();
  const body = mergeGeometries(parts, false);
  body.computeBoundingSphere();
  const lamp = new THREE.CylinderGeometry(1.55, 1.55, 2.6, 16, 1, true);
  lamp.deleteAttribute('uv');
  lamp.translate(0, 21.9, 0);
  lamp.computeBoundingSphere();
  return { body, lamp };
}

/**
 * The lighthouse's beam: two long, thin cones back to back from the
 * lantern, additive, fading along their length. Turned about Y by the
 * caller; drawn only at dusk and night.
 */
export function beamGeometry() {
  const L = 260;
  const g1 = new THREE.ConeGeometry(9, L, 12, 1, true);
  g1.deleteAttribute('normal');
  g1.rotateZ(Math.PI / 2);          // tip at -X... then moved so the tip sits at the lamp
  g1.translate(L / 2, 0, 0);
  const g2 = g1.clone();
  g2.rotateY(Math.PI);
  const n = g1.getAttribute('position').count;
  for (const g of [g1, g2]) {
    const p = g.getAttribute('position').array;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = 1 - clamp(Math.abs(p[i * 3]) / L, 0, 1);
    g.setAttribute('fade', new THREE.BufferAttribute(a, 1));
  }
  const g = new THREE.BufferGeometry();
  const pa = new Float32Array(n * 6), fa = new Float32Array(n * 2);
  pa.set(g1.getAttribute('position').array, 0); pa.set(g2.getAttribute('position').array, n * 3);
  fa.set(g1.getAttribute('fade').array, 0); fa.set(g2.getAttribute('fade').array, n);
  const i1 = Array.from(g1.index.array), i2 = Array.from(g2.index.array).map((v) => v + n);
  g.setAttribute('position', new THREE.BufferAttribute(pa, 3));
  g.setAttribute('fade', new THREE.BufferAttribute(fa, 1));
  g.setIndex(i1.concat(i2));
  g.translate(0, 21.9, 0);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Snow poles
// ---------------------------------------------------------------------------

/**
 * A roadside snow pole: 2.4 m of slim post, orange with black tips, the
 * marker a snowplough and a driver in a white-out steer by. Six-sided and
 * about forty triangles, because there are several hundred along the pass.
 */
export function snowPoleGeometry() {
  const ORANGE = lin(0.93, 0.36, 0.05), BLACK = lin(0.06, 0.06, 0.06);
  const r = (y) => lerp(0.045, 0.04, (y + 0.3) / 2.65);
  const pp = [[0.001, -0.3, ORANGE], [r(-0.3), -0.3, ORANGE], [r(1.55), 1.55, ORANGE], [r(1.55), 1.55, BLACK],
    [r(1.8), 1.8, BLACK], [r(1.8), 1.8, ORANGE], [r(2.1), 2.1, ORANGE], [r(2.1), 2.1, BLACK], [r(2.35), 2.35, BLACK], [0.001, 2.4, BLACK]];
  const g = lathe(pp.map(([a, b]) => [a, b]), 6, (y, j) => pp[j][2]);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
