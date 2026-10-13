// Shared test helpers. Uses the fake sample bank; the real bank is only ever read.
import { answerFp, normalizeBank } from '../src/domain/bank';
import type { Attempt, Bank, Mode, Question, Response } from '../src/domain/types';
import sample from './fixtures/sample-bank.json';
import real from '../content/questions.json';

function load(raw: unknown): Bank {
  const r = normalizeBank(structuredClone(raw));
  if (!r.ok) throw new Error(r.error);
  if (r.dropped.length) throw new Error(`dropped: ${JSON.stringify(r.dropped)}`);
  return r.bank;
}

export const fakeBank = (): Bank => load(sample);
export const realBank = (): Bank => load(real);
export const rawSample = (): Record<string, unknown> & { questions: Record<string, unknown>[] } =>
  structuredClone(sample) as never;

export function q<T extends Question['type']>(bank: Bank, id: string, type?: T) {
  const found = bank.questions.find((x) => x.id === id);
  if (!found) throw new Error(`no question ${id}`);
  if (type && found.type !== type) throw new Error(`${id} is ${found.type}, not ${type}`);
  return found as Extract<Question, { type: T }>;
}

let counter = 0;
/** A deterministic, valid lowercase uuid. */
export function uuid(n = ++counter): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function attempt(
  question: Question,
  correct: boolean,
  answeredAt: string,
  extra: Partial<Attempt> = {},
): Attempt {
  const response: Response =
    question.type === 'numeric' || question.type === 'text'
      ? { type: question.type, input: 'x' }
      : { type: 'mc', choice: 'A' };
  return {
    id: uuid(),
    questionId: question.id,
    revision: question.revision,
    answerFp: answerFp(question),
    correct,
    xp: correct ? { K: 1, A: 2, S: 3 }[question.level] : 0,
    mode: 'lesson' as Mode,
    response,
    answeredAt,
    ...extra,
  };
}

/** Noon UTC on a date, as an ISO timestamp (the same calendar day in Los Angeles). */
export const at = (date: string, hour = 20) =>
  `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
export const TZ = 'America/Los_Angeles';
