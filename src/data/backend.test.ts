import { describe, expect, it } from 'vitest';
import { settings0 } from '../../tests/dataHelpers';
import {
  canonicalTimestamp,
  fromServerAttempt,
  fromServerSettingsRow,
  fromSettingsJson,
  parseApplyResult,
} from './backend';

const good = {
  inserted: 2,
  duplicates: 1,
  rejected: [
    { index: 3, id: 'x', reason: 'r' },
    { index: 4, id: null, reason: 's' },
  ],
  settings_version: null,
  settings_conflict: true,
  server_settings: { ...settings0(), version: 5 },
  settings_error: null,
  max_seq: null,
};

describe('server replies', () => {
  it('parses apply_changes', () => {
    expect(parseApplyResult(good)).toEqual({
      inserted: 2,
      duplicates: 1,
      rejected: [
        { index: 3, id: 'x', reason: 'r' },
        { index: 4, id: null, reason: 's' },
      ],
      settingsVersion: null,
      settingsConflict: true,
      serverSettings: { settings: settings0(), version: 5 },
      settingsError: null,
      maxSeq: null,
    });
  });

  it('refuses an unexpected reply instead of guessing', () => {
    for (const bad of [
      null,
      [],
      { ...good, inserted: -1 },
      { ...good, duplicates: 1.5 },
      { ...good, rejected: {} },
      { ...good, rejected: [{ index: 'a', reason: 'r' }] },
      { ...good, rejected: [null] },
      { ...good, settings_conflict: 'no' },
      { ...good, settings_version: 'x' },
      { ...good, max_seq: -2 },
      { ...good, settings_error: 5 },
    ])
      expect(() => parseApplyResult(bad), JSON.stringify(bad)).toThrow('unexpected reply');
    expect(() =>
      parseApplyResult({ ...good, server_settings: { ...settings0(), version: 0 } }),
    ).toThrow('cannot read');
    expect(() => parseApplyResult({ ...good, server_settings: 'x' })).toThrow('unreadable');
  });

  it('reads settings rows and settings_json', () => {
    const row = {
      new_per_day: 15,
      lesson_size: 10,
      daily_xp_goal: 30,
      exam_date: '2026-12-15',
      reminder_enabled: false,
      reminder_time: '15:00:00',
      time_zone: 'America/Los_Angeles',
      version: 1,
    };
    expect(fromServerSettingsRow(row)).toEqual({ settings: settings0(), version: 1 });
    expect(() => fromServerSettingsRow({ ...row, reminder_time: '15:07:00' })).toThrow(
      'reminderTime must be HH:MM in 15-minute steps',
    );
    expect(() => fromServerSettingsRow({ ...row, reminder_time: 900 })).toThrow('reminderTime');
    expect(() => fromServerSettingsRow(null)).toThrow('unreadable');
    expect(fromSettingsJson({ ...settings0(), version: 2 })).toEqual({
      settings: settings0(),
      version: 2,
    });
    expect(() => fromSettingsJson([])).toThrow('unreadable');
  });

  it('reads answer rows defensively', () => {
    expect(fromServerAttempt(null)).toEqual({ ok: false, error: 'malformed answer row' });
    expect(fromServerAttempt({ seq: 1.5, answered_at: 'x' })).toEqual({
      ok: false,
      error: 'malformed answer row',
    });
    expect(fromServerAttempt({ seq: 1, answered_at: 'not a date' })).toEqual({
      ok: false,
      error: 'malformed answer row',
    });
  });

  it('spells every timestamp one way', () => {
    expect(canonicalTimestamp('2026-10-13T20:00:00+00:00')).toBe('2026-10-13T20:00:00.000Z');
    expect(canonicalTimestamp('2026-10-13 13:00:00-07')).toBe('2026-10-13T20:00:00.000Z');
    expect(canonicalTimestamp('2026-10-13T20:00:00.123456Z')).toBe('2026-10-13T20:00:00.123Z');
  });
});
