-- Checks the test harness itself: the auth shim behaves like Supabase's auth.uid().
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000000a';
begin
  insert into auth.users (id, email) values (a, 'fake-a@example.test');

  perform set_config('request.jwt.claims', '', true);
  assert auth.uid() is null, 'no claims: auth.uid() must be null';

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  assert auth.uid() = a, 'auth.uid() must read the sub claim';
  assert auth.role() = 'authenticated', 'auth.role() must read the role claim';

  assert (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3,
    'the three Supabase roles must exist';
end $$;

-- A failing assert must stop the run (this proves run.sh does not swallow failures).
do $$
begin
  begin
    assert false, 'expected failure';
    raise exception 'assert did not fire';
  exception when assert_failure then
    null; -- expected
  end;
end $$;
