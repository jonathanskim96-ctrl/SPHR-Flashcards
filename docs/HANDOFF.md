# HANDOFF: SPHR Flashcards

Every session reads this first, right after `CLAUDE.md`. Keep it short and current.

## 1. Current state (2026-10-13)

- **Planning is complete; no app code yet.** The next step is `docs/BUILD_PLAN.md` Phase 0.
- In the repo: `content/questions.json` (400 questions, 26 scenarios, bankVersion
  `2026-10-13.1`, passes the validator), `docs/QUESTION_FORMAT.md` (schema v1),
  `scripts/validate-bank.mjs`, `APP_BUILD_PLAYBOOK.md`, `PLANNING_PROMPT.md`, and the
  docs: `CLAUDE.md`, `docs/BUILD_PLAN.md`, `docs/SETUP.md`, `docs/RECOVERY.md`,
  `docs/INSTALL.md`.
- Supabase project: **not created yet** (SETUP Part B).
- GitHub Pages: **not set up yet** (SETUP Part A).
- Work happens on branch `claude/charming-cerf-rbnjub`. Nothing goes to `main` without the
  owner's OK.

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
1. **Exam date.** Placeholder default is 2026-12-01. Tell the build session her actual
   exam date (she can also change it in Settings). Scheduling never sets a card due after it.
2. Michelle's sign-in email, needed for SETUP step B6. Give it to Claude only if you want
   it written into the docs; otherwise just use it in the dashboard.

**Content (for the owner's question-writing project; no app action needed)**
3. 102 free-response worksheet items were rewritten as multiple choice.
4. Practice-test questions 70–85: in 10 items two choices were swapped, so the app's
   answer letters differ from the Word answer key (each item's `source.note` says so).
   The app shows no letters, so this is invisible to her.
5. In the practice-test items the correct choice is the longest choice 57 of 120 times
   (the validator reports 76 of 222 across all MC). Shuffling doesn't fix this cue.
6. `trw1-q01` (compa-ratio 0.85): typing "85%" is graded **wrong** under the decided numeric
   rule. Suggest changing the stem or adding the unit; that's a content edit with a revision bump.
7. `hiw1-q19` (unit °F): typing "87°" (degree sign without F) is graded wrong. Minor.
8. If a future text answer contains an apostrophe, the iPhone keyboard types a curly ’
   that won't match a straight '. No current answer has one. Decide then whether to forgive it.

**Unverified facts (confirm during SETUP)**
9. The cloud session could not open apple.com, webkit.org or supabase.com directly; the
   facts in §4 come from search results quoting those docs, plus community write-ups.
   SETUP Part G lists what to check on the live dashboard.
10. GitHub turns off scheduled workflows in a public repo after 60 days with no commits; it
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
./supabase/tests/run.sh                    # local Postgres: RLS, attack, import, recovery, contract
npm run e2e                                # Playwright, iPhone 13 Pro Max profile
```
(Until Phase 0 is built, only the first validator command exists.)
