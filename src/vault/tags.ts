/**
 * The vault's nested-tag rule and ordering comparator, shared by `VaultGraph` and the query
 * engine so the two can never drift.
 */

/** A tag key covers itself and everything nested under it with a '/' separator ("proj" covers
 *  "proj" and "proj/x", never "project"). Both arguments must already be lowercase. */
export function isTagOrDescendant(key: string, parent: string): boolean {
  return key === parent || key.startsWith(`${parent}/`);
}

/**
 * Case-insensitive comparator with a case-sensitive fallback, so ordering stays total and stable
 * for strings differing only by case. The shared tie-break rule for `tags()`, `orphans()` and
 * `hubs()`.
 */
export function compareCaseInsensitive(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
