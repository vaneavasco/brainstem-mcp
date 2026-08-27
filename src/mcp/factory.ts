import { type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SERVER_INFO } from '../version.ts';

const PingOutput = z.object({
  server: z.string(),
  version: z.string(),
  era: z.enum(['legacy', 'modern']),
  now: z.string(),
});

/**
 * Builds a fresh McpServer for one request. Stateless by design (MCP 2026-07-28):
 * nothing created here may outlive the request.
 */
export function createVaultServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'brainstem-mcp gives Claude read/write access to a personal markdown vault. Phase 0 exposes only a ping tool.',
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
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  return server;
}
