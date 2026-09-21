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

/** A real adapter whose directory listing fails the first `failures` times it is asked AFTER the
 *  fill's own listing: that is the settling reconcile failing transiently. */
function flakySettleAdapter(failures: number, delayMs = 0): typeof LocalFSAdapter.create {
  return async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    const list = adapter.list.bind(adapter);
    const batchRead = adapter.batchRead.bind(adapter);
    let lists = 0;
    adapter.list = async (...a) => {
      lists += 1;
      if (lists > 1 && lists <= 1 + failures) throw new Error('listing failed (injected)');
      return list(...a);
    };
    adapter.batchRead = async (...a) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return batchRead(...a);
    };
    return adapter;
  };
}

describe('the index is ready only after a pass over the disk has SUCCEEDED', () => {
  it('a settling pass that fails is retried; ready comes with a successful one, never before', async () => {
    for (let i = 0; i < 30; i += 1) await fs.writeFile(path.join(root, `n${i}.md`), `# n${i}\n`);
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      settleRetryMs: [20, 20, 20],
      createAdapter: flakySettleAdapter(2, 5),
    });
    try {
      // created while the fill runs: only a successful pass can know about it
      await fs.writeFile(path.join(root, 'during.md'), '# during\n');
      await runtime.indexReady;
      const state = runtime.indexState();
      expect(state).toMatchObject({ ready: true });
      expect(state.error).toBeUndefined();
      expect(runtime.index.reconciledAt).not.toBeNull(); // the invariant: ready ⇒ a pass succeeded
      expect(runtime.index.get('during.md')).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('when every attempt fails the index is in error, not ready', async () => {
    await fs.writeFile(path.join(root, 'a.md'), '# a\n');
    const errors: unknown[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      settleRetryMs: [10, 10],
      onIndexError: (e) => errors.push(e),
      createAdapter: flakySettleAdapter(99),
    });
    try {
      await runtime.indexReady;
      expect(runtime.indexState()).toMatchObject({ ready: false, error: true });
      expect(runtime.index.reconciledAt).toBeNull();
      expect(errors).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('a note the fill could not read is counted as unreadable, not as done', async () => {
    await fs.writeFile(path.join(root, 'good.md'), '# good\n');
    await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd])); // not UTF-8
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
    });
    try {
      await runtime.indexReady;
      expect(runtime.indexState()).toMatchObject({ ready: true, unreadable: 1 });
      expect(runtime.index.get('good.md')).toBeDefined();
      expect(runtime.index.get('bad.md')).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

describe('closing during the fill', () => {
  it('stops the fill between batches and resolves promptly, without starting a watcher', async () => {
    for (let i = 0; i < 400; i += 1) await fs.writeFile(path.join(root, `n${i}.md`), `# n${i}\n`);
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      deferIndex: true,
      createAdapter: slowAdapter(300), // 20 batches x 300 ms = 6 s if it ran to the end
    });
    await waitFor(() => runtime.indexState().total > 0);
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(1500);
    const state = runtime.indexState();
    expect(state.ready).toBe(false);
    expect(state.error).toBeUndefined(); // stopping is not failing
    expect(state.done).toBeLessThan(400);
  });
});

describe('a note the operating system refuses to read', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is counted as unreadable: the rest of the vault is still indexed',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-eacces-'));
      try {
        for (const name of ['a', 'b', 'c', 'd']) {
          await fs.writeFile(path.join(root, `${name}.md`), `---\nk: ${name}\n---\n`);
        }
        await fs.chmod(path.join(root, 'c.md'), 0o000);
        const runtime = await createLocalRuntime({ vaultPath: root, deferIndex: true });
        try {
          await runtime.indexReady;
          expect(runtime.indexState()).toMatchObject({ ready: true, unreadable: 1 });
          expect(runtime.index.size()).toBe(3);
        } finally {
          await runtime.close();
        }
        // the blocking boot (the HTTP server's) must not refuse to start over one file either
        const blocking = await createLocalRuntime({ vaultPath: root });
        expect(blocking.index.size()).toBe(3);
        await blocking.close();
      } finally {
        await fs.chmod(path.join(root, 'c.md'), 0o644).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('the unreadable count follows the disk', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'drops back once the note can be read, and total counts the note either way',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-eacces-heal-'));
      try {
        for (const name of ['a', 'b', 'c']) {
          await fs.writeFile(path.join(root, `${name}.md`), `---\nk: ${name}\n---\n`);
        }
        await fs.chmod(path.join(root, 'b.md'), 0o000);
        const runtime = await createLocalRuntime({
          vaultPath: root,
          deferIndex: true,
          reconcileMs: 0,
        });
        try {
          await runtime.indexReady;
          expect(runtime.indexState()).toEqual({ ready: true, done: 2, total: 3, unreadable: 1 });
          await fs.chmod(path.join(root, 'b.md'), 0o644);
          await runtime.index.reconcile(runtime.adapter);
          expect(runtime.indexState()).toEqual({ ready: true, done: 3, total: 3 });
          // and the other way: a note that stops being readable is counted from the next pass
          await fs.chmod(path.join(root, 'a.md'), 0o000);
          await fs.utimes(path.join(root, 'a.md'), new Date(), new Date(Date.now() + 5_000));
          await runtime.index.reconcile(runtime.adapter);
          expect(runtime.indexState().unreadable).toBe(1);
        } finally {
          await runtime.close();
        }
      } finally {
        for (const name of ['a', 'b'])
          await fs.chmod(path.join(root, `${name}.md`), 0o644).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
