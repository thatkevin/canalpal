import { createMap, maplibregl, protocol, POI_LAYERS, setRoute, setRouteFacilities, setRouteLocks, setStoppages, fitRoute } from './map.js';
import { estimate, formatDuration, getSettings, saveSettings, correctionFactor, logTrip } from './time-model.js';
import RouterWorker from './router.worker.js?worker';

const BASE = import.meta.env.BASE_URL || './';
const CANALPLAN = 'https://canalplan.uk/place/';
const $ = (id) => document.getElementById(id);

// --- worker plumbing ---
const worker = new RouterWorker();
let msgId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};
worker.onerror = (e) => { console.error('WORKER ERROR:', e.message, e.filename, e.lineno); setStatus('Worker failed to start'); };
function call(type, payload) {
  const id = ++msgId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }); });
}

// --- state ---
let map = null;
let points = [];        // [{lng,lat,name,id}]
let markers = [];
let lastRoute = null, summaryText = 'Journey', panelTitle = 'Journey', userLocation = null, ready = false, popup = null;

const FACILITY_EMOJI = {
  'Pub': '🍺', 'Bar': '🍷', 'Restaurant': '🍽️', 'Takeaway': '🥡', 'Coffee shop': '☕',
  'Water point': '🚰', 'Fuel / diesel': '⛽', 'Elsan / chemical toilet': '🚽', 'Pump-out': '🚽',
  'Sanitary station': '🚽', 'Rubbish disposal': '🗑️', 'Recycling': '♻️',
  'Shop': '🛒', 'Supermarket': '🛒', 'General store': '🛒', 'Store': '🛒', 'DIY / hardware': '🔧',
  'Pharmacy': '💊', 'Laundry': '🧺', 'Toilets': '🚻', 'Mooring': '⚓', 'Visitor mooring': '⚓', 'Boatyard': '🛥️',
};
const emojiFor = (t) => FACILITY_EMOJI[t] || '📍';
const SERVICE_EMOJI = FACILITY_EMOJI;
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const arrowFor = (b) => ARROWS[Math.round((((b % 360) + 360) % 360) / 45) % 8];

// --- theme (pirate | gongoozler) ---
let theme = localStorage.getItem('cp.theme') || 'pirate';
const t = (pirate, plain) => (theme === 'gongoozler' ? plain : pirate);
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('credit').innerHTML = t(
    `☠ Charts plundered fair an' square — with thanks — from the good crew at <a href="https://canalplan.org.uk" target="_blank" rel="noopener">CanalPlanAC</a>. Base waters © OpenStreetMap. ⚓`,
    `Mapping data from <a href="https://canalplan.org.uk" target="_blank" rel="noopener">CanalPlanAC</a>, used with thanks. Base map © OpenStreetMap contributors.`
  );
}
applyTheme();

// --- boot: onboarding consent → one-time chart download → map + network ---
const PM_URL = BASE + 'data/canalplan.pmtiles';

async function archiveCached() {
  try { const c = await caches.open('cp-archive'); return !!(await c.match(PM_URL)); } catch { return false; }
}
function setProgress(pct, label) {
  const f = $('ob-bar-fill'); if (f) f.style.width = pct + '%';
  const t = $('ob-pct'); if (t) t.textContent = label || `Loadin' charts… ${pct}%`;
}
// Download the .pmtiles archive once (GitHub Pages ignores Range, so PMTiles
// can't stream it) and keep it in Cache Storage for instant offline reloads.
async function getArchiveBlob(onProgress) {
  const cache = await caches.open('cp-archive');
  const hit = await cache.match(PM_URL);
  if (hit) return hit.blob();
  const res = await fetch(PM_URL);
  if (!res.ok) throw new Error('charts ' + res.status);
  const total = +res.headers.get('content-length') || 46320028;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.(Math.min(99, Math.round((got / total) * 100)));
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  try { await cache.put(PM_URL, new Response(blob.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* over quota — fine */ }
  return blob;
}

async function boot() {
  const cached = await archiveCached();
  if (cached) {
    // returning visitor — charts already aboard, skip onboarding entirely
    setStatus('Loading charts…');
  } else {
    // first visit — reveal the consent screen and wait for the user
    $('onboarding').classList.remove('init-hidden');
    await new Promise((res) => { $('ob-proceed').onclick = res; });
    $('ob-proceed').classList.add('hidden');
    $('ob-progress').classList.remove('hidden');
    setProgress(0, "Loadin' charts… 0%");
  }

  // load the routing network in parallel with the chart download
  const initP = call('init', { base: BASE }).catch((e) => { console.error(e); return null; });

  try {
    const blob = await getArchiveBlob((p) => { if (!cached) setProgress(p); });
    const { PMTiles, FileSource } = await import('pmtiles');
    // The File's name is the archive key — it MUST match the style source url
    // 'pmtiles://canalplan' (see map.js), or the overlay won't resolve.
    protocol.add(new PMTiles(new FileSource(new File([blob], 'canalplan'))));
  } catch (e) { console.error('chart load failed', e); }
  if (!cached) setProgress(100, "Charts aboard! Settin' sail…");

  map = createMap('map');
  window.__map = map;
  attachMapHandlers();

  const stats = await initP;
  ready = true;
  setStatus(stats ? `${stats.nodes.toLocaleString()} points · ready` : '');
  setTimeout(() => setStatus(''), 2500);

  if (!cached) {
    $('onboarding').classList.add('gone');
    setTimeout(() => $('onboarding')?.remove(), 600);
  }
  restoreView();
}

// On load: jump to wherever the user last set a start, and quietly learn the
// current location for the "use current location" link (without recentering).
function restoreView() {
  try {
    const ls = JSON.parse(localStorage.getItem('cp.laststart') || 'null');
    if (ls && isFinite(ls.lng) && isFinite(ls.lat)) map.jumpTo({ center: [ls.lng, ls.lat], zoom: 13 });
  } catch { /* ignore */ }
  navigator.geolocation?.getCurrentPosition(
    (pos) => { userLocation = { lng: pos.coords.longitude, lat: pos.coords.latitude }; if (points.length === 0) promptForStart(); },
    () => { /* silent */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

function attachMapHandlers() {
  map._geolocate?.on('geolocate', (e) => {
    userLocation = { lng: e.coords.longitude, lat: e.coords.latitude };
    if (points.length === 0) promptForStart();
  });
  map._geolocate?.on('error', (e) => { setStatus('Location: ' + (e?.message || 'unavailable')); setTimeout(() => setStatus(''), 4000); });
  map.on('error', () => {});

  // map click: open a POI popup, else drop a waypoint
  map.on('click', (e) => {
    if (!ready) return;
    // a stoppage marker → its own popup with a CRT link
    const stp = map.queryRenderedFeatures(e.point, { layers: ['stoppages'] });
    if (stp.length) { showStoppagePopup(lastStoppages.find((s) => s.id === stp[0].properties.id)); return; }
    const feats = map.queryRenderedFeatures(e.point, { layers: [...POI_LAYERS, 'routefac'] });
    if (feats.length) { showPoiPopup(e.lngLat, poiFromFeature(feats[0])); return; }
    addPoint({ lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  map.on('mouseenter', 'stoppages', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'stoppages', () => (map.getCanvas().style.cursor = ''));
  map.on('mouseenter', 'pl-jct', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'pl-jct', () => (map.getCanvas().style.cursor = ''));

  // hover a canal/river → highlight the whole waterway + show its name in #status
  let hoveredWw = null;
  for (const layer of ['ww', 'ww-unnav']) {
    map.on('mousemove', layer, (e) => {
      const f = e.features?.[0]; if (!f) return;
      const id = f.properties.cp_id;
      if (id !== hoveredWw) {
        hoveredWw = id;
        map.setFilter('ww-hl', ['==', ['get', 'cp_id'], id ?? ' ']);
        setStatus(f.properties.cp_name || '');
      }
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      hoveredWw = null;
      map.setFilter('ww-hl', ['==', ['get', 'cp_id'], ' ']);
      setStatus('');
      map.getCanvas().style.cursor = '';
    });
  }
}

boot();

// --- waypoints + draggable markers ---
let seq = 0; // bumped on every state change so stale async renders are ignored

// Snap a point onto the nearest navigable water (the marker "jumps" to the canal).
async function snapPoint(p) {
  try { const s = await call('snap', { point: p }); if (s) { p.lng = s.lng; p.lat = s.lat; } } catch { /* keep as-is */ }
  return p;
}

async function addPoint(p) {
  if (!ready) return;
  await snapPoint(p);
  Object.assign(p, nameFor(p.lng, p.lat));
  points.push(p);
  renderMarkers();
  if (points.length === 1) { try { localStorage.setItem('cp.laststart', JSON.stringify({ lng: p.lng, lat: p.lat })); } catch { /* ignore */ } }
  if (points.length >= 2) computeRoute();
  else { setRoute(map, null); setRouteLocks(map, null); requestServices(); updateHint(); }
}

// With only a start set, show the nearest boater services from there.
async function requestServices() {
  const my = ++seq;
  try {
    const facs = await call('services', { point: points[0], settings: { ...getSettings(), maxDays: 3 } });
    if (my === seq && points.length === 1) renderStartFacilities(facs); // ignore if superseded
  } catch (e) { console.error(e); }
}

function renderMarkers() {
  markers.forEach((m) => m.remove());
  markers = points.map((p, i) => {
    const role = i === 0 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'via';
    const el = document.createElement('div');
    el.className = 'wp wp-' + role;
    el.innerHTML = `<span>${role === 'via' ? i : ''}</span>`;
    const m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
    m.on('dragend', async () => {
      const ll = m.getLngLat();
      const np = await snapPoint({ lng: ll.lng, lat: ll.lat });
      points[i] = { ...np, ...nameFor(np.lng, np.lat) };
      m.setLngLat([np.lng, np.lat]); // jump the pin onto the canal
      if (points.length >= 2) computeRoute();
      else { requestServices(); updateHint(); }
    });
    return m;
  });
  updateUndoIcon();
}

// Broom for 0–1 points (the button clears); undo arrow for 2+ (removes a point).
function updateUndoIcon() { $('btn-undo').textContent = points.length <= 1 ? '🧹' : '↶'; }

// One button: undo the last point, or clear everything when none remain.
function undoOrClear() {
  if (points.length === 0) { reset(); return; }
  points.pop(); popup?.remove(); renderMarkers();
  if (points.length >= 2) computeRoute();
  else if (points.length === 1) { lastRoute = null; setRoute(map, null); setRouteLocks(map, null); requestServices(); updateHint(); }
  else reset(); // removed the last point → full clear
}
function reset() {
  points = []; lastRoute = null; renderMarkers();
  clearRouteOnly(); $('search').value = ''; popup?.remove();
  promptForStart();
}
function clearRouteOnly() {
  setRoute(map, null); setRouteFacilities(map, null); setRouteLocks(map, null); setStoppages(map, []);
  $('route-stoppages').innerHTML = '';
  $('panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
}

// nearest named place (for breadcrumb + drag relabelling)
let gazetteer = [];
fetch(BASE + 'data/places-named.json').then((r) => r.json()).then((d) => { gazetteer = d; });

// CRT stoppages (refreshed daily by a GitHub Action into a same-origin file)
let stoppages = [];
fetch(BASE + 'data/stoppages.json').then((r) => r.json()).then((d) => { stoppages = d; }).catch(() => {});

const R_EARTH = 6371000, toRad = (d) => (d * Math.PI) / 180;
function metres(aLng, aLat, bLng, bLat) {
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
// Stoppages whose location lies within `bufferM` of the route polyline.
function stoppagesOnRoute(coords, bufferM = 350) {
  const hits = [];
  for (const s of stoppages) {
    let min = Infinity;
    for (let i = 0; i < coords.length; i += 2) { // sample vertices (dense enough)
      const d = metres(s.lng, s.lat, coords[i][0], coords[i][1]);
      if (d < min) min = d;
      if (min < bufferM) break;
    }
    if (min < bufferM) hits.push(s);
  }
  // soonest / active first
  return hits.sort((a, b) => (a.start || '') .localeCompare(b.start || ''));
}
function ddmmyyyy(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function nameFor(lng, lat) {
  let best = null, bd = Infinity;
  for (const g of gazetteer) { const d = (g.lng - lng) ** 2 + (g.lat - lat) ** 2; if (d < bd) { bd = d; best = g; } }
  return best ? { name: best.name, id: best.id } : { name: null, id: '' };
}

async function computeRoute() {
  const my = ++seq;
  setStatus(t('Charting course…', 'Calculating…')); setHint('');
  try {
    const r = await call('route', { points });
    if (my !== seq || points.length < 2) return; // superseded by a newer action
    if (!r || r.error) {
      setStatus('');
      const leg = r && r.legIndex != null ? ` (leg ${r.legIndex + 1})` : '';
      showError(`No canal route${leg} — try points closer to navigable water.`);
      return;
    }
    lastRoute = r;
    setRoute(map, r.coords); setRouteFacilities(map, r.facilities); setRouteLocks(map, r.routeLocks);
    fitRoute(map, r.coords);
    renderSummary(r);
    setStatus('');
  } catch (err) { setStatus(''); showError(String(err.message || err)); }
}

function renderSummary(r) {
  const s = getSettings();
  const est = estimate(r.miles, r.locks, s);
  const miles = Math.floor(r.miles);
  const fur = Math.round((r.miles - miles) * 8);
  panelTitle = 'Journey';
  summaryText = `Journey: ${miles}mi ${fur}f, ${r.locks} lock${r.locks === 1 ? '' : 's'}, ${formatDuration(est.hours)}, ${est.days} day${est.days === 1 ? '' : 's'}`;

  renderBreadcrumb();

  const names = r.excludedNames.length ? r.excludedNames.slice(0, 2).map(escapeHtml).join(' & ') + ' ' : t('These waters ', 'this water ');
  const hasHave = r.excludedNames.length === 1 ? 'is' : (r.excludedNames.length ? 'are' : 'is');
  $('route-warning').innerHTML = r.excludedMiles > 0.02
    ? `<div class="warn">${t('☠', '⚠')} <span>${t(
        `<b>Don't be a fool!</b> ${names}${r.excludedNames.length === 1 ? 'has' : (r.excludedNames.length ? 'have' : 'has')} been plundered and can't be sailed - ${r.excludedMiles.toFixed(1)}mi of your course runs aground.`,
        `<b>Note:</b> ${names}${hasHave} disused or unnavigable - ${r.excludedMiles.toFixed(1)} mi of this route may not be passable by boat.`
      )}</span></div>`
    : '';

  renderStoppages(r);

  $('route-summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="big">${miles}<small>mi</small> ${fur}<small>fur</small></span><span class="lbl">distance</span></div>
      <div class="stat"><span class="big">${r.locks}</span><span class="lbl">lock${r.locks === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="big">${formatDuration(est.hours)}</span><span class="lbl">cruising</span></div>
      <div class="stat"><span class="big">${est.days}</span><span class="lbl">day${est.days === 1 ? '' : 's'}*</span></div>
    </div>
    <p class="muted small">*at ${s.hoursPerDay} hrs/day, ${s.speedMph} mph, ${s.lockMinutes} min/lock${est.samples >= 2 ? ` · ×${est.factor.toFixed(2)} from ${est.samples} logged trips` : ''}. Tap the water to add a stop, or drag a pin.</p>
    <button id="btn-log" class="primary">${t('Log this as a completed voyage…', 'Log this as a completed trip…')}</button>
  `;

  const facs = r.facilities;
  if (facs.length) {
    $('route-facilities').innerHTML = `<h3>On the way (${facs.length})</h3>` +
      facs.map((f, i) => `<div class="fac" data-fi="${i}"><span class="fac-emoji">${emojiFor(f.type)}</span><span class="fac-name">${escapeHtml(f.title)}</span><span class="fac-mi">${f.miles.toFixed(1)} mi</span></div>`).join('');
    $('route-facilities').querySelectorAll('.fac').forEach((el) => {
      const f = facs[+el.dataset.fi];
      el.onclick = () => {
        setCollapsed(true); // get the panel out of the way so the POI is visible
        map.flyTo({ center: [f.lng, f.lat], zoom: 15, offset: [0, -40] });
        showPoiPopup({ lng: f.lng, lat: f.lat }, { title: f.title, type: f.type });
      };
    });
  } else {
    $('route-facilities').innerHTML = '<p class="muted small">No mapped facilities directly on this route.</p>';
  }

  $('btn-log').onclick = () => logTripFlow(r, est);
  showPanel();
}

// Nearest boater services from the start point — shown in the collapsed bar with
// emoji + a direction arrow + distance/locks, with a detailed list when expanded.
function renderStartFacilities(facs) {
  panelTitle = 'Nearest facilities';
  const seen = new Set(); const bits = [];
  for (const f of facs) {
    const em = SERVICE_EMOJI[f.type] || '•';
    if (seen.has(em)) continue; seen.add(em);
    bits.push(`${em} ${arrowFor(f.bearing)} ${f.miles.toFixed(1)}mi`);
  }
  summaryText = bits.length ? 'Nearest  ' + bits.join('   ') : 'No facilities within ~12 mi';

  $('route-breadcrumb').innerHTML = `<b>${escapeHtml(points[0].name || 'Start')}</b>`;
  $('route-warning').innerHTML = '';
  $('route-summary').innerHTML = '<p class="muted small">Nearest boater services from here. Tap or search a destination to plan a journey.</p>';
  $('route-facilities').innerHTML = facs.length
    ? '<h3>Nearest services</h3>' + facs.map((f, i) =>
        `<div class="fac" data-fi="${i}"><span class="fac-emoji">${emojiFor(f.type)}</span><span class="fac-name">${escapeHtml(f.type)}</span><span class="fac-mi">${arrowFor(f.bearing)} ${f.miles.toFixed(1)}mi · ${f.locks}lk · ${f.days}d</span></div>`).join('')
    : '<p class="muted small">No mapped services within ~12 miles.</p>';
  $('route-facilities').querySelectorAll('.fac').forEach((el) => {
    const f = facs[+el.dataset.fi];
    el.onclick = () => { setCollapsed(true); map.flyTo({ center: [f.lng, f.lat], zoom: 15, offset: [0, -40] }); showPoiPopup({ lng: f.lng, lat: f.lat }, { title: f.title, type: f.type }); };
  });
  setRouteFacilities(map, facs);
  showPanel();
}

// CRT stoppages along the route, with dates so you can judge relevance
// (a June plan can ignore November works, but will still see them coming).
let lastStoppages = [];
function renderStoppages(r) {
  const hits = stoppagesOnRoute(r.coords);
  lastStoppages = hits;
  setStoppages(map, hits);
  if (!hits.length) { $('route-stoppages').innerHTML = ''; return; }
  const now = new Date().toISOString().slice(0, 10);
  const closures = hits.filter((s) => s.closure).length;
  const head = `${closures ? '⛔' : '⚠'} Stoppages on this route (${hits.length}${closures ? `, ${closures} closure${closures === 1 ? '' : 's'}` : ''})`;
  const rows = hits.map((s, i) => {
    const active = (s.start || '') <= now && (!s.end || s.end.slice(0, 10) >= now);
    const when = active ? 'now' : (s.start ? 'from ' + ddmmyyyy(s.start) : '');
    const cls = s.closure ? 'stp-closure' : 'stp-restrict';
    return `<button type="button" class="stp ${cls}" data-i="${i}">
      <span class="stp-when">${active ? '🔴' : '🟠'} ${escapeHtml(when)}</span>
      <span class="stp-body"><b>${escapeHtml(s.type)}</b> — ${escapeHtml(s.waterway || s.title || '')}${s.end && !active ? ` <span class="muted">to ${ddmmyyyy(s.end)}</span>` : ''}</span>
    </button>`;
  }).join('');
  $('route-stoppages').innerHTML = `<div class="stp-head">${head}</div>${rows}`;
  $('route-stoppages').querySelectorAll('.stp').forEach((el) => { el.onclick = () => showStoppagePopup(hits[+el.dataset.i]); });
}
const CRT = 'https://canalrivertrust.org.uk';
function stoppageUrl(s) { return s.path ? (s.path.startsWith('http') ? s.path : CRT + s.path) : CRT + '/notices'; }

// Fly to a stoppage and show a popup linking to the full CRT notice.
function showStoppagePopup(s) {
  if (!s) return;
  setCollapsed(true);
  map.flyTo({ center: [s.lng, s.lat], zoom: 14, offset: [0, -40] });
  popup?.remove();
  const dates = s.start ? `${ddmmyyyy(s.start)}${s.end ? ' – ' + ddmmyyyy(s.end) : ' onwards'}` : '';
  const html = `<div class="poi-title">${escapeHtml(s.type)}</div>
    <div class="poi-type">${escapeHtml(s.waterway || '')}${dates ? ' · ' + dates : ''}</div>
    ${s.title ? `<div class="muted small">${escapeHtml(s.title)}</div>` : ''}
    <a class="poi-link" href="${stoppageUrl(s)}" target="_blank" rel="noopener">More info on CRT ↗</a>`;
  popup = new maplibregl.Popup({ offset: 14 }).setLngLat([s.lng, s.lat]).setHTML(html).addTo(map);
}

function renderBreadcrumb() {
  $('route-breadcrumb').innerHTML = points.map((p) => {
    const label = escapeHtml(p.name || 'Dropped pin');
    return p.id ? `<a href="${CANALPLAN}${p.id}" target="_blank" rel="noopener">${label}</a>` : `<span>${label}</span>`;
  }).join('<span class="sep">›</span>');
}

// --- POI popup (shared by map clicks + facility list) ---
const ICON_LABEL = {
  'cp-water': 'Water point', 'cp-elsan': 'Elsan', 'cp-pumpout': 'Pump-out', 'cp-sanstation': 'Sanitary station',
  'cp-rubbish': 'Rubbish', 'cp-recycling': 'Recycling', 'cp-fuel': 'Fuel', 'cp-boatyard': 'Boatyard',
  'cp-pub': 'Pub', 'cp-bar': 'Bar', 'cp-restaurant': 'Restaurant', 'cp-takeaway': 'Takeaway', 'cp-coffeeshop': 'Coffee shop',
  'cp-shop': 'Shop', 'cp-supermarket': 'Supermarket', 'cp-genshop': 'Store', 'cp-miscshop': 'Shop', 'cp-diy': 'DIY / hardware', 'cp-pharmacy': 'Pharmacy', 'cp-laundry': 'Laundry',
  'cp-toilet': 'Toilets', 'cp-mooring': 'Mooring', 'cp-wmooring': 'Visitor mooring',
};
function poiFromFeature(f) {
  const p = f.properties || {};
  let type = p.type;
  if (!type) type = p.layer === 'locks' ? 'Lock' : p.layer === 'junctions' ? 'Junction' : (p.layer === 'bigplaces' || p.layer === 'smallplaces') ? 'Place' : ICON_LABEL[p.icon] || 'Point of interest';
  return { title: p.title || type, type, id: p.cp_id };
}
function showPoiPopup(lngLat, { title, type, id }) {
  popup?.remove();
  let html = `<div class="poi-title">${escapeHtml(title || '')}</div>`;
  if (type) html += `<div class="poi-type">${escapeHtml(type)}</div>`;
  // offer to add this place to the journey once a start is set
  if (points.length >= 1) html += `<a class="poi-route" href="#">🧭 Route to here</a>`;
  if (id) html += `<a class="poi-link" href="${CANALPLAN}${id}" target="_blank" rel="noopener">View on CanalPlanAC ↗</a>`;
  popup = new maplibregl.Popup({ offset: 14 }).setLngLat(lngLat).setHTML(html).addTo(map);
  const link = popup.getElement()?.querySelector('.poi-route');
  if (link) link.onclick = (e) => { e.preventDefault(); popup?.remove(); addPoint({ lng: lngLat.lng, lat: lngLat.lat, name: title || type, id: id || '' }); };
}

// --- trip logging (learned weighting) ---
function logTripFlow(r, est) {
  const txt = prompt(`How long did this ${t('voyage', 'trip')} actually take (hours)?\n\nPredicted: ${est.hours.toFixed(1)} hr for ${r.miles.toFixed(1)} mi & ${r.locks} locks.`, est.hours.toFixed(1));
  if (txt == null) return;
  const actual = parseFloat(txt);
  if (!isFinite(actual) || actual <= 0) return;
  logTrip({ miles: r.miles, locks: r.locks, predictedHours: est.hours, actualHours: actual });
  const { factor, samples } = correctionFactor();
  setStatus(`Logged. New correction ×${factor.toFixed(2)} (${samples} ${t('voyages', 'trips')}).`);
  setTimeout(() => setStatus(''), 4000);
  renderSummary(r);
}

// --- search ---
const TYPE_LABEL = { junctions: 'Junction', locks: 'Lock', bigplaces: 'Place', smallplaces: 'Place', fixedbridges: 'Bridge', movebridges: 'Bridge', winding: 'Winding hole', mooring: 'Mooring' };
function searchGazetteer(q, n = 8) {
  const starts = [], contains = [];
  for (const p of gazetteer) { const i = p.name.toLowerCase().indexOf(q); if (i === 0) starts.push(p); else if (i > 0) contains.push(p); }
  starts.sort((a, b) => a.name.length - b.name.length);
  return starts.concat(contains).slice(0, n);
}
const searchInput = $('search');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q.length < 2) { renderRecents(); return; }
  renderResults(searchGazetteer(q));
});
searchInput.addEventListener('focus', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q.length >= 2) renderResults(searchGazetteer(q)); else renderRecents();
});
function resultRow(p) {
  const meta = [TYPE_LABEL[p.layer] || '', p.region || ''].filter(Boolean).join(' · ');
  return `<span class="r-name">${escapeHtml(p.name)}</span><span class="r-type">${escapeHtml(meta)}</span>`;
}
function renderResults(res) {
  const ul = $('search-results');
  if (!res.length) { ul.innerHTML = '<li class="muted">No matches</li>'; ul.classList.remove('hidden'); return; }
  ul.innerHTML = res.map(() => '<li></li>').join('');
  [...ul.children].forEach((li, i) => { li.innerHTML = resultRow(res[i]); li.onclick = () => selectResult(res[i]); });
  ul.classList.remove('hidden');
}
function selectResult(p) {
  hideResults(); searchInput.value = ''; searchInput.blur();
  recordSearch(p);
  map.flyTo({ center: [p.lng, p.lat], zoom: 13 });
  addPoint({ lng: p.lng, lat: p.lat, name: p.name, id: p.id });
}
function hideResults() { $('search-results').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#searchbar')) hideResults(); });

// --- recent + starred searches (last 50; starred kept forever) ---
const SEARCH_KEY = 'cp.searches';
const getSearches = () => { try { return JSON.parse(localStorage.getItem(SEARCH_KEY) || '[]'); } catch { return []; } };
const saveSearches = (a) => localStorage.setItem(SEARCH_KEY, JSON.stringify(a));
function recordSearch(p) {
  let a = getSearches().filter((x) => !(x.name === p.name && x.id === p.id));
  a.unshift({ name: p.name, lng: p.lng, lat: p.lat, id: p.id || '', layer: p.layer || '', region: p.region || '', star: false, at: Date.now() });
  let n = 0;
  a = a.filter((x) => x.star || ++n <= 50); // keep all starred + 50 most-recent
  saveSearches(a);
}
function toggleStar(rec) {
  const a = getSearches();
  const it = a.find((x) => x.name === rec.name && x.id === rec.id);
  if (it) { it.star = !it.star; saveSearches(a); }
}
function renderRecents() {
  const a = getSearches();
  const ul = $('search-results');
  if (!a.length) { hideResults(); return; }
  const sorted = [...a].sort((x, y) => (y.star ? 1 : 0) - (x.star ? 1 : 0)); // starred first
  ul.innerHTML = '<li class="rec-head">Recent &amp; saved</li>' + sorted.map(() => '<li class="rec"></li>').join('');
  const rows = [...ul.querySelectorAll('.rec')];
  rows.forEach((li, i) => {
    const p = sorted[i];
    li.innerHTML = `${resultRow(p)}<button class="star ${p.star ? 'on' : ''}" title="${p.star ? 'Saved' : 'Save forever'}">${p.star ? '★' : '☆'}</button>`;
    li.onclick = (e) => { if (e.target.closest('.star')) return; selectResult(p); };
    li.querySelector('.star').onclick = (e) => { e.stopPropagation(); toggleStar(p); renderRecents(); };
  });
  ul.classList.remove('hidden');
}

// --- hints + panel ---
function setStatus(t) { $('status').innerHTML = t; }
function setHint(t) { const h = $('hint'); h.innerHTML = t; h.classList.toggle('hidden', !t); }
function updateHint() {
  if (points.length === 0) promptForStart();
  else if (points.length === 1) setHint('Tap or search to set your <b>destination</b>.');
  else setHint('');
}
function promptForStart() {
  let t = 'Tap or search to set your <b>start</b>';
  if (userLocation) t += ' or <a href="#" id="use-loc">use current location</a>';
  setHint(t + '.');
  if (userLocation) $('use-loc').onclick = (ev) => { ev.preventDefault(); if (ready) addPoint({ ...userLocation, name: 'Current location', id: '' }); };
}
function showPanel() {
  $('panel').classList.remove('hidden');
  document.body.classList.add('panel-open');
  setCollapsed(true); // closed by default — tap the header to see detail
}
function setCollapsed(c) {
  $('panel').classList.toggle('collapsed', c);
  $('panel-header').setAttribute('aria-expanded', String(!c));
  $('route-title').innerHTML = c ? escapeHtml(summaryText) : panelTitle;
}
$('panel-header').onclick = () => setCollapsed(!$('panel').classList.contains('collapsed'));
function showError(t) { setHint(`<span class="err">${escapeHtml(t)}</span>`); }

// --- toolbar ---
$('btn-undo').onclick = undoOrClear;
function askForLocation() {
  try { map?._geolocate?.trigger(); } catch { /* needs gesture */ }
  // A one-shot getCurrentPosition is more reliable than the control's
  // watchPosition (which on some platforms throws kCLErrorLocationUnknown).
  navigator.geolocation?.getCurrentPosition(
    (pos) => { userLocation = { lng: pos.coords.longitude, lat: pos.coords.latitude }; if (points.length === 0) promptForStart(); },
    () => { /* silent on the automatic attempt */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}
function locateMe() {
  if (userLocation) { map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14 }); }
  try { map._geolocate?.trigger(); } catch { /* needs gesture */ }
  if (!navigator.geolocation) { setStatus('No location on this device'); setTimeout(() => setStatus(''), 3000); return; }
  setStatus(t('Findin’ ye…', 'Finding you…'));
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14 });
      setStatus(''); if (points.length === 0) promptForStart();
    },
    (err) => { setStatus('Location: ' + err.message); setTimeout(() => setStatus(''), 4000); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}
$('btn-locate').onclick = locateMe;

// --- settings ---
$('btn-settings').onclick = () => {
  const s = getSettings();
  $('set-speed').value = s.speedMph; $('set-lock').value = s.lockMinutes; $('set-hours').value = s.hoursPerDay;
  $('set-theme').value = theme;
  const trips = t('voyages', 'trips');
  const { factor, samples } = correctionFactor(s);
  $('calib-note').textContent = samples >= 2 ? `Calibrated from ${samples} ${trips}: predictions ×${factor.toFixed(2)}.` : `Log a couple of ${trips} and predictions self-calibrate.`;
  $('settings').showModal();
};
$('set-save').addEventListener('click', () => {
  saveSettings({ speedMph: clamp(+$('set-speed').value, 1, 8, 3), lockMinutes: clamp(+$('set-lock').value, 1, 40, 12), hoursPerDay: clamp(+$('set-hours').value, 2, 14, 7) });
  theme = $('set-theme').value === 'gongoozler' ? 'gongoozler' : 'pirate';
  localStorage.setItem('cp.theme', theme);
  applyTheme();
  if (lastRoute) renderSummary(lastRoute);
});

function clamp(n, lo, hi, dflt) { return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

promptForStart();
