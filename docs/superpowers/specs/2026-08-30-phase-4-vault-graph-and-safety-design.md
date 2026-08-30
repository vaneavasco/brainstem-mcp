# brainstem-mcp Phase 4 — vault graph, safe concurrent writes, Obsidian coverage

**Date:** 2026-08-30 · **Owner:** Vanea · **Status:** draft for owner review (design agreed in conversation 2026-08-30 after the coverage research)
**Builds on:** `2026-08-28-single-user-local-tunnel-design.md` (rev. 2) — nothing there changes. Phase 0–3′ code is reused as is; this phase only adds to `src/vault/`, `src/storage/`, `src/tools/`.
**Research inputs:** Obsidian help + changelog 2025–2026 (links, properties, Bases, Canvas, search syntax, trash/rename behaviour); survey of Obsidian MCP servers and AI second-brain projects (MCPVault, StevenStavrakis/obsidian-mcp, aaronsb/obsidian-mcp-plugin, istefox/obsidian-mcp-connector, AgriciDaniel/claude-obsidian, Smart Connections, Khoj). Summarised in the conversation of 2026-08-30; the gap list below is what survived the "can the server do it on the raw vault folder, and can Claude not already do it with the existing tools" filter.

## 1. Goal

Make the server understand the vault as **Obsidian does** — a graph of notes joined by wikilinks and tags — and make writes from several Claude surfaces at once **safe**. After this phase Claude can: follow and list links in both directions, find orphans and hubs, rename a note without breaking the vault, work with tags as first-class objects, ask Bases-style questions of frontmatter, read a note's outline and a single section, edit without silently clobbering a concurrent edit, and touch every file type Obsidian itself accepts. All of it on the raw folder: **no Obsidian app, no plugin, no database, no embeddings.**

Coverage target: everything on the "achievable on the raw vault folder" list of the 2026-08-30 research, minus semantic search (Phase 5, optional).

## 2. Non-goals

- Semantic search / embeddings / RAG (Phase 5 if the owner wants it; needs a model in the image).
- Anything that needs the running Obsidian app: Dataview/DQL, live Bases view evaluation, Templater, command execution, active file, "open in Obsidian".
- Reading or writing `.obsidian/**` (schemas undocumented by Obsidian; stays blocked by the path policy).
- Scheduled jobs / digests (the server has no LLM; Claude's own scheduling can call our tools).
- Capture pipelines (web clipper, voice, Readwise, RSS) and publishing (Quartz) — the official Web Clipper already writes Markdown into the vault; Claude sees it.
- Emptying `.trash/` — Obsidian's folder, Obsidian's UI.
- Multi-vault, multi-user (ADR 0005 still binds).

## 3. Architecture

```
FrontmatterIndex (exists)  ──►  IndexEntry gains: links[], tags[], headings[], blockIds[], hash, wordCount
        │  version counter (++ on upsert/remove/rename)
        ▼
VaultGraph (new, src/vault/graph.ts)  — derived, rebuilt lazily when index.version changed:
   resolve(linkTarget) → path | ambiguous | unresolved      (Obsidian rules, §4.1)
   outgoing(path), backlinks(path), embedsOf(path), unlinkedMentions(path)
   tags(): Map<tag, paths>, orphans(), hubs(), unresolvedTargets()
        │
        ▼
Tools (src/tools/graph.ts, query.ts, tx.ts; edits to manage.ts, write.ts, read.ts, search.ts, canvas.ts)
        │
        ▼
LocalFSAdapter (exists) + WriteGate (new, src/storage/write-gate.ts): keyed async mutex + expectedHash check
```

One process, one vault (ADR 0005), so the graph lives in memory and is rebuilt from the index — never persisted. The only new on-disk artefact is the transaction journal under `_brainstem/tx/` (§4.6), which is deleted on success.

## 4. Components

### 4.1 Index extension — `src/vault/frontmatter-index.ts`, new `src/vault/note-parse.ts`

`IndexEntry` gains, parsed once per note in `FrontmatterIndex.fromNote`:

- `links: LinkRef[]` — every `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target…]]` (embed), and Markdown links `[text](relative/path.md)` / `[text](<path with spaces.md>)`. `LinkRef = { raw, target, heading?, block?, alias?, embed, line, kind: 'wiki'|'md' }`. Links inside fenced code blocks and inline code are ignored; `%% comments %%` are ignored.
- `tags: string[]` — frontmatter `tags` (list or string; the deprecated singular `tag` is *not* read — Obsidian 1.9 dropped it) plus inline `#tag` (Obsidian charset: letters, digits, `_-/`, Unicode; must contain a non-digit; not inside code). Stored as written; comparisons are case-insensitive. Nested tags are kept whole (`project/alpha`); `tags()` also aggregates parents.
- `headings: { level, text, line }[]`, `blockIds: { id, line }[]` (`^id` at line end).
- `hash: string` — `sha256hex(content)` of the file as read (frontmatter + body), the value clients echo back as `expectedHash` (§4.5).
- `wordCount: number` (body only).

Parsing is `note-parse.ts`, pure functions with table-driven tests copied from the Obsidian help pages (every link form listed there is a test case). The regexes replace the ad-hoc `WIKILINK`/`INLINE_TAG` in `analytics.ts`, which switches to the index data.

Memory: an entry grows from ~200 B to ~1–2 KB for a typical note; the existing `byteSize()` budget check stays and its ceiling rises to 64 MB (about 30k notes). Beyond that the index still builds; `vault_links` for hubs is capped (§4.2).

**Link resolution (Obsidian semantics, implemented in `VaultGraph.resolve`):** strip a trailing `.md`; if the target contains `/`, resolve as a vault path (case-insensitive); otherwise match by basename, case-insensitive. Exactly one match → resolved. Several → `ambiguous` with candidates (Obsidian would pick the "shortest path" but only for links it wrote itself; we report rather than guess). None → `unresolved`. Targets that are non-Markdown files (images, PDFs, `.canvas`, `.base`) resolve against the full file list, not only notes. Heading/block anchors are checked against `headings`/`blockIds` of the resolved note and reported as `anchorFound: boolean`.

### 4.2 Graph tools — new `src/tools/graph.ts`

- **`vault_links`** `{ path, include?: ('outgoing'|'backlinks'|'embeds'|'unlinkedMentions')[] }` (default all but `unlinkedMentions`). Returns `outgoing[] {target, resolvedPath|null, status: resolved|ambiguous|unresolved, anchorFound?, line}`, `backlinks[] {path, line, context}` (context = the source line, ≤ `MAX_MATCH_TEXT_CHARS`), `embeds[]`, and `unlinkedMentions[] {path, line, context}` — plain-text occurrences of the note's basename or any `aliases` value, whole-word, case-insensitive, in notes that do **not** already link to it (a ripgrep pass when available, JS fallback otherwise; capped at 100). Caps: 500 backlinks, 500 outgoing.
- **`vault_tags`** `{ tag?, prefix?, includeNested?: boolean }`. Without `tag`: every tag with `count` (notes) and `nested: true|false`, sorted by count then name, parents aggregated (`project` counts `project/alpha`). With `tag`: the notes carrying it (`includeNested` default true), each with where it came from (`frontmatter` | `inline`). Cap 500 notes.
- **`vault_outline`** `{ path }` → `frontmatterKeys[]`, `headings[]` (tree by level), `blockIds[]`, `wordCount`, `linkCount`, `backlinkCount`, `tags[]`, `hash`, `modifiedAt`. Reads from the index only.

Analytics gains categories `orphan_notes` (no incoming and no outgoing resolved links; excludes the daily-notes folder and `_brainstem`), `ambiguous_links`, and a `hubs` block in the summary (top 10 by backlink count). `broken_wikilinks` now comes from `VaultGraph.unresolvedTargets()`.

### 4.3 Rename with link rewriting — `vault_move` in `src/tools/manage.ts`

New input `updateLinks?: boolean` (default `true` when the source is a Markdown note or a folder containing notes). Behaviour, mirroring Obsidian's "Automatically update internal links":

1. Before moving, collect every link in the vault that resolves to the moved note(s) — from the graph, so this is O(backlinks), not O(vault).
2. Move the file(s) (existing adapter call, unchanged).
3. For each linking note, rewrite each affected link's **target text only**, preserving alias, heading/block anchor, embed marker and the wiki/markdown form. New target text follows the *style of the old one*: if the old link used a bare basename and the new basename is still unique in the vault, write the new bare basename; otherwise write the vault path without `.md`. Markdown links get the relative path re-computed. Notes that link *to themselves* after the move are handled the same way.
4. Each rewritten note is written through the WriteGate (§4.5) with its indexed hash as `expectedHash`; a conflict on one note is reported in `failed[]` and does not abort the others (the move itself is done).

Output adds `linksUpdated: { path, count }[]`, `failed: { path, error }[]`. `updateLinks: false` restores today's behaviour and the description no longer says links are never rewritten. Renaming a **folder** rewrites links to every note inside it (paths change; basenames don't — so bare-basename links are left alone unless they become ambiguous).

Not rewritten: links inside code fences/inline code (they are not links) and links whose target is `ambiguous` (reported, not guessed). **Ruling:** `.canvas` `file` nodes *are* rewritten — they store a vault path, Obsidian updates them on rename too, and we already parse the JSON.

### 4.4 Read and edit by section — `src/tools/read.ts`, `src/tools/write.ts`

- `vault_read` gains `section?: string` — a heading path `"Heading"` or `"H1 > H2"` (case-insensitive, `>`-separated). Returns only that heading's text up to the next heading of the same or higher level, plus `sectionRange: { startLine, endLine }`. Unknown heading → `NOT_FOUND` listing the headings that exist.
- `vault_append` gains `heading?: string` (same syntax) and `position?: 'end' | 'start'` (default `end`). Appends inside the section (before the next heading of equal/higher level), creating a trailing newline as today. Missing heading → `NOT_FOUND`; no heading param → today's behaviour (end of file).
- `vault_edit` is unchanged; the model reads a section with `vault_read {section}` and patches with exact text as before.

### 4.5 Safe concurrent writes — new `src/storage/write-gate.ts`, `VaultError('CONFLICT')`

Problem: claude.ai and Claude Code (or two chats) can both hold a stale copy and each `vault_write`/`vault_edit` wins silently. Two mechanisms:

1. **Keyed mutex.** Every mutating adapter call for a path runs inside `WriteGate.withLock(paths[], fn)` (sorted paths, acquired in order, so multi-path operations cannot deadlock). Single process, in-memory `Map<path, Promise>`; the gate is owned by the `VaultRuntime`. Reads are not locked.
2. **Optimistic concurrency.** `vault_write`, `vault_edit`, `vault_append`, `vault_frontmatter_update`, `vault_batch_frontmatter_update` (per item), and — for single files, not folders — `vault_move` and `vault_delete` accept `expectedHash?: string`. Inside the lock the gate reads the current file, computes `sha256hex(content)`, and if it differs throws `VaultError('CONFLICT', …)` whose message carries the **current** hash so the model can re-read and retry. Absent `expectedHash` → today's behaviour (last write wins). `vault_read`, `vault_batch_read`, `vault_outline` and `vault_write`'s result all return `hash`, so the round trip costs the model nothing extra. The default instructions (§7) tell the model to pass `expectedHash` when it edits a note it read earlier in the conversation.

`CONFLICT` is a new `VaultErrorCode`; `results.ts` maps it to an `isError` result with the current hash in `structuredContent` (`{ code: 'CONFLICT', path, currentHash }`).

### 4.6 Transactions — new `src/tools/tx.ts`, `src/storage/transaction.ts`

**`vault_transaction`** `{ ops: Op[] (1–20), dryRun? }` where `Op` is one of `write | edit | append | frontmatter_update | move | delete`, each with the same arguments as its tool plus `expectedHash?`. Semantics:

1. Lock every path touched (sorted, one acquisition).
2. **Pre-flight:** every `expectedHash` is checked; every `edit`'s patches are applied in memory (each `find` must still occur exactly once); every `move`'s destination must not exist; every `delete` needs `confirm: true`. Any failure → nothing is written, the result lists every op with `ok|error` and `dryRun` is implied.
3. **Journal:** the pre-images of every file to be modified/moved/deleted are copied to `_brainstem/tx/<txId>/` together with `manifest.json` (ops, timestamps) — `_brainstem` is already reserved; pre-images are plain copies written tmp+rename (no hard links: a later tmp+rename of the original must not alias the journal).
4. **Apply** ops in order through the adapter. On the first failure, **roll back**: restore pre-images from the journal in reverse order, undo moves, re-create deleted files, then return `rolledBack: true` with the failing op's error.
5. Delete the journal on success. A journal left behind (crash mid-transaction) is detected at boot: the app logs a warning naming the journal folder and the state its manifest reached, and leaves it in place for the owner; no automatic replay — the owner has the pre-images.

`dryRun: true` stops after step 2 and returns the unified diffs for `edit`/`write` ops. Cap: 20 ops, 20 files, `MAX_FILE_BYTES` each. Index updates happen once, after apply.

### 4.7 Query and recency — new `src/tools/query.ts`

- **`vault_query`** — Bases-style, index only, no disk reads: `{ where?: Cond[], tags?: { any?: string[], all?: string[], none?: string[] }, pathPrefix?, select?: string[], sort?: { field, order }[], limit?: (≤500), groupBy?: string }`. `Cond = { field, op: 'eq'|'neq'|'contains'|'startsWith'|'exists'|'gt'|'gte'|'lt'|'lte'|'in'|'regex', value? }` on frontmatter fields (dot paths) and the virtual fields `path`, `basename`, `folder`, `modifiedAt`, `size`, `wordCount`, `backlinks`, `outgoing`, `tags`. Comparisons follow Obsidian property types: numbers numerically, ISO dates/datetimes chronologically, strings case-insensitively, lists by membership. `regex` is a full match against the value (anchored at both ends) and length-capped (≤200 chars). It runs on the reduced-syntax, linear-time matcher in `src/vault/safe-regex.ts` — literals, `.`, `[classes]`, `* + ? {m} {m,} {m,n}` (counts ≤100), `|`, `(...)` — never a JavaScript `RegExp`, which backtracks: `^`/`$`, backreferences, lookarounds, named groups and inline flags are rejected with `INVALID_INPUT`. Returns `rows[] { path, ...selected }`, `total`, `truncated`, and with `groupBy` → `groups[] { key, count, paths(≤20) }`. This replaces most uses of `vault_search_frontmatter`, which stays for compatibility.
- **`vault_recent`** `{ since?: ISO, limit? (≤200), pathPrefix?, kind?: 'modified' }` — notes by `modifiedAt` desc from the index. (Created vs modified cannot be told apart on disk portably; `kind` exists so `created` can be added if a `created` property convention is adopted.)

### 4.8 Search upgrade — `src/tools/search.ts`, `LocalFSAdapter.search`

`vault_search` adds `regex?: boolean`, `tags?: string[]` (restrict to notes carrying any of them), `where?: Cond[]` (same as `vault_query`, pre-filters the candidate paths through the index), `glob?`, and returns `matches[]` grouped per file with `total`/`truncated`. Regex runs **only through ripgrep** (linear-time engine; `--regexp`, `-e`, no `--pcre2`); without ripgrep the tool returns `UNSUPPORTED` explaining that the Docker image always has it. Pattern ≤ 200 chars. Literal search is unchanged and remains the default.

Obsidian's own query mini-language (`tag:`, `path:`, `[prop:val]`) is **not** parsed — the structured parameters above are the equivalent and are unambiguous for a model.

### 4.9 Canvas completion — `src/tools/canvas.ts`, `src/vault/canvas.ts`

- `vault_canvas_add_node` accepts `type: 'text' | 'file' | 'link' | 'group'` (group needs `label?`), per JSON Canvas 1.0.
- **`vault_canvas_update_node`** `{ path, id, text?, x?, y?, width?, height?, color?, file?, url?, label? }` — partial update, unknown id → `NOT_FOUND`.
- **`vault_canvas_remove`** `{ path, nodeIds?: string[], edgeIds?: string[] }` — removing a node removes its edges; returns what was removed.
- All canvas writes go through the WriteGate and accept `expectedHash`.

### 4.10 File types and templates

- `.base` joins `TEXT_EXTENSIONS` (read/write/search/list as text; **no** evaluation — the syntax changed incompatibly twice in 2025, so we do not interpret it). The default instructions say what a `.base` file is and that Claude may edit its YAML.
- `BINARY_MIME_ALLOWLIST` extends to Obsidian's accepted formats: images `avif, bmp, svg` (in addition to png/jpeg/gif/webp), audio `mp3, m4a, ogg, wav, flac, webm, 3gp`, video `mp4, mov, mkv, ogv, webm`, plus `pdf` (existing). Extension ↔ MIME matching stays mandatory; `MAX_FILE_BYTES` stays 1 MiB for now (a config knob `MAX_BINARY_BYTES`, default 8 MiB, is added for attachments only).
- **`vault_create_from_template`** `{ templatePath, targetPath, vars?: Record<string,string>, uniquePrefix?: boolean, expectedHash? }` — renders Obsidian core-Templates placeholders `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FMT}}`, `{{time:FMT}}` (Moment tokens, vault timezone; the daily-notes renderer is reused and extended with `{{time}}`) plus `{{var}}` from `vars`; `uniquePrefix` prepends `YYYYMMDDHHmm ` to the basename like the Unique-note core plugin. Fails with `ALREADY_EXISTS` if the target exists.

### 4.11 Default instructions and owner instructions — `src/vault/instructions.ts`

`DEFAULT_INSTRUCTIONS` is rewritten for the larger surface (still < 2,000 chars): find → outline → read section → edit with `expectedHash`; use `vault_links`/`vault_tags`/`vault_query` instead of scanning; `vault_move` updates links; `vault_transaction` for multi-note changes; `.base`/`.canvas` are editable JSON/YAML. The registered-names guard test keeps it honest.

## 5. Data model changes

```ts
// src/storage/types.ts
type VaultErrorCode = … | 'CONFLICT';
interface Note { …; hash: string }                       // sha256hex(content)
interface WriteOpts { mergeFrontmatter?: boolean; expectedHash?: string }
interface MoveOpts { expectedHash?: string }               // move/softDelete gain an opts arg
interface StorageAdapter { …; hashOf(path): Promise<string> }  // read-through, used by WriteGate

// src/vault/frontmatter-index.ts
interface IndexEntry { …; links: LinkRef[]; tags: string[]; headings: Heading[]; blockIds: BlockId[]; hash: string; wordCount: number }
class FrontmatterIndex { …; readonly version: number }

// _brainstem/tx/<txId>/manifest.json
{ "id": "…", "startedAt": "ISO", "ops": [...], "preimages": [{ "path": "…", "file": "0001.md" }], "state": "applying" }
```

`state.json` (auth) is untouched. No new environment variables except `MAX_BINARY_BYTES`.

## 6. Security and safety

- Path policy unchanged: everything still goes through `normalizeVaultPath`; `_brainstem/`, `.obsidian/` and other dot-folders stay unreachable — including from `vault_query`/`vault_links` results (the index never contains them).
- The journal lives under `_brainstem/tx/`, so pre-images are as protected as `state.json` and invisible to every tool.
- Regex *content* search is ripgrep-only (no JS regex over untrusted patterns), pattern length capped, `--pcre2` never enabled; the in-memory `where` `regex` op runs on the linear-time NFA matcher in `src/vault/safe-regex.ts` for the same reason.
- SVG attachments are stored, never served or rendered by this server; Obsidian treats them as images. Documented in README.
- Link rewriting never touches code blocks and never guesses on ambiguity; every rewritten note goes through the hash check, so a note edited in Obsidian a second earlier is not overwritten — it is reported.
- Rate limits, auth, audit posture: unchanged.

## 7. Error handling

`CONFLICT` (new) carries the current hash; `NOT_FOUND` for unknown headings/canvas ids lists what exists; `UNSUPPORTED` for regex without ripgrep; `INVALID_INPUT` for malformed conditions, patterns over the cap, or `vars` that the template does not use (reported, not fatal). Transactions return a per-op result and a single `rolledBack` flag; a rollback failure is `IO` with the journal path in the message.

## 8. Testing

- `tests/vault/note-parse.test.ts` — table tests for every link/tag/heading/block form from the Obsidian help pages, code-fence and comment exclusions, CRLF.
- `tests/vault/graph.test.ts` — resolution (path, basename, ambiguity, non-md targets, anchors), backlinks, unlinked mentions, tags with nesting, orphans/hubs, incremental refresh via `touch`, `version` invalidation.
- `tests/tools/graph-tools.test.ts`, `query.test.ts`, `tx.test.ts`, `canvas` extensions, `template.test.ts` — through the real harness (`tests/tools/harness.ts`).
- `tests/tools/move-links.test.ts` — rename/move/folder-move × every link form × unique/ambiguous basename; canvas file nodes; conflict on one linking note.
- `tests/storage/write-gate.test.ts` — interleaved writes serialise; `expectedHash` mismatch → `CONFLICT` with current hash; sorted multi-path locking.
- `tests/storage/transaction.test.ts` — pre-flight failure writes nothing; mid-apply failure rolls back every file (byte-identical); journal removed on success, kept on rollback failure.
- `tests/tools/acceptance-scenario.test.ts` extended with the new flow (outline → section read → edit with hash → conflict → transaction → move with link update → query → tags).
- Performance guard: index build + graph derivation for a generated 5,000-note vault under 3 s on CI; `vault_query` under 50 ms.
- `scripts/docker-smoke.sh` calls `vault_links` and `vault_query` once.

## 9. Documentation and rollout

README: new "What Claude can do" table by capability, tool count updated (21 → 30 vault tools), sections on concurrency (`expectedHash`), transactions, link-updating renames, `.base`/attachments. `AGENTS.md` layout updated. CHANGELOG *Unreleased → 0.3.0*. ADR 0006: "vault graph in memory, derived from the index; optimistic concurrency with content hashes; transaction journal in `_brainstem/tx/`" (why not SQLite: same reasons as ADR 0005; why hashes not mtimes: sync tools rewrite mtimes). Default `instructions` rewritten. Release `v0.3.0` with images.

## 10. Plan impact and estimate

Detailed plan to follow in `docs/plans/2026-08-30-phase-4-vault-graph-and-safety.md` (writing-plans format), executed with subagent-driven development, `main` fast-forwarded per green task. Task outline (~3 days):

1. `note-parse.ts` + `IndexEntry` extension + `version` (0.5 d)
2. `VaultGraph` + `vault_links`/`vault_tags`/`vault_outline` + analytics categories (0.5 d)
3. `WriteGate` + `expectedHash` + `CONFLICT` across write tools + `hash` in reads (0.5 d)
4. `vault_move` link rewriting incl. canvas file nodes (0.5 d)
5. `vault_transaction` with journal/rollback (0.5 d)
6. `vault_query` + `vault_recent` + search upgrade (0.25 d)
7. Section read/append; canvas update/remove; `.base`; MIME; `vault_create_from_template` (0.25 d)
8. Instructions, README, AGENTS, CHANGELOG, ADR 0006, acceptance contract, smoke, release (0.25 d)

Out of this phase, recorded for Phase 5: embeddings/semantic search (`vault_similar`), and a deterministic "changes digest" job if scheduling ever matters.
