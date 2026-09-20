import type { CallToolResult } from '@modelcontextprotocol/server';
import { ZodError } from 'zod';
import { MAX_RESULT_CHARS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';

/** Travels with every truncated read, so the model knows the text is partial and how to get the rest. */
export const TRUNCATED_HINT =
  'Truncated: the text is incomplete. Use vault_outline to list the headings, then vault_read with "section" or "sections" — and never write truncated text back.';

/**
 * Appended to the description of the tools a conversation usually starts with. Not every client
 * shows the model the connection `instructions`; a tool description always arrives.
 */
export const GUIDE_POINTER = 'New here? Call brainstem_guide first.';

export function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function okJson<T extends Record<string, unknown>>(
  structured: T,
  text?: string,
): CallToolResult {
  const body = text ?? JSON.stringify(structured);
  return {
    content: [{ type: 'text', text: clampText(body).text }],
    structuredContent: structured,
  };
}

/**
 * A document read. Some clients show the model only `structuredContent`, others only the content
 * blocks — so a note's text is in both, and what the second kind would otherwise never see (the
 * `hash` for `expectedHash`, that the text was cut and how to read the rest) goes in a second
 * content block. The first block stays the note's text and nothing else, so it can be quoted into
 * an edit as it is. `text` is already clamped by the caller; it is not clamped again here (a second
 * clamp used to append a second marker with the wrong total).
 */
export function okDocument<T extends Record<string, unknown>>(
  structured: T,
  text: string,
  meta: { path: string; hash: string; sections?: string[]; truncated: boolean },
): CallToolResult {
  // Clients join content blocks without a separator: the block brings its own line break.
  const parts = [`\n[brainstem] path: ${meta.path}`, `hash: ${meta.hash}`];
  if (meta.sections?.length) parts.push(`sections: ${meta.sections.join(' | ')}`);
  if (meta.truncated) parts.push(TRUNCATED_HINT);
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: parts.join(' · ') },
    ],
    structuredContent: structured,
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function clampText(
  text: string,
  max = MAX_RESULT_CHARS,
): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= max) return { text, truncated: false, totalChars: text.length };
  const head = text.slice(0, max);
  return {
    text: `${head}\n\n[truncated: showing ${max} of ${text.length} characters]`,
    truncated: true,
    totalChars: text.length,
  };
}

export function errorToResult(error: unknown, log: (e: unknown) => void): CallToolResult {
  if (error instanceof VaultError) {
    // Every VaultError carries its code (and any details — a CONFLICT's currentHash, a NOT_FOUND's
    // path, ...) as structuredContent, so a client can branch on the code instead of parsing the
    // human-readable text, which stays exactly as it was.
    return {
      isError: true,
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      structuredContent: { code: error.code, ...error.details },
    };
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return fail(
      `INVALID_INPUT: ${first ? `${first.path.join('.') || 'input'} — ${first.message}` : 'invalid arguments'}`,
    );
  }
  log(error);
  return fail('INTERNAL: unexpected error; try again or report it.');
}

export async function guarded(
  log: (e: unknown) => void,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return errorToResult(error, log);
  }
}
