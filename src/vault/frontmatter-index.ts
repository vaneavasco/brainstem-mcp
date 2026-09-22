import { MAX_BATCH, MAX_INDEX_BYTES } from '../storage/limits.ts';
import { isMarkdownPath, isReservedPath } from '../storage/path-policy.ts';
import { type Note, type StorageAdapter, type Unsubscribe, VaultError } from '../storage/types.ts';
import {
  type BlockId,
  type Heading,
  type LinkRef,
  linkAwareEquals,
  parseNote,
} from './note-parse.ts';

/**
 * Bump this whenever `IndexEntry`'s shape, or how `fromNote` derives it, changes — it is the
 * schema number embedded in the machine-local index cache's file name and header
 * (`src/storage/local-cache.ts`, `index-v<N>.ndjson`). A cache written under the old number is
 * never read back once this changes (the loader rejects a schema mismatch outright), so a stale
 * shape can never be upserted straight into a live index. See also the comment at `fromNote`
 * below, and `tests/vault/frontmatter-index.test.ts`'s key-set snapshot test, which fails on a
 * shape change made without bumping this.
 */
export const INDEX_CACHE_SCHEMA = 1;

export interface IndexEntry {
  path: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  size: number;
  modifiedAt: string;
  hash: string;
  links: LinkRef[];
  tags: string[];
  headings: Heading[];
  blockIds: BlockId[];
  wordCount: number;
}

export interface FrontmatterQuery {
  field: string;
  equals?: unknown;
  contains?: string;
  exists?: boolean;
}

export interface FrontmatterHit {
  path: string;
  value: unknown;
}

export interface ReconcileResult {
  /** Markdown notes that had an index entry but whose size/modifiedAt differed — re-read. */
  refreshed: number;
  /** Notes or assets whose index entry no longer has a file on disk — dropped. */
  removed: number;
  /** Notes or assets found on disk with no prior index entry — added. */
  added: number;
  durationMs: number;
}

/** True for a path that must never be tracked as an asset: reserved (`_brainstem/`) or dot-segmented. */
function isDotOrReservedPath(p: string): boolean {
  return isReservedPath(p) || p.split('/').some((segment) => segment.startsWith('.'));
}

/** Dot-path lookup over frontmatter. Own properties only: `constructor` or `toString` is a field
 *  of no note, though every object inherits one. */
export function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = obj;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null) return a === b || linkAwareEquals(a, b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesEquals(value: unknown, wanted: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => sameValue(item, wanted));
  return sameValue(value, wanted);
}

function matchesContains(value: unknown, needle: string): boolean {
  const n = needle.toLowerCase();
  if (typeof value === 'string') return value.toLowerCase().includes(n);
  if (Array.isArray(value))
    return value.some((item) => typeof item === 'string' && item.toLowerCase().includes(n));
  return false;
}

/** Strings shorter than this are copied by V8 when sliced, never kept as a view of their parent. */
const SLICE_THRESHOLD = 13;

/**
 * A deep copy in which every string owns its characters. `JSON.parse(JSON.stringify(s))` is the
 * copy: exact for any string (lone surrogates included) and, unlike concatenation tricks, not
 * something an engine may optimise back into a view. Non-string values are kept as they are
 * (numbers, booleans, null, and whatever else YAML's core schema produced).
 */
export function detached<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.length < SLICE_THRESHOLD ? value : JSON.parse(JSON.stringify(value))) as T;
  }
  if (Array.isArray(value)) return value.map((item) => detached(item)) as T;
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // defineProperty, not `out[key] =`: YAML may hold a `__proto__` key, and assigning it would
      // set the copy's prototype, dropping the key and making its content answer as fields.
      Object.defineProperty(out, detached(key), {
        value: detached(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

/** `bytes` is the serialized size of the entries (what `byteSize()` returns), not heap. */
export interface IndexBudgetState {
  bytes: number;
  budgetBytes: number;
}

export class FrontmatterIndex {
  readonly builtAt: Date;
  /** Bumped by exactly 1 on every upsert/remove/rename/addAsset/removeAsset/renameAsset that actually
   *  changes the index, so consumers (e.g. VaultGraph) can cheaply detect staleness. */
  private _version = 0;
  private onOverBudget: ((state: IndexBudgetState) => void) | undefined;
  private _budgetBytes = MAX_INDEX_BYTES;
  private readonly entries = new Map<string, IndexEntry>();
  private readonly assetPaths = new Set<string>();
  private bytes = 0;
  private overBudgetLogged = false;
  private _reconciledAt: Date | null = null;
  /** Markdown paths a reconcile could not index, with the size:mtime they had then. */
  private readonly unindexable = new Map<string, string>();
  /** Notes whose last read failed; see `unreadableCount`. */
  private readonly unreadablePaths = new Set<string>();
  /** How many times each path was removed or renamed away, so a refresh that began before such
   *  a withdrawal knows not to write its stale result (see `refreshPath`). */
  private readonly withdrawals = new Map<string, number>();

  private withdraw(path: string): void {
    this.withdrawals.set(path, (this.withdrawals.get(path) ?? 0) + 1);
  }

  private constructor() {
    this.builtAt = new Date();
  }

  /** null until reconcile() has run at least once. */
  get reconciledAt(): Date | null {
    return this._reconciledAt;
  }

  get version(): number {
    return this._version;
  }

  private bumpVersion(): void {
    this._version += 1;
  }

  private entrySize(entry: IndexEntry): number {
    return Buffer.byteLength(JSON.stringify(entry));
  }

  get budgetBytes(): number {
    return this._budgetBytes;
  }

  /** Sets the budget and who hears about it, and checks at once: an index is built before anyone
   *  can listen, so a vault that is over the budget from the first minute would otherwise never
   *  say so. `onOver` is called at most once per over-budget episode (again only after the index
   *  has been back under the budget). The budget is a warning line, not a limit: nothing is
   *  evicted or refused, because an index that silently forgets notes is worse than a large one. */
  watchBudget(budgetBytes: number, onOver?: (state: IndexBudgetState) => void): void {
    if (!Number.isFinite(budgetBytes)) {
      // NaN would silently never warn, and neither survives JSON into brainstem_ping's output
      throw new RangeError('the index budget must be a finite number of bytes');
    }
    this._budgetBytes = budgetBytes;
    this.onOverBudget = onOver;
    this.overBudgetLogged = false;
    this.checkByteBudget();
  }

  private checkByteBudget(): void {
    if (this.bytes > this._budgetBytes) {
      if (!this.overBudgetLogged) {
        this.overBudgetLogged = true;
        try {
          this.onOverBudget?.({ bytes: this.bytes, budgetBytes: this._budgetBytes });
        } catch {
          // a listener that throws must not fail the write that happened to cross the line
        }
      }
    } else {
      this.overBudgetLogged = false;
    }
  }

  // Bump INDEX_CACHE_SCHEMA (above) whenever this changes what it returns.
  static fromNote(note: Note): IndexEntry {
    // Everything stored here outlives the note it came from. In V8 a piece cut out of a larger
    // string (a link target, a heading, a YAML value) keeps the whole string alive, so without
    // `detached` the index silently held the text of the entire vault: 940 MB of heap for 264 MB
    // of index, measured on a 37,000-note vault.
    return detached({
      path: note.path,
      frontmatter: note.frontmatter,
      hasFrontmatter: note.hasFrontmatter,
      size: note.meta.size,
      modifiedAt: note.meta.modifiedAt,
      hash: note.hash,
      ...parseNote(note.content, note.frontmatter, note.body),
    });
  }

  /** An index with nothing in it yet — the starting point for a background `fill()` (see
   *  `createLocalRuntime({ deferIndex: true })`), so a boot can answer at once and populate the
   *  index while the first tool calls are already waiting on `indexReady`. */
  static empty(): FrontmatterIndex {
    return new FrontmatterIndex();
  }

  /**
   * Lists the vault and reads every markdown note into this index, batching reads like `build()`.
   * `onProgress` is called once before the first batch (`{ done: 0, total }`) and once after each
   * batch, so a caller can report "N of M notes indexed" while a large vault is still filling.
   * Safe to call on an index that already has entries (a reconcile does the equivalent lighter
   * sweep instead); `build()` is exactly `empty()` followed by `fill()`.
   *
   * `cached` (optional, from the machine-local index cache — `src/storage/local-cache.ts`, used
   * only by the stdio entrypoint) is a hint, never a source: a markdown path in this boot's own
   * listing is upserted straight from `cached` — no disk read — only when its `size` and
   * `modifiedAt` are byte-for-byte equal to what the listing just reported; every other path (not
   * in `cached`, or changed) goes through `batchRead` exactly as it would without a cache. A path
   * cached but no longer in the listing is silently dropped, never upserted. Progress (`done`)
   * counts a cache hit the same as a disk read — both are notes the fill no longer has to wait
   * for. The known blind spot (a file rewritten with the same size and mtime, in the same second
   * a coarse filesystem clock resolves to) is the same one `reconcile` already accepts.
   */
  async fill(
    adapter: StorageAdapter,
    onProgress?: (progress: { done: number; total: number }) => void,
    /** Asked between batches: a fill that is no longer wanted (the runtime is closing) stops. */
    shouldStop: () => boolean = () => false,
    cached?: ReadonlyMap<string, IndexEntry>,
  ): Promise<{ unreadable: number; stopped: boolean; fromCache: number; fromDisk: number }> {
    const files = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const mdFiles: { path: string; size: number; modifiedAt: string }[] = [];
    for (const file of files) {
      if (isMarkdownPath(file.path)) {
        mdFiles.push({ path: file.path, size: file.size ?? -1, modifiedAt: file.modifiedAt ?? '' });
      } else {
        this.addAsset(file.path);
      }
    }
    const total = mdFiles.length;
    let done = 0;
    onProgress?.({ done, total });

    // The cache pass first, synchronously (no I/O): every hit removes one path from what
    // `batchRead` below has to fetch. `cached` may hold entries for paths this listing no longer
    // has at all (a note deleted since the cache was written) — those are simply never looked up.
    const toRead: string[] = [];
    let fromCache = 0;
    for (const f of mdFiles) {
      const hit = cached?.get(f.path);
      if (hit && hit.size === f.size && hit.modifiedAt === f.modifiedAt) {
        this.upsert(hit);
        fromCache += 1;
      } else {
        toRead.push(f.path);
      }
    }
    done = fromCache;
    if (fromCache > 0) onProgress?.({ done, total });

    let fromDisk = 0;
    for (let i = 0; i < toRead.length; i += MAX_BATCH) {
      if (shouldStop()) {
        return { unreadable: this.unreadablePaths.size, stopped: true, fromCache, fromDisk };
      }
      const chunk = toRead.slice(i, i + MAX_BATCH);
      const { notes, failed } = await adapter.batchRead(chunk);
      for (const note of notes) this.upsert(FrontmatterIndex.fromNote(note));
      for (const { path } of failed) this.unreadablePaths.add(path);
      fromDisk += chunk.length;
      // A note that vanished or could not be read is not "done": the unreadable ones are kept apart, and the
      // reconcile pass that follows the fill is what picks it up once it can be read.
      done += notes.length;
      onProgress?.({ done, total });
    }
    return { unreadable: this.unreadablePaths.size, stopped: false, fromCache, fromDisk };
  }

  static async build(adapter: StorageAdapter): Promise<FrontmatterIndex> {
    const index = FrontmatterIndex.empty();
    await index.fill(adapter);
    return index;
  }

  /** Applies a just-written (or just-read) Note without another disk read: markdown notes are
   *  (re)indexed, anything else is tracked as an asset. */
  applyNote(note: Note): void {
    if (isMarkdownPath(note.path)) this.upsert(FrontmatterIndex.fromNote(note));
    else this.addAsset(note.path);
  }

  upsert(entry: IndexEntry): void {
    const existing = this.entries.get(entry.path);
    if (existing) this.bytes -= this.entrySize(existing);
    this.entries.set(entry.path, entry);
    this.unreadablePaths.delete(entry.path); // it was just read
    this.bytes += this.entrySize(entry);
    this.bumpVersion();
    this.checkByteBudget();
  }

  remove(path: string): void {
    this.withdraw(path);
    this.unreadablePaths.delete(path); // a note that is gone is not an unreadable note
    const existing = this.entries.get(path);
    if (!existing) return;
    this.bytes -= this.entrySize(existing);
    this.entries.delete(path);
    this.bumpVersion();
    this.checkByteBudget();
  }

  rename(from: string, to: string): void {
    this.withdraw(from);
    // an unreadable note moves like any other (a rename needs no read permission)
    if (this.unreadablePaths.delete(from)) this.unreadablePaths.add(to);
    const existing = this.entries.get(from);
    if (!existing) return;
    this.bytes -= this.entrySize(existing);
    this.entries.delete(from);
    const overwritten = this.entries.get(to);
    if (overwritten) this.bytes -= this.entrySize(overwritten);
    const renamed = { ...existing, path: to };
    this.entries.set(to, renamed);
    this.bytes += this.entrySize(renamed);
    this.bumpVersion();
    this.checkByteBudget();
  }

  get(path: string): IndexEntry | undefined {
    return this.entries.get(path);
  }

  all(): IndexEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  size(): number {
    return this.entries.size;
  }

  /** Notes on disk whose last read failed (no permission, a lock held by another program, not UTF-8): kept current by
   *  the fill, every reconcile pass and every successful read, so it falls when a note heals. */
  unreadableCount(): number {
    return this.unreadablePaths.size;
  }

  /** Notes the vault holds: the indexed ones, and the unreadable ones the index has no entry for. */
  knownNoteCount(): number {
    let missing = 0;
    for (const path of this.unreadablePaths) if (!this.entries.has(path)) missing += 1;
    return this.entries.size + missing;
  }

  byteSize(): number {
    return this.bytes;
  }

  /** Vault-relative paths of every non-markdown file the index has seen — never dot or reserved paths. */
  assets(): ReadonlySet<string> {
    return new Set(this.assetPaths);
  }

  addAsset(path: string): void {
    if (isDotOrReservedPath(path)) return;
    if (this.assetPaths.has(path)) return;
    this.assetPaths.add(path);
    this.bumpVersion();
  }

  removeAsset(path: string): void {
    if (!this.assetPaths.has(path)) return;
    this.assetPaths.delete(path);
    this.bumpVersion();
  }

  renameAsset(from: string, to: string): void {
    if (!this.assetPaths.has(from)) return;
    if (isDotOrReservedPath(to)) return;
    this.assetPaths.delete(from);
    this.assetPaths.add(to);
    this.bumpVersion();
  }

  query(q: FrontmatterQuery): FrontmatterHit[] {
    const hits: FrontmatterHit[] = [];
    for (const entry of this.all()) {
      const value = getPath(entry.frontmatter, q.field);
      if (q.exists === true && value === undefined) continue;
      if (q.exists === false && value !== undefined) continue;
      if (q.equals !== undefined && !matchesEquals(value, q.equals)) continue;
      if (q.contains !== undefined && !matchesContains(value, q.contains)) continue;
      if (
        q.exists === undefined &&
        q.equals === undefined &&
        q.contains === undefined &&
        value === undefined
      )
        continue;
      hits.push({ path: entry.path, value });
    }
    return hits;
  }

  async refreshPath(adapter: StorageAdapter, path: string): Promise<void> {
    if (!isMarkdownPath(path)) return;
    // A tool that removes or renames this path while the read below is in flight must win: on
    // macOS a rename into .trash reaches the watcher as a change, whose refresh had read the
    // note before the move and would have put it back after vault_delete's index.remove.
    const withdrawn = this.withdrawals.get(path) ?? 0;
    try {
      const note = await adapter.read(path);
      if ((this.withdrawals.get(path) ?? 0) !== withdrawn) return;
      this.upsert(FrontmatterIndex.fromNote(note));
    } catch (error) {
      // Gone, or not a file at all (a folder, a FIFO or socket named like a note: no listing
      // ever shows those, only a watcher event can bring one here): not a note, so not counted.
      if (
        error instanceof VaultError &&
        (error.code === 'NOT_FOUND' || error.code === 'INVALID_INPUT')
      ) {
        this.remove(path);
        return;
      }
      if (error instanceof VaultError && error.code === 'ENCODING') {
        this.remove(path);
        this.unreadablePaths.add(path); // after remove(), which clears it
        return;
      }
      this.unreadablePaths.add(path);
      throw error;
    }
  }

  /**
   * Re-derives the index from a fresh directory listing, to recover from watcher events an
   * external process outran or an OS event queue silently dropped (inotify overflow and
   * similar). Compares the adapter's own listing — which already carries size/modifiedAt, no
   * extra stat calls — against what the index holds: a markdown path missing from the index, or
   * whose size/modifiedAt differ, is re-read; an index entry with no matching file on disk is
   * dropped; assets (non-markdown paths) are added/removed the same way, without a read (the
   * index never stores their content). `adapter.list()` already excludes the reserved folder and
   * hidden paths, so reconcile can never surface either.
   *
   * Safe to call while tools are writing: additions and refreshes go through the same
   * upsert/addAsset the live watcher path uses; a removal is never decided on the listing alone
   * but confirmed against the disk; and a single file that fails to read (raced away between the
   * listing and the read) is skipped, never thrown — the counters simply don't credit it.
   */
  async reconcile(adapter: StorageAdapter): Promise<ReconcileResult> {
    const start = Date.now();
    const files = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const seenNotes = new Set<string>();
    const seenAssets = new Set<string>();
    let refreshed = 0;
    let added = 0;
    let removed = 0;

    for (const file of files) {
      if (!isMarkdownPath(file.path)) {
        seenAssets.add(file.path);
        if (!this.assetPaths.has(file.path)) {
          this.addAsset(file.path);
          added += 1;
        }
        continue;
      }
      seenNotes.add(file.path);
      const stamp = `${file.size}:${file.modifiedAt}`;
      const existing = this.entries.get(file.path);
      if (existing && existing.size === file.size && existing.modifiedAt === file.modifiedAt) {
        continue;
      }
      // A file that could not be indexed last time (not UTF-8, say) and has not changed since is
      // not worth another full read on every sweep.
      if (!existing && this.unindexable.get(file.path) === stamp) continue;
      try {
        await this.refreshPath(adapter, file.path);
      } catch {
        this.unreadablePaths.add(file.path);
        continue; // one unreadable file must never abort the whole reconcile pass
      }
      if (this.entries.has(file.path)) {
        this.unindexable.delete(file.path);
        if (existing) refreshed += 1;
        else added += 1;
      } else if (this.unreadablePaths.has(file.path)) {
        // refreshPath said so (not UTF-8). A path it dropped without marking was gone, or was
        // no longer a regular file, by the time it was read: not a note, nothing to count.
        this.unindexable.set(file.path, stamp);
      }
    }
    for (const path of this.unreadablePaths) {
      if (!seenNotes.has(path)) this.unreadablePaths.delete(path); // gone from the disk
    }

    // The listing is a snapshot. A note a tool wrote, or moved, after it was taken is in the index
    // and not in the snapshot: removing on the snapshot alone would drop a note that exists (and a
    // later move of one of its link targets would then leave its links unrewritten). So absence
    // is confirmed against the disk, one candidate at a time; candidates are rare.
    for (const p of [...this.entries.keys()]) {
      if (seenNotes.has(p)) continue;
      try {
        await this.refreshPath(adapter, p); // removes the entry itself when the file is gone
      } catch {
        continue;
      }
      if (!this.entries.has(p)) removed += 1;
    }
    for (const p of [...this.assetPaths]) {
      if (seenAssets.has(p)) continue;
      const gone = adapter.exists
        ? !(await adapter.exists(p).catch(() => true))
        : (await adapter.hashOf(p).catch(() => undefined)) === null;
      if (gone) {
        this.removeAsset(p);
        removed += 1;
      }
    }
    for (const p of [...this.unindexable.keys()]) {
      if (!seenNotes.has(p)) this.unindexable.delete(p);
    }

    this._reconciledAt = new Date();
    return { refreshed, removed, added, durationMs: Date.now() - start };
  }

  /** `onError` (the adapter watcher's own `error` event, e.g. an inotify overflow) is optional so
   *  callers/tests that don't care about it are unaffected. */
  attach(adapter: StorageAdapter, onError?: (error: unknown) => void): Unsubscribe {
    if (!adapter.capabilities().watch || !adapter.watch) return () => {};
    return adapter.watch((event) => {
      if (!isMarkdownPath(event.path)) {
        if (event.type === 'delete') this.removeAsset(event.path);
        else this.addAsset(event.path);
        return;
      }
      if (event.type === 'delete') {
        this.remove(event.path);
        return;
      }
      void this.refreshPath(adapter, event.path).catch(() => {
        /* a transient read failure leaves the previous entry in place; the next event or TTL rebuild fixes it */
      });
    }, onError);
  }
}
