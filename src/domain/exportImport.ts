// Progress export file and import preview (BUILD_PLAN 1h). Import is a merge: it adds
// answers that are not already present and never removes anything. Settings are restored
// only when the user ticks "also restore settings".
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { validateAttempt, validateSettings } from './validate';
import type { Attempt, Settings } from './types';

export const EXPORT_FORMAT = 'sphr-flashcards-progress';
export const EXPORT_VERSION = 1;
/** A file larger than this is refused before parsing (about 40x a year of daily study). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  bankVersion: string;
  /**
   * A short fingerprint of the account the file came from (audit L4), so an import into a
   * different account is flagged. Not the account id itself. Files from before have none.
   */
  account?: string;
  attempts: Attempt[];
  settings: Settings;
}

/** The account fingerprint written into exports: 16 hex digits of a SHA-256 of the user id. */
export function accountFingerprint(userId: string): string {
  return bytesToHex(sha256(utf8ToBytes(`sphr-flashcards-account:${userId}`))).slice(0, 16);
}

export function buildExport(input: {
  attempts: readonly Attempt[];
  settings: Settings;
  bankVersion: string;
  now: Date;
  userId: string;
}): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: input.now.toISOString(),
    bankVersion: input.bankVersion,
    account: accountFingerprint(input.userId),
    attempts: [...input.attempts],
    settings: input.settings,
  };
}

export interface Rejected {
  index: number;
  id: string | null;
  reason: string;
}

export interface ImportPreview {
  /** Answers that would be added. */
  added: Attempt[];
  /** How many answers in the file are already present. */
  present: number;
  rejected: Rejected[];
  /** The file's settings, if valid (applied only when the user asks). */
  settings: Settings | null;
  settingsError: string | null;
  /** The file says it came from a different account (audit L4). */
  otherAccount: boolean;
  /** How many of the answers to add are for questions not in the current bank (audit L4). */
  unknownQuestions: number;
}

/** What the preview compares the file with: this account, and the questions it knows. */
export interface ImportContext {
  userId: string;
  /** null while the bank is not loaded yet (then nothing is counted as unknown). */
  questionIds: ReadonlySet<string> | null;
}

export type ParseResult = { ok: true; preview: ImportPreview } | { ok: false; error: string };

/**
 * Reads an export file's text and compares it with the answers already on this device.
 * Nothing is written here: the caller shows the preview, asks for confirmation, then saves
 * `added` through the normal write path.
 */
export function previewImport(
  text: string,
  existing: readonly Attempt[],
  now: number,
  context: ImportContext,
): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    return { ok: false, error: 'The file is too large to be a progress export.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not a progress export (it is not valid JSON).' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ok: false, error: 'The file is not a progress export.' };
  const file = data as Record<string, unknown>;
  if (file.format !== EXPORT_FORMAT)
    return { ok: false, error: 'The file is not an SPHR Flashcards progress export.' };
  if (file.version !== EXPORT_VERSION)
    return {
      ok: false,
      error: `This export is version ${String(file.version)}; this app reads version 1.`,
    };
  if (!Array.isArray(file.attempts))
    return { ok: false, error: 'The file has no list of answers.' };

  const known = new Set(existing.map((a) => a.id));
  const added: Attempt[] = [];
  const rejected: Rejected[] = [];
  let present = 0;
  file.attempts.forEach((raw: unknown, index) => {
    const r = validateAttempt(raw, now);
    if (!r.ok) {
      const id =
        typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : null;
      rejected.push({ index, id, reason: r.errors.join('; ') });
    } else if (known.has(r.value.id)) present++;
    else {
      known.add(r.value.id);
      added.push(r.value);
    }
  });

  const s = validateSettings(file.settings);
  return {
    ok: true,
    preview: {
      added,
      present,
      rejected,
      settings: s.ok ? s.value : null,
      settingsError: s.ok ? null : s.errors.join('; '),
      otherAccount:
        file.account !== undefined && file.account !== accountFingerprint(context.userId),
      unknownQuestions: context.questionIds
        ? added.filter((a) => !context.questionIds!.has(a.questionId)).length
        : 0,
    },
  };
}
