// XP: a correct answer earns its tier's points, read from the bank. No bonuses.
import { localDateOf } from './dates';
import type { Attempt, Bank, LocalDate, Question } from './types';

export function xpFor(bank: Bank, q: Question, correct: boolean): number {
  return correct ? bank.levels[q.level].points : 0;
}

export function totalXp(attempts: readonly Attempt[]): number {
  return attempts.reduce((sum, a) => sum + a.xp, 0);
}

/** XP earned on one local calendar day in the given time zone. */
export function dailyXp(attempts: readonly Attempt[], day: LocalDate, timeZone: string): number {
  return attempts.reduce(
    (sum, a) => (localDateOf(a.answeredAt, timeZone) === day ? sum + a.xp : sum),
    0,
  );
}
