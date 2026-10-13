// Calendar-date helpers. Scheduling works on local dates only (no time of day), in the
// user's time zone, using the platform's Intl data.
import type { LocalDate } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isLocalDate(s: unknown): s is LocalDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date of an instant in a time zone. */
export function localDateOf(instant: string | number | Date, timeZone: string): LocalDate {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Strict ISO 8601 timestamp with a zone (`Z` or `±HH:MM`), as produced by toISOString(). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    ISO_RE.test(s) &&
    isLocalDate(s.slice(0, 10)) &&
    !Number.isNaN(Date.parse(s))
  );
}
