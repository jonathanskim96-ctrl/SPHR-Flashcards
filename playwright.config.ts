import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`npm run build` first), served by `vite preview`.
// Chromium is the engine available; the device profile is the owner's target phone.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://localhost:4173/SPHR-Flashcards/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-13-pro-max',
      use: { ...devices['iPhone 13 Pro Max'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173/SPHR-Flashcards/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
