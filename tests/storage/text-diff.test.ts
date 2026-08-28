import { describe, expect, it } from 'vitest';
import { applyTextPatches, unifiedDiff } from '../../src/storage/text-diff.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('applyTextPatches', () => {
  it('applies ordered patches, later patches seeing earlier results', () => {
    const r = applyTextPatches('alpha beta gamma', [
      { find: 'beta', replace: 'BETA' },
      { find: 'alpha BETA', replace: 'x' },
    ]);
    expect(r).toEqual({ content: 'x gamma', applied: 2 });
  });

  it('rejects a patch whose text is missing, naming the index', () => {
    let err: unknown;
    try {
      applyTextPatches('abc', [{ find: 'zzz', replace: '' }]);
    } catch (e) {
      err = e;
    }
    expect((err as VaultError).code).toBe('INVALID_INPUT');
    expect((err as VaultError).message).toMatch(/patch #1/);
    expect((err as VaultError).message).toMatch(/0 times/);
  });

  it('rejects ambiguous patches (text occurs more than once)', () => {
    expect(() => applyTextPatches('a-a', [{ find: 'a', replace: 'b' }])).toThrow(/2 times/);
  });

  it('rejects empty find strings and empty patch lists', () => {
    expect(() => applyTextPatches('abc', [{ find: '', replace: 'x' }])).toThrow(VaultError);
    expect(() => applyTextPatches('abc', [])).toThrow(VaultError);
  });

  it('supports multi-line exact matches and deletion', () => {
    const r = applyTextPatches('l1\nl2\nl3\n', [{ find: 'l2\n', replace: '' }]);
    expect(r.content).toBe('l1\nl3\n');
  });
});

describe('unifiedDiff', () => {
  it('produces a unified diff with the vault path and no diff for identical text', () => {
    const d = unifiedDiff('notes/a.md', 'one\ntwo\n', 'one\n2\n');
    expect(d).toContain('--- a/notes/a.md');
    expect(d).toContain('+++ b/notes/a.md');
    expect(d).toContain('-two');
    expect(d).toContain('+2');
    expect(unifiedDiff('x.md', 'same\n', 'same\n')).toBe('');
  });
});
