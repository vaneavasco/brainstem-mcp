# Implementation Plan: `brainstem-mcp` — Multi-Storage MCP Vault Server (TypeScript)

**Status:** v1.2 — scope frozen 2026-08-27; protocol/auth/infra sections revised the same day after the 2026-readiness review (`docs/reviews/2026-08-27-plan-review.md`); §7 account/auth model corrected 2026-08-28 after a live consistency check against the MCP spec, Claude connector docs, Google OAuth docs and SDK v2 (`docs/reviews/2026-08-28-auth-consistency-review.md`)
**Owner:** Vanea
**Repo:** git@github.com:vaneavasco/brainstem-mcp.git
**Executor:** Claude Code
**Reference project (functional parity source):** https://github.com/jimprosser/obsidian-web-mcp — port its tool surface (currently **20 tools**), security model, and OAuth *behavior*; do NOT port its architecture (Python, single-user, filesystem-only) and do NOT port its DCR-first auth as-is (see §7).

---

## 0. Pinned protocol & platform targets (new in v1.1)

| Target | Value | Why |
|---|---|---|
| MCP spec | **2026-07-28** (stateless core, MRTR, header routing, cacheable lists) | Current spec. Serve **legacy 2025-06-18 / 2025-11-25 clients too** via SDK legacy mode — Claude's 2026-07-28 rollout is still in progress — as of 2026-08-28 the connector docs list only 2025-03-26 / 2025-06-18 / 2025-11-25, so `legacy: 'stateless'` is mandatory through Phase 2. Flip to `legacy: 'reject'` only after verifying claude.ai web + mobile + Desktop + Claude Code all negotiate 2026-07-28. |
| MCP SDK | `@modelcontextprotocol/server` **2.0.0**, `@modelcontextprotocol/express` 2.0.0, `@modelcontextprotocol/node` 2.0.0, `@modelcontextprotocol/core` (published 2026-07-27, first v2 line) | The v1 monolith `@modelcontextprotocol/sdk` is being retired (bugfix-only ~6 months after v2). **Pin exact versions**, bump weekly through Phase 1, read the changelog each bump. |
| HTTP framework | **Express 5.2.x** (latest 5.x; adapter peer range `^4.18 \|\| ^5.0`) | Owner decision (2026-08-27). Express 5 has async-error propagation and a Web-standard-ish router; the MCP Express adapter supplies `requireBearerAuth`, `mcpAuthMetadataRouter`, `hostHeaderValidation`. |
| Validation | Zod **^4.2** (SDK peer dep) | v1's Zod 3 schemas are not auto-converted in v2. |
| Runtime | **Node 24.x** (Active LTS; Heroku default), TypeScript strict (TS 6 needs the explicit type config the SDK README describes) | Node 22 is Maintenance LTS (EOL 2027-04); Node 26 becomes LTS Oct 2026 — revisit then. |
| Hosting | **Deferred (2026-08-28):** the acceptance environment through Phase 1–3 is a local **Docker Compose** stack (app + Postgres 17, bind-mounted vault). Heroku (Basic dyno + `heroku-postgresql:essential-0`) stays the intended production target and its constraints (§8, §11) still shape the code. | Owner decision: make everything work locally first; Heroku provisioning happens when we decide to go public. |
| Clients that must work at DoD | claude.ai web, Claude mobile (iOS/Android), Claude Desktop, **Claude Code** (`claude mcp add --transport http`) | Same Anthropic auth infra for hosted surfaces; Claude Code is a native client with CIMD + loopback redirect (exercises a different AS code path). **Hosted surfaces can only reach a hostname with a public IPv4 A record** (Claude rejects private/loopback/CGNAT resolutions), so the claude.ai/mobile acceptance needs a public URL (tunnel with public DNS, or Heroku); Claude Code and MCP Inspector work against `http://localhost`. |

## 1. Product definition (frozen — do not relitigate during build)

A remote MCP server, written in TypeScript/Node, that gives Claude (web, desktop, mobile, Claude Code) read/write access to a user's personal markdown vault. Key differences vs. the reference project:

1. **Multi-tenant.** Each user logs in with their own Google account. Strict tenant isolation.
2. **Pluggable storage.** A `StorageAdapter` interface with two v1 implementations: `LocalFSAdapter` (dev/self-host) and `GoogleDriveAdapter` (production default). GitHub adapter is Phase 2 — design the interface for it, do not build it.
3. **Personal vaults only (v1).** Each user's notes live in a folder in **their own** Google Drive. No shared/team vault in v1 (explicitly deferred; see §10).
4. **Hosted on Heroku** (Basic dyno). Ephemeral filesystem is acceptable because production storage is remote. **The server is stateless per request** (MCP 2026-07-28 model): any dyno can serve any request; all in-memory structures are caches.

Non-goals for v1: team/shared vaults, GitHub/Postgres storage backends, semantic search, any UI beyond OAuth/consent pages, MCP Apps, Tasks extension, Obsidian plugin compatibility beyond plain `.md` + YAML frontmatter + `.canvas` JSON.

Context (for the "why build" ADR): Google now ships an official Drive MCP server (`drivemcp.googleapis.com`, developer preview since 2026-05) and Anthropic's Google Drive connector gained write actions (2026-08). Neither offers vault semantics (path policy, frontmatter index, soft delete, daily notes, canvas). We are complementary, not competing.

## 2. Tech stack

- **Runtime:** Node 24.x, TypeScript strict mode, ESM. Build with `tsc` for production (native type-stripping only for scripts).
- **MCP:** `@modelcontextprotocol/server` 2.0.0 (`createMcpHandler(factory)`, `registerTool` config-object API, `ctx` handler context) + `@modelcontextprotocol/express` + `@modelcontextprotocol/node`. Streamable HTTP mounted at **`/mcp`** on Express 5.2.x.
- **Google:** `@googleapis/drive` (Drive v3; per-API package, currently v21.x) + `google-auth-library` (`OAuth2Client`, `verifyIdToken`).
- **Frontmatter:** `gray-matter` (or `yaml` + a 30-line splitter if gray-matter's YAML engine causes trouble — executor's call, one ADR line).
- **DB:** Heroku Postgres essential-0 via `pg` + thin query layer (no heavy ORM). **Pool max 5**, `statement_timeout` 5 s. Stores users, encrypted Google refresh tokens, vault folder mappings, OAuth clients/pending requests/codes/tokens, audit events.
- **Crypto:** AES-256-GCM for Google refresh tokens at rest, key from `ENCRYPTION_KEY` (32 bytes, base64). Plane A tokens stored as SHA-256 hashes only.
- **Tests:** Vitest 4. Tenant-isolation, auth-bypass, audience-validation and CIMD-SSRF suites are release-blocking.
- **Lint/format:** Biome (single binary, replaces eslint+prettier) — ESLint is acceptable if the executor wants type-aware rules; pick one in Phase 0, ADR line.
- **Logging:** pino, JSON, no PII/secrets/note content.
- **CI:** GitHub Actions — typecheck, lint, tests, `npm audit --omit=dev` (fail on high/critical), Dependabot enabled.

## 3. Repository structure

```
brainstem-mcp/
  src/
    server.ts              # Express 5 app; createMcpHandler mount at /mcp; keepAliveTimeout >= 90s; Origin + Host validation
    config.ts              # env parsing, fail-closed validation
    auth/
      as/                  # Plane A — we are the OAuth 2.1 Authorization Server
        metadata.ts        # /.well-known/oauth-authorization-server (RFC 8414)
        authorize.ts       # /oauth/authorize: client resolution (pre-reg -> CIMD -> DCR), PKCE, resource, consent, iss
        token.ts           # /oauth/token: code exchange, refresh rotation, form-urlencoded only
        register.ts        # /oauth/register: DCR fallback (deprecated path; rate-limited; application_type aware)
        cimd.ts            # Client ID Metadata Document fetcher: SSRF guard, cache, validation
        consent.ts         # consent page: client_name, redirect hostname, loopback warning, what is granted
      rs/                  # Plane A — we are the OAuth 2.1 Resource Server
        prm.ts             # /.well-known/oauth-protected-resource[/mcp] (RFC 9728) via mcpAuthMetadataRouter
        bearer.ts          # requireBearerAuth + OAuthTokenVerifier: hash lookup, expiry, audience (RFC 8707)
      google/
        idp.ts             # Plane B — Google code flow, ID token verification, refresh, invalid_grant handling
      crypto.ts            # AES-256-GCM helpers, token hashing
    tenancy/
      context.ts           # per-request TenantContext { userId, clientName, adapter } — derived only from the verified bearer
      registry.ts          # userId -> adapter instance (cache; byte-bounded LRU; safe under concurrency)
      ratelimit.ts         # per-tenant token bucket (spec: servers MUST rate limit tool invocations)
    storage/
      adapter.ts           # StorageAdapter interface + capability flags (§4)
      local-fs.ts          # LocalFSAdapter
      google-drive.ts      # GoogleDriveAdapter
      frontmatter-index.ts # per-tenant in-memory index — a CACHE, rebuildable at any time (§6)
      path-policy.ts       # normalization + traversal rejection (shared by all adapters)
    tools/
      read.ts write.ts binary.ts search.ts manage.ts daily.ts canvas.ts analytics.ts
      annotations.ts       # readOnlyHint/destructiveHint/idempotentHint/openWorldHint per tool (§5)
      register.ts          # registers all 20 tools, injects TenantContext, outputSchemas, cache hints
    audit/
      audit.ts             # Postgres audit_events writer (mutations always, reads optional)
    db/
      schema.sql migrations/ queries.ts
  tests/
    tenant-isolation.test.ts   # RELEASE-BLOCKING
    oauth-as.test.ts           # PKCE S256, CIMD, DCR fallback, iss, refresh rotation, consent gate, redirect exact-match
    oauth-rs.test.ts           # 401 challenge shape, PRM, audience validation, token passthrough rejection, auth-bypass regressions
    cimd-ssrf.test.ts          # private IPs, redirects, oversized docs, client_id mismatch
    transport.test.ts          # Mcp-* header/body mismatch, Origin 403, legacy-era fallback, GET/DELETE 405
    path-policy.test.ts
    adapters/ tools/
  Procfile
  app.json
  README.md
  docs/adr/                # architecture decision records
```

## 4. StorageAdapter interface (design first — everything depends on this)

```typescript
interface StorageAdapter {
  read(path: string): Promise<Note>;                          // { content, frontmatter, meta }
  batchRead(paths: string[]): Promise<BatchReadResult>;       // missing files reported, not thrown
  write(path: string, content: string, opts?: WriteOpts): Promise<void>;  // opts.mergeFrontmatter
  writeBinary(path: string, bytes: Uint8Array, mime: string): Promise<void>; // allowlisted mime, 1 MB cap
  edit(path: string, patches: TextPatch[], dryRun?: boolean): Promise<Diff>;
  append(path: string, content: string): Promise<void>;       // creates if missing
  batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult>;
  list(prefix: string, opts?: ListOpts): Promise<Entry[]>;    // depth, glob, files/dirs toggles
  move(from: string, to: string): Promise<void>;
  softDelete(path: string, confirm: boolean): Promise<void>;  // confirm=false -> error; moves to .trash/
  search(query: string, opts?: SearchOpts): Promise<Match[]>; // capped at 50 matches
  watch?(onChange: (e: ChangeEvent) => void): Unsubscribe;    // OPTIONAL — see capabilities
  capabilities(): Caps;
}

interface Caps {
  atomicWrites: boolean;    // FS: true (temp+rename). Drive: false (single PUT is atomic enough; document semantics)
  nativeSearch: boolean;    // FS: ripgrep/fallback. Drive: fullText contains (weak — document limits)
  watch: boolean;           // FS: chokidar. Drive: false in v1 (index refreshed on-write + TTL re-scan; Drive Events API deferred, §10)
  revisions: boolean;       // Drive: true = Drive keeps its default revision history. FS: false. NOT "pin forever" (see below)
}
```

Rules:
- Core/tools code MUST branch on `capabilities()`, never on adapter class names.
- All paths are vault-relative, normalized by `path-policy.ts` before reaching any adapter: reject `..`, absolute paths, null bytes, and dotfile access (`.obsidian`, `.git`, `.trash` direct access) — mirror the reference repo's path security exactly. Ripgrep is invoked with argv arrays, never a shell string (port `test_search_argv_injection`).
- Write cap 1 MB/file (text and binary), batch cap 20 files/request, search cap 50 matches (same limits as reference). Tool results are additionally capped at ~120k characters (claude.ai truncates around 150k) — `vault_read` on oversized notes returns a windowed slice with `offset`/`hasMore`.

### GoogleDriveAdapter specifics
- **Scope: `https://www.googleapis.com/auth/drive.file` (+ `openid email`) — FROZEN DECISION.** Rationale: personal per-user vaults mean the app only ever needs files it created itself; `drive.file` is non-sensitive → no Google verification audit → app can run in Production mode → refresh tokens don't expire weekly (Testing-mode pain). Known accepted limitation: files manually dropped into the folder via Drive UI are invisible to the app; imports happen through the app/Claude. Do not "upgrade" to full `drive` scope without reopening §10.
- On first login: find-or-create root folder (name from `VAULT_FOLDER_NAME`, default `SecondBrain`) in the user's My Drive; persist **folder ID** (never resolve by name again). Create skeleton subfolders: `00-inbox/`, `01-projects/`, `02-areas/`, `03-resources/`, `04-archive/`, `_MOC/`.
- **Path ↔ fileId map:** because `drive.file` only exposes app-created files, ONE paginated `files.list` with `q="trashed=false"` and `fields="nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,appProperties)"` returns the whole vault regardless of folder; rebuild paths from `parents` chains. Do **not** tree-walk with `'<id>' in parents` (non-recursive; 100 quota units per call). Invalidate/patch the map on write/move/delete; full rebuild on TTL (10 min) or miss.
- **Writes:** `files.update` media upload. **Do NOT set `keepRevisionForever=true`** — Drive caps pinned revisions at 200/file and they count against the user's storage; a daily note appended 10×/day would hit the cap in 20 days. Rely on Drive's default retention (≈30 days / 100 revisions). Store `type`, `domain`, `status` frontmatter keys also as `appProperties` for server-side filtering (`appProperties has { key='type' and value='…' }`).
- **Search:** Drive `fullText contains` (app-visible files only) merged with frontmatter-index hits; document that quality is weaker than FS ripgrep.
- **Quota (model changed 2026-05-01 to quota units):** `files.get` 5, `files.update` 50, `files.list` 100 units; 325k units/min/user. Truncated exponential backoff with jitter on 403/429 (`min(2^n + rand, 32s)`); surface a clean MCP tool error, never a stack trace.
- **Analytics tools** on Drive: compute over the frontmatter index + batched body reads (≤20/batch), cache result per tenant for 10 min; never scan the full vault on every call.

## 5. Tool surface (parity with reference repo — 20 tools)

Port name-for-name from https://github.com/jimprosser/obsidian-web-mcp:

`vault_read`, `vault_batch_read`, `vault_write`, `vault_write_binary` (base64 image/PDF, media-type allowlist, 1 MB), `vault_edit` (ordered exact-text patches, dry-run diff), `vault_append`, `vault_batch_frontmatter_update`, `vault_search`, `vault_search_frontmatter`, `vault_list`, `vault_move`, `vault_delete` (soft, `confirm=true` required), `vault_canvas_read`, `vault_canvas_add_node`, `vault_canvas_add_edge`, `vault_daily_note_path`, `vault_daily_note_read`, `vault_daily_note_append`, `vault_analytics_summary`, `vault_analytics_findings`.

Requirements (2026):
- **Annotations on every tool** — Claude requires `readOnlyHint` and `destructiveHint` and uses them for approval prompts. Also set `title`, `idempotentHint`, `openWorldHint: false`.

  | Tools | readOnly | destructive | idempotent |
  |---|---|---|---|
  | `vault_read`, `vault_batch_read`, `vault_search`, `vault_search_frontmatter`, `vault_list`, `vault_canvas_read`, `vault_daily_note_path`, `vault_daily_note_read`, `vault_analytics_*` | true | false | true |
  | `vault_write`, `vault_write_binary`, `vault_batch_frontmatter_update`, `vault_canvas_add_node`, `vault_canvas_add_edge` | false | true (overwrites) | true |
  | `vault_edit`, `vault_append`, `vault_daily_note_append` | false | false | false |
  | `vault_move`, `vault_delete` | false | true | false |
- **`outputSchema` + `structuredContent`** for `vault_list`, `vault_search*`, `vault_batch_read`, `vault_analytics_*`, `vault_edit` dry-run (also serialize JSON into a text block for legacy clients).
- **`tools/list` cache hints:** static list ⇒ `ttlMs: 3_600_000`, `cacheScope: "public"` via `ServerOptions.cacheHints`. Deterministic tool order.
- Tool execution errors ⇒ `isError: true` with actionable text; protocol errors only for unknown tool / malformed request.
- Keep tool descriptions token-efficient; prefer partial-edit guidance (`vault_edit`/`vault_append`) over full rewrites in descriptions.
- Canvas tools operate on `.canvas` JSON — straightforward on both adapters (they're just files).
- Daily-note config comes from per-user settings row (folder, strftime-like format via `date-fns`, optional template), defaults matching reference (`%Y-%m-%d` → `yyyy-MM-dd`).
- Note content returned to the model is **untrusted data** (prompt-injection surface): never echo it into tool descriptions or error messages; wrap read results so provenance is clear.
- `vault_delete` keeps the `confirm=true` parameter (works for both protocol eras). Do not convert it to MRTR elicitation in v1.

## 6. Frontmatter index (a cache, never state)

Per-tenant in-memory index (Map keyed by userId, **byte-bounded LRU** — Basic dyno has 512 MB — evicted after inactivity or memory pressure):
- Build lazily on first tool call for a tenant: list all `.md`, parse frontmatter (bodies fetched only when needed on Drive — use the flat `files.list` above + fetch content in batches of ≤20).
- FS: keep fresh via chokidar watch. Drive: refresh entries on every app write; full re-scan on TTL (default 10 min) or explicit miss.
- Must be safe to lose at any time (dyno restart, eviction, second dyno) — no tool may depend on a previous request having warmed it.
- `vault_search_frontmatter` queries this index: field equals / substring / exists.

## 7. Auth architecture (two OAuth planes — keep them cleanly separated)

### Plane A — Claude ↔ our server (we are both Authorization Server and Resource Server)

**Standards:** OAuth 2.1 (draft-13), RFC 8414 (AS metadata), **RFC 9728 (Protected Resource Metadata)**, **RFC 8707 (Resource Indicators)**, **RFC 9207 (`iss`)**, PKCE S256, **Client ID Metadata Documents** (primary), RFC 7591 DCR (deprecated fallback). Mirror the reference repo's fail-closed posture and auth-bypass regression tests.

**Resource server (`/mcp`):**
- Every request passes `requireBearerAuth` before any tool code. No token / invalid / expired ⇒ **HTTP 401** with
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp", scope="vault"`.
  Claude only honors the challenge on a 401 — never return an auth failure as a tool error or on a 200.
- **PRM** at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` (`mcpAuthMetadataRouter`): `resource = "<PUBLIC_URL>/mcp"` (must equal the URL the user types into Claude, exactly), `authorization_servers = [PUBLIC_URL]`, `scopes_supported = ["vault"]`, `bearer_methods_supported = ["header"]`. Do **not** list `offline_access` here.
- **Audience validation (RFC 8707):** each access token row stores `resource`; the verifier rejects tokens whose `resource ≠ "<PUBLIC_URL>/mcp"`. Tokens are opaque random strings (≥32 bytes), stored as SHA-256 hashes.
- **Token passthrough is forbidden:** the Claude-issued token never leaves this process; the Google token is a separate credential (Plane B). Test it.
- Transport hardening: validate `Origin` (403 on mismatch), Host header pinned to `PUBLIC_URL` host, `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` header↔body validation (400 / `-32020`) — provided by `createMcpHandler`; covered by `transport.test.ts`. `GET`/`DELETE` on `/mcp` only exist for legacy-era clients (SDK legacy mode).
- Single scope `vault` in v1 (avoids step-up flows). Rate limit per tenant before tool dispatch (429 as tool error with retry hint).

**Authorization server metadata** (`/.well-known/oauth-authorization-server`), all URLs built from `PUBLIC_URL`:
`issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` (DCR fallback), `scopes_supported: ["vault"]`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]` (**mandatory** — clients refuse to proceed without it), `token_endpoint_auth_methods_supported: ["none"]`, **`client_id_metadata_document_supported: true`**, **`authorization_response_iss_parameter_supported: true`**. (Claude selects CIMD only when both `client_id_metadata_document_supported` and `"none"` are present; otherwise it falls back to DCR.)

**Client registration — priority order:**
1. **Pre-registered client** (optional): user/admin pastes a client_id (+secret) into claude.ai's custom-connector dialog; we allow creating such a client via an env-seeded row. Not required for v1 launch.
2. **CIMD (primary):** `client_id` is an HTTPS URL with an explicit path (no credentials, fragment or dot-segments; an explicit port is significant). AS behavior: fetch the document (timeout 5 s, **max 5 KB** streamed, `Accept: application/json`, accept `application/json` or `application/*+json` only, **SSRF guard**: resolve DNS once, reject every RFC 6890 special-use range — loopback/private/link-local/CGNAT/cloud-metadata — reject non-HTTPS, **follow no redirects at all**, pin the resolved IP for the connection while verifying TLS against the original hostname); validate JSON, required fields `client_id`, `client_name`, `redirect_uris`; `client_id` in document must equal the URL string-for-string; cache with shared-cache semantics (`s-maxage` > `max-age` > `Expires`, conditional revalidation, `no-store`/`private` ⇒ don't cache; default 1 h, negative-cache 5 min). These rules are deliberately stricter than the spec's SHOULDs (borrowed from `@better-auth/cimd`'s validator, 2026-08); `redirect_uri` in the request must exactly match an entry — **except loopback (`http://localhost/...`, `http://127.0.0.1/...`) where the port is ignored** (RFC 8252 §7.3; Claude Code needs this). Optional `CIMD_ALLOWED_HOSTS` trust policy (default: allow all, log hostname).
3. **DCR (deprecated fallback):** `/oauth/register` accepts `application/json`, honors `application_type`, issues public clients only (`token_endpoint_auth_method: none`), stores `client_name` + `redirect_uris`; **rate-limited per IP** (e.g., 10/min) and rows expire after 30 days unused. Kept only because Claude falls back to it.

**Authorize (`GET /oauth/authorize`):** require `response_type=code`, `client_id`, `redirect_uri` (validated as above), `code_challenge` + `code_challenge_method=S256` (reject `plain` or missing), `resource` (must equal `<PUBLIC_URL>/mcp`; if absent, default to it and log — Claude always sends it), `scope ⊆ {vault}`, `state` (echoed). Persist a `oauth_pending` row (all params, 10-min expiry). Then:
- **Consent screen — mandatory, no cookie shortcut** (confused-deputy rule for OAuth proxies with a static upstream client: spec MUST): shows `client_name`, the redirect **hostname** (extra warning if loopback-only), and "this client will read and write your SecondBrain vault". Approve ⇒ continue; Deny ⇒ redirect with `error=access_denied` + `state` + `iss`. **CSRF binding:** the consent `POST` carries `pending_id` plus a random `nonce` stored on the `oauth_pending` row (hidden field; optionally mirrored in a `__Host-` cookie scoped to the flow, 10 min); mismatch or replay ⇒ `400` and the pending row is burned. "No cookie shortcut" means consent is never *skipped* for a returning user — per-flow CSRF state is required, not forbidden.
- **Plane B hand-off:** redirect to Google (see below) with `state = pending.id`.
- **Callback completion:** on Google success, find-or-create user, store refresh token if returned, mint a single-use authorization code (**≤ 60 s**, bound to `client_id`, `redirect_uri`, `code_challenge`, `resource`, `scope`, `user_id`), redirect to `redirect_uri` with `code`, `state`, and **`iss=<PUBLIC_URL>`** (RFC 9207; also on error responses).

**Token (`POST /oauth/token`, `application/x-www-form-urlencoded` only — a JSON-only body parser returns 415 and breaks Claude):**
- `grant_type=authorization_code`: verify code unused/unexpired, `client_id` match, `redirect_uri` match, PKCE `code_verifier` (S256), `resource` match. Issue access token (**TTL 1 h**) + refresh token (TTL 90 days sliding, `family_id`). Response is JSON with `token_type: "Bearer"`, `expires_in`, `scope`.
- `grant_type=refresh_token`: **rotate** (OAuth 2.1 MUST for public clients): issue new access + new refresh, mark old refresh as rotated with a **60 s grace window** for network races; reuse of a token outside the grace window ⇒ revoke the whole family. Dead/revoked/expired ⇒ `400 {"error":"invalid_grant"}` (RFC 6749 code — Claude keys re-auth on it).
- No upstream (Google) calls inside `/token` — Claude waits ≤10 s (≤30 s for refresh).
- `client_credentials` grant is NOT offered (Claude does not support M2M; reference repo's headless grant is not ported).

### Plane B — our server ↔ Google (we are an OAuth client, Google is the IdP)
- Google code flow via `google-auth-library` `OAuth2Client`: scopes `openid email https://www.googleapis.com/auth/drive.file`, `access_type=offline`, `include_granted_scopes=true`, `state=<pending.id>`, redirect `PUBLIC_URL/oauth/google/callback`. **Two-step prompt logic** (we do not know *which* Google account will log in before the callback, so "do we already hold a refresh token for this user" cannot be decided up front): step 1 redirects with `prompt=select_account` (no consent); at the callback we learn `sub` — if we hold a valid encrypted refresh token for that `sub`, or Google returned a fresh one, we are done; if we hold none **and** Google returned none (it only issues one on first consent), step 2 redirects again with `prompt=consent&login_hint=<sub>` and completes on that callback. Never send `prompt=consent` blindly: Google caps refresh tokens at **100 per Google Account per OAuth client** (oldest silently invalidated) and each consent mints a new one.
- Verify the ID token (`verifyIdToken` → `sub`, `email`, `aud` = our Google client_id) instead of calling userinfo. Store profile (`google_sub`, `email`) + AES-256-GCM-encrypted refresh token.
- Google access tokens refreshed on demand (in-memory per-tenant, ~55 min); on `invalid_grant` (revoked / 6-month inactivity) mark `users.reauth_required = true`, return a tool error explaining that the connector must be reconnected, **and revoke every Plane A token family of that user**. Reason: while the Plane A token is valid Claude never re-runs the OAuth flow, so without the revocation the user would have to find "disconnect" manually; with it, Claude's next refresh gets `invalid_grant`, it shows its own "Connect" prompt, and the reconnect goes consent → Google (step 2 above applies, no stored token) → new refresh token → flag cleared. The tool error is still returned once so the failure is visible in the conversation.
- Google Cloud consent screen in **Production** with only non-sensitive scopes ⇒ no verification audit, no 7-day refresh-token expiry, no 100-test-user cap. Brand verification (logo) optional. Console facts (Google Auth Platform, since 2025-06): the **client secret is shown once at creation** (only the last 4 chars afterwards) — paste it into `.env` immediately; **OAuth clients unused for 6 months are auto-deleted** (30-day recovery) — irrelevant once real users exist, relevant for a long pause between Phase 2 and go-live.
- Trust `email` only when the ID token has `email_verified: true`; the email is for display/audit, never for identity (a Google Account can change emails; `sub` never changes).

### Account model (what an "account" is)
- **Account = one Google identity (`sub`).** One `users` row per Google Account; a person with two Google accounts gets two independent tenants (v1 decision — no account linking).
- Under an account: **grants per Claude client** (claude.ai web/mobile/Desktop share one hosted client; Claude Code is a separate CIMD client) = separate Plane A token families, revocable independently; **one** Google refresh token (Plane B); **one** vault (`vaults` row: Drive folder id or `VAULT_PATH/<userId>` on LocalFS).
- **Lifecycle endpoints:** `POST /oauth/revoke` (RFC 7009, `revocation_endpoint` advertised in AS metadata; revokes the token's whole family) ships in Phase 2 — Claude is not documented to call it on "disconnect", but it is cheap and correct. Phase 4 adds a minimal **`/account` page** (Google login → list grants by `client_name` + last use, revoke a grant, **delete account**: revoke the Google refresh token at `https://oauth2.googleapis.com/revoke`, delete the user's rows; vault data is never deleted by the app — the Drive folder belongs to the user). Until then "delete my data" is a manual SQL + Google *Third-party access* revocation, documented in the README.

### Data model (Postgres)
`users(id, google_sub UNIQUE, email, email_verified bool, reauth_required bool, created_at)` · `google_tokens(user_id PK, refresh_token_enc, updated_at)` · `vaults(user_id PK, backend, root_ref, settings jsonb)` · `oauth_clients(client_id PK, kind 'prereg'|'dcr'|'cimd', client_name, redirect_uris jsonb, metadata jsonb, fetched_at, expires_at)` · `oauth_pending(id PK, client_id, redirect_uri, code_challenge, resource, scope, state, nonce, created_at, consented_at)` · `oauth_codes(code_hash PK, pending_id, user_id, expires_at, used_at)` · `oauth_tokens(token_hash PK, kind 'access'|'refresh', family_id, user_id, client_id, resource, scope, expires_at, rotated_at, revoked_at, last_used_at)` · `audit_events(id, user_id, ts, op, path, path_to, bytes_before, bytes_after, sha_before, sha_after, request_id, client_name, status, error)`.

## 8. Security requirements (release-blocking checklist)

1. **Tenant isolation:** no code path may construct an adapter from anything but the authenticated TenantContext (derived per request from the verified bearer — there are no sessions). Dedicated suite proves user A can never read/write/list/search user B's vault, including via cache poisoning of the path→fileId map and the frontmatter index, and under **concurrent** A/B requests on one instance.
2. **Path policy tests:** traversal, absolute, null-byte, dotfile, ripgrep argv injection — all rejected (port reference repo's test intent).
3. **OAuth AS:** PKCE S256 required and advertised; code single-use with expiry ≤ 60 s; redirect URI exact-match (loopback port-agnostic only); `iss` on every authorization response; refresh rotation with family revocation on reuse; `/oauth/revoke` revokes the whole family; DCR rate-limited; all metadata/issuer pinned to `PUBLIC_URL`; consent screen cannot be bypassed and its `POST` is CSRF-bound to the pending row (nonce mismatch/replay ⇒ 400); Google `invalid_grant` revokes the user's Plane A families (tested).
4. **OAuth RS:** PRM served and correct; 401 challenge shape; audience (`resource`) validated on every request; tokens for another resource rejected; **token passthrough test** (Claude token never appears in any outbound request); `Origin`/Host validation; `Mcp-*` header↔body mismatch rejected.
5. **CIMD SSRF suite:** every RFC 6890 special-use range (private/loopback/link-local/CGNAT/metadata), DNS-rebinding (single resolve + pinned connection), any redirect, documents > 5 KB or slower than 5 s, `client_id` mismatch (including port/path differences), non-JSON media types, missing explicit path — all rejected.
6. Google refresh tokens AES-256-GCM encrypted; `ENCRYPTION_KEY` never logged; no secrets, tokens, or note content in logs or error messages. Plane A tokens stored only as hashes.
7. Limits enforced server-side: 1 MB write, 20 batch, 50 search results, ~120k-char tool result, per-tenant rate limit.
8. Soft delete only; `.trash/` per vault; `confirm=true` gate.
9. **Audit log** in Postgres: every mutation (path, hashes, sizes, request_id, client_name, status); reads optional via flag; never note content; retention 90 days.
10. Note content treated as untrusted input to the model (no reflection into descriptions/errors).
11. Dependency audit in CI (`npm audit --omit=dev` gate on high/critical) + Dependabot; SDK pinned and bumped deliberately.

## 9. Milestones (target: ~11 dev-days; each phase ends green on CI)

**Phase 0 — Scaffold (1d):** repo, Node 24, TS strict, Biome/ESLint, CI, Express 5 + SDK v2 (`createMcpHandler`, legacy mode on) hello-world tool at `/mcp`, `keepAliveTimeout`, Heroku app + `essential-0` provisioned, `app.json` + `Procfile`, ADRs: SDK v2 + Express 5, DB layer, Drive path-mapping.
*Accept:* MCP Inspector connects locally and on Heroku with both a 2026-07-28 and a 2025-11-25 client profile; `tools/list` carries `ttlMs`.

**Phase 1 — Core tools on LocalFS (2.5d):** path-policy, LocalFSAdapter (atomic temp+rename writes, chokidar watch, ripgrep argv with JS fallback), frontmatter index, all **20** tools registered with annotations + outputSchemas.
*Accept:* full tool suite green against a temp vault; parity spot-check vs reference behavior (edit dry-run diffs, soft delete, daily notes, binary write, analytics).

**Phase 2 — Auth (3.5d):** Plane A RS (PRM, 401 challenge, bearer verifier, audience), Plane A AS (metadata, CIMD fetcher + SSRF guard, DCR fallback, consent page with CSRF nonce, authorize, token with rotation, `/oauth/revoke`, `iss`), Plane B (Google IdP with the two-step prompt logic, encrypted token storage, reauth handling via Plane A family revocation), tenancy context/registry/rate limit, audit log.
*Accept:* full connect flow completes from **Claude Code and MCP Inspector against the local Docker Compose stack**, then from **claude.ai web and Claude mobile** against a public URL (tunnel with public DNS, or Heroku) — Claude Code exercises CIMD + loopback, hosted surfaces exercise CIMD-or-DCR; `oauth-as`, `oauth-rs`, `cimd-ssrf`, `transport`, `tenant-isolation` suites green; refresh rotation observed in logs after 1 h.

**Phase 3 — GoogleDriveAdapter (2.5d):** folder bootstrap, flat-listing path↔fileId map, all 20 tools green on Drive, appProperties, backoff, analytics caching.
*Accept:* end-to-end on claude.ai mobile + web: login with Google → write note → read/search it → visible as `.md` in the user's own Drive folder; 10 rapid appends to a daily note do not create pinned revisions.

**Phase 4 — Hardening + onboarding (1.5d):** limits, error taxonomy, result-size windowing, logging (pino, no PII/secrets), README + 5-line user onboarding doc (connector URL + 3 example prompts), minimal `/account` page (grants, revoke, delete account — §7 account model), seed templates written to `00-inbox/README.md` on vault creation, §8 checklist walked item by item.
*Accept:* 2 real users (Vanea + 1 colleague) connected in production from phones; security checklist §8 fully checked.

## 10. Deferred (do not build in v1 — reopen only with demonstrated need)

- **Team/shared vault** (reopens Drive scope decision — requires full `drive` scope or Workspace Internal app; would also motivate Enterprise Managed Authorization).
- GitHub adapter; Postgres/pgvector search layer; import tool for pre-existing notes; per-user daily-note templates UI.
- **Drive change notifications** via Google Workspace Events API (Drive events GA 2026-05-18; Pub/Sub required) → would make `Caps.watch = true` on Drive and replace the TTL re-scan.
- **MCP Apps** (interactive note/canvas preview inside Claude) — Claude supports the extension since 2026-01.
- **Tasks extension** — not needed; all tools complete in seconds.
- **Server card / MCP Registry** (`/.well-known/mcp/server.json`, SEP-2127 still draft) — cheap onboarding win once stable.
- Flipping SDK to `legacy: 'reject'` (2026-07-28-only) once all Claude surfaces negotiate the new revision.
- MCP roadmap items (DPoP-bound tokens, agent identity, Streamable-HTTP-over-stdio) — track, don't build.

## 11. Environment variables

| Var | Required | Notes |
|---|---|---|
| `PUBLIC_URL` | yes | e.g. `https://brainstem-mcp.herokuapp.com`; pins issuer, PRM `resource` (`PUBLIC_URL/mcp`), all advertised endpoints, `iss`. Never derive URLs from `Host`/`X-Forwarded-*`. For the claude.ai/mobile test it must resolve to a public IPv4 address (tunnel or Heroku); `http://localhost:3000` (with `ALLOW_INSECURE_PUBLIC_URL=true`) is enough for Claude Code and Inspector. |
| `DATABASE_URL` | yes | Heroku Postgres essential-0 (pool max 5) |
| `ENCRYPTION_KEY` | yes | 32-byte base64; fail-closed if missing/malformed |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | OAuth client (Web application type). The secret is displayed once at creation — store it in `.env` right away; never paste it into chat or commits. |
| `STORAGE_BACKEND` | no | `drive` (default) / `localfs` |
| `VAULT_FOLDER_NAME` | no | default `SecondBrain` |
| `VAULT_PATH` | localfs only | root dir for LocalFSAdapter |
| `ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_S` | no | defaults 3600 / 7776000 (90 d) |
| `CIMD_ALLOWED_HOSTS` | no | optional comma-separated trust policy for CIMD `client_id` hosts; default allow-all with logging |
| `DCR_ENABLED` | no | default `true` (Claude falls back to DCR when CIMD isn't selected); set `false` once CIMD is verified on all surfaces |
| `AUDIT_INCLUDE_READS` | no | default `false` |
| `MCP_LEGACY_MODE` | no | `stateless` (default; serves 2025-era clients) / `reject` |
| `LOG_LEVEL` | no | default `info` |

Heroku: `app.set('trust proxy', 1)` only so Express knows the request was HTTPS (secure cookies) — never for URL construction. `server.keepAliveTimeout = 95_000` (router keeps connections 90 s). Express `engines.node: "24.x"`.

Google Cloud setup (manual, before Phase 2): create project, enable Drive API, OAuth consent screen in **Production** with only `openid`, `email`, `drive.file` scopes, authorized redirects `PUBLIC_URL/oauth/google/callback` **and** `http://localhost:3000/oauth/google/callback` (Google exempts localhost from the HTTPS rule, so the real Google flow also works against the local Compose stack).

## 12. Working agreements for Claude Code

- One ADR per consequential choice (SDK v2 + Express 5, DB layer, Drive path-mapping strategy, lint tool, frontmatter parser).
- Never widen the Google scope, never add a shared-vault code path, never store plaintext refresh tokens, never forward the Claude bearer upstream, never build URLs from request headers — frozen product/security decisions, not technical preferences.
- Prefer porting *behavior* from the reference repo (read its README and tests) over porting code (it's Python; licenses are MIT but we want idiomatic TS). Do not port its DCR-only auth, headless `client_credentials` grant, or password login — Plane A/B above replace them.
- Pin `@modelcontextprotocol/*` exactly; bump weekly in Phase 0–1 with the changelog read; a bump that breaks tests is a stop-and-ADR event, not a `--force`.
- Use the `mcp-server-dev` plugin (anthropics/claude-plugins-official) and MCP Inspector for local iteration; test the real connect flow on claude.ai and via `claude mcp add --transport http` before calling a phase done.
- Definition of done for the project: a colleague connects the claude.ai connector on their phone, logs in with Google, and their first note lands in their own Drive within 7 days of Phase 4 completion.

## 13. Feasibility & known risks (added 2026-08-27)

Everything in this plan is implementable with released software today. Risks, in order:

1. **SDK v2 is one month old** (2.0.0 published 2026-07-27). API churn and bugs are likely in Phase 0–1; mitigations: exact pins, weekly bumps, `legacy: 'stateless'` on, fallback path = `@modelcontextprotocol/sdk` 1.30 + `npx @modelcontextprotocol/codemod v1-to-v2` later. Express adapter peer range (`^4.18 || ^5.0`) covers Express 5.2.x.
2. **Claude's 2026-07-28 support is still rolling out** (connector docs on 2026-08-28 still list only the 2025 revisions) — we cannot yet verify the modern era end-to-end against claude.ai; legacy mode makes this a non-blocker. Re-test when Anthropic announces GA.
3. **CIMD selection by Claude is behavioral** (needs both metadata flags — confirmed verbatim in the connector docs on 2026-08-28) — verify on real claude.ai in Phase 2; DCR fallback stays on until then.
   **Build-vs-delegate was re-checked on 2026-08-28** (`docs/reviews/2026-08-28-auth-consistency-review.md`): SDK v2 dropped its authorization-server helpers (only the RS half remains), hosted IdPs with CIMD + a Google token vault (WorkOS AuthKit+Pipes, Scalekit, Descope) all require an external SaaS even for local dev and move the user's Drive token to a vendor, and the self-hosted Better Auth MCP plugin pins `legacy: 'reject'` and leaves Google-token custody unverified. Decision: keep the self-built AS.
4. **Heroku constraints** (20 DB connections, 512 MB, 55 s idle, 5 s default keep-alive) are all handled by explicit settings in §11; forgetting any one of them produces intermittent H13/H18/H15 errors that look like MCP bugs.
5. **Google `drive.file`** hides files the app didn't create — accepted product limitation (§4).
6. Timeline ~11 dev-days assumes one executor and no scope creep; Phase 2 is the long pole.
