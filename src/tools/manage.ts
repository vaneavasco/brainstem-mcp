import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_LIST_ENTRIES } from '../storage/limits.ts';
import { isMarkdownPath, normalizeVaultPath } from '../storage/path-policy.ts';
import { MOVE_OR_DELETE, READ_ONLY } from './annotations.ts';
import { ExpectedHashArg } from './args.ts';
import { applyLinkRewrites, planMove } from './move.ts';
import { locked, type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

export function registerManageTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index } = tc.runtime;

  /**
   * Every indexed note or asset path nested under folder `prefix`, tagged by kind. Used both to
   * expand a folder move/delete's lock set beyond the folder path itself (so a concurrent write to
   * a file already inside the folder is serialized against the rename/delete instead of racing it
   * — a disjoint lock key would otherwise let it interleave with the rename and potentially
   * resurrect the folder, or silently lose the write) and, for `vault_move`, to know which index
   * method (`rename` vs `renameAsset`) applies to each moved path.
   */
  function entriesUnder(prefix: string): { path: string; kind: 'note' | 'asset' }[] {
    const under = (p: string): boolean => p.startsWith(`${prefix}/`);
    const notes = index
      .all()
      .filter((entry) => under(entry.path))
      .map((entry) => ({ path: entry.path, kind: 'note' as const }));
    const assets = [...index.assets()]
      .filter(under)
      .map((path) => ({ path, kind: 'asset' as const }));
    return [...notes, ...assets];
  }

  function pathsUnder(prefix: string): string[] {
    return entriesUnder(prefix).map((e) => e.path);
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
        'Move or rename a file or folder inside the vault. Fails if the destination already exists. ' +
        'By default, wikilinks, markdown links and canvas file nodes elsewhere in the vault that point ' +
        'at the moved note(s) are rewritten to the new location (mirroring Obsidian); set ' +
        'updateLinks:false to restore the old behaviour of never rewriting them. Links whose target is ' +
        'ambiguous are reported, never guessed, and left untouched. expectedHash is only honoured when ' +
        'moving a single file (not a folder).',
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
        expectedHash: ExpectedHashArg,
        updateLinks: z
          .boolean()
          .optional()
          .describe(
            'Rewrite links to the moved note(s)/attachment(s) in other notes and canvas file ' +
              'nodes. Default: true when moving a markdown note, an attachment, or a folder ' +
              'containing either; false otherwise.',
          ),
      }),
      outputSchema: z.object({
        from: z.string(),
        to: z.string(),
        hash: z.string().nullable(),
        linksUpdated: z.array(z.object({ path: z.string(), count: z.number() })),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
      }),
      annotations: MOVE_OR_DELETE,
    },
    ({ from, to, expectedHash, updateLinks }) =>
      guarded(tc.log, async () => {
        const src = normalizeVaultPath(from);
        const dst = normalizeVaultPath(to);
        // entriesUnder: folder contents, tagged by kind — empty when src is a single file.
        const plan = await planMove(tc, src, dst, entriesUnder(src), updateLinks);
        return locked(tc, plan.lockPaths, async () => {
          await adapter.move(src, dst, { expectedHash });

          // Keep the index coherent for a single note/asset or a whole folder — unconditionally,
          // independent of link rewriting.
          for (const m of plan.moved) {
            if (m.kind === 'note') index.rename(m.oldPath, m.newPath);
            else index.renameAsset(m.oldPath, m.newPath);
          }
          if (plan.singleFile) await touch(tc, dst);

          const { linksUpdated, failed } = await applyLinkRewrites(tc, plan);

          // null for a moved folder; a real hash for a moved file.
          const hash = await adapter.hashOf(dst);
          const summary =
            linksUpdated.length > 0
              ? `Moved ${src} → ${dst}. Updated links in ${linksUpdated.length} note(s).`
              : `Moved ${src} → ${dst}.`;
          return okJson({ from: src, to: dst, hash, linksUpdated, failed }, summary);
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
          // Keep the index coherent for both kinds of file: a single deleted note or asset, and
          // everything the index knows under a deleted folder. Assets matter as much as notes —
          // a stale asset entry keeps `[[img.png]]` resolving to a file that is now in .trash/.
          if (isMarkdownPath(p)) index.remove(p);
          else index.removeAsset(p);
          for (const entry of index.all())
            if (entry.path.startsWith(`${p}/`)) index.remove(entry.path);
          // Snapshot first: removeAsset mutates the set `assets()` is derived from.
          for (const assetPath of [...index.assets()])
            if (assetPath.startsWith(`${p}/`)) index.removeAsset(assetPath);
          return okJson({ path: p, trashed: true }, `Moved ${p} to .trash/.`);
        });
      }),
  );
}
