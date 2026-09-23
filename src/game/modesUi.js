// The party games, on screen.
//
//   - the TIMING TOWER, top left: the running order in a race (with each
//     car's gap to the leader at the last checkpoint they share), the
//     scoreboard in tag (time free, and who is IT) or coin rush (coins). Rows
//     slide into their new places when the order changes;
//   - the INVITE, top centre: who started what, how long is left to join, and
//     the one key that joins (J, or a tap). For the players already in, the
//     same card counts down the lobby;
//   - the COUNTDOWN (3-2-1-GO off the room's clock) and big BANNERS for the
//     moments that matter: YOU'RE IT, a coin, a checkpoint, the finish;
//   - the PODIUM, three steps and the rest, with Rematch;
//   - on a touch screen, a Say button for the four emotes (keys 1-4 on a
//     keyboard).
//
// It reads game/modes.js's `view` and drains its `events` once a frame; it
// never talks to the room itself. DOM only; styled by styles/multiplayer.css.
// Player names go in with textContent, never innerHTML.

import { GAME_MARK } from './roster.js';
import { EMOTE_TEXT, GAME_NAME, fmtClock, fmtRaceTime } from './modes.js';

const BIG_S = 1.7, SMALL_S = 2.4;      // s a banner stays up
const PODIUM_BAR_MS = 12000;           // the room's podium time (server/modes.js)
const CARD_LATE_S = 6;                 // s a "game under way" card stays before it folds away

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * opts: {
 *   modes              game/modes.js
 *   isTouch
 *   toast(text, css)   the friends toasts (roster.js)
 *   online()           how many friends are in the room
 * }
 */
export function createModesUi(opts) {
  const modes = opts.modes;
  const view = modes.view;
  // Given by main.js, or read from the device: a coarse pointer is a finger.
  const touch = opts.isTouch != null ? !!opts.isTouch
    : typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const toast = opts.toast || (() => {});
  let clock = 0;
  let driving = false;
  let lastSelf = null;

  const root = el('div', 'mpg is-off');

  // ---- the timing tower -------------------------------------------------------
  const tower = el('section', 'mpg-tower');
  tower.hidden = true;
  const tHead = el('header', 'mpg-tower__head');
  const tGame = el('b', 'mpg-tower__game');
  const tName = el('span', 'mpg-tower__name');
  const tClock = el('span', 'mpg-tower__clock');
  tHead.append(tGame, tName, tClock);
  const tRows = el('ol', 'mpg-tower__rows');
  const tFoot = el('footer', 'mpg-tower__foot');
  const tFootText = el('span');
  const tGates = el('span', 'mpg-gates');
  tFoot.append(tFootText, tGates);
  tower.append(tHead, tRows, tFoot);
  root.appendChild(tower);
  const rowEls = new Map();            // id -> row DOM
  const gateTimes = new Map();         // id -> ms at each checkpoint, for gaps

  // ---- the card --------------------------------------------------------------
  const card = el('section', 'mpg-card');
  card.hidden = true;
  const cMark = el('span', 'mpg-card__mark');
  const cText = el('div', 'mpg-card__text');
  const cKind = el('div', 'mpg-card__kind');
  const cTitle = el('div', 'mpg-card__title');
  const cSub = el('div', 'mpg-card__sub');
  const cWho = el('div', 'mpg-card__who');
  cText.append(cKind, cTitle, cSub, cWho);
  const cAct = el('div', 'mpg-card__act');
  const cKey = el('kbd', null, touch ? 'Tap' : 'J');
  const cLabel = el('span', null, 'Join');
  const cSecs = el('b', 'mpg-card__secs');
  cAct.append(cSecs, cKey, cLabel);
  const cTime = el('i', 'mpg-card__time');
  card.append(cMark, cText, cAct, cTime);
  card.addEventListener('click', () => { if (cardAct === 'join') modes.join(); });
  root.appendChild(card);
  let cardAct = '', cardMark = '', cardSeen = -1, cardFirst = 0;
  let tagCountUntil = -1;              // the round's opening count, on this clock

  // ---- countdown and banners ----------------------------------------------------
  const count = el('div', 'mpg-count');
  const countNum = el('b');
  const countCap = el('small');
  count.append(countNum, countCap);
  count.hidden = true;
  root.appendChild(count);
  let countTxt = '';

  const flash = el('div', 'mpg-flash');
  root.appendChild(flash);
  const flashes = [];

  // ---- the podium --------------------------------------------------------------
  const podium = el('section', 'mpg-podium');
  podium.hidden = true;
  const pKind = el('div', 'mpg-podium__kind');
  const pTitle = el('div', 'mpg-podium__title');
  const pSteps = el('div', 'mpg-steps');
  const steps = [2, 1, 3].map((place) => {
    const s = el('div', 'mpg-step');
    s.dataset.place = String(place);
    const name = el('div', 'mpg-step__name');
    const stat = el('div', 'mpg-step__stat');
    const block = el('div', 'mpg-step__block');
    const num = el('span', null, String(place));
    block.appendChild(num);
    s.append(name, stat, block);
    pSteps.appendChild(s);
    return { s, name, stat, block, place };
  });
  const pRest = el('ol', 'mpg-rest');
  const pActs = el('div', 'mpg-podium__acts');
  const pAgain = el('button', 'ormp-btn ormp-btn--go', 'Rematch');
  pAgain.type = 'button';
  if (!touch) pAgain.append(' ', el('kbd', null, 'Enter'));
  const pClose = el('button', 'ormp-btn', 'Close');
  pClose.type = 'button';
  const pBar = el('span', 'mpg-podium__bar');
  const pBarFill = el('i');
  pBar.appendChild(pBarFill);
  pActs.append(pAgain, pClose, pBar);
  podium.append(pKind, pTitle, pSteps, pRest, pActs);
  pAgain.addEventListener('click', () => again());
  pClose.addEventListener('click', () => { podiumClosed = view.gid; podium.hidden = true; });
  root.appendChild(podium);
  let podiumFor = -1, podiumClosed = -1;

  // ---- say, on a touch screen ----------------------------------------------------
  const say = el('div', 'mpg-say');
  say.hidden = !touch;
  const sayOpen = el('button', 'mpg-say__open', 'Say…');
  sayOpen.type = 'button';
  const sayBtns = EMOTE_TEXT.map((t, i) => {
    const b = el('button', null, t);
    b.type = 'button';
    b.hidden = true;
    b.addEventListener('click', () => { modes.emote(i); setSay(false); });
    return b;
  });
  let sayOn = false;
  function setSay(on) { sayOn = on; for (const b of sayBtns) b.hidden = !on; sayOpen.textContent = on ? 'Close' : 'Say…'; }
  sayOpen.addEventListener('click', () => setSay(!sayOn));
  say.append(sayOpen, ...sayBtns);
  root.appendChild(say);

  document.body.appendChild(root);

  // ---- helpers -----------------------------------------------------------------
  function again() {
    if (view.phase !== 'done' || !(view.inGame || view.watching)) return;
    modes.again(lastSelf);
  }

  function banner(text, style, big) {
    const f = el('div', big ? 'mpg-flash__big' : 'mpg-flash__small', text);
    if (style) f.classList.add(style);
    flash.appendChild(f);
    flashes.push({ el: f, left: big ? BIG_S : SMALL_S });
    // One big banner at a time: a new one replaces the old.
    if (big) for (let i = flashes.length - 2; i >= 0; i--) if (flashes[i].el.classList.contains('mpg-flash__big')) { flashes[i].el.remove(); flashes.splice(i, 1); }
    while (flashes.length > 3) flashes.shift().el.remove();
  }

  /** The left column (friends chip, toasts) starts below the tower. */
  let leftTop = -1;
  function placeLeftColumn() {
    const on = !tower.hidden;
    const px = on ? Math.round(tower.getBoundingClientRect().bottom + 12) : 0;
    if (px === leftTop) return;
    leftTop = px;
    if (on) document.documentElement.style.setProperty('--mp-left-top', `max(30vh, ${px}px)`);
    else document.documentElement.style.removeProperty('--mp-left-top');
  }

  // ---- what just happened ----------------------------------------------------------
  function onEvent(e) {
    const my = (id) => id === myId();
    switch (e.k) {
      case 'invite':
        toast(`${modes.nameOf(e.id)} started ${e.kind === 'race' ? 'a race' : e.kind === 'tag' ? 'a game of Tag' : 'a Coin Rush'}${touch ? '' : ' — J to join'}`, modes.cssOf(e.id));
        break;
      case 'started':
        toast(`Invite sent. ${e.kind === 'race' ? 'Line up on the grid' : 'Waiting for friends to join'}`, view.css);
        break;
      case 'watching':
        toast("The race has started. You're watching, and in the next one", view.css);
        break;
      case 'ongrid':
        banner(`Grid slot ${e.slot + 1}`, null, false);
        break;
      case 'jumpstart':
        banner('Wait for GO!', 'is-red', true);
        break;
      case 'go':
        if (e.kind === 'coins') banner('Grab the coins!', 'is-gold', true);
        break;
      case 'tag':
        if (my(e.to)) banner("You're IT!", 'is-red', true);
        else if (my(e.from)) banner(`Tagged ${modes.nameOf(e.to)}! Run!`, 'is-green', true);
        else banner(`${modes.nameOf(e.from)} tagged ${modes.nameOf(e.to)}`, null, false);
        break;
      case 'newit':
        if (my(e.to)) banner("You're IT!", 'is-red', true);
        else banner(`${modes.nameOf(e.to)} is IT now`, null, false);
        break;
      case 'coin':
        if (my(e.id)) banner('+1 coin', 'is-gold', true);
        else banner(`${modes.nameOf(e.id)} grabbed a coin`, null, false);
        break;
      case 'gate':
        if (e.g < e.n) banner(`Checkpoint ${e.g} / ${e.n - 1}`, null, false);
        break;
      case 'fin':
        if (my(e.id)) banner(e.place === 1 ? 'You win!' : `Finished P${e.place}`, e.place === 1 ? 'is-gold' : null, true);
        else banner(`${modes.nameOf(e.id)} finished P${e.place}`, null, false);
        break;
      case 'backon':
        toast('Back on the course at your last checkpoint', view.css);
        break;
      case 'cancel':
        toast(e.why === 'nobody' ? 'Nobody joined this time. Try again when a friend is driving' : 'The game was called off', view.css);
        break;
      case 'left':
        if (view.inGame) toast(`${modes.nameOf(e.id)} left the game`, modes.cssOf(e.id));
        break;
      default: break;
    }
  }
  const myId = () => modes.myId();

  // ---- the tower ----------------------------------------------------------------
  function rowEl(id) {
    let r = rowEls.get(id);
    if (r) return r;
    const li = el('li', 'mpg-row');
    const pos = el('span', 'mpg-row__pos');
    const col = el('i', 'mpg-row__col');
    const name = el('span', 'mpg-row__name');
    const tag = el('span', 'mpg-row__tag');
    const stat = el('span', 'mpg-row__stat');
    li.append(pos, col, name, tag, stat);
    tRows.appendChild(li);
    r = { li, pos, col, name, tag, stat, p: '', n: '', c: '', t: null, s: '', y: -1, me: null, seen: 0 };
    rowEls.set(id, r);
    return r;
  }

  function gapText(row, leader) {
    if (row.fin) return fmtRaceTime(row.fin);
    if (row === leader || !row.g) return '';
    const lt = gateTimes.get(leader.id);
    const at = lt ? lt[row.g] : NaN;
    if (!(at >= 0)) return '';
    const gap = (row.ms - at) / 1000;
    return gap >= 0 ? `+${gap.toFixed(1)}` : '';
  }

  let footSig = '', headSig = '', rowsN = -1, gatesSig = '';
  function renderTower() {
    const rows = view.rows;
    const t = view.kind;
    const leader = rows[0];
    // Remember when everyone went through each checkpoint: the gaps.
    if (t === 'race') {
      for (const r of rows) {
        let a = gateTimes.get(r.id);
        if (!a) { a = new Float64Array(33).fill(NaN); gateTimes.set(r.id, a); }
        if (r.g > 0 && r.g < 33 && !(a[r.g] >= 0)) a[r.g] = r.ms;
      }
    }
    for (const r of rowEls.values()) r.seen = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const o = rowEl(row.id);
      o.seen = 1;
      const p = String(row.pos);
      if (o.p !== p) { o.pos.textContent = p; o.li.dataset.pos = p; o.p = p; }
      if (o.n !== row.name) { o.name.textContent = row.name; o.n = row.name; }
      if (o.c !== row.css) { o.col.style.color = row.css; o.c = row.css; }
      const isIt = t === 'tag' && view.it === row.id;
      const tag = isIt ? 'IT' : '';
      if (o.t !== tag) { o.tag.textContent = tag; o.tag.hidden = !tag; o.t = tag; }
      const s = t === 'race' ? gapText(row, leader) : row.stat;
      if (o.s !== s) { o.stat.textContent = s; o.s = s; }
      if (o.me !== row.me) { o.li.classList.toggle('is-me', row.me); o.me = row.me; }
      if (o.y !== i) { o.li.style.transform = `translateY(calc(var(--row) * ${i}))`; o.y = i; }
    }
    for (const [id, o] of rowEls) if (!o.seen) { o.li.remove(); rowEls.delete(id); }
    if (rowsN !== rows.length) { tRows.style.height = `calc(var(--row) * ${rows.length})`; rowsN = rows.length; leftTop = -2; }

    // Head: the game, what it is, and the clock that matters.
    const game = t === 'race' ? 'Race' : GAME_NAME[t];
    const name = t === 'race' ? view.name : t === 'tag' ? (view.it >= 0 ? `${view.itName} is IT` : 'Get ready') : `${view.coinsLeft} coins left`;
    const clk = view.phase === 'lobby' ? fmtClock(view.lobbyLeft)
      : t === 'race' ? (view.finished ? fmtRaceTime(view.myFin)
        : view.phase === 'run' ? fmtRaceTime(view.inGame ? view.myTime : Math.max(0, -view.goIn))
          : view.phase === 'done' ? '' : '0:00.0')
        : view.phase === 'done' ? '' : fmtClock(view.clockLeft);
    const hs = game + '|' + name;
    if (headSig !== hs) { tGame.textContent = game; tName.textContent = name; headSig = hs; }
    if (tClock.textContent !== clk) tClock.textContent = clk;

    // Foot: what to do now.
    let foot = '', hot = false;
    if (view.phase === 'lobby') foot = view.inGame ? `Waiting for players · ${view.entrants} in` : '';
    else if (t === 'race') {
      if (view.watching) foot = "Watching · you're in the next one";
      else if (view.phase === 'grid') foot = 'On the grid';
      else if (view.finished) foot = `Finished · P${view.myPlace}`;
      else foot = `Checkpoint ${Math.min(view.next + 1, view.n)} / ${view.n}`;
    } else if (t === 'tag') {
      if (view.readyIn > 0 && clock < tagCountUntil) foot = view.iAmIt ? 'You are IT · count to three' : `Run! ${view.itName} is counting`;
      else if (view.iAmIt) { foot = "You're IT · tag someone"; hot = true; }
      else foot = `Keep away from ${view.itName}`;
    } else if (t === 'coins') foot = `${view.coinsLeft} coin${view.coinsLeft === 1 ? '' : 's'} left · race for them`;
    if (view.phase === 'done') {
      let me = null;
      for (let i = 0; i < rows.length; i++) if (rows[i].me) me = rows[i];
      foot = t === 'race' ? (view.finished ? `Finished · P${view.myPlace}` : view.inGame ? 'Out of time' : 'Race over')
        : me ? `Final · P${me.pos}` : 'Final';
    }
    const fs = foot + (hot ? '!' : '');
    if (footSig !== fs) { tFootText.textContent = foot; tFoot.classList.toggle('is-hot', hot); tFoot.hidden = !foot; footSig = fs; }
    // Checkpoint pips.
    const gs = t === 'race' && view.inGame && view.phase === 'run' ? `${view.next}/${view.n}` : '';
    if (gs !== gatesSig) {
      gatesSig = gs;
      tGates.textContent = '';
      if (gs) for (let k = 0; k < view.n; k++) { const i = el('i'); if (k < view.next) i.className = 'is-done'; tGates.appendChild(i); }
    }
  }

  // ---- the card ---------------------------------------------------------------------
  let cardSig = '', whoSig = '';
  function renderCard() {
    const v = view;
    let show = false, kind = '', title = '', sub = '', act = '', label = '', secs = '', frac = -1;
    if (v.kind && v.phase !== 'done' && !v.unknown) {
      const verb = v.kind === 'race' ? 'wants to race' : v.kind === 'tag' ? 'wants to play Tag' : 'started a Coin Rush';
      if (v.phase === 'lobby') {
        show = true;
        kind = v.kind === 'race' ? 'Race invite' : v.kind === 'tag' ? 'Tag' : 'Coin Rush';
        secs = String(Math.ceil(v.lobbyLeft / 1000));
        frac = Math.min(1, v.lobbyLeft / 15000);
        if (v.inGame) {
          title = v.host === myId() ? 'Waiting for friends' : "You're in";
          sub = v.kind === 'race' ? `${v.name} · starting when the invite runs out` : 'Starting when the invite runs out';
          act = 'leave'; label = 'Backspace leaves';
        } else {
          title = `${v.hostName} ${verb}`;
          sub = v.kind === 'race' ? `${v.name} · ${(v.race.length / 1000).toFixed(1)} km · ${v.n} checkpoints` : v.kind === 'tag' ? "One car is IT. Don't be IT when time runs out" : '12 coins on the roads nearby';
          act = 'join'; label = 'Join';
        }
      } else if (!v.inGame && !v.watching) {
        // A game under way: a short nudge, once per game, then it folds away.
        if (cardSeen !== v.gid) { cardSeen = v.gid; cardFirst = clock; }
        if (clock - cardFirst < CARD_LATE_S) {
          show = true;
          kind = GAME_NAME[v.kind];
          title = v.kind === 'race' ? 'Race under way' : `${GAME_NAME[v.kind]} is on`;
          sub = `${v.entrants} playing${v.kind === 'race' ? ` · ${v.name}` : ` · ${fmtClock(v.clockLeft)} left`}`;
          act = 'join'; label = v.kind === 'race' ? 'Watch' : 'Join';
        }
      }
    }
    if (card.hidden === show) card.hidden = !show;
    cardAct = show ? act : '';
    if (!show) return;
    if (cardMark !== v.kind) { cMark.innerHTML = GAME_MARK[v.kind] || ''; cardMark = v.kind; }   // static markup
    const sig = kind + '|' + title + '|' + sub + '|' + label + '|' + act;
    if (cardSig !== sig) {
      cKind.textContent = kind; cTitle.textContent = title; cSub.textContent = sub; cLabel.textContent = label;
      cKey.hidden = act !== 'join';
      card.classList.toggle('is-mine', act !== 'join');
      cardSig = sig;
    }
    if (cSecs.textContent !== secs) cSecs.textContent = secs;
    cTime.hidden = frac < 0;
    if (frac >= 0) cTime.style.transform = `scaleX(${frac.toFixed(3)})`;
    // Who is in so far.
    const ws = v.rows.map((r) => r.id).join(',');
    if (ws !== whoSig) {
      whoSig = ws;
      cWho.textContent = '';
      for (const r of v.rows) {
        const s = el('span');
        const i = el('i'); i.style.color = r.css;
        s.append(i, r.name);
        cWho.appendChild(s);
      }
    }
  }

  // ---- the countdown -------------------------------------------------------------------
  function renderCount() {
    const v = view;
    let num = '', cap = '', go = false;
    if (v.kind === 'race' && (v.inGame || v.watching) && (v.phase === 'grid' || (v.phase === 'run' && v.goIn > -900))) {
      if (v.goIn > 3000) { num = ''; cap = 'Get ready'; }
      else if (v.goIn > 0) { num = String(Math.ceil(v.goIn / 1000)); cap = v.name; }
      else { num = 'GO'; go = true; }
    } else if (v.kind === 'tag' && v.inGame && v.phase === 'run' && clock < tagCountUntil && v.readyIn > 0) {
      num = String(Math.ceil(v.readyIn / 1000));
      cap = v.iAmIt ? "You're IT · count to three" : `Run! ${v.itName} is IT`;
    }
    const show = !!(num || cap);
    if (count.hidden === show) count.hidden = !show;
    if (!show) { countTxt = ''; return; }
    if (num !== countTxt) {
      countNum.textContent = num;
      countNum.className = go ? 'is-go' : 'is-tick';
      // Restart the tick animation for every new number.
      void countNum.offsetWidth;
      countTxt = num;
    }
    if (countCap.textContent !== cap) countCap.textContent = cap;
    countCap.hidden = !cap;
  }

  // ---- the podium -----------------------------------------------------------------------
  function renderPodium() {
    const v = view;
    const show = v.phase === 'done' && (v.inGame || v.watching || podiumFor === v.gid) && podiumClosed !== v.gid;
    if (show && podiumFor !== v.gid) {
      podiumFor = v.gid;
      pKind.textContent = v.kind === 'race' ? 'Race result' : v.kind === 'tag' ? 'Tag · most time free' : 'Coin Rush · most coins';
      pTitle.textContent = v.kind === 'race' ? v.name : v.rows[0] ? `${v.rows[0].name} wins!` : 'Finished';
      const byPlace = [];
      for (const r of v.rows) byPlace.push(r);
      for (const st of steps) {
        const r = byPlace.find((q) => q.pos === st.place && (v.kind !== 'race' || q.fin));
        st.s.classList.toggle('is-empty', !r);
        st.s.classList.toggle('is-me', !!r && r.me);
        st.name.textContent = r ? r.name : '';
        st.name.style.color = '';
        st.block.style.color = r ? r.css : '';
        st.stat.textContent = r ? (v.kind === 'race' ? fmtRaceTime(r.fin) : v.kind === 'coins' ? `${r.stat} coin${r.stat === '1' ? '' : 's'}` : `${r.stat} free`) : '';
      }
      pRest.textContent = '';
      for (const r of byPlace) {
        if (r.pos <= 3 && (v.kind !== 'race' || r.fin)) continue;
        const li = el('li');
        li.append(el('span', null, v.kind === 'race' && !r.fin ? 'DNF' : `P${r.pos}`), el('span', null, r.name), el('span', null, v.kind === 'race' ? (r.fin ? fmtRaceTime(r.fin) : '') : r.stat));
        pRest.appendChild(li);
      }
      pRest.hidden = !pRest.children.length;
      pAgain.hidden = !(v.inGame || v.watching);
    }
    if (podium.hidden === show) podium.hidden = !show;
    if (show) pBarFill.style.transform = `scaleX(${Math.max(0, Math.min(1, v.clockLeft / PODIUM_BAR_MS)).toFixed(3)})`;
  }

  // ---- keys ---------------------------------------------------------------------------
  function onKey(e) {
    if (!driving || e.metaKey || e.ctrlKey || e.altKey) return;
    const tagName = e.target && e.target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
    const k = e.code;
    if (/^Digit[1-4]$/.test(k)) { if (!e.repeat) modes.emote(+k.slice(5) - 1); return; }
    if (k === 'KeyJ' && !e.repeat && cardAct === 'join') { modes.join(); return; }
    if ((k === 'Enter' || k === 'NumpadEnter') && !podium.hidden && !e.repeat) { again(); e.preventDefault(); return; }
    if (k === 'Backspace' && !e.repeat) {
      if (!podium.hidden) { podiumClosed = view.gid; podium.hidden = true; e.preventDefault(); }
      else if (view.inGame && view.phase !== 'done') { modes.leave(); toast(`You left the ${view.kind === 'race' ? 'race' : 'game'}`, view.css); e.preventDefault(); }
    }
  }
  window.addEventListener('keydown', onKey);

  // ---- per frame -------------------------------------------------------------------------
  let told = false;
  /**
   * driving: the player has the wheel and no menu is up. self: where this car
   * is drawn (for coin spots on a rematch).
   */
  function update(dt, isDriving, self) {
    clock += dt;
    driving = isDriving;
    lastSelf = self;
    // News first, whatever is showing.
    for (let i = 0; i < modes.events.length; i++) {
      const e = modes.events[i];
      if (e.k === 'go' && e.kind === 'tag') tagCountUntil = clock + 3.2;
      onEvent(e);
    }
    modes.events.length = 0;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.left -= dt;
      if (f.left < 0.35 && !f.el.classList.contains('is-out')) f.el.classList.add('is-out');
      if (f.left <= 0) { f.el.remove(); flashes.splice(i, 1); }
    }
    const on = driving && !!view.kind;
    root.classList.toggle('is-off', !driving);
    if (root.dataset.kind !== view.kind) root.dataset.kind = view.kind;
    // The one-time hint: emotes exist.
    if (!told && driving && opts.online && opts.online() > 0) {
      told = true;
      toast(touch ? 'Tap Say… to wave at your friends' : 'Press 1, 2, 3 or 4 to say Hi, Follow me, Wait up or Nice one', '#eef4fa');
    }
    const tw = on && (view.inGame || view.watching) && view.rows.length > 0;
    if (tower.hidden === tw) { tower.hidden = !tw; leftTop = -2; }
    if (tw) renderTower();
    renderCard();
    renderCount();
    renderPodium();
    if (leftTop < 0) placeLeftColumn();
    if (touch && say.hidden !== !(driving && opts.online && opts.online() > 0)) say.hidden = !(driving && opts.online && opts.online() > 0);
  }

  function dispose() {
    window.removeEventListener('keydown', onKey);
    root.remove();
    document.documentElement.style.removeProperty('--mp-left-top');
  }

  return { update, dispose, banner, element: root };
}
