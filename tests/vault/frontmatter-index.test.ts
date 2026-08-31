import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { FrontmatterIndex } from '../../src/vault/frontmatter-index.ts';

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
