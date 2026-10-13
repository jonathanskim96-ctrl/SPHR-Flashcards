import { describe, expect, it } from 'vitest';
import { displayOrder, seededRng, shuffle } from './shuffle';
import { fakeBank, q } from '../../tests/helpers';

const bank = fakeBank();

describe('shuffle', () => {
  it('is a permutation and is reproducible with a seed', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect(shuffle(xs, seededRng(1)).sort()).toEqual(xs);
    expect(shuffle(xs, seededRng(7))).toEqual(shuffle(xs, seededRng(7)));
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]); // input untouched
  });

  it('seededRng stays in [0, 1)', () => {
    const r = seededRng(42);
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('ordering items never start in the correct order (1,000 seeds)', () => {
    const o = q(bank, 'fake2-q10', 'ordering');
    const three = { ...o, items: o.items.slice(0, 3), answer: ['C', 'A', 'B'] };
    for (let seed = 0; seed < 1000; seed++) {
      for (const x of [o, three]) {
        const order = displayOrder(x, seededRng(seed));
        expect([...order].sort()).toEqual(x.items.map((i) => i.id).sort());
        expect(order).not.toEqual(x.answer);
      }
    }
  });

  it('a stuck RNG still never shows the correct order', () => {
    const o = q(bank, 'fake2-q10', 'ordering');
    // With rng() = 0.999… a Fisher–Yates shuffle returns the input order unchanged.
    const inOrder = { ...o, items: o.answer.map((id) => o.items.find((i) => i.id === id)!) };
    expect(displayOrder(inOrder, () => 0.999999)).not.toEqual(o.answer);
  });

  it('choices and options are shuffled; prompts and typed answers are not', () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 50; seed++)
      orders.add(displayOrder(q(bank, 'fake1-q01'), seededRng(seed)).join());
    expect(orders.size).toBeGreaterThan(1);
    expect(displayOrder(q(bank, 'fake2-q01'), seededRng(1)).sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(displayOrder(q(bank, 'fake2-q11'), seededRng(1)).sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(displayOrder(q(bank, 'fake2-q02'), seededRng(1))).toEqual([]);
    expect(displayOrder(q(bank, 'fake2-q08'), seededRng(1))).toEqual([]);
  });
});
