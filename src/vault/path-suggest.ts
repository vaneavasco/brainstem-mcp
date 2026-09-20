import { baseName, isReservedPath } from '../storage/path-policy.ts';

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
const ASCII_ONLY = /^[\x20-\x7e]*$/;

export function foldPath(p: string): string {
  // Nearly every path is plain ASCII: nothing to normalise or substitute there.
  if (ASCII_ONLY.test(p)) return p.replace(/ {2,}/g, ' ').toLowerCase();
  return p
    .normalize('NFKC')
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .toLowerCase();
}

/**
 * Near-miss lookup over the index paths, folded ONCE: a batch with twenty missing paths must not
 * fold 40,000 paths twenty times (measured: 36 ms per miss, half a second for the batch).
 * A suggestion is an index path whose folded form equals the folded wanted path (a typographic
 * apostrophe, an en dash for a hyphen, a different case, a doubled space) or, failing that, a
 * note with the same folded file name in another folder (the reader had the name right and the
 * folder wrong). Deliberately not fuzzy: cheap and predictable.
 */
export function buildSuggester(
  indexPaths: Iterable<string>,
): (wanted: string, max?: number) => string[] {
  const byPath = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, p: string): void => {
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  };
  for (const p of indexPaths) {
    if (!isSuggestable(p)) continue;
    const folded = foldPath(p);
    add(byPath, folded, p);
    add(byName, folded.slice(folded.lastIndexOf('/') + 1), p); // the tail of the folded path: folding the name again would double the cost
  }
  return (wanted, max = 3) => {
    const exact = byPath.get(foldPath(wanted)) ?? [];
    const found = exact.length > 0 ? exact : (byName.get(foldPath(baseName(wanted))) ?? []);
    return [...found].sort().slice(0, max);
  };
}

/** One miss: a single pass, no maps to build (a map pays off from the second miss on). */
export function suggestPaths(indexPaths: Iterable<string>, wanted: string, max = 3): string[] {
  const foldedWanted = foldPath(wanted);
  const wantedName = foldedWanted.slice(foldedWanted.lastIndexOf('/') + 1);
  const exact: string[] = [];
  const sameName: string[] = [];
  for (const p of indexPaths) {
    if (!isSuggestable(p)) continue;
    const folded = foldPath(p);
    if (folded === foldedWanted) exact.push(p);
    else if (exact.length === 0 && folded.endsWith(wantedName)) {
      if (
        folded.length === wantedName.length ||
        folded[folded.length - wantedName.length - 1] === '/'
      ) {
        sameName.push(p);
      }
    }
  }
  return (exact.length > 0 ? exact : sameName).sort().slice(0, max);
}
