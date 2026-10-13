-- The daily reminder sender (supabase/functions/send-reminders, Phase 7) runs as the service
-- role through PostgREST. This checks, statement for statement, that every read and write it
-- makes works for the service role, that the app's own roles still cannot make them, that the
-- one-reminder-per-day key holds, and that its updates land in the safety log.
-- Runs in one transaction and is rolled back.
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a7', 'fake-a7@example.test'),
  ('00000000-0000-4000-8000-0000000000b7', 'fake-b7@example.test');

-- Michelle (a7) turns the reminder on and saves this phone; b7 has the reminder off.
select tests.login('00000000-0000-4000-8000-0000000000a7') \gset
do $$ begin
  perform public.apply_changes('[]'::jsonb,
    tests.settings() || '{"reminderEnabled": true, "reminderTime": "15:00"}'::jsonb, null);
  perform public.save_push_subscription('https://push.example.test/a7-phone', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  perform public.save_push_subscription('https://push.example.test/a7-ipad', 'BPkbbbbbbbbbbbbbbbbb', 'authsecret2');
  perform public.disable_push_subscription('https://push.example.test/a7-ipad');

  -- The app can never touch the log or the server's bookkeeping columns.
  perform tests.expect_error($q$select * from public.reminder_log$q$, '%permission denied%');
  perform tests.expect_error($q$insert into public.reminder_log (user_id, local_date) values (auth.uid(), '2026-10-13')$q$, '%permission denied%');
  perform tests.expect_error($q$update public.push_subscriptions set last_success_at = now()$q$, '%permission denied%');
  perform tests.expect_error($q$update public.push_subscriptions set failure_count = 1$q$, '%permission denied%');
end $$;
reset role;
select tests.login('00000000-0000-4000-8000-0000000000b7') \gset
do $$ begin
  perform public.apply_changes('[]'::jsonb, tests.settings(), null);
end $$;
reset role;
-- An anonymous caller sees nothing at all.
select tests.login(null) \gset
do $$ begin
  perform tests.expect_error($q$select * from public.reminder_log$q$, '%permission denied%');
  perform tests.expect_error($q$select * from public.push_subscriptions$q$, '%permission denied%');
  perform tests.expect_error($q$select * from public.settings$q$, '%permission denied%');
end $$;
reset role;

select tests.login_service() \gset
do $$
declare
  v_rows int;
  v_dev uuid;
  v_logged int;
begin
  -- enabledReminders(): GET settings?select=user_id,reminder_time,time_zone&reminder_enabled=eq.true
  select count(*) into v_rows from (
    select user_id, reminder_time, time_zone from public.settings where reminder_enabled = true) t;
  assert v_rows = 1, format('expected only the account with the reminder on, got %s', v_rows);
  assert (select to_char(reminder_time, 'HH24:MI') || '|' || time_zone from public.settings
          where reminder_enabled) = '15:00|America/Los_Angeles', 'reminder time and zone read back';

  -- activeDevices(): GET push_subscriptions?select=...&user_id=eq.<id>&disabled_at=is.null
  select count(*) into v_rows from (
    select id, endpoint, p256dh, auth, failure_count from public.push_subscriptions
    where user_id = '00000000-0000-4000-8000-0000000000a7' and disabled_at is null) t;
  assert v_rows = 1, format('expected one active device (the iPad is disabled), got %s', v_rows);
  select id into v_dev from public.push_subscriptions where endpoint = 'https://push.example.test/a7-phone';

  -- claimDay(): POST reminder_log; a second claim for the same local date is refused (23505).
  insert into public.reminder_log (user_id, local_date)
    values ('00000000-0000-4000-8000-0000000000a7', '2026-10-13');
  begin
    insert into public.reminder_log (user_id, local_date)
      values ('00000000-0000-4000-8000-0000000000a7', '2026-10-13');
    raise exception 'a second reminder for the same day was accepted';
  exception when unique_violation then
    null; -- PostgREST answers 409 with code 23505; the function reads that as "already sent"
  end;
  insert into public.reminder_log (user_id, local_date)
    values ('00000000-0000-4000-8000-0000000000a7', '2026-10-14');

  -- markSent / markFailed / markGone: PATCH push_subscriptions?id=eq.<id>
  update public.push_subscriptions set last_success_at = now() where id = v_dev;
  update public.push_subscriptions set failure_count = 1 where id = v_dev;
  update public.push_subscriptions set disabled_at = now() where id = v_dev;
  assert (select disabled_at is not null and failure_count = 1 and last_success_at is not null
          from public.push_subscriptions where id = v_dev), 'device updates stuck';

  -- The function never deletes (a gone device is disabled); nothing may truncate.
  perform tests.expect_error($q$truncate public.reminder_log$q$, '%permission denied%');
end $$;
reset role;

-- Every one of those updates is in the safety log, with the old row.
do $$ begin
  assert (select count(*) from public.safety_log
          where table_name = 'push_subscriptions' and op = 'UPDATE'
            and old_row ->> 'endpoint' = 'https://push.example.test/a7-phone'
            and db_user = 'service_role') = 3,
    'the three service-role updates were not logged';
end $$;

-- The phone opens the app again: save_push_subscription re-enables the device.
select tests.login('00000000-0000-4000-8000-0000000000a7') \gset
do $$ begin
  perform public.save_push_subscription('https://push.example.test/a7-phone', 'BPkaaaaaaaaaaaaaaaaa', 'authsecret1');
  assert (select disabled_at is null from public.push_subscriptions
          where endpoint = 'https://push.example.test/a7-phone'), 're-saving re-enables the device';
end $$;
reset role;
rollback;
