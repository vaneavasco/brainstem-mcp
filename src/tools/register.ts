import type { McpServer } from '@modelcontextprotocol/server';
import type { VaultRuntime } from '../vault/runtime.ts';
import { registerAnalyticsTools } from './analytics.ts';
import { registerCanvasTools } from './canvas.ts';
import { registerDailyTools } from './daily.ts';
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

export function registerVaultTools(server: McpServer, tc: ToolContext): void {
  registerReadTools(server, tc);
  registerWriteTools(server, tc);
  registerSearchTools(server, tc);
  registerManageTools(server, tc);
  registerCanvasTools(server, tc);
  registerDailyTools(server, tc);
  registerAnalyticsTools(server, tc);
}
