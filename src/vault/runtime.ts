import path from 'node:path';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import {
  DEFAULT_RECONCILE_MIN_GAP_MS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_SETTLE_RETRY_MS,
  INDEX_CACHE_DEAD_CLIENT_SKIP_NOTES,
  INDEX_CACHE_HOURLY_SAVE_MS,
  INDEX_CACHE_RACY_RESAVE_MS,
  INDEX_CACHE_SHUTDOWN_SAVE_BUDGET_MS,
  INDEX_CACHE_STALE_FRACTION,
  INDEX_WAIT_MS,
  MAX_BINARY_BYTES,
  MAX_INDEX_BYTES,
} from '../storage/limits.ts';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import { WriteGate } from '../storage/write-gate.ts';
import { CallTracker } from '../tools/call-tracker.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import {
  FrontmatterIndex,
  type IndexBudgetState,
  type IndexEntry,
  type ReconcileResult,
} from './frontmatter-index.ts';
import { VaultGraph } from './graph.ts';

/**
 * The machine-local index cache (stdio only — see `src/storage/local-cache.ts` and
 * `src/stdio-main.ts`, the only caller that constructs one). Kept deliberately free of any path
 * or environment logic: `runtime.ts` only loads, upserts and saves through this interface.
 */
export interface IndexCacheOption {
  load(): Promise<{
    entries: Map<string, IndexEntry> | null;
    rejected?: string;
    /** F4: lines dropped while loading (any reason) — surfaced verbatim in `IndexCacheStats`. */
    skipped: number;
  }>;
  save(
    entries: Iterable<IndexEntry>,
    count: number,
    opts?: { budgetMs?: number },
  ): Promise<{ ok: boolean; reason?: string; durationMs: number; racySkipped?: number }>;
}

/** `brainstem_ping`'s `index.cache` field (stdio only) — the numbers of THIS boot. */
export interface IndexCacheStats {
  used: boolean;
  entriesFromCache: number;
  entriesRead: number;
  /** F4: cache lines dropped at load (malformed JSON, wrong shape, a truncated last line, or one
   *  over the byte cap) — 0 when no cache was found at all, not just when nothing was dropped. */
  skipped: number;
  /** Set only when a cache was found but thrown out whole (bad schema, wrong vault, corrupt
   *  header) — never set when there was simply no cache yet. */
  rejected?: string;
}

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
  /** Notes the fill could not read (no permission, a lock held by another program, not UTF-8): not counted in `done`. */
  unreadable?: number;
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
  /** The tool calls running right now: a stopping server drains it before closing anything. */
  calls: CallTracker;
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
  /** THIS boot's use of the machine-local index cache (stdio only); undefined when no
   *  `indexCache` option was given (the HTTP server, or a `deferIndex: false` boot). */
  indexCacheStats(): IndexCacheStats | undefined;
  /** `reason: 'client-dead'` (the stdio entrypoint's abrupt-disconnect shutdown routes — a broken
   *  pipe, a destroyed stdout, stdin closing without an 'end') lets the index-cache save skip
   *  itself for a large index instead of spending the shutdown window on a write nobody is
   *  waiting for; omitted or `'normal'` (an orderly stop: stdin ending, SIGTERM/SIGINT) always
   *  attempts it. Has no effect without an `indexCache` option. */
  close(opts?: { reason?: 'normal' | 'client-dead' }): Promise<void>;
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
  /** Pauses between attempts of the settling pass that follows a deferred fill; when they run
   *  out the index is in error. Defaults to DEFAULT_SETTLE_RETRY_MS. Tests shorten it. */
  settleRetryMs?: number[];
  /** Called if a deferred fill throws (`indexState().error` becomes `true`). Gets the raw error
   *  (unlike `onReconcileError`, nothing here is on a path that logs an absolute file path by
   *  default) — callers decide whether and how to log it. Never left unhandled either way:
   *  `indexReady` itself never rejects. */
  onIndexError?: (error: unknown) => void;
  /** Overrides `INDEX_WAIT_MS` for this runtime (see `VaultRuntime.indexWaitMs`); tests shorten it
   *  to see the "still building" error without a real 45 s wait. */
  indexWaitMs?: number;
  /** Machine-local cache of the frontmatter index (stdio only — `src/storage/local-cache.ts` via
   *  `src/stdio-main.ts`); undefined disables it. Only meaningful together with `deferIndex: true`
   *  — the non-deferred (HTTP) boot never looks at it. */
  indexCache?: IndexCacheOption;
  /** Called after a successful index-cache save, from any of its three triggers (post-fill,
   *  hourly, on close). Logging only, like `onReconcile`. */
  /** F3: `racySkipped` is how many entries were left out of this save for looking "racily clean"
   *  (see `INDEX_CACHE_RACY_WINDOW_MS`'s doc comment in `src/storage/local-cache.ts`) — a debug
   *  signal, not a warning: those paths are simply read from disk again next boot. */
  onIndexCacheSaved?: (info: { durationMs: number; count: number; racySkipped: number }) => void;
  /** Called when an index-cache save failed or was abandoned (its own time budget, or a write
   *  error) — never thrown. Logging only, like `onReconcileError`. */
  onIndexCacheSaveError?: (reason: string) => void;
  /** Overrides INDEX_CACHE_STALE_FRACTION; tests shrink or grow it. */
  indexCacheStaleFraction?: number;
  /** Overrides INDEX_CACHE_HOURLY_SAVE_MS; tests shorten it. 0 disables the hourly timer. */
  indexCacheSaveIntervalMs?: number;
  /** Overrides INDEX_CACHE_RACY_RESAVE_MS: how long after a save that left racy entries out the
   *  one follow-up save runs; tests shorten it. */
  indexCacheRacyResaveMs?: number;
  /** Overrides INDEX_CACHE_SHUTDOWN_SAVE_BUDGET_MS for the save `close()` attempts; tests
   *  shorten it to exercise abandonment without a real 5 s wait. */
  indexCacheShutdownBudgetMs?: number;
  /** Overrides INDEX_CACHE_DEAD_CLIENT_SKIP_NOTES; tests shrink it. */
  indexCacheDeadClientSkipNotes?: number;
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
  let lastPassOk = false;

  // Index-cache bookkeeping (stdio only — see IndexCacheOption); all stay at their defaults when
  // opts.indexCache is undefined, and indexCacheStats() then reports undefined, not these zeros.
  let cacheUsed = false;
  let cacheEntriesFromCache = 0;
  let cacheEntriesRead = 0;
  let cacheSkipped = 0;
  let cacheRejected: string | undefined;
  let lastSavedCacheVersion = 0;
  let cacheHourlyTimer: ReturnType<typeof setInterval> | null = null;
  let racyResaveTimer: ReturnType<typeof setTimeout> | null = null;

  const runIndexCacheSave = async (
    budgetMs?: number,
  ): Promise<{ ok: boolean; reason?: string }> => {
    if (!opts.indexCache) return { ok: false, reason: 'no index cache configured' };
    const versionAtStart = index.version;
    const result = await opts.indexCache.save(index.all(), index.size(), { budgetMs });
    if (result.ok) {
      lastSavedCacheVersion = versionAtStart;
      // Entries modified just before the save are left out of the cache on purpose (the "racily
      // clean" rule in local-cache.ts). After a fresh import that is EVERY entry: measured, each
      // restart inside the window re-read the whole vault and saved an empty cache again. So a
      // save that left some out is repeated, once, when their window has passed.
      if (racyResaveTimer) clearTimeout(racyResaveTimer);
      racyResaveTimer = null;
      if ((result.racySkipped ?? 0) > 0 && !closed) {
        racyResaveTimer = setTimeout(() => {
          racyResaveTimer = null;
          if (!closed) void runIndexCacheSave();
        }, opts.indexCacheRacyResaveMs ?? INDEX_CACHE_RACY_RESAVE_MS);
        racyResaveTimer.unref();
      }
      try {
        opts.onIndexCacheSaved?.({
          durationMs: result.durationMs,
          count: index.size(),
          racySkipped: result.racySkipped ?? 0,
        });
      } catch {
        /* logging must not break the caller */
      }
    } else {
      try {
        opts.onIndexCacheSaveError?.(result.reason ?? 'index-cache save failed');
      } catch {
        /* logging must not break the caller */
      }
    }
    return result;
  };

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
          lastPassOk = true;
          try {
            opts.onReconcile?.(result);
          } catch {
            /* a reporting callback must not turn a good pass into a failed one */
          }
        },
        () => {
          lastPassOk = false;
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
    const retryMs = opts.settleRetryMs ?? DEFAULT_SETTLE_RETRY_MS;
    /** Interruptible: `close()` must not wait out a backoff. */
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const step = Math.min(ms, 50);
        const started = Date.now();
        const tick = (): void => {
          if (closed || Date.now() - started >= ms) resolve();
          else setTimeout(tick, step);
        };
        tick();
      });
    fillPromise = (async () => {
      try {
        let cachedEntries: Map<string, IndexEntry> | undefined;
        if (opts.indexCache) {
          const loaded = await opts.indexCache.load();
          if (loaded.entries) {
            cachedEntries = loaded.entries;
            cacheUsed = true;
          }
          cacheSkipped = loaded.skipped;
          if (loaded.rejected) cacheRejected = loaded.rejected;
        }
        const filled = await index.fill(
          adapter,
          (progress) => {
            fillDone = progress.done;
            fillTotal = progress.total;
          },
          () => closed,
          cachedEntries,
        );
        cacheEntriesFromCache = filled.fromCache;
        cacheEntriesRead = filled.fromDisk;
        // close() ran mid-fill: the fill stopped between batches; stopping is not failing, and a
        // watcher is never started behind a closed runtime's back.
        if (closed || filled.stopped) return;
        startWatching();
        // The index is READY only once a pass over the disk has SUCCEEDED: that pass is what
        // catches a note created, changed or removed while the fill ran. A pass that failed
        // (proved: a folder unreadable for a moment) used to flip `ready` all the same, and a
        // count stayed wrong until the next timer pass, five minutes later.
        for (let attempt = 0; ; attempt += 1) {
          await startPass();
          if (lastPassOk) break;
          const wait = retryMs[attempt];
          if (closed) return;
          if (wait === undefined)
            throw new Error('the index could not be checked against the disk');
          await pause(wait);
          if (closed) return;
        }
        built = true;

        if (opts.indexCache) {
          // Never save an index that is not ready — built is true only from this point on, and
          // the catch block below (a failed build) never reaches here at all.
          const total = filled.fromCache + filled.fromDisk;
          const staleFraction = total > 0 ? filled.fromDisk / total : 0;
          const staleLimit = opts.indexCacheStaleFraction ?? INDEX_CACHE_STALE_FRACTION;
          if (!cacheUsed || staleFraction > staleLimit) {
            await runIndexCacheSave();
          } else {
            // The cache was already accurate enough that rewriting it now would buy nothing —
            // but it still reflects the disk as of this boot, so later saves compare against it.
            lastSavedCacheVersion = index.version;
          }
          if (!closed) {
            const intervalMs = opts.indexCacheSaveIntervalMs ?? INDEX_CACHE_HOURLY_SAVE_MS;
            if (intervalMs > 0) {
              cacheHourlyTimer = setInterval(() => {
                if (closed || index.version === lastSavedCacheVersion) return;
                void runIndexCacheSave();
              }, intervalMs);
              cacheHourlyTimer.unref();
            }
          }
        }
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
    calls: new CallTracker(),
    maxBinaryBytes,
    paths: { vaultRoot: adapter.root, stateDir },
    indexState(): IndexState {
      if (built) {
        // live figures: a note that becomes readable again stops being counted at the next pass
        const unreadable = index.unreadableCount();
        return {
          ready: true,
          done: index.size(),
          total: index.knownNoteCount(),
          ...(unreadable > 0 ? { unreadable } : {}),
        };
      }
      return {
        ready: false,
        done: fillDone,
        total: fillTotal,
        ...(buildFailed ? { error: true } : {}),
        ...(index.unreadableCount() > 0 ? { unreadable: index.unreadableCount() } : {}),
      };
    },
    indexReady: fillPromise,
    indexWaitMs: opts.indexWaitMs ?? INDEX_WAIT_MS,
    indexCacheStats(): IndexCacheStats | undefined {
      if (!opts.indexCache) return undefined;
      return {
        used: cacheUsed,
        entriesFromCache: cacheEntriesFromCache,
        entriesRead: cacheEntriesRead,
        skipped: cacheSkipped,
        ...(cacheRejected !== undefined ? { rejected: cacheRejected } : {}),
      };
    },
    async close(closeOpts) {
      closed = true;
      await fillPromise; // a fill in flight finishes (and, per its own check above, never starts
      // the watcher afterwards) before tearing anything down
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (trailing) clearTimeout(trailing);
      if (cacheHourlyTimer) clearInterval(cacheHourlyTimer);
      if (racyResaveTimer) clearTimeout(racyResaveTimer);
      detach();
      await inFlight; // a reconcile pass in flight finishes before the caller tears the vault down

      // A last save on the way out, only when there is something new to save: never an index
      // that is not ready, never after a failed build, never a second write of what the hourly
      // timer or the post-fill save already wrote.
      if (
        deferIndex &&
        opts.indexCache &&
        built &&
        !buildFailed &&
        index.version !== lastSavedCacheVersion
      ) {
        const deadClient = closeOpts?.reason === 'client-dead';
        const skipThreshold =
          opts.indexCacheDeadClientSkipNotes ?? INDEX_CACHE_DEAD_CLIENT_SKIP_NOTES;
        const skip = deadClient && index.size() > skipThreshold;
        if (!skip) {
          const budgetMs = opts.indexCacheShutdownBudgetMs ?? INDEX_CACHE_SHUTDOWN_SAVE_BUDGET_MS;
          await runIndexCacheSave(budgetMs);
        }
      }
    },
  };
}
