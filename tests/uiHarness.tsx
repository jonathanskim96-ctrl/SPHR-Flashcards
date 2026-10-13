// Test harness for the screens: the whole app on a fake server, fake IndexedDB, a fixed
// clock and a seeded shuffle. Uses the fake sample bank only.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../src/App';
import { openUserDb } from '../src/data/db';
import { LocalStore } from '../src/data/store';
import { seededRng } from '../src/domain/shuffle';
import type { Attempt } from '../src/domain/types';
import type { AuthApi } from '../src/ui/auth';
import type { AppDeps } from '../src/ui/deps';
import { Clock, testEnv, USER } from './dataHelpers';
import { FakeServer } from './fakeServer';
import { rawSample, TZ } from './helpers';

export const PASSWORD = 'correct horse';

export async function harness(
  opts: {
    signedIn?: boolean;
    bank?: unknown;
    seed?: Attempt[];
    /** The built-in copy of the questions cannot be read. */
    bundledFails?: boolean;
    /** The server cannot be reached from the start. */
    offline?: boolean;
  } = {},
) {
  const clock = new Clock();
  const server = new FakeServer(() => clock.now);
  server.offline = opts.offline ?? false;
  const net = testEnv(clock);
  const factory = new IDBFactory();
  let signedIn = opts.signedIn ?? true;
  const signOutSpy = vi.fn();
  const auth: AuthApi = {
    currentUser: async () => (signedIn ? { id: USER, email: 'm@example.com' } : null),
    signIn: async (email, password) => {
      if (email === 'm@example.com' && password === PASSWORD) {
        signedIn = true;
        return { ok: true, user: { id: USER, email } };
      }
      return { ok: false, error: "That email and password don't match. Check them and try again." };
    },
    signOut: async () => {
      signOutSpy();
      signedIn = false;
      return { error: null };
    },
  };
  const deps: AppDeps = {
    auth,
    backend: server.backend(),
    env: { now: () => clock.now, rng: seededRng(7) },
    sessionOptions: {
      factory,
      env: net.env,
      deviceTimeZone: TZ,
      storage: undefined,
      loadBundled: async () => {
        if (opts.bundledFails) throw new Error('HTTP 500');
        return opts.bank ?? rawSample();
      },
    },
  };
  const user = userEvent.setup();
  if (opts.seed) {
    // Answers from earlier days, saved on the phone before the app opens.
    const store = new LocalStore(await openUserDb(USER, factory), () => clock.now);
    for (const attempt of opts.seed) await store.guardedWrite({ kind: 'attempt', attempt });
    store.close();
  }
  render(<App makeDeps={() => deps} />);
  return { clock, server, net, user, signOutSpy, factory };
}
