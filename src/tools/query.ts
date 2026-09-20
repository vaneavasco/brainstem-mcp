import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MAX_QUERY_FIELD_CHARS,
  MAX_QUERY_RESULT_CHARS,
  MAX_QUERY_ROWS,
  MAX_QUERY_SELECT,
  MAX_RECENT,
} from '../storage/limits.ts';
import type { Cond, Query } from '../vault/query.ts';
import { evaluateQuery } from '../vault/query.ts';
import { READ_ONLY } from './annotations.ts';
import { CondSchema, TagsFilterSchema } from './args.ts';
import type { ToolContext } from './register.ts';
import { GUIDE_POINTER, guarded, okJson } from './results.ts';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

const SortSchema = z.strictObject({
  field: z.string().min(1).max(MAX_QUERY_FIELD_CHARS),
  order: z.enum(['asc', 'desc']),
});

/**
 * Typed `z.ZodType<Query>` (not just an untyped `z.strictObject({...})`) so this schema's inferred output is
 * checked against the pure `Query` interface at compile time — the same pattern `tx.ts` uses for
 * `TxOp`. If the two ever drift, this fails typecheck instead of silently succeeding behind an
 * `as Query` cast at the call site.
 */
const QuerySchema: z.ZodType<Query> = z.strictObject({
  where: z.array(CondSchema).optional(),
  tags: TagsFilterSchema.optional(),
  pathPrefix: z.string().optional(),
  select: z.array(z.string().min(1).max(MAX_QUERY_FIELD_CHARS)).max(MAX_QUERY_SELECT).optional(),
  sort: z.array(SortSchema).optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_ROWS).optional(),
  groupBy: z.string().min(1).max(MAX_QUERY_FIELD_CHARS).optional(),
  countOnly: z.boolean().optional(),
  format: z
    .enum(['rows', 'columns'])
    .optional()
    .describe(
      '"rows" (default): one object per note. "columns": a "columns" name list plus one ' +
        '"values" array per note — cheaper for many rows/fields.',
    ),
});

const QueryRowSchema = z.looseObject({ path: z.string() });

const GroupSchema = z.looseObject({
  key: z.string(),
  count: z.number(),
  paths: z.array(z.string()),
});

const QueryResultSchema = z.looseObject({
  rows: z.array(QueryRowSchema),
  total: z.number(),
  truncated: z.boolean(),
  groups: z.array(GroupSchema).optional(),
  hint: z.string().optional(),
  columns: z.array(z.string()).optional(),
  values: z.array(z.array(z.unknown())).optional(),
});

const RecentInputSchema = z.strictObject({
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
        'Structured query over the in-memory index — no disk reads. "where" filters frontmatter ' +
        'dot paths or virtual fields (path, basename, folder, modifiedAt, size, wordCount, tags, ' +
        'hash, backlinks/outgoing, backlinkPaths/outgoingPaths); "tags" is nested-aware. Supports ' +
        `pathPrefix, select, sort, groupBy, limit (default 100, max ${MAX_QUERY_ROWS}), countOnly ` +
        '(total + group counts only). "format":"columns" trades repeated field names for one ' +
        `values array per row; rows/values cap at ${MAX_QUERY_RESULT_CHARS.toLocaleString('en-US')} ` +
        'characters (truncated + hint). Prefer it to vault_search_frontmatter. ' +
        GUIDE_POINTER,
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
