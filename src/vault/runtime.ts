import path from 'node:path';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { MAX_BINARY_BYTES } from '../storage/limits.ts';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import { WriteGate } from '../storage/write-gate.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import { FrontmatterIndex, type ReconcileResult } from './frontmatter-index.ts';
import { VaultGraph } from './graph.ts';

/** Default interval for the background FrontmatterIndex.reconcile() sweep (see
 *  LocalRuntimeOptions.reconcileMs); mirrored by VAULT_RECONCILE_MS's default in src/config.ts. */
export const DEFAULT_RECONCILE_MS = 300_000;

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

  // Shared by the timer and the watcher-error trigger below, so the two can never run a
  // reconcile concurrently: a tick that arrives while one is already in flight is skipped
  // outright rather than queued.
  let reconciling = false;
  const runReconcile = (): void => {
    if (reconciling) return;
    reconciling = true;
    void index
      .reconcile(adapter)
      .then((result) => opts.onReconcile?.(result))
      .catch(() => {
        /* a failed reconcile pass must never kill the timer or the watcher-error handler */
      })
      .finally(() => {
        reconciling = false;
      });
  };

  const detach: Unsubscribe = index.attach(adapter, runReconcile);

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
      if (reconcileTimer) clearInterval(reconcileTimer);
      detach();
    },
  };
}
