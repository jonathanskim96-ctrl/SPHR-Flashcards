-- The question import (import_bank). Insert/update only; refuses anything that would lose
-- a question or silently change one. Runs in transactions that are rolled back.
\set bank `cat "$ROOT/tests/fixtures/sample-bank.json"`
\set realbank `cat "$ROOT/content/questions.json"`

-- The real bank (read only): a preview on an empty database, then an apply.
begin;
select set_config('tests.bank', :'realbank', true) \gset
select tests.login_service() \gset
do $$
declare r jsonb; b jsonb := current_setting('tests.bank')::jsonb;
begin
  r := public.import_bank(b, false);
  assert r ->> 'applied' = 'false' and r ->> 'new' = '400' and r ->> 'scenarios_new' = '26'
         and r -> 'errors' = '[]'::jsonb, r::text;
  assert (select count(*) from public.questions) = 0, 'a preview must write nothing';
  r := public.import_bank(b, true);
  assert r ->> 'applied' = 'true' and r ->> 'new' = '400', r::text;
  assert (select count(*) from public.questions) = 400;
  assert (select count(*) from public.scenarios) = 26;
  assert (select bank_version from public.bank_meta) = b ->> 'bankVersion';
  assert (select data from public.questions where id = 'lsw1-q13')
         = (select q from jsonb_array_elements(b -> 'questions') q where q ->> 'id' = 'lsw1-q13');
end $$;
rollback;

-- The fake bank: every rule.
begin;
select set_config('tests.bank', :'bank', true) \gset
select tests.login_service() \gset
do $$
declare
  r jsonb;
  b jsonb := current_setting('tests.bank')::jsonb;
  logs bigint;
begin
  -- Dry run changes nothing.
  r := public.import_bank(b, false);
  assert r = jsonb_build_object('applied', false, 'bank_version', '2026-10-13.1', 'new', 19,
    'changed', 0, 'unchanged', 0, 'newly_retired', 0, 'scenarios_new', 1,
    'scenarios_changed', 0, 'errors', '[]'::jsonb), r::text;
  assert (select count(*) from public.questions) = 0 and (select count(*) from public.bank_meta) = 0;

  -- Apply inserts; re-applying the same bank is a no-op (nothing updated or logged).
  r := public.import_bank(b, true);
  assert r ->> 'applied' = 'true' and r ->> 'new' = '19', r::text;
  assert (select count(*) from public.questions) = 19;
  logs := (select count(*) from public.safety_log);
  r := public.import_bank(b, true);
  assert r ->> 'new' = '0' and r ->> 'changed' = '0' and r ->> 'unchanged' = '19'
         and r -> 'errors' = '[]'::jsonb, r::text;
  assert (select count(*) from public.safety_log) = logs, 'a no-op import must not update rows';

  -- A removed question is refused (retire instead).
  r := public.import_bank(tests.bank_without(b, 'fake2-q05', '2026-10-14.1'), true);
  assert r ->> 'applied' = 'false' and r -> 'errors' ? 'question fake2-q05: missing from the new bank (set status "retired" instead of deleting)', r::text;

  -- A removed scenario is refused.
  r := public.import_bank(jsonb_set(b, '{scenarios}', '[]') || '{"bankVersion": "2026-10-14.1"}', true);
  assert r -> 'errors' ? 'scenario fake-sa: missing from the new bank (scenarios are never deleted)', r::text;

  -- A lowered revision is refused.
  r := public.import_bank(tests.bank_patch(b, 'fake1-q05', '{"revision": 1}', '2026-10-14.1'), true);
  assert r -> 'errors' ? 'question fake1-q05: revision 1 is lower than the stored 2', r::text;

  -- Changed content without a raised revision is refused.
  r := public.import_bank(tests.bank_patch(b, 'fake1-q01', '{"stem": "FAKE: changed"}', '2026-10-14.1'), true);
  assert r -> 'errors' ? 'question fake1-q01: content changed but revision was not raised', r::text;

  -- A change without a raised bankVersion is refused; an older bankVersion is refused.
  r := public.import_bank(tests.bank_patch(b, 'fake1-q01', '{"stem": "FAKE: changed", "revision": 2}', '2026-10-13.1'), true);
  assert r -> 'errors' ? 'the bank changed but bankVersion 2026-10-13.1 was not raised', r::text;
  r := public.import_bank(b || '{"bankVersion": "2026-10-12.9"}', true);
  assert r -> 'errors' ? 'bankVersion 2026-10-12.9 is older than the stored 2026-10-13.1', r::text;
  assert (select count(*) from public.safety_log) = logs, 'refused imports must write nothing';

  -- A proper edit (revision raised, version raised) is applied and logged.
  r := public.import_bank(tests.bank_patch(b, 'fake1-q01', '{"stem": "FAKE: changed", "revision": 2}', '2026-10-13.10'), true);
  assert r ->> 'applied' = 'true' and r ->> 'changed' = '1' and r ->> 'unchanged' = '18', r::text;
  assert (select revision from public.questions where id = 'fake1-q01') = 2;
  assert (select bank_version from public.bank_meta) = '2026-10-13.10';
  assert exists (select 1 from public.safety_log where table_name = 'questions' and old_row ->> 'id' = 'fake1-q01');
  b := tests.bank_patch(b, 'fake1-q01', '{"stem": "FAKE: changed", "revision": 2}', '2026-10-13.10');

  -- Retiring needs no revision bump; it is counted.
  r := public.import_bank(tests.bank_patch(b, 'fake2-q05', '{"status": "retired"}', '2026-10-15.1'), true);
  assert r ->> 'applied' = 'true' and r ->> 'changed' = '1' and r ->> 'newly_retired' = '1', r::text;
  assert (select status from public.questions where id = 'fake2-q05') = 'retired';

  -- A bad schemaVersion, a malformed question and duplicate ids are refused.
  r := public.import_bank(b || '{"schemaVersion": 2}', true);
  assert r = '{"applied": false, "errors": ["schemaVersion must be 1"]}'::jsonb, r::text;
  r := public.import_bank(tests.bank_patch(b, 'fake1-q02', '{"type": "essay"}', '2026-10-16.1'), true);
  assert r -> 'errors' ? 'question fake1-q02: malformed', r::text;
  r := public.import_bank(jsonb_set(b, '{questions}', (b -> 'questions') || jsonb_build_array(b -> 'questions' -> 0))
                          || '{"bankVersion": "2026-10-16.1"}', true);
  assert r -> 'errors' ? 'duplicate question ids', r::text;
  r := public.import_bank('[]'::jsonb, false);
  assert r ->> 'applied' = 'false', r::text;
  assert (select count(*) from public.questions) = 19, 'nothing was ever deleted';
end $$;
rollback;
