// What the goals look like in the world: race arches, start rings and light
// beacons, speed-camera gantries, jump ramps, drift-zone banners, tokens, and
// the GPS — chevrons painted along the road and an arrow over the car.
//
// Everything a kid is meant to drive TO has to be visible from far enough away
// to drive to it. So each challenge carries a light pillar, the one the GPS is
// pointing at is exempt from the fog and reads from well over a kilometre, and
// the next race gate has a lit curtain across the road that is impossible to
// mistake for scenery.
//
// GLOW IS REAL BLOOM. effects.js runs UnrealBloom with a threshold of about 2.1
// in LINEAR light (see explosion.js), so a colour clamped to 1 never glows —
// it tone-maps to a flat painted look. The neon here is given HDR colours of
// 2.5-4 so it blooms like a lit sign, and the same material stays legible as a
// saturated colour when post-processing is off.
//
// COST. Static pieces are a few dozen meshes that are hidden by distance; the
// tokens are one InstancedMesh and one Points cloud; the chevrons are one
// InstancedMesh of 28. Per frame this touches ~80 matrices and allocates
// nothing. 'low' quality drops the halos, the non-target beams and a third of
// the chevrons.

import * as THREE from 'three';

const COL = {
  race: new THREE.Color(0xffb43c), trap: new THREE.Color(0xff4a4a), jump: new THREE.Color(0x4fe38a),
  drift: new THREE.Color(0xe45cff), token: new THREE.Color(0xffcf3a), gps: new THREE.Color(0x4fd8f0),
};
const MEDAL_COL = [null, new THREE.Color(0xd08a4c), new THREE.Color(0xd9e2ea), new THREE.Color(0xffd23f)];

const SHOW_R = 900;          // m within which static markers are drawn
const CHEVRONS = 28;
const CHEV_GAP = 7;          // m between chevrons
const BEAM_H = 140;

function hdr(c, k) { return new THREE.Color(c.r * k, c.g * k, c.b * k); }

// ---- textures, all procedural ----------------------------------------------

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A banner: dark panel, chequered ends, the word in the middle. */
function bannerTex(word, accent) {
  return canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, w, h);
    const sq = 16;
    for (const x0 of [0, w - 96]) {
      for (let y = 0; y < h; y += sq) {
        for (let x = 0; x < 96; x += sq) {
          g.fillStyle = ((x + y) / sq) % 2 ? '#f4f6f8' : '#0d1117';
          g.fillRect(x0 + x, y, sq, sq);
        }
      }
    }
    g.fillStyle = accent;
    g.fillRect(96, 0, w - 192, 10);
    g.fillRect(96, h - 10, w - 192, 10);
    g.font = '900 78px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(word, w / 2, h / 2 + 4);
  });
}

/** Vertical light: bright core, fading out sideways and upwards. */
function beamTex() {
  return canvasTex(64, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const up = 1 - y / h;                       // canvas row 0 is the TOP
      const fall = Math.pow(1 - up, 1.6) * 0.9 + 0.1 * (1 - up);
      for (let x = 0; x < w; x++) {
        const s = Math.abs(x / (w - 1) - 0.5) * 2;
        const core = Math.exp(-s * s * 9) + 0.35 * Math.exp(-s * s * 2.2);
        const a = Math.min(1, core * fall);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Soft round glow, for token halos and flashes. */
function glowTex() {
  return canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
}

/** A light curtain across a gate: bright at the road, gone by the banner. */
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

/** Ramp deck: grip-coated steel, hazard edges, arrows up the face. */
function deckTex() {
  const t = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#3a3f46';
    g.fillRect(0, 0, w, h);
    // Tread plate texture.
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let y = 6; y < h; y += 14) for (let x = (y / 14) % 2 ? 4 : 11; x < w; x += 14) g.fillRect(x, y, 6, 2);
    // Hazard stripes on both edges.
    for (const x0 of [0, w - 26]) {
      g.save();
      g.beginPath(); g.rect(x0, 0, 26, h); g.clip();
      for (let y = -40; y < h + 40; y += 28) {
        g.fillStyle = '#f2c230';
        g.beginPath();
        g.moveTo(x0, y); g.lineTo(x0 + 26, y - 14); g.lineTo(x0 + 26, y); g.lineTo(x0, y + 14);
        g.closePath(); g.fill();
      }
      g.restore();
    }
    // Arrows up the face (canvas top = the lip).
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let y = 60; y < h - 20; y += 120) {
      g.beginPath();
      g.moveTo(w / 2, y); g.lineTo(w / 2 + 50, y + 44); g.lineTo(w / 2 + 26, y + 44);
      g.lineTo(w / 2, y + 22); g.lineTo(w / 2 - 26, y + 44); g.lineTo(w / 2 - 50, y + 44);
      g.closePath(); g.fill();
    }
  });
  return t;
}

/** Token face: a star on gold. */
function coinTex() {
  return canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w * 0.4, h * 0.35, 4, w / 2, h / 2, w / 2);
    grd.addColorStop(0, '#fff3b0');
    grd.addColorStop(0.6, '#ffc623');
    grd.addColorStop(1, '#b8760c');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#8a5a06';
    g.lineWidth = 6;
    g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff8d8';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 18 : 42;
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
  });
}

function signTex(title, sub, accent) {
  return canvasTex(256, 192, (g, w, h) => {
    g.fillStyle = accent;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0d1117';
    g.fillRect(8, 8, w - 16, h - 16);
    g.fillStyle = accent;
    g.font = '900 58px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(title, w / 2, h * 0.38);
    g.fillStyle = '#ffffff';
    g.font = '700 30px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    g.fillText(sub, w / 2, h * 0.72);
  });
}

// ---------------------------------------------------------------------------

/**
 * opts.baseHeight  (x, z) => ground height WITHOUT the ramps (ramps.js wraps
 *                  the live query; the ramp mesh must stand on the road)
 * opts.quality     'low' | 'medium' | 'high'
 */
export function createGoalGates(scene, opts = {}) {
  const quality = opts.quality || 'medium';
  const low = quality === 'low';
  const baseHeight = opts.baseHeight || (() => 0);
  const group = new THREE.Group();
  group.name = 'goals';
  scene.add(group);

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  // ---- shared geometry and materials ---------------------------------------
  const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
  const unitPlane = keep(new THREE.PlaneGeometry(1, 1));
  const pillarMat = keep(new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.55, metalness: 0.4 }));
  const poleMat = keep(new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.7 }));
  const beamT = keep(beamTex());
  const glowT = keep(glowTex());
  const curtainT = keep(curtainTex());

  const neon = {};
  for (const k of Object.keys(COL)) {
    neon[k] = keep(new THREE.MeshBasicMaterial({ color: hdr(COL[k], 3.2), toneMapped: true }));
  }

  function bannerMat(word, kind) {
    const tex = keep(bannerTex(word, '#' + COL[kind].getHexString()));
    return keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: true }));
  }
  const banners = {
    start: bannerMat('START', 'race'),
    checkpoint: bannerMat('CHECKPOINT', 'gps'),
    finish: bannerMat('FINISH', 'race'),
    drift: bannerMat('DRIFT ZONE', 'drift'),
    driftEnd: bannerMat('ZONE END', 'drift'),
  };

  /** An arch across the road: two pillars, neon on their inner faces, a banner. */
  function makeArch(hw, banner, kind) {
    const g = new THREE.Group();
    const half = hw + 1.1;
    const H = 6.4;
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(unitBox, pillarMat);
      p.scale.set(0.6, H, 0.6);
      p.position.set(side * half, H / 2, 0);
      p.castShadow = !low;
      g.add(p);
      const strip = new THREE.Mesh(unitBox, neon[kind]);
      strip.scale.set(0.14, H - 1.6, 0.66);
      strip.position.set(side * (half - 0.32), (H - 1.6) / 2 + 0.1, 0);
      g.add(strip);
    }
    const b = new THREE.Mesh(unitBox, [pillarMat, pillarMat, pillarMat, pillarMat, banner, banner]);
    b.scale.set(half * 2 + 0.6, 1.35, 0.35);
    b.position.set(0, H - 0.6, 0);
    b.castShadow = !low;
    g.add(b);
    g.userData.half = half;
    return g;
  }

  /**
   * Stands obj on the road facing along (tx, tz): local -Z becomes the
   * direction of travel (the codebase's forward), so local +X is the driver's
   * right and local +Z faces the traffic coming towards it.
   */
  function placeAcross(obj, x, y, z, tx, tz) {
    obj.position.set(x, y, z);
    // Local -Z is "forward" in this codebase; the arch's X spans the road when
    // its forward is the road's tangent.
    obj.rotation.set(0, Math.atan2(-tx, -tz), 0);
  }

  // ---- per-challenge statics --------------------------------------------------
  const statics = [];       // { obj, x, z, r }
  const byId = new Map();   // id -> { ring, beam, ringMat, beamMat, kind, c }
  const recs = [];          // the same records, for the frame loop to walk by index
  const ringGeo = keep(new THREE.TorusGeometry(1, 0.045, 8, 64));
  const beamGeo = keep(new THREE.PlaneGeometry(1, 1));
  beamGeo.translate(0, 0.5, 0);

  function beacon(c) {
    const kind = c.kind;
    const s = c.start;
    const ringMat = keep(new THREE.MeshBasicMaterial({
      color: hdr(COL[kind], 2.6), transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const ring = new THREE.Mesh(ringGeo, ringMat);
    const r = (s.hw || 4) + 4;
    ring.scale.set(r, r, 6);
    ring.rotation.x = Math.PI / 2;
    const y = baseHeight(s.x, s.z);
    ring.position.set(s.x, y + 0.35, s.z);
    ring.renderOrder = 3;
    group.add(ring);

    const beamMat = keep(new THREE.MeshBasicMaterial({
      map: beamT, color: hdr(COL[kind], 1.8), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    const beam = new THREE.Group();
    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(beamGeo, beamMat);
      m.scale.set(7, BEAM_H, 1);
      m.rotation.y = k * Math.PI / 2;
      m.renderOrder = 4;
      beam.add(m);
    }
    beam.position.set(s.x, y, s.z);
    group.add(beam);
    const rec = { ring, beam, ringMat, beamMat, kind, c, r, medal: 0, x: s.x, z: s.z, isTarget: false };
    byId.set(c.id, rec);
    recs.push(rec);
    return rec;
  }

  // Race: a START arch on the line, visible whenever you are near it.
  function raceStatics(c) {
    const arch = makeArch(c.start.hw, banners.start, 'race');
    placeAcross(arch, c.start.x, baseHeight(c.start.x, c.start.z), c.start.z, c.start.tx, c.start.tz);
    group.add(arch);
    statics.push({ obj: arch, x: c.start.x, z: c.start.z, r: SHOW_R });
  }

  // Trap: a camera gantry on the right-hand verge, the lens looking back down
  // the run-up, and a line across the road where it measures.
  const trapFlash = new Map();
  const flashes = [];
  function trapStatics(c) {
    const g = new THREE.Group();
    const half = c.hw;
    const pole = new THREE.Mesh(unitBox, poleMat);
    pole.scale.set(0.28, 6.2, 0.28);
    pole.position.set(half + 1.4, 3.1, 0);
    pole.castShadow = !low;
    const arm = new THREE.Mesh(unitBox, poleMat);
    arm.scale.set(half + 1.6, 0.22, 0.22);
    arm.position.set((half + 1.4) / 2 + 0.2, 6.0, 0);
    const box = new THREE.Mesh(unitBox, pillarMat);
    box.scale.set(0.9, 0.7, 1.3);
    box.position.set(half * 0.35, 5.55, 0);
    box.castShadow = !low;
    const lens = new THREE.Mesh(unitBox, neon.trap);
    lens.scale.set(0.42, 0.34, 0.08);
    lens.position.set(half * 0.35, 5.55, 0.68);
    const signMat = keep(new THREE.MeshBasicMaterial({ map: keep(signTex('SPEED', 'TRAP', '#ff4a4a')) }));
    const sign = new THREE.Mesh(unitPlane, signMat);
    sign.scale.set(1.9, 1.4, 1);
    sign.position.set(half + 1.4, 4.2, 0.2);
    const line = new THREE.Mesh(unitPlane, keep(new THREE.MeshBasicMaterial({
      color: hdr(COL.trap, 2.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    line.scale.set(half * 2, 0.6, 1);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.08, 0);
    line.renderOrder = 3;
    const flashMat = keep(new THREE.SpriteMaterial({ map: glowT, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const flash = new THREE.Sprite(flashMat);
    flash.scale.set(9, 9, 1);
    flash.position.set(half * 0.35, 5.55, 0.9);
    g.add(pole, arm, box, lens, sign, line, flash);
    // Pole on the driver's right, lens and sign facing the run-up.
    placeAcross(g, c.x, baseHeight(c.x, c.z), c.z, c.tx, c.tz);
    group.add(g);
    statics.push({ obj: g, x: c.x, z: c.z, r: SHOW_R });
    const fl = { mat: flashMat, t: 0 };
    trapFlash.set(c.id, fl);
    flashes.push(fl);
  }

  // Jump: the ramp itself, built from the same profile the physics drives on,
  // plus a sign on the run-up.
  const deckT = keep(deckTex());
  const deckMat = keep(new THREE.MeshStandardMaterial({ map: deckT, roughness: 0.7, metalness: 0.35 }));
  const sideMat = keep(new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide }));
  const lipMat = neon.jump;
  function rampMesh(r) {
    const N = 16;
    const us = [];
    for (let i = 0; i <= N; i++) us.push((i / N) * r.L);
    us.push(r.L + r.B);
    const prof = (u) => (u <= r.L ? r.H * (u / r.L) * (u / r.L) : r.H * (1 - (u - r.L) / r.B));
    const pos = [], uv = [], idx = [];
    const sidePos = [], sideIdx = [];
    const at = (u, v, lift) => {
      const x = r.x + r.tx * u + r.nx * v, z = r.z + r.tz * u + r.nz * v;
      return [x, baseHeight(x, z) + lift, z];
    };
    // Deck: two vertices per station.
    for (let i = 0; i < us.length; i++) {
      const u = us[i];
      const h = prof(u) + 0.02;
      for (const v of [-r.halfW, r.halfW]) {
        const p = at(u, v, h);
        pos.push(p[0], p[1], p[2]);
        uv.push(v < 0 ? 0 : 1, Math.min(1, u / r.L));
      }
    }
    // (b - a) x (c - a) = n x t = up: the deck faces the sky.
    for (let i = 0; i < us.length - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    // Sides: deck edge down to the road, both sides.
    for (const v of [-r.halfW, r.halfW]) {
      const base = sidePos.length / 3;
      for (let i = 0; i < us.length; i++) {
        const u = us[i];
        const top = at(u, v, prof(u) + 0.02), bot = at(u, v, -0.05);
        sidePos.push(top[0], top[1], top[2], bot[0], bot[1], bot[2]);
      }
      for (let i = 0; i < us.length - 1; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        // Wound so each wall faces outward: left wall -n, right wall +n.
        if (v < 0) sideIdx.push(a, c, b, b, c, d); else sideIdx.push(a, b, c, b, d, c);
      }
    }
    const deck = new THREE.BufferGeometry();
    deck.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    deck.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    deck.setIndex(idx);
    deck.computeVertexNormals();
    const sides = new THREE.BufferGeometry();
    sides.setAttribute('position', new THREE.Float32BufferAttribute(sidePos, 3));
    sides.setIndex(sideIdx);
    sides.computeVertexNormals();
    keep(deck); keep(sides);
    const g = new THREE.Group();
    const dm = new THREE.Mesh(deck, deckMat);
    dm.castShadow = !low; dm.receiveShadow = true;
    const sm = new THREE.Mesh(sides, sideMat);
    sm.castShadow = !low;
    g.add(dm, sm);
    // A lit bar along the lip, so the edge reads at speed and at night.
    const lip = new THREE.Mesh(unitBox, lipMat);
    const lp = at(r.L, 0, r.H + 0.05);
    lip.scale.set(r.W, 0.1, 0.12);
    lip.position.set(lp[0], lp[1], lp[2]);
    lip.rotation.y = Math.atan2(-r.tx, -r.tz);
    g.add(lip);
    return g;
  }
  function jumpStatics(c, r) {
    if (!r) return;
    const ramp = rampMesh(r);
    group.add(ramp);
    statics.push({ obj: ramp, x: r.x, z: r.z, r: SHOW_R });
    const signMat = keep(new THREE.MeshBasicMaterial({ map: keep(signTex('JUMP', 'RAMP AHEAD', '#4fe38a')), side: THREE.DoubleSide }));
    const sign = new THREE.Group();
    const board = new THREE.Mesh(unitPlane, signMat);
    board.scale.set(2.2, 1.65, 1);
    board.position.set(0, 2.6, 0);
    const post = new THREE.Mesh(unitBox, poleMat);
    post.scale.set(0.12, 1.9, 0.12);
    post.position.set(0, 0.95, -0.05);
    sign.add(board, post);
    const back = 45;
    const sx = r.x - r.tx * back + r.nx * (c.hw + 1.6), sz = r.z - r.tz * back + r.nz * (c.hw + 1.6);
    sign.position.set(sx, baseHeight(sx, sz), sz);
    // Local +Z (the board's face) toward the traffic arriving along +t.
    sign.rotation.y = Math.atan2(-r.tx, -r.tz);
    group.add(sign);
    statics.push({ obj: sign, x: sx, z: sz, r: SHOW_R });
  }

  function driftStatics(c) {
    const a = makeArch(c.gate.hw, banners.drift, 'drift');
    placeAcross(a, c.gate.x, baseHeight(c.gate.x, c.gate.z), c.gate.z, c.gate.tx, c.gate.tz);
    const b = makeArch(c.end.hw, banners.driftEnd, 'drift');
    placeAcross(b, c.end.x, baseHeight(c.end.x, c.end.z), c.end.z, c.end.tx, c.end.tz);
    group.add(a, b);
    statics.push({ obj: a, x: c.gate.x, z: c.gate.z, r: SHOW_R }, { obj: b, x: c.end.x, z: c.end.z, r: SHOW_R });
  }

  // ---- race gates: a pool of two, moved along as the race goes -------------------
  const racePool = [];
  const curtainMat = keep(new THREE.MeshBasicMaterial({
    map: curtainT, color: hdr(COL.gps, 1.7), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  function poolArch(i) {
    if (racePool[i]) return racePool[i];
    const g = new THREE.Group();
    const arch = makeArch(5, banners.checkpoint, 'gps');
    const curtain = new THREE.Mesh(unitPlane, curtainMat);
    curtain.renderOrder = 4;
    g.add(arch, curtain);
    g.visible = false;
    group.add(g);
    racePool[i] = { g, arch, curtain, hw: 5, banner: 'checkpoint', slot: i };
    return racePool[i];
  }
  // Arches by (width, banner), built once each: a stage alternates between
  // gravel and tarmac widths, and rebuilding at every gate is churn.
  const archCache = new Map();
  function fitArch(p, hw, bannerKey) {
    if (p.hw !== hw || p.banner !== bannerKey) {
      const key = `${p.slot}:${hw}:${bannerKey}`;
      let arch = archCache.get(key);
      if (!arch) {
        arch = makeArch(hw, banners[bannerKey], bannerKey === 'finish' ? 'race' : 'gps');
        archCache.set(key, arch);
      }
      p.g.remove(p.arch);
      p.arch = arch;
      p.g.add(p.arch);
      p.hw = hw; p.banner = bannerKey;
    }
    const half = hw + 1.1;
    p.curtain.scale.set(half * 2, 5.2, 1);
    p.curtain.position.set(0, 2.6, 0);
  }

  // ---- tokens -----------------------------------------------------------------------
  let tokenMesh = null, tokenPts = null, tokenList = [], taken = null;
  // Seconds since each token was collected, or -1. A typed array rather than
  // a list of records, because placeTokens() runs every frame.
  let collectT = new Float32Array(0);
  const coinFace = keep(coinTex());
  function buildTokens(tokens, tk) {
    tokenList = tokens;
    taken = tk;
    collectT = new Float32Array(tokens.length).fill(-1);
    if (!tokens.length) return;
    const geo = keep(new THREE.CylinderGeometry(0.95, 0.95, 0.18, 28));
    geo.rotateX(Math.PI / 2);
    const edge = keep(new THREE.MeshStandardMaterial({ color: 0xffc233, metalness: 0.9, roughness: 0.3, emissive: 0xff9d00, emissiveIntensity: 0.6 }));
    const face = keep(new THREE.MeshStandardMaterial({ map: coinFace, metalness: 0.6, roughness: 0.35, emissive: 0xffb300, emissiveIntensity: 0.55, emissiveMap: coinFace }));
    tokenMesh = new THREE.InstancedMesh(geo, [edge, face, face], tokens.length);
    tokenMesh.frustumCulled = false;
    group.add(tokenMesh);
    if (!low) {
      const pos = new Float32Array(tokens.length * 3);
      const pg = keep(new THREE.BufferGeometry());
      pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pm = keep(new THREE.PointsMaterial({
        map: glowT, color: hdr(COL.token, 1.6), size: 7, sizeAttenuation: true,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      tokenPts = new THREE.Points(pg, pm);
      tokenPts.frustumCulled = false;
      group.add(tokenPts);
    }
    placeTokens(0);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  function placeTokens(time) {
    if (!tokenMesh) return;
    const pos = tokenPts ? tokenPts.geometry.attributes.position : null;
    for (let i = 0; i < tokenList.length; i++) {
      const t = tokenList[i];
      let scale = 1, lift = 0;
      const ct = collectT[i];
      if (ct >= 0) { const k = Math.min(1, ct / 0.45); scale = k >= 1 ? 0 : 1 + k * 1.4; lift = k * 3.5; }
      else if (taken[i]) scale = 0;
      const bob = Math.sin(time * 2.2 + i) * 0.22;
      e3.set(0, time * 2.4 + i * 0.7, 0);
      q.setFromEuler(e3);
      v3.set(t.x, t.y + 1.5 + bob + lift, t.z);
      s3.set(scale, scale, scale);
      m4.compose(v3, q, s3);
      tokenMesh.setMatrixAt(i, m4);
      if (pos) pos.setXYZ(i, t.x, scale > 0 ? t.y + 1.5 + bob + lift : -9999, t.z);
    }
    tokenMesh.instanceMatrix.needsUpdate = true;
    if (pos) pos.needsUpdate = true;
  }

  // ---- GPS: chevrons on the road, and the arrow over the car ------------------------
  const chevGeo = (() => {
    // A flat chevron in the XZ plane, pointing along -Z.
    const s = new THREE.Shape();
    s.moveTo(0, -0.9); s.lineTo(1.25, 0.35); s.lineTo(0.8, 0.75); s.lineTo(0, -0.05);
    s.lineTo(-0.8, 0.75); s.lineTo(-1.25, 0.35); s.closePath();
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(Math.PI / 2);        // shape Y -> world Z
    return keep(g);
  })();
  const chevMat = keep(new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    // Stronger than the road ribbon's own offset (-2, -4 at +4 cm, roads.js),
    // or the ribbon wins the depth test and the chevrons vanish under it.
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10, side: THREE.DoubleSide,
  }));
  const nChev = low ? 18 : CHEVRONS;
  const chevrons = new THREE.InstancedMesh(chevGeo, chevMat, nChev);
  chevrons.frustumCulled = false;
  chevrons.renderOrder = 5;
  chevrons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nChev * 3), 3);
  group.add(chevrons);
  const chevCol = new THREE.Color();
  const routeP = {}, routeQ = {};

  // The arrow over the car. Measured from the chase camera (7.4 m back, 3 m
  // up) a flat arrow at roof height is seen almost exactly edge-on — the first
  // version read as a white slab hovering over the bonnet. So it is chunky,
  // shaded rather than flat-lit (the shading is what tells the eye which way a
  // solid points), sits just above the roof a little ahead of the car, and is
  // tipped 24 degrees nose-up towards the camera so its top face is what you
  // see. Its colour is a saturated cyan emissive, not an HDR white: it should
  // read as an object, not as a hole in the picture.
  const arrow = (() => {
    const s = new THREE.Shape();
    s.moveTo(0, -1.0); s.lineTo(0.78, -0.12); s.lineTo(0.3, -0.12); s.lineTo(0.3, 0.72);
    s.lineTo(-0.3, 0.72); s.lineTo(-0.3, -0.12); s.lineTo(-0.78, -0.12); s.closePath();
    const geo = keep(new THREE.ExtrudeGeometry(s, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 2 }));
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0.17, 0);
    const mat = keep(new THREE.MeshStandardMaterial({
      color: 0x18a9c9, emissive: 0x27d3f2, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.15,
      transparent: true, opacity: 1,
    }));
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 6;
    m.visible = false;
    m.rotation.order = 'YXZ';
    group.add(m);
    return { m, mat, yaw: 0, alpha: 0 };
  })();

  // ---- build and update ---------------------------------------------------------------

  function build({ challenges, tokens, ramps, taken: tk }) {
    for (const c of challenges) {
      beacon(c);
      if (c.kind === 'race') raceStatics(c);
      else if (c.kind === 'trap') trapStatics(c);
      else if (c.kind === 'jump') jumpStatics(c, ramps[c.rampIndex]);
      else if (c.kind === 'drift') driftStatics(c);
    }
    buildTokens(tokens || [], tk || new Uint8Array((tokens || []).length));
  }

  let raceC = null;
  let flashT = 0, flashG = null;

  function update(dt, vs) {
    const time = vs.time;
    const cx = vs.car.x, cz = vs.car.z;

    for (const s of statics) {
      const dx = s.x - cx, dz = s.z - cz;
      s.obj.visible = dx * dx + dz * dz < s.r * s.r;
    }

    // Beacons: the target's is tall, bright and cuts through the fog; the rest
    // are shown near enough to be worth a detour. During a race, only the race.
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const isTarget = vs.target === rec.c;
      // Fog is compiled into the shader, so it is switched only when the
      // target changes, with a recompile — never flipped every frame.
      if (isTarget !== rec.isTarget) {
        rec.isTarget = isTarget;
        rec.beamMat.fog = !isTarget;
        rec.beamMat.needsUpdate = true;
      }
      const dx = rec.x - cx, dz = rec.z - cz;
      const d2 = dx * dx + dz * dz;
      const racing = !!vs.race;
      // Mid-race the gates do the guiding; a forest of other beacons would
      // only compete with the next one.
      const show = !racing && (isTarget || (!low && d2 < 1100 * 1100));
      rec.beam.visible = show;
      rec.ring.visible = !racing && (isTarget || d2 < 600 * 600);
      if (rec.beam.visible) {
        rec.beamMat.opacity = isTarget ? 0.75 + 0.2 * pulse : 0.32;
        rec.beam.scale.set(isTarget ? 1.6 : 1, isTarget ? 1 : 0.55, isTarget ? 1.6 : 1);
        rec.beam.rotation.y = time * 0.2;
      }
      if (rec.ring.visible) {
        rec.ringMat.opacity = 0.55 + 0.4 * pulse;
        const k = 1 + 0.04 * pulse;
        rec.ring.scale.set(rec.r * k, rec.r * k, 6);
      }
    }

    // Race gates: next one lit with its curtain, the one after dim.
    const race = vs.race;
    if (race !== raceC) { raceC = race; for (const p of racePool) p.g.visible = false; }
    if (race) {
      for (let k = 0; k < 2; k++) {
        const gi = vs.nextGate + k;
        const p = poolArch(k);
        const gate = race.gates[gi];
        if (!gate) { p.g.visible = false; continue; }
        const last = gi === race.gates.length - 1;
        fitArch(p, gate.hw, last ? 'finish' : 'checkpoint');
        placeAcross(p.g, gate.x, gate.y, gate.z, gate.tx, gate.tz);
        p.g.visible = true;
        p.curtain.visible = k === 0;
      }
      curtainMat.opacity = 0.55 + 0.35 * pulse;
    }
    if (flashT > 0) {
      flashT -= dt;
      curtainMat.color.copy(COL.gps).multiplyScalar(1.7 + 6 * Math.max(0, flashT));
    }

    // Trap flashes.
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      if (f.t > 0) { f.t -= dt; f.mat.opacity = Math.max(0, f.t / 0.25); }
    }

    // Tokens.
    for (let i = 0; i < collectT.length; i++) if (collectT[i] >= 0) collectT[i] = Math.min(1, collectT[i] + dt);
    placeTokens(time);

    // Chevrons along the GPS line, marching forward.
    const route = vs.route;
    let shown = 0;
    if (route && vs.driving) {
      const flow = (time * 9) % CHEV_GAP;
      for (let k = 0; k < nChev; k++) {
        const d = vs.routeD + 10 + k * CHEV_GAP + flow;
        if (d > vs.routeEnd - 2) break;
        route.at(d, routeP);
        route.at(Math.min(vs.routeEnd, d + 1.2), routeQ);
        const y0 = liveHeight(routeP.x, routeP.z), y1 = liveHeight(routeQ.x, routeQ.z);
        const pitch = Math.atan2(y1 - y0, Math.max(0.3, Math.hypot(routeQ.x - routeP.x, routeQ.z - routeP.z)));
        e3.set(pitch, Math.atan2(-routeP.tx, -routeP.tz), 0, 'YXZ');
        q.setFromEuler(e3);
        v3.set(routeP.x, y0 + 0.12, routeP.z);
        const sc = Math.min(1.25, (routeP.hw || 4) / 4);
        s3.set(sc, 1, sc);
        m4.compose(v3, q, s3);
        chevrons.setMatrixAt(shown, m4);
        // Fade in near the car, out at the far end; additive, so dimming the
        // colour is fading it.
        const near = Math.min(1, (d - vs.routeD - 6) / 14);
        const far = 1 - k / nChev;
        const a = Math.max(0, Math.min(1, near) * (0.35 + 0.65 * far));
        chevCol.copy(COL.gps).multiplyScalar(1.35 * a);
        chevrons.setColorAt(shown, chevCol);
        shown++;
      }
    }
    chevrons.count = shown;
    chevrons.instanceMatrix.needsUpdate = true;
    if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;

    // The arrow: over the car, pointing at the road 30 m on.
    const wantArrow = !!(vs.arrow && vs.driving && !vs.race);
    arrow.alpha += ((wantArrow ? 1 : 0) - arrow.alpha) * Math.min(1, dt * 5);
    arrow.m.visible = arrow.alpha > 0.02;
    if (arrow.m.visible) {
      const car = vs.car;
      const want = Math.atan2(-(vs.arrowX - car.x), -(vs.arrowZ - car.z));
      let dy = want - arrow.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      arrow.yaw += dy * Math.min(1, dt * 8);
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      arrow.m.position.set(car.x + fx * 1.6, car.y + 1.75 + Math.sin(time * 3) * 0.06, car.z + fz * 1.6);
      arrow.m.rotation.set(0.42, arrow.yaw, 0);
      arrow.mat.opacity = arrow.alpha;
      const s = 0.8 + 0.2 * arrow.alpha;
      arrow.m.scale.set(s, s, s);
    }
  }

  const liveHeight = opts.heightAt || baseHeight;

  function collect(i) { if (i >= 0 && i < collectT.length) collectT[i] = 0; }
  function flashGate() { flashT = 0.35; }
  function flashTrap(id) { const f = trapFlash.get(id); if (f) f.t = 0.25; }
  function setMedal(id, medal) {
    const rec = byId.get(id);
    if (!rec) return;
    rec.medal = medal || 0;
    // A won challenge's ring takes its medal's colour; an unwon one keeps its kind's.
    if (medal) rec.ringMat.color.copy(MEDAL_COL[medal]).multiplyScalar(2.4);
    else rec.ringMat.color.copy(COL[rec.kind]).multiplyScalar(2.6);
  }

  function dispose() {
    scene.remove(group);
    for (const d of disposables) if (d && d.dispose) d.dispose();
    if (tokenMesh) tokenMesh.dispose();
    chevrons.dispose();
  }

  return { group, build, update, collect, flashGate, flashTrap, setMedal, dispose };
}
