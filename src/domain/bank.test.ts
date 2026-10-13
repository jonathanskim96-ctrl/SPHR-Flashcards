import { describe, expect, it } from 'vitest';
import { answerFp, canonicalJson, compareBankVersion, normalizeBank } from './bank';
import { fakeBank, q, rawSample, realBank } from '../../tests/helpers';

describe('normalizeBank', () => {
  it('accepts the fake bank and the real bank without dropping anything', () => {
    expect(fakeBank().questions).toHaveLength(19);
    const real = realBank();
    expect(real.questions).toHaveLength(400);
    expect(real.scenarios).toHaveLength(26);
  });

  it('copies only known fields (defensive)', () => {
    const raw = rawSample();
    (raw.questions[0] as Record<string, unknown>).evil = '<script>';
    const r = normalizeBank(raw);
    expect(r.ok && 'evil' in (r.bank.questions[0] as object)).toBe(false);
  });

  it.each([
    [null, 'not a question bank'],
    [[], 'not a question bank'],
    [{ schemaVersion: 2 }, 'unsupported schemaVersion 2'],
    [{ schemaVersion: 1, bankVersion: '2026-10-13' }, 'invalid bankVersion'],
  ])('rejects %j as a whole', (input, error) => {
    expect(normalizeBank(input)).toEqual({ ok: false, error });
  });

  it('rejects a bank with missing or duplicate areas, or bad levels', () => {
    const noAreas = rawSample();
    noAreas.areas = (noAreas.areas as unknown[]).slice(0, 4);
    expect(normalizeBank(noAreas)).toMatchObject({
      ok: false,
      error: 'areas must list the 5 areas',
    });
    const dupAreas = rawSample();
    (dupAreas.areas as { id: number }[])[1]!.id = 1;
    expect(normalizeBank(dupAreas).ok).toBe(false);
    const notArray = rawSample();
    notArray.areas = 'x';
    expect(normalizeBank(notArray).ok).toBe(false);
    const noLevels = rawSample();
    delete noLevels.levels;
    expect(normalizeBank(noLevels)).toMatchObject({ ok: false, error: 'missing levels' });
    for (const points of [4, -1, 1.5, '1']) {
      const bad = rawSample();
      (bad.levels as Record<string, { points: unknown }>).A!.points = points;
      expect(normalizeBank(bad)).toMatchObject({ ok: false, error: 'invalid levels.A' });
    }
  });

  it('sorts areas and fills a missing level name', () => {
    const raw = rawSample();
    (raw.areas as unknown[]).reverse();
    delete (raw.levels as Record<string, { name?: string }>).K!.name;
    const r = normalizeBank(raw);
    expect(r.ok && r.bank.areas.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
    expect(r.ok && r.bank.levels.K.name).toBe('K');
  });

  it('treats missing scenarios and questions lists as empty', () => {
    const raw = rawSample();
    delete raw.scenarios;
    delete (raw as Record<string, unknown>).questions;
    const r = normalizeBank(raw);
    expect(r.ok && r.bank.questions).toEqual([]);
  });

  type Mutate = (x: Record<string, unknown>) => void;
  const cases: [string, string, Mutate, string][] = [
    ['fake1-q01', 'not an object', (x) => Object.keys(x).forEach((k) => delete x[k]), 'invalid id'],
    ['fake1-q01', 'bad id', (x) => (x.id = 'Bad Id'), 'invalid id'],
    ['fake1-q01', 'type', (x) => (x.type = 'essay'), 'unknown type essay'],
    ['fake1-q01', 'area', (x) => (x.area = 6), 'invalid area'],
    ['fake1-q01', 'level', (x) => (x.level = 'X'), 'invalid level'],
    ['fake1-q01', 'status', (x) => (x.status = 'deleted'), 'invalid status'],
    ['fake1-q01', 'revision', (x) => (x.revision = 1.5), 'invalid revision'],
    ['fake1-q01', 'revision 0', (x) => (x.revision = 0), 'invalid revision'],
    ['fake1-q01', 'stem', (x) => (x.stem = '  '), 'missing stem'],
    ['fake1-q01', 'explanation', (x) => delete x.explanation, 'missing explanation'],
    ['fake1-q01', 'scenario', (x) => (x.scenarioId = 'nope-sa'), 'unknown scenario'],
    ['fake1-q01', 'scenario type', (x) => (x.scenarioId = 7), 'unknown scenario'],
    ['fake1-q01', 'choices', (x) => (x.choices = 'A'), 'invalid choices'],
    ['fake1-q01', 'one choice', (x) => (x.choices = [{ id: 'A', text: 'a' }]), 'invalid choices'],
    [
      'fake1-q01',
      'choice text',
      (x) => (x.choices = [{ id: 'A' }, { id: 'B', text: 'b' }]),
      'invalid choices',
    ],
    [
      'fake1-q01',
      'dup choice ids',
      (x) =>
        (x.choices = [
          { id: 'A', text: 'a' },
          { id: 'A', text: 'b' },
        ]),
      'invalid choices',
    ],
    ['fake1-q01', 'choice not object', (x) => (x.choices = ['A', 'B']), 'invalid choices'],
    ['fake1-q01', 'mc answer', (x) => (x.answer = 'Z'), 'answer is not a choice'],
    ['fake1-q01', 'mc answer type', (x) => (x.answer = ['A']), 'answer is not a choice'],
    ['fake2-q01', 'multi choices', (x) => delete x.choices, 'invalid choices'],
    ['fake2-q01', 'multi answer', (x) => (x.answer = 'A'), 'invalid answer'],
    ['fake2-q01', 'multi empty', (x) => (x.answer = []), 'invalid answer'],
    ['fake2-q01', 'multi unknown', (x) => (x.answer = ['A', 'Z']), 'invalid answer'],
    ['fake2-q01', 'multi dup', (x) => (x.answer = ['A', 'A']), 'invalid answer'],
    [
      'fake2-q01',
      'multi all',
      (x) => ((x.answer = ['A', 'B', 'C', 'D', 'E']), (x.selectCount = 5)),
      'invalid answer',
    ],
    [
      'fake2-q01',
      'selectCount',
      (x) => (x.selectCount = 3),
      'selectCount must equal the number of answers',
    ],
    ['fake2-q02', 'numeric answer', (x) => (x.answer = 5), 'invalid answer'],
    [
      'fake2-q02',
      'numeric value',
      (x) => ((x.answer as Record<string, unknown>).value = '5'),
      'invalid answer value',
    ],
    [
      'fake2-q02',
      'numeric NaN',
      (x) => ((x.answer as Record<string, unknown>).value = Infinity),
      'invalid answer value',
    ],
    [
      'fake2-q02',
      'tolerance',
      (x) => ((x.answer as Record<string, unknown>).tolerance = -1),
      'invalid tolerance',
    ],
    [
      'fake2-q02',
      'tolerance type',
      (x) => ((x.answer as Record<string, unknown>).tolerance = '0'),
      'invalid tolerance',
    ],
    ['fake2-q02', 'unit', (x) => delete (x.answer as Record<string, unknown>).unit, 'invalid unit'],
    ['fake2-q08', 'accepted', (x) => (x.accepted = []), 'invalid accepted'],
    ['fake2-q08', 'accepted blank', (x) => (x.accepted = ['ok', ' ']), 'invalid accepted'],
    ['fake2-q08', 'accepted type', (x) => (x.accepted = 'ok'), 'invalid accepted'],
    ['fake2-q10', 'items', (x) => (x.items = []), 'invalid items'],
    [
      'fake2-q10',
      'ordering answer',
      (x) => (x.answer = ['A', 'B']),
      'answer must be a permutation of the items',
    ],
    [
      'fake2-q10',
      'ordering dup',
      (x) => (x.answer = ['A', 'A', 'B', 'C', 'D']),
      'answer must be a permutation of the items',
    ],
    [
      'fake2-q10',
      'ordering unknown',
      (x) => (x.answer = ['A', 'B', 'C', 'D', 'Z']),
      'answer must be a permutation of the items',
    ],
    [
      'fake2-q10',
      'ordering type',
      (x) => (x.answer = 'ABCDE'),
      'answer must be a permutation of the items',
    ],
    ['fake2-q11', 'prompts', (x) => (x.prompts = []), 'invalid prompts or options'],
    [
      'fake2-q11',
      'options',
      (x) => (x.options = [{ id: 'A', text: 'a' }]),
      'invalid prompts or options',
    ],
    ['fake2-q11', 'no options', (x) => delete x.options, 'invalid prompts or options'],
    ['fake2-q11', 'matching answer', (x) => (x.answer = []), 'invalid answer'],
    [
      'fake2-q11',
      'unmapped',
      (x) => delete (x.answer as Record<string, unknown>)['4'],
      'answer must map every prompt',
    ],
    [
      'fake2-q11',
      'bad option',
      (x) => ((x.answer as Record<string, unknown>)['4'] = 'Z'),
      'answer must map every prompt',
    ],
    [
      'fake2-q11',
      'extra key',
      (x) => ((x.answer as Record<string, unknown>)['9'] = 'C'),
      'answer has extra keys',
    ],
    [
      'fake2-q11',
      'used twice',
      (x) => ((x.answer as Record<string, unknown>)['4'] = 'B'),
      'an option is used twice',
    ],
  ];
  it.each(cases)('drops %s (%s) and reports why', (id, _label, mutate, reason) => {
    const raw = rawSample();
    const target = raw.questions.find((x) => x.id === id)!;
    mutate(target);
    const r = normalizeBank(raw);
    if (!r.ok) throw new Error(r.error);
    expect(r.bank.questions).toHaveLength(18);
    expect(r.dropped).toEqual([{ id: typeof target.id === 'string' ? target.id : '?', reason }]);
  });

  it('drops non-object questions, duplicates and malformed scenarios', () => {
    const raw = rawSample();
    raw.questions.push('nonsense' as never, structuredClone(raw.questions[0]!));
    (raw.scenarios as unknown[]).push(
      { id: 'bad', area: 1, text: 'x' },
      'x',
      structuredClone((raw.scenarios as unknown[])[0]),
    );
    const r = normalizeBank(raw);
    if (!r.ok) throw new Error(r.error);
    expect(r.dropped).toEqual([
      { id: 'bad', reason: 'malformed scenario' },
      { id: '?', reason: 'malformed scenario' },
      { id: 'fake-sa', reason: 'duplicate scenario id' },
      { id: '?', reason: 'invalid id' },
      { id: 'fake1-q01', reason: 'duplicate id' },
    ]);
  });

  it('fills defaults for optional fields', () => {
    const raw = rawSample();
    const num = raw.questions.find((x) => x.id === 'fake2-q05')!;
    delete num.displayAnswer;
    const unitless = raw.questions.find((x) => x.id === 'fake2-q07')!;
    delete unitless.displayAnswer;
    const text = raw.questions.find((x) => x.id === 'fake2-q08')!;
    delete text.displayAnswer;
    const m = raw.questions.find((x) => x.id === 'fake2-q11')!;
    delete m.note;
    const mc = raw.questions.find((x) => x.id === 'fake1-q01')!;
    delete mc.outline;
    delete mc.added;
    mc.category = 'Sub-topic';
    delete (raw.scenarios as Record<string, unknown>[])[0]!.title;
    const r = normalizeBank(raw);
    if (!r.ok) throw new Error(r.error);
    const b = r.bank;
    expect(q(b, 'fake2-q05', 'numeric').displayAnswer).toBe('30 days');
    expect(q(b, 'fake2-q07', 'numeric').displayAnswer).toBe('0.85');
    expect(q(b, 'fake2-q08', 'text').displayAnswer).toBe('widget-wrangling');
    expect(q(b, 'fake2-q11', 'matching').note).toBeNull();
    expect(q(b, 'fake1-q01', 'mc')).toMatchObject({
      outline: [],
      added: '',
      category: 'Sub-topic',
    });
    expect(b.scenarios[0]!.title).toBe('');
  });
});

describe('compareBankVersion', () => {
  it.each([
    ['2026-10-13.10', '2026-10-13.9', 1],
    ['2026-10-13.1', '2026-10-13.1', 0],
    ['2026-10-12.99', '2026-10-13.1', -1],
    ['2027-01-01.1', '2026-12-31.5', 1],
    ['junk', '2026-10-13.1', -1],
    ['2026-10-13.1', 'junk', 1],
    ['junk', 'other', 0],
  ])('%s vs %s = %i', (a, b, sign) => {
    expect(Math.sign(compareBankVersion(a, b))).toBe(sign);
  });
});

describe('answerFp', () => {
  it('is 16 hex chars and stable', () => {
    const b = fakeBank();
    for (const x of b.questions) {
      expect(answerFp(x)).toMatch(/^[0-9a-f]{16}$/);
      expect(answerFp(x)).toBe(answerFp(structuredClone(x)));
    }
  });

  it('matches a pinned value (changing the formula would reset every card)', () => {
    // Computed independently with Node's crypto over the canonical JSON of fake1-q01.
    expect(answerFp(q(fakeBank(), 'fake1-q01'))).toBe('b095ba8822800878');
  });

  it('ignores wording, explanation, scenario, revision and choice order', () => {
    const b = fakeBank();
    for (const x of b.questions) {
      const edited = {
        ...structuredClone(x),
        stem: 'FAKE: reworded',
        explanation: 'new',
        revision: 9,
        scenarioId: null,
      };
      expect(answerFp(edited)).toBe(answerFp(x));
    }
    const mc = q(b, 'fake1-q01', 'mc');
    expect(answerFp({ ...mc, choices: [...mc.choices].reverse() })).toBe(answerFp(mc));
    const t = q(b, 'fake2-q08', 'text');
    expect(answerFp({ ...t, accepted: [...t.accepted].reverse() })).toBe(answerFp(t));
  });

  it('changes when anything graded changes', () => {
    const b = fakeBank();
    const mc = q(b, 'fake1-q01', 'mc');
    const fp = (x: unknown) => answerFp(x as never);
    expect(fp({ ...mc, answer: 'B' })).not.toBe(fp(mc));
    expect(
      fp({ ...mc, choices: mc.choices.map((c, i) => (i ? c : { ...c, text: 'Navy' })) }),
    ).not.toBe(fp(mc));
    const multi = q(b, 'fake2-q01', 'multi');
    expect(fp({ ...multi, answer: ['A', 'B'] })).not.toBe(fp(multi));
    const num = q(b, 'fake2-q02', 'numeric');
    expect(fp({ ...num, answer: { ...num.answer, value: 1 } })).not.toBe(fp(num));
    expect(fp({ ...num, answer: { ...num.answer, unit: '%' } })).not.toBe(fp(num));
    expect(fp({ ...num, answer: { ...num.answer, tolerance: 1 } })).not.toBe(fp(num));
    const t = q(b, 'fake2-q08', 'text');
    expect(fp({ ...t, accepted: [...t.accepted, 'wrangle'] })).not.toBe(fp(t));
    const o = q(b, 'fake2-q10', 'ordering');
    expect(fp({ ...o, answer: [...o.answer].reverse() })).not.toBe(fp(o));
    expect(fp({ ...o, items: o.items.map((i, n) => (n ? i : { ...i, text: 'x' })) })).not.toBe(
      fp(o),
    );
    const m = q(b, 'fake2-q11', 'matching');
    expect(fp({ ...m, answer: { ...m.answer, 4: 'C' } })).not.toBe(fp(m));
    expect(fp({ ...m, options: m.options.map((i, n) => (n ? i : { ...i, text: 'x' })) })).not.toBe(
      fp(m),
    );
    expect(fp({ ...m, prompts: m.prompts.map((i, n) => (n ? i : { ...i, text: 'x' })) })).not.toBe(
      fp(m),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"z":1}]},"b":1}',
    );
  });
});
