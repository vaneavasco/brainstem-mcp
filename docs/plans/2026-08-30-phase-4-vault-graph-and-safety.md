# Phase 4 — Vault graph, safe concurrent writes, Obsidian coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the server the vault's link/tag graph, make concurrent writes safe with content hashes and a keyed lock, and close the remaining Obsidian file-format gaps — 21 → 30 vault tools, all on the raw folder.

**Architecture:** `FrontmatterIndex` entries grow to carry parsed links/tags/headings/block ids/hash; a derived in-memory `VaultGraph` (rebuilt lazily on an index version counter) answers link, tag, orphan and hub questions. A `WriteGate` (keyed async mutex + `expectedHash` check → `CONFLICT`) fronts every mutating adapter call; `vault_transaction` journals pre-images under `_brainstem/tx/` and rolls back. New tools are thin: they read the index/graph and call the adapter through the gate.

**Tech Stack:** Node 24 native TypeScript (`erasableSyntaxOnly`), Express 5, MCP TS SDK 2.0 (`@modelcontextprotocol/server`), Zod 4, Vitest 4, Biome, `yaml`, `date-fns`/`@date-fns/tz` (already present), ripgrep (Docker image; optional locally).

**Spec:** `docs/superpowers/specs/2026-08-30-phase-4-vault-graph-and-safety-design.md` — binding. Section numbers below (§4.x) refer to it.

## Global Constraints

- Every mutating tool call goes through `runtime.gate.withLock(paths, fn)`; every mutating adapter method accepts `expectedHash?` and throws `VaultError('CONFLICT', …, { path, currentHash })` on mismatch. Absent `expectedHash` ⇒ current behaviour (last write wins). (§4.5)
- `hash` = `sha256hex(content)` of the file text as read (frontmatter + body), hex lowercase, from `src/auth/hash.ts`. Returned by `vault_read`, `vault_batch_read` (per note), `vault_outline`, and by every write tool's result. (§4.5)
- Paths: everything still goes through `normalizeVaultPath`; `_brainstem/`, dot-folders (`.obsidian/`, `.trash/`) never appear in index, graph, query or link results. (§6)
- Regex search only via ripgrep (`-e`, never `--pcre2`, never `-F` for regex); pattern ≤ 200 chars; without ripgrep → `VaultError('UNSUPPORTED')`. (§4.8)
- Caps: `vault_links` 500 backlinks / 500 outgoing / 100 unlinked mentions; `vault_tags` 500 notes; `vault_query` limit ≤ 500 (default 100), `groupBy` paths ≤ 20 per group; `vault_recent` ≤ 200 (default 50); `vault_transaction` ≤ 20 ops. Index byte ceiling 64 MiB (`MAX_INDEX_BYTES`). (§4.2, §4.6, §4.7)
- `tests/tools/surface.test.ts` `EXPECTED` and `scripts/docker-smoke.sh` `[3/6]` count MUST equal the registered tool count **at every commit** (main is fast-forwarded per task and CI runs the smoke). Final count: 30 vault tools.
- Deprecated singular frontmatter keys (`tag`, `alias`) are not read; `tags`/`aliases` only. (§4.1)
- Link rewriting never touches code fences / inline code / `%% %%` comments and never rewrites an `ambiguous` link. (§4.3)
- Default instructions < 2,000 chars and only name registered tools (guard test exists). (§4.11)
- Conventions from `AGENTS.md`: TDD (failing test first), `.ts` import extensions, `import type`, no enums, Biome clean, Conventional Commits, no secrets in logs.

---

## File structure

```
src/vault/note-parse.ts        NEW  pure: links/tags/headings/blockIds/wordCount from a Note (masking code/comments)
src/vault/frontmatter-index.ts MOD  IndexEntry += parsed fields + hash; version counter; assets set
src/vault/graph.ts             NEW  VaultGraph: resolve, outgoing, backlinks, embeds, tags, orphans, hubs, unresolved/ambiguous
src/vault/link-rewrite.ts      NEW  pure: rewrite link targets in note text; canvas file-node rewrite
src/vault/query.ts             NEW  pure: evaluate vault_query conditions over IndexEntry + graph
src/vault/sections.ts          NEW  pure: heading-path → line range; insert into section
src/vault/templates.ts         NEW  pure: Obsidian core-Templates placeholders + {{var}} + unique prefix
src/vault/analytics.ts         MOD  categories from the graph (orphan_notes, ambiguous_links, hubs)
src/vault/runtime.ts           MOD  VaultRuntime += graph, gate, paths { vaultRoot, stateDir }
src/vault/instructions.ts      MOD  DEFAULT_INSTRUCTIONS rewritten (Task 12)
src/storage/types.ts           MOD  Note.hash, CONFLICT code, VaultError.details, opts with expectedHash, hardDelete
src/storage/write-gate.ts      NEW  WriteGate (keyed mutex) + assertExpectedHash
src/storage/transaction.ts     NEW  runTransaction: pre-flight, journal, apply, rollback
src/storage/local-fs.ts        MOD  hash on read; expectedHash in mutators; regex/paths in search; hardDelete; .base ext
src/storage/limits.ts          MOD  MIME allowlist, MAX_BINARY_BYTES, MAX_INDEX_BYTES, new caps
src/tools/graph.ts             NEW  vault_links, vault_tags, vault_outline
src/tools/query.ts             NEW  vault_query, vault_recent
src/tools/tx.ts                NEW  vault_transaction
src/tools/template.ts          NEW  vault_create_from_template
src/tools/{read,write,search,manage,canvas,daily}.ts MOD  hash/expectedHash/section/regex/link-rewrite/canvas update+remove
src/tools/results.ts           MOD  CONFLICT → structuredContent
src/tools/register.ts          MOD  register new groups; `locked()` helper
tests/vault/{note-parse,graph,link-rewrite,query,sections,templates}.test.ts  NEW
tests/storage/{write-gate,transaction}.test.ts  NEW
tests/tools/{graph-tools,query-tools,tx,move-links,sections-tools,template-tools}.test.ts  NEW
tests/tools/{surface,read-write,search-manage,canvas-daily-analytics,acceptance-scenario}.test.ts  MOD
tests/perf/index-build.test.ts  NEW  (guard, generous bound)
docs/adr/0006-vault-graph-and-optimistic-concurrency.md  NEW
README.md, AGENTS.md, CHANGELOG.md, scripts/docker-smoke.sh  MOD
```

---

### Task 1: Note parser — links, tags, headings, block ids, word count

**Files:**
- Create: `src/vault/note-parse.ts`
- Test: `tests/vault/note-parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LinkRef {
    raw: string;          // exact source text, e.g. "![[img.png|100]]" or "[text](<a b.md>)"
    target: string;       // "" for same-note anchors like [[#Heading]]
    heading?: string;     // "H1" or "H1#H2" (nested), without the leading '#'
    block?: string;       // block id without '^'
    alias?: string;       // display text after '|' (wiki) or link text (md)
    embed: boolean;       // leading '!'
    kind: 'wiki' | 'md';
    line: number;         // 1-based line in the FILE (frontmatter counted)
    start: number;        // offset of raw in the file content
    end: number;          // offset after raw
  }
  export interface Heading { level: number; text: string; line: number }
  export interface BlockId { id: string; line: number }
  export interface ParsedNote { links: LinkRef[]; tags: string[]; headings: Heading[]; blockIds: BlockId[]; wordCount: number }
  export function maskNonContent(text: string): string;   // fenced code, inline code, %% comments → spaces (same length, newlines kept)
  export function parseNote(content: string, frontmatter: Record<string, unknown>, body: string): ParsedNote;
  export function frontmatterTags(frontmatter: Record<string, unknown>): string[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/vault/note-parse.test.ts
import { describe, expect, it } from 'vitest';
import { frontmatterTags, maskNonContent, parseNote } from '../../src/vault/note-parse.ts';

const fm = (content: string) => {
  // tiny helper: split a '---' block the way the adapter does
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, unknown> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const [k, ...rest] = line.split(':');
    if (k) frontmatter[k.trim()] = rest.join(':').trim();
  }
  return { frontmatter, body: content.slice(m[0].length) };
};
const parse = (content: string, frontmatter?: Record<string, unknown>) => {
  const s = fm(content);
  return parseNote(content, frontmatter ?? s.frontmatter, s.body);
};

describe('maskNonContent', () => {
  it('blanks fenced code, inline code and %% comments but keeps length and newlines', () => {
    const src = 'a [[x]]\n```\n[[in-code]] #tag\n```\nb `[[inline]]` %% [[hidden]] %%\nc';
    const out = maskNonContent(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('[[x]]');
    expect(out).not.toContain('in-code');
    expect(out).not.toContain('inline');
    expect(out).not.toContain('hidden');
  });
  it('handles ~~~ fences and an unterminated fence to end of text', () => {
    const out = maskNonContent('x\n~~~\n[[a]]\n~~~\n[[b]]\n```\n[[c]]');
    expect(out).toContain('[[b]]');
    expect(out).not.toContain('[[a]]');
    expect(out).not.toContain('[[c]]');
  });
});

describe('parseNote links', () => {
  it('parses every Obsidian wikilink form', () => {
    const { links } = parse(
      '[[Note]] [[Note|Alias]] [[Note#Head]] [[Note#H1#H2|A]] [[Note#^blk]] ![[img.png|100]] [[#Local]] [[folder/Sub Note.md]]',
    );
    expect(links.map((l) => [l.target, l.heading, l.block, l.alias, l.embed])).toEqual([
      ['Note', undefined, undefined, undefined, false],
      ['Note', undefined, undefined, 'Alias', false],
      ['Note', 'Head', undefined, undefined, false],
      ['Note', 'H1#H2', undefined, 'A', false],
      ['Note', undefined, 'blk', undefined, false],
      ['img.png', undefined, undefined, '100', true],
      ['', 'Local', undefined, undefined, false],
      ['folder/Sub Note.md', undefined, undefined, undefined, false],
    ]);
    expect(links.every((l) => l.kind === 'wiki')).toBe(true);
    expect(links[0]?.raw).toBe('[[Note]]');
    expect(links[5]?.raw).toBe('![[img.png|100]]');
  });

  it('parses markdown links to vault paths and skips external schemes', () => {
    const { links } = parse(
      '[a](Note.md) [b](<Sub Folder/N%20B.md#Sec>) ![c](img.png) [d](https://x.y/z.md) [e](mailto:a@b.c) [f](obsidian://open?vault=v)',
    );
    expect(links.map((l) => [l.kind, l.target, l.heading, l.alias, l.embed])).toEqual([
      ['md', 'Note.md', undefined, 'a', false],
      ['md', 'Sub Folder/N B.md', 'Sec', 'b', false],
      ['md', 'img.png', undefined, 'c', true],
    ]);
  });

  it('reports file line numbers including the frontmatter block, and offsets', () => {
    const content = '---\ntitle: T\n---\n\nintro\n[[A]]\nx [[B]]';
    const { links } = parse(content);
    expect(links.map((l) => l.line)).toEqual([6, 7]);
    expect(content.slice(links[1]?.start, links[1]?.end)).toBe('[[B]]');
  });

  it('ignores links in code fences, inline code and comments', () => {
    const { links } = parse('[[keep]]\n```\n[[no1]]\n```\n`[[no2]]` %%[[no3]]%%');
    expect(links.map((l) => l.target)).toEqual(['keep']);
  });
});

describe('parseNote tags', () => {
  it('collects frontmatter tags (list or string) and inline tags, no duplicates, no digit-only tags', () => {
    const { tags } = parse(
      '---\ntags: [alpha, Beta/gamma]\n---\nText #alpha #delta #2024 #ok-1 #with_under #nested/deep and #beta/gamma. (#paren) #end',
      { tags: ['alpha', 'Beta/gamma'] },
    );
    expect(tags).toEqual([
      'alpha', 'Beta/gamma', 'delta', 'ok-1', 'with_under', 'nested/deep', 'paren', 'end',
    ]);
  });
  it('does not treat #heading markers, URL fragments or code as tags', () => {
    const { tags } = parse('# Heading\n## Two\nsee http://x.y/#frag and `#code` and a#b');
    expect(tags).toEqual([]);
  });
  it('frontmatterTags accepts "a, b" strings and strips leading #', () => {
    expect(frontmatterTags({ tags: '#a, b  c' })).toEqual(['a', 'b', 'c']);
    expect(frontmatterTags({ tag: 'legacy' })).toEqual([]);
    expect(frontmatterTags({ tags: [1, 'x', null] })).toEqual(['x']);
  });
});

describe('parseNote headings, block ids, words', () => {
  it('extracts headings with level and file line, ignoring fenced code', () => {
    const { headings } = parse('---\na: 1\n---\n# One\ntext\n## Two ##\n```\n# not\n```\n### Three');
    expect(headings).toEqual([
      { level: 1, text: 'One', line: 4 },
      { level: 2, text: 'Two', line: 6 },
      { level: 3, text: 'Three', line: 10 },
    ]);
  });
  it('extracts block ids at line end or on their own line', () => {
    const { blockIds } = parse('para one ^abc-1\n\n- item ^i2\n\n> quote\n^q3\n\nnot ^ inside');
    expect(blockIds).toEqual([
      { id: 'abc-1', line: 1 },
      { id: 'i2', line: 3 },
      { id: 'q3', line: 6 },
    ]);
  });
  it('counts words in the body only', () => {
    const { wordCount } = parse('---\ntitle: one two three\n---\nfour five, six!\n\n#tag seven');
    expect(wordCount).toBe(5); // four five six seven + "#tag"? no: tags are words too → 5 tokens with letters/digits: four five six #tag seven
  });
});
```

Note on the last test: the expected value is `5` because `wordCount` counts whitespace-separated tokens containing at least one letter or digit in the **unmasked body** (so `#tag` counts). Keep this definition.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/vault/note-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/note-parse.ts`**

```ts
export interface LinkRef {
  raw: string;
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
  embed: boolean;
  kind: 'wiki' | 'md';
  line: number;
  start: number;
  end: number;
}
export interface Heading { level: number; text: string; line: number }
export interface BlockId { id: string; line: number }
export interface ParsedNote {
  links: LinkRef[];
  tags: string[];
  headings: Heading[];
  blockIds: BlockId[];
  wordCount: number;
}

const FENCE = /^(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;
const COMMENT = /%%[\s\S]*?%%/g;
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
// [text](target) or [text](<target with spaces>); embeds have a leading '!'
const MD = /(!?)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^()\s]+))\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TAG = /(^|[\s([{,;"'])#([\p{L}\p{N}_/-]+)/gu;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/;
const BLOCK_ID_EOL = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;

/** Blank everything that is not note content, preserving length and newlines so offsets/lines hold. */
export function maskNonContent(text: string): string {
  const lines = text.split('\n');
  let inFence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (inFence) {
      out.push(blank(line));
      if (fence && fence[1]?.[0] === inFence[0] && fence[1].length >= inFence.length) inFence = null;
      continue;
    }
    if (fence) {
      inFence = fence[1] ?? null;
      out.push(blank(line));
      continue;
    }
    out.push(line);
  }
  let masked = out.join('\n');
  masked = masked.replace(COMMENT, (m) => blank(m));
  masked = masked.replace(INLINE_CODE, (m) => blank(m));
  return masked;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  const values: string[] = [];
  if (typeof raw === 'string') values.push(...raw.split(/[,\s]+/));
  else if (Array.isArray(raw)) values.push(...raw.filter((t): t is string => typeof t === 'string'));
  return values.map((t) => t.trim().replace(/^#/, '')).filter((t) => t !== '' && /[^\d/]/.test(t));
}

function splitWikiInner(inner: string): Omit<LinkRef, 'raw' | 'embed' | 'kind' | 'line' | 'start' | 'end'> {
  const pipe = inner.indexOf('|');
  const alias = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
  const ref = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = ref.indexOf('#');
  const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
  const anchor = hash >= 0 ? ref.slice(hash + 1) : '';
  if (anchor.startsWith('^')) return { target, block: anchor.slice(1), alias };
  if (anchor !== '') return { target, heading: anchor, alias };
  return { target, alias };
}

export function parseNote(
  content: string,
  frontmatter: Record<string, unknown>,
  body: string,
): ParsedNote {
  const bodyStart = content.length - body.length;
  const masked = maskNonContent(content);
  const maskedBody = masked.slice(bodyStart);
  const links: LinkRef[] = [];

  for (const m of maskedBody.matchAll(WIKI)) {
    const start = bodyStart + (m.index ?? 0);
    const end = start + m[0].length;
    const parts = splitWikiInner(m[2] ?? '');
    links.push({
      raw: content.slice(start, end),
      ...parts,
      embed: m[1] === '!',
      kind: 'wiki',
      line: lineAt(content, start),
      start,
      end,
    });
  }
  for (const m of maskedBody.matchAll(MD)) {
    const rawTarget = m[3] ?? m[4] ?? '';
    if (rawTarget === '' || SCHEME.test(rawTarget) || rawTarget.startsWith('#')) continue;
    const start = bodyStart + (m.index ?? 0);
    const end = start + m[0].length;
    const hash = rawTarget.indexOf('#');
    const targetPart = hash >= 0 ? rawTarget.slice(0, hash) : rawTarget;
    const anchor = hash >= 0 ? rawTarget.slice(hash + 1) : '';
    let target: string;
    try {
      target = decodeURIComponent(targetPart);
    } catch {
      target = targetPart;
    }
    links.push({
      raw: content.slice(start, end),
      target,
      ...(anchor.startsWith('^') ? { block: anchor.slice(1) } : anchor ? { heading: anchor } : {}),
      alias: m[2] ?? undefined,
      embed: m[1] === '!',
      kind: 'md',
      line: lineAt(content, start),
      start,
      end,
    });
  }
  links.sort((a, b) => a.start - b.start);

  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(t);
    }
  };
  for (const t of frontmatterTags(frontmatter)) push(t);
  for (const m of maskedBody.matchAll(TAG)) {
    const t = (m[2] ?? '').replace(/\/+$/, '');
    if (t !== '' && /[^\d/]/.test(t)) push(t);
  }

  const headings: Heading[] = [];
  const blockIds: BlockId[] = [];
  const maskedLines = maskedBody.split('\n');
  const firstBodyLine = lineAt(content, bodyStart);
  maskedLines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) headings.push({ level: (h[1] ?? '#').length, text: (h[2] ?? '').trim(), line: firstBodyLine + i });
    const b = BLOCK_ID_EOL.exec(line);
    if (b?.[1]) blockIds.push({ id: b[1], line: firstBodyLine + i });
  });

  const wordCount = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { links, tags, headings, blockIds, wordCount };
}
```

Adjust regex details until every test passes; do not weaken the tests. Heading regex: the trailing `##` closing sequence must be stripped (`'Two ##'` → `'Two'`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/vault/note-parse.test.ts` → PASS. Then `npm run lint:fix && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/vault/note-parse.ts tests/vault/note-parse.test.ts
git commit -m "feat(vault): note parser for links, tags, headings, block ids and word count"
```

---

### Task 2: Index extension — parsed fields, hash, version, assets; `hash` in reads

**Files:**
- Modify: `src/storage/types.ts` (`Note.hash`), `src/storage/local-fs.ts` (`read` computes hash), `src/vault/frontmatter-index.ts`, `src/storage/limits.ts` (`MAX_INDEX_BYTES = 64 * 1024 * 1024`), `src/tools/read.ts` (return `hash`)
- Test: `tests/vault/frontmatter-index.test.ts` (extend), `tests/tools/read-write.test.ts` (extend), `tests/storage/local-fs-core.test.ts` (extend)

**Interfaces:**
- Consumes: `parseNote` (Task 1), `sha256hex` (`src/auth/hash.ts`).
- Produces:
  ```ts
  // types.ts
  export interface Note { path; content; frontmatter; body; hasFrontmatter; meta; hash: string }
  // frontmatter-index.ts
  export interface IndexEntry {
    path: string; frontmatter: Record<string, unknown>; hasFrontmatter: boolean; size: number; modifiedAt: string;
    hash: string; links: LinkRef[]; tags: string[]; headings: Heading[]; blockIds: BlockId[]; wordCount: number;
  }
  class FrontmatterIndex {
    readonly version: number;              // increments on upsert/remove/rename/addAsset/removeAsset
    assets(): ReadonlySet<string>;          // vault paths of non-markdown files (never dot/reserved)
    addAsset(path: string): void; removeAsset(path: string): void; renameAsset(from: string, to: string): void;
    // existing API unchanged
  }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/vault/frontmatter-index.test.ts`:

```ts
it('indexes links, tags, headings, block ids, word count and content hash per note', async () => {
  // build a temp vault with: a.md '---\ntags: [t1]\n---\n# H\n[[b]] #t2 ^blk', b.md 'x', img.png (binary)
  // ... using the existing temp-vault helpers in this file
  const a = index.get('a.md');
  expect(a?.links.map((l) => l.target)).toEqual(['b']);
  expect(a?.tags).toEqual(['t1', 't2']);
  expect(a?.headings).toEqual([{ level: 1, text: 'H', line: 4 }]);
  expect(a?.blockIds).toEqual([{ id: 'blk', line: 5 }]);
  expect(a?.wordCount).toBe(4);
  expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(a?.hash).toBe(sha256hex((await adapter.read('a.md')).content));
});

it('tracks non-markdown assets and bumps version on every mutation', async () => {
  expect([...index.assets()]).toEqual(['img.png']);
  const v0 = index.version;
  index.upsert({ ...index.get('a.md')!, wordCount: 99 });
  index.removeAsset('img.png');
  index.addAsset('new.pdf');
  index.renameAsset('new.pdf', 'docs/new.pdf');
  index.rename('a.md', 'z.md');
  index.remove('z.md');
  expect(index.version).toBe(v0 + 6);
  expect([...index.assets()]).toEqual(['docs/new.pdf']);
});

it('watch events keep assets in sync (create/delete/rename of a .png)', async () => {
  // write img2.png via adapter.writeBinary, await the watcher (existing polling helper), expect assets() to contain it;
  // softDelete it → assets() no longer contains it
});
```

Add to `tests/tools/read-write.test.ts`: `vault_read` and `vault_batch_read` structured results carry `hash` equal to `sha256hex(content)`.

Add to `tests/storage/local-fs-core.test.ts`: `adapter.read(p)` returns `hash` and it changes after `append`.

- [ ] **Step 2: Run tests → FAIL** (`npx vitest run tests/vault/frontmatter-index.test.ts tests/tools/read-write.test.ts tests/storage/local-fs-core.test.ts`).

- [ ] **Step 3: Implement**

- `types.ts`: add `hash: string` to `Note`.
- `local-fs.ts` `read()`: after decoding, `hash: sha256hex(content)`; `batchRead` inherits (it calls `read`).
- `frontmatter-index.ts`: import `parseNote`; `fromNote` → `{ ...existing, hash: note.hash, ...parseNote(note.content, note.frontmatter, note.body) }`. Add `private _version = 0; get version() { return this._version; }` bumped in `upsert/remove/rename/addAsset/removeAsset/renameAsset`. Add `private readonly assetPaths = new Set<string>()`. In `build()`: for every listed file that is not markdown → `addAsset`. In `attach()`: handle non-markdown paths: `create|update` → `addAsset`, `delete` → `removeAsset` (skip dot/reserved — `list` never yields them, and watch already filters dot paths; add `isReservedPath` check defensively). Byte accounting: include a rough estimate of parsed fields (`JSON.stringify(links).length + tags.join().length + …`) and compare against `MAX_INDEX_BYTES`; when exceeded, log once via a `onOverBudget?` callback (keep the existing behaviour if there is a budget check already; do not throw).
- `read.ts`: `NoteSummary` gains `hash: z.string()`; both read tools include it.
- `register.ts` `touch()` also updates assets: if `!isMarkdownPath(p)` → `index.addAsset(p)` when the file exists (adapter.list on its parent is expensive — instead: `touch` accepts that callers pass only paths that exist; `vault_delete`/`vault_move` call `removeAsset`/`renameAsset` explicitly in Task 6).

- [ ] **Step 4: Run the full suite** `npx vitest run` → PASS; lint/typecheck clean.
- [ ] **Step 5: Commit** `git commit -am "feat(vault): index carries parsed links/tags/headings, content hash, assets and a version counter"`

---

### Task 3: `VaultGraph` + analytics from the graph

**Files:**
- Create: `src/vault/graph.ts`
- Modify: `src/vault/runtime.ts` (`graph: VaultGraph`), `src/vault/analytics.ts`, `src/tools/analytics.ts` (description lists new categories)
- Test: `tests/vault/graph.test.ts`, `tests/vault/analytics.test.ts` (extend)

**Interfaces:**
```ts
export type Resolution =
  | { status: 'resolved'; path: string; anchorFound?: boolean }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' };
export interface ResolvedLink { link: LinkRef; resolution: Resolution }
export interface Backlink { source: string; link: LinkRef }
export interface TagInfo { tag: string; count: number; nested: boolean; frontmatter: number; inline: number }
export class VaultGraph {
  constructor(index: FrontmatterIndex);
  resolve(target: string, fromPath: string, anchor?: { heading?: string; block?: string }): Resolution;
  outgoing(path: string): ResolvedLink[];
  backlinks(path: string): Backlink[];
  embedsOf(path: string): Backlink[];               // backlinks whose link.embed is true
  tags(): TagInfo[];                                 // sorted by count desc, then tag asc; parents aggregated
  notesWithTag(tag: string, includeNested?: boolean): { path: string; sources: ('frontmatter' | 'inline')[] }[];
  orphans(exclude?: (path: string) => boolean): string[];
  hubs(limit?: number): { path: string; backlinks: number }[];
  unresolved(): { source: string; link: LinkRef }[];
  ambiguous(): { source: string; link: LinkRef; candidates: string[] }[];
}
```
Rebuild rule: every public method first calls `this.ensureFresh()` which recomputes derived maps iff `index.version !== this.builtVersion`.

- [ ] **Step 1: Write the failing tests** (`tests/vault/graph.test.ts`) — build a `FrontmatterIndex` directly with `upsert` of hand-made entries (use a small helper `entry(path, content)` that runs `parseNote` and `sha256hex`), plus `addAsset('img/pic.png')`, `addAsset('boards/b.canvas')`:

```
notes: 'a.md' → '[[b]] [[c|C]] [[Missing]] [[dup]] ![[pic.png]] [[b#Sec]] [[b#^blk]] [[b#Nope]]'
       'b.md' → '# Sec\ntext ^blk\n[[a]]'
       'c.md' → '#t1 #proj/x\n[[folder/dup]]'
       'dup.md', 'folder/dup.md' → 'x'
       'lonely.md' → 'no links'
       frontmatter of c.md: { tags: ['T1', 'proj'] }
```
Assertions:
- `resolve('b','a.md')` → resolved `b.md`; `resolve('B','a.md')` → resolved (case-insensitive); `resolve('dup','a.md')` → ambiguous `['dup.md','folder/dup.md']`; `resolve('folder/dup','c.md')` → resolved `folder/dup.md`; `resolve('Missing','a.md')` → unresolved; `resolve('pic.png','a.md')` → resolved `img/pic.png` (asset by basename); `resolve('', 'a.md')` → resolved `a.md`.
- `outgoing('a.md')` anchors: `b#Sec` → anchorFound true; `b#^blk` → true; `b#Nope` → false.
- `backlinks('b.md')` → sources `['a.md']` ×3 links; `embedsOf('img/pic.png')` → from `a.md`.
- `tags()` → `t1` count 1 (c.md, frontmatter+inline, case-folded to the first spelling seen), `proj` count 1 with `nested:false`, `proj/x` nested true; parent `proj` aggregates the child (count counts distinct notes).
- `notesWithTag('proj')` includes c.md with sources `['frontmatter','inline']` (inline via `proj/x` when includeNested), `notesWithTag('proj', false)` sources only `['frontmatter']`.
- `orphans()` → `['lonely.md']` (dup notes have backlinks? `dup.md` has none resolved — ambiguous links do not count → both `dup.md` and `lonely.md` are orphans; `folder/dup.md` has a backlink from c.md). Expect `['dup.md','lonely.md']` sorted. With `exclude = p => p.startsWith('dup')` → `['lonely.md']`.
- `hubs(1)` → `[{ path: 'b.md', backlinks: 3 }]`.
- `unresolved()` → one item (`Missing` from a.md); `ambiguous()` → one (`dup` from a.md).
- Freshness: `index.upsert(entry('lonely.md','[[a]]'))` → `orphans()` no longer lists it (version bump triggers rebuild); calling twice without changes does not rebuild (spy on a private counter via `(graph as any).rebuilds`).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/vault/graph.ts`**

Key details:
- `norm(p) = p.toLowerCase()`; `stripMd(p)`; basename via `baseName()` from path-policy.
- Maps: `notesByPath: Map<lowerPathNoExt, path>`, `notesByBase: Map<lowerBase, path[]>`, `assetsByPath: Map<lowerPath, path>`, `assetsByBase: Map<lowerBase, path[]>`.
- `resolve`: `t = target.trim()`; if `t === ''` → self. If `t` contains `/`: strip leading `./`, try `notesByPath.get(norm(stripMd(t)))`, else `assetsByPath.get(norm(t))`; else basename: `notesByBase.get(norm(stripMd(t)))` ∪ (if `t` has an extension other than `.md`) `assetsByBase.get(norm(t))`. 0 → unresolved, 1 → resolved, >1 → ambiguous (sorted). `anchorFound`: for resolved notes with `heading` → compare `heading.split('#').at(-1)` case-insensitively against `entry.headings[].text`; with `block` → `entry.blockIds`.
- Derived `outgoing` computed for every entry; `backlinks` inverted from resolved ones only; `tags` from `entry.tags` — key is lowercase; display = first spelling seen; source classification: a tag is `frontmatter` if in `frontmatterTags(entry.frontmatter)`, else `inline`; parents: for `a/b/c` add `a` and `a/b` aggregates (count distinct notes).
- `orphans`: markdown notes with zero resolved outgoing and zero backlinks, filtered by `exclude`.
- `hubs`: sort by backlink count desc, path asc.

- `runtime.ts`: `VaultRuntime.graph = new VaultGraph(index)`.

- `analytics.ts`: replace the WIKILINK/INLINE_TAG scanning with the graph: `broken_wikilinks` ← `graph.unresolved()` (detail = raw target); new `ambiguous_links` ← `graph.ambiguous()` (detail = `target → candidates`); new `orphan_notes` ← `graph.orphans(p => p.startsWith(dailyFolder + '/'))`; `suspicious_tag_variants` computed from `graph.tags()` keys grouped by `tagKey`; `summary.hubs = graph.hubs(10)`. `analyzeVault(adapter, opts)` signature gains `graph: VaultGraph` and `dailyNotesFolder` in opts; `src/tools/analytics.ts` passes `tc.runtime.graph` and `settings.dailyNotes.folder`. Update `ANALYTICS_CATEGORIES` and the tool descriptions. `AnalyticsSummary` gains `hubs: { path: string; backlinks: number }[]`.

- [ ] **Step 4: Run the full suite → PASS; lint/typecheck.**
- [ ] **Step 5: Commit** `git commit -am "feat(vault): VaultGraph (link resolution, backlinks, tags, orphans, hubs); analytics reads the graph"`

---

### Task 4: Graph tools — `vault_links`, `vault_tags`, `vault_outline` (21 → 24)

**Files:**
- Create: `src/tools/graph.ts`
- Modify: `src/tools/register.ts`, `src/storage/limits.ts` (`MAX_GRAPH_ITEMS = 500`, `MAX_UNLINKED_MENTIONS = 100`), `tests/tools/surface.test.ts` (EXPECTED += 3; title "24"), `scripts/docker-smoke.sh` (`[3/6] … 24`)
- Test: `tests/tools/graph-tools.test.ts` (via `startHarness()`)

**Schemas (Zod, exact):**
```ts
vault_links: input { path: PathArg, include: z.array(z.enum(['outgoing','backlinks','embeds','unlinkedMentions'])).optional() }
  output { path, outgoing: [{ target, kind, line, embed, resolvedPath: string|null, status, candidates?: string[], anchorFound?: boolean }],
           backlinks: [{ path, line, context }], embeds: [{ path, line, context }],
           unlinkedMentions: [{ path, line, context }], truncated: { outgoing: boolean, backlinks: boolean, unlinkedMentions: boolean } }
vault_tags: input { tag: z.string().optional(), prefix: z.string().optional(), includeNested: z.boolean().optional() }
  output (no tag): { tags: [{ tag, count, nested, frontmatter, inline }], total }
  output (tag):    { tag, notes: [{ path, sources: ('frontmatter'|'inline')[] }], total, truncated }
vault_outline: input { path: PathArg }
  output { path, hash, modifiedAt, size, wordCount, frontmatterKeys: string[], tags: string[],
           headings: [{ level, text, line, children: [...] }] (tree), blockIds: [{ id, line }], linkCount, backlinkCount }
```
`context` for backlinks/embeds/mentions = the source line's text, clamped to `MAX_MATCH_TEXT_CHARS`, obtained by reading the source note once per source path (batch by `adapter.batchRead` in chunks of `MAX_BATCH`).
`unlinkedMentions`: candidates = basename without `.md` + every string in `frontmatter.aliases` (array or string); for each, `adapter.search(candidate, { limit: MAX_UNLINKED_MENTIONS * 2 })` (literal, case-insensitive), keep matches whose path ≠ the note and is not already a backlink source, whole-word check in JS (`new RegExp(\`(^|[^\\p{L}\\p{N}_])${escape(c)}([^\\p{L}\\p{N}_]|$)\`, 'iu')`), dedupe by path+line, cap `MAX_UNLINKED_MENTIONS`.
All three tools: `annotations: READ_ONLY`. Unknown note → `NOT_FOUND`.

- [ ] **Step 1: Tests** — seed a vault through the harness (`vault_write`) with the Task 3 shape plus `aliases: [Bee]` on b.md and a note `m.md` containing "the Bee note and b are mentioned" (no link); assert: outgoing statuses/anchors, backlinks with `context` text, `embeds`, `unlinkedMentions` finds `m.md` once for "Bee" (and `b` whole-word), not `a.md` (already links). `vault_tags` list and by-tag; `prefix: 'proj'` filters. `vault_outline` tree nesting (`# A`, `## B`, `### C`, `## D` → A.children=[B(children=[C]), D]`). Surface test lists 24.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** following `manage.ts` patterns (`guarded`, `okJson`, `normalizeVaultPath`). **Step 4: Full suite PASS; smoke count updated.** **Step 5: Commit** `feat(tools): vault_links, vault_tags, vault_outline`.

---

### Task 5: WriteGate, `expectedHash`, `CONFLICT`

**Files:**
- Create: `src/storage/write-gate.ts`
- Modify: `src/storage/types.ts`, `src/storage/local-fs.ts`, `src/tools/results.ts`, `src/tools/register.ts` (`locked()`), `src/vault/runtime.ts` (`gate`), `src/tools/{write,manage,canvas,daily}.ts`
- Test: `tests/storage/write-gate.test.ts`, `tests/tools/read-write.test.ts` (extend), `tests/tools/results.test.ts` (extend)

**Interfaces:**
```ts
// types.ts
export type VaultErrorCode = … | 'CONFLICT';
export class VaultError { constructor(code, message, readonly details?: Record<string, unknown>) }
export interface WriteOpts { mergeFrontmatter?: boolean; expectedHash?: string }
export interface MutateOpts { expectedHash?: string }
export interface FmUpdate { path; set?; unset?; expectedHash?: string }
export interface StorageAdapter {
  write(path, content, opts?: WriteOpts); writeBinary(path, bytes, mime, opts?: MutateOpts);
  edit(path, patches, dryRun?, opts?: MutateOpts); append(path, content, opts?: MutateOpts);
  batchFrontmatterUpdate(updates: FmUpdate[]); move(from, to, opts?: MutateOpts); softDelete(path, confirm, opts?: MutateOpts);
  hashOf(path): Promise<string | null>;            // null when the file does not exist
  hardDelete(path): Promise<void>;                 // internal: transaction rollback only (Task 7)
  …
}
// write-gate.ts
export class WriteGate {
  withLock<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T>;  // sorted, deduped, acquired in order
}
export function assertExpectedHash(path: string, current: string | null, expected: string | undefined): void;
// register.ts
export function locked<T>(tc: ToolContext, paths: string[], fn: () => Promise<T>): Promise<T>;
```
`assertExpectedHash` throws `new VaultError('CONFLICT', \`${path} changed since it was read (expected ${expected.slice(0,12)}…, current ${current ? current.slice(0,12)+'…' : 'missing'}). Re-read it and retry with the new hash.\`, { path, currentHash: current })`.

- [ ] **Step 1: Tests**
  - `write-gate.test.ts`: two `withLock(['a'])` calls serialize (record enter/exit order with deferred promises); `withLock(['a','b'])` vs `withLock(['b','a'])` never deadlock (both complete; use `Promise.all` with a timeout guard); a throwing `fn` releases the lock; `assertExpectedHash` passes on equal, throws `CONFLICT` with `details.currentHash` on mismatch and when current is null.
  - `read-write.test.ts`: `vault_write` with a stale `expectedHash` → `isError`, text starts with `CONFLICT:`, `structuredContent` = `{ code: 'CONFLICT', path, currentHash }`; with the right hash → ok and the result's `hash` equals the new content hash; `vault_edit`, `vault_append`, `vault_frontmatter_update`, `vault_batch_frontmatter_update` (per-item failure lands in `failed[]` with `CONFLICT` text), `vault_move`, `vault_delete` (single file) all honour `expectedHash`.
  - `results.test.ts`: `errorToResult(new VaultError('CONFLICT','m',{path:'p',currentHash:'h'}))` yields `structuredContent`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - `local-fs.ts`: private `async currentHash(p)` = `hashOf`; in `write/edit/append/batchFrontmatterUpdate/move/softDelete/writeBinary`, when `opts?.expectedHash !== undefined` call `assertExpectedHash(p, await this.hashOf(p), expected)` **before** mutating (inside the same method; the tool-level lock guarantees no interleaving). `hashOf` reads bytes and hashes the decoded string exactly as `read()` does (share a private helper so the two never diverge). `hardDelete(p)`: `fs.unlink` after `assertInsideRoot`; rejects reserved/dot paths.
  - `results.ts`: for `VaultError` with `code === 'CONFLICT'` return `{ isError: true, content: [{type:'text', text}], structuredContent: { code: 'CONFLICT', ...error.details } }`.
  - `runtime.ts`: `gate: new WriteGate()`.
  - Tools: add `expectedHash: z.string().length(64).optional()` to the input schemas listed above; wrap adapter calls in `locked(tc, [paths], …)`; every write tool's output gains `hash` (read after write via `adapter.hashOf`). `vault_batch_frontmatter_update` locks all paths at once. `vault_daily_note_append` and the canvas tools are wrapped in `locked` (no `expectedHash` for daily; canvas tools gain `expectedHash`).
- [ ] **Step 4: Full suite PASS.** **Step 5: Commit** `feat(storage): keyed write lock and optimistic concurrency with expectedHash → CONFLICT`.

---

### Task 6: `vault_move` rewrites links (notes + canvas file nodes)

**Files:**
- Create: `src/vault/link-rewrite.ts`
- Modify: `src/tools/manage.ts`, `src/vault/canvas.ts` (`rewriteFileNodes`)
- Test: `tests/vault/link-rewrite.test.ts`, `tests/tools/move-links.test.ts`

**Interfaces:**
```ts
// link-rewrite.ts
export interface TargetRewrite { link: LinkRef; newTarget: string }
export function rewriteLinks(content: string, rewrites: TargetRewrite[]): string;   // replaces raw spans, preserving alias/anchor/embed/kind; md links re-encode spaces with <…>
export function newTargetText(link: LinkRef, newPath: string, opts: { fromPath: string; basenameUnique: boolean }): string;
// canvas.ts
export function rewriteFileNodes(canvas: Canvas, mapping: Map<string /*lower old path*/, string>): { canvas: Canvas; count: number };
```
`newTargetText` rules (§4.3): wiki link whose old `target` had no `/` and `basenameUnique` → new basename (no `.md`); otherwise vault path without `.md` (assets keep their extension). Markdown links → relative path from `fromPath`'s folder to `newPath` (keep `.md`), wrapped in `<…>` if it contains spaces, else `%20`-free plain.

- [ ] **Step 1: Tests**
  - `link-rewrite.test.ts`: table over every link form from Task 1 — rename `b` → `notes/c`: `[[b]]`→`[[notes/c]]` when basename not unique, `[[c]]` when unique; `[[b|Al]]`→`[[c|Al]]`; `[[b#Sec]]`→`[[c#Sec]]`; `![[b]]`→`![[c]]`; `[t](b.md)` from `x/y.md` → `[t](../notes/c.md)`; `[t](<b.md#S>)` → `[t](<../notes/c.md#S>)`; spaces → `<…>`; untouched text identical; multiple links in one line rewritten right-to-left so offsets hold.
  - `move-links.test.ts` (harness): seed a.md/b.md/c.md/folder; `vault_move {from:'b.md', to:'notes/b2.md'}` → a.md and c.md links updated, result `linksUpdated` lists both with counts, `failed: []`; index/graph coherent (`vault_links` on `notes/b2.md` shows the same backlinks); `updateLinks:false` leaves links; **ambiguous** link `[[dup]]` untouched when renaming `dup.md`; link inside a code fence untouched; folder move `folder/` → `archive/folder/` rewrites `[[folder/dup]]` to `[[archive/folder/dup]]` and leaves bare `[[x]]` alone; canvas with a `file` node pointing at `b.md` gets `notes/b2.md`; a linking note with a stale `expectedHash`-style concurrent edit is reported in `failed` (simulate by making the source note read-only? no — simulate by monkeypatching `adapter.write` for that path to throw `CONFLICT` once).
- [ ] **Step 2: FAIL.** **Step 3: Implement** in `manage.ts`: `updateLinks` default `true`; compute `moved: Map<oldPathLower, newPath>` (single note or every index entry/asset under the folder); collect sources = union of `graph.backlinks(old)` for each moved path; group rewrites per source; for each source (excluding moved notes themselves whose own content is not changed — self-links `[[#x]]` are target `''` and untouched) read once, `rewriteLinks`, write through `locked` with the indexed hash as `expectedHash`, catch `VaultError` → `failed[]`. Then canvases: `adapter.list('', { depth: ∞, glob: '**/*.canvas' })`, parse, `rewriteFileNodes`, write if `count > 0`. Update index: `index.rename`/`renameAsset`, `touch` sources. Output schema: `{ from, to, linksUpdated: [{path,count}], failed: [{path,error}] }`. **Step 4: PASS.** **Step 5: Commit** `feat(tools): vault_move rewrites wikilinks, markdown links and canvas file nodes`.

---

### Task 7: `vault_transaction` (24 → 25)

**Files:**
- Create: `src/storage/transaction.ts`, `src/tools/tx.ts`
- Modify: `src/vault/runtime.ts` (`paths: { vaultRoot, stateDir }`; `createLocalRuntime` option `stateDir?`), `src/main.ts` (pass `stateDir`), `tests/tools/harness.ts` (temp stateDir), surface/smoke counts (25)
- Test: `tests/storage/transaction.test.ts`, `tests/tools/tx.test.ts`

**Interfaces:**
```ts
export type TxOp =
  | { op: 'write'; path: string; content: string; mergeFrontmatter?: boolean; expectedHash?: string }
  | { op: 'edit'; path: string; patches: TextPatch[]; expectedHash?: string }
  | { op: 'append'; path: string; content: string; expectedHash?: string }
  | { op: 'frontmatter_update'; path: string; set?: Record<string, unknown>; unset?: string[]; expectedHash?: string }
  | { op: 'move'; from: string; to: string; expectedHash?: string }
  | { op: 'delete'; path: string; confirm: boolean; expectedHash?: string };
export interface TxOpResult { index: number; op: TxOp['op']; ok: boolean; error?: string; diff?: string; hash?: string }
export interface TxResult { id: string; applied: boolean; dryRun: boolean; rolledBack: boolean; results: TxOpResult[]; journal?: string }
export async function runTransaction(deps: { adapter: StorageAdapter; gate: WriteGate; vaultRoot: string; stateDir: string; now?: () => Date }, ops: TxOp[], opts: { dryRun?: boolean }): Promise<TxResult>;
```
Journal layout: `<stateDir>/tx/<id>/manifest.json` + `0001.bin…` pre-images (raw bytes copied with `fs.copyFile` from `<vaultRoot>/<path>`); `id = <ISO compact>-<6 hex>`. On success the directory is removed; on rollback failure it stays and `journal` carries its path.

- [ ] **Step 1: Tests**
  - `transaction.test.ts` (real temp vault + `LocalFSAdapter`): pre-flight failure (bad `expectedHash` on op 2) → nothing written, `applied:false`, `results[1].ok === false`; `dryRun` returns diffs and writes nothing; happy path with write+edit+append+frontmatter_update+move+delete → all applied, journal dir gone; **mid-apply failure**: monkeypatch `adapter.append` to throw on op 3 → every touched file byte-identical to before (compare buffers), moved file back, deleted file restored, created file gone (`hardDelete`), `rolledBack:true`; rollback failure (make `adapter.write` throw during rollback) → `journal` path returned and the dir exists with the pre-images.
  - `tx.test.ts` (harness): tool schema accepts the union, returns per-op results; > 20 ops → `INVALID_INPUT`.
- [ ] **Step 2: FAIL.** **Step 3: Implement** — order: lock all paths (sorted unique of every `path/from/to`) → pre-flight (read current content/hash for each existing target; `assertExpectedHash`; simulate `applyTextPatches`; move dest must not exist; delete needs confirm; `dryRun` → build diffs via `unifiedDiff` and return) → journal (copy every existing touched file; record created paths) → apply sequentially via adapter (`expectedHash` already verified, pass none) → success: remove journal → on error: rollback in reverse (restore pre-images with `fs.copyFile` back into the vault root — not through the adapter, so size/merge logic cannot interfere; created files `hardDelete`; moves reversed by `fs.rename`), then return. Index: after apply, `touch` every touched path; on rollback `touch` as well. Tool `vault_transaction` (`annotations: OVERWRITE`) validates with a Zod discriminated union; output schema mirrors `TxResult`. **Step 4: PASS; counts 25.** **Step 5: Commit** `feat(tools): vault_transaction with journal and rollback`.

---

### Task 8: `vault_query` and `vault_recent` (25 → 27)

**Files:**
- Create: `src/vault/query.ts`, `src/tools/query.ts`
- Modify: register, surface/smoke counts (27), `src/storage/limits.ts` (`MAX_QUERY_ROWS = 500`, `MAX_RECENT = 200`)
- Test: `tests/vault/query.test.ts`, `tests/tools/query-tools.test.ts`

**Interfaces:**
```ts
export type Op = 'eq'|'neq'|'contains'|'startsWith'|'exists'|'gt'|'gte'|'lt'|'lte'|'in'|'regex';
export interface Cond { field: string; op: Op; value?: unknown }
export interface Query { where?: Cond[]; tags?: { any?: string[]; all?: string[]; none?: string[] }; pathPrefix?: string; select?: string[]; sort?: { field: string; order: 'asc'|'desc' }[]; limit?: number; groupBy?: string }
export interface QueryRow { path: string; [field: string]: unknown }
export interface QueryResult { rows: QueryRow[]; total: number; truncated: boolean; groups?: { key: string; count: number; paths: string[] }[] }
export function fieldValue(entry: IndexEntry, graph: VaultGraph, field: string): unknown;  // frontmatter dot-path or virtual: path, basename, folder, modifiedAt, size, wordCount, backlinks, outgoing, tags, hash
export function evaluateQuery(entries: Iterable<IndexEntry>, graph: VaultGraph, q: Query): QueryResult;
```
Comparison rules (§4.7): both numbers → numeric; both ISO date/datetime strings (`/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/`) → chronological; strings → case-insensitive; arrays: `eq`/`in` by membership, `contains` if any element contains; `exists` → value !== undefined (with `value:false` → must not exist); `regex` → `new RegExp(value, 'i')` on `String(field)`; reject patterns > 200 chars or containing `\\\d` (backreference) with `INVALID_INPUT`. Tag filters are case-insensitive and nested-aware (`any: ['proj']` matches `proj/x`).

- [ ] **Step 1: Tests** — pure `query.test.ts`: each op × type (number/date/string/array), `sort` multi-key with `desc`, `limit`/`truncated`, `groupBy` with `paths` ≤ 20, `select` limiting fields, virtual fields, tag filters, invalid regex → throws `INVALID_INPUT`. `query-tools.test.ts` via harness: `vault_query { where:[{field:'status',op:'eq',value:'active'}], sort:[{field:'modifiedAt',order:'desc'}], select:['status','tags'] }` and `vault_recent { since, limit }` ordering; caps enforced.
- [ ] **Step 2: FAIL. Step 3: Implement.** `vault_recent` = `evaluateQuery` with `where:[{field:'modifiedAt',op:'gte',value:since}]`, sort desc, select `['modifiedAt','size','wordCount']`. Both `READ_ONLY`. **Step 4: PASS; counts 27. Step 5: Commit** `feat(tools): vault_query (Bases-style) and vault_recent`.

---

### Task 9: Search upgrade — regex via ripgrep, tag/frontmatter pre-filters, grouped output

**Files:**
- Modify: `src/storage/types.ts` (`SearchOpts += regex?: boolean; paths?: string[]`), `src/storage/local-fs.ts` (`search`), `src/tools/search.ts`
- Test: `tests/storage/local-fs-core.test.ts` (rg-gated regex cases + `paths` restriction in the JS fallback), `tests/tools/search-manage.test.ts`

Behaviour:
- `opts.regex === true` and ripgrep unavailable → `VaultError('UNSUPPORTED', 'regex search needs ripgrep (the Docker image has it); use a literal query here')`. With ripgrep: drop `-F`, pass `-e <pattern>`; never add `--pcre2`. Pattern length > 200 → `INVALID_INPUT`.
- `opts.paths` (≤ 200 entries): ripgrep gets them as positional file arguments (after `--`), relative to root; JS fallback iterates only them. The tool passes candidates when `tags`/`where` filters yield ≤ 200 paths, otherwise searches all and post-filters.
- Tool input adds `regex?: boolean`, `tags?: { any?, all?, none? }`, `where?: Cond[]`, `glob?: string`; output becomes `{ query, files: [{ path, matches: [{ line, text }] }], total, truncated }` (existing `matches` flat array retained too for compatibility; the description tells the model to prefer `files`).

- [ ] **Steps:** tests first (regex tests `describe.skipIf(!rgAvailable)` like the existing rg suite; JS fallback for `paths`), implement, full suite, commit `feat(search): regex via ripgrep, tag/frontmatter filters, grouped results`.

---

### Task 10: Read and append by section

**Files:**
- Create: `src/vault/sections.ts`
- Modify: `src/tools/read.ts` (`section?`), `src/tools/write.ts` (`vault_append` `heading?`, `position?`)
- Test: `tests/vault/sections.test.ts`, `tests/tools/sections-tools.test.ts`

**Interfaces:**
```ts
export interface SectionRange { startLine: number; endLine: number; level: number; heading: string }  // 1-based file lines, inclusive; endLine = last line before the next heading of level ≤ this, or last line
export function findSection(content: string, headingPath: string): SectionRange | null;   // "A", "A > B", case-insensitive, trims '#'
export function sliceSection(content: string, range: SectionRange): string;
export function insertIntoSection(content: string, range: SectionRange, text: string, position: 'start' | 'end'): string;
export function listHeadingPaths(content: string): string[];   // for NOT_FOUND messages: ["A", "A > B", …]
```
`insertIntoSection` `end`: insert after the last non-blank line of the section, keeping exactly one blank line before the next heading if one followed; `start`: right after the heading line (after a blank line if the section already starts with one). Text gets a trailing newline. Uses `maskNonContent` so `#` inside code is not a heading.

- [ ] **Steps:** tests (nested paths, duplicate heading names at different depths, section at EOF, code-fence `#`, CRLF content), implement, wire `vault_read {section}` → returns only the slice with `sectionRange`, `vault_append {heading, position}` → `NOT_FOUND` lists `listHeadingPaths`, full suite, commit `feat(tools): read and append by heading section`.

---

### Task 11: Canvas update/remove, `.base`, Obsidian MIME list, `vault_create_from_template` (27 → 30)

**Files:**
- Create: `src/vault/templates.ts`, `src/tools/template.ts`
- Modify: `src/vault/canvas.ts` (`updateNode`, `removeNodesAndEdges`), `src/tools/canvas.ts`, `src/storage/local-fs.ts` (`TEXT_EXTENSIONS += '.base'`), `src/storage/limits.ts` (MIME list, `MAX_BINARY_BYTES` from env `MAX_BINARY_BYTES` default 8 MiB — read in `config.ts` and passed to `LocalFSAdapter.create` options), `src/config.ts`, `compose.yaml`/`.env.example` (`MAX_BINARY_BYTES=`), `src/vault/daily-notes.ts` (`{{time}}` support shared), register, surface/smoke counts (30)
- Test: `tests/vault/templates.test.ts`, `tests/vault/canvas.test.ts` (extend), `tests/tools/canvas-daily-analytics.test.ts` (extend), `tests/storage/limits.test.ts` (extend), `tests/tools/template-tools.test.ts`

**Interfaces:**
```ts
// canvas.ts
export function updateNode(canvas: Canvas, id: string, patch: Partial<Omit<CanvasNodeInput,'type'|'id'>>): { canvas: Canvas; node: CanvasNode };
export function removeNodesAndEdges(canvas: Canvas, nodeIds: string[], edgeIds: string[]): { canvas: Canvas; removedNodes: string[]; removedEdges: string[] };
// templates.ts
export function renderTemplate(template: string, ctx: { title: string; now: Date; timezone: string; vars?: Record<string, string> }): { text: string; unresolved: string[] };
export function uniquePrefix(now: Date, timezone: string): string;   // 'YYYYMMDDHHmm '
```
MIME allowlist (extension lists): `image/png .png; image/jpeg .jpg .jpeg; image/gif .gif; image/webp .webp; image/avif .avif; image/bmp .bmp; image/svg+xml .svg; application/pdf .pdf; audio/mpeg .mp3; audio/mp4 .m4a; audio/ogg .ogg; audio/wav .wav; audio/flac .flac; audio/webm .webm; audio/3gpp .3gp; video/mp4 .mp4; video/quicktime .mov; video/x-matroska .mkv; video/ogg .ogv; video/webm .webm`. `writeBinary` size limit becomes `MAX_BINARY_BYTES` (text stays `MAX_FILE_BYTES`).

Tools: `vault_canvas_update_node { path, id, patch, expectedHash? }`, `vault_canvas_remove { path, nodeIds?, edgeIds?, expectedHash? }` (at least one), `vault_create_from_template { templatePath, targetPath, vars?, uniquePrefix?, title? }` → `{ path, hash, unresolved }` (`ALREADY_EXISTS` if target exists; `title` defaults to target basename without `.md`).

- [ ] **Steps:** tests first (canvas update partial/unknown id; remove cascades edges; `.base` round-trips through `vault_write`/`vault_read`/`vault_search`; svg/mp3 accepted, mismatch rejected, 8 MiB cap; template placeholders incl. `{{date:YYYY-MM}}`, `{{time:HH}}`, `{{custom}}` from vars, unresolved list, unique prefix in vault timezone), implement, full suite, counts 30, commit `feat: canvas update/remove, .base files, Obsidian attachment types, notes from templates`.

---

### Task 12: Instructions, docs, ADR, acceptance contract, perf guard, release prep

**Files:**
- Modify: `src/vault/instructions.ts` (DEFAULT_INSTRUCTIONS rewritten per §4.11, < 2,000 chars, names only registered tools), `README.md` (capability table; tools 30; sections: concurrency/`expectedHash`, transactions, link-updating renames, section edits, `.base`/attachments, templates), `AGENTS.md` (layout, "30 tools", new modules), `CHANGELOG.md` (`## [Unreleased]` → all Phase 4 items under Added/Changed), `docs/plans/README.md` (Phase 4′ row → complete), `docs/implementation-plan.md` §5 tool list (30), `scripts/docker-smoke.sh` (call `vault_links` on the smoke note and `vault_query` once; expect 30), `tests/tools/acceptance-scenario.test.ts` (extend: outline → section read → edit with hash → stale hash CONFLICT → transaction → move with link update → query → tags → recent)
- Create: `docs/adr/0006-vault-graph-and-optimistic-concurrency.md`, `tests/perf/index-build.test.ts`

- [ ] **Step 1:** perf guard test: generate 5,000 small notes (each linking 2 random others, 2 tags) in a temp dir; `createLocalRuntime` + `graph.hubs(10)` complete in < 5 s (generous CI bound; log the actual time); `evaluateQuery` over them < 200 ms. Acceptance test extension fails until docs/instructions updated? No — the acceptance test exercises tools, which exist; write it and make it pass; the instructions guard test forces the tool names to be right.
- [ ] **Step 2:** rewrite `DEFAULT_INSTRUCTIONS`; run `tests/vault/instructions.test.ts`.
- [ ] **Step 3:** docs + ADR + CHANGELOG + smoke; `npm run docker:smoke` locally if Docker is available (report if not).
- [ ] **Step 4:** full suite, lint, typecheck. **Step 5:** commit `docs: Phase 4 — instructions, README, AGENTS, ADR 0006, acceptance contract, perf guard`.

Release (controller, after the final review): `CHANGELOG` `[Unreleased]` → `[0.3.0]`, `npm pkg set version=0.3.0` + lockfile, tag `v0.3.0`, GitHub release, images published by CI.

---

## Self-review notes (plan author)

- Spec coverage: §4.1 → T1/T2; §4.2 → T3/T4; §4.3 → T6; §4.4 → T10; §4.5 → T5; §4.6 → T7; §4.7 → T8; §4.8 → T9; §4.9/§4.10 → T11; §4.11 + §9 → T12. Perf guard §8 → T12.
- Type consistency: `LinkRef` (T1) is consumed by T2/T3/T6; `Resolution`/`VaultGraph` (T3) by T4/T6/T8; `WriteGate`/`MutateOpts`/`hardDelete` (T5) by T6/T7/T11; `Cond` (T8) reused by T9's `where`.
- Tool count trail: 21 → 24 (T4) → 25 (T7) → 27 (T8) → 30 (T11); surface test and smoke updated in those tasks.
- Deliberately not in this plan: embeddings (Phase 5), `.obsidian` access, app-only features.
