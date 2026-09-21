import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { createLocalRuntime } from '../../src/vault/runtime.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-runtime-deferred-'));
  for (let i = 0; i < 40; i += 1) {
    await fs.writeFile(path.join(root, `n${i}.md`), `---\nn: ${i}\n---\nbody ${i}`);
  }
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A real adapter whose `batchRead` (what `FrontmatterIndex.fill` uses) is slowed by a fixed
 *  delay per batch — injected, nothing global is patched. Mirrors the
 *  `adapterWithWatcherErrors` pattern in runtime.test.ts. */
function slowAdapter(delayMs: number): typeof LocalFSAdapter.create {
  return async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    const batchRead = adapter.batchRead.bind(adapter);
    adapter.batchRead = async (paths) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return batchRead(paths);
    };
    return adapter;
  };
}

/** An adapter whose `list` (the first thing `fill()` calls) always rejects. */
function brokenAdapter(): typeof LocalFSAdapter.create {
  return async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    adapter.list = async () => {
      throw new Error('simulated: cannot list the vault');
    };
    return adapter;
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('createLocalRuntime({ deferIndex: true })', () => {
  it('resolves well under the fill time, with an empty index that fills in the background', async () => {
    const started = Date.now();
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      createAdapter: slowAdapter(150), // 2 batches of 20 -> at least 300ms to finish
    });
    try {
      const bootMs = Date.now() - started;
      expect(bootMs).toBeLessThan(150); // returned before even one slow batch finished
      expect(runtime.indexState().ready).toBe(false);

      // Partial progress shows up while the (slow) fill is still running.
      await waitFor(() => runtime.indexState().total > 0);
      const partial = runtime.indexState();
      expect(partial.ready).toBe(false);
      expect(partial.total).toBe(40);

      await runtime.indexReady;
      const after = runtime.indexState();
      expect(after.ready).toBe(true);
      expect(after.done).toBe(after.total);
      expect(after.total).toBe(40);
      expect(runtime.index.size()).toBe(40);
    } finally {
      await runtime.close();
    }
  });

  it('non-deferred path: ready from the start, indexReady already resolved', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
    });
    try {
      expect(runtime.indexState()).toEqual({ ready: true, done: 40, total: 40 });
      await expect(runtime.indexReady).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('a fill that throws: indexState().error is true, close() resolves, no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const errors: unknown[] = [];
      const runtime = await createLocalRuntime({
        vaultPath: root,
        ripgrepPath: null,
        reconcileMs: 0,
        deferIndex: true,
        createAdapter: brokenAdapter(),
        onIndexError: (e) => errors.push(e),
      });
      await runtime.indexReady; // settles (does not reject) once the attempt is done
      const state = runtime.indexState();
      expect(state.ready).toBe(false);
      expect(state.error).toBe(true);
      expect(errors).toHaveLength(1);
      await runtime.close();
      // give any stray unhandled rejection a chance to surface before asserting none did
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('close() during a fill in flight waits for it and never attaches a watcher', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      createAdapter: slowAdapter(80),
    });
    // close before the fill (2 batches * 80ms) has any chance to finish
    await runtime.close();
    expect(runtime.indexState().ready).toBe(false);
  });

  it('the watcher and reconcile timer start only after the fill, then run one settling reconcile', async () => {
    const reconciles: number[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      createAdapter: slowAdapter(30),
      onReconcile: () => reconciles.push(Date.now()),
    });
    try {
      expect(reconciles).toEqual([]); // nothing yet: still filling
      await runtime.indexReady;
      await waitFor(() => reconciles.length >= 1);
      expect(reconciles).toHaveLength(1); // exactly the one post-fill settling pass
    } finally {
      await runtime.close();
    }
  });
});
