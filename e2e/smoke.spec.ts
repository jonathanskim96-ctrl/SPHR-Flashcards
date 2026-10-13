import { expect, test } from '@playwright/test';

// Phase 0 smoke test: the production build loads under the GitHub Pages base path.
test('the app shell loads at /SPHR-Flashcards/', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('./');
  await expect(page).toHaveTitle('SPHR Flashcards');
  await expect(page.getByRole('heading', { name: 'SPHR Flashcards' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the question bank is bundled at bank.json', async ({ request }) => {
  const res = await request.get('bank.json');
  expect(res.ok()).toBe(true);
  const bank = await res.json();
  expect(bank.schemaVersion).toBe(1);
  expect(bank.questions.length).toBeGreaterThan(0);
});

test('the web app manifest is generated', async ({ request }) => {
  const res = await request.get('manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.start_url).toBe('/SPHR-Flashcards/');
  expect(manifest.display).toBe('standalone');
});
