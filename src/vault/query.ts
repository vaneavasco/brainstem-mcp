import { MAX_QUERY_ROWS } from '../storage/limits.ts';
import { baseName, parentDir } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import type { IndexEntry } from './frontmatter-index.ts';
import type { VaultGraph } from './graph.ts';
import { compileSafePattern, type SafeMatcher } from './safe-regex.ts';
import { isTagOrDescendant } from './tags.ts';

export type Op =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'exists'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'regex';

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
  groupBy?: string;
}

export interface QueryRow {
  path: string;
  [field: string]: unknown;
}

export interface QueryResult {
  rows: QueryRow[];
  total: number;
  truncated: boolean;
  groups?: { key: string; count: number; paths: string[] }[];
}

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

/** Dot-path traversal over frontmatter, mirroring FrontmatterIndex's private getPath(). */
function getFrontmatterPath(obj: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = obj;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
  if (!VIRTUAL_FIELDS.has(field)) return getFrontmatterPath(entry.frontmatter, field);
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

function matchesEq(fieldVal: unknown, value: unknown): boolean {
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => typedCompare(el, value) === 0);
  return typedCompare(fieldVal, value) === 0;
}

/** Membership check for the "in" op. `value` is guaranteed to be an array by compileCond's
 *  up-front check before this ever runs — see the comment there. */
function matchesIn(fieldVal: unknown, value: unknown[]): boolean {
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => value.some((v) => typedCompare(el, v) === 0));
  return value.some((v) => typedCompare(fieldVal, v) === 0);
}

function matchesContains(fieldVal: unknown, value: unknown): boolean {
  const needle = String(value).toLowerCase();
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => String(el).toLowerCase().includes(needle));
  return String(fieldVal).toLowerCase().includes(needle);
}

function matchesStartsWith(fieldVal: unknown, value: unknown): boolean {
  const prefix = String(value).toLowerCase();
  const arr = asArray(fieldVal);
  if (arr) return arr.some((el) => String(el).toLowerCase().startsWith(prefix));
  return String(fieldVal).toLowerCase().startsWith(prefix);
}

function matchesExists(fieldVal: unknown, value: unknown): boolean {
  const wantExists = value !== false;
  return wantExists ? fieldVal !== undefined : fieldVal === undefined;
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

type CompiledCond = (entry: IndexEntry, graph: VaultGraph) => boolean;

/** Compiles one Cond into a predicate. Regex conditions are validated and built once, up front,
 *  so an invalid pattern or a malformed "in" value throws immediately regardless of how many (or
 *  few) entries are scanned. */
function compileCond(cond: Cond): CompiledCond {
  if (cond.op === 'regex') {
    const matcher = compileSafeRegex(cond.value);
    return (entry, graph) => matcher.test(String(fieldValue(entry, graph, cond.field)));
  }
  if (cond.op === 'in' && !Array.isArray(cond.value)) {
    throw new VaultError('INVALID_INPUT', '"in" requires an array value.');
  }
  return (entry, graph) => {
    const fv = fieldValue(entry, graph, cond.field);
    switch (cond.op) {
      case 'eq':
        return matchesEq(fv, cond.value);
      case 'neq':
        return !matchesEq(fv, cond.value);
      case 'contains':
        return matchesContains(fv, cond.value);
      case 'startsWith':
        return matchesStartsWith(fv, cond.value);
      case 'exists':
        return matchesExists(fv, cond.value);
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return matchesOrder(fv, cond.value, cond.op);
      case 'in':
        return matchesIn(fv, cond.value as unknown[]);
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
    row[field] = fieldValue(entry, graph, field);
  }
  return row;
}

function groupKeyForValue(v: unknown): string {
  return v === undefined ? NONE_GROUP_KEY : String(v);
}

/** One group per distinct value; an array field contributes one group per element (a note can
 *  land in several groups), and a missing/empty value groups under "(none)". */
function buildGroups(
  entries: IndexEntry[],
  graph: VaultGraph,
  field: string,
): { key: string; count: number; paths: string[] }[] {
  const groups = new Map<string, { count: number; paths: string[] }>();
  for (const entry of entries) {
    const v = fieldValue(entry, graph, field);
    const arr = asArray(v);
    // An array field contributes one group per element; an empty array (e.g. an untagged note's
    // `tags`) groups under "(none)" just like a missing value — it must not fall through to
    // groupKeyForValue(v), which would stringify `[]` to `""` instead.
    let keys: string[];
    if (arr) keys = arr.length > 0 ? [...new Set(arr.map(groupKeyForValue))] : [NONE_GROUP_KEY];
    else keys = [groupKeyForValue(v)];
    for (const key of keys) {
      let g = groups.get(key);
      if (!g) {
        g = { count: 0, paths: [] };
        groups.set(key, g);
      }
      g.count += 1;
      if (g.paths.length < MAX_GROUP_PATHS) g.paths.push(entry.path);
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, count: g.count, paths: g.paths }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
export function evaluateQuery(
  entries: Iterable<IndexEntry>,
  graph: VaultGraph,
  q: Query,
): QueryResult {
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

  const total = matched.length;
  const limit = Math.min(Math.max(q.limit ?? 100, 0), MAX_QUERY_ROWS);
  const truncated = total > limit;
  const limited = truncated ? matched.slice(0, limit) : matched;

  const result: QueryResult = {
    rows: limited.map((entry) => buildRow(entry, graph, q.select)),
    total,
    truncated,
  };
  if (q.groupBy !== undefined) result.groups = buildGroups(matched, graph, q.groupBy);
  return result;
}
