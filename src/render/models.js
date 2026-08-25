// Imported cars: the glTF pipeline, the rig convention, and the fallback.
//
// render/carModel.js draws a car out of code. This module is the other door:
// drop a .glb into assets/cars/ and the game drives that instead, with the same
// steering, suspension, lighting and damage bindings, because loadCar() hands
// back an object with EXACTLY the interface createCarModel() returns. Nothing
// downstream — main.js, the traffic pool, the damage renderer — is allowed to
// care which door a car came through.
//
// WHY EVERYTHING HERE IS DEFENSIVE
//
// There are no model files in this repo and none can be fetched, so on a clean
// checkout every path through this module ends at `null`. That is not a
// degraded mode, it is the normal one: `null` means "no imported car, use the
// procedural one", and the game is expected to look exactly as it does today.
// A missing asset, a missing loader, a corrupt file, a model with no rig — all
// of them resolve to null and warn once. None of them throw.
//
// GLTFLoader IS NOT VENDORED. vendor/three/addons/ ships environments, math,
// postprocessing, shaders and utils; there is no loaders/ directory at all. So
// the loader is brought in by DYNAMIC import inside a try/catch rather than a
// static import at the top of the file — a static one would fail at parse time
// and take the whole render layer with it, which is the exact opposite of what
// a graceful fallback means. Drop GLTFLoader.js into
// vendor/three/addons/loaders/ and this module starts working with no code
// change; until then it warns once and returns null.
//
// WHAT NORMALISATION HAS TO FIX
//
// Real glTF files are not authored to a game's conventions, so four things are
// measured and corrected at load, once per file, before anything is cached:
//
//   FACING   Half the car models in the world face +Z. The correction is a
//            yaw on a wrapper node, decided from the rig (front bumper vs rear
//            bumper, then headlights vs tail lights, then the wheel labels) and
//            overridable per car.
//   SCALE    Uniform, from the model's measured wheelbase to the spec's, so a
//            model authored in centimetres still sits on the road properly.
//            Never non-uniform: stretching X to hit the spec's track would turn
//            every wheel into an ellipse.
//   DATUM    car.y is the CHASSIS REFERENCE — spec.rideHeight above the contact
//            patches, not the ground. The model is translated so its lowest
//            point lands at y = -rideHeight and the axle midpoint at z = 0,
//            which is where carModel.js puts its origin.
//   COLOUR   colorSpace on every texture, because an export that got it wrong
//            produces a car that is visibly too dark next to a procedural one.
//
// The correction lives on a wrapper Object3D, never baked into the geometry:
// the geometry is shared by every instance of that car, and baking would
// scale the same buffer once per traffic slot.
//
// ZERO ALLOCATION: everything above happens at load. The per-frame setters
// (setSteer, setWheelSpin, setSuspension, the lights) only assign numbers.

import * as THREE from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

// ===========================================================================
// THE RIG CONVENTION
// ===========================================================================
//
// These are the node names a .glb must use. assets/cars/README.md is the
// artist-facing version of this block; the two must say the same thing.
//
// The model FACES -Z. forward = -Z, right = +X, up = +Y. The nose is at
// negative z, the boot at positive z, the driver's side is negative x.
//
// Node names are matched case-insensitively and ignore punctuation, so
// `wheel_FL`, `Wheel.FL` and `WHEEL-FL-001` are all the same node. A name that
// merely STARTS with a rig name also matches (`boot_lid` -> `boot`), which is
// what makes exporter suffixes harmless. No rig name is a prefix of another —
// tools/modelcheck.mjs asserts that, because the moment one is, prefix
// matching becomes ambiguous and a door starts answering to a bumper.
//
// Nothing is mandatory. Every missing node warns once and is then skipped: a
// car with no `spoiler` simply has no spoiler to lose. The one hard rule is
// that a file with no `body` AND fewer than two wheels is not a rig at all,
// and is rejected so the caller falls back to the procedural model.

export const RIG = {
  /** Which way the model points. Not a setting — the convention. */
  facing: '-Z',

  /** The painted shell: everything not listed separately below. */
  body: 'body',

  /**
   * The material the game recolours. If no material is named `paint`, whatever
   * material the `body` node uses is recoloured instead. The car's colour is
   * MULTIPLIED into the material, so a paint material wants a white or very
   * pale base texture, or none at all.
   */
  paintMaterial: 'paint',

  /**
   * Index order is [FL, FR, RL, RR] — the same order damage.js indexes
   * state.tyre, state.suspension and effects.gripScale. Each wheel is
   * re-parented onto a pivot at its own measured centre, so the model's own
   * pivots (which are usually at the origin) do not matter.
   */
  wheel: ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'],

  /** Keys are exactly GLASS from physics/damage.js. */
  glass: {
    windscreen: 'glass_windscreen',
    rear: 'glass_rear',
    sideL: 'glass_sideL',
    sideR: 'glass_sideR',
  },

  /** Keys are exactly LIGHTS from physics/damage.js. */
  light: {
    headL: 'light_headL',
    headR: 'light_headR',
    tailL: 'light_tailL',
    tailR: 'light_tailR',
  },

  /** Keys are exactly DETACHABLE from physics/damage.js. */
  detach: {
    mirrorL: 'mirror_L',
    mirrorR: 'mirror_R',
    frontBumper: 'bumper_front',
    rearBumper: 'bumper_rear',
    bonnet: 'bonnet',
    boot: 'boot',
    doorL: 'door_L',
    doorR: 'door_R',
    exhaust: 'exhaust',
    spoiler: 'spoiler',
  },

  /**
   * Not part of the damage model, but the lighting interface needs somewhere to
   * put the glow. With no brake nodes the tail lamps brighten under braking
   * instead — which is what a single-filament lamp does anyway — so these are
   * genuinely optional. `seat_driver` is an empty marking the driver's eye
   * point for the cockpit camera; without it the point is estimated.
   */
  optional: {
    brakeL: 'light_brakeL',
    brakeR: 'light_brakeR',
    reverseL: 'light_reverseL',
    reverseR: 'light_reverseR',
    indL: 'light_indL',
    indR: 'light_indR',
    seat: 'seat_driver',
  },

  /** Every node name above, flat. Filled in below and frozen with the rest. */
  names: [],
};

const WHEEL_TAG = ['FL', 'FR', 'RL', 'RR'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Node names collapse to letters and digits, so punctuation never matters. */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// The flat lookup table the matcher works from. `key` is how the rest of the
// game addresses a node; `name` is what the artist types.
const CANON = [
  { key: 'body', name: RIG.body },
  ...RIG.wheel.map((name, i) => ({ key: `wheel${WHEEL_TAG[i]}`, name })),
  ...Object.entries(RIG.glass).map(([k, name]) => ({ key: `glass${cap(k)}`, name })),
  ...Object.entries(RIG.light).map(([k, name]) => ({ key: `light${cap(k)}`, name })),
  ...Object.entries(RIG.detach).map(([k, name]) => ({ key: k, name })),
  ...Object.entries(RIG.optional).map(([k, name]) => ({ key: k, name })),
].map((c) => ({ ...c, norm: norm(c.name) }));

RIG.names = CANON.map((c) => c.name);
for (const sub of [RIG.glass, RIG.light, RIG.detach, RIG.optional]) Object.freeze(sub);
Object.freeze(RIG.wheel);
Object.freeze(RIG.names);
Object.freeze(RIG);

// Lamp tints and lit intensities, copied from carModel.js on purpose: an
// imported car and a procedural one in the same mirror have to glow the same
// amount, and two tables that drift apart is how that stops being true.
const LAMP = {
  head: { glow: 0xfff2d6, on: 2.4 },
  tail: { glow: 0xff2418, on: 0.45 },
  brake: { glow: 0xff2b1c, on: 2.6 },
  rev: { glow: 0xffffff, on: 2.2 },
  indL: { glow: 0xff9a12, on: 2.8 },
  indR: { glow: 0xff9a12, on: 2.8 },
};

// Which rig nodes drive which lamp bucket.
const LAMP_NODES = {
  head: ['lightHeadL', 'lightHeadR'],
  tail: ['lightTailL', 'lightTailR'],
  brake: ['brakeL', 'brakeR'],
  rev: ['reverseL', 'reverseR'],
  indL: ['indL'],
  indR: ['indR'],
};

// Texture slots that carry colour a human picked, and slots that carry data.
// An exporter that tags a normal map as sRGB produces lighting that is subtly
// wrong everywhere and obviously wrong nowhere, so both lists are asserted
// rather than trusted.
const SRGB_SLOTS = ['map', 'emissiveMap', 'specularMap', 'specularColorMap', 'sheenColorMap', 'lightMap'];
const DATA_SLOTS = [
  'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap', 'alphaMap',
  'displacementMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'transmissionMap', 'thicknessMap', 'iridescenceMap', 'anisotropyMap',
];

// A body is about 1.62 wheelbases long across every style in carModel.js
// (1.55 for the hatch, 1.70 for the mid-engined sports car). It is only used
// to guess a scale when a model has no wheel nodes to measure, which is
// already a warned-about state.
const LENGTH_PER_WHEELBASE = 1.62;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

// setSuspension wants a resting array once per car, and allocating one per car
// is an allocation per traffic slot for no reason.
const ZERO = [0, 0, 0, 0];

// Scratch, reused by the load-time measurements. Nothing here is reachable from
// a per-frame path, but three's Box3 is expensive enough to be worth not
// rebuilding once per wheel per car anyway.
const _box = new THREE.Box3();
const _vec = new THREE.Vector3();
const _mat = new THREE.Matrix4();

let instances = 0;

/** Fill in anything the caller's spec left out — the same table carModel uses. */
function defaults(spec) {
  const s = spec || {};
  return {
    wheelbase: s.wheelbase ?? 2.68,
    track: s.track ?? 1.58,
    wheelRadius: s.wheelRadius ?? 0.34,
    rideHeight: s.rideHeight ?? 0.28,
  };
}

/** World-space bounds of a node's whole subtree. Ancestors must be up to date. */
function boundsOf(node) {
  _box.makeEmpty();
  _box.expandByObject(node);
  return _box;
}

function centreOf(node, out) {
  return boundsOf(node).getCenter(out);
}

/** Every material used anywhere under `node`, deduplicated. */
function materialsUnder(node, into) {
  node.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (const one of m) if (one) into.add(one); }
    else into.add(m);
  });
  return into;
}

// ===========================================================================
// createModelLibrary
// ===========================================================================

/**
 * The asset library. One per game.
 *
 * opts:
 *   basePath        where bare names resolve to. Default 'assets/cars/'.
 *   loaderModule    specifier to dynamic-import. Default the three.js addon.
 *   loader          a ready-made loader instance, which skips the import
 *                   entirely. This is how a DRACO- or KTX2-configured loader is
 *                   wired in, and how tools/modelcheck.mjs drives the pipeline
 *                   with no loader on disk.
 *   configureLoader called with a freshly imported loader, for the same job
 *                   when the import IS available.
 *   fetch           injected so the harness can run the whole path with no
 *                   server. Defaults to the global fetch.
 *   specFor         id -> physics spec, so loadCar(id) can size a car without
 *                   the caller repeating itself. main.js passes the catalogue's.
 *   facing          'auto' | '-Z' | '+Z' | radians. Default 'auto'.
 *   scale           forces the uniform scale instead of measuring it.
 *   anisotropy      applied to every texture. Default 1.
 *   castShadow      default true; glass and lamp lenses never cast regardless.
 *   warn            default console.warn.
 *
 * facing, scale and colour can also be given per car, as the last argument to
 * load(), loadCar() and asset.create().
 */
export function createModelLibrary(opts = {}) {
  const basePath = opts.basePath ?? 'assets/cars/';
  const loaderModule = opts.loaderModule ?? 'three/addons/loaders/GLTFLoader.js';
  const anisotropy = opts.anisotropy ?? 1;
  const shadows = opts.castShadow !== false;
  const warnFn = opts.warn ?? ((msg) => console.warn(msg));
  const fetchFn = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  // url -> Promise<asset|null>. The promise, not the asset, is what is cached:
  // two cars asking for the same file on the same frame must share one load,
  // not race each other into two.
  const pending = new Map();
  const byId = new Map();
  const warned = new Set();
  let loaderPromise = null;
  let dead = false;

  function warnOnce(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
    warnFn(`[open road] ${msg}`);
  }

  /**
   * Bare names live under basePath; anything that already names a path does
   * not. The basePath test is what stops the obvious mistake of passing the
   * full 'assets/cars/lark.glb' and getting 'assets/cars/assets/cars/lark.glb'.
   */
  function resolveUrl(url) {
    if (/^(?:[a-z]+:|\/|\.{1,2}\/)/i.test(url)) return url;
    if (basePath && url.startsWith(basePath)) return url;
    return basePath + url;
  }

  /**
   * Resolve the loader once, ever. A failure here is cached as `null` so a
   * hundred cars produce one warning rather than a hundred rejected imports.
   */
  function getLoader() {
    if (loaderPromise) return loaderPromise;
    if (opts.loader) {
      loaderPromise = Promise.resolve(opts.loader);
      return loaderPromise;
    }
    loaderPromise = import(loaderModule)
      .then((mod) => {
        const Ctor = mod.GLTFLoader || mod.default;
        if (typeof Ctor !== 'function') throw new Error(`${loaderModule} has no GLTFLoader export`);
        const loader = new Ctor();
        if (opts.configureLoader) opts.configureLoader(loader);
        return loader;
      })
      .catch((err) => {
        warnOnce('loader', `no glTF loader (${loaderModule}: ${err.message}) — ` +
          'imported cars are off, the procedural models are being used instead');
        return null;
      });
    return loaderPromise;
  }

  /**
   * Read a file into a glTF result, or null.
   *
   * The fetch happens here rather than inside the loader so that a 404 can be
   * told apart from a corrupt file: an absent asset is the expected state and
   * says nothing, a present-but-unreadable one is an artist's problem and says
   * so loudly.
   */
  async function readGltf(url) {
    const loader = await getLoader();
    if (!loader) return null;
    const dir = url.slice(0, url.lastIndexOf('/') + 1);

    if (typeof loader.parse === 'function' && fetchFn) {
      let buffer = null;
      try {
        const res = await fetchFn(url);
        if (!res || !res.ok) return null;
        buffer = await res.arrayBuffer();
      } catch {
        return null;                       // unreachable file: same as absent
      }
      return await new Promise((done) => {
        try {
          loader.parse(buffer, dir, done, (err) => {
            warnOnce(`parse:${url}`, `${url} is not a readable glTF: ${err && err.message}`);
            done(null);
          });
        } catch (err) {
          warnOnce(`parse:${url}`, `${url} is not a readable glTF: ${err.message}`);
          done(null);
        }
      });
    }

    if (typeof loader.load !== 'function') return null;
    return await new Promise((done) => {
      try {
        loader.load(url, done, undefined, () => done(null));
      } catch {
        done(null);
      }
    });
  }

  /**
   * Load and normalise one file. Resolves to the asset record — which is a
   * superset of { scene, rig } — or to null if the file is absent, unreadable,
   * or carries no rig this game can drive.
   *
   * One .glb is one car, so the cache key is the url alone and the first spec
   * to ask for a file is the one it gets sized to.
   */
  function load(url, spec = null, per = null) {
    if (dead) return Promise.resolve(null);
    const resolved = resolveUrl(url);
    const hit = pending.get(resolved);
    if (hit) {
      if (spec && spec.wheelbase) {
        hit.then((asset) => {
          if (asset && Math.abs(asset.spec.wheelbase - spec.wheelbase) > 0.02) {
            warnOnce(`spec:${resolved}`, `${resolved} was already sized to a ` +
              `${asset.spec.wheelbase.toFixed(2)} m wheelbase and is being reused for a ` +
              `${spec.wheelbase.toFixed(2)} m one — give the second car its own file`);
          }
        });
      }
      return hit;
    }

    const job = readGltf(resolved)
      .then((gltf) => {
        if (dead) return null;
        const scene = gltf && (gltf.isObject3D ? gltf : gltf.scene || (gltf.scenes && gltf.scenes[0]));
        if (!scene) return null;
        return buildAsset(scene, resolved, defaults(spec), per || {});
      })
      .catch((err) => {
        warnOnce(`build:${resolved}`, `${resolved} could not be prepared: ${err.message}`);
        return null;
      });
    pending.set(resolved, job);
    return job;
  }

  // -------------------------------------------------------------------------
  // Normalisation
  // -------------------------------------------------------------------------

  /**
   * Which nodes of `root` are which. Exact matches are claimed first across the
   * whole tree, then prefixes, so `boot` never loses to `boot_lid` when both
   * exist. Shortest name wins a prefix contest, because the extra characters
   * are almost always an exporter's suffix on a child of the node we want.
   */
  function findRig(root, url) {
    const byNorm = new Map();
    root.traverse((o) => {
      if (!o.name) return;
      const n = norm(o.name);
      let list = byNorm.get(n);
      if (!list) byNorm.set(n, (list = []));
      list.push(o);
    });

    const rig = {};
    const claimed = new Set();
    for (const c of CANON) {
      const list = byNorm.get(c.norm);
      if (list && list.length && !claimed.has(list[0])) {
        rig[c.key] = list[0];
        claimed.add(list[0]);
      }
    }
    for (const c of CANON) {
      if (rig[c.key]) continue;
      let best = null, bestLen = Infinity;
      for (const [n, list] of byNorm) {
        if (n.length >= bestLen || !n.startsWith(c.norm)) continue;
        const pick = list.find((o) => !claimed.has(o));
        if (pick) { best = pick; bestLen = n.length; }
      }
      if (best) { rig[c.key] = best; claimed.add(best); }
    }

    const absent = [];
    for (const c of CANON) {
      if (rig[c.key]) rig[c.key].userData.rigKey = c.key;
      else { rig[c.key] = null; absent.push(c.name); }
    }
    if (absent.length) {
      // Capped, because a file that matched nothing at all would otherwise
      // print the entire convention back at the reader, and the useful part of
      // this message is the count.
      const shown = absent.slice(0, 8).join(', ') +
        (absent.length > 8 ? `, and ${absent.length - 8} more` : '');
      warnOnce(`rig:${url}`, `${url} has no ${shown} (${absent.length} of ${CANON.length}) — ` +
        'those parts cannot be lit, opened or knocked off. See assets/cars/README.md');
    }
    return rig;
  }

  /**
   * How far to yaw the model so it faces -Z, in radians (0 or PI).
   *
   * Three cues in descending order of trustworthiness, because a car that has
   * been auto-rotated the wrong way is worse than one that was never rotated:
   * bumpers first (unambiguous), then the lamp pairs, then the wheel labels.
   * With no cue at all the convention is assumed and nothing is said, since
   * saying it on every correctly authored model is just noise.
   */
  function chooseYaw(rig, per, url) {
    const want = per.facing ?? opts.facing ?? 'auto';
    if (typeof want === 'number') return want;
    if (want === '-Z') return 0;
    if (want === '+Z') return Math.PI;

    const pairs = [
      ['frontBumper', 'rearBumper'],
      ['lightHeadL', 'lightTailL'],
      ['lightHeadR', 'lightTailR'],
      ['wheelFL', 'wheelRL'],
    ];
    for (const [f, r] of pairs) {
      if (!rig[f] || !rig[r]) continue;
      const zf = centreOf(rig[f], _vec).z;
      const zr = centreOf(rig[r], _vec).z;
      if (Math.abs(zf - zr) < 1e-4) continue;
      if (zf <= zr) return 0;
      warnOnce(`facing:${url}`, `${url} faces +Z (${f} is behind ${r}); rotating it. ` +
        'Author to -Z, or pass facing to remove the guess.');
      return Math.PI;
    }
    return 0;
  }

  /** Wheelbase, track, radius and the axle midpoint, in the current world space. */
  function measureWheels(rig) {
    const x = [0, 0, 0, 0], z = [0, 0, 0, 0], r = [0, 0, 0, 0];
    let found = 0, front = 0, rear = 0, nF = 0, nR = 0, radius = 0;
    for (let i = 0; i < 4; i++) {
      const node = rig[`wheel${WHEEL_TAG[i]}`];
      if (!node) continue;
      const b = boundsOf(node);
      b.getCenter(_vec);
      x[i] = _vec.x; z[i] = _vec.z;
      // The tyre is round in the YZ plane, so its radius is the larger of the
      // two — using height alone under-reads a wheel modelled with a flat spot
      // at the contact patch, which plenty of static renders have.
      r[i] = Math.max(b.max.y - b.min.y, b.max.z - b.min.z) * 0.5;
      radius += r[i];
      found++;
      if (i < 2) { front += _vec.z; nF++; } else { rear += _vec.z; nR++; }
    }
    if (!found) return null;
    const zF = nF ? front / nF : 0, zR = nR ? rear / nR : 0;
    const trackF = rig.wheelFL && rig.wheelFR ? Math.abs(x[0] - x[1]) : 0;
    const trackR = rig.wheelRL && rig.wheelRR ? Math.abs(x[2] - x[3]) : 0;
    const tracks = (trackF ? 1 : 0) + (trackR ? 1 : 0);
    let cx = 0;
    for (let i = 0; i < 4; i++) if (rig[`wheel${WHEEL_TAG[i]}`]) cx += x[i];
    return {
      found,
      wheelbase: nF && nR ? Math.abs(zR - zF) : 0,
      track: tracks ? (trackF + trackR) / tracks : 0,
      radius: radius / found,
      cx: cx / found,
      cz: nF && nR ? (zF + zR) * 0.5 : 0,
      x, z, r,
    };
  }

  /**
   * Turn a loaded scene into the canonical, cached asset: correctly faced,
   * correctly scaled, sitting on the chassis datum, with four wheel pivots and
   * every node tagged so a clone can find itself again.
   */
  function buildAsset(scene, url, spec, per) {
    const root = new THREE.Group();
    root.name = 'car:imported';
    const chassis = new THREE.Group();
    chassis.name = 'chassis';
    chassis.add(scene);
    root.add(chassis);

    const rig = findRig(root, url);
    let wheelCount = 0;
    for (let i = 0; i < 4; i++) if (rig[`wheel${WHEEL_TAG[i]}`]) wheelCount++;
    if (!rig.body && wheelCount < 2) {
      warnOnce(`unrigged:${url}`, `${url} carries no rig this game can drive ` +
        `(no "${RIG.body}", ${wheelCount} of 4 wheels) — falling back to the procedural car. ` +
        'See assets/cars/README.md');
      return null;
    }

    // --- 1. facing -----------------------------------------------------------
    root.updateMatrixWorld(true);

    // A rig with nothing under it — meshes left behind on export, or a file
    // that is only an armature — measures as an EMPTY Box3, whose min is
    // +Infinity and max -Infinity. Two steps below, the datum arithmetic turns
    // that into a NaN chassis position and a dims full of +/-Infinity, which
    // then travels on into the camera rig and the HUD. An invisible car is a
    // fallback; a NaN transform is a broken game. So this is refused like any
    // other unusable file, and the procedural model wins.
    if (boundsOf(root).isEmpty()) {
      warnOnce(`empty:${url}`, `${url} matches the rig but has no geometry under it — ` +
        'falling back to the procedural car. See assets/cars/README.md');
      return null;
    }

    chassis.rotation.y = chooseYaw(rig, per, url);
    root.updateMatrixWorld(true);

    // --- 2. uniform scale, from the measured wheelbase to the spec's ----------
    let m = measureWheels(rig);
    let scale = per.scale ?? opts.scale ?? 0;
    if (!scale) {
      if (m && m.wheelbase > 1e-4) {
        scale = spec.wheelbase / m.wheelbase;
      } else {
        const len = boundsOf(root).getSize(_vec).z;
        scale = len > 1e-4 ? (spec.wheelbase * LENGTH_PER_WHEELBASE) / len : 1;
        warnOnce(`scale:${url}`, `${url} has no front and rear wheels to measure; ` +
          `its scale was guessed from overall length (x${scale.toFixed(3)})`);
      }
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    chassis.scale.setScalar(scale);
    root.updateMatrixWorld(true);

    // --- 3. datum: axle midpoint at the origin, contact patches at -rideHeight
    // The scratch Box3 is clobbered by the next measurement, so the three
    // numbers this step needs come out of it immediately.
    m = measureWheels(rig);
    const whole = boundsOf(root);
    const lowest = whole.min.y;
    const midX = (whole.min.x + whole.max.x) * 0.5;
    const midZ = (whole.min.z + whole.max.z) * 0.5;
    const cx = m ? m.cx : midX;
    const cz = m && m.wheelbase > 1e-4 ? m.cz : midZ;
    chassis.position.set(-cx, -spec.rideHeight - lowest, -cz);
    root.updateMatrixWorld(true);

    m = measureWheels(rig);
    const wheelRadius = m && m.radius > 1e-4 ? m.radius : spec.wheelRadius;
    const track = m && m.track > 1e-4 ? m.track : spec.track;
    if (m && m.found === 4 && m.x[0] > 0) {
      warnOnce(`mirror:${url}`, `${url} has ${RIG.wheel[0]} on the right-hand side; ` +
        'left is -X. Per-corner suspension and tyre damage will appear mirrored.');
    }
    if (Math.abs(track - spec.track) > spec.track * 0.2) {
      warnOnce(`track:${url}`, `${url} is ${track.toFixed(2)} m across the axles but the ` +
        `physics uses ${spec.track.toFixed(2)} m — the wheels will not line up with the tyre marks`);
    }

    // --- 4. wheel pivots -----------------------------------------------------
    // Each wheel node is re-parented onto a pivot AT ITS OWN CENTRE, with the
    // node's accumulated world transform baked into its new local matrix. That
    // is what makes steer, spin and suspension work regardless of where the
    // artist left the model's own pivots — which, in practice, is the origin.
    // Rotation order YXZ so steer (y) is applied outside spin (x); with the
    // default XYZ a steered wheel corkscrews as it rolls.
    const restY = new Float64Array(4);
    const pivots = [];
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Object3D();
      pivot.rotation.order = 'YXZ';
      pivot.name = WHEEL_TAG[i];
      pivot.userData.rigKey = `pivot${WHEEL_TAG[i]}`;
      const node = rig[`wheel${WHEEL_TAG[i]}`];
      if (node) {
        centreOf(node, _vec);
        pivot.position.copy(_vec);
        root.add(pivot);
        pivot.updateMatrixWorld(true);
        _mat.copy(pivot.matrixWorld).invert().multiply(node.matrixWorld);
        node.removeFromParent();
        pivot.add(node);
        _mat.decompose(node.position, node.quaternion, node.scale);
      } else {
        // No node: the pivot still exists so wheels[i] is never a hole, it just
        // has nothing hanging off it. Put it where the spec says the wheel is.
        pivot.position.set((i % 2 ? 0.5 : -0.5) * spec.track,
          spec.wheelRadius - spec.rideHeight, (i < 2 ? -0.5 : 0.5) * spec.wheelbase);
        root.add(pivot);
      }
      restY[i] = pivot.position.y;
      pivots.push(pivot);
    }
    root.updateMatrixWorld(true);

    // --- 5. materials --------------------------------------------------------
    const paint = new Set();
    for (const mat of materialsUnder(root, new Set())) {
      if (norm(mat.name || '').startsWith(norm(RIG.paintMaterial))) paint.add(mat.uuid);
    }
    if (!paint.size && rig.body) {
      for (const mat of materialsUnder(rig.body, new Set())) paint.add(mat.uuid);
    }
    if (!paint.size) {
      warnOnce(`paint:${url}`, `${url} has nothing to recolour — name the body's ` +
        `material "${RIG.paintMaterial}" if you want the game to paint this car`);
    }

    const lamp = new Map();
    for (const [kind, keys] of Object.entries(LAMP_NODES)) {
      for (const key of keys) {
        if (!rig[key]) continue;
        for (const mat of materialsUnder(rig[key], new Set())) {
          // First kind wins. A model that shares one material between the
          // headlights and the tail lights cannot light them separately, and
          // silently lighting both off the brake pedal is the worse failure.
          if (lamp.has(mat.uuid)) {
            warnOnce(`lampshare:${url}`, `${url} shares material "${mat.name || mat.uuid}" ` +
              'between two kinds of lamp; give each lamp its own material');
            continue;
          }
          lamp.set(mat.uuid, kind);
        }
      }
    }

    let skinned = false, triangles = 0;
    const glassKeys = new Set(Object.keys(RIG.glass).map((k) => `glass${cap(k)}`));
    root.traverse((o) => {
      if (o.isSkinnedMesh) skinned = true;
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const g = o.geometry;
      if (g) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      // Glass casts no shadow (it is drawn with depthWrite off, so its shadow
      // would be a solid black slab where the cabin is) and neither do lamp
      // lenses, whose whole job is to emit.
      const key = o.userData.rigKey;
      let seeThrough = glassKeys.has(key);
      if (!seeThrough) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of list) if (mat && lamp.has(mat.uuid)) seeThrough = true;
      }
      o.castShadow = shadows && !seeThrough;
      o.receiveShadow = false;
      fixMaterials(o);
    });

    // --- 6. the numbers the camera rig and the HUD ask for --------------------
    const box = boundsOf(root).clone();
    const dims = {
      length: box.max.z - box.min.z,
      width: box.max.x - box.min.x,
      // Quoted from the ground, like carModel's, and the ground is rideHeight
      // below the origin.
      height: box.max.y + spec.rideHeight,
      wheelbase: m && m.wheelbase > 1e-4 ? m.wheelbase : spec.wheelbase,
      track, wheelRadius,
      front: box.min.z, rear: box.max.z,
      seat: seatPoint(rig, box, spec, track, wheelRadius),
    };

    const asset = {
      url, scene: root, rig: shapeRig(rig, pivots), spec, dims, triangles,
      paint, lamp, skinned, restY,
      create: (carSpec, carOpts) => instantiate(asset, carSpec, carOpts),
    };
    return asset;
  }

  /**
   * Where the driver's eyes are. `seat_driver` is authoritative; without it the
   * point is reconstructed from carModel.js's own seat maths — 0.225 track to
   * the left of centre, on the belt line at 0.58 of the roof height, a shade
   * behind the axle midpoint. That is close enough that the cockpit camera does
   * not visibly jump when a car is swapped for its procedural twin.
   */
  function seatPoint(rig, box, spec, track, wheelRadius) {
    if (rig.seat) {
      rig.seat.getWorldPosition(_vec);
      return { x: _vec.x, y: _vec.y, z: _vec.z };
    }
    return {
      x: -track * 0.225,
      y: box.max.y * 0.58 - wheelRadius * 0.06,
      z: spec.wheelbase * 0.15,
    };
  }

  /** The flat match table, re-shaped into what damage.js indexes by. */
  function shapeRig(flat, pivots) {
    const out = {
      body: flat.body,
      wheel: pivots,
      glass: {}, light: {}, detach: {}, optional: {},
      node: flat,
    };
    for (const k of Object.keys(RIG.glass)) out.glass[k] = flat[`glass${cap(k)}`];
    for (const k of Object.keys(RIG.light)) out.light[k] = flat[`light${cap(k)}`];
    for (const k of Object.keys(RIG.detach)) out.detach[k] = flat[k];
    for (const k of Object.keys(RIG.optional)) out.optional[k] = flat[k];
    return out;
  }

  /**
   * Put every texture in the colour space it belongs in.
   *
   * GLTFLoader gets this right for well-formed glTF, but plenty of files in the
   * wild have been round-tripped through a tool that did not, and the symptom —
   * a car that is a little too dark, or a normal map that looks flat — never
   * points at its cause. Doing it unconditionally costs one traversal at load.
   */
  function fixMaterials(mesh) {
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of list) {
      if (!mat) continue;
      let touched = false;
      for (const slot of SRGB_SLOTS) {
        const t = mat[slot];
        if (!t || !t.isTexture) continue;
        if (t.colorSpace !== THREE.SRGBColorSpace) { t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; touched = true; }
        if (t.anisotropy !== anisotropy) t.anisotropy = anisotropy;
      }
      for (const slot of DATA_SLOTS) {
        const t = mat[slot];
        if (!t || !t.isTexture) continue;
        if (t.colorSpace !== THREE.NoColorSpace) { t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; touched = true; }
        if (t.anisotropy !== anisotropy) t.anisotropy = anisotropy;
      }
      if (touched) mat.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Instantiation
  // -------------------------------------------------------------------------

  /**
   * One car from a loaded asset, with the interface createCarModel() returns.
   *
   * Geometry and every material the game does not drive stay shared with the
   * asset. Only the paint and the lamp materials are cloned, because those are
   * the ones that differ car to car — sharing a lamp material across a traffic
   * queue makes forty cars indicate in unison off one car's stalk.
   */
  function instantiate(asset, carSpec, carOpts) {
    const spec = carSpec || {};
    const per = carOpts || {};
    const group = asset.skinned ? cloneRigged(asset.scene) : asset.scene.clone(true);
    group.name = `car:${spec.id || 'imported'}`;

    const rigFlat = {};
    for (const c of CANON) rigFlat[c.key] = null;
    const wheels = [null, null, null, null];
    const mats = new Map();
    const paintMats = [];
    const lampMats = { head: [], tail: [], brake: [], rev: [], indL: [], indR: [] };

    function localise(src) {
      const kind = asset.lamp.get(src.uuid);
      const isPaint = asset.paint.has(src.uuid);
      if (!kind && !isPaint) return src;
      let copy = mats.get(src.uuid);
      if (!copy) {
        copy = src.clone();
        mats.set(src.uuid, copy);
        if (isPaint) paintMats.push(copy);
        if (kind) {
          lampMats[kind].push(copy);
          if (copy.emissive) {
            // Keep an author's chosen emissive tint; supply one when the
            // material has none, which is the usual case for a lens exported
            // as plain glossy plastic.
            if (copy.emissive.getHex() === 0) copy.emissive.setHex(LAMP[kind].glow);
            copy.emissiveIntensity = 0;
          } else {
            warnOnce(`unlit:${asset.url}`, `${asset.url} lights use a material with no ` +
              'emissive channel — they will not glow. Export lamps as standard or physical materials.');
          }
        }
      }
      return copy;
    }

    group.traverse((o) => {
      const key = o.userData.rigKey;
      if (key) {
        if (key.startsWith('pivot')) wheels[WHEEL_TAG.indexOf(key.slice(5))] = o;
        else rigFlat[key] = o;
      }
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const m = o.material;
      if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) if (m[i]) m[i] = localise(m[i]); }
      else if (m) o.material = localise(m);
    });

    const restY = asset.restY;
    // Never let a wheel travel far enough to punch through its own arch.
    // carModel caps at 0.55 of an arch height, which is 1.14 wheel radii.
    const travel = asset.dims.wheelRadius * 0.6;

    const state = { brake: 0, head: false, rev: false, ind: 0, dead: false };
    // Golden-ratio stride off the build counter, exactly as carModel does it:
    // every traffic car is built from one catalogue entry, so a phase derived
    // from the spec alone puts the whole queue in lockstep.
    const blinkPhase = (instances++ * 0.6180339887) % 1;

    function setEmissive(list, v) {
      for (let i = 0; i < list.length; i++) list[i].emissiveIntensity = v;
    }

    function applyTail() {
      const running = state.head ? LAMP.tail.on : 0;
      // With no dedicated brake lamps this max() is the only thing that lights
      // under braking — which is what a single-filament tail lamp does anyway.
      setEmissive(lampMats.tail, Math.max(running, state.brake * 1.5));
      setEmissive(lampMats.brake, state.brake * LAMP.brake.on);
    }

    function setSteer(rad) {
      // Yaw grows counter-clockwise, so a RIGHT-positive steer angle is a
      // negative rotation about +Y. Same convention as physics/vehicle.js.
      wheels[0].rotation.y = -rad;
      wheels[1].rotation.y = -rad;
    }

    function setWheelSpin(rad) {
      // + = rolling forward, which carries the front of the wheel downward:
      // a negative rotation about +X.
      if (typeof rad === 'number') {
        for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad;
      } else {
        for (let i = 0; i < 4; i++) wheels[i].rotation.x = -rad[i];
      }
    }

    function setSuspension(comps) {
      for (let i = 0; i < 4; i++) wheels[i].position.y = restY[i] + clamp(comps[i], -travel, travel);
    }

    function setBrakeLights(v) { state.brake = clamp(v, 0, 1); applyTail(); }

    function setHeadlights(on) {
      state.head = !!on;
      setEmissive(lampMats.head, state.head ? LAMP.head.on : 0);
      applyTail();
    }

    function setReverseLights(on) {
      state.rev = !!on;
      setEmissive(lampMats.rev, state.rev ? LAMP.rev.on : 0);
    }

    /** dir: -1 left, 1 right, 2 hazard, 0 off. `on` overrides the blink phase. */
    function setIndicator(dir, on = null) {
      state.ind = dir | 0;
      const lit = on === null ? ((now() + blinkPhase) % 0.78) < 0.44 : !!on;
      setEmissive(lampMats.indL, lit && (state.ind === -1 || state.ind === 2) ? LAMP.indL.on : 0);
      setEmissive(lampMats.indR, lit && (state.ind === 1 || state.ind === 2) ? LAMP.indR.on : 0);
    }

    function setPaint(hex) {
      for (let i = 0; i < paintMats.length; i++) paintMats[i].color.setHex(hex);
    }

    function dispose() {
      // Idempotent, and it disposes ONLY what this instance owns. Geometry,
      // textures and every untouched material belong to the cached asset and
      // are still in use by every other car built from the same file.
      if (state.dead) return;
      state.dead = true;
      group.removeFromParent();
      for (const m of mats.values()) m.dispose();
      mats.clear();
    }

    const colour = per.colour ?? spec.colour;
    // Only repaint when a colour was actually asked for: an imported car may
    // carry an authored livery that a default grey would wash straight over.
    if (typeof colour === 'number') setPaint(colour);
    setSuspension(ZERO);

    return {
      group, wheels, triangles: asset.triangles,
      setSteer, setWheelSpin, setSuspension,
      setBrakeLights, setHeadlights, setReverseLights, setIndicator,
      setPaint, dispose,
      dims: asset.dims,
      // What tells a damage renderer where the panels are, and that this car
      // came through the import door rather than out of carModel.js.
      imported: true, url: asset.url, rig: shapeRig(rigFlat, wheels),
    };
  }

  // -------------------------------------------------------------------------
  // The public library
  // -------------------------------------------------------------------------

  /**
   * Load `url` and build one car from it, registered under `id`.
   * Resolves to null whenever the procedural model should be used instead.
   * With no url, `<basePath><id>.glb` is assumed.
   */
  async function loadCar(id, url, spec = null, per = null) {
    const useSpec = spec || (opts.specFor ? opts.specFor(id) : null);
    const asset = await load(url || `${id}.glb`, useSpec, per);
    byId.set(id, asset || null);
    if (!asset) return null;
    return asset.create(useSpec, per);
  }

  /** Has this id got a usable imported model? */
  function has(id) {
    return byId.get(id) != null;
  }

  /**
   * The loaded asset for an id, or null. Call `asset.create(spec, opts)` to
   * build another car from it synchronously — which is how the traffic pool
   * fills forty slots without forty awaits.
   */
  function get(id) {
    return byId.get(id) || null;
  }

  /**
   * Warm the cache. Entries are urls, or { id, url, spec } for anything that
   * should also be reachable through has()/get(). Never rejects.
   */
  async function preload(list = []) {
    const jobs = list.map((entry) => {
      if (typeof entry === 'string') return load(entry);
      const useSpec = entry.spec || (opts.specFor ? opts.specFor(entry.id) : null);
      return load(entry.url || `${entry.id}.glb`, useSpec, entry)
        .then((asset) => { if (entry.id) byId.set(entry.id, asset || null); return asset; });
    });
    const done = await Promise.all(jobs);
    const loaded = done.filter(Boolean).length;
    return { total: list.length, loaded, missing: list.length - loaded };
  }

  /**
   * Tear the whole library down. Every car built from it must already have been
   * disposed — this releases the geometry and textures they were sharing.
   */
  function dispose() {
    dead = true;
    const seen = new Set();
    for (const job of pending.values()) {
      job.then((asset) => {
        if (!asset) return;
        asset.scene.traverse((o) => {
          if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
          const list = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of list) {
            if (!mat || seen.has(mat)) continue;
            seen.add(mat);
            for (const slot of SRGB_SLOTS.concat(DATA_SLOTS)) {
              const t = mat[slot];
              if (t && t.isTexture && !seen.has(t)) { seen.add(t); t.dispose(); }
            }
            mat.dispose();
          }
        });
      }, () => {});
    }
    pending.clear();
    byId.clear();
    warned.clear();
    loaderPromise = null;
  }

  return { load, loadCar, has, get, preload, dispose };
}
