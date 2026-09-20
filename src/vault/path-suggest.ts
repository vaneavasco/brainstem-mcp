import { baseName, isReservedPath, parentDir } from '../storage/path-policy.ts';

/** True for a path under `_brainstem/` or with any dot-segment: the index never holds these, so
 *  a suggestion built from index paths never needs this filter to actually trigger — kept as a
 *  belt-and-suspenders guarantee independent of the caller. */
function isSuggestable(p: string): boolean {
  return !isReservedPath(p) && !p.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Folds a path for a cheap, purely textual comparison — no fuzzy distance matching, just the
 * handful of look-alike substitutions a reader actually hits: Unicode NFKC, typographic quotes
 * and apostrophes to their ASCII equivalents, en/em dashes and the non-breaking hyphen to a plain
 * hyphen, non-breaking and repeated spaces to one space, and lower-cased throughout.
 */
export function foldPath(p: string): string {
  return p
    .normalize('NFKC')
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[  -   　]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .toLowerCase();
}

/**
 * Up to `max` index paths that a caller who typed `wanted` and got NOT_FOUND probably meant: an
 * exact match once both sides are folded (a typographic apostrophe, an en dash for a hyphen, a
 * different case, a doubled space), or — failing that — a path in the same folder whose folded
 * basename equals. Deliberately not fuzzy: it runs over the whole index on every miss (up to
 * ~40,000 paths in the vaults this was built for), so the check per path must stay O(1).
 */
export function suggestPaths(indexPaths: Iterable<string>, wanted: string, max = 3): string[] {
  const all = [...indexPaths].filter(isSuggestable);
  const foldedWanted = foldPath(wanted);
  const exact = all.filter((p) => foldPath(p) === foldedWanted).sort();
  if (exact.length > 0) return exact.slice(0, max);

  const dir = parentDir(wanted);
  const foldedBase = foldPath(baseName(wanted));
  const sameFolder = all
    .filter((p) => parentDir(p) === dir && foldPath(baseName(p)) === foldedBase)
    .sort();
  return sameFolder.slice(0, max);
}
