import { describe, expect, it } from 'vitest';
import {
  baseName,
  isMarkdownPath,
  normalizeVaultPath,
  parentDir,
  TRASH_DIR,
} from '../../src/storage/path-policy.ts';
import { VaultError } from '../../src/storage/types.ts';

function rejects(input: unknown): string {
  try {
    normalizeVaultPath(input);
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe('INVALID_PATH');
    return (e as VaultError).message;
  }
  throw new Error(`expected rejection for ${JSON.stringify(input)}`);
}

describe('normalizeVaultPath', () => {
  it('normalizes ordinary relative paths', () => {
    expect(normalizeVaultPath('01-projects/plan.md')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('./01-projects//plan.md')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('01-projects/./plan.md/')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('  notes/a.md  ')).toBe('notes/a.md');
    expect(normalizeVaultPath('notes\\win\\a.md')).toBe('notes/win/a.md');
    expect(normalizeVaultPath('')).toBe('');
    expect(normalizeVaultPath('/')).toBe('');
  });

  it('rejects traversal in every disguise', () => {
    rejects('../secret.md');
    rejects('notes/../../etc/passwd');
    rejects('notes/..');
    rejects('..');
    rejects('notes\\..\\x.md');
  });

  it('rejects absolute paths (POSIX, Windows drive, UNC, scheme)', () => {
    rejects('/etc/passwd');
    rejects('C:\\Users\\x\\note.md');
    rejects('c:/x.md');
    rejects('\\\\server\\share\\a.md');
    rejects('file:///etc/passwd');
  });

  it('rejects NUL bytes, control characters and over-long paths', () => {
    rejects('a\u0000b.md');
    rejects('a\nb.md');
    rejects(`${'a'.repeat(1025)}.md`);
  });

  it('rejects dotfile segments (.obsidian, .git, .trash, hidden files) from tool input', () => {
    rejects('.obsidian/app.json');
    rejects('notes/.git/config');
    rejects('.trash/old.md');
    rejects('notes/.hidden.md');
    expect(rejects('.trash/old.md')).toContain('hidden');
  });

  it('allows internal .trash paths only with allowInternal', () => {
    expect(normalizeVaultPath('.trash/notes/a.md', { allowInternal: true })).toBe(
      '.trash/notes/a.md',
    );
    expect(() => normalizeVaultPath('../x', { allowInternal: true })).toThrow(VaultError);
  });

  it('rejects non-string input', () => {
    rejects(undefined);
    rejects(null);
    rejects(42);
    rejects(['a.md']);
  });

  it('applies Unicode NFC normalization so lookups are stable', () => {
    const decomposed = 'cafe\u0301.md';
    expect(normalizeVaultPath(decomposed)).toBe('café.md');
  });
});

describe('helpers', () => {
  it('detects markdown paths and splits dir/base', () => {
    expect(isMarkdownPath('a/b.md')).toBe(true);
    expect(isMarkdownPath('a/b.MD')).toBe(true);
    expect(isMarkdownPath('a/b.canvas')).toBe(false);
    expect(parentDir('a/b/c.md')).toBe('a/b');
    expect(parentDir('c.md')).toBe('');
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(TRASH_DIR).toBe('.trash');
  });
});
