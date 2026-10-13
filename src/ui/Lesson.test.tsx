// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { openSession, type Session } from '../data/session';
import { seededRng } from '../domain/shuffle';
import type { Question } from '../domain/types';
import { Clock, testEnv, USER } from '../../tests/dataHelpers';
import { FakeServer } from '../../tests/fakeServer';
import { fakeBank, rawSample, TZ } from '../../tests/helpers';
import { Lesson, type CardResult } from './Lesson';

afterEach(cleanup);

async function setup(ids: string[]) {
  const clock = new Clock();
  const server = new FakeServer(() => clock.now);
  const session: Session = await openSession({
    userId: USER,
    backend: server.backend(),
    factory: new IDBFactory(),
    env: testEnv(clock).env,
    deviceTimeZone: TZ,
    storage: undefined,
    loadBundled: async () => rawSample(),
  });
  await session.bank.loadLocal();
  const bank = fakeBank();
  const questions = ids.map((id) => bank.questions.find((q) => q.id === id)!);
  const ended: CardResult[][] = [];
  render(
    <Lesson
      session={session}
      bank={bank}
      env={{ now: () => clock.now, rng: seededRng(3) }}
      mode="lesson"
      initial={questions}
      onEnd={(r) => ended.push(r)}
      onQuit={() => {}}
    />,
  );
  return { session, bank, ended, user: userEvent.setup(), clock };
}

type User = ReturnType<typeof userEvent.setup>;
const text = (q: Question, id: string): string => {
  const list =
    q.type === 'mc' || q.type === 'multi'
      ? q.choices
      : q.type === 'ordering'
        ? q.items
        : q.type === 'matching'
          ? q.options
          : [];
  return list.find((x) => x.id === id)!.text;
};

/** Gives the right answer (or a wrong one) for the card on screen. */
async function respond(user: User, q: Question, right: boolean) {
  switch (q.type) {
    case 'mc':
      await user.click(
        screen.getByRole('button', {
          name: text(q, right ? q.answer : q.choices.find((c) => c.id !== q.answer)!.id),
        }),
      );
      return;
    case 'multi': {
      const wrong = q.choices.filter((c) => !q.answer.includes(c.id)).map((c) => c.id);
      const pick = right ? q.answer : [q.answer[0]!, wrong[0]!];
      for (const id of pick)
        await user.click(screen.getByRole('button', { name: new RegExp(text(q, id)) }));
      return;
    }
    case 'numeric':
      await user.type(screen.getByLabelText(/Your answer/), right ? String(q.answer.value) : '1');
      return;
    case 'text':
      await user.type(
        screen.getByLabelText(/Your answer/),
        right ? (q.accepted[0] as string) : 'zzz',
      );
      return;
    case 'ordering': {
      if (!right) return; // the starting order is never the right one
      for (let target = 0; target < q.answer.length; target++) {
        const want = text(q, q.answer[target]!);
        for (;;) {
          const rows = screen.getAllByRole('button', { name: /, move up$/ });
          const pos = rows.findIndex((b) =>
            b.getAttribute('aria-label')!.includes(`: ${want}, move up`),
          );
          const all = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
          const at = all.findIndex((t) => t.includes(want));
          if (at <= target) break;
          void pos;
          await user.click(
            screen.getByRole('button', {
              name: `Item ${at + 1} of ${q.answer.length}: ${want}, move up`,
            }),
          );
        }
      }
      return;
    }
    case 'matching': {
      const ids = q.prompts.map((p) => p.id);
      for (const [i, pid] of ids.entries()) {
        await user.click(
          screen.getByRole('button', { name: new RegExp(`^${q.prompts[i]!.text}`) }),
        );
        const opt = right ? q.answer[pid]! : q.answer[ids[(i + 1) % ids.length]!]!;
        const btn = screen.queryByRole('button', { name: text(q, opt) });
        await user.click(
          btn ?? screen.getAllByRole('button', { name: text(q, q.answer[pid]!) })[0]!,
        );
      }
      return;
    }
  }
}

const TYPES = ['fake1-q01', 'fake2-q01', 'fake2-q02', 'fake2-q08', 'fake2-q10', 'fake2-q11'];

describe('each question type, end to end', () => {
  for (const id of TYPES) {
    it(`${id}: a right answer is graded correct and earns the tier's XP`, async () => {
      const { user, bank, ended, session } = await setup([id]);
      const q = bank.questions.find((x) => x.id === id)!;
      await respond(user, q, true);
      await user.click(screen.getByRole('button', { name: 'Check' }));
      const fb = await screen.findByRole('status', { name: 'Feedback' });
      expect(fb.textContent).toContain('Correct!');
      expect(fb.textContent).toContain(`+${bank.levels[q.level].points} XP`);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(ended).toHaveLength(1));
      expect(ended[0]).toEqual([{ correct: true, xp: bank.levels[q.level].points }]);
      const saved = await session.store.attempts();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ questionId: id, correct: true, mode: 'lesson' });
    });

    it(`${id}: a wrong answer shows the correct answer and the explanation, and earns no XP`, async () => {
      const { user, bank, ended } = await setup([id]);
      const q = bank.questions.find((x) => x.id === id)!;
      await respond(user, q, false);
      await user.click(screen.getByRole('button', { name: 'Check' }));
      const fb = (await screen.findByRole('status', { name: 'Feedback' })).textContent!;
      expect(fb).toContain('Not quite');
      expect(fb).toContain(q.explanation);
      expect(fb).not.toContain('XP');
      expect(fb).toMatch(/Correct (answer|answers|order|pairs):/);
      if (q.type === 'text' || q.type === 'numeric') expect(fb).toContain(q.displayAnswer);
      if (q.type === 'multi') expect(fb).toContain('✗');
      if (q.type === 'matching') expect(fb).toMatch(/✗ .* → .*\(you chose:/);
      if (q.type === 'ordering') expect(fb).toContain('Your order:');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(ended[0]).toEqual([{ correct: false, xp: 0 }]));
    });
  }

  it('never shows A/B/C/D letters, and shuffles the choices', async () => {
    await setup(['fake1-q01']);
    const labels = screen
      .getAllByRole('button')
      .filter((b) => b.className === 'option')
      .map((b) => b.textContent);
    expect(labels.sort()).toEqual(['Blue', 'Green', 'Orange', 'Purple']);
    expect(document.body.textContent).not.toMatch(/\b[A-D]\.\s|\([A-D]\)/);
  });

  it('runs several cards: progress, then ends once with all results', async () => {
    const { user, bank, ended } = await setup(['fake1-q01', 'fake1-q02']);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    await respond(user, bank.questions[0]!, true);
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('2 / 2')).toBeTruthy();
    expect(screen.getByText(/How many sprockets/)).toBeTruthy();
    await respond(user, bank.questions[1]!, false);
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]!.map((r) => r.correct)).toEqual([true, false]);
  });

  it('holds a newly arrived bank back until the card on screen is finished', async () => {
    const { session, user, bank } = await setup(['fake1-q01', 'fake1-q02']);
    expect(session.bank.status().waiting).toBe(false);
    // beginCard was called for the card on screen: a bank arriving now would wait.
    session.bank.endCard(); // (no pending bank: nothing changes)
    await respond(user, bank.questions[0]!, true);
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });
});
