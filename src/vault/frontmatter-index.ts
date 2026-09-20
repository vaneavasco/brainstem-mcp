import { MAX_BATCH, MAX_INDEX_BYTES } from '../storage/limits.ts';
import { isMarkdownPath, isReservedPath } from '../storage/path-policy.ts';
import { type Note, type StorageAdapter, type Unsubscribe, VaultError } from '../storage/types.ts';
import { type BlockId, type Heading, type LinkRef, parseNote } from './note-parse.ts';

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

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = obj;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null) return a === b;
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

export class FrontmatterIndex {
  readonly builtAt: Date;
  /** Bumped by exactly 1 on every upsert/remove/rename/addAsset/removeAsset/renameAsset that actually
   *  changes the index, so consumers (e.g. VaultGraph) can cheaply detect staleness. */
  private _version = 0;
  /** Called at most once per over-budget episode (reset once back under budget); never throws. */
  onOverBudget?: () => void;
  private readonly entries = new Map<string, IndexEntry>();
  private readonly assetPaths = new Set<string>();
  private bytes = 0;
  private overBudgetLogged = false;
  private _reconciledAt: Date | null = null;

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
    return JSON.stringify(entry).length;
  }

  private checkByteBudget(): void {
    if (this.bytes > MAX_INDEX_BYTES) {
      if (!this.overBudgetLogged) {
        this.overBudgetLogged = true;
        this.onOverBudget?.();
      }
    } else {
      this.overBudgetLogged = false;
    }
  }

  static fromNote(note: Note): IndexEntry {
    return {
      path: note.path,
      frontmatter: note.frontmatter,
      hasFrontmatter: note.hasFrontmatter,
      size: note.meta.size,
      modifiedAt: note.meta.modifiedAt,
      hash: note.hash,
      ...parseNote(note.content, note.frontmatter, note.body),
    };
  }

  static async build(adapter: StorageAdapter): Promise<FrontmatterIndex> {
    const index = new FrontmatterIndex();
    const files = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const mdPaths: string[] = [];
    for (const file of files) {
      if (isMarkdownPath(file.path)) mdPaths.push(file.path);
      else index.addAsset(file.path);
    }
    for (let i = 0; i < mdPaths.length; i += MAX_BATCH) {
      const chunk = mdPaths.slice(i, i + MAX_BATCH);
      const { notes } = await adapter.batchRead(chunk);
      for (const note of notes) index.upsert(FrontmatterIndex.fromNote(note));
    }
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
    this.bytes += this.entrySize(entry);
    this.bumpVersion();
    this.checkByteBudget();
  }

  remove(path: string): void {
    const existing = this.entries.get(path);
    if (!existing) return;
    this.bytes -= this.entrySize(existing);
    this.entries.delete(path);
    this.bumpVersion();
    this.checkByteBudget();
  }

  rename(from: string, to: string): void {
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
    try {
      this.upsert(FrontmatterIndex.fromNote(await adapter.read(path)));
    } catch (error) {
      if (
        error instanceof VaultError &&
        (error.code === 'NOT_FOUND' || error.code === 'ENCODING')
      ) {
        this.remove(path);
        return;
      }
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
   * Safe to call while tools are writing: every mutation goes through the same
   * upsert/remove/addAsset/removeAsset the live watcher path uses, and a single file that fails
   * to read (raced away between the listing and the read) is skipped, never thrown — the
   * counters simply don't credit it.
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
      if (isMarkdownPath(file.path)) {
        seenNotes.add(file.path);
        const existing = this.entries.get(file.path);
        if (existing && existing.size === file.size && existing.modifiedAt === file.modifiedAt) {
          continue;
        }
        try {
          await this.refreshPath(adapter, file.path);
        } catch {
          continue; // one unreadable file must never abort the whole reconcile pass
        }
        // refreshPath silently removes on a race (NOT_FOUND/ENCODING) instead of adding — only
        // credit refreshed/added when an entry actually landed.
        if (this.entries.has(file.path)) {
          if (existing) refreshed += 1;
          else added += 1;
        }
      } else {
        seenAssets.add(file.path);
        if (!this.assetPaths.has(file.path)) {
          this.addAsset(file.path);
          added += 1;
        }
      }
    }

    for (const p of [...this.entries.keys()]) {
      if (!seenNotes.has(p)) {
        this.remove(p);
        removed += 1;
      }
    }
    for (const p of [...this.assetPaths]) {
      if (!seenAssets.has(p)) {
        this.removeAsset(p);
        removed += 1;
      }
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
