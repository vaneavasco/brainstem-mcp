# Changelog

All notable changes to brainstem-mcp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.3.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vaneavasco/brainstem-mcp/releases/tag/v0.1.0
