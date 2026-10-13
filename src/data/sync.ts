// The sync engine (BUILD_PLAN Phase 3). It sends the outbox to `apply_changes` in order,
// in batches of at most 200, and removes items only after the server confirmed them (by
// key, so an answer made during a flush is never lost). Then it pulls answers newer than
// the cursor, page by page, and the settings.
//
// When it runs: on start, when the phone comes back online, when the app returns to the
// foreground, 2 seconds after an answer, and every 5 minutes while open. Runs never
// overlap; a request during a run schedules one more run.
import { MAX_BATCH, PULL_PAGE, type Backend } from './backend';
import type { OutboxItem } from './db';
import { errorText, type LocalStore } from './store';

export const ANSWER_DEBOUNCE_MS = 2_000;
export const PERIODIC_MS = 5 * 60_000;
/** Runs in a row for one request (a pull discarded by a local write asks for another). */
const MAX_RUNS = 5;

export const SETTINGS_CONFLICT_NOTICE = 'Settings were changed on another device; reloaded them.';

export interface SyncStatus {
  running: boolean;
  offline: boolean;
  pendingAnswers: number;
  pendingSettings: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  notices: string[];
}

/** The browser hooks the engine needs (injectable for tests). */
export interface SyncEnv {
  isOnline(): boolean;
  isVisible(): boolean;
  /** Subscribes to "came back online" and "returned to the foreground". */
  onWake(fn: () => void): () => void;
  now(): number;
}

export function browserEnv(): SyncEnv {
  return {
    isOnline: () => navigator.onLine !== false,
    isVisible: () => document.visibilityState === 'visible',
    onWake(fn) {
      const onVisible = () => {
        if (document.visibilityState === 'visible') fn();
      };
      window.addEventListener('online', fn);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.removeEventListener('online', fn);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
    now: Date.now,
  };
}

const isAnswer = (i: OutboxItem): i is Extract<OutboxItem, { kind: 'attempt' }> =>
  i.kind === 'attempt';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 answers could not be saved: reason", one line per distinct reason. */
export function rejectionNotices(reasons: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(
    ([reason, n]) => `${plural(n, 'answer', 'answers')} could not be saved: ${reason}`,
  );
}

export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private offline = false;
  private lastError: string | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unwake: (() => void) | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: LocalStore,
    private readonly backend: Backend,
    private readonly env: SyncEnv = browserEnv(),
  ) {}

  start(): void {
    if (this.interval) return;
    this.unwake = this.env.onWake(() => void this.sync());
    this.interval = setInterval(() => void this.sync(), PERIODIC_MS);
    void this.sync();
  }

  stop(): void {
    this.unwake?.();
    this.unwake = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  /** Call after each saved answer: syncs 2 seconds after the last one. */
  noteAnswer(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.sync();
    }, ANSWER_DEBOUNCE_MS);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  async status(): Promise<SyncStatus> {
    const [pending, meta] = await Promise.all([this.store.pending(), this.store.meta()]);
    return {
      running: this.running !== null,
      offline: this.offline,
      pendingAnswers: pending.answers,
      pendingSettings: pending.settings,
      lastSyncAt: meta.lastSyncAt,
      lastError: this.lastError,
      notices: meta.notices,
    };
  }

  /** Runs a sync now (or joins the one running and asks for one more pass). Never throws. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      this.notify();
      let runs = 0;
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again && ++runs < MAX_RUNS);
    })().finally(() => {
      this.running = null;
      this.notify();
    });
    return this.running;
  }

  private async runOnce(): Promise<void> {
    if (!this.env.isOnline()) {
      this.offline = true;
      return;
    }
    this.offline = false;
    try {
      await this.flush();
      await this.pull();
      this.lastError = null;
      await this.store.setMeta({ lastSyncAt: new Date(this.env.now()).toISOString() });
    } catch (e) {
      this.lastError = errorText(e);
    }
    this.notify();
  }

  private async flush(): Promise<void> {
    for (;;) {
      const items = await this.store.outbox();
      const answers = items.filter(isAnswer).slice(0, MAX_BATCH);
      const settingsItems = items.filter((i) => i.kind === 'settings');
      if (!answers.length && !settingsItems.length) return;
      const record = settingsItems.length ? await this.store.settingsRecord() : undefined;

      const res = await this.backend.applyChanges(
        answers.map((i) => i.attempt),
        record?.settings ?? null,
        record ? record.version : null,
      );

      const notices = rejectionNotices(res.rejected.map((r) => r.reason));
      let settings: Parameters<LocalStore['confirmSent']>[0]['settings'] = null;
      if (record) {
        if (res.settingsError !== null) {
          settings = { outcome: 'error' };
          notices.push(`Settings could not be saved: ${res.settingsError}`);
        } else if (res.settingsConflict) {
          settings = { outcome: 'conflict', server: res.serverSettings };
          if (!record.isDefault) notices.push(SETTINGS_CONFLICT_NOTICE);
        } else if (res.settingsVersion !== null) {
          settings = { outcome: 'saved', version: res.settingsVersion };
        } else {
          settings = { outcome: 'error' };
          notices.push('Settings could not be saved: the server did not confirm them');
        }
      }
      await this.store.confirmSent({
        sentKeys: [...answers, ...settingsItems].map((i) => i.n as number),
        settings,
        notices,
      });
    }
  }

  private async pull(): Promise<void> {
    const epoch = this.store.writeEpoch;
    let cursor = (await this.store.meta()).cursor;
    for (;;) {
      const page = await this.backend.pullAttempts(cursor, PULL_PAGE);
      if (page.bad.length)
        await this.store.addNotices(
          page.bad.map((b) => `An answer from the server could not be read (${b}).`),
        );
      if (page.lastSeq === null) break;
      if (!(await this.store.mergePulled(epoch, page.rows, page.lastSeq))) {
        this.again = true;
        return;
      }
      cursor = page.lastSeq;
      if (page.rows.length + page.bad.length < PULL_PAGE) break;
    }
    const server = await this.backend.getSettings();
    if (server && !(await this.store.mergeServerSettings(epoch, server))) this.again = true;
  }
}

/** The sync status line in Settings. */
export function syncStatusText(s: SyncStatus): string[] {
  const lines: string[] = [];
  if (s.pendingAnswers === 0) lines.push('All answers backed up');
  else
    lines.push(
      `${plural(s.pendingAnswers, 'answer', 'answers')} waiting to back up` +
        (s.offline ? ' (offline)' : ''),
    );
  if (s.pendingSettings) lines.push('A settings change is waiting to back up');
  if (s.lastError) lines.push(`Last sync failed: ${s.lastError}`);
  return lines;
}
