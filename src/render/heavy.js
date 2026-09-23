// The working vehicles: the box lorry, the country bus and the farm tractor.
//
// A road with nothing on it but private cars is a car park that moves. What
// makes a country road read as lived-in at a glance is the MIX — a bus pulled
// in at a stop, a delivery lorry you cannot see round, a tractor holding up a
// queue with its beacon turning — and every one of those is a silhouette a kid
// recognises from the back seat. So these three are built for silhouette
// first: the lorry's cab-over face and tall box, the bus's length and glazing
// band, the tractor's enormous rear wheels and glass cab.
//
// COORDINATES are carModel.js's: the model faces -Z, right is +X, and y = 0
// is the chassis reference, spec.rideHeight above the ground. For all three
// the reference is the rear axle's height, so the ground is at y = -rideHeight
// and the rear wheels are centred on y = 0.
//
// THE CONTRACT is createCarModel's, exactly: the same keys, the same setters,
// wheels named FL, FR, RL, RR whose first child is the tyre, lamps in meshes
// named lHead, lTail, lIndL, lIndR, and a contact shadow. carModel.js builds
// the car and routes these three bodies here, so the traffic pool, the fleet's
// far bake and main.js cannot tell which file a vehicle came from. Materials
// and textures come from carModel.js's shared kit, handed in as `deps`, so the
// paint reflects the same sky and the glass is the same glass.
//
// WHAT IT COSTS: 16-18 draw calls near (see createHeavyModel), and the fleet
// draws every one of them beyond its near radius as one instanced mesh per
// model. Geometry is built once per model and shared.
//
// Every name painted on a vehicle here is invented. tools/brandcheck.mjs holds
// that line, lorry, bus and tractor makers included.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const HEAVY_BODIES = ['box', 'bus', 'tractor'];

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Invented operators. The lorries carry trade names from the same world as
// the shopfronts in city.js; the buses carry the places the map already has.
export const LIVERIES = [
  { name: 'KETTLEMARK', sub: 'FREIGHT & PARCELS', band: '#c8402c', ink: '#1c1f24', ground: '#f1efe9' },
  { name: 'PELLINGTON', sub: 'MILLS  ·  FLOUR & FEED', band: '#2f5d8a', ink: '#23364a', ground: '#f4f1e6' },
  { name: 'WENDLEMERE', sub: 'DAIRY', band: '#3e8a4f', ink: '#1f3a27', ground: '#f6f6f2' },
  { name: 'OAKHAVEN', sub: 'TIMBER & FENCING', band: '#8a5a2f', ink: '#3a2716', ground: '#efe8da' },
  { name: 'CASTERWAY', sub: 'REMOVALS', band: '#e0a526', ink: '#2a2a2a', ground: '#f3f1ec' },
  { name: 'BRACKENFORD', sub: 'GROCER  ·  HOME DELIVERY', band: '#7a2e5a', ink: '#2e1a26', ground: '#f5f2ee' },
];
export const BUS_ROUTES = [
  { no: '7', to: 'VALE PARK' }, { no: '12', to: 'GREENMEADOW' }, { no: '3', to: 'FROSTPEAK PASS' },
  { no: '21', to: 'SUNSPRAY BAY' }, { no: '9', to: 'RED CANYON' }, { no: '15', to: 'AMBERLEAF WOODS' },
];

// ---------------------------------------------------------------------------
// Geometry helpers. Build time only; nothing here is reachable per frame.
// ---------------------------------------------------------------------------

const _col = new THREE.Color();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

/** Give a geometry a vertex colour (and the uv a merge needs). */
function tint(g, hex) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  _col.setHex(hex);
  for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}
function at(g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ'));
  g.applyMatrix4(_m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)));
  return g;
}
const box = (w, h, d, hex, x, y, z, rx, ry, rz) => at(tint(new THREE.BoxGeometry(w, h, d), hex), x, y, z, rx, ry, rz);
/** A cylinder lying along X (an axle, a wheel, a pipe laid sideways). */
const cylX = (r, len, seg, hex, x, y, z) => at(tint(new THREE.CylinderGeometry(r, r, len, seg), hex), x, y, z, 0, 0, Math.PI / 2);
const cylY = (r0, r1, len, seg, hex, x, y, z) => at(tint(new THREE.CylinderGeometry(r0, r1, len, seg), hex), x, y, z);
/** A flat quad facing +X (side = 1) or -X at x, spanning z0..z1, y0..y1. */
function sideQuad(side, x, z0, z1, y0, y1, hex, u0 = 0, u1 = 1) {
  const g = new THREE.PlaneGeometry(z1 - z0, y1 - y0);
  at(g, x, (y0 + y1) / 2, (z0 + z1) / 2, 0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
  // The plane's u runs along its local +x, which the yaw turns toward the
  // front on the right flank and toward the back on the left: exactly the
  // way a viewer standing on either side reads, so lettering is the right
  // way round on both, as it is on a real lorry.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, lerp(u0, u1, uv.getX(i)));
  return tint(g, hex);
}
/** A flat quad facing -Z (front = true) or +Z at z, spanning x0..x1, y0..y1. */
function endQuad(front, z, x0, x1, y0, y1, hex) {
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  at(g, (x0 + x1) / 2, (y0 + y1) / 2, z, 0, front ? Math.PI : 0, 0);
  return tint(g, hex);
}

/**
 * A rounded rectangle, counter-clockwise from the bottom middle, as a flat
 * [x, y, ...] ring: width w, bottom y0, top y1, corner radii rb (bottom) and
 * rt (top). A near-duplicate point at each arc end keeps smooth normals from
 * bleeding the curvature across the flat side.
 */
function rrect(w, y0, y1, rb, rt, n = 4) {
  const hw = w / 2, out = [];
  const arc = (cx, cy, r, a0, a1) => {
    const d = (a1 - a0) * 0.03;
    const angles = [a0, a0 + d];
    for (let k = 1; k < n; k++) angles.push(a0 + (a1 - a0) * (k / n));
    angles.push(a1 - d, a1);
    for (const a of angles) out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  };
  out.push(0, y0);
  arc(hw - rb, y0 + rb, rb, -Math.PI / 2, 0);
  arc(hw - rt, y1 - rt, rt, 0, Math.PI / 2);
  out.push(0, y1);
  arc(-hw + rt, y1 - rt, rt, Math.PI / 2, Math.PI);
  arc(-hw + rb, y0 + rb, rb, Math.PI, Math.PI * 1.5);
  return out;
}

/**
 * A loft: `ring(i)` gives station i's ring as [x, y, ...] (same count at every
 * station), `zAt(i, x, y)` its z. Sides smooth-shaded, both ends capped flat.
 */
function loft(count, ring, zAt, hex, { capFront = true, capRear = true } = {}) {
  const r0 = ring(0), n = r0.length / 2;
  const pos = [], uv = [];
  for (let i = 0; i < count; i++) {
    const r = i === 0 ? r0 : ring(i);
    for (let j = 0; j < n; j++) {
      const x = r[j * 2], y = r[j * 2 + 1];
      pos.push(x, y, zAt(i, x, y));
      uv.push(j / n, i / (count - 1));
    }
  }
  const idx = [];
  for (let i = 0; i + 1 < count; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + ((j + 1) % n), d = (i + 1) * n + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const parts = [tint(g, hex)];
  // Caps: a fan from the ring's centroid, with its own flat vertices.
  const cap = (i, facing) => {
    const r = ring(i);
    let cx = 0, cy = 0;
    for (let j = 0; j < n; j++) { cx += r[j * 2]; cy += r[j * 2 + 1]; }
    cx /= n; cy /= n;
    const P = [cx, cy, zAt(i, cx, cy)], N = [0, 0, facing, ], U = [0.5, 0.5], I = [];
    for (let j = 0; j < n; j++) {
      P.push(r[j * 2], r[j * 2 + 1], zAt(i, r[j * 2], r[j * 2 + 1]));
      N.push(0, 0, facing); U.push(0.5 + r[j * 2] * 0.2, 0.5 + r[j * 2 + 1] * 0.2);
    }
    for (let j = 0; j < n; j++) {
      const a = 1 + j, b = 1 + ((j + 1) % n);
      // The ring is counter-clockwise seen from +z: that side keeps the order.
      if (facing > 0) I.push(0, a, b); else I.push(0, b, a);
    }
    const c = new THREE.BufferGeometry();
    c.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    c.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    c.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    c.setIndex(I);
    c.computeVertexNormals();
    parts.push(tint(c, hex));
  };
  if (capFront) cap(0, -1);
  if (capRear) cap(count - 1, 1);
  return parts;
}

/** A tyre (and rim, vertex-coloured into it) spinning about X, centred at 0. */
function tyre(r, w, hex, rimHex, { lugs = 0, lugDepth = 0, rim = 0.62, dual = false } = {}) {
  const parts = [];
  const one = (xo) => {
    const seg = lugs ? lugs * 2 : 24;
    const g = new THREE.CylinderGeometry(r, r, w, seg, lugs ? 3 : 1, true);
    if (lugs) {
      // Chevron lugs: every other facet stands proud, stepping round the
      // tread from each shoulder toward the middle.
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const a = Math.atan2(z, x), across = Math.abs(y) / (w / 2);
        const phase = ((a / TAU) * lugs + across * 0.45) % 1;
        const k = (phase + 1) % 1 < 0.5 ? 1 : 1 - lugDepth / r;
        p.setXYZ(i, x * k, y, z * k);
      }
      g.computeVertexNormals();
    }
    parts.push(at(tint(g, hex), xo, 0, 0, 0, 0, Math.PI / 2));
    // Sidewalls, a touch inside the tread, and the rim disc on the outer face.
    for (const s of [-1, 1]) {
      const side = new THREE.RingGeometry(r * rim, r * (lugs ? 1 - lugDepth / r : 1), seg);
      parts.push(at(tint(side, hex), xo + s * w / 2, 0, 0, 0, s * Math.PI / 2, 0));
    }
    // The outer face: a polished lip, then the rim dishing IN toward a centre
    // plate — a flat disc of paint is what made the first wheels look like
    // stickers. Shade darkens toward the well, which is where the light isn't.
    const lip = new THREE.RingGeometry(r * rim * 0.9, r * rim, 20);
    parts.push(at(tint(lip, rimHex), xo + w / 2 + 0.004, 0, 0, 0, Math.PI / 2, 0));
    const dish = new THREE.CylinderGeometry(r * rim * 0.9, r * rim * 0.5, w * 0.35, 20, 1, true);
    parts.push(at(tint(dish, shadeHex(rimHex, 0.62)), xo + w / 2 - w * 0.175, 0, 0, 0, 0, -Math.PI / 2));
    const plate = new THREE.CircleGeometry(r * rim * 0.5, 16);
    parts.push(at(tint(plate, shadeHex(rimHex, 0.85)), xo + w / 2 - w * 0.35 + 0.004, 0, 0, 0, Math.PI / 2, 0));
    const disc2 = new THREE.CircleGeometry(r * rim, 16);
    parts.push(at(tint(disc2, shadeHex(rimHex, 0.5)), xo - w / 2 - 0.004, 0, 0, 0, -Math.PI / 2, 0));
    // A hub boss and a ring of studs, so the centre reads as bolted on.
    const hx = xo + w / 2 - w * 0.35;
    parts.push(at(tint(new THREE.CylinderGeometry(r * rim * 0.2, r * rim * 0.26, 0.07, 12), 0x3a3c40), hx + 0.035, 0, 0, 0, 0, Math.PI / 2));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      parts.push(at(tint(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 6), 0x9a9ea3), hx + 0.015, Math.cos(a) * r * rim * 0.35, Math.sin(a) * r * rim * 0.35, 0, 0, Math.PI / 2));
    }
  };
  if (dual) { one(-w * 0.52); one(w * 0.52); } else one(0);
  return mergeGeometries(parts.map(norm), false);
}

/** `hex` scaled toward black by k (0..1). */
function shadeHex(hex, k) {
  return ((((hex >> 16) & 255) * k) << 16) | ((((hex >> 8) & 255) * k) << 8) | (((hex & 255) * k) | 0);
}

/** mergeGeometries wants the same attributes everywhere, non-null index. */
function norm(g) {
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}
function merged(list) { return list.length ? mergeGeometries(list.map(norm), false) : null; }

// ---------------------------------------------------------------------------
// The three bodies. Each returns { buckets, wheels: [{x, y, z, r, geo}], dims }
// ---------------------------------------------------------------------------

const BLACK = 0x17181b, RUBBER = 0x1b1c1e, STEEL = 0x5d6166, GREY = 0x8d9197, CHROME = 0xc6cbd1, WHITE = 0xecebe6;

function buckets() {
  return { paint: [], detail: [], glass: [], livery: [], lHead: [], lTail: [], lIndL: [], lIndR: [], lRev: [], lSign: [], lBeacon: [], lMarker: [] };
}

/**
 * The lorry: a 7.5-tonne cab-over with a box body. Cab in the paint colour,
 * the box in its operator's livery, dual rear wheels, a fuel tank, side guards.
 */
function buildBox(spec) {
  const wb = spec.wheelbase, tr = spec.track, wr = spec.wheelRadius, rh = spec.rideHeight;
  const gy = -rh;                                   // the ground
  const zF = -wb / 2 - 1.32, zCab = -wb / 2 + 0.52, zR = wb / 2 + 1.9;
  const W = 2.32, BW = 2.44;
  const B = buckets();
  const cabY0 = gy + 0.52, cabY1 = gy + 2.98;
  // Cab: raked face, rounded in plan at the front corners.
  const rake = 0.14;
  const cabZs = [zF, zF + 0.035, zF + 0.1, zF + 0.2, zCab];
  const plan = [0.93, 0.975, 0.995, 1, 1];
  B.paint.push(...loft(cabZs.length,
    (i) => { const r = rrect(W * plan[i], cabY0, cabY1, 0.05, 0.16); return r; },
    (i, x, y) => cabZs[i] + (i < 4 ? rake * clamp((y - cabY0 - 0.9) / (cabY1 - cabY0 - 0.9), 0, 1) : 0),
    0xffffff));
  const faceZ = (y) => zF + rake * clamp((y - cabY0 - 0.9) / (cabY1 - cabY0 - 0.9), 0, 1) - 0.006;
  // Windscreen: the upper face, leaning back with the rake.
  {
    const y0 = cabY0 + 1.1, y1 = cabY1 - 0.2, hw = W * 0.44;
    const g = new THREE.PlaneGeometry(hw * 2, y1 - y0);
    const len = Math.hypot(y1 - y0, faceZ(y1) - faceZ(y0));
    g.scale(1, len / (y1 - y0), 1);
    const tilt = Math.atan2(faceZ(y1) - faceZ(y0), y1 - y0);
    at(g, 0, (y0 + y1) / 2, (faceZ(y0) + faceZ(y1)) / 2 - 0.004, tilt, Math.PI, 0);
    B.glass.push(tint(g, 0xffffff));
  }
  // Door glass both sides, and the door shut lines as thin dark strips.
  for (const s of [-1, 1]) {
    B.glass.push(sideQuad(s, s * (W / 2 + 0.004), zF + 0.25, zCab - 0.55, cabY0 + 1.12, cabY1 - 0.25, 0xffffff));
    B.detail.push(sideQuad(s, s * (W / 2 + 0.005), zCab - 0.52, zCab - 0.5, cabY0 + 0.15, cabY1 - 0.2, BLACK));
    B.detail.push(sideQuad(s, s * (W / 2 + 0.005), zF + 0.22, zF + 0.24, cabY0 + 0.15, cabY1 - 0.2, BLACK));
    // Steps under the door, and the door handle.
    B.detail.push(box(0.5, 0.05, 0.28, STEEL, s * (W / 2 - 0.12), cabY0 - 0.05, zF + 0.75));
    B.detail.push(box(0.03, 0.04, 0.22, CHROME, s * (W / 2 + 0.02), cabY0 + 1.0, zCab - 0.8));
    // The big mirrors on their arms, the lorry's ears.
    B.detail.push(box(0.36, 0.035, 0.035, BLACK, s * (W / 2 + 0.16), cabY0 + 1.95, zF + 0.3));
    B.detail.push(box(0.035, 0.46, 0.035, BLACK, s * (W / 2 + 0.33), cabY0 + 1.75, zF + 0.3));
    B.detail.push(box(0.06, 0.52, 0.24, BLACK, s * (W / 2 + 0.36), cabY0 + 1.62, zF + 0.32));
  }
  // Grille band, a black band under the screen, the visor over it, the
  // bumper with its lamps set in bezels, and the marker lamps on the roof —
  // the four things that make a cab-over read as a lorry at a glance.
  B.detail.push(endQuad(true, zF - 0.008, -W * 0.4, W * 0.4, cabY0 + 0.42, cabY0 + 0.98, 0x2a2c30));
  for (let k = 0; k < 5; k++) B.detail.push(endQuad(true, zF - 0.011, -W * 0.38, W * 0.38, cabY0 + 0.47 + k * 0.11, cabY0 + 0.5 + k * 0.11, 0x0e0f11));
  B.detail.push(endQuad(true, faceZ(cabY0 + 1.04) - 0.003, -W * 0.46, W * 0.46, cabY0 + 1.01, cabY0 + 1.12, 0x151619));
  B.detail.push(box(W * 0.94, 0.05, 0.34, 0x151619, 0, cabY1 - 0.1, faceZ(cabY1) - 0.15, -0.12, 0, 0));
  B.detail.push(box(W + 0.04, 0.4, 0.18, 0x2b2d31, 0, cabY0 + 0.08, zF - 0.03));
  for (const s of [-1, 1]) {
    B.detail.push(endQuad(true, zF - 0.122, s * 0.74 - 0.27, s * 0.74 + 0.27, cabY0 - 0.04, cabY0 + 0.24, 0x0f1012));
    B.lHead.push(endQuad(true, zF - 0.126, s * 0.66 - 0.17, s * 0.66 + 0.17, cabY0 - 0.01, cabY0 + 0.21, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(true, zF - 0.126, s * 0.91 - 0.07, s * 0.91 + 0.07, cabY0 - 0.01, cabY0 + 0.21, 0xffffff));
    B.lMarker.push(box(0.12, 0.06, 0.06, 0xffffff, s * (W / 2 - 0.2), cabY1 + 0.03, faceZ(cabY1) + 0.2));
  }
  B.lMarker.push(box(0.12, 0.06, 0.06, 0xffffff, 0, cabY1 + 0.03, faceZ(cabY1) + 0.2));
  // Roof deflector: a wedge from the cab roof to the top of the box.
  const boxY0 = gy + 1.1, boxY1 = gy + 3.62;
  {
    const g = new THREE.BufferGeometry();
    const x = W * 0.46, zA = zF + 0.45, zB = zCab - 0.05, yA = cabY1 - 0.02, yB = boxY1 - 0.04;
    const P = [-x, yA, zA, x, yA, zA, x, yB, zB, -x, yB, zB, -x, yA, zB, x, yA, zB];
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex([0, 2, 1, 0, 3, 2, 0, 4, 3, 1, 2, 5, 3, 4, 5, 3, 5, 2]);
    g.computeVertexNormals();
    B.paint.push(tint(g.toNonIndexed(), 0xffffff));
  }
  // The box: a slightly rounded prism, livery panels on both flanks.
  const bz0 = zCab + 0.14;
  B.detail.push(...loft(2, () => rrect(BW, boxY0, boxY1, 0.04, 0.07, 2), (i) => (i === 0 ? bz0 : zR), WHITE));
  for (const s of [-1, 1]) {
    B.livery.push(sideQuad(s, s * (BW / 2 + 0.003), bz0 + 0.08, zR - 0.08, boxY0 + 0.1, boxY1 - 0.1, 0xffffff));
    // Amber side markers along the bottom rail, lit with the running lights.
    for (let k = 0; k < 4; k++) {
      const z = lerp(bz0 + 0.4, zR - 0.4, k / 3);
      B.lMarker.push(sideQuad(s, s * (BW / 2 + 0.006), z - 0.05, z + 0.05, boxY0 + 0.02, boxY0 + 0.08, 0xffffff));
    }
  }
  // Rear doors: frame, hinges, the split and the locking bars.
  B.detail.push(endQuad(false, zR + 0.004, -BW / 2 + 0.03, BW / 2 - 0.03, boxY0 + 0.03, boxY1 - 0.03, 0xdad8d2));
  B.detail.push(endQuad(false, zR + 0.007, -0.012, 0.012, boxY0 + 0.05, boxY1 - 0.05, 0x5a5c60));
  for (const x of [-0.45, 0.45]) B.detail.push(endQuad(false, zR + 0.008, x - 0.018, x + 0.018, boxY0 + 0.1, boxY1 - 0.1, GREY));
  // Chassis: rails, the subframe the box sits on with its cross-bearers,
  // fuel tank, side guards, rear underrun bar, mudguards.
  for (const s of [-1, 1]) B.detail.push(box(0.12, 0.26, zR - zF - 1.1, BLACK, s * 0.46, gy + 0.78, (zF + 1.0 + zR) / 2));
  B.detail.push(box(1.06, 0.2, zR - bz0 - 0.1, 0x222326, 0, boxY0 - 0.1, (bz0 + zR) / 2));
  for (let z = bz0 + 0.25; z < zR - 0.1; z += 0.62) B.detail.push(box(BW - 0.12, 0.09, 0.08, 0x2a2b2e, 0, boxY0 - 0.045, z));
  B.detail.push(cylX(0.24, 0.7, 14, CHROME, 0, 0, 0));
  B.detail[B.detail.length - 1].rotateY(Math.PI / 2);
  B.detail[B.detail.length - 1].translate(-BW / 2 + 0.3, gy + 0.72, 0.2);
  for (const s of [-1, 1]) {
    for (const y of [gy + 0.42, gy + 0.72]) B.detail.push(box(0.04, 0.07, wb - 1.9, GREY, s * (BW / 2 - 0.06), y, 0.1 + (s > 0 ? 0 : 0.35)));
    B.detail.push(box(0.42, 0.04, 1.2, BLACK, s * (tr / 2), wr + 0.1, wb / 2));
  }
  B.detail.push(box(2.1, 0.14, 0.12, 0x2b2d31, 0, gy + 0.5, zR + 0.05));
  // Rear lamps on the underrun bar, a plate between them.
  for (const s of [-1, 1]) {
    B.lTail.push(endQuad(false, zR + 0.115, s * 0.86 - 0.18, s * 0.86 + 0.18, gy + 0.46, gy + 0.56, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(false, zR + 0.115, s * 0.56 - 0.07, s * 0.56 + 0.07, gy + 0.46, gy + 0.56, 0xffffff));
    B.lRev.push(endQuad(false, zR + 0.115, s * 0.36 - 0.05, s * 0.36 + 0.05, gy + 0.46, gy + 0.56, 0xffffff));
  }
  B.detail.push(endQuad(false, zR + 0.115, -0.26, 0.26, gy + 0.62, gy + 0.74, 0xe4e6df));
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const rear = i >= 2;
    wheels.push({
      x: (i % 2 === 0 ? -0.5 : 0.5) * tr, y: 0, z: rear ? wb / 2 : -wb / 2, r: wr,
      geo: tyre(wr, rear ? 0.26 : 0.3, RUBBER, 0xbfc3c8, { dual: rear, rim: 0.6 }),
    });
  }
  return {
    B, wheels, frontX: 0,
    dims: { front: zF - 0.1, rear: zR + 0.12, width: BW, height: 3.62, seatY: cabY0 + 1.3, seatZ: zF + 0.8 },
  };
}

/** The country bus: twelve metres of glazing band, raked screen, dual rears. */
function buildBus(spec) {
  const wb = spec.wheelbase, tr = spec.track, wr = spec.wheelRadius, rh = spec.rideHeight;
  const gy = -rh;
  const zF = -wb / 2 - 2.65, zR = wb / 2 + 3.25, W = 2.55;
  const y0 = gy + 0.32, y1 = gy + 3.18;
  const B = buckets();
  const rakeTop = 0.22, rakeRear = 0.08;
  const archR = wr + 0.1;
  // Stations: rounded ends in plan, arches over both axles.
  const zs = [], plan = [];
  const push = (z, p) => { zs.push(z); plan.push(p); };
  push(zF, 0.9); push(zF + 0.03, 0.955); push(zF + 0.08, 0.985); push(zF + 0.16, 0.998); push(zF + 0.3, 1);
  for (const za of [-wb / 2, wb / 2]) {
    for (let k = 0; k <= 10; k++) push(za - archR * 1.02 + (2.04 * archR * k) / 10, 1);
  }
  push(zR - 0.3, 1); push(zR - 0.16, 0.998); push(zR - 0.08, 0.985); push(zR - 0.03, 0.955); push(zR, 0.9);
  const archY = (z) => {
    for (const za of [-wb / 2, wb / 2]) {
      const d = Math.abs(z - za);
      if (d < archR) return Math.max(y0, Math.sqrt(archR * archR - d * d) * 1.04);
    }
    return y0;
  };
  const faceZ = (i, y) => {
    const t = clamp((y - (gy + 1.0)) / (y1 - gy - 1.0), 0, 1);
    if (i < 4) return zs[i] + rakeTop * t;
    if (i >= zs.length - 4) return zs[i] - rakeRear * t;
    return zs[i];
  };
  B.paint.push(...loft(zs.length, (i) => rrect(W * plan[i], archY(zs[i]), y1, 0.06, 0.34, 4), (i, x, y) => faceZ(i, y), 0xffffff));
  // Front: a deep windscreen following the rake, the destination display
  // above it, a dark lower panel, headlamps and indicators.
  const fz = (y) => faceZ(0, y) - 0.008;
  {
    const ya = gy + 1.05, yb = y1 - 0.42, hw = W * 0.43;
    const len = Math.hypot(yb - ya, fz(yb) - fz(ya));
    const g = new THREE.PlaneGeometry(hw * 2, len);
    at(g, 0, (ya + yb) / 2, (fz(ya) + fz(yb)) / 2, Math.atan2(fz(yb) - fz(ya), yb - ya), Math.PI, 0);
    B.glass.push(tint(g, 0xffffff));
    const sa = y1 - 0.38, sb = y1 - 0.14;
    const s = new THREE.PlaneGeometry(W * 0.62, sb - sa);
    at(s, 0, (sa + sb) / 2, fz((sa + sb) / 2) - 0.004, Math.atan2(fz(sb) - fz(sa), sb - sa), Math.PI, 0);
    B.lSign.push(tint(s, 0xffffff));
  }
  B.detail.push(endQuad(true, zF - 0.004, -W * 0.44, W * 0.44, y0 + 0.08, gy + 0.98, 0x222428));
  for (const s of [-1, 1]) {
    B.lHead.push(endQuad(true, zF - 0.01, s * 0.86 - 0.2, s * 0.86 + 0.2, y0 + 0.2, y0 + 0.36, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(true, zF - 0.01, s * 1.1 - 0.06, s * 1.1 + 0.06, y0 + 0.2, y0 + 0.36, 0xffffff));
    // Rabbit-ear mirrors hung forward of the screen.
    B.detail.push(box(0.035, 0.035, 0.5, BLACK, s * (W / 2 - 0.05), y1 - 0.5, zF - 0.1));
    B.detail.push(box(0.035, 0.5, 0.035, BLACK, s * (W / 2 - 0.05), y1 - 0.74, zF - 0.34));
    B.detail.push(box(0.2, 0.36, 0.06, BLACK, s * (W / 2 - 0.12), y1 - 1.0, zF - 0.36));
  }
  // The glazing band both sides: panes between slim pillars, the entrance
  // doors on the right at the front, the driver's window on the left.
  const gyA = gy + 1.42, gyB = y1 - 0.44;
  const bandZ0 = zF + 0.55, bandZ1 = zR - 0.5;
  const pitch = 1.32;
  for (const s of [-1, 1]) {
    const x = s * (W / 2 + 0.004);
    let z = bandZ0;
    if (s > 0) {
      // Doors: two tall glazed leaves in a dark frame, down to the step.
      const d0 = zF + 0.42, d1 = zF + 1.62;
      B.detail.push(sideQuad(s, x, d0 - 0.05, d1 + 0.05, y0 + 0.06, gyB + 0.04, 0x1a1c1f));
      B.glass.push(sideQuad(s, s * (W / 2 + 0.007), d0, (d0 + d1) / 2 - 0.02, y0 + 0.12, gyB, 0xffffff));
      B.glass.push(sideQuad(s, s * (W / 2 + 0.007), (d0 + d1) / 2 + 0.02, d1, y0 + 0.12, gyB, 0xffffff));
      z = d1 + 0.2;
    }
    while (z + pitch * 0.5 < bandZ1) {
      const z1 = Math.min(z + pitch - 0.1, bandZ1);
      B.glass.push(sideQuad(s, x, z, z1, gyA, gyB, 0xffffff));
      z += pitch;
    }
  }
  // Rear window, the livery stripe, the skirt and a roof pod.
  B.glass.push(endQuad(false, zR - rakeRear * 0.8 + 0.01, -W * 0.36, W * 0.36, gyA + 0.1, gyB - 0.1, 0xffffff));
  for (const s of [-1, 1]) {
    B.livery.push(sideQuad(s, s * (W / 2 + 0.002), zF + 0.3, zR - 0.3, gy + 0.62, gyA - 0.08, 0xffffff, 0, 1));
  }
  B.detail.push(box(1.8, 0.3, 3.2, 0xd5d7da, 0, y1 + 0.13, wb / 2 - 0.4));
  B.detail.push(box(0.7, 0.08, 0.7, 0xb9bcc0, 0, y1 + 0.03, -wb / 2 + 0.6));
  // Rear lamp clusters up the corners, a high brake light, the plate.
  for (const s of [-1, 1]) {
    B.lTail.push(endQuad(false, zR + 0.006, s * 1.08 - 0.1, s * 1.08 + 0.1, y0 + 0.25, y0 + 0.95, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(false, zR + 0.006, s * 1.08 - 0.1, s * 1.08 + 0.1, y0 + 0.98, y0 + 1.16, 0xffffff));
    B.lRev.push(endQuad(false, zR + 0.006, s * 1.08 - 0.1, s * 1.08 + 0.1, y0 + 0.1, y0 + 0.22, 0xffffff));
  }
  B.lTail.push(endQuad(false, zR - rakeRear + 0.02, -0.4, 0.4, y1 - 0.2, y1 - 0.12, 0xffffff));
  B.detail.push(endQuad(false, zR + 0.006, -0.26, 0.26, y0 + 0.3, y0 + 0.42, 0xe4e6df));
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const rear = i >= 2;
    wheels.push({
      x: (i % 2 === 0 ? -0.5 : 0.5) * tr, y: 0, z: rear ? wb / 2 : -wb / 2, r: wr,
      geo: tyre(wr, rear ? 0.27 : 0.3, RUBBER, 0xd0d3d7, { dual: rear, rim: 0.62 }),
    });
  }
  return {
    B, wheels,
    dims: { front: zF - 0.4, rear: zR + 0.01, width: W, height: 3.18 + 0.28, seatY: gy + 1.9, seatZ: zF + 0.9 },
  };
}

/**
 * The tractor: a narrow bonnet over a front axle on small wheels, a glass cab
 * between two enormous lugged rear wheels, mudguards, an exhaust stack and an
 * amber beacon on the roof — which a slow vehicle on a public road runs.
 */
function buildTractor(spec) {
  const wb = spec.wheelbase, tr = spec.track, wr = spec.wheelRadius, rh = spec.rideHeight;
  const gy = -rh;
  const rf = spec.frontWheelRadius ?? wr * 0.6;
  const trF = spec.frontTrack ?? tr * 0.95;
  const zFA = -wb / 2, zRA = wb / 2;
  const yFA = gy + rf;
  const B = buckets();
  // Bonnet: narrow, lofted, sloping down to the grille.
  const bz0 = zFA - 1.05, bz1 = zRA - 1.55;
  const bot = yFA - 0.05, topR = gy + 1.72, topF = gy + 1.52;
  B.paint.push(...loft(6, (i) => {
    const t = i / 5, top = lerp(topF, topR, t);
    return rrect(i === 0 ? 0.78 : 0.86, bot, top, 0.04, 0.14, 3);
  }, (i) => lerp(bz0, bz1, i / 5), 0xffffff));
  // Grille, with slats, and lamps in its top corners.
  B.detail.push(endQuad(true, bz0 - 0.006, -0.34, 0.34, bot + 0.18, topF - 0.12, 0x1c1d20));
  for (let k = 0; k < 7; k++) B.detail.push(endQuad(true, bz0 - 0.01, -0.33 + k * 0.11, -0.31 + k * 0.11, bot + 0.2, topF - 0.14, 0x3a3c40));
  for (const s of [-1, 1]) B.lHead.push(endQuad(true, bz0 - 0.012, s * 0.24 - 0.08, s * 0.24 + 0.08, topF - 0.3, topF - 0.16, 0xffffff));
  // Louvred vents down both sides of the bonnet, and the maker's decal.
  for (const s of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const z = bz0 + 0.25 + k * 0.1;
      B.detail.push(sideQuad(s, s * 0.435, z, z + 0.05, topF - 0.36, topF - 0.12, 0x151619));
    }
    B.livery.push(sideQuad(s, s * 0.434, bz0 + 1.0, bz1 - 0.1, topR - 0.42, topR - 0.18, 0xffffff));
  }
  // The front weights and the axle.
  B.detail.push(box(0.92, 0.44, 0.42, 0x2d2f33, 0, bot - 0.02, bz0 - 0.18));
  for (let k = 0; k < 4; k++) B.detail.push(box(0.94, 0.02, 0.44, 0x1a1b1d, 0, bot - 0.18 + k * 0.11, bz0 - 0.18));
  B.detail.push(cylX(0.07, trF - 0.2, 10, BLACK, 0, yFA, zFA));
  // Front mudguards: arcs over the steered wheels.
  for (const s of [-1, 1]) {
    // CylinderGeometry puts theta = 0 on +z; laid along X, a point at theta
    // sits at height r sin(theta), toward the tail at r cos(theta). So this
    // arc runs from just ahead of the top of the tyre to just behind it.
    const g = new THREE.CylinderGeometry(rf + 0.1, rf + 0.1, 0.34, 14, 1, true, Math.PI * 0.12, Math.PI * 0.76);
    at(g, s * trF / 2, yFA, zFA, 0, 0, Math.PI / 2);
    B.paint.push(tint(g, 0xffffff));
  }
  // Cab: four black posts, glass all round, a white roof with an overhang.
  const cz0 = bz1 - 0.05, cz1 = zRA + 0.35, cw = 1.48;
  const floor = gy + 1.12, roof = gy + 2.82;
  for (const sx of [-1, 1]) {
    for (const zz of [cz0, cz1]) B.detail.push(box(0.07, roof - floor, 0.07, BLACK, sx * cw / 2, (floor + roof) / 2, zz));
  }
  for (const s of [-1, 1]) B.glass.push(sideQuad(s, s * cw / 2, cz0 + 0.04, cz1 - 0.04, floor + 0.05, roof - 0.06, 0xffffff));
  B.glass.push(endQuad(true, cz0, -cw / 2 + 0.04, cw / 2 - 0.04, topR + 0.02, roof - 0.06, 0xffffff));
  B.glass.push(endQuad(false, cz1, -cw / 2 + 0.04, cw / 2 - 0.04, floor + 0.3, roof - 0.06, 0xffffff));
  B.detail.push(box(cw + 0.22, 0.1, cz1 - cz0 + 0.3, WHITE, 0, roof + 0.04, (cz0 + cz1) / 2));
  B.detail.push(box(cw - 0.1, 0.08, cz1 - cz0 - 0.1, 0xd9d9d4, 0, roof + 0.12, (cz0 + cz1) / 2));
  // Inside: a seat and a wheel, seen through all that glass.
  B.detail.push(box(0.5, 0.12, 0.5, 0x2a2b2e, 0, floor + 0.45, cz0 + 0.95));
  B.detail.push(box(0.5, 0.6, 0.1, 0x2a2b2e, 0, floor + 0.78, cz0 + 1.2));
  B.detail.push(at(tint(new THREE.TorusGeometry(0.19, 0.022, 6, 16), BLACK), 0, floor + 0.95, cz0 + 0.45, -1.0, 0, 0));
  B.detail.push(box(0.06, 0.5, 0.06, BLACK, 0, floor + 0.62, cz0 + 0.36, -0.5, 0, 0));
  // Work lamps on the cab roof, the beacon, the exhaust stack.
  for (const s of [-1, 1]) B.lHead.push(endQuad(true, cz0 - 0.16, s * 0.55 - 0.09, s * 0.55 + 0.09, roof - 0.02, roof + 0.08, 0xffffff));
  B.lBeacon.push(cylY(0.09, 0.1, 0.16, 12, 0xffffff, -0.45, roof + 0.25, (cz0 + cz1) / 2 + 0.3));
  B.detail.push(cylY(0.11, 0.11, 0.05, 12, BLACK, -0.45, roof + 0.15, (cz0 + cz1) / 2 + 0.3));
  B.detail.push(cylY(0.055, 0.055, roof + 0.4 - topR, 10, 0x2f3134, 0.3, (topR + roof + 0.4) / 2, cz0 - 0.2));
  B.detail.push(cylY(0.07, 0.06, 0.16, 10, 0x2f3134, 0.3, roof + 0.44, cz0 - 0.2));
  // Rear mudguards: flat-topped arcs over the big wheels, lamps on their tails.
  const ga = wr + 0.1;
  for (const s of [-1, 1]) {
    // From ahead of the top round the back and down past the axle: a rear
    // guard shields the cab from what the lugs throw up.
    const g = new THREE.CylinderGeometry(ga, ga, 0.64, 18, 1, true, -Math.PI * 0.15, Math.PI * 1.05);
    at(g, s * tr / 2, 0, zRA, 0, 0, Math.PI / 2);
    B.paint.push(tint(g, 0xffffff));
    B.lTail.push(endQuad(false, zRA + ga * 0.95 + 0.01, s * tr / 2 - 0.08, s * tr / 2 + 0.08, 0.1, 0.24, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(false, zRA + ga * 0.95 + 0.01, s * (tr / 2 + 0.18) - 0.06, s * (tr / 2 + 0.18) + 0.06, 0.1, 0.24, 0xffffff));
    B[s < 0 ? 'lIndL' : 'lIndR'].push(endQuad(true, cz0 - 0.01, s * (cw / 2) - 0.05, s * (cw / 2) + 0.05, roof - 0.18, roof - 0.08, 0xffffff));
  }
  // The rear axle housing and the three-point linkage.
  B.detail.push(cylX(0.12, tr - 0.3, 12, BLACK, 0, 0, zRA));
  B.detail.push(box(0.9, 0.2, 0.9, 0x2d2f33, 0, gy + 0.9, zRA - 0.2));
  for (const s of [-1, 0, 1]) B.detail.push(box(0.06, 0.06, 0.7, 0x2a2c30, s * 0.35, gy + (s ? 0.62 : 1.05), zRA + 0.55, s ? -0.25 : 0.1, 0, 0));
  const rimHex = spec.rimColour ?? 0xd9b02a;
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const rear = i >= 2;
    const r = rear ? wr : rf;
    wheels.push({
      x: (i % 2 === 0 ? -0.5 : 0.5) * (rear ? tr : trF), y: rear ? 0 : yFA, z: rear ? zRA : zFA, r,
      geo: tyre(r, rear ? 0.5 : 0.3, RUBBER, rimHex, { lugs: rear ? 22 : 16, lugDepth: rear ? 0.05 : 0.035, rim: rear ? 0.6 : 0.58 }),
    });
  }
  return {
    B, wheels,
    dims: { front: bz0 - 0.4, rear: zRA + wr + 0.12, width: tr + 0.5, height: roof + 0.35 - gy, seatY: floor + 1.2, seatZ: cz0 + 0.95 },
  };
}

// ---------------------------------------------------------------------------
// Liveries: canvas-drawn, one per operator, shared by every vehicle wearing it
// ---------------------------------------------------------------------------

const texCache = new Map();
function canvasOf(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function fitText(g, text, maxW, px, weight = 800, family = '"Helvetica Neue", Helvetica, Arial, sans-serif') {
  let size = px;
  g.font = `${weight} ${size}px ${family}`;
  while (g.measureText(text).width > maxW && size > 8) { size -= 2; g.font = `${weight} ${size}px ${family}`; }
  return size;
}

/** The side of a lorry box: the ground colour, a band, the name and the trade. */
function boxLivery(i) {
  const key = `box${i}`;
  if (texCache.has(key)) return texCache.get(key);
  const L = LIVERIES[i % LIVERIES.length];
  const c = canvasOf(1024, 512);
  let t = null;
  if (c) {
    const g = c.getContext('2d');
    g.fillStyle = L.ground; g.fillRect(0, 0, 1024, 512);
    // Panel seams every so often, the box's own construction.
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (let x = 128; x < 1024; x += 128) g.fillRect(x, 0, 3, 512);
    // A band along the bottom with a pinstripe over it, rising into a
    // chevron at the end the lettering starts from.
    g.fillStyle = L.band;
    g.beginPath(); g.moveTo(0, 360); g.lineTo(150, 420); g.lineTo(1024, 420); g.lineTo(1024, 512); g.lineTo(0, 512); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.moveTo(0, 344); g.lineTo(150, 404); g.lineTo(1024, 404); g.lineTo(1024, 411); g.lineTo(150, 411); g.lineTo(0, 351); g.closePath(); g.fill();
    g.fillStyle = L.ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    fitText(g, L.name, 900, 150);
    g.fillText(L.name, 56, 230);
    g.fillStyle = L.band;
    fitText(g, L.sub, 880, 54, 700);
    g.fillText(L.sub, 60, 300);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }
  texCache.set(key, t);
  return t;
}

/** The bus's flank: the operator stripe, and its name small by the door. */
function busLivery(i) {
  const key = `bus${i}`;
  if (texCache.has(key)) return texCache.get(key);
  const c = canvasOf(2048, 256);
  let t = null;
  if (c) {
    const g = c.getContext('2d');
    g.fillStyle = '#f2f1ec'; g.fillRect(0, 0, 2048, 256);
    const band = ['#1f6f8b', '#b23a2f', '#2e7d4f', '#5b3f8c'][i % 4];
    g.fillStyle = band; g.fillRect(0, 150, 2048, 106);
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 138, 2048, 8);
    g.fillStyle = band;
    for (let k = 0; k < 18; k++) g.fillRect(1480 + k * 30, 40 + k * 5, 18, 100 - k * 5);
    g.fillStyle = '#23262b'; g.textAlign = 'left';
    fitText(g, 'VALECROSS COUNTRY BUSES', 900, 64, 800);
    g.fillText('VALECROSS COUNTRY BUSES', 380, 110);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }
  texCache.set(key, t);
  return t;
}

/** The tractor's bonnet decal: the maker and the model, in a white stripe. */
function tractorDecal() {
  if (texCache.has('tractor')) return texCache.get('tractor');
  const c = canvasOf(512, 96);
  let t = null;
  if (c) {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 96);
    g.fillStyle = '#f4f2ea'; g.fillRect(0, 26, 512, 44);
    g.fillStyle = '#1d1f22';
    g.textBaseline = 'middle'; g.textAlign = 'left';
    fitText(g, 'FENWRIGHT', 330, 38, 900);
    g.fillText('FENWRIGHT', 18, 49);
    g.textAlign = 'right';
    g.font = '800 34px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.fillText('140', 494, 49);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }
  texCache.set('tractor', t);
  return t;
}

/** The destination display: amber LED text on black. */
function busSign(i) {
  const key = `sign${i}`;
  if (texCache.has(key)) return texCache.get(key);
  const R = BUS_ROUTES[i % BUS_ROUTES.length];
  const c = canvasOf(512, 64);
  let t = null;
  if (c) {
    const g = c.getContext('2d');
    g.fillStyle = '#050505'; g.fillRect(0, 0, 512, 64);
    g.fillStyle = '#ffb21e';
    g.textBaseline = 'middle';
    g.font = '800 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textAlign = 'left'; g.fillText(R.no, 14, 34);
    g.textAlign = 'center';
    fitText(g, R.to, 390, 40, 700);
    g.fillText(R.to, 290, 34);
    // The dot matrix: a dark grid over the text.
    g.fillStyle = 'rgba(0,0,0,0.55)';
    for (let x = 0; x < 512; x += 4) g.fillRect(x, 0, 1, 64);
    for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 512, 1);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
  }
  texCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const geoCache = new Map();

function geometryFor(style, spec) {
  const key = `${style}|${spec.wheelbase}|${spec.track}|${spec.wheelRadius}|${spec.rideHeight}|${spec.frontWheelRadius || 0}|${spec.rimColour || 0}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const built = style === 'bus' ? buildBus(spec) : style === 'tractor' ? buildTractor(spec) : buildBox(spec);
  const out = { wheels: built.wheels, dims: built.dims, geo: {} };
  for (const [name, list] of Object.entries(built.B)) out.geo[name] = merged(list);
  const d = built.dims;
  const sg = new THREE.PlaneGeometry(d.width + 0.6, d.rear - d.front + 0.7);
  sg.rotateX(-Math.PI * 0.5);
  sg.translate(0, 0, (d.front + d.rear) * 0.5);
  out.shadow = sg;
  geoCache.set(key, out);
  return out;
}

/**
 * A heavy vehicle with exactly createCarModel's interface. `deps` is handed
 * in by carModel.js: its shared kit, the lamp table and the material helpers.
 */
export function createHeavyModel(spec, opts, deps) {
  const style = spec.body;
  const s = {
    wheelbase: spec.wheelbase ?? 4.2, track: spec.track ?? 1.9,
    wheelRadius: spec.wheelRadius ?? 0.46, rideHeight: spec.rideHeight ?? 0.46,
    frontWheelRadius: spec.frontWheelRadius, frontTrack: spec.frontTrack, rimColour: spec.rimColour,
  };
  const built = geometryFor(style, s);
  const K = deps.acquireKit();
  const env = K.tex.env;
  const colour = opts.colour ?? spec.colour ?? 0xd8d8d4;
  const livery = spec.livery | 0;

  const paint = new THREE.MeshPhysicalMaterial({
    color: colour, metalness: 0.2, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.12, envMap: env,
  });
  deps.paintFinish(colour, paint);
  if (env) { paint.onBeforeCompile = deps.patchEnv; paint.customProgramCacheKey = deps.envKey; }
  const detail = deps.envMaterial(THREE.MeshStandardMaterial, { color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.15 }, env);
  const liveryTex = style === 'bus' ? busLivery(livery) : style === 'box' ? boxLivery(livery) : tractorDecal();
  const liveryMat = deps.envMaterial(THREE.MeshStandardMaterial, {
    color: liveryTex ? 0xffffff : 0xe8e6e0, map: liveryTex, roughness: 0.45, metalness: 0.05,
    // The tractor's decal is a stripe on a transparent canvas.
    alphaTest: style === 'tractor' ? 0.5 : 0, transparent: false,
  }, env);
  // A tractor cab is see-through; a bus or lorry window is dark and glossy —
  // rough enough that the sky it reflects is a sheen, not a pasted shape.
  const glass = style === 'tractor' ? K.mats.glass
    : deps.envMaterial(THREE.MeshStandardMaterial, { color: 0x0d1318, roughness: 0.22, metalness: 0.3 }, env);

  const lamp = {};
  for (const [name, [tintHex, glow, rough, metal, graphic]] of Object.entries(deps.LAMPS)) {
    const tex = K.tex[graphic] || null;
    lamp[name] = deps.envMaterial(THREE.MeshStandardMaterial, {
      color: tintHex, emissive: glow, emissiveIntensity: 0, roughness: rough, metalness: metal, map: tex, emissiveMap: tex,
    }, env);
  }
  const signTex = style === 'bus' ? busSign(livery) : null;
  lamp.lSign = new THREE.MeshStandardMaterial({
    color: 0x080808, emissive: 0xffffff, emissiveIntensity: 1.25, emissiveMap: signTex, roughness: 0.3, metalness: 0,
  });
  if (!signTex) lamp.lSign.emissive.setHex(0xffa11a);
  lamp.lBeacon = new THREE.MeshStandardMaterial({ color: 0xc86a10, emissive: 0xff8a12, emissiveIntensity: 0, roughness: 0.2, metalness: 0, transparent: true, opacity: 0.9 });
  lamp.lMarker = new THREE.MeshStandardMaterial({ color: 0x8a5410, emissive: 0xff9a12, emissiveIntensity: 0, roughness: 0.2, metalness: 0 });

  const group = new THREE.Group();
  group.name = `car:${spec.id || style}`;
  // Same child order as a car: a LOD placeholder first, then the chassis.
  const lod = new THREE.LOD();
  lod.name = 'lod';
  group.add(lod);
  const chassis = new THREE.Group();
  group.add(chassis);
  let triangles = 0;
  // What the fleet's far bake should make of each mesh.
  const BAKE = {
    detail: null, livery: { colour: 0xe6e3dc, rough: 0.45, metal: 0.05 },
    glass: { colour: 0x10161c, rough: 0.08, metal: 0.5 },
  };
  const mats = { paint, detail, glass, livery: liveryMat, ...lamp };
  for (const [name, g] of Object.entries(built.geo)) {
    if (!g) continue;
    const mesh = new THREE.Mesh(g, mats[name]);
    mesh.name = name;
    mesh.castShadow = name === 'paint' || name === 'detail' || name === 'livery';
    mesh.receiveShadow = true;
    if (BAKE[name]) mesh.userData.bake = BAKE[name];
    chassis.add(mesh);
    triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  }
  const paintMesh = chassis.getObjectByName('paint');
  if (paintMesh) paintMesh.onBeforeRender = (renderer, scene) => deps.updateEnv(scene);

  // Contact shadow, pulled toward the eye like the road (see pullToward).
  const SHADOW_ALPHA = 0.66;
  const shadowMat = deps.pullToward(new THREE.MeshBasicMaterial({
    color: 0x000000, map: K.tex.shadow, transparent: true, opacity: SHADOW_ALPHA,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  const shadow = new THREE.Mesh(built.shadow, shadowMat);
  shadow.name = 'contactShadow';
  shadow.renderOrder = -1;
  shadow.visible = !!K.tex.shadow;
  shadow.position.y = -s.rideHeight + 0.047;
  group.add(shadow);

  // Wheels: FL, FR, RL, RR, the tyre (with its rim coloured in) first.
  const wheels = [];
  const rRef = s.wheelRadius;
  const spinK = [];
  const wheelMat = deps.envMaterial(THREE.MeshStandardMaterial, { color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.2 }, env);
  for (let i = 0; i < 4; i++) {
    const wd = built.wheels[i];
    const w = new THREE.Object3D();
    w.rotation.order = 'YXZ';
    w.name = ['FL', 'FR', 'RL', 'RR'][i];
    w.position.set(wd.x, wd.y, wd.z);
    const t = new THREE.Mesh(wd.geo, wheelMat);
    t.name = 'tyre';
    t.castShadow = true;
    t.userData.bake = { colour: 0xffffff, rough: 0.8, metal: 0.1, vertex: true };
    // Mirror the left side so the hub faces out on both.
    if (wd.x < 0) t.scale.x = -1;
    w.add(t);
    group.add(w);
    wheels.push(w);
    spinK.push(rRef / wd.r);
    triangles += wd.geo.index ? wd.geo.index.count / 3 : 0;
  }
  const restY = built.wheels.map((w) => w.y);

  const state = { brake: 0, head: false, ind: 0, dead: false };
  const beacon = style === 'tractor';
  const phase = Math.random();
  function applyTail() {
    const running = state.head ? 0.45 : 0;
    lamp.lTail.emissiveIntensity = Math.max(running, state.brake * 1.6);
    lamp.lMarker.emissiveIntensity = state.head ? 1.6 : 0.25;
  }
  function setSteer(rad) { wheels[0].rotation.y = -rad; wheels[1].rotation.y = -rad; }
  function setWheelSpin(rad) {
    const a = typeof rad === 'number' ? rad : rad[0];
    for (let i = 0; i < 4; i++) wheels[i].rotation.x = -(typeof rad === 'number' ? a : rad[i]) * spinK[i];
    // A slow vehicle's beacon turns whenever it is on the road. Driven from
    // here because this is the one setter every caller makes every frame.
    if (beacon) {
      const t = deps.now() * 7.5 + phase * TAU;
      lamp.lBeacon.emissiveIntensity = 0.4 + 3.2 * Math.max(0, Math.sin(t)) ** 3;
    }
  }
  function setSuspension(comps) {
    for (let i = 0; i < 4; i++) wheels[i].position.y = restY[i] + clamp(comps[i] || 0, -0.12, 0.12);
  }
  function setBrakeLights(v) { state.brake = clamp(v, 0, 1); applyTail(); }
  function setHeadlights(on) {
    state.head = !!on;
    lamp.lHead.emissiveIntensity = state.head ? 2.4 : 0;
    applyTail();
  }
  function setReverseLights(on) { lamp.lRev.emissiveIntensity = on ? 2.2 : 0; }
  function setIndicator(dir, on = null) {
    state.ind = dir | 0;
    const lit = on === null ? ((deps.now() + phase) % 0.78) < 0.44 : !!on;
    lamp.lIndL.emissiveIntensity = lit && (state.ind === -1 || state.ind === 2) ? 2.8 : 0;
    lamp.lIndR.emissiveIntensity = lit && (state.ind === 1 || state.ind === 2) ? 2.8 : 0;
  }
  function setPaint(hex) {
    paint.color.setHex(hex);
    deps.paintFinish(hex, paint);
    group.userData.paint = hex;
  }
  function dispose() {
    if (state.dead) return;
    state.dead = true;
    group.removeFromParent();
    for (const m of [paint, detail, liveryMat, wheelMat, shadowMat, ...Object.values(lamp)]) m.dispose();
    if (glass !== K.mats.glass) glass.dispose();
    deps.releaseKit();
  }
  applyTail();

  const bd = built.dims;
  const dims = {
    length: bd.rear - bd.front, width: bd.width, height: bd.height,
    wheelbase: s.wheelbase, track: s.track, wheelRadius: s.wheelRadius,
    front: bd.front, rear: bd.rear, seat: { x: -0.4, y: bd.seatY, z: bd.seatZ },
  };
  group.userData.dims = dims;
  group.userData.paint = colour;
  return {
    group, wheels, triangles,
    setSteer, setWheelSpin, setSuspension,
    setBrakeLights, setHeadlights, setReverseLights, setIndicator,
    setPaint, dispose, dims,
  };
}
