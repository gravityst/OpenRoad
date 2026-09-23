// The cars themselves, modelled in code.
//
// COORDINATE CONVENTION — the model is built FACING -Z.
//
//   forward = -Z      right = +X      up = +Y
//
// So the nose is at negative z, the boot at positive z, and the front wheels sit
// at z = -wheelbase/2. This matches physics/vehicle.js exactly; getting it
// backwards has cost this project real time before, so every z below is written
// with "front is more negative" in mind and nothing negates it on the way out.
//
// The origin is the CHASSIS REFERENCE, not the ground: local y = 0 is
// spec.rideHeight above the contact patches, which is precisely what car.y is.
// Drop the group at (car.x, car.y, car.z) with rotation.y = car.yaw and it sits
// where the simulation thinks it is. Style heights are multiples of the wheel
// radius above that datum, so the ground is at y = -rideHeight.
//
// HOW A BODY IS BUILT
//
// The first version of this file lofted a 12-point section and hung boxes off
// it. It read as a toy from any distance: every panel was a flat facet, the
// pillars were bricks, the wheels were twelve-sided and the paint, with no
// environment to reflect, came out as a flat dark smear. The player looks at
// this object for the whole session, so it is now built the way a car is
// actually shaped:
//
//   THE SHELL is everything below the window line. It is swept through ~80
//   stations, each one a closed cross-section with real fillets — a tucked
//   rocker, a lower crease, a belly, a crisp shoulder line, a rounded deck edge
//   and a crowned bonnet. Over each wheel the bottom of the section rises into
//   an arch with a rolled lip and a black liner behind it, and the flank flares
//   out. Through the cabin the top of the section drops into a tub, so there is
//   an inside to see through the glass instead of a painted lid at elbow height.
//   The nose and tail are rounded in plan and bowed forward in the middle, the
//   way every bumper is, rather than sliced off flat.
//
//   THE CANOPY is the greenhouse: one surface from the windscreen base to the
//   rear glass base, whose cells are assigned to paint, glass or trim. A pillar,
//   a window and the roof are therefore one smooth surface with shared normals,
//   so a reflection runs across all three without a seam, and the glass sits a
//   few millimetres below the pillars around it like real flush glazing.
//
//   EVERYTHING ELSE — lamps, grille, plates, mirrors, handles — is PROJECTED onto
//   the shell, so a headlight wraps round the corner of the wing it sits in
//   instead of floating in front of it as a box.
//
// All of it is procedural: no external assets, no image files. Tyre tread, lamp
// graphics, grille mesh, number plates and the sky the paint reflects are drawn
// into offscreen canvases the first time a car is built.
//
// WHAT THE DAMAGE RENDERER NEEDS FROM THIS FILE — read before renaming anything.
//
// render/carDamage.js takes these meshes apart geometrically. It relies on:
//   * a child Group of the car holding meshes NAMED by bucket: paint, glass,
//     glassDark, chrome, plastic, plate, lHead, lTail, lBrake, lRev, lIndL, lIndR;
//   * every bucket being INDEXED, and panes, lamps, mirrors and plates each being
//     their own connected component (pieces are never welded after the fact);
//   * exactly one glass component spanning the centreline in `glass` (the
//     windscreen) and one in `glassDark` (the backlight);
//   * the side glass running from the windscreen base to the rear glass base,
//     because the cabin's extent is MEASURED off it;
//   * mirrors living in `plastic`, outboard of 0.8 of the half width, and
//     nothing else black there — which is why low detail's window frames are
//     body colour rather than folded-in chrome;
//   * `chrome` holding something besides tailpipes (the badges), because a
//     bucket that is all one kind of part is never split, and then the
//     exhaust can never come off;
//   * the sports spoiler being separate paint components above the deck;
//   * wheels whose first child is the tyre.
// tools/carscheck.mjs asserts every one of those for every car in the catalogue.
//
// WHAT IT COSTS
//
// Per car at player detail: 26 draw calls at rest (the first version: 24), 11
// shadow casters (12), 21-23k triangles (1.6k). At traffic detail ('low'): 12
// calls (12), 6 casters (6), 4.8-5.8k triangles (1.4k). Past ~35 m a car's
// cabin, grille infill and calipers are dropped by a THREE.LOD switch, which is
// why a street full of traffic now costs FEWER draw calls than before. The
// wheel-blur discs are drawn only while the wheels are turning fast. Geometry
// is built once per model and shared by every car of that model.

import * as THREE from 'three';

export const BODY_STYLES = ['sedan', 'coupe', 'hatch', 'suv', 'pickup', 'van', 'sports'];

// ===========================================================================
// Style table
// ===========================================================================
//
//   over     front / rear overhang, x wheelbase
//   width    body width / track. Bodywork is always wider than the track.
//   topW     deck-edge half width / body half width, before tumblehome
//   roofW    roof half width / body half width
//   arch     wheel-arch crown above the axle, x wheelRadius
//   h        heights above the chassis datum, x wheelRadius:
//              nose   top of the front bumper face
//              bonnet top of the bonnet where the windscreen meets it
//              belt   window line through the doors
//              roof   roof
//              boot   rear deck at the base of the rear glass
//              tail   top of the rear panel
//   cab      [windscreen base, roof front, roof rear, rear glass base],
//            x wheelbase, measured from the midpoint between the axles
//
// The shape of the body on top of those numbers:
//
//   plan     plan-view corner radius at the nose and tail, x half width
//   sweep    how far the middle of each bumper stands proud of its corners, m
//   rake     how far the top of each end face leans back from the bumper, m
//   bulge    how far each bumper stands proud of the face above it, m
//   flare    wheel-arch flare, x wheel radius
//   crease   shoulder line below the window line, x wheel radius
//   quarter  where the side glass starts closing toward the C-pillar, as a
//            fraction of roof-rear -> rear-glass-base (negative is ahead of it)
//   shelf    where the cabin tub ends, same fraction — a sedan's parcel shelf
//            starts early, an estate's load floor runs to the tailgate
//
// The numbers were tuned against the catalogue: a Verrick 340S comes out
// 4.65 x 1.87 x 1.44 m, a Kestrel Lark 3.89 x 1.73 x 1.43, a Norvex Haulier
// 5.41 x 2.00 x 1.98 — which is where those cars ought to land.
const STYLES = {
  sedan: {
    over: [0.32, 0.30], width: 1.16, topW: 0.88, roofW: 0.80, arch: 1.14,
    h: { nose: 1.50, bonnet: 1.82, belt: 1.95, roof: 3.35, boot: 1.92, tail: 1.72 },
    cab: [-0.13, 0.06, 0.46, 0.63], bPillar: true, doors: 4,
    plan: [0.36, 0.30], sweep: [0.08, 0.05], rake: [0.08, 0.06], bulge: [0.018, 0.02],
    flare: 0.035, crease: 0.24,
    quarter: -0.25, shelf: 0.28, trim: 'chrome',
    head: 'swept', tail: 'wrap', grille: 'wide',
    wheel: { spokes: 'twin5', rim: 0.68, finish: 0xc4c8ce, caliper: 0x303236 },
    exhaust: 'twin', seat: 0x2c2f35,
  },
  coupe: {
    over: [0.33, 0.33], width: 1.16, topW: 0.86, roofW: 0.78, arch: 1.12,
    h: { nose: 1.30, bonnet: 1.62, belt: 1.80, roof: 3.30, boot: 1.82, tail: 1.58 },
    // No B-pillar and a long fastback rear glass: the two things that read as
    // "coupe" from fifty metres away.
    cab: [-0.06, 0.14, 0.36, 0.70], bPillar: false, doors: 2,
    plan: [0.40, 0.34], sweep: [0.09, 0.06], rake: [0.10, 0.07], bulge: [0.015, 0.02],
    flare: 0.05, crease: 0.20,
    quarter: 0.30, shelf: 0.30, trim: 'black',
    head: 'slim', tail: 'bar', grille: 'mesh',
    wheel: { spokes: 'y6', rim: 0.70, finish: 0x8f959c, caliper: 0xb3261e },
    exhaust: 'quad', seat: 0x24262a, skirts: true,
  },
  hatch: {
    over: [0.31, 0.24], width: 1.15, topW: 0.88, roofW: 0.80, arch: 1.14,
    h: { nose: 1.55, bonnet: 1.88, belt: 2.05, roof: 3.85, boot: 2.05, tail: 1.95 },
    cab: [-0.22, 0.00, 0.54, 0.68], bPillar: true, doors: 4,
    plan: [0.36, 0.26], sweep: [0.08, 0.04], rake: [0.07, 0.05], bulge: [0.018, 0.022],
    flare: 0.04, crease: 0.22,
    quarter: 0.15, shelf: 0.85, trim: 'black',
    head: 'swept', tail: 'tall', grille: 'mesh',
    wheel: { spokes: 'ten', rim: 0.64, finish: 0xc9cdd2, caliper: 0x303236 },
    exhaust: 'single', seat: 0x2d3036, roofSpoiler: true,
  },
  suv: {
    over: [0.30, 0.32], width: 1.16, topW: 0.90, roofW: 0.82, arch: 1.22, tyre: 0.66,
    h: { nose: 1.70, bonnet: 2.05, belt: 2.10, roof: 3.70, boot: 2.15, tail: 2.00 },
    cab: [-0.22, -0.02, 0.62, 0.74], bPillar: true, doors: 4, rails: true,
    plan: [0.30, 0.24], sweep: [0.07, 0.03], rake: [0.05, 0.04], bulge: [0.02, 0.025],
    flare: 0.05, crease: 0.26,
    quarter: 0.45, shelf: 0.9, trim: 'black',
    head: 'square', tail: 'tall', grille: 'bars',
    wheel: { spokes: 'five', rim: 0.58, finish: 0x5b5f66, caliper: 0x303236 },
    exhaust: 'twin', seat: 0x3a3226, cladding: true,
  },
  pickup: {
    over: [0.30, 0.32], width: 1.16, topW: 0.90, roofW: 0.80, arch: 1.22, tyre: 0.66,
    // boot/tail are the BED RAILS here; the bed floor is its own height.
    h: { nose: 1.72, bonnet: 2.08, belt: 2.25, roof: 3.85, boot: 2.30, tail: 2.22 },
    cab: [-0.14, 0.04, 0.29, 0.36], bPillar: true, doors: 4, bed: 1.52,
    plan: [0.28, 0.14], sweep: [0.06, 0.0], rake: [0.03, 0.0], bulge: [0.02, 0.035],
    flare: 0.06, crease: 0.24,
    quarter: -0.2, shelf: 0.8, trim: 'black',
    head: 'square', tail: 'tall', grille: 'shield',
    wheel: { spokes: 'six', rim: 0.58, finish: 0x3a3d42, caliper: 0x303236 },
    exhaust: 'single', seat: 0x2b2d31, cladding: true,
  },
  van: {
    over: [0.24, 0.34], width: 1.16, topW: 0.92, roofW: 0.90, arch: 1.14,
    h: { nose: 1.40, bonnet: 1.80, belt: 2.15, roof: 4.30, boot: 2.15, tail: 2.05 },
    // Cab-forward: the windscreen base sits almost over the front axle, and
    // everything behind the B-pillar is one tall box.
    cab: [-0.44, -0.24, 0.10, 0.10], bPillar: true, cargo: true, doors: 2,
    plan: [0.34, 0.12], sweep: [0.10, 0.0], rake: [0.06, 0.0], bulge: [0.02, 0.03],
    flare: 0.02, crease: 0.22,
    quarter: 0, shelf: 0.8, trim: 'black',
    head: 'square', tail: 'tall', grille: 'wide',
    wheel: { spokes: 'steel', rim: 0.62, finish: 0xb8bcc2, caliper: 0x303236 },
    exhaust: 'single', seat: 0x2b2d31,
  },
  sports: {
    over: [0.34, 0.36], width: 1.16, topW: 0.84, roofW: 0.74, arch: 1.06, tyre: 0.76,
    h: { nose: 1.02, bonnet: 1.34, belt: 1.95, roof: 2.95, boot: 1.86, tail: 1.62 },
    cab: [-0.16, 0.06, 0.28, 0.66], bPillar: false, doors: 2, spoiler: true, haunch: true,
    plan: [0.44, 0.36], sweep: [0.12, 0.07], rake: [0.12, 0.08], bulge: [0.012, 0.018],
    flare: 0.07, crease: 0.16,
    quarter: 0.25, shelf: 0.25, trim: 'black',
    head: 'slim', tail: 'bar', grille: 'mesh',
    wheel: { spokes: 'mesh', rim: 0.74, finish: 0x3b3e44, caliper: 0xd8a200 },
    exhaust: 'quad', seat: 0x1f2024, skirts: true,
  },
};

// Lamp lenses: unlit tint, the colour they glow, how glossy the lens is, how
// metallic the reflector behind it reads, and which graphic it carries. These
// are the only materials built per car besides the paint — every car brakes and
// indicates on its own schedule, so they cannot be shared. The lit intensities
// in the setters below are mirrored in render/models.js on purpose.
const LAMPS = {
  lHead:  [0xe4e9ef, 0xfff2d6, 0.10, 0.55, 'head'],
  lTail:  [0x6a1418, 0xff2418, 0.12, 0.10, 'tail'],
  lBrake: [0x7a171b, 0xff2b1c, 0.12, 0.10, 'strip'],
  lRev:   [0xd4d9df, 0xffffff, 0.10, 0.30, 'strip'],
  lIndL:  [0x8a5410, 0xff9a12, 0.12, 0.15, 'strip'],
  lIndR:  [0x8a5410, 0xff9a12, 0.12, 0.15, 'strip'],
};

// Per-model variety. Traffic is dozens of cars drawn from fifteen catalogue
// entries, and with one design per body style every hatch in a queue wore the
// same wheels, lamps and grille. Each catalogue car now picks from its style's
// candidates by a hash of its own id — so a given model always looks the same,
// the player's and traffic's alike, but two hatches do not.
const FINISH = { silver: 0xc4c8ce, bright: 0xdde1e6, graphite: 0x5b5f66, black: 0x2c2e32, bronze: 0x8a6c42 };
const VARIANTS = {
  sedan: { spokes: ['twin5', 'ten', 'y6'], finish: ['silver', 'bright', 'graphite'], caliper: [0x303236, 0x2a4f8a],
    head: ['swept', 'slim'], tail: ['wrap', 'bar'], grille: ['wide', 'bars'] },
  coupe: { spokes: ['y6', 'five', 'twin5'], finish: ['graphite', 'silver', 'black'], caliper: [0xb3261e, 0x303236],
    head: ['slim', 'swept'], tail: ['bar', 'wrap'], grille: ['mesh'] },
  hatch: { spokes: ['ten', 'five', 'six'], finish: ['silver', 'black', 'bronze'], caliper: [0x303236, 0xb3261e],
    head: ['swept', 'square'], tail: ['tall', 'wrap'], grille: ['mesh', 'wide'] },
  suv: { spokes: ['five', 'six', 'twin5'], finish: ['graphite', 'silver', 'black'], caliper: [0x303236],
    head: ['square', 'swept'], tail: ['tall'], grille: ['bars', 'shield'] },
  pickup: { spokes: ['six', 'five'], finish: ['black', 'graphite', 'silver'], caliper: [0x303236],
    head: ['square'], tail: ['tall'], grille: ['shield', 'bars'] },
  van: { spokes: ['steel'], finish: ['silver', 'bright'], caliper: [0x303236],
    head: ['square'], tail: ['tall'], grille: ['wide', 'bars'] },
  sports: { spokes: ['mesh', 'y6', 'twin5'], finish: ['graphite', 'black', 'bronze'], caliper: [0xd8a200, 0xb3261e, 0x2a4f8a],
    head: ['slim'], tail: ['bar', 'wrap'], grille: ['mesh'] },
};

/** The style table entry for this style, with this model's variant applied. */
function variantOf(style, vseed) {
  const V = VARIANTS[style], base = STYLES[style];
  if (!V) return { st: base, key: '' };
  let h = vseed >>> 0;
  const pick = (list) => { const v = list[h % list.length]; h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; return v; };
  const spokes = pick(V.spokes), finish = pick(V.finish), caliper = pick(V.caliper);
  const head = pick(V.head), tail = pick(V.tail), grille = pick(V.grille);
  const st = {
    ...base, head, tail, grille,
    wheel: { ...base.wheel, spokes, finish: FINISH[finish], caliper },
  };
  return { st, key: `${spokes}.${finish}.${caliper.toString(16)}.${head}.${tail}.${grille}` };
}

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
/** Smooth maximum: max(a, b) with the corner rounded over roughly k metres. */
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

// Bumped once per car built. The blink phase needs it because traffic is
// spawned from ONE catalogue entry, so a phase derived from the spec alone puts
// every car in the queue in lockstep — which is exactly what it is there to
// prevent. The plate stays seed-only, so a given car keeps its own number.
let instances = 0;

/** Deterministic small hash, so a given car always gets the same plate. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

// ===========================================================================
// Shared kit: textures, static materials and the geometry cache
// ===========================================================================
//
// Geometry depends only on the body style and the four dimensions that shape
// it, so a hundred Kestrel Larks share one set of buffers. The kit is
// reference-counted: the last car to be disposed tears the whole thing down,
// and until then a car being disposed can never pull the geometry out from
// under its neighbours.

const kit = { refs: 0, tex: null, mats: null, geom: new Map() };

/** Canvases only exist in a browser; tools/ measures this module in Node. */
function canvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function texFrom(c, { repeatX = 1, repeatY = 1, srgb = true, wrap = true } = {}) {
  if (!c) return null;
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

/** A small deterministic generator for the texture painters. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The sky the paint reflects, as a neutral equirectangular LUMINANCE map.
 *
 * Without an environment the only specular source on a car is the sun, so a
 * metallic paint shows one hotspot and is otherwise nearly black — which is
 * exactly how the old cars looked. What makes a car read as a car is the
 * horizon running along its flanks, the sky pooling on the roof and bonnet, and
 * the ground darkening the sills. This map supplies that STRUCTURE only: bright
 * horizon, dimmer zenith, drifting cloud, a broken treeline and skyline just
 * above the horizon, darker ground below. The COLOUR is applied in the shader
 * from the live hemisphere light and fog (see ENV below), so the reflection
 * turns orange at dusk and goes dark at night with the rest of the world
 * instead of being a fixed blue sky pasted onto a car at midnight.
 */
function envTexture() {
  const W = 512, H = 256;
  const c = canvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  const rnd = rng(0x51ce);
  // Values are sRGB; the texture is decoded to linear, so #ffffff is 1.0 and
  // #b3b3b3 is ~0.45 — the zenith sits at a bit under half the horizon.
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0, '#a9a9a9');
  sky.addColorStop(0.55, '#d6d6d6');
  sky.addColorStop(1, '#ffffff');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.5);
  // Soft cloud: what makes a reflection MOVE across a panel as the car turns.
  for (let i = 0; i < 42; i++) {
    const x = rnd() * W, y = 18 + rnd() * (H * 0.5 - 44), r = 10 + rnd() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r * 1.9, r * 0.55, 0, 0, TAU); g.fill();
  }
  const ground = g.createLinearGradient(0, H * 0.5, 0, H);
  ground.addColorStop(0, '#8e8e8e');
  ground.addColorStop(0.18, '#747474');
  ground.addColorStop(1, '#5a5a5a');
  g.fillStyle = ground; g.fillRect(0, H * 0.5, W, H * 0.5);
  // The treeline and skyline: a dark, broken band just above the horizon. This
  // is the single most "car" thing in the whole map — the dark line that runs
  // along every real car's flank at the height of the horizon.
  g.fillStyle = '#4a4a4a';
  g.beginPath(); g.moveTo(0, H * 0.5);
  let x = 0;
  while (x < W) {
    const building = rnd() < 0.12;
    const w = building ? 8 + rnd() * 14 : 4 + rnd() * 8;
    const h = building ? 3 + rnd() * 7 : 2 + rnd() * 6;
    if (building) { g.lineTo(x, H * 0.5 - h); g.lineTo(x + w, H * 0.5 - h); }
    else g.quadraticCurveTo(x + w * 0.5, H * 0.5 - h * 1.6, x + w, H * 0.5 - h * 0.4);
    x += w;
  }
  g.lineTo(W, H * 0.5); g.closePath(); g.fill();
  // A touch of blur: at 512 across, hard silhouette edges reflect as stair
  // steps on a glossy panel.
  if (typeof g.filter === 'string') { g.filter = 'blur(1.2px)'; g.drawImage(c, 0, 0); g.filter = 'none'; }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/**
 * Tyre tread and sidewall in one strip: u runs round the tyre, v across it
 * from the inner bead (0) to the outer bead (1). The lathe in tyreGeometry()
 * pins its profile points to these v bands, so the tread always lands on the
 * tread whatever the aspect ratio of the tyre.
 */
function tyreTextures() {
  const W = 512, H = 128;
  const c = canvas(W, H), b = canvas(W, H);
  if (!c) return { map: null, bump: null };
  const g = c.getContext('2d'), gb = b.getContext('2d');
  const rnd = rng(0x7e7e);
  const band = (v0, v1, col, colB) => {
    g.fillStyle = col; g.fillRect(0, v0 * H, W, (v1 - v0) * H);
    gb.fillStyle = colB; gb.fillRect(0, v0 * H, W, (v1 - v0) * H);
  };
  // Sidewalls: weathered grey rubber with a band of moulded lettering.
  band(0, 1, '#2a2b2e', '#808080');
  for (const [v0, v1] of [[0.10, 0.19], [0.81, 0.90]]) {
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, w = 2 + rnd() * 5;
      g.fillStyle = '#35373b'; g.fillRect(x, v0 * H, w, (v1 - v0) * H * (0.5 + rnd() * 0.5));
      gb.fillStyle = '#a0a0a0'; gb.fillRect(x, v0 * H, w, (v1 - v0) * H * 0.7);
    }
  }
  // Tread: darker, with four circumferential grooves and angled sipes.
  band(0.30, 0.70, '#1b1c1f', '#e0e0e0');
  const blocks = 60;
  for (let i = 0; i < blocks; i++) {
    const x = (i / blocks) * W;
    // Shoulder blocks, the part of a tyre that reads from behind.
    g.fillStyle = '#0d0e10'; gb.fillStyle = '#101010';
    g.fillRect(x, 0.30 * H, 2.4, 0.09 * H); gb.fillRect(x, 0.30 * H, 2.4, 0.09 * H);
    g.fillRect(x + 3, 0.61 * H, 2.4, 0.09 * H); gb.fillRect(x + 3, 0.61 * H, 2.4, 0.09 * H);
    // Sipes across the middle ribs.
    g.save(); g.translate(x, 0.5 * H); g.rotate(0.5);
    g.fillRect(-1, -0.09 * H, 1.3, 0.18 * H); gb.fillRect(-1, -0.09 * H, 1.3, 0.18 * H);
    g.restore();
  }
  for (const v of [0.40, 0.47, 0.53, 0.60]) {
    g.fillStyle = '#08090a'; g.fillRect(0, (v - 0.012) * H, W, 0.024 * H);
    gb.fillStyle = '#000000'; gb.fillRect(0, (v - 0.012) * H, W, 0.024 * H);
  }
  return { map: texFrom(c), bump: texFrom(b, { srgb: false }) };
}

/**
 * The low-detail wheel: one texture for alloy face AND tyre, plus a matching
 * metalness/roughness map, so a traffic car's wheel is one mesh and one draw
 * call. The tyre samples the corners outside the rim circle, which are black
 * rubber in the colour map and rough dielectric in the other — without the
 * second map the whole wheel would be metal and the tyre would mirror the sky.
 */
function wheelLowTextures() {
  const S = 256, R = 128;
  const c = canvas(S, S), o = canvas(S, S);
  if (!c) return { map: null, orm: null };
  const g = c.getContext('2d'), go = o.getContext('2d');
  g.fillStyle = '#141517'; g.fillRect(0, 0, S, S);
  go.fillStyle = 'rgb(0,235,0)'; go.fillRect(0, 0, S, S);      // G = rough 0.92, B = metal 0
  // Behind the spokes: dark disc and a caliper, so the gaps read as depth.
  g.fillStyle = '#1b1d20'; g.beginPath(); g.arc(R, R, 126, 0, TAU); g.fill();
  g.fillStyle = '#4a4d52'; g.beginPath(); g.arc(R, R, 96, 0, TAU); g.fill();
  g.fillStyle = '#26282c'; g.beginPath(); g.arc(R, R, 44, 0, TAU); g.fill();
  g.fillStyle = '#7a2a26';
  g.beginPath(); g.arc(R, R, 100, -0.6, 0.3); g.arc(R, R, 70, 0.3, -0.6, true); g.fill();
  const spokes = 10;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU;
    g.save(); g.translate(R, R); g.rotate(a);
    const grad = g.createLinearGradient(-12, 0, 12, 0);
    grad.addColorStop(0, '#8d939a'); grad.addColorStop(0.45, '#dde1e6'); grad.addColorStop(1, '#7a8088');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(-9, 26); g.lineTo(-6, 118); g.lineTo(6, 118); g.lineTo(9, 26); g.closePath(); g.fill();
    g.restore();
  }
  g.strokeStyle = '#d2d7dc'; g.lineWidth = 10; g.beginPath(); g.arc(R, R, 121, 0, TAU); g.stroke();
  g.fillStyle = '#b8bec5'; g.beginPath(); g.arc(R, R, 30, 0, TAU); g.fill();
  g.fillStyle = '#5c6169'; g.beginPath(); g.arc(R, R, 12, 0, TAU); g.fill();
  // Inside the rim: metal, fairly smooth. The disc stays rougher.
  go.fillStyle = 'rgb(0,90,215)'; go.beginPath(); go.arc(R, R, 127, 0, TAU); go.fill();
  go.fillStyle = 'rgb(0,150,160)'; go.beginPath(); go.arc(R, R, 96, 0, TAU); go.fill();
  go.fillStyle = 'rgb(0,90,215)';
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU;
    go.save(); go.translate(R, R); go.rotate(a);
    go.beginPath(); go.moveTo(-9, 26); go.lineTo(-6, 118); go.lineTo(6, 118); go.lineTo(9, 26); go.closePath(); go.fill();
    go.restore();
  }
  go.beginPath(); go.arc(R, R, 30, 0, TAU); go.fill();
  return { map: texFrom(c, { wrap: false }), orm: texFrom(o, { srgb: false, wrap: false }) };
}

/** Grille infill: honeycomb on the top half of the atlas, slats on the bottom. */
function grilleTexture() {
  const W = 256, H = 256;
  const c = canvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#060607'; g.fillRect(0, 0, W, H);
  // Honeycomb.
  g.strokeStyle = '#3a3d42'; g.lineWidth = 2.2;
  const r = 7, dx = r * 1.732;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 18; col++) {
      const cx = col * dx + (row % 2 ? dx * 0.5 : 0), cy = row * r * 1.5;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k / 6) * TAU;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.stroke();
    }
  }
  // Slats.
  g.fillStyle = '#060607'; g.fillRect(0, 128, W, 128);
  for (let y = 132; y < H; y += 16) {
    const grad = g.createLinearGradient(0, y, 0, y + 9);
    grad.addColorStop(0, '#8b9097'); grad.addColorStop(0.5, '#3b3e43'); grad.addColorStop(1, '#16171a');
    g.fillStyle = grad; g.fillRect(0, y, W, 9);
  }
  return texFrom(c);
}

// Four invented plates in one atlas, picked per car by hash. Every code here
// is made up and matches no real jurisdiction's format.
const PLATE_CODES = ['ORV 418', 'KVN 703', 'TSA 962', 'MDR 275'];

function plateTexture() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const y = i * 64;
    g.fillStyle = '#e4e6df'; g.fillRect(0, y, 256, 64);
    g.strokeStyle = '#1d1f22'; g.lineWidth = 3; g.strokeRect(4, y + 4, 248, 56);
    g.fillStyle = '#2b3f7a'; g.fillRect(6, y + 6, 26, 52);
    g.fillStyle = '#e8c42a'; g.beginPath(); g.arc(19, y + 22, 6, 0, TAU); g.fill();
    g.fillStyle = '#16181b';
    g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(PLATE_CODES[i], 146, y + 34);
  }
  return texFrom(c, { wrap: false });
}

/**
 * Lamp graphics, greyscale, one per kind. The same picture is the lens `map`
 * (so an unlit lamp shows its reflector and LED guides through the lens) and
 * the `emissiveMap` (so a lit one glows in that pattern instead of as a flat
 * block of colour). Colour comes from the material, so one tail graphic serves
 * red, amber and white alike. u runs inboard -> outboard, v bottom -> top.
 */
function lampTextures() {
  const W = 256, H = 128;
  const make = (paint) => { const c = canvas(W, H); if (!c) return null; paint(c.getContext('2d')); return texFrom(c, { wrap: false }); };
  const head = make((g) => {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#5a5d62'); bg.addColorStop(0.5, '#9ea3aa'); bg.addColorStop(1, '#4c4f54');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // Two projector modules: dark bezel, chrome ring, bright lens.
    for (const cx of [W * 0.34, W * 0.62]) {
      const cy = H * 0.52;
      g.fillStyle = '#1b1c1f'; g.beginPath(); g.arc(cx, cy, 30, 0, TAU); g.fill();
      const rg = g.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 26);
      rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.55, '#cfd6de'); rg.addColorStop(1, '#6a6f76');
      g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, 24, 0, TAU); g.fill();
    }
    // The daytime-running strip along the top edge, and a return down the
    // outer end: the "signature" that makes a lamp read as modern.
    g.fillStyle = '#ffffff';
    g.fillRect(W * 0.08, H * 0.08, W * 0.86, H * 0.11);
    g.fillRect(W * 0.86, H * 0.08, W * 0.08, H * 0.7);
  });
  // The fields behind the graphics are mid grey, not dark: the same picture is
  // the emissive map, and a near-black field (0.04 in linear light) meant a
  // lit lamp was only its thin light pipe — which averages to almost nothing
  // at chase-camera range, where a brake light has to be unmissable.
  const tail = make((g) => {
    g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, W, H);
    // Light pipe: a C round the outside of the lamp, and fine horizontal
    // louvres inside it.
    g.strokeStyle = '#ffffff'; g.lineWidth = 12;
    g.beginPath(); g.moveTo(W * 0.1, H * 0.2); g.lineTo(W * 0.88, H * 0.2); g.lineTo(W * 0.88, H * 0.8); g.lineTo(W * 0.1, H * 0.8); g.stroke();
    g.fillStyle = '#c8c8c8';
    for (let y = H * 0.32; y < H * 0.72; y += 9) g.fillRect(W * 0.1, y, W * 0.7, 3);
  });
  const strip = make((g) => {
    g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff';
    for (let x = 6; x < W; x += 16) g.fillRect(x, H * 0.18, 10, H * 0.64);
  });
  return { head, tail, strip };
}

/**
 * A spinning alloy, smeared. Greyscale with alpha: a solid hub, the spoke
 * zone at the average of spoke and the dark disc behind it — thin enough that
 * the caliper still shows through, as it does in any photo of a car at speed —
 * and a bright lip. The rim's own finish colour comes from vertex colours.
 */
function blurTexture() {
  const S = 128;
  const c = canvas(S, S);
  if (!c) return null;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const r = Math.hypot(i + 0.5 - S / 2, j + 0.5 - S / 2) / (S / 2);
      let v, a;
      if (r > 1) { v = 0; a = 0; }
      else if (r < 0.27) { v = 0.9; a = 0.92; }
      else if (r < 0.9) { v = 0.62 + 0.06 * Math.sin(r * 46); a = 0.6; }
      else { v = 1; a = 0.9; }
      // Soften the ring boundaries by a couple of texels.
      const o = (j * S + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * v);
      img.data[o + 3] = Math.round(255 * a * clamp((1 - r) * 40, 0, 1));
    }
  }
  g.putImageData(img, 0, 0);
  return texFrom(c, { wrap: false });
}

/**
 * A soft dark footprint for the contact shadow. The sun's shadow map is far
 * too coarse to darken the two centimetres where a tyre meets the road, and a
 * car without that darkening floats: it is the single cue the eye uses to put
 * an object ON a surface rather than in front of it.
 */
function shadowTexture() {
  const W = 64, H = 128;
  const c = canvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Signed distance to a rounded rectangle covering the body, in texels.
      const px = Math.abs(i + 0.5 - W / 2) - (W / 2 - 13), py = Math.abs(j + 0.5 - H / 2) - (H / 2 - 16);
      const r = 10;
      const qx = Math.max(px + r, 0), qy = Math.max(py + r, 0);
      const d = Math.hypot(qx, qy) + Math.min(Math.max(px + r, py + r), 0) - r;
      const a = clamp(1 - (d + 7) / 14, 0, 1);
      const o = (j * W + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
      img.data[o + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  }
  g.putImageData(img, 0, 0);
  return texFrom(c, { wrap: false });
}

// ---------------------------------------------------------------------------
// The environment the cars reflect, and the shader patches that use it
// ---------------------------------------------------------------------------
//
// One set of uniforms shared by every car material. They are refreshed from
// the scene's own HemisphereLight and fog, once a frame, by whichever car's
// paint is drawn first — so there is nothing for main.js to wire up, and a
// game with no sky layer simply gets a neutral daylight tint.
const ENV = {
  sky: { value: new THREE.Color(0.62, 0.72, 0.86) },
  horizon: { value: new THREE.Color(0.80, 0.84, 0.88) },
  ground: { value: new THREE.Color(0.18, 0.17, 0.15) },
  scene: null, hemi: null, searched: false,
};
// Gains from the hemisphere light to reflected radiance. The hemi colour is
// normalised to a max component of 1 by sky.js, so these are what put a noon
// horizon at about 0.9 and a clear zenith at about 0.45 in linear light: bright
// enough to shape a panel, well under the 2.1 bloom threshold so a white car
// in the sun does not flare.
const ENV_GAIN = { sky: 0.62, horizon: 1.0, ground: 0.72 };

function updateEnv(scene) {
  if (!scene) return;
  if (scene !== ENV.scene) { ENV.scene = scene; ENV.hemi = null; ENV.searched = false; }
  if (!ENV.hemi || ENV.hemi.parent !== scene) {
    if (ENV.searched && !ENV.hemi) return;
    ENV.hemi = null;
    for (const c of scene.children) if (c.isHemisphereLight) { ENV.hemi = c; break; }
    ENV.searched = true;
    if (!ENV.hemi) return;
  }
  const h = ENV.hemi;
  const k = h.intensity;
  ENV.sky.value.copy(h.color).multiplyScalar(k * ENV_GAIN.sky);
  ENV.ground.value.copy(h.groundColor).multiplyScalar(k * ENV_GAIN.ground);
  if (scene.fog && scene.fog.color) ENV.horizon.value.copy(scene.fog.color).multiplyScalar(ENV_GAIN.horizon * Math.min(1, k / 0.9));
  else ENV.horizon.value.copy(h.color).multiplyScalar(k * ENV_GAIN.horizon);
}

// The IBL chunk, rewritten. Two changes from three's own:
//   * irradiance from the map is ZERO. The world is lit by a HemisphereLight;
//     letting cars take a second ambient term from their private sky would make
//     them visibly brighter than the road they sit on.
//   * radiance is tinted by where the reflection points — ground, horizon or
//     sky — using the live colours in ENV.
const ENV_CHUNK = /* glsl */`
uniform vec3 carEnvSky;
uniform vec3 carEnvHorizon;
uniform vec3 carEnvGround;
#ifdef USE_ENVMAP
	vec3 carEnvTint( const in vec3 dir ) {
		vec3 low = mix( carEnvHorizon, carEnvGround, 1.0 - smoothstep( -0.32, 0.0, dir.y ) );
		return mix( low, carEnvSky, smoothstep( 0.03, 0.55, dir.y ) );
	}
	vec3 getIBLIrradiance( const in vec3 normal ) {
		return vec3( 0.0 );
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
			reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity * carEnvTint( reflectVec );
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			vec3 bentNormal = cross( bitangent, viewDir );
			bentNormal = normalize( cross( bentNormal, bitangent ) );
			bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
			return getIBLRadiance( viewDir, bentNormal, roughness );
		}
	#endif
#endif
`;

function envUniforms(shader) {
  shader.uniforms.carEnvSky = ENV.sky;
  shader.uniforms.carEnvHorizon = ENV.horizon;
  shader.uniforms.carEnvGround = ENV.ground;
  shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', ENV_CHUNK);
}

/**
 * Every environment-lit car surface except paint and glass. The sun's
 * direct highlight is capped under the bloom threshold here too: a lamp lens
 * or chrome tip at roughness 0.1 lined up with the sun otherwise flares into
 * a white star at the corner of the car.
 */
function patchEnv(shader) {
  envUniforms(shader);
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>',
    '#include <lights_fragment_begin>\nreflectedLight.directSpecular = min( reflectedLight.directSpecular, vec3( 1.2 ) );');
}

/**
 * Glass. Alpha blending scales EVERYTHING a transparent surface returns by its
 * opacity, reflections included, so a 35%-opaque windscreen reflected the sky
 * at 35% strength and looked like tinted cellophane. Real glass transmits AND
 * reflects: the reflection sits on top of what is behind it. Dividing the
 * specular term by alpha before the blend puts it back at full strength.
 * The SUN's part is capped first: a 0.04-roughness pane mirrors it at
 * hundreds, and boosted by 1/alpha that bloomed into a white star on every
 * rear window facing the light.
 */
function patchGlass(shader) {
  envUniforms(shader);
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
    'outgoingLight = totalDiffuse + ( min( reflectedLight.directSpecular, vec3( 0.5 ) ) + reflectedLight.indirectSpecular ) / max( diffuseColor.a, 0.12 ) + totalEmissiveRadiance;\n#include <opaque_fragment>');
}

/**
 * Paint: clearcoat over a coloured base, reflecting the environment, with the
 * panel gaps drawn analytically.
 *
 * SHARP REFLECTIONS, SOFT SUN. A clearcoat has to be glassy (roughness ~0.04)
 * for the horizon to run crisply along the flank — that is most of what reads
 * as "paint". But the sun is a direct light, and a lobe that sharp turns it
 * into a pinpoint that blows straight through the bloom threshold and puts a
 * white blob on the roof. So the clearcoat is widened to 0.2 for DIRECT light
 * only and put back before the environment is sampled: a highlight from the
 * sun, a mirror for the sky.
 *
 * SHUT LINES. A door gap is four millimetres wide, which is less than a pixel
 * at chase-camera range, so modelling it as a groove would shimmer and a
 * texture would need one atlas per car. Instead the shader knows where the
 * doors, bonnet and boot are (uniforms, per car model) and darkens a line of
 * constant physical width, widening it to one pixel and fading it as it gets
 * smaller than that, so it neither aliases nor vanishes. The positions match
 * where render/carDamage.js cuts those panels away, so a panel that comes off
 * leaves a hole the shape of the line that was drawn round it.
 */
function patchPaint(shader) {
  envUniforms(shader);
  const u = this.userData.seams;
  shader.uniforms.carSeamDoor = { value: u.door };
  shader.uniforms.carSeamDoorY = { value: u.doorY };
  shader.uniforms.carSeamBonnet = { value: u.bonnet };
  shader.uniforms.carSeamBoot = { value: u.boot };
  shader.uniforms.carSeamFuel = { value: u.fuel };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = transformed;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vCarPos;
uniform vec4 carSeamDoor;
uniform vec4 carSeamDoorY;
uniform vec4 carSeamBonnet;
uniform vec4 carSeamBoot;
uniform vec4 carSeamFuel;
float carLine( float d ) {
	const float w = 0.0022;
	float aa = max( fwidth( d ), 1e-5 );
	float we = max( w, aa * 0.75 );
	return ( 1.0 - smoothstep( we - aa * 0.5, we + aa * 0.5, abs( d ) ) ) * ( w / we );
}
float carBand( float v, float a, float b ) {
	return step( a, v ) * step( v, b );
}
float carSeams( vec3 p ) {
	float s = 0.0;
	float ax = abs( p.x );
	// Doors: vertical edges, the split between front and rear doors, and the
	// bottom edge above the sill, all on the flank only.
	float flank = step( carSeamDoor.w, ax ) * carBand( p.y, carSeamDoorY.x - 0.004, carSeamDoorY.y );
	s = max( s, carLine( p.z - carSeamDoor.x ) * flank );
	s = max( s, carLine( p.z - carSeamDoor.z ) * flank );
	s = max( s, carLine( p.z - carSeamDoor.y ) * flank * carSeamDoorY.z );
	s = max( s, carLine( p.y - carSeamDoorY.x ) * step( carSeamDoor.w, ax ) * carBand( p.z, carSeamDoor.x, carSeamDoor.z ) );
	// Bonnet: the front edge across the nose, and the two sides along the wings.
	float bon = step( carSeamBonnet.w, p.y );
	s = max( s, carLine( p.z - carSeamBonnet.x ) * bon * step( ax, carSeamBonnet.z ) );
	s = max( s, carLine( ax - carSeamBonnet.z ) * bon * carBand( p.z, carSeamBonnet.x, carSeamBonnet.y ) );
	// Boot: sides along the deck, and the bottom edge across the tail panel.
	float bt = carBand( p.z, carSeamBoot.x, carSeamBoot.y );
	s = max( s, carLine( ax - carSeamBoot.z ) * bt * step( carSeamBoot.w, p.y ) );
	s = max( s, carLine( p.y - carSeamBoot.w ) * step( carSeamBoot.y - 0.14, p.z ) * step( ax, carSeamBoot.z ) );
	// Fuel flap on the right rear wing.
	vec2 fq = vec2( p.y - carSeamFuel.x, p.z - carSeamFuel.y );
	s = max( s, carLine( length( fq ) - carSeamFuel.z ) * step( carSeamFuel.w, p.x ) );
	return s;
}`)
    .replace('#include <lights_fragment_begin>', `#ifdef USE_CLEARCOAT
	float carCcKeep = material.clearcoatRoughness;
	material.clearcoatRoughness = max( carCcKeep, 0.2 );
#endif
#include <lights_fragment_begin>
// A curved panel edge can line up with the sun over a long strip. At full
// strength that strip blew through the bloom threshold and read as a lit
// light bar across the boot lid; capped just under it, it reads as a glint.
reflectedLight.directSpecular = min( reflectedLight.directSpecular, vec3( 0.9 ) );
#ifdef USE_CLEARCOAT
	clearcoatSpecularDirect = min( clearcoatSpecularDirect, vec3( 0.9 ) );
	material.clearcoatRoughness = carCcKeep;
#endif`)
    .replace('#include <opaque_fragment>', `outgoingLight *= 1.0 - 0.82 * carSeams( vCarPos );
#include <opaque_fragment>`);
}

const PAINT_KEY = () => 'openroad-car-paint-1';
const ENV_KEY = () => 'openroad-car-env-1';
const GLASS_KEY = () => 'openroad-car-glass-1';

function envMaterial(Ctor, params, env) {
  const m = new Ctor(params);
  if (env) { m.envMap = env; m.onBeforeCompile = patchEnv; m.customProgramCacheKey = ENV_KEY; }
  return m;
}

function acquireKit() {
  if (kit.refs === 0) {
    const tyre = tyreTextures();
    const low = wheelLowTextures();
    kit.tex = {
      env: envTexture(), tyre: tyre.map, tyreBump: tyre.bump,
      wheelLow: low.map, wheelLowOrm: low.orm,
      grille: grilleTexture(), plate: plateTexture(), shadow: shadowTexture(), blur: blurTexture(),
      ...lampTextures(),
    };
    const T = kit.tex, E = T.env;
    const glass = (color, opacity) => {
      const m = new THREE.MeshStandardMaterial({
        color, metalness: 0, roughness: 0.04, transparent: true, opacity,
        // Double-sided because the cockpit camera sits behind the windscreen,
        // and depthWrite off so glass never hides the cabin behind it.
        side: THREE.DoubleSide, depthWrite: false, envMap: E,
      });
      if (E) { m.onBeforeCompile = patchGlass; m.customProgramCacheKey = GLASS_KEY; }
      return m;
    };
    kit.mats = {
      glass: glass(0x0e151c, 0.6),
      glassDark: glass(0x06080b, 0.84),
      chrome: envMaterial(THREE.MeshStandardMaterial, { color: 0xdfe3e8, roughness: 0.07, metalness: 1 }, E),
      plastic: envMaterial(THREE.MeshStandardMaterial, { color: 0x141518, roughness: 0.52, metalness: 0 }, E),
      grille: envMaterial(THREE.MeshStandardMaterial, { color: 0xffffff, roughness: 0.45, metalness: 0.4, map: T.grille }, E),
      interior: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, vertexColors: true }),
      plate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, map: T.plate }),
      rubber: new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.9, metalness: 0, map: T.tyre, bumpMap: T.tyreBump, bumpScale: 2.2,
      }),
      rim: envMaterial(THREE.MeshStandardMaterial, { color: 0xffffff, roughness: 0.26, metalness: 0.88, vertexColors: true }, E),
      caliper: envMaterial(THREE.MeshStandardMaterial, { color: 0xffffff, roughness: 0.38, metalness: 0.15, vertexColors: true }, E),
      wheelLow: envMaterial(THREE.MeshStandardMaterial, {
        color: 0xffffff, roughness: 1, metalness: 1,
        map: T.wheelLow, roughnessMap: T.wheelLowOrm, metalnessMap: T.wheelLowOrm,
      }, E),
    };
    if (!T.wheelLow) { kit.mats.wheelLow.metalness = 0.2; kit.mats.wheelLow.roughness = 0.7; kit.mats.wheelLow.color.setHex(0x2a2c30); }
  }
  kit.refs++;
  return kit;
}

function releaseKit() {
  if (--kit.refs > 0) return;
  for (const t of Object.values(kit.tex || {})) if (t) t.dispose();
  for (const m of Object.values(kit.mats || {})) if (m) m.dispose();
  for (const entry of kit.geom.values()) {
    for (const g of Object.values(entry.wheel)) if (g) g.dispose();
    for (const b of BUCKETS) if (entry[b]) entry[b].dispose();
    if (entry.shadow) entry.shadow.dispose();
  }
  kit.geom.clear();
  kit.tex = null; kit.mats = null; kit.refs = 0;
}

// ===========================================================================
// Pieces: geometry before it is merged into a bucket
// ===========================================================================
//
// A piece is plain typed arrays — position, normal, uv, optional colour and an
// index — so it can be bent, mirrored and recoloured without a BufferGeometry
// round trip, and so merging a bucket is concatenation. NOTHING IS WELDED after
// the fact: a piece's triangles share vertices exactly where the builder said
// so. carDamage takes buckets apart by connected component, so a windscreen has
// to be one component and a mirror stalk must never weld itself to the door.
//
// All of this runs at build time only, once per unique (style, dimensions)
// pair, so it allocates freely. Nothing here is reachable from update().

const _c = new THREE.Color();
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

function piece(pos, nrm, uv, idx, col = null) { return { pos, nrm, uv, idx, col }; }

/** Convert a three.js geometry to a piece, and dispose the geometry. */
function fromGeometry(g, hex = null) {
  const p = g.attributes.position.array;
  const n = g.attributes.normal ? g.attributes.normal.array : null;
  const count = p.length / 3;
  const uv = g.attributes.uv ? Float32Array.from(g.attributes.uv.array) : new Float32Array(count * 2);
  let idx;
  if (g.index) idx = Uint32Array.from(g.index.array);
  else { idx = new Uint32Array(count); for (let i = 0; i < count; i++) idx[i] = i; }
  const out = piece(Float32Array.from(p), n ? Float32Array.from(n) : new Float32Array(count * 3), uv, idx);
  if (!n) faceNormals(out);
  g.dispose();
  if (hex != null) tint(out, hex);
  return out;
}

/** Per-vertex normals from face normals, for pieces built without any. */
function faceNormals(pc) {
  const p = pc.pos, n = pc.nrm, idx = pc.idx;
  n.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
}

/** Give a piece a flat vertex colour (linear, as the renderer expects). */
function tint(pc, hex, k = 1) {
  _c.setHex(hex);
  const n = pc.pos.length / 3;
  if (!pc.col) pc.col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pc.col[i * 3] = _c.r * k; pc.col[i * 3 + 1] = _c.g * k; pc.col[i * 3 + 2] = _c.b * k; }
  return pc;
}

function transform(pc, m4) {
  _m3.getNormalMatrix(m4);
  const p = pc.pos, n = pc.nrm;
  for (let i = 0; i < p.length; i += 3) {
    _v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m4);
    p[i] = _v.x; p[i + 1] = _v.y; p[i + 2] = _v.z;
    _v.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(_m3).normalize();
    n[i] = _v.x; n[i + 1] = _v.y; n[i + 2] = _v.z;
  }
  return pc;
}

const _mat = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
function place(pc, x, y, z, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  _e.set(rx, ry, rz, order); _q.setFromEuler(_e);
  _mat.compose(_v.set(x, y, z), _q, _s.set(1, 1, 1));
  return transform(pc, _mat);
}

/** A mirrored copy across x = 0, with the winding turned back the right way. */
function mirror(pc) {
  const pos = Float32Array.from(pc.pos), nrm = Float32Array.from(pc.nrm);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = -pos[i]; nrm[i] = -nrm[i]; }
  const idx = Uint32Array.from(pc.idx);
  for (let t = 0; t < idx.length; t += 3) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  return piece(pos, nrm, Float32Array.from(pc.uv), idx, pc.col ? Float32Array.from(pc.col) : null);
}

/** Both sides: the piece as built (right, +x) and its mirror. */
function pair(list, pc) { list.push(pc, mirror(pc)); }

// ---- primitives -----------------------------------------------------------

/**
 * A box with rounded edges: a subdivided box whose vertices are pulled onto
 * a sphere of radius r around the inner box. Normals come out of the same
 * construction, so every edge is a genuine smooth radius. Used for seats,
 * mirrors, the dash and anything else that would look like a brick with
 * square edges.
 */
function roundedBox(w, h, d, r, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, seg * 2 + 1, seg * 2 + 1, seg * 2 + 1);
  const p = g.attributes.position, n = g.attributes.normal;
  r = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const ix = w / 2 - r, iy = h / 2 - r, iz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = clamp(x, -ix, ix), cy = clamp(y, -iy, iy), cz = clamp(z, -iz, iz);
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-9) { dx /= l; dy /= l; dz /= l; } else { dx = n.getX(i); dy = n.getY(i); dz = n.getZ(i); }
    p.setXYZ(i, cx + dx * r, cy + dy * r, cz + dz * r);
    n.setXYZ(i, dx, dy, dz);
  }
  return g;
}

function rbox(w, h, d, r, hex = null, seg = 2) { return fromGeometry(roundedBox(w, h, d, r, seg), hex); }
function boxPiece(w, h, d, hex = null) { return fromGeometry(new THREE.BoxGeometry(w, h, d), hex); }
function cyl(r0, r1, h, seg, open = false, hex = null) { return fromGeometry(new THREE.CylinderGeometry(r0, r1, h, seg, 1, open), hex); }
function sphere(r, ws, hs, hex = null) { return fromGeometry(new THREE.SphereGeometry(r, ws, hs), hex); }

/** A tapered bar from a to b: pillars, stalks, arms, rails. */
function strut(ax, ay, az, bx, by, bz, w, h, r = 0.004, hex = null) {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const pc = rbox(w, h, Math.max(0.01, len), r, hex, 1);
  _v.set(bx - ax, by - ay, bz - az).normalize();
  const up = Math.abs(_v.y) > 0.98 ? _w.set(0, 0, 1) : _w.set(0, 1, 0);
  _mat.lookAt(_s.set(0, 0, 0), _v.clone().negate(), up);
  _mat.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return transform(pc, _mat);
}

/**
 * Revolve a profile of [radius, x] points about the X axis — tyres, rims,
 * discs, exhaust tips. `v` optionally pins each profile point to a texture v,
 * which is how the tread lands on the tread band of tyreTextures().
 */
function lathe(profile, segs, { v = null, uRepeat = 1 } = {}) {
  const P = profile.length, C = segs + 1;
  const pos = new Float32Array(P * C * 3), nrm = new Float32Array(P * C * 3), uv = new Float32Array(P * C * 2);
  // Profile normals: rotate the profile tangent by +90 degrees in (x, r).
  const pn = [];
  for (let j = 0; j < P; j++) {
    const a = profile[Math.max(0, j - 1)], b = profile[Math.min(P - 1, j + 1)];
    let dr = b[0] - a[0], dx = b[1] - a[1];
    const l = Math.hypot(dr, dx) || 1;
    pn.push([-dr / l, dx / l]);                 // [nx, nr]
  }
  let len = 0; const acc = [0];
  for (let j = 1; j < P; j++) { len += Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]); acc.push(len); }
  for (let s = 0; s < C; s++) {
    const a = (s / segs) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < P; j++) {
      const o = (s * P + j), [r, x] = profile[j];
      pos[o * 3] = x; pos[o * 3 + 1] = r * ca; pos[o * 3 + 2] = r * sa;
      const [nx, nr] = pn[j];
      nrm[o * 3] = nx; nrm[o * 3 + 1] = nr * ca; nrm[o * 3 + 2] = nr * sa;
      uv[o * 2] = (s / segs) * uRepeat; uv[o * 2 + 1] = v ? v[j] : acc[j] / (len || 1);
    }
  }
  const idx = [];
  for (let s = 0; s < segs; s++) {
    for (let j = 0; j < P - 1; j++) {
      const a = s * P + j, b = (s + 1) * P + j, c = (s + 1) * P + j + 1, d = s * P + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  const pc = piece(pos, nrm, uv, Uint32Array.from(idx));
  orient(pc);
  return pc;
}

/**
 * Make the winding agree with the normals. Builders here produce consistent
 * but not always outward-facing triangle order; this flips a whole piece when
 * its faces disagree with its vertex normals on balance.
 */
function orient(pc) {
  const p = pc.pos, n = pc.nrm, idx = pc.idx;
  let score = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    score += fx * (n[a] + n[b] + n[c]) + fy * (n[a + 1] + n[b + 1] + n[c + 1]) + fz * (n[a + 2] + n[b + 2] + n[c + 2]);
  }
  if (score < 0) for (let t = 0; t < idx.length; t += 3) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  return pc;
}

// ---- grids ----------------------------------------------------------------
//
// The shell, the canopy and every projected lamp are grids of points, rows by
// columns. Their normals come from the grid itself — central differences
// across each vertex — rather than from averaging triangle normals, so the
// shading follows the SURFACE the grid samples and not the facets it happens
// to be cut into, and two buckets cut from one grid (a pillar and the glass
// beside it) share exactly the same normal along their common edge.

function gridNormals(P, R, C, wrapC) {
  const N = new Float64Array(R * C * 3);
  const bad = new Uint8Array(R * C);
  for (let r = 0; r < R; r++) {
    const r0 = r > 0 ? r - 1 : r, r1 = r < R - 1 ? r + 1 : r;
    for (let c = 0; c < C; c++) {
      const c0 = wrapC ? (c + C - 1) % C : Math.max(0, c - 1);
      const c1 = wrapC ? (c + 1) % C : Math.min(C - 1, c + 1);
      const A = (r1 * C + c) * 3, Bq = (r0 * C + c) * 3, Cq = (r * C + c1) * 3, D = (r * C + c0) * 3;
      const tx = P[A] - P[Bq], ty = P[A + 1] - P[Bq + 1], tz = P[A + 2] - P[Bq + 2];
      const sx = P[Cq] - P[D], sy = P[Cq + 1] - P[D + 1], sz = P[Cq + 2] - P[D + 2];
      let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
      const l = Math.hypot(nx, ny, nz);
      const o = (r * C + c) * 3;
      if (l < 1e-10) { bad[r * C + c] = 1; continue; }
      N[o] = nx / l; N[o + 1] = ny / l; N[o + 2] = nz / l;
    }
  }
  // Degenerate spots — a collapsed end row, a fillet with no room — borrow
  // the nearest good normal along the row, then along the column.
  for (let pass = 0; pass < 4; pass++) {
    let left = 0;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (!bad[r * C + c]) continue;
        let got = -1;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr; let cc = c + dc;
          if (wrapC) cc = (cc + C) % C;
          if (rr < 0 || rr >= R || cc < 0 || cc >= C || bad[rr * C + cc]) continue;
          got = rr * C + cc; break;
        }
        if (got < 0) { left++; continue; }
        N[(r * C + c) * 3] = N[got * 3]; N[(r * C + c) * 3 + 1] = N[got * 3 + 1]; N[(r * C + c) * 3 + 2] = N[got * 3 + 2];
        bad[r * C + c] = 0;
      }
    }
    if (!left) break;
  }
  return N;
}

/**
 * Cut a set of cells out of a grid as one piece. Cells are (r, c) meaning the
 * quad to (r+1, c+1), with c+1 wrapping when the grid is closed. `inset`
 * pushes the vertices back along their normals (flush glazing), and `uv` is
 * 'grid' or a pair of axes to project onto, normalised to the piece's bounds.
 */
function emit(G, cells, { inset = 0, uv = 'grid', flipUV = false } = {}) {
  const { P, N, R, C, wrapC } = G;
  const map = new Int32Array(R * C).fill(-1);
  const used = [];
  const pos = [], nrm = [], idx = [];
  const vert = (r, c) => {
    const k = r * C + c;
    let i = map[k];
    if (i >= 0) return i;
    i = pos.length / 3; map[k] = i; used.push(k);
    const o = k * 3;
    pos.push(P[o] - N[o] * inset, P[o + 1] - N[o + 1] * inset, P[o + 2] - N[o + 2] * inset);
    nrm.push(N[o], N[o + 1], N[o + 2]);
    return i;
  };
  const area2 = (a, b, c) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  for (const [r, c] of cells) {
    const c1 = wrapC ? (c + 1) % C : c + 1;
    const a = vert(r, c), b = vert(r + 1, c), cc = vert(r + 1, c1), d = vert(r, c1);
    if (area2(a, b, cc) > 1e-10) idx.push(a, b, cc);
    if (area2(a, cc, d) > 1e-10) idx.push(a, cc, d);
  }
  const n = pos.length / 3;
  const U = new Float32Array(n * 2);
  if (uv === 'grid') {
    for (const k of used) { const i = map[k]; U[i * 2] = (k % C) / Math.max(1, C - 1); U[i * 2 + 1] = Math.floor(k / C) / Math.max(1, R - 1); }
  } else {
    const [ua, va] = uv;                        // axis indices, e.g. [0, 2]
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) { u0 = Math.min(u0, pos[i * 3 + ua]); u1 = Math.max(u1, pos[i * 3 + ua]); v0 = Math.min(v0, pos[i * 3 + va]); v1 = Math.max(v1, pos[i * 3 + va]); }
    for (let i = 0; i < n; i++) {
      U[i * 2] = (pos[i * 3 + ua] - u0) / Math.max(1e-6, u1 - u0);
      U[i * 2 + 1] = (pos[i * 3 + va] - v0) / Math.max(1e-6, v1 - v0);
      if (flipUV) U[i * 2] = 1 - U[i * 2];
    }
  }
  const pc = piece(Float32Array.from(pos), Float32Array.from(nrm), U, Uint32Array.from(idx));
  return orient(pc);
}

function makeGrid(P, R, C, wrapC, outward) {
  const N = gridNormals(P, R, C, wrapC);
  // Point every normal the way `outward(x, y, z, nx, ny, nz)` says is out.
  let score = 0;
  for (let i = 0; i < R * C; i++) score += outward(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
  if (score < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i];
  return { P, N, R, C, wrapC };
}

// ---- 2D helpers for sections ----------------------------------------------

/**
 * A rounded corner at B between A and C, as n points: a quadratic curve from
 * the tangent point on AB, through B's influence, to the tangent point on BC.
 * Degenerate inputs (a zero-length side) just repeat B, so the point count —
 * which the loft depends on — never changes.
 */
function fillet(ax, ay, bx, by, cx, cy, r, n, out) {
  if (n <= 1) { out.push(bx, by); return; }
  const l1 = Math.hypot(ax - bx, ay - by), l2 = Math.hypot(cx - bx, cy - by);
  const t = Math.min(r, l1 * 0.45, l2 * 0.45);
  if (t < 1e-6) { for (let i = 0; i < n; i++) out.push(bx, by); return; }
  const px = bx + (ax - bx) / l1 * t, py = by + (ay - by) / l1 * t;
  const qx = bx + (cx - bx) / l2 * t, qy = by + (cy - by) / l2 * t;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1), a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
    out.push(a * px + b * bx + c * qx, a * py + b * by + c * qy);
  }
}

/** Interior points of a quadratic curve from A via control B to C. */
function quad2(ax, ay, bx, by, cx, cy, n, out) {
  for (let i = 1; i <= n; i++) {
    const s = i / (n + 1), a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
    out.push(a * ax + b * bx + c * cx, a * ay + b * by + c * cy);
  }
}

/** Smoothstep-interpolated 1D profile through [z, value] control points. */
function profileAt(cps, z) {
  const n = cps.length;
  if (z <= cps[0][0]) return cps[0][1];
  if (z >= cps[n - 1][0]) return cps[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (z <= cps[i][0]) {
      const a = cps[i - 1], b = cps[i];
      const t = (z - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t * t * (3 - 2 * t);
    }
  }
  return cps[n - 1][1];
}

// ===========================================================================
// Dimensions
// ===========================================================================

/** Everything derived from the spec that the builders below need. */
function dimensions(style, spec, stOverride = null) {
  const st = stOverride || STYLES[style] || STYLES.sedan;
  const wb = spec.wheelbase, tr = spec.track, wr = spec.wheelRadius, rh = spec.rideHeight;
  const fo = wb * st.over[0], ro = wb * st.over[1];
  const H = (k) => k * wr;
  const h = st.h;
  const hwMax = tr * st.width * 0.5;

  const d = {
    st, style, wb, tr, wr, rh, fo, ro, hwMax,
    zFront: -(wb * 0.5 + fo), zRear: wb * 0.5 + ro,
    zAxleF: -wb * 0.5, zAxleR: wb * 0.5,
    yWheel: wr - rh,
    tyreW: wr * (st.tyre ?? 0.62),
    rimR: wr * st.wheel.rim,
    yNose: H(h.nose), yBonnet: H(h.bonnet), yBelt: H(h.belt),
    yRoof: H(h.roof), yBoot: H(h.boot), yTail: H(h.tail),
    cabF: st.cab[0] * wb, roofF: st.cab[1] * wb, roofR: st.cab[2] * wb, cabR: st.cab[3] * wb,
    archH: wr * st.arch,
    // Half the length of the arch opening along the sill. Wider than the tyre
    // by a quarter of its radius each side, which is what a steered front
    // wheel needs to swing in.
    archLen: wr * 1.26,
    lipH: 0.022,
    crease: wr * st.crease,
    crown: wr * 0.05,
    tuck: 0.035,
  };
  // A bumper's middle stands proud of its corners. The loft is built in a
  // STRAIGHT frame whose tips sit `sweep` back from the real ones, and bend()
  // pushes the middle out afterwards, so zFront/zRear stay the true extremes.
  d.sweepF = st.sweep[0]; d.sweepR = st.sweep[1];
  d.rakeF = st.rake[0]; d.rakeR = st.rake[1];
  d.bulgeF = st.bulge[0]; d.bulgeR = st.bulge[1];
  d.zF0 = d.zFront + d.sweepF + d.bulgeF; d.zR0 = d.zRear - d.sweepR - d.bulgeR;
  d.rpF = st.plan[0] * hwMax; d.rpR = st.plan[1] * hwMax;
  d.endR = 0.06;                                   // edge radius round both end faces
  // Ground clearance under the sill. A real saloon's sill is ~13 cm off the
  // road; putting it at the chassis datum (27 cm) left daylight under every
  // car and made them look parked on stilts.
  d.yRocker = -rh + clamp(rh * 0.46, 0.09, 0.26);
  d.yFloor = d.yRocker + 0.035;
  d.rockerH = clamp(wr * 0.36, 0.10, 0.16);
  d.xWell = tr * 0.5 - d.tyreW * 0.5 - 0.045;
  d.hwRoof = hwMax * st.roofW;
  // The end faces: where the bumper line runs, and how far back from each tip
  // the rake reaches — never into the arch, or the wheel would poke through.
  d.yChinF = d.yRocker + 0.05; d.yChinR = d.yRocker + 0.07;
  d.yBumpF = lerp(d.yChinF, d.yNose, 0.45);
  d.yBumpR = lerp(d.yChinR, d.yTail, 0.42);
  d.tipF = clamp(d.zAxleF - d.archLen - d.zF0 - 0.06, 0.08, 0.32);
  d.tipR = clamp(d.zR0 - (d.zAxleR + d.archLen) - 0.06, 0.08, 0.32);

  // Top line: bumper, bonnet, a belt that rises through the doors, then the
  // rear deck.
  d.top = [
    [d.zFront, d.yNose],
    [d.zFront + fo * 0.55, d.yNose + (d.yBonnet - d.yNose) * 0.82],
    [d.cabF, d.yBonnet],
    [d.cabF + (d.cabR - d.cabF) * 0.35, d.yBelt],
    [d.cabR - 0.06, d.yBelt],
    [d.cabR, d.yBoot],
    [d.zRear, d.yTail],
  ];
  // Half width, as a fraction of the maximum. Only gently narrower at the
  // ends: the plan-view corner radius does the real rounding there.
  d.wide = [
    [d.zFront, 0.95], [d.zFront + fo * 0.5, 0.99],
    [d.zAxleF, st.haunch ? 0.985 : 1.0], [d.zAxleR, st.haunch ? 1.02 : 1.0],
    [d.zRear - ro * 0.5, 0.985], [d.zRear, 0.96],
  ];

  // The cabin tub: behind the dash, to the parcel shelf or load floor.
  const dash = Math.min(0.42, (d.cabR - d.cabF) * 0.3);
  const tubs = [];
  const cabEnd = st.cargo ? d.cabR : lerp(d.roofR, d.cabR, st.shelf);
  tubs.push({ kind: 'cabin', z0: d.cabF + dash, z1: Math.max(d.cabF + dash + 0.3, cabEnd - 0.01), floor: d.yFloor + 0.10 });
  if (st.bed) tubs.push({ kind: 'bed', z0: d.cabR + 0.07, z1: d.zRear - 0.08, floor: H(st.bed) });
  d.tubs = tubs;
  d.dashEnd = d.cabF + dash;

  // Where a driver's head goes, and where the cockpit camera wants to sit.
  // Same maths as the first version of this file, so dims.seat means what it
  // always has.
  const seatZ = d.cabF + (d.cabR - d.cabF) * 0.40;
  const k0 = sectionKeys(d, seatZ, 0, []);
  d.seat = { x: -k0[12] * 0.44, y: k0[13] - wr * 0.06, z: seatZ + wr * 0.05 };

  d.seams = seamUniforms(d);
  return d;
}

/**
 * Where the shut lines are, for the paint shader. Deliberately the same
 * windows render/carDamage.js carves panels out of (its doorSpan, the bonnet's
 * 0.42 of the front overhang and 0.86 of the half width, the boot from the rear
 * glass base), so a lost panel leaves a hole the shape of its drawn outline.
 */
function seamUniforms(d) {
  const st = d.st, wr = d.wr, hw = d.hwMax;
  const doorF = d.zAxleF + Math.max(wr * 0.95, d.archLen + 0.05);
  const doorR = st.cargo ? d.zAxleR - d.archLen - 0.06 : (st.doors === 4 ? d.zAxleR - d.archLen - 0.03 : lerp(d.roofR, d.cabR, 0.15));
  const split = st.cargo ? d.cabR + 0.04 : lerp(d.roofF, d.roofR, 0.44);
  const kD = sectionKeys(d, (doorF + doorR) * 0.5, 0, []);
  const yBottom = kD[7] + 0.004;
  const zBoot = st.cargo ? d.zRear + 1 : d.cabR + 0.01;
  const kB = sectionKeys(d, d.zAxleR + 0.06, 0, []);
  return {
    door: new THREE.Vector4(doorF, split, doorR, hw * 0.62),
    doorY: new THREE.Vector4(yBottom, d.yBelt + 0.02, (st.doors === 4 || st.cargo) ? 1 : 0, 0),
    bonnet: new THREE.Vector4(d.zFront + d.fo * 0.42, d.cabF - 0.02, hw * 0.86, d.yBonnet - wr * 0.45),
    boot: new THREE.Vector4(zBoot, st.bed ? zBoot - 1 : d.zRear + 0.05, hw * 0.86, d.yBoot - wr * 0.45),
    fuel: new THREE.Vector4(kB[11] - 0.10, d.zAxleR - d.archLen * 0.2 - 0.12, st.bed || st.cargo ? 0 : 0.055, hw * 0.7),
  };
}

// ---- the profiles a section is built from ---------------------------------

function planHalfWidth(d, z) {
  let w = d.hwMax * profileAt(d.wide, z);
  const df = z - d.zF0, dr = d.zR0 - z;
  if (df < d.rpF) { const t = (d.rpF - Math.max(0, df)) / d.rpF; w -= d.rpF * (1 - Math.sqrt(Math.max(0, 1 - t * t))); }
  if (dr < d.rpR) { const t = (d.rpR - Math.max(0, dr)) / d.rpR; w -= d.rpR * (1 - Math.sqrt(Math.max(0, 1 - t * t))); }
  return w;
}

/** Height of the top of the arch opening at z, or -Infinity outside an arch. */
function archCut(d, z) {
  for (const za of [d.zAxleF, d.zAxleR]) {
    const t = (z - za) / d.archLen;
    if (t >= -1 && t <= 1) return d.yWheel + d.archH * Math.sqrt(Math.max(0, 1 - t * t));
  }
  return -Infinity;
}

/** 0..1, how much this z is "over a wheel" — drives the flares. */
function archBlend(d, z) {
  let b = 0;
  for (const za of [d.zAxleF, d.zAxleR]) {
    const t = Math.abs(z - za) / (d.archLen * 1.45);
    if (t < 1) b = Math.max(b, 0.5 + 0.5 * Math.cos(t * Math.PI));
  }
  return b;
}

function flareAt(d, z) {
  const rear = z > 0 && d.st.haunch ? 1.7 : 1;
  return d.wr * d.st.flare * archBlend(d, z) * rear;
}

/** The sill line, lifting toward both bumpers for approach and departure. */
function rockerBotAt(d, z) {
  const fEnd = d.zAxleF - d.archLen, rEnd = d.zAxleR + d.archLen;
  let y = d.yRocker;
  if (z < fEnd) y += 0.05 * smooth(fEnd, d.zF0, z);
  if (z > rEnd) y += 0.07 * smooth(rEnd, d.zR0, z);
  return y;
}

/** How far the end faces have pulled every edge in, for the rounded rim. */
function endInset(d, z) {
  const a = z - d.zF0, b = d.zR0 - z, R = d.endR;
  const e = Math.min(a, b);
  if (e >= R) return 0;
  const t = (R - Math.max(0, e)) / R;
  return R * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
}

/**
 * The ten key points of the right half of a section at z, as x,y pairs:
 *
 *   0 bottom centre      5 shoulder crease
 *   1 underbody edge     6 deck edge / window line
 *   2 sill corner        7 tub rim (or on the deck crown)
 *   3 lower crease       8 tub floor corner (or on the deck crown)
 *   4 belly (control)    9 top centre (deck crown, or tub floor)
 *
 * `depth` 0..1 drops points 7-9 into the tub. Over a wheel, 1-3 rise into the
 * arch: 1 becomes the inner edge of the black well roof, 2-3 the rolled lip.
 */
function sectionKeys(d, z, depth, K, tubFloor = 0) {
  const hw = planHalfWidth(d, z);
  const fl = flareAt(d, z);
  const cut = archCut(d, z);
  const inArch = cut > -1e8;
  const yRB = rockerBotAt(d, z);
  const yRT = yRB + d.rockerH;
  const top = profileAt(d.top, z);
  const ab = archBlend(d, z);

  let ySh = top - d.crease + d.wr * 0.03 * ab;
  if (inArch) ySh = smax(ySh, cut + d.lipH + 0.075, 0.05);
  const yDk = Math.max(top + d.wr * 0.02 * ab, ySh + d.crease * 0.6);

  const xBelly = hw + fl * 0.8;
  const xLow = hw - 0.010 + fl;
  const xSill = hw - d.tuck + fl * 0.85;
  const xSh = hw - 0.008 + fl * 0.35;
  const xDk = xSh - Math.max(0.028, (yDk - ySh) * 0.55);

  let p1x, p1y, p2x, p2y, p3x, p3y;
  if (inArch && cut > yRB) {
    p1x = Math.min(d.xWell, xSill - 0.08); p1y = cut - 0.004;
    p2x = xLow - 0.022; p2y = cut;
    p3x = xLow; p3y = Math.max(yRT, cut + d.lipH);
  } else {
    p1x = xSill - 0.07; p1y = d.yFloor;
    p2x = xSill; p2y = yRB;
    p3x = xLow; p3y = yRT;
  }
  const p4y = Math.max(p3y + 0.02, lerp(p3y, ySh, 0.45));

  const yC = top + d.crown;
  const deck = (x) => yC + (yDk - yC) * (x / xDk) * (x / xDk);
  let p7x = xDk * 0.64, p7y = deck(p7x), p8x = xDk * 0.30, p8y = deck(p8x), p9y = yC;
  if (depth > 0) {
    const t7x = xDk - 0.045, t7y = yDk - 0.006;
    const t8x = t7x - 0.02;
    p7x = lerp(p7x, t7x, depth); p7y = lerp(p7y, t7y, depth);
    p8x = lerp(p8x, t8x, depth); p8y = lerp(p8y, tubFloor, depth);
    p9y = lerp(p9y, tubFloor, depth);
  }

  K.length = 20;
  K[0] = 0; K[1] = d.yFloor;
  K[2] = p1x; K[3] = p1y;
  K[4] = p2x; K[5] = p2y;
  K[6] = p3x; K[7] = p3y;
  K[8] = xBelly; K[9] = p4y;
  K[10] = xSh; K[11] = ySh;
  K[12] = xDk; K[13] = yDk;
  K[14] = p7x; K[15] = p7y;
  K[16] = p8x; K[17] = p8y;
  K[18] = 0; K[19] = p9y;

  // The end faces: every edge pulled in by the same amount, which is what
  // rounds the rim where the bumper face meets the wings and bonnet.
  const e = endInset(d, z);
  if (e > 0) {
    for (let i = 2; i < 17; i += 2) K[i] = Math.max(0, K[i] - e);
    for (const i of [1, 3, 5]) K[i] += e;
    for (const i of [11, 13, 15, 17, 19]) K[i] -= e;
  }
  return K;
}

// Ring point counts, and what each edge of the half ring is.
const UNDER = 0, BODY = 1, WALL = 2, FLOOR = 3;
const RING = {
  high: { n2: 3, n3: 2, belly: 3, n5: 2, n6: 3, n7: 2 },
  low: { n2: 1, n3: 1, belly: 1, n5: 1, n6: 2, n7: 1 },
};

/** The right half of a section as points, bottom centre excluded, top centre excluded. */
function halfRing(d, z, depth, tubFloor, hi, out, labels) {
  const K = sectionKeys(d, z, depth, _K, tubFloor);
  const R = hi ? RING.high : RING.low;
  // A soft bonnet edge, a crisp window line: blended along z so the edge
  // does not kink where one becomes the other.
  const cab = smooth(d.cabF - 0.3, d.cabF - 0.02, z) * (1 - smooth(d.cabR + 0.02, d.cabR + 0.3, z));
  const r6 = lerp(0.05, 0.016, cab);
  out.length = 0;
  const lab = labels ? [] : null;
  const push = (arr, l) => { for (let i = 0; i < arr.length; i += 2) { out.push(arr[i], arr[i + 1]); if (lab) lab.push(l); } };
  const f2 = [], f3 = [], f5 = [], f6 = [], f7 = [], belly = [];
  fillet(K[2], K[3], K[4], K[5], K[6], K[7], 0.03, R.n2, f2);
  fillet(K[4], K[5], K[6], K[7], K[8], K[9], 0.012, R.n3, f3);
  fillet(K[8], K[9], K[10], K[11], K[12], K[13], 0.012, R.n5, f5);
  fillet(K[10], K[11], K[12], K[13], K[14], K[15], r6, R.n6, f6);
  fillet(K[12], K[13], K[14], K[15], K[16], K[17], 0.012, R.n7, f7);
  quad2(f3[f3.length - 2], f3[f3.length - 1], K[8], K[9], f5[0], f5[1], R.belly, belly);
  push([K[2], K[3]], UNDER);
  push(f2, UNDER);
  push(f3, BODY);
  push(belly, BODY);
  push(f5, BODY);
  push(f6, BODY);
  push(f7, WALL);
  push([K[16], K[17]], FLOOR);
  if (lab) { labels.length = 0; for (const l of lab) labels.push(l); }
  return K;
}
const _K = [];

// ===========================================================================
// Surface queries
// ===========================================================================
//
// Lamps, grille, plates, mirrors and handles are placed by asking where the
// shell IS, in the straight (unbent) frame, and then bent with everything else.
// That is what makes a headlight wrap round the corner of the wing and a door
// handle sit on the door instead of hovering beside it.

const _half = [];

/**
 * The full section at z, no tub, as a flat closed polygon of (x, y) pairs
 * written into `out`. Returns the point count.
 */
function sectionRing(d, z, out) {
  halfRing(d, z, 0, 0, true, _half, null);
  const K = _K, M = _half.length / 2;
  let w = 0;
  out[w++] = 0; out[w++] = K[1];
  for (let i = 0; i < M; i++) { out[w++] = _half[i * 2]; out[w++] = _half[i * 2 + 1]; }
  out[w++] = 0; out[w++] = K[19];
  for (let i = M - 1; i >= 0; i--) { out[w++] = -_half[i * 2]; out[w++] = _half[i * 2 + 1]; }
  return w / 2;
}

/** Even-odd point-in-polygon over a flat ring, starting at float offset `o`. */
function insideRing(R, o, C, x, y) {
  let inside = false;
  for (let i = 0, j = C - 1; i < C; j = i++) {
    const xi = R[o + i * 2], yi = R[o + i * 2 + 1], xj = R[o + j * 2], yj = R[o + j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Scratch for one section and one blended section.
const _ringA = new Float64Array(512), _ringB = new Float64Array(512);

/**
 * The two ends of the body, sampled once per build.
 *
 * Every lamp, grille and plate vertex is found by searching along z for where
 * it enters the body, and each step of that search used to rebuild a section
 * from scratch — fillets and all. That was two thirds of a car's build time,
 * and a traffic spawn builds up to fifteen cars in one frame. Ahead of the
 * arches a section's point count never changes, so sections are sampled here
 * at 48 stations per end, packed tighter toward the tip where the shape turns
 * fastest, and the search blends between neighbours instead.
 */
function endCache(d) {
  if (d.ends) return d.ends;
  const n = 48;
  const C = sectionRing(d, d.zF0, _ringA);
  const make = (z0, z1) => {
    const zs = new Float64Array(n), rings = new Float64Array(n * C * 2);
    for (let i = 0; i < n; i++) {
      const t = Math.pow(i / (n - 1), 1.6);
      zs[i] = lerp(z0, z1, t);
      sectionRing(d, zs[i], _ringA);
      rings.set(_ringA.subarray(0, C * 2), i * C * 2);
    }
    return { zs, rings };
  };
  d.ends = {
    C, n,
    front: make(d.zF0, d.zAxleF - d.archLen - 0.006),
    rear: make(d.zR0, d.zAxleR + d.archLen + 0.006),
  };
  return d.ends;
}

/**
 * Where (x, y) first enters the body, searching from the tip of one end back
 * toward its arch. The search stops short of the arch: inside it the section
 * is cut away from below, so "inside" stops being monotonic and a point by
 * the chin would read as outside the car. NaN when it never enters.
 */
function endZ(d, face, x, y) {
  const E = endCache(d), C = E.C, S = face === 'front' ? E.front : E.rear;
  const stride = C * 2;
  let k = -1;
  for (let i = 0; i < E.n; i++) if (insideRing(S.rings, i * stride, C, x, y)) { k = i; break; }
  if (k < 0) return NaN;
  if (k === 0) return S.zs[0];
  // Bisect between the last sample outside and the first inside, on a
  // point-by-point blend of the two sections.
  const a = (k - 1) * stride, b = k * stride;
  let lo = 0, hi = 1;
  for (let it = 0; it < 14; it++) {
    const m = (lo + hi) * 0.5;
    for (let i = 0; i < stride; i++) _ringB[i] = S.rings[a + i] + (S.rings[b + i] - S.rings[a + i]) * m;
    if (insideRing(_ringB, 0, C, x, y)) hi = m; else lo = m;
  }
  return lerp(S.zs[k - 1], S.zs[k], hi);
}

/**
 * Where a point seen from one end lands on the body, as [y, z]. A point above
 * or below the body there — the top corner of a lamp outline that runs up over
 * a rounded wing — never enters it, and returning the search limit would throw
 * that vertex back to the axle line and stretch the lamp into a spike. So it is
 * first clamped into the body's vertical extent where the section is whole.
 */
function projectEnd(d, face, x, y) {
  const E = endCache(d), C = E.C, S = face === 'front' ? E.front : E.rear;
  const o = (E.n - 1) * C * 2, R = S.rings, ax = Math.abs(x);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, j = C - 1; i < C; j = i++) {
    const x0 = R[o + j * 2], y0 = R[o + j * 2 + 1], x1 = R[o + i * 2], y1 = R[o + i * 2 + 1];
    if ((x0 - ax) * (x1 - ax) > 0 || x0 === x1) continue;
    const yc = y0 + (y1 - y0) * (ax - x0) / (x1 - x0);
    lo = Math.min(lo, yc); hi = Math.max(hi, yc);
  }
  const yy = lo < hi ? clamp(y, lo + 0.003, hi - 0.003) : y;
  const z = endZ(d, face, x, yy);
  return [yy, Number.isNaN(z) ? S.zs[E.n - 1] : z];
}

/** The right flank: the outermost x of the section at z, at height y. */
function sideX(d, z, y) {
  const C = sectionRing(d, z, _ringA), half = (C >> 1) + 1;
  let best = 0;
  for (let i = 0; i < half - 1; i++) {
    const x0 = _ringA[i * 2], y0 = _ringA[i * 2 + 1], x1 = _ringA[i * 2 + 2], y1 = _ringA[i * 2 + 3];
    if ((y0 - y) * (y1 - y) > 0 || y0 === y1) continue;
    best = Math.max(best, x0 + (x1 - x0) * (y - y0) / (y1 - y0));
  }
  return best;
}

/** The top of the section at z, at lateral position x. */
function topY(d, z, x) {
  const C = sectionRing(d, z, _ringA), half = (C >> 1) + 1;
  let best = -Infinity;
  for (let i = 0; i < half - 1; i++) {
    const x0 = _ringA[i * 2], y0 = _ringA[i * 2 + 1], x1 = _ringA[i * 2 + 2], y1 = _ringA[i * 2 + 3];
    if ((x0 - x) * (x1 - x) > 0 || x0 === x1) continue;
    best = Math.max(best, y0 + (y1 - y0) * (x - x0) / (x1 - x0));
  }
  return best > -Infinity ? best : _K[19];
}

/**
 * A patch of the body surface seen from the front or the rear: a bilinear
 * quad in (x, y), projected onto the shell along z and lifted off it along its
 * own normal, with a gentle dome. Lamp lenses, grilles and the plates' mounts
 * are all this.
 */
function projectedPatch(d, corners, nu, nv, face, { lift = 0.004, dome = 0.004 } = {}) {
  const R = nv + 1, C = nu + 1;
  const P = new Float64Array(R * C * 3);
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;       // BL, BR, TR, TL
  for (let j = 0; j < R; j++) {
    const v = j / nv;
    for (let i = 0; i < C; i++) {
      const u = i / nu;
      const x = lerp(lerp(x0, x1, u), lerp(x3, x2, u), v);
      const [y, z] = projectEnd(d, face, x, lerp(lerp(y0, y1, u), lerp(y3, y2, u), v));
      const o = (j * C + i) * 3;
      P[o] = x; P[o + 1] = y; P[o + 2] = z;
    }
  }
  const out = face === 'front' ? -1 : 1;
  const G = makeGrid(P, R, C, false, (x, y, z, nx, ny, nz) => nz * out);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < C; i++) {
      const o = (j * C + i) * 3;
      const k = lift + dome * Math.sin(Math.PI * i / nu) * Math.sin(Math.PI * j / nv);
      P[o] += G.N[o] * k; P[o + 1] += G.N[o + 1] * k; P[o + 2] += G.N[o + 2] * k;
    }
  }
  const cells = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) cells.push([j, i]);
  const pc = emit(G, cells, { uv: 'grid' });
  // Grid uv is (column, row) = (u across, v up), which is what the lamp
  // graphics are drawn in.
  return pc;
}

/** A thin frame round a projected outline — grille surrounds, lamp bezels. */
function projectedFrame(d, corners, w, face, lift) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  const bars = [
    [[x0, y0], [x1, y1], [x1, y1 + w], [x0, y0 + w]],
    [[x3, y3 - w], [x2, y2 - w], [x2, y2], [x3, y3]],
    [[x0 - w, y0], [x0, y0], [x3, y3], [x3 - w, y3]],
    [[x1, y1], [x1 + w, y1], [x2 + w, y2], [x2, y2]],
  ];
  return bars.map((q) => projectedPatch(d, q, 4, 1, face, { lift, dome: 0 }));
}

// ===========================================================================
// The shell
// ===========================================================================

/** Stations along the car, dense where arches and ends need resolving. */
function shellStations(d, hi) {
  const zs = [d.zF0, d.zR0, d.cabF, d.cabR, d.dashEnd];
  const nP = hi ? 7 : 3;
  for (let i = 1; i <= nP; i++) {
    const th = (i / nP) * Math.PI * 0.5;
    zs.push(d.zF0 + d.rpF * (1 - Math.cos(th)), d.zR0 - d.rpR * (1 - Math.cos(th)));
  }
  // The end-face rim radius needs its own stations or it is a chamfer.
  for (const f of hi ? [0.25, 0.6] : [0.5]) zs.push(d.zF0 + d.endR * f, d.zR0 - d.endR * f);
  const nA = hi ? 14 : 7;
  for (const za of [d.zAxleF, d.zAxleR]) {
    for (let i = 0; i <= nA; i++) zs.push(za - d.archLen * Math.cos((i / nA) * Math.PI));
    // The arch legs: 4 mm outboard of the opening, so its sides are walls.
    zs.push(za - d.archLen - 0.004, za + d.archLen + 0.004);
    // Where the flare fades out.
    zs.push(za - d.archLen * 1.3, za + d.archLen * 1.3);
  }
  const RAMP = 0.006;
  for (const t of d.tubs) zs.push(t.z0, t.z0 + RAMP, t.z1 - RAMP, t.z1);
  zs.sort((a, b) => a - b);
  const clean = [];
  for (const z of zs) {
    if (z < d.zF0 - 1e-6 || z > d.zR0 + 1e-6) continue;
    if (clean.length && z - clean[clean.length - 1] < 0.003) continue;
    clean.push(z);
  }
  // Fill long gaps so the bonnet, roof-less deck and doors stay smooth.
  const step = hi ? 0.11 : 0.26;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    if (i > 0) {
      const a = clean[i - 1], b = clean[i], n = Math.floor((b - a) / step);
      for (let k = 1; k <= n; k++) out.push(a + (b - a) * (k / (n + 1)));
    }
    out.push(clean[i]);
  }
  const depthAt = (z) => {
    for (const t of d.tubs) {
      if (z >= t.z0 && z <= t.z1) return { depth: clamp((z - t.z0) / RAMP, 0, 1) * clamp((t.z1 - z) / RAMP, 0, 1), floor: t.floor, kind: t.kind };
    }
    return { depth: 0, floor: 0, kind: null };
  };
  const rows = [];
  const caps = hi ? [0, 0.38, 0.72] : [0, 0.55];
  for (const c of caps) rows.push({ z: d.zF0, cap: c, depth: 0, floor: 0, kind: null });
  for (const z of out) rows.push({ z, cap: 1, ...depthAt(z) });
  for (let i = caps.length - 1; i >= 0; i--) rows.push({ z: d.zR0, cap: caps[i], depth: 0, floor: 0, kind: null });
  return rows;
}

function buildShell(d, B, hi) {
  const rows = shellStations(d, hi);
  const labels = [];
  halfRing(d, 0, 0, 0, hi, _half, labels);
  const M = _half.length / 2;                 // points per half, centres excluded
  const C = 2 * M + 2;
  const R = rows.length;
  const P = new Float64Array(R * C * 3);
  for (let r = 0; r < R; r++) {
    const s = rows[r];
    const K = halfRing(d, s.z, s.depth, s.floor, hi, _half, null);
    const put = (c, x, y) => { const o = (r * C + c) * 3; P[o] = x * s.cap; P[o + 1] = y; P[o + 2] = s.z; };
    put(0, 0, K[1]);
    for (let i = 0; i < M; i++) put(1 + i, _half[i * 2], _half[i * 2 + 1]);
    put(M + 1, 0, K[19]);
    for (let i = 0; i < M; i++) put(M + 2 + i, -_half[(M - 1 - i) * 2], _half[(M - 1 - i) * 2 + 1]);
  }
  const G = makeGrid(P, R, C, true, (x, y, z, nx, ny) => x * nx + (y - d.yBelt * 0.5) * ny * 0.2);

  // Edge label for full-ring column c -> c+1.
  // Edge c runs from ring column c to c+1. On the right half, column c is
  // half-point c-1, and an edge takes the label of the point it runs TO; the
  // left half mirrors it.
  const edge = new Uint8Array(C);
  edge[0] = UNDER;
  for (let i = 1; i < M; i++) edge[i] = labels[i];
  edge[M] = FLOOR;
  for (let i = 0; i <= M; i++) edge[M + 1 + i] = edge[M - i];

  // The cabin tub goes in `plastic`, not `interior`: the seats and dash are
  // hidden at distance, and a tub hidden with them would leave a car you could
  // see straight through.
  const buckets = { paint: [], plastic: [] };
  for (let r = 0; r < R - 1; r++) {
    const a = rows[r], b = rows[r + 1];
    const zm = (a.z + b.z) * 0.5;
    const capRow = a.cap < 1 || b.cap < 1;
    const inBed = !capRow && d.tubs.some((t) => t.kind === 'bed' && zm > t.z0 - 0.001 && zm < t.z1 + 0.001);
    const inCab = !capRow && zm > d.cabF + 0.002 && zm < (d.st.cargo ? d.zR0 : d.cabR - 0.002);
    const deep = Math.min(a.depth, b.depth) > 0.5;
    for (let c = 0; c < C; c++) {
      const e = edge[c];
      let bucket;
      if (e === UNDER) bucket = 'plastic';
      else if (e === BODY) bucket = 'paint';
      else if (inBed) bucket = e === FLOOR && deep ? 'plastic' : 'paint';
      else if (inCab) bucket = 'plastic';
      else bucket = 'paint';
      buckets[bucket].push([r, c]);
    }
  }
  B.paint.push(emit(G, buckets.paint));
  B.plastic.push(emit(G, buckets.plastic));
  return G;
}

// ===========================================================================
// The canopy: pillars, glass and roof as one surface
// ===========================================================================

const CANOPY = {
  high: { side: 2, fillet: 2, top: 3 },
  low: { side: 0, fillet: 1, top: 1 },
};

function canopyLines(d) {
  const st = d.st;
  const zEnd = st.cargo ? d.zR0 : d.cabR;
  const K0 = sectionKeys(d, d.cabF, 0, []);
  const yCowl = K0[19];
  const K1 = sectionKeys(d, d.cabR, 0, []);
  const yDeckR = K1[19];
  const roofEnd = st.cargo ? d.zR0 - 0.03 : d.roofR;
  const L = {
    zEnd, roofEnd, yCowl, yDeckR,
    wrapF: 0.09, wrapR: st.cargo ? 0 : 0.07,
    sag: 0.018, railDrop: 0.05,
    wsBulge: 0.025, rgBulge: 0.02,
    cornerR: 0.045,
  };
  L.zA1 = d.roofF + L.wrapF;
  L.zC0 = st.cargo ? roofEnd : d.roofR - L.wrapR;
  return L;
}

function canopyTop(d, L, z) {
  if (z <= d.roofF) {
    const t = clamp((z - d.cabF) / (d.roofF - d.cabF), 0, 1);
    return lerp(L.yCowl, d.yRoof - L.sag, t) + L.wsBulge * 4 * t * (1 - t);
  }
  if (z <= L.roofEnd) {
    const t = (z - d.roofF) / Math.max(1e-3, L.roofEnd - d.roofF);
    return d.yRoof - L.sag * (2 * t - 1) * (2 * t - 1);
  }
  if (d.st.cargo) {
    // The back of a van: a small radius from the roof into a flat door face.
    const t = clamp((z - L.roofEnd) / Math.max(1e-3, d.zR0 - L.roofEnd), 0, 1);
    return d.yRoof - L.sag - 0.03 * t;
  }
  const t = clamp((z - d.roofR) / Math.max(1e-3, d.cabR - d.roofR), 0, 1);
  return lerp(d.yRoof - L.sag, L.yDeckR, t) + L.rgBulge * 4 * t * (1 - t);
}

function roofHalfWidth(d, L, z) {
  const t = clamp((z - d.roofF) / Math.max(1e-3, L.roofEnd - d.roofF), 0, 1);
  const w = d.hwRoof * (0.95 + 0.05 * Math.sin(t * Math.PI));
  return d.st.cargo && z > d.cabR ? Math.min(w * 1.02, planHalfWidth(d, z) * 0.965) : w;
}

/** Side glass height as a fraction of the window opening at z. */
function glassFraction(d, z) {
  const st = d.st;
  if (st.cargo) return z <= d.cabR + 1e-4 ? 1 : 0;
  const zQ = d.roofR + st.quarter * (d.cabR - d.roofR);
  if (z <= zQ) return 1;
  // Behind the quarter line the C-pillar sail takes over. A sliver of glass
  // is left running to the rear glass base: carDamage measures the cabin's
  // length off the side panes, and a pane that stopped short would move the
  // boot lid forward into the roof.
  return Math.max(0.05, 1 - smooth(zQ, zQ + (d.cabR - zQ) * 0.45, z));
}

function canopyRows(d, L, hi) {
  const st = d.st;
  const zs = [d.cabF, d.roofF, L.zA1, d.roofR, d.cabR];
  const nS = hi ? 6 : 3, nB = hi ? 5 : 3;
  for (let i = 1; i < nS; i++) zs.push(lerp(d.cabF, d.roofF, i / nS));
  for (let i = 1; i < nB; i++) zs.push(lerp(d.roofR, d.cabR, i / nB));
  if (!st.cargo && L.zC0 > d.roofF) zs.push(L.zC0);
  const zQ = d.roofR + st.quarter * (d.cabR - d.roofR);
  if (zQ > d.cabF && zQ < d.cabR) zs.push(zQ);
  if (st.bPillar && !st.cargo) {
    const zB = lerp(d.roofF, d.roofR, 0.44);
    zs.push(zB - 0.038, zB + 0.038);
  }
  if (st.cargo) {
    zs.push(d.cabR + 0.075, L.roofEnd, d.zR0 - 0.002, d.zR0);
    const n = Math.max(2, Math.round((L.roofEnd - d.cabR) / (hi ? 0.16 : 0.45)));
    for (let i = 1; i < n; i++) zs.push(lerp(d.cabR + 0.075, L.roofEnd, i / n));
  }
  zs.sort((a, b) => a - b);
  const out = [];
  const step = hi ? 0.15 : 0.36;
  for (const z of zs) {
    if (z < d.cabF - 1e-6 || z > L.zEnd + 1e-6) continue;
    if (out.length) {
      const a = out[out.length - 1];
      if (z - a < 0.0015) continue;
      const n = Math.floor((z - a) / step);
      for (let k = 1; k <= n; k++) out.push(a + (z - a) * (k / (n + 1)));
    }
    out.push(z);
  }
  return out;
}

/** The roof rail / A- and C-pillar line at z, as [x, y]. */
function canopyRail(d, L, z) {
  const tmp = [], lab = [];
  canopySection(d, L, z, false, tmp, lab);
  // The fillet start is the point labelled 'corner' first.
  const i = lab.indexOf('corner');
  return [tmp[i * 2], tmp[i * 2 + 1]];
}

/** One canopy section: the right half from the belt up, then the centre. */
function canopySection(d, L, z, hi, out, labels) {
  const n = hi ? CANOPY.high : CANOPY.low;
  const K = sectionKeys(d, z, 0, _K);
  const xb = K[12] - 0.008, yb = K[13] + 0.001;
  let yt = canopyTop(d, L, z);
  let xr, yr;
  const collapseAt = d.st.cargo ? d.zR0 : d.cabR;
  if (z >= collapseAt - 1e-6 || z <= d.cabF + 1e-6) {
    // The two end rows lie flat on the deck: the windscreen and backlight
    // start from nothing at their base, and a van's box closes onto its tail.
    xr = xb; yr = yb; yt = Math.max(yb + 0.002, K[19]);
  } else if (z < L.zA1) {
    const K0 = sectionKeys(d, d.cabF, 0, []);
    const t = (z - d.cabF) / (L.zA1 - d.cabF);
    const ex = roofHalfWidth(d, L, L.zA1), ey = canopyTop(d, L, L.zA1) - L.railDrop;
    xr = lerp(K0[12] - 0.008, ex, t); yr = lerp(K0[13], ey, t) + 0.012 * 4 * t * (1 - t);
  } else if (z <= L.zC0) {
    xr = roofHalfWidth(d, L, z); yr = yt - L.railDrop;
  } else {
    const K1 = sectionKeys(d, d.cabR, 0, []);
    const t = (z - L.zC0) / Math.max(1e-3, d.cabR - L.zC0);
    const sx = roofHalfWidth(d, L, L.zC0), sy = canopyTop(d, L, L.zC0) - L.railDrop;
    xr = lerp(sx, K1[12] - 0.008, t); yr = lerp(sy, K1[13], t) + 0.01 * 4 * t * (1 - t);
  }
  if (d.st.cargo && z > d.zR0 - 0.0021 && z < d.zR0 - 1e-6) {
    // The flat back face of the box: full height, straight down.
    xr = roofHalfWidth(d, L, z); yr = yt - L.railDrop;
  }
  yr = Math.min(yr, yt - 0.004);

  const len = Math.hypot(xr - xb, yr - yb);
  const sx = len > 1e-6 ? (xr - xb) / len : 0, sy = len > 1e-6 ? (yr - yb) / len : 1;
  const rc = Math.min(L.cornerR, len * 0.45);
  const seal = Math.min(0.012, len * 0.3);
  const frame = Math.min(0.014, len * 0.1);
  const f = glassFraction(d, z);
  const sTop = Math.max(seal, len - rc - frame);
  const sG = seal + f * (sTop - seal);
  const sF = Math.max(sG, len - rc);
  const ox = sy, oy = -sx;                       // outward from the side line
  const sidePt = (s) => {
    const u = len > 1e-6 ? s / len : 0, b = 0.012 * 4 * u * (1 - u);
    return [xb + sx * s + ox * b, yb + sy * s + oy * b];
  };
  out.length = 0; labels.length = 0;
  const add = (p, l) => { out.push(p[0], p[1]); labels.push(l); };
  add([xb, yb], 'seal');
  add(sidePt(seal), 'side');
  for (let i = 1; i <= n.side; i++) add(sidePt(seal + (sG - seal) * (i / (n.side + 1))), 'side');
  add(sidePt(sG), 'frame');
  const A = sidePt(sF);
  add(A, 'corner');
  // The corner, from the side line round onto the roof.
  const ctx = xr * 0.42, cty = yt;
  let tx = ctx - xr, ty = cty - yr;
  const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  const Cx = xr + tx * rc, Cy = yr + ty * rc;
  const tmp = [];
  quad2(A[0], A[1], xr, yr, Cx, Cy, n.fillet, tmp);
  for (let i = 0; i < tmp.length; i += 2) add([tmp[i], tmp[i + 1]], 'corner');
  add([Cx, Cy], 'top');
  tmp.length = 0;
  quad2(Cx, Cy, ctx, cty, 0, yt, n.top, tmp);
  for (let i = 0; i < tmp.length; i += 2) add([tmp[i], tmp[i + 1]], 'top');
  return yt;
}

function buildCanopy(d, B, hi) {
  const st = d.st;
  const L = canopyLines(d);
  const zs = canopyRows(d, L, hi);
  const half = [], lab = [];
  canopySection(d, L, (d.roofF + d.roofR) * 0.5, hi, half, lab);
  const H = half.length / 2;
  const labels = lab.slice();
  const C = 2 * H + 1, R = zs.length;
  const P = new Float64Array(R * C * 3);
  for (let r = 0; r < R; r++) {
    const yt = canopySection(d, L, zs[r], hi, half, lab);
    const put = (c, x, y) => { const o = (r * C + c) * 3; P[o] = x; P[o + 1] = y; P[o + 2] = zs[r]; };
    for (let i = 0; i < H; i++) put(i, -half[i * 2], half[i * 2 + 1]);
    put(H, 0, yt);
    for (let i = 0; i < H; i++) put(C - 1 - i, half[i * 2], half[i * 2 + 1]);
  }
  const G = makeGrid(P, R, C, false, (x, y, z, nx, ny) => x * nx + ny * 0.3);

  // Edge label for column c -> c+1: the left half runs up, the right down.
  const edge = [];
  for (let c = 0; c < C - 1; c++) edge.push(c < H ? labels[c] : labels[C - 2 - c]);

  // At low detail chrome is folded into plastic, and a chrome window frame
  // folded into plastic lands exactly where carDamage looks for mirrors (black
  // plastic, outboard, by the A-pillar). Traffic gets body-coloured frames.
  const trim = !hi ? 'paint' : st.trim === 'chrome' ? 'chrome' : 'plastic';
  const zB = st.cargo ? d.cabR + 0.0375 : lerp(d.roofF, d.roofR, 0.44);
  const inB = (z) => (st.bPillar || st.cargo) && Math.abs(z - zB) < 0.0375;
  const hasGlass = (z) => z > d.cabF && z < d.cabR && glassFraction(d, z) > 0.01;
  const groups = {
    paint: [], plastic: [], chrome: [], screen: [], back: [],
    sideLF: [], sideLR: [], sideRF: [], sideRR: [],
  };
  for (let r = 0; r < R - 1; r++) {
    const zm = (zs[r] + zs[r + 1]) * 0.5;
    const f = glassFraction(d, zm);
    for (let c = 0; c < C - 1; c++) {
      const e = edge[c];
      const left = c < H;
      let g;
      if (e === 'top') {
        g = zm < d.roofF ? 'screen' : zm < L.roofEnd || st.cargo ? 'paint' : 'back';
      } else if (e === 'corner') {
        g = 'paint';
      } else if (e === 'frame') {
        g = hasGlass(zm) && f > 0.97 && !inB(zm) && st.bPillar ? trim : 'paint';
      } else if (e === 'side') {
        if (inB(zm)) g = 'plastic';
        else if (hasGlass(zm)) g = `side${left ? 'L' : 'R'}${zm < zB ? 'F' : 'R'}`;
        else g = 'paint';
      } else {
        g = hasGlass(zm) || inB(zm) ? trim : 'paint';
      }
      if (!st.bPillar && g.startsWith('side')) g = `side${left ? 'L' : 'R'}F`;
      groups[g].push([r, c]);
    }
  }
  B.paint.push(emit(G, groups.paint));
  if (groups.plastic.length) B.plastic.push(emit(G, groups.plastic));
  if (groups.chrome.length) B.chrome.push(emit(G, groups.chrome));
  const GL = 0.0035;
  B.glass.push(emit(G, groups.screen, { inset: GL, uv: [0, 2] }));
  if (groups.back.length) B.glassDark.push(emit(G, groups.back, { inset: GL, uv: [0, 2] }));
  for (const k of ['sideLF', 'sideLR', 'sideRF', 'sideRR']) {
    if (groups[k].length) B.glass.push(emit(G, groups[k], { inset: GL, uv: [2, 1] }));
  }
  if (st.cargo) {
    // The backlight sits in the rear doors: one pane across both, with the
    // door seam laid over it. One pane, because carDamage identifies a rear
    // screen as the component that spans the centreline — two half-width
    // panes would each be taken for a side window.
    const z = d.zR0 + 0.003, y0 = d.yBelt + d.wr * 0.62, y1 = d.yRoof - d.wr * 0.42;
    const w = roofHalfWidth(d, L, d.zR0 - 0.01) * 0.78;
    const pc = fromGeometry(new THREE.PlaneGeometry(w * 2, y1 - y0));
    B.glassDark.push(place(pc, 0, (y0 + y1) * 0.5, z));
    B.plastic.push(place(boxPiece(0.022, y1 - y0 + 0.04, 0.012), 0, (y0 + y1) * 0.5, z + 0.004));
  }
  return L;
}

// ===========================================================================
// Front, rear and sides
// ===========================================================================

/** Map a lamp's (u across, v up) outline into the body's (x, y) at one end. */
function lampQuad(d, x0, x1, y0, y1, sweep = 0, tuck = 0) {
  const hw = d.hwMax;
  return [
    [x0 * hw, y0], [x1 * hw, y0 + sweep], [(x1 - tuck) * hw, y1 + sweep], [x0 * hw, y1],
  ];
}

function frontEnd(d, B, hi) {
  const st = d.st, hw = d.hwMax, wr = d.wr;
  const yN = d.yNose;
  const yChin = rockerBotAt(d, d.zF0) + 0.01;
  const nu = hi ? 8 : 3, nv = hi ? 4 : 1;

  // ---- headlamps --------------------------------------------------------
  const hl = {
    swept: { x: [0.37, 0.945], y: [yN - 0.105, yN + 0.025], sweep: 0.035, tuck: 0.08 },
    slim: { x: [0.42, 0.95], y: [yN - 0.06, yN + 0.025], sweep: 0.035, tuck: 0.07 },
    square: { x: [0.45, 0.93], y: [yN - 0.15, yN + 0.0], sweep: 0, tuck: 0.02 },
  }[st.head] || { x: [0.42, 0.96], y: [yN - 0.09, yN + 0.02], sweep: 0.02, tuck: 0.04 };
  const head = projectedPatch(d, lampQuad(d, hl.x[0], hl.x[1], hl.y[0], hl.y[1], hl.sweep, hl.tuck), nu, nv, 'front', { lift: 0.004, dome: 0.006 });
  pair(B.lHead, head);
  // A black bezel along the top and bottom of each lamp, so it sits IN the
  // body. Not round the outer end: out there the wing turns to face sideways,
  // and a thin strip projected along z onto a side-facing surface smears into
  // a long sliver down the wing.
  if (hi) {
    const f = projectedFrame(d, lampQuad(d, hl.x[0], Math.min(0.9, hl.x[1]), hl.y[0], hl.y[1], hl.sweep, hl.tuck), 0.006, 'front', 0.002);
    pair(B.plastic, f[0]); pair(B.plastic, f[1]); pair(B.plastic, f[2]);
  }
  // Indicators: an amber strip under the headlamp, kept off the corner for
  // the same reason.
  const ind = projectedPatch(d, lampQuad(d, hl.x[0] + (hl.x[1] - hl.x[0]) * 0.4, 0.88, hl.y[0] - 0.03, hl.y[0] - 0.008, hl.sweep * 0.5, 0), hi ? 5 : 2, 1, 'front', { lift: 0.004, dome: 0.002 });
  B.lIndR.push(ind); B.lIndL.push(mirror(ind));

  // ---- grille -----------------------------------------------------------
  const gx = hl.x[0] - 0.03;
  let grille;
  if (st.grille === 'shield') grille = [[-gx * hw, yN - 0.26], [gx * hw, yN - 0.26], [gx * hw, yN + 0.005], [-gx * hw, yN + 0.005]];
  else if (st.grille === 'mesh') grille = [[-gx * 0.7 * hw, yN - 0.09], [gx * 0.7 * hw, yN - 0.09], [gx * 0.8 * hw, yN - 0.015], [-gx * 0.8 * hw, yN - 0.015]];
  else if (st.grille === 'bars') grille = [[-gx * hw, yN - 0.17], [gx * hw, yN - 0.17], [gx * hw, yN - 0.005], [-gx * hw, yN - 0.005]];
  else grille = [[-gx * 0.92 * hw, yN - 0.14], [gx * 0.92 * hw, yN - 0.14], [gx * hw, yN - 0.008], [-gx * hw, yN - 0.008]];
  const gp = projectedPatch(d, grille, hi ? 8 : 4, hi ? 3 : 1, 'front', { lift: 0.003, dome: 0 });
  // The atlas: honeycomb in the top half, slats in the bottom.
  const slats = st.grille === 'bars' || st.grille === 'shield' || st.grille === 'wide';
  for (let i = 0; i < gp.uv.length; i += 2) { gp.uv[i] *= 2.2; gp.uv[i + 1] = (slats ? 0 : 0.5) + gp.uv[i + 1] * 0.5; }
  B.grille.push(gp);
  if (hi) {
    const frameB = st.trim === 'chrome' || st.grille === 'shield' ? B.chrome : B.plastic;
    for (const f of projectedFrame(d, grille, 0.012, 'front', 0.007)) frameB.push(f);
  }

  // ---- lower bumper: intake, splitter, fog lamps -------------------------
  // All plastic below the bumper line, and all of it forward of carDamage's
  // front-bumper line, so it comes off with the bumper.
  const iy0 = yChin + 0.04, iy1 = Math.min(yN - 0.17, yChin + (d.style === 'sports' || d.style === 'coupe' ? 0.2 : 0.17));
  const intake = [[-0.62 * hw, iy0], [0.62 * hw, iy0], [0.7 * hw, iy1], [-0.7 * hw, iy1]];
  // Wide patches keep a few segments even at low detail: across a curved
  // bumper, two segments cut into the body and show as black teeth.
  B.plastic.push(projectedPatch(d, intake, hi ? 8 : 6, 1, 'front', { lift: 0.004, dome: 0 }));
  // The lip under the nose: a black band standing a couple of centimetres
  // proud of the bumper and following its curve. (A straight plate stuck out
  // past the corners like a snow plough; one projected down to the chin was
  // clamped into a saw-tooth.)
  B.plastic.push(projectedPatch(d, [[-0.8 * hw, yChin + 0.004], [0.8 * hw, yChin + 0.004], [0.8 * hw, yChin + 0.024], [-0.8 * hw, yChin + 0.024]], hi ? 16 : 8, 1, 'front', { lift: 0.022, dome: 0 }));
  if (hi && (d.style === 'sedan' || d.style === 'suv' || d.style === 'pickup' || d.style === 'hatch')) {
    const fog = projectedPatch(d, [[0.62 * hw, iy0 + 0.012], [0.76 * hw, iy0 + 0.018], [0.76 * hw, iy0 + 0.052], [0.62 * hw, iy0 + 0.048]], 3, 1, 'front', { lift: 0.006, dome: 0.003 });
    pair(B.lHead, fog);
  }

  // ---- badge ----------------------------------------------------------------
  // Every car wears one. It also keeps the chrome bucket from ever being ALL
  // tailpipe: carDamage splits a bucket only when it holds two kinds of part,
  // and a car whose only chrome was its exhaust could never lose it.
  if (hi) {
    const by = (grille[0][1] + grille[3][1]) * 0.5;
    const [yy, zz] = projectEnd(d, 'front', 0, by);
    const badge = cyl(0.034, 0.034, 0.012, 20);
    B.chrome.push(place(badge, 0, yy, zz - 0.009, Math.PI * 0.5, 0, 0));
  }

  // ---- plate --------------------------------------------------------------
  if (hi) {
    const pw = Math.min(0.52, hw * 0.58), ph = pw * 0.23;
    const py = Math.min(iy1 - ph * 0.5 - 0.005, yN - 0.14);
    const pz = projectEnd(d, 'front', 0, py)[1] - 0.012;
    B.plate.push(plateQuad(pw, ph, py, pz, true, B.plateRow));
  }
}

function plateQuad(w, h, y, z, front, row) {
  const g = new THREE.PlaneGeometry(w, h);
  if (front) g.rotateY(Math.PI);
  g.translate(0, y, z);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (1 - (row + 1) / 4) + uv.getY(i) * 0.25);
  return fromGeometry(g);
}

function rearEnd(d, B, hi) {
  const st = d.st, hw = d.hwMax;
  const yT = d.yTail;
  const yChin = rockerBotAt(d, d.zR0) + 0.01;
  const nu = hi ? 8 : 3, nv = hi ? 4 : 1;

  // ---- tail lamps -----------------------------------------------------------
  // Each cluster is split into running, brake, reverse and indicator lenses —
  // separate buckets because each lights on its own — laid side by side on the
  // same projected surface so they read as one lamp.
  let x0, x1, y0, y1, sweep = 0;
  // A pickup's lamps sit on the tailgate corners below the rail: any higher and
  // their wrap runs forward over the open bed.
  if (st.tail === 'tall' && st.bed) { x0 = 0.8; x1 = 0.97; y0 = yT - 0.36; y1 = yT - 0.07; }
  else if (st.tail === 'tall') { x0 = 0.74; x1 = 0.975; y0 = yT - (st.cargo ? 0.44 : 0.34); y1 = yT - 0.035; }
  else if (st.tail === 'bar') { x0 = 0.50; x1 = 0.975; y0 = yT - 0.09; y1 = yT + 0.03; sweep = 0.012; }
  else { x0 = 0.42; x1 = 0.975; y0 = yT - 0.13; y1 = yT + 0.035; sweep = 0.02; }
  const Q = (u0, u1, v0, v1) => {
    const X = (u) => lerp(x0, x1, u) * hw, Y = (u, v) => lerp(y0, y1, v) + sweep * u;
    return [[X(u0), Y(u0, v0)], [X(u1), Y(u1, v0)], [X(u1), Y(u1, v1)], [X(u0), Y(u0, v1)]];
  };
  const opt = { lift: 0.004, dome: 0.005 };
  if (st.tail === 'tall') {
    pair(B.lTail, projectedPatch(d, Q(0, 1, 0.55, 1), 2, nv, 'rear', opt));
    pair(B.lBrake, projectedPatch(d, Q(0, 1, 0.30, 0.55), 2, 1, 'rear', opt));
    pair(B.lRev, projectedPatch(d, Q(0, 1, 0.15, 0.30), 2, 1, 'rear', opt));
    const ind = projectedPatch(d, Q(0, 1, 0, 0.15), 2, 1, 'rear', opt);
    B.lIndR.push(ind); B.lIndL.push(mirror(ind));
  } else {
    pair(B.lTail, projectedPatch(d, Q(0.18, 1, 0.45, 1), nu, nv, 'rear', opt));
    pair(B.lBrake, projectedPatch(d, Q(0.18, 1, 0.22, 0.45), nu, 1, 'rear', opt));
    pair(B.lRev, projectedPatch(d, Q(0, 0.18, 0.22, 1), 2, 2, 'rear', opt));
    const ind = projectedPatch(d, Q(0.18, 1, 0, 0.22), nu, 1, 'rear', opt);
    B.lIndR.push(ind); B.lIndL.push(mirror(ind));
  }
  if (st.tail === 'bar' && hi) {
    // A light bar across the tail between the clusters. It spans the
    // centreline, which carDamage reads as "not one of the four tracked lamps",
    // so it survives a smash exactly like the high-level brake light does.
    const bx = x0 * hw - 0.01;
    B.lTail.push(projectedPatch(d, [[-bx, y1 - 0.02], [bx, y1 - 0.02], [bx, y1 - 0.004], [-bx, y1 - 0.004]], 10, 1, 'rear', { lift: 0.004, dome: 0 }));
  }

  // ---- lower bumper: diffuser, plate, exhausts ------------------------------
  const dy1 = yChin + (d.style === 'sports' || d.style === 'coupe' ? 0.16 : 0.12);
  const diff = [[-0.76 * hw, yChin + 0.006], [0.76 * hw, yChin + 0.006], [0.8 * hw, dy1], [-0.8 * hw, dy1]];
  B.plastic.push(projectedPatch(d, diff, hi ? 14 : 6, hi ? 2 : 1, 'rear', { lift: 0.006, dome: 0 }));
  if (hi && (d.style === 'sports' || d.style === 'coupe')) {
    for (const x of [-0.3, -0.1, 0.1, 0.3]) {
      const zf = projectEnd(d, 'rear', x * hw, yChin + 0.03)[1];
      B.plastic.push(place(boxPiece(0.012, dy1 - yChin, 0.10), x * hw, (yChin + dy1) * 0.5 - 0.005, zf - 0.03));
    }
  }
  if (hi) {
    const pw = Math.min(0.52, hw * 0.58), ph = pw * 0.23;
    const py = Math.max(dy1 + ph * 0.5 + 0.02, Math.min(y0 - ph * 0.5 - 0.02, (dy1 + y0) * 0.5));
    const pz = projectEnd(d, 'rear', 0, py)[1] + 0.008;
    B.plate.push(plateQuad(pw, ph, py, pz, false, B.plateRow));
  }
  if (hi) {
    const [yy, zz] = projectEnd(d, 'rear', 0, yT - 0.03);
    B.chrome.push(place(cyl(0.03, 0.03, 0.01, 20), 0, yy, zz + 0.008, Math.PI * 0.5, 0, 0));
  }
  if (st.bed && hi) {
    // A step bumper across the back, and the tailgate handle: plastic, and
    // behind carDamage's rear-bumper line, so both leave with the bumper.
    const zb = projectEnd(d, 'rear', 0, yChin + 0.08)[1];
    B.plastic.push(place(rbox(hw * 1.9, 0.11, 0.16, 0.02, null, 1), 0, yChin + 0.055, zb + 0.05));
    const [yh, zh] = projectEnd(d, 'rear', 0, yT - 0.09);
    B.plastic.push(place(rbox(0.2, 0.035, 0.03, 0.01, null, 1), 0, yh, zh + 0.008));
  }
  const tips = { single: [0.55], twin: [-0.55, 0.55], quad: [-0.62, -0.46, 0.46, 0.62] }[st.exhaust] || [0.55];
  const er = d.style === 'sports' ? 0.042 : 0.035;
  for (const u of tips) {
    const x = u * hw, y = yChin + 0.035;
    // The lathe runs along x; turning it -90 degrees about y lays that along
    // +z, so the rolled lip ends up at the open, rearward end.
    const z = projectEnd(d, 'rear', x, y + 0.03)[1] + 0.008;
    const seg = hi ? 14 : 8;
    const tip = lathe([[er, -0.07], [er, 0.02], [er * 0.86, 0.022], [er * 0.84, -0.03]], seg);
    B.chrome.push(place(tip, x, y, z, 0, -Math.PI * 0.5, 0));
    if (hi) B.plastic.push(place(fromGeometry(new THREE.CircleGeometry(er * 0.84, seg)), x, y, z - 0.02));
  }
}

function sides(d, B, hi) {
  const st = d.st, wr = d.wr;
  // ---- mirrors ------------------------------------------------------------
  // Plastic, outboard of 0.8 of the half width and near the A-pillar base:
  // exactly the window carDamage looks in to find them. One piece each, the
  // stalk included, so the whole mirror leaves together.
  const mz = d.cabF + (st.cargo ? 0.10 : 0.16);
  const K = sectionKeys(d, mz, 0, []);
  const my = K[13] + 0.07, mx = K[12];
  const housing = rbox(0.19, 0.11, 0.085, 0.03, null, hi ? 2 : 1);
  place(housing, mx + 0.13, my + 0.02, mz + 0.035, 0, -0.12, 0);
  const stalk = strut(mx - 0.01, my - 0.04, mz + 0.02, mx + 0.09, my + 0.005, mz + 0.03, 0.035, 0.03, 0.008);
  pair(B.plastic, merge2(housing, stalk));

  if (hi) {
    // ---- door handles: paint, so they leave with the door ------------------
    const hy = d.yBelt - 0.075;
    const zs = st.doors === 4 ? [lerp(d.roofF, d.roofR, 0.44) - 0.13, d.zAxleR - d.archLen - 0.16] : [lerp(d.roofR, d.cabR, 0.05) - 0.12];
    if (st.cargo) zs.push(d.zAxleR - d.archLen - 0.22);
    for (const z of zs) {
      const x = sideX(d, z, hy);
      if (x <= 0) continue;
      pair(B.paint, place(rbox(0.018, 0.022, 0.14, 0.009, null, 1), x + 0.002, hy, z));
    }
    // ---- side repeaters on the front wings ---------------------------------
    const rz = d.zAxleF + d.archLen + 0.08, ry = sectionKeys(d, rz, 0, [])[11] - 0.03;
    const rx = sideX(d, rz, ry);
    const rep = place(rbox(0.01, 0.018, 0.05, 0.006, null, 1), rx + 0.001, ry, rz);
    B.lIndR.push(rep); B.lIndL.push(mirror(rep));
    // ---- wipers -------------------------------------------------------------
    const K0 = sectionKeys(d, d.cabF - 0.03, 0, []);
    for (const x of [-0.35, 0.18]) {
      const wy = K0[19] + 0.012;
      B.plastic.push(strut(x * d.hwMax, wy, d.cabF - 0.04, (x + 0.5) * d.hwMax, wy + 0.06, d.cabF + 0.1, 0.012, 0.01, 0.003));
    }
    // ---- shark-fin antenna ---------------------------------------------------
    if (!st.cargo && !st.rails) {
      const az = d.roofR - 0.05;
      const fin = rbox(0.05, 0.05, 0.16, 0.02, null, 1);
      B.plastic.push(place(fin, 0, d.yRoof - 0.012, az, 0.2, 0, 0));
    }
  }

  // ---- sills, cladding ---------------------------------------------------------
  if (st.skirts || st.cladding) {
    const z0 = d.zAxleF + d.archLen + 0.03, z1 = d.zAxleR - d.archLen - 0.03;
    const y = d.yRocker + 0.03;
    const x = sideX(d, (z0 + z1) * 0.5, y + 0.02);
    const skirt = rbox(0.03, 0.06, z1 - z0, 0.012, null, 1);
    pair(B.plastic, place(skirt, x + 0.004, y, (z0 + z1) * 0.5));
  }
  if (st.cladding) {
    // Black arch mouldings: the off-roader tell, and the reason a scuffed
    // SUV still looks tidy.
    for (const za of [d.zAxleF, d.zAxleR]) {
      const n = hi ? 16 : 8, R = 2, C = n + 1;
      const P = new Float64Array(R * C * 3);
      for (let i = 0; i < C; i++) {
        const th = (i / n) * Math.PI;
        const z = za - d.archLen * Math.cos(th);
        const y = archCut(d, z);
        const x = sideX(d, z, y + 0.03) + 0.012;
        const ny = Math.sin(th), nz = -Math.cos(th);
        const w = 0.07;
        const o0 = i * 3, o1 = (C + i) * 3;
        P[o0] = x; P[o0 + 1] = y - 0.004; P[o0 + 2] = z;
        P[o1] = x - 0.004; P[o1 + 1] = y + ny * w; P[o1 + 2] = z + nz * w * 0.9;
      }
      const G = makeGrid(P, R, C, false, (x, y, z, nx) => nx);
      const cells = [];
      for (let i = 0; i < n; i++) cells.push([0, i]);
      pair(B.plastic, emit(G, cells));
    }
  }

  // ---- roof rails, roof spoiler, rear wing -----------------------------------
  if (st.rails) {
    const z0 = d.roofF + 0.12, z1 = d.roofR - 0.05;
    const x = d.hwRoof * 0.8, y = d.yRoof + 0.035;
    const rail = strut(x, y, z0, x, y, z1, 0.025, 0.022, 0.009);
    const f0 = place(rbox(0.035, 0.04, 0.06, 0.012, null, 1), x, y - 0.02, z0);
    const f1 = place(rbox(0.035, 0.04, 0.06, 0.012, null, 1), x, y - 0.02, z1);
    pair(B.plastic, merge2(merge2(rail, f0), f1));
  }
  if (st.roofSpoiler) {
    const z = d.roofR + 0.015, y = canopyTop(d, canopyLines(d), d.roofR) - 0.005;
    B.plastic.push(place(rbox(d.hwRoof * 1.85, 0.03, 0.14, 0.012, null, hi ? 2 : 1), 0, y, z, -0.12, 0, 0));
  }
  // ---- the high-level brake light -------------------------------------------
  // On the centreline, which carDamage reads as not one of the four tracked
  // lamps, so like the first version's it survives every smash.
  {
    const w = Math.min(0.34, d.hwRoof * 0.5);
    if (st.cargo) {
      B.lBrake.push(place(rbox(w, 0.03, 0.02, 0.008, null, 1), 0, d.yRoof - d.wr * 0.3, d.zR0 + 0.008));
    } else {
      const L = canopyLines(d);
      const z = Math.min(d.roofR + 0.1, lerp(d.roofR, d.cabR, 0.3));
      const y = canopyTop(d, L, z), dy = canopyTop(d, L, z + 0.03) - y;
      const tilt = Math.atan2(-dy, 0.03);
      B.lBrake.push(place(rbox(w, 0.014, 0.05, 0.006, null, 1), 0, y + 0.004, z, tilt, 0, 0));
    }
  }
  if (st.spoiler) {
    // Paint, and separate components standing above the deck behind the rear
    // glass: carDamage finds a sports car's wing by exactly that description,
    // and takes the uprights with it.
    const z = d.zR0 - 0.17;
    const yDeck = topY(d, z, d.hwMax * 0.55);
    const span = d.hwMax * 1.72;
    const wing = rbox(span, 0.028, 0.2, 0.012, null, 1);
    B.paint.push(place(wing, 0, yDeck + 0.17, z + 0.02, -0.1, 0, 0));
    for (const s of [-1, 1]) {
      B.paint.push(place(rbox(0.02, 0.17, 0.1, 0.008, null, 1), s * d.hwMax * 0.56, yDeck + 0.08, z + 0.02));
    }
  }
  if (st.bed) {
    // Bed-rail caps and a tailgate handle.
    const z0 = d.cabR + 0.07, z1 = d.zRear - 0.1;
    const K2 = sectionKeys(d, (z0 + z1) * 0.5, 0, []);
    const rail = rbox(0.06, 0.018, z1 - z0, 0.008, null, 1);
    pair(B.plastic, place(rail, K2[12] - 0.02, K2[13] + 0.008, (z0 + z1) * 0.5));
  }
}

/** Two pieces as one, without welding — for parts that must leave together. */
function merge2(a, b) {
  const na = a.pos.length / 3;
  const idx = new Uint32Array(a.idx.length + b.idx.length);
  idx.set(a.idx); for (let i = 0; i < b.idx.length; i++) idx[a.idx.length + i] = b.idx[i] + na;
  const cat = (x, y) => { const o = new Float32Array(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
  return piece(cat(a.pos, b.pos), cat(a.nrm, b.nrm), cat(a.uv, b.uv), idx);
}

// ===========================================================================
// The cabin
// ===========================================================================

/**
 * Seats, dash and a driver, because an empty car looks wrong.
 *
 * Everything is sized to the headroom actually available where it sits. The
 * first cut sized seats by legroom and put them at a fixed height, and in a
 * car with a 0.97 m roof the headrests stood a hand's width out through it —
 * the "ears" on every sports car in the lineup.
 */
function cabin(d, B, hi) {
  const st = d.st;
  const L = canopyLines(d);
  const K = sectionKeys(d, (d.cabF + d.cabR) * 0.5, 0, []);
  const inner = K[12] - 0.07;                      // inside of the door cards
  const floor = d.tubs[0].floor;
  const roofEnd = st.cargo ? d.cabR : d.roofR;
  const seatX = inner * 0.5;
  const cloth = st.seat;
  const P = B.interior;
  const beltAt = (z) => sectionKeys(d, z, 0, _K)[13];
  // The underside of the roof above a point, allowing for its thickness.
  const ceilingAt = (z) => canopyTop(d, L, z) - 0.035;

  // A seated body, measured from the head: cushion 0.74 m below the eyes
  // at most, never through the floor, headrest never through the roof.
  const seatAt = (z) => {
    const yB = beltAt(z), ceil = ceilingAt(z);
    const headY = Math.min(ceil - 0.15, yB + (ceil - yB) * 0.55);
    const cushY = Math.max(floor + 0.07, headY - 0.74);
    return { headY, cushY, yB, ceil };
  };

  // Dash: a padded top across the car at the local window line — on a wedge
  // that is well below the belt at the doors — with the binnacle in front of
  // the driver.
  const dz1 = d.dashEnd + 0.06;
  const dashTop = Math.min(beltAt(dz1) + 0.02, ceilingAt(dz1) - 0.12);
  // Start the dash only where the windscreen has risen clear of it at the
  // A-pillars — on a steep wedge the glass at the cowl is below the dash top,
  // and a dash that ran all the way forward stood out through it.
  let dz0 = d.cabF + 0.02;
  for (let z = d.cabF + 0.02; z < dz1 - 0.12; z += 0.01) {
    dz0 = z;
    const [, yr] = canopyRail(d, L, z);
    if (yr > dashTop + 0.025) break;
  }
  P.push(place(rbox(inner * 2, 0.16, dz1 - dz0, 0.05, 0x1b1c1f, hi ? 2 : 1), 0, dashTop - 0.08, (dz0 + dz1) * 0.5));
  if (hi) P.push(place(rbox(0.3, 0.07, 0.12, 0.03, 0x121314, 1), -seatX, dashTop + 0.02, dz1 - 0.06));

  // Front seats.
  const headZ = lerp(d.roofF, roofEnd, st.cargo ? 0.5 : 0.30);
  const backZ = headZ + 0.13;
  const F = seatAt(headZ);
  const seat = (x, z, S, lean = 0.2, width = 0.46) => {
    const backH = Math.max(0.3, S.headY - 0.1 - S.cushY);
    if (hi) P.push(place(rbox(width, 0.12, 0.48, 0.05, cloth, 1), x, S.cushY, z - 0.24));
    P.push(place(rbox(width, backH, 0.13, 0.05, cloth, hi ? 2 : 1), x, S.cushY + backH * 0.5 + 0.03, z, lean, 0, 0));
    P.push(place(rbox(0.24, 0.14, 0.09, 0.04, cloth, 1), x, S.headY + 0.01, z + 0.07, 0.15, 0, 0));
  };
  for (const s of [-1, 1]) seat(s * seatX, backZ, F);

  // Rear bench, where there is room for one under the roof: a bench placed
  // by legroom alone ended up beneath a sedan's backlight with its headrests
  // standing through the glass.
  const rearBack = Math.min(backZ + 0.82, roofEnd - 0.1);
  if ((st.doors === 4 || d.style === 'coupe') && !st.cargo && rearBack - backZ > 0.52) {
    const R = seatAt(rearBack - 0.1);
    const backH = Math.max(0.3, R.headY - 0.1 - R.cushY);
    P.push(place(rbox(inner * 1.9, backH, 0.14, 0.05, cloth, hi ? 2 : 1), 0, R.cushY + backH * 0.5 + 0.03, rearBack, 0.22, 0, 0));
    if (hi) for (const s of [-1, 1]) P.push(place(rbox(0.22, 0.13, 0.09, 0.04, cloth, 1), s * seatX, R.headY + 0.0, rearBack + 0.07, 0.18, 0, 0));
  }
  if (hi) P.push(place(rbox(0.2, 0.12, 0.5, 0.03, 0x17181b, 1), 0, F.cushY + 0.02, backZ - 0.35));

  // The driver: left-hand drive, by convention.
  const dx = -seatX, headY = F.headY;
  const torsoH = Math.max(0.28, headY - 0.16 - F.cushY);
  P.push(place(rbox(0.38, torsoH, 0.22, 0.08, 0x31445e, hi ? 2 : 1), dx, F.cushY + torsoH * 0.5 + 0.02, backZ - 0.09, -0.12, 0, 0));
  P.push(place(sphere(0.105, hi ? 14 : 8, hi ? 10 : 6, 0xc08a6a), dx, headY, backZ - 0.11));
  P.push(place(sphere(0.11, hi ? 14 : 8, hi ? 6 : 4, 0x2a1d14), dx, headY + 0.025, backZ - 0.095));
  if (!hi) return;
  // Steering wheel, and the arms reaching for it.
  const wz = dz1 + 0.12, wy = dashTop - 0.03;
  const rim = fromGeometry(new THREE.TorusGeometry(0.18, 0.018, 6, 20), 0x141517);
  P.push(place(rim, dx, wy, wz, Math.PI * 0.5 - 0.35, 0, 0));
  for (const s of [-1, 1]) {
    P.push(strut(dx + s * 0.17, headY - 0.18, backZ - 0.12, dx + s * 0.13, wy + 0.04, wz + 0.04, 0.07, 0.07, 0.03, 0x31445e));
  }
}

// ===========================================================================
// Wheels
// ===========================================================================
//
// Built for the RIGHT side, outer face toward +x. The left wheels wear the
// same rim mirrored (scale.x = -1 on the rim and caliper meshes only — the tyre
// is symmetric, and carDamage rewrites the tyre's scale to squash it flat).

function tyreGeometry(d, segs, hi) {
  const hx = d.tyreW * 0.5, R = d.wr, rr = d.rimR, sw = R - rr;
  const prof = hi ? [
    [rr + 0.004, -hx * 0.80], [rr + sw * 0.30, -hx * 0.97], [rr + sw * 0.62, -hx * 1.00],
    [R - sw * 0.16, -hx * 0.95], [R - 0.007, -hx * 0.84], [R, -hx * 0.70],
    [R + 0.002, -hx * 0.25], [R + 0.002, hx * 0.25],
    [R, hx * 0.70], [R - 0.007, hx * 0.84], [R - sw * 0.16, hx * 0.95],
    [rr + sw * 0.62, hx * 1.00], [rr + sw * 0.30, hx * 0.97], [rr + 0.004, hx * 0.80],
  ] : [
    [rr, -hx * 0.85], [rr + sw * 0.6, -hx], [R - 0.01, -hx * 0.86], [R, -hx * 0.55],
    [R, hx * 0.55], [R - 0.01, hx * 0.86], [rr + sw * 0.6, hx], [rr, hx * 0.85],
  ];
  const v = hi ? [0, 0.1, 0.18, 0.25, 0.3, 0.34, 0.45, 0.55, 0.66, 0.7, 0.75, 0.82, 0.9, 1] : null;
  return lathe(prof, segs, { v });
}

/** Spoke layouts: [count, width at hub, width at rim, twist, pairing]. */
const SPOKES = {
  twin5: { n: 10, w0: 0.030, w1: 0.020, pair: 0.13 },
  ten: { n: 10, w0: 0.028, w1: 0.024, pair: 0 },
  five: { n: 5, w0: 0.060, w1: 0.070, pair: 0 },
  six: { n: 6, w0: 0.050, w1: 0.052, pair: 0 },
  y6: { n: 6, w0: 0.040, w1: 0.018, pair: 0, y: true },
  mesh: { n: 16, w0: 0.016, w1: 0.012, pair: 0, twist: 0.35 },
  steel: { n: 8, w0: 0.075, w1: 0.075, pair: 0, steel: true },
};

function rimGeometry(d, segs) {
  const st = d.st, W = st.wheel;
  const hx = d.tyreW * 0.5, rr = d.rimR;
  const finish = W.finish;
  const parts = [];
  // Lip and barrel: a polished lip you can see, and the inside of the barrel
  // behind the spokes, which is what gives an alloy its depth.
  const lip = lathe([
    [rr * 1.05, hx * 0.80], [rr * 1.035, hx * 0.90], [rr * 0.975, hx * 0.88],
    [rr * 0.94, hx * 0.72], [rr * 0.92, hx * 0.40], [rr * 0.90, -hx * 0.75],
  ], segs);
  parts.push(tint(lip, finish, 1.12));
  // Brake disc and its hat, dark iron, set well back.
  const xd = -hx * 0.08;
  const disc = lathe([[rr * 0.86, xd - 0.011], [rr * 0.86, xd + 0.011], [rr * 0.36, xd + 0.011], [rr * 0.34, hx * 0.36], [rr * 0.2, hx * 0.36]], segs);
  parts.push(tint(disc, 0x5d6166));
  // Hub and centre cap.
  const xh = hx * 0.50;
  const hub = lathe([[rr * 0.27, xh - 0.02], [rr * 0.27, xh], [rr * 0.2, xh + 0.006], [rr * 0.08, xh + 0.012], [0.0005, xh + 0.013]], segs);
  parts.push(tint(hub, finish));
  // Lug nuts.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const nut = cyl(0.009, 0.009, 0.014, 6, false);
    place(nut, xh + 0.006, Math.cos(a) * rr * 0.17, Math.sin(a) * rr * 0.17, 0, 0, Math.PI * 0.5);
    parts.push(tint(nut, 0x9aa0a8));
  }
  // Spokes: tapered, dished toward the hub, each a front face and two sides.
  const S = SPOKES[W.spokes] || SPOKES.ten;
  const r0 = rr * 0.25, r1 = rr * 0.925;
  const xRim = hx * 0.70, xHubS = xh - 0.004, dish = hx * 0.16, th = 0.022;
  const spoke = (a0, w0, w1, twist, rA = r0, rB = r1) => {
    const seg = 4, pos = [], nrm = [], idx = [];
    const ring = [];
    for (let k = 0; k <= seg; k++) {
      const t = k / seg, r = lerp(rA, rB, t);
      const x = lerp(xHubS, xRim, t) - dish * Math.sin(Math.PI * t) * 0.6;
      const a = a0 + twist * t;
      const hw = lerp(w0, w1, t) * 0.5 / r;
      ring.push([r, x, a - hw, a + hw]);
    }
    const P3 = (r, x, a) => [x, Math.cos(a) * r, Math.sin(a) * r];
    // Each quad is turned to face AWAY from the spoke's own centre line, so a
    // side wall is never back-face culled into a see-through slot.
    const quad = (p0, p1, p2, p3, ref) => {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const cx = (p0[0] + p2[0]) * 0.5 - ref[0], cy = (p0[1] + p2[1]) * 0.5 - ref[1], cz = (p0[2] + p2[2]) * 0.5 - ref[2];
      const flip = nx * cx + ny * cy + nz * cz < 0;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const b = pos.length / 3;
      for (const p of [p0, p1, p2, p3]) pos.push(p[0], p[1], p[2]);
      for (let i = 0; i < 4; i++) nrm.push(nx, ny, nz);
      if (flip) idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (let k = 0; k < seg; k++) {
      const [ra, xa, la, ha] = ring[k], [rb, xb, lb, hb] = ring[k + 1];
      const ref = P3((ra + rb) * 0.5, (xa + xb) * 0.5 - th * 0.5, (la + ha + lb + hb) * 0.25);
      quad(P3(ra, xa, la), P3(ra, xa, ha), P3(rb, xb, hb), P3(rb, xb, lb), ref);               // face
      quad(P3(ra, xa - th, la), P3(ra, xa, la), P3(rb, xb, lb), P3(rb, xb - th, lb), ref);     // side
      quad(P3(ra, xa, ha), P3(ra, xa - th, ha), P3(rb, xb - th, hb), P3(rb, xb, hb), ref);     // side
    }
    const pc = piece(Float32Array.from(pos), Float32Array.from(nrm), new Float32Array(pos.length / 3 * 2), Uint32Array.from(idx));
    return tint(pc, finish);
  };
  for (let i = 0; i < S.n; i++) {
    const base = (i / S.n) * TAU + (S.pair ? (i % 2 ? S.pair : -S.pair) * 0.5 : 0);
    if (S.y) {
      parts.push(spoke(base, S.w0 * 1.1, S.w0, 0, r0, rr * 0.55));
      for (const s of [-1, 1]) parts.push(spoke(base, S.w0 * 0.8, S.w1, s * 0.34, rr * 0.55, r1));
    } else {
      parts.push(spoke(base, S.w0, S.w1, S.twist || 0));
    }
  }
  if (S.steel) {
    // A steel wheel: the "spokes" are the web between the slots, capped by a
    // plain hubcap.
    const cap = lathe([[rr * 0.62, xh - 0.01], [rr * 0.6, xh + 0.012], [rr * 0.3, xh + 0.022], [0.0005, xh + 0.024]], segs);
    parts.push(tint(cap, 0xd6dade));
  }
  let pc = parts[0];
  for (let i = 1; i < parts.length; i++) pc = merge2c(pc, parts[i]);
  return pc;
}

/** merge2 that keeps vertex colours. */
function merge2c(a, b) {
  const m = merge2(a, b);
  if (a.col || b.col) {
    const na = a.pos.length / 3, nb = b.pos.length / 3;
    const col = new Float32Array((na + nb) * 3).fill(1);
    if (a.col) col.set(a.col);
    if (b.col) col.set(b.col, na * 3);
    m.col = col;
  }
  return m;
}

function caliperGeometry(d) {
  const hx = d.tyreW * 0.5, rr = d.rimR;
  const xd = -hx * 0.08;
  const n = 6, a0 = 0.35, a1 = 1.35;            // radians from +y toward +z: trailing, high
  const ri = rr * 0.6, ro = rr * 0.9, x0 = xd + 0.014, x1 = xd + 0.05;
  const R = n + 1;
  const P = new Float64Array(R * 5 * 3);
  // A closed loop section (inner-back, inner-front, outer-front, outer-back)
  // swept round the arc.
  for (let i = 0; i < R; i++) {
    const a = lerp(a0, a1, i / n), ca = Math.cos(a), sa = Math.sin(a);
    const sec = [[ri, x0], [ri, x1], [ro, x1], [ro, x0], [ri, x0]];
    for (let k = 0; k < 5; k++) {
      const o = (i * 5 + k) * 3, [r, x] = sec[k];
      P[o] = x; P[o + 1] = r * ca; P[o + 2] = r * sa;
    }
  }
  // Outward is away from the middle of the section, in (x, radius).
  const xm = (x0 + x1) * 0.5, rm = (ri + ro) * 0.5;
  const G = makeGrid(P, R, 5, false, (x, y, z, nx, ny, nz) => {
    const r = Math.hypot(y, z) || 1;
    return (x - xm) * nx + (r - rm) * (ny * y + nz * z) / r;
  });
  const cells = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) cells.push([i, k]);
  let pc = faceNormalsFlat(emit(G, cells));
  // Close both ends of the arc.
  for (const [a, s] of [[a0, -1], [a1, 1]]) {
    const ca = Math.cos(a), sa = Math.sin(a);
    const q = [[x0, ri], [x1, ri], [x1, ro], [x0, ro]].map(([x, r]) => [x, r * ca, r * sa]);
    const pos = Float32Array.from(q.flat());
    const tx = 0, ty = -sa * s, tz = ca * s;                  // along the arc, outward at this end
    const nrm = new Float32Array([tx, ty, tz, tx, ty, tz, tx, ty, tz, tx, ty, tz]);
    pc = merge2(pc, orient(piece(pos, nrm, new Float32Array(8), Uint32Array.from([0, 1, 2, 0, 2, 3]))));
  }
  return tint(pc, d.st.wheel.caliper);
}

/** Re-cut a piece so every triangle has its own flat normal — hard edges. */
function faceNormalsFlat(pc) {
  const idx = pc.idx, n = idx.length;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const s = idx[t + k] * 3;
      pos[(t + k) * 3] = pc.pos[s]; pos[(t + k) * 3 + 1] = pc.pos[s + 1]; pos[(t + k) * 3 + 2] = pc.pos[s + 2];
    }
    const a = t * 3, b = a + 3, c = a + 6;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) { nrm[a + k * 3] = nx / l; nrm[a + k * 3 + 1] = ny / l; nrm[a + k * 3 + 2] = nz / l; }
  }
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return piece(pos, nrm, uv, out);
}

function wheelGeometry(d, detail) {
  if (detail === 'low') {
    // One draw call per wheel: tyre and both faces in one mesh, textured from
    // the low atlas. The tyre samples the atlas corner, which is rubber.
    const tyre = tyreGeometry(d, 16, false);
    for (let i = 0; i < tyre.uv.length; i += 2) { tyre.uv[i] = 0.02; tyre.uv[i + 1] = 0.02; }
    const hx = d.tyreW * 0.5;
    const faces = [];
    for (const s of [-1, 1]) {
      const f = fromGeometry(new THREE.CircleGeometry(d.rimR * 1.02, 16));
      place(f, s * hx * 0.84, 0, 0, 0, s * Math.PI * 0.5, 0);
      faces.push(f);
    }
    return { wheel: toGeometry(merge2(merge2(tyre, faces[0]), faces[1])) };
  }
  const segs = 36;
  // In front of the spokes and behind the polished lip, so at speed the lip
  // still rings the smeared face.
  const blur = fromGeometry(new THREE.CircleGeometry(d.rimR * 0.96, 36), d.st.wheel.finish);
  place(blur, d.tyreW * 0.5 * 0.76, 0, 0, 0, Math.PI * 0.5, 0);
  return {
    tyre: toGeometry(tyreGeometry(d, segs, true)),
    rim: toGeometry(rimGeometry(d, segs)),
    caliper: toGeometry(caliperGeometry(d)),
    blur: toGeometry(blur),
  };
}

// ===========================================================================
// Assembly
// ===========================================================================

const BUCKETS = [
  'paint', 'glass', 'glassDark', 'chrome', 'plastic', 'grille', 'interior', 'plate',
  'lHead', 'lTail', 'lBrake', 'lRev', 'lIndL', 'lIndR',
];
// Buckets that carry vertex colours.
const COLOURED = new Set(['interior']);
// Draw calls are the budget that matters once there are dozens of cars, so low
// detail folds fourteen body meshes into eight. Anything mapped to null is cut.
const FOLD = {
  glassDark: 'glass', chrome: 'plastic', grille: 'plastic', plate: null, lBrake: 'lTail', lRev: null,
};
// What the automatic level of detail hides once a car is far enough away that
// it cannot be seen: the dash and seats behind tinted glass, the grille infill.
// Nothing carDamage splits is ever on this list.
const COSMETIC = new Set(['interior', 'grille']);

/** A smooth hump over [a, b], 1 in the middle and 0 at both ends. */
const hump = (y, a, b) => (y <= a || y >= b ? 0 : Math.sin(Math.PI * (y - a) / (b - a)));

/**
 * How far the straight frame is pushed along z at a point. Three things:
 *
 *   SWEEP  the middle of each bumper stands proud of its corners, so the ends
 *          are bowed in plan rather than sliced off flat.
 *   RAKE   above the bumper line the face leans back — the grille and lamps
 *          toward the bonnet, the tail panel toward the boot lid. A vertical
 *          end face is the single biggest reason a lofted car looks like a box.
 *   BULGE  the bumper itself stands a couple of centimetres proud of the face
 *          above it, which is what draws the bumper line across the car.
 */
function bendOffset(d, x, y, z) {
  const q = Math.min(1, (x / d.hwMax) * (x / d.hwMax));
  let dz = 0;
  const Lf = d.fo * 0.85, Lr = d.ro * 0.85;
  if (z < d.zF0 + Lf) dz -= d.sweepF * (1 - q) * smooth(d.zF0 + Lf, d.zF0, z);
  if (z > d.zR0 - Lr) dz += d.sweepR * (1 - q) * smooth(d.zR0 - Lr, d.zR0, z);
  const tf = smooth(d.zF0 + d.tipF, d.zF0, z);
  if (tf > 0) dz += tf * (d.rakeF * smooth(d.yBumpF, d.yNose + 0.06, y) - d.bulgeF * hump(y, d.yChinF, d.yBumpF + 0.03));
  const tr = smooth(d.zR0 - d.tipR, d.zR0, z);
  if (tr > 0) dz -= tr * (d.rakeR * smooth(d.yBumpR, d.yTail + 0.06, y) - d.bulgeR * hump(y, d.yChinR, d.yBumpR + 0.03));
  return dz;
}

/**
 * Bend the straight frame into the real one (see bendOffset). Normals are
 * carried through the same map by the inverse transpose of its Jacobian,
 * taken numerically, so the shading bends with the surface.
 */
function bend(d, pc) {
  const p = pc.pos, n = pc.nrm, h = 1e-3;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const dz = bendOffset(d, x, y, z);
    if (dz === 0 && bendOffset(d, x, y, z + h) === 0 && bendOffset(d, x, y, z - h) === 0) continue;
    const a = (bendOffset(d, x + h, y, z) - bendOffset(d, x - h, y, z)) / (2 * h);
    const c = (bendOffset(d, x, y + h, z) - bendOffset(d, x, y - h, z)) / (2 * h);
    let b = 1 + (bendOffset(d, x, y, z + h) - bendOffset(d, x, y, z - h)) / (2 * h);
    if (Math.abs(b) < 1e-3) b = 1e-3;
    p[i + 2] = z + dz;
    const nx = n[i], ny = n[i + 1], nz = n[i + 2];
    const mx = nx - (a / b) * nz, my = ny - (c / b) * nz, mz = nz / b;
    const l = Math.hypot(mx, my, mz) || 1;
    n[i] = mx / l; n[i + 1] = my / l; n[i + 2] = mz / l;
  }
}

function toGeometry(pc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pc.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(pc.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(pc.uv, 2));
  if (pc.col) g.setAttribute('color', new THREE.BufferAttribute(pc.col, 3));
  g.setIndex(new THREE.BufferAttribute(pc.idx, 1));
  g.computeBoundingSphere();
  return g;
}

function mergeBucket(list, coloured) {
  let nv = 0, ni = 0;
  for (const pc of list) { nv += pc.pos.length / 3; ni += pc.idx.length; }
  if (!ni) return null;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = coloured ? new Float32Array(nv * 3).fill(1) : null;
  const idx = new Uint32Array(ni);
  let v = 0, k = 0;
  for (const pc of list) {
    const n = pc.pos.length / 3;
    pos.set(pc.pos, v * 3); nrm.set(pc.nrm, v * 3); uv.set(pc.uv, v * 2);
    if (col && pc.col) col.set(pc.col, v * 3);
    for (let i = 0; i < pc.idx.length; i++) idx[k + i] = pc.idx[i] + v;
    v += n; k += pc.idx.length;
  }
  return toGeometry(piece(pos, nrm, uv, idx, col));
}

function geometryFor(style, spec, detail, plateRow, variant) {
  const key = `${style}|${variant.key}|${spec.wheelbase.toFixed(2)}|${spec.track.toFixed(2)}|` +
    `${spec.wheelRadius.toFixed(2)}|${spec.rideHeight.toFixed(2)}|${detail}|${plateRow}`;
  const hit = kit.geom.get(key);
  if (hit) return hit;

  const hi = detail !== 'low';
  const d = dimensions(style, spec, variant.st);
  const B = { plateRow };
  for (const b of BUCKETS) B[b] = [];
  buildShell(d, B, hi);
  buildCanopy(d, B, hi);
  frontEnd(d, B, hi);
  rearEnd(d, B, hi);
  sides(d, B, hi);
  cabin(d, B, hi);

  for (const b of BUCKETS) for (const pc of B[b]) bend(d, pc);

  if (!hi) {
    for (const [from, to] of Object.entries(FOLD)) {
      if (to) B[to] = B[to].concat(B[from]);
      B[from] = [];
    }
  }

  const entry = { d, wheel: wheelGeometry(d, detail) };
  for (const b of BUCKETS) entry[b] = mergeBucket(B[b], COLOURED.has(b));

  // The contact shadow's quad, sized to the footprint plus a soft margin.
  const sw = d.hwMax * 2 + 0.5, sl = (d.zRear - d.zFront) + 0.6;
  const sg = new THREE.PlaneGeometry(sw, sl);
  sg.rotateX(-Math.PI * 0.5);
  sg.translate(0, 0, (d.zFront + d.zRear) * 0.5);
  entry.shadow = sg;
  kit.geom.set(key, entry);
  return entry;
}

// ===========================================================================
// createCarModel
// ===========================================================================

/**
 * How a colour is painted. White is a solid, non-metallic paint — give it
 * metalness and it turns into a grey smear; black is a deep gloss; greys and
 * silvers are genuinely metallic; everything else is a metallic colour.
 */
function paintFinish(hex, mat) {
  const hsl = _c.setHex(hex).getHSL({});
  if (hsl.l > 0.8 && hsl.s < 0.25) { mat.metalness = 0.0; mat.roughness = 0.34; }
  else if (hsl.l < 0.14) { mat.metalness = 0.3; mat.roughness = 0.26; }
  else if (hsl.s < 0.16) { mat.metalness = 0.72; mat.roughness = 0.32; }
  else { mat.metalness = 0.42; mat.roughness = 0.3; }
  mat.userData.finish = { metalness: mat.metalness, roughness: mat.roughness, lum: luminance(_c.setHex(hex)) };
}

const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Fire takes the shine off paint. render/carDamage.js cooks a burning car by
 * pulling the paint COLOUR toward soot and leaves everything else alone, and
 * with a mirror-finish clearcoat that read as a freshly polished black car
 * rather than a husk. How far the colour has fallen below its clean value is
 * how charred the panel is, so the clearcoat and gloss follow it down. A
 * repair puts the colour back and the finish comes back with it.
 */
function charFinish(mat) {
  const f = mat.userData.finish;
  if (!f) return;
  const k = f.lum > 0.03 ? clamp((f.lum - luminance(mat.color)) / (f.lum - 0.01), 0, 1) : 0;
  mat.clearcoat = 1 - 0.92 * k;
  mat.roughness = lerp(f.roughness, 0.85, k);
  mat.metalness = lerp(f.metalness, 0.1, k);
}

const _cam = new THREE.Vector3(), _car = new THREE.Vector3();
// Past this, the cabin and grille infill cannot be resolved and are hidden.
// Hysteresis so a car idling at the boundary does not flicker.
const LOD_FAR = 38, LOD_NEAR = 33;

/**
 * Build one car. `spec` is a physics spec from vehicles/catalog.js — body,
 * colour, wheelbase, track, wheelRadius and rideHeight are all read from it, so
 * the model is always the size of the car being simulated.
 *
 * opts: { colour, detail: 'high' | 'low' }
 */
export function createCarModel(spec = {}, opts = {}) {
  const style = BODY_STYLES.includes(spec.body) ? spec.body : 'sedan';
  const detail = opts.detail === 'low' ? 'low' : 'high';
  const seed = hash(`${spec.id || style}:${spec.name || ''}`);
  const K = acquireKit();
  // Low detail drops the plates, so letting the plate row into the cache key
  // there would stash four identical geometry sets instead of one.
  const variant = variantOf(style, hash(`${spec.id || style}:${spec.name || ''}:look`));
  const geo = geometryFor(style, defaults(spec), detail, detail === 'low' ? 0 : seed % 4, variant);
  const d = geo.d;
  const env = K.tex.env;

  // Paint is per car because every car is a different colour.
  const colour = opts.colour ?? spec.colour ?? 0xb8bcc0;
  const paint = new THREE.MeshPhysicalMaterial({
    color: colour, metalness: 0.4, roughness: 0.3,
    clearcoat: 1, clearcoatRoughness: 0.05, envMap: env,
  });
  paintFinish(colour, paint);
  paint.userData.seams = d.seams;
  paint.onBeforeCompile = patchPaint;
  paint.customProgramCacheKey = PAINT_KEY;

  const lamp = {};
  for (const [name, [tint, glow, rough, metal, graphic]] of Object.entries(LAMPS)) {
    const tex = K.tex[graphic] || null;
    lamp[name] = envMaterial(THREE.MeshStandardMaterial, {
      color: tint, emissive: glow, emissiveIntensity: 0, roughness: rough, metalness: metal,
      map: tex, emissiveMap: tex,
    }, env);
  }
  const matFor = (b) => (b === 'paint' ? paint : lamp[b] || K.mats[b]);

  const group = new THREE.Group();
  group.name = `car:${spec.id || style}`;

  // The level-of-detail switch goes FIRST among the children: the renderer
  // visits children in order and calls update() on anything that isLOD, so
  // visiting it before the meshes it hides means the switch takes effect on
  // this frame rather than the next.
  const lod = new THREE.LOD();
  lod.name = 'lod';
  const cosmetic = [];
  let near = true;
  lod.update = (camera) => {
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _car.setFromMatrixPosition(group.matrixWorld);
    const dist = _cam.distanceTo(_car) / (camera.zoom || 1);
    const want = near ? dist < LOD_FAR : dist < LOD_NEAR;
    if (want === near) return;
    near = want;
    for (let i = 0; i < cosmetic.length; i++) cosmetic[i].visible = near;
    if (!near) for (let i = 0; i < blurs.length; i++) blurs[i].visible = false;
  };
  group.add(lod);

  const chassis = new THREE.Group();
  group.add(chassis);

  let triangles = 0;
  const shadowy = new Set(['paint', 'chrome', 'plastic']);
  for (const b of BUCKETS) {
    const g = geo[b];
    if (!g) continue;
    const mesh = new THREE.Mesh(g, matFor(b));
    mesh.castShadow = shadowy.has(b);
    mesh.name = b;
    chassis.add(mesh);
    triangles += g.index.count / 3;
    if (detail === 'high' && COSMETIC.has(b)) cosmetic.push(mesh);
  }
  const paintMesh = chassis.getObjectByName('paint');
  // Once a frame, while this car is on screen: pick up the sky for every
  // car's reflections, and follow the damage renderer's soot with the gloss.
  // Compare-and-skip, so an undamaged car does three float compares.
  let lastR = -1, lastG = -1, lastB = -1;
  if (paintMesh) {
    paintMesh.onBeforeRender = (renderer, scene) => {
      updateEnv(scene);
      const c = paint.color;
      if (c.r !== lastR || c.g !== lastG || c.b !== lastB) {
        lastR = c.r; lastG = c.g; lastB = c.b;
        charFinish(paint);
      }
    };
  }

  // ---- contact shadow -------------------------------------------------------
  const SHADOW_ALPHA = 0.62;
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, map: K.tex.shadow, transparent: true, opacity: SHADOW_ALPHA,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const shadow = new THREE.Mesh(geo.shadow, shadowMat);
  shadow.name = 'contactShadow';
  shadow.renderOrder = -1;
  shadow.visible = !!K.tex.shadow;
  group.add(shadow);
  // The road ribbon is drawn 4 cm above the physics ground (render/roads.js),
  // so the shadow sits just above that or the road would cover it.
  const SHADOW_LIFT = 0.047;

  // ---- wheels -------------------------------------------------------------
  // Rotation order YXZ so steer (y) is applied OUTSIDE spin (x); with the
  // default XYZ the wheel would corkscrew as it turned.
  const wheels = [];
  const calipers = [];
  const blurs = [];
  // Per car, because its opacity follows this car's wheel speed.
  const blurMat = detail === 'high' ? envMaterial(THREE.MeshStandardMaterial, {
    color: 0xffffff, map: K.tex.blur, vertexColors: true, transparent: true, opacity: 0,
    depthWrite: false, roughness: 0.35, metalness: 0.7,
  }, env) : null;
  const restY = d.yWheel;
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Object3D();
    w.rotation.order = 'YXZ';
    w.name = ['FL', 'FR', 'RL', 'RR'][i];
    const left = i % 2 === 0;
    w.position.set((left ? -0.5 : 0.5) * d.tr, restY, (i < 2 ? -0.5 : 0.5) * d.wb);
    const parts = detail === 'low'
      ? [['wheel', K.mats.wheelLow]]
      : [['tyre', K.mats.rubber], ['rim', K.mats.rim], ['caliper', K.mats.caliper]];
    for (const [part, mat] of parts) {
      const g = geo.wheel[part];
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.name = part;
      m.castShadow = part !== 'caliper';
      // Mirror the rim and caliper onto the left side. Never the tyre: it is
      // symmetric, and carDamage owns its scale for flats.
      if (left && (part === 'rim' || part === 'caliper')) m.scale.x = -1;
      w.add(m);
      triangles += g.index.count / 3;
      if (part === 'caliper') { calipers.push(m); cosmetic.push(m); }
    }
    if (blurMat && geo.wheel.blur) {
      const b = new THREE.Mesh(geo.wheel.blur, blurMat);
      b.name = 'blur';
      b.castShadow = false;
      b.visible = false;
      if (left) b.scale.x = -1;
      w.add(b);
      blurs.push(b);
    }
    group.add(w);
    wheels.push(w);
  }

  // ---- live state ---------------------------------------------------------
  const state = { brake: 0, head: false, rev: false, ind: 0, dead: false };
  // Golden-ratio stride off the build counter: two cars from the same spec —
  // which is every traffic car — still blink out of step.
  const blinkPhase = ((seed % 977) / 977 + (instances++) * 0.6180339887) % 1;

  function applyTail() {
    const running = state.head ? 0.45 : 0;
    lamp.lTail.emissiveIntensity = Math.max(running, state.brake * 1.5);
    lamp.lBrake.emissiveIntensity = state.brake * 2.6;
  }

  function setSteer(rad) {
    // Yaw grows counter-clockwise, so a RIGHT-positive steer angle is a
    // negative rotation about +Y. Same sign convention as physics/vehicle.js.
    wheels[0].rotation.y = -rad;
    wheels[1].rotation.y = -rad;
  }

  // How far the wheels turned since the last call, smoothed: one call a frame
  // is how main.js drives every car, so this is radians per frame.
  let lastSpin = NaN, spinRate = 0;

  function setWheelSpin(rad) {
    // + = rolling forward. Rolling forward carries the front of the wheel
    // downward, which is a negative rotation about +X. The calipers are bolted
    // to the upright, not the wheel, so they are turned back by the same amount
    // — which leaves them steering and riding the suspension, but not spinning.
    const a = typeof rad === 'number' ? rad : rad[0];
    if (typeof rad === 'number') {
      for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad;
      for (let i = 0; i < calipers.length; i++) calipers[i].rotation.x = rad;
    } else {
      for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad[i];
      for (let i = 0; i < calipers.length; i++) calipers[i].rotation.x = rad[i];
    }
    // Motion blur. Past ~0.3 rad a frame (a 0.33 m wheel at 21 km/h, 60 fps) a
    // ten-spoke alloy starts to strobe and appears to turn backwards; by 100
    // km/h it moves 1.4 rad a frame, more than two spokes' spacing. A smeared
    // face fades in over the spokes instead, and is not drawn at all below it.
    if (!blurs.length) return;
    if (a === a && lastSpin === lastSpin) spinRate += (Math.min(3, Math.abs(a - lastSpin)) - spinRate) * 0.3;
    lastSpin = a;
    const k = smooth(0.22, 0.6, spinRate);
    blurMat.opacity = k;
    const show = near && k > 0.02;
    for (let i = 0; i < blurs.length; i++) blurs[i].visible = show;
  }

  function setSuspension(comps) {
    const lim = d.archH * 0.55;      // never let a wheel punch through its arch
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const c = clamp(comps[i], -lim, lim);
      wheels[i].position.y = restY + c;
      sum += c;
    }
    // The ground is where the tyres are. When all four hang at full droop the
    // car is in the air, and a shadow glued to its underside would say
    // otherwise, so it fades out over the last five centimetres of droop.
    const mean = sum * 0.25;
    shadow.position.y = -d.rh + mean + SHADOW_LIFT;
    shadowMat.opacity = SHADOW_ALPHA * clamp((mean + 0.115) / 0.05, 0, 1);
  }

  function setBrakeLights(v) { state.brake = clamp(v, 0, 1); applyTail(); }
  function setHeadlights(on) {
    state.head = !!on;
    lamp.lHead.emissiveIntensity = state.head ? 2.4 : 0;
    applyTail();
  }
  function setReverseLights(on) {
    state.rev = !!on;
    lamp.lRev.emissiveIntensity = state.rev ? 2.2 : 0;
  }

  /**
   * dir: -1 left, 1 right, 2 hazard, 0 off. `on` overrides the blink phase if
   * the caller wants to drive it; otherwise each car blinks on its own offset
   * so a queue of traffic does not flash in unison.
   */
  function setIndicator(dir, on = null) {
    state.ind = dir | 0;
    const lit = on === null ? ((now() + blinkPhase) % 0.78) < 0.44 : !!on;
    lamp.lIndL.emissiveIntensity = lit && (state.ind === -1 || state.ind === 2) ? 2.8 : 0;
    lamp.lIndR.emissiveIntensity = lit && (state.ind === 1 || state.ind === 2) ? 2.8 : 0;
  }

  function setPaint(hex) {
    paint.color.setHex(hex);
    paintFinish(hex, paint);
    group.userData.paint = hex;
  }

  function dispose() {
    // Idempotent on purpose: the kit is reference counted, so a second
    // dispose() would decrement it a second time and tear the shared geometry,
    // textures and materials out from under every other car on screen.
    if (state.dead) return;
    state.dead = true;
    group.removeFromParent();
    paint.dispose();
    shadowMat.dispose();
    if (blurMat) blurMat.dispose();
    for (const m of Object.values(lamp)) m.dispose();
    // Geometry and the shared textures belong to the kit, which only tears
    // itself down once the last car has let go of it.
    releaseKit();
  }

  setSuspension([0, 0, 0, 0]);

  const dims = {
    length: d.zRear - d.zFront, width: d.hwMax * 2, height: d.yRoof + d.rh,
    wheelbase: d.wb, track: d.tr, wheelRadius: d.wr,
    front: d.zFront, rear: d.zRear, seat: d.seat,
  };
  // physics/debris.js sizes and colours a torn-off panel from these. It has
  // always looked for them; nothing ever put them there, so every bumper that
  // came off was a mid-size saloon's in the default grey.
  group.userData.dims = dims;
  group.userData.paint = colour;

  return {
    group, wheels, triangles,
    setSteer, setWheelSpin, setSuspension,
    setBrakeLights, setHeadlights, setReverseLights, setIndicator,
    setPaint, dispose,
    // Handy for the camera rig and for anything that needs the car's box.
    dims,
  };
}

/**
 * Build and cache the geometry for these specs now, so the first frame that
 * shows them does not have to.
 *
 * Traffic builds every model it needs on the first frame after Drive — up to
 * fifteen unique cars — and that frame is the one hitch this module adds (830
 * ms against 567 before the makeover, measured the same way). Called from the
 * loading screen, it moves that work behind the progress bar. Optional: skip
 * it and the models build on demand exactly as before.
 *
 * Geometry lives in the shared kit, which tears itself down when the last car
 * is disposed, so call this while at least one car exists (the player's is
 * built first). Returns how many new geometry sets were built.
 */
export function prewarmCarModels(specs = [], opts = {}) {
  const detail = opts.detail === 'low' ? 'low' : 'high';
  acquireKit();
  let built = 0;
  for (const spec of specs) {
    if (!spec) continue;
    const style = BODY_STYLES.includes(spec.body) ? spec.body : 'sedan';
    const seed = hash(`${spec.id || style}:${spec.name || ''}`);
    const variant = variantOf(style, hash(`${spec.id || style}:${spec.name || ''}:look`));
    const before = kit.geom.size;
    geometryFor(style, defaults(spec), detail, detail === 'low' ? 0 : seed % 4, variant);
    if (kit.geom.size > before) built++;
  }
  releaseKit();
  return built;
}

/** Fill in anything the caller's spec left out, so a bare {body} still works. */
function defaults(spec) {
  return {
    wheelbase: spec.wheelbase ?? 2.68,
    track: spec.track ?? 1.58,
    wheelRadius: spec.wheelRadius ?? 0.34,
    rideHeight: spec.rideHeight ?? 0.28,
  };
}
