// IndexedDB on the phone: one database per signed-in user, so two accounts can never mix.
// Stores (BUILD_PLAN Phase 3):
//   bank      the cached question bank (Phase 4)
//   attempts  every known answer, by id (this device's and those pulled from the server)
//   outbox    changes not yet confirmed by the server, in order (auto-increment key `n`)
//   settings  the current settings and the server version they are based on
//   meta      sync cursor, last sync time, last export date, unread notices
import { wrap, type DBSchema, type IDBPDatabase } from 'idb';
import type { Attempt, Settings } from '../domain/types';

export type OutboxItem =
  { n?: number; kind: 'attempt'; attempt: Attempt } | { n?: number; kind: 'settings' };

export interface SettingsRecord {
  settings: Settings;
  /** The server version these settings are based on; null if never saved on the server. */
  version: number | null;
  /** True while these are untouched defaults (a server copy then wins without a message). */
  isDefault: boolean;
}

export interface Meta {
  /** Highest server `seq` pulled so far. */
  cursor: number;
  lastSyncAt: string | null;
  lastExportAt: string | null;
  /** Messages for the user that survive a reload until dismissed (rejections, conflicts). */
  notices: string[];
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

/** `factory` is injectable so tests can run two "devices" side by side. */
export async function openUserDb(userId: string, factory: IDBFactory = indexedDB): Promise<UserDb> {
  const request = factory.open(dbName(userId), DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('bank');
    db.createObjectStore('attempts', { keyPath: 'id' });
    db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
    db.createObjectStore('settings');
    db.createObjectStore('meta');
  };
  return (await wrap(request)) as unknown as UserDb;
}

/** Deletes this user's local database (sign-out). Resolves once it is gone. */
export function deleteUserDb(userId: string, factory: IDBFactory = indexedDB): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(dbName(userId));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('could not delete local data'));
    request.onblocked = () =>
      reject(new Error('Local data is still in use in another tab; close it and try again.'));
  });
}
