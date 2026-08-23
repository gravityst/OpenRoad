// Temporary. Stubs just enough Canvas2D to run createRoads headlessly.
function makeCanvas() {
  const c = { width: 1, height: 1 };
  c.getContext = () => ({
    globalAlpha: 1, fillStyle: '#000',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, fillRect() {}, drawImage() {},
  });
  return c;
}
globalThis.document = { createElement: () => makeCanvas() };

const { buildWorld } = await import('../world/layout.js');
const { createGround } = await import('../world/ground.js');
const { createRoads } = await import('./.check.mjs');

let t = Date.now();
const world = buildWorld();
const ground = createGround(world);
console.log('world+ground ms', Date.now() - t);

let len = 0;
const kinds = {};
for (const e of world.edges) { len += e.length; kinds[e.kind] = (kinds[e.kind] || 0) + 1; }
console.log('edges', world.edges.length, 'nodes', world.nodes.length,
  'junctions', world.nodes.filter(n => n.edges.length >= 3).length,
  'road km', (len / 1000).toFixed(1), kinds);

t = Date.now();
const roads = createRoads(world, ground);
console.log('createRoads ms', Date.now() - t);
console.log('stats', roads.stats);

// Geometry sanity: every triangle must face up-ish or be a kerb face, and
// nothing may sit far from the physics surface.
let bad = 0, downFacing = 0, worstOff = 0, checked = 0;
const box = { minY: Infinity, maxY: -Infinity };
for (const m of roads.group.children) {
  const p = m.geometry.attributes.position.array;
  const n = m.geometry.attributes.normal.array;
  const uv = m.geometry.attributes.uv.array;
  for (let i = 0; i < p.length; i += 3) {
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2])) bad++;
    if (!Number.isFinite(n[i]) || !Number.isFinite(n[i + 1])) bad++;
    box.minY = Math.min(box.minY, p[i + 1]); box.maxY = Math.max(box.maxY, p[i + 1]);
  }
  for (let i = 0; i < uv.length; i++) if (uv[i] < -0.001 || uv[i] > 1.001) bad++;
  for (let i = 0; i < n.length; i += 9) if (n[i + 1] < -0.02) downFacing++;
}
// Sample the ribbon surface against ground.heightAt on real road points.
for (const e of world.edges) {
  for (let s = 2; s < e.length; s += 37) {
    const pts = e.pts; let k = 0;
    while (k < pts.length - 2 && pts[k + 1].s < s) k++;
    const tt = (s - pts[k].s) / Math.max(1e-4, pts[k + 1].s - pts[k].s);
    const x = pts[k].x + (pts[k + 1].x - pts[k].x) * tt;
    const z = pts[k].z + (pts[k + 1].z - pts[k].z) * tt;
    worstOff = Math.max(worstOff, Math.abs(ground.heightAt(x, z) - (pts[k].y + (pts[k + 1].y - pts[k].y) * tt)));
    checked++;
  }
}
console.log('non-finite/out-of-range', bad, 'down-facing tris', downFacing);
console.log('y range', box.minY.toFixed(1), box.maxY.toFixed(1));
console.log('field-vs-profile worst', worstOff.toFixed(3), 'm over', checked, 'samples');

// Culling behaves.
const shown = (x, z) => { roads.update({ x, y: 0, z }, 1); return roads.group.children.filter(m => m.visible).length; };
console.log('visible @centre', shown(0, 0), 'of', roads.group.children.length);
roads.setQuality('low');
console.log('visible @centre low', shown(0, 0));
roads.setQuality('ultra');
console.log('visible @corner ultra', shown(1900, 1900));
roads.dispose();
console.log('after dispose children', roads.group.children.length);
