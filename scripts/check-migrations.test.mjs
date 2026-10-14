import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrations, findUnapproved } from './check-migrations.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'mig-'));
const write = (dir, name, sql) => writeFileSync(join(dir, name), sql);
const lock = (dir) => JSON.parse(readFileSync(join(dir, 'migrations.lock.json'), 'utf8'));

function recorded() {
  const dir = fresh();
  write(dir, '0001_init.sql', 'create table a (id int primary key);\n');
  write(dir, '0002_more.sql', 'create table b (id int primary key);\n');
  const r = checkMigrations(dir, { record: true });
  assert.deepEqual(r.errors, []);
  return dir;
}

test('the repo migrations pass', () => {
  assert.deepEqual(checkMigrations('supabase/migrations').errors, []);
});

test('--record locks new files, then the check passes', () => {
  const dir = recorded();
  assert.deepEqual(Object.keys(lock(dir)), ['0001_init.sql', '0002_more.sql']);
  assert.deepEqual(checkMigrations(dir).errors, []);
});

test('an unrecorded new file fails until recorded', () => {
  const dir = recorded();
  write(dir, '0003_new.sql', 'create table c (id int);\n');
  assert.match(checkMigrations(dir).errors.join('\n'), /0003_new.sql: not in migrations.lock.json/);
  assert.deepEqual(checkMigrations(dir, { record: true }).errors, []);
  assert.deepEqual(checkMigrations(dir).errors, []);
});

test('editing an applied migration fails, and --record does not paper over it', () => {
  const dir = recorded();
  const before = lock(dir);
  write(dir, '0001_init.sql', 'create table a (id int primary key, x int);\n');
  assert.match(
    checkMigrations(dir).errors.join('\n'),
    /0001_init.sql: applied migration was edited/,
  );
  assert.match(checkMigrations(dir, { record: true }).errors.join('\n'), /was edited/);
  assert.deepEqual(lock(dir), before);
});

test('removing an applied migration fails', () => {
  const dir = recorded();
  rmSync(join(dir, '0002_more.sql'));
  assert.match(
    checkMigrations(dir).errors.join('\n'),
    /0002_more.sql: applied migration was removed/,
  );
});

test('renumbering an applied migration fails', () => {
  const dir = recorded();
  renameSync(join(dir, '0002_more.sql'), join(dir, '0003_more.sql'));
  const errors = checkMigrations(dir).errors.join('\n');
  assert.match(errors, /0002_more.sql: applied migration was removed or renamed/);
  assert.match(errors, /0003_more.sql: expected number 0002/);
});

test('a gap, a duplicate number and a bad name all fail', () => {
  const dir = fresh();
  write(dir, '0001_a.sql', 'select 1;');
  write(dir, '0003_c.sql', 'select 1;');
  assert.match(
    checkMigrations(dir, { record: true }).errors.join('\n'),
    /0003_c.sql: expected number 0002/,
  );
  const dup = fresh();
  write(dup, '0001_a.sql', 'select 1;');
  write(dup, '0001_b.sql', 'select 1;');
  assert.match(checkMigrations(dup, { record: true }).errors.join('\n'), /expected number 0002/);
  const bad = fresh();
  write(bad, 'init.sql', 'select 1;');
  assert.match(checkMigrations(bad).errors.join('\n'), /init.sql: name must look like/);
});

test('a corrupt lock file fails', () => {
  const dir = recorded();
  writeFileSync(join(dir, 'migrations.lock.json'), '{ not json');
  assert.match(checkMigrations(dir).errors.join('\n'), /not valid JSON/);
});

test('destructive statements need a guardrail-approved comment', () => {
  for (const sql of [
    'drop table attempts;',
    'truncate questions;',
    'delete from attempts where true;',
    'update settings set lesson_size = 5;',
    'alter table attempts drop column xp;',
    'alter table settings rename to old_settings;',
    'alter table attempts alter column xp type int;',
    'create table x (id int);\n\nDROP\n  TABLE x;',
    'create table x (id int);\ntruncate x;',
  ]) {
    assert.equal(findUnapproved(sql).length, 1, sql);
  }
});

test('approved destructive statements pass', () => {
  const sql = [
    'create table x (id int);',
    '-- guardrail-approved: Jonathan, 2026-10-13, remove the unused test table',
    'drop table x;',
  ].join('\n');
  assert.deepEqual(findUnapproved(sql), []);
  assert.deepEqual(findUnapproved('drop table x; -- guardrail-approved:\n'), [
    'line 1: destructive statement without "-- guardrail-approved:" comment: drop table x',
  ]);
});

test('definitions, permissions, comments and strings are not destructive', () => {
  const sql = `
    -- This trigger blocks delete from attempts; it never deletes.
    create function block_changes() returns trigger language plpgsql as $$
    begin
      delete from somewhere; update t set x = 1; drop table nothing;
      raise exception 'append-only';
    end $$;
    create trigger no_delete before update or delete on attempts
      for each row execute function block_changes();
    create trigger cap after delete on settings referencing old table as gone
      for each statement execute function block_changes();
    revoke truncate, references, trigger on all tables in schema public from authenticated;
    revoke all on attempts from anon;
    create trigger no_truncate before truncate on attempts for each statement execute function block_changes();
    create table archive as select * from attempts where false;
    alter table attempts enable row level security;
    create policy p on attempts for select to authenticated using (note <> 'drop table x;');
    create function f() returns void language sql as $body$ truncate t; $body$;
    /* drop table x; */
  `;
  assert.deepEqual(findUnapproved(sql), []);
});

test('a destructive statement in one migration file fails the whole check', () => {
  const dir = fresh();
  write(dir, '0001_init.sql', 'create table a (id int);\ndelete from a;\n');
  const r = checkMigrations(dir, { record: true });
  assert.match(r.errors.join('\n'), /0001_init.sql: line 2: destructive statement/);
  assert.throws(() => lock(dir));
});

// Audit M3: statements the first version let through.
const MISSED_BEFORE = {
  'do block delete': 'do $$ begin delete from attempts; end $$;',
  'do block execute': "do $x$ begin execute 'truncate attempts'; end $x$;",
  'replace a guardrail function':
    'create or replace function block_attempt_changes() returns trigger language plpgsql as $$ begin return old; end $$;',
  'disable triggers': 'alter table attempts disable trigger all;',
  'disable RLS': 'alter table attempts disable row level security;',
  'unforce RLS': 'alter table attempts no force row level security;',
  'update only': 'update only settings set lesson_size = 5;',
  'update with alias': 'update settings s set lesson_size = 5;',
  'update, digit in name': 'update t1 set x = 1;',
  'update, spaced schema': 'update public . settings set x = 1;',
  merge: 'merge into attempts a using (select 1) s on true when matched then delete;',
  'marker inside a string': "delete from attempts where note <> '-- guardrail-approved: x';",
  'marker below the start': 'delete from attempts\n-- guardrail-approved: me\nwhere true;',
  "E'' string hides it": "select E'\\''; delete from attempts; select '';",
  '$q$ inside a name hides it': 'create table t$q$ (a int); delete from attempts; -- $q$',
  "' inside a quoted name hides it": 'create table "it\'s" (a int); delete from attempts; -- \'',
  'create rule': 'create rule r as on insert to attempts do instead nothing;',
  'grant delete': 'grant delete on attempts to authenticated;',
  'grant all': 'grant all on public.settings to anon;',
  'table-wide update grant': 'grant update on public.attempts to authenticated;',
  'replication role': 'set session_replication_role = replica;',
  'create table as with delete':
    'create table z as with d as (delete from attempts returning *) select * from d;',
  'security definer':
    'create function f() returns int language sql security definer as $$ select 1 $$;',
  'alter function': 'alter function public.log_change() security invoker;',
  'alter policy': 'alter policy own_rows on public.attempts using (true);',
  'default privileges grant':
    'alter default privileges in schema public grant all on tables to anon;',
};

test('statements that weaken a guardrail or hide a deletion need approval (audit M3)', () => {
  for (const [name, sql] of Object.entries(MISSED_BEFORE))
    assert.equal(findUnapproved(sql).length >= 1, true, name);
});

test('each is accepted with a marker line of its own directly above (audit M3)', () => {
  for (const [name, sql] of Object.entries(MISSED_BEFORE)) {
    if (name.startsWith('marker') || name.includes('hides it')) continue;
    const approved = `select 1;\n-- guardrail-approved: Jonathan, 2026-10-14, test\n${sql}`;
    assert.deepEqual(findUnapproved(approved), [], name);
  }
  // A marker trailing the previous statement on its line does not count.
  assert.equal(
    findUnapproved('select 1; -- guardrail-approved: me\ndelete from attempts;').length,
    1,
  );
});

test('ordinary new migrations still pass (audit M3)', () => {
  const sql = `
    create function public.f() returns int language sql security invoker set search_path = public as $$ select 1 $$;
    revoke all on function public.f() from public, anon;
    grant execute on function public.f() to authenticated;
    grant select on public.questions to authenticated;
    grant insert (a, b) on public.t to authenticated;
    grant update (a) on public.t to authenticated;
    alter table public.t enable row level security;
    alter table public.t force row level security;
    create trigger t_check before insert on public.t for each row execute function public.f();
    do $$ begin raise notice 'hello'; end $$;
    alter default privileges revoke execute on functions from public;
    alter default privileges in schema public
      revoke truncate, references, trigger on tables from service_role;
  `;
  assert.deepEqual(findUnapproved(sql), []);
});

test('the applied migrations are exempt only as they are: one changed byte gets every rule (audit M3)', () => {
  const original = readFileSync('supabase/migrations/0002_guardrails.sql', 'utf8');
  assert.deepEqual(findUnapproved(original), []);
  assert.match(findUnapproved(original + '\n').join('\n'), /line 11: .*log_change/);
});
