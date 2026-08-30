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
import { evaluateQuery } from '../vault/query.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

// Mirrors CondSchema/TagsFilterSchema in tools/query.ts (same shape, duplicated on purpose per
// the Task 9 brief rather than importing values across tool modules — search.ts already imports
// the pure vault/query.ts leaf module for Cond/Query/evaluateQuery, and keeping the Zod schemas
// local avoids a second, needless cross-tool-module dependency for one small shape).
const SearchCondSchema: z.ZodType<Cond> = z.object({
  field: z.string().min(1),
  op: z.enum([
    'eq',
    'neq',
    'contains',
    'startsWith',
    'exists',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'regex',
  ]),
  value: z.unknown().optional(),
});

const SearchTagsSchema: z.ZodType<NonNullable<Query['tags']>> = z.object({
  any: z.array(z.string()).optional(),
  all: z.array(z.string()).optional(),
  none: z.array(z.string()).optional(),
});

interface CandidateOpts {
  tags?: Query['tags'];
  where?: Cond[];
  pathPrefix?: string;
  glob?: string;
}

/** The `where`/`tags`/`pathPrefix` portion of `CandidateOpts` as an `evaluateQuery` `Query`
 *  (glob is applied separately — evaluateQuery doesn't know about it). Shared by candidate-list
 *  computation and by the single-entry re-check used when the candidate list itself was
 *  truncated (see `passesFilters` below). */
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
  /** Candidate paths from evaluateQuery (bounded by MAX_QUERY_ROWS), already glob-filtered. */
  paths: string[];
  /** True when evaluateQuery's own `total` exceeded MAX_QUERY_ROWS — `paths` may then be an
   *  incomplete slice of the true candidate set (evaluateQuery always clamps `rows` to
   *  MAX_QUERY_ROWS regardless of the `limit` requested), so it cannot be trusted as exhaustive
   *  for either the ≤200/chunked path-list strategies or the "total" reported to the caller. */
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
  const { rows, total } = evaluateQuery(index.all(), graph, filterQuery(opts, MAX_QUERY_ROWS));
  let paths = rows.map((r) => r.path);
  const glob = opts.glob;
  if (glob) paths = paths.filter((p) => matchesGlob(p, glob, opts.pathPrefix));
  return { paths, incomplete: total > MAX_QUERY_ROWS };
}

/** Whether a single index entry passes the `where`/`tags`/`pathPrefix` filter, re-checked one
 *  entry at a time (via evaluateQuery on a 1-element input) so evaluateQuery's own row cap —
 *  the exact thing `computeCandidates` above cannot exceed — never applies here: a one-entry
 *  input either fully matches (`total === 1`) or doesn't (`total === 0`), never truncated. */
function passesFilters(entry: IndexEntry, graph: VaultGraph, opts: CandidateOpts): boolean {
  return evaluateQuery([entry], graph, filterQuery(opts, 1)).total === 1;
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
 * matches whose file passes the where/tags/pathPrefix/glob filter, re-checked per file via
 * `passesFilters` (immune to the row cap that made the candidate list untrustworthy here).
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
  const passing = new Set<string>();
  for (const p of new Set(scanned.map((m) => m.path))) {
    const entry = index.get(p);
    if (!entry) continue; // not a markdown note the index tracks (tags/where can never apply)
    if (!passesFilters(entry, graph, candidateOpts)) continue;
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
        'compatibility.',
      inputSchema: z.object({
        query: z.string().min(1),
        regex: z
          .boolean()
          .optional()
          .describe('Treat "query" as a ripgrep regular expression instead of a literal.'),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
        caseSensitive: z.boolean().optional(),
        pathPrefix: z.string().optional().describe('Folder to search in, e.g. "01-projects".'),
        tags: SearchTagsSchema.optional().describe(
          'Restrict to notes carrying these tags before searching text (nested-aware).',
        ),
        where: z
          .array(SearchCondSchema)
          .optional()
          .describe('Restrict to notes matching these conditions before searching text.'),
        glob: z
          .string()
          .optional()
          .describe('Restrict candidate files to this glob, e.g. "**/*.md".'),
      }),
      outputSchema: z.object({
        query: z.string(),
        regex: z.boolean(),
        files: z.array(
          z.object({
            path: z.string(),
            matches: z.array(z.object({ line: z.number(), text: z.string() })),
          }),
        ),
        matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
        total: z.number(),
        truncated: z.boolean(),
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
        if (!hasFilter) {
          matches = await adapter.search(query, baseOpts);
          truncated = matches.length >= max;
        } else {
          const candidateOpts: CandidateOpts = { tags, where, pathPrefix, glob };
          const candidates = computeCandidates(index, graph, candidateOpts);
          if (candidates.incomplete) {
            // evaluateQuery's own row cap means `candidates.paths` cannot be trusted as
            // exhaustive here — fall back to a bounded whole-vault scan, filtered per file.
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
        });
      }),
  );

  server.registerTool(
    'vault_search_frontmatter',
    {
      title: 'Search by frontmatter',
      description: `Find markdown notes by a frontmatter field using the in-memory index. Provide at least one of equals (exact value or array membership), contains (case-insensitive substring) or exists. Dot paths like "meta.owner" are supported. Returns at most ${MAX_FRONTMATTER_HITS} hits; narrow the query if truncated.`,
      inputSchema: z.object({
        field: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        contains: z.string().optional(),
        exists: z.boolean().optional(),
      }),
      outputSchema: z.object({
        field: z.string(),
        hits: z.array(z.object({ path: z.string(), value: z.unknown() })),
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
