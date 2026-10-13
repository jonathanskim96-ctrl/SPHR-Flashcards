// The question bank on the phone (BUILD_PLAN Phase 4). On start it uses the newest copy it
// has locally (the saved copy or the one built into the app), then asks the server whether
// it has a newer one. It asks again when the app returns to the foreground or comes back
// online, at most every 10 minutes. The winner is saved on the phone for next time.
//
// When a newer bank arrives while a card is on screen, the card is finished first:
// `beginCard()` / `endCard()` hold the switch until the card is done. Retired questions
// then drop out of lessons and progress (the domain does that); their answers remain.
import { compareBankVersion } from '../domain/bank';
import type { Bank } from '../domain/types';
import type { Backend } from './backend';
import { orderLike, pickBank, type BankSource, type Candidate, type Picked } from './bankLoader';
import { errorText, type LocalStore } from './store';
import type { SyncEnv } from './sync';

export const RECHECK_MS = 10 * 60_000;
const CACHE_KEY = 'current';

export interface BankStatus {
  bank: Bank | null;
  source: BankSource | null;
  /** A newer bank is waiting for the current card to be finished. */
  waiting: boolean;
  checking: boolean;
  /** The last problem reaching the server or saving on the phone (cleared on success). */
  lastError: string | null;
}

export type BankServer = Pick<Backend, 'getBankVersion' | 'getBank'>;

/** The copy built into the app (`public/bank.json`, precached by the service worker). */
export async function fetchBundledBank(
  fetchFn: typeof fetch = fetch,
  url = `${import.meta.env.BASE_URL}bank.json`,
): Promise<unknown> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class BankManager {
  private current: Picked | null = null;
  private next: Picked | null = null;
  private cardOpen = false;
  private cacheRaw: unknown = undefined;
  private bundledRaw: unknown = undefined;
  private lastCheckAt: number | null = null;
  private checking: Promise<void> | null = null;
  private lastError: string | null = null;
  private reported = new Set<string>();
  private listeners = new Set<() => void>();
  private unwake: (() => void) | null = null;

  constructor(
    private readonly store: LocalStore,
    private readonly server: BankServer,
    private readonly loadBundled: () => Promise<unknown>,
    private readonly env: Pick<SyncEnv, 'now' | 'onWake'>,
  ) {}

  /** Loads the local copies, then checks the server (and again on every wake-up). */
  async start(): Promise<void> {
    if (!this.unwake) this.unwake = this.env.onWake(() => void this.check());
    await this.loadLocal();
    await this.check(true);
  }

  stop(): void {
    this.unwake?.();
    this.unwake = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  /** The bank to use now (null until one has been loaded). */
  get bank(): Bank | null {
    return this.current?.bank ?? null;
  }

  status(): BankStatus {
    return {
      bank: this.bank,
      source: this.current?.source ?? null,
      waiting: this.next !== null,
      checking: this.checking !== null,
      lastError: this.lastError,
    };
  }

  /** A card is on screen: a new bank waits until `endCard()`. */
  beginCard(): void {
    this.cardOpen = true;
  }

  /** The card is finished: switch to a waiting bank now, if there is one. */
  endCard(): void {
    this.cardOpen = false;
    if (this.next) {
      this.current = this.next;
      this.next = null;
      this.notify();
    }
  }

  /** The saved copy and the built-in copy; no network. */
  async loadLocal(): Promise<void> {
    const problems: string[] = [];
    try {
      this.cacheRaw = await this.store.db.get('bank', CACHE_KEY);
    } catch (e) {
      this.cacheRaw = undefined;
      problems.push(
        `The copy of the questions saved on this phone could not be read (${errorText(e)}).`,
      );
    }
    try {
      this.bundledRaw = await this.loadBundled();
    } catch (e) {
      this.bundledRaw = undefined;
      problems.push(
        `The copy of the questions built into the app could not be loaded (${errorText(e)}).`,
      );
    }
    await this.choose([], problems);
  }

  /**
   * Asks the server for its bank version, and downloads the bank only when it differs from
   * the saved copy and could win. At most every 10 minutes unless `force`. Never throws.
   */
  check(force = false): Promise<void> {
    if (this.checking) return this.checking;
    if (!force && this.lastCheckAt !== null && this.env.now() - this.lastCheckAt < RECHECK_MS)
      return Promise.resolve();
    this.checking = this.runCheck().finally(() => {
      this.checking = null;
      this.notify();
    });
    this.notify();
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    try {
      const version = await this.server.getBankVersion();
      const candidates: Candidate[] = [];
      if (version !== null && this.worthDownloading(version)) {
        const raw = await this.server.getBank();
        if (raw !== null)
          candidates.push({
            source: 'server',
            raw: orderLike(raw, this.bundledRaw, this.cacheRaw),
          });
      }
      this.lastCheckAt = this.env.now();
      this.lastError = null;
      if (candidates.length) await this.choose(candidates, []);
    } catch (e) {
      this.lastError = `Could not check for new questions: ${errorText(e)}`;
    }
  }

  /** Download only if the server's version isn't the saved one and isn't older than ours. */
  private worthDownloading(version: string): boolean {
    const cached = cleanVersion(this.cacheRaw);
    if (cached !== null && compareBankVersion(version, cached) === 0) return false;
    const have = this.current?.bank.bankVersion;
    return have === undefined || compareBankVersion(version, have) >= 0;
  }

  private async choose(extra: readonly Candidate[], problems: string[]): Promise<void> {
    const candidates: Candidate[] = [...extra];
    // The bank in use stays a candidate, so a reload of the local copies never goes back.
    if (this.current) candidates.push({ source: this.current.source, raw: this.current.raw });
    if (this.cacheRaw !== undefined) candidates.push({ source: 'cache', raw: this.cacheRaw });
    if (this.bundledRaw !== undefined) candidates.push({ source: 'bundled', raw: this.bundledRaw });
    const r = pickBank(candidates);
    problems.push(...r.problems);
    if (!r.ok && !this.current)
      problems.push('No questions could be loaded. Connect to the internet and reopen the app.');
    if (r.ok) {
      if (r.picked.raw !== this.cacheRaw) await this.saveCache(r.picked.raw);
      this.adopt(r.picked);
    }
    await this.report(problems);
  }

  private async saveCache(raw: unknown): Promise<void> {
    try {
      await this.store.db.put('bank', raw, CACHE_KEY);
      this.cacheRaw = raw;
    } catch (e) {
      this.lastError = `Could not save the questions on this phone: ${errorText(e)}`;
    }
  }

  private adopt(picked: Picked): void {
    const shown = this.next ?? this.current;
    if (shown && shown.bank.bankVersion === picked.bank.bankVersion) return;
    if (this.cardOpen && this.current) this.next = picked;
    else {
      this.current = picked;
      this.next = null;
    }
    this.notify();
  }

  /** Problems go to the notices in Settings, each once per session. */
  private async report(problems: readonly string[]): Promise<void> {
    const fresh = problems.filter((p) => !this.reported.has(p));
    if (!fresh.length) return;
    try {
      await this.store.addNotices(fresh);
      for (const p of fresh) this.reported.add(p);
    } catch (e) {
      this.lastError = `${fresh.join(' ')} (Could not save this message: ${errorText(e)})`;
      this.notify();
    }
  }
}

/** The version of a copy that reads cleanly, else null (a damaged copy is never "the same"). */
function cleanVersion(raw: unknown): string | null {
  const r = pickBank([{ source: 'cache', raw }]);
  return r.ok && r.problems.length === 0 ? r.picked.bank.bankVersion : null;
}
