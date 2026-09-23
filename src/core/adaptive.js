// Automatic quality: step the picture down when the frames are consistently
// slow, and back up when there is room.
//
// Pure decision-making — frame times in, a level out — with no three.js and no
// DOM, so tools/smoothcheck.mjs can run it against simulated machines. main.js
// feeds it the real frame interval and applies the level it picks.
//
// WHAT IT TOUCHES, AND WHAT IT NEVER DOES
//
// Only the two levers that cannot pop: the render resolution (the canvas stays
// the same size and the frame is scaled up, so the picture softens slightly)
// and, further down, the post-processing tier (bloom fades out over a second,
// MSAA becomes FXAA). Each step is small — 0.9 and 0.8 of the resolution are
// 81% and 64% of the pixels.
//
// It NEVER touches shadows: switching the shadow map on or off changes the
// program of every lit material in the scene, and recompiling all of them is a
// stall of hundreds of milliseconds on a fast machine — the opposite of the
// point. Nor the draw distance, which moves the fog and the horizon visibly.
// And it never goes above what the player chose, or below 'low' post: 'off'
// drops the colour grade, which changes the whole look at once.
//
// HOW IT DECIDES
//
// Frames are judged in windows of 1.5 s. A window is SLOW when its 75th
// percentile is over 19 ms — a quarter of the frames missing a 60 Hz vsync is
// judder anyone sees, and so is a variable-refresh screen running under 53
// fps — and GOOD when its 90th percentile is under 20 ms. The margins over
// 16.7 are not slack: requestAnimationFrame's own timestamps wobble, and an
// idle game in the desktop app's browser measured a median of 16.6 ms but a
// 90th percentile of 18.3. Percentiles, not the mean, so a single streaming
// hitch or shader compile never counts as slow, and a window with a few of
// them still counts as good.
//
//   down  after two slow windows in a row (one if the median is under 33 fps,
//         and then two levels at once): a slow machine gets there in seconds.
//   up    after a run of good windows — four to begin with (6 s). That step up
//         is a probe: if it turns slow within three windows, it steps back and
//         the run needed next time doubles (to a cap of ~3 minutes), so a
//         machine on the edge settles instead of flickering between levels.
//
// With GPU timing (effects.gpuMs), it knows more. A frame that is slow while
// the GPU is idle for half of it is not waiting on pixels, and fewer pixels
// would only blur it, so it holds. And it predicts what the next level up would
// cost; with room to spare it returns after one good window, without room it
// does not probe at all. Without GPU timing it learns the same thing the slow
// way: if the whole ladder bought less than 10% it was never the pixels, and it
// goes back to full quality and leaves it for a minute.

/** Every rung: resolution scale, and how many post tiers below the player's. */
export const LADDER = [
  { scale: 1.00, drop: 0 },
  { scale: 0.90, drop: 0 },
  { scale: 0.80, drop: 0 },
  { scale: 0.80, drop: 1 },
  { scale: 0.70, drop: 1 },
  { scale: 0.70, drop: 2 },
  { scale: 0.60, drop: 2 },
];

const POST_ORDER = ['off', 'low', 'medium', 'high'];

/** The post tier `drop` steps below `chosen`, never below 'low', never above `chosen`. */
export function postFor(chosen, drop) {
  const i = POST_ORDER.indexOf(chosen);
  if (i <= 1) return chosen;                 // 'off', 'low' or unknown: leave it be
  return POST_ORDER[Math.max(1, i - drop)];
}

// GPU cost of a post tier relative to 'medium', for predicting a step up.
// Timer queries at 3840x2160 on an M2 Max, where the frame is bound by pixels
// the way an integrated GPU is at 1080p — median of 24 frames at each of five
// resolution scales: high (MSAA scene pass, full-resolution bloom) 1.54-1.84x
// medium, low (no bloom, no FXAA) 0.50-0.82x. 'off' is never compared with
// anything but itself (the ladder never drops to it), so its figure is moot.
const POST_COST = { off: 0.6, low: 0.65, medium: 1, high: 1.65 };

/**
 * The rungs that actually differ for a player on post tier `chosen`: a player
 * already on 'low' has no post tier to drop, so those rungs collapse into the
 * resolution steps.
 */
export function ladderFor(chosen) {
  const out = [];
  for (const r of LADDER) {
    const post = postFor(chosen, r.drop);
    const last = out[out.length - 1];
    if (last && last.scale === r.scale && last.post === post) continue;
    out.push({ scale: r.scale, post });
  }
  return out;
}

const DEFAULTS = {
  budgetMs: 1000 / 60,
  windowSec: 1.5,
  minFrames: 20,       // so a 14 fps machine's windows are not stretched to 2 s
  slowMs: 19,          // p75 above this: slow
  verySlowMs: 30.3,    // median above this (under 33 fps): very slow
  goodMs: 20,          // p90 at or below this: good
  warmupSec: 2,        // after start: shaders, streaming, the first GC
  settleSec: 0.75,     // after a change: the resize itself costs a frame
  probeWindows: 4,     // good windows before the first step up
  maxProbeWindows: 128,
  headroom: 0.8,       // with GPU timing, step up only if predicted < 80% of budget
  cpuBoundHoldSec: 60,
  maxGapMs: 250,       // a longer frame is a paused tab, not a slow machine
};

/**
 * @param {object} [opts]  post: the player's post tier; level: where to start
 *                         (a level remembered from last time); plus any of
 *                         DEFAULTS to override.
 */
export function createAdaptiveQuality(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let rungs = ladderFor(opts.post || 'medium');
  let level = clampLevel(opts.level | 0);

  // One window of frame intervals, sorted in place when it closes.
  const buf = new Float64Array(1024);
  let n = 0, windowMs = 0;
  let ignoreMs = cfg.warmupSec * 1000;

  let slowStreak = 0, goodStreak = 0;
  let probeNeed = cfg.probeWindows;
  let sinceUp = Infinity;          // windows since the last step up (a probe)
  let baselineP50 = NaN;           // median when the stepping down began
  let blindAtBottom = 0;           // slow windows at the bottom with no baseline
  let holdMs = 0;                  // cpu-bound: no stepping down until this runs out
  let holdNext = cfg.cpuBoundHoldSec * 1000;   // ...and it doubles every time
  let changes = 0;
  const last = { p50: NaN, p75: NaN, p90: NaN, gpuMs: NaN, verdict: 'warming up' };

  function clampLevel(l) { return Math.max(0, Math.min(rungs.length - 1, l)); }

  function setLevel(l, why) {
    const next = clampLevel(l);
    if (next === level) return false;
    level = next;
    changes++;
    last.verdict = why;
    ignoreMs = cfg.settleSec * 1000;
    n = 0; windowMs = 0;
    return true;
  }

  // Doubling, so a machine that is slow for reasons the picture cannot fix
  // (a busy CPU, a 50 Hz screen) is left alone for longer each time rather
  // than blurred and restored once a minute.
  function hold() {
    holdMs = holdNext;
    holdNext = Math.min(holdNext * 2, 16 * cfg.cpuBoundHoldSec * 1000);
  }

  function pct(sorted, count, p) {
    return sorted[Math.min(count - 1, Math.floor(p * count))];
  }

  /** Predicted GPU ms one rung up from here, from the measured GPU time. */
  function predictUp(gpuMs) {
    if (!(gpuMs > 0) || level === 0) return NaN;
    const a = rungs[level], b = rungs[level - 1];
    const px = (b.scale * b.scale) / (a.scale * a.scale);
    const post = (POST_COST[b.post] || 1) / (POST_COST[a.post] || 1);
    return gpuMs * px * post;
  }

  function judge(gpuMs) {
    const w = buf.subarray(0, n).sort();
    const p50 = pct(w, n, 0.5), p75 = pct(w, n, 0.75), p90 = pct(w, n, 0.9);
    last.p50 = p50; last.p75 = p75; last.p90 = p90; last.gpuMs = gpuMs;
    n = 0; windowMs = 0;

    const slow = p75 > cfg.slowMs;
    const verySlow = p50 > cfg.verySlowMs;
    const good = p90 <= cfg.goodMs;
    sinceUp++;

    if (slow) {
      goodStreak = 0;
      slowStreak++;
      // A probe that made things slow goes straight back, and the next one
      // has to wait twice as long.
      if (sinceUp <= 3) {
        probeNeed = Math.min(cfg.maxProbeWindows, probeNeed * 2);
        sinceUp = Infinity;
        slowStreak = 0;
        return setLevel(level + 1, 'probe failed');
      }
      if (holdMs > 0) { last.verdict = 'slow, but not the pixels'; return false; }
      if (slowStreak < 2 && !verySlow) { last.verdict = 'slow (once)'; return false; }
      // The GPU is idle for half the frame: fewer pixels will not help.
      if (gpuMs > 0 && gpuMs < 0.5 * p50) {
        hold();
        last.verdict = 'slow, but not the pixels';
        return false;
      }
      if (level >= rungs.length - 1) {
        // Bottom of the ladder and still slow. If the whole ladder bought
        // less than 10%, it was never the pixels: give the picture back.
        if (level > 0 && p50 > 0.9 * baselineP50) {
          hold();
          baselineP50 = NaN;
          return setLevel(0, 'slow, but not the pixels');
        }
        // Started down here (a level remembered from last time) and never
        // measured the top, so there is nothing to compare with. Without that,
        // a CPU-bound machine would stay blurred for good — and remember it.
        // Go and look once: from the top it either comes straight back down
        // with a baseline, or finds the pixels were never the problem.
        if (!Number.isFinite(baselineP50) && ++blindAtBottom >= 4) {
          blindAtBottom = 0;
          return setLevel(0, 're-checking the top');
        }
        last.verdict = 'slow at the lowest level';
        return false;
      }
      if (level === 0 || !Number.isFinite(baselineP50)) baselineP50 = p50;
      slowStreak = 0;
      return setLevel(level + (verySlow ? 2 : 1), verySlow ? 'very slow' : 'slow');
    }

    slowStreak = 0;
    if (sinceUp === 4) probeNeed = Math.max(cfg.probeWindows, probeNeed >> 1);   // a probe that held
    if (!good) { goodStreak = 0; last.verdict = 'holding'; return false; }
    goodStreak++;
    if (level === 0) { last.verdict = 'full quality'; baselineP50 = NaN; return false; }

    const predicted = predictUp(gpuMs);
    let need = probeNeed;
    if (predicted > 0) {
      if (predicted > cfg.headroom * cfg.budgetMs) { last.verdict = 'good, no room above'; return false; }
      if (predicted < 0.6 * cfg.budgetMs) need = 1;
    }
    if (goodStreak < need) { last.verdict = 'good'; return false; }
    goodStreak = 0;
    sinceUp = 0;
    return setLevel(level - 1, 'room to spare');
  }

  /**
   * One frame. `frameMs` is the time since the previous frame; `gpuMs` the
   * GPU's time for a frame if known. Returns true when the level changed.
   */
  function sample(frameMs, gpuMs) {
    if (!(frameMs > 0)) return false;
    if (frameMs > cfg.maxGapMs) { n = 0; windowMs = 0; return false; }
    if (holdMs > 0) holdMs -= frameMs;
    if (ignoreMs > 0) { ignoreMs -= frameMs; return false; }
    if (n < buf.length) buf[n++] = frameMs;
    windowMs += frameMs;
    if (windowMs < cfg.windowSec * 1000 || n < cfg.minFrames) return false;
    return judge(gpuMs);
  }

  /** The player changed the post tier: new ladder, back to the top of it. */
  function reset(post, startLevel = 0) {
    rungs = ladderFor(post || 'medium');
    level = clampLevel(startLevel | 0);
    n = 0; windowMs = 0;
    ignoreMs = cfg.warmupSec * 1000;
    slowStreak = 0; goodStreak = 0;
    probeNeed = cfg.probeWindows; sinceUp = Infinity;
    baselineP50 = NaN; holdMs = 0; holdNext = cfg.cpuBoundHoldSec * 1000;
    blindAtBottom = 0;
    last.verdict = 'warming up';
  }

  return {
    sample, reset,
    /** Force a level, for testing from the console. */
    force: (l) => setLevel(l, 'forced'),
    get level() { return level; },
    get levels() { return rungs.length; },
    get rung() { return rungs[level]; },
    get changes() { return changes; },
    get stats() { return last; },
  };
}
