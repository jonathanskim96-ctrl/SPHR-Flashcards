// Lesson builder (BUILD_PLAN 1f). Pure: the caller supplies today's date and card states.
import { stateOf } from './replay';
import type { AreaId, Bank, CardState, Level, LocalDate, Mode, Question, Settings } from './types';

export interface Selection {
  areas: readonly AreaId[];
  tiers: readonly Level[];
}

export interface LessonInput {
  bank: Bank;
  states: ReadonlyMap<string, CardState>;
  settings: Pick<Settings, 'newPerDay' | 'lessonSize'>;
  today: LocalDate;
  selection: Selection;
  mode: Mode;
}

const TIER_ORDER: Record<Level, number> = { K: 0, A: 1, S: 2 };

/** New cards first seen today, across all areas (the daily new-card cap counts these). */
export function newCardsToday(states: ReadonlyMap<string, CardState>, today: LocalDate): number {
  let n = 0;
  for (const s of states.values()) if (s.firstSeen === today) n++;
  return n;
}

export function buildLesson(input: LessonInput): Question[] {
  const { bank, states, settings, today, selection, mode } = input;
  const pool = bank.questions
    .map((q, index) => ({ q, index, s: stateOf(states, q.id) }))
    .filter(
      ({ q, s }) =>
        q.status === 'active' &&
        selection.areas.includes(q.area) &&
        selection.tiers.includes(q.level) &&
        s.lastAnswered !== today,
    );
  const size = settings.lessonSize;

  if (mode === 'mistakes')
    return pool
      .filter(({ s }) => s.inMistakes)
      .map((e) => ({ ...e, wrongOn: e.s.lastWrong ?? '' }))
      .sort((a, b) => cmp(a.wrongOn, b.wrongOn) || a.index - b.index)
      .slice(0, size)
      .map(({ q }) => q);

  // Cards that have been answered, with their due date.
  const scheduled = pool.flatMap((e) =>
    e.s.box > 0 && e.s.due !== null ? [{ ...e, due: e.s.due }] : [],
  );

  if (mode === 'ahead')
    return scheduled
      .filter((e) => e.due > today)
      .sort((a, b) => cmp(a.due, b.due) || a.index - b.index)
      .slice(0, size)
      .map(({ q }) => q);

  const due = scheduled
    .filter((e) => e.due <= today)
    .sort((a, b) => cmp(a.due, b.due) || a.s.box - b.s.box || a.index - b.index)
    .map(({ q }) => q);
  const newLeft = Math.max(0, settings.newPerDay - newCardsToday(states, today));
  const fresh = pool
    .filter(({ s }) => s.box === 0)
    .sort((a, b) => TIER_ORDER[a.q.level] - TIER_ORDER[b.q.level] || a.index - b.index)
    .slice(0, newLeft)
    .map(({ q }) => q);
  return [...due, ...fresh].slice(0, size);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * After the bank changed mid-lesson (BUILD_PLAN Phase 4): the rest of the lesson in the new
 * bank's version of each card. Cards that were retired or are no longer in the bank drop out.
 */
export function refreshLesson(remaining: readonly Question[], bank: Bank): Question[] {
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  return remaining.flatMap((q) => {
    const now = byId.get(q.id);
    return now && now.status === 'active' ? [now] : [];
  });
}
