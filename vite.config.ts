import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The app is served from https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/
const BASE = '/SPHR-Flashcards/';

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      // Phase 6 adds the custom register file, the reload banner and the icons.
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        name: 'SPHR Flashcards',
        short_name: 'SPHR',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        theme_color: '#1f6f50',
        background_color: '#ffffff',
        icons: [],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,json,png,svg,webmanifest}'],
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
