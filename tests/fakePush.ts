// A fake browser for the daily reminder: Notification permission, the service worker's
// PushManager and its subscription. Records the order of calls, so tests can check that the
// permission request comes first, straight from the tap.
import type { Permission, PushDeps, PushManagerLike, PushSubscriptionLike } from '../src/data/push';

// A real-looking VAPID public key (65 bytes, base64url) and a second one.
export const KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
export const OTHER_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
export const P256DH =
  'BIPUL12DLfytvTajnryr2PRdAgXS3HGKiLqndGcJGabyhHheJYlNGCeXl1dn18gSJ1WAkAPIxr4gK0_dQds4yiI';
export const AUTH = 'FPssNDTKnInHVndSTdbKFw';

export class FakeSub implements PushSubscriptionLike {
  unsubscribed = false;
  options: { applicationServerKey?: ArrayBuffer | null };
  constructor(
    public endpoint: string,
    key: Uint8Array | null,
    private keys: Record<string, string> | null = { p256dh: P256DH, auth: AUTH },
  ) {
    this.options = key ? { applicationServerKey: key.slice().buffer } : {};
  }
  toJSON() {
    return this.keys ? { endpoint: this.endpoint, keys: this.keys } : {};
  }
  unsubscribe() {
    this.unsubscribed = true;
    return Promise.resolve(true);
  }
}

/** A fake browser: records the order of calls so "permission first, from the tap" is checked. */
export function fakeBrowser(o: { permission?: Permission | null; answer?: Permission } = {}) {
  const log: string[] = [];
  let permission: Permission | null = o.permission === undefined ? 'default' : o.permission;
  let current: FakeSub | null = null;
  let n = 0;
  const pm: PushManagerLike = {
    getSubscription: () => {
      log.push('getSubscription');
      return Promise.resolve(current);
    },
    subscribe: (opts) => {
      log.push(`subscribe ${opts.userVisibleOnly}`);
      current = new FakeSub(`https://web.push.apple.com/sub-${++n}`, opts.applicationServerKey);
      return Promise.resolve(current);
    },
  };
  const push: PushDeps = {
    vapidKey: KEY,
    platform: {
      permission: () => permission,
      requestPermission: () => {
        log.push('requestPermission');
        permission = o.answer ?? 'granted';
        return Promise.resolve(permission);
      },
      pushManager: () => {
        log.push('pushManager');
        return Promise.resolve(pm);
      },
    },
  };
  return {
    push,
    log,
    get current() {
      return current;
    },
    set current(s: FakeSub | null) {
      current = s;
    },
    setPermission: (p: Permission | null) => (permission = p),
  };
}
