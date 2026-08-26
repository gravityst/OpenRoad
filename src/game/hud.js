// The driving HUD: instrument cluster, minimap, compass and telltales.
//
// COORDINATE CONVENTION — the minimap depends on it.
//
//   forward = -Z      right = +X      up = +Y      yaw grows counter-clockwise
//   forward = (-sin yaw, 0, -cos yaw)
//
// The world bitmap is drawn north-up with world +X to the right and world +Z
// down, so north (-Z) is at the top. Canvas rotation is clockwise-positive
// because its Y axis points down, and rotating the map by exactly `yaw` brings
// the car's forward vector to screen-up: R(yaw) applied to (-sin yaw, -cos yaw)
// is (0, -1). That single line is derived, not tuned — if the map ever spins the
// wrong way, the bug is in the sign of `heading`, not in this rotation.
//
// COST, AND WHY THE CODE LOOKS LIKE THIS
//
// The HUD runs every frame no matter what else the game is doing, so its budget
// is not "fast enough", it is "invisible". Two rules follow, and nearly every
// decision below is a consequence of one of them:
//
//   1. Nothing that can be drawn once is drawn twice. The entire road network is
//      rasterised into an offscreen bitmap at construction and the minimap is a
//      blit of one rotated crop of it. The dial's face, ticks, numbers and
//      redline band are baked into a second bitmap and rebuilt only when the
//      size or the redline changes. The compass tape is baked into a third and
//      the visible strip is a single drawImage. Per frame the three canvases
//      between them cost one clear, one blit and a couple of dozen arcs.
//
//   2. update() allocates nothing. No object literals, no template strings, no
//      toFixed — every number that reaches the screen is looked up in a string
//      table built at construction, and every DOM write is guarded by the value
//      it last wrote. A HUD that hands the collector a few hundred bytes a frame
//      buys a dropped frame every second or two, which is worse than no HUD.
//
//   3. A panel that shows a STATE rather than a value is redrawn only when the
//      state changes. The damage silhouette folds every dent, pane of glass,
//      light, tyre and corner into one 32-bit signature; if it matches the last
//      frame's, the entire draw is skipped — which on an undamaged car is every
//      frame, and on a wrecked one is every frame between impacts. The drift
//      gauge is the opposite case, a needle that genuinely moves, so it is
//      drawn while a drift is live and not touched at all otherwise.
//
// Text lives in the DOM, not on the canvas. fillText is the most expensive call
// in a 2D context and it re-shapes its glyphs every single time; a <span> whose
// textContent has not changed costs nothing at all. The only per-frame text is
// the handful of place names on the minimap, which genuinely have to move.
//
// Nothing here is interactive, so the whole layer is pointer-events: none and a
// click always reaches the road underneath.

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KMH = 3.6;

// The tach sweeps 250 degrees clockwise from the lower left, which leaves a
// 110 degree gap at the bottom. The pedal arcs fill that gap outward from
// bottom-dead-centre — brake to the left, throttle to the right, the way the
// pedals are laid out — so the ring reads as one instrument.
const DIAL_START = 145 * DEG;
const DIAL_SWEEP = 250 * DEG;
const PEDAL_GAP = 55 * DEG;

const MINIMAP_SPAN = 500;    // metres across the minimap at zoom 1
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const MAP_RES = 2048;        // world bitmap: 2 m per pixel across a 4 km world
const HILLSHADE = 192;       // terrain samples per side for the map's relief
const COMPASS_ARC = 110;     // degrees of heading visible on the strip
const TAPE_REV_MAX = 4096;   // cap one revolution so the tape canvas stays sane

const FONT_MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

const COL_ACCENT = '#ffb648';
const COL_WARN = '#ff5a48';
const COL_COOL = '#5fd0e6';
// Other drivers. Deliberately not the amber your own car and the towns use, and
// not the cyan of villages — at a glance on a busy map the only question that
// matters is "is that a person?", so it gets a hue nothing else owns.
const COL_PLAYER = '#7ef29a';
const COL_GO = '#4ad295';
const COL_NEEDLE = '#ffe7bd';
const COL_NEEDLE_SOFT = 'rgba(255,231,189,0.22)';
const COL_WARN_SOFT = 'rgba(255,90,72,0.28)';
const COL_TRACK = 'rgba(255,255,255,0.085)';
const COL_REDBAND = 'rgba(255,90,72,0.28)';
const COL_TICK = 'rgba(226,236,245,0.46)';
const COL_TICK_DIM = 'rgba(226,236,245,0.20)';
const COL_NUM = 'rgba(226,236,245,0.60)';
const COL_RIM = 'rgba(255,255,255,0.10)';
const COL_LABEL = 'rgba(238,244,250,0.94)';
const COL_LABEL_DIM = 'rgba(214,226,238,0.62)';
const COL_HALO = 'rgba(4,6,9,0.85)';

// Muted so the roads drawn over them stay the brightest thing on the map.
const ROAD_CORE = {
  highway: '#f0b95e', avenue: '#d9e0e7', link: '#c6cfd8', street: '#8b96a2',
  rural: '#c0ab84', dirt: '#8d7550', track: '#7d6647',
};
const ROAD_CASE = {
  highway: '#37281a', avenue: '#1b1f26', link: '#1b1f26', street: '#15181d',
  rural: '#221f18', dirt: '#1e1a14', track: '#1a1712',
};
// Painted smallest first so a highway is never interrupted by a lane crossing it.
const ROAD_ORDER = ['track', 'dirt', 'street', 'rural', 'link', 'avenue', 'highway'];
const NO_DASH = [];

// Elevation ramp for the map's relief, as [metres, r, g, b] quadruples.
const RELIEF = [
  -26, 34, 44, 54,
  -6, 46, 56, 46,
  10, 58, 68, 50,
  34, 76, 72, 54,
  64, 98, 92, 76,
  110, 128, 126, 118,
];

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const SURFACE_LABEL = {
  asphalt: 'ASPHALT', concrete: 'CONCRETE', sidewalk: 'PAVEMENT', dirt: 'DIRT',
  gravel: 'GRAVEL', grass: 'GRASS', sand: 'SAND', rock: 'ROCK',
};
const LOOSE = { dirt: 1, gravel: 1, sand: 1, grass: 1 };

const OPEN_COUNTRY = 'Open Country';
const RPM_LABEL = '×1000 r/min';

// Pre-rendered numerals. update() must never build a string, and every number it
// can show fits in one of these.
const INT_STR = new Array(1000);
for (let i = 0; i < 1000; i++) INT_STR[i] = String(i);
const PAD2 = new Array(60);
for (let i = 0; i < 60; i++) PAD2[i] = i < 10 ? '0' + i : INT_STR[i];
const DEG_STR = new Array(360);
for (let i = 0; i < 360; i++) DEG_STR[i] = (i < 10 ? '00' : i < 100 ? '0' : '') + i + '°';
const TENTH = new Array(10);
for (let i = 0; i < 10; i++) TENTH[i] = '.' + i;
const GEAR_STR = ['R', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// ---- the damage silhouette ------------------------------------------------
//
// A plan view, nose up, laid out in a 0..1 box. x grows to the CAR'S RIGHT
// because the drawing looks straight down, exactly as the minimap does: world
// +X to the right, forward (-Z) up the screen. So wingFL is on the left of the
// picture, and a dented left front corner is drawn at the corner the player
// actually hit. That correspondence is the entire value of the panel — get the
// handedness wrong and it is worse than useless, because it points at the wrong
// side of the car with total confidence.
//
// Each row is [key, x0, y0, x1, y1]. Built once; the redraw walks it by index.
const DMG_PANEL = [
  ['frontBumper', 0.170, 0.012, 0.830, 0.078],
  ['bonnet',      0.332, 0.086, 0.668, 0.268],
  ['wingFL',      0.160, 0.086, 0.325, 0.288],
  ['wingFR',      0.675, 0.086, 0.840, 0.288],
  ['doorL',       0.160, 0.296, 0.325, 0.596],
  ['doorR',       0.675, 0.296, 0.840, 0.596],
  ['roof',        0.378, 0.360, 0.622, 0.578],
  ['wingRL',      0.160, 0.604, 0.325, 0.906],
  ['wingRR',      0.675, 0.604, 0.840, 0.906],
  ['boot',        0.332, 0.670, 0.668, 0.878],
  ['rearBumper',  0.170, 0.920, 0.830, 0.986],
];

const DMG_GLASS = [
  ['windscreen', 0.332, 0.276, 0.668, 0.352],
  ['sideL',      0.332, 0.372, 0.372, 0.566],
  ['sideR',      0.628, 0.372, 0.668, 0.566],
  ['rear',       0.332, 0.586, 0.668, 0.662],
];

// Head first, tail second — the draw uses the index to pick warm white against
// red rather than carrying a colour per row.
const DMG_LIGHT = [
  ['headL', 0.200, 0.018, 0.310, 0.060],
  ['headR', 0.690, 0.018, 0.800, 0.060],
  ['tailL', 0.200, 0.938, 0.310, 0.980],
  ['tailR', 0.690, 0.938, 0.800, 0.980],
];

// Trim that reports itself only by its absence: once one of these detaches its
// mark simply stops being drawn. At this size a missing shape is a louder
// signal than any amount of colour on a shape that is still there.
const DMG_TRIM = [
  ['mirrorL', 0.096, 0.300, 0.158, 0.336],
  ['mirrorR', 0.842, 0.300, 0.904, 0.336],
  ['spoiler', 0.300, 0.884, 0.700, 0.912],
  ['exhaust', 0.560, 0.984, 0.648, 1.000],
];

// Flat [x0, y0, x1, y1] per wheel, in damage.tyre order: fl, fr, rl, rr. The
// wheels sit outboard of the body, which is why the box runs past 0 and 1.
const DMG_WHEEL = [
  0.042, 0.132, 0.158, 0.250,
  0.842, 0.132, 0.958, 0.250,
  0.042, 0.742, 0.158, 0.860,
  0.842, 0.742, 0.958, 0.860,
];

// Twelve-step ramps, pre-built. The silhouette picks a colour per panel, per
// pane and per wheel; composing 'rgb(...)' at that point would allocate on
// every impact, and impacts arrive in bursts of a dozen while a car grinds
// along a wall. Slate through amber to red, so an undamaged car is quiet and
// the first real dent is the brightest thing in the corner of the eye.
const DENT_RAMP = [
  '#2f3742', '#3b414a', '#4c4749', '#61503f', '#7a5c3a', '#976a35',
  '#b47230', '#c96b2f', '#da5a2f', '#e8462d', '#f4362a', '#ff2a20',
];
// Green through red: a tyre reads as a condition, not as a wound, so it starts
// somewhere positive rather than at the body's neutral slate.
const TYRE_RAMP = [
  '#3f9c72', '#4c9c68', '#619b5d', '#7c9a51', '#989747', '#ad8b3f',
  '#bf7a39', '#ca6534', '#d35131', '#da402e', '#df332b', '#e42a26',
];

const COL_SHELL = 'rgba(14,18,24,0.94)';
const COL_SHELL_EDGE = 'rgba(255,255,255,0.16)';
const COL_GONE = 'rgba(255,92,72,0.78)';
const COL_GLASS_OK = 'rgba(120,196,224,0.34)';
const COL_GLASS_CRAZED = 'rgba(206,224,236,0.52)';
const COL_CRACK = 'rgba(250,252,255,0.85)';
const COL_LIGHT_HEAD = 'rgba(255,238,196,0.92)';
const COL_LIGHT_TAIL = 'rgba(255,96,72,0.88)';
const COL_LIGHT_CRACKED = 'rgba(186,178,160,0.60)';
const COL_LIGHT_DEAD = 'rgba(102,110,120,0.55)';
const COL_TRIM = 'rgba(198,212,226,0.60)';
const COL_TRACK_BG = 'rgba(255,255,255,0.10)';
// Mutated in place before setLineDash, so the dash scales with the canvas
// without handing the collector an array on every redraw.
const GAP_DASH = [3, 3];

// The temperature bar stays hidden below this. damage.js idles at 0.35 and
// smoke does not start until 0.72, so anything under about 0.6 is a car working
// hard rather than a car in trouble — showing the gauge there would train the
// player to ignore it.
const TEMP_SHOW = 0.60;

// ---- the drift gauge ------------------------------------------------------

// The needle rides drift.holdRatio, not the raw angle: the drift module already
// knows what counts as a spin ON THIS SURFACE (state.spinAngle moves with grip)
// and publishes |angle| / spinAngle, where 1.0 is the edge of the cliff. A dial
// baked in ratio space is therefore correct on gravel and on asphalt from one
// bake, and — more to the point — the needle answers "how close am I to losing
// this" rather than "how many degrees is it", which is the question the player
// is actually asking mid-corner. The degrees are still printed in the hub, so
// nothing is lost by moving the needle to the more useful scale.
const DRIFT_RATIO_MAX = 1.25;      // full scale, a quarter past the spin line
const DRIFT_SWEEP = 78;            // degrees of needle travel at full scale
const DRIFT_BAND = [0.25, 0.75, 1.0];  // loose | scoring | committed | spinning
const DRIFT_COL = ['rgba(226,236,245,0.42)', '#4ad295', '#ffb648', '#ff5a48'];
const DRIFT_TRACK = [
  'rgba(255,255,255,0.07)', 'rgba(74,210,149,0.20)',
  'rgba(255,182,72,0.22)', 'rgba(255,90,72,0.26)',
];
// A lost chain says WHY it was lost. drift.js only ever reports these three,
// and the fallback covers a reason it might learn to report later.
const TAG_DRIFT = 'DRIFT';
const TAG_BANKED = 'BANKED';
const TAG_LOST = 'LOST';
const LOST_TAG = { spin: 'SPUN', slow: 'TOO SLOW', crash: 'CRASHED' };

// ---- more pre-rendered text ------------------------------------------------

// Past 90 degrees the car is travelling backwards and the chain is already
// gone, so the readout has no reason to count higher.
const ANGLE_MAX = 90;
const ANGLE_STR = new Array(ANGLE_MAX + 1);
for (let i = 0; i <= ANGLE_MAX; i++) ANGLE_STR[i] = INT_STR[i] + '°';
const MULT_STR = new Array(100);
for (let i = 0; i < 100; i++) MULT_STR[i] = '×' + ((i / 10) | 0) + '.' + (i % 10);
const DIGIT = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const BLANK = '';
// Most significant first, so writeScore() can walk the spans left to right.
const POW10 = [100000, 10000, 1000, 100, 10, 1];

// Bar fills are set through transform rather than width, because a width change
// is layout and a transform is not. Sixty-four steps is finer than a pixel on
// any bar this HUD draws, and every step is a string that already exists.
const SCALE_STEPS = 64;
const SCALE_STR = new Array(SCALE_STEPS + 1);
for (let i = 0; i <= SCALE_STEPS; i++) SCALE_STR[i] = 'scaleX(' + (i / SCALE_STEPS) + ')';

// One className write instead of two classList.toggle calls, off a table.
const LAMP_CLASS = ['hud__lamp', 'hud__lamp is-warn', 'hud__lamp is-crit'];
const TEMP_CLASS = [
  'hud__temp is-off', 'hud__temp', 'hud__temp is-warm',
  'hud__temp is-hot', 'hud__temp is-crit',
];
const DRIFT_CLASS = [
  'hud__drift', 'hud__drift is-on',
  'hud__drift is-on is-bank', 'hud__drift is-on is-lost',
];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fontFor(px, weight) {
  return weight + ' ' + Math.max(6, Math.round(px)) + 'px ' + FONT_MONO;
}

/**
 * A rounded rectangle path. arcTo rather than roundRect, which is younger than
 * some of the browsers this game is expected to run in and would take the
 * damage panel out entirely on those.
 */
function rrect(g, x, y, w, h, r) {
  const k = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}

/** Index into a twelve-step ramp from a 0..1 fraction, NaN-safe. */
function rampIndex(t) {
  const i = (t * 11) | 0;
  return i > 11 ? 11 : i > 0 ? i : 0;
}

/** Radians of needle deflection per unit of drift hold ratio. */
const SWEEP_K = (DRIFT_SWEEP / DRIFT_RATIO_MAX) * DEG;

/** A signed drift hold ratio, in radians of needle deflection. */
function sweep(ratio) {
  return ratio * SWEEP_K;
}

const FNV_PRIME = 0x01000193;
/** One step of FNV-1a over a small integer. */
function fold(h, v) {
  return Math.imul(h ^ v, FNV_PRIME);
}

/**
 * Builds the HUD inside `root` and returns its handle.
 *
 * opts.world        the world from buildWorld(); without it the minimap is hidden
 * opts.mapRes       world bitmap resolution, default 2048 (2 m/px over 4 km)
 * opts.speedScale   km/h at the end of the outer speed ring, default 260
 * opts.minimapZoom  starting zoom, 1 = 500 m across the disc
 * opts.visible      start hidden by passing false
 */
export function createHUD(root, opts = {}) {
  const doc = (root && root.ownerDocument) || document;
  const world = opts.world || null;
  const mapRes = opts.mapRes || MAP_RES;
  const speedScale = opts.speedScale || 260;

  function elem(tag, cls, parent) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  // ---- structure ---------------------------------------------------------
  const layer = elem('div', 'hud');
  const grid = elem('div', 'hud__grid', layer);

  const navBox = elem('div', 'hud__nav', grid);
  const compCanvas = elem('canvas', 'hud__compass', navBox);
  const placeRow = elem('div', 'hud__place', navBox);
  const districtEl = elem('span', 'hud__district', placeRow);
  const bearingEl = elem('span', 'hud__bearing', placeRow);

  const statusBox = elem('div', 'hud__status', grid);
  const clockEl = elem('div', 'hud__clock', statusBox);
  const clockH = elem('span', null, clockEl);
  elem('span', 'hud__colon', clockEl).textContent = ':';
  const clockM = elem('span', null, clockEl);
  const odoEl = elem('div', 'hud__odo', statusBox);
  const odoKm = elem('span', null, odoEl);
  const odoT = elem('span', 'hud__odoT', odoEl);
  elem('span', 'hud__odoU', odoEl).textContent = 'km';

  // Top left, diagonally opposite the cluster and on the other side of the
  // screen from the minimap: the four corners each carry one question, and
  // "what have I broken" is the one the player checks least often.
  const dmgBox = elem('div', 'hud__damage is-off', grid);
  const dmgCanvas = elem('canvas', 'hud__damageCanvas', dmgBox);
  const tempEl = elem('div', 'hud__temp is-off', dmgBox);
  elem('span', 'hud__tempLabel', tempEl).textContent = 'TEMP';
  const tempFill = elem('i', 'hud__tempFill', elem('div', 'hud__tempTrack', tempEl));
  const lampBox = elem('div', 'hud__lamps', dmgBox);
  // Left to right in the order these systems actually give out — see the
  // comment over the lamp thresholds in update().
  const lampEl = [
    elem('div', 'hud__lamp', lampBox), elem('div', 'hud__lamp', lampBox),
    elem('div', 'hud__lamp', lampBox), elem('div', 'hud__lamp', lampBox),
  ];
  lampEl[0].textContent = 'COOL';
  lampEl[1].textContent = 'TYRE';
  lampEl[2].textContent = 'ENG';
  lampEl[3].textContent = 'FIRE';

  const driftBox = elem('div', 'hud__drift', grid);
  const driftDial = elem('div', 'hud__driftDial', driftBox);
  const driftCanvas = elem('canvas', 'hud__driftGauge', driftDial);
  const driftAngleEl = elem('div', 'hud__driftAngle', driftDial);
  driftAngleEl.textContent = ANGLE_STR[0];
  const driftRow = elem('div', 'hud__driftRow', driftBox);
  const scoreEl = elem('div', 'hud__driftScore', driftRow);
  // One span per digit. The score outgrows any practical lookup table, so it is
  // written a character at a time out of DIGIT — which costs at most six
  // guarded comparisons and never builds a string, at any magnitude.
  const scoreDigits = [
    elem('span', null, scoreEl), elem('span', null, scoreEl), elem('span', null, scoreEl),
    elem('span', null, scoreEl), elem('span', null, scoreEl), elem('span', null, scoreEl),
  ];
  const multEl = elem('div', 'hud__driftMult', driftRow);
  multEl.textContent = MULT_STR[10];
  const driftTagEl = elem('div', 'hud__driftTag', driftBox);
  driftTagEl.textContent = TAG_DRIFT;

  const mapBox = elem('div', 'hud__map', grid);
  const mapCanvas = elem('canvas', 'hud__mapCanvas', mapBox);
  const surfaceEl = elem('div', 'hud__surface', mapBox);

  const toastEl = elem('div', 'hud__toast', grid);
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');

  const clusterBox = elem('div', 'hud__cluster', grid);
  const tellBox = elem('div', 'hud__tells', clusterBox);
  const limitEl = elem('div', 'hud__limit is-off', tellBox);
  const limitNum = elem('span', null, limitEl);
  const tellHand = elem('div', 'hud__tell hud__tell--hand', tellBox);
  tellHand.textContent = 'HAND';
  const tellSlip = elem('div', 'hud__tell hud__tell--slip', tellBox);
  tellSlip.textContent = 'SLIP';
  const tellAir = elem('div', 'hud__tell hud__tell--air', tellBox);
  tellAir.textContent = 'AIR';
  const dialBox = elem('div', 'hud__dial', clusterBox);
  const dialCanvas = elem('canvas', 'hud__dialCanvas', dialBox);
  const face = elem('div', 'hud__face', dialBox);
  const speedEl = elem('div', 'hud__speed', face);
  speedEl.textContent = '0';
  elem('div', 'hud__speedU', face).textContent = 'km/h';
  const gearEl = elem('div', 'hud__gear', face);
  gearEl.textContent = '1';

  const mapCtx = mapCanvas.getContext('2d');
  const dialCtx = dialCanvas.getContext('2d');
  const compCtx = compCanvas.getContext('2d');
  const dmgCtx = dmgCanvas.getContext('2d');
  const driftCtx = driftCanvas.getContext('2d');
  const dialBase = elem('canvas');            // a cache, deliberately not attached
  const dialBaseCtx = dialBase.getContext('2d');
  const driftBase = elem('canvas');           // likewise: the gauge's baked face
  const driftBaseCtx = driftBase.getContext('2d');
  let tape = null;
  let tapeCtx = null;

  if (root) root.appendChild(layer);

  // ---- the world bitmap --------------------------------------------------

  /** Writes the relief colour for `h` metres into `ramp`. */
  const ramp = new Float64Array(3);
  function reliefColour(h) {
    let k = 0;
    while (k < RELIEF.length - 8 && h > RELIEF[k + 4]) k += 4;
    const h0 = RELIEF[k], h1 = RELIEF[k + 4];
    const t = clamp((h - h0) / (h1 - h0 || 1), 0, 1);
    ramp[0] = RELIEF[k + 1] + (RELIEF[k + 5] - RELIEF[k + 1]) * t;
    ramp[1] = RELIEF[k + 2] + (RELIEF[k + 6] - RELIEF[k + 2]) * t;
    ramp[2] = RELIEF[k + 3] + (RELIEF[k + 7] - RELIEF[k + 3]) * t;
  }

  /**
   * Rasterises the whole world once: relief, blocks, then the road network.
   *
   * Roads are stroked as one path per kind rather than one path per edge —
   * every edge of a kind shares a width, so the ~600 edges collapse into 14
   * strokes and the round joins knit the junctions together for free.
   */
  function buildWorldMap() {
    const canvas = elem('canvas');
    canvas.width = mapRes;
    canvas.height = mapRes;
    const g = canvas.getContext('2d', { alpha: false });
    const half = world.half;
    const span = half * 2;
    const S = mapRes / span;                  // bitmap pixels per metre

    // Relief, sampled coarsely and scaled up. A per-pixel terrain query would be
    // four million calls to fbm; 192 squared is 37 thousand and the smoothing
    // filter hides the difference at minimap zoom.
    const hs = elem('canvas');
    hs.width = HILLSHADE;
    hs.height = HILLSHADE;
    const hg = hs.getContext('2d');
    const img = hg.createImageData(HILLSHADE, HILLSHADE);
    const px = img.data;
    const hgt = new Float32Array(HILLSHADE * HILLSHADE);
    const step = span / HILLSHADE;
    for (let j = 0; j < HILLSHADE; j++) {
      const z = -half + (j + 0.5) * step;
      for (let i = 0; i < HILLSHADE; i++) {
        hgt[j * HILLSHADE + i] = world.terrain.height(-half + (i + 0.5) * step, z);
      }
    }
    for (let j = 0; j < HILLSHADE; j++) {
      const jm = Math.max(0, j - 1) * HILLSHADE;
      const jp = Math.min(HILLSHADE - 1, j + 1) * HILLSHADE;
      for (let i = 0; i < HILLSHADE; i++) {
        const n = j * HILLSHADE + i;
        const gx = hgt[j * HILLSHADE + Math.min(HILLSHADE - 1, i + 1)] - hgt[j * HILLSHADE + Math.max(0, i - 1)];
        const gz = hgt[jp + i] - hgt[jm + i];
        // Lit from the north-west, the cartographic convention — and the one
        // that reads as hills rather than as craters.
        const shade = clamp(0.80 + (-gx - gz) * 0.030, 0.42, 1.45);
        reliefColour(hgt[n]);
        const o = n * 4;
        px[o] = clamp(ramp[0] * shade, 0, 255);
        px[o + 1] = clamp(ramp[1] * shade, 0, 255);
        px[o + 2] = clamp(ramp[2] * shade, 0, 255);
        px[o + 3] = 255;
      }
    }
    hg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(hs, 0, 0, HILLSHADE, HILLSHADE, 0, 0, mapRes, mapRes);
    hs.width = 0;
    hs.height = 0;

    // A wash over the built-up area, so the city reads as city before a single
    // road is drawn. Skipped entirely when there is no city: a zero-radius
    // radial gradient is degenerate, and drawing a grey blob over open
    // countryside would be a lie either way.
    const cityR = world.terrain.cityRadius * S;
    if (cityR > 1) {
    const wash = g.createRadialGradient(mapRes / 2, mapRes / 2, cityR * 0.15, mapRes / 2, mapRes / 2, cityR * 1.3);
    wash.addColorStop(0, 'rgba(104,112,124,0.30)');
    wash.addColorStop(1, 'rgba(104,112,124,0)');
    g.fillStyle = wash;
    g.fillRect(0, 0, mapRes, mapRes);
    }

    for (let i = 0; i < world.blocks.length; i++) {
      const b = world.blocks[i];
      g.save();
      g.translate((b.cx + half) * S, (b.cz + half) * S);
      g.rotate(b.rot);
      g.fillStyle = b.kind === 'park' ? 'rgba(62,96,56,0.60)'
        : b.kind === 'downtown' ? 'rgba(116,120,130,0.55)'
        : b.kind === 'industrial' ? 'rgba(88,86,94,0.50)'
        : 'rgba(94,98,108,0.45)';
      g.fillRect(-b.hx * S, -b.hz * S, b.hx * 2 * S, b.hz * 2 * S);
      g.restore();
    }

    const widthOf = new Map();
    for (let i = 0; i < world.edges.length; i++) {
      const e = world.edges[i];
      if (!widthOf.has(e.kind)) widthOf.set(e.kind, e.width);
    }
    const dash = [Math.max(3, 9 * S), Math.max(2.5, 7 * S)];

    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < ROAD_ORDER.length; k++) {
        const kind = ROAD_ORDER[k];
        const w = widthOf.get(kind);
        if (w === undefined) continue;
        g.beginPath();
        for (let i = 0; i < world.edges.length; i++) {
          const e = world.edges[i];
          if (e.kind !== kind) continue;
          const pts = e.pts;
          g.moveTo((pts[0].x + half) * S, (pts[0].z + half) * S);
          for (let q = 1; q < pts.length; q++) {
            g.lineTo((pts[q].x + half) * S, (pts[q].z + half) * S);
          }
        }
        const loose = kind === 'dirt' || kind === 'track';
        g.setLineDash(pass === 1 && loose ? dash : NO_DASH);
        g.strokeStyle = pass === 0 ? ROAD_CASE[kind] : ROAD_CORE[kind];
        g.lineWidth = Math.max(pass === 0 ? 2.2 : 1.2, w * S * (pass === 0 ? 1.3 : 0.78));
        g.stroke();
      }
    }
    g.setLineDash(NO_DASH);
    return canvas;
  }

  const worldMap = world ? buildWorldMap() : null;
  if (!world) mapBox.style.display = 'none';

  // Districts and villages both live in world.districts, so one list covers both
  // and nothing is labelled twice.
  const places = [];
  const districtNames = new Map();
  if (world) {
    for (let i = 0; i < world.districts.length; i++) {
      const d = world.districts[i];
      places.push({ name: d.name, x: d.cx, z: d.cz, village: d.id.startsWith('v_') });
      districtNames.set(d.id, d.name);
    }
  }

  // ---- sizing ------------------------------------------------------------
  // A 3x phone panel gains nothing at these element sizes and costs real fill
  // rate, so the backing store is capped well below the device ratio.
  let dpr = 0;
  let cx = 0, cy = 0, R = 0, kk = 0, rTach = 0, rSpeed = 0;
  let dialScale = 8000;
  let baseRedline = -1;
  let mapR = 0;
  let tapePxPerDeg = 0, tapeRev = 0;

  function fitCanvas(c) {
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width === w && c.height === h) return false;
    c.width = w;
    c.height = h;
    return true;
  }

  function relayout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    if (fitCanvas(dialCanvas) && dialCanvas.width >= 16) {
      const w = dialCanvas.width, h = dialCanvas.height;
      cx = w * 0.5;
      cy = h * 0.5;
      R = Math.min(w, h) * 0.5 - 2;
      kk = R / 100;                 // every dial dimension is a percentage of R
      rTach = R * 0.795;
      rSpeed = R * 0.955;
      drawDialBase(baseRedline > 0 ? baseRedline : 7000);
    }

    if (fitCanvas(mapCanvas) && mapCanvas.width >= 16) {
      mapR = mapCanvas.width * 0.5;
      // Set once: canvas state survives between frames, so update() never has to
      // re-parse a font or an alignment.
      mapCtx.imageSmoothingEnabled = true;
      mapCtx.imageSmoothingQuality = 'high';
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'middle';
      mapCtx.lineJoin = 'round';
      mapCtx.font = fontFor(mapCanvas.width * 0.062, 700);
      mapCtx.strokeStyle = COL_HALO;
    }

    if (fitCanvas(compCanvas)) buildCompassTape();

    // A resize invalidates the cached picture, not the state behind it, so the
    // signature is poisoned rather than recomputed — the next update() redraws
    // once at the new size and then goes quiet again.
    if (fitCanvas(dmgCanvas)) dmgSig = -1;
    if (fitCanvas(driftCanvas)) buildDriftBase();
  }

  // ---- the dial ----------------------------------------------------------

  function drawDialBase(redline) {
    const w = dialCanvas.width, h = dialCanvas.height;
    if (w < 16) return;
    baseRedline = redline;
    // Round the scale up past the limiter so the redline band always has room
    // to show, whatever car the player is in — 6900 gives 8000, 14000 gives 15000.
    dialScale = Math.max(1000, Math.ceil(redline * 1.06 / 1000) * 1000);
    dialBase.width = w;
    dialBase.height = h;
    const g = dialBaseCtx;

    const glass = g.createRadialGradient(cx, cy - R * 0.28, R * 0.10, cx, cy, R);
    glass.addColorStop(0, 'rgba(27,33,42,0.62)');
    glass.addColorStop(1, 'rgba(8,10,14,0.88)');
    g.fillStyle = glass;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fill();
    g.strokeStyle = COL_RIM;
    g.lineWidth = kk * 1.1;
    g.beginPath();
    g.arc(cx, cy, R - kk * 0.6, 0, TAU);
    g.stroke();

    g.lineCap = 'butt';
    g.strokeStyle = COL_TRACK;
    g.lineWidth = kk * 8.6;
    g.beginPath();
    g.arc(cx, cy, rTach, DIAL_START, DIAL_START + DIAL_SWEEP);
    g.stroke();
    g.lineWidth = kk * 2.6;
    g.beginPath();
    g.arc(cx, cy, rSpeed, DIAL_START, DIAL_START + DIAL_SWEEP);
    g.stroke();
    g.lineCap = 'round';
    g.lineWidth = kk * 4.4;
    g.beginPath();
    g.arc(cx, cy, rTach, HALF_PI - PEDAL_GAP, HALF_PI + PEDAL_GAP);
    g.stroke();

    g.lineCap = 'butt';
    g.strokeStyle = COL_REDBAND;
    g.lineWidth = kk * 8.6;
    g.beginPath();
    g.arc(cx, cy, rTach, DIAL_START + DIAL_SWEEP * clamp(redline / dialScale, 0, 1), DIAL_START + DIAL_SWEEP);
    g.stroke();

    const major = dialScale > 10000 ? 2000 : 1000;
    const minor = major / 2;
    g.font = fontFor(R * 0.135, 600);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let v = 0; v <= dialScale; v += minor) {
      const a = DIAL_START + DIAL_SWEEP * (v / dialScale);
      const ca = Math.cos(a), sa = Math.sin(a);
      const isMajor = v % major === 0;
      const r0 = rTach + kk * 5.6;
      const r1 = rTach + kk * (isMajor ? 11 : 8.2);
      g.strokeStyle = v >= redline ? COL_WARN : isMajor ? COL_TICK : COL_TICK_DIM;
      g.lineWidth = kk * (isMajor ? 1.9 : 1.1);
      g.beginPath();
      g.moveTo(cx + ca * r0, cy + sa * r0);
      g.lineTo(cx + ca * r1, cy + sa * r1);
      g.stroke();
      if (!isMajor) continue;
      const rn = rTach - kk * 12;
      g.fillStyle = v >= redline ? COL_WARN : COL_NUM;
      g.fillText(INT_STR[v / 1000], cx + ca * rn, cy + sa * rn);
    }

    // Below the readout, not above it. The digital speed, its unit and the gear
    // are centred as one stack about 0.43 R tall, so anything above the middle
    // ends up behind the numerals; underneath there is nothing until the pedal
    // arcs at 0.795 R.
    g.font = fontFor(R * 0.098, 500);
    g.fillStyle = 'rgba(226,236,245,0.34)';
    g.fillText(RPM_LABEL, cx, cy + R * 0.60);
  }

  function drawDial(rpm, redline, kmh, throttle, brake, hot) {
    const w = dialCanvas.width;
    if (w < 16) return;
    if (redline !== baseRedline) drawDialBase(redline);
    const g = dialCtx;
    g.clearRect(0, 0, w, dialCanvas.height);
    g.drawImage(dialBase, 0, 0);

    const tr = clamp(rpm / dialScale, 0, 1);
    g.lineCap = 'butt';
    g.lineWidth = kk * 8.6;
    g.strokeStyle = hot ? COL_WARN : COL_ACCENT;
    g.beginPath();
    g.arc(cx, cy, rTach, DIAL_START, DIAL_START + DIAL_SWEEP * tr);
    g.stroke();

    g.lineWidth = kk * 2.6;
    g.strokeStyle = COL_COOL;
    g.beginPath();
    g.arc(cx, cy, rSpeed, DIAL_START, DIAL_START + DIAL_SWEEP * clamp(kmh / speedScale, 0, 1));
    g.stroke();

    g.lineCap = 'round';
    g.lineWidth = kk * 4.4;
    if (throttle > 0.01) {
      g.strokeStyle = COL_GO;
      g.beginPath();
      g.arc(cx, cy, rTach, HALF_PI - PEDAL_GAP * clamp(throttle, 0, 1), HALF_PI);
      g.stroke();
    }
    if (brake > 0.01) {
      g.strokeStyle = COL_WARN;
      g.beginPath();
      g.arc(cx, cy, rTach, HALF_PI, HALF_PI + PEDAL_GAP * clamp(brake, 0, 1));
      g.stroke();
    }

    // A short pointer riding the ring rather than a full needle from the hub:
    // the middle of the dial belongs to the digital readout.
    const a = DIAL_START + DIAL_SWEEP * tr;
    const ca = Math.cos(a), sa = Math.sin(a);
    const n0 = R * 0.66, n1 = R * 0.90;
    // Two strokes instead of a shadowBlur — a blur costs more than the entire
    // rest of the HUD on an integrated GPU.
    g.strokeStyle = hot ? COL_WARN_SOFT : COL_NEEDLE_SOFT;
    g.lineWidth = kk * 7;
    g.beginPath();
    g.moveTo(cx + ca * n0, cy + sa * n0);
    g.lineTo(cx + ca * n1, cy + sa * n1);
    g.stroke();
    g.strokeStyle = hot ? '#fff2ee' : COL_NEEDLE;
    g.lineWidth = kk * 2.4;
    g.beginPath();
    g.moveTo(cx + ca * n0, cy + sa * n0);
    g.lineTo(cx + ca * n1, cy + sa * n1);
    g.stroke();
  }

  // ---- the compass strip -------------------------------------------------

  /**
   * Bakes three consecutive revolutions of the tape. Three, so the window can
   * sit anywhere in the middle copy and never run off either end — which means
   * the per-frame cost is one drawImage with no wrap-around special case.
   */
  function buildCompassTape() {
    const w = compCanvas.width, h = compCanvas.height;
    if (w < 32) return;
    tapePxPerDeg = w / COMPASS_ARC;
    tapeRev = Math.round(360 * tapePxPerDeg);
    if (tapeRev > TAPE_REV_MAX) {
      tapeRev = TAPE_REV_MAX;
      tapePxPerDeg = tapeRev / 360;
    }
    if (!tape) {
      tape = elem('canvas');
      tapeCtx = tape.getContext('2d');
    }
    tape.width = tapeRev * 3;
    tape.height = h;
    const g = tapeCtx;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const bigFont = fontFor(h * 0.40, 700);
    const smallFont = fontFor(h * 0.28, 600);
    for (let rep = 0; rep < 3; rep++) {
      const off = rep * tapeRev;
      for (let d = 0; d < 360; d += 15) {
        const x = off + d * tapePxPerDeg;
        const isMajor = d % 45 === 0;
        g.strokeStyle = isMajor ? 'rgba(226,236,245,0.55)' : 'rgba(226,236,245,0.20)';
        g.lineWidth = Math.max(1, h * (isMajor ? 0.055 : 0.035));
        g.beginPath();
        g.moveTo(x, h * 0.06);
        g.lineTo(x, h * (isMajor ? 0.34 : 0.24));
        g.stroke();
        if (!isMajor) continue;
        const cardinal = d % 90 === 0;
        g.font = cardinal ? bigFont : smallFont;
        g.fillStyle = d === 0 ? COL_WARN : cardinal ? COL_LABEL : COL_LABEL_DIM;
        g.fillText(CARDINALS[d / 45], x, h * 0.66);
      }
    }
  }

  function drawCompass(bearingDeg) {
    const w = compCanvas.width, h = compCanvas.height;
    if (!tape || w < 32) return;
    compCtx.clearRect(0, 0, w, h);
    const p = tapeRev + bearingDeg * tapePxPerDeg;
    compCtx.drawImage(tape, p - w * 0.5, 0, w, h, 0, 0, w, h);
  }

  // ---- the minimap -------------------------------------------------------

  let zoom = clamp(opts.minimapZoom || 1, ZOOM_MIN, ZOOM_MAX);

  function drawMap(px, pz, heading, players) {
    const w = mapCanvas.width;
    if (!worldMap || w < 16) return;
    const g = mapCtx;
    const r = mapR;
    g.clearRect(0, 0, w, mapCanvas.height);

    const span = MINIMAP_SPAN / zoom;          // metres across the disc
    const mpp = span / w;                      // metres per device pixel
    const S = mapRes / (world.half * 2);       // bitmap pixels per metre
    // Crop the square that circumscribes the disc, so no rotation can swing an
    // undrawn corner into view.
    const srcHalf = span * 0.7072 * S;
    const dstHalf = span * 0.7072 / mpp;

    g.save();
    g.beginPath();
    g.arc(r, r, r, 0, TAU);
    g.clip();

    g.save();
    g.translate(r, r);
    g.rotate(heading);
    g.drawImage(
      worldMap,
      (px + world.half) * S - srcHalf, (pz + world.half) * S - srcHalf, srcHalf * 2, srcHalf * 2,
      -dstHalf, -dstHalf, dstHalf * 2, dstHalf * 2,
    );
    g.restore();

    // Labels are drawn unrotated so they stay readable, but positioned through
    // the same rotation the bitmap got.
    const ch = Math.cos(heading), sh = Math.sin(heading);
    const range = span * 1.55;
    const villageRange = range > 1200 ? range : 1200;
    const edge = r * 0.74;
    g.strokeStyle = COL_HALO;
    g.lineWidth = w * 0.013;
    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const dx = p.x - px, dz = p.z - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > (p.village ? villageRange : range)) continue;
      let sx = (dx * ch - dz * sh) / mpp;
      let sy = (dx * sh + dz * ch) / mpp;
      const sd = Math.sqrt(sx * sx + sy * sy);
      let onRim = false;
      if (sd > edge) {
        const f = edge / sd;
        sx *= f;
        sy *= f;
        onRim = true;
      }
      g.beginPath();
      g.arc(r + sx, r + sy, w * (onRim ? 0.010 : 0.015), 0, TAU);
      g.fillStyle = p.village ? COL_COOL : COL_ACCENT;
      g.fill();
      const ly = r + sy + w * 0.056;
      g.strokeText(p.name, r + sx, ly);
      g.fillStyle = onRim ? COL_LABEL_DIM : COL_LABEL;
      g.fillText(p.name, r + sx, ly);
    }

    // Other drivers. Same rim-clamping the place labels use: a blip that would
    // fall outside the disc is pulled to the edge and hollowed out, so "north
    // of here, a long way" and "north of here, close" never look the same.
    if (players && players.length) {
      g.lineWidth = w * 0.011;
      for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (!q || !q.active || q.fade <= 0) continue;
        const dx = q.x - px, dz = q.z - pz;
        let sx = (dx * ch - dz * sh) / mpp;
        let sy = (dx * sh + dz * ch) / mpp;
        const sd = Math.sqrt(sx * sx + sy * sy);
        const off = sd > edge;
        if (off) { const f = edge / sd; sx *= f; sy *= f; }
        g.globalAlpha = q.fade;
        // A wedge, not a dot: it carries their heading, so you can see which
        // way someone is pointing before you can see their car.
        const hd = q.yaw - heading;
        const bs = w * (off ? 0.019 : 0.026);
        g.save();
        g.translate(r + sx, r + sy);
        g.rotate(-hd);
        g.beginPath();
        g.moveTo(0, -bs);
        g.lineTo(bs * 0.66, bs * 0.72);
        g.lineTo(0, bs * 0.3);
        g.lineTo(-bs * 0.66, bs * 0.72);
        g.closePath();
        g.fillStyle = off ? 'transparent' : COL_PLAYER;
        g.strokeStyle = COL_PLAYER;
        if (!off) g.fill();
        g.stroke();
        g.restore();
        if (!off && q.name) {
          g.strokeStyle = COL_HALO;
          g.lineWidth = w * 0.013;
          const ly = r + sy - w * 0.038;
          g.strokeText(q.name, r + sx, ly);
          g.fillStyle = COL_PLAYER;
          g.fillText(q.name, r + sx, ly);
          g.lineWidth = w * 0.011;
        }
      }
      g.globalAlpha = 1;
    }

    // North, so the rotation is always legible at a glance.
    const nx = sh, ny = -ch;
    g.strokeStyle = COL_WARN;
    g.lineWidth = w * 0.016;
    g.beginPath();
    g.moveTo(r + nx * r * 0.87, r + ny * r * 0.87);
    g.lineTo(r + nx * r * 0.99, r + ny * r * 0.99);
    g.stroke();

    const a = w * 0.052;
    g.beginPath();
    g.moveTo(r, r - a);
    g.lineTo(r + a * 0.62, r + a * 0.72);
    g.lineTo(r, r + a * 0.32);
    g.lineTo(r - a * 0.62, r + a * 0.72);
    g.closePath();
    g.fillStyle = COL_ACCENT;
    g.fill();
    g.strokeStyle = COL_HALO;
    g.lineWidth = w * 0.010;
    g.stroke();

    g.restore();
  }

  // ---- the damage panel --------------------------------------------------

  let dmgSig = -1;

  /**
   * Everything the silhouette can show, quantised and folded into one 32-bit
   * number. Dents to twelve steps because that is the length of the ramp, glass
   * and lights to three because that is all the states they are drawn in,
   * integrity to forty because that is roughly the bar's length in device
   * pixels. Nothing is quantised finer than the picture can express, so the
   * signature changes exactly when the picture would.
   *
   * WHY THIS IS WRITTEN OUT LONGHAND instead of walking the geometry tables,
   * which is what it did first and what it obviously should do:
   *
   * damage.panel, damage.glass and damage.light are plain objects holding
   * DOUBLES, and a keyed load with a variable name — d.panel[k] — goes through
   * the generic path and hands back a boxed heap number. Reading eleven panels
   * that way allocated about 96 bytes every single frame; measured over five
   * million calls with a 1 MB nursery it was 459 scavenges against zero for the
   * same arithmetic through named properties. Indexed reads off the tyre,
   * blown and suspension ARRAYS are free and stay in a loop.
   *
   * So the cost of this being ugly is that a panel added to DMG_PANEL must be
   * added here too, and the benefit is that the HUD hands the collector nothing
   * on a frame where nothing has broken — which is nearly every frame.
   */
  function damageSignature(d) {
    const p = d.panel, gl = d.glass, li = d.light, at = d.attached;
    let h = 0x811c9dc5;

    h = fold(h, rampIndex(p.frontBumper) | (at.frontBumper === false ? 16 : 0));
    h = fold(h, rampIndex(p.rearBumper) | (at.rearBumper === false ? 16 : 0));
    h = fold(h, rampIndex(p.bonnet) | (at.bonnet === false ? 16 : 0));
    h = fold(h, rampIndex(p.boot) | (at.boot === false ? 16 : 0));
    h = fold(h, rampIndex(p.doorL) | (at.doorL === false ? 16 : 0));
    h = fold(h, rampIndex(p.doorR) | (at.doorR === false ? 16 : 0));
    h = fold(h, rampIndex(p.roof));
    h = fold(h, rampIndex(p.wingFL));
    h = fold(h, rampIndex(p.wingFR));
    h = fold(h, rampIndex(p.wingRL));
    h = fold(h, rampIndex(p.wingRR));

    h = fold(h, (gl.windscreen * 2) | 0);
    h = fold(h, (gl.sideL * 2) | 0);
    h = fold(h, (gl.sideR * 2) | 0);
    h = fold(h, (gl.rear * 2) | 0);

    h = fold(h, (li.headL * 2) | 0);
    h = fold(h, (li.headR * 2) | 0);
    h = fold(h, (li.tailL * 2) | 0);
    h = fold(h, (li.tailR * 2) | 0);

    // The trim is drawn or not drawn, so four bits carry all of it.
    h = fold(h, (at.mirrorL === false ? 1 : 0) | (at.mirrorR === false ? 2 : 0)
      | (at.spoiler === false ? 4 : 0) | (at.exhaust === false ? 8 : 0));

    for (let i = 0; i < 4; i++) {
      h = fold(h, rampIndex(d.tyre[i]) | (d.blown[i] ? 16 : 0)
        | (rampIndex(d.suspension[i]) << 5));
    }
    return fold(h, (d.integrity * 40) | 0);
  }

  /**
   * The whole car, in about seventy paths. Called only when damageSignature()
   * moves.
   *
   * Order matters: the dark shell goes down first so that anything drawn as an
   * absence — a detached bumper, a windscreen that has left the frame — shows
   * the body cavity underneath rather than a hole punched clean through the
   * HUD onto the road.
   */
  function drawDamage(d) {
    const w = dmgCanvas.width, h = dmgCanvas.height;
    if (w < 16) return;
    const g = dmgCtx;
    g.clearRect(0, 0, w, h);

    const bh = h * 0.93;                 // the bottom strip is the integrity bar
    const r = w * 0.05;
    const hair = Math.max(1, w * 0.012);
    GAP_DASH[0] = Math.max(2, w * 0.036);
    GAP_DASH[1] = GAP_DASH[0];

    rrect(g, w * 0.155, bh * 0.006, w * 0.69, bh * 0.988, r);
    g.fillStyle = COL_SHELL;
    g.fill();
    g.strokeStyle = COL_SHELL_EDGE;
    g.lineWidth = hair;
    g.stroke();

    for (let i = 0; i < DMG_PANEL.length; i++) {
      const p = DMG_PANEL[i];
      const x = p[1] * w, y = p[2] * bh;
      rrect(g, x, y, (p[3] - p[1]) * w, (p[4] - p[2]) * bh, r * 0.42);
      // Panels that are not in DETACHABLE never have an `attached` entry, and
      // `undefined === false` is false — so the roof can never read as missing.
      if (d.attached[p[0]] === false) {
        g.setLineDash(GAP_DASH);
        g.strokeStyle = COL_GONE;
        g.lineWidth = hair;
        g.stroke();
        g.setLineDash(NO_DASH);
        continue;
      }
      g.fillStyle = DENT_RAMP[rampIndex(d.panel[p[0]])];
      g.fill();
    }

    for (let i = 0; i < DMG_GLASS.length; i++) {
      const q = DMG_GLASS[i];
      const x = q[1] * w, y = q[2] * bh;
      const gw = (q[3] - q[1]) * w, gh = (q[4] - q[2]) * bh;
      const v = d.glass[q[0]] || 0;
      rrect(g, x, y, gw, gh, r * 0.3);
      if (v >= 1) {
        g.setLineDash(GAP_DASH);
        g.strokeStyle = COL_GONE;
        g.lineWidth = hair;
        g.stroke();
        g.setLineDash(NO_DASH);
        continue;
      }
      g.fillStyle = v >= 0.5 ? COL_GLASS_CRAZED : COL_GLASS_OK;
      g.fill();
      if (v < 0.5) continue;
      // Three strokes: at this size that is as much spidering as the pane can
      // hold before it turns into a solid white block.
      g.strokeStyle = COL_CRACK;
      g.lineWidth = Math.max(1, w * 0.006);
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x + gw, y + gh);
      g.moveTo(x + gw, y); g.lineTo(x, y + gh);
      g.moveTo(x + gw * 0.5, y); g.lineTo(x + gw * 0.5, y + gh);
      g.stroke();
    }

    for (let i = 0; i < DMG_LIGHT.length; i++) {
      const l = DMG_LIGHT[i];
      const v = d.light[l[0]] || 0;
      rrect(g, l[1] * w, l[2] * bh, (l[3] - l[1]) * w, (l[4] - l[2]) * bh, r * 0.24);
      g.fillStyle = v >= 1 ? COL_LIGHT_DEAD
        : v >= 0.5 ? COL_LIGHT_CRACKED
        : i < 2 ? COL_LIGHT_HEAD : COL_LIGHT_TAIL;
      g.fill();
    }

    g.fillStyle = COL_TRIM;
    for (let i = 0; i < DMG_TRIM.length; i++) {
      const t = DMG_TRIM[i];
      if (d.attached[t[0]] === false) continue;
      rrect(g, t[1] * w, t[2] * bh, (t[3] - t[1]) * w, (t[4] - t[2]) * bh, r * 0.22);
      g.fill();
    }

    for (let i = 0; i < 4; i++) {
      const o = i * 4;
      const x = DMG_WHEEL[o] * w, y = DMG_WHEEL[o + 1] * bh;
      const ww = (DMG_WHEEL[o + 2] - DMG_WHEEL[o]) * w;
      const wh = (DMG_WHEEL[o + 3] - DMG_WHEEL[o + 1]) * bh;
      rrect(g, x, y, ww, wh, ww * 0.34);
      if (d.blown[i]) {
        // The one failure on this panel drawn both hollow AND in red. A blown
        // tyre changes what the car will do in the next two seconds, so it gets
        // the loudest mark the silhouette has.
        g.fillStyle = COL_SHELL;
        g.fill();
        g.strokeStyle = COL_WARN;
        g.lineWidth = Math.max(1.5, w * 0.018);
        g.stroke();
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + ww, y + wh);
        g.stroke();
      } else {
        g.fillStyle = TYRE_RAMP[rampIndex(1 - d.tyre[i])];
        g.fill();
      }
      // Suspension, as a bar OUTBOARD of the wheel that shortens as the corner
      // folds. Outboard because inboard is body, and two marks stacked on the
      // wing would read as one confused smear at a glance. Two marks per corner,
      // both at the corner, answers "which corner is wrecked" in one look.
      const sus = clamp(d.suspension[i], 0, 1);
      const barH = wh * (0.20 + 0.80 * sus);
      const bx = i % 2 === 0 ? x - w * 0.032 : x + ww + w * 0.010;
      g.fillStyle = DENT_RAMP[rampIndex(1 - sus)];
      g.fillRect(bx, y + (wh - barH) * 0.5, w * 0.022, barH);
    }

    // One overall number, on the green-to-red ramp so an intact car shows a
    // full green bar and there is something to watch it leave.
    const integ = clamp(d.integrity, 0, 1);
    const iy = h * 0.952, ih = h * 0.030;
    g.fillStyle = COL_TRACK_BG;
    g.fillRect(w * 0.06, iy, w * 0.88, ih);
    g.fillStyle = TYRE_RAMP[rampIndex(1 - integ)];
    g.fillRect(w * 0.06, iy, w * 0.88 * integ, ih);
  }

  // ---- the drift gauge ---------------------------------------------------

  let dcx = 0, dcy = 0, dR = 0, dBand = 0;
  let driftBaseReady = false;

  /**
   * Bakes the face: the four bands mirrored either side of top-dead-centre, the
   * ticks, and the index mark. Everything here is static, so the live gauge is
   * one blit, one arc and one line.
   */
  function buildDriftBase() {
    const w = driftCanvas.width, h = driftCanvas.height;
    driftBaseReady = false;
    if (w < 32) return;
    driftBase.width = w;
    driftBase.height = h;
    const g = driftBaseCtx;
    dcx = w * 0.5;
    dcy = h * 0.96;
    dBand = h * 0.17;
    dR = Math.min(w * 0.48, h * 0.88) - dBand * 0.5;

    g.lineCap = 'butt';
    g.lineWidth = dBand;
    for (let side = -1; side <= 1; side += 2) {
      let from = 0;
      for (let b = 0; b < 4; b++) {
        const to = b < 3 ? DRIFT_BAND[b] : DRIFT_RATIO_MAX;
        g.strokeStyle = DRIFT_TRACK[b];
        g.beginPath();
        if (side > 0) g.arc(dcx, dcy, dR, -HALF_PI + sweep(from), -HALF_PI + sweep(to));
        else g.arc(dcx, dcy, dR, -HALF_PI - sweep(to), -HALF_PI - sweep(from));
        g.stroke();
        from = to;
      }
    }

    // One tick, at the spin line. More would be decoration: there is exactly
    // one boundary on this dial that costs the player anything to cross.
    g.strokeStyle = COL_LABEL;
    g.lineWidth = Math.max(1, w * 0.007);
    const r0 = dR - dBand * 0.5, r1 = dR + dBand * 0.5;
    for (let side = -1; side <= 1; side += 2) {
      const t = side * sweep(DRIFT_BAND[2]);
      const ct = Math.sin(t), st = -Math.cos(t);
      g.beginPath();
      g.moveTo(dcx + ct * r0, dcy + st * r0);
      g.lineTo(dcx + ct * r1, dcy + st * r1);
      g.stroke();
    }

    // Straight ahead, and the thing the needle is trying to get back to.
    g.strokeStyle = COL_LABEL;
    g.lineWidth = Math.max(1.5, w * 0.009);
    g.beginPath();
    g.moveTo(dcx, dcy - dR - dBand * 0.5);
    g.lineTo(dcx, dcy - dR - dBand * 1.15);
    g.stroke();
    driftBaseReady = true;
  }

  /**
   * The needle position, handed over in `needle` rather than as an argument.
   *
   * A double passed to a function this size is boxed into a heap number at the
   * call site — TurboFan will not inline a body with this many canvas calls in
   * it — which cost about 16 bytes a frame while a drift was live. A one-slot
   * Float64Array holds the value unboxed and the call takes no arguments at
   * all. drawDial() above has the same leak for five of its six arguments and
   * would take the same fix; it is left alone here only because changing it is
   * not what this change is for.
   */
  const needle = new Float64Array(1);

  /**
   * needle[0] is a signed hold ratio: |angle| / spinAngle carrying the sign of
   * the angle. Positive swings the needle right, matching drift.js — positive
   * angle is the tail out to the right — and matching yaw growing
   * counter-clockwise seen from above.
   */
  function drawDriftGauge() {
    const w = driftCanvas.width;
    if (!driftBaseReady || w < 32) return;
    const g = driftCtx;
    g.clearRect(0, 0, w, driftCanvas.height);
    g.drawImage(driftBase, 0, 0);

    let r = needle[0];
    if (r > DRIFT_RATIO_MAX) r = DRIFT_RATIO_MAX;
    else if (r < -DRIFT_RATIO_MAX) r = -DRIFT_RATIO_MAX;
    const mag = r < 0 ? -r : r;
    g.strokeStyle = mag < DRIFT_BAND[0] ? DRIFT_COL[0]
      : mag < DRIFT_BAND[1] ? DRIFT_COL[1]
      : mag < DRIFT_BAND[2] ? DRIFT_COL[2] : DRIFT_COL[3];

    // The sweep from centre out to the needle. Magnitude as an area rather than
    // as a position is what makes the gauge legible while the player's eyes are
    // on the apex and not on the HUD.
    const a = r * SWEEP_K;
    g.lineCap = 'butt';
    g.lineWidth = dBand;
    g.beginPath();
    if (a >= 0) g.arc(dcx, dcy, dR, -HALF_PI, -HALF_PI + a);
    else g.arc(dcx, dcy, dR, -HALF_PI + a, -HALF_PI);
    g.stroke();

    // Top-dead-centre is (0,-1) in canvas space; rotating it by `a` clockwise —
    // which is the positive direction here, because canvas Y points down — puts
    // it at (sin a, -cos a).
    const ca = Math.sin(a), sa = -Math.cos(a);
    g.strokeStyle = COL_NEEDLE;
    g.lineWidth = Math.max(1.5, w * 0.010);
    g.beginPath();
    g.moveTo(dcx + ca * dR * 0.34, dcy + sa * dR * 0.34);
    g.lineTo(dcx + ca * (dR + dBand * 0.7), dcy + sa * (dR + dBand * 0.7));
    g.stroke();
  }

  // ---- state -------------------------------------------------------------
  let visible = opts.visible !== false;
  if (!visible) layer.classList.add('is-hidden');
  layer.setAttribute('aria-hidden', visible ? 'false' : 'true');

  let lastSpeed = -1, lastGear = -99, lastH = -1, lastM = -1;
  let lastOdoK = -1, lastOdoT = -1, lastBearing = -1;
  // 0 rather than undefined: an absent district is a value update() has to be
  // able to react to, and `undefined !== undefined` would never fire.
  let lastDistrict = 0, lastSurface = 0, lastLimit = -1;
  let lastOver = false, lastHand = false, lastSlip = false, lastAir = false, lastShift = false;

  let dmgOn = false, lastTempState = -1, lastTempFill = -1;
  const lampWas = new Int8Array(4).fill(-1);

  let lastDriftClass = -1, lastMult = -1, lastAngleDeg = -1, lastTag = BLANK;
  const scoreWas = new Int8Array(6).fill(-2);

  function setLamp(i, state) {
    if (lampWas[i] === state) return;
    lampWas[i] = state;
    lampEl[i].className = LAMP_CLASS[state];
  }

  /**
   * The live score, written a digit at a time. Leading zeros are blanked rather
   * than drawn, so a three-figure chain is three characters wide instead of
   * reading as 000420.
   */
  function writeScore(v) {
    for (let i = 0; i < 6; i++) {
      const p = POW10[i];
      const show = i === 5 || v >= p ? ((v / p) | 0) % 10 : -1;
      if (scoreWas[i] === show) continue;
      scoreWas[i] = show;
      scoreDigits[i].textContent = show < 0 ? BLANK : DIGIT[show];
    }
  }

  function update(s) {
    if (!visible || !s) return;

    const kmhF = (s.speed || 0) * MS_TO_KMH;
    const kmh = kmhF < 0 ? 0 : kmhF > 999 ? 999 : kmhF | 0;
    if (kmh !== lastSpeed) {
      speedEl.textContent = INT_STR[kmh];
      lastSpeed = kmh;
    }

    const gear = s.gear | 0;
    if (gear !== lastGear) {
      gearEl.textContent = GEAR_STR[gear] || '-';
      lastGear = gear;
    }

    const time = s.time || 0;
    const hour = ((time | 0) % 24 + 24) % 24;
    const minute = clamp((time - Math.floor(time)) * 60 | 0, 0, 59);
    if (hour !== lastH) {
      clockH.textContent = PAD2[hour];
      lastH = hour;
    }
    if (minute !== lastM) {
      clockM.textContent = PAD2[minute];
      lastM = minute;
    }

    const km = (s.odometer || 0) / 1000;
    const kmI = km < 0 ? 0 : km | 0;
    // `| 0` truncates toward zero, so a negative odometer leaves a negative
    // tenth and TENTH[-1] is undefined — which reaches the DOM as the literal
    // string "undefined". A branch, not a clamp() call, to stay allocation-free.
    let kmT = ((km - kmI) * 10) | 0;
    if (kmT < 0) kmT = 0;
    if (kmI !== lastOdoK) {
      // The table runs out at a thousand kilometres, and past that this costs one
      // small string per kilometre driven. Still nothing per frame.
      odoKm.textContent = kmI < 1000 ? INT_STR[kmI] : String(kmI);
      lastOdoK = kmI;
    }
    if (kmT !== lastOdoT) {
      odoT.textContent = TENTH[kmT];
      lastOdoT = kmT;
    }

    // Compass bearing: forward is (-sin yaw, -cos yaw), so east is -sin yaw and
    // north is cos yaw, and atan2 of those is simply -yaw.
    const yaw = s.heading || 0;
    let bearing = -yaw * RAD_TO_DEG % 360;
    if (bearing < 0) bearing += 360;
    let bi = bearing | 0;
    if (bi > 359) bi = 0;
    if (bi !== lastBearing) {
      bearingEl.textContent = DEG_STR[bi];
      lastBearing = bi;
    }

    const district = s.district;
    if (district !== lastDistrict) {
      lastDistrict = district;
      // main.js may hand over a district id or a name already; accept either.
      districtEl.textContent = (district && districtNames.get(district)) || district || OPEN_COUNTRY;
    }

    const surface = s.surface || '';
    if (surface !== lastSurface) {
      lastSurface = surface;
      surfaceEl.textContent = SURFACE_LABEL[surface] || surface.toUpperCase();
      surfaceEl.classList.toggle('is-loose', LOOSE[surface] === 1);
    }

    const limF = (s.speedLimit || 0) * MS_TO_KMH;
    // INT_STR stops at 999, and a limit past it would put "undefined" on the
    // sign. No road in the world is anywhere near this, but the readout should
    // degrade to a number rather than to a word.
    let lim = limF > 1 ? Math.round(limF / 5) * 5 : 0;
    if (lim > 995) lim = 995;
    if (lim !== lastLimit) {
      lastLimit = lim;
      if (lim > 0) limitNum.textContent = INT_STR[lim];
      limitEl.classList.toggle('is-off', lim === 0);
    }
    const over = lim > 0 && kmhF > lim * 1.08;
    if (over !== lastOver) {
      limitEl.classList.toggle('is-over', over);
      lastOver = over;
    }

    const hand = (s.handbrake || 0) > 0.05;
    if (hand !== lastHand) {
      tellHand.classList.toggle('is-on', hand);
      lastHand = hand;
    }
    const slip = (s.slipping || 0) > 0.30;
    if (slip !== lastSlip) {
      tellSlip.classList.toggle('is-on', slip);
      lastSlip = slip;
    }
    const air = !!s.airborne;
    if (air !== lastAir) {
      tellAir.classList.toggle('is-on', air);
      lastAir = air;
    }

    const redline = s.redline > 0 ? s.redline : 7000;
    const rpm = s.rpm > 0 ? s.rpm : 0;
    const shift = rpm > redline * 0.93;
    if (shift !== lastShift) {
      clusterBox.classList.toggle('is-shift', shift);
      lastShift = shift;
    }

    // ---- damage, temperature and the warning lamps ----------------------
    // Absent until main.js hands over car.damage.state, and the panel simply
    // does not exist until then rather than showing an undamaged car that is
    // not being measured.
    const d = s.damage;
    if (d) {
      if (!dmgOn) {
        dmgOn = true;
        dmgBox.classList.remove('is-off');
        // The panel is display:none until exactly this moment, so the size
        // relayout() measured for its canvas at construction was the size of a
        // box with no layout at all: zero, which fitCanvas floors to 1x1, which
        // drawDamage() then rejects on its own `w < 16` guard. Nothing would
        // ever come back and fix it — the ResizeObserver watches the layer, and
        // the layer does not change size when one of its children appears — so
        // without this call the silhouette stays blank for the whole session
        // while the signature happily reports it as up to date. Measure now
        // that the box has a size. Once, on the frame damage first arrives.
        relayout();
      }
      const sig = damageSignature(d);
      if (sig !== dmgSig) {
        dmgSig = sig;
        drawDamage(d);
      }

      // TEMPERATURE. damage.js idles at 0.35 and runs to 1.4: smoke starts at
      // 0.72, the engine begins cooking itself at 0.86, and it catches at 1.0.
      // The bar is scaled so that its far end IS ignition, because that is the
      // only number on it the player can do anything about — lift off, or find
      // some airflow. Overheating has no other tell at all until the smoke, by
      // which point the engine is already being eaten.
      const temp = d.temp || 0;
      const tState = temp < TEMP_SHOW ? 0
        : temp < 0.72 ? 1 : temp < 0.86 ? 2 : temp < 0.97 ? 3 : 4;
      if (tState !== lastTempState) {
        tempEl.className = TEMP_CLASS[tState];
        lastTempState = tState;
      }
      if (tState > 0) {
        let tf = ((temp - TEMP_SHOW) / (1 - TEMP_SHOW) * SCALE_STEPS) | 0;
        if (tf < 0) tf = 0;
        else if (tf > SCALE_STEPS) tf = SCALE_STEPS;
        if (tf !== lastTempFill) {
          tempFill.style.transform = SCALE_STR[tf];
          lastTempFill = tf;
        }
      }

      // LAMPS, left to right in the order these systems actually give out.
      // A nose-on impact hands the radiator the full weight of the hit and the
      // engine barely half of it (ZONE_TO_SYSTEM in damage.js: front radiator
      // 1.00, engine 0.55), so COOL always crosses its threshold first. Tyres
      // go next, from abrasion as often as from impact. The engine only starts
      // cooking once the coolant has actually drained away, which takes tens of
      // seconds. Fire is the end of that chain and never the start of it. So
      // reading the row from the left reads the crash back in order.
      setLamp(0, d.coolant < 0.35 || d.radiator < 0.30 ? 2
        : d.coolant < 0.88 || d.radiator < 0.80 ? 1 : 0);
      setLamp(1, d.blown[0] || d.blown[1] || d.blown[2] || d.blown[3] ? 2
        : d.tyre[0] < 0.55 || d.tyre[1] < 0.55 || d.tyre[2] < 0.55 || d.tyre[3] < 0.55 ? 1 : 0);
      setLamp(2, d.engine < 0.30 || temp > 0.97 ? 2
        : d.engine < 0.72 || temp > 0.80 ? 1 : 0);
      setLamp(3, d.onFire > 0 ? 2 : 0);
    } else if (dmgOn) {
      dmgOn = false;
      dmgBox.classList.add('is-off');
    }

    // ---- drift ----------------------------------------------------------
    // Everything here is read straight off the drift module's live state; the
    // HUD infers nothing and owns no timers of its own. In particular the flash
    // is NOT triggered by `active` going false — a chain survives up to 1.25 s
    // of straight running between linked slides, so `active` drops several
    // times inside one chain and a flash on that edge would fire three times a
    // corner. The chain is alive while `combo > 0`; it has ended when
    // `lastResult.kind` says so and `flash` is still decaying.
    const dr = s.drift;
    const live = !!(dr && (dr.active || dr.combo > 0));
    let dClass = 0;
    if (dr && !live && dr.flash > 0) {
      dClass = dr.lastResult && dr.lastResult.kind === 'banked' ? 2
        : dr.lastResult && dr.lastResult.kind === 'lost' ? 3 : 0;
    } else if (live) {
      dClass = 1;
    }
    if (dClass !== lastDriftClass) {
      driftBox.className = DRIFT_CLASS[dClass];
      lastDriftClass = dClass;
    }

    if (dClass > 0) {
      // While the chain runs, the number is `pending` — what banking right now
      // would actually pay, multiplier included. Once it has ended the number
      // is `lastResult.points`, which is the same figure frozen at the moment
      // it landed or was lost. So the digits never jump at the transition; they
      // just stop moving and change colour.
      const raw = dClass === 1 ? dr.pending : dr.lastResult.points;
      const val = raw > 0 ? (raw > 999999 ? 999999 : raw | 0) : 0;
      writeScore(val);

      const m = dr.multiplier > 0 ? (dr.multiplier * 10) | 0 : 10;
      const mi = m < 10 ? 10 : m > 99 ? 99 : m;
      if (mi !== lastMult) {
        multEl.textContent = MULT_STR[mi];
        lastMult = mi;
      }

      const tag = dClass === 1 ? TAG_DRIFT
        : dClass === 2 ? TAG_BANKED
        : LOST_TAG[dr.lastResult.reason] || TAG_LOST;
      if (tag !== lastTag) {
        driftTagEl.textContent = tag;
        lastTag = tag;
      }

      // drift.js publishes angleDeg beside angle, so the readout is a truncate
      // and a table lookup with no conversion of its own.
      let ad = (dr.angleDeg < 0 ? -dr.angleDeg : dr.angleDeg) | 0;
      if (!(ad >= 0)) ad = 0;
      else if (ad > ANGLE_MAX) ad = ANGLE_MAX;
      if (ad !== lastAngleDeg) {
        driftAngleEl.textContent = ANGLE_STR[ad];
        lastAngleDeg = ad;
      }

      // holdRatio is unsigned; the needle needs the angle's sign back. The
      // needle stays live through the flash rather than freezing with the
      // score: after a chain lost to a spin, the angle that killed it is the
      // most useful thing on the display, and a stopped needle beside a
      // still-sliding car reads as a broken gauge.
      needle[0] = dr.angle < 0 ? -dr.holdRatio : dr.holdRatio;
      drawDriftGauge();
    }

    drawDial(rpm, redline, kmhF, s.throttle || 0, s.brake || 0, shift);
    drawCompass(bearing);
    drawMap(s.x || 0, s.z || 0, yaw, s.players);
  }

  // ---- the rest of the surface -------------------------------------------
  let toastTimer = 0;
  function hideToast() {
    toastEl.classList.remove('is-on');
    toastTimer = 0;
  }

  function toast(message, seconds) {
    toastEl.textContent = message == null ? '' : String(message);
    toastEl.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, Math.max(0.2, seconds || 2.4) * 1000);
  }

  function setVisible(on) {
    const want = !!on;
    if (want === visible) return;
    visible = want;
    layer.classList.toggle('is-hidden', !want);
    layer.setAttribute('aria-hidden', want ? 'false' : 'true');
  }

  /** 1 shows roughly 500 m across the disc; larger zooms in. */
  function setMinimapZoom(z) {
    zoom = clamp(z || 1, ZOOM_MIN, ZOOM_MAX);
  }

  function dispose() {
    if (ro) ro.disconnect();
    window.removeEventListener('resize', relayout);
    if (toastTimer) clearTimeout(toastTimer);
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    // Hand the bitmaps back: the world map alone is a dozen megabytes, and a
    // detached canvas keeps every one of them until the next major collection.
    if (worldMap) { worldMap.width = 0; worldMap.height = 0; }
    if (tape) { tape.width = 0; tape.height = 0; }
    dialBase.width = 0; dialBase.height = 0;
    driftBase.width = 0; driftBase.height = 0;
    mapCanvas.width = 0; mapCanvas.height = 0;
    dialCanvas.width = 0; dialCanvas.height = 0;
    compCanvas.width = 0; compCanvas.height = 0;
    dmgCanvas.width = 0; dmgCanvas.height = 0;
    driftCanvas.width = 0; driftCanvas.height = 0;
  }

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(relayout);
  if (ro) ro.observe(layer);
  // ResizeObserver does not fire for a change of display density, and window
  // resize does not fire for a layout change that leaves the window alone, so
  // both are needed.
  window.addEventListener('resize', relayout);
  relayout();

  return { update, setVisible, toast, setMinimapZoom, dispose, element: layer };
}
