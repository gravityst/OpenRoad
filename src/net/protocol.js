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

export const PROTO = 1;          // the binary record's layout — unchanged since launch
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

/**
 * Protocol generations, and why a room only ever holds one of them.
 *
 * Generation 1 is what shipped: a snapshot says where each car IS at the
 * server's tick. Generation 2 keeps every byte of the 26-byte record in the
 * same place but changes what two things mean, so the two must never share
 * a room:
 *
 *   - byte 23 was `integrity`. Nothing can be damaged any more, so in a
 *     generation-2 room it carries the record's AGE: how many milliseconds
 *     before the snapshot's own timestamp the car was actually sampled
 *     (AGE_STALE = that long or longer). A tick carries whatever arrived last,
 *     and the gap between when that was sampled and when the tick ran wanders
 *     by up to a whole send interval — 50 ms, which is 1.5 m at 100 km/h. Read
 *     as "this is where the car is now", that is the stutter.
 *   - one snapshot may hold the same car more than once, oldest first — every
 *     sample that arrived since the last tick, not just the newest. A 20 Hz
 *     sender and a 20 Hz tick drift in and out of phase, and without this one
 *     tick in a few carries nothing new and the next throws a sample away.
 *
 * A generation-1 client reads either of those as nonsense, so the Worker puts
 * each generation in its own Durable Object, named from the `v` in the URL —
 * roomName() below. Old cached pages never send one and land exactly where
 * they always have.
 */
export const PROTO_V2 = 2;
export const PROTO_LATEST = PROTO_V2;
export const AGE_STALE = 255;
/** Samples of one car one snapshot may carry — enough to bridge a stall. */
export const MAX_BURST = 4;

/** The Durable Object a client's generation lives in. Generation 1's name is
 *  the one the live room has always had; never change it. */
export function roomName(proto) {
  return proto === PROTO_V2 ? 'open-road-v2' : 'open-road-main';
}

/** Which generation a connection URL asks for. Anything unrecognised is 1. */
export function protoFromUrl(url) {
  const m = /[?&]v=(\d{1,3})(?:&|$)/.exec(String(url || ''));
  return m && Number(m[1]) === PROTO_V2 ? PROTO_V2 : 1;
}

/**
 * A car is named by its catalogue id and a paint index, never by free text:
 * the id only ever LOOKS UP a car the client already has, and an unknown one
 * falls back to the starter. Nothing a player types reaches another screen
 * this way.
 */
export const CAR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export function cleanCarId(s) {
  return typeof s === 'string' && CAR_ID_RE.test(s) ? s : '';
}
export function cleanColour(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= 0 && v < 32 ? v : 0;
}

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
  // Byte 23: integrity in a generation-1 room, age in a generation-2 one (the
  // server sets `age` on the records it forwards; clients never do).
  dv.setUint8(off + 23, c.age != null ? clamp(c.age | 0, 0, 255)
    : clamp(Math.round((c.integrity == null ? 1 : c.integrity) * 255), 0, 255));
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
  out.age = dv.getUint8(off + 23);
  out.integrity = out.age / 255;
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

/**
 * Never trusted from the wire — the server re-runs this and its answer wins.
 *
 * This is the generation-1 rule, kept exactly as the live Worker runs it (a
 * protocol-1 room must send what it always sent): control characters and
 * non-ASCII are stripped, and anything past 16 characters is cut off rather
 * than refused. A generation-2 room uses safeName() below.
 */
export function cleanName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.normalize('NFKC').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return validName(t) ? t : fallback;
}

// Words no name may contain. ROT13, so the source of a kids' game does not
// read as a list of swearwords; rot13() below turns them back at load.
//
// A name is read as WORDS: split at anything that is not a letter, and where
// a lower-case letter meets a capital ('NakedDriver' is two words). Digits
// read as the letters they imitate (0=o 1=i 3=e 4=a 5=s 7=t 8=b 9=g); any
// other digit is a gap. Then each list matches in its own way:
//
//   SUB    anywhere inside one word ('Shitty', 'sh1t'), or starting at the
//          start of a word and running on across the next ones — the spaced-
//          out spellings: 'F U-C_K', 'Fuc K', 'Bit ch'.
//   START  only where a word starts: these sit inside innocent words.
//   WORD   only as whole words, or a run of whole words: 'Se X'.
//
// A match that starts in the MIDDLE of one word and runs into the next is
// never one: 'Push It', 'Fish It' and 'Wash It' all spell a swearword across
// the gap, and the version before this turned all three into 'Driver-7'
// without a word of explanation.
const SUB_R13 = 'shpx fuvg ovgpu phag chffl juber fyhg avttre avttn snttbg ergneq cravf intvan cbea ' +
  'onfgneq jnaxre gjng qvyqb wvmm zbyrfg nffubyr qhzonff wnpxnff frkl ahqr fhvpvqr';
// Inside real words: 'Snaked'.
const START_R13 = 'anxrq';
// Inside real words: 'Thorny', 'Torpedo', 'Therapist', 'Sexton', 'Nazir'.
const WORD_R13 = 'anmv uvgyre gvgf cvff frk crqb ubeal encvfg';
function rot13(w) {
  return w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
}
const BLOCK = [];
for (const w of SUB_R13.split(' ')) BLOCK.push({ w: rot13(w), how: 'sub' });
for (const w of START_R13.split(' ')) BLOCK.push({ w: rot13(w), how: 'start' });
for (const w of WORD_R13.split(' ')) BLOCK.push({ w: rot13(w), how: 'word' });
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };

/** True when a name reads as one of the blocked words (rules above). */
export function blockedName(s) {
  const words = String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .replace(/[0-9]/g, (d) => LEET[d] || ' ')
    .split(/[^a-z]+/).filter(Boolean);
  const joined = words.join('');
  // Where each word starts in `joined`, and where the last one ends.
  const at = [0];
  for (const w of words) at.push(at[at.length - 1] + w.length);
  for (const { w, how } of BLOCK) {
    for (let i = joined.indexOf(w); i >= 0; i = joined.indexOf(w, i + 1)) {
      const end = i + w.length;
      let k = 0;
      while (at[k + 1] <= i) k++;                   // the word the match starts in
      const atStart = at[k] === i;
      const inOne = end <= at[k + 1];
      if (how === 'sub' ? inOne || atStart : how === 'start' ? atStart : atStart && at.includes(end)) return true;
    }
  }
  return false;
}

/**
 * The generation-2 name rule. The same normalising as cleanName, but a name
 * over 16 characters is REFUSED, as the name rules above always said (a
 * 40-character name used to arrive as its first 16), and so is a name that
 * reads as a blocked word. Refused means `fallback`: the player still drives,
 * as "Driver-7".
 */
export function safeName(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.normalize('NFKC').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > 16 || !validName(t) || blockedName(t)) return fallback;
  return t;
}
