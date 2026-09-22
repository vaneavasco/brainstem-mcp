import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';

// Windows can report EPERM/EBUSY/EACCES for a rename into (or over) a folder another process —
// the file watcher, most often — still holds a handle inside, even though the rename is otherwise
// perfectly valid: docs/plans/2026-09-21-claude-desktop-integration.md phase 6 triage, item B
// (`vault_delete` of a folder failing on Windows). `renameWithRetry` and the folder-only
// copy+remove fallback in `softDelete` are exercised here by making `fs.rename` fail exactly like
// that — deterministically, and without a Windows machine.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, promises: { ...actual.promises, rename: vi.fn(actual.promises.rename) } };
});
const renameMock = vi.mocked(fs.rename);

function retryableError(code: 'EPERM' | 'EBUSY' | 'EACCES'): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  // Realpath'd up front so `root` (used below to build the mocked rename's expected `from`
  // argument) matches `LocalFSAdapter`'s own internal `this.root` (which is `await
  // fs.realpath(rootDir)`, not `rootDir` itself) exactly — on Windows CI, `os.tmpdir()` can hand
  // back a short (8.3) name that realpath resolves to a differently-spelled long form.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-retry-')));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
});

afterEach(async () => {
  renameMock.mockClear();
  await fs.rm(root, { recursive: true, force: true });
});

describe('softDelete: a rename into .trash/ retries past a transient EPERM/EBUSY/EACCES', () => {
  it('a file delete succeeds once the held handle lets go within the retry window', async () => {
    await vault.write('a.md', 'content\n');
    renameMock.mockImplementationOnce(async () => {
      throw retryableError('EBUSY');
    });
    renameMock.mockImplementationOnce(async () => {
      throw retryableError('EPERM');
    });
    // Every call after the two above falls through to the real rename (vi.fn(actual.rename)'s
    // own default implementation, set once in the vi.mock factory above).
    await vault.softDelete('a.md', true);
    expect(await fs.readFile(path.join(root, '.trash/a.md'), 'utf8')).toBe('content\n');
    expect(await vault.exists('a.md')).toBe(false);
  });

  it('a folder delete falls back to copy+remove when the rename keeps failing', async () => {
    await vault.write('more/deep/a.md', 'alpha\n');
    await vault.write('more/deep/b.md', 'beta\n');
    await vault.write('more/top.md', 'top\n');
    const target = path.join(root, 'more');
    renameMock.mockImplementation(async (from, to, ...rest) => {
      if (String(from) === target) throw retryableError('EBUSY');
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      // biome-ignore lint/suspicious/noExplicitAny: forwarding whatever fs.rename's own overload wants
      return (actual.promises.rename as any)(from, to, ...rest);
    });

    await vault.softDelete('more', true);

    expect(renameMock).toHaveBeenCalled(); // the retries did happen, not skipped straight to copy
    expect(await vault.exists('more/deep/a.md')).toBe(false); // the original is gone
    expect(await fs.readFile(path.join(root, '.trash/more/deep/a.md'), 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(path.join(root, '.trash/more/deep/b.md'), 'utf8')).toBe('beta\n');
    expect(await fs.readFile(path.join(root, '.trash/more/top.md'), 'utf8')).toBe('top\n');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a file delete still fails cleanly (no fallback) when the rename never recovers', async () => {
    await vault.write('a.md', 'content\n');
    renameMock.mockImplementation(async () => {
      throw retryableError('EBUSY');
    });
    await expect(vault.softDelete('a.md', true)).rejects.toMatchObject({ code: 'IO' });
    // Nothing was moved or lost: the file is exactly where it was.
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('content\n');
  });
});
