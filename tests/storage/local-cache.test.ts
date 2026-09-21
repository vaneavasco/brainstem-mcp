import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import {
  createIndexCacheHandle,
  type LocalCacheEnvDeps,
  type LocalCacheFsDeps,
  loadIndexCache,
  resolveBaseCacheDir,
  resolveLocalCacheDir,
  saveIndexCache,
} from '../../src/storage/local-cache.ts';
import { INDEX_CACHE_SCHEMA, type IndexEntry } from '../../src/vault/frontmatter-index.ts';

function deps(
  over: Partial<LocalCacheEnvDeps & { fs: LocalCacheFsDeps }> = {},
): LocalCacheEnvDeps & { fs: LocalCacheFsDeps } {
  return {
    env: {},
    platform: 'linux',
    homedir: () => '/home/tester',
    fs: fakeFs(),
    ...over,
  };
}

function fakeFs(): LocalCacheFsDeps & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async mkdir() {
      calls += 1;
      return undefined;
    },
  };
}

describe('resolveBaseCacheDir', () => {
  it('defaults to ~/.cache/brainstem on linux', () => {
    expect(resolveBaseCacheDir(deps({ platform: 'linux', env: {} }))).toEqual({
      ok: true,
      dir: '/home/tester/.cache/brainstem',
    });
  });

  it('honours XDG_CACHE_HOME on linux', () => {
    expect(
      resolveBaseCacheDir(
        deps({ platform: 'linux', env: { XDG_CACHE_HOME: '/custom/xdg-cache' } }),
      ),
    ).toEqual({ ok: true, dir: '/custom/xdg-cache/brainstem' });
  });

  it('defaults to ~/Library/Caches/brainstem on darwin', () => {
    expect(resolveBaseCacheDir(deps({ platform: 'darwin', env: {} }))).toEqual({
      ok: true,
      dir: '/home/tester/Library/Caches/brainstem',
    });
  });

  it('uses %LOCALAPPDATA%\\brainstem\\Cache on win32', () => {
    expect(
      resolveBaseCacheDir(
        deps({
          platform: 'win32',
          homedir: () => 'C:\\Users\\tester',
          env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
        }),
      ),
    ).toEqual({ ok: true, dir: 'C:\\Users\\tester\\AppData\\Local\\brainstem\\Cache' });
  });

  it('falls back to ~/AppData/Local/brainstem/Cache on win32 when LOCALAPPDATA is unset', () => {
    expect(
      resolveBaseCacheDir(deps({ platform: 'win32', homedir: () => 'C:\\Users\\tester', env: {} })),
    ).toEqual({ ok: true, dir: 'C:\\Users\\tester\\AppData\\Local\\brainstem\\Cache' });
  });

  it('BRAINSTEM_CACHE_HOME wins on every platform when absolute', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(
        resolveBaseCacheDir(
          deps({ platform, env: { BRAINSTEM_CACHE_HOME: '/opt/brainstem-cache' } }),
        ),
        platform,
      ).toEqual({ ok: true, dir: '/opt/brainstem-cache' });
    }
  });

  it('rejects a relative BRAINSTEM_CACHE_HOME with a clear error naming the variable', () => {
    const result = resolveBaseCacheDir(deps({ env: { BRAINSTEM_CACHE_HOME: 'relative/path' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('BRAINSTEM_CACHE_HOME');
      expect(result.error).toContain('relative/path');
    }
  });
});

describe('resolveLocalCacheDir (deps injected, no real filesystem)', () => {
  it('creates <base>/<16 hex of sha256(realpath)> with mode 0700 and returns the key', async () => {
    const fs_ = fakeFs();
    const result = await resolveLocalCacheDir('/vaults/mine', deps({ fs: fs_ }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedKey = sha256hex('/vaults/mine').slice(0, 16);
    expect(result.key).toBe(expectedKey);
    expect(result.dir).toBe(`/home/tester/.cache/brainstem/${expectedKey}`);
    expect(fs_.calls).toBe(1);
  });

  it('shares a folder with the state dir for the same vault (same key derivation)', async () => {
    const fs_ = fakeFs();
    const result = await resolveLocalCacheDir('/vaults/mine', deps({ fs: fs_ }));
    expect(result.ok && result.key).toBe(sha256hex('/vaults/mine').slice(0, 16));
  });

  it('never falls back anywhere when the base directory cannot be created', async () => {
    const fs_: LocalCacheFsDeps = {
      mkdir: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    const result = await resolveLocalCacheDir('/vaults/mine', deps({ fs: fs_ }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('index-cache');
  });

  it('propagates a BRAINSTEM_CACHE_HOME error instead of resolving a folder', async () => {
    const fs_ = fakeFs();
    const result = await resolveLocalCacheDir(
      '/vaults/mine',
      deps({ fs: fs_, env: { BRAINSTEM_CACHE_HOME: 'not-absolute' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_CACHE_HOME');
    expect(fs_.calls).toBe(0);
  });
});

function sampleEntry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: 'a.md',
    frontmatter: { type: 'note' },
    hasFrontmatter: true,
    size: 42,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    hash: 'deadbeef',
    links: [],
    tags: ['x'],
    headings: [{ level: 1, text: 'A', line: 0 }],
    blockIds: [],
    wordCount: 3,
    ...over,
  };
}

describe('save + load round trip, against the real filesystem', () => {
  let dir: string;
  const vaultKeyValue = 'abc123abc123abcd';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-cache-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves and loads the same entries back, keyed by path', async () => {
    const entries = [sampleEntry({ path: 'a.md' }), sampleEntry({ path: 'b.md', size: 99 })];
    const saved = await saveIndexCache(dir, entries, entries.length, vaultKeyValue, {
      serverVersion: '9.9.9',
    });
    expect(saved.ok).toBe(true);

    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.validCount).toBe(2);
    expect(loaded.skippedCount).toBe(0);
    expect(loaded.entries?.size).toBe(2);
    expect(loaded.entries?.get('a.md')).toEqual(entries[0]);
    expect(loaded.entries?.get('b.md')).toEqual(entries[1]);
  });

  it('writes dir 0700 and the cache file 0600', async () => {
    if (process.platform === 'win32') return;
    await fs.chmod(dir, 0o700);
    await saveIndexCache(dir, [sampleEntry()], 1, vaultKeyValue, { serverVersion: '1.0.0' });
    const files = await fs.readdir(dir);
    const cacheFile = files.find((f) => f.startsWith('index-v'));
    expect(cacheFile).toBeDefined();
    const st = await fs.stat(path.join(dir, cacheFile as string));
    expect(st.mode & 0o777).toBe(0o600);
    const dirSt = await fs.stat(dir);
    expect(dirSt.mode & 0o777).toBe(0o700);
  });

  it('writes via a unique tmp name, fsync + rename — no tmp file left after a clean save', async () => {
    await saveIndexCache(dir, [sampleEntry()], 1, vaultKeyValue, { serverVersion: '1.0.0' });
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.includes('.tmp'))).toBe(false);
    expect(files).toEqual([`index-v${INDEX_CACHE_SCHEMA}.ndjson`]);
  });

  it('an absent cache: entries null, no rejected reason, nothing thrown', async () => {
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.entries).toBeNull();
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.validCount).toBe(0);
  });

  it('a different server version alone does NOT reject the cache', async () => {
    await saveIndexCache(dir, [sampleEntry()], 1, vaultKeyValue, { serverVersion: '1.0.0' });
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.entries?.size).toBe(1);
  });

  it('a schema mismatch rejects the whole cache and deletes the file', async () => {
    const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
    await fs.writeFile(
      file,
      `${JSON.stringify({ schema: INDEX_CACHE_SCHEMA + 1, server: '1.0.0', vaultKey: vaultKeyValue, writtenAt: new Date().toISOString(), entries: 1 })}\n${JSON.stringify(sampleEntry())}\n`,
    );
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.entries).toBeNull();
    expect(loaded.rejected).toMatch(/schema/i);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('a vaultKey mismatch rejects the whole cache and deletes the file', async () => {
    const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
    await fs.writeFile(
      file,
      `${JSON.stringify({ schema: INDEX_CACHE_SCHEMA, server: '1.0.0', vaultKey: 'someone-elses-vault', writtenAt: new Date().toISOString(), entries: 1 })}\n${JSON.stringify(sampleEntry())}\n`,
    );
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.entries).toBeNull();
    expect(loaded.rejected).toMatch(/vault/i);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('a garbage header (unparseable JSON) rejects the whole cache', async () => {
    const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
    await fs.writeFile(file, 'not json at all\n{"path":"a.md"}\n');
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.entries).toBeNull();
    expect(loaded.rejected).toBeDefined();
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('a corrupted middle line is skipped; every other valid entry is still used', async () => {
    const header = {
      schema: INDEX_CACHE_SCHEMA,
      server: '1',
      vaultKey: vaultKeyValue,
      writtenAt: new Date().toISOString(),
      entries: 3,
    };
    const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
    const lines = [
      JSON.stringify(header),
      JSON.stringify(sampleEntry({ path: 'a.md' })),
      'this is not valid json {{{',
      JSON.stringify(sampleEntry({ path: 'c.md' })),
    ];
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.validCount).toBe(2);
    expect(loaded.skippedCount).toBe(1);
    expect([...(loaded.entries?.keys() ?? [])].sort()).toEqual(['a.md', 'c.md']);
  });

  it('a truncated last line: everything that validated before it is used', async () => {
    const header = {
      schema: INDEX_CACHE_SCHEMA,
      server: '1',
      vaultKey: vaultKeyValue,
      writtenAt: new Date().toISOString(),
      entries: 2,
    };
    const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
    const full = JSON.stringify(sampleEntry({ path: 'b.md' }));
    await fs.writeFile(
      file,
      `${JSON.stringify(header)}\n${JSON.stringify(sampleEntry({ path: 'a.md' }))}\n${full.slice(0, Math.floor(full.length / 2))}`,
    );
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.validCount).toBe(1);
    expect(loaded.skippedCount).toBe(1);
    expect(loaded.entries?.has('a.md')).toBe(true);
  });

  it('two runtimes saving at once leave exactly one valid file, and it loads cleanly', async () => {
    const a = saveIndexCache(dir, [sampleEntry({ path: 'a.md' })], 1, vaultKeyValue, {
      serverVersion: '1.0.0',
    });
    const b = saveIndexCache(dir, [sampleEntry({ path: 'b.md' })], 1, vaultKeyValue, {
      serverVersion: '1.0.0',
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    const files = await fs.readdir(dir);
    expect(files).toEqual([`index-v${INDEX_CACHE_SCHEMA}.ndjson`]);
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.rejected).toBeUndefined();
    expect(loaded.entries?.size).toBe(1); // whichever renamed last — but exactly one, and it's valid
  });

  it('a save abandoned on its time budget leaves no tmp file and the old cache intact', async () => {
    const initial = [sampleEntry({ path: 'a.md' })];
    await saveIndexCache(dir, initial, 1, vaultKeyValue, { serverVersion: '1.0.0' });

    const many = Array.from({ length: 50 }, (_, i) => sampleEntry({ path: `n${i}.md` }));
    // -1, not 0: the very first budget check must already read as "exceeded" regardless of how
    // many (zero or more) real milliseconds elapsed opening the tmp file and writing the header.
    const abandoned = await saveIndexCache(dir, many, many.length, vaultKeyValue, {
      serverVersion: '1.0.0',
      budgetMs: -1,
    });
    expect(abandoned.ok).toBe(false);
    expect(abandoned.reason).toMatch(/budget/i);

    const files = await fs.readdir(dir);
    expect(files).toEqual([`index-v${INDEX_CACHE_SCHEMA}.ndjson`]); // no tmp left
    const loaded = await loadIndexCache(dir, vaultKeyValue);
    expect(loaded.entries?.size).toBe(1);
    expect(loaded.entries?.has('a.md')).toBe(true); // the OLD cache, untouched
  });

  it('stale tmp files (dead writers) older than a day are removed at load; fresh ones are kept', async () => {
    const staleName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.999999.deadbeef.tmp`;
    const freshName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.999998.cafebabe.tmp`;
    await fs.writeFile(path.join(dir, staleName), 'stale');
    await fs.writeFile(path.join(dir, freshName), 'fresh');
    const dayAndAHalfAgo = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, staleName), dayAndAHalfAgo, dayAndAHalfAgo);

    await loadIndexCache(dir, vaultKeyValue);
    const files = await fs.readdir(dir);
    expect(files).not.toContain(staleName);
    expect(files).toContain(freshName);
  });

  it('createIndexCacheHandle wires load/save to a fixed dir+key+serverVersion', async () => {
    const handle = createIndexCacheHandle(dir, vaultKeyValue, '2.0.0');
    const saveResult = await handle.save([sampleEntry()], 1);
    expect(saveResult.ok).toBe(true);
    const loaded = await handle.load();
    expect(loaded.entries?.size).toBe(1);
  });
});
