// Phase 9: backing up and restoring, end to end. Two phones (two browser contexts) share one
// pretend account (e2e/cloud.ts); offline answers wait and then back up; a settings conflict
// keeps the server's copy and says so; export → sign out → a fresh account → import gives
// the same progress; and payloads in question text, typed answers and an imported file only
// ever appear as text. Questions come from the clearly fake sample bank.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loadSampleBank, PretendCloud } from './cloud';
import { signIn, watchCsp } from './helpers';
import {
  checkButton,
  choose,
  feedback,
  finishLesson,
  goToCard,
  mistakesButton,
  ring,
  xpTotal,
} from './study';

test.use({ timezoneId: 'America/Los_Angeles' });

const bank = loadSampleBank();
const stemOf = (id: string) => bank.questions.find((q) => q.id === id)!.stem as string;

async function phone(browser: Browser, cloud: PretendCloud) {
  const context = await browser.newContext({
    ...test.info().project.use,
    timezoneId: 'America/Los_Angeles',
    serviceWorkers: 'block',
  });
  await cloud.attach(context);
  const page = await context.newPage();
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  return { context, page };
}

/** Answers one mc card (area 1, K or A) with this choice text and goes back to Home. */
async function answerMc(page: Page, id: string, choice: string, tier: 'K' | 'A') {
  await choose(page, [1], [tier]);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, stemOf(id));
  await page.getByRole('button', { name: choice, exact: true }).click();
  await checkButton(page).click();
  await expect(feedback(page)).toBeVisible();
  await page.getByRole('button', { name: 'Quit lesson' }).click();
}

/** "Comes back to the front": the app syncs on this. */
const toFront = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

const backupLine = (page: Page) =>
  page.getByRole('region', { name: 'Backup' }).getByRole('status').first();

test('two phones: answers on one appear on the other', async ({ browser }) => {
  const cloud = new PretendCloud();
  const a = await phone(browser, cloud);
  await answerMc(a.page, 'fake1-q01', 'Blue', 'K'); // +1
  await expect.poll(() => cloud.server().rows.length).toBe(1);

  const b = await phone(browser, cloud);
  await expect(xpTotal(b.page)).toHaveText('1 XP');
  // The card answered on phone A today is not offered again on phone B.
  await choose(b.page, [1], ['K']);
  await b.page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(b.page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await b.page.getByRole('button', { name: 'Back to Home' }).click();
  await answerMc(b.page, 'fake1-q02', textOfAnswer('fake1-q02'), 'A'); // +2
  await expect.poll(() => cloud.server().rows.length).toBe(2);

  await toFront(a.page);
  await expect(xpTotal(a.page)).toHaveText('3 XP');
  await expect(ring(a.page)).toHaveAccessibleName("Today's goal: 3 of 30 XP");
  await a.context.close();
  await b.context.close();
});

function textOfAnswer(id: string) {
  const q = bank.questions.find((x) => x.id === id)!;
  return (q.choices as { id: string; text: string }[]).find((c) => c.id === q.answer)!.text;
}

test('offline: answers wait on the phone, then back up and reach the other phone', async ({
  browser,
}) => {
  const cloud = new PretendCloud();
  const a = await phone(browser, cloud);
  const b = await phone(browser, cloud);
  await a.context.setOffline(true);
  await answerMc(a.page, 'fake1-q01', 'Green', 'K'); // wrong, offline
  await a.page.getByRole('button', { name: 'Settings' }).click();
  await expect(backupLine(a.page)).toContainText('1 answer waiting to back up');
  // Sign-out is refused while an answer waits.
  await a.page.getByRole('button', { name: 'Sign out' }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(a.page.getByRole('region', { name: 'Account' }).getByRole('alert')).toBeVisible();
  expect(cloud.server().rows).toHaveLength(0);

  await answerMc(b.page, 'fake1-q02', textOfAnswer('fake1-q02'), 'A'); // online
  await expect.poll(() => cloud.server().rows.length).toBe(1);

  await a.context.setOffline(false);
  await expect(backupLine(a.page)).toContainText('All answers backed up');
  expect(cloud.server().rows).toHaveLength(2);
  await a.page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(xpTotal(a.page)).toHaveText('2 XP');
  await toFront(b.page);
  await expect(xpTotal(b.page)).toHaveText('2 XP');
  // The wrong answer made offline on phone A puts the card in Mistakes on both phones; it can
  // be practised from tomorrow (audit M2), so look on both phones a day later.
  for (const p of [a.page, b.page]) {
    await p.clock.install({ time: Date.now() + 24 * 60 * 60 * 1000 });
    await p.reload();
    await p.getByRole('button', { name: 'Start lesson' }).waitFor();
    await choose(p, [1], ['K', 'A']);
    await expect(mistakesButton(p)).toHaveText('Mistakes (1)');
  }
  await a.context.close();
  await b.context.close();
});

test('settings conflict: the other phone’s newer change wins, with a notice', async ({
  browser,
}) => {
  const cloud = new PretendCloud();
  const a = await phone(browser, cloud);
  const b = await phone(browser, cloud);
  await expect.poll(() => cloud.server().settings?.version).toBe(1);
  for (const p of [a.page, b.page]) await p.getByRole('button', { name: 'Settings' }).click();

  await a.page.getByLabel(/Daily XP goal/).fill('44');
  await a.page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => cloud.server().settings?.value.dailyXpGoal).toBe(44);

  // Phone B still has version 1 and saves a different goal: the server refuses it.
  await b.page.getByLabel(/Daily XP goal/).fill('55');
  await b.page.getByRole('button', { name: 'Save' }).click();
  await expect(
    b.page.getByText('Settings were changed on another device; reloaded them.'),
  ).toBeVisible();
  await expect(b.page.getByLabel(/Daily XP goal/)).toHaveValue('44');
  expect(cloud.server().settings?.value.dailyXpGoal).toBe(44);
  await b.page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(ring(b.page)).toHaveAccessibleName("Today's goal: 0 of 44 XP");
  await a.context.close();
  await b.context.close();
});

/** Everything Home shows about progress, as text. */
async function homeRecord(page: Page) {
  await choose(page, [1, 2, 3, 4, 5], ['K', 'A', 'S']);
  return {
    xp: await xpTotal(page).textContent(),
    ring: await ring(page).getAttribute('aria-label'),
    // Hidden when nothing can be practised today (audit M2).
    mistakes: (await mistakesButton(page).count())
      ? await mistakesButton(page).textContent()
      : null,
    bars: await page
      .getByRole('progressbar')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  };
}

test('export → sign out → sign in to a fresh account → import: identical progress', async ({
  page,
}) => {
  const cloud = new PretendCloud();
  const fresh = cloud.addAccount('fresh@example.com', 'another horse');
  await page.clock.install({ time: new Date('2026-10-20T09:00:00-07:00') });
  cloud.now = new Date('2026-10-20T09:00:00-07:00').getTime();
  await cloud.attach(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await finishLesson(page); // 10 cards, some right and some wrong
  await page.getByRole('button', { name: 'Done' }).click();
  // A second day, so card schedules (not only XP) are part of the record.
  cloud.now += 24 * 60 * 60 * 1000;
  await page.clock.setSystemTime(cloud.now);
  await page.reload();
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await finishLesson(page);
  await page.getByRole('button', { name: 'Done' }).click();
  const before = await homeRecord(page);
  expect(before.xp).not.toBe('0 XP');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(backupLine(page)).toContainText('All answers backed up');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export progress' }).first().click(),
  ]);
  expect(download.suggestedFilename()).toBe('sphr-progress-2026-10-21.json');
  const file = join(mkdtempSync(join(tmpdir(), 'sphr-export-')), download.suggestedFilename());
  await download.saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8')) as { attempts: unknown[] };
  expect(exported.attempts).toHaveLength(20);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill('fresh@example.com');
  await page.getByLabel('Password').fill('another horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(xpTotal(page)).toHaveText('0 XP');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Progress file').setInputFiles(file);
  const dialog = page.getByRole('dialog', { name: 'Import progress?' });
  await expect(dialog).toContainText('20 new answers, 0 already present, 0 rejected.');
  // A different account: it warns, and Import waits for "Import anyway" (audit L4).
  await expect(dialog.getByRole('alert')).toContainText('a different account');
  await expect(dialog.getByRole('button', { name: 'Import' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Import anyway' }).check();
  await dialog.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText(/Imported 20 new answers/)).toBeVisible({ timeout: 10_000 });
  await expect(backupLine(page)).toContainText('All answers backed up', { timeout: 10_000 });
  expect(fresh.rows).toHaveLength(20);
  await page.getByRole('button', { name: 'Back to Home' }).click();
  expect(await homeRecord(page)).toEqual(before);
});

// ---------------------------------------------------------------------------------------
// XSS: payloads in the server's questions, a typed answer, and an imported file

const IMG = '<img src=x onerror="window.__xss=1">';
const SCRIPT = '"><script>window.__xss=1</script>';
const SVG = '<svg onload="window.__xss=1">';

function poisonedBank() {
  const b = structuredClone(bank);
  b.bankVersion = '2026-10-13.7';
  const q = (id: string) => b.questions.find((x) => x.id === id)!;
  const mc = q('fake1-q04'); // area 2 K, with the scenario
  mc.stem = `${IMG} stem`;
  mc.explanation = `${SCRIPT} explanation`;
  (mc.choices as { text: string }[]).forEach(
    (c, i) => (c.text = `${[IMG, SCRIPT, SVG][i % 3]} choice ${i}`),
  );
  const sc = b.scenarios[0] as { title: string; text: string };
  sc.title = `${SVG} title`;
  sc.text = `${IMG} scenario`;
  const text = q('fake2-q05'); // numeric, area 2 K
  text.explanation = `${SVG} numeric explanation`;
  text.displayAnswer = `${SCRIPT} 30 days`;
  return b;
}

async function noScriptRan(page: Page) {
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('main img, main script, main svg[onload]').count()).toBe(0);
}

test('XSS: payloads in questions, typed answers and an imported file show as text', async ({
  page,
}) => {
  const csp = watchCsp(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const cloud = new PretendCloud();
  cloud.server().bank = poisonedBank();
  await cloud.attach(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Version 2026-10-13.7 (server)')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Home' }).click();

  await choose(page, [2], ['K']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, `${IMG} stem`);
  await expect(page.getByRole('complementary', { name: 'Scenario' })).toContainText(`${SVG} title`);
  await expect(page.getByRole('complementary', { name: 'Scenario' })).toContainText(
    `${IMG} scenario`,
  );
  await expect(page.getByRole('button', { name: `${SCRIPT} choice 1` })).toBeVisible();
  await noScriptRan(page);
  await page.getByRole('button', { name: `${SCRIPT} choice 1` }).click(); // wrong (D is right)
  await checkButton(page).click();
  await expect(feedback(page)).toContainText(`${SCRIPT} explanation`);
  await expect(feedback(page)).toContainText(`Correct answer: ${IMG} choice 3`);
  await noScriptRan(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await goToCard(page, stemOf('fake2-q05'));
  await page.getByLabel('Your answer').fill(`${IMG}`);
  await checkButton(page).click();
  await expect(feedback(page)).toContainText(`Correct answer: ${SCRIPT} 30 days`);
  await expect(feedback(page)).toContainText(`${SVG} numeric explanation`);
  await noScriptRan(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  // An imported file with payloads: the preview lists the rejections as text.
  await page.getByRole('button', { name: 'Settings' }).click();
  const file = join(mkdtempSync(join(tmpdir(), 'sphr-xss-')), 'bad.json');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export progress' }).first().click(),
  ]);
  await download.saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8')) as {
    attempts: Record<string, unknown>[];
  };
  exported.attempts.push(
    { ...exported.attempts[0], id: IMG, questionId: SCRIPT },
    { ...exported.attempts[0], id: crypto.randomUUID(), mode: SVG },
  );
  writeFileSync(file, JSON.stringify(exported));
  await page.getByLabel('Progress file').setInputFiles(file);
  const dialog = page.getByRole('dialog', { name: 'Import progress?' });
  await expect(dialog).toContainText('2 rejected');
  await noScriptRan(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  expect(dialogs).toEqual([]);
  expect(csp).toEqual([]);
});
