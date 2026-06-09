#!/usr/bin/env node
// Fetch Canal & River Trust stoppage notices into a compact, same-origin JSON.
//
// The CRT notices API (https://canalrivertrust.org.uk/api/stoppage/notices) is
// CORS-blocked and rejects plain curl, but works when called from within the
// notices page. So we load the page in headless Chromium and fetch from there.
//
// Output: public/data/stoppages.json (+ docs/data if present), an array of
//   { id, title, waterway, region, typeId, type, closure, start, end, lng, lat, path }
//
// Local:  PW_EXE=<chrome-headless-shell> node scripts/fetch-stoppages.mjs
// CI:     npx playwright install chromium && node scripts/fetch-stoppages.mjs
import { chromium } from 'playwright-core';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPE = {
  1: { name: 'Navigation closure', closure: true },
  2: { name: 'Navigation restriction', closure: false },
  3: { name: 'Towpath closure', closure: false },
  4: { name: 'Advice', closure: false },
  8: { name: 'Towpath restriction', closure: false },
  9: { name: 'Navigation & towpath closure', closure: true },
};

// fields must match what the notices page sends or the API 500s; the window is
// capped (~6 months) so page it in 90-day chunks across the next year and merge.
const FIELDS = 'title,region,waterways,path,typeId,reasonId,programmeId,start,end,state,image';
const iso = (d) => d.toISOString().slice(0, 10);
const now = Date.now();
const windows = [];
for (let i = 0; i < 4; i++) windows.push([iso(new Date(now + i * 90 * 864e5)), iso(new Date(now + (i + 1) * 90 * 864e5))]);

const browser = await chromium.launch({ executablePath: process.env.PW_EXE || undefined });
const page = await browser.newPage();
await page.goto('https://canalrivertrust.org.uk/notices', { waitUntil: 'networkidle', timeout: 60000 });

const byId = new Map();
for (const [start, end] of windows) {
  const url = `/api/stoppage/notices?consult=false&end=${end}&fields=${encodeURIComponent(FIELDS)}&geometry=point&start=${start}`;
  const fc = await page.evaluate(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('api ' + r.status); return r.json(); }, url);
  for (const f of fc.features || []) byId.set(f.properties?.id, f);
}
await browser.close();
const fc = { features: [...byId.values()] };

function pointOf(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'GeometryCollection') {
    const p = geom.geometries?.find((g) => g.type === 'Point') || geom.geometries?.[0];
    return p ? (p.type === 'Point' ? p.coordinates : p.coordinates?.[0]) : null;
  }
  if (Array.isArray(geom.coordinates)) return geom.coordinates.flat(Infinity).slice(0, 2);
  return null;
}

const out = [];
for (const f of fc.features || []) {
  const p = f.properties || {};
  const pt = pointOf(f.geometry);
  if (!pt || pt.length < 2) continue;
  const ty = TYPE[p.typeId] || { name: 'Notice', closure: false };
  out.push({
    id: p.id, title: p.title, waterway: p.waterways || '', region: p.region || '',
    typeId: p.typeId, type: ty.name, closure: ty.closure,
    start: p.start, end: p.end,
    lng: Math.round(pt[0] * 1e5) / 1e5, lat: Math.round(pt[1] * 1e5) / 1e5,
    path: p.path,
  });
}
out.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

for (const dir of ['public/data', 'docs/data']) {
  const d = join(root, dir);
  if (dir === 'docs/data' && !existsSync(d)) continue;
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'stoppages.json'), JSON.stringify(out));
}
const closures = out.filter((s) => s.closure).length;
console.log(`stoppages: ${out.length} (${closures} closures), ${windows[0][0]} → ${windows[windows.length - 1][1]}`);
