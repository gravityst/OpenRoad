// The cars themselves, modelled in code.
//
// COORDINATE CONVENTION — the model is built FACING -Z.
//
//   forward = -Z      right = +X      up = +Y
//
// So the nose is at negative z, the boot at positive z, and the front wheels sit
// at z = -wheelbase/2. This matches physics/vehicle.js exactly; getting it
// backwards has cost this project real time before, so every z below is written
// with "front is more negative" in mind and nothing negates it on the way out.
//
// The origin is the CHASSIS REFERENCE, not the ground: local y = 0 is
// spec.rideHeight above the contact patches, which is precisely what car.y is.
// Drop the group at (car.x, car.y, car.z) with rotation.y = car.yaw and it sits
// where the simulation thinks it is. Heights below are written as metres above
// the ground and converted once, in H().
//
// HOW A BODY IS BUILT
//
// Every silhouette comes from three one-dimensional profiles sampled along the
// car's length — the top line (bumper, bonnet, belt, boot), the half width, and
// the bottom line — lofted through a fixed 12-point cross-section. A car is
// almost entirely a swept section, so this gets a real bonnet and roofline out
// of a dozen numbers per style instead of a mesh.
//
// The wheel arches come out of the SAME loft: the bottom line arcs up over each
// axle, which cuts a genuine arch into the flank rather than pasting a decal on
// it. The floor stays low underneath because the section carries its own inner
// vertices, so only the outer flank rises.
//
// Everything a car actually needs to look right and nothing it does not: no
// external assets, no image files. Tyre tread, alloy faces, grille mesh and
// number plates are drawn into offscreen canvases the first time a car is built.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const BODY_STYLES = ['sedan', 'coupe', 'hatch', 'suv', 'pickup', 'van', 'sports'];

// Style table.
//
//   over     front / rear overhang, x wheelbase
//   width    body width / track. Bodywork is always wider than the track.
//   topW     top-surface half width / flank half width (the shoulder tuck)
//   roofW    roof half width / flank half width
//   arch     wheel-arch height above the axle, x wheelRadius
//   h        heights above the ground, x wheelRadius:
//              nose   top of the front bumper face
//              bonnet top of the bonnet where the windscreen meets it
//              belt   door top / shoulder line
//              roof   roof
//              boot   top of the rear deck at the base of the rear glass
//              tail   top of the rear panel
//   cab      [windscreen base, roof front, roof rear, rear glass base],
//            x wheelbase, measured from the midpoint between the axles
//
// The numbers were tuned against the catalogue: a Verrick 340S comes out
// 4.65 x 1.87 x 1.44 m, a Kestrel Lark 3.89 x 1.73 x 1.43, a Norvex Haulier
// 5.41 x 2.00 x 1.98 — which is where those cars ought to land.
const STYLES = {
  sedan: {
    over: [0.32, 0.30], width: 1.16, topW: 0.88, roofW: 0.80, arch: 1.14,
    h: { nose: 1.50, bonnet: 1.82, belt: 1.95, roof: 3.35, boot: 1.92, tail: 1.72 },
    cab: [-0.14, 0.08, 0.38, 0.58], bPillar: true,
  },
  coupe: {
    over: [0.33, 0.33], width: 1.16, topW: 0.86, roofW: 0.78, arch: 1.14,
    h: { nose: 1.30, bonnet: 1.62, belt: 1.80, roof: 3.30, boot: 1.82, tail: 1.58 },
    // No B-pillar and a long fastback rear glass: the two things that read as
    // "coupe" from fifty metres away.
    cab: [-0.06, 0.14, 0.34, 0.70], bPillar: false,
  },
  hatch: {
    over: [0.31, 0.24], width: 1.15, topW: 0.88, roofW: 0.80, arch: 1.14,
    h: { nose: 1.55, bonnet: 1.88, belt: 2.05, roof: 3.85, boot: 2.05, tail: 1.95 },
    cab: [-0.22, 0.00, 0.46, 0.62], bPillar: true,
  },
  suv: {
    over: [0.30, 0.32], width: 1.16, topW: 0.90, roofW: 0.82, arch: 1.22, tyre: 0.66,
    h: { nose: 1.70, bonnet: 2.05, belt: 2.10, roof: 3.70, boot: 2.15, tail: 2.00 },
    cab: [-0.22, -0.02, 0.52, 0.66], bPillar: true, rails: true,
  },
  pickup: {
    over: [0.30, 0.32], width: 1.16, topW: 0.90, roofW: 0.80, arch: 1.22, tyre: 0.66,
    // boot/tail are the BED FLOOR here; the rails are separate geometry.
    h: { nose: 1.72, bonnet: 2.08, belt: 2.25, roof: 3.85, boot: 1.70, tail: 1.62 },
    cab: [-0.14, 0.04, 0.26, 0.36], bPillar: true, bed: 2.30,
  },
  van: {
    over: [0.24, 0.34], width: 1.16, topW: 0.92, roofW: 0.90, arch: 1.14,
    h: { nose: 1.40, bonnet: 1.80, belt: 2.15, roof: 4.30, boot: 2.15, tail: 2.05 },
    // Cab-forward: the windscreen base sits almost over the front axle, and
    // everything behind the B-pillar is one tall box.
    // roofR == cabR: with no C-pillar and no backlight to cover it, any gap
    // between the roof rear and the door glass would be a hole in the cab.
    cab: [-0.44, -0.24, 0.10, 0.10], bPillar: true, cargo: true,
  },
  sports: {
    over: [0.34, 0.36], width: 1.16, topW: 0.84, roofW: 0.74, arch: 1.02, tyre: 0.76,
    h: { nose: 1.02, bonnet: 1.34, belt: 1.95, roof: 2.95, boot: 1.86, tail: 1.62 },
    cab: [-0.16, 0.06, 0.28, 0.66], bPillar: false, spoiler: true, haunch: true,
  },
};

// Lamp lenses: unlit tint, the colour they glow, and how glossy the lens is.
// These are the only materials built per car — every car brakes and indicates
// on its own schedule, so they cannot be shared.
const LAMPS = {
  lHead:  [0xcfd8e2, 0xfff2d6, 0.16],
  lTail:  [0x4b0f11, 0xff2418, 0.22],
  lBrake: [0x5a1113, 0xff2b1c, 0.22],
  lRev:   [0xc8ced6, 0xffffff, 0.20],
  lIndL:  [0x5c3506, 0xff9a12, 0.24],
  lIndR:  [0x5c3506, 0xff9a12, 0.24],
};

const RING = 12;              // vertices per lofted cross-section
const CREASE = 0.60;          // ~34 degrees: keeps the shoulder and arch crisp
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

// Bumped once per car built. The blink phase needs it because traffic is
// spawned from ONE catalogue entry, so a phase derived from the spec alone puts
// every car in the queue in lockstep — which is exactly what it is there to
// prevent. The plate stays seed-only, so a given car keeps its own number.
let instances = 0;

/** Deterministic small hash, so a given car always gets the same plate. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

// ===========================================================================
// Shared kit: textures, static materials and the geometry cache
// ===========================================================================
//
// Geometry depends only on the body style and the four dimensions that shape
// it, so a hundred Kestrel Larks share one set of buffers. The kit is
// reference-counted: the last car to be disposed tears the whole thing down,
// and until then a car being disposed can never pull the geometry out from
// under its neighbours.

const kit = { refs: 0, tex: null, mats: null, geom: new Map() };

/** Canvases only exist in a browser; tools/ measures this module in Node. */
function canvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function texFrom(c, repeatX = 1, repeatY = 1) {
  if (!c) return null;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  return t;
}

function tyreTexture() {
  const c = canvas(128, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#17191c'; g.fillRect(0, 0, 128, 64);
  // Tread blocks around the circumference, plus a pair of circumferential
  // grooves. At speed this is a blur, which is the point of having it at all.
  g.fillStyle = '#101215';
  for (let i = 0; i < 16; i++) {
    const x = i * 8;
    g.fillRect(x, 4, 3, 22);
    g.fillRect(x + 4, 38, 3, 22);
  }
  g.fillStyle = '#0c0d10';
  g.fillRect(0, 28, 128, 3); g.fillRect(0, 33, 128, 3);
  g.fillStyle = '#22252a';
  g.fillRect(0, 0, 128, 3); g.fillRect(0, 61, 128, 3);
  return texFrom(c, 1, 1);
}

function alloyTexture() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const R = 128;
  g.clearRect(0, 0, 256, 256);
  // Behind the spokes: brake disc and a caliper, so the gaps read as depth.
  g.fillStyle = '#1b1d20'; g.beginPath(); g.arc(R, R, 126, 0, TAU); g.fill();
  g.fillStyle = '#3c3f44'; g.beginPath(); g.arc(R, R, 92, 0, TAU); g.fill();
  g.strokeStyle = '#2b2e32'; g.lineWidth = 2;
  for (let r = 34; r < 92; r += 9) { g.beginPath(); g.arc(R, R, r, 0, TAU); g.stroke(); }
  g.fillStyle = '#7a2a26';
  g.beginPath(); g.arc(R, R, 96, -0.55, 0.55); g.arc(R, R, 68, 0.55, -0.55, true); g.fill();

  // Five spokes, lit from the upper left so the wheel has a direction.
  const spokes = 5;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU - Math.PI / 2;
    g.save(); g.translate(R, R); g.rotate(a);
    const grad = g.createLinearGradient(-22, 0, 22, 0);
    grad.addColorStop(0, '#8e949c'); grad.addColorStop(0.42, '#d5dae0'); grad.addColorStop(1, '#767c85');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-20, 8); g.lineTo(-9, 112); g.lineTo(9, 112); g.lineTo(20, 8);
    g.closePath(); g.fill();
    g.restore();
  }
  // Rim lip and hub.
  g.strokeStyle = '#b9c0c8'; g.lineWidth = 14;
  g.beginPath(); g.arc(R, R, 119, 0, TAU); g.stroke();
  g.strokeStyle = '#6e747c'; g.lineWidth = 3;
  g.beginPath(); g.arc(R, R, 111, 0, TAU); g.stroke();
  g.fillStyle = '#aeb4bc'; g.beginPath(); g.arc(R, R, 30, 0, TAU); g.fill();
  g.fillStyle = '#5c6169'; g.beginPath(); g.arc(R, R, 22, 0, TAU); g.fill();
  g.fillStyle = '#8d939b';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    g.beginPath(); g.arc(R + Math.cos(a) * 44, R + Math.sin(a) * 44, 5, 0, TAU); g.fill();
  }
  return texFrom(c);
}

function grilleTexture() {
  const c = canvas(64, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0b0d'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2a2d33';
  for (let y = 2; y < 64; y += 8) g.fillRect(0, y, 64, 4);
  g.fillStyle = '#16181c';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 2, 64);
  return texFrom(c, 3, 1);
}

// Four invented plates in one atlas, picked per car by hash. Every code here
// is made up and matches no real jurisdiction's format.
const PLATE_CODES = ['ORV 418', 'KVN 703', 'TSA 962', 'MDR 275'];

function plateTexture() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const y = i * 64;
    g.fillStyle = '#d9dbd4'; g.fillRect(0, y, 256, 64);
    g.strokeStyle = '#8c8f88'; g.lineWidth = 3; g.strokeRect(4, y + 4, 248, 56);
    g.fillStyle = '#2b3f7a'; g.fillRect(6, y + 6, 26, 52);
    g.fillStyle = '#1a1c1f';
    g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(PLATE_CODES[i], 146, y + 34);
  }
  return texFrom(c);
}

function acquireKit() {
  if (kit.refs === 0) {
    kit.tex = {
      tyre: tyreTexture(), alloy: alloyTexture(),
      grille: grilleTexture(), plate: plateTexture(),
    };
    const T = kit.tex;
    kit.mats = {
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x131820, metalness: 0, roughness: 0.05, transparent: true,
        opacity: 0.46, clearcoat: 1, clearcoatRoughness: 0.03,
        // Double-sided because the cockpit camera sits behind the windscreen,
        // and depthWrite off so glass never hides the cabin behind it.
        side: THREE.DoubleSide, depthWrite: false,
      }),
      glassDark: new THREE.MeshPhysicalMaterial({
        color: 0x0b0e13, metalness: 0, roughness: 0.06, transparent: true,
        opacity: 0.70, clearcoat: 1, clearcoatRoughness: 0.04,
        side: THREE.DoubleSide, depthWrite: false,
      }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x191b1f, roughness: 0.94, metalness: 0, map: T.tyre }),
      rim: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.88, map: T.alloy }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.13, metalness: 1 }),
      plastic: new THREE.MeshStandardMaterial({ color: 0x212429, roughness: 0.74, metalness: 0.04 }),
      grille: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.35, map: T.grille }),
      interior: new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.95, metalness: 0 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x9a7358, roughness: 0.86, metalness: 0 }),
      cloth: new THREE.MeshStandardMaterial({ color: 0x2f3a4a, roughness: 0.98, metalness: 0 }),
      plate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0, map: T.plate }),
    };
  }
  kit.refs++;
  return kit;
}

function releaseKit() {
  if (--kit.refs > 0) return;
  for (const t of Object.values(kit.tex || {})) if (t) t.dispose();
  for (const m of Object.values(kit.mats || {})) if (m) m.dispose();
  for (const entry of kit.geom.values()) {
    for (const g of Object.values(entry.wheel)) if (g) g.dispose();
    for (const b of BUCKETS) if (entry[b]) entry[b].dispose();
  }
  kit.geom.clear();
  kit.tex = null; kit.mats = null; kit.refs = 0;
}

// ===========================================================================
// Geometry helpers
// ===========================================================================
// All of this runs at build time only, once per unique (style, dimensions)
// pair, so it allocates freely. Nothing here is reachable from update().

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0), _fwd = new THREE.Vector3(0, 0, 1);
const ORIGIN = new THREE.Vector3();

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** A box stretched from a to b — pillars, rails, mirror stalks, exhausts. */
function prism(ax, ay, az, bx, by, bz, w, h) {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  _c.subVectors(_b, _a);
  const len = _c.length();
  const g = new THREE.BoxGeometry(w, h, Math.max(0.01, len));
  if (len > 1e-5) {
    // lookAt aims -Z at the target, so target = -direction puts +Z along it.
    const up = Math.abs(_c.y / len) > 0.985 ? _fwd : _up;
    _m4.lookAt(ORIGIN, _c.clone().negate(), up);
    g.applyMatrix4(_m4);
  }
  g.translate((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  return g;
}

/**
 * A quad strip from a list of rows, each row [xL, y, z] mirrored to both sides.
 * Used for glass, which is always a symmetric pair of edges swept along the car.
 */
function strip(rows) {
  const n = rows.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = rows[i];
    pos[i * 6] = -x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x; pos[i * 6 + 4] = y; pos[i * 6 + 5] = z;
    const v = i / (n - 1);
    uv[i * 4] = 0; uv[i * 4 + 1] = v; uv[i * 4 + 2] = 1; uv[i * 4 + 3] = v;
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, d, a, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat quad from four corners; (a, b, c) winds toward the outside. */
function quad3(a, b, c, d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(
    [...a, ...b, ...c, ...a, ...c, ...d]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(
    [0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]), 2));
  g.computeVertexNormals();
  return g;
}

/**
 * One cross-section of a lofted volume, written into `out` as (x, y) pairs.
 *
 * Point order runs up the left flank, across the top, down the right flank and
 * back along the floor. The two floor vertices are what let the outer flank
 * arch over a wheel while the underbody stays low — a plain rounded rectangle
 * cannot express that, and the arches are the whole reason for the loft.
 */
function section(s, out) {
  // The shoulder corners can stand ABOVE the centre of the top surface. That
  // is what a wheel arch crown is, and without it a car whose bonnet sits
  // lower than its front tyres — every mid-engined supercar — has its arches
  // clipped flat and the tyres come through the bodywork.
  const sh = s.top + s.rise;
  const bot = Math.min(s.bot, sh - s.shoulder - 0.03);
  const flank = Math.max(0.01, (sh - bot) * 0.26);
  const hwSide = s.hw * 0.955;
  const inner = Math.min(s.inner, hwSide * 0.92);
  out[0] = -hwSide; out[1] = bot;
  out[2] = -s.hw; out[3] = bot + flank;
  out[4] = -s.hw; out[5] = sh - s.shoulder;
  out[6] = -s.topHw; out[7] = sh;
  out[8] = -s.topHw * 0.45; out[9] = s.top + s.crown;
  out[10] = s.topHw * 0.45; out[11] = s.top + s.crown;
  out[12] = s.topHw; out[13] = sh;
  out[14] = s.hw; out[15] = sh - s.shoulder;
  out[16] = s.hw; out[17] = bot + flank;
  out[18] = hwSide; out[19] = bot;
  out[20] = inner; out[21] = Math.min(s.floor, bot);
  out[22] = -inner; out[23] = Math.min(s.floor, bot);
}

/**
 * Loft a closed shell through the given sections, which must be ordered front
 * to back (increasing z). Caps at both ends, outward normals throughout.
 */
function loft(sections) {
  const n = sections.length;
  const pos = new Float32Array(n * RING * 3);
  const uv = new Float32Array(n * RING * 2);
  const ring = new Float64Array(RING * 2);
  for (let k = 0; k < n; k++) {
    section(sections[k], ring);
    const v = k / (n - 1);
    for (let i = 0; i < RING; i++) {
      const o = (k * RING + i) * 3;
      pos[o] = ring[i * 2]; pos[o + 1] = ring[i * 2 + 1]; pos[o + 2] = sections[k].z;
      const u = (k * RING + i) * 2;
      uv[u] = i / RING; uv[u + 1] = v;
    }
  }
  const idx = [];
  for (let k = 0; k < n - 1; k++) {
    const A = k * RING, B = (k + 1) * RING;
    for (let i = 0; i < RING; i++) {
      const j = (i + 1) % RING;
      idx.push(A + i, B + i, B + j, A + i, B + j, A + j);
    }
  }
  const last = (n - 1) * RING;
  for (let i = 1; i < RING - 1; i++) {
    idx.push(0, i, i + 1);                          // front cap, normal -Z
    idx.push(last, last + i + 1, last + i);         // rear cap, normal +Z
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return toCreasedNormals(g, CREASE);
}

/** Smoothstep-interpolated 1D profile through [z, value] control points. */
function profileAt(cps, z) {
  const n = cps.length;
  if (z <= cps[0][0]) return cps[0][1];
  if (z >= cps[n - 1][0]) return cps[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (z <= cps[i][0]) {
      const a = cps[i - 1], b = cps[i];
      const t = (z - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t * t * (3 - 2 * t);
    }
  }
  return cps[n - 1][1];
}

// ===========================================================================
// Dimensions
// ===========================================================================

/** Everything derived from the spec that the builders below need. */
function dimensions(style, spec) {
  const st = STYLES[style] || STYLES.sedan;
  const wb = spec.wheelbase, tr = spec.track, wr = spec.wheelRadius, rh = spec.rideHeight;
  const fo = wb * st.over[0], ro = wb * st.over[1];
  // Style heights are quoted as multiples of the wheel radius above ride
  // height, and the origin already sits at ride height, so this is just k*wr.
  const H = (k) => k * wr;
  const h = st.h;

  const d = {
    st, wb, tr, wr, rh,
    zFront: -(wb * 0.5 + fo), zRear: wb * 0.5 + ro,
    zAxleF: -wb * 0.5, zAxleR: wb * 0.5,
    hwMax: tr * st.width * 0.5,
    yWheel: wr - rh,
    sill: -rh * 0.10,                           // rocker panel, just below the floor
    floorY: 0,                                  // the underbody IS the chassis datum
    tyreW: wr * (st.tyre ?? 0.62),
    shoulder: wr * 0.16,
    archLen: wr * 1.42, archH: wr * st.arch,
    yNose: H(h.nose), yBonnet: H(h.bonnet), yBelt: H(h.belt),
    yRoof: H(h.roof), yBoot: H(h.boot), yTail: H(h.tail),
    yBed: st.bed ? H(st.bed) : 0,
    cabF: st.cab[0] * wb, roofF: st.cab[1] * wb,
    roofR: st.cab[2] * wb, cabR: st.cab[3] * wb,
  };
  d.hwRoof = d.hwMax * st.roofW;

  // Top line: bumper, bonnet, a belt that rises through the doors, then the
  // rear deck. The control point 6 cm ahead of cabR is what turns a pickup's
  // bed front into a wall instead of a ramp.
  d.top = [
    [d.zFront, d.yNose],
    [d.zFront + fo * 0.55, d.yNose + (d.yBonnet - d.yNose) * 0.82],
    [d.cabF, d.yBonnet],
    [d.cabF + (d.cabR - d.cabF) * 0.35, d.yBelt],
    [d.cabR - 0.06, d.yBelt],
    [d.cabR, d.yBoot],
    [d.zRear, d.yTail],
  ];
  // Half width: narrow at both bumpers, full between the axles.
  d.wide = [
    [d.zFront, 0.80], [d.zFront + fo * 0.55, 0.95],
    [d.zAxleF, st.haunch ? 0.99 : 1.0], [d.zAxleR, st.haunch ? 1.02 : 1.0],
    [d.zRear - ro * 0.55, 0.96], [d.zRear, 0.82],
  ];
  // Where a driver's head goes, and where the cockpit camera wants to sit.
  const seatZ = d.cabF + (d.cabR - d.cabF) * 0.40;
  d.seat = {
    x: -hwAt(d, seatZ) * st.topW * 0.985 * 0.44,
    y: shoulderAt(d, seatZ) - wr * 0.06,
    z: seatZ + wr * 0.05,
  };
  return d;
}

/** Bottom of the flank: the sill, arcing up over each axle into a wheel arch. */
function archAt(d, z) {
  let y = d.sill;
  for (let i = 0; i < 2; i++) {
    const t = (z - (i ? d.zAxleR : d.zAxleF)) / d.archLen;
    if (t > -1 && t < 1) y = Math.max(y, d.yWheel + d.archH * Math.sqrt(1 - t * t));
  }
  return y;
}

/** How much this z is "over a wheel", 0..1 — used to blister the arches. */
function archBlend(d, z) {
  let b = 0;
  for (let i = 0; i < 2; i++) {
    const t = (z - (i ? d.zAxleR : d.zAxleF)) / d.archLen;
    if (t > -1 && t < 1) b = Math.max(b, Math.sqrt(1 - t * t));
  }
  return b;
}

function hwAt(d, z) {
  return d.hwMax * profileAt(d.wide, z) * (1 + 0.035 * archBlend(d, z));
}
function topAt(d, z) { return profileAt(d.top, z); }

/**
 * How far the shoulder line stands proud of the top surface. A little
 * everywhere over a wheel, for muscle, and exactly enough to clear the arch
 * wherever the top line alone would cut into it.
 */
function riseAt(d, z) {
  return Math.max(
    d.wr * 0.035 * archBlend(d, z),
    archAt(d, z) + d.shoulder + 0.045 - topAt(d, z),
  );
}
/** Height of the belt/shoulder corner — what the greenhouse and trim sit on. */
function shoulderAt(d, z) { return topAt(d, z) + riseAt(d, z); }

/** Station list for the main body, dense where the arches need resolving. */
function bodySections(d) {
  const zs = [
    d.zFront, d.zFront + (d.zAxleF - d.zFront) * 0.30, d.zFront + (d.zAxleF - d.zFront) * 0.62,
    d.cabF, d.cabF + 0.09, 0,
    d.cabR - 0.06, d.cabR, d.cabR + 0.09,
    d.zRear - (d.zRear - d.zAxleR) * 0.55, d.zRear,
  ];
  for (const zc of [d.zAxleF, d.zAxleR]) {
    for (const f of [-1.02, -0.62, -0.24, 0.24, 0.62, 1.02]) zs.push(zc + f * d.archLen);
  }
  zs.sort((p, q) => p - q);
  const out = [];
  for (const z of zs) {
    if (z < d.zFront - 1e-6 || z > d.zRear + 1e-6) continue;
    // toCreasedNormals quantises to 1 cm, so sections nearer than 5 cm would
    // smooth into one another anyway. Dropping them keeps the count honest.
    if (out.length && z - out[out.length - 1] < 0.05) continue;
    out.push(z);
  }
  if (out[out.length - 1] < d.zRear - 1e-6) out.push(d.zRear);
  return out.map((z) => ({
    z, hw: hwAt(d, z), topHw: hwAt(d, z) * d.st.topW,
    top: topAt(d, z), rise: riseAt(d, z), bot: archAt(d, z), floor: d.floorY,
    inner: hwAt(d, z) * 0.60, shoulder: d.shoulder, crown: d.wr * 0.045,
  }));
}

/**
 * The upper body: a roof slab for most styles, and for the van the whole
 * cab-roof-into-cargo-box in one sweep — same loft, the bottom line just steps
 * down to the belt behind the B-pillar.
 */
function roofSections(d) {
  const st = d.st, thick = d.wr * 0.22;
  const zEnd = st.cargo ? d.zRear : d.roofR;
  const zs = st.cargo
    ? [d.roofF, d.roofF + 0.14, d.cabR - 0.05, d.cabR + 0.05,
       (d.cabR + d.zRear) * 0.5, d.zRear - 0.16, d.zRear]
    : [d.roofF, d.roofF + 0.12, (d.roofF + d.roofR) * 0.5, d.roofR - 0.12, d.roofR];
  return zs.filter((z, i, arr) => i === 0 || z - arr[i - 1] > 0.04).map((z) => {
    const t = (z - d.roofF) / Math.max(1e-4, zEnd - d.roofF);
    const taper = 0.90 + 0.10 * Math.sin(Math.min(1, t * 3.2) * Math.PI * 0.5);
    const cargo = st.cargo && z > d.cabR;
    const hw = cargo ? d.hwMax * 0.94 * profileAt(d.wide, z) : d.hwRoof * taper;
    const bot = cargo ? shoulderAt(d, z) - 0.02 : d.yRoof - thick;
    return {
      z, hw, topHw: hw * (cargo ? 0.94 : 0.90), top: d.yRoof, rise: 0, bot,
      floor: bot - 0.02, inner: hw * 0.62,
      shoulder: d.wr * (cargo ? 0.14 : 0.07), crown: d.wr * 0.05,
    };
  });
}

// ===========================================================================
// The upper body: pillars, glass and what you can see through it
// ===========================================================================

function greenhouse(d, out, detail) {
  const st = d.st;
  const yB = (z) => shoulderAt(d, z);             // belt line the cabin sits on
  const hwG = (z) => hwAt(d, z) * st.topW * 0.985; // side-glass plane
  const yTop = d.yRoof - d.wr * 0.20;             // glass tops, under the slab
  const hwR = d.hwRoof * 0.90;                    // pillar tops
  const hwRG = d.hwRoof * 0.88;                   // glass tops, just inboard
  const pw = d.wr * 0.20, pt = d.wr * 0.22;
  const { cabF, roofF, roofR, cabR } = d;

  out.paint.push(loft(roofSections(d)));

  for (const s of [-1, 1]) {
    out.paint.push(prism(s * hwG(cabF), yB(cabF), cabF, s * hwR, yTop, roofF, pw, pt));
    if (!st.cargo) out.paint.push(prism(s * hwR, yTop, roofR, s * hwG(cabR), yB(cabR), cabR, pw * 1.15, pt));
    if (st.bPillar) {
      const zB = st.cargo ? cabR : roofF + (roofR - roofF) * 0.44;
      out.paint.push(prism(s * hwG(zB), yB(zB), zB, s * hwR * 0.99, yTop, zB, pw * 0.9, pt));
    }
    // Side glass, one panel per side, with the pillars laid over the top of
    // it. It leans inboard toward the roof — real tumblehome, and it also
    // buries the top edge INSIDE the roof slab. Hanging the glass straight
    // down from the belt line instead leaves a slot between the door top and
    // the roof edge that you can see daylight through.
    const fb = [s * hwG(cabF), yB(cabF), cabF], ft = [s * hwRG, yTop, roofF];
    const rt = [s * hwRG, yTop, roofR], rb = [s * hwG(cabR), yB(cabR), cabR];
    out.glass.push(s > 0 ? quad3(fb, ft, rt, rb) : quad3(rb, rt, ft, fb));
    if (detail === 'high') {
      out.chrome.push(prism(
        s * hwG(cabF) * 1.01, yB(cabF) - 0.012, cabF,
        s * hwG(cabR) * 1.01, yB(cabR) - 0.012, cabR, 0.018, 0.030,
      ));
    }
  }

  // Windscreen, with a middle row so it bows out rather than folding flat.
  const wsMid = 0.5;
  out.glass.push(strip([
    [hwG(cabF) * 0.99, yB(cabF), cabF],
    [(hwG(cabF) + hwR) * 0.5 * 1.01,
      yB(cabF) + (yTop - yB(cabF)) * wsMid, cabF + (roofF - cabF) * wsMid],
    [hwR * 0.99, yTop, roofF],
  ]));

  if (st.cargo) {
    // A van's rear glass sits in the cargo doors, high on a flat back panel.
    const yLo = shoulderAt(d, d.zRear) + d.wr * 0.55, yHi = d.yRoof - d.wr * 0.45, z = d.zRear + 0.01;
    out.glassDark.push(strip([[d.hwMax * 0.62, yHi, z], [d.hwMax * 0.62, yLo, z]]));
  } else {
    out.glassDark.push(strip([
      [hwR * 0.99, yTop, roofR],
      [(hwR + hwG(cabR)) * 0.5 * 1.01,
        yTop + (yB(cabR) - yTop) * 0.5, roofR + (cabR - roofR) * 0.5],
      [hwG(cabR) * 0.99, yB(cabR), cabR],
    ]));
  }
}

/** Seats, dash and a driver, because an empty car looks wrong. */
function cabin(d, out, detail) {
  const seatZ = d.cabF + (d.cabR - d.cabF) * 0.40;
  const yB = shoulderAt(d, seatZ), wr = d.wr;
  const hwG = hwAt(d, seatZ) * d.st.topW * 0.985;
  const driverX = -hwG * 0.44;                 // left-hand drive, by convention

  out.interior.push(box(hwG * 1.7, wr * 0.68, wr * 0.80, 0, yB - wr * 0.30, d.cabF + wr * 0.38));
  for (const x of [driverX, -driverX]) {
    out.cloth.push(box(wr * 1.12, wr * 0.24, wr * 1.05, x, yB - wr * 0.62, seatZ + wr * 0.10));
    out.cloth.push(box(wr * 1.12, wr * 1.15, wr * 0.24, x, yB - wr * 0.05, seatZ + wr * 0.60, -0.16));
    out.interior.push(box(wr * 0.60, wr * 0.34, wr * 0.20, x, yB + wr * 0.55, seatZ + wr * 0.72));
  }

  const yHead = yB + wr * 0.36, torsoZ = seatZ + wr * 0.26;
  out.cloth.push(box(wr * 1.00, wr * 1.25, wr * 0.62, driverX, yB + wr * 0.02, torsoZ, -0.14));
  const head = new THREE.IcosahedronGeometry(wr * 0.30, 0);
  head.scale(1, 1.14, 1.02);
  head.translate(driverX, yHead, torsoZ - wr * 0.05);
  out.skin.push(head);

  if (detail !== 'high') return;
  const wheelZ = d.cabF + wr * 0.66, wheelY = yB - wr * 0.24;
  const rim = new THREE.TorusGeometry(wr * 0.44, wr * 0.055, 3, 10);
  rim.rotateX(Math.PI * 0.5 - 0.42);
  rim.translate(driverX, wheelY, wheelZ);
  out.interior.push(rim);
  for (const s of [-1, 1]) {
    out.cloth.push(prism(
      driverX + s * wr * 0.44, yB + wr * 0.10, torsoZ,
      driverX + s * wr * 0.34, wheelY + wr * 0.14, wheelZ + wr * 0.14,
      wr * 0.24, wr * 0.24,
    ));
  }
}

// ---------------------------------------------------------------------------
// Lamps, bumpers and the rest of the jewellery
// ---------------------------------------------------------------------------

function plateQuad(w, h, y, z, front, row) {
  const g = new THREE.PlaneGeometry(w, h);
  if (front) g.rotateY(Math.PI);
  g.translate(0, y, z);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (1 - (row + 1) / 4) + uv.getY(i) * 0.25);
  uv.needsUpdate = true;
  return g;
}

function details(d, out, detail, plateRow) {
  const st = d.st, wr = d.wr, hw = d.hwMax;
  const zF = d.zFront, zR = d.zRear;
  const yF0 = d.sill + wr * 0.10, yF1 = d.yNose;
  const yR0 = d.sill + wr * 0.10, yR1 = st.bed ? d.yBed : d.yTail;
  const fH = Math.max(0.12, yF1 - yF0), rH = Math.max(0.12, yR1 - yR0);

  // --- front ---------------------------------------------------------------
  out.plastic.push(box(hw * 1.56, fH * 0.34, wr * 0.44, 0, yF0 + fH * 0.16, zF + wr * 0.20));
  out.grille.push(box(hw * 1.22, fH * 0.36, wr * 0.14, 0, yF0 + fH * 0.52, zF + wr * 0.10));
  out.chrome.push(box(hw * 1.30, fH * 0.05, wr * 0.16, 0, yF0 + fH * 0.72, zF + wr * 0.09));
  for (const s of [-1, 1]) {
    // Lamps are centred just behind the nose cap so their lenses sit flush in
    // the bodywork rather than floating in front of it.
    out.lHead.push(box(hw * 0.44, fH * 0.28, wr * 0.40, s * hw * 0.54, yF0 + fH * 0.74, zF + wr * 0.19));
    (s < 0 ? out.lIndL : out.lIndR).push(box(hw * 0.16, fH * 0.13, wr * 0.30, s * hw * 0.90, yF0 + fH * 0.62, zF + wr * 0.24));
  }

  // --- rear ----------------------------------------------------------------
  out.plastic.push(box(hw * 1.56, rH * 0.30, wr * 0.44, 0, yR0 + rH * 0.14, zR - wr * 0.20));
  for (const s of [-1, 1]) {
    out.lTail.push(box(hw * 0.38, rH * 0.24, wr * 0.36, s * hw * 0.58, yR0 + rH * 0.72, zR - wr * 0.17));
    out.lBrake.push(box(hw * 0.40, rH * 0.09, wr * 0.34, s * hw * 0.58, yR0 + rH * 0.80, zR - wr * 0.16));
    out.lRev.push(box(hw * 0.13, rH * 0.10, wr * 0.30, s * hw * 0.34, yR0 + rH * 0.64, zR - wr * 0.20));
    (s < 0 ? out.lIndL : out.lIndR).push(box(hw * 0.14, rH * 0.11, wr * 0.30, s * hw * 0.84, yR0 + rH * 0.64, zR - wr * 0.20));
  }
  // A high-level brake light on the trailing edge of the roof or the boot.
  out.lBrake.push(st.cargo
    ? box(hw * 0.50, wr * 0.10, wr * 0.10, 0, d.yRoof - wr * 0.18, zR + 0.008)
    : box(hw * 0.62, wr * 0.08, wr * 0.10, 0, shoulderAt(d, d.cabR) + wr * 0.10, d.cabR + wr * 0.10));

  if (st.bed) {
    // Bed rails and tailgate. The loft already dropped the deck to the bed
    // floor, so these three boxes are all that is left of a pickup's back end.
    const floor = shoulderAt(d, (d.cabR + zR) * 0.5), mid = (floor + d.yBed) * 0.5;
    const rh2 = d.yBed - floor, z0 = d.cabR + wr * 0.12, z1 = zR - wr * 0.10;
    for (const s of [-1, 1]) {
      out.paint.push(prism(s * hwAt(d, z0) * 0.955, mid, z0, s * hwAt(d, z1) * 0.955, mid, z1, wr * 0.22, rh2));
    }
    out.paint.push(box(hwAt(d, z1) * 1.86, rh2, wr * 0.20, 0, mid, z1));
  }
  if (st.rails) {
    for (const s of [-1, 1]) {
      out.chrome.push(prism(s * d.hwRoof * 0.78, d.yRoof + wr * 0.09, d.roofF + 0.10,
        s * d.hwRoof * 0.78, d.yRoof + wr * 0.09, d.roofR - 0.05, wr * 0.10, wr * 0.10));
    }
  }
  if (st.spoiler) {
    const y = shoulderAt(d, zR - wr * 0.55);
    for (const s of [-1, 1]) out.paint.push(box(wr * 0.14, wr * 0.42, wr * 0.30, s * hw * 0.62, y + wr * 0.21, zR - wr * 0.50));
    out.paint.push(box(hw * 1.68, wr * 0.10, wr * 0.62, 0, y + wr * 0.45, zR - wr * 0.50, -0.10));
  }

  if (detail !== 'high') return;
  for (const s of [-1, 1]) {
    // Mirrors: a stalk off the A-pillar base and a pod on the end of it.
    const z = d.cabF + wr * 0.30, x = hwAt(d, z) * d.st.topW, y = shoulderAt(d, z) + wr * 0.06;
    out.plastic.push(prism(s * x, y, z, s * x * 1.20, y + wr * 0.10, z + wr * 0.06, wr * 0.10, wr * 0.10));
    out.plastic.push(box(wr * 0.20, wr * 0.28, wr * 0.44, s * x * 1.26, y + wr * 0.12, z + wr * 0.06, 0, s * 0.18));
  }
  const pipe = new THREE.CylinderGeometry(wr * 0.13, wr * 0.13, wr * 0.34, 8, 1, true);
  pipe.rotateX(Math.PI * 0.5);
  for (const s of [-1, 1]) {
    const p = pipe.clone();
    p.translate(s * hw * 0.62, d.sill + wr * 0.22, zR - wr * 0.08);
    out.chrome.push(p);
  }
  pipe.dispose();
  const pw = hw * 0.62, ph = pw * 0.23;
  out.plate.push(plateQuad(pw, ph, yF0 + fH * 0.30, zF - 0.012, true, plateRow));
  out.plate.push(plateQuad(pw, ph, yR0 + rH * 0.30, zR + 0.012, false, plateRow));
}

// ===========================================================================
// Wheels
// ===========================================================================

/**
 * Tread, sidewalls and an alloy face. The face is a textured disc rather than
 * modelled spokes: at 12 segments a real spoke set costs three times the
 * triangles and looks worse, and the disc still reads as turning because the
 * texture turns with it.
 */
function wheelGeometry(wr, width, detail) {
  const rimR = wr * 0.66, hx = width * 0.5;
  const tread = new THREE.CylinderGeometry(wr, wr, width, 12, 1, true);
  tread.rotateZ(Math.PI * 0.5);                      // axle along X

  const parts = [tread];
  for (const s of [-1, 1]) {
    const side = new THREE.RingGeometry(rimR, wr, 12, 1);
    side.rotateY(s * Math.PI * 0.5);
    side.translate(s * hx, 0, 0);
    // Pin the sidewall to one dark texel: the ring's square UV layout would
    // otherwise stamp the tread pattern across the sidewall in bands.
    const uv = side.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, 0.5);
    parts.push(side);
  }
  const rimParts = [];
  for (const s of [-1, 1]) {
    const face = new THREE.CircleGeometry(rimR, 12);
    face.rotateY(s * Math.PI * 0.5);
    face.translate(s * (hx + 0.002), 0, 0);
    rimParts.push(face);
  }

  if (detail === 'low') {
    // One draw call per wheel. The rubber samples the transparent corner of the
    // alloy texture, which is black — exactly what a tyre wants to be.
    for (const g of parts) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.02, 0.02);
    }
    return { rubber: null, rim: merge(parts.concat(rimParts)) };
  }
  return { rubber: merge(parts), rim: merge(rimParts) };
}

// ===========================================================================
// Assembly
// ===========================================================================

function merge(list) {
  if (!list.length) return null;
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const joined = mergeGeometries(flat);
  for (const g of new Set(flat.concat(list))) if (g !== joined) g.dispose();
  const indexed = mergeVertices(joined, 1e-4);
  if (indexed !== joined) joined.dispose();
  return indexed;
}

const BUCKETS = [
  'paint', 'glass', 'glassDark', 'chrome', 'plastic', 'grille', 'interior',
  'cloth', 'skin', 'plate', 'lHead', 'lTail', 'lBrake', 'lRev', 'lIndL', 'lIndR',
];
// Draw calls are the budget that matters once there are dozens of cars, so low
// detail folds sixteen body meshes into eight. Anything mapped to null is cut.
const FOLD = {
  glassDark: 'glass', chrome: 'plastic', grille: 'plastic', cloth: 'interior',
  skin: 'interior', plate: null, lBrake: 'lTail', lRev: null,
};

function geometryFor(style, spec, detail, plateRow) {
  const key = `${style}|${spec.wheelbase.toFixed(2)}|${spec.track.toFixed(2)}|` +
    `${spec.wheelRadius.toFixed(2)}|${spec.rideHeight.toFixed(2)}|${detail}|${plateRow}`;
  const hit = kit.geom.get(key);
  if (hit) return hit;

  const d = dimensions(style, spec);
  const out = {};
  for (const b of BUCKETS) out[b] = [];
  out.paint.push(loft(bodySections(d)));
  greenhouse(d, out, detail);
  cabin(d, out, detail);
  details(d, out, detail, plateRow);

  if (detail === 'low') {
    for (const [from, to] of Object.entries(FOLD)) {
      if (to) out[to] = out[to].concat(out[from]);
      else for (const g of out[from]) g.dispose();
      out[from] = [];
    }
  }

  const entry = { d, wheel: wheelGeometry(d.wr, d.tyreW, detail) };
  for (const b of BUCKETS) entry[b] = merge(out[b]);
  kit.geom.set(key, entry);
  return entry;
}

// ===========================================================================
// createCarModel
// ===========================================================================

/**
 * Build one car. `spec` is a physics spec from vehicles/catalog.js — body,
 * colour, wheelbase, track, wheelRadius and rideHeight are all read from it, so
 * the model is always the size of the car being simulated.
 *
 * opts: { colour, detail: 'high' | 'low' }
 */
export function createCarModel(spec = {}, opts = {}) {
  const style = BODY_STYLES.includes(spec.body) ? spec.body : 'sedan';
  const detail = opts.detail === 'low' ? 'low' : 'high';
  const seed = hash(`${spec.id || style}:${spec.name || ''}`);
  const K = acquireKit();
  // Low detail drops the plates, so letting the plate row into the cache key
  // there would stash four identical geometry sets instead of one.
  const geo = geometryFor(style, defaults(spec), detail, detail === 'low' ? 0 : seed % 4);
  const d = geo.d;

  // Paint is per car because every car is a different colour.
  const paint = new THREE.MeshPhysicalMaterial({
    color: opts.colour ?? spec.colour ?? 0xb8bcc0,
    // The clearcoat lobe is deliberately softer than real paint. With no
    // environment map the sun is the ONLY specular source, so a razor-sharp
    // lobe (0.06) collapses into a single hotspot that blows through the bloom
    // threshold and puts a white blob on the boot lid at midday. Spreading the
    // lobe turns that back into a highlight.
    metalness: 0.55, roughness: 0.38, clearcoat: 0.85, clearcoatRoughness: 0.20,
  });
  const lamp = {};
  for (const [name, [tint, glow, rough]] of Object.entries(LAMPS)) {
    lamp[name] = new THREE.MeshStandardMaterial({
      color: tint, emissive: glow, emissiveIntensity: 0, roughness: rough, metalness: 0.05,
    });
  }
  const matFor = (b) => (b === 'paint' ? paint : lamp[b] || K.mats[b]);

  const group = new THREE.Group();
  group.name = `car:${spec.id || style}`;
  const chassis = new THREE.Group();
  group.add(chassis);

  let triangles = 0;
  const shadowy = new Set(['paint', 'chrome', 'plastic', 'grille']);
  for (const b of BUCKETS) {
    const g = geo[b];
    if (!g) continue;
    const mesh = new THREE.Mesh(g, matFor(b));
    mesh.castShadow = shadowy.has(b);
    mesh.name = b;
    chassis.add(mesh);
    triangles += g.index.count / 3;
  }

  // ---- wheels -------------------------------------------------------------
  // Rotation order YXZ so steer (y) is applied OUTSIDE spin (x); with the
  // default XYZ the wheel would corkscrew as it turned.
  const wheels = [];
  const restY = d.yWheel;
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Object3D();
    w.rotation.order = 'YXZ';
    w.name = ['FL', 'FR', 'RL', 'RR'][i];
    w.position.set((i % 2 ? 0.5 : -0.5) * d.tr, restY, (i < 2 ? -0.5 : 0.5) * d.wb);
    for (const part of ['rubber', 'rim']) {
      const g = geo.wheel[part];
      if (!g) continue;
      const m = new THREE.Mesh(g, part === 'rim' ? K.mats.rim : K.mats.rubber);
      m.castShadow = true;
      w.add(m);
      triangles += g.index.count / 3;
    }
    group.add(w);
    wheels.push(w);
  }

  // ---- live state ---------------------------------------------------------
  const state = { brake: 0, head: false, rev: false, ind: 0, dead: false };
  // Golden-ratio stride off the build counter: two cars from the same spec —
  // which is every traffic car — still blink out of step.
  const blinkPhase = ((seed % 977) / 977 + (instances++) * 0.6180339887) % 1;

  function applyTail() {
    const running = state.head ? 0.45 : 0;
    lamp.lTail.emissiveIntensity = Math.max(running, state.brake * 1.5);
    lamp.lBrake.emissiveIntensity = state.brake * 2.6;
  }

  function setSteer(rad) {
    // Yaw grows counter-clockwise, so a RIGHT-positive steer angle is a
    // negative rotation about +Y. Same sign convention as physics/vehicle.js.
    wheels[0].rotation.y = -rad;
    wheels[1].rotation.y = -rad;
  }

  function setWheelSpin(rad) {
    // + = rolling forward. Rolling forward carries the front of the wheel
    // downward, which is a negative rotation about +X.
    if (typeof rad === 'number') {
      for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad;
    } else {
      for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad[i];
    }
  }

  function setSuspension(comps) {
    const lim = d.archH * 0.55;      // never let a wheel punch through its arch
    for (let i = 0; i < 4; i++) wheels[i].position.y = restY + clamp(comps[i], -lim, lim);
  }

  function setBrakeLights(v) { state.brake = clamp(v, 0, 1); applyTail(); }
  function setHeadlights(on) {
    state.head = !!on;
    lamp.lHead.emissiveIntensity = state.head ? 2.4 : 0;
    applyTail();
  }
  function setReverseLights(on) {
    state.rev = !!on;
    lamp.lRev.emissiveIntensity = state.rev ? 2.2 : 0;
  }

  /**
   * dir: -1 left, 1 right, 2 hazard, 0 off. `on` overrides the blink phase if
   * the caller wants to drive it; otherwise each car blinks on its own offset
   * so a queue of traffic does not flash in unison.
   */
  function setIndicator(dir, on = null) {
    state.ind = dir | 0;
    const lit = on === null ? ((now() + blinkPhase) % 0.78) < 0.44 : !!on;
    lamp.lIndL.emissiveIntensity = lit && (state.ind === -1 || state.ind === 2) ? 2.8 : 0;
    lamp.lIndR.emissiveIntensity = lit && (state.ind === 1 || state.ind === 2) ? 2.8 : 0;
  }

  function setPaint(hex) { paint.color.setHex(hex); }

  function dispose() {
    // Idempotent on purpose: the kit is reference counted, so a second
    // dispose() would decrement it a second time and tear the shared geometry,
    // textures and materials out from under every other car on screen.
    if (state.dead) return;
    state.dead = true;
    group.removeFromParent();
    paint.dispose();
    for (const m of Object.values(lamp)) m.dispose();
    // Geometry and the shared textures belong to the kit, which only tears
    // itself down once the last car has let go of it.
    releaseKit();
  }

  setSuspension([0, 0, 0, 0]);

  return {
    group, wheels, triangles,
    setSteer, setWheelSpin, setSuspension,
    setBrakeLights, setHeadlights, setReverseLights, setIndicator,
    setPaint, dispose,
    // Handy for the camera rig and for anything that needs the car's box.
    dims: {
      length: d.zRear - d.zFront, width: d.hwMax * 2, height: d.yRoof + d.rh,
      wheelbase: d.wb, track: d.tr, wheelRadius: d.wr,
      front: d.zFront, rear: d.zRear, seat: d.seat,
    },
  };
}

/** Fill in anything the caller's spec left out, so a bare {body} still works. */
function defaults(spec) {
  return {
    wheelbase: spec.wheelbase ?? 2.68,
    track: spec.track ?? 1.58,
    wheelRadius: spec.wheelRadius ?? 0.34,
    rideHeight: spec.rideHeight ?? 0.28,
  };
}
