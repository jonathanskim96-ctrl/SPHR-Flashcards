# HANDOFF: SPHR Flashcards

Every session reads this first, right after `CLAUDE.md`. Keep it short and current.

## 1. Current state (2026-10-13)

- **Phase 8 (backups, keep-alive, question import) approved** by the owner (2026-10-13) on
  branch `ccr-67c10ae0-ubtsvr`. Phases 0–8 approved; nothing merged to `main`.
  **Next: Phase 9** (end-to-end, reviews, go-live), in a new chat (see §6).
  **The migrations have NOT been run on Supabase** (the project doesn't exist yet; SETUP
  Part B3 runs them later). Until then the real app shows "The app is not configured" (the
  Supabase address and key are repo variables set in SETUP); everything was tested against
  a pretend server. **The reminder function is not deployed** (SETUP B7–B9 do that), and
  the VAPID key pair was given to the owner in chat only (never in a file).
- Phase 8 contents: `.github/workflows/keepalive.yml` (daily 15:17 UTC + manual button,
  `permissions: {}`, one POST to `rpc/keepalive` with the secret passed through `env:`, fails
  on any non-2xx, URL from the repo variable `VITE_SUPABASE_URL`);
  `.github/workflows/import-questions.yml` (manual only; `apply` input, default off;
  `contents: read`; checks out `main`; the validator runs first and stops the job; then
  `scripts/import-bank.mjs`, whose Markdown summary goes to the job summary: first line
  **"PREVIEW ONLY: nothing was written"**, **"APPLIED: N new, M changed"** or **"FAILED: nothing
  was written"**, then a table of new / changed / unchanged / newly retired / errors);
  `scripts/import-bank.mjs` (one call = one transaction, since the database function refuses a
  question that is missing from the payload, so chunking would not work; writes only when
  `APPLY` is exactly `true`; the address must be https, never prints the key). Settings now
  says **"Last export: today / yesterday / N days ago"** (calendar days in her time zone;
  `src/ui/exportAge.ts`); export, import-with-preview and sign-out guard were already built in
  Phase 5. Tests: `scripts/import-bank.test.mjs` (pretend server), `scripts/workflows.test.mjs`
  (no `${{ }}` inside `run:` in any workflow, permissions, import manual-only and
  validator-before-import, keep-alive schedule, the secret used only by those two workflows;
  runs `actionlint` too when installed, which it is **not** here), `supabase/tests/contract/
  import.test.ts` (the real script, as the workflow runs it, against the real `import_bank`
  in local Postgres through a stand-in web address: fake bank preview → apply → re-run no-op;
  a second version with new / edited / retired questions; refusals of a deleted question, a
  change without a raised revision, an older version, a wrong key; the real bank read-only:
  400 new, apply, re-run no-op; each call is rolled back), `e2e/newQuestions.spec.ts` (the
  new-questions flow on production builds: v1 loaded and a card answered → v2 "deployed" with
  2 new, 1 edited, 1 retired → counts right, the two new cards offered, the edited card not
  offered again today (state kept), the retired card gone → the import simulated: no
  duplicates, same counts, nothing re-downloaded), `exportAge.test.ts`. 6 mutation checks in
  NOTES.md. No new dependencies.
- Phase 7 contents: **server** `supabase/functions/send-reminders/index.ts` (one file, pasted
  into the dashboard in SETUP B8): checks `x-cron-secret` (401 otherwise; 500 if
  `CRON_SECRET` is unset), reads `settings` rows with the reminder on and each account's
  active `push_subscriptions` as the service role (PostgREST via supabase-js), decides
  "due" in the account's time zone (below), inserts the `reminder_log` row **before**
  sending (its key = one per local day; a duplicate claim (23505) means "already sent"),
  sends with `npm:web-push@3.6.7` (VAPID, `TTL` 6 h, topic `daily-reminder`), then sets
  `last_success_at` / `disabled_at` (404/410) / `failure_count + 1` (anything else). Returns
  a JSON summary and logs it (never an endpoint, only its host). Deno config
  `supabase/functions/deno.json` + `deno.lock` (pinned, checked). **When a reminder is due:**
  the run's time is rounded to the nearest quarter hour; the reminder time "happens" at the
  first quarter-hour of the local day whose clock is at or past it (so 2:30 AM on the
  spring-forward night goes at 3:00 AM; the repeated 1–2 AM hour in the fall counts once);
  a run may send up to 1 hour after that if the earlier run failed (owner's decision, §2).
  **App:** `src/data/push.ts` (permission request made synchronously from the tap, then
  `pushManager.subscribe({userVisibleOnly: true})` with the VAPID key, then
  `save_push_subscription`; turning off saves `reminderEnabled: false` then calls
  `disable_push_subscription`; at start, on return to the front, and when the setting turns
  on anywhere: re-save the subscription, subscribing again if it expired; never asks for
  permission without a tap; a subscription made with an old key is replaced),
  `Backend.savePushSubscription` / `disablePushSubscription` (the two small RPCs),
  `src/ui/reminder.tsx` (the switch logic, messages, the one-time Home card "Turn on daily
  reminder (3:00 PM)?" with Turn on / Not now, remembered on the phone as
  `meta.reminderOfferDone`), Settings switch now runs the permission flow and shows: the
  iPhone Settings steps after "Don't Allow", a warning when the reminder is on but this phone
  blocks notifications, and errors. **Service worker** `public/push-sw.js` (imported by
  `sw.js` via workbox `importScripts`): every push shows title "SPHR Flashcards", body "You
  should practice some questions", the app icon, tag `daily-reminder` (the push message's own
  content is never shown); tapping focuses the open app or opens `/SPHR-Flashcards/`.
  Tests: Deno `index.test.ts` (19: DST in Los Angeles both ways for all 96 times, 19 zones incl.
  +5:30/+5:45/+12:45, 30-minute and midnight changes, a whole year at 3 PM; 401/500/405;
  410/404 → disabled; duplicate and simultaneous runs send once; the PostgREST requests made;
  a **real encrypted, VAPID-signed push** from `web-push` under Deno to a local HTTPS server,
  decrypted by an independent RFC 8291 implementation and signature-checked),
  `supabase/tests/70_reminders.test.sql` (each of the function's statements works for the
  service role, not for the app or anon; the day key; safety log), vitest (`push.test`, 20;
  `reminder.test`, 21), `scripts/push-sw.test.mjs`, Playwright `e2e/reminder.spec.ts`
  (pretend iPhone push: permission asked **during the tap's click event**, subscribe, save,
  re-save on reload, turn off → disable, "Don't Allow") and `e2e/push.spec.ts` (a push
  delivered to the real service worker through DevTools shows the fixed notification; runs
  in the full headless Chromium because the light one has no notifications). 16 mutation
  checks in NOTES.md. New dev dependency: `deno` 2.9.6 (official npm package; runs the
  function tests from `npm test`; `npm audit`: 0 vulnerabilities).
- Phase 6 contents: icons `public/icons/` (white "SPHR" on green: 192, 512, maskable 512,
  180 apple-touch; drawn by `scripts/make-icons.py`, PNGs committed); manifest with the three
  icons and an `apple-touch-icon` link in `index.html`; `src/pwa.ts` (registers
  `sw.js`, checks for a newer version when the app comes to the front and hourly, never
  reloads by itself) + `src/ui/UpdateBanner.tsx` (banner "New version: Reload" at the top;
  the Settings footer also says so if offline use could not be set up); build id in the
  Settings footer (was Phase 5; `BUILD_ID` env var can override it for tests); install check
  `src/ui/install.ts` (`display-mode: standalone` or iOS `navigator.standalone`), exposed to
  screens as `env.installed`; in a browser tab Settings shows an "Add to Home Screen" card
  **instead of** the reminder switch and time; CSP `<meta>` injected at build only
  (`vite.config.ts`, `contentSecurityPolicy()`): `default-src 'self'`, `connect-src 'self'` +
  the Supabase origin from `VITE_SUPABASE_URL`, `img-src 'self' data:`, `style-src 'self'`,
  `script-src 'self'`, plus `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`;
  frame-busting `src/frameBust.ts`. Tests: unit (`pwa`, `frameBust`, `install`, banner, the
  Settings card), `scripts/csp.test.mjs`, and Playwright `e2e/pwa.spec.ts` on the production
  build: manifest + icons, CSP, service worker control, **offline** (reload offline, answer,
  "1 answer waiting to back up", go online, "All answers backed up"), **update flow** (builds
  A and B, banner, Reload, new build id). The e2e build now bundles the fake sample bank
  (`public/bank.json` is regenerated by every build), and the service worker is blocked in the
  older e2e tests so their pretend server keeps working.
- Phase 5 contents (`src/ui/`, `src/App.tsx`): `auth.ts` (email + password through
  supabase-js; friendly error text), `deps.ts` (what the screens need from outside, so tests
  can swap it), `useStudy.ts` (reads answers/settings/bank from the phone; card states,
  progress and XP are recomputed), `SignIn`, `Home` (XP, goal ring, 5 area cards × 3 tier
  bars + badges, area/tier pickers, Start lesson, Mistakes), `Lesson` (progress bar,
  scenario box, Check, feedback, Continue; each answer saved with `guardedWrite`), the six
  answer inputs in `AnswerInputs.tsx` (mc, multi, numeric, text, ordering with dnd-kit touch
  drag + ▲/▼ + tap-then-"Move here", matching by tapping), `EndScreens` (lesson end, all
  caught up), `Settings` (study pace, daily reminder, backup status line, export, import with
  preview + confirmation, sign out with confirmation, build id), `Dialog` (in-app confirm).
  New dependencies: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`; dev: `jsdom`,
  `@testing-library/react`, `/dom`, `/user-event` (`npm audit`: 0 vulnerabilities).
  Tests: ~80 new component tests (every input type, all six types through to feedback right
  and wrong, XSS payloads in every text field, each screen's error states, export/import,
  sign-out refusal) and 6 new Playwright tests (below). 7 mutation checks in NOTES.md.
  Playwright now builds its own copy into `dist-e2e` with a pretend Supabase address and the
  fake sample bank (nothing real is contacted; Phase 9 extends this).
- Phase 4 contents: `src/data/bankLoader.ts` (`pickBank`: the newest copy that reads
  cleanly wins, ties prefer server → saved copy → built-in; `orderLike`: puts the server's
  rows back in the built-in file's order), `src/data/bankManager.ts` (`BankManager`: loads
  the saved and built-in copies at once, then asks the server for `bank_meta`; downloads
  questions and scenarios only when the server's version differs from the saved copy and
  could win; re-checks on return to foreground / back online, at most every 10 minutes;
  saves the winner on the phone; `beginCard()`/`endCard()` hold a new bank until the card on
  screen is finished; problems go to the Settings notices once per session), Supabase reads
  in `supabaseBackend.ts` (`getBankVersion`, `getBank`: pages of 1,000 ordered by id,
  refuses a bank that changed mid-read), `refreshLesson` in `src/domain/lesson.ts` (the
  rest of a lesson in the new bank; retired cards drop out). `openSession` now starts the
  bank manager (`session.bank`); sign-out stops it. Tests: every case in BUILD_PLAN
  Phase 4, plus the App↔DB contract test now imports the fake bank **and the real bank**
  into local Postgres (rolled back), reads them back as the signed-in user, and checks they
  equal the file exactly (same order, same answer fingerprints). 11 mutation checks in
  NOTES.md, all caught. No new dependencies.
- Phase 3 contents (`src/data/`): `db.ts` (IndexedDB via `idb`, one database per user id:
  stores `bank`, `attempts`, `outbox`, `settings`, `meta`), `store.ts` (`LocalStore`;
  `guardedWrite` validates with the domain validator and writes the answer + outbox entry in
  one transaction; a write counter discards a pull that raced a local write), `sync.ts`
  (`SyncEngine`: flush in order, ≤ 200 per call, remove outbox items by key only after the
  server confirms; pull `seq > cursor` in pages of 500, then settings; runs on start, online,
  return to foreground, 2 s after an answer, every 5 min; status text; notices for
  rejections and settings conflicts), `session.ts` (open a session, first-run settings,
  `navigator.storage.persist()`, sign-out refused while anything waits to back up, then
  wipes the local database), `backend.ts` (server ↔ app conversions), `supabaseBackend.ts`
  (supabase-js: `rpc/apply_changes`, `attempts` and `settings` selects),
  `supabaseClient.ts` (PKCE, publishable key only), `answer.ts` (`buildAttempt`).
  `src/ui/SyncStatusLine.tsx` (the Settings status line; Phase 5 places it). Domain:
  `validateSubscription` added; `isTimeZone` tightened (see §3 item 15).
  Tests: unit tests with an in-memory fake server (`tests/fakeServer.ts`), two-device and
  settings-conflict tests, the Supabase adapter against a fake `fetch`, and the **App↔DB
  contract test** (`supabase/tests/60_contract.test.sh` → `supabase/tests/contract/`) that
  runs the app's own code against the real functions in local Postgres: round trips of all 6
  answer types, settings and a push subscription, plus one shared boundary table
  (`tests/contract/cases.ts`, ~150 values) that the app validator and the database must
  agree on. Coverage of `src/domain` **and** `src/data` is 100% (enforced). 11 mutation
  checks recorded in NOTES.md, all caught. New dependencies: `idb`, `@supabase/supabase-js`;
  dev: `fake-indexeddb` (`npm audit`: 0 vulnerabilities).
- Phase 2 (database) approved 2026-10-13. Contents: `supabase/migrations/0001_init.sql` (tables + constraints),
  `0002_guardrails.sql` (safety log, append-only/no-delete/no-truncate triggers, mass-delete
  cap, grants, forced RLS), `0003_rpc.sql` (`apply_changes`, `save_push_subscription`,
  `disable_push_subscription`, `import_bank`, `keepalive`, validators), all three locked in
  `migrations.lock.json`. `supabase/recovery/look_first.sql` and
  `restore_from_safety_log.sql` (copied verbatim into RECOVERY.md §5, checked by
  `scripts/docs-sync.test.mjs`). Tests in `supabase/tests/`: `10_schema` (structural
  guardrails for every table/function, incl. future ones), `20_rls`, `30_attack`,
  `40_import` (incl. a preview+apply of the real bank, rolled back), `50_recovery.test.sh`.
  11 mutation checks recorded in NOTES.md, all caught.
- Phase 1 contents (`src/domain/`, pure, no I/O): `types.ts`, `dates.ts` (local dates via
  Intl), `textNorm.ts`, `bank.ts` (normalizeBank, compareBankVersion, answerFp),
  `grade.ts`, `xp.ts`, `schedule.ts`, `replay.ts`, `shuffle.ts`, `lesson.ts`,
  `progress.ts`, `validate.ts`, `exportImport.ts`. 273 vitest tests + node tests; coverage
  of `src/domain` is 100% (enforced in `npm test`); property tests run 1,000 cases each with
  a fixed seed; the text normalizer is checked byte-for-byte against the validator and fuzzed
  on 10,000 strings. New dependencies: `@noble/hashes` (SHA-256), dev: `fast-check`,
  `@vitest/coverage-v8`.
- Phase 0 contents: Vite 8 + React 19 + TypeScript 5.9 (strict) + vite-plugin-pwa 2
  (`base: '/SPHR-Flashcards/'`), ESLint (bans `dangerouslySetInnerHTML`, `innerHTML`,
  `eval`, `new Function`, `confirm/alert/prompt`), Prettier, vitest, Playwright 1.56.1
  (matches the pre-installed Chromium; iPhone 13 Pro Max profile on Chromium);
  `tests/fixtures/sample-bank.json` (fake bank, 19 questions) and 6 bad banks;
  `scripts/check-migrations.mjs` + `supabase/migrations/migrations.lock.json` (empty, no
  migrations yet); `scripts/build-bank.mjs`; `supabase/tests/run.sh` (local PostgreSQL +
  auth shim); `.github/workflows/ci.yml` and `deploy.yml`.
- Phase 0 acceptance: CI green on GitHub; a deliberately broken fake bank turned CI red and
  was reverted with a new commit; removing an id fails `--previous` and editing an applied
  migration fails check-migrations (both covered by `scripts/*.test.mjs`). Deploy has not
  run yet (it only runs on `main`).
- In the repo from planning: `content/questions.json` (400 questions, 26 scenarios,
  bankVersion `2026-10-13.1`, passes the validator), `docs/QUESTION_FORMAT.md` (schema v1),
  `scripts/validate-bank.mjs`, `APP_BUILD_PLAYBOOK.md`, `PLANNING_PROMPT.md`, and the
  docs: `CLAUDE.md`, `docs/BUILD_PLAN.md`, `docs/SETUP.md`, `docs/RECOVERY.md`,
  `docs/INSTALL.md`.
- Supabase project: **not created yet** (SETUP Part B).
- GitHub Pages: **not set up yet** (SETUP Part A). The deploy workflow only runs on pushes
  to `main`, so nothing is published until the owner merges.
- Nothing goes to `main` without the owner's OK.

Bank contents: mc 222, text 74, numeric 62, ordering 16, matching 16, multi 10. Per area
(K/A/S): 1 Leadership 21/35/44; 2 Workforce 18/28/29; 3 Talent Mgmt 20/30/35;
4 Total Rewards 18/28/29; 5 HR Info/Safety 18/24/23.

## 2. Owner's decisions

Decided in the planning prompt:
| Topic | Decision |
|---|---|
| Users | One user (Michelle), no sharing or social features |
| Structure | Units = the 5 functional areas; tiers K=1, A=2, S=3 from `level`; she can study one area or several at once |
| XP | Correct answer earns the tier's points (1/2/3) |
| Not included | Hearts/lives, timed exam mode, leaderboards, streaks |
| Grading: text | Matches any `accepted` after lowercasing, trimming, collapsing spaces, dropping one trailing period. Nothing else forgiven. |
| Grading: numeric | Strip `$`, `%`, commas, spaces and the unit; correct within `tolerance` |
| Feedback | Correct: brief confirmation + XP. Wrong: the correct answer + `explanation`. No distractor reasons or citations. |
| Reminder | Daily push, default 3:00 PM local, text "You should practice some questions"; change the time or turn it off in Settings |
| Backend | Supabase free plan: progress sync, question storage, reminder sending. Stop and tell the owner if anything needs a paid plan. |
| Second backup | In-app export/import of progress |

Decided in the planning session (2026-10-13):
| Topic | Decision |
|---|---|
| Sign-in | **Email + password.** The owner creates her account in the Supabase dashboard; public sign-ups are off from day one. |
| Question import | **Manual "Run workflow" button** on GitHub: a preview run first, then a second run with `apply` ticked. Insert/update only. |
| Supabase pausing | **Daily keep-alive** GitHub Action (plus her use and the reminder job) |
| Choice order | **Shuffle every time; no A/B/C/D letters shown** (also ordering items and matching options) |
| Partial credit | **All-or-nothing** for XP and scheduling; feedback marks which parts were right |
| Tier unlocking | **All tiers open from day one**; badge when mastered. Mastered card = last 2 reviews correct; mastered tier = every active card in it mastered. |
| Spaced repetition | **Exam-aware boxes**: 1, 3, 7, 14, 21 days; never due after the exam date; wrong → 1 day + Mistakes |
| Pace | **15 new cards a day, 10-card lessons** (both adjustable in Settings) |
| Progress markers | **Area + tier progress bars with mastery badges; XP total + daily XP goal ring** (default 30 XP). Not shown: due-today counter, exam countdown, streak. |
| XP bonuses | **None** |
| Mistakes deck | A card leaves after **2 correct answers in a row** (always on different days) |
| GitHub | **Ruleset on `main`** blocking force-push and deletion |
| Exam date | **December 15, 2026** (default in Settings; she can change it) |
| Reminder on first install | **Off until she turns it on; a one-time home-screen card offers "Turn on daily reminder (3:00 PM)?"** with a button; dismissing it leaves Settings as the way to turn it on (decided 2026-10-13, Phase 1) |
| Safety-log writer | **Option A approved**: one SECURITY DEFINER trigger function (`log_change`) writes the safety log; the app has no access to the log (decided 2026-10-13, Phase 2) |
| Chats and models | **One new chat per phase.** Opus for Phases 3, 7, 9; Sonnet is fine for 4, 5, 6, 8 (see §6). Every end-of-phase report tells the owner to open a new chat (decided 2026-10-13) |
| Phase 5 screen defaults | **All five kept as built** (2026-10-13): remembered area/tier choice with the last one unswitchable; ✕ quits with no question; one Save button for pace fields, reminder saves at once and asks before turning off; one-line hints on Ordering and Matching; a wrong choice stays highlighted green (the owner chose "keep" over the recommended dimming; revisit only if asked) |
| Phase 6 | **Approved** 2026-10-13 (start of the Phase 7 chat) |
| Phase 7 | **Approved** 2026-10-13 |
| Phase 8 | **Approved** 2026-10-13; no new product decisions were needed (all behaviour was decided in the plan) |
| Late reminder | **Up to 1 hour late, once**, when the run at her chosen time fails or she picks a time that has just passed (the alternative, skipping that day, was declined). `CATCH_UP_MS` in `supabase/functions/send-reminders/index.ts` (decided 2026-10-13, Phase 7) |
| Phase 6 choices | **App icon:** white "SPHR" letters on the app's green. **Safari (not installed):** the "Add to Home Screen" steps card appears at the top of Settings only, in place of the reminder switch; Home is unchanged (decided 2026-10-13) |
| Instructions | **Every instruction to the owner includes copy-pastable steps** (exact clicks, and any text to paste in a code block) |

Design choices made in planning (no product trade-off, but worth knowing):
- **Progress is stored as an append-only answer history.** Card schedules, XP and
  Mistakes are recalculated from it, so two devices can never conflict and restoring answers
  restores everything.
- **Edited questions:** a wording-only edit keeps her progress on that card; a change to
  the answer or to any choice text resets it. The app detects this by comparing the graded
  fields (an "answer fingerprint"). No schema change.
- **Newest bank wins:** the app uses whichever copy of the bank is newest (Supabase, the
  phone's cache, or the copy built into the app), so new questions reach her phone after a
  deploy even before the import runs.
- Reminder times are in 15-minute steps (the scheduler runs every 15 minutes).

Small defaults chosen by the planning session (the owner can change any of them; ask before
changing):
- Answering early (Mistakes practice, "Study ahead") counts as a review.
- A card answered today is not shown again until tomorrow.
- Wrong cards are not repeated at the end of the same lesson; they go to Mistakes.
- The reminder is sent every day, even if she has already studied that day.
- Daily XP goal default 30; settings ranges: new cards 1–50, lesson 5–30, goal 5–200.

## 3. Open items

**Needs the owner's input**
1. Michelle's sign-in email, needed for SETUP step B6. Give it to Claude only if you want
   it written into the docs; otherwise just use it in the dashboard.

**Content (for the owner's question-writing project; no app action needed)**
2. 102 free-response worksheet items were rewritten as multiple choice.
3. Practice-test questions 70–85: in 10 items two choices were swapped, so the app's
   answer letters differ from the Word answer key (each item's `source.note` says so).
   The app shows no letters, so this is invisible to her.
4. In the practice-test items the correct choice is the longest choice 57 of 120 times
   (the validator reports 76 of 222 across all MC). Shuffling doesn't fix this cue.
5. `trw1-q01` (compa-ratio 0.85): typing "85%" is graded **wrong** under the decided numeric
   rule. Suggest changing the stem or adding the unit; that's a content edit with a revision bump.
6. `hiw1-q19` (unit °F): typing "87°" (degree sign without F) is graded wrong. Minor.
7. If a future text answer contains an apostrophe, the iPhone keyboard types a curly ’
   that won't match a straight '. No current answer has one. Decide then whether to forgive it.

**Build notes (Phase 0)**
8. The migration checker also refuses destructive SQL (`drop …`, `truncate`, `delete from`,
   `update … set`, `alter table … rename/drop`, `alter column … type`) unless a
   `-- guardrail-approved: <who, date, why>` comment sits directly above it. Function and
   trigger *definitions* (code inside `$$ … $$`) and `grant`/`revoke` are not counted.
9. `scripts/validate-bank.mjs` is excluded from Prettier so it stays exactly as reviewed.
10. Phase 1 implementation choices (no product trade-off; tell the owner if one matters):
   the answer fingerprint ignores the *order* of choices/items/options in the file and the
   order of `accepted` (only their content counts); a wrong answer must record 0 XP; card
   dates follow the current Settings time zone, so changing it recalculates the calendar day of
   past answers; a Mistakes card is ordered by the date of its most recent wrong answer;
   attempts are checked for ≤ 1 day in the future against the device clock.
11. Phase 2 implementation notes: (a) the app role gets **column-limited** insert/update on
   `push_subscriptions` and `settings` (the RPCs are security invoker, so they need it; the
   plan said select-only for push_subscriptions). It can never set `user_id`, `seq`,
   `received_at`, `failure_count` or `last_success_at`, and can never delete. (b) RLS is
   forced on every table, with an `admin_all` policy for roles other than anon/authenticated
   so the SQL editor's postgres role and the service role (import, reminders, recovery) keep
   working. (c) `apply_changes` rejects bad answers one by one (`rejected: [{index, id,
   reason}]`) and saves the good ones; bad settings come back as `settings_error`.
   (d) The import lets a question be **retired without raising its revision** (SETUP Part F
   only says to set the status); any other content change needs a raised revision.
   (e) TRUNCATE is blocked by a trigger on every table, even for the table owner.
   (f) To match the database exactly, Phase 1's validator now measures answer size the way
   Postgres prints JSON, rejects NUL and broken-emoji characters, limits the exam date to
   2000–2100, and checks timestamp hours/minutes/seconds ranges.
12. CI installs Playwright's Chromium on the GitHub runner (`npx playwright install`); the
   cloud session never does (it uses the pre-installed one).

13. Phase 3 implementation notes (no product trade-off; tell the owner if one matters):
   (a) An answer the server refuses is reported ("1 answer could not be saved: reason") and
   dropped from the outbox, but **stays on her phone** (CLAUDE.md: no code path deletes
   answers). It cannot happen in practice: the app's validator and the database agree on
   every boundary (contract test). (b) Settings changes are not stored in the outbox; the
   outbox only notes that settings changed, and the latest local settings are sent with the
   server version they were based on. On a conflict the server copy wins and **every** queued
   settings change is dropped (also one made during that sync). Untouched first-run
   defaults give way to a server copy without a message. (c) Every timestamp is stored in one
   spelling (`…T20:00:00.000Z`), so a phone's copy and the server's copy of an answer are
   identical. (d) Sign-out tries one last sync first; it is refused while answers *or* a
   settings change wait to back up. (e) The status-line hook (`useSyncStatus`) has no test
   yet (no browser DOM in unit tests); Phase 5 covers it in the screen tests.
14. `supabase/tests/run.sh` now also runs the contract test with vitest, so it needs
   `npm ci` first (CI already does that).
15. Time zones: Intl accepts spellings the database's zone list doesn't (`utc`,
   `america/los_angeles`, `+05:00`), so the validator now also requires IANA spelling (each
   part starts with a capital). **Old alias names** (`US/Pacific`, `Asia/Calcutta`) are
   accepted by the app, but this machine's PostgreSQL doesn't know them and Supabase's list
   is unverified; Chrome reports some of them (e.g. `Asia/Calcutta` in India). Every US zone
   an iPhone reports is in the contract test and accepted by both. If a server ever refuses
   a zone, she sees "Settings could not be saved: timeZone …" in Settings.

16. Phase 4 implementation notes (no product trade-off; tell the owner if one matters):
   (a) "Reads cleanly" means no question had to be skipped. A newer copy with unreadable
   questions is passed over for an older clean one, with a notice; if no copy is clean, the
   newest readable one is used and the skipped ids are listed. This can't happen with a bank
   that passed the validator. (b) The database has no order column, so the server copy is
   put back in the order of the app's built-in file (new ids last, by id); without this,
   new cards would come in id order whenever the server copy is used. (c) A damaged saved
   copy is reported once ("The copy of the questions saved on this phone could not be read
   …") and overwritten with the winner. Failing to reach the server is not a notice (offline
   is normal); it shows as the bank status's last error, which Phase 5 places.
   (d) The contract test clears the bank tables inside its own rolled-back transaction in
   the throwaway local database (the same override the recovery test uses).

17a. Phase 5 choices the plan did not spell out (no money/safety impact; the owner can change
   any of them, so please confirm or say what you'd like):
   (a) Home remembers her last area/tier choice on the phone; the last area and the last tier
   cannot be switched off (so a lesson is never "nothing selected"). (b) The Mistakes button
   counts the Mistakes cards in the chosen areas/tiers. (c) ✕ in a lesson quits straight to Home
   with no question asked (answers are already saved). (d) Settings: the four pace/date fields
   have one **Save** button; the reminder switch and time save at once; turning the reminder
   **off** asks first. (e) **The reminder switch only saves the preference for now: no
   notification can be sent until Phase 7.** (Done in Phase 7.) The "one-time home-screen card" and the
   Safari "Add to Home Screen" card belong to Phase 6/7 (they need install detection).
   (f) Matching: tapping an option with no prompt open fills the first empty prompt, and after
   each pairing the next empty prompt opens. (g) Export file name `sphr-progress-YYYY-MM-DD.json`;
   Settings shows when she last exported. (h) The time zone is shown but not editable.
   (i) Two one-line hints (Ordering, Matching) are on the lesson screen because the controls
   aren't obvious; CLAUDE.md says no help paragraphs on daily screens, so say if you want them
   removed. (j) After a wrong answer her choice stays highlighted in green (same colour as a
   plain selection); the red "Not quite" box and ✗ carry the verdict. Say if you'd like it
   dimmed.
   (k) Not tested on a real phone: the touch-drag in Ordering passes in desktop Chromium with
   simulated touches; the ▲/▼ buttons are the dependable path.

17b. Phase 6 notes (no money/safety impact; the owner can change any):
   (a) "Not installed" means any browser tab (Safari, Chrome, desktop), not only Safari; all
   show the install card in Settings and hide the reminder switch. (b) Nothing reloads the app
   by itself; the banner stays until she taps it (she may be mid-card). (c) The "one-time
   home-screen card offering the 3:00 PM reminder" decided in Phase 1 is **Phase 7** work
   (it needs the permission flow). (Done in Phase 7.) (d) The CSP's `frame-ancestors 'none'` cannot be set from
   a `<meta>` tag (browsers ignore it), and GitHub Pages can't send headers, so framing is
   handled by `frameBust.ts` only. (e) The CSP has no `wss:` entry: Supabase realtime is not
   used. If Phase 7+ ever needs another host, `contentSecurityPolicy()` is the one place.
   (f) **Not verified on a real iPhone:** home-screen install, standalone detection,
   icon appearance, offline in the installed app, and the update banner. INSTALL.md §5's
   first-day checklist covers them; the browser tests use Chromium on an iPhone-sized screen.

17c. Phase 7 notes (no money/safety impact; the owner can change any):
   (a) Turning the reminder on needs the internet once (the phone's address must reach the
   server); offline, she sees "Could not turn on the reminder: …" and the switch stays off.
   Turning it **off** works offline at once; the server stops as soon as the setting backs up.
   (b) If the reminder is on but this phone blocks notifications, Settings says so with the
   iPhone Settings steps; after allowing them, going back to the app is enough (the app
   re-checks when it comes to the front). (c) A reminder that reaches a phone that is off is
   dropped after 6 hours. (d) The Home card appears only in the installed app, only while the
   reminder is off, and is remembered per phone; it reappears after sign-out (the phone's
   data is wiped then). (e) If every device fails at reminder time with a temporary error, that
   day is still counted as sent (the log row is written first so a day can never get two);
   the failure is counted on the device and shown in the function's logs.
   (f) The function runs as the service role, which Phase 2 left able to delete rows in
   `push_subscriptions` (only the app roles are blocked); the function never deletes, and the
   mass-delete cap and safety log still apply. (g) **Not verified:** that `npm:web-push` runs
   inside Supabase's own Edge runtime (verified in Deno 2.9 locally, against a local HTTPS
   push server), that `SUPABASE_SERVICE_ROLE_KEY` is provided to functions on a new project,
   and real delivery to an iPhone. SETUP Part G step 4 and INSTALL §5 check them.
19. (Resolved 2026-10-13) Late reminder: the owner kept "up to 1 hour late, once" (§2).

17d. Phase 8 notes (no money/safety impact; the owner can change any):
   (a) The import is one request with the whole bank (about 600 KB), not chunks: the database
   function checks that nothing disappeared, so it must see the whole bank at once.
   (b) **Not verified against real Supabase:** that the new `sb_secret_…` key works as both
   `apikey` and bearer token for `rpc/keepalive` and `rpc/import_bank` (tested against a local
   stand-in only); SETUP Part G step 5 checks it on the first run. (c) The keep-alive writes
   one row a day to `keepalive_log` (about 365 a year; tiny). (d) Applying an import is the
   owner's approval for that one write (CLAUDE.md §0): preview first, then tick **apply**.
   (e) GitHub only runs scheduled workflows from the default branch, so the keep-alive starts
   after the merge to `main`; use the **Run workflow** button until then. (f) "Last export" is
   about the file made on this phone; it does not know about exports from another phone.

**Unverified facts (confirm during SETUP)**
17. The cloud session could not open apple.com, webkit.org or supabase.com directly; the
   facts in §4 come from search results quoting those docs, plus community write-ups.
   SETUP Part G lists what to check on the live dashboard.
18. GitHub turns off scheduled workflows in a public repo after 60 days with no commits; it
    emails first, and re-enabling is one click (SETUP Part D). Any commit resets the clock.

## 4. Platform facts this plan relies on

- **iOS web push** (WebKit, iOS/iPadOS 16.4+): works only for a web app added to the Home
  Screen and opened from its icon; permission must be requested in response to a tap; uses
  the standard Push API + VAPID; every push must show a notification. Her iPhone runs
  iOS 27, well past 16.4.
- **Supabase free plan:** projects are paused after about 7 days without enough database
  activity; Supabase emails a warning first; a paused project can be restored from the
  dashboard for 90 days (per the official page; a mirror said 1 year). While paused: the app
  still works offline from its cache, answers queue on the phone, reminders stop, and
  nothing syncs until restored. Paid plans don't pause.
- **Supabase scheduling:** `pg_cron` + `pg_net` can call an Edge Function on a schedule;
  secrets go in Vault. Free quota: 500,000 Edge Function invocations a month (we use about
  2,900).
- **Sign-in on iOS home-screen apps:** the installed app has storage separate from Safari.
  OAuth redirects and email links can finish in Safari instead of the app, which is why
  email + password was chosen.

## 5. How to run checks

```
npm ci
node scripts/validate-bank.mjs            # the real bank
node scripts/validate-bank.mjs tests/fixtures/sample-bank.json
node scripts/check-migrations.mjs
npm run typecheck && npm run lint && npm test
npm run build
./supabase/tests/run.sh                    # local Postgres: RLS, attack, import, recovery, App↔DB contract (answers, settings, bank)
npm run e2e                                # Playwright, iPhone 13 Pro Max profile; builds dist-e2e itself (pretend Supabase address)
npm run test:functions                     # (part of npm test) the reminder Edge Function in Deno; needs openssl
# also in npm test: scripts/workflows.test.mjs and scripts/import-bank.test.mjs; run.sh runs supabase/tests/contract/import.test.ts
```
`npm test` runs vitest (domain, data layer and bank loader with fake IndexedDB and a fake server, UI) with
100% coverage enforced on `src/domain` and `src/data`, and the Node guardrail tests (`scripts/*.test.mjs`: validator
self-test on `tests/fixtures/bad-banks/`, `--previous`, check-migrations, build-bank, the service worker's
push handler), then the reminder function's Deno tests (`deno` comes from `npm ci`; the first run downloads
`web-push` and `supabase-js` from npm, pinned by `supabase/functions/deno.lock`).
`e2e/push.spec.ts` uses Playwright's full headless Chromium (`channel: 'chromium'`), which the cloud image
and CI's `playwright install chromium` both have.
`run.sh` needs a local PostgreSQL (`initdb`); as root it runs the server as the `postgres`
OS user. It applies the migrations as `migrator`, a non-superuser standing in for Supabase's
`postgres` role, with Supabase-like default grants, so missing revokes are caught. Migrations are added with `node scripts/check-migrations.mjs --record` once final.

## 6. Starting the next phase (paste this into every end-of-phase report)

Every phase runs in a **new chat**. At the end of a phase, the report must end with these
steps, with `N` replaced by the next phase number and the model taken from the table:

| Phase | What it builds | Model |
|---|---|---|
| 3 | Offline saving and syncing (phone ↔ Supabase) | **Opus** |
| 4 | Loading the questions onto the phone | Sonnet |
| 5 | The screens (UI) | Sonnet |
| 6 | Installable app, offline, updates | Sonnet |
| 7 | Daily reminder (push notifications) | **Opus** |
| 8 | Backups, keep-alive, question import | Sonnet |
| 9 | End-to-end tests, reviews, go-live | **Opus** |

Steps for the owner (copy these into the report):
1. Open a **new** Claude Code chat on the SPHR-Flashcards repository.
2. In the model menu, choose **MODEL** before sending anything.
3. Paste this as the first message:
```
Read CLAUDE.md and docs/HANDOFF.md first, then docs/BUILD_PLAN.md. Follow the data-safety and security rules exactly; my safety rules in CLAUDE.md section 0 override everything else. Ask me before deciding any product behaviour: give 2-3 options with a recommendation, and record my answers in docs/HANDOFF.md. I'm non-technical: every instruction you give me must be copy-pastable, meaning numbered steps with exact clicks, and anything I type or paste in its own code block. Never invent SPHR questions; tests use the fake sample bank.

Phases 0 to N-1 are built and approved. Work on the existing branch ccr-67c10ae0-ubtsvr (fetch it and continue from its latest commit), not main. Start BUILD_PLAN.md Phase N. When Phase N is done: run the full check chain, tell me honestly what passed and what didn't, update HANDOFF.md and NOTES.md, push to that branch, and stop. Wait for my OK before starting the next phase or merging to main.
```
(In the message itself, write the real numbers, e.g. "Phases 0 to 3 are built and approved"
and "Phase 4".) If the owner approves a phase in the same chat, record the approval in §1,
commit and push, then give these steps; do not start the next phase.
