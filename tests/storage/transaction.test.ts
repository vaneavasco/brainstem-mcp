import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { runTransaction, type TxDeps, type TxOp } from '../../src/storage/transaction.ts';
import { VaultError } from '../../src/storage/types.ts';
import { WriteGate } from '../../src/storage/write-gate.ts';

let root: string;
let adapter: LocalFSAdapter;
let deps: TxDeps;

async function seed(rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

function abs(rel: string): string {
  return path.join(root, ...rel.split('/'));
}

async function readText(rel: string): Promise<string> {
  return await fs.readFile(abs(rel), 'utf8');
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(abs(rel));
    return true;
  } catch {
    return false;
  }
}

/** Raw bytes of every listed file, so a rollback can be checked byte-for-byte. */
async function snapshot(rels: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of rels) {
    out[rel] = (await fs.readFile(abs(rel))).toString('base64');
  }
  return out;
}

async function txDirs(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, '_brainstem', 'tx'))).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-tx-')));
  adapter = await LocalFSAdapter.create(root, { ripgrepPath: null });
  deps = {
    adapter,
    gate: new WriteGate(),
    vaultRoot: adapter.root,
    stateDir: path.join(adapter.root, '_brainstem'),
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('runTransaction pre-flight', () => {
  it('writes nothing and reports every op when one op fails pre-flight', async () => {
    await seed('a.md', '# A\n');
    await seed('b.md', '# B\n');
    const before = await snapshot(['a.md', 'b.md']);

    const result = await runTransaction(
      deps,
      [
        { op: 'write', path: 'a.md', content: '# A2\n' },
        {
          op: 'edit',
          path: 'b.md',
          patches: [{ find: '# B', replace: '# B2' }],
          expectedHash: 'f'.repeat(64),
        },
        { op: 'append', path: 'b.md', content: 'tail' },
      ],
      {},
    );

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.journal).toBeUndefined();
    expect(result.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(result.results[1]?.error).toMatch(/^CONFLICT: /);
    expect(result.results[2]?.error).toMatch(/not attempted/);
    expect(result.touched).toEqual(['a.md', 'b.md']);
    expect(await snapshot(['a.md', 'b.md'])).toEqual(before);
    expect(await txDirs()).toEqual([]);
  });

  it('simulates ops on the same path in sequence so a later op sees the earlier result', async () => {
    await seed('n.md', 'one\n');
    const result = await runTransaction(
      deps,
      [
        { op: 'append', path: 'n.md', content: 'two' },
        { op: 'edit', path: 'n.md', patches: [{ find: 'two', replace: 'three' }] },
      ],
      {},
    );
    expect(result.applied).toBe(true);
    expect(await readText('n.md')).toBe('one\nthree\n');
  });

  it('checks expectedHash of the first op touching a path against the on-disk state', async () => {
    await seed('n.md', 'one\n');
    const onDisk = (await adapter.hashOf('n.md')) as string;
    const result = await runTransaction(
      deps,
      [
        { op: 'append', path: 'n.md', content: 'two', expectedHash: onDisk },
        // The second op must compare against the simulated content, not the stale disk hash.
        { op: 'append', path: 'n.md', content: 'three', expectedHash: onDisk },
      ],
      {},
    );
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.error).toMatch(/^CONFLICT: /);
    expect(await readText('n.md')).toBe('one\n');
  });

  it('refuses a move onto a path an earlier op created, and a delete without confirm', async () => {
    await seed('src.md', 'src\n');
    const clash = await runTransaction(
      deps,
      [
        { op: 'write', path: 'dst.md', content: 'made here\n' },
        { op: 'move', from: 'src.md', to: 'dst.md' },
      ],
      {},
    );
    expect(clash.results[1]?.ok).toBe(false);
    expect(clash.results[1]?.error).toMatch(/^ALREADY_EXISTS: /);
    expect(await exists('dst.md')).toBe(false);

    const noConfirm = await runTransaction(
      deps,
      [{ op: 'delete', path: 'src.md', confirm: false }],
      {},
    );
    expect(noConfirm.results[0]?.error).toMatch(/^CONFIRM_REQUIRED: /);
    expect(await exists('src.md')).toBe(true);
  });

  it('rejects more ops than the cap and more distinct files than the cap', async () => {
    const tooManyOps: TxOp[] = Array.from({ length: 21 }, (_, i) => ({
      op: 'write',
      path: `n${i}.md`,
      content: 'x\n',
    }));
    await expect(runTransaction(deps, tooManyOps, {})).rejects.toThrow(/20 op/);

    // 11 moves touch 22 distinct paths with only 11 ops.
    const tooManyFiles: TxOp[] = Array.from({ length: 11 }, (_, i) => ({
      op: 'move',
      from: `from${i}.md`,
      to: `to${i}.md`,
    }));
    await expect(runTransaction(deps, tooManyFiles, {})).rejects.toThrow(/20 file/);
  });
});

describe('runTransaction dryRun', () => {
  it('returns unified diffs and writes nothing', async () => {
    await seed('a.md', '---\ntype: note\n---\n# A\n');
    const before = await snapshot(['a.md']);

    const result = await runTransaction(
      deps,
      [
        { op: 'edit', path: 'a.md', patches: [{ find: '# A', replace: '# A!' }] },
        { op: 'write', path: 'new.md', content: 'hello\n' },
        { op: 'append', path: 'a.md', content: 'tail' },
        { op: 'frontmatter_update', path: 'a.md', set: { status: 'wip' } },
      ],
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(result.results[0]?.diff).toContain('+# A!');
    expect(result.results[1]?.diff).toContain('+hello');
    expect(result.results[2]?.diff).toContain('+tail');
    expect(result.results[3]?.diff).toContain('+status: wip');
    expect(result.results.every((r) => r.hash === undefined)).toBe(true);

    expect(await snapshot(['a.md'])).toEqual(before);
    expect(await exists('new.md')).toBe(false);
    expect(await txDirs()).toEqual([]);
  });
});

describe('runTransaction apply', () => {
  it('applies all six op kinds and removes the journal on success', async () => {
    await seed('notes/a.md', '# A\nbody\n');
    await seed('notes/edit.md', 'alpha\n');
    await seed('notes/append.md', 'first\n');
    await seed('notes/fm.md', '---\ntype: note\n---\nbody\n');
    await seed('notes/moved.md', 'move me\n');
    await seed('notes/gone.md', 'delete me\n');

    const result = await runTransaction(
      deps,
      [
        { op: 'write', path: 'notes/a.md', content: '# A2\n' },
        { op: 'edit', path: 'notes/edit.md', patches: [{ find: 'alpha', replace: 'beta' }] },
        { op: 'append', path: 'notes/append.md', content: 'second' },
        {
          op: 'frontmatter_update',
          path: 'notes/fm.md',
          set: { status: 'done' },
          unset: ['type'],
        },
        { op: 'move', from: 'notes/moved.md', to: 'archive/moved.md' },
        { op: 'delete', path: 'notes/gone.md', confirm: true },
      ],
      {},
    );

    expect(result.applied).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.journal).toBeUndefined();
    expect(result.results.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
    expect(result.results.map((r) => r.op)).toEqual([
      'write',
      'edit',
      'append',
      'frontmatter_update',
      'move',
      'delete',
    ]);
    expect(result.results[0]?.hash).toBe((await adapter.read('notes/a.md')).hash);
    expect(result.results[4]?.hash).toBe((await adapter.read('archive/moved.md')).hash);
    expect(result.results[5]?.hash).toBeUndefined();
    expect(result.touched).toEqual([
      'archive/moved.md',
      'notes/a.md',
      'notes/append.md',
      'notes/edit.md',
      'notes/fm.md',
      'notes/gone.md',
      'notes/moved.md',
    ]);

    expect(await readText('notes/a.md')).toBe('# A2\n');
    expect(await readText('notes/edit.md')).toBe('beta\n');
    expect(await readText('notes/append.md')).toBe('first\nsecond\n');
    expect(await readText('notes/fm.md')).toBe('---\nstatus: done\n---\nbody\n');
    expect(await readText('archive/moved.md')).toBe('move me\n');
    expect(await exists('notes/moved.md')).toBe(false);
    expect(await exists('notes/gone.md')).toBe(false);
    expect(await exists('.trash/notes/gone.md')).toBe(true);
    expect(await txDirs()).toEqual([]);
  });

  it('rolls every touched file back byte-for-byte when an op fails mid-apply', async () => {
    await seed('notes/a.md', '# A\nbody\n');
    await seed('notes/moved.md', 'move me\n');
    await seed('notes/gone.md', 'delete me\n');
    await seed('notes/append.md', 'first\n');
    const paths = ['notes/a.md', 'notes/moved.md', 'notes/gone.md', 'notes/append.md'];
    const before = await snapshot(paths);

    adapter.append = async (): Promise<void> => {
      throw new Error('disk on fire');
    };

    const result = await runTransaction(
      deps,
      [
        { op: 'write', path: 'notes/a.md', content: '# A2\n' },
        { op: 'move', from: 'notes/moved.md', to: 'archive/moved.md' },
        { op: 'delete', path: 'notes/gone.md', confirm: true },
        { op: 'write', path: 'notes/created.md', content: 'new\n' },
        { op: 'append', path: 'notes/append.md', content: 'boom' },
      ],
      {},
    );

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.journal).toBeUndefined();
    expect(result.results.map((r) => r.ok)).toEqual([true, true, true, true, false]);
    expect(result.results[4]?.error).toMatch(/disk on fire/);

    expect(await snapshot(paths)).toEqual(before);
    expect(await exists('archive/moved.md')).toBe(false);
    expect(await exists('notes/created.md')).toBe(false);
    // The soft-deleted copy stays in .trash: nothing is lost, the original is back in place.
    expect(await exists('.trash/notes/gone.md')).toBe(true);
    expect(await txDirs()).toEqual([]);
  });

  it('keeps the journal with its pre-images when the rollback itself fails', async () => {
    await seed('a.md', 'A\n');
    await seed('b.md', 'B\n');

    adapter.append = async (): Promise<void> => {
      throw new Error('disk on fire');
    };
    adapter.hardDelete = async (): Promise<void> => {
      throw new VaultError('IO', 'cannot unlink');
    };

    const result = await runTransaction(
      deps,
      [
        { op: 'write', path: 'a.md', content: 'A2\n' },
        { op: 'write', path: 'created.md', content: 'new\n' },
        { op: 'append', path: 'b.md', content: 'boom' },
      ],
      {},
    );

    expect(result.rolledBack).toBe(false);
    expect(result.journal).toBe(path.join(root, '_brainstem', 'tx', result.id));
    expect(result.results[2]?.error).toMatch(/rollback/i);
    expect(result.results[2]?.error).toContain(result.id);

    const dir = result.journal as string;
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      id: string;
      created: string[];
      preImages: { path: string; file: string }[];
    };
    expect(manifest.id).toBe(result.id);
    expect(manifest.created).toEqual(['created.md']);
    expect(manifest.preImages.map((p) => p.path).sort()).toEqual(['a.md', 'b.md']);
    for (const pre of manifest.preImages) {
      const bytes = await fs.readFile(path.join(dir, pre.file), 'utf8');
      expect(bytes).toBe(pre.path === 'a.md' ? 'A\n' : 'B\n');
    }
    // Pre-images were restored before the failing step, so a.md is already back.
    expect(await readText('a.md')).toBe('A\n');
    expect(await txDirs()).toEqual([result.id]);
  });
});
