# brainstem-mcp

**Your Obsidian vault as Claude's second brain.** A self-hosted MCP connector that gives claude.ai, Claude mobile, Claude Desktop and Claude Code safe read/write access to your own notes: persistent, local-first memory that lives in your Markdown files, not in someone else's database.

## What it is

A single-user, self-hosted MCP server that turns your Obsidian vault into a personal knowledge base Claude can read and write — from claude.ai web, Claude mobile, Claude Desktop and Claude Code. Your notes stay plain Markdown files on your machine; Claude gets a memory that persists across conversations, and everything it writes shows up in Obsidian as a normal note you can open and edit. It runs entirely in Docker; a Cloudflare tunnel makes it reachable from those Claude surfaces without opening any ports yourself.

30 tools cover the vault the way Obsidian sees it — a knowledge graph of linked notes, not a folder of files: reading and writing notes, sections, frontmatter and attachments; the link/tag graph (backlinks, orphans, hubs); structured queries and recency; safe concurrent edits and multi-note transactions; canvases; templates; daily notes. See "What Claude can do" below.

What it is *not*, so you can compare it fairly:

- **Not a RAG or semantic-search layer.** No embeddings, no vector database; it searches text and structure (links, tags, frontmatter).
- **Not an Obsidian plugin.** Nothing to install inside Obsidian; it works on the vault folder, so it also runs while Obsidian is closed.
- **Not a memory system with its own schema.** No new format, no sidecar database: your vault, as it is.
- **Not a methodology.** PARA, Zettelkasten or no system at all — the conventions live in your vault and in `_brainstem/instructions.md` (see below).
- **Not multi-user.** One owner, one vault, Claude only.

Handing this to someone non-technical — a manager, a marketer, anyone who just wants their notes to work with Claude? Give them **[docs/user-guide.md](docs/user-guide.md)**: what it's for, how to connect, and copy-paste prompts.

## Status

**v0.5.0 — beta.** Built for the owner and technically comfortable colleagues who clone this repo; not (yet) a hosted product.

Verified end-to-end: Linux host · Claude Code · claude.ai web (all tools, via a live quick tunnel) · Docker smoke test in CI.
Implemented but not yet verified by a real run: Claude mobile app · `cloudflare` (token) tunnel mode · Windows and macOS launchers · reconnect after a tunnel restart.
Issues and pull requests are welcome — see `CHANGELOG.md` for what shipped and `SECURITY.md` for reporting vulnerabilities.

## Requirements

- Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux)
- Node.js 24.x
- git

## Quick start

```bash
git clone https://github.com/vaneavasco/brainstem-mcp.git
cd brainstem-mcp
./brainstem start
```

Windows: `.\brainstem start`

On Windows, replace `./brainstem` with `.\brainstem` in every command below.

`start` checks your prerequisites and tells you exactly what to install if something is missing. On first run it asks for your Obsidian vault folder and whether you have a Cloudflare tunnel token (see *Stable URL* below — say no to get a quick tunnel instead). Then it starts the stack and prints your connector URL.

Containers come from prebuilt images (`ghcr.io/vaneavasco/brainstem-mcp`, built by CI for the exact commit you checked out), so a first start takes seconds; if no image matches — offline, or local edits — it builds locally instead. `./brainstem start --build` forces a local build.

## Connect Claude

**claude.ai (web or mobile):** Settings → Connectors → *Add custom connector* → paste `<your URL>/mcp` → Connect → type the owner secret → Approve.

**Claude Code:**

```bash
claude mcp add --transport http brainstem <your URL>/mcp
```

then run `/mcp` and authenticate.

The owner secret lives in `.env`. Show it any time with:

```bash
./brainstem secret show
```

## Use it locally, without Docker or a tunnel

On your own machine, Claude Code and Claude Desktop can start the server themselves and talk to it over stdin/stdout — no Docker, no Cloudflare tunnel, no OAuth. The process runs as your own OS user, so it can do nothing to the vault that you couldn't already do yourself with a text editor; the same path policy, size limits and optimistic-concurrency checks protect it from the model either way.

`./brainstem setup --mode local` asks only for your vault folder (no owner secret, no Docker, no tunnel question) and prints the exact line to run:

```bash
claude mcp add brainstem -- /path/to/brainstem stdio
```

A second vault is a second entry with its own name: `claude mcp add brainstem-work -- /path/to/brainstem stdio --vault <path>`. `--vault <path>` overrides `VAULT_PATH` from `.env` if you have one. Claude Desktop will use an installable bundle for this instead — coming soon. The index builds in the background so the connection is never blocked on a large vault: tools that need it wait briefly and, if it's still building, say so (`brainstem_ping`'s `index.building`/`index.indexed`/`index.total`); `vault_read` and the daily-note/canvas reads work immediately regardless.

### Where stdio keeps its state

The stdio server splits what it keeps in two places:

- `<vault>/_brainstem/instructions.md` is vault content — the same file the HTTP server reads and seeds, travelling with the vault wherever it's synced (see "Teach Claude your vault's conventions" below).
- Everything that is *this process's own working state* — the `vault_transaction` journal today, a per-vault index cache later — lives in a **machine-local folder**, never inside the vault: `$XDG_STATE_HOME/brainstem/<hash>` or `~/.local/state/brainstem/<hash>` on Linux, `~/Library/Application Support/brainstem/<hash>` on macOS, `%LOCALAPPDATA%\brainstem\State\<hash>` on Windows — `<hash>` is the first 16 hex characters of the SHA-256 of the vault's real (symlink-resolved) path, so two spellings of the same vault share one folder. A vault may live in git or in a folder synced between machines (iCloud Drive, Dropbox, Syncthing), where an in-flight transaction journal or a machine-bound cache would be the wrong thing to sync, upload or merge — this keeps it out. Override the base directory with `BRAINSTEM_STATE_HOME=<absolute path>` in `.env` or the environment; `STATE_DIR` (test/dev-only, see `.env.example`) still overrides the journal's folder directly, same as before this split. Nothing here bends the vault's own `_brainstem/` reservation: every tool still refuses to list, read, write or search it.

**Several stdio sessions on one vault are normal** — every Claude Code session, and every Claude Desktop restart, starts its own. Each one registers itself at `<local folder>/instances/<pid>.json` and prunes any left behind by a pid that's no longer alive; when another is already running, the new one logs one line on stderr saying how many, and `brainstem_ping`'s `localPeers` field (stdio only, absent on the HTTP server) shows the live count at any moment. What actually protects a vault written by more than one process at once is unchanged: `expectedHash` turns a colliding write into a `CONFLICT` instead of a lost write, and each process keeps its own in-memory index fresh through its filesystem watcher and periodic reconcile. **One vault per server** is still the design — a Desktop install serves one vault, and a second vault in Claude Code is a second `claude mcp add` entry with its own name (above), not a second vault served by one process.

### Read-only mode

`./brainstem stdio --read-only` (or `VAULT_READ_ONLY=true` in `.env`, either way in) registers only the tools whose own annotations mark them `readOnlyHint: true` — reading, searching, listing, querying — so nothing that could change a note, a canvas or a file is even offered to the client; `tools/list` doesn't show the rest, and calling one fails as an unknown tool. It's the right default for a connection that should only ever be asked questions, and a safety net for a vault synced between people. `brainstem_ping`'s `readOnly` field and one extra sentence in the connection instructions say when it's on; `/health`'s `vault.readOnly` shows it for the HTTP server too. A read-only boot also writes nothing into the vault on its own (no seeded instructions template, no connection note): the OAuth token store is the one exception, since it isn't vault content.

## Commands

`./brainstem help <command>` prints the full options for any command below.

### Everyday

| Command | What it does | Example |
|---|---|---|
| `./brainstem start` | Check prerequisites, configure on first run, then start brainstem-mcp | `./brainstem start` |
| `./brainstem up` | Start brainstem-mcp (docker compose up) and wait until it is healthy | `./brainstem up` |
| `./brainstem down` | Stop brainstem-mcp | `./brainstem down` |
| `./brainstem status` | Show configuration, health and container status | `./brainstem status` |
| `./brainstem url` | Print the connector/public URL and check it is reachable | `./brainstem url` |
| `./brainstem logs` | Follow container logs | `./brainstem logs` |
| `./brainstem stdio` | Serve one vault over stdio — no Docker, no tunnel, no OAuth | `./brainstem stdio --vault ~/Documents/Vault` |

### Configuration

| Command | What it does | Example |
|---|---|---|
| `./brainstem setup` | Create or update `.env`: local (stdio) or Docker + tunnel with an owner secret | `./brainstem setup --vault ~/Documents/Vault` |
| `./brainstem secret` | Show or rotate the owner secret | `./brainstem secret show` |
| `./brainstem vault` | Show or switch the vault this instance works on | `./brainstem vault set ~/Documents/Work` |

### Maintenance

| Command | What it does | Example |
|---|---|---|
| `./brainstem update` | Pull the latest version from GitHub, reinstall dependencies and restart | `./brainstem update` |
| `./brainstem doctor` | Check prerequisites and configuration; explain how to fix any issues | `./brainstem doctor` |
| `./brainstem revoke-all` | Revoke all OAuth tokens — every connected client must reconnect | `./brainstem revoke-all` |

### After an update

A release can add tools or arguments. A connected client keeps the tool list it fetched earlier: the server lets it be cached for five minutes, and some clients keep it for their whole session. If Claude does not seem to know an argument the changelog mentions, reconnect the connector (Claude Code: `/mcp` → the connector → Reconnect; claude.ai: Settings → Connectors). Nothing breaks in the meantime: the arguments the client already knows keep working, and results may carry new fields without being rejected.

## Stable URL (recommended)

A quick tunnel's URL changes every time the stack restarts (see below), so for anything beyond trying it out, get a Cloudflare *named* tunnel — free, no domain purchase required if you use a Cloudflare-provided hostname:

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → create a tunnel, copy its token.
2. Add a **Public Hostname** on that tunnel pointing to `http://app:3000`.
3. Run:
   ```bash
   ./brainstem setup --tunnel-token <token> --public-url https://<your-hostname>
   ./brainstem up
   ```

The URL never changes again, and OAuth tokens survive restarts.

## Quick tunnel caveat

Without a tunnel token, `setup` configures a quick tunnel: a random `*.trycloudflare.com` URL assigned on every start. Whenever the stack restarts (reboot, `docker compose restart`, a crash), the URL changes, existing tokens stop working (401), and **the connector must be removed and re-added** in claude.ai / Claude Code — the URL is part of the connector's identity, this can't be avoided.

`_brainstem/connection.md`, a note written inside your vault, always shows the current URL and the exact reconnect steps — and because it's in the vault, it syncs to your phone too. The app notices the URL change and restarts itself automatically; you don't need to do anything on the server side.

## Teach Claude your vault's conventions

On first start the server seeds `<vault>/_brainstem/instructions.md`. Open it in Obsidian and write, in plain markdown, how Claude should work in *your* vault — where things live, which frontmatter keys you use, what it must never touch. The text is sent to Claude on every new connection (as the MCP server's `instructions`), on top of the built-in guidance; frontmatter and `<!-- HTML comments -->` in that note are not sent. Edits apply to the next connection, no restart needed; it is capped at 12,000 characters.

## What Claude can do

### Safe concurrent edits

Every read (`vault_read`, `vault_batch_read`, `vault_daily_note_read`, `vault_outline`) returns a content `hash`. Pass it back as `expectedHash` on a write (`vault_write`, `vault_edit`, `vault_append`, `vault_frontmatter_update`, or moving/deleting a single file): if the note changed since — another Claude session, or you editing it in Obsidian — the call fails with `CONFLICT` and the current hash instead of silently overwriting. To change several notes as one unit, `vault_transaction` (up to 20 ops) applies every op or rolls all of them back, using a journal under `_brainstem/tx/` that is removed once the transaction settles.

### Renames keep links working

`vault_move` rewrites every wikilink, Markdown link and canvas file node elsewhere in the vault that points at the moved note or folder, mirroring Obsidian's "Automatically update internal links". Links whose target is ambiguous are reported, never guessed; pass `updateLinks: false` to restore a plain move with no rewriting.

### Query your notes

`vault_query` runs Bases-style structured filters (`where`, `tags`, `pathPrefix`, `sort`, `groupBy`) over the in-memory index, with no disk reads; `where` conditions on `contains`/`startsWith` also take an array value ("any of" up to 50 needles), and `nonEmpty` catches a field that's present but empty. `eq`/`in` are link-aware: a frontmatter value written as a wikilink matches its plain name and its full target either way. `sum` (up to 10 field names) totals over *every* match, not just the rows a result can carry, into `sums`/`sumCounted` — per group too with `groupBy`; `groupPrefix` narrows which group keys come back. `format: "columns"` trades one repeated field name per row for a `columns` list plus one `values` array per note, and the whole result (rows or values, groups, column names, hints) stays within 48,000 characters, with `truncated` and a `hint` that says what was cut (and, for `pathPrefix`, when no note exists under it at all) so a wide result never overflows a client. `vault_recent` lists notes by modification time. `vault_tags` lists every tag with counts, or every note carrying one (nested tags included). `vault_links` returns a note's outgoing links, backlinks and embeds, or just `total` with `countOnly: true`; `filter: { pathPrefix }` keeps only backlinks/embeds/unlinked mentions whose source path starts with it (applied before the result caps), so a heavily-linked note can still be checked one folder at a time — `total` reports the filtered counts. `vault_list` returns `folders` (every file under each listed folder, at any depth) and orders `entries` shallowest first, when the listing is cut by the budget, or is a long deep one (deeper than one level, no glob, over 200 entries, with sub-folders); a glob returns the paths themselves, and any other listing that fits is unchanged.

### Sections

`vault_read { section: "Heading > Sub-heading" }` returns just that heading's text instead of the whole note, and `sections: ["Summary", "Decisions"]` returns several headings in one call, in document order. `vault_batch_read` takes the same `sections` (and `maxChars`) for up to 20 notes at once; a note that lacks a heading lists it in `missingSections` instead of failing the batch, and `frontmatter: false` leaves frontmatter out entirely (`frontmatterOmitted: true`) so bodies get that room instead. A path that does not exist gets up to 3 near-miss suggestions (`vault_read`'s message, or `vault_batch_read`'s `suggestions`) when an indexed path matches once a typographic apostrophe, an en/em dash, or letter case is normalised away. Every result that is a list is bounded at 48,000 characters as the client receives it: a batch (frontmatter included; a short note leaves its share to the long ones), a `vault_query` / `vault_recent` (rows and groups together), a listing, a note's links, the tags: some clients refuse a larger tool result outright, so a cut with `truncated` and a `hint` beats an answer that never arrives. `maxChars` cuts a read earlier, and `vault_query { countOnly: true }` answers "how many" without rows. Some clients (the claude.ai connector among them) never show the model the connection instructions, so the same text — server conventions plus your `_brainstem/instructions.md` — is also the tool `brainstem_guide`, which the entry tools' descriptions point to. A read that had to be cut at 120,000 characters says so (`truncated: true`) and carries a `hint`: list the headings with `vault_outline`, read by section, never write the cut text back. `vault_append { heading, position }` writes inside a section instead of at the end of the file, and `unique: true` makes it a no-op (reported as `skipped`) when the section already has a line linking to the same `[[target]]` — different wikilink forms of the same note (a full path, a bare name, a `.md` suffix, an alias) all count as one target — or `unique: "line"` to skip only an identical trimmed line, ignoring links entirely, for bullets that legitimately link the same note more than once. The `append` op of `vault_transaction` takes the same fields, so a note and the reciprocal bullets on the notes it links to go in as one unit. Wikilinks inside frontmatter values count as links (backlinks, graph, rename), as in Obsidian.

### Attachments and file types

`.base` and `.canvas` files are read and written as plain text (YAML/JSON), so Claude can edit their structure directly; `.canvas` also has dedicated tools (`vault_canvas_add_node`, `vault_canvas_update_node`, `vault_canvas_remove`, and more) for editing nodes and edges without hand-rolling JSON. Binary attachments cover Obsidian's full accepted set — images (png/jpeg/gif/webp/avif/bmp/svg), audio (mp3/m4a/ogg/wav/flac/webm/3gp), video (mp4/mov/mkv/ogv/webm) and PDF — capped by `MAX_BINARY_BYTES` in `.env` (default 8 MiB; text writes stay capped at 1 MiB).

### Templates

`vault_create_from_template` renders a template note into a new file, substituting `{{title}}`, `{{date}}`, `{{time}}` (and `{{date:FMT}}`/`{{time:FMT}}` with Moment-style tokens), plus any `{{var}}` placeholders from `vars`. `uniquePrefix: true` prepends a timestamp to the filename, like Obsidian's core Unique Note plugin.

## Vault sync notes

The HTTP server keeps all of its own state inside `<vault>/_brainstem/` (tokens, the connection note, instance info) so that whatever syncs your vault also carries that state to another machine. The stdio server is different, on purpose: its own working state (the transaction journal, later an index cache) lives outside the vault in a machine-local folder — see "Where stdio keeps its state" above — while `_brainstem/instructions.md` still travels with the vault either way.

- **Obsidian Sync:** enable *Sync all other types* in the sync settings — plain JSON files are not synced by default, and `_brainstem/state.json` needs to travel.
- **Syncthing / git / Dropbox:** nothing to configure; they sync everything already.
- Run brainstem-mcp on **one machine at a time**. Two instances writing to the same synced vault concurrently is unsupported (the app logs a warning if it detects another live instance, but doesn't prevent it).
- The in-memory index self-heals: a background sweep (`VAULT_RECONCILE_MS` in `.env`, default 5 minutes; `0` disables it, otherwise at least 10 seconds) re-reads any note whose size or modified time drifted from what the index has, and also runs whenever the filesystem watcher itself reports an error (never dropped: at most one pass per 30 seconds, with a trailing pass for a burst) — recovering from watcher events an OS-level queue silently dropped (e.g. thousands of files rewritten in one minute by another tool). A note is dropped from the index only after its absence is confirmed on disk, so a note written while the sweep runs is never lost. `./brainstem status`, `/health` (`vault.reconciledAt`) and `brainstem_ping` (`index.reconciledAt`) show when the index was last checked. `brainstem_ping` also shows the index's size beside its budget (`index.bytes`, `index.budgetBytes`, `index.overBudget`): the budget is a warning line (one log line when crossed, a warning in `./brainstem status`, `vault.indexOverBudget` in `/health`; nothing is evicted), and the process holds roughly twice `index.bytes` of heap for it — about 3.5 KB of index per long note. On stdio (see above), where the index builds in the background instead of blocking the connection, `brainstem_ping`'s `index.building`/`index.indexed`/`index.total` show how far that build has gotten.

## Security model

- The owner secret gates the consent page for every new client; five wrong attempts lock it for 15 minutes.
- OAuth tokens are stored only as SHA-256 hashes in `_brainstem/state.json`, so a synced copy of that file leaks nothing usable.
- Every new client goes through a consent screen that shows the redirect hostname before granting access — no client is trusted silently.
- Client discovery (Client ID Metadata Documents) is restricted to an allowlist (`claude.ai,claude.com` by default) and fetched with an SSRF-hardened client: no redirects, private/loopback addresses rejected, size and time capped.
- `_brainstem/` is a reserved folder: every tool (list, search, read, write) refuses to touch it, so it's invisible to Claude.

## Troubleshooting

- **401 / "needs authentication" right after a restart, in quick-tunnel mode:** expected — the tunnel URL changed. Read `_brainstem/connection.md` in your vault for the new URL and reconnect the connector.
- **"Docker is not running or not installed":** start Docker Desktop (or the Docker daemon on Linux) and rerun the command; `./brainstem doctor` explains exactly what's missing.
- **Locked out of the consent page:** five wrong owner-secret attempts lock it for 15 minutes; check the correct value with `./brainstem secret show`.
- **A client won't reconnect, or you rotated the secret:** `./brainstem revoke-all` forces every client to go through consent again.
- **Something looks wrong in general:** `./brainstem logs` (or `./brainstem logs tunnel` / `./brainstem logs app`) to see what the containers are doing.

## For developers

Working on the code with an AI coding agent? `AGENTS.md` is the project guide it reads (Cursor, Copilot, Codex, …); `CLAUDE.md` imports it for Claude Code.

The launcher (`./brainstem`, `brainstem.cmd`) is a thin wrapper: it checks Node/Docker, installs dependencies, then delegates to the TypeScript CLI.

```bash
npm install
npm test
npm run typecheck && npm run lint
npm run dev                        # run the server directly, without Docker
npm run brainstem -- <command>     # run the CLI without the launcher's checks
npm run docker:smoke               # end-to-end smoke test against the Docker image
npm run mcp:call -- --list         # headless OAuth + tool calls against a running instance
```

The launcher reinstalls dependencies only when `package-lock.json` is newer than
`node_modules/.package-lock.json`. It installs the runtime-only tree
(`npm ci --omit=dev`), *except* when it finds `node_modules/.bin/vitest` — the
mark of a developer checkout — in which case it runs a plain `npm ci` so your
devDependencies survive. Set `BRAINSTEM_SKIP_INSTALL=1` to skip the install step
altogether (the launcher tests do this, so a stale lockfile can never rewrite
`node_modules` mid-suite).

**Images.** `./brainstem up` resolves the checked-out commit to the tag CI published (`sha-<7>`), runs `docker compose pull`, and starts without building; a dirty working tree or a failed pull falls back to `docker compose up --build`, which tags the local build `dev`. `--build` skips the registry; `--no-build` never builds (pulls, else reuses the last local build). CI (`publish-images` in `.github/workflows/ci.yml`) pushes `ghcr.io/vaneavasco/brainstem-mcp` and `…/brainstem-mcp-tunnel` for every commit on `main` and every `v*` tag (multi-arch: amd64 + arm64).

See `docs/` for the spec, ADRs and implementation plans.

## License

[MIT](LICENSE)
