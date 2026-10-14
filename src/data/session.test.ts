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
import { rawSample, TZ } from '../../tests/helpers';
import { deleteUserDb, openUserDb } from './db';
import {
  ensureSettings,
  openSession,
  requestPersistentStorage,
  signOut,
  signOutBlockedText,
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
    loadBundled: async () => rawSample(),
  });
  return { s, net, factory };
}

const okAuth = { signOut: vi.fn(async () => ({ error: null })) };

describe('openSession', () => {
  it('loads the question bank in the background', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const { s } = await session(server, clock);
    await vi.waitFor(() => expect(s.bank.bank?.bankVersion).toBe('2026-10-13.1'));
    await vi.waitFor(() => expect(s.bank.status().checking).toBe(false));
    expect(s.bank.status()).toMatchObject({ source: 'bundled', lastError: null });
    s.engine.stop();
    s.bank.stop();
    s.store.close();
  });

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
  async function withPending() {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const { s, factory, net } = await session(server, clock);
    await s.engine.sync();
    await vi.waitFor(() => expect(s.bank.bank).not.toBeNull());
    s.engine.stop();
    return { s, server, factory, net };
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
    const { s, server, factory, net } = await withPending();
    const clock = new Clock();
    const helper = await device(server, clock);
    const a = await helper.answer('fake1-q01', RIGHT);
    await s.store.guardedWrite({
      kind: 'attempt',
      attempt: { ...a, id: '00000000-0000-4000-8000-0000000fffff' },
    });
    expect(await signOut(s, okAuth)).toEqual({ ok: true });
    expect(net.wakers.size).toBe(0); // the bank stopped checking too
    expect(server.rows.map((r) => r.attempt.id)).toContain('00000000-0000-4000-8000-0000000fffff');
    expect(await factory.databases()).toEqual([]);
    const reopened = new LocalStore(await openUserDb(USER, factory));
    expect(await reopened.attempts()).toEqual([]);
    expect(await reopened.settingsRecord()).toBeUndefined();
    reopened.close();
  });

  it('reports a failing check instead of throwing, and does not sign out (audit L10)', async () => {
    const { s } = await withPending();
    const auth = { signOut: vi.fn(async () => ({ error: null })) };
    vi.spyOn(s.store, 'pending').mockRejectedValueOnce(new Error('database closed'));
    expect(await signOut(s, auth)).toEqual({
      ok: false,
      reason: 'error',
      error: 'Sign-out failed: database closed',
    });
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(await s.store.settingsRecord()).toBeDefined();
    s.store.close();
  });

  it('an account sign-out that fails after the data was removed says so (audit L1)', async () => {
    const { s, factory } = await withPending();
    const r = await signOut(s, { signOut: async () => ({ error: { message: 'network down' } }) });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(r.ok === false && r.reason === 'error' && r.error).toMatch(
      /all backed up .* signing out did not finish \(network down\)/,
    );
    expect(await factory.databases()).toEqual([]); // removed first: everything was backed up
    const s2 = (await withPending()).s;
    const r2 = await signOut(s2, {
      signOut: async () => {
        throw new Error('boom');
      },
    });
    expect(r2.ok === false && r2.reason === 'error' && r2.error).toMatch(/\(boom\)/);
  });

  it('a second tab closes its data at once when another signs out, so nothing is lost (audit L1)', async () => {
    const { s, factory } = await withPending();
    let closedB = 0;
    const tabB = new LocalStore(await openUserDb(USER, factory, () => closedB++));
    const auth = { signOut: vi.fn(async () => ({ error: null })) };
    expect(await signOut(s, auth)).toEqual({ ok: true });
    expect(closedB).toBe(1);
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(await factory.databases()).toEqual([]);
    // Tab B can no longer save into the removed data; it says so instead.
    const clock = new Clock();
    const a = await (await device(new FakeServer(), clock)).answer('fake1-q01', RIGHT);
    const w = await tabB.guardedWrite({ kind: 'attempt', attempt: a });
    expect(w.ok).toBe(false);
  });

  it('an older open copy that does not close: sign-out waits for it, then finishes (audit L1)', async () => {
    const { s, factory } = await withPending();
    // An older copy of the app (before audit L1) keeps its connection open.
    const old = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(`sphr-${USER}`, 1);
      req.onsuccess = () => resolve(req.result);
    });
    const onWaiting = vi.fn();
    const auth = { signOut: vi.fn(async () => ({ error: null })) };
    const done = signOut(s, auth, onWaiting);
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalled());
    expect(auth.signOut).not.toHaveBeenCalled();
    old.close();
    expect(await done).toEqual({ ok: true });
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it('signed out in another tab while this copy is still opening: opening fails (audit L1)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const factory = new IDBFactory();
    const backend = server.backend();
    const opening = openSession({
      userId: USER,
      backend: {
        ...backend,
        getSettings: async () => {
          await deleteUserDb(USER, factory); // the other tab's sign-out
          return null;
        },
      },
      factory,
      env: testEnv(clock).env,
      deviceTimeZone: TZ,
      storage: undefined,
      loadBundled: async () => rawSample(),
    });
    await expect(opening).rejects.toThrow();
    expect(await factory.databases()).toEqual([]);
  });

  it('tells listeners once when another tab signs out', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const factory = new IDBFactory();
    const { s } = await session(server, clock, factory);
    const heard = vi.fn();
    const unsubscribe = s.onClosedElsewhere(heard);
    const ignored = vi.fn();
    s.onClosedElsewhere(ignored)();
    await deleteUserDb(USER, factory);
    expect(heard).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
    unsubscribe();
    const late = vi.fn();
    s.onClosedElsewhere(late)(); // after the fact: called at once
    expect(late).toHaveBeenCalledOnce();
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
