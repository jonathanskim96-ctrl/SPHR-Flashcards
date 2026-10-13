// @vitest-environment jsdom
// Question text is data. Everything a card shows must come out as literal text, never as
// markup: no <img>, no <script>, no event handlers (CLAUDE.md §2).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { openSession } from '../data/session';
import { normalizeBank } from '../domain/bank';
import { seededRng } from '../domain/shuffle';
import { Clock, testEnv, USER } from '../../tests/dataHelpers';
import { FakeServer } from '../../tests/fakeServer';
import { harness } from '../../tests/uiHarness';
import { rawSample, TZ } from '../../tests/helpers';
import { Lesson } from './Lesson';

afterEach(cleanup);

const IMG = '<img src=x onerror="window.__xss=1">';
const SCRIPT = '"><script>window.__xss=1</script>';
const PAYLOADS = [IMG, SCRIPT, '<svg onload=alert(1)>', "'; DROP TABLE questions; --"];

/** Puts a payload in every user-visible text field of the question and its scenario. */
function poisoned(id: string) {
  const raw = rawSample();
  const bad = (field: string, i = 0) => `${PAYLOADS[i % PAYLOADS.length]} ${field}`;
  const q = raw.questions.find((x) => x.id === id) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  q.stem = bad('stem', 0);
  q.explanation = bad('explanation', 1);
  if (q.displayAnswer) q.displayAnswer = bad('displayAnswer', 2);
  for (const key of ['choices', 'items', 'prompts', 'options'])
    q[key]?.forEach((c: { text: string }, i: number) => (c.text = bad(`${key}${i}`, i)));
  if (q.scenarioId) {
    const sc = (raw.scenarios as Record<string, any>[]).find((s) => s.id === q.scenarioId)!; // eslint-disable-line @typescript-eslint/no-explicit-any
    sc.title = bad('scenario title', 3);
    sc.text = bad('scenario text', 0);
  }
  const r = normalizeBank(raw);
  if (!r.ok || r.dropped.length) throw new Error('poisoned bank did not normalize');
  return { raw, bank: r.bank, question: r.bank.questions.find((x) => x.id === id)! };
}

async function show(id: string) {
  const { raw, bank, question } = poisoned(id);
  const clock = new Clock();
  const session = await openSession({
    userId: USER,
    backend: new FakeServer().backend(),
    factory: new IDBFactory(),
    env: testEnv(clock).env,
    deviceTimeZone: TZ,
    storage: undefined,
    loadBundled: async () => raw,
  });
  const view = render(
    <Lesson
      session={session}
      bank={bank}
      env={{ now: () => clock.now, rng: seededRng(1), installed: true }}
      mode="lesson"
      initial={[question]}
      onEnd={() => {}}
      onQuit={() => {}}
    />,
  );
  return { view, question, user: userEvent.setup() };
}

function expectLiteral(container: HTMLElement, tags = 'img, script, svg, iframe') {
  expect(container.querySelector(`${tags}, [onerror], [onload]`)).toBeNull();
  expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
}

describe('card text is rendered as literal text', () => {
  for (const id of ['fake1-q03', 'fake2-q01', 'fake2-q02', 'fake2-q08', 'fake2-q10', 'fake2-q11']) {
    it(`${id}: stem, choices, scenario and explanation`, async () => {
      const { view, question, user } = await show(id);
      expect(view.container.textContent).toContain(IMG);
      if (question.scenarioId) expect(view.container.textContent).toContain('scenario title');
      expectLiteral(view.container);
      // Answer wrongly (or just Check, for ordering) to reach the feedback text.
      if (question.type === 'mc')
        await user.click(screen.getAllByRole('button').find((b) => b.className === 'option')!);
      if (question.type === 'multi')
        for (const b of screen
          .getAllByRole('button')
          .filter((b) => b.className === 'option')
          .slice(2, 4))
          await user.click(b);
      if (question.type === 'numeric' || question.type === 'text')
        await user.type(screen.getByLabelText(/Your answer/), 'zzz');
      if (question.type === 'matching')
        for (let i = 0; i < question.prompts.length; i++) {
          await user.click(
            screen
              .getAllByRole('button')
              .find((b) => b.className.startsWith('match-prompt') && b.textContent!.endsWith('…'))!,
          );
          await user.click(
            screen.getAllByRole('button').filter((b) => b.className === 'option')[0]!,
          );
        }
      await user.click(screen.getByRole('button', { name: 'Check' }));
      const fb = await screen.findByRole('status', { name: 'Feedback' });
      if (fb.textContent!.includes('Not quite')) expect(fb.textContent).toContain('explanation');
      expectLiteral(view.container);
    });
  }

  it('area names and question text on Home and in Settings notices are literal too', async () => {
    await harness({
      bank: (() => {
        const raw = rawSample();
        (raw.areas as { name: string }[])[0]!.name = IMG;
        return raw;
      })(),
    });
    const area = await screen.findByRole('button', { name: new RegExp('1\\. ') });
    expect(area.textContent).toContain(IMG);
    expectLiteral(document.body, 'img, script, iframe'); // the goal ring is a real <svg>
  });
});
