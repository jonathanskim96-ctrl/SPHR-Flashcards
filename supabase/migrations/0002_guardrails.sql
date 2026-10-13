-- SPHR Flashcards, migration 0002: guardrails (BUILD_PLAN Phase 2, CLAUDE.md §1-2).
-- Safety log, append-only answers, no deletes of questions, mass-delete caps, grants and
-- row-level security. Nothing in this file deletes or changes data; the word "delete"
-- appears only in rules that BLOCK deletes (the SQL editor's warning is a false alarm).

-- ---------------------------------------------------------------------------------------
-- Safety log writer.
-- SECURITY DEFINER, approved by the owner (Jonathan) on 2026-10-13 ("option A"): it lets
-- the log record changes made by the app while the app itself has no access to the log.
-- It takes no arguments, can only run as a trigger, and only inserts into safety_log.
create function public.log_change() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $$
begin
  insert into public.safety_log (table_name, op, old_row, new_row, db_user, jwt_sub)
  values (
    tg_table_name,
    tg_op,
    to_jsonb(old),
    case when tg_op = 'UPDATE' then to_jsonb(new) end,
    coalesce(nullif(current_setting('role', true), 'none'), session_user),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  );
  return null;
end $$;

-- Blocks an operation. The only way past it is an owner-approved SQL snippet that sets
-- app.guardrail_override (with a `-- guardrail-approved:` comment) and runs as an admin
-- role; the app's roles can never use the override.
create function public.guard_block() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
begin
  if coalesce(current_setting('app.guardrail_override', true), '') <> ''
     and current_user not in ('anon', 'authenticated') then
    if tg_level = 'ROW' then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    return null;
  end if;
  raise exception '% on % is not allowed (data safety rule, see docs/RECOVERY.md)', tg_op, tg_table_name;
end $$;

-- Refuses deleting more than 5 rows in one statement (same override rule).
create function public.cap_mass_delete() returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  n bigint;
begin
  select count(*) into n from gone;
  if n > 5 and not (
    coalesce(current_setting('app.guardrail_override', true), '') <> ''
    and current_user not in ('anon', 'authenticated')
  ) then
    raise exception 'deleting % rows from % in one statement is not allowed (limit 5)', n, tg_table_name;
  end if;
  return null;
end $$;

-- Every table: log updates and deletes; refuse TRUNCATE.
create trigger log_change after update or delete on public.bank_meta
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.scenarios
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.questions
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.attempts
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.settings
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.push_subscriptions
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.reminder_log
  for each row execute function public.log_change();
create trigger log_change after update or delete on public.keepalive_log
  for each row execute function public.log_change();

create trigger no_truncate before truncate on public.bank_meta
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.scenarios
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.questions
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.attempts
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.settings
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.push_subscriptions
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.reminder_log
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.keepalive_log
  for each statement execute function public.guard_block();
create trigger no_truncate before truncate on public.safety_log
  for each statement execute function public.guard_block();

-- Answers are append-only; the safety log is append-only; questions, scenarios and the
-- bank metadata are never deleted (retire a question instead).
create trigger append_only before update or delete on public.attempts
  for each row execute function public.guard_block();
create trigger append_only before update or delete on public.safety_log
  for each row execute function public.guard_block();
create trigger no_delete before delete on public.questions
  for each row execute function public.guard_block();
create trigger no_delete before delete on public.scenarios
  for each row execute function public.guard_block();
create trigger no_delete before delete on public.bank_meta
  for each row execute function public.guard_block();

create trigger cap_mass_delete after delete on public.settings
  referencing old table as gone
  for each statement execute function public.cap_mass_delete();
create trigger cap_mass_delete after delete on public.push_subscriptions
  referencing old table as gone
  for each statement execute function public.cap_mass_delete();
create trigger cap_mass_delete after delete on public.reminder_log
  referencing old table as gone
  for each statement execute function public.cap_mass_delete();

-- ---------------------------------------------------------------------------------------
-- Privileges. Supabase opens new tables and functions to the API roles by default; close
-- everything, then grant exactly what the app needs. No role used by the app may delete.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke truncate, references, trigger on all tables in schema public from service_role;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant select on public.questions, public.scenarios, public.bank_meta to authenticated;

grant select on public.attempts to authenticated;
grant insert (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
  on public.attempts to authenticated;

grant select on public.settings to authenticated;
grant insert (new_per_day, lesson_size, daily_xp_goal, exam_date, reminder_enabled,
              reminder_time, time_zone)
  on public.settings to authenticated;
grant update (new_per_day, lesson_size, daily_xp_goal, exam_date, reminder_enabled,
              reminder_time, time_zone, version, updated_at)
  on public.settings to authenticated;

grant select on public.push_subscriptions to authenticated;
grant insert (endpoint, p256dh, auth) on public.push_subscriptions to authenticated;
grant update (p256dh, auth, disabled_at) on public.push_subscriptions to authenticated;

-- Used by the settings time-zone check, so the inserting role needs it.
grant execute on function public.is_valid_time_zone(text) to authenticated, service_role;

-- safety_log, reminder_log and keepalive_log: no access for the app's roles at all.

-- ---------------------------------------------------------------------------------------
-- Row-level security, enabled and forced on every table. Each table also has an admin
-- policy for roles other than anon/authenticated (the dashboard's postgres role, the
-- service role), so recovery and the import keep working even with RLS forced.
alter table public.bank_meta enable row level security;
alter table public.bank_meta force row level security;
alter table public.scenarios enable row level security;
alter table public.scenarios force row level security;
alter table public.questions enable row level security;
alter table public.questions force row level security;
alter table public.attempts enable row level security;
alter table public.attempts force row level security;
alter table public.settings enable row level security;
alter table public.settings force row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;
alter table public.reminder_log enable row level security;
alter table public.reminder_log force row level security;
alter table public.keepalive_log enable row level security;
alter table public.keepalive_log force row level security;
alter table public.safety_log enable row level security;
alter table public.safety_log force row level security;

create policy admin_all on public.bank_meta to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.scenarios to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.questions to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.attempts to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.settings to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.push_subscriptions to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.reminder_log to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.keepalive_log to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));
create policy admin_all on public.safety_log to public
  using (current_user not in ('anon', 'authenticated'))
  with check (current_user not in ('anon', 'authenticated'));

create policy read_bank on public.questions for select to authenticated using (true);
create policy read_bank on public.scenarios for select to authenticated using (true);
create policy read_bank on public.bank_meta for select to authenticated using (true);

create policy own_rows_select on public.attempts for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_insert on public.attempts for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy own_rows_select on public.settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_insert on public.settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy own_rows_update on public.settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy own_rows_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy own_rows_update on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
