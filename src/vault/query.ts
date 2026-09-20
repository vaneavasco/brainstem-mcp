import { MAX_QUERY_RESULT_CHARS, MAX_QUERY_ROWS } from '../storage/limits.ts';
import { baseName, parentDir } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import { fitWithinBudget } from './budget.ts';
import { getPath, type IndexEntry } from './frontmatter-index.ts';
import type { VaultGraph } from './graph.ts';
import { type LinkKey, linkKey, sameLinkKey } from './note-parse.ts';
import { compileSafePattern, type SafeMatcher } from './safe-regex.ts';
import { isTagOrDescendant } from './tags.ts';

export type Op =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'exists'
  | 'nonEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'regex';

/** Cap on the number of needles a "contains"/"startsWith" array value may carry — past this, one
 *  query per candidate is no cheaper, and the caller likely wants a different op. */
export const MAX_CONTAINS_NEEDLES = 50;

export interface Cond {
  field: string;
  op: Op;
  value?: unknown;
}

export interface Query {
  where?: Cond[];
  tags?: { any?: string[]; all?: string[]; none?: string[] };
  pathPrefix?: string;
  select?: string[];
  sort?: { field: string; order: 'asc' | 'desc' }[];
  limit?: number;
  /** Counts only: no rows, no example paths in groups — the cheap answer to "how many". */
  countOnly?: boolean;
  groupBy?: string;
  /** With groupBy: keep only group keys that start with this. Refused without groupBy. */
  groupPrefix?: string;
  /** Field names (dot paths allowed) to total over every match, not only the rows a result can
   *  carry — the way to get an exact number without adding up a possibly-cut "rows". */
  sum?: string[];
  /** "rows" (default): one object per note. "columns": a "columns" name list (path first) plus
   *  one "values" array per note in the same order — cheaper to transmit than repeating every
   *  field name on every row. Either way "rows" is subject to the same MAX_QUERY_RESULT_CHARS
   *  budget as "values". */
  format?: 'rows' | 'columns';
}

export interface QueryRow {
  path: string;
  [field: string]: unknown;
}

export interface QueryGroup {
  key: string;
  count: number;
  paths: string[];
  /** Present only when "sum" was asked for: totals over this group's own matches. */
  sums?: Record<string, number>;
  sumCounted?: Record<string, number>;
}

export interface QueryResult {
  rows: QueryRow[];
  total: number;
  truncated: boolean;
  groups?: QueryGroup[];
  /** Set when notes landed in several groups, so nobody adds the group counts up to "total". */
  hint?: string;
  /** "columns" format only: field names, "path" first. */
  columns?: string[];
  /** "columns" format only: one array per note, aligned with "columns", in the same order "rows" would have been. */
  values?: unknown[][];
  /** Present only when "sum" was asked for: totals over EVERY match (not only the rows returned). */
  sums?: Record<string, number>;
  /** Present only when "sum" was asked for: how many matches had a numeric value per field, so a
   *  reader can tell "0" from "no data". */
  sumCounted?: Record<string, number>;
}

export const GROUP_PATHS_DROPPED_HINT =
  'Example paths were left out of "groups" to keep the result small; filter on one group key to list its notes.';

function joinHints(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b;
}

export const OVERLAPPING_GROUPS_HINT =
  'groupBy field is a list: a note counts once in each of its values, so the group counts add up to more than "total".';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const MAX_GROUP_PATHS = 20;
const NONE_GROUP_KEY = '(none)';

const VIRTUAL_FIELDS = new Set([
  'path',
  'basename',
  'folder',
  'modifiedAt',
  'size',
  'wordCount',
  'backlinks',
  'outgoing',
  'backlinkPaths',
  'outgoingPaths',
  'tags',
  'hash',
]);

function isIsoDateString(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v);
}

/** Unique, sorted target paths this entry resolves to (embeds and repeats collapsed). */
function resolvedOutgoingPaths(entry: IndexEntry, graph: VaultGraph): string[] {
  return [
    ...new Set(
      graph
        .outgoing(entry.path)
        .filter((rl) => rl.resolution.status === 'resolved')
        .map((rl) => (rl.resolution as { status: 'resolved'; path: string }).path),
    ),
  ].sort();
}

/**
 * Resolves a note's value for one query field: a virtual field (computed from the index/graph)
 * or a frontmatter dot path. Virtual field names always win over a same-named frontmatter key,
 * since they are the stable, well-typed surface a query author can rely on.
 *
 * `backlinks`/`outgoing` are NUMBERS (link-occurrence counts, matching `vault_outline`'s
 * `backlinkCount`/`linkCount` and `graph.backlinks()`'s one-entry-per-link semantics) so that
 * `gt`/`lt`/`sort` do degree comparisons correctly instead of falling into the string-fallback
 * branch of `typedCompare`. Use `backlinkPaths`/`outgoingPaths` (arrays of unique resolved paths)
 * for membership queries like `backlinkPaths contains 'x.md'`.
 */
export function fieldValue(entry: IndexEntry, graph: VaultGraph, field: string): unknown {
  if (!VIRTUAL_FIELDS.has(field)) return getPath(entry.frontmatter, field);
  switch (field) {
    case 'path':
      return entry.path;
    case 'basename':
      return baseName(entry.path).replace(/\.md$/i, '');
    case 'folder':
      return parentDir(entry.path);
    case 'modifiedAt':
      return entry.modifiedAt;
    case 'size':
      return entry.size;
    case 'wordCount':
      return entry.wordCount;
    case 'hash':
      return entry.hash;
    case 'tags':
      return entry.tags;
    case 'backlinks':
      return graph.backlinks(entry.path).length;
    case 'outgoing':
      return graph.outgoing(entry.path).filter((rl) => rl.resolution.status === 'resolved').length;
    case 'backlinkPaths':
      return [...new Set(graph.backlinks(entry.path).map((b) => b.source))].sort();
    case 'outgoingPaths':
      return resolvedOutgoingPaths(entry, graph);
    default:
      return undefined;
  }
}

/**
 * Typed comparison per the design spec: both numbers compare numerically, both ISO date/datetime
 * strings compare chronologically, otherwise both sides are compared as case-insensitive strings.
 * This last branch is also the deliberate fallback for mixed types (e.g. a numeric field against a
 * string query value) — never a hard error, always a total order.
 */
function typedCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (isIsoDateString(a) && isIsoDateString(b)) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  }
  const as = (typeof a === 'string' ? a : String(a)).toLowerCase();
  const bs = (typeof b === 'string' ? b : String(b)).toLowerCase();
  return as === bs ? 0 : as < bs ? -1 : 1;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** The query side of an eq / in, prepared once per condition rather than once per note: over
 *  40,000 notes and fifty values, parsing both sides at every comparison cost five times the
 *  plain comparison. */
interface Wanted {
  value: unknown;
  key: LinkKey | null;
}

function wanted(value: unknown): Wanted {
  return { value, key: linkKey(value) };
}

/** One field element against the prepared query values. The element is parsed as a link at most
 *  once, and only when a link is in play: its text starts one, or a query value is one. */
function elementMatches(fieldEl: unknown, ws: Wanted[], anyLinkWanted: boolean): boolean {
  for (const w of ws) if (typedCompare(fieldEl, w.value) === 0) return true;
  const fieldMayBeLink = typeof fieldEl === 'string' && fieldEl.trimStart().startsWith('[[');
  if (!fieldMayBeLink && !anyLinkWanted) return false;
  const key = linkKey(fieldEl);
  return key !== null && ws.some((w) => sameLinkKey(key, w.key));
}

function matchesEq(fieldVal: unknown, w: Wanted): boolean {
  // A missing field equals nothing (not even the text "undefined"); "exists: false" finds it.
  if (fieldVal === undefined) return false;
  // A null field equals null and nothing else (not the text "null").
  if (fieldVal === null || w.value === null) return fieldVal === w.value;
  const link = w.key?.isLink === true;
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => elementMatches(el, [w], link));
  return elementMatches(fieldVal, [w], link);
}

/** Membership check for the "in" op. `value` is guaranteed to be an array by compileCond's
 *  up-front check before this ever runs — see the comment there. */
function matchesIn(fieldVal: unknown, ws: Wanted[], anyLink: boolean): boolean {
  if (fieldVal === undefined) return false;
  if (fieldVal === null) return ws.some((w) => w.value === null);
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => elementMatches(el, ws, anyLink));
  return elementMatches(fieldVal, ws, anyLink);
}

function matchesOneContains(fieldVal: unknown, needleValue: unknown): boolean {
  if (fieldVal === undefined || fieldVal === null) return false; // a missing field contains nothing
  const needle = String(needleValue).toLowerCase();
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => String(el).toLowerCase().includes(needle));
  return String(fieldVal).toLowerCase().includes(needle);
}

/** `value` may be a single needle or (validated up front by compileCond) an array of up to
 *  MAX_CONTAINS_NEEDLES needles — "any of" them matching is a match, so checking a list field
 *  against many candidate values takes one query instead of one per candidate. */
function matchesContains(fieldVal: unknown, value: unknown): boolean {
  const needles = Array.isArray(value) ? value : [value];
  return needles.some((needle) => matchesOneContains(fieldVal, needle));
}

function matchesOneStartsWith(fieldVal: unknown, prefixValue: unknown): boolean {
  if (fieldVal === undefined || fieldVal === null) return false;
  const prefix = String(prefixValue).toLowerCase();
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => String(el).toLowerCase().startsWith(prefix));
  return String(fieldVal).toLowerCase().startsWith(prefix);
}

/** Same "any of" array-value semantics as matchesContains. */
function matchesStartsWith(fieldVal: unknown, value: unknown): boolean {
  const prefixes = Array.isArray(value) ? value : [value];
  return prefixes.some((prefix) => matchesOneStartsWith(fieldVal, prefix));
}

function matchesExists(fieldVal: unknown, value: unknown): boolean {
  const wantExists = value !== false;
  return wantExists ? fieldVal !== undefined : fieldVal === undefined;
}

/** True when the field is present and not "empty": not null/undefined, not "" and not []. Unlike
 *  "exists", which is true for an empty list or string, this is the op for "is there actually
 *  something here". */
function matchesNonEmpty(fieldVal: unknown): boolean {
  if (fieldVal === undefined || fieldVal === null) return false;
  if (typeof fieldVal === 'string') return fieldVal !== '';
  if (Array.isArray(fieldVal)) return fieldVal.length > 0;
  return true;
}

function matchesOrder(fieldVal: unknown, value: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  if (fieldVal === undefined) return false;
  const cmp = typedCompare(fieldVal, value);
  switch (op) {
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
    default:
      return false;
  }
}

/** Compiles the `regex` op's pattern with the linear-time, reduced-syntax matcher in
 *  `safe-regex.ts` — never a JavaScript `RegExp`, whose backtracking engine would let a pattern
 *  like `(a+)+` hang the event loop for every scanned note. Full-match semantics, per the design
 *  spec's "regex is anchored to the value". */
function compileSafeRegex(value: unknown): SafeMatcher {
  return compileSafePattern(String(value));
}

/** Validates a "contains"/"startsWith" array value up front: 1–MAX_CONTAINS_NEEDLES needles,
 *  each a string or number (the same types a scalar `value` is ever meaningfully compared as). */
function validateNeedleArray(op: 'contains' | 'startsWith', value: unknown[]): void {
  if (value.length === 0 || value.length > MAX_CONTAINS_NEEDLES) {
    throw new VaultError(
      'INVALID_INPUT',
      `"${op}" with an array value needs 1–${MAX_CONTAINS_NEEDLES} needles (got ${value.length}).`,
    );
  }
  for (const needle of value) {
    if (typeof needle !== 'string' && typeof needle !== 'number') {
      throw new VaultError('INVALID_INPUT', `"${op}" array needles must be strings or numbers.`);
    }
    if (needle === '') {
      throw new VaultError('INVALID_INPUT', `"${op}" array needles must not be empty strings.`);
    }
  }
}

type CompiledCond = (entry: IndexEntry, graph: VaultGraph) => boolean;

/** Compiles one Cond into a predicate. Regex conditions are validated and built once, up front,
 *  so an invalid pattern or a malformed "in"/array "contains"/"startsWith" value throws
 *  immediately regardless of how many (or few) entries are scanned. */
function compileCond(cond: Cond): CompiledCond {
  if (cond.op === 'regex') {
    const matcher = compileSafeRegex(cond.value);
    return (entry, graph) => {
      const fv = fieldValue(entry, graph, cond.field);
      return fv !== undefined && fv !== null && matcher.test(String(fv));
    };
  }
  if (cond.op === 'in' && !Array.isArray(cond.value)) {
    throw new VaultError('INVALID_INPUT', '"in" requires an array value.');
  }
  if (cond.op === 'contains' || cond.op === 'startsWith') {
    if (Array.isArray(cond.value)) validateNeedleArray(cond.op, cond.value);
    else if (cond.value === '' || cond.value === undefined || cond.value === null) {
      throw new VaultError(
        'INVALID_INPUT',
        `"${cond.op}" needs a non-empty value; use "exists" or "nonEmpty" to test for presence.`,
      );
    }
  }
  const one = wanted(cond.value);
  const many = cond.op === 'in' ? (cond.value as unknown[]).map(wanted) : [];
  const anyLink = many.some((w) => w.key?.isLink === true);
  return (entry, graph) => {
    const fv = fieldValue(entry, graph, cond.field);
    switch (cond.op) {
      case 'eq':
        return matchesEq(fv, one);
      case 'neq':
        return !matchesEq(fv, one);
      case 'contains':
        return matchesContains(fv, cond.value);
      case 'startsWith':
        return matchesStartsWith(fv, cond.value);
      case 'exists':
        return matchesExists(fv, cond.value);
      case 'nonEmpty':
        return matchesNonEmpty(fv);
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return matchesOrder(fv, cond.value, cond.op);
      case 'in':
        return matchesIn(fv, many, anyLink);
      default:
        return false;
    }
  };
}

function matchesPathPrefix(path: string, prefix?: string): boolean {
  if (prefix === undefined || prefix === '') return true;
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(p);
}

/** A tag filter value matches an entry's tag either exactly or as an ancestor of a nested tag,
 *  case-insensitively — the shared rule in vault/tags.ts. */
function tagFilterMatches(entryTags: string[], filter: string): boolean {
  const f = filter.toLowerCase();
  return entryTags.some((t) => isTagOrDescendant(t.toLowerCase(), f));
}

function passesTagFilters(entryTags: string[], tags: Query['tags']): boolean {
  if (!tags) return true;
  if (tags.any && !tags.any.some((t) => tagFilterMatches(entryTags, t))) return false;
  if (tags.all && !tags.all.every((t) => tagFilterMatches(entryTags, t))) return false;
  if (tags.none?.some((t) => tagFilterMatches(entryTags, t))) return false;
  return true;
}

function buildRow(entry: IndexEntry, graph: VaultGraph, select?: string[]): QueryRow {
  const row: QueryRow = { path: entry.path };
  if (!select) return row;
  for (const field of select) {
    if (field === 'path') continue;
    // defined, not assigned: a selected `__proto__` column must stay a column
    Object.defineProperty(row, field, {
      value: fieldValue(entry, graph, field),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return row;
}

/** "path" plus the deduplicated, path-free selected fields, in the order given — the column list
 *  for "columns" format, and (implicitly) the key order buildRow would have produced. */
function selectedColumns(select?: string[]): string[] {
  const fields = select ? [...new Set(select.filter((f) => f !== 'path'))] : [];
  return ['path', ...fields];
}

/** `asked` is how many rows this call could have returned at most (`limit`, or every match). */
function budgetHint(kept: number, asked: number): string {
  return (
    `${kept} of the ${asked} rows asked for fit the ${MAX_QUERY_RESULT_CHARS}-character result ` +
    'budget: anything you add up over just "rows" is incomplete. For counts: countOnly with ' +
    'groupBy. For totals: sum. For the same rows in fewer characters: fewer select fields or ' +
    'format: "columns". For the rest: sort, then filter on the sort key past the last row returned.'
  );
}

/** Sums (and how many matches had a numeric value) for `fields`, over every entry in `entries` —
 *  never only a page of it. Only finite numbers count: a numeric string, a boolean, null and
 *  undefined are all excluded, so a field that is never numeric totals 0 rather than throwing or
 *  being left out. Built via Map -> Object.fromEntries, never `obj[field] =`, so a field literally
 *  named "__proto__" becomes an ordinary own key instead of silently reassigning the prototype
 *  (the same hazard `buildRow` guards against for selected columns). */
const SCALE = 2 ** -32;

/** A running total that is plain addition whenever plain addition can hold it, so the result is
 *  exactly what adding the values gives. Only when the plain total has gone non-finite is the
 *  scaled total used: every value times 2^-32 (a power of two, so exact except for subnormals),
 *  which cannot overflow below four thousand million addends, scaled back at the end. So
 *  1.7e308 three times and -1.7e308 twice is 1.7e308, not an overflow, while a total that truly
 *  does not fit a number still comes out non-finite and is reported as such. */
class Total {
  private plain = 0;
  private scaled = 0;
  add(v: number): void {
    this.plain += v;
    this.scaled += v * SCALE;
  }
  value(): number {
    return Number.isFinite(this.plain) ? this.plain : this.scaled / SCALE;
  }
}

/** Totals over every match. A total that stops being a finite number (two values of 1e308) is
 *  left out of `sums` and named in `overflowed`: JSON has no Infinity, and a result that fails
 *  its own schema answers nothing. `sumCounted` still says how many values there were. */
function computeSums(
  entries: IndexEntry[],
  graph: VaultGraph,
  fields: string[],
): { sums: Record<string, number>; sumCounted: Record<string, number>; overflowed: string[] } {
  const totals = new Map<string, Total>(fields.map((f) => [f, new Total()]));
  const counted = new Map<string, number>(fields.map((f) => [f, 0]));
  for (const entry of entries) {
    for (const field of fields) {
      const v = fieldValue(entry, graph, field);
      if (typeof v === 'number' && Number.isFinite(v)) {
        totals.get(field)?.add(v);
        counted.set(field, (counted.get(field) ?? 0) + 1);
      }
    }
  }
  const sums = new Map<string, number>(fields.map((f) => [f, totals.get(f)?.value() ?? 0]));
  const overflowed = fields.filter((f) => !Number.isFinite(sums.get(f) ?? 0));
  for (const f of overflowed) sums.delete(f);
  return {
    sums: Object.fromEntries(sums),
    sumCounted: Object.fromEntries(counted),
    overflowed,
  };
}

function overflowHint(top: string[], inGroups: string[]): string {
  const names = (fields: string[]) => fields.map((f) => `"${f}"`).join(', ');
  const said: string[] = [];
  if (top.length > 0) {
    said.push(`Adding up ${names(top)} overflowed what a number can hold; left out of "sums".`);
  }
  if (inGroups.length > 0) {
    said.push(
      `Adding up ${names(inGroups)} overflowed inside a group; left out of the "sums" of a group.`,
    );
  }
  return said.join(' ');
}

interface QueryPayload {
  rows: QueryRow[];
  columns?: string[];
  values?: unknown[][];
  truncated: boolean;
  hint?: string;
}

function buildRowsPayload(
  limited: IndexEntry[],
  graph: VaultGraph,
  select: string[] | undefined,
  budget: number,
): QueryPayload {
  const rows = limited.map((entry) => buildRow(entry, graph, select));
  const { kept, cut } = fitWithinBudget(rows, budget);
  if (!cut) return { rows, truncated: false };
  return { rows: kept, truncated: true, hint: budgetHint(kept.length, limited.length) };
}

function buildColumnsPayload(
  limited: IndexEntry[],
  graph: VaultGraph,
  select: string[] | undefined,
  budget: number,
): QueryPayload {
  const columns = selectedColumns(select);
  const fields = columns.slice(1);
  const values = limited.map((entry) => [
    entry.path,
    ...fields.map((f) => fieldValue(entry, graph, f)),
  ]);
  const { kept, cut } = fitWithinBudget(values, budget);
  if (!cut) return { rows: [], columns, values, truncated: false };
  return {
    rows: [],
    columns,
    values: kept,
    truncated: true,
    hint: budgetHint(kept.length, limited.length),
  };
}

function groupKeyForValue(v: unknown): string {
  return v === undefined ? NONE_GROUP_KEY : String(v);
}

/** One group per distinct value; an array field contributes one group per element (a note can
 *  land in several groups), and a missing/empty value groups under "(none)". With `sumFields`,
 *  every group also carries `sums`/`sumCounted` over only the matches that landed in it (an entry
 *  that lands in several groups contributes to each one's sums, same as it does to each count). */
function buildGroups(
  entries: IndexEntry[],
  graph: VaultGraph,
  field: string,
  sumFields: string[] = [],
): QueryGroup[] {
  const groups = new Map<
    string,
    { count: number; paths: string[]; sums: Map<string, Total>; sumCounted: Map<string, number> }
  >();
  for (const entry of entries) {
    const v = fieldValue(entry, graph, field);
    const arr = asArray(v);
    // An array field contributes one group per element; an empty array (e.g. an untagged note's
    // `tags`) groups under "(none)" just like a missing value — it must not fall through to
    // groupKeyForValue(v), which would stringify `[]` to `""` instead.
    let keys: string[];
    if (arr) keys = arr.length > 0 ? [...new Set(arr.map(groupKeyForValue))] : [NONE_GROUP_KEY];
    else keys = [groupKeyForValue(v)];
    // Computed once per entry, reused for every group it lands in.
    const contributions = sumFields.map((f) => {
      const fv = fieldValue(entry, graph, f);
      return typeof fv === 'number' && Number.isFinite(fv) ? fv : undefined;
    });
    for (const key of keys) {
      let g = groups.get(key);
      if (!g) {
        g = {
          count: 0,
          paths: [],
          sums: new Map(sumFields.map((f) => [f, new Total()])),
          sumCounted: new Map(sumFields.map((f) => [f, 0])),
        };
        groups.set(key, g);
      }
      g.count += 1;
      if (g.paths.length < MAX_GROUP_PATHS) g.paths.push(entry.path);
      sumFields.forEach((f, i) => {
        const val = contributions[i];
        if (val !== undefined) {
          g.sums.get(f)?.add(val);
          g.sumCounted.set(f, (g.sumCounted.get(f) ?? 0) + 1);
        }
      });
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      count: g.count,
      paths: g.paths,
      ...(sumFields.length > 0
        ? {
            // a total that is no longer a finite number is left out, as at the top level
            sums: Object.fromEntries(
              [...g.sums]
                .map(([f, t]): [string, number] => [f, t.value()])
                .filter(([, v]) => Number.isFinite(v)),
            ),
            sumCounted: Object.fromEntries(g.sumCounted),
          }
        : {}),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** With groupPrefix: only the group keys that start with it. */
function applyGroupPrefix(groups: QueryGroup[], prefix?: string): QueryGroup[] {
  return prefix === undefined ? groups : groups.filter((g) => g.key.startsWith(prefix));
}

/** Sort comparator for one sort key; a missing value always sorts before any present value,
 *  regardless of asc/desc (only the relative order of two present values flips). */
function compareBySortKey(
  a: IndexEntry,
  b: IndexEntry,
  graph: VaultGraph,
  field: string,
  order: 'asc' | 'desc',
): number {
  const av = fieldValue(a, graph, field);
  const bv = fieldValue(b, graph, field);
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return -1;
  if (bv === undefined) return 1;
  const cmp = typedCompare(av, bv);
  return order === 'desc' ? -cmp : cmp;
}

/** Evaluates a Bases-style Query against the in-memory index. Pure and synchronous: no disk
 *  reads, no I/O. `limit` is always clamped to [0, MAX_QUERY_ROWS] as a safety net even when a
 *  caller bypasses the tool-layer Zod validation (e.g. vault_recent building its own Query). */
/**
 * The entries that pass `pathPrefix`, `tags` and `where`, sorted by `sort`: every match, with no
 * row limit and no character budget. `evaluateQuery` presents a page of this; a caller that
 * needs the complete set (vault_search narrowing its candidates) must use this, never the rows
 * of a presented result.
 */
export function matchEntries(
  entries: Iterable<IndexEntry>,
  graph: VaultGraph,
  q: Pick<Query, 'where' | 'tags' | 'pathPrefix' | 'sort'>,
): IndexEntry[] {
  const compiledWhere = (q.where ?? []).map(compileCond);

  let matched = [...entries].filter(
    (entry) =>
      matchesPathPrefix(entry.path, q.pathPrefix) &&
      passesTagFilters(entry.tags, q.tags) &&
      compiledWhere.every((fn) => fn(entry, graph)),
  );

  if (q.sort && q.sort.length > 0) {
    const sortKeys = q.sort;
    matched = [...matched].sort((a, b) => {
      for (const { field, order } of sortKeys) {
        const cmp = compareBySortKey(a, b, graph, field, order);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }
  return matched;
}

export function evaluateQuery(
  entries: Iterable<IndexEntry>,
  graph: VaultGraph,
  q: Query,
): QueryResult {
  if (q.groupPrefix !== undefined && q.groupBy === undefined) {
    throw new VaultError('INVALID_INPUT', '"groupPrefix" requires "groupBy".');
  }
  const matched = matchEntries(entries, graph, q);

  const total = matched.length;
  const limit = Math.min(Math.max(q.limit ?? 100, 0), MAX_QUERY_ROWS);
  const limitTruncated = total > limit;
  const limited = limitTruncated ? matched.slice(0, limit) : matched;
  const sumFields = [...new Set(q.sum ?? [])]; // a name listed twice is one total, not two
  // Over EVERY match, never only the rows a result can carry — the whole reason "sum" exists.
  const summed = sumFields.length === 0 ? undefined : computeSums(matched, graph, sumFields);

  // One budget for the whole result: the groups take what they need first (at most half when rows
  // are wanted too), the rows get the rest. Two independent budgets would add up to twice what a
  // client accepts.
  const room = Math.max(MAX_QUERY_RESULT_CHARS - wrapperChars(q, total), 0);
  const groupsBudget = q.countOnly ? room : Math.floor(room / 2);
  const allGroups =
    q.groupBy === undefined
      ? []
      : applyGroupPrefix(buildGroups(matched, graph, q.groupBy, sumFields), q.groupPrefix);
  // A group total can overflow while the overall one does not (and the other way round).
  const groupOverflowed = sumFields.filter((f) =>
    allGroups.some((g) => (g.sumCounted?.[f] ?? 0) > 0 && g.sums !== undefined && !(f in g.sums)),
  );
  const sumHint = (): string | undefined => {
    const top = summed?.overflowed ?? [];
    return top.length + groupOverflowed.length === 0
      ? undefined
      : overflowHint(top, groupOverflowed);
  };
  const fitted =
    q.groupBy === undefined
      ? undefined
      : fitGroups(allGroups, groupsBudget, q.countOnly === true, total);

  if (q.countOnly) {
    const counted: QueryResult = { rows: [], total, truncated: false };
    if (fitted) {
      counted.groups = fitted.groups;
      counted.truncated = fitted.cut;
      if (fitted.hint) counted.hint = fitted.hint;
    }
    if (summed) {
      counted.sums = summed.sums;
      counted.sumCounted = summed.sumCounted;
      const said = sumHint();
      if (said) counted.hint = joinHints(counted.hint, said);
    }
    return withGroupsHint(counted, fitted?.overlapping ?? false);
  }

  const rowsBudget = room - (fitted ? JSON.stringify(fitted.groups).length : 0);
  const payload =
    q.format === 'columns'
      ? buildColumnsPayload(limited, graph, q.select, rowsBudget)
      : buildRowsPayload(limited, graph, q.select, rowsBudget);

  const result: QueryResult = {
    rows: payload.rows,
    total,
    truncated: limitTruncated || payload.truncated || (fitted?.cut ?? false),
  };
  if (payload.columns) result.columns = payload.columns;
  if (payload.values) result.values = payload.values;
  if (payload.hint) {
    // With groups in the result the rows had less room: say so, or the advice cannot help.
    result.hint = fitted
      ? `${payload.hint} ${groupsTookHint(JSON.stringify(fitted.groups).length)}`
      : payload.hint;
  }
  if (fitted) {
    result.groups = fitted.groups;
    if (fitted.hint) result.hint = joinHints(result.hint, fitted.hint);
  }
  if (summed) {
    result.sums = summed.sums;
    result.sumCounted = summed.sumCounted;
    const said = sumHint();
    if (said) result.hint = joinHints(result.hint, said);
  }
  return withGroupsHint(result, fitted?.overlapping ?? false);
}

function groupsTookHint(chars: number): string {
  return `The groups took ${chars} characters of it: drop groupBy, or ask for the counts alone with countOnly.`;
}

function groupsShownHint(shown: number, all: number): string {
  return `${shown} of ${all} groups shown, the largest ones; filter with "where" to see the others.`;
}

/**
 * What the result costs besides its rows and groups: the keys, `total`, the column names, and
 * the longest hint this call could carry. Measured, not reserved: a caller may select fifty
 * long field names, and the hints together run to several hundred characters. When "sum" is
 * given, `sums`/`sumCounted` are weighed too, at the widest a finite JS number can serialize to
 * (`-Number.MAX_VALUE`'s exponential form) for the total and `Number.MAX_SAFE_INTEGER` for the
 * count — real sums are always finite (non-finite values are excluded from the sum itself) so
 * neither is ever wider than this.
 */
function wrapperChars(q: Query, total: number): number {
  const widest = Number.MAX_SAFE_INTEGER;
  const hint = [
    budgetHint(widest, widest),
    groupsTookHint(widest),
    GROUP_PATHS_DROPPED_HINT,
    groupsShownHint(widest, widest),
    OVERLAPPING_GROUPS_HINT,
    ...((q.sum ?? []).length === 0
      ? []
      : [overflowHint([...new Set(q.sum ?? [])], [...new Set(q.sum ?? [])])]),
  ].join(' ');
  const sumFields = [...new Set(q.sum ?? [])];
  const sumsPlaceholder =
    sumFields.length === 0
      ? {}
      : {
          sums: Object.fromEntries(sumFields.map((f) => [f, -Number.MAX_VALUE])),
          sumCounted: Object.fromEntries(sumFields.map((f) => [f, widest])),
        };
  return JSON.stringify({
    rows: [],
    total,
    truncated: true,
    ...(q.format === 'columns' ? { columns: selectedColumns(q.select), values: [] } : {}),
    ...(q.groupBy === undefined ? {} : { groups: [] }),
    ...sumsPlaceholder,
    hint,
  }).length;
}

/**
 * Groups within `budget` characters. The counts are the answer and the example paths a
 * convenience, so the paths go first; if thousands of keys still do not fit, the largest groups
 * are kept (in key order, like the full list) and the hint says how many were left out.
 * `overlapping` is decided on the full list, before anything is dropped.
 */
function fitGroups(
  all: QueryGroup[],
  budget: number,
  countsOnly: boolean,
  total: number,
): { groups: QueryGroup[]; hint?: string; overlapping: boolean; cut: boolean } {
  // A note with several values sits in several groups: only then do the counts exceed the total.
  const overlapping = all.reduce((n, g) => n + g.count, 0) > total;
  let groups = countsOnly ? all.map((g) => ({ ...g, paths: [] })) : all;
  let hint: string | undefined;
  let cut = false; // a group was left out (dropping example paths loses no count)
  if (JSON.stringify(groups).length > budget) {
    if (!countsOnly) hint = GROUP_PATHS_DROPPED_HINT;
    groups = groups.map((g) => ({ ...g, paths: [] }));
  }
  if (JSON.stringify(groups).length > budget) {
    const bySize = [...groups].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
    const { kept } = fitWithinBudget(bySize, budget);
    const keep = new Set(kept.map((g) => g.key));
    const shown = groups.filter((g) => keep.has(g.key));
    hint = joinHints(hint, groupsShownHint(shown.length, groups.length));
    groups = shown;
    cut = true;
  }
  return { groups, ...(hint ? { hint } : {}), overlapping, cut };
}

function withGroupsHint(result: QueryResult, overlapping: boolean): QueryResult {
  if (!overlapping) return result;
  return { ...result, hint: joinHints(result.hint, OVERLAPPING_GROUPS_HINT) };
}
