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
});

describe.skipIf(!hasRipgrep())('search (ripgrep)', () => {
  it('returns the same results as the JS fallback', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    expect(rgVault.capabilities().nativeSearch).toBe(true);
    const viaRg = await rgVault.search('milk');
    const viaJs = await vault.search('milk');
    expect(viaRg).toEqual(viaJs);
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
});
