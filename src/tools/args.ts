import { z } from 'zod';
import type { Cond, Query } from '../vault/query.ts';

/**
 * Shared Zod input-schema fragments for the vault tools.
 *
 * This module is a **leaf**: it imports only Zod and types from pure vault modules — never a
 * tool module. Tool modules read these at *module scope* (inside `z.object({...})` literals), so
 * they must be fully initialized by the time any tool module is evaluated. When they lived in
 * `register.ts` — which imports every tool module, and is imported back by `tx.ts` for
 * `ToolContext`/`touch` — a module-scope read hit the import cycle's temporal dead zone and
 * silently produced `undefined`, forcing `tx.ts` to build its schema lazily inside the register
 * call. Keeping them here removes that hazard for every importer;
 * `.github/workflows/ci.yml` boots `register.ts` under plain Node as the guard.
 */

/** Vault-relative path. Wording only — validation happens in `normalizeVaultPath` at call time. */
export const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

/** The same string argument, spelling out the path rules; used by the read/graph tools. */
export const DetailedPathArg = z
  .string()
  .describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

/** The `where` operator set shared by vault_query and vault_search. */
export const QueryOpSchema = z
  .enum(['eq', 'neq', 'contains', 'startsWith', 'exists', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'])
  .describe(
    'Comparison operator. "regex" is a FULL match — the pattern is implicitly anchored to the ' +
      'whole value — over a reduced, linear-time syntax: literals, ".", "[classes]", "* + ? ' +
      '{m} {m,} {m,n}" (counts <= 100), "|" and "(...)". No "^"/"$", backreferences, ' +
      'lookarounds or named groups; max 200 characters.',
  );

/** One `where` condition, shared by vault_query and vault_search (typed against the pure
 *  `Cond` interface so schema and engine cannot drift). */
export const CondSchema: z.ZodType<Cond> = z.object({
  field: z.string().min(1),
  op: QueryOpSchema,
  value: z.unknown().optional(),
});

/** The nested-aware tags filter (any/all/none), shared by vault_query and vault_search. */
export const TagsFilterSchema: z.ZodType<NonNullable<Query['tags']>> = z.object({
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
