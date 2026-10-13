import { describe, expect, it } from 'vitest';
import { lastExportText } from './exportAge';

const LA = 'America/Los_Angeles';
const at = (iso: string) => Date.parse(iso);

describe('lastExportText', () => {
  it('says so when there was no export', () => {
    expect(lastExportText(null, at('2026-10-13T20:00:00Z'), LA)).toBe('Never exported');
  });
  it('today, yesterday, N days ago', () => {
    const now = at('2026-10-13T20:00:00Z');
    expect(lastExportText('2026-10-13T15:00:00Z', now, LA)).toBe('Last export: today');
    expect(lastExportText('2026-10-12T20:00:00Z', now, LA)).toBe('Last export: yesterday');
    expect(lastExportText('2026-10-06T20:00:00Z', now, LA)).toBe('Last export: 7 days ago');
  });
  it('counts calendar days in her time zone, not 24-hour blocks', () => {
    // 11 PM Oct 12 in Los Angeles is 06:00 UTC Oct 13; at 1 AM Oct 13 local it is yesterday.
    expect(lastExportText('2026-10-13T06:00:00Z', at('2026-10-13T08:00:00Z'), LA)).toBe(
      'Last export: yesterday',
    );
  });
  it('never goes negative if the phone clock moved back', () => {
    expect(lastExportText('2026-10-14T20:00:00Z', at('2026-10-13T20:00:00Z'), LA)).toBe(
      'Last export: today',
    );
  });
  it('handles a daylight-saving change', () => {
    // Fall back on 2026-11-01 in Los Angeles: three calendar days either way.
    expect(lastExportText('2026-10-30T19:00:00Z', at('2026-11-02T20:00:00Z'), LA)).toBe(
      'Last export: 3 days ago',
    );
  });
});
