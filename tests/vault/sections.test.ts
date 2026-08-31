import { describe, expect, it } from 'vitest';
import {
  findSection,
  insertIntoSection,
  listHeadingPaths,
  type SectionRange,
  sliceSection,
} from '../../src/vault/sections.ts';

// Line numbers (1-based), for reference:
//  1 # Title
//  2 (blank)
//  3 ## Alpha
//  4 alpha content
//  5 (blank)
//  6 ### Beta        <- nested under Alpha
//  7 nested beta content
//  8 (blank)
//  9 ## Beta         <- sibling of Alpha, different parent (Title)
// 10 top beta content
// 11 (blank)
// 12 ## Gamma
// 13 gamma content
// (trailing newline)
const DOC = `${[
  '# Title',
  '',
  '## Alpha',
  'alpha content',
  '',
  '### Beta',
  'nested beta content',
  '',
  '## Beta',
  'top beta content',
  '',
  '## Gamma',
  'gamma content',
].join('\n')}\n`;

describe('listHeadingPaths', () => {
  it('builds nested "A > B" paths from heading levels, including skipped-back siblings', () => {
    expect(listHeadingPaths(DOC)).toEqual([
      'Title',
      'Title > Alpha',
      'Title > Alpha > Beta',
      'Title > Beta',
      'Title > Gamma',
    ]);
  });

  it('ignores headings inside fenced code', () => {
    const content = '# Real\n```\n# FakeHeading\n```\nAfter fence\n';
    expect(listHeadingPaths(content)).toEqual(['Real']);
  });

  it('returns an empty list for a note with no headings', () => {
    expect(listHeadingPaths('just text\nmore text\n')).toEqual([]);
  });
});

describe('findSection', () => {
  it('finds a top-level section by its bare name', () => {
    const range = findSection(DOC, 'Alpha');
    expect(range).toEqual({ startLine: 3, endLine: 8, level: 2, heading: 'Alpha' });
  });

  it('is case-insensitive and trims "#" and whitespace from each segment', () => {
    expect(findSection(DOC, '  ## alpha  ')).toEqual({
      startLine: 3,
      endLine: 8,
      level: 2,
      heading: 'Alpha',
    });
  });

  it('resolves "A > B" to the B nested inside A, not the same-named B under a different parent', () => {
    const range = findSection(DOC, 'Alpha > Beta');
    expect(range).toEqual({ startLine: 6, endLine: 8, level: 3, heading: 'Beta' });
  });

  it('resolves a bare duplicate heading name to its first (topmost) occurrence in the file', () => {
    // "Beta" exists both nested under Alpha (line 6) and as a sibling of Alpha (line 9); the
    // nested one comes first in the file, so the bare, unqualified path resolves to it.
    const range = findSection(DOC, 'Beta');
    expect(range).toEqual({ startLine: 6, endLine: 8, level: 3, heading: 'Beta' });
  });

  it('finds the last section in the file, ending at the last file line', () => {
    // DOC ends with a trailing newline, so splitting on '\n' yields one extra, empty, trailing
    // "line" (14) — the same file-line convention note-parse.ts uses; it round-trips correctly
    // through sliceSection (see below) since joining puts the final '\n' back exactly.
    const range = findSection(DOC, 'Gamma');
    expect(range).toEqual({ startLine: 12, endLine: 14, level: 2, heading: 'Gamma' });
  });

  it('returns null for an unknown heading or an unknown nested segment', () => {
    expect(findSection(DOC, 'Nope')).toBeNull();
    expect(findSection(DOC, 'Gamma > Nope')).toBeNull();
    // "Beta" (top-level, sibling of Alpha) has no child named "Alpha" — Alpha is its sibling,
    // not nested inside it.
    expect(findSection(DOC, 'Beta > Alpha')).toBeNull();
  });

  it('ignores a "heading" inside a fenced code block', () => {
    const content = '# Real\n```\n# FakeHeading\ncontent\n```\nAfter fence\n';
    expect(findSection(content, 'FakeHeading')).toBeNull();
    const real = findSection(content, 'Real');
    expect(real).toMatchObject({ startLine: 1, level: 1, heading: 'Real' });
  });

  it('returns null for an empty or whitespace-only heading path', () => {
    expect(findSection(DOC, '')).toBeNull();
    expect(findSection(DOC, '   ')).toBeNull();
  });

  it('backtracks across a same-named candidate that does not itself contain the child path', () => {
    // Two "# A" roots; only the SECOND contains a "## B". A naive "first match wins, no
    // backtracking" search would commit to the first "A" (whose range ends right before the
    // second "A" starts, since it's a same-or-higher-level sibling) and fail to find "B" inside
    // it, reporting the whole path as not found even though listHeadingPaths lists "A > B".
    const content = `${['# A', 'alpha-one', '', '# A', 'alpha-two', '', '## B', 'b-content'].join(
      '\n',
    )}\n`;
    // The identical "A" path is listed once (dedupe), but BOTH roots stay searchable below.
    expect(listHeadingPaths(content)).toEqual(['A', 'A > B']);
    const range = findSection(content, 'A > B');
    expect(range).toEqual({ startLine: 7, endLine: 9, level: 2, heading: 'B' });
  });
});

describe('findSection — headings scoped to the body (frontmatter is never a source of headings)', () => {
  it('does not treat a "#"-led YAML line inside frontmatter as a heading', () => {
    const content = '---\ntitle: T\n# note\n---\n\n# Real\n';
    expect(listHeadingPaths(content)).toEqual(['Real']);
    expect(findSection(content, 'note')).toBeNull();
    // Line 6 is the real heading's file-absolute line: 4 frontmatter lines (---, title, # note,
    // ---) plus the blank line right after the closing "---".
    expect(findSection(content, 'Real')).toEqual({
      startLine: 6,
      endLine: 7,
      level: 1,
      heading: 'Real',
    });
  });

  it('falls back to treating the whole file as the body when frontmatter YAML is invalid', () => {
    // splitFrontmatter throws INVALID_INPUT on malformed YAML; extractHeadings must swallow that
    // and scan the whole content as body, exactly like LocalFSAdapter.toNote does for reads.
    const content = '---\n[not: valid: yaml\n---\n\n# Real\n';
    expect(() => listHeadingPaths(content)).not.toThrow();
    expect(listHeadingPaths(content)).toEqual(['Real']);
  });
});

describe('findSection — a heading whose own text contains a literal ">"', () => {
  it('falls back to the whole path as one literal heading name when the nested split does not resolve', () => {
    const content = '# A > B\nbody text\n';
    expect(listHeadingPaths(content)).toEqual(['A > B']);
    expect(findSection(content, 'A > B')).toEqual({
      startLine: 1,
      endLine: 3,
      level: 1,
      heading: 'A > B',
    });
  });

  it('prefers a real nested path over a same-written literal heading elsewhere in the file', () => {
    const content = `${['# A', '## B', 'nested content', '# A > B', 'literal content'].join(
      '\n',
    )}\n`;
    // The nested "A" > "B" resolves first and wins; the literal "# A > B" heading (unreachable by
    // this same path string while the nested interpretation succeeds) is never tried.
    const range = findSection(content, 'A > B');
    expect(range).toEqual({ startLine: 2, endLine: 3, level: 2, heading: 'B' });
  });
});

describe('sliceSection', () => {
  it('slices a middle section including its heading line, excluding what follows', () => {
    const range = findSection(DOC, 'Alpha > Beta') as SectionRange;
    expect(sliceSection(DOC, range)).toBe('### Beta\nnested beta content\n');
  });

  it('slices the section at end of file, preserving the trailing newline', () => {
    const range = findSection(DOC, 'Gamma') as SectionRange;
    expect(sliceSection(DOC, range)).toBe('## Gamma\ngamma content\n');
  });

  it('slices a section with no trailing newline in the source file', () => {
    const content = '# Only\nbody line';
    const range = findSection(content, 'Only') as SectionRange;
    expect(sliceSection(content, range)).toBe('# Only\nbody line');
  });
});

describe('insertIntoSection — position "end"', () => {
  it('inserts after the last non-blank line, normalizing to exactly one blank line before the next heading', () => {
    // The top-level "Beta" (line 9), found directly by its own known range rather than through
    // findSection, since a bare or "Title > Beta" path is ambiguous by design (see the
    // findSection tests above) and would resolve to the nested "Beta" instead.
    const topBeta: SectionRange = { startLine: 9, endLine: 11, level: 2, heading: 'Beta' };
    const updated = insertIntoSection(DOC, topBeta, 'inserted-end', 'end');
    expect(updated).toContain(
      '## Beta\ntop beta content\ninserted-end\n\n## Gamma\ngamma content\n',
    );
    // Exactly one blank line, not zero and not doubled.
    expect(updated).not.toContain('inserted-end\n\n\n## Gamma');
    expect(updated).not.toContain('inserted-end\n## Gamma');
  });

  it('collapses multiple pre-existing blank lines before the next heading down to one', () => {
    const content = '## A\nbody\n\n\n\n## B\nmore\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'end');
    expect(updated).toBe('## A\nbody\nadded\n\n## B\nmore\n');
  });

  it('creates the separating blank line when none existed before the next heading', () => {
    const content = '## A\nbody\n## B\nmore\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'end');
    expect(updated).toBe('## A\nbody\nadded\n\n## B\nmore\n');
  });

  it('inserts right after the heading when the section has no body content of its own', () => {
    const content = '## A\n## B\nmore\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'end');
    expect(updated).toBe('## A\nadded\n\n## B\nmore\n');
  });

  it('appends at end of file without forcing a trailing blank line when no heading follows', () => {
    const content = '## Only\nbody\n';
    const range = findSection(content, 'Only') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'end');
    expect(updated).toBe('## Only\nbody\nadded\n');
  });

  it('forces a trailing newline when inserting at absolute EOF on a file that lacked one, matching plain vault_append', () => {
    const content = '## Only\nbody'; // no trailing newline
    const range = findSection(content, 'Only') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'end');
    expect(updated).toBe('## Only\nbody\nadded\n');
    expect(updated.endsWith('\n')).toBe(true);
  });

  it('adds a trailing newline to inserted text that lacks one, and keeps one that already has it', () => {
    const content = '## Only\nbody\n';
    const range = findSection(content, 'Only') as SectionRange;
    expect(insertIntoSection(content, range, 'no-newline', 'end')).toBe(
      '## Only\nbody\nno-newline\n',
    );
    expect(insertIntoSection(content, range, 'with-newline\n', 'end')).toBe(
      '## Only\nbody\nwith-newline\n',
    );
  });

  it('appending to a section that contains a nested subsection lands after the whole subtree', () => {
    const range = findSection(DOC, 'Alpha') as SectionRange;
    const updated = insertIntoSection(DOC, range, 'added-to-alpha', 'end');
    expect(updated).toBe(
      `${[
        '# Title',
        '',
        '## Alpha',
        'alpha content',
        '',
        '### Beta',
        'nested beta content',
        'added-to-alpha',
        '',
        '## Beta',
        'top beta content',
        '',
        '## Gamma',
        'gamma content',
      ].join('\n')}\n`,
    );
  });
});

describe('insertIntoSection — position "start"', () => {
  it('inserts right after the heading line when the section has no leading blank line', () => {
    const content = '## A\nbody\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'start');
    expect(updated).toBe('## A\nadded\nbody\n');
  });

  it('inserts after an existing leading blank line, not before it', () => {
    const content = '## A\n\nbody\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'start');
    expect(updated).toBe('## A\n\nadded\nbody\n');
  });

  it('inserts right after the heading when the section has no body content at all', () => {
    const content = '## A\n## B\nmore\n';
    const range = findSection(content, 'A') as SectionRange;
    const updated = insertIntoSection(content, range, 'added', 'start');
    expect(updated).toBe('## A\nadded\n## B\nmore\n');
  });
});

describe('CRLF handling', () => {
  // Two leaf H2 sections under one H1, so "Sub" (followed by "Sub2") and "Sub2" (at EOF) each
  // exercise a distinct end-position rule, and "Head" (the sole H1) spans the whole file.
  const crlfLines = ['# Head', 'text line', '', '## Sub', 'sub text', '', '## Sub2', 'more text'];
  const crlfDoc = `${crlfLines.join('\r\n')}\r\n`;

  it('finds sections and reports correct line numbers over CRLF content', () => {
    const range = findSection(crlfDoc, 'Sub');
    expect(range).toEqual({ startLine: 4, endLine: 6, level: 2, heading: 'Sub' });
  });

  it('slices a CRLF section keeping \\r\\n line endings intact', () => {
    // The range includes the trailing blank separator line (6) before "## Sub2"; that blank
    // line's own content is just its '\r' (a CRLF blank line has no other bytes), and the
    // slice's join stops there rather than adding a further '\n' that would belong to line 7.
    const range = findSection(crlfDoc, 'Sub') as SectionRange;
    expect(sliceSection(crlfDoc, range)).toBe('## Sub\r\nsub text\r\n\r');
  });

  it('inserts CRLF-style lines (with trailing \\r) into a CRLF file, end position, before the next heading', () => {
    const range = findSection(crlfDoc, 'Sub') as SectionRange;
    const updated = insertIntoSection(crlfDoc, range, 'added', 'end');
    expect(updated).toBe(
      '# Head\r\ntext line\r\n\r\n## Sub\r\nsub text\r\nadded\r\n\r\n## Sub2\r\nmore text\r\n',
    );
  });

  it('inserts CRLF-style lines into a CRLF file, start position', () => {
    const range = findSection(crlfDoc, 'Sub') as SectionRange;
    const updated = insertIntoSection(crlfDoc, range, 'added', 'start');
    expect(updated).toBe(
      '# Head\r\ntext line\r\n\r\n## Sub\r\nadded\r\nsub text\r\n\r\n## Sub2\r\nmore text\r\n',
    );
  });

  it('round-trips a whole CRLF file, byte for byte, via slice of its sole top-level heading', () => {
    const range = findSection(crlfDoc, 'Head') as SectionRange;
    expect(sliceSection(crlfDoc, range)).toBe(crlfDoc);
  });
});

describe('listHeadingPaths — identical sibling paths', () => {
  it('lists an identical sibling heading path once; the first occurrence is the reachable one', () => {
    const content = '# A\n\n## Tasks\none\n\n## Tasks\ntwo\n';
    expect(listHeadingPaths(content)).toEqual(['A', 'A > Tasks']);
    expect(findSection(content, 'A > Tasks')?.startLine).toBe(3);
  });
});
