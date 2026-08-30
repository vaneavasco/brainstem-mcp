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
  CanvasNodePatchSchema,
  parseCanvas,
  removeNodesAndEdges,
  serializeCanvas,
  updateNode,
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

  server.registerTool(
    'vault_canvas_update_node',
    {
      title: 'Update canvas node',
      description:
        'Partially update one node of a .canvas file (position, size, color, or a type-specific field like text/file/url/label). Only fields belonging to the node\'s existing type may be patched — e.g. patching "text" on a file node fails with INVALID_INPUT. Unknown id fails with NOT_FOUND.',
      inputSchema: z.object({
        path: z.string(),
        id: z.string(),
        patch: CanvasNodePatchSchema,
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        node: z.record(z.string(), z.unknown()),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, id, patch, expectedHash }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        return locked(tc, [p], async () => {
          const current = parseCanvas((await adapter.read(p)).content);
          const { canvas, node } = updateNode(current, id, patch);
          await adapter.write(p, serializeCanvas(canvas), { expectedHash });
          const hash = (await adapter.read(p)).hash;
          return okJson({ path: p, node, hash }, `Updated node ${id} in ${p}.`);
        });
      }),
  );

  server.registerTool(
    'vault_canvas_remove',
    {
      title: 'Remove canvas nodes/edges',
      description:
        'Remove nodes and/or edges from a .canvas file. Removing a node also removes every edge attached to it. Pass at least one of nodeIds or edgeIds. Unknown ids are reported in "missing", not fatal.',
      inputSchema: z.object({
        path: z.string(),
        nodeIds: z.array(z.string()).optional(),
        edgeIds: z.array(z.string()).optional(),
        expectedHash: ExpectedHashArg,
      }),
      outputSchema: z.object({
        path: z.string(),
        removedNodes: z.array(z.string()),
        removedEdges: z.array(z.string()),
        missing: z.array(z.string()),
        hash: z.string(),
      }),
      annotations: OVERWRITE,
    },
    ({ path, nodeIds, edgeIds, expectedHash }) =>
      guarded(tc.log, async () => {
        if ((nodeIds?.length ?? 0) === 0 && (edgeIds?.length ?? 0) === 0) {
          throw new VaultError('INVALID_INPUT', 'At least one of nodeIds or edgeIds is required.');
        }
        const p = requireCanvasPath(path);
        return locked(tc, [p], async () => {
          const current = parseCanvas((await adapter.read(p)).content);
          const { canvas, removedNodes, removedEdges, missing } = removeNodesAndEdges(
            current,
            nodeIds ?? [],
            edgeIds ?? [],
          );
          await adapter.write(p, serializeCanvas(canvas), { expectedHash });
          const hash = (await adapter.read(p)).hash;
          return okJson(
            { path: p, removedNodes, removedEdges, missing, hash },
            `Removed ${removedNodes.length} node(s) and ${removedEdges.length} edge(s) from ${p}.`,
          );
        });
      }),
  );
}
