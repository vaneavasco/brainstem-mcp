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

export const CanvasNodeInputSchema = z.discriminatedUnion('type', [
  NodeBase.extend({ type: z.literal('text'), text: z.string() }).loose(),
  NodeBase.extend({
    type: z.literal('file'),
    file: z.string().min(1),
    subpath: z.string().optional(),
  }).loose(),
  NodeBase.extend({ type: z.literal('link'), url: z.url() }).loose(),
  NodeBase.extend({
    type: z.literal('group'),
    label: z.string().optional(),
    background: z.string().optional(),
    backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
  }).loose(),
]);

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
  if (data.type === 'file') normalizeVaultPath(data.file); // throws INVALID_PATH on escape attempts
  const id = data.id ?? newCanvasId();
  if (canvas.nodes.some((n) => n.id === id)) {
    throw new VaultError('INVALID_INPUT', `A node with id ${id} already exists.`);
  }
  const node = { ...data, id } as CanvasNode;
  return { canvas: { ...canvas, nodes: [...canvas.nodes, node] }, node };
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
