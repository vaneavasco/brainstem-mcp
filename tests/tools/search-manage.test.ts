import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    expect(mv.structuredContent).toEqual({
      from: '00-inbox/todo.md',
      to: '04-archive/todo.md',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
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

  it('locks every path already inside a folder being moved, so a concurrent write to an existing file in it cannot race the rename', async () => {
    await h.call('vault_write', { path: 'projF/plan.md', content: 'original\n' });
    await h.call('vault_write', { path: 'projF/notes.md', content: 'notes\n' });

    const events: string[] = [];
    const gate = deferred<void>();
    const originalMove = h.runtime.adapter.move.bind(h.runtime.adapter);
    h.runtime.adapter.move = (async (...args: Parameters<typeof originalMove>) => {
      events.push('move-start');
      await gate.promise;
      const result = await originalMove(...args);
      events.push('move-end');
      return result;
    }) as typeof originalMove;

    const movePromise = h.call('vault_move', { from: 'projF', to: 'projF2' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(['move-start']); // move is holding the lock, waiting on `gate`

    const writePromise = h.call('vault_write', { path: 'projF/plan.md', content: 'concurrent\n' });
    await new Promise((r) => setTimeout(r, 30));
    // Must still be blocked: with the fix, vault_write shares the 'projF/plan.md' lock key with
    // the folder move (before the fix, this key was disjoint from the move's [src, dst] lock and
    // the write would have run immediately here).
    expect(events).toEqual(['move-start']);

    gate.resolve();
    const [moveResult, writeResult] = await Promise.all([movePromise, writePromise]);
    expect(events).toEqual(['move-start', 'move-end']);
    expect(moveResult.isError).toBeFalsy();
    expect(writeResult.isError).toBeFalsy();

    // Fully serialized (the move ran to completion before the write, per the event order above):
    // the original note ends up only at the destination, and the write created an independent
    // new file at the now-vacated source path — the original content is never present twice.
    expect(text(await h.call('vault_read', { path: 'projF2/plan.md' }))).toBe('original\n');
    expect(text(await h.call('vault_read', { path: 'projF/plan.md' }))).toBe('concurrent\n');
    expect(text(await h.call('vault_read', { path: 'projF2/notes.md' }))).toBe('notes\n');
  });

  it('locks every path already inside a folder being deleted, so a concurrent write cannot race the soft-delete', async () => {
    await h.call('vault_write', { path: 'projG/plan.md', content: 'original\n' });

    const events: string[] = [];
    const gate = deferred<void>();
    const originalSoftDelete = h.runtime.adapter.softDelete.bind(h.runtime.adapter);
    h.runtime.adapter.softDelete = (async (...args: Parameters<typeof originalSoftDelete>) => {
      events.push('delete-start');
      await gate.promise;
      const result = await originalSoftDelete(...args);
      events.push('delete-end');
      return result;
    }) as typeof originalSoftDelete;

    const deletePromise = h.call('vault_delete', { path: 'projG', confirm: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(['delete-start']);

    const writePromise = h.call('vault_write', { path: 'projG/plan.md', content: 'concurrent\n' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(['delete-start']);

    gate.resolve();
    const [deleteResult, writeResult] = await Promise.all([deletePromise, writePromise]);
    expect(events).toEqual(['delete-start', 'delete-end']);
    expect(deleteResult.isError).toBeFalsy();
    expect(writeResult.isError).toBeFalsy();

    expect(await fs.readFile(path.join(h.root, '.trash/projG/plan.md'), 'utf8')).toBe('original\n');
    expect(text(await h.call('vault_read', { path: 'projG/plan.md' }))).toBe('concurrent\n');
  });
});
