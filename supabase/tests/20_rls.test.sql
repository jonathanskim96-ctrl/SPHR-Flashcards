-- Row-level security and the apply_changes / push-subscription write paths.
-- Everything runs in one transaction and is rolled back.
\set bank `cat "$ROOT/tests/fixtures/sample-bank.json"`
begin;
select set_config('tests.bank', :'bank', true) \gset

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'fake-a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'fake-b@example.test');

-- The import (service role) loads the fake bank.
select tests.login_service() \gset
do $$ begin
  assert (public.import_bank(current_setting('tests.bank')::jsonb, true) ->> 'applied')::boolean, 'import failed';
end $$;

-- User A saves 3 answers and first settings.
select tests.login('00000000-0000-4000-8000-0000000000a1') \gset
do $$
declare r jsonb;
begin
  r := public.apply_changes(jsonb_build_array(tests.att(1), tests.att(2, 'fake1-q02', true, 2), tests.att(3, 'fake1-q03', false, 0)),
                            tests.settings(), null);
  assert r ->> 'inserted' = '3' and r ->> 'duplicates' = '0', r::text;
  assert r ->> 'settings_version' = '1' and r ->> 'settings_conflict' = 'false', r::text;
  assert r -> 'rejected' = '[]'::jsonb, r::text;
  assert (r ->> 'max_seq')::bigint = (select max(seq) from public.attempts), r::text;

  -- Replaying the same batch (outbox retry) changes nothing.
  r := public.apply_changes(jsonb_build_array(tests.att(1), tests.att(2, 'fake1-q02', true, 2), tests.att(3, 'fake1-q03', false, 0)));
  assert r ->> 'inserted' = '0' and r ->> 'duplicates' = '3', r::text;
  assert (select count(*) from public.attempts) = 3, 'A should see 3 answers';
  assert (select count(*) from public.settings) = 1;

  -- Duplicates inside one batch count once.
  r := public.apply_changes(jsonb_build_array(tests.att(4), tests.att(4)));
  assert r ->> 'inserted' = '1' and r ->> 'duplicates' = '1', r::text;

  -- The bank is readable; the logs are not.
  assert (select count(*) from public.questions) = 19;
  assert (select count(*) from public.scenarios) = 1;
  assert (select bank_version from public.bank_meta) = '2026-10-13.1';
  perform tests.expect_error('select * from public.safety_log', '%permission denied%');
  perform tests.expect_error('select * from public.reminder_log', '%permission denied%');
  perform tests.expect_error('select * from public.keepalive_log', '%permission denied%');
end $$;

-- Bad answers are reported one by one; good ones in the same batch are saved.
do $$
declare r jsonb;
begin
  r := public.apply_changes(jsonb_build_array(
    tests.att(10),
    jsonb_set(tests.att(11), '{xp}', '3.7'),
    jsonb_set(tests.att(12), '{xp}', '"1"'),
    jsonb_set(tests.att(13, 'fake1-q01', false, 2), '{correct}', 'false'),
    tests.att(14) || '{"user_id": "00000000-0000-4000-8000-0000000000b1"}',
    '"junk"'::jsonb,
    jsonb_set(tests.att(15), '{answeredAt}', '"2030-01-01T00:00:00Z"'),
    jsonb_set(tests.att(16), '{response}', '{"type": "mc", "choice": 5}')));
  assert r ->> 'inserted' = '1', r::text;
  assert r -> 'rejected' = jsonb_build_array(
    jsonb_build_object('index', 1, 'id', tests.att(11) ->> 'id', 'reason', 'xp must be a whole number from 0 to 3'),
    jsonb_build_object('index', 2, 'id', tests.att(12) ->> 'id', 'reason', 'xp must be a whole number from 0 to 3'),
    jsonb_build_object('index', 3, 'id', tests.att(13) ->> 'id', 'reason', 'a wrong answer earns 0 xp'),
    jsonb_build_object('index', 4, 'id', tests.att(14) ->> 'id', 'reason', 'unknown field'),
    jsonb_build_object('index', 5, 'id', null, 'reason', 'attempt must be an object'),
    jsonb_build_object('index', 6, 'id', tests.att(15) ->> 'id', 'reason', 'answeredAt is more than 1 day in the future'),
    jsonb_build_object('index', 7, 'id', tests.att(16) ->> 'id', 'reason', 'response has the wrong shape for its type')), r::text;
end $$;

-- Settings: stale writes are refused and the server copy is returned.
do $$
declare r jsonb;
begin
  r := public.apply_changes('[]', tests.settings(12), 1);
  assert r ->> 'settings_version' = '2' and r ->> 'settings_conflict' = 'false', r::text;
  r := public.apply_changes('[]', tests.settings(20), 1); -- another device, old base version
  assert r ->> 'settings_conflict' = 'true', r::text;
  assert r -> 'server_settings' = tests.settings(12) || '{"version": 2}', r::text;
  assert (select lesson_size from public.settings) = 12, 'conflict must not overwrite';
  r := public.apply_changes('[]', tests.settings() || '{"lessonSize": 31}', 2);
  assert r ->> 'settings_error' = 'lessonSize must be a whole number from 5 to 30', r::text;
  assert (select version from public.settings) = 2;
  r := public.apply_changes('[]', tests.settings() || '{"admin": true}', 2);
  assert r ->> 'settings_error' = 'settings must have exactly the known fields', r::text;
end $$;

-- Push subscriptions through their two RPCs.
do $$
declare id1 uuid; id2 uuid;
begin
  id1 := public.save_push_subscription('https://web.push.apple.com/abc', 'BPk1aaaaaaaaaaaaaaaa', 'authsecret123');
  id2 := public.save_push_subscription('https://web.push.apple.com/abc', 'BPk2bbbbbbbbbbbbbbbb', 'authsecret456');
  assert id1 = id2, 'saving again must update, not duplicate';
  assert (select p256dh from public.push_subscriptions) = 'BPk2bbbbbbbbbbbbbbbb';
  assert public.disable_push_subscription('https://web.push.apple.com/abc');
  assert not public.disable_push_subscription('https://web.push.apple.com/abc'), 'already disabled';
  assert (select disabled_at is not null from public.push_subscriptions);
  perform public.save_push_subscription('https://web.push.apple.com/abc', 'BPk2bbbbbbbbbbbbbbbb', 'authsecret456');
  assert (select disabled_at is null from public.push_subscriptions), 'saving re-enables';
end $$;

-- User B sees none of A's data and cannot take over A's subscription.
select tests.login('00000000-0000-4000-8000-0000000000b1') \gset
do $$
declare r jsonb;
begin
  assert (select count(*) from public.attempts) = 0, 'B sees A''s answers';
  assert (select count(*) from public.settings) = 0, 'B sees A''s settings';
  assert (select count(*) from public.push_subscriptions) = 0, 'B sees A''s subscription';
  assert not public.disable_push_subscription('https://web.push.apple.com/abc'), 'B disabled A''s subscription';
  perform tests.expect_error(
    $q$select public.save_push_subscription('https://web.push.apple.com/abc', 'BPk9cccccccccccccccc', 'stolen12')$q$,
    '%row-level security%');
  -- B re-sending A's answer id is a no-op, not a takeover.
  r := public.apply_changes(jsonb_build_array(tests.att(1)));
  assert r ->> 'inserted' = '0' and r ->> 'duplicates' = '1', r::text;
  assert (select count(*) from public.attempts) = 0;
  r := public.apply_changes(jsonb_build_array(tests.att(100)), tests.settings(), null);
  assert r ->> 'inserted' = '1' and r ->> 'settings_version' = '1', r::text;
  assert (select count(*) from public.attempts) = 1;
  -- Updates and deletes affect nothing outside B's rows (and are not granted at all).
  update public.settings set lesson_size = 5 where user_id = '00000000-0000-4000-8000-0000000000a1';
  perform tests.expect_error('delete from public.settings', '%permission denied%');
end $$;

-- Anonymous visitors can read and call nothing.
select tests.login(null) \gset
do $$ begin
  perform tests.expect_error('select * from public.questions', '%permission denied%');
  perform tests.expect_error('select * from public.attempts', '%permission denied%');
  perform tests.expect_error('select * from public.settings', '%permission denied%');
  perform tests.expect_error('select * from public.bank_meta', '%permission denied%');
  perform tests.expect_error($q$select public.apply_changes('[]')$q$, '%permission denied%');
  perform tests.expect_error($q$select public.save_push_subscription('https://x.test/a', 'aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbb')$q$, '%permission denied%');
end $$;

-- The safety log recorded A's settings change with who made it; A's settings survived B.
reset role;
do $$ begin
  assert (select lesson_size from public.settings where user_id = '00000000-0000-4000-8000-0000000000a1') = 12;
  assert exists (select 1 from public.safety_log where table_name = 'settings' and op = 'UPDATE'
                 and db_user = 'authenticated' and jwt_sub = '00000000-0000-4000-8000-0000000000a1'
                 and old_row ->> 'lesson_size' = '10' and new_row ->> 'lesson_size' = '12'),
    'settings update not in safety_log';
  assert exists (select 1 from public.safety_log where table_name = 'push_subscriptions'), 'push update not logged';
end $$;
rollback;
