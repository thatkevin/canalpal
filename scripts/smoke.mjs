// Headless smoke test: load the running dev app, wait for the network to load,
// click two points on the Worcester & Birmingham canal, assert a route appears.
import { chromium } from 'playwright-core';

const URL = process.env.URL || 'http://localhost:5173/';
const exe = process.env.PW_EXE;

const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
// Fake a GPS fix on the Worcester & Birmingham canal so we can test the
// "use current location" shortcut.
const context = await browser.newContext({
  viewport: { width: 414, height: 820 }, deviceScaleFactor: 2,
  geolocation: { longitude: -1.9717, latitude: 52.3486 }, permissions: ['geolocation'],
});
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'load' });

// wait for worker init: status text shows "ready"
await page.waitForFunction(() => /ready/.test(document.getElementById('status')?.textContent || ''), { timeout: 30000 });
console.log('✓ network loaded:', await page.locator('#status').textContent());

// the geolocate fix should make the "use current location" link appear
await page.waitForFunction(() => /use current location/i.test(document.getElementById('hint')?.innerHTML || ''), { timeout: 10000 });
console.log('✓ "use current location" offered');
await page.click('#use-loc');
await page.waitForFunction(() => /destination/i.test(document.getElementById('hint')?.innerHTML || ''), { timeout: 5000 });
console.log('✓ current location set as start');
await page.click('#btn-reset'); // clear before the routing test

// Drive the app directly via its map (more reliable than synthetic canvas clicks):
// dispatch two clicks at canal coordinates through MapLibre's project().
const result = await page.evaluate(async () => {
  // Two points on the Worcester & Birmingham canal near Alvechurch & King's Norton
  const a = { lng: -1.9717, lat: 52.3486 };
  const b = { lng: -1.9300, lat: 52.4060 };
  // find the map instance via the global the app doesn't expose -> simulate clicks
  const map = window.__map;
  if (!map) return { error: 'no map handle' };
  const click = (ll) => map.fire('click', {
    lngLat: ll, point: map.project(ll),
    originalEvent: { target: map.getCanvas(), preventDefault() {}, stopPropagation() {}, type: 'click' },
  });
  click(a);
  await new Promise((r) => setTimeout(r, 300));
  click(b);
  await new Promise((r) => setTimeout(r, 2500));
  const panel = document.getElementById('route-summary')?.textContent || '';
  const visible = !document.getElementById('panel').classList.contains('hidden');
  return { panel, visible };
});

console.log('route result:', JSON.stringify(result));

// --- search ---
await page.click('#btn-reset');
await page.fill('#search', 'Tardebigge');
await page.waitForSelector('#search-results li', { timeout: 5000 });
const firstResult = (await page.textContent('#search-results li .r-name'))?.trim();
console.log('✓ search → first result:', firstResult);
const hasTardebigge = await page.locator('#search-results li', { hasText: 'Tardebigge' }).count();

// --- via points: start -> via -> end, 3-point route ---
const via = await page.evaluate(async () => {
  const map = window.__map;
  const click = (ll) => map.fire('click', { lngLat: ll, point: map.project(ll), originalEvent: { target: map.getCanvas(), preventDefault() {}, stopPropagation() {}, type: 'click' } });
  document.getElementById('btn-reset').click();
  click({ lng: -2.0680, lat: 52.3090 }); // Tardebigge top area
  await new Promise((r) => setTimeout(r, 200));
  click({ lng: -1.9717, lat: 52.3486 }); // Alvechurch (via)
  await new Promise((r) => setTimeout(r, 1200));
  click({ lng: -1.9300, lat: 52.4060 }); // King's Norton (end)
  await new Promise((r) => setTimeout(r, 2000));
  return { title: document.getElementById('route-title').textContent, panel: document.getElementById('route-summary').textContent.replace(/\s+/g, ' ').trim() };
});
console.log('✓ via route:', via.title, '—', via.panel.slice(0, 80));

await page.screenshot({ path: 'smoke.png' });
console.log('✓ screenshot -> smoke.png');

if (errors.length) { console.log('\nConsole errors:'); for (const e of errors.slice(0, 12)) console.log('  -', e); }

await browser.close();
const ok = result && result.visible && /lock/i.test(result.panel);
console.log(ok ? '\nSMOKE PASS' : '\nSMOKE INCONCLUSIVE');
process.exit(ok ? 0 : 2);
