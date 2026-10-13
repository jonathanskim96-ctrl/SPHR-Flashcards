# App-building playbook (portable)

Distilled from building Horizon Tasks: a single-user installable PWA on React +
Vite + TypeScript + Supabase, deployed free on GitHub Pages. Drop this file
into a new project, or paste it at the start of a new Claude session. Adapt the
stack bits; the **process and safety rules** apply to any app.

---

## 1. How to work with the owner (non-technical)

- Assume zero experience. Give exact clicks and exact links, one step at a time.
- When the owner must paste something, **paste the content in the chat** (a code
  block with a copy button). Don't hand over a link to the file: the owner will
  paste the link itself into the editor (this happened with the SQL editor).
- **Ask before deciding product-behaviour trade-offs.** Offer 2–3 options with a
  recommendation. Don't assume. Record the answers in the handoff doc.
- Say plainly what each step changes and what happens if they skip it.
- Say what is verified and what is not. If tests fail, show it. Never hide a
  skipped step.
- Confirm outward-facing or hard-to-reverse actions first (pushing to main,
  running migrations, deleting anything).

## 2. Standing rules for every AI session (put in `CLAUDE.md`)

The owner's data and the app's working structure outrank any feature or "make it
work" instruction. AI tends to chase the outcome even if that means deleting a
database, so bake in guardrails:

- **Never destroy data or structure to make something pass or fit.** No
  drop/truncate/mass delete, no resetting the database, no disabling a check or
  test, unless the owner asked for that exact action in this conversation. If the
  only way forward looks destructive: stop and ask.
- **Migrations are additive.** New numbered file only; never edit, delete or
  reorder an applied one. A lock file of hashes + CI enforces it. Destructive SQL
  needs an inline `-- guardrail-approved: <who, date, why>` comment, written only
  after explicit owner approval of that statement.
- **Before the owner runs any migration:** have them export a backup, and say what
  the migration changes.
- **Safety log:** an append-only copy of every update/delete (via triggers), plus
  mass-delete caps in the write RPC, plus a written recovery doc and a tested
  recovery script. Never weaken these.
- **Git:** never force-push, rewrite published history, or delete a branch/tag
  without an explicit request. Never push to main with failing checks.
- **Guardrail tests are not obstacles.** If one fails, fix the change, not the
  test, unless the owner explicitly approves the widened behaviour.
- Keep a **`docs/HANDOFF.md`** (compact current state, decisions, open items,
  how to run checks) and tell every new session to read it first. Keep a longer
  `NOTES.md` for history.

## 3. Security checklist (apply to every change; re-check the diff before push)

- **Secrets:** never commit `.env*` (except `.env.example`), exports, task data,
  service-role/secret keys, OAuth client secrets, DB passwords. Only the project
  URL + publishable key go client-side (from `.env.local` / repo *variables*).
  Grep the diff for `sb_secret`, `service_role`, `eyJ`, `GOCSPX`.
- **Database:** every table gets RLS with `user_id = (select auth.uid())` policies
  `to authenticated`, and `revoke all … from anon`. Functions are
  `security invoker` with `set search_path = public`; revoke execute from
  `public, anon`. No `security definer` without sign-off. Revoke TRUNCATE etc.
  from app roles. Add behavioural checks for every new table/function.
- **Validate on write** in one domain validator, mirrored by DB constraints (types,
  integer checks, size limits). Reject `3.7` rather than letting Postgres round it.
- **Rendering:** no `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`.
  User text only through React text nodes. Colours through a `safeColor()` hex
  whitelist. Never build URLs from user input. Add every new user-visible text
  field to an XSS scenario in the browser tests.
- **One write path:** all writes through a single guard (`guardedWrite(key, fn)`)
  → one atomic RPC (`apply_changes`) that takes a whole change set, rejects stale
  writes, and caps mass deletes. No second code path.
- **Offline data** (IndexedDB) is keyed by user id and wiped on sign-out.
- **Errors are always shown in the UI**, never swallowed.
- **Destructive actions** need in-app confirmation. Never `confirm/alert/prompt`.
- **CSP** meta injected at build; frame-busting; auth via PKCE.
- **Dependencies:** only well-known packages; run `npm audit` after adding one.
- **CI:** least-privilege `permissions:`; untrusted values via `env:`, never
  `${{ }}` directly inside `run:`.
- Lock down sign-up after the first sign-in (disable new signups and
  email/password if only Google is used).

## 4. Architecture that worked

- **Pure domain layer** (`src/domain/`): validators, planners (`planCreate`,
  `planUpdate`, `planFinish`, `planDelete`, `planRestore`, …) that return a
  `ChangeSet`, a pure `applyLocal(snapshot, changeSet)` (idempotent), import/export,
  sorting/placement. No I/O, so it's easy to unit test and fuzz.
- **Data layer** (`src/data/`): row↔domain mapping that **normalizes defensively**
  (anything from the DB or an import file is untrusted), API wrapper, a store hook
  with a local cache, ordered **offline outbox**, realtime subscription, a gentle
  poll as fallback, and flush-on-reconnect.
- **UI** (`src/ui`, `src/screens`): thin; only calls planners via the store's
  `commit`.
- **Optional fields = nullable end to end** (type, validator, DB column, snapshot,
  import/export, sort, UI marker). Check every place a field is read: sorting,
  grouping, restore, recovery script, CSV, snapshots.
- **Offline rules:** edits apply instantly, queue in order, replay on reconnect;
  server rejections are dropped and reported; never lose a change made while a
  flush is in flight (edit the queue by id).
- **PWA:** `vite-plugin-pwa` (generateSW with skipWaiting + clientsClaim +
  cleanupOutdatedCaches), custom register file, build id in the footer, a
  "Reload" banner when a new release arrives mid-use, manifest shortcuts,
  install button, iOS "Add to Home Screen" instructions, PNG + maskable icons.
- **Deploy:** GitHub Pages via Actions: `verify` (migration guardrail, typecheck,
  lint, unit, DB tests) → build → deploy; refuse to publish if verify fails.
  Repo *variables* (not secrets) hold the two public values. A branch ruleset on
  main blocks deletion and force-push. Use **per-branch concurrency**
  (`group: pages-${{ github.ref }}`); a shared group let a branch push cancel the
  main deploy.

## 5. Testing: layers that each caught real bugs

Run before every push:

```
node scripts/check-migrations.mjs && npm run typecheck && npm run lint \
  && npm test && npm run build && ./supabase/tests/run.sh && npm run e2e
```

1. **Unit + fuzz** (vitest): random operation sequences against the pure domain,
   checking invariants (tree depth, due-date ordering, no duplicate ids, planners
   leave valid state). Include null/blank values for optional fields.
2. **Real Postgres locally** (no cloud needed): auth shim + migrations applied in
   order, then RLS tests, an **attack suite** (cross-user access, forged ids,
   bad types, oversized input, TRUNCATE, mass delete), a **recovery test** (delete
   things, run the documented recovery script, assert it all comes back, and that
   legitimately completed items are NOT resurrected), and an **app↔DB contract
   test** (every planner round-trips through the real RPC and reads back
   identical).
3. **Browser e2e** (Playwright, production build with CSP, mocked backend):
   happy paths, offline/queue/conflict, two-device races, XSS payloads, PWA
   installability, update flow. Chromium is pre-installed; don't run
   `playwright install`.
4. **Mutation checks:** deliberately weaken a guardrail (remove an ownership check,
   a cap, a constraint) and confirm a test fails. If nothing fails, the test is
   missing. One attempt here (removing a `user_id` comparison) did *not* fail, so
   the first mutation was too weak. Remove the whole check and re-run, and
   restore the file afterward.
5. **Two independent review passes before going live:** (a) code review for bugs,
   (b) black-box security attack. Then a full re-run, because AI sessions
   quietly introduce side-effect problems.
6. **Test for failure, then fix** (reproduce → fix → same check passes). Never
   skip or weaken a test to get green.

## 6. Supabase specifics

- Region near the user. Tables: categories, tasks, completions (history,
  append-only, no update policy), profiles (one-time seeding flag), safety_log.
- Atomic RPC `apply_changes(inserts, updates, deletes, completions,
  history_deletes)` with stale-write guard (a task completed on two devices is
  recorded once) and caps.
- Ownership trigger on tasks (category/parent belong to the same user; depth
  consistency). When a column becomes optional, update the trigger so it only
  checks when a value is present; and update any test that relied on "NOT NULL"
  to block cross-user references (use a real foreign id captured as owner).
- Realtime publication only for the tables the app needs.
- Google sign-in: OAuth client in Google Cloud, redirect URI =
  `https://<ref>.supabase.co/auth/v1/callback`; Site URL + Redirect URLs set to
  the Pages URL (including the repo path). "Ineligible accounts" test-user error →
  use the exact account email, or publish the app (needs Branding page filled in,
  no logo) and then lock sign-ups in Supabase.
- The Supabase SQL editor shows a "destructive operations" warning for any file
  containing `delete`/`on delete cascade`. It's a scanner false alarm for
  definitions; explain that to the owner before they click Run query.
- The cloud agent environment can't reach Supabase or github.io. The owner runs
  SQL in the SQL editor; everything else is tested locally against Postgres.

## 7. Release routine (what a good change looked like)

1. Ask product questions (options + recommendation) → record answers.
2. If the schema changes: new numbered migration with approved
   `guardrail-approved` markers, `node scripts/check-migrations.mjs --record`,
   attack/RLS/recovery tests extended, **write the app so it still works before
   the migration is applied** (a visible error, never data loss).
3. Change domain → data → UI; extend unit, fuzz, contract, e2e; update
   HANDOFF/NOTES/SETUP.
4. Run the full check chain; grep the diff for secrets/unsafe APIs.
5. Commit; push; (owner backs up via in-app export, runs migration in SQL editor).
6. Push to main only after the owner confirms the migration; wait for the deploy
   workflow to finish and verify success (not "cancelled"/"skipped").
7. Record "applied" in HANDOFF/NOTES.

## 8. Gotchas we hit (don't repeat)

- `pkill -f <pattern>` kills your own tool shell if the pattern appears in the
  command line. Stop servers with `fuser -k <port>/tcp`.
- Service worker never activated until `skipWaiting`/`clientsClaim` were set.
- A reload that started before a write finished can overwrite it with stale
  data: bump a write counter and discard stale loads.
- Recovery scripts must handle parents-before-children, cross-user rows, orphans,
  and *every nullable column*. A recovery script that required a category would
  have silently skipped uncategorised tasks; the recovery test caught it only after
  that case was added.
- Date-dependent e2e tests rot: use `iso(offset)` and a 30-day view rather than
  hard-coded dates or weeks.
- A trap like `trap 'kill $PID' EXIT` turns a passing script into exit 1 if the
  process already ended; use `kill $PID 2>/dev/null || true`.
- Playwright strict mode: scope selectors (`dlg(page).locator('.btn-row')…`) when
  a label like "Close" appears twice.
- Keep Node types out of the app tsconfig; put Node-based guardrail tests in
  `scripts/`.
- Don't put a help paragraph in a UI the owner will see every day unless asked;
  they removed it.

## 9. Starting a new project from this

1. Create the repo (public if code-only; data never in the repo), add `CLAUDE.md`
   (sections 2–3), `docs/HANDOFF.md`, `NOTES.md`, `docs/SETUP.md` (click-by-click),
   `docs/RECOVERY.md`.
2. Scaffold Vite + React + TS + vite-plugin-pwa; set up lint, typecheck, vitest.
3. Write migration 0001 with RLS, constraints and ownership triggers; the
   migration lock + checker script; local Postgres test harness (`run.sh`).
4. Build the domain layer first, with tests and a fuzzer; then the data layer; then
   UI; then PWA; then the e2e suite.
5. Add the guardrail migration early (safety log, TRUNCATE revoke, caps), not
   after launch.
6. Deploy workflow gated on checks; ruleset on main.
7. Two review passes, mutation checks, then go live; import existing data via the
   app's importer (preview first, idempotent), never via the repo.

## 10. Prompt to open a new session with

> Read `CLAUDE.md` and `docs/HANDOFF.md` first. Follow the data-safety and
> security rules exactly. Ask me before deciding product behaviour. I'm
> non-technical: explain steps plainly with exact clicks. Run the full check chain
> before every push and tell me honestly what passed and what didn't. Never
> destroy data or structure to make something work.
