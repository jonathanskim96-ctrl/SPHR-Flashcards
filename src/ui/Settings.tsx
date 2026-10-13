// Settings: pace, daily goal, exam date, daily reminder, backup status, Export / Import
// progress, sign out, and the build id. Changes are saved through guardedWrite; destructive
// or hard-to-undo actions (turning reminders off, importing, signing out) ask first in an
// in-app dialog.
import { useRef, useState, type ChangeEvent } from 'react';
import type { Session } from '../data/session';
import { signOut, signOutBlockedText } from '../data/session';
import { errorText } from '../data/store';
import { isLocalDate } from '../domain/dates';
import { buildExport, previewImport, type ImportPreview } from '../domain/exportImport';
import { EXAM_DATE_MAX, EXAM_DATE_MIN, SETTINGS_LIMITS } from '../domain/validate';
import type { Settings as SettingsData } from '../domain/types';
import type { PushDeps, RefreshResult } from '../data/push';
import type { AuthApi } from './auth';
import type { AppEnv } from './deps';
import { ConfirmDialog } from './Dialog';
import { refreshProblem, ReminderMessage, timeLabel, useReminderSwitch } from './reminder';
import { SyncStatusLine } from './SyncStatusLine';
import { OfflineLine } from './UpdateBanner';
import type { Study } from './useStudy';

export { timeLabel };

export const REMINDER_TIMES: string[] = Array.from({ length: 96 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, '0');
  const m = String((i % 4) * 15).padStart(2, '0');
  return `${h}:${m}`;
});

type Draft = { newPerDay: string; lessonSize: string; dailyXpGoal: string; examDate: string };

/** Friendly errors for the typed fields; returns the settings to save, or a list of problems. */
export function checkDraft(
  d: Draft,
  base: SettingsData,
): { ok: true; settings: SettingsData } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const num = (label: string, raw: string, key: keyof typeof SETTINGS_LIMITS): number => {
    const { min, max } = SETTINGS_LIMITS[key];
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max)
      errors.push(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const newPerDay = num('New cards per day', d.newPerDay, 'newPerDay');
  const lessonSize = num('Lesson length', d.lessonSize, 'lessonSize');
  const dailyXpGoal = num('Daily XP goal', d.dailyXpGoal, 'dailyXpGoal');
  if (!isLocalDate(d.examDate) || d.examDate < EXAM_DATE_MIN || d.examDate > EXAM_DATE_MAX)
    errors.push('Exam date must be a real date.');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    settings: { ...base, newPerDay, lessonSize, dailyXpGoal, examDate: d.examDate },
  };
}

export function Settings({
  session,
  study,
  auth,
  env,
  push,
  reminderRefresh,
  onBack,
  onSignedOut,
}: {
  session: Session;
  study: Study;
  auth: AuthApi;
  env: AppEnv;
  push: PushDeps;
  /** What the start-up check of this phone's reminder found. */
  reminderRefresh: RefreshResult | null;
  onBack: () => void;
  onSignedOut: () => void;
}) {
  const s = study.settings;
  const [draft, setDraft] = useState<Draft>({
    newPerDay: String(s.newPerDay),
    lessonSize: String(s.lessonSize),
    dailyXpGoal: String(s.dailyXpGoal),
    examDate: s.examDate,
  });
  // Settings changed underneath (restored from a file, or reloaded from another device):
  // show the new values instead of the old draft. Compared by content: the object is
  // re-read from the phone after every sync, and that must not wipe what she is typing.
  const settingsKey = JSON.stringify(s);
  const [seen, setSeen] = useState(settingsKey);
  if (seen !== settingsKey) {
    setSeen(settingsKey);
    setDraft({
      newPerDay: String(s.newPerDay),
      lessonSize: String(s.lessonSize),
      dailyXpGoal: String(s.dailyXpGoal),
      examDate: s.examDate,
    });
  }
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<'reminder-off' | 'sign-out' | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [imp, setImp] = useState<{ preview: ImportPreview; restoreSettings: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reminder = useReminderSwitch(session, push, s);
  const reminderProblem =
    reminder.problem ?? (s.reminderEnabled ? refreshProblem(reminderRefresh) : null);

  async function save(next: SettingsData) {
    const r = await session.store.guardedWrite({ kind: 'settings', settings: next });
    if (!r.ok) {
      setProblems([`Settings could not be saved: ${r.errors.join('; ')}`]);
      return false;
    }
    session.engine.noteAnswer();
    return true;
  }

  async function saveDraft() {
    setSaved(false);
    const c = checkDraft(draft, s);
    if (!c.ok) {
      setProblems(c.errors);
      return;
    }
    setProblems([]);
    setSaved(await save(c.settings));
  }

  async function setReminder(patch: Partial<SettingsData>) {
    setProblems([]);
    await save({ ...s, ...patch });
  }

  async function doExport() {
    try {
      const file = buildExport({
        attempts: await session.store.attempts(),
        settings: s,
        bankVersion: study.bank?.bankVersion ?? 'unknown',
        now: new Date(env.now()),
      });
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sphr-progress-${file.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await session.store.setMeta({ lastExportAt: file.exportedAt });
      setMessage({ kind: 'ok', text: `Exported ${file.attempts.length} answers.` });
    } catch (e) {
      setMessage({ kind: 'error', text: `Export failed: ${errorText(e)}` });
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMessage(null);
    try {
      const result = previewImport(await file.text(), await session.store.attempts(), env.now());
      if (!result.ok) setMessage({ kind: 'error', text: result.error });
      else setImp({ preview: result.preview, restoreSettings: false });
    } catch (err) {
      setMessage({ kind: 'error', text: `Could not read the file: ${errorText(err)}` });
    }
  }

  async function doImport() {
    if (!imp) return;
    const { preview, restoreSettings } = imp;
    setImp(null);
    let failed = 0;
    let first = '';
    for (const attempt of preview.added) {
      const r = await session.store.guardedWrite({ kind: 'attempt', attempt });
      if (!r.ok) {
        failed++;
        first ||= r.errors.join('; ');
      }
    }
    let settingsNote = '';
    if (restoreSettings && preview.settings) {
      const ok = await save(preview.settings);
      settingsNote = ok ? ' Settings restored.' : ' Settings could not be restored.';
    }
    session.engine.noteAnswer();
    const added = preview.added.length - failed;
    setMessage(
      failed
        ? {
            kind: 'error',
            text: `Imported ${added} answers; ${failed} could not be saved: ${first}.${settingsNote}`,
          }
        : { kind: 'ok', text: `Imported ${added} new answers.${settingsNote}` },
    );
  }

  async function doSignOut() {
    setConfirm(null);
    setBlocked(null);
    const r = await signOut(session, auth);
    if (r.ok) onSignedOut();
    else if (r.reason === 'unsynced') setBlocked(signOutBlockedText(r));
    else setMessage({ kind: 'error', text: r.error });
  }

  const field = (key: keyof Draft, label: string, hint: string) => (
    <label>
      {label}
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
      <span className="muted">{hint}</span>
    </label>
  );

  return (
    <main className="page">
      <header className="topbar">
        <button type="button" className="btn icon" onClick={onBack} aria-label="Back to Home">
          ←
        </button>
        <h1>Settings</h1>
      </header>

      <section className="stack" aria-label="Study pace">
        <h2>Study</h2>
        {field(
          'newPerDay',
          'New cards per day',
          `${SETTINGS_LIMITS.newPerDay.min}–${SETTINGS_LIMITS.newPerDay.max}`,
        )}
        {field(
          'lessonSize',
          'Cards per lesson',
          `${SETTINGS_LIMITS.lessonSize.min}–${SETTINGS_LIMITS.lessonSize.max}`,
        )}
        {field(
          'dailyXpGoal',
          'Daily XP goal',
          `${SETTINGS_LIMITS.dailyXpGoal.min}–${SETTINGS_LIMITS.dailyXpGoal.max}`,
        )}
        <label>
          Exam date
          <input
            type="date"
            value={draft.examDate}
            onChange={(e) => setDraft({ ...draft, examDate: e.target.value })}
          />
        </label>
        {problems.length > 0 && (
          <ul role="alert" className="error">
            {problems.map((p) => (
              <li key={p}>✗ {p}</li>
            ))}
          </ul>
        )}
        {saved && <p role="status">✓ Saved</p>}
        <button type="button" className="btn" onClick={() => void saveDraft()}>
          Save
        </button>
      </section>

      <section className="stack" aria-label="Daily reminder">
        <h2>Daily reminder</h2>
        {!env.installed ? (
          <div className="card stack" aria-label="Add to Home Screen">
            <p>
              <strong>Add this app to your Home Screen first.</strong> Reminders only work from the
              app icon.
            </p>
            <ol>
              <li>In Safari, tap the Share button (a square with an arrow).</li>
              <li>
                Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
              </li>
              <li>Open the SPHR icon and come back to this screen.</li>
            </ol>
          </div>
        ) : (
          <>
            <label className="switch-row">
              <input
                type="checkbox"
                role="switch"
                checked={s.reminderEnabled}
                disabled={reminder.busy}
                onChange={(e) =>
                  // Turning on asks for permission, which iOS allows only straight from the tap.
                  e.target.checked ? reminder.turnOn() : setConfirm('reminder-off')
                }
              />
              <span>Remind me every day</span>
            </label>
            <label>
              Time
              <select
                value={s.reminderTime}
                onChange={(e) => void setReminder({ reminderTime: e.target.value })}
              >
                {REMINDER_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {timeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">Time zone: {s.timeZone}</p>
            {reminder.busy && <p role="status">Turning on the reminder…</p>}
            {reminderProblem && <ReminderMessage problem={reminderProblem} />}
          </>
        )}
      </section>

      <section className="stack" aria-label="Backup">
        <h2>Backup</h2>
        <SyncStatusLine engine={session.engine} store={session.store} />
        <p className="muted">
          {study.lastExportAt
            ? `Last exported ${new Date(study.lastExportAt).toLocaleDateString()}`
            : 'Never exported'}
        </p>
        <button type="button" className="btn secondary" onClick={() => void doExport()}>
          Export progress
        </button>
        <button type="button" className="btn secondary" onClick={() => fileRef.current?.click()}>
          Import progress
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Progress file"
          onChange={(e) => void onFile(e)}
        />
        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={message.kind === 'error' ? 'error' : ''}
          >
            {message.kind === 'error' ? '✗' : '✓'} {message.text}
          </p>
        )}
      </section>

      <section className="stack" aria-label="Questions">
        <h2>Questions</h2>
        <p>
          {study.bank
            ? `Version ${study.bank.bankVersion} (${study.bankStatus.source ?? 'unknown'})`
            : 'Not loaded yet'}
        </p>
        {study.bankStatus.lastError && (
          <p role="alert" className="error">
            ✗ Could not check for new questions: {study.bankStatus.lastError}
          </p>
        )}
      </section>

      <section className="stack" aria-label="Account">
        <h2>Account</h2>
        {blocked && (
          <div role="alert" className="error">
            <p>✗ {blocked}</p>
            <button type="button" className="btn secondary" onClick={() => void doExport()}>
              Export progress
            </button>
          </div>
        )}
        <button type="button" className="btn secondary" onClick={() => setConfirm('sign-out')}>
          Sign out
        </button>
      </section>

      <footer className="muted footer">
        <div>Build {__BUILD_ID__}</div>
        <OfflineLine />
      </footer>

      {confirm === 'reminder-off' && (
        <ConfirmDialog
          title="Turn off the daily reminder?"
          confirmLabel="Turn off"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void reminder.turnOff();
          }}
        >
          <p>You will no longer get a reminder to practice.</p>
        </ConfirmDialog>
      )}
      {confirm === 'sign-out' && (
        <ConfirmDialog
          title="Sign out?"
          confirmLabel="Sign out"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doSignOut()}
        >
          <p>
            Your progress stays safe in your account. You will need your password to sign in again.
          </p>
        </ConfirmDialog>
      )}
      {imp && (
        <ConfirmDialog
          title="Import progress?"
          confirmLabel="Import"
          confirmDisabled={imp.preview.added.length === 0 && !imp.restoreSettings}
          onCancel={() => setImp(null)}
          onConfirm={() => void doImport()}
        >
          <p>
            {imp.preview.added.length} new answers, {imp.preview.present} already present,{' '}
            {imp.preview.rejected.length} rejected.
          </p>
          {imp.preview.rejected.length > 0 && (
            <ul>
              {imp.preview.rejected.slice(0, 5).map((r) => (
                <li key={r.index}>
                  #{r.index + 1}: {r.reason}
                </li>
              ))}
              {imp.preview.rejected.length > 5 && (
                <li>…and {imp.preview.rejected.length - 5} more</li>
              )}
            </ul>
          )}
          <p className="muted">Importing only adds answers; nothing is removed.</p>
          {imp.preview.settings ? (
            <label className="switch-row">
              <input
                type="checkbox"
                checked={imp.restoreSettings}
                onChange={(e) => setImp({ ...imp, restoreSettings: e.target.checked })}
              />
              <span>Also restore settings</span>
            </label>
          ) : (
            <p className="muted">
              The file's settings could not be read, so they will not be restored.
            </p>
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}
