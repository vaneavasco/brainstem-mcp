/**
 * Bounding a result by characters (ADR 0007). A client refuses a tool result that is too large
 * and the call is wasted, so every tool that returns a list keeps the longest prefix that fits
 * and says that it cut. Sizes are those of the serialized JSON, which is what travels.
 */

/**
 * The longest prefix of `items` whose JSON array stays within `budget` characters. Exact, not an
 * estimate: a plain array serializes as `[` + comma-joined items + `]`, so the items' own
 * serialized lengths plus one comma each reproduce it without re-serializing every prefix.
 */
export function fitWithinBudget<T>(items: T[], budget: number): { kept: T[]; cut: boolean } {
  let used = 2; // '[' + ']'
  const kept: T[] = [];
  for (const item of items) {
    const addition = JSON.stringify(item).length + (kept.length > 0 ? 1 : 0); // + comma
    if (used + addition > budget) return { kept, cut: true };
    used += addition;
    kept.push(item);
  }
  return { kept, cut: false };
}

/**
 * Several lists under one budget. Short lists are served whole and leave their share to the long
 * ones, like the notes of a batch read; `cut[i]` says whether list `i` lost items.
 */
export function fitListsWithinBudget<T>(
  lists: T[][],
  budget: number,
): { kept: T[][]; cut: boolean[] } {
  const sizes = lists.map((list) => JSON.stringify(list).length);
  const order = lists.map((_, i) => i).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
  const kept: T[][] = lists.map(() => []);
  const cut: boolean[] = lists.map(() => false);
  let remaining = budget;
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const fitted = fitWithinBudget(lists[index] ?? [], share);
    kept[index] = fitted.kept;
    cut[index] = fitted.cut;
    remaining -= JSON.stringify(fitted.kept).length;
  });
  return { kept, cut };
}
