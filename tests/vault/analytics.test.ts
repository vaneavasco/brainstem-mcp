import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { analyzeVault } from '../../src/vault/analytics.ts';

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
    const { findings } = await analyzeVault(vault);
    expect(
      findings.filter((f) => f.category === 'broken_wikilinks' && f.path === 'links.md'),
    ).toEqual([]);
  });

  it('honors the oversized threshold option and defaults requiredFrontmatter to none', async () => {
    const { summary } = await analyzeVault(vault, { oversizedBytes: 10 });
    expect(summary.categories.oversized_files.count).toBeGreaterThanOrEqual(4);
    expect(summary.categories.required_frontmatter_missing.count).toBe(0);
  });

  it('does not treat a wikilink target split across lines as a broken link', async () => {
    await vault.write('multiline.md', 'See [[a\nb]] here.\n');
    const { findings } = await analyzeVault(vault);
    expect(
      findings.filter((f) => f.category === 'broken_wikilinks' && f.path === 'multiline.md'),
    ).toEqual([]);
  });
});
