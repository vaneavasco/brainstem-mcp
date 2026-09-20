import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_SAFE_RESULT_CHARS } from '../../src/storage/limits.ts';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const size = (r: { structuredContent?: unknown }) => JSON.stringify(r.structuredContent).length;

/** One anchor of ~10 KB used 99 times: under the YAML parser's own alias limit, a 1 MB file that
 *  means 96 MB once every alias is written out, which is what a copy or JSON does. */
function aliasAmplifier(): string {
  const anchor = `base: &b\n${Array.from({ length: 100 }, (_, i) => `  k${i}: ${'v'.repeat(9_000)}`).join('\n')}\n`;
  const uses = Array.from({ length: 99 }, (_, i) => `use${i}: *b`).join('\n');
  return `---\n${anchor}${uses}\n---\nbody\n`;
}

describe('frontmatter cannot be larger than a file may be, however it is written', () => {
  it('reads an alias amplifier as body-only, with the reason, and indexes it as such', async () => {
    await fs.writeFile(path.join(h.root, 'amp.md'), aliasAmplifier());
    await h.runtime.index.reconcile(h.runtime.adapter);
    const before = h.runtime.index.byteSize();
    expect(before).toBeLessThan(100_000);
    const r = await h.call('vault_read', { path: 'amp.md', maxChars: 1000 });
    expect(r.isError).toBeFalsy();
    expect(size(r)).toBeLessThan(10_000);
    expect(h.runtime.index.get('amp.md')).toMatchObject({ hasFrontmatter: false });
    const update = await h.call('vault_frontmatter_update', { path: 'amp.md', set: { t: 1 } });
    expect(update.isError).toBe(true);
    expect(text(update)).toMatch(/too large/);
  });
});

describe('a large frontmatter block does not travel with every result', () => {
  const big = `---\n${Array.from({ length: 60 }, (_, i) => `field${i}: ${'x'.repeat(1_000)}`).join('\n')}\nstatus: open\n---\n# Title\n\nshort body\n`;

  it('vault_read leaves it out, says so, and the note still reads', async () => {
    await h.call('vault_write', { path: 'big.md', content: big });
    const r = await h.call('vault_read', { path: 'big.md', section: 'Title' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as {
      frontmatter: object;
      frontmatterOmitted?: boolean;
      hint?: string;
      text: string;
    };
    expect(body.frontmatterOmitted).toBe(true);
    expect(body.frontmatter).toEqual({});
    expect(body.hint).toMatch(/vault_query/);
    expect(body.text).toContain('short body');
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });

  it('vault_frontmatter_update does the same and still writes', async () => {
    await h.call('vault_write', { path: 'big.md', content: big });
    const r = await h.call('vault_frontmatter_update', { path: 'big.md', set: { status: 'done' } });
    expect(r.isError).toBeFalsy();
    expect(size(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
    expect((r.structuredContent as { frontmatterOmitted?: boolean }).frontmatterOmitted).toBe(true);
    expect(await fs.readFile(path.join(h.root, 'big.md'), 'utf8')).toContain('status: done');
  });

  it('an ordinary note keeps its frontmatter in the result', async () => {
    await h.call('vault_write', { path: 'small.md', content: '---\nstatus: open\n---\nbody\n' });
    const r = await h.call('vault_read', { path: 'small.md' });
    const body = r.structuredContent as { frontmatter: object; frontmatterOmitted?: boolean };
    expect(body.frontmatter).toEqual({ status: 'open' });
    expect(body.frontmatterOmitted).toBeUndefined();
  });
});

describe('YAML sets and ordered maps are values, not empty objects', () => {
  it('reads a !!set as a list, so it can be queried and rewritten without damage', async () => {
    await fs.writeFile(
      path.join(h.root, 'set.md'),
      '---\nmembers: !!set\n  ? alpha\n  ? beta\n---\nbody\n',
    );
    await h.runtime.index.reconcile(h.runtime.adapter);
    const r = await h.call('vault_read', { path: 'set.md' });
    expect((r.structuredContent as { frontmatter: unknown }).frontmatter).toEqual({
      members: ['alpha', 'beta'],
    });
    const q = await h.call('vault_query', {
      where: [{ field: 'members', op: 'contains', value: 'beta' }],
    });
    expect((q.structuredContent as { total: number }).total).toBe(1);
  });

  it('refuses a set that contains itself, like any other cycle', async () => {
    await fs.writeFile(
      path.join(h.root, 'cyc.md'),
      '---\na: &x !!set {? *x, ? alpha}\n---\nbody\n',
    );
    const r = await h.call('vault_frontmatter_update', { path: 'cyc.md', set: { t: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/refers to itself/);
    expect(await fs.readFile(path.join(h.root, 'cyc.md'), 'utf8')).not.toContain('t: 1');
  });
});

describe('`__proto__` is a key like any other, or it is refused; never dropped in silence', () => {
  it('vault_query select returns a `__proto__` column in rows format', async () => {
    await fs.writeFile(path.join(h.root, 'p.md'), '---\n__proto__:\n  beta: 1\n---\n');
    await h.runtime.index.reconcile(h.runtime.adapter);
    const r = await h.call('vault_query', {
      where: [{ field: 'path', op: 'eq', value: 'p.md' }],
      select: ['__proto__'],
    });
    const row = (r.structuredContent as { rows: Record<string, unknown>[] }).rows[0] ?? {};
    expect(Object.keys(row)).toContain('__proto__');
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({ path: 'p.md' });
  });

  it('vault_frontmatter_update refuses to set it, single and batch', async () => {
    await h.call('vault_write', { path: 'plain.md', content: '---\na: 1\n---\n' });
    const args = JSON.parse('{"path":"plain.md","set":{"__proto__":{"x":1}}}');
    const single = await h.call('vault_frontmatter_update', args);
    expect(single.isError).toBe(true);
    expect(text(single)).toMatch(/__proto__/);
    const batch = await h.call('vault_batch_frontmatter_update', { items: [args] });
    const out = batch.structuredContent as { updated?: string[] } | undefined;
    expect(batch.isError === true || (out?.updated ?? []).length === 0).toBe(true);
  });
});
