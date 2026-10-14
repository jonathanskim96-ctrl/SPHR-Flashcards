-- Phase 9 black-box attack: what a signed-in user (or an anonymous visitor) could try
-- through the API that the earlier files do not already cover. Every case must fail or be
-- harmless to the other account. One transaction, rolled back.
-- (Switching to a stronger role is not tried here: through the API the role comes from the
-- signed sign-in token, and this harness's own session is a superuser, so SET ROLE would
-- prove nothing.)
\set bank `cat "$ROOT/tests/fixtures/sample-bank.json"`
begin;
select set_config('tests.bank', :'bank', true) \gset

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'fake-c@example.test'),
  ('00000000-0000-4000-8000-0000000000f1', 'fake-d@example.test');

select tests.login_service() \gset
do $$ begin
  perform public.import_bank(current_setting('tests.bank')::jsonb, true);
end $$;

-- User D (the victim) has one answer, settings and a reminder subscription.
select tests.login('00000000-0000-4000-8000-0000000000f1') \gset
do $$
declare r jsonb;
begin
  r := public.apply_changes(jsonb_build_array(tests.att(4001)), tests.settings(), null);
  assert r ->> 'inserted' = '1', r::text;
  perform public.save_push_subscription('https://push.example.test/victim', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
end $$;

-- User C (the attacker).
select tests.login('00000000-0000-4000-8000-0000000000e1') \gset
do $$
declare r jsonb;
begin
  -- 1. An answer that names D as its owner is refused (unknown field), or stored as C's.
  r := public.apply_changes(jsonb_build_array(
         tests.att(4002) || '{"user_id": "00000000-0000-4000-8000-0000000000f1"}'::jsonb,
         tests.att(4003) || '{"userId": "00000000-0000-4000-8000-0000000000f1"}'::jsonb));
  assert (r ->> 'inserted')::int + jsonb_array_length(r -> 'rejected') = 2, r::text;

  -- 2. Re-sending D's answer id does not touch D's row or show it to C.
  r := public.apply_changes(jsonb_build_array(tests.att(4001, 'fake1-q02', false, 0)));
  assert (select count(*) from public.attempts where id = (tests.att(4001) ->> 'id')::uuid) = 0,
    'C must not see D''s answer';

  -- 3. Settings writes only ever touch C's own row, whatever base version is claimed.
  r := public.apply_changes('[]'::jsonb, tests.settings(29), 1);
  r := public.apply_changes('[]'::jsonb, tests.settings(28), 99);
  assert (select count(*) from public.settings) = 1, 'C sees only C''s settings';

  -- 4. C cannot take over or switch off D's reminder subscription by its address.
  begin
    perform public.save_push_subscription('https://push.example.test/victim', 'BPkbbbbbbbbbbbbbbbbb', 'authsecret2');
  exception when others then
    null; -- refused: fine
  end;
  perform public.disable_push_subscription('https://push.example.test/victim');

  -- 5. Answers with oversized or deeply nested responses are refused one by one.
  r := public.apply_changes(jsonb_build_array(
         tests.att(4004) || jsonb_build_object('response',
           jsonb_build_object('type', 'text', 'input', repeat('x', 100000))),
         tests.att(4005) || jsonb_build_object('response',
           (select string_agg('{"a":', '') || '1' || string_agg('}', '') from generate_series(1, 500))::jsonb)));
  assert jsonb_array_length(r -> 'rejected') = 2, r::text;
end $$;

-- D's data is exactly as D left it.
select tests.login_service() \gset
do $$
declare s record;
begin
  assert (select count(*) from public.attempts where user_id = '00000000-0000-4000-8000-0000000000f1') = 1,
    'D must still have exactly 1 answer';
  assert (select correct and xp = 1 and question_id = 'fake1-q01' from public.attempts
          where id = (tests.att(4001) ->> 'id')::uuid), 'D''s answer changed';
  assert (select lesson_size from public.settings where user_id = '00000000-0000-4000-8000-0000000000f1') = 10,
    'D''s settings changed';
  select * into s from public.push_subscriptions where endpoint = 'https://push.example.test/victim';
  assert s.user_id = '00000000-0000-4000-8000-0000000000f1', 'C took over D''s subscription';
  assert s.disabled_at is null, 'C switched off D''s reminder';
  assert s.p256dh = 'BPkaaaaaaaaaaaaaaaaa', 'C changed D''s subscription keys';
end $$;

-- 6. An anonymous visitor can read nothing and call nothing.
select tests.login(null) \gset
do $$
declare t text;
begin
  foreach t in array array['attempts', 'settings', 'push_subscriptions', 'questions', 'scenarios',
                           'bank_meta', 'reminder_log', 'keepalive_log', 'safety_log'] loop
    perform tests.expect_error(format('select * from public.%I', t), '%permission denied%');
  end loop;
  perform tests.expect_error('select public.apply_changes(''[]''::jsonb)', '%permission denied%');
  perform tests.expect_error($q$select public.save_push_subscription('https://push.example.test/a', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1')$q$, '%permission denied%');
  perform tests.expect_error($q$select public.disable_push_subscription('https://push.example.test/a')$q$, '%permission denied%');
  perform tests.expect_error('select public.import_bank(''{}''::jsonb, false)', '%permission denied%');
  perform tests.expect_error('select public.keepalive()', '%permission denied%');
end $$;

rollback;
