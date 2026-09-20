import path from 'node:path';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import {
  DEFAULT_RECONCILE_MIN_GAP_MS,
  DEFAULT_RECONCILE_MS,
  MAX_BINARY_BYTES,
} from '../storage/limits.ts';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import { WriteGate } from '../storage/write-gate.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import { FrontmatterIndex, type ReconcileResult } from './frontmatter-index.ts';
import { VaultGraph } from './graph.ts';

export interface VaultSettings {
  dailyNotes: DailyNoteSettings;
  requiredFrontmatter: string[];
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  dailyNotes: DEFAULT_DAILY_NOTE_SETTINGS,
  requiredFrontmatter: [],
};

export interface VaultRuntime {
  adapter: StorageAdapter;
  index: FrontmatterIndex;
  graph: VaultGraph;
  settings: VaultSettings;
  now: () => Date;
  caches: { analytics?: { at: number; report: AnalyticsReport } };
  /** Keyed write lock every mutating tool call runs inside (see src/storage/write-gate.ts). */
  gate: WriteGate;
  /** The cap actually given to the adapter's writeBinary (see MAX_BINARY_BYTES); exposed here so
   *  tool descriptions (vault_write_binary) can state the real configured limit. */
  maxBinaryBytes: number;
  /**
   * Absolute filesystem paths the vault tools need outside the adapter's reach: `vaultRoot` for
   * raw byte copies (transaction pre-images), `stateDir` for the reserved `_brainstem/` folder
   * the adapter deliberately refuses to touch.
   */
  paths: { vaultRoot: string; stateDir: string };
  close(): Promise<void>;
}

export type RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>;

export interface LocalRuntimeOptions {
  vaultPath: string;
  settings?: { dailyNotes?: Partial<DailyNoteSettings>; requiredFrontmatter?: string[] };
  ripgrepPath?: string | null;
  watchPollMs?: number | null;
  /** Defaults to `<vaultRoot>/_brainstem`. */
  stateDir?: string;
  now?: () => Date;
  /** Cap for writeBinary (attachments); defaults to MAX_BINARY_BYTES. */
  maxBinaryBytes?: number;
  /** How often to run FrontmatterIndex.reconcile() in the background, so a watcher event the OS
   *  dropped (inotify queue overflow, an external tool rewriting thousands of files) never leaves
   *  the index stale forever. Defaults to DEFAULT_RECONCILE_MS (5 min); 0 disables the timer. A
   *  reconcile also runs once whenever the adapter's watcher reports an error. */
  reconcileMs?: number;
  /** Called after every completed background reconcile (timer tick or watcher-error trigger) —
   *  never for a tick skipped because the previous one was still running. Callers decide whether
   *  and how to log it; runtime.ts stays logger-agnostic like the rest of vault/. */
  onReconcile?: (result: ReconcileResult) => void;
  /** Called when a background reconcile pass failed. It gets no error on purpose (an fs error
   *  carries an absolute path); log that it happened, `brainstem_ping` shows `reconciledAt` stall. */
  onReconcileError?: () => void;
  /** Minimum distance between reconciles triggered by watcher errors; defaults to
   *  DEFAULT_RECONCILE_MIN_GAP_MS. Tests shorten it. */
  reconcileMinGapMs?: number;
}

export function mergeSettings(overrides: LocalRuntimeOptions['settings']): VaultSettings {
  return {
    dailyNotes: { ...DEFAULT_DAILY_NOTE_SETTINGS, ...(overrides?.dailyNotes ?? {}) },
    requiredFrontmatter: overrides?.requiredFrontmatter ?? [],
  };
}

export async function createLocalRuntime(opts: LocalRuntimeOptions): Promise<VaultRuntime> {
  const maxBinaryBytes = opts.maxBinaryBytes ?? MAX_BINARY_BYTES;
  const adapter = await LocalFSAdapter.create(opts.vaultPath, {
    ripgrepPath: opts.ripgrepPath,
    watchPollMs: opts.watchPollMs ?? null,
    maxBinaryBytes,
  });
  const index = await FrontmatterIndex.build(adapter);

  // One reconcile at a time, shared by the timer and the watcher-error trigger. A trigger that
  // arrives while a pass is running is remembered, not dropped: it means events were lost after
  // that pass took its listing, so one more pass runs when the current one ends. Error-triggered
  // passes keep a minimum distance, because a watcher that cannot watch reports once per folder.
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let closed = false;
  let lastStart = 0;
  const minGapMs = opts.reconcileMinGapMs ?? DEFAULT_RECONCILE_MIN_GAP_MS;
  const runReconcile = (): void => {
    if (closed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    lastStart = Date.now();
    inFlight = index
      .reconcile(adapter)
      .then((result) => opts.onReconcile?.(result))
      .catch(() => {
        // Never the error itself: it can carry an absolute path. A failed pass must not kill
        // the timer or the watcher-error handler either.
        try {
          opts.onReconcileError?.();
        } catch {
          /* a logging callback must not break the loop */
        }
      })
      .finally(() => {
        inFlight = null;
        if (pending && !closed) {
          pending = false;
          runReconcile();
        }
      });
  };
  const onWatcherError = (): void => {
    if (Date.now() - lastStart < minGapMs) {
      if (inFlight) pending = true;
      return;
    }
    runReconcile();
  };

  const detach: Unsubscribe = index.attach(adapter, onWatcherError);

  const reconcileMs = opts.reconcileMs ?? DEFAULT_RECONCILE_MS;
  const reconcileTimer = reconcileMs > 0 ? setInterval(runReconcile, reconcileMs) : null;
  reconcileTimer?.unref();

  // adapter.root is the realpath'd vault root, so pre-image copies and the adapter always agree
  // on where a vault-relative path actually lives.
  const stateDir = opts.stateDir ?? path.join(adapter.root, RESERVED_DIR);
  return {
    adapter,
    index,
    graph: new VaultGraph(index),
    settings: mergeSettings(opts.settings),
    now: opts.now ?? (() => new Date()),
    caches: {},
    gate: new WriteGate(),
    maxBinaryBytes,
    paths: { vaultRoot: adapter.root, stateDir },
    async close() {
      closed = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      detach();
      await inFlight; // a pass in flight finishes before the caller tears the vault down
    },
  };
}
