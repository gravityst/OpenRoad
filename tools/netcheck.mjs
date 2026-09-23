// Multiplayer: remote cars move smoothly, and the room stays compatible.
//
// Everything here runs the REAL code — src/net/net.js and room.js on both
// clients, server/worker.js's Room class as the server — inside a
// discrete-event simulator: fake sockets, links with latency, jitter, TCP
// head-of-line stalls, and (for the fuzz case) drops, duplicates and
// reordering; three clocks that disagree with each other and drift. One
// client drives a known trajectory through its real send path; the other
// renders it through its real receive path at a jittery 60 fps, and every
// rendered frame is measured against the truth.
//
// Why a simulator and not two browsers: "it looked smooth when I tried it"
// is exactly how the linear interpolator shipped. A number per frame, under
// conditions a home WiFi actually produces, is the only thing that settles it.
//
// The frozen protocol-1 code in tools/fixtures/net-v1 is used three ways:
// as the OLD CLIENT (every cached page in the wild), as the OLD SERVER (the
// Worker before it is redeployed), and as the "before" column.

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const imp = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

const V1 = {
  net: await imp('tools/fixtures/net-v1/net.js'),
  worker: await imp('tools/fixtures/net-v1/worker.js'),
  proto: await imp('tools/fixtures/net-v1/protocol.js'),
};

let failures = 0;
const verbose = process.argv.includes('-v');
function check(ok, what, detail = '') {
  if (!ok) failures++;
  if (!ok || verbose) console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? '  — ' + detail : ''}`);
  return ok;
}
function note(s) { console.log(s); }

// ---------------------------------------------------------------------------
// Deterministic randomness and a discrete-event loop
// ---------------------------------------------------------------------------

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createSim(seed) {
  const heap = [];
  let seq = 0, now = 0;
  const rng = mulberry(seed);
  const less = (a, b) => (a.t < b.t || (a.t === b.t && a.s < b.s));
  function push(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }
  function pop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  }
  return {
    rng,
    get t() { return now; },
    at(t, fn) { const e = { t: Math.max(t, now), s: seq++, fn, dead: false }; push(e); return e; },
    async run(until) {
      while (heap.length && heap[0].t <= until) {
        const e = pop();
        now = e.t;
        if (e.dead) continue;
        const r = e.fn();
        if (r && typeof r.then === 'function') await r;
      }
      now = until;
    },
  };
}

// ---------------------------------------------------------------------------
// Network conditions
// ---------------------------------------------------------------------------
//
// One-way latency = base + exponential jitter, plus occasional spikes. A
// WebSocket is TCP, so within one direction of one connection nothing is
// reordered or lost — a late packet holds up every packet behind it and they
// then arrive together. That burst is the thing a real home connection does
// to a 20 Hz stream, and it is modelled as `stall` windows. The fuzz profile
// breaks the TCP promise on purpose (drops, duplicates, reordering) to prove
// the receiver survives input no socket should ever give it.

const PROFILES = {
  lan:   { base: 4,  jitter: 1,  spikeP: 0,    spike: 0,   stall: null },
  wifi:  { base: 22, jitter: 7,  spikeP: 0.03, spike: 70,  stall: null },
  rough: { base: 45, jitter: 14, spikeP: 0.03, spike: 90,  stall: { every: 2600, min: 140, max: 320 } },
  fuzz:  { base: 25, jitter: 8,  spikeP: 0.02, spike: 60,  stall: null,
           drop: 0.08, dup: 0.05, reorder: 0.10 },
};

function expo(rng, mean) { return -Math.log(1 - rng() * 0.999999) * mean; }

/** One direction of one connection. `deliver(fn)` schedules fn on arrival. */
function createLink(sim, prof, salt) {
  const rng = mulberry(salt);
  let last = 0;
  const stalls = [];
  if (prof.stall) {
    for (let t = 500 + rng() * prof.stall.every; t < 400000; t += prof.stall.every * (0.6 + rng() * 0.8)) {
      stalls.push([t, t + prof.stall.min + rng() * (prof.stall.max - prof.stall.min)]);
    }
  }
  function latency() {
    let d = prof.base + expo(rng, prof.jitter);
    if (rng() < prof.spikeP) d += prof.spike * (0.5 + rng());
    return d;
  }
  function stallEnd(t) {
    for (const [a, b] of stalls) { if (t >= a && t < b) return b; if (a > t) break; }
    return 0;
  }
  return {
    rng,
    /** Reliable, ordered: a control message or anything on a real socket. */
    ordered(fn) {
      let at = sim.t + latency();
      at = Math.max(at, stallEnd(sim.t) + prof.base);
      at = Math.max(at, last);
      last = at;
      sim.at(at, fn);
    },
    /** Unreliable: drops, duplicates and reorders — the fuzz case only. */
    unordered(fn) {
      if (rng() < prof.drop) return;
      let at = sim.t + latency();
      if (rng() < prof.reorder) at += 60 + rng() * 90;
      sim.at(at, fn);
      if (rng() < prof.dup) sim.at(at + 5 + rng() * 40, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// A fake Cloudflare runtime around the real Worker, and fake browser sockets
// ---------------------------------------------------------------------------

const realDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realResponse = globalThis.Response;

function installRuntime(sim, serverEpoch, timerJitter) {
  const rng = mulberry(991);
  Date.now = () => Math.floor(serverEpoch + sim.t);
  globalThis.setInterval = (fn, ms) => {
    const h = { dead: false, ev: null };
    const next = (from) => {
      let d = ms + (rng() * 2 - 1) * timerJitter;
      if (rng() < 0.01) d += 12;                      // a GC pause in the isolate
      h.ev = sim.at(from + d, () => { if (h.dead) return; next(sim.t); fn(); });
    };
    next(sim.t);
    return h;
  };
  globalThis.clearInterval = (h) => { if (h && h.dead !== undefined) { h.dead = true; if (h.ev) h.ev.dead = true; } };
  globalThis.Response = class {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.webSocket = init.webSocket || null; }
  };
  globalThis.WebSocketPair = function () {
    const server = new ServerEnd();
    return { 0: { placeholder: true, server }, 1: server };
  };
}
function uninstallRuntime() {
  Date.now = realDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.Response = realResponse;
  delete globalThis.WebSocketPair;
}

class ServerEnd {
  constructor() { this.client = null; this.closed = false; this.att = null; }
  send(data) { if (!this.closed && this.client) this.client._fromServer(data); }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.client) this.client._serverClosed(code, reason);
  }
  serializeAttachment(v) { this.att = JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this.att; }
}

/**
 * The Worker's env, with the Durable Object namespace faked: one Room per
 * name, exactly as idFromName() + get() behave. Routing is therefore the
 * Worker's own code, not the harness's idea of it.
 */
function createEnv(RoomClass) {
  const rooms = new Map();
  const sockets = new Map();       // room name -> accepted ServerEnds
  return {
    rooms, sockets,
    ROOM: {
      idFromName(name) { return { name }; },
      get(id) {
        let r = rooms.get(id.name);
        if (!r) {
          const list = [];
          sockets.set(id.name, list);
          const ctx = {
            acceptWebSocket(ws) { list.push(ws); ws.room = r; },
            getWebSockets() { return list.filter((w) => !w.closed); },
          };
          r = new RoomClass(ctx, {});
          r.__name = id.name;
          rooms.set(id.name, r);
        }
        return r;
      },
    },
  };
}

/**
 * What the browser hands net.js. Connects through worker.fetch() after one
 * uplink latency, then carries messages over the two links.
 */
function makeSocketFactory(sim, worker, env, prof, salt, opts = {}) {
  return (url) => {
    const up = createLink(sim, prof, salt * 7 + 1);
    const down = createLink(sim, prof, salt * 7 + 2);
    const sock = {
      binaryType: 'blob', onopen: null, onmessage: null, onclose: null, onerror: null,
      readyState: 0, url, server: null, room: null,
      send(data) {
        if (sock.readyState !== 1) throw new Error('not open');
        const copy = typeof data === 'string' ? data : data.slice(0);
        up.ordered(() => {
          if (!sock.server || sock.server.closed) return;
          sock.room.webSocketMessage(sock.server, copy);
        });
      },
      close() {
        if (sock.readyState === 3) return;
        sock.readyState = 3;
        up.ordered(() => {
          if (!sock.server || sock.server.closed) return;
          sock.server.closed = true;
          sock.room.webSocketClose(sock.server, 1000, '', true);
        });
      },
      _fromServer(data) {
        const deliver = () => { if (sock.readyState === 1 && sock.onmessage) sock.onmessage({ data }); };
        if (typeof data !== 'string' && prof.drop && !opts.reliable) down.unordered(deliver);
        else down.ordered(deliver);
      },
      _serverClosed() {
        down.ordered(() => {
          sock.readyState = 3;
          if (sock.onclose) sock.onclose({});
          sock.room.webSocketClose(sock.server, 1000, '', true);
        });
      },
    };
    up.ordered(async () => {
      const req = { url, headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? 'websocket' : null) } };
      const res = await worker.default.fetch(req, env);
      if (!res || res.status !== 101) {
        down.ordered(() => { sock.readyState = 3; if (sock.onclose) sock.onclose({}); });
        return;
      }
      const server = res.webSocket.server;
      server.client = sock;
      sock.server = server;
      sock.room = server.room;
      down.ordered(() => { sock.readyState = 1; if (sock.onopen) sock.onopen({}); });
    });
    return sock;
  };
}

// ---------------------------------------------------------------------------
// The truth: a car driven hard round a course, integrated at 1 kHz
// ---------------------------------------------------------------------------
//
// Launch, S-bends at 100 km/h, a braking zone into a hairpin (10.8 m/s^2 of
// lateral), a drag back up to 126 km/h and some sweepers. Speed and yaw rate
// change through smoothsteps: a real car's inputs are not instantaneous, and
// a step here would put a genuine infinite jerk into the reference.

const TRUTH_MS = 70000;
const ss = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function buildTruth(kind = 'course') {
  const n = TRUTH_MS + 1;
  const X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n);
  const W = new Float64Array(n), V = new Float64Array(n);
  let x = 0, z = 0, yaw = 0.3;
  const Yw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i % 24000) / 1000;           // the lap repeats every 24 s
    let v, w;
    if (kind === 'crawl') {
      v = 1.2 + 0.8 * Math.sin(i / 1000 * 0.7);
      w = 0.35 * Math.sin(i / 1000 * 0.4);
    } else {
      // Only the first lap launches from rest; every later one rolls in at
      // the 28 m/s the last one ended on, so the course has no step in it.
      v = i < 24000 ? 28 * ss(0, 4, t) : 28;
      v += (12 - 28) * ss(10, 12, t);
      v += (35 - 12) * ss(16, 20, t);
      v += (28 - 35) * ss(22, 24, t);
      w = 0;
      w += 0.45 * Math.sin(2 * Math.PI * (t - 4) / 3) * ss(4, 4.4, t) * (1 - ss(9.6, 10, t));
      w += 0.60 * ss(10, 11, t) * (1 - ss(11.6, 12, t));
      w += 0.90 * ss(12, 12.4, t) * (1 - ss(15.6, 16, t));
      w += 0.12 * Math.sin(2 * Math.PI * (t - 16) / 4) * ss(16, 16.5, t);
    }
    V[i] = v; W[i] = w; X[i] = x; Z[i] = z; Yw[i] = yaw;
    Y[i] = 2 + 1.5 * Math.sin(x * 0.01) * Math.cos(z * 0.013);
    const dt = 0.001;
    yaw += w * dt;
    x += -Math.sin(yaw) * v * dt;
    z += -Math.cos(yaw) * v * dt;
  }
  function at(ms, out = {}) {
    const f = Math.max(0, Math.min(TRUTH_MS - 1, ms));
    const i = Math.floor(f), u = f - i;
    out.x = X[i] + (X[i + 1] - X[i]) * u;
    out.z = Z[i] + (Z[i + 1] - Z[i]) * u;
    out.y = Y[i] + (Y[i + 1] - Y[i]) * u;
    out.yaw = Yw[i] + (Yw[i + 1] - Yw[i]) * u;
    out.v = V[i] + (V[i + 1] - V[i]) * u;
    out.yawRate = W[i] + (W[i + 1] - W[i]) * u;
    out.vx = -Math.sin(out.yaw) * out.v;
    out.vz = -Math.cos(out.yaw) * out.v;
    return out;
  }
  return { at, X, Z, V };
}

// ---------------------------------------------------------------------------
// One session: a driver and a watcher in the same room
// ---------------------------------------------------------------------------

/**
 * stack: { net: client module for the watcher, sender: client module for the
 * driver, worker: server module, name }. Returns the watcher's rendered track
 * of the driver's car, frame by frame, plus the truth it should match.
 */
async function session(stack, profName, opts = {}) {
  const prof = PROFILES[profName];
  const sim = createSim(opts.seed || 1234);
  const serverEpoch = 1.7e12 + 12345;
  installRuntime(sim, serverEpoch, 2);
  const env = createEnv(stack.worker.Room);
  const truth = opts.truth || buildTruth(opts.course || 'course');
  const dur = opts.duration || 30000;

  // Clocks. performance.now() on each machine: its own origin, its own drift.
  const senderNow = () => sim.t * (1 + 50e-6) + 5000.5;
  const watcherNow = () => sim.t * (1 - 30e-6) + 777.25;

  const base = 'wss://room.test/';
  const sender = (stack.sender || stack.net).createNet({
    url: base, name: 'Driver', seed: 1, carId: 'kaida', colour: 2,
    now: senderNow, socketFactory: makeSocketFactory(sim, stack.worker, env, prof, 11, { reliable: true }),
  });
  const watcher = stack.net.createNet({
    url: base, name: 'Watcher', seed: 1, carId: 'kaida2',
    now: watcherNow, socketFactory: makeSocketFactory(sim, stack.worker, env, prof, 23),
    ...(opts.watcherOpts || {}),
  });

  const rec = {
    id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vz: 0, yawRate: 0,
    steer: 0, wheelSpin: 0, integrity: 1, flags: 0, respawnSeq: 0,
  };
  const still = { ...rec, x: 9000, z: 9000 };
  const tq = {};
  let teleportAt = opts.teleportAt ?? -1, teleported = false;
  let nudgeAt = opts.nudgeAt ?? -1;
  let shiftX = 0, seqNo = 0;

  // The driver: 60 fps with jitter and the odd hitch, sending through net.update().
  const srng = mulberry(77);
  let sLast = 0;
  const senderFrame = () => {
    const dt = 16.667 + (srng() * 2 - 1) * 1.5 + (srng() < 0.01 ? 25 : 0);
    sim.at(sim.t + dt, () => {
      const t = sim.t;
      truth.at(t, tq);
      if (teleportAt >= 0 && t >= teleportAt && !teleported) {
        teleported = true; shiftX += 300; seqNo = (seqNo + 1) & 0xff; rec.flags |= 64;
      } else rec.flags &= ~64;
      if (nudgeAt >= 0 && t >= nudgeAt) { shiftX += 2.0; nudgeAt = -1; }
      rec.x = tq.x + shiftX; rec.z = tq.z; rec.y = tq.y; rec.yaw = tq.yaw;
      rec.vx = tq.vx; rec.vz = tq.vz; rec.yawRate = tq.yawRate;
      rec.respawnSeq = seqNo;
      rec.flags = (rec.flags & 64) | (tq.v < 20 && t % 24000 > 10000 && t % 24000 < 12000 ? 1 : 0);
      sender.update((t - sLast) / 1000, rec);
      sLast = t;
      senderFrame();
    });
  };

  // The watcher: renders at a jittery 60 fps and records the driver's car.
  const wrng = mulberry(91);
  let wLast = 0;
  const frames = [];
  const watcherFrame = () => {
    const dt = 16.667 + (wrng() * 2 - 1) * 1.5 + (wrng() < 0.01 ? 22 : 0);
    sim.at(sim.t + dt, () => {
      const t = sim.t;
      watcher.update((t - wLast) / 1000, still);
      wLast = t;
      const sid = sender.id;
      const c = watcher.room.cars.find((k) => k.active && k.id === sid);
      if (c) frames.push({ t, x: c.x, z: c.z, yaw: c.yaw, fade: c.fade, brake: c.brake });
      if (opts.onFrame) opts.onFrame(watcher, sender, sim);
      watcherFrame();
    });
  };
  senderFrame();
  watcherFrame();
  try {
    await sim.run(dur);
  } finally {
    uninstallRuntime();
  }
  return { frames, truth, sender, watcher, env, sim, shift: () => shiftX };
}

// ---------------------------------------------------------------------------
// Measuring a rendered track
// ---------------------------------------------------------------------------

/**
 * For every frame: how far it moved against how far the frame before said it
 * would (a pop), how hard it accelerated (a kink), whether it went backwards,
 * and how far behind the truth it is drawn (and how steady that lag is —
 * a wobbling lag is a car surging and hesitating).
 */
function measure(res, opts = {}) {
  const { frames, truth } = res;
  const skip = opts.skip ?? 3000;
  const q = {};
  let tau = -1;
  const acc = [], lag = [], xerr = [];
  let back = 0, pops = 0, maxDev = 0, maxAcc = 0;
  let prev = null, prevU = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Nearest truth time, searched forward from the last answer.
    let best = Infinity, bt = tau;
    const lo = tau < 0 ? Math.max(0, f.t - 1500) : tau - 150;
    const hi = tau < 0 ? f.t : Math.min(f.t, tau + 400);
    for (let s = lo; s <= hi; s += 1) {
      truth.at(s, q);
      const d = (q.x + (opts.shift || 0) - f.x) ** 2 + (q.z - f.z) ** 2;
      if (d < best) { best = d; bt = s; }
    }
    tau = bt;
    f.tau = bt; f.err = Math.sqrt(best);
    if (f.t < skip) { prev = f; prevU = null; continue; }
    if (prev) {
      const dt = (f.t - prev.t) / 1000;
      const ux = (f.x - prev.x) / dt, uz = (f.z - prev.z) / dt;
      truth.at(f.tau, q);
      const hx = -Math.sin(q.yaw), hz = -Math.cos(q.yaw);
      if (q.v > 1 && (f.x - prev.x) * hx + (f.z - prev.z) * hz < -0.002) back++;
      if (prevU) {
        const ax = (ux - prevU.x) / dt, az = (uz - prevU.z) / dt;
        const a = Math.hypot(ax, az);
        acc.push(a);
        if (a > maxAcc) maxAcc = a;
        // Deviation from where constant velocity would have put it this frame.
        const dev = Math.hypot(f.x - (prev.x + prevU.x * dt), f.z - (prev.z + prevU.z * dt));
        if (dev > maxDev) maxDev = dev;
        if (dev > 0.10) pops++;
      }
      prevU = { x: ux, z: uz };
    }
    lag.push(f.t - f.tau);
    xerr.push(f.err);
    prev = f;
  }
  const sorted = (a) => a.slice().sort((p, r) => p - r);
  const pct = (a, p) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const lm = mean(lag);
  const lagSd = Math.sqrt(mean(lag.map((v) => (v - lm) ** 2)));
  return {
    frames: acc.length, back, pops, maxDev, maxAcc,
    acc99: pct(acc, 0.99), acc999: pct(acc, 0.999),
    lag: lm, lagSd, err99: pct(xerr, 0.99),
  };
}

function row(name, m) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  return `${name.padEnd(18)} lag ${f(m.lag, 0).padStart(4)} ms ±${f(m.lagSd, 0).padStart(3)}   ` +
    `accel p99 ${f(m.acc99, 0).padStart(4)}  p99.9 ${f(m.acc999, 0).padStart(4)}  max ${f(m.maxAcc, 0).padStart(5)} m/s²   ` +
    `pops ${String(m.pops).padStart(3)} (max ${f(m.maxDev, 2)} m)   backwards ${String(m.back).padStart(3)}`;
}

// ---------------------------------------------------------------------------

const V1STACK = { name: 'protocol 1', net: V1.net, worker: V1.worker };
const V2STACK = {
  name: 'protocol 2',
  net: await imp('src/net/net.js'),
  worker: await imp('server/worker.js'),
};

if (process.argv.includes('--compare')) {
  note('                    BEFORE: protocol-1 client + server (live today)   /   AFTER: this branch');
  for (const p of ['lan', 'wifi', 'rough', 'fuzz']) {
    note(row(p + ' before', measure(await session(V1STACK, p))));
    const r = await session(V2STACK, p);
    const m = measure(r);
    note(row(p + ' after', m) + `   delay ${r.watcher.room.interp.toFixed(0)} ms, extrap ${(100 * r.watcher.room.stats.extrap / Math.max(1, r.watcher.room.stats.frames)).toFixed(1)}%`);
  }
  process.exit(0);
}

if (process.argv.includes('--dump')) {
  const prof = process.argv[process.argv.indexOf('--dump') + 1] || 'lan';
  const extra = [];
  const r = await session(process.argv.includes('--old') ? V1STACK : V2STACK, prof, {
    onFrame: (w, s) => {
      const c = w.room.cars.find((k) => k.active && k.id === s.id);
      extra.push(c ? { ex: c._ex || 0, ez: c._ez || 0, evx: c._vx || 0, evz: c._vz || 0, n: c._n || 0, top: c._n ? c._s[c._n - 1].t : 0, d: w.room.interp } : null);
    },
  });
  measure(r);
  const fr = r.frames;
  let worst = 0, wi = 0;
  for (let i = 2; i < fr.length; i++) {
    if (fr[i].t < 3000) continue;
    const dt = fr[i].t - fr[i - 1].t, pdt = fr[i - 1].t - fr[i - 2].t;
    const ux = (fr[i - 1].x - fr[i - 2].x) / pdt, uz = (fr[i - 1].z - fr[i - 2].z) / pdt;
    const dev = Math.hypot(fr[i].x - fr[i - 1].x - ux * dt, fr[i].z - fr[i - 1].z - uz * dt);
    if (dev > worst) { worst = dev; wi = i; }
  }
  const off = extra.length - fr.length;
  for (let i = Math.max(1, wi - 8); i <= Math.min(fr.length - 1, wi + 4); i++) {
    const f = fr[i], p = fr[i - 1], e = extra[i + off];
    console.log(f.t.toFixed(1), 'step', Math.hypot(f.x - p.x, f.z - p.z).toFixed(3), 'lag', (f.t - f.tau).toFixed(0),
      'err', f.err.toFixed(2), e ? `corr ${e.ex.toFixed(3)},${e.ez.toFixed(3)} v ${e.evx.toFixed(2)},${e.evz.toFixed(2)} n ${e.n} top ${e.top} D ${e.d.toFixed(0)}` : '');
  }
  process.exit(0);
}
if (process.argv.includes('--trace')) {
  const P = await imp('src/net/protocol.js');
  const log = [];
  let sends = 0;
  const r = await session(V2STACK, 'lan', {
    duration: 24000,
    onFrame: (w, s, sim) => {
      if (!w.__wrapped) {
        w.__wrapped = true;
        const orig = w.room.onSnapshot;
        w.room.onSnapshot = (buf, now) => {
          const pool = []; const n = P.decodeSnapshot(buf, pool); const st = P.snapshotTime(buf);
          for (let i = 0; i < n; i++) if (pool[i].id === s.id) log.push(`${(st - pool[i].age)}/${pool[i].age}`);
          return orig(buf, now);
        };
      }
    },
  });
  console.log(log.filter((e) => { const t = +e.split('/')[0]; return t > 22300 && t < 23000; }).join(' '));
  process.exit(0);
}
if (process.argv.includes('--trace2')) {
  let prevE = 0, shown = 0;
  await session(V2STACK, 'lan', {
    duration: 24000,
    onFrame: (w, s, sim) => {
      const c = w.room.cars.find((k) => k.active && k.id === s.id);
      if (!c) return;
      const e = Math.hypot(c._ex, c._ez);
      if (e - prevE > 0.3 && shown < 2 && sim.t > 3000) {
        shown++;
        console.log('frame', sim.t.toFixed(1), 'jump', (e - prevE).toFixed(3), 'delay', w.room.interp.toFixed(1), 'offset', w.room.offset.toFixed(1));
        for (let i = c._n - 5; i < c._n; i++) { const q = c._s[i]; console.log('  s', q.t, q.x.toFixed(2), q.z.toFixed(2), 'v', q.vx.toFixed(2), q.vz.toFixed(2), 'flags', q.flags, 'seq', q.respawnSeq); }
      }
      prevE = e;
    },
  });
  process.exit(0);
}
