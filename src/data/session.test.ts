import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  Clock,
  device,
  FakeServer,
  RIGHT,
  settings0,
  testEnv,
  USER,
} from '../../tests/dataHelpers';
import { TZ } from '../../tests/helpers';
import { openUserDb } from './db';
import {
  ensureSettings,
  openSession,
  requestPersistentStorage,
  signOut,
  signOutBlockedText,
  type Session,
} from './session';
import { LocalStore } from './store';

async function session(server: FakeServer, clock: Clock, factory = new IDBFactory()) {
  const net = testEnv(clock);
  const s = await openSession({
    userId: USER,
    backend: server.backend(),
    factory,
    env: net.env,
    deviceTimeZone: TZ,
    storage: { persisted: async () => false, persist: async () => true },
  });
  return { s, net, factory };
}

const okAuth = { signOut: vi.fn(async () => ({ error: null })) };

describe('openSession', () => {
  it('takes the server settings, asks for persistent storage and starts syncing', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings({ ...settings0(), dailyXpGoal: 60 });
    const { s } = await session(server, clock);
    expect(await s.persistence).toBe('persisted');
    expect(await s.store.settingsRecord()).toEqual({
      settings: { ...settings0(), dailyXpGoal: 60 },
      version: 1,
      isDefault: false,
    });
    await s.engine.sync();
    expect((await s.engine.status()).lastSyncAt).not.toBeNull();
    s.engine.stop();
    s.store.close();
  });

  it('a new account gets default settings in the device zone, saved to the server', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const { s } = await session(server, clock);
    await s.engine.sync();
    expect(server.settings).toEqual({ value: settings0(), version: 1 });
    s.engine.stop();
    s.store.close();
  });

  it('offline on first start: defaults now, the server copy wins later, silently', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings({ ...settings0(), lessonSize: 25 });
    server.offline = true;
    const factory = new IDBFactory();
    const store = new LocalStore(await openUserDb(USER, factory));
    await ensureSettings(store, server.backend(), 'Not/AZone');
    expect((await store.settingsRecord())?.settings.timeZone).toBe('UTC');
    await ensureSettings(store, server.backend(), TZ); // already has settings: no change
    expect((await store.settingsRecord())?.settings.timeZone).toBe('UTC');
    store.close();
  });

  it('uses the browser defaults when none are injected', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const net = testEnv(clock);
    const s = await openSession({
      userId: USER,
      backend: server.backend(),
      factory: new IDBFactory(),
      env: net.env,
    });
    expect(await s.persistence).toBe('unsupported'); // Node has no navigator.storage
    expect((await s.store.settingsRecord())?.settings.timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    s.engine.stop();
    s.store.close();
  });
});

it('defaults to the browser environment for syncing', async () => {
  const clock = new Clock();
  const server = new FakeServer(() => clock.now);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  try {
    const s = await openSession({
      userId: USER,
      backend: server.backend(),
      factory: new IDBFactory(),
    });
    await s.engine.sync();
    expect(server.settings?.version).toBe(1);
    s.engine.stop();
    s.store.close();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('requestPersistentStorage', () => {
  it('reports each outcome', async () => {
    expect(await requestPersistentStorage(undefined)).toBe('unsupported');
    expect(await requestPersistentStorage({})).toBe('unsupported');
    expect(
      await requestPersistentStorage({ persisted: async () => true, persist: async () => false }),
    ).toBe('persisted');
    expect(await requestPersistentStorage({ persist: async () => false })).toBe('denied');
    expect(
      await requestPersistentStorage({
        persist: async () => {
          throw new Error('nope');
        },
      }),
    ).toEqual({ error: 'nope' });
    expect(await requestPersistentStorage({ persist: () => Promise.reject('plain') })).toEqual({
      error: 'plain',
    });
  });
});

describe('signOut', () => {
  async function withPending(): Promise<{ s: Session; server: FakeServer; factory: IDBFactory }> {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const { s, factory } = await session(server, clock);
    await s.engine.sync();
    s.engine.stop();
    return { s, server, factory };
  }

  it('is refused while answers are waiting to back up, and keeps everything', async () => {
    const { s, server } = await withPending();
    server.offline = true;
    const d = { store: s.store };
    const clock = new Clock();
    const helper = await device(server, clock); // only to build a valid answer
    const a = await helper.answer('fake1-q01', RIGHT);
    await d.store.guardedWrite({ kind: 'attempt', attempt: { ...a } });
    const r = await signOut(s, okAuth);
    expect(r).toEqual({ ok: false, reason: 'unsynced', pendingAnswers: 1, pendingSettings: false });
    expect(okAuth.signOut).not.toHaveBeenCalled();
    expect(await s.store.attempts()).toHaveLength(1);
    s.store.close();
  });

  it('syncs first, then signs out and deletes this user’s local data', async () => {
    const { s, server, factory } = await withPending();
    const clock = new Clock();
    const helper = await device(server, clock);
    const a = await helper.answer('fake1-q01', RIGHT);
    await s.store.guardedWrite({
      kind: 'attempt',
      attempt: { ...a, id: '00000000-0000-4000-8000-0000000fffff' },
    });
    expect(await signOut(s, okAuth)).toEqual({ ok: true });
    expect(server.rows.map((r) => r.attempt.id)).toContain('00000000-0000-4000-8000-0000000fffff');
    expect(await factory.databases()).toEqual([]);
    const reopened = new LocalStore(await openUserDb(USER, factory));
    expect(await reopened.attempts()).toEqual([]);
    expect(await reopened.settingsRecord()).toBeUndefined();
    reopened.close();
  });

  it('reports an auth failure and keeps the local data', async () => {
    const { s } = await withPending();
    const r = await signOut(s, { signOut: async () => ({ error: { message: 'network down' } }) });
    expect(r).toEqual({ ok: false, reason: 'error', error: 'Sign-out failed: network down' });
    expect(await s.store.settingsRecord()).toBeDefined();
    const r2 = await signOut(s, {
      signOut: async () => {
        throw new Error('boom');
      },
    });
    expect(r2).toEqual({ ok: false, reason: 'error', error: 'Sign-out failed: boom' });
    s.store.close();
  });

  it('words the refusal', () => {
    expect(signOutBlockedText({ pendingAnswers: 1, pendingSettings: false })).toBe(
      "You can't sign out yet: 1 answer is not backed up. Connect to the internet and try again, or export your progress first.",
    );
    expect(signOutBlockedText({ pendingAnswers: 3, pendingSettings: true })).toMatch(
      /^You can't sign out yet: 3 answers and a settings change are not backed up\./,
    );
    expect(signOutBlockedText({ pendingAnswers: 0, pendingSettings: true })).toMatch(
      /^You can't sign out yet: a settings change is not backed up\./,
    );
  });
});
