import path from 'node:path';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import {
  DEFAULT_RECONCILE_MIN_GAP_MS,
  DEFAULT_RECONCILE_MS,
  INDEX_WAIT_MS,
  MAX_BINARY_BYTES,
  MAX_INDEX_BYTES,
} from '../storage/limits.ts';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import { WriteGate } from '../storage/write-gate.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import {
  FrontmatterIndex,
  type IndexBudgetState,
  type ReconcileResult,
} from './frontmatter-index.ts';
import { VaultGraph } from './graph.ts';

export interface VaultSettings {
  dailyNotes: DailyNoteSettings;
  requiredFrontmatter: string[];
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  dailyNotes: DEFAULT_DAILY_NOTE_SETTINGS,
  requiredFrontmatter: [],
};

/** Progress of a (possibly still in-flight) index build. `done`/`total` count markdown notes.
 *  `error: true` means the background fill threw; the index is not, and will not become, ready —
 *  a fresh runtime is the only way out. Omitted (not `false`) when nothing has failed. */
export interface IndexState {
  ready: boolean;
  done: number;
  total: number;
  error?: boolean;
}

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
  /** Current index-build progress. Without `deferIndex` this is always `{ ready: true, done,
   *  total }` (the index was built before `createLocalRuntime` returned). */
  indexState(): IndexState;
  /**
   * Settles once the background fill (and its one settling reconcile — see `deferIndex`) has
   * finished, successfully or not; check `indexState().error` to tell which. Never rejects, so it
   * is safe to leave un-awaited without risking an unhandled rejection. Already resolved when
   * `deferIndex` was not requested.
   */
  indexReady: Promise<void>;
  /** How long a gated tool call (see `registerVaultTools`) waits for `indexReady` before giving
   *  up and answering the "still building" error. Defaults to `INDEX_WAIT_MS`. */
  indexWaitMs: number;
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
  /** Serialized size of the index above which `onIndexOverBudget` is called; defaults to
   *  MAX_INDEX_BYTES. A warning line, not a limit: see FrontmatterIndex.watchBudget. */
  indexBudgetBytes?: number;
  /** Called once when the index is over its budget: at boot if it already is, otherwise on the
   *  change that crosses the line (and again only after it has been back under). */
  onIndexOverBudget?: (state: IndexBudgetState) => void;
  /** How the storage adapter is made; tests inject one whose watcher they can make fail. */
  createAdapter?: typeof LocalFSAdapter.create;
  /** Minimum distance between reconciles triggered by watcher errors; defaults to
   *  DEFAULT_RECONCILE_MIN_GAP_MS. Tests shorten it. */
  reconcileMinGapMs?: number;
  /**
   * Return at once with an empty index that fills in the background (`indexState()`/
   * `indexReady`), instead of blocking until the whole vault is read. For a client that starts
   * the server per session (the stdio entrypoint) and cannot wait the tens of seconds a large
   * vault's index build takes for `initialize`. The watcher and the background reconcile timer
   * start only once the fill has finished (an event handled mid-fill could be overwritten by the
   * fill's own, older read), followed by one reconcile pass to catch whatever changed on disk
   * while the fill was running.
   */
  deferIndex?: boolean;
  /** Called if a deferred fill throws (`indexState().error` becomes `true`). Gets the raw error
   *  (unlike `onReconcileError`, nothing here is on a path that logs an absolute file path by
   *  default) — callers decide whether and how to log it. Never left unhandled either way:
   *  `indexReady` itself never rejects. */
  onIndexError?: (error: unknown) => void;
  /** Overrides `INDEX_WAIT_MS` for this runtime (see `VaultRuntime.indexWaitMs`); tests shorten it
   *  to see the "still building" error without a real 45 s wait. */
  indexWaitMs?: number;
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

  const deferIndex = opts.deferIndex ?? false;
  const index = deferIndex ? FrontmatterIndex.empty() : await FrontmatterIndex.build(adapter);

  // Only meaningful while deferIndex is filling; indexState() ignores them once built (it reports
  // index.size() live instead, so it stays right even as the watcher adds notes afterward).
  let fillDone = 0;
  let fillTotal = 0;
  let built = !deferIndex;
  let buildFailed = false;

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

  /** Returns the pass's own promise (not just fire-and-forget) so a caller — the post-fill
   *  settling pass below — can await exactly this one pass finishing. */
  const startPass = (): Promise<void> => {
    lastPass = Date.now();
    const pass = index
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
    inFlight = pass;
    return pass;
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

  const reconcileMs = opts.reconcileMs ?? DEFAULT_RECONCILE_MS;
  let detach: Unsubscribe = () => {};
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;

  /** Starts watching for changes and the reconcile timer. Called once, either right away (the
   *  usual, non-deferred boot) or — with `deferIndex` — only after the fill has finished, so an
   *  event handled mid-fill can never be overwritten by the fill's own, older read of that file. */
  const startWatching = (): void => {
    index.watchBudget(opts.indexBudgetBytes ?? MAX_INDEX_BYTES, opts.onIndexOverBudget);
    detach = index.attach(adapter, requestPass);
    reconcileTimer = reconcileMs > 0 ? setInterval(onTick, reconcileMs) : null;
    reconcileTimer?.unref();
  };

  let fillPromise: Promise<void>;
  if (deferIndex) {
    fillPromise = (async () => {
      try {
        await index.fill(adapter, (progress) => {
          fillDone = progress.done;
          fillTotal = progress.total;
        });
        if (closed) return; // close() ran mid-fill: never start a watcher behind its back
        startWatching();
        await startPass(); // the one settling pass: catches whatever changed on disk during the fill
        built = true;
      } catch (error) {
        buildFailed = true;
        try {
          opts.onIndexError?.(error);
        } catch {
          /* a reporting callback must not turn this into an unhandled rejection */
        }
      }
    })();
  } else {
    startWatching();
    fillPromise = Promise.resolve();
  }

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
    indexState(): IndexState {
      if (built) return { ready: true, done: index.size(), total: index.size() };
      return {
        ready: false,
        done: fillDone,
        total: fillTotal,
        ...(buildFailed ? { error: true } : {}),
      };
    },
    indexReady: fillPromise,
    indexWaitMs: opts.indexWaitMs ?? INDEX_WAIT_MS,
    async close() {
      closed = true;
      await fillPromise; // a fill in flight finishes (and, per its own check above, never starts
      // the watcher afterwards) before tearing anything down
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (trailing) clearTimeout(trailing);
      detach();
      await inFlight; // a reconcile pass in flight finishes before the caller tears the vault down
    },
  };
}
