import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { VaultRuntime } from '../vault/runtime.ts';
import { registerAnalyticsTools } from './analytics.ts';
import { registerCanvasTools } from './canvas.ts';
import { registerDailyTools } from './daily.ts';
import { registerGraphTools } from './graph.ts';
import { registerManageTools } from './manage.ts';
import { registerReadTools } from './read.ts';
import { registerSearchTools } from './search.ts';
import { registerWriteTools } from './write.ts';

export interface ToolContext {
  runtime: VaultRuntime;
  log: (e: unknown) => void;
}

export async function touch(tc: ToolContext, ...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => tc.runtime.index.refreshPath(tc.runtime.adapter, p)));
}

/** Runs `fn` inside the runtime's WriteGate, holding all `paths` for the duration of the call. */
export function locked<T>(tc: ToolContext, paths: string[], fn: () => Promise<T>): Promise<T> {
  return tc.runtime.gate.withLock(paths, fn);
}

/** Shared input schema fragment for every tool that supports optimistic concurrency. */
export const ExpectedHashArg = z
  .string()
  .length(64)
  .optional()
  .describe(
    'sha256 content hash from a previous read or write of this file. If the file changed ' +
      'since, the call fails with CONFLICT instead of overwriting silently — re-read and retry.',
  );

export function registerVaultTools(server: McpServer, tc: ToolContext): void {
  registerReadTools(server, tc);
  registerWriteTools(server, tc);
  registerSearchTools(server, tc);
  registerManageTools(server, tc);
  registerCanvasTools(server, tc);
  registerDailyTools(server, tc);
  registerAnalyticsTools(server, tc);
  registerGraphTools(server, tc);
}
