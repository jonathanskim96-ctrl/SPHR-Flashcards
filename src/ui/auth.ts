// Email + password sign-in (the only provider; the account is created by the owner in the
// Supabase dashboard and public sign-ups are off). The app talks to this small interface so
// screens can be tested without a network.
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorText } from '../data/store';
import type { AuthLike } from '../data/session';

export interface AuthUser {
  id: string;
  email: string;
}

export type SignInResult = { ok: true; user: AuthUser } | { ok: false; error: string };

export interface AuthApi extends AuthLike {
  /** The signed-in user (restored from the phone's saved login), or null. */
  currentUser(): Promise<AuthUser | null>;
  signIn(email: string, password: string): Promise<SignInResult>;
}

export const BAD_LOGIN_TEXT = "That email and password don't match. Check them and try again.";

export function supabaseAuth(client: SupabaseClient): AuthApi {
  return {
    async currentUser() {
      const { data, error } = await client.auth.getSession();
      if (error) throw new Error(error.message);
      const u = data.session?.user;
      return u ? { id: u.id, email: u.email ?? '' } : null;
    },
    async signIn(email, password) {
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error)
          return {
            ok: false,
            error: /invalid login credentials/i.test(error.message)
              ? BAD_LOGIN_TEXT
              : `Could not sign in: ${error.message}`,
          };
        if (!data.user) return { ok: false, error: 'Could not sign in: no account came back.' };
        return { ok: true, user: { id: data.user.id, email: data.user.email ?? email } };
      } catch (e) {
        return {
          ok: false,
          error: `Could not reach the server. Check your internet connection and try again. (${errorText(e)})`,
        };
      }
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      return { error: error ? { message: error.message } : null };
    },
  };
}
