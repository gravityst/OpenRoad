import * as THREE from '/Users/curtis/Developer/OpenRoad/vendor/three/build/three.module.js';
import { createTerrain } from './.check.mjs';
import { buildWorld } from '../world/layout.js';
import { createGround } from '../world/ground.js';

const world = buildWorld(1337); world.buildLots();
const ground = createGround(world); world.buildProps(ground);
const T = createTerrain(world, ground, { quality: 'high' });
const p = new THREE.Vector3(0, 3, 0);
T.update(p, 1/60);
while (T.stats.pending > 0) T.update(p, 1/60);

// --- bounding spheres must contain every vertex (else chunks pop out of view) --
let over = 0, worstSlack = -1e9;
const v = new THREE.Vector3();
for (const m of T.group.children) {
  const g = m.geometry, pos = g.attributes.position.array, bs = g.boundingSphere;
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i+1], pos[i+2]);
    const d = v.distanceTo(bs.center) - bs.radius;
    if (d > 1e-4) over++;
    if (d > worstSlack) worstSlack = d;
  }
}
console.log('bounding sphere: vertices outside =', over, ' worst overshoot =', worstSlack.toFixed(4), 'm');

// --- LOD seam: does the skirt reach past the worst real crack? ---------------
// For each pair of side-by-side chunks at different LODs, measure the largest
// vertical gap along their shared edge and compare against the finer skirt.
const byKey = new Map();
for (const m of T.group.children) {
  const G = Math.round(Math.sqrt(m.geometry.attributes.position.array.length/3)) - 3;
  byKey.set(`${Math.round(m.position.x/128)},${Math.round(m.position.z/128)}`, { m, G });
}
function edgeY(o, side, t) {           // t in 0..1 along the shared edge
  const G = o.G, D = G + 3, pos = o.m.geometry.attributes.position.array;
  const k = t * G, i = Math.min(G - 1, Math.floor(k)), f = k - i;
  const at = (a, b) => pos[((a + 1) * D + (b + 1)) * 3 + 1];
  return side === 'x0' ? at(0, i) * (1-f) + at(0, i+1) * f
       : side === 'x1' ? at(G, i) * (1-f) + at(G, i+1) * f
       : side === 'z0' ? at(i, 0) * (1-f) + at(i+1, 0) * f
       :                 at(i, G) * (1-f) + at(i+1, G) * f;
}
let worstGap = 0, pairs = 0, breaches = 0;
for (const [key, a] of byKey) {
  const [cx, cz] = key.split(',').map(Number);
  const b = byKey.get(`${cx+1},${cz}`);
  if (!b || b.G === a.G) continue;
  pairs++;
  const fineG = Math.max(a.G, b.G), skirt = Math.max(3, (128 / fineG) * 1.25);
  for (let s = 0; s <= 200; s++) {
    const t = s / 200;
    const gap = Math.abs(edgeY(a, 'x1', t) - edgeY(b, 'x0', t));
    if (gap > worstGap) worstGap = gap;
    if (gap > skirt) breaches++;
  }
}
console.log(`LOD seams: ${pairs} mismatched-LOD chunk pairs, worst vertical gap ${worstGap.toFixed(3)} m, skirt breaches ${breaches}`);

// --- frame-time distribution while driving ---------------------------------
const times = [];
p.set(0, 3, 0);
for (let f = 0; f < 3600; f++) {
  p.z -= 40/60; p.x += 12/60;
  const t0 = performance.now();
  T.update(p, 1/60);
  times.push(performance.now() - t0);
}
times.sort((a,b)=>a-b);
const q = (x) => times[Math.min(times.length-1, Math.floor(times.length*x))].toFixed(2);
const sum = times.reduce((s,x)=>s+x,0);
console.log(`60 s drive: mean ${(sum/times.length).toFixed(3)} ms  p50 ${q(0.5)}  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${times[times.length-1].toFixed(2)} ms`);
console.log('frames over 3 ms:', times.filter(t=>t>3).length, 'of', times.length);

// --- steady-state allocation ------------------------------------------------
global.gc && global.gc();
const before = process.memoryUsage().heapUsed;
for (let f = 0; f < 600; f++) { p.z -= 0.001; T.update(p, 1/60); }   // no chunk crossing
const after = process.memoryUsage().heapUsed;
console.log('heap delta over 600 no-crossing frames:', ((after-before)/1024).toFixed(1), 'KB');

// --- what the colours actually are -----------------------------------------
const L2S = (c) => c <= 0.0031308 ? c*12.92 : 1.055*Math.pow(c, 1/2.4) - 0.055;
const hex = (o,i) => '#' + [0,1,2].map(k=>Math.round(L2S(o[i+k])*255).toString(16).padStart(2,'0')).join('');
const samples = [];
for (const m of T.group.children.slice(0, 9)) {
  const c = m.geometry.attributes.color.array;
  for (let i = 0; i < c.length; i += 3 * 997) samples.push(hex(c, i));
}
console.log('sample vertex colours (back to sRGB):', samples.slice(0, 14).join(' '));
T.dispose();
