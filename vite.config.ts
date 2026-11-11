import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  base: './',
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Adaptive Chess Tutor',
        short_name: 'ChessTutor',
        description: 'Adaptive, offline-capable chess training. All data stays on this device.',
        theme_color: '#1f2933',
        background_color: '#f4f1ea',
        display: 'standalone',
        start_url: './',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // App shell only; content packs and the engine are cached at runtime on first use.
        globPatterns: ['**/*.{js,css,html,svg}'],
        globIgnores: ['packs/**', 'engine/**', 'evidence/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/packs/') || url.pathname.includes('/engine/') || url.pathname.includes('/evidence/'),
            handler: 'CacheFirst',
            options: { cacheName: 'content-v1', expiration: { maxEntries: 400 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tablebase.lichess.ovh',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'tablebase-v1', expiration: { maxEntries: 5000 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    testTimeout: 60000,
  },
});
