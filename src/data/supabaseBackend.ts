// The real server: Supabase through supabase-js (PostgREST). Reads go through row-level
// security; the only write is the `apply_changes` RPC (CLAUDE.md §2 "one write path").
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ATTEMPT_COLUMNS,
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
  };
}
