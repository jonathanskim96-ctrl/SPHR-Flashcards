#!/usr/bin/env node
// Question import (BUILD_PLAN Phase 8). Sends content/questions.json to the database
// function import_bank in ONE call (one transaction: all or nothing). Preview by default;
// it writes only when APPLY is exactly "true". Insert/update only: the database function
// refuses a missing question, a lowered revision, or a change without a raised revision.
//
// Settings come from the environment (the workflow passes them through env:):
//   SUPABASE_URL         project URL (https; http only for localhost, used by the tests)
//   SUPABASE_SECRET_KEY  the secret key; never printed
//   APPLY                "true" to write, anything else is a preview
// Usage: node scripts/import-bank.mjs [bank file]   (default content/questions.json)
// Prints a Markdown summary on stdout (the workflow also appends it to the job summary);
// exits 1 on any error.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function importUrl(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error('SUPABASE_URL is not a valid address');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new Error('SUPABASE_URL must start with https://');
  }
  return `${u.origin}/rest/v1/rpc/import_bank`;
}

/** Calls the function and returns { ok, markdown }. Never throws on a server answer. */
export async function importBank({ url, key, apply, bank, fetchImpl = fetch }) {
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set');
  const endpoint = importUrl(url);
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ p_bank: bank, p_apply: apply === true }),
    });
  } catch (e) {
    return { ok: false, markdown: `**FAILED: could not reach the database** (${e.message})\n` };
  }
  const text = await res.text();
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    r = null;
  }
  if (!res.ok || !r || typeof r !== 'object' || !Array.isArray(r.errors)) {
    const detail = r && typeof r.message === 'string' ? r.message : `HTTP ${res.status}`;
    return { ok: false, markdown: `**FAILED: the database refused the import** (${detail})\n` };
  }
  const errors = r.errors;
  const head =
    errors.length > 0
      ? `**FAILED: nothing was written** (${errors.length} error${errors.length === 1 ? '' : 's'})`
      : r.applied
        ? `**APPLIED: ${r.new} new, ${r.changed} changed**`
        : '**PREVIEW ONLY: nothing was written**';
  const lines = [
    head,
    '',
    `Bank version: \`${r.bank_version}\``,
    '',
    '| | Questions | Scenarios |',
    '|---|---|---|',
    `| New | ${r.new} | ${r.scenarios_new} |`,
    `| Changed | ${r.changed} | ${r.scenarios_changed} |`,
    `| Unchanged | ${r.unchanged} | |`,
    `| Newly retired | ${r.newly_retired} | |`,
    `| Errors | ${errors.length} | |`,
  ];
  if (errors.length > 0) lines.push('', 'Errors:', ...errors.map((e) => `- ${String(e)}`));
  return { ok: errors.length === 0, markdown: `${lines.join('\n')}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2] ?? 'content/questions.json';
  try {
    const bank = JSON.parse(readFileSync(file, 'utf8'));
    const { ok, markdown } = await importBank({
      url: process.env.SUPABASE_URL ?? '',
      key: process.env.SUPABASE_SECRET_KEY ?? '',
      apply: process.env.APPLY === 'true',
      bank,
    });
    process.stdout.write(markdown);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    process.stdout.write(`**FAILED: ${e.message}**\n`);
    process.exit(1);
  }
}
