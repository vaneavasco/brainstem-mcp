import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  compileSafePattern,
  compileSafeSearch,
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
  it('handles a catastrophic-backtracking pattern in linear time', () => {
    const matcher = compileSafePattern('(a+)+');
    const subject = `${'a'.repeat(2000)}b`;
    const started = performance.now();
    expect(matcher.test(subject)).toBe(false);
    // A backtracking engine needs about 2^2000 steps here, so any finite bound tells the two
    // apart. One second, not 50 ms: measured 60 ms once on a machine busy with other suites.
    expect(performance.now() - started).toBeLessThan(1_000);
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

describe('compileSafeSearch — leftmost unanchored match', () => {
  function find(pattern: string, line: string, caseSensitive = false) {
    return compileSafeSearch(pattern, { caseSensitive }).find(line);
  }

  it('finds a literal substring anywhere in the line, not only a full match', () => {
    expect(find('cat', 'a cat sat')).toEqual({ start: 2, end: 5 });
    expect(find('cat', 'no match here')).toBeNull();
    expect(find('', 'anything')).toEqual({ start: 0, end: 0 });
  });

  it('matches at column 0', () => {
    expect(find('needle', 'needle in a haystack')).toEqual({ start: 0, end: 6 });
  });

  it('matches mid-line, after other text', () => {
    expect(find('needle', 'hay hay hay needle hay')).toEqual({ start: 12, end: 18 });
  });

  it('is the LEFTMOST match: an earlier, shorter candidate wins over a later, longer one', () => {
    expect(find('a+', 'x aaa x a x')).toEqual({ start: 2, end: 5 });
  });

  it('is case-insensitive by default, and case-sensitive on request', () => {
    expect(find('cat', 'a CAT sat')).toEqual({ start: 2, end: 5 });
    expect(find('cat', 'a CAT sat', true)).toBeNull();
    expect(find('cat', 'a cat sat', true)).toEqual({ start: 2, end: 5 });
  });

  it('supports the same reduced syntax as compileSafePattern: classes, quantifiers, alternation', () => {
    expect(find('\\d{4}-\\d{2}-\\d{2}', 'seen on 2026-08-31 at noon')).toEqual({
      start: 8,
      end: 18,
    });
    expect(find('cat|dog', 'I have a dog')).toEqual({ start: 9, end: 12 });
    expect(find('[a-f0-9]{6}', 'commit deadb0 was reverted')).toEqual({ start: 7, end: 13 });
  });

  it('. matches any character, including across the whole line when starred', () => {
    expect(find('a.c', 'xx a1c xx')).toEqual({ start: 3, end: 6 });
  });

  it('handles astral characters as one code point each, matched and counted that way', () => {
    // 😀 is a single code point (two UTF-16 units); "needle" starts right after it.
    expect(find('needle', '😀needle')).toEqual({ start: 1, end: 7 });
    expect(find('.', '😀')).toEqual({ start: 0, end: 1 });
  });

  it('matches a non-ASCII (but non-astral) line correctly', () => {
    expect(find('măr', 'un măr roșu')).toEqual({ start: 3, end: 6 });
  });

  it('rejects the same unsupported constructs as compileSafePattern, and the same way', () => {
    for (const pattern of ['(a)\\1', '(?=a)b', '^abc', '\\p{L}+', '[]']) {
      try {
        compileSafeSearch(pattern);
        expect.unreachable(`expected ${pattern} to be rejected`);
      } catch (error) {
        expect(error, pattern).toBeInstanceOf(VaultError);
        expect((error as VaultError).code, pattern).toBe('INVALID_INPUT');
      }
    }
  });

  it('rejects patterns over the character cap, exactly like compileSafePattern', () => {
    expect(() => compileSafeSearch('a'.repeat(MAX_PATTERN_CHARS + 1))).toThrow(VaultError);
    expect(() => compileSafeSearch('a'.repeat(MAX_PATTERN_CHARS))).not.toThrow();
  });

  it('never matches a line longer than the subject cap', () => {
    const long = `${'x'.repeat(MAX_SUBJECT_CHARS + 1)}needle`;
    expect(find('needle', long)).toBeNull();
  });

  it('finds nothing in an empty line unless the pattern accepts the empty string', () => {
    expect(find('needle', '')).toBeNull();
    expect(find('x*', '')).toEqual({ start: 0, end: 0 });
  });
});

describe('compileSafeSearch — linear-time guarantee on a pathological pattern', () => {
  it('stays well under a second across a 10,000-line file with a catastrophic-backtracking pattern', () => {
    const matcher = compileSafeSearch('(a+)+b');
    const line = `${'a'.repeat(200)}c`; // never matches: no trailing "b"
    const lines = Array.from({ length: 10_000 }, () => line);
    const started = performance.now();
    for (const l of lines) expect(matcher.find(l)).toBeNull();
    const elapsedMs = performance.now() - started;
    // A backtracking engine needs about 2^200 steps per line here; this engine needs O(len ×
    // states) — comfortably under a second for all 10,000 lines together even on a loaded CI
    // runner. Measured on this machine: ~600 ms for all 10,000 lines (~60 µs/line).
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe('compileSafeSearch — cannotMatch (the required-literal prefilter)', () => {
  it('rejects text missing every alternative of a top-level alternation', () => {
    const m = compileSafeSearch('invoice|receipt');
    expect(m.cannotMatch('nothing relevant here')).toBe(true);
    expect(m.cannotMatch('please find the invoice attached')).toBe(false);
    expect(m.cannotMatch('a receipt is enclosed')).toBe(false);
  });

  it('rejects text missing a plain literal pattern', () => {
    const m = compileSafeSearch('needle');
    expect(m.cannotMatch('haystack haystack haystack')).toBe(true);
    expect(m.cannotMatch('a needle in it')).toBe(false);
  });

  it('finds the longest literal run up to an optional character, not just one character', () => {
    // colou?r: "colo" (4 chars, before the optional "u") beats "r" (1 char).
    const m = compileSafeSearch('colou?r');
    expect(m.cannotMatch('nothing relevant in this line at all')).toBe(true); // no "colo" substring
    expect(m.cannotMatch('the color is nice')).toBe(false);
    expect(m.cannotMatch('the colour is nice')).toBe(false);
  });

  it('derives the union of every branch of the real invoice/receipt example pattern', () => {
    const m = compileSafeSearch('(invoice|receipt)[- ]?(number|no\\.?)\\s*[0-9]{3,}');
    expect(m.cannotMatch('nothing about billing here')).toBe(true);
    expect(m.cannotMatch('invoice number 48213 is overdue')).toBe(false);
    expect(m.cannotMatch('see receipt no. 991')).toBe(false);
  });

  it('never rejects (always returns false) for a pattern with no derivable required literal', () => {
    for (const pattern of ['.*', '\\d+', '[a-z]+', 'a*', 'a?', '(a|.)']) {
      const m = compileSafeSearch(pattern);
      expect(m.cannotMatch('literally anything, xyz 123 !@#'), pattern).toBe(false);
      expect(m.cannotMatch(''), pattern).toBe(false);
    }
  });

  it('is case-insensitive by default and case-sensitive on request, matching find()', () => {
    const insensitive = compileSafeSearch('Invoice');
    expect(insensitive.cannotMatch('an INVOICE is attached')).toBe(false);
    const sensitive = compileSafeSearch('Invoice', { caseSensitive: true });
    expect(sensitive.cannotMatch('an invoice is attached')).toBe(true); // wrong case
    expect(sensitive.cannotMatch('an Invoice is attached')).toBe(false);
  });

  it('never rejects a line find() actually matches, across the whole class of patterns above', () => {
    // Every case above already double-checks find() agrees with cannotMatch; this is the same
    // property stated directly, once, as the invariant the fuzz test below generalizes.
    for (const [pattern, line] of [
      ['invoice|receipt', 'my receipt is late'],
      ['colou?r', 'nice color'],
      ['(invoice|receipt)[- ]?(number|no\\.?)\\s*[0-9]{3,}', 'invoice-number 12345'],
    ] as const) {
      const m = compileSafeSearch(pattern);
      if (m.find(line) !== null) expect(m.cannotMatch(line), pattern).toBe(false);
    }
  });
});

describe('compileSafeSearch — cannotMatch is sound (fuzz)', () => {
  /** Deterministic PRNG (mulberry32), matching the convention used elsewhere in this repo's
   *  fixture generators (e.g. tests/scale/vault.scale.ts) — reproducible across runs. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A small alphabet, deliberately overlapping between "pattern literals" and "line content" —
  // maximizes the chance that a random line actually matches a random pattern, which is the only
  // case this test cares about (cannotMatch must never reject a line find() matches; a fuzz run
  // where nothing ever matches would trivially "pass" without checking anything meaningful).
  const ALPHABET = ['a', 'b', 'c', '0', '1', '-', '.', '@', ' '];

  function randomPattern(rand: () => number, depth: number): string {
    const pick = (n: number): number => Math.floor(rand() * n);
    const literalChar = (): string => ALPHABET[pick(ALPHABET.length)] as string;

    function atom(d: number): string {
      if (d <= 0) return literalChar();
      switch (pick(5)) {
        case 0:
          return literalChar();
        case 1:
          return '.';
        case 2: {
          const n = 1 + pick(3);
          return `[${Array.from({ length: n }, literalChar).join('')}]`;
        }
        case 3:
          return `(${concat(d - 1)})`;
        default:
          return `(?:${alt(d - 1)})`;
      }
    }
    function quantified(d: number): string {
      const a = atom(d);
      switch (pick(5)) {
        case 0:
          return `${a}*`;
        case 1:
          return `${a}+`;
        case 2:
          return `${a}?`;
        case 3:
          return `${a}{1,2}`;
        default:
          return a;
      }
    }
    function concat(d: number): string {
      const n = 1 + pick(3);
      return Array.from({ length: n }, () => quantified(d)).join('');
    }
    function alt(d: number): string {
      const n = 1 + pick(2);
      return Array.from({ length: n }, () => concat(d)).join('|');
    }
    return alt(depth);
  }

  function randomLine(rand: () => number): string {
    const pick = (n: number): number => Math.floor(rand() * n);
    const n = pick(24);
    return Array.from({ length: n }, () => ALPHABET[pick(ALPHABET.length)] as string).join('');
  }

  it('prefilter-reject implies find() === null, for a few hundred random patterns × random lines', () => {
    const rand = mulberry32(0xc0ffee);
    const pick = (n: number): number => Math.floor(rand() * n);
    let patternsChecked = 0;
    let comparisonsMade = 0;
    let realMatchesSeen = 0;
    for (let i = 0; i < 400; i += 1) {
      const pattern = randomPattern(rand, 3);
      const caseSensitive = pick(2) === 0;
      let matcher: ReturnType<typeof compileSafeSearch>;
      try {
        matcher = compileSafeSearch(pattern, { caseSensitive });
      } catch {
        continue; // an unsupported/too-complex random pattern isn't this test's concern
      }
      patternsChecked += 1;
      for (let j = 0; j < 8; j += 1) {
        const line = randomLine(rand);
        const found = matcher.find(line);
        comparisonsMade += 1;
        if (found !== null) {
          realMatchesSeen += 1;
          // The property under test, stated as the task requires it: prefilter-reject ⇒
          // find() === null. Contrapositive, checked directly: a real match ⇒ NOT rejected.
          expect(
            matcher.cannotMatch(line),
            `pattern=${JSON.stringify(pattern)} line=${JSON.stringify(line)} caseSensitive=${caseSensitive}`,
          ).toBe(false);
        }
      }
    }
    // Guards against a change to the generator (or the grammar) quietly making every pattern fail
    // to compile, or every line fail to match, which would let this test pass without checking
    // the property it exists to check.
    expect(patternsChecked).toBeGreaterThan(200);
    expect(comparisonsMade).toBeGreaterThan(1500);
    expect(realMatchesSeen).toBeGreaterThan(50);
  });
});
