// What the player has earned, kept between visits.
//
// One localStorage key, 'openroad.progress.v1', holding cash, XP, the cars
// bought, the best result and medal per challenge, the tokens found and a few
// one-shot flags (has the player seen the controls card yet). Deliberately
// separate from openroad.settings.v1: "Restore defaults" in the settings screen
// should never cost a kid the car they saved up for.
//
// THE ECONOMY IS SIZED TO THE WORLD. Every medal pays the DIFFERENCE over the
// medal already held (see REWARDS in challenges.js), so the total on offer is
// fixed: 8 races, 6 traps, 4 jumps and 4 drift zones at gold plus 50 tokens is
// $26,200. The garage below costs $21,000 in full, so a player who golds
// everything can own everything with some to spare, and one who takes bronze on
// the first race and picks up a token or two ($600 in about three minutes) can
// already afford the first upgrade. Three cars are free, so nobody starts with
// a choice of one.
//
// EVERYTHING LOADED IS VALIDATED. A save is data a kid can edit in devtools,
// and data an older build wrote; a NaN in `cash` would otherwise render as
// "$NaN" forever. Anything malformed falls back to the default for that field
// rather than throwing the whole save away.

import { MEDAL_NONE, MEDAL_GOLD, REWARDS } from './challenges.js';

export const PROGRESS_KEY = 'openroad.progress.v1';

/** Prices by car id. Absent ids fall back to their class price below. */
export const CAR_PRICES = {
  kaida2: 0, lark: 0, drover: 0,
  haulier: 400, scout: 650, bastion: 800, kaze: 1000, kaida: 1200,
  v340: 1450, ridgeback: 1600, lupo: 1900, meridian: 2250, rs200: 2550,
  corsara: 3200, arc: 4000,
};
// A car added to the catalogue later, without a price here, still gets one.
const CLASS_PRICE = { city: 0, utility: 500, offroad: 1200, sport: 1800, luxury: 2000, super: 3500 };

/** XP needed to REACH level n (level 1 is free). */
export function xpForLevel(n) { return n <= 1 ? 0 : 100 * n * (n - 1); }

/** Level, and how far into it, for an XP total. */
export function levelFor(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 99) level++;
  const lo = xpForLevel(level), hi = xpForLevel(level + 1);
  return { level, into: xp - lo, need: hi - lo, frac: (xp - lo) / Math.max(1, hi - lo) };
}

function defaults() {
  return {
    v: 1,
    cash: 0,
    xp: 0,
    owned: [],
    results: {},
    tokens: [],
    flags: {},
    stats: { races: 0, finishes: 0, tokens: 0, jumps: 0, bestJump: 0, topSpeed: 0 },
  };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Cleans a parsed save into the current shape. Never throws. */
export function sanitize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  out.cash = Math.max(0, Math.floor(num(raw.cash)));
  out.xp = Math.max(0, Math.floor(num(raw.xp)));
  if (Array.isArray(raw.owned)) out.owned = raw.owned.filter((s) => typeof s === 'string').slice(0, 64);
  if (raw.results && typeof raw.results === 'object') {
    for (const id of Object.keys(raw.results).slice(0, 256)) {
      const r = raw.results[id];
      if (!r || typeof r !== 'object') continue;
      const best = num(r.best, NaN);
      if (!Number.isFinite(best)) continue;
      const medal = Math.max(MEDAL_NONE, Math.min(MEDAL_GOLD, Math.floor(num(r.medal))));
      const rec = { best, medal };
      if (Array.isArray(r.splits)) rec.splits = r.splits.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice(0, 16);
      out.results[id] = rec;
    }
  }
  if (Array.isArray(raw.tokens)) {
    const seen = new Set();
    for (const t of raw.tokens) if (Number.isInteger(t) && t >= 0 && t < 4096) seen.add(t);
    out.tokens = [...seen].sort((a, b) => a - b);
  }
  if (raw.flags && typeof raw.flags === 'object') {
    for (const k of Object.keys(raw.flags).slice(0, 64)) if (raw.flags[k] === true) out.flags[k] = true;
  }
  if (raw.stats && typeof raw.stats === 'object') {
    for (const k of Object.keys(out.stats)) out.stats[k] = Math.max(0, num(raw.stats[k], out.stats[k]));
  }
  return out;
}

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * opts.storage   anything with getItem/setItem (default: localStorage, which
 *                can be missing or throw in private browsing — then progress
 *                simply lasts the session)
 * opts.cars      the catalogue, for class-based prices
 * opts.grant     car ids to own from the start, e.g. the car a returning
 *                player already drives — nobody loses a car to this update.
 *                A MIGRATION, applied once: only when there is no readable
 *                save yet, and written straight away. Once a save exists
 *                every car in it was free or bought, so a grant must never
 *                add one — above all after "Start over", when the car still
 *                named in the settings is the one the player just gave up.
 */
export function createProgress(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : browserStorage();
  const cars = opts.cars || [];
  const classOf = Object.fromEntries(cars.map((c) => [c.id, c.class]));
  const listeners = new Set();
  let data = load(opts.grant || []);

  function load(grant) {
    let raw = null;
    try { raw = storage ? storage.getItem(PROGRESS_KEY) : null; } catch { raw = null; }
    let parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
    const d = sanitize(parsed);
    for (const id of Object.keys(CAR_PRICES)) if (CAR_PRICES[id] === 0 && !d.owned.includes(id)) d.owned.push(id);
    for (const c of cars) if (priceOf(c.id) === 0 && !d.owned.includes(c.id)) d.owned.push(c.id);
    if (!parsed && grant) {
      let granted = false;
      for (const id of grant) if (id && !d.owned.includes(id)) { d.owned.push(id); granted = true; }
      // Kept at once: unsaved, it would be granted again next visit from
      // whatever car the settings name by then, and this one lost.
      if (granted) { try { if (storage) storage.setItem(PROGRESS_KEY, JSON.stringify(d)); } catch { /* private mode */ } }
    }
    return d;
  }

  function save() {
    try { if (storage) storage.setItem(PROGRESS_KEY, JSON.stringify(data)); } catch { /* quota or private mode */ }
    for (const fn of listeners) { try { fn(api); } catch (err) { console.error('[progress] listener failed', err); } }
  }

  function priceOf(id) {
    if (CAR_PRICES[id] != null) return CAR_PRICES[id];
    const cls = classOf[id];
    return cls && CLASS_PRICE[cls] != null ? CLASS_PRICE[cls] : 1500;
  }

  /**
   * Records an attempt. Lower is better for races, higher for everything else.
   * Returns what changed, so the UI can say "NEW BEST" and count the money up.
   */
  function record(ch, score, medal, splits) {
    const prev = data.results[ch.id] || null;
    const lowerBetter = ch.kind === 'race';
    const prevBest = prev ? prev.best : null;
    const prevMedal = prev ? prev.medal : MEDAL_NONE;
    const newBest = prevBest == null || (lowerBetter ? score < prevBest : score > prevBest);
    const m = Math.max(prevMedal, medal | 0);
    const table = REWARDS[ch.kind] || REWARDS.race;
    const cash = Math.max(0, table.cash[m] - table.cash[prevMedal]);
    const xp = Math.max(0, table.xp[m] - table.xp[prevMedal]);
    const levelBefore = levelFor(data.xp).level;
    data.cash += cash;
    data.xp += xp;
    const rec = { best: newBest ? score : prevBest, medal: m };
    if (newBest && splits) rec.splits = splits.slice(0, 16);
    else if (prev && prev.splits) rec.splits = prev.splits;
    data.results[ch.id] = rec;
    if (ch.kind === 'race') { data.stats.finishes++; }
    if (ch.kind === 'jump') { data.stats.jumps++; data.stats.bestJump = Math.max(data.stats.bestJump, score); }
    if (ch.kind === 'trap') data.stats.topSpeed = Math.max(data.stats.topSpeed, score);
    const levelAfter = levelFor(data.xp).level;
    save();
    return {
      medal: medal | 0, held: m, prevMedal, prevBest, newBest, cash, xp,
      levelUp: levelAfter > levelBefore ? levelAfter : 0,
    };
  }

  function takeToken(i) {
    if (data.tokens.includes(i)) return null;
    data.tokens.push(i);
    data.stats.tokens = data.tokens.length;
    const levelBefore = levelFor(data.xp).level;
    data.cash += REWARDS.token.cash;
    data.xp += REWARDS.token.xp;
    const levelAfter = levelFor(data.xp).level;
    save();
    return { cash: REWARDS.token.cash, xp: REWARDS.token.xp, count: data.tokens.length, levelUp: levelAfter > levelBefore ? levelAfter : 0 };
  }

  function buy(id) {
    if (data.owned.includes(id)) return true;
    const p = priceOf(id);
    if (data.cash < p) return false;
    data.cash -= p;
    data.owned.push(id);
    save();
    return true;
  }

  function medalCounts(ids) {
    const out = { gold: 0, silver: 0, bronze: 0, total: 0 };
    for (const id of ids || Object.keys(data.results)) {
      const r = data.results[id];
      if (!r) continue;
      if (r.medal === 3) out.gold++;
      else if (r.medal === 2) out.silver++;
      else if (r.medal === 1) out.bronze++;
      if (r.medal > 0) out.total++;
    }
    return out;
  }

  const api = {
    key: PROGRESS_KEY,
    get cash() { return data.cash; },
    get xp() { return data.xp; },
    get level() { return levelFor(data.xp); },
    get tokenCount() { return data.tokens.length; },
    get data() { return data; },
    result: (id) => data.results[id] || null,
    medalOf: (id) => (data.results[id] ? data.results[id].medal : MEDAL_NONE),
    record, takeToken, buy, medalCounts,
    hasToken: (i) => data.tokens.includes(i),
    owns: (id) => data.owned.includes(id),
    price: priceOf,
    flag: (k) => data.flags[k] === true,
    setFlag(k) { if (data.flags[k] !== true) { data.flags[k] = true; save(); } },
    grant(id) { if (id && !data.owned.includes(id)) { data.owned.push(id); save(); } },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reload() { data = load(); for (const fn of listeners) fn(api); },
    /** Wipes progress. Only ever called by a person, from the settings screen. */
    reset() { try { if (storage) storage.removeItem(PROGRESS_KEY); } catch { /* ignore */ } data = load(); save(); },
    serialize: () => JSON.stringify(data),
    save,
  };
  return api;
}
