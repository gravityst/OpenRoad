// The friends list, and every other place the game tells you where people are.
//
//   - a chip on the left while you drive: "2 friends online — Tab". It is the
//     touch button too; tap it.
//   - Tab opens the list: everyone online, nearest first, with how far and
//     which way, and two buttons each. GO puts you on the road right behind
//     them. GUIDE draws a route to them along the roads and keeps it pointing
//     at them as they drive.
//   - toasts when someone joins or leaves, and when the guide gets you there;
//   - a banner while you are being guided;
//   - on the title screen, "3 friends online", with a chip per friend: pick
//     one and Play starts you next to them (otherwise, next to the nearest);
//   - on the full map, a pin for everyone; click one for Go and Guide.
//
// DOM only, no three.js. The pins and the badge are ADDED to the menu screens
// found by class name, never by editing menus.js; if a class is not there any
// more, that one feature quietly does not appear. Everything a player typed
// (their name) goes in with textContent, never innerHTML — the name rules in
// protocol.js keep it ASCII, and this keeps it text.

import { carName } from './party.js';

const TOAST_S = 4.2;
const MAX_TOASTS = 3;

const CSS = `
.ormp,.ormp-badge,.ormp-pins{--ormp-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ormp{position:fixed;inset:0;pointer-events:none;z-index:30;font-family:var(--ormp-font);color:#eef2f6;-webkit-font-smoothing:antialiased}
.ormp *{box-sizing:border-box}
.ormp-dot{display:inline-block;width:.8em;height:.8em;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 2px rgba(0,0,0,.35),0 0 10px currentColor;background:currentColor}
.ormp-chip{position:absolute;left:calc(12px + env(safe-area-inset-left,0px));top:30vh;pointer-events:auto;display:flex;align-items:center;gap:.5em;
  padding:.5em .85em;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(10,14,20,.66);backdrop-filter:blur(8px);
  font:700 13px/1.1 var(--ormp-font);letter-spacing:.02em;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);transition:opacity .2s,transform .2s}
.ormp-chip:hover{background:rgba(24,30,40,.8)}
.ormp-chip[hidden]{display:none}
.ormp-chip .ormp-dots{display:flex;gap:3px}
.ormp-chip .ormp-dots .ormp-dot{width:.62em;height:.62em}
.ormp-chip kbd{font:600 11px/1 ui-monospace,Menlo,monospace;padding:.2em .45em;border-radius:5px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08)}
.ormp-panel{position:absolute;left:calc(12px + env(safe-area-inset-left,0px));top:50%;transform:translate(-12px,-50%);opacity:0;
  width:min(430px,calc(100vw - 24px));max-height:70vh;overflow:auto;pointer-events:none;
  border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(10,14,20,.8);backdrop-filter:blur(14px) saturate(1.1);
  box-shadow:0 18px 50px rgba(0,0,0,.5);padding:14px;transition:opacity .16s,transform .16s}
.ormp-panel.is-open{opacity:1;transform:translate(0,-50%);pointer-events:auto}
.ormp-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 10px}
.ormp-title{font:800 13px/1 var(--ormp-font);letter-spacing:.16em;text-transform:uppercase;color:#ffb43c}
.ormp-x{appearance:none;border:0;background:none;color:rgba(238,242,246,.6);font:700 18px/1 var(--ormp-font);cursor:pointer;padding:4px 8px;border-radius:8px}
.ormp-x:hover{background:rgba(255,255,255,.08);color:#fff}
.ormp-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;border:1px solid transparent}
.ormp-row.is-sel{border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.06)}
.ormp-row .ormp-dot{width:1em;height:1em}
.ormp-who{min-width:0}
.ormp-name{font:700 15px/1.2 var(--ormp-font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ormp-car{font:500 11.5px/1.3 var(--ormp-font);color:rgba(238,242,246,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ormp-where{display:flex;align-items:center;gap:6px;font:700 13px/1 ui-monospace,Menlo,monospace;color:rgba(238,242,246,.85);white-space:nowrap}
.ormp-arrow{width:18px;height:18px;display:inline-block;transition:transform .12s linear}
.ormp-btns{display:flex;gap:6px}
.ormp-btn{appearance:none;min-height:38px;min-width:58px;padding:0 .9em;border-radius:9px;border:1px solid rgba(255,255,255,.22);
  background:rgba(255,255,255,.07);color:#eef2f6;font:800 11.5px/1 var(--ormp-font);letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
.ormp-btn:hover{background:rgba(255,255,255,.16)}
.ormp-btn--go{border-color:transparent;background:linear-gradient(135deg,#ffb43c,#ff8a3c);color:#17120a}
.ormp-btn--go:hover{background:linear-gradient(135deg,#ffc45f,#ff9a4f)}
.ormp-btn.is-on{background:rgba(111,208,232,.25);border-color:rgba(111,208,232,.7)}
.ormp-empty{padding:14px 8px;color:rgba(238,242,246,.7);font:500 14px/1.45 var(--ormp-font)}
.ormp-foot{margin:10px 4px 0;color:rgba(238,242,246,.45);font:500 11.5px/1.5 var(--ormp-font)}
.ormp-foot kbd{font:600 10.5px/1 ui-monospace,Menlo,monospace;padding:.15em .4em;border-radius:4px;border:1px solid rgba(255,255,255,.25)}
.ormp-toasts{position:absolute;left:calc(12px + env(safe-area-inset-left,0px));top:calc(30vh + 48px);display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.ormp-toast{display:flex;align-items:center;gap:.55em;padding:.55em .9em;border-radius:10px;background:rgba(10,14,20,.74);backdrop-filter:blur(8px);
  border:1px solid rgba(255,255,255,.14);font:700 14px/1.25 var(--ormp-font);box-shadow:0 8px 24px rgba(0,0,0,.35);
  animation:ormp-in .22s cubic-bezier(.22,.61,.36,1);max-width:min(380px,80vw)}
.ormp-toast.is-out{opacity:0;transform:translateX(-8px);transition:opacity .3s,transform .3s}
@keyframes ormp-in{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
.ormp-guide{position:absolute;left:calc(12px + env(safe-area-inset-left,0px));top:calc(30vh - 50px);display:flex;align-items:center;gap:.6em;
  padding:.5em 1em;border-radius:999px;background:rgba(10,14,20,.72);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.18);
  font:800 14px/1.1 var(--ormp-font);letter-spacing:.02em;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.ormp-guide[hidden]{display:none}
.ormp-guide small{font:600 11px/1 var(--ormp-font);color:rgba(238,242,246,.55);letter-spacing:.04em}
.ormp-badge{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:14px 0 0;pointer-events:auto}
.ormp-badge[hidden]{display:none}
.ormp-badge-lead{display:flex;align-items:center;gap:.5em;font:800 14px/1.2 var(--ormp-font);color:#eef2f6}
.ormp-badge-lead .ormp-dot{color:#5ce07a}
.ormp-pick{appearance:none;display:inline-flex;align-items:center;gap:.45em;min-height:34px;padding:0 .8em;border-radius:999px;
  border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#eef2f6;font:700 13px/1 var(--ormp-font);cursor:pointer}
.ormp-pick:hover{background:rgba(255,255,255,.12)}
.ormp-pick.is-on{border-color:#ffb43c;background:rgba(255,180,60,.16)}
.ormp-badge-note{width:100%;font:500 12px/1.3 var(--ormp-font);color:rgba(238,242,246,.55)}
.ormp-pins{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2}
.ormp-pin{position:absolute;left:0;top:0;z-index:1;pointer-events:auto;appearance:none;border:0;background:none;padding:0;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%)}
.ormp-pin i{width:16px;height:16px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(6,8,12,.85),0 0 14px currentColor}
.ormp-pin b{margin-bottom:4px;padding:2px 7px;border-radius:6px;background:rgba(6,8,12,.82);color:#fff;font:700 12px/1.2 var(--ormp-font);white-space:nowrap}
.ormp-pop{position:absolute;left:0;top:0;z-index:5;pointer-events:auto;transform:translate(-50%,calc(-100% - 34px));display:flex;flex-direction:column;gap:8px;
  padding:10px;border-radius:12px;background:rgba(10,14,20,.92);border:1px solid rgba(255,255,255,.2);box-shadow:0 12px 30px rgba(0,0,0,.5);min-width:180px}
.ormp-pop[hidden]{display:none}
.ormp-pop .ormp-name{font-size:14px}
@media (prefers-reduced-motion: reduce){.ormp *{animation:none!important;transition:none!important}}
`;

const ARROW_SVG = '<svg viewBox="0 0 24 24" class="ormp-arrow" aria-hidden="true"><path d="M12 2 L20 20 L12 15 L4 20 Z" fill="currentColor"/></svg>';

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
 *   isTouch            bool — wording and the chip-as-button
 *   onGo(id)           put the player next to them (main.js)
 *   onGuide(id)        start guiding (main.js)
 *   onStopGuide()
 * }
 */
export function createRoster(opts) {
  const party = opts.party;
  const net = opts.net;
  const touch = !!opts.isTouch;
  let menus = null;
  let mode = 'title';
  let open = false;
  let sel = 0;
  let disposed = false;

  const root = el('div', 'ormp');
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

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

  // ---- the list ----------------------------------------------------------
  const panel = el('section', 'ormp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Friends online');
  const head = el('div', 'ormp-head');
  const title = el('div', 'ormp-title', 'Friends online');
  const x = el('button', 'ormp-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => close());
  head.append(title, x);
  const rows = el('div', 'ormp-rows');
  const empty = el('div', 'ormp-empty');
  const foot = el('div', 'ormp-foot');
  if (touch) foot.textContent = 'GO jumps you right behind them. GUIDE shows the way along the roads.';
  else {
    foot.append(
      el('kbd', null, '↑'), ' ', el('kbd', null, '↓'), ' pick · ',
      el('kbd', null, 'Enter'), ' go · ', el('kbd', null, 'G'), ' guide · ',
      el('kbd', null, 'Tab'), ' close',
    );
  }
  panel.append(head, rows, empty, foot);
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
  const bHint = el('small', null, touch ? 'tap Friends to stop' : 'Tab to change');
  banner.append(bDot, bText, bHint);
  root.appendChild(banner);

  document.body.appendChild(root);

  // Pooled row DOM, rebuilt only when what it says changes.
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
    const o = { r, dot, name, car, arrow, dist, go, gd, id: -1, txt: '', ctxt: '', dtxt: '', col: '', ang: '', on: null, sel: null, here: null };
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
    // One chip per friend; picking one makes Play start next to them.
    let i = 0;
    for (const row of list) {
      let p = pickEls[i];
      if (!p) {
        p = { b: el('button', 'ormp-pick'), dot: el('i', 'ormp-dot'), t: el('span'), id: -1, txt: '' };
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
    const note = picked ? `Play starts you right next to ${picked.name}.`
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

  // ---- the list, drawn ---------------------------------------------------
  let listSig = '';
  function renderList(self) {
    const list = party.roster(self);
    const n = list.length;
    if (sel >= n) sel = Math.max(0, n - 1);
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
      if (o.here !== row.here) { o.go.disabled = !row.here; o.gd.disabled = !row.here; o.here = row.here; }
      const on = row.guided;
      if (o.on !== on) { o.gd.textContent = on ? 'Stop' : 'Guide'; o.gd.classList.toggle('is-on', on); o.on = on; }
      const s = i === sel;
      if (o.sel !== s) { o.r.classList.toggle('is-sel', s); o.sel = s; }
    }
    for (let i = n; i < rowEls.length; i++) rowEls[i].r.hidden = true;
    const status = net ? net.status : 'off';
    const msg = n ? '' : status === 'off' ? 'Multiplayer is switched off. Turn on "Connect to other drivers" in Settings.'
      : status !== 'live' ? 'Connecting to the other drivers…'
        : 'Nobody else is driving right now. Anyone who opens OPEN ROAD will pop up here.';
    if (listSig !== msg) { empty.textContent = msg; empty.hidden = !msg; listSig = msg; }
  }

  function renderChip() {
    const n = party.online;
    const show = mode === 'driving' && (n > 0 || touch);
    if (chip.hidden === show) chip.hidden = !show;
    if (!show) return;
    const t = n ? `${n} friend${n === 1 ? '' : 's'} online` : 'Friends';
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
      toast(touch ? `${e.name} joined! Tap Friends to find them` : `${e.name} joined! Press Tab to find them`, col);
    } else if (e.type === 'leave') {
      toast(`${e.name} left`, col);
    } else if (e.type === 'welcome' && net && net.people.size) {
      const n = net.people.size;
      toast(`${n} friend${n === 1 ? '' : 's'} online${touch ? '' : ' — press Tab'}`, '#5ce07a');
    }
  }

  // ---- open / close ----------------------------------------------------------
  function setOpen(on) {
    if (open === on) return;
    open = on;
    panel.classList.toggle('is-open', on);
    panel.setAttribute('aria-hidden', String(!on));
    if (on) sel = 0;
  }
  function toggle() { setOpen(!open); }
  function close() { setOpen(false); }

  // Capture phase on window, registered before menus.js's own listener, so
  // while the list is open its keys (and Escape) never reach the pause menu,
  // the challenge cycler on G, or the car.
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
    let used = true;
    if (k === 'Escape') close();
    else if (k === 'ArrowDown') { if (!e.repeat) sel = Math.min(list.length - 1, sel + 1); }
    else if (k === 'ArrowUp') { if (!e.repeat) sel = Math.max(0, sel - 1); }
    else if (k === 'Enter' || k === 'NumpadEnter') { const r = list[sel]; if (r && r.here && !e.repeat) doGo(r.id); }
    else if (k === 'KeyG') { const r = list[sel]; if (r && r.here && !e.repeat) doGuide(r.id); }
    else if (/^Digit[1-9]$/.test(k)) { const i = +k.slice(5) - 1; if (i < list.length) sel = i; }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  window.addEventListener('keydown', onKey, true);

  // ---- per frame -------------------------------------------------------------
  let lastMenu = null;
  function update(dt, self, gameMode) {
    if (disposed) return;
    mode = gameMode;
    tickToasts(dt);
    // Toasts are for the road. On the title screen the badge says the same
    // thing, and a toast there landed on top of the wordmark.
    const showToasts = mode === 'driving';
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
