import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_QUERY_ROWS, MAX_RECENT } from '../../src/storage/limits.ts';
import { type Harness, startHarness, text } from './harness.ts';

interface QueryResult {
  rows: { path: string; [field: string]: unknown }[];
  total: number;
  truncated: boolean;
  groups?: { key: string; count: number; paths: string[] }[];
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.call('vault_write', {
    path: 'projects/alpha.md',
    content: '---\nstatus: active\npriority: 3\ntags:\n  - proj\n---\n# Alpha',
  });
  await h.call('vault_write', {
    path: 'projects/beta.md',
    content: '---\nstatus: done\npriority: 1\n---\n# Beta',
  });
  await h.call('vault_write', {
    path: 'archive/old.md',
    content: '---\nstatus: active\npriority: 5\n---\n# Old',
  });
});

afterEach(async () => {
  await h.close();
});

describe('vault_query', () => {
  it('filters with where, sorts, and limits fields with select', async () => {
    const r = await h.call('vault_query', {
      where: [{ field: 'status', op: 'eq', value: 'active' }],
      sort: [{ field: 'priority', order: 'desc' }],
      select: ['status', 'tags'],
    });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.rows).toEqual([
      { path: 'archive/old.md', status: 'active', tags: [] },
      { path: 'projects/alpha.md', status: 'active', tags: ['proj'] },
    ]);
  });

  it('restricts to a folder with pathPrefix and reports groups', async () => {
    const r = await h.call('vault_query', { pathPrefix: 'projects', groupBy: 'status' });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.rows.map((row) => row.path).sort()).toEqual([
      'projects/alpha.md',
      'projects/beta.md',
    ]);
    const byKey = new Map((body.groups ?? []).map((g) => [g.key, g]));
    expect(byKey.get('active')).toMatchObject({ count: 1, paths: ['projects/alpha.md'] });
    expect(byKey.get('done')).toMatchObject({ count: 1, paths: ['projects/beta.md'] });
  });

  it('countOnly returns the group counts without rows or example paths', async () => {
    const r = await h.call('vault_query', {
      pathPrefix: 'projects',
      groupBy: 'status',
      countOnly: true,
    });
    const body = r.structuredContent as QueryResult;
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(2);
    expect(body.groups).toEqual(
      expect.arrayContaining([
        { key: 'active', count: 1, paths: [] },
        { key: 'done', count: 1, paths: [] },
      ]),
    );
  });

  it('grouping by a list field says that the groups overlap', async () => {
    await h.call('vault_write', {
      path: 'projects/gamma.md',
      content: '---\nstatus: active\nkinds: [draft, review]\n---\n# Gamma',
    });
    const lists = await h.call('vault_query', {
      where: [{ field: 'kinds', op: 'exists' }],
      groupBy: 'kinds',
      countOnly: true,
    });
    const body = lists.structuredContent as QueryResult & { hint?: string };
    expect(body.total).toBe(1);
    expect(body.groups?.map((g) => g.count)).toEqual([1, 1]);
    expect(body.hint).toContain('more than "total"');
    const scalar = await h.call('vault_query', { pathPrefix: 'projects', groupBy: 'status' });
    expect(scalar.structuredContent).not.toHaveProperty('hint');
  });

  it('countOnly without groupBy is just the total, whatever limit says', async () => {
    const r = await h.call('vault_query', { pathPrefix: 'projects', countOnly: true, limit: 1 });
    expect(r.structuredContent).toEqual({ rows: [], total: 2, truncated: false });
  });

  it('filters by nested-aware tags', async () => {
    const r = await h.call('vault_query', { tags: { any: ['proj'] } });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.rows.map((row) => row.path)).toEqual(['projects/alpha.md']);
  });

  it('rejects an invalid regex with INVALID_INPUT', async () => {
    const r = await h.call('vault_query', {
      where: [{ field: 'status', op: 'regex', value: '(a)\\1' }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^INVALID_INPUT: /);
  });

  it('rejects a limit above MAX_QUERY_ROWS at the input-schema boundary', async () => {
    const r = await h.call('vault_query', { limit: MAX_QUERY_ROWS + 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid arguments for tool vault_query/);
    expect(text(r)).toMatch(/limit/);
  });
});

describe('vault_recent', () => {
  it('orders by modifiedAt desc and includes modifiedAt/size/wordCount', async () => {
    const r = await h.call('vault_recent', {});
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.rows).toHaveLength(3);
    // most recently written note first
    expect(body.rows[0]?.path).toBe('archive/old.md');
    for (const row of body.rows) {
      expect(typeof row.modifiedAt).toBe('string');
      expect(typeof row.size).toBe('number');
      expect(typeof row.wordCount).toBe('number');
      expect(row.status).toBeUndefined(); // select is fixed; frontmatter fields are not included
    }
    // strictly non-increasing modifiedAt
    const times = body.rows.map((row) => Date.parse(row.modifiedAt as string));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1] as number);
    }
  });

  it('filters by since', async () => {
    const all = await h.call('vault_recent', {});
    const allBody = all.structuredContent as QueryResult;
    const cutoff = allBody.rows[0]?.modifiedAt as string;
    const r = await h.call('vault_recent', { since: cutoff });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.rows.map((row) => row.path)).toEqual([allBody.rows[0]?.path]);
  });

  it('honors limit and pathPrefix', async () => {
    const r = await h.call('vault_recent', { pathPrefix: 'projects', limit: 1 });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as QueryResult;
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.path.startsWith('projects/')).toBe(true);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
  });

  it('rejects a limit above MAX_RECENT at the input-schema boundary', async () => {
    const r = await h.call('vault_recent', { limit: MAX_RECENT + 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid arguments for tool vault_recent/);
  });

  it('rejects a since value that is not an ISO date/datetime', async () => {
    const r = await h.call('vault_recent', { since: 'not-a-date' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid arguments for tool vault_recent/);
  });
});
