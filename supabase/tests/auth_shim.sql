-- A small stand-in for the parts of Supabase the migrations rely on, so they can be tested
-- on a plain local PostgreSQL. Never run this on the real Supabase project.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);

-- Same contract as Supabase: the caller's id comes from the JWT claims set per request.
create function auth.jwt() returns jsonb
  language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

create function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;

create function auth.role() returns text
  language sql stable
  as $$ select auth.jwt() ->> 'role' $$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Like Supabase: new tables and functions in `public` are open to the API roles by default,
-- so the migrations must revoke what they don't want exposed (and the tests prove they do).
-- `migrator` stands in for Supabase's `postgres` role, which is not a superuser.
create role migrator login nosuperuser nobypassrls;
grant usage, create on schema public to migrator;
grant usage on schema auth to migrator;
grant select, references on auth.users to migrator;
grant anon, authenticated, service_role to migrator;
alter default privileges for role migrator in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role migrator in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role migrator in schema public
  grant all on functions to anon, authenticated, service_role;

-- Test helpers (not part of the app). Security invoker: statements run as the current role.
create schema tests;
grant usage on schema tests to anon, authenticated, service_role, migrator;

-- Runs `sql` and fails unless it raises an error whose message matches `pattern` (ILIKE).
create function tests.expect_error(sql text, pattern text) returns void
  language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm ilike pattern then
      return;
    end if;
    raise exception 'expected error like "%" from [%], got: %', pattern, sql, sqlerrm;
  end;
  raise exception 'expected error like "%" but [%] succeeded', pattern, sql;
end $$;

-- Act as a signed-in user (or anon when uid is null) for the rest of the transaction.
create function tests.login(uid uuid) returns void
  language plpgsql as $$
begin
  if uid is null then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

create function tests.login_service() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

grant execute on all functions in schema tests to anon, authenticated, service_role, migrator;

-- An answer as the app sends it to apply_changes. `n` picks the uuid.
create function tests.att(n int, question text default 'fake1-q01', correct boolean default true,
                          xp int default 1, answered_at text default '2026-10-13T20:00:00.000Z')
  returns jsonb language sql as $$
  select jsonb_build_object(
    'id', format('00000000-0000-4000-8000-%s', lpad(to_hex(n), 12, '0')),
    'questionId', question, 'revision', 1, 'answerFp', '0123456789abcdef',
    'correct', correct, 'xp', xp, 'mode', 'lesson',
    'response', jsonb_build_object('type', 'mc', 'choice', 'A'),
    'answeredAt', answered_at)
$$;

create function tests.settings(lesson_size int default 10) returns jsonb language sql as $$
  select jsonb_build_object('newPerDay', 15, 'lessonSize', lesson_size, 'dailyXpGoal', 30,
    'examDate', '2026-12-15', 'reminderEnabled', false, 'reminderTime', '15:00',
    'timeZone', 'America/Los_Angeles')
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role, migrator;

-- Bank edits for the import tests.
create function tests.bank_patch(bank jsonb, qid text, patch jsonb, version text) returns jsonb
  language sql as $$
  select jsonb_set(bank, '{questions}', (
    select jsonb_agg(case when q ->> 'id' = qid then q || patch else q end order by i)
    from jsonb_array_elements(bank -> 'questions') with ordinality as x(q, i)))
    || jsonb_build_object('bankVersion', version)
$$;
create function tests.bank_without(bank jsonb, qid text, version text) returns jsonb
  language sql as $$
  select jsonb_set(bank, '{questions}', (
    select jsonb_agg(q order by i) from jsonb_array_elements(bank -> 'questions') with ordinality as x(q, i)
    where q ->> 'id' <> qid))
    || jsonb_build_object('bankVersion', version)
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role, migrator;
