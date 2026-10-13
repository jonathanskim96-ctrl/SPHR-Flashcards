// The daily reminder on screen, shared by Settings and the one-time Home card: turning it
// on (the permission request runs straight from the tap), turning it off, re-saving this
// phone's subscription when the app starts or comes back to the front, and the messages.
import { useEffect, useState } from 'react';
import {
  refreshReminder,
  turnOffReminder,
  turnOnReminder,
  type PushDeps,
  type RefreshResult,
} from '../data/push';
import type { Session } from '../data/session';
import type { Settings } from '../domain/types';
import type { Study } from './useStudy';

/** `15:00` → `3:00 PM`. */
export function timeLabel(hhmm: string): string {
  const [h = '0', m = '00'] = hhmm.split(':');
  const hour = Number(h);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

export type ReminderProblem =
  | { kind: 'denied' } // she tapped Don't Allow (now or earlier)
  | { kind: 'dismissed' }
  | { kind: 'unsupported' }
  | { kind: 'not-set-up' }
  | { kind: 'blocked'; permission: 'denied' | 'default' } // on, but this phone may not notify
  | { kind: 'error'; text: string }
  | { kind: 'off-error'; text: string };

/**
 * While the app runs from the Home Screen: when it starts, when it comes back to the front
 * (for example after allowing notifications in iPhone Settings), and whenever the reminder is
 * switched on (here or on another device), re-save this phone's subscription.
 */
export function useReminderRefresh(
  session: Session,
  push: PushDeps,
  enabled: boolean,
  installed: boolean,
): RefreshResult | null {
  const [result, setResult] = useState<RefreshResult | null>(null);
  useEffect(() => {
    if (!installed) return;
    let live = true;
    const run = () => {
      void refreshReminder(push, session.backend, enabled).then((r) => {
        if (live) setResult(r);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, push, enabled, installed]);
  return result;
}

export function useReminderSwitch(session: Session, push: PushDeps, settings: Settings) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReminderProblem | null>(null);

  async function saveEnabled(reminderEnabled: boolean): Promise<boolean> {
    const r = await session.store.guardedWrite({
      kind: 'settings',
      settings: { ...settings, reminderEnabled },
    });
    if (!r.ok) {
      setProblem({ kind: 'error', text: `Settings could not be saved: ${r.errors.join('; ')}` });
      return false;
    }
    session.engine.noteAnswer();
    return true;
  }

  /** Call straight from the tap handler: the permission request must be its first step. */
  function turnOn(onDone?: () => void) {
    if (busy) return;
    const pending = turnOnReminder(push, session.backend);
    setBusy(true);
    setProblem(null);
    void pending.then(async (r) => {
      if (r.ok) {
        if ((await saveEnabled(true)) && onDone) onDone();
      } else if (r.reason === 'error') {
        setProblem({ kind: 'error', text: r.error });
      } else {
        setProblem({ kind: r.reason });
      }
      setBusy(false);
    });
  }

  async function turnOff() {
    setProblem(null);
    if (!(await saveEnabled(false))) return;
    const error = await turnOffReminder(push, session.backend);
    if (error) setProblem({ kind: 'off-error', text: error });
  }

  return { busy, problem, turnOn, turnOff };
}

function AllowSteps({ last }: { last: string }) {
  return (
    <ol>
      <li>
        Open the iPhone <strong>Settings</strong> app.
      </li>
      <li>
        Tap <strong>Notifications</strong>, then scroll to <strong>SPHR</strong>.
      </li>
      <li>
        Turn on <strong>Allow Notifications</strong>.
      </li>
      <li>{last}</li>
    </ol>
  );
}

export function ReminderMessage({ problem }: { problem: ReminderProblem }) {
  switch (problem.kind) {
    case 'denied':
      return (
        <div role="alert" className="error">
          <p>
            ✗ Notifications are turned off for this app, so the reminder stays off. To allow them:
          </p>
          <AllowSteps last="Come back to this app and turn the reminder on." />
        </div>
      );
    case 'blocked':
      return problem.permission === 'denied' ? (
        <div role="alert" className="error">
          <p>
            ✗ Notifications are turned off for this app on this phone, so no reminder will arrive.
            To allow them:
          </p>
          <AllowSteps last="Come back to this app." />
        </div>
      ) : (
        <p role="alert" className="error">
          ✗ This phone has not been allowed to show the reminder yet. Turn the reminder off and on
          again to allow it.
        </p>
      );
    case 'dismissed':
      return (
        <p role="alert" className="error">
          ✗ Notifications were not allowed, so the reminder stays off.
        </p>
      );
    case 'unsupported':
      return (
        <p role="alert" className="error">
          ✗ This phone cannot show notifications from this app.
        </p>
      );
    case 'not-set-up':
      return (
        <p role="alert" className="error">
          ✗ Reminders are not set up yet (the app is missing its notification key).
        </p>
      );
    case 'error':
      return (
        <p role="alert" className="error">
          ✗ Could not turn on the reminder: {problem.text}
        </p>
      );
    case 'off-error':
      return (
        <p role="alert" className="error">
          ✗ The reminder is off, but the server could not be told yet ({problem.text}). It stops
          once your settings back up.
        </p>
      );
  }
}

/** What the start-up refresh found, as a problem to show (nothing when all is well). */
export function refreshProblem(r: RefreshResult | null): ReminderProblem | null {
  if (!r) return null;
  switch (r.state) {
    case 'blocked':
      return { kind: 'blocked', permission: r.permission };
    case 'unsupported':
    case 'not-set-up':
      return { kind: r.state };
    case 'error':
      return { kind: 'error', text: r.error };
    default:
      return null;
  }
}

/**
 * The one-time Home card (owner's decision, HANDOFF §2): offered in the installed app while
 * the reminder is off. "Turn on" runs the same flow as Settings; either button, or turning
 * the reminder on anywhere, retires the card on this phone for good.
 */
export function ReminderOffer({
  session,
  push,
  study,
}: {
  session: Session;
  push: PushDeps;
  study: Study;
}) {
  const sw = useReminderSwitch(session, push, study.settings);
  const done = () => void session.store.setMeta({ reminderOfferDone: true });
  return (
    <section className="card stack" aria-label="Daily reminder offer">
      <p>
        <strong>Turn on daily reminder ({timeLabel(study.settings.reminderTime)})?</strong>
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn secondary" onClick={done}>
          Not now
        </button>
        <button type="button" className="btn" disabled={sw.busy} onClick={() => sw.turnOn(done)}>
          Turn on
        </button>
      </div>
      {sw.problem && <ReminderMessage problem={sw.problem} />}
    </section>
  );
}

/** Whether the Home card should be offered on this phone right now. */
export function showReminderOffer(study: Study, push: PushDeps, installed: boolean): boolean {
  return (
    installed &&
    !study.settings.reminderEnabled &&
    !study.reminderOfferDone &&
    !!push.vapidKey &&
    push.platform.permission() !== null
  );
}
