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

interface ParsedKeyLine {
  key: string;
  /** Whether the key was written as `export KEY=...` (a common convention that also lets the
   *  file be `source`d by a shell) — carried through so a rewritten line keeps the prefix. */
  exported: boolean;
  /** Index of the `=` in the ORIGINAL (untrimmed) line — value slicing uses this, unaffected by
   *  stripping a leading `export `, since that only touches the part before `=`. */
  eq: number;
}

/** A line's `KEY` (and whether it's `export`-prefixed), or null when the line is blank, a
 *  comment, has no `=`, or its key doesn't look like an env var name. Shared by `parseEnv` and
 *  `upsertEnv` so both agree on what counts as "the same key" — including `export KEY=...`. */
function parseKeyLine(line: string): ParsedKeyLine | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  let keyPart = line.slice(0, eq).trim();
  let exported = false;
  const exportMatch = /^export\s+(\S.*)$/.exec(keyPart);
  if (exportMatch) {
    keyPart = exportMatch[1] as string;
    exported = true;
  }
  if (!KEY_RE.test(keyPart)) return null;
  return { key: keyPart, exported, eq };
}

/** Parses `KEY=VALUE` lines into a map; comments (`#...`) and blank lines are ignored. An
 *  `export KEY=VALUE` line is read the same as `KEY=VALUE`. A key repeated on more than one line
 *  reads as its LAST occurrence — the same line `upsertEnv` treats as authoritative and keeps
 *  (see below), so the two agree on what a duplicated key currently means. */
export function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of splitLines(text)) {
    const parsed = parseKeyLine(line);
    if (!parsed) continue;
    const rawValue = line.slice(parsed.eq + 1).trim();
    map.set(parsed.key, stripQuotes(rawValue));
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
 *
 * F2: when a key being set (only those — a key not in `values` is left exactly as it is, dupes
 * included) appears on more than one line, the new value is written at the LAST occurrence's
 * line (matching `parseEnv`'s own "last one wins" reading) and every EARLIER line defining that
 * key is dropped outright, not just left stale — so the file and `parseEnv` can never again
 * disagree about what a re-read gets. `removedDuplicates` names the key once per line removed
 * this way (never a value), so a caller can print e.g. `removed a duplicate OWNER_SECRET line`
 * without ever risking a secret in its own output. An `export KEY=...` line counts as defining
 * `KEY` for all of this, and the prefix is kept on whichever line survives.
 */
export function upsertEnv(
  text: string,
  values: Record<string, string>,
  opts?: { onlyIfEmpty?: boolean },
): { text: string; changed: string[]; kept: string[]; removedDuplicates: string[] } {
  const onlyIfEmpty = opts?.onlyIfEmpty ?? false;
  const remaining = new Map(Object.entries(values));
  const changed: string[] = [];
  const kept: string[] = [];
  const removedDuplicates: string[] = [];

  const lines = splitLines(text);

  // The LAST line index for each key we're about to touch — everything else defining that same
  // key is a duplicate to drop, whichever position it's in.
  const lastIndexForKey = new Map<string, number>();
  lines.forEach((line, i) => {
    const parsed = parseKeyLine(line);
    if (parsed && remaining.has(parsed.key)) lastIndexForKey.set(parsed.key, i);
  });

  const outLines: string[] = [];
  lines.forEach((line, i) => {
    const parsed = parseKeyLine(line);
    if (!parsed || !remaining.has(parsed.key)) {
      outLines.push(line);
      return;
    }
    if (lastIndexForKey.get(parsed.key) !== i) {
      removedDuplicates.push(parsed.key); // an earlier duplicate — dropped, not kept stale
      return;
    }

    const newValue = remaining.get(parsed.key) as string;
    remaining.delete(parsed.key);
    const current = stripQuotes(line.slice(parsed.eq + 1).trim());
    if (onlyIfEmpty && current !== '') {
      kept.push(parsed.key);
      outLines.push(line);
      return;
    }
    changed.push(parsed.key);
    const prefix = parsed.exported ? 'export ' : '';
    outLines.push(`${prefix}${parsed.key}=${formatValue(newValue)}`);
  });

  if (remaining.size > 0) {
    outLines.push('# added by setup');
    for (const [key, value] of remaining) {
      outLines.push(`${key}=${formatValue(value)}`);
      changed.push(key);
    }
  }

  return { text: `${outLines.join('\n')}\n`, changed, kept, removedDuplicates };
}
