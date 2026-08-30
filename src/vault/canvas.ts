import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';

const Side = z.enum(['top', 'right', 'bottom', 'left']);
const End = z.enum(['none', 'arrow']);

const NodeBase = z.object({
  id: z.string().min(1).optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: z.string().optional(),
});

const TextNodeSchema = NodeBase.extend({ type: z.literal('text'), text: z.string() }).loose();
const FileNodeSchema = NodeBase.extend({
  type: z.literal('file'),
  file: z.string().min(1),
  subpath: z.string().optional(),
}).loose();
const LinkNodeSchema = NodeBase.extend({ type: z.literal('link'), url: z.url() }).loose();
const GroupNodeSchema = NodeBase.extend({
  type: z.literal('group'),
  label: z.string().optional(),
  background: z.string().optional(),
  backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
}).loose();

export const CanvasNodeInputSchema = z.discriminatedUnion('type', [
  TextNodeSchema,
  FileNodeSchema,
  LinkNodeSchema,
  GroupNodeSchema,
]);

/** Fields specific to one node type — shared by `updateNode`'s type check and re-validation. */
const NODE_TYPE_SCHEMAS = {
  text: TextNodeSchema,
  file: FileNodeSchema,
  link: LinkNodeSchema,
  group: GroupNodeSchema,
} as const;

const TYPE_SPECIFIC_FIELDS: Record<keyof typeof NODE_TYPE_SCHEMAS, readonly string[]> = {
  text: ['text'],
  file: ['file', 'subpath'],
  link: ['url'],
  group: ['label', 'background', 'backgroundStyle'],
};

/** Every field that belongs to *some* node type, used to tell "wrong type for this node"
 *  (rejected) apart from an arbitrary custom property (passed through, per JSON Canvas's own
 *  extensibility — see parseCanvas's round-trip test). */
const ALL_TYPE_SPECIFIC_FIELDS = new Set(Object.values(TYPE_SPECIFIC_FIELDS).flat());

/** Common to every node type; always patchable regardless of the node's type. */
const COMMON_NODE_FIELDS = ['x', 'y', 'width', 'height', 'color'];

export const CanvasNodePatchSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    color: z.string().optional(),
    text: z.string().optional(),
    file: z.string().min(1).optional(),
    subpath: z.string().optional(),
    url: z.url().optional(),
    label: z.string().optional(),
    background: z.string().optional(),
    backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
  })
  .loose();

export type CanvasNodePatch = z.infer<typeof CanvasNodePatchSchema>;

export const CanvasEdgeInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    fromNode: z.string().min(1),
    toNode: z.string().min(1),
    fromSide: Side.optional(),
    toSide: Side.optional(),
    fromEnd: End.optional(),
    toEnd: End.optional(),
    color: z.string().optional(),
    label: z.string().optional(),
  })
  .loose();

const CanvasNodeSchema = CanvasNodeInputSchema.and(z.object({ id: z.string().min(1) }));
const CanvasEdgeSchema = CanvasEdgeInputSchema.and(z.object({ id: z.string().min(1) }));
const CanvasSchema = z
  .object({ nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema) })
  .loose();

export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CanvasNodeInput = z.infer<typeof CanvasNodeInputSchema>;
export type CanvasEdgeInput = z.infer<typeof CanvasEdgeInputSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;

export function newCanvasId(): string {
  return randomBytes(8).toString('hex');
}

export function parseCanvas(text: string): Canvas {
  if (text.trim() === '') return { nodes: [], edges: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError('INVALID_INPUT', 'Canvas file is not valid JSON.');
  }
  const parsed = CanvasSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError(
      'INVALID_INPUT',
      `Canvas file is not a valid JSON Canvas: ${first ? `${first.path.join('.')}: ${first.message}` : 'schema error'}.`,
    );
  }
  return parsed.data;
}

export function serializeCanvas(canvas: Canvas): string {
  return `${JSON.stringify(canvas, null, '\t')}\n`;
}

export function addNode(
  canvas: Canvas,
  input: CanvasNodeInput,
): { canvas: Canvas; node: CanvasNode } {
  const parsed = CanvasNodeInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError(
      'INVALID_INPUT',
      `Invalid canvas node: ${first?.path.join('.')} ${first?.message}.`,
    );
  }
  const data = parsed.data;
  const id = data.id ?? newCanvasId();
  if (canvas.nodes.some((n) => n.id === id)) {
    throw new VaultError('INVALID_INPUT', `A node with id ${id} already exists.`);
  }
  const node = {
    ...data,
    id,
    ...(data.type === 'file' ? { file: normalizeVaultPath(data.file) } : {}),
  } as CanvasNode;
  return { canvas: { ...canvas, nodes: [...canvas.nodes, node] }, node };
}

/**
 * Rewrites every `file`-type node whose `file` matches a key in `mapping` (compared
 * case-insensitively, as Obsidian resolves vault paths) to the mapped new path. Used by
 * `vault_move` to keep `.canvas` boards in sync with a note/asset rename.
 */
export function rewriteFileNodes(
  canvas: Canvas,
  mapping: Map<string, string>,
): { canvas: Canvas; count: number } {
  let count = 0;
  const nodes = canvas.nodes.map((node) => {
    if (node.type !== 'file') return node;
    const newFile = mapping.get(node.file.toLowerCase());
    if (newFile === undefined) return node;
    count += 1;
    return { ...node, file: newFile };
  });
  return count > 0 ? { canvas: { ...canvas, nodes }, count } : { canvas, count };
}

export function addEdge(
  canvas: Canvas,
  input: CanvasEdgeInput,
): { canvas: Canvas; edge: CanvasEdge } {
  const parsed = CanvasEdgeInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError(
      'INVALID_INPUT',
      `Invalid canvas edge: ${first?.path.join('.')} ${first?.message}.`,
    );
  }
  const data = parsed.data;
  const ids = new Set(canvas.nodes.map((n) => n.id));
  for (const endpoint of [data.fromNode, data.toNode]) {
    if (!ids.has(endpoint))
      throw new VaultError('INVALID_INPUT', `Node ${endpoint} does not exist in this canvas.`);
  }
  const id = data.id ?? newCanvasId();
  if (canvas.edges.some((e) => e.id === id)) {
    throw new VaultError('INVALID_INPUT', `An edge with id ${id} already exists.`);
  }
  const edge = { ...data, id } as CanvasEdge;
  return { canvas: { ...canvas, edges: [...canvas.edges, edge] }, edge };
}

/**
 * Partially updates one node by id. `patch` may carry any of the common geometry/color fields
 * (always allowed) plus any type-specific field (`text`, `file`/`subpath`, `url`, or
 * `label`/`background`/`backgroundStyle`) — but only the ones that belong to the node's *existing*
 * type; patching e.g. `text` on a `file` node is rejected rather than silently changing what kind
 * of node it is. `type` and `id` in `patch` are ignored (a node cannot be reassigned to a
 * different type or id via update). An arbitrary custom key that isn't part of any known node
 * type's field set is passed through untouched, mirroring parseCanvas's round-trip of unknown
 * JSON Canvas properties.
 */
export function updateNode(
  canvas: Canvas,
  id: string,
  patch: CanvasNodePatch,
): { canvas: Canvas; node: CanvasNode } {
  const node = canvas.nodes.find((n) => n.id === id);
  if (node === undefined) {
    const existing = canvas.nodes.map((n) => n.id).join(', ');
    throw new VaultError(
      'NOT_FOUND',
      existing === ''
        ? `No node with id ${id} in this canvas. This canvas has no nodes.`
        : `No node with id ${id} in this canvas. Existing ids: ${existing}.`,
    );
  }
  const { type: _type, id: _id, ...rest } = patch as Record<string, unknown>;
  const allowed = new Set([...COMMON_NODE_FIELDS, ...TYPE_SPECIFIC_FIELDS[node.type]]);
  for (const key of Object.keys(rest)) {
    if (ALL_TYPE_SPECIFIC_FIELDS.has(key) && !allowed.has(key)) {
      throw new VaultError(
        'INVALID_INPUT',
        `"${key}" is not a valid field for a ${node.type} node.`,
      );
    }
  }
  const candidate = {
    ...node,
    ...rest,
    ...(node.type === 'file' && typeof rest.file === 'string'
      ? { file: normalizeVaultPath(rest.file) }
      : {}),
    type: node.type,
    id: node.id,
  };
  const parsed = NODE_TYPE_SCHEMAS[node.type].safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError(
      'INVALID_INPUT',
      `Invalid canvas node patch: ${first?.path.join('.')} ${first?.message}.`,
    );
  }
  const updated = { ...parsed.data, id: node.id } as CanvasNode;
  const nodes = canvas.nodes.map((n) => (n.id === id ? updated : n));
  return { canvas: { ...canvas, nodes }, node: updated };
}

/**
 * Removes the given nodes and edges. Removing a node also removes every edge attached to it
 * (`fromNode` or `toNode`), whether or not that edge id was also listed. Unknown node/edge ids are
 * reported in `missing` rather than throwing — a caller can pass ids best-effort (e.g. "remove
 * this node and any edge that happens to reference it") without pre-checking existence.
 */
export function removeNodesAndEdges(
  canvas: Canvas,
  nodeIds: string[],
  edgeIds: string[],
): { canvas: Canvas; removedNodes: string[]; removedEdges: string[]; missing: string[] } {
  const nodeIdSet = new Set(nodeIds);
  const edgeIdSet = new Set(edgeIds);
  const existingNodeIds = new Set(canvas.nodes.map((n) => n.id));
  const existingEdgeIds = new Set(canvas.edges.map((e) => e.id));
  const missing = [
    ...nodeIds.filter((id) => !existingNodeIds.has(id)),
    ...edgeIds.filter((id) => !existingEdgeIds.has(id)),
  ];

  const removedNodes: string[] = [];
  const nodes = canvas.nodes.filter((n) => {
    if (!nodeIdSet.has(n.id)) return true;
    removedNodes.push(n.id);
    return false;
  });

  const removedEdges: string[] = [];
  const edges = canvas.edges.filter((e) => {
    if (!edgeIdSet.has(e.id) && !nodeIdSet.has(e.fromNode) && !nodeIdSet.has(e.toNode)) return true;
    removedEdges.push(e.id);
    return false;
  });

  return { canvas: { ...canvas, nodes, edges }, removedNodes, removedEdges, missing };
}
