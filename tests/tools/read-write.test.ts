import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('tool surface', () => {
  it('registers the read/write group with annotations and schemas', async () => {
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      'vault_read',
      'vault_batch_read',
      'vault_write',
      'vault_write_binary',
      'vault_edit',
      'vault_append',
      'vault_batch_frontmatter_update',
    ]) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)?.annotations?.openWorldHint).toBe(false);
    }
    expect(byName.get('vault_read')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get('vault_write')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get('vault_append')?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get('vault_batch_read')?.outputSchema).toBeDefined();
    expect(byName.get('vault_edit')?.outputSchema).toBeDefined();
  });
});

describe('vault_write / vault_read', () => {
  it('writes then reads a note, exposing frontmatter and body', async () => {
    const w = await h.call('vault_write', {
      path: '01-projects/plan.md',
      content: '---\ntitle: Plan\n---\n# Plan\n',
    });
    expect(w.isError).toBeFalsy();
    expect(w.structuredContent).toMatchObject({ path: '01-projects/plan.md' });
    const r = await h.call('vault_read', { path: '01-projects/plan.md' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('---\ntitle: Plan\n---\n# Plan\n');
    expect(r.structuredContent).toMatchObject({
      path: '01-projects/plan.md',
      frontmatter: { title: 'Plan' },
      hasFrontmatter: true,
      truncated: false,
      hash: sha256hex('---\ntitle: Plan\n---\n# Plan\n'),
    });
    expect(h.runtime.index.get('01-projects/plan.md')?.frontmatter).toEqual({ title: 'Plan' });
  });

  it('merges frontmatter when asked and rejects traversal with an actionable error', async () => {
    await h.call('vault_write', { path: 'n.md', content: '---\na: 1\n---\nold\n' });
    await h.call('vault_write', {
      path: 'n.md',
      content: '---\nb: 2\n---\nnew\n',
      mergeFrontmatter: true,
    });
    const r = await h.call('vault_read', { path: 'n.md' });
    expect(r.structuredContent).toMatchObject({ frontmatter: { a: 1, b: 2 } });
    const bad = await h.call('vault_read', { path: '../etc/passwd' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^INVALID_PATH: /);
    const missing = await h.call('vault_read', { path: 'nope.md' });
    expect(text(missing)).toMatch(/^NOT_FOUND: /);
  });

  it('clamps oversized read results', async () => {
    await fs.writeFile(path.join(h.root, 'huge.md'), 'y'.repeat(130_000));
    const r = await h.call('vault_read', { path: 'huge.md' });
    expect(r.structuredContent).toMatchObject({ truncated: true, totalChars: 130_000 });
    expect(text(r)).toContain('[truncated');
  });
});

describe('vault_batch_read', () => {
  it('reads several notes and reports missing ones', async () => {
    await h.call('vault_write', { path: 'a.md', content: 'A' });
    await h.call('vault_write', { path: 'b.md', content: 'B' });
    const r = await h.call('vault_batch_read', { paths: ['a.md', 'b.md', 'zzz.md'] });
    expect(r.structuredContent).toMatchObject({ missing: ['zzz.md'], failed: [] });
    const notes = (r.structuredContent as { notes: { path: string; body: string; hash: string }[] })
      .notes;
    expect(notes.map((n) => n.body)).toEqual(['A', 'B']);
    expect(notes.map((n) => n.hash)).toEqual([sha256hex('A'), sha256hex('B')]);
    const tooMany = await h.call('vault_batch_read', { paths: new Array(21).fill('a.md') });
    expect(tooMany.isError).toBe(true);
  });
});

describe('vault_write_binary', () => {
  it('stores base64 content for allowed media types and rejects others', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const ok = await h.call('vault_write_binary', {
      path: 'img/a.png',
      base64: png,
      mimeType: 'image/png',
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ path: 'img/a.png', bytes: 4 });
    const bad = await h.call('vault_write_binary', {
      path: 'a.exe',
      base64: png,
      mimeType: 'application/x-msdownload',
    });
    expect(bad.isError).toBe(true);
    const notB64 = await h.call('vault_write_binary', {
      path: 'img/b.png',
      base64: '%%%',
      mimeType: 'image/png',
    });
    expect(notB64.isError).toBe(true);
  });
});

describe('vault_frontmatter_update', () => {
  it('sets and unsets frontmatter keys on a single note without touching the body', async () => {
    await h.call('vault_write', {
      path: 'single.md',
      content: '---\nstatus: draft\ntemp: yes\n---\nbody\n',
    });
    const r = await h.call('vault_frontmatter_update', {
      path: 'single.md',
      set: { status: 'done' },
      unset: ['temp'],
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      path: 'single.md',
      frontmatter: { status: 'done' },
    });
    const read = await h.call('vault_read', { path: 'single.md' });
    expect(read.structuredContent).toMatchObject({ frontmatter: { status: 'done' } });
    expect(text(read)).toContain('body\n');
    expect(h.runtime.index.get('single.md')?.frontmatter).toEqual({ status: 'done' });
  });

  it('reports a failure for a non-markdown or missing file', async () => {
    const missing = await h.call('vault_frontmatter_update', {
      path: 'nope.md',
      set: { a: 1 },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/does not exist/);
  });
});

describe('vault_edit / vault_append / vault_batch_frontmatter_update', () => {
  it('previews with dryRun, applies patches, appends and updates frontmatter', async () => {
    await h.call('vault_write', { path: 'e.md', content: '---\nstatus: draft\n---\nalpha\n' });
    const dry = await h.call('vault_edit', {
      path: 'e.md',
      patches: [{ find: 'alpha', replace: 'beta' }],
      dryRun: true,
    });
    expect(dry.structuredContent).toMatchObject({ applied: 1, dryRun: true });
    expect(text(dry)).toContain('+beta');
    expect(text(await h.call('vault_read', { path: 'e.md' }))).toContain('alpha');
    const real = await h.call('vault_edit', {
      path: 'e.md',
      patches: [{ find: 'alpha', replace: 'beta' }],
    });
    expect(real.structuredContent).toMatchObject({ applied: 1, dryRun: false });
    await h.call('vault_append', { path: 'e.md', content: 'gamma' });
    expect(text(await h.call('vault_read', { path: 'e.md' }))).toBe(
      '---\nstatus: draft\n---\nbeta\ngamma\n',
    );
    const fm = await h.call('vault_batch_frontmatter_update', {
      updates: [{ path: 'e.md', set: { status: 'done' } }],
    });
    expect(fm.structuredContent).toMatchObject({ updated: ['e.md'], failed: [] });
    expect(h.runtime.index.get('e.md')?.frontmatter).toEqual({ status: 'done' });
    const ambiguous = await h.call('vault_edit', {
      path: 'e.md',
      patches: [{ find: 'a', replace: 'b' }],
    });
    expect(text(ambiguous)).toMatch(/INVALID_INPUT: patch #1/);
  });
});

describe('expectedHash / CONFLICT', () => {
  const staleHash = 'f'.repeat(64);

  function expectConflict(r: Awaited<ReturnType<Harness['call']>>, currentHash: string): void {
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^CONFLICT: /);
    expect(r.structuredContent).toMatchObject({ code: 'CONFLICT', currentHash });
  }

  it('vault_write rejects a stale expectedHash and succeeds with the current one, returning the new hash', async () => {
    await h.call('vault_write', { path: 'c.md', content: 'v1\n' });
    const v1Hash = (
      (await h.call('vault_read', { path: 'c.md' })).structuredContent as {
        hash: string;
      }
    ).hash;

    const stale = await h.call('vault_write', {
      path: 'c.md',
      content: 'v2\n',
      expectedHash: staleHash,
    });
    expectConflict(stale, v1Hash);
    expect(text(await h.call('vault_read', { path: 'c.md' }))).toBe('v1\n');

    const ok = await h.call('vault_write', {
      path: 'c.md',
      content: 'v2\n',
      expectedHash: v1Hash,
    });
    expect(ok.isError).toBeFalsy();
    const v2Hash = sha256hex('v2\n');
    expect(ok.structuredContent).toMatchObject({ path: 'c.md', hash: v2Hash });
  });

  it('vault_edit and vault_append honour expectedHash', async () => {
    await h.call('vault_write', { path: 'ce.md', content: 'alpha\n' });
    const h1 = (
      (await h.call('vault_read', { path: 'ce.md' })).structuredContent as {
        hash: string;
      }
    ).hash;

    const staleEdit = await h.call('vault_edit', {
      path: 'ce.md',
      patches: [{ find: 'alpha', replace: 'beta' }],
      expectedHash: staleHash,
    });
    expectConflict(staleEdit, h1);

    const okEdit = await h.call('vault_edit', {
      path: 'ce.md',
      patches: [{ find: 'alpha', replace: 'beta' }],
      expectedHash: h1,
    });
    expect(okEdit.isError).toBeFalsy();
    const h2 = (okEdit.structuredContent as { hash: string }).hash;
    expect(h2).toBe(sha256hex('beta\n'));

    const staleAppend = await h.call('vault_append', {
      path: 'ce.md',
      content: 'gamma',
      expectedHash: h1,
    });
    expectConflict(staleAppend, h2);

    const okAppend = await h.call('vault_append', {
      path: 'ce.md',
      content: 'gamma',
      expectedHash: h2,
    });
    expect(okAppend.isError).toBeFalsy();
    expect(okAppend.structuredContent).toMatchObject({ hash: sha256hex('beta\ngamma\n') });
  });

  it('vault_frontmatter_update honours expectedHash', async () => {
    await h.call('vault_write', { path: 'cf.md', content: '---\nstatus: draft\n---\nbody\n' });
    const h1 = (
      (await h.call('vault_read', { path: 'cf.md' })).structuredContent as {
        hash: string;
      }
    ).hash;

    const stale = await h.call('vault_frontmatter_update', {
      path: 'cf.md',
      set: { status: 'done' },
      expectedHash: staleHash,
    });
    expectConflict(stale, h1);

    const ok = await h.call('vault_frontmatter_update', {
      path: 'cf.md',
      set: { status: 'done' },
      expectedHash: h1,
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ frontmatter: { status: 'done' } });
  });

  it('vault_batch_frontmatter_update reports a per-item CONFLICT in failed[] without aborting the batch', async () => {
    await h.call('vault_write', { path: 'cb1.md', content: '---\na: 1\n---\nx\n' });
    await h.call('vault_write', { path: 'cb2.md', content: '---\na: 1\n---\ny\n' });
    const r = await h.call('vault_batch_frontmatter_update', {
      updates: [
        { path: 'cb1.md', set: { a: 2 }, expectedHash: staleHash },
        { path: 'cb2.md', set: { a: 2 } },
      ],
    });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as {
      updated: string[];
      failed: { path: string; error: string }[];
    };
    expect(body.updated).toEqual(['cb2.md']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.path).toBe('cb1.md');
    expect(body.failed[0]?.error).toMatch(/^CONFLICT: /);
    expect((await h.call('vault_read', { path: 'cb1.md' })).structuredContent).toMatchObject({
      frontmatter: { a: 1 },
    });
  });

  it('vault_move honours expectedHash for a file and rejects it outright for a folder', async () => {
    await h.call('vault_write', { path: 'cm.md', content: 'x\n' });
    const h1 = (
      (await h.call('vault_read', { path: 'cm.md' })).structuredContent as {
        hash: string;
      }
    ).hash;

    const stale = await h.call('vault_move', {
      from: 'cm.md',
      to: 'cm2.md',
      expectedHash: staleHash,
    });
    expectConflict(stale, h1);

    const ok = await h.call('vault_move', { from: 'cm.md', to: 'cm2.md', expectedHash: h1 });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ from: 'cm.md', to: 'cm2.md', hash: h1 });

    await h.call('vault_write', { path: 'cmfolder/a.md', content: 'z\n' });
    const folderMove = await h.call('vault_move', {
      from: 'cmfolder',
      to: 'cmfolder2',
      expectedHash: staleHash,
    });
    expect(text(folderMove)).toMatch(/^INVALID_INPUT: /);
  });

  it('vault_delete honours expectedHash for a single file and rejects it outright for a folder', async () => {
    await h.call('vault_write', { path: 'cd.md', content: 'x\n' });
    const h1 = (
      (await h.call('vault_read', { path: 'cd.md' })).structuredContent as {
        hash: string;
      }
    ).hash;

    const stale = await h.call('vault_delete', {
      path: 'cd.md',
      confirm: true,
      expectedHash: staleHash,
    });
    expectConflict(stale, h1);

    const ok = await h.call('vault_delete', { path: 'cd.md', confirm: true, expectedHash: h1 });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ path: 'cd.md', trashed: true });

    await h.call('vault_write', { path: 'cdfolder/a.md', content: 'z\n' });
    const folderDelete = await h.call('vault_delete', {
      path: 'cdfolder',
      confirm: true,
      expectedHash: staleHash,
    });
    expect(text(folderDelete)).toMatch(/^INVALID_INPUT: /);
  });

  it('canvas tools honour expectedHash', async () => {
    const first = await h.call('vault_canvas_add_node', {
      path: 'board.canvas',
      node: { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 100 },
    });
    const h1 = (first.structuredContent as { hash: string }).hash;

    const staleNode = await h.call('vault_canvas_add_node', {
      path: 'board.canvas',
      node: { id: 'b', type: 'text', text: 'B', x: 0, y: 0, width: 100, height: 100 },
      expectedHash: staleHash,
    });
    expectConflict(staleNode, h1);

    const second = await h.call('vault_canvas_add_node', {
      path: 'board.canvas',
      node: { id: 'b', type: 'text', text: 'B', x: 0, y: 0, width: 100, height: 100 },
      expectedHash: h1,
    });
    expect(second.isError).toBeFalsy();
    const h2 = (second.structuredContent as { hash: string }).hash;

    const staleEdge = await h.call('vault_canvas_add_edge', {
      path: 'board.canvas',
      edge: { fromNode: 'a', toNode: 'b' },
      expectedHash: staleHash,
    });
    expectConflict(staleEdge, h2);

    const edgeOk = await h.call('vault_canvas_add_edge', {
      path: 'board.canvas',
      edge: { fromNode: 'a', toNode: 'b' },
      expectedHash: h2,
    });
    expect(edgeOk.isError).toBeFalsy();
  });

  it('vault_write_binary hash is round-trippable through vault_move.expectedHash, even for real (non-UTF-8) binary content', async () => {
    // A real PNG header — not valid UTF-8 text, unlike the tiny 4-byte buffers used elsewhere in
    // this file, which exercises the "hash raw bytes, not decoded text" fallback in hashOf().
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const written = await h.call('vault_write_binary', {
      path: 'img/photo.png',
      base64: pngBytes.toString('base64'),
      mimeType: 'image/png',
    });
    expect(written.isError).toBeFalsy();
    const h1 = (written.structuredContent as { hash: string }).hash;
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    const staleMove = await h.call('vault_move', {
      from: 'img/photo.png',
      to: 'img/photo2.png',
      expectedHash: staleHash,
    });
    expectConflict(staleMove, h1);

    const ok = await h.call('vault_move', {
      from: 'img/photo.png',
      to: 'img/photo2.png',
      expectedHash: h1,
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({
      from: 'img/photo.png',
      to: 'img/photo2.png',
      hash: h1,
    });
  });

  it('vault_batch_frontmatter_update keeps updating valid items when another item has an invalid (reserved) path', async () => {
    await h.call('vault_write', { path: 'valid.md', content: '---\na: 1\n---\nx\n' });
    const r = await h.call('vault_batch_frontmatter_update', {
      updates: [
        { path: '_brainstem/x.md', set: { a: 2 } },
        { path: 'valid.md', set: { a: 2 } },
      ],
    });
    expect(r.isError).toBeFalsy();
    const body = r.structuredContent as {
      updated: string[];
      failed: { path: string; error: string }[];
    };
    expect(body.updated).toEqual(['valid.md']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.error).toMatch(/reserved/);
    expect((await h.call('vault_read', { path: 'valid.md' })).structuredContent).toMatchObject({
      frontmatter: { a: 2 },
    });
  });
});

describe('WriteGate (end-to-end, through the real harness)', () => {
  it('two overlapping vault_append calls to the same file both land — no lost update', async () => {
    await h.call('vault_write', { path: 'concurrent.md', content: 'start\n' });
    const [r1, r2] = await Promise.all([
      h.call('vault_append', { path: 'concurrent.md', content: 'line-A' }),
      h.call('vault_append', { path: 'concurrent.md', content: 'line-B' }),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const lines = text(await h.call('vault_read', { path: 'concurrent.md' }))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(expect.arrayContaining(['start', 'line-A', 'line-B']));
  });
});
