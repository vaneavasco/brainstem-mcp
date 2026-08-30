import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import {
  addEdge,
  addNode,
  type Canvas,
  CanvasEdgeInputSchema,
  CanvasNodeInputSchema,
  parseCanvas,
  serializeCanvas,
} from '../vault/canvas.ts';
import { OVERWRITE, READ_ONLY } from './annotations.ts';
import { ExpectedHashArg, locked, type ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

function requireCanvasPath(input: string): string {
  const p = normalizeVaultPath(input);
  if (!p.toLowerCase().endsWith('.canvas')) {
    throw new VaultError('INVALID_INPUT', `${p || '(root)'} is not a .canvas file.`);
  }
  return p;
}

export function registerCanvasTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  async function readCanvasOrEmpty(p: string): Promise<Canvas> {
    try {
      return parseCanvas((await adapter.read(p)).content);
    } catch (error) {
      if (error instanceof VaultError && error.code === 'NOT_FOUND')
        return { nodes: [], edges: [] };
      throw error;
    }
  }

  server.registerTool(
    'vault_canvas_read',
    {
      title: 'Read canvas',
      description: 'Read an Obsidian .canvas file (JSON Canvas) and return its nodes and edges.',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({
        path: z.string(),
        nodes: z.array(z.record(z.string(), z.unknown())),
        edges: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY,
    },
    ({ path }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        const canvas = parseCanvas((await adapter.read(p)).content);
        return okJson({ path: p, nodes: canvas.nodes, edges: canvas.edges });
      }),
  );

  server.registerTool(
    'vault_canvas_add_node',
    {
      title: 'Add canvas node',
      description:
        'Append a node (text, file, link or group) to a .canvas file. Creates the canvas file when it does not exist yet — there is intentionally no separate vault_canvas_create. The id is generated when omitted.',
      inputSchema: z.object({
        path: z.string(),
        node: CanvasNodeInputSchema,
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        node: z.record(z.string(), z.unknown()),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, node, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        return locked(tc, [p], async () => {
          const { canvas, node: added } = addNode(await readCanvasOrEmpty(p), node);
          await adapter.write(p, serializeCanvas(canvas), { expectedHash });
          const hash = (await adapter.read(p)).hash;
          return okJson({ path: p, node: added, hash }, `Added node ${added.id} to ${p}.`);
        });
      }),
  );

  server.registerTool(
    'vault_canvas_add_edge',
    {
      title: 'Add canvas edge',
      description:
        'Append an edge between two existing nodes of a .canvas file. Both fromNode and toNode must exist.',
      inputSchema: z.object({
        path: z.string(),
        edge: CanvasEdgeInputSchema,
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        edge: z.record(z.string(), z.unknown()),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, edge, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        return locked(tc, [p], async () => {
          const current = parseCanvas((await adapter.read(p)).content);
          const { canvas, edge: added } = addEdge(current, edge);
          await adapter.write(p, serializeCanvas(canvas), { expectedHash });
          const hash = (await adapter.read(p)).hash;
          return okJson({ path: p, edge: added, hash }, `Added edge ${added.id} to ${p}.`);
        });
      }),
  );
}
