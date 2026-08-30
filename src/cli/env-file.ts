/**
 * Minimal `.env` reader/writer for `./brainstem setup`. Preserves comments, blank
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
    // Single quotes are literal: what's between them is the value, verbatim.
    if (first === "'" && last === "'") return value.slice(1, -1);
    // Double quotes carry escapes (this is the fallback `formatValue` uses for
    // values containing an apostrophe): undo the three it emits, `\\`, `\"` and `\$`.
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\([\\"$])/g, '$1');
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

/**
 * Values containing a space, `#`, `$` or `'` need quoting so they round-trip
 * through `parseEnv` — and through Compose, which reads this same file (`$`
 * would otherwise be interpolated by compose-go). Quote with SINGLE quotes:
 * compose-go (and Node's `--env-file`) expand `\a \b \f \n \r \t \v \\ \" \$`
 * inside double quotes, which would mangle a Windows vault path such as
 * `C:\Users\ana\Obsidian Vault`; inside single quotes every character is
 * literal. A value that contains an apostrophe can't be single-quoted:
 * neither parser supports an escape there, and neither splices adjacent
 * quoted segments (`'\''`) the way a shell does — so it falls back to double
 * quotes with `\`, `"` and `$` escaped. Residual, accepted and verified against
 * both parsers: compose-go undoes `\$` (and `\\`, `\"`) inside double quotes,
 * while Node's `--env-file` strips the quotes and keeps everything between them
 * literal — including the backslashes. So a value carrying an apostrophe
 * TOGETHER WITH a `$` or a `\` reads as `it's $5` under Docker but as
 * `it's \$5` under `npm run dev`. Only the apostrophe path is affected; every
 * other value takes the single-quote branch, which both parsers read the same.
 */
function formatValue(value: string): string {
  if (!/[ #$']/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
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
