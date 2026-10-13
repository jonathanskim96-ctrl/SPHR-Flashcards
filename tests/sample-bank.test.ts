// The fake bank must keep covering every case BUILD_PLAN Phase 0 lists, so later tests can
// rely on it. It must also stay obviously fake (never real SPHR content).
import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-bank.json';

type Q = (typeof bank.questions)[number] & Record<string, unknown>;
const qs = bank.questions as Q[];
const ofType = (t: string) => qs.filter((q) => q.type === t);

describe('tests/fixtures/sample-bank.json', () => {
  it('is clearly fake', () => {
    for (const q of qs) expect(q.stem.startsWith('FAKE:')).toBe(true);
    for (const s of bank.scenarios) expect(s.text.startsWith('FAKE:')).toBe(true);
  });

  it('has every question type', () => {
    expect(new Set(qs.map((q) => q.type))).toEqual(
      new Set(['mc', 'multi', 'numeric', 'text', 'ordering', 'matching']),
    );
  });

  it('has a scenario shared by 2 questions', () => {
    const counts = new Map<string, number>();
    for (const q of qs)
      if (q.scenarioId) counts.set(q.scenarioId, (counts.get(q.scenarioId) ?? 0) + 1);
    expect([...counts.values()].some((n) => n >= 2)).toBe(true);
  });

  it('has a retired question and a question at revision 2', () => {
    expect(qs.some((q) => q.status === 'retired')).toBe(true);
    expect(qs.some((q) => q.revision === 2)).toBe(true);
  });

  it('has numeric units $, %, :1, days, °F and empty, and a tolerance > 0', () => {
    const numeric = ofType('numeric') as unknown as {
      answer: { unit: string; tolerance: number };
    }[];
    const units = new Set(numeric.map((q) => q.answer.unit));
    for (const u of ['$', '%', ':1', 'days', '°F', '']) expect(units.has(u)).toBe(true);
    expect(numeric.some((q) => q.answer.tolerance > 0)).toBe(true);
  });

  it('has a text item with 3+ accepted forms including a hyphenated one', () => {
    const text = ofType('text') as unknown as { accepted: string[] }[];
    expect(
      text.some((q) => q.accepted.length >= 3 && q.accepted.some((a) => a.includes('-'))),
    ).toBe(true);
  });

  it('has ordering with 5 items, matching with 4 prompts and 5 options, multi choose 2', () => {
    expect(
      (ofType('ordering') as unknown as { items: unknown[] }[]).some((q) => q.items.length === 5),
    ).toBe(true);
    const matching = ofType('matching') as unknown as { prompts: unknown[]; options: unknown[] }[];
    expect(matching.some((q) => q.prompts.length === 4 && q.options.length === 5)).toBe(true);
    expect(
      (ofType('multi') as unknown as { selectCount: number }[]).some((q) => q.selectCount === 2),
    ).toBe(true);
  });
});
