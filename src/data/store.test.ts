import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  Clock,
  device,
  FakeServer,
  nextId,
  OTHER_USER,
  RIGHT,
  settings0,
  USER,
} from '../../tests/dataHelpers';
import { attempt, fakeBank, q } from '../../tests/helpers';
import { dbName, deleteUserDb, openUserDb } from './db';
import { LocalStore } from './store';

const bank = fakeBank();

describe('guardedWrite', () => {
  it('rejects an invalid answer and writes nothing', async () => {
    const d = await device(new FakeServer(), new Clock());
    const bad = { ...attempt(q(bank, 'fake1-q01'), true, '2026-10-13T20:00:00Z'), xp: 3.7 };
    const r = await d.store.guardedWrite({ kind: 'attempt', attempt: bad });
    expect(r).toEqual({ ok: false, errors: ['xp must be a whole number from 0 to 3'] });
    expect(await d.store.attempts()).toEqual([]);
    expect(await d.store.outbox()).toEqual([]);
  });

  it('saves the answer and its outbox entry together, in the one timestamp spelling', async () => {
    const d = await device(new FakeServer(), new Clock());
    let changes = 0;
    d.store.subscribe(() => changes++);
    const a = { ...attempt(q(bank, 'fake1-q01'), true, '2026-10-13T13:00:00-07:00'), id: nextId() };
    expect(await d.store.guardedWrite({ kind: 'attempt', attempt: a })).toEqual({ ok: true });
    const saved = { ...a, answeredAt: '2026-10-13T20:00:00.000Z' };
    expect(await d.store.attempts()).toEqual([saved]);
    expect(await d.store.outbox()).toEqual([{ n: 1, kind: 'attempt', attempt: saved }]);
    expect(await d.store.pending()).toEqual({ answers: 1, settings: false });
    expect(changes).toBe(1);
    // The same answer twice is refused; nothing is duplicated.
    const again = await d.store.guardedWrite({ kind: 'attempt', attempt: a });
    expect(again).toEqual({ ok: false, errors: ['this answer was already saved'] });
    expect(await d.store.outbox()).toHaveLength(1);
    expect(d.store.writing).toBe(false);
  });

  it('rejects invalid settings; saves valid settings on top of the known server version', async () => {
    const d = await device(new FakeServer(), new Clock());
    const bad = await d.store.guardedWrite({
      kind: 'settings',
      settings: { ...settings0(), lessonSize: 31 },
    });
    expect(bad.ok).toBe(false);
    expect(await d.store.settingsRecord()).toBeUndefined();
    await d.store.saveDefaultSettings(settings0());
    expect(await d.store.settingsRecord()).toEqual({
      settings: settings0(),
      version: null,
      isDefault: true,
    });
    // Defaults are only written once.
    await d.store.saveDefaultSettings({ ...settings0(), lessonSize: 20 });
    expect((await d.store.settingsRecord())?.settings.lessonSize).toBe(10);
    await d.store.confirmSent({
      sentKeys: [1],
      settings: { outcome: 'saved', version: 4 },
      notices: [],
    });
    const s = { ...settings0(), lessonSize: 12 };
    expect(await d.store.guardedWrite({ kind: 'settings', settings: s })).toEqual({ ok: true });
    expect(await d.store.settingsRecord()).toEqual({ settings: s, version: 4, isDefault: false });
    expect(await d.store.pending()).toEqual({ answers: 0, settings: true });
  });

  it('refuses invalid default settings', async () => {
    const d = await device(new FakeServer(), new Clock());
    await expect(
      d.store.saveDefaultSettings({ ...settings0(), timeZone: 'Mars/Base' }),
    ).rejects.toThrow('timeZone');
  });

  it('reports a storage failure instead of swallowing it', async () => {
    const d = await device(new FakeServer(), new Clock());
    d.store.close();
    const a = { ...attempt(q(bank, 'fake1-q01'), true, '2026-10-13T20:00:00Z'), id: nextId() };
    const r = await d.store.guardedWrite({ kind: 'attempt', attempt: a });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^Could not save on this phone: /);
    expect(d.store.writing).toBe(false);
  });
});

describe('notices and meta', () => {
  it('keeps the last 20 notices until dismissed', async () => {
    const d = await device(new FakeServer(), new Clock());
    await d.store.addNotices([]);
    for (let i = 0; i < 25; i++) await d.store.addNotices([`n${i}`]);
    const meta = await d.store.meta();
    expect(meta.notices).toHaveLength(20);
    expect(meta.notices[19]).toBe('n24');
    await d.store.confirmSent({ sentKeys: [], settings: null, notices: ['last'] });
    expect((await d.store.meta()).notices.at(-1)).toBe('last');
    await d.store.dismissNotices();
    expect(await d.store.meta()).toEqual({
      cursor: 0,
      lastSyncAt: null,
      lastExportAt: null,
      notices: [],
      reminderOfferDone: false,
    });
  });

  it('refuses a pulled page when a local write happened since the pull started', async () => {
    const d = await device(new FakeServer(), new Clock());
    const epoch = d.store.writeEpoch;
    await d.answer('fake1-q01', RIGHT);
    expect(await d.store.mergePulled(epoch, [], 5)).toBe(false);
    expect((await d.store.meta()).cursor).toBe(0);
    expect(await d.store.mergePulled(d.store.writeEpoch, [], 5)).toBe(true);
    expect((await d.store.meta()).cursor).toBe(5);
    // The cursor never moves backwards.
    expect(await d.store.mergePulled(d.store.writeEpoch, [], 3)).toBe(true);
    expect((await d.store.meta()).cursor).toBe(5);
    const s = { settings: settings0(), version: 3 };
    expect(await d.store.mergeServerSettings(epoch, s)).toBe(false);
    expect(await d.store.settingsRecord()).toBeUndefined();
  });

  it('a pulled copy never replaces the answer already on the phone', async () => {
    const d = await device(new FakeServer(), new Clock());
    const a = await d.answer('fake1-q01', RIGHT);
    const altered = { ...a, answeredAt: '2026-10-01T00:00:00.000Z' };
    await d.store.mergePulled(d.store.writeEpoch, [{ seq: 1, attempt: altered }], 1);
    expect((await d.store.attempts())[0]!.answeredAt).toBe(new Date(a.answeredAt).toISOString());
  });
});

describe('one database per user', () => {
  it('two accounts on one phone never see each other', async () => {
    const factory = new IDBFactory();
    const a = new LocalStore(await openUserDb(USER, factory));
    const b = new LocalStore(await openUserDb(OTHER_USER, factory));
    const x = { ...attempt(q(bank, 'fake1-q01'), true, new Date().toISOString()), id: nextId() };
    expect(await a.guardedWrite({ kind: 'attempt', attempt: x })).toEqual({ ok: true });
    expect(await b.attempts()).toEqual([]);
    a.close();
    await deleteUserDb(USER, factory);
    const again = new LocalStore(await openUserDb(USER, factory));
    expect(await again.attempts()).toEqual([]);
    again.close();
    b.close();
  });

  it('names databases by a well-formed user id only', () => {
    expect(dbName(USER)).toBe(`sphr-${USER}`);
    expect(() => dbName('../evil')).toThrow('invalid user id');
  });

  it('reports a failed delete', async () => {
    const request = {} as IDBOpenDBRequest & { error: DOMException | null };
    const factory = { deleteDatabase: () => request } as unknown as IDBFactory;
    const p = deleteUserDb(USER, factory);
    Object.assign(request, { error: new DOMException('disk full') });
    request.onerror!(new Event('error'));
    await expect(p).rejects.toThrow('disk full');
    const request2 = { error: null } as unknown as IDBOpenDBRequest;
    const p2 = deleteUserDb(USER, { deleteDatabase: () => request2 } as unknown as IDBFactory);
    request2.onerror!(new Event('error'));
    await expect(p2).rejects.toThrow('could not delete local data');
  });

  it('reports a delete blocked by another open tab', async () => {
    const factory = new IDBFactory();
    const open = await openUserDb(USER, factory);
    await expect(deleteUserDb(USER, factory)).rejects.toThrow('another tab');
    open.close();
  });
});

describe('confirmSent', () => {
  it('a settings conflict drops queued settings changes but never a queued answer', async () => {
    const d = await device(new FakeServer(), new Clock());
    let changes = 0;
    const off = d.store.subscribe(() => changes++);
    await d.store.guardedWrite({ kind: 'settings', settings: settings0() });
    await d.answer('fake1-q01', RIGHT);
    await d.store.guardedWrite({ kind: 'settings', settings: { ...settings0(), lessonSize: 8 } });
    const server = { settings: { ...settings0(), lessonSize: 22 }, version: 9 };
    await d.store.confirmSent({
      sentKeys: [1],
      settings: { outcome: 'conflict', server },
      notices: [],
    });
    expect((await d.store.outbox()).map((i) => i.kind)).toEqual(['attempt']);
    expect(await d.store.settingsRecord()).toEqual({ ...server, isDefault: false });
    off();
    const before = changes;
    await d.store.dismissNotices();
    expect(changes).toBe(before);
  });

  it('a saved outcome without local settings changes nothing', async () => {
    const d = await device(new FakeServer(), new Clock());
    await d.store.confirmSent({
      sentKeys: [],
      settings: { outcome: 'saved', version: 2 },
      notices: [],
    });
    expect(await d.store.settingsRecord()).toBeUndefined();
  });
});

describe('mergeServerSettings', () => {
  it('leaves local settings alone while a local change is queued (the next flush settles it)', async () => {
    const d = await device(new FakeServer(), new Clock());
    await d.answer('fake1-q01', RIGHT);
    const mine = { ...settings0(), lessonSize: 9 };
    await d.store.guardedWrite({ kind: 'settings', settings: mine });
    const server = { settings: { ...settings0(), lessonSize: 22 }, version: 3 };
    expect(await d.store.mergeServerSettings(d.store.writeEpoch, server)).toBe(true);
    expect((await d.store.settingsRecord())?.settings).toEqual(mine);
  });
});
