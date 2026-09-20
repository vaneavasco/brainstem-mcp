import { parse, stringify } from 'yaml';
import { MAX_FILE_BYTES } from './limits.ts';
import { VaultError } from './types.ts';

export interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(\r?\n|$)/m;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Makes parsed YAML safe to hold, copy and serialize, or says why it cannot be. YAML can express
 * three things JSON, the index and every tool result cannot:
 *  - a value that contains itself (`a: &x {b: *x}`): refused, whatever it runs through (mapping,
 *    list, `!!set`, `!!omap`). One such note once stopped the server from starting.
 *  - one anchor used many times: 1 MB of file that is 96 MB once each alias is written out, which
 *    is what a copy or JSON.stringify does. Refused when the written-out size passes what a file
 *    may hold, so aliases can say nothing a plain file could not.
 *  - sets and ordered maps, which JSON shows as `{}`: read as a list and a mapping.
 * Sizes and copies are memoized per node, so a shared node costs once here however often used.
 */
function admit(root: unknown): unknown {
  const ancestors = new Set<object>();
  const sizes = new Map<object, number>();
  const copies = new Map<object, unknown>();

  const walk = (value: unknown): { size: number; out: unknown } => {
    // A tagged scalar arrives as an object; it is a value, not a mapping. Kept as the text YAML
    // itself would write, so a later update cannot turn `when: 2026-01-01` into `when: {}`.
    if (value instanceof Date) return walk(value.toISOString());
    if (value instanceof Uint8Array) return walk(Buffer.from(value).toString('base64'));
    if (value === null || typeof value !== 'object') {
      // sized as JSON will write it: a control character is six characters there, not one
      return { size: (JSON.stringify(value) ?? 'null').length, out: value };
    }
    if (ancestors.has(value)) {
      throw new VaultError('INVALID_INPUT', 'Frontmatter refers to itself (a YAML alias cycle).');
    }
    const known = sizes.get(value);
    if (known !== undefined) return { size: known, out: copies.get(value) };
    ancestors.add(value);
    let size = 2;
    let out: unknown;
    if (Array.isArray(value) || value instanceof Set) {
      const list: unknown[] = [];
      for (const item of value) {
        const child = walk(item);
        size += child.size + 1;
        list.push(child.out);
      }
      out = list;
    } else {
      const proto = Object.getPrototypeOf(value);
      if (!(value instanceof Map) && proto !== Object.prototype && proto !== null) {
        // nothing the parser is known to produce; refused rather than copied as an empty mapping
        throw new VaultError(
          'INVALID_INPUT',
          'Frontmatter holds a value this server cannot represent.',
        );
      }
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
      const record: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        const name = typeof key === 'string' ? key : JSON.stringify(walk(key).out);
        const child = walk(item);
        size += JSON.stringify(name).length + child.size + 2;
        // defined, not assigned: a `__proto__` key must stay a key
        Object.defineProperty(record, name, {
          value: child.out,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      out = record;
    }
    ancestors.delete(value);
    sizes.set(value, size);
    copies.set(value, out);
    if (size > MAX_FILE_BYTES) {
      throw new VaultError(
        'INVALID_INPUT',
        `Frontmatter is too large once its YAML aliases are written out (over ${MAX_FILE_BYTES} characters).`,
      );
    }
    return { size, out };
  };
  return walk(root).out;
}

export function splitFrontmatter(text: string): SplitResult {
  const open = OPEN.exec(text);
  if (!open) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const afterOpen = text.slice(open[0].length);
  const close = CLOSE.exec(afterOpen);
  if (!close) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const yamlText = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);

  let parsed: unknown;
  try {
    // schema 'core' keeps timestamps as strings; yaml's default 'core' does not coerce dates.
    // logLevel 'error' (not 'silent', which would also swallow parse errors): template notes
    // carry unquoted placeholders such as `created: {{date}}`, which YAML reads as a mapping
    // used as a key and reports through process.emitWarning on every index pass; the value is
    // still a valid mapping, so nothing is lost by not warning.
    parsed = yamlText.trim() === '' ? {} : parse(yamlText, { schema: 'core', logLevel: 'error' });
  } catch (error) {
    throw new VaultError(
      'INVALID_INPUT',
      `Frontmatter is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : 'parse error'}`,
    );
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isPlainObject(parsed)) {
    throw new VaultError('INVALID_INPUT', 'Frontmatter must be a YAML mapping (key: value pairs).');
  }
  return { frontmatter: admit(parsed) as Record<string, unknown>, body, hasFrontmatter: true };
}

export function joinFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  const yamlText = stringify(frontmatter, { lineWidth: 0 });
  return `---\n${yamlText}---\n${body}`;
}

export function mergeFrontmatter(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...incoming };
}

export function applyFrontmatterUpdate(
  existing: Record<string, unknown>,
  set: Record<string, unknown> = {},
  unset: string[] = [],
): Record<string, unknown> {
  if (Object.hasOwn(set, '__proto__')) {
    // `{...set}` would drop it and the write would report success having done nothing
    throw new VaultError('INVALID_INPUT', 'A frontmatter key cannot be named "__proto__".');
  }
  const out: Record<string, unknown> = { ...existing, ...set };
  for (const key of unset) delete out[key];
  return out;
}

/**
 * Why a leading `---` block cannot be used, or `null` when the text has no block or a valid one.
 * `splitFrontmatter` throws for the same cases; this is the non-throwing form for callers that
 * must refuse to build on a broken block (frontmatter updates, merges, template rendering)
 * instead of treating the note as body-only, which would bury the broken block under a new one.
 */
export function frontmatterProblem(text: string): string | null {
  if (!OPEN.test(text)) return null;
  try {
    splitFrontmatter(text);
    return null;
  } catch (error) {
    if (error instanceof VaultError) return error.message;
    throw error;
  }
}
