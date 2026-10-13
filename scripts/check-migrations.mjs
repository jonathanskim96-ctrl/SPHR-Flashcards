#!/usr/bin/env node
// Guardrail: applied migrations are never edited, removed or renumbered (CLAUDE.md §1).
//
// supabase/migrations/migrations.lock.json holds a sha256 per migration file. This script
// fails when a locked file is missing or its content changed, when a file is not in the
// lock yet, when file names are not numbered 0001, 0002, ... without gaps, or when a
// migration contains destructive SQL without a `-- guardrail-approved: <who, date, why>`
// comment right above that statement.
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
// A function body that *contains* `delete from` is a definition, not a deletion.
export function maskSql(sql) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
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
    } else if (rest[0] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const stop = Math.min(j + 1, sql.length);
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if ((m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
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

const DESTRUCTIVE = [
  /\bdrop\s+[a-z]/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\bupdate\s+[a-z_."]+\s+set\b/i,
  /\balter\s+table\b[\s\S]*\b(rename|drop)\b/i,
  /\balter\s+column\b[\s\S]*\btype\b/i,
];
const MARKER_RE = /--\s*guardrail-approved:\s*\S/i;

// Returns a list of problems: destructive statements with no approval marker.
export function findUnapproved(sql) {
  const masked = maskSql(sql);
  const problems = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i < masked.length && masked[i] !== ';') continue;
    const stmt = masked.slice(start, i);
    // `revoke truncate ...` / `grant ...` only change permissions.
    const isGrant = /^\s*(revoke|grant)\b/i.test(stmt);
    if (!isGrant && DESTRUCTIVE.some((re) => re.test(stmt))) {
      const raw = sql.slice(start, i);
      if (!MARKER_RE.test(raw)) {
        const line = sql.slice(0, start + Math.max(0, stmt.search(/\S/))).split('\n').length;
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
