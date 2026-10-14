// Phase 9: sign-in, every question type answered right and wrong, the answer inputs (touch,
// buttons, tap-to-place, keyboard only), and the display rules, on the production build with
// the iPhone 13 Pro Max profile. Questions come from the clearly fake sample bank; the
// pretend server (e2e/cloud.ts) serves a copy of it with citations and notes filled in, so
// the test can check those are never shown.
import { expect, test, type Page } from '@playwright/test';
import { loadSampleBank, PretendCloud, seedRandom } from './cloud';
import { signIn, watchCsp } from './helpers';
import {
  answerAnything,
  checkButton,
  choose,
  feedback,
  finishLesson,
  goToCard,
  stem,
} from './study';

const bank = loadSampleBank();
type Q = Record<string, unknown> & { id: string; stem: string; explanation: string };
const q = (id: string) => bank.questions.find((x) => x.id === id) as Q;
const texts = (xs: unknown) => (xs as { id: string; text: string }[]).map((x) => x.text);
const textOf = (xs: unknown, id: string) =>
  (xs as { id: string; text: string }[]).find((x) => x.id === id)!.text;

/** The fake bank as the server has it: same questions, plus citations and notes. */
function serverBank() {
  const b = structuredClone(bank);
  b.bankVersion = '2026-10-13.2';
  for (const x of b.questions) {
    x.citations = ['FAKE-CITATION 99 U.S.C. § 0'];
    x.otherNotes = 'FAKE-OTHER-NOTE common wrong answer';
  }
  return b;
}
const NEVER_SHOWN = (id: string) => [
  'FAKE-CITATION',
  'FAKE-OTHER-NOTE',
  ...Object.values((q(id).wrongReasons as Record<string, string> | undefined) ?? {}),
  (q(id).source as { doc: string }).doc,
];

async function open(page: Page, seed = 1) {
  const cloud = new PretendCloud();
  cloud.server().bank = serverBank();
  await seedRandom(page, seed);
  await cloud.attach(page);
  await signIn(page);
  return cloud;
}

/** Waits until the server's copy (with citations) is the one in use. */
async function serverCopyInUse(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Version 2026-10-13.2 (server)')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Home' }).click();
}

const rows = (page: Page) => page.locator('.order-text');

/** Puts the ordering rows in this order with the ▲ buttons. */
async function orderWithButtons(page: Page, wanted: string[]) {
  for (let i = 0; i < wanted.length; i++) {
    let at = (await rows(page).allTextContents()).indexOf(wanted[i]!);
    while (at > i) {
      await page
        .getByRole('button', { name: new RegExp(`^Item ${at + 1} of \\d+: .*, move up$`) })
        .click();
      at--;
    }
  }
}

/** Presses Tab until the focused element's accessible label or text matches. */
async function tabTo(page: Page, re: RegExp) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '') : '';
    });
    if (re.test(label)) return;
  }
  throw new Error(`nothing focusable matched ${re}`);
}

// ---------------------------------------------------------------------------------------
// Sign-in

test('sign in: a wrong password is explained, and there is no way to sign up', async ({ page }) => {
  const cloud = new PretendCloud();
  await cloud.attach(page);
  await signIn(page, 'wrong');
  await expect(page.getByRole('alert')).toContainText("That email and password don't match");
  const body = (await page.locator('body').innerText()).toLowerCase();
  for (const word of ['sign up', 'sign-up', 'signup', 'register', 'create account', 'forgot'])
    expect(body).not.toContain(word);
  expect(await page.getByRole('link').count()).toBe(0);
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();
  expect(cloud.calls.some((c) => c.includes('/auth/v1/signup'))).toBe(false);
});

// ---------------------------------------------------------------------------------------
// Every question type, right and wrong

interface Case {
  id: string;
  areas: number[];
  tiers: ('K' | 'A' | 'S')[];
  xp: number;
  right: (page: Page) => Promise<void>;
  wrong: (page: Page) => Promise<void>;
  /** Text the wrong-answer feedback must show (the correct answer). */
  shows: string[];
}

const multi = q('fake2-q01');
const ordering = q('fake2-q10');
const matching = q('fake2-q11');
const CASES: Case[] = [
  {
    id: 'fake1-q01',
    areas: [1],
    tiers: ['K'],
    xp: 1,
    right: async (page) => page.getByRole('button', { name: 'Blue', exact: true }).click(),
    wrong: async (page) => page.getByRole('button', { name: 'Green', exact: true }).click(),
    shows: ['Correct answer: Blue'],
  },
  {
    id: 'fake2-q01',
    areas: [4],
    tiers: ['A'],
    xp: 2,
    right: async (page) => {
      await page.getByRole('button', { name: 'Flux sprocket' }).click();
      await page.getByRole('button', { name: 'Zorb flange' }).click();
    },
    wrong: async (page) => {
      await page.getByRole('button', { name: 'Flux sprocket' }).click();
      await page.getByRole('button', { name: 'Kitchen sink' }).click();
    },
    shows: ['Correct answers:', 'Flux sprocket', 'Zorb flange', 'Your choices:', '✗ Kitchen sink'],
  },
  {
    id: 'fake2-q06',
    areas: [5],
    tiers: ['K'],
    xp: 1,
    right: async (page) => page.getByLabel('Your answer').fill('72'),
    wrong: async (page) => page.getByLabel('Your answer').fill('71'),
    shows: ['Correct answer: 72°F'],
  },
  {
    id: 'fake2-q08',
    areas: [3],
    tiers: ['K'],
    xp: 1,
    // Case, extra spaces and one trailing period are forgiven; nothing else.
    right: async (page) => page.getByLabel('Your answer').fill('  Widget   Wrangling. '),
    wrong: async (page) => page.getByLabel('Your answer').fill('widget wrangle'),
    shows: ['Correct answer: widget-wrangling'],
  },
  {
    id: 'fake2-q10',
    areas: [2],
    tiers: ['S'],
    xp: 3,
    right: async (page) =>
      orderWithButtons(
        page,
        (ordering.answer as string[]).map((id) => textOf(ordering.items, id)),
      ),
    wrong: async (page) =>
      orderWithButtons(
        page,
        [...(ordering.answer as string[])].reverse().map((id) => textOf(ordering.items, id)),
      ),
    shows: ['Correct order:', 'Your order:', ...texts(ordering.items)],
  },
  {
    id: 'fake2-q11',
    areas: [1],
    tiers: ['S'],
    xp: 3,
    right: async (page) => {
      for (const [p, o] of Object.entries(matching.answer as Record<string, string>)) {
        await page
          .getByRole('button', { name: new RegExp(`^${textOf(matching.prompts, p)}`) })
          .click();
        await page.getByRole('button', { name: textOf(matching.options, o), exact: true }).click();
      }
    },
    wrong: async (page) => {
      // Sprocketron and Flangeomatic swapped; the other two right.
      const plan: [string, string][] = [
        ['1', 'D'],
        ['2', 'B'],
        ['3', 'A'],
        ['4', 'E'],
      ];
      for (const [p, o] of plan) {
        await page
          .getByRole('button', { name: new RegExp(`^${textOf(matching.prompts, p)}`) })
          .click();
        await page.getByRole('button', { name: textOf(matching.options, o), exact: true }).click();
      }
    },
    shows: [
      'Correct pairs:',
      '✗ Sprocketron → Spins sprockets (you chose: Bends flanges)',
      '✓ Gizmoscope → Looks inside gizmos',
    ],
  },
];

for (const c of CASES) {
  const question = q(c.id);
  test(`${question.type} (${c.id}) answered right shows "Correct!" and +${c.xp} XP`, async ({
    page,
  }) => {
    await open(page);
    await serverCopyInUse(page);
    await choose(page, c.areas, c.tiers);
    await page.getByRole('button', { name: 'Start lesson' }).click();
    await goToCard(page, question.stem);
    await c.right(page);
    await checkButton(page).click();
    await expect(feedback(page)).toContainText(`✓ Correct! +${c.xp} XP`);
    const shown = await feedback(page).innerText();
    expect(shown).not.toContain(question.explanation);
    expect(shown).not.toContain('Not quite');
    for (const hidden of NEVER_SHOWN(c.id))
      expect(await page.locator('body').innerText()).not.toContain(hidden);
  });

  test(`${question.type} (${c.id}) answered wrong shows the answer and the explanation`, async ({
    page,
  }) => {
    await open(page);
    await serverCopyInUse(page);
    await choose(page, c.areas, c.tiers);
    await page.getByRole('button', { name: 'Start lesson' }).click();
    await goToCard(page, question.stem);
    await c.wrong(page);
    await checkButton(page).click();
    await expect(feedback(page)).toContainText('✗ Not quite');
    for (const t of c.shows) await expect(feedback(page)).toContainText(t);
    await expect(feedback(page)).toContainText(question.explanation);
    expect(await feedback(page).innerText()).not.toMatch(/XP/);
    for (const hidden of NEVER_SHOWN(c.id))
      expect(await page.locator('body').innerText()).not.toContain(hidden);
  });
}

// ---------------------------------------------------------------------------------------
// Display rules

test('a scenario question shows the scenario in its own box above the question', async ({
  page,
}) => {
  await open(page);
  await choose(page, [2], ['K']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, q('fake1-q04').stem);
  const box = page.getByRole('complementary', { name: 'Scenario' });
  await expect(box).toContainText('FAKE Scenario A');
  await expect(box).toContainText((bank.scenarios[0] as { text: string }).text);
  const boxAt = (await box.boundingBox())!;
  const stemAt = (await stem(page).boundingBox())!;
  expect(boxAt.y + boxAt.height).toBeLessThanOrEqual(stemAt.y);
});

test('multi: Check is enabled only with exactly 2 chosen', async ({ page }) => {
  await open(page);
  await choose(page, [4], ['A']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, multi.stem);
  await expect(page.getByText('Choose 2 (0 chosen)')).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Flux sprocket' }).click();
  await expect(checkButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Zorb flange' }).click();
  await expect(checkButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Park bench' }).click();
  await expect(page.getByText('Choose 2 (3 chosen)')).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  await page.getByRole('button', { name: /Park bench/ }).click();
  await expect(checkButton(page)).toBeEnabled();
});

async function shownOrder(page: Page, seed: number): Promise<string[]> {
  await open(page, seed);
  await choose(page, [1], ['K']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, q('fake1-q01').stem);
  return page.locator('.options button.option').allTextContents();
}

test('choices are shuffled each showing, with no letters', async ({ browser }) => {
  const orders: string[][] = [];
  for (const seed of [1, 2, 3, 1]) {
    const context = await browser.newContext(test.info().project.use);
    orders.push(await shownOrder(await context.newPage(), seed));
    await context.close();
  }
  const choices = texts(q('fake1-q01').choices);
  for (const o of orders) {
    expect([...o].sort()).toEqual([...choices].sort()); // exactly the choice text: no "A." etc.
    for (const t of o) expect(t).not.toMatch(/^\s*\(?[A-Ea-e][.):]/);
  }
  expect(new Set(orders.slice(0, 3).map((o) => o.join('|'))).size).toBeGreaterThan(1);
  expect(orders[3]).toEqual(orders[0]); // the same seed gives the same order (the hook works)
});

test('ordering items and matching options are shuffled too', async ({ browser }) => {
  const seen = new Set<string>();
  for (const seed of [1, 2, 3]) {
    const context = await browser.newContext(test.info().project.use);
    const page = await context.newPage();
    await open(page, seed);
    await choose(page, [1, 2], ['S']);
    await page.getByRole('button', { name: 'Start lesson' }).click();
    await goToCard(page, ordering.stem);
    const order = await rows(page).allTextContents();
    await answerAnything(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await goToCard(page, matching.stem);
    const options = await page.locator('.options button.option').allTextContents();
    seen.add(`${order.join('|')} / ${options.join('|')}`);
    await context.close();
  }
  expect(seen.size).toBeGreaterThan(1);
});

test('studying several areas only draws cards from those areas', async ({ page }) => {
  await open(page);
  await choose(page, [2, 4], ['K', 'A', 'S']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  const seen = await finishLesson(page);
  const expected = bank.questions
    .filter((x) => x.area === 2 || x.area === 4)
    .map((x) => x.stem as string);
  expect([...seen].sort()).toEqual([...expected].sort());
});

// ---------------------------------------------------------------------------------------
// Ordering and matching: every way of answering

async function toOrdering(page: Page) {
  await open(page);
  await choose(page, [2], ['S']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, ordering.stem);
}
const RIGHT_ORDER = (ordering.answer as string[]).map((id) => textOf(ordering.items, id));

/** One touch drag (press, hold, move in steps, lift) from one element's centre to another's. */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', from.x, from.y);
  await page.waitForTimeout(250); // hold: the drag starts after a short press
  for (let i = 1; i <= 12; i++) {
    await touch(
      'touchMove',
      from.x + ((to.x - from.x) * i) / 12,
      from.y + ((to.y - from.y) * i) / 12,
    );
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', to.x, to.y);
  // dnd-kit ignores clicks for 50 ms after a drop (so the drop is not also a tap); a person
  // cannot tap again that fast, the test can.
  await page.waitForTimeout(100);
}
const centre = async (page: Page, locator: ReturnType<Page['locator']>) => {
  const b = (await locator.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('ordering by touch drag, then graded right', async ({ page }) => {
  const csp = watchCsp(page);
  await toOrdering(page);
  for (let i = 0; i < RIGHT_ORDER.length; i++) {
    const now = await rows(page).allTextContents();
    const at = now.indexOf(RIGHT_ORDER[i]!);
    if (at === i) continue;
    await touchDrag(
      page,
      await centre(
        page,
        page.getByRole('button', { name: new RegExp(`^Drag: Item ${at + 1} of`) }),
      ),
      await centre(page, page.getByRole('button', { name: new RegExp(`^Drag: Item ${i + 1} of`) })),
    );
    await expect.poll(async () => (await rows(page).allTextContents())[i]).toBe(RIGHT_ORDER[i]);
  }
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
  expect(csp).toEqual([]);
});

test('ordering by tap-to-place ("Move here"), then graded right', async ({ page }) => {
  await toOrdering(page);
  for (let i = 0; i < RIGHT_ORDER.length; i++) {
    const at = (await rows(page).allTextContents()).indexOf(RIGHT_ORDER[i]!);
    if (at === i) continue;
    await rows(page).nth(at).click();
    await expect(rows(page).nth(at)).toHaveAttribute('aria-pressed', 'true');
    await page.locator('li.order-row').nth(i).getByRole('button', { name: 'Move here' }).click();
    expect((await rows(page).allTextContents())[i]).toBe(RIGHT_ORDER[i]);
  }
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
});

test('ordering with the keyboard only, then graded right', async ({ page }) => {
  await toOrdering(page);
  for (let i = 0; i < RIGHT_ORDER.length; i++) {
    let at = (await rows(page).allTextContents()).indexOf(RIGHT_ORDER[i]!);
    while (at > i) {
      await tabTo(page, new RegExp(`^Item ${at + 1} of \\d+: .*, move up$`));
      await page.keyboard.press('Enter');
      at--;
    }
  }
  expect(await rows(page).allTextContents()).toEqual(RIGHT_ORDER);
  // The drag handle works from the keyboard too (Space, arrow, Space): move row 1 down one.
  await tabTo(page, /^Drag: Item 1 of/);
  // dnd-kit starts listening for the arrow keys one tick after the pick-up.
  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await rows(page).allTextContents())[1]).toBe(RIGHT_ORDER[0]);
  await tabTo(page, /^Item 2 of \d+: .*, move up$/);
  await page.keyboard.press('Enter');
  await tabTo(page, /^Check$/);
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
});

async function toMatching(page: Page) {
  await open(page);
  await choose(page, [1], ['S']);
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await goToCard(page, matching.stem);
}
const PAIRS = Object.entries(matching.answer as Record<string, string>).map(([p, o]) => [
  textOf(matching.prompts, p),
  textOf(matching.options, o),
]) as [string, string][];
const promptButton = (page: Page, text: string) =>
  page.locator('.match-prompts').getByRole('button', { name: new RegExp(`^${text}`) });
const poolOption = (page: Page, text: string) =>
  page.getByRole('group', { name: 'Options' }).getByRole('button', { name: text, exact: true });

test('matching by touch drag, then graded right', async ({ page }) => {
  const csp = watchCsp(page);
  await toMatching(page);
  for (const [p, o] of PAIRS) {
    await touchDrag(
      page,
      await centre(page, poolOption(page, o)),
      await centre(page, promptButton(page, p)),
    );
    await expect(promptButton(page, p)).toContainText(`${o} (tap to undo)`);
    await expect(poolOption(page, o)).toHaveCount(0); // a used option leaves the pool
  }
  await expect(poolOption(page, 'Sings to widgets')).toBeVisible(); // the extra one stays
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
  expect(csp).toEqual([]);
});

test('matching: a drag let go away from every prompt pairs nothing (audit L8)', async ({
  page,
}) => {
  await toMatching(page);
  const [[p1, o1], [, o2]] = PAIRS as [[string, string], [string, string]];
  await touchDrag(
    page,
    await centre(page, poolOption(page, o1)),
    await centre(page, promptButton(page, p1)),
  );
  await expect(promptButton(page, p1)).toContainText(`${o1} (tap to undo)`);
  // Drag the next option and let go on the question text, not on a prompt.
  await touchDrag(page, await centre(page, poolOption(page, o2)), await centre(page, stem(page)));
  await expect(poolOption(page, o2)).toBeVisible(); // still in the pool
  await expect(promptButton(page, p1)).toContainText(`${o1} (tap to undo)`); // pair kept
  await expect(page.locator('.match-prompts')).not.toContainText(o2);
});

test('matching by tap-tap, with undo, then graded right', async ({ page }) => {
  await toMatching(page);
  // A wrong pair first, then undo it by tapping it.
  await promptButton(page, 'Sprocketron').click();
  await poolOption(page, 'Bends flanges').click();
  await expect(promptButton(page, 'Sprocketron')).toContainText('Bends flanges (tap to undo)');
  await promptButton(page, 'Sprocketron').click();
  await expect(poolOption(page, 'Bends flanges')).toBeVisible();
  for (const [p, o] of PAIRS) {
    await promptButton(page, p).click();
    await expect(checkButton(page)).toBeDisabled();
    await poolOption(page, o).click();
  }
  await expect(checkButton(page)).toBeEnabled();
  await checkButton(page).click();
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
});

test('matching with the keyboard only, then graded right', async ({ page }) => {
  await toMatching(page);
  for (const [p, o] of PAIRS) {
    await tabTo(page, new RegExp(`^${p}`));
    await page.keyboard.press('Enter');
    await tabTo(page, new RegExp(`^${o}$`));
    await page.keyboard.press('Enter');
    await expect(promptButton(page, p)).toContainText(`${o} (tap to undo)`);
  }
  await tabTo(page, /^Check$/);
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toContainText('✓ Correct! +3 XP');
});
