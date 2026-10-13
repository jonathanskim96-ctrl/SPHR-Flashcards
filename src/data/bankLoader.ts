// Choosing which copy of the question bank to use (BUILD_PLAN Phase 4). There are up to
// three copies: the server's (Supabase), the one saved on this phone (IndexedDB), and the
// one built into the app (`bank.json`, precached by the service worker). The newest one
// that reads cleanly wins; on a tie the server's copy is preferred, then the saved one.
// So a deploy with new questions reaches the phone even before the import is run, and the
// server's copy is used whenever it is current.
import { compareBankVersion, normalizeBank } from '../domain/bank';
import type { Bank } from '../domain/types';

export type BankSource = 'server' | 'cache' | 'bundled';

export interface Candidate {
  source: BankSource;
  raw: unknown;
}

export interface Picked {
  bank: Bank;
  source: BankSource;
  /** The copy as read (in the file's shape); this is what gets saved on the phone. */
  raw: unknown;
}

export type PickResult =
  { ok: true; picked: Picked; problems: string[] } | { ok: false; problems: string[] };

const LABEL: Record<BankSource, string> = {
  server: 'The questions on the server',
  cache: 'The copy of the questions saved on this phone',
  bundled: 'The copy of the questions built into the app',
};
const WHERE: Record<BankSource, string> = {
  server: 'on the server',
  cache: 'saved on this phone',
  bundled: 'built into the app',
};
const RANK: Record<BankSource, number> = { server: 0, cache: 1, bundled: 2 };
const MAX_LISTED = 5;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (q: unknown) => (isObj(q) && typeof q.id === 'string' ? q.id : '');

/**
 * The server has no order column, so its questions and scenarios come back sorted by id.
 * The lesson builder takes new cards in bank order, so put them in the order of a reference
 * copy (the app's built-in file, then the saved copy); entries the reference doesn't know go
 * last, by id. Anything that isn't a bank is returned unchanged for the normalizer to reject.
 */
export function orderLike(raw: unknown, ...references: unknown[]): unknown {
  if (!isObj(raw)) return raw;
  const out: Obj = { ...raw };
  for (const field of ['questions', 'scenarios'] as const) {
    const list = raw[field];
    if (!Array.isArray(list)) continue;
    const position = new Map<string, number>();
    for (const ref of references)
      if (isObj(ref) && Array.isArray(ref[field]))
        for (const x of ref[field] as unknown[]) {
          const id = idOf(x);
          if (id && !position.has(id)) position.set(id, position.size);
        }
    const key = (x: unknown) => position.get(idOf(x)) ?? Number.POSITIVE_INFINITY;
    out[field] = [...list].sort((a, b) => {
      const d = key(a) - key(b);
      if (d) return d;
      const [x, y] = [idOf(a), idOf(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return out;
}

function list(items: readonly { id: string; reason: string }[]): string {
  const shown = items.slice(0, MAX_LISTED).map((d) => `${d.id} (${d.reason})`);
  if (items.length > MAX_LISTED) shown.push(`and ${items.length - MAX_LISTED} more`);
  return shown.join(', ');
}

/**
 * Picks the copy with the highest bankVersion that reads cleanly (no question dropped).
 * If none reads cleanly, the newest one that reads at all is used and the dropped questions
 * are reported. Every copy that could not be read, or was passed over, is reported too.
 */
export function pickBank(candidates: readonly Candidate[]): PickResult {
  const problems: string[] = [];
  const readable: (Picked & { dropped: { id: string; reason: string }[] })[] = [];
  for (const c of candidates) {
    const r = normalizeBank(c.raw);
    if (r.ok) readable.push({ bank: r.bank, source: c.source, raw: c.raw, dropped: r.dropped });
    else problems.push(`${LABEL[c.source]} could not be read (${r.error}).`);
  }
  const order = (a: (typeof readable)[number], b: (typeof readable)[number]) =>
    compareBankVersion(b.bank.bankVersion, a.bank.bankVersion) || RANK[a.source] - RANK[b.source];
  const clean = readable.filter((r) => r.dropped.length === 0).sort(order);
  const best = clean[0] ?? readable.sort(order)[0];
  if (!best) return { ok: false, problems };

  for (const r of readable)
    if (
      r !== best &&
      r.dropped.length &&
      compareBankVersion(r.bank.bankVersion, best.bank.bankVersion) > 0
    )
      problems.push(
        `Version ${r.bank.bankVersion} of the questions (${WHERE[r.source]}) was not used ` +
          `because ${r.dropped.length} of its questions could not be read: ${list(r.dropped)}.`,
      );
  const n = best.dropped.length;
  if (n)
    problems.push(
      `${n === 1 ? '1 question was skipped because it' : `${n} questions were skipped because they`}` +
        ` could not be read: ${list(best.dropped)}.`,
    );
  return { ok: true, picked: { bank: best.bank, source: best.source, raw: best.raw }, problems };
}
