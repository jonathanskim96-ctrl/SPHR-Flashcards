// The daily reminder on this device, against a fake browser and the fake server.
import { describe, expect, it, vi } from 'vitest';
import { AUTH, FakeSub, fakeBrowser, KEY, OTHER_KEY, P256DH } from '../../tests/fakePush';
import { FakeServer } from '../../tests/fakeServer';
import {
  browserPushPlatform,
  refreshReminder,
  turnOffReminder,
  turnOnReminder,
  vapidKeyBytes,
  type Permission,
  type PushManagerLike,
} from './push';

describe('turnOnReminder', () => {
  it('asks for permission synchronously, before anything is awaited', () => {
    const b = fakeBrowser();
    const server = new FakeServer();
    void turnOnReminder(b.push, server.backend());
    // Nothing has been awaited yet, and the permission request has already been made.
    expect(b.log).toEqual(['requestPermission']);
  });

  it('allowed: subscribes with userVisibleOnly and our key, and saves it on the server', async () => {
    const b = fakeBrowser();
    const server = new FakeServer();
    expect(await turnOnReminder(b.push, server.backend())).toEqual({ ok: true });
    expect(b.log).toEqual([
      'requestPermission',
      'pushManager',
      'getSubscription',
      'subscribe true',
    ]);
    expect(server.pushCalls).toEqual(['save https://web.push.apple.com/sub-1']);
    expect([...server.subscriptions.values()]).toEqual([
      { endpoint: 'https://web.push.apple.com/sub-1', p256dh: P256DH, auth: AUTH, disabled: false },
    ]);
    expect(new Uint8Array(b.current!.options.applicationServerKey!)).toEqual(vapidKeyBytes(KEY));
  });

  it('reuses an existing subscription made with the same key (or one that hides its key)', async () => {
    for (const key of [vapidKeyBytes(KEY), null]) {
      const b = fakeBrowser({ permission: 'granted' });
      b.current = new FakeSub('https://web.push.apple.com/old', key);
      const server = new FakeServer();
      expect(await turnOnReminder(b.push, server.backend())).toEqual({ ok: true });
      expect(b.log).not.toContain('subscribe true');
      expect(server.pushCalls).toEqual(['save https://web.push.apple.com/old']);
    }
  });

  it('replaces a subscription made with an old server key', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    const old = new FakeSub('https://web.push.apple.com/old', vapidKeyBytes(OTHER_KEY));
    b.current = old;
    const server = new FakeServer();
    expect(await turnOnReminder(b.push, server.backend())).toEqual({ ok: true });
    expect(old.unsubscribed).toBe(true);
    expect(server.pushCalls).toEqual(['save https://web.push.apple.com/sub-1']);
  });

  it('denied or dismissed: nothing is subscribed or saved', async () => {
    for (const [answer, reason] of [
      ['denied', 'denied'],
      ['default', 'dismissed'],
    ] as const) {
      const b = fakeBrowser({ answer });
      const server = new FakeServer();
      expect(await turnOnReminder(b.push, server.backend())).toEqual({ ok: false, reason });
      expect(b.log).toEqual(['requestPermission']);
      expect(server.pushCalls).toEqual([]);
    }
  });

  it('no push in this browser, or no VAPID key yet: says so without asking', async () => {
    const b = fakeBrowser({ permission: null });
    const server = new FakeServer();
    expect(await turnOnReminder(b.push, server.backend())).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    const c = fakeBrowser();
    expect(await turnOnReminder({ ...c.push, vapidKey: undefined }, server.backend())).toEqual({
      ok: false,
      reason: 'not-set-up',
    });
    expect([...b.log, ...c.log]).toEqual([]);
  });

  it('offline, or a broken subscription: an error to show, nothing saved', async () => {
    const b = fakeBrowser();
    const server = new FakeServer();
    server.offline = true;
    expect(await turnOnReminder(b.push, server.backend())).toEqual({
      ok: false,
      reason: 'error',
      error: 'Saving to the server failed: TypeError: Failed to fetch',
    });

    const c = fakeBrowser({ permission: 'granted' });
    c.current = new FakeSub('https://web.push.apple.com/x', null, null);
    const r = await turnOnReminder(c.push, new FakeServer().backend());
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(r.ok === false && r.reason === 'error' && r.error).toMatch(/unusable subscription/);

    const d = fakeBrowser({ permission: 'granted' });
    d.push.platform.pushManager = () => Promise.reject(new Error('no worker'));
    expect(await turnOnReminder(d.push, new FakeServer().backend())).toEqual({
      ok: false,
      reason: 'error',
      error: 'no worker',
    });
  });
});

describe('turnOffReminder', () => {
  it("disables this device's subscription on the server (never deletes)", async () => {
    const b = fakeBrowser();
    const server = new FakeServer();
    await turnOnReminder(b.push, server.backend());
    expect(await turnOffReminder(b.push, server.backend())).toBeNull();
    expect(server.pushCalls).toEqual([
      'save https://web.push.apple.com/sub-1',
      'disable https://web.push.apple.com/sub-1',
    ]);
    expect(server.subscriptions.get('https://web.push.apple.com/sub-1')?.disabled).toBe(true);
  });

  it('nothing to do without permission or without a subscription', async () => {
    const server = new FakeServer();
    expect(await turnOffReminder(fakeBrowser().push, server.backend())).toBeNull();
    expect(
      await turnOffReminder(fakeBrowser({ permission: 'granted' }).push, server.backend()),
    ).toBeNull();
    expect(server.pushCalls).toEqual([]);
  });

  it('offline: returns the error to show', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    b.current = new FakeSub('https://web.push.apple.com/x', null);
    const server = new FakeServer();
    server.offline = true;
    expect(await turnOffReminder(b.push, server.backend())).toBe(
      'Saving to the server failed: TypeError: Failed to fetch',
    );
  });
});

describe('refreshReminder (every app start)', () => {
  it('re-saves the existing subscription while the reminder is on', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    b.current = new FakeSub('https://web.push.apple.com/kept', vapidKeyBytes(KEY));
    const server = new FakeServer();
    expect(await refreshReminder(b.push, server.backend(), true)).toEqual({ state: 'ok' });
    expect(server.pushCalls).toEqual(['save https://web.push.apple.com/kept']);
    expect(b.log).not.toContain('requestPermission');
  });

  it('subscribes again when the subscription expired', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    const server = new FakeServer();
    expect(await refreshReminder(b.push, server.backend(), true)).toEqual({ state: 'ok' });
    expect(b.log).toEqual(['pushManager', 'getSubscription', 'subscribe true']);
    expect(server.pushCalls).toEqual(['save https://web.push.apple.com/sub-1']);
  });

  it('does nothing when off; never asks for permission', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    const server = new FakeServer();
    expect(await refreshReminder(b.push, server.backend(), false)).toEqual({ state: 'off' });
    expect([...b.log, ...server.pushCalls]).toEqual([]);
  });

  it('on, but this device may not notify / cannot push / has no key yet', async () => {
    const server = new FakeServer();
    for (const p of ['denied', 'default'] as const)
      expect(
        await refreshReminder(fakeBrowser({ permission: p }).push, server.backend(), true),
      ).toEqual({ state: 'blocked', permission: p });
    expect(
      await refreshReminder(fakeBrowser({ permission: null }).push, server.backend(), true),
    ).toEqual({ state: 'unsupported' });
    const b = fakeBrowser({ permission: 'granted' });
    expect(
      await refreshReminder({ ...b.push, vapidKey: undefined }, server.backend(), true),
    ).toEqual({ state: 'not-set-up' });
    expect(server.pushCalls).toEqual([]);
  });

  it('offline: an error to show', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    const server = new FakeServer();
    server.offline = true;
    expect(await refreshReminder(b.push, server.backend(), true)).toEqual({
      state: 'error',
      error: 'Saving to the server failed: TypeError: Failed to fetch',
    });
  });
});

describe('vapidKeyBytes', () => {
  it('decodes base64url with or without padding', () => {
    expect(vapidKeyBytes(KEY)).toHaveLength(65);
    expect(vapidKeyBytes(KEY)[0]).toBe(4); // an uncompressed P-256 point
    expect([...vapidKeyBytes('-_8')]).toEqual([251, 255]);
    expect([...vapidKeyBytes('AQ==')]).toEqual([1]);
  });
});

describe('browserPushPlatform', () => {
  const pm: PushManagerLike = {
    getSubscription: () => Promise.resolve(null),
    subscribe: () => Promise.reject(new Error('unused')),
  };

  it('reads the permission and asks through Notification', async () => {
    const Notification = {
      permission: 'default' as Permission,
      requestPermission: vi.fn(() => Promise.resolve('granted' as Permission)),
    };
    const p = browserPushPlatform({
      Notification,
      PushManager: {},
      navigator: { serviceWorker: { ready: Promise.resolve({ pushManager: pm }) } },
    });
    expect(p.permission()).toBe('default');
    expect(await p.requestPermission()).toBe('granted');
    expect(await p.pushManager()).toBe(pm);
  });

  it('no Notification, no PushManager or no service worker: unsupported', () => {
    const N = { permission: 'granted' as Permission, requestPermission: vi.fn() };
    const sw = { serviceWorker: { ready: Promise.resolve({ pushManager: pm }) } };
    expect(browserPushPlatform({ PushManager: {}, navigator: sw }).permission()).toBeNull();
    expect(browserPushPlatform({ Notification: N, navigator: sw }).permission()).toBeNull();
    expect(
      browserPushPlatform({ Notification: N, PushManager: {}, navigator: {} }).permission(),
    ).toBeNull();
    expect(browserPushPlatform({ Notification: N, PushManager: {} }).permission()).toBeNull();
  });

  it('gives up when the service worker never becomes ready, and reports its failure', async () => {
    const never = browserPushPlatform(
      {
        Notification: { permission: 'granted', requestPermission: vi.fn() },
        PushManager: {},
        navigator: { serviceWorker: { ready: new Promise(() => {}) } },
      },
      5,
    );
    await expect(never.pushManager()).rejects.toThrow(/not running/);
    const failing = (reason: unknown) =>
      browserPushPlatform({
        Notification: { permission: 'granted', requestPermission: vi.fn() },
        PushManager: {},
        navigator: { serviceWorker: { ready: Promise.reject(reason) } },
      }).pushManager();
    await expect(failing(new Error('broken worker'))).rejects.toThrow('broken worker');
    await expect(failing('plain reason')).rejects.toThrow('plain reason');
  });

  it('uses the real globals by default', () => {
    // vitest runs in Node: no Notification there.
    expect(browserPushPlatform().permission()).toBeNull();
  });
});
