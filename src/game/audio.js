// Every sound in OPEN ROAD, made from nothing.
//
// There is not one audio file in this project, so all of it is oscillators, a
// single buffer of pink noise, and a rack of biquads. Two decisions shape the
// whole file and explain most of what looks odd in it:
//
//   * THE VOICE POOL IS FIXED. Every continuously audible source — six engine
//     oscillators, three noise taps, three traffic voices, the horn's two tones
//     — is created once in start() and then never stopped, only faded. Creating
//     an AudioNode per frame is the reliable way to earn both a click (a fresh
//     oscillator starts at zero phase) and a GC pause. The only nodes built
//     while driving belong to collisions, and a collision is not a per-frame
//     event.
//
//   * SILENCE IS A VALID OUTCOME. If the browser has no AudioContext, or
//     refuses to start one, `ok` stays false and every entry point returns
//     immediately. A game that throws because the tab is muted is worse than a
//     game that is quiet.
//
// THE GRAPH
//
//   6 osc ──▶ oscSum ─▶ lowpass ─▶ peaking ─▶ drive ─▶ shaper ─▶ tone ──┐
//    (partials of the firing frequency; the sixth is the exhaust pulse   │
//     LFO and goes to exhaust.gain, not to oscSum)                       │
//   noiseC ─┬─▶ intakeBP ──▶ intake ─────────────────────────────────────┤
//           └─▶ exhaustBP ─▶ exhaust ◀── pulse LFO ──────────────────────┤
//                                                        engineHP ◀──────┘
//   noiseA ─┬─▶ hissBP ────▶ hiss ──┐
//           ├─▶ rumbleLP ──▶ rumble ├──▶ roadBus ──┐
//           ├─▶ squealA/B ─▶ squeal ┘              │
//           └─▶ tickBP ────▶ tick ──┐              │
//   2 osc ──▶ hornBP ──────▶ horn ──┼──▶ fxBus ────┤
//   collisions (transient) ─────────┘              ├──▶ master ─▶ limiter ─▶ out
//   noiseB ─┬─▶ windLP ────▶ wind ──┐              │
//           ├─▶ rainHP ────▶ rain   ├──▶ weatherBus┤
//           └─▶ rainBodyBP ─▶ body ─┘              │
//   3 × (osc ─▶ lp ─▶ gain ─▶ panner) ──▶ trafficBus ─────────────────────┘
//
// THE DAMAGE VOICES
//
// Everything a broken car adds is a branch of the same shape: one filter on the
// noise it already has, one gain that spends nearly all its life at exactly
// zero. An undamaged car therefore costs two extra source nodes and nothing
// else — no branch is created or destroyed while driving, so nothing here can
// click, and a car with no damage model at all sounds identical to the car this
// file made before damage existed.
//
//   noiseD ─┬─▶ flapBP ─────────────┐                     ◀── flapOsc (AM at
//           │                       ├─▶ flap ─▶ flapPan ──┼── wheel rotation)
//           ├─▶ flapRim ─▶ rim ─────┘              ▼      │
//           │                                   roadBus ──┘
//           ├─▶ grindBP ──┬────────▶ grind ──┐
//           ├─▶ grindLP ──┘                  │
//           ├─▶ dragBP ───┬────────▶ drag ───┼──▶ fxBus
//           ├─▶ dragScreech ┘                │
//           └─▶ crackBP ───────────▶ crackle ┘
//   noiseB ────▶ fireLP ────────────▶ fire ──┘
//   noiseC ─┬─▶ raspBP ─────────────▶ rasp ────▶ engineHP   (holed exhaust)
//           └─▶ boilBP ─────────────▶ boil ────▶ engineBus  (cooking coolant)
//   glass, tyre bursts, clatter, clunks (transient) ─▶ fxBus
//
// COORDINATE CONVENTION (it matters here too — stereo panning depends on it):
//   forward = -Z, right = +X, up = +Y, yaw grows counter-clockwise from above.
//   right = (cos yaw, -sin yaw). Traffic is panned by its offset dotted with
//   that vector, so a car genuinely to the player's right comes out of the
//   right speaker.

import { clamp } from '../world/noise.js';

// ---------------------------------------------------------------------------
// Engine profiles
// ---------------------------------------------------------------------------
//
// `base` converts crank speed to firing frequency: rpm/60 * cylinders/2. Every
// partial is a multiple of that, so the same five oscillators serve a four, a
// six and a V8 — what differs is which orders are loud, how rough they are, and
// how far the lowpass opens.
//
// What actually distinguishes them, physically:
//   i4  a four is not balanced end to end, so the HALF order (once per crank
//       revolution) is audible as the familiar buzz, and the tone is dominated
//       by the firing order itself with a boomy cabin resonance above it.
//   i6  a straight six is perfectly balanced in both couples, so the half order
//       nearly vanishes. What is left is a clean stack of harmonics and a
//       lowpass that opens a long way — that stack, unmuffled, is the howl.
//   v8  a cross-plane V8 fires unevenly WITHIN each bank, which throws energy
//       into the quarter and one-and-a-half orders. That, plus a filter that
//       stays shut, is the difference between a rumble and a howl.
//   ev  no firing order at all. The audible content is stator slot harmonics of
//       the ROTATION rate (base 1) at high multiples, plus inverter switching:
//       a whine that rises without ever stepping.
//
// Arrays are module constants and are read, never rebuilt, so a profile change
// allocates nothing.
const PROFILES = {
  i4: {
    name: 'i4', base: 2,
    mul:    [0.50, 1.00, 1.50, 2.00, 3.00],
    gain:   [0.32, 1.00, 0.22, 0.40, 0.16],
    type:   ['triangle', 'sawtooth', 'sawtooth', 'square', 'sawtooth'],
    detune: [-7, 5, -12, 9, -6],
    peakMul: 2.6, peakQ: 3.2, peakDb: 9,
    cutHz: 380, cutRpm: 1500, cutDrive: 2400,
    drive: 0.40, idle: 0.30, level: 0.90,
    intake: 0.55, intakeHz: 320, intakeRpmHz: 2200,
    exhaust: 0.60, exhaustHz: 120,
  },
  i6: {
    name: 'i6', base: 3,
    mul:    [0.50, 1.00, 1.50, 2.00, 3.00],
    gain:   [0.06, 1.00, 0.07, 0.52, 0.34],
    type:   ['sine', 'sawtooth', 'sine', 'sawtooth', 'sawtooth'],
    detune: [0, 3, 0, -4, 6],
    peakMul: 4.0, peakQ: 5.0, peakDb: 8,
    cutHz: 520, cutRpm: 3800, cutDrive: 3200,
    drive: 0.24, idle: 0.26, level: 0.82,
    intake: 0.66, intakeHz: 380, intakeRpmHz: 2900,
    exhaust: 0.42, exhaustHz: 105,
  },
  v8: {
    name: 'v8', base: 4,
    mul:    [0.25, 0.50, 1.00, 1.50, 2.00],
    gain:   [0.55, 0.85, 0.72, 0.44, 0.28],
    type:   ['triangle', 'square', 'sawtooth', 'square', 'sawtooth'],
    detune: [0, -11, 7, -15, 10],
    peakMul: 1.6, peakQ: 2.2, peakDb: 7,
    cutHz: 300, cutRpm: 1400, cutDrive: 1900,
    drive: 0.58, idle: 0.34, level: 1.00,
    intake: 0.42, intakeHz: 260, intakeRpmHz: 1700,
    exhaust: 1.00, exhaustHz: 88,
  },
  electric: {
    name: 'electric', base: 1,
    mul:    [2.0, 6.0, 12.0, 24.0, 36.0],
    gain:   [0.40, 0.18, 0.52, 0.44, 0.14],
    type:   ['triangle', 'sawtooth', 'triangle', 'sawtooth', 'triangle'],
    detune: [0, 4, -3, 5, -6],
    peakMul: 24, peakQ: 9, peakDb: 10,
    cutHz: 1400, cutRpm: 7000, cutDrive: 2500,
    drive: 0.06, idle: 0.03, level: 0.70,
    // No exhaust at all; the "intake" branch becomes cooling and road rush.
    intake: 0.20, intakeHz: 900, intakeRpmHz: 3600,
    exhaust: 0.0, exhaustHz: 90,
  },
};

/** Accepts a profile name, or any object with `cylinders` (i.e. a car spec). */
function resolveProfile(p) {
  if (typeof p === 'string') return PROFILES[p] || PROFILES.i4;
  if (p && typeof p === 'object') {
    if (typeof p.profile === 'string' && PROFILES[p.profile]) return PROFILES[p.profile];
    const c = p.cylinders;
    if (c === 0) return PROFILES.electric;
    if (typeof c === 'number') return c <= 4 ? PROFILES.i4 : c <= 6 ? PROFILES.i6 : PROFILES.v8;
  }
  return PROFILES.i4;
}

// ---------------------------------------------------------------------------
// Tyre character per surface
// ---------------------------------------------------------------------------
//
// Asphalt is nearly all hiss; loose surfaces are nearly all rumble, and they
// spray rather than squeal, which is what `squeal` scales. These four numbers
// are morphed toward, never snapped to — a car straddling a road edge changes
// surface several times a second and a hard switch sounds like a fault.
const TYRE = {
  asphalt:  { hiss: 1.00, rumble: 0.10, hissHz: 1500, rumbleHz: 260, squeal: 1.00 },
  concrete: { hiss: 0.95, rumble: 0.18, hissHz: 1750, rumbleHz: 280, squeal: 0.92 },
  sidewalk: { hiss: 0.85, rumble: 0.32, hissHz: 1500, rumbleHz: 300, squeal: 0.70 },
  dirt:     { hiss: 0.35, rumble: 1.00, hissHz: 850,  rumbleHz: 190, squeal: 0.12 },
  gravel:   { hiss: 0.55, rumble: 1.10, hissHz: 1150, rumbleHz: 230, squeal: 0.16 },
  grass:    { hiss: 0.30, rumble: 0.75, hissHz: 700,  rumbleHz: 170, squeal: 0.08 },
  sand:     { hiss: 0.42, rumble: 0.85, hissHz: 900,  rumbleHz: 150, squeal: 0.06 },
  rock:     { hiss: 0.45, rumble: 1.25, hissHz: 1000, rumbleHz: 210, squeal: 0.30 },
};

// ---------------------------------------------------------------------------
// Impact materials
// ---------------------------------------------------------------------------
//
// WHAT was hit decides the spectrum; HOW HARD only moves within it. That order
// matters: scaling an impact by gain alone gives you one sound played louder,
// which is the single most recognisable sign of a synthesised crash. So every
// number below is a shape, and severity bends the shape — the burst dulls, the
// ring drops and lengthens, and past a threshold a low crumple appears that a
// light knock simply does not have.
//
//   burstHz  lowpass corner of the initial burst, at zero severity
//   ring     how much of the hit rings on as panel metal, 0..1
//   ringHz   where that ring sits
//   decay    multiplier on how long everything lasts
//   sub      how much low crumple a square-on hit produces
//   grindHz  centre of the scrape band, for a glancing blow
//   grindQ   how narrow that scrape is — narrow reads as metal, wide as stone
//   grit     how violently the scrape amplitude jitters
const MATERIALS = {
  // Masonry is the default because nearly everything solid in this city is a
  // building: no ring worth the name, and the roughest scrape of anything.
  brick:    { burstHz: 1500, ring: 0.20, ringHz: 400,  decay: 0.50, sub: 0.70, grindHz: 820,  grindQ: 1.0, grit: 1.00 },
  concrete: { burstHz: 1750, ring: 0.26, ringHz: 470,  decay: 0.60, sub: 0.85, grindHz: 1150, grindQ: 1.3, grit: 0.85 },
  stone:    { burstHz: 1300, ring: 0.16, ringHz: 360,  decay: 0.45, sub: 0.90, grindHz: 700,  grindQ: 0.9, grit: 1.10 },
  // A lamp post or a barrier: almost all ring, and it rings for a long time.
  metal:    { burstHz: 3400, ring: 1.00, ringHz: 640,  decay: 1.30, sub: 0.55, grindHz: 2600, grindQ: 3.2, grit: 0.45 },
  // Another car: two crumple structures instead of one, so the deepest sub of
  // anything and a ring that dies quickly because both sides are absorbing.
  car:      { burstHz: 2600, ring: 0.70, ringHz: 520,  decay: 0.95, sub: 1.00, grindHz: 1900, grindQ: 2.4, grit: 0.55 },
  wood:     { burstHz: 1900, ring: 0.30, ringHz: 300,  decay: 0.35, sub: 0.60, grindHz: 1300, grindQ: 1.6, grit: 0.70 },
  glass:    { burstHz: 6000, ring: 0.55, ringHz: 2600, decay: 0.40, sub: 0.15, grindHz: 4200, grindQ: 4.0, grit: 0.30 },
  kerb:     { burstHz: 2100, ring: 0.18, ringHz: 520,  decay: 0.30, sub: 0.75, grindHz: 1400, grindQ: 1.2, grit: 0.95 },
  hedge:    { burstHz: 5200, ring: 0.02, ringHz: 900,  decay: 0.20, sub: 0.10, grindHz: 3600, grindQ: 0.7, grit: 0.55 },
  earth:    { burstHz: 900,  ring: 0.04, ringHz: 240,  decay: 0.25, sub: 0.65, grindHz: 620,  grindQ: 0.8, grit: 0.60 },
};
const DEFAULT_MATERIAL = MATERIALS.concrete;

// Which detached parts are still making a noise, and how much.
//
// A part that has left the car entirely is silent — it is behind you. What is
// audible is the part still hanging from one mounting and being dragged, and
// the two lists differ: an exhaust drags all the way home, a mirror clears the
// bodywork and is gone. Mirrors and the spoiler are therefore absent from the
// first list rather than present with a zero, because a zero would suggest they
// might one day be tuned up, and they should not be.
const DRAG_PARTS  = ['exhaust', 'rearBumper', 'frontBumper', 'doorL', 'doorR', 'bonnet', 'boot'];
const DRAG_WEIGHT = [1.00, 0.80, 0.72, 0.60, 0.60, 0.55, 0.45];

// Parts heavy enough to ring when they hit the road. A mirror ticks; a bumper
// bangs and then tumbles.
const HEAVY_PARTS = ['frontBumper', 'rearBumper', 'bonnet', 'boot', 'doorL', 'doorR'];

const PARTIALS = 5;
const TRAFFIC = 3;             // simultaneous AI engines. Three is plenty: past
                               // that they smear into one texture anyway.
const TRAFFIC_RANGE = 72;      // m, beyond which a car is not worth a voice
const TRAFFIC_SCAN = 24;       // bound the per-frame scan, however long the list
const MAX_COLLISIONS = 4;      // concurrent impact voices
const MAX_TRANSIENT = 6;       // concurrent damage one-shots (glass, bangs, …)
const SOUND_SPEED = 340;
const DEFAULT_WHEEL_R = 0.34;  // m, matches DEFAULT_SPEC; only the slap rate
                               // depends on it, and the catalogue spans
                               // 0.30–0.41, which at 25 m/s is under 3 Hz of
                               // difference. Pass state.wheelRadius for exact.

// Ratios chosen not to share a common divisor, so an impact rings like sheet
// metal rather than like a bell.
const COLLISION_RATIOS = [1, 1.83, 2.71, 4.09];
// Higher, tighter and even less harmonic: a pane coming out of its frame.
const GLASS_RATIOS = [1, 1.47, 2.09];

/** Exponential approach that is stable for any dt. */
function approach(cur, target, dt, tc) {
  return cur + (target - cur) * (1 - Math.exp(-dt / tc));
}

/** A finite number or the fallback. `clamp` compares, so NaN survives it
 *  untouched — and one NaN written to an AudioParam is a thrown TypeError in
 *  Chrome, which would take the whole frame loop down with it. Worse, the
 *  smoothed state here is recursive: a single NaN in poisons every later frame.
 *  Every value that comes from outside this module is filtered through here. */
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

/** Which side of the car a named part is on, as a pan position.
 *
 *  Every side-specific thing in the damage model is named ...L or ...R —
 *  mirrorL, doorR, sideL, headR — so one rule covers glass, lights, mirrors and
 *  doors and no lookup table can fall out of step with damage.js. Names that
 *  end in a lower-case r ('rear', 'frontBumper') are centre, which is correct. */
function panOf(name) {
  if (typeof name !== 'string' || !name.length) return 0;
  const c = name.charCodeAt(name.length - 1);
  return c === 76 ? -0.62 : c === 82 ? 0.62 : 0;      // 'L' : 'R'
}

export function createAudio(opts = {}) {
  let ctx = null;
  let ok = false;               // false => permanently silent, never throws
  let running = false;
  let muted = !!opts.muted;
  let volume = clamp(num(opts.volume, 0.8), 0, 1);
  let prof = resolveProfile(opts.profile ?? 'i4');

  // --- nodes (all null until start) ---
  let master, limiter;
  let engineBus, roadBus, weatherBus, fxBus, trafficBus;
  let oscSum, engineLP, enginePeak, engineDrive, engineShaper, engineTone, engineHP;
  let intakeBP, intakeGain, exhaustBP, exhaustGain, pulseOsc, pulseGain;
  let hissBP, hissGain, rumbleLP, rumbleGain, squealA, squealB, squealGain;
  let windLP, windGain, rainHP, rainGain, rainBodyBP, rainBodyGain;
  let tickBP, tickGain, hornBP, hornGain;
  let flapPan, flapGain, flapBP, flapRim, rimGain, flapDepth, flapOsc;
  let grindGain, grindBP, grindLP, dragGain, dragBP, dragScreech;
  let crackGain, crackBP, fireGain, fireLP, boilGain, boilBP, raspGain, raspBP;
  let noiseBuf = null;
  const osc = new Array(PARTIALS).fill(null);
  const partialGain = new Array(PARTIALS).fill(null);
  const noiseSrc = [null, null, null, null];
  const hornOsc = [null, null];
  const trafficOsc = new Array(TRAFFIC).fill(null);
  const trafficLP = new Array(TRAFFIC).fill(null);
  const trafficGain = new Array(TRAFFIC).fill(null);
  const trafficPan = new Array(TRAFFIC).fill(null);

  // --- smoothed state, all scalars so update() allocates nothing ---
  let sThrottle = 0, sLoad = 0, sRpmN = 0, sSpeed = 0, sRain = 0, sSlip = 0;
  let sHiss = 1, sRumble = 0.1, sHissHz = 1500, sRumbleHz = 260, sSqueal = 1;
  let shiftDuck = 1, crackle = 0, skidImpulse = 0, wobble = 0;
  let limitPhase = 0, lastGear = 1, tickHigh = false;
  let now = 0;

  // --- damage, smoothed the same way and for the same reason ---------------
  // Damage arrives as a step: one frame the radiator is fine, the next it is
  // holed. Stepping an audio parameter is a click, and stepping ten of them at
  // once is a click you cannot mistake for a crash. Every one of these is
  // approached, so the car degrades audibly over a few hundred milliseconds
  // while the impact itself covers the transition.
  let dEngine = 1, dExhaust = 1, dPower = 1, dDead = 1;
  let dTemp = 0.35, dFire = 0, dWobble = 0;
  let dFlap = 0, dFlapPan = 0, dRim = 0, dDrag = 0;
  let misfire = 0, fireCrackle = 0, boilBoost = 0, dragJit = 0, judderPhase = 0;
  // The scrape voice, and what the last thing scraped was made of.
  let dGrind = 0, dGrindHz = 900, dGrindQ = 1.2, dGrit = 0.8;
  let grindHzT = 900, grindQT = 1.2, gritT = 0.8;
  let lastImpactAt = -1e9, impactRun = 0;

  // Traffic slot bookkeeping. `slotKey` is whatever identity the caller gave a
  // car; when it changes the doppler estimate is thrown away rather than
  // producing a pitch jump from a distance that belongs to a different car.
  // Impact voices are rationed by when each one finishes rather than by a
  // counter that onended decrements: a context suspended mid-ring never fires
  // onended at all, and a counter that can only go up would silence every
  // collision for the rest of the session.
  const collisionEnds = new Float64Array(MAX_COLLISIONS);
  // Damage one-shots get their own ration rather than sharing the collision
  // one: a heavy crash uses every collision slot at once, and that is the
  // precise moment the glass and the tyre have to be heard.
  const transientEnds = new Float64Array(MAX_TRANSIENT);

  const slotKey = [null, null, null];
  const slotDist = [0, 0, 0];
  const slotPick = [-1, -1, -1];

  function ramp(param, value, tc) { param.setTargetAtTime(value, now, tc); }

  function hz(v) {
    // Biquads reject frequencies at or past nyquist, and an oscillator at 0 Hz
    // is just a DC offset feeding the limiter.
    return clamp(v, 8, ctx.sampleRate * 0.45);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /** Pink noise. Kellet's economy filter — pink is the right starting point for
   *  tyres, wind and rain; white through the same filters sounds like static. */
  function makeNoise(seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  /** Soft clipper. Static curve — the amount of grit is set by how hard the
   *  signal is pushed into it, which IS modulatable, unlike the curve itself. */
  function makeShaperCurve() {
    const n = 1024, c = new Float32Array(n), k = Math.tanh(2.2);
    for (let i = 0; i < n; i++) c[i] = Math.tanh((i / (n - 1) * 2 - 1) * 2.2) / k;
    return c;
  }

  function gain(v, dest) { const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }
  function biquad(type, freq, q, dest) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz(freq); f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }
  function noiseTap(buf, offset) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, offset);   // different offsets so the three taps decorrelate
    return s;
  }

  function build() {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    limiter.connect(ctx.destination);

    master = gain(muted ? 0 : volume, limiter);

    // Bus trims, balanced by ear at volume 0.8.
    engineBus = gain(0.85, master);
    roadBus = gain(0.55, master);
    weatherBus = gain(0.50, master);
    fxBus = gain(0.90, master);
    trafficBus = gain(0.42, master);

    noiseBuf = makeNoise(3);
    noiseSrc[0] = noiseTap(noiseBuf, 0);        // tyres, squeal, indicator tick
    noiseSrc[1] = noiseTap(noiseBuf, 1.03);     // wind, rain
    noiseSrc[2] = noiseTap(noiseBuf, 2.11);     // intake, exhaust

    // --- engine -----------------------------------------------------------
    // A highpass on the way out: at idle a four-cylinder's half order sits near
    // 14 Hz, which no speaker reproduces but every limiter reacts to.
    engineHP = biquad('highpass', 32, 0.7, engineBus);
    engineTone = gain(0, engineHP);
    engineShaper = ctx.createWaveShaper();
    engineShaper.curve = makeShaperCurve();
    engineShaper.oversample = '2x';
    engineShaper.connect(engineTone);
    engineDrive = gain(1, engineShaper);
    enginePeak = biquad('peaking', 200, prof.peakQ, engineDrive);
    enginePeak.gain.value = prof.peakDb;
    engineLP = biquad('lowpass', 900, 1.1, enginePeak);
    oscSum = gain(0.5, engineLP);

    for (let i = 0; i < PARTIALS; i++) {
      partialGain[i] = gain(prof.gain[i], oscSum);
      const o = ctx.createOscillator();
      o.type = prof.type[i];
      o.frequency.value = 60;
      o.detune.value = prof.detune[i];
      o.connect(partialGain[i]);
      o.start();
      osc[i] = o;
    }

    intakeGain = gain(0, engineHP);
    intakeBP = biquad('bandpass', 600, 0.8, intakeGain);
    noiseSrc[2].connect(intakeBP);

    exhaustGain = gain(0, engineHP);
    exhaustBP = biquad('bandpass', prof.exhaustHz, 2.4, exhaustGain);
    noiseSrc[2].connect(exhaustBP);

    // The exhaust pulse. Amplitude-modulating the exhaust noise at the firing
    // frequency is what turns a hiss into an engine at idle, where the tonal
    // partials are all below hearing. It fuses into the tone as revs rise, so
    // the depth falls away with rpm.
    pulseGain = gain(0, exhaustGain.gain);
    pulseOsc = ctx.createOscillator();
    pulseOsc.type = 'sawtooth';
    pulseOsc.frequency.value = 30;
    pulseOsc.connect(pulseGain);
    pulseOsc.start();

    // --- road -------------------------------------------------------------
    hissGain = gain(0, roadBus);
    hissBP = biquad('bandpass', 1500, 0.7, hissGain);
    noiseSrc[0].connect(hissBP);

    rumbleGain = gain(0, roadBus);
    rumbleLP = biquad('lowpass', 260, 1.4, rumbleGain);
    noiseSrc[0].connect(rumbleLP);

    // Squeal is two narrow bands on the same noise: one alone reads as a
    // whistle, two beating against each other read as rubber letting go.
    squealGain = gain(0, roadBus);
    squealA = biquad('bandpass', 900, 14, squealGain);
    squealB = biquad('bandpass', 1400, 11, squealGain);
    noiseSrc[0].connect(squealA);
    noiseSrc[0].connect(squealB);

    // --- weather ----------------------------------------------------------
    windGain = gain(0, weatherBus);
    windLP = biquad('lowpass', 400, 0.6, windGain);
    noiseSrc[1].connect(windLP);

    rainGain = gain(0, weatherBus);
    rainHP = biquad('highpass', 1600, 0.7, rainGain);
    noiseSrc[1].connect(rainHP);

    rainBodyGain = gain(0, weatherBus);
    rainBodyBP = biquad('bandpass', 520, 1.2, rainBodyGain);
    noiseSrc[1].connect(rainBodyBP);

    // --- fx ---------------------------------------------------------------
    tickGain = gain(0, fxBus);
    tickBP = biquad('bandpass', 2400, 2.0, tickGain);
    noiseSrc[0].connect(tickBP);

    // Road horns are two tones roughly a minor third apart, not one.
    hornGain = gain(0, fxBus);
    hornBP = biquad('bandpass', 900, 1.1, hornGain);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = i === 0 ? 410 : 512;
      o.connect(hornBP);
      o.start();
      hornOsc[i] = o;
    }

    // --- damage -----------------------------------------------------------
    // A fourth tap on the same buffer. The damage voices are the ones most
    // likely to be audible AT THE SAME TIME as the tyres — you are usually
    // still driving — and two branches reading the same samples at the same
    // offset comb into a filter sweep instead of sounding like two noises.
    noiseSrc[3] = noiseTap(noiseBuf, 1.57);

    // Blown tyre. The slap is amplitude modulation at wheel-rotation rate: the
    // same trick as the exhaust pulse, and for the same reason. A sawtooth ramp
    // into the gain, whose snap back once per revolution IS the flat spot
    // arriving at the road. It is panned, because a front-left blowout that
    // comes out of both speakers tells the player nothing they can act on.
    flapPan = ctx.createStereoPanner();
    flapPan.connect(roadBus);
    flapGain = gain(0, flapPan);
    flapBP = biquad('bandpass', 150, 1.1, flapGain);
    noiseSrc[3].connect(flapBP);
    rimGain = gain(0, flapGain);
    flapRim = biquad('bandpass', 2600, 3.5, rimGain);
    noiseSrc[3].connect(flapRim);
    flapDepth = gain(0, flapGain.gain);
    flapOsc = ctx.createOscillator();
    flapOsc.type = 'sawtooth';
    flapOsc.frequency.value = 8;
    flapOsc.connect(flapDepth);
    flapOsc.start();

    // Scraping along something. Two bands: the narrow one is the material
    // talking, the wide low one is the mass of the car behind it.
    grindGain = gain(0, fxBus);
    grindBP = biquad('bandpass', 900, 1.2, grindGain);
    grindLP = biquad('lowpass', 320, 1.0, grindGain);
    noiseSrc[3].connect(grindBP);
    noiseSrc[3].connect(grindLP);

    // Something hanging off the car. Metal on tarmac catches and lets go, so
    // there is a scrape band and a screech band and the mix between them moves.
    dragGain = gain(0, fxBus);
    dragBP = biquad('bandpass', 520, 1.6, dragGain);
    dragScreech = biquad('bandpass', 3100, 7, dragGain);
    noiseSrc[3].connect(dragBP);
    noiseSrc[3].connect(dragScreech);

    crackGain = gain(0, fxBus);
    crackBP = biquad('bandpass', 2200, 2.5, crackGain);
    noiseSrc[3].connect(crackBP);

    // Fire off the weather tap: it is the only branch there that is normally
    // silent in clear weather, so a burning car in the rain still decorrelates.
    fireGain = gain(0, fxBus);
    fireLP = biquad('lowpass', 240, 1.2, fireGain);
    noiseSrc[1].connect(fireLP);

    // Boiling coolant goes to engineBus rather than fxBus — it is under the
    // bonnet, and it should duck and swell with the engine, not sit outside it.
    // Straight to the bus, past engineHP, because nothing here is below 300 Hz.
    boilGain = gain(0, engineBus);
    boilBP = biquad('bandpass', 420, 3.0, boilGain);
    noiseSrc[2].connect(boilBP);

    // A holed exhaust, sharing the intake/exhaust tap it belongs with.
    raspGain = gain(0, engineHP);
    raspBP = biquad('bandpass', 800, 1.4, raspGain);
    noiseSrc[2].connect(raspBP);

    // --- traffic ----------------------------------------------------------
    for (let i = 0; i < TRAFFIC; i++) {
      trafficPan[i] = ctx.createStereoPanner();
      trafficPan[i].connect(trafficBus);
      trafficGain[i] = gain(0, trafficPan[i]);
      trafficLP[i] = biquad('lowpass', 900, 1.0, trafficGain[i]);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 80;
      o.connect(trafficLP[i]);
      o.start();
      trafficOsc[i] = o;
    }
  }

  /** Push the current profile into the nodes. Ramped, because the garage lets
   *  you swap cars while the engine is audible. */
  function applyProfile() {
    if (!running) return;
    now = ctx.currentTime;
    for (let i = 0; i < PARTIALS; i++) {
      osc[i].type = prof.type[i];
      osc[i].detune.setTargetAtTime(prof.detune[i], now, 0.05);
      ramp(partialGain[i].gain, prof.gain[i], 0.06);
    }
    ramp(enginePeak.Q, prof.peakQ, 0.05);
    ramp(enginePeak.gain, prof.peakDb, 0.05);
    ramp(exhaustBP.frequency, hz(prof.exhaustHz), 0.05);
  }

  const onVisibility = () => {
    // Sound from a tab you cannot see is never wanted, and suspending stops the
    // whole graph being rendered rather than merely turning it down.
    if (!ok || !running) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  };

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Must be called from a user gesture — browsers will not start a context
   *  otherwise. Idempotent. Returns whether there is sound to be had. */
  function start() {
    if (running) return ok;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC({ latencyHint: 'interactive' });
      now = ctx.currentTime;
      build();
      running = true;
      ok = true;
      ctx.resume().catch(() => {});
      document.addEventListener('visibilitychange', onVisibility);
    } catch {
      // Anything at all going wrong here means the game is silent, not broken.
      ok = false;
      running = false;
      ctx = null;
    }
    return ok;
  }

  function update(state, dt) {
    if (!ok || !running || !state) return;
    dt = clamp(dt || 0.016, 0.001, 0.1);
    now = ctx.currentTime;

    // ---- read and smooth the inputs --------------------------------------
    const redline = Math.max(1000, state.redline || 7000);
    const rpmN = clamp((state.rpm || 0) / redline, 0, 1.08);
    const throttle = clamp(state.throttle || 0, 0, 1);
    const load = clamp(num(state.load, throttle), 0, 1);
    // num(), not `|| 0`: a falsy NaN already became 0, but an INFINITE speed is
    // truthy and survives, and approach() then evaluates Infinity - Infinity on
    // the next frame, which is NaN in every smoothed value downstream of it.
    const speed = Math.max(0, num(state.speed, 0));
    const airborne = !!state.airborne;

    sRpmN = approach(sRpmN, rpmN, dt, 0.020);
    sThrottle = approach(sThrottle, throttle, dt, 0.045);
    sLoad = approach(sLoad, load, dt, 0.070);
    sSpeed = approach(sSpeed, speed, dt, 0.080);
    sRain = approach(sRain, clamp(state.rainIntensity || 0, 0, 1), dt, 0.60);
    sSlip = approach(sSlip, clamp(state.slipping || 0, 0, 1), dt, 0.055);
    wobble = (wobble + dt) % 1000;

    // Damage is read before the engine is voiced, because most of what it does
    // is change the engine rather than add anything next to it.
    readDamage(state, dt);

    const drive = clamp(Math.max(sThrottle, sLoad * 0.85), 0, 1);
    const f0 = (state.rpm || 0) / 60 * prof.base;
    const speedN = clamp(sSpeed / 45, 0, 1.4);

    // ---- gear shift: a torque interruption, not a click ------------------
    // Ducking the tone (and only the tone — the exhaust keeps flowing) for the
    // length of the shift is what a real interruption sounds like. A separate
    // click event on top of it just sounds like a fault in the sample player.
    const gear = num(state.gear, lastGear);
    const shifting = !!state.shifting || gear !== lastGear;
    if (gear !== lastGear) { shiftDuck = Math.min(shiftDuck, 0.18); lastGear = gear; }
    shiftDuck = approach(shiftDuck, shifting ? 0.14 : 1, dt, shifting ? 0.020 : 0.075);

    // ---- rev limiter ------------------------------------------------------
    let limitCut = 1;
    if (rpmN > 0.985 && throttle > 0.5) {
      limitPhase = (limitPhase + dt * 55) % 1;
      limitCut = limitPhase < 0.45 ? 0.28 : 1;
    } else {
      limitPhase = 0;
    }

    // ---- engine tone ------------------------------------------------------
    // A sick engine loses its TOP END first, and that is a filter change, not a
    // level change. Burnt valves and a bent rotating assembly stop it making
    // the high harmonics at all: it gets duller and flatter while staying just
    // as loud, which is exactly what a tired engine does and is far more
    // legible than simply turning it down (the player reads a quieter engine as
    // "I lifted off", and a duller one as "something is wrong").
    const sick = 1 - dEngine;
    for (let i = 0; i < PARTIALS; i++) ramp(osc[i].frequency, hz(f0 * prof.mul[i]), 0.010);
    ramp(engineLP.frequency,
      hz((prof.cutHz + sRpmN * prof.cutRpm + drive * prof.cutDrive) * (1 - 0.55 * sick)), 0.020);
    ramp(enginePeak.frequency, hz(f0 * prof.peakMul), 0.020);
    // Roughness is redistribution, not addition: lean on the half order (the
    // imbalance order — the one a healthy six deliberately does not have) and
    // starve the top partial. Same total energy, worse engine.
    ramp(partialGain[0].gain, prof.gain[0] * (1 + 1.4 * sick), 0.08);
    ramp(partialGain[PARTIALS - 1].gain, prof.gain[PARTIALS - 1] * (1 - 0.7 * sick), 0.08);
    // Harder into the soft clipper on load: the grit is the throttle response.
    ramp(engineDrive.gain, 1 + prof.drive * 5.5 * Math.pow(drive, 1.4), 0.030);
    // A lumpy idle: a slow beat between two incommensurate rates, so it never
    // repeats on a bar line. It fades out with revs because above about half
    // throttle the firing rate is fast enough to smooth over a bad cylinder.
    const lump = 1 - 0.24 * sick * (0.5 + 0.5 * Math.sin(wobble * 13.7) * Math.sin(wobble * 4.1))
      * (1 - sRpmN * 0.6);
    const tone = prof.level * (prof.idle + (1 - prof.idle) * drive)
      * (0.55 + 0.45 * sRpmN) * shiftDuck * limitCut * lump * dDead * (1 - 0.78 * misfire)
      / (1 + prof.drive * 2.2 * drive);
    // A misfire is 20 ms of nothing. At the usual 20 ms time constant it would
    // arrive as a shrug, so the ramp itself gets faster while one is happening.
    ramp(engineTone.gain, tone, misfire > 0.02 ? 0.006 : 0.020);

    // ---- intake whoosh ----------------------------------------------------
    // Scaled by what the engine can still deliver rather than by its own
    // health, because powerScale also carries the fire and overheat derates —
    // a cooking engine stops breathing hard well before it is mechanically hurt.
    ramp(intakeBP.frequency, hz(prof.intakeHz + sRpmN * prof.intakeRpmHz), 0.030);
    ramp(intakeGain.gain,
      prof.intake * Math.pow(sThrottle, 1.5) * (0.20 + 0.80 * sRpmN) * (0.30 + 0.70 * dPower), 0.030);

    // ---- exhaust, and the rasp on overrun ---------------------------------
    // Overrun is a shut throttle at revs: unburnt mixture arriving in a hot pipe
    // is what crackles, so the crackle is gated on exactly that and nothing else.
    const overrun = clamp(1 - throttle * 3, 0, 1) * clamp((rpmN - 0.35) / 0.40, 0, 1);
    if (overrun > 0.30 && Math.random() < dt * 16 * overrun) crackle = 0.6 + Math.random() * 0.5;
    crackle *= Math.exp(-dt * 22);
    // A holed pipe is the one piece of damage that improves the car's day: it
    // gets louder, it loses the low resonance the silencer was making, and the
    // bandwidth opens up into a rasp. An electric car has no exhaust to hole,
    // so `hole` is gated on the profile having one at all rather than on the
    // damage state, which knows nothing about what is fitted.
    const hole = prof.exhaust > 0 ? 1 - dExhaust : 0;
    // A misfire is unburnt mixture leaving through the pipe: it barks whatever
    // the throttle is doing, which is why it is added outside the overrun gate.
    //
    // The ceiling of 3 is not arbitrary and it is not the limiter's job. An
    // overrunning V8 mid-crackle already reaches 2.95 here, and the limiter is
    // tuned around that; let a holed pipe multiply it and every misfire ducks
    // the entire mix for the length of the limiter's release, which sounds like
    // the game skipping. A damaged car may be as loud as the loudest thing this
    // file could already make, and no louder.
    const exhaust = prof.exhaust * Math.min(3.0,
      ((0.25 + 0.75 * sThrottle) + overrun * 0.85 + crackle * overrun) * (1 + 1.15 * hole)
      + misfire * 1.1);
    ramp(exhaustGain.gain, exhaust * shiftDuck * dDead, 0.015);
    ramp(exhaustBP.frequency, hz(prof.exhaustHz * (1 + 0.85 * hole)), 0.080);
    ramp(exhaustBP.Q, clamp(2.4 - 1.75 * hole, 0.6, 4), 0.080);
    pulseOsc.frequency.setTargetAtTime(hz(f0), now, 0.010);
    ramp(pulseGain.gain, exhaust * (0.90 - 0.55 * sRpmN), 0.020);

    // ---- tyres ------------------------------------------------------------
    const tyre = TYRE[state.surface] || TYRE.asphalt;
    sHiss = approach(sHiss, tyre.hiss, dt, 0.12);
    sRumble = approach(sRumble, tyre.rumble, dt, 0.12);
    sHissHz = approach(sHissHz, tyre.hissHz, dt, 0.12);
    sRumbleHz = approach(sRumbleHz, tyre.rumbleHz, dt, 0.12);
    sSqueal = approach(sSqueal, tyre.squeal, dt, 0.12);

    const contact = airborne ? 0 : 1;   // nothing is touching anything
    // A flat tyre does not only ADD a noise, it takes the rolling noise away
    // from its own corner: there is no tread left down there to hiss. Docking
    // the hiss is what makes the flap sound like it replaced something.
    ramp(hissBP.frequency, hz(sHissHz + speedN * 500), 0.040);
    ramp(hissGain.gain, contact * sHiss * Math.pow(speedN, 1.25) * 0.95 * (1 - 0.42 * dFlap), 0.040);
    // A slow amplitude wobble is what stops loose ground sounding like a fan.
    // Bent steering and a collapsed corner add a second, faster one locked to
    // wheel rotation — the judder you feel through the wheel, made audible.
    // Math.max on the radius, not just num(): a spec carrying a zero divides by
    // zero here and clamp() passes the NaN straight through. rotHz feeds
    // judderPhase, which is recursive, so one bad frame leaves the rumble gain
    // NaN for the rest of the session — and a NaN into setTargetAtTime is a
    // thrown TypeError in Chrome that takes the whole frame loop with it.
    const rotHz = clamp(
      sSpeed / (2 * Math.PI * Math.max(0.05, num(state.wheelRadius, DEFAULT_WHEEL_R))), 0.4, 26);
    judderPhase = (judderPhase + dt * rotHz) % 1;
    const rumbleMod = 1 + 0.25 * Math.sin(wobble * 11.3) * sRumble
      + 0.40 * dWobble * contact * Math.sin(judderPhase * 6.2832) * clamp(speedN, 0, 1);
    ramp(rumbleLP.frequency, hz(sRumbleHz), 0.040);
    ramp(rumbleGain.gain, contact * sRumble * clamp(speedN * 1.3, 0, 1.3) * rumbleMod * 1.15, 0.040);

    // ---- skid squeal ------------------------------------------------------
    skidImpulse *= Math.exp(-dt * 3.2);
    const slip = Math.max(sSlip, skidImpulse);
    // Below walking pace a locked tyre scrubs; it does not sing.
    const squeal = contact * sSqueal * slip * clamp((sSpeed - 2.5) / 6, 0, 1);
    const squealHz = 780 + slip * 520 + Math.sin(wobble * 7.4) * 45;
    ramp(squealA.frequency, hz(squealHz), 0.030);
    ramp(squealB.frequency, hz(squealHz * 1.54), 0.030);
    ramp(squealGain.gain, squeal * 0.55, 0.030);

    // ---- wind and rain ----------------------------------------------------
    const windN = clamp(sSpeed / 60, 0, 1.5);
    ramp(windLP.frequency, hz(300 + windN * 3000), 0.060);
    ramp(windGain.gain, windN * windN * (airborne ? 1.25 : 1) * 0.85, 0.060);
    ramp(rainGain.gain, sRain * (0.25 + 0.35 * speedN), 0.20);
    ramp(rainBodyGain.gain, sRain * (0.10 + 0.50 * speedN), 0.20);

    updateDamageVoices(dt, speedN, contact, drive, rotHz);
    updateTraffic(state, dt);
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * Read `state.damage` and `state.damageEffects` and smooth everything.
   *
   * All scalars, no allocation, and every read guarded — main.js may pass no
   * damage at all, and an undamaged car must sound bit-for-bit like the car
   * this file made before any of this existed. The unwrapping at the top is
   * deliberate slack in the wiring: `car.damage` and `car.damage.state` are
   * easy to confuse at the call site and the difference would otherwise be a
   * silent no-op that nobody notices for a week.
   */
  function readDamage(state, dt) {
    const d = state.damage && state.damage.state ? state.damage.state : state.damage;
    const fx = state.damageEffects || (state.damage && state.damage.effects) || null;

    const engine = d ? clamp(num(d.engine, 1), 0, 1) : 1;
    const exhaust = d ? clamp(num(d.exhaust, 1), 0, 1) : 1;
    const temp = d ? clamp(num(d.temp, 0.35), 0, 1.4) : 0.35;
    const fire = d ? clamp(num(d.onFire, 0), 0, 1) : 0;
    const power = fx ? clamp(num(fx.powerScale, 1), 0, 1) : 1;
    const wob = fx ? clamp(num(fx.wobble, 0), 0, 1) : 0;
    const dead = fx && fx.dead ? 0 : 1;

    // Tyres, per side. A tyre well below pressure already slaps; a blown one
    // slaps hard and grinds a rim as well. Left corners are the even indices —
    // the damage model orders them fl, fr, rl, rr.
    let flapL = 0, flapR = 0, rim = 0;
    if (d && d.tyre) {
      for (let i = 0; i < 4; i++) {
        const blown = !!(d.blown && d.blown[i]);
        const f = blown ? 1 : clamp((0.45 - clamp(num(d.tyre[i], 1), 0, 1)) / 0.45, 0, 1);
        if (i % 2 === 0) { if (f > flapL) flapL = f; } else if (f > flapR) flapR = f;
        if (blown) rim = 1;
      }
    }
    const flap = flapL > flapR ? flapL : flapR;
    const pan = flapL + flapR > 0 ? (flapR - flapL) / (flapL + flapR) : 0;

    // Dragging. The caller may know better — a debris system that has actually
    // parted a piece from the car can say so with state.dragging — but the
    // attached map is enough on its own, and it is what main.js already has.
    let drag = num(state.dragging, -1);
    // Clamped like every other value arriving from outside. `dragging` is
    // documented as 0..1, and a caller passing a COUNT of dragging parts
    // instead of a fraction gets a gain of 2.4 rather than 0.46, which pins
    // the limiter and ducks the entire mix for as long as the part is there.
    if (drag >= 0) drag = clamp(drag, 0, 1);
    else {
      drag = 0;
      const att = d && d.attached;
      // Summed, not maximised: two things dragging make more noise than one.
      if (att) {
        for (let i = 0; i < DRAG_PARTS.length; i++) {
          if (att[DRAG_PARTS[i]] === false) drag += DRAG_WEIGHT[i];
        }
      }
      drag = clamp(drag * 0.62, 0, 1);
    }

    dEngine = approach(dEngine, engine, dt, 0.25);
    dExhaust = approach(dExhaust, exhaust, dt, 0.25);
    dPower = approach(dPower, power, dt, 0.25);
    dTemp = approach(dTemp, temp, dt, 0.50);
    dFire = approach(dFire, fire, dt, 0.40);
    dWobble = approach(dWobble, wob, dt, 0.35);
    dFlap = approach(dFlap, flap, dt, 0.15);
    dRim = approach(dRim, rim, dt, 0.20);
    dDrag = approach(dDrag, drag, dt, 0.25);
    // An engine that has just given up coughs down over half a second. It does
    // not stop mid-note, which is what a hard mute sounds like.
    dDead = approach(dDead, dead, dt, 0.30);
    dFlapPan = approach(dFlapPan, pan, dt, 0.30);

    // Misfire. A sick engine drops a cylinder now and then, more often the
    // harder it is working and the worse it is. Random rather than periodic:
    // a periodic misfire is a rhythm, and a rhythm reads as intentional.
    const sick = 1 - dEngine;
    if (sick > 0.05 && Math.random() < dt * sick * sick * (6 + 22 * sRpmN) * (0.35 + 0.65 * sThrottle)) {
      misfire = 0.55 + Math.random() * 0.45;
    }
    misfire *= Math.exp(-dt * 42);
  }

  /**
   * The voices that only exist because something is broken.
   *
   * Every one of them lands on a hard zero when the car is well, so the cost of
   * this function on an undamaged car is a handful of setTargetAtTime calls to
   * values that are already there.
   */
  function updateDamageVoices(dt, speedN, contact, drive, rotHz) {
    // ---- blown tyre -------------------------------------------------------
    // Rotation rate, not road speed. The slap comes once per revolution, so it
    // slows as you slow, and that relationship is the whole tell: a noise that
    // tracked speed alone would just be more road roar. Not through hz(),
    // which floors at 8 Hz — this is a modulator and belongs at walking pace.
    flapOsc.frequency.setTargetAtTime(rotHz, now, 0.050);
    const flapLevel = dFlap * contact * clamp((sSpeed - 1.2) / 8, 0, 1);
    // Depth close to the base gain, so the ramp bottoms out near zero and the
    // sawtooth's snap back to the top is a transient rather than a wobble.
    ramp(flapGain.gain, flapLevel * 0.42, 0.060);
    ramp(flapDepth.gain, flapLevel * 0.38, 0.060);
    ramp(flapBP.frequency, hz(115 + rotHz * 5.5), 0.080);
    ramp(flapPan.pan, clamp(dFlapPan * 0.6, -1, 1), 0.100);
    // Running on the rim. Only once there is real speed behind it: a wheel
    // rolling gently on a flat carcass is a slap and nothing more.
    ramp(flapRim.frequency, hz(2100 + speedN * 1500), 0.080);
    // 0.40 against the flap's own 0.42: the rim band is narrow and high, where
    // the ear is most sensitive, so matching them by number makes it dominate.
    ramp(rimGain.gain, dRim * clamp((sSpeed - 3) / 14, 0, 1) * contact * 0.40, 0.100);

    // ---- scraping along something -----------------------------------------
    // The grind is fed by impacts and decays on its own, which is what lets a
    // 1.5 s rasp exist at all: a one-shot long enough to cover a scrape has to
    // guess how long the scrape will last, and it always guesses wrong.
    dGrind *= Math.exp(-dt * 3.0);
    if (dGrind > 0.001) {
      dGrindHz = approach(dGrindHz, grindHzT, dt, 0.08);
      dGrindQ = approach(dGrindQ, grindQT, dt, 0.08);
      dGrit = approach(dGrit, gritT, dt, 0.08);
      // Two fast incommensurate rates: the jitter is what turns a filtered
      // noise into stone tearing at paint. The 20 ms ramp is deliberately
      // short — smooth this and it becomes a hum.
      const grit = 0.55 + 0.45 * Math.sin(wobble * 41.3) * Math.sin(wobble * 17.7);
      ramp(grindGain.gain, dGrind * (1 - dGrit * 0.5 + dGrit * grit * 0.5) * 0.85, 0.020);
      ramp(grindBP.frequency, hz(dGrindHz), 0.030);
      ramp(grindBP.Q, clamp(dGrindQ, 0.4, 8), 0.050);
      ramp(grindLP.frequency, hz(dGrindHz * 0.35), 0.030);
    } else if (grindGain.gain.value > 0.0005) {
      ramp(grindGain.gain, 0, 0.030);
    }

    // ---- dragging metal ---------------------------------------------------
    const dragLevel = dDrag * contact * clamp((sSpeed - 0.8) / 6, 0, 1);
    if (dragLevel > 0.001 || dragGain.gain.value > 0.0005) {
      // Metal on tarmac catches, screeches and lets go. A smoothed random walk
      // does that; a steady level sounds like a stuck fan.
      dragJit = approach(dragJit, Math.random(), dt, 0.055);
      ramp(dragGain.gain, dragLevel * (0.30 + 0.70 * dragJit) * 0.55, 0.030);
      ramp(dragBP.frequency, hz(360 + speedN * 380), 0.060);
      ramp(dragScreech.frequency, hz(2100 + dragJit * 2800), 0.040);
    }

    // ---- overheat ---------------------------------------------------------
    // 0.72 is where damage.js starts making smoke, so the sound and the smoke
    // arrive together rather than the player seeing steam in silence.
    boilBoost *= Math.exp(-dt * 0.55);
    const boil = clamp((dTemp - 0.72) / 0.35 + boilBoost, 0, 1.3);
    if (boil > 0.001 || boilGain.gain.value > 0.0005) {
      const gurgle = 0.70 + 0.30 * Math.sin(wobble * 5.3) * Math.sin(wobble * 2.1);
      // The centre frequency climbing is what reads as "getting worse". A hiss
      // that only gets louder reads as "getting closer".
      ramp(boilBP.frequency, hz(380 + boil * 2400), 0.150);
      ramp(boilGain.gain, boil * boil * 0.30 * gurgle, 0.120);
    }

    // ---- fire -------------------------------------------------------------
    if (dFire > 0.001 || fireGain.gain.value > 0.0005) {
      const surge = 0.72 + 0.28 * Math.sin(wobble * 3.1) * Math.sin(wobble * 1.37);
      ramp(fireLP.frequency, hz(170 + dFire * 280), 0.200);
      ramp(fireGain.gain, dFire * surge * 0.60, 0.100);
      if (dFire > 0.02 && Math.random() < dt * (8 + 46 * dFire)) {
        fireCrackle = 0.5 + Math.random() * 0.5;
      }
      fireCrackle *= Math.exp(-dt * 26);
      // Each crackle is a different pitch, which is the difference between a
      // fire and a Geiger counter.
      ramp(crackBP.frequency, hz(1300 + fireCrackle * 2400), 0.010);
      ramp(crackGain.gain, dFire * fireCrackle * 0.55, 0.008);
    }

    // ---- holed exhaust ----------------------------------------------------
    const hole = prof.exhaust > 0 ? 1 - dExhaust : 0;
    if (hole > 0.001 || raspGain.gain.value > 0.0005) {
      ramp(raspBP.frequency, hz(600 + sRpmN * 1500), 0.050);
      ramp(raspGain.gain,
        hole * prof.exhaust * (0.20 + 0.80 * drive) * (0.30 + 0.70 * sRpmN) * 0.55, 0.030);
    }
  }

  /**
   * Take the damage events main.js drained this frame.
   *
   * ACCEPTS the array; never drains it and never mutates it. drainEvents()
   * empties the queue, so exactly one consumer in the game may call it, and
   * that consumer is main.js — an audio module that drained for itself would
   * silently starve the particles and the renderer of every event it saw.
   */
  function applyDamageEvents(events) {
    if (!ok || !running || !events) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e || !e.type) continue;
      switch (e.type) {
        case 'glass-shatter': playShatter(e.glass); break;
        // A craze is the first 30 ms of a shatter and nothing after it.
        case 'glass-crack': playTick(3200, 0.42, 0.030, panOf(e.glass), 0.55); break;
        // A lamp lens is a smaller, thinner pane: brighter and shorter again.
        case 'light-smash': playTick(5400, 0.34, 0.045, panOf(e.light), 0.75); break;
        case 'tyre-burst': playTyreBurst(e.wheel, e.cause); break;
        case 'detach': playClatter(e.part, e.speed); break;
        case 'fire-start': playIgnition(); break;
        case 'fire-out': playSteam(0.55, 0.9); break;
        // Emitted on every impact once the radiator is holed, so this must be
        // a nudge to a continuous voice rather than a one-shot — one-shots
        // would machine-gun the moment you leant on a wall.
        case 'coolant-leak': boilBoost = Math.min(0.45, boilBoost + 0.14); break;
        // Only the two systems you would actually HEAR let go. A dead radiator
        // is already the boil, a dead exhaust is already the rasp, and a
        // clunk for each of them would be five clunks for one crash.
        case 'system-dead':
          if (e.system === 'engine' || e.system === 'gearbox') playClunk(e.system);
          break;
        // 'system-failing' is deliberately silent: the continuous voices are
        // already saying it, every frame, better than a beep could.
        default: break;
      }
    }
  }

  function updateTraffic(state, dt) {
    const cars = state.nearbyCars;
    const n = cars ? Math.min(cars.length, TRAFFIC_SCAN) : 0;
    // Positions may be world-space (pass state.x/state.z/state.yaw too) or
    // already relative to the player, in which case the defaults do the right
    // thing on their own.
    const lx = state.x || 0, lz = state.z || 0, yaw = state.yaw || 0;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);   // the car's right, see header

    for (let s = 0; s < TRAFFIC; s++) slotPick[s] = -1;
    for (let s = 0; s < TRAFFIC; s++) {
      let best = -1, bestD = TRAFFIC_RANGE;
      for (let i = 0; i < n; i++) {
        if (i === slotPick[0] || i === slotPick[1] || i === slotPick[2]) continue;
        const c = cars[i];
        if (!c) continue;              // sparse or pooled lists have holes
        const dx = (c.x || 0) - lx, dz = (c.z || 0) - lz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < bestD) { bestD = d; best = i; }
      }
      slotPick[s] = best;

      if (best < 0) { ramp(trafficGain[s].gain, 0, 0.10); slotKey[s] = null; continue; }

      const c = cars[best];
      const dx = (c.x || 0) - lx, dz = (c.z || 0) - lz;
      const key = c.id ?? best;

      // Doppler from how fast the gap is closing. Needs the same car frame to
      // frame, so a slot that has changed hands sits this one out rather than
      // shifting pitch by the difference between two unrelated cars.
      let closing = 0;
      if (slotKey[s] === key) closing = (bestD - slotDist[s]) / dt;
      slotKey[s] = key;
      slotDist[s] = bestD;
      const dop = clamp(SOUND_SPEED / (SOUND_SPEED + clamp(closing, -60, 60)), 0.85, 1.20);

      // AI cars all get a generic four-cylinder voice; at this level in the mix
      // nobody can tell, and it keeps the node count at one oscillator each.
      const f = hz((c.rpm || 2200) / 60 * 2 * dop);
      const att = 1 - bestD / TRAFFIC_RANGE;
      const level = att * att * (0.35 + 0.65 * clamp((c.speed || 0) / 30, 0, 1));
      ramp(trafficOsc[s].frequency, f, 0.040);
      ramp(trafficLP[s].frequency, hz(420 + level * 1600), 0.060);
      ramp(trafficGain[s].gain, level * 0.30, 0.060);
      ramp(trafficPan[s].pan, clamp((dx * rx + dz * rz) / Math.max(5, bestD), -1, 1), 0.060);
    }
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  /** One filtered noise transient, panned, that tidies itself away.
   *
   *  Four nodes and a closure per call. Allocating here is fine — what must not
   *  allocate is update(); a bang is not a per-frame event. Returns the gain so
   *  a caller can schedule more of an envelope onto it. */
  function noiseBurst(t, type, freq, q, peak, attack, dur, pan) {
    const out = ctx.createStereoPanner();
    out.pan.value = clamp(num(pan, 0), -1, 1);
    out.connect(fxBus);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz(freq); f.Q.value = q;
    f.connect(g);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.connect(f);
    // A random offset into the buffer, kept clear of the end so a long tail
    // never runs off it and stops early.
    src.start(t, Math.random() * 2.0);
    src.stop(t + dur);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); out.disconnect(); };
    return g;
  }

  /** A stack of inharmonic partials. Inharmonic is the whole trick: harmonic
   *  partials sound like a bell, ratios that do not divide sound like metal. */
  function ringBurst(t, ratios, base, peak, dur, pan, attack) {
    const out = ctx.createStereoPanner();
    out.pan.value = clamp(num(pan, 0), -1, 1);
    out.connect(fxBus);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    for (let i = 0; i < ratios.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = hz(base * ratios[i]);
      o.connect(g);
      o.start(t);
      o.stop(t + dur);
      if (i === 0) o.onended = () => { g.disconnect(); out.disconnect(); };
    }
  }

  /** Ration for the damage one-shots. End times rather than a counter, for the
   *  same reason as collisionEnds: a context suspended mid-ring never fires
   *  onended, and a counter that can only go up ends the session in silence. */
  function transientSlot(t, dur) {
    for (let i = 0; i < MAX_TRANSIENT; i++) {
      if (transientEnds[i] <= t) { transientEnds[i] = t + dur; return true; }
    }
    return false;
  }

  /**
   * An impact.
   *
   * Two sounds live in here and the split between them is what the whole thing
   * turns on. A square-on hit is ONE event: a burst, a crumple you feel more
   * than hear, and the panel ringing after it. A glancing blow is not an event
   * at all — it is a rasp that lasts as long as you stay against the wall — so
   * its energy goes into the continuous grind voice instead, and only a little
   * of it fires a transient. Scaling one sound by gain for both is the single
   * most recognisable sign of a synthesised crash.
   *
   * @param {number} severity 0..1, from the collision solver.
   * @param {object|string} [opts] a material name, or `{ material, glance }`.
   *        `glance` 1 is a sideswipe that never stops moving, 0 is square on;
   *        leave it out and it is measured from the rate impacts arrive at.
   */
  function playCollision(severity = 0.5, opts) {
    if (!ok || !running) return;
    const s = clamp(num(severity, 0.5), 0, 1);
    const t = ctx.currentTime;

    let mat = DEFAULT_MATERIAL, glance = -1;
    if (typeof opts === 'string') mat = MATERIALS[opts] || DEFAULT_MATERIAL;
    else if (opts) {
      if (typeof opts.material === 'string' && MATERIALS[opts.material]) mat = MATERIALS[opts.material];
      glance = num(opts.glance, -1);
    }

    // Measuring the glance when nobody said. A scrape along a wall is not one
    // collision: it is the solver reporting a small hit on EVERY physics step
    // for as long as the car is touching, at 120 a second. A crash is one
    // report and then silence. Counting how many arrived back to back is
    // therefore a direct measurement of "am I sliding along this or did I hit
    // it", and it needs nothing at all from the caller.
    if (t - lastImpactAt < 0.14) { if (impactRun < 12) impactRun++; } else impactRun = 0;
    lastImpactAt = t;
    if (glance < 0) glance = clamp(impactRun / 5, 0, 1);
    else glance = clamp(glance, 0, 1);

    // ---- the scrape half --------------------------------------------------
    const scrape = glance * (0.35 + 0.65 * s);
    if (scrape > 0.02) {
      if (scrape > dGrind) dGrind = Math.min(1, scrape);
      grindHzT = mat.grindHz * (1 - 0.30 * s);
      grindQT = mat.grindQ;
      gritT = mat.grit;
    }

    // ---- the hit half -----------------------------------------------------
    // What the grind took, the transient does not get. A light scrape fires
    // nothing at all, which is what stops a wall-ride sounding like gunfire.
    const hit = (1 - glance * 0.85) * s;
    if (hit < 0.03) return;

    const burstDur = (0.06 + 0.30 * hit) * (0.5 + 0.5 * mat.decay);
    const ringDur = (0.18 + 0.85 * s) * mat.decay;
    const subDur = 0.30;
    let dur = burstDur > ringDur ? burstDur : ringDur;

    let slot = -1;
    for (let i = 0; i < MAX_COLLISIONS; i++) if (collisionEnds[i] <= t) { slot = i; break; }
    if (slot < 0) return;

    // Severity moves the spectrum, not just the level: a heavier hit is duller,
    // because more mass is moving and less of the panel is free to ring.
    noiseBurst(t, 'lowpass', mat.burstHz * (1 - 0.55 * s), 1.2,
      0.22 + 0.85 * hit, 0.004, burstDur, 0);

    if (mat.ring > 0.05) {
      ringBurst(t, COLLISION_RATIOS, mat.ringHz * (1 - 0.42 * s),
        (0.06 + 0.30 * hit) * mat.ring, ringDur, 0, 0.006);
    }

    // The crumple. A real head-on is felt before it is heard, and the felt part
    // is a single deep collapse sweeping downward as the structure folds — one
    // note, not a rumble. Only square-on hits get it; a sideswipe folds nothing.
    if (hit > 0.30 && mat.sub > 0.10) {
      if (subDur > dur) dur = subDur;
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(0.55 * mat.sub * hit, t + 0.006);
      out.gain.exponentialRampToValueAtTime(0.0001, t + subDur);
      out.connect(fxBus);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(hz(160 * (1 - 0.30 * hit)), t);
      o.frequency.exponentialRampToValueAtTime(hz(42), t + 0.17);
      o.connect(out);
      o.start(t);
      o.stop(t + subDur);
      o.onended = () => { out.disconnect(); };
    }

    collisionEnds[slot] = t + dur;
  }

  // ---- damage one-shots -----------------------------------------------------

  /** A short filtered tick: a windscreen crazing, a lens going. `bright` moves
   *  it from a dull knock toward a splinter without changing its length. */
  function playTick(freq, peak, dur, pan, bright) {
    const t = ctx.currentTime;
    if (!transientSlot(t, dur)) return;
    noiseBurst(t, 'bandpass', freq, 1.2 + 6 * clamp(num(bright, 0.5), 0, 1), peak, 0.0015, dur, pan);
  }

  /**
   * A pane leaving its frame.
   *
   * The burst is the easy half. What makes it read as glass rather than as a
   * cymbal is the SHOWER afterwards — fragments landing over the next third of
   * a second — and that is scheduled as spikes on the one gain the burst
   * already has, rather than as six more buffer sources. Six sources per
   * windscreen, with four windows and a crash that can take them all at once,
   * is how a one-shot system runs out of slots.
   */
  function playShatter(name) {
    const t = ctx.currentTime;
    if (!transientSlot(t, 0.55)) return;
    const pan = panOf(name);
    const g = noiseBurst(t, 'highpass', 2600, 0.7, 0.60, 0.003, 0.50, pan);
    const p = g.gain;
    for (let i = 0; i < 6; i++) {
      const ti = t + 0.09 + i * 0.048 + Math.random() * 0.030;
      p.setValueAtTime(0.0001, ti);
      p.exponentialRampToValueAtTime(0.34 * (1 - i / 7) * (0.5 + Math.random() * 0.5), ti + 0.002);
      p.exponentialRampToValueAtTime(0.0001, ti + 0.038);
    }
    // Three high, tight, thoroughly inharmonic partials: the glassiness.
    ringBurst(t, GLASS_RATIOS, 2900 + Math.random() * 700, 0.16, 0.22, pan, 0.004);
  }

  /**
   * A tyre letting go.
   *
   * An impact burst is a single sharp crack — the air is gone in milliseconds.
   * Wearing through is the same energy spread over four times as long, because
   * the carcass tears rather than splits, and the two are worth telling apart:
   * one means you hit something, the other means you have been ignoring the
   * surface you chose to drive on.
   */
  function playTyreBurst(wheel, cause) {
    const t = ctx.currentTime;
    const torn = cause === 'wear';
    const dur = torn ? 0.30 : 0.10;
    if (!transientSlot(t, dur + 0.14)) return;
    const w = wheel | 0;
    const pan = (w % 2 === 0 ? -1 : 1) * 0.5;      // fl, fr, rl, rr — even is left
    noiseBurst(t, 'highpass', torn ? 700 : 1100, 0.6, torn ? 0.55 : 1.0, 0.0015, dur, pan);
    // The carcass slamming the arch: one thump, swept down, no ring.
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(torn ? 0.28 : 0.50, t + 0.005);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(fxBus);
    out.connect(p);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz(170), t);
    o.frequency.exponentialRampToValueAtTime(hz(55), t + 0.12);
    o.connect(out);
    o.start(t);
    o.stop(t + 0.14);
    o.onended = () => { out.disconnect(); p.disconnect(); };
  }

  /**
   * A part coming off and bouncing away.
   *
   * Three ticks rather than one: something that leaves a car at speed hits the
   * road, comes back up and hits it again, and the gaps between those are the
   * only reason it sounds like a bumper rather than a door slam. Heavy parts
   * get a ring under the first tick; a mirror gets none, because there is no
   * panel there to ring.
   */
  function playClatter(part, speed) {
    const t = ctx.currentTime;
    if (!transientSlot(t, 0.45)) return;
    const v = clamp(num(speed, 8) / 22, 0.25, 1);
    const pan = panOf(part);
    let heavy = false;
    for (let i = 0; i < HEAVY_PARTS.length; i++) if (HEAVY_PARTS[i] === part) { heavy = true; break; }

    const g = noiseBurst(t, 'bandpass', heavy ? 1100 : 2300, 1.6, 0.34 * v, 0.002, 0.42, pan);
    const p = g.gain;
    for (let i = 1; i < 3; i++) {
      const ti = t + 0.075 * i * (1.6 - i * 0.25) + Math.random() * 0.04;
      p.setValueAtTime(0.0001, ti);
      p.exponentialRampToValueAtTime(0.30 * v / (1 + i), ti + 0.002);
      p.exponentialRampToValueAtTime(0.0001, ti + 0.09);
    }
    if (heavy) ringBurst(t, COLLISION_RATIOS, 260 + Math.random() * 90, 0.16 * v, 0.30, pan, 0.005);
  }

  /** Something mechanical giving up. Low, dull and over quickly: the body of it
   *  sits under 200 Hz and lasts a fifth of a second, because a thing that has
   *  just broken is precisely the thing that no longer rings on. */
  function playClunk(system) {
    const t = ctx.currentTime;
    if (!transientSlot(t, 0.26)) return;
    noiseBurst(t, 'lowpass', system === 'gearbox' ? 420 : 260, 1.0, 0.45, 0.003, 0.24, 0);
    ringBurst(t, GLASS_RATIOS, system === 'gearbox' ? 150 : 95, 0.22, 0.20, 0, 0.006);
  }

  /** Catching light: a soft swell rather than an explosion. There is no bomb
   *  under the bonnet, and a bang here would promise one — so the whole event
   *  is a 150 ms attack, which is far too slow to read as a detonation. */
  function playIgnition() {
    const t = ctx.currentTime;
    if (!transientSlot(t, 0.60)) return;
    noiseBurst(t, 'lowpass', 900, 0.8, 0.42, 0.150, 0.58, 0);
  }

  /** Steam: a hiss that falls away. The sound of having won, if the fire is
   *  what put it there. */
  function playSteam(peak, dur) {
    const t = ctx.currentTime;
    if (!transientSlot(t, dur)) return;
    noiseBurst(t, 'highpass', 1800, 0.7, peak, 0.030, dur, 0);
  }

  /** An explicit scrub, on top of whatever `slipping` is already asking for. */
  function playSkid(v = 1) {
    if (!ok || !running) return;
    skidImpulse = Math.max(skidImpulse, clamp(num(v, 1), 0, 1));
  }

  function playHorn() {
    if (!ok || !running) return;
    // Retriggering restarts the envelope rather than stacking a second horn on
    // the first, which is what makes a held key sound like one long note.
    const t = ctx.currentTime;
    const g = hornGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.34, t + 0.014);
    g.setValueAtTime(0.34, t + 0.34);
    g.linearRampToValueAtTime(0, t + 0.42);
  }

  function playIndicator() {
    if (!ok || !running) return;
    // A relay makes two slightly different noises — pulling in and dropping out.
    tickHigh = !tickHigh;
    const t = ctx.currentTime;
    tickBP.frequency.setValueAtTime(hz(tickHigh ? 2400 : 1750), t);
    const g = tickGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(0.55, t + 0.0015);
    g.exponentialRampToValueAtTime(0.0001, t + 0.028);
  }

  // -------------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------------

  function applyMaster() {
    if (!ok || !running) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02);
  }
  function setMuted(b) { muted = !!b; applyMaster(); }
  function setVolume(v) { volume = clamp(num(v, volume), 0, 1); applyMaster(); }
  function setEngineProfile(p) { prof = resolveProfile(p); applyProfile(); }

  function dispose() {
    if (!running) { ok = false; return; }
    running = false;
    ok = false;
    try {
      document.removeEventListener('visibilitychange', onVisibility);
      for (let i = 0; i < PARTIALS; i++) osc[i].stop();
      for (let i = 0; i < TRAFFIC; i++) trafficOsc[i].stop();
      for (let i = 0; i < 2; i++) hornOsc[i].stop();
      for (let i = 0; i < noiseSrc.length; i++) noiseSrc[i].stop();
      pulseOsc.stop();
      flapOsc.stop();
      master.disconnect();
      ctx.close();
    } catch { /* already torn down; nothing here is worth a crash */ }
    ctx = null;
    noiseBuf = null;
  }

  return {
    start, update, applyDamageEvents,
    playCollision, playSkid, playHorn, playIndicator,
    setMuted, setVolume, setEngineProfile,
    dispose,
    get running() { return ok && running; },
  };
}
