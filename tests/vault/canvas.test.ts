import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  addEdge,
  addNode,
  newCanvasId,
  parseCanvas,
  removeNodesAndEdges,
  rewriteFileNodes,
  serializeCanvas,
  updateNode,
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
    const { node: n1 } = addNode(canvas, {
      id: 'n1',
      type: 'file',
      file: 'notes\\a.md',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    if (n1.type !== 'file') throw new Error('expected a file node');
    expect(n1.file).toBe('notes/a.md');
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

describe('rewriteFileNodes', () => {
  it('rewrites file nodes matching the mapping case-insensitively and counts them', () => {
    let canvas = parseCanvas('');
    canvas = addNode(canvas, {
      id: 'f1',
      type: 'file',
      file: 'notes/b.md',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    canvas = addNode(canvas, {
      id: 't1',
      type: 'text',
      text: 'hi',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    const mapping = new Map([['notes/b.md', 'archive/notes/b.md']]);
    const { canvas: rewritten, count } = rewriteFileNodes(canvas, mapping);
    expect(count).toBe(1);
    const fileNode = rewritten.nodes.find((n) => n.id === 'f1');
    expect(fileNode).toMatchObject({ file: 'archive/notes/b.md' });
    // Untouched node is left alone (same reference-equal object).
    expect(rewritten.nodes.find((n) => n.id === 't1')).toBe(
      canvas.nodes.find((n) => n.id === 't1'),
    );
  });

  it('matches case-insensitively and leaves unrelated file nodes untouched', () => {
    let canvas = parseCanvas('');
    canvas = addNode(canvas, {
      id: 'f1',
      type: 'file',
      file: 'Notes/B.MD',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    canvas = addNode(canvas, {
      id: 'f2',
      type: 'file',
      file: 'other.md',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    const mapping = new Map([['notes/b.md', 'archive/notes/b.md']]);
    const { canvas: rewritten, count } = rewriteFileNodes(canvas, mapping);
    expect(count).toBe(1);
    expect(rewritten.nodes.find((n) => n.id === 'f1')).toMatchObject({
      file: 'archive/notes/b.md',
    });
    expect(rewritten.nodes.find((n) => n.id === 'f2')).toMatchObject({ file: 'other.md' });
  });

  it('returns the same canvas object and count 0 when nothing matches', () => {
    const canvas = addNode(parseCanvas(''), {
      id: 'f1',
      type: 'file',
      file: 'other.md',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).canvas;
    const result = rewriteFileNodes(canvas, new Map([['notes/b.md', 'archive/notes/b.md']]));
    expect(result.count).toBe(0);
    expect(result.canvas).toBe(canvas);
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

describe('updateNode', () => {
  function fixture() {
    let canvas = parseCanvas('');
    canvas = addNode(canvas, {
      id: 't1',
      type: 'text',
      text: 'Hello',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    }).canvas;
    canvas = addNode(canvas, {
      id: 'f1',
      type: 'file',
      file: 'notes/a.md',
      x: 10,
      y: 10,
      width: 1,
      height: 1,
    }).canvas;
    return canvas;
  }

  it('partially updates common fields without touching the rest', () => {
    const canvas = fixture();
    const { canvas: next, node } = updateNode(canvas, 't1', { x: 500, color: '3' });
    expect(node).toMatchObject({ id: 't1', type: 'text', text: 'Hello', x: 500, color: '3', y: 0 });
    expect(next.nodes.find((n) => n.id === 'f1')).toBe(canvas.nodes.find((n) => n.id === 'f1'));
  });

  it("updates a type-specific field matching the node's existing type", () => {
    const canvas = fixture();
    const { node } = updateNode(canvas, 't1', { text: 'Updated' });
    expect(node).toMatchObject({ type: 'text', text: 'Updated' });
    const { node: fileNode } = updateNode(canvas, 'f1', { file: 'notes\\b.md' });
    if (fileNode.type !== 'file') throw new Error('expected a file node');
    expect(fileNode.file).toBe('notes/b.md');
  });

  it("rejects a field that does not belong to the node's type", () => {
    const canvas = fixture();
    expect(() => updateNode(canvas, 'f1', { text: 'nope' })).toThrow(VaultError);
    try {
      updateNode(canvas, 'f1', { text: 'nope' });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe('INVALID_INPUT');
      expect((error as VaultError).message).toContain('text');
      expect((error as VaultError).message).toContain('file');
    }
    expect(() => updateNode(canvas, 't1', { url: 'https://x.y' })).toThrow(VaultError);
    expect(() => updateNode(canvas, 't1', { label: 'nope' })).toThrow(VaultError);
  });

  it('unknown id fails NOT_FOUND and lists existing ids', () => {
    const canvas = fixture();
    try {
      updateNode(canvas, 'zzz', { x: 1 });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe('NOT_FOUND');
      expect((error as VaultError).message).toContain('t1');
      expect((error as VaultError).message).toContain('f1');
    }
  });

  it('unknown id on an empty canvas still fails NOT_FOUND', () => {
    expect(() => updateNode(parseCanvas(''), 'zzz', { x: 1 })).toThrow(/no nodes/i);
  });

  it('rejects an invalid value for an otherwise-allowed field', () => {
    const canvas = fixture();
    expect(() => updateNode(canvas, 't1', { width: -5 })).toThrow(VaultError);
  });

  it('ignores id/type in the patch — a node keeps its identity and type', () => {
    const canvas = fixture();
    const { node } = updateNode(canvas, 't1', {
      // biome-ignore lint/suspicious/noExplicitAny: exercising a caller that ignores the type
      ...({ id: 'evil', type: 'link' } as any),
      x: 1,
    });
    expect(node.id).toBe('t1');
    expect(node.type).toBe('text');
    expect(node.x).toBe(1);
  });
});

describe('removeNodesAndEdges', () => {
  function fixture() {
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
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    }).canvas;
    canvas = addNode(canvas, {
      id: 'c',
      type: 'text',
      text: 'C',
      x: 2,
      y: 2,
      width: 1,
      height: 1,
    }).canvas;
    canvas = addEdge(canvas, { id: 'e1', fromNode: 'a', toNode: 'b' }).canvas;
    canvas = addEdge(canvas, { id: 'e2', fromNode: 'b', toNode: 'c' }).canvas;
    return canvas;
  }

  it('removing a node cascades to every edge attached to it', () => {
    const canvas = fixture();
    const {
      canvas: next,
      removedNodes,
      removedEdges,
      missing,
    } = removeNodesAndEdges(canvas, ['a'], []);
    expect(removedNodes).toEqual(['a']);
    expect(removedEdges).toEqual(['e1']);
    expect(missing).toEqual([]);
    expect(next.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(next.edges.map((e) => e.id)).toEqual(['e2']);
  });

  it('removes an edge directly by id without touching its endpoints', () => {
    const canvas = fixture();
    const { canvas: next, removedNodes, removedEdges } = removeNodesAndEdges(canvas, [], ['e1']);
    expect(removedNodes).toEqual([]);
    expect(removedEdges).toEqual(['e1']);
    expect(next.nodes).toHaveLength(3);
    expect(next.edges.map((e) => e.id)).toEqual(['e2']);
  });

  it('reports unknown ids as missing without throwing, still removing the valid ones', () => {
    const canvas = fixture();
    const { removedNodes, removedEdges, missing } = removeNodesAndEdges(
      canvas,
      ['a', 'zzz'],
      ['nope'],
    );
    expect(removedNodes).toEqual(['a']);
    expect(removedEdges).toEqual(['e1']);
    expect(missing).toEqual(['zzz', 'nope']);
  });

  it('a node and its edge both listed only removes the edge once', () => {
    const canvas = fixture();
    const { removedEdges } = removeNodesAndEdges(canvas, ['a'], ['e1']);
    expect(removedEdges).toEqual(['e1']);
  });

  it('is a no-op when nothing is requested', () => {
    const canvas = fixture();
    const {
      canvas: next,
      removedNodes,
      removedEdges,
      missing,
    } = removeNodesAndEdges(canvas, [], []);
    expect(removedNodes).toEqual([]);
    expect(removedEdges).toEqual([]);
    expect(missing).toEqual([]);
    expect(next.nodes).toEqual(canvas.nodes);
    expect(next.edges).toEqual(canvas.edges);
  });
});
