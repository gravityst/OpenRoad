// Checks the traffic actually behaves like traffic.
//
// Traffic is the difference between a world and a diorama, and it fails in ways
// that are obvious to a player and invisible to a unit test: cars on the wrong
// side of the road, cars driving through each other, cars stopped forever at a
// junction, cars spawning on top of the player. Each is checked here against
// the real road graph.
//
// The side-of-the-road test is the fiddly one and worth spelling out. A road
// polyline has no direction of travel — traffic uses it both ways — so "wrong
// side" cannot be read off the tangent alone. It is: take the car's own
// heading, decide whether it is travelling with or against the tangent, and
// require its lateral offset to be on the correspondingly correct side.
import { buildWorld } from '../src/world/layout.js';
import { createGround } from '../src/world/ground.js';
import { createTraffic } from '../src/ai/traffic.js';

const w = buildWorld();
const g = createGround(w);
const traffic = createTraffic(w, g, { density: 50 });
const dt = 1 / 60;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`);
  if (!ok) fail++;
};

let px = 0, pz = -1250;
let maxAlive = 0, moving = 0, sweeps = 0;
let wrongSide = 0, sideSamples = 0;
let sameLaneOverlaps = 0, offRoad = 0, samples = 0, stationary = 0, transientTouches = 0;
let wasOverlapping = new Set();
let nowOverlapping = new Set();
let nearPlayerSpawn = 0;
const seen = new Set();
const road = {};

for (let step = 0; step < 60 * 90; step++) {          // 90 seconds of driving
  const a = step * 0.0016;
  px = Math.cos(a) * 1250;
  pz = Math.sin(a) * 1250;
  traffic.update(dt, px, pz, 22);

  const live = (traffic.cars || []).filter((c) => c.active !== false);
  maxAlive = Math.max(maxAlive, live.length);
  if (step % 30) continue;
  sweeps++;

  for (const c of live) {
    if (!seen.has(c)) {
      seen.add(c);
      if (Math.hypot(c.x - px, c.z - pz) < 22) nearPlayerSpawn++;
    }
    if (c.speed > 0.5) moving++;
    if (c.speed < 0.2) stationary++;
    samples++;

    g.roadAt(c.x, c.z, road);
    if (!road.edge || road.dist > road.width * 0.62) { offRoad++; continue; }

    // Which side of the centreline, relative to the way this car is going.
    const near = g.nearestRoad(c.x, c.z, 40);
    if (!near || road.dist < 0.5) continue;
    const fwdX = -Math.sin(c.yaw), fwdZ = -Math.cos(c.yaw);
    const along = fwdX * near.tx + fwdZ * near.tz;         // with or against
    if (Math.abs(along) < 0.5) continue;                   // mid-turn: no verdict
    // Right of the tangent is (-tz, tx) in this coordinate system.
    const offset = (c.x - near.x) * -near.tz + (c.z - near.z) * near.tx;
    sideSamples++;
    if (Math.sign(offset) !== Math.sign(along)) wrongSide++;
  }

  // Cars in the same space. Two crossing at a junction are legitimately close,
  // and two merging can touch for an instant — neither is visible at speed.
  // What matters is a pair that STAYS inside each other, so overlaps are only
  // counted once they persist across consecutive sweeps.
  nowOverlapping.clear();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j];
      if (Math.hypot(A.x - B.x, A.z - B.z) > 2.6) continue;
      const dot = Math.cos(A.yaw) * Math.cos(B.yaw) + Math.sin(A.yaw) * Math.sin(B.yaw);
      if (dot <= 0.7) continue;                            // crossing, not merging
      const id = `${Math.min(i, j)}:${Math.max(i, j)}:${A.respawnId || 0}:${B.respawnId || 0}`;
      nowOverlapping.add(id);
      if (wasOverlapping.has(id)) sameLaneOverlaps++;      // still stuck together
      transientTouches++;
    }
  }
  const swap = wasOverlapping;
  wasOverlapping = nowOverlapping;
  nowOverlapping = swap;
}

check('traffic stays populated around the player', maxAlive >= 12, `peak ${maxAlive} cars alive`);
check('traffic actually moves', moving > sweeps * 4, `${moving} moving samples over ${sweeps} sweeps`);
check('traffic stays on the road', offRoad / Math.max(1, samples) < 0.06,
  `${offRoad}/${samples} off the carriageway (${(offRoad / Math.max(1, samples) * 100).toFixed(2)}%)`);
check('traffic keeps right', wrongSide / Math.max(1, sideSamples) < 0.05,
  `${wrongSide}/${sideSamples} on the wrong side (${(wrongSide / Math.max(1, sideSamples) * 100).toFixed(2)}%)`);
check('no car stays inside another', sameLaneOverlaps === 0,
  `${sameLaneOverlaps} sustained, ${transientTouches} momentary merge contacts over ${sweeps} sweeps`);
check('nothing spawns on top of the player', nearPlayerSpawn === 0, `${nearPlayerSpawn} spawns within 22 m`);
check('traffic is not permanently stopped', stationary / Math.max(1, samples) < 0.35,
  `${(stationary / Math.max(1, samples) * 100).toFixed(1)}% of samples stationary`);

const t0 = performance.now();
for (let i = 0; i < 600; i++) traffic.update(dt, px, pz, 22);
const per = (performance.now() - t0) / 600;
check('update() is cheap enough for 60 fps', per < 1.2,
  `${per.toFixed(3)} ms per frame with ${maxAlive} cars`);

console.log(fail === 0 ? '\nAll traffic checks passed.' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail ? 1 : 0);
