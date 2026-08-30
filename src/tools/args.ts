import { z } from 'zod';

/**
 * Shared Zod input-schema fragments for the vault tools.
 *
 * This module is a **leaf**: it imports nothing but Zod. Tool modules read these at *module
 * scope* (inside `z.object({...})` literals), so they must be fully initialized by the time any
 * tool module is evaluated. When they lived in `register.ts` — which imports every tool module,
 * and is imported back by `tx.ts` for `ToolContext`/`touch` — a module-scope read hit the import
 * cycle's temporal dead zone and silently produced `undefined`, forcing `tx.ts` to build its
 * schema lazily inside the register call. Keeping them here removes that hazard for every
 * importer; `.github/workflows/ci.yml` boots `register.ts` under plain Node as the guard.
 */

/** Vault-relative path. Wording only — validation happens in `normalizeVaultPath` at call time. */
export const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

/** The same string argument, spelling out the path rules; used by the read/graph tools. */
export const DetailedPathArg = z
  .string()
  .describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

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
