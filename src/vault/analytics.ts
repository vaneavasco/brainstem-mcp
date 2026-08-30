import { MAX_ANALYTICS_FILES, MAX_BATCH } from '../storage/limits.ts';
import { isMarkdownPath } from '../storage/path-policy.ts';
import type { StorageAdapter } from '../storage/types.ts';
import type { VaultGraph } from './graph.ts';

export const ANALYTICS_CATEGORIES = [
  'frontmatter_missing',
  'required_frontmatter_missing',
  'broken_wikilinks',
  'ambiguous_links',
  'orphan_notes',
  'suspicious_tag_variants',
  'encoding_issues',
  'oversized_files',
] as const;

export type AnalyticsCategory = (typeof ANALYTICS_CATEGORIES)[number];

export interface AnalyticsFinding {
  category: AnalyticsCategory;
  path: string;
  detail: string;
}

export interface AnalyticsSummary {
  scannedFiles: number;
  truncated: boolean;
  categories: Record<AnalyticsCategory, { count: number; examples: string[] }>;
  hubs: { path: string; backlinks: number }[];
}

export interface AnalyticsOptions {
  graph: VaultGraph;
  requiredFrontmatter?: string[];
  oversizedBytes?: number;
  dailyNotesFolder?: string;
}

export interface AnalyticsReport {
  summary: AnalyticsSummary;
  findings: AnalyticsFinding[];
}

/** Groups tag spellings that differ only by case, hyphen, or underscore (e.g. second-brain vs
 *  Second_Brain vs secondbrain), independent of VaultGraph's own (case-only) tag key. */
function tagKey(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, '');
}

export async function analyzeVault(
  adapter: StorageAdapter,
  opts: AnalyticsOptions,
): Promise<AnalyticsReport> {
  const required = opts.requiredFrontmatter ?? [];
  const oversizedBytes = opts.oversizedBytes ?? 524_288;
  const { graph, dailyNotesFolder } = opts;

  const allFiles = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
  const truncated = allFiles.length > MAX_ANALYTICS_FILES;
  const files = allFiles.slice(0, MAX_ANALYTICS_FILES);
  const findings: AnalyticsFinding[] = [];

  for (const file of files) {
    if ((file.size ?? 0) > oversizedBytes) {
      findings.push({ category: 'oversized_files', path: file.path, detail: `${file.size} bytes` });
    }
  }

  const mdPaths = files.filter((f) => isMarkdownPath(f.path)).map((f) => f.path);
  for (let i = 0; i < mdPaths.length; i += MAX_BATCH) {
    const chunk = mdPaths.slice(i, i + MAX_BATCH);
    const { notes, failed } = await adapter.batchRead(chunk);
    for (const f of failed) {
      findings.push({ category: 'encoding_issues', path: f.path, detail: f.error });
    }
    for (const note of notes) {
      if (!note.hasFrontmatter) {
        findings.push({
          category: 'frontmatter_missing',
          path: note.path,
          detail: 'no YAML frontmatter block',
        });
      }
      const missingKeys = required.filter((key) => note.frontmatter[key] === undefined);
      if (missingKeys.length > 0) {
        findings.push({
          category: 'required_frontmatter_missing',
          path: note.path,
          detail: `missing: ${missingKeys.join(', ')}`,
        });
      }
    }
  }

  for (const { source, link } of graph.unresolved()) {
    findings.push({ category: 'broken_wikilinks', path: source, detail: link.target });
  }
  for (const { source, link, candidates } of graph.ambiguous()) {
    findings.push({
      category: 'ambiguous_links',
      path: source,
      detail: `${link.target} → ${candidates.join(', ')}`,
    });
  }
  const isDaily = (p: string) => Boolean(dailyNotesFolder) && p.startsWith(`${dailyNotesFolder}/`);
  for (const path of graph.orphans(isDaily)) {
    findings.push({ category: 'orphan_notes', path, detail: 'no resolved links in or out' });
  }

  const tagForms = new Map<string, Set<string>>(); // grouped key -> exact spellings seen
  for (const t of graph.tags()) {
    const key = tagKey(t.tag);
    const forms = tagForms.get(key) ?? new Set<string>();
    forms.add(t.tag);
    tagForms.set(key, forms);
  }
  for (const [, forms] of tagForms) {
    if (forms.size < 2) continue;
    const spellings = [...forms].sort();
    const paths = spellings.flatMap((s) => graph.notesWithTag(s, false).map((n) => n.path));
    findings.push({
      category: 'suspicious_tag_variants',
      path: [...paths].sort()[0] ?? '',
      detail: `tag spelled ${spellings.length} ways: ${spellings.join(', ')}`,
    });
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    summary: summarize(findings, files.length, truncated, graph.hubs(10)),
    findings,
  };
}

export function summarize(
  findings: AnalyticsFinding[],
  scannedFiles: number,
  truncated: boolean,
  hubs: { path: string; backlinks: number }[],
): AnalyticsSummary {
  const categories = Object.fromEntries(
    ANALYTICS_CATEGORIES.map((category) => {
      const paths = [
        ...new Set(findings.filter((f) => f.category === category).map((f) => f.path)),
      ];
      return [
        category,
        {
          count: findings.filter((f) => f.category === category).length,
          examples: paths.slice(0, 3),
        },
      ];
    }),
  ) as AnalyticsSummary['categories'];
  return { scannedFiles, truncated, categories, hubs };
}
