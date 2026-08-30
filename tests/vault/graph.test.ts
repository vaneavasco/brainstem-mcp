import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { splitFrontmatter } from '../../src/storage/frontmatter.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { FrontmatterIndex, type IndexEntry } from '../../src/vault/frontmatter-index.ts';
import { VaultGraph } from '../../src/vault/graph.ts';
import { parseNote } from '../../src/vault/note-parse.ts';

/** Builds an IndexEntry by hand the way FrontmatterIndex.fromNote() would, without a real file. */
function entry(p: string, content: string): IndexEntry {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(content);
  return {
    path: p,
    frontmatter,
    hasFrontmatter,
    size: content.length,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    hash: sha256hex(content),
    ...parseNote(content, frontmatter, body),
  };
}

let root: string;
let index: FrontmatterIndex;
let graph: VaultGraph;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-graph-'));
  const vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  index = await FrontmatterIndex.build(vault); // empty vault; entries are added by hand below

  index.upsert(
    entry('a.md', '[[b]] [[c|C]] [[Missing]] [[dup]] ![[pic.png]] [[b#Sec]] [[b#^blk]] [[b#Nope]]'),
  );
  index.upsert(entry('b.md', '# Sec\ntext ^blk\n[[a]]'));
  index.upsert(entry('c.md', '---\ntags:\n  - T1\n  - proj\n---\n#t1 #proj/x\n[[folder/dup]]'));
  index.upsert(entry('dup.md', 'x'));
  index.upsert(entry('folder/dup.md', 'x'));
  index.upsert(entry('lonely.md', 'no links'));
  index.addAsset('img/pic.png');
  index.addAsset('boards/b.canvas'); // same basename as b.md — must not create ambiguity for `[[b]]`

  graph = new VaultGraph(index);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolve', () => {
  it('resolves by vault path or basename, case-insensitively, and reports ambiguity', () => {
    expect(graph.resolve('b', 'a.md')).toEqual({ status: 'resolved', path: 'b.md' });
    expect(graph.resolve('B', 'a.md')).toEqual({ status: 'resolved', path: 'b.md' });
    expect(graph.resolve('dup', 'a.md')).toEqual({
      status: 'ambiguous',
      candidates: ['dup.md', 'folder/dup.md'],
    });
    expect(graph.resolve('folder/dup', 'c.md')).toEqual({
      status: 'resolved',
      path: 'folder/dup.md',
    });
    expect(graph.resolve('Missing', 'a.md')).toEqual({ status: 'unresolved' });
    expect(graph.resolve('pic.png', 'a.md')).toEqual({ status: 'resolved', path: 'img/pic.png' });
    expect(graph.resolve('', 'a.md')).toEqual({ status: 'resolved', path: 'a.md' });
  });

  it('only matches an asset by basename when the target itself carries a non-.md extension', () => {
    // 'b' alone must resolve to the note, not the like-named boards/b.canvas asset.
    expect(graph.resolve('b', 'a.md')).toEqual({ status: 'resolved', path: 'b.md' });
    expect(graph.resolve('b.canvas', 'a.md')).toEqual({
      status: 'resolved',
      path: 'boards/b.canvas',
    });
  });
});

describe('outgoing', () => {
  it('reports anchorFound for headings and block ids independently of link resolution', () => {
    const out = graph.outgoing('a.md');
    const bySec = out.find((o) => o.link.raw === '[[b#Sec]]');
    const byBlk = out.find((o) => o.link.raw === '[[b#^blk]]');
    const byNope = out.find((o) => o.link.raw === '[[b#Nope]]');
    expect(bySec?.resolution).toEqual({ status: 'resolved', path: 'b.md', anchorFound: true });
    expect(byBlk?.resolution).toEqual({ status: 'resolved', path: 'b.md', anchorFound: true });
    expect(byNope?.resolution).toEqual({ status: 'resolved', path: 'b.md', anchorFound: false });
  });
});

describe('backlinks, embeds and hubs', () => {
  it('inverts every resolved outgoing link (one entry per link, not per source note)', () => {
    const back = graph.backlinks('b.md');
    expect(back).toHaveLength(4); // [[b]], [[b#Sec]], [[b#^blk]], [[b#Nope]] all target 'b'
    expect(back.every((b) => b.source === 'a.md')).toBe(true);
  });

  it('filters backlinks to embeds only', () => {
    const embeds = graph.embedsOf('img/pic.png');
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toMatchObject({ source: 'a.md', link: { target: 'pic.png', embed: true } });
  });

  it('ranks hubs by backlink count desc, then path asc', () => {
    expect(graph.hubs(1)).toEqual([{ path: 'b.md', backlinks: 4 }]);
  });
});

describe('tags', () => {
  it('folds case, keeps the first spelling seen, classifies source, and keeps nested tags whole', () => {
    const list = graph.tags();
    const t1 = list.find((t) => t.tag.toLowerCase() === 't1');
    const proj = list.find((t) => t.tag === 'proj');
    const projX = list.find((t) => t.tag === 'proj/x');
    // c.md writes 'T1' in frontmatter and '#t1' inline; parseNote's own case-fold dedup keeps
    // only the first spelling ('T1'), so the tag is classified frontmatter, not both.
    expect(t1).toMatchObject({ tag: 'T1', count: 1, nested: false, frontmatter: 1, inline: 0 });
    expect(proj).toMatchObject({ nested: false });
    expect(projX).toMatchObject({ nested: true, frontmatter: 0, inline: 1 });
  });

  it('aggregates a nested child into its parent, counting distinct notes rather than summing', () => {
    const proj = graph.tags().find((t) => t.tag === 'proj');
    // c.md contributes to 'proj' twice: once as its own literal frontmatter tag, once via the
    // nested inline child 'proj/x'. count must still be 1 distinct note, even though frontmatter
    // and inline are each 1 (the same note counted under both source buckets).
    expect(proj).toEqual({ tag: 'proj', count: 1, nested: false, frontmatter: 1, inline: 1 });
  });
});

describe('notesWithTag', () => {
  it('includes nested children by default and can be restricted to the exact tag', () => {
    expect(graph.notesWithTag('proj')).toEqual([
      { path: 'c.md', sources: ['frontmatter', 'inline'] },
    ]);
    expect(graph.notesWithTag('proj', false)).toEqual([{ path: 'c.md', sources: ['frontmatter'] }]);
  });
});

describe('orphans', () => {
  it('flags markdown notes with neither a resolved outgoing link nor a backlink', () => {
    // dup.md and folder/dup.md share a basename, so the only link targeting 'dup' is ambiguous and
    // resolves to neither — folder/dup.md instead gets its one backlink from c.md's path-qualified
    // [[folder/dup]] link, leaving only dup.md and lonely.md orphaned.
    expect(graph.orphans()).toEqual(['dup.md', 'lonely.md']);
    expect(graph.orphans((p) => p.startsWith('dup'))).toEqual(['lonely.md']);
  });
});

describe('unresolved and ambiguous', () => {
  it('collects unresolved link targets', () => {
    const list = graph.unresolved();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'a.md', link: { target: 'Missing' } });
  });

  it('collects ambiguous link targets with their sorted candidates', () => {
    const list = graph.ambiguous();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: 'a.md',
      link: { target: 'dup' },
      candidates: ['dup.md', 'folder/dup.md'],
    });
  });
});

describe('freshness', () => {
  it('rebuilds derived maps only when index.version changes', () => {
    expect(graph.orphans()).toContain('lonely.md');
    const rebuildsAfterFirst = (graph as unknown as { rebuilds: number }).rebuilds;
    expect(rebuildsAfterFirst).toBeGreaterThan(0);

    graph.orphans(); // no index mutation in between
    expect((graph as unknown as { rebuilds: number }).rebuilds).toBe(rebuildsAfterFirst);

    index.upsert(entry('lonely.md', '[[a]]')); // bumps index.version
    expect(graph.orphans()).not.toContain('lonely.md');
    const rebuildsAfterUpsert = (graph as unknown as { rebuilds: number }).rebuilds;
    expect(rebuildsAfterUpsert).toBe(rebuildsAfterFirst + 1);

    graph.orphans();
    expect((graph as unknown as { rebuilds: number }).rebuilds).toBe(rebuildsAfterUpsert);
  });
});
