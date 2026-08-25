// Damage you can see.
//
// physics/damage.js decides what is broken. This decides what that looks like:
// panels pushed in, paint torn off, glass crazed and then punched out, lenses
// smashed, parts gone, tyres flat and the corner sitting down on them.
//
// THE BINDING PROBLEM — read this before changing anything below.
//
// render/carModel.js does not build a car out of named parts. It builds ONE
// merged geometry per MATERIAL and caches it, so the meshes hanging off the
// chassis are called `paint`, `glass`, `plastic`, `lHead`… and nothing else.
// There is no `bonnet` object to hide, no `windscreen` mesh to swap, no
// `headL`. Both headlights are triangles in the same buffer as each other; the
// bonnet, the doors, the wings and the roof are all one lofted shell.
//
// Worse, that geometry is SHARED. A hundred cars of the same model point at the
// same buffers, reference counted by the kit in carModel.js. Writing a dent
// into it would dent every car in the city at once.
//
// So this module recovers the parts geometrically, and only ever from copies:
//
//   1. It CLONES `paint` before it moves anything, then builds a per-panel
//      vertex list by testing every vertex against a smooth region window in
//      the car's own frame. Openings that have to be carved out of that shell
//      — bonnet, boot, doors — are tagged per triangle at the same time.
//   2. It SPLITS the other merged meshes by CONNECTED COMPONENT, keeping the
//      original material on every piece. carModel welds each bucket with
//      mergeVertices, but two boxes that never touched stay disjoint, so a
//      headlamp bucket is exactly two components and the glass bucket is
//      exactly three panes. Keeping the material matters: setHeadlights()
//      writes emissiveIntensity on it, so a surviving headlight goes on
//      lighting up for free and a smashed one goes dark simply by being handed
//      a different material.
//
// Everything except the cheapest bookkeeping is lazy. A car that is never hit
// clones nothing, splits nothing and allocates nothing, which is what makes it
// affordable to give one of these to every car in traffic.
//
// STATE IS THE TRUTH, EVENTS ARE A SHORTCUT. update() diffs car.damage.state
// and is the only thing that has to run; applyEvents() only pre-empts the same
// work so a shatter lands on the frame the bang happened. Both are idempotent,
// and this module NEVER calls drainEvents() — main.js owns that queue.

import * as THREE from 'three';
import { clamp, lerp, mulberry, smoothstep } from '../world/noise.js';
import { PANELS, DETACHABLE, GLASS, LIGHTS } from '../physics/damage.js';

// Which way a panel folds when it is hit, in the car's own axes:
// forward = -Z, right = +X, up = +Y. A nose hit drives the bumper rearwards, a
// flank hit drives the side inwards, everything on top gets stamped down.
const AXIS = {
  frontBumper: [0, 0, 1], rearBumper: [0, 0, -1],
  bonnet: [0, -1, 0], roof: [0, -1, 0], boot: [0, -1, 0],
  wingFL: [1, 0, 0], wingRL: [1, 0, 0], doorL: [1, 0, 0],
  wingFR: [-1, 0, 0], wingRR: [-1, 0, 0], doorR: [-1, 0, 0],
};

// How far each panel travels at panel = 1, as a fraction of the global dent
// depth. Bumpers concertina; a roof that caved in as far as a bumper looks like
// the car went through a press rather than down a bank.
const DEPTH = {
  frontBumper: 0.95, rearBumper: 0.90, bonnet: 0.72, boot: 0.66, roof: 0.44,
  wingFL: 0.60, wingFR: 0.60, wingRL: 0.58, wingRR: 0.58, doorL: 0.52, doorR: 0.52,
};

// How much of the dent direction comes from the panel axis rather than from the
// surface itself. All axis gives a flat push that reads as a scale; all normal
// gives an even shrink that reads as a deflating balloon. Half and half is what
// looks like sheet metal folding.
const AXIS_MIX = 0.58;

// Parts that have to be cut out of the body loft rather than hidden, and the
// pane of glass that leaves with each.
const OPENINGS = ['bonnet', 'boot', 'doorL', 'doorR'];
const OPENING_GLASS = { doorL: 'sideL', doorR: 'sideR' };

const TAU = Math.PI * 2;

// ===========================================================================
// Shared kit: two procedural textures and the materials every damaged car uses
// ===========================================================================
//
// Reference counted exactly like carModel's kit, and for the same reason: the
// last car disposed tears it down, and until then disposing one car can never
// pull the crack texture out from under its neighbours.

const kit = { refs: 0, crack: null, hole: null, mats: null, shred: new Map() };

/** Canvases only exist in a browser; tools/ imports this module in Node. */
function canvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Crazed safety glass: a pale wash with fractures running out of two impact
 * points and concentric arcs crossing them. Drawn WITH ALPHA in the canvas so
 * it works as a `map` on a transparent material and the glass stays
 * see-through between the cracks.
 */
function crackTexture() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const rnd = mulberry(0x5ac31d);
  g.clearRect(0, 0, 256, 256);
  // The wash is what turns clear glass milky. Without it the cracks float in
  // nothing and a crazed windscreen is no less transparent than a clean one.
  g.fillStyle = 'rgba(204,219,233,0.30)';
  g.fillRect(0, 0, 256, 256);
  g.lineCap = 'round';
  for (let hit = 0; hit < 2; hit++) {
    const cx = 60 + rnd() * 136, cy = 52 + rnd() * 152;
    const spokes = 9 + ((rnd() * 5) | 0);
    for (let s = 0; s < spokes; s++) {
      let ang = (s / spokes) * TAU + rnd() * 0.30;
      let x = cx, y = cy;
      const len = 26 + rnd() * 96;
      g.strokeStyle = `rgba(255,255,255,${0.55 + rnd() * 0.40})`;
      g.lineWidth = 0.7 + rnd() * 1.7;
      g.beginPath();
      g.moveTo(x, y);
      // The fracture wanders as it runs. A straight spoke reads as a drawn
      // star; a wandering one reads as glass.
      for (let step = 0; step < 6; step++) {
        ang += (rnd() - 0.5) * 0.42;
        x += Math.cos(ang) * len / 6;
        y += Math.sin(ang) * len / 6;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let r = 12; r < 96; r += 11 + rnd() * 13) {
      g.strokeStyle = `rgba(255,255,255,${0.20 + rnd() * 0.30})`;
      g.lineWidth = 0.6 + rnd() * 0.9;
      const from = rnd() * TAU;
      g.beginPath();
      g.arc(cx, cy, r * (0.85 + rnd() * 0.3), from, from + 1.1 + rnd() * 2.6);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * What is left in the frame once a pane blows out: a ragged rim of shards and
 * nothing in the middle. Greyscale, because three.js samples an alphaMap's
 * GREEN channel — white survives, black is the hole. The inner boundary is
 * square-ish rather than circular so a broken windscreen keeps its shards down
 * the pillars instead of leaving a porthole.
 */
function holeTexture() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const rnd = mulberry(0x11f0b3);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  const edge = (a) => 128 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
  g.beginPath();
  g.rect(0, 0, 256, 256);
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    const r = edge(a) * (0.62 + rnd() * 0.26);
    const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill('evenodd');
  // A few shards still hanging off the rim, so the hole has teeth.
  for (let i = 0; i < 14; i++) {
    const a = rnd() * TAU;
    const r0 = edge(a) * 0.68, r1 = r0 * (0.40 + rnd() * 0.34);
    const w = 0.06 + rnd() * 0.10;
    g.beginPath();
    g.moveTo(128 + Math.cos(a - w) * r0, 128 + Math.sin(a - w) * r0);
    g.lineTo(128 + Math.cos(a + w) * r0, 128 + Math.sin(a + w) * r0);
    g.lineTo(128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1);
    g.closePath();
    g.fill();
  }
  // No colour space: this is data, not a picture.
  return new THREE.CanvasTexture(c);
}

function acquireKit() {
  if (kit.refs === 0) {
    kit.crack = crackTexture();
    kit.hole = holeTexture();
    kit.mats = {
      // Crazed: still glass, still transparent, just no longer clear.
      crazed: new THREE.MeshPhysicalMaterial({
        color: 0xd3dde6, map: kit.crack, transparent: true, opacity: 0.94,
        roughness: 0.42, metalness: 0, clearcoat: 0.4,
        side: THREE.DoubleSide, depthWrite: false,
      }),
      // Blown out: alphaTest rather than blending, so what is left is solid
      // glass and the hole is a real hole the cabin shows through.
      shattered: new THREE.MeshStandardMaterial({
        color: 0xc6d4e0, alphaMap: kit.hole, alphaTest: 0.5,
        roughness: 0.30, metalness: 0, side: THREE.DoubleSide,
      }),
      // A smashed lens: dark, with the crack texture picking out the broken
      // edges. Handing this to a lamp also takes it off the per-car lamp
      // material, which is what kills its emissive without any extra work.
      lens: new THREE.MeshStandardMaterial({
        color: 0x1b1e22, map: kit.crack, roughness: 0.86, metalness: 0.12,
      }),
      // A destroyed tyre: no tread map, because there is no tread left.
      carcass: new THREE.MeshStandardMaterial({
        color: 0x0d0e10, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      }),
      // Back faces only, so an opened bonnet is a recess you look INTO rather
      // than a black box sitting in the engine bay.
      cavity: new THREE.MeshStandardMaterial({
        color: 0x090a0c, roughness: 1, metalness: 0, side: THREE.BackSide,
      }),
      engine: new THREE.MeshStandardMaterial({
        color: 0x2b2e33, roughness: 0.66, metalness: 0.55,
      }),
    };
  }
  kit.refs++;
  return kit;
}

function releaseKit() {
  if (--kit.refs > 0) return;
  if (kit.crack) kit.crack.dispose();
  if (kit.hole) kit.hole.dispose();
  for (const m of Object.values(kit.mats || {})) m.dispose();
  for (const e of kit.shred.values()) e.geo.dispose();
  kit.shred.clear();
  kit.crack = kit.hole = kit.mats = null;
  kit.refs = 0;
}

/**
 * Ragged flaps of rubber hanging off a destroyed tyre, in the wheel's own
 * frame (axle along X, radius in the YZ plane). Cached per wheel size, because
 * every car of a given model wears the same four.
 */
function shredGeometry(key, wr, width) {
  const hit = kit.shred.get(key);
  if (hit) { hit.refs++; return hit.geo; }
  const rnd = mulberry(0x7a31c5);
  const FLAPS = 9;
  const pos = new Float32Array(FLAPS * 6 * 3);
  let w = 0;
  const put = (x, r, a) => { pos[w++] = x; pos[w++] = Math.cos(a) * r; pos[w++] = Math.sin(a) * r; };
  for (let i = 0; i < FLAPS; i++) {
    const a0 = (i / FLAPS) * TAU + rnd() * 0.25;
    const a1 = a0 + 0.16 + rnd() * 0.24;
    const twist = (rnd() - 0.5) * 0.5;
    const r0 = wr * 0.67, r1 = wr * (0.92 + rnd() * 0.36);
    const x0 = (rnd() - 0.5) * width * 0.5, x1 = x0 + width * (0.22 + rnd() * 0.30);
    const jx = (rnd() - 0.5) * width * 0.9;
    put(x0, r0, a0); put(x1, r0, a1); put(x1 + jx, r1, a1 + twist);
    put(x0, r0, a0); put(x1 + jx, r1, a1 + twist); put(x0 + jx, r1, a0 + twist);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  kit.shred.set(key, { geo, refs: 1 });
  return geo;
}

function releaseShred(key) {
  const hit = kit.shred.get(key);
  if (hit && --hit.refs <= 0) { hit.geo.dispose(); kit.shred.delete(key); }
}

// ===========================================================================
// Geometry analysis — all of it construction time, so it allocates freely
// ===========================================================================

/**
 * A stable pseudo-random in [0,1) keyed on a POSITION, not on a vertex index.
 *
 * This is load bearing. carModel runs its lofts through toCreasedNormals, which
 * leaves several vertices sharing one position with different normals along
 * every crease. Keying the crumple noise on the index would give those copies
 * different displacements and tear the shell open along its sharpest and most
 * visible edges. Keying on the quantised position gives them all the same
 * number, so a crease stays welded however hard it is hit.
 */
function hashAt(x, y, z, salt) {
  let h = 2166136261 ^ (salt | 0);
  h = Math.imul(h ^ Math.round(x * 2000), 16777619);
  h = Math.imul(h ^ Math.round(y * 2000), 16777619);
  h = Math.imul(h ^ Math.round(z * 2000), 16777619);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Group vertices by position and average their normals, for exactly the same
 * reason: the dent DIRECTION has to agree across every copy of a crease vertex
 * or the crease splits. The averaged normal only aims the dent; the per-copy
 * normals in the buffer are recomputed afterwards and keep the crease sharp.
 */
function positionGroups(pos, nrm, n) {
  const map = new Map();
  const gid = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 2000)},${Math.round(pos[i * 3 + 1] * 2000)},${Math.round(pos[i * 3 + 2] * 2000)}`;
    let id = map.get(k);
    if (id === undefined) { id = count++; map.set(k, id); }
    gid[i] = id;
  }
  const avg = new Float32Array(count * 3);
  for (let i = 0; i < n; i++) {
    const g = gid[i] * 3;
    avg[g] += nrm[i * 3]; avg[g + 1] += nrm[i * 3 + 1]; avg[g + 2] += nrm[i * 3 + 2];
  }
  for (let g = 0; g < count; g++) {
    const o = g * 3;
    const l = Math.hypot(avg[o], avg[o + 1], avg[o + 2]) || 1;
    avg[o] /= l; avg[o + 1] /= l; avg[o + 2] /= l;
  }
  return { gid, normal: avg };
}

/**
 * Connected components over an indexed geometry, labelled per TRIANGLE, with
 * the bounds and centroid of each. This is how a merged mesh gets taken apart
 * again without knowing anything about how it was put together.
 */
function componentsOf(geo) {
  const idx = geo.index.array;
  const n = geo.attributes.position.count;
  const tris = idx.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < tris; t++) {
    const a = find(idx[t * 3]), b = find(idx[t * 3 + 1]), c = find(idx[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    if (a !== c) parent[find(c)] = a;
  }
  const label = new Int32Array(tris);
  const remap = new Map();
  let count = 0;
  for (let t = 0; t < tris; t++) {
    const r = find(idx[t * 3]);
    let id = remap.get(r);
    if (id === undefined) { id = count++; remap.set(r, id); }
    label[t] = id;
  }
  const pos = geo.attributes.position.array;
  const box = new Float64Array(count * 6);
  const mid = new Float64Array(count * 3);
  const seen = new Uint32Array(count);
  for (let c = 0; c < count; c++) {
    box[c * 6] = box[c * 6 + 1] = box[c * 6 + 2] = Infinity;
    box[c * 6 + 3] = box[c * 6 + 4] = box[c * 6 + 5] = -Infinity;
  }
  for (let t = 0; t < tris; t++) {
    const c = label[t];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      for (let d = 0; d < 3; d++) {
        const p = pos[v + d];
        if (p < box[c * 6 + d]) box[c * 6 + d] = p;
        if (p > box[c * 6 + 3 + d]) box[c * 6 + 3 + d] = p;
        mid[c * 3 + d] += p;
      }
      seen[c]++;
    }
  }
  for (let c = 0; c < count; c++) {
    for (let d = 0; d < 3; d++) mid[c * 3 + d] /= Math.max(1, seen[c]);
  }
  return { label, count, box, mid, tris };
}

/** Copy a list of triangles out of an indexed geometry into a standalone one. */
function extractTriangles(geo, tris) {
  const idx = geo.index.array;
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const n = tris.length * 3;
  const P = new Float32Array(n * 3);
  const N = nrm ? new Float32Array(n * 3) : null;
  const U = uv ? new Float32Array(n * 2) : null;
  for (let t = 0; t < tris.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[tris[t] * 3 + k], w = t * 3 + k;
      P[w * 3] = pos[v * 3]; P[w * 3 + 1] = pos[v * 3 + 1]; P[w * 3 + 2] = pos[v * 3 + 2];
      if (N) { N[w * 3] = nrm[v * 3]; N[w * 3 + 1] = nrm[v * 3 + 1]; N[w * 3 + 2] = nrm[v * 3 + 2]; }
      if (U) { U[w * 2] = uv[v * 2]; U[w * 2 + 1] = uv[v * 2 + 1]; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (N) g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  return g;
}

/**
 * Take one merged mesh apart into independently controllable pieces, keeping
 * the source material on every one. `labeller(comp)` returns a label per
 * component, or null for "leave this in the leftovers". Returns null when the
 * whole mesh lands in a single bucket, because splitting it would buy nothing
 * and cost a draw call.
 */
function splitMesh(mesh, labeller) {
  const geo = mesh.geometry;
  if (!geo || !geo.index || !mesh.parent) return null;
  const comp = componentsOf(geo);
  const labels = labeller(comp);
  const byLabel = new Map();
  for (let c = 0; c < comp.count; c++) {
    const label = labels[c] || '';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(c);
  }
  if (byLabel.size < 2) return null;
  const parts = new Map();
  for (const [label, comps] of byLabel) {
    const tris = [];
    for (let t = 0; t < comp.tris; t++) if (comps.indexOf(comp.label[t]) >= 0) tris.push(t);
    const m = new THREE.Mesh(extractTriangles(geo, tris), mesh.material);
    m.name = `${mesh.name}:${label || 'rest'}`;
    m.castShadow = mesh.castShadow;
    m.receiveShadow = mesh.receiveShadow;
    mesh.parent.add(m);
    parts.set(label, m);
  }
  mesh.visible = false;
  return { source: mesh, parts };
}

/** Wrap a per-component predicate into the labeller splitMesh wants. */
function perComponent(fn) {
  return (comp) => {
    const out = new Array(comp.count);
    for (let c = 0; c < comp.count; c++) {
      out[c] = fn(comp.box, c, comp.mid[c * 3], comp.mid[c * 3 + 1], comp.mid[c * 3 + 2]);
    }
    return out;
  };
}

/** 1 inside [lo,hi], feathering smoothly to 0 over `f` beyond each end. */
function win(v, lo, hi, f) {
  const t = Math.min((v - lo) / f + 1, (hi - v) / f + 1);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Concatenate a few non-indexed primitives into one buffer. Small enough not to
 * be worth pulling BufferGeometryUtils in for, and it sidesteps that helper's
 * insistence on matching attribute sets these do not have.
 */
function mergeBuffers(list) {
  let verts = 0;
  for (const g of list) verts += g.index ? g.index.count : g.attributes.position.count;
  const P = new Float32Array(verts * 3), N = new Float32Array(verts * 3);
  let w = 0;
  for (const g of list) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.attributes.position.array, nn = src.attributes.normal.array;
    for (let i = 0; i < src.attributes.position.count; i++) {
      P[w * 3] = p[i * 3]; P[w * 3 + 1] = p[i * 3 + 1]; P[w * 3 + 2] = p[i * 3 + 2];
      N[w * 3] = nn[i * 3]; N[w * 3 + 1] = nn[i * 3 + 1]; N[w * 3 + 2] = nn[i * 3 + 2];
      w++;
    }
    if (src !== g) src.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P.subarray(0, w * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N.subarray(0, w * 3), 3));
  return out;
}

// ===========================================================================
// createCarDamage
// ===========================================================================

/**
 * Bind visible damage to one car model.
 *
 * @param carModel  the object returned by createCarModel()
 * @param spec      the physics spec — body style and ride height are read
 * @param opts      { detail: 'high'|'low', dents, scuffs, cavities, dentScale }
 *
 * Returns { update, applyEvents, reset, dispose }. Call update(car.damage, dt)
 * every frame: passing the whole damage object gets the exact ride drop out of
 * car.damage.effects, and passing car.damage.state alone still works, with the
 * drop derived from suspension and blown tyres instead.
 */
export function createCarDamage(carModel, spec = {}, opts = {}) {
  const low = opts.detail === 'low';
  const wantDents = opts.dents ?? !low;
  const wantScuffs = opts.scuffs ?? !low;
  const wantCavities = opts.cavities ?? !low;
  const K = acquireKit();

  const group = carModel.group;
  const dims = carModel.dims;
  const wheels = carModel.wheels;

  // ---- locate what carModel actually built --------------------------------
  // The chassis is the child Group holding the body meshes. The wheels are its
  // SIBLINGS, not its children, which is exactly what lets the body lean over
  // onto a flat tyre without dragging the wheels down with it.
  let chassis = group;
  for (const c of group.children) {
    if (c.isGroup && c.children.some((m) => m.name === 'paint')) { chassis = c; break; }
  }
  const canSag = chassis !== group;
  const mesh = {};
  for (const m of chassis.children) if (m.isMesh && m.name) mesh[m.name] = m;
  const paintMesh = mesh.paint || null;
  const paintMat = paintMesh ? paintMesh.material : null;

  // ---- dimensions ---------------------------------------------------------
  const wr = dims.wheelRadius, wb = dims.wheelbase, tr = dims.track;
  const hw = dims.width * 0.5;
  const zF = dims.front, zR = dims.rear;
  const zAF = -wb * 0.5, zAR = wb * 0.5;
  const fo = Math.max(0.2, zAF - zF), ro = Math.max(0.2, zR - zAR);
  const rideHeight = spec.rideHeight ?? 0.28;
  const yRoof = dims.height - rideHeight;
  // These two mirror private constants in carModel.js. They only size
  // classification windows, so a small drift costs a slightly different
  // feather, never a wrong answer.
  const archLen = wr * 1.42;
  const sill = -rideHeight * 0.10;
  const shredKey = `${wr.toFixed(3)}|${(wr * 0.55).toFixed(3)}`;

  // The cabin is MEASURED off the glass rather than guessed from a style
  // table: the side panes are the door tops, so their bounds give the exact
  // belt line and the exact ends of the greenhouse for all seven body styles,
  // including the cab-forward van and the long-tailed coupe.
  let cabF = zAF * 0.28, cabR = zAR * 1.16, yBelt = yRoof * 0.58;
  let yBonnet = yBelt, yBoot = yBelt;
  let measured = false;

  /**
   * Which pane each glass component is. At high detail the backlight lives in
   * its own `glassDark` bucket, which settles it outright; at low detail
   * carModel folds the two together, and then the one further FORWARD (front
   * is -Z) is the windscreen. Comparing against the car's midpoint instead
   * would misfile a fastback coupe, whose windscreen sits behind it.
   */
  function labelGlass(src, comp) {
    const out = new Array(comp.count);
    const spanning = [];
    for (let c = 0; c < comp.count; c++) {
      if (comp.box[c * 6] < -hw * 0.05 && comp.box[c * 6 + 3] > hw * 0.05) {
        spanning.push(c);
        out[c] = null;
      } else {
        out[c] = comp.mid[c * 3] < 0 ? 'sideL' : 'sideR';
      }
    }
    if (spanning.length === 1) {
      out[spanning[0]] = src === mesh.glassDark ? 'rear' : 'windscreen';
    } else if (spanning.length > 1) {
      spanning.sort((a, b) => comp.mid[a * 3 + 2] - comp.mid[b * 3 + 2]);
      out[spanning[0]] = 'windscreen';
      for (let k = 1; k < spanning.length; k++) out[spanning[k]] = 'rear';
    }
    return out;
  }

  function measureCabin() {
    if (measured) return;
    measured = true;
    let minZ = Infinity, maxZ = -Infinity, beltY = Infinity;
    for (const name of ['glass', 'glassDark']) {
      const src = mesh[name];
      if (!src || !src.geometry || !src.geometry.index) continue;
      const comp = componentsOf(src.geometry);
      const labels = labelGlass(src, comp);
      for (let c = 0; c < comp.count; c++) {
        if (!labels[c] || labels[c] === 'rear') continue;
        minZ = Math.min(minZ, comp.box[c * 6 + 2]);
        if (labels[c] === 'windscreen') continue;
        maxZ = Math.max(maxZ, comp.box[c * 6 + 5]);
        beltY = Math.min(beltY, comp.box[c * 6 + 1]);
      }
    }
    if (minZ < Infinity) cabF = minZ;
    if (maxZ > -Infinity) cabR = maxZ;
    if (beltY < Infinity) yBelt = beltY;
    // The top of the bonnet and of the rear deck, measured rather than
    // derived: a pickup's "boot" is its bed floor and a van barely has a
    // bonnet at all, and both come out right this way.
    yBonnet = yBelt; yBoot = yBelt;
    if (paintMesh && paintMesh.geometry) {
      const p = paintMesh.geometry.attributes.position.array;
      const n = paintMesh.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) {
        const z = p[i * 3 + 2], y = p[i * 3 + 1];
        if (z > zF + fo * 0.45 && z < cabF && y > yBonnet) yBonnet = y;
        if (z > cabR && z < zR - ro * 0.40 && y > yBoot) yBoot = y;
      }
    }
  }

  // ---- panel region windows ----------------------------------------------
  const flank = (s) => smoothstep(hw * 0.34, hw * 0.64, s);
  const arch = (z, zc) => win(z, zc - archLen * 0.55, zc + archLen * 0.55, archLen * 0.55);
  const underBelt = (y) => 1 - smoothstep(yBelt + wr * 0.05, yBelt + wr * 0.45, y);
  const doorSpan = (z) => win(z, zAF + archLen * 0.62, zAR - archLen * 0.62, archLen * 0.55);

  function panelWeight(name, x, y, z) {
    switch (name) {
      case 'frontBumper': return win(z, zF - 0.06, zF + fo * 0.40, fo * 0.40);
      case 'rearBumper': return win(z, zR - ro * 0.40, zR + 0.06, ro * 0.40);
      case 'bonnet': return win(z, zF + fo * 0.40, cabF, fo * 0.45) *
        smoothstep(yBonnet - wr * 0.60, yBonnet - wr * 0.12, y);
      case 'boot': return win(z, cabR, zR - ro * 0.40, ro * 0.42) *
        smoothstep(yBoot - wr * 0.55, yBoot - wr * 0.10, y);
      case 'roof': return win(z, cabF, cabR, wr * 0.45) *
        smoothstep(yRoof - wr * 0.75, yRoof - wr * 0.18, y);
      case 'wingFL': return flank(-x) * arch(z, zAF) * underBelt(y);
      case 'wingFR': return flank(x) * arch(z, zAF) * underBelt(y);
      case 'wingRL': return flank(-x) * arch(z, zAR) * underBelt(y);
      case 'wingRR': return flank(x) * arch(z, zAR) * underBelt(y);
      case 'doorL': return flank(-x) * doorSpan(z) * underBelt(y);
      case 'doorR': return flank(x) * doorSpan(z) * underBelt(y);
      default: return 0;
    }
  }

  // ---- glass panes --------------------------------------------------------
  const paneOf = new Map();
  let glassSplit = null;

  function ensureGlass() {
    if (glassSplit) return;
    measureCabin();
    glassSplit = [];
    for (const name of ['glass', 'glassDark']) {
      const src = mesh[name];
      if (!src) continue;
      const s = splitMesh(src, (comp) => labelGlass(src, comp));
      if (s) {
        glassSplit.push(s);
        for (const [label, m] of s.parts) {
          if (label) paneOf.set(label, { mesh: m, clean: m.material });
        }
      } else {
        // A single pane in the whole bucket — a van's backlight. Nothing to
        // split, but it still has to be controllable, so adopt it as it is.
        paneOf.set(src === mesh.glassDark ? 'rear' : 'windscreen', { mesh: src, clean: src.material });
      }
    }
  }

  // ---- the deformable body ------------------------------------------------
  // Cloned on the first dent or the first lost panel and not before, because
  // most cars in the city are never touched and this is the only part of the
  // module with real cost.
  let body = null;
  const dentMax = wr * 0.62 * (opts.dentScale ?? 1);
  const maxTotal = wr * 0.95;

  function ensureBody() {
    if (body) return body;
    if (!paintMesh || !paintMesh.geometry || !paintMesh.geometry.index) return null;
    measureCabin();
    const src = paintMesh.geometry;
    const geo = src.clone();                     // never write to the shared kit copy
    paintMesh.geometry = geo;
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal.array;
    const n = geo.attributes.position.count;
    const baseIndex = geo.index.array.slice();
    body = {
      src, geo, pos, nrm, n, baseIndex, tris: baseIndex.length / 3,
      base: pos.slice(), baseNrm: nrm.slice(),
      delta: new Float32Array(n * 3), mag: new Float32Array(n),
      idxOf: null, dirOf: null, streak: null, soot: null, tint: null,
      colour: null, overlay: null,
      // Carve groups: 0 is permanent bodywork, 1..N a removable opening.
      triTag: new Uint8Array(baseIndex.length / 3), hidden: new Uint8Array(8),
      tagCount: 0, tagOf: new Map(), spoilerLabel: null, spoilerPick: null,
    };
    tagOpenings();
    if (wantDents) buildPanelMaps();
    return body;
  }

  /**
   * Per panel: which vertices it owns, and the vector each of them travels per
   * metre of dent depth. Folding the crumple noise and the region weight into
   * that vector here turns the whole rebuild into multiply-adds later.
   */
  function buildPanelMaps() {
    const b = body, pos = b.base, n = b.n;
    const { gid, normal: gnrm } = positionGroups(pos, b.baseNrm, n);
    const idxOf = [], dirOf = [];
    const tmpI = new Uint32Array(n), tmpD = new Float32Array(n * 3);
    for (let p = 0; p < PANELS.length; p++) {
      const name = PANELS[p];
      const ax = AXIS[name][0], ay = AXIS[name][1], az = AXIS[name][2];
      let c = 0;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const w = panelWeight(name, x, y, z);
        if (w <= 0.02) continue;
        const g = gid[i] * 3;
        const dx = ax * AXIS_MIX - gnrm[g] * (1 - AXIS_MIX);
        const dy = ay * AXIS_MIX - gnrm[g + 1] * (1 - AXIS_MIX);
        const dz = az * AXIS_MIX - gnrm[g + 2] * (1 - AXIS_MIX);
        const l = Math.hypot(dx, dy, dz) || 1;
        // Crumple: the same smooth window, roughened so the metal folds
        // unevenly instead of shrinking like a balloon.
        const s = w * (0.42 + 0.58 * hashAt(x, y, z, 7919 * (p + 1))) / l;
        tmpI[c] = i;
        tmpD[c * 3] = dx * s; tmpD[c * 3 + 1] = dy * s; tmpD[c * 3 + 2] = dz * s;
        c++;
      }
      idxOf.push(tmpI.slice(0, c));
      dirOf.push(tmpD.slice(0, c * 3));
    }
    b.idxOf = idxOf; b.dirOf = dirOf;

    // Where the paint gives up first. Position keyed like everything else, and
    // squared so roughly a third of the surface takes most of it — that is
    // what makes a scrape a streak rather than a grey wash.
    b.streak = new Float32Array(n);
    b.soot = new Float32Array(n);
    b.tint = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const h = hashAt(x, y, z, 33013);
      b.streak[i] = h * h * (0.55 + 0.45 * hashAt(x, y, z, 60013));
      // Soot climbs out of the engine bay and back over the screen, so a car
      // that catches fire blackens from the nose rather than uniformly.
      b.soot[i] = clamp(1.25 - (z - zF) / Math.max(0.5, zR - zF) * 1.35, 0.12, 1) *
        (0.62 + 0.38 * hashAt(x, y, z, 90011));
      b.tint[i] = hashAt(x, y, z, 12289);
    }
  }

  /** Mark the triangles that leave with the bonnet, boot, doors and spoiler. */
  function tagOpenings() {
    const b = body, idx = b.baseIndex, p = b.base;
    const add = (name) => { b.tagOf.set(name, ++b.tagCount); return b.tagCount; };
    const tagBonnet = add('bonnet');
    // A van's rear deck IS its roof — the loft runs the cargo box straight out
    // to the tail. Carving a "boot lid" there takes the roof off the box and
    // looks like the car was opened with a tin opener, so a van simply has no
    // boot to lose and the request becomes a no-op.
    const tagBoot = yBoot < yRoof - wr * 0.50 ? add('boot') : 0;
    const tagDoorL = add('doorL'), tagDoorR = add('doorR');
    // A spoiler is separate lumps of bodywork rather than part of the shell, so
    // it falls out of the component pass instead of a region test — and only
    // for the one style that ever grows one. All three pieces go, not just the
    // rearmost: a wing that leaves its uprights behind is worse than no wing.
    let tagSpoiler = 0;
    if ((spec.body || '') === 'sports') {
      const comp = componentsOf(b.geo);
      const pick = new Uint8Array(comp.count);
      let any = false;
      for (let c = 0; c < comp.count; c++) {
        if (comp.box[c * 6 + 2] > cabR && comp.box[c * 6 + 1] > yBelt + wr * 0.05) { pick[c] = 1; any = true; }
      }
      if (any) { b.spoilerLabel = comp.label; b.spoilerPick = pick; tagSpoiler = add('spoiler'); }
    }
    for (let t = 0; t < b.tris; t++) {
      if (b.spoilerPick && b.spoilerPick[b.spoilerLabel[t]]) { b.triTag[t] = tagSpoiler; continue; }
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        cx += p[v]; cy += p[v + 1]; cz += p[v + 2];
      }
      cx /= 3; cy /= 3; cz /= 3;
      if (cz > zF + fo * 0.42 && cz < cabF - 0.02 && cy > yBonnet - wr * 0.45 && Math.abs(cx) < hw * 0.86) {
        b.triTag[t] = tagBonnet;
      } else if (tagBoot && cz > cabR - 0.02 && cz < zR + 0.01 && cy > yBoot - wr * 0.45 && Math.abs(cx) < hw * 0.86) {
        // Runs all the way back to the tail cap on purpose. On a sedan that is
        // the boot lid and the top of the tail panel; on a hatch, whose rear
        // deck is barely thirty centimetres long, the tail cap IS the tailgate
        // and stopping short of it carved a strip you could not see.
        b.triTag[t] = tagBoot;
      } else if (Math.abs(cx) > hw * 0.55 && cz > zAF + wr * 0.95 && cz < zAR - wr * 0.95 &&
                 cy > sill + wr * 0.28 && cy < yBelt - wr * 0.06) {
        // The sill stays behind: a car that loses a door should not lose its
        // floor with it.
        b.triTag[t] = cx < 0 ? tagDoorL : tagDoorR;
      }
    }
  }

  /**
   * Rewrite the live index so hidden openings simply are not drawn, and pull
   * the draw range in behind them. The base index is kept intact alongside,
   * because normals still have to be accumulated over the whole shell and
   * because reset() has to be able to put the panel back.
   */
  function rebuildIndex() {
    const b = body, liveIdx = b.geo.index.array;
    let w = 0;
    for (let t = 0; t < b.tris; t++) {
      if (b.hidden[b.triTag[t]]) continue;
      liveIdx[w++] = b.baseIndex[t * 3];
      liveIdx[w++] = b.baseIndex[t * 3 + 1];
      liveIdx[w++] = b.baseIndex[t * 3 + 2];
    }
    b.geo.index.needsUpdate = true;
    b.geo.setDrawRange(0, w);
  }

  // ---- the dent pass ------------------------------------------------------
  // Runs only when a panel depth actually moved, which is on impact and never
  // otherwise. Every displacement is measured from the CACHED base positions
  // rather than from the current ones, so however many times this runs the car
  // can only ever be as bent as state.panel says. It cannot fold in on itself.

  function deform(st) {
    const b = body;
    if (!b.idxOf) return;
    const d = b.delta;
    d.fill(0);
    for (let p = 0; p < PANELS.length; p++) {
      const depth = st.panel[PANELS[p]] || 0;
      if (depth <= 0) continue;
      const A = dentMax * DEPTH[PANELS[p]] * depth;
      const list = b.idxOf[p], dir = b.dirOf[p];
      for (let k = 0; k < list.length; k++) {
        const o = list[k] * 3, s = k * 3;
        d[o] += dir[s] * A; d[o + 1] += dir[s + 1] * A; d[o + 2] += dir[s + 2] * A;
      }
    }
    for (let i = 0; i < b.n; i++) {
      const o = i * 3;
      let dx = d[o], dy = d[o + 1], dz = d[o + 2];
      const l = Math.hypot(dx, dy, dz);
      // A hard ceiling on TOTAL travel, so a corner owned by three panels at
      // once cannot be driven through the far side of the car.
      if (l > maxTotal) { const s = maxTotal / l; dx *= s; dy *= s; dz *= s; }
      b.mag[i] = l < maxTotal ? l : maxTotal;
      b.pos[o] = b.base[o] + dx;
      b.pos[o + 1] = b.base[o + 1] + dy;
      b.pos[o + 2] = b.base[o + 2] + dz;
    }
    b.geo.attributes.position.needsUpdate = true;
    recomputeNormals();
  }

  /**
   * Vertex normals over the whole shell, written in place.
   *
   * Not THREE's computeVertexNormals: that one walks geometry.index, which this
   * module compacts whenever a panel is carved off, so it would average in the
   * stale triangles left in the tail of the buffer. This walks baseIndex, which
   * is always the complete shell — and it allocates nothing, which THREE's does.
   */
  function recomputeNormals() {
    const b = body, p = b.pos, nr = b.nrm, idx = b.baseIndex;
    nr.fill(0);
    for (let t = 0; t < b.tris; t++) {
      const a = idx[t * 3] * 3, c = idx[t * 3 + 1] * 3, e = idx[t * 3 + 2] * 3;
      const ax = p[c] - p[a], ay = p[c + 1] - p[a + 1], az = p[c + 2] - p[a + 2];
      const bx = p[e] - p[a], by = p[e + 1] - p[a + 1], bz = p[e + 2] - p[a + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      nr[a] += nx; nr[a + 1] += ny; nr[a + 2] += nz;
      nr[c] += nx; nr[c + 1] += ny; nr[c + 2] += nz;
      nr[e] += nx; nr[e + 1] += ny; nr[e + 2] += nz;
    }
    for (let i = 0; i < b.n; i++) {
      const o = i * 3;
      const l = Math.hypot(nr[o], nr[o + 1], nr[o + 2]);
      if (l > 1e-9) { nr[o] /= l; nr[o + 1] /= l; nr[o + 2] /= l; }
      else { nr[o] = b.baseNrm[o]; nr[o + 1] = b.baseNrm[o + 1]; nr[o + 2] = b.baseNrm[o + 2]; }
    }
    b.geo.attributes.normal.needsUpdate = true;
  }

  /**
   * Bare metal where the metal actually moved.
   *
   * A dent alone is nearly invisible past twenty metres — it only changes how
   * the paint catches the light, and with one sun and no environment map there
   * is not much light to catch. A scrape changes the COLOUR, and colour reads
   * at any distance. This rides on a second mesh sharing the deformed geometry,
   * so it bends with the panel for free, and takes its coverage from a
   * FOUR-component vertex colour: rgb is the exposed metal, alpha is how much
   * of it shows through. The car's own paint material has vertexColors off and
   * never sees the attribute, so carModel's setPaint() keeps working untouched.
   */
  function ensureOverlay() {
    const b = body;
    if (b.overlay || !wantScuffs || !b.streak) return b.overlay;
    const col = new Float32Array(b.n * 4);
    for (let i = 0; i < b.n; i++) { col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; }
    b.geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    b.colour = col;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.44, metalness: 0.82,
      transparent: true, vertexColors: true, depthWrite: false,
      // Exactly coplanar with the paint it sits on, so it has to be pulled
      // forward or it z-fights across the entire car.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(b.geo, mat);
    m.name = 'scuff';
    m.castShadow = false;
    m.renderOrder = 1;
    chassis.add(m);
    b.overlay = { mesh: m, mat };
    return b.overlay;
  }

  function updateScuff(scorch) {
    const b = body;
    if (!b.colour) return;
    const col = b.colour;
    for (let i = 0; i < b.n; i++) {
      const bare = clamp((b.mag[i] / dentMax - 0.14) * 1.8, 0, 1) * b.streak[i];
      const burn = scorch * b.soot[i];
      const o = i * 4;
      // Fresh scrapes run from bright steel to dull primer; soot pulls all of
      // it down to charcoal as the fire takes hold.
      const g = lerp(0.86, 0.46, b.tint[i]);
      const k = clamp(burn * 1.4, 0, 1);
      col[o] = lerp(g, 0.10, k);
      col[o + 1] = lerp(g * 0.98, 0.10, k);
      col[o + 2] = lerp(g * 0.96, 0.11, k);
      col[o + 3] = clamp(bare > burn * 0.92 ? bare : burn * 0.92, 0, 1) * 0.94;
    }
    b.geo.attributes.color.needsUpdate = true;
  }

  // ---- what is behind an opening -----------------------------------------
  const cavities = new Map();

  function openCavity(part) {
    if (!wantCavities || cavities.has(part) || !measured) return;
    let x0, x1, y0, y1, z0, z1;
    if (part === 'bonnet') {
      x0 = -hw * 0.70; x1 = hw * 0.70; z0 = zF + fo * 0.44; z1 = cabF;
      y1 = yBonnet - 0.01; y0 = Math.max(sill + 0.02, y1 - wr * 1.05);
    } else if (part === 'boot') {
      x0 = -hw * 0.70; x1 = hw * 0.70; z0 = cabR; z1 = zR - ro * 0.12;
      y1 = yBoot - 0.01; y0 = Math.max(sill + 0.02, y1 - wr * 0.95);
    } else {
      const s = part === 'doorL' ? -1 : 1;
      x0 = Math.min(s * hw * 0.94, s * hw * 0.40);
      x1 = Math.max(s * hw * 0.94, s * hw * 0.40);
      z0 = zAF + wr * 0.95; z1 = zAR - wr * 0.95;
      y0 = sill + wr * 0.26; y1 = yBelt - 0.015;
    }
    if (x1 - x0 < 0.05 || y1 - y0 < 0.05 || z1 - z0 < 0.05) return;
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
    const m = new THREE.Mesh(g, K.mats.cavity);
    m.name = `cavity:${part}`;
    chassis.add(m);
    const entry = { mesh: m, geo: g, engine: null };
    if (part === 'bonnet') entry.engine = addEngine(x0, x1, y0, y1, z0, z1);
    cavities.set(part, entry);
  }

  function closeCavity(part) {
    const cav = cavities.get(part);
    if (!cav) return;
    cav.mesh.removeFromParent(); cav.geo.dispose();
    if (cav.engine) { cav.engine.mesh.removeFromParent(); cav.engine.geo.dispose(); }
    cavities.delete(part);
  }

  /** Something to look at in an opened engine bay. Three primitives, one mesh. */
  function addEngine(x0, x1, y0, y1, z0, z1) {
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    const h = Math.min(wr * 0.72, (y1 - y0) * 0.80);
    const block = new THREE.BoxGeometry((x1 - x0) * 0.56, h, (z1 - z0) * 0.52);
    block.translate(cx, y0 + h * 0.5, cz);
    const cam = new THREE.CylinderGeometry(wr * 0.11, wr * 0.11, (x1 - x0) * 0.50, 6);
    cam.rotateZ(Math.PI * 0.5);
    cam.translate(cx, y0 + h * 0.92, cz - (z1 - z0) * 0.10);
    const pulley = new THREE.CylinderGeometry(wr * 0.20, wr * 0.20, (x1 - x0) * 0.10, 8);
    pulley.rotateZ(Math.PI * 0.5);
    pulley.translate(x0 + (x1 - x0) * 0.16, y0 + h * 0.60, cz + (z1 - z0) * 0.24);
    const geo = mergeBuffers([block, cam, pulley]);
    const m = new THREE.Mesh(geo, K.mats.engine);
    m.name = 'engineBay';
    chassis.add(m);
    return { mesh: m, geo };
  }

  // ---- detachable parts that DO exist as geometry -------------------------
  // Bumpers, mirrors, tailpipes and number plates live inside merged material
  // meshes, so they are split out the first time anything is lost. Anything a
  // body style never built simply has no entry here, which is what makes
  // losing a van's spoiler a no-op instead of a crash.
  const partOf = new Map();
  let partsSplit = null;

  function ensureParts() {
    if (partsSplit) return;
    measureCabin();
    partsSplit = [];
    if (mesh.plastic) {
      const s = splitMesh(mesh.plastic, perComponent((box, c, mx, my, mz) => {
        // Only the mirrors stand further outboard than the bodywork; the
        // bumper valance never reaches past 0.78 of the half width.
        if (Math.abs(mx) > hw * 0.80 && mz > cabF - wr * 1.0 && mz < cabF + wr * 1.8 &&
            my > yBelt - wr * 0.40) return mx < 0 ? 'mirrorL' : 'mirrorR';
        if (mz < zF + wr * 0.80) return 'frontBumper';
        if (mz > zR - wr * 0.80) return 'rearBumper';
        return null;
      }));
      if (s) partsSplit.push(s);
    }
    if (mesh.chrome) {
      // The tailpipes are the only chrome down by the sill at the very back;
      // the grille bar, window surrounds and roof rails are all elsewhere.
      const s = splitMesh(mesh.chrome, perComponent((box, c, mx, my, mz) =>
        (mz > zR - wr * 0.60 && my < sill + wr * 0.60) ? 'exhaust' : null));
      if (s) partsSplit.push(s);
    }
    if (mesh.plate) {
      // Plates are bolted to the bumpers and leave with them.
      const s = splitMesh(mesh.plate, perComponent((box, c, mx, my, mz) =>
        mz < 0 ? 'frontBumper' : 'rearBumper'));
      if (s) partsSplit.push(s);
    }
    for (const s of partsSplit) {
      for (const [label, m] of s.parts) {
        if (!label) continue;
        if (!partOf.has(label)) partOf.set(label, []);
        partOf.get(label).push(m);
      }
    }
  }

  function setAttached(part, on) {
    ensureParts();
    const list = partOf.get(part);
    if (list) for (const m of list) m.visible = on;
    if (OPENINGS.indexOf(part) < 0 && part !== 'spoiler') return;
    const b = ensureBody();
    // No tag means this body style never had that panel as separable geometry
    // — a van's boot, a hatch's spoiler. Nothing to cut, nothing to open.
    const tag = b && b.tagOf.get(part);
    if (!tag) return;
    b.hidden[tag] = on ? 0 : 1;
    rebuildIndex();
    if (part === 'spoiler') return;
    if (on) closeCavity(part); else openCavity(part);
    // The door glass goes with the door. A pane hanging in mid-air where a
    // door used to be is the most obvious possible way to get this wrong.
    const pane = OPENING_GLASS[part];
    if (pane) {
      ensureGlass();
      const p = paneOf.get(pane);
      if (p) p.mesh.visible = on;
    }
  }

  // ---- lamps --------------------------------------------------------------
  // Split so one headlight can go out while the other still works. Every piece
  // keeps the per-car lamp material it was built with, which is what
  // setHeadlights(), setBrakeLights() and setIndicator() write to — so the
  // survivors go on responding without this module touching them at all.
  const lampOf = new Map();
  let lampsSplit = null;

  function ensureLamps() {
    if (lampsSplit) return;
    lampsSplit = [];
    const labeller = perComponent((box, c, mx, my, mz) => {
      // A lamp on the centreline is the high-level brake light. It is not one
      // of the four the damage model tracks, so it survives everything.
      if (Math.abs(mx) < hw * 0.22) return null;
      return (mz < 0 ? 'head' : 'tail') + (mx < 0 ? 'L' : 'R');
    });
    for (const name of ['lHead', 'lTail', 'lBrake', 'lRev', 'lIndL', 'lIndR']) {
      const src = mesh[name];
      if (!src) continue;
      const s = splitMesh(src, labeller);
      if (!s) continue;
      lampsSplit.push(s);
      for (const [label, m] of s.parts) {
        if (!label) continue;
        if (!lampOf.has(label)) lampOf.set(label, []);
        lampOf.get(label).push({ mesh: m, clean: m.material });
      }
    }
  }

  function setLight(name, smashed) {
    ensureLamps();
    const list = lampOf.get(name);
    if (!list) return;
    for (const e of list) e.mesh.material = smashed ? K.mats.lens : e.clean;
  }

  // ---- wheels -------------------------------------------------------------
  // A pivot is slipped between the car and each wheel so the hub can follow the
  // tyre down WITHOUT fighting carModel: setSuspension() goes on writing
  // wheel.position.y for spring travel and this rides outside it, so neither
  // one can clobber the other whatever order main.js calls them in.
  const corner = [];
  for (let i = 0; i < 4; i++) corner.push({ pivot: null, tyre: null, hasRim: false, shred: null, clean: null });
  let shredGeo = null;

  function ensureCorner(i) {
    const c = corner[i];
    if (c.pivot) return c;
    const w = wheels[i];
    const pivot = new THREE.Object3D();
    pivot.name = `sag${i}`;
    group.add(pivot);
    pivot.add(w);
    c.pivot = pivot;
    // High detail builds [rubber, rim]; low detail folds both into one mesh,
    // in which case the whole wheel deflates together and the alloy is left
    // its own colour rather than being blackened with the tyre.
    c.hasRim = w.children.length > 1;
    c.tyre = w.children[0] || null;
    c.clean = c.tyre ? c.tyre.material : null;
    return c;
  }

  /** Squash a tyre onto its rim. Returns how much radius it lost, in metres. */
  function setTyre(i, deflate, blown) {
    const c = ensureCorner(i);
    if (!c.tyre) return 0;
    // Never below the rim: tread collapsing THROUGH the alloy looks worse than
    // no deflation at all.
    const k = clamp(1 - 0.32 * deflate, 0.68, 1);
    // A flat tyre also spreads as it squashes. Scaling Y and Z by the SAME
    // factor keeps the squash invariant under the wheel's own spin about X, so
    // there is no oval rolling round and round with the wheel.
    c.tyre.scale.set(1 + (1 - k) * 0.55, k, k);
    if (c.hasRim) c.tyre.material = blown ? K.mats.carcass : c.clean;
    if (blown && !c.shred) {
      if (!shredGeo) shredGeo = shredGeometry(shredKey, wr, wr * 0.55);
      const m = new THREE.Mesh(shredGeo, K.mats.carcass);
      m.name = `shred${i}`;
      m.castShadow = false;
      wheels[i].add(m);
      c.shred = m;
    }
    if (c.shred) c.shred.visible = blown;
    return wr * (1 - k);
  }

  // ---- per-frame ----------------------------------------------------------
  // Everything below is compare-and-skip. Undamaged, update() is thirty-odd
  // float comparisons and nothing else: no allocation, no writes, no rebuild.

  const lastPanel = new Float32Array(PANELS.length);
  // Float64, NOT Float32, and that is load bearing. Glass and lights are
  // compared for EXACT equality below, and damage.js hands out continuous
  // values (a crazed screen sits at 0.27, a cracked lens at 0.54 — the
  // discrete-looking 0.5 and 1.0 are only the thresholds). Storing a float64
  // into a Float32Array rounds it, so `v === last[i]` is false forever after
  // and the branch fires on every frame for the life of the car, re-running
  // the lookups and rewriting .material on five meshes a frame. Panels get
  // away with Float32 because they compare against a 1e-3 tolerance instead.
  const lastGlass = new Float64Array(GLASS.length);
  const lastLight = new Float64Array(LIGHTS.length);
  const lastAttached = new Uint8Array(DETACHABLE.length).fill(1);
  const lastTyre = new Float64Array(4);
  const hubDrop = new Float64Array(4);
  const drop = new Float64Array(4);
  const cleanColour = new THREE.Color();
  const sootColour = new THREE.Color(0x15161a);
  const scratchColour = new THREE.Color();
  let lastScorch = 0;
  let sooted = false;
  let live = true;

  function update(damage, dt) {
    if (!live || !damage) return;
    const st = damage.state || damage;
    if (!st || !st.panel) return;
    const fx = damage.effects || null;

    // --- panels: a full re-deform, but only when something actually bent ---
    let bent = false;
    for (let p = 0; p < PANELS.length; p++) {
      const v = st.panel[PANELS[p]] || 0;
      if (Math.abs(v - lastPanel[p]) > 1e-3) { lastPanel[p] = v; bent = true; }
    }
    const scorch = clamp(Math.max(st.onFire || 0, (st.burntFor || 0) * 0.28), 0, 1);
    const burnt = Math.abs(scorch - lastScorch) > 0.03;
    if (bent && wantDents) {
      const b = ensureBody();
      if (b) {
        deform(st);
        if (wantScuffs) { ensureOverlay(); updateScuff(scorch); }
      }
    } else if (burnt && wantScuffs && body) {
      ensureOverlay();
      updateScuff(scorch);
    }
    if (burnt) lastScorch = scorch;
    if (paintMat) {
      // Soot goes on the paint itself, and the clean colour underneath it is
      // re-read EVERY frame the car is not sooty rather than latched once.
      // carModel.setPaint() can be called at any moment — the garage does it
      // live — so the material, not this module, has to stay the authority on
      // what colour the car is. Three float writes; it does not allocate.
      if (!sooted) cleanColour.copy(paintMat.color);
      if (burnt) {
        if (scorch > 0.01) {
          paintMat.color.copy(scratchColour.copy(cleanColour).lerp(sootColour, clamp(scorch * 0.85, 0, 0.85)));
          sooted = true;
        } else if (sooted) {
          paintMat.color.copy(cleanColour);
          sooted = false;
        }
      }
    }

    // --- glass ---
    for (let i = 0; i < GLASS.length; i++) {
      const v = st.glass[GLASS[i]] || 0;
      if (v === lastGlass[i]) continue;
      lastGlass[i] = v;
      ensureGlass();
      const pane = paneOf.get(GLASS[i]);
      if (!pane) continue;
      pane.mesh.material = v >= 1 ? K.mats.shattered : v >= 0.5 ? K.mats.crazed : pane.clean;
    }

    // --- lights ---
    for (let i = 0; i < LIGHTS.length; i++) {
      const v = st.light[LIGHTS[i]] || 0;
      if (v === lastLight[i]) continue;
      lastLight[i] = v;
      setLight(LIGHTS[i], v >= 1);
    }

    // --- parts ---
    for (let i = 0; i < DETACHABLE.length; i++) {
      const on = st.attached[DETACHABLE[i]] ? 1 : 0;
      if (on === lastAttached[i]) continue;
      lastAttached[i] = on;
      setAttached(DETACHABLE[i], !!on);
    }

    // --- tyres, and the corner sitting down on them ---
    let sagged = false;
    for (let i = 0; i < 4; i++) {
      const blown = !!st.blown[i];
      // A worn tyre is visibly low well before it lets go, which is the only
      // warning the player gets that one is about to.
      const deflate = blown ? 1 : clamp((1 - (st.tyre[i] ?? 1)) * 0.5, 0, 0.30);
      const key = blown ? 2 + deflate : deflate;
      if (Math.abs(key - lastTyre[i]) > 0.01) {
        lastTyre[i] = key;
        hubDrop[i] = setTyre(i, deflate, blown);
        corner[i].pivot.position.y = -hubDrop[i];
        sagged = true;
      }
      // Ride drop is the BODY going down: radius lost by the tyre plus
      // whatever the suspension has given up. Only the tyre part moves the hub,
      // so a collapsed spring closes the arch onto the wheel and a flat tyre
      // takes the whole corner down with it.
      const ride = fx ? fx.rideDrop[i]
        : (1 - (st.suspension[i] ?? 1)) * 0.06 + (blown ? 0.11 : 0);
      const d = clamp(ride > hubDrop[i] ? ride : hubDrop[i], 0, wr * 0.55);
      if (Math.abs(d - drop[i]) > 1e-4) { drop[i] = d; sagged = true; }
    }
    if (sagged && canSag) {
      // Fit a plane through the four corner drops and stand the body on it.
      // Wheel order is FL, FR, RL, RR; left is -X and front is -Z.
      const mean = (drop[0] + drop[1] + drop[2] + drop[3]) * 0.25;
      const leftRight = ((drop[0] + drop[2]) - (drop[1] + drop[3])) * 0.5;
      const frontRear = ((drop[0] + drop[1]) - (drop[2] + drop[3])) * 0.5;
      chassis.position.y = -mean;
      chassis.rotation.z = leftRight / tr;
      chassis.rotation.x = -frontRear / wb;
    }
  }

  /**
   * The drained event array from car.damage.drainEvents(), handed over by
   * main.js. Nothing here is required — update() reaches the same place from
   * the state on its own — but running it first puts a shatter or a lost
   * bumper on the exact frame the bang happened rather than the next one.
   */
  function applyEvents(events) {
    if (!live || !events) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.type === 'detach') {
        setAttached(e.part, false);
      } else if (e.type === 'glass-shatter' || e.type === 'glass-crack') {
        ensureGlass();
        const pane = paneOf.get(e.glass);
        if (!pane) continue;
        if (e.type === 'glass-shatter') pane.mesh.material = K.mats.shattered;
        else if (pane.mesh.material === pane.clean) pane.mesh.material = K.mats.crazed;
      } else if (e.type === 'light-smash') {
        setLight(e.light, true);
      } else if (e.type === 'tyre-burst') {
        hubDrop[e.wheel] = setTyre(e.wheel, 1, true);
        corner[e.wheel].pivot.position.y = -hubDrop[e.wheel];
      }
    }
  }

  function reset() {
    if (!live) return;
    lastPanel.fill(0);
    if (body) {
      body.delta.fill(0);
      body.pos.set(body.base);
      body.nrm.set(body.baseNrm);
      body.mag.fill(0);
      body.geo.attributes.position.needsUpdate = true;
      body.geo.attributes.normal.needsUpdate = true;
      body.hidden.fill(0);
      rebuildIndex();
      if (body.colour) updateScuff(0);
    }
    for (const [, pane] of paneOf) { pane.mesh.material = pane.clean; pane.mesh.visible = true; }
    for (const [, list] of lampOf) for (const e of list) e.mesh.material = e.clean;
    for (const [, list] of partOf) for (const m of list) m.visible = true;
    for (const part of OPENINGS) closeCavity(part);
    for (let i = 0; i < 4; i++) {
      const c = corner[i];
      if (c.tyre) { c.tyre.scale.set(1, 1, 1); if (c.hasRim && c.clean) c.tyre.material = c.clean; }
      if (c.shred) c.shred.visible = false;
      if (c.pivot) c.pivot.position.y = 0;
      drop[i] = 0; hubDrop[i] = 0; lastTyre[i] = 0;
    }
    // Guarded, because when carModel gave us no separate chassis group — which
    // is what an IMPORTED car from models.js looks like — `chassis` IS the car's
    // root group, and main.js drives that. Zeroing it here would teleport the
    // car to y = 0 and snap its heading to due north on every repair. update()
    // has always checked canSag before writing the sag; reset() and dispose()
    // have to check it before undoing one.
    if (canSag) { chassis.position.y = 0; chassis.rotation.set(0, 0, 0); }
    lastGlass.fill(0); lastLight.fill(0); lastAttached.fill(1);
    if (paintMat && sooted) paintMat.color.copy(cleanColour);
    lastScorch = 0; sooted = false;
  }

  function dispose() {
    // Idempotent, and it puts carModel back exactly as it was found: the shared
    // geometry goes back on the paint mesh, the merged meshes become visible
    // again, the wheels come out of their pivots. carModel.dispose() may run
    // before or after this and neither order can double-free anything.
    if (!live) return;
    live = false;
    // A bucket holding a single pane is adopted whole rather than split — a
    // van's backlight — so that mesh belongs to carModel and has to be handed
    // back wearing its own material, not one of this module's.
    for (const [, pane] of paneOf) { pane.mesh.material = pane.clean; pane.mesh.visible = true; }
    for (const list of [glassSplit, partsSplit, lampsSplit]) {
      if (!list) continue;
      for (const split of list) {
        for (const [, m] of split.parts) { m.removeFromParent(); m.geometry.dispose(); }
        split.source.visible = true;
      }
    }
    for (const part of OPENINGS) closeCavity(part);
    if (body) {
      if (body.overlay) { body.overlay.mesh.removeFromParent(); body.overlay.mat.dispose(); }
      if (paintMesh) paintMesh.geometry = body.src;
      body.geo.dispose();
      body = null;
    }
    for (let i = 0; i < 4; i++) {
      const c = corner[i];
      if (c.shred) { c.shred.removeFromParent(); c.shred = null; }
      if (c.tyre) { c.tyre.scale.set(1, 1, 1); if (c.hasRim && c.clean) c.tyre.material = c.clean; }
      if (c.pivot) { group.add(wheels[i]); c.pivot.removeFromParent(); c.pivot = null; }
    }
    if (shredGeo) { releaseShred(shredKey); shredGeo = null; }
    if (canSag) { chassis.position.y = 0; chassis.rotation.set(0, 0, 0); }
    if (paintMat && sooted) { paintMat.color.copy(cleanColour); sooted = false; }
    releaseKit();
  }

  return { update, applyEvents, reset, dispose };
}
