// Self-test for the bank validator: the fake bank passes, every bad bank fails for the
// expected reason, and the --previous check catches a removed question id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const validate = (...args) =>
  spawnSync(process.execPath, ['scripts/validate-bank.mjs', ...args], { encoding: 'utf8' });
const SAMPLE = 'tests/fixtures/sample-bank.json';

test('the fake sample bank is valid', () => {
  const r = validate(SAMPLE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the real bank is valid (read-only)', () => {
  const r = validate('content/questions.json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const EXPECTED = {
  'all-of-the-above.json': 'uses all/none of the above',
  'duplicate-id.json': 'duplicate id',
  'matching-option-used-twice.json': 'an option is used twice',
  'missing-answer.json': 'is not a choice id',
  'ordering-already-in-order.json': 'already listed in the correct order',
  'run-of-three-letters.json': 'run of 3',
};

test('every bad bank has an expected reason, and every expected bad bank exists', () => {
  assert.deepEqual(readdirSync('tests/fixtures/bad-banks').sort(), Object.keys(EXPECTED).sort());
});

for (const [file, reason] of Object.entries(EXPECTED)) {
  test(`the validator rejects bad-banks/${file}`, () => {
    const r = validate(join('tests/fixtures/bad-banks', file));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(reason.replace(/[/.]/g, '\\$&')));
  });
}

test('--previous fails when a question id was removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  const bank = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  bank.questions = bank.questions.filter((q) => q.id !== 'fake2-q05');
  const shrunk = join(dir, 'shrunk.json');
  writeFileSync(shrunk, JSON.stringify(bank));
  const r = validate(shrunk, '--previous', SAMPLE);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /fake2-q05: question removed; set status "retired"/);
});

test('--previous passes when ids are kept (retiring is allowed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  const bank = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  bank.questions.find((q) => q.id === 'fake2-q05').status = 'retired';
  const retired = join(dir, 'retired.json');
  writeFileSync(retired, JSON.stringify(bank));
  const r = validate(retired, '--previous', SAMPLE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
