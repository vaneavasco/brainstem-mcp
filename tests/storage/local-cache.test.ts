import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import {
  createIndexCacheHandle,
  INDEX_CACHE_MAX_LINE_BYTES,
  INDEX_CACHE_RACY_WINDOW_MS,
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
    async realpath(p) {
      return p;
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
      realpath: async (p) => p,
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

  it('F1: refuses a cache base that is inside (or equal to) the vault, creating nothing', async () => {
    const fs_ = fakeFs();
    const result = await resolveLocalCacheDir(
      '/vaults/mine',
      deps({ fs: fs_, env: { BRAINSTEM_CACHE_HOME: '/vaults/mine/cache' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_CACHE_HOME');
    expect(result.error).toContain('inside');
    expect(fs_.calls).toBe(0); // mkdir never called
  });

  it('F1 (reverse): refuses when the vault is inside the cache base', async () => {
    const fs_ = fakeFs();
    const result = await resolveLocalCacheDir(
      '/opt/brainstem-cache/some-vault',
      deps({ fs: fs_, env: { BRAINSTEM_CACHE_HOME: '/opt/brainstem-cache' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
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

  it('F10: a FRESH tmp file of a DEAD writer is removed; a FRESH tmp file of a LIVE writer is kept', async () => {
    // Same (fresh) age for both — the only difference the new rule looks at is liveness. The
    // pre-F10 rule (age alone) would have kept both, since neither is stale; F10 additionally
    // removes a dead writer's tmp file at ANY age, while a live writer's fresh file is untouched.
    const deadName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.424242.deadbeef.tmp`;
    const liveName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.777777.cafebabe.tmp`;
    await fs.writeFile(path.join(dir, deadName), 'dead');
    await fs.writeFile(path.join(dir, liveName), 'live');

    await loadIndexCache(dir, vaultKeyValue, { isAlive: (pid) => pid === 777_777 });
    const files = await fs.readdir(dir);
    expect(files).not.toContain(deadName);
    expect(files).toContain(liveName);
  });

  it('F10: a LIVE writer’s tmp file older than a day is still removed — "as today", liveness alone never saves it', async () => {
    const liveButOldName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.777777.cafebabe.tmp`;
    await fs.writeFile(path.join(dir, liveButOldName), 'live but old');
    const dayAndAHalfAgo = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, liveButOldName), dayAndAHalfAgo, dayAndAHalfAgo);

    await loadIndexCache(dir, vaultKeyValue, { isAlive: () => true });
    expect(await fs.readdir(dir)).not.toContain(liveButOldName);
  });

  it('F10: a FRESH tmp file of a dead writer is removed immediately (any age, not just stale ones)', async () => {
    const deadName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.555555.deadbeef.tmp`;
    await fs.writeFile(path.join(dir, deadName), 'dead but fresh');
    await loadIndexCache(dir, vaultKeyValue, { isAlive: () => false });
    expect(await fs.readdir(dir)).not.toContain(deadName);
  });

  it('F10: a live writer’s FRESH tmp file is untouched', async () => {
    const liveName = `.index-v${INDEX_CACHE_SCHEMA}.ndjson.888888.cafebabe.tmp`;
    await fs.writeFile(path.join(dir, liveName), 'live and fresh');
    await loadIndexCache(dir, vaultKeyValue, { isAlive: () => true });
    expect(await fs.readdir(dir)).toContain(liveName);
  });

  it('createIndexCacheHandle wires load/save to a fixed dir+key+serverVersion', async () => {
    const handle = createIndexCacheHandle(dir, vaultKeyValue, '2.0.0');
    const saveResult = await handle.save([sampleEntry()], 1);
    expect(saveResult.ok).toBe(true);
    const loaded = await handle.load();
    expect(loaded.entries?.size).toBe(1);
  });

  describe('F3: "racily clean" entries are never written to the cache', () => {
    it('an entry modified just before the save is absent from the file and re-read from disk next boot', async () => {
      const savedAt = new Date('2026-09-21T12:00:00.000Z');
      const racyEntry = sampleEntry({
        path: 'racy.md',
        modifiedAt: new Date(savedAt.getTime() - 500).toISOString(), // 0.5s before the save
      });
      const oldEntry = sampleEntry({
        path: 'old.md',
        modifiedAt: new Date(savedAt.getTime() - 60_000).toISOString(), // a minute before
      });
      const result = await saveIndexCache(dir, [racyEntry, oldEntry], 2, vaultKeyValue, {
        serverVersion: '1.0.0',
        now: () => savedAt,
      });
      expect(result.ok).toBe(true);
      expect(result.racySkipped).toBe(1);

      const loaded = await loadIndexCache(dir, vaultKeyValue);
      // The racy path is simply absent from the cache map — which is exactly what makes
      // `FrontmatterIndex.fill()` read it from disk at the next boot instead of trusting a stale
      // hit: `fill()` only ever upserts a path present in the cache map (see
      // `src/vault/frontmatter-index.ts`), so "absent" already means "read from disk next boot"
      // by construction, with no special-casing needed there.
      expect(loaded.entries?.has('racy.md')).toBe(false);
      // The old, safely-quiet entry IS present and is what a cache hit would come from.
      expect(loaded.entries?.has('old.md')).toBe(true);
      expect(loaded.entries?.get('old.md')).toEqual(oldEntry);
    });

    it('an entry safely old (past the racy window) IS written and served from cache', async () => {
      const savedAt = new Date('2026-09-21T12:00:00.000Z');
      const oldEntry = sampleEntry({
        path: 'old.md',
        modifiedAt: new Date(savedAt.getTime() - INDEX_CACHE_RACY_WINDOW_MS - 1).toISOString(),
      });
      await saveIndexCache(dir, [oldEntry], 1, vaultKeyValue, {
        serverVersion: '1.0.0',
        now: () => savedAt,
      });
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('old.md')).toBe(true);
    });

    it('the documented blind spot: a rewrite that RESTORES an old mtime with the same size is still not caught', async () => {
      // Not a save-time concern at all (this is exactly the pair the module doc says it does not
      // attempt to close): an old entry cached, then the file on disk is rewritten but its mtime
      // is forced back with `utimes` to the SAME old value and the same size — indistinguishable
      // from an untouched file to both this cache and FrontmatterIndex.reconcile.
      const savedAt = new Date('2026-09-21T12:00:00.000Z');
      const oldMtime = new Date(savedAt.getTime() - 60_000).toISOString();
      const entry = sampleEntry({ path: 'forced.md', modifiedAt: oldMtime, size: 42 });
      await saveIndexCache(dir, [entry], 1, vaultKeyValue, {
        serverVersion: '1.0.0',
        now: () => savedAt,
      });
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      // Cached, because it looked safely old at save time — this IS the accepted blind spot.
      expect(loaded.entries?.get('forced.md')).toEqual(entry);
    });
  });

  describe('F11: a number JSON cannot carry is never written to the cache', () => {
    it('a non-finite number anywhere in frontmatter (even nested) is skipped', async () => {
      const entry = sampleEntry({
        path: 'nan.md',
        frontmatter: { type: 'note', nested: { nanval: Number.NaN } },
      });
      const result = await saveIndexCache(dir, [entry], 1, vaultKeyValue, {
        serverVersion: '1.0.0',
      });
      expect(result.ok).toBe(true);
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('nan.md')).toBe(false);
    });

    it('-0 anywhere in frontmatter is skipped', async () => {
      const entry = sampleEntry({ path: 'negzero.md', frontmatter: { count: -0 } });
      await saveIndexCache(dir, [entry], 1, vaultKeyValue, { serverVersion: '1.0.0' });
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('negzero.md')).toBe(false);
    });

    it('Infinity anywhere in an array value is skipped', async () => {
      const entry = sampleEntry({
        path: 'inf.md',
        frontmatter: { list: [1, 2, Number.POSITIVE_INFINITY] },
      });
      await saveIndexCache(dir, [entry], 1, vaultKeyValue, { serverVersion: '1.0.0' });
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('inf.md')).toBe(false);
    });

    it('a plain finite number is written normally', async () => {
      const entry = sampleEntry({ path: 'fine.md', frontmatter: { count: 42, ratio: 0.5 } });
      await saveIndexCache(dir, [entry], 1, vaultKeyValue, { serverVersion: '1.0.0' });
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.get('fine.md')).toEqual(entry);
    });
  });

  describe('F4 + F9: the load-time line splitter is bounded and never breaks on U+2028/U+2029', () => {
    it('a 50 MB single line among valid ones: the valid ones load, the huge one is skipped and counted', async () => {
      const header = {
        schema: INDEX_CACHE_SCHEMA,
        server: '1',
        vaultKey: vaultKeyValue,
        writtenAt: new Date().toISOString(),
        entries: 3,
      };
      const huge = `{"path":"huge.md","pad":"${'x'.repeat(50 * 1024 * 1024)}"}`;
      const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
      const lines = [
        JSON.stringify(header),
        JSON.stringify(sampleEntry({ path: 'a.md' })),
        huge,
        JSON.stringify(sampleEntry({ path: 'c.md' })),
      ];
      await fs.writeFile(file, `${lines.join('\n')}\n`);

      // RSS is measured around the load only; `global.gc()` is not available without --expose-gc,
      // so this is a coarse bound, not an exact one — generous on purpose (150 MB) to stay stable
      // across machines and GC timing while still catching the failure mode this guards against:
      // the old readline-based reader (or a naive "accumulate the whole line") holding the full
      // 50 MB line (or worse, a decoded/JSON.parse'd copy of it) in memory at once. The
      // line-splitter drops bytes for an over-cap line as they arrive rather than buffering them,
      // so a real fix keeps this well under the bound; a regression would spike it by tens of MB.
      const before = process.memoryUsage().rss;
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      const after = process.memoryUsage().rss;
      expect(after - before).toBeLessThan(150 * 1024 * 1024);

      expect(loaded.rejected).toBeUndefined();
      expect(loaded.entries?.has('a.md')).toBe(true);
      expect(loaded.entries?.has('c.md')).toBe(true);
      expect(loaded.entries?.has('huge.md')).toBe(false);
      expect(loaded.skippedCount).toBe(1);
    }, 30_000);

    it('a line at exactly the cap loads; one byte past it is skipped', async () => {
      const header = {
        schema: INDEX_CACHE_SCHEMA,
        server: '1',
        vaultKey: vaultKeyValue,
        writtenAt: new Date().toISOString(),
        entries: 1,
      };
      // Build an entry whose serialized line is exactly INDEX_CACHE_MAX_LINE_BYTES, by padding a
      // string field to hit the target byte length exactly.
      const base = sampleEntry({ path: 'pad.md', frontmatter: {} });
      const withoutPad = JSON.stringify({ ...base, frontmatter: { pad: '' } });
      const padLen = INDEX_CACHE_MAX_LINE_BYTES - Buffer.byteLength(withoutPad, 'utf8');
      const exact = JSON.stringify({ ...base, frontmatter: { pad: 'x'.repeat(padLen) } });
      expect(Buffer.byteLength(exact, 'utf8')).toBe(INDEX_CACHE_MAX_LINE_BYTES);
      const overCap = JSON.stringify({
        ...base,
        path: 'over.md',
        frontmatter: { pad: 'x'.repeat(padLen + 1) },
      });

      const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
      await fs.writeFile(file, `${JSON.stringify(header)}\n${exact}\n${overCap}\n`);
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('pad.md')).toBe(true);
      expect(loaded.entries?.has('over.md')).toBe(false);
      expect(loaded.skippedCount).toBe(1);
    });

    it('a path and a frontmatter value containing U+2028 and U+2029 round-trip through save + load', async () => {
      const entry = sampleEntry({
        path: 'sep  note.md',
        frontmatter: { title: 'before after end' },
      });
      const saved = await saveIndexCache(dir, [entry], 1, vaultKeyValue, {
        serverVersion: '1.0.0',
      });
      expect(saved.ok).toBe(true);
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.rejected).toBeUndefined();
      expect(loaded.skippedCount).toBe(0);
      expect(loaded.validCount).toBe(1);
      expect(loaded.entries?.get('sep  note.md')).toEqual(entry);
    });

    it('CRLF line endings are tolerated (decision: strip a trailing CR, like readline’s crlfDelay did)', async () => {
      const header = {
        schema: INDEX_CACHE_SCHEMA,
        server: '1',
        vaultKey: vaultKeyValue,
        writtenAt: new Date().toISOString(),
        entries: 1,
      };
      const file = path.join(dir, `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
      const lines = [JSON.stringify(header), JSON.stringify(sampleEntry({ path: 'crlf.md' }))];
      await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.rejected).toBeUndefined();
      expect(loaded.entries?.get('crlf.md')).toEqual(sampleEntry({ path: 'crlf.md' }));
    });

    it('at save time, an entry whose serialized line would exceed the cap is not written', async () => {
      const huge = sampleEntry({
        path: 'toobig.md',
        frontmatter: { pad: 'x'.repeat(INDEX_CACHE_MAX_LINE_BYTES) },
      });
      const small = sampleEntry({ path: 'small.md' });
      const result = await saveIndexCache(dir, [huge, small], 2, vaultKeyValue, {
        serverVersion: '1.0.0',
      });
      expect(result.ok).toBe(true);
      const loaded = await loadIndexCache(dir, vaultKeyValue);
      expect(loaded.entries?.has('toobig.md')).toBe(false);
      expect(loaded.entries?.has('small.md')).toBe(true);
    }, 30_000);
  });
});
