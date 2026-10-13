// The one domain validator for everything written (CLAUDE.md §2 "validate on write").
// The database constraints (Phase 2) mirror these rules exactly. Bad values are rejected,
// never rounded or clamped.
import { ID_RE } from './bank';
import { isIsoTimestamp, isLocalDate, isTimeZone } from './dates';
import { MODES, type Attempt, type Mode, type Response, type Settings } from './types';

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const SETTINGS_LIMITS = {
  newPerDay: { min: 1, max: 50 },
  lessonSize: { min: 5, max: 30 },
  dailyXpGoal: { min: 5, max: 200 },
} as const;

export const MAX_RESPONSE_BYTES = 2048;
export const MAX_QUESTION_ID = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP_RE = /^[0-9a-f]{16}$/;
const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Defaults; `timeZone` is the device's zone at first run. */
export function defaultSettings(timeZone: string): Settings {
  return {
    newPerDay: 15,
    lessonSize: 10,
    dailyXpGoal: 30,
    examDate: '2026-12-15',
    // Off until she turns it on: iOS only allows the permission prompt from a tap.
    reminderEnabled: false,
    reminderTime: '15:00',
    timeZone,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const SETTINGS_KEYS = [
  'newPerDay',
  'lessonSize',
  'dailyXpGoal',
  'examDate',
  'reminderEnabled',
  'reminderTime',
  'timeZone',
] as const;

export function validateSettings(v: unknown): Result<Settings> {
  if (!isObj(v)) return { ok: false, errors: ['settings must be an object'] };
  const errors: string[] = [];
  for (const k of ['newPerDay', 'lessonSize', 'dailyXpGoal'] as const) {
    const { min, max } = SETTINGS_LIMITS[k];
    if (!isIntIn(v[k], min, max)) errors.push(`${k} must be a whole number from ${min} to ${max}`);
  }
  if (!isLocalDate(v.examDate)) errors.push('examDate must be a real date YYYY-MM-DD');
  if (typeof v.reminderEnabled !== 'boolean') errors.push('reminderEnabled must be true or false');
  if (typeof v.reminderTime !== 'string' || !TIME_RE.test(v.reminderTime))
    errors.push('reminderTime must be HH:MM in 15-minute steps');
  if (!isTimeZone(v.timeZone)) errors.push('timeZone must be a real IANA time zone');
  for (const k of Object.keys(v))
    if (!(SETTINGS_KEYS as readonly string[]).includes(k)) errors.push(`unknown setting ${k}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, v[k]])) as unknown as Settings,
  };
}

const isIdList = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 64);

export function validateResponse(v: unknown): Result<Response> {
  if (!isObj(v)) return { ok: false, errors: ['response must be an object'] };
  const keys = Object.keys(v).sort().join(',');
  let ok = false;
  switch (v.type) {
    case 'mc':
      ok = keys === 'choice,type' && typeof v.choice === 'string' && v.choice.length <= 64;
      break;
    case 'multi':
      ok = keys === 'choices,type' && isIdList(v.choices, 20);
      break;
    case 'numeric':
    case 'text':
      ok = keys === 'input,type' && typeof v.input === 'string';
      break;
    case 'ordering':
      ok = keys === 'order,type' && isIdList(v.order, 20);
      break;
    case 'matching':
      ok =
        keys === 'pairs,type' &&
        isObj(v.pairs) &&
        Object.keys(v.pairs).length <= 20 &&
        Object.entries(v.pairs).every(
          ([k, x]) => k.length <= 64 && typeof x === 'string' && x.length <= 64,
        );
      break;
  }
  if (!ok) return { ok: false, errors: ['response has the wrong shape for its type'] };
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_RESPONSE_BYTES)
    return { ok: false, errors: [`response is larger than ${MAX_RESPONSE_BYTES} bytes`] };
  return { ok: true, value: v as Response };
}

const ATTEMPT_KEYS = [
  'id',
  'questionId',
  'revision',
  'answerFp',
  'correct',
  'xp',
  'mode',
  'response',
  'answeredAt',
] as const;

/** `now` is injected (ms since epoch) so the check is pure. */
export function validateAttempt(v: unknown, now: number): Result<Attempt> {
  if (!isObj(v)) return { ok: false, errors: ['attempt must be an object'] };
  const errors: string[] = [];
  if (typeof v.id !== 'string' || !UUID_RE.test(v.id)) errors.push('id must be a lowercase uuid');
  if (
    typeof v.questionId !== 'string' ||
    v.questionId.length > MAX_QUESTION_ID ||
    !ID_RE.test(v.questionId)
  )
    errors.push('questionId has an invalid format');
  if (!isIntIn(v.revision, 1, 1_000_000)) errors.push('revision must be a whole number >= 1');
  if (typeof v.answerFp !== 'string' || !FP_RE.test(v.answerFp))
    errors.push('answerFp must be 16 hex characters');
  if (typeof v.correct !== 'boolean') errors.push('correct must be true or false');
  if (!isIntIn(v.xp, 0, 3)) errors.push('xp must be a whole number from 0 to 3');
  if (v.correct === false && v.xp !== 0) errors.push('a wrong answer earns 0 xp');
  if (!MODES.includes(v.mode as Mode)) errors.push('mode is invalid');
  const r = validateResponse(v.response);
  if (!r.ok) errors.push(...r.errors);
  if (!isIsoTimestamp(v.answeredAt)) errors.push('answeredAt must be an ISO timestamp');
  else if (Date.parse(v.answeredAt) > now + DAY_MS)
    errors.push('answeredAt is more than 1 day in the future');
  for (const k of Object.keys(v))
    if (!(ATTEMPT_KEYS as readonly string[]).includes(k)) errors.push(`unknown field ${k}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: Object.fromEntries(ATTEMPT_KEYS.map((k) => [k, v[k]])) as unknown as Attempt,
  };
}
