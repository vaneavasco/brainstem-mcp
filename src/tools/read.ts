import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MAX_BATCH,
  MAX_BATCH_RESULT_CHARS,
  MAX_READ_SECTIONS,
  MAX_RESULT_CHARS,
} from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import type { SectionRange } from '../vault/sections.ts';
import { describeUnknownHeading, findSection, sliceSection } from '../vault/sections.ts';
import { READ_ONLY } from './annotations.ts';
import { DetailedPathArg } from './args.ts';
import type { ToolContext } from './register.ts';
import {
  clampText,
  GUIDE_POINTER,
  guarded,
  okDocument,
  okJson,
  TRUNCATED_HINT,
} from './results.ts';

const NoteSummary = z.looseObject({
  path: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  hasFrontmatter: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
  hash: z.string(),
});

/** Blank (whitespace-only) lines at the end of a slice, including the final line break. */
const TRAILING_BLANK_LINES = /(?:\r?\n[ \t]*)*\r?\n?$/;

type PickedSections = {
  text: string;
  ranges: { heading: string; startLine: number; endLine: number }[];
  missing: string[];
};

/**
 * The asked sections of one text, in document order. Content lines stay byte-exact (a model quotes
 * them into vault_edit): only the blank lines after a section are dropped, and the separator uses
 * the text's own line ending. Headings that do not resolve are returned in "missing".
 */
function pickSections(content: string, headings: string[]): PickedSections {
  const found = new Map<number, { heading: string; range: SectionRange }>();
  const missing: string[] = [];
  for (const heading of headings) {
    const range = findSection(content, heading);
    if (!range) {
      missing.push(heading);
      continue;
    }
    // Two heading paths may resolve to one section ("B" and "A > B"): return it once.
    if (!found.has(range.startLine)) found.set(range.startLine, { heading: range.heading, range });
  }
  // Document order; a section inside another requested one is already in its parent's text.
  const ordered = [...found.values()]
    .sort((a, b) => a.range.startLine - b.range.startLine)
    .filter(
      (s, _i, all) =>
        !all.some(
          (o) =>
            o !== s && o.range.startLine <= s.range.startLine && o.range.endLine >= s.range.endLine,
        ),
    );
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const text = ordered.length
    ? `${ordered
        .map(({ range }) => sliceSection(content, range).replace(TRAILING_BLANK_LINES, ''))
        .join(eol + eol)}${eol}`
    : '';
  return {
    text,
    ranges: ordered.map(({ heading, range }) => ({
      heading,
      startLine: range.startLine,
      endLine: range.endLine,
    })),
    missing,
  };
}

/**
 * How many characters each text may take from one shared budget. Shorter texts are served first
 * and whole; what they leave is split among the longer ones, so two notes of 100 and 45,000
 * characters both arrive whole under a 60,000 budget instead of the second being cut at 30,000.
 * `cap` is the caller's own per-text limit.
 */
export function shareBudget(lengths: number[], budget: number, cap?: number): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  const order = lengths.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  let remaining = budget;
  order.forEach((index, position) => {
    const fair = Math.floor(remaining / (order.length - position));
    const take = Math.min(lengths[index] ?? 0, fair, cap ?? Number.POSITIVE_INFINITY);
    out[index] = Math.max(take, 0);
    remaining -= out[index] ?? 0;
  });
  return out;
}

export function registerReadTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_read',
    {
      title: 'Read note',
      description:
        'Read one file: the full text (frontmatter + body), cut at 120k characters ("maxChars" cuts earlier; a cut result carries a "hint": read it by section). "section" (a heading path like "Heading" or "H1 > H2", case-insensitive) returns only that section and its sectionRange; "sections" returns several in document order with sectionRanges — text inside a section is verbatim, the blank line between sections is added. A final "[brainstem] …" content block is metadata (path, hash), never part of the note. ' +
        GUIDE_POINTER,
      inputSchema: z.strictObject({
        path: DetailedPathArg,
        section: z
          .string()
          .optional()
          .describe(
            'Return only this section (by heading path, e.g. "Heading" or "H1 > H2") instead of the whole file.',
          ),
        sections: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_READ_SECTIONS)
          .optional()
          .describe(
            `Return only these sections (up to ${MAX_READ_SECTIONS} heading paths), in document order, joined by a blank line. Not together with "section".`,
          ),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(MAX_RESULT_CHARS)
          .optional()
          .describe(
            'Cut the returned text after this many characters, plus a short truncation marker (a look at a note of unknown size).',
          ),
      }),
      outputSchema: NoteSummary.extend({
        // The text also travels in the content block, but clients that render structuredContent
        // when it is present would otherwise never show the note body.
        text: z.string(),
        truncated: z.boolean(),
        totalChars: z.number(),
        sectionRange: z.looseObject({ startLine: z.number(), endLine: z.number() }).optional(),
        sectionRanges: z
          .array(z.looseObject({ heading: z.string(), startLine: z.number(), endLine: z.number() }))
          .optional(),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ path, section, sections, maxChars }) =>
      guarded(tc.log, async () => {
        if (section !== undefined && sections !== undefined) {
          throw new VaultError('INVALID_INPUT', 'pass either "section" or "sections", not both');
        }
        const note = await adapter.read(path);
        let textOut = note.content;
        let sectionRange: { startLine: number; endLine: number } | undefined;
        let sectionRanges: { heading: string; startLine: number; endLine: number }[] | undefined;
        if (sections !== undefined) {
          const picked = pickSections(note.content, sections);
          const unknown = picked.missing[0];
          if (unknown !== undefined) {
            throw new VaultError('NOT_FOUND', describeUnknownHeading(note.content, unknown));
          }
          sectionRanges = picked.ranges;
          textOut = picked.text;
        } else if (section !== undefined) {
          const range = findSection(note.content, section);
          if (!range) {
            throw new VaultError('NOT_FOUND', describeUnknownHeading(note.content, section));
          }
          textOut = sliceSection(note.content, range);
          sectionRange = { startLine: range.startLine, endLine: range.endLine };
        }
        const clamped = clampText(textOut, maxChars);
        return okDocument(
          {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            hash: note.hash,
            text: clamped.text,
            truncated: clamped.truncated,
            totalChars: clamped.totalChars,
            ...(sectionRange ? { sectionRange } : {}),
            ...(sectionRanges ? { sectionRanges } : {}),
            ...(clamped.truncated ? { hint: TRUNCATED_HINT } : {}),
          },
          clamped.text,
          {
            path: note.path,
            hash: note.hash,
            sections: sectionRanges?.map((r) => r.heading) ?? (section ? [section] : undefined),
            truncated: clamped.truncated,
          },
        );
      }),
  );

  server.registerTool(
    'vault_batch_read',
    {
      title: 'Read several notes',
      description: `Read up to ${MAX_BATCH} files in one call; the bodies share ${MAX_BATCH_RESULT_CHARS.toLocaleString('en-US')} characters (a short note leaves its share to the long ones). Whole long notes rarely fit: pass "sections" (heading paths, as in vault_read) to get only those sections of every note — a note lacking one still answers and lists it in "missingSections" — and/or "maxChars" to cut each note. Missing files are listed in "missing", unreadable ones in "failed"; the call never fails because of one bad path.`,
      inputSchema: z.strictObject({
        paths: z.array(DetailedPathArg).min(1).max(MAX_BATCH),
        sections: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_READ_SECTIONS)
          .optional()
          .describe(
            `Return only these sections of every note (up to ${MAX_READ_SECTIONS} heading paths), in document order.`,
          ),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(MAX_RESULT_CHARS)
          .optional()
          .describe('Cut the body of each note after this many characters.'),
      }),
      outputSchema: z.looseObject({
        notes: z.array(
          NoteSummary.extend({
            body: z.string(),
            truncated: z.boolean(),
            missingSections: z.array(z.string()).optional(),
          }),
        ),
        missing: z.array(z.string()),
        failed: z.array(z.looseObject({ path: z.string(), error: z.string() })),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ paths, sections, maxChars }) =>
      guarded(tc.log, async () => {
        const result = await adapter.batchRead(paths);
        // Pick the sections first, then share the budget over what is actually wanted: a short
        // note leaves its unused share to the long ones instead of wasting it.
        const wanted = result.notes.map((note) =>
          sections ? pickSections(note.content, sections) : undefined,
        );
        const lengths = result.notes.map((note, i) => (wanted[i]?.text ?? note.body).length);
        const allowance = shareBudget(lengths, MAX_BATCH_RESULT_CHARS, maxChars);
        const notes = result.notes.map((note, i) => {
          const picked = wanted[i];
          const clamped = clampText(picked ? picked.text : note.body, allowance[i]);
          return {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            hash: note.hash,
            body: clamped.text,
            truncated: clamped.truncated,
            ...(picked?.missing.length ? { missingSections: picked.missing } : {}),
          };
        });
        return okJson({
          notes,
          missing: result.missing,
          failed: result.failed,
          ...(notes.some((n) => n.truncated) ? { hint: TRUNCATED_HINT } : {}),
        });
      }),
  );
}
