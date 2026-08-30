import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    dailyNotes: {
      folder: 'journal',
      timezone: 'Europe/Chisinau',
      template: '# {{title}}\n\n## Log\n',
    },
    requiredFrontmatter: ['type'],
  });
});

afterEach(async () => {
  await h.close();
});

describe('canvas tools', () => {
  it('creates a canvas by adding nodes and edges, then reads it back', async () => {
    const n1 = await h.call('vault_canvas_add_node', {
      path: 'boards/ideas.canvas',
      node: { id: 'a', type: 'text', text: 'Idea A', x: 0, y: 0, width: 200, height: 100 },
    });
    expect(n1.structuredContent).toMatchObject({ path: 'boards/ideas.canvas', node: { id: 'a' } });
    const n2 = await h.call('vault_canvas_add_node', {
      path: 'boards/ideas.canvas',
      node: { type: 'file', file: '01-projects/plan.md', x: 300, y: 0, width: 200, height: 100 },
    });
    const bId = (n2.structuredContent as { node: { id: string } }).node.id;
    expect(bId).toMatch(/^[0-9a-f]{16}$/);
    const e = await h.call('vault_canvas_add_edge', {
      path: 'boards/ideas.canvas',
      edge: { fromNode: 'a', toNode: bId, label: 'informs' },
    });
    expect(e.structuredContent).toMatchObject({ edge: { fromNode: 'a', toNode: bId } });
    const read = await h.call('vault_canvas_read', { path: 'boards/ideas.canvas' });
    expect(read.structuredContent).toMatchObject({ path: 'boards/ideas.canvas' });
    expect((read.structuredContent as { nodes: unknown[]; edges: unknown[] }).nodes).toHaveLength(
      2,
    );
    expect((read.structuredContent as { nodes: unknown[]; edges: unknown[] }).edges).toHaveLength(
      1,
    );
    expect(await fs.readFile(path.join(h.root, 'boards/ideas.canvas'), 'utf8')).toContain(
      '\t"nodes"',
    );
    const notCanvas = await h.call('vault_canvas_read', { path: 'note.md' });
    expect(text(notCanvas)).toMatch(/INVALID_INPUT/);
    const badEdge = await h.call('vault_canvas_add_edge', {
      path: 'boards/ideas.canvas',
      edge: { fromNode: 'a', toNode: 'nope' },
    });
    expect(text(badEdge)).toMatch(/nope/);
  });
});

describe('daily note tools', () => {
  it('resolves paths in the vault timezone, refuses to read missing notes, creates from template on append', async () => {
    const p = await h.call('vault_daily_note_path', { date: '2026-08-29' });
    expect(p.structuredContent).toEqual({
      path: 'journal/2026-08-29.md',
      date: '2026-08-29',
      exists: false,
    });
    const missing = await h.call('vault_daily_note_read', { date: '2026-08-29' });
    expect(text(missing)).toMatch(/NOT_FOUND/);
    const a = await h.call('vault_daily_note_append', {
      date: '2026-08-29',
      content: '- did a thing',
    });
    expect(a.structuredContent).toEqual({
      path: 'journal/2026-08-29.md',
      created: true,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const r = await h.call('vault_daily_note_read', { date: '2026-08-29' });
    expect(text(r)).toBe('# 2026-08-29\n\n## Log\n- did a thing\n');
    const a2 = await h.call('vault_daily_note_append', {
      date: '2026-08-29',
      content: '- another',
    });
    expect(a2.structuredContent).toEqual({
      path: 'journal/2026-08-29.md',
      created: false,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const today = await h.call('vault_daily_note_path', {});
    expect((today.structuredContent as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const bad = await h.call('vault_daily_note_path', { date: 'tomorrow' });
    expect(text(bad)).toMatch(/INVALID_INPUT/);
  });

  it('creates the daily note with default frontmatter when no template is configured', async () => {
    const fresh = await startHarness({ requiredFrontmatter: ['type'] });
    try {
      const a = await fresh.call('vault_daily_note_append', {
        date: '2026-08-29',
        content: '- did a thing',
      });
      expect(a.structuredContent).toMatchObject({ created: true });
      const r = await fresh.call('vault_daily_note_read', { date: '2026-08-29' });
      expect(r.structuredContent).toMatchObject({
        frontmatter: { type: 'daily', date: '2026-08-29' },
      });
      expect(text(r)).toBe(
        '---\ntype: daily\ndate: 2026-08-29\n---\n\n# 2026-08-29\n- did a thing\n',
      );
      const s = await fresh.call('vault_analytics_summary', {});
      expect(s.structuredContent).toMatchObject({
        categories: {
          frontmatter_missing: { count: 0 },
          required_frontmatter_missing: { count: 0 },
        },
      });
    } finally {
      await fresh.close();
    }
  });
});

describe('analytics tools', () => {
  it('summarizes hygiene issues, caches, and drills into a category', async () => {
    await h.call('vault_write', { path: 'a.md', content: '---\ntype: note\n---\n[[missing]]\n' });
    await h.call('vault_write', { path: 'b.md', content: 'no frontmatter\n' });
    const s = await h.call('vault_analytics_summary', {});
    expect(s.structuredContent).toMatchObject({
      scannedFiles: 2,
      truncated: false,
      categories: {
        frontmatter_missing: { count: 1, examples: ['b.md'] },
        required_frontmatter_missing: { count: 1, examples: ['b.md'] },
        broken_wikilinks: { count: 1, examples: ['a.md'] },
      },
    });
    await h.call('vault_write', { path: 'c.md', content: 'also none\n' });
    const cached = await h.call('vault_analytics_summary', {});
    expect((cached.structuredContent as { scannedFiles: number }).scannedFiles).toBe(2);
    const fresh = await h.call('vault_analytics_summary', { refresh: true });
    expect((fresh.structuredContent as { scannedFiles: number }).scannedFiles).toBe(3);
    const f = await h.call('vault_analytics_findings', { category: 'broken_wikilinks' });
    expect(f.structuredContent).toEqual({
      category: 'broken_wikilinks',
      total: 1,
      findings: [{ category: 'broken_wikilinks', path: 'a.md', detail: 'missing' }],
    });
    const badCat = await h.call('vault_analytics_findings', { category: 'nonsense' });
    expect(badCat.isError).toBe(true);
  });
});
