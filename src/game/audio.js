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

const PARTIALS = 5;
const TRAFFIC = 3;             // simultaneous AI engines. Three is plenty: past
                               // that they smear into one texture anyway.
const TRAFFIC_RANGE = 72;      // m, beyond which a car is not worth a voice
const TRAFFIC_SCAN = 24;       // bound the per-frame scan, however long the list
const MAX_COLLISIONS = 4;      // concurrent impact voices
const SOUND_SPEED = 340;

// Ratios chosen not to share a common divisor, so an impact rings like sheet
// metal rather than like a bell.
const COLLISION_RATIOS = [1, 1.83, 2.71, 4.09];

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
  let noiseBuf = null;
  const osc = new Array(PARTIALS).fill(null);
  const partialGain = new Array(PARTIALS).fill(null);
  const noiseSrc = [null, null, null];
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

  // Traffic slot bookkeeping. `slotKey` is whatever identity the caller gave a
  // car; when it changes the doppler estimate is thrown away rather than
  // producing a pitch jump from a distance that belongs to a different car.
  // Impact voices are rationed by when each one finishes rather than by a
  // counter that onended decrements: a context suspended mid-ring never fires
  // onended at all, and a counter that can only go up would silence every
  // collision for the rest of the session.
  const collisionEnds = new Float64Array(MAX_COLLISIONS);

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
    const speed = Math.max(0, state.speed || 0);
    const airborne = !!state.airborne;

    sRpmN = approach(sRpmN, rpmN, dt, 0.020);
    sThrottle = approach(sThrottle, throttle, dt, 0.045);
    sLoad = approach(sLoad, load, dt, 0.070);
    sSpeed = approach(sSpeed, speed, dt, 0.080);
    sRain = approach(sRain, clamp(state.rainIntensity || 0, 0, 1), dt, 0.60);
    sSlip = approach(sSlip, clamp(state.slipping || 0, 0, 1), dt, 0.055);
    wobble = (wobble + dt) % 1000;

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
    for (let i = 0; i < PARTIALS; i++) ramp(osc[i].frequency, hz(f0 * prof.mul[i]), 0.010);
    ramp(engineLP.frequency, hz(prof.cutHz + sRpmN * prof.cutRpm + drive * prof.cutDrive), 0.020);
    ramp(enginePeak.frequency, hz(f0 * prof.peakMul), 0.020);
    // Harder into the soft clipper on load: the grit is the throttle response.
    ramp(engineDrive.gain, 1 + prof.drive * 5.5 * Math.pow(drive, 1.4), 0.030);
    const tone = prof.level * (prof.idle + (1 - prof.idle) * drive)
      * (0.55 + 0.45 * sRpmN) * shiftDuck * limitCut
      / (1 + prof.drive * 2.2 * drive);
    ramp(engineTone.gain, tone, 0.020);

    // ---- intake whoosh ----------------------------------------------------
    ramp(intakeBP.frequency, hz(prof.intakeHz + sRpmN * prof.intakeRpmHz), 0.030);
    ramp(intakeGain.gain, prof.intake * Math.pow(sThrottle, 1.5) * (0.20 + 0.80 * sRpmN), 0.030);

    // ---- exhaust, and the rasp on overrun ---------------------------------
    // Overrun is a shut throttle at revs: unburnt mixture arriving in a hot pipe
    // is what crackles, so the crackle is gated on exactly that and nothing else.
    const overrun = clamp(1 - throttle * 3, 0, 1) * clamp((rpmN - 0.35) / 0.40, 0, 1);
    if (overrun > 0.30 && Math.random() < dt * 16 * overrun) crackle = 0.6 + Math.random() * 0.5;
    crackle *= Math.exp(-dt * 22);
    const exhaust = prof.exhaust * ((0.25 + 0.75 * sThrottle) + overrun * 0.85 + crackle * overrun);
    ramp(exhaustGain.gain, exhaust * shiftDuck, 0.015);
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
    ramp(hissBP.frequency, hz(sHissHz + speedN * 500), 0.040);
    ramp(hissGain.gain, contact * sHiss * Math.pow(speedN, 1.25) * 0.95, 0.040);
    // A slow amplitude wobble is what stops loose ground sounding like a fan.
    const rumbleMod = 1 + 0.25 * Math.sin(wobble * 11.3) * sRumble;
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

    updateTraffic(state, dt);
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

  /** A short noise burst for the impact plus an inharmonic ring for the panel
   *  work. Inharmonic is the whole trick: harmonic partials sound like a bell,
   *  ratios that do not divide sound like metal. */
  function playCollision(severity = 0.5) {
    if (!ok || !running) return;
    const s = clamp(num(severity, 0.5), 0, 1);
    const t = ctx.currentTime;

    const burstDur = 0.10 + 0.35 * s;
    const ringDur = 0.20 + 0.90 * s;

    let slot = -1;
    for (let i = 0; i < MAX_COLLISIONS; i++) if (collisionEnds[i] <= t) { slot = i; break; }
    if (slot < 0) return;
    collisionEnds[slot] = t + ringDur;

    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.30 + 0.85 * s, t + 0.004);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + burstDur);
    bg.connect(fxBus);
    // A heavier hit is duller: more mass moving, less panel ringing through.
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass'; bf.frequency.value = hz(2400 - 1500 * s); bf.Q.value = 1.2;
    bf.connect(bg);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.connect(bf);
    src.start(t, Math.random() * 2.5);
    src.stop(t + burstDur);

    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(0.10 + 0.30 * s, t + 0.006);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + ringDur);
    rg.connect(fxBus);
    const base = 620 - 280 * s;
    for (let i = 0; i < COLLISION_RATIOS.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = hz(base * COLLISION_RATIOS[i]);
      o.connect(rg);
      o.start(t);
      o.stop(t + ringDur);
      // One closure per impact, to release the little sub-graph. Allocating
      // here is fine — what must not allocate is update().
      if (i === 0) o.onended = () => { src.disconnect(); bf.disconnect(); bg.disconnect(); rg.disconnect(); };
    }
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
      master.disconnect();
      ctx.close();
    } catch { /* already torn down; nothing here is worth a crash */ }
    ctx = null;
    noiseBuf = null;
  }

  return {
    start, update,
    playCollision, playSkid, playHorn, playIndicator,
    setMuted, setVolume, setEngineProfile,
    dispose,
    get running() { return ok && running; },
  };
}
