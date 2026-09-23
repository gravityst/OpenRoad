/**
 * The transport. Everything that knows the word "WebSocket" lives here, so the
 * room logic above it can be tested without a socket and the whole feature can
 * be moved to a different host by changing one URL.
 *
 * createNet() RETURNS SYNCHRONOUSLY with a fully usable object and connects in
 * the background. It must never await the socket and must never throw: a dead
 * server has to mean "you are driving alone", not a game that fails to boot.
 *
 * This client speaks protocol generation 2 and says so twice: `v=2` in the URL
 * (which is what puts it in the generation-2 room — see protocol.js) and
 * `proto: 2` in the join. If the server it reaches has not been updated, the
 * welcome comes back without a `proto` and everything here falls back to
 * generation-1 behaviour: no ages, no car bodies, nothing it would misread.
 */

import { encodeState, MSG_SNAPSHOT, cleanName, cleanCarId, cleanColour, PROTO_V2 } from './protocol.js';
import { createRoom } from './room.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];
// Six quick pings to lock the clock on, then one every two seconds to keep it
// there. A ping is ~40 bytes; the 20 Hz state stream is fifty times that.
const PING_FAST = 250, PING_FAST_N = 6, PING_SLOW = 2000;
// While the game loop is not running (a background tab: no rAF) the server
// would drop us after 8 s of silence, and everyone else would see a "left"
// and a "joined" every time someone looked at another tab. A timer keeps the
// socket known to be alive; browsers throttle it to 1 Hz, which is plenty.
const KEEPALIVE_MS = 2500;

/** The URL with this client's generation on it, unless it already has one. */
export function withProto(url) {
  if (!url || /[?&]v=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + PROTO_V2;
}

export function createNet(opts = {}) {
  const room = createRoom({ maxPlayers: opts.maxPlayers ?? 16, heightAt: opts.heightAt });
  const makeSocket = opts.socketFactory || (u => new WebSocket(u));
  const now = opts.now || (() => performance.now());
  const url = withProto(opts.url || '');

  let ws = null;
  let state = 'idle';            // idle | connecting | live | retry | off
  let tries = 0;
  let retryAt = 0;
  let sendAcc = 0;
  let sendHz = opts.sendHz ?? 20;
  let selfId = -1;
  let epoch = 0;
  let lastErr = '';
  let serverProto = 0;           // 0 until welcomed; 1 = an old server
  let welcomed = false;
  let pingsSent = 0, nextPing = 0;
  let lastUpdate = 0;
  let carId = cleanCarId(opts.carId);
  let colour = cleanColour(opts.colour);
  let name = cleanName(opts.name, 'Driver');
  // id -> { id, name, car, colour }. Everyone else in the room, as the server
  // described them. The car's live pose is in room.cars; this is who they are.
  const people = new Map();
  let onRoster = opts.onRoster || null;
  let onEvent = opts.onEvent || null;

  function connect() {
    if (!url || state === 'connecting' || state === 'live' || state === 'off') return;
    state = 'connecting';
    let s;
    try {
      s = makeSocket(url);
    } catch (err) {
      lastErr = String(err && err.message || err);
      return fail();
    }
    ws = s;
    try { s.binaryType = 'arraybuffer'; } catch { /* node ws differs; harmless */ }

    s.onopen = () => {
      if (ws !== s) return;
      state = 'live';
      tries = 0;
      epoch = now();
      welcomed = false;
      send(JSON.stringify({
        t: 'join', proto: PROTO_V2, seed: opts.seed ?? 0,
        name, carId, colour,
      }));
    };
    s.onmessage = ev => {
      if (ws !== s) return;
      const d = ev.data;
      if (typeof d === 'string') return control(d);
      const buf = d instanceof ArrayBuffer ? d : (d && d.buffer) || null;
      if (!buf || buf.byteLength < 2) return;
      if (new DataView(buf).getUint8(0) === MSG_SNAPSHOT) room.onSnapshot(buf, now());
    };
    s.onerror = () => { lastErr = 'socket error'; };
    s.onclose = () => { if (ws === s) fail(); };
  }

  function emit(type, p) {
    if (!onEvent) return;
    try { onEvent({ type, id: p.id, name: p.name, car: p.car, colour: p.colour }); } catch { /* a UI bug must not kill the socket */ }
  }

  function learn(p, announce) {
    if (!p || typeof p.id !== 'number') return;
    const known = people.get(p.id);
    const rec = {
      id: p.id,
      name: typeof p.name === 'string' ? p.name : (known ? known.name : ''),
      car: cleanCarId(p.car),
      colour: cleanColour(p.colour),
    };
    if (p.id === selfId) return;
    people.set(p.id, rec);
    room.setName(rec.id, rec.name);
    room.setInfo(rec.id, rec.car, rec.colour);
    if (announce) emit(known ? 'update' : 'join', rec);
  }

  function control(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'welcome') {
      selfId = m.id;
      room.setSelf(m.id);
      serverProto = m.proto === PROTO_V2 ? PROTO_V2 : 1;
      room.setStamped(serverProto === PROTO_V2);
      if (m.sendHz) { sendHz = m.sendHz; room.setSendHz(m.sendHz); }
      people.clear();
      if (Array.isArray(m.players)) for (const p of m.players) learn(p, false);
      welcomed = true;
      pingsSent = 0;
      nextPing = now();
      roster();
      emit('welcome', { id: selfId, name, car: carId, colour });
    } else if (m.t === 'joined') {
      // The server announces a join to every open socket, including ones
      // whose own welcome has not arrived yet — and that welcome then lists
      // the same player. Announced before it, everyone already in the room
      // would pop up as "just joined" the moment you connect.
      learn(m, welcomed);
      roster();
    } else if (m.t === 'left') {
      const p = people.get(m.id);
      people.delete(m.id);
      room.dropName(m.id);
      if (p) emit('leave', p);
      roster();
    } else if (m.t === 'rate' && m.sendHz) {
      sendHz = m.sendHz;
      room.setSendHz(m.sendHz);
    } else if (m.t === 'pong') {
      // `c` went out relative to this connection's epoch; hand the room the
      // absolute time it was sent, or every round trip reads as the age of
      // the connection and is thrown away as implausible.
      if (typeof m.c === 'number' && typeof m.s === 'number') room.onPong(m.c + epoch, m.s, now());
    } else if (m.t === 'error') {
      lastErr = String(m.msg || 'refused');
    }
  }

  function roster() {
    if (onRoster) {
      const names = new Map();
      for (const [id, p] of people) names.set(id, p.name);
      try { onRoster(names); } catch { /* a UI bug must not kill the socket */ }
    }
  }

  function fail() {
    if (state === 'off') return;
    const had = people.size;
    ws = null;
    state = 'retry';
    welcomed = false;
    serverProto = 0;
    room.reset();
    people.clear();
    if (had) roster();
    retryAt = now() + BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    tries++;
  }

  function send(data) {
    if (!ws || state !== 'live') return false;
    try { ws.send(data); return true; } catch { return false; }
  }

  function ping() {
    send(JSON.stringify({ t: 'ping', c: (now() - epoch) | 0 }));
  }

  function pumpPings(t) {
    if (!welcomed || t < nextPing) return;
    ping();
    pingsSent++;
    nextPing = t + (pingsSent < PING_FAST_N ? PING_FAST : PING_SLOW);
  }

  /**
   * Called every frame. `car` is the local vehicle — read-only here; the net
   * layer must never write to it.
   */
  function update(dt, car) {
    const t = now();
    lastUpdate = t;
    if (state === 'retry' && t >= retryAt) connect();
    if (state === 'idle') connect();
    room.update(t, dt);

    if (state !== 'live') return;
    pumpPings(t);
    if (!car) return;
    // Fixed cadence off a real clock, NOT off the physics accumulator — the
    // substep count varies with frame time, so driving the send rate from it
    // makes the send interval jitter with framerate.
    sendAcc += dt;
    const period = 1 / Math.max(4, sendHz);
    if (sendAcc < period) return;
    sendAcc = sendAcc % period;
    send(encodeState(car, (t - epoch) | 0));
  }

  let keepalive = null;
  const si = opts.setInterval || (typeof setInterval === 'function' ? setInterval : null);
  if (si && opts.keepalive !== false) {
    keepalive = si(() => {
      if (state === 'live' && now() - lastUpdate > KEEPALIVE_MS * 0.8) ping();
    }, KEEPALIVE_MS);
  }

  return {
    room,
    get status() { return state; },
    get id() { return selfId; },
    get rtt() { return room.rtt; },
    get error() { return lastErr; },
    get players() { return room.count; },
    /** Everyone else in the room right now: { id, name, car, colour }. */
    get people() { return people; },
    /** How many other drivers the server says are here (before any car shows). */
    get online() { return people.size; },
    /** 2 once a generation-2 server has welcomed us, 1 for an old one, 0 before. */
    get serverProto() { return serverProto; },
    set onRoster(fn) { onRoster = fn; },
    /** fn({ type: 'welcome'|'join'|'update'|'leave', id, name, car, colour }) */
    set onEvent(fn) { onEvent = fn; },
    /** The server's clock, for anything that must happen at the same moment
     *  on every screen (a race start). null until the first sync. */
    serverNow() { return room.serverNow(now()); },
    update,
    rename(n) {
      name = cleanName(n, 'Driver');
      send(JSON.stringify({ t: 'name', name }));
    },
    /** The car and paint everyone else should see. Sent now and on every rejoin. */
    setCar(id, col) {
      const cid = cleanCarId(id), c = cleanColour(col);
      if (cid === carId && c === colour) return;
      carId = cid; colour = c;
      if (serverProto === PROTO_V2) send(JSON.stringify({ t: 'car', car: carId, colour }));
    },
    ping,
    enable() { if (state === 'off') { state = 'idle'; tries = 0; } },
    disable() {
      state = 'off';
      room.reset();
      const had = people.size;
      people.clear();
      if (had) roster();
      if (ws) { try { ws.close(); } catch { /* already gone */ } ws = null; }
    },
    dispose() {
      this.disable();
      if (keepalive && typeof clearInterval === 'function') { try { clearInterval(keepalive); } catch { /* fine */ } }
      keepalive = null;
    },
  };
}
