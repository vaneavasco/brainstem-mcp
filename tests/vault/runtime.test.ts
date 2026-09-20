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

  it('skips a tick while the previous reconcile is still running', async () => {
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

  it('triggers one reconcile when the adapter watcher reports an error', async () => {
    let capturedOnError: ((error: unknown) => void) | undefined;
    const originalWatch = LocalFSAdapter.prototype.watch;
    LocalFSAdapter.prototype.watch = function (
      this: LocalFSAdapter,
      onChange: Parameters<typeof originalWatch>[0],
      onError?: Parameters<typeof originalWatch>[1],
    ) {
      capturedOnError = onError;
      return originalWatch.call(this, onChange, onError);
    };
    try {
      const runtime = await createLocalRuntime({
        vaultPath: root,
        ripgrepPath: null,
        reconcileMs: 0, // isolate the watcher-error trigger from the timer
      });
      try {
        expect(runtime.index.reconciledAt).toBeNull();
        expect(capturedOnError).toBeTypeOf('function');
        capturedOnError?.(new Error('simulated watcher overflow'));
        await waitFor(() => runtime.index.reconciledAt !== null);
        expect(runtime.index.reconciledAt).toBeInstanceOf(Date);
      } finally {
        await runtime.close();
      }
    } finally {
      LocalFSAdapter.prototype.watch = originalWatch;
    }
  });
});
