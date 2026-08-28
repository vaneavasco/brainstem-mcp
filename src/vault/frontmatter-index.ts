import { MAX_BATCH } from '../storage/limits.ts';
import { isMarkdownPath } from '../storage/path-policy.ts';
import { type Note, type StorageAdapter, type Unsubscribe, VaultError } from '../storage/types.ts';

export interface IndexEntry {
  path: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  size: number;
  modifiedAt: string;
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
  private readonly entries = new Map<string, IndexEntry>();
  private bytes = 0;

  private constructor() {
    this.builtAt = new Date();
  }

  static fromNote(note: Note): IndexEntry {
    return {
      path: note.path,
      frontmatter: note.frontmatter,
      hasFrontmatter: note.hasFrontmatter,
      size: note.meta.size,
      modifiedAt: note.meta.modifiedAt,
    };
  }

  static async build(adapter: StorageAdapter): Promise<FrontmatterIndex> {
    const index = new FrontmatterIndex();
    const files = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const mdPaths = files.map((f) => f.path).filter(isMarkdownPath);
    for (let i = 0; i < mdPaths.length; i += MAX_BATCH) {
      const chunk = mdPaths.slice(i, i + MAX_BATCH);
      const { notes } = await adapter.batchRead(chunk);
      for (const note of notes) index.upsert(FrontmatterIndex.fromNote(note));
    }
    return index;
  }

  upsert(entry: IndexEntry): void {
    this.remove(entry.path);
    this.entries.set(entry.path, entry);
    this.bytes += JSON.stringify(entry).length;
  }

  remove(path: string): void {
    const existing = this.entries.get(path);
    if (!existing) return;
    this.bytes -= JSON.stringify(existing).length;
    this.entries.delete(path);
  }

  rename(from: string, to: string): void {
    const existing = this.entries.get(from);
    if (!existing) return;
    this.remove(from);
    this.upsert({ ...existing, path: to });
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
      if (!isMarkdownPath(event.path)) return;
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
