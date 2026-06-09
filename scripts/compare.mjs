#!/usr/bin/env node
// Benchmark our routing engine against CanalPlanAC by running well-known canals
// end-to-end. Prints our distance / locks / time next to CanalPlanAC's published
// figures (where known), plus the canalplan.uk place links so you can check the
// rest by hand. Run: node scripts/compare.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanalGraph } from '../src/graph.js';
import { estimate, formatDuration, DEFAULTS } from '../src/time-model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public', 'data');
const J = (f) => JSON.parse(readFileSync(join(pub, f), 'utf8'));
const places = JSON.parse(readFileSync(join(root, 'data', 'places.geojson'), 'utf8').replace(/,(\s*[\]}])/g, '$1'));

const g = new CanalGraph().build(J('waterways.geojson'), J('locks.json'), J('facilities.json'));

function place(title) {
  for (const f of places.features) {
    const p = f.properties;
    if (p?.title === title && f.geometry?.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates;
      return { lng, lat, title, id: p.cp_id };
    }
  }
  return null;
}

// Curated end-to-end routes. ref = CanalPlanAC / standard published figures
// (miles, locks) where I'm confident; null where you should check by hand.
const ROUTES = [
  { name: 'Worcester & Birmingham (Tardebigge top→bottom)', a: 'Tardebigge Top Lock No 58', b: 'Tardebigge Bottom Lock No 29', ref: { mi: 2.5, locks: 30 } },
  { name: 'Worcester & Birmingham (Hanbury Jn→Kings Norton Jn)', a: 'Hanbury Junction', b: "King's Norton Junction", ref: { mi: 15, locks: 42 } },
  { name: 'Stratford Canal (Kings Norton Jn→Stratford)', a: "King's Norton Junction", b: 'Bancroft Basin', ref: { mi: 25.5, locks: 56 } },
  { name: 'Coventry Canal (Hawkesbury Jn→Fradley Jn)', a: 'Hawkesbury Junction', b: 'Fradley Junction', ref: { mi: 38, locks: 13 } },
  { name: 'Oxford Canal (Hawkesbury Jn→Napton Jn)', a: 'Hawkesbury Junction', b: 'Napton Junction', ref: null },
  { name: 'Llangollen (Hurleston Jn→Llangollen)', a: 'Hurleston Junction', b: 'Llangollen Wharf', ref: { mi: 46, locks: 21 } },
];

const s = DEFAULTS;
const pad = (x, n) => String(x).padEnd(n);
const padl = (x, n) => String(x).padStart(n);
console.log(pad('Route', 52), padl('our mi', 7), padl('locks', 6), padl('time', 9), '  | ', padl('ref mi', 7), padl('locks', 6), ' Δlocks');
console.log('-'.repeat(110));

for (const r of ROUTES) {
  const a = place(r.a), b = place(r.b);
  if (!a || !b) { console.log(pad(r.name, 52), ' — endpoint not found:', !a ? r.a : r.b); continue; }
  const res = g.route(a, b);
  if (!res) { console.log(pad(r.name, 52), ' — no route'); continue; }
  const est = estimate(res.miles, res.locks, s);
  const dl = r.ref ? res.locks - r.ref.locks : '';
  console.log(
    pad(r.name, 52),
    padl(res.miles.toFixed(1), 7),
    padl(res.locks, 6),
    padl(formatDuration(est.hours), 9),
    '  | ',
    padl(r.ref ? r.ref.mi : '—', 7),
    padl(r.ref ? r.ref.locks : '—', 6),
    padl(dl === '' ? '—' : (dl > 0 ? '+' + dl : dl), 7)
  );
}
console.log('-'.repeat(110));
console.log(`Time uses defaults: ${s.speedMph} mph, ${s.lockMinutes} min/lock, ${s.hoursPerDay} hrs/day.`);
console.log('Check any route on CanalPlanAC via the place pages, e.g. https://canalplan.uk/place/<id>:');
for (const r of ROUTES) { const a = place(r.a), b = place(r.b); if (a && b) console.log(`  ${r.name}: ${a.id} → ${b.id}`); }
