import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import {
  FrontmatterIndex,
  INDEX_CACHE_SCHEMA,
  type IndexEntry,
} from '../../src/vault/frontmatter-index.ts';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await vault.write(
    'a.md',
    '---\ntype: project\nstatus: active\ntags: [mcp, Notes]\nmeta:\n  owner: ana\n---\nA',
  );
  await vault.write('sub/b.md', '---\ntype: area\nstatus: active\ntags: [health]\n---\nB');
  await vault.write('sub/c.md', 'no frontmatter');
  await vault.write('d.canvas', '{"nodes":[],"edges":[]}');
  for (let i = 0; i < 25; i += 1) await vault.write(`bulk/n${i}.md`, `---\nn: ${i}\n---\n`);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FrontmatterIndex.build', () => {
  it('indexes every markdown file (batching past 20) and ignores non-markdown', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.size()).toBe(28);
    expect(index.get('d.canvas')).toBeUndefined();
    expect(index.get('sub/c.md')).toMatchObject({ hasFrontmatter: false, frontmatter: {} });
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
    expect(index.byteSize()).toBeGreaterThan(0);
    expect(index.builtAt).toBeInstanceOf(Date);
  });
});

describe('FrontmatterIndex.empty + fill', () => {
  it('empty() starts with nothing; fill() populates it the same way build() does', async () => {
    const index = FrontmatterIndex.empty();
    expect(index.size()).toBe(0);
    expect(index.get('a.md')).toBeUndefined();
    await index.fill(vault);
    expect(index.size()).toBe(28);
    expect(index.get('d.canvas')).toBeUndefined();
    expect(index.assets()).toContain('d.canvas');
    expect(index.get('sub/c.md')).toMatchObject({ hasFrontmatter: false, frontmatter: {} });
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
  });

  it('build() is empty() + fill()', async () => {
    const built = await FrontmatterIndex.build(vault);
    const filled = FrontmatterIndex.empty();
    await filled.fill(vault);
    expect(filled.size()).toBe(built.size());
    expect(filled.all().map((e) => e.path)).toEqual(built.all().map((e) => e.path));
  });

  it('reports { done, total } progress as it goes, ending at done === total === note count', async () => {
    const index = FrontmatterIndex.empty();
    const snapshots: { done: number; total: number }[] = [];
    await index.fill(vault, (p) => snapshots.push({ ...p }));
    expect(snapshots.length).toBeGreaterThan(1); // at least a start snapshot and a batch snapshot
    expect(snapshots[0]).toEqual({ done: 0, total: 28 });
    for (const s of snapshots) expect(s.total).toBe(28);
    const last = snapshots.at(-1);
    expect(last).toEqual({ done: 28, total: 28 });
  });
});

describe('fill() with a cached entries map (the machine-local index cache — a hint, never a source)', () => {
  it('a cache hit (same path, size and modifiedAt as the listing) is upserted with no disk read', async () => {
    const built = FrontmatterIndex.empty();
    await built.fill(vault);
    const real = built.get('a.md');
    if (!real) throw new Error('expected a.md to be indexed');

    // Proves the hit skipped batchRead entirely, not merely that the result matches: batchRead
    // for a.md would fail if called, since the counting adapter below only forwards other paths.
    const countingVault = Object.create(vault) as typeof vault;
    countingVault.batchRead = (paths: string[]) => {
      if (paths.includes('a.md')) throw new Error('a.md must not be read from disk on a cache hit');
      return vault.batchRead(paths);
    };

    const cached = new Map<string, IndexEntry>([['a.md', real]]);
    const index = FrontmatterIndex.empty();
    const result = await index.fill(countingVault, undefined, undefined, cached);
    expect(result.fromCache).toBe(1);
    expect(result.fromDisk).toBe(27); // every other markdown note, still read
    expect(index.get('a.md')).toEqual(real);
    expect(index.size()).toBe(28);
  });

  it('a stale cache entry (size or modifiedAt differs from the listing) is re-read from disk', async () => {
    const cached = new Map<string, IndexEntry>([
      [
        'a.md',
        {
          path: 'a.md',
          frontmatter: { stale: true },
          hasFrontmatter: true,
          size: 999_999, // does not match the real file's size
          modifiedAt: '1999-01-01T00:00:00.000Z',
          hash: 'stale-hash',
          links: [],
          tags: [],
          headings: [],
          blockIds: [],
          wordCount: 0,
        },
      ],
    ]);
    const index = FrontmatterIndex.empty();
    await index.fill(vault, undefined, undefined, cached);
    // re-read from disk: the real frontmatter shows, not the stale cached one
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
    expect(index.get('a.md')?.frontmatter).not.toMatchObject({ stale: true });
  });

  it('a cached path no longer in the listing (a note deleted since the cache was written) is dropped', async () => {
    const cached = new Map<string, IndexEntry>([
      [
        'gone.md',
        {
          path: 'gone.md',
          frontmatter: {},
          hasFrontmatter: false,
          size: 1,
          modifiedAt: new Date().toISOString(),
          hash: 'x',
          links: [],
          tags: [],
          headings: [],
          blockIds: [],
          wordCount: 0,
        },
      ],
    ]);
    const index = FrontmatterIndex.empty();
    const result = await index.fill(vault, undefined, undefined, cached);
    expect(index.get('gone.md')).toBeUndefined();
    expect(result.fromCache).toBe(0);
    expect(result.fromDisk).toBe(28);
  });

  it('progress counts a cache hit as done, the same as a disk read', async () => {
    const built = FrontmatterIndex.empty();
    await built.fill(vault);
    const cached = new Map(built.all().map((e) => [e.path, e]));

    const snapshots: { done: number; total: number }[] = [];
    const index = FrontmatterIndex.empty();
    await index.fill(vault, (p) => snapshots.push({ ...p }), undefined, cached);
    expect(snapshots[0]).toEqual({ done: 0, total: 28 });
    expect(snapshots.at(-1)).toEqual({ done: 28, total: 28 });
    // everything came from the cache — no disk read at all
    const result = await FrontmatterIndex.empty().fill(vault, undefined, undefined, cached);
    expect(result.fromCache).toBe(28);
    expect(result.fromDisk).toBe(0);
  });

  it('byteSize() is identical whether entries came from disk or from a cache hit', async () => {
    const cold = FrontmatterIndex.empty();
    await cold.fill(vault);
    const cached = new Map(cold.all().map((e) => [e.path, e]));

    const warm = FrontmatterIndex.empty();
    await warm.fill(vault, undefined, undefined, cached);

    expect(warm.byteSize()).toBe(cold.byteSize());
    expect(warm.all()).toEqual(cold.all());
  });

  it('with no cache at all, behaves exactly as before (undefined cachedEntries)', async () => {
    const index = FrontmatterIndex.empty();
    const result = await index.fill(vault);
    expect(result.fromCache).toBe(0);
    expect(result.fromDisk).toBe(28);
    expect(index.size()).toBe(28);
  });
});

describe('INDEX_CACHE_SCHEMA guards IndexEntry’s shape', () => {
  it('a representative entry’s sorted key list matches the schema number — bump both together', async () => {
    // If this fails because IndexEntry gained, lost or renamed a field, the fix is: update the
    // key list below AND bump INDEX_CACHE_SCHEMA (src/vault/frontmatter-index.ts) — a cache
    // written under the old schema must never be upserted straight into an index expecting the
    // new shape (src/storage/local-cache.ts rejects a schema mismatch outright).
    expect(INDEX_CACHE_SCHEMA).toBe(1);
    const index = await FrontmatterIndex.build(vault);
    const entry = index.get('a.md');
    if (!entry) throw new Error('expected a.md to be indexed');
    expect(Object.keys(entry).sort()).toEqual(
      [
        'blockIds',
        'frontmatter',
        'hasFrontmatter',
        'hash',
        'headings',
        'links',
        'modifiedAt',
        'path',
        'size',
        'tags',
        'wordCount',
      ].sort(),
    );
  });
});

describe('query', () => {
  it('supports equals, contains, exists, array membership and dot paths', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.query({ field: 'type', equals: 'project' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'status', equals: 'active' }).map((h) => h.path)).toEqual([
      'a.md',
      'sub/b.md',
    ]);
    expect(index.query({ field: 'tags', equals: 'mcp' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'tags', contains: 'note' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'meta.owner', equals: 'ana' }).map((h) => h.path)).toEqual([
      'a.md',
    ]);
    expect(index.query({ field: 'type', exists: true }).map((h) => h.path)).toEqual([
      'a.md',
      'sub/b.md',
    ]);
    expect(index.query({ field: 'type', exists: false })).toHaveLength(26);
    expect(index.query({ field: 'n', equals: 7 }).map((h) => h.path)).toEqual(['bulk/n7.md']);
    const hit = index.query({ field: 'tags', equals: 'health' })[0];
    expect(hit).toEqual({ path: 'sub/b.md', value: ['health'] });
  });

  it('ANDs multiple criteria', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(
      index
        .query({ field: 'status', equals: 'active', contains: 'act', exists: true })
        .map((h) => h.path),
    ).toEqual(['a.md', 'sub/b.md']);
  });

  it('equals is link-aware: a wikilink value matches its plain name and full target, scalar and list', async () => {
    await vault.write('links/a.md', '---\nowner: "[[people/Alpha Person]]"\n---\nx');
    await vault.write('links/b.md', '---\nowners:\n  - "[[Alpha Person|Alpha]]"\n---\nx');
    await vault.write('links/c.md', '---\nowner: "[[Beta Person]]"\n---\nx');
    const index = await FrontmatterIndex.build(vault);
    expect(index.query({ field: 'owner', equals: 'Alpha Person' }).map((h) => h.path)).toEqual([
      'links/a.md',
    ]);
    expect(
      index.query({ field: 'owner', equals: 'people/Alpha Person' }).map((h) => h.path),
    ).toEqual(['links/a.md']);
    expect(index.query({ field: 'owners', equals: 'Alpha Person' }).map((h) => h.path)).toEqual([
      'links/b.md',
    ]);
    expect(
      index.query({ field: 'owner', equals: 'Alpha Person' }).map((h) => h.path),
    ).not.toContain('links/c.md');
  });
});

describe('mutation helpers', () => {
  it('upsert/remove/rename/refreshPath keep the index consistent', async () => {
    const index = await FrontmatterIndex.build(vault);
    index.remove('a.md');
    expect(index.get('a.md')).toBeUndefined();
    await index.refreshPath(vault, 'a.md');
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
    index.rename('a.md', 'moved/a.md');
    expect(index.get('a.md')).toBeUndefined();
    expect(index.get('moved/a.md')?.path).toBe('moved/a.md');
    await index.refreshPath(vault, 'moved/a.md'); // file does not exist on disk -> removed
    expect(index.get('moved/a.md')).toBeUndefined();
  });

  it('rename() does not leak bytes when the target path already holds an entry', async () => {
    const rRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-rename-'));
    const rVault = await LocalFSAdapter.create(rRoot, { ripgrepPath: null });
    await rVault.write('a.md', '---\ntitle: A\n---\nAlpha body with a few extra words to size it.');
    await rVault.write('b.md', 'B');
    const index = await FrontmatterIndex.build(rVault);
    expect(index.size()).toBe(2);

    index.rename('a.md', 'b.md');
    expect(index.size()).toBe(1);

    const survivor = index.get('b.md');
    if (!survivor) throw new Error('expected b.md to survive the rename');
    expect(survivor.path).toBe('b.md');

    // Compare against a fresh index holding only the surviving entry: if rename() failed to
    // subtract the byte size of the entry it overwrote at "b.md", index.byteSize() would still
    // include the discarded original b.md entry's bytes and this would not match.
    const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-rename-fresh-'));
    const freshVault = await LocalFSAdapter.create(freshRoot, { ripgrepPath: null });
    const fresh = await FrontmatterIndex.build(freshVault); // no files -> starts at 0 bytes
    fresh.upsert(survivor);
    expect(index.byteSize()).toBe(fresh.byteSize());

    await fs.rm(rRoot, { recursive: true, force: true });
    await fs.rm(freshRoot, { recursive: true, force: true });
  });
});

describe('attach', () => {
  it('follows filesystem changes through the adapter watcher', async () => {
    const index = await FrontmatterIndex.build(vault);
    const detach = index.attach(vault);
    await new Promise((r) => setTimeout(r, 300));
    await vault.write('live.md', '---\ntype: live\n---\n');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !index.get('live.md'))
      await new Promise((r) => setTimeout(r, 50));
    expect(index.get('live.md')?.frontmatter).toEqual({ type: 'live' });
    await fs.rm(path.join(root, 'live.md'));
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2 && index.get('live.md'))
      await new Promise((r) => setTimeout(r, 50));
    expect(index.get('live.md')).toBeUndefined();
    detach();
  });
});

describe('parsed fields, hash, assets and version', () => {
  let pRoot: string;
  let pVault: LocalFSAdapter;
  let index: FrontmatterIndex;

  beforeEach(async () => {
    pRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-parsed-'));
    pVault = await LocalFSAdapter.create(pRoot, { ripgrepPath: null });
    await pVault.write('a.md', '---\ntags: [t1]\n---\n# H\n[[b]] #t2 ^blk');
    await pVault.write('b.md', 'x');
    await pVault.writeBinary('img.png', PNG_BYTES, 'image/png');
    index = await FrontmatterIndex.build(pVault);
  });

  afterEach(async () => {
    await fs.rm(pRoot, { recursive: true, force: true });
  });

  it('indexes links, tags, headings, block ids, word count and content hash per note', async () => {
    const a = index.get('a.md');
    expect(a?.links.map((l) => l.target)).toEqual(['b']);
    expect(a?.tags).toEqual(['t1', 't2']);
    expect(a?.headings).toEqual([{ level: 1, text: 'H', line: 4 }]);
    expect(a?.blockIds).toEqual([{ id: 'blk', line: 5 }]);
    expect(a?.wordCount).toBe(4);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.hash).toBe(sha256hex((await pVault.read('a.md')).content));
  });

  it('tracks non-markdown assets and bumps version on every mutation', async () => {
    expect([...index.assets()]).toEqual(['img.png']);
    const aEntry = index.get('a.md');
    if (!aEntry) throw new Error('expected a.md to be indexed');
    const v0 = index.version;
    index.upsert({ ...aEntry, wordCount: 99 });
    index.removeAsset('img.png');
    index.addAsset('new.pdf');
    index.renameAsset('new.pdf', 'docs/new.pdf');
    index.rename('a.md', 'z.md');
    index.remove('z.md');
    expect(index.version).toBe(v0 + 6);
    expect([...index.assets()]).toEqual(['docs/new.pdf']);
  });

  it('never adds a reserved or dot path as an asset, even via addAsset/renameAsset', () => {
    const before = index.version;
    index.addAsset('_brainstem/state.json');
    index.addAsset('.obsidian/workspace.json');
    expect([...index.assets()]).toEqual(['img.png']);
    expect(index.version).toBe(before);
    index.renameAsset('img.png', '_brainstem/moved.png');
    expect([...index.assets()]).toEqual(['img.png']);
  });
});

describe('assets via watch', () => {
  it('watch events keep assets in sync (create/move/delete of a .png)', async () => {
    const wRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-watch-'));
    const wVault = await LocalFSAdapter.create(wRoot, { ripgrepPath: null, watchPollMs: 300 });
    const index = await FrontmatterIndex.build(wVault);
    const detach = index.attach(wVault);
    await new Promise((r) => setTimeout(r, 400));

    await wVault.writeBinary('img2.png', PNG_BYTES, 'image/png');
    const created = Date.now() + 5000;
    while (Date.now() < created && !index.assets().has('img2.png'))
      await new Promise((r) => setTimeout(r, 50));
    expect(index.assets().has('img2.png')).toBe(true);

    await wVault.move('img2.png', 'moved/img2.png');
    const moved = Date.now() + 5000;
    while (
      Date.now() < moved &&
      (index.assets().has('img2.png') || !index.assets().has('moved/img2.png'))
    )
      await new Promise((r) => setTimeout(r, 50));
    expect(index.assets().has('img2.png')).toBe(false);
    expect(index.assets().has('moved/img2.png')).toBe(true);

    await wVault.softDelete('moved/img2.png', true);
    const deleted = Date.now() + 5000;
    while (Date.now() < deleted && index.assets().has('moved/img2.png'))
      await new Promise((r) => setTimeout(r, 50));
    expect(index.assets().has('moved/img2.png')).toBe(false);

    detach();
    await fs.rm(wRoot, { recursive: true, force: true });
  });
});

describe('applyNote', () => {
  it('indexes a markdown note and tracks anything else as an asset, without a disk read', async () => {
    const index = await FrontmatterIndex.build(vault);
    const note = await vault.write('applied.md', '---\nk: 2\n---\nApplied');
    index.applyNote(note);
    expect(index.get('applied.md')?.hash).toBe(note.hash);
    expect(index.get('applied.md')?.frontmatter).toEqual({ k: 2 });
    index.applyNote({ ...note, path: 'img/applied.png' });
    expect(index.assets().has('img/applied.png')).toBe(true);
  });
});

describe('reconcile', () => {
  it('never drops a note that was written or moved while the sweep was running', async () => {
    const index = await FrontmatterIndex.build(vault);
    // The listing is a snapshot: whatever a tool indexes after it was taken is not in it.
    const list = vault.list.bind(vault);
    vault.list = async (...args: Parameters<typeof list>) => {
      const snapshot = await list(...args);
      index.applyNote(await vault.write('fresh.md', '---\nstatus: new\n---\nfresh'));
      await vault.move('a.md', 'moved.md');
      index.rename('a.md', 'moved.md');
      return snapshot;
    };
    const result = await index.reconcile(vault);
    expect(index.get('fresh.md')?.frontmatter).toMatchObject({ status: 'new' });
    expect(index.get('moved.md')).toBeDefined();
    expect(index.get('a.md')).toBeUndefined();
    expect(result.removed).toBe(0);
  });

  it('a file that vanishes in the middle of the listing does not abort the sweep', async () => {
    const index = await FrontmatterIndex.build(vault);
    await fs.writeFile(path.join(root, 'sub', 'b.md'), '---\nstatus: CHANGED\n---\nB');
    const stat = fs.stat;
    let tripped = false;
    (fs as { stat: unknown }).stat = async (p: Parameters<typeof stat>[0], ...rest: unknown[]) => {
      if (!tripped && String(p).endsWith(`${path.sep}a.md`)) {
        tripped = true;
        await fs.unlink(String(p));
      }
      return (stat as (...a: unknown[]) => unknown)(p, ...rest);
    };
    try {
      await index.reconcile(vault);
    } finally {
      (fs as { stat: unknown }).stat = stat;
    }
    expect(tripped).toBe(true);
    expect(index.get('sub/b.md')?.frontmatter).toMatchObject({ status: 'CHANGED' });
    expect(index.get('a.md')).toBeUndefined();
  });

  it('confirms that an asset is gone without reading it', async () => {
    await fs.mkdir(path.join(root, 'img'), { recursive: true });
    await fs.writeFile(path.join(root, 'img', 'big.png'), Buffer.alloc(1024));
    const index = await FrontmatterIndex.build(vault);
    expect(index.assets().has('img/big.png')).toBe(true);
    await fs.unlink(path.join(root, 'img', 'big.png'));
    let hashed = 0;
    const hashOf = vault.hashOf.bind(vault);
    vault.hashOf = async (p: string) => {
      hashed += 1;
      return hashOf(p);
    };
    const result = await index.reconcile(vault);
    expect(index.assets().has('img/big.png')).toBe(false);
    expect(result.removed).toBe(1);
    expect(hashed).toBe(0);
  });

  it('does not read an unindexable file again on every sweep', async () => {
    await fs.writeFile(path.join(root, 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
    const index = await FrontmatterIndex.build(vault);
    let reads = 0;
    const read = vault.read.bind(vault);
    vault.read = async (p: string) => {
      if (p === 'binary.md') reads += 1;
      return read(p);
    };
    await index.reconcile(vault);
    await index.reconcile(vault);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('is null until the first call, and set after — regardless of whether anything changed', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.reconciledAt).toBeNull();
    const result = await index.reconcile(vault);
    expect(index.reconciledAt).toBeInstanceOf(Date);
    expect(result).toEqual({ refreshed: 0, removed: 0, added: 0, durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refreshes a note whose frontmatter changed behind the index (no watcher attached)', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.get('a.md')?.frontmatter).toMatchObject({ status: 'active' });
    // Bypasses the index entirely — simulates a lost/overflowed watcher event.
    await vault.write('a.md', '---\ntype: project\nstatus: DONE\n---\nA');
    expect(index.get('a.md')?.frontmatter).toMatchObject({ status: 'active' }); // still stale

    const result = await index.reconcile(vault);
    expect(index.get('a.md')?.frontmatter).toMatchObject({ status: 'DONE' });
    expect(result.refreshed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('drops the entry for a file deleted behind the index', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.get('sub/b.md')).toBeDefined();
    await fs.rm(path.join(root, 'sub/b.md'));

    const result = await index.reconcile(vault);
    expect(index.get('sub/b.md')).toBeUndefined();
    expect(result.removed).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.added).toBe(0);
  });

  it('adds a note and an asset created behind the index', async () => {
    const index = await FrontmatterIndex.build(vault);
    await vault.write('new/note.md', '---\nk: 1\n---\nNew');
    await vault.writeBinary('new/img.png', PNG_BYTES, 'image/png');

    const result = await index.reconcile(vault);
    expect(index.get('new/note.md')?.frontmatter).toEqual({ k: 1 });
    expect(index.assets().has('new/img.png')).toBe(true);
    expect(result.added).toBe(2);
  });

  it('reports zero work for an unchanged vault', async () => {
    const index = await FrontmatterIndex.build(vault);
    const result = await index.reconcile(vault);
    expect(result).toMatchObject({ refreshed: 0, removed: 0, added: 0 });
  });

  it('never indexes the reserved folder or hidden paths, even if files appear there on disk', async () => {
    const index = await FrontmatterIndex.build(vault);
    const before = index.size();
    // Written directly on disk, bypassing the adapter (which itself refuses these paths) — this
    // is exactly what reconcile must never surface, since adapter.list() already hides them.
    await fs.mkdir(path.join(root, '_brainstem'), { recursive: true });
    await fs.writeFile(path.join(root, '_brainstem', 'rogue.md'), '---\nx: 1\n---\n');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(root, '.obsidian', 'hidden.md'), '---\nx: 1\n---\n');

    const result = await index.reconcile(vault);
    expect(index.get('_brainstem/rogue.md')).toBeUndefined();
    expect(index.get('.obsidian/hidden.md')).toBeUndefined();
    expect(index.size()).toBe(before);
    expect(result.added).toBe(0);
  });

  it('never throws when one file fails to read, and still processes the rest', async () => {
    const index = await FrontmatterIndex.build(vault);
    await vault.write('good.md', '---\nk: 1\n---\nGood');
    const originalRead = vault.read.bind(vault);
    vault.read = (async (p: string) => {
      if (p === 'good.md') throw new Error('simulated read failure');
      return originalRead(p);
    }) as typeof vault.read;
    await vault.write('a.md', '---\ntype: project\nstatus: DONE\n---\nA');

    await expect(index.reconcile(vault)).resolves.toBeDefined();
    expect(index.get('good.md')).toBeUndefined(); // failed read: left un-added, never throws
    expect(index.get('a.md')?.frontmatter).toMatchObject({ status: 'DONE' }); // other files still refresh
  });
});

describe('what a hostile or odd note cannot do to the index', () => {
  it('keeps a `__proto__` frontmatter key as an ordinary key, never as the prototype', async () => {
    await fs.writeFile(
      path.join(root, 'proto.md'),
      '---\n__proto__:\n  status: smuggled\ntitle: alpha\n---\n',
    );
    const index = await FrontmatterIndex.build(vault);
    const fm = index.get('proto.md')?.frontmatter ?? {};
    expect(Object.keys(fm).sort()).toEqual(['__proto__', 'title']);
    expect((fm as { status?: unknown }).status).toBeUndefined(); // not inherited
    expect(index.query({ field: 'status', equals: 'smuggled' })).toEqual([]);
  });

  it('builds past a note whose frontmatter refers to itself, and reads it as body-only', async () => {
    await fs.writeFile(path.join(root, 'cycle.md'), '---\na: &x\n  b: *x\n---\nbody\n');
    const index = await FrontmatterIndex.build(vault);
    expect(index.get('a.md')).toBeDefined();
    expect(index.get('cycle.md')).toMatchObject({ hasFrontmatter: false, frontmatter: {} });
    const note = await vault.read('cycle.md');
    expect(note.frontmatterError).toMatch(/refers to itself/);
    expect(() => JSON.stringify(note)).not.toThrow();
  });

  it('measures its size in bytes, not in UTF-16 units', async () => {
    const index = await FrontmatterIndex.build(vault);
    const base = index.byteSize();
    const entry = async (p: string, title: string) =>
      FrontmatterIndex.fromNote(await vault.write(p, `---\ntitle: ${title}\n---\n`));
    index.upsert(await entry('latin.md', 'a'.repeat(1000)));
    const latin = index.byteSize() - base;
    index.remove('latin.md');
    index.upsert(await entry('other.md', 'ж'.repeat(1000)));
    expect(index.byteSize() - base).toBe(latin + 1000 + 'other.md'.length - 'latin.md'.length);
  });

  it('refuses a budget that is not a finite number', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(() => index.watchBudget(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => index.watchBudget(Number.NaN)).toThrow(RangeError);
  });
});

describe('a refresh that read a note before a tool rewrote it never overwrites the rewrite', () => {
  it('applyNote() during a slow read wins over the read', async () => {
    // Seen on the macOS runner: the watcher's refresh for the previous version of a note landed
    // after vault_write had applied the new one, and the index held the old links and tags
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-race2-'));
    try {
      await fs.writeFile(path.join(root, 'a.md'), '---\ntags: [old]\n---\nold');
      const adapter = await LocalFSAdapter.create(root, { ripgrepPath: null });
      const index = await FrontmatterIndex.build(adapter);
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const read = adapter.read.bind(adapter);
      adapter.read = async (p) => {
        const note = await read(p); // the OLD version
        await held;
        return note;
      };
      const refresh = index.refreshPath(adapter, 'a.md');
      adapter.read = read;
      const written = await adapter.write('a.md', '---\ntags: [new]\n---\n[[b]]');
      index.applyNote(written);
      release();
      await refresh;
      expect(index.get('a.md')?.tags).toEqual(['new']);
      expect(index.get('a.md')?.links).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('a refresh started by a watcher event never resurrects a note a tool removed meanwhile', () => {
  it('remove() during a slow read wins over the read', async () => {
    // macOS reports a rename as a change: the watcher's refreshPath had stat'ed the note before
    // vault_delete moved it to .trash, and its upsert landed after the tool's index.remove
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-race-'));
    try {
      await fs.writeFile(path.join(root, 'a.md'), '---\nk: 1\n---\n');
      const adapter = await LocalFSAdapter.create(root, { ripgrepPath: null });
      const index = await FrontmatterIndex.build(adapter);
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const read = adapter.read.bind(adapter);
      adapter.read = async (p) => {
        const note = await read(p);
        await held; // the read finished before the removal; its result arrives after
        return note;
      };
      const refresh = index.refreshPath(adapter, 'a.md');
      index.remove('a.md');
      release();
      await refresh;
      expect(index.get('a.md')).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
