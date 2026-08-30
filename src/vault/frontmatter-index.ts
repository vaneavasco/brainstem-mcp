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

  private constructor() {
    this.builtAt = new Date();
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
  }

  rename(from: string, to: string): void {
    const existing = this.entries.get(from);
    if (!existing) return;
    this.bytes -= this.entrySize(existing);
    this.entries.delete(from);
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
    return this.assetPaths;
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

  attach(adapter: StorageAdapter): Unsubscribe {
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
    });
  }
}
