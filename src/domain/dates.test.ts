import { describe, expect, it } from 'vitest';
import { addDays, isIsoTimestamp, isLocalDate, isTimeZone, localDateOf } from './dates';

describe('dates', () => {
  it('isLocalDate accepts only real YYYY-MM-DD dates', () => {
    for (const ok of ['2026-12-15', '2028-02-29', '2000-01-01']) expect(isLocalDate(ok)).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-1-01',
      '2026-12-15T00:00',
      20261215,
      null,
      '',
    ])
      expect(isLocalDate(bad)).toBe(false);
  });

  it('addDays crosses months, years and DST without drifting', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 21)).toBe('2026-03-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('isTimeZone', () => {
    expect(isTimeZone('America/Los_Angeles')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    for (const bad of ['Mars/Olympus', '', 'x'.repeat(65), 5, null])
      expect(isTimeZone(bad)).toBe(false);
  });

  it('localDateOf uses the time zone, including around DST changes', () => {
    expect(localDateOf('2026-10-14T06:30:00Z', 'America/Los_Angeles')).toBe('2026-10-13');
    expect(localDateOf('2026-10-14T07:30:00Z', 'America/Los_Angeles')).toBe('2026-10-14');
    expect(localDateOf('2026-10-14T06:30:00Z', 'UTC')).toBe('2026-10-14');
    expect(localDateOf('2026-03-08T07:59:00Z', 'America/Los_Angeles')).toBe('2026-03-07');
    expect(localDateOf('2026-11-01T08:30:00Z', 'America/Los_Angeles')).toBe('2026-11-01');
    expect(localDateOf('2026-10-13T23:30:00+14:00', 'Pacific/Kiritimati')).toBe('2026-10-13');
  });

  it('isIsoTimestamp', () => {
    for (const ok of [
      '2026-10-13T12:00:00Z',
      '2026-10-13T12:00:00.123Z',
      '2026-10-13T12:00:00-07:00',
    ])
      expect(isIsoTimestamp(ok)).toBe(true);
    for (const bad of [
      '2026-10-13',
      '2026-10-13T12:00:00',
      '2026-02-30T12:00:00Z',
      '2026-10-13T25:00:00Z',
      5,
    ])
      expect(isIsoTimestamp(bad)).toBe(false);
  });
});
