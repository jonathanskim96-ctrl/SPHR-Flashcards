import { describe, expect, it } from 'vitest';
import { answerFp } from './bank';
import {
  accountFingerprint,
  buildExport,
  EXPORT_FORMAT,
  MAX_IMPORT_BYTES,
  previewImport,
} from './exportImport';
import { mergeAttempts, replay } from './replay';
import { defaultSettings } from './validate';
import { at, attempt, fakeBank, q, TZ } from '../../tests/helpers';

const NOW = Date.parse('2026-10-13T23:00:00Z');
const bank = fakeBank();
const USER_ID = '00000000-0000-4000-8000-00000000a001';
const CTX = { userId: USER_ID, questionIds: new Set(bank.questions.map((x) => x.id)) };
const settings = { ...defaultSettings(TZ), lessonSize: 12 };
const atts = [
  attempt(q(bank, 'fake1-q01'), true, at('2026-10-11')),
  attempt(q(bank, 'fake1-q01'), false, at('2026-10-12')),
  attempt(q(bank, 'fake2-q10'), true, at('2026-10-13')),
];
const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...buildExport({
      attempts: atts,
      settings,
      bankVersion: bank.bankVersion,
      now: new Date(NOW),
      userId: USER_ID,
    }),
    ...over,
  });

describe('export / import', () => {
  it('builds the documented file shape', () => {
    expect(JSON.parse(file())).toEqual({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: '2026-10-13T23:00:00.000Z',
      bankVersion: '2026-10-13.1',
      account: accountFingerprint(USER_ID),
      attempts: atts,
      settings,
    });
  });

  it('round trip: importing into an empty device restores identical progress', () => {
    const r = previewImport(file(), [], NOW, CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.preview).toMatchObject({
      present: 0,
      rejected: [],
      settings,
      settingsError: null,
      otherAccount: false,
      unknownQuestions: 0,
    });
    expect(r.preview.added).toEqual(atts);
    const s = { examDate: settings.examDate, timeZone: TZ };
    expect(replay(r.preview.added, bank, s)).toEqual(replay(atts, bank, s));
  });

  it('merge is idempotent and never removes anything', () => {
    const local = [atts[0]!, attempt(q(bank, 'fake1-q02'), true, at('2026-10-13'))];
    const r1 = previewImport(file(), local, NOW, CTX);
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.preview.added.map((a) => a.id)).toEqual([atts[1]!.id, atts[2]!.id]);
    expect(r1.preview.present).toBe(1);
    const merged = mergeAttempts(local, r1.preview.added);
    expect(merged).toHaveLength(4);
    const r2 = previewImport(file(), merged, NOW, CTX);
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.preview).toMatchObject({ added: [], present: 3 });
  });

  it('a repeated id inside the file is counted once', () => {
    const r = previewImport(file({ attempts: [atts[0], atts[0]] }), [], NOW, CTX);
    expect(r.ok && [r.preview.added.length, r.preview.present]).toEqual([1, 1]);
  });

  it('rejects bad answers one by one with reasons, keeping the good ones', () => {
    const r = previewImport(
      file({ attempts: [atts[0], { ...atts[1], xp: 3.7 }, 'junk', { id: 7 }] }),
      [],
      NOW,
      CTX,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.preview.added).toEqual([atts[0]]);
    expect(r.preview.rejected).toEqual([
      {
        index: 1,
        id: atts[1]!.id,
        reason: 'xp must be a whole number from 0 to 3; a wrong answer earns 0 xp',
      },
      { index: 2, id: null, reason: 'attempt must be an object' },
      { index: 3, id: null, reason: expect.stringContaining('id must be a lowercase uuid') },
    ]);
  });

  it('reports invalid settings without blocking the answers', () => {
    const r = previewImport(file({ settings: { ...settings, lessonSize: 99 } }), [], NOW, CTX);
    expect(r.ok && [r.preview.settings, r.preview.settingsError]).toEqual([
      null,
      'lessonSize must be a whole number from 5 to 30',
    ]);
  });

  it.each([
    ['not json', 'The file is not a progress export (it is not valid JSON).'],
    ['[]', 'The file is not a progress export.'],
    ['null', 'The file is not a progress export.'],
    ['{"format":"other"}', 'The file is not an SPHR Flashcards progress export.'],
    [
      `{"format":"${EXPORT_FORMAT}","version":2}`,
      'This export is version 2; this app reads version 1.',
    ],
    [`{"format":"${EXPORT_FORMAT}","version":1,"attempts":{}}`, 'The file has no list of answers.'],
  ])('rejects a malformed file with a message: %s', (text, error) => {
    expect(previewImport(text, [], NOW, CTX)).toEqual({ ok: false, error });
  });

  it('flags a file from another account; a file without an account is fine (audit L4)', () => {
    const other = previewImport(file(), [], NOW, {
      ...CTX,
      userId: '00000000-0000-4000-8000-00000000b001',
    });
    expect(other.ok && other.preview.otherAccount).toBe(true);
    const old = previewImport(file({ account: undefined }), [], NOW, {
      ...CTX,
      userId: '00000000-0000-4000-8000-00000000b001',
    });
    expect(old.ok && old.preview.otherAccount).toBe(false);
    // The fingerprint is not the account id, and differs per account.
    expect(accountFingerprint(USER_ID)).toMatch(/^[0-9a-f]{16}$/);
    expect(accountFingerprint(USER_ID)).not.toContain('a001');
    expect(accountFingerprint('x')).not.toBe(accountFingerprint('y'));
  });

  it('counts answers for questions not in the current bank (audit L4)', () => {
    const r = previewImport(file(), [], NOW, { ...CTX, questionIds: new Set(['fake1-q01']) });
    expect(r.ok && [r.preview.added.length, r.preview.unknownQuestions]).toEqual([3, 1]);
    const noBank = previewImport(file(), [], NOW, { ...CTX, questionIds: null });
    expect(noBank.ok && noBank.preview.unknownQuestions).toBe(0);
  });

  it('refuses an oversized file before parsing', () => {
    expect(previewImport(' '.repeat(MAX_IMPORT_BYTES + 1), [], NOW, CTX)).toEqual({
      ok: false,
      error: 'The file is too large to be a progress export.',
    });
  });
});

describe('tests/fixtures/sample-export.json (used by the database recovery test)', () => {
  it('is a valid export whose answers match the fake bank', async () => {
    const text = JSON.stringify((await import('../../tests/fixtures/sample-export.json')).default);
    const r = previewImport(text, [], Date.parse('2026-10-13T00:00:00Z'), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.preview.rejected).toEqual([]);
    expect(r.preview.added).toHaveLength(36);
    for (const a of r.preview.added) expect(a.answerFp).toBe(answerFp(q(bank, a.questionId)));
  });
});
