import { createDamage } from '../src/physics/damage.js';
const spec = { id:'hatch', track:1.62, wheelbase:2.5, length:4.0, width:1.72, height:1.45, mass:1150 };
const d = createDamage(spec);
const hw = spec.track*0.5, hl = 2.2;
for (let k = 0; k < 400; k++) {
  const lx = ((k*0.37) % 2 - 1) * hw * 1.4;
  const lz = ((k*0.61) % 2 - 1) * hl * 1.4;
  d.impact(1, lx, lz, hw, hl, 40);
  const ev=[]; d.drainEvents(ev);
}
console.log('floor integrity:', d.integrity.toFixed(4), '| onFire:', d.state.onFire,
            '| <0.22?', d.integrity < 0.22, '| <0.35?', d.integrity < 0.35);
