/**
 * The same room, as a plain Node process.
 *
 * This exists so the hosting decision stays reversible. It runs the very same
 * roomcore.js as the Worker, so the two can never disagree about the wire
 * format or the rules — swapping hosts is a redeploy and one URL in the
 * client, not a rewrite. Runs on anything that can hold a socket: a free PaaS
 * dyno, a VM, or localhost while you work on the netcode offline.
 *
 *   npm i ws && node server/node-server.js
 *
 * One room per protocol generation, picked from the URL's `v` exactly as the
 * Worker picks its Durable Object, so old and new pages never share a world
 * here either.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { protoFromUrl } from '../src/net/protocol.js';
import { createRoomCore, TICK_MS, MAX_PLAYERS } from './roomcore.js';

const PORT = process.env.PORT || 10000;   // PaaS hosts inject this

const rooms = new Map();                  // proto -> { core, socks:Set }
function roomFor(proto) {
  let r = rooms.get(proto);
  if (!r) {
    r = { core: createRoomCore({ proto, now: () => Date.now(), maxPlayers: MAX_PLAYERS }), socks: new Set() };
    rooms.set(proto, r);
  }
  return r;
}

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('open road room\n');
});

// Shares the HTTP server rather than opening its own port: PaaS hosts route all
// public traffic to exactly one port, so a second listener is unreachable.
//
// maxPayload: ws defaults to 100 MiB, and roomcore only throws away text over
// 512 characters AFTER it has been buffered and decoded — so one client could
// make this process hold 100 MiB per message. The largest legitimate message
// is a join at about 120 bytes; 1 KiB is eight times that, and anything bigger
// is refused by ws before it is ever assembled.
const wss = new WebSocketServer({ server: http, maxPayload: 1024 });

wss.on('connection', (ws, req) => {
  const room = roomFor(protoFromUrl(req.url));
  if (room.socks.size >= MAX_PLAYERS || room.core.open(ws) < 0) { ws.close(1013, 'room full'); return; }
  room.socks.add(ws);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) { room.core.message(ws, data.toString()); return; }
    const b = data;
    room.core.message(ws, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  });
  const drop = () => { if (room.socks.delete(ws)) room.core.close(ws); };
  ws.on('close', drop);
  ws.on('error', drop);
});

setInterval(() => {
  for (const r of rooms.values()) if (r.socks.size) r.core.tick([...r.socks]);
}, TICK_MS);

// PaaS hosts send SIGTERM on deploy and give you a grace window. Closing
// cleanly means clients reconnect on backoff instead of hanging on a dead socket.
process.on('SIGTERM', () => {
  for (const r of rooms.values()) for (const ws of r.socks) { try { ws.close(1012, 'restarting'); } catch { /* gone */ } }
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

http.listen(PORT, () => console.log('[open road] room on :' + PORT));
