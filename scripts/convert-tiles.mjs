#!/usr/bin/env node
// Convert data/canalplan.mbtiles -> public/data/canalplan.pmtiles
// PMTiles is a single-file archive MapLibre can read directly (and we cache it
// for offline use), unlike mbtiles which needs a tile server.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'data', 'canalplan.mbtiles');
const out = join(root, 'public', 'data', 'canalplan.pmtiles');

if (!existsSync(src)) {
  console.error(`Missing ${src}. Download it first (see README).`);
  process.exit(1);
}
console.log('Converting mbtiles -> pmtiles ...');
// Uses go-pmtiles (installed to ./.bin via `go install`, see README).
const bin = join(root, '.bin', 'go-pmtiles');
execFileSync(bin, ['convert', src, out], { stdio: 'inherit' });
console.log(`-> ${out}`);
