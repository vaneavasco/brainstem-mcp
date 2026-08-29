# brainstem-mcp v2 — single-user, self-hosted, Docker + Cloudflare quick tunnel

**Date:** 2026-08-28 · **Owner:** Vanea · **Status:** design approved in conversation, awaiting written review
**Supersedes:** `docs/implementation-plan.md` §1 (product), §7 (auth), Phase 2–4 of §9. Phase 0–1 code is unchanged and fully reused.

## 1. Goal

One person (the owner) uses Claude — claude.ai web, Claude mobile, Claude Desktop, Claude Code — to read and write their **existing Obsidian vault**, which lives on their own machine. The server runs entirely in Docker on that machine; claude.ai reaches it through a **Cloudflare quick tunnel**. Installation and configuration must be trivial on Linux and Windows (macOS incidentally): `git clone`, `npm install`, `npm run setup`, `npm run up`.

Decisions taken 2026-08-28 (owner): single user only; owner authenticates with a generated secret kept in `.env` (no Google); quick tunnel (random `*.trycloudflare.com` hostname per start) is acceptable; the vault is the real Obsidian folder, bind-mounted; everything that runs, runs in Docker; the CLI is TypeScript (cross-platform), not bash, and not a web UI.

## 2. Non-goals (moved to "Deferred" in the plan)

Multi-tenancy, tenant isolation suites, per-tenant rate limits, audit table, `/account` page · Google as identity provider (Plane B), encrypted refresh-token storage, re-auth handling · Google Drive adapter · Postgres · Dynamic Client Registration · Heroku · a named Cloudflare tunnel (owner may add a domain later: then `PUBLIC_URL` simply becomes fixed and `.env.tunnel` is unused).

The code keeps the seams that make these additions instead of rewrites: `StorageAdapter`, `RuntimeResolver(ctx)`, a `TokenStore` interface, and an AS whose only user-specific piece is `OwnerAuth`.

## 3. Architecture

```
 phone / claude.ai ──HTTPS──▶ Cloudflare edge ──quick tunnel──▶ [cloudflared] ──http──▶ [app :3000]
 Claude Code ─────────────────────────────────────────────────────────────────────▶ (same PUBLIC_URL)
                                                                                      │
                                              /vault  (bind mount = your Obsidian vault)◀┘
                                              /data   (named volume: auth-store.json)
 host: npm run setup | up | url | status | down | logs | revoke-all   (TypeScript CLI drives docker compose, writes .env / .env.tunnel)
```

Docker Compose services: `app` (Node 24 image from Phase 1, unchanged base), `cloudflared` (profile `tunnel`, `cloudflare/cloudflared` pinned, `tunnel --url http://app:3000 --no-autoupdate`), named volume `brainstem-data`. **Postgres is removed.**

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
`TokenStore` interface: `getClient/putClient`, `putPending/takePending`, `putCode/takeCode`, `putToken/getToken/rotateToken/revokeFamily/revokeAll`, `sweepExpired(now)`. Implementation `FileTokenStore` at `${DATA_DIR}/auth-store.json` (`DATA_DIR` default `/data`, the named volume): whole document in memory, every mutation serialised through an in-process queue and written temp-file + `rename`; the file's mtime is checked before each read so an external edit (the `revoke-all` tool) is picked up without a restart; document validated with Zod on load (`version: 1`); a corrupt or newer-version file ⇒ boot refused with the path and the hint `npm run revoke-all -- --reset`. Secrets (codes, tokens) are stored **only as SHA-256 hex**; pending rows and clients are plain. `sweepExpired` runs at boot and every 10 min. A Postgres implementation is the deferred multi-user path; nothing else changes.

### 4.5 Request context — `src/auth/context.ts`
`createOwnerResolver(runtime): RuntimeResolver` — returns `runtime` when `ctx.authInfo?.extra?.userId === 'owner'`, otherwise throws (defence in depth; `requireBearerAuth` already blocks). `clientName` from `authInfo.extra` is attached to the tool log line.

### 4.6 Config — `src/config.ts`
Added: `OWNER_SECRET` (required), `CIMD_ALLOWED_HOSTS` (default `claude.ai,claude.com`), `DATA_DIR` (default `/data`), `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_S`, `VAULT_WATCH_POLL_MS` (default unset = native events; `> 0` ⇒ chokidar `usePolling` with that interval). Removed: `DATABASE_URL`, `STORAGE_BACKEND=drive` branch (backend is `localfs`; the enum stays so the adapter seam survives). `PUBLIC_URL` unchanged (https required unless `ALLOW_INSECURE_PUBLIC_URL=true`); the missing-`PUBLIC_URL` error hint becomes "run `npm run up` (tunnel) or set PUBLIC_URL".

### 4.7 LocalFSAdapter — one option
`watch()` gains `{ usePolling, interval }` from `VAULT_WATCH_POLL_MS`; Docker Desktop bind mounts (Windows, macOS) do not propagate inotify, so `setup` enables polling on non-Linux hosts. Nothing else in Phase 1 changes.

### 4.8 `/health`
Adds `publicUrl`, `mcpUrl`, `vault: { notes: <indexed count> }` so `status` can show them. No secrets.

## 5. CLI — `src/cli/`

Run as `npm run brainstem -- <command>`; aliases `npm run setup|up|url|status|down|logs|revoke-all`. Node 24 executes the `.ts` files directly (no build step). Dependencies: `commander` 15 (commands, `--help`), `@inquirer/prompts` 8 (prompts with validation). Everything else is Node built-ins: `node:crypto` (secret), `node:child_process.spawn` without a shell (no quoting issues on Windows), `node:fs`, `node:readline` fallback when stdin is not a TTY (`--vault` flag required then).

Files: `brainstem.ts` (entry, command wiring), `env-file.ts` (parse/update `.env` **preserving comments and order**, filling only empty or missing keys unless `--force`), `docker.ts` (`compose(args)` runner, `docker compose version` check with a clear "Docker is not running / not installed" message), `tunnel.ts` (start `cloudflared`, poll its logs for `https://[a-z0-9-]+\.trycloudflare\.com`, 60 s timeout), `vault-path.ts` (validation), `commands/*.ts`. All logic that does not touch Docker is pure and unit-tested; commands take an injected runner so they are tested against a fake compose.

| Command | Behaviour |
|---|---|
| `setup [--vault <path>] [--force]` | Creates `.env` from `.env.example` if missing. Fills empty keys: `OWNER_SECRET` = 32 random bytes base64url; `VAULT_PATH` from `--vault` or an interactive prompt (suggests `~/Obsidian*`, `~/Documents/Obsidian*` if found); `HOST_UID`/`HOST_GID` (Linux only); `VAULT_WATCH_POLL_MS=2000` on non-Linux; `VAULT_TIMEZONE` from the host if empty. Prints what it set and what it kept. Never prints the secret unless `--show-secret`. |
| `up [--local] [--no-build]` | Default: `compose --profile tunnel up -d [--build] cloudflared` → wait for the tunnel URL → write `.env.tunnel` (`PUBLIC_URL=https://<x>.trycloudflare.com`, `ALLOW_INSECURE_PUBLIC_URL=false`) → `compose up -d [--build] app` → poll `<PUBLIC_URL>/health` (≤ 60 s) → print: connector URL `<PUBLIC_URL>/mcp`, `claude mcp add --transport http brainstem <PUBLIC_URL>/mcp`, "the owner secret is in `.env` (`npm run brainstem -- secret show`)", and "a new tunnel means a new URL: remove and re-add the connector in claude.ai, `claude mcp remove brainstem` then add again". `--local`: no tunnel, `.env.tunnel` gets `PUBLIC_URL=http://localhost:3000`, `ALLOW_INSECURE_PUBLIC_URL=true`; for Claude Code / Inspector only. |
| `url` | Prints `PUBLIC_URL` from `.env.tunnel` and whether `<PUBLIC_URL>/health` answers; exit 1 if the tunnel is down. |
| `status` | Vault path (exists? writable?), watch mode, tunnel URL + health, indexed note count, container states (`compose ps --format json`). |
| `down` | `compose --profile tunnel down` (volume kept). `--purge` also removes `brainstem-data` after confirmation. |
| `logs [service]` | `compose logs -f`. |
| `revoke-all [--reset]` | Empties `tokens`/`codes`/`pending` in the store via `compose exec app node dist/cli/store-tool.js revoke-all` (the image ships the compiled tool; works while the app runs — the store reloads on mtime change). `--reset` deletes the file (recovery from corruption). |
| `secret show \| rotate` | Shows the secret / regenerates it (asks whether to also `revoke-all`). |

Vault path validation (`vault-path.ts`): absolute (Windows drive or POSIX), exists, is a directory, writable (temp file created and removed), is not `/`, not `$HOME` itself, not the repo directory or an ancestor of it; warn (not fail) when `.obsidian/` is absent. Windows paths are written to `.env` as given (`C:\Users\...`); Compose handles them on Docker Desktop.

`.env.tunnel` is git-ignored and always rewritten by `up`. `compose.yaml` loads `env_file: [.env, { path: .env.tunnel, required: false }]` so the tunnel's `PUBLIC_URL` overrides the one in `.env`. Running `docker compose up` by hand without `.env.tunnel` fails fast in `loadConfig` with the hint above.

## 6. Data model (`auth-store.json`, version 1)

```
clients:  { [clientId]: { clientName, redirectUris[], fetchedAt, expiresAt, negative?: true } }
pending:  { [id]: { clientId, clientName, redirectUri, codeChallenge, resource, scope, state, nonce, expiresAt } }
codes:    { [sha256]: { pendingId, expiresAt, usedAt? } }
tokens:   { [sha256]: { kind: 'access'|'refresh', familyId, clientId, clientName, resource, scope, expiresAt, rotatedAt?, revokedAt?, lastUsedAt? } }
```

## 7. Security — kept vs. cut

Kept from the v1.2 plan: PKCE S256 required and advertised; `resource` bound and validated on every request; `iss` on every authorization response; single-use 60 s codes; refresh rotation with family revocation on reuse; consent per client with the redirect hostname shown and a loopback warning; consent CSRF nonce; strict CIMD fetch + host allowlist; no DCR; Origin/Host validation and `Mcp-*` header checks (Phase 0); tokens stored only as hashes; secret never logged; `/oauth/revoke`; global brute-force guard on the secret; body limits.
Cut because single-user: tenancy and isolation suites, audit table, per-tenant rate limit (a global 60 req/s token bucket on `/mcp` stays), Plane B and encryption at rest, `/account`. Each cut is listed in the plan's "Deferred" section with what it would take.
Residual risks, accepted: a stolen `.env` = full access (same as any self-hosted secret); quick-tunnel hostnames are public and guessable only by brute force of the random label, and every request still needs a bearer token; `trycloudflare.com` has no availability guarantee.

## 8. Error handling

Config errors exit 1 with bare variable names and a hint. Corrupt store ⇒ refuse to boot. Tunnel URL not found within 60 s ⇒ `up` prints the last 20 cloudflared log lines and exits 1 (containers left running for inspection). `/health` unreachable through the tunnel after 60 s ⇒ warning with both URLs, exit 1. `PUBLIC_URL` changed since tokens were issued ⇒ they fail audience validation ⇒ 401 ⇒ Claude asks to reconnect (documented as expected). Wrong secret ⇒ counted; lockout message names the remaining minutes.

## 9. Testing

- Unit/integration (Vitest, existing harness): `owner-auth.test.ts` (timing-safe compare, lockout), `file-store.test.ts` (atomic write, reload-on-mtime, sweep, concurrent mutations), `oauth-as.test.ts` (metadata shape without `registration_endpoint`, authorize validation matrix, consent nonce/deny/wrong-secret, code exchange + PKCE, rotation, grace, family revocation, `invalid_grant`, revoke), `oauth-rs.test.ts` (401 shape, PRM, audience mismatch, expired), `cimd.test.ts` (allowlist, size, redirect, RFC 6890, `client_id` mismatch, cache headers) with an in-process HTTPS fixture, `context.test.ts`.
- End-to-end: `@modelcontextprotocol/client` with its OAuth provider completes the whole flow against `createApp` (a local CIMD document served by the test, allowlist extended in test config), then calls `vault_list`.
- CLI: `env-file.test.ts`, `vault-path.test.ts`, `tunnel.test.ts` (URL extraction from sample logs), `commands.test.ts` with a fake compose runner.
- Acceptance (manual, recorded in the plan): `npm run setup && npm run up` on Linux; Claude Code connects via the tunnel URL (CIMD from claude.ai + loopback redirect, secret typed once); claude.ai web and the phone connect and write a note that appears in Obsidian; `npm run up` again ⇒ new URL ⇒ reconnect works; Windows run of `setup`/`up` (polling watch confirmed by editing a note in Obsidian and reading it through Claude).

## 10. Plan impact and estimate

`docs/implementation-plan.md` → v2.0: §1 rewritten (single-user, self-hosted), §7 replaced by a pointer to this spec, §9 Phase 2′ = "Auth (single-user) + CLI + tunnel" (~2.5 d: AS/RS 1.25, store + owner 0.5, CLI 0.5, compose/tunnel/docs 0.25), Phase 3′ = hardening + README (~0.5 d), Google/Drive/Postgres/multi-tenant/Heroku moved to §10 Deferred with their prerequisites. Detailed plan: `docs/plans/2026-08-28-phase-2-single-user-auth-cli.md` (writing-plans format, TDD tasks, executed with subagent-driven-development, `main` fast-forwarded per task as before).
