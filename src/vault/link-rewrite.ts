import { baseName, isMarkdownPath, parentDir } from '../storage/path-policy.ts';
import type { LinkRef } from './note-parse.ts';

export interface TargetRewrite {
  link: LinkRef;
  newTarget: string;
}

function stripMdExt(p: string): string {
  return isMarkdownPath(p) ? p.slice(0, -3) : p;
}

/** The bare form a wikilink would use for `path` (basename, `.md` stripped for notes only). */
export function bareBasename(path: string): string {
  return baseName(stripMdExt(path));
}

/**
 * Relative POSIX path from `fromFolder` (a vault folder, '' for the root) to `toPath` (a vault
 * file path), without a leading './'. Pure path-segment arithmetic — no filesystem access.
 */
function relativeFromFolder(fromFolder: string, toPath: string): string {
  const fromSegs = fromFolder === '' ? [] : fromFolder.split('/');
  const toSegs = toPath.split('/');
  const toFile = toSegs.pop() ?? toPath;
  let i = 0;
  while (i < fromSegs.length && i < toSegs.length && fromSegs[i] === toSegs[i]) i += 1;
  const ups = fromSegs.length - i;
  const downs = toSegs.slice(i);
  return [...Array(ups).fill('..'), ...downs, toFile].join('/');
}

/**
 * The new target *text* for a single link, following the style of the old one (§4.3): a wiki
 * link that used a bare basename keeps that style when the new basename is still unique in the
 * vault, otherwise (and always for a link that already used a `/`) it gets the full vault path
 * (extension stripped for notes, kept for assets). A markdown link always gets the path relative
 * to `fromPath`'s folder, extension kept. Anchors and aliases are not part of this text — the
 * caller (`rewriteLinks`) re-attaches them from the original `LinkRef` unchanged.
 */
export function newTargetText(
  link: LinkRef,
  newPath: string,
  opts: { fromPath: string; basenameUnique: boolean },
): string {
  if (link.kind === 'wiki') {
    const full = stripMdExt(newPath);
    if (!link.target.includes('/') && opts.basenameUnique) return baseName(full);
    return full;
  }
  return relativeFromFolder(parentDir(opts.fromPath), newPath);
}

function attachAnchor(target: string, link: LinkRef): string {
  if (link.block !== undefined) return `${target}#^${link.block}`;
  if (link.heading !== undefined) return `${target}#${link.heading}`;
  return target;
}

function buildWiki(link: LinkRef, newTarget: string): string {
  let inner = attachAnchor(newTarget, link);
  if (link.alias !== undefined) inner += `|${link.alias}`;
  return `${link.embed ? '!' : ''}[[${inner}]]`;
}

/**
 * Whether the original markdown link wrapped its target in `<...>` — the label cannot itself
 * contain `]` (excluded by the parser's regex), so the first `](` in `raw` unambiguously marks
 * the label/target boundary.
 */
function mdUsedAngleBrackets(raw: string): boolean {
  const sep = raw.indexOf('](');
  return sep !== -1 && raw[sep + 2] === '<';
}

function buildMd(link: LinkRef, newTarget: string): string {
  const withAnchor = attachAnchor(newTarget, link);
  const wrap = mdUsedAngleBrackets(link.raw) || /\s/.test(withAnchor);
  const wrapped = wrap ? `<${withAnchor}>` : withAnchor;
  return `${link.embed ? '!' : ''}[${link.alias ?? ''}](${wrapped})`;
}

/**
 * Replaces each rewrite's link span (`link.start`..`link.end`) in `content` with a rebuilt link
 * that carries `newTarget`, preserving alias, heading/block anchor, embed marker and wiki/markdown
 * form exactly. Spans are replaced right-to-left (by `link.start` descending) so earlier offsets
 * in `content` stay valid as later ones are rewritten. Everything outside a rewritten span is left
 * byte-identical.
 */
export function rewriteLinks(content: string, rewrites: TargetRewrite[]): string {
  const sorted = [...rewrites].sort((a, b) => b.link.start - a.link.start);
  let out = content;
  for (const { link, newTarget } of sorted) {
    const replacement =
      link.kind === 'wiki' ? buildWiki(link, newTarget) : buildMd(link, newTarget);
    out = out.slice(0, link.start) + replacement + out.slice(link.end);
  }
  return out;
}
