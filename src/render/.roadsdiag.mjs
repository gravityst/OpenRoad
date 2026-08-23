function makeCanvas(){const c={width:1,height:1};c.getContext=()=>({globalAlpha:1,fillStyle:'#000',
 createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData(){},fillRect(){},drawImage(){}});return c;}
globalThis.document={createElement:()=>makeCanvas()};
const { buildWorld, pointOnEdge } = await import('../world/layout.js');
const { createGround } = await import('../world/ground.js');
const { createRoads } = await import('./.roadscheck.mjs');
const world = buildWorld(); const ground = createGround(world);
const roads = createRoads(world, ground);

const C=16, key=(a,b)=>a*100003+b, cells=new Map(), T=[];
for (const m of roads.group.children) {
  const p=m.geometry.attributes.position.array, n=m.geometry.attributes.normal.array;
  for (let i=0;i<p.length;i+=9){ if(n[i+1]<0.5) continue;
    const t=[p[i],p[i+2],p[i+1], p[i+3],p[i+5],p[i+4], p[i+6],p[i+8],p[i+7]];
    const ti=T.length; T.push(t);
    const x0=Math.min(t[0],t[3],t[6]),x1=Math.max(t[0],t[3],t[6]);
    const z0=Math.min(t[1],t[4],t[7]),z1=Math.max(t[1],t[4],t[7]);
    for(let a=Math.floor(x0/C);a<=Math.floor(x1/C);a++)for(let b=Math.floor(z0/C);b<=Math.floor(z1/C);b++){
      const k=key(a,b);let L=cells.get(k);if(!L)cells.set(k,L=[]);L.push(ti);} }
}
// Interpolate y inside the triangle instead of taking a corner's y.
function nearestSurface(x,z,want){
  const L=cells.get(key(Math.floor(x/C),Math.floor(z/C))); if(!L) return null;
  let best=null;
  for(const ti of L){ const t=T[ti];
    const d=(t[4]-t[7])*(t[0]-t[6])+(t[6]-t[3])*(t[1]-t[7]); if(Math.abs(d)<1e-9)continue;
    const l1=((t[4]-t[7])*(x-t[6])+(t[6]-t[3])*(z-t[7]))/d;
    const l2=((t[7]-t[1])*(x-t[6])+(t[0]-t[6])*(z-t[7]))/d; const l3=1-l1-l2;
    if(l1<-1e-4||l2<-1e-4||l3<-1e-4)continue;
    const y=l1*t[2]+l2*t[5]+l3*t[8];
    if(best===null||Math.abs(y-want)<Math.abs(best-want))best=y;
  } return best;
}
const hist=[0,0,0,0,0]; let worst=[]; let n=0;
for (const e of world.edges) {
  for (let s=3;s<e.length;s+=7) {
    const p=pointOnEdge(e,s);
    for (const f of [-0.7,-0.35,0,0.35,0.7]) {
      const x=p.x+p.nx*(e.width/2)*f, z=p.z+p.nz*(e.width/2)*f;
      const want=ground.heightAt(x,z)+0.04;
      const y=nearestSurface(x,z,want); if(y===null)continue;
      const d=Math.abs(y-want); n++;
      hist[d<0.02?0:d<0.06?1:d<0.15?2:d<0.5?3:4]++;
      if(d>0.3) worst.push([d,e.kind,x|0,z|0,s|0]);
    }
  }
}
worst.sort((a,b)=>b[0]-a[0]);
console.log('samples',n);
console.log('  <2cm',hist[0],' <6cm',hist[1],' <15cm',hist[2],' <50cm',hist[3],' >=50cm',hist[4]);
console.log('worst 8:', worst.slice(0,8).map(w=>`${w[0].toFixed(2)}m ${w[1]} @${w[2]},${w[3]}`).join('  '));
// how many of the worst sit where two roads genuinely overlap?
let ov=0;
for (const w of worst.slice(0,200)) {
  let k=0; for (const e of world.edges) { const r=ground.roadAt(w[2],w[3]); if(r.onRoad)k++; break; }
  const near=world.edges.filter(e=>e.pts.some(q=>Math.hypot(q.x-w[2],q.z-w[3])<e.width*0.6)).length;
  if (near>1) ov++;
}
console.log('of worst 200, sitting under 2+ overlapping carriageways:', ov);
