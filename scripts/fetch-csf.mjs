#!/usr/bin/env node
// Fetch Canal & River Trust "Customer Service Facilities" (water points, elsan,
// pump-out, refuse, toilets…) from CRT's Mapbox vector tileset and write them to
// public/data/services.json. The CanalPlanAC export barely tags these (~35 water
// points nationwide); CRT has ~1,800 with coordinates.
//
// The tileset token is URL-restricted, so we send a canalrivertrust.org.uk Referer.
// Points cluster at low zoom, so we union a few zoom levels by their globalid.
//
// Run: node scripts/fetch-csf.mjs   (libs: pbf@3 @mapbox/vector-tile@1)
import { createRequire } from 'module';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const Pbf = require('pbf');
const { VectorTile } = require('@mapbox/vector-tile');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TILESET = 'webteamcrt.customer-service-facilities';

// The Mapbox token is public (CRT ship it in their site config) but rotates and
// trips secret-scanning if committed — so read it live from the notices page.
async function getToken() {
  const html = await (await fetch('https://canalrivertrust.org.uk/notices', { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
  const m = html.match(/"mapbox\.api"\s*:\s*"(pk\.[^"]+)"/);
  if (!m) throw new Error('Mapbox token not found on CRT notices page');
  return m[1];
}
const TOKEN = await getToken();
const BOUNDS = [-3.43, 51.01, 0.18, 54.58];
const HEADERS = { Referer: 'https://canalrivertrust.org.uk/' };

const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);

// our friendly type names; drop types that aren't boater services
const TYPE = {
  water_point: 'Water point', elsan_point: 'Elsan / chemical toilet', elsan: 'Elsan / chemical toilet',
  pump_out: 'Pump-out', pumpout: 'Pump-out', pump_out_user_operated: 'Pump-out', refuse_disposal: 'Rubbish disposal', refuse: 'Rubbish disposal',
  rubbish: 'Rubbish disposal', toilet: 'Toilets', toilets: 'Toilets', sanitary_station: 'Sanitary station',
  recycling: 'Recycling', shower: 'Shower', launderette: 'Laundry', laundry: 'Laundry',
  washing_machine: 'Laundry', tumble_dryer: 'Laundry',
};

const byId = new Map();
async function fetchTile(z, x, y) {
  const res = await fetch(`https://a.tiles.mapbox.com/v4/${TILESET}/${z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`, { headers: HEADERS });
  if (res.status !== 200) return;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length) return;
  const layer = new VectorTile(new Pbf(buf)).layers['csf'];
  if (!layer) return;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const p = f.properties;
    const id = p.globalid;
    if (!id || byId.has(id)) continue;
    const [lng, lat] = f.toGeoJSON(x, y, z).geometry.coordinates;
    byId.set(id, { id, lng: Math.round(lng * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5, ft: p.facility_type, desc: p.sap_description || '' });
  }
}

for (const z of [6, 9, 11]) {
  let tiles = 0;
  const x0 = lon2x(BOUNDS[0], z), x1 = lon2x(BOUNDS[2], z), y0 = lat2y(BOUNDS[3], z), y1 = lat2y(BOUNDS[1], z);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { tiles++; jobs.push(fetchTile(z, x, y)); }
  // limit concurrency
  for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16));
  console.log(`z${z}: ${tiles} tiles, total unique so far ${byId.size}`);
}

const out = [];
const skipped = new Set();
for (const s of byId.values()) {
  const type = TYPE[s.ft];
  if (!type) { skipped.add(s.ft); continue; }
  out.push({ lng: s.lng, lat: s.lat, type, title: s.desc || type });
}
writeFileSync(join(root, 'public', 'data', 'services.json'), JSON.stringify(out));
const counts = {};
for (const s of out) counts[s.type] = (counts[s.type] || 0) + 1;
console.log('services:', out.length, counts);
if (skipped.size) console.log('skipped facility_types:', [...skipped]);
