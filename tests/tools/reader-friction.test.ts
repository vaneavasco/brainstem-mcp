import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_SAFE_RESULT_CHARS } from '../../src/storage/limits.ts';
import { type Harness, startHarness, text } from './harness.ts';

/**
 * Frictions observed when sixteen fresh models answered real multi-step questions through these
 * tools (docs/adr/0007-tool-contract-and-index-reconcile.md, "Addendum 2"). One describe block per
 * item of the brief.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const size = (r: { structuredContent?: unknown }) => JSON.stringify(r.structuredContent).length;

describe('A — vault_list: shallowest first and "folders" file counts, only when truncated', () => {
  it('truncated: all top-level entries/dirs survive, "folders" counts files per folder from the full listing', async () => {
    const longName = (n: number) => `${'a-rather-long-file-name-segment-'.repeat(3)}${n}.md`;
    for (const dir of ['alpha', 'beta', 'gamma']) {
      await fs.mkdir(path.join(h.root, dir), { recursive: true });
      for (let i = 0; i < 400; i += 1) {
        await fs.writeFile(path.join(h.root, dir, longName(i)), '# x\n');
      }
    }
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(h.root, `top-${i}.md`), '# x\n');
    }
    const r = await h.call('vault_list', { depth: 3 });
    expect(r.isError).toBeFalsy();
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as {
      entries: { path: string; kind: string }[];
      folders?: { path: string; files: number }[];
      truncated: boolean;
      hint?: string;
    };
    expect(body.truncated).toBe(true);
    // Shallowest first, then path: the 8 top-level entries (3 dirs + 5 notes) come before any
    // entry nested inside a folder.
    expect(body.entries.slice(0, 8).map((e) => e.path)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'top-0.md',
      'top-1.md',
      'top-2.md',
      'top-3.md',
      'top-4.md',
    ]);
    expect(body.folders).toBeDefined();
    const byPath = new Map((body.folders ?? []).map((f) => [f.path, f.files]));
    expect(byPath.get('alpha')).toBe(400);
    expect(byPath.get('beta')).toBe(400);
    expect(byPath.get('gamma')).toBe(400);
    expect(body.hint).toMatch(/shallowest/);
    expect(body.hint).toMatch(/folders/);
  });

  it('a small listing is unchanged: no "folders" key, same order as before', async () => {
    await fs.mkdir(path.join(h.root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(h.root, 'sub', 'x.md'), '# x\n');
    await fs.writeFile(path.join(h.root, 'a.md'), '# x\n');
    const r = await h.call('vault_list', {});
    const body = r.structuredContent as {
      entries: unknown[];
      truncated: boolean;
      folders?: unknown;
    };
    expect(body.truncated).toBe(false);
    expect(body.folders).toBeUndefined();
    expect(Object.keys(body)).not.toContain('folders');
  });
});

describe('B — vault_query: sum, groupPrefix, and a hint for an empty path prefix', () => {
  it('sum totals over every match, and groupPrefix narrows which group keys come back', async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.call('vault_write', {
        path: `b/topic-${i}.md`,
        content: `---\ncat: topic/${i}\namount: ${i}\n---\nx\n`,
      });
    }
    await h.call('vault_write', {
      path: 'b/other.md',
      content: '---\ncat: other\namount: 100\n---\nx\n',
    });
    await h.runtime.index.reconcile(h.runtime.adapter);

    const sum = await h.call('vault_query', { pathPrefix: 'b', sum: ['amount'] });
    expect(sum.isError).toBeFalsy();
    expect((sum.structuredContent as { sums: { amount: number } }).sums.amount).toBe(
      0 + 1 + 2 + 3 + 4 + 100,
    );

    const grouped = await h.call('vault_query', {
      pathPrefix: 'b',
      groupBy: 'cat',
      groupPrefix: 'topic/',
    });
    expect(grouped.isError).toBeFalsy();
    const body = grouped.structuredContent as { groups: { key: string }[]; total: number };
    expect(body.groups.map((g) => g.key).sort()).toEqual([
      'topic/0',
      'topic/1',
      'topic/2',
      'topic/3',
      'topic/4',
    ]);
    expect(body.total).toBe(6); // groupPrefix narrows the groups shown, not the match total

    const refused = await h.call('vault_query', { groupPrefix: 'topic/' });
    expect(refused.isError).toBe(true);
  });

  it('a hint says so when NO note exists under an empty path prefix, but not when notes exist and simply none matched', async () => {
    await h.call('vault_write', { path: 'real/only.md', content: '# x\n' });
    await h.runtime.index.reconcile(h.runtime.adapter);

    const emptyPrefix = await h.call('vault_query', { pathPrefix: 'nowhere-at-all' });
    expect((emptyPrefix.structuredContent as { total: number }).total).toBe(0);
    expect((emptyPrefix.structuredContent as { hint?: string }).hint).toMatch(
      /no note exists under/i,
    );

    const noMatch = await h.call('vault_query', {
      pathPrefix: 'real',
      where: [{ field: 'status', op: 'eq', value: 'nope' }],
    });
    expect((noMatch.structuredContent as { total: number }).total).toBe(0);
    expect((noMatch.structuredContent as { hint?: string }).hint).toBeUndefined();
  });
});

describe('D — near-miss paths: vault_read and vault_batch_read suggest a typographic near-match', () => {
  it('vault_read: a curly apostrophe in the file name, a straight one in the argument', async () => {
    await h.call('vault_write', {
      path: 'people/Alpha’s note.md',
      content: '# Alpha\n',
    });
    const r = await h.call('vault_read', { path: "people/Alpha's note.md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
    expect(text(r)).toContain('Did you mean: "people/Alpha’s note.md"?');
  });

  it('vault_read: an en dash in the file name, a hyphen in the argument', async () => {
    await h.call('vault_write', { path: 'notes/alpha–beta.md', content: '# x\n' });
    const r = await h.call('vault_read', { path: 'notes/alpha-beta.md' });
    expect(text(r)).toContain('Did you mean: "notes/alpha–beta.md"?');
  });

  it('vault_read: a different case', async () => {
    await h.call('vault_write', { path: 'notes/Report.md', content: '# x\n' });
    const r = await h.call('vault_read', { path: 'notes/report.md' });
    expect(text(r)).toContain('Did you mean: "notes/Report.md"?');
  });

  it('vault_read: no suggestion for a path that simply does not exist', async () => {
    await h.call('vault_write', { path: 'notes/Report.md', content: '# x\n' });
    const r = await h.call('vault_read', { path: 'notes/completely-unrelated.md' });
    expect(text(r)).not.toContain('Did you mean');
  });

  it('vault_read: the NOT_FOUND message stays bounded', async () => {
    await h.call('vault_write', { path: 'notes/Report.md', content: '# x\n' });
    const r = await h.call('vault_read', { path: 'notes/report.md' });
    expect(text(r).length).toBeLessThan(2_000);
  });

  it('vault_batch_read: suggestions travel per missing entry, inside the measured budget', async () => {
    await h.call('vault_write', {
      path: 'people/Alpha’s note.md',
      content: '# Alpha\n',
    });
    await h.call('vault_write', { path: 'notes/Report.md', content: '# x\n' });
    const r = await h.call('vault_batch_read', {
      paths: ["people/Alpha's note.md", 'notes/report.md', 'nowhere/nothing.md'],
    });
    expect(r.isError).toBeFalsy();
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as {
      missing: string[];
      suggestions?: { path: string; didYouMean: string[] }[];
    };
    expect(body.missing.sort()).toEqual(
      ["people/Alpha's note.md", 'notes/report.md', 'nowhere/nothing.md'].sort(),
    );
    const byPath = new Map((body.suggestions ?? []).map((s) => [s.path, s.didYouMean]));
    expect(byPath.get("people/Alpha's note.md")).toEqual(['people/Alpha’s note.md']);
    expect(byPath.get('notes/report.md')).toEqual(['notes/Report.md']);
    expect(byPath.has('nowhere/nothing.md')).toBe(false);
  });

  it('never suggests a path under _brainstem/ or a dot folder (the index never holds either)', async () => {
    await h.call('vault_write', { path: 'notes/Report.md', content: '# x\n' });
    const r = await h.call('vault_read', { path: 'notes/report.md' });
    expect(text(r)).not.toContain('_brainstem/');
    expect(text(r)).not.toContain('.trash/');
  });
});

describe('E — vault_batch_read frontmatter:false gives bodies the room frontmatter would take', () => {
  it('strictly more body text comes back with frontmatter:false, and both fit the cap', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const ids = Array.from({ length: 40 }, (_, k) => `"id-${i}-${k}-${'x'.repeat(40)}"`);
      const content = `---\nids: [${ids.join(', ')}]\n---\n${'word '.repeat(1_200)}\n`;
      paths.push(`bulk/n${i}.md`);
      await h.call('vault_write', { path: `bulk/n${i}.md`, content });
    }
    const withFm = await h.call('vault_batch_read', { paths });
    const withoutFm = await h.call('vault_batch_read', { paths, frontmatter: false });
    expect(withFm.isError).toBeFalsy();
    expect(withoutFm.isError).toBeFalsy();
    expect(size(withFm)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    expect(size(withoutFm)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);

    const bodyChars = (r: { structuredContent?: unknown }) =>
      (r.structuredContent as { notes: { body: string }[] }).notes.reduce(
        (n, note) => n + note.body.length,
        0,
      );
    expect(bodyChars(withoutFm)).toBeGreaterThan(bodyChars(withFm));

    const withoutBody = withoutFm.structuredContent as {
      notes: { frontmatter: object; frontmatterOmitted?: boolean }[];
      hint?: string;
    };
    expect(withoutBody.notes.every((n) => Object.keys(n.frontmatter).length === 0)).toBe(true);
    expect(withoutBody.notes.every((n) => n.frontmatterOmitted === true)).toBe(true);
  });

  it('frontmatter defaults to true: an ordinary note keeps its frontmatter as before', async () => {
    await h.call('vault_write', { path: 'plain.md', content: '---\nstatus: open\n---\nbody\n' });
    const r = await h.call('vault_batch_read', { paths: ['plain.md'] });
    const body = r.structuredContent as { notes: { frontmatter: object }[] };
    expect(body.notes[0]?.frontmatter).toEqual({ status: 'open' });
  });
});
