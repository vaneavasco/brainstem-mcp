import { describe, expect, it } from 'vitest';
import { suggestVaultPaths, validateVaultPath } from '../../src/cli/vault-path.ts';

describe('validateVaultPath', () => {
  it('rejects relative, missing, root, home, repo and read-only paths; warns without .obsidian', async () => {
    const ctx = {
      home: '/home/u',
      repoDir: '/home/u/Code/brainstem-mcp',
      platform: 'linux' as const,
      stat: async (p: string) =>
        ['/home/u/Vault', '/home/u', '/', '/ro'].includes(p) || p === '/home/u/Vault/.obsidian'
          ? { isDirectory: () => true }
          : null,
      probeWrite: async (p: string) => p !== '/ro',
    };
    expect(await validateVaultPath('Vault', ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/absolute/),
    });
    expect(await validateVaultPath('/nope', ctx)).toMatchObject({ ok: false });
    expect(await validateVaultPath('/', ctx)).toMatchObject({ ok: false });
    expect(await validateVaultPath('/home/u', ctx)).toMatchObject({ ok: false });
    expect(await validateVaultPath('/home/u/Code', ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/repository/),
    });
    expect(await validateVaultPath('/ro', ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/writable/),
    });
    expect(await validateVaultPath('/home/u/Vault', ctx)).toEqual({
      ok: true,
      path: '/home/u/Vault',
      warnings: [],
    });
  });

  it('accepts Windows drive paths on win32', async () => {
    const ctx = {
      home: 'C:\\Users\\u',
      repoDir: 'C:\\Users\\u\\Code\\brainstem-mcp',
      platform: 'win32' as const,
      stat: async () => ({ isDirectory: () => true }),
      probeWrite: async () => true,
    };
    expect((await validateVaultPath('C:\\Users\\u\\Obsidian\\Vault', ctx)).ok).toBe(true);
  });

  it('warns when the vault has no .obsidian folder yet', async () => {
    const ctx = {
      home: '/home/u',
      repoDir: '/home/u/Code/brainstem-mcp',
      platform: 'linux' as const,
      stat: async (p: string) => (p === '/home/u/Fresh' ? { isDirectory: () => true } : null),
      probeWrite: async () => true,
    };
    const verdict = await validateVaultPath('/home/u/Fresh', ctx);
    expect(verdict).toMatchObject({ ok: true, path: '/home/u/Fresh' });
    expect(verdict.ok && verdict.warnings.some((w) => /\.obsidian/.test(w))).toBe(true);
  });

  it('allows a vault path nested inside the repository directory (e.g. local dev vault)', async () => {
    // The repo check only guards against picking the repo itself or an ancestor of it
    // (which would make Docker mount the whole repo, or its parent, into the container) —
    // a subfolder of the repo used as a scratch vault for local testing is fine.
    const ctx = {
      home: '/home/u',
      repoDir: '/home/u/Code/brainstem-mcp',
      platform: 'linux' as const,
      stat: async () => ({ isDirectory: () => true }),
      probeWrite: async () => true,
    };
    expect(await validateVaultPath('/home/u/Code/brainstem-mcp/vault-dev', ctx)).toMatchObject({
      ok: true,
      path: '/home/u/Code/brainstem-mcp/vault-dev',
    });
  });

  it('rejects the repository directory itself', async () => {
    const ctx = {
      home: '/home/u',
      repoDir: '/home/u/Code/brainstem-mcp',
      platform: 'linux' as const,
      stat: async () => ({ isDirectory: () => true }),
      probeWrite: async () => true,
    };
    expect(await validateVaultPath('/home/u/Code/brainstem-mcp', ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/repository/),
    });
  });
});

describe('suggestVaultPaths', () => {
  it('suggests ~/Obsidian* and ~/Documents/Obsidian* directories', async () => {
    const readdir = async (p: string) => {
      if (p === '/home/u') return ['Obsidian Vault', 'Documents', 'other'];
      if (p === '/home/u/Documents') return ['Obsidian', 'Not Obsidian'];
      return [];
    };
    const suggestions = await suggestVaultPaths('/home/u', readdir);
    expect(suggestions).toEqual(['/home/u/Obsidian Vault', '/home/u/Documents/Obsidian']);
  });

  it('returns no suggestions when nothing matches or the directory is missing', async () => {
    const readdir = async () => {
      throw new Error('ENOENT');
    };
    expect(await suggestVaultPaths('/home/u', readdir)).toEqual([]);
  });
});
