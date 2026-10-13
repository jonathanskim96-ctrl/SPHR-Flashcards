// The bank on the phone (BUILD_PLAN Phase 4): which copy wins, caching, re-checks, a bank
// that changes mid-card, and what edits and retirements do to her progress. Fake bank only.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { Clock, FakeServer, testEnv, USER } from '../../tests/dataHelpers';
import { attempt, at, rawSample, TZ } from '../../tests/helpers';
import { normalizeBank } from '../domain/bank';
import { refreshLesson } from '../domain/lesson';
import { computeProgress } from '../domain/progress';
import { replay } from '../domain/replay';
import type { Bank } from '../domain/types';
import { BankManager, fetchBundledBank, RECHECK_MS } from './bankManager';
import { openUserDb } from './db';
import { LocalStore } from './store';

type RawBank = ReturnType<typeof rawSample>;
const version = (bankVersion: string, edit: (b: RawBank) => void = () => {}): RawBank => {
  const b = rawSample();
  b.bankVersion = bankVersion;
  edit(b);
  return b;
};
const V1 = '2026-10-13.1';
const V2 = '2026-10-20.1';
const question = (b: RawBank, id: string) => b.questions.find((q) => q.id === id)!;

/** The new-questions example: 2 new questions, a stem edit, an answer change, a retirement. */
const v2 = () =>
  version(V2, (b) => {
    b.questions.push(
      { ...structuredClone(question(b, 'fake1-q01')), id: 'fake3-q01', stem: 'FAKE: new one?' },
      { ...structuredClone(question(b, 'fake1-q02')), id: 'fake3-q02', stem: 'FAKE: new two?' },
    );
    Object.assign(question(b, 'fake1-q01'), { stem: 'FAKE: reworded?', revision: 2 });
    Object.assign(question(b, 'fake1-q02'), { answer: 'A', revision: 2 });
    question(b, 'fake1-q06').status = 'retired';
  });

async function setup(
  o: { bundled?: unknown; server?: RawBank | null; cache?: unknown; factory?: IDBFactory } = {},
) {
  const clock = new Clock();
  const server = new FakeServer(() => clock.now);
  server.bank = o.server ?? null;
  const factory = o.factory ?? new IDBFactory();
  const store = new LocalStore(await openUserDb(USER, factory), () => clock.now);
  if (o.cache !== undefined) await store.db.put('bank', o.cache, 'current');
  const net = testEnv(clock);
  const loadBundled = vi.fn(async () => {
    if (o.bundled instanceof Error) throw o.bundled;
    return structuredClone('bundled' in o ? o.bundled : version(V1));
  });
  const manager = new BankManager(store, server.backend(), loadBundled, net.env);
  const changes = vi.fn();
  manager.subscribe(changes);
  return { clock, server, store, net, manager, changes, factory, loadBundled };
}

const cached = async (store: LocalStore) =>
  ((await store.db.get('bank', 'current')) as { bankVersion?: string } | undefined)?.bankVersion;

describe('which copy is used', () => {
  it('offline with nothing saved: the copy built into the app, then saved', async () => {
    const t = await setup({ server: version(V2) });
    t.server.offline = true;
    await t.manager.start();
    expect(t.manager.status()).toMatchObject({
      source: 'bundled',
      waiting: false,
      checking: false,
    });
    expect(t.manager.bank?.bankVersion).toBe(V1);
    expect(t.manager.status().lastError).toMatch(/^Could not check for new questions: /);
    expect(await cached(t.store)).toBe(V1);
    expect((await t.store.meta()).notices).toEqual([]);
  });

  it('server newer: the server copy, saved on the phone', async () => {
    const t = await setup({ server: version(V2) });
    await t.manager.start();
    expect([t.manager.status().source, t.manager.bank?.bankVersion]).toEqual(['server', V2]);
    expect(await cached(t.store)).toBe(V2);
    expect(t.manager.status().lastError).toBeNull();
    expect(t.changes).toHaveBeenCalled();
    const later = vi.fn();
    t.manager.subscribe(later)();
    await t.manager.check(true);
    expect(later).not.toHaveBeenCalled(); // unsubscribed
  });

  it('server older than the built-in copy: the built-in copy, and nothing downloaded', async () => {
    const t = await setup({ server: version('2026-10-01.1'), bundled: version(V2) });
    await t.manager.start();
    expect([t.manager.status().source, t.manager.bank?.bankVersion]).toEqual(['bundled', V2]);
    expect(t.server.bankDownloads).toBe(0);
  });

  it('nothing imported on the server yet: the built-in copy', async () => {
    const t = await setup();
    await t.manager.start();
    expect(t.manager.status()).toMatchObject({ source: 'bundled', lastError: null });
  });

  it('a damaged saved copy: falls back, reports it once, and repairs the saved copy', async () => {
    const t = await setup({ cache: { schemaVersion: 1, bankVersion: V2, questions: 'oops' } });
    t.server.offline = true;
    await t.manager.start();
    expect(t.manager.status().source).toBe('bundled');
    const notice =
      'The copy of the questions saved on this phone could not be read (areas must list the 5 areas).';
    expect((await t.store.meta()).notices).toEqual([notice]);
    expect(await cached(t.store)).toBe(V1);
    await t.manager.loadLocal(); // the saved copy is fine now: nothing new to report
    expect((await t.store.meta()).notices).toEqual([notice]);
  });

  it('a damaged saved copy with the same version as the server is downloaded again', async () => {
    const damaged = version(V2, (b) => (b.questions[0]!.type = 'essay'));
    const t = await setup({ cache: damaged, server: version(V2) });
    await t.manager.start();
    expect([t.manager.status().source, t.server.bankDownloads]).toEqual(['server', 1]);
  });

  it('the saved copy already has the server version: no download', async () => {
    const t = await setup({ cache: version(V2), server: version(V2) });
    await t.manager.start();
    expect([t.manager.status().source, t.server.bankDownloads]).toEqual(['cache', 0]);
  });

  it('a phone that cannot read its saved copy reports it and carries on', async () => {
    const t = await setup();
    vi.spyOn(t.store.db, 'get').mockRejectedValueOnce(new Error('disk error'));
    await t.manager.start();
    expect(t.manager.status().source).toBe('bundled');
    expect((await t.store.meta()).notices).toEqual([
      'The copy of the questions saved on this phone could not be read (disk error).',
    ]);
  });

  it('a saved copy that cannot be written is shown as an error, and the bank is still used', async () => {
    const t = await setup();
    vi.spyOn(t.store.db, 'put').mockRejectedValueOnce(new Error('quota exceeded'));
    await t.manager.loadLocal();
    expect(t.manager.status()).toMatchObject({
      source: 'bundled',
      lastError: 'Could not save the questions on this phone: quota exceeded',
    });
  });

  it('nothing at all: says so', async () => {
    const t = await setup({ bundled: new Error('HTTP 404') });
    t.server.offline = true;
    await t.manager.start();
    expect(t.manager.bank).toBeNull();
    expect((await t.store.meta()).notices).toEqual([
      'The copy of the questions built into the app could not be loaded (HTTP 404).',
      'No questions could be loaded. Connect to the internet and reopen the app.',
    ]);
  });

  it('a message that cannot be saved is still shown', async () => {
    const t = await setup({ bundled: null });
    t.server.offline = true;
    vi.spyOn(t.store, 'addNotices').mockRejectedValueOnce(new Error('closed'));
    await t.manager.loadLocal();
    expect(t.manager.status().lastError).toBe(
      'The copy of the questions built into the app could not be read (not a question bank). ' +
        'No questions could be loaded. Connect to the internet and reopen the app. ' +
        '(Could not save this message: closed)',
    );
  });

  it('the server copy keeps the bank order of the built-in copy', async () => {
    // The built-in file is not in id order; the server returns rows by id.
    const bundled = version(V1, (b) => b.questions.reverse());
    const t = await setup({ server: v2(), bundled });
    await t.manager.start();
    const got = t.manager.bank!.questions.map((q) => q.id);
    const local = bundled.questions.map((q) => q.id as string);
    expect(got).toEqual([...local, 'fake3-q01', 'fake3-q02']);
  });

  it('a server answer that is not a bank at all is reported, and the local copy kept', async () => {
    const t = await setup({ server: version(V2) });
    const backend = t.server.backend();
    backend.getBank = async () => 'garbage';
    const m = new BankManager(t.store, backend, t.loadBundled, t.net.env);
    await m.start();
    expect(m.status().source).toBe('bundled');
    expect((await t.store.meta()).notices).toEqual([
      'The questions on the server could not be read (not a question bank).',
    ]);
  });

  it('the server reports a version but returns no bank: nothing changes', async () => {
    const t = await setup({ server: version(V2) });
    const backend = t.server.backend();
    backend.getBank = async () => null;
    const m = new BankManager(t.store, backend, t.loadBundled, t.net.env);
    await m.start();
    expect(m.status()).toMatchObject({ source: 'bundled', lastError: null });
  });
});

describe('re-checking the server', () => {
  it('on wake-up, at most every 10 minutes; a failed check does not count', async () => {
    const t = await setup({ server: version(V1) });
    await t.manager.start();
    t.server.bank = version(V2);
    t.net.wake();
    await t.manager.check();
    expect(t.server.bankDownloads).toBe(0); // too soon
    expect(t.manager.bank?.bankVersion).toBe(V1);

    t.clock.tick(RECHECK_MS);
    t.server.offline = true;
    t.net.wake();
    await t.manager.check();
    expect(t.manager.status().lastError).toMatch(/Could not check/);
    t.server.offline = false;
    t.net.wake(); // the failed check did not start a new 10 minutes
    await t.manager.check();
    expect([t.manager.bank?.bankVersion, t.manager.status().lastError]).toEqual([V2, null]);
  });

  it('checks never overlap, and stop() ends the wake-ups', async () => {
    const t = await setup({ server: version(V2) });
    await t.manager.loadLocal();
    const a = t.manager.check(true);
    expect(t.manager.status().checking).toBe(true);
    expect(t.manager.check(true)).toBe(a);
    await a;
    t.manager.stop();
    t.manager.stop();
    expect(t.net.wakers.size).toBe(0);
    await t.manager.start(); // start again re-subscribes once
    await t.manager.start();
    expect(t.net.wakers.size).toBe(1);
  });

  it('the same version again changes nothing on screen', async () => {
    const t = await setup({ server: version(V2) });
    await t.manager.start();
    t.changes.mockClear();
    const bankBefore = t.manager.bank;
    await t.store.db.delete('bank', 'current'); // forces a download of the same version
    await t.manager.loadLocal();
    await t.manager.check(true);
    expect(t.manager.bank).toBe(bankBefore);
  });
});

describe('a new bank while a card is on screen', () => {
  it('waits until the card is finished, then the rest of the lesson uses it', async () => {
    const t = await setup({ server: v2() });
    await t.manager.loadLocal();
    const old = t.manager.bank!;
    const lesson = ['fake1-q04', 'fake1-q01', 'fake1-q06', 'fake1-q02'].map((id) =>
      old.questions.find((q) => q.id === id)!,
    );
    t.manager.beginCard();
    await t.manager.check(true);
    expect(t.manager.bank).toBe(old);
    expect(t.manager.status().waiting).toBe(true);
    await t.manager.check(true); // the same new version again: still just one waiting
    t.manager.endCard();
    const now = t.manager.bank!;
    expect([now.bankVersion, t.manager.status().waiting]).toEqual([V2, false]);
    const rest = refreshLesson(lesson.slice(1), now);
    expect(rest.map((q) => [q.id, q.revision])).toEqual([
      ['fake1-q01', 2],
      ['fake1-q02', 2],
    ]); // fake1-q06 was retired
    t.manager.endCard(); // nothing waiting: no change
    expect(t.manager.bank).toBe(now);
  });

  it('with no bank yet, the first one is used at once', async () => {
    const t = await setup({ bundled: null, server: version(V2) });
    t.manager.beginCard();
    await t.manager.start();
    expect(t.manager.bank?.bankVersion).toBe(V2);
  });
});

describe('what an update does to her progress', () => {
  const load = (raw: unknown): Bank => {
    const r = normalizeBank(raw);
    if (!r.ok) throw new Error(r.error);
    return r.bank;
  };
  const s = { examDate: '2026-12-15', timeZone: TZ };

  it('a stem-only edit keeps the card; an answer change resets it; retired cards leave progress', async () => {
    const before = load(version(V1));
    const id = (x: string) => before.questions.find((q) => q.id === x)!;
    const answers = ['fake1-q01', 'fake1-q02', 'fake1-q06'].flatMap((x) => [
      attempt(id(x), true, at('2026-10-13')),
      attempt(id(x), true, at('2026-10-14')),
    ]);
    const t = await setup({ server: v2() });
    await t.manager.start();
    const after = t.manager.bank!;
    const states = replay(answers, after, s);
    expect(states.get('fake1-q01')).toMatchObject({ box: 2, streak: 2 }); // kept
    expect(states.has('fake1-q02')).toBe(false); // reset: new again
    expect(states.get('fake1-q06')).toMatchObject({ box: 2 }); // retired keeps its state

    const pBefore = computeProgress(before, replay(answers, before, s));
    const pAfter = computeProgress(after, states);
    expect(pBefore[3].K).toEqual({ active: 2, seen: 1, mastered: 1, badge: false });
    expect(pAfter[3].K).toEqual({ active: 1, seen: 0, mastered: 0, badge: false });
    expect(pAfter[1].K.active).toBe(pBefore[1].K.active + 1); // fake3-q01 is new
    expect(pAfter[1].A).toMatchObject({ seen: 0, mastered: 0 }); // fake1-q02 reset
    expect(answers).toHaveLength(6); // her answers are untouched
  });
});

describe('fetchBundledBank', () => {
  it('fetches bank.json next to the app', async () => {
    const f = vi.fn(async () => new Response('{"a":1}'));
    expect(await fetchBundledBank(f as typeof fetch)).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}bank.json`);
  });

  it('an HTTP error is an error', async () => {
    const f = async () => new Response('', { status: 404 });
    await expect(fetchBundledBank(f as typeof fetch, 'x')).rejects.toThrow('HTTP 404');
  });
});
