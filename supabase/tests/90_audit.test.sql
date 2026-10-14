-- Migration 0004 (security audit, docs/SECURITY_AUDIT.md): what the signed-in account could
-- do straight to the tables before, and is refused now. One transaction, rolled back.
\set bank `cat "$ROOT/tests/fixtures/sample-bank.json"`
begin;
select set_config('tests.bank', :'bank', true) \gset

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a9', 'fake-audit@example.test'),
  ('00000000-0000-4000-8000-0000000000b9', 'fake-anon@example.test');

select tests.login_service() \gset
do $$ begin
  perform public.import_bank(current_setting('tests.bank')::jsonb, true);
end $$;

select tests.login('00000000-0000-4000-8000-0000000000a9') \gset
do $$
declare r jsonb;
begin
  -- L12: an answer written straight into the table gets the same checks as apply_changes.
  perform tests.expect_error($q$
    insert into public.attempts (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
    values (gen_random_uuid(), 'fake1-q01', 1, '0123456789abcdef', true, 3, 'lesson',
            '{"evil": "<img src=x onerror=alert(1)>"}', '2026-10-13T20:00:00Z')$q$,
    '%answer refused: response has the wrong shape%');
  perform tests.expect_error($q$
    insert into public.attempts (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
    values (gen_random_uuid(), 'fake1-q01', 1, '0123456789abcdef', true, 1, 'lesson',
            '{"type": "mc", "choice": "A"}', now() + interval '3 days')$q$,
    '%answer refused: answeredAt is more than 1 day in the future%');
  -- A well-formed one is still accepted (the check is the same, not stricter).
  insert into public.attempts (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
  values ('00000000-0000-4000-8000-000000009001', 'fake1-q01', 1, '0123456789abcdef', true, 1,
          'lesson', '{"type": "mc", "choice": "A"}', '2026-10-13T20:00:00.123456Z');
  -- At most 200 answers in one statement.
  perform tests.expect_error($q$
    insert into public.attempts (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
    select gen_random_uuid(), 'fake1-q01', 1, '0123456789abcdef', true, 1, 'lesson',
           '{"type": "mc", "choice": "A"}', '2026-10-13T20:00:00Z'
    from generate_series(1, 201)$q$,
    '%too many answers in one statement (201 > 200)%');
  -- apply_changes keeps working, 200 at a time.
  r := public.apply_changes(
         (select jsonb_agg(tests.att(9100 + n)) from generate_series(1, 200) n),
         tests.settings(), null);
  assert r ->> 'inserted' = '200', r::text;
  assert r ->> 'settings_version' = '1', r::text;

  -- L12: the version can't be wound back; every app update moves it forward by one.
  update public.settings set version = 1, lesson_size = 12;
  assert (select version from public.settings) = 2, 'version not raised';
  update public.settings set version = 99;
  assert (select version from public.settings) = 3, 'version jumped';
  r := public.apply_changes('[]'::jsonb, tests.settings(20), 3);
  assert r ->> 'settings_version' = '4' and r ->> 'settings_conflict' = 'false', r::text;
  r := public.apply_changes('[]'::jsonb, tests.settings(25), 3);
  assert r ->> 'settings_conflict' = 'true', r::text;

  -- L13: only real push services.
  perform public.save_push_subscription('https://web.push.apple.com/audit-1', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  perform public.save_push_subscription('https://fcm.googleapis.com/fcm/send/audit', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  perform tests.expect_error($q$select public.save_push_subscription('https://169.254.169.254/latest/meta-data/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error($q$select public.save_push_subscription('https://localhost:5432/', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error($q$select public.save_push_subscription('https://user:pass@web.push.apple.com/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error($q$select public.save_push_subscription('https://web.push.apple.com.evil.test/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  perform tests.expect_error($q$insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://attacker.example/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%push address refused%');
  assert public.is_push_endpoint('https://updates.push.services.mozilla.com/wpush/v2/a');
  assert public.is_push_endpoint('https://wns2-par02p.notify.windows.com/w/?token=a');
  assert not public.is_push_endpoint('https://notify.windows.com.evil.test/');
  assert not public.is_push_endpoint(null);

  -- L13: at most 10 devices with reminders on; re-saving one of them is fine at the cap.
  for i in 3..10 loop
    perform public.save_push_subscription('https://web.push.apple.com/audit-' || i, 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  end loop;
  assert (select count(*) from public.push_subscriptions where disabled_at is null) = 10;
  perform tests.expect_error($q$select public.save_push_subscription('https://web.push.apple.com/audit-11', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%too many devices%');
  perform public.save_push_subscription('https://web.push.apple.com/audit-5', 'BPkbbbbbbbbbbbbbbbbb', 'authsecret2');
  -- Turning one off frees a place; turning it back on at the cap is refused.
  assert public.disable_push_subscription('https://web.push.apple.com/audit-3');
  perform public.save_push_subscription('https://web.push.apple.com/audit-11', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  perform tests.expect_error($q$select public.save_push_subscription('https://web.push.apple.com/audit-3', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%too many devices%');
end $$;

-- The table's own check still holds where the new check does not apply (the service role).
select tests.login_service() \gset
do $$
begin
  perform tests.expect_error($q$insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('00000000-0000-4000-8000-0000000000a9', 'http://web.push.apple.com/x', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%check constraint%');
  -- The service role (the reminder function) is not limited by the app's rules.
  update public.push_subscriptions set failure_count = failure_count + 1
  where endpoint = 'https://web.push.apple.com/audit-1';
end $$;

-- L14: an anonymous sign-in (if it were ever switched on) gets nothing.
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-0000000000b9", "role": "authenticated", "is_anonymous": true}', true) \gset
select set_config('role', 'authenticated', true) \gset
do $$
declare r jsonb;
begin
  assert (select count(*) from public.questions) = 0, 'anonymous user reads questions';
  assert (select count(*) from public.bank_meta) = 0, 'anonymous user reads bank_meta';
  perform tests.expect_error($q$select public.apply_changes(jsonb_build_array(tests.att(9500)), null, null)$q$, '%row-level security%');
  perform tests.expect_error($q$select public.apply_changes('[]'::jsonb, tests.settings(), null)$q$, '%row-level security%');
  perform tests.expect_error($q$select public.save_push_subscription('https://web.push.apple.com/anon', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%row-level security%');
end $$;
-- A normal sign-in token that says is_anonymous: false still works.
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-0000000000b9", "role": "authenticated", "is_anonymous": false}', true) \gset
do $$
declare r jsonb;
begin
  assert (select count(*) from public.questions) > 0, 'signed-in user cannot read questions';
  r := public.apply_changes(jsonb_build_array(tests.att(9501)), null, null);
  assert r ->> 'inserted' = '1', r::text;
end $$;
reset role;

-- L15: a function or table made by a later migration is closed by default.
set local role migrator;
create function public.zz_future_fn() returns int language sql set search_path = public as $$ select 1 $$;
create table public.zz_future_tbl (id int);
reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.zz_future_fn()', 'execute'), 'anon can run a new function';
  assert not has_function_privilege('authenticated', 'public.zz_future_fn()', 'execute'), 'app can run a new function';
  assert not has_table_privilege('service_role', 'public.zz_future_tbl', 'truncate, references, trigger'), 'service_role may truncate a new table';
end $$;

rollback;
