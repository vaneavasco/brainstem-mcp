import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { MAX_FILE_BYTES } from '../../src/storage/limits.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { TRASH_DIR } from '../../src/storage/path-policy.ts';
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

  it('computes a content hash on read that changes after the content changes', async () => {
    await vault.write('h.md', '---\ntitle: H\n---\nv1\n');
    const n1 = await vault.read('h.md');
    expect(n1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(n1.hash).toBe(sha256hex(n1.content));
    await vault.append('h.md', 'v2');
    const n2 = await vault.read('h.md');
    expect(n2.hash).not.toBe(n1.hash);
    expect(n2.hash).toBe(sha256hex(n2.content));
  });

  it('merges frontmatter on write when requested, incoming keys winning', async () => {
    await vault.write('n.md', '---\na: 1\nb: 2\n---\nold body\n');
    await vault.write('n.md', '---\nb: 20\nc: 3\n---\nnew body\n', { mergeFrontmatter: true });
    const note = await vault.read('n.md');
    expect(note.frontmatter).toEqual({ a: 1, b: 20, c: 3 });
    expect(note.body).toBe('new body\n');
  });

  it('preserves the trailing newline through write and frontmatter round-trips', async () => {
    const noFrontmatter = 'plain body without frontmatter.\n';
    await vault.write('plain.md', noFrontmatter);
    expect(await fs.readFile(path.join(root, 'plain.md'), 'utf8')).toBe(noFrontmatter);

    const withFrontmatter = '---\ntype: test\n---\n\n# A\n\nline.\n';
    await vault.write('a.md', withFrontmatter);
    const rawA = await fs.readFile(path.join(root, 'a.md'), 'utf8');
    expect(rawA).toBe(withFrontmatter);
    expect(rawA.endsWith('\n')).toBe(true);

    const merged = '---\ntype: test\nstatus: draft\n---\n\nline.\n';
    await vault.write('b.md', merged, { mergeFrontmatter: true });
    const rawB = await fs.readFile(path.join(root, 'b.md'), 'utf8');
    expect(rawB).toBe(merged);
    expect(rawB.endsWith('\n')).toBe(true);
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

  it('leaves the file newline-terminated even when the appended content is not, so a later dry-run diff does not report a missing trailing newline', async () => {
    await vault.write('a.md', '---\ntype: test\n---\n\n# A\n\nline.\n');
    await vault.append('a.md', 'appended without its own newline');
    const raw = await fs.readFile(path.join(root, 'a.md'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const dry = await vault.edit('a.md', [{ find: 'line.', replace: 'line changed.' }], true);
    expect(dry.diff).not.toContain('No newline at end of file');
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

  describe('hashOf', () => {
    it('returns sha256hex of the decoded text, matching read().hash, and null when missing or a directory', async () => {
      await vault.write('h2.md', '---\ntitle: H2\n---\nbody\n');
      const note = await vault.read('h2.md');
      expect(await vault.hashOf('h2.md')).toBe(note.hash);
      expect(await vault.hashOf('h2.md')).toBe(sha256hex(note.content));
      expect(await vault.hashOf('nope.md')).toBeNull();
      await fs.mkdir(path.join(root, 'a-folder'));
      expect(await vault.hashOf('a-folder')).toBeNull();
    });

    it('returns null rather than throwing for content that is not valid UTF-8 text', async () => {
      await fs.writeFile(path.join(root, 'bin.png'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
      expect(await vault.hashOf('bin.png')).toBeNull();
    });
  });

  describe('hardDelete', () => {
    it('unlinks a file outright (no .trash)', async () => {
      await vault.write('gone.md', 'bye\n');
      await vault.hardDelete('gone.md');
      expect(await code(vault.read('gone.md'))).toBe('NOT_FOUND');
      const rootEntries = await fs.readdir(root);
      expect(rootEntries.includes(TRASH_DIR)).toBe(false);
    });

    it('reports NOT_FOUND for a missing file and rejects reserved/dot paths', async () => {
      expect(await code(vault.hardDelete('nope.md'))).toBe('NOT_FOUND');
      expect(await code(vault.hardDelete('_brainstem/state.json'))).toBe('INVALID_PATH');
      expect(await code(vault.hardDelete('.trash/x.md'))).toBe('INVALID_PATH');
    });
  });

  describe('expectedHash (optimistic concurrency)', () => {
    it('write: proceeds when the hash matches, conflicts with the current hash when it does not', async () => {
      await vault.write('c.md', 'v1\n');
      const v1Hash = await vault.hashOf('c.md');
      await vault.write('c.md', 'v2\n', { expectedHash: v1Hash ?? undefined });
      const v2Hash = await vault.hashOf('c.md');
      expect(v2Hash).not.toBe(v1Hash);

      try {
        await vault.write('c.md', 'v3\n', { expectedHash: v1Hash ?? undefined });
        throw new Error('expected CONFLICT');
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
        expect((error as VaultError).code).toBe('CONFLICT');
        expect((error as VaultError).details).toEqual({ path: 'c.md', currentHash: v2Hash });
      }
      // The failed write must not have mutated the file.
      expect((await vault.read('c.md')).content).toBe('v2\n');
    });

    it('write: conflicts when the file does not exist yet but a hash was expected', async () => {
      expect(await code(vault.write('new.md', 'x\n', { expectedHash: 'a'.repeat(64) }))).toBe(
        'CONFLICT',
      );
    });

    it('edit / append honour expectedHash', async () => {
      await vault.write('e2.md', 'alpha\n');
      const h1 = await vault.hashOf('e2.md');
      expect(
        await code(
          vault.edit('e2.md', [{ find: 'alpha', replace: 'beta' }], false, {
            expectedHash: 'f'.repeat(64),
          }),
        ),
      ).toBe('CONFLICT');
      await vault.edit('e2.md', [{ find: 'alpha', replace: 'beta' }], false, {
        expectedHash: h1 ?? undefined,
      });
      const h2 = await vault.hashOf('e2.md');
      expect(await code(vault.append('e2.md', 'gamma', { expectedHash: h1 ?? undefined }))).toBe(
        'CONFLICT',
      );
      await vault.append('e2.md', 'gamma', { expectedHash: h2 ?? undefined });
      expect((await vault.read('e2.md')).content).toBe('beta\ngamma\n');
    });

    it('writeBinary honours expectedHash', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      await vault.writeBinary('img/c.png', png, 'image/png');
      expect(
        await code(
          vault.writeBinary('img/c.png', png, 'image/png', { expectedHash: 'a'.repeat(64) }),
        ),
      ).toBe('CONFLICT');
    });

    it('batchFrontmatterUpdate reports a per-item CONFLICT without touching the file', async () => {
      await vault.write('bf.md', '---\nstatus: draft\n---\nBody\n');
      const currentHash = await vault.hashOf('bf.md');
      const r = await vault.batchFrontmatterUpdate([
        { path: 'bf.md', set: { status: 'done' }, expectedHash: 'a'.repeat(64) },
      ]);
      expect(r.updated).toEqual([]);
      expect(r.failed).toEqual([{ path: 'bf.md', error: expect.stringMatching(/^CONFLICT: /) }]);
      expect(await vault.read('bf.md')).toMatchObject({ frontmatter: { status: 'draft' } });
      const ok = await vault.batchFrontmatterUpdate([
        { path: 'bf.md', set: { status: 'done' }, expectedHash: currentHash ?? undefined },
      ]);
      expect(ok.updated).toEqual(['bf.md']);
    });

    it('move honours expectedHash for a single file and rejects it for a folder', async () => {
      await vault.write('mv1.md', 'x\n');
      expect(await code(vault.move('mv1.md', 'mv2.md', { expectedHash: 'a'.repeat(64) }))).toBe(
        'CONFLICT',
      );
      const h = await vault.hashOf('mv1.md');
      await vault.move('mv1.md', 'mv2.md', { expectedHash: h ?? undefined });
      expect(await code(vault.read('mv1.md'))).toBe('NOT_FOUND');
      expect((await vault.read('mv2.md')).content).toBe('x\n');

      await vault.write('folder/inside.md', 'y\n');
      expect(await code(vault.move('folder', 'folder2', { expectedHash: 'a'.repeat(64) }))).toBe(
        'INVALID_INPUT',
      );
    });

    it('softDelete honours expectedHash for a single file and rejects it for a folder', async () => {
      await vault.write('sd1.md', 'z\n');
      expect(await code(vault.softDelete('sd1.md', true, { expectedHash: 'a'.repeat(64) }))).toBe(
        'CONFLICT',
      );
      const h = await vault.hashOf('sd1.md');
      await vault.softDelete('sd1.md', true, { expectedHash: h ?? undefined });
      expect(await code(vault.read('sd1.md'))).toBe('NOT_FOUND');

      await vault.write('folder3/inside.md', 'w\n');
      expect(await code(vault.softDelete('folder3', true, { expectedHash: 'a'.repeat(64) }))).toBe(
        'INVALID_INPUT',
      );
    });
  });
});
