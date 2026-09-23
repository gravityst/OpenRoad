// The goals, on screen: what to do next, the race clock, the 3-2-1, the medal
// card, the pop when a token is grabbed, and — once, on a first drive — which
// keys do what.
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
// line is compared against what is already on screen first. The layer is
// pointer-events: none except the two buttons on the medal card, and those
// never take focus — a focused button turns the handbrake (Space) into
// "Race again".

const ICONS = {
  race: '<svg viewBox="0 0 24 24"><path d="M5 3v18" stroke="currentColor" stroke-width="2" fill="none"/><path d="M6 4h13l-3 4 3 4H6z" fill="currentColor"/><path d="M9 4h3v4H9zM12 8h3v4h-3z" fill="#0b0e13" opacity=".55"/></svg>',
  trap: '<svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M12 16l5-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16" r="1.8" fill="currentColor"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M2 20h9l-7-5z" fill="currentColor"/><path d="M8 13c3-7 9-8 13-4" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="2 2.5"/><path d="M21 9l-.5 3.5-3-1.8z" fill="currentColor"/></svg>',
  drift: '<svg viewBox="0 0 24 24"><path d="M4 18c4 0 5-5 9-5s4 4 7 4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5 11c3 0 4-4 7-4s3 3 6 3" stroke="currentColor" stroke-width="2" fill="none" opacity=".55" stroke-linecap="round"/></svg>',
  token: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M12 6.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L12 14.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" fill="#0b0e13" opacity=".7"/></svg>',
  level: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" fill="currentColor"/></svg>',
  nav: '<svg viewBox="0 0 24 24"><path d="M12 2l7 18-7-4-7 4z" fill="currentColor"/></svg>',
};
const KIND_WORD = { race: 'RACE', trap: 'SPEED TRAP', jump: 'JUMP', drift: 'DRIFT ZONE' };
const MEDAL_WORD = ['NO MEDAL', 'BRONZE', 'SILVER', 'GOLD'];

function fmtTime(t) {
  if (!(t >= 0)) return '0:00.0';
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600), s = Math.floor((tenths % 600) / 10), d = tenths % 10;
  return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
}
function fmtDist(m) {
  if (!(m >= 0)) return '';
  if (m < 995) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
const fmtCash = (v) => `$${Math.round(v).toLocaleString('en')}`;

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
    </div>
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
    kind: null, title: null, detail: null, dist: null, raceOn: null, zoneOn: null,
    tenths: -1, cp: null, delta: null, tMedal: -1, tText: null, zScore: -1, zMedal: -1, zText: null,
    hint: null, cash: -1, lv: -1, xp: -1,
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
    E.obj.classList.toggle('is-on', showObj);
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
    const dist = o.dist >= 0 ? fmtDist(o.dist) : '';
    if (dist !== last.dist) { last.dist = dist; E.dist.textContent = dist; }

    const r = ui.race;
    const raceOn = r.active && r.phase === 'running';
    if (raceOn !== last.raceOn) { last.raceOn = raceOn; E.race.classList.toggle('is-on', raceOn); }
    if (raceOn) {
      const tenths = Math.floor(r.time * 10);
      if (tenths !== last.tenths) { last.tenths = tenths; E.timer.textContent = fmtTime(r.time); }
      const cp = r.cp >= r.cpTotal - 1 ? 'FINAL GATE' : `GATE ${r.cp + 1} / ${r.cpTotal}`;
      if (cp !== last.cp) { last.cp = cp; E.cp.textContent = cp; }
      if (r.deltaAge < 3 && Number.isFinite(r.delta)) {
        const txt = `${r.delta <= 0 ? '−' : '+'}${Math.abs(r.delta).toFixed(1)}`;
        if (txt !== last.delta) {
          last.delta = txt; E.delta.textContent = txt;
          E.delta.dataset.sign = r.delta <= 0 ? 'ahead' : 'behind';
          E.delta.classList.add('is-on');
        }
      } else if (last.delta !== '') { last.delta = ''; E.delta.classList.remove('is-on'); }
      if (r.targetMedal !== last.tMedal) { last.tMedal = r.targetMedal; E.tMedal.dataset.medal = r.targetMedal; }
      const tt = r.targetMedal ? `${MEDAL_WORD[r.targetMedal]} ${fmtTime(r.targetTime)}` : 'NO MEDAL — FINISH IT!';
      if (tt !== last.tText) { last.tText = tt; E.tText.textContent = tt; }
    }

    const z = ui.zone;
    if (z.active !== last.zoneOn) { last.zoneOn = z.active; E.zone.classList.toggle('is-on', z.active); }
    if (z.active) {
      const sc = Math.round(z.score);
      if (sc !== last.zScore) { last.zScore = sc; E.zScore.textContent = sc.toLocaleString('en'); }
      if (z.targetMedal !== last.zMedal) { last.zMedal = z.targetMedal; E.zMedal.dataset.medal = z.targetMedal; }
      const zt = `${MEDAL_WORD[z.targetMedal]} ${z.targetScore.toLocaleString('en')}`;
      if (zt !== last.zText) { last.zText = zt; E.zText.textContent = zt; }
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
    E.resNext.textContent = r.levelUp ? `LEVEL ${r.levelUp}! New cars within reach` : r.next ? `Next: ${r.next}` : 'Top of the podium.';
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
    el.remove();
  }

  return { element: el, update, setVisible, countdown, popup, result, hideResult, controls, dispose };
}
