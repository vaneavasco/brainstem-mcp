import { describe, expect, it } from 'vitest';
import { foldPath, suggestPaths } from '../../src/vault/path-suggest.ts';

describe('foldPath', () => {
  it('folds typographic apostrophes and quotes to ASCII', () => {
    expect(foldPath('people/Alpha’s note.md')).toBe(foldPath("people/Alpha's note.md"));
  });

  it('folds en/em dashes and the non-breaking hyphen to a plain hyphen', () => {
    expect(foldPath('notes/alpha–beta.md')).toBe(foldPath('notes/alpha-beta.md'));
    expect(foldPath('notes/alpha—beta.md')).toBe(foldPath('notes/alpha-beta.md'));
    expect(foldPath('notes/alpha‑beta.md')).toBe(foldPath('notes/alpha-beta.md'));
  });

  it('folds non-breaking and repeated spaces to one space', () => {
    expect(foldPath('notes/alpha beta.md')).toBe(foldPath('notes/alpha beta.md'));
    expect(foldPath('notes/alpha   beta.md')).toBe(foldPath('notes/alpha beta.md'));
  });

  it('is case-insensitive and applies Unicode NFKC', () => {
    expect(foldPath('Notes/ALPHA.md')).toBe(foldPath('notes/alpha.md'));
  });
});

describe('suggestPaths', () => {
  const index = [
    'people/Alpha’s note.md',
    'people/other.md',
    'notes/alpha-beta.md',
    'notes/unrelated.md',
    '_brainstem/tx/should-not-appear.md',
    '.obsidian/should-not-appear.md',
  ];

  it('finds an exact match once both sides are folded (curly vs straight apostrophe)', () => {
    expect(suggestPaths(index, "people/Alpha's note.md")).toEqual(['people/Alpha’s note.md']);
  });

  it('finds an exact match across an en dash vs a hyphen', () => {
    expect(suggestPaths(index, 'notes/alpha–beta.md')).toEqual(['notes/alpha-beta.md']);
  });

  it('finds an exact match regardless of case', () => {
    expect(suggestPaths(index, 'PEOPLE/OTHER.MD')).toEqual(['people/other.md']);
  });

  it('keeps folder specificity: a same-named file in a different folder is not suggested', () => {
    const twoFolders = ['notes/plan.md', 'archive/plan.md'];
    expect(suggestPaths(twoFolders, 'notes/Plan.md')).toEqual(['notes/plan.md']);
  });

  it('returns nothing for a path that simply does not exist', () => {
    expect(suggestPaths(index, 'nowhere/nothing.md')).toEqual([]);
  });

  it('caps at max (default 3)', () => {
    const dup = ['n/X.md', 'N/X.MD', 'n/X.MD', 'n/X.Md'];
    expect(suggestPaths(dup, 'n/x.md').length).toBeLessThanOrEqual(3);
    expect(suggestPaths(dup, 'n/x.md', 2)).toHaveLength(2);
  });

  it('never suggests a path under _brainstem/ or a dot folder, even if handed one', () => {
    const withReserved = [
      'people/Alpha’s note.md',
      '_brainstem/tx/Alpha’s note.md',
      '.trash/Alpha’s note.md',
    ];
    const found = suggestPaths(withReserved, "people/Alpha's note.md");
    expect(found).toEqual(['people/Alpha’s note.md']);
    expect(found.some((p) => p.startsWith('_brainstem/') || p.startsWith('.trash/'))).toBe(false);
  });
});
