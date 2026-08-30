import type { CallToolResult } from '@modelcontextprotocol/server';
import { ZodError } from 'zod';
import { MAX_RESULT_CHARS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';

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
    const text = `${error.code}: ${error.message}`;
    if (error.code === 'CONFLICT') {
      return {
        isError: true,
        content: [{ type: 'text', text }],
        structuredContent: { code: error.code, ...error.details },
      };
    }
    return fail(text);
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
