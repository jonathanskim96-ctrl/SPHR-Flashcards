// A pretend Supabase that keeps state, for the Phase 9 end-to-end tests. It answers the
// same HTTP requests the real app makes (auth, PostgREST reads, the `apply_changes` RPC),
// using the unit tests' FakeServer for the `apply_changes` contract, so two browser contexts
// (two "phones") attached to one PretendCloud share one account. Nothing real is contacted.
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { FakeServer } from '../tests/fakeServer';

export const SAMPLE_BANK = 'tests/fixtures/sample-bank.json';
export const loadSampleBank = () =>
  JSON.parse(readFileSync(SAMPLE_BANK, 'utf8')) as Record<string, unknown> & {
    bankVersion: string;
    questions: Record<string, unknown>[];
    scenarios: Record<string, unknown>[];
  };

interface Account {
  id: string;
  password: string;
  server: FakeServer;
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

export class PretendCloud {
  /** The server's clock (ms). Tests that move the phone's clock move this one too. */
  now = Date.now();
  /** Every request, as `METHOD /path?query` (newest last). */
  calls: string[] = [];
  /** Set to make every request fail as if the phone had no signal. */
  down = false;
  private accounts = new Map<string, Account>();
  private tokens = new Map<string, string>(); // token → email
  private n = 0;

  constructor() {
    this.addAccount('michelle@example.com', 'correct horse');
  }

  addAccount(email: string, password: string): FakeServer {
    const id = `00000000-0000-4000-8000-${String(this.accounts.size + 1).padStart(12, '0')}`;
    const server = new FakeServer(() => this.now);
    this.accounts.set(email, { id, password, server });
    return server;
  }

  server(email = 'michelle@example.com'): FakeServer {
    return this.accounts.get(email)!.server;
  }

  /** Answers for http://supabase.test on this page or every page of this context. */
  async attach(target: Page | BrowserContext) {
    await target.route('http://supabase.test/**', (route) => this.handle(route));
  }

  private session(email: string) {
    const account = this.accounts.get(email)!;
    const access = `e2e-access-${++this.n}`;
    const refresh = `e2e-refresh-${this.n}`;
    this.tokens.set(access, email);
    this.tokens.set(refresh, email);
    // No `expires_at`: the app computes it from its own (possibly fake) clock.
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refresh,
      user: {
        id: account.id,
        aud: 'authenticated',
        role: 'authenticated',
        email,
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: '2026-10-01T00:00:00Z',
      },
    };
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    if (this.down) return route.abort('internetdisconnected');
    this.calls.push(`${req.method()} ${url.pathname}${url.search}`);
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    const body = JSON.parse(req.postData() || '{}') as Record<string, unknown>;

    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const email = this.tokens.get(String(body.refresh_token));
        if (!email)
          return route.fulfill(json({ error_code: 'refresh_token_not_found', msg: 'bad' }, 400));
        return route.fulfill(json(this.session(email)));
      }
      const account = this.accounts.get(String(body.email));
      if (!account || account.password !== body.password)
        return route.fulfill(
          json(
            { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            400,
          ),
        );
      return route.fulfill(json(this.session(String(body.email))));
    }
    if (url.pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });

    const token = (req.headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const email = this.tokens.get(token);
    if (!email) return route.fulfill(json({ message: 'JWT expired', code: 'PGRST301' }, 401));
    const server = this.server(email);

    switch (url.pathname) {
      case '/rest/v1/rpc/apply_changes':
        try {
          return route.fulfill(
            json(
              server.applyRaw(
                body.p_attempts as unknown[],
                body.p_settings as never,
                body.p_settings_base_version as number | null,
              ),
            ),
          );
        } catch (e) {
          return route.fulfill(json({ message: String(e) }, 400));
        }
      case '/rest/v1/rpc/save_push_subscription':
        return route.fulfill(json('e2e-subscription-id'));
      case '/rest/v1/rpc/disable_push_subscription':
        return route.fulfill(json(true));
      case '/rest/v1/attempts': {
        const after = Number((url.searchParams.get('seq') ?? 'gt.0').replace(/^gt\./, ''));
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        return route.fulfill(json(server.attemptRows(after, limit)));
      }
      case '/rest/v1/settings': {
        const row = server.settingsRow();
        return route.fulfill(json(row ? [row] : []));
      }
      case '/rest/v1/bank_meta': {
        const b = server.bank;
        return route.fulfill(
          json(
            b
              ? [
                  {
                    schema_version: b.schemaVersion,
                    bank_version: b.bankVersion,
                    areas: b.areas,
                    levels: b.levels,
                  },
                ]
              : [],
          ),
        );
      }
      case '/rest/v1/questions':
      case '/rest/v1/scenarios': {
        const key = url.pathname.endsWith('questions') ? 'questions' : 'scenarios';
        const rows = ((server.bank?.[key] ?? []) as { id: string }[])
          .map((data) => ({ id: data.id, data }))
          .sort((x, y) => (x.id < y.id ? -1 : 1));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        return route.fulfill(json(rows.slice(offset, offset + limit)));
      }
    }
    return route.fulfill(json({ message: `pretend server: no route ${url.pathname}` }, 404));
  }
}

/** A seeded Math.random (mulberry32), so the shuffled order of choices is repeatable. */
export async function seedRandom(target: Page | BrowserContext, seed: number) {
  await target.addInitScript((s) => {
    let a = s >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
}
