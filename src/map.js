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
export const POI_LAYERS = ['pl-fac', 'pl-lock', 'pl-jct', 'pl-label'];

const CARTO = (style) => ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`);
const BASES = {
  colour: { name: 'Coloured chart', source: { type: 'raster', tiles: CARTO('rastertiles/voyager'), tileSize: 256, attribution: '© OpenStreetMap, © CARTO' } },
  mono: { name: 'Mono chart', source: { type: 'raster', tiles: CARTO('light_all'), tileSize: 256, attribution: '© OpenStreetMap, © CARTO' } },
};

// Anything that isn't an "*_excluded" type is navigable → solid blue line.
const NAVIGABLE = ['==', ['index-of', '_excluded', ['get', 'cp_type']], -1];

function empty() { return { type: 'FeatureCollection', features: [] }; }

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
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#aadaff' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': 0.95 } },

        { id: 'ww-unnav', type: 'line', source: 'canalplan', 'source-layer': 'canalplan_waterways', filter: ['!', NAVIGABLE],
          paint: { 'line-color': '#7a6a55', 'line-dasharray': [2, 2], 'line-width': 1.3 } },
        { id: 'ww', type: 'line', source: 'canalplan', 'source-layer': 'canalplan_waterways', filter: NAVIGABLE,
          paint: { 'line-color': '#1565a8', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 3, 16, 6] } },

        { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3a2410', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 16, 13] } },
        { id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#e8590c', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 16, 8] } },

        { id: 'pl-fac', type: 'circle', source: 'canalplan', 'source-layer': 'canalplan_places', filter: ['==', ['get', 'layer'], 'facilities'], minzoom: 12,
          paint: { 'circle-radius': 4, 'circle-color': '#1f6f7d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } },
        { id: 'pl-lock', type: 'circle', source: 'canalplan', 'source-layer': 'canalplan_places', filter: ['==', ['get', 'layer'], 'locks'], minzoom: 10,
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 5], 'circle-color': '#9e2b1c', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } },
        { id: 'pl-jct', type: 'circle', source: 'canalplan', 'source-layer': 'canalplan_places', filter: ['==', ['get', 'layer'], 'junctions'], minzoom: 9,
          paint: { 'circle-radius': 4, 'circle-color': '#cf9f3a', 'circle-stroke-color': '#3a2410', 'circle-stroke-width': 1 } },
        { id: 'pl-label', type: 'symbol', source: 'canalplan', 'source-layer': 'canalplan_places', filter: ['in', ['get', 'layer'], ['literal', ['bigplaces', 'junctions']]], minzoom: 11,
          layout: { 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'], 'text-optional': true },
          paint: { 'text-color': '#0b2a3a', 'text-halo-color': '#f3e6c4', 'text-halo-width': 1.4 } },

        // facilities on the chosen route (highlighted)
        { id: 'routefac', type: 'circle', source: 'routefac',
          paint: { 'circle-radius': 6, 'circle-color': '#1f6f7d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },

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

  map.on('load', () => addLockArrow(map));
  map.on('styleimagemissing', (e) => { if (e.id === 'lock-arrow') addLockArrow(map); });
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
export function setRouteLocks(map, locks) {
  map.getSource('routelocks').setData({ type: 'FeatureCollection', features: (locks || []).map((l) => ({ type: 'Feature', properties: { rot: (l.rot || 0) + (l.flip ? 180 : 0), title: l.title }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] } })) });
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
