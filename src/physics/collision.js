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

  const result = { hit: false, severity: 0, nx: 0, nz: 0, x: 0, z: 0 };
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
