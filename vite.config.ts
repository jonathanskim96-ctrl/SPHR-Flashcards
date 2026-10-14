import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The app is served from https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/
const BASE = '/SPHR-Flashcards/';

// Shown in the Settings footer so she can tell which version is running.
// BUILD_ID can be set by hand (the update test builds two different versions).
const BUILD_ID =
  process.env.BUILD_ID ??
  `${new Date().toISOString().slice(0, 10)}-${(process.env.GITHUB_SHA ?? 'dev').slice(0, 7)}`;

/**
 * The Supabase address must be the bare project address (`https://abcd1234.supabase.co`).
 * Anything after it (such as `/rest/v1/`, which Supabase's Data API page shows) makes every
 * request fail at sign-in, so the build stops with a plain message instead. The message never
 * repeats the value: a secret pasted into the wrong box would otherwise be printed again.
 * Plain http is accepted only for the reserved test names (`*.test`, `localhost`).
 */
export function checkSupabaseUrl(value: string | undefined): void {
  if (!value) return;
  const fix =
    'Set the repository variable VITE_SUPABASE_URL to just the Project URL, like ' +
    'https://abcd1234.supabase.co (nothing after .co: no /rest/v1/, no slash, no space).';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_SUPABASE_URL is not a web address. ${fix}`);
  }
  const testHost = url.hostname === 'localhost' || url.hostname.endsWith('.test');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && testHost))
    throw new Error(`VITE_SUPABASE_URL must start with https://. ${fix}`);
  if (value !== url.origin)
    throw new Error(`VITE_SUPABASE_URL has something extra before or after the address. ${fix}`);
}

/**
 * The Content-Security-Policy as a <meta> tag, added to the built page only (the dev server
 * needs inline scripts). connect-src is limited to this site and the Supabase project.
 * frame-ancestors cannot be set from a meta tag (browsers ignore it there); the frame-busting
 * check in src/frameBust.ts covers that instead.
 */
export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
  checkSupabaseUrl(supabaseUrl);
  const connect = ["'self'"];
  if (supabaseUrl) connect.push(new URL(supabaseUrl).origin);
  return [
    "default-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function cspPlugin(supabaseUrl: string | undefined): Plugin {
  return {
    name: 'sphr-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: contentSecurityPolicy(supabaseUrl),
        },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  base: BASE,
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    cspPlugin(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL),
    VitePWA({
      // Registered by hand in src/pwa.ts, which also drives the "New version: Reload" banner.
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
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The daily reminder's `push` and `notificationclick` handlers (Phase 7).
        importScripts: ['push-sw.js'],
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
}));
