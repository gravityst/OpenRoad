/**
 * The transport. Everything that knows the word "WebSocket" lives here, so the
 * room logic above it can be tested without a socket and the whole feature can
 * be moved to a different host by changing one URL.
 *
 * createNet() RETURNS SYNCHRONOUSLY with a fully usable object and connects in
 * the background. It must never await the socket and must never throw: a dead
 * server has to mean "you are driving alone", not a game that fails to boot.
 */

import { encodeState, decodeSnapshot, MSG_SNAPSHOT, cleanName } from './protocol.js';
import { createRoom } from './room.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

export function createNet(opts = {}) {
  const room = createRoom({ maxPlayers: opts.maxPlayers ?? 16 });
  const makeSocket = opts.socketFactory || (u => new WebSocket(u));
  const now = opts.now || (() => performance.now());
  const url = opts.url || '';

  let ws = null;
  let state = 'idle';            // idle | connecting | live | retry | off
  let tries = 0;
  let retryAt = 0;
  let sendAcc = 0;
  let sendHz = opts.sendHz ?? 20;
  let selfId = -1;
  let epoch = 0;
  let lastErr = '';
  const names = new Map();
  let onRoster = opts.onRoster || null;

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
      state = 'live';
      tries = 0;
      epoch = now();
      send(JSON.stringify({
        t: 'join', proto: 1, seed: opts.seed ?? 0,
        name: cleanName(opts.name, 'Driver'), carId: opts.carId || '',
      }));
    };
    s.onmessage = ev => {
      const d = ev.data;
      if (typeof d === 'string') return control(d);
      const buf = d instanceof ArrayBuffer ? d : (d && d.buffer) || null;
      if (!buf || buf.byteLength < 2) return;
      if (new DataView(buf).getUint8(0) === MSG_SNAPSHOT) room.onSnapshot(buf, now());
    };
    s.onerror = () => { lastErr = 'socket error'; };
    s.onclose = () => fail();
  }

  function control(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'welcome') {
      selfId = m.id;
      room.setSelf(m.id);
      if (m.sendHz) { sendHz = m.sendHz; room.setSendHz(m.sendHz); }
      names.clear();
      if (Array.isArray(m.players)) for (const p of m.players) names.set(p.id, p.name);
      roster();
    } else if (m.t === 'joined') {
      names.set(m.id, m.name);
      roster();
    } else if (m.t === 'left') {
      names.delete(m.id);
      if (room.dropName) room.dropName(m.id);
      roster();
    } else if (m.t === 'rate' && m.sendHz) {
      sendHz = m.sendHz;
      room.setSendHz(m.sendHz);
    } else if (m.t === 'pong') {
      room.onPong(m.c, m.s, now());
    } else if (m.t === 'error') {
      lastErr = String(m.msg || 'refused');
    }
  }

  function roster() {
    for (const [id, n] of names) room.setName(id, n);
    if (onRoster) { try { onRoster(names); } catch { /* a UI bug must not kill the socket */ } }
  }

  function fail() {
    if (state === 'off') return;
    ws = null;
    state = 'retry';
    room.reset();
    retryAt = now() + BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    tries++;
  }

  function send(data) {
    if (!ws || state !== 'live') return false;
    try { ws.send(data); return true; } catch { return false; }
  }

  /**
   * Called every frame. `car` is the local vehicle — read-only here; the net
   * layer must never write to it.
   */
  function update(dt, car) {
    const t = now();
    if (state === 'retry' && t >= retryAt) connect();
    if (state === 'idle') connect();
    room.update(t, dt);

    if (state !== 'live' || !car) return;
    // Fixed cadence off a real clock, NOT off the physics accumulator — the
    // substep count varies with frame time, so driving the send rate from it
    // makes the send interval jitter with framerate.
    sendAcc += dt;
    const period = 1 / Math.max(4, sendHz);
    if (sendAcc < period) return;
    sendAcc = sendAcc % period;
    send(encodeState(car, (t - epoch) | 0));
  }

  return {
    room,
    get status() { return state; },
    get id() { return selfId; },
    get rtt() { return room.rtt; },
    get error() { return lastErr; },
    get players() { return room.count; },
    set onRoster(fn) { onRoster = fn; },
    update,
    rename(name) { send(JSON.stringify({ t: 'name', name: cleanName(name, 'Driver') })); },
    ping() { send(JSON.stringify({ t: 'ping', c: (now() - epoch) | 0 })); },
    enable() { if (state === 'off') { state = 'idle'; tries = 0; } },
    disable() {
      state = 'off';
      room.reset();
      if (ws) { try { ws.close(); } catch { /* already gone */ } ws = null; }
    },
    dispose() { this.disable(); },
  };
}
