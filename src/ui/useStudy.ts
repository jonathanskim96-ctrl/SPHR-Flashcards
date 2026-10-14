// Reads everything the screens show from the phone: answers, settings, the question bank.
// Card states, progress and XP are recomputed from the answer history (nothing is stored).
import { useEffect, useMemo, useState } from 'react';
import type { BankStatus } from '../data/bankManager';
import type { Session } from '../data/session';
import { errorText } from '../data/store';
import { localDateOf } from '../domain/dates';
import { computeProgress, type Progress } from '../domain/progress';
import { replay } from '../domain/replay';
import type { Attempt, Bank, CardState, LocalDate, Settings } from '../domain/types';
import { dailyXp, totalXp } from '../domain/xp';
import type { AppEnv } from './deps';

/** How often an open app checks whether the local date has changed. */
export const DAY_CHECK_MS = 30_000;

export interface Study {
  attempts: Attempt[];
  settings: Settings;
  lastExportAt: string | null;
  /** The one-time Home card offering the reminder was answered on this phone. */
  reminderOfferDone: boolean;
  bankStatus: BankStatus;
  bank: Bank | null;
  today: LocalDate;
  states: ReadonlyMap<string, CardState>;
  progress: Progress | null;
  xpTotal: number;
  xpToday: number;
}

export function useStudy(
  session: Session,
  env: AppEnv,
): { study: Study | null; error: string | null } {
  const [data, setData] = useState<{
    attempts: Attempt[];
    settings: Settings;
    lastExportAt: string | null;
    reminderOfferDone: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bankStatus, setBankStatus] = useState<BankStatus>(() => session.bank.status());

  useEffect(() => {
    let live = true;
    const load = () => {
      Promise.all([
        session.store.attempts(),
        session.store.settingsRecord(),
        session.store.meta(),
      ]).then(
        ([attempts, record, meta]) => {
          if (!live) return;
          setBankStatus(session.bank.status());
          if (!record) {
            setError('Your settings are missing from this phone. Close and reopen the app.');
            return;
          }
          setError(null);
          setData({
            attempts,
            settings: record.settings,
            lastExportAt: meta.lastExportAt,
            reminderOfferDone: meta.reminderOfferDone,
          });
        },
        (e: unknown) => {
          if (live) setError(`Could not read your progress from this phone: ${errorText(e)}`);
        },
      );
    };
    load();
    const offStore = session.store.subscribe(load);
    const offBank = session.bank.subscribe(() => setBankStatus(session.bank.status()));
    return () => {
      live = false;
      offStore();
      offBank();
    };
  }, [session]);

  // The local date can change while the app stays open (or waits in the background):
  // re-render when it does, so the XP ring, the daily new-card cap and due cards follow it.
  const timeZone = data?.settings.timeZone;
  const [, setDay] = useState<LocalDate | null>(null);
  useEffect(() => {
    if (!timeZone) return;
    const check = () => setDay(localDateOf(env.now(), timeZone));
    check();
    const timer = setInterval(check, DAY_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [env, timeZone]);

  const bank = bankStatus.bank;
  const states = useMemo(
    () =>
      data && bank ? replay(data.attempts, bank, data.settings) : new Map<string, CardState>(),
    [data, bank],
  );
  const progress = useMemo(() => (bank ? computeProgress(bank, states) : null), [bank, states]);

  if (!data) return { study: null, error };
  const today = localDateOf(env.now(), data.settings.timeZone);
  return {
    error,
    study: {
      ...data,
      bankStatus,
      bank,
      today,
      states,
      progress,
      xpTotal: totalXp(data.attempts),
      xpToday: dailyXp(data.attempts, today, data.settings.timeZone),
    },
  };
}
