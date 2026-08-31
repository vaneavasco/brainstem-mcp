import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Polls until `cond()` holds (or the deadline passes — the caller's assertion then reports the
 *  actual state). For "the call has reached X" checks, which a fixed sleep under-waits on a
 *  loaded CI runner: the in-flight tool call crosses a real HTTP round-trip plus planning I/O
 *  before it can hit the instrumented adapter method. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
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

  it('reports total and truncated alongside the matches', async () => {
    const r = await h.call('vault_search', { query: 'milk' });
    expect(r.structuredContent).toMatchObject({ total: 2, truncated: false });
    const limited = await h.call('vault_search', { query: 'milk', limit: 1 });
    expect(limited.structuredContent).toMatchObject({ total: 1, truncated: true });
  });

  it('groups matches per file under "files" while keeping the flat "matches" array', async () => {
    await h.call('vault_write', { path: 'multi.md', content: 'milk one\nmilk two\n' });
    const r = await h.call('vault_search', { query: 'milk' });
    const sc = r.structuredContent as {
      files: { path: string; matches: { line: number; text: string }[] }[];
      matches: { path: string; line: number }[];
    };
    const multi = sc.files.find((f) => f.path === 'multi.md');
    expect(multi?.matches.map((m) => m.line)).toEqual([1, 2]);
    expect(sc.matches.filter((m) => m.path === 'multi.md').map((m) => m.line)).toEqual([1, 2]);
    expect(sc.files.map((f) => f.path)).toEqual([
      '00-inbox/todo.md',
      '02-areas/health.md',
      'multi.md',
    ]);
  });

  it('narrows candidates by tags before searching text', async () => {
    await h.call('vault_write', {
      path: '03-tagged/a.md',
      content: '---\ntags: [proj]\n---\nmilk in the fridge\n',
    });
    await h.call('vault_write', {
      path: '03-tagged/b.md',
      content: '---\ntags: [other]\n---\nmilk on the shelf\n',
    });
    const r = await h.call('vault_search', { query: 'milk', tags: { any: ['proj'] } });
    const sc = r.structuredContent as { matches: { path: string }[] };
    expect(sc.matches.map((m) => m.path)).toEqual(['03-tagged/a.md']);
  });

  it('narrows candidates by a where condition before searching text', async () => {
    const r = await h.call('vault_search', {
      query: 'milk',
      where: [{ field: 'status', op: 'eq', value: 'open' }],
    });
    // '00-inbox/todo.md' has status:open and contains "milk"; '02-areas/health.md' has no
    // frontmatter at all, so the where condition excludes it even though it also matches "milk".
    const sc = r.structuredContent as { matches: { path: string }[] };
    expect(sc.matches.map((m) => m.path)).toEqual(['00-inbox/todo.md']);
  });

  it('narrows candidates by glob before searching text', async () => {
    await h.call('vault_write', { path: 'note.txt', content: 'milk in a plain text file\n' });
    const r = await h.call('vault_search', { query: 'milk', glob: '**/*.md' });
    const sc = r.structuredContent as { matches: { path: string }[] };
    expect(sc.matches.map((m) => m.path)).not.toContain('note.txt');
    expect(sc.matches.map((m) => m.path)).toContain('00-inbox/todo.md');
  });

  it('rejects regex:true without ripgrep with UNSUPPORTED (this harness runs the JS fallback)', async () => {
    const r = await h.call('vault_search', { query: 'mi.k', regex: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/UNSUPPORTED/);
  });

  // Regression: candidate filtering used to run one unscoped, alphabetically-ordered
  // adapter.search() call and filter its (limit-capped) output by candidate path afterwards —
  // so if enough non-candidate files sorted before any candidate file, the limit was exhausted
  // before a single candidate was ever scanned, silently returning zero results with
  // truncated:false. Both branches below (chunked ≤MAX_QUERY_ROWS candidates, and the
  // full-scan fallback when the candidate list itself is truncated) must never do that.
  describe('candidate filtering never drops real matches', () => {
    async function writeTagged(paths: string[], tag: string): Promise<void> {
      for (let i = 0; i < paths.length; i += 50) {
        const batch = paths.slice(i, i + 50);
        await Promise.all(
          batch.map(async (p) => {
            await h.runtime.adapter.write(p, `---\ntags: [${tag}]\n---\nneedle here\n`);
            await h.runtime.index.refreshPath(h.runtime.adapter, p);
          }),
        );
      }
    }

    it('chunks a 201..500-candidate search instead of exhausting the limit on non-candidate files first', async () => {
      const untagged = Array.from(
        { length: 60 },
        (_, i) => `a-untagged-${String(i).padStart(3, '0')}.md`,
      );
      const tagged = Array.from(
        { length: 201 },
        (_, i) => `z-tagged-${String(i).padStart(3, '0')}.md`,
      );
      await writeTagged(untagged, 'other');
      await writeTagged(tagged, 'x');

      const r = await h.call('vault_search', { query: 'needle', tags: { any: ['x'] } });
      const sc = r.structuredContent as { matches: { path: string }[]; truncated: boolean };
      expect(sc.matches.length).toBeGreaterThan(0);
      expect(sc.matches.every((m) => m.path.startsWith('z-tagged-'))).toBe(true);
      expect(sc.truncated).toBe(true);
    }, 30_000);

    it('still finds matches via the full-scan fallback when the candidate set exceeds MAX_QUERY_ROWS', async () => {
      const tagged = Array.from({ length: 520 }, (_, i) => `big-${String(i).padStart(4, '0')}.md`);
      await writeTagged(tagged, 'y');

      const r = await h.call('vault_search', { query: 'needle', tags: { any: ['y'] } });
      const sc = r.structuredContent as { matches: { path: string }[]; truncated: boolean };
      expect(sc.matches.length).toBeGreaterThan(0);
      expect(sc.matches.every((m) => m.path.startsWith('big-'))).toBe(true);
      expect(sc.truncated).toBe(true);
    }, 30_000);
  });
});

describe.skipIf(!hasRipgrep())('vault_search regex (real ripgrep)', () => {
  it('runs a regex query end-to-end through the tool', async () => {
    const rgHarness = await startHarness(undefined, 'rg');
    try {
      await rgHarness.call('vault_write', { path: 'r.md', content: 'a cat and a dog\n' });
      const r = await rgHarness.call('vault_search', { query: 'cat|dog', regex: true });
      expect(r.structuredContent).toMatchObject({ regex: true, truncated: false });
      const sc = r.structuredContent as { matches: { path: string }[] };
      expect(sc.matches.map((m) => m.path)).toEqual(['r.md']);
    } finally {
      await rgHarness.close();
    }
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
      linksUpdated: [],
      failed: [],
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

  it('drops deleted attachments from the index, alone and under a deleted folder', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    await h.call('vault_write_binary', { path: 'att/img.png', base64: png, mimeType: 'image/png' });
    await h.call('vault_write_binary', {
      path: 'more/deep/img2.png',
      base64: png,
      mimeType: 'image/png',
    });
    // The chokidar watcher registers new assets asynchronously; do it deterministically here.
    h.runtime.index.addAsset('att/img.png');
    h.runtime.index.addAsset('more/deep/img2.png');
    await h.call('vault_write', { path: 'uses.md', content: '![[att/img.png]]\n' });
    expect(h.runtime.graph.resolve('att/img.png', 'uses.md').status).toBe('resolved');

    const one = await h.call('vault_delete', { path: 'att/img.png', confirm: true });
    expect(one.isError).toBeFalsy();
    expect([...h.runtime.index.assets()]).not.toContain('att/img.png');
    expect(h.runtime.graph.resolve('att/img.png', 'uses.md').status).toBe('unresolved');

    const folder = await h.call('vault_delete', { path: 'more', confirm: true });
    expect(folder.isError).toBeFalsy();
    expect([...h.runtime.index.assets()]).not.toContain('more/deep/img2.png');
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
    await waitFor(() => events.length > 0);
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
    await waitFor(() => events.length > 0);
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
