#!/usr/bin/env node
// Compare OUR journey times/speeds against CanalPlanAC's, for a curated set of
// canal "chunks". We do NOT scrape canalplan.uk: their robots.txt disallows the
// /cgi-bin/ planner and they block bots, and we rely on their goodwill (we use
// their data under a non-commercial + credit licence). So this script:
//   1. computes OUR distance / locks / time / implied mph for each route, and
//   2. merges CanalPlanAC figures you've collected BY HAND into
//      data/canalplan-refs.json (open each printed planner link in a browser —
//      that's normal human use — and read off their numbers).
// Then it prints ours-vs-theirs with deltas, so you can sanity-check the speed
// model. Run gently, by hand, a few routes at a time. Run: node scripts/compare-canalplan.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanalGraph } from '../src/graph.js';
import { estimate, formatDuration, DEFAULTS } from '../src/time-model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const J = (f) => JSON.parse(readFileSync(join(root, 'public', 'data', f), 'utf8'));
const places = JSON.parse(readFileSync(join(root, 'data', 'places.geojson'), 'utf8').replace(/,(\s*[\]}])/g, '$1'));
const refs = JSON.parse(readFileSync(join(root, 'data', 'canalplan-refs.json'), 'utf8')).routes || {};

const g = new CanalGraph().build(J('waterways.geojson'), J('locks.json'), J('facilities.json'));
const place = (title) => {
  for (const f of places.features) {
    if (f.properties?.title === title && f.geometry?.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates;
      return { lng, lat, title, id: f.properties.cp_id };
    }
  }
  return null;
};

// Curated chunks — add more here (keys must match data/canalplan-refs.json).
const ROUTES = [
  { name: 'Worcester & Birmingham (Tardebigge top→bottom)', a: 'Tardebigge Top Lock No 58', b: 'Tardebigge Bottom Lock No 29' },
  { name: 'Worcester & Birmingham (Hanbury Jn→Kings Norton Jn)', a: 'Hanbury Junction', b: "King's Norton Junction" },
  { name: 'Stratford Canal (Kings Norton Jn→Stratford)', a: "King's Norton Junction", b: 'Bancroft Basin' },
  { name: 'Coventry Canal (Coventry Basin→Fradley Jn)', a: 'Coventry Basin', b: 'Fradley Junction' },
  { name: 'Oxford Canal (Hawkesbury Jn→Napton Jn)', a: 'Hawkesbury Junction', b: 'Napton Junction' },
  { name: 'Llangollen (Hurleston Jn→Llangollen)', a: 'Hurleston Junction', b: 'Llangollen Wharf' },
];

const s = DEFAULTS;
const pad = (x, n) => String(x).padEnd(n);
const padl = (x, n) => String(x).padStart(n);
const mph = (mi, hrs) => (hrs > 0 ? (mi / hrs).toFixed(1) : '—');

console.log(`\nOurs vs CanalPlanAC — our times use ${s.speedMph} mph, ${s.lockMinutes} min/lock.\n`);
console.log(pad('Route', 50), padl('our mi', 7), padl('lk', 4), padl('our t', 8), padl('mph', 5), ' | ',
  padl('cp mi', 6), padl('cp t', 8), padl('mph', 5), padl('Δ time', 8));
console.log('-'.repeat(118));

let withRef = 0, sumOurH = 0, sumCpH = 0;
const links = [];
for (const r of ROUTES) {
  const a = place(r.a), b = place(r.b);
  if (!a || !b) { console.log(pad(r.name, 50), ' — endpoint not found:', !a ? r.a : r.b); continue; }
  const res = g.route(a, b);
  if (!res) { console.log(pad(r.name, 50), ' — no route'); continue; }
  const est = estimate(res.miles, res.locks, s, { bendFactor: res.bendFactor });
  const ref = refs[r.name] || {};
  const cpH = typeof ref.hours === 'number' ? ref.hours : null;
  const dTime = cpH != null ? `${est.hours >= cpH ? '+' : ''}${Math.round((est.hours - cpH) * 60)}m` : '—';
  if (cpH != null) { withRef++; sumOurH += est.hours; sumCpH += cpH; }
  console.log(
    pad(r.name, 50), padl(res.miles.toFixed(1), 7), padl(res.locks, 4),
    padl(formatDuration(est.hours), 8), padl(mph(res.miles, est.hours), 5), ' | ',
    padl(ref.miles ?? '—', 6), padl(cpH != null ? formatDuration(cpH) : '—', 8),
    padl(cpH != null ? mph(ref.miles ?? res.miles, cpH) : '—', 5), padl(dTime, 8)
  );
  // human lookup link (open in a browser; commas separate the two places)
  links.push(`  ${r.name}\n    https://canalplan.uk/cgi-bin/canal.cgi?plan=yes&where=${a.id},${b.id}`);
}
console.log('-'.repeat(118));
if (withRef) console.log(`Across ${withRef} route(s) with CanalPlanAC times: ours ${sumOurH.toFixed(1)}h vs theirs ${sumCpH.toFixed(1)}h (×${(sumOurH / sumCpH).toFixed(2)}).`);
else console.log('No CanalPlanAC times collected yet — fill data/canalplan-refs.json from the links below.');

console.log('\nLook these up BY HAND on canalplan.uk (human use is fine; do not automate), then fill data/canalplan-refs.json:');
console.log(links.join('\n'));
