# brainstem-mcp

## What it is

A single-user, self-hosted MCP server that gives Claude — claude.ai web, Claude mobile, Claude Desktop, Claude Code — read/write access to your own Obsidian vault. It runs entirely in Docker on your machine; a Cloudflare tunnel makes it reachable from those Claude surfaces without opening any ports yourself.

30 tools cover the vault the way Obsidian sees it: reading and writing notes, sections, frontmatter and attachments; the link/tag graph (backlinks, orphans, hubs); structured queries and recency; safe concurrent edits and multi-note transactions; canvases; templates; daily notes. See "What Claude can do" below.

Handing this to someone non-technical — a manager, a marketer, anyone who just wants their notes to work with Claude? Give them **[docs/user-guide.md](docs/user-guide.md)**: what it's for, how to connect, and copy-paste prompts.

## Status

**v0.3.0 — beta.** Built for the owner and technically comfortable colleagues who clone this repo; not (yet) a hosted product.

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

### Configuration

| Command | What it does | Example |
|---|---|---|
| `./brainstem setup` | Create or update `.env` (owner secret, vault path, tunnel mode) | `./brainstem setup --vault ~/Documents/Vault` |
| `./brainstem secret` | Show or rotate the owner secret | `./brainstem secret show` |

### Maintenance

| Command | What it does | Example |
|---|---|---|
| `./brainstem update` | Pull the latest version from GitHub, reinstall dependencies and restart | `./brainstem update` |
| `./brainstem doctor` | Check prerequisites and configuration; explain how to fix any issues | `./brainstem doctor` |
| `./brainstem revoke-all` | Revoke all OAuth tokens — every connected client must reconnect | `./brainstem revoke-all` |

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

On first start the server seeds `<vault>/_brainstem/instructions.md`. Open it in Obsidian and write, in plain markdown, how Claude should work in *your* vault — where things live, which frontmatter keys you use, what it must never touch. The text is sent to Claude on every new connection (as the MCP server's `instructions`), on top of the built-in guidance; frontmatter and `<!-- HTML comments -->` in that note are not sent. Edits apply to the next connection, no restart needed; it is capped at 8,000 characters.

## What Claude can do

### Safe concurrent edits

Every read (`vault_read`, `vault_batch_read`, `vault_outline`) returns a content `hash`. Pass it back as `expectedHash` on a write (`vault_write`, `vault_edit`, `vault_append`, `vault_frontmatter_update`, or moving/deleting a single file): if the note changed since — another Claude session, or you editing it in Obsidian — the call fails with `CONFLICT` and the current hash instead of silently overwriting. To change several notes as one unit, `vault_transaction` (up to 20 ops) applies every op or rolls all of them back, using a journal under `_brainstem/tx/` that is removed once the transaction settles.

### Renames keep links working

`vault_move` rewrites every wikilink, Markdown link and canvas file node elsewhere in the vault that points at the moved note or folder, mirroring Obsidian's "Automatically update internal links". Links whose target is ambiguous are reported, never guessed; pass `updateLinks: false` to restore a plain move with no rewriting.

### Query your notes

`vault_query` runs Bases-style structured filters (`where`, `tags`, `pathPrefix`, `sort`, `groupBy`) over the in-memory index, with no disk reads. `vault_recent` lists notes by modification time. `vault_tags` lists every tag with counts, or every note carrying one (nested tags included). `vault_links` returns a note's outgoing links, backlinks and embeds.

### Sections

`vault_read { section: "Heading > Sub-heading" }` returns just that heading's text instead of the whole note; `vault_append { heading, position }` writes inside a section instead of at the end of the file.

### Attachments and file types

`.base` and `.canvas` files are read and written as plain text (YAML/JSON), so Claude can edit their structure directly; `.canvas` also has dedicated tools (`vault_canvas_add_node`, `vault_canvas_update_node`, `vault_canvas_remove`, and more) for editing nodes and edges without hand-rolling JSON. Binary attachments cover Obsidian's full accepted set — images (png/jpeg/gif/webp/avif/bmp/svg), audio (mp3/m4a/ogg/wav/flac/webm/3gp), video (mp4/mov/mkv/ogv/webm) and PDF — capped by `MAX_BINARY_BYTES` in `.env` (default 8 MiB; text writes stay capped at 1 MiB).

### Templates

`vault_create_from_template` renders a template note into a new file, substituting `{{title}}`, `{{date}}`, `{{time}}` (and `{{date:FMT}}`/`{{time:FMT}}` with Moment-style tokens), plus any `{{var}}` placeholders from `vars`. `uniquePrefix: true` prepends a timestamp to the filename, like Obsidian's core Unique Note plugin.

## Vault sync notes

The server keeps all of its own state inside `<vault>/_brainstem/` (tokens, the connection note, instance info) so that whatever syncs your vault also carries that state to another machine.

- **Obsidian Sync:** enable *Sync all other types* in the sync settings — plain JSON files are not synced by default, and `_brainstem/state.json` needs to travel.
- **Syncthing / git / Dropbox:** nothing to configure; they sync everything already.
- Run brainstem-mcp on **one machine at a time**. Two instances writing to the same synced vault concurrently is unsupported (the app logs a warning if it detects another live instance, but doesn't prevent it).

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
