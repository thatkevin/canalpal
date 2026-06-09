#!/usr/bin/env node
// Pre-dev guard: make sure the generated data + icons exist, and explain how to
// build them if not. Generates placeholder PWA icons.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const need = [
  ['data/canalplan.pmtiles', 'npm run tiles'],
  ['data/waterways.geojson', 'npm run preprocess'],
  ['data/locks.json', 'npm run preprocess'],
  ['data/facilities.json', 'npm run preprocess'],
  ['glyphs/Open Sans Regular/0-255.pbf', 'node scripts/download-glyphs.mjs'],
];
let missing = false;
for (const [f, cmd] of need) {
  if (!existsSync(join(pub, f))) { console.error(`Missing public/${f} — run: ${cmd}`); missing = true; }
}
if (missing) process.exit(1);

// --- placeholder PWA icons (solid navy PNG) ---
function solidPng(size, [r, g, b]) {
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const iconDir = join(pub, 'icons');
mkdirSync(iconDir, { recursive: true });
for (const s of [192, 512]) {
  const p = join(iconDir, `icon-${s}.png`);
  if (!existsSync(p)) writeFileSync(p, solidPng(s, [13, 59, 102]));
}
console.log('Assets present.');
