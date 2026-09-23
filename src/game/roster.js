// The party panel, and every other place the game tells you where people are.
//
//   - a chip on the left while you drive: "2 friends online · Tab". It is the
//     touch button too; tap it.
//   - Tab opens the party panel:
//       FRIENDS ONLINE — everyone, nearest first, with how far and which way,
//       and two buttons each. GO puts you on the road right behind them. GUIDE
//       draws a route to them along the roads and keeps it pointing at them.
//       PLAY TOGETHER — the party games (game/modes.js): a race (pick which
//       with the arrows), tag, coin rush. Start one and everyone gets an
//       invite; while one is on, its row joins, leaves or rematches it.
//   - toasts when someone joins or leaves, when the guide gets you there, and
//     for the party games' news;
//   - a banner while you are being guided;
//   - on the title screen, "3 friends online", with a button per friend: pick
//     one and Play starts you next to them (otherwise, next to the nearest);
//   - on the full map, a pin for everyone; click one for Go and Guide.
//
// DOM only, no three.js; styled by styles/multiplayer.css. The pins and the
// badge are ADDED to the menu screens found by class name, never by editing
// menus.js; if a class is not there any more, that one feature quietly does
// not appear. Everything a player typed (their name) goes in with
// textContent, never innerHTML — the name rules in protocol.js keep it ASCII,
// and this keeps it text. innerHTML is used only for the static SVG marks.

import { carName } from './party.js';

const TOAST_S = 4.2;
const MAX_TOASTS = 3;

const ARROW_SVG = '<svg viewBox="0 0 24 24" class="ormp-arrow" aria-hidden="true"><path d="M12 2 L20 20 L12 15 L4 20 Z" fill="currentColor"/></svg>';

/** The three games' marks: a chequered flag, a tag burst, a coin. */
export const GAME_MARK = {
  race: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 3v27" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M7 4c5-2 9 2 14 0s5-1 6-1v14c-1 0-2 0-6 1s-9-2-14 0z" fill="currentColor" opacity=".25"/>' +
    '<path d="M7 4c2.5-1 4.5-.2 6.7.5V9C11.5 8.3 9.5 7.5 7 8.5zM13.7 9c2.2.7 4.2 1.5 6.7.6v4.4c-2.5.9-4.5.1-6.7-.6zM20.4 4.7c2.4-.9 4.1-1.4 6.6-1.4v4.4c-2.5 0-4.2.5-6.6 1.4zM7 12.5c2.5-1 4.5-.2 6.7.5v4.4c-2.2-.7-4.2-1.5-6.7-.5zM20.4 14c2.4-.9 4.1-1.4 6.6-1.4V17c-2.5 0-4.2.5-6.6 1.4z" fill="currentColor"/></svg>',
  tag: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 1.5l3.1 6.4 6.9-2.2-2.2 6.9 6.7 3.4-6.7 3.4 2.2 6.9-6.9-2.2L16 30.5l-3.1-6.4-6.9 2.2 2.2-6.9L1.5 16l6.7-3.4-2.2-6.9 6.9 2.2z" fill="currentColor"/>' +
    '<text x="16" y="20.2" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="900" font-size="10.5" fill="#150d05">IT</text></svg>',
  coins: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="currentColor"/><circle cx="16" cy="16" r="9.6" fill="none" stroke="#150d05" stroke-width="1.6" opacity=".45"/>' +
    '<path d="M16 9.4l1.9 4 4.4.5-3.3 3 .9 4.3L16 19l-3.9 2.2.9-4.3-3.3-3 4.4-.5z" fill="#150d05" opacity=".7"/></svg>',
};

const GAME_ROWS = [
  { kind: 'race', name: 'Race', sub: 'Everyone on one grid, first to the finish' },
  { kind: 'tag', name: 'Tag', sub: "One car is IT. Don't be IT when the clock runs out" },
  { kind: 'coins', name: 'Coin Rush', sub: '12 coins on the roads nearby. Grab more than anyone' },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function fmtDist(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * opts: {
 *   party, net,
 *   modes              game/modes.js, or null (no party games)
 *   isTouch            bool — wording and the chip-as-button
 *   onGo(id)           put the player next to them (main.js)
 *   onGuide(id)        start guiding (main.js)
 *   onStopGuide()
 * }
 */
export function createRoster(opts) {
  const party = opts.party;
  const net = opts.net;
  const modes = opts.modes || null;
  // Given by main.js, or read from the device: a coarse pointer is a finger.
  const touch = opts.isTouch != null ? !!opts.isTouch
    : typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let menus = null;
  let mode = 'title';
  let open = false;
  let sel = 0;
  let disposed = false;
  let lastSelf = null;

  const root = el('div', 'ormp');

  // ---- the chip ----------------------------------------------------------
  const chip = el('button', 'ormp-chip');
  chip.type = 'button';
  chip.hidden = true;
  const chipDots = el('span', 'ormp-dots');
  const chipText = el('span', null, '');
  const chipKey = el('kbd', null, 'Tab');
  chip.append(chipDots, chipText);
  if (!touch) chip.append(chipKey);
  chip.addEventListener('click', () => toggle());
  root.appendChild(chip);

  // ---- the panel -----------------------------------------------------------
  const panel = el('section', 'ormp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Party');
  const head = el('div', 'ormp-head');
  const title = el('div', 'ormp-title', 'Party');
  const x = el('button', 'ormp-x', 'Close');
  x.type = 'button';
  if (!touch) x.append(el('kbd', null, 'Tab'));
  x.addEventListener('click', () => close());
  head.append(title, x);
  const secFriends = el('div', 'ormp-sec', 'Friends online');
  const rows = el('div', 'ormp-rows');
  const empty = el('div', 'ormp-empty');
  const secGames = el('div', 'ormp-sec', 'Play together');
  const games = el('div', 'ormp-games');
  const foot = el('div', 'ormp-foot');
  if (touch) foot.textContent = 'GO jumps you right behind a friend. GUIDE shows the way along the roads. START a game and everyone gets an invite.';
  else {
    foot.append(
      el('kbd', null, '↑'), ' ', el('kbd', null, '↓'), ' pick  ',
      el('kbd', null, 'Enter'), ' go / start  ', el('kbd', null, 'G'), ' guide  ',
      el('kbd', null, '←'), ' ', el('kbd', null, '→'), ' which race  ',
      el('kbd', null, '1'), '–', el('kbd', null, '4'), ' say hi',
    );
  }
  panel.append(head, secFriends, rows, empty, secGames, games, foot);
  if (!modes) { secGames.hidden = true; games.hidden = true; }
  root.appendChild(panel);

  // ---- toasts and the guide banner ---------------------------------------
  const toasts = el('div', 'ormp-toasts');
  toasts.setAttribute('aria-live', 'polite');
  // Hidden from birth. update() shows it once the game is on the road, but the
  // welcome arrives while boot is still loading layers — created visible, the
  // "1 friend online" toast sat across the OPEN ROAD wordmark for a moment.
  toasts.hidden = true;
  root.appendChild(toasts);
  const live = [];

  const banner = el('div', 'ormp-guide');
  banner.hidden = true;
  const bDot = el('i', 'ormp-dot');
  const bText = el('span', null, '');
  const bHint = el('small', null, touch ? 'tap Party to stop' : 'Tab to change');
  banner.append(bDot, bText, bHint);
  root.appendChild(banner);

  document.body.appendChild(root);

  // ---- friend rows, pooled, rebuilt only when what they say changes -----------
  const rowEls = [];
  function rowEl(i) {
    if (rowEls[i]) return rowEls[i];
    const r = el('div', 'ormp-row');
    const dot = el('i', 'ormp-dot');
    const who = el('div', 'ormp-who');
    const name = el('div', 'ormp-name');
    const car = el('div', 'ormp-car');
    who.append(name, car);
    const where = el('div', 'ormp-where');
    const arrowWrap = el('span');
    arrowWrap.innerHTML = ARROW_SVG;              // static markup, no player text
    const arrow = arrowWrap.firstChild;
    const dist = el('span');
    where.append(arrow, dist);
    const btns = el('div', 'ormp-btns');
    const go = el('button', 'ormp-btn ormp-btn--go', 'Go');
    const gd = el('button', 'ormp-btn', 'Guide');
    go.type = 'button'; gd.type = 'button';
    btns.append(go, gd);
    r.append(dot, who, where, btns);
    rows.appendChild(r);
    const o = { r, dot, name, car, arrow, dist, go, gd, id: -1, txt: '', ctxt: '', dtxt: '', col: '', ang: '', on: null, sel: null, here: null, block: null };
    go.addEventListener('click', () => { if (o.id >= 0) doGo(o.id); });
    gd.addEventListener('click', () => { if (o.id >= 0) doGuide(o.id); });
    r.addEventListener('pointerenter', () => { sel = i; });
    rowEls[i] = o;
    return o;
  }

  function doGo(id) {
    close();
    if (opts.onGo) opts.onGo(id);
  }
  function doGuide(id) {
    if (party.guide.id === id) { if (opts.onStopGuide) opts.onStopGuide(); }
    else if (opts.onGuide) opts.onGuide(id);
    close();
  }

  // ---- game rows ---------------------------------------------------------------
  let raceList = [];
  let raceSel = 0;
  const gameEls = GAME_ROWS.map((g, i) => {
    const r = el('div', 'ormp-row ormp-game');
    r.dataset.kind = g.kind;
    const mark = el('span', 'ormp-game-mark');
    mark.innerHTML = GAME_MARK[g.kind];           // static markup
    const text = el('div', 'ormp-who');
    const name = el('div', 'ormp-game-name', g.name);
    const sub = el('div', 'ormp-game-sub', g.sub);
    text.append(name, sub);
    let pick = null, pickName = null;
    if (g.kind === 'race') {
      pick = el('div', 'ormp-pick');
      // Drawn chevrons, not the triangle characters: phones render those as colour
      // emoji buttons, a different cartoon on every device (uicheck enforces it).
      const chev = (d) => `<svg viewBox="0 0 10 16" width="9" height="14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>`;
      const prev = el('button'); prev.innerHTML = chev('M8 1.5 2 8l6 6.5'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous race');
      const next = el('button'); next.innerHTML = chev('M2 1.5 8 8l-6 6.5'); next.type = 'button'; next.setAttribute('aria-label', 'Next race');
      pickName = el('span');
      prev.addEventListener('click', () => cycleRace(-1));
      next.addEventListener('click', () => cycleRace(1));
      pick.append(prev, pickName, next);
      text.appendChild(pick);
    }
    const btn = el('button', 'ormp-btn ormp-btn--go', 'Start');
    btn.type = 'button';
    btn.addEventListener('click', () => gameAct(g.kind));
    r.append(mark, text, btn);
    r.addEventListener('pointerenter', () => { sel = friendCount + i; });
    games.appendChild(r);
    return { r, sub, btn, pick, pickName, kind: g.kind, base: g.sub, txt: '', btxt: '', act: '', dis: null, sel: null, live: null };
  });
  let friendCount = 0;

  function cycleRace(d) {
    if (!raceList.length) return;
    raceSel = (raceSel + d + raceList.length) % raceList.length;
  }

  /** What the button on a game's row does right now, and what it says. */
  function gameState(kind) {
    const v = modes.view;
    const online = party.online;
    if (!modes.canPlay) {
      return { act: '', label: 'Start', sub: net && net.status === 'off' ? 'Turn on "Connect to other drivers" in Settings' : net && net.serverProto === 1 ? 'Party games arrive when the room is updated' : 'Connecting…', live: false };
    }
    // The podium: a rematch for the players who were in it; anyone else may
    // start a new game over it (the room allows that).
    const played = v.inGame || v.watching;
    if (v.kind === kind && v.phase === 'done' && !played) return online ? { act: 'start', label: 'Start', sub: null, live: false } : { act: '', label: 'Start', sub: 'Needs a friend online', live: false };
    if (v.kind === kind) {
      if (v.phase === 'done') return { act: 'again', label: 'Rematch', sub: 'Finished. Same players, same game', live: true };
      if (v.inGame) return { act: 'leave', label: 'Leave', sub: v.phase === 'lobby' ? `You're in. ${v.entrants} in so far` : 'You are playing', live: true };
      if (v.watching) return { act: '', label: 'Next one', sub: "Watching. You're in the next race", live: true };
      return { act: 'join', label: 'Join', sub: `${v.hostName} started it${v.phase === 'lobby' ? '' : ' (under way)'}`, live: true };
    }
    if (v.kind && v.phase !== 'done') return { act: '', label: 'Start', sub: 'One game at a time', live: false };
    if (!online) return { act: '', label: 'Start', sub: 'Needs a friend online', live: false };
    return { act: 'start', label: 'Start', sub: null, live: false };
  }

  function gameAct(kind) {
    if (!modes) return;
    const s = gameState(kind);
    const self = lastSelf;
    if (s.act === 'start') {
      if (kind === 'race') { const c = raceList[raceSel]; if (c) modes.startRace(c.id); }
      else if (kind === 'tag') modes.startTag();
      else modes.startCoins(self);
      close();
    } else if (s.act === 'join') { modes.join(); close(); }
    else if (s.act === 'leave') { modes.leave(); close(); }
    else if (s.act === 'again') { modes.again(self); close(); }
  }

  function renderGames(self) {
    if (!modes) return;
    for (let i = 0; i < gameEls.length; i++) {
      const o = gameEls[i];
      const s = gameState(o.kind);
      const sub = s.sub || o.base;
      if (o.txt !== sub) { o.sub.textContent = sub; o.txt = sub; }
      if (o.btxt !== s.label) { o.btn.textContent = s.label; o.btxt = s.label; }
      const dis = !s.act;
      if (o.dis !== dis) { o.btn.disabled = dis; o.dis = dis; }
      if (o.live !== s.live) { o.btn.classList.toggle('ormp-btn--live', s.live); o.btn.classList.toggle('ormp-btn--go', !s.live); o.live = s.live; }
      o.act = s.act;
      if (o.pick) {
        const showPick = s.act === 'start' && raceList.length > 0;
        if (o.pick.hidden === showPick) o.pick.hidden = !showPick;
        const c = raceList[raceSel];
        const t = c ? `${c.name} · ${fmtDist(self ? Math.hypot(c.start.x - self.x, c.start.z - self.z) : NaN)}` : '';
        if (o.pickName.textContent !== t) o.pickName.textContent = t;
      }
      const isSel = friendCount + i === sel;
      if (o.sel !== isSel) { o.r.classList.toggle('is-sel', isSel); o.sel = isSel; }
    }
  }

  // ---- title-screen badge and map pins (added to the menus' own DOM) ------
  let badge = null, badgeLead = null, badgeNote = null;
  const pickEls = [];
  let pinLayer = null, mapCanvas = null, pop = null, popId = -1;
  const pinEls = [];

  function attach(m) {
    menus = m;
    if (!menus || !menus.el || typeof document === 'undefined') return;
    const titleInner = menus.el.querySelector('.or-title-inner');
    if (titleInner) {
      badge = el('div', 'ormp-badge');
      badge.hidden = true;
      badgeLead = el('div', 'ormp-badge-lead');
      badgeNote = el('div', 'ormp-badge-note');
      badge.append(badgeLead, badgeNote);
      const actions = titleInner.querySelector('.or-title-actions');
      titleInner.insertBefore(badge, actions || null);
    }
    const frame = menus.el.querySelector('.or-map-frame');
    mapCanvas = menus.el.querySelector('.or-map-canvas');
    if (frame && mapCanvas) {
      pinLayer = el('div', 'ormp-pins');
      pop = el('div', 'ormp-pop');
      pop.hidden = true;
      pinLayer.appendChild(pop);
      frame.appendChild(pinLayer);
    }
  }

  function renderBadge() {
    if (!badge) return;
    const list = party.roster(null);
    const n = list.length;
    badge.hidden = n === 0;
    if (!n) return;
    const lead = `${n} friend${n === 1 ? '' : 's'} online`;
    if (badgeLead.dataset.txt !== lead) {
      badgeLead.textContent = '';
      const d = el('i', 'ormp-dot');
      badgeLead.append(d, lead);
      badgeLead.dataset.txt = lead;
    }
    // One button per friend; picking one makes Play start next to them.
    let i = 0;
    for (const row of list) {
      let p = pickEls[i];
      if (!p) {
        p = { b: el('button', 'ormp-pickf'), dot: el('i', 'ormp-dot'), t: el('span'), id: -1, txt: '' };
        p.b.type = 'button';
        p.b.append(p.dot, p.t);
        p.b.addEventListener('click', () => {
          party.pickSpawn(party.picked === p.id ? -1 : p.id);
          renderBadge();
        });
        pickEls[i] = p;
      }
      if (!p.b.parentNode) badge.insertBefore(p.b, badgeNote);
      p.id = row.id;
      if (p.txt !== row.name) { p.t.textContent = row.name; p.txt = row.name; }
      p.dot.style.color = row.css;
      p.b.classList.toggle('is-on', party.picked === row.id);
      i++;
    }
    for (let k = i; k < pickEls.length; k++) if (pickEls[k].b.parentNode) pickEls[k].b.remove();
    const picked = list.find((r) => r.id === party.picked);
    // A game inviting right now beats everything: Play joins it (main.js).
    const v = modes ? modes.view : null;
    const note = v && v.invite ? `${v.hostName} ${v.kind === 'race' ? `wants to race: ${v.name}` : v.kind === 'tag' ? 'wants to play Tag' : 'started a Coin Rush'}. Press Play to join in!`
      : picked ? `Play starts you right next to ${picked.name}.`
        : 'Play starts you next to the nearest one. Pick a name to choose.';
    if (badgeNote.textContent !== note) badgeNote.textContent = note;
  }

  function renderPins(self) {
    if (!pinLayer || !mapCanvas || !menus || !menus.el) return;
    const world = opts.worldHalf || 0;
    if (!world) return;
    const fr = pinLayer.getBoundingClientRect();
    const cr = mapCanvas.getBoundingClientRect();
    const list = party.roster(self);
    let i = 0;
    for (const row of list) {
      if (!row.here) continue;
      let p = pinEls[i];
      if (!p) {
        p = { b: el('button', 'ormp-pin'), name: el('b'), dot: el('i'), id: -1, txt: '' };
        p.b.type = 'button';
        p.b.append(p.name, p.dot);
        p.b.addEventListener('click', (e) => { e.stopPropagation(); showPop(p.id); });
        p.b.addEventListener('pointerdown', (e) => e.stopPropagation());
        pinLayer.appendChild(p.b);
        pinEls[i] = p;
      }
      p.id = row.id;
      p.b.hidden = false;
      if (p.txt !== row.name) { p.name.textContent = row.name; p.txt = row.name; p.b.setAttribute('aria-label', `${row.name}: go or guide`); }
      p.b.style.color = row.css;
      const px = cr.left - fr.left + ((row.x + world) / (2 * world)) * cr.width;
      const py = cr.top - fr.top + ((row.z + world) / (2 * world)) * cr.height;
      p.b.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,-100%)`;
      if (popId === row.id) placePop(px, py, row);
      i++;
    }
    for (let k = i; k < pinEls.length; k++) pinEls[k].b.hidden = true;
    if (popId >= 0 && !list.some((r) => r.id === popId && r.here)) hidePop();
  }

  let popBuilt = null;
  function showPop(id) {
    popId = id;
    if (!popBuilt) {
      const name = el('div', 'ormp-name');
      const where = el('div', 'ormp-car');
      const btns = el('div', 'ormp-btns');
      const go = el('button', 'ormp-btn ormp-btn--go', 'Go');
      const gd = el('button', 'ormp-btn', 'Guide');
      go.type = 'button'; gd.type = 'button';
      go.addEventListener('click', (e) => { e.stopPropagation(); const i = popId; hidePop(); if (opts.onGo) opts.onGo(i); });
      gd.addEventListener('click', (e) => { e.stopPropagation(); const i = popId; hidePop(); if (opts.onGuide) opts.onGuide(i); });
      pop.addEventListener('pointerdown', (e) => e.stopPropagation());
      btns.append(go, gd);
      pop.append(name, where, btns);
      popBuilt = { name, where, go };
    }
    pop.hidden = false;
    setTimeout(() => { try { popBuilt.go.focus({ preventScroll: true }); } catch { /* fine */ } }, 0);
  }
  function placePop(px, py, row) {
    pop.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,calc(-100% - 34px))`;
    if (popBuilt.name.textContent !== row.name) popBuilt.name.textContent = row.name;
    const w = `${row.carName} · ${fmtDist(row.dist)} away`;
    if (popBuilt.where.textContent !== w) popBuilt.where.textContent = w;
  }
  function hidePop() { popId = -1; if (pop) pop.hidden = true; }

  // ---- the panel, drawn ------------------------------------------------------
  let listSig = '', secSig = '';
  function renderList(self) {
    const list = party.roster(self);
    const n = list.length;
    friendCount = n;
    const total = n + (modes ? gameEls.length : 0);
    if (sel >= total) sel = Math.max(0, total - 1);
    const block = modes ? modes.blocksGo : '';
    for (let i = 0; i < n; i++) {
      const row = list[i];
      const o = rowEl(i);
      o.id = row.id;
      o.r.hidden = false;
      if (o.txt !== row.name) { o.name.textContent = row.name; o.txt = row.name; }
      if (o.ctxt !== row.carName) { o.car.textContent = row.carName; o.ctxt = row.carName; }
      if (o.col !== row.css) { o.dot.style.color = row.css; o.col = row.css; }
      const d = row.here ? fmtDist(row.dist) : '…';
      if (o.dtxt !== d) { o.dist.textContent = d; o.dtxt = d; }
      // Bearing is +ve to the right and CSS turns clockwise, so it goes in as is.
      const ang = row.here ? `rotate(${row.bearing.toFixed(2)}rad)` : 'none';
      if (o.ang !== ang) { o.arrow.style.transform = ang; o.ang = ang; }
      const here = row.here;
      if (o.here !== here || o.block !== block) {
        o.go.disabled = !here || !!block; o.gd.disabled = !here || !!block;
        o.go.title = block; o.here = here; o.block = block;
      }
      const on = row.guided;
      if (o.on !== on) { o.gd.textContent = on ? 'Stop' : 'Guide'; o.gd.classList.toggle('is-on', on); o.on = on; }
      const s = i === sel;
      if (o.sel !== s) { o.r.classList.toggle('is-sel', s); o.sel = s; }
    }
    for (let i = n; i < rowEls.length; i++) rowEls[i].r.hidden = true;
    const sec = n ? `Friends online · ${n}` : 'Friends online';
    if (secSig !== sec) { secFriends.textContent = sec; secSig = sec; }
    const status = net ? net.status : 'off';
    const msg = n ? '' : status === 'off' ? 'Multiplayer is switched off. Turn on "Connect to other drivers" in Settings.'
      : status !== 'live' ? 'Connecting to the other drivers…'
        : 'Nobody else is driving right now. Anyone who opens OPEN ROAD will pop up here.';
    if (listSig !== msg) { empty.textContent = msg; empty.hidden = !msg; listSig = msg; }
    renderGames(self);
  }

  function renderChip() {
    const n = party.online;
    const show = mode === 'driving' && (n > 0 || touch);
    if (chip.hidden === show) chip.hidden = !show;
    if (!show) return;
    const t = n ? `${n} friend${n === 1 ? '' : 's'} online` : 'Party';
    if (chipText.textContent !== t) chipText.textContent = t;
    const list = party.roster(null);
    let i = 0;
    for (const row of list) {
      if (i >= 6) break;
      let d = chipDots.children[i];
      if (!d) { d = el('i', 'ormp-dot'); chipDots.appendChild(d); }
      if (d.style.color !== row.css) d.style.color = row.css;
      i++;
    }
    while (chipDots.children.length > i) chipDots.lastChild.remove();
  }

  let bannerSig = '';
  function renderBanner() {
    const g = party.guide;
    const on = g.id >= 0 && mode === 'driving';
    if (banner.hidden === on) banner.hidden = !on;
    if (!on) return;
    const t = `Following ${g.name} · ${fmtDist(g.dist || g.straight)}`;
    if (bannerSig !== t) { bText.textContent = t; bannerSig = t; }
    if (bDot.style.color !== g.css) bDot.style.color = g.css;
  }

  // ---- toasts --------------------------------------------------------------
  function toast(text, css) {
    const t = el('div', 'ormp-toast');
    if (css) { const d = el('i', 'ormp-dot'); d.style.color = css; t.appendChild(d); }
    t.appendChild(document.createTextNode(text));
    toasts.appendChild(t);
    live.push({ el: t, left: TOAST_S });
    while (live.length > MAX_TOASTS) { const o = live.shift(); o.el.remove(); }
  }
  function tickToasts(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const o = live[i];
      o.left -= dt;
      if (o.left < 0.3 && !o.el.classList.contains('is-out')) o.el.classList.add('is-out');
      if (o.left <= 0) { o.el.remove(); live.splice(i, 1); }
    }
  }

  /** A net event: someone joined, left, or changed car. */
  function onNetEvent(e) {
    if (!e || disposed) return;
    const col = party.colourFor({ id: e.id, carId: e.car, colour: e.colour }).css;
    if (e.type === 'join') {
      toast(touch ? `${e.name} joined! Tap Party to find them` : `${e.name} joined! Press Tab to find them`, col);
    } else if (e.type === 'leave') {
      toast(`${e.name} left`, col);
    } else if (e.type === 'welcome' && net && net.people.size) {
      const n = net.people.size;
      toast(`${n} friend${n === 1 ? '' : 's'} online${touch ? '. Tap Party to play together' : ' — Tab to play together'}`, '#5ce07a');
    }
  }

  // ---- open / close ----------------------------------------------------------
  function setOpen(on) {
    if (open === on) return;
    open = on;
    panel.classList.toggle('is-open', on);
    panel.setAttribute('aria-hidden', String(!on));
    if (on) {
      sel = 0;
      // The races, nearest first, read once per opening (not every frame).
      raceList = modes ? modes.racesNear(lastSelf) : [];
      raceSel = 0;
    }
  }
  function toggle() { setOpen(!open); }
  function close() { setOpen(false); }

  // Capture phase on window, registered before menus.js's own listener, so
  // while the panel is open its keys (arrows, Enter, G, Escape) never reach
  // the pause menu, the challenge cycler on G, or the car. W A S D still
  // drive, and 1-4 still say hi.
  function onKey(e) {
    if (disposed || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (menus && menus.current) return;             // a menu screen owns the keys
    if (mode !== 'driving') { if (open) close(); return; }
    const k = e.code;
    if (k === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) toggle();
      return;
    }
    if (!open) return;
    const list = party.roster(null);
    const n = list.length;
    const total = n + (modes ? gameEls.length : 0);
    const game = sel >= n ? gameEls[sel - n] : null;
    let used = true;
    if (k === 'Escape') close();
    else if (k === 'ArrowDown') sel = Math.min(total - 1, sel + 1);
    else if (k === 'ArrowUp') sel = Math.max(0, sel - 1);
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { if (game && game.kind === 'race') cycleRace(k === 'ArrowLeft' ? -1 : 1); }
    else if (k === 'Enter' || k === 'NumpadEnter') {
      if (!e.repeat) {
        if (game) gameAct(game.kind);
        else { const r = list[sel]; if (r && r.here && !(modes && modes.blocksGo)) doGo(r.id); }
      }
    } else if (k === 'KeyG') { const r = list[sel]; if (r && r.here && !e.repeat && !(modes && modes.blocksGo)) doGuide(r.id); }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  window.addEventListener('keydown', onKey, true);

  // ---- per frame -------------------------------------------------------------
  let lastMenu = null;
  function update(dt, self, gameMode) {
    if (disposed) return;
    mode = gameMode;
    lastSelf = self;
    tickToasts(dt);
    // Toasts are for the road. On the title screen the badge says the same
    // thing, and a toast there landed on top of the wordmark. With the panel
    // open they wait behind it (their clocks keep running): the panel is
    // above them, but a long one's tail still poked out past its edge.
    const showToasts = mode === 'driving' && !open;
    if (toasts.hidden === showToasts) toasts.hidden = !showToasts;
    if (mode !== 'driving' && open) close();
    renderChip();
    renderBanner();
    if (open) renderList(self);
    const screen = menus ? menus.current : null;
    if (screen === 'title') renderBadge();
    if (screen === 'map') renderPins(self);
    else if (lastMenu === 'map') hidePop();
    lastMenu = screen;
  }

  function dispose() {
    disposed = true;
    window.removeEventListener('keydown', onKey, true);
    root.remove();
    if (badge) badge.remove();
    if (pinLayer) pinLayer.remove();
  }

  return {
    attach, update, toast, onNetEvent, toggle, close, dispose,
    get isOpen() { return open; },
    /** For main.js: the map pins need the world's half-size. */
    setWorldHalf(h) { opts.worldHalf = h; },
  };
}

export { carName };
