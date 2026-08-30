import type { McpServer } from '@modelcontextprotocol/server';
import picomatch from 'picomatch';
import { z } from 'zod';
import {
  MAX_FRONTMATTER_HITS,
  MAX_QUERY_ROWS,
  MAX_SEARCH_PATHS,
  MAX_SEARCH_PATTERN_CHARS,
  MAX_SEARCH_RESULTS,
} from '../storage/limits.ts';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import type { Match, SearchOpts } from '../storage/types.ts';
import { VaultError } from '../storage/types.ts';
import type { FrontmatterIndex } from '../vault/frontmatter-index.ts';
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
): string[] {
  const query: Query = {
    ...(opts.where ? { where: opts.where } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.pathPrefix !== undefined ? { pathPrefix: opts.pathPrefix } : {}),
    // evaluateQuery clamps to MAX_QUERY_ROWS regardless of what's requested (its own safety net),
    // so this is the largest candidate set it can hand back in one call. Above that, vault_search
    // falls back to searching everything and post-filtering matches by path (see below) — a
    // pragmatic bound shared with vault_query's own row cap rather than a second, unbounded scan.
    limit: MAX_QUERY_ROWS,
  };
  const { rows } = evaluateQuery(index.all(), graph, query);
  let paths = rows.map((r) => r.path);
  if (opts.glob) {
    const base = normalizeVaultPath(opts.pathPrefix ?? '');
    const matcher = picomatch(opts.glob, { dot: false });
    paths = paths.filter((p) => matcher(base === '' ? p : p.slice(base.length + 1)));
  }
  return paths;
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
        if (hasFilter) {
          const candidates = computeCandidates(index, graph, { tags, where, pathPrefix, glob });
          if (candidates.length === 0) {
            matches = [];
          } else if (candidates.length <= MAX_SEARCH_PATHS) {
            matches = await adapter.search(query, { ...baseOpts, paths: candidates });
          } else {
            const all = await adapter.search(query, baseOpts);
            const candidateSet = new Set(candidates);
            matches = all.filter((m) => candidateSet.has(m.path));
          }
        } else {
          matches = await adapter.search(query, baseOpts);
        }

        return okJson({
          query,
          regex: regex === true,
          files: groupByFile(matches),
          matches,
          total: matches.length,
          truncated: matches.length >= max,
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
