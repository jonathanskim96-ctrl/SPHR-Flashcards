// The real server: Supabase through supabase-js (PostgREST). Reads go through row-level
// security; the only write is the `apply_changes` RPC (CLAUDE.md §2 "one write path").
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assembleServerBank,
  ATTEMPT_COLUMNS,
  BANK_META_COLUMNS,
  BANK_PAGE,
  bankVersionOf,
  canonicalAttempt,
  fromServerAttempt,
  fromServerSettingsRow,
  MAX_BATCH,
  parseApplyResult,
  SETTINGS_COLUMNS,
  type Backend,
  type PullPage,
} from './backend';

/** A Supabase error → an Error with a message the UI can show. */
function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message || 'unknown error'}`);
}

export function createSupabaseBackend(client: SupabaseClient): Backend {
  const readMeta = async (): Promise<unknown> => {
    const { data, error } = await client
      .from('bank_meta')
      .select(BANK_META_COLUMNS)
      .eq('id', 1)
      .maybeSingle();
    if (error) fail('Reading the questions from the server failed', error);
    return data;
  };

  /** Every row of a bank table, ordered by id, page by page. */
  const readAll = async (table: 'questions' | 'scenarios'): Promise<unknown[]> => {
    const rows: unknown[] = [];
    for (;;) {
      const { data, error } = await client
        .from(table)
        .select('id,data')
        .order('id', { ascending: true })
        .range(rows.length, rows.length + BANK_PAGE - 1);
      if (error) fail('Reading the questions from the server failed', error);
      const page = (data ?? []) as unknown[];
      rows.push(...page);
      if (page.length < BANK_PAGE) return rows;
    }
  };

  return {
    async applyChanges(attempts, settings, settingsBaseVersion) {
      if (attempts.length > MAX_BATCH) throw new Error(`at most ${MAX_BATCH} answers per call`);
      const { data, error } = await client.rpc('apply_changes', {
        p_attempts: attempts.map(canonicalAttempt),
        p_settings: settings,
        p_settings_base_version: settingsBaseVersion,
      });
      if (error) fail('Saving to the server failed', error);
      return parseApplyResult(data);
    },

    async pullAttempts(afterSeq, limit): Promise<PullPage> {
      const { data, error } = await client
        .from('attempts')
        .select(ATTEMPT_COLUMNS)
        .gt('seq', afterSeq)
        .order('seq', { ascending: true })
        .limit(limit);
      if (error) fail('Reading answers from the server failed', error);
      const page: PullPage = { rows: [], lastSeq: null, bad: [] };
      for (const row of (data ?? []) as unknown[]) {
        const r = fromServerAttempt(row);
        const seq = (row as { seq?: unknown }).seq;
        if (Number.isSafeInteger(seq)) page.lastSeq = Math.max(page.lastSeq ?? 0, seq as number);
        if (r.ok) page.rows.push(r.value);
        else page.bad.push(r.error);
      }
      return page;
    },

    async getSettings() {
      const { data, error } = await client.from('settings').select(SETTINGS_COLUMNS).maybeSingle();
      if (error) fail('Reading settings from the server failed', error);
      return data ? fromServerSettingsRow(data) : null;
    },

    async getBankVersion() {
      return bankVersionOf(await readMeta());
    },

    async getBank() {
      const meta = await readMeta();
      if (!meta) return null;
      const scenarios = await readAll('scenarios');
      const questions = await readAll('questions');
      // The import is one transaction, but these are separate requests: if it ran in
      // between, the tables may mix two versions. Read again later.
      if (bankVersionOf(await readMeta()) !== bankVersionOf(meta))
        throw new Error('The questions changed on the server while loading; trying again later.');
      return assembleServerBank(meta, scenarios, questions);
    },
  };
}
