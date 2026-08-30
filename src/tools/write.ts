import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BINARY_MIME_ALLOWLIST, MAX_BATCH, MAX_FILE_BYTES } from '../storage/limits.ts';
import { normalizedOrRaw, normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import { assertExpectedHash } from '../storage/write-gate.ts';
import { findSection, insertIntoSection, listHeadingPaths } from '../vault/sections.ts';
import { APPEND_ONLY, OVERWRITE } from './annotations.ts';
import { ExpectedHashArg, locked, type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

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
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number(), hash: z.string() }),
      annotations: OVERWRITE,
    },
    ({ path, content, mergeFrontmatter, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        return locked(tc, [p], async () => {
          await adapter.write(p, content, {
            mergeFrontmatter: mergeFrontmatter ?? false,
            expectedHash,
          });
          const note = await adapter.read(p);
          await touch(tc, note.path);
          return okJson(
            { path: note.path, bytes: note.meta.size, hash: note.hash },
            `Wrote ${note.path} (${note.meta.size} bytes).`,
          );
        });
      }),
  );

  server.registerTool(
    'vault_write_binary',
    {
      title: 'Write image or PDF',
      description: `Store a binary attachment from base64. Allowed media types: ${[...BINARY_MIME_ALLOWLIST.keys()].join(', ')}. Max ${MAX_FILE_BYTES} bytes decoded. The file extension must match the media type.`,
      inputSchema: z.object({
        path: PathArg,
        base64: z.string(),
        mimeType: z.string(),
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        bytes: z.number(),
        mimeType: z.string(),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, base64, mimeType, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        return locked(tc, [p], async () => {
          const bytes = decodeBase64Strict(base64);
          await adapter.writeBinary(p, bytes, mimeType, { expectedHash });
          const hash = await adapter.hashOf(p);
          // Unreachable in practice: we just wrote this exact file successfully, so it exists
          // and hashOf only returns null for a missing path or a directory.
          if (hash === null) throw new VaultError('IO', `Could not compute a hash for ${p}.`);
          return okJson(
            { path: p, bytes: bytes.byteLength, mimeType, hash },
            `Wrote ${p} (${bytes.byteLength} bytes, ${mimeType}).`,
          );
        });
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
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        applied: z.number(),
        dryRun: z.boolean(),
        diff: z.string(),
        hash: z.string(),
      }),
      annotations: APPEND_ONLY,
    },
    ({ path, patches, dryRun, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        return locked(tc, [p], async () => {
          const result = await adapter.edit(p, patches, dryRun ?? false, { expectedHash });
          if (!result.dryRun) await touch(tc, result.path);
          // Present both for dryRun (still the pre-edit hash) and a real edit (the new hash).
          const note = await adapter.read(result.path);
          const summary = result.dryRun
            ? `Dry run: ${result.applied} patch(es) would change ${result.path}.\n${result.diff}`
            : `Applied ${result.applied} patch(es) to ${result.path}.\n${result.diff}`;
          return okJson({ ...result, hash: note.hash }, summary);
        });
      }),
  );

  server.registerTool(
    'vault_append',
    {
      title: 'Append to note',
      description:
        'Append text to the end of a file (a newline is inserted before the appended text if the file does not already end with one, and after it so the file always ends with a newline). Creates the file when missing. Cheaper than vault_write for adding to existing notes. With "heading" (a heading path like "Heading" or "H1 > H2"), inserts inside that section instead — at its end (default) or its start ("position").',
      inputSchema: z.object({
        path: PathArg,
        content: z.string().min(1),
        heading: z
          .string()
          .optional()
          .describe('Insert inside this section (by heading path) instead of at end of file.'),
        position: z
          .enum(['start', 'end'])
          .optional()
          .describe('Where inside the section to insert, when "heading" is given. Default "end".'),
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number(), hash: z.string() }),
      annotations: APPEND_ONLY,
    },
    ({ path, content, heading, position, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        return locked(tc, [p], async () => {
          if (heading !== undefined) {
            const note = await adapter.read(p);
            const range = findSection(note.content, heading);
            if (!range) {
              throw new VaultError('NOT_FOUND', headingNotFoundMessage(note.content, heading));
            }
            const updated = insertIntoSection(note.content, range, content, position ?? 'end');
            await adapter.write(p, updated, { expectedHash });
            const after = await adapter.read(p);
            await touch(tc, after.path);
            return okJson(
              { path: after.path, bytes: after.meta.size, hash: after.hash },
              `Inserted into "${heading}" in ${after.path} (now ${after.meta.size} bytes).`,
            );
          }
          await adapter.append(p, content, { expectedHash });
          const note = await adapter.read(p);
          await touch(tc, note.path);
          return okJson(
            { path: note.path, bytes: note.meta.size, hash: note.hash },
            `Appended to ${note.path} (now ${note.meta.size} bytes).`,
          );
        });
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
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        frontmatter: z.record(z.string(), z.unknown()),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, set, unset, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        return locked(tc, [p], async () => {
          // Read first so a missing file, encoding problem or stale hash surfaces with its real
          // error code — batchFrontmatterUpdate (below) swallows per-item errors into `failed`
          // for its own best-effort batch semantics, which would otherwise flatten that away.
          const before = await adapter.read(p);
          if (expectedHash !== undefined) {
            assertExpectedHash(p, before.hash, expectedHash);
          }
          // Re-checked inside the adapter too (defense in depth); under the same lock this is
          // guaranteed to still match, so it never changes the observable outcome above.
          const result = await adapter.batchFrontmatterUpdate([
            { path: p, set, unset, expectedHash },
          ]);
          if (result.updated.length === 0) {
            throw new VaultError(
              'INVALID_INPUT',
              result.failed[0]?.error ?? `Failed to update ${p}.`,
            );
          }
          await touch(tc, ...result.updated);
          const note = await adapter.read(result.updated[0] as string);
          return okJson(
            { path: note.path, frontmatter: note.frontmatter, hash: note.hash },
            `Updated frontmatter on ${note.path}.`,
          );
        });
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
              expectedHash: ExpectedHashArg,
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
        // Non-throwing normalization: an invalid path (reserved, traversal, ...) must still
        // land in adapter.batchFrontmatterUpdate's per-item failed[], not abort the whole
        // batch by throwing while computing lock keys.
        const paths = updates.map((u) => normalizedOrRaw(u.path));
        return locked(tc, paths, async () => {
          const result = await adapter.batchFrontmatterUpdate(updates);
          await touch(tc, ...result.updated);
          return okJson({ updated: result.updated, failed: result.failed });
        });
      }),
  );
}
