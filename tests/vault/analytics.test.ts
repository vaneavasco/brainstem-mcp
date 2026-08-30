import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { analyzeVault } from '../../src/vault/analytics.ts';
import { FrontmatterIndex } from '../../src/vault/frontmatter-index.ts';
import { VaultGraph } from '../../src/vault/graph.ts';

/** Builds a fresh graph reflecting the vault's current contents, for tests that write files after
 *  the shared beforeEach fixture and then call analyzeVault. */
async function buildGraph(v: LocalFSAdapter): Promise<VaultGraph> {
  return new VaultGraph(await FrontmatterIndex.build(v));
}

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-analytics-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await vault.write(
    'ok.md',
    '---\ntype: note\ntags: [second-brain]\n---\nSee [[Target]] and [[sub/deep|alias]] and [[Target#Heading]].\n',
  );
  await vault.write(
    'Target.md',
    '---\ntype: note\ntags: [Second_Brain]\n---\n#secondbrain inline tag\n',
  );
  await vault.write('sub/deep.md', 'no frontmatter, links to [[missing-note]] and ![[img.png]]\n');
  await vault.write('big.md', `---\ntype: note\n---\n${'x'.repeat(600_000)}\n`);
  await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41]));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('analyzeVault', () => {
  it('produces counts, examples and detailed findings per category', async () => {
    const { summary, findings } = await analyzeVault(vault, {
      requiredFrontmatter: ['type', 'status'],
      graph: await buildGraph(vault),
    });
    expect(summary.scannedFiles).toBe(5);
    expect(summary.truncated).toBe(false);

    expect(summary.categories.frontmatter_missing).toEqual({ count: 1, examples: ['sub/deep.md'] });
    // ok.md, Target.md, big.md have type but not status; sub/deep.md has neither
    expect(summary.categories.required_frontmatter_missing.count).toBe(4);
    expect(summary.categories.broken_wikilinks).toEqual({ count: 2, examples: ['sub/deep.md'] });
    expect(findings.filter((f) => f.category === 'broken_wikilinks').map((f) => f.detail)).toEqual([
      'missing-note',
      'img.png',
    ]);
    expect(summary.categories.suspicious_tag_variants.count).toBe(1);
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain(
      'second-brain',
    );
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain(
      'Second_Brain',
    );
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain(
      'secondbrain',
    );
    expect(summary.categories.encoding_issues).toEqual({ count: 1, examples: ['bad.md'] });
    expect(summary.categories.oversized_files).toEqual({ count: 1, examples: ['big.md'] });
  });

  it('resolves links case-insensitively, with or without .md, by path or basename', async () => {
    await vault.write(
      'links.md',
      '[[target]] [[TARGET.md]] [[sub/deep.md]] [[deep]] [[Sub/Deep]]\n',
    );
    const { findings } = await analyzeVault(vault, { graph: await buildGraph(vault) });
    expect(
      findings.filter((f) => f.category === 'broken_wikilinks' && f.path === 'links.md'),
    ).toEqual([]);
  });

  it('honors the oversized threshold option and defaults requiredFrontmatter to none', async () => {
    const { summary } = await analyzeVault(vault, {
      oversizedBytes: 10,
      graph: await buildGraph(vault),
    });
    expect(summary.categories.oversized_files.count).toBeGreaterThanOrEqual(4);
    expect(summary.categories.required_frontmatter_missing.count).toBe(0);
  });

  it('does not treat a wikilink target split across lines as a broken link', async () => {
    await vault.write('multiline.md', 'See [[a\nb]] here.\n');
    const { findings } = await analyzeVault(vault, { graph: await buildGraph(vault) });
    expect(
      findings.filter((f) => f.category === 'broken_wikilinks' && f.path === 'multiline.md'),
    ).toEqual([]);
  });

  it('derives ambiguous_links and orphan_notes from the graph, and lists top hubs in the summary', async () => {
    await vault.write('note-a.md', '[[note-b]]\n');
    await vault.write('note-b.md', 'x');
    await vault.write('alpha.md', 'x');
    await vault.write('nested/alpha.md', 'x');
    await vault.write('linker.md', '[[alpha]]\n');
    await vault.write('lonely-note.md', 'nothing here\n');
    await vault.write('daily/2026-08-29.md', 'nothing here either\n');

    const { summary, findings } = await analyzeVault(vault, {
      graph: await buildGraph(vault),
      dailyNotesFolder: 'daily',
    });

    expect(findings.filter((f) => f.category === 'ambiguous_links')).toEqual([
      {
        category: 'ambiguous_links',
        path: 'linker.md',
        detail: 'alpha → alpha.md, nested/alpha.md',
      },
    ]);

    const orphanPaths = findings.filter((f) => f.category === 'orphan_notes').map((f) => f.path);
    expect(orphanPaths).toContain('lonely-note.md');
    expect(orphanPaths).not.toContain('daily/2026-08-29.md');

    const noteBHub = summary.hubs.find((h) => h.path === 'note-b.md');
    expect(noteBHub).toEqual({ path: 'note-b.md', backlinks: 1 });
  });
});
