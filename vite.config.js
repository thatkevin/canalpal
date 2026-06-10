import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => ({
  // served from the root of the custom domain canalpal.co.uk (see public/CNAME)
  base: '/',
  build: { target: 'es2022', outDir: 'docs' },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Canal Pal',
        short_name: 'Canal Pal',
        description: 'Offline canal journey planner',
        theme_color: '#0d3b66',
        background_color: '#0d3b66',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The big offline assets: pmtiles basemap/overlay + the routing data.
        // Cache-first so once fetched they work with no network.
        globPatterns: ['**/*.{js,css,html,json,geojson}'],
        // The CRT data files are refreshed daily by a GitHub Action that commits
        // the JSON without rebuilding the app — so they must NOT be precached by
        // content-hash (installed users would be stuck on the build-time copy).
        // Served NetworkFirst below instead, so updates land immediately online
        // and still fall back to cache offline.
        globIgnores: ['**/data/stoppages.json', '**/data/services.json'],
        maximumFileSizeToCacheInBytes: 80 * 1024 * 1024,
        runtimeCaching: [
          {
            // Daily-refreshed CRT data: prefer fresh, fall back to cache offline.
            urlPattern: ({ url }) => /\/data\/(stoppages|services)\.json$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'crt-data',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // NB: the .pmtiles archive is downloaded + cached by the app itself
            // (Cache Storage 'cp-archive'), because GitHub Pages ignores Range
            // requests — so it's deliberately not handled here.
            // Raster basemap tiles (CARTO coloured/mono): cache visited tiles so
            // areas you've panned over keep working offline ("nearly offline").
            urlPattern: ({ url }) => /basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.host),
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-raster',
              expiration: { maxEntries: 6000, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
    }),
  ],
}));
