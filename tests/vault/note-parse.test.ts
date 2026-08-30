import { describe, expect, it } from 'vitest';
import { frontmatterTags, maskNonContent, parseNote } from '../../src/vault/note-parse.ts';

const fm = (content: string) => {
  // tiny helper: split a '---' block the way the adapter does
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, unknown> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const [k, ...rest] = line.split(':');
    if (k) frontmatter[k.trim()] = rest.join(':').trim();
  }
  return { frontmatter, body: content.slice(m[0].length) };
};
const parse = (content: string, frontmatter?: Record<string, unknown>) => {
  const s = fm(content);
  return parseNote(content, frontmatter ?? s.frontmatter, s.body);
};

describe('maskNonContent', () => {
  it('blanks fenced code, inline code and %% comments but keeps length and newlines', () => {
    const src = 'a [[x]]\n```\n[[in-code]] #tag\n```\nb `[[inline]]` %% [[hidden]] %%\nc';
    const out = maskNonContent(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('[[x]]');
    expect(out).not.toContain('in-code');
    expect(out).not.toContain('inline');
    expect(out).not.toContain('hidden');
  });
  it('handles ~~~ fences and an unterminated fence to end of text', () => {
    const out = maskNonContent('x\n~~~\n[[a]]\n~~~\n[[b]]\n```\n[[c]]');
    expect(out).toContain('[[b]]');
    expect(out).not.toContain('[[a]]');
    expect(out).not.toContain('[[c]]');
  });
});

describe('parseNote links', () => {
  it('parses every Obsidian wikilink form', () => {
    const { links } = parse(
      '[[Note]] [[Note|Alias]] [[Note#Head]] [[Note#H1#H2|A]] [[Note#^blk]] ![[img.png|100]] [[#Local]] [[folder/Sub Note.md]]',
    );
    expect(links.map((l) => [l.target, l.heading, l.block, l.alias, l.embed])).toEqual([
      ['Note', undefined, undefined, undefined, false],
      ['Note', undefined, undefined, 'Alias', false],
      ['Note', 'Head', undefined, undefined, false],
      ['Note', 'H1#H2', undefined, 'A', false],
      ['Note', undefined, 'blk', undefined, false],
      ['img.png', undefined, undefined, '100', true],
      ['', 'Local', undefined, undefined, false],
      ['folder/Sub Note.md', undefined, undefined, undefined, false],
    ]);
    expect(links.every((l) => l.kind === 'wiki')).toBe(true);
    expect(links[0]?.raw).toBe('[[Note]]');
    expect(links[5]?.raw).toBe('![[img.png|100]]');
  });

  it('parses markdown links to vault paths and skips external schemes', () => {
    const { links } = parse(
      '[a](Note.md) [b](<Sub Folder/N%20B.md#Sec>) ![c](img.png) [d](https://x.y/z.md) [e](mailto:a@b.c) [f](obsidian://open?vault=v)',
    );
    expect(links.map((l) => [l.kind, l.target, l.heading, l.alias, l.embed])).toEqual([
      ['md', 'Note.md', undefined, 'a', false],
      ['md', 'Sub Folder/N B.md', 'Sec', 'b', false],
      ['md', 'img.png', undefined, 'c', true],
    ]);
  });

  it('reports file line numbers including the frontmatter block, and offsets', () => {
    const content = '---\ntitle: T\n---\n\nintro\n[[A]]\nx [[B]]';
    const { links } = parse(content);
    expect(links.map((l) => l.line)).toEqual([6, 7]);
    expect(content.slice(links[1]?.start, links[1]?.end)).toBe('[[B]]');
  });

  it('ignores links in code fences, inline code and comments', () => {
    const { links } = parse('[[keep]]\n```\n[[no1]]\n```\n`[[no2]]` %%[[no3]]%%');
    expect(links.map((l) => l.target)).toEqual(['keep']);
  });
});

describe('parseNote tags', () => {
  it('collects frontmatter tags (list or string) and inline tags, no duplicates, no digit-only tags', () => {
    const { tags } = parse(
      '---\ntags: [alpha, Beta/gamma]\n---\nText #alpha #delta #2024 #ok-1 #with_under #nested/deep and #beta/gamma. (#paren) #end',
      { tags: ['alpha', 'Beta/gamma'] },
    );
    expect(tags).toEqual([
      'alpha',
      'Beta/gamma',
      'delta',
      'ok-1',
      'with_under',
      'nested/deep',
      'paren',
      'end',
    ]);
  });
  it('does not treat #heading markers, URL fragments or code as tags', () => {
    const { tags } = parse('# Heading\n## Two\nsee http://x.y/#frag and `#code` and a#b');
    expect(tags).toEqual([]);
  });
  it('frontmatterTags accepts "a, b" strings and strips leading #', () => {
    expect(frontmatterTags({ tags: '#a, b  c' })).toEqual(['a', 'b', 'c']);
    expect(frontmatterTags({ tag: 'legacy' })).toEqual([]);
    expect(frontmatterTags({ tags: [1, 'x', null] })).toEqual(['x']);
  });
});

describe('parseNote headings, block ids, words', () => {
  it('extracts headings with level and file line, ignoring fenced code', () => {
    const { headings } = parse(
      '---\na: 1\n---\n# One\ntext\n## Two ##\n```\n# not\n```\n### Three',
    );
    expect(headings).toEqual([
      { level: 1, text: 'One', line: 4 },
      { level: 2, text: 'Two', line: 6 },
      { level: 3, text: 'Three', line: 10 },
    ]);
  });
  it('extracts block ids at line end or on their own line', () => {
    const { blockIds } = parse('para one ^abc-1\n\n- item ^i2\n\n> quote\n^q3\n\nnot ^ inside');
    expect(blockIds).toEqual([
      { id: 'abc-1', line: 1 },
      { id: 'i2', line: 3 },
      { id: 'q3', line: 6 },
    ]);
  });
  it('counts words in the body only', () => {
    const { wordCount } = parse('---\ntitle: one two three\n---\nfour five, six!\n\n#tag seven');
    expect(wordCount).toBe(5); // four five six seven + "#tag"? no: tags are words too → 5 tokens with letters/digits: four five six #tag seven
  });
});
