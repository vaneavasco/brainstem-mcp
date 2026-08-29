# brainstem-mcp v2 — single-user, self-hosted, Docker + Cloudflare quick tunnel

**Date:** 2026-08-28 (rev. 2, same day: tunnel modes + state-in-vault) · **Owner:** Vanea · **Status:** approved by owner in conversation 2026-08-28
**Supersedes:** `docs/implementation-plan.md` §1 (product), §7 (auth), Phase 2–4 of §9. Phase 0–1 code is unchanged and fully reused.

## 1. Goal

One person (the owner) uses Claude — claude.ai web, Claude mobile, Claude Desktop, Claude Code — to read and write their **existing Obsidian vault**, which lives on their own machine. The server runs entirely in Docker on that machine; claude.ai reaches it through a **Cloudflare quick tunnel**. Installation and configuration must be trivial on Linux and Windows (macOS incidentally): `git clone`, `npm install`, `npm run setup`, `npm run up`.

Decisions taken 2026-08-28 (owner): single user only; owner authenticates with a generated secret kept in `.env` (no Google); **two tunnel modes** — a Cloudflare *named* tunnel when the owner has a `TUNNEL_TOKEN` (stable URL, recommended), otherwise a *quick* tunnel (random `*.trycloudflare.com` hostname per start, for trying it out); the vault is the real Obsidian folder, bind-mounted; **all server state lives inside the vault** (`_brainstem/`, a reserved folder) so a synced vault carries the state to any other machine; everything that runs, runs in Docker; the CLI is TypeScript (cross-platform), not bash, and not a web UI.

## 2. Non-goals (moved to "Deferred" in the plan)

Multi-tenancy, tenant isolation suites, per-tenant rate limits, audit table, `/account` page · Google as identity provider (Plane B), encrypted refresh-token storage, re-auth handling · Google Drive adapter · Postgres, SQLite (a SQLite file must never live in a synced folder — WAL/SHM sidecars and mid-transaction copies corrupt it; if a large machine-local cache ever needs SQLite it goes outside the vault) · Dynamic Client Registration · Heroku · Tailscale Funnel / ngrok as alternative exposure modes (a third `TUNNEL_MODE` would be additive).

The code keeps the seams that make these additions instead of rewrites: `StorageAdapter`, `RuntimeResolver(ctx)`, a `TokenStore` interface, and an AS whose only user-specific piece is `OwnerAuth`.

## 3. Architecture

```
 phone / claude.ai ──HTTPS──▶ Cloudflare edge ──tunnel (named | quick)──▶ [tunnel] ──http──▶ [app :3000]
 Claude Code ────────────────────────────────────────────────────────────────────────▶ (same PUBLIC_URL)
                                                                                         │
            /vault  (bind mount = your Obsidian vault; `_brainstem/` = reserved state folder)◀┘
 host: npm run setup | up | url | status | down | logs | revoke-all   (TypeScript CLI drives docker compose, writes .env)
```

Docker Compose services: `app` (Node 24 image from Phase 1, unchanged base) and `tunnel` (profile `tunnel`; our own small image = `cloudflared` binary + a TypeScript supervisor, see 4.9). **No Docker volumes**: the only persistent state is `<vault>/_brainstem/` on the bind mount. **Postgres is removed.**

Request path for MCP: `POST /mcp` → `requireBearerAuth` (SDK) → `createMcpHandler` (Phase 0) → `createVaultServer(ctx)` → `resolveRuntime(ctx)` returns the single boot-time `VaultRuntime` after checking `authInfo.extra.userId === 'owner'`.

## 4. Components

### 4.1 Resource server — `src/auth/rs/`
- `verifier.ts`: `OAuthTokenVerifier.verifyAccessToken(token)` → SHA-256 → `TokenStore.getToken(hash)`; reject if missing, `kind !== 'access'`, revoked, expired, or `resource !== config.mcpUrl.href`. Returns `AuthInfo { token, clientId, scopes: ['vault'], expiresAt, resource, extra: { userId: 'owner', clientName } }`.
- PRM via `mcpAuthMetadataRouter` at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`: `resource = mcpUrl`, `authorization_servers = [publicUrl]`, `scopes_supported = ['vault']`, `bearer_methods_supported = ['header']`.
- 401 challenge: `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp", scope="vault"` (SDK helper with `resourceMetadataUrl` + `requiredScopes`). Never a 200 with an auth error, never an auth failure as a tool error.

### 4.2 Authorization server — `src/auth/as/`
- `metadata.ts` — `GET /.well-known/oauth-authorization-server`, all URLs from `PUBLIC_URL`: `issuer`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `scopes_supported: ['vault']`, `response_types_supported: ['code']`, `grant_types_supported: ['authorization_code','refresh_token']`, `code_challenge_methods_supported: ['S256']`, `token_endpoint_auth_methods_supported: ['none']`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`. **No `registration_endpoint`** (DCR not offered; Claude picks CIMD because both flags are present).
- `cimd.ts` — resolves `client_id` (must be an HTTPS URL with an explicit path, no credentials/fragment/dot-segments; port significant). Host must be in `CIMD_ALLOWED_HOSTS` (default `claude.ai,claude.com`); otherwise `invalid_client` and a log line naming the host so the owner can extend the list. Fetch: 5 s timeout, 5 KB streamed cap, `Accept: application/json`, accept `application/json` / `application/*+json`, **no redirects**, DNS resolved once and every RFC 6890 special-use address rejected, connection pinned to the resolved IP with TLS verified against the hostname. Validate with Zod: `client_id === url`, `client_name` string, `redirect_uris` non-empty array of valid URLs, `token_endpoint_auth_method` absent or `none`. Cache in `TokenStore.clients` with shared-cache semantics (`s-maxage` > `max-age` > `Expires`; `no-store`/`private` ⇒ not cached; default 1 h; negative cache 5 min).
- `authorize.ts` — `GET /oauth/authorize`: require `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`; `resource` must equal `mcpUrl` (absent ⇒ default + warn); `scope` absent or `⊆ {vault}`. `redirect_uri` must match a registered entry exactly, except loopback (`http://localhost/…`, `http://127.0.0.1/…`, `http://[::1]/…`) where the port is ignored. Invalid `client_id`/`redirect_uri` ⇒ HTML error page (never redirect); other errors ⇒ redirect with `error`, `state`, `iss`. Success ⇒ `pending` row `{ id, clientId, clientName, redirectUri, codeChallenge, resource, scope, state, nonce, expiresAt: +10 min }` and the consent page.
- `consent.ts` — server-rendered HTML (no JS needed, strict CSP, `Cache-Control: no-store`): client name, redirect **hostname** (plus a warning when every registered redirect is loopback), "this client will read and write your vault", an `Owner secret` password field, Approve / Deny. `POST /oauth/consent` with `pending_id`, `nonce`, `secret`, `action`. Nonce or pending mismatch/expired ⇒ 400 and the pending row is deleted. Deny ⇒ redirect `error=access_denied&state&iss`. Wrong secret ⇒ page re-rendered with an error, attempt counted (see 4.3). Correct ⇒ mint code (32 random bytes, stored as hash, `expiresAt: +60 s`, bound to the pending row) ⇒ `302 redirect_uri?code&state&iss=<publicUrl>`.
- `token.ts` — `POST /oauth/token`, `application/x-www-form-urlencoded` only (415 otherwise). `authorization_code`: code unused/unexpired, `client_id`, `redirect_uri`, `resource` equal to the pending row, PKCE S256 verified ⇒ access token (TTL `ACCESS_TOKEN_TTL_S`, default 3600) + refresh token (TTL `REFRESH_TOKEN_TTL_S`, default 90 d, sliding) with a new `familyId`; code marked used. `refresh_token`: rotate — new access + new refresh, old refresh `rotatedAt = now` and honoured for a 60 s grace window; use of a refresh token rotated more than 60 s ago, revoked, or expired ⇒ revoke the family and answer `400 {"error":"invalid_grant"}`. Responses `{ access_token, token_type: 'Bearer', expires_in, refresh_token, scope }`, `Cache-Control: no-store`. No outbound calls; p95 < 50 ms.
- `revoke.ts` — `POST /oauth/revoke` (RFC 7009): form field `token` (access or refresh) ⇒ revoke its whole family; always `200`.

### 4.3 Owner authentication — `src/auth/owner.ts`
`OwnerAuth.verify(candidate)`: constant-time comparison (`crypto.timingSafeEqual` on equal-length buffers) against `OWNER_SECRET` (required, ≥ 32 bytes when base64url-decoded, otherwise boot fails with a hint to run `npm run setup`). Brute-force guard is **global, not per IP** (behind the tunnel every request has the same source address): 5 failed attempts per rolling minute, then a 15-minute lockout during which the consent page says so; counters in memory. Every failure is logged without the candidate.

### 4.4 Token store — `src/auth/store/`
`TokenStore` interface: `getClient/putClient`, `putPending/takePending`, `putCode/takeCode`, `putToken/getToken/rotateToken/revokeFamily/revokeAll`, `sweepExpired(now)`. Implementation `FileTokenStore` at `<vault>/_brainstem/state.json` (inside the vault on purpose — see 4.10; `STATE_DIR` overrides the location for tests): whole document in memory, every mutation serialised through an in-process queue and written temp-file + `rename`; the file's mtime is checked before each read so an external edit (the `revoke-all` tool) is picked up without a restart; document validated with Zod on load (`version: 1`); a corrupt or newer-version file ⇒ boot refused with the path and the hint `npm run revoke-all -- --reset`; a sync-conflict copy next to it (`state.sync-conflict-*.json`, `state (conflicted copy).json`) is reported at boot and ignored. Secrets (codes, tokens) are stored **only as SHA-256 hex**, so syncing the file to other devices leaks nothing usable; pending rows and clients are plain. `sweepExpired` runs at boot and every 10 min. A Postgres implementation is the deferred multi-user path; nothing else changes.

### 4.5 Request context — `src/auth/context.ts`
`createOwnerResolver(runtime): RuntimeResolver` — returns `runtime` when `ctx.authInfo?.extra?.userId === 'owner'`, otherwise throws (defence in depth; `requireBearerAuth` already blocks). `clientName` from `authInfo.extra` is attached to the tool log line.

### 4.6 Config — `src/config.ts`
Added: `OWNER_SECRET` (required), `CIMD_ALLOWED_HOSTS` (default `claude.ai,claude.com`), `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_S`, `VAULT_WATCH_POLL_MS` (default unset = native events; `> 0` ⇒ chokidar `usePolling` with that interval), `PUBLIC_URL_FILE` (quick mode: path of the file the tunnel supervisor writes; when set it takes precedence over `PUBLIC_URL`), `STATE_DIR` (default `<vault>/_brainstem`). Removed: `DATABASE_URL`, `STORAGE_BACKEND=drive` branch (backend is `localfs`; the enum stays so the adapter seam survives). `PUBLIC_URL` unchanged (https required unless `ALLOW_INSECURE_PUBLIC_URL=true`); the missing-`PUBLIC_URL` error hint becomes "run `npm run setup`".

### 4.7 LocalFSAdapter — one option
`watch()` gains `{ usePolling, interval }` from `VAULT_WATCH_POLL_MS`; Docker Desktop bind mounts (Windows, macOS) do not propagate inotify, so `setup` enables polling on non-Linux hosts. Nothing else in Phase 1 changes.

### 4.8 `/health`
Adds `publicUrl`, `mcpUrl`, `tunnelMode`, `vault: { notes: <indexed count> }` so `status` can show them. No secrets.

### 4.9 Tunnel modes and URL rotation — `tunnel/` image, `src/tunnel/supervisor.ts`
`TUNNEL_MODE` is set by `setup`:
- **`cloudflare`** (has `TUNNEL_TOKEN`; recommended): the `tunnel` container runs `cloudflared tunnel run --token $TUNNEL_TOKEN`; the owner has mapped a public hostname to `http://app:3000` in the Cloudflare Zero Trust dashboard; `PUBLIC_URL=https://<that hostname>` is fixed in `.env`. Nothing ever rotates. README explains the 5-minute dashboard setup (free Cloudflare account + a domain on Cloudflare DNS).
- **`quick`** (no token): the container runs `cloudflared tunnel --url http://app:3000 --no-autoupdate` under a small TypeScript supervisor that parses stdout for `https://[a-z0-9-]+\.trycloudflare\.com`, writes it atomically to `<vault>/_brainstem/public-url` (the file named by `PUBLIC_URL_FILE`), and restarts `cloudflared` with backoff if it exits. A quick tunnel keeps its hostname across network blips (cloudflared reconnects); the hostname changes only when the process restarts — reboot, `docker compose restart`, crash.
- **`none`**: no tunnel; `PUBLIC_URL=http://localhost:3000` + `ALLOW_INSECURE_PUBLIC_URL=true`; Claude Code and Inspector only.

`app` in quick mode: at boot waits up to 120 s for `PUBLIC_URL_FILE` to appear, then treats its content as `PUBLIC_URL`; it polls the file every 5 s and, when the content changes, logs `tunnel URL changed`, drains (existing shutdown path), and exits 0 — Docker (`restart: unless-stopped`) restarts it with the new issuer/`resource`. The issuer therefore stays immutable for the lifetime of a process, as OAuth expects. Old tokens fail audience validation ⇒ 401 ⇒ Claude asks to reconnect; the connector must be removed and re-added in claude.ai / Claude Code because the URL is part of its identity — unavoidable, and the reason `cloudflare` mode is recommended.

**Notification of a new URL** (quick mode, and also written once in `cloudflare` mode): on every boot the app upserts the note `_brainstem/connection.md` in the vault — connector URL `<PUBLIC_URL>/mcp`, mode, `updatedAt`, the `claude mcp add` command, and the three reconnect steps for claude.ai. Because the vault is synced, the note appears on the phone, which is where the connector has to be re-added. No webhook in v1 (YAGNI; `TokenStore`-style seam not needed — it would be one `fetch`).

### 4.10 State lives in the vault — `_brainstem/`
Everything the server persists goes to `<vault>/_brainstem/`: `state.json` (4.4), `public-url` (4.9), `connection.md` (4.9), `instance.json` (`hostname`, `startedAt`, heartbeat every 60 s). Rationale (owner, 2026-08-28): whatever syncs the vault (Obsidian Sync, Syncthing, git, Dropbox) now also carries the server state, so another machine with the same `.env` resumes with the same clients and tokens — in `cloudflare` mode that means **no re-login anywhere**. Consequences:
- `_brainstem/` is a **reserved prefix** in `src/storage/path-policy.ts`: every tool path that starts with it is `INVALID_PATH`; `vault_list`, search, the frontmatter index and the watcher skip it; `connection.md` is for the human in Obsidian, not for Claude.
- Only text/JSON files, always written temp + `rename`; no databases (see §2).
- Obsidian Sync users must enable *Sync all other types* (JSON is not synced by default); Syncthing/git/Dropbox need nothing. Documented in the README.
- One machine at a time: at boot, if `instance.json` names another hostname with a heartbeat younger than 5 min, the app logs a loud warning (sync latency makes a hard lock unreliable; the vault itself would suffer first anyway).
- Backup = backup of the vault. Nothing else to save; `docker compose down --purge` no longer exists.

## 5. CLI — `src/cli/`

Run as `npm run brainstem -- <command>`; aliases `npm run setup|up|url|status|down|logs|revoke-all`. Node 24 executes the `.ts` files directly (no build step). Dependencies: `commander` 15 (commands, `--help`), `@inquirer/prompts` 8 (prompts with validation). Everything else is Node built-ins: `node:crypto` (secret), `node:child_process.spawn` without a shell (no quoting issues on Windows), `node:fs`, `node:readline` fallback when stdin is not a TTY (`--vault` flag required then).

Files: `brainstem.ts` (entry, command wiring), `env-file.ts` (parse/update `.env` **preserving comments and order**, filling only empty or missing keys unless `--force`), `docker.ts` (`compose(args)` runner, `docker compose version` check with a clear "Docker is not running / not installed" message), `tunnel.ts` (start `cloudflared`, poll its logs for `https://[a-z0-9-]+\.trycloudflare\.com`, 60 s timeout), `vault-path.ts` (validation), `commands/*.ts`. All logic that does not touch Docker is pure and unit-tested; commands take an injected runner so they are tested against a fake compose.

| Command | Behaviour |
|---|---|
| `setup [--vault <path>] [--tunnel-token <t>] [--public-url <u>] [--force]` | Creates `.env` from `.env.example` if missing. Fills empty keys: `OWNER_SECRET` = 32 random bytes base64url; `VAULT_PATH` from `--vault` or an interactive prompt (suggests `~/Obsidian*`, `~/Documents/Obsidian*` if found); **tunnel**: asks "Do you have a Cloudflare tunnel token? (stable URL, recommended)" → yes: `TUNNEL_MODE=cloudflare`, `TUNNEL_TOKEN`, `PUBLIC_URL=https://<hostname you mapped>` (validated https, no path); no: `TUNNEL_MODE=quick`, `PUBLIC_URL_FILE=/vault/_brainstem/public-url`, with a printed warning that the URL changes on every restart; `--local`-style answer: `TUNNEL_MODE=none`; `HOST_UID`/`HOST_GID` (Linux only); `VAULT_WATCH_POLL_MS=2000` on non-Linux; `VAULT_TIMEZONE` from the host if empty. Prints what it set and what it kept. Never prints the secret unless `--show-secret`. |
| `up [--no-build]` | `compose [--profile tunnel] up -d [--build]` (profile only when `TUNNEL_MODE != none`) → poll `http://localhost:3000/health` (≤ 120 s; in quick mode the app waits for the supervisor's URL) → print: connector URL `<publicUrl>/mcp`, `claude mcp add --transport http brainstem <publicUrl>/mcp`, "the owner secret is in `.env` (`npm run brainstem -- secret show`)", and in quick mode "this URL changes on every restart — see `_brainstem/connection.md` in your vault; for a stable URL run `setup --tunnel-token …`". Plain `docker compose --profile tunnel up -d` does the same without the summary. |
| `url` | Reads `publicUrl` from `http://localhost:3000/health`, then checks `<publicUrl>/health` through the tunnel; prints both results; exit 1 if either fails. |
| `status` | Vault path (exists? writable?), watch mode, tunnel mode + URL + health, indexed note count, container states (`compose ps --format json`). |
| `down` | `compose --profile tunnel down`. State stays in `<vault>/_brainstem/`. |
| `logs [service]` | `compose logs -f`. |
| `revoke-all [--reset]` | Empties `tokens`/`codes`/`pending` in `<VAULT_PATH>/_brainstem/state.json` directly from the host (same `FileTokenStore` code, atomic write; the running app reloads on mtime change). `--reset` deletes the file (recovery from corruption). |
| `secret show \| rotate` | Shows the secret / regenerates it (asks whether to also `revoke-all`). |

Vault path validation (`vault-path.ts`): absolute (Windows drive or POSIX), exists, is a directory, writable (temp file created and removed), is not `/`, not `$HOME` itself, not the repo directory or an ancestor of it; warn (not fail) when `.obsidian/` is absent. Windows paths are written to `.env` as given (`C:\Users\...`); Compose handles them on Docker Desktop.

`.env` is the single source of configuration; `compose.yaml` loads it with `env_file: [.env]` and passes `TUNNEL_MODE`/`TUNNEL_TOKEN` to the `tunnel` service. There is no `.env.tunnel`.

## 6. Data model (`auth-store.json`, version 1)

```
clients:  { [clientId]: { clientName, redirectUris[], fetchedAt, expiresAt, negative?: true } }   # file: <vault>/_brainstem/state.json
pending:  { [id]: { clientId, clientName, redirectUri, codeChallenge, resource, scope, state, nonce, expiresAt } }
codes:    { [sha256]: { pendingId, expiresAt, usedAt? } }
tokens:   { [sha256]: { kind: 'access'|'refresh', familyId, clientId, clientName, resource, scope, expiresAt, rotatedAt?, revokedAt?, lastUsedAt? } }
```

## 7. Security — kept vs. cut

Kept from the v1.2 plan: PKCE S256 required and advertised; `_brainstem/` reserved from every tool; `resource` bound and validated on every request; `iss` on every authorization response; single-use 60 s codes; refresh rotation with family revocation on reuse; consent per client with the redirect hostname shown and a loopback warning; consent CSRF nonce; strict CIMD fetch + host allowlist; no DCR; Origin/Host validation and `Mcp-*` header checks (Phase 0); tokens stored only as hashes; secret never logged; `/oauth/revoke`; global brute-force guard on the secret; body limits.
Cut because single-user: tenancy and isolation suites, audit table, per-tenant rate limit (a global 60 req/s token bucket on `/mcp` stays), Plane B and encryption at rest, `/account`. Each cut is listed in the plan's "Deferred" section with what it would take.
Residual risks, accepted: a stolen `.env` = full access (same as any self-hosted secret); the synced `state.json` holds only hashes; quick-tunnel hostnames are public and guessable only by brute force of the random label, and every request still needs a bearer token; `trycloudflare.com` has no availability guarantee (hence `cloudflare` mode is the recommended default); running two machines on the same synced vault at once is unsupported (warned, not prevented).

## 8. Error handling

Config errors exit 1 with bare variable names and a hint. Corrupt store ⇒ refuse to boot. Quick mode: `PUBLIC_URL_FILE` absent after 120 s ⇒ app exits 1 with "tunnel did not come up — `npm run logs tunnel`" (Docker restarts it; `up` prints the last 20 tunnel log lines). `/health` unreachable through the tunnel ⇒ `url`/`up` warn with both URLs, exit 1. `PUBLIC_URL` changed since tokens were issued ⇒ they fail audience validation ⇒ 401 ⇒ Claude asks to reconnect (documented as expected). Wrong secret ⇒ counted; lockout message names the remaining minutes. `cloudflared tunnel run` rejects the token ⇒ tunnel container logs it and restarts with backoff; `status` shows the container as restarting.

## 9. Testing

- Unit/integration (Vitest, existing harness): `owner-auth.test.ts` (timing-safe compare, lockout), `file-store.test.ts` (atomic write, reload-on-mtime, sweep, concurrent mutations), `oauth-as.test.ts` (metadata shape without `registration_endpoint`, authorize validation matrix, consent nonce/deny/wrong-secret, code exchange + PKCE, rotation, grace, family revocation, `invalid_grant`, revoke), `oauth-rs.test.ts` (401 shape, PRM, audience mismatch, expired), `cimd.test.ts` (allowlist, size, redirect, RFC 6890, `client_id` mismatch, cache headers) with an in-process HTTPS fixture, `context.test.ts`.
- End-to-end: `@modelcontextprotocol/client` with its OAuth provider completes the whole flow against `createApp` (a local CIMD document served by the test, allowlist extended in test config), then calls `vault_list`.
- Tunnel supervisor: `supervisor.test.ts` (URL extraction from sample cloudflared output, atomic file write, restart/backoff with a fake child process). App: `public-url-file.test.ts` (wait-for-file, change ⇒ shutdown hook), `connection-note.test.ts`, `reserved-prefix` cases in `path-policy.test.ts` and index/list/search tests.
- CLI: `env-file.test.ts`, `vault-path.test.ts`, `commands.test.ts` with a fake compose runner (setup in all three tunnel modes, up summary, url, revoke-all).
- Acceptance (manual, recorded in the plan): `npm run setup && npm run up` on Linux in quick mode; Claude Code connects via the tunnel URL (CIMD from claude.ai + loopback redirect, secret typed once); claude.ai web and the phone connect and write a note that appears in Obsidian; `docker compose restart tunnel` ⇒ new URL ⇒ app restarted itself, `connection.md` updated, reconnect works; the same with a Cloudflare token (`cloudflare` mode) ⇒ URL survives restarts and tokens stay valid; Windows run of `setup`/`up` (polling watch confirmed by editing a note in Obsidian and reading it through Claude).

## 10. Plan impact and estimate

`docs/implementation-plan.md` → v2.0: §1 rewritten (single-user, self-hosted), §7 replaced by a pointer to this spec, §9 Phase 2′ = "Auth (single-user) + CLI + tunnel" (~3 d: AS/RS 1.25, store + owner + reserved folder 0.5, tunnel image/supervisor/URL file/connection note 0.5, CLI 0.5, compose/docs 0.25), Phase 3′ = hardening + README (~0.5 d), Google/Drive/Postgres/multi-tenant/Heroku moved to §10 Deferred with their prerequisites. Detailed plan: `docs/plans/2026-08-28-phase-2-single-user-auth-cli.md` (writing-plans format, TDD tasks, executed with subagent-driven-development, `main` fast-forwarded per task as before).
