import { maskNonContent } from './note-parse.ts';

/**
 * A heading's section: `startLine` is the heading's own file line, `endLine` is the last line
 * before the next heading of level <= this one (or the last file line when none follows). Both
 * are 1-based and inclusive, counted the same way `note-parse.ts` counts file lines (frontmatter
 * included, one line per '\n'-separated chunk of `content`, so a trailing newline yields one
 * extra, empty, trailing "line" — harmless for slicing/inserting, see below).
 */
export interface SectionRange {
  startLine: number;
  endLine: number;
  level: number;
  heading: string;
}

interface HeadingHit {
  level: number;
  text: string;
  line: number;
}

// Mirrors note-parse.ts's HEADING regex exactly (kept local: sections.ts must not depend on
// note-parse.ts internals beyond the exported maskNonContent).
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/;

function splitLines(content: string): string[] {
  return content.split('\n');
}

/** Strips a trailing '\r' for matching only — the caller keeps using the original line string. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || stripCr(line) === '';
}

/** All ATX headings in `content`, in file order, with 1-based file line numbers. Fenced code,
 *  inline code and %% comments are masked first so a '#' inside them is never a heading — same
 *  masking note-parse.ts uses for the same reason. */
function extractHeadings(content: string): HeadingHit[] {
  const masked = maskNonContent(content);
  const headings: HeadingHit[] = [];
  splitLines(masked).forEach((raw, i) => {
    const m = HEADING.exec(stripCr(raw));
    if (m) headings.push({ level: (m[1] ?? '#').length, text: (m[2] ?? '').trim(), line: i + 1 });
  });
  return headings;
}

/** The section range for `headings[index]`, scanning forward for the first later heading whose
 *  level is <= this one's (independent of any search bounds — see findSection for why that's
 *  still correct once a match must also lie inside its parent's range). */
function rangeFor(headings: HeadingHit[], index: number, totalLines: number): SectionRange {
  const h = headings[index] as HeadingHit;
  let endLine = totalLines;
  for (let j = index + 1; j < headings.length; j += 1) {
    const next = headings[j] as HeadingHit;
    if (next.level <= h.level) {
      endLine = next.line - 1;
      break;
    }
  }
  return { startLine: h.line, endLine, level: h.level, heading: h.text };
}

function normalizeSegment(segment: string): string {
  return segment
    .trim()
    .replace(/^#+\s*/, '')
    .trim();
}

/**
 * Resolves a heading path ("Heading" or "H1 > H2 > ...", case-insensitive, each segment trimmed
 * of leading '#'s and whitespace) to the `SectionRange` it names, or `null` when no such path
 * exists.
 *
 * Each segment after the first must match a heading whose level is strictly greater than the
 * previous segment's and whose line falls inside the previous segment's own resolved range —
 * "inside" meaning anywhere in that subtree, not only a direct child, so "A > B" always reaches
 * the "B" that lives under "A" even when another "B" exists elsewhere under a different parent.
 * When several headings at a given step share the same text, the first one in file order wins.
 */
export function findSection(content: string, headingPath: string): SectionRange | null {
  const segments = headingPath
    .split('>')
    .map(normalizeSegment)
    .filter((s) => s !== '');
  if (segments.length === 0) return null;

  const headings = extractHeadings(content);
  const totalLines = splitLines(content).length;

  let boundsStart = 1;
  let boundsEnd = totalLines;
  let parentLevel = 0;
  let range: SectionRange | null = null;

  for (const segment of segments) {
    const needle = segment.toLowerCase();
    let foundIndex = -1;
    for (let i = 0; i < headings.length; i += 1) {
      const h = headings[i] as HeadingHit;
      if (h.line < boundsStart || h.line > boundsEnd) continue;
      if (h.level <= parentLevel) continue;
      if (h.text.toLowerCase() !== needle) continue;
      foundIndex = i;
      break;
    }
    if (foundIndex === -1) return null;
    range = rangeFor(headings, foundIndex, totalLines);
    boundsStart = range.startLine;
    boundsEnd = range.endLine;
    parentLevel = range.level;
  }
  return range;
}

/** The exact text of a section, including its own heading line, as file lines `range.startLine`
 *  through `range.endLine` inclusive. Original line endings (LF or CRLF) are preserved exactly. */
export function sliceSection(content: string, range: SectionRange): string {
  const lines = splitLines(content);
  return lines.slice(range.startLine - 1, range.endLine).join('\n');
}

/** All heading paths in `content`, in file order, in the same "A", "A > B" syntax `findSection`
 *  accepts — for building NOT_FOUND messages that list what headings actually exist. */
export function listHeadingPaths(content: string): string[] {
  const headings = extractHeadings(content);
  const stack: HeadingHit[] = [];
  const paths: string[] = [];
  for (const h of headings) {
    while (stack.length > 0 && (stack[stack.length - 1] as HeadingHit).level >= h.level) {
      stack.pop();
    }
    stack.push(h);
    paths.push(stack.map((s) => s.text).join(' > '));
  }
  return paths;
}

/** `text` split into discrete lines with no trailing empty element (i.e. `text` is treated as
 *  always ending with a newline), each carrying a trailing '\r' when `crlf` is true so inserted
 *  lines match the file's own line-ending style. */
function insertionLines(text: string, crlf: boolean): string[] {
  const unified = text.replace(/\r\n/g, '\n');
  const parts = unified.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return crlf ? parts.map((l) => `${l}\r`) : parts;
}

/**
 * Inserts `text` into the section named by `range`, returning the whole updated file content.
 * `text` always ends up on its own line(s) followed by a newline, regardless of whether the
 * caller's `text` already ended with one.
 *
 * - `'start'`: right after the heading line — after an existing blank line too, if the section
 *   already starts with one (so a normal "heading, blank line, body" note keeps that shape).
 * - `'end'`: after the section's last non-blank line. When another heading immediately follows
 *   the section, any existing blank line(s) between the inserted text and that heading are
 *   normalized to exactly one; at end of file (no following heading), nothing is removed.
 */
export function insertIntoSection(
  content: string,
  range: SectionRange,
  text: string,
  position: 'start' | 'end',
): string {
  const crlf = content.includes('\r\n');
  const lines = splitLines(content);
  const totalLines = lines.length;
  const newLines = insertionLines(text, crlf);

  if (position === 'start') {
    let idx = range.startLine; // 0-based index of the line right after the heading
    if (idx <= range.endLine - 1 && isBlank(lines[idx])) idx += 1;
    lines.splice(idx, 0, ...newLines);
  } else {
    let lastNonBlank = range.startLine - 1; // the heading line itself, always non-blank
    for (let i = range.startLine - 1; i <= range.endLine - 1; i += 1) {
      if (!isBlank(lines[i])) lastNonBlank = i;
    }
    const insertAt = lastNonBlank + 1;
    const hasFollowingHeading = range.endLine < totalLines;
    if (hasFollowingHeading) {
      const removeCount = range.endLine - 1 - lastNonBlank;
      lines.splice(insertAt, removeCount, ...newLines, crlf ? '\r' : '');
    } else {
      lines.splice(insertAt, 0, ...newLines);
    }
  }
  return lines.join('\n');
}
