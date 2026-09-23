// Party games, on this screen: race your friends, tag, and coin rush.
//
// The room referees (server/modes.js) — who is in, when the countdown ends,
// who is IT, who reached a coin first, the finishing order. This module turns
// what the room says into what this player sees and does:
//
//   - puts you on the start grid when you join a race, holds you there, and
//     lets go at GO on the room's clock, so every screen starts together;
//   - watches YOUR car through the race gates (the one thing only this screen
//     knows exactly) and tells the room, which keeps the order;
//   - keeps a live running order for everyone in the race, from the gates the
//     room has confirmed and where each car is along the route right now;
//   - works out whose turn, whose score and how long is left, for the screen
//     (modesUi.js) and the world (render/modeFx.js) to draw;
//   - the emotes: four preset reactions, shown over the car that sent them.
//
// Pure: no DOM, no three.js. tools/modescheck.mjs drives three of these
// against the real room on the real world.

/** The four emotes, in key order 1-4. Words a kid would shout across the room. */
export const EMOTE_TEXT = ['Hi!', 'Follow me!', 'Wait up!', 'Nice one!'];

export const GAME_NAME = { race: 'Race', tag: 'Tag', coins: 'Coin Rush' };
// One colour per game, kept clear of the GPS cyan and of each other.
export const GAME_COLOUR = { race: 0xffb43c, tag: 0xff4d3a, coins: 0xffd84a };

const EMOTE_S = 3.2;           // s a reaction stays over the car
const EMOTE_GAP = 1.3;         // s between two of yours (the room allows 1.2)
// A staggered grid, as on a real circuit: two columns, each car 3.3 m behind
// the one before it on the other side, so 6.6 m nose to nose in a column
// (these cars are about 4.4 m long). Eight of them fit in the 30 m between a
// stage's first junction and its start line (challenges.js puts the line at
// d = 30), five metres short of it.
const GRID_STEP = 3.3;         // m between consecutive grid places
const GRID_LINE = 5;           // m from the line to pole position
const JUMP_START = 3.0;        // m off the grid spot before GO puts you back on it
const OFF_COURSE = 45;         // m from the race line after a jump: back to the last gate
const FAR_FROM_HOST = 450;     // m: joining tag or coins from further takes you to them
const COIN_COUNT = 12;

// ---------------------------------------------------------------------------
// Pure helpers, exported for the harness
// ---------------------------------------------------------------------------

/**
 * Grid place `slot` for race `c` (0 is pole): behind the start line of a
 * stage. A lap's start line is also its finish, so its grid is laid just past
 * the line, pole furthest on (goals.js starts a solo lap 3 m past it for the
 * same reason).
 */
export function gridSpot(c, slot, out = {}) {
  const col = slot % 2;
  const back = slot * GRID_STEP;
  const d = c.lap ? 3 + 7 * GRID_STEP - back : Math.max(1, c.start.d - GRID_LINE - back);
  const p = c.route.at(d, out);
  const off = (col === 0 ? -1 : 1) * Math.min(2.3, (p.hw || 4.5) * 0.42);
  const x = p.x - p.tz * off, z = p.z + p.tx * off;
  out.x = x; out.z = z; out.d = d;
  out.yaw = Math.atan2(-p.tx, -p.tz);
  return out;
}

/**
 * Where to scatter the coins: points on real roads (tracks too — a coin is a
 * reason to take the lane you never would) between 90 and 650 m from (x, z),
 * at least 110 m apart. Widens its search if the neighbourhood is short of
 * road. Deterministic in `rng`.
 */
export function pickCoinSpots(world, x, z, rng, n = COIN_COUNT) {
  const out = [];
  for (const [rMax, gap] of [[650, 110], [1000, 90], [1600, 70]]) {
    const cands = [];
    for (const e of world.edges) {
      const pts = e.pts;
      if (!pts || pts.length < 2) continue;
      for (let i = 1; i < pts.length - 1; i += 2) {
        const d = Math.hypot(pts[i].x - x, pts[i].z - z);
        if (d > 90 && d < rMax) cands.push(pts[i]);
      }
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = cands[i]; cands[i] = cands[j]; cands[j] = t;
    }
    for (const p of cands) {
      if (out.length >= n) break;
      let ok = true;
      for (const q of out) if (Math.hypot(q[0] - p.x, q[1] - p.z) < gap) { ok = false; break; }
      if (ok) out.push([Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);
    }
    if (out.length >= n) break;
  }
  return out;
}

/** m:ss.t — the same shape as the solo race clock (challenges.js). */
export function fmtRaceTime(ms) {
  if (!(ms >= 0) || !Number.isFinite(ms)) return '--:--.-';
  const tenths = Math.floor(ms / 100);
  const m = Math.floor(tenths / 600), s = Math.floor((tenths % 600) / 10);
  return `${m}:${s < 10 ? '0' : ''}${s}.${tenths % 10}`;
}

/** m:ss for a round clock. */
export function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------

/**
 * opts: {
 *   net                  net.js handle
 *   goals()              the goals layer (its races), or null
 *   world
 *   place(x, z, yaw)     put this car somewhere as a cut (main.js placeCar)
 *   abandonGoals()       end any solo race/zone first (main.js)
 *   colourOf(car)        party.colourFor
 *   self()               { name, carId, colour } for this player
 *   goTo(id)             party.goTo: onto the road behind a friend
 *   rng()
 * }
 */
export function createModes(opts) {
  const net = opts.net;
  const rng = opts.rng || Math.random;
  const events = [];                  // for the screen: { k, ... }, drained each frame
  const say = new Map();              // id -> { e, until }
  let clock = 0;
  const lastSelf = { x: 0, z: 0, ok: false };

  // What the screen and the world read. One object, updated in place.
  const view = {
    kind: '', phase: '', gid: 0, host: -1, hostName: '', hostCss: '#fff',
    name: '',                         // "Thunder Ridge Rally" / "Tag" / "Coin Rush"
    colour: 0xffffff, css: '#ffffff',
    inGame: false, watching: false, invite: false, unknown: false,
    lobbyLeft: 0, entrants: 0, goIn: 0, clockLeft: 0,
    // race
    race: null, next: 0, n: 0, myTime: 0, finished: false, myPlace: 0, myFin: 0,
    // tag
    it: -1, iAmIt: false, itName: '', itCss: '#fff', readyIn: 0,
    // coins
    pts: null, taken: null, coinsLeft: 0,
    rows: [],                         // standings, best first: { id, name, css, me, place, stat, g, d, fin }
  };
  const rowPool = [];
  const byStanding = (a, b) => (a.rank - b.rank) || (b.g - a.g) || (b.d - a.d) || (a.id - b.id);

  // ---- my race ---------------------------------------------------------------
  const my = {
    gid: -1, placed: false, onSpot: false, spot: { x: 0, z: 0, yaw: 0, d: 0 },
    next: 0, hint: -1, d: 0, prevX: 0, prevZ: 0, prevValid: false, prevD: 0,
    lastGate: -1, sentFor: -1, lost: 0,
  };
  const proj = { i: 0, d: 0, dist: 0 };
  const hints = new Map();            // remote id -> route hint
  const spot = { x: 0, z: 0, yaw: 0, d: 0 };
  // The race line for beacons.js to draw chevrons along (it draws a friend's
  // Guide the same way), and the minimap's nav while a game is on.
  const guide = { id: -2, name: '', hex: GAME_COLOUR.race, css: '#ffb43c', route: null, d: 0 };
  const nav = { route: null, from: 0, markers: null, tokens: null };
  const coinNav = { xs: null, zs: null, taken: null, n: 0 };

  function me() { return net ? net.id : -1; }
  function g() { return net ? net.mode : null; }
  function serverNow() { const t = net ? net.serverNow() : null; return t == null ? 0 : t; }
  function raceOf(id) {
    const gl = opts.goals ? opts.goals() : null;
    const c = gl && gl.byId ? gl.byId[id] : null;
    return c && c.kind === 'race' ? c : null;
  }
  function entrantOf(m, id) {
    if (!m || !m.ps) return null;
    for (const e of m.ps) if (e.id === id) return e;
    return null;
  }
  // Who this player is, read once a frame (opts.self() builds an object).
  const selfInfo = { name: '', carId: '', colour: 0 };
  function readSelf() {
    const s = opts.self ? opts.self() : null;
    selfInfo.name = (s && s.name) || 'You';
    selfInfo.carId = (s && s.carId) || '';
    selfInfo.colour = s ? s.colour | 0 : 0;
  }
  readSelf();
  function nameOf(id) {
    if (id === me()) return selfInfo.name;
    const p = net && net.people.get(id);
    return p ? p.name : `Driver-${id}`;
  }
  // A player's colour, by id: party.colourFor wants a car-like object, so one
  // scratch object is reused rather than one built per row per frame.
  const colourQ = { id: -1, carId: '', colour: 0 };
  function cssOf(id) {
    if (!opts.colourOf) return '#ffffff';
    colourQ.id = id;
    if (id === me()) { colourQ.carId = selfInfo.carId; colourQ.colour = selfInfo.colour; }
    else {
      const p = net && net.people.get(id);
      colourQ.carId = p ? p.car : ''; colourQ.colour = p ? p.colour : 0;
    }
    return opts.colourOf(colourQ).css;
  }

  // ---- what the room says ------------------------------------------------------

  /** net.onMode: the game changed. `ev` says what happened. */
  function onMode(m, ev) {
    const id = me();
    if (m && m.gid !== my.gid) {
      my.gid = m.gid; my.placed = false; my.next = 0; my.hint = -1; my.prevValid = false;
      my.lastGate = -1; my.sentFor = -1; my.lost = 0;
      hints.clear();
    }
    if (!ev) return;
    const k = ev.k;
    if (k === 'start' && m) {
      if (ev.id === id) events.push({ k: 'started', kind: m.kind });
      else events.push({ k: 'invite', kind: m.kind, id: ev.id });
    } else if (k === 'join' && m && ev.id === id) {
      events.push({ k: 'joined', kind: m.kind });
      // Tag and coins are played where the host is. Joining from across the
      // map takes you there, rather than leaving you to drive 3 km first.
      if ((m.kind === 'tag' || m.kind === 'coins') && opts.goTo && m.host !== id) {
        const hc = net.room.car(m.host);
        if (hc && lastSelf.ok && Math.hypot(hc.x - lastSelf.x, hc.z - lastSelf.z) > FAR_FROM_HOST) opts.goTo(m.host);
      }
    } else if (k === 'watch' && ev.id === id) {
      events.push({ k: 'watching' });
    } else if (k === 'grid') {
      if (m && entrantOf(m, id)) events.push({ k: 'grid' });
    } else if (k === 'go') {
      if (m && entrantOf(m, id)) events.push({ k: 'go', kind: m.kind, it: m.it });
      else if (m && m.kind === 'tag') events.push({ k: 'tagstart', it: m.it });
    } else if (k === 'tag') {
      events.push({ k: 'tag', from: ev.from, to: ev.to });
    } else if (k === 'newit') {
      events.push({ k: 'newit', to: ev.id, from: ev.from });
    } else if (k === 'coin') {
      events.push({ k: 'coin', i: ev.i, id: ev.id });
    } else if (k === 'fin') {
      events.push({ k: 'fin', id: ev.id, place: ev.place });
    } else if (k === 'done' || k === 'time' || k === 'allcoins' || (k === 'leave' && m && m.phase === 'done')) {
      if (m) events.push({ k: 'podium', kind: m.kind });
    } else if (k === 'cancel') {
      events.push({ k: 'cancel', why: ev.why });
    } else if (k === 'leave' && ev.id !== id) {
      events.push({ k: 'left', id: ev.id });
    }
  }

  function expire(s, id) { if (clock > s.until) say.delete(id); }

  function onEmote(id, e) {
    say.set(id, { e, until: clock + EMOTE_S });
    events.push({ k: 'emote', id, e });
  }

  if (net) { net.onMode = onMode; net.onEmote = onEmote; }

  // ---- actions -------------------------------------------------------------------

  function canPlay() { return !!(net && net.serverProto === 2 && net.status === 'live'); }

  function startRace(raceId, again) {
    const c = raceOf(raceId);
    if (!c || !canPlay()) return false;
    return net.sendMode('race', { race: c.id, n: c.gates.length, again });
  }
  function startTag(again) { return canPlay() && net.sendMode('tag', { again }); }
  function startCoins(self, again) {
    if (!canPlay() || !opts.world || !self) return false;
    const pts = pickCoinSpots(opts.world, self.x, self.z, rng);
    return pts.length >= 3 && net.sendMode('coins', { pts, again });
  }
  /** Rematch: the same game, the same players. */
  function again(self) {
    const m = g();
    if (!m || m.phase !== 'done') return false;
    if (m.kind === 'race') return startRace(m.race, true);
    if (m.kind === 'tag') return startTag(true);
    return startCoins(self, true);
  }
  function join() { return canPlay() && net.sendMode('join'); }
  function leave() { return canPlay() && net.sendMode('leave'); }
  // The room takes one emote per player every 1.2 s and drops the rest. The
  // same limit here, a touch longer, so your own bubble never shows one your
  // friends did not get.
  let lastEmote = -Infinity;
  function emote(e) {
    if (clock - lastEmote < EMOTE_GAP || !net || !net.emote(e)) return false;
    lastEmote = clock;
    say.set(me(), { e, until: clock + EMOTE_S });
    return true;
  }

  /** The nearest race to (x, z) that this world has, then the rest by distance. */
  function racesNear(self) {
    const gl = opts.goals ? opts.goals() : null;
    if (!gl) return [];
    const list = gl.list.filter((c) => c.kind === 'race');
    if (self) list.sort((a, b) => Math.hypot(a.start.x - self.x, a.start.z - self.z) - Math.hypot(b.start.x - self.x, b.start.z - self.z));
    return list;
  }

  // ---- the frame -------------------------------------------------------------------

  /**
   * Once a frame. `self` is where this car is drawn ({x, z, yaw}; main.js
   * passes `pose`), `driving` whether the player has the wheel.
   */
  function update(dt, self, driving) {
    clock += dt;
    if (self) { lastSelf.x = self.x; lastSelf.z = self.z; lastSelf.ok = true; }
    readSelf();
    if (say.size) say.forEach(expire);
    const m = g();
    const id = me();
    const v = view;
    guide.route = null;
    nav.route = null; nav.tokens = null; nav.markers = null;
    if (!m || !m.kind) { reset(v); return; }

    const t = serverNow();
    const e = entrantOf(m, id);
    v.kind = m.kind; v.phase = m.phase; v.gid = m.gid; v.host = m.host;
    v.hostName = nameOf(m.host); v.hostCss = cssOf(m.host);
    v.colour = GAME_COLOUR[m.kind] || 0xffffff;
    v.css = '#' + v.colour.toString(16).padStart(6, '0');
    v.inGame = !!e;
    v.watching = m.kind === 'race' && Array.isArray(m.spect) && m.spect.includes(id);
    v.entrants = m.ps.length;
    v.lobbyLeft = m.phase === 'lobby' ? Math.max(0, m.at - t) : 0;
    v.goIn = m.go ? m.go - t : 0;
    v.clockLeft = m.phase === 'run' || m.phase === 'done' ? Math.max(0, m.at - t) : 0;
    const c = m.kind === 'race' ? raceOf(m.race) : null;
    v.race = c;
    v.unknown = m.kind === 'race' && !c;
    v.name = c ? c.name : GAME_NAME[m.kind] || '';
    v.invite = m.phase === 'lobby' && !e && !v.unknown;

    if (m.kind === 'race') raceFrame(m, c, e, t, self, driving);
    else if (m.kind === 'tag') tagFrame(m, t);
    else if (m.kind === 'coins') coinFrame(m);
    rows(m, t);
  }

  function reset(v) {
    if (!v.kind) return;
    v.kind = ''; v.phase = ''; v.inGame = false; v.watching = false; v.invite = false;
    v.race = null; v.pts = null; v.taken = null; v.it = -1; v.iAmIt = false; v.finished = false;
    v.rows.length = 0;
  }

  function raceFrame(m, c, e, t, self, driving) {
    const v = view;
    v.n = m.n;
    v.finished = !!(e && e.fin);
    v.myFin = e ? e.fin : 0;
    v.myPlace = e ? e.place : 0;
    if (!c || !e || !self) { v.next = 0; v.myTime = 0; return; }
    // Onto the grid the moment you are in, whatever you were doing.
    if (!my.placed && (m.phase === 'lobby' || m.phase === 'grid')) {
      if (opts.abandonGoals) opts.abandonGoals();
      gridSpot(c, e.slot, my.spot);
      if (opts.place) opts.place(my.spot.x, my.spot.z, my.spot.yaw);
      my.placed = true;
      my.onSpot = false;
      my.prevValid = false;
      my.next = 0;
      my.d = my.spot.d;
      my.hint = -1;
      events.push({ k: 'ongrid', slot: e.slot });
    }
    // Held on the grid (main.js reads `hold`). Should anything let the car
    // roll anyway, a wheel off the spot before GO is a jump start: back on it.
    // Only once the car has been SEEN on its spot: `self` is where the car is
    // drawn, and for the frame of the placement that is still where it was.
    const offSpot = Math.hypot(self.x - my.spot.x, self.z - my.spot.z);
    if (my.placed && offSpot < 0.5) my.onSpot = true;
    if (my.placed && my.onSpot && (m.phase === 'lobby' || m.phase === 'grid') && driving && offSpot > JUMP_START) {
      if (opts.place) opts.place(my.spot.x, my.spot.z, my.spot.yaw);
      my.onSpot = false;
      my.prevValid = false;
      events.push({ k: 'jumpstart' });
    }
    v.myTime = m.phase === 'run' ? (e.fin || Math.max(0, t - m.go)) : 0;
    // The race line: chevrons from where you are, and the minimap line.
    guide.route = c.route; guide.hex = GAME_COLOUR.race; guide.css = '#ffb43c';
    const gl = opts.goals ? opts.goals() : null;
    nav.route = c.route; nav.markers = gl && gl.nav ? gl.nav.markers : null;
    if (m.phase !== 'run' || e.fin) {
      const pr = c.route.project(self.x, self.z, my.hint, 30, proj);
      my.hint = pr.i; my.d = pr.d;
      guide.d = my.d; nav.from = my.hint;
      v.next = e.g;
      my.prevX = self.x; my.prevZ = self.z; my.prevValid = !!driving;
      return;
    }
    // Running: my own gates.
    if (my.next < e.g) my.next = e.g;
    const prevD = my.d;
    const pr = c.route.project(self.x, self.z, my.hint, 30, proj);
    if (pr.dist > 25) c.route.project(self.x, self.z, -1, 0, proj);
    my.hint = proj.i; my.d = proj.d;
    guide.d = my.d; nav.from = my.hint;
    const moved = my.prevValid ? Math.hypot(self.x - my.prevX, self.z - my.prevZ) : 0;
    // A jump off the course (R, or the map): put back at the last gate.
    if (moved > 60 && proj.dist > OFF_COURSE) {
      const gk = my.next > 0 ? c.gates[my.next - 1] : null;
      const d = gk ? gk.d + 4 : my.spot.d;
      const p = c.route.at(d, spot);
      if (opts.place) opts.place(p.x, p.z, Math.atan2(-p.tx, -p.tz));
      events.push({ k: 'backon', gate: my.next });
      my.prevValid = false;
      my.d = d;
      return;
    }
    const gate = c.gates[my.next];
    if (gate && my.prevValid && driving && moved < 60) {
      // The same two tests as a solo race (goals.js raceStep): through the
      // plane between the gate's posts with a generous margin, or past it by
      // progress along the line while near it.
      const a0 = (my.prevX - gate.x) * gate.tx + (my.prevZ - gate.z) * gate.tz;
      const a1 = (self.x - gate.x) * gate.tx + (self.z - gate.z) * gate.tz;
      const lat = Math.abs((self.x - gate.x) * -gate.tz + (self.z - gate.z) * gate.tx);
      let f = -1;
      if (a0 < 0 && a1 >= 0 && lat < gate.hw + 14) f = a1 / Math.max(1e-6, a1 - a0);
      else if (prevD < gate.d && my.d >= gate.d && proj.dist < 30 && my.d - prevD < 60) f = (my.d - gate.d) / Math.max(1e-6, my.d - prevD);
      if (f >= 0) {
        // The crossing, in the room's race time, back-dated within the frame.
        const rt = Math.max(0, t - m.go - f * (1000 / 60));
        net.sendMode('gate', { g: my.next, ms: rt });
        my.lastGate = my.next;
        my.next++;
        events.push({ k: 'gate', g: my.next, n: m.n });
      }
    }
    v.next = my.next;
    my.prevX = self.x; my.prevZ = self.z; my.prevValid = !!driving;
  }

  function tagFrame(m, t) {
    const v = view;
    v.it = m.phase === 'run' ? m.it : -1;
    // IT's count at the start of a round (and the breath after each tag).
    v.readyIn = m.phase === 'run' && m.ready ? Math.max(0, m.ready - t) : 0;
    v.iAmIt = v.it >= 0 && v.it === me();
    v.itName = v.it >= 0 ? nameOf(v.it) : '';
    v.itCss = v.it >= 0 ? cssOf(v.it) : '#fff';
  }

  function coinFrame(m) {
    const v = view;
    v.pts = m.pts; v.taken = m.taken;
    let left = 0;
    for (let i = 0; i < m.taken.length; i++) if (!m.taken[i]) left++;
    v.coinsLeft = left;
    if (!coinNav.xs || coinNav.xs.length !== m.pts.length) {
      coinNav.xs = new Float32Array(m.pts.length); coinNav.zs = new Float32Array(m.pts.length);
      coinNav.taken = new Uint8Array(m.pts.length);
    }
    for (let i = 0; i < m.pts.length; i++) { coinNav.xs[i] = m.pts[i][0]; coinNav.zs[i] = m.pts[i][1]; coinNav.taken[i] = m.taken[i] ? 1 : 0; }
    coinNav.n = m.pts.length;
    if (view.inGame) nav.tokens = coinNav;
  }

  /** The running order / scoreboard, best first. */
  function rows(m, t) {
    const out = view.rows;
    out.length = 0;
    const id = me();
    const c = view.race;
    let i = 0;
    for (const e of m.ps) {
      const r = rowPool[i] || (rowPool[i] = {});
      i++;
      r.id = e.id; r.me = e.id === id;
      r.name = nameOf(e.id); r.css = cssOf(e.id);
      r.g = e.g; r.ms = e.ms; r.fin = e.fin; r.place = e.place; r.d = 0; r.rank = 1e9;
      if (m.kind === 'race') {
        // Finished: by place. Otherwise by gates the room has confirmed (mine
        // counts as soon as I cross — the room will agree), then by how far
        // along the line each car is right now.
        if (r.me) { r.g = Math.max(e.g, my.next); r.d = my.d; }
        else if (c) {
          const car = net.room.car(e.id);
          if (car && car.active) {
            const pr = c.route.project(car.x, car.z, hints.get(e.id) ?? -1, 30, proj);
            if (pr.dist > 25) c.route.project(car.x, car.z, -1, 0, proj);
            hints.set(e.id, proj.i);
            r.d = proj.d;
          }
        }
        r.rank = e.fin ? e.place : 1e6;
        r.stat = e.fin ? fmtRaceTime(e.fin) : '';
      } else if (m.kind === 'tag') {
        // Time free, counted on from the room's last word unless IT.
        const live = e.free + (m.phase === 'run' && e.id !== m.it ? Math.max(0, t - m.s) : 0);
        r.free = live;
        r.rank = m.phase === 'done' ? e.place : 1e6 - live / 1000;
        r.stat = fmtClock(live);
      } else {
        r.rank = m.phase === 'done' ? e.place : 1e6 - e.n;
        r.stat = `${e.n}`;
      }
      out.push(r);
    }
    out.sort(byStanding);
    // The number shown: the running order, or on the podium the room's
    // places (a tie shares a step).
    for (let k = 0; k < out.length; k++) out[k].pos = m.phase === 'done' && out[k].place ? out[k].place : k + 1;
  }

  // ---- read by everything else ------------------------------------------------------

  return {
    view, events, guide, EMOTE_TEXT,
    update, onMode, onEmote,
    startRace, startTag, startCoins, again, join, leave, emote, racesNear,
    get canPlay() { return canPlay(); },
    /** True while this car must sit on the grid (main.js holds the brakes). */
    get hold() {
      const m = g();
      return !!(m && m.kind === 'race' && my.placed && (m.phase === 'lobby' || m.phase === 'grid') && entrantOf(m, me()));
    },
    /** True while a game is steering this player: the challenge GPS stands down. */
    get owns() { return view.inGame && view.phase !== 'done'; },
    /** The race line for the chevrons, or null. */
    get raceGuide() { return guide.route ? guide : null; },
    /** The minimap's route/coins while in a game, or null. */
    get nav() { return view.inGame && (nav.route || nav.tokens) ? nav : null; },
    /** Why Go would be wrong right now ('' when it is fine). */
    get blocksGo() {
      if (!view.inGame || view.phase === 'done') return '';
      if (view.kind === 'race') return 'You are in a race: Backspace leaves it';
      return `No jumping in ${GAME_NAME[view.kind]}: drive!`;
    },
    /** 'IT' over the IT car, 'P2' over a racer, else ''. */
    badge(id) {
      const v = view;
      const m = g();
      if (m && m.kind === 'tag' && m.phase === 'run' && m.it === id) return 'IT';
      if (v.kind === 'race' && v.phase === 'run') {
        for (const r of v.rows) if (r.id === id) return BADGE[r.pos] || '';
      }
      return '';
    },
    /** The reaction over car `id` right now, or ''. */
    say(id) { const s = say.get(id); return s ? EMOTE_TEXT[s.e] : ''; },
    nameOf, cssOf,
    myId: () => me(),
  };
}

const BADGE = ['', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
