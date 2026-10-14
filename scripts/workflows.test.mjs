// Workflow guardrails (CLAUDE.md §2 CI): no ${{ }} inside a run: block (untrusted values go
// through env:), least-privilege permissions, the import is manual only, the keep-alive
// schedule and permissions are as planned. Uses actionlint too when it is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = '.github/workflows';
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const text = (f) => readFileSync(`${DIR}/${f}`, 'utf8');

/** Lines belonging to `run:` blocks (single-line and `|` / `>` block scalars). */
function runLines(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length + (lines[i].includes('- run:') ? 2 : 0);
    if (m[2] && !/^[|>][+-]?$/.test(m[2])) {
      out.push(m[2]);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== '' && l.search(/\S/) <= indent) break;
      out.push(l);
    }
  }
  return out;
}

test('there are workflows to check', () => {
  for (const f of ['ci.yml', 'deploy.yml', 'import-questions.yml', 'keepalive.yml'])
    assert.ok(files.includes(f), `${f} is missing`);
});

test('no workflow puts ${{ }} inside a run: block', () => {
  for (const f of files)
    for (const l of runLines(text(f)))
      assert.ok(!l.includes('${{'), `${f}: "${l.trim()}" uses an expression inside run:`);
});

test('every workflow declares permissions', () => {
  for (const f of files) assert.match(text(f), /^permissions:/m, `${f} has no permissions:`);
});

test('the import workflow: manual only, apply defaults to false, read-only token', () => {
  const t = text('import-questions.yml');
  assert.match(t, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(t, /^\s+(push|schedule|pull_request\w*):/m);
  assert.match(t, /apply:[\s\S]*?type: boolean\n\s+default: false/);
  assert.match(t, /^permissions:\n {2}contents: read\n/m);
  assert.match(t, /ref: main/);
  assert.ok(
    t.indexOf('scripts/validate-bank.mjs') < t.indexOf('scripts/import-bank.mjs'),
    'the validator must run before the import',
  );
  assert.match(t, /APPLY: \$\{\{ inputs\.apply \}\}/);
  assert.match(t, /SUPABASE_SECRET_KEY: \$\{\{ secrets\.SUPABASE_SECRET_KEY \}\}/);
  assert.match(t, /GITHUB_STEP_SUMMARY/);
});

test('the keep-alive workflow: daily 15:17 UTC + manual, no token permissions', () => {
  const t = text('keepalive.yml');
  assert.match(t, /cron: '17 15 \* \* \*'/);
  assert.match(t, /^ {2}workflow_dispatch:/m);
  assert.match(t, /^permissions: \{\}$/m);
  assert.match(t, /rpc\/keepalive/);
  assert.match(t, /SUPABASE_SECRET_KEY: \$\{\{ secrets\.SUPABASE_SECRET_KEY \}\}/);
  assert.match(t, /-ge 300/, 'a non-2xx answer must fail the run');
});

test('the secret key is only used by the import and keep-alive workflows', () => {
  for (const f of files)
    if (!['import-questions.yml', 'keepalive.yml'].includes(f))
      assert.doesNotMatch(text(f), /SUPABASE_SECRET_KEY/, `${f} must not use the secret`);
});

test('variables are shape-checked in an if: before any step can print them (audit M4)', () => {
  for (const [f, vars] of [
    ['deploy.yml', ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_VAPID_PUBLIC_KEY']],
    ['import-questions.yml', ['VITE_SUPABASE_URL']],
    ['keepalive.yml', ['VITE_SUPABASE_URL']],
  ]) {
    const t = text(f);
    const check = t.indexOf('- name: Check the repository variables');
    assert.ok(check > 0, `${f} has no variable check`);
    for (const v of vars) {
      const firstUse = t.indexOf(`\${{ vars.${v} }}`);
      assert.ok(firstUse === -1 || firstUse > check, `${f}: ${v} is used before the check`);
      assert.match(t.slice(check), new RegExp(`if: >-[\\s\\S]*vars\\.${v}`), `${f}: ${v}`);
    }
    assert.match(t, /'sb_publishable_'|'https:\/\/'/);
  }
  assert.match(
    text('deploy.yml'),
    /startsWith\(vars\.VITE_SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_'\)/,
  );
});

test('the secret is only reachable through the main-only environment (audit L16)', () => {
  for (const f of ['import-questions.yml', 'keepalive.yml'])
    assert.match(text(f), /^ {4}environment: supabase-admin$/m, f);
});

test('actionlint (when installed) accepts every workflow', (t) => {
  const r = spawnSync(
    'actionlint',
    files.map((f) => `${DIR}/${f}`),
    { encoding: 'utf8' },
  );
  if (r.error) return t.skip('actionlint is not installed');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
