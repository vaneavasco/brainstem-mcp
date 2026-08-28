import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_FRONTMATTER_HITS, MAX_SEARCH_RESULTS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

export function registerSearchTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index } = tc.runtime;

  server.registerTool(
    'vault_search',
    {
      title: 'Full-text search',
      description: `Literal (non-regex) substring search across text files in the vault, case-insensitive by default. Returns up to ${MAX_SEARCH_RESULTS} matching lines with path and line number. Use pathPrefix to scope to a folder.`,
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
        caseSensitive: z.boolean().optional(),
        pathPrefix: z.string().optional().describe('Folder to search in, e.g. "01-projects".'),
      }),
      outputSchema: z.object({
        query: z.string(),
        matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit, caseSensitive, pathPrefix }) =>
      guarded(tc.log, async () => {
        const max = limit ?? MAX_SEARCH_RESULTS;
        const opts = {
          limit: max,
          ...(caseSensitive !== undefined ? { caseSensitive } : {}),
          ...(pathPrefix !== undefined ? { pathPrefix } : {}),
        };
        const matches = await adapter.search(query, opts);
        return okJson({ query, matches, truncated: matches.length >= max });
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
