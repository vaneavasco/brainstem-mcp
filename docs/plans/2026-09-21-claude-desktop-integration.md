# Claude Desktop integration: a local (stdio) server and an installable bundle

Date: 2026-09-21 · Status: in progress on `feat/desktop-integration` · Decision record: ADR 0008

## Why

The server reaches Claude in one way today: HTTP behind a Cloudflare tunnel, with its own OAuth. That is the right shape for a vault several people reach from claude.ai, and the wrong one for the owner on their own machine. In one day of use the quick tunnel died twice (the hostname lost its DNS record; every client had to be re-created with a new URL), and a connector kept serving a stale tool list for hours after a release. None of that exists for a process the client starts itself and talks to over stdin/stdout.

So a **second way in**, not a replacement:

| | HTTP + tunnel (today) | stdio (this project) |
|---|---|---|
| Who starts it | Docker, always on | the client, per session |
| Reaches | claude.ai (web, mobile), any machine, several people | Claude Code and Claude Desktop on that machine |
| Auth | OAuth 2.1, owner secret, consent page | none: the process runs as the OS user who owns the files |
| Breaks when | the tunnel dies, the URL changes, a proxy caches the tool list | never for those reasons |

The core (`src/tools`, `src/vault`, `src/storage`) does not know about HTTP. The SDK ships `serveStdio(factory)`, which takes the same server factory `createMcpHandler` does. What is missing is an entrypoint, a boot that does not make the client wait, a packaging step, and proof on three operating systems.

## Facts established (2026-09-21)

- MCP Bundles (`.mcpb`): a zip with `manifest.json` (`manifest_version` "0.3"), `server.type` one of `node | python | binary | uv`, `server.entry_point`, `server.mcp_config { command, args, env }` with `${__dirname}`, `${user_config.KEY}`, `${HOME}` substitution; `user_config` fields of type `string | number | boolean | directory | file` (`required`, `default`, `sensitive`, `multiple`); `compatibility { claude_desktop, platforms: darwin | win32 | linux, runtimes: { node } }`. A Node bundle carries its production `node_modules`. CLI: `mcpb init | validate | pack | sign`.
- "Node.js ships with Claude for macOS and Windows"; **which version is not stated anywhere**. We build for ES2024 and run on Node 24 in Docker. Phase 0 measures it.
- The owner's machine is Linux, where there is no official Claude Desktop: there the stdio server is used from Claude Code (`claude mcp add brainstem -- ./brainstem stdio`). The bundle is for people on macOS and Windows.
- Index build on a 37,000-note vault: about 27 s and 250 MB of heap; on a 3,400-note vault a few seconds. A client that starts the server per session cannot wait 27 s for `initialize`.

## Decisions already taken (with the owner, 2026-09-21; see ADR 0008)

1. **Variant A: a standalone stdio server** that opens the vault itself. Not a stdio bridge to the running HTTP server: that would need a local trust path in `src/auth/`, which is a security change with its own plan and review.
2. **No authentication on stdio.** Whoever can start a process as the owner can already read the files. The path policy, the reserved `_brainstem/` folder, size limits, optimistic concurrency and the write gate all still apply: they protect the vault from the model, not from the user.
3. **The boot answers at once and builds the index in the background.** Tools that need the index wait for it, briefly, and otherwise say how far it is. No tool ever answers from a half-built index.
4. **An index cache, when it comes, is machine-local, never in the vault** (a vault may be in git or synced across machines): `CACHE_DIR` → OS cache dir; NDJSON, one entry per line, validated per entry against the local listing (size + mtime); written on clean shutdown and at most hourly. SQLite stays out of the vault (ADR 0005); inside the cache dir it remains a candidate, not a plan.
5. One server per vault is the design. Two processes on one vault (the Docker server and a stdio session) are tolerated for reads; for writes `expectedHash` catches collisions, and each process heals its index through the watcher and reconcile.

## Phases

Each phase is shippable on its own and ends with `lint`, `typecheck`, `npm test`, the scale run, an adversarial review repeated until a round finds nothing above low, and a release (a new entrypoint or tool behaviour is a release: AGENTS.md).

### Phase 0 — measure what we do not know (no product code)

- A five-line throwaway bundle that prints `process.version`, `process.platform`, `process.arch` to stderr and answers `initialize`: installed once on macOS and once on Windows by whoever has them. **Output: the minimum Node we must run on.**
- `npm run build` output run under that Node version (nvm) against the unit tests that do not need Docker: list every API that is missing (candidates seen in the tree: `import.meta.dirname` in the CLI).
- Decide the floor: if Desktop's Node is ≥ 22, nothing to do; if it is 20, the build target and a handful of call sites change, behind a CI job pinned to that version.

### Phase 1 — the stdio entrypoint (`./brainstem stdio`)

- `src/stdio-main.ts`: `serveStdio((ctx) => createVaultServer(ctx, deps))`, the same factory the HTTP server uses, so both ways in expose the same 32 tools by construction.
- Configuration without HTTP: a `loadVaultConfig(env)` carved out of `loadConfig` (vault path, daily notes, required frontmatter, timezone, watch polling, binary cap, reconcile interval, log level). `OWNER_SECRET`, `PUBLIC_URL`, tunnel settings are not read and not required. `--vault <path>` overrides `VAULT_PATH`.
- **stdout carries the protocol and nothing else.** The logger writes to stderr; the launcher already prints its own messages to stderr; a test asserts that every line on stdout parses as JSON-RPC.
- `src/cli/catalog.ts` gets the command first (the README table and its tests derive from it). `brainstem.cmd` gets the same.
- Lifecycle: stdin closing, SIGTERM and SIGINT close the runtime (watcher, reconcile timer) and exit 0; an unusable vault path exits 1 with one line on stderr before any protocol byte.
- Tests, with a real child process and the SDK's stdio client: tool list identical to the HTTP harness (names, input and output schemas, annotations); read, write with `expectedHash`, conflict; stdout purity; clean exit on stdin close; refusal of a missing vault.

### Phase 2 — a boot that does not make the client wait

- `FrontmatterIndex`: `empty()` + `fill(adapter, onProgress)`; `build()` stays as the two together. `createLocalRuntime({ deferIndex: true })` returns at once with `indexState(): { ready, done, total }` and `indexReady: Promise<void>`.
- The watcher and the reconcile timer start **after** the fill (an event handled mid-fill could be overwritten by the fill's older read), followed by one reconcile pass to catch what changed during it.
- One gate where tools are registered, not thirty edits: every vault tool waits for `indexReady` up to `INDEX_WAIT_MS` (20 s), then runs; if the index is still building it answers an error that says so, with `done` of `total`, and nothing else. Exempt, because they do not read the index: `brainstem_ping` (which reports the state), `brainstem_guide`, `vault_read`, `vault_daily_note_read`, `vault_daily_note_path`, `vault_canvas_read`. Writes wait like everything else.
- The HTTP server keeps its blocking boot in this phase (its health check means "ready to answer anything"); moving it over is a separate, small decision once stdio has shown the gate works.
- Tests, with an adapter whose reads are slowed by injection: `initialize` and `tools/list` answer in under a second; `ping` says building and counts; `vault_read` works; `vault_query` waits and then answers the full count; with a tiny wait the error names the progress; a write is not applied before the index is ready; after the fill a change made during it is visible.

### Phase 3 — two processes on one vault, stated honestly

- stdio keeps its transaction journal and (later) its cache in a machine-local state dir keyed by the vault's real path, not in `<vault>/_brainstem/` (`STATE_DIR` exists); the HTTP server keeps the vault-local state it has (tokens must travel with the vault).
- README and `brainstem_ping`: "one server per vault" and what happens with two. A boot line on stderr when another brainstem process holds the same machine-local state dir.
- A cross-process write lock is **not** in this project: `expectedHash` already turns a collision into a CONFLICT instead of a lost write. Revisit with evidence.

### Phase 4 — the machine-local index cache

As decided (point 4 above). Only after phases 1–2 are in use: it matters for a 37,000-note vault started per session and not at all for a small one. Acceptance: second start on the large vault under 3 s, identical query results with and without the cache, a cache from another vault or schema is discarded, permissions 0700/0600.

### Phase 5 — the bundle

- `manifest.json` (0.3): `server.type: node`, `entry_point: dist/stdio-main.js`, `mcp_config.args: ["${__dirname}/dist/stdio-main.js", "--vault", "${user_config.vault}"]`; `user_config.vault` of type `directory`, required; optional timezone and daily-notes folder; `compatibility.platforms: darwin, win32, linux`, `runtimes.node` from phase 0; `tools_generated: false` with the tool list generated from the registry so it cannot drift.
- Contents: `dist/`, production `node_modules`, `package.json`, the licence. ripgrep is **not** bundled at first: search already falls back to a JavaScript scan; a per-platform binary is a later, measured decision.
- `npm run bundle` = build + `npm ci --omit=dev` in a staging dir + `mcpb validate` + `mcpb pack`. CI builds it on every tag and attaches `brainstem-mcp-X.Y.Z.mcpb` to the GitHub release; `tests/release/version-consistency.test.ts` also checks `manifest.json`.
- Signing (`mcpb sign`) is an open question below.

### Phase 6 — three operating systems

- CI matrix `ubuntu | macos | windows` for unit tests (Docker smoke stays on Linux). Expected trouble, to be found by tests rather than by users: backslashes reaching the path policy, case-insensitive file systems (two notes that differ only by case; near-miss suggestions), atomic rename over an open file on Windows, watcher behaviour (FSEvents, ReadDirectoryChangesW), `\r\n` in notes, long paths.
- Nothing in the security invariants may weaken to make a platform pass; a platform that cannot hold one is listed as unsupported.

### Phase 7 — proof with readers

The five costliest prompts of the reader test, run through stdio in Claude Code on the large vault and compared with the HTTP runs (calls, characters, errors), then one session by a person on macOS or Windows with the installed bundle. Findings are fixed or listed.

## Out of scope

A stdio bridge to the HTTP server; any change under `src/auth/`; SQLite; multi-user; a setup UI; bundling a Node runtime of our own.

## Open questions for the owner

1. Who, besides the owner, will install the bundle, and on which systems? (Decides how much of phase 6 is needed before phase 5 ships.)
2. Signing: ship unsigned at first (Desktop warns on install), or set up a signing key now?
3. After phase 2, should the HTTP server also boot in the background (no 27 s gap at every deploy), with `/health` reporting "building"?

## Order and releases

Phase 0 runs beside phase 1. **0.5.0** = phases 1 + 2 (usable at once from Claude Code on Linux). **0.6.0** = phases 3 + 4. **0.7.0** = phases 5 + 6, with the bundle on the release page. Phase 7 gates 0.7.0.
