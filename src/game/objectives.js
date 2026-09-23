// The goals, on screen: what to do next, the race clock, the 3-2-1, the medal
// card, the pop when a token is grabbed, and — once, on a first drive — which
// keys do what. And the long game: the skill-chain meter and its feed, the
// level-up banner, trophy and daily notes, the next reward and the dailies.
//
// THE CHAIN METER sits top-centre under the compass, the one place a driver's
// eye passes every second: multiplier, value, and a bar that drains toward
// the bank. The skills that feed it drop in underneath and fade in 1.5 s —
// long enough to read NEAR MISS, short enough never to stack past three.
//
// WHERE THINGS SIT. The HUD owns the four corners and the top-centre compass,
// and its drift dial drops into the top of the middle column whenever the car
// is sideways. So the standing information (objective, race clock, wallet)
// lives in a column down the right-hand side under the clock, where nothing
// else is, and only the moments — the countdown, the medal card, a token pop —
// take the centre of the screen, briefly.
//
// NOTHING HERE BUILDS A STRING UNLESS WHAT IT SHOWS HAS CHANGED. The race clock
// changes ten times a second and is rebuilt ten times a second; every other
// line compares the NUMBERS behind it with the ones on screen, and only
// formats when they differ — nor is any class toggled without a change.
//
// The layer is pointer-events: none except the two buttons on the medal card,
// and those never take focus — a focused button turns the handbrake (Space)
// into "Race again".

const ICONS = {
  race: '<svg viewBox="0 0 24 24"><path d="M5 3v18" stroke="currentColor" stroke-width="2" fill="none"/><path d="M6 4h13l-3 4 3 4H6z" fill="currentColor"/><path d="M9 4h3v4H9zM12 8h3v4h-3z" fill="#0b0e13" opacity=".55"/></svg>',
  trap: '<svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M12 16l5-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M2 20h9l-7-5z" fill="currentColor"/><path d="M8 13c3-7 9-8 13-4" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="2 2.5"/><path d="M21 9l-.5 3.5-3-1.8z" fill="currentColor"/></svg>',
  drift: '<svg viewBox="0 0 24 24"><path d="M4 18c4 0 5-5 9-5s4 4 7 4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5 11c3 0 4-4 7-4s3 3 6 3" stroke="currentColor" stroke-width="2" fill="none" opacity=".55" stroke-linecap="round"/></svg>',
  token: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M12 6.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L12 14.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" fill="#0b0e13" opacity=".7"/></svg>',
  level: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" fill="currentColor"/></svg>',
  nav: '<svg viewBox="0 0 24 24"><path d="M12 2l7 18-7-4-7 4z" fill="currentColor"/></svg>',
  trophy: '<svg viewBox="0 0 24 24"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M11 13h2v4h-2zM8 18h8v3H8z" fill="currentColor"/></svg>',
  daily: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2"/><path d="M8 15l2.5 2.5L16 12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
  streak: '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M3 15l2-5c.4-1 1.3-2 2.6-2h8.8c1.3 0 2.2 1 2.6 2l2 5v3H3z" fill="currentColor"/><circle cx="7.5" cy="18" r="2.2" fill="#0b0e13"/><circle cx="16.5" cy="18" r="2.2" fill="#0b0e13"/></svg>',
  paint: '<svg viewBox="0 0 24 24"><path d="M4 16c0-4 5-12 8-12s8 8 8 12a8 4 0 0 1-16 0z" fill="currentColor"/></svg>',
};
const KIND_WORD = { race: 'RACE', trap: 'SPEED TRAP', jump: 'JUMP', drift: 'DRIFT ZONE' };
const MEDAL_WORD = ['NO MEDAL', 'BRONZE', 'SILVER', 'GOLD'];

function fmtTime(t) {
  if (!(t >= 0)) return '0:00.0';
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600), s = Math.floor((tenths % 600) / 10), d = tenths % 10;
  return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
}
// Distances are compared as the number that is SHOWN, before any string is
// made: metres to the nearest 10 under a kilometre, then tenths of a km
// (stored as 100 m steps plus an offset so the two ranges cannot collide).
function distKey(m) {
  if (!(m >= 0)) return -1;
  if (m < 995) return Math.max(10, Math.round(m / 10) * 10);
  return 1e6 + Math.round(m / 100);
}
function fmtDistKey(k) {
  if (k < 0) return '';
  if (k < 1e6) return `${k} m`;
  return `${((k - 1e6) / 10).toFixed(1)} km`;
}
const fmtCash = (v) => `$${Math.round(v).toLocaleString('en')}`;

// The chain bar is set through transform, off a table, like the HUD's bars: a
// width change is layout, and a template string per frame is garbage.
const BAR_STEPS = 64;
const BAR_STR = new Array(BAR_STEPS + 1);
for (let i = 0; i <= BAR_STEPS; i++) BAR_STR[i] = `scaleX(${i / BAR_STEPS})`;
// Multipliers are x1.0 to x10.0 in halves: 19 strings, built once.
const MULT_STR = new Array(21);
for (let i = 2; i <= 20; i++) MULT_STR[i] = `×${(i / 2).toFixed(1)}`;
// Four tiers of multiplier colour, so a x7 chain LOOKS worth protecting.
const multTier = (m) => (m >= 7 ? 3 : m >= 4 ? 2 : m >= 2 ? 1 : 0);
const REWARD_ICON = { car: 'car', paint: 'paint', cash: 'token' };

export function createObjectives(root, opts = {}) {
  const doc = (root && root.ownerDocument) || document;

  // Stylesheet, linked once, resolved against this module like menus.js does
  // for ui.css — index.html is not this layer's to edit.
  if (!doc.querySelector('link[data-openroad-goals]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.openroadGoals = '';
    link.href = new URL('../../styles/goals.css', import.meta.url).href;
    doc.head.appendChild(link);
  }

  const el = doc.createElement('div');
  el.className = 'goal is-hidden';
  el.innerHTML = `
    <div class="goal__col">
      <div class="goal__obj">
        <i class="goal__icon" aria-hidden="true"></i>
        <div class="goal__objText"><b class="goal__title"></b><span class="goal__detail"></span></div>
        <span class="goal__dist"></span>
      </div>
      <div class="goal__race">
        <div class="goal__timer">0:00.0</div>
        <div class="goal__raceRow"><span class="goal__cp"></span><span class="goal__delta"></span></div>
        <div class="goal__target"><i class="goal__medal"></i><span class="goal__targetText"></span></div>
      </div>
      <div class="goal__zone">
        <div class="goal__zoneScore">0</div>
        <div class="goal__target"><i class="goal__medal"></i><span class="goal__zoneTarget"></span></div>
      </div>
      <div class="goal__hint"></div>
      <div class="goal__wallet"><i class="goal__coin" aria-hidden="true">${ICONS.token}</i><b class="goal__cash">$0</b><span class="goal__lv">LV 1</span><span class="goal__xp"><i></i></span></div>
      <div class="goal__next"><u class="goal__nextBar" aria-hidden="true"><i></i></u><span class="goal__nextLv"></span><i class="goal__nextIcon" aria-hidden="true"></i><span class="goal__nextText"></span></div>
      <div class="goal__daily">
        <div class="goal__dHead"><i class="goal__dIcon" aria-hidden="true">${ICONS.daily}</i><b>DAILY</b><span class="goal__streak"></span></div>
        <div class="goal__dRows"></div>
      </div>
    </div>
    <div class="goal__chain" aria-live="off">
      <div class="goal__chainRow"><b class="goal__mult">×1.0</b><span class="goal__chainVal">0</span></div>
      <div class="goal__chainBar"><i></i></div>
      <div class="goal__chainBest"></div>
      <div class="goal__chainEnd"><b></b><span></span></div>
      <div class="goal__feed"></div>
    </div>
    <div class="goal__banner" role="status"><div class="goal__bTitle"></div><div class="goal__bSub"></div><div class="goal__bDetail"></div></div>
    <div class="goal__notes" aria-live="polite"></div>
    <div class="goal__flash" aria-hidden="true"></div>
    <div class="goal__count" aria-live="assertive"></div>
    <div class="goal__pops" aria-live="polite"></div>
    <div class="goal__result" role="status">
      <div class="goal__resKind"></div>
      <div class="goal__resName"></div>
      <div class="goal__resMedal"><i class="goal__medalBig"></i><b class="goal__resMedalWord"></b></div>
      <div class="goal__resScore"></div>
      <div class="goal__resBest"></div>
      <div class="goal__resPay"></div>
      <div class="goal__resNext"></div>
      <div class="goal__resActions">
        <button type="button" tabindex="-1" data-act="retry">Again <kbd>Enter</kbd></button>
        <button type="button" tabindex="-1" data-act="next">Keep driving</button>
      </div>
    </div>
    <div class="goal__controls"></div>
  `;
  (root || doc.body).appendChild(el);

  const q = (s) => el.querySelector(s);
  const E = {
    obj: q('.goal__obj'), icon: q('.goal__icon'), title: q('.goal__title'), detail: q('.goal__detail'), dist: q('.goal__dist'),
    race: q('.goal__race'), timer: q('.goal__timer'), cp: q('.goal__cp'), delta: q('.goal__delta'),
    tMedal: q('.goal__race .goal__medal'), tText: q('.goal__targetText'),
    zone: q('.goal__zone'), zScore: q('.goal__zoneScore'), zMedal: q('.goal__zone .goal__medal'), zText: q('.goal__zoneTarget'),
    hint: q('.goal__hint'),
    cash: q('.goal__cash'), lv: q('.goal__lv'), xp: q('.goal__xp i'),
    next: q('.goal__next'), nextLv: q('.goal__nextLv'), nextIcon: q('.goal__nextIcon'), nextText: q('.goal__nextText'),
    nextBar: q('.goal__nextBar i'),
    daily: q('.goal__daily'), dRows: q('.goal__dRows'), streak: q('.goal__streak'),
    chain: q('.goal__chain'), mult: q('.goal__mult'), chainVal: q('.goal__chainVal'), chainBar: q('.goal__chainBar i'),
    chainBest: q('.goal__chainBest'),
    chainEnd: q('.goal__chainEnd'), chainEndB: q('.goal__chainEnd b'), chainEndS: q('.goal__chainEnd span'),
    feed: q('.goal__feed'),
    banner: q('.goal__banner'), bTitle: q('.goal__bTitle'), bSub: q('.goal__bSub'), bDetail: q('.goal__bDetail'),
    notes: q('.goal__notes'), flash: q('.goal__flash'),
    count: q('.goal__count'), pops: q('.goal__pops'),
    res: q('.goal__result'), resKind: q('.goal__resKind'), resName: q('.goal__resName'),
    resMedal: q('.goal__resMedal'), resMedalWord: q('.goal__resMedalWord'), resScore: q('.goal__resScore'),
    resBest: q('.goal__resBest'), resPay: q('.goal__resPay'), resNext: q('.goal__resNext'),
    controls: q('.goal__controls'),
  };

  // Buttons: clickable, never focusable.
  for (const b of el.querySelectorAll('.goal__resActions button')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      b.blur();
      if (b.dataset.act === 'retry' && opts.onRetry) opts.onRetry();
      if (b.dataset.act === 'next' && opts.onNext) opts.onNext();
    });
  }

  // ---- what is on screen now, to compare against -----------------------------
  const last = {
    kind: null, title: null, detail: null, dist: -2, showObj: null, raceOn: null, zoneOn: null,
    tenths: -1, cp: -1, cpTotal: -1, delta: 0, tMedal: -1, tTextMedal: -1, tTextTime: NaN,
    zScore: -1, zMedal: -1, zTextMedal: -1, zTextScore: NaN,
    hint: null, cash: -1, lv: -1, xp: -1,
    nextLevel: -1, nextText: null, nextBar: -1, dailyStamp: -2,
    chainOn: null, chainMult: -1, chainTier: -1, chainVal: -1, chainBar: -1, chainHold: null,
    chainBeat: null, chainBestShown: -1,
  };
  let visible = false;
  let freshT = 0;
  let deltaT = 0;

  function setVisible(on) {
    if (on === visible) return;
    visible = on;
    el.classList.toggle('is-hidden', !on);
  }

  function update(dt, ui) {
    if (freshT > 0) { freshT -= dt; if (freshT <= 0) E.obj.classList.remove('is-fresh'); }

    const o = ui.objective;
    const showObj = !!o.title && !ui.race.active && !ui.zone.active;
    if (showObj !== last.showObj) { last.showObj = showObj; E.obj.classList.toggle('is-on', showObj); }
    if (o.kind !== last.kind) {
      last.kind = o.kind;
      E.icon.innerHTML = ICONS[o.kind] || ICONS.nav;
      E.obj.dataset.kind = o.kind || 'nav';
    }
    if (o.title !== last.title) {
      last.title = o.title;
      E.title.textContent = o.title;
      // A new objective pulses once, so the change is noticed out of the
      // corner of an eye that is on the road.
      E.obj.classList.remove('is-fresh');
      void E.obj.offsetWidth;
      E.obj.classList.add('is-fresh');
      freshT = 1.6;
    }
    if (o.detail !== last.detail) { last.detail = o.detail; E.detail.textContent = o.detail; }
    const dk = distKey(o.dist);
    if (dk !== last.dist) { last.dist = dk; E.dist.textContent = fmtDistKey(dk); }

    const r = ui.race;
    const raceOn = r.active && r.phase === 'running';
    if (raceOn !== last.raceOn) { last.raceOn = raceOn; E.race.classList.toggle('is-on', raceOn); }
    if (raceOn) {
      const tenths = Math.floor(r.time * 10);
      if (tenths !== last.tenths) { last.tenths = tenths; E.timer.textContent = fmtTime(r.time); }
      if (r.cp !== last.cp || r.cpTotal !== last.cpTotal) {
        last.cp = r.cp; last.cpTotal = r.cpTotal;
        E.cp.textContent = r.cp >= r.cpTotal - 1 ? 'FINAL GATE' : `GATE ${r.cp + 1} / ${r.cpTotal}`;
      }
      // The split, as signed tenths: 0 means hidden, and the +1 keeps "−0.0"
      // and "+0.0" apart.
      const dKey = r.deltaAge < 3 && Number.isFinite(r.delta)
        ? (r.delta <= 0 ? -1 : 1) * (Math.round(Math.abs(r.delta) * 10) + 1) : 0;
      if (dKey !== last.delta) {
        last.delta = dKey;
        if (dKey) {
          E.delta.textContent = `${dKey < 0 ? '−' : '+'}${((Math.abs(dKey) - 1) / 10).toFixed(1)}`;
          E.delta.dataset.sign = dKey < 0 ? 'ahead' : 'behind';
          E.delta.classList.add('is-on');
        } else E.delta.classList.remove('is-on');
      }
      if (r.targetMedal !== last.tMedal) { last.tMedal = r.targetMedal; E.tMedal.dataset.medal = r.targetMedal; }
      if (r.targetMedal !== last.tTextMedal || r.targetTime !== last.tTextTime) {
        last.tTextMedal = r.targetMedal; last.tTextTime = r.targetTime;
        E.tText.textContent = r.targetMedal ? `${MEDAL_WORD[r.targetMedal]} ${fmtTime(r.targetTime)}` : 'NO MEDAL — FINISH IT!';
      }
    }

    const z = ui.zone;
    if (z.active !== last.zoneOn) { last.zoneOn = z.active; E.zone.classList.toggle('is-on', z.active); }
    if (z.active) {
      const sc = Math.round(z.score);
      if (sc !== last.zScore) { last.zScore = sc; E.zScore.textContent = sc.toLocaleString('en'); }
      if (z.targetMedal !== last.zMedal) { last.zMedal = z.targetMedal; E.zMedal.dataset.medal = z.targetMedal; }
      if (z.targetMedal !== last.zTextMedal || z.targetScore !== last.zTextScore) {
        last.zTextMedal = z.targetMedal; last.zTextScore = z.targetScore;
        E.zText.textContent = `${MEDAL_WORD[z.targetMedal]} ${z.targetScore.toLocaleString('en')}`;
      }
    }

    if (ui.hint !== last.hint) {
      last.hint = ui.hint;
      E.hint.textContent = ui.hint;
      E.hint.classList.toggle('is-on', !!ui.hint);
    }

    const w = ui.wallet;
    if (w.cash !== last.cash) {
      if (last.cash >= 0 && w.cash > last.cash) { E.cash.classList.remove('is-bump'); void E.cash.offsetWidth; E.cash.classList.add('is-bump'); }
      last.cash = w.cash; E.cash.textContent = fmtCash(w.cash);
    }
    if (w.level !== last.lv) { last.lv = w.level; E.lv.textContent = `LV ${w.level}`; }
    const xp = Math.round(w.frac * 100);
    if (xp !== last.xp) { last.xp = xp; E.xp.style.width = `${xp}%`; }

    if (deltaT > 0) deltaT -= dt;

    // ---- the next reward ------------------------------------------------------
    const nx = ui.next;
    if (nx && (nx.level !== last.nextLevel || nx.text !== last.nextText)) {
      last.nextLevel = nx.level; last.nextText = nx.text;
      const on = !!nx.text;
      E.next.classList.toggle('is-on', on);
      if (on) {
        E.nextLv.textContent = `NEXT AT LV ${nx.level}`;
        E.nextIcon.innerHTML = ICONS[REWARD_ICON[nx.type] || 'level'];
        E.nextText.textContent = nx.text;
        E.next.dataset.type = nx.type || '';
      }
    }
    // The line is also the bar: it fills toward the reward it names.
    if (nx) {
      let f = Math.round((nx.frac || 0) * BAR_STEPS);
      f = f < 0 ? 0 : f > BAR_STEPS ? BAR_STEPS : f;
      if (f !== last.nextBar) { last.nextBar = f; E.nextBar.style.transform = BAR_STR[f]; }
    }

    // ---- today's dailies ------------------------------------------------------
    const dv = ui.daily;
    if (dv && dv.stamp !== last.dailyStamp) {
      last.dailyStamp = dv.stamp;
      renderDaily(dv);
    }

    // ---- the skill chain ------------------------------------------------------
    const ch = ui.chain;
    if (ch) {
      const on = !!ch.live;
      if (on !== last.chainOn) {
        last.chainOn = on;
        E.chain.classList.toggle('is-live', on);
        if (on) { clearTimeout(endTimer); E.chainEnd.className = 'goal__chainEnd'; }
      }
      if (on) {
        let mi = Math.round(ch.mult * 2);
        mi = mi < 2 ? 2 : mi > 20 ? 20 : mi;
        if (mi !== last.chainMult) {
          const up = mi > last.chainMult && last.chainMult > 0;
          last.chainMult = mi;
          E.mult.textContent = MULT_STR[mi];
          const tier = multTier(mi / 2);
          if (tier !== last.chainTier) { last.chainTier = tier; E.chain.dataset.tier = String(tier); }
          if (up) { E.mult.classList.remove('is-up'); void E.mult.offsetWidth; E.mult.classList.add('is-up'); }
        }
        const v = ch.value | 0;
        if (v !== last.chainVal) {
          last.chainVal = v;
          E.chainVal.textContent = v.toLocaleString('en');
          // The record to beat, under the bar — and the moment it is beaten,
          // the chain says so while it is still running, which is exactly
          // when a kid starts driving carefully.
          const best = ch.best | 0;
          const beat = best > 0 && v > best;
          if (beat !== last.chainBeat || (!beat && best !== last.chainBestShown)) {
            last.chainBeat = beat; last.chainBestShown = best;
            E.chainBest.textContent = beat ? 'NEW BEST!' : best > 0 ? `BEST ${best.toLocaleString('en')}` : '';
            E.chain.classList.toggle('is-record', beat);
          }
        }
        let b = Math.round(ch.timerFrac * BAR_STEPS);
        b = b < 0 ? 0 : b > BAR_STEPS ? BAR_STEPS : b;
        if (b !== last.chainBar) { last.chainBar = b; E.chainBar.style.transform = BAR_STR[b]; }
        const hold = !!ch.hold;
        if (hold !== last.chainHold) { last.chainHold = hold; E.chain.classList.toggle('is-hold', hold); }
      } else if (last.chainMult !== -1) {
        last.chainMult = -1; last.chainVal = -1; last.chainBar = -1; last.chainHold = null;
        last.chainBeat = null; last.chainBestShown = -1;
        E.chain.classList.remove('is-record');
      }
    }
  }

  // ---- the long game ------------------------------------------------------------

  // Three rows built once and then only re-texted; the text changes when the
  // numbers behind it do, which for a distance daily is once a second.
  const dRow = [];
  for (let i = 0; i < 3; i++) {
    const r = doc.createElement('div');
    r.className = 'goal__dRow';
    r.innerHTML = '<i class="goal__dTick" aria-hidden="true"></i><span class="goal__dText"></span><em class="goal__dNum"></em><u class="goal__dBar"><i></i></u>';
    E.dRows.appendChild(r);
    dRow.push({ el: r, text: r.querySelector('.goal__dText'), num: r.querySelector('.goal__dNum'), bar: r.querySelector('.goal__dBar i') });
  }
  const oneDp = { km: 1, air: 1, tow: 1 };
  function fmtDaily(metric, v) {
    if (oneDp[metric]) return (Math.floor(v * 10) / 10).toString();
    return Math.floor(v).toLocaleString('en');
  }
  function renderDaily(dv) {
    const list = dv.list || [];
    E.daily.classList.toggle('is-on', list.length === 3);
    E.daily.classList.toggle('is-all', !!dv.allDone);
    for (let i = 0; i < 3; i++) {
      const d = list[i], r = dRow[i];
      if (!d) continue;
      r.el.classList.toggle('is-done', d.done);
      r.el.dataset.tier = String(d.tier);
      if (r.text.textContent !== d.text) r.text.textContent = d.text;
      r.num.textContent = d.done ? 'DONE' : `${fmtDaily(d.metric, d.progress)}/${fmtDaily(d.metric, d.target)}`;
      const f = d.done ? 1 : Math.max(0, Math.min(1, d.progress / Math.max(1e-6, d.target)));
      r.bar.style.transform = BAR_STR[Math.round(f * BAR_STEPS)];
    }
    // The streak: how many days, and whether today still needs doing.
    const due = dv.streak > 0 && !dv.doneToday;
    E.streak.innerHTML = dv.streak > 0 ? `<i aria-hidden="true">${ICONS.streak}</i>${dv.streak | 0}-DAY STREAK` : '';
    E.streak.classList.toggle('is-on', dv.streak > 0);
    E.streak.classList.toggle('is-due', due);
    E.streak.title = due ? 'Finish a daily today to keep your streak' : '';
  }

  // Skills as they land, newest on top, three at most.
  function skill(kind, label, points) {
    const p = doc.createElement('div');
    p.className = 'goal__feedItem';
    p.dataset.kind = kind;
    p.innerHTML = '<b></b><span></span>';
    p.firstChild.textContent = label;
    p.lastChild.textContent = points > 0 ? `+${points.toLocaleString('en')}` : '';
    E.feed.insertBefore(p, E.feed.firstChild);
    while (E.feed.children.length > 3) E.feed.lastChild.remove();
    setTimeout(() => p.classList.add('is-out'), 1200);
    setTimeout(() => p.remove(), 1600);
  }

  // The chain's end: gold for banked, red for lost, with what it paid.
  let endTimer = 0;
  function chainEnd(kind, value, mult, xp, cash, best) {
    clearTimeout(endTimer);
    const bank = kind === 'bank';
    E.chainEndB.textContent = bank ? `BANKED ${value.toLocaleString('en')}` : 'CHAIN LOST';
    E.chainEndS.textContent = bank
      ? `${best ? 'NEW BEST CHAIN!  ' : ''}+${xp} XP  +$${cash}`
      : `${value.toLocaleString('en')} gone — don't crash!`;
    E.chainEnd.className = 'goal__chainEnd';
    void E.chainEnd.offsetWidth;
    E.chainEnd.className = `goal__chainEnd is-on ${bank ? 'is-bank' : 'is-lost'}${best ? ' is-best' : ''}`;
    endTimer = setTimeout(() => { E.chainEnd.className = 'goal__chainEnd'; }, bank ? 2600 : 2000);
  }

  // Level-ups, the daily sweep, welcome back: one big banner at a time.
  const bannerQ = [];
  let bannerTimer = 0, bannerOn = false;
  function celebrate(kind, title, sub, reward) {
    bannerQ.push({ kind, title, sub, reward });
    if (!bannerOn) nextBanner();
  }
  function nextBanner() {
    // The medal card is the moment when there is one; a level-up earned by
    // the trophy that medal unlocked waits for the card to go, rather than
    // landing on top of it (the two share the middle of the screen).
    if (bannerQ.length && E.res.classList.contains('is-on')) {
      bannerOn = true;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(nextBanner, 400);
      return;
    }
    const b = bannerQ.shift();
    if (!b) { bannerOn = false; E.banner.classList.remove('is-on'); return; }
    bannerOn = true;
    E.banner.dataset.kind = b.kind;
    E.bTitle.textContent = b.title;
    E.bSub.textContent = b.sub || '';
    E.bDetail.textContent = '';
    const r = b.reward;
    if (r && r.type === 'paint') {
      const chip = doc.createElement('i');
      chip.className = 'goal__swatch';
      chip.style.background = `#${r.hex.toString(16).padStart(6, '0')}`;
      E.bDetail.appendChild(chip);
      E.bDetail.appendChild(doc.createTextNode('New paint in the garage'));
    } else if (r && r.type === 'car') {
      E.bDetail.textContent = 'Parked in your garage — go and try it!';
    } else if (r && r.type === 'list') {
      E.bDetail.textContent = r.items.join('  ·  ');
    }
    E.banner.classList.remove('is-on');
    void E.banner.offsetWidth;
    E.banner.classList.add('is-on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      E.banner.classList.remove('is-on');
      bannerTimer = setTimeout(nextBanner, 350);
    }, r && r.type === 'list' ? 4800 : 3200);
  }

  // Trophies, dailies and the streak: small cards down the left edge.
  function note(kind, title, text, sub) {
    const n = doc.createElement('div');
    n.className = `goal__note goal__note--${kind}`;
    n.innerHTML = `<i class="goal__noteIcon">${ICONS[kind] || ICONS.level}</i><div><b></b><span class="goal__noteText"></span><em></em></div>`;
    n.querySelector('b').textContent = title;
    n.querySelector('.goal__noteText').textContent = text || '';
    n.querySelector('em').textContent = sub || '';
    E.notes.appendChild(n);
    while (E.notes.children.length > 3) E.notes.firstChild.remove();
    setTimeout(() => n.classList.add('is-out'), 4200);
    setTimeout(() => n.remove(), 4700);
  }
  function trophy(name, desc, xp) {
    note('trophy', 'TROPHY UNLOCKED', name, xp ? `${desc}  +${xp} XP` : desc);
  }

  /** A soft full-screen flash; k is its peak opacity, 0..1. */
  function flash(k) {
    E.flash.style.setProperty('--k', String(Math.max(0, Math.min(0.6, k || 0.3))));
    E.flash.classList.remove('is-on');
    void E.flash.offsetWidth;
    E.flash.classList.add('is-on');
  }

  // ---- the moments ------------------------------------------------------------------

  let countTimer = 0;
  /** 3, 2, 1 — then 0 for GO!, and -1 to clear. */
  function countdown(n) {
    clearTimeout(countTimer);
    if (n < 0) { E.count.className = 'goal__count'; E.count.textContent = ''; return; }
    E.count.textContent = n > 0 ? String(n) : 'GO!';
    E.count.className = 'goal__count';
    void E.count.offsetWidth;
    E.count.className = `goal__count is-on${n === 0 ? ' is-go' : ''}`;
    countTimer = setTimeout(() => { E.count.className = 'goal__count'; }, n === 0 ? 900 : 1100);
  }

  function popup(kind, title, sub) {
    const p = doc.createElement('div');
    p.className = `goal__pop goal__pop--${kind}`;
    p.innerHTML = `<i class="goal__popIcon">${ICONS[kind] || ICONS.nav}</i><div><b></b><span></span></div>`;
    p.querySelector('b').textContent = title;
    p.querySelector('span').textContent = sub || '';
    E.pops.appendChild(p);
    while (E.pops.children.length > 3) E.pops.firstChild.remove();
    setTimeout(() => p.classList.add('is-out'), 2300);
    setTimeout(() => p.remove(), 2800);
  }

  function result(r) {
    E.res.dataset.medal = String(r.medal);
    E.res.dataset.kind = r.kind;
    E.resKind.textContent = r.kind === 'race' ? 'FINISH' : KIND_WORD[r.kind] || '';
    E.resName.textContent = r.name;
    E.resMedalWord.textContent = MEDAL_WORD[r.medal] || '';
    E.resScore.textContent = r.score;
    E.resBest.textContent = r.newBest ? `NEW BEST!  was ${r.prevBest}` : r.first ? 'FIRST RUN' : r.best ? `Best ${r.best}` : '';
    E.resBest.classList.toggle('is-new', !!r.newBest);
    const pay = [];
    if (r.cash) pay.push(`+${fmtCash(r.cash)}`);
    if (r.xp) pay.push(`+${r.xp} XP`);
    E.resPay.textContent = pay.join('   ');
    E.resPay.classList.toggle('is-on', pay.length > 0);
    E.resNext.textContent = r.levelUp
      ? `LEVEL ${r.levelUp}!${r.levelReward ? `  ${r.levelReward}` : ''}`
      : r.next ? `Next: ${r.next}` : 'Top of the podium.';
    E.resNext.classList.toggle('is-level', !!r.levelUp);
    E.res.classList.remove('is-on');
    void E.res.offsetWidth;
    E.res.classList.add('is-on');
  }
  function hideResult() { E.res.classList.remove('is-on'); }

  let controlsTimer = 0;
  function controls(show, touch) {
    clearTimeout(controlsTimer);
    if (!show) { E.controls.classList.remove('is-on'); return; }
    E.controls.innerHTML = touch
      ? `<b>How to drive</b>
         <div class="goal__keys"><span><kbd>Right pedal</kbd> go</span><span><kbd>Left pedal</kbd> brake</span><span><kbd>Wheel</kbd> steer</span></div>
         <p>Follow the <em>blue arrows</em> to your first race.</p>`
      : `<b>How to drive</b>
         <div class="goal__keys">
           <span><kbd>W</kbd> go</span><span><kbd>S</kbd> brake</span><span><kbd>A</kbd><kbd>D</kbd> steer</span>
           <span><kbd>Space</kbd> handbrake</span><span><kbd>R</kbd> back on the road</span><span><kbd>G</kbd> next goal</span><span><kbd>M</kbd> map</span>
         </div>
         <p>Follow the <em>blue arrows</em> to your first race.</p>`;
    E.controls.classList.remove('is-on');
    void E.controls.offsetWidth;
    E.controls.classList.add('is-on');
    controlsTimer = setTimeout(() => E.controls.classList.remove('is-on'), 9000);
  }

  function dispose() {
    clearTimeout(countTimer);
    clearTimeout(controlsTimer);
    clearTimeout(endTimer);
    clearTimeout(bannerTimer);
    el.remove();
  }

  return {
    element: el, update, setVisible, countdown, popup, result, hideResult, controls, dispose,
    skill, chainEnd, celebrate, note, trophy, flash,
  };
}
