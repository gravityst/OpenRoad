// Solid buildings.
//
// Without this the city is scenery you drive through, which undoes the whole
// illusion in about four seconds. With it, the city has walls.
//
// THE ONE RULE: a collision may only ever REMOVE energy.
//
// The previous project shipped a collision response that pushed the car out of
// a wall and then applied a restitution impulse computed from the *corrected*
// velocity, so grinding along a barrier accelerated the car — it manufactured
// energy out of the penetration depth. Here, position correction and velocity
// correction are strictly separate: the push-out moves the car and touches
// nothing else, and the velocity response only ever cancels the component
// heading INTO the surface. Nothing in this file can increase speed, and
// tools/collisioncheck.mjs asserts exactly that.

const CELL = 32;

export function createCollision(world, opts = {}) {
  const ground = opts.ground || null;
  const boxes = [];
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;

  for (const lot of world.lots) {
    // Buildings are a little smaller than their lot: the lot includes the strip
    // of garden or pavement around the footprint, and clipping a hedge should
    // not stop the car dead.
    const hw = lot.w * 0.5 * 0.94;
    const hd = lot.d * 0.5 * 0.94;
    const box = {
      x: lot.x, z: lot.z, hw, hd,
      cos: Math.cos(lot.rot), sin: Math.sin(lot.rot),
      height: lot.height, y: lot.y,
    };
    const i = boxes.length;
    boxes.push(box);

    // Register in every cell the footprint can reach, so one lookup is enough.
    const r = Math.hypot(hw, hd) + 4;
    for (let cx = Math.floor((lot.x - r) / CELL); cx <= Math.floor((lot.x + r) / CELL); cx++) {
      for (let cz = Math.floor((lot.z - r) / CELL); cz <= Math.floor((lot.z + r) / CELL); cz++) {
        const k = key(cx, cz);
        let L = grid.get(k);
        if (!L) grid.set(k, (L = []));
        L.push(i);
      }
    }
  }
  const cells = new Map();
  for (const [k, L] of grid) cells.set(k, Int32Array.from(L));
  grid.clear();
  const EMPTY = new Int32Array(0);

  const result = { hit: false, severity: 0, recovered: false, nx: 0, nz: 0, x: 0, z: 0 };
  // Car corners in body space, filled per call. Reused so resolve() allocates
  // nothing — it runs every physics step.
  const cornerX = new Float64Array(4);
  const cornerZ = new Float64Array(4);

  /**
   * Push `car` out of any building it has entered and remove the velocity that
   * drove it in. Returns a shared result object; copy anything you keep.
   */
  function resolve(car) {
    result.hit = false;
    result.severity = 0;
    // `result` is shared and reused, and resolveAll() returns it whenever
    // nothing was hit. Leaving this latched meant one wedge recovery made every
    // later frame claim a recovery, so the toast re-fired ~360 times a second
    // and no other message — fire, coolant, a burst tyre — was ever seen again.
    result.recovered = false;

    const spec = car.spec;
    const hb = spec.wheelbase * 0.5 + 0.55;      // body overhang past the axles
    const hwid = spec.track * 0.5 + 0.22;
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);

    cornerX[0] = car.x + fx * hb + rx * hwid;  cornerZ[0] = car.z + fz * hb + rz * hwid;
    cornerX[1] = car.x + fx * hb - rx * hwid;  cornerZ[1] = car.z + fz * hb - rz * hwid;
    cornerX[2] = car.x - fx * hb + rx * hwid;  cornerZ[2] = car.z - fz * hb + rz * hwid;
    cornerX[3] = car.x - fx * hb - rx * hwid;  cornerZ[3] = car.z - fz * hb - rz * hwid;

    // Deepest penetration across all four corners wins. Resolving each corner
    // separately fights itself in a doorway and jitters the car apart.
    let bestDepth = 0, bestNx = 0, bestNz = 0, bestCorner = -1;

    for (let c = 0; c < 4; c++) {
      const px = cornerX[c], pz = cornerZ[c];
      const list = cells.get(key(Math.floor(px / CELL), Math.floor(pz / CELL))) || EMPTY;
      for (let n = 0; n < list.length; n++) {
        const b = boxes[list[n]];

        // Into the building's own frame, where the test is a plain box.
        const dx = px - b.x, dz = pz - b.z;
        const lx = dx * b.cos + dz * b.sin;
        const lz = -dx * b.sin + dz * b.cos;
        const ox = b.hw - Math.abs(lx);
        if (ox <= 0) continue;
        const oz = b.hd - Math.abs(lz);
        if (oz <= 0) continue;

        // Shallowest axis is the one to push along — the face the car came in
        // through. Choosing the deeper one launches the car out of the far side.
        let depth, nlx, nlz;
        if (ox < oz) { depth = ox; nlx = Math.sign(lx) || 1; nlz = 0; }
        else { depth = oz; nlx = 0; nlz = Math.sign(lz) || 1; }
        if (depth <= bestDepth) continue;

        bestDepth = depth;
        bestNx = nlx * b.cos - nlz * b.sin;      // back to world
        bestNz = nlx * b.sin + nlz * b.cos;
        bestCorner = c;
      }
    }

    if (bestDepth <= 0) return result;

    // --- 1. Position correction. Moves the car. Touches nothing else. -------
    car.x += bestNx * bestDepth;
    car.z += bestNz * bestDepth;

    // --- 2. Velocity correction. Can only ever subtract. -------------------
    const vn = car.vx * bestNx + car.vz * bestNz;
    result.severity = 0;
    if (vn < 0) {
      // Speed heading into the wall. Cancel it, then return a fraction as
      // bounce. Because the restitution coefficient is below 1 the outgoing
      // normal speed (R * |vn|) is strictly less than the incoming, so this
      // branch can only ever reduce the total.
      const RESTITUTION = 0.18;
      car.vx -= bestNx * vn * (1 + RESTITUTION);
      car.vz -= bestNz * vn * (1 + RESTITUTION);
      result.severity = Math.min(1, -vn / 18);

      // Scrub speed along the wall too — a real car does not slide along
      // brickwork for free. Taken from the velocity AFTER the normal impulse,
      // so the tangential component is the real one.
      const FRICTION = 0.22 * result.severity;
      const vnAfter = car.vx * bestNx + car.vz * bestNz;
      car.vx -= (car.vx - bestNx * vnAfter) * FRICTION;
      car.vz -= (car.vz - bestNz * vnAfter) * FRICTION;

      // A corner strike should spin the car, but bounded — an unbounded yaw
      // impulse off a wall is how cars end up helicoptering.
      if (bestCorner >= 0) {
        const side = bestCorner === 0 || bestCorner === 2 ? 1 : -1;
        const front = bestCorner < 2 ? 1 : -1;
        car.yawRate = Math.max(-2.6, Math.min(2.6,
          car.yawRate - side * front * result.severity * 1.5));
      }
    }

    result.hit = true;
    result.nx = bestNx; result.nz = bestNz;
    result.x = cornerX[bestCorner]; result.z = cornerZ[bestCorner];

    // Tell the damage model WHERE it was hit, in the car's own frame. A model
    // that only knows "you hit something, this hard" cannot tell a clipped wing
    // mirror from a head-on into a wall, and every consequence downstream —
    // which panel folds, which light goes, whether the radiator is holed —
    // depends on that distinction.
    if (car.damage && result.severity > 0) {
      const wx = result.x - car.x, wz = result.z - car.z;
      car.damage.impact(
        result.severity,
        wx * rx + wz * rz,          // metres right of centre
        wx * fx + wz * fz,          // metres forward of centre
        hwid, hb, -vn);
    }
    return result;
  }

  const deepestOut = { depth: 0, nx: 0, nz: 0 };
  /** Deepest building overlap at a single point, with the way out. */
  function deepest(x, z) {
    deepestOut.depth = 0; deepestOut.nx = 0; deepestOut.nz = 0;
    const list = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY;
    for (let n = 0; n < list.length; n++) {
      const b = boxes[list[n]];
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * b.cos + dz * b.sin;
      const lz = -dx * b.sin + dz * b.cos;
      const ox = b.hw - Math.abs(lx);
      if (ox <= 0) continue;
      const oz = b.hd - Math.abs(lz);
      if (oz <= 0) continue;
      let depth, nlx, nlz;
      if (ox < oz) { depth = ox; nlx = Math.sign(lx) || 1; nlz = 0; }
      else { depth = oz; nlx = 0; nlz = Math.sign(lz) || 1; }
      if (depth <= deepestOut.depth) continue;
      deepestOut.depth = depth;
      deepestOut.nx = nlx * b.cos - nlz * b.sin;
      deepestOut.nz = nlx * b.sin + nlz * b.cos;
    }
    return deepestOut;
  }

  /** True if (x, z) is inside a building — used to keep spawns out of walls. */
  function insideBuilding(x, z, margin = 0) {
    const list = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY;
    for (let n = 0; n < list.length; n++) {
      const b = boxes[list[n]];
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * b.cos + dz * b.sin;
      const lz = -dx * b.sin + dz * b.cos;
      if (Math.abs(lx) < b.hw + margin && Math.abs(lz) < b.hd + margin) return true;
    }
    return false;
  }

  /**
   * Resolve repeatedly within one step.
   *
   * A single pass corrects the deepest corner and nothing else, so a car wedged
   * into an inside corner gets pushed out of one wall and straight into the
   * other, forever. Three passes settle every case the harness could find, and
   * it costs nothing when the car is not touching anything.
   */
  /**
   * Resolve, and if the car is genuinely wedged, put it back on the road.
   *
   * Buildings no longer intersect and no longer stand in the road, which
   * removes the wedges that used to trap a car — but a gap between two
   * buildings can still be narrower than the car that drove into it, and no
   * amount of push-out solves a space the car does not fit in. Rather than
   * pretend that case away, recover from it: after `stuckLimit` seconds still
   * buried, the car is placed on the nearest road. Every open-world game has
   * this, and a player who has wedged themselves wants exactly this.
   */
  function resolveAll(car, dt = 0, passes = 6) {
    let worst = null;
    for (let i = 0; i < passes; i++) {
      // Buried: the car's own CENTRE is inside a wall, which means every corner
      // is too and the shallowest-corner rule has nothing useful to say. Check
      // this every pass, not once — pushing clear of one building can put the
      // car inside the next one along.
      const buried = deepest(car.x, car.z);
      if (buried.depth > 0) {
        car.x += buried.nx * (buried.depth + 0.05);
        car.z += buried.nz * (buried.depth + 0.05);
        const vn = car.vx * buried.nx + car.vz * buried.nz;
        if (vn < 0) { car.vx -= buried.nx * vn; car.vz -= buried.nz * vn; }
      }
      const r = resolve(car);
      if (!r.hit && buried.depth <= 0) break;
      if (!r.hit) continue;
      if (!worst || r.severity > worst.severity) {
        worst = { hit: true, severity: r.severity, nx: r.nx, nz: r.nz, x: r.x, z: r.z };
      }
    }
    // Wedged: still inside after every pass. Give it a moment in case the
    // solver is mid-recovery, then put the car back on the road.
    if (deepest(car.x, car.z).depth > 0) {
      car.stuckTime = (car.stuckTime || 0) + dt;
      if (ground && car.stuckTime > 1.0) {
        const road = ground.nearestRoad(car.x, car.z, 400);
        if (road) {
          const yaw = Math.atan2(-road.tx, -road.tz);
          car.reset(road.x, road.z, yaw);
          car.stuckTime = 0;
          if (worst) worst.recovered = true;
          else { result.hit = true; result.recovered = true; }
        }
      }
    } else {
      car.stuckTime = 0;
    }

    return worst || result;
  }

  return { resolve: resolveAll, resolveOnce: resolve, insideBuilding, count: boxes.length };
}

// ---------------------------------------------------------------------------
// Car against car
// ---------------------------------------------------------------------------

/**
 * Traffic you can actually hit.
 *
 * Buildings were solid from the start but other cars were not, so you drove
 * straight through them — which undoes the world more thoroughly than any
 * missing texture, because the one thing sharing a road with you is the one
 * thing that turned out not to be there.
 *
 * Traffic is kinematic, so this is not a symmetric rigid-body solve. The player
 * is the dynamic body; a traffic car is given a velocity it then carries under
 * its own steam, which is enough for it to be shoved aside, spun, and knocked
 * off its line. What it is NOT allowed to do is give energy back: the same rule
 * that governs the walls governs this, and tools/carcrashcheck.mjs asserts it.
 */
export function createCarCollision(opts = {}) {
  const result = {
    hit: false, severity: 0, other: null,
    nx: 0, nz: 0, x: 0, z: 0, closing: 0, headOn: false,
  };
  // Scratch. resolve() runs every physics step against every nearby car.
  const axes = new Float64Array(8);
  const half = new Float64Array(4);

  /**
   * Separating-axis overlap of two oriented boxes, returning the minimum
   * translation axis and depth, or 0 if they are apart.
   */
  function overlap(ax, az, ac, as, ahw, ahl, bx, bz, bc, bs, bhw, bhl, out) {
    // Four candidate axes: each box's own right and forward.
    axes[0] = ac;  axes[1] = -as;      // A right
    axes[2] = -as; axes[3] = -ac;      // A forward
    axes[4] = bc;  axes[5] = -bs;      // B right
    axes[6] = -bs; axes[7] = -bc;      // B forward
    half[0] = ahw; half[1] = ahl; half[2] = bhw; half[3] = bhl;

    const dx = bx - ax, dz = bz - az;
    let best = Infinity, bnx = 0, bnz = 0;
    for (let i = 0; i < 8; i += 2) {
      const nx = axes[i], nz = axes[i + 1];
      const dist = Math.abs(dx * nx + dz * nz);
      const ra = ahw * Math.abs(ac * nx - as * nz) + ahl * Math.abs(-as * nx - ac * nz);
      const rb = bhw * Math.abs(bc * nx - bs * nz) + bhl * Math.abs(-bs * nx - bc * nz);
      const gap = ra + rb - dist;
      if (gap <= 0) return 0;                       // separated on this axis
      if (gap < best) {
        best = gap;
        // Point the normal from A toward B, so the sign is unambiguous later.
        const s = (dx * nx + dz * nz) < 0 ? -1 : 1;
        bnx = nx * s; bnz = nz * s;
      }
    }
    out.nx = bnx; out.nz = bnz;
    return best;
  }

  const mtv = { nx: 0, nz: 0 };

  /**
   * @param car   the player's vehicle
   * @param cars  the traffic pool; inactive slots are skipped
   * @param dt    seconds
   * @param onHit optional (trafficCar, severity, lx, lz, closing) for damage
   */
  function resolve(car, cars, dt, onHit) {
    result.hit = false;
    result.severity = 0;
    result.other = null;
    if (!cars || !cars.length) return result;

    const ahw = car.spec.track * 0.5 + 0.16;
    const ahl = car.spec.wheelbase * 0.5 + 0.52;
    const ac = Math.cos(car.yaw), as = Math.sin(car.yaw);
    const reach = ahl + 3.6;

    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (!o || o.active === false) continue;
      const dx = o.x - car.x, dz = o.z - car.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach * 2.6) continue;                 // broad phase

      const bhw = (o.spec ? o.spec.track : 1.6) * 0.5 + 0.16;
      const bhl = (o.halfLen != null ? o.halfLen : (o.spec ? o.spec.wheelbase * 0.5 + 0.5 : 2.2));
      const bc = Math.cos(o.yaw), bs = Math.sin(o.yaw);

      const depth = overlap(car.x, car.z, ac, as, ahw, ahl, o.x, o.z, bc, bs, bhw, bhl, mtv);
      if (depth <= 0) continue;

      // --- separate. The player yields a third, traffic two thirds: shoving a
      //     hatchback aside should move the hatchback, not the player. ---
      car.x -= mtv.nx * depth * 0.34;
      car.z -= mtv.nz * depth * 0.34;
      o.x += mtv.nx * depth * 0.66;
      o.z += mtv.nz * depth * 0.66;

      // --- velocity. Only the closing component is touched, and it can only
      //     be reduced. Traffic carries no velocity vector of its own, so it
      //     is given one along its heading plus the shove it just took. ---
      // The traffic car's velocity is its own heading speed PLUS whatever shove
      // it is still carrying. Leaving the shove out was the bug: it made the
      // closing speed look undiminished on the next frame, so sustained contact
      // re-applied a full impulse every step and the pair gained energy without
      // limit — 37 m/s of it in the worst case. Including it is what lets the
      // contact actually resolve.
      const ovx = -Math.sin(o.yaw) * (o.speed || 0) + (o.kvx || 0);
      const ovz = -Math.cos(o.yaw) * (o.speed || 0) + (o.kvz || 0);
      const rvx = car.vx - ovx, rvz = car.vz - ovz;
      const closing = rvx * mtv.nx + rvz * mtv.nz;
      if (closing > 0) {
        const mA = car.spec.mass || 1400;
        const mB = (o.spec && o.spec.mass) || 1400;
        const share = mB / (mA + mB);
        const RESTITUTION = 0.16;
        const j = closing * (1 + RESTITUTION);
        car.vx -= mtv.nx * j * share;
        car.vz -= mtv.nz * j * share;
        // Push the traffic car along its own frame: it steers itself, so what
        // it needs is a shove and a spin, not a full velocity it cannot use.
        // Apply the impulse to the traffic car's TOTAL velocity, then put that
        // total back into the two parts it is stored as.
        //
        // A traffic car's motion lives in two places — the speed it is driving
        // at along its heading, and the shove it is carrying. Adding the
        // impulse to the shove alone leaves the heading component untouched, so
        // the car ends up with more total velocity than the impulse granted and
        // the pair gains energy. Decomposing puts exactly the post-impulse
        // velocity back, and nothing is invented on the way through.
        const push = j * (1 - share);
        const nvx = ovx + mtv.nx * push;
        const nvz = ovz + mtv.nz * push;

        // Spin the struck car FIRST, then decompose against its new heading.
        //
        // Order matters here and it is not obvious. Its velocity is stored as
        // heading x speed plus a shove, so turning the heading afterwards
        // rotates the speed component without touching the shove — which
        // changes the magnitude of the total and quietly adds energy. Rotating
        // before the split means the decomposition describes the velocity the
        // impulse actually produced.
        const lxHit = (o.x - car.x) * ac - (o.z - car.z) * as;
        const spin = Math.max(-1.8, Math.min(1.8, (lxHit > 0 ? -1 : 1) * Math.min(1, closing / 16) * 1.2));
        o.yaw += spin * 0.06;

        const hx = -Math.sin(o.yaw), hz = -Math.cos(o.yaw);
        const along = nvx * hx + nvz * hz;
        o.speed = Math.max(0, along);                 // it cannot be driven backwards
        o.kvx = nvx - hx * o.speed;
        o.kvz = nvz - hz * o.speed;

        const sev = Math.min(1, closing / 16);
        result.severity = Math.max(result.severity, sev);
        // Where it landed on the PLAYER, in the player's own frame.
        const px = o.x - car.x, pz = o.z - car.z;
        const lx = px * ac - pz * as;
        const lz = -px * as - pz * ac;
        if (car.damage && sev > 0) car.damage.impact(sev, lx, lz, ahw, ahl, closing);
        if (onHit) {
          // And on the OTHER car, in its frame — a car you rear-end takes it
          // in the back, not wherever your bumper happens to be.
          const qx = car.x - o.x, qz = car.z - o.z;
          onHit(o, sev, qx * bc - qz * bs, -qx * bs - qz * bc, closing);
        }
        // A glancing blow spins the player too; bounded, because a car that
        // helicopters off a wing mirror is worse than one that ignores you.
        car.yawRate = Math.max(-3.2, Math.min(3.2, car.yawRate + spin * 0.5));

        result.hit = true;
        result.other = o;
        result.nx = mtv.nx; result.nz = mtv.nz;
        result.x = (car.x + o.x) * 0.5; result.z = (car.z + o.z) * 0.5;
        result.closing = closing;
        result.headOn = (ac * bc + as * bs) < -0.45;
      }
    }
    return result;
  }

  return { resolve };
}
