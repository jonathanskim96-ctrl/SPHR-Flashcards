-- Attack suite (BUILD_PLAN Phase 2): every attempt below must fail or be harmless.
-- Runs in one transaction and is rolled back.
\set bank `cat "$ROOT/tests/fixtures/sample-bank.json"`
begin;
select set_config('tests.bank', :'bank', true) \gset
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a2', 'fake-a2@example.test'),
  ('00000000-0000-4000-8000-0000000000b2', 'fake-b2@example.test');
select tests.login_service() \gset
do $$ begin perform public.import_bank(current_setting('tests.bank')::jsonb, true); end $$;

select tests.login('00000000-0000-4000-8000-0000000000a2') \gset
do $$
declare r jsonb; big jsonb;
begin
  perform public.apply_changes(jsonb_build_array(tests.att(201), tests.att(202)), tests.settings(), null);
  perform public.save_push_subscription('https://web.push.apple.com/a2', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');

  -- Forging the owner of a row.
  perform tests.expect_error($q$insert into public.attempts (id, user_id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
    values (gen_random_uuid(), '00000000-0000-4000-8000-0000000000b2', 'fake1-q01', 1, '0123456789abcdef', true, 1, 'lesson', '{"type":"mc","choice":"A"}', now())$q$,
    '%permission denied%');
  perform tests.expect_error($q$update public.settings set user_id = '00000000-0000-4000-8000-0000000000b2'$q$, '%permission denied%');
  perform tests.expect_error($q$insert into public.settings (user_id, time_zone) values ('00000000-0000-4000-8000-0000000000b2', 'UTC')$q$, '%permission denied%');
  perform tests.expect_error($q$update public.push_subscriptions set failure_count = 0$q$, '%permission denied%');

  -- Changing history, even one's own.
  perform tests.expect_error('update public.attempts set xp = 3', '%permission denied%');
  perform tests.expect_error('delete from public.attempts', '%permission denied%');
  perform set_config('app.guardrail_override', 'I am the app', true);
  perform tests.expect_error('delete from public.attempts', '%permission denied%');
  perform set_config('app.guardrail_override', '', true);

  -- Wiping or writing the bank, the logs, or anything else.
  perform tests.expect_error('truncate public.attempts', '%permission denied%');
  perform tests.expect_error('truncate public.questions', '%permission denied%');
  perform tests.expect_error('delete from public.questions', '%permission denied%');
  perform tests.expect_error($q$update public.questions set status = 'retired'$q$, '%permission denied%');
  perform tests.expect_error($q$insert into public.questions (id, revision, status, area, level, type, data) values ('evil-q1', 1, 'active', 1, 'K', 'mc', '{"id":"evil-q1","type":"mc","status":"active"}')$q$, '%permission denied%');
  perform tests.expect_error('insert into public.safety_log (table_name, op, old_row, db_user) values (''x'', ''DELETE'', ''{}'', ''me'')', '%permission denied%');
  perform tests.expect_error('select public.import_bank(''{}''::jsonb, true)', '%permission denied%');
  perform tests.expect_error('select public.keepalive()', '%permission denied%');
  perform tests.expect_error('select public.log_change()', '%permission denied%');

  -- Oversized and malformed input.
  select jsonb_agg(tests.att(1000 + g)) into big from generate_series(1, 201) g;
  perform tests.expect_error(format('select public.apply_changes(%L::jsonb)', big), '%too many answers%');
  perform tests.expect_error($q$select public.apply_changes('{"not": "an array"}')$q$, '%must be an array%');
  r := public.apply_changes(jsonb_build_array(
    jsonb_set(tests.att(301), '{xp}', '3.7'),
    jsonb_set(tests.att(302), '{xp}', '4'),
    jsonb_set(tests.att(303), '{revision}', '0'),
    jsonb_set(tests.att(304), '{response}', jsonb_build_object('type', 'text', 'input', repeat('x', 3000))),
    jsonb_set(tests.att(305), '{questionId}', to_jsonb('a-' || repeat('b', 2000))),
    jsonb_set(tests.att(306), '{revision}', '99999999999999999999'),
    jsonb_set(tests.att(307), '{answeredAt}', '"2026-02-30T12:00:00Z"'),
    jsonb_set(tests.att(308), '{answeredAt}', '"2026-10-13 12:00:00"'),
    jsonb_set(tests.att(309), '{mode}', '"exam"'),
    jsonb_set(tests.att(310), '{id}', '"ABCDEF00-0000-4000-8000-00000000000A"')));
  assert r ->> 'inserted' = '0', r::text;
  assert (select array_agg(x ->> 'reason' order by (x ->> 'index')::int) from jsonb_array_elements(r -> 'rejected') x) = array[
    'xp must be a whole number from 0 to 3', 'xp must be a whole number from 0 to 3',
    'revision must be a whole number >= 1', 'response is larger than 2048 bytes',
    'questionId has an invalid format', 'revision must be a whole number >= 1',
    'answeredAt must be an ISO timestamp', 'answeredAt must be an ISO timestamp',
    'mode is invalid', 'id must be a lowercase uuid'], r::text;

  -- The way PostgREST writes JSON into columns: 3.7 is an error, never rounded.
  perform tests.expect_error($q$select (json_populate_record(null::public.attempts, '{"xp": 2.6}')).xp$q$, '%invalid input syntax%');

  -- Settings: off-grid time, fake zone, out-of-range values (also straight to the table).
  r := public.apply_changes('[]', tests.settings() || '{"reminderTime": "15:07"}', 1);
  assert r ->> 'settings_error' = 'reminderTime must be HH:MM in 15-minute steps', r::text;
  r := public.apply_changes('[]', tests.settings() || '{"timeZone": "Mars/Olympus_Mons"}', 1);
  assert r ->> 'settings_error' = 'timeZone must be a real IANA time zone', r::text;
  r := public.apply_changes('[]', tests.settings() || '{"newPerDay": 3.7}', 1);
  assert r ->> 'settings_error' = 'newPerDay must be a whole number from 1 to 50', r::text;
  perform tests.expect_error($q$update public.settings set reminder_time = '15:07'$q$, '%check constraint%');
  perform tests.expect_error($q$update public.settings set reminder_time = '15:00:30'$q$, '%check constraint%');
  perform tests.expect_error($q$update public.settings set time_zone = 'Mars/Olympus_Mons'$q$, '%check constraint%');
  perform tests.expect_error($q$update public.settings set lesson_size = 31$q$, '%check constraint%');
  perform tests.expect_error($q$update public.settings set exam_date = '2101-01-01'$q$, '%check constraint%');

  -- Push endpoints must be https and of sane size.
  -- Since 0004 the push-service check refuses these before the table's own check does
  -- (90_audit.test.sql shows the table check still holds on its own).
  perform tests.expect_error($q$select public.save_push_subscription('http://web.push.apple.com/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error($q$select public.save_push_subscription('javascript:alert(1)', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error(format('select public.save_push_subscription(%L, ''BPkaaaaaaaaaaaaaaaaa'', ''authsecret1'')', 'https://web.push.apple.com/' || repeat('a', 1100)), '%check constraint%');
  perform tests.expect_error($q$select public.save_push_subscription('https://web.push.apple.com/k', 'bad key!', 'authsecret1')$q$, '%check constraint%');

  -- SQL-injection-shaped text is stored as plain data.
  r := public.apply_changes(jsonb_build_array(jsonb_set(tests.att(400), '{response}',
    '{"type": "text", "input": "x''); drop table public.attempts; --"}')));
  assert r ->> 'inserted' = '1', r::text;
  assert (select response ->> 'input' from public.attempts where id = (tests.att(400) ->> 'id')::uuid)
         = 'x''); drop table public.attempts; --';
  perform public.save_push_subscription('https://web.push.apple.com/q?a='');drop table x;--', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  assert to_regclass('public.attempts') is not null;
end $$;

-- The service role (used by the import and the reminder job) cannot rewrite history either.
select tests.login_service() \gset
do $$
declare n bigint;
begin
  perform tests.expect_error('update public.attempts set xp = 0', '%not allowed%');
  perform tests.expect_error('delete from public.attempts', '%not allowed%');
  perform tests.expect_error('delete from public.questions where id = ''fake1-q01''', '%not allowed%');
  perform tests.expect_error('delete from public.scenarios', '%not allowed%');
  perform tests.expect_error('delete from public.bank_meta', '%not allowed%');
  perform tests.expect_error('truncate public.attempts', '%permission denied%');
  perform tests.expect_error('truncate public.safety_log', '%permission denied%');
  n := public.keepalive();
  assert n = (select count(*) from public.keepalive_log), 'keepalive count';

  -- Mass-delete cap: 6 push subscriptions in one statement is refused; 5 is allowed.
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  select '00000000-0000-4000-8000-0000000000b2', 'https://web.push.apple.com/m' || g, 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1'
  from generate_series(1, 11) g;
  perform tests.expect_error($q$delete from public.push_subscriptions where endpoint like 'https://web.push.apple.com/m%' and endpoint not like '%/m1_'$q$, '%limit 5%');
  perform tests.expect_error($q$delete from public.push_subscriptions where endpoint like 'https://web.push.apple.com/m%'$q$, '%limit 5%');
  delete from public.push_subscriptions where endpoint in (select 'https://web.push.apple.com/m' || g from generate_series(1, 5) g);
  assert (select count(*) from public.push_subscriptions where endpoint like 'https://web.push.apple.com/m%') = 6;
  assert (select count(*) from public.safety_log where table_name = 'push_subscriptions' and op = 'DELETE') = 5;
  perform tests.expect_error('delete from public.safety_log', '%not allowed%');
  perform tests.expect_error('update public.safety_log set db_user = ''x''', '%not allowed%');
end $$;

-- Even the table owner (like Supabase's postgres role) is blocked without an override.
reset role;
set local role migrator;
do $$ begin
  perform tests.expect_error('delete from public.attempts', '%not allowed%');
  perform tests.expect_error('truncate public.attempts', '%not allowed%');
  perform tests.expect_error('truncate public.questions', '%not allowed%');
  perform tests.expect_error('delete from public.questions', '%not allowed%');
end $$;

-- Defence in depth: even if a future migration wrongly gave the app delete/update rights,
-- the guard triggers would still refuse, and the override would not work for the app.
grant delete, update on public.attempts, public.safety_log to authenticated;
grant delete on public.questions to authenticated;
create policy tmp_all on public.attempts to authenticated using (true);
create policy tmp_all on public.safety_log to authenticated using (true);
create policy tmp_all on public.questions to authenticated using (true);
select tests.login('00000000-0000-4000-8000-0000000000a2') \gset
do $$ begin
  perform set_config('app.guardrail_override', 'the app trying the override', true);
  perform tests.expect_error('delete from public.attempts', '%not allowed%');
  perform tests.expect_error('update public.attempts set xp = 0', '%not allowed%');
  perform tests.expect_error('delete from public.questions', '%not allowed%');
end $$;
rollback;
