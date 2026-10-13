// Phase 7: the real service worker's daily-reminder handler, on the production build. A push
// message is delivered through the browser's DevTools protocol (no push service involved).
import { expect, test } from '@playwright/test';
import { pretendSupabase } from './helpers';

// The lightweight headless browser has no notifications at all; the full Chromium build
// (also pre-installed, and installed in CI) running headless does.
test.use({ serviceWorkers: 'allow', channel: 'chromium' });

test('a push message shows the reminder notification (the real service worker)', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await pretendSupabase(page);
  await page.goto('./');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
    timeout: 20_000,
  });
  const cdp = await context.newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const reg = e.registrations.find((r) => r.scopeURL.endsWith('/SPHR-Flashcards/'));
      if (reg) resolve(reg.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  // Whatever the message says, the notification text is fixed in the worker.
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(page.url()).origin,
    registrationId: await registrationId,
    data: '{"kind":"daily-reminder","title":"<b>not shown</b>"}',
  });
  const shown = () =>
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return (await reg.getNotifications()).map((n) => ({
        title: n.title,
        body: n.body,
        tag: n.tag,
        icon: n.icon,
      }));
    });
  await expect.poll(shown, { timeout: 10_000 }).toHaveLength(1);
  expect(await shown()).toEqual([
    {
      title: 'SPHR Flashcards',
      body: 'You should practice some questions',
      tag: 'daily-reminder',
      icon: `${new URL(page.url()).origin}/SPHR-Flashcards/icons/icon-192.png`,
    },
  ]);
});
