import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_LIST_ENTRIES } from '../storage/limits.ts';
import { isMarkdownPath, normalizeVaultPath } from '../storage/path-policy.ts';
import { MOVE_OR_DELETE, READ_ONLY } from './annotations.ts';
import { ExpectedHashArg, locked, type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

export function registerManageTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index } = tc.runtime;

  /**
   * Every indexed note or asset path nested under folder `prefix`. Used to expand a folder
   * move/delete's lock set beyond the folder path itself, so a concurrent write to a file already
   * inside the folder is serialized against the rename/delete instead of racing it (a disjoint
   * lock key would otherwise let it interleave with the rename and potentially resurrect the
   * folder, or silently lose the write).
   */
  function pathsUnder(prefix: string): string[] {
    const under = (p: string): boolean => p.startsWith(`${prefix}/`);
    const notePaths = index.all().map((entry) => entry.path);
    return [...notePaths, ...index.assets()].filter(under);
  }

  server.registerTool(
    'vault_list',
    {
      title: 'List folder',
      description:
        'List files and folders under a vault path (default: root, depth 1). Use depth for recursion and glob (relative to the listed folder, e.g. "**/*.md") to filter. Hidden folders such as .obsidian are never listed. Returns at most 2000 entries; narrow with path/glob/depth if truncated.',
      inputSchema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(50).optional(),
        glob: z.string().optional(),
        includeFiles: z.boolean().optional(),
        includeDirs: z.boolean().optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        entries: z.array(
          z.object({
            path: z.string(),
            kind: z.enum(['file', 'dir']),
            size: z.number().optional(),
            modifiedAt: z.string().optional(),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY,
    },
    ({ path, depth, glob, includeFiles, includeDirs }) =>
      guarded(tc.log, async () => {
        const base = normalizeVaultPath(path ?? '');
        const entries = await adapter.list(base, {
          ...(depth !== undefined ? { depth } : {}),
          ...(glob !== undefined ? { glob } : {}),
          ...(includeFiles !== undefined ? { includeFiles } : {}),
          ...(includeDirs !== undefined ? { includeDirs } : {}),
        });
        const truncated = entries.length > MAX_LIST_ENTRIES;
        return okJson({
          path: base,
          entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
          truncated,
        });
      }),
  );

  server.registerTool(
    'vault_move',
    {
      title: 'Move or rename',
      description:
        'Move or rename a file or folder inside the vault. Fails if the destination already exists. Wikilinks in other notes are not rewritten. expectedHash is only honoured when moving a single file (not a folder).',
      inputSchema: z.object({ from: z.string(), to: z.string(), expectedHash: ExpectedHashArg }),
      outputSchema: z.object({ from: z.string(), to: z.string(), hash: z.string().nullable() }),
      annotations: MOVE_OR_DELETE,
    },
    ({ from, to, expectedHash }) =>
      guarded(tc.log, async () => {
        const src = normalizeVaultPath(from);
        const dst = normalizeVaultPath(to);
        const isNote = index.get(src) !== undefined;
        // A folder move must also lock everything currently known to live inside it — see
        // pathsUnder's doc comment.
        const lockPaths = isNote ? [src, dst] : [src, dst, ...pathsUnder(src)];
        return locked(tc, lockPaths, async () => {
          await adapter.move(src, dst, { expectedHash });
          // Keep the index coherent for a single note or a whole folder.
          if (isNote) {
            index.rename(src, dst);
            await touch(tc, dst);
          } else {
            for (const entry of index.all()) {
              if (entry.path.startsWith(`${src}/`))
                index.rename(entry.path, `${dst}/${entry.path.slice(src.length + 1)}`);
            }
          }
          // null for a moved folder; a real hash
          // for a moved file.
          const hash = await adapter.hashOf(dst);
          return okJson({ from: src, to: dst, hash }, `Moved ${src} → ${dst}.`);
        });
      }),
  );

  server.registerTool(
    'vault_delete',
    {
      title: 'Delete (to trash)',
      description:
        "Soft-delete a file or folder by moving it into the vault's .trash/ folder. Requires confirm=true — call without it first only if you need the user to confirm. Nothing is erased permanently. expectedHash is only honoured when deleting a single file (not a folder).",
      inputSchema: z.object({
        path: z.string(),
        confirm: z.boolean(),
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({ path: z.string(), trashed: z.boolean() }),
      annotations: MOVE_OR_DELETE,
    },
    ({ path, confirm, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        // A superset covering both cases: pathsUnder(p) is empty when p is a single file.
        const lockPaths = [p, ...pathsUnder(p)];
        return locked(tc, lockPaths, async () => {
          await adapter.softDelete(p, confirm, { expectedHash });
          if (isMarkdownPath(p)) index.remove(p);
          for (const entry of index.all())
            if (entry.path.startsWith(`${p}/`)) index.remove(entry.path);
          return okJson({ path: p, trashed: true }, `Moved ${p} to .trash/.`);
        });
      }),
  );
}
