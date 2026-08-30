import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_GRAPH_ITEMS } from '../../src/storage/limits.ts';
import { type Harness, startHarness, text } from './harness.ts';

interface OutgoingLink {
  target: string;
  kind: 'wiki' | 'md';
  line: number;
  embed: boolean;
  resolvedPath: string | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  candidates?: string[];
  anchorFound?: boolean;
}

interface ContextHit {
  path: string;
  line: number;
  context: string;
}

interface LinksResult {
  path: string;
  outgoing: OutgoingLink[];
  backlinks: ContextHit[];
  embeds: ContextHit[];
  unlinkedMentions: ContextHit[];
  truncated: { outgoing: boolean; backlinks: boolean; embeds: boolean; unlinkedMentions: boolean };
}

interface TagsListResult {
  tags: { tag: string; count: number; nested: boolean; frontmatter: number; inline: number }[];
  total: number;
}

interface TagsByTagResult {
  tag: string;
  notes: { path: string; sources: ('frontmatter' | 'inline')[] }[];
  total: number;
  truncated: boolean;
}

interface OutlineResult {
  path: string;
  hash: string;
  modifiedAt: string;
  size: number;
  wordCount: number;
  frontmatterKeys: string[];
  tags: string[];
  headings: { level: number; text: string; line: number; children: unknown[] }[];
  blockIds: { id: string; line: number }[];
  linkCount: number;
  backlinkCount: number;
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

/**
 * The graph fixture shared by the vault_links tests: a.md links to b.md (with three anchor
 * variants), an ambiguous "dup" target, an unresolved "Missing" target, and both a plain and an
 * embedded link to c.md. b.md carries an alias ("Bee") so unlinkedMentions has something to find
 * in m.md, which mentions "the Bee note and b" in plain text without ever linking to either.
 */
async function seedLinkGraph(harness: Harness): Promise<void> {
  await harness.call('vault_write', {
    path: 'a.md',
    content: '[[b]] [[c|C]] [[Missing]] [[dup]] ![[c]] [[b#Sec]] [[b#^blk]] [[b#Nope]]',
  });
  await harness.call('vault_write', {
    path: 'b.md',
    content: '---\naliases:\n  - Bee\n---\n# Sec\ntext ^blk\n[[a]]',
  });
  await harness.call('vault_write', {
    path: 'c.md',
    content: '---\ntags:\n  - T1\n  - proj\n---\n#t1 #proj/x\n[[folder/dup]]',
  });
  await harness.call('vault_write', { path: 'dup.md', content: 'x' });
  await harness.call('vault_write', { path: 'folder/dup.md', content: 'x' });
  await harness.call('vault_write', { path: 'lonely.md', content: 'no links' });
  await harness.call('vault_write', { path: 'm.md', content: 'the Bee note and b are mentioned' });
}

describe('vault_links', () => {
  beforeEach(async () => {
    await seedLinkGraph(h);
  });

  it('reports outgoing link statuses and heading/block anchors', async () => {
    const r = await h.call('vault_links', { path: 'a.md', include: ['outgoing'] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    expect(body.path).toBe('a.md');
    expect(body.outgoing).toHaveLength(8);
    expect(body.truncated).toEqual({
      outgoing: false,
      backlinks: false,
      embeds: false,
      unlinkedMentions: false,
    });

    const byTarget = (target: string) => body.outgoing.filter((o) => o.target === target);

    const missing = byTarget('Missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ status: 'unresolved', resolvedPath: null });

    const dup = byTarget('dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ status: 'ambiguous', resolvedPath: null });
    expect(dup[0]?.candidates).toEqual(['dup.md', 'folder/dup.md']);

    const c = byTarget('c');
    expect(c).toHaveLength(2);
    expect(c.find((o) => !o.embed)).toMatchObject({ status: 'resolved', resolvedPath: 'c.md' });
    expect(c.find((o) => o.embed)).toMatchObject({ status: 'resolved', resolvedPath: 'c.md' });

    const b = byTarget('b');
    expect(b).toHaveLength(4);
    expect(b.every((o) => o.status === 'resolved' && o.resolvedPath === 'b.md')).toBe(true);
    const anchorFlags = b.map((o) => o.anchorFound).sort();
    // one plain [[b]] (no anchor field at all), #Sec and #^blk found, #Nope not found
    expect(anchorFlags).toEqual([false, true, true, undefined]);
  });

  it('returns backlinks with the source line as context', async () => {
    const r = await h.call('vault_links', { path: 'b.md', include: ['backlinks'] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    expect(body.backlinks).toHaveLength(4);
    for (const hit of body.backlinks) {
      expect(hit.path).toBe('a.md');
      expect(hit.line).toBe(1);
      expect(hit.context).toBe(
        '[[b]] [[c|C]] [[Missing]] [[dup]] ![[c]] [[b#Sec]] [[b#^blk]] [[b#Nope]]',
      );
    }
  });

  it('separates embeds from plain backlinks', async () => {
    const r = await h.call('vault_links', { path: 'c.md', include: ['backlinks', 'embeds'] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    expect(body.backlinks).toHaveLength(2);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]).toMatchObject({ path: 'a.md', line: 1 });
    expect(body.embeds[0]?.context).toContain('![[c]]');
  });

  it('finds unlinked mentions by basename and alias, excluding notes that already link', async () => {
    const r = await h.call('vault_links', { path: 'b.md', include: ['unlinkedMentions'] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    // "Bee" (alias) and "b" (basename) both match the same line in m.md, once each — deduped
    // by path+line into a single mention, since it's one line mentioning both.
    expect(body.unlinkedMentions).toHaveLength(1);
    expect(body.unlinkedMentions[0]).toMatchObject({ path: 'm.md', line: 1 });
    expect(body.unlinkedMentions[0]?.context).toContain('Bee');
    // a.md already links to b.md (several times), so it must not show up as an unlinked mention
    // even though its text contains a whole-word "b" inside "[[b]]".
    expect(body.unlinkedMentions.some((mnt) => mnt.path === 'a.md')).toBe(false);
    expect(body.truncated.unlinkedMentions).toBe(false);
  });

  it('defaults to outgoing+backlinks+embeds, excluding unlinkedMentions', async () => {
    const r = await h.call('vault_links', { path: 'a.md' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    expect(body.outgoing.length).toBeGreaterThan(0);
    expect(body.backlinks).toHaveLength(1); // from b.md's [[a]]
    expect(body.unlinkedMentions).toEqual([]);
  });

  it('fails with NOT_FOUND for an unknown note', async () => {
    const r = await h.call('vault_links', { path: 'nope.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
  });
});

describe('vault_links embeds cap', () => {
  it('caps embeds at MAX_GRAPH_ITEMS and reports truncation', async () => {
    await h.call('vault_write', { path: 'target.md', content: 'Target note.' });

    // Write MAX_GRAPH_ITEMS + 1 embedding notes directly through the adapter (bypassing the
    // MCP round trip per note) and refresh the index for each, so the fixture stays fast.
    const total = MAX_GRAPH_ITEMS + 1;
    const paths = Array.from({ length: total }, (_, i) => `embedder-${i}.md`);
    await Promise.all(paths.map((p) => h.runtime.adapter.write(p, '![[target]]')));
    await Promise.all(paths.map((p) => h.runtime.index.refreshPath(h.runtime.adapter, p)));

    const r = await h.call('vault_links', { path: 'target.md', include: ['embeds'] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as LinksResult;
    expect(body.embeds).toHaveLength(MAX_GRAPH_ITEMS);
    expect(body.truncated.embeds).toBe(true);
  });
});

describe('vault_tags', () => {
  beforeEach(async () => {
    await h.call('vault_write', {
      path: 'c.md',
      content: '---\ntags:\n  - T1\n  - proj\n---\n#t1 #proj/x\n[[folder/dup]]',
    });
  });

  it('lists every tag with counts and nested rollup', async () => {
    const r = await h.call('vault_tags', {});
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as TagsListResult;
    expect(body.total).toBe(3);
    const byTag = new Map(body.tags.map((t) => [t.tag, t]));
    expect(byTag.get('proj')).toMatchObject({
      count: 1,
      nested: false,
      frontmatter: 1,
      inline: 1,
    });
    expect(byTag.get('proj/x')).toMatchObject({
      count: 1,
      nested: true,
      frontmatter: 0,
      inline: 1,
    });
    expect(byTag.get('T1')).toMatchObject({ count: 1, nested: false, frontmatter: 1, inline: 0 });
  });

  it('filters the tag list by prefix, case-insensitively', async () => {
    const r = await h.call('vault_tags', { prefix: 'PROJ' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as TagsListResult;
    expect(body.total).toBe(2);
    expect(body.tags.map((t) => t.tag).sort()).toEqual(['proj', 'proj/x']);
  });

  it('lists the notes carrying one tag, aggregating nested children by default', async () => {
    const r = await h.call('vault_tags', { tag: 'proj' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as TagsByTagResult;
    expect(body.tag).toBe('proj');
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.notes).toEqual([{ path: 'c.md', sources: ['frontmatter', 'inline'] }]);
  });

  it('restricts to the exact tag when includeNested is false', async () => {
    const r = await h.call('vault_tags', { tag: 'proj', includeNested: false });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as TagsByTagResult;
    expect(body.notes).toEqual([{ path: 'c.md', sources: ['frontmatter'] }]);
  });
});

describe('vault_outline', () => {
  beforeEach(async () => {
    await h.call('vault_write', {
      path: 'outline.md',
      content: '---\ntitle: Outline\ntags:\n  - test\n---\n# A\n## B\n### C\n## D',
    });
  });

  it('builds a heading tree and reports index-derived stats', async () => {
    const r = await h.call('vault_outline', { path: 'outline.md' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as OutlineResult;

    expect(body.path).toBe('outline.md');
    expect(typeof body.hash).toBe('string');
    expect(body.hash.length).toBeGreaterThan(0);
    expect(typeof body.modifiedAt).toBe('string');
    expect(body.size).toBeGreaterThan(0);
    expect(body.wordCount).toBe(4); // A, B, C, D
    expect(body.frontmatterKeys.sort()).toEqual(['tags', 'title']);
    expect(body.tags).toEqual(['test']);
    expect(body.blockIds).toEqual([]);
    expect(body.linkCount).toBe(0);
    expect(body.backlinkCount).toBe(0);

    // '# A' / '## B' / '### C' / '## D' -> A.children = [B(children=[C]), D]
    expect(body.headings).toHaveLength(1);
    const a = body.headings[0] as { level: number; text: string; children: unknown[] };
    expect(a).toMatchObject({ level: 1, text: 'A' });
    expect(a.children).toHaveLength(2);
    const [b, d] = a.children as { level: number; text: string; children: unknown[] }[];
    expect(b).toMatchObject({ level: 2, text: 'B' });
    const bChildren = b?.children ?? [];
    expect(bChildren).toHaveLength(1);
    expect((bChildren[0] as { level: number; text: string }).level).toBe(3);
    expect((bChildren[0] as { level: number; text: string }).text).toBe('C');
    expect(d).toMatchObject({ level: 2, text: 'D', children: [] });
  });

  it('counts outgoing links and backlinks from the index', async () => {
    await h.call('vault_write', { path: 'linker.md', content: '[[outline]] [[outline]]' });
    await h.call('vault_write', {
      path: 'outline.md',
      content: '---\ntitle: Outline\n---\n[[linker]]\n# A',
    });
    const r = await h.call('vault_outline', { path: 'outline.md' });
    const body = r.structuredContent as OutlineResult;
    expect(body.linkCount).toBe(1);
    expect(body.backlinkCount).toBe(2);
  });

  it('fails with NOT_FOUND for an unknown note', async () => {
    const r = await h.call('vault_outline', { path: 'nope.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
  });
});
