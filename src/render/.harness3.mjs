function makeCanvas(){const c={width:1,height:1};c.getContext=()=>({globalAlpha:1,fillStyle:'#000',
 createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData(){},fillRect(){},drawImage(){}});return c;}
globalThis.document={createElement:()=>makeCanvas()};
const { buildWorld, pointOnEdge } = await import('../world/layout.js');
const { createGround } = await import('../world/ground.js');
const world = buildWorld(); const ground = createGround(world);

// Is the ground field actually flat across a carriageway? That was the whole
// justification for a two-vertex cross-section.
const byKind = {};
for (const e of world.edges) {
  const k = e.kind; if (!byKind[k]) byKind[k] = { worst: 0, n: 0, sum: 0, where: null };
  // distance from this sample to the nearest 3+ way node, so junctions can be split out
  for (let s = 4; s < e.length - 4; s += 11) {
    const p = pointOnEdge(e, s);
    const h = e.width / 2;
    const yl = ground.heightAt(p.x - p.nx * h, p.z - p.nz * h);
    const yr = ground.heightAt(p.x + p.nx * h, p.z + p.nz * h);
    for (const f of [-0.7, -0.35, 0, 0.35, 0.7]) {
      const x = p.x + p.nx * h * f, z = p.z + p.nz * h * f;
      const lin = yl + (yr - yl) * ((f + 1) / 2);
      const d = Math.abs(ground.heightAt(x, z) - lin);
      const b = byKind[k]; b.n++; b.sum += d;
      if (d > b.worst) { b.worst = d; b.where = [x.toFixed(0), z.toFixed(0), (s).toFixed(0)]; }
    }
  }
}
for (const k of Object.keys(byKind)) {
  const b = byKind[k];
  console.log(k.padEnd(8), 'mean', (b.sum / b.n).toFixed(3), 'worst', b.worst.toFixed(2), 'at', b.where);
}
