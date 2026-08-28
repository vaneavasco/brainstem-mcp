import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ANALYTICS_CATEGORIES, type AnalyticsReport, analyzeVault } from '../vault/analytics.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

const CACHE_TTL_MS = 10 * 60 * 1000;

export function registerAnalyticsTools(server: McpServer, tc: ToolContext): void {
  const { adapter, settings, caches, now } = tc.runtime;

  async function report(refresh: boolean): Promise<AnalyticsReport> {
    const cached = caches.analytics;
    if (!refresh && cached && now().getTime() - cached.at < CACHE_TTL_MS) return cached.report;
    const fresh = await analyzeVault(adapter, {
      requiredFrontmatter: settings.requiredFrontmatter,
    });
    caches.analytics = { at: now().getTime(), report: fresh };
    return fresh;
  }

  const CategorySummary = z.object({ count: z.number(), examples: z.array(z.string()) });

  server.registerTool(
    'vault_analytics_summary',
    {
      title: 'Vault health summary',
      description:
        'Counts and examples of vault hygiene issues: notes without frontmatter, missing required frontmatter keys, broken wikilinks, inconsistent tag spellings, non-UTF-8 files and oversized files. Results are cached for 10 minutes unless refresh=true.',
      inputSchema: z.object({ refresh: z.boolean().optional() }),
      outputSchema: z.object({
        scannedFiles: z.number(),
        truncated: z.boolean(),
        categories: z.object(
          Object.fromEntries(ANALYTICS_CATEGORIES.map((c) => [c, CategorySummary])),
        ),
      }),
      annotations: READ_ONLY,
    },
    ({ refresh }) =>
      guarded(tc.log, async () => {
        const { summary } = await report(refresh ?? false);
        return okJson({ ...summary });
      }),
  );

  server.registerTool(
    'vault_analytics_findings',
    {
      title: 'Vault health findings',
      description: `Detailed findings for one category: ${ANALYTICS_CATEGORIES.join(', ')}.`,
      inputSchema: z.object({
        category: z.enum(ANALYTICS_CATEGORIES),
        limit: z.number().int().min(1).max(100).optional(),
        refresh: z.boolean().optional(),
      }),
      outputSchema: z.object({
        category: z.string(),
        total: z.number(),
        findings: z.array(z.object({ category: z.string(), path: z.string(), detail: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    ({ category, limit, refresh }) =>
      guarded(tc.log, async () => {
        const { findings } = await report(refresh ?? false);
        const matching = findings.filter((f) => f.category === category);
        return okJson({
          category,
          total: matching.length,
          findings: matching.slice(0, limit ?? 100),
        });
      }),
  );
}
