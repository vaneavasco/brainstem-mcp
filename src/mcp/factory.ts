import { type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { registerVaultTools } from '../tools/register.ts';
import type { RuntimeResolver } from '../vault/runtime.ts';
import { SERVER_INFO } from '../version.ts';

export interface FactoryDeps {
  resolveRuntime: RuntimeResolver;
  logger: Logger;
}

const PingOutput = z.object({
  server: z.string(),
  version: z.string(),
  era: z.enum(['legacy', 'modern']),
  now: z.string(),
});

/** Builds a fresh McpServer for one request (stateless per MCP 2026-07-28). */
export async function createVaultServer(
  ctx: McpRequestContext,
  deps: FactoryDeps,
): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "brainstem-mcp gives you read/write access to the user's personal markdown vault. Paths are vault-relative. Prefer vault_edit/vault_append over rewriting whole notes. Deleting requires confirm=true and only moves files to .trash/.",
    cacheHints: {
      'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    },
  });

  server.registerTool(
    'brainstem_ping',
    {
      title: 'Ping',
      description: 'Health check. Returns server name, version, protocol era and current time.',
      outputSchema: PingOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const out = {
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        era: ctx.era,
        now: new Date().toISOString(),
      };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  const runtime = await deps.resolveRuntime(ctx);
  registerVaultTools(server, {
    runtime,
    log: (error) => deps.logger.error({ err: error }, 'tool failure'),
  });
  return server;
}
