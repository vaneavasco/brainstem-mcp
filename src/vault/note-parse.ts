export interface LinkRef {
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
  embed: boolean;
  kind: 'wiki' | 'md';
  /** Markdown links only: the target was written `<like this>`, which a rewrite must keep. The
   *  link's own text is not stored (it is `content.slice(start, end)`): across a large vault it
   *  was half the weight of all links. */
  angle?: true;
  line: number;
  start: number;
  end: number;
}
export interface Heading {
  level: number;
  text: string;
  line: number;
}
export interface BlockId {
  id: string;
  line: number;
}
export interface ParsedNote {
  links: LinkRef[];
  tags: string[];
  headings: Heading[];
  blockIds: BlockId[];
  wordCount: number;
}

const FENCE = /^(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;
const COMMENT = /%%[\s\S]*?%%|%%[\s\S]*$/g;
// The inner group allows a lone ']' that is not itself followed by another ']' — an alias like
// "[Draft] hello" (a single, unpaired bracket) must not terminate the match before the real "]]",
// which would otherwise leave the whole wikilink unrecognised (see sections.ts's LINK_TARGETS,
// which has the same fix for the same reason).
const WIKI = /(!?)\[\[((?:[^\]\n]|\](?!\]))+?)\]\]/g;
// [text](target) or [text](<target with spaces>); embeds have a leading '!'
const MD = /(!?)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^()\s]+))\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TAG = /(^|[\s([{,;"'])#([\p{L}\p{N}_/-]+)/gu;
// Exported: sections.ts (read/append by section) reuses this exact heading grammar rather
// than duplicating it, so the two never drift apart.
export const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/;
const BLOCK_ID_EOL = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;

/** Blank everything that is not note content, preserving length and newlines so offsets/lines hold. */
export function maskNonContent(text: string): string {
  const lines = text.split('\n');
  let inFence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (inFence) {
      out.push(blank(line));
      if (fence && fence[1]?.[0] === inFence[0] && (fence[1]?.length ?? 0) >= inFence.length)
        inFence = null;
      continue;
    }
    if (fence) {
      inFence = fence[1] ?? null;
      out.push(blank(line));
      continue;
    }
    out.push(line);
  }
  let masked = out.join('\n');
  masked = masked.replace(COMMENT, (m) => blank(m));
  masked = masked.replace(INLINE_CODE, (m) => blank(m));
  return masked;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

/** Exported for sections.ts, which needs the same file-line arithmetic to offset headings
 *  found in the body back to file-absolute line numbers. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  const values: string[] = [];
  if (typeof raw === 'string') values.push(...raw.split(/[,\s]+/));
  else if (Array.isArray(raw))
    values.push(...raw.filter((t): t is string => typeof t === 'string'));
  return values
    .map((t) => t.trim().replace(/^#/, '').replace(/\/+$/, ''))
    .filter((t) => t !== '' && /[^\d/]/.test(t));
}

export function splitWikiInner(
  inner: string,
): Omit<LinkRef, 'embed' | 'kind' | 'angle' | 'line' | 'start' | 'end'> {
  const pipe = inner.indexOf('|');
  const alias = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
  const ref = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = ref.indexOf('#');
  const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
  const anchor = hash >= 0 ? ref.slice(hash + 1) : '';
  if (anchor.startsWith('^')) return { target, block: anchor.slice(1), alias };
  if (anchor !== '') return { target, heading: anchor, alias };
  return { target, alias };
}

export function parseNote(
  content: string,
  frontmatter: Record<string, unknown>,
  body: string,
): ParsedNote {
  const bodyStart = content.length - body.length;
  const masked = maskNonContent(content);
  const maskedBody = masked.slice(bodyStart);
  const links: LinkRef[] = [];

  // Wikilinks inside the frontmatter block. Obsidian treats `[[…]]` in property values as links
  // (backlinks, graph, rename), so the index must too — otherwise a note whose only link to X is
  // `author: "[[X]]"` reports zero backlinks on X and a rename of X leaves the value stale.
  if (bodyStart > 0) {
    const head = content.slice(0, bodyStart);
    for (const m of head.matchAll(WIKI)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const parts = splitWikiInner(m[2] ?? '');
      if (parts.target === '' && !parts.heading && !parts.block) continue;
      links.push({
        ...parts,
        embed: false,
        kind: 'wiki',
        line: lineAt(content, start),
        start,
        end,
      });
    }
  }

  for (const m of maskedBody.matchAll(WIKI)) {
    const start = bodyStart + (m.index ?? 0);
    const end = start + m[0].length;
    const parts = splitWikiInner(m[2] ?? '');
    if (parts.target === '' && !parts.heading && !parts.block) continue;
    links.push({
      ...parts,
      embed: m[1] === '!',
      kind: 'wiki',
      line: lineAt(content, start),
      start,
      end,
    });
  }
  for (const m of maskedBody.matchAll(MD)) {
    const rawTarget = (m[3] ?? m[4] ?? '').trim();
    if (rawTarget === '' || SCHEME.test(rawTarget) || rawTarget.startsWith('#')) continue;
    const start = bodyStart + (m.index ?? 0);
    const end = start + m[0].length;
    const hash = rawTarget.indexOf('#');
    const targetPart = hash >= 0 ? rawTarget.slice(0, hash) : rawTarget;
    const anchor = hash >= 0 ? rawTarget.slice(hash + 1) : '';
    let target: string;
    try {
      target = decodeURIComponent(targetPart);
    } catch {
      target = targetPart;
    }
    links.push({
      target,
      ...(anchor.startsWith('^') ? { block: anchor.slice(1) } : anchor ? { heading: anchor } : {}),
      alias: m[2] ?? undefined,
      embed: m[1] === '!',
      kind: 'md',
      ...(m[3] !== undefined ? { angle: true as const } : {}),
      line: lineAt(content, start),
      start,
      end,
    });
  }
  links.sort((a, b) => a.start - b.start);

  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(t);
    }
  };
  for (const t of frontmatterTags(frontmatter)) push(t);
  for (const m of maskedBody.matchAll(TAG)) {
    const t = (m[2] ?? '').replace(/\/+$/, '');
    if (t !== '' && /[^\d/]/.test(t)) push(t);
  }

  const headings: Heading[] = [];
  const blockIds: BlockId[] = [];
  const maskedLines = maskedBody.split('\n');
  const firstBodyLine = lineAt(content, bodyStart);
  maskedLines.forEach((rawLine, i) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const h = HEADING.exec(line);
    if (h)
      headings.push({
        level: (h[1] ?? '#').length,
        text: (h[2] ?? '').trim(),
        line: firstBodyLine + i,
      });
    const b = BLOCK_ID_EOL.exec(line);
    if (b?.[1]) blockIds.push({ id: b[1], line: firstBodyLine + i });
  });

  const wordCount = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { links, tags, headings, blockIds, wordCount };
}

/** Matches a string that is, in its entirety, one wikilink — "[[target]]", optionally with
 *  "|alias", "#heading" or "^block" — the same inner grammar `WIKI` uses for note bodies, but
 *  anchored to the whole (trimmed) value: "text [[x]] more" has brackets only in the middle and
 *  is never mistaken for a link. */
const WHOLE_WIKILINK = /^\[\[((?:[^\]\n]|\](?!\]))+?)\]\]$/;

/** `s`, parsed as a whole wikilink; `null` when `s` (trimmed) is not exactly one. */
export function parseWholeWikilink(
  s: string,
): Omit<LinkRef, 'embed' | 'kind' | 'angle' | 'line' | 'start' | 'end'> | null {
  const m = WHOLE_WIKILINK.exec(s.trim());
  if (!m) return null;
  const parts = splitWikiInner(m[1] ?? '');
  return parts.target === '' ? null : parts;
}

/** What a link-aware comparison looks at: the target without a trailing `.md`, lower-cased, and
 *  its last path segment. `isLink` says whether the text was one whole wikilink. */
export interface LinkKey {
  full: string;
  base: string;
  hasFolder: boolean;
  isLink: boolean;
}

/** The key of a string or number; `null` for anything else (a list, a boolean, null). */
export function linkKey(value: unknown): LinkKey | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  const link = typeof value === 'string' && text.includes('[[') ? parseWholeWikilink(text) : null;
  const target = (link ? link.target : text).trim().replace(/\.md$/i, '').toLowerCase();
  const slash = target.lastIndexOf('/');
  return {
    full: target,
    base: slash === -1 ? target : target.slice(slash + 1),
    hasFolder: slash !== -1,
    isLink: link !== null,
  };
}

/** Whether two keys name the same note. Only when at least one side is a wikilink: two plain
 *  texts are the business of ordinary equality ("Open" is not "open"). With a folder on both
 *  sides the whole target decides (`[[a/Name]]` is not `[[b/Name]]`); otherwise the name does. */
export function sameLinkKey(a: LinkKey | null, b: LinkKey | null): boolean {
  if (!a || !b || (!a.isLink && !b.isLink)) return false;
  return a.hasFolder && b.hasFolder ? a.full === b.full : a.base === b.base;
}

/**
 * A frontmatter value that is one whole wikilink (`[[Alpha Person]]`, `[[people/Alpha Person]]`,
 * `[[Alpha Person|Alpha]]`, `[[Alpha Person#Heading]]`, `[[Alpha Person.md]]`) equals the plain
 * name, the full target, and another link to the same note. "contains" and "startsWith" never
 * come here: they stay substring and prefix operations on the raw text.
 */
export function linkAwareEquals(a: unknown, b: unknown): boolean {
  return sameLinkKey(linkKey(a), linkKey(b));
}
