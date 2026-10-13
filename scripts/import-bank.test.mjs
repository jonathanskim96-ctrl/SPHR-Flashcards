// import-bank.mjs against a pretend server (the real database function is exercised by
// supabase/tests/contract/import.test.ts through ./supabase/tests/run.sh).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { importBank, importUrl } from './import-bank.mjs';

const reply =
  (body, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });
const base = {
  applied: false,
  bank_version: '2026-10-13.1',
  new: 400,
  changed: 0,
  unchanged: 0,
  newly_retired: 0,
  scenarios_new: 26,
  scenarios_changed: 0,
  errors: [],
};
const args = (over) => ({
  url: 'https://x.supabase.co',
  key: 'sb_secret_k',
  apply: false,
  bank: {},
  ...over,
});

test('preview text starts with PREVIEW ONLY', async () => {
  const r = await importBank(args({ fetchImpl: reply(base) }));
  assert.ok(r.ok);
  assert.match(r.markdown, /^\*\*PREVIEW ONLY: nothing was written\*\*/);
  assert.match(r.markdown, /\| New \| 400 \| 26 \|/);
});

test('applied text starts with APPLIED: N new, M changed', async () => {
  const r = await importBank(
    args({ apply: true, fetchImpl: reply({ ...base, applied: true, new: 2, changed: 3 }) }),
  );
  assert.match(r.markdown, /^\*\*APPLIED: 2 new, 3 changed\*\*/);
});

test('errors fail and are listed', async () => {
  const r = await importBank(
    args({ fetchImpl: reply({ ...base, errors: ['question a-b: missing'] }) }),
  );
  assert.equal(r.ok, false);
  assert.match(r.markdown, /FAILED: nothing was written/);
  assert.match(r.markdown, /- question a-b: missing/);
});

test('sends the key, one payload, and apply only when exactly true', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(base));
  };
  await importBank(args({ fetchImpl: f, apply: 'true' })); // a string is not a yes
  await importBank(args({ fetchImpl: f, apply: true }));
  assert.equal(seen[0].url, 'https://x.supabase.co/rest/v1/rpc/import_bank');
  assert.equal(JSON.parse(seen[0].init.body).p_apply, false);
  assert.equal(JSON.parse(seen[1].init.body).p_apply, true);
  assert.equal(seen[0].init.headers.apikey, 'sb_secret_k');
});

test('HTTP failures, junk replies and network errors fail without printing the key', async () => {
  for (const f of [
    reply({ message: 'nope' }, 401),
    reply('junk'),
    async () => {
      throw new Error('offline');
    },
  ]) {
    const r = await importBank(args({ fetchImpl: f }));
    assert.equal(r.ok, false);
    assert.match(r.markdown, /^\*\*FAILED/);
    assert.ok(!r.markdown.includes('sb_secret_k'));
  }
});

test('the address must be https (http only for localhost); the key is required', async () => {
  assert.throws(() => importUrl('http://x.supabase.co'), /https/);
  assert.throws(() => importUrl('not a url'), /valid/);
  assert.equal(importUrl('http://127.0.0.1:5/'), 'http://127.0.0.1:5/rest/v1/rpc/import_bank');
  await assert.rejects(importBank(args({ key: '' })), /SECRET_KEY/);
});

test('the command line exits 1 with a FAILED line when nothing is configured', () => {
  const r = spawnSync(
    process.execPath,
    ['scripts/import-bank.mjs', 'tests/fixtures/sample-bank.json'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILED: SUPABASE_SECRET_KEY is not set/);
});
