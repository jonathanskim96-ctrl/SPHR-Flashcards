// The app's text normalizer must be byte-for-byte the same function as the validator's
// `norm` (BUILD_PLAN 1b), and behave identically on 10,000 random strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { norm as appNorm } from '../src/domain/textNorm.ts';

const body = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `norm definition not found by ${re}`);
  return m[1];
};
const validatorSrc = readFileSync('scripts/validate-bank.mjs', 'utf8');
const appSrc = readFileSync('src/domain/textNorm.ts', 'utf8');
const validatorBody = body(validatorSrc, /^const norm = \(s\) => (.+);$/m);
const appBody = body(appSrc, /^export const norm = \(s: string\): string => (.+);$/m);

test('the normalizer expression is byte-for-byte identical', () => {
  assert.equal(appBody, validatorBody);
});

test('both normalizers agree on 10,000 random strings', async () => {
  // Load the validator's own expression as a module (the validator script itself exits).
  const dir = mkdtempSync(join(tmpdir(), 'norm-'));
  const file = join(dir, 'validator-norm.mjs');
  writeFileSync(file, `export const norm = (s) => ${validatorBody};\n`);
  const { norm: validatorNorm } = await import(pathToFileURL(file).href);
  const chars = fc.constantFrom(..."aAzZ .-/\t\n  –’'İ1é.".split(''));
  fc.assert(
    fc.property(
      fc.oneof(fc.string({ unit: chars, maxLength: 30 }), fc.string({ unit: 'binary' })),
      (s) => {
        assert.equal(appNorm(s), validatorNorm(s));
      },
    ),
    { numRuns: 10_000, seed: 20261013 },
  );
});
