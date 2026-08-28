import { MAX_ANALYTICS_FILES, MAX_BATCH } from '../storage/limits.ts';
import { baseName, isMarkdownPath } from '../storage/path-policy.ts';
import type { Note, StorageAdapter } from '../storage/types.ts';

export const ANALYTICS_CATEGORIES = [
  'frontmatter_missing',
  'required_frontmatter_missing',
  'broken_wikilinks',
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
}

export interface AnalyticsOptions {
  requiredFrontmatter?: string[];
  oversizedBytes?: number;
}

export interface AnalyticsReport {
  summary: AnalyticsSummary;
  findings: AnalyticsFinding[];
}

const WIKILINK = /!?\[\[([^\]|#^\n]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;

function stripMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

function tagKey(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, '');
}

function collectTags(note: Note): string[] {
  const tags: string[] = [];
  const fm = note.frontmatter.tags;
  if (typeof fm === 'string') tags.push(...fm.split(/[,\s]+/).filter(Boolean));
  if (Array.isArray(fm)) tags.push(...fm.filter((t): t is string => typeof t === 'string'));
  for (const m of note.body.matchAll(INLINE_TAG)) if (m[1]) tags.push(m[1]);
  return tags.map((t) => t.replace(/^#/, ''));
}

export async function analyzeVault(
  adapter: StorageAdapter,
  opts: AnalyticsOptions = {},
): Promise<AnalyticsReport> {
  const required = opts.requiredFrontmatter ?? [];
  const oversizedBytes = opts.oversizedBytes ?? 524_288;

  const allFiles = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
  const truncated = allFiles.length > MAX_ANALYTICS_FILES;
  const files = allFiles.slice(0, MAX_ANALYTICS_FILES);
  const findings: AnalyticsFinding[] = [];

  const mdPaths = files.filter((f) => isMarkdownPath(f.path)).map((f) => f.path);
  const knownPaths = new Set(mdPaths.map((p) => stripMd(p).toLowerCase()));
  const knownBasenames = new Set(mdPaths.map((p) => stripMd(baseName(p)).toLowerCase()));
  const otherPaths = new Set(
    files.filter((f) => !isMarkdownPath(f.path)).map((f) => f.path.toLowerCase()),
  );
  const otherBasenames = new Set([...otherPaths].map((p) => baseName(p)));

  for (const file of files) {
    if ((file.size ?? 0) > oversizedBytes) {
      findings.push({ category: 'oversized_files', path: file.path, detail: `${file.size} bytes` });
    }
  }

  const tagForms = new Map<string, Map<string, string[]>>(); // key -> raw form -> paths

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
      for (const m of note.body.matchAll(WIKILINK)) {
        const target = (m[1] ?? '').trim();
        if (target === '') continue;
        const lower = target.toLowerCase();
        const resolved =
          knownPaths.has(stripMd(lower)) ||
          knownBasenames.has(stripMd(baseName(lower))) ||
          otherPaths.has(lower) ||
          otherBasenames.has(lower);
        if (!resolved)
          findings.push({ category: 'broken_wikilinks', path: note.path, detail: target });
      }
      for (const tag of collectTags(note)) {
        const key = tagKey(tag);
        const forms = tagForms.get(key) ?? new Map<string, string[]>();
        forms.set(tag, [...(forms.get(tag) ?? []), note.path]);
        tagForms.set(key, forms);
      }
    }
  }

  for (const [, forms] of tagForms) {
    if (forms.size < 2) continue;
    const spellings = [...forms.keys()];
    const firstPath = [...forms.values()].flat().sort()[0] ?? '';
    findings.push({
      category: 'suspicious_tag_variants',
      path: firstPath,
      detail: `tag spelled ${spellings.length} ways: ${spellings.join(', ')}`,
    });
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { summary: summarize(findings, files.length, truncated), findings };
}

export function summarize(
  findings: AnalyticsFinding[],
  scannedFiles: number,
  truncated: boolean,
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
  return { scannedFiles, truncated, categories };
}
