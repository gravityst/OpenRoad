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

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fontFor(px, weight) {
  return weight + ' ' + Math.max(6, Math.round(px)) + 'px ' + FONT_MONO;
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
  const dialBase = elem('canvas');            // a cache, deliberately not attached
  const dialBaseCtx = dialBase.getContext('2d');
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
    // road is drawn.
    const cityR = world.terrain.cityRadius * S;
    const wash = g.createRadialGradient(mapRes / 2, mapRes / 2, cityR * 0.15, mapRes / 2, mapRes / 2, cityR * 1.3);
    wash.addColorStop(0, 'rgba(104,112,124,0.30)');
    wash.addColorStop(1, 'rgba(104,112,124,0)');
    g.fillStyle = wash;
    g.fillRect(0, 0, mapRes, mapRes);

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

    g.font = fontFor(R * 0.098, 500);
    g.fillStyle = 'rgba(226,236,245,0.34)';
    g.fillText(RPM_LABEL, cx, cy - R * 0.46);
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

  function drawMap(px, pz, heading) {
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

  // ---- state -------------------------------------------------------------
  let visible = opts.visible !== false;
  if (!visible) layer.classList.add('is-hidden');
  layer.setAttribute('aria-hidden', visible ? 'false' : 'true');

  let lastSpeed = -1, lastGear = -99, lastH = -1, lastM = -1;
  let lastOdoK = -1, lastOdoT = -1, lastBearing = -1;
  let lastDistrict, lastSurface, lastLimit = -1;
  let lastOver = false, lastHand = false, lastSlip = false, lastAir = false, lastShift = false;

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
    const kmT = ((km - kmI) * 10) | 0;
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
    const lim = limF > 1 ? Math.round(limF / 5) * 5 : 0;
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

    drawDial(rpm, redline, kmhF, s.throttle || 0, s.brake || 0, shift);
    drawCompass(bearing);
    drawMap(s.x || 0, s.z || 0, yaw);
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
    mapCanvas.width = 0; mapCanvas.height = 0;
    dialCanvas.width = 0; dialCanvas.height = 0;
    compCanvas.width = 0; compCanvas.height = 0;
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
