// Trees, rocks and street furniture.
//
// COORDINATE CONVENTION — the same one the physics uses, stated here because
// getting it backwards has already cost this project real time:
//
//   forward = -Z      right = +X      up = +Y
//   a Y rotation of `rot` sends local -Z to world (-sin rot, -cos rot)
//
// The only prop with a front is the streetlight, and its arm is modelled along
// local +Z — i.e. pointing BACKWARD — because layout.js hands us a `rot` whose
// forward direction points away from the carriageway. Local +Z therefore lands
// over the road, which is where a lamp belongs.
//
// WHAT MAKES THIS EXPENSIVE, AND WHAT WAS DONE ABOUT IT
//
// world.props is mostly trees, and the generator scatters tens of thousands of
// candidates to get them. Three things had to be true at once: one draw call
// per species, no per-frame allocation, and no per-frame rebuild of the
// instance buffers. Nothing below scales with the size of world.props once the
// grid is built, so turning the tree density up costs load time and memory but
// not frame time.
//
//   * Draw calls. Trunk and canopy are merged into a single geometry per
//     species and coloured with a vertex attribute, so a species is one
//     InstancedMesh and one material — not one per material slot. Per-instance
//     hue comes from instanceColor, which the shader multiplies into the same
//     vColor, so scale and colour variation cost nothing extra.
//
//   * Culling. Instances are counting-sorted into a grid at load, so every cell
//     owns a CONTIGUOUS run of the source matrix array. Showing the world
//     around the camera is then a couple of hundred run copies into the live
//     instance buffer, not a per-instance distance test over every prop.
//
//   * Rebuild rate. The copy runs with a radius of cull + REBUILD_STEP, so the
//     set stays correct until the camera has moved REBUILD_STEP metres. At
//     100 km/h that is a rebuild roughly every 1.2 s per field, and at most one
//     field rebuilds on any given frame. Between rebuilds update() does nothing
//     but two subtractions per field.
//
// WHY LOW-POLY CANOPIES AND NOT CROSS-BILLBOARDS
//
// Cross-billboards win on triangle count and lose on everything else at speed.
// They need an alpha-tested foliage texture (another thing to generate), they
// shear visibly as you drive past because the two quads are seen edge-on in
// turn, and alpha-test makes them a separate, slower depth path. A twenty-face
// icosahedron is only about sixty triangles once a trunk is attached, holds a
// solid silhouette from every angle, and shades correctly under the sun. With
// the counts kept in the low thousands by distance culling, triangles are not
// the scarce resource here — silhouette and colour variation are, and those are
// exactly what a lit solid gives you and a flat billboard does not.
//
// WHY THE LAMP POOLS ARE FAKE
//
// There are thousands of streetlights. Thousands of real lights is not a frame
// budget question, it is a shader-compile and uniform-limit question — the
// renderer would fall over long before the fill rate did. So a lit lamp is an
// emissive head plus an additive ground decal, and setNight() fades both.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry, clamp, lerp, smoothstep } from '../world/noise.js';

// How far the camera may travel before a field's visible set is stale. Every
// field builds with `radius + REBUILD_STEP`, which is what makes that safe.
const REBUILD_STEP = 34;

/**
 * Grid pitch for a field, from its cull radius.
 *
 * Culling is per cell, so an instance can survive up to a cell diagonal past
 * the radius. That slop is a fixed number of metres, which means a coarse grid
 * that is nearly free for a 450 m tree cull nearly doubles the reach of a
 * 130 m decal cull — measured at 229 m before this was tied to the radius.
 * A seventh of the radius keeps the overshoot around 20% for every field while
 * leaving cells big enough that a refresh copies a few hundred long runs
 * rather than a few thousand short ones.
 */
function cellFor(cull) {
  return clamp(Math.round(cull / 7), 24, 64);
}

// Full-quality cull radii. setQuality() scales these down; the instance buffers
// are sized for the full radius so quality can move freely without reallocating.
const CULL = {
  tree: 450,
  rock: 340,
  light: 330,
  pool: 260,
  shade: 130,
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Scale (uniform unless told otherwise) then translate, in that order. */
function part(geo, x, y, z, sx, sy, sz) {
  if (sx !== undefined) geo.scale(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
  geo.translate(x, y, z);
  return geo;
}

/**
 * Bakes a colour into a geometry, jittered per triangle.
 *
 * Everything here is flat-shaded, so without this a canopy is one uniform
 * green blob and reads as plastic. A few percent of per-face brightness noise
 * costs nothing — the geometry is stored once and instanced — and is the
 * difference between "a green ball" and "foliage" in peripheral vision.
 *
 * Also drops UVs: none of these materials carry a map, and the attribute would
 * otherwise have to survive the merge and sit in VRAM unused.
 */
function paint(geo, hex, jitter, rnd) {
  const g = geo.index === null ? geo : geo.toNonIndexed();
  if (g !== geo) geo.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');

  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color(hex);   // Color converts sRGB hex to the working space
  for (let f = 0; f + 2 < pos.count; f += 3) {
    const k = 1 + (rnd() * 2 - 1) * jitter;
    const r = base.r * k, gg = base.g * k, b = base.b * k;
    for (let v = 0; v < 3; v++) {
      const o = (f + v) * 3;
      col[o] = r; col[o + 1] = gg; col[o + 2] = b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merged(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

// --- Species ---------------------------------------------------------------
// `height` and `spread` are metres at instance scale 1, and are what the
// contact-shadow decal and the caller's spawn clearance are sized from.

function deciduousTree(rnd) {
  const bark = 0x5b4632, leaf = 0x4f7a33;
  return {
    geo: merged([
      paint(part(new THREE.CylinderGeometry(0.16, 0.28, 3.0, 6, 1, true), 0, 1.5, 0), bark, 0.15, rnd),
      paint(part(new THREE.IcosahedronGeometry(2.20, 0), 0, 4.50, 0, 1.15, 0.92, 1.10), leaf, 0.13, rnd),
      paint(part(new THREE.IcosahedronGeometry(1.50, 0), -1.40, 3.60, 0.50), leaf, 0.13, rnd),
      paint(part(new THREE.IcosahedronGeometry(1.35, 0), 1.25, 4.00, -0.65), leaf, 0.13, rnd),
    ]),
    height: 6.5, spread: 3.3, hue: 0.22, sink: 0.18,
  };
}

function coniferTree(rnd) {
  const bark = 0x4a3a2b, needle = 0x2f5537;
  return {
    geo: merged([
      paint(part(new THREE.CylinderGeometry(0.12, 0.22, 2.0, 5, 1, true), 0, 1.0, 0), bark, 0.15, rnd),
      paint(part(new THREE.ConeGeometry(1.85, 3.2, 6, 1, false), 0, 2.60, 0), needle, 0.12, rnd),
      paint(part(new THREE.ConeGeometry(1.40, 2.8, 6, 1, false), 0, 4.20, 0), needle, 0.12, rnd),
      paint(part(new THREE.ConeGeometry(0.90, 2.4, 6, 1, false), 0, 5.70, 0), needle, 0.12, rnd),
    ]),
    height: 6.9, spread: 2.9, hue: 0.10, sink: 0.16,
  };
}

function scrubTree(rnd) {
  const bark = 0x584a34, leaf = 0x6f8b3c;
  return {
    geo: merged([
      paint(part(new THREE.CylinderGeometry(0.10, 0.18, 0.8, 5, 1, true), 0, 0.40, 0), bark, 0.15, rnd),
      paint(part(new THREE.IcosahedronGeometry(1.25, 0), 0, 1.20, 0, 1.35, 0.72, 1.25), leaf, 0.16, rnd),
      paint(part(new THREE.IcosahedronGeometry(0.88, 0), 0.90, 0.95, -0.50, 1.15, 0.78, 1.05), leaf, 0.16, rnd),
    ]),
    height: 2.2, spread: 2.6, hue: 0.26, sink: 0.12,
  };
}

/**
 * A boulder: an icosahedron pushed around by a smooth field.
 *
 * PolyhedronGeometry is already non-indexed, so each corner exists once per
 * face it touches. The displacement therefore has to be a continuous function
 * of DIRECTION and nothing else — anything per-vertex would move the copies of
 * a shared corner apart and tear the shell open.
 */
function rockGeometry(detail, squash, rnd) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  const a = g.getAttribute('position').array;
  const p0 = rnd() * 6.283, p1 = rnd() * 6.283, p2 = rnd() * 6.283;
  const amp = 0.20 + rnd() * 0.16;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    const lobe = Math.sin(x * 3.1 + p0) * Math.cos(z * 2.7 + p1) * 0.6 +
                 Math.sin(y * 4.3 + p2) * 0.4;
    const k = 1 + lobe * amp;
    a[i] = x * k; a[i + 1] = y * k * squash; a[i + 2] = z * k;
  }
  g.computeVertexNormals();
  const rock = new THREE.Color(0x6d6862);
  const col = new Float32Array(a.length);
  for (let f = 0; f < col.length; f += 9) {
    const k = 1 + (rnd() * 2 - 1) * 0.18;
    for (let v = 0; v < 9; v += 3) {
      col[f + v] = rock.r * k; col[f + v + 1] = rock.g * k; col[f + v + 2] = rock.b * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// --- Street furniture ------------------------------------------------------
// Arm and lamp head extend along local +Z. See the header.

function streetlightBody(rnd) {
  const metal = 0x4a4e54;
  const brace = new THREE.BoxGeometry(0.09, 0.95, 0.09);
  brace.rotateX(0.72);
  return merged([
    paint(part(new THREE.CylinderGeometry(0.20, 0.26, 0.34, 6), 0, 0.17, 0), metal, 0.10, rnd),
    paint(part(new THREE.CylinderGeometry(0.085, 0.135, 7.0, 6, 1, true), 0, 3.50, 0), metal, 0.10, rnd),
    paint(part(new THREE.BoxGeometry(0.10, 0.10, 1.95), 0, 7.02, 0.98), metal, 0.10, rnd),
    paint(part(brace, 0, 6.58, 0.42), metal, 0.10, rnd),
  ]);
}

function polelightBody(rnd) {
  const timber = 0x5a5148;
  return merged([
    paint(part(new THREE.CylinderGeometry(0.18, 0.24, 0.30, 6), 0, 0.15, 0), timber, 0.10, rnd),
    paint(part(new THREE.CylinderGeometry(0.10, 0.17, 6.2, 6, 1, true), 0, 3.10, 0), timber, 0.10, rnd),
    paint(part(new THREE.BoxGeometry(0.08, 0.08, 0.56), 0, 6.14, 0.26), timber, 0.10, rnd),
  ]);
}

/** Lamp heads live on their own mesh so only they can go emissive at night. */
function lampGeometry(w, h, d, x, y, z, hex, rnd) {
  return paint(part(new THREE.BoxGeometry(w, h, d), x, y, z), hex, 0.05, rnd);
}

// ---------------------------------------------------------------------------
// Procedural decal textures
// ---------------------------------------------------------------------------

/**
 * A soft radial disc. `edgePower` shapes the falloff: the light pool wants a
 * long tail (a lamp does not stop at a rim), the contact shadow wants a tight
 * core so it reads as contact rather than as a grey plate.
 */
function discTexture(rgb, peakAlpha, edgePower) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const dx = (i + 0.5) / S * 2 - 1, dy = (j + 0.5) / S * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, edgePower) * peakAlpha;
      const o = (j * S + i) * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
      d[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

/** A unit quad lying in the XZ plane, ready to be scaled to a decal radius. */
function decalGeometry() {
  const g = new THREE.PlaneGeometry(2, 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProps(world, ground, opts = {}) {
  const group = new THREE.Group();
  group.name = 'props';

  const half = world.half;
  const seed = opts.seed === undefined ? world.seed : opts.seed;
  const range = opts.range === undefined ? 1 : opts.range;
  const wantShade = opts.contactShadows !== false;

  // Scratch. Everything below reuses these; update() allocates nothing at all.
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _euler = new THREE.Euler();
  const _mat = new THREE.Matrix4();
  const out = { x: 0, y: 0, z: 0, rot: 0, sx: 1, sy: 1, sz: 1, r: 1, g: 1, b: 1 };

  const fields = [];
  const disposables = [];

  // -------------------------------------------------------------------------
  // The instanced field
  // -------------------------------------------------------------------------

  /**
   * Builds one InstancedMesh over a subset of world.props.
   *
   * `place(prop, out)` fills the scratch record for one instance; it is called
   * once per prop, in the order the props appear, so a shared RNG stays
   * deterministic. The grid cell is taken from prop.x/prop.z rather than from
   * the placed position — a lamp pool sits a couple of metres off its pole,
   * which is nothing against a 64 m cell, and using the prop keeps the sort
   * key identical between the counting pass and the placing pass.
   */
  function makeField(spec) {
    const { name, indices, place, geometry, material, cull, tint } = spec;
    const n = indices.length;
    if (n === 0) return null;

    const cell = spec.cell || cellFor(cull * range);
    const G = Math.ceil((half * 2) / cell) + 1;
    const cellOf = (x, z) => {
      const i = clamp(Math.floor((x + half) / cell), 0, G - 1);
      const j = clamp(Math.floor((z + half) / cell), 0, G - 1);
      return j * G + i;
    };

    // ---- Counting sort into contiguous per-cell runs -----------------------
    const start = new Int32Array(G * G + 1);
    for (let k = 0; k < n; k++) {
      const p = world.props[indices[k]];
      start[cellOf(p.x, p.z) + 1]++;
    }
    for (let c = 0; c < G * G; c++) start[c + 1] += start[c];

    const cursor = Int32Array.from(start);
    const srcM = new Float32Array(n * 16);
    const srcC = tint ? new Float32Array(n * 3) : null;
    for (let k = 0; k < n; k++) {
      const p = world.props[indices[k]];
      place(p, out);
      const slot = cursor[cellOf(p.x, p.z)]++;
      _euler.set(0, out.rot, 0);
      _quat.setFromEuler(_euler);
      _pos.set(out.x, out.y, out.z);
      _scale.set(out.sx, out.sy, out.sz);
      _mat.compose(_pos, _quat, _scale);
      _mat.toArray(srcM, slot * 16);
      if (srcC) {
        srcC[slot * 3] = out.r; srcC[slot * 3 + 1] = out.g; srcC[slot * 3 + 2] = out.b;
      }
    }

    // ---- Capacity ---------------------------------------------------------
    // The exact worst case: the most instances any square block of cells the
    // cull can reach holds. A summed-area table answers that for every camera
    // position at once, which beats guessing and then either wasting a
    // megabyte or silently clipping a forest.
    const R = Math.ceil((cull * range + REBUILD_STEP) / cell);
    const W = G + 1;
    const sat = new Int32Array(W * W);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const c = j * G + i;
        sat[(j + 1) * W + i + 1] = (start[c + 1] - start[c]) +
          sat[j * W + i + 1] + sat[(j + 1) * W + i] - sat[j * W + i];
      }
    }
    let cap = 0;
    for (let j = 0; j < G; j++) {
      const j0 = Math.max(0, j - R), j1 = Math.min(G - 1, j + R) + 1;
      for (let i = 0; i < G; i++) {
        const i0 = Math.max(0, i - R), i1 = Math.min(G - 1, i + R) + 1;
        const s = sat[j1 * W + i1] - sat[j0 * W + i1] - sat[j1 * W + i0] + sat[j0 * W + i0];
        if (s > cap) cap = s;
      }
    }
    cap = Math.min(n, cap);
    if (cap === 0) return null;

    // ---- Cell visiting order, nearest first --------------------------------
    // Precomputed so a refresh walks a flat Int16Array instead of building a
    // candidate list. Nearest-first only matters if capacity is ever reached,
    // which the exact figure above should prevent — but it costs nothing to
    // make the failure mode "the far edge thins" rather than "a hole appears".
    const tmp = [];
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) tmp.push([di * di + dj * dj, di, dj]);
    }
    tmp.sort((a, b) => a[0] - b[0]);
    const offs = new Int16Array(tmp.length * 2);
    for (let k = 0; k < tmp.length; k++) { offs[k * 2] = tmp[k][1]; offs[k * 2 + 1] = tmp[k][2]; }

    // ---- Mesh -------------------------------------------------------------
    const mesh = new THREE.InstancedMesh(geometry, material, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Our own distance cull already decides what exists; three's frustum test
    // would only measure a bounding sphere that spans the whole map.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    const dstM = mesh.instanceMatrix.array;

    let dstC = null;
    if (tint) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      dstC = mesh.instanceColor.array;
    }
    group.add(mesh);

    const field = {
      name, mesh, extras: [], cap, total: n,
      cull, radius: cull * range,
      atX: Infinity, atZ: Infinity, dirty: true,
    };

    field.refresh = function refresh(camX, camZ) {
      const radius = field.radius + REBUILD_STEP;
      const r2 = radius * radius;
      const ci = Math.floor((camX + half) / cell);
      const cj = Math.floor((camZ + half) / cell);
      let w = 0;

      for (let t = 0; t < offs.length; t += 2) {
        const i = ci + offs[t], j = cj + offs[t + 1];
        if (i < 0 || j < 0 || i >= G || j >= G) continue;
        const c = j * G + i;
        const s = start[c];
        let len = start[c + 1] - s;
        if (len === 0) continue;

        // Distance to the nearest point of the cell, so a cell only qualifies
        // if it actually touches the circle.
        const x0 = i * cell - half, z0 = j * cell - half;
        const dx = camX < x0 ? x0 - camX : camX > x0 + cell ? camX - x0 - cell : 0;
        const dz = camZ < z0 ? z0 - camZ : camZ > z0 + cell ? camZ - z0 - cell : 0;
        if (dx * dx + dz * dz > r2) continue;

        if (w + len > cap) len = cap - w;
        if (len <= 0) break;

        // Copied by hand rather than with dst.set(src.subarray(...)): subarray
        // allocates a view object per call, and this runs a couple of hundred
        // times per rebuild. A flat loop over a few hundred thousand floats is
        // a fraction of a millisecond and allocates nothing.
        let sm = s * 16, dm = w * 16;
        for (let k = len * 16; k > 0; k--) dstM[dm++] = srcM[sm++];
        if (dstC) {
          let sc = s * 3, dc = w * 3;
          for (let k = len * 3; k > 0; k--) dstC[dc++] = srcC[sc++];
        }
        w += len;
        if (w >= cap) break;
      }

      mesh.count = w;
      for (let k = 0; k < field.extras.length; k++) field.extras[k].count = w;
      if (w > 0) {
        // Upload only the slice in use; capacity is sized for the worst clump
        // in the world and is usually several times what is on screen. The
        // renderer clears the ranges once it has uploaded them, so the clear
        // here is for the case where it never did — a hidden mesh, or a
        // refresh that found nothing — whose stale range would otherwise merge
        // with this one and widen the upload.
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, w * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, w * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
      field.atX = camX; field.atZ = camZ; field.dirty = false;
    };

    fields.push(field);
    return field;
  }

  /**
   * A second mesh riding the same instance transforms — used for lamp heads,
   * which need their own emissive material but sit exactly where the pole they
   * belong to sits. Sharing the attribute means one buffer and one upload.
   */
  function shareInstances(field, geometry, material, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, field.cap);
    mesh.name = name;
    mesh.instanceMatrix = field.mesh.instanceMatrix;
    mesh.instanceColor = null;
    mesh.count = field.mesh.count;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    field.extras.push(mesh);
    group.add(mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Sort the prop list
  // -------------------------------------------------------------------------

  const treeIdx = [[], [], []];
  const rockIdx = [[], [], []];
  const streetIdx = [];
  const poleIdx = [];
  const lightIdx = [];
  for (let i = 0; i < world.props.length; i++) {
    const p = world.props[i];
    const v = clamp(p.variant | 0, 0, 2);
    if (p.type === 'tree') treeIdx[v].push(i);
    else if (p.type === 'rock') rockIdx[v].push(i);
    else if (p.type === 'streetlight') { streetIdx.push(i); lightIdx.push(i); }
    else if (p.type === 'polelight') { poleIdx.push(i); lightIdx.push(i); }
  }
  const treeAll = treeIdx[0].concat(treeIdx[1], treeIdx[2]);

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  // Lambert, not Standard: foliage and bark have no interesting specular, and
  // this is the material that gets evaluated a few hundred thousand times a
  // frame. flatShading suits the faceted geometry and skips normal smoothing.
  const foliageMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const poleMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const lampMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
    emissive: new THREE.Color(0xffb356), emissiveIntensity: 0,
  });

  const poolTex = discTexture([255, 226, 178], 1.0, 2.1);
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex, color: 0xffc98a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const shadeTex = discTexture([0, 0, 0], 1.0, 1.5);
  const shadeMat = new THREE.MeshBasicMaterial({
    map: shadeTex, color: 0x000000, transparent: true, opacity: 0.40,
    depthWrite: false, toneMapped: false,
  });

  disposables.push(foliageMat, rockMat, poleMat, lampMat, poolMat, shadeMat, poolTex, shadeTex);

  // -------------------------------------------------------------------------
  // Build the fields
  // -------------------------------------------------------------------------

  const rnd = mulberry(seed ^ 0x51ed2f);
  const species = [deciduousTree(rnd), coniferTree(rnd), scrubTree(rnd)];
  const rocks = [
    rockGeometry(0, 0.62, rnd),
    rockGeometry(0, 0.48, rnd),
    rockGeometry(1, 0.70, rnd),
  ];
  const streetGeo = streetlightBody(rnd);
  const poleGeo = polelightBody(rnd);
  const streetLampGeo = lampGeometry(0.56, 0.16, 0.34, 0, 6.92, 1.86, 0xc4c8cc, rnd);
  const poleLampGeo = lampGeometry(0.42, 0.14, 0.30, 0, 6.02, 0.50, 0xc4c8cc, rnd);
  const decalGeo = decalGeometry();
  for (const s of species) disposables.push(s.geo);
  disposables.push(...rocks, streetGeo, poleGeo, streetLampGeo, poleLampGeo, decalGeo);

  // Where each lamp head actually hangs, in the pole's local +Z. Used to put
  // the light pool under the lamp rather than under the pole.
  const STREET_ARM = 1.86;
  const POLE_ARM = 0.50;

  const groundY = (x, z) => ground.heightAt(x, z);
  const propY = (p) => (p.y === undefined || p.y === null ? groundY(p.x, p.z) : p.y);

  /** Warm/cool drift about white, so instanceColor tints without darkening. */
  function tintFrom(r, spread, o) {
    const v = 0.80 + r() * 0.42;
    const h = (r() * 2 - 1) * spread;
    o.r = clamp(v * (1 + h), 0.35, 1.45);
    o.g = clamp(v * (1 + h * 0.30), 0.35, 1.45);
    o.b = clamp(v * (1 - h * 0.85), 0.35, 1.45);
  }

  for (let v = 0; v < 3; v++) {
    const sp = species[v];
    const r = mulberry(seed + 101 + v * 977);
    makeField({
      name: 'trees' + v,
      indices: treeIdx[v],
      geometry: sp.geo,
      material: foliageMat,
      cull: CULL.tree,
      tint: true,
      place(p, o) {
        const s = p.scale || 1;
        o.x = p.x; o.z = p.z;
        o.y = propY(p) - sp.sink * s;
        o.rot = p.rot || 0;
        // A little non-uniform stretch: two trees of the same species and the
        // same scale should still not be the same tree.
        o.sy = s * (0.88 + r() * 0.26);
        o.sx = o.sz = s * (0.94 + r() * 0.14);
        tintFrom(r, sp.hue, o);
      },
    });
  }

  for (let v = 0; v < 3; v++) {
    const r = mulberry(seed + 401 + v * 613);
    makeField({
      name: 'rocks' + v,
      indices: rockIdx[v],
      geometry: rocks[v],
      material: rockMat,
      cull: CULL.rock,
      tint: true,
      place(p, o) {
        const s = p.scale || 1;
        o.x = p.x; o.z = p.z;
        // Buried by a third of its radius, so a boulder sits in the hillside
        // instead of balancing on it.
        o.y = propY(p) - 0.32 * s;
        o.rot = p.rot || 0;
        o.sx = s * (0.90 + r() * 0.30);
        o.sy = s * (0.85 + r() * 0.35);
        o.sz = s * (0.90 + r() * 0.30);
        tintFrom(r, 0.14, o);
      },
    });
  }

  function lightPlace(p, o) {
    o.x = p.x; o.z = p.z;
    // The prop carries the carriageway height; the pole stands a lane and a
    // half off it, on graded verge, so ask the ground where it really is.
    o.y = groundY(p.x, p.z) - 0.05;
    o.rot = p.rot || 0;
    o.sx = o.sy = o.sz = p.scale || 1;
  }

  const streetField = makeField({
    name: 'streetlights', indices: streetIdx, geometry: streetGeo,
    material: poleMat, cull: CULL.light, tint: false, place: lightPlace,
  });
  if (streetField) shareInstances(streetField, streetLampGeo, lampMat, 'streetlamps');

  const poleField = makeField({
    name: 'polelights', indices: poleIdx, geometry: poleGeo,
    material: poleMat, cull: CULL.light, tint: false, place: lightPlace,
  });
  if (poleField) shareInstances(poleField, poleLampGeo, lampMat, 'polelamps');

  const poolField = makeField({
    name: 'lightpools', indices: lightIdx, geometry: decalGeo,
    material: poolMat, cull: CULL.pool, tint: false,
    place(p, o) {
      const s = p.scale || 1;
      const arm = (p.type === 'streetlight' ? STREET_ARM : POLE_ARM) * s;
      const rot = p.rot || 0;
      // Local +Z under a Y rotation lands at (sin rot, cos rot).
      o.x = p.x + Math.sin(rot) * arm;
      o.z = p.z + Math.cos(rot) * arm;
      // Lifted a hand's width and drawn without depth writes. Streetlights
      // stand on graded verge beside a flat carriageway, so a flat quad is a
      // good enough stand-in for a projected decal and costs one triangle pair.
      o.y = groundY(o.x, o.z) + 0.10;
      o.rot = rot;
      o.sx = o.sy = o.sz = (p.type === 'streetlight' ? 7.4 : 5.6) * s;
    },
  });
  if (poolField) { poolField.mesh.renderOrder = 3; poolField.mesh.visible = false; }

  let shadeField = null;
  if (wantShade) {
    shadeField = makeField({
      name: 'treeshadows', indices: treeAll, geometry: decalGeo,
      material: shadeMat, cull: CULL.shade, tint: false,
      place(p, o) {
        const sp = species[clamp(p.variant | 0, 0, 2)];
        const s = p.scale || 1;
        o.x = p.x; o.z = p.z;
        o.y = propY(p) + 0.07;
        o.rot = p.rot || 0;
        o.sx = o.sy = o.sz = sp.spread * 0.46 * s;
      },
    });
    if (shadeField) shadeField.mesh.renderOrder = 2;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  let quality = 1;
  let night = 0;
  let cursorField = 0;
  let primed = false;

  function markAll() {
    for (let i = 0; i < fields.length; i++) fields[i].dirty = true;
  }

  function update(cameraPos, dt) {
    if (!cameraPos) return;
    const cx = cameraPos.x, cz = cameraPos.z;

    // A frame that has already overrun is the worst possible place to spend
    // another few tenths of a millisecond rebuilding instance buffers, and the
    // rebuild margin gives us plenty of frames to catch up in.
    let budget = primed ? (dt > 0.05 ? 0 : 1) : fields.length;
    primed = true;

    for (let n = 0; n < fields.length && budget > 0; n++) {
      const f = fields[cursorField];
      cursorField = cursorField + 1 === fields.length ? 0 : cursorField + 1;
      if (!f.mesh.visible) continue;
      if (!f.dirty) {
        const dx = cx - f.atX, dz = cz - f.atZ;
        if (dx * dx + dz * dz < REBUILD_STEP * REBUILD_STEP) continue;
      }
      f.refresh(cx, cz);
      budget--;
    }
  }

  /** 0 = midday, 1 = full dark. */
  function setNight(t) {
    night = clamp(t, 0, 1);
    const lit = smoothstep(0.18, 0.72, night);

    lampMat.emissiveIntensity = lit * 2.6;

    if (poolField) {
      poolMat.opacity = lit * 0.85;
      const on = poolMat.opacity > 0.01;
      if (on && !poolField.mesh.visible) poolField.dirty = true;
      poolField.mesh.visible = on;
    }
    if (shadeField) {
      // Sun shadows go with the sun. Leaving them on after dark would paint
      // black discs under trees lit only by a streetlight.
      shadeMat.opacity = (1 - lit) * 0.40 * (quality >= 0.5 ? 1 : 0);
      const on = shadeMat.opacity > 0.01;
      if (on && !shadeField.mesh.visible) shadeField.dirty = true;
      shadeField.mesh.visible = on;
    }
  }

  /** 0 = the cheapest thing that still reads as a world, 1 = everything. */
  function setQuality(q) {
    quality = clamp(typeof q === 'number' ? q : 1, 0, 1);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      f.radius = lerp(f.cull * 0.42, f.cull, quality) * range;
    }
    markAll();
    setNight(night);   // shadow decals are gated on quality
  }

  function dispose() {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      group.remove(f.mesh);
      f.mesh.dispose();
      // Extras are NOT disposed: InstancedMesh.dispose() makes the renderer
      // free whatever instanceMatrix the mesh is holding, and an extra is
      // holding its owner's. Removing it is enough — the owner's dispose above
      // released the one buffer they share, and the geometry and material it
      // uses are in `disposables`.
      for (let k = 0; k < f.extras.length; k++) group.remove(f.extras[k]);
      f.extras.length = 0;
    }
    fields.length = 0;
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    group.clear();
  }

  setQuality(opts.quality === undefined ? 1 : opts.quality);
  setNight(opts.night === undefined ? 0 : opts.night);

  const stats = { fields: fields.length, meshes: group.children.length, instances: {}, capacity: {} };
  for (const f of fields) { stats.instances[f.name] = f.total; stats.capacity[f.name] = f.cap; }

  return { group, update, setNight, setQuality, dispose, stats };
}
