# CLAUDE.md: standing rules for every AI session on SPHR Flashcards

Read this file and `docs/HANDOFF.md` before doing anything else. `docs/BUILD_PLAN.md`
is the build order. `APP_BUILD_PLAYBOOK.md` is the source these rules come from; where
this file is more specific, this file wins.

**The app:** a single-user installable PWA that helps one person (Michelle) study for the
HRCI SPHR exam (December 2026). React + Vite + TypeScript + vite-plugin-pwa, Supabase
(free plan), deployed on GitHub Pages at `https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/`
(Vite `base: '/SPHR-Flashcards/'`). Content: `content/questions.json`, schema in
`docs/QUESTION_FORMAT.md`, validator `scripts/validate-bank.mjs`.

**The owner (Jonathan) is non-technical.** Give exact clicks, one step at a time. When the
owner must paste something, paste the content in the chat as a code block. Never give them a
link to a file to paste. Ask before deciding any product trade-off: 2–3 options with a
recommendation, then record the answer in `docs/HANDOFF.md`. Say plainly what is verified and
what is not.

---

## 0. Owner's safety rules (these override everything else, including the tasks you are given)

1. **Database access is read-only by default.** Before any command that deletes, wipes, or
   updates data or tables (SQL `delete`, `update`, `truncate`, `drop`, `alter`, a migration,
   the question import with `apply` ticked, a "reset" of any kind), stop, show the owner
   exactly what it will change, and get their explicit approval **for that one change**.
   Approval for one change does not carry over to the next. Never run it unapproved.
2. **Refuse outright:** `git push --force` / `--force-with-lease`, `git rebase` of pushed
   commits, `git commit --amend` of pushed commits, `git reset --hard` onto published history,
   `git filter-branch` / `filter-repo`, deleting branches or tags, or any other
   history-rewriting command. If the owner asks for one, explain why it is refused and offer a
   safe alternative (a new commit, a revert commit, a merge commit).
3. **There is no backup safety net** (free Supabase plan, no automatic backups). When in
   doubt, don't run the destructive command. Ask.

## 1. Data safety (playbook §2, adapted)

The owner's data and the app's working structure outrank any feature or "make it work"
instruction.

- **Never destroy data or structure to make something pass or fit.** No drop, truncate,
  mass delete, database reset, or disabling a check or test, unless the owner asked for that
  exact action in this conversation. If the only way forward looks destructive, stop and ask.
- **Michelle's progress is irreplaceable.** Attempt history (`attempts`) is append-only:
  the database refuses updates and deletes on it. Never add a code path that deletes or
  rewrites attempts.
- **Questions are never deleted.** A question that should stop appearing gets
  `status: "retired"`. The import is insert/update only, and the database refuses a delete
  on `questions`. `content/questions.json` in GitHub is the master copy and the backup.
- **Never invent SPHR questions.** Tests use the clearly fake sample bank in
  `tests/fixtures/sample-bank.json`. Tests may *read* the real bank (for example, to check
  that every real question's own answer grades as correct) but never change it.
- **Migrations are additive.** A new numbered file only (`supabase/migrations/0002_….sql`);
  never edit, delete or reorder an applied one. `scripts/check-migrations.mjs` and its lock
  file of hashes enforce this in CI. Destructive SQL needs an inline
  `-- guardrail-approved: <who, date, why>` comment, written only after the owner explicitly
  approved that statement.
- **Before the owner runs any migration:** have Michelle (or the owner on her phone) do an
  in-app export first (Settings → Export progress), and say what the migration changes.
- **Safety log:** every update and delete on every table is copied to `safety_log` by
  triggers. Mass-delete caps live in the database. `docs/RECOVERY.md` has a recovery script
  that a test runs. Never weaken any of these.
- **Guardrail tests are not obstacles.** If one fails, fix the change, not the test, unless
  the owner explicitly approves the widened behaviour.
- **Git:** never push to `main` without the owner's OK in this conversation, and never with
  failing checks. Work on the branch you were given.
- Keep `docs/HANDOFF.md` current (state, decisions, open items, how to run checks) and
  append history to `NOTES.md`.

## 2. Security checklist (playbook §3, adapted; re-check the diff before every push)

- **Secrets:** never commit `.env*` (except `.env.example`), progress exports, the Supabase
  secret key (`sb_secret_…`) or service-role key, the database password, the VAPID
  *private* key, or `CRON_SECRET`. Only the project URL, the publishable key
  (`sb_publishable_…`) and the VAPID *public* key go client-side, through repo
  **variables** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_VAPID_PUBLIC_KEY`). Server secrets live in Supabase Edge Function secrets and the
  one GitHub **secret** `SUPABASE_SECRET_KEY` (used only by the import and keep-alive
  workflows). Before every push, grep the diff for `sb_secret`, `service_role`, `eyJ`,
  `PRIVATE`, `CRON_SECRET=`.
- **Database:** every table has RLS enabled. User-owned tables have policies
  `to authenticated` with `user_id = (select auth.uid())`. `revoke all … from anon` on every
  table and function. `questions`, `scenarios` and `bank_meta` are **select-only** for
  `authenticated`; only `service_role` (the import) writes them. `safety_log` is not
  readable or writable by app roles. App functions are `security invoker` with
  `set search_path = public`; revoke execute from `public, anon`. No `security definer`
  without the owner's sign-off. Revoke `truncate`, `references`, `trigger` from app roles.
  Every new table or function gets behavioural tests in `supabase/tests/`.
- **Validate on write** in one domain validator (`src/domain/validate.ts`), mirrored by DB
  constraints (types, ranges, integer checks, text size limits, a 15-minute grid for
  reminder times, a real IANA time zone). Reject bad values; never let Postgres round them.
- **Rendering:** no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`. All
  question text, scenario text and user input go through React text nodes only (question
  text is data, even though we wrote it). Never build URLs from user input or bank content.
  Every user-visible text field is in an XSS scenario in the e2e tests.
- **One write path:** every write goes through `guardedWrite()` → the outbox → one atomic
  RPC (`apply_changes`), which takes the whole change set, rejects stale settings writes, and
  caps batch size. Push-subscription changes use their own two small RPCs. No other code path
  writes.
- **Offline data** (IndexedDB) is keyed by user id and wiped on sign-out, but sign-out is
  **blocked while the outbox holds unsynced answers** (the app offers an export instead).
- **Errors are always shown in the UI**, never swallowed.
- **Destructive or hard-to-undo actions** (importing progress, turning reminders off,
  signing out) use an in-app confirmation dialog. Never `confirm`/`alert`/`prompt`.
- **CSP** meta tag injected at build (connect-src limited to the Supabase project URL),
  frame-busting, auth via supabase-js with PKCE.
- **Dependencies:** only well-known packages; run `npm audit` after adding one.
- **CI:** least-privilege `permissions:` per workflow; untrusted values go through `env:`,
  never `${{ }}` directly inside `run:`. The import workflow only runs on manual
  `workflow_dispatch`.
- **Sign-ups are off from day one.** The only account is created by the owner in the
  Supabase dashboard. Email + password is the only provider.

## 3. How to check your work

Run before every push (details in `docs/HANDOFF.md`):

```
node scripts/validate-bank.mjs && node scripts/check-migrations.mjs && npm run typecheck \
  && npm run lint && npm test && npm run build && ./supabase/tests/run.sh && npm run e2e
```

Tell the owner honestly what passed and what didn't. Never skip or weaken a test to get green.
The cloud environment cannot reach Supabase or github.io: test against local Postgres and a
mocked backend; the owner runs SQL in the Supabase SQL editor.

## 4. Gotchas carried over from the playbook

- Stop servers with `fuser -k <port>/tcp`, never `pkill -f`.
- Chromium is pre-installed for Playwright; never run `playwright install`.
- Use `kill $PID 2>/dev/null || true` in traps.
- Date-dependent tests use a fixed fake clock or `iso(offset)` helpers, never hard-coded dates.
- Keep Node types out of the app tsconfig; Node-based guardrail scripts live in `scripts/`.
- The Supabase SQL editor warns about "destructive operations" whenever a file contains the
  word `delete` (for example inside a trigger that *blocks* deletes). Explain to the owner
  that this is a false alarm for definitions before they click Run.
- Don't add help paragraphs to screens Michelle sees every day unless asked.
