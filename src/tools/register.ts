import type { McpServer } from '@modelcontextprotocol/server';
import type { Note } from '../storage/types.ts';
import type { VaultRuntime } from '../vault/runtime.ts';
import { registerAnalyticsTools } from './analytics.ts';
import { registerCanvasTools } from './canvas.ts';
import { registerDailyTools } from './daily.ts';
import { registerGraphTools } from './graph.ts';
import { registerManageTools } from './manage.ts';
import { registerQueryTools } from './query.ts';
import { registerReadTools } from './read.ts';
import { registerSearchTools } from './search.ts';
import { registerTemplateTools } from './template.ts';
import { registerTxTools } from './tx.ts';
import { registerWriteTools } from './write.ts';

export interface ToolContext {
  runtime: VaultRuntime;
  log: (e: unknown) => void;
}

/** Re-reads `paths` into the index. Markdown-only (refreshPath skips anything else) — a mutation
 *  that already holds the post-write Note should call `applyNote` instead (no disk read), and
 *  non-markdown mutations apply the returned Note or `index.addAsset` at the call site. */
export async function touch(tc: ToolContext, ...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => tc.runtime.index.refreshPath(tc.runtime.adapter, p)));
}

/** Applies an already-in-hand post-write Note to the index — the no-disk-read sibling of touch(). */
export function applyNote(tc: ToolContext, note: Note): void {
  tc.runtime.index.applyNote(note);
}

/** Runs `fn` inside the runtime's WriteGate, holding all `paths` for the duration of the call. */
export function locked<T>(tc: ToolContext, paths: string[], fn: () => Promise<T>): Promise<T> {
  return tc.runtime.gate.withLock(paths, fn);
}

/** Re-exported for compatibility: the shared argument fragments now live in the leaf module
 *  `args.ts`, so a tool module can read them at module scope without touching this file (and its
 *  import cycle). New code should import them from `./args.ts` directly. */
export { DetailedPathArg, ExpectedHashArg, PathArg } from './args.ts';

export function registerVaultTools(server: McpServer, tc: ToolContext): void {
  registerReadTools(server, tc);
  registerWriteTools(server, tc);
  registerSearchTools(server, tc);
  registerManageTools(server, tc);
  registerCanvasTools(server, tc);
  registerDailyTools(server, tc);
  registerAnalyticsTools(server, tc);
  registerGraphTools(server, tc);
  registerQueryTools(server, tc);
  registerTxTools(server, tc);
  registerTemplateTools(server, tc);
}
