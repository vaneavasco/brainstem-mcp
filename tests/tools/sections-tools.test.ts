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

describe('vault_read sections', () => {
  it('returns several sections in document order, joined by a blank line, with their ranges', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', sections: ['Gamma', 'Alpha'] });
    expect(r.isError).toBeFalsy();
    const expected = '## Alpha\nalpha content\n\n## Gamma\ngamma content\n';
    expect(text(r)).toBe(expected);
    expect(r.structuredContent).toMatchObject({
      path: 'n.md',
      text: expected,
      truncated: false,
      totalChars: expected.length,
      sectionRanges: [
        { heading: 'Alpha', startLine: 3, endLine: 5 },
        { heading: 'Gamma', startLine: 9, endLine: 11 },
      ],
    });
    expect(r.structuredContent).not.toHaveProperty('sectionRange');
  });

  it('returns a section once when two heading paths resolve to it', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', sections: ['Beta', 'Title > Beta'] });
    expect(text(r)).toBe('## Beta\nbeta content\n');
    expect((r.structuredContent as { sectionRanges: unknown[] }).sectionRanges).toHaveLength(1);
  });

  it('fails with NOT_FOUND and the existing headings when one heading path is unknown', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', sections: ['Alpha', 'Nope'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND: /);
    expect(text(r)).toContain('Title > Alpha');
  });

  it('refuses "section" together with "sections"', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', section: 'Alpha', sections: ['Beta'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/section/);
  });
});

describe('vault_read sections — shape', () => {
  const TIGHT = '# T\n## One\none\n## Two\ntwo\n### Deep\ndeep\n## Three\nthree\n';

  it('separates sections by exactly one blank line even when the note has none', async () => {
    await h.call('vault_write', { path: 't.md', content: TIGHT });
    const r = await h.call('vault_read', { path: 't.md', sections: ['One', 'Three'] });
    expect(text(r)).toBe('## One\none\n\n## Three\nthree\n');
  });

  it('returns a section once when its parent was asked for too', async () => {
    await h.call('vault_write', { path: 't.md', content: TIGHT });
    const r = await h.call('vault_read', { path: 't.md', sections: ['Two > Deep', 'Two'] });
    expect(text(r)).toBe('## Two\ntwo\n### Deep\ndeep\n');
    expect((r.structuredContent as { sectionRanges: unknown[] }).sectionRanges).toHaveLength(1);
  });

  it('keeps every content line byte-exact: CRLF endings and trailing spaces survive, only blank lines between sections are normalised', async () => {
    await h.call('vault_write', {
      path: 'crlf.md',
      content: '# T\r\n## A\r\na  \r\n\r\n\r\n## B\r\nb\r\n',
    });
    const r = await h.call('vault_read', { path: 'crlf.md', sections: ['A', 'B'] });
    expect(text(r)).toBe('## A\r\na  \r\n\r\n## B\r\nb\r\n');
    await h.call('vault_write', { path: 'lf.md', content: '# T\n## A\nhard break  \n\n## B\nb' });
    const lf = await h.call('vault_read', { path: 'lf.md', sections: ['A', 'B'] });
    expect(text(lf)).toBe('## A\nhard break  \n\n## B\nb\n');
  });

  it('labels each returned range with the heading it resolved to, whatever spelling was asked for', async () => {
    await h.call('vault_write', { path: 't.md', content: TIGHT });
    const r = await h.call('vault_read', { path: 't.md', sections: ['two > deep', 'ONE'] });
    expect(
      (r.structuredContent as { sectionRanges: { heading: string }[] }).sectionRanges.map(
        (x) => x.heading,
      ),
    ).toEqual(['One', 'Deep']);
  });

  it('maxChars cuts the read earlier than the server limit and says so', async () => {
    await h.call('vault_write', { path: 'long.md', content: `# L\n${'word '.repeat(2_000)}\n` });
    const r = await h.call('vault_read', { path: 'long.md', maxChars: 1_000 });
    expect(r.structuredContent).toMatchObject({ truncated: true, totalChars: 10_005 });
    expect(text(r)).toContain('[truncated: showing 1000 of 10005 characters]');
    expect(text(r).length).toBeLessThan(1_060); // 1,000 + the marker line
  });

  it('starts the second content block on its own line', async () => {
    await h.call('vault_write', { path: 't.md', content: 'no trailing newline' });
    const r = await h.call('vault_read', { path: 't.md' });
    expect((r.content[1] as { text: string }).text.startsWith('\n[brainstem] ')).toBe(true);
  });
});

describe('truncated reads', () => {
  const BIG = `# Big\n\n## Head\nshort\n\n## Tail\n${'word '.repeat(30_000)}\n`;

  it('vault_read says how to read the rest when the text was cut', async () => {
    await h.call('vault_write', { path: 'big.md', content: BIG });
    const r = await h.call('vault_read', { path: 'big.md' });
    expect(r.structuredContent).toMatchObject({ truncated: true });
    const hint = (r.structuredContent as { hint?: string }).hint ?? '';
    expect(hint).toContain('vault_outline');
    expect(hint).toContain('sections');
    const head = await h.call('vault_read', { path: 'big.md', section: 'Head' });
    expect(head.structuredContent).toMatchObject({ truncated: false });
    expect(head.structuredContent).not.toHaveProperty('hint');
  });

  it('vault_batch_read carries the same hint when a note was cut', async () => {
    await h.call('vault_write', { path: 'big.md', content: BIG });
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const cut = await h.call('vault_batch_read', { paths: ['big.md', 'n.md'] });
    expect((cut.structuredContent as { hint?: string }).hint ?? '').toContain('vault_outline');
    const whole = await h.call('vault_batch_read', { paths: ['n.md'] });
    expect(whole.structuredContent).not.toHaveProperty('hint');
  });
});

describe('vault_batch_read sections and maxChars', () => {
  type BatchNote = { path: string; body: string; truncated: boolean; missingSections?: string[] };
  const notesOf = (r: { structuredContent?: unknown }) =>
    (r.structuredContent as { notes: BatchNote[] }).notes;
  const BIG = `# Big\n\n## Head\nshort\n\n## Tail\n${'word '.repeat(30_000)}\n`;

  it('returns only the asked sections of every note, in document order', async () => {
    await h.call('vault_write', { path: 'a.md', content: NOTE });
    await h.call('vault_write', { path: 'b.md', content: NOTE.replace('alpha content', 'other') });
    const r = await h.call('vault_batch_read', {
      paths: ['a.md', 'b.md'],
      sections: ['Gamma', 'Alpha'],
    });
    expect(r.isError).toBeFalsy();
    const [a, b] = notesOf(r);
    expect(a?.body).toBe('## Alpha\nalpha content\n\n## Gamma\ngamma content\n');
    expect(b?.body).toBe('## Alpha\nother\n\n## Gamma\ngamma content\n');
    expect(a).not.toHaveProperty('missingSections');
  });

  it('a note without one of the sections still answers, and names what it lacks', async () => {
    await h.call('vault_write', { path: 'a.md', content: NOTE });
    await h.call('vault_write', { path: 'short.md', content: '# T\n\n## Alpha\nonly alpha\n' });
    await h.call('vault_write', { path: 'none.md', content: '# T\n\nplain\n' });
    const r = await h.call('vault_batch_read', {
      paths: ['a.md', 'short.md', 'none.md'],
      sections: ['Alpha', 'Beta'],
    });
    expect(r.isError).toBeFalsy();
    const [a, short, none] = notesOf(r);
    expect(a?.body).toContain('beta content');
    expect(short?.body).toBe('## Alpha\nonly alpha\n');
    expect(short?.missingSections).toEqual(['Beta']);
    expect(none?.body).toBe('');
    expect(none?.missingSections).toEqual(['Alpha', 'Beta']);
  });

  it('maxChars cuts every note on its own and the result says so', async () => {
    await h.call('vault_write', { path: 'big.md', content: BIG });
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_batch_read', { paths: ['big.md', 'n.md'], maxChars: 600 });
    const [big, n] = notesOf(r);
    expect(big?.truncated).toBe(true);
    expect(big?.body.length).toBeLessThan(800);
    expect(n?.truncated).toBe(false);
    expect((r.structuredContent as { hint?: string }).hint ?? '').toContain('vault_outline');
  });
});

describe('vault_batch_read shares one budget fairly', () => {
  it('a short note leaves its share to a long one; the total never exceeds the budget', async () => {
    const { shareBudget } = await import('../../src/tools/read.ts');
    expect(shareBudget([100, 45_000], 60_000)).toEqual([100, 45_000]);
    expect(shareBudget([100, 80_000], 60_000)).toEqual([100, 59_900]);
    expect(shareBudget([50_000, 50_000, 10], 60_000)).toEqual([29_995, 29_995, 10]);
    expect(shareBudget([9_000, 9_000], 60_000, 600)).toEqual([600, 600]);
    expect(shareBudget([], 60_000)).toEqual([]);
    const many = shareBudget(new Array(20).fill(100_000), 60_000);
    expect(many.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  it('two notes of very different length both arrive whole when they fit together', async () => {
    // more than an even share of the budget: an even split would have cut it
    const long = `# Long\n\n${'word '.repeat(6_000)}\n`; // 30k characters
    await h.call('vault_write', { path: 'long.md', content: long });
    await h.call('vault_write', { path: 'short.md', content: '# Short\nhi\n' });
    const r = await h.call('vault_batch_read', { paths: ['short.md', 'long.md'] });
    const notes = (r.structuredContent as { notes: { truncated: boolean }[] }).notes;
    expect(notes.map((n) => n.truncated)).toEqual([false, false]);
    expect(r.structuredContent).not.toHaveProperty('hint');
  });
});

describe('vault_batch_read bounds what the client receives, not only the bodies', () => {
  it('twenty notes with heavy frontmatter and long bodies stay within the client-safe size', async () => {
    const { CLIENT_SAFE_RESULT_CHARS } = await import('../../src/storage/limits.ts');
    const paths: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const ids = Array.from({ length: 60 }, (_, k) => `"<id-${i}-${k}-${'x'.repeat(40)}>"`);
      const content = `---\nids: [${ids.join(', ')}]\nstatus: open\n---\n# N${i}\n\n## Summary\n${'word '.repeat(2_000)}\n`;
      paths.push(`heavy/n${i}.md`);
      await h.call('vault_write', { path: `heavy/n${i}.md`, content });
    }
    const r = await h.call('vault_batch_read', { paths, sections: ['Summary'] });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(
      CLIENT_SAFE_RESULT_CHARS,
    );
    const body = r.structuredContent as {
      notes: { frontmatter: object; frontmatterOmitted?: boolean; body: string }[];
      hint?: string;
    };
    const omitted = body.notes.filter((n) => n.frontmatterOmitted);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((n) => Object.keys(n.frontmatter).length === 0)).toBe(true);
    expect(body.notes.every((n) => n.body.includes('## Summary'))).toBe(true); // every note still answers
    expect(body.hint).toContain('frontmatterOmitted');
  });

  const received = (r: { structuredContent?: unknown }) =>
    JSON.stringify(r.structuredContent).length;

  it('a body that is denser at the start than on average does not slip past the budget', async () => {
    const { CLIENT_SAFE_RESULT_CHARS } = await import('../../src/storage/limits.ts');
    const paths: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      // 1,500 short quoted list lines (every line break and quote costs two characters in JSON),
      // then long prose: the average escape ratio badly underestimates the prefix
      const dense = Array.from({ length: 1_500 }, (_, k) => `- "k${k}"`).join('\n');
      paths.push(`dense/n${i}.md`);
      await h.call('vault_write', {
        path: `dense/n${i}.md`,
        content: `---\nstatus: open\n---\n\n\n\n${dense}\n${'prose '.repeat(8_000)}\n`,
      });
    }
    const r = await h.call('vault_batch_read', { paths });
    expect(r.isError).toBeFalsy();
    expect(received(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });

  it('control characters, which JSON escapes sixfold, stay within the budget too', async () => {
    const { CLIENT_SAFE_RESULT_CHARS } = await import('../../src/storage/limits.ts');
    await h.call('vault_write', {
      path: 'ctl.md',
      content: `# C\n${'\u0001'.repeat(20_000)}${'a'.repeat(100_000)}\n`,
    });
    const r = await h.call('vault_batch_read', { paths: ['ctl.md'] });
    expect(received(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });

  it('long paths, present or missing, are paid for out of the same budget', async () => {
    const { CLIENT_SAFE_RESULT_CHARS } = await import('../../src/storage/limits.ts');
    const folder = `${'d'.repeat(120)}/${'e'.repeat(110)}`;
    const present: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      present.push(`${folder}/n${i}.md`);
      await h.call('vault_write', {
        path: `${folder}/n${i}.md`,
        content: `# N\n${'word '.repeat(6_000)}\n`,
      });
    }
    const missing = Array.from({ length: 10 }, (_, i) => `${folder}/missing-${i}.md`);
    const r = await h.call('vault_batch_read', { paths: [...present, ...missing] });
    expect((r.structuredContent as { missing: string[] }).missing).toHaveLength(10);
    expect(received(r)).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
  });

  it('a section name is a heading path, not a document: over 200 characters is refused', async () => {
    await h.call('vault_write', { path: 'a.md', content: '# A\n' });
    const long = 'h'.repeat(201);
    expect((await h.call('vault_batch_read', { paths: ['a.md'], sections: [long] })).isError).toBe(
      true,
    );
    expect((await h.call('vault_read', { path: 'a.md', sections: [long] })).isError).toBe(true);
    expect((await h.call('vault_read', { path: 'a.md', section: long })).isError).toBe(true);
  });

  it('small frontmatter is never touched', async () => {
    await h.call('vault_write', { path: 'a.md', content: '---\nstatus: open\n---\n# A\n' });
    const r = await h.call('vault_batch_read', { paths: ['a.md'] });
    const note = (r.structuredContent as { notes: Record<string, unknown>[] }).notes[0];
    expect(note?.frontmatter).toEqual({ status: 'open' });
    expect(note).not.toHaveProperty('frontmatterOmitted');
  });

  it('omitLargest drops the biggest blocks first, only as many as needed', async () => {
    const { omitLargest } = await import('../../src/tools/read.ts');
    expect([...omitLargest([10, 5_000, 20, 3_000], 4_000)]).toEqual([1]);
    expect([...omitLargest([10, 20], 4_000)]).toEqual([]);
    expect(omitLargest([3_000, 3_000, 3_000], 0).size).toBe(3);
  });
});

describe('document reads for clients that show only the content blocks', () => {
  const meta = (r: { content: { type: string; text?: string }[] }) =>
    r.content[1]?.type === 'text' ? (r.content[1].text ?? '') : '';

  it('vault_read keeps the note text pure in the first block and adds path and hash in a second', async () => {
    await h.call('vault_write', { path: 'n.md', content: NOTE });
    const r = await h.call('vault_read', { path: 'n.md', sections: ['Alpha'] });
    const hash = (r.structuredContent as { hash: string }).hash;
    expect(text(r)).toBe('## Alpha\nalpha content\n');
    expect(r.content).toHaveLength(2);
    expect(meta(r)).toContain('n.md');
    expect(meta(r)).toContain(hash);
    expect(meta(r)).toContain('Alpha');
    expect(meta(r)).not.toContain('Truncated');
  });

  it('says in the second block that the text was cut, once, with the real total', async () => {
    const big = `# Big\n\n${'word '.repeat(30_000)}\n`;
    await h.call('vault_write', { path: 'big.md', content: big });
    const r = await h.call('vault_read', { path: 'big.md' });
    expect(text(r).match(/\[truncated: showing/g)).toHaveLength(1);
    expect(text(r)).toContain(`of ${big.length} characters`);
    expect(meta(r)).toContain('Truncated');
    expect(meta(r)).toContain('vault_outline');
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

describe('vault_read / vault_append — frontmatter is never a source of headings (regression)', () => {
  it('does not resolve a "#"-led YAML line as a heading, and never corrupts the frontmatter block', async () => {
    const content = '---\ntitle: T\n# note\n---\n\n# Real\nbody\n';
    await h.call('vault_write', { path: 'fm.md', content });

    const badRead = await h.call('vault_read', { path: 'fm.md', section: 'note' });
    expect(badRead.isError).toBe(true);
    expect(text(badRead)).toMatch(/^NOT_FOUND: /);
    // "note" is not among the real headings — only "Real" is.
    expect(text(badRead)).toContain('Headings in this note: Real.');

    const r = await h.call('vault_append', { path: 'fm.md', content: 'added', heading: 'Real' });
    expect(r.isError).toBeFalsy();
    const after = text(await h.call('vault_read', { path: 'fm.md' }));
    expect(after).toBe('---\ntitle: T\n# note\n---\n\n# Real\nbody\nadded\n');
    // The frontmatter block (including its own "# note" YAML comment) is byte-for-byte untouched.
    expect(after.startsWith('---\ntitle: T\n# note\n---\n')).toBe(true);
  });
});
