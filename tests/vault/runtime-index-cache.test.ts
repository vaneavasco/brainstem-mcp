// The machine-local index cache (ADR 0008 amendment, phase 4), as wired into createLocalRuntime:
// loading it into the deferred fill, deciding whether to save once ready, the hourly timer, and
// the bounded save on close(). src/storage/local-cache.ts has its own unit tests (real files,
// real NDJSON); this file fakes IndexCacheOption so the runtime's own decisions are exercised in
// isolation and without real disk I/O or a real hour of wall-clock time.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexEntry } from '../../src/vault/frontmatter-index.ts';
import { createLocalRuntime, type IndexCacheOption } from '../../src/vault/runtime.ts';

let root: string;
const NOTES = 40;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-runtime-cache-'));
  for (let i = 0; i < NOTES; i += 1) {
    await fs.writeFile(path.join(root, `n${i}.md`), `---\nn: ${i}\n---\nbody ${i}`);
  }
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface FakeCache {
  cache: IndexCacheOption;
  saveCalls: { count: number; budgetMs?: number }[];
  loadCalls: number;
}

function fakeIndexCache(
  loadResult: { entries: Map<string, IndexEntry> | null; rejected?: string } = { entries: null },
  saveResult: { ok: boolean; reason?: string } = { ok: true },
): FakeCache {
  const saveCalls: { count: number; budgetMs?: number }[] = [];
  let loadCalls = 0;
  return {
    saveCalls,
    get loadCalls() {
      return loadCalls;
    },
    cache: {
      async load() {
        loadCalls += 1;
        return loadResult;
      },
      async save(_entries, count, opts) {
        saveCalls.push({ count, budgetMs: opts?.budgetMs });
        return { ok: saveResult.ok, reason: saveResult.reason, durationMs: 1 };
      },
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!cond()) throw new Error('timed out waiting for condition');
}

describe('createLocalRuntime without an indexCache option', () => {
  it('indexCacheStats() is undefined — the HTTP server, and any boot that never wires one, is unaffected', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
    });
    try {
      expect(runtime.indexCacheStats()).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

describe('createLocalRuntime({ deferIndex: true, indexCache })', () => {
  it('loads the cache before the fill reads anything, and reports the hit/miss counts', async () => {
    // Build once, cold, to get real IndexEntry objects whose size/modifiedAt match the files on
    // disk (they have not changed since).
    const cold = await createLocalRuntime({ vaultPath: root, ripgrepPath: null, reconcileMs: 0 });
    const allEntries = new Map(cold.index.all().map((e) => [e.path, e]));
    await cold.close();

    const fake = fakeIndexCache({ entries: allEntries });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: fake.cache,
      indexCacheSaveIntervalMs: 0,
    });
    try {
      await runtime.indexReady;
      expect(fake.loadCalls).toBe(1);
      expect(runtime.indexCacheStats()).toEqual({
        used: true,
        entriesFromCache: NOTES,
        entriesRead: 0,
      });
      expect(runtime.index.size()).toBe(NOTES);
    } finally {
      await runtime.close();
    }
  });

  it('a rejected cache is reported (rejected reason, used: false, everything read from disk)', async () => {
    const { cache } = fakeIndexCache({ entries: null, rejected: 'schema mismatch (example)' });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    try {
      await runtime.indexReady;
      expect(runtime.indexCacheStats()).toEqual({
        used: false,
        entriesFromCache: 0,
        entriesRead: NOTES,
        rejected: 'schema mismatch (example)',
      });
    } finally {
      await runtime.close();
    }
  });

  it('saves once after ready when the cache was absent', async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    try {
      await runtime.indexReady;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]?.count).toBe(NOTES);
    } finally {
      await runtime.close();
    }
  });

  it('does NOT save after ready when the cache was already fully accurate (0% stale)', async () => {
    const cold = await createLocalRuntime({ vaultPath: root, ripgrepPath: null, reconcileMs: 0 });
    const allEntries = new Map(cold.index.all().map((e) => [e.path, e]));
    await cold.close();

    const { cache, saveCalls } = fakeIndexCache({ entries: allEntries });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    try {
      await runtime.indexReady;
      expect(saveCalls).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('saves once after ready when more than the stale-fraction threshold had to be read from disk', async () => {
    const cold = await createLocalRuntime({ vaultPath: root, ripgrepPath: null, reconcileMs: 0 });
    const allEntries = new Map(cold.index.all().map((e) => [e.path, e]));
    await cold.close();
    allEntries.delete('n0.md'); // 1 of 40 = 2.5%, above the default 1% threshold

    const { cache, saveCalls } = fakeIndexCache({ entries: allEntries });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    try {
      await runtime.indexReady;
      expect(saveCalls).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('never saves when the build fails', async () => {
    const brokenAdapter: Parameters<typeof createLocalRuntime>[0]['createAdapter'] = async (
      ...args
    ) => {
      const { LocalFSAdapter } = await import('../../src/storage/local-fs.ts');
      const adapter = await LocalFSAdapter.create(...args);
      adapter.list = async () => {
        throw new Error('simulated: cannot list the vault');
      };
      return adapter;
    };
    const { cache, saveCalls } = fakeIndexCache();
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      createAdapter: brokenAdapter,
      settleRetryMs: [5],
    });
    try {
      await runtime.indexReady;
      expect(runtime.indexState().error).toBe(true);
      expect(saveCalls).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('close() saves when the index changed since the last save', async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null }); // absent -> 1 save right after ready
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    await runtime.indexReady;
    expect(saveCalls).toHaveLength(1); // the post-fill save
    runtime.index.upsert({ ...(runtime.index.get('n0.md') as IndexEntry), wordCount: 12345 });
    await runtime.close();
    expect(saveCalls).toHaveLength(2); // the shutdown save, because the version moved on
  });

  it('close() does NOT save again when nothing changed since the last save', async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
    });
    await runtime.indexReady;
    expect(saveCalls).toHaveLength(1);
    await runtime.close();
    expect(saveCalls).toHaveLength(1); // unchanged since the post-fill save: close() writes nothing
  });

  it("close({ reason: 'client-dead' }) skips a save above the dead-client threshold", async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
      indexCacheDeadClientSkipNotes: 1, // this vault (40 notes) is "large" for this test
    });
    await runtime.indexReady;
    expect(saveCalls).toHaveLength(1); // post-fill save still happened
    runtime.index.upsert({ ...(runtime.index.get('n0.md') as IndexEntry), wordCount: 1 });
    await runtime.close({ reason: 'client-dead' });
    expect(saveCalls).toHaveLength(1); // the shutdown save was skipped outright
  });

  it("close({ reason: 'client-dead' }) still saves when the index is below the threshold", async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
      indexCacheDeadClientSkipNotes: 1_000_000,
    });
    await runtime.indexReady;
    expect(saveCalls).toHaveLength(1);
    runtime.index.upsert({ ...(runtime.index.get('n0.md') as IndexEntry), wordCount: 1 });
    await runtime.close({ reason: 'client-dead' });
    expect(saveCalls).toHaveLength(2);
  });

  it("close()'s save is given indexCacheShutdownBudgetMs", async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
      indexCacheShutdownBudgetMs: 1234,
    });
    await runtime.indexReady;
    runtime.index.upsert({ ...(runtime.index.get('n0.md') as IndexEntry), wordCount: 1 });
    await runtime.close();
    expect(saveCalls.at(-1)?.budgetMs).toBe(1234);
  });

  it('the hourly timer (shortened for the test) saves again once the index has changed', async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 20,
    });
    try {
      await runtime.indexReady;
      expect(saveCalls).toHaveLength(1); // the post-fill save
      runtime.index.upsert({ ...(runtime.index.get('n0.md') as IndexEntry), wordCount: 777 });
      await waitFor(() => saveCalls.length >= 2);
      expect(saveCalls).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('the hourly timer does not save when nothing changed', async () => {
    const { cache, saveCalls } = fakeIndexCache({ entries: null });
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 20,
    });
    try {
      await runtime.indexReady;
      expect(saveCalls).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 80)); // several ticks' worth
      expect(saveCalls).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('onIndexCacheSaved / onIndexCacheSaveError fire for the corresponding outcome', async () => {
    const saved: { count: number }[] = [];
    const errors: string[] = [];
    const { cache } = fakeIndexCache(
      { entries: null },
      { ok: false, reason: 'disk full (example)' },
    );
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      indexCache: cache,
      indexCacheSaveIntervalMs: 0,
      onIndexCacheSaved: (info) => saved.push(info),
      onIndexCacheSaveError: (reason) => errors.push(reason),
    });
    try {
      await runtime.indexReady;
      expect(saved).toEqual([]);
      expect(errors).toEqual(['disk full (example)']);
    } finally {
      await runtime.close();
    }
  });
});
