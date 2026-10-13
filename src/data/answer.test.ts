import { describe, expect, it } from 'vitest';
import { fakeBank, q } from '../../tests/helpers';
import { answerFp } from '../domain/bank';
import { validateAttempt } from '../domain/validate';
import { buildAttempt } from './answer';

const bank = fakeBank();
const now = new Date('2026-10-13T20:00:00.000Z');

describe('buildAttempt', () => {
  it('grades, adds the tier XP and the answer fingerprint', () => {
    const question = q(bank, 'fake1-q03'); // S tier, answer B
    const a = buildAttempt({
      bank,
      question,
      response: { type: 'mc', choice: 'B' },
      mode: 'ahead',
      now,
    });
    expect(a).toMatchObject({
      questionId: 'fake1-q03',
      revision: question.revision,
      answerFp: answerFp(question),
      correct: true,
      xp: 3,
      mode: 'ahead',
      answeredAt: '2026-10-13T20:00:00.000Z',
    });
    expect(validateAttempt(a, now.getTime()).ok).toBe(true);
    const wrong = buildAttempt({
      bank,
      question,
      response: { type: 'mc', choice: 'A' },
      mode: 'lesson',
      now,
      id: 'x',
    });
    expect(wrong).toMatchObject({ id: 'x', correct: false, xp: 0 });
  });

  it('makes a fresh lowercase uuid for every answer', () => {
    const question = q(bank, 'fake1-q01');
    const r = { type: 'mc', choice: 'A' } as const;
    const x = buildAttempt({ bank, question, response: r, mode: 'lesson', now });
    const y = buildAttempt({ bank, question, response: r, mode: 'lesson', now });
    expect(x.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(x.id).not.toBe(y.id);
  });
});
