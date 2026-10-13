// scripts/import-bank.mjs end to end (BUILD_PLAN Phase 8): the real script, run as the
// workflow runs it, talks to a small stand-in for the Supabase web address that hands each
// call to the real import_bank function in the throwaway database, as the service role.
// Each call runs in a transaction that is rolled back; earlier "applied" calls are replayed
// first, so the database is left empty for the other tests.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import real from '../../../content/questions.json';
import sample from '../../../tests/fixtures/sample-bank.json';
import { sqlOk } from './psql';

const KEY = 'sb_secret_test_only';
let server: Server;
let url = '';
let dir = '';
const applied: string[] = []; // file paths of banks applied so far
let counter = 0;

function callFunction(bank: unknown, apply: boolean): string {
  const file = join(dir, `bank-${counter++}.json`);
  writeFileSync(file, JSON.stringify(bank));
  const script = [
    'begin;',
    // Earlier test files leave their own fake bank behind; start from empty bank tables
    // (rolled back below, the same override the contract test uses).
    "set local app.guardrail_override = 'test: import script, rolled back';",
    'delete from public.questions; delete from public.scenarios; delete from public.bank_meta;',
    'select tests.login_service() \\gset',
    ...applied.map((f, i) => `\\set prev${i} \`cat ${f}\``),
    `\\set cur \`cat ${file}\``,
    ...applied.map((_, i) => `select public.import_bank(:'prev${i}'::jsonb, true) \\g /dev/null`),
    `select public.import_bank(:'cur'::jsonb, ${apply});`,
    'rollback;',
  ].join('\n');
  const out = sqlOk(script).split('\n').filter(Boolean).pop() as string;
  if (apply && (JSON.parse(out) as { applied: boolean }).applied) applied.push(file);
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'import-test-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (code: number, body: string) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(body);
      };
      if (req.headers.apikey !== KEY) return send(401, '{"message":"Invalid API key"}');
      if (req.method !== 'POST' || req.url !== '/rest/v1/rpc/import_bank')
        return send(404, '{"message":"not found"}');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        p_bank: unknown;
        p_apply: boolean;
      };
      try {
        send(200, callFunction(body.p_bank, body.p_apply));
      } catch (e) {
        send(400, JSON.stringify({ message: (e as Error).message }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function runScript(bank: unknown, apply: boolean, key = KEY) {
  const file = join(dir, `input-${counter++}.json`);
  writeFileSync(file, JSON.stringify(bank));
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['scripts/import-bank.mjs', file], {
      env: {
        PATH: process.env.PATH,
        SUPABASE_URL: url,
        SUPABASE_SECRET_KEY: key,
        APPLY: String(apply),
      },
    });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', (code) => resolve({ code, out }));
  });
}

type FakeBank = {
  bankVersion: string;
  questions: { id: string; revision: number; status: string; stem: string }[];
};
const v1 = sample as unknown as FakeBank;
let latest = v1; // the bank applied last, in this file's tests

describe('import-bank.mjs against the real import_bank function', () => {
  const before = sqlOk('select count(*) from public.questions');
  it('fake bank: preview, apply, re-run is a no-op, nothing left behind', async () => {
    let r = await runScript(v1, false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\*\*PREVIEW ONLY: nothing was written\*\*/);
    expect(r.out).toContain('| New | 19 | 1 |');

    r = await runScript(v1, true);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\*\*APPLIED: 19 new, 0 changed\*\*/);

    r = await runScript(v1, true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| New | 0 | 0 |');
    expect(r.out).toContain('| Unchanged | 19 | |');
  });

  it('a second version: new, edited and retired questions; no duplicates', async () => {
    const v2 = structuredClone(v1);
    latest = v2;
    v2.bankVersion = '2026-10-14.1';
    const [a, b, c] = v2.questions;
    // Two new questions (clones of a fake one under new ids), one stem edit, one retirement.
    v2.questions.push({ ...a, id: 'fake1-q90' }, { ...a, id: 'fake1-q91' });
    b.revision += 1;
    b.stem = `${b.stem} (edited)`;
    c.status = 'retired';
    let r = await runScript(v2, false);
    expect(r.out).toMatch(/^\*\*PREVIEW ONLY/);
    expect(r.out).toContain('| New | 2 |');
    expect(r.out).toContain('| Changed | 2 |');
    expect(r.out).toContain('| Newly retired | 1 |');
    r = await runScript(v2, true);
    expect(r.out).toMatch(/^\*\*APPLIED: 2 new, 2 changed\*\*/);
    r = await runScript(v2, true);
    expect(r.out).toContain('| Unchanged | 21 |');
    expect(sqlOk('select count(*) from public.questions')).toBe(before); // rolled back
  });

  it('refuses a deleted question, a stem change with no new revision, and an old version', async () => {
    const gone = structuredClone(v1);
    gone.bankVersion = '2026-10-15.1';
    gone.questions.pop();
    let r = await runScript(gone, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAILED: nothing was written/);
    expect(r.out).toMatch(/missing from the new bank/);

    const sneaky = structuredClone(v1);
    sneaky.bankVersion = '2026-10-15.1';
    sneaky.questions[0].stem += ' changed quietly';
    r = await runScript(sneaky, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/content changed but revision was not raised/);

    const old = structuredClone(latest);
    old.bankVersion = '2026-01-01.1';
    r = await runScript(old, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/older than the stored/);
  });

  it('a wrong key is refused and nothing is written', async () => {
    const r = await runScript(v1, true, 'sb_secret_wrong');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\*\*FAILED: the database refused the import/);
    expect(r.out).not.toContain('sb_secret_wrong');
  });

  it('the real bank (read only): preview says 400 new; apply works', async () => {
    applied.length = 0; // start from an empty database for the real bank
    let r = await runScript(real, false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('| New | 400 | 26 |');
    r = await runScript(real, true);
    expect(r.out).toMatch(/^\*\*APPLIED: 400 new, 0 changed\*\*/);
    r = await runScript(real, true);
    expect(r.out).toContain('| Unchanged | 400 | |');
    applied.length = 0;
  });
});
