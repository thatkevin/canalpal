# Canal Pal

**Live at [canalpal.co.uk](https://canalpal.co.uk).**

An offline-capable canal journey planner. Tap two points on the map and it works
out distance (miles & furlongs), number of locks, estimated cruising time and the
facilities you'll pass. Built on CanalPlanAC's mapping data and OpenStreetMap.

Plan multi-stop journeys (stops insert in geographic order), save and re-open
them, then **start a journey** to track your position live — with a breadcrumb
trail, updating ETA, speed and a "north-up / heading-up" compass toggle. Finished
trips go into a **history** with per-lock dwell times, and everything (places,
journeys, history, settings) exports/imports as readable text.

## How it works

- **Map** — MapLibre GL rendering CanalPlanAC's vector tiles (`canalplan.pmtiles`,
  44 MB, all of Great Britain) as a transparent overlay over an OSM raster base.
  Glyphs are bundled locally so labels work offline.
- **Routing** — the 487 waterway centrelines are noded into a welded planar graph
  (~84k nodes) in `src/graph.js`. Tapping two points snaps each to the nearest
  edge and runs Dijkstra. Distance comes from the geometry (haversine).
- **Locks** — lock points are snapped to edges; a journey's lock count sums the
  chamber counts of the locks on the traversed edges. The `cp-lockN` icon encodes
  staircase size (e.g. Bingley Five Rise = 5), so flights/staircases count correctly.
- **Facilities** — amenity points within ~70 m of the route, ordered by distance along it.
- **Time** — `miles / speed + locks × minutes-per-lock`, with a learned correction
  factor fitted from logged trips (expected vs actual). Speed/lock-time/hours-per-day
  are adjustable in Settings.

Validated against CanalPlanAC's published figures: Hanbury Jn → King's Norton Jn
= 15.1 mi / **42 locks** (matches), Tardebigge flight = 29 locks (published 30).

## Offline

Installable PWA. A service worker cache-firsts the pmtiles, routing data and
glyphs, and caches OSM raster tiles as you pan ("nearly offline" — any area
viewed once works offline afterwards). For full offline streets everywhere, a
Protomaps GB basemap can be bundled (roadmap); the Basemap button is the swap point.

## Data & licence

Mapping data © [CanalPlanAC](https://canalplan.org.uk), used for non-commercial
purposes with attribution (shown on the map). Base map © OpenStreetMap contributors.

Source files (download into `data/`):
- `canalplan.mbtiles` — https://canalplan.uk/mapping/tiles/canalplan_great-britain.mbtiles
- `waterways.geojson` — https://canalplan.uk/mapping/geodata/full/ukuk/canalplan_waterways.geojson
- `places.geojson` — https://canalplan.uk/mapping/geodata/full/ukuk/canalplan_places.geojson

## Setup

```bash
npm install
go install github.com/protomaps/go-pmtiles@latest   # or put the binary in ./.bin/go-pmtiles
npm run preprocess        # places.geojson -> locks.json + facilities.json, clean waterways
npm run tiles             # canalplan.mbtiles -> public/data/canalplan.pmtiles
node scripts/download-glyphs.mjs
npm run dev               # http://localhost:5173
npm run build             # production PWA into docs/ (GitHub Pages serves it at canalpal.co.uk)
```

Deployed via GitHub Pages from `docs/` on `main`; the custom domain is set by
`public/CNAME`. `npm run build` regenerates `docs/`.

## Validate / test

```bash
node scripts/validate-graph.mjs   # connectivity + known-route distance/lock checks
node scripts/smoke.mjs            # headless browser end-to-end (needs dev server running)
```

## Roadmap

Shipped since the first cut: multi-stop journeys with ordered insertion, saved
journeys, live GPS tracking + journey history (per-lock dwell times) feeding the
calibration, named-place search, curvature-aware times, and a heading-up compass.

Still on the list:
- Bundle a Protomaps GB basemap for true offline streets; import-your-own
  `.pmtiles`/`.mbtiles` basemap via file picker.
- Push notifications when a stoppage starts affecting a saved route.
- Wrap in Capacitor for iOS/Android app-store builds.
- Per-waterway-type speeds; tunnels & moveable bridges in the time model.
