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
import type { Attempt, Settings } from '../src/domain/types';
import { defaultSettings } from '../src/domain/validate';
import type { AuthApi } from '../src/ui/auth';
import type { AppDeps } from '../src/ui/deps';
import { vapidKeyBytes, type Permission } from '../src/data/push';
import { Clock, testEnv, USER } from './dataHelpers';
import { fakeBrowser, FakeSub, KEY } from './fakePush';
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
    /** Opened from the Home Screen icon (default) rather than a browser tab. */
    installed?: boolean;
    /** This device's time zone (default: the same as the settings). */
    deviceTimeZone?: string;
    /** This phone's notification permission before anything is asked (null: no push). */
    permission?: Permission | null;
    /** What she answers when asked for notifications (default: Allow). */
    answer?: Permission;
    /** The VAPID key is not configured. */
    noVapidKey?: boolean;
    /** The phone already has a push subscription for our key (from an earlier visit). */
    subscribed?: boolean;
    /** Settings already saved on the server (a returning user). */
    serverSettings?: Partial<Settings>;
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
  const browser = fakeBrowser({
    permission: opts.permission === undefined ? 'default' : opts.permission,
    ...(opts.answer ? { answer: opts.answer } : {}),
  });
  if (opts.noVapidKey) browser.push.vapidKey = undefined;
  if (opts.subscribed)
    browser.current = new FakeSub('https://web.push.apple.com/earlier', vapidKeyBytes(KEY));
  if (opts.serverSettings)
    server.settings = { value: { ...defaultSettings(TZ), ...opts.serverSettings }, version: 1 };
  const deps: AppDeps = {
    auth,
    backend: server.backend(),
    env: {
      now: () => clock.now,
      rng: seededRng(7),
      installed: opts.installed ?? true,
      deviceTimeZone: () => opts.deviceTimeZone ?? TZ,
    },
    push: browser.push,
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
  return { clock, server, net, user, signOutSpy, factory, browser };
}
