import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_BATCH, MAX_RESULT_CHARS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { describeUnknownHeading, findSection, sliceSection } from '../vault/sections.ts';
import { READ_ONLY } from './annotations.ts';
import { DetailedPathArg } from './args.ts';
import type { ToolContext } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

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
        path: DetailedPathArg,
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
            throw new VaultError('NOT_FOUND', describeUnknownHeading(note.content, section));
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
      inputSchema: z.object({ paths: z.array(DetailedPathArg).min(1).max(MAX_BATCH) }),
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
