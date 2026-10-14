// IndexedDB on the phone: one database per signed-in user, so two accounts can never mix.
// Stores (BUILD_PLAN Phase 3):
//   bank      the cached question bank (Phase 4)
//   attempts  every known answer, by id (this device's and those pulled from the server)
//   outbox    changes not yet confirmed by the server, in order (auto-increment key `n`)
//   settings  the current settings and the server version they are based on
//   meta      sync cursor, last sync time, last export date, unread notices
import { unwrap, wrap, type DBSchema, type IDBPDatabase } from 'idb';
import type { Attempt, Settings } from '../domain/types';

export type OutboxItem =
  | {
      n?: number;
      kind: 'attempt';
      attempt: Attempt;
      /**
       * The server refused it (audit L3). It stays queued, so sign-out still waits for it and
       * it is offered again on each sync (a phone clock that ran ahead catches up); the
       * notice is shown only the first time.
       */
      refused?: boolean;
    }
  | { n?: number; kind: 'settings' };

export interface SettingsRecord {
  settings: Settings;
  /** The server version these settings are based on; null if never saved on the server. */
  version: number | null;
  /**
   * Settings sent on top of `version` whose reply never arrived (audit L2). If the server
   * later reports a conflict and its copy is one of these, that earlier save did land.
   */
  sent?: Settings[];
  /** True while these are untouched defaults (a server copy then wins without a message). */
  isDefault: boolean;
}

export interface Meta {
  /** Highest server `seq` pulled so far. */
  cursor: number;
  /**
   * Where the next pull starts (audit M1). Server `seq` numbers are handed out before a save
   * commits, so a save from another phone can appear later with a lower number than one
   * already pulled. Everything up to `settled` was pulled at least SETTLE_MS after it was
   * the cursor, so nothing below it can still appear; pulls re-read from there.
   */
  settled: number;
  /** The cursor at the last pull and when (ms); becomes `settled` once SETTLE_MS old. */
  recent: { seq: number; at: number } | null;
  lastSyncAt: string | null;
  lastExportAt: string | null;
  /** Messages for the user that survive a reload until dismissed (rejections, conflicts). */
  notices: string[];
  /** The one-time Home card offering the daily reminder was answered or dismissed. */
  reminderOfferDone: boolean;
}

interface Schema extends DBSchema {
  bank: { key: string; value: unknown };
  attempts: { key: string; value: Attempt };
  outbox: { key: number; value: OutboxItem };
  settings: { key: string; value: SettingsRecord };
  meta: { key: string; value: unknown };
}

export type UserDb = IDBPDatabase<Schema>;
export const DB_VERSION = 1;

/** The database name for a user id (a Supabase auth uuid). */
export function dbName(userId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('invalid user id');
  return `sphr-${userId}`;
}

/**
 * `factory` is injectable so tests can run two "devices" side by side. `onClosedElsewhere`
 * runs when another tab or window signs out (deletes this database): this copy closes at
 * once, so it can never save answers into data that is about to be deleted (audit L1).
 */
export async function openUserDb(
  userId: string,
  factory: IDBFactory = indexedDB,
  onClosedElsewhere?: () => void,
): Promise<UserDb> {
  const request = factory.open(dbName(userId), DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('bank');
    db.createObjectStore('attempts', { keyPath: 'id' });
    db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
    db.createObjectStore('settings');
    db.createObjectStore('meta');
  };
  const db = (await wrap(request)) as unknown as UserDb;
  const raw = unwrap(db) as IDBDatabase;
  raw.onversionchange = () => {
    raw.close();
    onClosedElsewhere?.();
  };
  return db;
}

/**
 * Deletes this user's local database (sign-out). Resolves once it is gone. Copies of the app
 * open in other tabs close by themselves (see `openUserDb`); an older copy that doesn't is
 * reported through `onBlocked`, and the delete then finishes when that copy is closed.
 */
export function deleteUserDb(
  userId: string,
  factory: IDBFactory = indexedDB,
  onBlocked?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(dbName(userId));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('could not delete local data'));
    request.onblocked = () => onBlocked?.();
  });
}
