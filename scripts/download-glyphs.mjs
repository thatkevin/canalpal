#!/usr/bin/env node
// Bundle the font glyph ranges we use so map labels render fully offline.
// Pulls "Open Sans Regular" Latin ranges from the public OpenMapTiles font server.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = 'Open Sans Regular';
const ranges = ['0-255', '256-511', '512-767', '768-1023']; // Latin + extended (covers GB/Welsh names)
const outDir = join(root, 'public', 'glyphs', font);
mkdirSync(outDir, { recursive: true });

for (const range of ranges) {
  const out = join(outDir, `${range}.pbf`);
  if (existsSync(out)) continue;
  const url = `https://fonts.openmaptiles.org/${encodeURIComponent(font)}/${range}.pbf`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`Failed ${range}: ${res.status}`); continue; }
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`glyphs ${font} ${range}`);
}
console.log('Glyphs bundled ->', outDir);
