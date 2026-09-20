import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import type { ReconcileResult } from '../../src/vault/frontmatter-index.ts';
import { createLocalRuntime, DEFAULT_VAULT_SETTINGS } from '../../src/vault/runtime.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-runtime-'));
  await fs.writeFile(path.join(root, 'seed.md'), '---\ntype: seed\n---\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createLocalRuntime', () => {
  it('builds adapter + index with defaults and closes cleanly', async () => {
    const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
    expect(runtime.adapter.capabilities().watch).toBe(true);
    expect(runtime.index.get('seed.md')?.frontmatter).toEqual({ type: 'seed' });
    expect(runtime.settings).toEqual(DEFAULT_VAULT_SETTINGS);
    expect(runtime.settings.dailyNotes.format).toBe('yyyy-MM-dd');
    expect(runtime.now()).toBeInstanceOf(Date);
    expect(runtime.caches).toEqual({});
    await runtime.close();
  });

  it('applies partial settings overrides deeply', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      settings: {
        dailyNotes: { folder: 'journal', timezone: 'Europe/Chisinau' } as never,
        requiredFrontmatter: ['type'],
      },
    });
    expect(runtime.settings.dailyNotes).toEqual({
      folder: 'journal',
      format: 'yyyy-MM-dd',
      template: null,
      timezone: 'Europe/Chisinau',
    });
    expect(runtime.settings.requiredFrontmatter).toEqual(['type']);
    await runtime.close();
  });
});

/** A real adapter whose watcher error callback the test can fire: injected, nothing is patched. */
function adapterWithWatcherErrors(): {
  createAdapter: typeof LocalFSAdapter.create;
  fail: (error: unknown) => void;
} {
  let onWatcherError: ((error: unknown) => void) | undefined;
  return {
    createAdapter: async (...args) => {
      const adapter = await LocalFSAdapter.create(...args);
      const watch = adapter.watch.bind(adapter);
      adapter.watch = (onChange, onError) => {
        onWatcherError = onError;
        return watch(onChange, onError);
      };
      return adapter;
    },
    fail: (error) => onWatcherError?.(error),
  };
}

describe('background reconcile', () => {
  async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it('runs on a timer and reports through onReconcile', async () => {
    const calls: ReconcileResult[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 30,
      onReconcile: (r) => calls.push(r),
    });
    try {
      await waitFor(() => calls.length >= 2);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(runtime.index.reconciledAt).toBeInstanceOf(Date);
    } finally {
      await runtime.close();
    }
  });

  it('reconcileMs: 0 disables the timer', async () => {
    const calls: ReconcileResult[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      onReconcile: (r) => calls.push(r),
    });
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(calls).toEqual([]);
      expect(runtime.index.reconciledAt).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('close() stops the timer — no further reconciles after closing', async () => {
    const calls: ReconcileResult[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 30,
      onReconcile: (r) => calls.push(r),
    });
    await waitFor(() => calls.length >= 1);
    await runtime.close();
    const countAtClose = calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.length).toBe(countAtClose);
  });

  it('never runs two passes at once: a tick during a pass is skipped', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 15,
    });
    try {
      let inFlight = 0;
      let peakInFlight = 0;
      let calls = 0;
      const original = runtime.index.reconcile.bind(runtime.index);
      runtime.index.reconcile = (async (adapter) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        calls += 1;
        await new Promise((r) => setTimeout(r, 100));
        try {
          return await original(adapter);
        } finally {
          inFlight -= 1;
        }
      }) as typeof runtime.index.reconcile;

      await waitFor(() => calls >= 2, 2000);
      expect(peakInFlight).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('a storm of watcher errors costs at most two passes, and close() waits for the one in flight', async () => {
    const watcher = adapterWithWatcherErrors();
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0,
      createAdapter: watcher.createAdapter,
    });
    let started = 0;
    let finished = 0;
    const original = runtime.index.reconcile.bind(runtime.index);
    runtime.index.reconcile = (async (adapter) => {
      started += 1;
      await new Promise((r) => setTimeout(r, 60));
      const result = await original(adapter);
      finished += 1;
      return result;
    }) as typeof runtime.index.reconcile;
    for (let i = 0; i < 25; i += 1) watcher.fail(new Error('no space left on device'));
    await waitFor(() => started >= 1);
    await runtime.close();
    expect(finished).toBe(started); // nothing was left running behind close()
    expect(started).toBeLessThanOrEqual(2);
    const atClose = started;
    watcher.fail(new Error('late'));
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toBe(atClose);
  });

  it('a watcher error inside the gap is answered by one trailing pass, never dropped', async () => {
    const watcher = adapterWithWatcherErrors();
    const calls: ReconcileResult[] = [];
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0, // no timer to rescue a lost trigger
      reconcileMinGapMs: 300,
      createAdapter: watcher.createAdapter,
      onReconcile: (r) => calls.push(r),
    });
    try {
      watcher.fail(new Error('overflow'));
      await waitFor(() => calls.length === 1);
      // events were lost AFTER that pass took its listing: this one must still be answered
      watcher.fail(new Error('overflow again'));
      watcher.fail(new Error('and again'));
      expect(calls.length).toBe(1);
      await waitFor(() => calls.length >= 2);
      expect(calls.length).toBe(2);
      await new Promise((r) => setTimeout(r, 400));
      expect(calls.length).toBe(2); // one trailing pass for the burst, not one per error
    } finally {
      await runtime.close();
    }
  });

  it('a reporting callback that throws does not turn a good pass into a failed one', async () => {
    let failures = 0;
    let reports = 0;
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 20,
      onReconcile: () => {
        reports += 1;
        throw new Error('logger down');
      },
      onReconcileError: () => {
        failures += 1;
      },
    });
    try {
      await waitFor(() => reports >= 2);
      expect(failures).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('a failing pass is reported without the error and does not stop the timer', async () => {
    let failures = 0;
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 20,
      onReconcileError: (...args: unknown[]) => {
        expect(args).toEqual([]); // an fs error carries an absolute path: it never reaches a logger
        failures += 1;
      },
    });
    try {
      runtime.index.reconcile = (async () => {
        throw new Error("ENOENT: no such file or directory, stat '/abs/secret/path.md'");
      }) as typeof runtime.index.reconcile;
      await waitFor(() => failures >= 2);
      expect(failures).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.close();
    }
  });

  it('triggers one reconcile when the adapter watcher reports an error', async () => {
    const watcher = adapterWithWatcherErrors();
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      reconcileMs: 0, // isolate the watcher-error trigger from the timer
      createAdapter: watcher.createAdapter,
    });
    try {
      expect(runtime.index.reconciledAt).toBeNull();
      watcher.fail(new Error('simulated watcher overflow'));
      await waitFor(() => runtime.index.reconciledAt !== null);
      expect(runtime.index.reconciledAt).toBeInstanceOf(Date);
    } finally {
      await runtime.close();
    }
  });
});
