import { describe, expect, it } from 'vitest';
import { computeProgress, totals } from './progress';
import { NEW_CARD } from './schedule';
import type { Bank, CardState } from './types';
import { fakeBank } from '../../tests/helpers';

describe('progress', () => {
  const bank = fakeBank();
  it('counts active cards per area and tier; retired cards are left out', () => {
    const p = computeProgress(bank, new Map());
    // fake2-q09 (area 5, A) is retired; area 5 A has fake1-q08 only.
    expect(p[5].A).toEqual({ active: 1, seen: 0, mastered: 0, badge: false });
    expect(totals(p, [1, 2, 3, 4, 5]).active).toBe(18);
  });

  it('seen, mastered and the badge when every active card in a tier is mastered', () => {
    const m: CardState = {
      ...NEW_CARD,
      box: 3,
      streak: 2,
      due: '2026-10-20',
      lastAnswered: '2026-10-13',
      firstSeen: '2026-10-01',
    };
    const seen: CardState = { ...m, streak: 1 };
    const states = new Map([
      ['fake1-q08', m], // area 5 A (its only active card)
      ['fake2-q09', m], // retired: ignored
      ['fake1-q01', seen], // area 1 K
    ]);
    const p = computeProgress(bank, states);
    expect(p[5].A).toEqual({ active: 1, seen: 1, mastered: 1, badge: true });
    expect(p[1].K).toMatchObject({ seen: 1, mastered: 0, badge: false });
    expect(totals(p, [1, 5])).toEqual({
      active:
        p[1].K.active +
        p[1].A.active +
        p[1].S.active +
        p[5].K.active +
        p[5].A.active +
        p[5].S.active,
      seen: 2,
      mastered: 1,
    });
  });

  it('an empty tier never shows a badge', () => {
    const empty: Bank = { ...bank, questions: [] };
    expect(computeProgress(empty, new Map())[1].K.badge).toBe(false);
  });
});
