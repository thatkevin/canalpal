// Routing engine for the canal network — pure JS, no DOM/worker deps so it can
// be unit-tested / validated standalone.
//
// We build a welded planar graph from the waterway LineStrings:
//  - every vertex becomes a node, keyed by its coordinate quantised to ~1m, so
//    lines that share a vertex at a junction automatically connect;
//  - additionally, each line endpoint is welded to any nearby node within
//    WELD_M metres, to bridge junctions where the geometry doesn't share an
//    exact vertex.
// Edges carry haversine length and the waterway type (for per-type speeds).
// Locks are snapped to their nearest edge; a journey's lock count is the sum of
// chamber counts on the traversed edges.

// Boater service types for the "nearest facilities from here" search.
const SERVICE_TYPES = new Set(['Water point', 'Fuel / diesel', 'Elsan / chemical toilet', 'Pump-out', 'Sanitary station', 'Rubbish disposal', 'Toilets']);

const QUANT = 1e5;            // 5 dp ≈ 1.1 m grid for vertex welding
const WELD_M = 12;            // bridge near-miss junctions up to this distance
const EARTH_R = 6371000;      // metres

const rad = (d) => (d * Math.PI) / 180;
export function haversine(aLng, aLat, bLng, bLat) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const la1 = rad(aLat);
  const la2 = rad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// Initial great-circle bearing from A to B, degrees clockwise from north.
export function bearing(aLng, aLat, bLng, bLat) {
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Project point P onto segment AB; return {t, lng, lat, dist} (dist in metres).
// Uses a local equirectangular approximation — fine at canal scale.
function projectToSegment(plng, plat, alng, alat, blng, blat) {
  const cosLat = Math.cos(rad((alat + blat) / 2));
  const ax = alng * cosLat, ay = alat;
  const bx = blng * cosLat, by = blat;
  const px = plng * cosLat, py = plat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const lng = (ax + t * dx) / cosLat;
  const lat = ay + t * dy;
  return { t, lng, lat, dist: haversine(plng, plat, lng, lat) };
}

// Simple uniform grid spatial index over lng/lat (degrees).
class Grid {
  constructor(cell = 0.01) { this.cell = cell; this.map = new Map(); }
  key(ix, iy) { return ix * 100000 + iy; }
  cellOf(lng, lat) { return [Math.floor(lng / this.cell), Math.floor(lat / this.cell)]; }
  insert(lng, lat, item) {
    const [ix, iy] = this.cellOf(lng, lat);
    const k = this.key(ix, iy);
    let a = this.map.get(k);
    if (!a) this.map.set(k, (a = []));
    a.push(item);
  }
  near(lng, lat, ring = 1) {
    const [ix, iy] = this.cellOf(lng, lat);
    const out = [];
    for (let x = ix - ring; x <= ix + ring; x++)
      for (let y = iy - ring; y <= iy + ring; y++) {
        const a = this.map.get(this.key(x, y));
        if (a) out.push(...a);
      }
    return out;
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, cost) {
    const a = this.a; a.push({ node, cost });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; this._down(0); }
    return top;
  }
  _down(i) {
    const a = this.a, n = a.length;
    for (;;) {
      let s = i, l = 2 * i + 1, r = l + 1;
      if (l < n && a[l].cost < a[s].cost) s = l;
      if (r < n && a[r].cost < a[s].cost) s = r;
      if (s === i) break;
      [a[s], a[i]] = [a[i], a[s]]; i = s;
    }
  }
}

export class CanalGraph {
  constructor() {
    this.nodes = [];          // [lng, lat] per node id
    this.adj = [];            // adj[id] = [{to, w, edge}]
    this.edges = [];          // edge.type, edge.locks (chamber count)
    this._key = new Map();    // quantised coord -> node id
    this._nodeGrid = new Grid(0.01);
    this._edgeGrid = new Grid(0.01);
    this._facGrid = new Grid(0.01);
    this.facilities = [];
  }

  _nodeAt(lng, lat) {
    const qk = Math.round(lng * QUANT) + ':' + Math.round(lat * QUANT);
    let id = this._key.get(qk);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push([lng, lat]);
      this.adj.push([]);
      this._key.set(qk, id);
      this._nodeGrid.insert(lng, lat, id);
    }
    return id;
  }

  // Find an existing node within WELD_M metres (for endpoint welding).
  _weldNode(lng, lat) {
    let best = -1, bd = WELD_M;
    for (const id of this._nodeGrid.near(lng, lat, 1)) {
      const [nl, na] = this.nodes[id];
      const d = haversine(lng, lat, nl, na);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  _addEdge(a, b, type, name) {
    if (a === b) return;
    const [al, aa] = this.nodes[a];
    const [bl, ba] = this.nodes[b];
    const w = haversine(al, aa, bl, ba);
    const edgeId = this.edges.length;
    const excluded = type.indexOf('_excluded') !== -1;
    this.edges.push({ type, locks: 0, lockList: [], excluded, name: excluded ? name : undefined });
    this.adj[a].push({ to: b, w, edge: edgeId });
    this.adj[b].push({ to: a, w, edge: edgeId });
    // index the edge by both endpoint cells for snapping
    this._edgeGrid.insert(al, aa, edgeId);
    this._edgeGrid.insert(bl, ba, edgeId);
    this._edgeEnds ??= [];
    this._edgeEnds[edgeId] = [a, b];
  }

  build(waterways, locks, facilities) {
    for (const f of waterways.features) {
      const g = f.geometry;
      if (!g) continue;
      const type = f.properties?.cp_type || 'narrow';
      const name = f.properties?.cp_name || 'Unnamed waterway';
      const lines = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
      for (const line of lines) {
        let prev = -1;
        for (let i = 0; i < line.length; i++) {
          const [lng, lat] = line[i];
          let id = this._nodeAt(lng, lat);
          // weld line endpoints to a nearby existing node if vertices don't coincide
          if (i === 0 || i === line.length - 1) {
            const w = this._weldNode(lng, lat);
            if (w !== -1 && w !== id) id = w;
          }
          if (prev !== -1) this._addEdge(prev, id, type, name);
          prev = id;
        }
      }
    }
    if (locks) this._snapLocks(locks);
    if (facilities) this._indexFacilities(facilities);
    return this;
  }

  _nearestEdge(lng, lat, ring = 1) {
    let best = null, bd = Infinity;
    for (const edgeId of this._edgeGrid.near(lng, lat, ring)) {
      const [a, b] = this._edgeEnds[edgeId];
      const [al, aa] = this.nodes[a], [bl, ba] = this.nodes[b];
      const pr = projectToSegment(lng, lat, al, aa, bl, ba);
      if (pr.dist < bd) { bd = pr.dist; best = { edgeId, a, b, ...pr, dist: pr.dist }; }
    }
    if (!best && ring < 4) return this._nearestEdge(lng, lat, ring + 1);
    return best;
  }

  _snapLocks(locks) {
    this.lockData = locks; // kept for flight grouping (lockGroups)
    for (const lk of locks) {
      const e = this._nearestEdge(lk.lng, lk.lat);
      if (e && e.dist < 60) {
        const ed = this.edges[e.edgeId];
        ed.locks += lk.chambers || 1;
        ed.lockList.push({ lng: lk.lng, lat: lk.lat, rot: lk.rot ?? 0, flip: !!lk.flip, chambers: lk.chambers || 1, title: lk.title });
      }
    }
  }

  _indexFacilities(facilities) {
    this.facilities = facilities;
    this.facByNode = new Map(); // nodeId -> [service facilities] for nearest-from-here
    for (let i = 0; i < facilities.length; i++) {
      const f = facilities[i];
      this._facGrid.insert(f.lng, f.lat, i);
      if (SERVICE_TYPES.has(f.type)) {
        const n = this._nearestNode(f.lng, f.lat);
        if (n !== -1) { let a = this.facByNode.get(n); if (!a) this.facByNode.set(n, (a = [])); a.push(f); }
      }
    }
  }

  _nearestNode(lng, lat, maxM = 120) {
    let best = -1, bd = maxM;
    for (const id of this._nodeGrid.near(lng, lat, 1)) {
      const d = haversine(lng, lat, ...this.nodes[id]);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // Nearest boater services (water, fuel, elsan, rubbish, pump-out) reachable
  // along the network from a point, in any direction. One per type.
  nearestServices(start, opts = {}) {
    const { speedMph = 3, lockMinutes = 12, hoursPerDay = 7, maxDays = 3 } = opts;
    const se = this._nearestEdge(start.lng, start.lat);
    if (!se) return [];
    const N = this.nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const locksTo = new Int32Array(N);
    const heap = new MinHeap();
    dist[se.a] = haversine(se.lng, se.lat, ...this.nodes[se.a]); heap.push(se.a, dist[se.a]);
    dist[se.b] = haversine(se.lng, se.lat, ...this.nodes[se.b]); heap.push(se.b, dist[se.b]);
    // distance ceiling for `maxDays` of cruising (locks only make it slower, so
    // this is a safe upper bound); the per-service time check does the rest.
    const maxHours = maxDays * hoursPerDay;
    const maxM = maxHours * speedMph * 1609.344;
    const time = (miles, locks) => miles / speedMph + (locks * lockMinutes) / 60;
    const found = new Map();
    let remaining = SERVICE_TYPES.size;
    let settled = 0;
    while (heap.size && remaining > 0) {
      const { node, cost } = heap.pop();
      if (cost > dist[node]) continue;
      if (cost > maxM) break;
      if (++settled > 80000) break; // bound work when sparse types are never found

      const facs = this.facByNode.get(node);
      if (facs) for (const f of facs) {
        if (found.has(f.type)) continue;
        const miles = cost / 1609.344, locks = locksTo[node], hrs = time(miles, locks);
        if (hrs > maxHours) continue; // beyond the day budget
        found.set(f.type, { type: f.type, title: f.title, lng: f.lng, lat: f.lat, miles, locks, hours: hrs, days: Math.max(1, Math.ceil(hrs / hoursPerDay)), bearing: bearing(start.lng, start.lat, f.lng, f.lat) });
        remaining--;
      }
      for (const e of this.adj[node]) {
        const nd = cost + e.w;
        if (nd < dist[e.to]) { dist[e.to] = nd; locksTo[e.to] = locksTo[node] + this.edges[e.edge].locks; heap.push(e.to, nd); }
      }
    }
    return [...found.values()].sort((a, b) => a.miles - b.miles);
  }

  // Group locks into flights: runs of locks in a row on the same stretch of canal,
  // not crossing a junction (a node with >2 ways) and within maxGapM along the
  // water. So Caen Hill's 16 chain into one marker, but locks either side of a
  // junction stay separate. Returns one marker per flight:
  // { lng, lat, rot, count, chambers, title }.
  lockGroups(maxGapM = 400) {
    const locks = this.lockData || [];
    const N = locks.length;
    if (!N) return [];
    const Nn = this.nodes.length;
    const node = new Int32Array(N).fill(-1);   // each lock's nearest graph node
    const nodeLocks = new Map();               // nodeId -> [lockIdx]
    for (let i = 0; i < N; i++) {
      const n = this._nearestNode(locks[i].lng, locks[i].lat, 120);
      node[i] = n;
      if (n >= 0) { let a = nodeLocks.get(n); if (!a) nodeLocks.set(n, (a = [])); a.push(i); }
    }
    // union-find: chain locks reachable within maxGapM without crossing a junction
    const parent = new Int32Array(N); for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const dist = new Float64Array(Nn);
    const stamp = new Int32Array(Nn).fill(-1); // avoids an O(N) reset per lock
    let token = 0;
    for (let i = 0; i < N; i++) {
      const s = node[i]; if (s < 0) continue;
      token++;
      dist[s] = 0; stamp[s] = token;
      const heap = new MinHeap(); heap.push(s, 0);
      while (heap.size) {
        const { node: u, cost } = heap.pop();
        if (stamp[u] === token && cost > dist[u]) continue;
        const here = nodeLocks.get(u);
        if (here) for (const j of here) if (j !== i) union(i, j);
        if (u !== s && this.adj[u].length > 2) continue; // stop at a junction
        for (const e of this.adj[u]) {
          const nd = cost + e.w;
          if (nd <= maxGapM && (stamp[e.to] !== token || nd < dist[e.to])) { dist[e.to] = nd; stamp[e.to] = token; heap.push(e.to, nd); }
        }
      }
    }
    const groups = new Map();
    for (let i = 0; i < N; i++) { const r = find(i); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(i); }
    const out = [];
    for (const idxs of groups.values()) {
      let lng = 0, lat = 0, chambers = 0;
      for (const j of idxs) { lng += locks[j].lng; lat += locks[j].lat; chambers += locks[j].chambers || 1; }
      lng /= idxs.length; lat /= idxs.length;
      // anchor the marker on the flight's most central lock (so it sits on water)
      let best = idxs[0], bd = Infinity;
      for (const j of idxs) { const d = (locks[j].lng - lng) ** 2 + (locks[j].lat - lat) ** 2; if (d < bd) { bd = d; best = j; } }
      const rep = locks[best];
      out.push({ lng: rep.lng, lat: rep.lat, rot: (rep.rot || 0) + (rep.flip ? 180 : 0), count: idxs.length, chambers, title: rep.title });
    }
    return out;
  }

  // ---- connectivity diagnostics (used by the validation script) ----
  components() {
    const seen = new Int32Array(this.nodes.length).fill(-1);
    let comp = 0; const sizes = [];
    for (let s = 0; s < this.nodes.length; s++) {
      if (seen[s] !== -1) continue;
      let size = 0; const stack = [s]; seen[s] = comp;
      while (stack.length) {
        const u = stack.pop(); size++;
        for (const e of this.adj[u]) if (seen[e.to] === -1) { seen[e.to] = comp; stack.push(e.to); }
      }
      sizes.push(size); comp++;
    }
    sizes.sort((a, b) => b - a);
    return { count: comp, sizes };
  }

  // Nearest point on the navigable network to an arbitrary point (for snapping
  // a tapped/dragged marker onto the canal).
  snap(point) {
    const e = this._nearestEdge(point.lng, point.lat);
    return e ? { lng: e.lng, lat: e.lat, dist: e.dist } : null;
  }

  // ---- routing ----
  route(start, end) {
    const se = this._nearestEdge(start.lng, start.lat);
    const ee = this._nearestEdge(end.lng, end.lat);
    if (!se || !ee) return null;

    const N = this.nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prevNode = new Int32Array(N).fill(-1);
    const prevEdge = new Int32Array(N).fill(-1);
    const heap = new MinHeap();

    // seed from the two endpoints of the snapped start edge
    const seedA = haversine(se.lng, se.lat, ...this.nodes[se.a]);
    const seedB = haversine(se.lng, se.lat, ...this.nodes[se.b]);
    dist[se.a] = seedA; heap.push(se.a, seedA);
    dist[se.b] = seedB; heap.push(se.b, seedB);

    const tailA = haversine(ee.lng, ee.lat, ...this.nodes[ee.a]);
    const tailB = haversine(ee.lng, ee.lat, ...this.nodes[ee.b]);
    let settledEndA = false, settledEndB = false;

    while (heap.size) {
      const { node, cost } = heap.pop();
      if (cost > dist[node]) continue;
      if (node === ee.a) settledEndA = true;
      if (node === ee.b) settledEndB = true;
      if (settledEndA && settledEndB) break;
      for (const e of this.adj[node]) {
        // strongly prefer navigable water: disused/unnavigable edges cost 8× so
        // they're only used when there's genuinely no alternative.
        const nd = cost + e.w * (this.edges[e.edge].excluded ? 8 : 1);
        if (nd < dist[e.to]) {
          dist[e.to] = nd; prevNode[e.to] = node; prevEdge[e.to] = e.edge;
          heap.push(e.to, nd);
        }
      }
    }

    const totA = dist[ee.a] + tailA;
    const totB = dist[ee.b] + tailB;
    if (!isFinite(totA) && !isFinite(totB)) return null;
    const endNode = totA <= totB ? ee.a : ee.b;

    // walk back to whichever start endpoint we came from
    const nodeSeq = [];
    const edgeSeq = [];
    for (let u = endNode; u !== -1; u = prevNode[u]) {
      nodeSeq.push(u);
      if (prevEdge[u] !== -1) edgeSeq.push(prevEdge[u]);
      if (u === se.a || u === se.b) break;
    }
    nodeSeq.reverse(); edgeSeq.reverse();

    // assemble geometry + tallies
    const coords = [[se.lng, se.lat]];
    for (const id of nodeSeq) coords.push(this.nodes[id]);
    coords.push([ee.lng, ee.lat]);

    let metres = 0;
    for (let i = 1; i < coords.length; i++)
      metres += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);

    let locks = 0;
    const milesByType = {};
    const routeLocks = [];
    let excludedMiles = 0;
    const excludedNames = new Set();
    for (let i = 1; i < nodeSeq.length; i++) {
      const edgeId = edgeSeq[i - 1];
      if (edgeId === undefined) continue;
      const ed = this.edges[edgeId];
      locks += ed.locks;
      if (ed.lockList.length) routeLocks.push(...ed.lockList);
      const m = haversine(...this.nodes[nodeSeq[i - 1]], ...this.nodes[nodeSeq[i]]) / 1609.344;
      milesByType[ed.type] = (milesByType[ed.type] || 0) + m;
      if (ed.excluded) { excludedMiles += m; if (ed.name) excludedNames.add(ed.name); }
    }

    return {
      coords,
      miles: metres / 1609.344,
      furlongs: (metres / 1609.344) * 8,
      locks,
      milesByType,
      routeLocks,
      excludedMiles,
      excludedNames: [...excludedNames],
      facilities: this.facilitiesAlong(coords, 70),
    };
  }

  // Route through an ordered list of waypoints (>=2). Concatenates the legs,
  // sums distance + locks, and finds facilities over the whole journey.
  routeThrough(points) {
    if (!points || points.length < 2) return null;
    let coords = [];
    let metres = 0, locks = 0, excludedMiles = 0;
    const milesByType = {};
    const routeLocks = [];
    const excludedNames = new Set();
    for (let i = 0; i < points.length - 1; i++) {
      const leg = this.route(points[i], points[i + 1]);
      if (!leg || leg.error) return { error: 'no-route', legIndex: i };
      // drop the duplicated junction vertex between consecutive legs
      const segCoords = i > 0 ? leg.coords.slice(1) : leg.coords;
      coords = coords.concat(segCoords);
      locks += leg.locks;
      excludedMiles += leg.excludedMiles;
      for (const n of leg.excludedNames) excludedNames.add(n);
      routeLocks.push(...leg.routeLocks);
      for (const [t, m] of Object.entries(leg.milesByType)) milesByType[t] = (milesByType[t] || 0) + m;
    }
    for (let i = 1; i < coords.length; i++)
      metres += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    const miles = metres / 1609.344;
    return {
      coords, miles, furlongs: miles * 8, locks, milesByType, routeLocks,
      excludedMiles, excludedNames: [...excludedNames],
      legs: points.length - 1,
      facilities: this.facilitiesAlong(coords, 70),
    };
  }

  // Facilities within bufferM of the route polyline, ordered along the route.
  facilitiesAlong(coords, bufferM = 70) {
    const found = new Map(); // index -> {fac, along}
    let cumM = 0;
    for (let i = 1; i < coords.length; i++) {
      const [aLng, aLat] = coords[i - 1];
      const [bLng, bLat] = coords[i];
      const segLen = haversine(aLng, aLat, bLng, bLat);
      // candidate facilities near this segment's bbox cells
      const midL = (aLng + bLng) / 2, midA = (aLat + bLat) / 2;
      for (const fi of this._facGrid.near(midL, midA, 1)) {
        if (found.has(fi)) continue;
        const f = this.facilities[fi];
        const pr = projectToSegment(f.lng, f.lat, aLng, aLat, bLng, bLat);
        if (pr.dist <= bufferM) {
          found.set(fi, { ...f, along: cumM + pr.t * segLen, off: pr.dist });
        }
      }
      cumM += segLen;
    }
    return [...found.values()]
      .sort((a, b) => a.along - b.along)
      .map((f) => ({ type: f.type, title: f.title, lng: f.lng, lat: f.lat, miles: f.along / 1609.344 }));
  }
}
