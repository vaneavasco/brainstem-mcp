import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BINARY_MIME_ALLOWLIST, MAX_BATCH, MAX_FILE_BYTES } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { APPEND_ONLY, OVERWRITE } from './annotations.ts';
import { type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

function decodeBase64Strict(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new VaultError('INVALID_INPUT', 'base64 is not valid.');
  }
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
}

export function registerWriteTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_write',
    {
      title: 'Write note',
      description: `Create or overwrite a text file (max ${MAX_FILE_BYTES} bytes). Content may start with a YAML frontmatter block. With mergeFrontmatter=true the existing frontmatter is kept and only the provided keys are changed. Prefer vault_edit or vault_append to change part of an existing note.`,
      inputSchema: z.object({
        path: PathArg,
        content: z.string(),
        mergeFrontmatter: z
          .boolean()
          .optional()
          .describe('Keep existing frontmatter keys not present in the new content.'),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      annotations: OVERWRITE,
    },
    ({ path, content, mergeFrontmatter }) =>
      guarded(tc.log, async () => {
        await adapter.write(path, content, { mergeFrontmatter: mergeFrontmatter ?? false });
        const note = await adapter.read(path);
        await touch(tc, note.path);
        return okJson(
          { path: note.path, bytes: note.meta.size },
          `Wrote ${note.path} (${note.meta.size} bytes).`,
        );
      }),
  );

  server.registerTool(
    'vault_write_binary',
    {
      title: 'Write image or PDF',
      description: `Store a binary attachment from base64. Allowed media types: ${[...BINARY_MIME_ALLOWLIST.keys()].join(', ')}. Max ${MAX_FILE_BYTES} bytes decoded. The file extension must match the media type.`,
      inputSchema: z.object({ path: PathArg, base64: z.string(), mimeType: z.string() }),
      outputSchema: z.object({ path: z.string(), bytes: z.number(), mimeType: z.string() }),
      annotations: OVERWRITE,
    },
    ({ path, base64, mimeType }) =>
      guarded(tc.log, async () => {
        const bytes = decodeBase64Strict(base64);
        await adapter.writeBinary(path, bytes, mimeType);
        return okJson(
          { path, bytes: bytes.byteLength, mimeType },
          `Wrote ${path} (${bytes.byteLength} bytes, ${mimeType}).`,
        );
      }),
  );

  server.registerTool(
    'vault_edit',
    {
      title: 'Edit note (exact-text patches)',
      description:
        'Apply ordered exact-text replacements to a file. Each "find" must occur exactly once in the current text (include surrounding context to disambiguate). Use dryRun=true to preview the unified diff without writing.',
      inputSchema: z.object({
        path: PathArg,
        patches: z
          .array(z.object({ find: z.string().min(1), replace: z.string() }))
          .min(1)
          .max(50),
        dryRun: z.boolean().optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        applied: z.number(),
        dryRun: z.boolean(),
        diff: z.string(),
      }),
      annotations: APPEND_ONLY,
    },
    ({ path, patches, dryRun }) =>
      guarded(tc.log, async () => {
        const result = await adapter.edit(path, patches, dryRun ?? false);
        if (!result.dryRun) await touch(tc, result.path);
        const summary = result.dryRun
          ? `Dry run: ${result.applied} patch(es) would change ${result.path}.\n${result.diff}`
          : `Applied ${result.applied} patch(es) to ${result.path}.\n${result.diff}`;
        return okJson({ ...result }, summary);
      }),
  );

  server.registerTool(
    'vault_append',
    {
      title: 'Append to note',
      description:
        'Append text to the end of a file (a newline is inserted before the appended text if the file does not already end with one, and after it so the file always ends with a newline). Creates the file when missing. Cheaper than vault_write for adding to existing notes.',
      inputSchema: z.object({ path: PathArg, content: z.string().min(1) }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      annotations: APPEND_ONLY,
    },
    ({ path, content }) =>
      guarded(tc.log, async () => {
        await adapter.append(path, content);
        const note = await adapter.read(path);
        await touch(tc, note.path);
        return okJson(
          { path: note.path, bytes: note.meta.size },
          `Appended to ${note.path} (now ${note.meta.size} bytes).`,
        );
      }),
  );

  server.registerTool(
    'vault_frontmatter_update',
    {
      title: 'Update frontmatter on a note',
      description:
        'Set or remove YAML frontmatter keys on a single markdown file without touching its body.',
      inputSchema: z.object({
        path: PathArg,
        set: z.record(z.string(), z.unknown()).optional(),
        unset: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        frontmatter: z.record(z.string(), z.unknown()),
      }),
      annotations: OVERWRITE,
    },
    ({ path, set, unset }) =>
      guarded(tc.log, async () => {
        // Read first so a missing file or encoding problem surfaces with its real error code;
        // batchFrontmatterUpdate (below) swallows per-item errors into `failed` for its own
        // best-effort batch semantics, which would otherwise flatten that distinction away.
        await adapter.read(path);
        const result = await adapter.batchFrontmatterUpdate([{ path, set, unset }]);
        if (result.updated.length === 0) {
          throw new VaultError(
            'INVALID_INPUT',
            result.failed[0]?.error ?? `Failed to update ${path}.`,
          );
        }
        await touch(tc, ...result.updated);
        const note = await adapter.read(result.updated[0] as string);
        return okJson(
          { path: note.path, frontmatter: note.frontmatter },
          `Updated frontmatter on ${note.path}.`,
        );
      }),
  );

  server.registerTool(
    'vault_batch_frontmatter_update',
    {
      title: 'Update frontmatter on several notes',
      description: `Set or remove YAML frontmatter keys on up to ${MAX_BATCH} markdown files without touching their bodies. Per-file failures are reported in "failed". For a single note use vault_frontmatter_update.`,
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              path: PathArg,
              set: z.record(z.string(), z.unknown()).optional(),
              unset: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
      }),
      outputSchema: z.object({
        updated: z.array(z.string()),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
      }),
      annotations: OVERWRITE,
    },
    ({ updates }) =>
      guarded(tc.log, async () => {
        const result = await adapter.batchFrontmatterUpdate(updates);
        await touch(tc, ...result.updated);
        return okJson({ updated: result.updated, failed: result.failed });
      }),
  );
}
