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

describe('filtered search never loses a candidate to the presentation budget', () => {
  it('finds the one matching note among hundreds of long-path candidates', async () => {
    const folder = `threads/${'a-long-folder-name-for-many-notes-'.repeat(3)}`;
    for (let i = 0; i < 480; i += 1) {
      const name = `${String(i).padStart(4, '0')}-${'subject-words-'.repeat(5)}.md`;
      const body = i === 479 ? 'the NEEDLE-XYZ is here' : 'nothing to see';
      await fs.mkdir(path.join(h.root, folder), { recursive: true });
      await fs.writeFile(path.join(h.root, folder, name), `---\nstatus: open\n---\n${body}\n`);
    }
    await h.runtime.index.reconcile(h.runtime.adapter);
    const r = await h.call('vault_search', {
      query: 'NEEDLE-XYZ',
      where: [{ field: 'status', op: 'eq', value: 'open' }],
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { total: number }).total).toBe(1);
  });
});

describe('vault_links filter is strict like every other input', () => {
  it('a misspelled filter key is refused, not ignored', async () => {
    await h.call('vault_write', { path: 'a/t.md', content: '# T\n' });
    await h.call('vault_write', { path: 'b/s.md', content: 'see [[t]]\n' });
    const r = await h.call('vault_links', {
      path: 'a/t.md',
      filter: { prefix: 'zzz/' },
      countOnly: true,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('prefix');
  });
});

describe('vault_batch_read resolves sections the way vault_read does', () => {
  it('a body that opens with a horizontal rule keeps its headings', async () => {
    const content = '---\nt: 1\n---\n---\n# Intro\nfoo: bar\n---\n# Next\nmore\n';
    await h.call('vault_write', { path: 'hr.md', content });
    const one = await h.call('vault_read', { path: 'hr.md', sections: ['Intro'] });
    const many = await h.call('vault_batch_read', { paths: ['hr.md'], sections: ['Intro'] });
    const note = (
      many.structuredContent as { notes: { body: string; missingSections?: string[] }[] }
    ).notes[0];
    expect(note?.missingSections).toBeUndefined();
    expect(note?.body).toBe(text(one));
  });
});

describe('zero-hit hint says what is true', () => {
  it('does not suggest regex to a caller who used regex, and blames the filter when it matched nothing', async () => {
    await h.call('vault_write', { path: 'n.md', content: '---\nstatus: open\n---\nhello\n' });
    const filtered = await h.call('vault_search', {
      query: 'hello',
      where: [{ field: 'status', op: 'eq', value: 'closed' }],
    });
    const hint = (filtered.structuredContent as { hint?: string }).hint ?? '';
    expect(hint).toContain('filter');
    expect(hint).not.toContain('spelling');
    const plain = await h.call('vault_search', { query: 'absent-word' });
    expect((plain.structuredContent as { hint?: string }).hint ?? '').toContain('spelling');
  });
});
