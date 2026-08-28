import { describe, expect, it } from 'vitest';
import {
  applyFrontmatterUpdate,
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from '../../src/storage/frontmatter.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('splitFrontmatter', () => {
  it('parses a YAML block and returns the body without it', () => {
    const text = '---\ntitle: Plan\ntags:\n  - a\n  - b\nstatus: active\n---\n# Heading\n\nBody.\n';
    const r = splitFrontmatter(text);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter).toEqual({ title: 'Plan', tags: ['a', 'b'], status: 'active' });
    expect(r.body).toBe('# Heading\n\nBody.\n');
  });

  it('treats text without a leading --- as body only', () => {
    const r = splitFrontmatter('# Just a note\n---\nnot frontmatter\n');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('# Just a note\n---\nnot frontmatter\n');
  });

  it('accepts CRLF line endings and an empty block', () => {
    expect(splitFrontmatter('---\r\ntitle: X\r\n---\r\nbody').frontmatter).toEqual({ title: 'X' });
    const empty = splitFrontmatter('---\n---\nbody\n');
    expect(empty.hasFrontmatter).toBe(true);
    expect(empty.frontmatter).toEqual({});
    expect(empty.body).toBe('body\n');
  });

  it('rejects invalid YAML and non-object frontmatter with INVALID_INPUT', () => {
    expect(() => splitFrontmatter('---\ntitle: [unclosed\n---\nbody')).toThrow(VaultError);
    let err: unknown;
    try {
      splitFrontmatter('---\n- just\n- a list\n---\nbody');
    } catch (e) {
      err = e;
    }
    expect((err as VaultError).code).toBe('INVALID_INPUT');
  });

  it('keeps dates as strings rather than JS Date objects', () => {
    const r = splitFrontmatter('---\ncreated: 2026-08-28\n---\n');
    expect(r.frontmatter.created).toBe('2026-08-28');
  });
});

describe('joinFrontmatter', () => {
  it('round-trips preserving key order and omits the block when empty', () => {
    const fm = { title: 'Plan', tags: ['a', 'b'], nested: { k: 1 } };
    const text = joinFrontmatter(fm, 'Body\n');
    expect(
      text.startsWith('---\ntitle: Plan\ntags:\n  - a\n  - b\nnested:\n  k: 1\n---\nBody\n'),
    ).toBe(true);
    expect(splitFrontmatter(text).frontmatter).toEqual(fm);
    expect(joinFrontmatter({}, 'Body\n')).toBe('Body\n');
  });
});

describe('mergeFrontmatter / applyFrontmatterUpdate', () => {
  it('merges shallowly with incoming keys winning and existing order kept', () => {
    const merged = mergeFrontmatter({ a: 1, b: 2, c: 3 }, { b: 20, d: 4 });
    expect(Object.keys(merged)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged).toEqual({ a: 1, b: 20, c: 3, d: 4 });
  });

  it('applies set and unset without touching other keys', () => {
    const out = applyFrontmatterUpdate({ a: 1, b: 2 }, { c: 3, a: 10 }, ['b', 'zzz']);
    expect(out).toEqual({ a: 10, c: 3 });
  });
});
