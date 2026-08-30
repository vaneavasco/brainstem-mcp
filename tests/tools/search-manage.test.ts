import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.call('vault_write', {
    path: '00-inbox/todo.md',
    content: '---\ntype: task\nstatus: open\n---\nBuy milk\n',
  });
  await h.call('vault_write', {
    path: '01-projects/brainstem/plan.md',
    content: '---\ntype: project\nstatus: open\n---\nShip it\n',
  });
  await h.call('vault_write', { path: '02-areas/health.md', content: 'Drink milk\n' });
});

afterEach(async () => {
  await h.close();
});

describe('vault_search', () => {
  it('returns literal matches with a truncation flag and honors limit/prefix', async () => {
    const r = await h.call('vault_search', { query: 'milk' });
    expect(r.structuredContent).toMatchObject({ query: 'milk', truncated: false });
    const matches = (
      r.structuredContent as { matches: { path: string; line: number; text: string }[] }
    ).matches;
    expect(matches.map((m) => m.path)).toEqual(['00-inbox/todo.md', '02-areas/health.md']);
    const limited = await h.call('vault_search', { query: 'milk', limit: 1 });
    expect(limited.structuredContent).toMatchObject({ truncated: true });
    const scoped = await h.call('vault_search', { query: 'milk', pathPrefix: '02-areas' });
    expect((scoped.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);
    const empty = await h.call('vault_search', { query: '  ' });
    expect(empty.isError).toBe(true);
  });
});

describe('vault_search_frontmatter', () => {
  it('queries the index by equals/contains/exists and requires a criterion', async () => {
    const r = await h.call('vault_search_frontmatter', { field: 'status', equals: 'open' });
    expect(r.structuredContent).toMatchObject({ truncated: false });
    expect((r.structuredContent as { hits: { path: string }[] }).hits.map((x) => x.path)).toEqual([
      '00-inbox/todo.md',
      '01-projects/brainstem/plan.md',
    ]);
    const ex = await h.call('vault_search_frontmatter', { field: 'type', exists: false });
    expect((ex.structuredContent as { hits: { path: string }[] }).hits.map((x) => x.path)).toEqual([
      '02-areas/health.md',
    ]);
    const none = await h.call('vault_search_frontmatter', { field: 'type' });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/INVALID_INPUT/);
  });

  it('caps hits at MAX_FRONTMATTER_HITS and sets truncated', async () => {
    for (let i = 0; i < 505; i += 1) {
      h.runtime.index.upsert({
        path: `bulk/n${i}.md`,
        frontmatter: { status: 'open' },
        hasFrontmatter: true,
        size: 1,
        modifiedAt: new Date().toISOString(),
        hash: `hash-${i}`,
        links: [],
        tags: [],
        headings: [],
        blockIds: [],
        wordCount: 0,
      });
    }
    const r = await h.call('vault_search_frontmatter', { field: 'status', equals: 'open' });
    const sc = r.structuredContent as { hits: unknown[]; truncated: boolean };
    expect(sc.hits).toHaveLength(500);
    expect(sc.truncated).toBe(true);
  });
});

describe('vault_list', () => {
  it('lists with depth and glob and rejects hidden folders', async () => {
    const top = await h.call('vault_list', {});
    expect(top.structuredContent).toMatchObject({ truncated: false });
    expect(
      (top.structuredContent as { entries: { path: string; kind: string }[] }).entries.map(
        (e) => e.path,
      ),
    ).toEqual(['00-inbox', '01-projects', '02-areas']);
    const md = await h.call('vault_list', {
      path: '01-projects',
      depth: 3,
      glob: '**/*.md',
      includeDirs: false,
    });
    expect(
      (md.structuredContent as { entries: { path: string }[] }).entries.map((e) => e.path),
    ).toEqual(['01-projects/brainstem/plan.md']);
    const hidden = await h.call('vault_list', { path: '.obsidian' });
    expect(text(hidden)).toMatch(/INVALID_PATH/);
  });

  it('caps entries at MAX_LIST_ENTRIES and sets truncated', async () => {
    // Plain .txt files written in parallel batches: they are ignored by the frontmatter index,
    // so this exercises the list cap without a 2005-event watcher/index storm (slow on CI).
    const dir = path.join(h.root, 'bulk');
    await fs.mkdir(dir, { recursive: true });
    const names = Array.from({ length: 2005 }, (_, i) => `n${i}.txt`);
    for (let i = 0; i < names.length; i += 250) {
      await Promise.all(names.slice(i, i + 250).map((n) => fs.writeFile(path.join(dir, n), 'x')));
    }
    const r = await h.call('vault_list', { path: 'bulk', depth: 1 });
    const sc = r.structuredContent as { entries: unknown[]; truncated: boolean };
    expect(sc.entries).toHaveLength(2000);
    expect(sc.truncated).toBe(true);
  }, 60_000);
});

describe('vault_move / vault_delete', () => {
  it('moves files and folders keeping the index in sync', async () => {
    const mv = await h.call('vault_move', { from: '00-inbox/todo.md', to: '04-archive/todo.md' });
    expect(mv.structuredContent).toEqual({ from: '00-inbox/todo.md', to: '04-archive/todo.md' });
    expect(h.runtime.index.get('00-inbox/todo.md')).toBeUndefined();
    expect(h.runtime.index.get('04-archive/todo.md')?.frontmatter).toMatchObject({ type: 'task' });
    await h.call('vault_move', { from: '01-projects/brainstem', to: '01-projects/bs' });
    expect(h.runtime.index.get('01-projects/bs/plan.md')).toBeDefined();
    expect(h.runtime.index.get('01-projects/brainstem/plan.md')).toBeUndefined();
    const clash = await h.call('vault_move', {
      from: '04-archive/todo.md',
      to: '02-areas/health.md',
    });
    expect(text(clash)).toMatch(/ALREADY_EXISTS/);
  });

  it('requires confirm=true and soft-deletes into .trash', async () => {
    const refused = await h.call('vault_delete', { path: '02-areas/health.md', confirm: false });
    expect(text(refused)).toMatch(/CONFIRM_REQUIRED/);
    const ok = await h.call('vault_delete', { path: '02-areas/health.md', confirm: true });
    expect(ok.structuredContent).toEqual({ path: '02-areas/health.md', trashed: true });
    expect(await fs.readFile(path.join(h.root, '.trash/02-areas/health.md'), 'utf8')).toBe(
      'Drink milk\n',
    );
    expect(h.runtime.index.get('02-areas/health.md')).toBeUndefined();
    const gone = await h.call('vault_read', { path: '02-areas/health.md' });
    expect(text(gone)).toMatch(/NOT_FOUND/);
  });
});
