// The long game: what each level gives you, what the paint shop sells, the
// three daily challenges, and the trophies.
//
// The play-test that shaped round one was a kid with nothing to do. The one
// that shaped this file was the same kid a day later, with a medal or two and
// no reason to come back: every challenge had a best time on it and the only
// thing left was to beat it. So the rules here are about the NEXT thing — the
// reward one level away, three fresh challenges tomorrow, a trophy half done —
// and every one of them is something the HUD and the menus can put a number on.
//
// Pure data and arithmetic: no DOM, no storage, no clock. progress.js keeps
// the save and calls in here; tools/skillscheck.mjs checks every rule below.

import { mulberry } from '../world/noise.js';

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const MAX_LEVEL = 99;

/**
 * XP needed to REACH level n (level 1 is free): 40 (n^2 - 1).
 *
 * Each level costs 80 XP more than the one before — 120 for level 2, then
 * 200, 280, 360 — so the first few arrive in minutes and later ones settle to
 * one every twenty or so. Round one's curve was 100 n (n - 1), which put level
 * 5 at 2,000 XP: the rookie race at gold (450) and ten tokens (250) left a new
 * player at level 2 after twenty minutes, with the next level another hour
 * away. That curve paid for medals alone. This one also has skill chains,
 * dailies and trophies pouring into it: twenty minutes of cautious driving
 * (43 XP a minute from skills, measured with the real car in real traffic —
 * tools/skillscheck.mjs) plus four bronzes and eight tokens is 1,535 XP,
 * level 6 here against level 4 on the old curve.
 *
 * It is below round one's curve at every level past 1, so a returning player
 * only ever goes UP when their save is migrated.
 */
export function xpForLevel(n) {
  const l = Math.floor(n);
  return l <= 1 ? 0 : 40 * (l * l - 1);
}

/** Level, and how far into it, for an XP total. */
export function levelFor(xp) {
  const x = Number.isFinite(xp) && xp > 0 ? xp : 0;
  // Closed form, then nudged: sqrt of a float can land a hair either side of
  // an exact boundary, and a level that flickers at 120 XP is a bug.
  let level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Math.sqrt(x / 40 + 1))));
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= x) level++;
  while (level > 1 && xpForLevel(level) > x) level--;
  const lo = xpForLevel(level);
  if (level >= MAX_LEVEL) return { level, into: x - lo, need: 0, frac: 1 };
  const hi = xpForLevel(level + 1);
  return { level, into: x - lo, need: hi - lo, frac: (x - lo) / Math.max(1, hi - lo) };
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

// The shop's stock. Global unlocks: buy a paint once and every car you own can
// wear it — a kid saving for a colour should not have to buy it again for the
// next car. Names invented, like everything else (tools/brandcheck.mjs).
//
// The hexes are picked against carModel.js's paintFinish(): a light, grey
// colour (L > 0.8, S < 0.25) is painted as a solid white, so the silver here
// sits at L 0.73 to come out as real metallic silver instead of chalk.
export const PAINTS = [
  { id: 'sunburst',    name: 'Sunburst Yellow',  hex: 0xffc21a, price: 300 },
  { id: 'lagoon',      name: 'Lagoon Teal',      hex: 0x12b5a2, price: 300 },
  { id: 'flamingo',    name: 'Flamingo Pink',    hex: 0xff5fa2, price: 400 },
  { id: 'lime',        name: 'Zap Lime',         hex: 0x8fe12b, price: 400 },
  { id: 'tangerine',   name: 'Tangerine',        hex: 0xff7a1a, price: 450 },
  { id: 'ultraviolet', name: 'Ultraviolet',      hex: 0x7b3fe4, price: 500 },
  { id: 'glacier',     name: 'Glacier Blue',     hex: 0x6fcdfb, price: 550 },
  { id: 'cherry',      name: 'Cherry Pop',       hex: 0xd0102e, price: 600 },
  { id: 'midnight',    name: 'Midnight Violet',  hex: 0x2b1b5e, price: 700 },
  { id: 'silver',      name: 'Liquid Silver',    hex: 0xaeb9c4, price: 800 },
  { id: 'onyx',        name: 'Deep Space Black', hex: 0x0b0c10, price: 800 },
  { id: 'trophy',      name: 'Trophy Gold',      hex: 0xd9a514, price: 1500 },
];
export const PAINT_BY_ID = Object.fromEntries(PAINTS.map((p) => [p.id, p]));

// Paints a level can hand out, in the order they are handed out. A paint the
// player already bought is skipped for the next one down the list, so a level
// reward is never something they have.
const REWARD_PAINTS = ['sunburst', 'flamingo', 'lime', 'ultraviolet', 'glacier', 'cherry',
  'tangerine', 'lagoon', 'midnight', 'silver', 'onyx', 'trophy'];

// ---------------------------------------------------------------------------
// Level rewards
// ---------------------------------------------------------------------------

/** Cash a plain level pays: $300 at level 2, rising $50 about every level. */
export function levelCash(level) {
  return 50 * Math.round((200 + 60 * level) / 50);
}

/**
 * What reaching `level` gives. Every level gives something:
 *
 *   every 5th level (5, 10, 15 ...)      a car — the cheapest one not yet owned
 *   every level ending in 3 or 8         a paint from REWARD_PAINTS
 *   every other level                    cash
 *
 * A car every fifth level puts the twelve paid cars at levels 5 to 60, and
 * the first one about twenty minutes in. Once everything is owned the car
 * slot pays double cash and the paint slot plain cash, so the reward is never
 * "nothing".
 *
 * `own` answers for the player's current state:
 *   { car(id) => bool, paint(id) => bool, cars: [{ id, name, price }] }
 * Deterministic in that state, so the "next reward" the HUD promises is the
 * reward that is then paid — unless the player buys that exact car first, in
 * which case the promise moves on to the next one, which is the kind outcome.
 */
export function levelReward(level, own) {
  if (!(level >= 2)) return null;
  if (level % 5 === 0) {
    const cars = (own && own.cars) || [];
    for (const c of cars) {
      if (!own.car(c.id)) return { type: 'car', id: c.id, name: c.name };
    }
    return { type: 'cash', amount: levelCash(level) * 2 };
  }
  if (level % 5 === 3) {
    for (const id of REWARD_PAINTS) {
      if (!own || !own.paint(id)) return { type: 'paint', id, name: PAINT_BY_ID[id].name, hex: PAINT_BY_ID[id].hex };
    }
  }
  return { type: 'cash', amount: levelCash(level) };
}

/** A reward as a few words, for a banner or the "next reward" line. */
export function rewardText(r) {
  if (!r) return '';
  if (r.type === 'car') return `New car: ${r.name}`;
  if (r.type === 'paint') return `${r.name} paint`;
  return `$${Math.round(r.amount).toLocaleString('en')}`;
}

// ---------------------------------------------------------------------------
// Daily challenges
// ---------------------------------------------------------------------------

// Each template is one METRIC (progress.js counts them) and a target per tier:
// easy, medium, hard. A day draws one of each tier from three different
// metrics. `sum` metrics add up over the day, `peak` ones keep the best.
//
// Easy is a few minutes of ordinary play, medium wants you to go looking for
// it, hard is a proper session. For scale: the cautious autopilot in
// tools/skillscheck.mjs, which never tries for a near miss, gets five of them,
// fourteen speed milestones and several slipstreams in eleven minutes — so
// every easy target falls to ordinary driving and the hard ones do not.
export const DAILY_TEMPLATES = [
  { id: 'near',   metric: 'near',   kind: 'sum',  targets: [3, 8, 15],          text: (n) => `Get ${n} near misses` },
  { id: 'drift',  metric: 'drift',  kind: 'sum',  targets: [1500, 4000, 10000], text: (n) => `Drift ${n.toLocaleString('en')} points` },
  { id: 'air',    metric: 'air',    kind: 'sum',  targets: [3, 7, 14],          text: (n) => `Catch ${n} seconds of air` },
  { id: 'speed',  metric: 'speed',  kind: 'peak', targets: [140, 170, 200],     text: (n) => `Hit ${n} km/h` },
  { id: 'tow',    metric: 'tow',    kind: 'sum',  targets: [4, 10, 20],         text: (n) => `Slipstream for ${n} seconds` },
  { id: 'chain',  metric: 'chain',  kind: 'peak', targets: [2500, 8000, 20000], text: (n) => `Bank a ${n.toLocaleString('en')}-point chain` },
  { id: 'mult',   metric: 'mult',   kind: 'peak', targets: [3, 5, 8],           text: (n) => `Build a ×${n} multiplier` },
  { id: 'km',     metric: 'km',     kind: 'sum',  targets: [3, 8, 15],          text: (n) => `Drive ${n} km` },
  { id: 'clean',  metric: 'clean',  kind: 'peak', targets: [45, 90, 180],       text: (n) => `Drive ${n} s without crashing` },
  { id: 'medals', metric: 'medals', kind: 'sum',  targets: [1, 2, 4],           text: (n) => `Win ${n} medal${n > 1 ? 's' : ''}` },
  { id: 'tokens', metric: 'tokens', kind: 'sum',  targets: [2, 4, 6],           text: (n) => `Find ${n} tokens` },
  { id: 'jump',   metric: 'jump',   kind: 'peak', targets: [25, 35, 45],        text: (n) => `Fly ${n} m off a ramp` },
];
export const DAILY_BY_ID = Object.fromEntries(DAILY_TEMPLATES.map((t) => [t.id, t]));
export const DAILY_TIERS = ['easy', 'medium', 'hard'];
/** What one daily pays, by tier. All three in a day pays the sweep on top. */
export const DAILY_REWARD = [{ cash: 250, xp: 60 }, { cash: 450, xp: 120 }, { cash: 800, xp: 220 }];
export const DAILY_SWEEP = { cash: 500, xp: 150 };

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * The player's own calendar day, 'YYYY-MM-DD', from LOCAL time. Not UTC: a kid
 * in the evening should not see tomorrow's challenges appear at teatime.
 */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Parses 'YYYY-MM-DD'; null for anything else. */
export function parseDay(day) {
  const m = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/**
 * The day `k` days after `day`. Built at local NOON, because stepping a
 * midnight across a daylight-saving change lands at 23:00 the day before and
 * a streak would lose a day to the clocks going forward.
 */
export function shiftDay(day, k) {
  const p = parseDay(day);
  if (!p) return day;
  return localDay(new Date(p.y, p.m - 1, p.d + k, 12, 0, 0));
}

/** FNV-1a over the day string: the same date gives the same number anywhere. */
export function daySeed(day) {
  let h = 0x811c9dc5;
  const s = String(day);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h ^ 0x0da11e5) >>> 0;
}

/**
 * The three dailies for a day: one easy, one medium, one hard, on three
 * different metrics. Deterministic in the date, so a reload, a second tab or
 * a brother on the next computer all see the same three.
 *
 * `eligible(template, target)` can refuse one the player cannot do — tokens,
 * once every token is found — and the draw moves on to the next template in
 * the same shuffled order, so the replacement is deterministic too.
 */
export function pickDailies(day, eligible) {
  const ok = typeof eligible === 'function' ? eligible : () => true;
  const rnd = mulberry(daySeed(day));
  const order = DAILY_TEMPLATES.map((t, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const out = [];
  const used = new Set();
  for (let tier = 0; tier < 3; tier++) {
    let pick = null;
    for (const i of order) {
      const t = DAILY_TEMPLATES[i];
      if (used.has(t.metric)) continue;
      if (!ok(t, t.targets[tier])) continue;
      pick = t;
      break;
    }
    // Driving is always possible. A pool so thin that nothing else is left
    // still hands out a challenge rather than a hole.
    if (!pick) pick = DAILY_BY_ID.km;
    used.add(pick.metric);
    out.push({
      id: pick.id, metric: pick.metric, kind: pick.kind, tier,
      target: pick.targets[tier], text: pick.text(pick.targets[tier]),
      cash: DAILY_REWARD[tier].cash, xp: DAILY_REWARD[tier].xp,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trophies
// ---------------------------------------------------------------------------

// `value(stats, ctx)` is how far along the player is; `at` is the target (a
// number, or a function of ctx for the ones that depend on the world, like
// "every token"). ctx: { level, cars, carsTotal, paints, tokensTotal,
// streakBest, kinds } — see progress.js trophyCtx().
const st = (k) => (s) => s[k] || 0;
export const TROPHIES = [
  { id: 'near-1',     name: 'Close Shave',      desc: 'Your first near miss',                    xp: 30,  value: st('near'), at: 1 },
  { id: 'finish-1',   name: 'Off the Line',     desc: 'Finish a race',                           xp: 50,  value: st('finishes'), at: 1 },
  { id: 'air-2',      name: 'Airborne',         desc: '2 seconds of air in one jump',            xp: 80,  value: st('airBest'), at: 2 },
  { id: 'gold-1',     name: 'Gold Rush',        desc: 'Win a gold medal',                        xp: 100, value: st('golds'), at: 1 },
  { id: 'chain-10k',  name: 'Chain Reaction',   desc: 'Bank a 10,000-point skill chain',         xp: 120, value: st('chainBest'), at: 10000 },
  { id: 'daily-1',    name: 'Daily Driver',     desc: 'Finish a daily challenge',                xp: 50,  value: st('dailies'), at: 1 },
  { id: 'speed-200',  name: 'Two Hundred Club', desc: 'Hit 200 km/h',                            xp: 100, value: st('topSpeed'), at: 200 },
  { id: 'tow-30',     name: 'Slipstreamer',     desc: 'Slipstream for 30 seconds in all',        xp: 100, value: st('tow'), at: 30 },
  { id: 'drift-5k',   name: 'Sideways',         desc: 'Bank a 5,000-point drift',                xp: 120, value: st('driftBest'), at: 5000 },
  { id: 'paint-1',    name: 'Fresh Paint',      desc: 'Get a special paint',                     xp: 50,  value: (s, c) => c.paints, at: 1 },
  { id: 'level-5',    name: 'Rising Star',      desc: 'Reach level 5',                           xp: 0,   value: (s, c) => c.level, at: 5 },
  { id: 'near-50',    name: 'Traffic Weaver',   desc: '50 near misses',                          xp: 150, value: st('near'), at: 50 },
  { id: 'mult-10',    name: 'Maxed Out',        desc: 'Reach the ×10 multiplier',               xp: 250, value: st('multBest'), at: 10 },
  { id: 'clean-120',  name: 'Smooth Operator',  desc: 'Two minutes without a crash',             xp: 120, value: st('cleanBest'), at: 120 },
  { id: 'tokens-10',  name: 'Token Hunter',     desc: 'Find 10 tokens',                          xp: 100, value: st('tokens'), at: 10 },
  { id: 'cars-5',     name: 'Collector',        desc: 'Own 5 cars',                              xp: 150, value: (s, c) => c.cars, at: 5 },
  { id: 'sweep-1',    name: 'Hat Trick',        desc: 'All three dailies in one day',            xp: 150, value: st('sweeps'), at: 1 },
  { id: 'streak-3',   name: 'On a Roll',        desc: 'A 3-day streak',                          xp: 150, value: (s, c) => c.streakBest, at: 3 },
  { id: 'kinds-4',    name: 'All-Rounder',      desc: 'A medal in a race, a trap, a jump and a drift zone', xp: 200, value: (s, c) => c.kinds, at: 4 },
  { id: 'air-60',     name: 'Frequent Flyer',   desc: 'A whole minute in the air, all told',     xp: 200, value: st('air'), at: 60 },
  { id: 'level-10',   name: 'Road Hero',        desc: 'Reach level 10',                          xp: 0,   value: (s, c) => c.level, at: 10 },
  { id: 'chain-50k',  name: 'Chain Master',     desc: 'Bank a 50,000-point skill chain',         xp: 300, value: st('chainBest'), at: 50000 },
  { id: 'speed-250',  name: 'Warp Speed',       desc: 'Hit 250 km/h',                            xp: 250, value: st('topSpeed'), at: 250 },
  { id: 'km-100',     name: 'Long Haul',        desc: 'Drive 100 km',                            xp: 250, value: st('km'), at: 100 },
  { id: 'near-250',   name: 'Needle Threader',  desc: '250 near misses',                         xp: 300, value: st('near'), at: 250 },
  { id: 'streak-7',   name: 'Week Warrior',     desc: 'A 7-day streak',                          xp: 400, value: (s, c) => c.streakBest, at: 7 },
  { id: 'tokens-all', name: 'Token Master',     desc: 'Find every token',                        xp: 500, value: st('tokens'), at: (c) => c.tokensTotal || 50 },
  { id: 'cars-all',   name: 'Full Garage',      desc: 'Own every car',                           xp: 500, value: (s, c) => c.cars, at: (c) => c.carsTotal || 15 },
  { id: 'level-25',   name: 'Legend',           desc: 'Reach level 25',                          xp: 0,   value: (s, c) => c.level, at: 25 },
];
export const TROPHY_BY_ID = Object.fromEntries(TROPHIES.map((t) => [t.id, t]));

/** Target of a trophy for this player's world. */
export function trophyTarget(t, ctx) {
  return typeof t.at === 'function' ? t.at(ctx) : t.at;
}
