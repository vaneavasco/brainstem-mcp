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

const NOTE = `${[
  '# Title',
  '',
  '## Alpha',
  'alpha content',
  '',
  '## Beta',
  'beta content',
  '',
  '## Gamma',
  'gamma content',
].join('\n')}\n`;

describe('vault_read section', () => {
  it('returns only the section slice as text, plus sectionRange, leaving other fields as usual', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const full = await h.call('vault_read', { path: 'n.md' });
    const fullHash = (full.structuredContent as { hash: string }).hash;

    const r = await h.call('vault_read', { path: 'n.md', section: 'Beta' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('## Beta\nbeta content\n');
    expect(r.structuredContent).toMatchObject({
      path: 'n.md',
      hash: fullHash,
      sectionRange: { startLine: 6, endLine: 8 },
      truncated: false,
      totalChars: '## Beta\nbeta content\n'.length,
    });
  });

  it('resolves a nested "H1 > H2" heading path', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', section: 'Title > Gamma' });
    expect(text(r)).toBe('## Gamma\ngamma content\n');
    expect(r.structuredContent).toMatchObject({ sectionRange: { startLine: 9, endLine: 11 } });
  });

  it('fails with NOT_FOUND listing the headings that exist for an unknown heading path', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', section: 'Nope' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
    expect(text(r)).toContain('Title');
    expect(text(r)).toContain('Title > Alpha');
    expect(text(r)).toContain('Title > Beta');
    expect(text(r)).toContain('Title > Gamma');
  });

  it('reports no headings for a note that has none', async () => {
    await h.call('vault_write', { path: 'flat.md', content: 'just text, no headings\n' });
    const r = await h.call('vault_read', { path: 'flat.md', section: 'Anything' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
    expect(text(r)).toMatch(/no headings/);
  });

  it('still reads the whole file when "section" is omitted', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md' });
    expect(text(r)).toBe(NOTE);
    expect(r.structuredContent).not.toHaveProperty('sectionRange');
  });
});

describe('vault_append heading', () => {
  it('inserts under a heading (default position "end"), landing before the next heading with one blank line', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_append', {
      path: 'n.md',
      content: 'new alpha line',
      heading: 'Alpha',
    });
    expect(r.isError).toBeFalsy();
    const expected = `${[
      '# Title',
      '',
      '## Alpha',
      'alpha content',
      'new alpha line',
      '',
      '## Beta',
      'beta content',
      '',
      '## Gamma',
      'gamma content',
    ].join('\n')}\n`;
    expect(text(await h.call('vault_read', { path: 'n.md' }))).toBe(expected);
    expect((r.structuredContent as { hash: string }).hash).toBe(sha256hex(expected));
  });

  it('inserts at position "start", right after the heading line', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    await h.call('vault_append', {
      path: 'n.md',
      content: 'first alpha line',
      heading: 'Alpha',
      position: 'start',
    });
    const after = text(await h.call('vault_read', { path: 'n.md' }));
    expect(after).toBe(
      `${[
        '# Title',
        '',
        '## Alpha',
        'first alpha line',
        'alpha content',
        '',
        '## Beta',
        'beta content',
        '',
        '## Gamma',
        'gamma content',
      ].join('\n')}\n`,
    );
  });

  it('fails with NOT_FOUND listing headings when the heading does not exist', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_append', {
      path: 'n.md',
      content: 'x',
      heading: 'Nope',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
    expect(text(r)).toContain('Title > Alpha');
  });

  it('rejects a stale expectedHash with CONFLICT and leaves the file untouched', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const staleHash = 'f'.repeat(64);
    const r = await h.call('vault_append', {
      path: 'n.md',
      content: 'should not land',
      heading: 'Alpha',
      expectedHash: staleHash,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^CONFLICT: /);
    expect(r.structuredContent).toMatchObject({ code: 'CONFLICT' });
    expect(text(await h.call('vault_read', { path: 'n.md' }))).toBe(NOTE);
  });

  it('succeeds with the correct expectedHash, returning the new hash', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const h1 = (
      (await h.call('vault_read', { path: 'n.md' })).structuredContent as { hash: string }
    ).hash;
    const r = await h.call('vault_append', {
      path: 'n.md',
      content: 'gamma addition',
      heading: 'Gamma',
      expectedHash: h1,
    });
    expect(r.isError).toBeFalsy();
    const after = await h.call('vault_read', { path: 'n.md' });
    expect((r.structuredContent as { hash: string }).hash).toBe(
      (after.structuredContent as { hash: string }).hash,
    );
    expect(text(after)).toContain('gamma content\ngamma addition\n');
  });

  it('leaves plain vault_append (no heading) behaviour unchanged', async () => {
    await h.call('vault_write', { path: 'plain.md', content: 'start\n' });
    await h.call('vault_append', { path: 'plain.md', content: 'more' });
    expect(text(await h.call('vault_read', { path: 'plain.md' }))).toBe('start\nmore\n');
  });
});
