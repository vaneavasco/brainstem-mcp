import { z } from 'zod';
import { MAX_PATH_ARG_CHARS, MAX_QUERY_FIELD_CHARS } from '../storage/limits.ts';
import type { Cond, Query } from '../vault/query.ts';

/**
 * Shared Zod input-schema fragments for the vault tools.
 *
 * This module is a **leaf**: it imports only Zod and types from pure vault modules — never a
 * tool module. Tool modules read these at *module scope* (inside `z.strictObject({...})` literals), so
 * they must be fully initialized by the time any tool module is evaluated. When they lived in
 * `register.ts` — which imports every tool module, and is imported back by `tx.ts` for
 * `ToolContext`/`touch` — a module-scope read hit the import cycle's temporal dead zone and
 * silently produced `undefined`, forcing `tx.ts` to build its schema lazily inside the register
 * call. Keeping them here removes that hazard for every importer;
 * `.github/workflows/ci.yml` boots `register.ts` under plain Node as the guard.
 */

/** Frontmatter keys to set. A plain `z.record` drops a `__proto__` key without a word, so the
 *  write would report success having done less than it was asked; here that key is an error. */
export const FrontmatterSetArg = z.preprocess(
  (value, ctx) => {
    if (typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')) {
      ctx.addIssue({ code: 'custom', message: 'a frontmatter key cannot be named "__proto__"' });
      return z.NEVER;
    }
    return value;
  },
  z.record(z.string(), z.unknown()),
);

/** Vault-relative path. Wording only — validation happens in `normalizeVaultPath` at call time. */
export const PathArg = z
  .string()
  .max(MAX_PATH_ARG_CHARS)
  .describe('Vault-relative path, e.g. "00-inbox/idea.md".');

/** The same string argument, spelling out the path rules; used by the read/graph tools. */
export const DetailedPathArg = z
  .string()
  .max(MAX_PATH_ARG_CHARS)
  .describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

/** The `where` operator set shared by vault_query and vault_search. */
export const QueryOpSchema = z
  .enum([
    'eq',
    'neq',
    'contains',
    'startsWith',
    'exists',
    'nonEmpty',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'regex',
  ])
  .describe(
    'Comparison operator. "contains"/"startsWith" also accept an array value: true when any ' +
      'needle matches (max 50). "exists" is true for an empty list/string too; "nonEmpty" also ' +
      'requires a non-null, non-"", non-[] value. "regex" is a FULL match — the pattern is ' +
      'implicitly anchored to the whole value — over a reduced, linear-time syntax: literals, ' +
      '".", "[classes]", "* + ? {m} {m,} {m,n}" (counts <= 100), "|" and "(...)". No "^"/"$", ' +
      'backreferences, lookarounds or named groups; max 200 characters.',
  );

/** One `where` condition, shared by vault_query and vault_search (typed against the pure
 *  `Cond` interface so schema and engine cannot drift). */
export const CondSchema: z.ZodType<Cond> = z.strictObject({
  field: z.string().min(1).max(MAX_QUERY_FIELD_CHARS),
  op: QueryOpSchema,
  value: z.unknown().optional(),
});

/** The nested-aware tags filter (any/all/none), shared by vault_query and vault_search. */
export const TagsFilterSchema: z.ZodType<NonNullable<Query['tags']>> = z.strictObject({
  any: z.array(z.string()).optional(),
  all: z.array(z.string()).optional(),
  none: z.array(z.string()).optional(),
});

/** Shared input schema fragment for every tool that supports optimistic concurrency. */
export const ExpectedHashArg = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase 64-character hex sha256 hash')
  .optional()
  .describe(
    'sha256 content hash (lowercase hex) from a previous read or write of this file. If the ' +
      'file changed since, the call fails with CONFLICT instead of overwriting silently — ' +
      're-read and retry.',
  );
