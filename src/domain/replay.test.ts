import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { answerFp } from './bank';
import { addDays, localDateOf } from './dates';
import { mergeAttempts, replay, sortAttempts, stateOf } from './replay';
import { NEW_CARD } from './schedule';
import { totalXp } from './xp';
import type { Attempt, Bank } from './types';
import { at, attempt, fakeBank, q, TZ, uuid } from '../../tests/helpers';

const EXAM = '2026-12-15';
const settings = { examDate: EXAM, timeZone: TZ };

describe('replay', () => {
  const bank = fakeBank();
  const a = q(bank, 'fake1-q01');
  const b = q(bank, 'fake1-q02');

  it('builds state from attempts in time order', () => {
    const atts = [attempt(a, true, at('2026-10-02')), attempt(a, true, at('2026-10-01'))];
    const s = replay(atts, bank, settings).get(a.id)!;
    expect(s).toMatchObject({
      box: 2,
      firstSeen: '2026-10-01',
      lastAnswered: '2026-10-02',
      due: '2026-10-05',
    });
  });

  it('ignores unknown questions and duplicate attempt ids', () => {
    const one = attempt(a, true, at('2026-10-01'));
    const ghost = { ...attempt(a, true, at('2026-10-01')), questionId: 'gone-q01' };
    const states = replay([one, one, ghost], bank, settings);
    expect(states.get(a.id)!.box).toBe(1);
    expect(states.has('gone-q01')).toBe(false);
  });

  it('a stem-only edit keeps the card; an answer change resets only that card', () => {
    const atts = [attempt(a, true, at('2026-10-01')), attempt(b, true, at('2026-10-01'))];
    const reworded: Bank = {
      ...bank,
      questions: bank.questions.map((x) =>
        x.id === a.id ? { ...x, stem: 'FAKE: new wording', revision: 2 } : x,
      ),
    };
    expect(replay(atts, reworded, settings).get(a.id)!.box).toBe(1);
    const changed: Bank = {
      ...bank,
      questions: bank.questions.map((x) =>
        x.id === a.id && x.type === 'mc' ? { ...x, answer: 'B' } : x,
      ),
    };
    const s = replay(atts, changed, settings);
    expect(stateOf(s, a.id)).toEqual(NEW_CARD);
    expect(s.get(b.id)!.box).toBe(1);
    // XP from the reset card's attempts still counts.
    expect(totalXp(atts)).toBe(3);
  });

  it('keeps state for retired questions', () => {
    const retired = q(bank, 'fake2-q09');
    expect(
      replay([attempt(retired, true, at('2026-10-01'))], bank, settings).get(retired.id)!.box,
    ).toBe(1);
  });

  it('sorts equal timestamps by id', () => {
    const x = { ...attempt(a, true, at('2026-10-01')), id: uuid(900) };
    const y = { ...attempt(a, false, at('2026-10-01')), id: uuid(901) };
    expect(sortAttempts([y, x]).map((t) => t.id)).toEqual([x.id, y.id]);
    expect(sortAttempts([x, y]).map((t) => t.id)).toEqual([x.id, y.id]);
    expect(sortAttempts([x, { ...x }]).length).toBe(2);
  });
});

// ---- Property tests (fuzz), 1,000 cases each ----

const bank = fakeBank();
const ids = bank.questions.map((x) => x.id);
const START = Date.parse('2026-09-01T00:00:00Z');

/** Random answer histories: distinct timestamps across ~6 months, crossing the exam date. */
const historyArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 180 * 24 * 60 }), { minLength: 0, maxLength: 60 })
  .chain((minutes) =>
    fc.tuple(
      fc.constant(minutes),
      fc.array(fc.tuple(fc.integer({ min: 0, max: ids.length - 1 }), fc.boolean()), {
        minLength: minutes.length,
        maxLength: minutes.length,
      }),
    ),
  )
  .map(([minutes, picks]) =>
    minutes.map((m, i) => {
      const [qi, correct] = picks[i]!;
      const question = q(bank, ids[qi]!);
      return {
        ...attempt(question, correct, new Date(START + m * 60_000).toISOString()),
        id: uuid(10_000 + i),
      };
    }),
  );
const examArb = fc.integer({ min: 0, max: 200 }).map((d) => addDays('2026-09-01', d));
const PROPS = { numRuns: 1000, seed: 20261013 };

describe('replay properties', () => {
  it('box stays 0-5, due ≥ lastAnswered + 1, and never after the exam when answered before it', () => {
    fc.assert(
      fc.property(historyArb, examArb, (atts, examDate) => {
        for (const s of replay(atts, bank, { examDate, timeZone: TZ }).values()) {
          expect(s.box).toBeGreaterThanOrEqual(0);
          expect(s.box).toBeLessThanOrEqual(5);
          expect(s.due! >= addDays(s.lastAnswered!, 1)).toBe(true);
          if (s.lastAnswered! < examDate) expect(s.due! <= examDate).toBe(true);
        }
      }),
      PROPS,
    );
  });

  it('inMistakes ⇔ the last answer was wrong, or fewer than 2 correct since the last wrong', () => {
    fc.assert(
      fc.property(historyArb, (atts) => {
        const states = replay(atts, bank, settings);
        const byQ = new Map<string, Attempt[]>();
        for (const t of sortAttempts(atts))
          byQ.set(t.questionId, [...(byQ.get(t.questionId) ?? []), t]);
        for (const [id, list] of byQ) {
          const lastWrong = list.map((t) => t.correct).lastIndexOf(false);
          const correctSince = lastWrong === -1 ? 0 : list.length - 1 - lastWrong;
          const expected = lastWrong !== -1 && correctSince < 2;
          expect(states.get(id)!.inMistakes).toBe(expected);
        }
      }),
      PROPS,
    );
  });

  it('is deterministic and independent of input order', () => {
    fc.assert(
      fc.property(historyArb, fc.integer(), (atts, seed) => {
        const shuffled = fc.sample(fc.shuffledSubarray(atts, { minLength: atts.length }), {
          numRuns: 1,
          seed,
        })[0]!;
        expect(replay(shuffled, bank, settings)).toEqual(replay(atts, bank, settings));
      }),
      PROPS,
    );
  });

  it('replaying a union is the same in either merge order (and with overlap)', () => {
    fc.assert(
      fc.property(
        historyArb,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (atts, i, j) => {
          const x = atts.slice(0, Math.max(i, j));
          const y = atts.slice(Math.min(i, j));
          const ab = mergeAttempts(x, y);
          const ba = mergeAttempts(y, x);
          expect(ab.map((t) => t.id)).toEqual(ba.map((t) => t.id));
          expect(ab).toHaveLength(atts.length);
          expect(replay(ab, bank, settings)).toEqual(replay(ba, bank, settings));
          expect(replay(ab, bank, settings)).toEqual(replay(atts, bank, settings));
        },
      ),
      PROPS,
    );
  });

  it('XP total equals the sum of tier points of correct attempts', () => {
    fc.assert(
      fc.property(historyArb, (atts) => {
        const expected = atts
          .filter((t) => t.correct)
          .reduce((sum, t) => sum + bank.levels[q(bank, t.questionId).level].points, 0);
        expect(totalXp(atts)).toBe(expected);
      }),
      PROPS,
    );
  });

  it('firstSeen and lastAnswered bracket every attempt', () => {
    fc.assert(
      fc.property(historyArb, (atts) => {
        const states = replay(atts, bank, settings);
        for (const t of atts) {
          const s = states.get(t.questionId)!;
          expect(t.answerFp).toBe(answerFp(q(bank, t.questionId)));
          expect(s.firstSeen! <= localDateOf(t.answeredAt, TZ)).toBe(true);
          expect(s.lastAnswered! >= localDateOf(t.answeredAt, TZ)).toBe(true);
        }
      }),
      PROPS,
    );
  });
});
