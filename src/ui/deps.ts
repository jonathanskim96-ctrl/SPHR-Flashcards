// Everything the screens need from the outside world, in one place so tests can swap it.
import type { Backend } from '../data/backend';
import type { SessionOptions } from '../data/session';
import { createSupabaseBackend } from '../data/supabaseBackend';
import { createAppClient } from '../data/supabaseClient';
import type { Rng } from '../domain/shuffle';
import { supabaseAuth, type AuthApi } from './auth';

export interface AppEnv {
  now(): number;
  /** Used for the display order of choices; never affects grading. */
  rng: Rng;
}

export interface AppDeps {
  auth: AuthApi;
  backend: Backend;
  env: AppEnv;
  /** Test hooks for opening the session (fake IndexedDB, fake clock, ...). */
  sessionOptions?: Partial<Omit<SessionOptions, 'userId' | 'backend'>>;
}

/** Throws when the Supabase URL or key is missing (the screen then says so). */
export function productionDeps(): AppDeps {
  const client = createAppClient();
  return {
    auth: supabaseAuth(client),
    backend: createSupabaseBackend(client),
    env: { now: Date.now, rng: Math.random },
  };
}
