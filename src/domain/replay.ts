// Card state is never stored: it is recomputed from the append-only attempt history.
// Two devices' histories merge as a set union by attempt id, and replay gives the same
// state everywhere (BUILD_PLAN "the attempt log is the source of truth").
import { answerFp } from './bank';
import { localDateOf } from './dates';
import { applyAnswer, NEW_CARD } from './schedule';
import type { Attempt, Bank, CardState, Settings } from './types';

/** Union by attempt id (the first copy wins), in replay order: answeredAt, then id. */
export function mergeAttempts(...sets: readonly (readonly Attempt[])[]): Attempt[] {
  const byId = new Map<string, Attempt>();
  for (const set of sets) for (const a of set) if (!byId.has(a.id)) byId.set(a.id, a);
  return sortAttempts([...byId.values()]);
}

export function sortAttempts(attempts: readonly Attempt[]): Attempt[] {
  return [...attempts].sort(
    (a, b) =>
      Date.parse(a.answeredAt) - Date.parse(b.answeredAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * State per question id. Attempts for unknown questions, or made against a different
 * answer fingerprint (the answer changed since), are ignored for scheduling. Retired
 * questions keep their state; lessons and progress leave them out.
 */
export function replay(
  attempts: readonly Attempt[],
  bank: Bank,
  settings: Pick<Settings, 'examDate' | 'timeZone'>,
): Map<string, CardState> {
  const fps = new Map(bank.questions.map((q) => [q.id, answerFp(q)]));
  const states = new Map<string, CardState>();
  for (const a of mergeAttempts(attempts)) {
    if (fps.get(a.questionId) !== a.answerFp) continue;
    const today = localDateOf(a.answeredAt, settings.timeZone);
    states.set(
      a.questionId,
      applyAnswer(states.get(a.questionId) ?? NEW_CARD, a.correct, today, settings.examDate),
    );
  }
  return states;
}

export function stateOf(states: ReadonlyMap<string, CardState>, id: string): CardState {
  return states.get(id) ?? NEW_CARD;
}
