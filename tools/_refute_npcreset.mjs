// Headless replay of main.js's traffic-damage lifecycle.
import { createCarModel } from '../src/render/carModel.js';
import { createCarDamage } from '../src/render/carDamage.js';
import { createDamage } from '../src/physics/damage.js';
import { createTraffic } from '../src/ai/traffic.js';

// --- a stand-in for the pool car objects main.js sees -----------------------
function poolCar(id, spec) {
  return { id, respawnId: 0, active: true, speed: 20, spec, halfLen: 2.2, x:0,y:0,z:0,yaw:0 };
}

const spec = { id:'hatch', track:1.62, wheelbase:2.5, length:4.0, width:1.72, height:1.45,
               rideHeight:0.28, wheelRadius:0.31, mass:1150 };

// (a) does createCarDamage throw on a traffic model with the low-detail opts?
let model, rig, threw = null;
try {
  model = createCarModel({ ...spec, body:'hatch', colour:0x3366aa });
  rig = createCarDamage(model, spec, { detail:'low', dents:true, scuffs:true, cavities:false });
  console.log('(a) createCarDamage low-detail: OK, methods =', Object.keys(rig).join(','));
} catch (e) { threw = e; console.log('(a) createCarDamage THREW:', e.message); }

// --- replicate main.js onTrafficHit + syncTrafficModels ---------------------
function makeSim({ hasCarDamage, hasModel }) {
  const trafficModels = [], trafficDamage = [], trafficRespawn = [];
  const npcEvents = [];
  let explosions = 0;
  const t = poolCar(3, spec);
  if (hasModel) trafficModels[3] = createCarModel({ ...spec, body:'hatch', colour:0x3366aa });
  else trafficModels[3] = null;

  function onTrafficHit(other, severity, lx, lz, closing) {           // main.js:907
    if (!other.damage) other.damage = createDamage(other.spec || {}); // :908
    const hw = (other.spec ? other.spec.track : 1.6) * 0.5;
    const hl = other.halfLen != null ? other.halfLen : 2.2;
    other.damage.impact(severity, lx, lz, hw, hl, closing);
    npcEvents.length = 0;
    other.damage.drainEvents(npcEvents);
    const mi = other.id;
    if (mi != null && trafficModels[mi] && trafficDamage[mi] === undefined && hasCarDamage) { // :917
      try {
        trafficDamage[mi] = createCarDamage(trafficModels[mi], other.spec || {},
          { detail:'low', dents:true, scuffs:true, cavities:false });
        trafficRespawn[mi] = other.respawnId;                          // :926
      } catch (err) { console.log('   rig failed:', err.message); trafficDamage[mi] = null; }
    }
    if (trafficDamage[mi] && npcEvents.length) trafficDamage[mi].applyEvents(npcEvents);
    const integ = other.damage.integrity;
    if (integ < 0.35) { other.wrecked = true; other.speed = Math.min(other.speed, 2); }  // :936
    else if (integ < 0.7) other.speed = Math.min(other.speed, 8);
    if (other.damage.state.onFire > 0 || integ < 0.22) {               // :938
      explosions++;
      other.damage.state.onFire = Math.max(other.damage.state.onFire, 0.5);
    }
  }
  function sync(dt) {                                                  // main.js:294
    const i = 3;
    const m = trafficModels[i];
    if (!m) return;
    if (trafficRespawn[i] !== undefined && trafficRespawn[i] !== t.respawnId) {  // :314
      trafficRespawn[i] = t.respawnId;
      if (trafficDamage[i]) trafficDamage[i].reset();
      if (t.damage) { t.damage.reset(); t.wrecked = false; }            // :317
    }
    if (trafficDamage[i] && t.damage) trafficDamage[i].update(t.damage.state, dt);
  }
  return { t, onTrafficHit, sync, get explosions() { return explosions; },
           trafficRespawn, trafficDamage };
}

for (const cfg of [{hasCarDamage:true, hasModel:true, label:'HEALTHY (carDamage loaded)'},
                   {hasCarDamage:false, hasModel:true, label:'DEGRADED (carDamage null)'}]) {
  const sim = makeSim(cfg);
  console.log('\n--- ' + cfg.label + ' ---');
  sim.sync(0.016);
  // hard hit: closing 24 m/s head-on into the nose
  sim.onTrafficHit(sim.t, 1.0, 0, 2.0, 24);
  sim.sync(0.016);
  console.log('  after hard hit: integrity=', sim.t.damage.integrity.toFixed(3),
              'onFire=', sim.t.damage.state.onFire.toFixed(2),
              'wrecked=', !!sim.t.wrecked, 'explosions=', sim.explosions,
              'trafficRespawn[3]=', sim.trafficRespawn[3]);
  // slot recycles: traffic.js place() bumps respawnId, touches nothing else
  sim.t.respawnId++; sim.t.active = true; sim.t.speed = 20;
  sim.sync(0.016);
  console.log('  after respawn : integrity=', sim.t.damage.integrity.toFixed(3),
              'onFire=', sim.t.damage.state.onFire.toFixed(2), 'wrecked=', !!sim.t.wrecked);
  // gentle 5 km/h nudge (closing 1.4 m/s -> sev 0.087)
  const before = sim.explosions;
  sim.onTrafficHit(sim.t, 1.4/16, 0, 2.0, 1.4);
  console.log('  gentle nudge  : explosions +' + (sim.explosions - before),
              ' speed=', sim.t.speed);
}

// --- how many hard hits does it take to latch onFire? ----------------------
for (const cfg of [{hasCarDamage:true, hasModel:true, label:'HEALTHY'},
                   {hasCarDamage:false, hasModel:true, label:'DEGRADED'}]) {
  const sim = makeSim(cfg);
  console.log('\n=== ' + cfg.label + ' : repeated hard hits ===');
  for (let k = 0; k < 6; k++) {
    sim.onTrafficHit(sim.t, 1.0, (k%2?1:-1)*0.5, 2.0, 26);
    sim.sync(0.016);
    console.log('   hit', k+1, 'integ=', sim.t.damage.integrity.toFixed(3),
                'onFire=', sim.t.damage.state.onFire.toFixed(2), 'expl=', sim.explosions);
  }
  sim.t.respawnId++; sim.sync(0.016);
  console.log('   AFTER RESPAWN: integ=', sim.t.damage.integrity.toFixed(3),
              'onFire=', sim.t.damage.state.onFire.toFixed(2), 'wrecked=', !!sim.t.wrecked);
  const b = sim.explosions;
  sim.onTrafficHit(sim.t, 0.087, 0, 2.0, 1.4);   // 5 km/h nudge
  console.log('   5km/h nudge after respawn -> explosions +' + (sim.explosions-b),
              ' speed=', sim.t.speed);
}
