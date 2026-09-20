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
  /** Called after every completed background reconcile (timer tick or watcher-error trigger).
   *  Callers decide whether and how to log it; runtime.ts stays logger-agnostic like the rest of
   *  vault/. */
  onReconcile?: (result: ReconcileResult) => void;
  /** Called when a background reconcile pass failed. It gets no error on purpose (an fs error
   *  carries an absolute path); log that it happened, `brainstem_ping` shows `reconciledAt` stall. */
  onReconcileError?: () => void;
  /** How the storage adapter is made; tests inject one whose watcher they can make fail. */
  createAdapter?: typeof LocalFSAdapter.create;
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
  const adapter = await (opts.createAdapter ?? LocalFSAdapter.create.bind(LocalFSAdapter))(
    opts.vaultPath,
    { ripgrepPath: opts.ripgrepPath, watchPollMs: opts.watchPollMs ?? null, maxBinaryBytes },
  );
  const index = await FrontmatterIndex.build(adapter);

  // One reconcile at a time. The timer simply skips a tick while a pass runs (the next tick is
  // soon enough). A watcher error is different: it means events were lost, so it is never
  // dropped. During a pass it is remembered and answered by one more pass; within `minGapMs` of
  // the last pass it is answered by one trailing pass when the gap ends, because a watcher that
  // cannot watch reports once per folder and each pass lists the whole vault.
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let closed = false;
  let lastPass = 0; // when the last pass started, then when it ended: the gap counts from its end
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const minGapMs = opts.reconcileMinGapMs ?? DEFAULT_RECONCILE_MIN_GAP_MS;

  const startPass = (): void => {
    lastPass = Date.now();
    inFlight = index
      .reconcile(adapter)
      .then(
        (result) => {
          try {
            opts.onReconcile?.(result);
          } catch {
            /* a reporting callback must not turn a good pass into a failed one */
          }
        },
        () => {
          // Never the error itself: it can carry an absolute path.
          try {
            opts.onReconcileError?.();
          } catch {
            /* nor break the loop */
          }
        },
      )
      .finally(() => {
        inFlight = null;
        lastPass = Date.now();
        if (pending) {
          pending = false;
          requestPass();
        }
      });
  };

  /** A trigger that must not be lost, answered as soon as the gap allows. */
  const requestPass = (): void => {
    if (closed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    const wait = minGapMs - (Date.now() - lastPass);
    if (wait <= 0) {
      startPass();
    } else if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        requestPass();
      }, wait);
      trailing.unref();
    }
  };

  const onTick = (): void => {
    if (!closed && !inFlight) startPass();
  };

  const detach: Unsubscribe = index.attach(adapter, requestPass);

  const reconcileMs = opts.reconcileMs ?? DEFAULT_RECONCILE_MS;
  const reconcileTimer = reconcileMs > 0 ? setInterval(onTick, reconcileMs) : null;
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
      if (trailing) clearTimeout(trailing);
      detach();
      await inFlight; // a pass in flight finishes before the caller tears the vault down
    },
  };
}
