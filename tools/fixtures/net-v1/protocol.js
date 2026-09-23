/**
 * The wire format, and nothing else.
 *
 * This module imports NOTHING — not three.js, not the DOM, not WebSocket. That
 * is deliberate and load-bearing: the Cloudflare Worker, a plain Node `ws`
 * server and the browser client all run this exact file, so the encoder can
 * never disagree with the decoder. It also means the harness can test it in
 * bare Node with no DOM shims.
 *
 * A car is 26 bytes. That number is a budget, not a coincidence — at 20 Hz a
 * sixteen-player room is 132 KB/s of egress, which fits inside every free
 * hosting tier worth using. If you are tempted to add a field, delete one.
 */

export const PROTO = 1;
export const REC = 26;          // bytes per car
export const HDR = 6;           // snapshot header: type + count + serverMs
export const UP = 5 + REC;      // client -> server: type + clientMs + own record

export const MSG_SNAPSHOT = 0x01;
export const MSG_STATE = 0x02;

/** flags byte — one bit each, so the whole car's lamp state costs 8 bits. */
export const F_BRAKE = 1 << 0;
export const F_INDL = 1 << 1;
export const F_INDR = 1 << 2;
export const F_HAND = 1 << 3;
export const F_LIGHTS = 1 << 4;
export const F_AIR = 1 << 5;
export const F_TELEPORT = 1 << 6;
export const F_HORN = 1 << 7;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Every quantum here is chosen to sit BELOW the smallest threshold that reads
 * it, so quantisation can never itself trigger a visible correction. Position
 * lands on 1 cm; the interpolator ignores errors under 25 cm. That is 25x of
 * margin, which is why you can round this hard and see nothing.
 */
function putYaw(dv, o, yaw) {
  let a = yaw % TAU;
  if (a < 0) a += TAU;
  dv.setUint16(o, Math.round(a * 65536 / TAU) & 0xffff, true);
}
function getYaw(dv, o) {
  return dv.getUint16(o, true) * TAU / 65536;
}

/** Writes one car record at `off`. Returns the next offset. */
export function writeCar(dv, off, c) {
  dv.setUint8(off, c.id & 0xff);
  dv.setInt32(off + 1, clamp(Math.round(c.x * 100), -2147483647, 2147483647), true);
  dv.setInt32(off + 5, clamp(Math.round(c.z * 100), -2147483647, 2147483647), true);
  dv.setInt16(off + 9, clamp(Math.round((c.y || 0) * 100), -32767, 32767), true);
  putYaw(dv, off + 11, c.yaw || 0);
  dv.setInt8(off + 13, clamp(Math.round((c.pitch || 0) * 162), -127, 127));
  dv.setInt8(off + 14, clamp(Math.round((c.roll || 0) * 162), -127, 127));
  dv.setInt16(off + 15, clamp(Math.round((c.vx || 0) * 100), -32767, 32767), true);
  dv.setInt16(off + 17, clamp(Math.round((c.vz || 0) * 100), -32767, 32767), true);
  dv.setInt16(off + 19, clamp(Math.round((c.yawRate || 0) * 1000), -32767, 32767), true);
  dv.setInt8(off + 21, clamp(Math.round((c.steer || 0) * 127), -127, 127));
  dv.setUint8(off + 22, Math.round((((c.wheelSpin || 0) % TAU) + TAU) % TAU * 256 / TAU) & 0xff);
  dv.setUint8(off + 23, clamp(Math.round((c.integrity == null ? 1 : c.integrity) * 255), 0, 255));
  dv.setUint8(off + 24, c.flags & 0xff);
  dv.setUint8(off + 25, c.respawnSeq & 0xff);
  return off + REC;
}

/** Reads one car record into `out` (reused — never allocate per frame). */
export function readCar(dv, off, out) {
  out.id = dv.getUint8(off);
  out.x = dv.getInt32(off + 1, true) / 100;
  out.z = dv.getInt32(off + 5, true) / 100;
  out.y = dv.getInt16(off + 9, true) / 100;
  out.yaw = getYaw(dv, off + 11);
  out.pitch = dv.getInt8(off + 13) / 162;
  out.roll = dv.getInt8(off + 14) / 162;
  out.vx = dv.getInt16(off + 15, true) / 100;
  out.vz = dv.getInt16(off + 17, true) / 100;
  out.yawRate = dv.getInt16(off + 19, true) / 1000;
  out.steer = dv.getInt8(off + 21) / 127;
  out.wheelSpin = dv.getUint8(off + 22) * TAU / 256;
  out.integrity = dv.getUint8(off + 23) / 255;
  out.flags = dv.getUint8(off + 24);
  out.respawnSeq = dv.getUint8(off + 25);
  return off + REC;
}

/** Client -> server. 31 bytes, and the clock echo is what measures RTT. */
export function encodeState(car, clientMs) {
  const buf = new ArrayBuffer(UP);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_STATE);
  dv.setUint32(1, clientMs >>> 0, true);
  writeCar(dv, 5, car);
  return buf;
}

export function decodeState(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength !== UP || dv.getUint8(0) !== MSG_STATE) return null;
  const out = {};
  readCar(dv, 5, out);
  return { clientMs: dv.getUint32(1, true), car: out };
}

/**
 * Server -> clients. One frame for everyone, built once and sent N times —
 * the fan-out is the whole reason the record is 26 bytes rather than JSON.
 */
export function encodeSnapshot(cars, serverMs) {
  const n = Math.min(cars.length, 255);
  const buf = new ArrayBuffer(HDR + REC * n);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_SNAPSHOT);
  dv.setUint8(1, n);
  dv.setUint32(2, serverMs >>> 0, true);
  let o = HDR;
  for (let i = 0; i < n; i++) o = writeCar(dv, o, cars[i]);
  return buf;
}

/**
 * Decodes into `pool`, an array of reused objects. Returns the count actually
 * present. Allocating a fresh array here would produce garbage 20x a second
 * for the entire session, which is exactly the kind of thing that shows up as
 * a stutter every few seconds and gets blamed on the network.
 */
export function decodeSnapshot(buf, pool) {
  const dv = new DataView(buf);
  if (dv.byteLength < HDR || dv.getUint8(0) !== MSG_SNAPSHOT) return -1;
  const n = dv.getUint8(1);
  if (dv.byteLength < HDR + REC * n) return -1;
  let o = HDR;
  for (let i = 0; i < n; i++) {
    if (!pool[i]) pool[i] = {};
    o = readCar(dv, o, pool[i]);
  }
  return n;
}

export function snapshotTime(buf) {
  return new DataView(buf).getUint32(2, true);
}

/**
 * Name rules. ASCII-only is not laziness — it is UTS #39 Restriction Level 1,
 * and it eliminates homoglyph impersonation, right-to-left override tricks and
 * zalgo stacks in one line, none of which any blocklist would ever catch.
 * Rejected rather than stripped, because silently mangling what someone typed
 * is more confusing than telling them no.
 */
export const NAME_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 _-]{2,16}$/;

export function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && !/\s{2,}/.test(s) && s.trim() === s;
}

/** Never trusted from the wire — the server re-runs this and its answer wins. */
export function cleanName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.normalize('NFKC').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return validName(t) ? t : fallback;
}
