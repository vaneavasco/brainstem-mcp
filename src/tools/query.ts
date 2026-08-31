import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_QUERY_ROWS, MAX_RECENT } from '../storage/limits.ts';
import type { Cond, Query } from '../vault/query.ts';
import { evaluateQuery } from '../vault/query.ts';
import { READ_ONLY } from './annotations.ts';
import { CondSchema, TagsFilterSchema } from './args.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

const SortSchema = z.object({ field: z.string().min(1), order: z.enum(['asc', 'desc']) });

/**
 * Typed `z.ZodType<Query>` (not just `z.object({...})`) so this schema's inferred output is
 * checked against the pure `Query` interface at compile time — the same pattern `tx.ts` uses for
 * `TxOp`. If the two ever drift, this fails typecheck instead of silently succeeding behind an
 * `as Query` cast at the call site.
 */
const QuerySchema: z.ZodType<Query> = z.object({
  where: z.array(CondSchema).optional(),
  tags: TagsFilterSchema.optional(),
  pathPrefix: z.string().optional(),
  select: z.array(z.string()).optional(),
  sort: z.array(SortSchema).optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_ROWS).optional(),
  groupBy: z.string().optional(),
});

const QueryRowSchema = z.object({ path: z.string() }).catchall(z.unknown());

const GroupSchema = z.object({
  key: z.string(),
  count: z.number(),
  paths: z.array(z.string()),
});

const QueryResultSchema = z.object({
  rows: z.array(QueryRowSchema),
  total: z.number(),
  truncated: z.boolean(),
  groups: z.array(GroupSchema).optional(),
});

const RecentInputSchema = z.object({
  since: z
    .string()
    .regex(
      ISO_DATE_RE,
      'must be an ISO date or datetime, e.g. "2026-01-01" or "2026-01-01T00:00:00Z"',
    )
    .optional(),
  limit: z.number().int().min(1).max(MAX_RECENT).optional(),
  pathPrefix: z.string().optional(),
  kind: z.literal('modified').optional(),
});

const DEFAULT_RECENT_LIMIT = 50;

export function registerQueryTools(server: McpServer, tc: ToolContext): void {
  const { index, graph } = tc.runtime;

  server.registerTool(
    'vault_query',
    {
      title: 'Query notes',
      description:
        'Bases-style structured query over the in-memory index — no disk reads. Filter with ' +
        '"where" on frontmatter dot paths or virtual fields (path, basename, folder, modifiedAt, ' +
        'size, wordCount, tags, hash, backlinks/outgoing as counts, backlinkPaths/outgoingPaths ' +
        'as path arrays); comparisons are typed (numeric, chronological ISO dates, ' +
        'case-insensitive strings/arrays). "tags" (any/all/none) is nested-aware ("proj" matches ' +
        `"proj/x"). Supports pathPrefix, select, sort, groupBy, and limit (default 100, max ` +
        `${MAX_QUERY_ROWS}). Replaces most uses of vault_search_frontmatter, which stays for ` +
        'compatibility.',
      inputSchema: QuerySchema,
      outputSchema: QueryResultSchema,
      annotations: READ_ONLY,
    },
    (input) => guarded(tc.log, async () => okJson({ ...evaluateQuery(index.all(), graph, input) })),
  );

  server.registerTool(
    'vault_recent',
    {
      title: 'Recently modified notes',
      description:
        'Notes ordered by modification time (from the index, no disk reads), most recent first. ' +
        'Optionally restrict to notes modified at or after "since" (ISO date/datetime) or under ' +
        `"pathPrefix". Caps at ${MAX_RECENT} rows (default ${DEFAULT_RECENT_LIMIT}). Each row ` +
        'includes modifiedAt, size and wordCount. "kind" is reserved for a future "created" ' +
        'variant; only "modified" (the default) is supported today, since creation time cannot be ' +
        'told apart from modification time portably.',
      inputSchema: RecentInputSchema,
      outputSchema: QueryResultSchema,
      annotations: READ_ONLY,
    },
    ({ since, limit, pathPrefix }) =>
      guarded(tc.log, async () => {
        const where: Cond[] =
          since !== undefined ? [{ field: 'modifiedAt', op: 'gte', value: since }] : [];
        const query: Query = {
          where,
          ...(pathPrefix !== undefined ? { pathPrefix } : {}),
          sort: [{ field: 'modifiedAt', order: 'desc' }],
          select: ['modifiedAt', 'size', 'wordCount'],
          limit: limit ?? DEFAULT_RECENT_LIMIT,
        };
        return okJson({ ...evaluateQuery(index.all(), graph, query) });
      }),
  );
}
