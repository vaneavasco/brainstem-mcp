# brainstem-mcp

## What it is

A single-user, self-hosted MCP server that gives Claude — claude.ai web, Claude mobile, Claude Desktop, Claude Code — read/write access to your own Obsidian vault. It runs entirely in Docker on your machine; a Cloudflare tunnel makes it reachable from those Claude surfaces without opening any ports yourself.

## Requirements

- Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux)
- Node.js 24.x
- git

## Install & run

```bash
git clone https://github.com/vaneavasco/brainstem-mcp.git
cd brainstem-mcp
npm install
npm run setup
npm run up
```

`npm run setup` creates `.env` and asks two things: the path to your Obsidian vault folder, and whether you have a Cloudflare tunnel token (see *Stable URL* below — say no to get a quick tunnel instead). It generates the owner secret for you. `npm run up` builds the image, starts the stack, waits for it to become healthy, and prints your connector URL.

## Connect Claude

**claude.ai (web or mobile):** Settings → Connectors → *Add custom connector* → paste `<your URL>/mcp` → Connect → type the owner secret → Approve.

**Claude Code:**

```bash
claude mcp add --transport http brainstem <your URL>/mcp
```

then run `/mcp` and authenticate.

The owner secret lives in `.env`. Show it any time with:

```bash
npm run brainstem -- secret show
```

## Stable URL (recommended)

A quick tunnel's URL changes every time the stack restarts (see below), so for anything beyond trying it out, get a Cloudflare *named* tunnel — free, no domain purchase required if you use a Cloudflare-provided hostname:

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → create a tunnel, copy its token.
2. Add a **Public Hostname** on that tunnel pointing to `http://app:3000`.
3. Run:
   ```bash
   npm run setup -- --tunnel-token <token> --public-url https://<your-hostname>
   npm run up
   ```

The URL never changes again, and OAuth tokens survive restarts.

## Quick tunnel caveat

Without a tunnel token, `setup` configures a quick tunnel: a random `*.trycloudflare.com` URL assigned on every start. Whenever the stack restarts (reboot, `docker compose restart`, a crash), the URL changes, existing tokens stop working (401), and **the connector must be removed and re-added** in claude.ai / Claude Code — the URL is part of the connector's identity, this can't be avoided.

`_brainstem/connection.md`, a note written inside your vault, always shows the current URL and the exact reconnect steps — and because it's in the vault, it syncs to your phone too. The app notices the URL change and restarts itself automatically; you don't need to do anything on the server side.

## Vault sync notes

The server keeps all of its own state inside `<vault>/_brainstem/` (tokens, the connection note, instance info) so that whatever syncs your vault also carries that state to another machine.

- **Obsidian Sync:** enable *Sync all other types* in the sync settings — plain JSON files are not synced by default, and `_brainstem/state.json` needs to travel.
- **Syncthing / git / Dropbox:** nothing to configure; they sync everything already.
- Run brainstem-mcp on **one machine at a time**. Two instances writing to the same synced vault concurrently is unsupported (the app logs a warning if it detects another live instance, but doesn't prevent it).

## Commands

| Command | What it does |
|---|---|
| `npm run setup [-- --vault <path> --tunnel-token <t> --public-url <u> --force --show-secret]` | Create or update `.env`: owner secret, vault path, tunnel mode |
| `npm run up [-- --no-build]` | Start the stack and wait for it to become healthy; print the connector URL |
| `npm run url` | Print the connector URL and check that it's reachable |
| `npm run status` | Show vault, tunnel, health and container status |
| `npm run down` | Stop the stack (state stays in the vault) |
| `npm run logs [-- <service>]` | Follow container logs (`app` or `tunnel`; omit for both) |
| `npm run revoke-all [-- --reset --yes]` | Revoke every OAuth token, forcing all clients to reconnect (`--reset` resets the auth state file instead — also clears registered clients, and is the recovery for a corrupt file) |
| `npm run brainstem -- secret show\|rotate` | Show, or generate a new, owner secret |

## Security model

- The owner secret gates the consent page for every new client; five wrong attempts lock it for 15 minutes.
- OAuth tokens are stored only as SHA-256 hashes in `_brainstem/state.json`, so a synced copy of that file leaks nothing usable.
- Every new client goes through a consent screen that shows the redirect hostname before granting access — no client is trusted silently.
- Client discovery (Client ID Metadata Documents) is restricted to an allowlist (`claude.ai,claude.com` by default) and fetched with an SSRF-hardened client: no redirects, private/loopback addresses rejected, size and time capped.
- `_brainstem/` is a reserved folder: every tool (list, search, read, write) refuses to touch it, so it's invisible to Claude.

## Troubleshooting

- **401 / "needs authentication" right after a restart, in quick-tunnel mode:** expected — the tunnel URL changed. Read `_brainstem/connection.md` in your vault for the new URL and reconnect the connector.
- **"Docker is not running or not installed":** start Docker Desktop (or the Docker daemon on Linux) and rerun the command.
- **Locked out of the consent page:** five wrong owner-secret attempts lock it for 15 minutes; check the correct value with `npm run brainstem -- secret show`.
- **A client won't reconnect, or you rotated the secret:** `npm run revoke-all` forces every client to go through consent again.
- **Something looks wrong in general:** `npm run logs` (or `npm run logs -- tunnel` / `npm run logs -- app`) to see what the containers are doing.
