# Build plan: SPHR Flashcards

For the build session. Read `CLAUDE.md` and `docs/HANDOFF.md` first. The owner's product
decisions are recorded in HANDOFF §2; this plan implements them and does not reopen them. If
something here turns out to be wrong or impossible, stop and ask the owner. Don't improvise
a product change.

Work phase by phase. A phase is done only when all of its acceptance criteria hold and its
tests pass in CI. Update `docs/HANDOFF.md` and `NOTES.md` at the end of each phase. Push to
the working branch after each phase; push to `main` only with the owner's OK.

---

## Architecture summary

```
content/questions.json ──(build)──► public/bank.json (bundled fallback, precached)
        │
        └─(Import workflow, manual, validator first)──► Supabase: questions, scenarios, bank_meta

Phone (PWA, offline-first)
  src/domain/  pure: grading, scheduling, XP, mastery, lessons, replay, validate, export
  src/data/    IndexedDB cache (per user) + outbox → RPC apply_changes; bank loader
  src/ui, src/screens   thin React UI

Supabase (free plan)
  tables: questions, scenarios, bank_meta (read-only to app)
          attempts (append-only), settings, push_subscriptions, reminder_log,
          keepalive_log, safety_log
  RPCs:   apply_changes, save_push_subscription, disable_push_subscription,
          import_bank (service_role only), keepalive (service_role only)
  pg_cron every 15 min → pg_net → Edge Function send-reminders → Web Push (VAPID)
GitHub Actions: ci (every push), deploy (main), import-questions (manual), keepalive (daily)
```

### Key design decision: the attempt log is the source of truth

Card scheduling state (box, due date, streak, Mistakes membership) is **not stored as
mutable rows**. It is computed by a pure function `replay(attempts, bank, settings)` from
the append-only attempt history. Consequences, all intended:

- Sync has no merge conflicts for progress: two devices' attempts are a set union by
  attempt `id` (a client-generated UUID), and replay gives the same state everywhere.
- XP total = the sum of `xp` over attempts. Daily XP = the sum over attempts on the local day.
- Recovery = restore attempts (from the export file, or the database). Everything else
  follows.
- The "spaced-repetition state per card" the owner wants backed up is backed up, because it
  is derived from data that is backed up.

Each attempt records the question `revision` and an `answerFp` (answer fingerprint, below).
Replay ignores, **for scheduling only**, attempts whose `answerFp` differs from the
question's current fingerprint. That is how "change the answer → reset that card" works
without any schema change. XP from those attempts still counts.

### Answer fingerprint (no schema change)

`answerFp(q)` = a short stable hash (e.g. SHA-256, first 16 hex chars, of canonical JSON) of
the **graded** fields only: `type`, `answer`, `accepted`, `selectCount`, and the `id`+`text`
of `choices` / `items` / `prompts` / `options`. Not included: `stem`, `explanation`,
`scenarioId`, citations, notes. So:

- Fixing a typo in the stem or explanation (revision raised) keeps her progress.
- Changing the answer, an accepted spelling, or the text of any choice/item/option resets
  that card's schedule (it becomes "new" again).

Write a test for each of those cases.

---

## Phase 0: Scaffold, CI, guardrails

**Build**
- Vite + React + TypeScript (strict) + vite-plugin-pwa, `base: '/SPHR-Flashcards/'`.
  ESLint, Prettier, vitest, Playwright (Chromium pre-installed; never `playwright install`;
  if the pinned version needs it, use `executablePath: '/opt/pw-browsers/chromium'`).
- Folders: `src/domain`, `src/data`, `src/ui`, `src/screens`, `supabase/migrations`,
  `supabase/functions/send-reminders`, `supabase/tests`, `supabase/recovery`, `scripts`,
  `tests/fixtures`, `e2e`.
- `tests/fixtures/sample-bank.json`: a **clearly fake** bank in schema v1 that passes
  `scripts/validate-bank.mjs`. Every stem starts with "FAKE:" and is about nonsense topics
  (e.g. "FAKE: Which colour is the test widget?"). It must contain: every one of the 6
  types, a scenario shared by 2 questions, one retired question, one question at revision 2,
  numeric items with units `$`, `%`, `:1`, `days`, `°F`, `""` and a tolerance > 0, a text item
  with 3+ accepted forms including a hyphenated one, ordering with 5 items, matching with
  4 prompts and 5 options, and a multi with `selectCount: 2`. Note: the validator's
  answer-letter scan applies per `source.doc`, so give fake MC items a balanced A/B/C/D
  sequence.
- `scripts/check-migrations.mjs` + `supabase/migrations/migrations.lock.json` (sha256 per
  file): fails if an applied migration is edited, removed or renumbered. `--record` adds new
  files.
- `scripts/build-bank.mjs`: runs the validator, then copies `content/questions.json` to
  `public/bank.json` at build time (the bundled fallback).
- `.github/workflows/ci.yml` (on push and PR, `permissions: contents: read`): validator on
  `content/questions.json` **with `--previous` set to the version of the file on the base
  commit** (`git show <base>:content/questions.json > /tmp/prev.json`; skip `--previous` if
  the file did not exist), validator on the fake bank, check-migrations, typecheck, lint,
  unit tests, build, local Postgres tests, e2e.
- `.github/workflows/deploy.yml` (push to `main`): a `verify` job equal to CI → build (repo
  variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_VAPID_PUBLIC_KEY`) →
  deploy to Pages. Refuses to deploy if verify fails. `concurrency: group: pages-${{ github.ref }}`.
- `.env.example` with the three variable names and no values. `.gitignore` covers `.env*`
  (except the example), `*.export.json`, `supabase/.temp`.
- `NOTES.md` started.

**Acceptance**
- CI is green on the branch. Pushing a deliberately broken bank (on a scratch branch, then
  reverted with a new commit, never a force-push) makes CI red and blocks deploy.
- Removing a question id makes the `--previous` check fail.
- Editing an applied migration makes check-migrations fail.

**Tests**: `scripts/*.test.mjs` (node:test) for check-migrations and build-bank; a CI
self-test that the validator rejects `tests/fixtures/bad-banks/*.json` (missing answer,
duplicate id, ordering already in order, matching option used twice, "all of the above",
run of 3 answer letters).

---

## Phase 1: Domain layer (pure, no I/O)

All in `src/domain/`, fully typed from `docs/QUESTION_FORMAT.md`.

### 1a. Bank model and normalizer (`bank.ts`)
- Types for every question type, scenario, area, level.
- `normalizeBank(unknown)`: defensive parse of anything from the network, cache or file.
  Drop and report malformed questions, never crash. Reject `schemaVersion !== 1` as a whole.
- `compareBankVersion(a, b)`: compares `YYYY-MM-DD.n` correctly (`2026-10-13.10` > `.9`).
- `answerFp(q)` as described above.

### 1b. Grading (`grade.ts`)
One function per type, returning `{ correct: boolean, parts?: boolean[] }`, where `parts`
gives per-part right/wrong for multi, ordering and matching (shown in feedback only).

| Type | Rule (decided; do not loosen) |
|---|---|
| mc | selected id === `answer` |
| multi | the selected set equals the `answer` set exactly. The UI only enables Check once exactly `selectCount` are selected. `parts`: per chosen option, whether it is in the answer. |
| numeric | input → lowercase → remove every occurrence of `unit` (lowercased) if `unit` is non-empty → remove `$`, `%`, `,` and all whitespace → must match `^-?(\d+\.?\d*|\.\d+)$` (otherwise incorrect, not an error) → `abs(x − value) ≤ tolerance + 1e-9`. |
| text | `norm(s)` = lowercase → collapse whitespace runs to one space → trim → drop **one** trailing `.`. Correct if `norm(input)` equals `norm` of any `accepted`. Must be byte-for-byte the same function as `norm` in `scripts/validate-bank.mjs` (test it). Nothing else is forgiven: not hyphens, not plurals, not curly quotes. |
| ordering | the submitted id sequence equals `answer` exactly. `parts`: per position. |
| matching | every prompt is mapped, and each mapping equals `answer[prompt]`. `parts`: per prompt. Each option can be used at most once; the UI enforces this. |

All-or-nothing: `correct` is the only thing that drives XP and scheduling.

### 1c. XP (`xp.ts`)
- `xpFor(q, correct)` = `correct ? bank.levels[q.level].points : 0` (read the points from
  the bank, don't hard-code 1/2/3). No bonuses.
- `totalXp(attempts)`, `dailyXp(attempts, localDate, tz)`.

### 1d. Scheduling (`schedule.ts`): exam-aware boxes
State per card: `{ box: 0..5, due: LocalDate | null, streak: number, inMistakes: boolean,
lastAnswered: LocalDate | null, firstSeen: LocalDate | null }`. Box 0 = new.

`applyAnswer(state, correct, today, examDate)`:
- correct → `box = min(box + 1, 5)`, interval = `[1, 3, 7, 14, 21][box − 1]` days.
- wrong → `box = 1`, interval = 1 day, `inMistakes = true`.
- `streak = correct ? streak + 1 : 0`; if `streak ≥ 2` → `inMistakes = false`.
- `due = today + interval`; **if `today < examDate` and `due > examDate`, then
  `due = examDate`**. After the exam date there is no cap.
- `lastAnswered = today`; `firstSeen ??= today`.

`mastered(state)` = `streak ≥ 2` (the last 2 reviews were correct). A tier badge is earned
when every **active** card in that area+tier is mastered.

Dates are local calendar dates in `settings.timeZone` (default: the device's zone). Use a
small, well-known date library or `Intl`; there is no time of day in scheduling.

### 1e. Replay (`replay.ts`)
`replay(attempts, bank, settings) → Map<questionId, CardState>`: sort attempts by
`answeredAt`, then `id`; skip attempts whose question is unknown or whose `answerFp`
differs from the current one (for scheduling only); apply `applyAnswer` in order.
Retired questions keep their state but are excluded from lessons and progress counts.

### 1f. Lesson builder (`lesson.ts`)
Input: bank, card states, settings, today, selection `{ areas: number[] (1–5 areas),
tiers: ('K'|'A'|'S')[] }`, mode.
- **mode `lesson`** (default): (1) due cards (`due ≤ today`, `lastAnswered ≠ today`,
  active, in selection), most overdue first, then lower box first; (2) then new cards
  (box 0) in K → A → S order and bank order, limited by the remaining **daily new-card cap**
  (`settings.newPerDay`, default 15, counted across all areas by `firstSeen = today`); stop
  at `settings.lessonSize` (default 10).
- **mode `mistakes`**: cards with `inMistakes` in the selection, `lastAnswered ≠ today`,
  oldest mistake first. Because of the same-day rule, "2 correct in a row" always means
  two different days.
- **mode `ahead`** (offered only when a normal lesson would be empty): not-yet-due cards in
  the selection, soonest due first, `lastAnswered ≠ today`.
- Every answer in every mode counts as a review (it updates the schedule and earns XP).
- A card is never shown twice in one lesson.
- Display shuffling (`shuffle.ts`, given an injectable RNG): mc/multi choices and matching
  options are shuffled every time the card is shown; ordering items are shuffled and
  re-shuffled until the order differs from `answer`. No A/B/C/D letters are shown anywhere.
  Responses are recorded as ids, so shuffling never affects grading.

### 1g. Progress (`progress.ts`)
Per area and tier: `{ active, seen, mastered }`; tier badge when `mastered === active > 0`.
Totals across selected areas. These drive the bars and badges.

### 1h. Validation and export (`validate.ts`, `exportImport.ts`)
- `validateSettings`: `newPerDay` integer 1–50; `lessonSize` integer 5–30; `dailyXpGoal`
  integer 5–200 (default 30); `examDate` a valid date (default `2026-12-15`, the owner's
  confirmed exam date); `reminderEnabled` boolean; `reminderTime` `HH:MM` on a
  15-minute grid (default `15:00`); `timeZone` a valid IANA zone.
- `validateAttempt`: uuid id, known question id format, revision integer ≥ 1, `answerFp`
  16 hex chars, `correct` boolean, `xp` integer 0–3, `mode` in the enum, `response` JSON
  ≤ 2 KB of the right shape for the type, `answeredAt` ISO timestamp not more than 1 day
  in the future.
- Export file: `{ "format": "sphr-flashcards-progress", "version": 1, "exportedAt",
  "bankVersion", "attempts": [...], "settings": {...} }`. Import = **merge** (union of
  attempts by id; settings only if the user ticks "also restore settings"). The preview
  shows "N new answers, M already present, K rejected (reason)". Import never removes
  anything.

**Tests (vitest)**
- Grading: table-driven tests per type using the fake bank, **plus real-bank edge cases**
  (read-only) by id:
  - `lsw2-q18` (0.72 %): `"0.72"`, `"0.72%"`, `".72"`, `" 0.72 % "` → correct; `"0.7"` → wrong.
  - `trw2-q18` (unit `:1`): `"89"`, `"89:1"` → correct; `"89 to 1"` → wrong.
  - `hiw1-q19` (unit `°F`): `"87"`, `"87°F"`, `"87 °f"` → correct; `"87°"` → **wrong**
    (decided rule; recorded in HANDOFF open items).
  - `trw1-q01` (0.85, unit `""`): `"0.85"`, `".85"` → correct; `"85%"` → **wrong** (open item).
  - `pt1-q015` (38.4 ± 0.1): `"38.3"`, `"38.5"` → correct; `"38.6"` → wrong.
  - `pt1-q006` (1.44 ± 0.01, unit `ratio`): `"1.44 ratio"`, `"1.45"` → correct.
  - `lsw2-q20` ($504,000): `"$504,000"`, `"504000"`, `"504,000.00"` → correct;
    `"504k"`, `"1.2.3"`, `""`, `"-"` → wrong, no crash.
  - `hiw1-q21` (text): `"lockout/tagout"`, `"LOTO"`, `"  Lockout   tagout. "` → correct;
    `"lockout tag out"`, `"lockouts/tagout"` → wrong.
  - `lsw1-q13` (text): `"ADEA."` → correct; `"ADEA.."` → wrong.
  - `wpw1-q22`: `"Standalone"` and `"stand-alone"` → correct; `"stand alone"` → wrong.
  - For **every** real question: the canonical correct response grades correct (mc answer,
    multi answer set, `String(value)` and `String(value) + unit` for numeric, each
    `accepted` for text, `answer` for ordering and matching), and for mc/multi every other
    single choice grades wrong. Do **not** feed `displayAnswer` to the grader: six numeric
    display answers contain explanation text by design (`hiw2-q13`, `tmw2-q07`, `trw1-q01`,
    `trw1-q04`, `trw1-q25`, `wpw1-q16`).
  - text `norm` equals the validator's `norm` on 10,000 random strings (fuzz).
- Fuzz (fast-check is acceptable as a well-known dev dependency, or a seeded hand-rolled
  RNG): random answer sequences with random dates. Invariants: box stays in 0–5; due is never
  before `lastAnswered + 1`; due never exceeds the exam date while answered before it;
  `inMistakes` is true iff the last answer was wrong or the streak has not reached 2 since
  the last wrong; replay is deterministic and independent of the input order of attempts
  with distinct timestamps; replaying the union of two attempt sets is the same as
  replaying them in either merge order; XP total equals the sum of points of correct attempts.
- Lesson builder: the daily new cap holds across several lessons and areas in one day; no
  card twice in a lesson; no card answered today appears in `lesson` or `mistakes` modes;
  retired cards never appear; a selection of multiple areas only draws from those areas.
- Answer fingerprint: stem edit → same fp; answer change → different fp; replay resets
  only that card.
- Shuffle: ordering never starts in the correct order (property test with 1,000 seeds).
- Validators: every bound ± 1, wrong types, `3.7` for integers, an oversized response.
- Export/import: round trip; merge is idempotent; a malformed file is rejected with a message.

**Acceptance**: 100% of the domain is covered by tests; the fuzz suite runs ≥ 1,000 cases
per property in CI.

---

## Phase 2: Database (local Postgres first; the owner applies it in the SQL editor later)

### Migration `0001_init.sql`
- `bank_meta` (single row, `id int primary key check (id = 1)`, `schema_version`,
  `bank_version`, `areas jsonb`, `levels jsonb`, `updated_at`).
- `scenarios` (`id text pk`, `area smallint`, `data jsonb`, `updated_at`).
- `questions` (`id text pk` with an id-format check, `revision int ≥ 1`, `status` in
  (`active`, `retired`), `area` 1–5, `level` in (K, A, S), `type` in the 6 types,
  `data jsonb` (the full question object, ≤ 16 KB), `updated_at`).
- `attempts` (`id uuid pk`, `user_id uuid not null default auth.uid() references
  auth.users`, `seq bigint generated always as identity unique` (sync cursor),
  `question_id text`, `revision int`, `answer_fp text check (~ '^[0-9a-f]{16}$')`,
  `correct bool`, `xp smallint 0–3`, `mode text`, `response jsonb` (≤ 2 KB),
  `answered_at timestamptz`, `received_at timestamptz default now()`).
  No foreign key to `questions` (an attempt must survive any bank problem).
- `settings` (`user_id uuid pk`, the fields from 1h with matching checks, `version int`,
  `updated_at`). The time zone check uses `pg_timezone_names`; the reminder time check is
  `extract(minute from reminder_time)::int % 15 = 0 and extract(second …) = 0`.
- `push_subscriptions` (`id uuid pk`, `user_id`, `endpoint text unique` (https only,
  ≤ 1 KB), `p256dh`, `auth`, `created_at`, `last_success_at`, `failure_count`,
  `disabled_at`).
- `reminder_log` (`user_id`, `local_date date`, `sent_at`, pk (`user_id`, `local_date`)):
  guarantees at most one reminder per local day.
- `keepalive_log` (`id bigint identity pk`, `at timestamptz default now()`).
- `safety_log` (`id bigint identity`, `at`, `table_name`, `op`, `old_row jsonb`,
  `new_row jsonb`, `db_user text`, `jwt_sub text`).

### Migration `0002_guardrails.sql`
- Triggers on every table: `after update or delete … for each row` insert into
  `safety_log`.
- `attempts`: `before update or delete` trigger raises **always** (append-only), unless the
  session setting `app.guardrail_override` equals a non-empty approval string. That string
  must only ever be set in an owner-approved, `-- guardrail-approved:` SQL snippet.
- `questions`, `scenarios`: `before delete` raises always (same override rule).
- Statement-level mass-delete cap on `settings`, `push_subscriptions`, `reminder_log`:
  `after delete … referencing old table` raises if more than 5 rows are deleted in one
  statement.
- `revoke all on all tables in schema public from anon`; revoke `truncate, references,
  trigger` from `authenticated`. Grants: `authenticated` gets `select` on questions,
  scenarios and bank_meta; `select, insert` on attempts (own rows via RLS); `select,
  insert, update` on settings; `select` on push_subscriptions. **No `delete` grant to
  `authenticated` on any table.** `safety_log`, `reminder_log` and `keepalive_log`: no
  grants to app roles.
- RLS enabled and forced on every table. Policies `to authenticated using/with check
  (user_id = (select auth.uid()))` on attempts, settings and push_subscriptions;
  `using (true)` select-only on questions, scenarios and bank_meta.

### Migration `0003_rpc.sql`
- `apply_changes(p_attempts jsonb, p_settings jsonb, p_settings_base_version int)`,
  security invoker: rejects more than 200 attempts per call; inserts attempts with
  `on conflict (id) do nothing` (idempotent replay of the outbox); if `p_settings` is given,
  upserts settings only when the stored `version = p_settings_base_version` (or no row
  exists), incrementing `version`, else returns `{settings_conflict: true, server: …}`.
  Returns `{ inserted, duplicates, settings_version, max_seq }`.
- `save_push_subscription(endpoint, p256dh, auth)` (upsert by endpoint for the caller,
  clears `disabled_at`) and `disable_push_subscription(endpoint)` (sets `disabled_at`; no
  delete).
- `import_bank(p_bank jsonb, p_apply boolean)`: execute granted **only to `service_role`**.
  Checks `schemaVersion = 1`; refuses if any id in `questions` is missing from the incoming
  bank (retire instead of delete); refuses any revision lower than the stored one; refuses
  any question whose `data` changed while its revision did not; refuses if anything changed
  but `bankVersion` is not greater than the stored one. With `p_apply = false` it changes
  nothing and returns `{ new, changed, unchanged, newly_retired, errors[] }`; with
  `p_apply = true` it inserts and updates (never deletes) and returns the same summary.
  The whole call is one transaction.
- `keepalive()`: service_role only; inserts one row into `keepalive_log` and returns the
  row count.

### Local test harness `supabase/tests/run.sh`
Starts a throwaway local Postgres (Docker image `postgres:15`/`supabase/postgres` if Docker
is available, otherwise a locally installed PostgreSQL via `initdb` in a temp dir),
creates an **auth shim** (`auth` schema, `auth.users`, `auth.uid()` reading
`request.jwt.claims`, roles `anon`, `authenticated`, `service_role`), applies the
migrations in order, then runs the SQL test files (plain SQL with `do $$ … assert …$$`, or
pgTAP if available) and exits non-zero on any failure. The trap uses
`kill $PID 2>/dev/null || true`.

**Tests**
- `rls.sql`: user A sees only A's attempts/settings/subscriptions; anon sees nothing,
  including questions; authenticated can read questions but not write them.
- `attack.sql` (the attack suite): cross-user select/insert/update by forging `user_id`;
  inserting an attempt with another user's id; updating or deleting an attempt (must fail,
  even for the owner); `truncate` as authenticated; deleting questions; calling
  `import_bank` and `keepalive` as authenticated or anon; 201 attempts in one call;
  `xp = 3.7`, `xp = 4`, `revision = 0`; a 3 KB response; a 2,000-char question id; a
  reminder time of 15:07; a fake time zone; a non-https push endpoint; mass delete of 6
  rows from push_subscriptions as service role (cap fires); SQL-injection-shaped strings
  stored as plain data.
- `import.sql`: dry run changes nothing; apply inserts; re-apply is a no-op; a removed id
  is refused; a lowered revision is refused; changed data with the same revision is
  refused; retiring works; a bad schemaVersion is refused.
- `recovery.sql`, the **recovery test**: seed a user with settings, a subscription and 50
  attempts; simulate damage (with the override set, as a stand-in for an accident: update
  settings to junk, disable the subscription, delete 10 questions); run
  `supabase/recovery/restore_from_safety_log.sql` exactly as documented in
  `docs/RECOVERY.md`; assert settings, the subscription and the questions are back, that
  attempts were untouched, and that a row legitimately changed *after* the damage window is
  not reverted. A second case: wipe a user's attempts (override), re-import them from a
  fixture export file through `apply_changes`, and assert replay gives identical state.
- Mutation checks (manual, recorded in NOTES.md): remove the `user_id` policy predicate, the
  append-only trigger, the 200 cap and the import's "missing id" check, one at a time;
  confirm a test fails each time; restore the file.

**Acceptance**: `./supabase/tests/run.sh` passes locally and in CI, and the mutation checks
are recorded.

---

## Phase 3: Data layer and offline sync

- `src/data/db.ts`: IndexedDB (via `idb`), databases named per user id: stores `bank`,
  `attempts` (all known, by id), `outbox` (ordered), `settings`, `meta` (last seq cursor,
  last export date, last sync time).
- `guardedWrite(change)`: validates with the domain validator, appends to the outbox **and**
  the local attempts in one IndexedDB transaction, so the UI updates instantly.
- Sync engine: flush the outbox in order through `apply_changes` in batches of ≤ 200 on
  app start, `online`, `visibilitychange` to visible, after each answer (debounced 2 s), and
  every 5 minutes while open. Remove items from the outbox **by id** only after the server
  confirms, so an answer made during a flush is never lost. Then pull
  `attempts where seq > cursor` (paged) and settings. Server rejections are dropped from the
  outbox and shown in the UI ("1 answer could not be saved: reason"). A settings conflict
  shows "Settings were changed on another device; reloaded them" and keeps the server copy.
- A sync status line in Settings: "All answers backed up" / "3 answers waiting to back up"
  / the last error.
- Reload-race guard: a write counter; a pull that started before a local write finished
  is discarded.
- Sign-out: blocked while the outbox is non-empty (offers export); otherwise it wipes this
  user's IndexedDB.
- Ask for persistent storage (`navigator.storage.persist()`) after sign-in.

**Tests**
- Unit tests with a fake RPC: offline queueing; ordered flush; a crash mid-flush followed by
  replay is idempotent (server duplicates are ignored); an answer made during a flush
  survives; a rejection is reported and dropped; pagination of the pull.
- **Two-device tests**: devices A and B each answer offline (including the same card on the
  same day with different results); both sync; both end with identical replayed state and
  XP; the attempt count equals the union.
- **Settings conflict**: A and B edit settings from the same base version; the second gets a
  conflict and shows the message; no data is lost.
- **App↔DB contract tests** (run inside `supabase/tests/run.sh` with Node against the
  local Postgres via PostgREST-shaped calls, or by calling the SQL functions directly with
  the same JSON the client produces): every client payload shape (attempt of each of the 6
  response types, settings, subscription) round-trips through the real RPC and reads back
  identical after `normalize`; the client's validator and the DB constraints accept and
  reject exactly the same boundary values (generated from one shared table).

---

## Phase 4: Question delivery

- `loadBank()`: candidates are (1) Supabase (`bank_meta`, then all `questions` and
  `scenarios` when `bank_version` differs from the cached one), (2) the IndexedDB cache,
  (3) the bundled `bank.json` (precached by the service worker). **Use the candidate with
  the highest `bankVersion`** that normalizes cleanly; ties prefer Supabase, then cache. (This
  means a deploy with new questions reaches her phone even before the owner runs the
  import, and Supabase is used whenever it is current.) Cache the winner.
- Re-check `bank_meta` on app start and on return to foreground (at most every 10 minutes).
- When the bank changes mid-session: finish the current card, then use the new bank.
- Retired questions disappear from lessons and progress; their attempts remain.

**Tests**: offline with an empty cache → bundled bank; Supabase newer → Supabase; Supabase
older than bundled → bundled; a corrupt cache → falls back and reports; a revision bump of
a stem-only edit keeps the card's state, an answer change resets it; a retired card vanishes
from progress denominators.

---

## Phase 5: UI (Duolingo-like, iPhone 13 Pro Max first: 428×926 CSS px)

Screens:
1. **Sign in**: email + password only. No sign-up link. Clear error messages.
2. **Home**: total XP and the daily-XP-goal ring at the top; five **area cards**, each
   with three tier rows (K "Knowledge", A "Application", S "Synthesis") showing a progress
   bar (mastered / active) and a badge when mastered; a big **Start lesson** button; an
   area picker (tap areas to select one or several; tier chips K/A/S, all on by default);
   a **Mistakes** button showing the count. (Not shown, by the owner's choice: a due-today
   counter, an exam countdown, a streak.)
3. **Lesson**: a progress bar across the top (card x of n); the scenario (if any) in a
   distinct box above the stem; the answer area by type; a **Check** button. Feedback:
   - correct → a short confirmation ("Correct!") and "+N XP";
   - wrong → "Not quite", the correct answer (choice text / `displayAnswer` / the correct
     order / the correct pairs, with her right parts marked), and `explanation`. Never show
     `wrongReasons`, `otherNotes`, `citations` or `source`.
   - then **Continue**.
4. **Lesson end**: XP earned, n of m correct, **Keep going** / **Done**.
5. **All caught up**: when nothing is due and today's new cap is used: **Practice
   Mistakes** (if any) and **Study ahead**.
6. **Settings**: new cards per day, lesson length, daily XP goal, exam date, daily reminder
   (on/off, time in 15-minute steps, shows the time zone), sync status, **Export
   progress**, **Import progress** (with preview and a confirmation), sign out, and the build
   id in the footer.

Inputs by type:
- **mc**: big tappable option buttons. **multi**: toggle buttons and a "Choose 2"
  counter; Check is enabled at exactly `selectCount`.
- **numeric**: a text input with `inputmode="decimal"`, the unit shown beside it.
- **text**: a text input with `autocapitalize="off"`, `autocorrect="off"`,
  `spellcheck="false"`, `autocomplete="off"` (iOS must not "fix" her spelling).
- **ordering**: a vertical list; **touch drag-and-drop** (dnd-kit with touch and
  keyboard sensors, or an equivalent well-known library) **and** a non-drag fallback on
  every row: ▲/▼ buttons, plus tap-to-select then tap-a-slot to move. Each row has an
  accessible label ("Item 2 of 5: …, move up").
- **matching**: prompts on the left, and a pool of options. Tap a prompt then tap an option
  (or drag an option onto a prompt) to pair; tap a pair to undo. A used option is
  removed from the pool. Check is enabled when every prompt is paired. The extra
  (distractor) option stays in the pool.

Accessibility: everything reachable by VoiceOver and keyboard; targets ≥ 44 px; colour is
never the only signal (✓/✗ icons too); text sized for reading (≥ 17 px body); respects
reduced motion.

**Tests**: component tests for each input; XSS (a fake question whose stem, choices,
scenario and explanation contain `<img src=x onerror=…>` and `"><script>` renders as
literal text); and each screen's error states.

---

## Phase 6: PWA, install, update

- vite-plugin-pwa `generateSW` with `skipWaiting`, `clientsClaim`, `cleanupOutdatedCaches`;
  precaches the app shell and `bank.json`; a custom register file; a "New version: Reload"
  banner; the build id in the Settings footer.
- Manifest: name "SPHR Flashcards", short_name "SPHR", `display: "standalone"`,
  `start_url` and `scope` `/SPHR-Flashcards/`, theme colours, PNG icons 192/512 + maskable,
  and an `apple-touch-icon` (180 px) link in `index.html`.
- Detect standalone mode (`matchMedia('(display-mode: standalone)')` or
  `navigator.standalone`). In Safari (not installed) show a short "Add to Home Screen"
  instruction card instead of the reminder switch.
- A CSP meta tag injected at build: `default-src 'self'; connect-src 'self'
  https://<ref>.supabase.co; img-src 'self' data:; style-src 'self'; script-src 'self';
  frame-ancestors 'none'` (adjust only as needed and record why). A frame-busting check.

**Tests (Playwright, production build served locally)**: the manifest is valid and
linked; the service worker activates; **offline use**: load, go offline, reload, start a
lesson, answer, see the queued count, go online, see the count drop to 0; the **update
flow**: build A, load, build B, reload → banner → Reload → new build id.

---

## Phase 7: Daily reminder (Web Push)

Facts to design around (iOS/iPadOS 16.4+ home-screen web apps; see HANDOFF §4 for
sources and what is unverified):
- Push only works in the **installed** home-screen app, not in a Safari tab.
- `Notification.requestPermission()` and `pushManager.subscribe()` must be called
  **directly inside a tap handler** (no `await` on other work before them), only in
  standalone mode.
- Use standard Web Push with VAPID; `userVisibleOnly: true`; every push must show a
  notification (no silent pushes).
- Subscriptions can expire or be revoked: on every app start, if permission is granted,
  call `pushManager.getSubscription()` (subscribe again if it is null) and
  `save_push_subscription` (an upsert). The server disables endpoints that return 404/410.

Client:
- Settings → "Daily reminder": a switch and a time picker (15-minute steps, default 15:00),
  showing the device time zone, which is saved with the settings. Turning it on runs the
  permission + subscribe flow from the tap. If permission is denied, show how to re-enable
  it in iPhone Settings (text from `docs/INSTALL.md`). Turning it off sets
  `reminderEnabled = false` and calls `disable_push_subscription`.
- Service worker `push` handler shows the notification: title "SPHR Flashcards", body
  **"You should practice some questions"**, the app icon; `notificationclick` opens or
  focuses `/SPHR-Flashcards/`.

Server:
- Edge Function `send-reminders` (Deno, `verify_jwt = false`). It **requires** the header
  `x-cron-secret` to equal the `CRON_SECRET` secret, otherwise it returns 401. It uses the
  built-in `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` env vars server-side only. For each
  settings row with `reminder_enabled`: compute the local time in `time_zone`; if it is
  within `[reminder_time, reminder_time + 15 min)` and there is no `reminder_log` row for the
  local date, insert the log row first (pk prevents duplicates), then send to each active
  subscription using a well-known Web Push library (`npm:web-push` under Deno, or
  `jsr:@negrel/webpush`; verify in the local Deno test that it works in the Edge runtime)
  with `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. On 404/410 set
  `disabled_at`; on success set `last_success_at`; other errors increment `failure_count`
  and are logged. Returns a JSON summary.
- Schedule: `pg_cron` job `send-reminders`, `*/15 * * * *` (pg_cron runs in UTC, which is
  fine because the function does the time zone math), calling the function through `pg_net`
  with the project URL and cron secret read from **Vault** (`vault.decrypted_secrets`).
  The exact SQL goes in `docs/SETUP.md` step B9 (paste-ready, with the placeholders the
  owner fills in).
- VAPID keys: the build session generates a key pair once (`npx web-push
  generate-vapid-keys`) and gives the private key to the owner **in chat only** (never in a
  file, commit, log or workflow output) to paste into Supabase secrets. The public key goes in
  the repo variable `VITE_VAPID_PUBLIC_KEY` and the `VAPID_PUBLIC_KEY` secret.

**Tests**: a Deno unit test of the function's time-window logic over many zones and DST
transitions (America/Los_Angeles spring forward and fall back: exactly one reminder per local
day, none skipped); a 401 without the secret; 410 → disabled; a duplicate run in the same
window sends once. A Playwright test with a mocked `PushManager` shows the permission flow
is triggered from the tap, and that the subscription is saved and re-saved on start.

Free-plan budget: 96 invocations a day ≈ 2,900 a month, against the free quota of
500,000 Edge Function invocations a month.

---

## Phase 8: Backups, keep-alive, and the question import

- **Export/import progress** (phase 1h UI): Settings → Export progress downloads
  `sphr-progress-YYYY-MM-DD.json` (iOS shows the share sheet: "Save to Files"). Settings shows
  "Last export: N days ago". Import: pick a file → preview → confirm → merge.
- `.github/workflows/keepalive.yml`: `schedule: cron '17 15 * * *'` + `workflow_dispatch`,
  `permissions: {}`; calls `POST {SUPABASE_URL}/rest/v1/rpc/keepalive` with the secret key
  from `secrets.SUPABASE_SECRET_KEY` passed via `env:`; fails visibly on a non-2xx response.
  The URL comes from the repo variable `VITE_SUPABASE_URL`.
- `.github/workflows/import-questions.yml`: `workflow_dispatch` only, input `apply`
  (boolean, default false), `permissions: contents: read`. Steps: checkout `main`; run
  `node scripts/validate-bank.mjs` (the job stops if it fails); `node scripts/import-bank.mjs`
  calls `rpc/import_bank` with `p_apply` from the input (via `env:`), prints the summary
  table to the job summary (`$GITHUB_STEP_SUMMARY`): new / changed / unchanged / newly
  retired / errors; it fails if there are errors. The first line of the summary says
  **"PREVIEW ONLY: nothing was written"** or **"APPLIED: N new, M changed"**.
- `scripts/import-bank.mjs` sends the bank as one JSON payload (≈600 KB, within PostgREST
  limits; if not, it sends in chunks of 100 questions, each its own dry-run/apply call, and
  stops at the first error).

**Tests**: import-bank.mjs against local Postgres (dry run → apply → re-run no-op, using the
fake bank); the workflow YAML is linted (actionlint if available) and checked for
`${{ }}` inside `run:`.

**New-questions flow, end to end** (an e2e test plus the owner's steps in SETUP Part F):
fake bank v1 deployed → the device caches it → fake bank v2 with 2 new questions, 1 stem
edit and 1 retirement is "deployed" (the bundled file changes) → app reload → the new cards
are available, the edited card keeps its state, the retired card is gone; then the import is
simulated (the mocked Supabase returns v2) → no duplicate questions, same state.

---

## Phase 9: End-to-end, reviews, go-live

Playwright, production build with CSP, mocked Supabase (route interception), **iPhone
13 Pro Max device profile** (428×926, `hasTouch`, `isMobile`, WebKit UA). Chromium is the
engine available; note in HANDOFF that real-device checks happen on her phone (INSTALL
§5 checklist).

Scenarios:
- Sign in; sign-in error; no sign-up path exists.
- **Every question type**, each answered right and wrong, checking the feedback (XP shown on
  right; the answer and explanation on wrong; no wrong-reasons or citations shown).
- A scenario question shows the scenario above the stem.
- **Ordering by touch drag** (`page.touchscreen` / pointer events with touch) **and** by
  ▲/▼ buttons **and** by tap-to-place; **matching by touch drag and by tap-tap**; keyboard
  only for both.
- Multi: Check is disabled until exactly 2 are chosen.
- Choice order differs across two showings (seeded RNG hook in test mode); no letters
  are visible.
- Studying several areas at once only draws from the selected areas.
- Daily new cap: after 15 new cards, only reviews / "All caught up".
- Mistakes: a wrong card appears in Mistakes; after correct answers on two different
  (fake-clock) days it leaves.
- Progress bars and a tier badge update after mastery (fake bank with a tiny tier).
- XP total and the daily ring update; the ring resets at local midnight (fake clock).
- Offline, conflict and two-device (two browser contexts) flows from phase 3.
- Export → sign out → sign in as fresh → import → identical progress.
- XSS payloads render as text.
- PWA installability, offline use, update banner (phase 6).
- The reminder settings flow (phase 7, mocked push).
- The new-questions flow (phase 8).

Then, per the playbook:
1. Mutation checks (phase 2 list, plus the grading rules: loosen the text normalizer and
   confirm a test fails).
2. Two independent review passes: (a) code review for bugs, (b) black-box security attack
   on the deployed-shaped build and the SQL. Fix, then re-run everything.
3. Hand the owner the go-live steps in `docs/SETUP.md` (they run the SQL and set the
   secrets), then INSTALL on her phone, then the real-device checklist in `docs/INSTALL.md` §5.
4. Record "live" in HANDOFF and NOTES.

**Acceptance for go-live**: the full check chain is green on `main`; the deploy run says
"success"; the owner has done SETUP Parts A–E; the real-device checklist passes on her phone.
