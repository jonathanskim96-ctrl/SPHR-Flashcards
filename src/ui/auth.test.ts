import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { BAD_LOGIN_TEXT, supabaseAuth } from './auth';

const client = (auth: Record<string, unknown>) => ({ auth }) as unknown as SupabaseClient;

describe('supabaseAuth', () => {
  it('restores the saved user, or null when signed out', async () => {
    const a = supabaseAuth(
      client({
        getSession: async () => ({
          data: { session: { user: { id: 'u1', email: 'm@x.com' } } },
          error: null,
        }),
      }),
    );
    expect(await a.currentUser()).toEqual({ id: 'u1', email: 'm@x.com' });
    const none = supabaseAuth(
      client({ getSession: async () => ({ data: { session: null }, error: null }) }),
    );
    expect(await none.currentUser()).toBeNull();
    const noEmail = supabaseAuth(
      client({
        getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
      }),
    );
    expect(await noEmail.currentUser()).toEqual({ id: 'u1', email: '' });
  });

  it('reports a failure to read the saved login', async () => {
    const a = supabaseAuth(
      client({ getSession: async () => ({ data: { session: null }, error: { message: 'boom' } }) }),
    );
    await expect(a.currentUser()).rejects.toThrow('boom');
  });

  it('signs in with email and password, and explains each failure', async () => {
    const calls: unknown[] = [];
    const ok = supabaseAuth(
      client({
        signInWithPassword: async (c: unknown) => {
          calls.push(c);
          return { data: { user: { id: 'u1', email: 'm@x.com' } }, error: null };
        },
      }),
    );
    expect(await ok.signIn('m@x.com', 'pw')).toEqual({
      ok: true,
      user: { id: 'u1', email: 'm@x.com' },
    });
    expect(calls).toEqual([{ email: 'm@x.com', password: 'pw' }]);

    const bad = supabaseAuth(
      client({
        signInWithPassword: async () => ({
          data: {},
          error: { message: 'Invalid login credentials' },
        }),
      }),
    );
    expect(await bad.signIn('a', 'b')).toEqual({ ok: false, error: BAD_LOGIN_TEXT });

    const other = supabaseAuth(
      client({
        signInWithPassword: async () => ({ data: {}, error: { message: 'Email not confirmed' } }),
      }),
    );
    expect(await other.signIn('a', 'b')).toEqual({
      ok: false,
      error: 'Could not sign in: Email not confirmed',
    });

    const nobody = supabaseAuth(
      client({ signInWithPassword: async () => ({ data: { user: null }, error: null }) }),
    );
    expect((await nobody.signIn('a', 'b')).ok).toBe(false);

    const offline = supabaseAuth(
      client({
        signInWithPassword: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    );
    const r = await offline.signIn('a', 'b');
    expect(r.ok === false && r.error).toContain('Could not reach the server');
  });

  it('signs out and passes on an error message', async () => {
    const ok = supabaseAuth(client({ signOut: async () => ({ error: null }) }));
    expect(await ok.signOut()).toEqual({ error: null });
    const bad = supabaseAuth(client({ signOut: async () => ({ error: { message: 'nope' } }) }));
    expect(await bad.signOut()).toEqual({ error: { message: 'nope' } });
  });
});
