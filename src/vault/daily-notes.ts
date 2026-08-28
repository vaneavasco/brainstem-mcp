import { TZDate } from '@date-fns/tz';
import { format, isValid } from 'date-fns';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';

export interface DailyNoteSettings {
  folder: string;
  format: string;
  template: string | null;
  timezone: string;
}

export const DEFAULT_DAILY_NOTE_SETTINGS: DailyNoteSettings = {
  folder: '',
  format: 'yyyy-MM-dd',
  template: null,
  timezone: 'UTC',
};

const STRFTIME: Record<string, string> = {
  Y: 'yyyy',
  y: 'yy',
  m: 'MM',
  d: 'dd',
  H: 'HH',
  M: 'mm',
  S: 'ss',
  B: 'MMMM',
  b: 'MMM',
  A: 'EEEE',
  a: 'EEE',
  j: 'DDD',
  e: 'd',
  U: 'ww',
  V: 'II',
  u: 'i',
  w: 'e',
  '%': '%',
};

export function toDateFnsFormat(fmt: string): string {
  if (!fmt.includes('%')) return fmt;
  return fmt.replace(/%([A-Za-z%])/g, (whole, token: string) => STRFTIME[token] ?? whole);
}

function inZone(date: Date, timezone: string): TZDate {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new VaultError('INVALID_INPUT', `Unknown timezone ${JSON.stringify(timezone)}.`);
  }
  try {
    return new TZDate(date, timezone);
  } catch {
    throw new VaultError('INVALID_INPUT', `Unknown timezone ${JSON.stringify(timezone)}.`);
  }
}

export function formatInVaultZone(date: Date, fmt: string, timezone: string): string {
  const zoned = inZone(date, timezone);
  try {
    return format(zoned, toDateFnsFormat(fmt));
  } catch (error) {
    const message =
      error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    throw new VaultError('INVALID_INPUT', `Invalid date format ${JSON.stringify(fmt)}: ${message}`);
  }
}

export function resolveDailyNotePath(settings: DailyNoteSettings, date: Date): string {
  const name = formatInVaultZone(date, settings.format, settings.timezone);
  const folder = normalizeVaultPath(settings.folder);
  return normalizeVaultPath(folder === '' ? `${name}.md` : `${folder}/${name}.md`);
}

export function renderDailyTemplate(
  template: string,
  date: Date,
  settings: DailyNoteSettings,
): string {
  const title = formatInVaultZone(date, settings.format, settings.timezone);
  return template
    .replace(/\{\{\s*date:([^}]+?)\s*\}\}/g, (_m, fmt: string) =>
      formatInVaultZone(date, fmt, settings.timezone),
    )
    .replace(/\{\{\s*date\s*\}\}/g, title)
    .replace(/\{\{\s*title\s*\}\}/g, title);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateArg(input: string | undefined, now: Date, timezone: string): Date {
  if (input === undefined || input.trim() === '') return now;
  const m = ISO_DAY.exec(input.trim());
  if (!m) throw new VaultError('INVALID_INPUT', 'date must be YYYY-MM-DD.');
  const [, y, mo, d] = m;
  const candidate = new TZDate(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, timezone);
  if (
    !isValid(candidate) ||
    candidate.getMonth() !== Number(mo) - 1 ||
    candidate.getDate() !== Number(d)
  ) {
    throw new VaultError('INVALID_INPUT', `${input} is not a valid calendar date.`);
  }
  return candidate;
}
