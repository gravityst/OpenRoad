// Temporary. Coverage test: is there tarmac under every point of every road?
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

const { buildWorld, pointOnEdge } = await import('../world/layout.js');
const { createGround } = await import('../world/ground.js');
const { createRoads } = await import('./.roadscheck.mjs');

const world = buildWorld();
const ground = createGround(world);
const roads = createRoads(world, ground);

// Spatial hash of upward-facing triangles only (kerb faces are vertical).
const C = 16, key = (a, b) => a * 100003 + b;
const cells = new Map();
const T = [];
for (const m of roads.group.children) {
  const p = m.geometry.attributes.position.array;
  const n = m.geometry.attributes.normal.array;
  for (let i = 0; i < p.length; i += 9) {
    if (n[i + 1] < 0.5) continue;
    const t = [p[i], p[i + 2], p[i + 3], p[i + 5], p[i + 6], p[i + 8], p[i + 1]];
    const ti = T.length; T.push(t);
    const x0 = Math.min(t[0], t[2], t[4]), x1 = Math.max(t[0], t[2], t[4]);
    const z0 = Math.min(t[1], t[3], t[5]), z1 = Math.max(t[1], t[3], t[5]);
    for (let a = Math.floor(x0 / C); a <= Math.floor(x1 / C); a++)
      for (let b = Math.floor(z0 / C); b <= Math.floor(z1 / C); b++) {
        const k = key(a, b); let L = cells.get(k); if (!L) cells.set(k, L = []); L.push(ti);
      }
  }
}
function covered(x, z, want) {
  const L = cells.get(key(Math.floor(x / C), Math.floor(z / C)));
  if (!L) return null;
  let best = null, hits = 0;
  for (const ti of L) {
    const [ax, az, bx, bz, cx, cz, y] = T[ti];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4) {
      hits++;
      if (best === null || (want !== undefined && Math.abs(y - want) < Math.abs(best - want))) best = y;
    }
  }
  overlaps += hits > 1 ? 1 : 0;
  probes += hits > 0 ? 1 : 0;
  return best;
}
let overlaps = 0, probes = 0;

let holes = 0, tested = 0, worstLift = 0, liftBad = 0;
const report = [];
for (const e of world.edges) {
  for (let s = 0; s <= e.length; s += 4) {
    const p = pointOnEdge(e, Math.min(s, e.length));
    tested++;
    const y = covered(p.x, p.z);
    if (y === null) { holes++; if (report.length < 6) report.push(`${e.kind} s=${s.toFixed(0)}/${e.length.toFixed(0)} @${p.x.toFixed(0)},${p.z.toFixed(0)}`); }
  }
}
for (const n of world.nodes) {
  if (n.edges.length < 3) continue;
  tested++;
  if (covered(n.x, n.z) === null) { holes++; if (report.length < 6) report.push(`junction node ${n.i}`); }
}
console.log('centreline coverage:', tested - holes, '/', tested, 'holes', holes, report);

// Does the drawn surface sit exactly 4 cm over the physics surface?
for (const e of world.edges) {
  for (let s = 6; s < e.length; s += 23) {
    const p = pointOnEdge(e, s);
    const off = 0.35 * e.width * (s % 2 ? 1 : -1);
    const x = p.x + p.nx * off, z = p.z + p.nz * off;
    const y = covered(x, z, ground.heightAt(x, z) + 0.04);
    if (y === null) continue;
    const d = Math.abs(y - (ground.heightAt(x, z) + 0.04));
    if (d > worstLift) worstLift = d;
    if (d > 0.06) liftBad++;
  }
}
console.log('worst |drawn - (heightAt + 0.04)| =', worstLift.toFixed(4), 'm; samples over 6 cm:', liftBad);
console.log('probes landing on 2+ overlapping surfaces:', overlaps, '/', probes);
