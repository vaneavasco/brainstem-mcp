import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(
      (r.structuredContent as { notes: { path: string; body: string }[] }).notes.map((n) => n.body),
    ).toEqual(['A', 'B']);
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
      path: 'a.svg',
      base64: png,
      mimeType: 'image/svg+xml',
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
