import { describe, expect, it } from 'vitest';
import { applyAnswer, mastered, NEW_CARD } from './schedule';
import type { CardState } from './types';

const EXAM = '2026-12-15';
const run = (answers: boolean[], start = '2026-10-01', exam = EXAM) => {
  let s: CardState = NEW_CARD;
  let day = start;
  const out: CardState[] = [];
  for (const c of answers) {
    s = applyAnswer(s, c, day, exam);
    out.push(s);
    day = s.due!;
  }
  return out;
};

describe('applyAnswer', () => {
  it('climbs the boxes 1, 3, 7, 14, 21 days and stays at box 5', () => {
    const states = run([true, true, true, true, true, true], '2026-01-01', '2027-12-31');
    expect(states.map((s) => s.box)).toEqual([1, 2, 3, 4, 5, 5]);
    expect(states.map((s) => s.due)).toEqual([
      '2026-01-02',
      '2026-01-05',
      '2026-01-12',
      '2026-01-26',
      '2026-02-16',
      '2026-03-09',
    ]);
    expect(states[0]).toMatchObject({
      firstSeen: '2026-01-01',
      lastAnswered: '2026-01-01',
      lastWrong: null,
    });
    expect(states[5]!.firstSeen).toBe('2026-01-01');
  });

  it('wrong → box 1, due tomorrow, into Mistakes; 2 correct in a row → out and mastered', () => {
    const [a, b, c, d] = run([true, false, true, true], '2026-10-01');
    expect(a).toMatchObject({ box: 1, inMistakes: false, streak: 1 });
    expect(b).toMatchObject({
      box: 1,
      due: '2026-10-03',
      inMistakes: true,
      streak: 0,
      lastWrong: '2026-10-02',
    });
    expect(c).toMatchObject({ box: 2, inMistakes: true, streak: 1, lastWrong: '2026-10-02' });
    expect(mastered(c!)).toBe(false);
    expect(d).toMatchObject({ box: 3, inMistakes: false, streak: 2 });
    expect(mastered(d!)).toBe(true);
  });

  it('never schedules past the exam date when answered before it', () => {
    const s = applyAnswer({ ...NEW_CARD, box: 4 }, true, '2026-12-01', EXAM);
    expect(s.due).toBe(EXAM); // would be 12-22
    expect(applyAnswer(NEW_CARD, true, '2026-12-14', EXAM).due).toBe(EXAM);
  });

  it('has no cap on or after the exam date', () => {
    expect(applyAnswer({ ...NEW_CARD, box: 4 }, true, EXAM, EXAM).due).toBe('2027-01-05');
    expect(applyAnswer(NEW_CARD, false, '2026-12-20', EXAM).due).toBe('2026-12-21');
  });

  it('handles month and leap-year boundaries', () => {
    expect(applyAnswer({ ...NEW_CARD, box: 2 }, true, '2028-02-25', '2029-01-01').due).toBe(
      '2028-03-03',
    );
  });
});
