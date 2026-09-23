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
  let podiumFor = -1, podiumClosed = -1, podiumBar = -1;

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
      // 'invite' and 'started' say nothing here: the card at the top says it,
      // and a toast as well was the same news twice.
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
    r = { li, pos, col, name, tag, stat, p: -1, n: '', c: '', t: null, s: '', sk: NaN, y: -1, me: null, seen: 0 };
    rowEls.set(id, r);
    return r;
  }

  /**
   * What a race row's figure shows, as one number, so its text is rebuilt
   * only when that changes: a finishing time (> 0), a gap to the leader at
   * the last checkpoint both have passed (-1 - tenths), or nothing (0).
   */
  function gapKey(row, leader) {
    if (row.fin) return row.fin;
    if (row === leader || !row.g) return 0;
    const lt = gateTimes.get(leader.id);
    const at = lt ? lt[row.g] : NaN;
    if (!(at >= 0) || row.ms < at) return 0;
    return -1 - Math.round((row.ms - at) / 100);
  }
  function gapText(k) {
    return k > 0 ? fmtRaceTime(k) : k < 0 ? `+${((-1 - k) / 10).toFixed(1)}` : '';
  }

  // What the head, clock and foot were last drawn from. Each is rebuilt only
  // when one of its inputs changes — a string a frame per line, sixty times a
  // second, for text that changes a few times a second at most, is exactly
  // the per-frame garbage the rest of the game is written to avoid.
  const was = {
    kind: '', name: '', it: -2, itName: '', coins: -1,                        // head
    ck: NaN,                                                                   // clock
    phase: '', inGame: null, watching: null, finished: null, place: -1,       // foot
    next: -1, n: -1, counting: null, iAmIt: null, entrants: -1,
    fKind: '', fIt: -2, fItName: '', fCoins: -1, fMe: -1,
  };
  let rowsN = -1, gatesN = -1, gatesDone = -1;
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
      if (o.p !== row.pos) { const p = String(row.pos); o.pos.textContent = p; o.li.dataset.pos = p; o.p = row.pos; }
      if (o.n !== row.name) { o.name.textContent = row.name; o.n = row.name; }
      if (o.c !== row.css) { o.col.style.color = row.css; o.c = row.css; }
      const isIt = t === 'tag' && view.it === row.id;
      const tag = isIt ? 'IT' : '';
      if (o.t !== tag) { o.tag.textContent = tag; o.tag.hidden = !tag; o.t = tag; }
      if (t === 'race') {
        const k = gapKey(row, leader);
        if (o.sk !== k) { o.sk = k; o.s = gapText(k); o.stat.textContent = o.s; }
      } else if (o.s !== row.stat) { o.sk = NaN; o.stat.textContent = row.stat; o.s = row.stat; }
      if (o.me !== row.me) { o.li.classList.toggle('is-me', row.me); o.me = row.me; }
      if (o.y !== i) { o.li.style.transform = `translateY(calc(var(--row) * ${i}))`; o.y = i; }
    }
    for (const [id, o] of rowEls) if (!o.seen) { o.li.remove(); rowEls.delete(id); }
    if (rowsN !== rows.length) { tRows.style.height = `calc(var(--row) * ${rows.length})`; rowsN = rows.length; leftTop = -2; }

    // Head: the game, what it is, and the clock that matters.
    if (was.kind !== t || was.name !== view.name || was.it !== view.it || was.itName !== view.itName || was.coins !== view.coinsLeft) {
      was.kind = t; was.name = view.name; was.it = view.it; was.itName = view.itName; was.coins = view.coinsLeft;
      tGame.textContent = t === 'race' ? 'Race' : GAME_NAME[t];
      tName.textContent = t === 'race' ? view.name : t === 'tag' ? (view.it >= 0 ? `${view.itName} is IT` : 'Get ready') : `${view.coinsLeft} coins left`;
      was.ck = NaN;
    }
    // The clock as one number: whole seconds (a round or lobby clock, +), tenths
    // of a race (-1 - tenths), or blank (0). Its text is built when that moves.
    const race = t === 'race' && view.phase !== 'lobby';
    const cms = view.phase === 'lobby' ? view.lobbyLeft
      : race ? (view.finished ? view.myFin : view.phase === 'run' ? (view.inGame ? view.myTime : Math.max(0, -view.goIn)) : view.phase === 'done' ? -1 : 0)
        : view.phase === 'done' ? -1 : view.clockLeft;
    const ck = cms < 0 ? 0 : race ? -1 - Math.floor(cms / 100) : 1 + Math.max(0, Math.ceil(cms / 1000));
    if (was.ck !== ck) { was.ck = ck; tClock.textContent = ck === 0 ? '' : race ? fmtRaceTime(cms) : fmtClock(cms); }

    // Foot: what to do now.
    const counting = view.readyIn > 0 && clock < tagCountUntil;
    let mePos = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i].me) mePos = rows[i].pos;
    if (was.phase === view.phase && was.inGame === view.inGame && was.watching === view.watching && was.finished === view.finished &&
      was.place === view.myPlace && was.next === view.next && was.n === view.n && was.counting === counting &&
      was.iAmIt === view.iAmIt && was.entrants === view.entrants && was.fKind === t && was.fIt === view.it &&
      was.fItName === view.itName && was.fCoins === view.coinsLeft && was.fMe === mePos) {
      renderGates();
      return;
    }
    was.phase = view.phase; was.inGame = view.inGame; was.watching = view.watching; was.finished = view.finished;
    was.place = view.myPlace; was.next = view.next; was.n = view.n; was.counting = counting;
    was.iAmIt = view.iAmIt; was.entrants = view.entrants;
    was.fKind = t; was.fIt = view.it; was.fItName = view.itName; was.fCoins = view.coinsLeft; was.fMe = mePos;
    let foot = '', hot = false;
    if (view.phase === 'lobby') foot = view.inGame ? `Waiting for players · ${view.entrants} in` : '';
    else if (t === 'race') {
      if (view.watching) foot = "Watching · you're in the next one";
      else if (view.phase === 'grid') foot = 'On the grid';
      else if (view.finished) foot = `Finished · P${view.myPlace}`;
      else foot = `Checkpoint ${Math.min(view.next + 1, view.n)} / ${view.n}`;
    } else if (t === 'tag') {
      if (counting) foot = view.iAmIt ? 'You are IT · count to three' : `Run! ${view.itName} is counting`;
      else if (view.iAmIt) { foot = "You're IT · tag someone"; hot = true; }
      else foot = `Keep away from ${view.itName}`;
    } else if (t === 'coins') foot = `${view.coinsLeft} coin${view.coinsLeft === 1 ? '' : 's'} left · race for them`;
    if (view.phase === 'done') {
      foot = t === 'race' ? (view.finished ? `Finished · P${view.myPlace}` : view.inGame ? 'Out of time' : 'Race over')
        : mePos > 0 ? `Final · P${mePos}` : 'Final';
    }
    if (tFootText.textContent !== foot) tFootText.textContent = foot;
    tFoot.classList.toggle('is-hot', hot);
    tFoot.hidden = !foot;
    renderGates();
  }

  /** Checkpoint pips: rebuilt when the race or the count changes, not per frame. */
  function renderGates() {
    const on = view.kind === 'race' && view.inGame && view.phase === 'run';
    const n = on ? view.n : 0, done = on ? view.next : 0;
    if (n === gatesN && done === gatesDone) return;
    gatesN = n; gatesDone = done;
    tGates.textContent = '';
    for (let k = 0; k < n; k++) { const i = el('i'); if (k < done) i.className = 'is-done'; tGates.appendChild(i); }
  }

  // ---- the card ---------------------------------------------------------------------
  // What the card was last built from (see `was` above: the same idea).
  const cw = { kind: '', phase: '', inGame: null, host: -2, hostName: '', name: '', entrants: -1, late: null, clk: -1, secs: -1, frac: -1, ids: new Int32Array(16), nIds: -1 };
  let cardShow = false;
  function renderCard() {
    const v = view;
    // Whether it shows, and whether anything it says has changed. Everything
    // below that builds a string runs only when this says so.
    let show = false, late = false;
    if (v.kind && v.phase !== 'done' && !v.unknown) {
      if (v.phase === 'lobby') show = true;
      else if (!v.inGame && !v.watching) {
        // A game under way: a short nudge, once per game, then it folds away.
        if (cardSeen !== v.gid) { cardSeen = v.gid; cardFirst = clock; }
        late = show = clock - cardFirst < CARD_LATE_S;
      }
    }
    if (card.hidden === show) card.hidden = !show;
    if (!show) { cardAct = ''; cardShow = false; return; }
    const clk = late && v.kind !== 'race' ? Math.ceil(v.clockLeft / 1000) : -1;
    if (!cardShow || cw.kind !== v.kind || cw.phase !== v.phase || cw.inGame !== v.inGame || cw.host !== v.host || cw.hostName !== v.hostName ||
      cw.name !== v.name || cw.entrants !== v.entrants || cw.late !== late || cw.clk !== clk) {
      cw.kind = v.kind; cw.phase = v.phase; cw.inGame = v.inGame; cw.host = v.host; cw.hostName = v.hostName;
      cw.name = v.name; cw.entrants = v.entrants; cw.late = late; cw.clk = clk;
      buildCard(v);
    }
    cardShow = true;
    const secs = v.phase === 'lobby' ? Math.ceil(v.lobbyLeft / 1000) : -1;
    if (cw.secs !== secs) { cw.secs = secs; cSecs.textContent = secs >= 0 ? String(secs) : ''; }
    const frac = v.phase === 'lobby' ? Math.round(Math.min(1, v.lobbyLeft / 15000) * 400) : -1;   // 400 steps: under a pixel
    if (cw.frac !== frac) {
      cw.frac = frac;
      cTime.hidden = frac < 0;
      if (frac >= 0) cTime.style.transform = `scaleX(${(frac / 400).toFixed(4)})`;
    }
    // Who is in so far: rebuilt when the ids in it change.
    let same = cw.nIds === v.rows.length;
    for (let i = 0; same && i < v.rows.length && i < cw.ids.length; i++) same = cw.ids[i] === v.rows[i].id;
    if (!same) {
      cw.nIds = v.rows.length;
      for (let i = 0; i < v.rows.length && i < cw.ids.length; i++) cw.ids[i] = v.rows[i].id;
      cWho.textContent = '';
      for (const r of v.rows) {
        const s = el('span');
        const i = el('i'); i.style.color = r.css;
        s.append(i, r.name);
        cWho.appendChild(s);
      }
    }
  }

  /** The card's words: only when renderCard() says something changed. */
  function buildCard(v) {
    let kind, title, sub, act, label;
    if (v.phase === 'lobby') {
      kind = v.kind === 'race' ? 'Race invite' : v.kind === 'tag' ? 'Tag' : 'Coin Rush';
      if (v.inGame) {
        title = v.host === myId() ? 'Waiting for friends' : "You're in";
        sub = v.kind === 'race' ? `${v.name} · starting when the invite runs out` : 'Starting when the invite runs out';
        act = 'leave'; label = 'Backspace leaves';
      } else {
        const verb = v.kind === 'race' ? 'wants to race' : v.kind === 'tag' ? 'wants to play Tag' : 'started a Coin Rush';
        title = `${v.hostName} ${verb}`;
        sub = v.kind === 'race' ? `${v.name} · ${(v.race.length / 1000).toFixed(1)} km · ${v.n} checkpoints` : v.kind === 'tag' ? "One car is IT. Don't be IT when time runs out" : '12 coins on the roads nearby';
        act = 'join'; label = 'Join';
      }
    } else {
      kind = GAME_NAME[v.kind];
      title = v.kind === 'race' ? 'Race under way' : `${GAME_NAME[v.kind]} is on`;
      sub = `${v.entrants} playing${v.kind === 'race' ? ` · ${v.name}` : ` · ${fmtClock(v.clockLeft)} left`}`;
      act = 'join'; label = v.kind === 'race' ? 'Watch' : 'Join';
    }
    cardAct = act;
    if (cardMark !== v.kind) { cMark.innerHTML = GAME_MARK[v.kind] || ''; cardMark = v.kind; }   // static markup
    cKind.textContent = kind; cTitle.textContent = title; cSub.textContent = sub; cLabel.textContent = label;
    cKey.hidden = act !== 'join';
    card.classList.toggle('is-mine', act !== 'join');
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
    if (show) {
      const q = Math.round(Math.max(0, Math.min(1, v.clockLeft / PODIUM_BAR_MS)) * 400);   // 400 steps: under a pixel
      if (q !== podiumBar) { podiumBar = q; pBarFill.style.transform = `scaleX(${(q / 400).toFixed(4)})`; }
    }
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
