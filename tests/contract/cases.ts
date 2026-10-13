// One shared table of boundary values for everything the app writes (BUILD_PLAN Phase 3,
// "App↔DB contract"). Each case says whether it must be accepted. The same table is run
// against the app's validator (tests/contract/cases.test.ts) and against the real database
// functions (supabase/tests/contract/contract.test.ts), so the two can never drift apart.
import { buildAttempt } from '../../src/data/answer';
import { jsonbText, MAX_RESPONSE_BYTES } from '../../src/domain/validate';
import type { Attempt, Bank, Response } from '../../src/domain/types';
import { defaultSettings } from '../../src/domain/validate';

export interface Case {
  name: string;
  value: unknown;
  /**
   * `server-dependent`: the app accepts it; whether the database does depends on its copy
   * of the time zone list (old alias names such as `US/Pacific` are missing from some).
   */
  accept: boolean | 'server-dependent';
}

const HOUR = 3_600_000;
const UUID = '00000000-0000-4000-8000-0000000c0001';

/** One valid response of each type for the fake bank (all correct answers). */
export const RESPONSES: Record<string, Response> = {
  'fake1-q01': { type: 'mc', choice: 'A' },
  'fake2-q01': { type: 'multi', choices: ['A', 'D'] },
  'fake2-q02': { type: 'numeric', input: '$504,000' },
  'fake2-q08': { type: 'text', input: 'Widget Wrangling.' },
  'fake2-q10': { type: 'ordering', order: ['C', 'A', 'E', 'B', 'D'] },
  'fake2-q11': { type: 'matching', pairs: { '1': 'B', '2': 'D', '3': 'A', '4': 'E' } },
};

/** A text response whose stored size is exactly `bytes`, built from `fill` after `prefix`. */
function textOfSize(bytes: number, prefix = '', fill = 'x'): Response {
  const r = { type: 'text' as const, input: prefix };
  const size = () => new TextEncoder().encode(jsonbText(r)!).length;
  while (size() < bytes) r.input += fill;
  if (size() !== bytes) throw new Error(`cannot hit ${bytes} bytes with ${JSON.stringify(fill)}`);
  return r;
}

const ids = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i));
const E32 = 'é'.repeat(32); // 32 characters, 64 bytes

export function attemptCases(bank: Bank, now: number): Case[] {
  const question = bank.questions.find((q) => q.id === 'fake1-q01')!;
  const base: Attempt = buildAttempt({
    bank,
    question,
    response: RESPONSES['fake1-q01']!,
    mode: 'lesson',
    now: new Date(now - 60_000),
    id: UUID,
  });
  const ok = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: true,
  });
  const bad = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: false,
  });
  const resp = (name: string, response: unknown, accept: boolean): Case => ({
    name: `response: ${name}`,
    value: { ...base, response },
    accept,
  });
  const at = (name: string, answeredAt: unknown, accept: boolean): Case => ({
    name: `answeredAt: ${name}`,
    value: { ...base, answeredAt },
    accept,
  });
  const without = (key: keyof Attempt): Case => {
    const v: Record<string, unknown> = { ...base };
    delete v[key];
    return { name: `missing ${key}`, value: v, accept: false };
  };

  return [
    ok('a normal answer', {}),
    ...Object.entries(RESPONSES).map(([id, response]) => {
      const q = bank.questions.find((x) => x.id === id)!;
      return {
        name: `a ${response.type} answer built by the app`,
        value: buildAttempt({
          bank,
          question: q,
          response,
          mode: 'lesson',
          now: new Date(now - 1000),
          id: UUID,
        }),
        accept: true,
      };
    }),
    // id
    bad('id: uppercase uuid', { id: UUID.toUpperCase() }),
    bad('id: not a uuid', { id: 'not-a-uuid' }),
    bad('id: number', { id: 5 }),
    without('id'),
    // questionId
    ok('questionId: 64 characters', { questionId: `${'a'.repeat(31)}-${'b'.repeat(32)}` }),
    bad('questionId: 65 characters', { questionId: `${'a'.repeat(32)}-${'b'.repeat(32)}` }),
    bad('questionId: 2,000 characters', { questionId: `a-${'b'.repeat(1998)}` }),
    bad('questionId: capitals', { questionId: 'Fake1-q01' }),
    bad('questionId: no hyphen', { questionId: 'fake1q01' }),
    bad('questionId: injection-shaped', { questionId: "x'); drop table attempts;--" }),
    // revision
    ok('revision: 1,000,000', { revision: 1_000_000 }),
    bad('revision: 0', { revision: 0 }),
    bad('revision: 1,000,001', { revision: 1_000_001 }),
    bad('revision: 3.7', { revision: 3.7 }),
    bad('revision: "1"', { revision: '1' }),
    bad('revision: -1', { revision: -1 }),
    // answerFp
    bad('answerFp: 15 hex', { answerFp: 'a'.repeat(15) }),
    bad('answerFp: 17 hex', { answerFp: 'a'.repeat(17) }),
    bad('answerFp: uppercase', { answerFp: 'A'.repeat(16) }),
    // correct / xp
    ok('xp 3 when correct', { correct: true, xp: 3 }),
    ok('xp 0 when wrong', { correct: false, xp: 0 }),
    bad('xp 1 when wrong', { correct: false, xp: 1 }),
    bad('xp 4', { xp: 4 }),
    bad('xp -1', { xp: -1 }),
    bad('xp 3.7', { xp: 3.7 }),
    bad('xp "1"', { xp: '1' }),
    bad('correct "true"', { correct: 'true' }),
    // mode
    ok('mode mistakes', { mode: 'mistakes' }),
    ok('mode ahead', { mode: 'ahead' }),
    bad('mode exam', { mode: 'exam' }),
    // response
    resp('mc extra key', { type: 'mc', choice: 'A', extra: 1 }, false),
    resp('mc choice is a number', { type: 'mc', choice: 5 }, false),
    resp('unknown type', { type: 'essay', input: 'x' }, false),
    resp('an array', ['A'], false),
    resp('null', null, false),
    resp('multi with 20 ids of 64 bytes', { type: 'multi', choices: ids(20, () => E32) }, true),
    resp('multi with 21 ids', { type: 'multi', choices: ids(21, (i) => `c${i}`) }, false),
    resp('multi id of 65 bytes', { type: 'multi', choices: [`${E32}a`] }, false),
    resp('multi id is a number', { type: 'multi', choices: [1] }, false),
    resp('ordering with 20 ids', { type: 'ordering', order: ids(20, (i) => `o${i}`) }, true),
    resp('ordering with 21 ids', { type: 'ordering', order: ids(21, (i) => `o${i}`) }, false),
    resp(
      'matching with 20 pairs',
      { type: 'matching', pairs: Object.fromEntries(ids(20, (i) => `p${i}`).map((k) => [k, 'A'])) },
      true,
    ),
    resp(
      'matching with 21 pairs',
      { type: 'matching', pairs: Object.fromEntries(ids(21, (i) => `p${i}`).map((k) => [k, 'A'])) },
      false,
    ),
    resp('matching value is a number', { type: 'matching', pairs: { '1': 2 } }, false),
    resp('matching key of 65 bytes', { type: 'matching', pairs: { [`${E32}a`]: 'A' } }, false),
    resp('numeric input is a number', { type: 'numeric', input: 5 }, false),
    resp(`text of exactly ${MAX_RESPONSE_BYTES} bytes`, textOfSize(MAX_RESPONSE_BYTES), true),
    resp(`text of ${MAX_RESPONSE_BYTES + 1} bytes`, textOfSize(MAX_RESPONSE_BYTES + 1), false),
    resp(
      `text of exactly ${MAX_RESPONSE_BYTES} bytes, 2-byte letters`,
      textOfSize(MAX_RESPONSE_BYTES, 'x', 'é'),
      true,
    ),
    resp(
      `text of exactly ${MAX_RESPONSE_BYTES} bytes with escaped characters`,
      textOfSize(MAX_RESPONSE_BYTES, '\t\n"\\\u0001\u007f /', 'x'),
      true,
    ),
    resp(
      `text of ${MAX_RESPONSE_BYTES + 1} bytes with escaped characters`,
      textOfSize(MAX_RESPONSE_BYTES + 1, '\t\n"\\\u0001\u007f /', 'x'),
      false,
    ),
    resp('text of 3 KB', { type: 'text', input: 'x'.repeat(3072) }, false),
    resp('text with a NUL character', { type: 'text', input: 'a\u0000b' }, false),
    resp('text with half an emoji', { type: 'text', input: 'a\ud83d' }, false),
    resp('text with a whole emoji', { type: 'text', input: 'a😀' }, true),
    resp(
      'text with injection-shaped input',
      { type: 'text', input: "'); delete from attempts; --" },
      true,
    ),
    resp(
      'text with markup',
      { type: 'text', input: '<img src=x onerror=alert(1)>"><script>' },
      true,
    ),
    // answeredAt
    at('with a +05:30 offset', new Date(now - HOUR).toISOString().replace('Z', '+05:30'), true),
    at('with microseconds', new Date(now - HOUR).toISOString().replace('Z', '123Z'), true),
    at('without fractions', new Date(now - HOUR).toISOString().replace(/\.\d+Z$/, 'Z'), true),
    at('23 hours ahead', new Date(now + 23 * HOUR).toISOString(), true),
    at('25 hours ahead', new Date(now + 25 * HOUR).toISOString(), false),
    at('in 2030', '2030-01-01T00:00:00.000Z', false),
    at('no zone', '2026-10-13T20:00:00', false),
    at('impossible date', '2026-02-30T12:00:00Z', false),
    at('hour 24', '2026-10-13T24:00:00Z', false),
    at('7 fraction digits', '2026-10-13T20:00:00.1234567Z', false),
    at('date only', '2026-10-13', false),
    at('a number', now, false),
    // shape
    bad('extra field user_id', { user_id: '00000000-0000-4000-8000-0000000000b1' }),
    { name: 'not an object', value: 'junk', accept: false },
  ];
}

export const US_ZONES = [
  'America/New_York',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Chicago',
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Juneau',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
];

export function settingsCases(): Case[] {
  const base = defaultSettings('America/Los_Angeles');
  const ok = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: true,
  });
  const bad = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: false,
  });
  const missing: Record<string, unknown> = { ...base };
  delete missing.timeZone;
  return [
    ok('the defaults', {}),
    ok('newPerDay 1', { newPerDay: 1 }),
    ok('newPerDay 50', { newPerDay: 50 }),
    bad('newPerDay 0', { newPerDay: 0 }),
    bad('newPerDay 51', { newPerDay: 51 }),
    bad('newPerDay 3.7', { newPerDay: 3.7 }),
    bad('newPerDay "15"', { newPerDay: '15' }),
    ok('lessonSize 5', { lessonSize: 5 }),
    ok('lessonSize 30', { lessonSize: 30 }),
    bad('lessonSize 4', { lessonSize: 4 }),
    bad('lessonSize 31', { lessonSize: 31 }),
    ok('dailyXpGoal 5', { dailyXpGoal: 5 }),
    ok('dailyXpGoal 200', { dailyXpGoal: 200 }),
    bad('dailyXpGoal 4', { dailyXpGoal: 4 }),
    bad('dailyXpGoal 201', { dailyXpGoal: 201 }),
    bad('dailyXpGoal 1e3', { dailyXpGoal: 1000 }),
    ok('examDate 2000-01-01', { examDate: '2000-01-01' }),
    ok('examDate 2100-12-31', { examDate: '2100-12-31' }),
    ok('examDate 2028-02-29', { examDate: '2028-02-29' }),
    bad('examDate 1999-12-31', { examDate: '1999-12-31' }),
    bad('examDate 2101-01-01', { examDate: '2101-01-01' }),
    bad('examDate 2026-02-30', { examDate: '2026-02-30' }),
    bad('examDate 2026-2-3', { examDate: '2026-2-3' }),
    bad('reminderEnabled "true"', { reminderEnabled: 'true' }),
    ok('reminderEnabled true', { reminderEnabled: true }),
    ok('reminderTime 00:00', { reminderTime: '00:00' }),
    ok('reminderTime 23:45', { reminderTime: '23:45' }),
    bad('reminderTime 15:07', { reminderTime: '15:07' }),
    bad('reminderTime 24:00', { reminderTime: '24:00' }),
    bad('reminderTime 9:00', { reminderTime: '9:00' }),
    bad('reminderTime 15:00:00', { reminderTime: '15:00:00' }),
    // Every US zone an iPhone reports, plus a few others: must be accepted everywhere.
    ...US_ZONES.concat([
      'UTC',
      'Europe/London',
      'Asia/Kolkata',
      'Etc/GMT+5',
      'Pacific/Chatham',
    ]).map((tz) => ok(`timeZone ${tz}`, { timeZone: tz })),
    ...['US/Pacific', 'Asia/Calcutta', 'America/Indianapolis'].map((tz) => ({
      name: `timeZone ${tz} (old alias)`,
      value: { ...base, timeZone: tz },
      accept: 'server-dependent' as const,
    })),
    ...['Fake/Zone', 'america/los_angeles', 'utc', '+05:00', '', 'x'.repeat(65)].map((tz) =>
      bad(`timeZone ${JSON.stringify(tz)}`, { timeZone: tz }),
    ),
    bad('unknown setting', { theme: 'dark' }),
    { name: 'missing timeZone', value: missing, accept: false },
    { name: 'not an object', value: [base], accept: false },
  ];
}

export function subscriptionCases(): Case[] {
  const base = {
    endpoint: 'https://push.example.test/abc',
    p256dh: 'B'.repeat(87),
    auth: 'c'.repeat(22),
  };
  const ok = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: true,
  });
  const bad = (name: string, patch: Record<string, unknown>): Case => ({
    name,
    value: { ...base, ...patch },
    accept: false,
  });
  return [
    ok('a normal subscription', {}),
    ok('endpoint of 1,024 bytes', { endpoint: `https://${'x'.repeat(1016)}` }),
    bad('endpoint of 1,025 bytes', { endpoint: `https://${'x'.repeat(1017)}` }),
    bad('endpoint of 1,025 bytes, 2-byte letters', { endpoint: `https://${'é'.repeat(508)}x` }),
    bad('endpoint over http', { endpoint: 'http://push.example.test/abc' }),
    bad('endpoint HTTPS in capitals', { endpoint: 'HTTPS://push.example.test/abc' }),
    bad('endpoint with a NUL character', { endpoint: 'https://x/\u0000' }),
    ok('p256dh of 16', { p256dh: 'A'.repeat(16) }),
    ok('p256dh of 255', { p256dh: 'A'.repeat(255) }),
    bad('p256dh of 15', { p256dh: 'A'.repeat(15) }),
    bad('p256dh of 256', { p256dh: 'A'.repeat(256) }),
    bad('p256dh with +', { p256dh: `${'A'.repeat(16)}+` }),
    bad('p256dh with a newline', { p256dh: `${'A'.repeat(16)}\n` }),
    ok('auth of 8', { auth: 'a'.repeat(8) }),
    bad('auth of 7', { auth: 'a'.repeat(7) }),
    bad('auth with /', { auth: `${'a'.repeat(8)}/` }),
  ];
}
