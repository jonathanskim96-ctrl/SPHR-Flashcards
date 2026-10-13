// Phase 6 checks, on the production build: the manifest and icons, the service worker,
// offline use, and the "New version: Reload" flow. The Supabase address is pretend.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { asInstalledApp, pretendSupabase, signIn, watchCsp } from './helpers';

test.use({ serviceWorkers: 'allow' });

const controlled = (page: Page) =>
  page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 20_000 });

test('the manifest is valid, linked, and its icons exist', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/SPHR-Flashcards/manifest.webmanifest');
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({
    name: 'SPHR Flashcards',
    short_name: 'SPHR',
    display: 'standalone',
    start_url: '/SPHR-Flashcards/',
    scope: '/SPHR-Flashcards/',
  });
  const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];
  expect(icons.map((i) => `${i.sizes}${i.purpose ? ' ' + i.purpose : ''}`).sort()).toEqual([
    '192x192',
    '512x512',
    '512x512 maskable',
  ]);
  for (const icon of icons) {
    const res = await request.get(`/SPHR-Flashcards/${icon.src}`);
    expect(res.ok()).toBe(true);
    expect(res.headers()['content-type']).toBe('image/png');
    const png = await res.body();
    expect(png.readUInt32BE(16)).toBe(Number(icon.sizes.split('x')[0])); // PNG width
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  const res = await request.get(apple!);
  expect(res.ok()).toBe(true);
  expect((await res.body()).readUInt32BE(16)).toBe(180);
});

test('the built page carries the Content-Security-Policy', async ({ request }) => {
  const html = await (await request.get('./')).text();
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll('&#39;', "'");
  expect(csp).toBeTruthy();
  expect(csp).toContain("connect-src 'self' http://supabase.test");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toMatch(/unsafe-/);
});

test('the service worker activates and takes control', async ({ page }) => {
  await pretendSupabase(page);
  await page.goto('./');
  await controlled(page);
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.scope,
  );
  expect(scope).toMatch(/\/SPHR-Flashcards\/$/);
});

test('offline: reload, study, queue answers, then go online and the queue empties', async ({
  page,
  context,
}) => {
  const csp = watchCsp(page);
  await asInstalledApp(page);
  const server = await pretendSupabase(page);
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();
  await controlled(page);
  // Let the worker finish saving the app and the question bank.
  await page.evaluate(() => navigator.serviceWorker.ready);

  server.net.down = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();

  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page.getByText('FAKE: Which colour is the test widget?')).toBeVisible();
  await page.getByRole('button', { name: 'Blue' }).click();
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status', { name: 'Feedback' })).toContainText('Correct! +1 XP');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Quit lesson' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('1 answer waiting to back up')).toBeVisible();

  server.net.down = false;
  await context.setOffline(false);
  await expect(page.getByText('All answers backed up')).toBeVisible({ timeout: 20_000 });
  expect(csp).toEqual([]);
});

// ---- the update flow: build A, load it, put build B on the server, reload ------------------

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const PREFIX = '/SPHR-Flashcards/';

function build(id: string, outDir: string) {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir], {
    env: {
      ...process.env,
      BUILD_ID: id,
      VITE_SUPABASE_URL: 'http://supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e',
    },
    stdio: 'pipe',
  });
}

test('update flow: a new build shows the banner; Reload shows the new build id', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const tmp = mkdtempSync(join(tmpdir(), 'sphr-update-'));
  const dirs = { A: join(tmp, 'a'), B: join(tmp, 'b') };
  build('e2e-build-A', dirs.A);
  build('e2e-build-B', dirs.B);

  let current = dirs.A;
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (!path.startsWith(PREFIX)) return void res.writeHead(404).end();
    let file = join(current, normalize(path.slice(PREFIX.length)));
    if (!file.startsWith(current)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    await pretendSupabase(page);
    await asInstalledApp(page);
    await page.goto(`${origin}${PREFIX}`);
    await page.getByLabel('Email').fill('michelle@example.com');
    await page.getByLabel('Password').fill('correct horse');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Build e2e-build-A')).toBeVisible();
    await controlled(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect(page.getByRole('button', { name: 'New version: Reload' })).toHaveCount(0);

    current = dirs.B; // the server now has the new version
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    const reload = page.getByRole('button', { name: 'New version: Reload' });
    await expect(reload).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Build e2e-build-A')).toBeVisible(); // nothing reloaded by itself

    await reload.click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Build e2e-build-B')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New version: Reload' })).toHaveCount(0);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
