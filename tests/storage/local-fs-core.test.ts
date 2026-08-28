import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/storage/limits.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { VaultError } from '../../src/storage/types.ts';

let root: string;
let outside: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error('expected a VaultError');
}

describe('LocalFSAdapter core', () => {
  it('reports capabilities for the filesystem backend', () => {
    expect(vault.capabilities()).toEqual({
      atomicWrites: true,
      nativeSearch: false,
      watch: true,
      revisions: false,
    });
  });

  it('writes and reads a markdown note with frontmatter, creating parent folders', async () => {
    await vault.write('01-projects/plan.md', '---\ntitle: Plan\ntags: [a]\n---\n# Plan\n');
    const note = await vault.read('01-projects/plan.md');
    expect(note.path).toBe('01-projects/plan.md');
    expect(note.frontmatter).toEqual({ title: 'Plan', tags: ['a'] });
    expect(note.body).toBe('# Plan\n');
    expect(note.hasFrontmatter).toBe(true);
    expect(note.meta.size).toBeGreaterThan(0);
    expect(Date.parse(note.meta.modifiedAt)).not.toBeNaN();
    const leftovers = (await fs.readdir(path.join(root, '01-projects'))).filter((n) =>
      n.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('merges frontmatter on write when requested, incoming keys winning', async () => {
    await vault.write('n.md', '---\na: 1\nb: 2\n---\nold body\n');
    await vault.write('n.md', '---\nb: 20\nc: 3\n---\nnew body\n', { mergeFrontmatter: true });
    const note = await vault.read('n.md');
    expect(note.frontmatter).toEqual({ a: 1, b: 20, c: 3 });
    expect(note.body).toBe('new body\n');
  });

  it('rejects oversized writes and reports NOT_FOUND for missing files', async () => {
    expect(await code(vault.write('big.md', 'x'.repeat(MAX_FILE_BYTES + 1)))).toBe('TOO_LARGE');
    expect(await code(vault.read('nope.md'))).toBe('NOT_FOUND');
    expect(await code(vault.read(''))).toBe('INVALID_PATH');
  });

  it('rejects invalid UTF-8 with ENCODING and degrades invalid YAML to no frontmatter', async () => {
    await fs.writeFile(path.join(root, 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(await code(vault.read('bin.md'))).toBe('ENCODING');
    await fs.writeFile(path.join(root, 'bad.md'), '---\ntitle: [oops\n---\nbody\n');
    const note = await vault.read('bad.md');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatter).toEqual({});
    expect(note.body).toBe('---\ntitle: [oops\n---\nbody\n');
  });

  it('blocks symlink escapes out of the vault root', async () => {
    await fs.writeFile(path.join(outside, 'secret.md'), 'top secret');
    await fs.symlink(outside, path.join(root, 'link'));
    expect(await code(vault.read('link/secret.md'))).toBe('INVALID_PATH');
    expect(await code(vault.write('link/new.md', 'x'))).toBe('INVALID_PATH');
  });

  it('writes allowlisted binaries and rejects others or mismatched extensions', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await vault.writeBinary('img/a.png', png, 'image/png');
    expect(await fs.readFile(path.join(root, 'img/a.png'))).toEqual(Buffer.from(png));
    expect(await code(vault.writeBinary('img/a.jpg', png, 'image/png'))).toBe('INVALID_INPUT');
    expect(await code(vault.writeBinary('a.exe', png, 'application/x-msdownload'))).toBe(
      'INVALID_INPUT',
    );
    expect(
      await code(vault.writeBinary('big.png', new Uint8Array(MAX_FILE_BYTES + 1), 'image/png')),
    ).toBe('TOO_LARGE');
  });

  it('edits with dry-run (no write) and for real (write), returning a diff', async () => {
    await vault.write('e.md', 'alpha\nbeta\n');
    const dry = await vault.edit('e.md', [{ find: 'beta', replace: 'BETA' }], true);
    expect(dry).toMatchObject({ path: 'e.md', applied: 1, dryRun: true });
    expect(dry.diff).toContain('-beta');
    expect(dry.diff).toContain('+BETA');
    expect((await vault.read('e.md')).content).toBe('alpha\nbeta\n');
    const real = await vault.edit('e.md', [{ find: 'beta', replace: 'BETA' }]);
    expect(real.dryRun).toBe(false);
    expect((await vault.read('e.md')).content).toBe('alpha\nBETA\n');
    expect(await code(vault.edit('e.md', [{ find: 'zzz', replace: '' }]))).toBe('INVALID_INPUT');
  });

  it('appends with newline handling and creates the file when missing', async () => {
    await vault.append('log.md', 'first');
    await vault.append('log.md', 'second');
    await vault.append('log.md', 'third\n');
    expect((await vault.read('log.md')).content).toBe('first\nsecond\nthird\n');
  });

  it('batch-reads reporting missing and failed files separately', async () => {
    await vault.write('a.md', 'A');
    await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe]));
    const r = await vault.batchRead(['a.md', 'missing.md', 'bad.md']);
    expect(r.notes.map((n) => n.path)).toEqual(['a.md']);
    expect(r.missing).toEqual(['missing.md']);
    expect(r.failed).toEqual([{ path: 'bad.md', error: expect.stringContaining('UTF-8') }]);
    expect(await code(vault.batchRead([]))).toBe('INVALID_INPUT');
    expect(await code(vault.batchRead(new Array(21).fill('a.md')))).toBe('INVALID_INPUT');
  });

  it('normalizes failed[].path when the raw input path can be normalized', async () => {
    await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe]));
    const r = await vault.batchRead(['./bad.md']);
    expect(r.failed).toEqual([{ path: 'bad.md', error: expect.stringContaining('UTF-8') }]);
  });

  it('falls back to the raw path in failed[] when the path itself is invalid', async () => {
    const r = await vault.batchRead(['..']);
    expect(r.failed).toEqual([
      { path: '..', error: expect.stringContaining('Invalid vault path') },
    ]);
  });

  it('batch-updates frontmatter without touching bodies', async () => {
    await vault.write('x.md', '---\nstatus: draft\nkeep: 1\n---\nBody\n');
    await vault.write('y.md', 'No frontmatter body\n');
    const r = await vault.batchFrontmatterUpdate([
      { path: 'x.md', set: { status: 'done' }, unset: ['keep'] },
      { path: 'y.md', set: { type: 'note' } },
      { path: 'missing.md', set: { a: 1 } },
      { path: '..', set: { a: 1 } },
    ]);
    expect(r.updated).toEqual(['x.md', 'y.md']);
    expect(r.failed).toEqual([
      { path: 'missing.md', error: expect.stringContaining('missing.md') },
      { path: '..', error: expect.stringContaining('Invalid vault path') },
    ]);
    expect(await vault.read('x.md')).toMatchObject({
      frontmatter: { status: 'done' },
      body: 'Body\n',
    });
    expect(await vault.read('y.md')).toMatchObject({
      frontmatter: { type: 'note' },
      body: 'No frontmatter body\n',
    });
  });
});
