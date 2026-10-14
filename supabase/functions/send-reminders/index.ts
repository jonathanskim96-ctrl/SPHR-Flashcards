// SPHR Flashcards: the daily reminder sender (Supabase Edge Function `send-reminders`).
//
// pg_cron calls this every 15 minutes (docs/SETUP.md B9). For each account with the reminder
// on, it works out the local time in the account's time zone and, when the reminder is due,
// first records the day in `reminder_log` (its primary key allows one row per local day, so
// a repeated run can never send twice) and then sends a Web Push to each active device.
// A device the push service says is gone (404/410) is marked disabled, never deleted.
//
// Deployed by pasting this one file into the Supabase dashboard (SETUP B8), with
// "Enforce JWT verification" off: the caller must send the `x-cron-secret` header instead.
// Secrets (Edge Function secrets, never in GitHub): CRON_SECRET, VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided
// by Supabase and used here, server-side only.
// Tests: index.test.ts next to this file (`npm run test:functions`).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';

// ---------------------------------------------------------------------------------------
// When is a reminder due? (pure; no I/O)

export const SLOT_MS = 15 * 60_000;
/** A run may send a reminder up to this long after the reminder time first occurred. */
export const CATCH_UP_MS = 60 * 60_000;

/**
 * The 15-minute slot a run belongs to: `now` rounded to the nearest quarter hour. pg_cron
 * starts runs on the quarter hour; rounding absorbs start-up delay and small clock drift.
 */
export function slotOf(nowMs: number): number {
  return Math.round(nowMs / SLOT_MS) * SLOT_MS;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at instant `ms`: local date and minutes since midnight. */
export function wallClock(ms: number, timeZone: string): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** `15:00` → 900. */
export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) throw new Error(`bad reminder time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Is `slot` the first slot of its local day whose wall-clock time is at or past `target`? */
function isFirstSlotAtOrPast(slot: number, timeZone: string, target: number): boolean {
  const here = wallClock(slot, timeZone);
  if (here.minutes < target) return false;
  // Walk back through the same local day: an earlier slot already at or past the target
  // means the time came earlier (the repeated hour when clocks go back).
  for (let s = slot - SLOT_MS; ; s -= SLOT_MS) {
    const w = wallClock(s, timeZone);
    if (w.date !== here.date) return true;
    if (w.minutes >= target) return false;
  }
}

/**
 * Whether a reminder is due in the run for `slot` (see `slotOf`), and for which local date.
 *
 * The reminder time "happens" at the first quarter-hour slot of the local day whose wall
 * clock is at or past it. So when clocks go forward over the chosen time (2:30 AM on the
 * spring-forward night) it happens at 3:00 AM, and when the hour repeats (fall back) only
 * the first pass counts. A run sends it at that slot, or up to CATCH_UP_MS later if the run
 * at that slot failed; `reminder_log` keeps it to one per local date.
 */
export function dueReminder(
  slot: number,
  timeZone: string,
  reminderTime: string,
): { localDate: string } | null {
  const target = minutesOf(reminderTime);
  for (let s = slot - CATCH_UP_MS + SLOT_MS; s <= slot; s += SLOT_MS) {
    if (isFirstSlotAtOrPast(s, timeZone, target)) return { localDate: wallClock(s, timeZone).date };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// The run (database and push service passed in, so tests can replace them)

export interface ReminderRow {
  userId: string;
  reminderTime: string;
  timeZone: string;
}

export interface Device {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
}

export interface Store {
  /** Every account with the reminder switched on. */
  enabledReminders(): Promise<ReminderRow[]>;
  /** The account's devices that are not disabled. */
  activeDevices(userId: string): Promise<Device[]>;
  /** Records that today's reminder is being sent; false if a row for that day exists. */
  claimDay(userId: string, localDate: string): Promise<boolean>;
  markSent(deviceId: string, at: string): Promise<void>;
  markGone(deviceId: string, at: string): Promise<void>;
  /** Counts a failure; at MAX_FAILURES in a row the device is turned off (`at`). */
  markFailed(device: Device, at: string): Promise<void>;
}

/**
 * Only real push services (audit L13), the same list as the app (src/domain/validate.ts) and
 * the database (migration 0004). A device with any other address is turned off, never sent to.
 */
export const PUSH_ENDPOINT_RE =
  /^https:\/\/(([a-z0-9-]+\.)*(push\.apple\.com|notify\.windows\.com)|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)\//;
/** Failures in a row (one a day) after which a device is turned off (audit L13). */
export const MAX_FAILURES = 10;

/** Sends one push; returns the push service's HTTP status (an error status does not throw). */
export type Sender = (device: Device) => Promise<number>;

export interface Summary {
  checked: number;
  due: number;
  alreadySent: number;
  noDevices: number;
  sent: number;
  gone: number;
  failed: number;
  /** Devices turned off because their address is not a push service's (audit L13). */
  blocked: number;
  errors: string[];
}

/** Never log the endpoint itself: it is a capability URL. Only the push service's host. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown host';
  }
}

export async function runReminders(
  store: Store,
  send: Sender,
  nowMs: number,
  /** Tests that send to a local push server widen this; production uses the real list. */
  isPushEndpoint: (endpoint: string) => boolean = (e) => PUSH_ENDPOINT_RE.test(e),
): Promise<Summary> {
  const slot = slotOf(nowMs);
  const at = new Date(nowMs).toISOString();
  const sum: Summary = {
    checked: 0,
    due: 0,
    alreadySent: 0,
    noDevices: 0,
    sent: 0,
    gone: 0,
    failed: 0,
    blocked: 0,
    errors: [],
  };
  for (const row of await store.enabledReminders()) {
    sum.checked++;
    let due: { localDate: string } | null;
    try {
      due = dueReminder(slot, row.timeZone, row.reminderTime);
    } catch (e) {
      sum.errors.push(`account ${row.userId}: ${errorText(e)}`);
      continue;
    }
    if (!due) continue;
    sum.due++;
    const devices = await store.activeDevices(row.userId);
    if (devices.length === 0) {
      sum.noDevices++; // nothing claimed: a device added later in the window still gets it
      continue;
    }
    if (!(await store.claimDay(row.userId, due.localDate))) {
      sum.alreadySent++;
      continue;
    }
    for (const device of devices) {
      if (!isPushEndpoint(device.endpoint)) {
        sum.blocked++;
        sum.errors.push(`${hostOf(device.endpoint)}: not a push service; device turned off`);
        await store.markGone(device.id, at);
        continue;
      }
      let status: number;
      try {
        status = await send(device);
      } catch (e) {
        status = 0;
        sum.errors.push(`${hostOf(device.endpoint)}: ${withoutAddresses(errorText(e))}`);
      }
      if (status >= 200 && status < 300) {
        sum.sent++;
        await store.markSent(device.id, at);
      } else if (status === 404 || status === 410) {
        sum.gone++;
        await store.markGone(device.id, at);
      } else {
        sum.failed++;
        if (status) sum.errors.push(`${hostOf(device.endpoint)}: push service answered ${status}`);
        await store.markFailed(device, at);
      }
    }
  }
  return sum;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A network error's text may quote the push address; keep only its host (audit I2). */
function withoutAddresses(text: string): string {
  return text.replace(/https?:\/\/[^\s'"()<>]+/g, (u) => hostOf(u));
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface HandlerDeps {
  cronSecret: string | undefined;
  makeStore(): Store;
  makeSender(): Sender;
  now(): number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!deps.cronSecret) return json(500, { error: 'CRON_SECRET is not set' });
    const given = req.headers.get('x-cron-secret');
    if (given === null || !sameSecret(given, deps.cronSecret))
      return json(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return json(405, { error: 'use POST' });
    try {
      const summary = await runReminders(deps.makeStore(), deps.makeSender(), deps.now());
      console.log('send-reminders', JSON.stringify(summary));
      return json(200, summary);
    } catch (e) {
      console.error('send-reminders failed:', errorText(e));
      return json(500, { error: errorText(e) });
    }
  };
}

// ---------------------------------------------------------------------------------------
// The real database (PostgREST through supabase-js, as the service role) and push service

export function supabaseStore(client: SupabaseClient): Store {
  const check = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async enabledReminders() {
      const { data, error } = await client
        .from('settings')
        .select('user_id,reminder_time,time_zone')
        .eq('reminder_enabled', true);
      check('reading settings', error);
      return (data ?? []).map((r) => ({
        userId: r.user_id as string,
        reminderTime: r.reminder_time as string,
        timeZone: r.time_zone as string,
      }));
    },
    async activeDevices(userId) {
      const { data, error } = await client
        .from('push_subscriptions')
        .select('id,endpoint,p256dh,auth,failure_count')
        .eq('user_id', userId)
        .is('disabled_at', null);
      check('reading devices', error);
      return (data ?? []).map((r) => ({
        id: r.id as string,
        endpoint: r.endpoint as string,
        p256dh: r.p256dh as string,
        auth: r.auth as string,
        failureCount: r.failure_count as number,
      }));
    },
    async claimDay(userId, localDate) {
      const { error } = await client
        .from('reminder_log')
        .insert({ user_id: userId, local_date: localDate });
      if (error?.code === '23505') return false; // the day's row exists: already sent
      check('recording the reminder', error);
      return true;
    },
    async markSent(deviceId, at) {
      const { error } = await client
        .from('push_subscriptions')
        // A success ends a run of failures.
        .update({ last_success_at: at, failure_count: 0 })
        .eq('id', deviceId);
      check('recording a sent reminder', error);
    },
    async markGone(deviceId, at) {
      const { error } = await client
        .from('push_subscriptions')
        .update({ disabled_at: at })
        .eq('id', deviceId);
      check('disabling a device', error);
    },
    async markFailed(device, at) {
      const failures = device.failureCount + 1;
      const { error } = await client
        .from('push_subscriptions')
        .update(
          failures >= MAX_FAILURES
            ? { failure_count: failures, disabled_at: at }
            : { failure_count: failures },
        )
        .eq('id', device.id);
      check('recording a failed reminder', error);
    },
  };
}

/** What every reminder says. The app's service worker shows its own fixed text. */
export const PAYLOAD = JSON.stringify({ kind: 'daily-reminder' });
/** A reminder not delivered within 6 hours (phone off) is dropped by the push service. */
export const TTL_SECONDS = 6 * 60 * 60;

export interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export function webPushSender(vapid: Vapid): Sender {
  return async (device) => {
    try {
      const res = await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        PAYLOAD,
        { vapidDetails: vapid, TTL: TTL_SECONDS, urgency: 'normal', topic: 'daily-reminder' },
      );
      return res.statusCode;
    } catch (e) {
      // web-push throws a WebPushError for any non-2xx answer; its status is what counts.
      const status = (e as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number') return status;
      throw e;
    }
  };
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function productionDeps(): HandlerDeps {
  return {
    cronSecret: Deno.env.get('CRON_SECRET'),
    makeStore: () =>
      supabaseStore(
        createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
      ),
    makeSender: () =>
      webPushSender({
        subject: requireEnv('VAPID_SUBJECT'),
        publicKey: requireEnv('VAPID_PUBLIC_KEY'),
        privateKey: requireEnv('VAPID_PRIVATE_KEY'),
      }),
    now: Date.now,
  };
}

// The tests import this file without starting a server.
if (Deno.env.get('SEND_REMINDERS_TEST') !== '1') Deno.serve(createHandler(productionDeps()));
