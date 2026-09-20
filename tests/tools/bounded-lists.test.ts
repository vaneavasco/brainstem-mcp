import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_SAFE_RESULT_CHARS } from '../../src/storage/limits.ts';
import { fitListsWithinBudget, fitWithinBudget } from '../../src/vault/budget.ts';
import { type Harness, startHarness } from './harness.ts';

/** ADR 0007: a list a client would refuse is cut to what it accepts, and says so. */
let h: Harness;
const FOLDER = `long/${'a-folder-name-that-is-rather-long-'.repeat(2)}`;
const size = (r: { structuredContent?: unknown }) => JSON.stringify(r.structuredContent).length;

beforeAll(async () => {
  h = await startHarness();
  await fs.mkdir(path.join(h.root, FOLDER), { recursive: true });
  const hub = '# Hub\n';
  await fs.writeFile(path.join(h.root, 'hub.md'), hub);
  for (let i = 0; i < 900; i += 1) {
    const name = `${String(i).padStart(4, '0')}-${'subject-words-'.repeat(4)}.md`;
    const tags = `[t${i}-${'x'.repeat(40)}, shared]`;
    await fs.writeFile(
      path.join(h.root, FOLDER, name),
      `---\nkind: item\ntags: ${tags}\n---\nsee [[hub]] and [[${String((i + 1) % 900).padStart(4, '0')}-${'subject-words-'.repeat(4)}]]\n`,
    );
  }
  await h.runtime.index.reconcile(h.runtime.adapter);
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('list-returning tools stay within what a client accepts', () => {
  it('vault_list', async () => {
    const r = await h.call('vault_list', { path: 'long', depth: 3 });
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as { entries: unknown[]; truncated: boolean; hint?: string };
    expect(body.truncated).toBe(true);
    expect(body.entries.length).toBeGreaterThan(50);
    expect(body.hint).toMatch(/of 90\d entries/);
  });

  it('vault_links on a hub', async () => {
    const r = await h.call('vault_links', { path: 'hub.md' });
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as {
      backlinks: unknown[];
      truncated: { backlinks: boolean };
      total: { backlinks: number };
      hint?: string;
    };
    expect(body.total.backlinks).toBe(900);
    expect(body.truncated.backlinks).toBe(true);
    expect(body.hint).toContain('filter.pathPrefix');
  });

  it('vault_tags', async () => {
    const r = await h.call('vault_tags', {});
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as {
      tags: unknown[];
      total: number;
      truncated?: boolean;
      hint?: string;
    };
    expect(body.total).toBe(901);
    expect(body.truncated).toBe(true);
    expect(body.hint).toContain('prefix');
  });

  it('vault_search_frontmatter', async () => {
    const r = await h.call('vault_search_frontmatter', { field: 'kind', equals: 'item' });
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    expect((r.structuredContent as { truncated: boolean }).truncated).toBe(true);
  });

  it('a path of many hundred characters is paid for out of the same budget', async () => {
    const deep = ['a', 'b', 'c', 'd'].map((c) => c.repeat(230)).join('/');
    await fs.mkdir(path.join(h.root, deep), { recursive: true });
    for (let i = 0; i < 120; i += 1) {
      await fs.writeFile(path.join(h.root, deep, `n${i}.md`), `see [[hub]]\n`);
    }
    await fs.writeFile(path.join(h.root, deep, 'center.md'), '# center\n');
    await h.runtime.index.reconcile(h.runtime.adapter);
    const listed = await h.call('vault_list', { path: deep });
    expect(size(listed)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const links = await h.call('vault_links', { path: 'hub.md' });
    expect(size(links)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });

  it('a small result is untouched', async () => {
    const r = await h.call('vault_list', { path: '' });
    const body = r.structuredContent as { truncated: boolean; hint?: string };
    expect(body.truncated).toBe(false);
    expect(body.hint).toBeUndefined();
  });
});

describe('budget helpers', () => {
  it('fitWithinBudget is exact against JSON.stringify', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ path: `p/${i}.md`, note: 'é"\n' }));
    const { kept, cut } = fitWithinBudget(items, 500);
    expect(cut).toBe(true);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify([...kept, items[kept.length]]).length).toBeGreaterThan(500);
  });

  it('several lists share one budget: the short one is whole, the long ones split the rest', () => {
    const short = ['a', 'b'];
    const long = Array.from({ length: 400 }, (_, i) => `item-number-${i}`);
    const { kept, cut } = fitListsWithinBudget([long, short, [...long]], 2_000);
    expect(kept[1]).toEqual(short);
    expect(cut).toEqual([true, false, true]);
    expect(kept.reduce((n, l) => n + JSON.stringify(l).length, 0)).toBeLessThanOrEqual(2_000);
  });
});
