import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  compileSafePattern,
  MAX_PATTERN_CHARS,
  MAX_SUBJECT_CHARS,
} from '../../src/vault/safe-regex.ts';

/** `pattern` matched against `subject` — full-match semantics, case-insensitive. */
function m(pattern: string, subject: string): boolean {
  return compileSafePattern(pattern).test(subject);
}

function rejects(pattern: string): void {
  try {
    compileSafePattern(pattern);
    expect.unreachable(`expected ${pattern} to be rejected`);
  } catch (error) {
    expect(error, pattern).toBeInstanceOf(VaultError);
    expect((error as VaultError).code, pattern).toBe('INVALID_INPUT');
  }
}

describe('compileSafePattern — matching', () => {
  it('matches literals as a full match, not a substring', () => {
    expect(m('abc', 'abc')).toBe(true);
    expect(m('b', 'abc')).toBe(false);
    expect(m('ab', 'abc')).toBe(false);
    expect(m('abc', '')).toBe(false);
    expect(m('', '')).toBe(true);
    expect(m('', 'a')).toBe(false);
  });

  it('. matches any single character (newline included)', () => {
    expect(m('a.c', 'abc')).toBe(true);
    expect(m('a.c', 'a\nc')).toBe(true);
    expect(m('a.c', 'ac')).toBe(false);
    expect(m('.*', 'anything at all')).toBe(true);
  });

  it('character classes: sets, ranges, negation and shorthands', () => {
    expect(m('[abc]+', 'cab')).toBe(true);
    expect(m('[abc]+', 'cad')).toBe(false);
    expect(m('[^abc]+', 'xyz')).toBe(true);
    expect(m('[^abc]+', 'xay')).toBe(false);
    expect(m('[a-f0-9]{6}', 'deadb0')).toBe(true);
    expect(m('[a-f0-9]{6}', 'zeadb0')).toBe(false);
  });

  it('shorthand classes and their negations', () => {
    expect(m('\\d{4}-\\d{2}-\\d{2}', '2026-08-31')).toBe(true);
    expect(m('\\d{4}', '20x6')).toBe(false);
    expect(m('\\w+', 'a_9Z')).toBe(true);
    expect(m('\\w+', 'a b')).toBe(false);
    expect(m('a\\sb', 'a b')).toBe(true);
    expect(m('\\D+', 'abc')).toBe(true);
    expect(m('\\D+', 'ab1')).toBe(false);
    expect(m('\\S+', 'abc')).toBe(true);
    expect(m('[\\d.]+', '1.5')).toBe(true);
  });

  it('alternation and grouping', () => {
    expect(m('cat|dog', 'dog')).toBe(true);
    expect(m('cat|dog', 'cats')).toBe(false);
    expect(m('(ab)+c', 'ababc')).toBe(true);
    expect(m('(ab)+c', 'abac')).toBe(false);
    expect(m('(?:ab)+c', 'ababc')).toBe(true);
    expect(m('a(b|c)d', 'acd')).toBe(true);
  });

  it('quantifiers * + ? {m} {m,} {m,n}', () => {
    expect(m('ab*', 'a')).toBe(true);
    expect(m('ab*', 'abbb')).toBe(true);
    expect(m('ab+', 'a')).toBe(false);
    expect(m('ab?c', 'ac')).toBe(true);
    expect(m('a{3}', 'aaa')).toBe(true);
    expect(m('a{3}', 'aa')).toBe(false);
    expect(m('a{2,}', 'aaaaa')).toBe(true);
    expect(m('a{2,}', 'a')).toBe(false);
    expect(m('a{2,4}', 'aaa')).toBe(true);
    expect(m('a{2,4}', 'aaaaa')).toBe(false);
    expect(m('a{0,2}', '')).toBe(true);
  });

  it('is case-insensitive for literals and classes, with JS negation semantics', () => {
    expect(m('active', 'ACTIVE')).toBe(true);
    expect(m('ACTIVE', 'Active')).toBe(true);
    expect(m('[a-z]+', 'ABC')).toBe(true);
    expect(m('[A-Z]+', 'abc')).toBe(true);
    // /[^A-Z]/i.test('a') is false in JS: the case variant 'A' is in the inner set.
    expect(m('[^A-Z]+', 'abc')).toBe(false);
    expect(m('[^A-Z]+', '123')).toBe(true);
  });

  it('escapes make metacharacters literal', () => {
    expect(m('a\\.b', 'a.b')).toBe(true);
    expect(m('a\\.b', 'axb')).toBe(false);
    expect(m('a\\*', 'a*')).toBe(true);
    expect(m('\\[x\\]', '[x]')).toBe(true);
    expect(m('a\\\\b', 'a\\b')).toBe(true);
    expect(m('a\\tb', 'a\tb')).toBe(true);
  });

  it('matches realistic frontmatter values', () => {
    expect(m('v\\d+\\.\\d+(\\.\\d+)?', 'v1.20.3')).toBe(true);
    expect(m('(draft|active|done)', 'Done')).toBe(true);
    expect(m('notes/.*', 'notes/a.md')).toBe(true);
    expect(m('notes/.*', 'archive/a.md')).toBe(false);
  });
});

describe('compileSafePattern — rejections', () => {
  it('rejects backreferences, lookarounds, named groups and inline flags', () => {
    rejects('(a)\\1');
    rejects('(?=a)b');
    rejects('(?!a)b');
    rejects('(?<=a)b');
    rejects('(?<!a)b');
    rejects('(?<name>a)');
    rejects('(?i)abc');
    rejects('(?i:abc)');
  });

  it('rejects explicit anchors — matching is always full-match', () => {
    rejects('^abc');
    rejects('abc$');
    rejects('a^b');
  });

  it('rejects unsupported escapes and unicode property classes', () => {
    rejects('\\b(word)');
    rejects('\\p{L}+');
    rejects('\\u0041');
    rejects('\\x41');
    rejects('a\\');
  });

  it('rejects malformed structure', () => {
    rejects('(ab');
    rejects('ab)');
    rejects('[abc');
    rejects('[]');
    rejects('[z-a]');
    rejects('*a');
    rejects('a**');
    rejects('a*?');
    rejects('{2}');
    rejects('a{');
    rejects('a{x}');
  });

  it('rejects patterns over the character cap', () => {
    rejects('a'.repeat(MAX_PATTERN_CHARS + 1));
    expect(() => compileSafePattern('a'.repeat(MAX_PATTERN_CHARS))).not.toThrow();
  });

  it('rejects repetition counts above 100 and inverted ranges', () => {
    rejects('a{101}');
    rejects('a{0,101}');
    rejects('a{3,2}');
    expect(() => compileSafePattern('a{100}')).not.toThrow();
  });

  it('rejects a pattern that would explode into too many NFA states', () => {
    rejects('((a{100}){100}){100}');
  });
});

describe('compileSafePattern — linear-time guarantee', () => {
  it('handles a catastrophic-backtracking pattern in well under 50 ms', () => {
    const matcher = compileSafePattern('(a+)+');
    const subject = `${'a'.repeat(2000)}b`;
    const started = performance.now();
    expect(matcher.test(subject)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('never matches a subject longer than the subject cap', () => {
    const matcher = compileSafePattern('a*');
    expect(matcher.test('a'.repeat(MAX_SUBJECT_CHARS))).toBe(true);
    expect(matcher.test('a'.repeat(MAX_SUBJECT_CHARS + 1))).toBe(false);
  });
});

describe('subject cap is counted in code points', () => {
  it('accepts an astral-heavy subject whose UTF-16 length exceeds the cap', () => {
    const matcher = compileSafePattern('.*');
    // 2×cap UTF-16 units, exactly cap code points — must be within the cap.
    expect(matcher.test('😀'.repeat(MAX_SUBJECT_CHARS))).toBe(true);
    expect(matcher.test('😀'.repeat(MAX_SUBJECT_CHARS + 1))).toBe(false);
    expect(matcher.test('a'.repeat(MAX_SUBJECT_CHARS))).toBe(true);
    expect(matcher.test('a'.repeat(MAX_SUBJECT_CHARS + 1))).toBe(false);
  });
});
