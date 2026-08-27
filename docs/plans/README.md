# Implementation plans

Spec: `../implementation-plan.md` (v1.1). Every plan follows the superpowers `writing-plans` format: bite-sized TDD tasks with the exact test and implementation code, one commit per task. Executed with `superpowers:subagent-driven-development` (fresh subagent per task + review) or `superpowers:executing-plans`.

**Rule:** a phase's detailed plan is written when the previous phase is green, because each phase pins down interfaces (adapter contract, runtime resolver, auth types) the next one codes against. Writing Phase 2–4 code now, against APIs not yet exercised, would produce placeholder-quality plans.

| Phase | Plan | Status | Notes |
|---|---|---|---|
| 0 — Scaffold | [2026-08-28-phase-0-scaffold.md](2026-08-28-phase-0-scaffold.md) | planned | 7 tasks. Express 5.2 + SDK 2.0.0, both protocol eras, Heroku + Postgres provisioned, CI, ADR 0001–0003. |
| 1 — Core tools on LocalFS | [2026-08-28-phase-1-core-tools-localfs.md](2026-08-28-phase-1-core-tools-localfs.md) | planned | 15 tasks. StorageAdapter contract, path policy, frontmatter (ADR 0004), LocalFSAdapter, index, daily notes (tz-aware), canvas, analytics, all 20 tools, env wiring. |
| 2 — Auth | *written at Phase 1 exit* | outline below | Longest phase (3.5 d). |
| 3 — GoogleDriveAdapter | *written at Phase 2 exit* | outline below | |
| 4 — Hardening + onboarding | *written at Phase 3 exit* | outline below | |

## Phase 2 — Auth (outline; spec §7, §8)

Interfaces this phase must honor from Phase 1: `RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>` (per-tenant runtime from `ctx.authInfo`), `createApp(config, logger, resolveRuntime)`, `AuthInfo` from the SDK (`clientId`, `scopes`, `expiresAt`, `resource`, `extra.userId`).

1. Postgres layer: `pg` pool (max 5), migrations runner, `schema.sql` for `users`, `google_tokens`, `vaults`, `oauth_clients`, `oauth_pending`, `oauth_codes`, `oauth_tokens`, `audit_events`; tests against `DATABASE_URL` (local Postgres via Docker or Heroku CI add-on).
2. `auth/crypto.ts`: AES-256-GCM seal/open with `ENCRYPTION_KEY`, SHA-256 token hashing, `randomToken()`; key never logged.
3. Resource server: `OAuthTokenVerifier` backed by `oauth_tokens` (hash lookup, expiry, **audience = mcpUrl**), `requireBearerAuth` on `/mcp`, `mcpAuthMetadataRouter` PRM (`resource`, `authorization_servers`, `scopes_supported: ['vault']`), 401 challenge shape test, token-passthrough test (Claude token never appears in outbound requests — assert via a mocked Google client).
4. AS metadata (`/.well-known/oauth-authorization-server`) built only from `PUBLIC_URL`, including `code_challenge_methods_supported: ['S256']`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `token_endpoint_auth_methods_supported: ['none']`.
5. CIMD fetcher: SSRF guard (DNS resolve → reject private/loopback/link-local/metadata ranges, HTTPS only, no cross-host redirects, 5 s timeout, 64 KB cap), `client_id` == URL, required fields, cache per HTTP headers, loopback redirect port-agnostic match (Claude Code). `cimd-ssrf.test.ts`.
6. DCR fallback (`/oauth/register`, JSON, public clients only, `application_type`, per-IP rate limit, 30-day expiry) behind `DCR_ENABLED`.
7. `/oauth/authorize`: validation (`response_type=code`, PKCE S256 required, `resource` == mcpUrl, `scope ⊆ {vault}`), `oauth_pending` row, **consent page** (client_name, redirect hostname, loopback warning) — no cookie shortcut.
8. Plane B: Google code flow (`openid email drive.file`, `access_type=offline`, `prompt=consent` only when no stored refresh token), `verifyIdToken`, encrypted refresh token storage, callback completes Plane A: mint code (≤60 s, single-use, bound to client/redirect/challenge/resource/user), redirect with `code`, `state`, `iss`.
9. `/oauth/token` (form-urlencoded only): code exchange with PKCE verification, access token 1 h + refresh 90 d; refresh **rotation** with family id, 60 s grace, reuse → family revocation, `invalid_grant` on dead tokens. No upstream calls.
10. Tenancy: `resolveRuntime` maps `authInfo.extra.userId` → cached `VaultRuntime` (byte-bounded LRU, concurrency-safe); per-tenant token-bucket rate limit; `tenant-isolation.test.ts` with concurrent A/B requests including cache poisoning attempts. Phase 2 still uses LocalFS per tenant (`VAULT_PATH/<userId>`) so isolation is provable before Drive exists.
11. Audit log writer (`audit_events`) wired into every mutating tool; reads behind `AUDIT_INCLUDE_READS`.
12. Google `invalid_grant` → `users.reauth_required`, tool error instructing reconnect.
13. End-to-end acceptance: connect from claude.ai web, Claude mobile and Claude Code against Heroku; refresh rotation observed after 1 h; all auth suites green.

## Phase 3 — GoogleDriveAdapter (outline; spec §4)

1. Drive client wrapper (`@googleapis/drive` + per-tenant `OAuth2Client` from the encrypted refresh token; access token cached ~55 min).
2. Vault bootstrap: find-or-create root folder by `VAULT_FOLDER_NAME`, persist folder id in `vaults.root_ref`, skeleton subfolders, `00-inbox/README.md` seed.
3. Path ↔ fileId map from one flat paginated `files.list` (`trashed=false`, fields incl. `parents`, `appProperties`), rebuilt on TTL/miss, patched on write/move/delete.
4. `read`/`batchRead` (`files.get` + `alt=media`), `write`/`writeBinary`/`append`/`edit` (`files.update` media upload, **no** `keepRevisionForever`), `appProperties` mirror of `type/domain/status`.
5. `list` from the map, `move` (`addParents/removeParents` + rename), `softDelete` to a `.trash` folder inside the vault root, `search` = `fullText contains` scoped to app files merged with index hits, `watch` absent (`Caps.watch=false`) → index TTL re-scan.
6. Truncated exponential backoff with jitter on 403/429; clean `VaultError('IO')` messages; quota-unit awareness in logs.
7. Contract test suite: the Phase 1 adapter tests re-run against a mocked Drive API (recorded fixtures) so both adapters satisfy the same `StorageAdapter` behavior; a manual live test against a real account.
8. `STORAGE_BACKEND=drive` default path in `main.ts`; Heroku config switched; end-to-end from Claude mobile: login → write → read/search → visible as `.md` in Drive.

## Phase 4 — Hardening + onboarding (outline; spec §8, §9)

1. Walk every §8 checklist item with a named test or a documented manual check.
2. Error taxonomy review across tools (codes, actionable texts, no leakage), result windowing for large notes.
3. pino production settings, request ids, no PII/secrets/note content (grep-based test on log output).
4. README + 5-line onboarding doc (connector URL, "Connect", 3 example prompts), Google consent-screen production checklist.
5. `npm audit` gate verified, Dependabot config, SDK bump policy documented.
6. Two real users connected from phones; retro notes → open the Phase 2+ deferred list (§10) only if a demonstrated need appears.
