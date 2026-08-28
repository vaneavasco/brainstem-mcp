import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  DEFAULT_DAILY_NOTE_SETTINGS,
  parseDateArg,
  renderDailyTemplate,
  resolveDailyNotePath,
  toDateFnsFormat,
} from '../../src/vault/daily-notes.ts';

// 2026-08-28T23:30:00Z is already 2026-08-29 in Europe/Chisinau (UTC+3) and still 2026-08-28 in UTC.
const lateUtc = new Date('2026-08-28T23:30:00Z');

describe('toDateFnsFormat', () => {
  it('translates strftime tokens and passes date-fns formats through', () => {
    expect(toDateFnsFormat('%Y-%m-%d')).toBe('yyyy-MM-dd');
    expect(toDateFnsFormat('%Y/%m/%B %A %H:%M:%S %j %y %b %a')).toBe(
      'yyyy/MM/MMMM EEEE HH:mm:ss DDD yy MMM EEE',
    );
    expect(toDateFnsFormat('yyyy-MM-dd')).toBe('yyyy-MM-dd');
    expect(toDateFnsFormat("yyyy-'W'II")).toBe("yyyy-'W'II");
  });
});

describe('resolveDailyNotePath', () => {
  it('uses the vault timezone, folder and format', () => {
    expect(resolveDailyNotePath(DEFAULT_DAILY_NOTE_SETTINGS, lateUtc)).toBe('2026-08-28.md');
    expect(
      resolveDailyNotePath(
        { ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' },
        lateUtc,
      ),
    ).toBe('2026-08-29.md');
    expect(
      resolveDailyNotePath(
        { folder: 'journal/daily/', format: '%Y/%m/%Y-%m-%d', template: null, timezone: 'UTC' },
        lateUtc,
      ),
    ).toBe('journal/daily/2026/08/2026-08-28.md');
  });

  it('rejects folders or formats that would escape the vault', () => {
    expect(() =>
      resolveDailyNotePath({ ...DEFAULT_DAILY_NOTE_SETTINGS, folder: '../outside' }, lateUtc),
    ).toThrow(VaultError);
  });
});

describe('renderDailyTemplate', () => {
  it('expands {{date}}, {{date:FORMAT}} and {{title}} in the vault timezone', () => {
    const settings = { ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' };
    const out = renderDailyTemplate(
      '# {{title}}\n\nCreated {{date:EEEE, d MMMM yyyy}} ({{date}})\n\n## Log\n',
      lateUtc,
      settings,
    );
    expect(out).toBe('# 2026-08-29\n\nCreated Saturday, 29 August 2026 (2026-08-29)\n\n## Log\n');
  });

  it('maps an invalid date-fns format token to a VaultError instead of a raw exception', () => {
    expect(() =>
      renderDailyTemplate('{{date:???bogus}}', lateUtc, DEFAULT_DAILY_NOTE_SETTINGS),
    ).toThrow(VaultError);
  });
});

describe('parseDateArg', () => {
  it('defaults to now, accepts YYYY-MM-DD as a calendar day in the timezone, rejects garbage', () => {
    expect(parseDateArg(undefined, lateUtc, 'UTC')).toBe(lateUtc);
    const d = parseDateArg('2026-01-05', lateUtc, 'Europe/Chisinau');
    expect(
      resolveDailyNotePath({ ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' }, d),
    ).toBe('2026-01-05.md');
    expect(resolveDailyNotePath(DEFAULT_DAILY_NOTE_SETTINGS, d)).toBe('2026-01-05.md');
    expect(() => parseDateArg('yesterday', lateUtc, 'UTC')).toThrow(VaultError);
    expect(() => parseDateArg('2026-13-40', lateUtc, 'UTC')).toThrow(VaultError);
  });
});
