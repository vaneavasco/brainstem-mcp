import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_RESULT_CHARS } from '../../src/storage/limits.ts';
import { VaultError } from '../../src/storage/types.ts';
import {
  clampText,
  errorToResult,
  fail,
  guarded,
  okJson,
  okText,
} from '../../src/tools/results.ts';

describe('results helpers', () => {
  it('builds text, json and error results', () => {
    expect(okText('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    const r = okJson({ a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(r.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(okJson({ a: 1 }, 'custom').content[0]).toEqual({ type: 'text', text: 'custom' });
    expect(fail('nope')).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] });
  });

  it('clamps an oversized text block but leaves structuredContent intact', () => {
    const big = 'x'.repeat(MAX_RESULT_CHARS + 500);
    const r = okJson({ a: big });
    expect(r.structuredContent).toEqual({ a: big });
    const clamped = (r.content[0] as { text: string }).text;
    expect(clamped.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(clamped).toContain('[truncated');
    const customBig = okJson({ a: 1 }, 'y'.repeat(MAX_RESULT_CHARS + 500));
    const clampedCustom = (customBig.content[0] as { text: string }).text;
    expect(clampedCustom.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(clampedCustom).toContain('[truncated');
  });

  it('clamps long text and reports truncation', () => {
    const short = clampText('abc');
    expect(short).toEqual({ text: 'abc', truncated: false, totalChars: 3 });
    const long = clampText('x'.repeat(MAX_RESULT_CHARS + 10));
    expect(long.truncated).toBe(true);
    expect(long.totalChars).toBe(MAX_RESULT_CHARS + 10);
    expect(long.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(long.text).toContain('[truncated');
    expect(clampText('abcdef', 3).text.startsWith('abc')).toBe(true);
  });

  it('maps errors to actionable tool errors without leaking internals', () => {
    const logged: unknown[] = [];
    const log = (e: unknown) => logged.push(e);
    expect(errorToResult(new VaultError('NOT_FOUND', 'a.md does not exist.'), log)).toEqual(
      fail('NOT_FOUND: a.md does not exist.'),
    );
    const zodErr = z.object({ n: z.number() }).safeParse({ n: 'x' });
    const zr = errorToResult(zodErr.success ? null : zodErr.error, log);
    expect(zr.isError).toBe(true);
    expect((zr.content[0] as { text: string }).text).toMatch(/^INVALID_INPUT: /);
    const internal = errorToResult(new Error('db password is hunter2'), log);
    expect((internal.content[0] as { text: string }).text).toBe(
      'INTERNAL: unexpected error; try again or report it.',
    );
    expect((internal.content[0] as { text: string }).text).not.toContain('hunter2');
    expect(logged).toHaveLength(1);
  });

  it('guarded() converts thrown errors and passes results through', async () => {
    const log = () => {};
    expect(await guarded(log, async () => okText('ok'))).toEqual(okText('ok'));
    const r = await guarded(log, async () => {
      throw new VaultError('TOO_LARGE', 'big');
    });
    expect(r).toEqual(fail('TOO_LARGE: big'));
  });
});
