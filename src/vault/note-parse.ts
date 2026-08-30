export interface LinkRef {
  raw: string;
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
  embed: boolean;
  kind: 'wiki' | 'md';
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
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
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

function splitWikiInner(
  inner: string,
): Omit<LinkRef, 'raw' | 'embed' | 'kind' | 'line' | 'start' | 'end'> {
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

  for (const m of maskedBody.matchAll(WIKI)) {
    const start = bodyStart + (m.index ?? 0);
    const end = start + m[0].length;
    const parts = splitWikiInner(m[2] ?? '');
    if (parts.target === '' && !parts.heading && !parts.block) continue;
    links.push({
      raw: content.slice(start, end),
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
      raw: content.slice(start, end),
      target,
      ...(anchor.startsWith('^') ? { block: anchor.slice(1) } : anchor ? { heading: anchor } : {}),
      alias: m[2] ?? undefined,
      embed: m[1] === '!',
      kind: 'md',
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
