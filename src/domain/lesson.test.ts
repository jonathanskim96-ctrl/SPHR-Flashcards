import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildLesson, newCardsToday, refreshLesson, type Selection } from './lesson';
import { replay } from './replay';
import type { Attempt, Bank, CardState, Level, Mode, Question } from './types';
import { AREA_IDS, LEVELS } from './types';
import { at, attempt, fakeBank, q, TZ } from '../../tests/helpers';
import { applyAnswer, NEW_CARD } from './schedule';
import { addDays } from './dates';

const EXAM = '2026-12-15';
const ALL: Selection = { areas: [1, 2, 3, 4, 5], tiers: ['K', 'A', 'S'] };
const settings = { newPerDay: 15, lessonSize: 10 };

/** A bank of n active mc questions spread over areas and tiers (built from the fake bank). */
function bigBank(n: number): Bank {
  const base = fakeBank();
  const proto = q(base, 'fake1-q01', 'mc');
  const questions: Question[] = Array.from({ length: n }, (_, i) => ({
    ...proto,
    id: `big-q${String(i).padStart(3, '0')}`,
    area: AREA_IDS[i % 5]!,
    level: LEVELS[Math.floor(i / 5) % 3]!,
  }));
  return { ...base, questions: [...base.questions, ...questions] };
}

const lesson = (
  bank: Bank,
  states: Map<string, CardState>,
  today: string,
  mode: Mode = 'lesson',
  selection = ALL,
  s = settings,
) => buildLesson({ bank, states, settings: s, today, selection, mode });

describe('lesson mode', () => {
  it('starts with new cards K → A → S in bank order, capped by lesson size', () => {
    const bank = fakeBank();
    const l = lesson(bank, new Map(), '2026-10-13');
    expect(l).toHaveLength(10);
    const tiers = l.map((x) => x.level);
    expect(tiers).toEqual([...tiers].sort((a, b) => 'KAS'.indexOf(a) - 'KAS'.indexOf(b)));
    expect(l[0]!.id).toBe('fake1-q01');
  });

  it('puts due cards first: most overdue, then lower box', () => {
    const bank = fakeBank();
    const states = new Map<string, CardState>([
      [
        'fake1-q05',
        {
          ...NEW_CARD,
          box: 3,
          due: '2026-10-12',
          lastAnswered: '2026-10-05',
          firstSeen: '2026-10-01',
        },
      ],
      [
        'fake1-q06',
        {
          ...NEW_CARD,
          box: 1,
          due: '2026-10-12',
          lastAnswered: '2026-10-11',
          firstSeen: '2026-10-01',
        },
      ],
      [
        'fake1-q07',
        {
          ...NEW_CARD,
          box: 2,
          due: '2026-10-10',
          lastAnswered: '2026-10-07',
          firstSeen: '2026-10-01',
        },
      ],
      [
        'fake1-q08',
        {
          ...NEW_CARD,
          box: 2,
          due: '2026-10-14',
          lastAnswered: '2026-10-11',
          firstSeen: '2026-10-01',
        },
      ],
    ]);
    const l = lesson(bank, states, '2026-10-13');
    expect(l.slice(0, 3).map((x) => x.id)).toEqual(['fake1-q07', 'fake1-q06', 'fake1-q05']);
    expect(l.map((x) => x.id)).not.toContain('fake1-q08');
  });

  it('respects the daily new-card cap across several lessons and areas in one day', () => {
    const bank = bigBank(60);
    const today = '2026-10-13';
    let attempts: Attempt[] = [];
    let seenNew = 0;
    for (let round = 0; round < 6; round++) {
      const area = AREA_IDS[round % 5]!;
      const states = replay(attempts, bank, { examDate: EXAM, timeZone: TZ });
      const l = lesson(bank, states, today, 'lesson', { areas: [area], tiers: ['K', 'A', 'S'] });
      for (const x of l) {
        expect(states.get(x.id)).toBeUndefined(); // only new cards today
        attempts = [...attempts, attempt(x, round % 2 === 0, at(today, 15 + round))];
      }
      seenNew += l.length;
    }
    expect(seenNew).toBe(15);
    const states = replay(attempts, bank, { examDate: EXAM, timeZone: TZ });
    expect(newCardsToday(states, today)).toBe(15);
    expect(lesson(bank, states, today)).toEqual([]);
    // Tomorrow: yesterday's cards are due again and new cards are available again.
    const tomorrow = lesson(bank, states, '2026-10-14');
    expect(tomorrow.length).toBe(10);
  });

  it('honours a smaller daily cap and lesson size', () => {
    const l = lesson(fakeBank(), new Map(), '2026-10-13', 'lesson', ALL, {
      newPerDay: 3,
      lessonSize: 5,
    });
    expect(l).toHaveLength(3);
  });
});

describe('mistakes and study-ahead modes', () => {
  const bank = fakeBank();
  const today = '2026-10-13';
  const states = new Map<string, CardState>([
    ['fake1-q01', { ...applyAnswer(NEW_CARD, false, '2026-10-10', EXAM) }],
    ['fake1-q02', { ...applyAnswer(NEW_CARD, false, '2026-10-08', EXAM) }],
    ['fake1-q03', { ...applyAnswer(NEW_CARD, false, today, EXAM) }], // answered today
    ['fake1-q04', { ...applyAnswer({ ...NEW_CARD, box: 3 }, true, '2026-10-12', EXAM) }],
    ['fake1-q05', { ...applyAnswer({ ...NEW_CARD, box: 1 }, true, '2026-10-12', EXAM) }],
  ]);

  it('mistakes: oldest mistake first, never a card answered today', () => {
    expect(lesson(bank, states, today, 'mistakes').map((x) => x.id)).toEqual([
      'fake1-q02',
      'fake1-q01',
    ]);
  });

  it('mistakes: a card with no recorded wrong date (defensive) sorts first', () => {
    const odd = new Map(states).set('fake1-q06', {
      ...NEW_CARD,
      box: 1,
      due: '2026-10-12',
      inMistakes: true,
    });
    expect(lesson(bank, odd, today, 'mistakes').map((x) => x.id)).toEqual([
      'fake1-q06',
      'fake1-q02',
      'fake1-q01',
    ]);
  });

  it('ahead: not-yet-due cards, soonest first', () => {
    // q05 due 10-15 (box 2), q04 due 10-26 (box 4).
    expect(lesson(bank, states, today, 'ahead').map((x) => x.id)).toEqual([
      'fake1-q05',
      'fake1-q04',
    ]);
  });
});

describe('lesson invariants (fuzz)', () => {
  const bank = bigBank(40);
  const modes: Mode[] = ['lesson', 'mistakes', 'ahead'];
  const stateArb = fc.record({
    box: fc.integer({ min: 0, max: 5 }),
    dueOffset: fc.integer({ min: -10, max: 10 }),
    lastOffset: fc.integer({ min: -10, max: 0 }),
    inMistakes: fc.boolean(),
  });
  const today = '2026-10-13';
  it('no duplicates; never retired, answered today, or outside the selection', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(stateArb), {
          minLength: bank.questions.length,
          maxLength: bank.questions.length,
        }),
        fc.subarray([...AREA_IDS], { minLength: 1 }),
        fc.subarray(['K', 'A', 'S'] as Level[], { minLength: 1 }),
        fc.constantFrom(...modes),
        (raw, areas, tiers, mode) => {
          const states = new Map<string, CardState>();
          bank.questions.forEach((x, i) => {
            const r = raw[i];
            if (r && r.box > 0)
              states.set(x.id, {
                ...NEW_CARD,
                box: r.box,
                due: addDays(today, r.dueOffset),
                lastAnswered: addDays(today, r.lastOffset),
                firstSeen: addDays(today, r.lastOffset),
                inMistakes: r.inMistakes,
                lastWrong: r.inMistakes ? addDays(today, r.lastOffset) : null,
              });
          });
          const l = lesson(bank, states, today, mode, { areas, tiers });
          expect(new Set(l.map((x) => x.id)).size).toBe(l.length);
          expect(l.length).toBeLessThanOrEqual(settings.lessonSize);
          for (const x of l) {
            expect(x.status).toBe('active');
            expect(areas).toContain(x.area);
            expect(tiers).toContain(x.level);
            expect(states.get(x.id)?.lastAnswered).not.toBe(today);
          }
        },
      ),
      { numRuns: 1000, seed: 20261013 },
    );
  });
});

describe('refreshLesson (the bank changed mid-lesson)', () => {
  it('swaps in the new version of each card and drops retired or missing ones', () => {
    const old = fakeBank();
    const rest = ['fake1-q01', 'fake1-q02', 'fake1-q03'].map((id) => q(old, id));
    const next: Bank = {
      ...old,
      questions: old.questions
        .filter((x) => x.id !== 'fake1-q03')
        .map((x) =>
          x.id === 'fake1-q01'
            ? { ...x, stem: 'FAKE: reworded?', revision: 2 }
            : x.id === 'fake1-q02'
              ? { ...x, status: 'retired' as const }
              : x,
        ),
    };
    const got = refreshLesson(rest, next);
    expect(got.map((x) => [x.id, x.stem])).toEqual([['fake1-q01', 'FAKE: reworded?']]);
    expect(refreshLesson([], next)).toEqual([]);
  });
});
