/**
 * The room, as a Cloudflare Durable Object.
 *
 * Three things here are not stylistic and will cost real money or real players
 * if they are changed:
 *
 *   1. setInterval, NEVER setAlarm. Alarm invocations bill as full requests
 *      with no WebSocket discount, so a 20 Hz alarm is 1.7M requests/day and
 *      exhausts the free tier in under an hour. Timers inside a live object
 *      cost nothing.
 *   2. ctx.acceptWebSocket(), NEVER server.accept(). The latter bills duration
 *      for the entire time the socket is open, whether anyone is driving or not.
 *   3. The interval is cleared when the last player leaves, so an empty room
 *      hibernates and stops billing duration entirely.
 *
 * Outgoing messages are free; incoming are metered. That is why the client
 * sends 31 bytes and the server fans out 6 + 26N.
 */

import { encodeSnapshot, decodeState, cleanName, REC } from '../src/net/protocol.js';

const TICK_MS = 50;             // 20 Hz downstream
const MAX_PLAYERS = 16;
const STALE_MS = 8000;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.timer = null;
    this.epoch = Date.now();
    this.nextId = 1;
    this.peers = new Map();     // ws -> {id, name, rec, last}
    this.scratch = [];
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('open road room', { status: 200 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('room full', { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const id = this.nextId++ & 0xff;
    this.peers.set(server, { id, name: 'Driver-' + id, rec: null, last: Date.now() });
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    const p = this.peers.get(ws);
    if (!p) return;
    p.last = Date.now();

    if (typeof data === 'string') return this.control(ws, p, data);

    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const st = decodeState(buf);
    if (!st) return;
    // The id on the wire is ignored. A client does not get to say who it is —
    // otherwise anyone can drive someone else's car by editing one byte.
    st.car.id = p.id;
    p.rec = st.car;
  }

  control(ws, p, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m) return;

    if (m.t === 'join') {
      p.name = this.unique(cleanName(m.name, 'Driver-' + p.id), p.id);
      const players = [];
      for (const q of this.peers.values()) players.push({ id: q.id, name: q.name });
      ws.send(JSON.stringify({
        t: 'welcome', id: p.id, sendHz: this.rate(), serverMs: this.ms(), players,
      }));
      this.broadcastJSON({ t: 'joined', id: p.id, name: p.name }, ws);
    } else if (m.t === 'name') {
      p.name = this.unique(cleanName(m.name, p.name), p.id);
      this.broadcastJSON({ t: 'joined', id: p.id, name: p.name });
    } else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: m.c, s: this.ms() }));
    }
  }

  /** Two players called "Ace" is confusing at 200 km/h; disambiguate server-side. */
  unique(name, id) {
    let taken = false;
    for (const q of this.peers.values()) if (q.id !== id && q.name === name) taken = true;
    return taken ? (name.slice(0, 13) + '-' + id) : name;
  }

  /** Throttle as the room fills, so a busy room degrades smoothly instead of
   *  hitting the request ceiling and dying outright. */
  rate() {
    const n = this.peers.size;
    return n <= 6 ? 20 : n <= 10 ? 15 : 10;
  }

  ms() { return (Date.now() - this.epoch) | 0; }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const p = this.peers.get(ws);
    if (!p) return;
    this.peers.delete(ws);
    this.broadcastJSON({ t: 'left', id: p.id });
    if (this.peers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  broadcastJSON(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch { /* closing; drop() will clean up */ }
    }
  }

  tick() {
    const socks = this.ctx.getWebSockets();
    if (!socks.length) { clearInterval(this.timer); this.timer = null; return; }
    const nowT = Date.now();
    this.scratch.length = 0;
    for (const ws of socks) {
      const p = this.peers.get(ws);
      if (!p) continue;
      if (nowT - p.last > STALE_MS) { try { ws.close(1000, 'idle'); } catch { /* gone */ } continue; }
      if (p.rec) this.scratch.push(p.rec);
    }
    if (!this.scratch.length) return;
    const frame = encodeSnapshot(this.scratch, this.ms());
    for (const ws of socks) { try { ws.send(frame); } catch { /* gone */ } }
  }
}

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    }
    const id = env.ROOM.idFromName('open-road-main');
    // Pinned to western North America. Without the hint the object is placed
    // near whoever connects FIRST, so one player on another continent would
    // anchor the room there for everyone for the rest of the day.
    return env.ROOM.get(id, { locationHint: 'wnam' }).fetch(req);
  },
};
