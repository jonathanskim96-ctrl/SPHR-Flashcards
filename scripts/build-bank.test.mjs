import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBank } from './build-bank.mjs';

test('a valid bank is copied byte for byte', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'build-')), 'nested', 'bank.json');
  const r = buildBank('tests/fixtures/sample-bank.json', dest);
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(readFileSync(dest), readFileSync('tests/fixtures/sample-bank.json'));
});

test('an invalid bank stops the build and nothing is copied', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'build-')), 'bank.json');
  const r = buildBank('tests/fixtures/bad-banks/duplicate-id.json', dest);
  assert.equal(r.ok, false);
  assert.match(r.output, /duplicate id/);
  assert.equal(existsSync(dest), false);
});

test('a missing source file stops the build', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'build-')), 'bank.json');
  const r = buildBank('tests/fixtures/does-not-exist.json', dest);
  assert.equal(r.ok, false);
  assert.equal(existsSync(dest), false);
});
