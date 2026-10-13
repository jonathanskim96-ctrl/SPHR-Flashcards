// The Supabase adapter, against a fake fetch: checks the exact HTTP calls supabase-js makes
// (PostgREST paths, parameters, RPC body) and how replies and errors are read.
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { settings0 } from '../../tests/dataHelpers';
import { attempt, fakeBank, q } from '../../tests/helpers';
import { createSupabaseBackend } from './supabaseBackend';
import { createAppClient } from './supabaseClient';

const URL = 'https://fakeproject.supabase.test';
interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

function fakeClient(reply: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new globalThis.URL(String(input instanceof Request ? input.url : input));
    const call = {
      method: init?.method ?? 'GET',
      path: u.pathname,
      search: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const r = reply(call);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createClient(URL, 'sb_publishable_fake', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { backend: createSupabaseBackend(client), calls };
}

const bank = fakeBank();
const a1 = attempt(q(bank, 'fake1-q01'), true, '2026-10-13T13:00:00-07:00');

describe('Supabase backend', () => {
  it('applyChanges calls the apply_changes RPC with the canonical answers', async () => {
    const { backend, calls } = fakeClient(() => ({
      json: {
        inserted: 1,
        duplicates: 0,
        rejected: [],
        settings_version: 3,
        settings_conflict: false,
        server_settings: null,
        settings_error: null,
        max_seq: 41,
      },
    }));
    const r = await backend.applyChanges([a1], settings0(), 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/rest/v1/rpc/apply_changes');
    expect(calls[0]!.body).toEqual({
      p_attempts: [{ ...a1, answeredAt: '2026-10-13T20:00:00.000Z' }],
      p_settings: settings0(),
      p_settings_base_version: 2,
    });
    expect(r).toEqual({
      inserted: 1,
      duplicates: 0,
      rejected: [],
      settingsVersion: 3,
      settingsConflict: false,
      serverSettings: null,
      settingsError: null,
      maxSeq: 41,
    });
  });

  it('refuses more than 200 answers before calling the server', async () => {
    const { backend, calls } = fakeClient(() => ({ json: {} }));
    await expect(backend.applyChanges(Array(201).fill(a1), null, null)).rejects.toThrow('200');
    expect(calls).toHaveLength(0);
  });

  it('turns a server error into a readable message', async () => {
    const { backend } = fakeClient(() => ({
      status: 400,
      json: { message: 'too many answers in one call (201 > 200)', code: 'P0001' },
    }));
    await expect(backend.applyChanges([a1], null, null)).rejects.toThrow(
      'Saving to the server failed: too many answers in one call (201 > 200)',
    );
    const { backend: b2 } = fakeClient(() => ({ status: 500, json: {} }));
    await expect(b2.getSettings()).rejects.toThrow('Reading settings from the server failed');
    await expect(b2.pullAttempts(0, 10)).rejects.toThrow('Reading answers from the server failed');
  });

  it('pullAttempts asks for seq > cursor, oldest first, one page; reads rows in the server spelling', async () => {
    const row = {
      seq: 7,
      id: a1.id,
      question_id: a1.questionId,
      revision: a1.revision,
      answer_fp: a1.answerFp,
      correct: a1.correct,
      xp: a1.xp,
      mode: a1.mode,
      response: a1.response,
      answered_at: '2026-10-13T20:00:00+00:00',
    };
    const { backend, calls } = fakeClient(() => ({ json: [row, { ...row, seq: 8, id: 'bad' }] }));
    const page = await backend.pullAttempts(6, 500);
    expect(calls[0]!.path).toBe('/rest/v1/attempts');
    expect(calls[0]!.search.get('select')).toBe(
      'seq,id,question_id,revision,answer_fp,correct,xp,mode,response,answered_at',
    );
    expect(calls[0]!.search.get('seq')).toBe('gt.6');
    expect(calls[0]!.search.get('order')).toBe('seq.asc');
    expect(calls[0]!.search.get('limit')).toBe('500');
    expect(page.rows).toEqual([
      { seq: 7, attempt: { ...a1, answeredAt: '2026-10-13T20:00:00.000Z' } },
    ]);
    expect(page.lastSeq).toBe(8);
    expect(page.bad).toEqual(['answer bad: id must be a lowercase uuid']);
    const { backend: nothing } = fakeClient(() => ({ json: null }));
    expect(await nothing.pullAttempts(0, 500)).toEqual({ rows: [], lastSeq: null, bad: [] });
    const { backend: empty } = fakeClient(() => ({ json: [{ junk: true }] }));
    expect(await empty.pullAttempts(0, 500)).toEqual({
      rows: [],
      lastSeq: null,
      bad: ['malformed answer row'],
    });
  });

  it('getSettings reads the row (or null when there is none)', async () => {
    const { backend, calls } = fakeClient(() => ({
      json: [
        {
          new_per_day: 15,
          lesson_size: 10,
          daily_xp_goal: 30,
          exam_date: '2026-12-15',
          reminder_enabled: false,
          reminder_time: '15:00:00',
          time_zone: 'America/Los_Angeles',
          version: 4,
        },
      ],
    }));
    expect(await backend.getSettings()).toEqual({ settings: settings0(), version: 4 });
    expect(calls[0]!.path).toBe('/rest/v1/settings');
    expect(calls[0]!.search.get('select')).toBe(
      'new_per_day,lesson_size,daily_xp_goal,exam_date,reminder_enabled,reminder_time,time_zone,version',
    );
    const { backend: none } = fakeClient(() => ({ json: [] }));
    expect(await none.getSettings()).toBeNull();
  });
});

describe('createAppClient', () => {
  it('needs the URL and the publishable key', () => {
    expect(() => createAppClient('', 'x')).toThrow('not configured');
    expect(() => createAppClient(URL, undefined)).toThrow('not configured');
    expect(createAppClient(URL, 'sb_publishable_fake').auth).toBeDefined();
  });
});
