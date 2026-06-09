import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // dev runs at root; production is a GitHub Pages project site at /canalpal/
  base: command === 'build' ? '/canalpal/' : '/',
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
        maximumFileSizeToCacheInBytes: 80 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.pmtiles'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pmtiles',
              rangeRequests: true,
              expiration: { maxEntries: 4 },
            },
          },
          {
            // Raster basemap tiles (CARTO coloured/mono) -> cache visited tiles
            // so areas you've panned over keep working offline ("nearly offline").
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
