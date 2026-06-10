#!/usr/bin/env node
// Preprocess CanalPlanAC mapping data into compact artefacts for the app.
//
// Inputs  (data/):
//   waterways.geojson   - 487 canal centrelines (LineStrings)
//   places.geojson      - 122k point features (locks, junctions, facilities ...)
//
// Outputs (public/data/):
//   waterways.geojson   - copied as-is (the routing graph is built in the worker)
//   locks.json          - [{lng,lat,chambers,title}]   ~2.2k locks
//   facilities.json     - [{lng,lat,type,title}]        amenity points for along-route queries
//
// Run: node scripts/preprocess.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const outDir = join(root, 'public', 'data');
mkdirSync(outDir, { recursive: true });

// The source files have trailing commas before the closing `]` (invalid JSON),
// so parse tolerantly.
function loadGeoJSON(path) {
  let txt = readFileSync(path, 'utf8');
  txt = txt.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(txt);
}

// --- load places (a real FeatureCollection) ---
const places = loadGeoJSON(join(dataDir, 'places.geojson'));

// cp-lockN icon suffix encodes staircase / chamber count (cp-lock = 1, cp-lock5 = 5 ...).
// "_flip" is just a rendering mirror, ignore it.
function chambersFromIcon(icon) {
  const m = /^cp-lock(\d+)/.exec(icon);
  return m ? parseInt(m[1], 10) : 1;
}

// Map facility icons to a friendly type. These drive the "facilities on the way" list.
const FACILITY_TYPES = {
  'cp-water': 'Water point',
  'cp-elsan': 'Elsan / chemical toilet',
  'cp-pumpout': 'Pump-out',
  'cp-sanstation': 'Sanitary station',
  'cp-rubbish': 'Rubbish disposal',
  'cp-recycling': 'Recycling',
  'cp-fuel': 'Fuel / diesel',
  'cp-boatyard': 'Boatyard',
  'cp-pub': 'Pub',
  'cp-bar': 'Bar',
  'cp-restaurant': 'Restaurant',
  'cp-takeaway': 'Takeaway',
  'cp-coffeeshop': 'Coffee shop',
  'cp-shop': 'Shop',
  'cp-supermarket': 'Supermarket',
  'cp-genshop': 'General store',
  'cp-miscshop': 'Shop',
  'cp-diy': 'DIY / hardware',
  'cp-pharmacy': 'Chemist',
  'cp-laundry': 'Laundry',
  'cp-toilet': 'Toilets',
  'cp-mooring': 'Mooring',
  'cp-wmooring': 'Visitor mooring',
  'cp-water,cp-elsan': 'Services',
};

const locks = [];
const facilities = [];
const named = []; // searchable gazetteer: anything with a real name

for (const f of places.features) {
  const p = f.properties;
  if (!p || !f.geometry || f.geometry.type !== 'Point') continue;
  const [lng, lat] = f.geometry.coordinates;
  const icon = p.icon || '';

  if (p.title) named.push({ name: p.title, lng, lat, layer: p.layer || '', id: p.cp_id || '' });

  if (p.layer === 'locks' || icon.startsWith('cp-lock')) {
    locks.push({
      lng, lat, chambers: chambersFromIcon(icon), title: p.title || 'Lock',
      rot: p.cp_rotate || 0, flip: icon.endsWith('_flip'),
    });
    continue;
  }
  const type = FACILITY_TYPES[icon];
  if (type) {
    facilities.push({ lng, lat, type, title: p.title || type });
  }
}

// round coords to ~1m to shrink the JSON
const r = (n) => Math.round(n * 1e5) / 1e5;
for (const l of locks) { l.lng = r(l.lng); l.lat = r(l.lat); }
for (const f of facilities) { f.lng = r(f.lng); f.lat = r(f.lat); }
for (const n of named) { n.lng = r(n.lng); n.lat = r(n.lat); }
named.sort((a, b) => a.name.localeCompare(b.name));

// clean + re-emit waterways as valid minified GeoJSON
const waterways = loadGeoJSON(join(dataDir, 'waterways.geojson'));

// Locality for each place = the waterway it sits on (good "where is this" hint,
// e.g. a Birmingham bridge -> "Birmingham Canal Navigations"). Built from a grid
// of waterway vertices -> trimmed waterway name; assign nearest to each place.
function buildLocator(ww) {
  const cell = 0.02;
  const grid = new Map();
  const key = (ix, iy) => ix * 100000 + iy;
  for (const f of ww.features) {
    let name = (f.properties?.cp_name || '').replace(/\s*\(.*$/, '').trim();
    if (!name) continue;
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) for (const [lng, lat] of line) {
      const k = key(Math.floor(lng / cell), Math.floor(lat / cell));
      let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push([lng, lat, name]);
    }
  }
  return (lng, lat) => {
    const ix = Math.floor(lng / cell), iy = Math.floor(lat / cell);
    let best = null, bd = Infinity;
    for (let x = ix - 1; x <= ix + 1; x++) for (let y = iy - 1; y <= iy + 1; y++) {
      const a = grid.get(key(x, y)); if (!a) continue;
      for (const [vl, va, nm] of a) { const d = (vl - lng) ** 2 + (va - lat) ** 2; if (d < bd) { bd = d; best = nm; } }
    }
    return best;
  };
}
const locate = buildLocator(waterways);
for (const n of named) n.region = locate(n.lng, n.lat) || '';

writeFileSync(join(outDir, 'locks.json'), JSON.stringify(locks));
writeFileSync(join(outDir, 'facilities.json'), JSON.stringify(facilities));
writeFileSync(join(outDir, 'places-named.json'), JSON.stringify(named));
writeFileSync(join(outDir, 'waterways.geojson'), JSON.stringify(waterways));

const totalChambers = locks.reduce((s, l) => s + l.chambers, 0);
console.log(`locks:      ${locks.length} markers, ${totalChambers} chambers`);
console.log(`facilities: ${facilities.length}`);
console.log(`named:      ${named.length} searchable places`);
console.log(`waterways:  copied`);
console.log(`-> ${outDir}`);
