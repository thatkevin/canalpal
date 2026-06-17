#!/usr/bin/env node
// Build our three data artefacts from OpenStreetMap instead of CanalPlanAC, via
// the Overpass API. OSM is ODbL: commercial use is fine with attribution (and
// share-alike only on a redistributed *database*, not on the app itself).
//
// Emits, into data/osm/ (so it never clobbers the live CanalPlan-derived files):
//   waterways.geojson  - canal/navigable centrelines, {cp_type,cp_name,cp_id}
//   locks.json         - [{lng,lat,chambers,title,rot,flip}]
//   facilities.json    - [{lng,lat,type,title}]
// shaped EXACTLY like scripts/preprocess.mjs output, so they drop straight into
// new CanalGraph().build(waterways, locks, facilities).
//
// Key modelling note: CanalPlanAC put ONE marker per staircase and encoded the
// chamber count in the icon (cp-lockN). OSM maps ONE way per chamber (lock=yes),
// so we emit chambers:1 per chamber and let CanalGraph._snapLocks sum them per
// edge and lockGroups() cluster the flights. No staircase decoding needed.
//
// Usage:
//   node scripts/fetch-osm.mjs                 # default bbox: Worcester & Birmingham
//   node scripts/fetch-osm.mjs --bbox S,W,N,E  # custom area
//   node scripts/fetch-osm.mjs --compare       # route ALL canalplan-refs.json chunks
//                                              #   (fetches a region per route, cached)
//   node scripts/fetch-osm.mjs --compare-only  # re-route from cache, no fetching
//
// Run gently — Overpass is a shared free service.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, 'data', 'osm');
const cacheDir = join(outDir, 'cache');
mkdirSync(cacheDir, { recursive: true });

const args = process.argv.slice(2);
// --compare      : fetch each route's region (cached), then route all chunks
// --compare-only : skip fetching, reuse the per-route caches and just route
const COMPARE_ONLY = args.includes('--compare-only');
const COMPARE = COMPARE_ONLY || args.includes('--compare');
// --national : tile the whole GB canal network, merge, write artefacts + validate
const NATIONAL = args.includes('--national');
// --rivers : also merge named navigable rivers into the graph. OFF by default:
// they form their OWN disconnected river-only components rather than welding to
// canals (canals meet rivers mid-edge, not at a shared node), so they hurt more
// than help. Properly bridging needs edge-snapping, not endpoint-welding (TODO).
const USE_RIVERS = args.includes('--rivers');
// Default bbox spans Worcester (south) to King's Norton (north), covering the
// whole Worcester & Birmingham canal incl. the Tardebigge flight + Hanbury Jn.
const bboxArg = args[args.indexOf('--bbox') + 1];
const DEFAULT_BBOX = args.includes('--bbox') && bboxArg
  ? bboxArg.split(',').map(Number)            // S,W,N,E
  : [52.16, -2.24, 52.42, -1.90];

// Several public Overpass mirrors; they get busy and 504, so we rotate + retry.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overpass(query, tries = 8) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'canalproject/osm-extract (me@kev.cc)' },
        body: 'data=' + encodeURIComponent(query),
      });
      const body = await res.text();
      if (res.status === 429 || res.status === 504 || body.includes('runtime error')) throw new Error(`${res.status} from ${url}`);
      if (!res.ok) throw new Error(`${res.status} from ${url}: ${body.slice(0, 120)}`);
      return JSON.parse(body).elements || [];
    } catch (e) {
      lastErr = e;
      // 429 = rate-limited (needs a real cool-off); otherwise linear backoff.
      const wait = /429/.test(e.message) ? 30000 : Math.min(45000, 4000 * (attempt + 1));
      console.warn(`  Overpass attempt ${attempt + 1}/${tries} failed (${e.message.slice(0, 60)}); waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;
const bboxStr = ([S, W, N, E]) => `${S},${W},${N},${E}`;
const centroid = (geometry) => {
  let x = 0, y = 0;
  for (const p of geometry) { x += p.lon; y += p.lat; }
  return { lng: r5(x / geometry.length), lat: r5(y / geometry.length) };
};

// ---- 1. waterways (canal centrelines) ----
// canal everywhere; navigable rivers (boat!=no) so river-linked canals connect.
// Disused / unnavigable stretches become *_excluded so routing avoids them
// unless there's no alternative (matches CanalGraph's 8× penalty).
async function fetchWaterways(box) {
  const bbox = bboxStr(box);
  const els = await overpass(`[out:json][timeout:180];
    (
      way["waterway"="canal"](${bbox});
      way["disused:waterway"="canal"](${bbox});
      way["waterway"="river"]["boat"!="no"](${bbox});
    );
    out geom;`);
  const features = [];
  for (const el of els) {
    if (!el.geometry || el.geometry.length < 2) continue;
    const t = el.tags || {};
    const disused = !!t['disused:waterway'] || t.waterway === 'disused' ||
      t.boat === 'no' || t.access === 'no' || t.navigation === 'no';
    const cp_type = disused ? 'narrow_excluded' : 'narrow';
    features.push({
      type: 'Feature',
      properties: { cp_type, cp_name: t.name || t.waterway_name || 'Unnamed waterway', cp_id: String(el.id) },
      geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [r5(p.lon), r5(p.lat)]) },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---- 2. locks (one entry per chamber) ----
async function fetchLocks(box) {
  const bbox = bboxStr(box);
  const els = await overpass(`[out:json][timeout:180];
    (
      way["lock"="yes"](${bbox});
      way["waterway"="lock"](${bbox});
      node["lock"="yes"](${bbox});
    );
    out geom;`);
  const locks = [];
  for (const el of els) {
    const t = el.tags || {};
    const pt = el.type === 'node'
      ? { lng: r5(el.lon), lat: r5(el.lat) }
      : (el.geometry?.length ? centroid(el.geometry) : null);
    if (!pt) continue;
    locks.push({
      ...pt, chambers: 1,
      title: t.lock_name || t.name || 'Lock',
      rot: 0, flip: false,           // OSM has no marker orientation; renderer copes
    });
  }
  // Dedupe chambers mapped twice (e.g. lock=yes way + standalone node) within ~20m.
  const out = [];
  for (const l of locks) {
    if (out.some((o) => Math.hypot((o.lng - l.lng) * 0.62, o.lat - l.lat) * 111000 < 20)) continue;
    out.push(l);
  }
  return out;
}

// ---- 3. facilities (boater services + amenities) ----
// Map OSM tags onto the same friendly type strings preprocess.mjs emits, so the
// SERVICE_TYPES set in graph.js keeps working for "nearest services from here".
function facilityType(t) {
  if (t.waterway === 'water_point' || t.amenity === 'drinking_water' || t.man_made === 'water_tap') return 'Water point';
  if (t.amenity === 'sanitary_dump_station' || t.waterway === 'sanitary_dump_station') return 'Pump-out';
  if (t.amenity === 'waste_disposal' && /chemical|elsan/i.test(t.waste || '')) return 'Elsan / chemical toilet';
  if (t.waterway === 'fuel' || (t.amenity === 'fuel' && t.fuel_diesel !== 'no')) return 'Fuel / diesel';
  if (t.amenity === 'recycling') return 'Recycling';
  if (t.amenity === 'waste_disposal' || t.amenity === 'waste_basket') return 'Rubbish disposal';
  if (t.amenity === 'toilets') return 'Toilets';
  if (t.amenity === 'pub') return 'Pub';
  if (t.amenity === 'bar') return 'Bar';
  if (t.amenity === 'restaurant') return 'Restaurant';
  if (t.amenity === 'cafe') return 'Coffee shop';
  if (t.shop === 'convenience' || t.shop === 'general') return 'General store';
  if (t.shop === 'supermarket') return 'Supermarket';
  if (t.craft === 'boatbuilder' || t.shop === 'boat') return 'Boatyard';
  return null;
}
async function fetchFacilities(box) {
  const bbox = bboxStr(box);
  const els = await overpass(`[out:json][timeout:180];
    (
      nwr["amenity"~"^(drinking_water|fuel|pub|bar|restaurant|cafe|toilets|waste_disposal|waste_basket|recycling|sanitary_dump_station)$"](${bbox});
      nwr["waterway"~"^(water_point|fuel|sanitary_dump_station)$"](${bbox});
      nwr["shop"~"^(convenience|general|supermarket|boat)$"](${bbox});
    );
    out center;`);
  const facilities = [];
  for (const el of els) {
    const t = el.tags || {};
    const type = facilityType(t);
    if (!type) continue;
    const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    if (lng == null || lat == null) continue;
    facilities.push({ lng: r5(lng), lat: r5(lat), type, title: t.name || type });
  }
  return facilities;
}

// ===================== NATIONAL MODE ===========================
// Tile the GB canal network (tiles seeded from the CanalPlan waterways extent so
// we don't query empty ocean), one COMBINED query per tile, merge with id dedup.
// Facilities are constrained to within 250 m of canals (around.w) so the national
// amenity volume stays sane. Rivers require explicit navigability (boat/motorboat/
// ship=yes) — nationally "boat!=no" would drag in every non-navigable stream.
function classify(els) {
  const waterways = [], lockEls = [], facs = [];
  for (const el of els) {
    const t = el.tags || {};
    const isWW = t.waterway === 'canal' || t.waterway === 'river' || t['disused:waterway'] === 'canal';
    if (isWW && el.geometry && el.geometry.length >= 2) {
      const disused = !!t['disused:waterway'] || t.waterway === 'disused' ||
        t.boat === 'no' || t.access === 'no' || t.navigation === 'no';
      waterways.push({
        type: 'Feature',
        properties: { cp_type: disused ? 'narrow_excluded' : 'narrow', cp_name: t.name || 'Unnamed waterway', cp_id: String(el.id) },
        geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [r5(p.lon), r5(p.lat)]) },
      });
    }
    if (t.lock === 'yes' || t.waterway === 'lock') {
      const pt = el.type === 'node' ? { lng: r5(el.lon), lat: r5(el.lat) } : (el.geometry?.length ? centroid(el.geometry) : null);
      if (pt) lockEls.push({ id: el.type + el.id, ...pt, chambers: 1, title: t.lock_name || t.name || 'Lock', rot: 0, flip: false });
    }
    const ft = facilityType(t);
    if (ft) {
      const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
      if (lng != null && lat != null) facs.push({ id: el.type + el.id, lng: r5(lng), lat: r5(lat), type: ft, title: t.name || ft });
    }
  }
  return { waterways, lockEls, facs };
}

// Network (waterways + locks) — cheap, geometric, ESSENTIAL. One query.
async function fetchNet(box) {
  const b = bboxStr(box);
  const els = await overpass(`[out:json][timeout:240];
    (
      way["waterway"="canal"](${b});
      way["disused:waterway"="canal"](${b});
      way["waterway"="river"]["boat"="yes"](${b});
      way["waterway"="river"]["motorboat"="yes"](${b});
      way["waterway"="river"]["ship"="yes"](${b});
      way["lock"="yes"](${b});
      way["waterway"="lock"](${b});
      node["lock"="yes"](${b});
    );
    out geom;`);
  const { waterways, lockEls } = classify(els);
  return { waterways, lockEls };
}

// Facilities within 200 m of canals — heavy (around-search), OPTIONAL. Separate
// query so a timeout here never loses the tile's network data.
async function fetchFac(box) {
  const b = bboxStr(box);
  const els = await overpass(`[out:json][timeout:240];
    (
      way["waterway"="canal"](${b});
      way["waterway"="river"]["boat"="yes"](${b});
    )->.w;
    (
      node(around.w:200)["amenity"~"^(drinking_water|fuel|pub|bar|restaurant|cafe|toilets|waste_disposal|waste_basket|recycling|sanitary_dump_station)$"];
      nwr(around.w:200)["waterway"~"^(water_point|fuel|sanitary_dump_station)$"];
      nwr(around.w:200)["shop"~"^(convenience|general|supermarket|boat)$"];
    );
    out center;`);
  return classify(els).facs;
}

// Major named navigable rivers — these BRIDGE canals that connect only via a river
// (Severn links the W&B/Staffs&Worcs/Gloucester&Sharpness; Trent, Yorkshire Ouse,
// Weaver, Nene, Soar, Lee, Wey, Avon, …). Tagged 'broad' (wide navigable water).
// Fetched separately so it doesn't invalidate the cached .net tiles. A non-
// navigable namesake (e.g. the Hampshire Avon) just forms its own stub and is
// dropped by the component prune.
const NAV_RIVERS = 'Severn|Trent|Thames|Weaver|Ouse|Aire|Nene|Soar|Lee|Lea|Wey|Medway|Avon|Calder|Don|Hull|Witham|Welland|Cam|Ure|Stort|Kennet';
async function fetchRivers(box) {
  const b = bboxStr(box);
  const els = await overpass(`[out:json][timeout:180];
    way["waterway"="river"]["name"~"River (${NAV_RIVERS})"](${b});
    out geom;`);
  return els.filter((el) => el.geometry && el.geometry.length >= 2).map((el) => ({
    type: 'Feature',
    properties: { cp_type: 'broad', cp_name: el.tags?.name || 'River', cp_id: 'r' + el.id },
    geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [r5(p.lon), r5(p.lat)]) },
  }));
}

if (NATIONAL) {
  const TILE = 1.5;
  const natDir = join(cacheDir, 'national');
  mkdirSync(natDir, { recursive: true });
  // occupied tiles from the CanalPlan extent (seed only — OSM is what we fetch)
  const cp = JSON.parse(readFileSync(join(root, 'data', 'waterways.geojson'), 'utf8').replace(/,(\s*[\]}])/g, '$1'));
  const tiles = new Map();
  for (const f of cp.features) {
    const ls = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of ls) for (const [x, y] of line) {
      const ix = Math.floor(x / TILE), iy = Math.floor(y / TILE);
      tiles.set(ix + ',' + iy, [iy * TILE, ix * TILE, (iy + 1) * TILE, (ix + 1) * TILE]); // S,W,N,E
    }
  }
  const tileList = [...tiles.entries()];
  console.log(`National pull: ${tileList.length} tiles of ${TILE}°. Combined query each (cached).`);

  const wwById = new Map(), facById = new Map();
  let allLocks = [];
  let done = 0;
  const failedNet = [], failedFac = [];
  for (const [key, box] of tileList) {
    done++;
    const netFile = join(natDir, key.replace(',', '_') + '.net.json');
    const facFile = join(natDir, key.replace(',', '_') + '.fac.json');
    // --- network (essential, non-fatal) ---
    let net = null;
    if (existsSync(netFile)) net = JSON.parse(readFileSync(netFile, 'utf8'));
    else {
      process.stdout.write(`  [${done}/${tileList.length}] tile ${key} network … `);
      try {
        net = await fetchNet(box);
        writeFileSync(netFile, JSON.stringify(net));
        console.log(`${net.waterways.length} ways, ${net.lockEls.length} locks`);
      } catch (e) { console.log(`FAILED (${e.message.slice(0, 40)}) — skipping tile`); failedNet.push(key); }
      await sleep(2000);
    }
    if (!net) continue;
    for (const w of net.waterways) if (!wwById.has(w.properties.cp_id)) wwById.set(w.properties.cp_id, w);
    allLocks.push(...net.lockEls);
    // --- facilities (optional, non-fatal) ---
    let facs = null;
    if (existsSync(facFile)) facs = JSON.parse(readFileSync(facFile, 'utf8'));
    else {
      process.stdout.write(`  [${done}/${tileList.length}] tile ${key} facilities … `);
      try {
        facs = await fetchFac(box);
        writeFileSync(facFile, JSON.stringify(facs));
        console.log(`${facs.length} facilities`);
      } catch (e) { console.log(`facilities timed out (${e.message.slice(0, 30)}) — keeping network only`); facs = []; failedFac.push(key); }
      await sleep(2000);
    }
    for (const f of facs) if (!facById.has(f.id)) facById.set(f.id, f);
    // --- named navigable rivers (opt-in via --rivers; see USE_RIVERS note) ---
    if (USE_RIVERS) {
      const rivFile = join(natDir, key.replace(',', '_') + '.riv.json');
      let rivers = null;
      if (existsSync(rivFile)) rivers = JSON.parse(readFileSync(rivFile, 'utf8'));
      else {
        process.stdout.write(`  [${done}/${tileList.length}] tile ${key} rivers … `);
        try {
          rivers = await fetchRivers(box);
          writeFileSync(rivFile, JSON.stringify(rivers));
          console.log(`${rivers.length} river ways`);
        } catch (e) { console.log(`rivers skipped (${e.message.slice(0, 30)})`); rivers = []; }
        await sleep(2000);
      }
      for (const w of rivers) if (!wwById.has(w.properties.cp_id)) wwById.set(w.properties.cp_id, w);
    }
  }
  if (failedNet.length) console.log(`\n⚠ network failed for tiles: ${failedNet.join(' ')} (rerun --national to retry)`);
  if (failedFac.length) console.log(`⚠ facilities skipped for tiles: ${failedFac.join(' ')} (rerun to backfill)`);

  // locks: dedup by OSM id, then by proximity (a chamber mapped as both a way and
  // a node, or caught in two overlapping tiles, within ~20 m).
  const byId = new Map();
  for (const l of allLocks) if (!byId.has(l.id)) byId.set(l.id, l);
  let locks = [];
  for (const l of byId.values()) {
    if (locks.some((o) => Math.hypot((o.lng - l.lng) * 0.62, o.lat - l.lat) * 111000 < 20)) continue;
    locks.push({ lng: l.lng, lat: l.lat, chambers: 1, title: l.title, rot: 0, flip: false });
  }
  let wwFeatures = [...wwById.values()];
  let facilities = [...facById.values()].map(({ id, ...f }) => f);

  // --- GB clip: tiles spill past the SE coast into French/Belgian canals (lng>2) ---
  const inGB = (lng, lat) => lng >= -8.5 && lng <= 1.95 && lat >= 49.8 && lat <= 61.0;
  const midIn = (f) => { const c = f.geometry.coordinates; const [x, y] = c[Math.floor(c.length / 2)]; return inGB(x, y); };
  const wwBefore = wwFeatures.length;
  wwFeatures = wwFeatures.filter(midIn);
  locks = locks.filter((l) => inGB(l.lng, l.lat));
  facilities = facilities.filter((f) => inGB(f.lng, f.lat));
  console.log(`\nMerged: ${wwBefore} ways (${wwFeatures.length} after GB clip), ${locks.length} locks, ${facilities.length} facilities`);

  const { CanalGraph } = await import('../src/graph.js');
  const WELD = 25; // raw OSM junctions are looser than CanalPlan's welded centrelines

  // component sizes per node (BFS over the adjacency)
  const componentSizes = (g) => {
    const comp = new Int32Array(g.nodes.length).fill(-1); const sizes = [];
    for (let s = 0; s < g.nodes.length; s++) {
      if (comp[s] !== -1) continue;
      const id = sizes.length; const st = [s]; comp[s] = id; let sz = 0;
      while (st.length) { const u = st.pop(); sz++; for (const e of g.adj[u]) if (comp[e.to] === -1) { comp[e.to] = id; st.push(e.to); } }
      sizes.push(sz);
    }
    return { comp, sizes };
  };
  const report = (label, g) => {
    const { sizes } = componentSizes(g); const sorted = [...sizes].sort((a, b) => b - a); const total = g.nodes.length;
    console.log(`${label}: ${g.nodes.length} nodes, ${sizes.length} components, largest ${sorted[0]} (${((sorted[0] / total) * 100).toFixed(1)}%)  [top: ${sorted.slice(0, 6).join(', ')}]`);
  };

  // build with junction bridging (weld 25 + edge-snap 30m), prune tiny stubs
  const BUILD = { weldM: WELD, bridge: true, snapM: 30 };
  let g = new CanalGraph(BUILD).build({ type: 'FeatureCollection', features: wwFeatures }, locks, facilities);
  report('post-clip, pre-prune', g);
  const { comp, sizes } = componentSizes(g);
  const keyOf = (lng, lat) => Math.round(lng * 1e5) + ':' + Math.round(lat * 1e5);
  const MIN_NODES = 20;
  wwFeatures = wwFeatures.filter((f) => {
    let best = 0;
    for (const [x, y] of f.geometry.coordinates) { const nid = g._key.get(keyOf(x, y)); if (nid !== undefined) { const sz = sizes[comp[nid]]; if (sz > best) best = sz; } }
    return best >= MIN_NODES;
  });

  // rebuild from the pruned network for the final artefacts + validation
  const waterways = { type: 'FeatureCollection', features: wwFeatures };
  g = new CanalGraph(BUILD).build(waterways, locks, facilities);
  report(`post-prune (<${MIN_NODES}-node stubs dropped)`, g);

  writeFileSync(join(outDir, 'waterways.geojson'), JSON.stringify(waterways));
  writeFileSync(join(outDir, 'locks.json'), JSON.stringify(locks));
  writeFileSync(join(outDir, 'facilities.json'), JSON.stringify(facilities));
  console.log(`-> ${outDir}  (${waterways.features.length} ways, ${locks.length} locks, ${facilities.length} facilities)`);
  console.log(`\nCanalPlan baseline for reference: largest component 89.7%`);

  // ---- validate: the two known CanalPlan routes ----
  const KNOWN = [
    { name: 'Hanbury Jn→Kings Norton Jn', a: { lng: -2.11476, lat: 52.26492 }, b: { lng: -1.92275, lat: 52.41232 }, ref: '15mi / 42 locks' },
    { name: 'Llangollen (Hurleston→Llangollen)', a: { lng: -2.55976, lat: 53.09389 }, b: { lng: -3.17056, lat: 52.97198 }, ref: '46mi / 21 locks' },
  ];
  for (const k of KNOWN) {
    const r = g.route(k.a, k.b);
    console.log(`${k.name.padEnd(34)} ${r ? `${r.miles.toFixed(1)}mi / ${r.locks} locks` : 'NO ROUTE'}   [CanalPlanAC ${k.ref}]`);
  }
  process.exit(0);
}

// ---- default mode: write the three artefacts for one bbox ----
if (!COMPARE) {
  console.log(`Fetching OSM for bbox ${bboxStr(DEFAULT_BBOX)} (S,W,N,E)...`);
  const waterways = await fetchWaterways(DEFAULT_BBOX);
  const locks = await fetchLocks(DEFAULT_BBOX);
  const facilities = await fetchFacilities(DEFAULT_BBOX);
  writeFileSync(join(outDir, 'waterways.geojson'), JSON.stringify(waterways));
  writeFileSync(join(outDir, 'locks.json'), JSON.stringify(locks));
  writeFileSync(join(outDir, 'facilities.json'), JSON.stringify(facilities));
  const km = waterways.features.reduce((s, f) => {
    const c = f.geometry.coordinates; let m = 0;
    for (let i = 1; i < c.length; i++) m += Math.hypot((c[i][0] - c[i - 1][0]) * 0.62, c[i][1] - c[i - 1][1]) * 111;
    return s + m;
  }, 0);
  console.log(`waterways:  ${waterways.features.length} ways, ~${km.toFixed(0)} km`);
  console.log(`locks:      ${locks.length} chambers`);
  console.log(`facilities: ${facilities.length}`);
  console.log(`-> ${outDir}`);
  process.exit(0);
}

// ===================== COMPARE MODE ============================
// One row per route in scripts/canalplan-refs.json. Endpoints are real OSM
// coordinates (named junctions/basins via Nominatim; lock chambers by lock_ref).
// Each route fetches its OWN region (bbox padded around the two endpoints) so the
// sub-network is self-contained; results cache to data/osm/cache/<key>.json.
const ROUTES = [
  { key: 'Worcester & Birmingham (Tardebigge top→bottom)',        a: { lng: -2.01034, lat: 52.32148 }, b: { lng: -2.05449, lat: 52.31010 } },
  { key: 'Worcester & Birmingham (Hanbury Jn→Kings Norton Jn)',   a: { lng: -2.11476, lat: 52.26492 }, b: { lng: -1.92275, lat: 52.41232 } },
  { key: 'Stratford Canal (Kings Norton Jn→Stratford)',          a: { lng: -1.92275, lat: 52.41232 }, b: { lng: -1.70286, lat: 52.19202 } },
  { key: 'Coventry Canal (Coventry Basin→Fradley Jn)',           a: { lng: -1.51137, lat: 52.41380 }, b: { lng: -1.79347, lat: 52.72363 } },
  { key: 'Oxford Canal (Hawkesbury Jn→Napton Jn)',               a: { lng: -1.46955, lat: 52.45738 }, b: { lng: -1.31535, lat: 52.25847 } },
  { key: 'Llangollen (Hurleston Jn→Llangollen)',                 a: { lng: -2.55976, lat: 53.09389 }, b: { lng: -3.17056, lat: 52.97198 } },
];
const PAD = 0.18; // degrees (~20 km) of slack so a wandering canal isn't clipped
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const refs = JSON.parse(readFileSync(join(here, 'canalplan-refs.json'), 'utf8')).routes || {};

async function regionFor(route) {
  const cacheFile = join(cacheDir, slug(route.key) + '.json');
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  if (COMPARE_ONLY) throw new Error(`no cache for "${route.key}" — run --compare first`);
  const box = [
    Math.min(route.a.lat, route.b.lat) - PAD, Math.min(route.a.lng, route.b.lng) - PAD,
    Math.max(route.a.lat, route.b.lat) + PAD, Math.max(route.a.lng, route.b.lng) + PAD,
  ];
  process.stdout.write(`  fetching region for ${route.key.slice(0, 40)}… `);
  const waterways = await fetchWaterways(box);
  const locks = await fetchLocks(box);
  console.log(`${waterways.features.length} ways, ${locks.length} locks`);
  const region = { box, waterways, locks };
  writeFileSync(cacheFile, JSON.stringify(region));
  await sleep(1500); // be polite between regions
  return region;
}

const { CanalGraph } = await import('../src/graph.js');
const fmt = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
const pad = (x, n) => String(x).padEnd(n);
const padl = (x, n) => String(x).padStart(n);

console.log(COMPARE_ONLY ? 'Routing from cache…\n' : 'Comparing all routes (fetching regions as needed)…\n');
const rows = [];
for (const route of ROUTES) {
  const { waterways, locks } = await regionFor(route);
  const g = new CanalGraph().build(waterways, locks, []);
  const res = g.route(route.a, route.b);
  const ref = refs[route.key] || {};
  rows.push({
    short: route.key,
    osmMi: res ? res.miles : null, osmLk: res ? res.locks : null,
    cpMi: ref.miles ?? null, cpLk: ref.locks ?? null,
  });
}

console.log(pad('Route', 52), padl('OSM mi', 7), padl('lk', 4), ' | ', padl('CP mi', 6), padl('lk', 4), ' | ', padl('Δmi', 6), padl('Δlk', 5));
console.log('-'.repeat(100));
for (const r of rows) {
  const dMi = r.osmMi != null && r.cpMi != null ? (r.osmMi - r.cpMi) : null;
  const dLk = r.osmLk != null && r.cpLk != null ? (r.osmLk - r.cpLk) : null;
  const sign = (n, d = 1) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d);
  console.log(
    pad(r.short.length > 52 ? r.short.slice(0, 51) + '…' : r.short, 52),
    padl(fmt(r.osmMi), 7), padl(r.osmLk ?? '—', 4), ' | ',
    padl(fmt(r.cpMi), 6), padl(r.cpLk ?? '—', 4), ' | ',
    padl(sign(dMi), 6), padl(sign(dLk, 0), 5),
  );
}
console.log('-'.repeat(100));
console.log('Δ = OSM − CanalPlanAC.  Routes with null CP refs show — (not yet collected by hand).');
