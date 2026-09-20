import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_BATCH, MAX_READ_SECTIONS, MAX_RESULT_CHARS } from '../storage/limits.ts';
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

const NoteSummary = z.object({
  path: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  hasFrontmatter: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
  hash: z.string(),
});

export function registerReadTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_read',
    {
      title: 'Read note',
      description:
        'Read one file from the vault: the full text (frontmatter + body). Large files are truncated at 120k characters ("maxChars" cuts earlier). With "section" (a heading path like "Heading" or "H1 > H2", case-insensitive), returns only that section\'s text and its sectionRange instead of the whole file; with "sections" (several heading paths), those sections in document order and their sectionRanges — one call instead of one per heading. A truncated result carries a "hint": read it by section. ' +
        GUIDE_POINTER,
      inputSchema: z.object({
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
            'Cut the returned text after this many characters (a look at a note of unknown size).',
          ),
      }),
      outputSchema: NoteSummary.extend({
        // The text also travels in the content block, but clients that render structuredContent
        // when it is present would otherwise never show the note body.
        text: z.string(),
        truncated: z.boolean(),
        totalChars: z.number(),
        sectionRange: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
        sectionRanges: z
          .array(z.object({ heading: z.string(), startLine: z.number(), endLine: z.number() }))
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
          const found = new Map<number, { heading: string; range: SectionRange }>();
          for (const heading of sections) {
            const range = findSection(note.content, heading);
            if (!range) {
              throw new VaultError('NOT_FOUND', describeUnknownHeading(note.content, heading));
            }
            // Two heading paths may resolve to one section ("B" and "A > B"): return it once.
            if (!found.has(range.startLine)) found.set(range.startLine, { heading, range });
          }
          // Document order; a section inside another requested one is already in its parent's text.
          const ordered = [...found.values()]
            .sort((a, b) => a.range.startLine - b.range.startLine)
            .filter(
              (s, _i, all) =>
                !all.some(
                  (o) =>
                    o !== s &&
                    o.range.startLine <= s.range.startLine &&
                    o.range.endLine >= s.range.endLine,
                ),
            );
          sectionRanges = ordered.map(({ heading, range }) => ({
            heading,
            startLine: range.startLine,
            endLine: range.endLine,
          }));
          textOut = `${ordered
            .map(({ range }) => sliceSection(note.content, range).replace(/\s+$/, ''))
            .join('\n\n')}\n`;
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
      description: `Read up to ${MAX_BATCH} files in one call. Missing files are listed in "missing", unreadable ones in "failed"; the call never fails because of one bad path.`,
      inputSchema: z.object({ paths: z.array(DetailedPathArg).min(1).max(MAX_BATCH) }),
      outputSchema: z.object({
        notes: z.array(NoteSummary.extend({ body: z.string(), truncated: z.boolean() })),
        missing: z.array(z.string()),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ paths }) =>
      guarded(tc.log, async () => {
        const result = await adapter.batchRead(paths);
        const perNote = Math.max(
          2_000,
          Math.floor(MAX_RESULT_CHARS / Math.max(1, result.notes.length)),
        );
        const notes = result.notes.map((note) => {
          const clamped = clampText(note.body, perNote);
          return {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            hash: note.hash,
            body: clamped.text,
            truncated: clamped.truncated,
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
