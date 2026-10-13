// Phase 7: the daily reminder in a real browser, on the production build, with a pretend
// iPhone notification system (e2e/helpers.ts fakePushPhone) and the pretend Supabase server.
// The real service worker's push handling is checked in e2e/pwa.spec.ts.
import { expect, test } from '@playwright/test';
import { asInstalledApp, fakePushPhone, pretendSupabase, signIn, watchCsp } from './helpers';

test('Home card: Turn on asks from the tap, subscribes, saves; every start re-saves', async ({
  page,
}) => {
  const csp = watchCsp(page);
  await asInstalledApp(page);
  const phone = await fakePushPhone(page);
  const server = await pretendSupabase(page);
  await signIn(page);
  const card = page.getByRole('region', { name: 'Daily reminder offer' });
  await expect(card).toContainText('Turn on daily reminder (3:00 PM)?');
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(card).toHaveCount(0);
  const log = await phone.log();
  // The permission request is the first thing, made while the tap is being handled.
  expect(log[0]).toBe('requestPermission@click');
  expect(log).toContain('subscribe userVisibleOnly=true key=65');
  await expect.poll(() => server.pushCalls.length).toBeGreaterThanOrEqual(1);
  expect(server.pushCalls[0]).toMatch(/^save https:\/\/web\.push\.apple\.com\/e2e-/);
  const endpoint = server.pushCalls[0]!.slice('save '.length);

  // Open the app again: the same subscription is saved again, without asking.
  const before = server.pushCalls.length;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();
  await expect.poll(() => server.pushCalls.length).toBeGreaterThan(before);
  expect(server.pushCalls.at(-1)).toBe(`save ${endpoint}`);
  expect((await phone.log()).filter((e) => e.startsWith('requestPermission'))).toHaveLength(1);
  await expect(card).toHaveCount(0);
  expect(csp).toEqual([]);
});

test('Settings: the switch turns on from the tap; turning off asks, then disables', async ({
  page,
}) => {
  await asInstalledApp(page);
  const phone = await fakePushPhone(page);
  const server = await pretendSupabase(page);
  await signIn(page);
  await page
    .getByRole('region', { name: 'Daily reminder offer' })
    .getByRole('button', { name: 'Not now' })
    .click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const sw = page.getByRole('switch', { name: 'Remind me every day' });
  await sw.click();
  await expect(sw).toBeChecked();
  expect((await phone.log())[0]).toBe('requestPermission@click');
  await expect.poll(() => server.pushCalls[0]).toMatch(/^save /);
  const endpoint = server.pushCalls[0]!.slice('save '.length);
  await sw.click();
  await page
    .getByRole('dialog', { name: 'Turn off the daily reminder?' })
    .getByRole('button', { name: 'Turn off' })
    .click();
  await expect(sw).not.toBeChecked();
  await expect.poll(() => server.pushCalls).toContain(`disable ${endpoint}`);
});

test("Don't Allow: the switch stays off and the iPhone Settings steps are shown", async ({
  page,
}) => {
  await asInstalledApp(page);
  await fakePushPhone(page, { answer: 'denied' });
  const server = await pretendSupabase(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const sw = page.getByRole('switch', { name: 'Remind me every day' });
  await sw.click();
  await expect(page.getByRole('alert')).toContainText('Allow Notifications');
  await expect(sw).not.toBeChecked();
  expect(server.pushCalls).toEqual([]);
});
