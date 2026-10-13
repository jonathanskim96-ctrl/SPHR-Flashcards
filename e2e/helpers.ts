// Shared by the end-to-end tests: the pretend Supabase server and the sign-in steps.
import { type Page } from '@playwright/test';

const USER = {
  id: '00000000-0000-4000-8000-00000000a001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'michelle@example.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-01T00:00:00Z',
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

export async function pretendSupabase(page: Page, opts: { password?: string } = {}) {
  const password = opts.password ?? 'correct horse';
  const calls: string[] = [];
  /** The push-subscription RPCs: `save <endpoint>` / `disable <endpoint>`. */
  const pushCalls: string[] = [];
  const net = { down: false };
  await page.route('http://supabase.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (net.down) return route.abort('internetdisconnected');
    calls.push(`${req.method()} ${url.pathname}`);
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(req.postData() ?? '{}') as { password?: string };
      if (body.password !== password)
        return route.fulfill(
          json(
            { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            400,
          ),
        );
      return route.fulfill(
        json({
          access_token: 'e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'e2e-refresh-token',
          user: USER,
        }),
      );
    }
    if (url.pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname.endsWith('_push_subscription')) {
      const body = JSON.parse(req.postData() ?? '{}') as { p_endpoint?: string };
      pushCalls.push(`${url.pathname.includes('save') ? 'save' : 'disable'} ${body.p_endpoint}`);
      return route.fulfill(json(url.pathname.includes('save') ? 'e2e-subscription-id' : true));
    }
    if (url.pathname === '/rest/v1/rpc/apply_changes')
      return route.fulfill(
        json({
          inserted: 0,
          duplicates: 0,
          rejected: [],
          settings_version: 1,
          settings_conflict: false,
          server_settings: null,
          settings_error: null,
          max_seq: null,
        }),
      );
    // bank_meta, settings, attempts: nothing on the server yet.
    return route.fulfill(json([]));
  });
  return { calls, net, pushCalls };
}

/** Collects Content-Security-Policy violations (the built page carries a strict policy). */
export function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|violates the following/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (/Content Security Policy/i.test(e.message)) violations.push(e.message);
  });
  return violations;
}

/** Pretend the app was opened from the Home Screen icon (iOS's own flag). */
export async function asInstalledApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
}

export async function signIn(page: Page, password = 'correct horse') {
  await page.goto('./');
  await page.getByLabel('Email').fill('michelle@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * A pretend iPhone notification system for the reminder tests: `Notification` (permission
 * and the Allow prompt) and the service worker's `PushManager`. Kept in localStorage so a
 * reload sees the same phone. Every call is logged, with the event being handled at that
 * moment: a permission request made straight from a tap logs `requestPermission@click`.
 */
export async function fakePushPhone(page: Page, opts: { answer?: 'granted' | 'denied' } = {}) {
  await page.addInitScript((answer) => {
    const store = {
      get: (k: string) => localStorage.getItem(`fake-push:${k}`),
      set: (k: string, v: string) => localStorage.setItem(`fake-push:${k}`, v),
    };
    const log = (entry: string) =>
      store.set('log', JSON.stringify([...JSON.parse(store.get('log') ?? '[]'), entry]));
    const subscription = (endpoint: string) => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({
        endpoint,
        keys: {
          p256dh:
            'BIPUL12DLfytvTajnryr2PRdAgXS3HGKiLqndGcJGabyhHheJYlNGCeXl1dn18gSJ1WAkAPIxr4gK0_dQds4yiI',
          auth: 'FPssNDTKnInHVndSTdbKFw',
        },
      }),
      unsubscribe: async () => true,
    });
    const pushManager = {
      getSubscription: async () => {
        log('getSubscription');
        const e = store.get('endpoint');
        return e ? subscription(e) : null;
      },
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        log(`subscribe userVisibleOnly=${o.userVisibleOnly} key=${o.applicationServerKey.length}`);
        const e = `https://web.push.apple.com/e2e-${Date.now()}`;
        store.set('endpoint', e);
        return subscription(e);
      },
    };
    class FakeNotification {
      static get permission() {
        return store.get('permission') ?? 'default';
      }
      static async requestPermission() {
        log(`requestPermission@${window.event?.type ?? 'none'}`);
        store.set('permission', answer);
        return answer;
      }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    const container = {
      controller: null,
      ready: Promise.resolve({ pushManager }),
      register: async () => ({ update: async () => undefined }),
      addEventListener: () => undefined,
    };
    Object.defineProperty(Navigator.prototype, 'serviceWorker', {
      get: () => container,
      configurable: true,
    });
  }, opts.answer ?? 'granted');
  return {
    log: (): Promise<string[]> =>
      page.evaluate(() => JSON.parse(localStorage.getItem('fake-push:log') ?? '[]')),
  };
}
