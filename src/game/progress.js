// What the player has earned, kept between visits.
//
// One localStorage key, 'openroad.progress.v1', holding cash, XP, the cars
// bought, the best result and medal per challenge, the tokens found and a few
// one-shot flags (has the player seen the controls card yet). Deliberately
// separate from openroad.settings.v1: "Restore defaults" in the settings screen
// should never cost a kid the car they saved up for.
//
// SCHEMA VERSION 2 lives under the SAME key. Round one wrote `v: 1`; this
// build adds the long game — skill-chain and driving stats, the level rewards
// paid so far, special paints and which car wears which, trophies, and today's
// three daily challenges with the streak. The key keeps its name so nobody's
// save is orphaned: an old save is read, migrated in memory (see migrate()),
// and written back as v2 the first time anything changes. A v1 player's XP is
// kept exactly; under the new level curve (career.js) that is the same or a
// higher level, and every level reward they have not been paid is paid on
// load, once, as a single "welcome back" rather than a queue of banners.
//
// THE ECONOMY. Every medal pays the DIFFERENCE over the medal already held (see
// REWARDS in challenges.js), so medals on their own are a fixed $26,200 across
// the world — enough to buy the $21,000 garage. Skill chains, dailies and level
// rewards now pay on top of that, open-ended, so there is always something to
// save up for: the paint shop (career.js PAINTS) is the sink.
//
// EVERYTHING LOADED IS VALIDATED. A save is data a kid can edit in devtools,
// and data an older build wrote; a NaN in `cash` would otherwise render as
// "$NaN" forever. Anything malformed falls back to the default for that field
// rather than throwing the whole save away.

import { MEDAL_NONE, MEDAL_GOLD, REWARDS } from './challenges.js';
import {
  xpForLevel, levelFor, levelReward, PAINTS, PAINT_BY_ID, TROPHIES, trophyTarget,
  pickDailies, localDay, parseDay, shiftDay, DAILY_BY_ID, DAILY_REWARD, DAILY_SWEEP,
} from './career.js';

// The curve moved to career.js with the rest of the long game; re-exported so
// everything that imported it from here (goals.js, the harnesses) still does.
export { xpForLevel, levelFor };

export const PROGRESS_KEY = 'openroad.progress.v1';
export const PROGRESS_VERSION = 2;

/** Prices by car id. Absent ids fall back to their class price below. */
export const CAR_PRICES = {
  kaida2: 0, lark: 0, drover: 0,
  haulier: 400, scout: 650, bastion: 800, kaze: 1000, kaida: 1200,
  v340: 1450, ridgeback: 1600, lupo: 1900, meridian: 2250, rs200: 2550,
  corsara: 3200, arc: 4000,
};
// A car added to the catalogue later, without a price here, still gets one.
const CLASS_PRICE = { city: 0, utility: 500, offroad: 1200, sport: 1800, luxury: 2000, super: 3500 };

// Round one's stats, then this round's. All non-negative numbers; sanitize()
// keeps exactly these keys.
const STAT_KEYS = [
  'races', 'finishes', 'tokens', 'jumps', 'bestJump', 'topSpeed',
  'near', 'oncoming', 'driftPts', 'driftBest', 'air', 'airBest', 'tow', 'km',
  'chains', 'chainBest', 'multBest', 'cleanBest', 'skill', 'medals', 'golds',
  'dailies', 'sweeps',
];

// Which lifetime stat a daily METRIC feeds, and how. `sum` adds, `peak` keeps
// the best. 'medals' and 'tokens' are counted where they happen (record(),
// takeToken()) and only reach the dailies through here.
const METRIC_STAT = {
  near: ['near', 'sum'], drift: ['driftPts', 'sum'], air: ['air', 'sum'],
  tow: ['tow', 'sum'], km: ['km', 'sum'],
  speed: ['topSpeed', 'peak'], chain: ['chainBest', 'peak'], mult: ['multBest', 'peak'],
  clean: ['cleanBest', 'peak'], jump: ['bestJump', 'peak'],
  medals: [null, 'sum'], tokens: [null, 'sum'],
  // Trophy-only: no daily asks for these, but "2 seconds of air in one jump"
  // and "a 5,000-point drift" are single bests, not totals.
  airBest: ['airBest', 'peak'], driftBest: ['driftBest', 'peak'],
};

function defaults() {
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = 0;
  return {
    v: PROGRESS_VERSION,
    cash: 0,
    xp: 0,
    owned: [],
    results: {},
    tokens: [],
    flags: {},
    stats,
    rewardLevel: 1,
    paints: [],
    livery: {},
    trophies: {},
    daily: { day: '', ids: [], progress: [0, 0, 0], done: [false, false, false], swept: false },
    streak: { count: 0, last: '', best: 0 },
  };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Cleans a parsed save into the current shape. Never throws.
 *
 * Reads any version. A v1 save simply lacks the v2 fields and gets their
 * defaults — except `rewardLevel`, which migrate() handles, because "no level
 * rewards paid yet" is the truth for a v1 save and must not be confused with
 * a corrupt v2 one.
 */
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
    for (const k of STAT_KEYS) out.stats[k] = Math.max(0, num(raw.stats[k], out.stats[k]));
  }

  // ---- v2 ----
  const lvl = levelFor(out.xp).level;
  out.rewardLevel = Math.max(1, Math.min(lvl, Math.floor(num(raw.rewardLevel, 1))));
  if (Array.isArray(raw.paints)) {
    out.paints = [...new Set(raw.paints.filter((p) => typeof p === 'string' && PAINT_BY_ID[p]))];
  }
  if (raw.livery && typeof raw.livery === 'object') {
    for (const car of Object.keys(raw.livery).slice(0, 64)) {
      const p = raw.livery[car];
      if (typeof p === 'string' && out.paints.includes(p)) out.livery[car] = p;
    }
  }
  if (raw.trophies && typeof raw.trophies === 'object') {
    for (const id of Object.keys(raw.trophies).slice(0, 128)) {
      const d = raw.trophies[id];
      if (TROPHIES.some((t) => t.id === id) && (d === true || parseDay(d))) out.trophies[id] = d === true ? '' : d;
    }
  }
  const dy = raw.daily;
  if (dy && typeof dy === 'object' && parseDay(dy.day) && Array.isArray(dy.ids) && dy.ids.length === 3 &&
      dy.ids.every((id) => typeof id === 'string' && DAILY_BY_ID[id])) {
    out.daily.day = dy.day;
    out.daily.ids = dy.ids.slice();
    for (let i = 0; i < 3; i++) {
      out.daily.progress[i] = Math.max(0, num(Array.isArray(dy.progress) ? dy.progress[i] : 0));
      out.daily.done[i] = !!(Array.isArray(dy.done) && dy.done[i] === true);
    }
    out.daily.swept = dy.swept === true;
  }
  const sk = raw.streak;
  if (sk && typeof sk === 'object') {
    out.streak.count = Math.max(0, Math.floor(num(sk.count)));
    out.streak.best = Math.max(out.streak.count, Math.floor(num(sk.best)));
    out.streak.last = parseDay(sk.last) ? sk.last : '';
    if (!out.streak.last) out.streak.count = 0;
  }
  return out;
}

/**
 * What changes between a raw save and the current shape, given which version
 * wrote it. Returns { data, from } — `from` is the version read (0 for none).
 *
 * v1 -> v2: rewardLevel starts at 1, so load() pays every level reward the
 * player has already earned, and the medal counts v1 never kept are counted
 * back out of its results.
 */
export function migrate(raw) {
  const from = raw && typeof raw === 'object' ? Math.max(1, Math.floor(num(raw.v, 1))) : 0;
  const data = sanitize(raw);
  if (from === 1) {
    data.rewardLevel = 1;
    // v1 kept medals per challenge but never counted them, so "Gold Rush"
    // would have asked a player who already has a gold to win another.
    let medals = 0, golds = 0;
    for (const id of Object.keys(data.results)) {
      const m = data.results[id].medal;
      if (m > MEDAL_NONE) medals++;
      if (m >= MEDAL_GOLD) golds++;
    }
    data.stats.medals = Math.max(data.stats.medals, medals);
    data.stats.golds = Math.max(data.stats.golds, golds);
    data.stats.tokens = Math.max(data.stats.tokens, data.tokens.length);
  }
  data.v = PROGRESS_VERSION;
  return { data, from };
}

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * opts.storage     anything with getItem/setItem (default: localStorage, which
 *                  can be missing or throw in private browsing — then progress
 *                  simply lasts the session)
 * opts.cars        the catalogue, for class-based prices and car rewards
 * opts.grant       car ids to own from the start, e.g. the car a returning
 *                  player already drives — nobody loses a car to this update.
 *                  A MIGRATION, applied once: only when there is no readable
 *                  save yet, and written straight away. Once a save exists
 *                  every car in it was free or bought, so a grant must never
 *                  add one — above all after "Start over", when the car still
 *                  named in the settings is the one the player just gave up.
 * opts.today       () => 'YYYY-MM-DD'; the player's local date. Injected so the
 *                  harness can walk a streak across a month end.
 * opts.tokensTotal how many tokens the world has, for "find every token"
 * opts.dailyEligible (template, target, data) => bool: may this daily be
 *                  offered? Needed at construction, because today's three are
 *                  drawn on load — goals.js refuses "find N tokens" once fewer
 *                  than N are left, and anything about a layer that is missing.
 */
export function createProgress(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : browserStorage();
  const cars = opts.cars || [];
  const classOf = Object.fromEntries(cars.map((c) => [c.id, c.class]));
  const today = typeof opts.today === 'function' ? opts.today : () => localDay(new Date());
  let tokensTotal = opts.tokensTotal || 0;
  const listeners = new Set();
  // Everything that should be CELEBRATED — level-ups, trophies, dailies — is
  // queued here and handed out by drainEvents(), so every source of XP (a
  // medal, a token, a skill chain, a trophy that itself pays XP) reaches the
  // screen through one door and nothing is shown twice.
  const events = [];
  let eligible = typeof opts.dailyEligible === 'function' ? opts.dailyEligible : () => true;
  let dirty = false;
  let migratedFrom = 0;
  let data = load(opts.grant || []);

  function priceOf(id) {
    if (CAR_PRICES[id] != null) return CAR_PRICES[id];
    const cls = classOf[id];
    return cls && CLASS_PRICE[cls] != null ? CLASS_PRICE[cls] : 1500;
  }

  // The catalogue by price, cheapest first: the order level rewards hand cars
  // out in. Built once; ties broken by id so it never depends on sort order.
  const carsByPrice = cars
    .map((c) => ({ id: c.id, name: `${c.brand || ''} ${c.model || c.id}`.trim(), price: priceOf(c.id) }))
    .filter((c) => c.price > 0)
    .sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1));
  const ownView = {
    car: (id) => data.owned.includes(id),
    paint: (id) => data.paints.includes(id),
    cars: carsByPrice,
  };

  function load(grant) {
    let raw = null;
    try { raw = storage ? storage.getItem(PROGRESS_KEY) : null; } catch { raw = null; }
    let parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
    const { data: d, from } = migrate(parsed);
    migratedFrom = from;
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
  /** Writes the save. `quiet` skips the listeners — for stat trickles nobody is looking at. */
  function save(quiet) {
    dirty = false;
    try { if (storage) storage.setItem(PROGRESS_KEY, JSON.stringify(data)); } catch { /* quota or private mode */ }
    if (quiet) return;
    for (const fn of listeners) { try { fn(api); } catch (err) { console.error('[progress] listener failed', err); } }
  }

  // ---- XP, levels and their rewards ----------------------------------------

  function applyReward(r) {
    if (!r) return;
    if (r.type === 'cash') data.cash += r.amount;
    else if (r.type === 'car' && !data.owned.includes(r.id)) data.owned.push(r.id);
    else if (r.type === 'paint' && !data.paints.includes(r.id)) data.paints.push(r.id);
  }

  /**
   * Pays every level between the last one paid and the one the XP has reached.
   * Returns the rewards paid, in order. `quiet` marks them as a migration
   * catch-up, which the overlay shows as one "welcome back" card.
   */
  function payLevels(quiet) {
    const lv = levelFor(data.xp).level;
    const paid = [];
    while (data.rewardLevel < lv) {
      data.rewardLevel++;
      const r = levelReward(data.rewardLevel, ownView);
      applyReward(r);
      paid.push({ level: data.rewardLevel, reward: r });
      if (!quiet) events.push({ type: 'level', level: data.rewardLevel, reward: r });
    }
    return paid;
  }

  /** Adds XP, pays any levels it crosses, and returns the new level if one was reached (else 0). */
  function gainXp(n) {
    const add = Math.floor(n);
    if (!(add > 0)) return 0;
    const before = levelFor(data.xp).level;
    data.xp += add;
    payLevels(false);
    const after = levelFor(data.xp).level;
    return after > before ? after : 0;
  }

  // ---- trophies --------------------------------------------------------------

  function kindsWithMedal() {
    const kinds = new Set();
    for (const id of Object.keys(data.results)) {
      if (!(data.results[id].medal > 0)) continue;
      const k = id.startsWith('race-') || id.startsWith('stage-') ? 'race' : id.split('-')[0];
      kinds.add(k);
    }
    return kinds.size;
  }
  const ctxScratch = { level: 1, cars: 0, carsTotal: 0, paints: 0, tokensTotal: 0, streakBest: 0, kinds: 0 };
  function trophyCtx() {
    const c = ctxScratch;
    c.level = levelFor(data.xp).level;
    c.cars = data.owned.length;
    c.carsTotal = cars.length;
    c.paints = data.paints.length;
    c.tokensTotal = tokensTotal;
    c.streakBest = data.streak.best;
    c.kinds = kindsWithMedal();
    return c;
  }

  /**
   * Unlocks whatever is now earned. A trophy can pay XP, the XP can reach a
   * level, and a level can earn a trophy — so this loops until nothing new
   * unlocks, which it must within one pass per trophy.
   */
  function checkTrophies() {
    let any = false;
    for (let pass = 0; pass <= TROPHIES.length; pass++) {
      let got = false;
      const ctx = trophyCtx();
      for (const t of TROPHIES) {
        if (data.trophies[t.id] !== undefined) continue;
        if (!(t.value(data.stats, ctx) >= trophyTarget(t, ctx))) continue;
        data.trophies[t.id] = today();
        events.push({ type: 'trophy', id: t.id, name: t.name, desc: t.desc, xp: t.xp });
        if (t.xp) gainXp(t.xp);
        got = true;
      }
      if (!got) break;
      any = true;
    }
    return any;
  }

  // ---- dailies and the streak ------------------------------------------------

  const dailyView = {
    day: '', stamp: -1, list: [], streak: 0, streakBest: 0, alive: false, doneToday: false, doneCount: 0, allDone: false,
  };
  let dailyStamp = -1, dailyBuilt = -2;

  /** Today's three, rolled fresh when the date has moved on. Returns true if it rolled. */
  function rollDay() {
    const day = today();
    if (data.daily.day === day && data.daily.ids.length === 3) return false;
    const picks = pickDailies(day, (t, n) => eligible(t, n, data));
    data.daily.day = day;
    data.daily.ids = picks.map((p) => p.id);
    data.daily.progress = [0, 0, 0];
    data.daily.done = [false, false, false];
    data.daily.swept = false;
    dailyStamp++;
    dirty = true;
    return true;
  }

  function dailyEntry(i) {
    const t = DAILY_BY_ID[data.daily.ids[i]];
    const target = t.targets[i];
    return {
      id: t.id, metric: t.metric, tier: i, target, text: t.text(target),
      progress: Math.min(target, data.daily.progress[i]), done: data.daily.done[i],
      cash: DAILY_REWARD[i].cash, xp: DAILY_REWARD[i].xp,
    };
  }

  function completeDaily(i) {
    if (data.daily.done[i]) return;
    data.daily.done[i] = true;
    data.stats.dailies++;
    const r = DAILY_REWARD[i];
    data.cash += r.cash;
    const t = DAILY_BY_ID[data.daily.ids[i]];
    events.push({ type: 'daily', index: i, text: t.text(t.targets[i]), cash: r.cash, xp: r.xp });
    // The streak counts DAYS with at least one daily done. Doing yesterday's
    // extends it; a gap starts it again at 1. Checked against the date of the
    // daily itself, not the wall clock, so finishing a challenge a minute
    // after midnight still lands on the day it belonged to.
    const day = data.daily.day;
    if (data.streak.last !== day) {
      const was = data.streak.count;
      data.streak.count = data.streak.last === shiftDay(day, -1) ? was + 1 : 1;
      data.streak.last = day;
      data.streak.best = Math.max(data.streak.best, data.streak.count);
      if (data.streak.count > 1) events.push({ type: 'streak', count: data.streak.count });
    }
    gainXp(r.xp);
    if (!data.daily.swept && data.daily.done.every(Boolean)) {
      data.daily.swept = true;
      data.stats.sweeps++;
      data.cash += DAILY_SWEEP.cash;
      events.push({ type: 'sweep', cash: DAILY_SWEEP.cash, xp: DAILY_SWEEP.xp });
      gainXp(DAILY_SWEEP.xp);
    }
    dailyStamp++;
  }

  /** Feeds a daily metric. Returns true if a daily completed. */
  function feedDaily(metric, value, kind) {
    if (data.daily.ids.length !== 3) return false;
    let done = false;
    for (let i = 0; i < 3; i++) {
      if (data.daily.done[i]) continue;
      const t = DAILY_BY_ID[data.daily.ids[i]];
      if (!t || t.metric !== metric) continue;
      const before = data.daily.progress[i];
      data.daily.progress[i] = kind === 'peak' ? Math.max(before, value) : before + value;
      if (data.daily.progress[i] !== before) dailyStamp++;
      if (data.daily.progress[i] >= t.targets[i]) { completeDaily(i); done = true; }
    }
    return done;
  }

  // ---- the public verbs ------------------------------------------------------

  /**
   * Adds to a SUM metric: near misses, drift points, airtime, slipstream
   * seconds, kilometres. Cheap and unsaved — flush() writes it later — unless
   * it finished a daily or earned a trophy, which are saved at once.
   */
  function track(metric, amount) {
    if (!(amount > 0) || !Number.isFinite(amount)) return false;
    const m = METRIC_STAT[metric];
    if (!m) return false;
    if (m[0]) data.stats[m[0]] += amount;
    dirty = true;
    const done = feedDaily(metric, amount, 'sum');
    const got = checkTrophies();
    if (done || got) save();
    return done;
  }

  /** Raises a PEAK metric: top speed, best chain, best multiplier, clean seconds, jump. */
  function peak(metric, value) {
    if (!Number.isFinite(value) || value <= 0) return false;
    const m = METRIC_STAT[metric];
    if (!m) return false;
    let changed = false;
    if (m[0] && value > data.stats[m[0]]) { data.stats[m[0]] = value; changed = true; }
    const done = feedDaily(metric, value, 'peak');
    if (!changed && !done) return false;
    dirty = true;
    const got = checkTrophies();
    if (done || got) save();
    return done;
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
    const rec = { best: newBest ? score : prevBest, medal: m };
    if (newBest && splits) rec.splits = splits.slice(0, 16);
    else if (prev && prev.splits) rec.splits = prev.splits;
    data.results[ch.id] = rec;
    if (ch.kind === 'race') { data.stats.finishes++; }
    if (ch.kind === 'jump') { data.stats.jumps++; data.stats.bestJump = Math.max(data.stats.bestJump, score); }
    if (ch.kind === 'trap') data.stats.topSpeed = Math.max(data.stats.topSpeed, score);
    if ((medal | 0) > MEDAL_NONE) {
      data.stats.medals++;
      feedDaily('medals', 1, 'sum');
    }
    if ((medal | 0) >= MEDAL_GOLD) data.stats.golds++;
    if (ch.kind === 'jump') feedDaily('jump', score, 'peak');
    if (ch.kind === 'trap') feedDaily('speed', score, 'peak');
    // Level-ups from the medal's XP are reported on the result card, so the
    // events they queue are marked as already shown there.
    const mark = events.length;
    gainXp(xp);
    for (let i = mark; i < events.length; i++) if (events[i].type === 'level') events[i].onCard = true;
    checkTrophies();
    const levelAfter = levelFor(data.xp).level;
    save();
    return {
      medal: medal | 0, held: m, prevMedal, prevBest, newBest, cash, xp,
      levelUp: levelAfter > levelBefore ? levelAfter : 0,
      reward: levelAfter > levelBefore ? lastPaid(levelAfter) : null,
    };
  }
  // The reward actually paid at `level`, from the event queue (the prediction
  // would be wrong after the fact: the car it names is now owned).
  function lastPaid(level) {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'level' && events[i].level === level) return events[i].reward;
    return null;
  }

  function takeToken(i) {
    if (data.tokens.includes(i)) return null;
    data.tokens.push(i);
    data.stats.tokens = data.tokens.length;
    const levelBefore = levelFor(data.xp).level;
    data.cash += REWARDS.token.cash;
    gainXp(REWARDS.token.xp);
    feedDaily('tokens', 1, 'sum');
    checkTrophies();
    const levelAfter = levelFor(data.xp).level;
    save();
    return { cash: REWARDS.token.cash, xp: REWARDS.token.xp, count: data.tokens.length, levelUp: levelAfter > levelBefore ? levelAfter : 0 };
  }

  /**
   * A skill chain has banked. Converts its value to XP and cash (skills.js
   * SKILL_XP_PER and SKILL_CASH_PER), counts it, and returns what it paid.
   */
  function bankChain(value, xp, cash) {
    const v = Math.max(0, Math.floor(num(value)));
    if (!v) return { xp: 0, cash: 0, newBest: false, levelUp: 0 };
    const newBest = v > data.stats.chainBest;
    data.stats.chains++;
    data.stats.skill += v;
    data.cash += Math.max(0, Math.floor(num(cash)));
    const levelUp = gainXp(num(xp));
    peak('chain', v);
    checkTrophies();
    save();
    return { xp: Math.floor(num(xp)), cash: Math.floor(num(cash)), newBest, levelUp };
  }

  function buy(id) {
    if (data.owned.includes(id)) return true;
    const p = priceOf(id);
    if (data.cash < p) return false;
    data.cash -= p;
    data.owned.push(id);
    checkTrophies();
    save();
    return true;
  }

  function buyPaint(id) {
    const p = PAINT_BY_ID[id];
    if (!p) return false;
    if (data.paints.includes(id)) return true;
    if (data.cash < p.price) return false;
    data.cash -= p.price;
    data.paints.push(id);
    checkTrophies();
    save();
    return true;
  }

  /** Which special paint car `carId` wears; null for its factory colour. */
  function livery(carId) {
    const p = data.livery[carId];
    return p && data.paints.includes(p) ? p : null;
  }
  function setLivery(carId, paintId) {
    if (paintId && !data.paints.includes(paintId)) return false;
    if (livery(carId) === (paintId || null)) return true;
    if (paintId) data.livery[carId] = paintId;
    else delete data.livery[carId];
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

  /**
   * Today's dailies and the streak, as one object that is rebuilt only when
   * something in it changed — the HUD reads it every frame.
   */
  function daily() {
    if (dailyBuilt === dailyStamp && dailyView.day === data.daily.day) return dailyView;
    dailyBuilt = dailyStamp;
    const v = dailyView;
    v.day = data.daily.day;
    v.stamp = dailyStamp;
    v.list = data.daily.ids.length === 3 ? [0, 1, 2].map(dailyEntry) : [];
    v.doneCount = data.daily.done.filter(Boolean).length;
    v.allDone = v.doneCount === 3;
    v.doneToday = data.streak.last === data.daily.day && data.streak.count > 0;
    // Alive: done today, or done yesterday and still savable today.
    v.alive = v.doneToday || (data.streak.count > 0 && data.streak.last === shiftDay(data.daily.day, -1));
    v.streak = v.alive ? data.streak.count : 0;
    v.streakBest = data.streak.best;
    return v;
  }

  /** The reward for the next level, and how close it is. */
  function nextReward() {
    const lv = levelFor(data.xp);
    const level = Math.min(lv.level + 1, 99);
    return { level, reward: lv.level >= 99 ? null : levelReward(level, ownView), frac: lv.frac, into: lv.into, need: lv.need };
  }

  function trophyList() {
    const ctx = trophyCtx();
    return TROPHIES.map((t) => {
      const at = trophyTarget(t, ctx);
      return { id: t.id, name: t.name, desc: t.desc, xp: t.xp, got: data.trophies[t.id] !== undefined,
        value: Math.min(at, t.value(data.stats, ctx)), at };
    });
  }

  function afterLoad() {
    // A migrated save is paid its level rewards now, and handed its trophies
    // for what it had already done — as ONE "welcome back" card. A round-one
    // player at 2,000 XP is level 7 on the new curve: six rewards and a
    // handful of trophies, which as separate banners is fifteen seconds of
    // the screen being talked at before they can see the road.
    const mark = events.length;
    const paid = payLevels(true);
    rollDay();
    checkTrophies();
    // Trophy XP can itself cross levels, which queues ordinary level events;
    // everything since `mark` is folded into the one card.
    const since = events.splice(mark);
    const trophies = since.filter((e) => e.type === 'trophy');
    for (const e of since) if (e.type === 'level') paid.push({ level: e.level, reward: e.reward });
    if (paid.length || trophies.length) {
      const sum = {
        type: 'welcome', level: levelFor(data.xp).level, levels: paid.length, cash: 0,
        cars: [], paints: [], trophies: trophies.map((t) => t.name),
      };
      for (const p of paid) {
        if (!p.reward) continue;
        if (p.reward.type === 'cash') sum.cash += p.reward.amount;
        else if (p.reward.type === 'car') sum.cars.push(p.reward.name);
        else if (p.reward.type === 'paint') sum.paints.push(p.reward.name);
      }
      events.push(sum);
    }
    if (paid.length || trophies.length || migratedFrom === 1) save(true);
  }
  afterLoad();

  const api = {
    key: PROGRESS_KEY,
    get version() { return data.v; },
    /** The schema version the save was read from: 0 new, 1 migrated, 2 current. */
    get migratedFrom() { return migratedFrom; },
    get cash() { return data.cash; },
    get xp() { return data.xp; },
    get level() { return levelFor(data.xp); },
    get tokenCount() { return data.tokens.length; },
    get data() { return data; },
    get stats() { return data.stats; },
    get streak() { return data.streak; },
    result: (id) => data.results[id] || null,
    medalOf: (id) => (data.results[id] ? data.results[id].medal : MEDAL_NONE),
    record, takeToken, buy, medalCounts, bankChain, track, peak,
    hasToken: (i) => data.tokens.includes(i),
    owns: (id) => data.owned.includes(id),
    price: priceOf,
    flag: (k) => data.flags[k] === true,
    setFlag(k) { if (data.flags[k] !== true) { data.flags[k] = true; save(); } },
    grant(id) { if (id && !data.owned.includes(id)) { data.owned.push(id); save(); } },
    // ---- paint ----
    paints: PAINTS,
    ownsPaint: (id) => data.paints.includes(id),
    buyPaint, livery, setLivery,
    paintHex(carId) { const p = livery(carId); return p ? PAINT_BY_ID[p].hex : null; },
    // ---- the long game ----
    daily, nextReward, trophyList,
    hasTrophy: (id) => data.trophies[id] !== undefined,
    get trophyCount() { return Object.keys(data.trophies).length; },
    trophyTotal: TROPHIES.length,
    /** Who may be offered as a daily — goals.js refuses tokens once they are all found. */
    setDailyEligible(fn) { eligible = typeof fn === 'function' ? fn : () => true; },
    setTokensTotal(n) { tokensTotal = n | 0; },
    /** Re-checks the date; rolls new dailies at midnight. Cheap enough to call every few seconds. */
    rollDay() { const r = rollDay(); if (r) save(); return r; },
    /** Moves every queued celebration into `out` (an array) and clears the queue. */
    drainEvents(out) { for (const e of events) out.push(e); events.length = 0; return out; },
    /** Writes pending stat trickles; call every few seconds while driving. */
    flush() { if (dirty) save(true); },
    get dirty() { return dirty; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reload() { data = load(); afterLoad(); dailyStamp++; for (const fn of listeners) fn(api); },
    /** Wipes progress. Only ever called by a person, from the settings screen. */
    reset() {
      try { if (storage) storage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
      data = load();
      events.length = 0;
      afterLoad();
      dailyStamp++;
      save();
    },
    serialize: () => JSON.stringify(data),
    save,
  };
  return api;
}
