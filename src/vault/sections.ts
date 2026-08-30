import { splitFrontmatter } from '../storage/frontmatter.ts';
import { HEADING, lineAt, maskNonContent } from './note-parse.ts';

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

const MAX_HEADING_LIST = 50;

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

/** Offset (character index) and 1-based file line of where the body starts, i.e. right after the
 *  frontmatter block — or 0 / line 1 when there is none. Mirrors exactly how `note-parse.ts`'s
 *  callers compute it (`content.length - body.length` from `splitFrontmatter`); invalid YAML is
 *  treated the same way `LocalFSAdapter.toNote` treats it — as "no frontmatter", body = whole
 *  content — so this stays pure and never throws on a malformed file. */
function bodyStart(content: string): { offset: number; line: number } {
  let body = content;
  try {
    body = splitFrontmatter(content).body;
  } catch {
    body = content;
  }
  const offset = content.length - body.length;
  return { offset, line: lineAt(content, offset) };
}

/** All ATX headings in `content`'s body (frontmatter excluded, so a '#'-led YAML line can never
 *  become a phantom heading), in file order, with 1-based file-absolute line numbers. Fenced
 *  code, inline code and %% comments are masked first so a '#' inside them is never a heading —
 *  same masking `note-parse.ts` uses for the same reason, and the same `HEADING` grammar. */
function extractHeadings(content: string): HeadingHit[] {
  const { offset, line: firstBodyLine } = bodyStart(content);
  const maskedBody = maskNonContent(content).slice(offset);
  const headings: HeadingHit[] = [];
  splitLines(maskedBody).forEach((raw, i) => {
    const m = HEADING.exec(stripCr(raw));
    if (m) {
      headings.push({
        level: (m[1] ?? '#').length,
        text: (m[2] ?? '').trim(),
        line: firstBodyLine + i,
      });
    }
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
 * Depth-first, backtracking search: tries each heading matching `segments[segIndex]` inside
 * `[boundsStart, boundsEnd]` with level > `parentLevel`, in file order: if the rest of the path
 * resolves under a candidate, that candidate wins; otherwise it tries the next candidate before
 * giving up. This is what lets "A > B" reach a "B" nested under a *later* "A" when an earlier,
 * same-named "A" (which would otherwise be tried first) does not itself contain a "B".
 */
function resolveSegments(
  headings: HeadingHit[],
  segments: string[],
  segIndex: number,
  boundsStart: number,
  boundsEnd: number,
  parentLevel: number,
  totalLines: number,
): SectionRange | null {
  const needle = (segments[segIndex] as string).toLowerCase();
  const isLast = segIndex === segments.length - 1;
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i] as HeadingHit;
    if (h.line < boundsStart || h.line > boundsEnd) continue;
    if (h.level <= parentLevel) continue;
    if (h.text.toLowerCase() !== needle) continue;
    const range = rangeFor(headings, i, totalLines);
    if (isLast) return range;
    const deeper = resolveSegments(
      headings,
      segments,
      segIndex + 1,
      range.startLine,
      range.endLine,
      range.level,
      totalLines,
    );
    if (deeper) return deeper;
    // This candidate's subtree doesn't contain the rest of the path — backtrack and try the
    // next heading matching this segment, rather than failing the whole lookup outright.
  }
  return null;
}

/**
 * Resolves a heading path ("Heading" or "H1 > H2 > ...", case-insensitive, each segment trimmed
 * of leading '#'s and whitespace) to the `SectionRange` it names, or `null` when no such path
 * exists.
 *
 * Each segment after the first must match a heading whose level is strictly greater than the
 * previous segment's and whose line falls inside the previous segment's own resolved range —
 * "inside" meaning anywhere in that subtree, not only a direct child, so "A > B" always reaches
 * a "B" that lives under "A" even when another "B" exists elsewhere under a different parent, or
 * when an earlier, same-named "A" doesn't itself contain a "B" (candidates are tried in file
 * order, backtracking into later ones). When several headings at a given step share the same
 * text, the first one (in file order) that lets the rest of the path resolve wins.
 *
 * A heading whose own text contains a literal '>' (e.g. `# A > B`) is matched by falling back to
 * treating the *whole* `headingPath` as one literal heading name, but only once the nested
 * ("A" then child "B") interpretation has already failed — so when both a real nested path and a
 * same-written literal heading exist, the nested one wins.
 */
export function findSection(content: string, headingPath: string): SectionRange | null {
  const headings = extractHeadings(content);
  const totalLines = splitLines(content).length;

  const segments = headingPath
    .split('>')
    .map(normalizeSegment)
    .filter((s) => s !== '');
  if (segments.length > 0) {
    const nested = resolveSegments(headings, segments, 0, 1, totalLines, 0, totalLines);
    if (nested) return nested;
  }

  const whole = normalizeSegment(headingPath);
  if (whole === '') return null;
  return resolveSegments(headings, [whole], 0, 1, totalLines, 0, totalLines);
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

/** NOT_FOUND message for an unresolved heading path, listing what headings actually exist
 *  (capped so a huge note cannot blow out the error message). Shared by vault_read and
 *  vault_append so the two tools report the exact same wording. */
export function describeUnknownHeading(content: string, headingPath: string): string {
  const paths = listHeadingPaths(content);
  if (paths.length === 0) {
    return `No heading "${headingPath}" found; this note has no headings.`;
  }
  const shown = paths.slice(0, MAX_HEADING_LIST).join(', ');
  const more = paths.length > MAX_HEADING_LIST ? ` (+${paths.length - MAX_HEADING_LIST} more)` : '';
  return `No heading "${headingPath}" found. Headings in this note: ${shown}${more}.`;
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
 *   normalized to exactly one; at end of file (no following heading — i.e. inserting at the very
 *   end of the document), no existing line is removed, but the result is still forced to end
 *   with a newline, consistent with plain `vault_append` on a file that didn't have one.
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
      // !hasFollowingHeading means this section runs to the end of the document, so inserting
      // here is inserting at absolute EOF — force a trailing newline exactly like plain
      // vault_append does, rather than leaving the file unterminated when it wasn't already.
      if (lines[lines.length - 1] !== '') lines.push('');
    }
  }
  return lines.join('\n');
}
