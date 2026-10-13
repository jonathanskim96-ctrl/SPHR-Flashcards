-- SPHR Flashcards, migration 0003: functions (BUILD_PLAN Phase 2).
-- All are SECURITY INVOKER: they run with the caller's own rights, so the grants and
-- row-level security from 0002 still apply inside them.
-- The validation rules mirror src/domain/validate.ts exactly (tested in Phase 3).

-- Why an answer from the app is invalid, or null if it is valid.
create function public.attempt_problem(a jsonb) returns text
  language plpgsql
  stable
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  r jsonb;
  k text;
  v jsonb;
  t timestamptz;
begin
  if jsonb_typeof(a) is distinct from 'object' then
    return 'attempt must be an object';
  end if;
  if (a - array['id', 'questionId', 'revision', 'answerFp', 'correct', 'xp', 'mode',
                'response', 'answeredAt']) <> '{}'::jsonb then
    return 'unknown field';
  end if;
  if jsonb_typeof(a -> 'id') is distinct from 'string'
     or a ->> 'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'id must be a lowercase uuid';
  end if;
  if jsonb_typeof(a -> 'questionId') is distinct from 'string'
     or length(a ->> 'questionId') > 64
     or a ->> 'questionId' !~ '^[a-z0-9]+(-[a-z0-9]+)+$' then
    return 'questionId has an invalid format';
  end if;
  if jsonb_typeof(a -> 'revision') is distinct from 'number'
     or a ->> 'revision' !~ '^[1-9][0-9]{0,6}$'
     or (a ->> 'revision')::int > 1000000 then
    return 'revision must be a whole number >= 1';
  end if;
  if jsonb_typeof(a -> 'answerFp') is distinct from 'string'
     or a ->> 'answerFp' !~ '^[0-9a-f]{16}$' then
    return 'answerFp must be 16 hex characters';
  end if;
  if jsonb_typeof(a -> 'correct') is distinct from 'boolean' then
    return 'correct must be true or false';
  end if;
  if jsonb_typeof(a -> 'xp') is distinct from 'number' or a ->> 'xp' !~ '^[0-3]$' then
    return 'xp must be a whole number from 0 to 3';
  end if;
  if a -> 'correct' = 'false'::jsonb and a ->> 'xp' <> '0' then
    return 'a wrong answer earns 0 xp';
  end if;
  if jsonb_typeof(a -> 'mode') is distinct from 'string'
     or a ->> 'mode' not in ('lesson', 'mistakes', 'ahead') then
    return 'mode is invalid';
  end if;

  r := a -> 'response';
  if jsonb_typeof(r) is distinct from 'object' then
    return 'response has the wrong shape for its type';
  end if;
  if not (case r ->> 'type'
    when 'mc' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['choice', 'type']
      and jsonb_typeof(r -> 'choice') = 'string' and octet_length(r ->> 'choice') <= 64
    when 'multi' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['choices', 'type']
      and jsonb_typeof(r -> 'choices') = 'array' and jsonb_array_length(r -> 'choices') <= 20
      and not exists (select 1 from jsonb_array_elements(r -> 'choices') e
                      where jsonb_typeof(e) <> 'string' or octet_length(e #>> '{}') > 64)
    when 'ordering' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['order', 'type']
      and jsonb_typeof(r -> 'order') = 'array' and jsonb_array_length(r -> 'order') <= 20
      and not exists (select 1 from jsonb_array_elements(r -> 'order') e
                      where jsonb_typeof(e) <> 'string' or octet_length(e #>> '{}') > 64)
    when 'numeric' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['input', 'type']
      and jsonb_typeof(r -> 'input') = 'string'
    when 'text' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['input', 'type']
      and jsonb_typeof(r -> 'input') = 'string'
    when 'matching' then
      (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['pairs', 'type']
      and jsonb_typeof(r -> 'pairs') = 'object'
      and (select count(*) from jsonb_object_keys(r -> 'pairs')) <= 20
      and not exists (select 1 from jsonb_each(r -> 'pairs') p
                      where octet_length(p.key) > 64 or jsonb_typeof(p.value) <> 'string'
                         or octet_length(p.value #>> '{}') > 64)
    else false
  end) then
    return 'response has the wrong shape for its type';
  end if;
  if octet_length(r::text) > 2048 then
    return 'response is larger than 2048 bytes';
  end if;

  if jsonb_typeof(a -> 'answeredAt') is distinct from 'string'
     or a ->> 'answeredAt' !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    return 'answeredAt must be an ISO timestamp';
  end if;
  begin
    t := (a ->> 'answeredAt')::timestamptz; -- an impossible date such as 02-30 is an error
  exception when others then
    return 'answeredAt must be an ISO timestamp';
  end;
  if t > now() + interval '1 day' then
    return 'answeredAt is more than 1 day in the future';
  end if;
  return null;
end $$;

-- Why settings from the app are invalid, or null if they are valid.
create function public.settings_problem(s jsonb) returns text
  language plpgsql
  stable
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  d date;
begin
  if jsonb_typeof(s) is distinct from 'object' then
    return 'settings must be an object';
  end if;
  if (select array_agg(x order by x) from jsonb_object_keys(s) x)
     <> array['dailyXpGoal', 'examDate', 'lessonSize', 'newPerDay', 'reminderEnabled',
              'reminderTime', 'timeZone'] then
    return 'settings must have exactly the known fields';
  end if;
  if jsonb_typeof(s -> 'newPerDay') <> 'number' or s ->> 'newPerDay' !~ '^[0-9]{1,3}$'
     or (s ->> 'newPerDay')::int not between 1 and 50 then
    return 'newPerDay must be a whole number from 1 to 50';
  end if;
  if jsonb_typeof(s -> 'lessonSize') <> 'number' or s ->> 'lessonSize' !~ '^[0-9]{1,3}$'
     or (s ->> 'lessonSize')::int not between 5 and 30 then
    return 'lessonSize must be a whole number from 5 to 30';
  end if;
  if jsonb_typeof(s -> 'dailyXpGoal') <> 'number' or s ->> 'dailyXpGoal' !~ '^[0-9]{1,3}$'
     or (s ->> 'dailyXpGoal')::int not between 5 and 200 then
    return 'dailyXpGoal must be a whole number from 5 to 200';
  end if;
  if jsonb_typeof(s -> 'examDate') <> 'string' or s ->> 'examDate' !~ '^\d{4}-\d{2}-\d{2}$' then
    return 'examDate must be a real date from 2000-01-01 to 2100-12-31';
  end if;
  begin
    d := (s ->> 'examDate')::date;
  exception when others then
    return 'examDate must be a real date from 2000-01-01 to 2100-12-31';
  end;
  if d not between '2000-01-01' and '2100-12-31' then
    return 'examDate must be a real date from 2000-01-01 to 2100-12-31';
  end if;
  if jsonb_typeof(s -> 'reminderEnabled') <> 'boolean' then
    return 'reminderEnabled must be true or false';
  end if;
  if jsonb_typeof(s -> 'reminderTime') <> 'string'
     or s ->> 'reminderTime' !~ '^([01]\d|2[0-3]):(00|15|30|45)$' then
    return 'reminderTime must be HH:MM in 15-minute steps';
  end if;
  if jsonb_typeof(s -> 'timeZone') <> 'string' or length(s ->> 'timeZone') > 64
     or not public.is_valid_time_zone(s ->> 'timeZone') then
    return 'timeZone must be a real IANA time zone';
  end if;
  return null;
end $$;

-- A settings row as the app sees it (camelCase, plus the version).
create function public.settings_json(s public.settings) returns jsonb
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
  as $$
  select jsonb_build_object(
    'newPerDay', s.new_per_day,
    'lessonSize', s.lesson_size,
    'dailyXpGoal', s.daily_xp_goal,
    'examDate', to_char(s.exam_date, 'YYYY-MM-DD'),
    'reminderEnabled', s.reminder_enabled,
    'reminderTime', to_char(s.reminder_time, 'HH24:MI'),
    'timeZone', s.time_zone,
    'version', s.version
  )
$$;

-- The app's one write path. Saves a batch of answers (idempotent: an answer already saved
-- is counted as a duplicate) and, optionally, settings with a stale-write check.
create function public.apply_changes(
  p_attempts jsonb default '[]'::jsonb,
  p_settings jsonb default null,
  p_settings_base_version int default null
) returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid();
  v_valid jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_inserted int := 0;
  v_problem text;
  v_settings_error text;
  v_settings_version int;
  v_conflict boolean := false;
  v_server jsonb;
  v_current int;
  v_row public.settings;
  a jsonb;
  i int := 0;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  p_attempts := coalesce(p_attempts, '[]'::jsonb);
  if jsonb_typeof(p_attempts) <> 'array' then
    raise exception 'p_attempts must be an array';
  end if;
  if jsonb_array_length(p_attempts) > 200 then
    raise exception 'too many answers in one call (% > 200)', jsonb_array_length(p_attempts);
  end if;

  for a in select value from jsonb_array_elements(p_attempts) loop
    v_problem := public.attempt_problem(a);
    if v_problem is null then
      v_valid := v_valid || jsonb_build_array(a);
    else
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object(
        'index', i,
        'id', case when jsonb_typeof(a) = 'object' then a ->> 'id' end,
        'reason', v_problem));
    end if;
    i := i + 1;
  end loop;

  insert into public.attempts
    (id, question_id, revision, answer_fp, correct, xp, mode, response, answered_at)
  select (x ->> 'id')::uuid, x ->> 'questionId', (x ->> 'revision')::int, x ->> 'answerFp',
         (x ->> 'correct')::boolean, (x ->> 'xp')::smallint, x ->> 'mode', x -> 'response',
         (x ->> 'answeredAt')::timestamptz
  from jsonb_array_elements(v_valid) x
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  if p_settings is not null then
    v_settings_error := public.settings_problem(p_settings);
  end if;
  if p_settings is not null and v_settings_error is null then
    select version into v_current from public.settings where user_id = v_uid for update;
    if not found then
      insert into public.settings (new_per_day, lesson_size, daily_xp_goal, exam_date,
                                   reminder_enabled, reminder_time, time_zone)
      values ((p_settings ->> 'newPerDay')::int, (p_settings ->> 'lessonSize')::int,
              (p_settings ->> 'dailyXpGoal')::int, (p_settings ->> 'examDate')::date,
              (p_settings ->> 'reminderEnabled')::boolean, (p_settings ->> 'reminderTime')::time,
              p_settings ->> 'timeZone')
      on conflict (user_id) do nothing;
      v_conflict := not found;
    elsif v_current is not distinct from p_settings_base_version then
      update public.settings set
        new_per_day = (p_settings ->> 'newPerDay')::int,
        lesson_size = (p_settings ->> 'lessonSize')::int,
        daily_xp_goal = (p_settings ->> 'dailyXpGoal')::int,
        exam_date = (p_settings ->> 'examDate')::date,
        reminder_enabled = (p_settings ->> 'reminderEnabled')::boolean,
        reminder_time = (p_settings ->> 'reminderTime')::time,
        time_zone = p_settings ->> 'timeZone',
        version = version + 1,
        updated_at = now()
      where user_id = v_uid;
    else
      v_conflict := true;
    end if;
  end if;

  select * into v_row from public.settings where user_id = v_uid;
  if found then
    v_settings_version := v_row.version;
    if v_conflict then
      v_server := public.settings_json(v_row);
    end if;
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'duplicates', jsonb_array_length(v_valid) - v_inserted,
    'rejected', v_rejected,
    'settings_version', v_settings_version,
    'settings_conflict', v_conflict,
    'server_settings', v_server,
    'settings_error', v_settings_error,
    'max_seq', (select max(seq) from public.attempts where user_id = v_uid)
  );
end $$;

-- Save (or refresh) this device's push subscription. Re-enables a disabled one.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
  returns uuid
  language plpgsql
  volatile
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth)
  values (p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, disabled_at = null
  returning id into v_id;
  return v_id;
end $$;

-- Turn off reminders for this device. Never deletes; returns false if nothing matched.
create function public.disable_push_subscription(p_endpoint text) returns boolean
  language plpgsql
  volatile
  security invoker
  set search_path = public, pg_temp
  as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  update public.push_subscriptions set disabled_at = now()
  where endpoint = p_endpoint and user_id = auth.uid() and disabled_at is null;
  return found;
end $$;

-- 'YYYY-MM-DD.n' as a comparable key.
create function public.bank_version_key(v text) returns text
  language sql
  immutable
  security invoker
  set search_path = public, pg_temp
  as $$ select split_part(v, '.', 1) || '.' || lpad(split_part(v, '.', 2), 12, '0') $$;

-- The question import (service role only; run by the "Import questions" workflow).
-- Insert/update only, never deletes. Refuses: a question or scenario that disappeared
-- (retire instead), a lowered revision, a content change without a raised revision, an
-- unchanged or lower bankVersion when anything changed. With p_apply = false nothing is
-- written. Any error means nothing is written. One call = one transaction.
create function public.import_bank(p_bank jsonb, p_apply boolean default false) returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = public, pg_temp
  as $$
declare
  v_errors text[] := '{}';
  v_new int := 0;
  v_changed int := 0;
  v_unchanged int := 0;
  v_retired int := 0;
  v_scen_new int := 0;
  v_scen_changed int := 0;
  v_version text := p_bank ->> 'bankVersion';
  v_meta public.bank_meta;
  v_meta_changed boolean;
  v_applied boolean := false;
  v_old public.questions;
  v_old_scen public.scenarios;
  q jsonb;
  s jsonb;
  v_id text;
  v_missing text;
begin
  if jsonb_typeof(p_bank) is distinct from 'object' or p_bank -> 'schemaVersion' is distinct from '1'::jsonb then
    v_errors := v_errors || 'schemaVersion must be 1'::text;
  end if;
  if v_version is null or v_version !~ '^\d{4}-\d{2}-\d{2}\.\d{1,12}$' then
    v_errors := v_errors || 'bankVersion must look like YYYY-MM-DD.n'::text;
  end if;
  if jsonb_typeof(p_bank -> 'questions') is distinct from 'array'
     or jsonb_typeof(p_bank -> 'scenarios') is distinct from 'array'
     or jsonb_typeof(p_bank -> 'areas') is distinct from 'array'
     or jsonb_typeof(p_bank -> 'levels') is distinct from 'object' then
    v_errors := v_errors || 'questions, scenarios, areas and levels are required'::text;
  end if;
  if cardinality(v_errors) > 0 then
    return jsonb_build_object('applied', false, 'errors', to_jsonb(v_errors));
  end if;

  -- Scenarios.
  for s in select value from jsonb_array_elements(p_bank -> 'scenarios') loop
    v_id := s ->> 'id';
    if jsonb_typeof(s) <> 'object' or v_id is null or v_id !~ '^[a-z0-9]+(-[a-z0-9]+)+$'
       or length(v_id) > 64 or s ->> 'area' !~ '^[1-5]$' or octet_length(s::text) > 16384 then
      v_errors := v_errors || format('scenario %s: malformed', coalesce(v_id, '?'));
      continue;
    end if;
    select * into v_old_scen from public.scenarios where id = v_id;
    if not found then
      v_scen_new := v_scen_new + 1;
    elsif v_old_scen.data <> s then
      v_scen_changed := v_scen_changed + 1;
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_bank -> 'scenarios'))
     <> (select count(distinct value ->> 'id') from jsonb_array_elements(p_bank -> 'scenarios')) then
    v_errors := v_errors || 'duplicate scenario ids'::text;
  end if;
  for v_missing in
    select id from public.scenarios
    where id not in (select value ->> 'id' from jsonb_array_elements(p_bank -> 'scenarios')
                     where value ->> 'id' is not null)
    order by id
  loop
    v_errors := v_errors || format('scenario %s: missing from the new bank (scenarios are never deleted)', v_missing);
  end loop;

  -- Questions.
  for q in select value from jsonb_array_elements(p_bank -> 'questions') loop
    v_id := q ->> 'id';
    if jsonb_typeof(q) <> 'object' or v_id is null or v_id !~ '^[a-z0-9]+(-[a-z0-9]+)+$'
       or length(v_id) > 64
       or jsonb_typeof(q -> 'revision') <> 'number' or q ->> 'revision' !~ '^[1-9][0-9]{0,8}$'
       or q ->> 'status' not in ('active', 'retired')
       or q ->> 'area' !~ '^[1-5]$'
       or q ->> 'level' not in ('K', 'A', 'S')
       or q ->> 'type' not in ('mc', 'multi', 'numeric', 'text', 'ordering', 'matching')
       or octet_length(q::text) > 16384 then
      v_errors := v_errors || format('question %s: malformed', coalesce(v_id, '?'));
      continue;
    end if;
    select * into v_old from public.questions where id = v_id;
    if not found then
      v_new := v_new + 1;
    elsif (q ->> 'revision')::int < v_old.revision then
      v_errors := v_errors || format('question %s: revision %s is lower than the stored %s',
                                     v_id, q ->> 'revision', v_old.revision);
    elsif v_old.data = q then
      v_unchanged := v_unchanged + 1;
    elsif (q ->> 'revision')::int = v_old.revision
          and (v_old.data - 'status') <> (q - 'status') then
      v_errors := v_errors || format('question %s: content changed but revision was not raised', v_id);
    else
      -- A changed revision, or only the status changed (retiring needs no revision bump).
      v_changed := v_changed + 1;
      if v_old.status = 'active' and q ->> 'status' = 'retired' then
        v_retired := v_retired + 1;
      end if;
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_bank -> 'questions'))
     <> (select count(distinct value ->> 'id') from jsonb_array_elements(p_bank -> 'questions')) then
    v_errors := v_errors || 'duplicate question ids'::text;
  end if;
  for v_missing in
    select id from public.questions
    where id not in (select value ->> 'id' from jsonb_array_elements(p_bank -> 'questions')
                     where value ->> 'id' is not null)
    order by id
  loop
    v_errors := v_errors || format('question %s: missing from the new bank (set status "retired" instead of deleting)', v_missing);
  end loop;

  -- Bank version.
  select * into v_meta from public.bank_meta where id = 1;
  v_meta_changed := v_meta.id is null
    or v_meta.areas <> p_bank -> 'areas' or v_meta.levels <> p_bank -> 'levels'
    or v_meta.bank_version <> v_version;
  if v_meta.id is not null and cardinality(v_errors) = 0 then
    if public.bank_version_key(v_version) < public.bank_version_key(v_meta.bank_version) then
      v_errors := v_errors || format('bankVersion %s is older than the stored %s', v_version, v_meta.bank_version);
    elsif public.bank_version_key(v_version) = public.bank_version_key(v_meta.bank_version)
          and (v_new + v_changed + v_scen_new + v_scen_changed > 0 or v_meta_changed) then
      v_errors := v_errors || format('the bank changed but bankVersion %s was not raised', v_version);
    end if;
  end if;

  if p_apply and cardinality(v_errors) = 0 then
    insert into public.scenarios (id, area, data)
    select value ->> 'id', (value ->> 'area')::smallint, value
    from jsonb_array_elements(p_bank -> 'scenarios')
    on conflict (id) do update
      set area = excluded.area, data = excluded.data, updated_at = now()
      where scenarios.data <> excluded.data;

    insert into public.questions (id, revision, status, area, level, type, data)
    select value ->> 'id', (value ->> 'revision')::int, value ->> 'status',
           (value ->> 'area')::smallint, value ->> 'level', value ->> 'type', value
    from jsonb_array_elements(p_bank -> 'questions')
    on conflict (id) do update
      set revision = excluded.revision, status = excluded.status, area = excluded.area,
          level = excluded.level, type = excluded.type, data = excluded.data, updated_at = now()
      where questions.data <> excluded.data;

    if v_meta_changed then
      insert into public.bank_meta (id, schema_version, bank_version, areas, levels)
      values (1, 1, v_version, p_bank -> 'areas', p_bank -> 'levels')
      on conflict (id) do update
        set bank_version = excluded.bank_version, areas = excluded.areas,
            levels = excluded.levels, updated_at = now();
    end if;
    v_applied := true;
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'bank_version', v_version,
    'new', v_new,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'newly_retired', v_retired,
    'scenarios_new', v_scen_new,
    'scenarios_changed', v_scen_changed,
    'errors', to_jsonb(v_errors)
  );
end $$;

-- Daily keep-alive (service role only): one small write so the free project stays awake.
create function public.keepalive() returns bigint
  language sql
  volatile
  security invoker
  set search_path = public, pg_temp
  as $$
  insert into public.keepalive_log default values;
  select count(*) from public.keepalive_log;
$$;

-- Execute rights: nothing by default, then exactly what each role needs.
revoke all on function public.attempt_problem(jsonb), public.settings_problem(jsonb),
  public.settings_json(public.settings), public.apply_changes(jsonb, jsonb, int),
  public.save_push_subscription(text, text, text), public.disable_push_subscription(text),
  public.bank_version_key(text), public.import_bank(jsonb, boolean), public.keepalive()
  from public, anon, authenticated, service_role;

grant execute on function public.apply_changes(jsonb, jsonb, int),
  public.save_push_subscription(text, text, text), public.disable_push_subscription(text),
  public.attempt_problem(jsonb), public.settings_problem(jsonb),
  public.settings_json(public.settings)
  to authenticated;
grant execute on function public.import_bank(jsonb, boolean), public.keepalive(),
  public.bank_version_key(text), public.attempt_problem(jsonb), public.settings_problem(jsonb),
  public.settings_json(public.settings)
  to service_role;
