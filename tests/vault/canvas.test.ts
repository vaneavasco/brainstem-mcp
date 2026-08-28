import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  addEdge,
  addNode,
  newCanvasId,
  parseCanvas,
  serializeCanvas,
} from '../../src/vault/canvas.ts';

describe('parseCanvas / serializeCanvas', () => {
  it('parses an empty file as an empty canvas and round-trips unknown keys', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] });
    const text = JSON.stringify({
      nodes: [
        { id: 'a1', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50, customKey: 1 },
      ],
      edges: [],
      metadata: { version: '1.0-0' },
    });
    const canvas = parseCanvas(text);
    expect(canvas.nodes[0]).toMatchObject({ id: 'a1', customKey: 1 });
    expect((canvas as unknown as { metadata: unknown }).metadata).toEqual({ version: '1.0-0' });
    const out = serializeCanvas(canvas);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\t"nodes"');
    expect(parseCanvas(out)).toEqual(canvas);
  });

  it('rejects invalid JSON and structurally invalid canvases', () => {
    expect(() => parseCanvas('{not json')).toThrow(VaultError);
    expect(() => parseCanvas('{"nodes":"nope","edges":[]}')).toThrow(VaultError);
    expect(() => parseCanvas('{"nodes":[{"id":"x","type":"text"}],"edges":[]}')).toThrow(
      VaultError,
    );
  });
});

describe('addNode', () => {
  it('generates ids, validates by type and rejects duplicates', () => {
    const { canvas, node } = addNode(parseCanvas(''), {
      type: 'text',
      text: 'Hello',
      x: 10,
      y: 20,
      width: 200,
      height: 80,
    });
    expect(node.id).toMatch(/^[0-9a-f]{16}$/);
    expect(canvas.nodes).toHaveLength(1);
    const withFile = addNode(canvas, {
      id: 'f1',
      type: 'file',
      file: 'notes/a.md',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(withFile.canvas.nodes.map((n) => n.id)).toEqual([node.id, 'f1']);
    expect(() =>
      addNode(withFile.canvas, {
        id: 'f1',
        type: 'link',
        url: 'https://x.y',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).toThrow(/already exists/);
    expect(() =>
      addNode(canvas, { type: 'file', x: 0, y: 0, width: 1, height: 1 } as never),
    ).toThrow(VaultError);
    expect(() =>
      addNode(canvas, { type: 'file', file: '../escape.md', x: 0, y: 0, width: 1, height: 1 }),
    ).toThrow(VaultError);
  });

  it('newCanvasId is unique-ish', () => {
    expect(new Set(Array.from({ length: 100 }, newCanvasId)).size).toBe(100);
  });
});

describe('addEdge', () => {
  it('requires both endpoints to exist and fills defaults', () => {
    let canvas = parseCanvas('');
    canvas = addNode(canvas, {
      id: 'a',
      type: 'text',
      text: 'A',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    canvas = addNode(canvas, {
      id: 'b',
      type: 'text',
      text: 'B',
      x: 5,
      y: 5,
      width: 1,
      height: 1,
    }).canvas;
    const { canvas: next, edge } = addEdge(canvas, {
      fromNode: 'a',
      toNode: 'b',
      label: 'leads to',
    });
    expect(edge.id).toMatch(/^[0-9a-f]{16}$/);
    expect(edge).toMatchObject({ fromNode: 'a', toNode: 'b', label: 'leads to' });
    expect(next.edges).toHaveLength(1);
    expect(() => addEdge(next, { fromNode: 'a', toNode: 'zzz' })).toThrow(/zzz/);
    expect(() => addEdge(next, { id: edge.id, fromNode: 'a', toNode: 'b' })).toThrow(
      /already exists/,
    );
  });
});
