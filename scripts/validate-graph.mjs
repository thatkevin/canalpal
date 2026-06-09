#!/usr/bin/env node
// Build the routing graph from the real data and sanity-check it:
//  - connectivity (how much of the network is one routable component)
//  - a known route with a CanalPlanAC-published distance + lock count
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanalGraph } from '../src/graph.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public', 'data');
const J = (f) => JSON.parse(readFileSync(join(pub, f), 'utf8'));

const waterways = J('waterways.geojson');
const locks = J('locks.json');
const facilities = J('facilities.json');
const places = JSON.parse(readFileSync(join(root, 'data', 'places.geojson'), 'utf8'));

console.time('build');
const g = new CanalGraph().build(waterways, locks, facilities);
console.timeEnd('build');
console.log(`nodes: ${g.nodes.length}  edges: ${g.edges.length}`);

const c = g.components();
const total = g.nodes.length;
console.log(`components: ${c.count}, largest ${c.sizes[0]} (${((c.sizes[0] / total) * 100).toFixed(1)}%)`);
console.log(`top component sizes: ${c.sizes.slice(0, 8).join(', ')}`);

// named-place lookup by title
function place(titleIncludes) {
  for (const f of places.features) {
    const t = f.properties?.title;
    if (t && t.includes(titleIncludes) && f.geometry?.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates;
      return { lng, lat, title: t };
    }
  }
  return null;
}

function test(aName, bName, expectMiles, expectLocks) {
  const a = place(aName), b = place(bName);
  if (!a || !b) { console.log(`SKIP ${aName} -> ${bName} (place not found)`); return; }
  const r = g.route(a, b);
  if (!r) { console.log(`NO ROUTE ${a.title} -> ${b.title}`); return; }
  console.log(`\n${a.title}  ->  ${b.title}`);
  console.log(`  distance: ${r.miles.toFixed(1)} mi (${Math.round(r.furlongs)} furlongs)   [expected ~${expectMiles} mi]`);
  console.log(`  locks:    ${r.locks}   [expected ~${expectLocks}]`);
  console.log(`  facilities on route: ${r.facilities.length}`);
}

// Worcester & Birmingham corridor: Hanbury Jn -> King's Norton Jn ~ 15 mi, 42 locks
test('Hanbury Junction', "King's Norton Junction", 15, 42);
// Tardebigge flight test (top to bottom) ~ 30 locks
test('Tardebigge Top Lock', 'Tardebigge Bottom Lock', 2.5, 30);
