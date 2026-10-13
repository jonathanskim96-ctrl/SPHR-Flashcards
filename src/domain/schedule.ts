// Exam-aware Leitner boxes (BUILD_PLAN 1d). Box 0 = new; intervals 1, 3, 7, 14, 21 days.
// Never due after the exam date while answered before it. Wrong → box 1, due tomorrow,
// into Mistakes. Two correct answers in a row take a card out of Mistakes (and master it).
import { addDays } from './dates';
import type { CardState, LocalDate } from './types';

export const INTERVALS = [1, 3, 7, 14, 21] as const;
export const MAX_BOX = INTERVALS.length;

export const NEW_CARD: Readonly<CardState> = Object.freeze({
  box: 0,
  due: null,
  streak: 0,
  inMistakes: false,
  lastAnswered: null,
  firstSeen: null,
  lastWrong: null,
});

export function applyAnswer(
  state: CardState,
  correct: boolean,
  today: LocalDate,
  examDate: LocalDate,
): CardState {
  const box = correct ? Math.min(state.box + 1, MAX_BOX) : 1;
  const interval = INTERVALS[box - 1] as number;
  const streak = correct ? state.streak + 1 : 0;
  const inMistakes = correct ? state.inMistakes && streak < 2 : true;
  let due = addDays(today, interval);
  if (today < examDate && due > examDate) due = examDate;
  return {
    box,
    due,
    streak,
    inMistakes,
    lastAnswered: today,
    firstSeen: state.firstSeen ?? today,
    lastWrong: correct ? state.lastWrong : today,
  };
}

/** Mastered = the last 2 reviews were correct. */
export function mastered(state: CardState): boolean {
  return state.streak >= 2;
}
