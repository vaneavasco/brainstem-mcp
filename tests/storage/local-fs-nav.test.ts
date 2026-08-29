import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import type { ChangeEvent, StorageAdapter } from '../../src/storage/types.ts';
import { VaultError } from '../../src/storage/types.ts';

let root: string;
let vault: LocalFSAdapter;

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function seed(): Promise<void> {
  await vault.write('00-inbox/todo.md', '---\ntype: task\n---\nBuy milk\n');
  await vault.write(
    '01-projects/brainstem/plan.md',
    '---\ntype: project\n---\nShip the MCP server\n',
  );
  await vault.write('01-projects/brainstem/notes.md', 'meeting notes about milk and MCP\n');
  await vault.write('02-areas/health.md', 'Drink Milk daily\n');
  await vault.write('board.canvas', '{"nodes":[],"edges":[]}');
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(root, '.obsidian/app.json'), '{"milk":true}');
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error('expected a VaultError');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-nav-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await seed();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('list', () => {
  it('lists one level by default, never dot entries, with file metadata', async () => {
    const entries = await vault.list('');
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      'dir:00-inbox',
      'dir:01-projects',
      'dir:02-areas',
      'file:board.canvas',
    ]);
    const canvas = entries.find((e) => e.path === 'board.canvas');
    expect(canvas?.size).toBeGreaterThan(0);
    expect(canvas?.modifiedAt).toBeDefined();
  });

  it('recurses with depth and filters with a glob relative to the prefix', async () => {
    const all = await vault.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    expect(all.map((e) => e.path)).toEqual([
      '00-inbox/todo.md',
      '01-projects/brainstem/notes.md',
      '01-projects/brainstem/plan.md',
      '02-areas/health.md',
      'board.canvas',
    ]);
    const md = await vault.list('01-projects', { depth: 5, glob: '**/*.md', includeDirs: false });
    expect(md.map((e) => e.path)).toEqual([
      '01-projects/brainstem/notes.md',
      '01-projects/brainstem/plan.md',
    ]);
    const dirsOnly = await vault.list('', { includeFiles: false });
    expect(dirsOnly.every((e) => e.kind === 'dir')).toBe(true);
  });

  it('rejects listing a file or a missing folder', async () => {
    expect(await code(vault.list('board.canvas'))).toBe('INVALID_INPUT');
    expect(await code(vault.list('nope'))).toBe('NOT_FOUND');
    expect(await code(vault.list('.obsidian'))).toBe('INVALID_PATH');
  });
});

describe('move', () => {
  it('moves files and folders, creating parents, refusing to overwrite', async () => {
    await vault.move('00-inbox/todo.md', '04-archive/2026/todo.md');
    expect((await vault.read('04-archive/2026/todo.md')).body).toBe('Buy milk\n');
    expect(await code(vault.read('00-inbox/todo.md'))).toBe('NOT_FOUND');
    await vault.move('01-projects/brainstem', '01-projects/brainstem-mcp');
    expect((await vault.read('01-projects/brainstem-mcp/plan.md')).frontmatter).toEqual({
      type: 'project',
    });
    expect(await code(vault.move('02-areas/health.md', 'board.canvas'))).toBe('ALREADY_EXISTS');
    expect(await code(vault.move('missing.md', 'x.md'))).toBe('NOT_FOUND');
    expect(await code(vault.move('02-areas/health.md', '.trash/h.md'))).toBe('INVALID_PATH');
  });
});

describe('softDelete', () => {
  it('requires confirm=true and moves into .trash keeping the relative path', async () => {
    expect(await code(vault.softDelete('02-areas/health.md', false))).toBe('CONFIRM_REQUIRED');
    await vault.softDelete('02-areas/health.md', true);
    expect(await code(vault.read('02-areas/health.md'))).toBe('NOT_FOUND');
    expect(await fs.readFile(path.join(root, '.trash/02-areas/health.md'), 'utf8')).toBe(
      'Drink Milk daily\n',
    );
    // trash is unreachable through the public API
    expect(await code(vault.read('.trash/02-areas/health.md'))).toBe('INVALID_PATH');
    expect((await vault.list('', { depth: 9 })).some((e) => e.path.startsWith('.trash'))).toBe(
      false,
    );
  });

  it('does not overwrite an earlier trashed file with the same path', async () => {
    await vault.softDelete('02-areas/health.md', true);
    await vault.write('02-areas/health.md', 'second version\n');
    await vault.softDelete('02-areas/health.md', true);
    const trashed = await fs.readdir(path.join(root, '.trash/02-areas'));
    expect(trashed).toHaveLength(2);
    expect(trashed).toContain('health.md');
    expect(trashed.some((n) => /^health\..+\.md$/.test(n))).toBe(true);
  });

  it('refuses to trash into a symlinked .trash directory, leaving the file in place', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
    try {
      await fs.symlink(outside, path.join(root, '.trash'));
      expect(await code(vault.softDelete('02-areas/health.md', true))).toBe('INVALID_PATH');
      expect((await vault.read('02-areas/health.md')).body).toBe('Drink Milk daily\n');
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('search (JS fallback)', () => {
  it('finds literal substrings case-insensitively by default, skipping dot files, honoring limit and prefix', async () => {
    const all = await vault.search('milk');
    expect(all.map((m) => `${m.path}:${m.line}`)).toEqual([
      '00-inbox/todo.md:4',
      '01-projects/brainstem/notes.md:1',
      '02-areas/health.md:1',
    ]);
    expect(all[0]?.text).toBe('Buy milk');
    const sensitive = await vault.search('Milk', { caseSensitive: true });
    expect(sensitive.map((m) => m.path)).toEqual(['02-areas/health.md']);
    const limited = await vault.search('milk', { limit: 2 });
    expect(limited).toHaveLength(2);
    const scoped = await vault.search('milk', { pathPrefix: '01-projects' });
    expect(scoped.map((m) => m.path)).toEqual(['01-projects/brainstem/notes.md']);
    expect(await code(vault.search('   '))).toBe('INVALID_INPUT');
  });

  it('treats the query literally, not as a regex', async () => {
    await vault.write('re.md', 'a.c\nabc\n');
    const r = await vault.search('a.c');
    expect(r.map((m) => `${m.path}:${m.line}`)).toEqual(['re.md:1']);
  });

  it('windows a long match line to avoid huge result payloads', async () => {
    const longLine = `milk ${'x'.repeat(5000)}`;
    await vault.write('long.md', `${longLine}\n`);
    const r = await vault.search('milk');
    const hit = r.find((m) => m.path === 'long.md');
    expect(hit?.text.length).toBeLessThanOrEqual(401);
    expect(hit?.text.endsWith('…')).toBe(true);
  });

  it('validates pathPrefix before dispatching, refusing a symlink escape', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'link'));
      expect(await code(vault.search('milk', { pathPrefix: 'link' }))).toBe('INVALID_PATH');
      expect(await code(vault.search('milk', { pathPrefix: 'nope' }))).toBe('NOT_FOUND');
      expect(await code(vault.search('milk', { pathPrefix: 'board.canvas' }))).toBe(
        'INVALID_INPUT',
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasRipgrep())('search (ripgrep)', () => {
  it('returns the same results as the JS fallback', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    expect(rgVault.capabilities().nativeSearch).toBe(true);
    const viaRg = await rgVault.search('milk');
    const viaJs = await vault.search('milk');
    expect(viaRg).toEqual(viaJs);
  });

  it('validates pathPrefix before dispatching to ripgrep, refusing a symlink escape', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'link'));
      expect(await code(rgVault.search('milk', { pathPrefix: 'link' }))).toBe('INVALID_PATH');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('treats a query beginning with - as a literal string, not a flag', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await rgVault.write('dash.md', '-milk special offer\n');
    const r = await rgVault.search('-milk');
    expect(r.map((m) => m.path)).toContain('dash.md');
  });

  it('does not honor in-vault .gitignore files (matches the JS fallback, which never did)', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    await fs.writeFile(path.join(root, '.gitignore'), '02-areas/\n');
    const r = await rgVault.search('milk');
    expect(r.map((m) => m.path)).toContain('02-areas/health.md');
  });

  it('windows a long match line the same way as the JS fallback', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    const longLine = `milk ${'y'.repeat(5000)}`;
    await rgVault.write('long-rg.md', `${longLine}\n`);
    const r = await rgVault.search('milk');
    const hit = r.find((m) => m.path === 'long-rg.md');
    expect(hit?.text.length).toBeLessThanOrEqual(401);
    expect(hit?.text.endsWith('…')).toBe(true);
  });

  it('stops reading once the limit is reached on a large result set', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    for (let i = 0; i < 200; i += 1) {
      await rgVault.write(`bulk/note-${i}.md`, 'needle appears here\n');
    }
    const r = await rgVault.search('needle', { limit: 5 });
    expect(r).toHaveLength(5);
  });
});

describe('reserved _brainstem directory', () => {
  it('list() and watch() never expose the reserved _brainstem folder', async () => {
    await fs.mkdir(path.join(root, '_brainstem'), { recursive: true });
    await fs.writeFile(path.join(root, '_brainstem', 'state.json'), '{}');
    await fs.writeFile(path.join(root, 'visible.md'), '# v');
    const entries = await vault.list('', { depth: Number.POSITIVE_INFINITY });
    expect(entries.map((e) => e.path)).toContain('visible.md');
    expect(entries.some((e) => e.path.startsWith('_brainstem'))).toBe(false);

    const seen: string[] = [];
    const stop = vault.watch((ev) => seen.push(ev.path));
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(root, '_brainstem', 'public-url'), 'https://x');
    await fs.writeFile(path.join(root, 'other.md'), '# o');
    await new Promise((r) => setTimeout(r, 700));
    stop();
    expect(seen).toContain('other.md');
    expect(seen.some((p) => p.startsWith('_brainstem'))).toBe(false);
  });

  it('search() never returns matches from inside the reserved _brainstem folder (JS fallback)', async () => {
    const needle = 'xyzzybrainstemneedle';
    await fs.mkdir(path.join(root, '_brainstem'), { recursive: true });
    await fs.writeFile(path.join(root, '_brainstem', 'secret.md'), `${needle} secret\n`);
    await vault.write('visible-needle.md', `${needle} visible\n`);
    const results = await vault.search(needle);
    expect(results.map((m) => m.path)).toEqual(['visible-needle.md']);
  });
});

describe('watch', () => {
  it('emits create/update/delete events with vault-relative paths', async () => {
    const adapter: StorageAdapter = vault;
    const events: ChangeEvent[] = [];
    const unsubscribe = adapter.watch?.((e) => events.push(e));
    expect(unsubscribe).toBeTypeOf('function');
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    await vault.write('watched/new.md', 'v1');
    await vault.write('watched/new.md', 'v2');
    await fs.rm(path.join(root, 'watched/new.md'));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some((e) => e.type === 'delete')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsubscribe?.();
    const types = events.filter((e) => e.path === 'watched/new.md').map((e) => e.type);
    expect(types[0]).toBe('create');
    expect(types.at(-1)).toBe('delete');
  });

  it('watch() honours watchPollMs by using chokidar polling', async () => {
    const polled = await LocalFSAdapter.create(root, { ripgrepPath: null, watchPollMs: 300 });
    const seen: string[] = [];
    const stop = polled.watch((ev) => seen.push(ev.path));
    await new Promise((r) => setTimeout(r, 400));
    await fs.writeFile(path.join(root, 'polled.md'), '# p');
    await new Promise((r) => setTimeout(r, 1200));
    stop();
    expect(seen).toContain('polled.md');
    expect(polled.capabilities().watch).toBe(true);
  });
});
