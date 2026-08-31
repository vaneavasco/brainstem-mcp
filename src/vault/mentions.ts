import { clampMatchText, MAX_BATCH, MAX_UNLINKED_MENTIONS } from '../storage/limits.ts';
import { baseName } from '../storage/path-policy.ts';
import type { StorageAdapter } from '../storage/types.ts';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasCandidates(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.aliases;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string');
  return [];
}

/** Reads every distinct source path once (batched) and resolves each backlink's line to its text. */
export async function contextByLine(
  adapter: StorageAdapter,
  items: { source: string; line: number }[],
): Promise<Map<string, string>> {
  const paths = [...new Set(items.map((i) => i.source))];
  const linesByPath = new Map<string, string[]>();
  for (let i = 0; i < paths.length; i += MAX_BATCH) {
    const chunk = paths.slice(i, i + MAX_BATCH);
    const { notes } = await adapter.batchRead(chunk);
    for (const note of notes) linesByPath.set(note.path, note.content.split('\n'));
  }
  const result = new Map<string, string>();
  for (const { source, line } of items) {
    const key = `${source}:${line}`;
    if (result.has(key)) continue;
    const raw = linesByPath.get(source)?.[line - 1] ?? '';
    result.set(key, clampMatchText(raw));
  }
  return result;
}

/**
 * Plain-text occurrences of the note's basename or any alias, whole-word and case-insensitive,
 * in notes that do not already link to it. `adapter.search` is literal and already case-insensitive.
 */
export async function findUnlinkedMentions(
  adapter: StorageAdapter,
  notePath: string,
  frontmatter: Record<string, unknown>,
  backlinkSources: ReadonlySet<string>,
): Promise<{ mentions: { path: string; line: number; context: string }[]; truncated: boolean }> {
  const base = baseName(notePath).replace(/\.md$/i, '');
  const candidates = [...new Set([base, ...aliasCandidates(frontmatter)])].filter(
    (c) => c.trim() !== '',
  );
  const seen = new Set<string>();
  const mentions: { path: string; line: number; context: string }[] = [];
  for (const candidate of candidates) {
    const regex = new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escapeRegExp(candidate)}([^\\p{L}\\p{N}_]|$)`,
      'iu',
    );
    const matches = await adapter.search(candidate, { limit: MAX_UNLINKED_MENTIONS * 2 });
    for (const m of matches) {
      if (m.path === notePath) continue;
      if (backlinkSources.has(m.path)) continue;
      if (!regex.test(m.text)) continue;
      const key = `${m.path}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // m.text is already windowed by the adapter's own clampMatchText — no re-clamp needed.
      mentions.push({ path: m.path, line: m.line, context: m.text });
    }
  }
  const truncated = mentions.length > MAX_UNLINKED_MENTIONS;
  return { mentions: truncated ? mentions.slice(0, MAX_UNLINKED_MENTIONS) : mentions, truncated };
}
