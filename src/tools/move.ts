import { baseName, isMarkdownPath } from '../storage/path-policy.ts';
import { failedEntryMessage, VaultError } from '../storage/types.ts';
import { parseCanvas, rewriteFileNodes, serializeCanvas } from '../vault/canvas.ts';
import { newTargetText, rewriteLinks, type TargetRewrite } from '../vault/link-rewrite.ts';
import type { LinkRef } from '../vault/note-parse.ts';
// Type-only on purpose: a value import would re-arm the register.ts import cycle (register →
// manage → move → register) that C3 in the Phase 4 final review defused via args.ts.
import type { ToolContext } from './register.ts';

export interface MovedPath {
  oldPath: string;
  newPath: string;
  kind: 'note' | 'asset';
}

/** Everything vault_move derives from the pre-move index before taking any lock. */
export interface MovePlan {
  src: string;
  dst: string;
  /** True when src is a single indexed note or asset (not a folder). */
  singleFile: boolean;
  moved: MovedPath[];
  rewritesBySource: Map<string, { link: LinkRef; newPath: string }[]>;
  canvasPaths: string[];
  lockPaths: string[];
  movedNewPathByOld: Map<string, string>;
  movedLower: Map<string, string>;
}

/**
 * Plans a move: which paths rename, which notes and canvases may need link rewrites, and the
 * full lock set. Pure derivation from the pre-move index/graph plus one `adapter.list` for
 * canvases — nothing here mutates the vault.
 */
export async function planMove(
  tc: ToolContext,
  src: string,
  dst: string,
  under: { path: string; kind: 'note' | 'asset' }[],
  updateLinks: boolean | undefined,
): Promise<MovePlan> {
  const { adapter, index, graph } = tc.runtime;
  const isNote = index.get(src) !== undefined;
  const isAsset = !isNote && index.assets().has(src);
  const effectiveUpdateLinks = updateLinks ?? (isNote || isAsset || under.length > 0);

  // The set of paths this move renames, computed from the pre-move index (a single note or
  // asset, or every note/asset currently under a moved folder). Used to keep the index
  // coherent regardless of updateLinks, and — when link rewriting is enabled — to resolve
  // backlinks and build the canvas file-node mapping.
  const moved: MovedPath[] =
    isNote || isAsset
      ? [{ oldPath: src, newPath: dst, kind: isNote ? 'note' : 'asset' }]
      : under.map((entry) => ({
          oldPath: entry.path,
          newPath: `${dst}/${entry.path.slice(src.length + 1)}`,
          kind: entry.kind,
        }));

  // Every link in the vault resolving to a moved path, collected from the graph *before* the
  // move (so this is O(backlinks), not O(vault)) — excludes same-file anchors (`[[#x]]`,
  // target === ''), which never carry a path and so are never rewritten. A moved note that
  // links to *another* moved note lands here too (source === one of `moved`'s old paths); it
  // is written back at its own new path once applyLinkRewrites remaps it.
  const rewritesBySource = new Map<string, { link: LinkRef; newPath: string }[]>();
  if (effectiveUpdateLinks) {
    for (const m of moved) {
      for (const bl of graph.backlinks(m.oldPath)) {
        if (bl.link.target === '') continue;
        const list = rewritesBySource.get(bl.source) ?? [];
        list.push({ link: bl.link, newPath: m.newPath });
        rewritesBySource.set(bl.source, list);
      }
    }
  }

  const canvasPaths = effectiveUpdateLinks
    ? (await adapter.list('', { depth: Number.POSITIVE_INFINITY, glob: '**/*.canvas' })).map(
        (e) => e.path,
      )
    : [];

  // A folder move must also lock everything currently known to live inside it (see
  // entriesUnder's doc comment in manage.ts) *and* the new path each of those files ends up at
  // — a moved note that links to another moved note is rewritten at its new path, which is a
  // different lock key from its old one — plus every source note this call may rewrite and
  // every canvas it may touch. Deduped because a canvas inside a moved folder is in both lists.
  const lockPaths = [
    ...new Set([
      src,
      dst,
      ...moved.map((m) => m.oldPath),
      ...moved.map((m) => m.newPath),
      ...rewritesBySource.keys(),
      ...canvasPaths,
    ]),
  ];

  return {
    src,
    dst,
    singleFile: isNote || isAsset,
    moved,
    rewritesBySource,
    canvasPaths,
    lockPaths,
    movedNewPathByOld: new Map(moved.map((m) => [m.oldPath, m.newPath])),
    movedLower: new Map(moved.map((m) => [m.oldPath.toLowerCase(), m.newPath])),
  };
}

/**
 * Rewrites wikilinks/markdown links in the planned source notes and file nodes in the planned
 * canvases, after the rename itself has happened. Must run inside the lock taken over
 * `plan.lockPaths`. Per-file failures (CONFLICT, unparseable canvas, …) land in `failed` and
 * never abort the loop — the move itself has already happened.
 */
export async function applyLinkRewrites(
  tc: ToolContext,
  plan: MovePlan,
): Promise<{
  linksUpdated: { path: string; count: number }[];
  failed: { path: string; error: string }[];
}> {
  const { adapter, index, graph } = tc.runtime;
  const { rewritesBySource, canvasPaths, movedNewPathByOld, movedLower } = plan;
  const linksUpdated: { path: string; count: number }[] = [];
  const failed: { path: string; error: string }[] = [];

  if (rewritesBySource.size > 0) {
    // Memoized per new path: is the moved note/asset's bare basename still the only one in the
    // vault after the move? (Reuses VaultGraph's own resolution rules instead of
    // re-implementing them.)
    const basenameUniqueCache = new Map<string, boolean>();
    const isBasenameUnique = (newPath: string): boolean => {
      const cached = basenameUniqueCache.get(newPath);
      if (cached !== undefined) return cached;
      const bare = isMarkdownPath(newPath) ? baseName(newPath.slice(0, -3)) : baseName(newPath);
      const unique = graph.resolve(bare, newPath).status === 'resolved';
      basenameUniqueCache.set(newPath, unique);
      return unique;
    };

    for (const [source, rewrites] of rewritesBySource) {
      // A moved note that itself links to another moved note is written at its *new* path — by
      // now it has already moved.
      const actualPath = movedNewPathByOld.get(source) ?? source;
      try {
        const expectedSourceHash = index.get(actualPath)?.hash;
        const targetRewrites: TargetRewrite[] = rewrites.map(({ link, newPath }) => ({
          link,
          newTarget: newTargetText(link, newPath, {
            fromPath: actualPath,
            basenameUnique: isBasenameUnique(newPath),
          }),
        }));
        const note = await adapter.read(actualPath);
        const newContent = rewriteLinks(note.content, targetRewrites);
        if (newContent === note.content) continue;
        const written = await adapter.write(actualPath, newContent, {
          expectedHash: expectedSourceHash,
        });
        index.applyNote(written);
        linksUpdated.push({ path: actualPath, count: targetRewrites.length });
      } catch (error) {
        if (error instanceof VaultError) {
          failed.push({ path: actualPath, error: failedEntryMessage(error) });
        } else {
          throw error;
        }
      }
    }
  }

  for (const canvasPath of canvasPaths) {
    // A moved .canvas file itself is listed at its old path (collected before the move).
    const actualCanvasPath = movedNewPathByOld.get(canvasPath) ?? canvasPath;
    // Same contract as the note loop above: one canvas the server cannot parse (an empty
    // object, a format from a newer Obsidian) is reported in failed[] — it must never abort a
    // move that has already renamed files and rewritten notes.
    try {
      const file = await adapter.read(actualCanvasPath);
      const canvas = parseCanvas(file.content);
      const { canvas: rewritten, count } = rewriteFileNodes(canvas, movedLower);
      // file.hash is the hash of exactly the bytes parsed above, read inside the lock: a
      // concurrent edit that slipped in fails with CONFLICT instead of being clobbered.
      if (count > 0) {
        await adapter.write(actualCanvasPath, serializeCanvas(rewritten), {
          expectedHash: file.hash,
        });
      }
    } catch (error) {
      if (error instanceof VaultError) {
        failed.push({ path: actualCanvasPath, error: failedEntryMessage(error) });
      } else {
        throw error;
      }
    }
  }

  return { linksUpdated, failed };
}
