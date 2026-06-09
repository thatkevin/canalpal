import { createMap, maplibregl, POI_LAYERS, setRoute, setRouteFacilities, setRouteLocks, cycleBasemap, fitRoute } from './map.js';
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
const map = createMap('map');
window.__map = map; // handle for smoke tests / debugging
let points = [];        // [{lng,lat,name,id}]
let markers = [];
let lastRoute = null, summaryText = 'Journey', userLocation = null, ready = false, popup = null;

map._geolocate?.on('geolocate', (e) => {
  userLocation = { lng: e.coords.longitude, lat: e.coords.latitude };
  if (points.length === 0) promptForStart();
});

// Load the routing network independently of map tiles, so the planner is usable
// even if tiles are slow or a tile source hiccups.
(async () => {
  setStatus('Loading network…');
  try {
    const stats = await call('init', { base: BASE });
    ready = true;
    setStatus(`${stats.nodes.toLocaleString()} points · ready`);
    setTimeout(() => setStatus(''), 2500);
    $('loading').classList.add('gone');
    setTimeout(() => $('loading')?.remove(), 600);
    askForLocation();
  } catch (err) { setStatus('Failed to load chart'); console.error(err); }
})();

// --- map click: open a POI popup, else drop a waypoint ---
map.on('click', (e) => {
  if (!ready) return;
  const feats = map.queryRenderedFeatures(e.point, { layers: [...POI_LAYERS, 'routefac'] });
  if (feats.length) { showPoiPopup(e.lngLat, poiFromFeature(feats[0])); return; }
  addPoint({ lng: e.lngLat.lng, lat: e.lngLat.lat });
});
map.on('mouseenter', 'pl-jct', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'pl-jct', () => (map.getCanvas().style.cursor = ''));

// --- waypoints + draggable markers ---
function addPoint(p) {
  if (!ready) return;
  if (p.name === undefined) Object.assign(p, nameFor(p.lng, p.lat));
  points.push(p);
  renderMarkers();
  if (points.length >= 2) computeRoute();
  else { clearRouteOnly(); updateHint(); }
}

function renderMarkers() {
  markers.forEach((m) => m.remove());
  markers = points.map((p, i) => {
    const role = i === 0 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'via';
    const el = document.createElement('div');
    el.className = 'wp wp-' + role;
    el.innerHTML = `<span>${role === 'via' ? i : ''}</span>`;
    const m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
    m.on('dragend', () => {
      const ll = m.getLngLat();
      points[i] = { lng: ll.lng, lat: ll.lat, ...nameFor(ll.lng, ll.lat) };
      if (points.length >= 2) computeRoute(); else updateHint();
    });
    return m;
  });
}

function undo() {
  if (!points.length) return;
  points.pop(); renderMarkers();
  if (points.length >= 2) computeRoute();
  else { lastRoute = null; clearRouteOnly(); updateHint(); }
}
function reset() {
  points = []; lastRoute = null; renderMarkers();
  clearRouteOnly(); $('search').value = ''; popup?.remove();
  promptForStart();
}
function clearRouteOnly() {
  setRoute(map, null); setRouteFacilities(map, null); setRouteLocks(map, null);
  $('panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
}

// nearest named place (for breadcrumb + drag relabelling)
let gazetteer = [];
fetch(BASE + 'data/places-named.json').then((r) => r.json()).then((d) => { gazetteer = d; });
function nameFor(lng, lat) {
  let best = null, bd = Infinity;
  for (const g of gazetteer) { const d = (g.lng - lng) ** 2 + (g.lat - lat) ** 2; if (d < bd) { bd = d; best = g; } }
  return best ? { name: best.name, id: best.id } : { name: null, id: '' };
}

async function computeRoute() {
  setStatus('Charting course…'); setHint('');
  try {
    const r = await call('route', { points });
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
  summaryText = `Journey: ${miles}mi ${fur}f, ${r.locks} lock${r.locks === 1 ? '' : 's'}, ${formatDuration(est.hours)}, ${est.days} day${est.days === 1 ? '' : 's'}`;

  renderBreadcrumb();

  $('route-warning').innerHTML = r.excludedMiles > 0.02
    ? `<div class="warn">⚠ <span><b>Heads up:</b> this route uses ${r.excludedMiles.toFixed(1)} mi of disused / unnavigable water${r.excludedNames.length ? ` (${r.excludedNames.slice(0, 2).map(escapeHtml).join(', ')}${r.excludedNames.length > 2 ? '…' : ''})` : ''}. You may not get a boat through.</span></div>`
    : '';

  $('route-summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="big">${miles}<small>mi</small> ${fur}<small>fur</small></span><span class="lbl">distance</span></div>
      <div class="stat"><span class="big">${r.locks}</span><span class="lbl">lock${r.locks === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="big">${formatDuration(est.hours)}</span><span class="lbl">cruising</span></div>
      <div class="stat"><span class="big">${est.days}</span><span class="lbl">day${est.days === 1 ? '' : 's'}*</span></div>
    </div>
    <p class="muted small">*at ${s.hoursPerDay} hrs/day, ${s.speedMph} mph, ${s.lockMinutes} min/lock${est.samples >= 2 ? ` · ×${est.factor.toFixed(2)} from ${est.samples} logged trips` : ''}. Tap the water to add a stop, or drag a pin.</p>
    <button id="btn-log" class="primary">Log this as a completed voyage…</button>
  `;

  const facs = r.facilities;
  if (facs.length) {
    $('route-facilities').innerHTML = `<h3>On the way (${facs.length})</h3>` +
      facs.map((f, i) => `<div class="fac" data-fi="${i}"><span class="fac-dot"></span><span class="fac-name">${escapeHtml(f.title)}</span><span class="fac-mi">${f.miles.toFixed(1)} mi</span></div>`).join('');
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
  'cp-shop': 'Shop', 'cp-supermarket': 'Supermarket', 'cp-genshop': 'Store', 'cp-pharmacy': 'Pharmacy', 'cp-laundry': 'Laundry',
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
  if (id) html += `<a class="poi-link" href="${CANALPLAN}${id}" target="_blank" rel="noopener">View on CanalPlanAC ↗</a>`;
  popup = new maplibregl.Popup({ offset: 14 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

// --- trip logging (learned weighting) ---
function logTripFlow(r, est) {
  const txt = prompt(`How long did this voyage actually take (hours)?\n\nPredicted: ${est.hours.toFixed(1)} hr for ${r.miles.toFixed(1)} mi & ${r.locks} locks.`, est.hours.toFixed(1));
  if (txt == null) return;
  const actual = parseFloat(txt);
  if (!isFinite(actual) || actual <= 0) return;
  logTrip({ miles: r.miles, locks: r.locks, predictedHours: est.hours, actualHours: actual });
  const { factor, samples } = correctionFactor();
  setStatus(`Logged. New correction ×${factor.toFixed(2)} (${samples} voyages).`);
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
  $('route-title').innerHTML = c ? escapeHtml(summaryText) : 'Journey';
}
$('panel-header').onclick = () => setCollapsed(!$('panel').classList.contains('collapsed'));
function showError(t) { setHint(`<span class="err">${escapeHtml(t)}</span>`); }

// --- toolbar ---
$('btn-undo').onclick = undo;
$('btn-reset').onclick = reset;
$('btn-basemap').onclick = () => { const n = cycleBasemap(map); setStatus(n); setTimeout(() => setStatus(''), 1500); };
function askForLocation() { try { map._geolocate?.trigger(); } catch { /* needs gesture */ } }
function locateMe() { if (userLocation) map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14 }); askForLocation(); }
map.on('error', () => {});
$('btn-locate').onclick = locateMe;

// --- settings ---
$('btn-settings').onclick = () => {
  const s = getSettings();
  $('set-speed').value = s.speedMph; $('set-lock').value = s.lockMinutes; $('set-hours').value = s.hoursPerDay;
  const { factor, samples } = correctionFactor(s);
  $('calib-note').textContent = samples >= 2 ? `Calibrated from ${samples} voyages: predictions ×${factor.toFixed(2)}.` : 'Log a couple of voyages and predictions self-calibrate.';
  $('settings').showModal();
};
$('set-save').addEventListener('click', () => {
  saveSettings({ speedMph: clamp(+$('set-speed').value, 1, 8, 3), lockMinutes: clamp(+$('set-lock').value, 1, 40, 12), hoursPerDay: clamp(+$('set-hours').value, 2, 14, 7) });
  if (lastRoute) renderSummary(lastRoute);
});

function clamp(n, lo, hi, dflt) { return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

promptForStart();
