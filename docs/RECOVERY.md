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

Steps (the build session walks you through it and pastes the SQL in chat, with the
`PASTE_…` values already filled in):
1. **Look first (read-only).** Supabase → **SQL Editor** → **New query** → paste the
   "look first" query → **Run**. It lists what changed in the window, e.g.
   `settings UPDATE 1`, `questions DELETE 10`. Copy the result back to Claude.
2. **Dry run.** Paste the restore script with `PASTE_DRY_RUN` set to `true` → **Run**. It
   changes nothing and lists each row as `WOULD BE restored …` or `WOULD BE skipped …`
   (skipped = changed again after the window, so it is left alone). Copy the result back.
3. **Approve.** Claude shows you exactly which rows the restore will put back. You approve
   that one restore in chat.
4. **Restore.** Claude pastes the same script with `PASTE_DRY_RUN` set to `false` and the
   first line filled in (`-- guardrail-approved: Jonathan, <date>, <why>`) → **Run**. The
   last result says e.g. `restored: questions 10, settings 1`. The SQL editor may warn about
   "destructive operations": this script only inserts and updates; it never deletes.
5. **Check in the app.** Running the script a second time is harmless: it says
   `restored: nothing`.

The scripts below are the exact files the recovery test runs (`supabase/tests/50_recovery.test.sh`),
and a test (`scripts/docs-sync.test.mjs`) fails if this page and the files ever differ.

Look first, `supabase/recovery/look_first.sql`:

<!-- file: supabase/recovery/look_first.sql -->
```sql
-- READ-ONLY. Lists what changed between two times, from the safety log (RECOVERY.md §5).
-- Replace PASTE_FROM_TIME and PASTE_TO_TIME with times in UTC, e.g. 2026-11-02 14:00:00+00
select table_name, op, count(*) as changes, min(at) as first_change, max(at) as last_change
from public.safety_log
where at >= timestamptz 'PASTE_FROM_TIME' and at < timestamptz 'PASTE_TO_TIME'
group by table_name, op
order by table_name, op;
```

Restore, `supabase/recovery/restore_from_safety_log.sql`:

<!-- file: supabase/recovery/restore_from_safety_log.sql -->
```sql
-- guardrail-approved: PASTE_WHO_DATE_WHY
-- Puts rows back the way they were just BEFORE a time window, for rows changed or deleted
-- INSIDE the window (RECOVERY.md §5). Run only after the owner approved this exact restore.
-- It never deletes anything. Rows changed again after the window are left alone (listed as
-- skipped), and answers (attempts) are never touched: they are restored by importing an
-- export file in the app.
--
-- Fill in the three PASTE_ values (keep the quotes). Times are UTC, e.g. 2026-11-02 14:00:00+00
-- PASTE_DRY_RUN: 'true' only lists what would happen; 'false' restores.
begin;

create temp table recovery_window on commit drop as
select timestamptz 'PASTE_FROM_TIME' as from_at,
       timestamptz 'PASTE_TO_TIME' as to_at,
       'PASTE_DRY_RUN'::boolean as dry_run;

create temp table recovery_result (table_name text, row_key text, action text) on commit drop;

do $$
declare
  w record;
  t record;
  c record;
  cols text;
  cur jsonb;
  action text;
begin
  select * into w from recovery_window;
  if w.to_at <= w.from_at then
    raise exception 'the end of the window must be after the start';
  end if;

  for t in select * from (values ('bank_meta', 'id'), ('scenarios', 'id'), ('questions', 'id'),
                                 ('settings', 'user_id'), ('push_subscriptions', 'id')) v(name, pk) loop
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
    where table_schema = 'public' and table_name = t.name and is_generated = 'NEVER'
      and coalesce(identity_generation, '') <> 'ALWAYS';

    for c in
      select l.old_row ->> t.pk as row_key,
             (array_agg(l.old_row order by l.at, l.id))[1] as before_row,
             (array_agg(l.op order by l.at desc, l.id desc))[1] as last_op
      from public.safety_log l
      where l.table_name = t.name and l.at >= w.from_at and l.at < w.to_at
      group by 1
      order by 1
    loop
      execute format('select to_jsonb(x) from public.%I x where x.%I::text = $1', t.name, t.pk)
        into cur using c.row_key;
      if exists (select 1 from public.safety_log l
                 where l.table_name = t.name and l.old_row ->> t.pk = c.row_key and l.at >= w.to_at) then
        action := 'skipped: changed again after the window';
      elsif cur is null then
        action := 'restored (put back)';
        if not w.dry_run then
          execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
                         t.name, cols, cols, t.name) using c.before_row;
        end if;
      elsif c.last_op = 'DELETE' then
        action := 'skipped: re-created after the window';
      elsif cur = c.before_row then
        action := 'skipped: already as before';
      else
        action := 'restored (changed back)';
        if not w.dry_run then
          execute format('update public.%I x set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where x.%I::text = $2',
                         t.name, cols, cols, t.name, t.pk) using c.before_row, c.row_key;
        end if;
      end if;
      -- Restored settings get a NEW version number, higher than any this row ever had, so a
      -- phone holding an old copy can't mistake it for the one it has (audit L11).
      if t.name = 'settings' and action like 'restored%' and not w.dry_run then
        update public.settings set updated_at = now(), version = 1 + greatest(
          coalesce((cur ->> 'version')::int, 0),
          (select coalesce(max(greatest((l.old_row ->> 'version')::int,
                                        coalesce((l.new_row ->> 'version')::int, 0))), 0)
           from public.safety_log l
           where l.table_name = 'settings' and l.old_row ->> 'user_id' = c.row_key))
        where user_id::text = c.row_key;
      end if;
      insert into recovery_result values (t.name, c.row_key,
        case when w.dry_run then 'WOULD BE ' || action else action end);
    end loop;
  end loop;
end $$;

select table_name, row_key, action from recovery_result order by table_name, row_key;
select case when (select dry_run from recovery_window) then 'DRY RUN, nothing changed. ' else '' end
       || 'restored: ' || coalesce((select string_agg(table_name || ' ' || n, ', ' order by table_name)
          from (select table_name, count(*) n from recovery_result
                where action like '%restored%' group by table_name) s), 'nothing') as summary;

commit;
```

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
   latest weekly export). The preview warns that the file is from a different account
   (it is: the account is new). That is expected here: tick **Import anyway** → **Import**.
5. Check XP and the area bars.

## 8. GitHub repository problem

The ruleset stops `main` being deleted or force-pushed. If a bad commit lands on `main`,
the fix is a **new** commit that reverts it (the build session can make one with your OK),
never a history rewrite. The live app only updates when the deploy workflow succeeds, and
it never deletes anything from Supabase.
