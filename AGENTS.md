# AGENTS.md — working on brainstem-mcp

Guide for coding agents (Cursor, Copilot, Codex, Claude Code via `CLAUDE.md`, …) and the humans driving them. Read this before touching code.

## What this is

A **single-user, self-hosted MCP server** that gives Claude read/write access to the owner's Obsidian vault. Node 24 + Express 5 + the official MCP TypeScript SDK 2.0, packaged as two Docker images (app, Cloudflare tunnel) and a TypeScript CLI (`./brainstem …`). It is also its own **OAuth 2.1 authorization server** (owner secret + consent page, PKCE, Client ID Metadata Documents, refresh rotation). Everything the server persists lives as hashed JSON under `<vault>/_brainstem/`.

Binding documents, in order of authority:
1. `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md` (core) and `docs/superpowers/specs/2026-08-30-phase-4-vault-graph-and-safety-design.md` (vault graph, safe concurrent writes) — the design specs.
2. `docs/adr/` — decisions (0005 = single-user re-scope; 0006 = vault graph + optimistic concurrency; Heroku/Postgres/multi-tenant are **dropped**, not pending).
3. `docs/implementation-plan.md` + `docs/plans/` — phase plans; `docs/reviews/` — adversarial reviews with the open "fix-later" lists.
4. `README.md` — user-facing behaviour; `SECURITY.md`, `CHANGELOG.md`.

## Layout

```
src/app.ts            Express app: /mcp (bearer-gated), /health, auth mount
src/main.ts           boot order: tunnel URL → config → vault runtime → token store → server → notes
src/auth/as/          authorization server: metadata, cimd (+net SSRF guard), authorize/consent, token
src/auth/rs/          resource server: bearer token verifier
src/auth/store/       FileTokenStore (JSON, atomic writes, mtime reload)
src/auth/mount.ts     rate limiters, bearer gate, router mounting
src/mcp/factory.ts    McpServer per request; instructions; brainstem_ping
src/tools/            the 30 vault_* tools (read/write/search/manage/daily/canvas/analytics/graph/query/tx/template)
src/storage/          LocalFSAdapter, path policy (reserved `_brainstem/`), frontmatter, limits, write-gate, transaction
src/vault/            runtime, frontmatter index, note-parse, graph, link-rewrite, query, sections, templates,
                      daily notes, canvas, connection note, instructions
src/tunnel/           cloudflared supervisor (quick + named modes), public-url file
src/cli/              commander CLI; one file per command in commands/, deps injected
tests/                mirrors src/; tests/tools/harness.ts boots a real server + MCP client
scripts/              docker-smoke.sh, mcp-call.ts (headless OAuth + tool calls)
```

## Commands

```bash
npm ci                      # dev install (the ./brainstem launcher installs runtime-only)
npm test                    # vitest; 7 ripgrep tests skip when `rg` is not installed
npm run typecheck           # tsc --noEmit
npm run lint                # biome check .   (npm run lint:fix to apply)
npm run dev                 # server without Docker, reads .env
npm run docker:smoke        # end-to-end against the Docker image (needs Docker)
npm run mcp:call -- --list  # authenticate headlessly and call tools on a running instance
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, `npm audit --omit=dev --audit-level=high`, build, the Docker smoke, then publishes images. A change is not done until CI is green.

## Conventions that will bite you

- **TypeScript runs natively on Node 24** — no build step in dev. `erasableSyntaxOnly` means **no enums, no parameter properties, no namespaces**. Relative imports carry the `.ts` extension. `verbatimModuleSyntax`: use `import type` for types.
- **Biome** formats and lints: 2 spaces, single quotes, semicolons, trailing commas, 100 columns. Run `npm run lint:fix` before committing.
- **Zod 4**, **Vitest 4**, **Express 5** (async handlers are fine), MCP SDK 2.0 packages are `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.
- **TDD is the working style**: write the failing test first, then the code. Tests exercise real behaviour (temp dirs, real HTTP, real MCP client); external processes and the clock are injected through a `deps` object rather than mocked globally. Every `src/cli/commands/*.ts` exports `runX(args, deps)` for that reason.
- **`src/cli/catalog.ts` is the single source of truth for CLI commands**: `--help`, the README command tables and `tests/cli/{catalog,readme}.test.ts` are derived from or checked against it. Add a command there first.
- **Never print, log or commit secrets**: `OWNER_SECRET`, `TUNNEL_TOKEN`, tokens. `.env` is git-ignored on purpose; `*dev-tokens*.json` too.
- Conventional Commits (`feat(auth): …`, `fix(cli): …`, `docs: …`, `chore(release): …`).

## Security invariants — do not weaken without an adversarial review

- `_brainstem/` is reserved: every tool refuses to list, read, write or search it (`src/storage/path-policy.ts`).
- OAuth tokens are stored **only as SHA-256 hashes**; the store is safe to sync.
- No client is trusted silently: every new client passes the consent page, gated by the owner secret (constant-time compare, 5 failures ⇒ 15-minute lockout).
- Client ID Metadata Documents are fetched only from the allowlist (`CIMD_ALLOWED_HOSTS`, default `claude.ai,claude.com`) through the pinned, redirect-free, size- and time-capped fetch in `src/auth/as/net.ts`. Do not "simplify" it with plain `fetch`.
- `/mcp` order is fixed: unauthenticated limiter → bearer shape gate → main limiter → handler.
- Consent page: `Referrer-Policy: same-origin` (a `no-referrer` policy makes the form POST arrive with `Origin: null`) and a per-request CSP `form-action` that includes the client's redirect origin (Chrome enforces `form-action` on the post-submit redirect). Both were found by real-browser testing; keep them.
- `PUBLIC_URL_FILE` is honoured only in `TUNNEL_MODE=quick`.
- Optimistic concurrency: mutating tools accept `expectedHash`; a mismatch throws `VaultError('CONFLICT', …)` with the current hash rather than overwriting silently. All mutating calls for a path run inside `WriteGate.withLock` (`src/storage/write-gate.ts`), sorted-path locking so multi-path ops can't deadlock.
- `vault_transaction`'s journal lives under `_brainstem/tx/<txId>/` (reserved, invisible to every tool). Pre-image files are write-once (`COPYFILE_EXCL` — never overwritten); `manifest.json`'s `state` (`applying` → `applied`/`rolled-back`) only ever flips via a fresh tmp+rename, never an in-place edit, so a crash mid-write is never mistaken for a committed or reverted transaction. The journal is removed only after that state flip succeeds; a leftover one is a signal for the owner, not something to auto-replay.

## Out of scope (decided, not forgotten)

Multi-tenancy, Google sign-in, Google Drive storage, Postgres, SQLite inside the vault, Dynamic Client Registration, Heroku, a web UI for setup. See ADR 0005 and the spec's "Deferred" section before proposing any of them.

## When you finish

`npm run lint:fix && npm run typecheck && npm test`, update `CHANGELOG.md` under *Unreleased* for user-visible changes, keep `README.md` in step with behaviour, and record notable decisions in `docs/adr/` or the relevant plan.
