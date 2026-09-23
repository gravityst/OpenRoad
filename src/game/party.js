// Finding each other: who is online, where they are, and getting you to them.
//
// Nobody should ever have to hunt for their sibling. This is the logic behind
// every way the game helps — pure data, no DOM and no three.js, so
// tools/netcheck.mjs runs it on the real world:
//
//   - the roster: everyone online, nearest first, with distance and which way
//     they are from where you are pointing;
//   - a colour per player, the same on their beacon, their name tag, their
//     arrow at the screen edge and their row in the list;
//   - a spot on a road right next to someone, facing the way they are going,
//     for "Go" and for pressing Play while friends are online;
//   - "Guide": a GPS route along real roads to a player who keeps moving,
//     re-planned as they go, on the same road graph and route objects the
//     challenge GPS uses (routes.js) — so the minimap line and the chevrons
//     on the road draw it without knowing it is a person, not a race.
//
// src/game/roster.js is the face of it (the list, the toasts, the title badge,
// the map pins); render/beacons.js draws the beacons and the guide chevrons.

import { createRoadGraph } from './routes.js';
import { CAR_BY_ID, STARTER } from '../vehicles/catalog.js';

// Bright, far apart on the wheel, and none of them the GPS cyan (0x4fd8f0),
// so a friend's beacon can never be mistaken for a challenge's.
const PALETTE = [0xff5a5a, 0xffc93c, 0x5ce07a, 0xc77dff, 0xff9f43, 0xff7eb6, 0x9ad0ff, 0xe8f06a];

const BEHIND = 26;          // m behind a friend that "Go" puts you
const GUIDE_REPLAN = 40;    // m the friend may move off the end of the route
const OFF_ROUTE = 35;       // m you may stray off it
const ARRIVE = 38;          // m: close enough — "you found them"
const TAU = Math.PI * 2;
const nearestFirst = (a, b) => a.dist - b.dist;

/** 0xRRGGBB -> [h (0..1), s, l] */
function hsl(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/**
 * A player's colour, from the paint they chose. Lifted so it glows — a dark
 * green car still gets a bright green beacon — and, where the paint has no
 * colour to speak of (white, silver, black, the most popular choices), a
 * colour of their own from the palette, picked by id so it is stable.
 */
export function playerColour(carId, colourIndex, id) {
  const car = CAR_BY_ID[carId];
  const paint = car ? car.colours[(colourIndex | 0) % car.colours.length] : null;
  if (paint != null) {
    let [h, s, l] = hsl(paint);
    if (s > 0.28 && l > 0.08 && l < 0.92) {
      // Keep clear of the GPS cyan (hue ~190 degrees): a teal paint lifted to
      // full brightness came out as #3ecde0, the challenge arrows' colour.
      const deg = h * 360;
      if (deg > 168 && deg < 212) h = (deg < 190 ? 160 : 218) / 360;
      return fromHsl(h, Math.max(0.72, s), Math.min(0.66, Math.max(0.56, l)));
    }
  }
  return PALETTE[((id | 0) % PALETTE.length + PALETTE.length) % PALETTE.length];
}

export function cssOf(hex) {
  return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
}

/** The car's name as the garage shows it, never the raw id off the wire. */
export function carName(carId) {
  const c = CAR_BY_ID[carId];
  return c ? `${c.brand} ${c.model}` : '';
}

/**
 * opts: {
 *   net                 net.js handle (room.cars, people)
 *   world, ground
 *   graph()             the road graph if something already built one
 *                       (goals.graph); otherwise built here on first Guide
 *   place(x, z, yaw)    put the car there as a cut (main.js's placeCar)
 * }
 */
export function createParty(opts) {
  const net = opts.net;
  const ground = opts.ground;
  let graph = null;
  const colours = new Map();          // id -> { hex, css, key }
  const list = [];                    // roster rows, pooled
  const roadQ = {};
  const rowPool = [];
  let pickedSpawn = -1;

  // ---- the guide ----------------------------------------------------------
  const guide = {
    id: -1, name: '', hex: 0xffffff, css: '#ffffff',
    route: null, d: 0, hint: -1, dist: 0, straight: 0, off: 0, planAt: -1e9,
    endX: 0, endZ: 0, arrived: false,
  };
  // What the HUD's minimap reads while guiding: the same shape goals.nav has,
  // so the same drawing code draws it. Challenge pins and tokens are borrowed
  // from the goals layer when there is one, so they stay on the map.
  const nav = { route: null, from: 0, markers: null, tokens: null };
  const proj = {};
  let clock = 0;

  function roadGraph() {
    if (graph) return graph;
    const g = opts.graph ? opts.graph() : null;
    graph = g || (opts.world ? createRoadGraph(opts.world) : null);
    return graph;
  }

  /** { hex, css } for a car-like { id, carId, colour }. Called per car per
   *  frame by the tags, the beacons and the list, so it compares fields and
   *  only builds anything when a player's car or paint actually changed. */
  function colourFor(c) {
    const carId = c.carId || '', paint = c.colour | 0;
    let e = colours.get(c.id);
    if (!e || e.carId !== carId || e.paint !== paint) {
      const hex = playerColour(carId, paint, c.id);
      e = { hex, css: cssOf(hex), carId, paint };
      colours.set(c.id, e);
    }
    return e;
  }

  /** The remote car for an id, if it is being drawn. */
  function carOf(id) {
    const c = net && net.room ? net.room.car(id) : null;
    return c && c.active && c.fade > 0 ? c : null;
  }

  /**
   * Everyone online, nearest first. Rows are pooled objects rebuilt in place;
   * read them, do not keep them. `self` is the local car ({x, z, yaw}).
   */
  function roster(self) {
    list.length = 0;
    if (!net) return list;
    const people = net.people;
    let i = 0;
    for (const p of people.values()) {
      const row = rowPool[i] || (rowPool[i] = {});
      i++;
      const c = carOf(p.id);
      row.id = p.id;
      row.name = p.name || ('Driver-' + p.id);
      row.carId = c ? c.carId : p.car;
      row.carName = carName(row.carId) || carName(STARTER);
      const col = colourFor(c || { id: p.id, carId: p.car, colour: p.colour });
      row.hex = col.hex; row.css = col.css;
      row.here = !!c;
      if (c && self) {
        const dx = c.x - self.x, dz = c.z - self.z;
        row.x = c.x; row.z = c.z; row.yaw = c.yaw;
        row.dist = Math.hypot(dx, dz);
        // Bearing relative to where you are pointing: 0 dead ahead, +ve to
        // the right. Forward is -Z and yaw grows anticlockwise, so the world
        // heading of the offset is atan2(-dx, -dz) in the same sense as yaw.
        let b = self.yaw - Math.atan2(-dx, -dz);
        b = ((b + Math.PI) % TAU + TAU) % TAU - Math.PI;
        row.bearing = b;
      } else {
        row.x = 0; row.z = 0; row.yaw = 0; row.dist = Infinity; row.bearing = 0;
      }
      row.guided = guide.id === p.id;
      list.push(row);
    }
    list.sort(nearestFirst);
    return list;
  }

  /**
   * A place on a road right next to a friend: about BEHIND metres back along
   * their direction of travel, in the lane that runs their way, facing where
   * they are going. Returns null if they are not being drawn (yet).
   */
  function spotNear(id) {
    const c = carOf(id);
    if (!c || !ground) return null;
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    const notTrack = (e) => e.kind !== 'track';
    let near = null;
    for (const back of [BEHIND, BEHIND * 0.5, 0]) {
      near = ground.nearestRoad(c.x - fx * back, c.z - fz * back, 300, notTrack) ||
        ground.nearestRoad(c.x - fx * back, c.z - fz * back, 900, null);
      if (near && Math.hypot(near.x - c.x, near.z - c.z) >= 8) break;
    }
    if (!near) return null;
    let yaw = Math.atan2(-near.tx, -near.tz);
    // The road's own direction is an accident of how it was drawn: face the
    // way the friend is facing, so "Go" puts you behind them, not head-on.
    if (Math.cos(yaw - c.yaw) < 0) yaw += Math.PI;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const lane = (near.edge && near.edge.width ? near.edge.width : 8) * 0.25;
    let x = near.x + rx * lane, z = near.z + rz * lane;
    // Never on top of them: a road that doubles back can put the nearest
    // point right beside their car. Ten metres further back along the way
    // you face (backwards is +sin, +cos of yaw).
    if (Math.hypot(x - c.x, z - c.z) < 6) { x += Math.sin(yaw) * 10; z += Math.cos(yaw) * 10; }
    // Face along the road WHERE THE CAR ENDS UP. On a tight bend the lane
    // offset lands on the next segment, and the first tangent was 28 degrees
    // off it — a car put down pointing into the verge.
    const here = ground.roadAt(x, z, roadQ);
    if (here && here.edge) {
      const ry = Math.atan2(-here.tx, -here.tz);
      yaw = Math.cos(ry - yaw) >= 0 ? ry : ry + Math.PI;
    }
    return { x, z, yaw, id, name: (net.people.get(id) || {}).name || c.name };
  }

  function nearestId(self) {
    let best = -1, bd = Infinity;
    for (const p of net.people.values()) {
      const c = carOf(p.id);
      if (!c) continue;
      const d = self ? Math.hypot(c.x - self.x, c.z - self.z) : 0;
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }

  /** "Go": straight to a spot next to them. Returns the spot, or null. */
  function goTo(id) {
    const s = spotNear(id);
    if (!s || !opts.place) return null;
    opts.place(s.x, s.z, s.yaw);
    if (guide.id === id) stopGuide();
    return s;
  }

  /**
   * Play was pressed. If anyone is online, start next to whoever was picked
   * on the title screen, or else the nearest. Returns the spot, or null when
   * there is nobody to start next to (the normal first-challenge start stands).
   */
  function onPlay(self) {
    if (!net || !net.people.size) return null;
    const id = carOf(pickedSpawn) ? pickedSpawn : nearestId(self);
    if (id < 0) return null;
    return goTo(id);
  }

  function startGuide(id, self) {
    const c = carOf(id);
    if (!c) return false;
    const col = colourFor(c);
    guide.id = id;
    guide.name = (net.people.get(id) || {}).name || c.name || 'them';
    guide.hex = col.hex; guide.css = col.css;
    guide.route = null; guide.planAt = -1e9; guide.arrived = false; guide.off = 0;
    plan(self, c);
    return !!guide.route;
  }

  function stopGuide() {
    guide.id = -1;
    guide.route = null;
    nav.route = null;
  }

  function plan(self, c) {
    const g = roadGraph();
    if (!g || !self) return;
    const r = g.route(self.x, self.z, c.x, c.z);
    guide.planAt = clock;
    guide.hint = -1;
    guide.off = 0;
    if (!r || r.n < 2) { guide.route = null; return; }
    guide.route = r;
    guide.endX = r.xs[r.n - 1]; guide.endZ = r.zs[r.n - 1];
  }

  /**
   * Once a frame. Keeps the guide route leading to where the friend is NOW:
   * re-planned when they drive more than GUIDE_REPLAN metres off its end, or
   * you stray OFF_ROUTE metres from it, at most twice a second. Dijkstra on
   * this map is well under a millisecond (routes.js), so that is free.
   * Returns an event string when something the player should hear about
   * happens ('arrived', 'lost'), else ''.
   */
  function update(dt, self, goalsNav) {
    clock += dt;
    if (guide.id < 0) { nav.route = null; return ''; }
    const c = carOf(guide.id);
    if (!c) { const was = guide.name; stopGuide(); guide.name = was; return 'lost'; }
    guide.straight = Math.hypot(c.x - self.x, c.z - self.z);
    if (guide.straight < ARRIVE) { guide.arrived = true; stopGuide(); return 'arrived'; }
    const moved = Math.hypot(c.x - guide.endX, c.z - guide.endZ);
    if (!guide.route || ((moved > GUIDE_REPLAN || guide.off > 1.2) && clock - guide.planAt > 0.5)) plan(self, c);
    const r = guide.route;
    if (!r) { nav.route = null; return ''; }
    r.project(self.x, self.z, guide.hint, 40, proj);
    if (guide.hint >= 0 && proj.dist > 25) r.project(self.x, self.z, -1, 0, proj);
    guide.hint = proj.i;
    guide.d = proj.d;
    guide.off = proj.dist > OFF_ROUTE ? guide.off + dt : 0;
    guide.dist = Math.max(0, r.length - guide.d) + Math.hypot(c.x - guide.endX, c.z - guide.endZ);
    nav.route = r;
    nav.from = guide.hint;
    nav.markers = goalsNav ? goalsNav.markers : null;
    nav.tokens = goalsNav ? goalsNav.tokens : null;
    return '';
  }

  return {
    roster, spotNear, goTo, onPlay, update, colourFor,
    startGuide, stopGuide,
    /** Who Play should start next to; -1 for "whoever is nearest". */
    pickSpawn(id) { pickedSpawn = id == null ? -1 : id; },
    get picked() { return pickedSpawn; },
    get guide() { return guide; },
    /** The minimap's nav while guiding, else null. */
    get nav() { return guide.id >= 0 && nav.route ? nav : null; },
    get online() { return net ? net.people.size : 0; },
  };
}
