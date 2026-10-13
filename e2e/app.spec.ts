// Phase 5 end-to-end checks in a real (Chromium, iPhone 13 Pro Max) browser. The Supabase
// address is pretend (http://supabase.test): these tests answer for it, and for the built-in
// question bank they serve the clearly fake sample bank. Nothing real is contacted.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SAMPLE_BANK = readFileSync('tests/fixtures/sample-bank.json', 'utf8');
const USER = {
  id: '00000000-0000-4000-8000-00000000a001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'michelle@example.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-01T00:00:00Z',
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

async function pretendSupabase(page: Page, opts: { password?: string } = {}) {
  const password = opts.password ?? 'correct horse';
  const calls: string[] = [];
  await page.route('**/bank.json', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: SAMPLE_BANK }),
  );
  await page.route('http://supabase.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}`);
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(req.postData() ?? '{}') as { password?: string };
      if (body.password !== password)
        return route.fulfill(
          json(
            { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            400,
          ),
        );
      return route.fulfill(
        json({
          access_token: 'e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'e2e-refresh-token',
          user: USER,
        }),
      );
    }
    if (url.pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/rest/v1/rpc/apply_changes')
      return route.fulfill(
        json({
          inserted: 0,
          duplicates: 0,
          rejected: [],
          settings_version: 1,
          settings_conflict: false,
          server_settings: null,
          settings_error: null,
          max_seq: null,
        }),
      );
    // bank_meta, settings, attempts: nothing on the server yet.
    return route.fulfill(json([]));
  });
  return { calls };
}

async function signIn(page: Page, password = 'correct horse') {
  await page.goto('./');
  await page.getByLabel('Email').fill('michelle@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('a wrong password is explained; the right one opens Home', async ({ page }) => {
  await pretendSupabase(page);
  await signIn(page, 'wrong');
  await expect(page.getByRole('alert')).toContainText("That email and password don't match");
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();
  await noSideScroll(page);
});

test('answer a card, see feedback, and the answer is saved on the phone', async ({ page }) => {
  await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page.getByText('FAKE: Which colour is the test widget?')).toBeVisible();
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Blue' }).click();
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status', { name: 'Feedback' })).toContainText('Correct! +1 XP');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Quit lesson' }).click();
  await expect(page.getByText('1 XP', { exact: true })).toBeVisible();
});

test('every button is at least 44 px tall and the page reads at 17 px or more', async ({
  page,
}) => {
  await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input, select'))
      .map((el) => ({ el, r: (el as HTMLElement).getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height < 44)
      .map(({ el }) => `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent ?? ''}`),
  );
  expect(small).toEqual([]);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('17px');
});

test('ordering: the up/down buttons work in the browser', async ({ page }) => {
  await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  // Area 2, tier S only: the scenario card first, then the ordering card.
  for (const n of [1, 3, 4, 5])
    await page.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }).click();
  await page.getByRole('button', { name: /K · Knowledge/ }).click();
  await page.getByRole('button', { name: /A · Application/ }).click();
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page.getByRole('complementary', { name: 'Scenario' })).toBeVisible();
  await page.locator('button.option').first().click();
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Put the steps for building/)).toBeVisible();
  const rows = page.locator('.order-text');
  const before = await rows.allTextContents();
  await page.getByRole('button', { name: /Item 2 of 5: .*, move up/ }).click();
  const after = await rows.allTextContents();
  expect(after[0]).toBe(before[1]);
  expect(after[1]).toBe(before[0]);
  await noSideScroll(page);
});

test('ordering: a touch drag on the handle moves a row', async ({ page }) => {
  await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  for (const n of [1, 3, 4, 5])
    await page.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }).click();
  await page.getByRole('button', { name: /K · Knowledge/ }).click();
  await page.getByRole('button', { name: /A · Application/ }).click();
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await page.locator('button.option').first().click();
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Put the steps for building/)).toBeVisible();
  const rows = page.locator('.order-text');
  const before = await rows.allTextContents();
  const handle = page.getByRole('button', { name: /^Drag: Item 1 of 5/ });
  const from = (await handle.boundingBox())!;
  const last = (await page.getByRole('button', { name: /^Drag: Item 5 of 5/ }).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = from.x + from.width / 2;
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  const y0 = from.y + from.height / 2;
  await touch('touchStart', y0);
  await page.waitForTimeout(250); // hold: the drag starts after a short press
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', y0 + ((last.y + last.height / 2 - y0) * i) / 10);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', 0);
  await expect.poll(async () => (await rows.allTextContents())[4]).toBe(before[0]);
});

test('Settings: save, reminder confirm, and sign out', async ({ page }) => {
  await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(/^Build /)).toBeVisible();
  await page.getByLabel(/Daily XP goal/).fill('44');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('✓ Saved')).toBeVisible();
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toBeChecked();
  await page.getByRole('switch').click();
  await expect(page.getByRole('dialog', { name: 'Turn off the daily reminder?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('switch')).toBeChecked();
  await noSideScroll(page);
  await expect(page.getByText('All answers backed up')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
});
