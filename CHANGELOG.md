# Changelog

All notable changes to brainstem-mcp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] — 2026-09-21

### Added

- `vault_query` takes `format: "columns"`: a `columns` name list plus one `values` array per
  note, instead of repeating every field name on every row; the same rows in roughly 40% fewer
  characters. Found running a few hundred selected rows through a client that refused the
  result outright.
- `vault_query`'s `contains`/`startsWith` `where` conditions accept an array value (any of up to
  50 needles, validated up front); useful when checking a list field against many candidates
  would otherwise mean one query per candidate. `vault_search`'s `where` shares the same
  compiler, so it gets this too.
- `vault_query` gains a `nonEmpty` op: true when a field is present and not `null`, `""` or
  `[]`. `exists` alone cannot tell an empty list or string from a filled one.
- `vault_links` takes `countOnly`: keeps `total` (the per-kind counts it already reports) and
  returns an empty array for every link list — for a plain "does this note have backlinks"
  check that doesn't need the 9,000-character answer.
- `vault_search` adds a `hint` on zero hits, and only advice that is true for that call: the
  filter matched no note (so no text was searched), the scan stopped at its limit, the regular
  expression matched nothing, or, for a plain search, that it is a literal substring match.
- The in-memory index reconciles itself with the disk. An external job rewrote about 24,000
  files in a minute; the file watcher lost events and the index served stale frontmatter until a
  restart, with no sign of it. `FrontmatterIndex.reconcile()` compares a fresh listing (size and
  mtime: unchanged files are not read) with the index; what differs is re-read, what is new is
  added, and an entry is removed only after its absence is confirmed on disk, because a tool may
  write or move a note while the sweep runs. It runs every `VAULT_RECONCILE_MS` (default
  300000; `0` turns it off, otherwise at least 10000) and when the watcher reports an error. A
  watcher error is never dropped: during a pass it is answered by one more pass, within 30 s of
  the end of the last one by one trailing pass when the gap ends (a watcher that cannot watch reports once
  per folder). A failed pass is logged without its error text (it can carry an absolute path),
  and shutdown waits for the pass in flight. `brainstem_ping` (`index: { notes, builtAt, reconciledAt }`), `/health`
  (`vault.reconciledAt`) and `./brainstem status` show when the index was last checked. An idle
  pass over 37,000 notes takes about a second.
- Every result is bounded as the client receives it, at 48,000 characters (ADR 0007), because on
  a 37,000-note vault they were not: `vault_list` returned 283,000 characters, `vault_links` on
  a hub 161,000, `vault_tags` 146,000, a batch of twenty long notes 91,000. Nothing is estimated:
  each tool weighs its result with the lists empty and its longest hint in place (a path or a
  field name can be a thousand characters) and gives the lists what is left. `vault_list`,
  `vault_links` (its four lists share the room, short lists first), `vault_tags`,
  `vault_search_frontmatter` and `vault_analytics_findings` keep the longest prefix that fits,
  set `truncated`, and say how many of how many are shown and which narrower call to make.
- `vault_search` is bounded like the other list results: its hits travel twice (`files` groups
  what `matches` lists flat), so fifty long lines in long paths outgrew 48,000 characters. It
  keeps the longest run of hits whose two renderings fit together, and sets `truncated`.
- Arguments that are echoed back or compiled are capped where they are declared, so a caller
  cannot make the server answer with 200,000 characters by sending them (a `tag` was echoed
  whole; a 40,000-character `glob` ended in an internal error): a path 1,024 characters, a
  heading path, field name or tag 200, `select` 50 names, a search string or glob 1,000.
- `vault_query` and `vault_recent` bound the whole result, not only the rows: the result stays
  within 48,000 characters, rows (or `values`), `groups`, column names, hints and all (`select`
  takes at most 50 names of 200 characters). Groups get at most half when rows are wanted too (all of
  it with `countOnly`); their example paths are dropped before any group is, and when thousands
  of keys still do not fit the largest groups are kept. A cut is never silent: `truncated` is
  set and a `hint` says what was cut; the row hint counts against the rows asked for (`limit`),
  not against every match, and says so when the groups took part of the room. The number is
  measured: a client with a token limit on tool results took about 51,000 characters and refused
  55,100 and 59,800 (JSON costs more tokens per character than prose); another took 120,000.
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

- The server promised tool-list change notifications (`tools.listChanged: true`, the SDK's
  default) that a server built per request has no channel to send, and told clients the list
  could be cached for an hour. After a release that added tool arguments, a connector kept
  serving the previous list for more than three hours: readers could not see the new arguments,
  and a call that used one anyway was refused. The capability is now declared `false`, the
  cache hint is five minutes, and the server version changes with every release so a client
  that keys its cache on it sees the change. After an upgrade, reconnect the connector if the
  new arguments do not show up.
- The server went on reporting 0.3.1 through four pull requests that changed its tools: a
  release is a manual step and nothing noticed that it had not been made. The reported version
  now carries the commit the image was built from (`0.4.0+3c421e3` in `brainstem_ping` and
  `/health`), a test fails when package.json, the changelog and the README disagree, CI fails on
  a release tag that does not match package.json, and AGENTS.md says when and how to release.
- The index no longer keeps the text of the whole vault in memory. Every string it stored (a
  link target, a heading, a frontmatter value) was a piece cut out of the note it came from, and
  in V8 such a piece keeps the whole note alive. Measured on a 37,000-note vault: heap after
  indexing 940 MB → 254 MB, process memory 1.29 GB → 0.61 GB, build time unchanged. Index entries
  are now detached copies, and a link no longer stores its own source text (`raw`), only its
  position. A test builds an index over 90 MB of notes in a child process and fails if more than
  20 MiB stays held.
- The index size budget was never connected to anything: no log line, and a vault already over
  it at boot could not have been reported even if it were. It now warns once at boot or on the
  change that crosses it, `./brainstem status` prints a warning (`/health` carries only the
  yes/no, `vault.indexOverBudget`, because it is public), `brainstem_ping` shows `index.bytes`, `index.budgetBytes` and
  `index.overBudget`, and the budget is the measured one (256 MiB of serialized entries, about
  75,000 long notes; the earlier 64 MiB assumed 1–2 KB per note, real notes need 3.5 KB). It is
  a warning line, not a limit: nothing is evicted. The size is counted in bytes (it was UTF-16
  units, which halved it for a vault not written in Latin script), and a budget that is not a
  finite number is refused.
- A note whose frontmatter refers to itself (a YAML alias cycle, `a: &x {b: *x}`) stopped the
  server from starting. Such frontmatter is now refused where frontmatter is parsed, like any
  other invalid block: the note reads as body-only with the reason in `frontmatterError`.
- A query on a field name every object inherits (`constructor`, `toString`) matched every note.
  Only what the frontmatter itself holds is a field, in `vault_query`, `vault_search`'s `where`,
  `vault_search_frontmatter` and the required-frontmatter check. A `__proto__` key in
  frontmatter is kept as an ordinary key, `vault_query` `select` returns it as a column, and
  setting it through `vault_frontmatter_update`, the batch form or a transaction is refused
  instead of reporting success while dropping it.
- YAML aliases could make a 1 MB note cost 116 MB of memory (one anchor used 99 times, written
  out in full by every copy and every result); 45 such notes stopped the server from starting.
  Frontmatter whose written-out size passes what a file may hold (1 MiB) is refused where it is
  parsed; the note reads as body-only with the reason.
- `vault_read`, `vault_daily_note_read` and `vault_frontmatter_update` returned a note's
  frontmatter whatever its size (630,000 characters measured). A block over 24,000 characters
  is left out and flagged (`frontmatterOmitted`, with a `hint` naming the narrower call).
- A YAML `!!set` or `!!omap` value read as `{}` everywhere, and a set that contained itself got
  past the cycle check. A set reads as a list, an ordered map as a mapping; a frontmatter update
  writes them back as such. A tagged timestamp reads as its ISO text and tagged binary as base64.
- `vault_outline` listed a note's frontmatter key names, tags and block ids without a bound (a
  million characters for a note with 9,000 keys). Each list has a budget; `frontmatterKeyCount`
  says how many keys there are, `truncated` and `hint` say what was left out. Headings stay
  whole: they are what an outline is for.
- `vault_read` and `vault_batch_read` say why a frontmatter block could not be used
  (`frontmatterError`: invalid YAML, a cycle, too large) instead of only showing `{}`.
- Tool results may grow without breaking anyone. Output schemas were closed
  (`additionalProperties: false`), and clients cache the tool list: the first result that
  carried a field added after the client's copy was rejected whole with "data must NOT have
  additional properties". Every output schema is now open at every level, and a test walks all of
  them. **Upgrading to this release:** a client that still holds the previous release's tool list
  rejects the results that carry a new field by default: `brainstem_ping` (always), a
  `vault_search` with zero hits, and a `vault_query` grouped by a list field or cut by the
  character budget. It does not see new arguments either. Reconnect the connector after the
  upgrade (that refreshes the list at once); otherwise the list is cacheable for an hour. See
  ADR 0007.
- Tool arguments nobody asked for are now an error instead of being ignored. A misspelled key
  used to be dropped without a word: `vault_frontmatter_update { updates: … }` answered "ok" and
  changed nothing, and `expected_hash` (for `expectedHash`) silently switched the concurrency
  check off for that write. Every tool input is strict, and so are the nested `where`
  conditions, sort keys, tags filters, edit patches, transaction ops, batch items and the
  `vault_links` filter; the error names the unknown key. The one exception is deliberate: a
  canvas node, edge or patch may carry properties the server does not know (JSON Canvas is
  extensible), and they are written through.
- A `vault_search` narrowed by `tags` / `where` / `glob` took its candidates from a presented
  query result. With the new character budget on query rows, a few hundred candidates with long
  paths were cut and matches were lost without a sign. Candidates now come from the complete
  match set (`matchEntries`), which has no presentation limits.
- A condition on a field the note does not have compared against the text "undefined":
  `contains "und"`, `eq "undefined"`, `in ["undefined"]` and a matching `regex` all found every
  note without the field. A missing field now contains nothing, equals nothing and matches no
  pattern (`neq` stays the complement; `exists: false` finds the notes without it), and a null
  field equals `null`, not the text "null". An empty
  `contains` / `startsWith` needle, alone or in a list, is refused: it matched every note, and
  `exists` / `nonEmpty` are the operators for presence.
- `vault_batch_read` resolved `sections` against the body without the frontmatter, so a note
  whose body opens with a horizontal rule lost its headings. It now resolves them against the
  whole note, as `vault_read` does.
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

- The owner's `_brainstem/instructions.md` may be up to 12,000 characters (was 8,000) before it is cut with a marker: a guide for a large, structured vault (folders, queryable fields, reading recipes) did not fit, and it is read once per conversation through `brainstem_guide`.

- `vault_batch_read` bounds what the client receives, at 48,000 characters (it was 120,000 of
  bodies alone, which a client refused outright: a full batch returned nothing). The result is
  weighed without any body text first: paths, hashes, `missing`, `failed`, `missingSections`,
  hints and frontmatter. Frontmatter gets at most half of the room (on a real vault the
  frontmatter of twenty long notes weighed as much as their bodies); beyond that the largest
  blocks are left out and flagged (`frontmatterOmitted`, with a hint that names `vault_query
  select`). The bodies share exactly what is left, in serialized characters, each cut at the
  longest prefix that fits (a body that opens with line breaks, quotes or control characters is
  denser at the start than on average, so a ratio is not enough); a short note leaves its unused
  share to the long ones. A heading path may be at most 200 characters, and a batch whose paths
  and section names alone would exceed the limit is refused with a clear error (one bad path
  never fails a batch). With `maxChars`, a note costs only what it may return, so capped notes
  strand no room. `sections` is the intended call for long notes.
- Positioning: the README intro, `llms.txt` and the GitHub description/topics
  now say what brainstem is *for* — your Obsidian vault as Claude's second brain
  (personal knowledge management, local-first, persistent memory) — before
  saying how it runs, and state plainly what it is not (no RAG/embeddings, no
  Obsidian plugin, no schema of its own, no methodology, single-user).
  `llms.txt` gains the user guide, the vault-graph spec and ADR 0006. No
  behaviour change.

### Added

- `vault_query` takes `sum` (1–10 field names): exact totals over *every* match, not only the
  rows a result can carry, in a new `sums` (and `sumCounted`, so a reader can tell "0" from "no
  data" — only finite numbers count, not a numeric string or a boolean). With `groupBy`, each
  group also gets its own `sums`/`sumCounted`, over just its own matches. Sixteen fresh models
  answering real multi-step questions kept adding up a partial `rows` array by hand and getting
  it wrong; the truncation hint now names `sum` (and `countOnly` + `groupBy` for counts) as the
  way to get an exact number instead.
- `vault_query` takes `groupPrefix`: with `groupBy`, keep only group keys that start with it
  (e.g. `groupBy: "tags", groupPrefix: "topic/"`). Refused without `groupBy`.
- `vault_query` adds a `hint` when a `pathPrefix` matches nothing because no note exists under it
  at all (as against notes existing there but none matching `where`/`tags`), so a reader is not
  left to double-check with a separate listing.
- `vault_list` gains `folders` (`{ path, files }`: every note and attachment under each listed folder, at any depth, counted from the index whatever depth or glob was asked)
  and orders `entries` shallowest first — but only when the listing would otherwise be truncated.
  A deep listing used to return the first ~2,000 paths in on-disk order, i.e. the contents of
  whichever big folder came first alphabetically, and the reader learned nothing about the shape
  of the rest; eight of sixteen fresh models paid 25,000–48,000 characters for exactly that. An
  untruncated listing is unchanged: no `folders`, same order as before. One more case takes
  the same form: a listing deeper than one level, without a glob, that holds more than 200
  entries. It fits the budget (45,000 characters for a folder of 600 pages) and is still not
  an answer to "what is in here"; a glob asks for the paths themselves.
- `vault_batch_read` says how many missing paths had a suggestion that did not fit
  (`suggestionsOmitted`); a `sum` that overflows only inside a group is named in the hint, and
  an intermediate overflow no longer hides a finite total (the total is plain addition unless
  that overflowed). The shape form applies only where the listing holds sub-folders.
- `vault_batch_read` takes `frontmatter: false`: every note's `frontmatter` comes back `{}`
  (`frontmatterOmitted: true`) and the room it would have used goes to bodies instead — readers
  who only needed note text were losing several bodies per batch to long frontmatter blocks
  (a list of ids, most often).
- `vault_read`'s `NOT_FOUND` gains up to 3 `Did you mean: "…"?` suggestions, and
  `vault_batch_read` gains a `suggestions` entry per missing path that has one, when a requested
  path's folded form (Unicode NFKC; typographic quotes/apostrophes, en/em dashes and the
  non-breaking hyphen to their ASCII equivalents; repeated/non-breaking spaces to one; lower-
  cased) matches an indexed path exactly, or has the same folded file name in another folder. Cheap and
  predictable — no fuzzy distance matching — because it runs on every miss. A reader who typed a
  straight apostrophe where the file name has a typographic one used to be told only "does not
  exist".

### Fixed

- `vault_query`'s `eq`/`in` (and `vault_search_frontmatter`'s `equals`) are now link-aware: a
  frontmatter value written as a wikilink (`"[[Alpha Person]]"`, `"[[people/Alpha Person]]"`,
  with an alias or a heading) is found by the plain name (`"Alpha Person"`) and by the full
  target (`"people/Alpha Person"`), for a scalar field and for a list element. A reader who asked
  for `owner in ["Alpha Person"]` used to get zero rows and no explanation because the field held
  `"[[Alpha Person]]"`. `contains`/`startsWith` are unchanged (still plain substring/prefix).

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

[0.4.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vaneavasco/brainstem-mcp/releases/tag/v0.1.0
