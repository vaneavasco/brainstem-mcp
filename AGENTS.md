# AGENTS.md — working on brainstem-mcp

Guide for coding agents (Cursor, Copilot, Codex, Claude Code via `CLAUDE.md`, …) and the humans driving them. Read this before touching code.

## What this is

A **single-user, self-hosted MCP server** that gives Claude read/write access to the owner's Obsidian vault. Node 24 + Express 5 + the official MCP TypeScript SDK 2.0, packaged as two Docker images (app, Cloudflare tunnel) and a TypeScript CLI (`./brainstem …`). It is also its own **OAuth 2.1 authorization server** (owner secret + consent page, PKCE, Client ID Metadata Documents, refresh rotation). Everything the **HTTP server** persists lives as hashed JSON under `<vault>/_brainstem/`. The **stdio server** (ADR 0008) splits this: `_brainstem/instructions.md` is vault content and still travels with the vault, but its own working state — the `vault_transaction` journal (`src/storage/local-state.ts`, `BRAINSTEM_STATE_HOME`) and the machine-local frontmatter-index cache (`src/storage/local-cache.ts`, `BRAINSTEM_CACHE_HOME`, a *hint, never a source* — validated per entry against the current listing, safe to delete) — lives in a machine-local folder outside the vault, because a vault may be in git or synced between machines where that state would be the wrong thing to carry along.

Binding documents, in order of authority:
1. `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md` (core) and `docs/superpowers/specs/2026-08-30-phase-4-vault-graph-and-safety-design.md` (vault graph, safe concurrent writes) — the design specs.
2. `docs/adr/` — decisions (0005 = single-user re-scope; 0006 = vault graph + optimistic concurrency; 0007 = tool contract + index reconcile; 0008 = local stdio server + Claude Desktop bundle, in progress; Heroku/Postgres/multi-tenant are **dropped**, not pending).
3. `docs/implementation-plan.md` + `docs/plans/` — phase plans; `docs/reviews/` — adversarial reviews with the open "fix-later" lists.
4. `README.md` — user-facing behaviour; `SECURITY.md`, `CHANGELOG.md`.

## Layout

```
src/app.ts            Express app: /mcp (bearer-gated), /health, auth mount
src/main.ts           boot order: tunnel URL → config → vault runtime → token store → server → notes
src/stdio-main.ts     local (stdio) entrypoint: loadVaultConfig → deferred-index runtime → serveStdio,
                      the same createVaultServer factory main.ts uses; no auth, no HTTP, no tunnel
src/auth/as/          authorization server: metadata, cimd (+net SSRF guard), authorize/consent, token
src/auth/rs/          resource server: bearer token verifier
src/auth/store/       FileTokenStore (JSON, atomic writes, mtime reload)
src/auth/mount.ts     rate limiters, bearer gate, router mounting
src/mcp/factory.ts    McpServer per request; instructions; brainstem_ping, brainstem_guide
src/tools/            the 30 vault_* tools (read/write/search/manage/daily/canvas/analytics/graph/query/tx/template)
src/storage/          LocalFSAdapter, path policy (reserved `_brainstem/`), frontmatter, limits, write-gate, transaction,
                      local-state (stdio's machine-local state folder), local-peers (instances/<pid>.json, localPeers),
                      local-cache (stdio's machine-local frontmatter-index cache)
src/vault/            runtime, frontmatter index, note-parse, graph, link-rewrite, query, sections, templates,
                      daily notes, canvas, connection note, instructions
src/tunnel/           cloudflared supervisor (quick + named modes), public-url file
src/cli/              commander CLI; one file per command in commands/, deps injected
src/vault/safe-regex.ts  the linear-time engine both vault_query's `regex` op and vault_search's
                      JS fallback build on (compileSafeSearch: unanchored, a required-literal
                      prefilter, cannotMatch) — see the module's own doc comment for the syntax
tests/                mirrors src/; tests/tools/harness.ts boots a real server + MCP client
scripts/              docker-smoke.sh, mcp-call.ts (headless OAuth + tool calls),
                      bundle-build.ts/bundle-manifest.ts/bundle-icon.ts/bundle-pack.ts (the
                      Claude Desktop .mcpb — esbuild bundle, generated manifest, packed release)
bundle/, release/     gitignored output of `npm run bundle`: bundle/ is the unpacked extension
                      (dist/stdio-main.js + manifest.json + icon + LICENSE/README excerpt),
                      release/ the packed .mcpb files and SHA256SUMS
```

## Commands

```bash
npm ci                      # dev install (the ./brainstem launcher installs runtime-only)
npm test                    # vitest; 10 ripgrep-only tests skip when `rg` is not installed (regex-result tests run either way, against the builtin engine)
npm run test:scale          # 40,000-note run: memory, build time, bounded results (about a minute)
npm run typecheck           # tsc --noEmit
npm run lint                # biome check .   (npm run lint:fix to apply)
npm run dev                 # server without Docker, reads .env
npm run stdio -- --vault <path>  # local stdio server without Docker, a tunnel or OAuth
npm run docker:smoke        # end-to-end against the Docker image (needs Docker)
npm run mcp:call -- --list  # authenticate headlessly and call tools on a running instance
npm run bundle:build        # esbuild src/stdio-main.ts -> bundle/dist/stdio-main.js (one file)
npm run bundle:manifest     # generate bundle/manifest.json + icon.png from package.json + the tool registry
npm run bundle              # build + manifest + LICENSE/README + `mcpb validate`/`pack` -> release/*.mcpb, SHA256SUMS
npm run test:bundle         # bundle:build + tests/stdio/** run against the BUNDLED file (vitest.bundle.config.ts)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, the 40,000-note scale run, `npm audit --omit=dev --audit-level=moderate`, build, the Docker smoke, the Claude Desktop bundle (build + `test:bundle`, uploaded as an artifact, attested and attached to the release on a tag), then publishes images. A change is not done until CI is green.

## Conventions that will bite you

- **TypeScript runs natively on Node 24** — no build step in dev. `erasableSyntaxOnly` means **no enums, no parameter properties, no namespaces**. Relative imports carry the `.ts` extension. `verbatimModuleSyntax`: use `import type` for types.
- **Biome** formats and lints: 2 spaces, single quotes, semicolons, trailing commas, 100 columns. Run `npm run lint:fix` before committing.
- **Zod 4**, **Vitest 4**, **Express 5** (async handlers are fine), MCP SDK 2.0 packages are `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.
- **TDD is the working style**: write the failing test first, then the code. Tests exercise real behaviour (temp dirs, real HTTP, real MCP client); external processes and the clock are injected through a `deps` object rather than mocked globally. Every `src/cli/commands/*.ts` exports `runX(args, deps)` for that reason.
- **`src/cli/catalog.ts` is the single source of truth for CLI commands**: `--help`, the README command tables and `tests/cli/{catalog,readme}.test.ts` are derived from or checked against it. Add a command there first.
- **Never print, log or commit secrets**: `OWNER_SECRET`, `TUNNEL_TOKEN`, tokens. `.env` is git-ignored on purpose; `*dev-tokens*.json` too.
- **Changing `IndexEntry`'s shape, or how `FrontmatterIndex.fromNote` derives it, means bumping `INDEX_CACHE_SCHEMA`** (next to `IndexEntry` in `src/vault/frontmatter-index.ts`) in the same change — the machine-local index cache (`src/storage/local-cache.ts`) embeds that number in its file name and header, and rejects (deletes, cold-fills) a cache written under any other number. `tests/vault/frontmatter-index.test.ts` snapshots the sorted key list alongside the schema number and fails if they drift apart without a bump.
- **Tests run on Linux, macOS and Windows** (`platforms` in `.github/workflows/ci.yml`, gating every published image and bundle) — a test that only passes on the machine that wrote it shows up there, not here. Concretely:
  - Never hand-write a POSIX absolute path (`/home/u/...`) as a test fixture or expectation; build it with `path.join`/`path.resolve` (or `node:path/posix`/`node:path/win32` directly when the code under test takes an injected `platform` and the test needs to hold it fixed regardless of the machine actually running it) so the same test means the same thing everywhere.
  - Signals are not portable: `SIGTERM` terminates a Windows process at once instead of asking it to stop. Gate a signal-only test with `process.platform === 'win32'` (`it.skipIf`) and say in a comment that the graceful-stop coverage lives in the stdin-close variant next to it instead.
  - File permission bits (`0600`, `0700`, …) don't exist on Windows the way POSIX modes do; skip that one assertion there (`if (process.platform !== 'win32') expect(...)`), not the whole test.
  - Build an `import()` specifier for a path with `pathToFileURL(...).href` (`node:url`), never a bare string — an absolute Windows path is not a valid `file://` URL on its own.
  - A file watcher's own startup is asynchronous: a fixed sleep to "let it finish scanning" is a race a loaded CI runner can lose (and, on GitHub Actions' macOS runners specifically, the native backend may not deliver events at all — confirmed by a canary that never round-trips even after retrying, while the same test with `usePolling: true` does; that is polling-vs-native, not a bug in this server's own path computation). Wait for a real signal of readiness (a canary write-and-observe, retried) instead, and put `unsubscribe()`/`close()` in a `finally` — an assertion (or a bounded wait simply finding nothing) throwing before cleanup ran once left a live watch handle open for the rest of a CI job, which hung it for six hours until GitHub's own ceiling killed it.
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
- `vault_transaction`'s journal lives under `<stateDir>/tx/<txId>/`: `_brainstem/tx/` (reserved, invisible to every tool) on the HTTP server, the machine-local state folder for stdio (`src/storage/local-state.ts`; never inside the vault). Every byte crossing the journal↔vault boundary moves with `fs.copyFile`, never `fs.rename` (the two can now be on different filesystems — `rename` fails `EXDEV` across devices); a `rename` only ever happens between two paths in the *same* directory (the manifest's own tmp+rename). Pre-image files are write-once (`COPYFILE_EXCL` — never overwritten); `manifest.json`'s `state` (`applying` → `applied`/`rolled-back`) only ever flips via a fresh tmp+rename, never an in-place edit, so a crash mid-write is never mistaken for a committed or reverted transaction. The journal is removed only after that state flip succeeds; a leftover one is a signal for the owner, not something to auto-replay.

## Out of scope (decided, not forgotten)

Multi-tenancy, Google sign-in, Google Drive storage, Postgres, SQLite inside the vault, Dynamic Client Registration, Heroku, a web UI for setup. See ADR 0005 and the spec's "Deferred" section before proposing any of them.

## Releasing

Nothing bumps the version for you. Images are published for every commit on main as `sha-<7>`, so a change can be merged and deployed without a release, and the server then goes on reporting the last released version (it did, across four pull requests that changed the tool surface). **A pull request that adds, removes or changes a tool, an argument or an output field is a release.** The steps, in one `chore(release): vX.Y.Z` commit on the PR's branch:

1. `npm version X.Y.Z --no-git-tag-version` (package.json and package-lock.json).
2. `CHANGELOG.md`: a `## [X.Y.Z] — YYYY-MM-DD` heading under `## [Unreleased]`, and its compare link at the bottom.
3. `README.md`: the `**vX.Y.Z — beta.**` line.
4. After the merge: `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z` (CI then publishes `vX.Y.Z` and `latest`, and fails if the tag disagrees with package.json), and `gh release create vX.Y.Z` with the changelog section as notes.

`tests/release/version-consistency.test.ts` fails on a half-made release. A running server reports `X.Y.Z+<commit>` (`brainstem_ping`, `/health`), so what is deployed can always be told from what is released.

## When you finish

`npm run lint:fix && npm run typecheck && npm test`, update `CHANGELOG.md` under *Unreleased* for user-visible changes, keep `README.md` in step with behaviour, and record notable decisions in `docs/adr/` or the relevant plan.
