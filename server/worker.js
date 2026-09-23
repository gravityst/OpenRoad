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
 *
 * TWO ROOMS, ONE CLASS. The URL's `v` picks the protocol generation and the
 * generation picks the Durable Object (protocol.js, roomName()). A page cached
 * from before generation 2 sends no `v`, so it lands in 'open-road-main' —
 * the object it has always used, speaking exactly what it always spoke — and
 * never shares a world with a newer page whose records it would misread. The
 * logic for both lives in roomcore.js; this file is only the Cloudflare glue.
 */

import { protoFromUrl, roomName } from '../src/net/protocol.js';
import { createRoomCore, TICK_MS, MAX_PLAYERS } from './roomcore.js';

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.timer = null;
    this.core = null;
  }

  /** Built on first use, because the generation comes from the first URL —
   *  or, after hibernation, from what was attached to a surviving socket. */
  coreFor(proto) {
    if (!this.core) {
      this.core = createRoomCore({
        proto, now: () => Date.now(), maxPlayers: MAX_PLAYERS,
        persist: (ws, info) => ws.serializeAttachment(info),
      });
    }
    return this.core;
  }

  /** The core for a socket that may have outlived the object's memory. */
  wake(ws) {
    let att = null;
    try { att = ws.deserializeAttachment(); } catch { att = null; }
    const core = this.coreFor(att && att.proto);
    if (!core.has(ws) && att) core.restore(ws, att);
    this.startTimer();
    return core;
  }

  startTimer() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('open road room', { status: 200 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('room full', { status: 503 });
    }
    const core = this.coreFor(protoFromUrl(req.url));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (core.open(server) < 0) {
      try { server.close(1013, 'room full'); } catch { /* gone */ }
    }
    this.startTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    this.wake(ws).message(ws, data);
  }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    if (!this.core) return;
    this.core.close(ws);
    if (this.core.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    const socks = this.ctx.getWebSockets();
    if (!socks.length || !this.core) { clearInterval(this.timer); this.timer = null; return; }
    this.core.tick(socks, (ws) => { try { return ws.deserializeAttachment(); } catch { return null; } });
  }
}

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    }
    const id = env.ROOM.idFromName(roomName(protoFromUrl(req.url)));
    // Pinned to western North America. Without the hint the object is placed
    // near whoever connects FIRST, so one player on another continent would
    // anchor the room there for everyone for the rest of the day.
    return env.ROOM.get(id, { locationHint: 'wnam' }).fetch(req);
  },
};
