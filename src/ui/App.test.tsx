// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, SIGNED_OUT_ELSEWHERE } from '../App';
import { deleteUserDb } from '../data/db';
import { Clock, USER } from '../../tests/dataHelpers';
import { FakeServer } from '../../tests/fakeServer';
import { attempt, at, fakeBank, q } from '../../tests/helpers';
import { harness, PASSWORD } from '../../tests/uiHarness';
import type { AppDeps } from './deps';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const home = () => screen.findByRole('button', { name: 'Start lesson' });

/** Answers the card on screen correctly or wrongly, by its stem. */
async function answerCard(user: ReturnType<typeof userEvent.setup>, stem: string, right: boolean) {
  await screen.findByText(stem);
  const pick = right ? 'Blue' : 'Green';
  await user.click(screen.getByRole('button', { name: pick }));
  await user.click(screen.getByRole('button', { name: 'Check' }));
}

describe('sign in', () => {
  it('shows the sign-in form with no sign-up link when signed out', async () => {
    await harness({ signedIn: false });
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByText(/sign.?up|create account|register/i)).toBeNull();
  });

  it('explains a wrong password, and an empty form', async () => {
    const { user } = await harness({ signedIn: false });
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter your email and password.',
    );
    await user.type(screen.getByLabelText('Email'), 'm@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        "That email and password don't match",
      ),
    );
  });

  it('signs in and shows Home', async () => {
    const { user } = await harness({ signedIn: false });
    await user.type(await screen.findByLabelText('Email'), 'm@example.com');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await home()).toBeTruthy();
  });

  it('shows why it cannot check the saved login', async () => {
    const clock = new Clock();
    const deps: AppDeps = {
      auth: {
        currentUser: async () => {
          throw new Error('storage is blocked');
        },
        signIn: async () => ({ ok: false, error: 'x' }),
        signOut: async () => ({ error: null }),
      },
      backend: new FakeServer().backend(),
      env: { now: () => clock.now, rng: Math.random, installed: true },
    };
    render(<App makeDeps={() => deps} />);
    expect((await screen.findByRole('alert')).textContent).toContain('storage is blocked');
  });

  it('shows a missing configuration instead of a blank page', () => {
    render(
      <App
        makeDeps={() => {
          throw new Error('The app is not configured: the Supabase URL or key is missing.');
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('not configured');
  });

  it('shows an error when the phone cannot open her data', async () => {
    const h = await harness({ signedIn: false });
    cleanup();
    const clock = new Clock();
    const deps: AppDeps = {
      auth: {
        currentUser: async () => ({ id: USER, email: 'm@example.com' }),
        signIn: async () => ({ ok: false, error: 'x' }),
        signOut: async () => ({ error: null }),
      },
      backend: h.server.backend(),
      env: { now: () => clock.now, rng: Math.random, installed: true },
      sessionOptions: { factory: {} as IDBFactory },
    };
    render(<App makeDeps={() => deps} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open your data');
  });
});

describe('signed out in another tab (audit L1)', () => {
  it('goes to the sign-in screen with a message instead of saving into removed data', async () => {
    const { factory } = await harness();
    await home();
    await deleteUserDb(USER, factory); // what sign-out in another tab does
    expect(await screen.findByText(SIGNED_OUT_ELSEWHERE, { exact: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('Home', () => {
  it('shows XP, the goal ring, five areas with three tiers each and the Mistakes count', async () => {
    await harness();
    await home();
    expect(screen.getByText('0 XP')).toBeTruthy();
    expect(screen.getByRole('img', { name: "Today's goal: 0 of 30 XP" })).toBeTruthy();
    expect(document.querySelectorAll('progress')).toHaveLength(15);
    // No Mistakes cards to practise: no Mistakes button (audit M2).
    expect(screen.queryByRole('button', { name: /^Mistakes/ })).toBeNull();
    for (let n = 1; n <= 5; n++)
      expect(
        screen.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area ${n}`) }),
      ).toBeTruthy();
    expect(screen.queryByText(/streak|due today|countdown/i)).toBeNull();
  });

  it('selects areas and tiers, never down to none, and remembers the choice', async () => {
    const { user } = await harness();
    await home();
    const area1 = screen.getByRole('button', { name: /1\. FAKE Area 1/ });
    expect(area1.getAttribute('aria-pressed')).toBe('true');
    for (let n = 2; n <= 5; n++)
      await user.click(screen.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }));
    await user.click(area1); // the last one stays on
    expect(area1.getAttribute('aria-pressed')).toBe('true');
    const tiers = screen.getByRole('group', { name: 'Tiers' });
    for (const t of ['A', 'S'])
      await user.click(within(tiers).getByRole('button', { name: new RegExp(`^(✓ )?${t} ·`) }));
    await user.click(within(tiers).getByRole('button', { name: /K · Knowledge/ })); // last tier stays on
    expect(JSON.parse(localStorage.getItem('sphr-selection')!)).toEqual({
      areas: [1],
      tiers: ['K'],
    });
  });

  it('starts from a remembered choice and survives unreadable storage', async () => {
    localStorage.setItem('sphr-selection', JSON.stringify({ areas: [2], tiers: ['K', 'S'] }));
    await harness();
    await home();
    expect(
      screen.getByRole('button', { name: /2\. FAKE Area 2/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /1\. FAKE Area 1/ }).getAttribute('aria-pressed'),
    ).toBe('false');
    cleanup();
    localStorage.setItem('sphr-selection', '{not json');
    await harness();
    await home();
    expect(
      screen.getByRole('button', { name: /1\. FAKE Area 1/ }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('keeps saying Loading while the questions are unreadable, and Settings explains', async () => {
    await harness({ bank: { schemaVersion: 2 } });
    expect(await screen.findByText('Loading questions…')).toBeTruthy();
  });

  it('shows the reason when no copy of the questions can be loaded at all', async () => {
    await harness({ bundledFails: true, offline: true });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load the questions',
    );
  });
});

describe('a lesson', () => {
  async function startArea1K(user: ReturnType<typeof userEvent.setup>) {
    // Area 1, tier K only: exactly one card (fake1-q01).
    await home();
    for (let n = 2; n <= 5; n++)
      await user.click(screen.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }));
    const tiers = screen.getByRole('group', { name: 'Tiers' });
    await user.click(within(tiers).getByRole('button', { name: /A · Application/ }));
    await user.click(within(tiers).getByRole('button', { name: /S · Synthesis/ }));
    await user.click(screen.getByRole('button', { name: 'Start lesson' }));
  }

  it('grades a right answer, shows +XP, saves it, then ends with the summary', async () => {
    const { user, server, clock } = await harness();
    await startArea1K(user);
    await answerCard(user, 'FAKE: Which colour is the test widget?', true);
    expect((await screen.findByRole('status', { name: 'Feedback' })).textContent).toContain(
      'Correct!',
    );
    expect(screen.getByRole('status', { name: 'Feedback' }).textContent).toContain('+1 XP');
    expect(screen.queryByText(/made-up correct value/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Lesson complete')).toBeTruthy();
    expect(screen.getByText('+1 XP')).toBeTruthy();
    expect(screen.getByText('1 of 1 correct')).toBeTruthy();
    // Saved on the phone and sent to the server by the debounced sync.
    await vi.waitFor(() => expect(server.rows).toHaveLength(0));
    clock.tick(3000);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('1 XP')).toBeTruthy();
  });

  it('shows the right answer and the explanation after a wrong one, with no XP', async () => {
    const { user } = await harness();
    await startArea1K(user);
    await answerCard(user, 'FAKE: Which colour is the test widget?', false);
    const fb = await screen.findByRole('status', { name: 'Feedback' });
    expect(fb.textContent).toContain('Not quite');
    expect(fb.textContent).toContain('Correct answer: Blue');
    expect(fb.textContent).toContain('FAKE: Blue is the made-up correct value.');
    expect(fb.textContent).not.toContain('XP');
    expect(fb.textContent).not.toContain('is not the test value'); // wrongReasons are never shown
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Keep going' }));
    // The wrong card is not repeated today; Mistakes can't be practised until tomorrow either.
    expect(await screen.findByText('All caught up')).toBeTruthy();
  });

  it('keeps Check off until something is chosen and quits back to Home', async () => {
    const { user } = await harness();
    await startArea1K(user);
    const check = await screen.findByRole('button', { name: 'Check' });
    expect(check.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Quit lesson' }));
    expect(await home()).toBeTruthy();
  });

  it('shows the scenario in its own box above the stem', async () => {
    const { user } = await harness();
    await home();
    for (const n of [1, 3, 4, 5])
      await user.click(screen.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }));
    const tiers = screen.getByRole('group', { name: 'Tiers' });
    await user.click(within(tiers).getByRole('button', { name: /A · Application/ }));
    await user.click(within(tiers).getByRole('button', { name: /S · Synthesis/ }));
    await user.click(screen.getByRole('button', { name: 'Start lesson' })); // area 2, K: fake1-q04 uses a scenario
    const box = await screen.findByRole('complementary', { name: 'Scenario' });
    expect(box.textContent).toContain('FAKE');
  });

  it('shows an error and stays on the card when the answer cannot be saved', async () => {
    const { user } = await harness();
    await startArea1K(user);
    await screen.findByText('FAKE: Which colour is the test widget?');
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    // A broken phone database: the save fails, and she is told.
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('disk full');
    });
    await user.click(screen.getByRole('button', { name: 'Check' }));
    spy.mockRestore();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your answer could not be saved',
    );
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check' })); // she can try again
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});

describe('All caught up', () => {
  const area1K = async (user: ReturnType<typeof userEvent.setup>) => {
    await home();
    for (let n = 2; n <= 5; n++)
      await user.click(screen.getByRole('button', { name: new RegExp(`${n}\\. FAKE Area`) }));
    const tiers = screen.getByRole('group', { name: 'Tiers' });
    await user.click(within(tiers).getByRole('button', { name: /A · Application/ }));
    await user.click(within(tiers).getByRole('button', { name: /S · Synthesis/ }));
  };
  const q01 = () => q(fakeBank(), 'fake1-q01');

  it('offers Study ahead (and no Mistakes) when cards are scheduled for later', async () => {
    const { user } = await harness({
      seed: [attempt(q01(), true, at('2026-10-11')), attempt(q01(), true, at('2026-10-12'))],
    });
    await area1K(user);
    await user.click(screen.getByRole('button', { name: 'Start lesson' }));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Practice Mistakes/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Study ahead' }));
    await screen.findByText('FAKE: Which colour is the test widget?'); // an early review counts
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await home()).toBeTruthy();
  });

  it('offers Practice Mistakes for a card that is not due yet', async () => {
    const { user } = await harness({
      seed: [attempt(q01(), false, at('2026-10-10')), attempt(q01(), true, at('2026-10-11'))],
    });
    await area1K(user);
    expect(screen.getByRole('button', { name: 'Mistakes (1)' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start lesson' }));
    await user.click(await screen.findByRole('button', { name: /Practice Mistakes \(1\)/ }));
    await screen.findByText('FAKE: Which colour is the test widget?');
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Lesson complete')).toBeTruthy();
  });

  it('a card answered wrong today: no Mistakes button and no Practice Mistakes loop (audit M2)', async () => {
    const { user } = await harness({ seed: [attempt(q01(), false, at('2026-10-13', 19))] });
    await area1K(user);
    expect(screen.queryByRole('button', { name: /^Mistakes/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start lesson' }));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Practice Mistakes/ })).toBeNull();
  });

  it('after a lesson, Keep going with nothing left shows All caught up and Back to Home works', async () => {
    const { user } = await harness({ seed: [attempt(q01(), true, at('2026-10-12'))] });
    await area1K(user);
    await user.click(screen.getByRole('button', { name: 'Start lesson' })); // q01 is due today
    await answerCard(user, 'FAKE: Which colour is the test widget?', true);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Keep going' }));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to Home' }));
    expect(await home()).toBeTruthy();
  });
});
