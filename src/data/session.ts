// A signed-in session on this phone: opens the user's local database, makes sure there are
// settings, asks the browser to keep the data, and starts syncing. Also sign-out, which is
// refused while anything is still waiting to back up (the screen then offers an export).
import { isTimeZone } from '../domain/dates';
import { defaultSettings } from '../domain/validate';
import type { Backend } from './backend';
import { deleteUserDb, openUserDb } from './db';
import { errorText, LocalStore } from './store';
import { browserEnv, SyncEngine, type SyncEnv } from './sync';

export interface Session {
  userId: string;
  store: LocalStore;
  engine: SyncEngine;
  /** The result of asking for persistent storage. */
  persistence: Promise<PersistResult>;
  factory: IDBFactory | undefined;
}

export interface SessionOptions {
  userId: string;
  backend: Backend;
  factory?: IDBFactory;
  env?: SyncEnv;
  deviceTimeZone?: string;
  storage?: StorageManagerLike | undefined;
}

export async function openSession(o: SessionOptions): Promise<Session> {
  const env = o.env ?? browserEnv();
  const db = await openUserDb(o.userId, o.factory);
  const store = new LocalStore(db, env.now);
  const engine = new SyncEngine(store, o.backend, env);
  await ensureSettings(
    store,
    o.backend,
    o.deviceTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const persistence = requestPersistentStorage(
    'storage' in o ? o.storage : globalThis.navigator?.storage,
  );
  engine.start();
  return { userId: o.userId, store, engine, persistence, factory: o.factory };
}

/**
 * First run on this phone: take the server's settings if it has them; otherwise (a new
 * account, or offline) start from the defaults in the device's time zone. Defaults made
 * offline are replaced silently by a server copy on the next sync.
 */
export async function ensureSettings(
  store: LocalStore,
  backend: Backend,
  deviceTimeZone: string,
): Promise<void> {
  if (await store.settingsRecord()) return;
  let server = null;
  try {
    server = await backend.getSettings();
  } catch {
    // Offline: the defaults below are queued and reconciled on the next sync, whose
    // errors are shown in the sync status line.
  }
  if (server) await store.mergeServerSettings(store.writeEpoch, server);
  else
    await store.saveDefaultSettings(
      defaultSettings(isTimeZone(deviceTimeZone) ? deviceTimeZone : 'UTC'),
    );
}

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}
export type PersistResult = 'persisted' | 'denied' | 'unsupported' | { error: string };

/** Asks the browser not to evict this app's data under storage pressure. */
export async function requestPersistentStorage(
  storage: StorageManagerLike | undefined,
): Promise<PersistResult> {
  if (!storage?.persist) return 'unsupported';
  try {
    if (storage.persisted && (await storage.persisted())) return 'persisted';
    return (await storage.persist()) ? 'persisted' : 'denied';
  } catch (e) {
    return { error: errorText(e) };
  }
}

export interface AuthLike {
  signOut(): Promise<{ error: { message: string } | null }>;
}

export type SignOutResult =
  | { ok: true }
  | { ok: false; reason: 'unsynced'; pendingAnswers: number; pendingSettings: boolean }
  | { ok: false; reason: 'error'; error: string };

/**
 * Tries one last sync, then refuses if anything is still waiting to back up. Otherwise
 * signs out and deletes this user's local data (everything in it is on the server).
 */
export async function signOut(session: Session, auth: AuthLike): Promise<SignOutResult> {
  await session.engine.sync();
  const pending = await session.store.pending();
  if (pending.answers > 0 || pending.settings)
    return {
      ok: false,
      reason: 'unsynced',
      pendingAnswers: pending.answers,
      pendingSettings: pending.settings,
    };
  try {
    const { error } = await auth.signOut();
    if (error) return { ok: false, reason: 'error', error: `Sign-out failed: ${error.message}` };
    session.engine.stop();
    session.store.close();
    await deleteUserDb(session.userId, session.factory);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', error: `Sign-out failed: ${errorText(e)}` };
  }
}

/** The sign-out refusal message (the screen adds an "Export progress" button). */
export function signOutBlockedText(r: { pendingAnswers: number; pendingSettings: boolean }) {
  const parts: string[] = [];
  if (r.pendingAnswers)
    parts.push(r.pendingAnswers === 1 ? '1 answer' : `${r.pendingAnswers} answers`);
  if (r.pendingSettings) parts.push('a settings change');
  const verb = parts.length > 1 || r.pendingAnswers > 1 ? 'are' : 'is';
  return (
    `You can't sign out yet: ${parts.join(' and ')} ${verb} not backed up. ` +
    'Connect to the internet and try again, or export your progress first.'
  );
}
