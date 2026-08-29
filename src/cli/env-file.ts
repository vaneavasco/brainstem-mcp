/**
 * Minimal `.env` reader/writer for `npm run setup`. Preserves comments, blank
 * lines and key order so re-running setup on a hand-edited `.env` doesn't
 * clobber it; only touches the keys it's told to.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Parses `KEY=VALUE` lines into a map; comments (`#...`) and blank lines are ignored. */
export function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    const rawValue = line.slice(eq + 1).trim();
    map.set(key, stripQuotes(rawValue));
  }
  return map;
}

/** Values containing a space or `#` need quoting so they round-trip through `parseEnv`. */
function formatValue(value: string): string {
  return /[ #]/.test(value) ? `"${value}"` : value;
}

/**
 * Sets `values` into `text`, keeping comments/blank lines/order intact.
 * Existing keys are replaced (or, with `onlyIfEmpty`, only replaced when
 * their current value is empty); keys absent from `text` are appended at
 * the end, after a single `# added by setup` marker line (only emitted when
 * at least one key is actually appended). Line endings are always
 * normalized to `\n`.
 */
export function upsertEnv(
  text: string,
  values: Record<string, string>,
  opts?: { onlyIfEmpty?: boolean },
): { text: string; changed: string[]; kept: string[] } {
  const onlyIfEmpty = opts?.onlyIfEmpty ?? false;
  const remaining = new Map(Object.entries(values));
  const changed: string[] = [];
  const kept: string[] = [];

  const outLines = splitLines(text).map((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (!remaining.has(key)) return line;

    const newValue = remaining.get(key) as string;
    remaining.delete(key);
    const current = stripQuotes(line.slice(eq + 1).trim());
    if (onlyIfEmpty && current !== '') {
      kept.push(key);
      return line;
    }
    changed.push(key);
    return `${key}=${formatValue(newValue)}`;
  });

  if (remaining.size > 0) {
    outLines.push('# added by setup');
    for (const [key, value] of remaining) {
      outLines.push(`${key}=${formatValue(value)}`);
      changed.push(key);
    }
  }

  return { text: `${outLines.join('\n')}\n`, changed, kept };
}
