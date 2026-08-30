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

/**
 * Used to create a daily note when no DAILY_NOTES_TEMPLATE is configured, so a fresh daily note
 * always has frontmatter (an empty file would otherwise be flagged by vault_analytics_summary as
 * frontmatter_missing).
 */
export const DEFAULT_DAILY_TEMPLATE = '---\ntype: daily\ndate: {{date}}\n---\n\n# {{title}}\n';

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

// Moment-style tokens accepted when the format has no strftime '%' escapes, translated to their
// date-fns equivalents in longest-first order (YYYY before YY) so a four-Y run isn't left with a
// stray "YY". This is a narrow compatibility shim — only these three tokens are recognized — so
// that Obsidian's own Daily Notes default ("YYYY-MM-DD") works untranslated when pasted in.
const MOMENT_TOKENS: readonly [RegExp, string][] = [
  [/YYYY/g, 'yyyy'],
  [/YY/g, 'yy'],
  [/DD/g, 'dd'],
];

export function toDateFnsFormat(fmt: string): string {
  if (fmt.includes('%')) {
    return fmt.replace(/%([A-Za-z%])/g, (whole, token: string) => STRFTIME[token] ?? whole);
  }
  let out = fmt;
  for (const [pattern, replacement] of MOMENT_TOKENS) out = out.replace(pattern, replacement);
  return out;
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
    // useAdditionalDayOfYearTokens lets %j -> DDD (day-of-year) format without a console warning.
    return format(zoned, toDateFnsFormat(fmt), { useAdditionalDayOfYearTokens: true });
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
