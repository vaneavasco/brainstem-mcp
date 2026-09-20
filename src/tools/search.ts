import type { McpServer } from '@modelcontextprotocol/server';
import picomatch from 'picomatch';
import { z } from 'zod';
import {
  MAX_FRONTMATTER_HITS,
  MAX_QUERY_ROWS,
  MAX_SEARCH_PATHS,
  MAX_SEARCH_PATTERN_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SCAN,
} from '../storage/limits.ts';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import type { Match, SearchOpts, StorageAdapter } from '../storage/types.ts';
import { VaultError } from '../storage/types.ts';
import type { FrontmatterIndex, IndexEntry } from '../vault/frontmatter-index.ts';
import type { VaultGraph } from '../vault/graph.ts';
import type { Cond, Query } from '../vault/query.ts';
import { matchEntries } from '../vault/query.ts';
import { READ_ONLY } from './annotations.ts';
import { CondSchema, TagsFilterSchema } from './args.ts';
import type { ToolContext } from './register.ts';
import { GUIDE_POINTER, guarded, okJson } from './results.ts';

/** Attached only when a search found nothing, and only with advice that is true for that call:
 *  which of the caller's own choices could explain the empty result, never a generic tip. */
function zeroHitsHint(why: { regex: boolean; noCandidates: boolean; truncated: boolean }): string {
  if (why.noCandidates) {
    return 'No note passed the tags/where/glob filter, so no text was searched: check the filter with vault_query (countOnly) before changing the words.';
  }
  if (why.truncated) {
    return 'No matches in the part of the vault that was scanned before the scan limit: narrow the search with pathPrefix, tags or where.';
  }
  if (why.regex) {
    return 'No matches for this regular expression: it is matched per line; try a simpler pattern or a literal search.';
  }
  return 'No matches: this is a literal substring search. Try a spelling variant or a shorter word.';
}

interface CandidateOpts {
  tags?: Query['tags'];
  where?: Cond[];
  pathPrefix?: string;
  glob?: string;
}

/** The `where`/`tags`/`pathPrefix` portion of `CandidateOpts` as a `Query` for `matchEntries`
 *  (glob is applied separately — the query engine doesn't know about it). Shared by candidate-list
 *  computation and by the single-entry re-check used when the candidate list itself was
 *  truncated (see `filterPassingPaths` below). */
function filterQuery(opts: CandidateOpts, limit: number): Query {
  return {
    ...(opts.where ? { where: opts.where } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.pathPrefix !== undefined ? { pathPrefix: opts.pathPrefix } : {}),
    limit,
  };
}

function matchesGlob(p: string, glob: string, pathPrefix?: string): boolean {
  const base = normalizeVaultPath(pathPrefix ?? '');
  const matcher = picomatch(glob, { dot: false });
  return matcher(base === '' ? p : p.slice(base.length + 1));
}

interface Candidates {
  /** The first MAX_QUERY_ROWS candidate paths from matchEntries, already glob-filtered. */
  paths: string[];
  /** True when more than MAX_QUERY_ROWS notes matched: `paths` is then only a slice of the
   *  candidate set and cannot be trusted as exhaustive, neither for the path-list strategies nor
   *  for the "total" reported to the caller. */
  incomplete: boolean;
}

/**
 * Resolves `tags`/`where`/`glob` into a concrete list of candidate paths to search, by filtering
 * the in-memory index the same way `vault_query` does (§4.7) rather than re-implementing
 * filtering here. Glob matches candidate paths the same way `vault_list` does: relative to
 * `pathPrefix` when given, else relative to the vault root.
 */
function computeCandidates(
  index: FrontmatterIndex,
  graph: VaultGraph,
  opts: CandidateOpts,
): Candidates {
  // matchEntries, not evaluateQuery: a presented query result is cut by a row limit AND by a
  // character budget, and a candidate list cut by either silently loses matches.
  const matched = matchEntries(index.all(), graph, filterQuery(opts, MAX_QUERY_ROWS));
  let paths = matched.slice(0, MAX_QUERY_ROWS).map((entry) => entry.path);
  const glob = opts.glob;
  if (glob) paths = paths.filter((p) => matchesGlob(p, glob, opts.pathPrefix));
  return { paths, incomplete: matched.length > MAX_QUERY_ROWS };
}

/** Which of `entries` pass the `where`/`tags`/`pathPrefix` filter: every one of them. */
function filterPassingPaths(
  entries: IndexEntry[],
  graph: VaultGraph,
  opts: CandidateOpts,
): Set<string> {
  return new Set(
    matchEntries(entries, graph, filterQuery(opts, MAX_QUERY_ROWS)).map((entry) => entry.path),
  );
}

/**
 * Searches an already-known-good candidate path list (≤MAX_QUERY_ROWS, from `computeCandidates`)
 * in bounded chunks of at most MAX_SEARCH_PATHS paths per adapter call, stopping as soon as
 * `max` matches have been collected. Chunking (rather than one unscoped whole-vault call, or one
 * oversized `paths` call) is required because both the adapter's ripgrep and JS-fallback
 * backends apply `limit` while scanning — an unscoped call would burn the whole limit on
 * whichever files sort first, dropping every candidate match in a later file entirely; an
 * oversized `paths` call would exceed the adapter's own MAX_SEARCH_PATHS cap.
 */
async function searchInChunks(
  adapter: StorageAdapter,
  query: string,
  baseOpts: SearchOpts,
  candidatePaths: string[],
  max: number,
): Promise<{ matches: Match[]; truncated: boolean }> {
  const matches: Match[] = [];
  let truncated = false;
  for (let i = 0; i < candidatePaths.length; i += MAX_SEARCH_PATHS) {
    const remaining = max - matches.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const chunk = candidatePaths.slice(i, i + MAX_SEARCH_PATHS);
    const chunkMatches = await adapter.search(query, {
      ...baseOpts,
      limit: remaining,
      paths: chunk,
    });
    matches.push(...chunkMatches);
    // This chunk alone used up its whole budget: more matches may exist in it (past `limit`) or
    // in a later, unprocessed chunk — either way, the result is not exhaustive.
    if (chunkMatches.length >= remaining) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

/**
 * Used only when `computeCandidates` reported `incomplete: true` — its path list cannot be
 * trusted as exhaustive, so instead of searching a (possibly partial) candidate set, this scans
 * the whole vault for the text query (bounded by MAX_SEARCH_SCAN raw matches) and keeps only the
 * matches whose file passes the where/tags/pathPrefix/glob filter, re-checked in chunks via
 * `filterPassingPaths` (immune to the row cap that made the candidate list untrustworthy here).
 */
async function searchScanAndFilter(
  adapter: StorageAdapter,
  index: FrontmatterIndex,
  graph: VaultGraph,
  query: string,
  baseOpts: SearchOpts,
  candidateOpts: CandidateOpts,
  max: number,
): Promise<{ matches: Match[]; truncated: boolean }> {
  const scanned = await adapter.search(query, { ...baseOpts, limit: MAX_SEARCH_SCAN });
  const scannedEntries = [...new Set(scanned.map((m) => m.path))]
    .map((p) => index.get(p))
    // a path the index does not track is not a markdown note (tags/where can never apply)
    .filter((e): e is IndexEntry => e !== undefined);
  const passing = new Set<string>();
  for (const p of filterPassingPaths(scannedEntries, graph, candidateOpts)) {
    if (candidateOpts.glob && !matchesGlob(p, candidateOpts.glob, candidateOpts.pathPrefix))
      continue;
    passing.add(p);
  }
  const filtered = scanned.filter((m) => passing.has(m.path));
  const truncated = scanned.length >= MAX_SEARCH_SCAN || filtered.length > max;
  return { matches: filtered.slice(0, max), truncated };
}

function groupByFile(
  matches: Match[],
): { path: string; matches: { line: number; text: string }[] }[] {
  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const m of matches) {
    const forPath = byPath.get(m.path);
    if (forPath) forPath.push({ line: m.line, text: m.text });
    else byPath.set(m.path, [{ line: m.line, text: m.text }]);
  }
  return [...byPath.entries()].map(([p, ms]) => ({ path: p, matches: ms }));
}

export function registerSearchTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index, graph } = tc.runtime;

  server.registerTool(
    'vault_search',
    {
      title: 'Full-text search',
      description:
        'Literal substring search across text files, case-insensitive by default. Set ' +
        `regex:true for a ripgrep regular expression (max ${MAX_SEARCH_PATTERN_CHARS} chars; ` +
        'UNSUPPORTED if ripgrep is not installed — the Docker image always has it). Narrow the ' +
        'files searched first with tags (any/all/none), where (same conditions as vault_query) ' +
        'and/or glob before matching text — this can turn a vault-wide scan into a scan of a ' +
        `handful of files. Returns up to ${MAX_SEARCH_RESULTS} matching lines grouped per file ` +
        'in "files" (prefer this); "matches" is the same hits as a flat array, kept for ' +
        `compatibility. ${GUIDE_POINTER}`,
      inputSchema: z.strictObject({
        query: z.string().min(1),
        regex: z
          .boolean()
          .optional()
          .describe('Treat "query" as a ripgrep regular expression instead of a literal.'),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
        caseSensitive: z.boolean().optional(),
        pathPrefix: z.string().optional().describe('Folder to search in, e.g. "01-projects".'),
        tags: TagsFilterSchema.optional().describe(
          'Restrict to notes carrying these tags before searching text (nested-aware).',
        ),
        where: z
          .array(CondSchema)
          .optional()
          .describe('Restrict to notes matching these conditions before searching text.'),
        glob: z
          .string()
          .optional()
          .describe('Restrict candidate files to this glob, e.g. "**/*.md".'),
      }),
      outputSchema: z.looseObject({
        query: z.string(),
        regex: z.boolean(),
        files: z.array(
          z.looseObject({
            path: z.string(),
            matches: z.array(z.looseObject({ line: z.number(), text: z.string() })),
          }),
        ),
        matches: z.array(z.looseObject({ path: z.string(), line: z.number(), text: z.string() })),
        total: z.number(),
        truncated: z.boolean(),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ query, regex, limit, caseSensitive, pathPrefix, tags, where, glob }) =>
      guarded(tc.log, async () => {
        const max = limit ?? MAX_SEARCH_RESULTS;
        const baseOpts: SearchOpts = {
          limit: max,
          ...(caseSensitive !== undefined ? { caseSensitive } : {}),
          ...(pathPrefix !== undefined ? { pathPrefix } : {}),
          ...(regex !== undefined ? { regex } : {}),
        };

        const hasFilter = tags !== undefined || where !== undefined || glob !== undefined;
        let matches: Match[];
        let truncated: boolean;
        let noCandidates = false;
        if (!hasFilter) {
          matches = await adapter.search(query, baseOpts);
          truncated = matches.length >= max;
        } else {
          const candidateOpts: CandidateOpts = { tags, where, pathPrefix, glob };
          const candidates = computeCandidates(index, graph, candidateOpts);
          if (candidates.incomplete) {
            // More candidates than one path list may carry: `candidates.paths` is only a slice —
            // fall back to a bounded whole-vault scan, filtered per file.
            ({ matches, truncated } = await searchScanAndFilter(
              adapter,
              index,
              graph,
              query,
              baseOpts,
              candidateOpts,
              max,
            ));
          } else if (candidates.paths.length === 0) {
            matches = [];
            truncated = false;
            noCandidates = true;
          } else if (candidates.paths.length <= MAX_SEARCH_PATHS) {
            matches = await adapter.search(query, { ...baseOpts, paths: candidates.paths });
            truncated = matches.length >= max;
          } else {
            // 201..MAX_QUERY_ROWS candidates: chunk the search instead of one unscoped call, so
            // real candidate matches sorting after the limit in an unscoped scan are never
            // silently dropped (see searchInChunks's doc comment).
            ({ matches, truncated } = await searchInChunks(
              adapter,
              query,
              baseOpts,
              candidates.paths,
              max,
            ));
          }
        }

        return okJson({
          query,
          regex: regex === true,
          files: groupByFile(matches),
          matches,
          total: matches.length,
          truncated,
          ...(matches.length === 0
            ? { hint: zeroHitsHint({ regex: regex === true, noCandidates, truncated }) }
            : {}),
        });
      }),
  );

  server.registerTool(
    'vault_search_frontmatter',
    {
      title: 'Search by frontmatter',
      description: `Find markdown notes by a frontmatter field using the in-memory index. Provide at least one of equals (exact value or array membership), contains (case-insensitive substring) or exists. Dot paths like "meta.owner" are supported. Returns at most ${MAX_FRONTMATTER_HITS} hits; narrow the query if truncated.`,
      inputSchema: z.strictObject({
        field: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        contains: z.string().optional(),
        exists: z.boolean().optional(),
      }),
      outputSchema: z.looseObject({
        field: z.string(),
        hits: z.array(z.looseObject({ path: z.string(), value: z.unknown() })),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY,
    },
    ({ field, equals, contains, exists }) =>
      guarded(tc.log, async () => {
        if (equals === undefined && contains === undefined && exists === undefined) {
          throw new VaultError(
            'INVALID_INPUT',
            'Provide at least one of equals, contains or exists.',
          );
        }
        const hits = index.query({
          field,
          ...(equals !== undefined ? { equals } : {}),
          ...(contains !== undefined ? { contains } : {}),
          ...(exists !== undefined ? { exists } : {}),
        });
        const truncated = hits.length > MAX_FRONTMATTER_HITS;
        return okJson({
          field,
          hits: truncated ? hits.slice(0, MAX_FRONTMATTER_HITS) : hits,
          truncated,
        });
      }),
  );
}
