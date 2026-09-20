import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.call('vault_write', { path: 'n.md', content: '---\nstatus: draft\n---\n# N\n' });
});

afterEach(async () => {
  await h.close();
});

describe('tool arguments nobody asked for are an error, never ignored', () => {
  it('a misspelled key on a metadata update fails loudly instead of changing nothing', async () => {
    const r = await h.call('vault_frontmatter_update', {
      path: 'n.md',
      updates: { status: 'review' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('updates');
    const after = await h.call('vault_read', { path: 'n.md' });
    expect(text(after)).toContain('status: draft');
  });

  it('a misspelled expectedHash cannot switch the concurrency check off silently', async () => {
    const r = await h.call('vault_write', {
      path: 'n.md',
      content: '# overwritten\n',
      expected_hash: 'stale',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('expected_hash');
    const after = await h.call('vault_read', { path: 'n.md' });
    expect(text(after)).toContain('status: draft');
  });

  it('nested objects are strict too: a where condition and a sort key', async () => {
    const where = await h.call('vault_query', {
      where: [{ field: 'status', op: 'eq', value: 'draft', caseSensitive: true }],
    });
    expect(where.isError).toBe(true);
    expect(text(where)).toContain('caseSensitive');
    const sort = await h.call('vault_query', { sort: [{ field: 'status', direction: 'asc' }] });
    expect(sort.isError).toBe(true);
    expect(text(sort)).toContain('direction');
  });

  it('a correct call is unaffected', async () => {
    const r = await h.call('vault_frontmatter_update', { path: 'n.md', set: { status: 'review' } });
    expect(r.isError).toBeFalsy();
  });
});
