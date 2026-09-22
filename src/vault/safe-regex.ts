import { VaultError } from '../storage/types.ts';

/**
 * A linear-time regular-expression matcher over a deliberately reduced syntax.
 *
 * `vault_query`/`vault_search`'s `where` conditions run their `regex` op against every indexed
 * note on the event loop, so a JavaScript `RegExp` is not usable here: its backtracking engine
 * turns a pattern like `(a+)+` into exponential time (seconds of a hung server for a few dozen
 * characters). This module compiles the pattern into a Thompson NFA and simulates it over the
 * subject one character at a time, keeping the whole state set alive — O(len(subject) × states),
 * with no backtracking and therefore no ReDoS.
 *
 * Supported syntax: literals, `.`, character classes `[...]`/`[^...]` (ranges, `\d \w \s` and
 * their negations), quantifiers `* + ? {m} {m,} {m,n}`, alternation `|`, grouping `(...)` and
 * `(?:...)`, and backslash escapes of the metacharacters plus `\t \n \r`.
 *
 * Everything else is rejected with `INVALID_INPUT` rather than reinterpreted: backreferences,
 * lookarounds, named groups, inline flags, unicode property escapes, `^`/`$` (matching is always
 * a FULL match — the pattern is implicitly anchored at both ends, per the design spec's "regex is
 * anchored to the value"), and any pattern that would expand past the state cap.
 *
 * Matching is case-insensitive: a subject character matches when any of its case variants is in
 * the pattern's set, with negation applied afterwards, so `[^A-Z]` rejects 'a' exactly as
 * `/^[^A-Z]$/i` does.
 *
 * `.` and every character set consume one code point, so an astral character (e.g. an emoji)
 * counts as a single character — a deliberate divergence from JavaScript's non-`u` `RegExp`,
 * which sees two surrogate halves.
 */

/** Longest accepted pattern; mirrors `MAX_SEARCH_PATTERN_CHARS` for ripgrep-backed search. */
export const MAX_PATTERN_CHARS = 200;
/** Largest accepted repetition count in `{m}`, `{m,}` and `{m,n}`. */
export const MAX_REPEAT = 100;
/** Compile-time ceiling on the NFA; counted repetition is expanded, so this is what stops a short
 *  pattern such as `((a{100}){100}){100}` from building a million states. */
export const MAX_NFA_STATES = 5000;
/** Subjects longer than this never match — a query value that big is not a regex target.
 *  Counted in Unicode code points, the unit the matcher consumes (an astral character counts
 *  once, not twice). */
export const MAX_SUBJECT_CHARS = 2048;

function invalid(message: string): VaultError {
  return new VaultError('INVALID_INPUT', message);
}

// ---------------------------------------------------------------- character sets

type ClassName = 'd' | 'D' | 'w' | 'W' | 's' | 'S';

type SetItem = { type: 'range'; from: number; to: number } | { type: 'class'; name: ClassName };

/** A single-character matcher. `negated: true` with no items is `.` (matches any character). */
interface CharSet {
  negated: boolean;
  items: SetItem[];
}

const DIGIT = /[0-9]/;
const WORD = /[A-Za-z0-9_]/;
const SPACE = /\s/;
const CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S']);
const ESCAPABLE_PUNCTUATION = new Set([
  '\\',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '^',
  '$',
  '-',
  '/',
]);

function classMatches(name: ClassName, ch: string): boolean {
  switch (name) {
    case 'd':
      return DIGIT.test(ch);
    case 'D':
      return !DIGIT.test(ch);
    case 'w':
      return WORD.test(ch);
    case 'W':
      return !WORD.test(ch);
    case 's':
      return SPACE.test(ch);
    default:
      return !SPACE.test(ch);
  }
}

function itemsMatch(items: SetItem[], ch: string): boolean {
  const cp = ch.codePointAt(0) ?? -1;
  for (const item of items) {
    if (item.type === 'range') {
      if (cp >= item.from && cp <= item.to) return true;
    } else if (classMatches(item.name, ch)) return true;
  }
  return false;
}

/** Case-insensitive membership: the character matches when ANY of its case variants is in the
 *  *inner* set; negation is applied only afterwards (testing variants against an already-negated
 *  set would make `[^A-Z]` accept 'a', which JavaScript's own `i` flag does not). */
function setMatches(set: CharSet, variants: string[]): boolean {
  let member = false;
  for (const v of variants) {
    if (itemsMatch(set.items, v)) {
      member = true;
      break;
    }
  }
  return set.negated ? !member : member;
}

/** The character plus its single-character case variants ('ß'.toUpperCase() is 'SS' — dropped). */
function variantsOfUncached(ch: string): string[] {
  const out = [ch];
  const lower = ch.toLowerCase();
  if (lower !== ch && [...lower].length === 1) out.push(lower);
  const upper = ch.toUpperCase();
  if (upper !== ch && [...upper].length === 1) out.push(upper);
  return out;
}

/** Ceiling on `VARIANTS_CACHE` below: a real vault's alphabet is a few hundred code points at
 *  most, so this is never reached in practice — it exists only so a search fed a long run of
 *  distinct, never-repeating characters (an adversarial input, or one pathologically diverse
 *  line) can't grow the cache without bound over a long-running server's lifetime. Reached: the
 *  cache is simply cleared and rebuilt, which only costs a little recomputation, never
 *  correctness (`variantsOfUncached` is pure). */
const VARIANTS_CACHE_MAX = 4096;
const VARIANTS_CACHE = new Map<string, string[]>();

/** `variantsOfUncached`, memoized — every character of every line, in `compileSafePattern.test()`
 *  and `compileSafeSearch.find()` alike, calls this once per NFA step; a vault search re-scans
 *  the same handful of dozens of common characters across thousands of lines, so caching turns a
 *  `toLowerCase()`/`toUpperCase()` pair plus two small array allocations per character into a Map
 *  lookup after the first sighting. */
function variantsOf(ch: string): string[] {
  let cached = VARIANTS_CACHE.get(ch);
  if (cached !== undefined) return cached;
  if (VARIANTS_CACHE.size >= VARIANTS_CACHE_MAX) VARIANTS_CACHE.clear();
  cached = variantsOfUncached(ch);
  VARIANTS_CACHE.set(ch, cached);
  return cached;
}

function literalSet(ch: string): CharSet {
  const cp = ch.codePointAt(0) ?? 0;
  return { negated: false, items: [{ type: 'range', from: cp, to: cp }] };
}

// ---------------------------------------------------------------- parser

type Ast =
  | { kind: 'empty' }
  | { kind: 'set'; set: CharSet }
  | { kind: 'concat'; parts: Ast[] }
  | { kind: 'alt'; options: Ast[] }
  | { kind: 'repeat'; node: Ast; min: number; max: number | null };

type ClassAtom = { kind: 'char'; cp: number } | { kind: 'class'; name: ClassName };

/** Recursive-descent parser over the reduced syntax; every unsupported construct throws. */
function parsePattern(pattern: string): Ast {
  const src = [...pattern];
  let pos = 0;

  const peek = (): string | undefined => src[pos];
  const at = (offset: number): string | undefined => src[pos + offset];
  const advance = (): string => {
    const c = src[pos];
    pos += 1;
    return c ?? '';
  };

  function escapedAtom(inClass: boolean): ClassAtom {
    advance(); // the backslash
    const e = peek();
    if (e === undefined) throw invalid('pattern ends with a dangling "\\".');
    advance();
    if (DIGIT.test(e)) {
      throw invalid('backreferences (e.g. "\\1") are not supported.');
    }
    if (CLASS_ESCAPES.has(e)) return { kind: 'class', name: e as ClassName };
    if (ESCAPABLE_PUNCTUATION.has(e)) return { kind: 'char', cp: e.codePointAt(0) ?? 0 };
    const control: Record<string, string> = { t: '\t', n: '\n', r: '\r' };
    const lit = control[e];
    if (lit !== undefined) return { kind: 'char', cp: lit.codePointAt(0) ?? 0 };
    throw invalid(
      `unsupported escape "\\${e}"${inClass ? ' in a character class' : ''}: only \\d \\w \\s ` +
        '(and \\D \\W \\S), \\t \\n \\r and escaped punctuation are supported.',
    );
  }

  function classAtom(): ClassAtom {
    if (peek() === '\\') return escapedAtom(true);
    const c = advance();
    return { kind: 'char', cp: c.codePointAt(0) ?? 0 };
  }

  function parseClass(): CharSet {
    advance(); // '['
    let negated = false;
    if (peek() === '^') {
      advance();
      negated = true;
    }
    const items: SetItem[] = [];
    for (;;) {
      const c = peek();
      if (c === undefined) throw invalid('unterminated character class: missing "]".');
      if (c === ']') {
        advance();
        break;
      }
      const first = classAtom();
      if (peek() === '-' && at(1) !== undefined && at(1) !== ']') {
        advance(); // '-'
        const second = classAtom();
        if (first.kind !== 'char' || second.kind !== 'char') {
          throw invalid('a shorthand class (\\d, \\w, \\s) cannot be a character-range endpoint.');
        }
        if (second.cp < first.cp) {
          throw invalid('character-class range is out of order (e.g. "[z-a]").');
        }
        items.push({ type: 'range', from: first.cp, to: second.cp });
      } else if (first.kind === 'char') {
        items.push({ type: 'range', from: first.cp, to: first.cp });
      } else {
        items.push({ type: 'class', name: first.name });
      }
    }
    if (items.length === 0) {
      throw invalid('empty character class: "[]" and "[^]" are not supported (use "." for any).');
    }
    return { negated, items };
  }

  function parseGroup(): Ast {
    advance(); // '('
    if (peek() === '?') {
      const marker = at(1);
      if (marker === ':') {
        pos += 2;
      } else if (marker === '=' || marker === '!') {
        throw invalid('lookahead assertions "(?=" / "(?!" are not supported.');
      } else if (marker === '<') {
        throw invalid('lookbehind assertions and named groups "(?<…" are not supported.');
      } else {
        throw invalid('inline flags and extended group syntax "(?…" are not supported.');
      }
    }
    const inner = parseAlternation();
    if (peek() !== ')') throw invalid('unbalanced "(": missing ")".');
    advance();
    return inner;
  }

  function parseAtom(): Ast {
    const c = peek();
    if (c === undefined) throw invalid('unexpected end of pattern.');
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      throw invalid(`nothing to repeat before "${c}".`);
    }
    if (c === '^' || c === '$') {
      throw invalid(
        `"${c}" is not supported: the pattern is always matched against the whole value ` +
          `(escape it as "\\${c}" to match the character itself).`,
      );
    }
    if (c === ')') throw invalid('unbalanced ")".');
    if (c === '(') return parseGroup();
    if (c === '[') return { kind: 'set', set: parseClass() };
    if (c === '.') {
      advance();
      return { kind: 'set', set: { negated: true, items: [] } };
    }
    if (c === '\\') {
      const atom = escapedAtom(false);
      return {
        kind: 'set',
        set:
          atom.kind === 'class'
            ? { negated: false, items: [{ type: 'class', name: atom.name }] }
            : { negated: false, items: [{ type: 'range', from: atom.cp, to: atom.cp }] },
      };
    }
    return { kind: 'set', set: literalSet(advance()) };
  }

  function parseBraces(): { min: number; max: number | null } {
    advance(); // '{'
    let digits = '';
    while (peek() !== undefined && DIGIT.test(peek() as string)) digits += advance();
    if (digits === '') {
      throw invalid('"{" must start a repetition such as {2}, {2,} or {2,5}; escape it as "\\{".');
    }
    const min = Number(digits);
    let max: number | null = min;
    if (peek() === ',') {
      advance();
      let upper = '';
      while (peek() !== undefined && DIGIT.test(peek() as string)) upper += advance();
      max = upper === '' ? null : Number(upper);
    }
    if (peek() !== '}') {
      throw invalid('"{" must start a repetition such as {2}, {2,} or {2,5}; escape it as "\\{".');
    }
    advance();
    if (min > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) {
      throw invalid(`repetition counts must be at most ${MAX_REPEAT}.`);
    }
    if (max !== null && max < min) throw invalid('repetition "{m,n}" requires m <= n.');
    return { min, max };
  }

  function readQuantifier(): { min: number; max: number | null } | null {
    const c = peek();
    if (c === '*') {
      advance();
      return { min: 0, max: null };
    }
    if (c === '+') {
      advance();
      return { min: 1, max: null };
    }
    if (c === '?') {
      advance();
      return { min: 0, max: 1 };
    }
    if (c === '{') return parseBraces();
    return null;
  }

  function parseQuantified(): Ast {
    const atom = parseAtom();
    const quant = readQuantifier();
    if (quant === null) return atom;
    const next = peek();
    if (next === '*' || next === '+' || next === '?' || next === '{') {
      throw invalid(
        'a quantifier cannot directly follow another quantifier (lazy quantifiers such as "*?" ' +
          'are not supported — matching is a boolean full match, so greediness never matters).',
      );
    }
    return { kind: 'repeat', node: atom, min: quant.min, max: quant.max };
  }

  function parseConcat(): Ast {
    const parts: Ast[] = [];
    while (pos < src.length && peek() !== '|' && peek() !== ')') parts.push(parseQuantified());
    if (parts.length === 0) return { kind: 'empty' };
    if (parts.length === 1) return parts[0] as Ast;
    return { kind: 'concat', parts };
  }

  function parseAlternation(): Ast {
    const options: Ast[] = [parseConcat()];
    while (peek() === '|') {
      advance();
      options.push(parseConcat());
    }
    if (options.length === 1) return options[0] as Ast;
    return { kind: 'alt', options };
  }

  const ast = parseAlternation();
  if (pos < src.length) throw invalid(`unexpected "${peek()}" at position ${pos}.`);
  return ast;
}

// ---------------------------------------------------------------- required-literal prefilter

/**
 * The exact character this AST node is guaranteed to consume, if — and only if — it is a plain,
 * non-negated, single-code-point `set` node (a literal character or an escaped metacharacter; not
 * `.`, not a class like `\d`, not a multi-character range like `[a-z]`). Used only to find
 * consecutive literal characters in a `concat` to merge into a single longer required substring.
 */
function definiteChar(node: Ast): string | null {
  if (node.kind !== 'set') return null;
  const { set } = node;
  if (set.negated || set.items.length !== 1) return null;
  const item = set.items[0] as SetItem;
  if (item.type !== 'range' || item.from !== item.to) return null;
  return String.fromCodePoint(item.from);
}

/**
 * Ripgrep's own trick, in miniature: derives a set of literal substrings of which AT LEAST ONE
 * must appear (as a plain substring, ignoring where) in anything this pattern matches — or `null`
 * when no such set can be derived (the safe default: "no information", never wrong, just not
 * useful for skipping). `LocalFSAdapter.searchJs` uses this to reject a whole file, or a single
 * line, with one `String.includes` check per candidate literal, before ever running the NFA over
 * it — the NFA is linear in the subject length, but a `.includes` scan is a small constant
 * factor of that, so this turns "run the automaton over every line of every candidate file" into
 * "run it only over the line/file that could possibly match".
 *
 * Two shapes are recognised, matching this module's own reduced grammar:
 *  - a run of consecutive literal characters anywhere in a `concat` (e.g. `\d{4}-\d{2}-\d{2}`'s
 *    two `-` characters are each a length-1 run; `colou?r`'s `colo` — up to the optional `u` — is
 *    a length-4 run) — the LONGEST such run (or, when no run beats it, the strongest recursive
 *    requirement of a non-literal child, e.g. a nested alternation) is kept;
 *  - a top-level alternation where EVERY branch itself has a derivable requirement (e.g.
 *    `invoice|receipt` → `{"invoice","receipt"}`) — the union of every branch's alternatives,
 *    since a match follows exactly one branch and so is guaranteed to contain that branch's own
 *    required substring. A branch with no derivable requirement (it could match without any
 *    particular substring present) makes the WHOLE alternation undecidable, not just that branch.
 *
 * Not attempted: combining more than one independent requirement with AND (e.g. `invoice` AND
 * `number` both required by `(invoice|receipt)[- ]?(number|no\.?)`) — only the single strongest
 * one found is kept. Weaker than possible, never wrong: the result is still a sound (if not
 * maximally selective) required-literal set.
 */
function deriveRequiredLiterals(ast: Ast): string[] | null {
  /** The requirement itself, plus how selective it is (the length of its shortest alternative —
   *  a longer literal is rarer, and so filters more), so `concat` can pick the best candidate
   *  among several unrelated ones instead of just the first non-null one found. */
  function requirementOf(node: Ast): { literals: string[]; score: number } | null {
    switch (node.kind) {
      case 'empty':
        return null;
      case 'set': {
        const ch = definiteChar(node);
        return ch === null ? null : { literals: [ch], score: ch.length };
      }
      case 'repeat':
        // min === 0: the whole thing can be absent, so nothing about it is guaranteed present.
        // min >= 1: it occurs at least once, so whatever it requires is still required.
        return node.min === 0 ? null : requirementOf(node.node);
      case 'alt': {
        const literals: string[] = [];
        for (const option of node.options) {
          const req = requirementOf(option);
          if (req === null) return null; // one undecidable branch undecides the whole alternation
          literals.push(...req.literals);
        }
        const unique = [...new Set(literals)];
        return { literals: unique, score: Math.min(...unique.map((s) => s.length)) };
      }
      case 'concat': {
        let best: { literals: string[]; score: number } | null = null;
        let run = '';
        const consider = (candidate: { literals: string[]; score: number } | null): void => {
          if (candidate !== null && (best === null || candidate.score > best.score))
            best = candidate;
        };
        for (const part of node.parts) {
          const ch = definiteChar(part);
          if (ch !== null) {
            run += ch;
            continue;
          }
          if (run.length > 0) {
            consider({ literals: [run], score: run.length });
            run = '';
          }
          consider(requirementOf(part));
        }
        if (run.length > 0) consider({ literals: [run], score: run.length });
        return best;
      }
    }
  }
  return requirementOf(ast)?.literals ?? null;
}

// ---------------------------------------------------------------- NFA

interface CharState {
  kind: 'char';
  set: CharSet;
  next: number;
}
interface SplitState {
  kind: 'split';
  a: number;
  b: number;
}
interface MatchState {
  kind: 'match';
}
type NfaState = CharState | SplitState | MatchState;

/** A partially built NFA: an entry state plus the dangling exits still to be pointed somewhere. */
interface Fragment {
  start: number;
  patch: ((target: number) => void)[];
}

function buildNfa(ast: Ast): { states: NfaState[]; start: number } {
  const states: NfaState[] = [];

  function alloc(state: NfaState): number {
    if (states.length >= MAX_NFA_STATES) {
      throw invalid(
        `pattern is too complex: it expands to more than ${MAX_NFA_STATES} matcher states. ` +
          'Reduce the nesting or the repetition counts.',
      );
    }
    states.push(state);
    return states.length - 1;
  }

  function epsilon(): Fragment {
    const index = alloc({ kind: 'split', a: -1, b: -1 });
    const state = states[index] as SplitState;
    return {
      start: index,
      patch: [
        (t) => {
          state.a = t;
          state.b = t;
        },
      ],
    };
  }

  function chain(fragments: Fragment[]): Fragment {
    let frag = fragments[0] as Fragment;
    for (let i = 1; i < fragments.length; i += 1) {
      const next = fragments[i] as Fragment;
      for (const p of frag.patch) p(next.start);
      frag = { start: frag.start, patch: next.patch };
    }
    return frag;
  }

  function star(node: Ast): Fragment {
    const index = alloc({ kind: 'split', a: -1, b: -1 });
    const state = states[index] as SplitState;
    const inner = compile(node);
    state.a = inner.start;
    for (const p of inner.patch) p(index);
    return {
      start: index,
      patch: [
        (t) => {
          state.b = t;
        },
      ],
    };
  }

  function optional(node: Ast): Fragment {
    const inner = compile(node);
    const index = alloc({ kind: 'split', a: inner.start, b: -1 });
    const state = states[index] as SplitState;
    return {
      start: index,
      patch: [
        ...inner.patch,
        (t) => {
          state.b = t;
        },
      ],
    };
  }

  function compileRepeat(node: Ast, min: number, max: number | null): Fragment {
    const pieces: Fragment[] = [];
    for (let i = 0; i < min; i += 1) pieces.push(compile(node));
    if (max === null) pieces.push(star(node));
    else for (let i = min; i < max; i += 1) pieces.push(optional(node));
    if (pieces.length === 0) return epsilon();
    return chain(pieces);
  }

  function compile(node: Ast): Fragment {
    switch (node.kind) {
      case 'empty':
        return epsilon();
      case 'set': {
        const index = alloc({ kind: 'char', set: node.set, next: -1 });
        const state = states[index] as CharState;
        return {
          start: index,
          patch: [
            (t) => {
              state.next = t;
            },
          ],
        };
      }
      case 'concat':
        return chain(node.parts.map(compile));
      case 'alt': {
        // Right-nested splits: option0 | (option1 | (…)).
        let frag = compile(node.options[node.options.length - 1] as Ast);
        for (let i = node.options.length - 2; i >= 0; i -= 1) {
          const left = compile(node.options[i] as Ast);
          const index = alloc({ kind: 'split', a: left.start, b: frag.start });
          frag = { start: index, patch: [...left.patch, ...frag.patch] };
        }
        return frag;
      }
      default:
        return compileRepeat(node.node, node.min, node.max);
    }
  }

  const frag = compile(ast);
  const matchIndex = alloc({ kind: 'match' });
  for (const p of frag.patch) p(matchIndex);
  return { states, start: frag.start };
}

// ---------------------------------------------------------------- matcher

export interface SafeMatcher {
  /** The pattern this matcher was compiled from, for error messages. */
  readonly source: string;
  /** True when the WHOLE subject matches the pattern (case-insensitively). */
  test(subject: string): boolean;
}

/**
 * Compiles `pattern` into a linear-time full-match matcher, or throws
 * `VaultError('INVALID_INPUT', …)` if it uses anything outside the reduced syntax.
 */
export function compileSafePattern(pattern: string): SafeMatcher {
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw invalid(`regex pattern exceeds ${MAX_PATTERN_CHARS} characters (got ${pattern.length}).`);
  }
  const { states, start } = buildNfa(parsePattern(pattern));
  // Visited marks for the epsilon closure, stamped with a per-step generation instead of being
  // reallocated: closure and stepping stay O(states) with no per-character allocation.
  const marks = new Int32Array(states.length).fill(-1);
  let generation = 0;

  function addState(list: number[], gen: number, from: number): void {
    const stack = [from];
    while (stack.length > 0) {
      const index = stack.pop() as number;
      if (marks[index] === gen) continue;
      marks[index] = gen;
      const state = states[index] as NfaState;
      if (state.kind === 'split') {
        stack.push(state.a);
        stack.push(state.b);
      } else {
        list.push(index);
      }
    }
  }

  function test(subject: string): boolean {
    // Cheap pre-reject: even all-astral (2 UTF-16 units per code point), a string this long has
    // more code points than the cap.
    if (subject.length > MAX_SUBJECT_CHARS * 2) return false;
    generation += 1;
    let current: number[] = [];
    addState(current, generation, start);
    let codePoints = 0;
    for (const ch of subject) {
      // The cap counts code points — the unit this loop consumes — so an astral-heavy subject
      // is not rejected at half the advertised length.
      codePoints += 1;
      if (codePoints > MAX_SUBJECT_CHARS) return false;
      if (current.length === 0) return false;
      const variants = variantsOf(ch);
      generation += 1;
      const next: number[] = [];
      for (const index of current) {
        const state = states[index] as NfaState;
        if (state.kind === 'char' && setMatches(state.set, variants)) {
          addState(next, generation, state.next);
        }
      }
      current = next;
    }
    return current.some((index) => (states[index] as NfaState).kind === 'match');
  }

  return { source: pattern, test };
}

// ---------------------------------------------------------------- unanchored search (find)

export interface SafeSearchMatch {
  /** Code-point offset (not UTF-16 units) of the first matched character. */
  start: number;
  /** Code-point offset one past the last matched character (exclusive), so `end - start` is the
   *  match length in code points. */
  end: number;
}

export interface SafeSearchMatcher {
  /** The pattern this matcher was compiled from, for error messages. */
  readonly source: string;
  /**
   * The leftmost match in `line`, or `null`. Unanchored (the pattern may start anywhere in the
   * line, unlike `SafeMatcher.test`, which requires a full match) and single-line (a `find` call
   * is always given one line at a time by `LocalFSAdapter.searchJs`; there is no multi-line
   * matching in either search backend).
   *
   * Leftmost-first semantics: among matches starting at the leftmost possible position, the one
   * this returns is whichever a Thompson-NFA simulation that runs candidate threads in the
   * pattern's own priority order (earlier alternatives first, a quantifier's "consume another"
   * branch before its "stop here" branch — the same order `(a+)+` or `cat|dog` are written in)
   * reaches a match state on first, with strictly lower-priority threads dropped the moment a
   * higher-priority one accepts. For an unambiguous pattern (no alternation, no quantifier that
   * could stop at more than one length) this coincides with the leftmost-LONGEST match too; for
   * an ambiguous one (e.g. `a|ab` against "ab") it is whichever alternative is written first
   * (here, "a"), matching Perl/PCRE-style backtracking precedence rather than POSIX
   * leftmost-longest — chosen because it is what a person writing the pattern expects, and it is
   * the cheaper of the two to keep linear (POSIX semantics need every thread run to exhaustion
   * before any can be preferred; this needs only the highest-priority one still alive).
   */
  find(line: string): SafeSearchMatch | null;
  /**
   * True when `text` is GUARANTEED not to contain a match — every literal `deriveRequiredLiterals`
   * could derive from the pattern is checked with one `String.includes` (case-folded together
   * when the matcher is case-insensitive) before any NFA thread ever runs. `false` never means
   * "there is a match", only "cannot rule one out" — a pattern with no derivable requirement (most
   * uses of `.`, a class, or an unconstrained quantifier at the top level) always returns `false`,
   * the same as if this check did not exist. Safe, and useful, on a whole file's text (skip
   * reading every line of a file that plainly cannot match) as well as on one line (skip that
   * line's `find()` call) — see `LocalFSAdapter.searchJs`.
   */
  cannotMatch(text: string): boolean;
}

/**
 * Compiles `pattern` into a linear-time, unanchored, single-line search matcher — the JS-fallback
 * counterpart of ripgrep's regex mode for `LocalFSAdapter.search({ regex: true })` when `rg` is
 * not on PATH. Same reduced syntax as `compileSafePattern` (see the module doc comment) and the
 * same `MAX_PATTERN_CHARS`/`MAX_NFA_STATES` caps; throws `VaultError('INVALID_INPUT', …)` on
 * anything outside it, worded to say what is and is not supported.
 *
 * Unlike `compileSafePattern` (always case-insensitive, built for `vault_query`'s `where: [{ op:
 * 'regex' }]`), this defaults to case-INsensitive but honours `caseSensitive: true` — matching
 * ripgrep's own `--ignore-case`/`--case-sensitive` default and override.
 */
export function compileSafeSearch(
  pattern: string,
  opts: { caseSensitive?: boolean } = {},
): SafeSearchMatcher {
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw invalid(`regex pattern exceeds ${MAX_PATTERN_CHARS} characters (got ${pattern.length}).`);
  }
  const caseSensitive = opts.caseSensitive === true;
  const ast = parsePattern(pattern);
  const { states, start } = buildNfa(ast);
  const marks = new Int32Array(states.length).fill(-1);
  let generation = 0;

  const requiredLiterals = deriveRequiredLiterals(ast);
  // Compared case-insensitively (the matcher's default) unless caseSensitive was requested — see
  // `cannotMatch`'s own doc comment on the interface above.
  const requiredNeedles = requiredLiterals?.map((lit) => (caseSensitive ? lit : lit.toLowerCase()));

  function cannotMatch(text: string): boolean {
    if (requiredNeedles === undefined) return false; // no derivable requirement: never skip
    const haystack = caseSensitive ? text : text.toLowerCase();
    for (const needle of requiredNeedles) {
      if (haystack.includes(needle)) return false; // this literal is present: might match
    }
    return true; // none of the required literals appear anywhere in `text`
  }

  // Two thread lists, each a pair of parallel Int32Arrays (NFA state index, code-point start
  // offset) sized to the worst case (every state alive in one generation) — reused across every
  // step of every `find()` call, and across every `find()` call this matcher ever makes (a vault
  // search calls `find()` once per candidate line, often thousands of times), never reallocated;
  // ping-ponged by swapping which pair is "current" and which is "next" rather than by copying.
  const cap = states.length;
  const stateA = new Int32Array(cap);
  const startA = new Int32Array(cap);
  const stateB = new Int32Array(cap);
  const startB = new Int32Array(cap);
  // The epsilon-closure DFS's own scratch stack: also reused, grown (never shrunk) on demand —
  // cheap, since a JS array's backing store growing by push() amortizes to O(1), and this stack
  // empties completely (length reset to 0) between every `addThread` call.
  const stack: number[] = [];

  // Epsilon closure of `from`, appended into (stateBuf, startBuf) starting at `count`, in the
  // pattern's own priority order (the quantifier/alternation branch written — and therefore
  // compiled — first is explored, and so appended, first): pushes the LOWER-priority child (`b`)
  // before the higher-priority one (`a`), so `a`'s whole subtree pops — and is visited — first.
  // (Contrast `compileSafePattern`'s own `addState`, which pushes `a` then `b`: fine there, since
  // `test()` only asks "is any thread in a match state", never "which one gets to answer first".)
  // Returns the new count.
  function addThread(
    stateBuf: Int32Array,
    startBuf: Int32Array,
    count: number,
    gen: number,
    from: number,
    startCp: number,
  ): number {
    let n = count;
    stack.length = 0;
    stack.push(from);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      if (marks[index] === gen) continue;
      marks[index] = gen;
      const state = states[index] as NfaState;
      if (state.kind === 'split') {
        stack.push(state.b);
        stack.push(state.a);
      } else {
        stateBuf[n] = index;
        startBuf[n] = startCp;
        n += 1;
      }
    }
    return n;
  }

  function find(line: string): SafeSearchMatch | null {
    if (cannotMatch(line)) return null;
    // Same guarantee as compileSafePattern's test(): a subject over the cap is refused outright
    // rather than scanned partially, bounding the worst case a single very long note line (a
    // minified .canvas/.base file, say) can cost — ripgrep has no such cap, but no test in the
    // parity suite feeds either backend a line anywhere near it. Two stages, like test(): a cheap
    // UTF-16-length pre-reject (no iteration) for anything astronomically long, then a precise
    // code-point count that still bails out early instead of materializing the whole array first.
    if (line.length > MAX_SUBJECT_CHARS * 2) return null;
    const cps: string[] = [];
    for (const ch of line) {
      cps.push(ch);
      if (cps.length > MAX_SUBJECT_CHARS) return null;
    }
    const n = cps.length;

    let matched: SafeSearchMatch | null = null;
    generation += 1;
    let curState = stateA;
    let curStart = startA;
    let nextState = stateB;
    let nextStart = startB;
    let curCount = addThread(curState, curStart, 0, generation, start, 0);

    for (let sp = 0; sp <= n; sp += 1) {
      // Highest-priority match in the current thread list wins; anything after it in the
      // (priority-ordered) list is strictly worse — whether a different, later start (unanchored
      // search always keeps threads sorted oldest-start/highest-priority first, since a new
      // thread is only ever appended at the end) or the same start via a lower-priority path —
      // and is dropped rather than allowed to also extend to the next step.
      let cut = -1;
      for (let i = 0; i < curCount; i += 1) {
        if ((states[curState[i] as number] as NfaState).kind === 'match') {
          matched = { start: curStart[i] as number, end: sp };
          cut = i;
          break;
        }
      }
      if (cut !== -1) curCount = cut;
      if (sp >= n) break;
      if (curCount === 0 && matched !== null) break; // nothing left could ever beat `matched`

      generation += 1;
      let nextCount = 0;
      const ch = cps[sp] as string;
      const variants = caseSensitive ? [ch] : variantsOf(ch);
      for (let i = 0; i < curCount; i += 1) {
        const state = states[curState[i] as number] as NfaState;
        if (state.kind === 'char' && setMatches(state.set, variants)) {
          nextCount = addThread(
            nextState,
            nextStart,
            nextCount,
            generation,
            state.next,
            curStart[i] as number,
          );
        }
      }
      // A new thread may start at the next position — but only while no match has been found
      // yet: any thread starting now begins no earlier than `matched.start` already does, so it
      // can never improve on it (leftmost start always wins over anything else).
      if (matched === null) {
        nextCount = addThread(nextState, nextStart, nextCount, generation, start, sp + 1);
      }
      // Swap: what was "next" becomes "current" for the following step, and vice versa — no
      // array is ever allocated or copied to make this happen.
      [curState, nextState] = [nextState, curState];
      [curStart, nextStart] = [nextStart, curStart];
      curCount = nextCount;
    }
    return matched;
  }

  return { source: pattern, find, cannotMatch };
}
