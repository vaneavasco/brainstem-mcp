import { parse, stringify } from 'yaml';
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
    parsed = yamlText.trim() === '' ? {} : parse(yamlText, { schema: 'core' });
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
  return { frontmatter: parsed, body, hasFrontmatter: true };
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
  const out: Record<string, unknown> = { ...existing, ...set };
  for (const key of unset) delete out[key];
  return out;
}
