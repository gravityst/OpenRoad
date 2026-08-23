// The front end: title, garage, settings, pause and map.
//
// This is the first thing anyone sees, so it is built like a game's shell and
// not like a debug panel. Three decisions shape everything below.
//
// EVERY SCREEN IS TRANSLUCENT. main.js keeps rendering the world behind the UI
// the whole time — the title sits over a drive-by, the garage sits over the
// actual car. So there is no opaque backdrop anywhere; screens are gradients
// and glass, and the garage deliberately leaves a hole in the middle of its
// layout (`.or-stage`) for the 3D car to occupy. stageRect() hands main.js the
// rectangle so it can frame the car into it.
//
// THE MENU OWNS ITS KEYS WHILE IT IS OPEN. The driving controls also listen on
// the document, so any key this file acts on is consumed at capture phase — a
// menu that lets Escape through twice pauses and unpauses in the same frame.
//
// THE DISPLAYED CAR FIGURES ARE DERIVED, NOT TYPED IN. catalog.js states what
// the physics needs (watts, gear ratios, drag area); a player wants horsepower,
// 0-100 and a top speed. Writing those out by hand means the garage lies the
// moment anyone retunes a car, so they are computed here from the same spec the
// simulation runs on. See carStats().

import { CARS, CAR_BY_ID, CLASSES, STARTER, specFor } from '../vehicles/catalog.js';
import { DEFAULT_SPEC } from '../physics/vehicle.js';

/** Everything the player has chosen lives under this one key. */
export const SETTINGS_KEY = 'openroad.settings.v1';

// KEY NAMES ARE A CONTRACT. main.js reads settings.post, settings.time,
// settings.quality and the rest straight off the object this file emits, and
// writes the same object back to the same storage key. Renaming anything here
// silently disconnects a control from the thing it is supposed to drive, so the
// names match main.js and the value sets match the modules that consume them:
// `quality` is a tier in render/terrain.js, `post` a tier in render/effects.js.
export const DEFAULT_SETTINGS = {
  quality: 'medium',
  post: 'medium',
  shadows: true,
  drawDistance: 3200,
  traffic: 0.55,
  time: 9.5,
  weather: 'clear',
  esc: true,
  tc: true,
  abs: true,
  invertLook: false,
  sensitivity: 1.0,
  volume: 0.8,
};

// Picking a quality tier snaps the three settings that hurt most, then leaves
// them individually overridable — which is what every game does, and what
// players expect when they drag "High" down to "Low" and still want shadows.
const TIER_PRESETS = {
  low:    { post: 'off',    shadows: false, drawDistance: 1400 },
  medium: { post: 'medium', shadows: true,  drawDistance: 2400 },
  high:   { post: 'high',   shadows: true,  drawDistance: 3600 },
};

const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtMetres = (v) => `${Math.round(v)} m`;
const fmtMult = (v) => `${v.toFixed(2)}×`;
const fmtClock = (v) => {
  const h = Math.floor(v) % 24;
  const m = Math.round((v - Math.floor(v)) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const SETTINGS_SCHEMA = [
  {
    group: 'Display',
    items: [
      { key: 'quality', label: 'Graphics quality', type: 'choice',
        options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      { key: 'post', label: 'Post-processing', type: 'choice',
        options: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
        hint: 'Bloom, vignette and colour shift.' },
      { key: 'shadows', label: 'Shadows', type: 'toggle' },
      { key: 'drawDistance', label: 'Draw distance', type: 'range',
        min: 800, max: 4500, step: 100, format: fmtMetres,
        hint: 'How far buildings and props stay loaded.' },
    ],
  },
  {
    group: 'World',
    items: [
      { key: 'traffic', label: 'Traffic density', type: 'range', min: 0, max: 1, step: 0.05, format: fmtPct },
      { key: 'time', label: 'Time of day', type: 'range', min: 0, max: 24, step: 0.25, format: fmtClock },
      { key: 'weather', label: 'Weather', type: 'choice',
        options: [['clear', 'Clear'], ['cloud', 'Cloud'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['fog', 'Fog']] },
    ],
  },
  {
    group: 'Driving assists',
    items: [
      { key: 'esc', label: 'Stability control', type: 'toggle', hint: 'ESC. Trims the throttle when the car starts to rotate.' },
      { key: 'tc', label: 'Traction control', type: 'toggle', hint: 'TC. Caps wheelspin on the driven axle.' },
      { key: 'abs', label: 'Anti-lock brakes', type: 'toggle', hint: 'ABS. Releases a locked wheel so it steers again.' },
    ],
  },
  {
    group: 'Controls',
    items: [
      { key: 'invertLook', label: 'Invert look', type: 'toggle' },
      { key: 'sensitivity', label: 'Look sensitivity', type: 'range', min: 0.3, max: 2.5, step: 0.05, format: fmtMult },
    ],
  },
  {
    group: 'Audio',
    items: [
      { key: 'volume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, format: fmtPct },
    ],
  },
];

const SCREENS = ['title', 'garage', 'settings', 'pause', 'map'];

const DRIVE_LABEL = { fwd: 'Front-wheel drive', rwd: 'Rear-wheel drive', awd: 'All-wheel drive' };
const DRIVE_SHORT = { fwd: 'FWD', rwd: 'RWD', awd: 'AWD' };

// Map colours, by road kind. Deliberately close to what the roads look like
// from the air: trunk roads warm and dominant, lanes cool and thin, dirt broken.
const MAP_ROADS = {
  highway: { colour: '#ffb43c', w: 3.0, dash: null, z: 5 },
  avenue:  { colour: '#d7dee6', w: 2.1, dash: null, z: 4 },
  link:    { colour: '#aab6c4', w: 1.9, dash: null, z: 3 },
  rural:   { colour: '#93a48c', w: 1.5, dash: null, z: 2 },
  street:  { colour: '#6d7986', w: 1.0, dash: null, z: 1 },
  dirt:    { colour: '#9b7a52', w: 1.2, dash: [4, 4], z: 0 },
  track:   { colour: '#8a6c48', w: 1.0, dash: [2, 5], z: 0 },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Settings as stored, merged over the defaults. Unknown keys in storage are
 * dropped and missing ones filled, so a build that adds a setting still reads
 * an old save instead of throwing it away.
 */
export function loadSettings() {
  const out = { ...DEFAULT_SETTINGS };
  let raw = null;
  try { raw = localStorage.getItem(SETTINGS_KEY); } catch { return out; }
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw);
    for (const k of Object.keys(out)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof out[k]) out[k] = saved[k];
    }
  } catch { /* corrupt entry: the defaults are a perfectly good answer */ }
  return out;
}

/**
 * Written as a merge, not a replace. main.js keeps its own keys in this same
 * entry (timeScale, for one) and the menu has no control for them; overwriting
 * wholesale would quietly delete every setting the menu does not know about.
 */
function persist(settings) {
  try {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { stored = {}; }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...stored, ...settings }));
  } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Derived car figures
// ---------------------------------------------------------------------------

const RHO = 1.225;          // kg/m^3
const GRAV = 9.81;
const DRIVELINE = 0.86;     // crank to contact patch
const ROLL_C = 0.014;       // asphalt rolling resistance coefficient

/**
 * Top speed, in m/s. The car runs out of road speed at whichever comes first:
 * the power needed to push it through the air, or the redline in top gear.
 * Downforce is included because on the supercar it is worth several km/h of
 * extra rolling drag, and quoting a number the car cannot reach is worse than
 * quoting a slightly conservative one.
 */
function topSpeed(spec) {
  let lo = 5, hi = 160;
  for (let i = 0; i < 48; i++) {
    const v = (lo + hi) * 0.5;
    const load = spec.mass * GRAV + spec.downforce * v * v;
    const need = (0.5 * RHO * spec.dragArea * v * v + ROLL_C * load) * v;
    if (need < spec.power * DRIVELINE) lo = v; else hi = v;
  }
  const topGear = spec.gears[spec.gears.length - 1];
  const geared = (spec.redline / 60) * 2 * Math.PI * spec.wheelRadius / (topGear * spec.finalDrive);
  return Math.min(lo, geared);
}

/**
 * 0-100 km/h in seconds, forward-integrated against the same limits the
 * simulation uses: traction on the driven axle first, engine power after.
 * Load transfer is in because it is the whole reason the rear-drive cars launch
 * better than their static weight distribution suggests.
 */
function accelTime(spec) {
  const TARGET = 100 / 3.6;
  const mu = (spec.gripFront + spec.gripRear) * 0.5;
  const staticShare = spec.drive === 'fwd' ? spec.cgBias
    : spec.drive === 'rwd' ? 1 - spec.cgBias : 1;
  const transfer = spec.drive === 'fwd' ? -1 : spec.drive === 'rwd' ? 1 : 0;

  const dt = 0.004;
  let v = 0, t = 0, a = 4;
  while (v < TARGET && t < 40) {
    const share = clamp(staticShare + transfer * (a * spec.cgHeight) / (spec.wheelbase * GRAV), 0.12, 1);
    const load = spec.mass * GRAV + spec.downforce * v * v;
    const traction = mu * share * load;
    // Below a few m/s the clutch, not the engine, sets the torque; capping the
    // divisor keeps the first tenth of a second finite instead of infinite.
    const fromPower = (spec.power * DRIVELINE) / Math.max(v, 3.4);
    const drag = 0.5 * RHO * spec.dragArea * v * v + ROLL_C * load;
    a = (Math.min(traction, fromPower) - drag) / spec.mass;
    if (a <= 0) break;
    v += a * dt;
    t += dt;
  }

  // Every upshift on the way to 100 is a real gap in the drive.
  let shifts = 0;
  for (let g = 0; g < spec.gears.length - 1; g++) {
    const vTop = (spec.redline / 60) * 2 * Math.PI * spec.wheelRadius / (spec.gears[g] * spec.finalDrive);
    if (vTop < TARGET) shifts++;
  }
  return t + shifts * spec.shiftTime;
}

/**
 * The figures the garage prints for one catalogue entry. The spec is merged
 * over DEFAULT_SPEC first because catalog entries only state their differences,
 * and shiftTime in particular is usually left to the default.
 */
export function carStats(car) {
  const spec = { ...DEFAULT_SPEC, ...car.spec };
  const top = topSpeed(spec);
  return {
    hp: Math.round((spec.power / 745.7) / 5) * 5,
    kw: Math.round(spec.power / 1000),
    accel: accelTime(spec),
    topKph: Math.round(top * 3.6),
    mass: spec.mass,
    drive: spec.drive,
    gears: spec.gears.length,
  };
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------

/**
 * Builds the whole front end into `root` and returns a handle to it.
 *
 * opts.world        world from buildWorld(); needed by the map screen. Can also
 *                   arrive later via setWorld().
 * opts.settings     overrides applied on top of whatever was stored.
 * opts.handleEscape set true to let the menu open the pause screen itself.
 *                   Off by default: main.js owns that key. See onKeyDown.
 * opts.stylesheet   set false to skip auto-linking styles/ui.css.
 */
export function createMenus(root, opts = {}) {
  const host = root || document.body;
  let world = opts.world || null;

  // ---- stylesheet ---------------------------------------------------------
  // index.html normally links styles/ui.css itself; this is the fallback for a
  // page that embeds the menu without it. Resolved against this module so it
  // works from any page depth, and skipped if the sheet is already on the page.
  const linked = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((l) => /(^|\/)ui\.css(\?|$)/.test(l.getAttribute('href') || ''));
  if (opts.stylesheet !== false && !linked) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.openroadUi = '';
    link.href = new URL('../../styles/ui.css', import.meta.url).href;
    document.head.appendChild(link);
  }

  // ---- state --------------------------------------------------------------
  const settings = { ...loadSettings(), ...(opts.settings || {}) };
  const handlers = new Map();
  let current = null;          // null means "closed, the player is driving"
  let backTo = 'title';        // where Escape goes from a sub-screen
  let cars = [];
  let stats = [];
  let bars = [];               // normalised 0..1 per car, parallel to `cars`
  let index = 0;
  const colourByCar = new Map();
  let persistTimer = 0;
  let disposed = false;

  // ---- events -------------------------------------------------------------
  function on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => off(event, handler);
  }
  function off(event, handler) {
    const set = handlers.get(event);
    if (set) set.delete(handler);
  }
  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try { h(payload); } catch (err) { console.error(`[menus] ${event} handler failed`, err); }
    }
  }

  // ---- shell --------------------------------------------------------------
  const ui = el('div', 'or-ui');
  ui.dataset.screen = '';
  ui.innerHTML = `
    <div class="or-wash" aria-hidden="true"></div>

    <section class="or-screen or-title" data-screen="title" role="dialog" aria-modal="true" aria-label="Main menu">
      <div class="or-title-inner">
        <p class="or-eyebrow">An open world for driving in</p>
        <h1 class="or-wordmark"><span class="or-word">Open</span><span class="or-word or-word--hi">Road</span></h1>
        <p class="or-tagline">Nowhere to be, and all day to get there.</p>
        <div class="or-title-actions">
          <button class="or-btn or-btn--primary or-btn--xl" data-act="drive" data-autofocus>Drive</button>
          <div class="or-title-secondary">
            <button class="or-btn or-btn--ghost" data-act="garage">Garage</button>
            <button class="or-btn or-btn--ghost" data-act="map">Map</button>
            <button class="or-btn or-btn--ghost" data-act="settings">Settings</button>
          </div>
        </div>
      </div>
      <p class="or-title-foot"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to drive &middot; <kbd>Esc</kbd> to pause</p>
    </section>

    <section class="or-screen or-garage" data-screen="garage" role="dialog" aria-modal="true" aria-label="Garage">
      <header class="or-topbar">
        <button class="or-back" data-act="back" aria-label="Back">&larr;</button>
        <h2 class="or-screen-title">Garage</h2>
      </header>
      <div class="or-garage-grid">
        <div class="or-carlist-wrap">
          <div class="or-carlist" role="listbox" aria-label="Cars" tabindex="-1"></div>
        </div>
        <div class="or-stage" aria-hidden="true"></div>
        <aside class="or-spec">
          <p class="or-spec-class"></p>
          <h3 class="or-spec-name"><span class="or-spec-brand"></span><span class="or-spec-model"></span></h3>
          <p class="or-spec-blurb"></p>
          <div class="or-stats"></div>
          <div class="or-drive">
            <span class="or-drive-label"></span>
            <span class="or-wheels" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          </div>
          <div class="or-swatch-row">
            <span class="or-swatch-label">Paint</span>
            <div class="or-swatches" role="radiogroup" aria-label="Paint"></div>
          </div>
        </aside>
      </div>
      <footer class="or-garage-foot">
        <p class="or-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> car &middot; <kbd>&larr;</kbd><kbd>&rarr;</kbd> paint</p>
        <button class="or-btn or-btn--primary" data-act="drive" data-autofocus>Take it out</button>
      </footer>
    </section>

    <section class="or-screen or-settings" data-screen="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="or-topbar">
        <button class="or-back" data-act="back" aria-label="Back">&larr;</button>
        <h2 class="or-screen-title">Settings</h2>
      </header>
      <div class="or-groups"></div>
      <footer class="or-settings-foot">
        <button class="or-btn or-btn--quiet" data-act="reset">Restore defaults</button>
        <button class="or-btn or-btn--primary" data-act="back" data-autofocus>Done</button>
      </footer>
    </section>

    <section class="or-screen or-pause" data-screen="pause" role="dialog" aria-modal="true" aria-label="Paused">
      <div class="or-card">
        <p class="or-eyebrow">Engine idling</p>
        <h2 class="or-card-title">Paused</h2>
        <div class="or-menu-list">
          <button class="or-btn or-btn--primary" data-act="resume" data-autofocus>Resume</button>
          <button class="or-btn or-btn--ghost" data-act="map">Map</button>
          <button class="or-btn or-btn--ghost" data-act="garage">Garage</button>
          <button class="or-btn or-btn--ghost" data-act="settings">Settings</button>
          <button class="or-btn or-btn--quiet" data-act="quit">Quit to title</button>
        </div>
      </div>
    </section>

    <section class="or-screen or-map" data-screen="map" role="dialog" aria-modal="true" aria-label="Map">
      <header class="or-topbar">
        <button class="or-back" data-act="back" aria-label="Back">&larr;</button>
        <h2 class="or-screen-title">Map</h2>
        <p class="or-map-coords" aria-live="polite"></p>
      </header>
      <div class="or-map-frame">
        <canvas class="or-map-canvas" tabindex="0" role="application"
                aria-label="World map. Arrow keys move the marker, Enter travels there."></canvas>
      </div>
      <footer class="or-map-foot">
        <ul class="or-legend">
          <li><i style="background:#ffb43c"></i>Motorway</li>
          <li><i style="background:#d7dee6"></i>Main road</li>
          <li><i style="background:#6d7986"></i>Street</li>
          <li><i style="background:#9b7a52"></i>Track</li>
        </ul>
        <p class="or-hint">Tap the map to travel there</p>
      </footer>
    </section>
  `;
  host.appendChild(ui);

  const screenEls = {};
  for (const name of SCREENS) screenEls[name] = ui.querySelector(`[data-screen="${name}"]`);

  const listEl = ui.querySelector('.or-carlist');
  const stageEl = ui.querySelector('.or-stage');
  const specEls = {
    cls: ui.querySelector('.or-spec-class'),
    brand: ui.querySelector('.or-spec-brand'),
    model: ui.querySelector('.or-spec-model'),
    blurb: ui.querySelector('.or-spec-blurb'),
    stats: ui.querySelector('.or-stats'),
    driveLabel: ui.querySelector('.or-drive-label'),
    wheels: ui.querySelectorAll('.or-wheels i'),
    swatches: ui.querySelector('.or-swatches'),
  };
  const mapCanvas = ui.querySelector('.or-map-canvas');
  const mapFrame = ui.querySelector('.or-map-frame');
  const mapCoords = ui.querySelector('.or-map-coords');

  // =========================================================================
  // Garage
  // =========================================================================

  const STAT_ROWS = [
    { key: 'power', label: 'Power', value: (s) => `${s.hp} hp`, bar: (b) => b.power },
    { key: 'accel', label: '0–100', value: (s) => `${s.accel.toFixed(1)} s`, bar: (b) => b.accel },
    { key: 'top', label: 'Top speed', value: (s) => `${s.topKph} km/h`, bar: (b) => b.top },
  ];

  const statRowEls = STAT_ROWS.map((row) => {
    const wrap = el('div', 'or-stat');
    wrap.appendChild(el('span', 'or-stat-label', row.label));
    const track = el('span', 'or-stat-track');
    const fill = el('i', 'or-stat-fill');
    track.appendChild(fill);
    wrap.appendChild(track);
    const val = el('span', 'or-stat-value');
    wrap.appendChild(val);
    specEls.stats.appendChild(wrap);
    return { fill, val, row };
  });

  function resolveCar(entry) {
    if (typeof entry === 'string') return CAR_BY_ID[entry] || null;
    return entry && entry.spec ? entry : null;
  }

  /**
   * Bars are relative to the cars on offer, not to absolute limits: a garage of
   * city cars should still show a range rather than five stubs. The floor of
   * 0.1 keeps the slowest car's bar visible as a bar.
   */
  function normalise() {
    const span = (get, invert) => {
      let lo = Infinity, hi = -Infinity;
      for (const s of stats) { const v = get(s); if (v < lo) lo = v; if (v > hi) hi = v; }
      const range = hi - lo;
      return (s) => {
        const t = range < 1e-6 ? 1 : (get(s) - lo) / range;
        return 0.1 + 0.9 * (invert ? 1 - t : t);
      };
    };
    const p = span((s) => s.hp, false);
    const a = span((s) => s.accel, true);
    const t = span((s) => s.topKph, false);
    bars = stats.map((s) => ({ power: p(s), accel: a(s), top: t(s) }));
  }

  function rebuildList() {
    listEl.textContent = '';
    cars.forEach((car, i) => {
      const row = el('button', 'or-car');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.dataset.index = String(i);
      row.tabIndex = -1;
      const text = el('span', 'or-car-text');
      text.appendChild(el('span', 'or-car-brand', car.brand));
      text.appendChild(el('span', 'or-car-model', car.model));
      row.appendChild(text);
      row.appendChild(el('span', 'or-car-class', (CLASSES[car.class] || { name: car.class }).name));
      const chip = el('i', 'or-car-chip');
      chip.style.background = '#' + car.colours[0].toString(16).padStart(6, '0');
      row.appendChild(chip);
      row.addEventListener('click', () => select(i));
      listEl.appendChild(row);
    });
  }

  function colourIndexFor(car) {
    return colourByCar.get(car.id) || 0;
  }

  /** The payload every 'select' and 'drive' event carries. */
  function selection() {
    const car = cars[index];
    if (!car) return null;
    const ci = colourIndexFor(car);
    // Cars that came from the catalogue get the catalogue's own spec builder so
    // the two cannot drift; anything injected through setCars() is assembled
    // the same way here.
    const spec = CAR_BY_ID[car.id]
      ? specFor(car.id, ci)
      : {
          ...car.spec,
          name: `${car.brand} ${car.model}`,
          id: car.id,
          body: car.body,
          cylinders: car.cylinders,
          colour: car.colours[ci % car.colours.length],
        };
    // `colour` is the INDEX, not the hex. main.js feeds it straight to
    // specFor(id, colourIndex) and to the car model, so handing over a packed
    // colour here would paint the wrong car and silently pick a random one.
    return {
      car, index, id: car.id,
      colour: ci,
      colourIndex: ci,
      colourHex: car.colours[ci % car.colours.length],
      spec,
      stats: stats[index],
    };
  }

  function renderSwatches(car) {
    specEls.swatches.textContent = '';
    const ci = colourIndexFor(car);
    car.colours.forEach((hex, i) => {
      const b = el('button', 'or-swatch');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === ci));
      b.setAttribute('aria-label', `Paint ${i + 1}`);
      b.tabIndex = i === ci ? 0 : -1;
      b.style.setProperty('--c', '#' + hex.toString(16).padStart(6, '0'));
      b.addEventListener('click', () => setColour(i));
      specEls.swatches.appendChild(b);
    });
  }

  function renderSpec() {
    const car = cars[index];
    if (!car) return;
    const s = stats[index], b = bars[index];
    specEls.cls.textContent = (CLASSES[car.class] || { name: car.class }).name;
    specEls.brand.textContent = car.brand;
    specEls.model.textContent = car.model;
    specEls.blurb.textContent = car.blurb || '';
    for (const { fill, val, row } of statRowEls) {
      fill.style.width = `${(row.bar(b) * 100).toFixed(1)}%`;
      val.textContent = row.value(s);
    }
    specEls.driveLabel.textContent = `${DRIVE_LABEL[s.drive] || s.drive} · ${DRIVE_SHORT[s.drive] || ''}`;
    // Wheel dots are FL, FR, RL, RR — the same order as car.wheels.
    const driven = [s.drive !== 'rwd', s.drive !== 'rwd', s.drive !== 'fwd', s.drive !== 'fwd'];
    specEls.wheels.forEach((dot, i) => dot.classList.toggle('is-driven', driven[i]));
    renderSwatches(car);

    for (const row of listEl.children) {
      const on = Number(row.dataset.index) === index;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
      row.tabIndex = on ? 0 : -1;
    }
  }

  function select(i, silent) {
    if (!cars.length) return;
    index = clamp(i, 0, cars.length - 1);
    renderSpec();
    const row = listEl.children[index];
    if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!silent) emit('select', selection());
  }

  function setColour(i) {
    const car = cars[index];
    if (!car) return;
    colourByCar.set(car.id, ((i % car.colours.length) + car.colours.length) % car.colours.length);
    renderSpec();
    emit('select', selection());
  }

  function setCars(list) {
    // main.js calls this after the menu has already been built, so hold on to
    // whatever was highlighted rather than snapping back to the top of a list
    // that mostly did not change.
    const wasId = cars[index] ? cars[index].id : null;
    const resolved = (list && list.length ? list : CARS).map(resolveCar).filter(Boolean);
    cars = resolved.length ? resolved : CARS.slice();
    stats = cars.map(carStats);
    normalise();
    rebuildList();
    let want = wasId ? cars.findIndex((c) => c.id === wasId) : -1;
    if (want < 0) want = cars.findIndex((c) => c.id === STARTER);
    select(want < 0 ? 0 : want, true);
  }

  // =========================================================================
  // Settings
  // =========================================================================

  const groupsEl = ui.querySelector('.or-groups');
  const controls = new Map();   // key -> refresh function

  function change(key, value) {
    settings[key] = value;
    if (key === 'quality') Object.assign(settings, TIER_PRESETS[value] || {});
    refreshSettings();
    emit('settings-change', settings);
    // Dragging a slider fires dozens of changes a second; the listeners want
    // every one of them, localStorage does not.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persist(settings), 250);
  }

  function buildControl(item) {
    const row = el('div', 'or-row');
    const head = el('div', 'or-row-head');
    const label = el('label', 'or-row-label', item.label);
    head.appendChild(label);
    if (item.hint) head.appendChild(el('p', 'or-row-hint', item.hint));
    row.appendChild(head);
    const control = el('div', 'or-control');
    row.appendChild(control);

    if (item.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'or-switch';
      input.id = `or-set-${item.key}`;
      label.htmlFor = input.id;
      input.addEventListener('change', () => change(item.key, input.checked));
      control.appendChild(input);
      controls.set(item.key, () => { input.checked = !!settings[item.key]; });

    } else if (item.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'or-range';
      input.min = item.min; input.max = item.max; input.step = item.step;
      input.id = `or-set-${item.key}`;
      label.htmlFor = input.id;
      const read = el('output', 'or-range-value');
      input.addEventListener('input', () => change(item.key, Number(input.value)));
      control.appendChild(input);
      control.appendChild(read);
      controls.set(item.key, () => {
        const v = Number(settings[item.key]);
        input.value = String(v);
        // Drives the filled portion of the track, which no browser gives us.
        input.style.setProperty('--fill', `${((v - item.min) / (item.max - item.min)) * 100}%`);
        read.textContent = item.format ? item.format(v) : String(v);
      });

    } else if (item.type === 'choice') {
      const seg = el('div', 'or-seg');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', item.label);
      const inputs = [];
      for (const [value, text] of item.options) {
        const id = `or-set-${item.key}-${value}`;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `or-set-${item.key}`;
        input.id = id;
        input.value = value;
        input.addEventListener('change', () => { if (input.checked) change(item.key, value); });
        const lab = el('label', 'or-seg-item', text);
        lab.htmlFor = id;
        seg.appendChild(input);
        seg.appendChild(lab);
        inputs.push(input);
      }
      control.appendChild(seg);
      controls.set(item.key, () => {
        for (const input of inputs) input.checked = input.value === settings[item.key];
      });
    }
    return row;
  }

  for (const group of SETTINGS_SCHEMA) {
    const section = el('section', 'or-group');
    section.appendChild(el('h3', 'or-group-title', group.group));
    for (const item of group.items) section.appendChild(buildControl(item));
    groupsEl.appendChild(section);
  }

  function refreshSettings() {
    for (const refresh of controls.values()) refresh();
  }
  refreshSettings();

  // =========================================================================
  // Map
  // =========================================================================

  const mapCtx = mapCanvas.getContext('2d');
  const player = { x: 0, z: 0, yaw: 0, known: false };
  const cursor = { x: 0, z: 0, active: false };
  let staticLayer = null;       // roads + labels, redrawn only on resize
  let mapSize = 0;              // device pixels, square
  let snapXZ = null;            // Float32Array of [x, z, y] road samples
  let snapEdge = null;

  function buildSnapIndex() {
    if (!world || snapXZ) return;
    let n = 0;
    for (const e of world.edges) n += e.pts.length;
    snapXZ = new Float32Array(n * 3);
    snapEdge = new Int32Array(n);
    let k = 0;
    for (const e of world.edges) {
      for (const p of e.pts) {
        snapXZ[k * 3] = p.x; snapXZ[k * 3 + 1] = p.z; snapXZ[k * 3 + 2] = p.y;
        snapEdge[k] = e.i;
        k++;
      }
    }
  }

  /**
   * Nearest point on the road network. Teleporting is only useful if it puts
   * the car somewhere it can drive away from, so a tap in the middle of a field
   * lands on the lane at the edge of it.
   */
  function snapToRoad(x, z) {
    buildSnapIndex();
    if (!snapXZ || !snapXZ.length) return { x, z, y: 0, edge: -1 };
    let best = -1, bd = Infinity;
    for (let i = 0; i < snapEdge.length; i++) {
      const dx = snapXZ[i * 3] - x, dz = snapXZ[i * 3 + 1] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return {
      x: snapXZ[best * 3], z: snapXZ[best * 3 + 1], y: snapXZ[best * 3 + 2],
      edge: snapEdge[best], dist: Math.sqrt(bd),
    };
  }

  function drawStatic(size) {
    const half = world.half;
    const s = size / (half * 2);
    const c = staticLayer || (staticLayer = document.createElement('canvas'));
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const mx = (x) => (x + half) * s;
    const mz = (z) => (z + half) * s;

    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(8, 11, 16, 0.72)';
    g.fillRect(0, 0, size, size);

    // 500 m grid, so distances on the map mean something.
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    for (let v = -half; v <= half; v += 500) {
      g.beginPath();
      g.moveTo(Math.round(mx(v)) + 0.5, 0); g.lineTo(Math.round(mx(v)) + 0.5, size);
      g.moveTo(0, Math.round(mz(v)) + 0.5); g.lineTo(size, Math.round(mz(v)) + 0.5);
      g.stroke();
    }

    // District footprints, under the roads.
    for (const d of world.districts) {
      if (d.id.startsWith('v_')) continue;   // villages get their own marker
      const grd = g.createRadialGradient(mx(d.cx), mz(d.cz), 0, mx(d.cx), mz(d.cz), d.r * s);
      grd.addColorStop(0, 'rgba(255, 180, 60, 0.13)');
      grd.addColorStop(1, 'rgba(255, 180, 60, 0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(mx(d.cx), mz(d.cz), d.r * s, 0, Math.PI * 2);
      g.fill();
    }

    // Roads, thinnest kind first so trunk routes end up on top.
    const order = Object.keys(MAP_ROADS).sort((a, b) => MAP_ROADS[a].z - MAP_ROADS[b].z);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const kind of order) {
      const style = MAP_ROADS[kind];
      g.strokeStyle = style.colour;
      g.lineWidth = Math.max(0.8, style.w * (size / 900));
      g.setLineDash(style.dash ? style.dash.map((v) => v * (size / 900)) : []);
      g.beginPath();
      for (const e of world.edges) {
        if (e.kind !== kind) continue;
        const pts = e.pts;
        g.moveTo(mx(pts[0].x), mz(pts[0].z));
        for (let i = 1; i < pts.length; i++) g.lineTo(mx(pts[i].x), mz(pts[i].z));
      }
      g.stroke();
    }
    g.setLineDash([]);

    // Labels last, with a dark halo so they survive crossing a bright motorway.
    const scale = size / 900;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const label = (text, x, z, px, colour, track) => {
      g.font = `600 ${px * scale}px ui-sans-serif, system-ui, sans-serif`;
      const spaced = track ? text.toUpperCase().split('').join(' ') : text;
      g.lineWidth = 4 * scale;
      g.strokeStyle = 'rgba(4, 6, 9, 0.85)';
      g.strokeText(spaced, mx(x), mz(z));
      g.fillStyle = colour;
      g.fillText(spaced, mx(x), mz(z));
    };
    for (const d of world.districts) {
      if (d.id.startsWith('v_')) continue;
      label(d.name, d.cx, d.cz, 13, 'rgba(255, 214, 150, 0.92)', true);
    }
    for (const v of world.villages) {
      g.beginPath();
      g.arc(mx(v.x), mz(v.z), 3.2 * scale, 0, Math.PI * 2);
      g.fillStyle = 'rgba(226, 234, 242, 0.85)';
      g.fill();
      label(v.name, v.x, v.z + 62, 11, 'rgba(226, 234, 242, 0.82)', false);
    }

    // Compass, so nobody has to work out which way -Z is.
    g.font = `700 ${13 * scale}px ui-sans-serif, system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText('N', size * 0.5, 14 * scale);
  }

  function drawMap() {
    if (!world || current !== 'map' || !mapSize) return;
    const half = world.half;
    const s = mapSize / (half * 2);
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
    mapCtx.clearRect(0, 0, mapSize, mapSize);
    if (staticLayer) mapCtx.drawImage(staticLayer, 0, 0);
    const scale = mapSize / 900;

    if (cursor.active) {
      const cx = (cursor.x + half) * s, cy = (cursor.z + half) * s;
      mapCtx.strokeStyle = 'rgba(111, 208, 232, 0.9)';
      mapCtx.lineWidth = 1.5 * scale;
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 9 * scale, 0, Math.PI * 2);
      mapCtx.moveTo(cx - 15 * scale, cy); mapCtx.lineTo(cx - 12 * scale, cy);
      mapCtx.moveTo(cx + 12 * scale, cy); mapCtx.lineTo(cx + 15 * scale, cy);
      mapCtx.moveTo(cx, cy - 15 * scale); mapCtx.lineTo(cx, cy - 12 * scale);
      mapCtx.moveTo(cx, cy + 12 * scale); mapCtx.lineTo(cx, cy + 15 * scale);
      mapCtx.stroke();
    }

    if (player.known) {
      const px = (player.x + half) * s, py = (player.z + half) * s;
      mapCtx.save();
      mapCtx.translate(px, py);
      // The arrow is drawn pointing up the screen, which is -Z. World forward is
      // (-sin yaw, -cos yaw); canvas rotate(t) turns an up-pointing shape to
      // (sin t, -cos t), so t = -yaw.
      mapCtx.rotate(-player.yaw);
      mapCtx.beginPath();
      mapCtx.moveTo(0, -9 * scale);
      mapCtx.lineTo(6 * scale, 7 * scale);
      mapCtx.lineTo(0, 4 * scale);
      mapCtx.lineTo(-6 * scale, 7 * scale);
      mapCtx.closePath();
      mapCtx.fillStyle = '#ffb43c';
      mapCtx.strokeStyle = 'rgba(6, 8, 12, 0.9)';
      mapCtx.lineWidth = 1.6 * scale;
      mapCtx.fill();
      mapCtx.stroke();
      mapCtx.restore();
    }
  }

  function layoutMap() {
    if (!world) return;
    // The frame is padded, so its border box is the wrong measurement: sizing
    // the canvas from it overflows by exactly the padding and clips the map.
    const cs = getComputedStyle(mapFrame);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const css = Math.max(1, Math.min(mapFrame.clientWidth - padX, mapFrame.clientHeight - padY));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.round(css * dpr);
    if (size === mapSize) { drawMap(); return; }
    mapSize = size;
    mapCanvas.width = size;
    mapCanvas.height = size;
    mapCanvas.style.width = `${css}px`;
    mapCanvas.style.height = `${css}px`;
    drawStatic(size);
    drawMap();
  }

  const mapObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (current === 'map') layoutMap(); })
    : null;
  if (mapObserver) mapObserver.observe(mapFrame);

  function pointToWorld(clientX, clientY) {
    const rect = mapCanvas.getBoundingClientRect();
    const half = world.half;
    return {
      x: ((clientX - rect.left) / rect.width) * half * 2 - half,
      z: ((clientY - rect.top) / rect.height) * half * 2 - half,
    };
  }

  function showCursorAt(x, z) {
    cursor.x = clamp(x, -world.half, world.half);
    cursor.z = clamp(z, -world.half, world.half);
    cursor.active = true;
    const snap = snapToRoad(cursor.x, cursor.z);
    mapCoords.textContent = `${Math.round(cursor.x)}, ${Math.round(cursor.z)}`
      + (snap.dist > 30 ? `  → road ${Math.round(snap.dist)} m away` : '');
    drawMap();
  }

  function travelTo(x, z) {
    const snap = snapToRoad(x, z);
    hide();
    emit('teleport', { x: snap.x, z: snap.z, y: snap.y, edge: snap.edge });
  }

  // Travel on release, and only if the finger stayed put: a drag across the map
  // to read it should not fling the car to wherever the finger came to rest.
  let downAt = null;
  mapCanvas.addEventListener('pointerdown', (e) => {
    if (!world) return;
    mapCanvas.focus();
    downAt = { x: e.clientX, y: e.clientY };
    const p = pointToWorld(e.clientX, e.clientY);
    showCursorAt(p.x, p.z);
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    if (!world || !downAt) return;
    const p = pointToWorld(e.clientX, e.clientY);
    showCursorAt(p.x, p.z);
  });
  mapCanvas.addEventListener('pointerup', (e) => {
    if (!world || !downAt) return;
    const slipped = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 12;
    downAt = null;
    if (slipped) return;
    const p = pointToWorld(e.clientX, e.clientY);
    travelTo(p.x, p.z);
  });
  mapCanvas.addEventListener('pointercancel', () => { downAt = null; });
  mapCanvas.addEventListener('keydown', (e) => {
    if (!world) return;
    const step = e.shiftKey ? 300 : 70;
    let dx = 0, dz = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dz = -step;
    else if (e.key === 'ArrowDown') dz = step;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cursor.active) travelTo(cursor.x, cursor.z);
      return;
    } else return;
    e.preventDefault();
    if (!cursor.active) { cursor.x = player.x; cursor.z = player.z; }
    showCursorAt(cursor.x + dx, cursor.z + dz);
  });

  function setWorld(next) {
    world = next || null;
    snapXZ = null; snapEdge = null; staticLayer = null; mapSize = 0;
    if (current === 'map') layoutMap();
  }

  /** main.js can call this every frame; it only costs anything while the map is up. */
  function setPlayer(x, z, yaw = 0) {
    const moved = Math.abs(x - player.x) > 0.5 || Math.abs(z - player.z) > 0.5
      || Math.abs(yaw - player.yaw) > 0.01;
    player.x = x; player.z = z; player.yaw = yaw; player.known = true;
    if (moved && current === 'map') drawMap();
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  function focusFirst(name) {
    const screen = screenEls[name];
    if (!screen) return;
    const target = screen.querySelector('[data-autofocus]')
      || screen.querySelector(FOCUSABLE);
    if (target) target.focus({ preventScroll: true });
  }

  function show(name) {
    if (!SCREENS.includes(name)) return;
    if (name === 'garage' || name === 'settings' || name === 'map') {
      // Opened straight from the road — main.js does this for the map key — so
      // backing out lands on the pause screen, which is the state the game is
      // actually in. Dropping the player on the title screen mid-drive is not.
      backTo = current === 'title' ? 'title' : 'pause';
    } else {
      backTo = name === 'pause' ? 'pause' : 'title';
    }
    current = name;
    ui.dataset.screen = name;
    for (const key of SCREENS) {
      const on = key === name;
      const screen = screenEls[key];
      screen.classList.toggle('is-on', on);
      screen.setAttribute('aria-hidden', String(!on));
      screen.inert = !on;
    }
    if (name === 'garage' && cars.length) emit('select', selection());
    if (name === 'map') layoutMap();
    focusFirst(name);
    emit('screen', name);
  }

  function hide() {
    if (current === null) return;
    current = null;
    ui.dataset.screen = '';
    for (const key of SCREENS) {
      const screen = screenEls[key];
      screen.classList.remove('is-on');
      screen.setAttribute('aria-hidden', 'true');
      screen.inert = true;
    }
    if (document.activeElement && ui.contains(document.activeElement)) document.activeElement.blur();
    emit('screen', null);
  }

  function goBack() {
    if (current === 'pause' || current === null) { resume(); return; }
    if (current === 'title') return;
    show(backTo === 'pause' ? 'pause' : 'title');
  }

  function resume() {
    hide();
    emit('resume');
  }

  function startDriving() {
    const sel = selection();
    hide();
    emit('drive', sel);
  }

  // One delegated listener for every button on every screen; each declares what
  // it does with data-act, so adding a button never means adding wiring.
  const ACTIONS = {
    drive: startDriving,
    garage: () => show('garage'),
    settings: () => show('settings'),
    map: () => show('map'),
    back: goBack,
    resume,
    quit: () => { show('title'); emit('quit-to-title'); },
    reset: () => {
      Object.assign(settings, DEFAULT_SETTINGS);
      refreshSettings();
      persist(settings);
      emit('settings-change', settings);
    },
  };
  ui.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !ui.contains(btn)) return;
    const action = ACTIONS[btn.dataset.act];
    if (action) { e.preventDefault(); action(); }
  });

  // ---- keyboard -----------------------------------------------------------
  // Capture phase, because the driving controls are also listening on the
  // document and must not see anything the menu has already used.
  function onKeyDown(e) {
    if (disposed) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // While the player is driving the menu is deaf, because main.js owns the
    // pause key: it has to flip its own mode flag and stop the HUD, and two
    // handlers on one Escape would pause and unpause in the same frame. Pass
    // handleEscape:true only if nothing else is watching for it.
    if (current === null) {
      if (e.key === 'Escape' && opts.handleEscape === true) {
        e.preventDefault(); e.stopPropagation();
        show('pause');
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      goBack();
      return;
    }

    if (e.key === 'Tab') { trapTab(e); return; }

    if (current === 'garage') {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); select(index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); select(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setColour(colourIndexFor(cars[index]) + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setColour(colourIndexFor(cars[index]) - 1 + cars[index].colours.length); }
      else if (e.key === 'Enter' && e.target === document.body) { e.preventDefault(); startDriving(); }
      return;
    }

    if (current === 'title' && e.key === 'Enter' && e.target === document.body) {
      e.preventDefault();
      startDriving();
    }
  }

  /** Keeps Tab inside the open screen — an overlay you can tab out of is a trap of its own. */
  function trapTab(e) {
    const screen = screenEls[current];
    const items = [...screen.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!screen.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // ---- go -----------------------------------------------------------------
  setCars(opts.cars);
  hide();

  function dispose() {
    disposed = true;
    clearTimeout(persistTimer);
    persist(settings);
    window.removeEventListener('keydown', onKeyDown, true);
    if (mapObserver) mapObserver.disconnect();
    handlers.clear();
    ui.remove();
    staticLayer = null; snapXZ = null; snapEdge = null;
  }

  return {
    el: ui,
    /** null while the player is driving, otherwise the visible screen name. */
    get current() { return current; },
    /** Live object — read it, do not mutate it; use the settings-change event. */
    settings,
    get cars() { return cars; },
    get selected() { return selection(); },
    /** Where the garage expects the 3D car, in CSS pixels. */
    stageRect: () => stageEl.getBoundingClientRect(),
    show, hide, on, off, setCars, setPlayer, setWorld, dispose,
  };
}
