// Steps shared by the Phase 9 end-to-end tests: choosing areas and tiers, moving through a
// lesson, and reading Home. All questions come from the clearly fake sample bank.
import { expect, type Page } from '@playwright/test';

export const AREAS = [1, 2, 3, 4, 5] as const;
export const TIERS = ['K', 'A', 'S'] as const;
const TIER_NAME = { K: 'Knowledge', A: 'Application', S: 'Synthesis' } as const;

export const areaButton = (page: Page, n: number) =>
  page.getByRole('button', { name: new RegExp(`^(✓ )?${n}\\. FAKE Area ${n}$`) });
export const tierButton = (page: Page, t: (typeof TIERS)[number]) =>
  page.getByRole('button', { name: new RegExp(`^(✓ )?${t} · ${TIER_NAME[t]}$`) });

/** On Home: make exactly these areas and tiers selected. */
export async function choose(
  page: Page,
  areas: readonly number[],
  tiers: readonly (typeof TIERS)[number][],
) {
  await page.getByRole('button', { name: 'Start lesson' }).waitFor();
  // Switch the wanted ones on first: the last area/tier can never be switched off.
  for (const n of AREAS)
    if (areas.includes(n) && (await areaButton(page, n).getAttribute('aria-pressed')) !== 'true')
      await areaButton(page, n).click();
  for (const t of TIERS)
    if (tiers.includes(t) && (await tierButton(page, t).getAttribute('aria-pressed')) !== 'true')
      await tierButton(page, t).click();
  for (const n of AREAS)
    if (!areas.includes(n) && (await areaButton(page, n).getAttribute('aria-pressed')) === 'true')
      await areaButton(page, n).click();
  for (const t of TIERS)
    if (!tiers.includes(t) && (await tierButton(page, t).getAttribute('aria-pressed')) === 'true')
      await tierButton(page, t).click();
}

export const stem = (page: Page) => page.locator('p.stem');
export const checkButton = (page: Page) => page.getByRole('button', { name: 'Check' });
export const feedback = (page: Page) => page.getByRole('status', { name: 'Feedback' });

/** Gives some answer to the card on screen (right or wrong does not matter), then Check. */
export async function answerAnything(page: Page) {
  for (let i = 0; i < 8 && !(await checkButton(page).isEnabled()); i++) {
    const box = page.getByRole('textbox');
    if (await box.count()) await box.fill('zzz');
    else await page.locator('.options button.option:not([aria-pressed="true"])').first().click();
  }
  await checkButton(page).click();
  await expect(feedback(page)).toBeVisible();
}

/** Answers cards (anything) until the card with this stem is on screen. */
export async function goToCard(page: Page, text: string) {
  for (let i = 0; i < 30; i++) {
    await stem(page).waitFor();
    if ((await stem(page).textContent()) === text) return;
    await answerAnything(page);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  throw new Error(`card not reached: ${text}`);
}

/** Reads the stems of the rest of the lesson by answering every card (anything). */
export async function finishLesson(page: Page): Promise<string[]> {
  const seen: string[] = [];
  while (!(await page.getByRole('heading', { name: 'Lesson complete' }).isVisible())) {
    await stem(page)
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    if (await page.getByRole('heading', { name: 'Lesson complete' }).isVisible()) break;
    seen.push((await stem(page).textContent()) ?? '');
    await answerAnything(page);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  return seen;
}

export const xpTotal = (page: Page) => page.locator('.xp-total');
export const ring = (page: Page) => page.getByRole('img', { name: /^Today's goal/ });
export const mistakesButton = (page: Page) => page.getByRole('button', { name: /^Mistakes \(/ });
