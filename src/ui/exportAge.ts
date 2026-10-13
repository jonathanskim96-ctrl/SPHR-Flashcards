// "Last export: 3 days ago" for Settings (BUILD_PLAN Phase 8). Counts calendar days in the
// settings time zone, so an export at 11 PM is "yesterday" at 1 AM.
import { localDateOf } from '../domain/dates';

const DAY_MS = 86_400_000;
const dayNumber = (date: string) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS;

export function lastExportText(lastExportAt: string | null, now: number, timeZone: string): string {
  if (!lastExportAt) return 'Never exported';
  const days = Math.max(
    0,
    dayNumber(localDateOf(now, timeZone)) - dayNumber(localDateOf(lastExportAt, timeZone)),
  );
  if (days === 0) return 'Last export: today';
  return days === 1 ? 'Last export: yesterday' : `Last export: ${days} days ago`;
}
