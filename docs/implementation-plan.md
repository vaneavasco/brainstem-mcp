# Implementation Plan: `brainstem-mcp` — Multi-Storage MCP Vault Server (TypeScript)

**Status:** v2.0 — re-scoped 2026-08-28 to single-user self-hosted, Phase 2′ complete 2026-08-29 (spec: `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md`). Supersedes v1.2 (scope frozen 2026-08-27, protocol/auth/infra revised after `docs/reviews/2026-08-27-plan-review.md`, §7 corrected after `docs/reviews/2026-08-28-auth-consistency-review.md`) — the v1.2 multi-tenant/Google/Drive product definition is preserved verbatim in §10 for the deferred path; resume from it (git history) if the goal changes.
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
| Hosting | Local Docker Compose on the owner's machine + Cloudflare tunnel; Heroku dropped | Owner decision 2026-08-28: single-user self-hosted is the whole product now, not an interim acceptance environment — see `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md`. |
| Clients that must work at DoD | claude.ai web, Claude mobile (iOS/Android), Claude Desktop, **Claude Code** (`claude mcp add --transport http`) | Same Anthropic auth infra for hosted surfaces; Claude Code is a native client with CIMD + loopback redirect (exercises a different AS code path). **Hosted surfaces can only reach a hostname with a public IPv4 A record** (Claude rejects private/loopback/CGNAT resolutions), so the claude.ai/mobile acceptance needs a public URL (tunnel with public DNS, or Heroku); Claude Code and MCP Inspector work against `http://localhost`. |

## 1. Product definition (frozen — do not relitigate during build)

**Goal:** one person (the owner) uses Claude — claude.ai web, Claude mobile, Claude Desktop, Claude Code — to read and write their **existing Obsidian vault**, which lives on their own machine. The server runs entirely in Docker on that machine; claude.ai reaches it through a **Cloudflare tunnel**. Installation and configuration must be trivial on Linux and Windows (macOS incidentally): `git clone`, `npm install`, `npm run setup`, `npm run up`.

Decisions taken 2026-08-28 (owner): single user only; owner authenticates with a generated secret kept in `.env` (no Google); **two tunnel modes** — a Cloudflare *named* tunnel when the owner has a `TUNNEL_TOKEN` (stable URL, recommended), otherwise a *quick* tunnel (random `*.trycloudflare.com` hostname per start, for trying it out); the vault is the real Obsidian folder, bind-mounted; **all server state lives inside the vault** (`_brainstem/`, a reserved folder) so a synced vault carries the state to any other machine; everything that runs, runs in Docker; the CLI is TypeScript (cross-platform), not bash, and not a web UI.

**Non-goals (deferred — see §10):** multi-tenancy, tenant isolation suites, per-tenant rate limits, audit table, `/account` page · Google as identity provider, encrypted refresh-token storage, re-auth handling · Google Drive adapter · Postgres, SQLite (a SQLite file must never live in a synced folder — WAL/SHM sidecars and mid-transaction copies corrupt it; if a large machine-local cache ever needs SQLite it goes outside the vault) · Dynamic Client Registration · Heroku · Tailscale Funnel / ngrok as alternative exposure modes (a third `TUNNEL_MODE` would be additive).

The code keeps the seams that make these additions instead of rewrites: `StorageAdapter`, `RuntimeResolver(ctx)`, a `TokenStore` interface, and an AS whose only user-specific piece is `OwnerAuth`. Full detail: `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md` §1–2.

## 2. Tech stack

- **Runtime:** Node 24.x, TypeScript strict mode, ESM. Build with `tsc` for production (native type-stripping only for scripts).
- **MCP:** `@modelcontextprotocol/server` 2.0.0 (`createMcpHandler(factory)`, `registerTool` config-object API, `ctx` handler context) + `@modelcontextprotocol/express` + `@modelcontextprotocol/node`. Streamable HTTP mounted at **`/mcp`** on Express 5.2.x.
- **Google:** `@googleapis/drive` (Drive v3; per-API package, currently v21.x) + `google-auth-library` (`OAuth2Client`, `verifyIdToken`).
- **Frontmatter:** `gray-matter` (or `yaml` + a 30-line splitter if gray-matter's YAML engine causes trouble — executor's call, one ADR line).
- **DB:** *(deferred with the multi-user path — see §10.)* There is no database in the single-user build: all state is one JSON file in the vault (`_brainstem/state.json`, spec §4.4). The v1.2 plan was Heroku Postgres essential-0 via `pg` + a thin query layer, pool max 5, `statement_timeout` 5 s.
- **Crypto:** AES-256-GCM for Google refresh tokens at rest, key from `ENCRYPTION_KEY` (32 bytes, base64). Plane A tokens stored as SHA-256 hashes only.
- **Tests:** Vitest 4. Tenant-isolation, auth-bypass, audience-validation and CIMD-SSRF suites are release-blocking.
- **Lint/format:** Biome (single binary, replaces eslint+prettier) — ESLint is acceptable if the executor wants type-aware rules; pick one in Phase 0, ADR line.
- **Logging:** pino, JSON, no PII/secrets/note content.
- **CI:** GitHub Actions — typecheck, lint, tests, `npm audit --omit=dev` (fail on high/critical), Dependabot enabled.

## 3. Repository structure

The tree below is the **v1.2 multi-tenant layout**, kept for the deferred path (§10). The single-user build ships without `auth/google/`, `tenancy/`, `audit/`, `db/`, `Procfile` and `app.json`; what it does have is `src/{auth/{as,rs,store},cli,storage,tools,tunnel,vault}` plus `compose.yaml` and `tunnel/`.

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
    audit/                 # DEFERRED (§10) — no audit table in the single-user build
      audit.ts             # Postgres audit_events writer (mutations always, reads optional)
    db/                    # DEFERRED (§10) — no database in the single-user build
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

Superseded 2026-08-28 by the single-user redesign: the server is now solely an OAuth 2.1 Authorization Server + Resource Server towards Claude, gated by an owner secret instead of a second OAuth plane to Google — there is no Plane B in this scope, and no Postgres-backed account/data model. Full component-level detail (resource server, authorization server, owner authentication, token store, request context, config, tunnel modes, `_brainstem/` state layout, CLI) lives in `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md` §4 (Components); the kept-vs-cut security posture (what carries over from this section unchanged, e.g. PKCE S256, CIMD + SSRF guard, refresh rotation, consent CSRF binding, `iss`, and what is cut because there is only one user, e.g. tenant isolation, audit table, Plane B) is in its §7 (Security). The two-plane (Claude + Google) design this section originally described — Plane A/B split, account model, Postgres schema — is not reproduced here; resume its full detail from plan v1.2 in git history (§10 keeps the old Phase 2/3/4 milestone text verbatim as a starting point) if the multi-user goal comes back.

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

**Phase 2′ — Single-user auth (owner secret) + CLI + tunnel (~3 d; spec: `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md`):** reserved `_brainstem/` prefix in the path policy; owner-secret AS+RS (metadata, CIMD fetcher + SSRF guard, consent page with global lockout, authorize/token/revoke, refresh rotation); `FileTokenStore` (hashed OAuth state as JSON in the vault); Cloudflare tunnel image + TypeScript supervisor (named/quick modes, URL file, app self-restart on URL change); `_brainstem/connection.md` + `instance.json`; cross-platform TypeScript CLI (`setup`/`up`/`url`/`status`/`down`/`logs`/`revoke-all`/`secret`). Detailed plan: `docs/plans/2026-08-28-phase-2-single-user-auth-cli.md` (16 tasks).
*Status:* **complete 2026-08-29** — all 16 tasks merged plus the final-review fix wave, 301 automated tests passing. Only the owner-run acceptance items remain open; see the "Acceptance log" at the bottom of the detailed plan.
*Accept (automated, done):* `owner`, `file-store`, `cimd`, `oauth-authorize`, `oauth-token`, `oauth-rs`, `context`, `verifier` suites green; an end-to-end OAuth flow via the official MCP SDK client (`tests/auth/e2e.test.ts`) completes against `createApp` and calls `vault_list`; Docker smoke (`scripts/docker-smoke.sh`) passes, including the unauthenticated-401 gate and the `_brainstem/connection.md` write; a quick tunnel came up live with a real `trycloudflare.com` URL answering `/health`.
*Accept (owner-run, pending):* Claude Code and claude.ai web/mobile connect through a real tunnel URL (CIMD + loopback, secret typed once) and a note written from Claude appears in Obsidian; `docker compose restart tunnel` rotates the quick-tunnel URL and the app reconnects cleanly with `connection.md` updated; a real Cloudflare named-tunnel token keeps a stable URL and valid tokens across restarts; a Windows run of `setup`/`up` with the polling watcher confirmed by editing a note in Obsidian and reading it through Claude.

**Phase 3′ — Hardening + README polish (0.5 d):** walk the §8 checklist items still relevant at single-user scope (limits, error taxonomy, no secrets/tokens/note-content in logs); finish this README and ADR 0005 (this document, Task 16); close out the "owner-run, pending" acceptance items above with dates in the Acceptance log.
*Accept:* every "owner-run, pending" item above checked off with a date; README, ADR 0005 and this plan v2.0 merged.

Phase 2 (multi-user auth) and Phase 3 (GoogleDriveAdapter) as originally scoped, plus the Phase 4 (hardening + onboarding) that depended on them, are deferred — kept verbatim below in §10 for the multi-user product path.

## 10. Deferred (do not build in v1 — reopen only with demonstrated need)

- **Team/shared vault** (reopens Drive scope decision — requires full `drive` scope or Workspace Internal app; would also motivate Enterprise Managed Authorization).
- GitHub adapter; Postgres/pgvector search layer; import tool for pre-existing notes; per-user daily-note templates UI.
- **Drive change notifications** via Google Workspace Events API (Drive events GA 2026-05-18; Pub/Sub required) → would make `Caps.watch = true` on Drive and replace the TTL re-scan.
- **MCP Apps** (interactive note/canvas preview inside Claude) — Claude supports the extension since 2026-01.
- **Tasks extension** — not needed; all tools complete in seconds.
- **Server card / MCP Registry** (`/.well-known/mcp/server.json`, SEP-2127 still draft) — cheap onboarding win once stable.
- Flipping SDK to `legacy: 'reject'` (2026-07-28-only) once all Claude surfaces negotiate the new revision.
- MCP roadmap items (DPoP-bound tokens, agent identity, Streamable-HTTP-over-stdio) — track, don't build.

### Deferred — multi-user product path (resume from plan v1.2 in git history if the goal changes)

The milestone text below is the v1.2 plan's §9 as written before the 2026-08-28 re-scope, kept verbatim so resuming this path doesn't mean re-deriving it. It assumes the full multi-tenant/Google/Drive/Postgres/Heroku design in the old §1/§7 (git history: `docs/implementation-plan.md` at the `v1.2` state, or the `9b94d13` commit) — not the single-user design above.

**Phase 2 — Auth (3.5d):** Plane A RS (PRM, 401 challenge, bearer verifier, audience), Plane A AS (metadata, CIMD fetcher + SSRF guard, DCR fallback, consent page with CSRF nonce, authorize, token with rotation, `/oauth/revoke`, `iss`), Plane B (Google IdP with the two-step prompt logic, encrypted token storage, reauth handling via Plane A family revocation), tenancy context/registry/rate limit, audit log.
*Accept:* full connect flow completes from **Claude Code and MCP Inspector against the local Docker Compose stack**, then from **claude.ai web and Claude mobile** against a public URL (tunnel with public DNS, or Heroku) — Claude Code exercises CIMD + loopback, hosted surfaces exercise CIMD-or-DCR; `oauth-as`, `oauth-rs`, `cimd-ssrf`, `transport`, `tenant-isolation` suites green; refresh rotation observed in logs after 1 h.

**Phase 3 — GoogleDriveAdapter (2.5d):** folder bootstrap, flat-listing path↔fileId map, all 20 tools green on Drive, appProperties, backoff, analytics caching.
*Accept:* end-to-end on claude.ai mobile + web: login with Google → write note → read/search it → visible as `.md` in the user's own Drive folder; 10 rapid appends to a daily note do not create pinned revisions.

**Phase 4 — Hardening + onboarding (1.5d):** limits, error taxonomy, result-size windowing, logging (pino, no PII/secrets), README + 5-line user onboarding doc (connector URL + 3 example prompts), minimal `/account` page (grants, revoke, delete account — old §7 account model), seed templates written to `00-inbox/README.md` on vault creation, §8 checklist walked item by item.
*Accept:* 2 real users (Vanea + 1 colleague) connected in production from phones; security checklist §8 fully checked.

## 11. Environment variables

Every key is created by `npm run setup` in `.env` (from `.env.example`); most are filled automatically, and `setup` prompts only for the vault path and the tunnel choice. Hand-editing `.env` is only needed to override a default.

| Var | Notes |
|---|---|
| `OWNER_SECRET` | Required. 32 random bytes, base64url — the password typed into the consent page. Generated by `setup`; show it with `npm run brainstem -- secret show`. |
| `VAULT_PATH` | Required. Absolute path to your Obsidian vault; bind-mounted into the container at `/vault`. |
| `TUNNEL_MODE` | `cloudflare` (stable URL, needs `TUNNEL_TOKEN` + `PUBLIC_URL`) \| `quick` (default; random URL each start) \| `none` (Claude Code / localhost only). |
| `TUNNEL_TOKEN` | Cloudflare named-tunnel token; required only in `cloudflare` mode. Never printed by the CLI. |
| `PUBLIC_URL` | The URL Claude connects to; pins the OAuth issuer, PRM `resource` and every advertised endpoint. Fixed hostname in `cloudflare` mode, `http://localhost:3000` in `none` mode; ignored in `quick` mode once `PUBLIC_URL_FILE` has content. |
| `PUBLIC_URL_FILE` | Path the quick-tunnel supervisor writes the current URL to (default `/vault/_brainstem/public-url`); takes precedence over `PUBLIC_URL` when set. |
| `ALLOW_INSECURE_PUBLIC_URL` | Allows a non-https `PUBLIC_URL` — only for `none` mode / localhost. |
| `VAULT_TIMEZONE` | IANA timezone used to resolve "today" for daily notes; `setup` fills it from the host. |
| `VAULT_WATCH_POLL_MS` | When set, chokidar polls the vault at this interval instead of native fs events — needed on Docker Desktop bind mounts (Windows/macOS), which don't propagate inotify; `setup` sets `2000` automatically on non-Linux hosts. |
| `DAILY_NOTES_FOLDER` | Folder daily notes are stored under (default: vault root). |
| `DAILY_NOTES_FORMAT` | `date-fns` format string for the daily-note filename (default `yyyy-MM-dd`). |
| `PORT` | Local port the app listens on, and that `up`/`url`/`status` poll (default `3000`). |
| `LOG_LEVEL` | pino log level (default `info`). |
| `MCP_LEGACY_MODE` | `stateless` (default; also serves 2025-era MCP clients) \| `reject`. |
| `CIMD_ALLOWED_HOSTS` | Allow-listed hostnames for Client ID Metadata Document discovery (default `claude.ai,claude.com`). |
| `ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_S` | OAuth token lifetimes in seconds (defaults `3600` / `7776000` — 90 days). |
| `HOST_UID` / `HOST_GID` | Linux only. The container runs as this uid:gid so files it writes in the vault are owned by you, not root; `setup` fills these from the current user on Linux. |

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
3. **CIMD selection by Claude is behavioral** (needs both metadata flags — confirmed verbatim in the connector docs on 2026-08-28); the design offers CIMD only (no `registration_endpoint`, no DCR fallback — §4.2 of the tunnel-design spec). Verified in Phase 2′ via `cimd.test.ts` and the end-to-end OAuth test against the SDK client; still pending a live claude.ai/Claude-mobile connection (owner-run acceptance item).
   **Build-vs-delegate was re-checked on 2026-08-28** (`docs/reviews/2026-08-28-auth-consistency-review.md`): SDK v2 dropped its authorization-server helpers (only the RS half remains), hosted IdPs with CIMD + a Google token vault (WorkOS AuthKit+Pipes, Scalekit, Descope) all require an external SaaS even for local dev and move the user's Drive token to a vendor, and the self-hosted Better Auth MCP plugin pins `legacy: 'reject'` and leaves Google-token custody unverified. Decision: keep the self-built AS.
4. **Quick tunnel URL rotation:** in `TUNNEL_MODE=quick`, the `*.trycloudflare.com` hostname changes on every restart (reboot, `docker compose restart`, crash), which invalidates the OAuth issuer for tokens issued under the old URL — Claude gets a 401 and the connector must be removed and re-added, since the URL is part of the connector's identity. Mitigation: the app watches `PUBLIC_URL_FILE` and restarts itself the moment the URL changes (rather than silently serving a stale issuer), `_brainstem/connection.md` always carries the current URL and reconnect steps into the (synced) vault, and `TUNNEL_MODE=cloudflare` with a real `TUNNEL_TOKEN` — the recommended default — makes the URL permanent.
5. **Docker Desktop bind mounts do not propagate inotify** (Windows, macOS): chokidar's native filesystem events don't fire for edits made through a Docker Desktop bind mount, so notes edited directly in Obsidian would not be picked up by the live watch/index without a fix. Mitigation: `VAULT_WATCH_POLL_MS` switches chokidar to polling; `npm run setup` sets it to `2000` automatically on non-Linux hosts; the Windows acceptance item (§9) explicitly re-verifies this by editing a note in Obsidian and reading it back through Claude.
6. **Google `drive.file`** hides files the app didn't create — accepted product limitation (§4), relevant only if the deferred Drive adapter (§10) is resumed.
7. Timeline ~11 dev-days assumed one executor and no scope creep; Phase 2′ replaced the original (multi-user) Phase 2 as the long pole and closed at ~3 days per the tunnel-design spec's estimate.
