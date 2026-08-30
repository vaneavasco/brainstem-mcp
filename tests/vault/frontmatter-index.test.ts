import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { FrontmatterIndex } from '../../src/vault/frontmatter-index.ts';

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
