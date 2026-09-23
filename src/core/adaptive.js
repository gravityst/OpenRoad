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
// 81% and 64% of the pixels — on ANY screen: the scale is always a fraction of
// the pixel ratio of the tier the player chose (applyRung below), so dropping
// the post tier never cuts the resolution as well. See effects.js.
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
// A SCREEN THAT IS NOT 60 Hz
//
// Those thresholds are for a 60 Hz target. A 50 Hz screen shows a frame every
// 20 ms, and Safari's Low Power Mode (Macs on battery, iPads) holds every page
// to 30 fps, so on those EVERY window used to be slow, whatever the picture
// cost: simulated over 10 minutes with a fast GPU and no GPU timer, 24 changes
// and 13% of the time blurred at 50 Hz, 16 changes at 30 fps. main.js measures
// the display's own frame period while the game loads (createDisplayProbe) and
// the thresholds scale with it: at 20 ms a window is slow over 22.8 ms, at
// 33.3 over 38. A game running at the screen's own rate is never "slow". If a
// window ever runs clearly faster than the measured period, the measurement was
// wrong and it goes back to assuming 60 Hz.
//
// IS IT THE PIXELS?
//
// Fewer pixels only help a frame that is waiting on the GPU. Two direct
// measurements say when it is not, and in either case it holds rather than
// blurring the picture for nothing — and, if it is already below full quality,
// gives a level back:
//
//   CPU  main.js times its own frame callback. The screen shows a frame on a
//        vsync, so a frame whose script alone takes 24 ms cannot come round in
//        less than 2 x 16.7 = 33.3 ms however few pixels it draws. If the
//        frames are already that fast, the CPU is the limit. Every browser can
//        measure this.
//   GPU  with a GPU timer (effects.gpuMs; Chrome has one, Safari and Firefox
//        do not), a frame that is slow while the GPU is idle for half of it is
//        not waiting on pixels. And it predicts what the next level up would
//        cost: with room to spare it returns after one good window, without
//        room it does not probe at all.
//
// With neither (a machine slowed by something outside the page), it learns
// the slow way: if the whole ladder bought less than 10% it was never the
// pixels, it goes back to where it started, and it does not try again until
// the frame rate itself changes — the same slow frames are the same answer.
// It used to retry after 60, 120 and 240 s, walking the whole ladder down and
// snapping back each time.

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

// On a screen with more than about 1.17 device pixels per CSS pixel (a 125%
// Windows laptop, any HiDPI Mac) the bottom rung above still draws 0.6 x 1.5 =
// 0.9 device pixels per CSS pixel on 'medium' — more than a whole
// standard-density screen's worth at full quality. One more step lets a slow
// HiDPI laptop get down to where a slow ordinary one does.
// (0.6 x 1.17 = 0.7: past that, the bottom rung is sharper than it needs to be.)
const HIDPI_FLOOR = { scale: 0.5, above: 1.17 };

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
 * resolution steps. `dpr` is the device pixels per CSS pixel that tier draws
 * at full scale (effects.basePixelRatio); above HIDPI_FLOOR.above there is one
 * more rung at the bottom.
 */
export function ladderFor(chosen, dpr = 1) {
  const out = [];
  for (const r of LADDER) {
    const post = postFor(chosen, r.drop);
    const last = out[out.length - 1];
    if (last && last.scale === r.scale && last.post === post) continue;
    out.push({ scale: r.scale, post });
  }
  if (dpr > HIDPI_FLOOR.above) out.push({ scale: HIDPI_FLOOR.scale, post: out[out.length - 1].post });
  return out;
}

/**
 * Put a rung on the post-processing: the tier, and the resolution as a
 * fraction of the pixel ratio of the tier the player CHOSE, not of the rung's
 * own tier. main.js and the harness both go through this, so the machine the
 * harness simulates is lit the way the game is.
 */
export function applyRung(effects, rung, chosen) {
  if (effects.setResolutionScale) effects.setResolutionScale(rung.scale, chosen);
  effects.setQuality(rung.post);
}

const DEFAULTS = {
  budgetMs: 1000 / 60,
  windowSec: 1.5,
  minFrames: 20,       // so a 14 fps machine's windows are not stretched to 2 s
  slowMs: 19,          // p75 above this: slow (scaled by a slower display)
  verySlowMs: 30.3,    // median above this (under 33 fps): very slow
  goodMs: 20,          // p90 at or below this: good
  warmupSec: 2,        // after start: shaders, streaming, the first GC
  settleSec: 0.75,     // after a change: the resize itself costs a frame
  probeWindows: 4,     // good windows before the first step up
  maxProbeWindows: 128,
  headroom: 0.8,       // with GPU timing, step up only if predicted < 80% of budget
  cpuBoundHoldSec: 60,
  maxGapMs: 250,       // a longer frame is a paused tab, not a slow machine
  sameSlow: 0.15,      // a slow median within 15% of a known answer is that answer
};

/**
 * @param {object} [opts]  post: the player's post tier; level: where to start
 *                         (a level remembered from last time); dpr: that
 *                         tier's pixel ratio (for ladderFor); displayMs: the
 *                         screen's frame period if known; plus any of DEFAULTS.
 */
export function createAdaptiveQuality(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let dpr = opts.dpr > 0 ? opts.dpr : 1;
  let rungs = ladderFor(opts.post || 'medium', dpr);
  let level = clampLevel(opts.level | 0);
  let displayMs = validPeriod(opts.displayMs);

  // One window of frame intervals, and of the script time of those frames,
  // each sorted in place when it closes.
  const buf = new Float64Array(1024);
  const cpuBuf = new Float64Array(1024);
  let n = 0, cpuN = 0, windowMs = 0;
  let ignoreMs = cfg.warmupSec * 1000;

  let slowStreak = 0, goodStreak = 0, idleStreak = 0;
  let probeNeed = cfg.probeWindows;
  let sinceUp = Infinity;          // windows since the last step up (a probe)
  let probeP50 = NaN;              // median before a probe made while slow
  let baselineP50 = NaN;           // median when the stepping down began...
  let descentFrom = 0;             // ...and the level it began at
  let notPixelsP50 = NaN;          // median the whole ladder once failed to move...
  let notPixelsLevel = 0;          // ...from this level
  let blockedLevel = -1;           // a level given back while slow that made it slower...
  let blockedP50 = NaN;            // ...when the frames were this slow
  let blindAtBottom = 0;          // slow windows at the bottom with no baseline
  let holdMs = 0;                  // cpu-bound: no stepping down until this runs out
  let holdNext = cfg.cpuBoundHoldSec * 1000;   // ...and it doubles every time
  let changes = 0;
  const last = { p50: NaN, p75: NaN, p90: NaN, gpuMs: NaN, cpuMs: NaN, displayMs, verdict: 'warming up' };

  function clampLevel(l) { return Math.max(0, Math.min(rungs.length - 1, l)); }

  function setLevel(l, why) {
    const next = clampLevel(l);
    if (next === level) return false;
    level = next;
    changes++;
    last.verdict = why;
    ignoreMs = cfg.settleSec * 1000;
    n = 0; cpuN = 0; windowMs = 0;
    return true;
  }

  // Doubling, so a machine that is slow for reasons the picture cannot fix
  // is left alone for longer each time rather than blurred and restored once
  // a minute.
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

  /** Step up. `fromP50` NaN: the frames were good; else how slow they were. */
  function probeUp(fromP50, why) {
    goodStreak = 0; idleStreak = 0;
    sinceUp = 0;
    probeP50 = fromP50;
    return setLevel(level - 1, why);
  }

  function judge(gpuMs) {
    const w = buf.subarray(0, n).sort();
    const p25 = pct(w, n, 0.25), p50 = pct(w, n, 0.5), p75 = pct(w, n, 0.75), p90 = pct(w, n, 0.9);
    // Script time is only trusted when most of the window's frames had one.
    const cpu50 = cpuN >= n >> 1 ? pct(cpuBuf.subarray(0, cpuN).sort(), cpuN, 0.5) : NaN;
    last.p50 = p50; last.p75 = p75; last.p90 = p90; last.gpuMs = gpuMs; last.cpuMs = cpu50;
    n = 0; cpuN = 0; windowMs = 0;

    // A quarter of the frames came faster than the screen supposedly can:
    // the measured period was wrong, so go back to assuming 60 Hz.
    if (displayMs > 0 && p25 < 0.85 * displayMs) displayMs = NaN;
    last.displayMs = displayMs;
    const k = displayMs > cfg.budgetMs ? displayMs / cfg.budgetMs : 1;
    const vsync = displayMs > 0 ? displayMs : cfg.budgetMs;

    const slow = p75 > cfg.slowMs * k;
    const verySlow = p50 > cfg.verySlowMs * k;
    const good = p90 <= cfg.goodMs * k;
    sinceUp++;

    if (slow) {
      goodStreak = 0;
      // A probe that made things slower goes straight back, and the next one
      // has to wait twice as long. A probe made from good frames fails on any
      // slow window; one made from slow frames (a level given back because
      // the pixels were not the problem) only if the frames got slower.
      if (sinceUp <= 3 && (!(probeP50 > 0) || p50 > probeP50 * 1.08 + 0.5)) {
        probeNeed = Math.min(cfg.maxProbeWindows, probeNeed * 2);
        // A level given back while slow that made it slower stays out of
        // bounds while the frames are this slow, or it would be tried again
        // every few seconds.
        if (probeP50 > 0) { blockedLevel = level; blockedP50 = probeP50; }
        sinceUp = Infinity;
        slowStreak = 0;
        return setLevel(level + 1, 'probe failed');
      }

      // Not the pixels, measured: the script alone fills the frame (rounded
      // up to the vsync it can make), or the GPU is idle for half of it.
      const cpuBound = cpu50 > 0 && p50 <= Math.ceil(cpu50 * 1.05 / vsync) * vsync + 1.5;
      const gpuIdle = gpuMs > 0 && gpuMs < 0.5 * p50;
      if (cpuBound || gpuIdle) {
        slowStreak = 0;
        if (gpuIdle && holdMs <= 0) hold();
        last.verdict = cpuBound ? 'slow, but it is the CPU' : 'slow, but not the pixels';
        // Below full quality for nothing: give a level back, if the GPU (when
        // it can be timed) would still fit inside the frame the CPU sets, and
        // it has not already been tried at this speed and found slower.
        const blocked = level - 1 <= blockedLevel && Math.abs(p50 - blockedP50) <= cfg.sameSlow * blockedP50;
        if (level > 0 && !blocked && ++idleStreak >= 2) {
          const pred = predictUp(gpuMs);
          if (!(pred > 0) || pred < 0.8 * p50) return probeUp(p50, 'not the pixels: sharper again');
        }
        return false;
      }
      idleStreak = 0;
      if (holdMs > 0) { last.verdict = 'slow, but not the pixels'; return false; }
      if (++slowStreak < 2 && !verySlow) { last.verdict = 'slow (once)'; return false; }
      slowStreak = 0;

      // Slow in the same way as when the whole ladder was last tried from
      // here and bought nothing: that answer still stands.
      if (level === notPixelsLevel && Math.abs(p50 - notPixelsP50) <= cfg.sameSlow * notPixelsP50) {
        last.verdict = 'slow, but not the pixels (as before)';
        return false;
      }
      if (level >= rungs.length - 1) {
        // Bottom of the ladder and still slow. If the whole ladder bought
        // less than 10%, it was never the pixels: give the picture back.
        if (level > descentFrom && p50 > 0.9 * baselineP50) {
          hold();
          notPixelsP50 = baselineP50;
          notPixelsLevel = descentFrom;
          baselineP50 = NaN;
          return setLevel(descentFrom, 'slow, but not the pixels');
        }
        // Started down here (a level remembered from last time) and never
        // measured the top, so there is nothing to compare with. Without that,
        // a machine slow for other reasons would stay blurred for good — and
        // remember it. Go and look once: from the top it either comes
        // straight back down with a baseline, or finds the pixels were never
        // the problem.
        if (!Number.isFinite(baselineP50) && ++blindAtBottom >= 4) {
          blindAtBottom = 0;
          return setLevel(0, 're-checking the top');
        }
        last.verdict = 'slow at the lowest level';
        return false;
      }
      if (!Number.isFinite(baselineP50)) { baselineP50 = p50; descentFrom = level; }
      return setLevel(level + (verySlow ? 2 : 1), verySlow ? 'very slow' : 'slow');
    }

    slowStreak = 0; idleStreak = 0;
    if (sinceUp === 4) probeNeed = Math.max(cfg.probeWindows, probeNeed >> 1);   // a probe that held
    if (!good) { goodStreak = 0; last.verdict = 'holding'; return false; }
    goodStreak++;
    // Good frames: whatever was learned about being slow is out of date.
    baselineP50 = NaN; blockedLevel = -1;
    if (level === 0) { last.verdict = 'full quality'; return false; }

    const predicted = predictUp(gpuMs);
    let need = probeNeed;
    if (predicted > 0) {
      if (predicted > cfg.headroom * cfg.budgetMs * k) { last.verdict = 'good, no room above'; return false; }
      if (predicted < 0.6 * cfg.budgetMs * k) need = 1;
    }
    if (goodStreak < need) { last.verdict = 'good'; return false; }
    return probeUp(NaN, 'room to spare');
  }

  /**
   * One frame. `frameMs` is the time since the previous frame; `gpuMs` the
   * GPU's time for a frame if known; `cpuMs` how long the page's own script
   * took for the frame that interval contained, if known. Returns true when
   * the level changed.
   */
  function sample(frameMs, gpuMs, cpuMs) {
    if (!(frameMs > 0)) return false;
    if (frameMs > cfg.maxGapMs) { n = 0; cpuN = 0; windowMs = 0; return false; }
    if (holdMs > 0) holdMs -= frameMs;
    if (ignoreMs > 0) { ignoreMs -= frameMs; return false; }
    if (n < buf.length) buf[n++] = frameMs;
    if (cpuMs > 0 && cpuN < cpuBuf.length) cpuBuf[cpuN++] = cpuMs;
    windowMs += frameMs;
    if (windowMs < cfg.windowSec * 1000 || n < cfg.minFrames) return false;
    return judge(gpuMs);
  }

  /** The player changed the post tier: new ladder, back to the top of it. */
  function reset(post, startLevel = 0, pixelRatio = dpr) {
    dpr = pixelRatio > 0 ? pixelRatio : 1;
    rungs = ladderFor(post || 'medium', dpr);
    level = clampLevel(startLevel | 0);
    n = 0; cpuN = 0; windowMs = 0;
    ignoreMs = cfg.warmupSec * 1000;
    slowStreak = 0; goodStreak = 0; idleStreak = 0;
    probeNeed = cfg.probeWindows; sinceUp = Infinity; probeP50 = NaN;
    baselineP50 = NaN; descentFrom = 0; notPixelsP50 = NaN; notPixelsLevel = 0;
    blockedLevel = -1; blockedP50 = NaN;
    holdMs = 0; holdNext = cfg.cpuBoundHoldSec * 1000;
    blindAtBottom = 0;
    last.verdict = 'warming up';
  }

  return {
    sample, reset,
    /** The screen's frame period in ms, from createDisplayProbe; NaN: assume 60 Hz. */
    setDisplayPeriod: (ms) => { displayMs = validPeriod(ms); last.displayMs = displayMs; },
    /** Force a level, for testing from the console. */
    force: (l) => setLevel(l, 'forced'),
    get level() { return level; },
    get levels() { return rungs.length; },
    get rung() { return rungs[level]; },
    get changes() { return changes; },
    get stats() { return last; },
  };
}

// 4 ms is a 240 Hz screen; 34 ms a 30 fps cap with a millisecond of slack.
// Anything outside that is a measurement gone wrong, and 60 Hz is assumed.
function validPeriod(ms) {
  return ms >= 4 && ms <= 34 ? ms : NaN;
}

/**
 * The display's frame period, measured while the game loads.
 *
 * requestAnimationFrame runs once per screen refresh whenever the page is not
 * busy, and the loading screen is the one time the page is mostly idle while
 * visible. Loading work can only make an interval LONGER — a whole number of
 * refreshes longer — never shorter, so the period is the shortest interval
 * that turns up often: the cluster at the 10th percentile. Intervals over
 * 40 ms are dropped outright. Fewer than 24 samples, or no real cluster there
 * (a tenth of them within 12% of each other), and the answer is "unknown":
 * the game assumes 60 Hz exactly as it always did. `raf` is
 * requestAnimationFrame (a parameter so the harness can drive it). stop()
 * ends it and returns the period in ms, or NaN.
 */
export function createDisplayProbe(raf) {
  const got = new Float64Array(240);
  let count = 0, prev = NaN, running = typeof raf === 'function';
  function tick(now) {
    if (!running) return;
    const d = now - prev;
    prev = now;
    if (d > 3 && d < 40 && count < got.length) got[count++] = d;
    if (count < got.length) raf(tick); else running = false;
  }
  if (running) raf(tick);
  return {
    get samples() { return count; },
    stop() {
      running = false;
      return estimateDisplayPeriod(got, count);
    },
  };
}

/** The shortest common frame interval, or NaN if there is none to be sure of. */
export function estimateDisplayPeriod(intervals, count) {
  if (!(count >= 24)) return NaN;
  const s = intervals.slice(0, count).sort();
  const lo = s[Math.floor(count * 0.1)];
  // The cluster round it, and its middle: rAF timestamps wobble either way.
  let a = 0, b = count;
  while (a < count && s[a] < lo * 0.88) a++;
  while (b > a && s[b - 1] > lo * 1.12) b--;
  if (b - a < Math.max(8, count * 0.1)) return NaN;
  return validPeriod(s[(a + b) >> 1]);
}
