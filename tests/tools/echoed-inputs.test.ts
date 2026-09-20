import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_SAFE_RESULT_CHARS } from '../../src/storage/limits.ts';
import { type Harness, startHarness } from './harness.ts';

/**
 * ADR 0007: an argument that is echoed back counts against the result, so it is capped where it
 * is declared. A caller cannot make the server answer with 200,000 characters by sending them.
 */
let h: Harness;
const size = (r: { structuredContent?: unknown }) =>
  JSON.stringify(r.structuredContent ?? {}).length;
const huge = 'Z'.repeat(100_000);

beforeAll(async () => {
  h = await startHarness();
  await h.call('vault_write', {
    path: 'n.md',
    content: '---\nstatus: open\ntags: [one]\n---\nhello\n',
  });
});

afterAll(async () => {
  await h.close();
});

describe('arguments that are echoed back are capped where they are declared', () => {
  it.each([
    ['vault_tags', { tag: huge }],
    ['vault_tags', { prefix: huge }],
    ['vault_search_frontmatter', { field: huge, exists: true }],
    ['vault_search', { query: huge }],
    ['vault_list', { glob: `**/*${'Z'.repeat(40_000)}` }],
    ['vault_query', { where: [{ field: huge, op: 'exists' }] }],
    ['vault_read', { path: `${huge}.md` }],
  ] as const)('%s refuses an oversized argument instead of echoing it', async (tool, args) => {
    const r = await h.call(tool, args as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content).length).toBeLessThan(5_000);
    expect(JSON.stringify(r.content)).not.toContain('INTERNAL');
  });

  it('one bad path does not fail a batch', async () => {
    const r = await h.call('vault_batch_read', { paths: ['n.md', '\u0001'.repeat(900)] });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as { notes: unknown[]; failed: unknown[]; missing: unknown[] };
    expect(body.notes).toHaveLength(1);
    expect(body.failed.length + body.missing.length).toBe(1);
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });
});

describe('vault_batch_read pays for its truncation markers', () => {
  it('long paths plus long unknown section names leave no room for bodies, and the result still fits', async () => {
    const folder = `${'p'.repeat(125)}/${'q'.repeat(125)}`;
    await fs.mkdir(path.join(h.root, folder), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      paths.push(`${folder}/n${i}.md`);
      await fs.writeFile(
        path.join(h.root, folder, `n${i}.md`),
        `---\nk: "${'w'.repeat(100)}"\n---\n# H\n${'x'.repeat(10_000)}\n`,
      );
    }
    await h.runtime.index.reconcile(h.runtime.adapter);
    const sections = ['H', ...Array.from({ length: 9 }, (_, i) => `${'s'.repeat(190)}-${i}`)];
    const r = await h.call('vault_batch_read', { paths, sections });
    if (!r.isError) expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    else expect(JSON.stringify(r.content)).toContain('fewer notes or sections');
  });

  it('maxChars does not strand budget that a dense note could use', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 19; i += 1) {
      paths.push(`plain/n${i}.md`);
      await h.call('vault_write', { path: `plain/n${i}.md`, content: 'a'.repeat(100_000) });
    }
    paths.push('plain/dense.md');
    await h.call('vault_write', { path: 'plain/dense.md', content: '\n'.repeat(100_000) });
    const r = await h.call('vault_batch_read', { paths, maxChars: 2_000 });
    const dense = (r.structuredContent as { notes: { path: string; body: string }[] }).notes.find(
      (n) => n.path === 'plain/dense.md',
    );
    expect(dense?.body.startsWith('\n'.repeat(1_900))).toBe(true);
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });
});

describe('vault_search is bounded too', () => {
  it('fifty hits in long paths stay within what a client accepts, and say when they were cut', async () => {
    const folder = `${'s'.repeat(100)}/${'t'.repeat(100)}`;
    await fs.mkdir(path.join(h.root, folder), { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(
        path.join(h.root, folder, `hit-${i}.md`),
        `${'findme word '.repeat(60)}\n`,
      );
    }
    await h.runtime.index.reconcile(h.runtime.adapter);
    const r = await h.call('vault_search', { query: 'findme', limit: 50 });
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    const body = r.structuredContent as { matches: unknown[]; truncated: boolean };
    expect(body.matches.length).toBeGreaterThan(5);
    if (body.matches.length < 50) expect(body.truncated).toBe(true);
  });
});
