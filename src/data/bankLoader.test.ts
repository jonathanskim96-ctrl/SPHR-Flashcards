// Choosing a bank copy (BUILD_PLAN Phase 4). Fake sample bank only.
import { describe, expect, it } from 'vitest';
import { rawSample } from '../../tests/helpers';
import { orderLike, pickBank, type Candidate } from './bankLoader';

const v = (version: string, edit: (b: ReturnType<typeof rawSample>) => void = () => {}) => {
  const b = rawSample();
  b.bankVersion = version;
  edit(b);
  return b;
};
const broken = (b: ReturnType<typeof rawSample>) => {
  b.questions[0]!.type = 'essay';
};
const ids = (raw: unknown) => (raw as { questions: { id: string }[] }).questions.map((q) => q.id);

describe('pickBank', () => {
  it('uses the newest copy', () => {
    const r = pickBank([
      { source: 'server', raw: v('2026-10-13.9') },
      { source: 'cache', raw: v('2026-10-13.10') },
      { source: 'bundled', raw: v('2026-10-12.99') },
    ]);
    expect(r.ok && [r.picked.source, r.picked.bank.bankVersion]).toEqual([
      'cache',
      '2026-10-13.10',
    ]);
    expect(r.problems).toEqual([]);
  });

  it('on a tie prefers the server, then the saved copy', () => {
    const all: Candidate[] = [
      { source: 'bundled', raw: v('2026-10-14.1') },
      { source: 'cache', raw: v('2026-10-14.1') },
      { source: 'server', raw: v('2026-10-14.1') },
    ];
    const r1 = pickBank(all);
    expect(r1.ok && r1.picked.source).toBe('server');
    const r2 = pickBank(all.filter((c) => c.source !== 'server'));
    expect(r2.ok && r2.picked.source).toBe('cache');
  });

  it('reports a copy that cannot be read and uses the next one', () => {
    const r = pickBank([
      { source: 'cache', raw: '{"not json' },
      { source: 'bundled', raw: v('2026-10-13.1') },
    ]);
    expect(r.ok && r.picked.source).toBe('bundled');
    expect(r.problems).toEqual([
      'The copy of the questions saved on this phone could not be read (not a question bank).',
    ]);
  });

  it('passes over a newer copy with unreadable questions for an older clean one, and says so', () => {
    const r = pickBank([
      { source: 'server', raw: v('2026-10-20.1', broken) },
      { source: 'bundled', raw: v('2026-10-13.1') },
    ]);
    expect(r.ok && r.picked.source).toBe('bundled');
    expect(r.problems).toEqual([
      'Version 2026-10-20.1 of the questions (on the server) was not used because 1 of its ' +
        'questions could not be read: fake1-q01 (unknown type essay).',
    ]);
  });

  it('uses the newest readable copy when none is clean, listing what was skipped', () => {
    const many = (b: ReturnType<typeof rawSample>) => {
      for (const q of b.questions.slice(0, 7)) q.type = 'essay';
    };
    const r = pickBank([
      { source: 'cache', raw: v('2026-10-13.2', broken) },
      { source: 'bundled', raw: v('2026-10-13.1', many) },
    ]);
    expect(r.ok && [r.picked.source, r.picked.bank.questions.length]).toEqual(['cache', 18]);
    expect(r.problems).toEqual([
      '1 question was skipped because it could not be read: fake1-q01 (unknown type essay).',
    ]);
    const r2 = pickBank([{ source: 'bundled', raw: v('2026-10-13.1', many) }]);
    expect(r2.problems[0]).toMatch(
      /^7 questions were skipped .*fake1-q05 \(unknown type essay\), and 2 more\.$/,
    );
  });

  it('fails, with every reason, when nothing can be read', () => {
    const r = pickBank([
      { source: 'server', raw: { ...v('2026-10-13.1'), schemaVersion: 2 } },
      { source: 'bundled', raw: null },
    ]);
    expect(r).toEqual({
      ok: false,
      problems: [
        'The questions on the server could not be read (unsupported schemaVersion 2).',
        'The copy of the questions built into the app could not be read (not a question bank).',
      ],
    });
    expect(pickBank([])).toEqual({ ok: false, problems: [] });
  });
});

describe('orderLike', () => {
  it('puts server rows (sorted by id) back in the reference order; unknown ids go last by id', () => {
    const ref = v('2026-10-13.1');
    const server = v('2026-10-14.1', (b) => {
      b.questions.push(
        { ...b.questions[0]!, id: 'fake9-q02' },
        { ...b.questions[1]!, id: 'fake0-q01' },
      );
      b.questions.sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1));
    });
    expect(ids(orderLike(server, ref))).toEqual([...ids(ref), 'fake0-q01', 'fake9-q02']);
    const twice = { questions: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] };
    expect(ids(orderLike(twice))).toEqual(['a', 'b', 'b']);
  });

  it('uses the second reference for ids the first lacks, and ignores junk references', () => {
    const first = v('1', (b) => (b.questions = b.questions.slice(0, 2).reverse()));
    const second = v('1', (b) => (b.questions = [{ id: 7 }, ...b.questions.slice(2, 4).reverse()]));
    const server = v('2', (b) => (b.questions = [...b.questions.slice(0, 4), 'junk' as never]));
    expect(ids(orderLike(server, first, null, { questions: 'x' }, second))).toEqual([
      'fake1-q02',
      'fake1-q01',
      'fake1-q04',
      'fake1-q03',
      undefined,
    ]);
  });

  it('leaves anything that is not a bank unchanged', () => {
    expect(orderLike(null)).toBeNull();
    expect(orderLike({ questions: 3 })).toEqual({ questions: 3 });
  });

  it('puts scenarios back in the reference order too', () => {
    const ref = { scenarios: [{ id: 'z-s' }, { id: 'a-s' }] };
    const server = { scenarios: [{ id: 'a-s' }, { id: 'm-s' }, { id: 'z-s' }] };
    expect(orderLike(server, ref)).toEqual({
      scenarios: [{ id: 'z-s' }, { id: 'a-s' }, { id: 'm-s' }],
    });
  });
});
