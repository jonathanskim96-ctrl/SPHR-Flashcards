import { describe, expect, it } from 'vitest';
import { dailyXp, totalXp, xpFor } from './xp';
import { attempt, fakeBank, q, TZ } from '../../tests/helpers';

describe('xp', () => {
  const bank = fakeBank();
  it('a correct answer earns the tier points read from the bank; wrong earns 0', () => {
    expect(xpFor(bank, q(bank, 'fake1-q01'), true)).toBe(1); // K
    expect(xpFor(bank, q(bank, 'fake1-q02'), true)).toBe(2); // A
    expect(xpFor(bank, q(bank, 'fake1-q03'), true)).toBe(3); // S
    expect(xpFor(bank, q(bank, 'fake1-q03'), false)).toBe(0);
    const custom = { ...bank, levels: { ...bank.levels, K: { name: 'K', points: 3 } } };
    expect(xpFor(custom, q(bank, 'fake1-q01'), true)).toBe(3);
  });

  it('totals and daily totals use the local day', () => {
    const s = q(bank, 'fake1-q03');
    const atts = [
      attempt(s, true, '2026-10-13T15:00:00Z'),
      attempt(s, true, '2026-10-14T06:59:00Z'), // still Oct 13 in Los Angeles
      attempt(s, false, '2026-10-13T16:00:00Z'),
      attempt(s, true, '2026-10-14T07:00:00Z'), // Oct 14 in Los Angeles
    ];
    expect(totalXp(atts)).toBe(9);
    expect(dailyXp(atts, '2026-10-13', TZ)).toBe(6);
    expect(dailyXp(atts, '2026-10-14', TZ)).toBe(3);
    expect(dailyXp(atts, '2026-10-14', 'UTC')).toBe(6);
    expect(totalXp([])).toBe(0);
  });
});
