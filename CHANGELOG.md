# Changelog

All notable changes to brainstem-mcp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `vault_query` takes `format: "columns"`: a `columns` name list plus one `values` array per
  note, instead of repeating every field name on every row. Both formats now share a
  `MAX_QUERY_RESULT_CHARS` (60,000) budget on the row payload — a large result is cut to the
  longest prefix that fits, `truncated: true`, and a `hint` says how many rows fit of how many
  matched and how to get the rest (fewer `select` fields, `format: "columns"`, a lower `limit`,
  or `countOnly`). Found running a few hundred selected rows through a client that refused a
  result past 85,000 characters.
- `vault_query`'s `contains`/`startsWith` `where` conditions accept an array value (any of up to
  50 needles, validated up front); useful when checking a list field against many candidates
  would otherwise mean one query per candidate. `vault_search`'s `where` shares the same
  compiler, so it gets this too.
- `vault_query` gains a `nonEmpty` op: true when a field is present and not `null`, `""` or
  `[]`. `exists` alone cannot tell an empty list or string from a filled one.
- `vault_links` takes `countOnly`: keeps `total` (the per-kind counts it already reports) and
  returns an empty array for every link list — for a plain "does this note have backlinks"
  check that doesn't need the 9,000-character answer.
- `vault_search` adds a `hint` only on zero hits: it is a literal substring search, so a
  spelling variant, a shorter word, or `regex: true` may find what a plain miss did not.
  `vault_list`'s description now points at `vault_query { pathPrefix, countOnly: true }` as the
  cheaper way to count or size a folder instead of a deep listing.
- The in-memory index reconciles itself in the background: `FrontmatterIndex.reconcile()`
  re-reads any note whose size or modified time drifted from what the index has, drops entries
  for files that are gone, and adds ones that appeared — recovering from a watcher event the
  OS silently dropped (e.g. thousands of files rewritten in one minute by another tool, which
  can overflow an inotify queue without warning). Runs on a timer (`VAULT_RECONCILE_MS`,
  default 5 min, `0` disables it) and once more whenever the filesystem watcher itself reports
  an error; a tick is skipped while the previous one is still running. `brainstem_ping` now
  reports `index: { notes, builtAt, reconciledAt }` so an owner can see how fresh it is.
- `vault_batch_read` takes `sections` and `maxChars`, as `vault_read` does: the named sections
  of every note in one call. A note that lacks one of the sections still answers and lists it in
  `missingSections`, so a batch over notes of mixed shape never fails. Found by running
  multi-step questions through a fresh model: reading the summaries of a dozen long notes was
  the natural next step, and the only way to do it was one call per note.
- `vault_query` results carry a `hint` when `groupBy` ran over a list field: a note counts once
  under each of its values, so the group counts add up to more than `total`. Two test runs
  out of sixteen took the sum for the total, or suspected a bug.

- `brainstem_guide`: the connection instructions (server conventions plus the owner's
  `_brainstem/instructions.md`) as a tool. Measured on the claude.ai connector: the model
  never sees the MCP `instructions` field, so an owner's vault guide did not reach it at all.
  The descriptions of `vault_list`, `vault_search`, `vault_query` and `vault_read` point to it.
- `vault_read` takes `maxChars` (500–120,000): a look at a note of unknown size without paying
  for 120k characters. `vault_query` takes `countOnly`: `total` and group counts, no rows and
  no example paths (`limit`, `select`, `sort` ignored) — "how many per status" in a few hundred characters instead of thousands.
- `vault_read` takes `sections` (1–10 heading paths): the sections come back in
  document order, joined by a blank line, with `sectionRanges` — one call where a
  reader needed one per heading. Two paths that resolve to the same section return
  it once; an unknown path fails with `NOT_FOUND` and the list of headings, as
  `section` does. `section` and `sections` cannot be combined. Content lines come back
  byte-exact (line endings, trailing spaces); only the blank line between sections is
  synthetic, and a section nested in another requested one is returned once, labelled
  with the heading it resolved to.
- `vault_read` and `vault_daily_note_read` add a second content block with the note's
  `path`, its `hash` and, when the text was cut, how to read the rest. Clients that show
  the model only the content blocks (the claude.ai connector does) never saw the hash —
  so could not pass `expectedHash` — nor that a text was truncated. The first block is
  still the note's text and nothing else. `vault_daily_note_read` also returns `hash` and
  `text` in its structured result, which clients that show only `structuredContent` need
  to see the body at all.
- A truncated `vault_read` or `vault_batch_read` result carries a `hint` that says
  the text is incomplete and how to read the rest (`vault_outline`, then `section` /
  `sections`). The connection instructions now say the same in one line: a
  truncated text is read by section and never written back.
- `vault_append` and the `append` op of `vault_transaction` take `unique`: when the
  target section (or the file, without `heading`) already has a line linking to the
  same `[[target]]` — alias and anchor ignored — or an identical line when the text
  has no wikilink, nothing is written and the result says `skipped: true` instead of
  failing. The transaction `append` op also takes `heading` and `position`, like
  `vault_append` already did, so a note and every reciprocal bullet on the notes it
  links to can be written as one all-or-nothing unit, with retries and parallel
  writers unable to duplicate a bullet.
- `unique` on `vault_append` and the transaction `append` op now also accepts
  `"line"`: skip only when an identical trimmed line already exists, ignoring
  links entirely — for event-log bullets that legitimately link the same note
  more than once (e.g. "away, covered by [[Bob Jones]]" on two different
  dates), which `unique: true`'s same-target rule used to drop.
- `vault_links` takes `filter: { pathPrefix }` (vault-relative, case-sensitive):
  only backlinks, embeds and unlinked mentions whose source path starts with it
  are returned, applied before the result caps, so a note with hundreds of
  backlinks can still be checked one folder at a time. A new `total` object
  reports the outgoing/backlinks/embeds/unlinkedMentions counts after
  filtering and before capping.

### Fixed

- The content block of a truncated `vault_read` carried two truncation markers, the
  second with a wrong total (the already-clamped text was clamped again).
- Frontmatter parsing no longer emits a Node process warning for every note whose
  YAML holds an unquoted `{{placeholder}}` (template notes such as `created: {{date}}`);
  the server log stayed noisy at each index pass.
- A wikilink whose alias (or heading/block anchor) contains a lone `]` — e.g.
  `[[Alice Smith|[Draft] hello]]` — is now recognised, matching Obsidian, which
  resolves it to a link to "Alice Smith". Before, both the link index (so it
  never showed up as a resolved outgoing link or backlink) and `unique` on
  appends stopped parsing at that first `]`, so a `unique` append next to such
  a line could land a duplicate bullet.
- `unique: true` on `vault_append` and the transaction `append` op now
  canonicalises link targets before comparing them, so `[[people/Alice
  Smith]]`, `[[Alice Smith]]`, `[[Alice Smith.md]]` and `[[Alice Smith|Ali]]`
  are recognised as the same target instead of only an exact (lowercased)
  text match. `vault_append` and `vault_transaction` resolve each target
  through the vault graph relative to the note's own path, so two different
  notes that merely share a basename (e.g. `projects/Chart.md` and
  `archive/Chart.md`) are still told apart correctly.
- Wikilinks inside frontmatter values (`author: "[[Alice]]"`, list items) are now
  part of the link index, as they are in Obsidian: they count as backlinks in
  `vault_links`, in `vault_analytics_*` and in the graph, and `vault_move` rewrites
  them. Before, a note whose only link to another was a frontmatter property reported
  zero backlinks, and renaming the target left the property pointing at the old name.

- `vault_read` now includes the note text in `structuredContent` (`text`), not only
  in the content block. MCP clients that render `structuredContent` when it is
  present (Claude Code among them) showed only frontmatter and stats, so a model
  could not see a note's body to make exact-text edits; `vault_batch_read`
  already returned the body. With `section`, `text` is the section slice.
- Invalid YAML frontmatter is refused instead of buried. `vault_frontmatter_update`,
  `vault_batch_frontmatter_update`, the `frontmatter_update` transaction op and
  `vault_write` with `mergeFrontmatter=true` used to treat a note whose leading
  `---` block does not parse as body-only and then *prepended* a fresh block,
  leaving two frontmatter blocks in the file. They now fail with
  `INVALID_INPUT` naming the YAML error, and the file is left untouched.
  `vault_create_from_template` likewise refuses to create a note whose rendered
  frontmatter is not valid YAML (typically a var that was quoted twice), pointing
  at the `unresolved` placeholders. Notes read through `vault_read` still expose
  a broken block as body-only; the new `frontmatterError` field on the adapter's
  `Note` carries the reason.

### Added

- `./brainstem vault show` / `./brainstem vault set <path>` — switch the
  instance to another Obsidian vault without re-running setup. `set` validates
  the folder like `setup` does, rewrites only `VAULT_PATH` in `.env` (the owner
  secret is untouched, unlike `setup --force`), pre-creates `_brainstem/` in
  the new vault, copies `_brainstem/state.json` over from the previous vault so
  already-connected clients keep working, and restarts the containers if they
  were running. In quick-tunnel mode that restart hands out a new public URL,
  as any restart does.

### Changed

- `vault_batch_read` shares 60,000 characters between the note bodies (was 120,000). Frontmatter
  and metadata of twenty notes ride on top of the bodies, and clients refuse a tool result near
  100,000 characters outright: a full batch returned nothing at all. The cut is reported per note
  (`truncated`) with the usual hint.

- Positioning: the README intro, `llms.txt` and the GitHub description/topics
  now say what brainstem is *for* — your Obsidian vault as Claude's second brain
  (personal knowledge management, local-first, persistent memory) — before
  saying how it runs, and state plainly what it is not (no RAG/embeddings, no
  Obsidian plugin, no schema of its own, no methodology, single-user).
  `llms.txt` gains the user guide, the vault-graph spec and ADR 0006. No
  behaviour change.

## [0.3.1] — 2026-08-31

### Added

- `docs/user-guide.md` — a guide for non-technical users (managers, marketing):
  what the connector is for, how to connect from Claude, copy-paste prompts,
  the safety net, and honest limits (Claude-only, single-user). Linked from
  the README intro.

### Changed

- Ordering ties in `vault_tags`, `orphan_notes` and `hubs` now break
  case-insensitively everywhere (previously tags did, orphans/hubs did not);
  the tag list also stops rescanning every tag per call, so `vault_tags` on
  tag-heavy vaults is noticeably cheaper.
- Write-type tools (`vault_write`, `vault_append`, `vault_edit`,
  `vault_frontmatter_update`, canvas writes, templates, daily notes, link
  rewrites during `vault_move`) index the content they just wrote instead of
  re-reading it from disk — same results, fewer reads per mutation. A freshly
  written attachment or newly created canvas is also resolvable by `[[name]]`
  immediately, without waiting for the filesystem watcher.
- The `regex` operator's subject cap (2048) in `vault_query`/`vault_search`
  `where` conditions now counts characters (code points), not UTF-16 units —
  emoji-heavy values up to 2048 characters match instead of being rejected at
  half that length.

### Fixed

- `vault_create_from_template` reports `{{…}}` placeholders whose name the
  grammar cannot parse (space- or digit-led, e.g. `{{my var}}`, `{{2nd}}`) in
  `unresolved` instead of silently passing them through.
- "No heading … found" messages list an identical sibling heading path once
  instead of repeating it.
- Size-limit errors for sub-MiB limits no longer print a rounded "(0.0 MiB)".

## [0.3.0] — 2026-08-31

### Added

- Vault graph tools: `vault_links` (outgoing links, backlinks, embeds, unlinked
  mentions), `vault_tags` (tag list with counts, or the notes carrying one,
  nested-tag aware), `vault_outline` (headings, block ids, word/link/backlink
  counts). `vault_analytics_summary` gains `orphan_notes`, `ambiguous_links`
  and a `hubs` block; `broken_wikilinks` now comes from the graph.
- Safe concurrent writes: `expectedHash` on `vault_write`, `vault_edit`,
  `vault_append`, `vault_frontmatter_update`, `vault_batch_frontmatter_update`
  and single-file `vault_move`/`vault_delete` — a stale hash fails with a new
  `CONFLICT` error carrying the current hash instead of overwriting silently.
  All mutating calls for a path are serialized through a keyed write lock.
- `vault_transaction` — up to 20 `write`/`edit`/`append`/`frontmatter_update`/
  `move`/`delete` ops applied as one unit, with a pre-flight check, a journal
  under `_brainstem/tx/` for rollback, and `dryRun` support.
- `vault_query` — Bases-style structured queries (`where`, `tags`,
  `pathPrefix`, `select`, `sort`, `groupBy`, `limit`) over the in-memory index,
  no disk reads. `vault_recent` — notes by modification time.
- Search upgrade: `vault_search` gains `regex` (ripgrep-only), `tags`, `where`
  and `glob` filters, and now returns matches grouped per file.
- Section-level read/append: `vault_read { section }` returns one heading's
  text; `vault_append { heading, position }` writes inside a section instead
  of always at the end of the file.
- Canvas completion: `vault_canvas_update_node` and `vault_canvas_remove`;
  canvas writes accept `expectedHash`.
- `.base` files join the text file types (read/write/search/list as
  YAML — no query evaluation); the binary attachment allowlist now covers
  Obsidian's full accepted set (avif/bmp/svg images; mp3/m4a/ogg/wav/flac/webm/
  3gp audio; mp4/mov/mkv/ogv/webm video), with a new `MAX_BINARY_BYTES` env
  var (default 8 MiB) capping attachments separately from text writes.
- `vault_create_from_template` — renders `{{title}}`/`{{date}}`/`{{time}}`/
  `{{var}}` placeholders (plus `{{date:FMT}}`/`{{time:FMT}}`) into a new note,
  with `uniquePrefix` for Obsidian's Unique Note filename style.
- 30 vault tools total (up from 21). `DEFAULT_INSTRUCTIONS` rewritten for the
  larger surface: find via search/query/tags/links, read an outline and a
  section, edit with `expectedHash`, batch multi-note changes through
  `vault_transaction`.

### Changed

- `vault_move` now rewrites wikilinks, Markdown links and canvas file nodes
  that point at the moved note or folder by default (`updateLinks: false`
  restores the old behaviour); a conflict on one linking note is reported in
  `failed[]` without aborting the others.
- Write tools (`vault_write`, `vault_edit`, `vault_append`,
  `vault_frontmatter_update`) and reads (`vault_read`, `vault_batch_read`,
  `vault_outline`) return a `hash` so a subsequent edit can pass
  `expectedHash` at no extra cost.
- `vault_search` output adds `files[]` (matches grouped per file, preferred);
  the flat `matches[]` array is kept for compatibility.
- The `regex` operator in `vault_query`/`vault_search` `where` conditions now
  runs on a built-in linear-time matcher over a reduced syntax (literals, `.`,
  `[classes]`, `* + ? {m,n}`, `|`, `(...)`) instead of a JavaScript `RegExp`:
  patterns are a FULL match against the value (`^`/`$`, backreferences,
  lookarounds and named groups are rejected with `INVALID_INPUT`). Matching is
  linear in the value's length with hard caps on pattern size and complexity —
  the catastrophic-backtracking class that could previously hang the server
  now completes in milliseconds; a worst-case crafted pattern costs seconds
  over a large vault, never unbounded time. Regex `vault_search` over file *contents* still
  goes through ripgrep and is unchanged.
- Every error result now carries `structuredContent` with its `code` (and any
  details, e.g. a `CONFLICT`'s `currentHash`), not just `CONFLICT`.

## [0.2.0] — 2026-08-30

### Added

- Owner-editable instructions for Claude: `<vault>/_brainstem/instructions.md`
  (seeded at first start) is sent as the MCP server's `instructions` on every
  connection, on top of a fuller built-in guide to the vault tools.
- Prebuilt images on GHCR (`ghcr.io/vaneavasco/brainstem-mcp`,
  `…/brainstem-mcp-tunnel`; amd64 + arm64) for every commit on `main` and every
  release tag. `./brainstem up` pulls the image for the checked-out commit and
  only builds locally when nothing matches (`--build` forces a build,
  `--no-build` refuses one).
- `AGENTS.md` (+ `CLAUDE.md` importing it) for coding agents working on the
  repo, and `llms.txt` pointing LLMs at the right documents.

### Changed

- `./brainstem up` / `start` default to pulling the prebuilt image instead of
  building. `--no-build` keeps its meaning (never build) but now tries the
  registry first and only then reuses the last local build; new `--build`
  forces a local build.
- `./brainstem update` restarts with a plain `up`, so it runs the prebuilt image
  of the commit it just pulled instead of forcing a local rebuild.

## [0.1.0] — 2026-08-30

First public release. Beta: verified end-to-end on Linux with Claude Code and
claude.ai web; see *Status* in `README.md` for what is not yet verified.

### Added

- 21 vault tools over a local Obsidian vault (list, search with ripgrep, read,
  write, append, move, soft-delete to `.trash/`, frontmatter update, daily
  notes, canvas, analyze …), served over MCP Streamable HTTP with the
  official TypeScript SDK 2.0.
- Single-user OAuth 2.1 authorization server: Client ID Metadata Documents
  (host allowlist, SSRF-hardened fetch), PKCE, consent page gated by an
  owner secret with lockout, refresh-token rotation with family revocation,
  `/oauth/revoke`, Protected Resource Metadata, rate limiting.
- All server state as hashed JSON in the vault's reserved `_brainstem/`
  folder, so a synced vault carries the state to another machine.
- Cloudflare tunnel in two modes: `cloudflare` (named tunnel, stable URL,
  `TUNNEL_TOKEN`) and `quick` (trycloudflare.com URL, rotates on restart,
  written to `_brainstem/connection.md`); `none` for Claude Code only.
- Cross-platform launcher (`./brainstem`, `brainstem.cmd`) and TypeScript CLI:
  `start`, `setup`, `up`, `down`, `status`, `url`, `logs`, `secret`, `update`,
  `doctor`, `revoke-all`.
- Docker Compose deployment (app + tunnel), CI with unit/integration suites
  and a Docker smoke test, `npm run mcp:call` headless client for developers.

[0.3.1]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vaneavasco/brainstem-mcp/releases/tag/v0.1.0
