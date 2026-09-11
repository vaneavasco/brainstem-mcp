import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

interface TxStructured {
  id: string;
  applied: boolean;
  dryRun: boolean;
  rolledBack: boolean;
  touched: string[];
  journal?: string;
  results: {
    index: number;
    op: string;
    ok: boolean;
    error?: string;
    diff?: string;
    skipped?: boolean;
  }[];
}

function structured(result: { structuredContent?: unknown }): TxStructured {
  return result.structuredContent as TxStructured;
}

async function seed(rel: string, content: string): Promise<void> {
  const r = await h.call('vault_write', { path: rel, content });
  expect(r.isError, text(r)).toBeFalsy();
}

describe('vault_transaction', () => {
  it('accepts every op kind, reports per-op results and refreshes the index', async () => {
    await seed('tx/a.md', '# A\nbody\n');
    await seed('tx/edit.md', 'alpha\n');
    await seed('tx/fm.md', '---\ntype: note\n---\nbody\n');
    await seed('tx/moved.md', 'move me\n');
    await seed('tx/gone.md', 'delete me\n');

    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'write', path: 'tx/a.md', content: '# A2\n' },
        { op: 'edit', path: 'tx/edit.md', patches: [{ find: 'alpha', replace: 'beta' }] },
        { op: 'append', path: 'tx/a.md', content: 'tail' },
        { op: 'frontmatter_update', path: 'tx/fm.md', set: { status: 'done' } },
        { op: 'move', from: 'tx/moved.md', to: 'tx/archive/moved.md' },
        { op: 'delete', path: 'tx/gone.md', confirm: true },
      ],
    });

    expect(result.isError, text(result)).toBeFalsy();
    const s = structured(result);
    expect(s.applied).toBe(true);
    expect(s.dryRun).toBe(false);
    expect(s.rolledBack).toBe(false);
    expect(s.results.map((r) => r.op)).toEqual([
      'write',
      'edit',
      'append',
      'frontmatter_update',
      'move',
      'delete',
    ]);
    expect(s.results.every((r) => r.ok)).toBe(true);
    expect(s.touched).toContain('tx/archive/moved.md');

    expect(await fs.readFile(path.join(h.root, 'tx', 'a.md'), 'utf8')).toBe('# A2\ntail\n');
    // touch() ran for every path: the index sees the move and the delete immediately.
    expect(h.runtime.index.get('tx/archive/moved.md')).toBeDefined();
    expect(h.runtime.index.get('tx/moved.md')).toBeUndefined();
    expect(h.runtime.index.get('tx/gone.md')).toBeUndefined();
    expect(h.runtime.index.get('tx/fm.md')?.frontmatter.status).toBe('done');
  });

  it('previews with dryRun without writing', async () => {
    await seed('tx/dry.md', 'one\n');
    const result = await h.call('vault_transaction', {
      ops: [{ op: 'edit', path: 'tx/dry.md', patches: [{ find: 'one', replace: 'two' }] }],
      dryRun: true,
    });
    const s = structured(result);
    expect(s.dryRun).toBe(true);
    expect(s.applied).toBe(false);
    expect(s.results[0]?.diff).toContain('+two');
    expect(await fs.readFile(path.join(h.root, 'tx', 'dry.md'), 'utf8')).toBe('one\n');
  });

  it('reports a pre-flight conflict as an error and writes nothing', async () => {
    await seed('tx/conflict.md', 'one\n');
    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'append', path: 'tx/conflict.md', content: 'two' },
        {
          op: 'edit',
          path: 'tx/conflict.md',
          patches: [{ find: 'one', replace: 'x' }],
          expectedHash: 'f'.repeat(64),
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/CONFLICT/);
    const s = structured(result);
    expect(s.applied).toBe(false);
    expect(s.results[1]?.ok).toBe(false);
    expect(await fs.readFile(path.join(h.root, 'tx', 'conflict.md'), 'utf8')).toBe('one\n');
  });

  it('reports a failed dry run as an error instead of a preview', async () => {
    await seed('tx/dryfail.md', 'one\n');
    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'append', path: 'tx/dryfail.md', content: 'two' },
        { op: 'edit', path: 'tx/dryfail.md', patches: [{ find: 'nowhere', replace: 'x' }] },
      ],
      dryRun: true,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/op #2 \(edit\)/);
    expect(text(result)).toMatch(/INVALID_INPUT: patch #1/);
    expect(text(result)).not.toMatch(/would apply/);
    const s = structured(result);
    expect(s.dryRun).toBe(true);
    expect(s.applied).toBe(false);
    expect(s.results[1]?.ok).toBe(false);
    expect(await fs.readFile(path.join(h.root, 'tx', 'dryfail.md'), 'utf8')).toBe('one\n');
  });

  it('rejects an empty op list with INVALID_INPUT', async () => {
    const result = await h.call('vault_transaction', { ops: [] });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^INVALID_INPUT: /);
  });

  it('rejects more than 20 ops with INVALID_INPUT', async () => {
    const ops = Array.from({ length: 21 }, (_, i) => ({
      op: 'write',
      path: `tx/many/n${i}.md`,
      content: 'x\n',
    }));
    const result = await h.call('vault_transaction', { ops });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^INVALID_INPUT: /);
  });

  it('rejects an unknown op kind and a reserved path', async () => {
    const bad = await h.call('vault_transaction', {
      ops: [{ op: 'nope', path: 'tx/a.md', content: 'x' }],
    });
    expect(bad.isError).toBe(true);

    const reserved = await h.call('vault_transaction', {
      ops: [{ op: 'write', path: '_brainstem/state.json', content: 'x' }],
    });
    expect(reserved.isError).toBe(true);
    expect(text(reserved)).toMatch(/INVALID_PATH/);
  });
});

describe('vault_transaction frontmatter_update on invalid YAML frontmatter', () => {
  it('fails pre-flight with INVALID_INPUT and writes nothing', async () => {
    const broken = '---\norganization: """"\n---\nbody\n';
    await seed('tx/broken.md', broken);
    await seed('tx/ok.md', '---\ntype: note\n---\nbody\n');
    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'frontmatter_update', path: 'tx/ok.md', set: { status: 'done' } },
        { op: 'frontmatter_update', path: 'tx/broken.md', set: { status: 'done' } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not valid YAML/);
    const ok = await h.call('vault_read', { path: 'tx/ok.md' });
    expect(text(ok)).toBe('---\ntype: note\n---\nbody\n');
    const brokenRead = await h.call('vault_read', { path: 'tx/broken.md' });
    expect(text(brokenRead)).toBe(broken);
  });
});

describe('vault_transaction — append into a section, unique', () => {
  const person =
    '---\ntype: person\n---\n# P\n\n## Related\n- Author of [[Old]]\n\n## Timeline\n- 2025-01-01 [[t1|t]] — x\n';

  it('inserts inside the heading and skips a unique duplicate, reporting it as skipped', async () => {
    await seed('tx/person.md', person);
    const result = await h.call('vault_transaction', {
      ops: [
        {
          op: 'append',
          path: 'tx/person.md',
          content: '- Author of [[New Project]]',
          heading: 'Related',
          unique: true,
        },
        {
          op: 'append',
          path: 'tx/person.md',
          content: '- Author of [[New Project|alias]]',
          heading: 'Related',
          unique: true,
        },
        {
          op: 'append',
          path: 'tx/person.md',
          content: '- 2025-02-02 [[t2|t]] — y',
          heading: 'Timeline',
          unique: true,
        },
        {
          op: 'append',
          path: 'tx/person.md',
          content: '- 2025-01-01 [[t1|other]] — dup',
          heading: 'Timeline',
          unique: true,
        },
      ],
    });
    expect(result.isError, text(result)).toBeFalsy();
    const s = structured(result);
    expect(s.applied).toBe(true);
    expect(s.results.map((r) => r.skipped === true)).toEqual([false, true, false, true]);
    expect(s.results.every((r) => r.ok)).toBe(true);
    const after = await fs.readFile(path.join(h.root, 'tx', 'person.md'), 'utf8');
    expect(after).toBe(
      '---\ntype: person\n---\n# P\n\n## Related\n- Author of [[Old]]\n- Author of [[New Project]]\n\n## Timeline\n- 2025-01-01 [[t1|t]] — x\n- 2025-02-02 [[t2|t]] — y\n',
    );
  });

  it('fails the whole transaction when the heading does not exist, writing nothing', async () => {
    await seed('tx/h.md', '## A\n');
    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'append', path: 'tx/h.md', content: 'x' },
        { op: 'append', path: 'tx/h.md', content: '- y', heading: 'Nope' },
      ],
    });
    const s = structured(result);
    expect(s.applied).toBe(false);
    expect(s.results[1]?.error).toMatch(/NOT_FOUND/);
    expect(await fs.readFile(path.join(h.root, 'tx', 'h.md'), 'utf8')).toBe('## A\n');
  });

  it('unique without a heading checks the whole file', async () => {
    await seed('tx/u.md', '- [[Z|first]]\n');
    const result = await h.call('vault_transaction', {
      ops: [
        { op: 'append', path: 'tx/u.md', content: '- [[Z]] again', unique: true },
        { op: 'append', path: 'tx/u.md', content: '- [[Y]]', unique: true },
      ],
    });
    const s = structured(result);
    expect(s.applied).toBe(true);
    expect(s.results.map((r) => r.skipped === true)).toEqual([true, false]);
    expect(await fs.readFile(path.join(h.root, 'tx', 'u.md'), 'utf8')).toBe(
      '- [[Z|first]]\n- [[Y]]\n',
    );
  });
});

describe('vault_append — unique', () => {
  it('skips an equivalent line inside the section and reports skipped without changing the hash', async () => {
    await seed('ap/p.md', '# P\n\n## Related\n- Author of [[R]]\n');
    const before = await h.call('vault_append', {
      path: 'ap/p.md',
      content: '- Author of [[R|alias]]',
      heading: 'Related',
      unique: true,
    });
    expect(before.isError, text(before)).toBeFalsy();
    const body = before.structuredContent as { hash: string; skipped?: boolean };
    expect(body.skipped).toBe(true);
    expect(await fs.readFile(path.join(h.root, 'ap', 'p.md'), 'utf8')).toBe(
      '# P\n\n## Related\n- Author of [[R]]\n',
    );
    const added = await h.call('vault_append', {
      path: 'ap/p.md',
      content: '- Author of [[S]]',
      heading: 'Related',
      unique: true,
    });
    const body2 = added.structuredContent as { hash: string; skipped?: boolean };
    expect(body2.skipped).toBeUndefined();
    expect(body2.hash).not.toBe(body.hash);
  });
});

describe('vault_transaction — append, unique: "line"', () => {
  it('skips only an identical trimmed line, allowing a legitimate repeat link on a different line', async () => {
    await seed('tx/log.md', '## Log\n- 2026-03-01 — away, covered by [[Bob Jones]]\n');
    const result = await h.call('vault_transaction', {
      ops: [
        {
          op: 'append',
          path: 'tx/log.md',
          content: '- 2026-03-01 — away, covered by [[Bob Jones]]',
          heading: 'Log',
          unique: 'line',
        },
        {
          op: 'append',
          path: 'tx/log.md',
          content: '- 2026-04-02 — away, covered by [[Bob Jones]]',
          heading: 'Log',
          unique: 'line',
        },
      ],
    });
    expect(result.isError, text(result)).toBeFalsy();
    const s = structured(result);
    expect(s.applied).toBe(true);
    // First op is an exact repeat of the existing line, so it's skipped; the second links the
    // same [[Bob Jones]] but on a different line, so "line" mode (unlike "true") keeps it.
    expect(s.results.map((r) => r.skipped === true)).toEqual([true, false]);
    expect(await fs.readFile(path.join(h.root, 'tx', 'log.md'), 'utf8')).toBe(
      '## Log\n- 2026-03-01 — away, covered by [[Bob Jones]]\n- 2026-04-02 — away, covered by [[Bob Jones]]\n',
    );
  });
});

describe('vault_transaction — append, unique canonicalises via the graph', () => {
  it('does not conflate two different notes that merely share a basename', async () => {
    await seed('projects/Chart.md', 'x');
    await seed('archive/Chart.md', 'x');
    await seed('tx/report.md', '## Related\n- See [[projects/Chart]]\n');
    const result = await h.call('vault_transaction', {
      ops: [
        {
          op: 'append',
          path: 'tx/report.md',
          content: '- See [[archive/Chart]]',
          heading: 'Related',
          unique: true,
        },
      ],
    });
    expect(result.isError, text(result)).toBeFalsy();
    const s = structured(result);
    expect(s.results[0]?.skipped).toBeUndefined();
    expect(await fs.readFile(path.join(h.root, 'tx', 'report.md'), 'utf8')).toBe(
      '## Related\n- See [[projects/Chart]]\n- See [[archive/Chart]]\n',
    );
  });

  it('treats a bare name and a full vault path to the same note as the same target', async () => {
    await seed('people/Alice Smith.md', 'x');
    await seed('tx/report2.md', '## Related\n- Author of [[people/Alice Smith]]\n');
    const result = await h.call('vault_transaction', {
      ops: [
        {
          op: 'append',
          path: 'tx/report2.md',
          content: '- Author of [[Alice Smith]]',
          heading: 'Related',
          unique: true,
        },
      ],
    });
    expect(result.isError, text(result)).toBeFalsy();
    const s = structured(result);
    expect(s.results[0]?.skipped).toBe(true);
    expect(await fs.readFile(path.join(h.root, 'tx', 'report2.md'), 'utf8')).toBe(
      '## Related\n- Author of [[people/Alice Smith]]\n',
    );
  });
});

describe('vault_append — unique: "line"', () => {
  it('skips only an identical trimmed line, ignoring a shared link target', async () => {
    await seed('ap/log.md', '## Log\n- 2026-03-01 — away, covered by [[Bob Jones]]\n');
    const dup = await h.call('vault_append', {
      path: 'ap/log.md',
      content: '- 2026-03-01 — away, covered by [[Bob Jones]]',
      heading: 'Log',
      unique: 'line',
    });
    expect((dup.structuredContent as { skipped?: boolean }).skipped).toBe(true);

    const added = await h.call('vault_append', {
      path: 'ap/log.md',
      content: '- 2026-04-02 — away, covered by [[Bob Jones]]',
      heading: 'Log',
      unique: 'line',
    });
    expect((added.structuredContent as { skipped?: boolean }).skipped).toBeUndefined();
    expect(await fs.readFile(path.join(h.root, 'ap', 'log.md'), 'utf8')).toBe(
      '## Log\n- 2026-03-01 — away, covered by [[Bob Jones]]\n- 2026-04-02 — away, covered by [[Bob Jones]]\n',
    );
  });
});

describe('vault_append — unique canonicalises via the graph', () => {
  it('does not conflate two different notes that merely share a basename', async () => {
    await seed('projects/Report.md', 'x');
    await seed('archive/Report.md', 'x');
    await seed('ap/related.md', '## Related\n- See [[projects/Report]]\n');
    const r = await h.call('vault_append', {
      path: 'ap/related.md',
      content: '- See [[archive/Report]]',
      heading: 'Related',
      unique: true,
    });
    expect((r.structuredContent as { skipped?: boolean }).skipped).toBeUndefined();
    expect(await fs.readFile(path.join(h.root, 'ap', 'related.md'), 'utf8')).toBe(
      '## Related\n- See [[projects/Report]]\n- See [[archive/Report]]\n',
    );
  });

  it('treats a bare name, a full path and a .md-suffixed target as the same note', async () => {
    await seed('people/Bob Jones.md', 'x');
    await seed('ap/related2.md', '## Related\n- Author of [[people/Bob Jones]]\n');
    const r = await h.call('vault_append', {
      path: 'ap/related2.md',
      content: '- Author of [[Bob Jones.md]]',
      heading: 'Related',
      unique: true,
    });
    expect((r.structuredContent as { skipped?: boolean }).skipped).toBe(true);
  });
});
