// Tests for the reminder sender (Deno; `npm run test:functions`). No real Supabase or push
// service is contacted: the database is a fake (and, for the adapter, a fake PostgREST), and
// the push service is a local HTTPS server.
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.14';
import https from 'node:https';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';

Deno.env.set('SEND_REMINDERS_TEST', '1');
const {
  CATCH_UP_MS,
  createHandler,
  dueReminder,
  MAX_FAILURES,
  PAYLOAD,
  PUSH_ENDPOINT_RE,
  runReminders,
  sameSecret,
  slotOf,
  SLOT_MS,
  supabaseStore,
  TTL_SECONDS,
  wallClock,
  webPushSender,
} = await import('./index.ts');
type Store = import('./index.ts').Store;
type Device = import('./index.ts').Device;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const utc = (s: string) => Date.parse(s);
const TIMES = Array.from(
  { length: 96 },
  (_, i) =>
    `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
);

/**
 * Runs the scheduler every 15 minutes from `from` to `to` for one account and returns the
 * slots that sent, with the local date recorded. A set stands in for reminder_log's key.
 * `skip` drops runs (as if pg_cron or the function failed at that slot).
 */
function simulate(
  timeZone: string,
  reminderTime: string,
  from: number,
  to: number,
  skip: (slot: number) => boolean = () => false,
) {
  const log = new Set<string>();
  const sent: { slot: number; localDate: string }[] = [];
  for (let s = from; s < to; s += SLOT_MS) {
    if (skip(s)) continue;
    const due = dueReminder(s, timeZone, reminderTime);
    if (due && !log.has(due.localDate)) {
      log.add(due.localDate);
      sent.push({ slot: s, localDate: due.localDate });
    }
  }
  return sent;
}

/** Every local date that is fully inside [from, to) in `timeZone`. */
function fullLocalDays(timeZone: string, from: number, to: number): string[] {
  const days: string[] = [];
  for (let s = from + DAY; s < to - DAY; s += HOUR) {
    const d = wallClock(s, timeZone).date;
    if (days.at(-1) !== d) days.push(d);
  }
  return days;
}

function checkOnePerDay(timeZone: string, from: number, to: number, times = TIMES) {
  const days = fullLocalDays(timeZone, from, to);
  for (const t of times) {
    const sent = simulate(timeZone, t, from, to);
    const dates = sent.map((x) => x.localDate);
    assertEquals(new Set(dates).size, dates.length, `${timeZone} ${t}: a day got two reminders`);
    for (const d of days) assert(dates.includes(d), `${timeZone} ${t}: no reminder on ${d}`);
    for (const x of sent) {
      const w = wallClock(x.slot, timeZone);
      // It goes out on the day it belongs to (or at most CATCH_UP after the time, which can
      // run past midnight only for a late-evening time) and never before the chosen time.
      const [h, m] = t.split(':').map(Number);
      if (w.date === x.localDate)
        assert(w.minutes >= h! * 60 + m!, `${timeZone} ${t}: sent early at ${w.minutes}`);
    }
  }
}

// ---------------------------------------------------------------------------------------

Deno.test('slotOf rounds to the nearest quarter hour', () => {
  const q = utc('2026-10-13T22:00:00Z');
  assertEquals(slotOf(q), q);
  assertEquals(slotOf(q + 7 * MIN), q); // pg_cron started late
  assertEquals(slotOf(q - 7 * MIN), q); // this machine's clock is a little behind
  assertEquals(slotOf(q + 8 * MIN), q + SLOT_MS);
});

Deno.test('an ordinary day: due exactly at the chosen time, in local time', () => {
  // 3:00 PM in Los Angeles on 2026-10-13 (PDT, UTC-7) is 22:00 UTC.
  const at = utc('2026-10-13T22:00:00Z');
  assertEquals(dueReminder(at, 'America/Los_Angeles', '15:00'), { localDate: '2026-10-13' });
  assertEquals(dueReminder(at - SLOT_MS, 'America/Los_Angeles', '15:00'), null);
  assertEquals(simulate('America/Los_Angeles', '15:00', at - DAY / 2, at + DAY / 2), [
    { slot: at, localDate: '2026-10-13' },
  ]);
  // Same instant, other zones: due only where it is 3:00 PM.
  assertEquals(dueReminder(at, 'America/New_York', '15:00'), null);
  assertEquals(dueReminder(at, 'America/New_York', '18:00'), { localDate: '2026-10-13' });
  assertEquals(dueReminder(at, 'Asia/Tokyo', '07:00'), { localDate: '2026-10-14' });
});

Deno.test('Los Angeles, spring forward (2027-03-14): one reminder per day, none skipped', () => {
  const from = utc('2027-03-11T00:00:00Z');
  const to = utc('2027-03-18T00:00:00Z');
  checkOnePerDay('America/Los_Angeles', from, to);
  // 2:30 AM does not exist that night: it goes out at 3:00 AM PDT (10:00 UTC).
  const sent = simulate('America/Los_Angeles', '02:30', from, to);
  const day = sent.find((x) => x.localDate === '2027-03-14');
  assertEquals(day?.slot, utc('2027-03-14T10:00:00Z'));
  // 3:00 AM is a normal time that day.
  const three = simulate('America/Los_Angeles', '03:00', from, to);
  assertEquals(three.find((x) => x.localDate === '2027-03-14')?.slot, utc('2027-03-14T10:00:00Z'));
});

Deno.test('Los Angeles, fall back (2026-11-01): the repeated hour sends once', () => {
  const from = utc('2026-10-29T00:00:00Z');
  const to = utc('2026-11-05T00:00:00Z');
  checkOnePerDay('America/Los_Angeles', from, to);
  // 1:30 AM happens twice; the first one (PDT, 08:30 UTC) counts.
  const sent = simulate('America/Los_Angeles', '01:30', from, to);
  assertEquals(sent.find((x) => x.localDate === '2026-11-01')?.slot, utc('2026-11-01T08:30:00Z'));
  // Even with no log at all, the second 1:30 AM (PST, 09:30 UTC) is not "due".
  assertEquals(dueReminder(utc('2026-11-01T09:30:00Z'), 'America/Los_Angeles', '01:30'), null);
  // After the hour: 3:00 PM PST is 23:00 UTC.
  const pm = simulate('America/Los_Angeles', '15:00', from, to);
  assertEquals(pm.find((x) => x.localDate === '2026-11-01')?.slot, utc('2026-11-01T23:00:00Z'));
});

Deno.test('many zones, around their clock changes: one reminder per local day', () => {
  const cases: [string, string][] = [
    ['America/New_York', '2026-11-01'],
    ['America/Chicago', '2027-03-14'],
    ['America/Denver', '2026-11-01'],
    ['America/Phoenix', '2026-11-01'], // no DST
    ['America/Anchorage', '2027-03-14'],
    ['Pacific/Honolulu', '2027-03-14'], // no DST
    ['America/St_Johns', '2026-11-01'], // UTC-3:30
    ['America/Santiago', '2027-04-04'], // changes at midnight
    ['America/Havana', '2027-03-14'], // changes at midnight
    ['Europe/London', '2026-10-25'],
    ['Europe/Berlin', '2027-03-28'],
    ['Asia/Kolkata', '2026-10-13'], // UTC+5:30
    ['Asia/Kathmandu', '2026-10-13'], // UTC+5:45
    ['Australia/Adelaide', '2026-10-04'], // UTC+9:30/+10:30
    ['Australia/Lord_Howe', '2026-10-04'], // a 30-minute change
    ['Pacific/Chatham', '2027-04-04'], // UTC+12:45/+13:45
    ['Pacific/Kiritimati', '2026-10-13'], // UTC+14
    ['Pacific/Pago_Pago', '2026-10-13'], // UTC-11
    ['UTC', '2026-10-13'],
  ];
  for (const [zone, day] of cases) {
    const mid = utc(`${day}T12:00:00Z`);
    // Every hour of the day, plus the quarter hours around 0:00-3:00 where clocks change.
    const times = TIMES.filter((t) => t.endsWith(':00') || t < '03:00' || t >= '23:00');
    checkOnePerDay(zone, mid - 3 * DAY, mid + 3 * DAY, times);
  }
});

Deno.test('a whole year in Los Angeles at 3:00 PM: exactly one a day, always at 3:00 PM', () => {
  const from = utc('2026-10-01T00:00:00Z');
  const to = utc('2027-10-01T00:00:00Z');
  const sent = simulate('America/Los_Angeles', '15:00', from, to);
  const days = fullLocalDays('America/Los_Angeles', from, to);
  assertEquals(new Set(sent.map((x) => x.localDate)).size, sent.length);
  for (const d of days)
    assert(
      sent.some((x) => x.localDate === d),
      `missing ${d}`,
    );
  for (const x of sent) assertEquals(wallClock(x.slot, 'America/Los_Angeles').minutes, 15 * 60);
});

Deno.test('a failed run is made up by the next run, up to an hour late, still once', () => {
  const at = utc('2026-10-13T22:00:00Z'); // 3:00 PM in Los Angeles
  const one = simulate('America/Los_Angeles', '15:00', at - HOUR, at + DAY / 2, (s) => s === at);
  assertEquals(one, [{ slot: at + SLOT_MS, localDate: '2026-10-13' }]);
  // Runs failing for a whole hour after 3:00 PM: that day's reminder is not sent late.
  const none = simulate(
    'America/Los_Angeles',
    '15:00',
    at - HOUR,
    at + DAY / 2,
    (s) => s >= at && s < at + CATCH_UP_MS,
  );
  assertEquals(none, []);
});

Deno.test('a late-evening time made up after midnight belongs to the day before', () => {
  const at = utc('2026-10-14T06:45:00Z'); // 11:45 PM in Los Angeles on the 13th
  const sent = simulate('America/Los_Angeles', '23:45', at - HOUR, at + HOUR, (s) => s === at);
  assertEquals(sent, [{ slot: at + SLOT_MS, localDate: '2026-10-13' }]);
});

// ---------------------------------------------------------------------------------------
// The run, with a fake database and push service

const ALICE = '00000000-0000-4000-8000-00000000a001';

class FakeStore implements Store {
  reminders = [{ userId: ALICE, reminderTime: '15:00:00', timeZone: 'America/Los_Angeles' }];
  devices: (Device & { disabledAt: string | null; lastSuccessAt: string | null })[] = [];
  log = new Set<string>();
  enabledReminders = () => Promise.resolve(this.reminders.map((r) => ({ ...r })));
  activeDevices = (userId: string) =>
    Promise.resolve(
      this.devices
        .filter((d) => d.disabledAt === null && userId === ALICE)
        .map(({ id, endpoint, p256dh, auth, failureCount }) => ({
          id,
          endpoint,
          p256dh,
          auth,
          failureCount,
        })),
    );
  claimDay(userId: string, localDate: string) {
    const key = `${userId} ${localDate}`;
    if (this.log.has(key)) return Promise.resolve(false); // the primary key refuses it
    this.log.add(key);
    return Promise.resolve(true);
  }
  markSent = (id: string, at: string) => this.patch(id, { lastSuccessAt: at, failureCount: 0 });
  markGone = (id: string, at: string) => this.patch(id, { disabledAt: at });
  markFailed = (d: Device, at: string) =>
    this.patch(d.id, {
      failureCount: d.failureCount + 1,
      ...(d.failureCount + 1 >= MAX_FAILURES ? { disabledAt: at } : {}),
    });
  private patch(id: string, p: Partial<FakeStore['devices'][number]>) {
    const d = this.devices.find((x) => x.id === id)!;
    Object.assign(d, p);
    return Promise.resolve();
  }
  add(id: string) {
    this.devices.push({
      id,
      endpoint: `https://web.push.apple.com/${id}`,
      p256dh: 'BPfake-p256dh-key-xxxxxxxx',
      auth: 'fake-auth',
      failureCount: 0,
      disabledAt: null,
      lastSuccessAt: null,
    });
  }
}

const AT = utc('2026-10-13T22:00:30Z'); // 30 s after 3:00 PM in Los Angeles

Deno.test('sends to every active device, records the day, and marks the results', async () => {
  const store = new FakeStore();
  ['ok', 'gone410', 'gone404', 'busy'].forEach((id) => store.add(id));
  store.add('off');
  store.devices.find((d) => d.id === 'off')!.disabledAt = '2026-10-01T00:00:00Z';
  const status: Record<string, number> = { ok: 201, gone410: 410, gone404: 404, busy: 503 };
  const sentTo: string[] = [];
  const sum = await runReminders(
    store,
    (d) => {
      sentTo.push(d.id);
      return Promise.resolve(status[d.id]!);
    },
    AT,
  );
  assertEquals(sentTo, ['ok', 'gone410', 'gone404', 'busy']); // never the disabled one
  assertEquals([...store.log], [`${ALICE} 2026-10-13`]);
  const by = (id: string) => store.devices.find((d) => d.id === id)!;
  assertEquals(by('ok').lastSuccessAt, new Date(AT).toISOString());
  assertEquals(by('gone410').disabledAt, new Date(AT).toISOString());
  assertEquals(by('gone404').disabledAt, new Date(AT).toISOString());
  assertEquals(by('busy').failureCount, 1);
  assertEquals(by('busy').disabledAt, null);
  assertEquals(
    { ...sum, errors: sum.errors.length },
    {
      checked: 1,
      due: 1,
      alreadySent: 0,
      noDevices: 0,
      sent: 1,
      gone: 2,
      failed: 1,
      blocked: 0,
      errors: 1,
    },
  );
  assertEquals(sum.errors, ['web.push.apple.com: push service answered 503']);
});

Deno.test('a second run in the same window (or a repeated call) sends nothing', async () => {
  const store = new FakeStore();
  store.add('ok');
  let sends = 0;
  const send = () => (sends++, Promise.resolve(201));
  await runReminders(store, send, AT);
  const again = await runReminders(store, send, AT + 2 * MIN);
  const next = await runReminders(store, send, AT + SLOT_MS);
  assertEquals(sends, 1);
  assertEquals(again.alreadySent, 1);
  assertEquals(next.alreadySent, 1);
  // Two runs at the same moment: the log's key lets only one through.
  const store2 = new FakeStore();
  store2.add('ok');
  let sends2 = 0;
  const send2 = () => (sends2++, Promise.resolve(201));
  await Promise.all([runReminders(store2, send2, AT), runReminders(store2, send2, AT)]);
  assertEquals(sends2, 1);
});

Deno.test(
  'not due, no devices, a bad row, a network error: nothing is claimed wrongly',
  async () => {
    const store = new FakeStore();
    store.add('ok');
    const notYet = await runReminders(store, () => Promise.resolve(201), AT - SLOT_MS);
    assertEquals([notYet.due, store.log.size], [0, 0]);

    const empty = new FakeStore();
    const sum = await runReminders(empty, () => Promise.resolve(201), AT);
    assertEquals([sum.due, sum.noDevices, empty.log.size], [1, 1, 0]);

    const bad = new FakeStore();
    bad.reminders = [{ userId: ALICE, reminderTime: 'soon', timeZone: 'America/Los_Angeles' }];
    const s2 = await runReminders(bad, () => Promise.resolve(201), AT);
    assertEquals(s2.errors, [`account ${ALICE}: bad reminder time soon`]);

    const flaky = new FakeStore();
    flaky.add('ok');
    const s3 = await runReminders(flaky, () => Promise.reject(new Error('connect timeout')), AT);
    assertEquals([s3.failed, flaky.devices[0]!.failureCount], [1, 1]);
    assertEquals(s3.errors, ['web.push.apple.com: connect timeout']);
  },
);

Deno.test(
  'an address that is not a push service is turned off, never sent to (audit L13)',
  async () => {
    const store = new FakeStore();
    store.add('ok');
    store.add('evil');
    store.devices[1]!.endpoint = 'https://169.254.169.254/latest/meta-data/x';
    const sentTo: string[] = [];
    const sum = await runReminders(store, (d) => (sentTo.push(d.id), Promise.resolve(201)), AT);
    assertEquals(sentTo, ['ok']);
    assertEquals([sum.sent, sum.blocked], [1, 1]);
    assertEquals(store.devices[1]!.disabledAt, new Date(AT).toISOString());
    assertEquals(sum.errors, ['169.254.169.254: not a push service; device turned off']);
    for (const ok of [
      'https://web.push.apple.com/x',
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])
      assert(PUSH_ENDPOINT_RE.test(ok), ok);
    for (const bad of [
      'https://web.push.apple.com.evil.test/x',
      'https://user:pass@web.push.apple.com/x',
      'https://localhost:5432/',
      'http://web.push.apple.com/x',
    ])
      assert(!PUSH_ENDPOINT_RE.test(bad), bad);
  },
);

Deno.test(
  '10 failures in a row turn a device off; a success resets the count (audit L13)',
  async () => {
    const store = new FakeStore();
    store.add('flaky');
    const d = store.devices[0]!;
    d.failureCount = MAX_FAILURES - 2;
    await runReminders(store, () => Promise.resolve(201), AT);
    assertEquals([d.failureCount, d.disabledAt], [0, null]); // a success: back to 0
    d.failureCount = MAX_FAILURES - 1;
    store.log.clear();
    await runReminders(store, () => Promise.resolve(503), AT);
    assertEquals([d.failureCount, d.disabledAt], [MAX_FAILURES, new Date(AT).toISOString()]);
  },
);

Deno.test('a network error never puts the push address in the log (audit I2)', async () => {
  const store = new FakeStore();
  store.add('secret-path');
  const sum = await runReminders(
    store,
    () =>
      Promise.reject(
        new Error(`error sending request for url (${store.devices[0]!.endpoint}): timed out`),
      ),
    AT,
  );
  assertEquals(sum.errors, [
    'web.push.apple.com: error sending request for url (web.push.apple.com): timed out',
  ]);
});

// ---------------------------------------------------------------------------------------
// The HTTP handler

function handlerWith(store: Store, secret: string | null = 'right-secret') {
  return createHandler({
    cronSecret: secret ?? undefined,
    makeStore: () => store,
    makeSender: () => () => Promise.resolve(201),
    now: () => AT,
  });
}
const post = (headers: Record<string, string> = {}, method = 'POST') =>
  new Request('http://localhost/send-reminders', {
    method,
    headers,
    body: method === 'POST' ? '{}' : null,
  });

Deno.test('401 without the cron secret, or with a wrong one; nothing runs', async () => {
  const store = new FakeStore();
  store.add('ok');
  const h = handlerWith(store);
  const tries: Record<string, string>[] = [
    {},
    { 'x-cron-secret': 'wrong' },
    { 'x-cron-secret': '' },
  ];
  for (const headers of tries) {
    const res = await h(post(headers));
    assertEquals(res.status, 401);
    assertEquals(await res.json(), { error: 'unauthorized' });
  }
  // A Supabase JWT is not enough either.
  assertEquals((await h(post({ authorization: 'Bearer eyJfake' }))).status, 401);
  assertEquals(store.log.size, 0);
});

Deno.test('500 when CRON_SECRET is not set (never open to everyone)', async () => {
  const res = await handlerWith(new FakeStore(), null)(post({ 'x-cron-secret': '' }));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: 'CRON_SECRET is not set' });
});

Deno.test(
  'with the secret: 405 for GET, 200 and a summary for POST, 500 on a database error',
  async () => {
    const store = new FakeStore();
    store.add('ok');
    const h = handlerWith(store);
    assertEquals((await h(post({ 'x-cron-secret': 'right-secret' }, 'GET'))).status, 405);
    const res = await h(post({ 'x-cron-secret': 'right-secret' }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals([body.sent, body.checked], [1, 1]);

    const broken = new FakeStore();
    broken.enabledReminders = () => Promise.reject(new Error('reading settings: boom'));
    const res2 = await handlerWith(broken)(post({ 'x-cron-secret': 'right-secret' }));
    assertEquals(res2.status, 500);
    assertEquals(await res2.json(), { error: 'reading settings: boom' });
  },
);

Deno.test('sameSecret compares the whole string', () => {
  assert(sameSecret('abc', 'abc'));
  assert(!sameSecret('abc', 'abd'));
  assert(!sameSecret('abc', 'abcd'));
  assert(!sameSecret('', 'a'));
  assert(sameSecret('', ''));
});

// ---------------------------------------------------------------------------------------
// The database adapter against a fake PostgREST: the exact requests made

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
  auth: string | null;
}
function fakeRest(reply: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: decodeURIComponent(u.search),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const r = reply(call);
    return Promise.resolve(
      new Response(r.json === undefined ? null : JSON.stringify(r.json), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const client = createClient('https://fakeproject.supabase.test', 'service-role-key-fake', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { store: supabaseStore(client), calls };
}

Deno.test('the adapter reads and writes exactly these rows', async () => {
  const { store, calls } = fakeRest((c) => {
    if (c.path.endsWith('/settings'))
      return {
        json: [{ user_id: ALICE, reminder_time: '15:00:00', time_zone: 'America/Los_Angeles' }],
      };
    if (c.path.endsWith('/push_subscriptions') && c.method === 'GET')
      return {
        json: [
          { id: 'd1', endpoint: 'https://p.test/1', p256dh: 'k', auth: 'a', failure_count: 2 },
        ],
      };
    return { status: 201 };
  });
  assertEquals(await store.enabledReminders(), [
    { userId: ALICE, reminderTime: '15:00:00', timeZone: 'America/Los_Angeles' },
  ]);
  const devices = await store.activeDevices(ALICE);
  assertEquals(devices, [
    { id: 'd1', endpoint: 'https://p.test/1', p256dh: 'k', auth: 'a', failureCount: 2 },
  ]);
  assertEquals(await store.claimDay(ALICE, '2026-10-13'), true);
  await store.markSent('d1', '2026-10-13T22:00:00.000Z');
  await store.markGone('d1', '2026-10-13T22:00:00.000Z');
  await store.markFailed(devices[0]!, '2026-10-13T22:00:00.000Z');
  await store.markFailed({ ...devices[0]!, failureCount: 9 }, '2026-10-13T22:00:00.000Z');

  const shape = calls.map((c) => [c.method, c.path.replace('/rest/v1/', ''), c.query, c.body]);
  assertEquals(shape, [
    ['GET', 'settings', '?select=user_id,reminder_time,time_zone&reminder_enabled=eq.true', null],
    [
      'GET',
      'push_subscriptions',
      `?select=id,endpoint,p256dh,auth,failure_count&user_id=eq.${ALICE}&disabled_at=is.null`,
      null,
    ],
    ['POST', 'reminder_log', '', { user_id: ALICE, local_date: '2026-10-13' }],
    [
      'PATCH',
      'push_subscriptions',
      '?id=eq.d1',
      { last_success_at: '2026-10-13T22:00:00.000Z', failure_count: 0 },
    ],
    ['PATCH', 'push_subscriptions', '?id=eq.d1', { disabled_at: '2026-10-13T22:00:00.000Z' }],
    ['PATCH', 'push_subscriptions', '?id=eq.d1', { failure_count: 3 }],
    [
      'PATCH',
      'push_subscriptions',
      '?id=eq.d1',
      { failure_count: 10, disabled_at: '2026-10-13T22:00:00.000Z' },
    ],
  ]);
  // Every request carries the service-role key (server-side only).
  for (const c of calls) assertEquals(c.auth, 'Bearer service-role-key-fake');
});

Deno.test(
  'the adapter: an existing reminder_log row means "already sent"; errors are readable',
  async () => {
    const { store } = fakeRest(() => ({
      status: 409,
      json: { code: '23505', message: 'duplicate key value violates unique constraint' },
    }));
    assertEquals(await store.claimDay(ALICE, '2026-10-13'), false);

    const { store: broken } = fakeRest(() => ({
      status: 500,
      json: { code: 'XX000', message: 'boom' },
    }));
    for (const call of [
      () => broken.enabledReminders(),
      () => broken.activeDevices(ALICE),
      () => broken.claimDay(ALICE, '2026-10-13'),
      () => broken.markSent('d1', 'x'),
      () => broken.markGone('d1', 'x'),
      () =>
        broken.markFailed({ id: 'd1', endpoint: '', p256dh: '', auth: '', failureCount: 0 }, 'x'),
    ]) {
      let message = '';
      try {
        await call();
      } catch (e) {
        message = (e as Error).message;
      }
      assertMatch(message, /: boom$/);
    }
  },
);

// ---------------------------------------------------------------------------------------
// Real Web Push (npm:web-push under Deno) to a local HTTPS push service

/** A throwaway certificate authority and a localhost certificate it signed (openssl). */
async function localTls() {
  const dir = await Deno.makeTempDir();
  const run = async (args: string[]) => {
    const out = await new Deno.Command('openssl', { args, cwd: dir, stderr: 'piped' }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  await run([
    'req',
    '-x509',
    ...ec,
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=test-ca',
  ]);
  await run(['req', ...ec, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
  await Deno.writeTextFile(`${dir}/ext`, 'subjectAltName=DNS:localhost,IP:127.0.0.1');
  await run([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '1',
    '-extfile',
    'ext',
  ]);
  const read = (f: string) => Deno.readTextFile(`${dir}/${f}`);
  const tls = {
    ca: await read('ca.pem'),
    cert: await read('leaf.pem'),
    key: await read('leaf.key'),
  };
  await Deno.remove(dir, { recursive: true });
  return tls;
}

/** A browser's side of a push subscription: its key pair and auth secret. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16) };
}

const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, len);
};

/** RFC 8291 decryption, written independently of web-push, as a browser would do it. */
function decrypt(body: Uint8Array, b: ReturnType<typeof browserKeys>): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20]!;
  const serverKey = buf.subarray(21, 21 + idlen);
  const cipher = buf.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverKey]);
  const ikm = hkdf(b.auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assertEquals(plain[plain.length - 1], 2, 'last-record padding delimiter');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

/** Checks the VAPID header's ES256 signature with WebCrypto and returns its claims. */
async function vapidClaims(header: string, publicKey: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert(m, `Authorization header: ${header}`);
  assertEquals(m[2], publicKey);
  const [h, p, s] = m[1]!.split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(publicKey, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(s!, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert(ok, 'the VAPID signature verifies with the public key');
  return JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
}

Deno.test({
  name: 'web-push under Deno: a real encrypted, VAPID-signed push; 201 / 404 / 410 / 500 read correctly',
  sanitizeResources: false, // node:https keeps its socket pool open between requests
  sanitizeOps: false,
  async fn() {
    const tls = await localTls();
    // Trust the throwaway CA for this test's requests only.
    (https.globalAgent as unknown as { options: { ca?: string } }).options.ca = tls.ca;
    const vapidKeys = webpush.generateVAPIDKeys();
    const vapid = { subject: 'mailto:owner@example.com', ...vapidKeys };
    const seen: { path: string; headers: Headers; body: Uint8Array }[] = [];
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, cert: tls.cert, key: tls.key, onListen() {} },
      async (req) => {
        const path = new URL(req.url).pathname;
        seen.push({ path, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
        const status = { '/ok': 201, '/gone': 410, '/missing': 404, '/broken': 500 }[path] ?? 400;
        return new Response(null, { status });
      },
    );
    try {
      const b = browserKeys();
      const device = (path: string): Device => ({
        id: path,
        endpoint: `https://localhost:${server.addr.port}${path}`,
        p256dh: b.p256dh,
        auth: b.auth.toString('base64url'),
        failureCount: 0,
      });
      const send = webPushSender(vapid);
      assertEquals(await send(device('/ok')), 201);
      assertEquals(await send(device('/gone')), 410);
      assertEquals(await send(device('/missing')), 404);
      assertEquals(await send(device('/broken')), 500);

      const first = seen[0]!;
      assertEquals(first.headers.get('content-encoding'), 'aes128gcm');
      assertEquals(first.headers.get('ttl'), String(TTL_SECONDS));
      assertEquals(first.headers.get('urgency'), 'normal');
      assertEquals(first.headers.get('topic'), 'daily-reminder');
      assertEquals(decrypt(first.body, b), PAYLOAD);
      const claims = await vapidClaims(first.headers.get('authorization')!, vapid.publicKey);
      assertEquals(claims.aud, `https://localhost:${server.addr.port}`);
      assertEquals(claims.sub, vapid.subject);
      const now = Date.now() / 1000;
      assert(claims.exp > now && claims.exp <= now + 24 * 3600, 'expires within 24 hours');

      // And the whole run, end to end, through the real sender.
      const store = new FakeStore();
      store.devices = [
        { ...device('/ok'), disabledAt: null, lastSuccessAt: null },
        { ...device('/gone'), disabledAt: null, lastSuccessAt: null },
      ];
      // (A local push server is not a real push service: this test alone allows it.)
      const sum = await runReminders(store, send, AT, () => true);
      assertEquals([sum.sent, sum.gone], [1, 1]);
      assertEquals(store.devices[1]!.disabledAt, new Date(AT).toISOString());
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test('a network error reaching the push service is an error, not a status', async () => {
  const send = webPushSender({
    subject: 'mailto:owner@example.com',
    ...webpush.generateVAPIDKeys(),
  });
  const b = browserKeys();
  let failed = false;
  try {
    // Port 9 on localhost: nothing listens there.
    await send({
      id: 'x',
      endpoint: 'https://127.0.0.1:9/nothing',
      p256dh: b.p256dh,
      auth: b.auth.toString('base64url'),
      failureCount: 0,
    });
  } catch {
    failed = true;
  }
  assert(failed);
});
