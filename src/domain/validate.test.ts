import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  jsonbText,
  MAX_RESPONSE_BYTES,
  SETTINGS_LIMITS,
  validateAttempt,
  validateResponse,
  validateSettings,
} from './validate';
import { at, attempt, fakeBank, q, TZ } from '../../tests/helpers';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const good = defaultSettings(TZ);

describe('validateSettings', () => {
  it('accepts the defaults and returns a clean copy', () => {
    expect(validateSettings(good)).toEqual({ ok: true, value: good });
    expect(good).toMatchObject({
      newPerDay: 15,
      lessonSize: 10,
      dailyXpGoal: 30,
      examDate: '2026-12-15',
      reminderTime: '15:00',
    });
  });

  for (const [key, { min, max }] of Object.entries(SETTINGS_LIMITS)) {
    it(`${key}: ${min}..${max}, whole numbers only`, () => {
      for (const v of [min, max]) expect(validateSettings({ ...good, [key]: v }).ok).toBe(true);
      for (const v of [min - 1, max + 1, 3.7, min + 0.5, '10', null, NaN, Infinity])
        expect([v, validateSettings({ ...good, [key]: v }).ok]).toEqual([v, false]);
    });
  }

  it('examDate must be a real date', () => {
    for (const v of ['2026-12-15', '2027-02-28'])
      expect(validateSettings({ ...good, examDate: v }).ok).toBe(true);
    for (const v of ['2026-02-30', '12/15/2026', '', 20261215])
      expect(validateSettings({ ...good, examDate: v }).ok).toBe(false);
  });

  it('reminderTime is HH:MM on the 15-minute grid', () => {
    for (const v of ['00:00', '15:00', '23:45', '09:15'])
      expect(validateSettings({ ...good, reminderTime: v }).ok).toBe(true);
    for (const v of ['15:07', '24:00', '9:15', '15:00:00', '15:60', 1500])
      expect(validateSettings({ ...good, reminderTime: v }).ok).toBe(false);
  });

  it('reminderEnabled is a boolean; timeZone is a real IANA zone', () => {
    expect(validateSettings({ ...good, reminderEnabled: true }).ok).toBe(true);
    expect(validateSettings({ ...good, reminderEnabled: 'yes' }).ok).toBe(false);
    expect(validateSettings({ ...good, timeZone: 'Fake/Zone' }).ok).toBe(false);
    expect(validateSettings({ ...good, timeZone: 'Europe/London' }).ok).toBe(true);
  });

  it('rejects non-objects and unknown keys, listing every problem', () => {
    expect(validateSettings(null)).toEqual({ ok: false, errors: ['settings must be an object'] });
    expect(validateSettings([])).toMatchObject({ ok: false });
    const r = validateSettings({ ...good, newPerDay: 0, admin: true });
    expect(r).toEqual({
      ok: false,
      errors: ['newPerDay must be a whole number from 1 to 50', 'unknown setting admin'],
    });
  });
});

describe('validateResponse', () => {
  it.each([
    { type: 'mc', choice: 'A' },
    { type: 'multi', choices: ['A', 'D'] },
    { type: 'numeric', input: '$5' },
    { type: 'text', input: 'ADEA' },
    { type: 'ordering', order: ['A', 'B', 'C'] },
    { type: 'matching', pairs: { 1: 'A' } },
  ])('accepts %j', (r) => {
    expect(validateResponse(r)).toEqual({ ok: true, value: r });
  });

  it.each([
    null,
    'A',
    { type: 'essay', input: 'x' },
    { type: 'mc', choice: 5 },
    { type: 'mc', choice: 'A', extra: 1 },
    { type: 'mc', choice: 'x'.repeat(65) },
    { type: 'mc', choice: 'é'.repeat(33) }, // 66 bytes
    { type: 'multi', choices: 'A' },
    { type: 'multi', choices: [1] },
    { type: 'multi', choices: Array(21).fill('A') },
    { type: 'numeric', input: 5 },
    { type: 'ordering', order: [['A']] },
    { type: 'matching', pairs: ['A'] },
    { type: 'matching', pairs: { 1: 2 } },
    { type: 'matching', pairs: { ['k'.repeat(65)]: 'A' } },
    { type: 'matching', pairs: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [i, 'A'])) },
  ])('rejects %j', (r) => {
    expect(validateResponse(r).ok).toBe(false);
  });

  it(`rejects a response over ${MAX_RESPONSE_BYTES} bytes, measured as the database prints it`, () => {
    // Postgres prints {"type": "text", "input": "…"}: 29 bytes around the input.
    const fits = { type: 'text', input: 'x'.repeat(MAX_RESPONSE_BYTES - 29) };
    expect(jsonbText(fits)).toBe(`{"type": "text", "input": "${fits.input}"}`);
    expect(new TextEncoder().encode(jsonbText(fits)!).length).toBe(MAX_RESPONSE_BYTES);
    expect(validateResponse(fits).ok).toBe(true);
    expect(validateResponse({ type: 'text', input: 'x'.repeat(MAX_RESPONSE_BYTES - 28) }).ok).toBe(
      false,
    );
    expect(validateResponse({ type: 'text', input: 'é'.repeat(1100) }).ok).toBe(false); // 2,200 bytes
    expect(validateResponse({ type: 'text', input: 'x'.repeat(3000) })).toEqual({
      ok: false,
      errors: ['response is larger than 2048 bytes'],
    });
  });
});

describe('characters the database cannot store', () => {
  it.each(['a\u0000b', '\uD800', 'x\uDC00', '\uDC00\uD800'])('rejects %j', (input) => {
    expect(validateResponse({ type: 'text', input })).toEqual({
      ok: false,
      errors: ['response contains a character that cannot be stored'],
    });
    expect(validateResponse({ type: 'matching', pairs: { [input]: 'A' } }).ok).toBe(false);
    expect(validateResponse({ type: 'multi', choices: [input] }).ok).toBe(false);
  });

  it('accepts emoji, accents, curly quotes and control characters other than NUL', () => {
    for (const input of ['😀 café ’', 'line\nbreak\t', '\u0001'])
      expect(validateResponse({ type: 'text', input }).ok).toBe(true);
  });

  it('jsonbText formats nested values like Postgres', () => {
    expect(jsonbText({ a: [1, true, null, 'x'], b: {} })).toBe(
      '{"a": [1, true, null, "x"], "b": {}}',
    );
  });
});

describe('validateAttempt', () => {
  const bank = fakeBank();
  const a = attempt(q(bank, 'fake1-q03'), true, at('2026-10-13'));

  it('accepts a well-formed attempt and returns a clean copy', () => {
    expect(validateAttempt(a, NOW)).toEqual({ ok: true, value: a });
  });

  it.each<[string, unknown]>([
    ['id', 'not-a-uuid'],
    ['id', 'ABCDEF00-0000-4000-8000-00000000000A'],
    ['questionId', 'Bad Id'],
    ['questionId', `a-${'b'.repeat(2000)}`],
    ['questionId', 5],
    ['revision', 0],
    ['revision', 3.7],
    ['revision', '1'],
    ['answerFp', 'abc'],
    ['answerFp', 'G'.repeat(16)],
    ['correct', 'true'],
    ['xp', 4],
    ['xp', -1],
    ['xp', 3.7],
    ['mode', 'exam'],
    ['response', { type: 'mc' }],
    ['answeredAt', '2026-10-13'],
    ['answeredAt', '2026-10-15T00:00:01Z'], // more than 1 day ahead of NOW
  ])('rejects %s = %j', (field, value) => {
    const r = validateAttempt({ ...a, [field]: value }, NOW);
    expect(r.ok).toBe(false);
  });

  it('allows up to 1 day in the future (clock skew), and boundary values', () => {
    expect(validateAttempt({ ...a, answeredAt: '2026-10-14T20:00:00.000Z' }, NOW).ok).toBe(true);
    expect(validateAttempt({ ...a, xp: 0, correct: false }, NOW).ok).toBe(true);
    expect(validateAttempt({ ...a, xp: 3 }, NOW).ok).toBe(true);
    expect(validateAttempt({ ...a, revision: 1 }, NOW).ok).toBe(true);
  });

  it('a wrong answer earns no xp; unknown fields and non-objects are rejected', () => {
    expect(validateAttempt({ ...a, correct: false, xp: 2 }, NOW)).toEqual({
      ok: false,
      errors: ['a wrong answer earns 0 xp'],
    });
    expect(validateAttempt({ ...a, user_id: 'x' }, NOW)).toEqual({
      ok: false,
      errors: ['unknown field user_id'],
    });
    expect(validateAttempt([], NOW)).toEqual({ ok: false, errors: ['attempt must be an object'] });
  });
});
