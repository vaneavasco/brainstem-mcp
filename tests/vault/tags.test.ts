import { describe, expect, it } from 'vitest';
import { compareCaseInsensitive, isTagOrDescendant } from '../../src/vault/tags.ts';

describe('isTagOrDescendant', () => {
  it('matches the tag itself and nested descendants, never mere prefixes', () => {
    expect(isTagOrDescendant('proj', 'proj')).toBe(true);
    expect(isTagOrDescendant('proj/x', 'proj')).toBe(true);
    expect(isTagOrDescendant('proj/x/y', 'proj')).toBe(true);
    expect(isTagOrDescendant('project', 'proj')).toBe(false);
    expect(isTagOrDescendant('proj', 'proj/x')).toBe(false);
  });
});

describe('compareCaseInsensitive', () => {
  it('orders case-insensitively with a case-sensitive fallback for equal folds', () => {
    expect(compareCaseInsensitive('a.md', 'B.md')).toBeLessThan(0);
    expect(compareCaseInsensitive('B.md', 'a.md')).toBeGreaterThan(0);
    expect(['B.md', 'a.md', 'A.md'].sort(compareCaseInsensitive)).toEqual(['A.md', 'a.md', 'B.md']);
    expect(compareCaseInsensitive('x', 'x')).toBe(0);
  });
});
