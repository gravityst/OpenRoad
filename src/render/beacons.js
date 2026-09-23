// Beacons over other players, and the road the guide takes you along.
//
// FROM FAR AWAY, A PERSON. Every other driver carries a tall column of light
// in their own colour (party.js, playerColour) — the same colour as their name
// tag, their arrow at the edge of the screen and their row in the friends
// list. It is exempt from the fog, so it reads from anywhere the terrain is
// drawn. Challenge beacons (render/gates.js) are also columns of light, so
// these are made to look unlike them: slimmer, taller, and with bright bands
// climbing them, where a challenge pillar is thick and still. A kid should
// never drive two kilometres to a speed trap thinking it was their brother.
//
// Up close the column fades away — a pillar of light through someone's car is
// not how you want to see them when you are right behind them — and a ring on
// the ground marks them instead. It grows with distance, so it keeps a
// readable width on screen instead of thinning to a hair at 2 km.
//
// THE GUIDE. While you are being guided to someone, chevrons in their colour
// march along the road ahead, exactly as the challenge GPS's cyan ones do
// (same shape, same spacing, same depth offset over the road ribbon).
//
// TAG. The car that is IT (game/modes.js) keeps its column but in signal red,
// twice as wide and pulsing: from anywhere on the map you can see where the
// chaser is, which is half of the fun of running from it.
//
// The chevrons also draw a party race's line (the race's amber), exactly as
// they draw a Guide.
//
// COST. One beam and one ring per player, at most sixteen of each, plus one
// InstancedMesh of chevrons; no per-frame allocation. 'low' drops the rings.

import * as THREE from 'three';

const MAX = 16;
const BEAM_H = 230;          // m
const NEAR = 30, FULL = 110; // m: invisible inside NEAR, full strength past FULL
const CHEVRONS = 24;
const CHEV_GAP = 7;

function bandTex() {
  // Horizontal: a hot core in a soft glow. Vertical: one bright band per
  // tile, repeated up the column and scrolled upwards — the climbing light.
  const w = 64, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const band = 0.55 + 0.45 * Math.pow(Math.max(0, Math.sin(v * Math.PI)), 6);
    for (let x = 0; x < w; x++) {
      const s = Math.abs(x / (w - 1) - 0.5) * 2;
      const core = Math.exp(-s * s * 4) + 0.35 * Math.exp(-s * s * 1.2);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, core * band) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 9);
  return t;
}

/** A unit column standing on y = 0, fading out towards the top through its
 *  vertex alpha (so the repeating band texture can scroll freely). */
function beamGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 1, 12);
  g.translate(0, 0.5, 0);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const up = pos.getY(i);
    const a = Math.pow(1 - up, 1.1) * Math.min(1, up * 40 + 0.35);
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
    col[i * 4 + 3] = a;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return g;
}

function chevronGeometry() {
  // Same chevron as the challenge GPS (gates.js): flat, pointing along -Z.
  const s = new THREE.Shape();
  s.moveTo(0, -0.9); s.lineTo(1.25, 0.35); s.lineTo(0.8, 0.75); s.lineTo(0, -0.05);
  s.lineTo(-0.8, 0.75); s.lineTo(-1.25, 0.35); s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(Math.PI / 2);
  return g;
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const IT_HEX = 0xff4d3a;

/**
 * opts: { quality, heightAt(x, z) }
 * update(dt, camera, cars, colourOf(car) -> {hex}, guide, driving, itId)
 *   cars     net.room.cars (read only)
 *   guide    party.guide or a party race's line ({ id, hex, route, d }), or null
 *   itId     the player who is IT in tag, or -1
 */
export function createBeacons(scene, opts = {}) {
  const low = opts.quality === 'low';
  const heightAt = typeof opts.heightAt === 'function' ? opts.heightAt : null;
  const group = new THREE.Group();
  group.name = 'player-beacons';
  scene.add(group);

  const tex = bandTex();
  const beamGeo = beamGeometry();
  const ringGeo = new THREE.RingGeometry(0.72, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const chevGeo = chevronGeometry();

  const slots = [];
  function slot(i) {
    if (slots[i]) return slots[i];
    // NORMAL blending, not additive. Added light is invisible against a
    // bright midday sky — the first version was measured in the browser as a
    // 3 px, barely-there hairline at 2.4 km — whereas a column painted in the
    // player's colour reads against sky, cloud and hillside alike, and still
    // blooms at night from the colour's slight HDR lift.
    const beamMat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffffff, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.renderOrder = 4;
    beam.frustumCulled = false;
    beam.visible = false;
    group.add(beam);
    let ring = null, ringMat = null;
    if (!low) {
      ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10,
      });
      ring = new THREE.Mesh(ringGeo, ringMat);
      ring.renderOrder = 4;
      ring.visible = false;
      group.add(ring);
    }
    const s = { beam, beamMat, ring, ringMat, hex: -1 };
    slots[i] = s;
    return s;
  }

  // Painted, not added. The challenge GPS gets away with additive because
  // cyan is bright; a red or purple friend's chevrons added onto grey tarmac
  // in daylight were faint dashes (seen in the browser at 71 km/h). They fade
  // in by size instead of by brightness.
  const chevMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.88,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -10,
    side: THREE.DoubleSide,
  });
  const nChev = low ? 16 : CHEVRONS;
  const chevrons = new THREE.InstancedMesh(chevGeo, chevMat, nChev);
  chevrons.frustumCulled = false;
  chevrons.renderOrder = 5;
  chevrons.count = 0;
  chevrons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nChev * 3), 3);
  group.add(chevrons);

  const camPos = new THREE.Vector3();
  const tmpCol = new THREE.Color(), chevCol = new THREE.Color();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler();
  const v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const rp = {}, rq = {};
  let time = 0;
  let visible = true;

  function groundAt(x, z, fallback) {
    return heightAt ? heightAt(x, z) : fallback;
  }

  function update(dt, camera, cars, colourOf, guide, driving, itId = -1) {
    time += dt;
    tex.offset.y = (tex.offset.y - dt * 0.55) % 1;
    camera.getWorldPosition(camPos);
    const n = cars ? cars.length : 0;
    for (let i = 0; i < Math.max(n, slots.length); i++) {
      const c = i < n ? cars[i] : null;
      if (!c || !c.active || c.fade <= 0 || !visible) {
        if (slots[i]) { slots[i].beam.visible = false; if (slots[i].ring) slots[i].ring.visible = false; }
        continue;
      }
      if (i >= MAX) continue;
      const s = slot(i);
      const it = c.id === itId;
      const col = colourOf ? colourOf(c) : null;
      const hex = it ? IT_HEX : col ? col.hex : 0xffffff;
      const guided = (guide && guide.id === c.id) || it;
      const dx = c.x - camPos.x, dz = c.z - camPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // Colour in HDR so the bloom pass (threshold ~2.1 linear) makes it glow;
      // the guided friend's column pulses.
      const pulse = guided ? 0.85 + 0.35 * Math.sin(time * 6) : 1;
      if (s.hex !== hex || guided) {
        tmpCol.setHex(hex);
        s.beamMat.color.setRGB(tmpCol.r * 1.3 * pulse, tmpCol.g * 1.3 * pulse, tmpCol.b * 1.3 * pulse);
        if (s.ringMat) s.ringMat.color.setRGB(tmpCol.r * 2.2, tmpCol.g * 2.2, tmpCol.b * 2.2);
        s.hex = guided ? -2 : hex;
      }
      const gy = groundAt(c.x, c.z, c.y - 0.5);
      const far = smooth(NEAR, FULL, dist);
      s.beam.visible = far > 0.01;
      if (s.beam.visible) {
        // About 1.6 degrees wide at any range: 4 m at 150 m, 67 m at 2.4 km,
        // ~20 px on a laptop screen wherever they are. At 0.2 degrees (the
        // first try) a purple column against a blue sky was a hairline.
        const w = Math.max(3, dist * 0.028) * (it ? 2 : guided ? 1.35 : 1);
        s.beam.position.set(c.x, gy, c.z);
        // Turned to face the camera about the vertical only, so it stays a
        // column from every side.
        s.beam.rotation.set(0, Math.atan2(camPos.x - c.x, camPos.z - c.z), 0);
        s.beam.scale.set(w, BEAM_H, 1);
        s.beamMat.opacity = far * c.fade;
      }
      if (s.ring) {
        // IT has its own red ring and ripple (render/modeFx.js); a second,
        // friend-coloured one under it was two circles saying one thing.
        const on = dist < 700 && !it;
        s.ring.visible = on;
        if (on) {
          const r = 2.6 + Math.max(0, dist - 40) * 0.012 + 0.25 * Math.sin(time * 3.2 + i);
          s.ring.position.set(c.x, gy + 0.18, c.z);
          s.ring.scale.set(r, 1, r);
          s.ringMat.opacity = 0.85 * c.fade * (0.35 + 0.65 * smooth(8, 25, dist));
        }
      }
    }

    // The guide's chevrons, marching along the road ahead.
    let shown = 0;
    // A Guide (party.js clears its route when it stops) or a party race's line.
    const route = guide ? guide.route : null;
    if (route && driving && visible) {
      tmpCol.setHex(guide.hex);
      const flow = (time * 9) % CHEV_GAP;
      const end = route.length;
      for (let k = 0; k < nChev; k++) {
        const d = guide.d + 10 + k * CHEV_GAP + flow;
        if (d > end - 2) break;
        route.at(d, rp);
        route.at(Math.min(end, d + 1.2), rq);
        const y0 = groundAt(rp.x, rp.z, rp.y), y1 = groundAt(rq.x, rq.z, rq.y);
        const pitch = Math.atan2(y1 - y0, Math.max(0.3, Math.hypot(rq.x - rp.x, rq.z - rp.z)));
        e3.set(pitch, Math.atan2(-rp.tx, -rp.tz), 0, 'YXZ');
        q.setFromEuler(e3);
        v3.set(rp.x, y0 + 0.13, rp.z);
        const nearA = Math.min(1, Math.max(0, (d - guide.d - 6) / 14));
        const grow = Math.max(0.2, nearA * (0.55 + 0.45 * (1 - k / nChev)));
        const sc = Math.min(1.25, (rp.hw || 4) / 4) * grow;
        s3.set(sc, 1, sc);
        m4.compose(v3, q, s3);
        chevrons.setMatrixAt(shown, m4);
        chevrons.setColorAt(shown, chevCol.setRGB(tmpCol.r * 1.15, tmpCol.g * 1.15, tmpCol.b * 1.15));
        shown++;
      }
    }
    chevrons.count = shown;
    chevrons.visible = shown > 0;
    if (shown) {
      chevrons.instanceMatrix.needsUpdate = true;
      if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const s of slots) { if (!s) continue; s.beamMat.dispose(); if (s.ringMat) s.ringMat.dispose(); }
    beamGeo.dispose(); ringGeo.dispose(); chevGeo.dispose();
    chevMat.dispose(); chevrons.dispose(); tex.dispose();
  }

  return {
    group, update, dispose,
    setVisible(on) { visible = !!on; },
  };
}
