// The party games, in the world.
//
//   RACE   the next checkpoint arch across the road with a light curtain in
//          it, and the one after standing dim beyond, in the race's amber —
//          the same shape as a solo race's arches (render/gates.js), with the
//          number on the banner. The finish is chequered.
//   TAG    the car that is IT is marked: a crisp red ring on the ground round
//          it, a ripple going out from it, and a red pointer spinning over its
//          roof. Yours gets the rings but not the pointer, which from the chase
//          camera sat in the middle of the road ahead. (Its column of light, for finding
//          it from far away, is beacons.js's, made thick and red.) Deliberately
//          NOT a glow round the body: the first version was a soft red-orange
//          halo, and on screen a car wrapped in red-orange light is a car on
//          fire, which this game never shows.
//   COINS  big spinning gold coins on the road, each under a gold column of
//          light you can see from across the valley; a coin that is taken
//          leaps up and vanishes on every screen at once.
//
// COST. Two arches, two rings and a pointer for IT, sixteen coins as one
// InstancedMesh plus sixteen light columns. Nothing allocated per frame.

import * as THREE from 'three';

const RACE = new THREE.Color(0xffb43c);
const TAG = new THREE.Color(0xff4d3a);
const GOLD = new THREE.Color(0xffd84a);
const MAX_COINS = 16;
const COIN_R = 1.6;             // m: a coin you can see from a car at 100 km/h
const PILLAR_H = 160;           // m

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A banner: dark panel, the word, amber rules — chequered ends on the finish. */
function bannerTex(word, finish) {
  return canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, w, h);
    const sq = 16;
    if (finish) {
      for (let y = 0; y < h; y += sq) for (let x = 0; x < w; x += sq) {
        if (((x + y) / sq) % 2) { g.fillStyle = '#f4f6f8'; g.fillRect(x, y, sq, sq); }
      }
      g.fillStyle = '#0d1117';
      g.fillRect(160, 14, w - 320, h - 28);
    }
    g.fillStyle = '#ffb43c';
    g.fillRect(finish ? 160 : 0, 0, finish ? w - 320 : w, 10);
    g.fillRect(finish ? 160 : 0, h - 10, finish ? w - 320 : w, 10);
    g.font = '900 76px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(word, w / 2, h / 2 + 4);
  });
}

function curtainTex() {
  return canvasTex(8, 128, (g, w, h) => {
    const grd = g.createLinearGradient(0, h, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.18, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0.0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
}

/** A column of light, bright at the foot, gone by the top. */
function pillarTex() {
  return canvasTex(32, 128, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const up = 1 - y / h;
      for (let x = 0; x < w; x++) {
        const s = Math.abs(x / (w - 1) - 0.5) * 2;
        const a = Math.min(1, (Math.exp(-s * s * 7) + 0.3 * Math.exp(-s * s * 1.5)) * Math.pow(1 - up, 1.3));
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** The coin's face: a gold disc, a raised rim, a star. */
function coinFaceTex() {
  return canvasTex(128, 128, (g, w) => {
    const c = w / 2;
    const grd = g.createRadialGradient(c * 0.8, c * 0.7, 4, c, c, c);
    grd.addColorStop(0, '#fff3a8');
    grd.addColorStop(0.55, '#ffcd2e');
    grd.addColorStop(1, '#b77c05');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, w);
    g.strokeStyle = 'rgba(120,70,0,0.55)';
    g.lineWidth = 7;
    g.beginPath(); g.arc(c, c, c * 0.78, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(140,86,0,0.75)';
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? c * 0.24 : c * 0.52;
      const a = -Math.PI / 2 + k * Math.PI / 5;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  });
}

/**
 * opts: { quality, heightAt(x, z) }
 * update(dt, camera, modes, self, room)
 *   modes   game/modes.js (its view)
 *   self    where this car is drawn ({x, y, z})
 *   room    net.room, for the remote cars
 */
export function createModeFx(scene, opts = {}) {
  const low = opts.quality === 'low';
  const heightAt = typeof opts.heightAt === 'function' ? opts.heightAt : () => 0;
  const group = new THREE.Group();
  group.name = 'party-games';
  scene.add(group);
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
  const unitPlane = keep(new THREE.PlaneGeometry(1, 1));
  const pillarMat = keep(new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.55, metalness: 0.4 }));
  const neon = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(RACE.r * 3.2, RACE.g * 3.2, RACE.b * 3.2) }));
  const curtainT = keep(curtainTex());
  const pillarT = keep(pillarTex());

  // ---- race arches -------------------------------------------------------------
  const bannerMats = new Map();       // label -> material
  function bannerMat(label) {
    let m = bannerMats.get(label);
    if (!m) {
      const t = keep(bannerTex(label, label === 'FINISH'));
      m = keep(new THREE.MeshBasicMaterial({ map: t }));
      bannerMats.set(label, m);
    }
    return m;
  }
  const curtainMat = keep(new THREE.MeshBasicMaterial({
    map: curtainT, color: new THREE.Color(RACE.r * 1.7, RACE.g * 1.7, RACE.b * 1.7), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  const H = 6.4;
  function makeArch() {
    const g = new THREE.Group();
    const pillars = [], strips = [];
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(unitBox, pillarMat);
      p.castShadow = !low;
      const s = new THREE.Mesh(unitBox, neon);
      g.add(p, s);
      pillars.push(p); strips.push(s);
    }
    const banner = new THREE.Mesh(unitBox, [pillarMat, pillarMat, pillarMat, pillarMat, pillarMat, pillarMat]);
    const curtain = new THREE.Mesh(unitPlane, curtainMat);
    curtain.renderOrder = 4;
    g.add(banner, curtain);
    g.visible = false;
    group.add(g);
    return { g, pillars, strips, banner, curtain, hw: -1, label: '' };
  }
  const arches = [makeArch(), makeArch()];
  function fit(a, hw, label) {
    if (a.hw !== hw) {
      const half = hw + 1.1;
      for (let k = 0; k < 2; k++) {
        const side = k ? 1 : -1;
        a.pillars[k].scale.set(0.6, H, 0.6);
        a.pillars[k].position.set(side * half, H / 2, 0);
        a.strips[k].scale.set(0.14, H - 1.6, 0.66);
        a.strips[k].position.set(side * (half - 0.32), (H - 1.6) / 2 + 0.1, 0);
      }
      a.banner.scale.set(half * 2 + 0.6, 1.35, 0.35);
      a.banner.position.set(0, H - 0.6, 0);
      a.curtain.scale.set(half * 2, 5.2, 1);
      a.curtain.position.set(0, 2.6, 0);
      a.hw = hw;
    }
    if (a.label !== label) {
      const m = bannerMat(label);
      a.banner.material = [pillarMat, pillarMat, pillarMat, pillarMat, m, m];
      a.label = label;
    }
  }

  // ---- the IT marker -----------------------------------------------------------------
  // A flat ring on the ground (a band, not a tube, so it reads as paint on
  // the road rather than a hoop), a second one rippling out and fading, and a
  // four-sided pointer over the roof, point down, turning.
  const ringGeo = keep(new THREE.RingGeometry(0.9, 1, 64));
  ringGeo.rotateX(-Math.PI / 2);
  // Only a little over 1: ACES tone mapping bends a bright saturated red
  // towards orange, and at 2.6x the ring came out salmon.
  const itRingMat = keep(new THREE.MeshBasicMaterial({
    color: new THREE.Color(TAG.r * 1.25, TAG.g * 1.25, TAG.b * 1.25), transparent: true, opacity: 0.9,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10,
  }));
  const rippleMat = keep(new THREE.MeshBasicMaterial({
    color: new THREE.Color(TAG.r * 1.1, TAG.g * 1.1, TAG.b * 1.1), transparent: true, opacity: 0.6,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10,
  }));
  const itRing = new THREE.Mesh(ringGeo, itRingMat);
  itRing.renderOrder = 4;
  const itRipple = new THREE.Mesh(ringGeo, rippleMat);
  itRipple.renderOrder = 4;
  const pointerGeo = keep(new THREE.ConeGeometry(0.42, 0.85, 4, 1));
  pointerGeo.rotateX(Math.PI);                        // point down, at the car
  const pointerMat = keep(new THREE.MeshStandardMaterial({
    color: 0xe8261a, emissive: 0xc8150c, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1, flatShading: true,
  }));
  const pointer = new THREE.Mesh(pointerGeo, pointerMat);
  const itGroup = new THREE.Group();
  itGroup.add(itRing, itRipple, pointer);
  itGroup.visible = false;
  group.add(itGroup);

  // ---- coins ------------------------------------------------------------------------
  const coinGeo = keep(new THREE.CylinderGeometry(COIN_R, COIN_R, 0.34, 40));
  coinGeo.rotateX(Math.PI / 2);          // face forward (+Z), edge up
  const faceT = keep(coinFaceTex());
  const coinEdge = keep(new THREE.MeshStandardMaterial({ color: 0xd9a514, metalness: 0.85, roughness: 0.28, emissive: 0x5a3a00, emissiveIntensity: 0.6 }));
  const coinFace = keep(new THREE.MeshStandardMaterial({ map: faceT, metalness: 0.7, roughness: 0.3, emissive: 0xffc21a, emissiveIntensity: 0.35, emissiveMap: faceT }));
  const coins = new THREE.InstancedMesh(coinGeo, [coinEdge, coinFace, coinFace], MAX_COINS);
  coins.count = 0;
  coins.frustumCulled = false;
  coins.castShadow = !low;
  group.add(coins);
  const pillarGeo = keep(new THREE.PlaneGeometry(1, 1));
  pillarGeo.translate(0, 0.5, 0);
  const pillarMats = [], pillars = [];
  for (let i = 0; i < MAX_COINS; i++) {
    const m = keep(new THREE.MeshBasicMaterial({
      map: pillarT, color: new THREE.Color(GOLD.r * 1.6, GOLD.g * 1.6, GOLD.b * 1.6), transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    const p = new THREE.Mesh(pillarGeo, m);
    p.visible = false;
    p.frustumCulled = false;
    p.renderOrder = 3;
    group.add(p);
    pillarMats.push(m); pillars.push(p);
  }
  const takenAt = new Float32Array(MAX_COINS).fill(-1);
  const coinY = new Float32Array(MAX_COINS);
  let coinGid = -1;

  const camPos = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  let time = 0;

  function update(dt, camera, modes, self, room) {
    time += dt;
    const v = modes ? modes.view : null;
    camera.getWorldPosition(camPos);

    // ---- race arches: my next checkpoint, and the one after -------------
    const c = v && v.kind === 'race' && v.inGame && !v.finished && v.race && (v.phase === 'run' || v.phase === 'grid') ? v.race : null;
    for (let k = 0; k < 2; k++) {
      const a = arches[k];
      const gi = c ? v.next + k : -1;
      const gate = c ? c.gates[gi] : null;
      if (!gate) { a.g.visible = false; continue; }
      const last = gi === c.gates.length - 1;
      fit(a, gate.hw || 4.75, last ? 'FINISH' : `CHECKPOINT ${gi + 1}`);
      a.g.position.set(gate.x, gate.y != null ? gate.y : heightAt(gate.x, gate.z), gate.z);
      a.g.rotation.set(0, Math.atan2(-gate.tx, -gate.tz), 0);
      a.g.visible = true;
      a.curtain.visible = k === 0;
    }
    if (c) curtainMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(time * 5));

    // ---- IT --------------------------------------------------------------------
    let itCar = null;
    if (v && v.kind === 'tag' && v.phase === 'run' && v.it >= 0) {
      if (v.iAmIt) itCar = self;
      else if (room) { const rc = room.car(v.it); if (rc && rc.active && rc.fade > 0) itCar = rc; }
    }
    itGroup.visible = !!itCar;
    if (itCar) {
      const gy = heightAt(itCar.x, itCar.z);
      itGroup.position.set(itCar.x, gy, itCar.z);
      const br = 0.5 + 0.5 * Math.sin(time * 5.2);
      itRing.scale.set(3.3, 1, 3.3); itRing.position.y = 0.12;
      itRingMat.opacity = 0.65 + 0.3 * br;
      const k = (time * 0.8) % 1;                          // a ripple going out every 1.25 s
      const r2 = 3.3 + k * 6;
      itRipple.scale.set(r2, 1, r2); itRipple.position.y = 0.1;
      rippleMat.opacity = 0.6 * (1 - k) * (1 - k);
      pointer.visible = !v.iAmIt;
      pointer.position.set(0, 2.9 + 0.2 * Math.sin(time * 3), 0);
      pointer.rotation.set(0, time * 2.2, 0);
    }

    // ---- coins -------------------------------------------------------------------
    const pts = v && v.kind === 'coins' && v.pts && v.phase !== 'done' ? v.pts : null;
    if (!pts) {
      coins.count = 0;
      for (const p of pillars) p.visible = false;
      coinGid = -1;
    } else {
      if (coinGid !== v.gid) {
        coinGid = v.gid;
        takenAt.fill(-1);
        for (let i = 0; i < pts.length && i < MAX_COINS; i++) coinY[i] = heightAt(pts[i][0], pts[i][1]);
      }
      let n = 0;
      for (let i = 0; i < pts.length && i < MAX_COINS; i++) {
        const taken = !!(v.taken && v.taken[i]);
        if (taken && takenAt[i] < 0) takenAt[i] = time;
        const since = taken ? time - takenAt[i] : 0;
        const p = pillars[i];
        if (taken && since > 0.6) { p.visible = false; continue; }
        const x = pts[i][0], z = pts[i][1];
        // Bob and spin; a taken coin leaps up and shrinks away.
        const up = taken ? since * 9 : 0;
        const k = taken ? Math.max(0.01, 1 - since / 0.6) : 1;
        v3.set(x, coinY[i] + 2.3 + 0.35 * Math.sin(time * 2.2 + i) + up, z);
        e3.set(0, time * 2.4 + i, 0);
        q.setFromEuler(e3);
        s3.set(k, k, k);
        m4.compose(v3, q, s3);
        coins.setMatrixAt(n++, m4);
        const dist = Math.hypot(camPos.x - x, camPos.z - z);
        p.visible = true;
        p.position.set(x, coinY[i], z);
        p.rotation.set(0, Math.atan2(camPos.x - x, camPos.z - z), 0);
        const w = Math.max(2.2, dist * 0.02);
        p.scale.set(w, PILLAR_H, 1);
        // Faint up close (it is the coin you look at then), full from afar.
        pillarMats[i].opacity = (taken ? k : 1) * Math.min(0.85, 0.2 + dist / 120);
      }
      coins.count = n;
      coins.instanceMatrix.needsUpdate = true;
      for (let i = pts.length; i < MAX_COINS; i++) pillars[i].visible = false;
    }
  }

  function dispose() {
    group.removeFromParent();
    coins.dispose();
    for (const d of disposables) if (d && d.dispose) d.dispose();
  }

  return { group, update, dispose };
}
