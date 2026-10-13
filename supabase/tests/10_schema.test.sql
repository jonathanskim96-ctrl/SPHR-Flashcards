-- Structural guardrails that every table and function must keep, including future ones
-- (CLAUDE.md §2): RLS enabled and forced, a safety-log trigger, TRUNCATE blocked, no
-- access for anon, no DELETE for the app, functions locked to a search_path, and no
-- SECURITY DEFINER except the owner-approved safety-log writer.
do $$
declare
  r record;
  t text;
begin
  for r in select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' loop
    assert r.relrowsecurity and r.relforcerowsecurity, format('RLS not enabled+forced on %s', r.relname);
    assert exists (select 1 from pg_trigger t where t.tgrelid = ('public.' || r.relname)::regclass
                   and t.tgname = 'no_truncate'), format('%s: TRUNCATE is not blocked', r.relname);
    assert r.relname = 'safety_log' or exists (
      select 1 from pg_trigger t where t.tgrelid = ('public.' || r.relname)::regclass and t.tgname = 'log_change'),
      format('%s: changes are not copied to safety_log', r.relname);
    assert not has_table_privilege('anon', 'public.' || r.relname, 'select, insert, update, delete, truncate, references, trigger'),
      format('anon has a privilege on %s', r.relname);
    assert not has_table_privilege('authenticated', 'public.' || r.relname, 'delete, truncate, references, trigger'),
      format('authenticated may delete/truncate %s', r.relname);
    assert not has_table_privilege('service_role', 'public.' || r.relname, 'truncate, references, trigger'),
      format('service_role may truncate %s', r.relname);
  end loop;

  foreach t in array array['safety_log', 'reminder_log', 'keepalive_log'] loop
    assert not has_table_privilege('authenticated', 'public.' || t, 'select, insert, update'),
      format('authenticated can access %s', t);
  end loop;
  assert not has_table_privilege('authenticated', 'public.questions', 'insert, update'), 'app can write questions';
  assert not has_table_privilege('authenticated', 'public.scenarios', 'insert, update'), 'app can write scenarios';
  assert not has_table_privilege('authenticated', 'public.bank_meta', 'insert, update'), 'app can write bank_meta';
  assert not has_table_privilege('authenticated', 'public.attempts', 'update'), 'app can update attempts';
  assert not has_column_privilege('authenticated', 'public.attempts', 'user_id', 'insert'), 'app can set attempts.user_id';
  assert not has_column_privilege('authenticated', 'public.settings', 'user_id', 'insert, update'), 'app can set settings.user_id';
  assert not has_column_privilege('authenticated', 'public.push_subscriptions', 'user_id', 'insert, update'), 'app can set push user_id';
  assert not has_column_privilege('authenticated', 'public.push_subscriptions', 'failure_count', 'update'), 'app can edit failure_count';

  for r in select p.proname, p.prosecdef, p.proconfig, p.oid
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' loop
    assert not r.prosecdef or r.proname = 'log_change',
      format('function %s is SECURITY DEFINER without owner sign-off', r.proname);
    assert exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%'),
      format('function %s has no fixed search_path', r.proname);
    assert not has_function_privilege('anon', r.oid, 'execute'), format('anon can execute %s', r.proname);
  end loop;

  foreach t in array array['import_bank', 'keepalive', 'log_change', 'guard_block', 'cap_mass_delete', 'bank_version_key'] loop
    assert not exists (select 1 from pg_proc p where p.proname = t
                       and has_function_privilege('authenticated', p.oid, 'execute')),
      format('authenticated can execute %s', t);
  end loop;
  foreach t in array array['apply_changes', 'save_push_subscription', 'disable_push_subscription'] loop
    assert exists (select 1 from pg_proc p where p.proname = t
                   and has_function_privilege('authenticated', p.oid, 'execute')),
      format('authenticated cannot execute %s', t);
  end loop;
end $$;
