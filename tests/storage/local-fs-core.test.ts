import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import {
  MAX_BINARY_BYTES,
  MAX_FILE_BYTES,
  MAX_SEARCH_PATHS,
  MAX_SEARCH_PATTERN_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SCAN,
} from '../../src/storage/limits.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { RESERVED_DIR, TRASH_DIR } from '../../src/storage/path-policy.ts';
import type { SearchOpts } from '../../src/storage/types.ts';
import { VaultError } from '../../src/storage/types.ts';

// Real `spawn` stays the default implementation (so the real-ripgrep-binary suite below is
// unaffected); individual tests override it for exactly one call via `mockImplementationOnce`
// to capture ripgrep's argv without ever spawning a real process.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnMock = vi.mocked(spawn);

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A fake ChildProcess good enough for LocalFSAdapter's ripgrep code path: readline reads
 *  `stdout` to EOF, then `close` fires with the given exit code (1 == "ripgrep found nothing",
 *  same as a real `rg` run with no matches). Never spawns a real process. */
function fakeRgChild(exitCode = 1): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
}

let root: string;
let outside: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
});

afterEach(async () => {
  // Clears call history only — the base implementation (real `spawn`) set up by vi.mock above
  // is preserved so the real-ripgrep-binary suite keeps spawning an actual process.
  spawnMock.mockClear();
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
    // Binary attachments are capped at MAX_BINARY_BYTES (8 MiB by default), not MAX_FILE_BYTES —
    // a size well past the old 1 MiB text cap must still be accepted.
    await vault.writeBinary('ok.png', new Uint8Array(MAX_FILE_BYTES + 1), 'image/png');
    expect(
      await code(vault.writeBinary('big.png', new Uint8Array(MAX_BINARY_BYTES + 1), 'image/png')),
    ).toBe('TOO_LARGE');
  });

  it('accepts an svg (image/svg+xml) attachment', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await vault.writeBinary('img/a.svg', svg, 'image/svg+xml');
    expect(await fs.readFile(path.join(root, 'img/a.svg'))).toEqual(Buffer.from(svg));
  });

  it('honours a custom maxBinaryBytes passed to LocalFSAdapter.create', async () => {
    const capped = await LocalFSAdapter.create(root, { ripgrepPath: null, maxBinaryBytes: 10 });
    await capped.writeBinary('ok.png', new Uint8Array(10), 'image/png');
    expect(await code(capped.writeBinary('big.png', new Uint8Array(11), 'image/png'))).toBe(
      'TOO_LARGE',
    );
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

    it('hashes the raw bytes (not text-decoded, never null) for content that is not valid UTF-8', async () => {
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
      await fs.writeFile(path.join(root, 'bin.png'), bytes);
      const hash = await vault.hashOf('bin.png');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
      // ...and not the (meaningless) hash of the replacement-character decode of those bytes.
      expect(hash).not.toBe(sha256hex(Buffer.from(bytes).toString('utf8')));
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

describe('.base files (Obsidian Bases — read/write/search as plain text, never evaluated)', () => {
  it('round-trips through write/read and is found by search, like any other text file', async () => {
    const yaml = 'views:\n  - type: table\n    name: All\nfilters: []\n';
    await vault.write('boards/all.base', yaml);
    expect((await vault.read('boards/all.base')).content).toBe(yaml);
    const listed = await vault.list('', { depth: Number.POSITIVE_INFINITY, includeFiles: true });
    expect(listed.map((e) => e.path)).toContain('boards/all.base');
    const hits = await vault.search('filters');
    expect(hits.map((m) => m.path)).toContain('boards/all.base');
  });
});

describe('search: regex and paths options (JS fallback, always runs)', () => {
  it('regex:true without ripgrep throws UNSUPPORTED', async () => {
    await vault.write('a.md', 'foo bar\n');
    expect(await code(vault.search('fo+', { regex: true }))).toBe('UNSUPPORTED');
  });

  it('rejects an over-length regex pattern before ever checking ripgrep availability', async () => {
    const longPattern = 'a'.repeat(MAX_SEARCH_PATTERN_CHARS + 1);
    expect(await code(vault.search(longPattern, { regex: true }))).toBe('INVALID_INPUT');
  });

  it('does not cap a literal query at the regex pattern length', async () => {
    const longQuery = 'x'.repeat(MAX_SEARCH_PATTERN_CHARS + 1);
    await expect(vault.search(longQuery)).resolves.toEqual([]);
  });

  it('restricts the search to exactly the given paths, ignoring every other file', async () => {
    await vault.write('a.md', 'needle here\n');
    await vault.write('b.md', 'needle here too\n');
    await vault.write('c.md', 'needle again\n');
    const r = await vault.search('needle', { paths: ['a.md', 'c.md'] });
    expect(r.map((m) => m.path).sort()).toEqual(['a.md', 'c.md']);
  });

  it('returns no matches for an empty paths array, without scanning the rest of the vault', async () => {
    await vault.write('a.md', 'needle\n');
    const r = await vault.search('needle', { paths: [] });
    expect(r).toEqual([]);
  });

  it('skips a candidate path that no longer exists, without failing the whole search', async () => {
    await vault.write('a.md', 'needle\n');
    const r = await vault.search('needle', { paths: ['a.md', 'missing.md'] });
    expect(r.map((m) => m.path)).toEqual(['a.md']);
  });

  it(`rejects more than ${MAX_SEARCH_PATHS} candidate paths`, async () => {
    const many = Array.from({ length: MAX_SEARCH_PATHS + 1 }, (_, i) => `n${i}.md`);
    expect(await code(vault.search('x', { paths: many }))).toBe('INVALID_INPUT');
  });

  it('drops reserved and dot-segment entries from an explicit paths list, even with an allowed extension', async () => {
    await fs.mkdir(path.join(root, '_brainstem', 'tx'), { recursive: true });
    await fs.writeFile(path.join(root, '_brainstem', 'tx', 'leaked.md'), 'needle secret\n');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    // .json is an allowed TEXT_EXTENSIONS entry, so only the dot-segment check saves this one.
    await fs.writeFile(path.join(root, '.obsidian', 'app.json'), '{"needle":true}');
    await vault.write('ok.md', 'needle here\n');
    const r = await vault.search('needle', {
      paths: ['_brainstem/tx/leaked.md', '.obsidian/app.json', 'ok.md'],
    });
    expect(r.map((m) => m.path)).toEqual(['ok.md']);
  });

  it('returns no matches (not an error) when every entry in paths is reserved/dot, without scanning the rest of the vault', async () => {
    await vault.write('untouched.md', 'needle should not appear\n');
    const r = await vault.search('needle', { paths: ['_brainstem/x.md', '.hidden/y.md'] });
    expect(r).toEqual([]);
  });
});

describe('search: the limit ceiling (what vault_links unlinked mentions relies on)', () => {
  /** One file, `count` lines each containing the needle. */
  async function seedMatches(path: string, count: number): Promise<void> {
    await vault.write(
      path,
      `${Array.from({ length: count }, (_, i) => `needle line ${i}`).join('\n')}\n`,
    );
  }

  it(`returns more than MAX_SEARCH_RESULTS (${MAX_SEARCH_RESULTS}) matches when asked for more`, async () => {
    // vault_links asks for MAX_UNLINKED_MENTIONS * 2 = 200; the adapter must honour that instead
    // of silently clamping every caller back down to the tool layer's public default of 50.
    await seedMatches('many.md', 120);
    const hits = await vault.search('needle', { limit: 200 });
    expect(hits).toHaveLength(120);
    expect(hits.length).toBeGreaterThan(MAX_SEARCH_RESULTS);
  });

  it(`clamps an absurd limit to MAX_SEARCH_SCAN (${MAX_SEARCH_SCAN})`, async () => {
    await seedMatches('huge.md', MAX_SEARCH_SCAN + 50);
    const hits = await vault.search('needle', { limit: 999_999 });
    expect(hits).toHaveLength(MAX_SEARCH_SCAN);
  });
});

describe('search: ripgrep argv construction (mocked spawn, no real rg binary needed)', () => {
  async function capturedArgs(query: string, opts: SearchOpts): Promise<string[]> {
    const rgVault = await LocalFSAdapter.create(root, { ripgrepPath: 'rg' });
    let args: string[] = [];
    spawnMock.mockImplementationOnce(((...spawnArgs: unknown[]) => {
      args = spawnArgs[1] as string[];
      return fakeRgChild() as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
    await rgVault.search(query, opts);
    return args;
  }

  it('literal search (default): keeps --fixed-strings, includes per-extension globs, positional query then target dir', async () => {
    const args = await capturedArgs('needle', {});
    expect(args).toContain('--fixed-strings');
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--pcre2');
    expect(args).toContain('*.md');
    const dashdash = args.indexOf('--');
    expect(args.slice(dashdash + 1)).toEqual(['needle', vault.root]);
  });

  it('regex:true: drops --fixed-strings, passes -e <pattern>, never adds --pcre2', async () => {
    const args = await capturedArgs('foo|bar', { regex: true });
    expect(args).not.toContain('--fixed-strings');
    expect(args).not.toContain('--pcre2');
    expect(args).toContain('-e');
    expect(args[args.indexOf('-e') + 1]).toBe('foo|bar');
    expect(args).toContain('*.md'); // still walks the target directory, restricted to text files
    const dashdash = args.indexOf('--');
    expect(args.slice(dashdash + 1)).toEqual([vault.root]); // -e already carries the pattern
  });

  it('paths: passed as positional file arguments after --, per-extension include globs dropped, exclusions kept', async () => {
    const args = await capturedArgs('needle', { paths: ['a.md', 'b/c.md'] });
    expect(args).toContain('--fixed-strings');
    expect(args).not.toContain('*.md');
    expect(args).toContain('!.*');
    expect(args).toContain('!**/.*/**');
    expect(args).toContain(`!/${RESERVED_DIR}/**`);
    const dashdash = args.indexOf('--');
    expect(args.slice(dashdash + 1)).toEqual([
      'needle',
      path.join(vault.root, 'a.md'),
      path.join(vault.root, 'b/c.md'),
    ]);
  });

  it('regex + paths together: -e pattern, no --fixed-strings, no include globs, files after --', async () => {
    const args = await capturedArgs('fo+', { regex: true, paths: ['a.md'] });
    expect(args).not.toContain('--fixed-strings');
    expect(args).not.toContain('*.md');
    expect(args).not.toContain('--pcre2');
    expect(args[args.indexOf('-e') + 1]).toBe('fo+');
    const dashdash = args.indexOf('--');
    expect(args.slice(dashdash + 1)).toEqual([path.join(vault.root, 'a.md')]);
  });

  it('always excludes dot-paths and the reserved _brainstem folder, in every mode', async () => {
    for (const opts of [
      {},
      { regex: true },
      { paths: ['a.md'] },
      { regex: true, paths: ['a.md'] },
    ]) {
      const args = await capturedArgs('x', opts);
      expect(args).toContain('!.*');
      expect(args).toContain('!**/.*/**');
      expect(args).toContain(`!/${RESERVED_DIR}/**`);
      expect(args).not.toContain('--pcre2');
    }
  });
});

describe.skipIf(!hasRipgrep())('search: regex (real ripgrep binary)', () => {
  it('supports alternation, is case-insensitive by default', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('pets.md', 'I have a cat\nI have a Dog\nI have a bird\n');
    const alt = await rgVault.search('cat|dog', { regex: true });
    expect(alt.map((m) => m.line).sort()).toEqual([1, 2]);
  });

  it('supports anchors', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('pets.md', 'I have a cat\nbird has a cat\n');
    const anchored = await rgVault.search('^I have a cat$', { regex: true });
    expect(anchored.map((m) => m.line)).toEqual([1]);
  });

  it('is case-sensitive only when explicitly requested', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('case.md', 'Cat\ncat\n');
    const r = await rgVault.search('^cat$', { regex: true, caseSensitive: true });
    expect(r.map((m) => m.line)).toEqual([2]);
  });

  it('treats "." as any-character only in regex mode, not in literal mode', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('dotted.md', 'a.c\nabc\n');
    const literal = await rgVault.search('a.c');
    expect(literal.map((m) => m.line)).toEqual([1]);
    const regexed = await rgVault.search('a.c', { regex: true });
    expect(regexed.map((m) => m.line).sort()).toEqual([1, 2]);
  });

  it('restricts to the given paths, ignoring files outside the set', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('x1.md', 'needle\n');
    await rgVault.write('x2.md', 'needle\n');
    await rgVault.write('x3.md', 'needle\n');
    const r = await rgVault.search('needle', { paths: ['x1.md', 'x3.md'] });
    expect(r.map((m) => m.path).sort()).toEqual(['x1.md', 'x3.md']);
  });

  it('regex + paths together', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('y1.md', 'foo123\n');
    await rgVault.write('y2.md', 'foo123\n');
    const r = await rgVault.search('foo\\d+', { regex: true, paths: ['y1.md'] });
    expect(r.map((m) => m.path)).toEqual(['y1.md']);
  });

  // Regression: ripgrep does NOT apply --glob exclusions to files named explicitly on the
  // command line (confirmed against a real binary) — so this must be enforced by the adapter's
  // own pre-filter in search(), not by the --glob args handed to ripgrep. Same case as the
  // JS-fallback test above ("drops reserved and dot-segment entries...").
  it('drops reserved and dot-segment entries from an explicit paths list even when passed to ripgrep', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await fs.mkdir(path.join(root, '_brainstem', 'tx'), { recursive: true });
    await fs.writeFile(path.join(root, '_brainstem', 'tx', 'leaked.md'), 'needle secret\n');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(root, '.obsidian', 'app.json'), '{"needle":true}');
    await rgVault.write('ok2.md', 'needle here\n');
    const r = await rgVault.search('needle', {
      paths: ['_brainstem/tx/leaked.md', '.obsidian/app.json', 'ok2.md'],
    });
    expect(r.map((m) => m.path)).toEqual(['ok2.md']);
  });
});

describe('post-write results', () => {
  it('write/append/edit return the post-write note; writeBinary returns the hash', async () => {
    const written = await vault.write('pw.md', '---\nk: 1\n---\nbody\n');
    expect(written.hash).toBe(await vault.hashOf('pw.md'));
    expect(written.frontmatter).toEqual({ k: 1 });
    expect(written.meta.size).toBeGreaterThan(0);

    const appended = await vault.append('pw.md', 'more');
    expect(appended.hash).toBe(await vault.hashOf('pw.md'));
    expect(appended.content.endsWith('more\n')).toBe(true);

    const edited = await vault.edit('pw.md', [{ find: 'more', replace: 'MORE' }]);
    expect(edited.note.hash).toBe(await vault.hashOf('pw.md'));

    const dry = await vault.edit('pw.md', [{ find: 'MORE', replace: 'zzz' }], true);
    expect(dry.note.hash).toBe(await vault.hashOf('pw.md')); // unchanged pre-image

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const hash = await vault.writeBinary('img/pw.png', png, 'image/png');
    expect(hash).toBe(await vault.hashOf('img/pw.png'));
  });

  it('batchFrontmatterUpdate returns updatedNotes aligned with updated', async () => {
    await vault.write('bfu.md', 'x\n');
    const result = await vault.batchFrontmatterUpdate([{ path: 'bfu.md', set: { a: 1 } }]);
    expect(result.updated).toEqual(['bfu.md']);
    expect(result.updatedNotes.map((n) => n.path)).toEqual(['bfu.md']);
    expect(result.updatedNotes[0]?.hash).toBe(await vault.hashOf('bfu.md'));
  });
});
