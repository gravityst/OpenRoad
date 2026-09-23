// Routing on the real road network.
//
// Everything that tells the player where to go is built on this file: the GPS
// line on the minimap, the chevrons painted on the road, the arrow over the car,
// and the route every race runs. None of it is a straight line between two
// points, because a straight line across this map goes through a field, a hill
// and usually a barn — which is exactly the "ten seconds after pressing Drive
// the car was in a field" failure the play-test found. A route here is a walk
// along world.edges, and a harness proves every point of it sits on a road.
//
// Pure data, no three.js and no DOM, so tools/goalscheck.mjs routes on the same
// world the browser does.
//
// THE GRAPH IS SMALL. 678 nodes and 840 edges for 82 km of road, so Dijkstra
// with a binary heap is well under a millisecond and there is no case for A*,
// contraction or caching. What matters instead is that a route request never
// allocates in steady state: the GPS re-plans whenever the player wanders off
// the line, and the scratch arrays below are sized once, at construction.
//
// EDGE POLYLINES RUN a -> b. Verified against the generated world: 0 of 840 are
// reversed, but 51 end up to 6.8 m short of their node because the overlap pass
// in layout.js nudges junctions after the polyline is laid. Routes therefore
// concatenate polylines rather than node positions, and never assume the two
// meet exactly.

// What a metre of each kind of road costs the router. A kid following the GPS
// should be led along tarmac where tarmac exists, and only onto a goat track if
// it saves a great deal — 'track' is 5.5 m wide, unmarked, and where the car
// ends up in a hedge.
const KIND_COST = {
  highway: 1, avenue: 1, link: 1, rural: 1, street: 1.05,
  circuit: 1.08, rallyx: 1.2, gravel: 1.18, dirt: 1.35, track: 2.4,
};

const KIND_CODE = { rural: 0, gravel: 1, dirt: 2, track: 3, circuit: 4, rallyx: 5, highway: 6, avenue: 7, link: 8, street: 9 };
export const KIND_NAMES = ['rural', 'gravel', 'dirt', 'track', 'circuit', 'rallyx', 'highway', 'avenue', 'link', 'street'];
/** Loose surfaces, by kind code — the reference driver brakes earlier on these. */
export const LOOSE_CODE = new Uint8Array([0, 1, 1, 1, 0, 1, 0, 0, 0, 0]);

const CELL = 64;        // spatial hash for locate(), metres
const hkey = (cx, cz) => (cx + 1024) * 4096 + (cz + 1024);

/**
 * Builds the routing graph for `world`.
 *
 * Returns { locate, route, walk, routeFromEdges, edgeCost, nodes, edges }.
 */
export function createRoadGraph(world) {
  const nodes = world.nodes, edges = world.edges;
  const N = nodes.length;

  // ---- adjacency, compressed ----------------------------------------------
  const degree = new Int32Array(N + 1);
  for (const e of edges) { degree[e.a]++; degree[e.b]++; }
  const start = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) start[i + 1] = start[i] + degree[i];
  const adjEdge = new Int32Array(start[N]);
  const adjTo = new Int32Array(start[N]);
  const fill = start.slice(0, N);
  for (const e of edges) {
    adjEdge[fill[e.a]] = e.i; adjTo[fill[e.a]++] = e.b;
    adjEdge[fill[e.b]] = e.i; adjTo[fill[e.b]++] = e.a;
  }
  const edgeCost = new Float64Array(edges.length);
  for (const e of edges) edgeCost[e.i] = (e.length || 0) * (KIND_COST[e.kind] || 1.2);

  // ---- spatial index over polyline segments -------------------------------
  // Packed (edge << 12 | pointIndex). No edge has anywhere near 4096 points —
  // the longest is ~150 at 8 m spacing — and the harness would see it if one did.
  const cells = new Map();
  for (const e of edges) {
    const pts = e.pts;
    if (!pts) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const cx0 = Math.floor(Math.min(a.x, b.x) / CELL), cx1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const cz0 = Math.floor(Math.min(a.z, b.z) / CELL), cz1 = Math.floor(Math.max(a.z, b.z) / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = hkey(cx, cz);
          let list = cells.get(k);
          if (!list) { list = []; cells.set(k, list); }
          list.push((e.i << 12) | i);
        }
      }
    }
  }

  const located = { edge: null, s: 0, x: 0, z: 0, y: 0, dist: Infinity, tx: 0, tz: 0 };

  /**
   * Nearest point on the network to (x, z), searching outward ring by ring so a
   * point on a road costs one cell and a point in the middle of nowhere still
   * gets an answer. Returns a SHARED object unless `out` is given.
   */
  function locate(x, z, maxR = 1500, filter = null, out = located) {
    out.edge = null; out.dist = Infinity;
    const cx0 = Math.floor(x / CELL), cz0 = Math.floor(z / CELL);
    const rings = Math.ceil(maxR / CELL);
    for (let r = 0; r <= rings; r++) {
      for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
        for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
          if (Math.max(Math.abs(cx - cx0), Math.abs(cz - cz0)) !== r) continue;
          const list = cells.get(hkey(cx, cz));
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const e = edges[list[n] >> 12];
            if (filter && !filter(e)) continue;
            const i = list[n] & 4095;
            const a = e.pts[i], b = e.pts[i + 1];
            const dx = b.x - a.x, dz = b.z - a.z;
            const len2 = dx * dx + dz * dz;
            let t = len2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = a.x + dx * t, pz = a.z + dz * t;
            const d = Math.hypot(x - px, z - pz);
            if (d < out.dist) {
              const inv = 1 / Math.max(1e-6, Math.sqrt(len2));
              out.dist = d; out.edge = e;
              out.s = a.s + (b.s - a.s) * t;
              out.x = px; out.z = pz; out.y = a.y + (b.y - a.y) * t;
              out.tx = dx * inv; out.tz = dz * inv;
            }
          }
        }
      }
      // Anything in a ring further out is at least (r * CELL) away.
      if (out.edge && out.dist <= r * CELL) break;
    }
    return out.edge ? out : null;
  }

  // ---- Dijkstra -----------------------------------------------------------
  const dist = new Float64Array(N);
  const prevNode = new Int32Array(N);
  const prevEdge = new Int32Array(N);
  const heapNode = new Int32Array(start[N] + 8);
  const heapKey = new Float64Array(start[N] + 8);
  let heapLen = 0;

  function push(n, k) {
    let i = heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= k) break;
      heapNode[i] = heapNode[p]; heapKey[i] = heapKey[p];
      i = p;
    }
    heapNode[i] = n; heapKey[i] = k;
  }
  function pop() {
    const top = heapNode[0];
    const n = heapNode[--heapLen], k = heapKey[heapLen];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapLen) break;
      if (c + 1 < heapLen && heapKey[c + 1] < heapKey[c]) c++;
      if (heapKey[c] >= k) break;
      heapNode[i] = heapNode[c]; heapKey[i] = heapKey[c];
      i = c;
    }
    heapNode[i] = n; heapKey[i] = k;
    return top;
  }

  /**
   * Cheapest path between two points ON edges, as a list of pieces
   * [{edge, s0, s1}] — each piece runs from s0 to s1 along its edge, which is
   * backwards when s1 < s0. Returns null only if the two are not connected,
   * which on this map never happens (every node reaches every other).
   *
   * `avoid(edge)` may veto edges outright.
   */
  function pathPieces(fromEdge, fromS, toEdge, toS, avoid = null) {
    const fe = typeof fromEdge === 'number' ? edges[fromEdge] : fromEdge;
    const te = typeof toEdge === 'number' ? edges[toEdge] : toEdge;
    if (!fe || !te) return null;

    dist.fill(Infinity);
    prevNode.fill(-1);
    prevEdge.fill(-1);
    heapLen = 0;
    const kf = edgeCost[fe.i] / Math.max(1e-6, fe.length);
    // Two virtual starts: leave the first edge by either end.
    dist[fe.a] = fromS * kf; push(fe.a, dist[fe.a]);
    const viaEnd = (fe.length - fromS) * kf;
    if (viaEnd < dist[fe.b]) { dist[fe.b] = viaEnd; push(fe.b, viaEnd); }

    while (heapLen) {
      const u = pop();
      const du = dist[u];
      for (let k = start[u]; k < start[u + 1]; k++) {
        const ei = adjEdge[k];
        if (avoid && avoid(edges[ei])) continue;
        const v = adjTo[k];
        const nd = du + edgeCost[ei];
        if (nd < dist[v]) {
          dist[v] = nd; prevNode[v] = u; prevEdge[v] = ei;
          push(v, nd);
        }
      }
    }

    const kt = edgeCost[te.i] / Math.max(1e-6, te.length);
    const viaA = dist[te.a] + toS * kt;
    const viaB = dist[te.b] + (te.length - toS) * kt;
    // Same edge: driving straight along it may beat any detour.
    const direct = fe === te ? Math.abs(toS - fromS) * kt : Infinity;
    if (!Number.isFinite(Math.min(viaA, viaB, direct))) return null;
    if (direct <= viaA && direct <= viaB) return [{ edge: fe, s0: fromS, s1: toS }];

    const endNode = viaA <= viaB ? te.a : te.b;
    const pieces = [{ edge: te, s0: endNode === te.a ? 0 : te.length, s1: toS }];
    let n = endNode;
    while (prevEdge[n] >= 0) {
      const e = edges[prevEdge[n]];
      const from = prevNode[n];
      pieces.push({ edge: e, s0: from === e.a ? 0 : e.length, s1: from === e.a ? e.length : 0 });
      n = from;
    }
    // n is now whichever end of the first edge the path left by.
    pieces.push({ edge: fe, s0: fromS, s1: n === fe.a ? 0 : fe.length });
    pieces.reverse();
    return pieces;
  }

  /** A Route between two world positions, snapped onto the network. */
  function route(ax, az, bx, bz, opts = {}) {
    const A = locate(ax, az, opts.maxR || 1500, opts.filter, {});
    const B = locate(bx, bz, opts.maxR || 1500, opts.filter, {});
    if (!A || !B) return null;
    const pieces = pathPieces(A.edge, A.s, B.edge, B.s, opts.avoid || null);
    return pieces ? buildRoute(pieces) : null;
  }

  /**
   * Walks forward from a node along the straightest continuation, never
   * revisiting a node, until `length` metres are covered. Used to find the
   * road a race will run and the run-up to a speed trap. `pick(e, turn)` can
   * reject an edge (return false) or bias the choice (return a cost).
   */
  function walk(fromNode, firstEdge, length, pick = null, rnd = null) {
    const seen = new Set([fromNode]);
    const pieces = [];
    let node = fromNode, e = firstEdge, total = 0;
    while (e && total < length) {
      const fwd = e.a === node;
      const next = fwd ? e.b : e.a;
      pieces.push({ edge: e, s0: fwd ? 0 : e.length, s1: fwd ? e.length : 0 });
      total += e.length;
      if (seen.has(next)) break;
      seen.add(next);
      // Heading at the end of this edge, in the direction of travel.
      const pts = e.pts;
      const p1 = fwd ? pts[pts.length - 1] : pts[0];
      const p0 = fwd ? pts[Math.max(0, pts.length - 3)] : pts[Math.min(pts.length - 1, 2)];
      const hx = p1.x - p0.x, hz = p1.z - p0.z;
      const hl = Math.hypot(hx, hz) || 1;
      let best = null, bestCost = Infinity;
      for (let k = start[next]; k < start[next + 1]; k++) {
        const ce = edges[adjEdge[k]];
        if (ce === e || seen.has(adjTo[k])) continue;
        const cf = ce.a === next;
        const q = ce.pts;
        const q0 = cf ? q[0] : q[q.length - 1];
        const q1 = cf ? q[Math.min(q.length - 1, 2)] : q[Math.max(0, q.length - 3)];
        const cx = q1.x - q0.x, cz = q1.z - q0.z;
        const cl = Math.hypot(cx, cz) || 1;
        const turn = Math.acos(Math.max(-1, Math.min(1, (hx * cx + hz * cz) / (hl * cl))));
        let cost = turn;
        if (pick) {
          const r = pick(ce, turn);
          if (r === false) continue;
          if (typeof r === 'number') cost = r;
        }
        if (rnd) cost += rnd() * 0.25;
        if (cost < bestCost) { bestCost = cost; best = ce; }
      }
      node = next;
      e = best;
    }
    return pieces;
  }

  function routeFromPieces(pieces) { return buildRoute(pieces); }

  return {
    nodes, edges, edgeCost, locate, pathPieces, route, walk,
    routeFromPieces,
    /** Neighbours of a node, as [edge, otherNode] pairs — for the harness. */
    neighbours(n) {
      const out = [];
      for (let k = start[n]; k < start[n + 1]; k++) out.push([edges[adjEdge[k]], adjTo[k]]);
      return out;
    },
  };
}

/**
 * Concatenates edge pieces into one polyline with cumulative distance, road
 * half-width and surface kind at every point.
 */
export function buildRoute(pieces) {
  // Count first, so the arrays are allocated exactly once.
  let cap = 2;
  for (const p of pieces) cap += p.edge.pts.length + 2;
  const xs = new Float32Array(cap), zs = new Float32Array(cap), ys = new Float32Array(cap);
  const ds = new Float64Array(cap), hw = new Float32Array(cap);
  const kind = new Uint8Array(cap);
  const edgeOf = new Int32Array(cap);
  let n = 0;

  const add = (x, z, y, half, k, ei) => {
    if (n > 0) {
      const dx = x - xs[n - 1], dz = z - zs[n - 1];
      const d = Math.hypot(dx, dz);
      if (d < 0.5) return;            // a join, or two samples on top of each other
      ds[n] = ds[n - 1] + d;
    } else ds[n] = 0;
    xs[n] = x; zs[n] = z; ys[n] = y; hw[n] = half; kind[n] = k; edgeOf[n] = ei;
    n++;
  };

  for (const p of pieces) {
    const e = p.edge, pts = e.pts;
    const half = (e.width || 8) * 0.5;
    const k = KIND_CODE[e.kind] != null ? KIND_CODE[e.kind] : 0;
    const lo = Math.min(p.s0, p.s1), hi = Math.max(p.s0, p.s1);
    const a = pointAt(pts, p.s0), b = pointAt(pts, p.s1);
    add(a.x, a.z, a.y, half, k, e.i);
    if (p.s1 >= p.s0) {
      for (let i = 0; i < pts.length; i++) if (pts[i].s > lo && pts[i].s < hi) add(pts[i].x, pts[i].z, pts[i].y, half, k, e.i);
    } else {
      for (let i = pts.length - 1; i >= 0; i--) if (pts[i].s > lo && pts[i].s < hi) add(pts[i].x, pts[i].z, pts[i].y, half, k, e.i);
    }
    add(b.x, b.z, b.y, half, k, e.i);
  }
  return makeRoute(xs, zs, ys, ds, hw, kind, edgeOf, n, pieces);
}

function pointAt(pts, s) {
  if (s <= pts[0].s) return pts[0];
  const last = pts[pts.length - 1];
  if (s >= last.s) return last;
  let lo = 0, hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[lo + 1];
  const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, s };
}

/**
 * A polyline you can ask two questions of: where is distance d along it, and
 * how far along it is the point nearest (x, z). Both answer into a caller's
 * object so a per-frame query allocates nothing.
 */
function makeRoute(xs, zs, ys, ds, hw, kind, edgeOf, n, pieces) {
  const length = n > 0 ? ds[n - 1] : 0;

  function indexAt(d) {
    if (d <= 0) return 0;
    if (d >= length) return Math.max(0, n - 2);
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid] <= d) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Position, tangent, half-width and kind at distance d. */
  function at(d, out) {
    const o = out || {};
    if (n < 2) { o.x = xs[0] || 0; o.z = zs[0] || 0; o.y = ys[0] || 0; o.tx = 0; o.tz = -1; o.hw = 4; o.kind = 0; o.i = 0; return o; }
    const i = indexAt(d);
    const seg = Math.max(1e-6, ds[i + 1] - ds[i]);
    const t = Math.max(0, Math.min(1, (d - ds[i]) / seg));
    o.x = xs[i] + (xs[i + 1] - xs[i]) * t;
    o.z = zs[i] + (zs[i + 1] - zs[i]) * t;
    o.y = ys[i] + (ys[i + 1] - ys[i]) * t;
    o.tx = (xs[i + 1] - xs[i]) / seg;
    o.tz = (zs[i + 1] - zs[i]) / seg;
    o.hw = hw[i]; o.kind = kind[i]; o.i = i; o.edge = edgeOf[i];
    return o;
  }

  /**
   * Distance along the route of the point nearest (x, z). With a hint the
   * search is confined to a window around the last answer, which is what makes
   * tracking the player along a 5 km route cost a few dozen segment tests a
   * frame rather than hundreds.
   */
  function project(x, z, hint = -1, window = 40, out) {
    const o = out || {};
    let i0 = 0, i1 = n - 2;
    if (hint >= 0) { i0 = Math.max(0, hint - window); i1 = Math.min(n - 2, hint + window); }
    let bd = Infinity, bi = 0, bt = 0;
    for (let i = i0; i <= i1; i++) {
      const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i];
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - xs[i]) * dx + (z - zs[i]) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = xs[i] + dx * t - x, pz = zs[i] + dz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < bd) { bd = d2; bi = i; bt = t; }
    }
    o.i = bi;
    o.d = ds[bi] + (ds[bi + 1] - ds[bi]) * bt;
    o.dist = Math.sqrt(bd);
    return o;
  }

  return { xs, zs, ys, ds, hw, kind, edgeOf, n, length, pieces, at, project, indexAt };
}
