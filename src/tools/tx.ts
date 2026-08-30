import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MAX_TX_FILES,
  MAX_TX_OPS,
  runTransaction,
  type TxOp,
  type TxResult,
} from '../storage/transaction.ts';
import { OVERWRITE } from './annotations.ts';
import { ExpectedHashArg, PathArg } from './args.ts';
import { type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

/** Built at module scope: the shared argument fragments live in the leaf module `args.ts`, which
 *  is fully initialized before any tool module runs (see the note there). */
const TxOpSchema: z.ZodType<TxOp> = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('write'),
    path: PathArg,
    content: z.string(),
    mergeFrontmatter: z.boolean().optional(),
    expectedHash: ExpectedHashArg,
  }),
  z.object({
    op: z.literal('edit'),
    path: PathArg,
    patches: z
      .array(z.object({ find: z.string().min(1), replace: z.string() }))
      .min(1)
      .max(50),
    expectedHash: ExpectedHashArg,
  }),
  z.object({
    op: z.literal('append'),
    path: PathArg,
    content: z.string().min(1),
    expectedHash: ExpectedHashArg,
  }),
  z.object({
    op: z.literal('frontmatter_update'),
    path: PathArg,
    set: z.record(z.string(), z.unknown()).optional(),
    unset: z.array(z.string()).optional(),
    expectedHash: ExpectedHashArg,
  }),
  z.object({
    op: z.literal('move'),
    from: PathArg,
    to: PathArg,
    expectedHash: ExpectedHashArg,
  }),
  z.object({
    op: z.literal('delete'),
    path: PathArg,
    confirm: z.boolean(),
    expectedHash: ExpectedHashArg,
  }),
]);

const OpResultSchema = z.object({
  index: z.number(),
  op: z.enum(['write', 'edit', 'append', 'frontmatter_update', 'move', 'delete']),
  ok: z.boolean(),
  error: z.string().optional(),
  diff: z.string().optional(),
  hash: z.string().optional(),
});

/** The first op that actually failed; the ones after it are only marked "not attempted". */
function failure(result: TxResult): { index: number; op: string; error: string } | null {
  const hit = result.results.find((r) => !r.ok && r.error !== undefined);
  return hit === undefined ? null : { index: hit.index, op: hit.op, error: hit.error ?? 'failed' };
}

/** A dry run only "succeeds" when every op passed pre-flight; a failed one is still a failure. */
function isClean(result: TxResult): boolean {
  return result.results.every((r) => r.ok);
}

function summarize(result: TxResult): string {
  const failed = failure(result);
  if (result.applied) {
    return `Transaction ${result.id}: applied ${result.results.length} op(s) across ${result.touched.length} file(s).`;
  }
  if (result.dryRun && isClean(result)) {
    const diffs = result.results
      .map((r) => r.diff)
      .filter((d): d is string => d !== undefined && d !== '')
      .join('\n');
    return `Dry run of transaction ${result.id}: ${result.results.length} op(s) would apply, nothing was written.\n${diffs}`;
  }
  const where =
    failed === null ? '' : ` at op #${failed.index + 1} (${failed.op}): ${failed.error}`;
  if (result.journal !== undefined && !result.rolledBack) {
    return `IO: transaction ${result.id} failed${where}\nThe rollback did not finish. The original files are kept as pre-images in ${result.journal} — restore them by hand; nothing else will touch that folder.`;
  }
  if (result.rolledBack) {
    return `Transaction ${result.id} failed${where}\nEvery change was rolled back; a copy of any deleted note may remain in .trash/.`;
  }
  const problems = result.results
    .filter((r) => !r.ok && r.error !== undefined)
    .map((r) => `op #${r.index + 1} (${r.op}): ${r.error}`)
    .join('\n');
  return `Transaction ${result.id} was not applied — it failed pre-flight:\n${problems}\nNothing was written.`;
}

export function registerTxTools(server: McpServer, tc: ToolContext): void {
  server.registerTool(
    'vault_transaction',
    {
      title: 'Run several writes as one transaction',
      description: `Apply up to ${MAX_TX_OPS} write/edit/append/frontmatter_update/move/delete ops to at most ${MAX_TX_FILES} files as one all-or-nothing unit. Every op is checked first (hashes, patches, move destinations); if any check fails nothing is written. If a write fails half-way, every touched file is restored from a journalled copy. Ops on the same path compose in order. Use dryRun=true to see the diffs first.`,
      inputSchema: z.object({
        // No Zod .min/.max here on purpose: both caps are enforced inside runTransaction so a
        // violation comes back as INVALID_INPUT like every other vault error, instead of the
        // SDK's generic "Input validation error".
        ops: z.array(TxOpSchema).describe(`Ordered operations, 1 to ${MAX_TX_OPS} of them.`),
        dryRun: z.boolean().optional().describe('Validate and return diffs without writing.'),
      }),
      outputSchema: z.object({
        id: z.string(),
        applied: z.boolean(),
        dryRun: z.boolean(),
        rolledBack: z.boolean(),
        results: z.array(OpResultSchema),
        touched: z.array(z.string()),
        journal: z.string().optional(),
      }),
      annotations: OVERWRITE,
    },
    ({ ops, dryRun }) =>
      guarded(tc.log, async (): Promise<CallToolResult> => {
        const { adapter, gate, paths, now } = tc.runtime;
        const result = await runTransaction(
          { adapter, gate, vaultRoot: paths.vaultRoot, stateDir: paths.stateDir, now },
          ops,
          { dryRun: dryRun ?? false },
        );
        // The index is refreshed for every touched path once, after the lock is released —
        // including after a rollback, where the files changed and changed back.
        if (result.applied || result.rolledBack || result.journal !== undefined) {
          await touch(tc, ...result.touched);
        }
        const text = summarize(result);
        if (result.applied || (result.dryRun && isClean(result))) {
          return okJson({ ...result }, text);
        }
        return {
          isError: true,
          content: [{ type: 'text', text }],
          structuredContent: { ...result },
        };
      }),
  );
}
