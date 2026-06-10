import { createMap, maplibregl, protocol, POI_LAYERS, POI_CATS, setRoute, setTrail, setRouteFacilities, setRouteLocks, setStoppages, setLockFlights, setLocksAll, setLayerVisible, fitRoute } from './map.js';
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
  'Chemist': '💊', 'Laundry': '🧺', 'Shower': '🚿', 'Toilets': '🚻', 'Mooring': '⚓', 'Visitor mooring': '⚓', 'Boatyard': '🛥️',
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
  loadLockGroups(); // network's built — group locks into flights and show them
  resumeActiveJourney(); // pick up a journey that's still under way from a reload
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
  map._geolocate?.on('error', (e) => { setStatus(geoErrText(e)); setTimeout(() => setStatus(''), 7000); });
  map.on('error', () => {});

  // feed the locks once both the style and the grouped data are ready
  map.on('load', () => { if (lockAllData.length) applyLocks(); applyLayerPrefs(); });

  // map click: open a POI popup, else drop a waypoint
  map.on('click', (e) => {
    if (!ready) return;
    // a lock flight (zoomed out) or an individual lock (zoomed in) → info popup
    const lp = map.queryRenderedFeatures(e.point, { layers: ['lock-coarse', 'lock-fine', 'lock-point'] });
    if (lp.length) {
      const p = lp[0].properties;
      const type = p.count > 1 ? `Lock flight · ${p.count} locks` : 'Lock';
      showPoiPopup(e.lngLat, { title: p.title || 'Lock', type });
      return;
    }
    // a stoppage marker → its own popup with a CRT link
    const stp = map.queryRenderedFeatures(e.point, { layers: ['stoppages'] });
    if (stp.length) { const i = lastStoppages.findIndex((s) => s.id === stp[0].properties.id); if (i >= 0) showStoppageAt(i); return; }
    const feats = map.queryRenderedFeatures(e.point, { layers: [...POI_LAYERS, 'routefac'] });
    if (feats.length) {
      const f = feats[0];
      // a facility that's on the chosen route → step-through popup; other POIs → plain
      if (f.layer.id === 'routefac' && lastRoute?.facilities) {
        const [lng, lat] = f.geometry.coordinates;
        const i = lastRoute.facilities.findIndex((x) => Math.abs(x.lng - lng) < 1e-6 && Math.abs(x.lat - lat) < 1e-6);
        if (i >= 0) { showFacAt(i); return; }
      }
      showPoiPopup(e.lngLat, poiFromFeature(f)); return;
    }
    choosePlace({ lng: e.lngLat.lng, lat: e.lngLat.lat });
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
  if (p.name === undefined) Object.assign(p, nameFor(p.lng, p.lat)); // keep explicit names (search/last start)
  points.push(p);
  renderMarkers();
  if (points.length === 1) saveLastStart(p);
  if (points.length >= 2) computeRoute();
  else { setRoute(map, null); setRouteLocks(map, null); requestServices(); updateHint(); }
}

// --- choosing a place: first one starts the journey, later ones preview first ---
// (issue #13 — no more silent appending; a wrong start is fixed via per-stop ✕
// removal and the search-bar Clear, which also resolves the stuck-start, #12)
let preview = null;          // { p, index, route } — transient, not in `points`
let previewMarker = null;
async function choosePlace(p) {
  if (!ready) return;
  popup?.remove();
  if (points.length === 0) { await addPoint(p); map.flyTo({ center: [p.lng, p.lat], zoom: 13 }); return; }
  await showPreview(p);
}
async function showPreview(p) {
  await snapPoint(p);
  if (p.name === undefined || p.name === null) Object.assign(p, nameFor(p.lng, p.lat));
  let index = points.length, route = null;
  try { ({ index, route } = await call('bestinsert', { points, p })); } catch (e) { console.error(e); }
  preview = { p, index, route };
  previewMarker?.remove();
  const el = document.createElement('div'); el.className = 'wp wp-preview'; el.innerHTML = '<span>?</span>';
  previewMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
  map.flyTo({ center: [p.lng, p.lat], zoom: 13, offset: [0, -60] });
  renderPreviewCard();
}
function clearPreview() { preview = null; previewMarker?.remove(); previewMarker = null; }
function previewBack() {
  clearPreview();
  if (active) renderTracking();                                  // resume the live view
  else if (points.length >= 2 && lastRoute) renderSummary(lastRoute);
  else if (points.length === 1) requestServices();
  setCollapsed(true);
  updateUndoIcon();
}
function previewAdd() {
  if (!preview) return;
  const { p, index, route } = preview;
  points.splice(index, 0, p);
  clearPreview();
  renderMarkers();
  if (route && points.length >= 2) applyRoute(route, true); // fit the whole route into view
  else computeRoute();
}
function renderPreviewCard() {
  panelView = 'preview';
  const { p, index } = preview;
  // describe where it lands, rather than an opaque "stop N of M": between the two
  // stops it falls between, or as the new destination at the end.
  const where = index < points.length
    ? `between ${escapeHtml(points[index - 1].name || 'start')} and ${escapeHtml(points[index].name || 'the next stop')}`
    : 'as your destination';
  panelTitle = 'Add a stop?';
  summaryText = `📍 ${p.name || 'Place'} — add to route?`;
  $('route-breadcrumb').innerHTML = `<b>📍 ${escapeHtml(p.name || 'Place')}</b>`;
  $('route-warning').innerHTML = '';
  $('route-stoppages').innerHTML = '';
  $('route-summary').innerHTML = `<p class="muted small">Would slot in ${where}.</p>
    <div class="preview-actions"><button id="pv-back" class="ghost">‹ Back to journey</button><button id="pv-add" class="primary">＋ Add to route</button></div>`;
  $('route-facilities').innerHTML = '';
  $('route-log').innerHTML = '';
  $('pv-back').onclick = previewBack;
  $('pv-add').onclick = previewAdd;
  showPanel(); setCollapsed(false); // expand so the buttons show
  updateUndoIcon();
}

// --- live journey tracking: "Avast — start", live position + ETA, resume on reload ---
let active = null;        // { points, startedAt, track:[{lng,lat,t}] } — persisted
let watchId = null;
let liveMarker = null;
let lastProg = null;      // most recent route progress, for in-place tracking updates
let panelView = null;     // which view the panel is showing: journey|services|preview|tracking|history
const ACTIVE_KEY = 'cp.active';
const ARRIVE_MI = 0.12;   // ~190 m from the destination counts as arrived
const saveActive = () => { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(active)); } catch { /* quota */ } };
const getActive = () => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch { return null; } };

function startJourney() {
  if (!lastRoute || points.length < 2) return;
  active = { points: points.map(({ lng, lat, name, id }) => ({ lng, lat, name, id: id || '' })), startedAt: Date.now(), track: [] };
  saveActive(); beginWatch(); renderTracking();
}
function beginWatch() {
  if (!navigator.geolocation) { setStatus('No location on this device'); setTimeout(() => setStatus(''), 3000); return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onFix,
    (e) => { setStatus('Location: ' + e.message); setTimeout(() => setStatus(''), 3000); },
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
}
function onFix(pos) {
  if (!active) return;
  const p = { lng: pos.coords.longitude, lat: pos.coords.latitude, t: Date.now() };
  active.track.push(p);
  if (active.track.length > 5000) active.track.splice(0, active.track.length - 5000);
  saveActive();
  if (liveMarker) liveMarker.setLngLat([p.lng, p.lat]);
  else { const el = document.createElement('div'); el.className = 'wp wp-live'; el.innerHTML = '<span>⛵</span>'; liveMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map); }
  setTrail(map, active.track.map((q) => [q.lng, q.lat]));
  lastProg = routeProgress(p);
  // Only refresh the tracking numbers in place — never rebuild/recollapse the
  // panel here, so the user can expand it to tap "end", or wander off to preview
  // and add another stop, without it flipping back. (Builds the panel if needed.)
  if (panelView === 'tracking') updateTrackingNumbers(lastProg);
  // Don't call it arrived while a lock still lies ahead on the route — wait until
  // you're on the destination's side of it.
  if (lastProg && lastProg.remainingMiles <= ARRIVE_MI && lastProg.locksAhead === 0) endJourney(true);
}
// Along-route distance (miles) of each lock, cached on the route so we can tell
// how many locks still lie ahead of the current position.
function lockAlongMiles() {
  if (!lastRoute) return [];
  if (lastRoute._lockAlong) return lastRoute._lockAlong;
  const coords = lastRoute.coords, locks = lastRoute.routeLocks || [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + metres(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) / 1609.344;
  lastRoute._lockAlong = locks.map((lk) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < coords.length; i++) { const d = metres(lk.lng, lk.lat, coords[i][0], coords[i][1]); if (d < best) { best = d; bi = i; } }
    return cum[bi];
  });
  return lastRoute._lockAlong;
}
// Project the current position onto the planned polyline → distance covered, so
// remaining distance + ETA update as you go.
function routeProgress(p) {
  const coords = lastRoute?.coords; if (!coords || coords.length < 2) return null;
  let best = Infinity, coveredM = 0, cum = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const cosLat = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    const ax = a[0] * cosLat, ay = a[1], bx = b[0] * cosLat, by = b[1], px = p.lng * cosLat, py = p.lat;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let tt = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0; tt = Math.max(0, Math.min(1, tt));
    const segLen = metres(a[0], a[1], b[0], b[1]);
    const d = metres(p.lng, p.lat, (ax + tt * dx) / cosLat, ay + tt * dy);
    if (d < best) { best = d; coveredM = cum + tt * segLen; }
    cum += segLen;
  }
  const total = lastRoute.miles, coveredMi = coveredM / 1609.344, remaining = Math.max(0, total - coveredMi);
  const est = estimate(total, lastRoute.locks, getSettings(), { bendFactor: lastRoute.bendFactor });
  const pace = total > 0 ? est.hours / total : 0;
  const locksAhead = lockAlongMiles().filter((m) => m > coveredMi + 0.005).length; // ~8m past
  return { coveredMi, remainingMiles: remaining, remHours: remaining * pace, off: best, locksAhead };
}
// Actual distance travelled along the recorded track + current speed (last ~60s).
function trackStats() {
  const tr = active?.track || [];
  let distMi = 0;
  for (let i = 1; i < tr.length; i++) distMi += metres(tr[i - 1].lng, tr[i - 1].lat, tr[i].lng, tr[i].lat) / 1609.344;
  let cur = 0;
  if (tr.length >= 2) {
    const tNow = tr[tr.length - 1].t; let i = tr.length - 1, d = 0;
    while (i > 0 && tNow - tr[i - 1].t < 60000) { d += metres(tr[i].lng, tr[i].lat, tr[i - 1].lng, tr[i - 1].lat); i--; }
    const dt = (tNow - tr[i].t) / 3600000;
    if (dt > 0) cur = (d / 1609.344) / dt;
  }
  return { distMi, cur };
}
// Build the tracking panel once (on start / route change). onFix then only
// updates the numbers in place via updateTrackingNumbers — no rebuilds.
function renderTracking() {
  if (!active) return;
  panelView = 'tracking';
  panelTitle = 'On your way';
  const a = active.points, dest = a[a.length - 1];
  $('route-breadcrumb').innerHTML = `<b>${escapeHtml(a[0].name || 'Start')}</b> → <b>${escapeHtml(dest.name || 'End')}</b>`;
  $('route-warning').innerHTML = ''; $('route-stoppages').innerHTML = ''; $('route-log').innerHTML = '';
  $('route-summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="big" id="trk-togo">–</span><span class="lbl">to go</span></div>
      <div class="stat"><span class="big" id="trk-remaining">–</span><span class="lbl">remaining</span></div>
      <div class="stat"><span class="big" id="trk-eta">–</span><span class="lbl">ETA</span></div>
      <div class="stat"><span class="big" id="trk-underway">–</span><span class="lbl">underway</span></div>
    </div>
    <p class="muted small" id="trk-speed">Waiting for your location…</p>
    <p class="muted small" id="trk-off" hidden>You look off the planned route — ETA may drift.</p>
    <div class="trk-actions">
      <button id="trk-compass" class="ghost ${compassOn ? 'on' : ''}" title="Face direction of travel / back to north">🧭 Heading-up</button>
      <button id="btn-end" class="primary">Arrived / end journey</button>
    </div>`;
  $('route-facilities').innerHTML = '';
  $('btn-end').onclick = () => endJourney(false);
  $('trk-compass').onclick = () => setCompass(!compassOn);
  showPanel();
  updateTrackingNumbers(lastProg);
}
// Lightweight per-fix update: text only, no rebuild, no collapse change.
function updateTrackingNumbers(prog) {
  if (panelView !== 'tracking' || !active) return;
  const elapsed = (Date.now() - active.startedAt) / 3600000;
  if (prog) {
    const arr = new Date(Date.now() + prog.remHours * 3600000).toTimeString().slice(0, 5);
    const st = trackStats();
    const avg = elapsed > 0 ? prog.coveredMi / elapsed : 0;
    summaryText = `🛶 ${prog.remainingMiles.toFixed(1)} mi to go · arrive ~${arr}`;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('trk-togo', prog.remainingMiles.toFixed(1)); set('trk-remaining', formatDuration(prog.remHours));
    set('trk-eta', arr); set('trk-underway', formatDuration(elapsed));
    set('trk-speed', `Now ${st.cur.toFixed(1)} mph · avg ${avg.toFixed(1)} mph · ${st.distMi.toFixed(1)} mi travelled${prog.locksAhead ? ` · ${prog.locksAhead} lock${prog.locksAhead === 1 ? '' : 's'} ahead` : ''}.`);
    const off = $('trk-off'); if (off) off.hidden = !(prog.off > 150);
  } else {
    summaryText = '🛶 Journey under way — waiting for GPS…';
  }
  if ($('panel').classList.contains('collapsed')) $('route-title').innerHTML = escapeHtml(summaryText);
}
function endJourney(arrived) {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (active) {
    const actualHours = (Date.now() - active.startedAt) / 3600000;
    const dest = active.points[active.points.length - 1];
    // record it in the journey history with estimated per-lock dwell times
    const hist = getHistory();
    hist.unshift({ id: 'h' + Date.now(), name: `${active.points[0].name || 'Start'} → ${dest.name || 'End'}`,
      points: active.points, startedAt: active.startedAt, at: Date.now(), arrived, actualHours,
      miles: lastRoute?.miles || 0, locks: lastRoute?.locks || 0, track: active.track,
      lockTimes: lockDwellTimes(active.track, lastRoute?.routeLocks) });
    saveHistory(hist);
    if (arrived && lastRoute) { const est = estimate(lastRoute.miles, lastRoute.locks, getSettings(), { bendFactor: lastRoute.bendFactor }); logTrip({ miles: lastRoute.miles, locks: lastRoute.locks, predictedHours: est.hours, actualHours }); }
    setStatus(arrived ? t('Arrived — voyage logged ⚓', 'Arrived — journey logged') : 'Journey ended'); setTimeout(() => setStatus(''), 3500);
  }
  active = null; localStorage.removeItem(ACTIVE_KEY);
  liveMarker?.remove(); liveMarker = null;
  setTrail(map, null);
  lastProg = null;
  if (compassOn) setCompass(false); // back to north-up when the journey's over
  if (lastRoute) renderSummary(lastRoute); else { panelView = null; $('panel').classList.add('hidden'); document.body.classList.remove('panel-open'); }
}
// On reload, pick up a journey that's still under way.
async function resumeActiveJourney() {
  const a = getActive(); if (!a || !a.points || a.points.length < 2) return;
  active = a; points = a.points.map((p) => ({ ...p })); renderMarkers();
  await computeRoute();
  if (!lastRoute) { active = null; localStorage.removeItem(ACTIVE_KEY); return; }
  setTrail(map, active.track.map((q) => [q.lng, q.lat])); // restore the breadcrumb
  beginWatch(); renderTracking();
}

// --- demo: play a journey along the planned route (no GPS needed) ---
// In the browser console:  __simulate()  — uses the current route, or a demo
// Worcester & Birmingham leg if none is planned. __simulate(20) runs it faster.
let simTimer = null;
function coordAtMiles(coords, mi) {
  let cum = 0; const target = mi * 1609.344;
  for (let k = 1; k < coords.length; k++) {
    const seg = metres(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]);
    if (cum + seg >= target) { const f = seg ? (target - cum) / seg : 0; return [coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * f, coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * f]; }
    cum += seg;
  }
  return coords[coords.length - 1];
}
function startSim(secs = 40) {
  if (!lastRoute) return;
  if (simTimer) clearInterval(simTimer);
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  active = { points: points.map(({ lng, lat, name, id }) => ({ lng, lat, name, id: id || '' })), startedAt: Date.now(), track: [] };
  saveActive(); renderTracking();
  const coords = lastRoute.coords, total = lastRoute.miles;
  const steps = Math.max(8, Math.round(secs)); let step = 0;
  simTimer = setInterval(() => {
    step++;
    const [lng, lat] = coordAtMiles(coords, total * step / steps);
    onFix({ coords: { longitude: lng, latitude: lat } });
    if (!active || step >= steps) { clearInterval(simTimer); simTimer = null; }
  }, 1000);
}
window.__simulate = async (secs) => {
  if (!lastRoute) {
    points = [{ lng: -1.9717, lat: 52.3486, name: 'Alvechurch' }, { lng: -1.9300, lat: 52.4060, name: "King's Norton" }];
    renderMarkers(); await computeRoute();
    if (!lastRoute) { console.warn('Could not plan the demo route.'); return; }
  }
  startSim(secs);
  console.log('Simulating the journey — watch the trail, ETA and speed update, then arrival.');
};

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

// One two-in-one button: undo the last stop when there's a route, broom/clear
// everything when there's 0–1 points (or a preview open).
function updateUndoIcon() {
  $('btn-undo').textContent = points.length >= 2 ? '↶' : '🧹';
  $('btn-undo').title = points.length >= 2 ? 'Undo last stop' : 'Clear';
  $('btn-undo').style.display = (points.length || preview) ? '' : 'none';
}
function undoOrClear() {
  if (preview) { previewBack(); return; }     // back out of a previewed place first
  if (points.length >= 2) { removeStop(points.length - 1); return; } // undo last stop
  reset();                                      // 0–1 points → clear it all
}
function reset() {
  points = []; lastRoute = null; clearPreview(); renderMarkers();
  clearRouteOnly(); $('search').value = ''; popup?.remove();
  promptForStart();
}
function clearRouteOnly() {
  panelView = null;
  setRoute(map, null); setRouteFacilities(map, null); setRouteLocks(map, null); setStoppages(map, []);
  $('route-stoppages').innerHTML = ''; $('route-log').innerHTML = '';
  $('panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
}

// nearest named place (for breadcrumb + drag relabelling)
let gazetteer = [];
fetch(BASE + 'data/places-named.json').then((r) => r.json()).then((d) => { gazetteer = d; });

// locks — always on, in three zoom tiers: coarse flights (zoomed out) → fine
// flights → every individual lock. Loaded once the worker's network is ready.
let lockCoarse = [], lockFine = [], lockAllData = [];
function applyLocks() {
  if (!map) return;
  const feed = () => { setLockFlights(map, 'locks-coarse', lockCoarse); setLockFlights(map, 'locks-fine', lockFine); setLocksAll(map, lockAllData); };
  if (map.isStyleLoaded()) feed(); else map.once('load', feed);
}
function loadLockGroups() {
  call('lockgroups').then((r) => {
    lockCoarse = r?.coarse || []; lockFine = r?.fine || []; lockAllData = r?.all || [];
    applyLocks();
  }).catch((e) => console.error(e));
}

// --- legend: toggle POI categories on/off (locks are pinned on) ---
const LAYER_KEY = 'cp.layers';
const getLayerPrefs = () => { try { return JSON.parse(localStorage.getItem(LAYER_KEY) || '{}'); } catch { return {}; } };
function buildLegend() {
  $('legend-body').innerHTML = POI_CATS.map((c) => `<button type="button" class="leg-row" data-cat="${c.id}"><span class="leg-emoji">${c.emoji}</span><span class="leg-label">${escapeHtml(c.label)}</span></button>`).join('');
  $('legend-body').querySelectorAll('.leg-row[data-cat]').forEach((el) => { el.onclick = () => toggleCat(el.dataset.cat); });
  applyLayerPrefs();
}
function toggleCat(id) {
  const prefs = getLayerPrefs();
  prefs[id] = prefs[id] === false; // flip (default on)
  localStorage.setItem(LAYER_KEY, JSON.stringify(prefs));
  applyLayerPrefs();
}
function applyLayerPrefs() {
  const prefs = getLayerPrefs();
  for (const c of POI_CATS) {
    const on = prefs[c.id] !== false;
    if (map) setLayerVisible(map, 'cat-' + c.id, on);
    const el = document.querySelector(`.leg-row[data-cat="${c.id}"]`);
    if (el) el.classList.toggle('leg-off', !on);
  }
}
buildLegend();

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
    applyRoute(r, true);
    setStatus('');
  } catch (err) { setStatus(''); showError(String(err.message || err)); }
}

// Paint a computed route onto the map + panel. `fit` re-frames the map (skip it
// when we already have the route, e.g. confirming a previewed stop).
function applyRoute(r, fit) {
  lastRoute = r;
  setHint(''); // a journey's set now — clear the "tap to set destination" prompt
  setRoute(map, r.coords); setRouteFacilities(map, r.facilities); setRouteLocks(map, r.routeLocks);
  if (fit) fitRoute(map, r.coords);
  if (active) renderTracking(); else renderSummary(r); // keep the live view while under way
}

function renderSummary(r) {
  panelView = 'journey';
  const s = getSettings();
  const est = estimate(r.miles, r.locks, s, { bendFactor: r.bendFactor });
  const miles = Math.floor(r.miles);
  const fur = Math.round((r.miles - miles) * 8);
  panelTitle = 'Journey';
  // lead the collapsed bar with the ordered stops (start › via › … › end) so the
  // whole journey shows at a glance, then the key figures
  const stopPath = points.map((p) => p.name || 'pin').join(' › ');
  summaryText = `${stopPath} · ${miles}mi ${r.locks}lk · ${formatDuration(est.hours)}`;

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
  `;

  // "On the way": the journey's own via stops interleaved with facilities, in
  // order along the route, each with distance + ETA at the journey's average pace.
  const facs = r.facilities;
  const pace = r.miles > 0 ? est.hours / r.miles : 0; // hours per mile (incl. locks)
  const etaStr = (m) => formatDuration(m * pace);
  const stops = [];
  if (r.legMiles) {
    let cum = 0;
    for (let i = 0; i < r.legMiles.length; i++) {
      cum += r.legMiles[i];
      const via = i + 1; // points index reached after this leg
      if (via < points.length - 1) stops.push({ stop: true, miles: cum, num: via + 1, name: points[via].name || `Stop ${via + 1}`, lng: points[via].lng, lat: points[via].lat });
    }
  }
  const items = facs.map((f, i) => ({ fi: i, miles: f.miles, type: f.type, title: f.title }))
    .concat(stops).sort((a, b) => a.miles - b.miles);
  if (items.length) {
    $('route-facilities').innerHTML = `<h3>On the way (${items.length})</h3>` + items.map((it) => it.stop
      ? `<div class="fac fac-stop" data-stop="${it.num}" data-lng="${it.lng}" data-lat="${it.lat}"><span class="fac-emoji">🚩</span><span class="fac-name"><b>Stop ${it.num}</b> · ${escapeHtml(it.name)}</span><span class="fac-mi">${it.miles.toFixed(1)} mi · ${etaStr(it.miles)}</span></div>`
      : `<div class="fac" data-fi="${it.fi}"><span class="fac-emoji">${emojiFor(it.type)}</span><span class="fac-name">${escapeHtml(it.title)}</span><span class="fac-mi">${it.miles.toFixed(1)} mi · ${etaStr(it.miles)}</span></div>`).join('');
    $('route-facilities').querySelectorAll('.fac').forEach((el) => {
      if (el.dataset.stop) el.onclick = () => { setCollapsed(true); map.flyTo({ center: [+el.dataset.lng, +el.dataset.lat], zoom: 14, offset: [0, -40] }); };
      else el.onclick = () => showFacAt(+el.dataset.fi);
    });
  } else {
    $('route-facilities').innerHTML = '<p class="muted small">No mapped facilities directly on this route.</p>';
  }

  // Start / save / log buttons at the very bottom of the panel, below "On the way".
  $('route-log').innerHTML = `<button id="btn-go" class="primary">${t('⚓ Avast — start journey', '▶ Start journey')}</button><button id="btn-save" class="ghost">💾 Save journey</button><button id="btn-log" class="ghost">${t('Log this as a completed voyage…', 'Log this as a completed trip…')}</button>`;
  $('btn-go').onclick = startJourney;
  $('btn-save').onclick = saveJourney;
  $('btn-log').onclick = () => logTripFlow(r, est);
  showPanel();
}

// Nearest boater services from the start point — shown in the collapsed bar with
// emoji + a direction arrow + distance/locks, with a detailed list when expanded.
function renderStartFacilities(facs) {
  panelView = 'services';
  panelTitle = 'Nearest facilities';
  const seen = new Set(); const bits = [];
  for (const f of facs) {
    const em = SERVICE_EMOJI[f.type] || '•';
    if (seen.has(em)) continue; seen.add(em);
    bits.push(`${em} ${arrowFor(f.bearing)} ${f.miles.toFixed(1)}mi`);
  }
  const label = points[0]?.name || 'Nearest';
  summaryText = bits.length ? `${label}  ` + bits.join('   ') : `${label} — no services within 3 days`;

  $('route-breadcrumb').innerHTML = `<b>${escapeHtml(points[0].name || 'Start')}</b>`;
  $('route-warning').innerHTML = '';
  $('route-log').innerHTML = ''; // no completed-voyage button in services-only mode
  $('route-summary').innerHTML = '<p class="muted small">Nearest boater services from here. Tap or search a destination to plan a journey.</p>';
  if (facs.length) {
    // split into the two ways along the canal, each listing every type by distance
    const byDir = [[], []];
    facs.forEach((f, i) => byDir[f.dir === 1 ? 1 : 0].push(i));
    const facRow = (i) => { const f = facs[i]; return `<div class="fac" data-fi="${i}"><span class="fac-emoji">${emojiFor(f.type)}</span><span class="fac-name">${escapeHtml(f.type)}</span><span class="fac-mi">${arrowFor(f.bearing)} ${f.miles.toFixed(1)}mi · ${f.locks}lk · ${f.days}d</span></div>`; };
    const section = (idxs) => idxs.length ? `<h3>${arrowFor(facs[idxs[0]].bearing)} ${idxs.length} ${idxs.length === 1 ? 'service' : 'services'} this way</h3>` + idxs.map(facRow).join('') : '';
    $('route-facilities').innerHTML = section(byDir[0]) + section(byDir[1]);
  } else {
    $('route-facilities').innerHTML = '<p class="muted small">No mapped services within ~12 miles.</p>';
  }
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
  // Hidden by default — a tap on the header reveals the list, so the panel isn't
  // dominated by stoppages you may not care about for this trip.
  $('route-stoppages').innerHTML = `<button type="button" class="stp-head" id="stp-toggle" aria-expanded="false">${head}<span class="stp-show">Show</span></button><div id="stp-list" class="stp-hidden">${rows}</div>`;
  const list = $('stp-list');
  $('stp-toggle').onclick = () => {
    const hidden = list.classList.toggle('stp-hidden');
    $('stp-toggle').setAttribute('aria-expanded', String(!hidden));
    $('stp-toggle').querySelector('.stp-show').textContent = hidden ? 'Show' : 'Hide';
  };
  list.querySelectorAll('.stp').forEach((el) => { el.onclick = () => showStoppageAt(+el.dataset.i); });
}
const CRT = 'https://canalrivertrust.org.uk';
function stoppageUrl(s) { return s.path ? (s.path.startsWith('http') ? s.path : CRT + s.path) : CRT + '/notices'; }

// Fly to a stoppage and show a popup linking to the full CRT notice.
function showStoppagePopup(s, nav) {
  if (!s) return;
  setCollapsed(true);
  map.flyTo({ center: [s.lng, s.lat], zoom: 14, offset: [0, -40] });
  popup?.remove();
  const dates = s.start ? `${ddmmyyyy(s.start)}${s.end ? ' – ' + ddmmyyyy(s.end) : ' onwards'}` : '';
  const html = navRow(nav) + `<div class="poi-title">${escapeHtml(s.type)}</div>
    <div class="poi-type">${escapeHtml(s.waterway || '')}${dates ? ' · ' + dates : ''}</div>
    ${s.title ? `<div class="muted small">${escapeHtml(s.title)}</div>` : ''}
    <a class="poi-link" href="${stoppageUrl(s)}" target="_blank" rel="noopener">More info on CRT ↗</a>`;
  popup = new maplibregl.Popup({ offset: 14 }).setLngLat([s.lng, s.lat]).setHTML(html).addTo(map);
  wireNav(nav, showStoppageAt);
}

function renderBreadcrumb() {
  $('route-breadcrumb').innerHTML = points.map((p, i) => {
    const label = escapeHtml(p.name || 'Dropped pin');
    const link = p.id ? `<a href="${CANALPLAN}${p.id}" target="_blank" rel="noopener">${label}</a>` : `<span>${label}</span>`;
    return `<span class="crumb">${link}<button class="crumb-x" data-i="${i}" title="Remove this stop">✕</button></span>`;
  }).join('<span class="sep">›</span>');
  $('route-breadcrumb').querySelectorAll('.crumb-x').forEach((b) => { b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeStop(+b.dataset.i); }; });
}
// Remove any stop — start, middle or end — and re-plan (issue #13).
function removeStop(i) {
  if (i < 0 || i >= points.length) return;
  points.splice(i, 1);
  popup?.remove();
  renderMarkers();
  if (points.length >= 2) computeRoute();
  else if (points.length === 1) { lastRoute = null; setRoute(map, null); setRouteLocks(map, null); requestServices(); updateHint(); }
  else reset();
}

// --- POI popup (shared by map clicks + facility list) ---
const ICON_LABEL = {
  'cp-water': 'Water point', 'cp-elsan': 'Elsan', 'cp-pumpout': 'Pump-out', 'cp-sanstation': 'Sanitary station',
  'cp-rubbish': 'Rubbish', 'cp-recycling': 'Recycling', 'cp-fuel': 'Fuel', 'cp-boatyard': 'Boatyard',
  'cp-pub': 'Pub', 'cp-bar': 'Bar', 'cp-restaurant': 'Restaurant', 'cp-takeaway': 'Takeaway', 'cp-coffeeshop': 'Coffee shop',
  'cp-shop': 'Shop', 'cp-supermarket': 'Supermarket', 'cp-genshop': 'Store', 'cp-miscshop': 'Shop', 'cp-diy': 'DIY / hardware', 'cp-pharmacy': 'Chemist', 'cp-laundry': 'Laundry',
  'cp-toilet': 'Toilets', 'cp-mooring': 'Mooring', 'cp-wmooring': 'Visitor mooring',
};
function poiFromFeature(f) {
  const p = f.properties || {};
  let type = p.type;
  if (!type) type = p.layer === 'locks' ? 'Lock' : p.layer === 'junctions' ? 'Junction' : (p.layer === 'bigplaces' || p.layer === 'smallplaces') ? 'Place' : ICON_LABEL[p.icon] || 'Point of interest';
  return { title: p.title || type, type, id: p.cp_id };
}
function showPoiPopup(lngLat, { title, type, id }, nav) {
  popup?.remove();
  let html = navRow(nav) + `<div class="poi-title">${escapeHtml(title || '')}</div>`;
  if (type) html += `<div class="poi-type">${escapeHtml(type)}</div>`;
  // set as start (no journey yet) or preview adding it (start already set)
  html += `<a class="poi-route" href="#">${points.length === 0 ? '⚓ Set as start' : '＋ Add to route'}</a>`;
  if (id) html += `<a class="poi-link" href="${CANALPLAN}${id}" target="_blank" rel="noopener">View on CanalPlanAC ↗</a>`;
  popup = new maplibregl.Popup({ offset: 14 }).setLngLat(lngLat).setHTML(html).addTo(map);
  wireNav(nav, showFacAt);
  const link = popup.getElement()?.querySelector('.poi-route');
  if (link) link.onclick = (e) => { e.preventDefault(); popup?.remove(); choosePlace({ lng: lngLat.lng, lat: lngLat.lat, name: title || type, id: id || '' }); };
}

// --- popup prev/next: step through the route's facilities or stoppages ---
// nav = { index, total }; renders ‹ n / N › and wraps at the ends.
function navRow(nav) {
  if (!nav || nav.total < 2) return '';
  return `<div class="poi-nav"><button type="button" class="nav-btn nav-prev" aria-label="Previous">‹</button><span class="nav-count">${nav.index + 1} / ${nav.total}</span><button type="button" class="nav-btn nav-next" aria-label="Next">›</button></div>`;
}
function wireNav(nav, goTo) {
  if (!nav || nav.total < 2) return;
  const el = popup?.getElement();
  el?.querySelector('.nav-prev')?.addEventListener('click', (e) => { e.preventDefault(); goTo(nav.index - 1); });
  el?.querySelector('.nav-next')?.addEventListener('click', (e) => { e.preventDefault(); goTo(nav.index + 1); });
}
function showFacAt(i) {
  const facs = lastRoute?.facilities || [];
  if (!facs.length) return;
  const n = facs.length; i = ((i % n) + n) % n;
  const f = facs[i];
  setCollapsed(true); // get the panel out of the way so the POI is visible
  map.flyTo({ center: [f.lng, f.lat], zoom: 15, offset: [0, -40] });
  showPoiPopup({ lng: f.lng, lat: f.lat }, { title: f.title, type: f.type }, { index: i, total: n });
}
function showStoppageAt(i) {
  const list = lastStoppages || [];
  if (!list.length) return;
  const n = list.length; i = ((i % n) + n) % n;
  showStoppagePopup(list[i], { index: i, total: n });
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
  choosePlace({ lng: p.lng, lat: p.lat, name: p.name, id: p.id });
}
function hideResults() { $('search-results').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#searchbar')) hideResults(); });

// --- recent + starred searches (last 50; starred kept forever) ---
// --- saved journeys (#8): named, ordered waypoint lists in localStorage ---
const JOURNEY_KEY = 'cp.journeys';
const getJourneys = () => { try { return JSON.parse(localStorage.getItem(JOURNEY_KEY) || '[]'); } catch { return []; } };
const saveJourneys = (a) => localStorage.setItem(JOURNEY_KEY, JSON.stringify(a));

// completed journeys (the record): when, how long, the track + estimated lock times
const HISTORY_KEY = 'cp.history';
const getHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const saveHistory = (a) => localStorage.setItem(HISTORY_KEY, JSON.stringify(a));
// Estimated minutes spent at each lock: the span of track time within ~70 m of it
// (guesswork — a boat dwells near a lock while working it).
function lockDwellTimes(track, routeLocks) {
  return (routeLocks || []).map((lk) => {
    let minT = Infinity, maxT = -Infinity, n = 0;
    for (const p of track) if (metres(p.lng, p.lat, lk.lng, lk.lat) <= 70) { if (p.t < minT) minT = p.t; if (p.t > maxT) maxT = p.t; n++; }
    return { title: lk.title || 'Lock', minutes: n >= 2 ? (maxT - minT) / 60000 : null };
  });
}
function deleteHistory(id) { saveHistory(getHistory().filter((x) => x.id !== id)); renderRecents(); }
function showHistoryDetail(id) {
  const h = getHistory().find((x) => x.id === id); if (!h) return;
  panelView = 'history';
  hideResults(); searchInput.value = ''; searchInput.blur();
  if (h.track?.length) { setTrail(map, h.track.map((p) => [p.lng, p.lat])); fitRoute(map, h.track.map((p) => [p.lng, p.lat])); }
  panelTitle = 'Past journey';
  const dest = h.points[h.points.length - 1];
  const when = new Date(h.at);
  const dateStr = `${ddmmyyyy(when.toISOString())} ${when.toTimeString().slice(0, 5)}`;
  summaryText = `${h.points[0].name || 'Start'} → ${dest.name || 'End'} · ${dateStr} · ${formatDuration(h.actualHours)}`;
  $('route-breadcrumb').innerHTML = `<b>${escapeHtml(h.points[0].name || 'Start')}</b> → <b>${escapeHtml(dest.name || 'End')}</b>`;
  $('route-warning').innerHTML = ''; $('route-stoppages').innerHTML = '';
  $('route-summary').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="big">${(h.miles || 0).toFixed(1)}<small>mi</small></span><span class="lbl">distance</span></div>
      <div class="stat"><span class="big">${h.locks || 0}</span><span class="lbl">locks</span></div>
      <div class="stat"><span class="big">${formatDuration(h.actualHours)}</span><span class="lbl">took</span></div>
      <div class="stat"><span class="big">${when.toTimeString().slice(0, 5)}</span><span class="lbl">${ddmmyyyy(when.toISOString())}</span></div>
    </div>
    <button id="hist-back" class="ghost">‹ Back</button>`;
  const lt = (h.lockTimes || []).filter((l) => l.minutes != null);
  $('route-facilities').innerHTML = lt.length
    ? `<h3>Time at locks (estimated)</h3>` + lt.map((l) => `<div class="fac"><span class="fac-emoji">⚓</span><span class="fac-name">${escapeHtml(l.title)}</span><span class="fac-mi">${Math.max(1, Math.round(l.minutes))} min</span></div>`).join('')
    : '<p class="muted small">No lock timings recorded for this trip.</p>';
  $('route-log').innerHTML = '';
  $('hist-back').onclick = () => { setTrail(map, null); if (lastRoute) renderSummary(lastRoute); else { $('panel').classList.add('hidden'); document.body.classList.remove('panel-open'); } };
  showPanel(); setCollapsed(false);
}
function historyRowsHtml(hist) {
  return hist.length ? '<li class="rec-head">Past journeys</li>' + hist.map((h) => {
    const d = new Date(h.at);
    return `<li class="rec hrow" data-hid="${h.id}"><span class="r-name">${escapeHtml(h.name)}</span><span class="r-type">${ddmmyyyy(d.toISOString())} · ${formatDuration(h.actualHours)}</span><button class="jbtn hdel" title="Delete">✕</button></li>`;
  }).join('') : '';
}
function wireHistoryRows() {
  $('search-results').querySelectorAll('.hrow').forEach((li) => {
    const id = li.dataset.hid;
    li.onclick = (e) => { if (e.target.closest('.jbtn')) return; showHistoryDetail(id); };
    li.querySelector('.hdel').onclick = (e) => { e.stopPropagation(); deleteHistory(id); };
  });
}
function saveJourney() {
  if (points.length < 2) return;
  const def = `${points[0].name || 'Start'} → ${points[points.length - 1].name || 'End'}`;
  const name = prompt('Name this journey:', def);
  if (name == null) return;
  const a = getJourneys();
  a.unshift({ id: 'j' + Date.now(), name: name.trim() || def, points: points.map(({ lng, lat, name, id }) => ({ lng, lat, name, id: id || '' })), at: Date.now() });
  saveJourneys(a);
  setStatus(t('Voyage saved aboard ⚓', 'Journey saved')); setTimeout(() => setStatus(''), 2500);
}
// Load (re-open) a saved journey so it can be sailed or edited (drag/add/remove).
function loadJourney(id) {
  const j = getJourneys().find((x) => x.id === id); if (!j) return;
  hideResults(); searchInput.value = ''; searchInput.blur();
  clearPreview();
  points = j.points.map((p) => ({ ...p }));
  renderMarkers();
  if (points.length >= 2) computeRoute();
  else if (points.length === 1) { lastRoute = null; setRoute(map, null); setRouteLocks(map, null); requestServices(); updateHint(); }
  if (points.length) map.flyTo({ center: [points[0].lng, points[0].lat], zoom: 12 });
}
function renameJourney(id) {
  const a = getJourneys(); const j = a.find((x) => x.id === id); if (!j) return;
  const n = prompt('Rename journey:', j.name); if (n == null) return;
  j.name = n.trim() || j.name; saveJourneys(a); renderRecents();
}
function deleteJourney(id) { saveJourneys(getJourneys().filter((x) => x.id !== id)); renderRecents(); }
function savedRowsHtml(saved) {
  return saved.length ? '<li class="rec-head">Saved journeys</li>' + saved.map((j) =>
    `<li class="rec jrow" data-jid="${j.id}"><span class="r-name">⚓ ${escapeHtml(j.name)}</span><span class="r-type">${j.points.length} stops</span><button class="jbtn jren" title="Rename">✎</button><button class="jbtn jdel" title="Delete">✕</button></li>`).join('') : '';
}
function wireSavedRows() {
  $('search-results').querySelectorAll('.jrow').forEach((li) => {
    const id = li.dataset.jid;
    li.onclick = (e) => { if (e.target.closest('.jbtn')) return; loadJourney(id); };
    li.querySelector('.jren').onclick = (e) => { e.stopPropagation(); renameJourney(id); };
    li.querySelector('.jdel').onclick = (e) => { e.stopPropagation(); deleteJourney(id); };
  });
}

// --- backup / restore as readable text (places, journeys, settings, map key) ---
function resolvePlaceByName(name) {
  if (!gazetteer.length || !name) return null;
  const q = name.trim().toLowerCase();
  for (const g of gazetteer) if (g.name.toLowerCase() === q) return g; // exact
  let best = null;
  for (const g of gazetteer) if (g.name.toLowerCase().startsWith(q) && (!best || g.name.length < best.name.length)) best = g;
  return best || gazetteer.find((g) => g.name.toLowerCase().includes(q)) || null;
}
function exportText() {
  const places = getSearches().filter((x) => x.star);
  const journeys = getJourneys();
  const s = getSettings();
  const prefs = getLayerPrefs();
  const L = ['Canal Pal data', '', 'Saved places:'];
  places.length ? places.forEach((p) => L.push('- ' + p.name)) : L.push('- (none)');
  L.push('', 'Saved journeys:');
  journeys.length ? journeys.forEach((j) => L.push('- ' + j.name + ': ' + j.points.map((p) => p.name || 'pin').join(' -> '))) : L.push('- (none)');
  const hist = getHistory();
  L.push('', 'Journey history:');
  if (!hist.length) L.push('- (none)');
  for (const h of hist) {
    const d = new Date(h.at);
    L.push(`- ${h.points.map((p) => p.name || 'pin').join(' -> ')} | ${ddmmyyyy(d.toISOString())} ${d.toTimeString().slice(0, 5)} | ${formatDuration(h.actualHours)}`);
    for (const l of (h.lockTimes || [])) if (l.minutes != null) L.push(`    ${l.title}: ${Math.max(1, Math.round(l.minutes))} min`);
  }
  L.push('', 'Settings:', 'Cruising speed: ' + s.speedMph + ' mph', 'Minutes per lock: ' + s.lockMinutes,
    'Cruising hours per day: ' + s.hoursPerDay, 'Theme: ' + (theme === 'gongoozler' ? 'Gongoozler' : 'Pirate'));
  L.push('', 'Map key:');
  for (const c of POI_CATS) L.push(c.label + ': ' + (prefs[c.id] !== false ? 'show' : 'hide'));
  return L.join('\n');
}
function importText(text) {
  const labelToId = {}; for (const c of POI_CATS) labelToId[c.label.toLowerCase()] = c.id;
  const splitKV = (line) => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; };
  let section = null, curHist = null;
  const places = [], journeys = [], history = [];
  const settings = { ...getSettings() }; const prefs = { ...getLayerPrefs() }; let newTheme = theme;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const low = line.toLowerCase();
    if (/^canal pal data/.test(low)) continue;
    if (low === 'saved places:') { section = 'places'; continue; }
    if (low === 'saved journeys:') { section = 'journeys'; continue; }
    if (low === 'journey history:') { section = 'history'; continue; }
    if (low === 'settings:') { section = 'settings'; continue; }
    if (low === 'map key:') { section = 'mapkey'; continue; }
    if (section === 'places') { const n = line.replace(/^[-•]\s*/, ''); if (n && n !== '(none)') places.push(n); }
    else if (section === 'journeys') { let b = line.replace(/^[-•]\s*/, ''); if (!b || b === '(none)') continue; let name = b, seq = b; const ci = b.indexOf(':'); if (ci > 0) { name = b.slice(0, ci).trim(); seq = b.slice(ci + 1).trim(); } journeys.push({ name, stops: seq.split('->').map((x) => x.trim()).filter(Boolean) }); }
    else if (section === 'history') {
      if (/^[-•]/.test(line)) { // entry header: route | date time | duration
        const b = line.replace(/^[-•]\s*/, ''); if (b === '(none)') { curHist = null; continue; }
        const [route = '', when = '', dur = ''] = b.split('|').map((x) => x.trim());
        curHist = { stops: route.split('->').map((x) => x.trim()).filter(Boolean), when, dur, locks: [] };
        history.push(curHist);
      } else if (curHist) { const [k, v] = splitKV(line); if (k) curHist.locks.push({ title: k, minutes: parseFloat(v) || null }); }
    }
    else if (section === 'settings') { const [k, v] = splitKV(line); if (/speed/i.test(k)) settings.speedMph = parseFloat(v) || settings.speedMph; else if (/lock/i.test(k)) settings.lockMinutes = parseFloat(v) || settings.lockMinutes; else if (/hours/i.test(k)) settings.hoursPerDay = parseFloat(v) || settings.hoursPerDay; else if (/theme/i.test(k)) newTheme = /gong/i.test(v) ? 'gongoozler' : 'pirate'; }
    else if (section === 'mapkey') { const [k, v] = splitKV(line); const id = labelToId[k.toLowerCase()]; if (id) prefs[id] = !/hide/i.test(v); }
  }
  let addedP = 0, addedJ = 0, addedH = 0, missed = 0;
  if (places.length) {
    const cur = getSearches();
    for (const nm of places) { const g = resolvePlaceByName(nm); if (!g) { missed++; continue; } if (!cur.some((x) => x.id === g.id && x.name === g.name)) { cur.unshift({ name: g.name, lng: g.lng, lat: g.lat, id: g.id || '', layer: g.layer || '', region: g.region || '', star: true, at: Date.now() }); addedP++; } }
    saveSearches(cur);
  }
  if (journeys.length) {
    const cur = getJourneys();
    journeys.forEach((j, idx) => {
      const pts = j.stops.map(resolvePlaceByName).map((g) => { if (!g) { missed++; return null; } return { lng: g.lng, lat: g.lat, name: g.name, id: g.id || '' }; }).filter(Boolean);
      if (pts.length >= 2) { cur.unshift({ id: 'j' + Date.now() + '-' + idx, name: j.name, points: pts, at: Date.now() }); addedJ++; }
    });
    saveJourneys(cur);
  }
  if (history.length) {
    const cur = getHistory();
    history.forEach((h, idx) => {
      const pts = h.stops.map(resolvePlaceByName).map((g) => g ? { lng: g.lng, lat: g.lat, name: g.name, id: g.id || '' } : null).filter(Boolean);
      if (pts.length < 2) { missed++; return; }
      let at = Date.now();
      const m = h.when.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/);
      if (m) at = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
      const hM = h.dur.match(/(\d+)\s*hr/), mM = h.dur.match(/(\d+)\s*min/);
      const actualHours = (hM ? +hM[1] : 0) + (mM ? +mM[1] : 0) / 60;
      cur.unshift({ id: 'h' + Date.now() + '-' + idx, name: `${pts[0].name} → ${pts[pts.length - 1].name}`, points: pts, at, arrived: true, actualHours, miles: 0, locks: h.locks.length, track: [], lockTimes: h.locks });
      addedH++;
    });
    saveHistory(cur);
  }
  saveSettings({ speedMph: settings.speedMph, lockMinutes: settings.lockMinutes, hoursPerDay: settings.hoursPerDay });
  theme = newTheme; localStorage.setItem('cp.theme', theme); applyTheme();
  localStorage.setItem(LAYER_KEY, JSON.stringify(prefs)); applyLayerPrefs();
  if (lastRoute) renderSummary(lastRoute);
  return { addedP, addedJ, addedH, missed };
}

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
// First-run: when there are no recents yet, offer well-known boating landmarks.
// Each is resolved against the loaded gazetteer (by id where the colloquial name
// differs), and any that don't resolve are silently dropped.
const SEED_PLACES = [
  { q: 'Hawkesbury Junction', id: 'c9tv' },
  { q: 'Braunston Turn' },
  { q: 'Little Venice' },
  { q: 'Foxton Bottom Staircase' },
  { q: 'Caen Hill Flight' },
  { q: 'Llangollen' },
  { q: 'Gas Street Basin' },
  { q: 'Bancroft Basin' },
  { q: 'Anderton Boat Lift' },
  { q: 'Bingley Five Rise' },
  { q: 'Standedge Tunnel' },
  { q: 'Tardebigge' },
];
function resolveSeed(s) {
  if (s.id) { const g = gazetteer.find((x) => x.id === s.id); if (g) return g; }
  const q = s.q.toLowerCase();
  let best = null; // prefer a name that starts with the query, shortest wins
  for (const g of gazetteer) { if (g.name.toLowerCase().startsWith(q) && (!best || g.name.length < best.name.length)) best = g; }
  return best || gazetteer.find((g) => g.name.toLowerCase().includes(q)) || null;
}
// First-run / empty-focus dropdown: saved journeys, then recents (or, with no
// recents, popular landmarks).
function renderRecents() {
  const ul = $('search-results');
  const saved = getJourneys(), hist = getHistory(), a = getSearches();
  if (!saved.length && !hist.length && !a.length) { renderSeeds(); return; }
  const sorted = [...a].sort((x, y) => (y.star ? 1 : 0) - (x.star ? 1 : 0)); // starred first
  ul.innerHTML = savedRowsHtml(saved) + historyRowsHtml(hist)
    + (a.length ? '<li class="rec-head">Recent &amp; saved</li>' + sorted.map(() => '<li class="rec srow"></li>').join('') : '');
  wireSavedRows(); wireHistoryRows();
  [...ul.querySelectorAll('.srow')].forEach((li, i) => {
    const p = sorted[i];
    li.innerHTML = `${resultRow(p)}<button class="star ${p.star ? 'on' : ''}" title="${p.star ? 'Saved' : 'Save forever'}">${p.star ? '★' : '☆'}</button>`;
    li.onclick = (e) => { if (e.target.closest('.star')) return; selectResult(p); };
    li.querySelector('.star').onclick = (e) => { e.stopPropagation(); toggleStar(p); renderRecents(); };
  });
  ul.classList.remove('hidden');
}
function renderSeeds() {
  const ul = $('search-results');
  const saved = getJourneys(), hist = getHistory();
  const seen = new Set();
  const seeds = gazetteer.length ? SEED_PLACES.map(resolveSeed).filter((g) => g && !seen.has(g.id) && seen.add(g.id)) : [];
  if (!saved.length && !hist.length && !seeds.length) { hideResults(); return; }
  ul.innerHTML = savedRowsHtml(saved) + historyRowsHtml(hist)
    + (seeds.length ? '<li class="rec-head">Popular places</li>' + seeds.map(() => '<li class="rec drow"></li>').join('') : '');
  wireSavedRows(); wireHistoryRows();
  [...ul.querySelectorAll('.drow')].forEach((li, i) => { const p = seeds[i]; li.innerHTML = resultRow(p); li.onclick = () => selectResult(p); });
  ul.classList.remove('hidden');
}

// --- hints + panel ---
function setStatus(t) { $('status').innerHTML = t; }
let hintTimer = null;
function setHint(t) {
  const h = $('hint');
  h.innerHTML = t;
  h.classList.toggle('hidden', !t);
  h.classList.remove('fading');
  clearTimeout(hintTimer);
  if (t) hintTimer = setTimeout(() => h.classList.add('fading'), 6000); // fade away after a few seconds
}
function updateHint() {
  if (points.length === 0) promptForStart();
  else if (points.length === 1) setHint('Tap or search to set your <b>destination</b>.');
  else setHint('');
}
function saveLastStart(p) {
  try { localStorage.setItem('cp.laststart', JSON.stringify({ lng: p.lng, lat: p.lat, name: p.name || null, id: p.id || '' })); } catch { /* ignore */ }
}
function getLastStart() {
  try { return JSON.parse(localStorage.getItem('cp.laststart') || 'null'); } catch { return null; }
}
function promptForStart() {
  const last = getLastStart();
  const opts = [];
  if (userLocation) opts.push('<a href="#" id="use-loc">use current location</a>');
  if (last && last.name) opts.push(`<a href="#" id="use-last">start at ${escapeHtml(last.name)}</a>`);
  setHint('Tap or search to set your <b>start</b>' + (opts.length ? ' — ' + opts.join(' or ') : '') + '.');
  if (userLocation) $('use-loc').onclick = (ev) => { ev.preventDefault(); if (ready) addPoint({ ...userLocation, name: 'Current location', id: '' }); };
  if (last && last.name && $('use-last')) $('use-last').onclick = (ev) => { ev.preventDefault(); if (ready) addPoint({ lng: last.lng, lat: last.lat, name: last.name, id: last.id || '' }); };
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
updateUndoIcon(); // set its icon/visibility for the empty initial state
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
// Safari reports code 1 ("User denied") for an OS-level Location Services block
// too, even when the site is allowed — so say what's actually likely wrong.
function geoErrText(e) {
  if (e?.code === 1) return t('Location’s blocked by yer device, not the site — switch on Location Services for your browser ⚓', 'Location is off in your device settings (not the site) — turn on Location Services for your browser.');
  if (e?.code === 3) return t('Couldn’t get a fix — try again under open sky.', 'Location timed out — try again.');
  return 'Location unavailable' + (e?.message ? ': ' + e.message : '');
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
    (err) => { setStatus(geoErrText(err)); setTimeout(() => setStatus(''), 7000); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}
$('search-locate').onclick = locateMe; // find-me lives on the search bar; clear is back on the undo button

// --- compass: rotate the map to face the way the device points (toggle) ---
let compassOn = false, orientEvt = null, smoothBearing = 0;
function headingFromEvent(e) {
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) return e.webkitCompassHeading; // iOS, true north
  if (typeof e.alpha === 'number') {
    const so = (screen.orientation && screen.orientation.angle) || 0; // allow for landscape
    return (360 - e.alpha + so + 360) % 360;
  }
  return null;
}
function onOrient(e) {
  const h = headingFromEvent(e); if (h == null) return;
  const diff = ((h - smoothBearing + 540) % 360) - 180; // shortest way round
  smoothBearing = (smoothBearing + diff * 0.25 + 360) % 360; // low-pass the jitter
  map.setBearing(smoothBearing);
}
function setCompass(on) {
  compassOn = on;
  $('trk-compass')?.classList.toggle('on', on); // the toggle lives in the tracking bar
  if (on) {
    const begin = () => { orientEvt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation'; smoothBearing = map.getBearing(); window.addEventListener(orientEvt, onOrient, true); setStatus(t('Steady as she goes — facing yer heading ⚓', 'Map faces your heading')); setTimeout(() => setStatus(''), 2500); };
    const Dev = window.DeviceOrientationEvent;
    if (Dev && typeof Dev.requestPermission === 'function') { // iOS needs a gesture-time prompt
      Dev.requestPermission().then((r) => { if (r === 'granted') begin(); else { setCompass(false); setStatus('Compass permission denied'); setTimeout(() => setStatus(''), 3000); } }).catch(() => setCompass(false));
    } else begin();
  } else {
    if (orientEvt) { window.removeEventListener(orientEvt, onOrient, true); orientEvt = null; }
    map.easeTo({ bearing: 0, duration: 400 }); // back to north-up
  }
}

// --- settings (tabbed: Settings + Map key) ---
document.querySelectorAll('#settings .tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('#settings .tab').forEach((b) => b.classList.toggle('on', b === tab));
    document.querySelectorAll('#settings .tabpanel').forEach((pan) => pan.classList.toggle('hidden', pan.dataset.panel !== tab.dataset.tab));
  };
});
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

// backup / restore (readable text)
$('data-export').onclick = () => { $('data-text').value = exportText(); $('data-text').select(); $('data-note').textContent = 'Select all and copy this somewhere safe.'; };
$('data-import').onclick = () => {
  const txt = $('data-text').value.trim();
  if (!txt) { $('data-note').textContent = 'Paste your exported text first.'; return; }
  try {
    const r = importText(txt);
    $('data-note').textContent = `Restored ${r.addedP} place(s), ${r.addedJ} journey(s), ${r.addedH} past trip(s), settings & map key${r.missed ? ` · ${r.missed} name(s) not found on the network` : ''}.`;
  } catch (e) { $('data-note').textContent = "Couldn't read that text — check the section headings."; console.error(e); }
};

function clamp(n, lo, hi, dflt) { return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

promptForStart();
