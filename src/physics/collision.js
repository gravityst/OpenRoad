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
    return result;
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

  return { resolve, insideBuilding, count: boxes.length };
}
