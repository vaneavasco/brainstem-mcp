import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_BATCH, MAX_RESULT_CHARS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { findSection, listHeadingPaths, sliceSection } from '../vault/sections.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

const PathArg = z
  .string()
  .describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

const MAX_HEADING_LIST = 50;

/** NOT_FOUND message for an unresolved heading path, listing what headings actually exist
 *  (capped so a huge note cannot blow out the error message). */
function headingNotFoundMessage(content: string, headingPath: string): string {
  const paths = listHeadingPaths(content);
  if (paths.length === 0) {
    return `No heading "${headingPath}" found; this note has no headings.`;
  }
  const shown = paths.slice(0, MAX_HEADING_LIST).join(', ');
  const more = paths.length > MAX_HEADING_LIST ? ` (+${paths.length - MAX_HEADING_LIST} more)` : '';
  return `No heading "${headingPath}" found. Headings in this note: ${shown}${more}.`;
}

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
        'Read one file from the vault. Returns the full text (frontmatter + body) and parsed frontmatter. Large files are truncated at 120k characters. With "section" (a heading path like "Heading" or "H1 > H2", case-insensitive), returns only that section\'s text and its sectionRange instead of the whole file.',
      inputSchema: z.object({
        path: PathArg,
        section: z
          .string()
          .optional()
          .describe(
            'Return only this section (by heading path, e.g. "Heading" or "H1 > H2") instead of the whole file.',
          ),
      }),
      outputSchema: NoteSummary.extend({
        truncated: z.boolean(),
        totalChars: z.number(),
        sectionRange: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ path, section }) =>
      guarded(tc.log, async () => {
        const note = await adapter.read(path);
        let textOut = note.content;
        let sectionRange: { startLine: number; endLine: number } | undefined;
        if (section !== undefined) {
          const range = findSection(note.content, section);
          if (!range) {
            throw new VaultError('NOT_FOUND', headingNotFoundMessage(note.content, section));
          }
          textOut = sliceSection(note.content, range);
          sectionRange = { startLine: range.startLine, endLine: range.endLine };
        }
        const clamped = clampText(textOut);
        return okJson(
          {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            hash: note.hash,
            truncated: clamped.truncated,
            totalChars: clamped.totalChars,
            ...(sectionRange ? { sectionRange } : {}),
          },
          clamped.text,
        );
      }),
  );

  server.registerTool(
    'vault_batch_read',
    {
      title: 'Read several notes',
      description: `Read up to ${MAX_BATCH} files in one call. Missing files are listed in "missing", unreadable ones in "failed"; the call never fails because of one bad path.`,
      inputSchema: z.object({ paths: z.array(PathArg).min(1).max(MAX_BATCH) }),
      outputSchema: z.object({
        notes: z.array(NoteSummary.extend({ body: z.string(), truncated: z.boolean() })),
        missing: z.array(z.string()),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
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
        return okJson({ notes, missing: result.missing, failed: result.failed });
      }),
  );
}
