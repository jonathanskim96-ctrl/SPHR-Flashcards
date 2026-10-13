import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The app is served from https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/
const BASE = '/SPHR-Flashcards/';

// Shown in the Settings footer so she can tell which version is running.
const BUILD_ID = `${new Date().toISOString().slice(0, 10)}-${(process.env.GITHUB_SHA ?? 'dev').slice(0, 7)}`;

export default defineConfig({
  base: BASE,
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
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
    // The 1,000-case property tests are CPU-heavy: alone ~1.5 s, but over 5 s when they share
    // the machine with the screen tests. Only the time limit is raised; no check is loosened.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts', 'src/data/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/domain/types.ts'],
      reporter: ['text-summary', 'text'],
      // BUILD_PLAN Phase 1: 100% of the domain is covered by tests. Phase 3 holds the data
      // layer (storage and sync) to the same bar.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
