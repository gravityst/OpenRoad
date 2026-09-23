/**
 * Party games, refereed by the room.
 *
 * Three games and a handful of emotes, for a few kids who are in the same
 * world at the same time:
 *
 *   RACE    anyone starts one of the world's races as a room event; the others
 *           get an invite; entrants line up on a grid, a countdown runs off the
 *           server's clock, and the room keeps the order to the finish.
 *   TAG     one car is IT. The room decides every tag from the positions it is
 *           already relaying — nobody's screen gets a say — and whoever spends
 *           the least time IT wins.
 *   COINS   a dozen coins scattered round the roads near the players; the room
 *           decides who reached each one first.
 *   EMOTES  four preset reactions. Never text a player typed.
 *
 * ALL game state lives here. A client renders what the room says and reports
 * only what it alone can see (that it drove through its own next race gate).
 * Nothing a player types is ever relayed: a race is named by an id every
 * client looks up in its own copy of the world (and never displays raw), coin
 * spots are numbers, emotes are 0-3.
 *
 * Generation 2 only. A protocol-1 room never creates this, never sends a byte
 * of it, and so stays exactly what the live Worker has always been.
 *
 * Pure: no sockets, no timers, no platform. roomcore.js hands it the room's
 * clock, its players and a way to talk to them, and ticks it at 20 Hz.
 */

// ---- rules, in the units they are felt in ---------------------------------

export const EMOTES = 4;               // presets 0-3 (the client has the words)
export const MAX_RACERS = 8;           // two columns of four on a start grid
export const MAX_ENTRANTS = 16;
export const RACE_ID_RE = /^(race|stage)-[a-z0-9-]{1,40}$/;

const LOBBY_RACE = 15000;   // ms the invite stays open
const LOBBY_TAG = 10000;
const LOBBY_COINS = 10000;
const LOBBY_AGAIN = 8000;   // a rematch: everyone is already in
const LOBBY_ALL_IN = 3000;  // ...and when every driver in the room has joined, go
const GRID_MS = 4000;       // on the grid: "ready", then 3-2-1
const RACE_MAX = 8 * 60000; // a race nobody finishes still ends
const FINISH_WINDOW = 45000; // after the winner, how long the rest get
const PODIUM_MS = 12000;
const TAG_ROUND = 150000;
const COIN_ROUND = 150000;

// A tag: centres within TAG_R and closing, or within TAG_TOUCH at all. Cars
// are about 4.4 m long and 1.9 m wide, so 4.6 m is a bumper touching a
// bumper, or a door alongside a door. Positions are brought to the same
// instant first (see posAt), so a 30 m/s car is not tagged by where it was
// 50 ms ago.
const TAG_R = 4.6;
const TAG_TOUCH = 3.0;
const TAG_CLOSING = 1.0;    // m/s
const NO_TAGBACK = 4000;    // ms the new IT cannot tag whoever just tagged them
const TAG_GRACE = 1500;     // ms after any tag before the next can happen
// At the start of a round IT counts to three: the players usually start in a
// clump (they have just finished a race together, or were brought to the
// host), and without a head start the first tag landed the instant the grace
// ran out, before anyone had moved.
const TAG_COUNT = 3000;
const COIN_R = 7.0;         // m: generous, a coin is a prize, not a test
const CUT_GRACE = 1500;     // ms after a respawn/teleport a car cannot tag or be tagged
const STALE_POS = 1000;     // ms without a state: that car's position is not trusted
const EXTRAP_MAX = 250;     // ms a position may be carried forward to "now"
const START_GAP = 10000;    // ms between one player's game starts (invites are loud)
const EMOTE_GAP = 1200;     // ms between one player's emotes
const COINS_MIN = 3, COINS_MAX = 16;
const WORLD_LIMIT = 20000;  // m: a coin spot outside this is not on any map

const KINDS = { race: 1, tag: 1, coins: 1 };

/**
 * opts: {
 *   ms()                 the room clock (what clients sync serverNow() to)
 *   players()            iterable of joined players: { id, rec, recMs }
 *   broadcast(obj, exceptId)
 *   rng()                0..1, for picking who is IT first
 * }
 */
export function createModes(opts) {
  const ms = opts.ms;
  const rng = opts.rng || Math.random;
  const lastStart = new Map();          // id -> ms
  const lastEmote = new Map();
  const seqOf = new Map();              // id -> respawnSeq last seen
  const cutAt = new Map();              // id -> ms of their last respawn/teleport
  let v = 0;                            // bumps on every change the clients see
  let gid = 0;                          // bumps once per game: a rematch is a new game
  let lastTick = -1;

  // The one game in progress (or none: kind '').
  const g = {
    kind: '', phase: '', host: -1, at: 0, go: 0,
    race: '', n: 0, finishers: 0,
    it: -1, noBack: -1, noBackUntil: 0, graceUntil: 0,
    pts: null, taken: null,
    ps: new Map(),                      // id -> entrant
    spect: new Set(),                   // race only: watching, queued for the next
  };

  function entrant(id, slot) {
    return { id, slot, g: 0, ms: 0, fin: 0, place: 0, free: 0, n: 0 };
  }

  function playerById(id) {
    for (const p of opts.players()) if (p.id === id) return p;
    return null;
  }
  function joinedCount() {
    let n = 0;
    for (const p of opts.players()) if (p.joined) n++;
    return n;
  }

  // ---- what the clients are told -------------------------------------------

  /** The whole game as one small JSON object; null when nothing is on. */
  function wire() {
    if (!g.kind) return null;
    const ps = [];
    for (const e of g.ps.values()) ps.push({ id: e.id, slot: e.slot, g: e.g, ms: e.ms, fin: e.fin, place: e.place, free: e.free, n: e.n });
    const o = { v, gid, kind: g.kind, phase: g.phase, host: g.host, at: g.at, go: g.go, s: ms(), ps };
    if (g.kind === 'race') { o.race = g.race; o.n = g.n; o.spect = [...g.spect]; }
    if (g.kind === 'tag') { o.it = g.it; o.noBack = g.noBack; o.noBackUntil = g.noBackUntil; o.ready = g.graceUntil; }
    if (g.kind === 'coins') { o.pts = g.pts; o.taken = g.taken; }
    return o;
  }

  function tell(ev) {
    v++;
    const o = wire() || { v, kind: '', phase: '', s: ms() };
    o.t = 'mode';
    if (ev) o.ev = ev;
    opts.broadcast(o);
  }

  function clear(ev) {
    g.kind = ''; g.phase = ''; g.host = -1; g.ps.clear(); g.spect.clear();
    g.pts = null; g.taken = null; g.it = -1; g.finishers = 0;
    tell(ev);
  }

  // ---- starting, joining, leaving -------------------------------------------

  function start(p, m, t) {
    const kind = m.a;
    if (!KINDS[kind]) return;
    // One game at a time. The one exception is the podium: a new game may
    // start over it, and "again" carries the same players into a rematch.
    if (g.kind && g.phase !== 'done') return;
    if (t - (lastStart.get(p.id) ?? -Infinity) < START_GAP) return;
    let race = '', n = 0, pts = null;
    if (kind === 'race') {
      if (typeof m.race !== 'string' || !RACE_ID_RE.test(m.race)) return;
      n = Number(m.n);
      if (!Number.isInteger(n) || n < 1 || n > 32) return;
      race = m.race;
    } else if (kind === 'coins') {
      pts = cleanPts(m.pts);
      if (!pts) return;
    }
    const again = !!m.again && g.kind === kind && g.phase === 'done';
    const carry = again ? [...g.ps.keys(), ...g.spect] : [];
    lastStart.set(p.id, t);
    gid++;
    g.kind = kind; g.phase = 'lobby'; g.host = p.id; g.go = 0;
    g.race = race; g.n = n; g.finishers = 0;
    g.it = -1; g.noBack = -1; g.noBackUntil = 0; g.graceUntil = 0;
    g.pts = pts; g.taken = pts ? pts.map(() => 0) : null;
    g.ps.clear(); g.spect.clear();
    const cap = kind === 'race' ? MAX_RACERS : MAX_ENTRANTS;
    const ids = [p.id, ...carry.filter((id) => id !== p.id && playerById(id))];
    for (const id of ids) if (g.ps.size < cap) g.ps.set(id, entrant(id, g.ps.size));
    g.at = t + (again ? LOBBY_AGAIN : kind === 'race' ? LOBBY_RACE : kind === 'tag' ? LOBBY_TAG : LOBBY_COINS);
    allIn(t);
    tell({ k: 'start', id: p.id });
  }

  /** Everyone in the room is in: no point holding the lobby open. */
  function allIn(t) {
    if (g.phase === 'lobby' && g.ps.size >= 2 && g.ps.size >= joinedCount()) g.at = Math.min(g.at, t + LOBBY_ALL_IN);
  }

  function join(p, t) {
    if (!g.kind || g.phase === 'done' || g.ps.has(p.id)) return;
    if (g.kind === 'race') {
      if (g.phase !== 'lobby' || g.ps.size >= MAX_RACERS) {
        // Too late for this grid (or it is full): watch, and be in the next.
        if (!g.spect.has(p.id)) { g.spect.add(p.id); tell({ k: 'watch', id: p.id }); }
        return;
      }
      g.ps.set(p.id, entrant(p.id, freeSlot()));
    } else {
      if (g.ps.size >= MAX_ENTRANTS) return;
      g.ps.set(p.id, entrant(p.id, g.ps.size));
    }
    allIn(t);
    tell({ k: 'join', id: p.id });
  }

  function freeSlot() {
    const used = new Set();
    for (const e of g.ps.values()) used.add(e.slot);
    let s = 0;
    while (used.has(s)) s++;
    return s;
  }

  /** A player left the game (or the room). The game carries on without them
   *  if it still can. */
  function drop(id, why) {
    g.spect.delete(id);
    if (!g.ps.has(id)) return;
    g.ps.delete(id);
    if (!g.kind || g.phase === 'done') return;
    const t = ms();
    const left = g.ps.size;
    if (g.phase === 'lobby') {
      if (!left) return clear({ k: 'cancel', why: 'empty' });
      if (g.host === id) g.host = g.ps.keys().next().value;
      return tell({ k: 'leave', id, why });
    }
    if (g.kind === 'race') {
      if (!left) return clear({ k: 'cancel', why: 'empty' });
      if (everyoneHome()) return finish(t, { k: 'leave', id, why });
      return tell({ k: 'leave', id, why });
    }
    // Tag and coins need two.
    if (left < 2) return finish(t, { k: 'leave', id, why, short: 1 });
    if (g.kind === 'tag' && g.it === id) {
      g.it = pickIt(-1);
      g.noBack = -1;
      g.graceUntil = t + TAG_GRACE;
      return tell({ k: 'newit', id: g.it, from: id });
    }
    tell({ k: 'leave', id, why });
  }

  function everyoneHome() {
    for (const e of g.ps.values()) if (!e.fin) return false;
    return true;
  }

  function pickIt(not) {
    const ids = [...g.ps.keys()].filter((id) => id !== not);
    if (!ids.length) return -1;
    return ids[Math.min(ids.length - 1, Math.floor(rng() * ids.length))];
  }

  // ---- the podium -------------------------------------------------------------

  function finish(t, ev) {
    g.phase = 'done';
    g.at = t + PODIUM_MS;
    if (g.kind === 'tag' || g.kind === 'coins') {
      // Most time free / most coins first; a tie shares the step.
      const key = g.kind === 'tag' ? (e) => e.free : (e) => e.n;
      const list = [...g.ps.values()].sort((a, b) => key(b) - key(a));
      let place = 0, prev = NaN;
      list.forEach((e, i) => { if (key(e) !== prev) { place = i + 1; prev = key(e); } e.place = place; });
    }
    tell(ev || { k: 'done' });
  }

  // ---- messages -----------------------------------------------------------------

  function control(p, m) {
    if (!p.joined || !m || typeof m !== 'object') return;
    const t = ms();
    if (m.t === 'emote') {
      const e = Number(m.e);
      if (!Number.isInteger(e) || e < 0 || e >= EMOTES) return;
      if (t - (lastEmote.get(p.id) ?? -Infinity) < EMOTE_GAP) return;
      lastEmote.set(p.id, t);
      opts.broadcast({ t: 'emote', id: p.id, e }, p.id);
      return;
    }
    if (m.t !== 'mode') return;
    const a = m.a;
    if (KINDS[a]) start(p, m, t);
    else if (a === 'join') join(p, t);
    else if (a === 'leave') drop(p.id, 'left');
    else if (a === 'gate') gate(p, m, t);
  }

  /**
   * A racer drove through their next gate. The one thing a client reports,
   * because only it knows exactly when its car crossed the line; the room
   * still checks it is the NEXT gate and a plausible time.
   */
  function gate(p, m, t) {
    if (g.kind !== 'race' || g.phase !== 'run') return;
    const e = g.ps.get(p.id);
    if (!e || e.fin) return;
    const k = Number(m.g);
    if (!Number.isInteger(k) || k !== e.g) return;
    const elapsed = t - g.go;
    let rt = Number(m.ms);
    // Measured by the client off the synced clock, so normally within a few
    // ms of the room's own figure; never ahead of it, never wildly behind.
    if (!(rt >= 0) || rt > elapsed + 250 || rt < elapsed - 3000) rt = elapsed;
    rt = Math.max(rt, e.ms);
    e.g = k + 1;
    e.ms = Math.round(rt);
    if (e.g >= g.n) {
      e.fin = e.ms;
      e.place = ++g.finishers;
      if (e.place === 1) g.at = Math.min(g.at, t + FINISH_WINDOW);
      if (everyoneHome()) return finish(t, { k: 'fin', id: p.id, place: e.place });
      return tell({ k: 'fin', id: p.id, place: e.place });
    }
    tell({ k: 'gate', id: p.id, g: e.g });
  }

  // ---- the clock ------------------------------------------------------------------

  const posA = { x: 0, z: 0, vx: 0, vz: 0 }, posB = { x: 0, z: 0, vx: 0, vz: 0 };

  /** Where a player's car is at room time t, from its last record, carried
   *  forward by its velocity (never more than EXTRAP_MAX). False when the
   *  record is too old to trust or the car was just put somewhere. */
  function posAt(p, t, out) {
    const r = p.rec;
    if (!r || t - (p.recMs ?? -Infinity) > STALE_POS) return false;
    if (t - (cutAt.get(p.id) ?? -Infinity) < CUT_GRACE) return false;
    const at = r.sampleMs != null ? r.sampleMs : p.recMs;
    const h = Math.max(0, Math.min(EXTRAP_MAX, t - at)) / 1000;
    out.x = r.x + (r.vx || 0) * h; out.z = r.z + (r.vz || 0) * h;
    out.vx = r.vx || 0; out.vz = r.vz || 0;
    return true;
  }

  function tick() {
    const t = ms();
    const dt = lastTick < 0 ? 0 : Math.max(0, Math.min(1000, t - lastTick));
    lastTick = t;
    // A respawn or teleport is a cut: nobody may be tagged by, or grab a coin
    // with, a car that has just been put there.
    for (const p of opts.players()) {
      const r = p.rec;
      if (!r) continue;
      const s = r.respawnSeq | 0;
      if (seqOf.has(p.id) && seqOf.get(p.id) !== s) cutAt.set(p.id, t);
      seqOf.set(p.id, s);
    }
    if (!g.kind) return;
    // Anyone the room no longer has is out of the game.
    for (const id of [...g.ps.keys()]) if (!playerById(id)) drop(id, 'gone');
    if (!g.kind) return;

    if (g.phase === 'lobby') {
      if (t < g.at) return;
      if (g.ps.size < 2) return clear({ k: 'cancel', why: 'nobody' });
      if (g.kind === 'race') { g.phase = 'grid'; g.go = t + GRID_MS; g.at = g.go; return tell({ k: 'grid' }); }
      g.phase = 'run'; g.go = t; g.at = t + (g.kind === 'tag' ? TAG_ROUND : COIN_ROUND);
      if (g.kind === 'tag') { g.it = pickIt(-1); g.graceUntil = t + TAG_COUNT; }
      return tell({ k: 'go', it: g.it });
    }
    if (g.phase === 'grid') {
      if (t < g.go) return;
      g.phase = 'run'; g.at = g.go + RACE_MAX;
      return tell({ k: 'go' });
    }
    if (g.phase === 'done') {
      if (t >= g.at) clear({ k: 'over' });
      return;
    }
    // Running.
    if (t >= g.at) return finish(t, { k: 'time' });
    if (g.kind === 'tag') tagStep(t, dt);
    else if (g.kind === 'coins') coinStep(t);
  }

  function tagStep(t, dt) {
    for (const e of g.ps.values()) if (e.id !== g.it) e.free += dt;
    if (t < g.graceUntil) return;
    const itP = playerById(g.it);
    if (!itP || !posAt(itP, t, posA)) return;
    let best = null, bd = Infinity;
    for (const e of g.ps.values()) {
      if (e.id === g.it) continue;
      if (e.id === g.noBack && t < g.noBackUntil) continue;
      const q = playerById(e.id);
      if (!q || !posAt(q, t, posB)) continue;
      const dx = posB.x - posA.x, dz = posB.z - posA.z;
      const d = Math.hypot(dx, dz);
      if (d > TAG_R) continue;
      // Positive when the gap is shrinking.
      const closing = d > 1e-3 ? -((dx * (posB.vx - posA.vx) + dz * (posB.vz - posA.vz)) / d) : 0;
      if (d > TAG_TOUCH && closing < TAG_CLOSING) continue;
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return;
    const from = g.it;
    g.it = best.id;
    g.noBack = from;
    g.noBackUntil = t + NO_TAGBACK;
    g.graceUntil = t + TAG_GRACE;
    tell({ k: 'tag', from, to: best.id });
  }

  function coinStep(t) {
    let left = 0;
    for (let i = 0; i < g.pts.length; i++) {
      if (g.taken[i]) continue;
      const [cx, cz] = g.pts[i];
      let best = null, bd = COIN_R;
      for (const e of g.ps.values()) {
        const q = playerById(e.id);
        if (!q || !posAt(q, t, posA)) continue;
        const d = Math.hypot(posA.x - cx, posA.z - cz);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        g.taken[i] = best.id;
        best.n++;
        tell({ k: 'coin', i, id: best.id });
      } else left++;
    }
    if (!left) finish(t, { k: 'allcoins' });
  }

  return {
    control, tick, wire,
    /** The player left the room. */
    drop: (id) => drop(id, 'gone'),
    /** For the harness. */
    get game() { return g; },
  };
}

/** Coin spots: 3-16 pairs of finite numbers inside the world, to 0.1 m. */
function cleanPts(pts) {
  if (!Array.isArray(pts) || pts.length < COINS_MIN || pts.length > COINS_MAX) return null;
  const out = [];
  for (const q of pts) {
    if (!Array.isArray(q) || q.length !== 2) return null;
    const x = Number(q[0]), z = Number(q[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return null;
    out.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }
  return out;
}
