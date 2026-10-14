#!/usr/bin/env bash
# Recovery test (BUILD_PLAN Phase 2): damage data, then run the documented recovery
# scripts exactly as docs/RECOVERY.md says (only the PASTE_ values filled in), as the
# non-superuser admin role, and check everything came back. Uses the throwaway test DB.
set -euo pipefail
psql_as() { local u="$1"; shift; "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -U "$u" "$@"; }
sql() { psql_as postgres -At -c "$1"; }
fill() { # script from to dry_run
  sed -e "s/PASTE_FROM_TIME/$2/" -e "s/PASTE_TO_TIME/$3/" -e "s/PASTE_DRY_RUN/$4/" \
      -e "s/PASTE_WHO_DATE_WHY/test, recovery test run/" "$ROOT/supabase/recovery/$1"
}
U=00000000-0000-4000-8000-0000000000c1

# Seed: the fake bank, a user with settings, a push subscription and the fixture answers.
psql_as postgres -v bank="$(cat "$ROOT/tests/fixtures/sample-bank.json")" \
  -v export="$(cat "$ROOT/tests/fixtures/sample-export.json")" <<SQL
insert into auth.users (id, email) values ('$U', 'fake-recovery@example.test');
begin;
select tests.login_service() \gset
select public.import_bank(:'bank'::jsonb, true) \gset
commit;
begin;
select tests.login('$U') \gset
select public.apply_changes((:'export'::jsonb) -> 'attempts', (:'export'::jsonb) -> 'settings', null) as r \gset
select public.save_push_subscription('https://web.push.apple.com/r1', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1') \gset
commit;
create table tests.snap_settings as select * from public.settings where user_id = '$U';
create table tests.snap_push as select * from public.push_subscriptions where user_id = '$U';
create table tests.snap_questions as select * from public.questions;
create table tests.snap_attempts as
  select id, user_id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at
  from public.attempts where user_id = '$U';
SQL
[ "$(sql "select count(*) from tests.snap_attempts")" = 36 ] || { echo "seed failed"; exit 1; }

# The accident, inside a window [T1, T2). Override set as an admin, as an accident would need.
T1=$(sql "select clock_timestamp()")
psql_as migrator <<SQL
begin;
set local app.guardrail_override = 'test: simulated accident';
update public.settings set lesson_size = 30, daily_xp_goal = 5, time_zone = 'UTC' where user_id = '$U';
update public.push_subscriptions set disabled_at = now() where user_id = '$U';
delete from public.questions where id in (select id from public.questions order by id limit 10);
update public.questions set data = data || '{"revision": 2}', revision = 2 where id = 'fake2-q10';
commit;
SQL
sleep 0.2
T2=$(sql "select clock_timestamp()")
sleep 0.2
# A legitimate change after the window, which must NOT be reverted.
psql_as migrator -c "update public.questions set data = data || '{\"revision\": 3}', revision = 3 where id = 'fake2-q10'"

# 1. Look first (read-only).
LOOK=$(fill look_first.sql "$T1" "$T2" x | psql_as migrator -At -F ' ')
EXPECTED="push_subscriptions UPDATE 1
questions DELETE 10
questions UPDATE 1
settings UPDATE 1"
[ "$(echo "$LOOK" | cut -d' ' -f1-3)" = "$EXPECTED" ] || { echo "look_first output was:"; echo "$LOOK"; exit 1; }

# 2. Dry run changes nothing.
DRY=$(fill restore_from_safety_log.sql "$T1" "$T2" true | psql_as migrator -At)
echo "$DRY" | grep -q "^DRY RUN, nothing changed. restored: push_subscriptions 1, questions 10, settings 1$" \
  || { echo "dry run output was:"; echo "$DRY"; exit 1; }
[ "$(sql "select count(*) from public.questions")" = 9 ] || { echo "dry run wrote"; exit 1; }

# 3. The restore.
OUT=$(fill restore_from_safety_log.sql "$T1" "$T2" false | psql_as migrator -At)
echo "$OUT" | grep -q "^restored: push_subscriptions 1, questions 10, settings 1$" \
  || { echo "restore output was:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "questions|fake2-q10|skipped: changed again after the window" \
  || { echo "fake2-q10 should be skipped:"; echo "$OUT"; exit 1; }

psql_as postgres <<SQL
do \$\$ begin
  assert (select to_jsonb(s) - 'version' - 'updated_at' from public.settings s where user_id = '$U')
       = (select to_jsonb(s) - 'version' - 'updated_at' from tests.snap_settings s), 'settings not restored';
  -- A new, higher version, never one a phone may already hold (audit L11).
  assert (select version from public.settings where user_id = '$U')
       > (select version from tests.snap_settings), 'restored settings reuse an old version';
  assert (select to_jsonb(p) from public.push_subscriptions p where user_id = '$U')
       = (select to_jsonb(p) from tests.snap_push p), 'subscription not restored';
  assert (select count(*) from public.questions) = 19, 'questions not all back';
  assert not exists (
    select to_jsonb(q) from tests.snap_questions q where q.id <> 'fake2-q10'
    except select to_jsonb(q) from public.questions q), 'a question differs from before';
  assert (select revision from public.questions where id = 'fake2-q10') = 3, 'later change was reverted';
  assert not exists (
    select * from tests.snap_attempts except
    select id, user_id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at
    from public.attempts where user_id = '$U'), 'answers were touched';
  assert (select count(*) from public.attempts where user_id = '$U') = 36;
end \$\$;
SQL

# 4. Running the restore again changes nothing more.
AGAIN=$(fill restore_from_safety_log.sql "$T1" "$T2" false | psql_as migrator -At)
echo "$AGAIN" | grep -q "^restored: nothing$" || { echo "second restore output was:"; echo "$AGAIN"; exit 1; }

# 5. Answers wiped (an owner-approved override as a stand-in for an accident), then
#    restored by importing the export file through the app's normal write path.
psql_as migrator -c "begin; set local app.guardrail_override = 'test: simulated wipe'; delete from public.attempts where user_id = '$U'; commit;"
[ "$(sql "select count(*) from public.attempts where user_id = '$U'")" = 0 ]
psql_as postgres -v export="$(cat "$ROOT/tests/fixtures/sample-export.json")" <<SQL
begin;
select tests.login('$U') \gset
select public.apply_changes((:'export'::jsonb) -> 'attempts') as r \gset
commit;
do \$\$ begin
  assert (select count(*) from public.attempts where user_id = '$U') = 36, 'not all answers re-imported';
  assert not exists (
    (select * from tests.snap_attempts
     except select id, user_id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at
     from public.attempts where user_id = '$U')
    union all
    (select id, user_id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at
     from public.attempts where user_id = '$U' except select * from tests.snap_attempts)),
    're-imported answers differ (replay would differ)';
  assert (select count(*) from public.safety_log where table_name = 'attempts' and op = 'DELETE') = 36,
    'the wipe was not logged';
end \$\$;
SQL
echo "    recovery: restore, skip-after-window, idempotent re-run and answer re-import all OK"
