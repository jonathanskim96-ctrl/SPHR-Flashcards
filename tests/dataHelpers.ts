// Helpers for data-layer tests: a "device" is its own fake IndexedDB plus a sync engine
// pointed at a shared FakeServer. Uses the fake sample bank only.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { buildAttempt } from '../src/data/answer';
import { openUserDb } from '../src/data/db';
import { LocalStore } from '../src/data/store';
import { SyncEngine, type SyncEnv } from '../src/data/sync';
import type { Attempt, Bank, Mode, Response } from '../src/domain/types';
import { defaultSettings } from '../src/domain/validate';
import { FakeServer } from './fakeServer';
import { fakeBank, TZ } from './helpers';

export const USER = '00000000-0000-4000-8000-00000000a001';
export const OTHER_USER = '00000000-0000-4000-8000-00000000b001';
export const settings0 = () => defaultSettings(TZ);

/** A controllable clock (ms) shared by devices and the server. */
export class Clock {
  constructor(public now = Date.parse('2026-10-13T20:00:00.000Z')) {}
  tick(ms = 1000) {
    this.now += ms;
    return this.now;
  }
  date() {
    return new Date(this.now);
  }
}

export function testEnv(clock: Clock) {
  let online = true;
  const wakers = new Set<() => void>();
  const env: SyncEnv = {
    isOnline: () => online,
    isVisible: () => true,
    onWake(fn) {
      wakers.add(fn);
      return () => wakers.delete(fn);
    },
    now: () => clock.now,
  };
  return {
    env,
    setOnline(v: boolean) {
      online = v;
    },
    wake() {
      for (const f of wakers) f();
    },
    wakers,
  };
}

export interface Device {
  factory: IDBFactory;
  store: LocalStore;
  engine: SyncEngine;
  net: ReturnType<typeof testEnv>;
  answer(questionId: string, response: Response, mode?: Mode): Promise<Attempt>;
}

let ids = 0x100000;
export const nextId = () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`;

export async function device(
  server: FakeServer,
  clock: Clock,
  bank: Bank = fakeBank(),
  userId = USER,
): Promise<Device> {
  const factory = new IDBFactory();
  const store = new LocalStore(await openUserDb(userId, factory), () => clock.now);
  const net = testEnv(clock);
  const engine = new SyncEngine(store, server.backend(), net.env);
  return {
    factory,
    store,
    engine,
    net,
    async answer(questionId, response, mode = 'lesson') {
      const question = bank.questions.find((q) => q.id === questionId)!;
      const a = buildAttempt({ bank, question, response, mode, now: clock.date(), id: nextId() });
      clock.tick();
      const r = await store.guardedWrite({ kind: 'attempt', attempt: a });
      if (!r.ok) throw new Error(r.errors.join('; '));
      return a;
    },
  };
}

export const RIGHT: Response = { type: 'mc', choice: 'A' }; // fake1-q01's answer
export const WRONG: Response = { type: 'mc', choice: 'B' };
export { FakeServer };
