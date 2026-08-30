import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { splitFrontmatter } from '../../src/storage/frontmatter.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { VaultError } from '../../src/storage/types.ts';
import { FrontmatterIndex, type IndexEntry } from '../../src/vault/frontmatter-index.ts';
import { VaultGraph } from '../../src/vault/graph.ts';
import { parseNote } from '../../src/vault/note-parse.ts';
import { evaluateQuery, fieldValue, type Query } from '../../src/vault/query.ts';

/** Builds an IndexEntry by hand the way FrontmatterIndex.fromNote() would, without a real file. */
function entry(
  p: string,
  content: string,
  opts?: { modifiedAt?: string; size?: number },
): IndexEntry {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(content);
  return {
    path: p,
    frontmatter,
    hasFrontmatter,
    size: opts?.size ?? content.length,
    modifiedAt: opts?.modifiedAt ?? '2026-01-01T00:00:00.000Z',
    hash: sha256hex(content),
    ...parseNote(content, frontmatter, body),
  };
}

let root: string;
let index: FrontmatterIndex;
let graph: VaultGraph;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-query-'));
  const vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  index = await FrontmatterIndex.build(vault); // empty vault; entries are added by hand below

  index.upsert(
    entry(
      'notes/a.md',
      '---\nstatus: Active\npriority: 3\ndue: 2026-01-05\nowners:\n  - Alice\n  - Bob\n---\n#proj/x [[b]]',
      { modifiedAt: '2026-01-10T00:00:00.000Z' },
    ),
  );
  index.upsert(
    entry(
      'notes/b.md',
      '---\nstatus: inactive\npriority: 5\ndue: 2026-02-10\nowners:\n  - Carol\ntags:\n  - proj\n---\ntext',
      { modifiedAt: '2026-02-01T00:00:00.000Z' },
    ),
  );
  index.upsert(
    entry('notes/c.md', 'no frontmatter here', { modifiedAt: '2026-03-01T00:00:00.000Z' }),
  );
  index.upsert(
    entry('archive/d.md', '---\nstatus: Active\npriority: 1\n---\narchived', {
      modifiedAt: '2025-12-01T00:00:00.000Z',
    }),
  );

  graph = new VaultGraph(index);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function run(q: Query) {
  return evaluateQuery(index.all(), graph, q);
}

function paths(r: ReturnType<typeof run>): string[] {
  return r.rows.map((row) => row.path).sort();
}

describe('fieldValue — virtual fields', () => {
  it('resolves every virtual field', () => {
    const a = index.get('notes/a.md');
    if (!a) throw new Error('fixture missing');
    expect(fieldValue(a, graph, 'path')).toBe('notes/a.md');
    expect(fieldValue(a, graph, 'basename')).toBe('a');
    expect(fieldValue(a, graph, 'folder')).toBe('notes');
    expect(fieldValue(a, graph, 'modifiedAt')).toBe('2026-01-10T00:00:00.000Z');
    expect(fieldValue(a, graph, 'size')).toBe(a.size);
    expect(fieldValue(a, graph, 'wordCount')).toBe(a.wordCount);
    expect(fieldValue(a, graph, 'hash')).toBe(a.hash);
    expect(fieldValue(a, graph, 'tags')).toEqual(['proj/x']);
    expect(fieldValue(a, graph, 'outgoing')).toEqual(['notes/b.md']);

    const b = index.get('notes/b.md');
    if (!b) throw new Error('fixture missing');
    expect(fieldValue(b, graph, 'backlinks')).toEqual(['notes/a.md']);
  });

  it('resolves a root-level file to folder ""', () => {
    index.upsert(entry('root.md', 'x'));
    const r = index.get('root.md');
    if (!r) throw new Error('fixture missing');
    expect(fieldValue(r, graph, 'folder')).toBe('');
    expect(fieldValue(r, graph, 'basename')).toBe('root');
  });

  it('falls back to a frontmatter dot path for any other field name', () => {
    const a = index.get('notes/a.md');
    if (!a) throw new Error('fixture missing');
    expect(fieldValue(a, graph, 'status')).toBe('Active');
    expect(fieldValue(a, graph, 'owners')).toEqual(['Alice', 'Bob']);
    expect(fieldValue(a, graph, 'nope.nested')).toBeUndefined();
  });
});

describe('evaluateQuery — where operators by type', () => {
  it('eq: numbers compare numerically', () => {
    expect(paths(run({ where: [{ field: 'priority', op: 'eq', value: 3 }] }))).toEqual([
      'notes/a.md',
    ]);
  });

  it('eq: strings compare case-insensitively', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'eq', value: 'active' }] }))).toEqual([
      'archive/d.md',
      'notes/a.md',
    ]);
  });

  it('eq: ISO date/datetime strings compare chronologically across representations', () => {
    expect(
      paths(run({ where: [{ field: 'due', op: 'eq', value: '2026-01-05T00:00:00.000Z' }] })),
    ).toEqual(['notes/a.md']);
  });

  it('eq: array fields match by membership, case-insensitively', () => {
    expect(paths(run({ where: [{ field: 'owners', op: 'eq', value: 'alice' }] }))).toEqual([
      'notes/a.md',
    ]);
  });

  it('neq: is the negation of eq, including for a missing field', () => {
    expect(paths(run({ where: [{ field: 'priority', op: 'neq', value: 3 }] }))).toEqual([
      'archive/d.md',
      'notes/b.md',
      'notes/c.md',
    ]);
  });

  it('contains: substring on a string field, case-insensitively', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'contains', value: 'CTIV' }] }))).toEqual([
      'archive/d.md',
      'notes/a.md',
      'notes/b.md',
    ]);
  });

  it('contains: matches if any array element contains the substring', () => {
    expect(paths(run({ where: [{ field: 'owners', op: 'contains', value: 'aro' }] }))).toEqual([
      'notes/b.md',
    ]);
  });

  it('startsWith: case-insensitive prefix on a string field', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'startsWith', value: 'IN' }] }))).toEqual([
      'notes/b.md',
    ]);
  });

  it('exists: true (default) requires the field to be present', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'exists' }] }))).toEqual([
      'archive/d.md',
      'notes/a.md',
      'notes/b.md',
    ]);
  });

  it('exists: value:false requires the field to be absent', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'exists', value: false }] }))).toEqual([
      'notes/c.md',
    ]);
  });

  it('gt/gte/lt/lte: numeric ordering', () => {
    expect(paths(run({ where: [{ field: 'priority', op: 'gt', value: 2 }] }))).toEqual([
      'notes/a.md',
      'notes/b.md',
    ]);
    expect(paths(run({ where: [{ field: 'priority', op: 'lte', value: 1 }] }))).toEqual([
      'archive/d.md',
    ]);
  });

  it('gt/lt: chronological ordering on ISO date strings; a missing field never matches', () => {
    expect(paths(run({ where: [{ field: 'due', op: 'gt', value: '2026-01-10' }] }))).toEqual([
      'notes/b.md',
    ]);
  });

  it('gt: falls back to case-insensitive string ordering for non-numeric, non-date strings', () => {
    expect(paths(run({ where: [{ field: 'status', op: 'gt', value: 'active' }] }))).toEqual([
      'notes/b.md',
    ]);
  });

  it('in: value must be an array; membership is case-insensitive', () => {
    expect(
      paths(run({ where: [{ field: 'status', op: 'in', value: ['active', 'archived'] }] })),
    ).toEqual(['archive/d.md', 'notes/a.md']);
  });

  it('in: throws INVALID_INPUT when value is not an array', () => {
    expect(() => run({ where: [{ field: 'status', op: 'in', value: 'active' }] })).toThrowError(
      VaultError,
    );
  });

  it('regex: case-insensitive pattern over String(field)', () => {
    expect(paths(run({ where: [{ field: 'path', op: 'regex', value: '^notes/' }] }))).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
    ]);
  });

  it('regex: rejects patterns over 200 characters with INVALID_INPUT', () => {
    const pattern = `a${'b'.repeat(200)}`;
    try {
      run({ where: [{ field: 'status', op: 'regex', value: pattern }] });
      expect.unreachable('expected evaluateQuery to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe('INVALID_INPUT');
    }
  });

  it('regex: rejects a backreference with INVALID_INPUT', () => {
    try {
      run({ where: [{ field: 'status', op: 'regex', value: '(a)\\1' }] });
      expect.unreachable('expected evaluateQuery to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe('INVALID_INPUT');
    }
  });

  it('regex: validates up front, even when no entry would be scanned', () => {
    index.remove('notes/a.md');
    index.remove('notes/b.md');
    index.remove('notes/c.md');
    index.remove('archive/d.md');
    expect(() => run({ where: [{ field: 'status', op: 'regex', value: '(a)\\1' }] })).toThrow();
  });
});

describe('evaluateQuery — pathPrefix', () => {
  it('restricts matches to paths under prefix/', () => {
    expect(paths(run({ pathPrefix: 'notes' }))).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
  });
});

describe('evaluateQuery — tag filters (case-insensitive, nested-aware)', () => {
  it('any: matches a parent filter against a nested child tag', () => {
    expect(paths(run({ tags: { any: ['PROJ'] } }))).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('all: requires every filter tag to match', () => {
    expect(paths(run({ tags: { all: ['proj', 'nope'] } }))).toEqual([]);
    expect(paths(run({ tags: { all: ['proj'] } }))).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('none: excludes notes matching any listed tag', () => {
    expect(paths(run({ tags: { none: ['proj'] } }))).toEqual(['archive/d.md', 'notes/c.md']);
  });
});

describe('evaluateQuery — select', () => {
  it('limits returned fields to path plus the selected ones', () => {
    const r = run({
      where: [{ field: 'status', op: 'eq', value: 'active' }],
      select: ['priority'],
    });
    const row = r.rows.find((x) => x.path === 'notes/a.md');
    expect(row).toEqual({ path: 'notes/a.md', priority: 3 });
  });

  it('returns just path when select is omitted', () => {
    const r = run({ where: [{ field: 'status', op: 'eq', value: 'active' }] });
    for (const row of r.rows) expect(Object.keys(row)).toEqual(['path']);
  });
});

describe('evaluateQuery — sort', () => {
  it('sorts by multiple keys, missing values first, ties broken by the next key', () => {
    const r = run({
      sort: [
        { field: 'status', order: 'asc' },
        { field: 'priority', order: 'desc' },
      ],
    });
    // notes/c.md has no status (sorts first regardless of direction); 'Active' < 'inactive'
    // case-insensitively, and the two 'Active' notes break the tie by priority desc (3 before 1).
    expect(r.rows.map((row) => row.path)).toEqual([
      'notes/c.md',
      'notes/a.md',
      'archive/d.md',
      'notes/b.md',
    ]);
  });
});

describe('evaluateQuery — limit/truncated/total', () => {
  it('caps rows at limit while total reflects every match', () => {
    const r = run({ limit: 2 });
    expect(r.total).toBe(4);
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('defaults limit to 100 and reports truncated:false when under it', () => {
    const r = run({});
    expect(r.total).toBe(4);
    expect(r.rows).toHaveLength(4);
    expect(r.truncated).toBe(false);
  });

  it('clamps a limit above MAX_QUERY_ROWS instead of throwing', () => {
    const r = run({ limit: 100_000 });
    expect(r.rows.length).toBeLessThanOrEqual(500);
    expect(r.truncated).toBe(false); // only 4 fixture entries, well under the cap
  });
});

describe('evaluateQuery — groupBy', () => {
  it('groups by scalar and array values, with "(none)" for a missing field; rows are still returned', () => {
    const r = run({ groupBy: 'owners' });
    expect(r.rows).toHaveLength(4); // groupBy does not filter or replace rows
    const byKey = new Map((r.groups ?? []).map((g) => [g.key, g]));
    expect(byKey.get('Alice')).toMatchObject({ count: 1, paths: ['notes/a.md'] });
    expect(byKey.get('Bob')).toMatchObject({ count: 1, paths: ['notes/a.md'] });
    expect(byKey.get('Carol')).toMatchObject({ count: 1, paths: ['notes/b.md'] });
    const none = byKey.get('(none)');
    expect(none?.count).toBe(2);
    expect(new Set(none?.paths)).toEqual(new Set(['notes/c.md', 'archive/d.md']));
  });

  it('caps example paths per group at 20 even when many more notes share the value', () => {
    for (let i = 0; i < 25; i += 1) {
      index.upsert(entry(`bucket/n${i}.md`, '---\nbucket: same\n---\nx'));
    }
    const r = run({ pathPrefix: 'bucket', groupBy: 'bucket' });
    expect(r.groups).toHaveLength(1);
    expect(r.groups?.[0]?.key).toBe('same');
    expect(r.groups?.[0]?.count).toBe(25);
    expect(r.groups?.[0]?.paths).toHaveLength(20);
  });
});
