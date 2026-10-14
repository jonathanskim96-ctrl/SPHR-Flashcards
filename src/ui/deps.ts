// Everything the screens need from the outside world, in one place so tests can swap it.
import type { Backend } from '../data/backend';
import { browserPushPlatform, type PushDeps } from '../data/push';
import type { SessionOptions } from '../data/session';
import { createSupabaseBackend } from '../data/supabaseBackend';
import { createAppClient } from '../data/supabaseClient';
import type { Rng } from '../domain/shuffle';
import { supabaseAuth, type AuthApi } from './auth';
import { isStandalone } from './install';

export interface AppEnv {
  now(): number;
  /** Used for the display order of choices; never affects grading. */
  rng: Rng;
  /** Opened from the Home Screen icon (an installed app), not a browser tab. */
  installed: boolean;
  /** This device's time zone (default: the browser's). Settings offers it if different. */
  deviceTimeZone?: () => string;
}

export interface AppDeps {
  auth: AuthApi;
  backend: Backend;
  env: AppEnv;
  /** The daily reminder's browser push (missing: this device cannot do push). */
  push?: PushDeps;
  /** Test hooks for opening the session (fake IndexedDB, fake clock, ...). */
  sessionOptions?: Partial<Omit<SessionOptions, 'userId' | 'backend'>>;
}

/** For a device or a test without push: every reminder action says "not supported". */
export const NO_PUSH: PushDeps = {
  vapidKey: undefined,
  platform: {
    permission: () => null,
    requestPermission: () => Promise.resolve('denied'),
    pushManager: () => Promise.reject(new Error('push is not supported here')),
  },
};

/** Throws when the Supabase URL or key is missing (the screen then says so). */
export function productionDeps(): AppDeps {
  const client = createAppClient();
  return {
    auth: supabaseAuth(client),
    backend: createSupabaseBackend(client),
    env: { now: Date.now, rng: Math.random, installed: isStandalone() },
    push: {
      platform: browserPushPlatform(),
      vapidKey: (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || undefined,
    },
  };
}
