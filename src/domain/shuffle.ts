// Display shuffling with an injectable RNG (tests pass a seeded one). Responses are
// recorded as ids, so the display order never affects grading. No letters are shown.
import type { Question } from './types';

/** Returns a number in [0, 1). */
export type Rng = () => number;

/** Small seeded RNG (mulberry32) for tests and the e2e test hook. */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const same = (a: readonly string[], b: readonly string[]) => a.every((x, i) => x === b[i]);

/**
 * Display order (ids) for a card each time it is shown: choices for mc/multi, options for
 * matching (prompts keep their order), items for ordering, never starting in the right order.
 */
export function displayOrder(q: Question, rng: Rng): string[] {
  switch (q.type) {
    case 'mc':
    case 'multi':
      return shuffle(q.choices, rng).map((c) => c.id);
    case 'matching':
      return shuffle(q.options, rng).map((o) => o.id);
    case 'ordering': {
      let order = shuffle(q.items, rng).map((i) => i.id);
      for (let tries = 0; same(order, q.answer) && tries < 20; tries++)
        order = shuffle(q.items, rng).map((i) => i.id);
      // A degenerate RNG could keep returning the answer: rotate by one as a last resort.
      if (same(order, q.answer)) order = [...order.slice(1), order[0] as string];
      return order;
    }
    case 'numeric':
    case 'text':
      return [];
  }
}
