You are the PLANNING session for a new app. Do not write app code in this session.
Your output is docs committed to the repo: CLAUDE.md, docs/HANDOFF.md, docs/BUILD_PLAN.md,
docs/SETUP.md, docs/RECOVERY.md, and docs/INSTALL.md. A later Sonnet session will build from them.

## Read first (already in the repo)
- APP_BUILD_PLAYBOOK.md: its process, data-safety, security, testing, and release rules apply
  in full. Put its sections 2–3 into CLAUDE.md, adapted to this app.
- content/questions.json: the real question bank (400 questions), already built and validated.
- docs/QUESTION_FORMAT.md: the bank's schema (version 1). Build around it; do not redesign it.
  If you think it needs a change, propose it to me first.
- scripts/validate-bank.mjs: the bank validator. It must run in CI and block deploys/imports.
- I'm non-technical: exact clicks, one step at a time, paste content in chat rather than
  linking files. Ask me before deciding any product trade-off: 2–3 options with a
  recommendation. Record my answers in docs/HANDOFF.md.

## My standing safety rules (put these in CLAUDE.md)
- Database access is read-only by default. Before any command that deletes, wipes, or updates
  data or tables, stop and get my explicit approval for that one change. Never run it unapproved.
- Refuse outright: git force-push or any history-rewriting git command.
- There is no backup safety net (free Supabase plan, no branch protection), so when in doubt,
  don't run the destructive command.

## The app
"SPHR Flashcards": a single-user installable PWA for my girlfriend Michelle to study for the
HRCI SPHR exam (December 2026). Installed from Safari on her iPhone 13 Pro Max (iOS 27.0.1)
via Add to Home Screen. Public GitHub repo, deployed free on GitHub Pages
(repo name "SPHR Flashcards" becomes "SPHR-Flashcards", which sets the Pages URL and base path).
Stack per the playbook: React + Vite + TypeScript + vite-plugin-pwa + Supabase (free tier).
One user, no sharing, no social features.

Style: Duolingo-like, with levels and visible progress markers.

### Structure
- Units are the 5 SPHR functional areas. Inside each area, levels are difficulty tiers from the
  bank's `level` field: K = tier 1, A = tier 2, S = tier 3.
- She can study one area or choose several areas at once.
- XP: correct answer earns the level's points (K = 1, A = 2, S = 3). Propose any bonuses
  to me; don't add them silently.
- Spaced repetition schedules every card. A Mistakes deck holds cards she got wrong.
- NOT included: hearts/lives, timed exam mode, leaderboards, streaks (unless I approve).

### Question types (all six are in the bank and all are required)
mc, multi (choose N), numeric, text (exact spelling), ordering, matching. Scenario questions
show their shared scenario text above the stem. Ordering and matching must work by touch on
iPhone, with an accessible non-drag fallback (e.g., tap to select, tap to place).

### Grading (decided)
- text: correct if it matches any `accepted` answer after lowercasing, trimming, collapsing
  spaces, and dropping one trailing period. Nothing else is forgiven.
- numeric: strip $, %, commas, spaces, and the unit; correct if within `tolerance`.

### Feedback (decided)
- Correct: brief confirmation plus XP earned.
- Wrong: show the correct answer and `explanation`. Don't show distractor reasons or citations
  (they stay in the data).

### Notifications
- Daily push reminder, default 3:00 PM in her local time, text:
  "You should practice some questions". She can change the time or turn it off in Settings.
- Verify current iOS home-screen web push requirements from Apple/WebKit docs (permission
  must come from a user tap; works only after install).
- Sending runs on Supabase: push subscription + reminder time/time zone stored in a table, a
  scheduled job, and an Edge Function sending Web Push with VAPID keys kept as Supabase
  secrets, never in the repo.

### Supabase does three jobs (all on the FREE plan; if anything needs a paid plan, stop and tell me)
1. **Progress backup and sync.** Her progress (XP, levels, spaced-repetition state per card,
   attempt history, Mistakes deck, settings) syncs to Supabase so it survives a lost or replaced
   phone. The app is offline-first: progress saves on the phone first and syncs when online
   (the playbook's outbox pattern). Progress is keyed by question `id` and `revision`.
   Attempt history is append-only. Sign-in method: propose options (playbook default is
   Google sign-in, then lock sign-ups after her first sign-in).
2. **Question bank storage.** A `questions` table mirrors content/questions.json. The app reads
   questions from Supabase when online, caches them for offline use, and shows new questions
   without an app update. content/questions.json in GitHub stays the master copy and the
   backup. The import into Supabase is insert/update only (never delete; retired questions
   keep `status: "retired"`), runs only after the validator passes, and must respect my
   approval rule for database writes. Give me options for how the import is triggered (for
   example: I paste generated SQL into the SQL editor, or I manually click "Run workflow" on a
   GitHub Action), with a recommendation. If Supabase is unreachable, the app falls back to its
   cached bank, then to a copy of questions.json bundled at build time.
3. **Reminder sending** (above).
- Apply the playbook's Supabase and security rules: RLS on every table with
  `user_id = (select auth.uid())`, revoke from anon, questions table read-only to the app,
  safety log, mass-delete caps, local Postgres tests including an attack suite and a recovery
  test, and a tested recovery script in docs/RECOVERY.md.
- Verify from Supabase docs whether free projects pause after inactivity, whether the daily
  scheduled job and her normal use prevent that, and what happens to reminders and syncing if it
  pauses. If it's a risk, give me options.
- Also include an in-app export/import of progress as a second backup.

### Adding questions later
I will generate new questions in my separate Claude project, following
docs/QUESTION_FORMAT.md, and add them to content/questions.json. Plan the full path from
"edited file" to "questions on her phone" so it's as few steps as possible for me, with the
validator and my database-approval rule in the way of anything bad. Never invent SPHR
questions; tests use a small, clearly fake sample bank.

### Known content items (record in HANDOFF open items; no action needed in this session)
- 102 free-response worksheet items were rewritten as multiple choice.
- Practice test questions 70–85: in 10 items, two choices were swapped, so the app's answer
  letters differ from the Word answer key (each item's `source.note` says so).
- In the practice-test items, the correct choice is the longest choice 57 of 120 times.

## Decisions to ask me about (don't assume)
- Shuffle choice order at display time? (Shuffling also hides the letter issue above.)
- Partial credit (if any) for multi, ordering, and matching.
- How tiers unlock (open from the start, or after mastering the tier below?) and what
  "mastery" means.
- Spaced-repetition algorithm and tuning (daily new-card cap, session length).
- Which progress markers appear (area progress bars, level badges, XP totals, etc.).
- Sign-in method, and the question-import trigger (above).
- Anything else that's a product trade-off.

## Deliverables
1. CLAUDE.md: playbook standing rules plus my safety rules above.
2. docs/HANDOFF.md: current state, my decisions, open items, how to run checks.
3. docs/BUILD_PLAN.md: ordered phases for the Sonnet session, each with acceptance criteria
   and the tests that prove it: unit + fuzz for spaced repetition, XP, and grading of every
   question type (using real edge cases from the bank); validator in CI; local Postgres RLS,
   attack, and recovery tests; app↔DB contract tests; offline sync and conflict tests;
   Playwright e2e at iPhone viewport for every question type, including touch drag-and-drop;
   PWA installability; offline use; the new-questions update flow.
4. docs/SETUP.md: click-by-click Supabase setup (project, sign-in, SQL, Edge Function, secrets,
   schedule) and GitHub Pages deploy, written for me.
5. docs/RECOVERY.md: how to restore progress and the question table.
6. docs/INSTALL.md: plain steps for Michelle or me to install the app on her iPhone from Safari
   and turn on notifications.

Show me the plan in chat for approval before committing. Don't push to main without my OK.
