// Phase 9: what happens across days, with a fake clock in Los Angeles time: the daily
// new-card cap, the Mistakes deck (a card leaves after correct answers on two different
// days), mastery bars and the tier badge, and XP with the daily ring resetting at local
// midnight. The phone's answers stay in its IndexedDB across reloads, like the real app.
import { expect, test, type Page } from '@playwright/test';
import { loadSampleBank, PretendCloud } from './cloud';
import { signIn } from './helpers';
import {
  checkButton,
  choose,
  feedback,
  finishLesson,
  goToCard,
  mistakesButton,
  ring,
  stem,
  xpTotal,
} from './study';

test.use({ timezoneId: 'America/Los_Angeles' });

const bank = loadSampleBank();
const stemOf = (id: string) => bank.questions.find((q) => q.id === id)!.stem as string;
const DAY = 24 * 60 * 60 * 1000;

/** Opens the app at this Los Angeles time (`2026-10-20T09:00`). */
async function openAt(page: Page, local: string) {
  const cloud = new PretendCloud();
  const time = new Date(`${local}:00-07:00`);
  cloud.now = time.getTime();
  await page.clock.install({ time });
  await cloud.attach(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  return cloud;
}

/** Moves the phone (and the server) to the same time on a later day, and reopens the app. */
async function nextDay(page: Page, cloud: PretendCloud, days = 1) {
  cloud.now += days * DAY;
  await page.clock.setSystemTime(cloud.now);
  await page.reload();
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
}

async function answerOnly(page: Page, id: string, choice: string, mode = 'Start lesson') {
  await page.getByRole('button', { name: mode }).click();
  await goToCard(page, stemOf(id));
  await page.getByRole('button', { name: choice, exact: true }).click();
  await checkButton(page).click();
  await expect(feedback(page)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Lesson complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
}

test('daily new-card cap: after 15 new cards only "All caught up" is left today', async ({
  page,
}) => {
  const cloud = await openAt(page, '2026-10-20T09:00');
  await page.getByRole('button', { name: 'Start lesson' }).click();
  const first = await finishLesson(page); // 10-card lessons
  expect(first).toHaveLength(10);
  await page.getByRole('button', { name: 'Keep going' }).click();
  const second = await finishLesson(page); // 5 more reach the cap of 15
  expect(second).toHaveLength(5);
  expect(new Set([...first, ...second]).size).toBe(15);
  await page.getByRole('button', { name: 'Keep going' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();

  // Tomorrow: yesterday's cards are due for review, and come before new ones.
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await nextDay(page, cloud);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  const third = await finishLesson(page);
  expect(third).toHaveLength(10);
  for (const s of third) expect([...first, ...second]).toContain(s);
});

test('Mistakes: a wrong card joins it and leaves after right answers on two different days', async ({
  page,
}) => {
  const cloud = await openAt(page, '2026-10-20T09:00');
  await choose(page, [1], ['K']);
  await expect(mistakesButton(page)).toHaveCount(0);
  await answerOnly(page, 'fake1-q01', 'Green'); // wrong
  // Answered today, so it can't be practised until tomorrow: no button that leads nowhere
  // (audit M2: before, "Mistakes (1)" opened "All caught up" in a loop).
  await expect(mistakesButton(page)).toHaveCount(0);

  // Day 1: in Mistakes; right once. Still in Mistakes, but not offered again the same day.
  await nextDay(page, cloud);
  await expect(mistakesButton(page)).toHaveText('Mistakes (1)');
  await answerOnly(page, 'fake1-q01', 'Blue', 'Mistakes (1)');
  await expect(mistakesButton(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Practice Mistakes/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Home' }).click();

  // Day 2: still in Mistakes (one right answer is not enough); right again: it leaves.
  await nextDay(page, cloud);
  await expect(mistakesButton(page)).toHaveText('Mistakes (1)');
  await answerOnly(page, 'fake1-q01', 'Blue', 'Mistakes (1)');
  await nextDay(page, cloud);
  await expect(mistakesButton(page)).toHaveCount(0);
});

test('progress bars and the tier badge update after mastery', async ({ page }) => {
  const cloud = await openAt(page, '2026-10-20T09:00');
  // Area 5, Knowledge has one card (a tiny tier): mastered after 2 right answers.
  const bar = page.getByRole('progressbar', { name: 'FAKE Area 5, Knowledge: 0 of 1 mastered' });
  const tierRow = page
    .locator('.area')
    .filter({ hasText: 'FAKE Area 5' })
    .locator('.tier-row')
    .first();
  await expect(bar).toBeVisible();
  await expect(tierRow.getByRole('img', { name: 'Mastered' })).toHaveCount(0);
  await choose(page, [5], ['K']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, stemOf('fake2-q06'));
  await page.getByLabel('Your answer').fill('72');
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('Correct!');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toBeVisible(); // one right answer is not mastery
  await expect(tierRow.getByRole('img', { name: 'Mastered' })).toHaveCount(0);

  await nextDay(page, cloud);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, stemOf('fake2-q06'));
  await page.getByLabel('Your answer').fill('72 °F');
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('Correct!');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('progressbar', { name: 'FAKE Area 5, Knowledge: 1 of 1 mastered' }),
  ).toBeVisible();
  await expect(tierRow).toContainText('1/1');
  await expect(tierRow.getByRole('img', { name: 'Mastered' })).toBeVisible();
  // Only that tier: the other tiers of area 5 are not mastered.
  await expect(page.getByRole('img', { name: 'Mastered' })).toHaveCount(1);
});

test('XP total and the daily ring update, and the ring resets at local midnight', async ({
  page,
}) => {
  const cloud = await openAt(page, '2026-10-20T23:58');
  await expect(xpTotal(page)).toHaveText('0 XP');
  await expect(ring(page)).toHaveAccessibleName("Today's goal: 0 of 30 XP");
  await choose(page, [2], ['S']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, stemOf('fake1-q03'));
  const right = bank.questions.find((q) => q.id === 'fake1-q03')!;
  const text = (right.choices as { id: string; text: string }[]).find(
    (c) => c.id === right.answer,
  )!.text;
  await page.getByRole('button', { name: text, exact: true }).click();
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('+3 XP');
  await page.getByRole('button', { name: 'Quit lesson' }).click();
  await expect(xpTotal(page)).toHaveText('3 XP');
  await expect(ring(page)).toHaveAccessibleName("Today's goal: 3 of 30 XP");

  // The app stays open on Home past midnight (no sync runs in between): the ring starts
  // again, the total stays.
  // The backup after an answer happens first (it would redraw Home by itself).
  await expect
    .poll(async () => {
      await page.clock.runFor(1000);
      return cloud.server().rows.length;
    })
    .toBe(1);
  await page.clock.runFor(1000);
  await page.clock.fastForward('02:00');
  await expect(ring(page)).toHaveAccessibleName("Today's goal: 0 of 30 XP");
  await expect(xpTotal(page)).toHaveText('3 XP');
  await expect(stem(page)).toHaveCount(0);
});
