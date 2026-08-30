import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import { type Harness, startHarness, text } from './harness.ts';

interface MoveResult {
  from: string;
  to: string;
  hash: string | null;
  linksUpdated: { path: string; count: number }[];
  failed: { path: string; error: string }[];
}

interface ContextHit {
  path: string;
  line: number;
  context: string;
}

interface LinksResult {
  backlinks: ContextHit[];
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('vault_move — link rewriting', () => {
  it('rewrites wikilinks and markdown links in every linking note and keeps the graph coherent', async () => {
    await h.call('vault_write', { path: 'b.md', content: 'Note B body.\n' });
    await h.call('vault_write', { path: 'a.md', content: '[[b]] link one.\n' });
    await h.call('vault_write', { path: 'c.md', content: 'See [t](b.md) for details.\n' });

    const mv = await h.call('vault_move', { from: 'b.md', to: 'notes/b2.md' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.from).toBe('b.md');
    expect(body.to).toBe('notes/b2.md');
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.failed).toEqual([]);
    expect([...body.linksUpdated].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.md', count: 1 },
      { path: 'c.md', count: 1 },
    ]);

    // 'b2' is unique in the vault, so the bare wikilink keeps its bare style.
    expect(text(await h.call('vault_read', { path: 'a.md' }))).toBe('[[b2]] link one.\n');
    expect(text(await h.call('vault_read', { path: 'c.md' }))).toBe(
      'See [t](notes/b2.md) for details.\n',
    );

    const links = await h.call('vault_links', { path: 'notes/b2.md', include: ['backlinks'] });
    expect(links.isError).toBeFalsy();
    const linkBody = links.structuredContent as LinksResult;
    expect(linkBody.backlinks.map((bl) => bl.path).sort()).toEqual(['a.md', 'c.md']);
  });

  it('rewrites to the full vault path when the new basename is no longer unique', async () => {
    await h.call('vault_write', { path: 'b.md', content: 'Note B body.\n' });
    await h.call('vault_write', { path: 'notes/b2.md', content: 'Another note named b2.\n' });
    await h.call('vault_write', { path: 'a.md', content: '[[b]] link.\n' });

    const mv = await h.call('vault_move', { from: 'b.md', to: 'other/b2.md' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.linksUpdated).toEqual([{ path: 'a.md', count: 1 }]);
    // 'b2' now collides with notes/b2.md, so the bare form would be ambiguous — full path instead.
    expect(text(await h.call('vault_read', { path: 'a.md' }))).toBe('[[other/b2]] link.\n');
  });

  it('updateLinks:false leaves every link untouched', async () => {
    await h.call('vault_write', { path: 'b.md', content: 'Note B body.\n' });
    await h.call('vault_write', { path: 'a.md', content: '[[b]] link one.\n' });
    await h.call('vault_write', { path: 'c.md', content: 'See [t](b.md) for details.\n' });

    const mv = await h.call('vault_move', {
      from: 'b.md',
      to: 'notes/b2.md',
      updateLinks: false,
    });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.linksUpdated).toEqual([]);
    expect(body.failed).toEqual([]);

    expect(text(await h.call('vault_read', { path: 'a.md' }))).toBe('[[b]] link one.\n');
    expect(text(await h.call('vault_read', { path: 'c.md' }))).toBe('See [t](b.md) for details.\n');
  });

  it('leaves an ambiguous bare link untouched when one of the candidates is renamed', async () => {
    await h.call('vault_write', { path: 'dup.md', content: 'root dup\n' });
    await h.call('vault_write', { path: 'folder/dup.md', content: 'folder dup\n' });
    await h.call('vault_write', { path: 'amb.md', content: '[[dup]] ambiguous link.\n' });

    const mv = await h.call('vault_move', { from: 'dup.md', to: 'renamed/dup2.md' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.linksUpdated).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(text(await h.call('vault_read', { path: 'amb.md' }))).toBe('[[dup]] ambiguous link.\n');
  });

  it('leaves a link inside a code fence untouched (it is never parsed as a link)', async () => {
    await h.call('vault_write', { path: 'target.md', content: 'Target note.\n' });
    const fenced = '```\n[[target]]\n```\nNo other links here.\n';
    await h.call('vault_write', { path: 'coder.md', content: fenced });

    const mv = await h.call('vault_move', { from: 'target.md', to: 'new/target2.md' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.linksUpdated).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(text(await h.call('vault_read', { path: 'coder.md' }))).toBe(fenced);
  });

  it('rewrites full-path wikilinks on a folder move and leaves unrelated bare links alone', async () => {
    await h.call('vault_write', { path: 'dup.md', content: 'root dup\n' }); // makes bare "dup" ambiguous
    await h.call('vault_write', { path: 'folder/dup.md', content: 'folder dup\n' });
    await h.call('vault_write', { path: 'x.md', content: 'x content\n' });
    await h.call('vault_write', {
      path: 'linker.md',
      content: '[[folder/dup]] and [[x]] both linked.\n',
    });

    const mv = await h.call('vault_move', { from: 'folder', to: 'archive/folder' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.failed).toEqual([]);
    expect(body.linksUpdated).toEqual([{ path: 'linker.md', count: 1 }]);
    expect(text(await h.call('vault_read', { path: 'linker.md' }))).toBe(
      '[[archive/folder/dup]] and [[x]] both linked.\n',
    );
  });

  it('rewrites a moved note that links to another note moved in the same folder, writing to its new path', async () => {
    await h.call('vault_write', { path: 'folder/p.md', content: '[[folder/q]] see also.\n' });
    await h.call('vault_write', { path: 'folder/q.md', content: 'Q content.\n' });

    const mv = await h.call('vault_move', { from: 'folder', to: 'archive/folder2' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.failed).toEqual([]);
    // Reported under the note's *new* path, since it was already moved by the time it was rewritten.
    expect(body.linksUpdated).toEqual([{ path: 'archive/folder2/p.md', count: 1 }]);

    expect(h.runtime.index.get('folder/p.md')).toBeUndefined();
    expect(text(await h.call('vault_read', { path: 'archive/folder2/p.md' }))).toBe(
      '[[archive/folder2/q]] see also.\n',
    );
  });

  it('rewrites .canvas file nodes pointing at the moved note', async () => {
    await h.call('vault_write', { path: 'b.md', content: 'B note.\n' });
    await h.call('vault_canvas_add_node', {
      path: 'boards/board.canvas',
      node: { type: 'file', file: 'b.md', x: 0, y: 0, width: 100, height: 100 },
    });

    const mv = await h.call('vault_move', { from: 'b.md', to: 'notes/b2.md' });
    expect(mv.isError).toBeFalsy();

    const read = await h.call('vault_canvas_read', { path: 'boards/board.canvas' });
    const nodes = (read.structuredContent as { nodes: { file?: string }[] }).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.file).toBe('notes/b2.md');
  });

  it('reports a per-source CONFLICT in failed[] without aborting the move or the other rewrites', async () => {
    await h.call('vault_write', { path: 'b.md', content: 'B\n' });
    await h.call('vault_write', { path: 'a.md', content: '[[b]] one.\n' });
    await h.call('vault_write', { path: 'c.md', content: '[[b]] two.\n' });

    const originalWrite = h.runtime.adapter.write.bind(h.runtime.adapter);
    let thrown = false;
    h.runtime.adapter.write = (async (
      ...args: Parameters<typeof originalWrite>
    ): ReturnType<typeof originalWrite> => {
      const [path] = args;
      if (path === 'a.md' && !thrown) {
        thrown = true;
        throw new VaultError('CONFLICT', 'a.md changed since it was read.', {
          path: 'a.md',
          currentHash: 'deadbeef',
        });
      }
      return originalWrite(...args);
    }) as typeof originalWrite;

    const mv = await h.call('vault_move', { from: 'b.md', to: 'notes/b2.md' });
    expect(mv.isError).toBeFalsy();
    const body = mv.structuredContent as MoveResult;
    expect(body.failed).toEqual([{ path: 'a.md', error: expect.stringContaining('CONFLICT') }]);
    expect(body.linksUpdated).toEqual([{ path: 'c.md', count: 1 }]);

    // a.md's on-disk content is unchanged since its write failed; c.md's rewrite went through.
    expect(text(await h.call('vault_read', { path: 'a.md' }))).toBe('[[b]] one.\n');
    expect(text(await h.call('vault_read', { path: 'c.md' }))).toBe('[[b2]] two.\n');
  });
});
