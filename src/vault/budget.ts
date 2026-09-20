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

/** What is left of `budget` once `wrapper` (the result with its lists empty and its longest
 *  hint in place) is paid for. Measured, never estimated: a path, a field name or a hint can be
 *  a thousand characters long. */
export function roomBeside(wrapper: unknown, budget: number): number {
  return Math.max(budget - JSON.stringify(wrapper).length, 0);
}

/**
 * The longest prefix of `text` whose JSON string stays within `maxSerialized` characters
 * (quotes included). An average escape ratio is not good enough: a text that opens with line
 * breaks or control characters is denser at the start than overall. Serialized length grows with
 * the prefix, so a binary search finds the cut; a surrogate pair is never split.
 */
export function prefixWithinSerialized(text: string, maxSerialized: number): string {
  if (JSON.stringify(text).length <= maxSerialized) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, mid)).length <= maxSerialized) low = mid;
    else high = mid - 1;
  }
  const code = text.charCodeAt(low - 1);
  if (low > 0 && code >= 0xd800 && code <= 0xdbff) low -= 1;
  return text.slice(0, low);
}
