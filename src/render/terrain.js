// The ground mesh.
//
// COORDINATES: X east, Z south, Y up — the physics frame, unchanged. A chunk's
// vertices are (x, ground.heightAt-equivalent, z) with x/z local to the chunk and
// y absolute. Nothing here mirrors or negates an axis, so a car standing on a
// visible slope is standing on the slope it looks like it is standing on.
//
// WHY IT IS BUILT THIS WAY
//
// This is the largest mesh in the game and therefore the one that decides the
// frame rate, so both of its costs are capped by construction:
//
//   Triangles are capped by concentric LOD rings. Chunks are a fixed 128 m
//   square at EVERY level — only the vertex spacing changes (2 / 4 / 8 / 16 m
//   at 'high'). Uniform chunk size is the whole trick: chunks tile exactly, so
//   two LOD levels can never overlap and z-fight, which is the failure mode of
//   the more obvious scheme where distant chunks are made bigger. The price is
//   a seam wherever two different LODs meet, and that is paid with skirts.
//
//   Build cost is capped by a per-frame time budget. A cold ring is ~250 k
//   triangles' worth of terrain sampling; spending it all in one frame is a
//   half-second stall, so chunks are queued nearest-first and drained against a
//   millisecond budget that shrinks on frames that are already late.
//
// Height comes from ground.sample(), not from world.terrain — the roads are
// carved into ground's height field, and a mesh built from bare terrain would
// show a hillside where the car is driving through a cutting. Sampling the same
// function the wheels sample makes that class of bug impossible rather than
// unlikely.
//
// SKIRTS. Each chunk is a (G+3)^2 vertex grid whose outer ring is clamped back
// onto the border and dropped a few metres, forming a vertical apron. It costs
// one ring of vertices and hides LOD cracks completely, which matters because a
// crack is not a subtle artefact — you see sky through the ground.

import * as THREE from 'three';
import { fbm, valueNoise, clamp, lerp, smoothstep } from '../world/noise.js';

// rings[l] is the largest Chebyshev chunk distance still drawn at level l;
// grids[l] is that level's quad count per chunk edge. 128 / grid = vertex spacing.
const QUALITY = {
  low:    { rings: [0, 2, 4, 6], grids: [48, 24, 12,  6], budgetMs: 2.5 },
  medium: { rings: [1, 2, 4, 7], grids: [64, 32, 16,  8], budgetMs: 3.5 },
  high:   { rings: [1, 3, 5, 8], grids: [64, 32, 16,  8], budgetMs: 5.0 },
};

// Materials whose colour is stamped by a road rather than grown by the terrain.
const PAVED = { asphalt: 1, concrete: 1, sidewalk: 1, gravel: 1 };

// Grass endpoints, hand-picked rather than derived from SURFACES.grass: one
// flat green over four square kilometres reads as painted plastic at any speed.
const LUSH = [0.19, 0.33, 0.12];
const DRY  = [0.47, 0.44, 0.22];
const SOIL = [0.34, 0.26, 0.16];

// three.js treats a colour attribute as already being in the working (linear)
// space, but the palette above and SURFACES[..].colour are authored as sRGB.
// A 257-entry LUT converts for the price of one lerp instead of a pow per channel.
const S2L = new Float32Array(257);
for (let i = 0; i <= 256; i++) {
  const c = i / 256;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function toLinear(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  const t = c * 256, i = t | 0;
  return S2L[i] + (S2L[i + 1] - S2L[i]) * (t - i);
}

const clock = typeof performance !== 'undefined' && performance.now ? performance : Date;

export function createTerrain(world, ground, opts = {}) {
  const CHUNK = opts.chunk ?? 128;
  const SURFACES = ground.SURFACES;
  const terrain = world.terrain;
  const tintSeed = ((terrain.seed ?? 0) | 0) + 5501;
  const shadows = opts.shadows ?? false;
  const managed = !!(THREE.ColorManagement && THREE.ColorManagement.enabled);

  const group = new THREE.Group();
  group.name = 'terrain';
  group.matrixAutoUpdate = false;

  // Lambert, not Standard: this mesh covers the whole screen, and a per-vertex
  // diffuse term over a quarter-million triangles is a great deal cheaper than a
  // per-pixel BRDF for ground that has no specular character anyway. Pass
  // opts.material to match the rest of the scene if that trade stops being worth it.
  const material = opts.material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
  const ownsMaterial = !opts.material;

  const asked = typeof opts.quality === 'number'
    ? (opts.quality < 0.34 ? 'low' : opts.quality < 0.75 ? 'medium' : 'high')
    : opts.quality;
  let preset = QUALITY[asked] ? asked : 'high';
  let rings = QUALITY[preset].rings;
  let grids = QUALITY[preset].grids;
  let budgetMs = opts.budgetMs ?? QUALITY[preset].budgetMs;

  const stats = {
    quality: preset, chunks: 0, triangles: 0, pending: 0,
    viewDistance: (rings[rings.length - 1] + 0.5) * CHUNK,
  };

  // ---- scratch: reused for every vertex of every chunk, forever --------------
  const gs = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', grip: 0, roughness: 0, rolling: 0, dust: 0 };
  const rgb = [0, 0, 0], rgb2 = [0, 0, 0];
  let hgrid = new Float32Array(0);   // heights incl. the ring outside the chunk

  const trisFor = (G) => (G + 2) * (G + 2) * 2;

  // =========================================================================
  // Colour
  // =========================================================================

  /** Base colour of a surface at a point, before mottle and occlusion. */
  function palette(surface, x, z, ny, out) {
    if (surface === 'grass') {
      // A slow wet/dry sweep at field scale, then bare soil wherever the slope
      // is steep enough that turf would not hold.
      const dry = clamp(fbm(x * 0.0042, z * 0.0042, tintSeed, 3) * 0.62 + 0.5, 0, 1);
      const r = lerp(LUSH[0], DRY[0], dry);
      const g = lerp(LUSH[1], DRY[1], dry);
      const b = lerp(LUSH[2], DRY[2], dry);
      const bare = smoothstep(0.14, 0.55, 1 - ny) * 0.7;
      out[0] = lerp(r, SOIL[0], bare);
      out[1] = lerp(g, SOIL[1], bare);
      out[2] = lerp(b, SOIL[2], bare);
      return;
    }
    const hex = (SURFACES[surface] || SURFACES.grass).colour;
    out[0] = ((hex >> 16) & 255) / 255;
    out[1] = ((hex >> 8) & 255) / 255;
    out[2] = (hex & 255) / 255;
  }

  /**
   * `fine` fades the short-wavelength mottle out on coarse chunks — sampled at
   * 16 m it would alias into blotches rather than texture. `roadMix` does the
   * same job for road materials, which are narrower than a far chunk's vertex
   * spacing and otherwise scatter grey measles across the countryside; the road
   * renderer draws the real carriageway and fog covers the rest.
   */
  function tint(surface, x, z, ny, fine, roadMix, out) {
    palette(surface, x, z, ny, out);
    if (roadMix > 0 && PAVED[surface] === 1) {
      palette(terrain.cover(x, z, ny), x, z, ny, rgb2);
      out[0] = lerp(out[0], rgb2[0], roadMix);
      out[1] = lerp(out[1], rgb2[1], roadMix);
      out[2] = lerp(out[2], rgb2[2], roadMix);
    }
    const amp = PAVED[surface] === 1 ? 0.06 : 0.17;
    const lum = valueNoise(x * 0.0091, z * 0.0091, tintSeed + 7);
    const mot = fine > 0 ? valueNoise(x * 0.029, z * 0.029, tintSeed + 31) : 0;
    const k = 1 + lum * amp * 0.62 + mot * amp * 0.45 * fine;
    out[0] *= k; out[1] *= k; out[2] *= k;
  }

  // =========================================================================
  // Geometry pool
  // =========================================================================
  // Keyed by grid resolution, not by LOD index, because setQuality() changes
  // which resolution a level uses. Every chunk of a given resolution has an
  // identical index buffer, so one is built and shared by all of them.

  const pools = new Map();
  const indices = new Map();

  function indexFor(G) {
    let attr = indices.get(G);
    if (attr) return attr;
    const D = G + 3, n = G + 2;
    const arr = new Uint16Array(n * n * 6);
    let w = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        // Wound so the face normal is +Y: (a,b) -> (a,b+1) -> (a+1,b+1).
        const A = a * D + b, B = A + 1, C = A + D + 1, E = A + D;
        arr[w++] = A; arr[w++] = B; arr[w++] = C;
        arr[w++] = A; arr[w++] = C; arr[w++] = E;
      }
    }
    attr = new THREE.BufferAttribute(arr, 1);
    indices.set(G, attr);
    return attr;
  }

  function acquire(G) {
    const pool = pools.get(G);
    if (pool && pool.length) return pool.pop();
    const V = (G + 3) * (G + 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geom.setIndex(indexFor(G));
    geom.boundingSphere = new THREE.Sphere();
    return geom;
  }

  function release(G, geom) {
    // A resolution the current preset no longer asks for would never be popped
    // again, so it goes back to the driver rather than sitting in a pool.
    if (grids.indexOf(G) < 0) { geom.dispose(); return; }
    let pool = pools.get(G);
    if (!pool) pools.set(G, (pool = []));
    pool.push(geom);
  }

  // =========================================================================
  // Chunk fill
  // =========================================================================

  function fill(cx, cz, G, geom) {
    const step = CHUNK / G;
    const D = G + 3, last = G + 2;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const pos = geom.attributes.position.array;
    const nrm = geom.attributes.normal.array;
    const col = geom.attributes.color.array;

    const fine = smoothstep(12, 4, step);
    const roadMix = smoothstep(4, 13, step) * 0.75;
    const aoW = smoothstep(11, 3, step) * 0.18;
    const skirt = Math.max(3, step * 1.25);

    if (hgrid.length < D * D) hgrid = new Float32Array(D * D);

    let minY = Infinity, maxY = -Infinity;

    // Pass 1. Every grid point is sampled, including the ring one cell OUTSIDE
    // the chunk: those heights are what lets the border vertices get the same
    // occlusion treatment as interior ones, so chunk seams do not show up as a
    // faint lattice of un-shaded ground.
    for (let a = 0; a <= last; a++) {
      const lx = (a - 1) * step, x = ox + lx;
      for (let b = 0; b <= last; b++) {
        const lz = (b - 1) * step, z = oz + lz;
        const s = ground.sample(x, z, gs);
        const v = a * D + b;
        hgrid[v] = s.y;
        if (a === 0 || b === 0 || a === last || b === last) continue;   // skirt, pass 3
        const o = v * 3;
        pos[o] = lx; pos[o + 1] = s.y; pos[o + 2] = lz;
        // Normals come straight from the height field's own gradient. Averaging
        // face normals on a 16 m grid would flatten every hill into facets.
        nrm[o] = s.nx; nrm[o + 1] = s.ny; nrm[o + 2] = s.nz;
        tint(s.surface, x, z, s.ny, fine, roadMix, rgb);
        col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2];
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
      }
    }

    // Pass 2. Cheap ambient occlusion from the grid Laplacian: a point sitting
    // below its neighbours is in a hollow and gets less sky. Faded out on coarse
    // chunks, where the measurement radius is too wide to mean anything.
    for (let a = 1; a < last; a++) {
      for (let b = 1; b < last; b++) {
        const v = a * D + b, o = v * 3;
        const lap = hgrid[v] * 4 - hgrid[v - D] - hgrid[v + D] - hgrid[v - 1] - hgrid[v + 1];
        const k = 1 + clamp(lap / (step * 1.6), -1, 1) * aoW;
        let r = col[o] * k, g = col[o + 1] * k, b2 = col[o + 2] * k;
        if (managed) { r = toLinear(r); g = toLinear(g); b2 = toLinear(b2); }
        col[o] = r; col[o + 1] = g; col[o + 2] = b2;
      }
    }

    // Pass 3. The skirt: outer ring clamped back onto the border and dropped, so
    // a neighbouring chunk at a coarser LOD has something to hide its crack behind.
    for (let a = 0; a <= last; a++) {
      const edgeA = a === 0 || a === last;
      for (let b = 0; b <= last; b++) {
        if (!edgeA && b !== 0 && b !== last) continue;
        const ca = a === 0 ? 1 : a === last ? last - 1 : a;
        const cb = b === 0 ? 1 : b === last ? last - 1 : b;
        const src = (ca * D + cb) * 3, dst = (a * D + b) * 3;
        pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - skirt; pos[dst + 2] = pos[src + 2];
        nrm[dst] = nrm[src]; nrm[dst + 1] = nrm[src + 1]; nrm[dst + 2] = nrm[src + 2];
        col[dst] = col[src]; col[dst + 1] = col[src + 1]; col[dst + 2] = col[src + 2];
      }
    }

    geom.attributes.position.needsUpdate = true;
    geom.attributes.normal.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;

    // Set by hand rather than computeBoundingSphere(): the extents are already
    // known from the sampling pass, and this runs for every chunk built.
    geom.boundingSphere.center.set(CHUNK * 0.5, (minY + maxY) * 0.5, CHUNK * 0.5);
    geom.boundingSphere.radius = Math.hypot(CHUNK * 0.7072, (maxY - minY) * 0.5 + skirt);
  }

  // =========================================================================
  // Streaming
  // =========================================================================

  const chunks = new Map();
  const queue = [];
  let qi = 0;
  let stamp = 0;
  let lastCx = NaN, lastCz = NaN;
  let primed = false;

  const byNear = (a, b) => a.d - b.d;
  const keyOf = (cx, cz) => (cx + 1024) * 4096 + (cz + 1024);

  function levelFor(d) {
    for (let l = 0; l < rings.length; l++) if (d <= rings[l]) return l;
    return -1;
  }

  function drop(rec) {
    if (!rec.mesh) return;
    group.remove(rec.mesh);
    release(rec.grid, rec.mesh.geometry);
    stats.chunks--;
    stats.triangles -= trisFor(rec.grid);
    rec.mesh = null;
  }

  function refresh(ccx, ccz) {
    stamp++;
    queue.length = 0;
    qi = 0;
    const R = rings[rings.length - 1];
    for (let dx = -R; dx <= R; dx++) {
      const ax = dx < 0 ? -dx : dx;
      for (let dz = -R; dz <= R; dz++) {
        const az = dz < 0 ? -dz : dz;
        const d = ax > az ? ax : az;
        const lod = levelFor(d);
        if (lod < 0) continue;
        const cx = ccx + dx, cz = ccz + dz, key = keyOf(cx, cz);
        let rec = chunks.get(key);
        if (!rec) {
          rec = { key, cx, cz, d, want: lod, grid: 0, mesh: null, seen: stamp };
          chunks.set(key, rec);
        } else {
          rec.d = d; rec.want = lod; rec.seen = stamp;
        }
        if (rec.grid !== grids[lod]) queue.push(rec);
      }
    }
    for (const rec of chunks.values()) {
      if (rec.seen !== stamp) { drop(rec); chunks.delete(rec.key); }
    }
    // Nearest first: the ground the player is about to drive onto is worth more
    // than the ground on the horizon, and the horizon is in fog anyway.
    queue.sort(byNear);
    stats.pending = queue.length;
  }

  function build(rec) {
    const G = grids[rec.want];
    const geom = acquire(G);
    fill(rec.cx, rec.cz, G, geom);
    if (rec.mesh) {
      release(rec.grid, rec.mesh.geometry);
      stats.triangles -= trisFor(rec.grid);
      rec.mesh.geometry = geom;
    } else {
      const mesh = new THREE.Mesh(geom, material);
      mesh.position.set(rec.cx * CHUNK, 0, rec.cz * CHUNK);
      mesh.matrixAutoUpdate = false;   // chunks never move once placed
      mesh.updateMatrix();
      mesh.castShadow = false;
      rec.mesh = mesh;
      group.add(mesh);
      stats.chunks++;
    }
    // Only the two near rings bother with shadow receive; past ~400 m the
    // cascade has nothing to say and the extra depth pass is pure cost.
    rec.mesh.receiveShadow = shadows && rec.want <= 1;
    rec.grid = G;
    stats.triangles += trisFor(G);
  }

  function drain(ms) {
    if (qi >= queue.length) return;
    const t0 = clock.now();
    while (qi < queue.length) {
      const rec = queue[qi++];
      // A chunk can be dropped or already re-satisfied between queueing and now.
      if (rec.mesh === null && !chunks.has(rec.key)) continue;
      if (rec.grid === grids[rec.want]) continue;
      build(rec);
      if (clock.now() - t0 >= ms) break;   // checked after, so one always lands
    }
    stats.pending = queue.length - qi;
  }

  function update(cameraPos, dt) {
    const ccx = Math.floor(cameraPos.x / CHUNK);
    const ccz = Math.floor(cameraPos.z / CHUNK);
    if (ccx !== lastCx || ccz !== lastCz) {
      lastCx = ccx; lastCz = ccz;
      refresh(ccx, ccz);
    }
    if (!primed) {
      // The first ring has to exist before the first frame is worth showing, so
      // the opening drain gets a much larger budget. Call update() once from the
      // loading screen and the player never sees the world assemble itself.
      primed = true;
      drain(opts.primeMs ?? 250);
      return;
    }
    // Streaming stutter is exactly what you notice from a moving car, so frames
    // that are already late get less of the budget, not the same amount.
    const step = dt === undefined ? 1 / 60 : dt;
    const scale = step > 0.026 ? 0.4 : step < 0.015 ? 1.5 : 1;
    drain(budgetMs * scale);
  }

  /** 'low' | 'medium' | 'high'. A 0..1 number is accepted too, so main.js can
   *  drive every renderer from one quality knob. */
  function setQuality(q) {
    const name = typeof q === 'number' ? (q < 0.34 ? 'low' : q < 0.75 ? 'medium' : 'high') : q;
    const next = QUALITY[name];
    if (!next || name === preset) return;
    preset = name;
    rings = next.rings;
    grids = next.grids;
    budgetMs = opts.budgetMs ?? next.budgetMs;
    stats.quality = preset;
    stats.viewDistance = (rings[rings.length - 1] + 0.5) * CHUNK;
    // Pooled geometries of a resolution the new preset never asks for would sit
    // in memory unreachable, so they go back to the driver now.
    const wanted = new Set(grids);
    for (const [G, pool] of pools) {
      if (wanted.has(G)) continue;
      for (const geom of pool) geom.dispose();
      pools.delete(G);
      indices.delete(G);
    }
    lastCx = NaN;   // force a full re-plan on the next update
  }

  function dispose() {
    for (const rec of chunks.values()) {
      if (rec.mesh) { group.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh = null; }
    }
    chunks.clear();
    for (const pool of pools.values()) for (const geom of pool) geom.dispose();
    pools.clear();
    indices.clear();
    queue.length = 0;
    qi = 0;
    if (ownsMaterial) material.dispose();
    stats.chunks = 0; stats.triangles = 0; stats.pending = 0;
  }

  return { group, update, setQuality, dispose, stats, material };
}
