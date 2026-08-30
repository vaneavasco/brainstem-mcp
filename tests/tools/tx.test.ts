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
  results: { index: number; op: string; ok: boolean; error?: string; diff?: string }[];
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
