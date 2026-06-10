#!/usr/bin/env node
// Enrich our pub/bar points with names from OpenStreetMap (the CanalPlanAC export
// has locations but no names). Queries Overpass for GB pubs+bars (tiled to avoid
// timeouts), matches each of our points to the nearest OSM pub within ~70 m, and
// writes the name into public/data/facilities.json.
//
// Run after `npm run preprocess`:  node scripts/enrich-pubs.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const facPath = join(root, 'public', 'data', 'facilities.json');
const facilities = JSON.parse(readFileSync(facPath, 'utf8'));

// GB latitude bands (keep each Overpass query small)
const bands = [];
for (let lat = 49.8; lat < 59; lat += 1.5) bands.push([lat, Math.min(lat + 1.5, 59)]);
const LNG = [-8.3, 1.9];

const EARTH = 6371000, rad = (d) => (d * Math.PI) / 180;
const metres = (aLng, aLat, bLng, bLat) => {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
};

// uniform grid index over OSM pubs
const cell = 0.01, grid = new Map();
const key = (ix, iy) => ix * 1e6 + iy;
let osmCount = 0;
function add(lng, lat, name) {
  osmCount++;
  const k = key(Math.floor(lng / cell), Math.floor(lat / cell));
  let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push([lng, lat, name]);
}

async function fetchBand([s, n]) {
  const bbox = `${s},${LNG[0]},${n},${LNG[1]}`;
  const q = `[out:json][timeout:120];(node["amenity"="pub"]["name"](${bbox});node["amenity"="bar"]["name"](${bbox}););out;`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'CanalPal/1.0 (https://github.com/thatkevin/canalpal)' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error('overpass ' + res.status);
      const d = await res.json();
      for (const e of d.elements) if (e.lon != null && e.tags?.name) add(e.lon, e.lat, e.tags.name);
      return d.elements.length;
    } catch (e) {
      console.error(`  band ${s} attempt ${attempt + 1}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return 0;
}

for (const band of bands) {
  const n = await fetchBand(band);
  console.log(`band ${band[0].toFixed(1)}–${band[1].toFixed(1)}: ${n} pubs`);
  await new Promise((r) => setTimeout(r, 3000)); // be kind to Overpass
}
console.log(`OSM pubs indexed: ${osmCount}`);

function nearestName(lng, lat, maxM = 110) {
  const ix = Math.floor(lng / cell), iy = Math.floor(lat / cell);
  let best = null, bd = maxM;
  for (let x = ix - 1; x <= ix + 1; x++) for (let y = iy - 1; y <= iy + 1; y++) {
    const a = grid.get(key(x, y)); if (!a) continue;
    for (const [ol, oa, nm] of a) { const d = metres(lng, lat, ol, oa); if (d < bd) { bd = d; best = nm; } }
  }
  return best;
}

let named = 0;
for (const f of facilities) {
  if (f.type !== 'Pub' && f.type !== 'Bar') continue;
  if (f.title && f.title !== f.type) continue; // already named
  const nm = nearestName(f.lng, f.lat);
  if (nm) { f.title = nm; named++; }
}
writeFileSync(facPath, JSON.stringify(facilities));
const pubs = facilities.filter((f) => f.type === 'Pub' || f.type === 'Bar').length;
console.log(`named ${named} of ${pubs} pubs/bars -> ${facPath}`);
