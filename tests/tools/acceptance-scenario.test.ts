import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

/**
 * Reproduces, as one ordered sequence, the real claude.ai acceptance run recorded in
 * docs/plans/2026-08-28-phase-2-single-user-auth-cli.md (b) — every tool exercised through the
 * real MCP client/server wire protocol (startHarness), JS-fallback search (ripgrepPath: null),
 * against a temp vault. It doubles as the regression test for the three bugs found in that run:
 *   A) vault_append must leave the file newline-terminated so a later vault_edit dry-run diff
 *      never reports "No newline at end of file" for a note vault_write created cleanly.
 *   B) a daily note created with no DAILY_NOTES_TEMPLATE configured gets default frontmatter
 *      (type: daily, date: ...) instead of being an empty file analytics flags as missing it.
 *   C) vault_frontmatter_update (single-file) exists alongside vault_batch_frontmatter_update.
 *
 * Extended for Phase 4 (docs/superpowers/specs/2026-08-30-phase-4-vault-graph-and-safety-design.md
 * §8) with the vault-graph and safe-concurrency flow: vault_outline → vault_read{section} →
 * vault_edit with a matching expectedHash → the same (now stale) hash producing CONFLICT →
 * vault_transaction (two ops, one unit) → vault_move rewriting a linking note's wikilink →
 * vault_query / vault_tags / vault_recent over the result.
 */
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('acceptance scenario (claude.ai run, end to end)', () => {
  it('exercises every vault tool in sequence, matching the real acceptance run', async () => {
    // brainstem_ping
    const ping = await h.call('brainstem_ping', {});
    expect(ping.isError).toBeFalsy();
    expect(ping.structuredContent).toMatchObject({ server: 'brainstem-mcp' });

    // vault_list root (empty vault)
    const rootList = await h.call('vault_list', {});
    expect((rootList.structuredContent as { entries: unknown[] }).entries).toEqual([]);

    // vault_write acceptance/note-a.md — frontmatter type/status/tags, body ending in \n
    const noteAContent =
      '---\ntype: test\nstatus: draft\ntags:\n  - alpha\n---\n\n# Note A\n\nBody line.\n';
    const writeA = await h.call('vault_write', {
      path: 'acceptance/note-a.md',
      content: noteAContent,
    });
    expect(writeA.isError).toBeFalsy();
    expect(writeA.structuredContent).toMatchObject({ path: 'acceptance/note-a.md' });
    expect(await fs.readFile(path.join(h.root, 'acceptance/note-a.md'), 'utf8')).toBe(noteAContent);

    // vault_read
    const readA = await h.call('vault_read', { path: 'acceptance/note-a.md' });
    expect(readA.structuredContent).toMatchObject({
      frontmatter: { type: 'test', status: 'draft', tags: ['alpha'] },
      hasFrontmatter: true,
    });
    expect(text(readA)).toBe(noteAContent);

    // vault_append — content with no trailing newline of its own (bug A's real trigger)
    const appendA = await h.call('vault_append', {
      path: 'acceptance/note-a.md',
      content: 'Appended without its own newline',
    });
    expect(appendA.isError).toBeFalsy();
    const rawAfterAppend = await fs.readFile(path.join(h.root, 'acceptance/note-a.md'), 'utf8');
    expect(rawAfterAppend.endsWith('\n')).toBe(true);

    // vault_edit dryRun then apply — the dry-run diff must not show a missing trailing newline
    const dry = await h.call('vault_edit', {
      path: 'acceptance/note-a.md',
      patches: [{ find: 'Body line.', replace: 'Body line changed.' }],
      dryRun: true,
    });
    expect(dry.structuredContent).toMatchObject({ applied: 1, dryRun: true });
    expect(text(dry)).not.toContain('No newline at end of file');
    const applied = await h.call('vault_edit', {
      path: 'acceptance/note-a.md',
      patches: [{ find: 'Body line.', replace: 'Body line changed.' }],
    });
    expect(applied.structuredContent).toMatchObject({ applied: 1, dryRun: false });
    expect(
      (await fs.readFile(path.join(h.root, 'acceptance/note-a.md'), 'utf8')).endsWith('\n'),
    ).toBe(true);

    // vault_write acceptance/note-b.md, containing a distinctive token for search
    const noteBContent = '---\ntype: test\n---\n\nSee ZEBRA-42 for details.\n';
    const writeB = await h.call('vault_write', {
      path: 'acceptance/note-b.md',
      content: noteBContent,
    });
    expect(writeB.isError).toBeFalsy();

    // vault_batch_read
    const batch = await h.call('vault_batch_read', {
      paths: ['acceptance/note-a.md', 'acceptance/note-b.md'],
    });
    expect(batch.structuredContent).toMatchObject({ missing: [], failed: [] });
    expect(
      (batch.structuredContent as { notes: { path: string }[] }).notes.map((n) => n.path),
    ).toEqual(['acceptance/note-a.md', 'acceptance/note-b.md']);

    // vault_search 'ZEBRA-42' (JS fallback: startHarness always runs with ripgrepPath: null)
    const search = await h.call('vault_search', { query: 'ZEBRA-42' });
    expect((search.structuredContent as { matches: { path: string }[] }).matches).toEqual([
      { path: 'acceptance/note-b.md', line: 5, text: 'See ZEBRA-42 for details.' },
    ]);

    // vault_search_frontmatter type=test
    const byType = await h.call('vault_search_frontmatter', { field: 'type', equals: 'test' });
    expect(
      (byType.structuredContent as { hits: { path: string }[] }).hits.map((hit) => hit.path),
    ).toEqual(['acceptance/note-a.md', 'acceptance/note-b.md']);

    // vault_frontmatter_update (single-file) on note-a
    const single = await h.call('vault_frontmatter_update', {
      path: 'acceptance/note-a.md',
      set: { status: 'done' },
    });
    expect(single.isError).toBeFalsy();
    expect(single.structuredContent).toMatchObject({
      path: 'acceptance/note-a.md',
      frontmatter: { status: 'done', type: 'test' },
    });

    // vault_batch_frontmatter_update on both
    const batchFm = await h.call('vault_batch_frontmatter_update', {
      updates: [
        { path: 'acceptance/note-a.md', set: { reviewed: true } },
        { path: 'acceptance/note-b.md', set: { reviewed: true } },
      ],
    });
    expect(batchFm.structuredContent).toMatchObject({
      updated: ['acceptance/note-a.md', 'acceptance/note-b.md'],
      failed: [],
    });

    // vault_move note-b -> acceptance/moved/note-b.md
    const moved = await h.call('vault_move', {
      from: 'acceptance/note-b.md',
      to: 'acceptance/moved/note-b.md',
    });
    expect(moved.structuredContent).toEqual({
      from: 'acceptance/note-b.md',
      to: 'acceptance/moved/note-b.md',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      linksUpdated: [],
      failed: [],
    });
    expect(h.runtime.index.get('acceptance/moved/note-b.md')?.frontmatter).toMatchObject({
      reviewed: true,
    });

    // vault_daily_note_path / read (NOT_FOUND error result) / append — no template configured
    const dailyPath = await h.call('vault_daily_note_path', {});
    const { path: dailyRelPath, exists: dailyExisted } = dailyPath.structuredContent as {
      path: string;
      exists: boolean;
    };
    expect(dailyExisted).toBe(false);
    const dailyMissing = await h.call('vault_daily_note_read', {});
    expect(dailyMissing.isError).toBe(true);
    expect(text(dailyMissing)).toMatch(/^NOT_FOUND: /);
    const dailyAppend = await h.call('vault_daily_note_append', {
      content: '- did the acceptance run',
    });
    expect(dailyAppend.structuredContent).toMatchObject({ path: dailyRelPath, created: true });
    const dailyRead = await h.call('vault_daily_note_read', {});
    expect(dailyRead.structuredContent).toMatchObject({ frontmatter: { type: 'daily' } });
    expect(text(dailyRead)).toContain('- did the acceptance run');
    const dailyRaw = await fs.readFile(path.join(h.root, dailyRelPath), 'utf8');
    expect(dailyRaw).toContain('type: daily');
    expect(dailyRaw.endsWith('\n')).toBe(true);

    // vault_canvas_add_node x2 + vault_canvas_add_edge + vault_canvas_read
    const canvasPath = 'acceptance/board.canvas';
    const nodeA = await h.call('vault_canvas_add_node', {
      path: canvasPath,
      node: { id: 'a', type: 'text', text: 'Node A', x: 0, y: 0, width: 200, height: 100 },
    });
    expect(nodeA.structuredContent).toMatchObject({ node: { id: 'a' } });
    const nodeB = await h.call('vault_canvas_add_node', {
      path: canvasPath,
      node: { type: 'text', text: 'Node B', x: 300, y: 0, width: 200, height: 100 },
    });
    const nodeBId = (nodeB.structuredContent as { node: { id: string } }).node.id;
    const edge = await h.call('vault_canvas_add_edge', {
      path: canvasPath,
      edge: { fromNode: 'a', toNode: nodeBId, label: 'relates to' },
    });
    expect(edge.structuredContent).toMatchObject({ edge: { fromNode: 'a', toNode: nodeBId } });
    const canvasRead = await h.call('vault_canvas_read', { path: canvasPath });
    const canvasBody = canvasRead.structuredContent as { nodes: unknown[]; edges: unknown[] };
    expect(canvasBody.nodes).toHaveLength(2);
    expect(canvasBody.edges).toHaveLength(1);

    // vault_analytics_summary + vault_analytics_findings — nothing here should lack frontmatter
    const summary = await h.call('vault_analytics_summary', {});
    expect(summary.structuredContent).toMatchObject({
      categories: {
        frontmatter_missing: { count: 0 },
        required_frontmatter_missing: { count: 0 },
      },
    });
    const findings = await h.call('vault_analytics_findings', { category: 'frontmatter_missing' });
    expect(findings.structuredContent).toMatchObject({ category: 'frontmatter_missing', total: 0 });

    // --- Phase 4: graph, safe concurrent writes, transactions, link-updating moves, query ---

    // vault_write two notes: note-d (headings/tags, for outline+section+edit) and note-e
    // (links to note-d by bare basename, for the backlink/move-rewrite check)
    const noteDPath = 'acceptance/graph/note-d.md';
    const noteDContent =
      '---\ntype: test\ntags:\n  - alpha\n  - beta\n---\n\n# Note D\n\n## Intro\n\nIntro text.\n\n## Details\n\nDetails text line.\n';
    const writeD = await h.call('vault_write', { path: noteDPath, content: noteDContent });
    const writeDHash = (writeD.structuredContent as { hash: string }).hash;

    const noteEPath = 'acceptance/graph/note-e.md';
    const noteEContent = '---\ntype: test\n---\n\n# Note E\n\nSee [[note-d]] for background.\n';
    await h.call('vault_write', { path: noteEPath, content: noteEContent });

    // vault_outline on note-d — headings tree, tags, link/backlink counts, hash from the index
    const outline = await h.call('vault_outline', { path: noteDPath });
    const outlineBody = outline.structuredContent as {
      hash: string;
      tags: string[];
      headings: { text: string; children: { text: string }[] }[];
      linkCount: number;
      backlinkCount: number;
    };
    expect([...outlineBody.tags].sort()).toEqual(['alpha', 'beta']);
    expect(outlineBody.headings[0]).toMatchObject({ text: 'Note D' });
    expect(outlineBody.headings[0]?.children.map((c) => c.text)).toEqual(['Intro', 'Details']);
    expect(outlineBody.linkCount).toBe(0);
    expect(outlineBody.backlinkCount).toBe(1);
    expect(outlineBody.hash).toBe(writeDHash);

    // vault_read with "section" — just the "Details" heading's text
    const sectionRead = await h.call('vault_read', { path: noteDPath, section: 'Details' });
    expect(text(sectionRead)).toContain('Details text line.');
    expect(text(sectionRead)).not.toContain('Intro text.');

    // vault_edit with a matching expectedHash — succeeds, returns a fresh hash
    const editWithHash = await h.call('vault_edit', {
      path: noteDPath,
      patches: [{ find: 'Details text line.', replace: 'Details text updated.' }],
      expectedHash: outlineBody.hash,
    });
    expect(editWithHash.isError).toBeFalsy();
    const noteDHashAfterEdit = (editWithHash.structuredContent as { hash: string }).hash;
    expect(noteDHashAfterEdit).not.toBe(outlineBody.hash);

    // The same (now stale) hash again — CONFLICT, carrying the current hash
    const staleEdit = await h.call('vault_edit', {
      path: noteDPath,
      patches: [{ find: 'Note D', replace: 'Note D!' }],
      expectedHash: outlineBody.hash,
    });
    expect(staleEdit.isError).toBe(true);
    expect(text(staleEdit)).toMatch(/^CONFLICT: /);
    expect(staleEdit.structuredContent).toEqual({
      code: 'CONFLICT',
      path: noteDPath,
      currentHash: noteDHashAfterEdit,
    });

    // vault_transaction — two ops (append + frontmatter_update on different files) as one unit
    const tx = await h.call('vault_transaction', {
      ops: [
        { op: 'append', path: noteDPath, content: 'Appended via transaction.' },
        { op: 'frontmatter_update', path: noteEPath, set: { reviewed: true } },
      ],
    });
    expect(tx.isError).toBeFalsy();
    expect(tx.structuredContent).toMatchObject({ applied: true, rolledBack: false });
    expect(await fs.readFile(path.join(h.root, noteDPath), 'utf8')).toContain(
      'Appended via transaction.',
    );
    const noteEAfterTx = await h.call('vault_read', { path: noteEPath });
    expect(noteEAfterTx.structuredContent).toMatchObject({ frontmatter: { reviewed: true } });

    // vault_move note-d to a new path — the bare-basename wikilink in note-e must be rewritten
    const movedDPath = 'acceptance/graph/moved-note-d.md';
    const moveD = await h.call('vault_move', { from: noteDPath, to: movedDPath });
    expect(moveD.isError).toBeFalsy();
    expect(moveD.structuredContent).toMatchObject({
      linksUpdated: [{ path: noteEPath, count: 1 }],
      failed: [],
    });
    const noteERaw = await fs.readFile(path.join(h.root, noteEPath), 'utf8');
    expect(noteERaw).not.toContain('[[note-d]]');
    expect(noteERaw).toContain('[[moved-note-d]]');

    // vault_query — structured filter (tag + pathPrefix) over the in-memory index
    const query = await h.call('vault_query', {
      pathPrefix: 'acceptance/graph',
      tags: { any: ['alpha'] },
    });
    const queryPaths = (query.structuredContent as { rows: { path: string }[] }).rows.map(
      (r) => r.path,
    );
    expect(queryPaths).toEqual([movedDPath]);

    // vault_tags — "alpha" now covers note-a and the moved note-d
    const tags = await h.call('vault_tags', { tag: 'alpha' });
    const tagPaths = (tags.structuredContent as { notes: { path: string }[] }).notes.map(
      (n) => n.path,
    );
    expect(tagPaths).toEqual(expect.arrayContaining(['acceptance/note-a.md', movedDPath]));

    // vault_recent — both graph notes show up under their folder
    const recent = await h.call('vault_recent', { pathPrefix: 'acceptance/graph', limit: 10 });
    const recentPaths = (recent.structuredContent as { rows: { path: string }[] }).rows.map(
      (r) => r.path,
    );
    expect(recentPaths).toEqual(expect.arrayContaining([movedDPath, noteEPath]));

    // vault_delete note-a confirm=true
    const del = await h.call('vault_delete', { path: 'acceptance/note-a.md', confirm: true });
    expect(del.structuredContent).toEqual({ path: 'acceptance/note-a.md', trashed: true });
    const trashedRaw = await fs.readFile(path.join(h.root, '.trash/acceptance/note-a.md'), 'utf8');
    expect(trashedRaw.endsWith('\n')).toBe(true);
    expect(trashedRaw).toContain('Body line changed.');

    // vault_list acceptance
    const finalList = await h.call('vault_list', { path: 'acceptance', depth: 5 });
    const finalPaths = (finalList.structuredContent as { entries: { path: string }[] }).entries.map(
      (e) => e.path,
    );
    expect(finalPaths).toContain('acceptance/board.canvas');
    expect(finalPaths).toContain('acceptance/moved');
    expect(finalPaths).toContain('acceptance/moved/note-b.md');
    expect(finalPaths).not.toContain('acceptance/note-a.md');
  });
});
