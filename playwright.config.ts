import { defineConfig, devices } from '@playwright/test';

// Runs against a production build served by `vite preview`. The build is made here with a
// pretend Supabase address (nothing real is contacted: the tests answer for it), into its own
// folder so it never touches `dist`. Chromium is the engine available; the device profile is
// the owner's target phone. The bundled bank is the clearly fake sample bank.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://localhost:4173/SPHR-Flashcards/',
    trace: 'retain-on-failure',
    // The service worker answers some requests itself, which hides them from the tests'
    // pretend server. Only e2e/pwa.spec.ts turns it on.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'iphone-13-pro-max',
      use: { ...devices['iPhone 13 Pro Max'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command:
      'node scripts/build-bank.mjs tests/fixtures/sample-bank.json && ' +
      'VITE_SUPABASE_URL=http://supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e ' +
      'npx vite build --outDir dist-e2e && ' +
      'npx vite preview --outDir dist-e2e --port 4173 --strictPort',
    url: 'http://localhost:4173/SPHR-Flashcards/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
