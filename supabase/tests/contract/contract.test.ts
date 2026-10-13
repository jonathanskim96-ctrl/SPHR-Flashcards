// App↔DB contract (BUILD_PLAN Phase 3), run by supabase/tests/run.sh against the local
// PostgreSQL with the real migrations:
//  1. every payload the app produces (an answer of each of the 6 response types, settings,
//     a push subscription) goes through the real function and reads back identical after
//     the app's own conversion (the same code the app runs on PostgREST replies);
//  2. the app's validator and the database accept and reject exactly the same values from
//     one shared table (tests/contract/cases.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ATTEMPT_COLUMNS,
  canonicalAttempt,
  fromServerAttempt,
  fromServerSettingsRow,
  parseApplyResult,
  SETTINGS_COLUMNS,
} from '../../../src/data/backend';
import { buildAttempt } from '../../../src/data/answer';
import { normalizeBank } from '../../../src/domain/bank';
import type { Attempt, Bank } from '../../../src/domain/types';
import {
  defaultSettings,
  validateAttempt,
  validateSettings,
  validateSubscription,
} from '../../../src/domain/validate';
import {
  attemptCases,
  RESPONSES,
  settingsCases,
  subscriptionCases,
} from '../../../tests/contract/cases';
import sample from '../../../tests/fixtures/sample-bank.json';
import { sql, sqlOk } from './psql';

const USER = '00000000-0000-4000-8000-00000000c0de';
const loadBank = (): Bank => {
  const r = normalizeBank(structuredClone(sample));
  if (!r.ok) throw new Error(r.error);
  return r.bank;
};
const bank = loadBank();

/** As the signed-in test user, in a transaction that is committed (or rolled back). */
const asUser = (body: string, end: 'commit' | 'rollback' = 'rollback') =>
  `begin;\nselect tests.login(:'uid') \\gset\n${body}\n${end};\n`;

// Errors the database raises for a value it cannot store at all (jsonb parse, constraints).
const STORAGE_ERROR =
  /invalid input syntax for type json|unsupported Unicode escape sequence|violates check constraint/;

/** Accept/reject verdict from a database call, failing the test on any unexpected error. */
function verdict(r: ReturnType<typeof sql>, accepted: (out: string) => boolean): boolean {
  if (r.ok) return accepted(r.out);
  if (STORAGE_ERROR.test(r.error)) return false;
  throw new Error(`unexpected database error: ${r.error}`);
}

beforeAll(() => {
  sqlOk(
    `insert into auth.users (id, email) values (:'uid', 'fake-contract@example.test') on conflict do nothing;`,
    {
      uid: USER,
    },
  );
});

describe('round trips through the real functions', () => {
  it('an answer of each of the 6 types reads back identical', () => {
    const now = Date.now();
    const made: Attempt[] = Object.entries(RESPONSES).map(([id, response], i) =>
      buildAttempt({
        bank,
        question: bank.questions.find((q) => q.id === id)!,
        response,
        mode: (['lesson', 'mistakes', 'ahead'] as const)[i % 3]!,
        now: new Date(now - 60_000 + i),
      }),
    );
    expect(new Set(made.map((a) => a.response.type)).size).toBe(6);
    const reply = parseApplyResult(
      JSON.parse(
        sqlOk(asUser(`select public.apply_changes(:'p'::jsonb)::text;`, 'commit'), {
          uid: USER,
          p: JSON.stringify(made.map(canonicalAttempt)),
        }),
      ),
    );
    expect(reply).toMatchObject({ inserted: 6, duplicates: 0, rejected: [] });

    // Read back the way PostgREST does (row_to_json of the selected columns), in a time zone
    // other than UTC to prove the offset is handled.
    const rows = JSON.parse(
      sqlOk(
        asUser(
          `set local timezone = 'America/Los_Angeles';
           select coalesce(json_agg(row_to_json(t) order by t.seq), '[]')
           from (select ${ATTEMPT_COLUMNS} from public.attempts order by seq) t;`,
        ),
        { uid: USER },
      ),
    ) as unknown[];
    const back = rows.map((row) => {
      const r = fromServerAttempt(row);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
    expect(back.map((b) => b.attempt)).toEqual(made.map(canonicalAttempt));
    expect(reply.maxSeq).toBe(back.at(-1)!.seq);

    // Sending the same batch again (an outbox retry) only counts duplicates.
    const again = parseApplyResult(
      JSON.parse(
        sqlOk(asUser(`select public.apply_changes(:'p'::jsonb)::text;`, 'commit'), {
          uid: USER,
          p: JSON.stringify(made.map(canonicalAttempt)),
        }),
      ),
    );
    expect(again).toMatchObject({ inserted: 0, duplicates: 6, rejected: [] });
  });

  it('settings read back identical, from the table and from a conflict reply', () => {
    const settings = {
      ...defaultSettings('America/Los_Angeles'),
      reminderTime: '07:45',
      examDate: '2027-01-04',
    };
    const first = parseApplyResult(
      JSON.parse(
        sqlOk(asUser(`select public.apply_changes('[]', :'s'::jsonb, null)::text;`, 'commit'), {
          uid: USER,
          s: JSON.stringify(settings),
        }),
      ),
    );
    expect(first).toMatchObject({
      settingsVersion: 1,
      settingsConflict: false,
      settingsError: null,
    });
    const row = JSON.parse(
      sqlOk(
        asUser(`select row_to_json(t) from (select ${SETTINGS_COLUMNS} from public.settings) t;`),
        {
          uid: USER,
        },
      ),
    );
    expect(fromServerSettingsRow(row)).toEqual({ settings, version: 1 });

    // A stale write: the reply carries the server copy (settings_json), read the same way.
    const stale = parseApplyResult(
      JSON.parse(
        sqlOk(asUser(`select public.apply_changes('[]', :'s'::jsonb, null)::text;`), {
          uid: USER,
          s: JSON.stringify({ ...settings, lessonSize: 20 }),
        }),
      ),
    );
    expect(stale).toMatchObject({ settingsConflict: true, settingsVersion: 1 });
    expect(stale.serverSettings).toEqual({ settings, version: 1 });

    // A write on top of the current version succeeds and bumps it.
    const next = parseApplyResult(
      JSON.parse(
        sqlOk(asUser(`select public.apply_changes('[]', :'s'::jsonb, 1)::text;`), {
          uid: USER,
          s: JSON.stringify({ ...settings, lessonSize: 20 }),
        }),
      ),
    );
    expect(next).toMatchObject({ settingsConflict: false, settingsVersion: 2 });
  });

  it('a push subscription reads back identical', () => {
    const sub = {
      endpoint: 'https://push.example.test/sub/1',
      p256dh: 'B'.repeat(87),
      auth: 'c'.repeat(22),
    };
    expect(validateSubscription(sub).ok).toBe(true);
    const row = JSON.parse(
      sqlOk(
        asUser(
          `select public.save_push_subscription(x ->> 'endpoint', x ->> 'p256dh', x ->> 'auth')
             from (select :'p'::jsonb x) s \\gset
           select row_to_json(t) from (select endpoint, p256dh, auth from public.push_subscriptions) t;`,
        ),
        { uid: USER, p: JSON.stringify(sub) },
      ),
    );
    expect(row).toEqual(sub);
  });
});

describe('the app and the database accept exactly the same values', () => {
  const now = Date.now();
  it.each(attemptCases(bank, now).map((c) => [c.name, c] as const))('answer: %s', (_, c) => {
    expect(validateAttempt(c.value, Date.now()).ok, 'app').toBe(c.accept);
    const r = sql(asUser(`select public.apply_changes(jsonb_build_array(:'p'::jsonb))::text;`), {
      uid: USER,
      p: JSON.stringify(c.value),
    });
    const db = verdict(r, (out) => {
      const reply = parseApplyResult(JSON.parse(out));
      return reply.inserted === 1 && reply.rejected.length === 0;
    });
    expect(db, `database${r.ok ? `: ${r.out}` : ''}`).toBe(c.accept);
  });

  // Old alias zone names are left out: the app cannot know which ones a server's zone list
  // has (HANDOFF build notes). A refusal there is reported to her as a notice.
  const fixed = settingsCases().filter((c) => c.accept !== 'server-dependent');
  it.each(fixed.map((c) => [c.name, c] as const))('settings: %s', (_, c) => {
    expect(validateSettings(c.value).ok, 'app').toBe(c.accept);
    // A fresh user per case, so the first write is never a stale-version conflict.
    const r = sql(
      `begin;
       insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000ff');
       select tests.login('00000000-0000-4000-8000-0000000000ff') \\gset
       select public.apply_changes('[]', :'s'::jsonb, null)::text;
       rollback;`,
      { s: JSON.stringify(c.value) },
    );
    const db = verdict(r, (out) => {
      const reply = parseApplyResult(JSON.parse(out));
      return reply.settingsError === null && reply.settingsVersion === 1;
    });
    expect(db, `database${r.ok ? `: ${r.out}` : ''}`).toBe(c.accept);
  });

  it.each(subscriptionCases().map((c) => [c.name, c] as const))('subscription: %s', (_, c) => {
    expect(validateSubscription(c.value).ok, 'app').toBe(c.accept);
    const r = sql(
      asUser(
        `select public.save_push_subscription(x ->> 'endpoint', x ->> 'p256dh', x ->> 'auth')
           from (select :'p'::jsonb x) s;`,
      ),
      { uid: USER, p: JSON.stringify(c.value) },
    );
    expect(
      verdict(r, () => true),
      `database${r.ok ? '' : `: ${r.error}`}`,
    ).toBe(c.accept);
  });
});
