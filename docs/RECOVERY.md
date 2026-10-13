# Recovery guide

What to do when something is lost. The free Supabase plan has **no automatic backups**, so
the app keeps three copies of what matters:

| What | Copy 1 | Copy 2 | Copy 3 |
|---|---|---|---|
| Michelle's progress (her answer history; XP, schedules and Mistakes are recalculated from it) | Her phone (IndexedDB) | Supabase `attempts` table (append-only) | Her exported progress file (Settings → Export progress) |
| Her settings | Her phone | Supabase `settings` (every change copied to `safety_log`) | The export file |
| The questions | `content/questions.json` in GitHub (the master copy) | Supabase `questions` (every change copied to `safety_log`) | Built into the app (`bank.json`) and cached on her phone |

**Rules while recovering** (from `CLAUDE.md`): don't delete anything to "start clean". Any
SQL that changes data needs the owner's explicit approval for that exact statement. When
unsure, stop and ask. Before any recovery SQL, if her phone still works, do an export
first.

Recommended habit: Michelle exports once a week (Settings → Export progress → **Save to
Files**). Settings shows "Last export: N days ago".

---

## 1. Lost, broken, or replaced phone

Nothing to restore in the database. Her progress is in Supabase.
1. On the new phone, follow `docs/INSTALL.md` (install, sign in, turn on reminders).
2. The app downloads her answer history and rebuilds XP, schedules and Mistakes.
3. Check: XP and the area bars look as before.

If she answered questions **offline** on the old phone and it never reconnected, those
answers are only on the old phone. If the old phone still turns on, open the app on it
while online and wait for "All answers backed up" in Settings.

## 2. The app was deleted from the Home Screen

Deleting the icon deletes the app's data on the phone. Anything already backed up is safe.
Reinstall (INSTALL.md) and sign in. Unsynced offline answers are lost unless an export file
has them. That's why sign-out is blocked while answers are waiting, and why the weekly
export helps.

## 3. Progress missing or wrong in Supabase

The `attempts` table refuses updates and deletes, so this should not happen. If it does:
1. On her phone (if it still has the data): Settings → **Export progress** → Save to Files.
2. Tell the build session what you see. It will check the safety log (§5) first.
3. To restore from an export file: on her phone, Settings → **Import progress** → choose
   the file → read the preview ("N new answers, M already present") → **Import**. Import
   only *adds* missing answers; it never removes anything, so it's safe to run twice.
4. Check: Settings shows "All answers backed up" and XP matches what you expected.

## 4. Questions table damaged or out of date

The master copy is `content/questions.json` in GitHub, so you can always rebuild:
1. Repo → **Actions** → **Import questions** → **Run workflow** (apply **unticked**).
2. The preview shows what would be re-added or corrected (e.g. "37 new" if rows went
   missing). If it refuses because Supabase has a *higher* revision than the file, stop and
   ask the build session; don't edit revisions by hand.
3. Run again with **apply** ticked (this is your approval for that write).

Her phone keeps working the whole time from its cached and built-in copies.

## 5. Undo bad changes to settings, subscriptions, or questions (safety log)

Every update and delete on every table is copied to `safety_log` with the old row and the
time. The tested script `supabase/recovery/restore_from_safety_log.sql` puts rows back
the way they were **before** a time you choose, for the changes made **inside** a window
you choose, and leaves alone anything changed legitimately afterwards. The recovery test
(`supabase/tests/recovery.sql`) runs this exact script on every CI run.

Steps (the build session walks you through it and pastes the SQL in chat):
1. **Look first (read-only):** the build session pastes a `select` that lists what changed
   in the window, e.g. "settings: 1 update at 14:02; questions: 10 deletes at 14:03".
   Run it in the SQL Editor and paste the result back to Claude.
2. Claude shows you exactly which rows the restore will put back. You approve that one
   restore in chat.
3. Claude pastes the restore SQL, which begins with a line like
   `-- guardrail-approved: Jonathan, <date>, restore settings after <what happened>`.
   Run it. You should see a summary like `restored: settings 1, questions 10`.
4. Check in the app.

> The build session must replace this paragraph with the final, tested script text (and
> the read-only "look first" query) once Phase 2 is done, so that this file always
> contains the exact SQL the recovery test runs.

## 6. Supabase project paused

The app keeps working on her phone; answers queue up; reminders stop.
1. Supabase emails you before and after pausing. Go to https://supabase.com/dashboard
   and open the project.
2. Click **Restore project** (or **Resume**). Wait a few minutes until it's green.
3. Open the app on her phone; it backs up the queued answers. Reminders resume on the
   next 15-minute run.
4. Check the keep-alive workflow is still enabled (SETUP Part D3).

A paused project can be restored for 90 days (per Supabase's docs).

## 7. Supabase project lost entirely (paused too long, or deleted)

1. **First, before anything else:** on her phone, Settings → **Export progress** → Save to
   Files. Export works offline, and her phone holds her full answer history.
2. Create a new project and redo `docs/SETUP.md` Part B (all steps) and A3/A4 with the
   new values. Redeploy (the build session will do this with your OK).
3. Part E: import the questions from GitHub.
4. On her phone: open the app (it reloads to the new version), sign in with the **new**
   account, then Settings → **Import progress** → choose the file from step 1 (or her
   latest weekly export) → **Import**.
5. Check XP and the area bars.

## 8. GitHub repository problem

The ruleset stops `main` being deleted or force-pushed. If a bad commit lands on `main`,
the fix is a **new** commit that reverts it (the build session can make one with your OK),
never a history rewrite. The live app only updates when the deploy workflow succeeds, and
it never deletes anything from Supabase.
