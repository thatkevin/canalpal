// Render the Canal Pal app icon (a narrowboat under a roving bridge) to PNGs via
// headless chromium, so we can draw real vector shapes rather than a flat colour.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(root, 'public', 'icons');
mkdirSync(iconDir, { recursive: true });

// `bleed` = full-square background (maskable); otherwise rounded corners.
function svg(bleed) {
  const r = bleed ? 0 : 96;
  // content scaled into the maskable safe zone when bleeding
  const s = bleed ? 0.78 : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${r}" fill="#0d3b66"/>
  <g transform="translate(256 256) scale(${s}) translate(-256 -256)">
    <!-- roving bridge arch -->
    <path d="M 84 268 A 172 172 0 0 1 428 268" fill="none" stroke="#e9f2fb" stroke-width="20" stroke-linecap="round"/>
    <circle cx="84" cy="268" r="14" fill="#e9f2fb"/>
    <circle cx="428" cy="268" r="14" fill="#e9f2fb"/>
    <!-- water -->
    <rect x="40" y="312" width="432" height="92" rx="30" fill="#2f86c4"/>
    <path d="M 70 356 q 26 -16 52 0 t 52 0 t 52 0 t 52 0 t 52 0 t 52 0" fill="none" stroke="#7cc0ec" stroke-width="7" stroke-linecap="round"/>
    <!-- narrowboat hull -->
    <path d="M 120 300 h 250 q 36 0 26 34 l -4 14 q -4 12 -18 12 H 116 q -14 0 -18 -12 l -4 -14 q -8 -28 24 -34 Z" fill="#e8590c"/>
    <!-- cabin -->
    <rect x="170" y="258" width="150" height="46" rx="10" fill="#f3e7cf"/>
    <rect x="170" y="258" width="150" height="12" rx="6" fill="#c0392b"/>
    <circle cx="205" cy="285" r="8" fill="#0d3b66"/>
    <circle cx="243" cy="285" r="8" fill="#0d3b66"/>
    <circle cx="281" cy="285" r="8" fill="#0d3b66"/>
    <!-- chimney -->
    <rect x="196" y="234" width="14" height="26" rx="3" fill="#1b2a3a"/>
    <rect x="194" y="243" width="18" height="6" fill="#e8590c"/>
  </g>
</svg>`;
}

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const page = await browser.newPage();

async function render(markup, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0}</style>` +
    markup.replace('width="512" height="512"', `width="${size}" height="${size}"`),
    { waitUntil: 'networkidle' }
  );
  const el = await page.$('svg');
  const buf = await el.screenshot({ omitBackground: true });
  writeFileSync(join(iconDir, file), buf);
  console.log('icon', file);
}

await render(svg(false), 512, 'icon-512.png');
await render(svg(false), 192, 'icon-192.png');
await render(svg(false), 180, 'apple-touch-icon.png');
await render(svg(true), 512, 'icon-maskable-512.png');
await render(svg(false), 32, 'favicon-32.png');

await browser.close();
console.log('done ->', iconDir);
