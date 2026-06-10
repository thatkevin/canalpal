import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';

export { maplibregl };

// Shared so main.js can register a pre-downloaded in-memory archive (GitHub
// Pages ignores Range requests, so we download the .pmtiles once ourselves).
export const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const BASE = import.meta.env.BASE_URL || './';

// POI layers that respond to clicks (show a popup instead of adding a waypoint).
export const POI_LAYERS = ['cat-moorings', 'cat-water', 'cat-fuel', 'cat-sanitary', 'cat-rubbish', 'cat-food', 'pl-label'];

// Boater-relevant facility icons (excludes the 80k bus stops, banks, etc. that
// otherwise litter the map).
const USEFUL_FAC = ['cp-water', 'cp-elsan', 'cp-pumpout', 'cp-sanstation', 'cp-rubbish', 'cp-recycling',
  'cp-fuel', 'cp-boatyard', 'cp-pub', 'cp-bar', 'cp-restaurant', 'cp-takeaway', 'cp-coffeeshop',
  'cp-shop', 'cp-supermarket', 'cp-genshop', 'cp-miscshop', 'cp-diy', 'cp-pharmacy', 'cp-laundry',
  'cp-toilet', 'cp-mooring', 'cp-wmooring'];

const CARTO = (style) => ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`);
const BASES = {
  colour: { name: 'Coloured chart', source: { type: 'raster', tiles: CARTO('rastertiles/voyager'), tileSize: 256, attribution: '© OpenStreetMap, © CARTO' } },
  mono: { name: 'Mono chart', source: { type: 'raster', tiles: CARTO('light_all'), tileSize: 256, attribution: '© OpenStreetMap, © CARTO' } },
};

// Anything that isn't an "*_excluded" type is navigable → solid blue line.
const NAVIGABLE = ['==', ['index-of', '_excluded', ['get', 'cp_type']], -1];

function empty() { return { type: 'FeatureCollection', features: [] }; }

// Boater POI categories: each is one toggleable map layer drawn as an emoji in a
// coloured disc. `icons` are the CanalPlanAC `icon` values that fall in the group;
// `layer` (junctions) matches on the place layer instead. Locks are handled
// separately (always on, monochrome, clustered) — see lockLayers below.
export const POI_CATS = [
  { id: 'moorings',  label: 'Moorings',            emoji: '⚓',  bg: '#1f6f7d', icons: ['cp-mooring', 'cp-wmooring'] },
  { id: 'water',     label: 'Water points',        emoji: '🚰', bg: '#1565a8', icons: ['cp-water'] },
  { id: 'fuel',      label: 'Fuel & boatyards',    emoji: '⛽', bg: '#8a5a2b', icons: ['cp-fuel', 'cp-boatyard'] },
  { id: 'sanitary',  label: 'Sanitary',            emoji: '🚽', bg: '#5a6b2b', icons: ['cp-elsan', 'cp-pumpout', 'cp-sanstation', 'cp-toilet'] },
  { id: 'rubbish',   label: 'Rubbish & recycling', emoji: '🗑️', bg: '#555555', icons: ['cp-rubbish', 'cp-recycling'] },
  { id: 'food',      label: 'Pubs & shops',        emoji: '🍺', bg: '#a8431a', icons: ['cp-pub', 'cp-bar', 'cp-restaurant', 'cp-takeaway', 'cp-coffeeshop', 'cp-shop', 'cp-supermarket', 'cp-genshop', 'cp-miscshop', 'cp-diy', 'cp-pharmacy', 'cp-laundry'] },
];

const catLayers = POI_CATS.map((c) => ({
  id: 'cat-' + c.id, type: 'symbol', source: 'canalplan', 'source-layer': 'canalplan_places',
  filter: ['all', ['==', ['get', 'layer'], 'facilities'], ['in', ['get', 'icon'], ['literal', c.icons]]],
  minzoom: 12,
  layout: { 'icon-image': 'ic-' + c.id, 'icon-allow-overlap': true,
    'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 0.75] },
}));

// Locks: always on, monochrome (black & white, as in life), prominent. Flights
// (consecutive locks on one stretch) are pre-grouped in the routing graph and
// drawn as a single downstream arrow with the lock count beside it — e.g. ❯(7).
// Flights break into individual locks across this zoom band: the flight marker
// fades out and the individual locks fade in, so the split is a smooth cross-fade
// rather than a pop. Lowered so flights separate sooner.
const SPLIT_LO = 12.5, SPLIT_HI = 13.4;
const lockLayers = [
  // zoomed out: one marker per flight — a bolder triple chevron for a stretch of
  // locks (count > 1) or the plain double chevron for a single lock, with the
  // lock count beside it: ❯(7).
  { id: 'lock-flight', type: 'symbol', source: 'locks', minzoom: 8, maxzoom: SPLIT_HI,
    layout: {
      'icon-image': ['case', ['>', ['get', 'count'], 1], 'ic-lock-flight', 'ic-lock'], 'icon-allow-overlap': true,
      'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
      // base size by zoom, each stop scaled up ~12% per 5 locks. NB: ['zoom']
      // must stay the top-level interpolate input — scale the OUTPUTS by count,
      // never nest the zoom interpolate inside another expression.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        9, ['*', 0.6, ['+', 1, ['*', 0.12, ['floor', ['/', ['-', ['get', 'count'], 1], 5]]]]],
        13, ['*', 0.95, ['+', 1, ['*', 0.12, ['floor', ['/', ['-', ['get', 'count'], 1], 5]]]]]],
      'text-field': ['case', ['>', ['get', 'count'], 1], ['concat', '(', ['to-string', ['get', 'count']], ')'], ''],
      'text-font': ['Open Sans Regular'], 'text-size': 13, 'text-offset': [1.1, 0], 'text-anchor': 'left',
      'text-allow-overlap': true, 'text-optional': true,
    },
    paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.6,
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], SPLIT_LO, 1, SPLIT_HI, 0],
      'text-opacity': ['interpolate', ['linear'], ['zoom'], SPLIT_LO, 1, SPLIT_HI, 0] } },
  // zoomed in: every individual lock as its own downstream arrow, fading in as the
  // flight marker fades out
  { id: 'lock-point', type: 'symbol', source: 'locks-all', minzoom: SPLIT_LO,
    layout: { 'icon-image': 'ic-lock', 'icon-allow-overlap': true,
      'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 16, 1.15] },
    paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], SPLIT_LO, 0, SPLIT_HI, 1] } },
];

// Draw an emoji centred in a coloured disc and register it as a map image.
function emojiImage(map, key, emoji, bg) {
  if (map.hasImage(key)) return;
  const s = 44; const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
  x.fillStyle = bg; x.fill();
  x.lineWidth = 2; x.strokeStyle = '#fff'; x.stroke();
  x.font = `${Math.round(s * 0.5)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(emoji, s / 2, s / 2 + s * 0.04);
  map.addImage(key, { width: s, height: s, data: x.getImageData(0, 0, s, s).data }, { pixelRatio: 2 });
}

// A black-and-white double chevron pointing "down" (south); the lock-point layer
// rotates it per-lock so the point heads downstream. White halo keeps it legible
// over the blue canal line, monochrome like a real lock.
function lockImage(map) {
  if (map.hasImage('ic-lock')) return;
  const s = 44; const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.lineCap = 'round'; x.lineJoin = 'round';
  const chevrons = () => {
    x.beginPath(); x.moveTo(s * 0.28, s * 0.26); x.lineTo(s * 0.50, s * 0.50); x.lineTo(s * 0.72, s * 0.26);
    x.moveTo(s * 0.28, s * 0.48); x.lineTo(s * 0.50, s * 0.72); x.lineTo(s * 0.72, s * 0.48);
  };
  x.strokeStyle = '#fff'; x.lineWidth = 9; chevrons(); x.stroke();   // halo
  x.strokeStyle = '#111'; x.lineWidth = 5; chevrons(); x.stroke();   // arrow
  map.addImage('ic-lock', { width: s, height: s, data: x.getImageData(0, 0, s, s).data }, { pixelRatio: 2 });
}

// A bolder TRIPLE chevron for a lock flight (a stretch of several locks), so a
// flight reads differently from a single lock at a glance.
function lockFlightImage(map) {
  if (map.hasImage('ic-lock-flight')) return;
  const s = 44; const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.lineCap = 'round'; x.lineJoin = 'round';
  const chevrons = () => {
    x.beginPath();
    for (const y of [0.13, 0.35, 0.57]) { x.moveTo(s * 0.24, s * y); x.lineTo(s * 0.50, s * (y + 0.22)); x.lineTo(s * 0.76, s * y); }
  };
  x.strokeStyle = '#fff'; x.lineWidth = 11; chevrons(); x.stroke();   // halo
  x.strokeStyle = '#111'; x.lineWidth = 7; chevrons(); x.stroke();    // bolder arrow
  map.addImage('ic-lock-flight', { width: s, height: s, data: x.getImageData(0, 0, s, s).data }, { pixelRatio: 2 });
}

function addPoiIcons(map) {
  for (const c of POI_CATS) emojiImage(map, 'ic-' + c.id, c.emoji, c.bg);
  lockImage(map); lockFlightImage(map);
}

export function createMap(container) {
  const map = new maplibregl.Map({
    container, center: [-2.0, 52.48], zoom: 7, maxZoom: 16, attributionControl: false,
    style: {
      version: 8,
      glyphs: BASE + 'glyphs/{fontstack}/{range}.pbf',
      sources: {
        base: BASES.colour.source,
        canalplan: { type: 'vector', url: 'pmtiles://canalplan', attribution: '<a href="https://canalplan.org.uk">© CanalPlanAC</a>' },
        route: { type: 'geojson', data: empty() },
        routefac: { type: 'geojson', data: empty() },
        routelocks: { type: 'geojson', data: empty() },
        stoppages: { type: 'geojson', data: empty() },
        locks: { type: 'geojson', data: empty() },       // flight markers (zoomed out)
        'locks-all': { type: 'geojson', data: empty() },  // every individual lock (zoomed in)
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#aadaff' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': 0.95 } },

        { id: 'ww-unnav', type: 'line', source: 'canalplan', 'source-layer': 'canalplan_waterways', filter: ['!', NAVIGABLE],
          paint: { 'line-color': '#7a6a55', 'line-dasharray': [2, 2], 'line-width': 1.3 } },
        { id: 'ww', type: 'line', source: 'canalplan', 'source-layer': 'canalplan_waterways', filter: NAVIGABLE,
          paint: { 'line-color': '#1565a8', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 3, 16, 6] } },

        // hovered-waterway highlight (filter set on mousemove by cp_id)
        { id: 'ww-hl', type: 'line', source: 'canalplan', 'source-layer': 'canalplan_waterways',
          filter: ['==', ['get', 'cp_id'], ' '],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffcc00', 'line-blur': 0.6, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 12, 7, 16, 12] } },

        { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3a2410', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 16, 13] } },
        { id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#e8590c', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 16, 8] } },

        // boater POI categories (emoji-in-disc) — toggled by the legend
        ...catLayers,
        // locks: always on, monochrome, clustered with a count
        ...lockLayers,
        { id: 'pl-label', type: 'symbol', source: 'canalplan', 'source-layer': 'canalplan_places', filter: ['in', ['get', 'layer'], ['literal', ['bigplaces', 'junctions']]], minzoom: 11,
          layout: { 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'], 'text-optional': true },
          paint: { 'text-color': '#0b2a3a', 'text-halo-color': '#f3e6c4', 'text-halo-width': 1.4 } },

        // facilities on the chosen route (highlighted)
        { id: 'routefac', type: 'circle', source: 'routefac',
          paint: { 'circle-radius': 6, 'circle-color': '#1f6f7d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },

        // CRT stoppages affecting the route (red = closure, amber = restriction)
        { id: 'stoppages', type: 'circle', source: 'stoppages',
          paint: {
            'circle-radius': ['case', ['get', 'closure'], 9, 7],
            'circle-color': ['case', ['get', 'closure'], '#c0202a', '#e8920c'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
          } },
        { id: 'stoppages-x', type: 'symbol', source: 'stoppages', filter: ['get', 'closure'],
          layout: { 'text-field': '!', 'text-size': 13, 'text-font': ['Open Sans Regular'], 'text-allow-overlap': true },
          paint: { 'text-color': '#fff' } },

        // lock direction arrows along the route
        { id: 'routelocks', type: 'symbol', source: 'routelocks',
          layout: { 'icon-image': 'lock-arrow', 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1] } },
      ],
    },
  });

  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

  const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserLocation: true, showAccuracyCircle: true });
  map.addControl(geolocate, 'bottom-left');
  map._geolocate = geolocate;

  map.on('load', () => { addLockArrow(map); addPoiIcons(map); });
  map.on('styleimagemissing', (e) => {
    if (e.id === 'lock-arrow') addLockArrow(map);
    else if (e.id === 'ic-lock') lockImage(map);
    else if (e.id === 'ic-lock-flight') lockFlightImage(map);
    else if (e.id?.startsWith('ic-')) { const c = POI_CATS.find((p) => 'ic-' + p.id === e.id); if (c) emojiImage(map, e.id, c.emoji, c.bg); }
  });
  return map;
}

// A small downhill chevron, drawn to a canvas and registered as a map image so we
// can rotate it per-lock via icon-rotate (lock cp_rotate ≈ gate orientation).
function addLockArrow(map) {
  if (map.hasImage('lock-arrow')) return;
  const s = 28; const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.strokeStyle = '#9e2b1c'; x.fillStyle = '#9e2b1c'; x.lineWidth = 3; x.lineCap = 'round'; x.lineJoin = 'round';
  // chevron pointing "down" (south); icon-rotate then orients it downhill
  x.beginPath(); x.moveTo(7, 9); x.lineTo(14, 18); x.lineTo(21, 9); x.stroke();
  x.beginPath(); x.moveTo(7, 15); x.lineTo(14, 24); x.lineTo(21, 15); x.stroke();
  const img = x.getImageData(0, 0, s, s);
  map.addImage('lock-arrow', { width: s, height: s, data: img.data });
}

export function setRoute(map, coords) {
  map.getSource('route').setData(coords ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } : empty());
}
export function setRouteFacilities(map, facs) {
  map.getSource('routefac').setData({ type: 'FeatureCollection', features: (facs || []).map((f) => ({ type: 'Feature', properties: { type: f.type, title: f.title }, geometry: { type: 'Point', coordinates: [f.lng, f.lat] } })) });
}
export function setStoppages(map, list) {
  map.getSource('stoppages').setData({
    type: 'FeatureCollection',
    features: (list || []).map((s) => ({ type: 'Feature', properties: { id: s.id, closure: !!s.closure, title: s.title, type: s.type }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })),
  });
}
export function setRouteLocks(map, locks) {
  map.getSource('routelocks').setData({ type: 'FeatureCollection', features: (locks || []).map((l) => ({ type: 'Feature', properties: { rot: (l.rot || 0) + (l.flip ? 180 : 0), title: l.title }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] } })) });
}
// All locks on the network (clustered) — shown throughout, always on.
export function setLocks(map, groups) {
  map.getSource('locks')?.setData({ type: 'FeatureCollection', features: (groups || []).map((g) => ({ type: 'Feature', properties: { title: g.title, chambers: g.chambers || 1, count: g.count || 1, rot: g.rot || 0 }, geometry: { type: 'Point', coordinates: [g.lng, g.lat] } })) });
}
// Every individual lock (shown when zoomed in past the flight grouping).
export function setLocksAll(map, locks) {
  map.getSource('locks-all')?.setData({ type: 'FeatureCollection', features: (locks || []).map((l) => ({ type: 'Feature', properties: { title: l.title, chambers: l.chambers || 1, count: 1, rot: (l.rot || 0) + (l.flip ? 180 : 0) }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] } })) });
}
export function setLayerVisible(map, id, on) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

let baseKey = 'colour';
export function cycleBasemap(map) {
  const keys = Object.keys(BASES);
  baseKey = keys[(keys.indexOf(baseKey) + 1) % keys.length];
  const b = BASES[baseKey];
  if (map.getLayer('base')) map.removeLayer('base');
  if (map.getSource('base')) map.removeSource('base');
  map.addSource('base', b.source);
  map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': 0.95 } }, 'ww-unnav');
  return b.name;
}

export function fitRoute(map, coords) {
  const b = new maplibregl.LngLatBounds();
  for (const c of coords) b.extend(c);
  map.fitBounds(b, { padding: { top: 110, bottom: 240, left: 40, right: 60 }, maxZoom: 14 });
}
