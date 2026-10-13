# NOTES: SPHR Flashcards history

Longer history than `docs/HANDOFF.md`. Newest entries at the bottom.

## 2026-10-13: Planning

Planning session wrote `CLAUDE.md`, `docs/HANDOFF.md`, `docs/BUILD_PLAN.md`,
`docs/SETUP.md`, `docs/RECOVERY.md`, `docs/INSTALL.md`, moved the bank to
`content/questions.json` with its schema doc and validator. Merged to `main` as PR #1.

## 2026-10-13: Phase 0 (scaffold, CI, guardrails)

Branch `ccr-67c10ae0-ubtsvr`.

- Scaffold: Vite 8.3, React 19.3, TypeScript 5.9 strict (TS 7 and 6.1 are out, but
  typescript-eslint supports only < 6.1), vite-plugin-pwa 2.0 (manifest + generateSW with
  skipWaiting/clientsClaim/cleanupOutdatedCaches; register file, icons, CSP in Phase 6),
  ESLint 10 flat config, Prettier, vitest 5, Playwright 1.56.1 (pinned to match the
  pre-installed Chromium build 1194). `npm audit`: 0 vulnerabilities.
- `tests/fixtures/sample-bank.json`: 19 fake questions ("FAKE:" stems, nonsense topics)
  covering every Phase 0 requirement; a vitest test keeps it covering them. MC answers
  A C B D C A D B in source order (passes the letter scan).
- `tests/fixtures/bad-banks/`: missing answer, duplicate id, ordering already in order,
  matching option used twice, "all of the above", run of 3 answer letters. Each must fail
  for its expected reason (`scripts/validate-bank.test.mjs`).
- `scripts/check-migrations.mjs`: sha256 lock, numbering, `--record` never rewrites an
  existing hash, plus a destructive-SQL scan requiring `-- guardrail-approved:`.
- `scripts/build-bank.mjs`: validator first, then copies to `public/bank.json` (gitignored).
- `supabase/tests/run.sh`: throwaway PostgreSQL via `initdb` (Docker not needed), auth shim,
  migrations in order, `*.test.sql` in order, `ON_ERROR_STOP`. Verified that a failing
  `assert` makes it exit non-zero.
- CI: `ci.yml` (push to non-main branches, PRs, and called by deploy), `deploy.yml` (push to
  main: verify = ci.yml → build with repo variables → Pages; per-branch concurrency).
  The bank is validated with `--previous` = the base commit's copy
  (`scripts/ci-validate-bank.sh`).
- Mutation-style checks done locally: an injected `assert 1 = 2` test file made `run.sh`
  exit 3; a scratch file with `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `alert`,
  `new Function` gave 5 lint errors. Both scratch files removed.
- Acceptance on GitHub: CI run 38354068917 (commit cc3c09e) green, all 14 steps. Then a
  deliberately broken **fake** bank (duplicate id) was pushed: CI run 38354373105 failed at
  "Validate the fake test bank" with `fake2-q05: duplicate id`. Undone with a revert commit
  (no force-push). The real bank was never modified. A bad *real* bank stops CI at the
  first validation step the same way, and `deploy.yml` builds only after `verify` (= CI)
  passes, and `build-bank.mjs` refuses to copy an invalid bank (tested), so a bad bank
  cannot be deployed.

## 2026-10-13: Phase 1 (domain layer)

Owner approved Phase 0 and asked for Phase 1 on the same branch, no merge to `main`.

- `src/domain/` modules as listed in HANDOFF §1. Pure functions; `today`/`now` are passed in.
- Answer fingerprint: SHA-256 (`@noble/hashes`, sync, audited) over canonical JSON (keys
  sorted) of the graded fields, with choices/items/prompts/options sorted by id and
  `accepted`/multi answers sorted, so reordering in the file never resets progress. A test
  pins the value for `fake1-q01` (`b095ba8822800878`), computed independently with Node's
  crypto: if the formula ever changes, that test fails before anyone's progress resets.
- Grading follows BUILD_PLAN 1b exactly; all real-bank edge cases listed in the plan pass,
  and every one of the 400 real questions grades its own canonical answer as correct (and
  every other single mc/multi choice as wrong). The real bank is only read.
- `scripts/norm-parity.test.mjs` imports `src/domain/textNorm.ts` directly (Node 22 strips
  types), checks the expression is byte-identical to the validator's, and fuzzes both on
  10,000 strings including Unicode spaces, dashes and curly quotes.
- Fuzz (fast-check, 1,000 runs, seed 20261013): box range, due ≥ last answer + 1, exam cap,
  Mistakes membership vs an independent model, order-independence, union merge order, XP
  totals, lesson invariants (no duplicates, no retired, no same-day repeats, selection only).
- Coverage reached 100% by restructuring two unreachable fallbacks (not by excluding lines).
- Settings default `reminderEnabled: false` (asked the owner; see HANDOFF).

## 2026-10-13: Phase 2 (database)

Owner approved Phase 1, chose the one-time reminder card (HANDOFF §2), and approved
**option A** for the safety log: a single SECURITY DEFINER trigger function `log_change`.

- Migrations 0001–0003 written and locked. Not run on Supabase yet.
- Local harness now mimics Supabase more closely: migrations run as non-superuser
  `migrator`; new tables/functions get Supabase's open default grants, so the tests prove
  0002 revokes them.
- Bugs the tests caught while building: a regex repetition `{16,256}` (Postgres max is 255)
  in two push-subscription checks; the migration scanner flagging `create trigger … before
  truncate` (a protective rule) as destructive, fixed by treating `create …` as non-destructive
  (test added).
- The recovery test runs the exact recovery files with only the `PASTE_…` values filled in,
  as the non-superuser admin: look-first, dry run (writes nothing), restore (settings,
  subscription and 10 deleted questions come back byte-identical; a question changed again
  after the window is skipped), a second restore is a no-op, and wiped answers re-imported
  from `tests/fixtures/sample-export.json` through `apply_changes` are identical.

Mutation checks (2026-10-13; each change made to a copy, the full DB suite run, file restored):

| Mutation | Caught by |
|---|---|
| attempts select policy `user_id = auth.uid()` → `true` | 20_rls "B sees A's answers" |
| append-only trigger on attempts removed | 30_attack (service role update succeeded) |
| 200-answer cap removed | 30_attack "too many answers" |
| import "missing id" check removed | 40_import |
| settings safety-log trigger removed | 10_schema |
| mass-delete cap raised to 50 | 30_attack "limit 5" |
| settings stale-write check removed | 20_rls conflict test |
| override usable by app roles | **not caught at first** (grants block earlier); added a defence-in-depth test that grants the app delete rights in a rolled-back transaction; now caught |
| recovery ignores "changed after the window" | 50_recovery |
| xp check loosened in `attempt_problem` | 30_attack (constraint then fails the batch) |
| `revoke … from anon` removed | 10_schema |
