-- SPHR Flashcards, migration 0004: security audit hardening (docs/SECURITY_AUDIT.md),
-- approved by the owner (Jonathan) on 2026-10-14 ("all recommended options").
-- Additive only: new check functions, triggers and policies. Nothing here changes or
-- deletes any row. The word "delete" may appear in comments only; the SQL editor's
-- "destructive operation" warning is a false alarm for this file.
--
--   L12  answers written straight into the table get the same checks as apply_changes
--        (and at most 200 per statement); a settings update by the app always raises the
--        version, so the stale-write check can't be wound back.
--   L13  push addresses must belong to a real push service; at most 10 active devices.
--   L14  anonymous sign-ins (if ever switched on) can use none of the app's tables.
--   L15  functions made by later migrations are not executable by everyone by default.

-- ---------------------------------------------------------------------------------------
-- L12: answers written directly (not through apply_changes) are checked the same way.
create function public.check_direct_attempt() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  v_problem text;
begin
  if current_user in ('anon', 'authenticated') then
    v_problem := public.attempt_problem(jsonb_build_object(
      'id', new.id::text,
      'questionId', new.question_id,
      'revision', new.revision,
      'answerFp', new.answer_fp,
      'correct', new.correct,
      'xp', new.xp,
      'mode', new.mode,
      'response', new.response,
      'answeredAt', to_char(new.answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ));
    if v_problem is not null then
      raise exception 'answer refused: %', v_problem;
    end if;
  end if;
  return new;
end $$;

create trigger check_direct_attempt before insert on public.attempts
  for each row execute function public.check_direct_attempt();

-- At most 200 answers per statement from the app (the same cap as apply_changes).
create function public.cap_attempt_batch() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  n bigint;
begin
  if current_user in ('anon', 'authenticated') then
    select count(*) into n from added;
    if n > 200 then
      raise exception 'too many answers in one statement (% > 200)', n;
    end if;
  end if;
  return null;
end $$;

create trigger cap_attempt_batch after insert on public.attempts
  referencing new table as added
  for each statement execute function public.cap_attempt_batch();

-- A settings change by the app always moves the version forward by exactly one.
create function public.bump_settings_version() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger bump_settings_version before update on public.settings
  for each row execute function public.bump_settings_version();

-- ---------------------------------------------------------------------------------------
-- L13: push addresses. Same list as src/domain/validate.ts (PUSH_ENDPOINT_RE) and the
-- reminder function: Apple, Google, Mozilla and Microsoft push services, nothing else.
create function public.is_push_endpoint(p_endpoint text) returns boolean
  language sql
  immutable
  security invoker
  set search_path = public, pg_temp
  as $$
  select coalesce(p_endpoint ~ '^https://(([a-z0-9-]+\.)*(push\.apple\.com|notify\.windows\.com)|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)/', false)
$$;

create function public.check_push_subscription() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  n bigint;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and not public.is_push_endpoint(new.endpoint) then
      raise exception 'push address refused: not a known push service';
    end if;
    if new.disabled_at is null
       and (tg_op = 'INSERT' or old.disabled_at is not null) then
      select count(*) into n from public.push_subscriptions
      where user_id = (select auth.uid()) and disabled_at is null and endpoint <> new.endpoint;
      if n >= 10 then
        raise exception 'too many devices with reminders on (limit 10)';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger check_push_subscription before insert or update on public.push_subscriptions
  for each row execute function public.check_push_subscription();

-- ---------------------------------------------------------------------------------------
-- L14: an anonymous sign-in (switched off in the dashboard; this is a second lock) gets
-- nothing. Restrictive policies are added to the existing ones, so they can only narrow.
create policy no_anonymous on public.attempts as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false))
  with check (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));
create policy no_anonymous on public.settings as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false))
  with check (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));
create policy no_anonymous on public.push_subscriptions as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false))
  with check (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));
create policy no_anonymous on public.questions as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));
create policy no_anonymous on public.scenarios as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));
create policy no_anonymous on public.bank_meta as restrictive to authenticated
  using (not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false));

-- ---------------------------------------------------------------------------------------
-- Rights on the new functions: none for the app's roles (triggers call them), except the
-- push-address check, which the app may call.
revoke all on function public.check_direct_attempt(), public.cap_attempt_batch(),
  public.bump_settings_version(), public.check_push_subscription(),
  public.is_push_endpoint(text)
  from public, anon, authenticated;
grant execute on function public.is_push_endpoint(text) to authenticated, service_role;

-- L15: PostgreSQL lets everyone run a new function unless told otherwise; this changes the
-- default for functions made later by the role that runs the migrations. And the service
-- role never gets TRUNCATE, REFERENCES or TRIGGER on tables made later.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public
  revoke truncate, references, trigger on tables from service_role;
