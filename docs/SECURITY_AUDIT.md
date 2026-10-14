# Security and bug audit (2026-10-14)

Audit of `main` at commit `36692d3`, on branch `claude/happy-thompson-b923a5`. Nothing was sent
to the live Supabase project or the live github.io site; no real data was touched.

## How the audit was done

| Part | Who | What was run |
|---|---|---|
| Bug audit A: answer and progress safety | separate subagent, fresh start | read `src/data`, `src/domain`, sync and import paths, `0001`/`0003` SQL; repro tests on fake IndexedDB and on a throwaway local PostgreSQL |
| Bug audit B: screens, scripts, reminder function, workflows, recovery | separate subagent, fresh start | read `src/ui`, `src/*.ts`, `scripts/`, `supabase/functions`, migrations, recovery SQL, workflows; repro tests in a scratch folder |
| Security review (a), white-box | separate subagent, fresh start | CLAUDE.md §2 checklist item by item; ad-hoc SQL probes as `anon`, `authenticated` (two accounts) and `service_role` on local PostgreSQL 16 with the migrations; git history scanned for secrets |
| Security review (b), black-box, and the penetration tests against the local build | **not done** | see "Not done" below |
| Dependency review | main session | `npm audit` (app and dev tools), a separate `npm audit` of the reminder function's own packages (`web-push@3.6.7`, `@supabase/supabase-js@2.117.3`), usage check of every package |

Repro scripts live outside the repo (session scratch folder); the repro steps are written into
each finding so they can be redone.

## Not done (be aware)

- **The black-box review and the browser-side penetration tests** (attacker view of the built
  site, XSS and injection in every text field through the browser, CSP and frame bypass
  attempts, token and session handling in the browser) were **not carried out** in this
  session: the instructions for that agent were cut off by a safety filter and the agent was
  stopped before it did any testing. What still covers this ground: the existing e2e tests
  (XSS payloads in server questions, a typed answer and an imported file; CSP present on the
  production build), the unit XSS tests (`src/ui/xss.test.tsx`), and the white-box review's
  reading of the CSP, frame-busting and rendering code (all PASS below).
- **Database attack testing** was done only as part of the white-box review (cross-account
  reads and writes, anon access, calling admin functions, the `log_change` writer, mass-delete
  cap, direct table writes, push endpoints) plus the existing `30_attack` and `80_blackbox`
  SQL tests, which pass. There was no separate penetration-test pass.
- Anything that can only be checked on the live system is listed under "Checks for the owner".

## Summary

No critical or high findings. No secret was ever committed (all 27 commits scanned). No path
was found where an answer that reached the server is lost or duplicated **on the server**.
`npm audit`: 0 vulnerabilities.

| ID | Severity | Title | Changes app behaviour? | Migration? | Status |
|---|---|---|---|---|---|
| M1 | medium | A phone can miss answers made on another phone at the same moment, forever | no | option | **fixed** |
| M2 | medium | "Mistakes (N)" leads to an endless "All caught up" loop after a wrong answer today | yes | no | **fixed** |
| M3 | medium | The migration checker lets most destructive SQL through | no (CI only) | no | **fixed** |
| M4 | medium | A secret pasted into a public key variable would be published | no | no | **fixed** |
| M5 | medium (unconfirmed) | Export on the iPhone app may save no file but still say "Last export: today" | yes | no | **fixed** |
| M6 | medium (unconfirmed) | The account's time zone comes from whichever device signed in first; the app can't change it | yes | no | **fixed** |
| L1 | low | Sign-out with a second tab open: says it failed, but later answers in that tab are deleted | yes | no | **fixed** |
| L2 | low | A lost reply to a settings save gives a false "changed on another device" and drops a newer change | yes | no | **fixed** |
| L3 | low | Answers the server refused (phone clock > 1 day fast) are deleted on sign-out | yes | no | **fixed** |
| L4 | low | Import has no account check and can't be undone | yes | no | **fixed** |
| L5 | low | Importing thousands of answers redraws everything per answer (slow, no busy state) | yes | no | **fixed** |
| L6 | low | Turning the reminder on overwrites settings changed meanwhile | no | no | **fixed** |
| L7 | low | The bank validator accepts files the app then refuses or partly drops | no | no | **fixed** |
| L8 | low (unconfirmed) | Matching: a drag released outside any prompt still pairs with the nearest prompt | yes | no | **fixed** |
| L9 | low | Unsaved Study fields are wiped when the reminder or a sync changes settings | no | no | **fixed** |
| L10 | low | Some errors are swallowed instead of shown | no | no | **fixed** |
| L11 | low | The recovery script can put `settings.version` back to an old number | no | no | **fixed** |
| L12 | low | The database lets the signed-in account write tables directly, skipping `apply_changes` | no | yes | **fixed** |
| L13 | low | Any https address is accepted as a push endpoint; the reminder function then sends to it | slightly | yes | **fixed** (owner runs 0004 and redeploys the function) |
| L14 | low | "One user only" rests on two Supabase dashboard switches | no | option | **fixed** (owner still checks the two switches) |
| L15 | low | Default privileges don't stop future functions being callable by everyone | no | yes (next one) | **fixed** |
| L16 | low | `SUPABASE_SECRET_KEY` is usable by a workflow on any branch | no | no | **fixed** (owner moves the secret) |
| L17 | low | A Settings screen test fails when the machine is busy (1-second wait) | no | no | **fixed** |
| I1–I5 | info | see below | | | I2 fixed; others noted |

## Fixes (2026-10-14)

The owner approved the recommended option (A) for every item. All are fixed on this branch;
each fix has tests that fail without it (checked by removing the fix), except where noted.

| ID | What changed | Tests |
|---|---|---|
| M1 | Each pull re-reads answers below the cursor until they are a minute old (at most 1,000 back), so a save that commits late is still found; already-known answers are skipped and cause no screen update. Phones from before re-read everything once. (`src/data/sync.ts`, `store.ts`, `db.ts`) | `sync.test.ts` "appears late, below the cursor", "pulls start where nothing more can appear" |
| M2 | "Mistakes (N)" counts only cards she can practise today and is hidden at 0, so it never opens an empty lesson. (`src/ui/Home.tsx`) | `App.test.tsx` "no Practice Mistakes loop"; `e2e/days.spec.ts` rewritten for the new rule |
| M3 | The migration checker also catches `do` blocks, disabled triggers/RLS, `create or replace`, rules, `merge`, `session_replication_role`, `security definer`, `alter function/policy/role`, table-wide grants, hidden deletes inside `create … as`; it parses `E''` strings, quoted names and `$` in names; the approval comment must be a line of its own above the statement. The three applied migrations are pinned by content and keep passing. (`scripts/check-migrations.mjs`) | `check-migrations.test.mjs` (all 21 audit cases + approved forms + ordinary migrations) |
| M4 | Build: `checkPublicKeys` (earlier). Workflows: a first step stops deploy, import and keep-alive, without printing anything, unless the URL is `https://….supabase.co`, the key starts `sb_publishable_` and the VAPID key starts `B`. GitHub expressions can't measure length, so a VAPID private key that happens to start with `B` is caught only by the build check. | `workflows.test.mjs`, `csp.test.mjs` |
| M5 | In the installed app, Export uses the share sheet ("Save to Files"); "Last export" is recorded only when it completes; cancelling says so. In a browser tab the download link is revoked after a minute instead of at once. INSTALL §5 checks it on the phone. (`src/ui/Settings.tsx`) | `Settings.test.tsx` "share sheet", "cleaned up a minute later" |
| M6 | Settings → Study shows "This phone is in X, but your study days and reminder use Y" with **Use this phone's time zone** when they differ (only zones the validator accepts). Saved through the normal write path. | `Settings.test.tsx` "time zone (audit M6)" |
| L1 | Every open copy closes its local data as soon as another tab starts a sign-out and goes to the sign-in screen ("You signed out in another tab or window."). Sign-out deletes the local data first, then signs out; if an older open copy blocks the delete, Settings says it is waiting and finishes when that copy closes. Offline, the account is signed out on this phone. (`src/data/db.ts`, `session.ts`, `src/App.tsx`, `src/ui/auth.ts`) | `session.test.ts` (second tab, older copy, listeners), `store.test.ts`, `auth.test.ts`, `App.test.tsx` |
| L2 | The phone remembers settings it sent whose reply never came; if the server later reports a "conflict" with exactly one of those, it was our own save: no notice, and a newer change is sent on top. A real change elsewhere is still a conflict. | `sync.test.ts` three "audit L2" tests, `store.test.ts` |
| L3 | A refused answer stays in the outbox (marked), so sign-out still waits for it; it is offered again once per sync (after new answers, never holding them up) and backs up once the server accepts it; the notice is shown once. | `sync.test.ts` two "audit L3" tests |
| L4 | New exports carry a 16-digit fingerprint of the account (not its id). The import preview warns about a file from another account (Import needs "Import anyway") and about answers for questions not in the app. Old files import as before. RECOVERY §4 step 4 says to tick it after a project rebuild. | `exportImport.test.ts`, `Settings.test.tsx`, `e2e/sync.spec.ts` |
| L5 | Import saves all answers in one `guardedWrite` (`kind: 'attempts'`: every answer checked first, one transaction, one screen update) with "Importing N answers…" and the buttons disabled meanwhile. | `store.test.ts`, `Settings.test.tsx` |
| L6, L9, L10, L17 | Fixed in the first round (below). | |
| L7 | The validator also checks the `bankVersion` format, level points (whole 0–3), area ids and names, text ids and text in every choices/items/prompts/options list, a finite tolerance; with `--previous`, any change needs a higher `bankVersion`, changed content needs a raised revision, and a revision never goes down (the database import's rules). | `validate-bank.test.mjs` (9 new) |
| L8 | Matching pairs only when the dragged option is let go overlapping a prompt (`rectIntersection`). `pointerWithin` was tried first and broke real touch drags in the browser test, so it was not used. | `e2e/questions.spec.ts` "let go away from every prompt pairs nothing" |
| L11 | Restored settings get a new version, one higher than any the row ever had. RECOVERY.md §5 updated (its copy is checked by a test). | `50_recovery.test.sh` |
| L12, L13, L14, L15 | Migration `0004_audit_hardening.sql` (additive): direct answer inserts get `attempt_problem`'s checks and a 200-per-statement cap; app updates to settings always raise the version by one; push addresses must be Apple/Microsoft/Google/Mozilla push services (also in the app validator and the function) and at most 10 devices can be on; restrictive policies refuse anonymous sign-ins on every app table; new functions are not executable by everyone by default and the service role gets no TRUNCATE on new tables. The reminder function also skips and turns off a non-push address, turns a device off after 10 failures in a row and resets the count after a success. Not done: limiting the tables to Michelle's own account id (needs her id; the dashboard switches are the main lock). | `90_audit.test.sql` (new; fails without `0004`), `30_attack`, `70_reminders`, contract boundary cases, Deno tests |
| L16 | `import-questions.yml` and `keepalive.yml` run in the `supabase-admin` environment; the owner moves the secret there (steps in the chat; SETUP A4 updated). | `workflows.test.mjs` |
| I2 | The function's error lines replace any web address with its host. | Deno "never puts the push address in the log" |

## Findings

### M1 (medium): a phone can miss answers made on another phone at the same moment, forever
- **Where:** `supabase/migrations/0001_init.sql` (`seq … generated always as identity`),
  `supabase/migrations/0003_rpc.sql` (`apply_changes` insert, no per-user lock),
  `src/data/sync.ts` and `src/data/store.ts` (the pull cursor becomes the highest `seq` seen).
- **What happens:** `seq` numbers are handed out when a row is inserted but become visible only
  when the transaction commits. If phone A gets seq 1 and commits a moment after phone B's seq 2,
  and B pulls in between, B's cursor jumps to 2 and B never asks for seq 1 again. The server
  copy is intact; B's screen and B's export are missing that answer until B signs out and in.
  Needs two devices saving within tens of milliseconds, so rare, but silent and permanent.
- **Reproduced:** local PostgreSQL with the real migrations: A `begin; apply_changes([att1]);
  pg_sleep(2); commit;`, B 0.5 s later `apply_changes([att2])` → pull `seq > 0` returns only 2;
  after A commits, pull `seq > 2` returns nothing; the table holds both.
- **Options:** (A, recommended) app only: each pull re-reads a small overlap behind the cursor
  (e.g. the last 1,000 seq numbers); duplicates are already ignored. No migration.
  (B) migration `0004`: a per-user lock in a new wrapper so one account's saves commit in order.
  (C) leave it (single user, rarely two devices at once).

### M2 (medium): "Mistakes (N)" leads to an endless "All caught up" loop
- **Where:** `src/ui/Home.tsx` `mistakesCount` counts cards answered today;
  `src/domain/lesson.ts` `buildLesson` leaves them out; `src/App.tsx` CaughtUp screen.
- **What happens:** answer a card wrong, tap Done: Home shows "Mistakes (1)". Tap it: "All
  caught up" with "Practice Mistakes (1)". Tap that: the same screen again, forever.
- **Reproduced:** screen test with the fake bank (scratch `mistakes.test.tsx`); confirmed by
  reading both filters.
- **Options:** (A, recommended) count only Mistakes cards she can practise now (not answered
  today), so the button matches what it opens; hide it at 0. (B) keep the count and show
  "Mistakes (1, tomorrow)" with the button disabled. (C) let Mistakes practice include cards
  answered today (changes the planned "not shown again until tomorrow" rule).

### M3 (medium): the migration checker lets most destructive SQL through
- **Where:** `scripts/check-migrations.mjs` (`maskSql`, `findUnapproved`).
- **Reproduced:** the real `findUnapproved` returns no problem for 20 of 21 test statements,
  including `do $$ begin delete from attempts; end $$;`, `alter table attempts disable trigger
  all;`, `alter table attempts disable row level security;`, `create or replace function` of a
  guardrail function, `create rule … do instead nothing`, `merge … then delete`, `update only
  settings set …`, `update settings s set …`, `set session_replication_role = replica`,
  `grant delete … to authenticated`, and an approval marker inside a string literal or below
  the statement. Only `with x as (delete …)` was caught.
- **Why it matters:** this is the CI guardrail that stops a future AI session or a mistake from
  shipping a destructive migration. The database triggers still protect the data, but several
  of the missed statements switch those triggers off.
- **Options:** (A, recommended) tighten the checker for all the above, require the marker as
  its own comment line directly above the statement, and keep the three applied migrations
  passing by checking them against their locked hashes only (they cannot be edited anyway);
  add every case to `check-migrations.test.mjs`. (B) tighten only the patterns that disable
  guardrails (triggers, RLS, rules, replication role, DO blocks, replacing guardrail functions).
  (C) leave as is and rely on review.

### M4 (medium): a secret pasted into a public key variable would be published
- **Where:** `vite.config.ts` checked only `VITE_SUPABASE_URL`; `.github/workflows/deploy.yml`,
  `import-questions.yml`, `keepalive.yml` pass repo variables through `env:` (GitHub prints
  variables unmasked in public run logs).
- **What happens:** pasting the `sb_secret_…` key into `VITE_SUPABASE_PUBLISHABLE_KEY`, or the
  VAPID **private** key into `VITE_VAPID_PUBLIC_KEY`, builds fine and puts the secret into the
  public JavaScript. The same kind of mistake already happened once (database password in
  `VITE_SUPABASE_URL`).
- **Fix made (behaviour-neutral):** the build now stops, without repeating the value, unless the
  publishable key starts `sb_publishable_` and the VAPID key has the shape of a public key
  (87 base64url characters starting with `B`). Test: `scripts/csp.test.mjs`.
- **Still open (ask owner):** the value would still appear in the run log's `env:` listing
  before the build step fails. Option (A, recommended): a first step in the three workflows
  that checks the variables' shapes with an `if:` expression (not printed) and stops the job
  before anything prints them. (B) leave it at the build check.

### M5 (medium, unconfirmed): export on the iPhone app may save no file but still say done
- **Where:** `src/ui/Settings.tsx` `doExport`: the download link is revoked immediately after
  `a.click()`, then "Last export" is set and "Exported N answers." shown regardless.
- **Why:** WebKit is known to cancel downloads whose blob link is revoked at once; the installed
  iPhone app is stricter still. If so, Settings reports a backup that does not exist, and the
  owner relies on an export before every migration. Not testable without a real iPhone.
- **Options:** (A, recommended) revoke the link after 60 seconds, and on the iPhone use the
  share sheet (`navigator.share` with the file) and record "Last export" only when it completes;
  add "check the file is in Files" to INSTALL §5. (B) only delay the revoke. (C) leave it and
  test on the phone first (step in "Checks for the owner").

### M6 (medium, unconfirmed): the account's time zone comes from the first device to sign in
- **Where:** `src/data/session.ts` `ensureSettings` (first sign-in saves defaults with that
  device's zone); `src/ui/Settings.tsx` shows the zone but cannot change it.
- **What happens:** HANDOFF says the first sign-in was the owner's, in desktop Chrome. If that
  computer's zone is not Michelle's, her day boundaries, new-card cap, XP ring, Mistakes and the
  reminder time are all shifted, and nothing in the app can fix it.
- **Owner check:** "Checks for the owner" step 1.
- **Options:** (A, recommended) when the phone's zone differs from the saved one, Settings
  offers "Use this phone's time zone (X)?"; saved through the normal write path. (B) make the
  zone a plain picker in Settings. (C) fix it once by hand in the Supabase SQL editor (a data
  change, needs your approval at the time).

### L1 (low): sign-out with a second tab open can delete that tab's later answers
- **Where:** `src/data/session.ts` `signOut`, `src/data/db.ts` (no `onversionchange`),
  `src/App.tsx` (no sign-out listener).
- **What happens:** sign-out signs out of Supabase first, then asks to delete the local
  database. Another open tab blocks the delete, so "Sign-out failed" appears, but the delete
  stays queued. Answers made afterwards in the other tab can't sync (signed out) and are
  deleted when that tab closes. Needs two tabs (desktop), not the installed iPhone app.
- **Reproduced:** fake-IndexedDB test (scratch `signout.test.ts`): sign-out returns
  `{ok:false}`, an answer saved in tab B afterwards, tab B closed → the database is gone.
- **Options:** (A, recommended) other tabs close their database and go to the sign-in screen as
  soon as a sign-out starts; the database is deleted before the Supabase sign-out, and if the
  delete is blocked the sign-out is refused with a message. (B) only refuse sign-out while
  another tab is open. (C) leave it (installed app has one window).

### L2 (low): a lost reply to a settings save gives a false conflict
- **Where:** `src/data/sync.ts` settings flush; `src/data/store.ts` conflict branch.
- **What happens:** the server saves a settings change but the reply is lost (weak signal). The
  retry is based on the old version, so the server reports a conflict: she sees "Settings were
  changed on another device; reloaded them." (untrue), and any newer settings change she made
  meanwhile is dropped.
- **Reproduced:** fake-server test (scratch `settingsLost.test.ts`).
- **Options:** (A, recommended) on a conflict, if the server's copy equals what this phone
  sent, treat it as saved: no notice, keep newer queued changes. (B) leave it.

### L3 (low): answers the server refused are deleted on sign-out
- **Where:** `src/data/store.ts` (refused answers leave the outbox), `src/data/session.ts`
  (sign-out check ignores them), `src/domain/exportImport.ts` (re-import counts them as present).
- **What happens:** the only realistic refusal is a phone clock more than 1 day fast (the server
  checks against its own clock). Those answers stay on the phone, but sign-out deletes them and
  a re-import can never resend them. Traced; the existing test shows the refusal path.
- **Options:** (A, recommended) keep refused answers in a list on the phone and count them in the
  sign-out check (offer an export instead). (B) also let the import preview offer to resend
  them. (C) leave it.

### L4 (low): import has no account check and can't be undone
- **Where:** `src/domain/exportImport.ts` (no account id in the file).
- **What happens:** any valid export merges in, including another account's or a test file;
  answers can never be deleted on the server, so XP stays inflated for good.
- **Options:** (A, recommended) new exports carry a short fingerprint of the account; the
  preview warns when it doesn't match and when answers point to questions not in the bank.
  Old files still import. (B) leave it (one user).

### L5 (low): importing thousands of answers is slow with no busy state
- **Where:** `src/ui/Settings.tsx` import (one write per answer), `src/ui/useStudy.ts` (each
  write re-reads every answer and recomputes progress).
- **Measured:** about 45 ms per recompute of 3,000 answers on this machine; a full restore can
  freeze the screen for minutes on a phone, with nothing shown. No data is lost (re-import is safe).
- **Options:** (A, recommended) one batch write for the whole import and an "Importing…" line
  with the buttons disabled. (B) leave it.

### L6 (low, fixed): turning the reminder on overwrites settings changed meanwhile
- **Where:** `src/ui/reminder.tsx` saved `{...settings, reminderEnabled}` using the settings
  from the moment of the tap, after waiting for the permission prompt and the server.
- **Reproduced:** change the reminder time while "Turning on the reminder…" shows; when the
  switch finishes, the time is silently put back. The same with a sync landing meanwhile.
- **Fix made:** the switch now reads the latest saved settings when it writes and changes only
  `reminderEnabled`. Test in `src/ui/reminder.test.tsx`, fails without the fix.

### L7 (low): the bank validator accepts files the app refuses
- **Where:** `scripts/validate-bank.mjs`.
- **Reproduced (fake bank changed):** `levels.K.points` = 4 or 1.5, a `bankVersion` like
  `2026-10-13`, or an area without a name pass the validator, but the app refuses the **whole**
  bank; an empty ordering item, empty matching prompt or a numeric choice id pass, but the app
  silently drops that question. `--previous` does not require a raised `bankVersion` when content
  changed (such an edit would deploy but never reach the phone, and the import refuses it).
  The deploy is protected today only because `src/domain/bank.test.ts` checks the real bank.
- **Options:** (A, recommended) add those checks to the validator (and `--previous`: content
  changed ⇒ `bankVersion` raised). The validator is "exactly as reviewed" (HANDOFF §3 item 9),
  so this needs your OK. (B) instead make `build-bank` run the app's own bank reader and fail on
  any dropped question. (C) leave it.

### L8 (low, unconfirmed): matching drag released outside a prompt still pairs
- **Where:** `src/ui/AnswerInputs.tsx` matching (`collisionDetection={closestCenter}`).
- **What happens:** once a drag starts (a 6 px mouse wobble, or a finger held 0.2 s), letting go
  anywhere pairs the option with the nearest prompt, and can replace a pair she had right.
  Traced in the dnd-kit source; the jsdom test could not start a drag, so needs a real check.
- **Options:** (A, recommended) only pair when released over a prompt (`pointerWithin`); a drop
  elsewhere does nothing. (B) leave it.

### L9 (low, fixed): unsaved Study fields wiped by other setting changes
- **Where:** `src/ui/Settings.tsx`: the four Study fields reset whenever any setting changed
  (reminder switch, reminder time, a sync).
- **Fix made:** they reset only when one of those four values changes. Test in
  `src/ui/Settings.test.tsx`, fails without the fix.

### L10 (low, fixed): some errors were swallowed
- **Where:** `src/ui/reminder.tsx` (Not now on the Home card), `src/ui/SyncStatusLine.tsx`
  (dismissing notices), `src/data/session.ts` `signOut` (a failing sync or check before the
  try).
- **Fix made:** each now shows its error (CLAUDE.md: errors are always shown). Tests fail
  without the fix.

### L11 (low): the recovery script can reuse a settings version number
- **Where:** `supabase/recovery/restore_from_safety_log.sql` restores `settings.version`.
- **What happens:** putting version 7 back to 5 lets later edits reach 7 again with different
  content; a second phone holding the old 7 would think it's up to date and could overwrite.
- **Options:** (A, recommended) restore everything except `version`/`updated_at`, and raise the
  version by one instead (recovery file, RECOVERY.md copy and its docs-sync test). (B) leave it
  (single phone).

### L12 (low): direct table writes skip `apply_changes`
- **Where:** `supabase/migrations/0002_guardrails.sql` column grants (needed because the
  functions run as the caller).
- **Reproduced (local, as the signed-in account):** a direct `insert into attempts` with a
  malformed `response` and a 1900 date succeeds; `update settings set version = 1` succeeds
  (defeats the stale-write check); 500 rows in one insert succeed (the 200 cap is in the
  function). Only Michelle's own session can do this; the app re-validates pulled rows, so no
  XSS.
- **Options:** (A, recommended) migration `0004` (additive): triggers that run the same checks
  as `apply_changes` on direct inserts into `attempts` and force `version + 1` on settings
  updates by the app roles. (B) make the three functions `security definer` and remove the
  direct grants (against the current rule; needs your sign-off). (C) leave it.

### L13 (low): any https push endpoint is accepted and the reminder function sends to it
- **Where:** `0001_init.sql` (`endpoint ~ '^https://'`), `save_push_subscription`,
  `supabase/functions/send-reminders/index.ts`.
- **Reproduced (local):** the signed-in account saved `https://169.254.169.254/…`,
  `https://localhost:5432/` and 300 other addresses; each reminder run would post to them.
  Failures never disable a device. The function's secret check itself is sound (constant-time,
  401 without the header, 500 when unset).
- **Options:** (A, recommended) allow only the real push services (Apple, Google, Mozilla,
  Microsoft) in the app validator, a new database trigger and the function; cap active devices
  (e.g. 10); disable a device after repeated failures. Needs `0004` and a function redeploy.
  (B) only the function-side host check (redeploy, no migration). (C) leave it.

### L14 (low): "one user only" rests on two dashboard switches
- **Where:** the policies admit any signed-in account (`to authenticated`).
- **Why:** if "Allow new users to sign up" or "Allow anonymous sign-ins" were ever on, anyone
  could sign in and fill the free database (each change is copied to the safety log) or register
  push addresses (L13). Owner check step 2.
- **Options:** (A, recommended) confirm both are off (read-only look); later, with `0004`, add a
  policy that only Michelle's account id may use the tables. (B) only the dashboard check.

### L15 (low): future functions are callable by everyone by default
- **Where:** `0002_guardrails.sql` default privileges (`… in schema public …` can't remove
  PostgreSQL's built-in rule that new functions are executable by everyone).
- **Reproduced (local):** a function created after the migrations is executable by `anon`.
  `10_schema.test.sql` already fails CI if a future migration forgets its revokes, so this is
  defence in depth.
- **Fix:** add the global default-privilege revokes to the next migration (no separate
  migration just for this).

### L16 (low): the Supabase secret is usable by a workflow on any branch
- **Where:** repository secret `SUPABASE_SECRET_KEY` (used by `import-questions.yml`,
  `keepalive.yml`).
- **What happens:** anyone (or any AI session) with push rights could add a workflow on a branch
  that reads it. Fork pull requests cannot.
- **Options:** (A, recommended) move it into a GitHub Environment limited to `main` (steps
  below, once approved), and add `environment:` to the two jobs. (B) leave it.

### L17 (low, fixed): a screen test failed when the machine was busy
- **Where:** `src/ui/Settings.test.tsx` "lists rejected answers…" waited the default 1 second
  for a 35-answer import; it failed once in the baseline run while three reviews were running,
  and passed 3 of 3 alone.
- **Fix made:** the screen tests' wait limit is raised to 10 seconds (the checks themselves are
  unchanged), the same approach already used for the test time limit.

### Info
- **I1:** GitHub Actions are pinned to major tags (`actions/checkout@v5` …), not commit ids.
  All are GitHub's own; optional.
- **I2:** the reminder function puts a thrown network error's text into its log and reply;
  depending on Deno's wording that might include a full push address (the code otherwise logs
  only the host). Not verified. Fix: log only the host and the error name (function redeploy).
- **I3:** the reminder claims the day before sending, so if every device fails with a temporary
  error the day is not retried. Already accepted (HANDOFF §3 17c(e)).
- **I4:** `apply_changes` returns `max_seq`, which the app doesn't use; it could support M1.
- **I5:** the browser test `e2e/push.spec.ts` ("a push message shows the reminder
  notification") failed once in the final full run (no notification within 10 s), then passed
  twice alone and in a second full run (53 of 53). The audit's changes don't touch the service
  worker. Not changed; watch for it in CI.

## CLAUDE.md §2 checklist (white-box review)

| Item | Result |
|---|---|
| No secrets committed (27 commits scanned) | PASS |
| Only URL, publishable key, VAPID public key client-side | PASS (shape check added, M4) |
| Server secret only in import + keep-alive workflows | PASS (branch scoping: L16) |
| RLS enabled and forced on all 9 tables | PASS |
| User tables `to authenticated`, `user_id = (select auth.uid())` | PASS (user B cannot read or take over A's rows, verified) |
| `revoke all … from anon` on every table and function | PASS (verified) |
| `questions`, `scenarios`, `bank_meta` select-only | PASS |
| `safety_log` not readable/writable by app roles | PASS (verified) |
| Functions security invoker, `search_path` set, execute revoked | PASS (only `log_change` is definer, owner-approved, not callable) |
| `truncate`, `references`, `trigger` revoked | PASS |
| Behavioural tests for every table/function | PASS |
| One validator mirrored by DB constraints | PARTIAL (direct table writes: L12) |
| No `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`; no URLs from input | PASS |
| One write path (`guardedWrite` → outbox → `apply_changes`) | PASS in the app; PARTIAL in the database (L12) |
| Offline data keyed by user, wiped on sign-out, sign-out blocked while unsynced | PASS (two-tab case: L1; refused answers: L3) |
| Errors always shown | PARTIAL → fixed (L10) |
| In-app confirmation dialogs, no `confirm`/`alert`/`prompt` | PASS |
| CSP (no `unsafe-*`, connect-src = Supabase origin), frame-busting, PKCE | PASS |
| Dependencies well-known; `npm audit` | PASS (0 vulnerabilities) |
| CI least-privilege `permissions:`, no `${{ }}` in `run:`, import manual only | PASS (no `pull_request_target`; `persist-credentials: false`) |
| Sign-ups off, email + password only | needs live check (owner step 2) |

## Dependency review

- `npm audit`: **0 vulnerabilities** (all packages and production-only).
- Reminder function packages (not covered by `npm audit`, pinned in `deno.lock`):
  `web-push@3.6.7`, `@supabase/supabase-js@2.117.3`: **0 vulnerabilities** in a separate audit.
- Every package in `package.json` is used and well known. Install scripts: only `deno`
  (official, downloads its binary) and `fsevents` (macOS only).
- Behind the latest: `@playwright/test` 1.56.1 (kept on purpose to match the pre-installed
  Chromium), `eslint` 10.0.1 → 10.12.0 (dev only). No update needed for security.

## Checks for the owner (live system, read-only)

The exact steps are given in the chat, and will be copied to HANDOFF.md once done.
1. Michelle's time zone shown in Settings (M6).
2. Supabase sign-up and anonymous sign-in switches (L14).
3. Read-only SQL in the Supabase SQL editor: grants and RLS, function rights, default
   privileges, realtime/storage/GraphQL exposure, accounts and push hosts.
4. Export on the iPhone actually saves a file in Files (M5).
5. GitHub: fork pull request approval and default workflow permissions.
