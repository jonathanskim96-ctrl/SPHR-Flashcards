#!/usr/bin/env node
// Guardrail: applied migrations are never edited, removed or renumbered (CLAUDE.md §1).
//
// supabase/migrations/migrations.lock.json holds a sha256 per migration file. This script
// fails when a locked file is missing or its content changed, when a file is not in the
// lock yet, when file names are not numbered 0001, 0002, ... without gaps, or when a
// migration contains destructive SQL, or SQL that switches a guardrail off or widens access
// (audit M3), without a `-- guardrail-approved: <who, date, why>` comment line directly above
// that statement.
//
// Usage: node scripts/check-migrations.mjs [--record] [--dir supabase/migrations]
//   --record  adds new files to the lock. It never changes or removes an existing entry.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK = 'migrations.lock.json';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Replace comments, string literals and dollar-quoted bodies with spaces (newlines kept), so
// the destructive-SQL scan only sees statements that run when the migration is applied.
// A function body that *contains* `delete from` is a definition, not a deletion. (A `do`
// block's body does run: `findUnapproved` checks it separately.) Quoted identifiers keep
// their length but become `x`s, so a quote character inside one can't hide what follows.
export function maskSql(sql) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const identChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  while (i < sql.length) {
    const rest = sql.slice(i);
    let m;
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (rest[0] === "'" || (/^[eE]'/.test(rest) && !identChar(sql[i - 1]))) {
      // A string; in an E'…' string a backslash escapes the next character.
      const escapes = rest[0] !== "'";
      let j = i + (escapes ? 2 : 1);
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const stop = Math.min(j + 1, sql.length);
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (rest[0] === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      const stop = Math.min(j + 1, sql.length);
      out += '"' + sql.slice(i + 1, stop - 1).replace(/[^\n]/g, 'x') + (stop - i > 1 ? '"' : '');
      i = stop;
    } else if (!identChar(sql[i - 1]) && (m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

// Statements that destroy data or structure (checked in every statement except grants,
// revokes and `create`, which define something new).
const DESTRUCTIVE = [
  /\bdrop\s+[a-z]/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\bupdate\s+(only\s+)?[\w"]+(\s*\.\s*[\w"]+)?(\s+(as\s+)?[\w"]+)?\s+set\b/i,
  /\balter\s+table\b[\s\S]*\b(rename|drop)\b/i,
  /\balter\s+column\b[\s\S]*\btype\b/i,
  /\bmerge\s+into\b/i,
];
// Data changes that also count inside a `create` (e.g. `create table … as` with a delete).
const WRITES = [DESTRUCTIVE[2], DESTRUCTIVE[3], DESTRUCTIVE[6]];
// Statements that switch a guardrail off or widen access (audit M3). Checked in every
// statement, `create`/`grant` included, except in the files reviewed before these rules.
const WEAKENING = [
  /\balter\s+table\b[\s\S]*\bdisable\s+(trigger|rule)\b/i,
  /\balter\s+table\b[\s\S]*\benable\s+(replica|always)\s+(trigger|rule)\b/i,
  /\b(no\s+force|disable)\s+row\s+level\s+security\b/i,
  /\bcreate\s+or\s+replace\b/i,
  /\bcreate\s+rule\b/i,
  /\bsession_replication_role\b/i,
  /\bsecurity\s+definer\b/i,
  /\balter\s+(function|procedure|policy|trigger|role|database|schema)\b/i,
  /\balter\s+default\s+privileges\b[\s\S]*\bgrant\b/i,
  // Table-wide write rights (a column list, as in `grant update (a, b)`, is reviewed in place).
  /^\s*grant\b[\s\S]*\b(delete|truncate|references|trigger|all)\b[\s\S]*\bon\b/i,
  /^\s*grant\b[\s\S]*\b(insert|update)\b(?!\s*\()[\s\S]*\bon\b(?!\s+(function|sequence|schema)\b)/i,
];
// The approval: a comment line of its own among the lines directly above the statement.
const MARKER_RE = /^[ \t]*--[ \t]*guardrail-approved:[ \t]*\S/im;

// Files applied and reviewed before the WEAKENING rules existed, pinned by content: they keep
// passing exactly as they are (they can never change: the lock file sees to that), and any
// other file, even one added to the lock by hand, gets every rule.
const REVIEWED_BEFORE_M3 = new Set([
  'cecdc66c24d0860561b684327b862863adf509d78b447a7ed31d46e427cd9b18',
  '8ffdb2cbdfdbb0002d9c9637fa3a69b288f19c855c9aae48194cb0e3537edb39',
  '7a1f5695155943a4d8494bd559f34b4260bad14c6b64212054d3995dd65aa80e',
]);

/** The body of a `do` block, masked like any other SQL (it runs when applied). */
function doBody(rawStmt) {
  const m = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rawStmt);
  if (!m) return '';
  const end = rawStmt.indexOf(m[0], m.index + m[0].length);
  return maskSql(rawStmt.slice(m.index + m[0].length, end === -1 ? undefined : end));
}

// Returns a list of problems: destructive or guardrail-weakening statements with no approval.
export function findUnapproved(sql) {
  const legacy = REVIEWED_BEFORE_M3.has(sha256(sql));
  const masked = maskSql(sql);
  const problems = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i < masked.length && masked[i] !== ';') continue;
    const stmt = masked.slice(start, i);
    const first = stmt.search(/\S/);
    const raw = sql.slice(start, i);
    // A default-privileges change that only revokes is a permission change too.
    const isDefinition =
      /^\s*(revoke|grant|create)\b/i.test(stmt) ||
      (/^\s*alter\s+default\s+privileges\b/i.test(stmt) && !/\bgrant\b/i.test(stmt));
    const isDo = /^\s*do\b/i.test(stmt);
    const body = isDo ? doBody(raw) : '';
    const bad =
      (!isDefinition && DESTRUCTIVE.some((re) => re.test(stmt))) ||
      // `create table … as with d as (delete …)` still runs the delete.
      (isDefinition && WRITES.some((re) => re.test(stmt))) ||
      (!legacy && WEAKENING.some((re) => re.test(stmt))) ||
      (isDo &&
        (DESTRUCTIVE.some((re) => re.test(body)) ||
          WEAKENING.some((re) => re.test(body)) ||
          /\bexecute\b/i.test(body)));
    if (first !== -1 && bad) {
      // Only the comment lines before the statement's first word count, and only lines that
      // are comments on their own (not a comment trailing the previous statement).
      const leading = raw.slice(0, first);
      const ownLines =
        start === 0
          ? leading
          : leading.includes('\n')
            ? leading.slice(leading.indexOf('\n') + 1)
            : '';
      const approved = MARKER_RE.test(ownLines);
      if (!approved) {
        const line = sql.slice(0, start + first).split('\n').length;
        problems.push(
          `line ${line}: destructive statement without "-- guardrail-approved:" comment: ${stmt.trim().split('\n')[0].slice(0, 80)}`,
        );
      }
    }
    start = i + 1;
  }
  return problems;
}

export function checkMigrations(dir, { record = false } = {}) {
  const errors = [];
  const notes = [];
  const lockPath = join(dir, LOCK);
  let lock = {};
  if (existsSync(lockPath)) {
    try {
      lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch (e) {
      return { errors: [`${LOCK} is not valid JSON: ${e.message}`], notes };
    }
  }
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : [];

  for (const f of files)
    if (!NAME_RE.test(f)) errors.push(`${f}: name must look like 0001_short_name.sql`);
  const numbered = files.filter((f) => NAME_RE.test(f));
  numbered.forEach((f, idx) => {
    const n = Number(NAME_RE.exec(f)[1]);
    if (n !== idx + 1)
      errors.push(
        `${f}: expected number ${String(idx + 1).padStart(4, '0')} (no gaps, no duplicates, no renumbering)`,
      );
  });

  for (const [name, hash] of Object.entries(lock)) {
    if (!files.includes(name)) errors.push(`${name}: applied migration was removed or renamed`);
    else if (sha256(readFileSync(join(dir, name), 'utf8')) !== hash)
      errors.push(`${name}: applied migration was edited (add a new numbered migration instead)`);
  }

  const added = [];
  for (const f of numbered) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const p of findUnapproved(sql)) errors.push(`${f}: ${p}`);
    if (!(f in lock)) {
      if (record) added.push(f);
      else errors.push(`${f}: not in ${LOCK} yet (run with --record once the file is final)`);
    }
  }

  if (record && errors.length === 0 && added.length > 0) {
    const next = { ...lock };
    for (const f of added) next[f] = sha256(readFileSync(join(dir, f), 'utf8'));
    writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n');
    notes.push(`recorded: ${added.join(', ')}`);
  }
  if (record && errors.length > 0 && added.length > 0)
    notes.push('nothing recorded because of the errors above');
  notes.push(
    `${files.length} migration file(s), ${Object.keys(lock).length + (errors.length ? 0 : added.length)} locked`,
  );
  return { errors, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : 'supabase/migrations';
  const { errors, notes } = checkMigrations(dir, { record: args.includes('--record') });
  for (const n of notes) console.log(n);
  if (errors.length) {
    console.error(`\n${errors.length} error(s):\n  ` + errors.join('\n  '));
    process.exit(1);
  }
  console.log('OK: migrations are intact.');
}
