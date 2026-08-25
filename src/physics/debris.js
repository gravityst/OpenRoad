// Debris — the parts that come off, and what happens to them next.
//
// A crash that only rearranges the paintwork is a crash you stop noticing after
// the third one. A bumper that tears off at 120 km/h, cartwheels twice down the
// road and ends up lying across the carriageway behind you is the one you tell
// somebody about. That is the whole job of this file: take the 'detach' events
// the damage model emits and turn them into bodies that fall, bounce, tumble and
// come to rest on the actual ground.
//
// COORDINATE CONVENTION — the same one everything else uses, restated because
// the mount points below are written in the car's own frame and getting it
// backwards puts the bonnet behind the boot:
//
//   forward = -Z      right = +X      up = +Y
//
// THE ONE RULE, restated from physics/collision.js because it is the same rule
//
// A bounce may only ever REMOVE energy. The previous project computed its
// restitution impulse from the already-corrected velocity, so a barrier
// manufactured energy out of penetration depth and turned into a rail gun.
// Here the two halves are strictly separated: ground contact clamps POSITION
// and touches nothing else, and the impulse is built from the velocity that
// carried the piece INTO the ground, never from one that has already been
// corrected. The incoming velocity is split into its normal and tangential
// parts once; the normal part comes back scaled by a restitution below 1 and
// the tangential part is scrubbed toward zero, so
//
//   |v_out|^2 = e^2 * vn^2 + (1 - mu)^2 * |vt|^2  <  vn^2 + |vt|^2
//
// term by term, for every e < 1 and every mu in [0, 1). Angular velocity is
// handled the same way: contact only ever damps spin. A piece tumbles because
// the crash threw it, not because the road keeps topping it up. The only place
// energy enters is spawn(), where it comes from the impact that tore the part
// off — and even there the piece leaves with LESS than the car's velocity,
// which is why it falls behind you rather than pacing you down the road.
//
// tools/debrischeck.mjs asserts all of that: over ten thousand steps no piece's
// speed ever rises by more than gravity can account for, and nothing ends up
// below the surface it landed on.
//
// WHY THE POOL IS SMALL, FIXED, AND AGES UNDER PRESSURE
//
// Forty pieces is roughly two thoroughly destroyed cars. Past that the road
// stops reading as "wreckage" and starts reading as "litter", and every extra
// piece is a draw call for something nobody is looking at. So the pool is fixed
// at construction and update() allocates nothing: velocity, spin and lifetimes
// live in typed arrays, position and orientation live on the mesh that is
// already there, and a dead slot is swap-removed.
//
// A hard cap alone pops pieces out of existence the moment the cap is reached,
// which is worse than losing them slowly. Instead, a full pool hurries its OLD
// pieces along: the ageing multiplier is weighted by how far through its life a
// piece already is, so under a sustained shunt the wreckage from four cars ago
// reaches its fade in about a third of the usual time while the bumper that
// came off half a second ago ages at exactly the normal rate. Hurrying
// everything uniformly — the obvious version — kills the piece you are actually
// looking at, which is the one thing the cap must never do. The cap is still
// enforced underneath; it just very rarely has anything left to evict.

import * as THREE from 'three';

// Slot flags.
const RESTING = 1;   // touched down and settling onto its flat side
const ASLEEP = 2;    // settled; skipped entirely by the integrator
const OWNED = 4;     // mesh came from our own cache and can be handed back

// Fallback car dimensions, used when the source object carries none. These are
// the mid-size sedan out of the catalogue, so a caller that wires up nothing at
// all still gets parts in plausible places rather than at the origin.
const DEFAULT_DIMS = { length: 4.42, width: 1.82, height: 1.44, front: -2.00, rear: 2.42 };

// Where each part sits on the car and how it leaves it.
//
//   x     fraction of the body HALF width  (+ = right)
//   y     fraction of roof height, above the chassis datum
//   zr    which end z is measured from: -1 nose, 0 centre, +1 tail
//   zo    offset from that datum, as a fraction of the car's length
//   w,h,d size as fractions of (width, roof height, length)
//   keep  how much of the car's velocity the part leaves with — always < 1,
//         because a part that is torn off has just been decelerated by the
//         thing that tore it off
//   up    upward kick, m/s
//   out   sideways kick away from the car, m/s
//   spin  tumble rate at 30 m/s, rad/s, scattered per piece
//
// Fractions rather than metres so that a van and a coupe both get a bonnet the
// size of their own bonnet.
const PARTS = {
  frontBumper: { shape: 'slab', mat: 'paint', x: 0, y: 0.17, zr: -1, zo: 0.03, w: 0.94, h: 0.14, d: 0.075, keep: 0.78, up: 2.6, out: 0, spin: 9, axis: 'pitch' },
  rearBumper: { shape: 'slab', mat: 'paint', x: 0, y: 0.17, zr: 1, zo: -0.03, w: 0.94, h: 0.14, d: 0.075, keep: 0.95, up: 2.2, out: 0, spin: 7, axis: 'pitch' },
  bonnet: { shape: 'slab', mat: 'paint', x: 0, y: 0.40, zr: 0, zo: -0.28, w: 0.80, h: 0.05, d: 0.24, keep: 0.72, up: 4.2, out: 0, spin: 12, axis: 'pitch' },
  boot: { shape: 'slab', mat: 'paint', x: 0, y: 0.42, zr: 0, zo: 0.32, w: 0.78, h: 0.05, d: 0.18, keep: 0.92, up: 3.2, out: 0, spin: 9, axis: 'pitch' },
  doorL: { shape: 'slab', mat: 'paint', x: -0.94, y: 0.32, zr: 0, zo: 0.02, w: 0.06, h: 0.34, d: 0.22, keep: 0.88, up: 1.8, out: 2.6, spin: 7, axis: 'yaw' },
  doorR: { shape: 'slab', mat: 'paint', x: 0.94, y: 0.32, zr: 0, zo: 0.02, w: 0.06, h: 0.34, d: 0.22, keep: 0.88, up: 1.8, out: 2.6, spin: 7, axis: 'yaw' },
  mirrorL: { shape: 'slab', mat: 'plastic', x: -1.12, y: 0.45, zr: 0, zo: -0.20, w: 0.07, h: 0.09, d: 0.05, keep: 0.86, up: 2.4, out: 3.4, spin: 16, axis: 'roll' },
  mirrorR: { shape: 'slab', mat: 'plastic', x: 1.12, y: 0.45, zr: 0, zo: -0.20, w: 0.07, h: 0.09, d: 0.05, keep: 0.86, up: 2.4, out: 3.4, spin: 16, axis: 'roll' },
  exhaust: { shape: 'tube', mat: 'metal', x: 0.24, y: 0.06, zr: 1, zo: -0.06, w: 0.06, h: 0.06, d: 0.13, keep: 0.96, up: 1.2, out: 0.6, spin: 6, axis: 'roll' },
  spoiler: { shape: 'slab', mat: 'paint', x: 0, y: 0.52, zr: 1, zo: -0.08, w: 0.88, h: 0.04, d: 0.07, keep: 0.90, up: 3.0, out: 0, spin: 11, axis: 'pitch' },
};

// Module-scope scratch. Built at import, which is safe: Vector3 and Quaternion
// touch neither the DOM nor WebGL.
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qFlat = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();

/**
 * A unit box with a crowned top face. One extra vertex of displacement turns a
 * plank into something with a highlight that moves as it tumbles, which is the
 * difference between reading as a panel and reading as a packing crate. Every
 * part is this one geometry under a non-uniform scale, so the whole system is
 * two geometries however many pieces are in the air.
 */
function slabGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1, 2, 1, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.499) continue;
    // Across the face in -1..1. The side faces' top rows sit at |x| or |z| = 1
    // where the crown is exactly zero, so the shell stays closed.
    const x = p.getX(i) * 2, z = p.getZ(i) * 2;
    p.setY(i, 0.5 + 0.30 * (1 - x * x) * (1 - z * z));
  }
  g.computeVertexNormals();
  return g;
}

/** A unit tube with its axis along +Z — exhaust sections and nothing else. */
function tubeGeometry() {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, false);
  g.rotateX(Math.PI * 0.5);
  return g;
}

/**
 * Loose parts that fall off cars, tumble, and lie where they land.
 *
 * @param {object} ground  anything exposing heightAt(x, z); sample(x, z, out)
 *                         is used as well when present, for the surface normal
 *                         and for how much a landing bounces
 * @param {object} opts    max, life, fade, gravity, cullDistance, paint
 */
export function createDebris(ground, opts = {}) {
  const MAX = Math.max(4, Math.round(opts.max ?? 40));
  // Past this many live pieces the old ones start ageing faster. Two thirds
  // full is early enough that the hurry comes on gradually rather than as a
  // cliff at the cap.
  const SOFT = Math.max(1, Math.min(MAX - 1, Math.round(MAX * (opts.soft ?? 0.65))));
  const SPAN = Math.max(1, MAX - SOFT);
  // At full pressure a piece at the end of its life ages thirteen times faster,
  // which works out as about a third of the nominal lifetime overall.
  const HURRY = opts.hurry ?? 12;

  // Floored, because the ageing rate is a function of age/life and a life of
  // zero makes that 0/0 — a piece whose age is NaN never reaches its lifetime
  // and never leaves the pool.
  const LIFE = Math.max(0.1, opts.life ?? 24);   // s in the world before it goes
  const FADE = Math.min(LIFE * 0.5, opts.fade ?? 1.6);   // s of shrinking out
  const GRAVITY = opts.gravity ?? 13.5;
  const DRAG = opts.drag ?? 0.22;        // 1/s, air resistance on the body
  const SPIN_DRAG = opts.spinDrag ?? 0.30;
  const CULL = opts.cullDistance ?? 260;
  const CULL_SQ = CULL * CULL;
  const DEFAULT_PAINT = opts.paint ?? 0xb8bcc0;

  // A step this long moves a piece thrown at 30 m/s about a metre. Longer
  // steps — a tab coming back from the background — are INTEGRATED at this
  // length and aged at the real one, so a stall leaves the debris roughly
  // where it was and ages it out honestly, rather than teleporting a bumper
  // half a kilometre down the road on the first frame back.
  const MAX_STEP = 0.04;

  const REST_V = 0.42;        // m/s under which a piece in contact is settling
  const REST_W = 0.9;         // rad/s, same
  const REST_TIME = 0.22;     // s of quiet before it lies down
  const SETTLE_RATE = 7;      // 1/s, how fast it rolls onto its flat side
  const HIT_SPIN = 0.06;      // s/m: how much of a contact impulse kills spin

  const group = new THREE.Group();
  group.name = 'debris';
  group.matrixAutoUpdate = false;    // it never moves; its children do
  group.updateMatrix();

  // ---- shared geometry and materials --------------------------------------
  const geo = { slab: slabGeometry(), tube: tubeGeometry() };
  const paints = new Map();          // hex -> material, one per car colour seen
  const plastic = new THREE.MeshStandardMaterial({ color: 0x212429, roughness: 0.80, metalness: 0.04 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.34, metalness: 0.92 });
  // Meshes handed back by recycled pieces, keyed by shape and colour so a long
  // demolition derby settles into reusing the same forty objects.
  const spare = new Map();

  function paintFor(hex) {
    let m = paints.get(hex);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: hex, metalness: 0.50, roughness: 0.45 });
      paints.set(hex, m);
    }
    return m;
  }

  // ---- slot state ----------------------------------------------------------
  const vel = new Float64Array(MAX * 3);
  const spin = new Float64Array(MAX * 3);
  const half = new Float64Array(MAX * 3);    // half extents in the piece's frame
  const base = new Float64Array(MAX * 3);    // mesh scale before the fade
  const nrm = new Float32Array(MAX * 3);     // surface normal it last touched
  const age = new Float32Array(MAX);
  const life = new Float32Array(MAX);
  const restT = new Float32Array(MAX);
  const floorY = new Float32Array(MAX);      // ground height where it settled
  const flags = new Uint8Array(MAX);
  const meshes = new Array(MAX).fill(null);
  const keys = new Array(MAX).fill('');
  let n = 0;

  const stats = {
    alive: 0, asleep: 0, spawned: 0, recycled: 0, evicted: 0, bounces: 0,
    // The invariant, measured rather than asserted: the largest amount by which
    // any single contact has ever increased a piece's linear speed or spin.
    // Both must stay at zero. tools/debrischeck.mjs reads them.
    worstBounceGain: 0, worstSpinGain: 0,
  };

  // Ground query results, reused. sample() fills the same shape the rest of the
  // game uses, so this object doubles as its output buffer.
  const surf = {
    y: 0, nx: 0, ny: 1, nz: 0,
    surface: 'asphalt', grip: 1, roughness: 0.03, rolling: 0.014, dust: 0,
  };
  const hasSample = !!(ground && typeof ground.sample === 'function');
  const hasHeight = !!(ground && typeof ground.heightAt === 'function');

  /**
   * Height, normal and material under (x, z), into `surf`.
   *
   * The normal is renormalised and the grip clamped on the way out, and neither
   * is defensive habit: the proof that a bounce can only remove energy assumes
   * a unit normal and a restitution below 1, and both of those come from an
   * object the caller handed us. Two lines here make the guarantee a property
   * of this file rather than a property of somebody else's ground.
   */
  function probeGround(x, z) {
    if (hasSample) {
      ground.sample(x, z, surf);
      const l = Math.sqrt(surf.nx * surf.nx + surf.ny * surf.ny + surf.nz * surf.nz);
      if (l > 1e-6) {
        const s = 1 / l;
        surf.nx *= s; surf.ny *= s; surf.nz *= s;
      } else {
        surf.nx = 0; surf.ny = 1; surf.nz = 0;
      }
      const g = surf.grip;
      surf.grip = g >= 0 ? (g > 1 ? 1 : g) : 0;      // >= also rejects NaN
      return;
    }
    surf.y = hasHeight ? ground.heightAt(x, z) : 0;
    surf.nx = 0; surf.ny = 1; surf.nz = 0;
    surf.grip = 1;
  }

  // ---- slot bookkeeping ----------------------------------------------------

  function moveSlot(from, to) {
    const a = from * 3, b = to * 3;
    for (let k = 0; k < 3; k++) {
      vel[b + k] = vel[a + k];
      spin[b + k] = spin[a + k];
      half[b + k] = half[a + k];
      base[b + k] = base[a + k];
      nrm[b + k] = nrm[a + k];
    }
    age[to] = age[from]; life[to] = life[from];
    restT[to] = restT[from]; floorY[to] = floorY[from];
    flags[to] = flags[from];
    meshes[to] = meshes[from]; keys[to] = keys[from];
  }

  function release(i) {
    const m = meshes[i];
    if (m) {
      group.remove(m);
      if (flags[i] & OWNED) {
        let list = spare.get(keys[i]);
        if (!list) spare.set(keys[i], (list = []));
        if (list.length < MAX) list.push(m);
      }
    }
    const last = --n;
    if (i !== last) moveSlot(last, i);
    meshes[last] = null;
    keys[last] = '';
    flags[last] = 0;
    stats.recycled++;
  }

  /**
   * A free slot. When the pool is full the piece furthest through its life goes
   * now — the hurry factor above means that is almost always one already
   * shrinking out, so the eviction is rarely something you could have seen.
   */
  function alloc() {
    if (n < MAX) return n++;
    let worst = 0, worstT = -1;
    for (let i = 0; i < n; i++) {
      const t = age[i] / life[i];
      if (t > worstT) { worstT = t; worst = i; }
    }
    release(worst);
    stats.evicted++;
    return n++;              // release() freed the last index; take it back
  }

  // ---- spawning ------------------------------------------------------------

  /** Half extents of a mesh, from its geometry bounds and its own scale. */
  function extentsOf(mesh, i) {
    let hx = 0.20, hy = 0.05, hz = 0.35;
    const g = mesh.geometry;
    if (g) {
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      if (b) {
        // Treated as centred on the origin: an off-centre part would sit a
        // little into or above the ground, which at debris scale is invisible
        // and costs nothing to be wrong about.
        hx = Math.max(1e-3, (b.max.x - b.min.x) * 0.5);
        hy = Math.max(1e-3, (b.max.y - b.min.y) * 0.5);
        hz = Math.max(1e-3, (b.max.z - b.min.z) * 0.5);
      }
    }
    const i3 = i * 3;
    half[i3] = hx * Math.abs(mesh.scale.x);
    half[i3 + 1] = hy * Math.abs(mesh.scale.y);
    half[i3 + 2] = hz * Math.abs(mesh.scale.z);
  }

  let lastSlot = -1;                   // slot the most recent spawn() landed in

  /**
   * Hand a mesh over to the debris system. It is reparented into `group` and
   * simulated until it fades; when it is recycled it is simply detached again,
   * so anything you built yourself stays yours to dispose of.
   *
   * Velocities are m/s in world space, spins rad/s about the world axes.
   */
  function spawn(mesh, x, y, z, vx = 0, vy = 0, vz = 0, spinX = 0, spinY = 0, spinZ = 0) {
    lastSlot = -1;
    if (!mesh) return null;
    // Re-spawning a mesh that is already live would leave two slots pointing at
    // one object, and the first release would yank it out from under the second.
    let i = -1;
    for (let k = 0; k < n; k++) if (meshes[k] === mesh) { i = k; break; }
    if (i < 0) i = alloc();
    const i3 = i * 3;

    meshes[i] = mesh;
    keys[i] = '';
    flags[i] = 0;
    if (mesh.parent !== group) group.add(mesh);
    mesh.position.set(x, y, z);
    mesh.visible = true;

    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    spin[i3] = spinX; spin[i3 + 1] = spinY; spin[i3 + 2] = spinZ;
    base[i3] = mesh.scale.x; base[i3 + 1] = mesh.scale.y; base[i3 + 2] = mesh.scale.z;
    nrm[i3] = 0; nrm[i3 + 1] = 1; nrm[i3 + 2] = 0;
    extentsOf(mesh, i);
    age[i] = 0;
    life[i] = LIFE;
    restT[i] = 0;
    floorY[i] = 0;
    stats.spawned++;
    lastSlot = i;
    return mesh;
  }

  /**
   * The convenience path for a damage 'detach' event: build the named part, put
   * it where it was on the car, and throw it off with the car's own velocity
   * plus a kick.
   *
   * `sourceObject3D` is the car's model group. Its world transform places the
   * part; `userData.dims` (the `dims` object createCarModel returns) sizes it,
   * and the mesh named 'paint' inside it gives the part the car's colour. All
   * three are optional — without them the part is a mid-size sedan's, in the
   * default colour, at the source object's origin.
   *
   * `carVelocity` accepts {x,y,z} or a vehicle's own {vx,vy,vz}.
   */
  function spawnPart(partName, sourceObject3D, carVelocity) {
    const P = PARTS[partName];
    if (!P) return null;
    const src = sourceObject3D || null;
    const dims = (src && src.userData && src.userData.dims) || DEFAULT_DIMS;
    const L = dims.length ?? DEFAULT_DIMS.length;
    const W = dims.width ?? DEFAULT_DIMS.width;
    const H = dims.height ?? DEFAULT_DIMS.height;
    const zF = dims.front ?? -L * 0.45;
    const zR = dims.rear ?? L * 0.55;

    // --- colour: whatever the car is actually painted -----------------------
    let hex = DEFAULT_PAINT;
    if (P.mat === 'paint' && src) {
      // Guarded the same way `dims` is above: a stand-in source object with no
      // userData at all must not throw, because this runs off a crash event.
      if (src.userData && typeof src.userData.paint === 'number') hex = src.userData.paint;
      else {
        const body = src.getObjectByName('paint');
        if (body && body.material && body.material.color) hex = body.material.color.getHex();
      }
    }
    const key = P.mat === 'paint' ? `${P.shape}:${hex}` : `${P.shape}:${P.mat}`;

    let mesh = null;
    const list = spare.get(key);
    if (list && list.length) mesh = list.pop();
    if (!mesh) {
      const mat = P.mat === 'paint' ? paintFor(hex) : P.mat === 'metal' ? metal : plastic;
      mesh = new THREE.Mesh(geo[P.shape], mat);
      mesh.castShadow = true;
    }
    // Named every time, not only when built: a slab recycled from a bonnet is
    // about to be a boot, and a scene graph that says otherwise is a debugging
    // session spent chasing the wrong object.
    mesh.name = `debris:${partName}`;
    mesh.scale.set(W * P.w, H * P.h, L * P.d);

    // --- where it was, in the world ----------------------------------------
    const lx = P.x * W * 0.5;
    const ly = P.y * H;
    const lz = (P.zr < 0 ? zF : P.zr > 0 ? zR : 0) + P.zo * L;
    _v.set(lx, ly, lz);
    if (src) {
      src.updateWorldMatrix(true, false);
      _v.applyMatrix4(src.matrixWorld);
      src.getWorldQuaternion(_q);
    } else {
      _q.identity();
    }
    mesh.quaternion.copy(_q);

    // Car axes in the world, for a kick that means the same thing whichever way
    // the car is pointing.
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);

    // A vehicle carries BOTH x,y,z (where it is) and vx,vy,vz (how fast it is
    // going), so the two forms have to be told apart before anything is read —
    // picking fields one at a time would quietly hand a car's altitude to a
    // bumper as an upward launch velocity.
    let cvx = 0, cvy = 0, cvz = 0;
    if (carVelocity) {
      const asCar = typeof carVelocity.vx === 'number';
      cvx = (asCar ? carVelocity.vx : carVelocity.x) || 0;
      cvy = (asCar ? carVelocity.vy : carVelocity.y) || 0;
      cvz = (asCar ? carVelocity.vz : carVelocity.z) || 0;
    }
    const speed = Math.hypot(cvx, cvy, cvz);
    const side = P.x < 0 ? -1 : P.x > 0 ? 1 : (Math.random() < 0.5 ? -1 : 1);
    const r = Math.random;

    // keep < 1 is what makes a bumper drop BEHIND you instead of pacing you.
    // The upward flick scales with speed: a part that lets go at a standstill
    // should fall off, and one that lets go at 120 km/h should be thrown.
    const fling = 0.55 + speed / 34;
    const kx = cvx * P.keep + _right.x * P.out * side + (r() - 0.5) * 1.6;
    const ky = cvy * P.keep + P.up * fling * (0.7 + r() * 0.6);
    const kz = cvz * P.keep + _right.z * P.out * side + (r() - 0.5) * 1.6;

    // Tumble scales with how fast it was going when it let go: at a standstill
    // a mirror drops and rocks, at 33 m/s it goes end over end. The dominant
    // axis is the car's, so a bonnet cartwheels about the car's own lateral
    // axis whichever way the car happened to be pointing.
    const rate = P.spin * (0.35 + speed / 30) * (0.6 + r() * 0.8);
    const j = rate * 0.45;
    let sx = (r() - 0.5) * j, sy = (r() - 0.5) * j, sz = (r() - 0.5) * j;
    if (P.axis === 'pitch') { sx += _right.x * rate; sy += _right.y * rate; sz += _right.z * rate; }
    else if (P.axis === 'yaw') sy += rate * side;
    else { sx += _fwd.x * rate; sy += _fwd.y * rate; sz += _fwd.z * rate; }

    const out = spawn(mesh, _v.x, _v.y, _v.z, kx, ky, kz, sx, sy, sz);
    if (out && lastSlot >= 0) { flags[lastSlot] |= OWNED; keys[lastSlot] = key; }
    return out;
  }

  // ---- simulation ----------------------------------------------------------

  /**
   * How far the piece's box reaches below its own origin, right now. Exact for
   * an oriented box: the world-Y extent is the sum of the half extents times
   * the magnitudes of the Y row of the rotation matrix, which is what makes a
   * slab rest on its face and an exhaust rest on its side without either of
   * them needing a special case.
   */
  function supportOf(i, q) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const m10 = 2 * (x * y + w * z);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z - w * x);
    const i3 = i * 3;
    return half[i3] * Math.abs(m10) + half[i3 + 1] * Math.abs(m11) + half[i3 + 2] * Math.abs(m12);
  }

  /** q += 0.5 * dt * (omega x q), renormalised. */
  function integrateSpin(q, wx, wy, wz, h) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const k = 0.5 * h;
    let nx = qx + k * (wx * qw + wy * qz - wz * qy);
    let ny = qy + k * (-wx * qz + wy * qw + wz * qx);
    let nz = qz + k * (wx * qy - wy * qx + wz * qw);
    let nw = qw + k * (-wx * qx - wy * qy - wz * qz);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    if (len > 1e-9) { const s = 1 / len; nx *= s; ny *= s; nz *= s; nw *= s; }
    else { nx = 0; ny = 0; nz = 0; nw = 1; }
    q.set(nx, ny, nz, nw);
  }

  /**
   * One piece, one step. Everything here is scalar arithmetic on preallocated
   * storage — no vectors are constructed, and the mesh's own position and
   * quaternion ARE the state, so nothing is copied twice either.
   */
  function fly(i, mesh, h) {
    const i3 = i * 3;
    let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
    let wx = spin[i3], wy = spin[i3 + 1], wz = spin[i3 + 2];

    // Gravity, then drag. Drag is implicit — a divide rather than a subtract —
    // so however long the step is it can never overshoot into negative damping
    // and start winding the piece up instead of slowing it down.
    vy -= GRAVITY * h;
    const f = 1 / (1 + DRAG * h);
    vx *= f; vy *= f; vz *= f;
    const fw = 1 / (1 + SPIN_DRAG * h);
    wx *= fw; wy *= fw; wz *= fw;

    const pos = mesh.position;
    const px = pos.x + vx * h;
    let py = pos.y + vy * h;
    const pz = pos.z + vz * h;

    const q = mesh.quaternion;
    integrateSpin(q, wx, wy, wz, h);

    probeGround(px, pz);
    const gy = surf.y;
    const nx = surf.nx, ny = surf.ny, nz = surf.nz;
    const floor = gy + supportOf(i, q);

    if (py < floor) {
      // --- 1. Position correction. Moves the piece. Touches nothing else. ---
      py = floor;

      // --- 2. Velocity response, built from the velocity that carried it in --
      const vn = vx * nx + vy * ny + vz * nz;
      if (vn < 0) {
        const before = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const beforeW = Math.sqrt(wx * wx + wy * wy + wz * wz);

        // Hard surfaces skitter, soft ones absorb. Both stay well under 1.
        const e = 0.34 * surf.grip;
        const mu = Math.min(0.85, 1 - surf.grip * 0.55);

        // The incoming split, done once. The tangential part is untouched by a
        // normal impulse, so this is the real one, not a corrected one.
        const tx = vx - nx * vn, ty = vy - ny * vn, tz = vz - nz * vn;
        const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);

        // Coulomb: the tangential impulse is capped by the normal one, so a
        // hard landing scrubs hard and a piece merely sitting on the road is
        // barely touched. Scaling the tangential velocity by a fixed fraction
        // instead is the obvious version and it is wrong — it is per STEP, not
        // per second, so at 120 Hz a resting piece loses 45% of its speed every
        // frame and a bumper thrown down the road at 120 km/h stops dead after
        // twelve metres. Measured, in exactly that case, before this changed.
        const jn = -(1 + e) * vn;                // > 0: the normal impulse
        const scrub = vt > 1e-9 ? Math.min(vt, mu * jn) / vt : 0;
        const keep = 1 - scrub;                  // in [0, 1], never negative
        const outN = -e * vn;                    // e < 1, so |outN| < |vn|
        vx = tx * keep + nx * outN;
        vy = ty * keep + ny * outN;
        vz = tz * keep + nz * outN;

        // Contact scrubs spin, in proportion to how hard the contact was, and
        // for the same reason. It is never allowed to CREATE any: converting
        // linear motion into rotation at the contact point is exactly the trade
        // that lets an impact solver manufacture energy, so the tumble comes
        // from the throw and is only ever taken away afterwards.
        const damp = 1 / (1 + HIT_SPIN * jn);
        wx *= damp; wy *= damp; wz *= damp;

        const after = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const afterW = Math.sqrt(wx * wx + wy * wy + wz * wz);
        stats.bounces++;
        if (after - before > stats.worstBounceGain) stats.worstBounceGain = after - before;
        if (afterW - beforeW > stats.worstSpinGain) stats.worstSpinGain = afterW - beforeW;
      }

      // Quiet and in contact for long enough: lie down.
      if (vx * vx + vy * vy + vz * vz < REST_V * REST_V &&
          wx * wx + wy * wy + wz * wz < REST_W * REST_W) {
        restT[i] += h;
        if (restT[i] >= REST_TIME) {
          flags[i] |= RESTING;
          floorY[i] = gy;
          nrm[i3] = nx; nrm[i3 + 1] = ny; nrm[i3 + 2] = nz;
          vx = vy = vz = 0;
          wx = wy = wz = 0;
        }
      } else {
        restT[i] = 0;
      }
    }

    pos.set(px, py, pz);
    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    spin[i3] = wx; spin[i3 + 1] = wy; spin[i3 + 2] = wz;
  }

  /**
   * A piece that has stopped, rolling onto its flat side.
   *
   * The orientation is slerped toward "lying on the surface, still pointing the
   * way it stopped", and the piece is re-seated on the ground every step while
   * it does — because as it rolls flat its support height shrinks, and a piece
   * that is not re-seated ends up hovering by exactly the difference.
   */
  function settle(i, mesh, h) {
    const i3 = i * 3;
    const q = mesh.quaternion;

    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    _qYaw.set(0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5));
    _n.set(nrm[i3], nrm[i3 + 1], nrm[i3 + 2]);
    _qFlat.setFromUnitVectors(_up, _n);
    _qTarget.multiplyQuaternions(_qFlat, _qYaw);

    // Exponential approach, so the settle takes the same wall-clock time
    // whatever the frame rate is doing.
    q.slerp(_qTarget, 1 - Math.exp(-SETTLE_RATE * h));
    mesh.position.y = floorY[i] + supportOf(i, q);
    if (q.angleTo(_qTarget) < 0.02) flags[i] |= ASLEEP;
  }

  // ---- update --------------------------------------------------------------

  function update(dt, cameraPos) {
    // Infinity survives `dt > 0` and would pin every lifetime at Infinity, so
    // the whole field would freeze rather than fade. Large finite steps are
    // fine: they age normally and integrate at MAX_STEP.
    if (!(dt > 0) || dt === Infinity) dt = 0;
    const h = dt > MAX_STEP ? MAX_STEP : dt;

    // Fuller pool, faster ageing — but only for pieces that are already old.
    // The multiplier is weighted by the square of how far through its life a
    // piece is, so a full pool takes about a third off the oldest wreckage and
    // nothing at all off the part that came away this frame.
    const boost = n > SOFT ? ((n - SOFT) / SPAN) * HURRY : 0;

    let cx = 0, cy = 0, cz = 0, cull = false;
    if (cameraPos) {
      cx = cameraPos.x; cy = cameraPos.y; cz = cameraPos.z;
      cull = Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz);
    }

    let asleep = 0;
    for (let i = 0; i < n;) {
      const t = age[i] / life[i];
      const a = age[i] + dt * (1 + boost * t * t);
      if (a >= life[i]) { release(i); continue; }
      age[i] = a;

      const mesh = meshes[i];
      const flag = flags[i];
      if (flag & ASLEEP) asleep++;
      else if (h > 0) {
        if (flag & RESTING) settle(i, mesh, h);
        else fly(i, mesh, h);
      }

      const pos = mesh.position;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        // Nothing in here can produce this, but a caller can hand us a NaN
        // velocity, and one bad piece must not take the pool down with it.
        release(i);
        continue;
      }
      if (cull) {
        const ddx = pos.x - cx, ddy = pos.y - cy, ddz = pos.z - cz;
        if (ddx * ddx + ddy * ddy + ddz * ddz > CULL_SQ) { release(i); continue; }
      }

      // Fade by shrinking rather than by opacity: the material may belong to
      // the caller, may be shared with another piece, and may not be
      // transparent — scale is the one channel that is always ours.
      const left = life[i] - a;
      const i3 = i * 3;
      if (left < FADE) {
        const s = left / FADE;
        mesh.scale.set(base[i3] * s, base[i3 + 1] * s, base[i3 + 2] * s);
      } else if (mesh.scale.x !== base[i3]) {
        mesh.scale.set(base[i3], base[i3 + 1], base[i3 + 2]);
      }
      i++;
    }

    stats.alive = n;
    stats.asleep = asleep;
  }

  // ---- housekeeping --------------------------------------------------------

  function clear() {
    while (n > 0) release(0);
  }

  function dispose() {
    clear();
    spare.clear();
    if (group.parent) group.parent.remove(group);
    geo.slab.dispose();
    geo.tube.dispose();
    plastic.dispose();
    metal.dispose();
    for (const m of paints.values()) m.dispose();
    paints.clear();
  }

  /**
   * Read one live piece's state, for harnesses. Fills and returns `out`; the
   * index is only stable for as long as nothing is spawned or recycled, which
   * is exactly the condition a measurement run wants anyway.
   */
  function probe(i, out) {
    if (!(i >= 0 && i < n)) return null;
    const o = out || {};
    const i3 = i * 3, m = meshes[i];
    o.x = m.position.x; o.y = m.position.y; o.z = m.position.z;
    o.vx = vel[i3]; o.vy = vel[i3 + 1]; o.vz = vel[i3 + 2];
    o.wx = spin[i3]; o.wy = spin[i3 + 1]; o.wz = spin[i3 + 2];
    o.support = supportOf(i, m.quaternion);
    o.resting = !!(flags[i] & RESTING);
    o.asleep = !!(flags[i] & ASLEEP);
    o.age = age[i]; o.life = life[i];
    return o;
  }

  return {
    group,
    spawn, spawnPart,
    update, clear, dispose, probe,
    stats,
    limit: MAX,
    gravity: GRAVITY,
    get count() { return n; },
  };
}
