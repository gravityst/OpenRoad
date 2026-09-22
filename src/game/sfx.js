// Short game sounds: countdown beeps, checkpoint chimes, the token ping.
//
// A silent game feels broken, and a checkpoint that makes no sound is a
// checkpoint a kid does not notice passing. But the engine synth was switched
// off in main.js because it came up at the full system volume, so this module
// is built so it cannot do that:
//
//   * nothing is created until the first sound is asked for, which is always
//     after a key press — no AudioContext exists on the title screen;
//   * every sound goes through ONE master gain whose ceiling is 0.22 of full
//     scale, times the player's own volume setting, into a limiter;
//   * each sound is a few hundred milliseconds of enveloped oscillator, with
//     no sustain phase that could ever be left running.
//
// If the audio layer comes back, connect() routes these into its master bus
// instead, so the one volume slider still governs everything.

const CEILING = 0.22;

// Notes as [frequency Hz, start s, length s, type, level]. Major-key figures
// read as reward; the fail figure falls.
const SOUNDS = {
  beep:    [[660, 0, 0.16, 'square', 0.35]],
  go:      [[990, 0, 0.42, 'square', 0.42], [1320, 0, 0.42, 'sine', 0.3]],
  gate:    [[880, 0, 0.1, 'triangle', 0.6], [1320, 0.07, 0.18, 'triangle', 0.55]],
  finish:  [[523, 0, 0.14, 'triangle', 0.6], [659, 0.1, 0.14, 'triangle', 0.6], [784, 0.2, 0.14, 'triangle', 0.6], [1047, 0.3, 0.5, 'triangle', 0.65]],
  gold:    [[784, 0, 0.12, 'triangle', 0.6], [988, 0.09, 0.12, 'triangle', 0.6], [1175, 0.18, 0.12, 'triangle', 0.6], [1568, 0.27, 0.6, 'sine', 0.7], [2093, 0.36, 0.5, 'sine', 0.35]],
  medal:   [[659, 0, 0.12, 'triangle', 0.6], [880, 0.1, 0.35, 'triangle', 0.6]],
  token:   [[1175, 0, 0.07, 'sine', 0.55], [1568, 0.05, 0.07, 'sine', 0.55], [2349, 0.1, 0.22, 'sine', 0.5]],
  trap:    [[1800, 0, 0.03, 'square', 0.3], [1200, 0.05, 0.18, 'triangle', 0.5]],
  launch:  [[330, 0, 0.25, 'sawtooth', 0.18], [495, 0.02, 0.3, 'triangle', 0.3]],
  land:    [[140, 0, 0.18, 'sine', 0.6]],
  fail:    [[440, 0, 0.14, 'triangle', 0.5], [370, 0.12, 0.14, 'triangle', 0.5], [294, 0.24, 0.3, 'triangle', 0.5]],
  buy:     [[523, 0, 0.1, 'triangle', 0.6], [784, 0.08, 0.1, 'triangle', 0.6], [1047, 0.16, 0.3, 'sine', 0.6]],
  level:   [[392, 0, 0.12, 'triangle', 0.5], [523, 0.1, 0.12, 'triangle', 0.5], [659, 0.2, 0.12, 'triangle', 0.5], [784, 0.3, 0.12, 'triangle', 0.5], [1047, 0.4, 0.6, 'sine', 0.6]],
  zone:    [[587, 0, 0.12, 'triangle', 0.5], [740, 0.09, 0.2, 'triangle', 0.5]],
};

/**
 * opts.volume   () => 0..1, read at every sound, so the settings slider
 *               applies immediately
 */
export function createSfx(opts = {}) {
  const volume = typeof opts.volume === 'function' ? opts.volume : () => 0.8;
  let ctx = null, master = null, limiter = null, external = null;
  let broken = typeof window === 'undefined' ||
    (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined');

  function ensure() {
    if (broken) return false;
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = external ? external.ctx : new AC();
      master = ctx.createGain();
      master.gain.value = 0;
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      master.connect(limiter);
      limiter.connect(external ? external.destination : ctx.destination);
      return true;
    } catch (err) {
      console.warn('[sfx] unavailable:', err);
      broken = true;
      return false;
    }
  }

  function play(name) {
    const notes = SOUNDS[name];
    const v = Math.max(0, Math.min(1, Number(volume()) || 0));
    if (!notes || v <= 0.001 || !ensure()) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    const now = ctx.currentTime + 0.01;
    master.gain.setValueAtTime(CEILING * v, now);
    for (const [f, at, len, type, level] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, now + at);
      g.gain.setValueAtTime(0, now + at);
      g.gain.linearRampToValueAtTime(level, now + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0008, now + at + len);
      o.connect(g);
      g.connect(master);
      o.start(now + at);
      o.stop(now + at + len + 0.03);
    }
  }

  return {
    play,
    /** Route into another module's context and bus, e.g. the engine audio's master. */
    connect(audioCtx, destination) {
      if (!audioCtx || !destination) return;
      // Nodes cannot cross contexts, so anything built on our own context is
      // dropped and rebuilt on theirs at the next sound.
      if (ctx && !external) { try { ctx.close(); } catch { /* ignore */ } }
      ctx = null; master = null; limiter = null;
      external = { ctx: audioCtx, destination };
      broken = false;
    },
    dispose() {
      if (ctx && !external) { try { ctx.close(); } catch { /* ignore */ } }
      ctx = null; master = null; limiter = null;
    },
  };
}
