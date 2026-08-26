import { createDamage } from '../src/physics/damage.js';
const spec = { id:'hatch', track:1.62, wheelbase:2.5, length:4.0, width:1.72, height:1.45, mass:1150 };
const hw = spec.track*0.5, hl = 2.2;
for (const sev of [1.0, 0.75, 0.5]) {
  const d = createDamage(spec);
  let n22 = -1, n35 = -1;
  for (let k = 0; k < 2000; k++) {
    const lx = ((k*0.37) % 2 - 1) * hw * 1.4;
    const lz = ((k*0.61) % 2 - 1) * hl * 1.4;
    d.impact(sev, lx, lz, hw, hl, sev*16);
    const ev=[]; d.drainEvents(ev);
    if (n35 < 0 && d.integrity < 0.35) n35 = k+1;
    if (n22 < 0 && d.integrity < 0.22) { n22 = k+1; break; }
  }
  console.log(`sev=${sev}: hits to wrecked(<0.35)=${n35}, hits to explode(<0.22)=${n22}`);
}
