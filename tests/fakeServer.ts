// An in-memory stand-in for the Supabase side, for sync tests. It follows the contract of
// `apply_changes` in supabase/migrations/0003_rpc.sql (idempotent inserts, per-answer
// rejections, stale-settings check, 200 cap) and answers in the server's own spelling, so
// the real conversion functions in src/data/backend.ts are exercised. The real database is
// checked against the same client code by supabase/tests/60_contract.test.sh.
import {
  assembleServerBank,
  fromServerAttempt,
  fromServerSettingsRow,
  parseApplyResult,
  type Backend,
  type PullPage,
} from '../src/data/backend';
import {
  validateAttempt,
  validateSettings,
  validateSubscription,
  type PushSubscriptionKeys,
} from '../src/domain/validate';
import type { Attempt, Settings } from '../src/domain/types';

interface Row {
  seq: number;
  attempt: Attempt;
}

/** `2026-10-13T20:00:00.000Z` → `2026-10-13T20:00:00+00:00` (how Postgres prints it). */
const pgTimestamp = (iso: string) => new Date(iso).toISOString().replace(/\.000Z$|Z$/, '+00:00');

export class FakeServer {
  rows: Row[] = [];
  settings: { value: Settings; version: number } | null = null;
  calls = 0;
  /** Set to make every call fail as if the network were down. */
  offline = false;
  /** Called at the start of each applyChanges call (tests use it to act "during" a flush). */
  onApply: (() => Promise<void> | void) | null = null;
  /** Called at the start of each pull page. */
  onPull: (() => Promise<void> | void) | null = null;
  /** The next N applyChanges calls are applied but their replies are lost. */
  loseReplies = 0;
  /** Answer ids the server refuses (beyond what the validator refuses). */
  refuse = new Map<string, string>();
  /** The imported question bank in the file's shape (null: never imported). */
  bank: Record<string, unknown> | null = null;
  bankDownloads = 0;
  /** push_subscriptions, by endpoint (like the table: never deleted, only disabled). */
  subscriptions = new Map<string, PushSubscriptionKeys & { disabled: boolean }>();
  /** Every push-subscription call, in order: `save <endpoint>` / `disable <endpoint>`. */
  pushCalls: string[] = [];
  /** The next `seq`; a test can skip one to act out a save that commits late. */
  nextSeq = 1;

  constructor(private readonly now: () => number = Date.now) {}

  backend(): Backend {
    return {
      applyChanges: async (attempts, settings, base) => {
        this.calls++;
        await this.onApply?.();
        this.check();
        const raw = this.applyRaw(structuredClone(attempts), structuredClone(settings), base);
        if (this.loseReplies > 0) {
          this.loseReplies--;
          throw new Error('Saving to the server failed: TypeError: Load failed');
        }
        return parseApplyResult(structuredClone(raw));
      },
      pullAttempts: async (afterSeq, limit): Promise<PullPage> => {
        await this.onPull?.();
        this.check();
        const page: PullPage = { rows: [], lastSeq: null, bad: [] };
        for (const row of this.attemptRows(afterSeq, limit)) {
          const res = fromServerAttempt(row);
          page.lastSeq = row.seq;
          if (res.ok) page.rows.push(res.value);
          else page.bad.push(res.error);
        }
        return page;
      },
      getSettings: async () => {
        this.check();
        const row = this.settingsRow();
        return row ? fromServerSettingsRow(row) : null;
      },
      getBankVersion: async () => {
        this.check();
        return typeof this.bank?.bankVersion === 'string' ? this.bank.bankVersion : null;
      },
      getBank: async () => {
        this.check();
        if (!this.bank) return null;
        this.bankDownloads++;
        // Like the real tables: one row per question/scenario, read back ordered by id.
        const b = structuredClone(this.bank) as Record<string, unknown>;
        const rows = (xs: unknown) =>
          (xs as { id: string }[])
            .map((data) => ({ id: data.id, data }))
            .sort((x, y) => (x.id < y.id ? -1 : 1));
        return assembleServerBank(
          {
            schema_version: b.schemaVersion,
            bank_version: b.bankVersion,
            areas: b.areas,
            levels: b.levels,
          },
          rows(b.scenarios),
          rows(b.questions),
        );
      },
      savePushSubscription: async (keys) => {
        this.check();
        this.pushCalls.push(`save ${keys.endpoint}`);
        const r = validateSubscription(keys);
        if (!r.ok) throw new Error(`Saving the reminder on the server failed: ${r.errors[0]}`);
        this.subscriptions.set(keys.endpoint, { ...r.value, disabled: false });
      },
      disablePushSubscription: async (endpoint) => {
        this.check();
        this.pushCalls.push(`disable ${endpoint}`);
        const sub = this.subscriptions.get(endpoint);
        if (sub) sub.disabled = true;
      },
    };
  }

  private check() {
    if (this.offline) throw new Error('Saving to the server failed: TypeError: Failed to fetch');
  }

  /** `attempts` rows with `seq > afterSeq`, in PostgREST's spelling (also used by e2e). */
  attemptRows(afterSeq: number, limit: number) {
    return this.rows
      .filter((x) => x.seq > afterSeq)
      .slice(0, limit)
      .map(({ seq, attempt: a }) => ({
        seq,
        id: a.id,
        question_id: a.questionId,
        revision: a.revision,
        answer_fp: a.answerFp,
        correct: a.correct,
        xp: a.xp,
        mode: a.mode,
        response: structuredClone(a.response),
        answered_at: pgTimestamp(a.answeredAt),
      }));
  }

  /** The `settings` row in PostgREST's spelling, or null (also used by e2e). */
  settingsRow() {
    if (!this.settings) return null;
    const s = this.settings.value;
    return {
      new_per_day: s.newPerDay,
      lesson_size: s.lessonSize,
      daily_xp_goal: s.dailyXpGoal,
      exam_date: s.examDate,
      reminder_enabled: s.reminderEnabled,
      reminder_time: `${s.reminderTime}:00`,
      time_zone: s.timeZone,
      version: this.settings.version,
    };
  }

  /** Mirrors apply_changes; returns its raw JSON (also used by e2e). */
  applyRaw(attempts: readonly unknown[], settings: Settings | null, base: number | null) {
    if (attempts.length > 200) throw new Error('too many answers in one call');
    const rejected: { index: number; id: string | null; reason: string }[] = [];
    let inserted = 0;
    let duplicates = 0;
    attempts.forEach((a, index) => {
      const r = validateAttempt(a, this.now());
      const id = (a as { id?: string }).id ?? null;
      const refused = id ? this.refuse.get(id) : undefined;
      if (!r.ok || refused) {
        rejected.push({ index, id, reason: refused ?? (r.ok ? '' : r.errors[0]!) });
      } else if (this.rows.some((x) => x.attempt.id === r.value.id)) duplicates++;
      else {
        this.rows.push({ seq: this.nextSeq++, attempt: r.value });
        inserted++;
      }
    });
    let conflict = false;
    let settingsError: string | null = null;
    if (settings) {
      const v = validateSettings(settings);
      if (!v.ok) settingsError = v.errors[0]!;
      else if (!this.settings) this.settings = { value: v.value, version: 1 };
      else if (this.settings.version === base)
        this.settings = { value: v.value, version: this.settings.version + 1 };
      else conflict = true;
    }
    return {
      inserted,
      duplicates,
      rejected,
      settings_version: this.settings?.version ?? null,
      settings_conflict: conflict,
      server_settings:
        conflict && this.settings
          ? { ...this.settings.value, version: this.settings.version }
          : null,
      settings_error: settingsError,
      max_seq: this.rows.length ? this.rows[this.rows.length - 1]!.seq : null,
    };
  }

  /** Another device (or the SQL editor) saves settings directly. */
  setSettings(value: Settings) {
    this.settings = { value, version: (this.settings?.version ?? 0) + 1 };
  }
}
