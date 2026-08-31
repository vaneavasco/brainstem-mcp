# Fix-Later Wave (Phase 4 residuals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every item on the adjudicated "fix-later" list in `docs/reviews/2026-08-31-phase-4-final-review.md` — the parked quality/perf/cosmetic residuals left after Phase 4 shipped as v0.3.0.

**Architecture:** No new features, no behavior contracts broken. Three refactor clusters (shared tag/compare helpers + graph rollup precompute; post-write `Note` results on the adapter so tools stop re-reading what they just wrote; `vault_move` handler decomposition) plus a set of small precise fixes (regex subject cap in code points, template `unresolved` grammar gap, heading-path dedupe, message cosmetics, deterministic perf-guard seeding, Zod schema dedupe into the `args.ts` leaf).

**Tech Stack:** Node 24 native TS, Express 5, MCP SDK 2.0, Zod 4, Vitest 4, Biome.

**Spec:** `docs/reviews/2026-08-31-phase-4-final-review.md` §"Fix-later list" (the itemized source of truth), with `AGENTS.md` invariants binding throughout.

## Global Constraints

- TypeScript runs natively on Node 24: no enums/parameter properties/namespaces; relative imports carry `.ts`; `import type` for types.
- Biome: 2 spaces, single quotes, semicolons, trailing commas, 100 columns. `npm run lint:fix` before each commit.
- TDD: failing test first, then code. Tests exercise real behavior (temp dirs, real adapter, harness-booted MCP server).
- Security invariants from AGENTS.md untouched: `_brainstem/` reserved, `/mcp` gate order, no `RegExp` on user-supplied `where` patterns, `expectedHash`/`WriteGate` semantics unchanged.
- Every mutating adapter call stays inside a `locked()` scope; no lock acquired while another is held.
- Conventional Commits; one commit per task.
- Work on a branch (`fix/fix-later-wave`), never directly on `main`.
- Done means: `npm run lint:fix && npm run typecheck && npm test` green (7–15 ripgrep tests skip without `rg` locally; CI runs them), CHANGELOG *Unreleased* updated.

## Item → task map

| Fix-later item | Task |
|---|---|
| nested-tag prefix rule duplicated (`graph.ts`/`query.ts`) | 1 |
| `tags()`/`notesWithTag()` O(T²); `orphans()`/`hubs()` re-sort via `index.all()`; case-sensitive tie-breaks | 2 |
| `graph.ts` size + redundant `clampMatch` | 3 |
| CONFLICT message formatting ×3; `results.ts` CONFLICT assumes `details`; "0.0 MiB" | 4 |
| NFA `MAX_SUBJECT_CHARS` off-by-a-surrogate; astral `.` doc | 5 |
| template placeholder grammar boundary absent from `unresolved` | 6 |
| sibling same-text heading paths in `listHeadingPaths`; final-segment file-order doc | 7 |
| adapter post-write hashes; `touch()` no-op for non-md | 8 |
| `vault_move` handler ~170 lines inline | 9 |
| perf-guard "deterministic" wording + margin | 10 |
| search/query Zod schema duplication | 11 |
| coverage-breadth notes from Tasks 3/4 | folded into Tasks 2, 5–8's new tests (original task-review notes are no longer on disk; discharged as breadth tests over the same surface) |
| docs: CHANGELOG, wave record, re-adjudicated "documented divergences" | 12 |

Adjudicated as **documented, no code change** (recorded again in Task 12): final-segment heading ambiguity resolving in file order (documented on `findSection`); astral `.` matching one code point (correct and documented; Task 5 strengthens the doc); C1 residual regex cost (~90 ms/2048-char value — bounded, accepted).

---

### Task 1: Shared nested-tag rule + shared case-insensitive comparator

**Files:**
- Create: `src/vault/tags.ts`
- Modify: `src/vault/query.ts` (tagFilterMatches)
- Test: `tests/vault/tags.test.ts` (new)

**Interfaces:**
- Produces: `isTagOrDescendant(key: string, parent: string): boolean` (lowercase args), `compareCaseInsensitive(a: string, b: string): number`. Task 2 imports both into `graph.ts`.

- [x] **Step 1: Write the failing test** (`tests/vault/tags.test.ts`)

```ts
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
    expect(['B.md', 'a.md', 'A.md'].sort(compareCaseInsensitive)).toEqual([
      'A.md',
      'a.md',
      'B.md',
    ]);
    expect(compareCaseInsensitive('x', 'x')).toBe(0);
  });
});
```

- [x] **Step 2: Run it — FAIL** (`npx vitest run tests/vault/tags.test.ts`; module not found)

- [x] **Step 3: Implement** (`src/vault/tags.ts`)

```ts
/**
 * The vault's nested-tag rule and ordering comparator, shared by `VaultGraph` and the query
 * engine so the two can never drift.
 */

/** A tag key covers itself and everything nested under it with a '/' separator ("proj" covers
 *  "proj" and "proj/x", never "project"). Both arguments must already be lowercase. */
export function isTagOrDescendant(key: string, parent: string): boolean {
  return key === parent || key.startsWith(`${parent}/`);
}

/**
 * Case-insensitive comparator with a case-sensitive fallback, so ordering stays total and stable
 * for strings differing only by case. The shared tie-break rule for `tags()`, `orphans()` and
 * `hubs()`.
 */
export function compareCaseInsensitive(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
```

In `src/vault/query.ts`, add `import { isTagOrDescendant } from './tags.ts';` and replace `tagFilterMatches`:

```ts
/** A tag filter value matches an entry's tag either exactly or as an ancestor of a nested tag,
 *  case-insensitively — the shared rule in vault/tags.ts. */
function tagFilterMatches(entryTags: string[], filter: string): boolean {
  const f = filter.toLowerCase();
  return entryTags.some((t) => isTagOrDescendant(t.toLowerCase(), f));
}
```

- [x] **Step 4: Run tests — PASS** (`npx vitest run tests/vault/tags.test.ts tests/vault/query.test.ts`)

- [x] **Step 5: Commit** — `refactor(vault): shared nested-tag rule and case-insensitive comparator`

---

### Task 2: Graph — rollup precompute, cached path list, unified tie-breaks

**Files:**
- Modify: `src/vault/graph.ts`
- Test: `tests/vault/graph.test.ts`

**Interfaces:**
- Consumes: Task 1's `compareCaseInsensitive`.
- Produces: unchanged public `VaultGraph` API; `tags()`/`notesWithTag()` become O(keys) per call, `orphans()`/`hubs()` stop calling `index.all()`; all three tie-break case-insensitively.

- [x] **Step 1: Write the failing tests** (append to `tests/vault/graph.test.ts`)

```ts
describe('ordering tie-breaks (shared case-insensitive rule)', () => {
  it('orders orphans case-insensitively', () => {
    index.upsert(entry('B-orphan.md', 'x'));
    index.upsert(entry('a-orphan.md', 'x'));
    const orphans = graph.orphans();
    expect(orphans.indexOf('a-orphan.md')).toBeLessThan(orphans.indexOf('B-orphan.md'));
  });

  it('breaks hub ties case-insensitively', () => {
    index.upsert(entry('B-hub.md', 'x'));
    index.upsert(entry('a-hub.md', 'x'));
    index.upsert(entry('pointer.md', '[[B-hub]] [[a-hub]]'));
    const hubs = graph.hubs().filter((h) => h.path.endsWith('-hub.md'));
    expect(hubs).toEqual([
      { path: 'a-hub.md', backlinks: 1 },
      { path: 'B-hub.md', backlinks: 1 },
    ]);
  });
});

describe('tag rollup', () => {
  it('rolls nested descendants into ancestors, case-insensitively', () => {
    index.upsert(entry('t1.md', '#Deep/Nested/leaf'));
    index.upsert(entry('t2.md', '#deep'));
    const deep = graph.tags().find((t) => t.tag.toLowerCase() === 'deep');
    expect(deep?.count).toBe(2);
    expect(graph.notesWithTag('deep').map((n) => n.path)).toEqual(['t1.md', 't2.md']);
    expect(graph.notesWithTag('deep', false).map((n) => n.path)).toEqual(['t2.md']);
    expect(graph.notesWithTag('deep/nested').map((n) => n.path)).toEqual(['t1.md']);
  });
});
```

(The hub-ties test FAILS today: `B-hub.md` sorts before `a-hub.md` case-sensitively. The rollup test pins today's behavior so the precompute cannot change it.)

- [x] **Step 2: Run — FAIL on tie-breaks** (`npx vitest run tests/vault/graph.test.ts`)

- [x] **Step 3: Implement** (`src/vault/graph.ts`)

1. Replace the local `compareCaseInsensitive` with `import { compareCaseInsensitive } from './tags.ts';`.
2. New private fields:

```ts
  /** entry paths in index.all() order, cached per rebuild so orphans()/hubs() don't re-copy. */
  private entryPaths: string[] = [];
  /** notesForKey(includeNested=true) precomputed per registry key — O(T·depth) built once per
   *  rebuild instead of an O(T²) scan of every direct bucket on every tags() call. */
  private rolledTagBuckets = new Map<
    string,
    { frontmatterNotes: Set<string>; inlineNotes: Set<string> }
  >();
```

3. In `rebuild()`, set `this.entryPaths = entries.map((e) => e.path);` right after `const entries = this.index.all();`, and append after the `tagKeyRegistry` block:

```ts
    this.rolledTagBuckets = new Map();
    for (const key of this.tagKeyRegistry.keys()) {
      this.rolledTagBuckets.set(key, { frontmatterNotes: new Set(), inlineNotes: new Set() });
    }
    for (const [dkey, bucket] of this.directTagBuckets) {
      const segments = dkey.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        const rolled = this.rolledTagBuckets.get(segments.slice(0, i).join('/'));
        if (!rolled) continue;
        for (const p of bucket.frontmatterNotes) rolled.frontmatterNotes.add(p);
        for (const p of bucket.inlineNotes) rolled.inlineNotes.add(p);
      }
    }
```

4. Replace `notesForKey` (callers only read the sets — never mutate):

```ts
  /** Notes contributing to `key`: precomputed rollup (with descendants) or the direct bucket. */
  private notesForKey(
    key: string,
    includeNested: boolean,
  ): { frontmatterNotes: ReadonlySet<string>; inlineNotes: ReadonlySet<string> } {
    const bucket = includeNested
      ? this.rolledTagBuckets.get(key)
      : this.directTagBuckets.get(key);
    return bucket ?? { frontmatterNotes: new Set(), inlineNotes: new Set() };
  }
```

5. `orphans()` iterates `this.entryPaths` instead of `this.index.all()` and sorts with the shared comparator; `hubs()` maps over `this.entryPaths` and tie-breaks with it; `notesWithTag()`'s final sort uses `compareCaseInsensitive(a.path, b.path)`.

- [x] **Step 4: Run — PASS** (`npx vitest run tests/vault/graph.test.ts tests/vault/analytics.test.ts tests/tools/graph-tools.test.ts`)

- [x] **Step 5: Commit** — `perf(graph): precompute tag rollup, cache entry paths, unify case-insensitive tie-breaks`

---

### Task 3: Shared match-text clamp + extract mentions from tools/graph.ts

**Files:**
- Create: `src/vault/mentions.ts`
- Modify: `src/storage/limits.ts`, `src/storage/local-fs.ts`, `src/tools/graph.ts`
- Test: `tests/storage/limits.test.ts`

**Interfaces:**
- Produces: `clampMatchText(text: string): string` in `limits.ts` (replaces both `windowMatchText` in local-fs.ts and `clampMatch` in tools/graph.ts); `contextByLine(adapter, items)` and `findUnlinkedMentions(adapter, notePath, frontmatter, backlinkSources)` in `src/vault/mentions.ts` with today's exact signatures.

- [x] **Step 1: Failing test** (append to `tests/storage/limits.test.ts`, import `clampMatchText, MAX_MATCH_TEXT_CHARS`)

```ts
  it('windows long match text with an ellipsis', () => {
    const exact = 'x'.repeat(MAX_MATCH_TEXT_CHARS);
    expect(clampMatchText(exact)).toBe(exact);
    expect(clampMatchText(`${exact}yyyyy`)).toBe(`${exact}…`);
  });
```

- [x] **Step 2: Run — FAIL** (no export)

- [x] **Step 3: Implement**

`limits.ts`:

```ts
/** Windows one line of match/context text so a single long line cannot blow the result-size cap.
 *  The one clamp shared by adapter search matches and the graph tools' context lines. */
export function clampMatchText(text: string): string {
  return text.length > MAX_MATCH_TEXT_CHARS ? `${text.slice(0, MAX_MATCH_TEXT_CHARS)}…` : text;
}
```

`local-fs.ts`: delete `windowMatchText`, import `clampMatchText` from `./limits.ts`, replace its two uses.

`src/vault/mentions.ts`: move `escapeRegExp`, `aliasCandidates`, `contextByLine`, `findUnlinkedMentions` verbatim from `src/tools/graph.ts` (imports: `MAX_BATCH`, `MAX_UNLINKED_MENTIONS`, `clampMatchText` from `../storage/limits.ts`; `baseName` from `../storage/path-policy.ts`; `type StorageAdapter` from `../storage/types.ts`), with two deltas: `clampMatch` → `clampMatchText`, and in `findUnlinkedMentions` push `context: m.text` (the adapter already windowed it — the re-clamp was the redundant call the review flagged).

`tools/graph.ts`: drop the moved functions and `clampMatch`; `import { contextByLine, findUnlinkedMentions } from '../vault/mentions.ts';` (`toContextHit` and `buildHeadingTree` stay — presentation).

- [x] **Step 4: Run — PASS** (`npx vitest run tests/storage/limits.test.ts tests/tools/graph-tools.test.ts tests/storage/local-fs-core.test.ts`)

- [x] **Step 5: Commit** — `refactor(vault): one shared clampMatchText; unlinked-mentions helpers move out of tools/graph.ts`

---

### Task 4: Message polish — failed[] CONFLICT helper, details-less CONFLICT, "0.0 MiB"

**Files:**
- Modify: `src/storage/types.ts`, `src/storage/limits.ts`, `src/storage/local-fs.ts`, `src/tools/manage.ts`
- Test: `tests/tools/results.test.ts`, `tests/storage/limits.test.ts`

**Interfaces:**
- Produces: `failedEntryMessage(error: VaultError): string` in `types.ts`, used by Task 9's extracted rewrite loop too.

- [x] **Step 1: Failing tests**

`tests/tools/results.test.ts` (import `failedEntryMessage` from types):

```ts
  it('serializes a CONFLICT thrown without details as {code} alone, without crashing', () => {
    const r = errorToResult(new VaultError('CONFLICT', 'stale'), () => {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: 'CONFLICT' });
  });

  it('failedEntryMessage keeps the code prefix only for CONFLICT', () => {
    expect(failedEntryMessage(new VaultError('CONFLICT', 'x changed'))).toBe(
      'CONFLICT: x changed',
    );
    expect(failedEntryMessage(new VaultError('NOT_FOUND', 'x missing'))).toBe('x missing');
  });
```

`tests/storage/limits.test.ts`:

```ts
  it('mentions MiB only for limits of at least 1 MiB', () => {
    const msg = (bytes: number, limit: number): string => {
      try {
        assertWithinSize(bytes, 'blob', limit);
      } catch (e) {
        return (e as VaultError).message;
      }
      return '';
    };
    expect(msg(101, 100)).not.toContain('MiB');
    expect(msg(MAX_FILE_BYTES + 1, MAX_FILE_BYTES)).toContain('(1 MiB)');
    expect(msg(9_000_000, MAX_BINARY_BYTES)).toContain('(8 MiB)');
  });
```

- [x] **Step 2: Run — FAIL** (`failedEntryMessage` missing; "0.0 MiB" present)

- [x] **Step 3: Implement**

`types.ts`:

```ts
/** Message for a per-item `failed[]` entry: CONFLICT keeps its code prefix (the caller needs the
 *  re-read-and-retry advice), every other code stays bare. The one rule shared by
 *  batchFrontmatterUpdate and vault_move's rewrite loops. */
export function failedEntryMessage(error: VaultError): string {
  return error.code === 'CONFLICT' ? `${error.code}: ${error.message}` : error.message;
}
```

Replace the three inline ternaries with `failedEntryMessage(error)`: `local-fs.ts` `batchFrontmatterUpdate` catch; `manage.ts` note-rewrite catch and canvas-rewrite catch.

`limits.ts` `assertWithinSize`:

```ts
export function assertWithinSize(
  bytes: number,
  what: string,
  limit: number = MAX_FILE_BYTES,
): void {
  if (bytes > limit) {
    const mib = limit / (1024 * 1024);
    // The parenthetical is a readability aid for MiB-scale limits; below 1 MiB it would round
    // to a meaningless "0.0 MiB", so the exact byte count stands alone.
    const inMib = mib >= 1 ? ` (${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB)` : '';
    throw new VaultError(
      'TOO_LARGE',
      `${what} is ${bytes} bytes; the limit is ${limit} bytes${inMib}. Split the content or use vault_append/vault_edit.`,
    );
  }
}
```

- [x] **Step 4: Run — PASS** (`npx vitest run tests/tools/results.test.ts tests/storage/limits.test.ts tests/storage/local-fs-core.test.ts tests/tools/move-links.test.ts`)

- [x] **Step 5: Commit** — `fix(storage): shared failed[] CONFLICT wording; no "0.0 MiB" for sub-MiB limits`

---

### Task 5: safe-regex — subject cap counted in code points

**Files:**
- Modify: `src/vault/safe-regex.ts`
- Test: `tests/vault/safe-regex.test.ts`

- [x] **Step 1: Failing test** (import `MAX_SUBJECT_CHARS`)

```ts
describe('subject cap is counted in code points', () => {
  it('accepts an astral-heavy subject whose UTF-16 length exceeds the cap', () => {
    const m = compileSafePattern('.*');
    expect(m.test('😀'.repeat(MAX_SUBJECT_CHARS))).toBe(true); // 2×cap UTF-16 units, cap code points
    expect(m.test('😀'.repeat(MAX_SUBJECT_CHARS + 1))).toBe(false);
    expect(m.test('a'.repeat(MAX_SUBJECT_CHARS))).toBe(true);
    expect(m.test('a'.repeat(MAX_SUBJECT_CHARS + 1))).toBe(false);
  });
});
```

- [x] **Step 2: Run — FAIL** (first expectation: length 4096 > 2048 rejected today)

- [x] **Step 3: Implement** — in `test()`, replace the up-front `subject.length` check:

```ts
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
      ...unchanged body...
    }
    return current.some((index) => (states[index] as NfaState).kind === 'match');
  }
```

Doc updates: `MAX_SUBJECT_CHARS` comment → `/** Subjects longer than this — counted in Unicode code points, the unit the matcher consumes (an astral character counts once) — never match. */`; module doc gains one line: "`.` and every set consume one code point, so an astral character (e.g. an emoji) counts as a single character — a deliberate divergence from JavaScript's non-`u` `RegExp`."

- [x] **Step 4: Run — PASS** (`npx vitest run tests/vault/safe-regex.test.ts tests/vault/query.test.ts`)

- [x] **Step 5: Commit** — `fix(vault): safe-regex subject cap counts code points, not UTF-16 units`

---

### Task 6: Templates — non-grammar placeholders reported in `unresolved`

**Files:**
- Modify: `src/vault/templates.ts`
- Test: `tests/vault/templates.test.ts`

- [x] **Step 1: Failing test**

```ts
  it('reports non-grammar placeholders (space/digit-led names) in unresolved', () => {
    const out = renderTemplate('Hello {{author}}, {{my var}} and {{2nd}} and {{ }}.', {
      title: 't',
      now: new Date('2026-08-31T10:00:00Z'),
      timezone: 'UTC',
    });
    expect(out.text).toBe('Hello {{author}}, {{my var}} and {{2nd}} and {{ }}.');
    expect(out.unresolved).toEqual(['author', 'my var', '2nd']);
  });
```

- [x] **Step 2: Run — FAIL** (today `unresolved` is `['author']`)

- [x] **Step 3: Implement** — add after the existing constants:

```ts
// Anchored single-placeholder version of PLACEHOLDER, for re-testing one already-extracted block.
const PLACEHOLDER_GRAMMAR = /^\{\{\s*([A-Za-z_][\w.-]*)\s*(?::\s*([^}]*?)\s*)?\}\}$/;
// Any {{...}} block at all, grammar-valid or not, for the unresolved sweep below.
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
```

and at the end of `renderTemplate`, before the `return`:

```ts
  // {{…}} blocks the grammar cannot even parse (space- or digit-led names, e.g. "{{my var}}" or
  // "{{2nd}}") are left verbatim like any unknown var — so they belong in `unresolved` too,
  // instead of silently passing through. Grammar-parsed names were handled by the replace above.
  for (const [, inner] of template.matchAll(ANY_PLACEHOLDER)) {
    const raw = (inner ?? '').trim();
    if (raw === '' || PLACEHOLDER_GRAMMAR.test(`{{${raw}}}`)) continue;
    const name = (raw.split(':')[0] ?? '').trim();
    if (name !== '') unresolvedSeen.add(name);
  }
```

Update the `RenderedTemplate.unresolved` doc: "…Also includes the (trimmed, before-':') text of `{{…}}` blocks whose name the grammar cannot parse; grammar-parsed names come first, then these, in template order."

- [x] **Step 4: Run — PASS** (`npx vitest run tests/vault/templates.test.ts tests/tools/template-tools.test.ts`)

- [x] **Step 5: Commit** — `fix(vault): templates report non-grammar {{…}} blocks in unresolved`

---

### Task 7: Sections — `listHeadingPaths` dedupes identical paths; docs

**Files:**
- Modify: `src/vault/sections.ts`
- Test: `tests/vault/sections.test.ts`

- [x] **Step 1: Failing test**

```ts
  it('lists an identical sibling heading path only once; the first occurrence is the reachable one', () => {
    const content = '# A\n\n## Tasks\none\n\n## Tasks\ntwo\n';
    expect(listHeadingPaths(content)).toEqual(['A', 'A > Tasks']);
    expect(findSection(content, 'A > Tasks')?.startLine).toBe(3);
  });
```

- [x] **Step 2: Run — FAIL** (today: `['A', 'A > Tasks', 'A > Tasks']`)

- [x] **Step 3: Implement** — in `listHeadingPaths`, dedupe:

```ts
  const seen = new Set<string>();
  for (const h of headings) {
    while (stack.length > 0 && (stack[stack.length - 1] as HeadingHit).level >= h.level) {
      stack.pop();
    }
    stack.push(h);
    const path = stack.map((s) => s.text).join(' > ');
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
```

Doc deltas: `listHeadingPaths` doc gains "Identical paths (same-text siblings, or same-text ancestors) are listed once — only the first occurrence is addressable anyway."; `findSection` doc gains one sentence: "Two headings producing the identical path cannot be told apart by path — every lookup reaches the first in file order."

- [x] **Step 4: Run — PASS** (`npx vitest run tests/vault/sections.test.ts tests/tools/sections-tools.test.ts`)

- [x] **Step 5: Commit** — `fix(vault): listHeadingPaths dedupes identical sibling paths; document first-wins`

---

### Task 8: Adapter post-write results; index.applyNote; tools stop re-reading their own writes

**Files:**
- Modify: `src/storage/types.ts`, `src/storage/local-fs.ts`, `src/vault/frontmatter-index.ts`, `src/tools/register.ts`, `src/tools/write.ts`, `src/tools/canvas.ts`, `src/tools/template.ts`, `src/tools/daily.ts`, `src/tools/manage.ts`
- Test: `tests/storage/local-fs-core.test.ts`, `tests/vault/frontmatter-index.test.ts`, `tests/tools/read-write.test.ts`

**Interfaces:**
- Produces (contract change, LocalFSAdapter is the only implementation):
  - `StorageAdapter.write(path, content, opts?): Promise<Note>` — the post-write note (fresh stat; content from memory, no re-read).
  - `StorageAdapter.append(path, content, opts?): Promise<Note>` — same.
  - `StorageAdapter.writeBinary(path, bytes, mime, opts?): Promise<string>` — the post-write content hash (same text-or-raw-bytes rule as `hashOf`).
  - `EditResult` gains `note: Note` (post-edit; for `dryRun` the unchanged pre-edit note).
  - `BatchResult` gains `updatedNotes: Note[]` (parallel to `updated`).
  - `FrontmatterIndex.applyNote(note: Note): void` — md ⇒ `upsert(fromNote(note))`, non-md ⇒ `addAsset(note.path)`.
  - `applyNote(tc: ToolContext, note: Note): void` in `register.ts` — the no-disk-read sibling of `touch()`.
- Existing callers that ignore the return values (`transaction.ts`) compile unchanged.

- [x] **Step 1: Failing tests**

`tests/storage/local-fs-core.test.ts` (uses the file's existing `vault` adapter fixture):

```ts
describe('post-write results', () => {
  it('write/append/edit return the post-write note; writeBinary returns the hash', async () => {
    const written = await vault.write('pw.md', '---\nk: 1\n---\nbody\n');
    expect(written.hash).toBe(await vault.hashOf('pw.md'));
    expect(written.frontmatter).toEqual({ k: 1 });
    expect(written.meta.size).toBeGreaterThan(0);

    const appended = await vault.append('pw.md', 'more');
    expect(appended.hash).toBe(await vault.hashOf('pw.md'));
    expect(appended.content.endsWith('more\n')).toBe(true);

    const edited = await vault.edit('pw.md', [{ find: 'more', replace: 'MORE' }]);
    expect(edited.note.hash).toBe(await vault.hashOf('pw.md'));

    const dry = await vault.edit('pw.md', [{ find: 'MORE', replace: 'zzz' }], true);
    expect(dry.note.hash).toBe(await vault.hashOf('pw.md')); // unchanged pre-image

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const hash = await vault.writeBinary('img/pw.png', png, 'image/png');
    expect(hash).toBe(await vault.hashOf('img/pw.png'));
  });

  it('batchFrontmatterUpdate returns updatedNotes aligned with updated', async () => {
    await vault.write('bfu.md', 'x\n');
    const result = await vault.batchFrontmatterUpdate([{ path: 'bfu.md', set: { a: 1 } }]);
    expect(result.updated).toEqual(['bfu.md']);
    expect(result.updatedNotes.map((n) => n.path)).toEqual(['bfu.md']);
    expect(result.updatedNotes[0]?.hash).toBe(await vault.hashOf('bfu.md'));
  });
});
```

`tests/vault/frontmatter-index.test.ts`:

```ts
  it('applyNote indexes a markdown note and tracks anything else as an asset', async () => {
    const note = await vault.read(/* an existing md fixture path in this file */);
    index.applyNote(note);
    expect(index.get(note.path)?.hash).toBe(note.hash);
    index.applyNote({ ...note, path: 'img/applied.png' });
    expect(index.assets().has('img/applied.png')).toBe(true);
  });
```

(Adapt the fixture names to the file's existing setup at execution time — the assertions are the contract.)

`tests/tools/read-write.test.ts` (harness): the "touch no-op for non-md" behavior pin — a fresh attachment resolves immediately, without waiting for the watcher:

```ts
  it('vault_write_binary makes the attachment resolvable immediately', async () => {
    await h.call('vault_write', { path: 'embeds.md', content: 'see ![[fresh.png]]\n' });
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    await h.call('vault_write_binary', { path: 'img/fresh.png', base64: png, mimeType: 'image/png' });
    const links = await h.call('vault_links', { path: 'embeds.md' });
    const embed = (links.structuredContent as { outgoing: { target: string; status: string }[] })
      .outgoing.find((o) => o.target === 'fresh.png');
    expect(embed?.status).toBe('resolved');
  });
```

- [x] **Step 2: Run — FAIL** (returns are `void` today; `applyNote`/`updatedNotes` missing)

- [x] **Step 3: Implement — storage layer**

`types.ts`: update `StorageAdapter` signatures and doc comments; `EditResult` gains `note: Note`; `BatchResult` gains `updatedNotes: Note[]`.

`local-fs.ts`:

```ts
  /** Builds a Note for text this adapter just wrote to `p` — fresh stat, no content re-read. */
  private async noteForWritten(p: string, content: string): Promise<Note> {
    const stat = await this.statOrNull(this.abs(p));
    if (!stat) throw new VaultError('IO', `Failed to stat ${p} after writing it.`);
    return this.noteFrom(p, content, stat);
  }

  /** Same rule hashOf documents: decoded text when the bytes are valid UTF-8, raw bytes otherwise. */
  private hashForBytes(p: string, bytes: Uint8Array): string {
    try {
      return sha256hex(this.decodeText(p, bytes));
    } catch {
      return createHash('sha256').update(bytes).digest('hex');
    }
  }
```

Split `toNote` into `toNote(p, bytes, stat)` (decodes, delegates) + `private noteFrom(p, content: string, stat)` (the existing body, taking the string). `hashOf` tail becomes `return this.hashForBytes(p, bytes);`. Then:

- `write`: `await this.atomicWrite(p, Buffer.from(finalContent, 'utf8')); return this.noteForWritten(p, finalContent);`
- `append`: `…; return this.noteForWritten(p, next);`
- `writeBinary`: `await this.atomicWrite(p, bytes); return this.hashForBytes(p, bytes);`
- `edit`: `if (dryRun) return { path: note.path, applied, diff, dryRun, note };` else write and `return { path: note.path, applied, diff, dryRun, note: await this.noteForWritten(note.path, content) };`
- `batchFrontmatterUpdate`: `const result: BatchResult = { updated: [], updatedNotes: [], failed: [] };` and after each successful write push `result.updatedNotes.push(await this.noteForWritten(p, text));`

`frontmatter-index.ts`:

```ts
  /** Applies a just-written (or just-read) Note without another disk read: markdown notes are
   *  (re)indexed, anything else is tracked as an asset. */
  applyNote(note: Note): void {
    if (isMarkdownPath(note.path)) this.upsert(FrontmatterIndex.fromNote(note));
    else this.addAsset(note.path);
  }
```

`register.ts` (import `type { Note }` from `../storage/types.ts`):

```ts
/** Applies an already-in-hand post-write Note to the index — the no-disk-read sibling of touch(). */
export function applyNote(tc: ToolContext, note: Note): void {
  tc.runtime.index.applyNote(note);
}
```

and extend `touch()`'s doc: "Markdown-only (refreshPath skips anything else) — non-markdown mutations apply the returned Note or call `index.addAsset` at the call site; the watcher also covers them."

**Tools** — replace every write-then-re-read with the returned value:

- `write.ts` `vault_write`: `const note = await adapter.write(p, content, {...}); applyNote(tc, note);` respond from `note`.
- `vault_write_binary`: `const hash = await adapter.writeBinary(p, bytes, mimeType, { expectedHash }); tc.runtime.index.addAsset(p);` respond with `hash` (drop the unreachable-null guard).
- `vault_edit`: `const { note, ...rest } = await adapter.edit(p, patches, dryRun ?? false, { expectedHash }); if (!rest.dryRun) applyNote(tc, note);` respond `okJson({ ...rest, hash: note.hash }, summary)` (destructuring keeps the Note out of `structuredContent`).
- `vault_append` both branches: use the `Note` returned by `adapter.write`/`adapter.append`, `applyNote`, respond from it.
- `vault_frontmatter_update`: keep the pre-read + `assertExpectedHash`; then `const written = result.updatedNotes[0]; if (!written) throw …; applyNote(tc, written);` respond from `written` (drop the trailing `adapter.read`).
- `vault_batch_frontmatter_update`: `for (const n of result.updatedNotes) applyNote(tc, n);` (replaces `touch(tc, ...result.updated)`).
- `canvas.ts` (all four mutators): `const note = await adapter.write(p, serializeCanvas(canvas), { expectedHash }); applyNote(tc, note);` respond with `note.hash` — this is also what registers a **newly created** canvas as an asset immediately (the `touch()` no-op gap).
- `template.ts`: `const written = await adapter.write(targetP, text); applyNote(tc, written);` respond with `written.hash`.
- `daily.ts` `vault_daily_note_append`: `const note = await adapter.append(path, content); applyNote(tc, note);` respond with `note.hash`.
- `manage.ts` note-rewrite loop: `const written = await adapter.write(actualPath, newContent, { expectedHash: expectedSourceHash }); applyNote(tc, written);` (drops one read per rewritten note).

- [x] **Step 4: Run — PASS** (`npx vitest run tests/storage tests/vault tests/tools` — full local suite; then `npm run typecheck`)

- [x] **Step 5: Commit** — `perf(storage): writes return the post-write note/hash; tools index it instead of re-reading`

---

### Task 9: Extract the vault_move handler's planning + rewrite loops

**Files:**
- Create: `src/tools/move.ts`
- Modify: `src/tools/manage.ts`
- Test: `tests/tools/move-links.test.ts` (existing suite is the safety net; pure refactor, no new behavior)

**Interfaces:**
- Produces (consumed only by `manage.ts`; registration position of `vault_move` inside `registerManageTools` is unchanged so tool ordering stays deterministic):

```ts
export interface MovedPath { oldPath: string; newPath: string; kind: 'note' | 'asset' }
export interface MovePlan {
  moved: MovedPath[];
  rewritesBySource: Map<string, { link: LinkRef; newPath: string }[]>;
  canvasPaths: string[];
  lockPaths: string[];
  movedNewPathByOld: Map<string, string>;
  movedLower: Map<string, string>;
}
export async function planMove(
  tc: ToolContext,
  src: string,
  dst: string,
  under: { path: string; kind: 'note' | 'asset' }[],
  updateLinks: boolean | undefined,
): Promise<MovePlan>;
export async function applyLinkRewrites(
  tc: ToolContext,
  plan: MovePlan,
): Promise<{ linksUpdated: { path: string; count: number }[]; failed: { path: string; error: string }[] }>;
```

- [x] **Step 1: Baseline** — `npx vitest run tests/tools/move-links.test.ts` PASS before touching anything (refactor guard).

- [x] **Step 2: Implement** — move the handler's blocks verbatim into `src/tools/move.ts`:
  - `planMove`: the `isNote`/`isAsset`/`effectiveUpdateLinks` derivation, `moved`, `rewritesBySource`, `movedNewPathByOld`, `movedLower`, `canvasPaths` (the `adapter.list` call), `lockPaths` — returning `MovePlan`. Keep every existing comment with its code.
  - `applyLinkRewrites`: the `basenameUniqueCache`/`isBasenameUnique` helper plus the note-rewrite and canvas-rewrite loops (now using `failedEntryMessage` from Task 4 and `applyNote` from Task 8), returning `{ linksUpdated, failed }`.
  - `manage.ts` handler shrinks to: normalize paths → `const plan = await planMove(tc, src, dst, entriesUnder(src), updateLinks);` → `locked(tc, plan.lockPaths, async () => { await adapter.move(...); index renames from plan.moved; touch dst when single file; const { linksUpdated, failed } = plan.rewritesBySource.size > 0 || plan.canvasPaths.length > 0 ? await applyLinkRewrites(tc, plan) : { linksUpdated: [], failed: [] }; hash; okJson })`.

- [x] **Step 3: Run — PASS** (`npx vitest run tests/tools/move-links.test.ts tests/tools/search-manage.test.ts tests/tools/acceptance-scenario.test.ts` and `npm run typecheck`)

- [x] **Step 4: Commit** — `refactor(tools): vault_move planning and link-rewrite loops extracted to tools/move.ts`

---

### Task 10: Perf guard — deterministic seeding, honest comments

**Files:**
- Modify: `tests/perf/index-build.test.ts`

- [x] **Step 1: Implement** (the test is its own test)

```ts
/** Deterministic PRNG (mulberry32) so the seeded vault is identical on every run — the guard's
 *  timing then varies only with the machine, never with the RNG. */
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
```

In `seedVault`, `const rand = mulberry32(0x5eed);` and replace all four `Math.random()` calls with `rand()`. Comment fixes: the seeding comment becomes true ("Two seeded-PRNG links and tags per note — deterministic scatter…"); the header keeps the measured numbers and states the margin explicitly: "bounds sit ~3× above the worst measured full-suite time (5.1 s vs the 15 s ceiling) — headroom for scheduler noise, not a target".

- [x] **Step 2: Run — PASS** (`npx vitest run tests/perf/index-build.test.ts`)

- [x] **Step 3: Commit** — `test(perf): deterministic seeding for the index-build guard; honest margin comment`

---

### Task 11: Zod schema dedupe — Cond/Tags/Op schemas live in args.ts

**Files:**
- Modify: `src/tools/args.ts`, `src/tools/query.ts`, `src/tools/search.ts`

**Interfaces:**
- Produces in `args.ts` (imports `{ z }` and `import type { Cond, Query } from '../vault/query.ts';` — still a leaf: `vault/query.ts` never imports a tool module; the CI boot smoke guards the cycle class):

```ts
export const QueryOpSchema = z
  .enum(['eq', 'neq', 'contains', 'startsWith', 'exists', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'])
  .describe(/* the exact operator text currently duplicated in query.ts/search.ts */);
export const CondSchema: z.ZodType<Cond> = z.object({
  field: z.string().min(1),
  op: QueryOpSchema,
  value: z.unknown().optional(),
});
export const TagsFilterSchema: z.ZodType<NonNullable<Query['tags']>> = z.object({
  any: z.array(z.string()).optional(),
  all: z.array(z.string()).optional(),
  none: z.array(z.string()).optional(),
});
```

- [x] **Step 1: Baseline** — `npx vitest run tests/tools/query-tools.test.ts tests/tools/search-manage.test.ts tests/tools/surface.test.ts` PASS.

- [x] **Step 2: Implement** — add the three exports to `args.ts` (update its module doc: "imports only Zod and types from pure vault modules — never a tool module"); delete `OpSchema`/`CondSchema`/`TagsFilterSchema` from `tools/query.ts` and `SearchCondSchema`/`SearchTagsSchema` (and their duplication-justifying comment) from `tools/search.ts`; both import from `./args.ts`. Call-site `.describe(...)` wrappers (`tags`, `where` field descriptions) stay where they are.

- [x] **Step 3: Run — PASS** (same three suites, plus `node -e "await import('./src/tools/register.ts')"` — the boot smoke)

- [x] **Step 4: Commit** — `refactor(tools): one CondSchema/TagsFilterSchema in args.ts for query and search`

---

### Task 12: Docs — CHANGELOG, wave record, re-adjudications

**Files:**
- Modify: `CHANGELOG.md`, `docs/plans/README.md`
- Create: `docs/reviews/2026-08-31-fix-later-wave.md`

- [x] **Step 1: CHANGELOG** — add under a new `## [Unreleased]`:
  - Changed: tags/orphans/hubs order ties case-insensitively; tag listing no longer rescans per call on tag-heavy vaults; write-type tools index their own write instead of re-reading (fewer disk reads per mutation, same results); `vault_search`/`vault_query` regex subject cap now counts characters (code points), so emoji-heavy values up to 2048 characters match.
  - Fixed: templates report space-/digit-led `{{…}}` placeholders in `unresolved`; duplicate sibling headings listed once in "No heading found" messages; sub-MiB size limits no longer print "0.0 MiB".

- [x] **Step 2: Wave record** — `docs/reviews/2026-08-31-fix-later-wave.md`: table item → commit; the three items re-adjudicated as documented-not-changed (final-segment file-order resolution; astral `.` = one code point; C1 residual cost) with one-line rationale each; note that the Tasks 3/4 coverage-breadth notes were discharged as the new graph/regex/template/section/adapter tests (originals no longer on disk). Add a pointer row/line in `docs/plans/README.md`.

- [x] **Step 3: Final gate** — `npm run lint:fix && npm run typecheck && npm test`; commit `docs: fix-later wave record and changelog`.

---

## Self-review

- Spec coverage: every fix-later item maps to a task in the table above; the three documented-divergence items are explicitly re-adjudicated in Task 12 rather than silently dropped.
- Placeholders: none — each step carries the code or the exact verbatim-move instruction with deltas named.
- Type consistency: `Note` from `src/storage/types.ts` everywhere; `applyNote(tc, note)` (register) vs `index.applyNote(note)` (index) both defined in Task 8 before use in Tasks 8–9; `failedEntryMessage` defined in Task 4, reused in Task 9; `compareCaseInsensitive` defined in Task 1, consumed in Task 2.
- Ordering: 1→2 (helpers before graph), 4 before 9 (helper before extraction), 8 before 9 (applyNote before extraction). Tasks 5–7, 10–11 are order-independent.
