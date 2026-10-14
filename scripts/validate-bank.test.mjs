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
  bank.bankVersion = '2026-10-13.2'; // any change needs a higher bankVersion (audit L7)
  const retired = join(dir, 'retired.json');
  writeFileSync(retired, JSON.stringify(bank));
  const r = validate(retired, '--previous', SAMPLE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Audit L7: banks the validator used to pass but the app refuses (or partly drops).
const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));
function check(mutate, ...extra) {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  const bank = sample();
  mutate(bank);
  const path = join(dir, 'bank.json');
  writeFileSync(path, JSON.stringify(bank));
  return validate(path, ...extra);
}
const q = (bank, id) => bank.questions.find((x) => x.id === id);
const firstOfType = (bank, type) => bank.questions.find((x) => x.type === type);

for (const [name, mutate, reason] of [
  [
    'points above 3',
    (b) => (b.levels.K.points = 4),
    /levels\.K\.points must be a whole number from 0 to 3/,
  ],
  [
    'fractional points',
    (b) => (b.levels.A.points = 1.5),
    /levels\.A\.points must be a whole number/,
  ],
  [
    'bankVersion without its number',
    (b) => (b.bankVersion = '2026-10-13'),
    /bankVersion must look like/,
  ],
  ['an area without a name', (b) => delete b.areas[2].name, /area 3 has no name/],
  [
    'empty ordering item',
    (b) => (firstOfType(b, 'ordering').items[0].text = ' '),
    /every one of items needs/,
  ],
  [
    'empty matching prompt',
    (b) => (firstOfType(b, 'matching').prompts[1].text = ''),
    /every one of prompts needs/,
  ],
  [
    'a numeric choice id',
    (b) => (firstOfType(b, 'mc').choices[0].id = 7),
    /every one of choices needs/,
  ],
]) {
  test(`the validator rejects ${name} (audit L7)`, () => {
    const r = check(mutate);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, reason);
  });
}

test('--previous: a change needs a higher bankVersion; a lower one is refused (audit L7)', () => {
  const edit = (b) => (q(b, 'fake1-q01').explanation += ' More.');
  const same = check((b) => (edit(b), q(b, 'fake1-q01').revision++), '--previous', SAMPLE);
  assert.equal(same.status, 1);
  assert.match(same.stderr, /changed, so bankVersion must be raised/);
  const lower = check((b) => (b.bankVersion = '2026-10-12.9'), '--previous', SAMPLE);
  assert.match(lower.stderr, /is lower than the previous/);
  const ok = check(
    (b) => (edit(b), q(b, 'fake1-q01').revision++, (b.bankVersion = '2026-10-14.1')),
    '--previous',
    SAMPLE,
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('--previous: changed content needs a raised revision, which never goes down (audit L7)', () => {
  const bump = (b) => (b.bankVersion = '2026-10-13.2');
  const noRev = check((b) => (bump(b), (q(b, 'fake1-q01').stem += ' Now?')), '--previous', SAMPLE);
  assert.match(noRev.stderr, /fake1-q01: content changed but revision was not raised/);
  const down = check((b) => (bump(b), (q(b, 'fake1-q01').revision = 0)), '--previous', SAMPLE);
  assert.equal(down.status, 1);
  const unchanged = check(() => {}, '--previous', SAMPLE);
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
});
