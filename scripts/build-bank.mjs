#!/usr/bin/env node
// Build step: validates the question bank, then copies it to public/bank.json, the copy
// bundled into the app as the offline fallback. A bank that fails the validator stops the
// build, so a bad bank can never be deployed.
//
// Usage: node scripts/build-bank.mjs [source] [destination]
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VALIDATOR = fileURLToPath(new URL('./validate-bank.mjs', import.meta.url));

export function buildBank(src = 'content/questions.json', dest = 'public/bank.json') {
  const run = spawnSync(process.execPath, [VALIDATOR, src], { encoding: 'utf8' });
  if (run.status !== 0) {
    return { ok: false, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return { ok: true, output: run.stdout };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [src, dest] = process.argv.slice(2);
  const result = buildBank(src, dest);
  if (!result.ok) {
    console.error(result.output);
    console.error('build-bank: the bank failed validation; nothing was copied.');
    process.exit(1);
  }
  console.log(`build-bank: validated and copied to ${dest ?? 'public/bank.json'}`);
}
