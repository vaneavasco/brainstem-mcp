import { type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { registerVaultTools } from '../tools/register.ts';
import { DEFAULT_INSTRUCTIONS } from '../vault/instructions.ts';
import type { RuntimeResolver } from '../vault/runtime.ts';
import { SERVER_INFO } from '../version.ts';

export interface FactoryDeps {
  resolveRuntime: RuntimeResolver;
  logger: Logger;
  /**
   * The `instructions` sent in the initialize result — defaults plus the
   * owner's `_brainstem/instructions.md` (see `src/vault/instructions.ts`).
   * Optional so tests and tools that don't care get the defaults.
   */
  instructions?: () => Promise<string>;
}

const PingOutput = z.looseObject({
  server: z.string(),
  version: z.string(),
  era: z.enum(['legacy', 'modern']),
  now: z.string(),
  index: z.looseObject({
    notes: z.number(),
    builtAt: z.string(),
    /** null until the background reconcile has run at least once. */
    reconciledAt: z.string().nullable(),
    /** Serialized size of the index entries (the process heap holds about twice that). */
    bytes: z.number(),
    /** The warning line for `bytes`; nothing is evicted above it, the owner is told. */
    budgetBytes: z.number(),
    overBudget: z.boolean(),
    /** True while a deferred index build (`createLocalRuntime({ deferIndex: true })`, the stdio
     *  entrypoint) is still filling; every other vault tool but a handful of exempt reads waits
     *  for it, up to INDEX_WAIT_MS, before answering. Always false without `deferIndex`. */
    building: z.boolean(),
    /** Notes indexed so far while building; equals `total` once `building` is false. */
    indexed: z.number(),
    /** Notes the current fill found to index; 0 until the initial listing finishes. */
    total: z.number(),
  }),
});

/** Builds a fresh McpServer for one request (stateless per MCP 2026-07-28). */
export async function createVaultServer(
  ctx: McpRequestContext,
  deps: FactoryDeps,
): Promise<McpServer> {
  const instructions = deps.instructions ? await deps.instructions() : DEFAULT_INSTRUCTIONS;
  const runtime = await deps.resolveRuntime(ctx);
  const server = new McpServer(SERVER_INFO, {
    instructions,
    // Built per request, this server has no channel to push `notifications/tools/list_changed`
    // on, so it must not promise to: a client that believes the promise never asks again.
    capabilities: { tools: { listChanged: false } },
    // Five minutes. An hour meant that a release which added tool arguments stayed invisible to
    // connected clients well past the hour; the list is small and the same for everyone.
    cacheHints: {
      'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
    },
  });

  server.registerTool(
    'brainstem_ping',
    {
      title: 'Ping',
      description:
        'Health check. Returns server name, version, protocol era, current time, and index ' +
        'state (note count, when it was built, when the background reconcile last ran, its size ' +
        'beside its budget).',
      outputSchema: PingOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const indexState = runtime.indexState();
      const out = {
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        era: ctx.era,
        now: new Date().toISOString(),
        index: {
          notes: runtime.index.size(),
          builtAt: runtime.index.builtAt.toISOString(),
          reconciledAt: runtime.index.reconciledAt?.toISOString() ?? null,
          bytes: runtime.index.byteSize(),
          budgetBytes: runtime.index.budgetBytes,
          overBudget: runtime.index.byteSize() > runtime.index.budgetBytes,
          building: !indexState.ready,
          indexed: indexState.done,
          total: indexState.total,
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  // Not every client shows the model the initialize `instructions` (measured: the claude.ai
  // connector does not). The same text as a tool reaches any client; the descriptions of the tools
  // a conversation starts with point here.
  server.registerTool(
    'brainstem_guide',
    {
      title: 'How to use this vault',
      description:
        "How this vault is organised and how to read and edit it cheaply: the server conventions plus the owner's own instructions for this vault. Call once at the start of a conversation, before listing or searching.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ content: [{ type: 'text', text: instructions }] }),
  );

  registerVaultTools(server, {
    runtime,
    log: (error) => deps.logger.error({ err: error }, 'tool failure'),
  });
  return server;
}
