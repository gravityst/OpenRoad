import * as THREE from '/Users/curtis/Developer/OpenRoad/vendor/three/build/three.module.js';
import { createTerrain } from './.check.mjs';
import { buildWorld } from '../world/layout.js';
import { createGround } from '../world/ground.js';

const t0 = Date.now();
const world = buildWorld(1337);
world.buildLots(); 
const ground = createGround(world);
world.buildProps(ground);
console.log('world+ground built in', Date.now() - t0, 'ms; CM enabled =', THREE.ColorManagement.enabled);

const cam = new THREE.Vector3(0, 3, 0);

for (const q of ['low', 'medium', 'high']) {
  const T = createTerrain(world, ground, { quality: q });
  const s0 = Date.now();
  let frames = 0;
  T.update(cam, 1 / 60);
  while (T.stats.pending > 0 && frames < 5000) { T.update(cam, 1 / 60); frames++; }
  const ms = Date.now() - s0;
  console.log(`${q.padEnd(6)} chunks=${String(T.stats.chunks).padStart(4)} tris=${String(T.stats.triangles).padStart(7)} view=${T.stats.viewDistance}m  coldBuild=${ms}ms over ${frames + 1} update() calls`);
  if (q === 'high') globalThis.__T = T; else T.dispose();
}

const T = globalThis.__T;

// --- heights must be exactly the surface the car drives on -----------------
let worst = 0, checked = 0;
for (const m of T.group.children) {
  const p = m.geometry.attributes.position.array;
  const D = Math.round(Math.sqrt(p.length / 3));
  const G = D - 3;
  if (G !== 64) continue;                       // near ring only
  for (let a = 1; a <= G + 1; a += 7) {
    for (let b = 1; b <= G + 1; b += 7) {
      const o = (a * D + b) * 3;
      const x = m.position.x + p[o], z = m.position.z + p[o + 2];
      worst = Math.max(worst, Math.abs(p[o + 1] - ground.heightAt(x, z)));
      checked++;
    }
  }
}
console.log('LOD0 vertex vs ground.heightAt: max |err| =', worst, 'over', checked, 'samples');

// --- winding: every top-face normal must point +Y --------------------------
const m0 = T.group.children[0];
const pos = m0.geometry.attributes.position.array;
const idx = m0.geometry.index.array;
const D0 = Math.round(Math.sqrt(pos.length / 3));
let bad = 0, tested = 0;
const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
for (let t = 0; t < idx.length; t += 3) {
  const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
  const ra = Math.floor(ia / D0), ca = ia % D0;
  if (ra < 1 || ca < 1 || ra > D0 - 2 || ca > D0 - 2) continue;   // skip skirt cells
  const rb = Math.floor(ib / D0), cb = ib % D0, rc = Math.floor(ic / D0), cc = ic % D0;
  if (rb < 1 || cb < 1 || rb > D0 - 2 || cb > D0 - 2) continue;
  if (rc < 1 || cc < 1 || rc > D0 - 2 || cc > D0 - 2) continue;
  A.fromArray(pos, ia * 3); B.fromArray(pos, ib * 3); C.fromArray(pos, ic * 3);
  e1.subVectors(B, A); e2.subVectors(C, A); n.crossVectors(e1, e2);
  tested++;
  if (n.y <= 0) bad++;
}
console.log('winding: top faces with normal.y<=0:', bad, 'of', tested);

// --- vertex colours in range ------------------------------------------------
let cmin = 9, cmax = -9, nanCount = 0, nrmBad = 0;
for (const m of T.group.children) {
  const c = m.geometry.attributes.color.array;
  const nr = m.geometry.attributes.normal.array;
  for (let i = 0; i < c.length; i++) { if (!Number.isFinite(c[i])) nanCount++; if (c[i] < cmin) cmin = c[i]; if (c[i] > cmax) cmax = c[i]; }
  for (let i = 0; i < nr.length; i += 3) { const L = Math.hypot(nr[i], nr[i+1], nr[i+2]); if (Math.abs(L - 1) > 1e-3) nrmBad++; }
}
console.log('vertex colour range', cmin.toFixed(4), '..', cmax.toFixed(4), ' non-finite:', nanCount, ' unnormalised normals:', nrmBad);

// --- LOD seam: how far can a coarse chunk deviate at a shared edge? ---------
// Worst-case gap = |coarse linear interpolation - true height| along a border.
let gap = 0;
for (let k = 0; k < 4000; k++) {
  const x = (Math.random() * 2 - 1) * 1900, z = (Math.random() * 2 - 1) * 1900;
  const step = 16;
  const x0 = Math.floor(x / step) * step;
  const t = (x - x0) / step;
  const lin = ground.heightAt(x0, z) * (1 - t) + ground.heightAt(x0 + step, z) * t;
  gap = Math.max(gap, Math.abs(lin - ground.heightAt(x, z)));
}
console.log('worst 16 m-LOD interpolation error:', gap.toFixed(2), 'm  (skirt at that LOD is 20 m)');

// --- steady state: cost of driving across chunks ---------------------------
let moved = 0, worstFrame = 0, allocFrames = 0;
const p = new THREE.Vector3(0, 3, 0);
const s1 = Date.now();
for (let f = 0; f < 1800; f++) {          // 30 s at 60 fps, 40 m/s along -Z
  p.z -= 40 / 60;
  const f0 = Date.now();
  T.update(p, 1 / 60);
  const d = Date.now() - f0;
  if (d > worstFrame) worstFrame = d;
  moved += d;
}
console.log(`30 s drive at 40 m/s: ${moved} ms total in update(), worst single frame ${worstFrame} ms; chunks=${T.stats.chunks} tris=${T.stats.triangles}`);
T.setQuality('low');
T.update(p, 1 / 60);
while (T.stats.pending > 0) T.update(p, 1 / 60);
console.log('after setQuality(low):', T.stats.chunks, 'chunks', T.stats.triangles, 'tris', T.stats.viewDistance + 'm');
T.dispose();
console.log('after dispose:', T.group.children.length, 'children,', T.stats.chunks, 'chunks');
