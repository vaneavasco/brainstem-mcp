import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_BATCH, MAX_RESULT_CHARS } from '../storage/limits.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

const PathArg = z
  .string()
  .describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

const NoteSummary = z.object({
  path: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  hasFrontmatter: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
});

export function registerReadTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_read',
    {
      title: 'Read note',
      description:
        'Read one file from the vault. Returns the full text (frontmatter + body) and parsed frontmatter. Large files are truncated at 120k characters.',
      inputSchema: z.object({ path: PathArg }),
      outputSchema: NoteSummary.extend({ truncated: z.boolean(), totalChars: z.number() }),
      annotations: READ_ONLY,
    },
    ({ path }) =>
      guarded(tc.log, async () => {
        const note = await adapter.read(path);
        const clamped = clampText(note.content);
        return okJson(
          {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            truncated: clamped.truncated,
            totalChars: clamped.totalChars,
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
            body: clamped.text,
            truncated: clamped.truncated,
          };
        });
        return okJson({ notes, missing: result.missing, failed: result.failed });
      }),
  );
}
