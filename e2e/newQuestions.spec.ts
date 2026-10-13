// Phase 8: the new-questions flow, end to end on production builds (fake bank only).
//  1. Build A (fake bank v1) is loaded; one card is answered.
//  2. Build B (fake bank v2: 2 new questions, 1 stem edit with a raised revision, 1
//     retirement) is "deployed". After a reload the new cards are there, the edited card
//     keeps its state (it is not offered again today), the retired card is gone.
//  3. The import is simulated: the pretend Supabase now returns v2. Nothing is duplicated
//     and the state is the same.
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { pretendSupabase } from './helpers';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const PREFIX = '/SPHR-Flashcards/';
const FIXTURE = 'tests/fixtures/sample-bank.json';

type Q = {
  id: string;
  revision: number;
  status: string;
  stem: string;
  answer?: string;
  source: { doc: string };
};
type Bank = { bankVersion: string; questions: Q[]; scenarios: { id: string }[] };

function buildWith(bankFile: string, id: string, outDir: string) {
  // public/bank.json is the generated copy bundled into the app; restored in `finally`.
  execFileSync('node', ['scripts/build-bank.mjs', bankFile, 'public/bank.json'], { stdio: 'pipe' });
  execFileSync('npx', ['vite', 'build', '--outDir', outDir], {
    env: {
      ...process.env,
      BUILD_ID: id,
      VITE_SUPABASE_URL: 'http://supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e',
    },
    stdio: 'pipe',
  });
}

const count = (page: Page, area: number, tier: string, active: number) =>
  expect(
    page.getByRole('progressbar', { name: `FAKE Area ${area}, ${tier}: 0 of ${active} mastered` }),
  ).toBeVisible();

test('new questions: deploy v2, state kept, then the import changes nothing', async ({ page }) => {
  test.setTimeout(240_000);
  const tmp = mkdtempSync(join(tmpdir(), 'sphr-newq-'));
  const v1 = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Bank;
  const v2 = structuredClone(v1);
  v2.bankVersion = '2026-10-14.1';
  const byId = (id: string) => v2.questions.find((q) => q.id === id)!;
  const original = byId('fake1-q01');
  v2.questions.push(
    {
      ...original,
      id: 'fake1-q90',
      stem: 'FAKE: A brand new question, number one?',
      answer: 'B',
      source: { ...original.source, doc: 'FAKE Worksheet 9' },
    },
    {
      ...original,
      id: 'fake1-q91',
      stem: 'FAKE: A brand new question, number two?',
      answer: 'C',
      source: { ...original.source, doc: 'FAKE Worksheet 9' },
    },
  );
  original.revision += 1;
  original.stem = 'FAKE: Which colour is the test widget? (reworded)';
  byId('fake2-q05').status = 'retired';
  const v2File = join(tmp, 'v2.json');
  writeFileSync(v2File, JSON.stringify(v2));

  const dirs = { A: join(tmp, 'a'), B: join(tmp, 'b') };
  try {
    buildWith(FIXTURE, 'newq-A', dirs.A);
    buildWith(v2File, 'newq-B', dirs.B);
  } finally {
    execFileSync('node', ['scripts/build-bank.mjs', FIXTURE, 'public/bank.json'], {
      stdio: 'pipe',
    });
  }

  let current = dirs.A;
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (!path.startsWith(PREFIX)) return void res.writeHead(404).end();
    let file = join(current, normalize(path.slice(PREFIX.length)));
    if (!file.startsWith(current)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    await pretendSupabase(page);
    await page.goto(`${origin}${PREFIX}`);
    await page.getByLabel('Email').fill('michelle@example.com');
    await page.getByLabel('Password').fill('correct horse');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // v1: area 1 has one Knowledge card; answer it.
    await count(page, 1, 'Knowledge', 1);
    await count(page, 2, 'Knowledge', 2);
    await page.getByRole('button', { name: '✓ K · Knowledge' }).waitFor();
    for (const t of ['A · Application', 'S · Synthesis'])
      await page.getByRole('button', { name: `✓ ${t}` }).click();
    for (const a of [2, 3, 4, 5])
      await page.getByRole('button', { name: new RegExp(`^✓ ${a}\\. `) }).click();
    await page.getByRole('button', { name: 'Start lesson' }).click();
    await expect(page.getByText('FAKE: Which colour is the test widget?')).toBeVisible();
    await page.getByRole('button', { name: 'Blue' }).click();
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('status', { name: 'Feedback' })).toContainText('Correct! +1 XP');
    await page.getByRole('button', { name: 'Continue' }).click();

    // "Deploy" v2 and reload the app.
    current = dirs.B;
    await page.goto(`${origin}${PREFIX}`);
    await count(page, 1, 'Knowledge', 3); // 1 + 2 new
    await count(page, 2, 'Knowledge', 1); // 2 - 1 retired

    // The lesson offers the two new cards and not the edited one (its state was kept).
    await page.getByRole('button', { name: 'Start lesson' }).click();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const stem = page.getByText(/^FAKE: (A brand new question|Which colour)/);
      if (!(await stem.isVisible({ timeout: 2_000 }).catch(() => false))) break;
      seen.push((await stem.textContent()) ?? '');
      await page.getByRole('button', { name: 'Blue' }).click();
      await page.getByRole('button', { name: 'Check' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    expect(seen.sort()).toEqual([
      'FAKE: A brand new question, number one?',
      'FAKE: A brand new question, number two?',
    ]);
    await expect(page.getByText(/Which colour is the test widget\? \(reworded\)/)).toHaveCount(0);
    await expect(page.getByText('FAKE: The retired name for a broken gizmo')).toHaveCount(0);

    // The import is simulated: Supabase now returns v2 (the rows the import would write).
    // The app downloads it; no card is duplicated and the counts and state are unchanged.
    const reads: string[] = [];
    await page.route('http://supabase.test/rest/v1/**', async (route, request) => {
      const path = new URL(request.url()).pathname;
      const table = path.split('/').pop() ?? '';
      const reply = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (request.method() !== 'GET' || !['bank_meta', 'questions', 'scenarios'].includes(table))
        return route.fallback();
      reads.push(table);
      if (table === 'bank_meta') {
        const full = v2 as unknown as Record<string, unknown>;
        return reply({
          schema_version: 1,
          bank_version: v2.bankVersion,
          areas: full.areas,
          levels: full.levels,
        });
      }
      const rows = table === 'questions' ? v2.questions : v2.scenarios;
      return reply(rows.map((r) => ({ id: r.id, data: r })));
    });
    await page.goto(`${origin}${PREFIX}`);
    await count(page, 1, 'Knowledge', 3);
    await count(page, 2, 'Knowledge', 1);
    expect(reads).toContain('bank_meta');
    // Same bank version as the phone already has: nothing needs downloading.
    expect(reads).not.toContain('questions');
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
