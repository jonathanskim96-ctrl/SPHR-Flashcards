// The phone's local data and the app's only write entry point, `guardedWrite`.
// Every change is validated by the domain validator, then saved to the local store and the
// outbox in one IndexedDB transaction, so the screen updates at once and the change is
// sent to the server later by the sync engine (sync.ts).
import { validateAttempt, validateSettings } from '../domain/validate';
import type { Attempt, Settings } from '../domain/types';
import { canonicalAttempt, type PulledAttempt, type VersionedSettings } from './backend';
import type { Meta, OutboxItem, SettingsRecord, UserDb } from './db';

export type Change =
  { kind: 'attempt'; attempt: unknown } | { kind: 'settings'; settings: unknown };

export type WriteResult = { ok: true } | { ok: false; errors: string[] };

const META_DEFAULTS: Meta = {
  cursor: 0,
  lastSyncAt: null,
  lastExportAt: null,
  notices: [],
  reminderOfferDone: false,
};
const MAX_NOTICES = 20;

export interface PendingCounts {
  answers: number;
  settings: boolean;
}

export class LocalStore {
  /**
   * Changes every time a local write starts and finishes. A pull compares it before and
   * after, and discards its result if a write happened meanwhile (reload-race guard).
   */
  writeEpoch = 0;
  private writesInFlight = 0;
  private listeners = new Set<() => void>();

  constructor(
    readonly db: UserDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called after every change to local data (the UI re-reads). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  get writing(): boolean {
    return this.writesInFlight > 0;
  }

  /** The one write path on the phone. Invalid changes are rejected, never "fixed". */
  async guardedWrite(change: Change): Promise<WriteResult> {
    this.writeEpoch++;
    this.writesInFlight++;
    try {
      if (change.kind === 'attempt') {
        const r = validateAttempt(change.attempt, this.now());
        if (!r.ok) return { ok: false, errors: r.errors };
        const attempt = canonicalAttempt(r.value);
        const tx = this.db.transaction(['attempts', 'outbox'], 'readwrite');
        if (await tx.objectStore('attempts').get(attempt.id)) {
          await tx.done;
          return { ok: false, errors: ['this answer was already saved'] };
        }
        await Promise.all([
          tx.objectStore('attempts').add(attempt),
          tx.objectStore('outbox').add({ kind: 'attempt', attempt }),
          tx.done,
        ]);
      } else {
        const r = validateSettings(change.settings);
        if (!r.ok) return { ok: false, errors: r.errors };
        const tx = this.db.transaction(['settings', 'outbox'], 'readwrite');
        const current = await tx.objectStore('settings').get('current');
        await Promise.all([
          tx
            .objectStore('settings')
            .put(
              { settings: r.value, version: current?.version ?? null, isDefault: false },
              'current',
            ),
          tx.objectStore('outbox').add({ kind: 'settings' }),
          tx.done,
        ]);
      }
      this.changed();
      return { ok: true };
    } catch (e) {
      return { ok: false, errors: [`Could not save on this phone: ${errorText(e)}`] };
    } finally {
      this.writesInFlight--;
      this.writeEpoch++;
    }
  }

  /**
   * First-run settings: stored as defaults and queued for the server, so the account gets a
   * settings row. A copy already on the server replaces them silently (see sync.ts).
   */
  async saveDefaultSettings(settings: Settings): Promise<void> {
    const r = validateSettings(settings);
    if (!r.ok) throw new Error(r.errors.join('; '));
    const tx = this.db.transaction(['settings', 'outbox'], 'readwrite');
    if (!(await tx.objectStore('settings').get('current'))) {
      await tx
        .objectStore('settings')
        .put({ settings: r.value, version: null, isDefault: true }, 'current');
      await tx.objectStore('outbox').add({ kind: 'settings' });
    }
    await tx.done;
    this.changed();
  }

  async attempts(): Promise<Attempt[]> {
    return this.db.getAll('attempts');
  }

  async settingsRecord(): Promise<SettingsRecord | undefined> {
    return this.db.get('settings', 'current');
  }

  async outbox(): Promise<OutboxItem[]> {
    return this.db.getAll('outbox');
  }

  async pending(): Promise<PendingCounts> {
    const items = await this.outbox();
    return {
      answers: items.filter((i) => i.kind === 'attempt').length,
      settings: items.some((i) => i.kind === 'settings'),
    };
  }

  async meta(): Promise<Meta> {
    const tx = this.db.transaction('meta');
    const keys = Object.keys(META_DEFAULTS) as (keyof Meta)[];
    const values = await Promise.all(keys.map((k) => tx.store.get(k)));
    const meta = { ...META_DEFAULTS };
    keys.forEach((k, i) => {
      if (values[i] !== undefined) (meta as Record<string, unknown>)[k] = values[i];
    });
    return meta;
  }

  async setMeta(patch: Partial<Meta>): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    await Promise.all([...Object.entries(patch).map(([k, v]) => tx.store.put(v, k)), tx.done]);
    this.changed();
  }

  async addNotices(messages: readonly string[]): Promise<void> {
    if (!messages.length) return;
    const tx = this.db.transaction('meta', 'readwrite');
    const old = ((await tx.store.get('notices')) as string[] | undefined) ?? [];
    await tx.store.put([...old, ...messages].slice(-MAX_NOTICES), 'notices');
    await tx.done;
    this.changed();
  }

  async dismissNotices(): Promise<void> {
    await this.setMeta({ notices: [] });
  }

  /**
   * After the server answered a flush: remove exactly the outbox items that were sent
   * (by key, so anything added meanwhile stays), and record the settings outcome.
   */
  async confirmSent(input: {
    sentKeys: readonly number[];
    settings:
      | { outcome: 'saved'; version: number }
      | { outcome: 'conflict'; server: VersionedSettings | null }
      | { outcome: 'error' }
      | null;
    notices: readonly string[];
  }): Promise<void> {
    const tx = this.db.transaction(['outbox', 'settings', 'meta'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    const settingsStore = tx.objectStore('settings');
    for (const n of input.sentKeys) await outbox.delete(n);
    const s = input.settings;
    if (s?.outcome === 'saved') {
      const current = await settingsStore.get('current');
      if (current) await settingsStore.put({ ...current, version: s.version }, 'current');
    } else if (s?.outcome === 'conflict') {
      // Keep the server copy and drop every queued settings change (even one made during
      // the flush: it was based on settings that no longer exist).
      for (const item of await outbox.getAll())
        if (item.kind === 'settings') await outbox.delete(item.n as number);
      if (s.server)
        await settingsStore.put(
          { settings: s.server.settings, version: s.server.version, isDefault: false },
          'current',
        );
    }
    if (input.notices.length) {
      const meta = tx.objectStore('meta');
      const old = ((await meta.get('notices')) as string[] | undefined) ?? [];
      await meta.put([...old, ...input.notices].slice(-MAX_NOTICES), 'notices');
    }
    await tx.done;
    this.changed();
  }

  /**
   * Adds pulled answers (an answer already on the phone is kept as is) and moves the cursor.
   * Returns false, writing nothing, if a local write started since `epoch`.
   */
  async mergePulled(
    epoch: number,
    rows: readonly PulledAttempt[],
    lastSeq: number,
  ): Promise<boolean> {
    if (epoch !== this.writeEpoch || this.writing) return false;
    const tx = this.db.transaction(['attempts', 'meta'], 'readwrite');
    const store = tx.objectStore('attempts');
    for (const { attempt } of rows) if (!(await store.get(attempt.id))) await store.add(attempt);
    const cursor = ((await tx.objectStore('meta').get('cursor')) as number | undefined) ?? 0;
    await tx.objectStore('meta').put(Math.max(cursor, lastSeq), 'cursor');
    await tx.done;
    if (rows.length) this.changed();
    return true;
  }

  /**
   * Replaces local settings with the server copy, unless a local settings change is still
   * queued (the next flush settles that) or a write started since `epoch`.
   */
  async mergeServerSettings(epoch: number, server: VersionedSettings): Promise<boolean> {
    if (epoch !== this.writeEpoch || this.writing) return false;
    const tx = this.db.transaction(['settings', 'outbox'], 'readwrite');
    const queued = (await tx.objectStore('outbox').getAll()).some((i) => i.kind === 'settings');
    const current = await tx.objectStore('settings').get('current');
    let changed = false;
    if (!queued && (current?.version !== server.version || current?.isDefault)) {
      await tx
        .objectStore('settings')
        .put({ settings: server.settings, version: server.version, isDefault: false }, 'current');
      changed = true;
    }
    await tx.done;
    if (changed) this.changed();
    return true;
  }

  close(): void {
    this.db.close();
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
