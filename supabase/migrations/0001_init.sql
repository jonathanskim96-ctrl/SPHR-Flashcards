-- SPHR Flashcards, migration 0001: tables and constraints (BUILD_PLAN Phase 2).
-- Security rules (grants, row-level security, safety log) are in 0002; functions in 0003.
-- Run 0001, 0002 and 0003 in order, each once. Applied migrations are never edited.

-- Valid IANA time zone, as Postgres knows them (the app checks the same with Intl).
create function public.is_valid_time_zone(tz text) returns boolean
  language sql stable
  security invoker
  set search_path = public
  as $$ select exists (select 1 from pg_catalog.pg_timezone_names where name = tz) $$;

-- The question bank, written only by the import (service role). Read-only for the app.
create table public.bank_meta (
  id int primary key check (id = 1),
  schema_version int not null check (schema_version = 1),
  bank_version text not null check (bank_version ~ '^\d{4}-\d{2}-\d{2}\.\d+$'),
  areas jsonb not null check (jsonb_typeof(areas) = 'array'),
  levels jsonb not null check (jsonb_typeof(levels) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.scenarios (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)+$' and length(id) <= 64),
  area smallint not null check (area between 1 and 5),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and octet_length(data::text) <= 16384 and data ->> 'id' = id
  ),
  updated_at timestamptz not null default now()
);

create table public.questions (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)+$' and length(id) <= 64),
  revision int not null check (revision >= 1),
  status text not null check (status in ('active', 'retired')),
  area smallint not null check (area between 1 and 5),
  level text not null check (level in ('K', 'A', 'S')),
  type text not null check (type in ('mc', 'multi', 'numeric', 'text', 'ordering', 'matching')),
  -- The full question object from content/questions.json.
  data jsonb not null check (
    jsonb_typeof(data) = 'object'
    and octet_length(data::text) <= 16384
    and data ->> 'id' = id
    and data ->> 'type' = type
    and data ->> 'status' = status
  ),
  updated_at timestamptz not null default now()
);

-- Michelle's answer history: the source of truth for all progress. Append-only (0002
-- blocks updates and deletes). No foreign key to questions: an answer must survive any
-- problem with the bank.
create table public.attempts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  seq bigint generated always as identity unique, -- sync cursor
  question_id text not null check (question_id ~ '^[a-z0-9]+(-[a-z0-9]+)+$' and length(question_id) <= 64),
  revision int not null check (revision between 1 and 1000000),
  answer_fp text not null check (answer_fp ~ '^[0-9a-f]{16}$'),
  correct boolean not null,
  xp smallint not null check (xp between 0 and 3),
  mode text not null check (mode in ('lesson', 'mistakes', 'ahead')),
  response jsonb not null check (
    jsonb_typeof(response) = 'object' and octet_length(response::text) <= 2048
  ),
  answered_at timestamptz not null,
  received_at timestamptz not null default now(),
  check (correct or xp = 0),
  check (answered_at <= received_at + interval '1 day')
);
create index attempts_user_seq on public.attempts (user_id, seq);

create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id),
  new_per_day int not null default 15 check (new_per_day between 1 and 50),
  lesson_size int not null default 10 check (lesson_size between 5 and 30),
  daily_xp_goal int not null default 30 check (daily_xp_goal between 5 and 200),
  exam_date date not null default '2026-12-15'
    check (exam_date between '2000-01-01' and '2100-12-31'),
  reminder_enabled boolean not null default false,
  reminder_time time not null default '15:00' check (
    extract(minute from reminder_time)::int % 15 = 0 and extract(second from reminder_time) = 0
  ),
  time_zone text not null check (public.is_valid_time_zone(time_zone)),
  version int not null default 1 check (version >= 1),
  updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id),
  endpoint text not null unique check (endpoint ~ '^https://' and octet_length(endpoint) <= 1024),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_=-]{16,255}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_=-]{8,255}$'),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count int not null default 0 check (failure_count >= 0),
  disabled_at timestamptz
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

-- At most one reminder per user per local day (the primary key guarantees it).
create table public.reminder_log (
  user_id uuid not null references auth.users (id),
  local_date date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, local_date)
);

-- One row per keep-alive run (stops the free project from pausing).
create table public.keepalive_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now()
);

-- Copy of every update and delete on every table (filled by triggers in 0002).
create table public.safety_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  table_name text not null,
  op text not null check (op in ('UPDATE', 'DELETE')),
  old_row jsonb not null,
  new_row jsonb,
  db_user text not null,
  jwt_sub text
);
create index safety_log_at on public.safety_log (at);
