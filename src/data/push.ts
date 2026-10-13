// The daily reminder on this device: asking for permission, subscribing to Web Push, and
// keeping the server's copy of the subscription fresh (BUILD_PLAN Phase 7).
//
// iOS rules this follows: push works only in the installed Home Screen app; the permission
// request must come straight from a tap (nothing awaited before it); every push shows a
// notification (`userVisibleOnly`). Subscriptions can expire, so every app start re-saves
// the current one (or subscribes again) while the reminder is on.
import { validateSubscription, type PushSubscriptionKeys } from '../domain/validate';
import type { Backend } from './backend';
import { errorText } from './store';

export type Permission = 'granted' | 'denied' | 'default';

/** The parts of a browser `PushSubscription` used here. */
export interface PushSubscriptionLike {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null } | undefined;
  toJSON(): { keys?: Record<string, string> | undefined };
  unsubscribe(): Promise<boolean>;
}

/** The parts of a browser `PushManager` used here. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike>;
}

/** What this file needs from the browser (tests pass a fake). */
export interface PushPlatform {
  /** The notification permission, or null when this browser cannot do push at all. */
  permission(): Permission | null;
  requestPermission(): Promise<Permission>;
  /** The service worker's push manager, once the worker is ready. */
  pushManager(): Promise<PushManagerLike>;
}

export interface PushDeps {
  platform: PushPlatform;
  /** The VAPID public key (repo variable VITE_VAPID_PUBLIC_KEY); missing until SETUP. */
  vapidKey: string | undefined;
}

/** How long to wait for the service worker before giving up. */
export const WORKER_TIMEOUT_MS = 10_000;

interface BrowserGlobals {
  Notification?: {
    permission: Permission;
    requestPermission(): Promise<Permission>;
  };
  PushManager?: unknown;
  navigator?: {
    serviceWorker?: { ready: Promise<{ pushManager: PushManagerLike }> };
  };
}

export function browserPushPlatform(
  g: BrowserGlobals = globalThis as unknown as BrowserGlobals,
  timeoutMs = WORKER_TIMEOUT_MS,
): PushPlatform {
  const supported = !!g.Notification && !!g.PushManager && !!g.navigator?.serviceWorker;
  return {
    permission: () => (supported ? g.Notification!.permission : null),
    requestPermission: () => g.Notification!.requestPermission(),
    pushManager: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the offline part of the app is not running; reopen the app')),
          timeoutMs,
        );
        g.navigator!.serviceWorker!.ready.then(
          (reg) => {
            clearTimeout(timer);
            resolve(reg.pushManager);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      }),
  };
}

/** A base64url VAPID key → the bytes `pushManager.subscribe` wants. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer, b: Uint8Array): boolean {
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** This device's subscription for our VAPID key, subscribing (again) when needed. */
async function ensureSubscription(
  pm: PushManagerLike,
  key: Uint8Array<ArrayBuffer>,
): Promise<PushSubscriptionLike> {
  const existing = await pm.getSubscription();
  const existingKey = existing?.options?.applicationServerKey;
  if (existing && (!existingKey || sameBytes(existingKey, key))) return existing;
  // Made with a different server key (the keys were replaced): it can never work again.
  if (existing) await existing.unsubscribe();
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

function keysOf(sub: PushSubscriptionLike): PushSubscriptionKeys {
  const keys = sub.toJSON().keys;
  const r = validateSubscription({
    endpoint: sub.endpoint,
    p256dh: keys?.p256dh,
    auth: keys?.auth,
  });
  if (!r.ok) throw new Error(`this phone gave an unusable subscription (${r.errors.join('; ')})`);
  return r.value;
}

export type TurnOnResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'not-set-up' }
  | { ok: false; reason: 'error'; error: string };

/**
 * Turns the reminder on for this device: asks for permission, subscribes, and saves the
 * subscription on the server. Call it straight from the tap handler: the permission request
 * is made synchronously, before anything is awaited (iOS ignores it otherwise). The caller
 * saves `reminderEnabled: true` only when this succeeds.
 */
export function turnOnReminder(push: PushDeps, backend: Backend): Promise<TurnOnResult> {
  if (push.platform.permission() === null)
    return Promise.resolve({ ok: false, reason: 'unsupported' });
  if (!push.vapidKey) return Promise.resolve({ ok: false, reason: 'not-set-up' });
  const asked = push.platform.requestPermission(); // first thing in the tap: nothing before it
  const key = push.vapidKey;
  return (async (): Promise<TurnOnResult> => {
    try {
      const answer = await asked;
      if (answer === 'denied') return { ok: false, reason: 'denied' };
      if (answer !== 'granted') return { ok: false, reason: 'dismissed' };
      const sub = await ensureSubscription(await push.platform.pushManager(), vapidKeyBytes(key));
      await backend.savePushSubscription(keysOf(sub));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error', error: errorText(e) };
    }
  })();
}

/**
 * Tells the server to stop reminders to this device. The caller has already saved
 * `reminderEnabled: false` (which on its own stops the server once it syncs).
 * Returns an error message, or null.
 */
export async function turnOffReminder(push: PushDeps, backend: Backend): Promise<string | null> {
  if (push.platform.permission() !== 'granted') return null; // never subscribed here
  try {
    const sub = await (await push.platform.pushManager()).getSubscription();
    if (sub) await backend.disablePushSubscription(sub.endpoint);
    return null;
  } catch (e) {
    return errorText(e);
  }
}

export type RefreshResult =
  | { state: 'off' } // reminder off: nothing to do
  | { state: 'ok' } // subscription re-saved
  | { state: 'unsupported' }
  | { state: 'not-set-up' }
  | { state: 'blocked'; permission: 'denied' | 'default' } // on, but this device may not notify
  | { state: 'error'; error: string };

/**
 * At app start (and whenever the reminder is switched on elsewhere): while the reminder is
 * on and notifications are allowed, re-save this device's subscription, subscribing again if
 * it expired. Never asks for permission (that needs a tap).
 */
export async function refreshReminder(
  push: PushDeps,
  backend: Backend,
  reminderEnabled: boolean,
): Promise<RefreshResult> {
  if (!reminderEnabled) return { state: 'off' };
  const permission = push.platform.permission();
  if (permission === null) return { state: 'unsupported' };
  if (permission !== 'granted') return { state: 'blocked', permission };
  if (!push.vapidKey) return { state: 'not-set-up' };
  try {
    const sub = await ensureSubscription(
      await push.platform.pushManager(),
      vapidKeyBytes(push.vapidKey),
    );
    await backend.savePushSubscription(keysOf(sub));
    return { state: 'ok' };
  } catch (e) {
    return { state: 'error', error: errorText(e) };
  }
}
