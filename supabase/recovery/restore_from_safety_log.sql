-- guardrail-approved: PASTE_WHO_DATE_WHY
-- Puts rows back the way they were just BEFORE a time window, for rows changed or deleted
-- INSIDE the window (RECOVERY.md §5). Run only after the owner approved this exact restore.
-- It never deletes anything. Rows changed again after the window are left alone (listed as
-- skipped), and answers (attempts) are never touched: they are restored by importing an
-- export file in the app.
--
-- Fill in the three PASTE_ values (keep the quotes). Times are UTC, e.g. 2026-11-02 14:00:00+00
-- PASTE_DRY_RUN: 'true' only lists what would happen; 'false' restores.
begin;

create temp table recovery_window on commit drop as
select timestamptz 'PASTE_FROM_TIME' as from_at,
       timestamptz 'PASTE_TO_TIME' as to_at,
       'PASTE_DRY_RUN'::boolean as dry_run;

create temp table recovery_result (table_name text, row_key text, action text) on commit drop;

do $$
declare
  w record;
  t record;
  c record;
  cols text;
  cur jsonb;
  action text;
begin
  select * into w from recovery_window;
  if w.to_at <= w.from_at then
    raise exception 'the end of the window must be after the start';
  end if;

  for t in select * from (values ('bank_meta', 'id'), ('scenarios', 'id'), ('questions', 'id'),
                                 ('settings', 'user_id'), ('push_subscriptions', 'id')) v(name, pk) loop
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
    where table_schema = 'public' and table_name = t.name and is_generated = 'NEVER'
      and coalesce(identity_generation, '') <> 'ALWAYS';

    for c in
      select l.old_row ->> t.pk as row_key,
             (array_agg(l.old_row order by l.at, l.id))[1] as before_row,
             (array_agg(l.op order by l.at desc, l.id desc))[1] as last_op
      from public.safety_log l
      where l.table_name = t.name and l.at >= w.from_at and l.at < w.to_at
      group by 1
      order by 1
    loop
      execute format('select to_jsonb(x) from public.%I x where x.%I::text = $1', t.name, t.pk)
        into cur using c.row_key;
      if exists (select 1 from public.safety_log l
                 where l.table_name = t.name and l.old_row ->> t.pk = c.row_key and l.at >= w.to_at) then
        action := 'skipped: changed again after the window';
      elsif cur is null then
        action := 'restored (put back)';
        if not w.dry_run then
          execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
                         t.name, cols, cols, t.name) using c.before_row;
        end if;
      elsif c.last_op = 'DELETE' then
        action := 'skipped: re-created after the window';
      elsif cur = c.before_row then
        action := 'skipped: already as before';
      else
        action := 'restored (changed back)';
        if not w.dry_run then
          execute format('update public.%I x set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where x.%I::text = $2',
                         t.name, cols, cols, t.name, t.pk) using c.before_row, c.row_key;
        end if;
      end if;
      insert into recovery_result values (t.name, c.row_key,
        case when w.dry_run then 'WOULD BE ' || action else action end);
    end loop;
  end loop;
end $$;

select table_name, row_key, action from recovery_result order by table_name, row_key;
select case when (select dry_run from recovery_window) then 'DRY RUN, nothing changed. ' else '' end
       || 'restored: ' || coalesce((select string_agg(table_name || ' ' || n, ', ' order by table_name)
          from (select table_name, count(*) n from recovery_result
                where action like '%restored%' group by table_name) s), 'nothing') as summary;

commit;
