import { describe, expect, it } from 'vitest';
import { grade, parseNumeric } from './grade';
import type { Question, Response } from './types';
import { fakeBank, q, realBank } from '../../tests/helpers';

const fake = fakeBank();
const real = realBank();
const num = (input: string): Response => ({ type: 'numeric', input });
const text = (input: string): Response => ({ type: 'text', input });

describe('mc', () => {
  const mc = q(fake, 'fake1-q01', 'mc');
  it('is correct only for the answer id', () => {
    expect(grade(mc, { type: 'mc', choice: 'A' })).toEqual({ correct: true });
    for (const c of ['B', 'C', 'D', 'a', '', 'Z'])
      expect(grade(mc, { type: 'mc', choice: c }).correct).toBe(false);
  });
});

describe('multi', () => {
  const m = q(fake, 'fake2-q01', 'multi'); // answer A, D
  it('needs exactly the answer set; parts mark each chosen option', () => {
    expect(grade(m, { type: 'multi', choices: ['D', 'A'] })).toEqual({
      correct: true,
      parts: [true, true],
    });
    expect(grade(m, { type: 'multi', choices: ['A', 'B'] })).toEqual({
      correct: false,
      parts: [true, false],
    });
    expect(grade(m, { type: 'multi', choices: ['A'] }).correct).toBe(false);
    expect(grade(m, { type: 'multi', choices: ['A', 'D', 'B'] }).correct).toBe(false);
    expect(grade(m, { type: 'multi', choices: ['A', 'A'] }).correct).toBe(false);
    expect(grade(m, { type: 'multi', choices: [] }).correct).toBe(false);
  });
});

describe('numeric', () => {
  const cases: [string, string, boolean][] = [
    ['fake2-q02', '$504,000', true],
    ['fake2-q02', '504000', true],
    ['fake2-q02', '504,000.00', true],
    ['fake2-q02', '504k', false],
    ['fake2-q03', '12.5%', true],
    ['fake2-q03', '12.6', true], // tolerance 0.1
    ['fake2-q03', '12.4 %', true],
    ['fake2-q03', '12.7', false],
    ['fake2-q04', '40:1', true],
    ['fake2-q04', '40', true],
    ['fake2-q04', '40 to 1', false],
    ['fake2-q05', '30 days', true],
    ['fake2-q05', '30 DAYS', true],
    ['fake2-q05', '30 day', false],
    ['fake2-q06', '72°F', true],
    ['fake2-q06', '72°', false],
    ['fake2-q07', '.85', true],
    ['fake2-q07', '0.850', true],
    ['fake2-q07', '85%', false],
    ['fake2-q07', '-0.85', false],
    ['fake2-q07', '', false],
    ['fake2-q07', '.', false],
    ['fake2-q07', '1e3', false],
    ['fake2-q07', '0x1', false],
    ['fake2-q07', 'Infinity', false],
  ];
  it.each(cases)('%s: %j → %s', (id, input, correct) => {
    expect(grade(q(fake, id), num(input)).correct).toBe(correct);
  });

  it('parses negatives and trailing dots; rejects junk', () => {
    expect(parseNumeric('-3', '')).toBe(-3);
    expect(parseNumeric('3.', '')).toBe(3);
    expect(parseNumeric('1.2.3', '')).toBeNull();
    expect(parseNumeric('-', '')).toBeNull();
  });
});

describe('text', () => {
  const t = q(fake, 'fake2-q08', 'text');
  it.each([
    ['widget-wrangling', true],
    ['Widget Wrangling', true],
    ['  WW. ', true],
    ['widget-wrangler.', true],
    ['widget wrangling..', false],
    ['widgetwrangling', false],
    ['widget-wranglings', false],
    ['widget–wrangling', false], // en dash is not forgiven
    ['', false],
  ])('%j → %s', (input, correct) => {
    expect(grade(t, text(input)).correct).toBe(correct);
  });
});

describe('ordering', () => {
  const o = q(fake, 'fake2-q10', 'ordering'); // C A E B D
  it('needs the exact sequence; parts per position', () => {
    expect(grade(o, { type: 'ordering', order: ['C', 'A', 'E', 'B', 'D'] })).toEqual({
      correct: true,
      parts: [true, true, true, true, true],
    });
    expect(grade(o, { type: 'ordering', order: ['A', 'C', 'E', 'B', 'D'] })).toEqual({
      correct: false,
      parts: [false, false, true, true, true],
    });
    expect(grade(o, { type: 'ordering', order: ['C', 'A', 'E', 'B', 'D', 'D'] }).correct).toBe(
      false,
    );
    expect(grade(o, { type: 'ordering', order: ['C', 'A', 'E', 'B'] }).correct).toBe(false);
  });
});

describe('matching', () => {
  const m = q(fake, 'fake2-q11', 'matching'); // 1B 2D 3A 4E
  it('needs every prompt mapped correctly; parts per prompt', () => {
    expect(grade(m, { type: 'matching', pairs: { 1: 'B', 2: 'D', 3: 'A', 4: 'E' } })).toEqual({
      correct: true,
      parts: [true, true, true, true],
    });
    expect(grade(m, { type: 'matching', pairs: { 1: 'B', 2: 'D', 3: 'A', 4: 'C' } })).toEqual({
      correct: false,
      parts: [true, true, true, false],
    });
    expect(grade(m, { type: 'matching', pairs: { 1: 'B', 2: 'D', 3: 'A' } }).correct).toBe(false);
    expect(grade(m, { type: 'matching', pairs: {} }).correct).toBe(false);
  });
});

describe('a response of the wrong type is wrong, not an error', () => {
  const wrong: Response = { type: 'mc', choice: 'A' };
  it.each(fake.questions.filter((x) => x.type !== 'mc').map((x) => [x.id, x] as const))(
    '%s',
    (_id, x) => {
      expect(grade(x, wrong).correct).toBe(false);
    },
  );
  it('mc', () => {
    expect(grade(q(fake, 'fake1-q01'), text('A')).correct).toBe(false);
  });
});

describe('real bank edge cases (read-only)', () => {
  const cases: [string, string, boolean][] = [
    ['lsw2-q18', '0.72', true],
    ['lsw2-q18', '0.72%', true],
    ['lsw2-q18', '.72', true],
    ['lsw2-q18', ' 0.72 % ', true],
    ['lsw2-q18', '0.7', false],
    ['trw2-q18', '89', true],
    ['trw2-q18', '89:1', true],
    ['trw2-q18', '89 to 1', false],
    ['hiw1-q19', '87', true],
    ['hiw1-q19', '87°F', true],
    ['hiw1-q19', '87 °f', true],
    ['hiw1-q19', '87°', false], // decided rule; HANDOFF open item
    ['trw1-q01', '0.85', true],
    ['trw1-q01', '.85', true],
    ['trw1-q01', '85%', false], // open item
    ['pt1-q015', '38.3', true],
    ['pt1-q015', '38.5', true],
    ['pt1-q015', '38.6', false],
    ['pt1-q006', '1.44 ratio', true],
    ['pt1-q006', '1.45', true],
    ['lsw2-q20', '$504,000', true],
    ['lsw2-q20', '504000', true],
    ['lsw2-q20', '504,000.00', true],
    ['lsw2-q20', '504k', false],
    ['lsw2-q20', '1.2.3', false],
    ['lsw2-q20', '', false],
    ['lsw2-q20', '-', false],
  ];
  it.each(cases)('%s numeric %j → %s', (id, input, correct) => {
    expect(grade(q(real, id, 'numeric'), num(input)).correct).toBe(correct);
  });

  it.each([
    ['hiw1-q21', 'lockout/tagout', true],
    ['hiw1-q21', 'LOTO', true],
    ['hiw1-q21', '  Lockout   tagout. ', true],
    ['hiw1-q21', 'lockout tag out', false],
    ['hiw1-q21', 'lockouts/tagout', false],
    ['lsw1-q13', 'ADEA.', true],
    ['lsw1-q13', 'ADEA..', false],
    ['wpw1-q22', 'Standalone', true],
    ['wpw1-q22', 'stand-alone', true],
    ['wpw1-q22', 'stand alone', false],
  ])('%s text %j → %s', (id, input, correct) => {
    expect(grade(q(real, id, 'text'), text(input)).correct).toBe(correct);
  });
});

/** The canonical correct responses for a question (never displayAnswer). */
function correctResponses(x: Question): Response[] {
  switch (x.type) {
    case 'mc':
      return [{ type: 'mc', choice: x.answer }];
    case 'multi':
      return [
        { type: 'multi', choices: [...x.answer] },
        { type: 'multi', choices: [...x.answer].reverse() },
      ];
    case 'numeric':
      return [num(String(x.answer.value)), num(String(x.answer.value) + x.answer.unit)];
    case 'text':
      return x.accepted.map(text);
    case 'ordering':
      return [{ type: 'ordering', order: [...x.answer] }];
    case 'matching':
      return [{ type: 'matching', pairs: { ...x.answer } }];
  }
}

describe.each([
  ['fake', fake],
  ['real', real],
])('every %s question', (_name, bank) => {
  it('grades its own canonical answers correct', () => {
    for (const x of bank.questions)
      for (const r of correctResponses(x))
        expect([x.id, grade(x, r).correct]).toEqual([x.id, true]);
  });

  it('grades every other single choice wrong (mc and multi)', () => {
    for (const x of bank.questions) {
      if (x.type === 'mc')
        for (const c of x.choices)
          if (c.id !== x.answer)
            expect([x.id, grade(x, { type: 'mc', choice: c.id }).correct]).toEqual([x.id, false]);
      if (x.type === 'multi')
        for (const c of x.choices)
          expect([x.id, grade(x, { type: 'multi', choices: [c.id] }).correct]).toEqual([
            x.id,
            false,
          ]);
    }
  });
});
