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
 */

/** Longest accepted pattern; mirrors `MAX_SEARCH_PATTERN_CHARS` for ripgrep-backed search. */
export const MAX_PATTERN_CHARS = 200;
/** Largest accepted repetition count in `{m}`, `{m,}` and `{m,n}`. */
export const MAX_REPEAT = 100;
/** Compile-time ceiling on the NFA; counted repetition is expanded, so this is what stops a short
 *  pattern such as `((a{100}){100}){100}` from building a million states. */
export const MAX_NFA_STATES = 5000;
/** Subjects longer than this never match — a query value that big is not a regex target. */
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
function variantsOf(ch: string): string[] {
  const out = [ch];
  const lower = ch.toLowerCase();
  if (lower !== ch && [...lower].length === 1) out.push(lower);
  const upper = ch.toUpperCase();
  if (upper !== ch && [...upper].length === 1) out.push(upper);
  return out;
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
    if (subject.length > MAX_SUBJECT_CHARS) return false;
    generation += 1;
    let current: number[] = [];
    addState(current, generation, start);
    for (const ch of subject) {
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
