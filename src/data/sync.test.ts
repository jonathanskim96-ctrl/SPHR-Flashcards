import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock, device, FakeServer, RIGHT, settings0, WRONG } from '../../tests/dataHelpers';
import { fakeBank, TZ } from '../../tests/helpers';
import { replay } from '../domain/replay';
import { totalXp } from '../domain/xp';
import type { Response } from '../domain/types';
import {
  ANSWER_DEBOUNCE_MS,
  PERIODIC_MS,
  rejectionNotices,
  SETTLE_MS,
  SETTINGS_CONFLICT_NOTICE,
  browserEnv,
  SyncEngine,
  syncStatusText,
  type SyncStatus,
} from './sync';

const bank = fakeBank();
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

afterEach(() => {
  vi.useRealTimers();
});

describe('flushing the outbox', () => {
  it('queues answers while offline and sends them in order once online', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    d.net.setOnline(false);
    const made = [
      await d.answer('fake1-q01', RIGHT),
      await d.answer('fake1-q02', { type: 'mc', choice: 'C' }),
      await d.answer('fake1-q03', WRONG),
    ];
    await d.engine.sync();
    let status = await d.engine.status();
    expect(status).toMatchObject({ offline: true, pendingAnswers: 3, lastError: null });
    expect(syncStatusText(status)).toEqual(['3 answers waiting to back up (offline)']);
    expect(server.calls).toBe(0);

    d.net.setOnline(true);
    await d.engine.sync();
    status = await d.engine.status();
    expect(status).toMatchObject({
      offline: false,
      pendingAnswers: 0,
      lastError: null,
      running: false,
    });
    expect(status.lastSyncAt).toBe(clock.date().toISOString());
    expect(syncStatusText(status)).toEqual(['All answers backed up']);
    expect(server.rows.map((r) => r.attempt.id)).toEqual(made.map((a) => a.id));
    // The server's copies are identical to the phone's.
    expect(server.rows.map((r) => r.attempt)).toEqual(await d.store.attempts());
  });

  it('sends at most 200 answers per call, oldest first', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    const made = [];
    for (let i = 0; i < 450; i++) made.push(await d.answer('fake1-q01', i % 2 ? RIGHT : WRONG));
    const sizes: number[] = [];
    const backend = server.backend();
    const spy = new SyncEngine(
      d.store,
      {
        ...backend,
        applyChanges: (a, s, v) => {
          sizes.push(a.length);
          return backend.applyChanges(a, s, v);
        },
      },
      d.net.env,
    );
    await spy.sync();
    expect(sizes).toEqual([200, 200, 50]);
    expect(server.rows.map((r) => r.attempt.id)).toEqual(made.map((a) => a.id));
    expect(await d.store.outbox()).toEqual([]);
  });

  it('a reply lost mid-flush is harmless: the retry counts duplicates and loses nothing', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    for (let i = 0; i < 5; i++) await d.answer('fake1-q01', RIGHT);
    server.loseReplies = 1;
    await d.engine.sync();
    let status = await d.engine.status();
    expect(status.lastError).toMatch(/Load failed/);
    expect(status.pendingAnswers).toBe(5); // not confirmed, so still queued
    expect(syncStatusText(status)).toEqual([
      '5 answers waiting to back up',
      'Last sync failed: Saving to the server failed: TypeError: Load failed',
    ]);
    expect(server.rows).toHaveLength(5); // but the server did save them

    await d.engine.sync();
    status = await d.engine.status();
    expect(status).toMatchObject({ pendingAnswers: 0, lastError: null });
    expect(server.rows).toHaveLength(5);
    expect(ids(server.rows.map((r) => r.attempt))).toEqual(ids(await d.store.attempts()));
  });

  it('an answer made during a flush is kept and sent', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.answer('fake1-q01', RIGHT);
    let during: { id: string } | null = null;
    server.onApply = async () => {
      server.onApply = null;
      during = await d.answer('fake1-q02', WRONG);
    };
    await d.engine.sync();
    expect(during).not.toBeNull();
    expect(server.rows.map((r) => r.attempt.id)).toContain(during!.id);
    expect(await d.store.outbox()).toEqual([]);
    expect(await d.store.attempts()).toHaveLength(2);
  });

  it('an answer made while the reply is lost survives the retry', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.answer('fake1-q01', RIGHT);
    server.loseReplies = 1;
    server.onApply = async () => {
      server.onApply = null;
      await d.answer('fake1-q02', WRONG);
    };
    await d.engine.sync();
    expect((await d.engine.status()).pendingAnswers).toBe(2);
    await d.engine.sync();
    expect(server.rows).toHaveLength(2);
    expect(await d.store.outbox()).toEqual([]);
  });

  it('a refused answer is reported once, stays queued and on the phone, and is offered again (audit L3)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    const a = await d.answer('fake1-q01', RIGHT);
    const b = await d.answer('fake1-q02', WRONG);
    server.refuse.set(a.id, 'question no longer accepted');
    await d.engine.sync();
    let status = await d.engine.status();
    // Still waiting: sign-out is refused while it waits, so it can't be wiped from the phone.
    expect(status.pendingAnswers).toBe(1);
    expect(status.notices).toEqual(['1 answer could not be saved: question no longer accepted']);
    expect(server.rows.map((r) => r.attempt.id)).toEqual([b.id]);
    expect(ids(await d.store.attempts())).toEqual(ids([a, b]));
    expect(await d.store.outbox()).toMatchObject([{ kind: 'attempt', refused: true }]);
    await d.store.dismissNotices();

    // Offered again once per sync, without a new notice; a new answer is sent first.
    const calls = server.calls;
    const c = await d.answer('fake1-q03', RIGHT);
    await d.engine.sync();
    expect(server.calls).toBe(calls + 1);
    expect(server.rows.map((r) => r.attempt.id)).toEqual([b.id, c.id]);
    status = await d.engine.status();
    expect(status).toMatchObject({ pendingAnswers: 1, notices: [] });

    // Once the server accepts it (e.g. the phone's clock was ahead), it is backed up.
    server.refuse.clear();
    await d.engine.sync();
    expect((await d.engine.status()).pendingAnswers).toBe(0);
    expect(server.rows.map((r) => r.attempt.id)).toEqual([b.id, c.id, a.id]);
  });

  it('refused answers never hold up new ones (they go last in the 200)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    const old = await d.answer('fake1-q01', RIGHT);
    server.refuse.set(old.id, 'no');
    await d.engine.sync();
    for (let i = 0; i < 200; i++) await d.answer('fake1-q02', RIGHT);
    const sent: string[][] = [];
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        applyChanges: (xs, s, v) => {
          sent.push(xs.map((x) => x.id));
          return backend.applyChanges(xs, s, v);
        },
      },
      d.net.env,
    );
    await engine.sync();
    expect(sent[0]).toHaveLength(200);
    expect(sent[0]).not.toContain(old.id);
    expect(sent[1]).toEqual([old.id]);
    expect(await d.store.outbox()).toMatchObject([{ attempt: { id: old.id }, refused: true }]);
  });

  it('groups rejection messages by reason', () => {
    expect(rejectionNotices(['x', 'y', 'x'])).toEqual([
      '2 answers could not be saved: x',
      '1 answer could not be saved: y',
    ]);
  });
});

describe('pulling', () => {
  it('pulls everything in pages of 500 and moves the cursor', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const other = await device(server, clock);
    for (let i = 0; i < 1234; i++) await other.answer('fake1-q01', i % 3 ? RIGHT : WRONG);
    await other.engine.sync();
    expect(server.rows).toHaveLength(1234);

    const d = await device(server, clock);
    const cursors: number[] = [];
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        pullAttempts: (after, limit) => {
          cursors.push(after);
          return backend.pullAttempts(after, limit);
        },
      },
      d.net.env,
    );
    await engine.sync();
    expect(cursors).toEqual([0, 500, 1000]);
    expect((await d.store.meta()).cursor).toBe(1234);
    expect(ids(await d.store.attempts())).toEqual(ids(await other.store.attempts()));
    // Right away, the last 1,000 numbers are read again (audit M1: a save from another phone
    // may still appear below the cursor); answers already on the phone are skipped.
    await engine.sync();
    expect(cursors.slice(3)).toEqual([234, 734, 1234]);
    expect(await d.store.attempts()).toHaveLength(1234);
    // A minute later nothing can still appear below 1234: only newer answers are asked for.
    clock.tick(SETTLE_MS);
    await engine.sync();
    expect(cursors.slice(6)).toEqual([1234]);
    clock.tick(SETTLE_MS);
    await engine.sync();
    expect(cursors.slice(7)).toEqual([1234]);
  });

  it('an answer saved on another phone that appears late, below the cursor, is still pulled (audit M1)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const a = await device(server, clock);
    const b = await device(server, clock);
    await a.answer('fake1-q01', RIGHT);
    await a.engine.sync(); // seq 1
    // Phone A's next save has taken seq 2 but not finished; phone B saves seq 3 and pulls.
    const late = await a.answer('fake1-q02', WRONG);
    const reserved = server.nextSeq++;
    await b.answer('fake1-q03', RIGHT);
    await b.engine.sync();
    expect((await b.store.meta()).cursor).toBe(3);
    // Phone A's save now finishes, with the lower number.
    server.rows.push({ seq: reserved, attempt: late });
    server.rows.sort((x, y) => x.seq - y.seq);
    clock.tick(1000);
    await b.engine.sync();
    expect(ids(await b.store.attempts())).toContain(late.id);
  });

  it('pulls start where nothing more can appear, never more than 1,000 back (audit M1)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.store.setMeta({ cursor: 5000, settled: 0, recent: null });
    const asked: number[] = [];
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        pullAttempts: (after, n) => (asked.push(after), backend.pullAttempts(after, n)),
      },
      d.net.env,
    );
    await engine.sync();
    expect(asked).toEqual([4000]);
    expect((await d.store.meta()).recent).toEqual({ seq: 5000, at: clock.now });
    clock.tick(SETTLE_MS - 1);
    await engine.sync();
    expect(asked.at(-1)).toBe(4000);
    clock.tick(1);
    await engine.sync();
    expect(asked.at(-1)).toBe(5000);
    expect((await d.store.meta()).settled).toBe(5000);
  });

  it('an exactly full last page asks once more and stops on the empty page', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const other = await device(server, clock);
    for (let i = 0; i < 500; i++) await other.answer('fake1-q01', RIGHT);
    await other.engine.sync();
    const d = await device(server, clock);
    await d.engine.sync();
    expect((await d.store.attempts()).length).toBe(500);
    expect((await d.store.meta()).cursor).toBe(500);
  });

  it('discards a pull that raced a local write, then pulls again', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const other = await device(server, clock);
    await other.answer('fake1-q01', RIGHT);
    await other.engine.sync();

    const d = await device(server, clock);
    const merges: boolean[] = [];
    const original = d.store.mergePulled.bind(d.store);
    d.store.mergePulled = async (...args) => {
      const r = await original(...args);
      merges.push(r);
      return r;
    };
    server.onPull = async () => {
      server.onPull = null;
      await d.answer('fake1-q02', WRONG); // she answers while the pull is in flight
    };
    await d.engine.sync();
    expect(merges).toEqual([false, true]);
    expect(await d.store.attempts()).toHaveLength(2);
    expect(server.rows).toHaveLength(2);
    expect(await d.store.outbox()).toEqual([]);
  });

  it('reports a server row it cannot read and still moves past it', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const other = await device(server, clock);
    await other.answer('fake1-q01', RIGHT);
    await other.answer('fake1-q02', WRONG);
    await other.engine.sync();
    server.rows[0]!.attempt.answerFp = 'NOT-HEX';
    const d = await device(server, clock);
    await d.engine.sync();
    const status = await d.engine.status();
    expect(status.notices).toHaveLength(1);
    expect(status.notices[0]).toMatch(
      /^An answer from the server could not be read \(answer .*answerFp/,
    );
    expect(await d.store.attempts()).toHaveLength(1);
    expect((await d.store.meta()).cursor).toBe(2);
  });
});

describe('settings', () => {
  it('first save creates version 1; later saves build on it', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.store.saveDefaultSettings(settings0());
    await d.engine.sync();
    expect(server.settings?.version).toBe(1);
    expect(await d.store.settingsRecord()).toMatchObject({ version: 1 });
    await d.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), dailyXpGoal: 50 } });
    expect(syncStatusText(await d.engine.status())).toEqual([
      'All answers backed up',
      'A settings change is waiting to back up',
    ]);
    await d.engine.sync();
    expect(server.settings).toEqual({ value: { ...settings0(), dailyXpGoal: 50 }, version: 2 });
    expect(await d.store.settingsRecord()).toEqual({
      settings: { ...settings0(), dailyXpGoal: 50 },
      version: 2,
      isDefault: false,
    });
  });

  it('two devices edit from the same version: the second gets the conflict message and the server copy', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0()); // version 1
    const a = await device(server, clock);
    const b = await device(server, clock);
    await a.engine.sync();
    await b.engine.sync();
    expect(await a.store.settingsRecord()).toMatchObject({ version: 1 });
    expect(await b.store.settingsRecord()).toMatchObject({ version: 1 });

    a.net.setOnline(false);
    b.net.setOnline(false);
    await a.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), lessonSize: 20 } });
    await a.answer('fake1-q01', RIGHT);
    await b.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), newPerDay: 5 } });
    const bAnswer = await b.answer('fake1-q02', WRONG);

    a.net.setOnline(true);
    await a.engine.sync();
    b.net.setOnline(true);
    await b.engine.sync();

    expect(server.settings).toEqual({ value: { ...settings0(), lessonSize: 20 }, version: 2 });
    const bStatus = await b.engine.status();
    expect(bStatus.notices).toEqual([SETTINGS_CONFLICT_NOTICE]);
    expect(bStatus.pendingSettings).toBe(false);
    expect(await b.store.settingsRecord()).toEqual({
      settings: { ...settings0(), lessonSize: 20 },
      version: 2,
      isDefault: false,
    });
    // No answer was lost on either side.
    expect(server.rows.map((r) => r.attempt.id)).toContain(bAnswer.id);
    await a.engine.sync();
    expect(ids(await a.store.attempts())).toEqual(ids(await b.store.attempts()));
    expect(await a.store.attempts()).toHaveLength(2);
  });

  it('a lost reply to a settings save is not mistaken for a conflict; a newer change is kept (audit L2)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0()); // version 1
    const d = await device(server, clock);
    await d.engine.sync();
    await d.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), lessonSize: 20 } });
    server.loseReplies = 1;
    await d.engine.sync(); // saved as version 2, but the phone never heard
    expect(server.settings?.version).toBe(2);
    // She changes something else before the retry.
    const newest = { ...settings0(), lessonSize: 20, dailyXpGoal: 50 };
    await d.store.guardedWrite({ kind: 'settings', settings: newest });
    await d.engine.sync();
    const status = await d.engine.status();
    expect(status.notices).toEqual([]);
    expect(status.pendingSettings).toBe(false);
    expect(server.settings).toEqual({ value: newest, version: 3 });
    expect(await d.store.settingsRecord()).toEqual({
      settings: newest,
      version: 3,
      isDefault: false,
    });
  });

  it('a lost reply with nothing changed since: settled quietly at the server version (audit L2)', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0());
    const d = await device(server, clock);
    await d.engine.sync();
    const mine = { ...settings0(), newPerDay: 7 };
    await d.store.guardedWrite({ kind: 'settings', settings: mine });
    server.loseReplies = 1;
    await d.engine.sync();
    expect((await d.store.settingsRecord())?.sent).toEqual([mine]);
    // The retry is based on version 1; the server is at 2 with exactly these settings.
    await d.engine.sync();
    const status = await d.engine.status();
    expect(status).toMatchObject({ notices: [], pendingSettings: false });
    expect(await d.store.settingsRecord()).toEqual({
      settings: mine,
      version: 2,
      isDefault: false,
    });
    expect(server.settings).toEqual({ value: mine, version: 2 });
  });

  it('a different change on another device is still a conflict, even after a lost reply', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0());
    const d = await device(server, clock);
    await d.engine.sync();
    await d.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), newPerDay: 7 } });
    d.net.setOnline(false);
    await d.engine.sync();
    const other = { ...settings0(), lessonSize: 25 };
    server.setSettings(other); // another phone, version 2
    d.net.setOnline(true);
    await d.engine.sync();
    expect((await d.engine.status()).notices).toEqual([SETTINGS_CONFLICT_NOTICE]);
    expect(await d.store.settingsRecord()).toEqual({
      settings: other,
      version: 2,
      isDefault: false,
    });
  });

  it('untouched defaults made offline give way to the server copy without a message', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings({ ...settings0(), dailyXpGoal: 80 });
    const d = await device(server, clock);
    await d.store.saveDefaultSettings(settings0());
    await d.engine.sync();
    expect((await d.engine.status()).notices).toEqual([]);
    expect(await d.store.settingsRecord()).toEqual({
      settings: { ...settings0(), dailyXpGoal: 80 },
      version: 1,
      isDefault: false,
    });
  });

  it('settings changed elsewhere are picked up when nothing is queued here', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0());
    const d = await device(server, clock);
    await d.engine.sync();
    server.setSettings({ ...settings0(), reminderTime: '09:45' });
    await d.engine.sync();
    expect(await d.store.settingsRecord()).toMatchObject({
      settings: { reminderTime: '09:45' },
      version: 2,
    });
    expect((await d.engine.status()).notices).toEqual([]);
  });

  it('settings the server refuses are reported and not retried forever', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.store.guardedWrite({ kind: 'settings', settings: settings0() });
    // Simulate a server whose zone list lacks this zone.
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        applyChanges: async (a, s, v) => ({
          ...(await backend.applyChanges(a, null, v)),
          settingsError: s ? 'timeZone must be a real IANA time zone' : null,
        }),
      },
      d.net.env,
    );
    await engine.sync();
    const status = await engine.status();
    expect(status.notices).toEqual([
      'Settings could not be saved: timeZone must be a real IANA time zone',
    ]);
    expect(status.pendingSettings).toBe(false);
  });

  it('a reply that confirms no settings version is reported', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.store.guardedWrite({ kind: 'settings', settings: settings0() });
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      { ...backend, applyChanges: (a, _s, v) => backend.applyChanges(a, null, v) },
      d.net.env,
    );
    await engine.sync();
    expect((await engine.status()).notices).toEqual([
      'Settings could not be saved: the server did not confirm them',
    ]);
  });

  it('a conflict reply without a server copy keeps the local settings but drops the change', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.store.guardedWrite({ kind: 'settings', settings: settings0() });
    const backend = server.backend();
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        applyChanges: async (a, _s, v) => ({
          ...(await backend.applyChanges(a, null, v)),
          settingsConflict: true,
          serverSettings: null,
        }),
      },
      d.net.env,
    );
    await engine.sync();
    expect((await engine.status()).pendingSettings).toBe(false);
    expect((await d.store.settingsRecord())?.settings).toEqual(settings0());
  });

  it('a settings pull that raced a local write is discarded', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    server.setSettings(settings0());
    const d = await device(server, clock);
    const backend = server.backend();
    let raced = false;
    const engine = new SyncEngine(
      d.store,
      {
        ...backend,
        getSettings: async () => {
          const s = await backend.getSettings();
          if (!raced) {
            raced = true;
            await d.answer('fake1-q01', RIGHT);
          }
          return s;
        },
      },
      d.net.env,
    );
    await engine.sync();
    expect(await d.store.settingsRecord()).toMatchObject({ version: 1 });
    expect(server.rows).toHaveLength(1);
  });
});

describe('two devices', () => {
  it('answering offline on both (same card, same day, different results) ends identical everywhere', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const a = await device(server, clock);
    const b = await device(server, clock);
    a.net.setOnline(false);
    b.net.setOnline(false);
    const answers: [string, Response][] = [
      ['fake1-q01', RIGHT],
      ['fake1-q02', { type: 'mc', choice: 'C' }],
      ['fake2-q08', { type: 'text', input: 'WW' }],
      ['fake2-q02', { type: 'numeric', input: '$504,000' }],
    ];
    for (const [id, r] of answers) await a.answer(id, r);
    await b.answer('fake1-q01', WRONG); // same card, same day, different result
    await b.answer('fake2-q10', { type: 'ordering', order: ['C', 'A', 'E', 'B', 'D'] });
    await b.answer('fake2-q11', {
      type: 'matching',
      pairs: { '1': 'B', '2': 'D', '3': 'A', '4': 'E' },
    });
    await b.answer('fake2-q01', { type: 'multi', choices: ['D', 'A'] });

    a.net.setOnline(true);
    b.net.setOnline(true);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    const aAtt = await a.store.attempts();
    const bAtt = await b.store.attempts();
    expect(aAtt).toHaveLength(8);
    expect(ids(aAtt)).toEqual(ids(bAtt));
    expect(server.rows).toHaveLength(8);
    const s = { examDate: '2026-12-15', timeZone: TZ };
    expect(replay(aAtt, bank, s)).toEqual(replay(bAtt, bank, s));
    expect(totalXp(aAtt)).toBe(totalXp(bAtt));
    expect(totalXp(aAtt)).toBe(1 + 2 + 1 + 2 + 3 + 3 + 2);
    // The copies are byte-identical, so exports from either device match.
    const byId = (xs: typeof aAtt) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(byId(aAtt)).toEqual(byId(bAtt));
  });
});

describe('when sync runs', () => {
  it('runs on start, on wake (online / foreground), 2 s after answers, and every 5 minutes', async () => {
    const clock = new Clock();
    const d = await device(new FakeServer(() => clock.now), clock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const runs = vi.spyOn(d.engine, 'sync').mockResolvedValue(undefined);
    d.engine.start();
    d.engine.start(); // a second start is ignored
    expect(runs).toHaveBeenCalledTimes(1);

    d.net.wake();
    expect(runs).toHaveBeenCalledTimes(2);

    d.engine.noteAnswer();
    d.engine.noteAnswer(); // debounced: one run
    vi.advanceTimersByTime(ANSWER_DEBOUNCE_MS - 1);
    expect(runs).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(PERIODIC_MS);
    expect(runs).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(PERIODIC_MS);
    expect(runs).toHaveBeenCalledTimes(5);

    d.engine.noteAnswer();
    d.engine.stop();
    vi.advanceTimersByTime(PERIODIC_MS * 2);
    d.net.wake();
    expect(runs).toHaveBeenCalledTimes(5);
    expect(d.net.wakers.size).toBe(0);
    d.engine.stop(); // stopping twice is fine
  });

  it('tells listeners when a run starts and ends', async () => {
    const clock = new Clock();
    const d = await device(new FakeServer(() => clock.now), clock);
    let notified = 0;
    const off = d.engine.subscribe(() => notified++);
    await d.engine.sync();
    expect(notified).toBeGreaterThanOrEqual(2);
    off();
    const before = notified;
    await d.engine.sync();
    expect(notified).toBe(before);
  });

  it('a request during a run joins it and causes exactly one more pass', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.answer('fake1-q01', RIGHT);
    const first = d.engine.sync();
    const second = d.engine.sync();
    expect((await d.engine.status()).running).toBe(true);
    await Promise.all([first, second]);
    expect(server.calls).toBe(1); // the second pass had nothing to send
    expect((await d.engine.status()).running).toBe(false);
  });

  it('shows the last error and clears it after a good sync', async () => {
    const clock = new Clock();
    const server = new FakeServer(() => clock.now);
    const d = await device(server, clock);
    await d.answer('fake1-q01', RIGHT);
    server.offline = true;
    await d.engine.sync();
    expect((await d.engine.status()).lastError).toMatch(/Failed to fetch/);
    server.offline = false;
    await d.engine.sync();
    expect((await d.engine.status()).lastError).toBeNull();
  });
});

describe('syncStatusText', () => {
  const base: SyncStatus = {
    running: false,
    offline: false,
    pendingAnswers: 0,
    pendingSettings: false,
    lastSyncAt: null,
    lastError: null,
    notices: [],
  };
  it('words the status line', () => {
    expect(syncStatusText(base)).toEqual(['All answers backed up']);
    expect(syncStatusText({ ...base, pendingAnswers: 1 })).toEqual(['1 answer waiting to back up']);
    expect(syncStatusText({ ...base, pendingAnswers: 2, lastError: 'boom' })).toEqual([
      '2 answers waiting to back up',
      'Last sync failed: boom',
    ]);
  });
});

describe('browserEnv', () => {
  it('reads online state and visibility from the browser and listens for wake-ups', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const env = browserEnv();
      expect(env.isOnline()).toBe(false);
      expect(env.isVisible()).toBe(false);
      expect(env.now()).toBeGreaterThan(0);
      let woke = 0;
      const off = env.onWake(() => woke++);
      win.dispatchEvent(new Event('online'));
      doc.dispatchEvent(new Event('visibilitychange')); // still hidden: no wake
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(woke).toBe(2);
      expect(env.isVisible()).toBe(true);
      off();
      win.dispatchEvent(new Event('online'));
      expect(woke).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is the default environment', async () => {
    const clock = new Clock();
    const d = await device(new FakeServer(() => clock.now), clock);
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const engine = new SyncEngine(d.store, new FakeServer().backend());
      await engine.sync();
      expect((await engine.status()).offline).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
