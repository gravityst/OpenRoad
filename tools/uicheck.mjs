// The front end, checked without a browser.
//
// Every other harness here guards the simulation; this one guards what a kid
// actually reads. It builds the REAL menus, HUD, goals overlay and touch rig —
// wired to the real goals layer over the real world, as main.js wires them —
// into a small stand-in DOM, opens every screen and fires every moment, and
// then checks the things that have gone wrong on screens like these:
//
//   - a screen that throws while it builds, or opens with nothing focused, so
//     Enter does nothing and a keyboard kid is stuck;
//   - emoji used as UI: they render as a different cartoon on every machine
//     (the garage's padlock was one) and they are the first mark of a UI that
//     was not designed;
//   - fire, damage and wreck words in a game that has none of those any more,
//     and scolding copy ("don't crash!") where a kid needs encouragement;
//   - a shaking animation on the moment a chain ends: the kids hated being
//     told off for bumping something;
//   - design-system drift: a colour token used but never defined, a pill
//     shape or a backdrop blur creeping back into the stylesheets.
//
// It cannot see pixels. A human still has to look at the screen; this makes
// sure there is something correct on it to look at.
//
// The stand-in DOM implements only what these four modules touch: elements,
// an HTML parser for their templates, class and attribute selectors with the
// descendant combinator and :not(), events, focus, and a canvas whose context
// swallows every call. No npm, no jsdom — the repo has no runtime dependencies
// and this harness adds none.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) fail++;
};

// ===========================================================================
// A stand-in DOM
// ===========================================================================

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'wbr', 'col', 'area']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', copy: '©', times: '×' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] != null ? ENTITIES[e] : m;
});

let activeElement = null;
const docListeners = new Map();

class Node {
  constructor(type, name) {
    this.nodeType = type;               // 1 element, 3 text
    this.tagName = type === 1 ? String(name).toUpperCase() : undefined;
    this.localName = type === 1 ? String(name).toLowerCase() : undefined;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this._text = type === 3 ? String(name) : '';
    this.listeners = new Map();
    this.style = makeStyle();
    this.inert = false;
    this.width = 0; this.height = 0;    // for canvases
  }
  get ownerDocument() { return document; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) { this._text = String(v); return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== '') this.appendChild(new Node(3, String(v)));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    this.textContent = '';
    for (const n of parseHTML(String(html))) this.appendChild(n);
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get classList() {
    const n = this;
    const list = () => n.className.split(/\s+/).filter(Boolean);
    const set = (a) => { n.className = a.join(' '); };
    return {
      add: (...c) => set([...new Set([...list(), ...c])]),
      remove: (...c) => set(list().filter((x) => !c.includes(x))),
      contains: (c) => list().includes(c),
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want && !has) set([...list(), c]); if (!want && has) set(list().filter((x) => x !== c)); return want; },
    };
  }
  get dataset() {
    const n = this;
    const key = (p) => 'data-' + p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    return new Proxy({}, {
      get: (_, p) => (typeof p === 'string' ? (n.getAttribute(key(p)) ?? undefined) : undefined),
      set: (_, p, v) => { n.setAttribute(key(p), v); return true; },
      deleteProperty: (_, p) => { n.removeAttribute(key(p)); return true; },
      has: (_, p) => n.hasAttribute(key(p)),
    });
  }
  // Reflected properties the modules use.
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get tabIndex() { const t = this.getAttribute('tabindex'); return t == null ? (/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(this.tagName) ? 0 : -1) : Number(t); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get htmlFor() { return this.getAttribute('for') || ''; }
  set htmlFor(v) { this.setAttribute('for', v); }
  // Layout, which a stand-in cannot do: everything measures zero, and an
  // element is "rendered" unless it or an ancestor is hidden.
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  get offsetParent() {
    for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.hasAttribute('hidden')) return null;
    return this.parentNode;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  scrollIntoView() {}
  getContext() { return fakeContext(); }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...xs) { for (const x of xs) this.appendChild(typeof x === 'string' ? new Node(3, x) : x); }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  removeEventListener(t, fn) { const l = this.listeners.get(t); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let n = this; n && !ev._stopped; n = n.parentNode) {
      for (const fn of (n.listeners.get(ev.type) || []).slice()) fn(ev);
    }
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent(makeEvent('click')); }
  focus() { activeElement = this; }
  blur() { if (activeElement === this) activeElement = null; }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && matches(n, sel)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  matches(sel) { return matches(this, sel); }
}

function makeStyle() {
  const props = {};
  return new Proxy(props, {
    get: (o, p) => (p === 'setProperty' ? (k, v) => { o[k] = String(v); }
      : p === 'removeProperty' ? (k) => { delete o[k]; }
      : p === 'getPropertyValue' ? (k) => o[k] || '' : (o[p] ?? '')),
    set: (o, p, v) => { o[p] = v; return true; },
  });
}

function makeEvent(type, extra) {
  return Object.assign({ type, defaultPrevented: false, _stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stopped = true; } }, extra);
}

/** A 2D context that accepts every call and returns something harmless. */
function fakeContext() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get: (o, p) => {
      if (p in o) return o[p];
      if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => grad;
      if (p === 'measureText') return (t) => ({ width: String(t).length * 6 });
      if (p === 'getImageData' || p === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)) });
      return () => {};
    },
    set: (o, p, v) => { o[p] = v; return true; },
  });
}

function walk(n, fn) { for (const c of n.childNodes) { if (c.nodeType === 1) { fn(c); walk(c, fn); } } }

function serialize(n) {
  if (n.nodeType === 3) return n._text;
  const a = [...n.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
  return VOID.has(n.localName) ? `<${n.localName}${a}>` : `<${n.localName}${a}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

/** Enough HTML for these templates: tags, attributes, text, comments, self-closing SVG. */
function parseHTML(html) {
  const root = new Node(1, 'template');
  let cur = root, i = 0;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > i) cur.appendChild(new Node(3, decode(html.slice(i, m.index))));
    i = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {                                  // a closing tag: pop to it
      for (let n = cur; n && n !== root; n = n.parentNode) if (n.localName === m[1].toLowerCase()) { cur = n.parentNode; break; }
      continue;
    }
    const el = new Node(1, m[2]);
    const ar = /([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[3] || ''))) el.setAttribute(a[1], decode(a[3] ?? a[4] ?? a[5] ?? ''));
    cur.appendChild(el);
    if (!m[4] && !VOID.has(el.localName)) cur = el;
  }
  if (i < html.length) cur.appendChild(new Node(3, decode(html.slice(i))));
  return root.childNodes.slice();
}

// ---- selectors: compound (tag, .class, [attr], [attr="v"], :not(...)),
// descendant combinator, comma lists. ------------------------------------
function matches(n, sel) {
  return splitTop(sel, ',').some((s) => matchChain(n, splitTop(s.trim(), ' ').filter(Boolean)));
}
function splitTop(s, sep) {
  const out = []; let depth = 0, q = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}
function matchChain(n, parts) {
  if (!parts.length) return true;
  if (!matchCompound(n, parts[parts.length - 1])) return false;
  const rest = parts.slice(0, -1);
  if (!rest.length) return true;
  for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchChain(p, rest)) return true;
  return false;
}
function matchCompound(n, c) {
  if (n.nodeType !== 1) return false;
  const re = /^([a-zA-Z*][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|:not\(((?:[^()]|\([^()]*\))*)\)|:scope/g;
  let m, pos = 0;
  while ((m = re.exec(c))) {
    if (m.index !== pos) return false;
    pos = re.lastIndex;
    if (m[1] && m[1] !== '*' && n.localName !== m[1].toLowerCase()) return false;
    if (m[2] && !n.classList.contains(m[2])) return false;
    if (m[3] && n.id !== m[3]) return false;
    if (m[4]) {
      const v = n.getAttribute(m[4]);
      if (v == null) return false;
      if (m[5] === '=' && v !== m[6]) return false;
    }
    if (m[7] && matchCompound(n, m[7])) return false;
  }
  return pos === c.length;
}

const documentElement = new Node(1, 'html');
const head = new Node(1, 'head');
const body = new Node(1, 'body');
documentElement.appendChild(head);
documentElement.appendChild(body);
const winListeners = new Map();
const document = {
  documentElement, head, body,
  createElement: (t) => new Node(1, t),
  createElementNS: (ns, t) => new Node(1, t),
  createTextNode: (t) => new Node(3, t),
  querySelector: (s) => documentElement.querySelector(s),
  querySelectorAll: (s) => documentElement.querySelectorAll(s),
  getElementById: (id) => documentElement.querySelector('#' + id),
  get activeElement() { return activeElement || body; },
  addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
  removeEventListener() {},
  visibilityState: 'visible',
  hidden: false,
};
const window = {
  document,
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  addEventListener: (t, fn) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); },
  removeEventListener: (t, fn) => { const l = winListeners.get(t); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => new Proxy({}, { get: () => '0px' }),
  confirm: () => true,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  cancelAnimationFrame: clearTimeout,
};
Object.assign(globalThis, {
  document, window, getComputedStyle: window.getComputedStyle, matchMedia: window.matchMedia,
  requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
});
try { Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0, userAgent: 'uicheck' }, configurable: true }); } catch { /* read-only on this Node */ }

/** A key pressed while the page has focus, the way menus.js hears it (capture, on window). */
function key(k) {
  const ev = makeEvent('keydown', { key: k, code: k, target: activeElement || body, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
  for (const fn of (winListeners.get('keydown') || []).slice()) fn(ev);
  return ev;
}

// ===========================================================================
// What counts as wrong
// ===========================================================================

// Pictographs that render as colour emoji, and the variation selector that
// forces one. Plain typographic marks (x, ·, arrows, dashes) are not in it.
const EMOJI = /\p{Extended_Pictographic}|️/u;
// A game with no fire and no damage should not promise either, in any word a
// kid reads. Whole words, so "Driftwood" or "bumped" pass.
const HARSH = /\b(fire|flames?|burn(ing|t|s)?|explo(de|des|sion|sions)|wreck(ed|s)?|damage[ds]?|destroy(ed)?|dead|die[ds]?|kill(ed|s)?|lose|loser|failed?)\b|don'?t crash|gone —|CHAIN LOST/i;

function visibleText(root) {
  const out = [];
  const visit = (n, hidden) => {
    if (n.nodeType === 3) { if (!hidden && n._text.trim()) out.push(n._text.trim()); return; }
    // `hidden`, and the two classes the HUD uses for display: none
    // (hud.css .is-off, and the whole layer's .is-hidden) — the stand-in has
    // no stylesheet, so it is told which classes mean "not drawn".
    const h = hidden || n.hasAttribute('hidden') || (n.nodeType === 1 && (n.classList.contains('is-off') || n.classList.contains('is-hidden')));
    if (n.localName === 'style' || n.localName === 'svg') return;
    for (const c of n.childNodes) visit(c, h);
    // Titles and labels are read too: a tooltip or a screen reader label is copy.
    for (const a of ['title', 'aria-label', 'placeholder']) if (!h && n.getAttribute(a)) out.push(n.getAttribute(a));
  };
  visit(root, false);
  return out;
}

function copyProblems(strings) {
  const emoji = [], harsh = [];
  for (const s of strings) {
    if (EMOJI.test(s)) emoji.push(s);
    if (HARSH.test(s)) harsh.push(s);
  }
  return { emoji, harsh };
}

// ===========================================================================
// Build it all, the way main.js does
// ===========================================================================

const { buildWorld } = await import('../src/world/layout.js');
const { createGround } = await import('../src/world/ground.js');
const { createVehicle } = await import('../src/physics/vehicle.js');
const { CARS, specFor } = await import('../src/vehicles/catalog.js');
const { createTraffic } = await import('../src/ai/traffic.js');
const { createDrift } = await import('../src/game/drift.js');
const { createGoals } = await import('../src/game/goals.js');
const { createObjectives } = await import('../src/game/objectives.js');
const { createMenus } = await import('../src/game/menus.js');
const { createHUD } = await import('../src/game/hud.js');
const { createTouchControls } = await import('../src/input/touch.js');
const { PATHS, icon, logotype } = await import('../src/game/icons.js');
const { TROPHIES, PAINTS, DAILY_BY_ID } = await import('../src/game/career.js');
const { generateChallenges } = await import('../src/game/challenges.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const hudRoot = new Node(1, 'div'); hudRoot.id = 'hud'; body.appendChild(hudRoot);
const menuRoot = new Node(1, 'div'); menuRoot.id = 'menus'; body.appendChild(menuRoot);
const touchRoot = new Node(1, 'div'); touchRoot.id = 'touch'; body.appendChild(touchRoot);

console.log('-- building the front end over the real world --');
const world = buildWorld();
const ground = createGround(world);
const car = createVehicle({ ground, spec: specFor('kaida2'), isPlayer: true });
car.reset(0, -260, 0);
const traffic = createTraffic(world, ground, { density: 30 });
const drift = createDrift({ ground });
const errors = [];
// Every toast the goals layer raises lands here, to be read like any screen.
const toasts = [];
const guard = (what, fn) => { try { return fn(); } catch (err) { errors.push(`${what}: ${err.message}`); return null; } };

const hud = guard('createHUD', () => createHUD(hudRoot, { world: null }));
const goals = guard('createGoals', () => createGoals({
  world, ground, car, cars: CARS, storage: memoryStorage(), sfx: false, drift, traffic, camera: { fov: 60 },
  today: () => '2026-09-23', root: hudRoot, createOverlay: createObjectives, toast: (m) => toasts.push(String(m)),
}));
const menus = guard('createMenus', () => createMenus(menuRoot, { world, settings: {}, handleEscape: true }));
const touch = guard('createTouchControls', () => createTouchControls(touchRoot));
if (menus) { menus.setCars(CARS); if (goals) menus.setGoals(goals); }
check('the menus, HUD, overlay and touch rig all build', errors.length === 0 && !!(hud && goals && menus && touch),
  errors.length ? errors.join('; ') : 'four layers, real goals over the real world');
if (!menus || !goals) { console.log('\nCannot continue without the menus and goals.'); process.exit(1); }

// ---- every screen ---------------------------------------------------------
console.log('\n-- every screen --');
const SCREENS = ['title', 'garage', 'settings', 'pause', 'map', 'trophies'];
const AUTOFOCUS = { title: 'Play', garage: 'Take it out', settings: 'Done', pause: 'Resume', trophies: 'Done' };
const allText = [];
for (const name of SCREENS) {
  const threw = guard(`show(${name})`, () => { menus.show(name); return true; });
  const screen = menus.el.querySelector(`[data-screen="${name}"]`);
  const on = !!threw && menus.current === name && screen.classList.contains('is-on') && screen.getAttribute('aria-hidden') === 'false';
  const others = SCREENS.filter((s) => s !== name).every((s) => menus.el.querySelector(`[data-screen="${s}"]`).inert === true);
  const focused = activeElement && screen.contains(activeElement);
  const want = AUTOFOCUS[name];
  const focusOk = name === 'map' ? activeElement === screen.querySelector('.or-map-canvas') || focused
    : focused && activeElement.textContent.replace(/\s+/g, ' ').trim().startsWith(want);
  const text = visibleText(screen);
  allText.push(...text);
  const p = copyProblems(text);
  check(`${name}: opens, the rest go inert, focus lands on its action`, on && others && focusOk && p.emoji.length === 0,
    `${text.length} strings; focus on "${activeElement ? activeElement.textContent.replace(/\s+/g, ' ').trim().slice(0, 24) : 'nothing'}"${p.emoji.length ? `; EMOJI: ${p.emoji.join(' | ')}` : ''}`);
}
const menuCopy = copyProblems(allText);
check('no screen says fire, damage, wreck or tells a kid off', menuCopy.harsh.length === 0,
  menuCopy.harsh.length ? menuCopy.harsh.slice(0, 6).join(' | ') : `${allText.length} strings read across ${SCREENS.length} screens`);

// Every data-act a screen offers has something to do.
{
  const src = readFileSync(join(ROOT, 'src/game/menus.js'), 'utf8');
  const actsBlock = src.slice(src.indexOf('const ACTIONS = {'), src.indexOf('ui.addEventListener(\'click\''));
  const handled = new Set([...actsBlock.matchAll(/^\s{4}'?([\w-]+)'?\s*[:(,]/gm)].map((m) => m[1]));
  const offered = new Set(menus.el.querySelectorAll('[data-act]').map((n) => n.getAttribute('data-act')));
  const orphan = [...offered].filter((a) => !handled.has(a));
  check('every button on every screen does something', orphan.length === 0,
    orphan.length ? `no handler for: ${orphan.join(', ')}` : `${offered.size} actions, all handled`);
}

// ---- the keyboard ---------------------------------------------------------
console.log('\n-- the keyboard --');
{
  menus.show('title');
  const rows = menus.el.querySelectorAll('.or-title [data-nav]').filter((n) => !n.hidden);
  const start = activeElement;
  key('ArrowDown');
  const second = activeElement;
  key('ArrowUp');
  const back = activeElement;
  key('ArrowUp');
  const wrapped = activeElement;
  check('Up and Down walk the title menu, and wrap', start === rows[0] && second === rows[1] && back === rows[0] && wrapped === rows[rows.length - 1],
    `${rows.length} rows: ${rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim().split(' ')[0]).join(', ')}`);
  menus.show('pause');
  key('ArrowDown');
  const pauseRows = menus.el.querySelectorAll('.or-pause [data-nav]').filter((n) => n.offsetParent !== null);
  check('...and the pause menu', activeElement === pauseRows[1], `${pauseRows.length} rows, focus moved to "${activeElement.textContent.replace(/\s+/g, ' ').trim().slice(0, 20)}"`);
  menus.hide();
  const esc = key('Escape');
  check('Escape while driving is left to main.js (no card, not swallowed)', menus.current === null && !esc._stopped,
    'the menu did not open the pause card itself, so inspect mode cannot flash it');
  menus.show('settings');
  const armBtn = menus.el.querySelector('[data-act="reset-progress"]');
  const xp = goals.progress.xp;
  goals.progress.bankChain(1, 50, 10);
  const had = goals.progress.xp;
  armBtn.click();
  const armed = armBtn.classList.contains('is-armed') && goals.progress.xp === had;
  menus.show('title');
  menus.show('settings');
  const disarmed = !armBtn.classList.contains('is-armed');
  check('Start over asks twice, and forgets when you leave', armed && disarmed && had > xp,
    `first press armed it (XP kept at ${had}); leaving the screen disarmed it`);
}

// ---- the overlay's moments ------------------------------------------------
console.log('\n-- the goals overlay and its moments --');
{
  const ctx = { driving: true, model: null };
  const PH = 1 / 120;
  const overlay = hudRoot.querySelector('.goal');
  menus.hide();
  for (let step = 0; step < 120 * 6; step++) {
    car.input.throttle = 0.5; car.input.steer = 0;
    goals.preStep(); car.step(PH); goals.step(PH);
    if (step % 2) { traffic.update(PH * 2, car.x, car.z, car.speed, car.yaw); drift.update(PH * 2, car); goals.update(PH * 2, ctx); }
  }
  const seen = [];
  const moments = ['chain', 'lost', 'chain', 'bank', 'level', 'trophy', 'daily', 'sweep', 'streak', 'welcome', 'medal'];
  for (const m of moments) {
    guard(`demo(${m})`, () => goals.demo(m));
    for (let i = 0; i < 30; i++) goals.update(1 / 60, ctx);
    seen.push(...visibleText(overlay));
  }
  const lostCard = overlay.querySelector('.goal__chainEnd');
  const p = copyProblems(seen);
  check('every moment shows, with no emoji', goals.errors === 0 && errors.length === 0 && p.emoji.length === 0 && seen.length > 20,
    `${moments.length} moments, ${seen.length} strings, ${goals.errors} frames threw${p.emoji.length ? `; EMOJI: ${p.emoji.join(' | ')}` : ''}`);
  check('...and none of them scolds', p.harsh.length === 0, p.harsh.length ? p.harsh.slice(0, 5).join(' | ') : 'no fire, damage or "don\'t crash"');

  // Toasts are words a kid reads too. The ones this drive raised, plus a
  // GPS cycle, plus every toast the goals layer can say at all: its literal
  // lines are read from the source, with each ${...} as a placeholder, so a
  // line only a rare path reaches (a drift zone missed, a race respawn) is
  // checked without having to stage it.
  guard('cycleTarget', () => goals.cycleTarget());
  const src = readFileSync(join(ROOT, 'src/game/goals.js'), 'utf8');
  // abandonRace(msg) hands its line on to toast(), so it is read too.
  const literal = [...src.matchAll(/\b(?:toast|abandonRace)\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2].replace(/\$\{[^}]*\}/g, 'Name'));
  const said = [...new Set([...toasts, ...literal])];
  const t = copyProblems(said);
  check('every toast is kind, with no emoji', toasts.length >= 2 && literal.length >= 5 && t.emoji.length === 0 && t.harsh.length === 0,
    t.harsh.length || t.emoji.length ? [...t.harsh, ...t.emoji].slice(0, 5).join(' | ')
      : `${toasts.length} raised in play, ${literal.length} lines in goals.js: "${toasts[0]}"`);
  goals.demo('chain');
  for (let i = 0; i < 5; i++) goals.update(1 / 60, ctx);
  goals.demo('lost');
  for (let i = 0; i < 3; i++) goals.update(1 / 60, ctx);
  const lostText = lostCard.textContent;
  check('a chain ended by a bump says what to do next', /reset/i.test(lostText) && /new one/i.test(lostText) && lostCard.classList.contains('is-lost'),
    `"${lostText}"`);
}

// ---- the HUD and the touch rig --------------------------------------------
console.log('\n-- the HUD and the touch rig --');
{
  const state = {
    speed: 30, gear: 3, rpm: 5200, redline: 7000, surface: 'gravel', throttle: 0.8, brake: 0, handbrake: 0,
    time: 9.5, heading: 0.4, x: 0, z: 0, district: 'Greenmeadow Farms', speedLimit: 22.2, airborne: false, slipping: 0.4,
    odometer: 1234, damage: null, drift: null, players: null, nav: null, playerColour: () => ({ css: '#ff0' }),
  };
  guard('hud.update', () => { for (let i = 0; i < 120; i++) { state.rpm = 1000 + i * 60; hud.update(state); } });
  const text = visibleText(hudRoot.querySelector('.hud'));
  const p = copyProblems(text);
  check('the HUD updates and shows what it should', errors.length === 0 && text.includes('108') && text.includes('GRAVEL') && p.emoji.length === 0 && p.harsh.length === 0,
    `${text.filter((t) => /^\d+$/.test(t) || /^[A-Z ]+$/.test(t)).slice(0, 8).join(' ')}`);

  const buttons = touchRoot.querySelectorAll('button[data-ctl]');
  const bare = buttons.filter((b) => b.getAttribute('data-ctl') !== 'horn' && !b.querySelector('svg'));
  const unlabelled = buttons.filter((b) => !b.getAttribute('aria-label'));
  const touchCss = readFileSync(join(ROOT, 'styles/touch.css'), 'utf8');
  const hornHidden = /\.touch__btn\[data-ctl="horn"\]\s*\{\s*display:\s*none/.test(touchCss);
  check('every touch control has a glyph and a label; the silent horn is hidden', bare.length === 0 && unlabelled.length === 0 && hornHidden,
    `${buttons.length} controls${bare.length ? `; no glyph: ${bare.map((b) => b.getAttribute('data-ctl')).join(', ')}` : ''}${hornHidden ? '' : '; horn visible'}`);
}

// ---- words that live in data, not in the DOM -------------------------------
console.log('\n-- the words in the data --');
{
  const gen = generateChallenges(world, ground);
  const words = [
    ...gen.list.map((c) => c.name),
    ...TROPHIES.flatMap((t) => [t.name, t.desc]),
    ...PAINTS.map((q) => q.name),
    ...Object.values(DAILY_BY_ID).map((d) => (typeof d.text === 'function' ? d.text(3) : String(d.text))),
  ];
  const p = copyProblems(words);
  check('challenge, trophy, paint and daily names are kid-safe', p.emoji.length === 0 && p.harsh.length === 0,
    p.harsh.length || p.emoji.length ? [...p.harsh, ...p.emoji].join(' | ') : `${words.length} names and lines`);
}

// ---- the icon set and the logotype ----------------------------------------
console.log('\n-- icons and logotype --');
{
  const names = Object.keys(PATHS);
  const bad = names.filter((n) => {
    const m = icon(n);
    return !/^<svg viewBox="0 0 24 24"/.test(m) || /#[0-9a-f]{3,6}"/i.test(PATHS[n]) || !/currentColor/.test(m);
  });
  const logo = logotype({ stacked: true }), logo2 = logotype({ stacked: true });
  const ids = [...logo.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const ids2 = [...logo2.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  check('icons are one 24-unit set in currentColor, no baked colours', bad.length === 0,
    bad.length ? `off-grammar: ${bad.join(', ')}` : `${names.length} glyphs`);
  check('two logotypes on one page never share a mask id', ids.length > 0 && ids.every((i) => !ids2.includes(i)),
    `${ids.join(', ')} vs ${ids2.join(', ')}`);
}

// ---- the stylesheets ------------------------------------------------------
console.log('\n-- the stylesheets --');
{
  const files = ['styles/ui.css', 'styles/hud.css', 'styles/goals.css', 'styles/touch.css'];
  const css = Object.fromEntries(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]));
  const all = Object.values(css).join('\n');
  // Tokens: every --or-* read with no fallback must be defined somewhere.
  // base.css defines the page shell's tokens (safe areas, the boot font) that
  // touch.css reads; it is read for definitions only.
  const base = readFileSync(join(ROOT, 'styles/base.css'), 'utf8');
  const defined = new Set([...(all + base).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const js = ['src/game/menus.js', 'src/game/objectives.js', 'src/game/hud.js', 'src/input/touch.js']
    .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  for (const m of js.matchAll(/setProperty\('(--[\w-]+)'/g)) defined.add(m[1]);
  const used = [...all.matchAll(/var\((--[\w-]+)\s*\)/g)].map((m) => m[1]);
  const missing = [...new Set(used.filter((u) => !defined.has(u)))];
  check('every colour, size and font token used is defined', missing.length === 0,
    missing.length ? `undefined: ${missing.join(', ')}` : `${new Set(used).size} tokens read without a fallback, all defined`);

  // Emoji smuggled in through CSS content escapes.
  const escapes = [...all.matchAll(/content:\s*"([^"]*)"/g)].map((m) => m[1].replace(/\\([0-9a-f]{1,6})\s?/gi, (x, h) => String.fromCodePoint(parseInt(h, 16))));
  const cssEmoji = escapes.filter((s) => EMOJI.test(s));
  check('no emoji in generated content either', cssEmoji.length === 0, cssEmoji.length ? cssEmoji.join(' | ') : `${escapes.length} content strings`);

  // The grammar: no pills, no frosted glass. A radius of 50% is allowed on
  // the four things that really are round (the minimap, the dial and its
  // shadow, the speed-limit sign, the steering wheel and its parts).
  const pills = [...all.matchAll(/border-radius:\s*(999px|9999px|100vmax)/g)].length;
  const blur = files.filter((f) => /backdrop-filter:\s*blur/.test(css[f]));
  const round = [...all.matchAll(/([^{}]+)\{[^}]*border-radius:\s*50%/g)].map((m) => m[1].trim().split('\n').pop().trim());
  const roundOk = round.every((sel) => /hud__mapCanvas|hud__dial|hud__limit|touch__(rim|hub|knob|wheel)|touch__knob::after/.test(sel));
  check('no pill chips, no frosted glass, round only where round is real', pills === 0 && blur.length === 0 && roundOk,
    `${pills} pills, blur in ${blur.join(', ') || 'nothing'}; round: ${round.map((r) => r.replace(/\s+/g, ' ')).join('; ')}`);

  // The title never overlaps itself or leaves a row out of reach, at any
  // window size. This harness has no layout engine, so it holds the grid to
  // the two rules that make that true whatever the window is, in the base
  // rule and every media rule that re-lays it out:
  //   - a row with something in it, and something in a row after it, may not
  //     shrink below its content (minmax(0, ...) or a fixed height), or its
  //     content runs under the next row. That is how Settings ended up under
  //     the key strip, and off the bottom, in a 1366x768 laptop's Chrome;
  //   - the grid scrolls, so content taller than the window is still there.
  {
    const blocks = [...css['styles/ui.css'].matchAll(/\.or-title-inner\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const tracks = (v) => {
      const out = []; let depth = 0, cur = '';
      for (const ch of v.trim()) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    };
    const shrinks = (t) => /^minmax\(\s*0(px)?\s*,/.test(t) || /^[\d.]+(px|rem|em|vh|%)$/.test(t);
    const base = blocks[0] || '';
    const baseRows = (base.match(/grid-template-rows:\s*([^;]+);/) || [])[1];
    const baseAreas = (base.match(/grid-template-areas:\s*((?:"[^"]*"\s*)+)/) || [])[1];
    const bad = [];
    let layouts = 0;
    for (const b of blocks) {
      const rowsDecl = (b.match(/grid-template-rows:\s*([^;]+);/) || [])[1];
      const areasDecl = (b.match(/grid-template-areas:\s*((?:"[^"]*"\s*)+)/) || [])[1];
      if (!rowsDecl && !areasDecl) continue;
      layouts++;
      const rows = tracks(rowsDecl || baseRows || '');
      const areas = [...(areasDecl || baseAreas || '').matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
      if (rows.length !== areas.length) { bad.push(`${rows.length} rows for ${areas.length} area rows`); continue; }
      const used = areas.map((r) => r.some((c) => !/^\.+$/.test(c)));
      const lastUsed = used.lastIndexOf(true);
      rows.forEach((t, i) => {
        if (used[i] && i < lastUsed && shrinks(t)) bad.push(`"${areas[i].join(' ')}" is ${t}`);
      });
    }
    const scrolls = /overflow(-y)?:\s*(\w+\s+)?(auto|scroll)\s*;/.test(base);
    const clipped = blocks.slice(1).filter((b) => /overflow(-y)?:\s*(\w+\s+)?(visible|hidden|clip)\s*;/.test(b)).length;
    check('the title cannot overlap itself or put a row out of reach', layouts >= 4 && bad.length === 0 && scrolls && clipped === 0,
      bad.length ? `a row that can shrink under its content: ${bad.join('; ')}`
        : `${layouts} layouts, every occupied row at least its content; ${scrolls ? 'scrolls when taller than the window' : 'DOES NOT SCROLL'}${clipped ? `; ${clipped} media rules stop it scrolling` : ''}`);
  }

  // A chain or a drift that ends early settles; it does not shake.
  const shakes = [];
  for (const [f, text] of Object.entries(css)) {
    for (const m of text.matchAll(/\.(goal__chainEnd|hud__drift)\.is-lost\s*\{[^}]*animation:\s*([\w-]+)/g)) {
      const kf = text.match(new RegExp(`@keyframes\\s+${m[2]}\\s*\\{([\\s\\S]*?)\\}\\s*\\}`));
      // Each translateX's argument up to the end of its declaration: the
      // values are calc(var(--u) * -0.8), and a [^)]* capture stops inside them.
      const xs = kf ? [...kf[1].matchAll(/translateX\(([^;}]*)/g)].map((q) => q[1].replace(/\s/g, '')) : [];
      // var(--x) is taken out first: its own "(--" would read as a minus.
      const isNeg = (v) => /[*(]-|^-/.test(v.replace(/var\([^)]*\)/g, 'V'));
      const neg = xs.some(isNeg), pos = xs.some((v) => !isNeg(v));
      if (neg && pos) shakes.push(`${f}: ${m[2]}`);
    }
  }
  check('an ended chain or drift settles instead of shaking', shakes.length === 0, shakes.length ? shakes.join(', ') : 'goal-settle and hud-settle move one way');
}

// ---- no emoji anywhere in the UI source -----------------------------------
{
  const dirs = ['src/game', 'src/input', 'styles'];
  const hits = [];
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (!/\.(js|css)$/.test(f) || f === 'audio.js') continue;
      const lines = readFileSync(join(ROOT, d, f), 'utf8').split('\n');
      lines.forEach((l, i) => { if (EMOJI.test(l)) hits.push(`${d}/${f}:${i + 1}`); });
    }
  }
  check('no emoji in any UI source file', hits.length === 0, hits.length ? hits.slice(0, 6).join(', ') : `${dirs.join(', ')}`);
}

if (fail) {
  console.log(`\n${fail} UI check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');
process.exit(0);
