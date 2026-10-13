#!/usr/bin/env node
// Validates content/questions.json. Exit code 1 on any error, so CI blocks a bad bank.
// Usage: node scripts/validate-bank.mjs [path] [--previous path-to-previous-bank.json]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--previous') ?? 'content/questions.json';
const prevIdx = args.indexOf('--previous');
const prevPath = prevIdx >= 0 ? args[prevIdx + 1] : null;

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

let bank;
try {
  bank = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`Cannot read or parse ${path}: ${e.message}`);
  process.exit(1);
}

const TYPES = new Set(['mc', 'multi', 'numeric', 'text', 'ordering', 'matching']);
const LEVELS = new Set(['K', 'A', 'S']);
const STATUS = new Set(['active', 'retired']);
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const isStr = (s) => typeof s === 'string' && s.trim().length > 0;
const MAX_TEXT = 2000;

if (bank.schemaVersion !== 1) err('bank', `schemaVersion must be 1, got ${bank.schemaVersion}`);
if (!isStr(bank.bankVersion)) err('bank', 'bankVersion missing');
const areaIds = new Set((bank.areas ?? []).map((a) => a.id));
if (areaIds.size !== 5) err('bank', 'areas must list the 5 functional areas');
for (const l of LEVELS) if (!bank.levels?.[l]?.points) err('bank', `levels.${l}.points missing`);

const scen = new Map();
for (const s of bank.scenarios ?? []) {
  if (!ID_RE.test(s.id ?? '')) err(s.id ?? '?', 'scenario id invalid');
  if (scen.has(s.id)) err(s.id, 'duplicate scenario id');
  if (!isStr(s.text)) err(s.id, 'scenario text missing');
  if (!areaIds.has(s.area)) err(s.id, 'scenario area invalid');
  scen.set(s.id, s);
}

const ids = new Set();
const usedScen = new Set();
const uniq = (arr) => new Set(arr).size === arr.length;
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');

for (const q of bank.questions ?? []) {
  const id = q.id ?? '?';
  if (!ID_RE.test(id)) err(id, 'id invalid (lowercase letters, digits, hyphens)');
  if (ids.has(id)) err(id, 'duplicate id');
  ids.add(id);
  if (!TYPES.has(q.type)) { err(id, `unknown type ${q.type}`); continue; }
  if (!areaIds.has(q.area)) err(id, `unknown area ${q.area}`);
  if (!LEVELS.has(q.level)) err(id, `unknown level ${q.level}`);
  if (!STATUS.has(q.status)) err(id, `unknown status ${q.status}`);
  if (!Number.isInteger(q.revision) || q.revision < 1) err(id, 'revision must be an integer >= 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.added ?? '')) err(id, 'added must be YYYY-MM-DD');
  if (!isStr(q.stem)) err(id, 'stem missing');
  if (!isStr(q.explanation)) err(id, 'explanation (why the answer is correct) missing');
  if (!Array.isArray(q.outline) || q.outline.length === 0) err(id, 'outline task(s) missing');
  for (const f of ['stem', 'explanation']) if ((q[f] ?? '').length > MAX_TEXT) err(id, `${f} longer than ${MAX_TEXT} chars`);
  if (q.scenarioId != null) {
    if (!scen.has(q.scenarioId)) err(id, `scenarioId ${q.scenarioId} not found`);
    else { usedScen.add(q.scenarioId); if (scen.get(q.scenarioId).area !== q.area) warn(id, 'scenario area differs from question area'); }
  }
  if (/\b(all|none) of the above\b/i.test(JSON.stringify(q.choices ?? ''))) err(id, 'uses all/none of the above');

  if (q.type === 'mc' || q.type === 'multi') {
    const ch = q.choices ?? [];
    if (ch.length < 3 || ch.length > 5) err(id, `needs 3-5 choices, has ${ch.length}`);
    const cids = ch.map((c) => c.id);
    if (!uniq(cids)) err(id, 'duplicate choice ids');
    if (!uniq(ch.map((c) => norm(c.text ?? '')))) err(id, 'duplicate choice text');
    if (ch.some((c) => !isStr(c.text))) err(id, 'empty choice text');
    const ans = q.type === 'mc' ? [q.answer] : q.answer;
    if (!Array.isArray(ans) || ans.length === 0) err(id, 'answer missing');
    else for (const a of ans) if (!cids.includes(a)) err(id, `answer ${a} is not a choice id`);
    if (q.type === 'multi') {
      if (!uniq(ans)) err(id, 'duplicate answers');
      if (q.selectCount !== ans.length) err(id, 'selectCount must equal number of answers');
      if (ans.length >= ch.length) err(id, 'multi-select must leave at least one wrong choice');
    }
    const wrong = cids.filter((c) => !ans.includes(c));
    for (const w of wrong) if (!isStr(q.wrongReasons?.[w])) warn(id, `no explanation for wrong choice ${w}`);
  }
  if (q.type === 'numeric') {
    const a = q.answer;
    if (typeof a?.value !== 'number' || !Number.isFinite(a.value)) err(id, 'answer.value must be a finite number');
    if (typeof a?.tolerance !== 'number' || a.tolerance < 0) err(id, 'answer.tolerance must be a number >= 0');
    if (typeof a?.unit !== 'string') err(id, 'answer.unit must be a string (may be empty)');
  }
  if (q.type === 'text') {
    const acc = q.accepted ?? [];
    if (acc.length === 0 || acc.some((s) => !isStr(s))) err(id, 'accepted answers missing or empty');
    if (!uniq(acc.map(norm))) err(id, 'accepted answers repeat after normalizing');
    if (!/_{3,}/.test(q.stem ?? '')) warn(id, 'text stem has no ____ blank');
  }
  if (q.type === 'ordering') {
    const it = (q.items ?? []).map((i) => i.id);
    if (it.length < 3) err(id, 'ordering needs at least 3 items');
    if (!uniq(it)) err(id, 'duplicate item ids');
    const a = q.answer ?? [];
    if (a.length !== it.length || !uniq(a) || a.some((x) => !it.includes(x))) err(id, 'answer must be a permutation of item ids');
    if (a.every((x, i) => x === it[i])) err(id, 'items are already listed in the correct order');
  }
  if (q.type === 'matching') {
    const p = (q.prompts ?? []).map((x) => x.id);
    const o = (q.options ?? []).map((x) => x.id);
    if (p.length < 3) err(id, 'matching needs at least 3 prompts');
    if (o.length < p.length) err(id, 'fewer options than prompts');
    if (!uniq(p) || !uniq(o)) err(id, 'duplicate prompt or option ids');
    const a = q.answer ?? {};
    if (Object.keys(a).length !== p.length || p.some((x) => !o.includes(a[x]))) err(id, 'answer must map every prompt to a valid option');
    if (!uniq(Object.values(a))) err(id, 'an option is used twice');
  }
}
for (const s of scen.keys()) if (!usedScen.has(s)) warn(s, 'scenario not used by any question');

// Answer-letter pattern scan for single-answer MC, per source document in source order (project rule 7).
function patternProblems(seq) {
  const out = [];
  for (let i = 2; i < seq.length; i++) if (seq[i] === seq[i - 1] && seq[i] === seq[i - 2]) out.push(`run of 3 at position ${i - 1}`);
  for (let p = 2; p <= 5; p++) {
    if (seq.length >= 2 * p + 1) {
      let m = 0;
      for (let i = p; i < seq.length; i++) if (seq[i] === seq[i - p]) m++;
      if (m / (seq.length - p) > 0.5) out.push(`period-${p} pattern (${m}/${seq.length - p} positions repeat)`);
    }
    for (let i = 0; i + 3 * p <= seq.length; i++) {
      const a = seq.slice(i, i + p).join(''), b = seq.slice(i + p, i + 2 * p).join(''), c = seq.slice(i + 2 * p, i + 3 * p).join('');
      if (a === b && b === c) { out.push(`block ${a} repeats 3 times at position ${i + 1}`); break; }
    }
  }
  return out;
}
const byDoc = new Map();
for (const q of bank.questions ?? []) {
  if (q.type !== 'mc' || q.status !== 'active') continue;
  const d = q.source?.doc ?? 'unknown';
  if (!byDoc.has(d)) byDoc.set(d, []);
  byDoc.get(d).push(q);
}
const letterReport = [];
for (const [d, qs] of byDoc) {
  qs.sort((a, b) => (a.source?.number ?? 0) - (b.source?.number ?? 0));
  const seq = qs.map((q) => q.answer);
  const c = {}; for (const l of seq) c[l] = (c[l] ?? 0) + 1;
  const probs = patternProblems(seq);
  const counts = ['A', 'B', 'C', 'D'].map((l) => c[l] ?? 0);
  if (Math.max(...counts) - Math.min(...counts) > Math.max(2, Math.ceil(seq.length * 0.1))) probs.push(`unbalanced letters ${counts.join('/')}`);
  letterReport.push(`${d}: ${seq.length} MC, A/B/C/D = ${counts.join('/')}${probs.length ? ' — ' + probs.join('; ') : ''}`);
  for (const p of probs) err(d, `answer letters: ${p}`);
}
// Correct-answer-is-longest cue check (warning only)
let longest = 0, mcCount = 0;
for (const q of bank.questions ?? []) {
  if (q.type !== 'mc') continue;
  mcCount++;
  const lens = q.choices.map((c) => c.text.length);
  const ai = q.choices.findIndex((c) => c.id === q.answer);
  if (lens[ai] === Math.max(...lens) && lens.filter((l) => l === lens[ai]).length === 1) longest++;
}
if (longest / mcCount > 0.4) warn('bank', `correct answer is the single longest choice in ${longest}/${mcCount} MC items (cue risk)`);

// Stable-id check against a previous bank: ids may never disappear (retire instead).
if (prevPath) {
  const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
  for (const q of prev.questions ?? []) if (!ids.has(q.id)) err(q.id, 'question removed; set status "retired" instead of deleting');
}

const counts = {};
for (const q of bank.questions ?? []) counts[q.type] = (counts[q.type] ?? 0) + 1;
console.log(`Questions: ${bank.questions?.length ?? 0} ${JSON.stringify(counts)}; scenarios: ${scen.size}`);
console.log(`Correct choice is the single longest in ${longest}/${mcCount} MC items`);
console.log('Answer-letter scan:\n  ' + letterReport.join('\n  '));
if (warnings.length) console.log(`\n${warnings.length} warning(s):\n  ` + warnings.join('\n  '));
if (errors.length) { console.error(`\n${errors.length} error(s):\n  ` + errors.join('\n  ')); process.exit(1); }
console.log('\nOK: bank is valid.');
