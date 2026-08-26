/**
 * The same room, as a plain Node process.
 *
 * This exists so the hosting decision stays reversible. It shares protocol.js
 * with the Worker and the browser, so the three can never disagree about the
 * wire format — swapping hosts is a redeploy and one URL in the client, not a
 * rewrite. Runs on anything that can hold a socket: a free PaaS dyno, a VM, or
 * localhost while you work on the netcode offline.
 *
 *   npm i ws && node server/node-server.js
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { encodeSnapshot, decodeState, cleanName } from '../src/net/protocol.js';

const PORT = process.env.PORT || 10000;   // PaaS hosts inject this
const TICK_MS = 50;
const MAX_PLAYERS = 16;
const STALE_MS = 8000;

const epoch = Date.now();
const ms = () => (Date.now() - epoch) | 0;
const peers = new Map();
let nextId = 1;

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('open road room\n');
});

// Shares the HTTP server rather than opening its own port: PaaS hosts route all
// public traffic to exactly one port, so a second listener is unreachable.
const wss = new WebSocketServer({ server: http });

wss.on('connection', ws => {
  if (peers.size >= MAX_PLAYERS) { ws.close(1013, 'room full'); return; }
  const id = nextId++ & 0xff;
  const p = { id, name: 'Driver-' + id, rec: null, last: Date.now(), ws };
  peers.set(ws, p);

  ws.on('message', (data, isBinary) => {
    p.last = Date.now();
    if (!isBinary) return control(p, data.toString());
    const b = data;
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const st = decodeState(buf);
    if (!st) return;
    st.car.id = p.id;               // the client does not get to choose its id
    p.rec = st.car;
  });
  ws.on('close', () => drop(p));
  ws.on('error', () => drop(p));
});

function control(p, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m) return;
  if (m.t === 'join') {
    p.name = unique(cleanName(m.name, 'Driver-' + p.id), p.id);
    const players = [...peers.values()].map(q => ({ id: q.id, name: q.name }));
    sendJSON(p.ws, { t: 'welcome', id: p.id, sendHz: rate(), serverMs: ms(), players });
    broadcastJSON({ t: 'joined', id: p.id, name: p.name }, p.ws);
  } else if (m.t === 'name') {
    p.name = unique(cleanName(m.name, p.name), p.id);
    broadcastJSON({ t: 'joined', id: p.id, name: p.name });
  } else if (m.t === 'ping') {
    sendJSON(p.ws, { t: 'pong', c: m.c, s: ms() });
  }
}

function unique(name, id) {
  const taken = [...peers.values()].some(q => q.id !== id && q.name === name);
  return taken ? name.slice(0, 13) + '-' + id : name;
}
function rate() { const n = peers.size; return n <= 6 ? 20 : n <= 10 ? 15 : 10; }
function sendJSON(ws, o) { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } }
function broadcastJSON(o, except) {
  const s = JSON.stringify(o);
  for (const q of peers.values()) if (q.ws !== except) { try { q.ws.send(s); } catch { /* closing */ } }
}
function drop(p) {
  if (!peers.has(p.ws)) return;
  peers.delete(p.ws);
  broadcastJSON({ t: 'left', id: p.id });
}

setInterval(() => {
  if (!peers.size) return;
  const now = Date.now();
  const cars = [];
  for (const p of peers.values()) {
    if (now - p.last > STALE_MS) { try { p.ws.close(1000, 'idle'); } catch { /* gone */ } continue; }
    if (p.rec) cars.push(p.rec);
  }
  if (!cars.length) return;
  const frame = encodeSnapshot(cars, ms());
  for (const p of peers.values()) { try { p.ws.send(frame); } catch { /* gone */ } }
}, TICK_MS);

// PaaS hosts send SIGTERM on deploy and give you a grace window. Closing
// cleanly means clients reconnect on backoff instead of hanging on a dead socket.
process.on('SIGTERM', () => {
  for (const p of peers.values()) { try { p.ws.close(1012, 'restarting'); } catch { /* gone */ } }
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

http.listen(PORT, () => console.log('[open road] room on :' + PORT));
