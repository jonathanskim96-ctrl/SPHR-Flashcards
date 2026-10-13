# Question bank format (schema version 1)

The app's questions live in `content/questions.json`. This file is the **master copy**: it is
version-controlled in GitHub (the free Supabase plan has no backups), and it is loaded into the
Supabase `questions` table by an insert/update-only import. To add questions, edit this file
and run the validator: `node scripts/validate-bank.mjs`. CI runs the same check and refuses to
deploy or import a bank that fails.

## Top level

```json
{
  "schemaVersion": 1,
  "bankVersion": "2026-10-13.1",
  "areas":  [{ "id": 1, "name": "Leadership and Strategy" }, ...5 areas],
  "levels": { "K": { "name": "Knowledge/Comprehension", "points": 1 },
              "A": { "name": "Application", "points": 2 },
              "S": { "name": "Synthesis/Evaluation", "points": 3 } },
  "scenarios": [ ... ],
  "questions": [ ... ]
}
```

- `bankVersion`: `YYYY-MM-DD.n`. Raise it on every change so the app knows to refresh.
- Areas: 1 Leadership and Strategy; 2 Workforce Planning and Talent Acquisition;
  3 Talent Management; 4 Total Rewards; 5 HR Information Management, Safety, and Security.
- Levels are the difficulty tiers. XP per correct answer = `points`.

## Scenario

```json
{ "id": "lsw1-sa", "area": 1, "title": "Scenario A", "text": "Lakeshore Regional Credit Union ...",
  "source": { "doc": "Leadership and Strategy Worksheet 1" } }
```
Questions point to a scenario with `scenarioId`. The app shows the scenario text above each
of its questions, because cards are served one at a time.

## Fields on every question

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique and **permanent**. Lowercase letters, digits, hyphens. Progress is keyed by it. Never reuse or rename. |
| `type` | string | `mc`, `multi`, `numeric`, `text`, `ordering`, `matching` |
| `area` | 1–5 | Functional area |
| `level` | `K` / `A` / `S` | Difficulty tier and points (1/2/3) |
| `outline` | string[] | HRCI 2024 outline task numbers, e.g. `["1.12"]` |
| `category` | string or null | Sub-topic (practice-test items have one) |
| `scenarioId` | string or null | Shared scenario, if any |
| `stem` | string | The question. Must be answerable without seeing the options. |
| `explanation` | string | Why the correct answer is correct. Shown after a wrong answer. |
| `citations` | string[] | Statutes, regulations, or cases (may be empty) |
| `source` | object | `doc`, `number`, `originalType`; optional `note` |
| `added` | `YYYY-MM-DD` | Date first added |
| `revision` | integer ≥ 1 | Raise by 1 when the content changes |
| `status` | `active` / `retired` | Retired questions stop appearing; their history is kept |

Optional: `wrongReasons` (`mc`/`multi`: choice id → why it is wrong), `otherNotes`
(worksheet items: common wrong answers), `note` (matching: instruction line).

## Type-specific fields

**mc** — one answer
```json
"choices": [{ "id": "A", "text": "..." }, ...3 to 5], "answer": "C",
"wrongReasons": { "A": "...", "B": "...", "D": "..." }
```

**multi** — choose N
```json
"choices": [...5], "answer": ["A", "D"], "selectCount": 2
```
The stem states how many to choose. Graded all-or-nothing unless the owner decides otherwise.

**numeric**
```json
"answer": { "value": 13.2, "tolerance": 0, "unit": "%" }, "displayAnswer": "13.2%"
```
Correct when `|input − value| ≤ tolerance`. The app strips `$`, `%`, commas, spaces, and the
unit word before comparing. `unit` is shown next to the input box (`$`, `%`, `days`, `:1`, ...).

**text** — exact spelling
```json
"accepted": ["Age Discrimination in Employment Act", "ADEA"], "displayAnswer": "Age Discrimination in Employment Act"
```
Correct when the input matches any accepted answer after: lowercasing, trimming,
collapsing repeated spaces, and dropping one trailing period. Nothing else is forgiven,
so list every acceptable form (abbreviation, hyphenated, plural) explicitly.

**ordering**
```json
"items": [{ "id": "A", "text": "..." }, ...], "answer": ["D", "E", "C", "B", "A"]
```
`items` must not already be in the correct order.

**matching**
```json
"prompts": [{ "id": "1", "text": "SWOT analysis" }, ...],
"options": [{ "id": "A", "text": "Scans political, economic ..." }, ...],
"answer":  { "1": "D", "2": "A", ... }
```
There may be one more option than prompts (a distractor). Each option is used at most once.

## Changing the bank without breaking progress

- **Add**: new object with a new `id`. Suggested id pattern: `<area code><set>-q<nn>`, e.g.
  `trw3-q07`, or `pt2-q041` for a second practice test.
- **Fix a typo or wording**: edit in place, raise `revision`. Progress is kept.
- **Change the answer** or meaning: raise `revision`. The app resets spaced-repetition state for
  that card only (it is effectively a new question).
- **Remove**: set `status` to `"retired"`. Never delete a question; the validator fails if an
  id that existed before is missing (`--previous old.json`).

## Content rules (from the SPHR project instructions)

Every new batch must meet the project's 11 checks before it is added: one best answer;
plausible, parallel, similar-length distractors; no "all/none of the above"; no negative
stems; legal accuracy for federal and California law as of December 2026; cognitive-level
tags; explanations for the key and each distractor; and an answer-letter scan with no runs
of 3 and no repeating cycles. The validator enforces the structural parts and the letter
scan; legal accuracy still needs a human/AI review against primary sources.
