// Types for the question bank (docs/QUESTION_FORMAT.md, schema v1), attempts and settings.

export type QuestionType = 'mc' | 'multi' | 'numeric' | 'text' | 'ordering' | 'matching';
export type Level = 'K' | 'A' | 'S';
export type AreaId = 1 | 2 | 3 | 4 | 5;
export type Status = 'active' | 'retired';
/** A calendar date `YYYY-MM-DD` in the user's time zone. */
export type LocalDate = string;

export const QUESTION_TYPES: readonly QuestionType[] = [
  'mc',
  'multi',
  'numeric',
  'text',
  'ordering',
  'matching',
];
export const LEVELS: readonly Level[] = ['K', 'A', 'S'];
export const AREA_IDS: readonly AreaId[] = [1, 2, 3, 4, 5];

export interface Labeled {
  id: string;
  text: string;
}

export interface Area {
  id: AreaId;
  name: string;
}

export interface LevelInfo {
  name: string;
  points: number;
}

export interface Scenario {
  id: string;
  area: AreaId;
  title: string;
  text: string;
}

interface QuestionBase {
  id: string;
  area: AreaId;
  level: Level;
  outline: string[];
  category: string | null;
  scenarioId: string | null;
  stem: string;
  explanation: string;
  revision: number;
  status: Status;
  added: string;
}

export interface McQuestion extends QuestionBase {
  type: 'mc';
  choices: Labeled[];
  answer: string;
}
export interface MultiQuestion extends QuestionBase {
  type: 'multi';
  choices: Labeled[];
  answer: string[];
  selectCount: number;
}
export interface NumericQuestion extends QuestionBase {
  type: 'numeric';
  answer: { value: number; tolerance: number; unit: string };
  displayAnswer: string;
}
export interface TextQuestion extends QuestionBase {
  type: 'text';
  accepted: string[];
  displayAnswer: string;
}
export interface OrderingQuestion extends QuestionBase {
  type: 'ordering';
  items: Labeled[];
  answer: string[];
}
export interface MatchingQuestion extends QuestionBase {
  type: 'matching';
  prompts: Labeled[];
  options: Labeled[];
  answer: Record<string, string>;
  note: string | null;
}

export type Question =
  McQuestion | MultiQuestion | NumericQuestion | TextQuestion | OrderingQuestion | MatchingQuestion;

export interface Bank {
  schemaVersion: 1;
  bankVersion: string;
  areas: Area[];
  levels: Record<Level, LevelInfo>;
  scenarios: Scenario[];
  questions: Question[];
}

/** What the user submitted. Always ids, never display positions, so shuffling cannot affect grading. */
export type Response =
  | { type: 'mc'; choice: string }
  | { type: 'multi'; choices: string[] }
  | { type: 'numeric'; input: string }
  | { type: 'text'; input: string }
  | { type: 'ordering'; order: string[] }
  | { type: 'matching'; pairs: Record<string, string> };

export type Mode = 'lesson' | 'mistakes' | 'ahead';
export const MODES: readonly Mode[] = ['lesson', 'mistakes', 'ahead'];

/** One answer. Append-only: never edited or deleted. */
export interface Attempt {
  id: string;
  questionId: string;
  revision: number;
  answerFp: string;
  correct: boolean;
  xp: number;
  mode: Mode;
  response: Response;
  /** ISO 8601 timestamp. */
  answeredAt: string;
}

export interface Settings {
  newPerDay: number;
  lessonSize: number;
  dailyXpGoal: number;
  examDate: LocalDate;
  reminderEnabled: boolean;
  /** `HH:MM`, on a 15-minute grid. */
  reminderTime: string;
  /** IANA time zone, e.g. `America/Los_Angeles`. */
  timeZone: string;
}

export interface CardState {
  /** 0 = new, 1..5 = Leitner box. */
  box: number;
  due: LocalDate | null;
  /** Correct answers in a row. */
  streak: number;
  inMistakes: boolean;
  lastAnswered: LocalDate | null;
  firstSeen: LocalDate | null;
  /** Date of the most recent wrong answer (orders the Mistakes deck). */
  lastWrong: LocalDate | null;
}
