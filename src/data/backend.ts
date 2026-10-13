// The app's view of the server, and the conversions between the server's JSON and the
// domain types. The real implementation (supabaseBackend.ts) and the test fake both
// convert through these functions, and the contract test (supabase/tests/60_contract)
// checks them against the real database.
import { validateAttempt, validateSettings } from '../domain/validate';
import type { Attempt, Settings } from '../domain/types';

export interface VersionedSettings {
  settings: Settings;
  version: number;
}

export interface RejectedAnswer {
  index: number;
  id: string | null;
  reason: string;
}

/** What `apply_changes` returns, in the app's spelling. */
export interface ApplyResult {
  inserted: number;
  duplicates: number;
  rejected: RejectedAnswer[];
  settingsVersion: number | null;
  settingsConflict: boolean;
  serverSettings: VersionedSettings | null;
  settingsError: string | null;
  maxSeq: number | null;
}

export interface PulledAttempt {
  seq: number;
  attempt: Attempt;
}

export interface Backend {
  /** The one write path (`apply_changes`). At most 200 answers per call. */
  applyChanges(
    attempts: readonly Attempt[],
    settings: Settings | null,
    settingsBaseVersion: number | null,
  ): Promise<ApplyResult>;
  /** Answers with `seq > afterSeq`, oldest first, at most `limit`. Bad rows are reported. */
  pullAttempts(afterSeq: number, limit: number): Promise<PullPage>;
  /** The saved settings, or null if this account has none yet. */
  getSettings(): Promise<VersionedSettings | null>;
  /** The version of the question bank on the server, or null if none was imported yet. */
  getBankVersion(): Promise<string | null>;
  /**
   * The whole question bank on the server, as untrusted JSON in the file's shape (the
   * loader normalizes it), or null if none was imported yet. Throws if the bank changed
   * while it was being read.
   */
  getBank(): Promise<unknown>;
}

export interface PullPage {
  rows: PulledAttempt[];
  /** Highest seq seen on this page (including bad rows), or null if the page was empty. */
  lastSeq: number | null;
  /** Rows that could not be read, with the reason. */
  bad: string[];
}

/** The columns the app reads from `attempts` (PostgREST select list). */
export const ATTEMPT_COLUMNS =
  'seq,id,question_id,revision,answer_fp,correct,xp,mode,response,answered_at';
/** The columns the app reads from `settings`. */
export const SETTINGS_COLUMNS =
  'new_per_day,lesson_size,daily_xp_goal,exam_date,reminder_enabled,reminder_time,time_zone,version';
/** The columns the app reads from `bank_meta`. */
export const BANK_META_COLUMNS = 'schema_version,bank_version,areas,levels';
/** Rows per request when reading questions and scenarios (Supabase returns at most 1,000). */
export const BANK_PAGE = 1000;
export const MAX_BATCH = 200;
export const PULL_PAGE = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * The one spelling of a timestamp used everywhere (`2026-10-13T20:00:00.000Z`). The server
 * prints `2026-10-13 20:00:00+00` or `…+00:00`; both become the same text, so a device's own
 * copy of an answer and the copy pulled back from the server are identical.
 */
export function canonicalTimestamp(s: string): string {
  return new Date(s).toISOString();
}

/** An answer exactly as it is stored on the phone and sent to the server. */
export function canonicalAttempt(a: Attempt): Attempt {
  return { ...a, answeredAt: canonicalTimestamp(a.answeredAt) };
}

/** A row of `attempts` (as PostgREST returns it) → an Attempt, or the reason it is unreadable. */
export function fromServerAttempt(
  row: unknown,
): { ok: true; value: PulledAttempt } | { ok: false; error: string } {
  if (!isObj(row) || !Number.isSafeInteger(row.seq) || typeof row.answered_at !== 'string')
    return { ok: false, error: 'malformed answer row' };
  const ts = Date.parse(row.answered_at);
  if (Number.isNaN(ts)) return { ok: false, error: 'malformed answer row' };
  const candidate = {
    id: row.id,
    questionId: row.question_id,
    revision: row.revision,
    answerFp: row.answer_fp,
    correct: row.correct,
    xp: row.xp,
    mode: row.mode,
    response: row.response,
    answeredAt: new Date(ts).toISOString(),
  };
  // The "not in the future" check is the server's job for stored rows; device clocks differ.
  const r = validateAttempt(candidate, Number.POSITIVE_INFINITY);
  if (!r.ok) return { ok: false, error: `answer ${String(row.id)}: ${r.errors.join('; ')}` };
  return { ok: true, value: { seq: row.seq as number, attempt: r.value } };
}

/** A row of `settings` (PostgREST: `15:00:00`, `2026-12-15`) → VersionedSettings. */
export function fromServerSettingsRow(row: unknown): VersionedSettings {
  if (!isObj(row)) throw new Error('The server sent unreadable settings.');
  return checkSettings(
    {
      newPerDay: row.new_per_day,
      lessonSize: row.lesson_size,
      dailyXpGoal: row.daily_xp_goal,
      examDate: row.exam_date,
      reminderEnabled: row.reminder_enabled,
      reminderTime:
        typeof row.reminder_time === 'string'
          ? row.reminder_time.replace(/^(\d{2}:\d{2}):00$/, '$1')
          : row.reminder_time,
      timeZone: row.time_zone,
    },
    row.version,
  );
}

/** `settings_json()` output (already camelCase, with `version`) → VersionedSettings. */
export function fromSettingsJson(v: unknown): VersionedSettings {
  if (!isObj(v)) throw new Error('The server sent unreadable settings.');
  const { version, ...settings } = v;
  return checkSettings(settings, version);
}

function checkSettings(settings: unknown, version: unknown): VersionedSettings {
  const r = validateSettings(settings);
  if (!r.ok || !Number.isInteger(version) || (version as number) < 1)
    throw new Error(
      `The server sent settings this app cannot read${r.ok ? '' : `: ${r.errors.join('; ')}`}.`,
    );
  return { settings: r.value, version: version as number };
}

/** The raw JSON from `apply_changes` → ApplyResult. Throws if the shape is unexpected. */
export function parseApplyResult(raw: unknown): ApplyResult {
  if (
    !isObj(raw) ||
    !isCount(raw.inserted) ||
    !isCount(raw.duplicates) ||
    !Array.isArray(raw.rejected) ||
    typeof raw.settings_conflict !== 'boolean' ||
    !(raw.settings_version === null || isCount(raw.settings_version)) ||
    !(raw.max_seq === null || isCount(raw.max_seq)) ||
    !(raw.settings_error === null || typeof raw.settings_error === 'string')
  )
    throw new Error('The server sent an unexpected reply.');
  const rejected = raw.rejected.map((x: unknown) => {
    if (!isObj(x) || !isCount(x.index) || typeof x.reason !== 'string')
      throw new Error('The server sent an unexpected reply.');
    return { index: x.index, id: typeof x.id === 'string' ? x.id : null, reason: x.reason };
  });
  return {
    inserted: raw.inserted,
    duplicates: raw.duplicates,
    rejected,
    settingsVersion: raw.settings_version,
    settingsConflict: raw.settings_conflict,
    serverSettings: raw.server_settings == null ? null : fromSettingsJson(raw.server_settings),
    settingsError: raw.settings_error,
    maxSeq: raw.max_seq,
  };
}

/** The `bank_meta` row → its bank version (null if the row is missing or unreadable). */
export function bankVersionOf(meta: unknown): string | null {
  return isObj(meta) && typeof meta.bank_version === 'string' ? meta.bank_version : null;
}

/**
 * The server's tables → a bank in the file's shape (`content/questions.json`). Each row's
 * `data` is the question or scenario exactly as imported. The result is still untrusted:
 * the loader normalizes it like any other copy.
 */
export function assembleServerBank(
  meta: unknown,
  scenarioRows: readonly unknown[],
  questionRows: readonly unknown[],
): unknown {
  if (!isObj(meta)) throw new Error('The server sent an unreadable question bank.');
  const data = (r: unknown) => (isObj(r) ? r.data : r);
  return {
    schemaVersion: meta.schema_version,
    bankVersion: meta.bank_version,
    areas: meta.areas,
    levels: meta.levels,
    scenarios: scenarioRows.map(data),
    questions: questionRows.map(data),
  };
}
