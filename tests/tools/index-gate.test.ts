import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { type Harness, startHarness } from './harness.ts';

/**
 * A real adapter whose `batchRead` (what `FrontmatterIndex.fill` uses) takes `delayMs` longer to
 * resolve than the real one — injected, nothing global is patched. The real read happens first
 * (so the disk snapshot it captures reflects the moment it was called, not the moment it
 * returns); only the return is delayed, so a write that lands after the call but before it
 * resolves is captured only by the post-fill reconcile, never by the fill itself. Mirrors the
 * `adapterWithWatcherErrors` pattern in tests/vault/runtime.test.ts.
 */
function slowAdapter(delayMs: number): typeof LocalFSAdapter.create {
  return async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    const batchRead = adapter.batchRead.bind(adapter);
    adapter.batchRead = async (paths) => {
      const result = await batchRead(paths);
      await new Promise((r) => setTimeout(r, delayMs));
      return result;
    };
    return adapter;
  };
}

/**
 * The same, but the fill is held until the test lets it go, instead of for a fixed time: a test
 * that asserts "still building" must not depend on how fast the machine is (on a loaded CI runner
 * a 200 ms delay was over before the first call was answered).
 */
function heldAdapter(): { create: typeof LocalFSAdapter.create; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create: typeof LocalFSAdapter.create = async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    const batchRead = adapter.batchRead.bind(adapter);
    adapter.batchRead = async (paths) => {
      const result = await batchRead(paths);
      await held;
      return result;
    };
    return adapter;
  };
  return { create, release };
}

function brokenAdapter(): typeof LocalFSAdapter.create {
  return async (...args) => {
    const adapter = await LocalFSAdapter.create(...args);
    adapter.list = async () => {
      throw new Error('simulated: cannot list the vault');
    };
    return adapter;
  };
}

/** A fresh vault directory seeded with one note, so a deferred fill has at least one (slow)
 *  batch to run instead of completing instantly on an empty vault. */
async function seededRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-gate-'));
  await fs.writeFile(path.join(root, 'seed.md'), '---\nkind: seed\n---\nseed body');
  return root;
}

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('the index-readiness gate on vault tools (deferIndex: true)', () => {
  it('brainstem_ping reports building with counts while the fill is in flight, then done', async () => {
    const fill = heldAdapter();
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: fill.create,
    });
    const first = await h.call('brainstem_ping');
    const firstBody = first.structuredContent as {
      index: { building: boolean; indexed: number; total: number };
    };
    expect(firstBody.index.building).toBe(true);
    expect(firstBody.index.total).toBe(1);

    fill.release();
    await h.runtime.indexReady;
    const after = await h.call('brainstem_ping');
    const afterBody = after.structuredContent as {
      index: { building: boolean; indexed: number; total: number };
    };
    expect(afterBody.index.building).toBe(false);
    expect(afterBody.index.indexed).toBe(afterBody.index.total);
  });

  it('vault_read is exempt: it works immediately, before the index is ready', async () => {
    const fill = heldAdapter();
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: fill.create,
    });
    await h.runtime.adapter.write('note.md', '# hello');
    const r = await h.call('vault_read', { path: 'note.md' });
    expect(r.isError).toBeFalsy();
    expect(h.runtime.indexState().ready).toBe(false); // proves this really didn't wait
    fill.release();
  });

  it('vault_read gives no near-miss suggestion while the index is building, never waits, never throws', async () => {
    const fill = heldAdapter();
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: fill.create,
    });
    const r = await h.call('vault_read', { path: 'seed-typo.md' });
    expect(h.runtime.indexState().ready).toBe(false); // still building: proves this didn't wait
    fill.release();
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg).not.toContain('Did you mean');
  });

  it('vault_query { countOnly: true } waits for the fill and answers the FULL count, never a partial one', async () => {
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: slowAdapter(150),
    });
    // Written directly to disk (bypassing the gate) while the fill is still busy with the seed
    // note: the fill's own directory listing predates these, so only the post-fill settling
    // reconcile can find them.
    for (let i = 0; i < 5; i += 1) {
      await h.runtime.adapter.write(`n${i}.md`, '---\nkind: x\n---\nbody');
    }
    const r = await h.call('vault_query', {
      where: [{ field: 'kind', op: 'eq', value: 'x' }],
      countOnly: true,
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { total: number }).total).toBe(5);
    expect(h.runtime.indexState().ready).toBe(true); // the call only returned once ready
  });

  it('with a tiny indexWaitMs, a gated tool answers the building error naming "N of M"', async () => {
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: slowAdapter(2000),
      indexWaitMs: 20,
    });
    const r = await h.call('vault_query', {});
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg).toMatch(/\d+ of \d+/);
    expect(h.runtime.indexState().ready).toBe(false);
  });

  it('a vault_write issued during the fill is applied only after the index is ready, and reflected in it', async () => {
    const fill = heldAdapter();
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: fill.create,
    });
    const before = h.runtime.indexState().ready;
    const pending = h.call('vault_write', { path: 'new.md', content: '# New' });
    setTimeout(fill.release, 100); // the call is parked at the gate by then; either order is valid
    const writeResult = await pending;
    expect(before).toBe(false); // the write really was issued while still building
    expect(writeResult.isError).toBeFalsy();
    expect(h.runtime.indexState().ready).toBe(true); // the gate only let it run once ready
    expect(h.runtime.index.get('new.md')).toBeDefined();
  });

  it('a note changed on disk during the fill is correct in the index once ready (the post-fill reconcile)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-gate-reconcile-'));
    await fs.writeFile(path.join(root, 'existing.md'), '---\nv: 1\n---\nold');
    h = await startHarness(undefined, null, root, {
      deferIndex: true,
      createAdapter: slowAdapter(150),
    });
    // Changed on disk after the fill's read of it already ran (slowAdapter captures the disk
    // snapshot at call time, then delays only the return), before the fill becomes ready: only
    // the post-fill settling reconcile can pick this up.
    await h.runtime.adapter.write('existing.md', '---\nv: 2\n---\nnew');
    await h.runtime.indexReady;
    expect(h.runtime.index.get('existing.md')?.frontmatter).toMatchObject({ v: 2 });
  });

  it('a fill that throws: gated tools answer a clear error, forever', async () => {
    h = await startHarness(undefined, null, await seededRoot(), {
      deferIndex: true,
      createAdapter: brokenAdapter(),
    });
    await h.runtime.indexReady;
    expect(h.runtime.indexState().error).toBe(true);
    const r = await h.call('vault_query', {});
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg.toLowerCase()).toContain('index');
  });
});
