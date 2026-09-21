import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';

/** sha256 of every file under `root`, keyed by its path relative to `root` — `_brainstem/` is
 *  left out on purpose: its OAuth token store keeps ticking (lastUsedAt) on every authenticated
 *  call regardless of read-only mode (AGENTS.md: "the OAuth token store ... is NOT vault content
 *  for this purpose"), so it is server state, not the vault content this test protects. */
async function hashVaultFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (rel === '' && entry.name === '_brainstem') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        out[relPath] = createHash('sha256')
          .update(await fs.readFile(abs))
          .digest('hex');
      }
    }
  }
  await walk(root, '');
  return out;
}

let normal: Harness;
let fullNames: string[];
let readOnlyNames: string[];

beforeAll(async () => {
  normal = await startHarness();
  const { tools } = await normal.client.listTools();
  fullNames = tools.map((t) => t.name).sort();
  // Computed from the normal-mode listing's own annotations, never a literal list here: that is
  // exactly what a read-only server must not drift from (see src/tools/register.ts).
  readOnlyNames = tools
    .filter((t) => t.annotations?.readOnlyHint === true)
    .map((t) => t.name)
    .sort();
});

afterAll(async () => {
  await normal.close();
});

describe('read-only mode (tests/tools/harness.ts readOnly flag)', () => {
  it('registers exactly the tools annotated readOnlyHint: true in normal mode, and none other', async () => {
    const ro = await startHarness(undefined, null, undefined, undefined, true);
    try {
      const { tools } = await ro.client.listTools();
      expect(readOnlyNames.length).toBeGreaterThan(0);
      expect(readOnlyNames.length).toBeLessThan(fullNames.length);
      expect(tools.map((t) => t.name).sort()).toEqual(readOnlyNames);
    } finally {
      await ro.close();
    }
  });

  it('brainstem_ping reports readOnly: true, and false in normal mode', async () => {
    const ro = await startHarness(undefined, null, undefined, undefined, true);
    try {
      const roPing = await ro.call('brainstem_ping');
      expect((roPing.structuredContent as { readOnly: boolean }).readOnly).toBe(true);
      const normalPing = await normal.call('brainstem_ping');
      expect((normalPing.structuredContent as { readOnly: boolean }).readOnly).toBe(false);
    } finally {
      await ro.close();
    }
  });

  it('adds one read-only sentence to the connection instructions', async () => {
    const ro = await startHarness(undefined, null, undefined, undefined, true);
    try {
      const instructions = ro.client.getInstructions() ?? '';
      expect(instructions.toLowerCase()).toContain('read-only');
      const normalInstructions = normal.client.getInstructions() ?? '';
      expect(normalInstructions.toLowerCase()).not.toContain('read-only');
    } finally {
      await ro.close();
    }
  });

  it('every tool absent from the read-only list fails as an unknown tool when called', async () => {
    const ro = await startHarness(undefined, null, undefined, undefined, true);
    try {
      const missing = fullNames.filter((n) => !readOnlyNames.includes(n));
      expect(missing.length).toBeGreaterThan(0);
      for (const name of missing) {
        await expect(ro.call(name, {})).rejects.toThrow(/not found/i);
      }
    } finally {
      await ro.close();
    }
  });

  it('leaves every vault file byte-identical after calling every read-only tool once with plausible arguments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-readonly-'));
    const today = new Date().toISOString().slice(0, 10); // default daily-note format/timezone
    await fs.writeFile(
      path.join(root, 'note.md'),
      '---\ntype: note\n---\n# Note\nalpha body text\n',
    );
    await fs.writeFile(path.join(root, 'board.canvas'), '{"nodes":[],"edges":[]}');
    await fs.writeFile(path.join(root, `${today}.md`), '---\ntype: daily\n---\n# Today\n');

    const ro = await startHarness(undefined, null, root, undefined, true);
    try {
      const before = await hashVaultFiles(root);

      const calls: [string, Record<string, unknown>][] = [
        ['brainstem_ping', {}],
        ['brainstem_guide', {}],
        ['vault_analytics_summary', {}],
        ['vault_analytics_findings', { category: 'orphan_notes' }],
        ['vault_batch_read', { paths: ['note.md'] }],
        ['vault_canvas_read', { path: 'board.canvas' }],
        ['vault_daily_note_path', {}],
        ['vault_daily_note_read', {}],
        ['vault_links', { path: 'note.md' }],
        ['vault_list', {}],
        ['vault_outline', { path: 'note.md' }],
        ['vault_query', {}],
        ['vault_read', { path: 'note.md' }],
        ['vault_recent', {}],
        ['vault_search', { query: 'alpha' }],
        ['vault_search_frontmatter', { field: 'type', exists: true }],
        ['vault_tags', {}],
      ];
      // Every read-only tool is covered, and nothing extra: keeps this list honest against drift.
      expect(calls.map(([name]) => name).sort()).toEqual(readOnlyNames);

      for (const [name, args] of calls) {
        const result = await ro.call(name, args);
        expect(result.isError, name).toBeFalsy();
      }

      const after = await hashVaultFiles(root);
      expect(after).toEqual(before);
    } finally {
      await ro.close();
    }
  });
});
