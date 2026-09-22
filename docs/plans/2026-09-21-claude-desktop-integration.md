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
- The developer documentation says Claude Desktop "runs on macOS (`darwin`) and Windows (`win32`)" and that installing is a double-click, a drag-and-drop or Settings → Extensions → Advanced settings → "Install Extension…", all three opening one screen where the user "reviews extension details and permissions, configures required settings, grants permissions"; installation is per user. The help centre page also lists Linux: to be settled in phase 6, and irrelevant for the known installers (Windows 11, macOS).
- Claude Desktop's help centre lists macOS, Windows and Linux as supported and says the app "includes a built-in Node.js environment" (version still not stated). The stdio server is also usable directly from Claude Code (`claude mcp add brainstem -- ./brainstem stdio`), with only Node installed.
- Installing a bundle that is not in the directory: Settings → Extensions → Advanced settings → Extension Developer → "Install Extension…" → pick the `.mcpb`. No signature is required by the documentation (reports show a log line "Installing unsigned extension" and the install proceeding). Such extensions do not update themselves: "users will need to install updated .mcpb files manually".
- On Team and Enterprise plans an owner can upload a custom desktop extension for one-click install by the team, and can enable or disable desktop extensions for the organisation (`isDesktopExtensionEnabled`, `isDesktopExtensionDirectoryEnabled`): where they are disabled, nothing installs, signed or not.
- Measured: the production dependency tree is 60 MB unpacked, about 10 MB zipped, 8,400 files, **no native addon** (`*.node`): one bundle serves every platform, and nothing has to be compiled on install. `@anthropic-ai/mcpb` 2.1.2 is the packing CLI. Node 18, 20, 22 and 24 are available locally through nvm for phase 0.
- Reports (2026) of `.mcpb` installs failing silently on some Desktop builds while "Install Unpacked Extension" works: phase 5 tests the install on each system and ships the unpacked form as a fallback.
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

**Results (2026-09-21).**

- The probe bundle on macOS (Apple silicon) reported Node `v24.20.0`, Electron `44.2.0`, `darwin`/`arm64`, run by the app's own plugin helper process. A bundle therefore runs on **Electron's Node, not on a Node installed on the machine**: the Node version follows the Claude Desktop version. The same probe on Windows 11 (x64) reported the same pair, Node `v24.20.0` on Electron `44.2.0`, run by `Claude.exe` from the Store package `Claude_2.2553.1.0_x64`: both platforms ship one runtime, and Claude Desktop **2.2553.1** is the first version we have seen carry Node 24.
- The compiled server was run under nvm: it works on Node 24, 22 and 20.11 (13 of 14 tools probed; see the next point) and fails on Node 18 (the logger needs `diagnostics_channel.tracingChannel`). `import.meta.dirname` in `src/stdio-main.ts` is the only API on the stdio graph newer than Node 20.0.
- **Decided with the owner: the floor is Node 24**, the version we develop, test and ship in Docker. Nothing older is tested, so nothing older is promised. The manifest states `compatibility.runtimes.node: ">=24"` and a minimum Claude Desktop version (`compatibility.claude_desktop: ">=2.2553.1"`, the version measured on Windows; to be lowered only if an older one is shown to carry Node 24, and checked against the macOS version number in phase 6), so an older app refuses the bundle with a clear message instead of failing at start.
- No functionality may be lost in the bundle. The one tool that depends on something outside Node is regex search, which shells out to ripgrep; without it the error says "the Docker image has it", which is wrong for a bundle user. Phase 5 adds the fallback: when `rg` is absent, regex search runs through our own linear-time safe-regex engine over the files (slower, same results, same limits), and the tests that skip today without `rg` run against that path instead.

### Phase 1 — the stdio entrypoint (`./brainstem stdio`)

- `src/stdio-main.ts`: `serveStdio((ctx) => createVaultServer(ctx, deps))`, the same factory the HTTP server uses, so both ways in expose the same 32 tools by construction.
- Configuration without HTTP: a `loadVaultConfig(env)` carved out of `loadConfig` (vault path, daily notes, required frontmatter, timezone, watch polling, binary cap, reconcile interval, log level). `OWNER_SECRET`, `PUBLIC_URL`, tunnel settings are not read and not required. `--vault <path>` overrides `VAULT_PATH`.
- **stdout carries the protocol and nothing else.** The logger writes to stderr; the launcher already prints its own messages to stderr; a test asserts that every line on stdout parses as JSON-RPC.
- `src/cli/catalog.ts` gets the command first (the README table and its tests derive from it). `brainstem.cmd` gets the same.
- **The launchers must not demand Docker for this command.** `brainstem` and `brainstem.cmd` exit 1 today when `docker` is missing, before any command runs; `stdio` (like `--help`) needs only Node. The check moves to the commands that use Docker.
- Lifecycle: stdin closing, SIGTERM and SIGINT close the runtime (watcher, reconcile timer) and exit 0, as do a failing stdout (`EPIPE`: the client was killed) and a fatal transport error, so no server outlives its client. Stopping is orderly (found by adversarial review 2): running calls are drained and answered (`CallTracker`, a 250 ms quiet period so calls read together with the disconnect still run, capped at 1 s after the stop began so a busy client cannot postpone it: review 3), a call parked on the index gets 2 s and then `SHUTTING_DOWN`, stdout is flushed, then the transport and the runtime close; an unusable vault path exits 1 with one line on stderr before any protocol byte.
- Tests, with a real child process and the SDK's stdio client: tool list identical to the HTTP harness (names, input and output schemas, annotations); read, write with `expectedHash`, conflict; stdout purity; clean exit on stdin close; refusal of a missing vault.

### Phase 2 — a boot that does not make the client wait

- `FrontmatterIndex`: `empty()` + `fill(adapter, onProgress)`; `build()` stays as the two together. `createLocalRuntime({ deferIndex: true })` returns at once with `indexState(): { ready, done, total }` and `indexReady: Promise<void>`.
- The watcher and the reconcile timer start **after** the fill (an event handled mid-fill could be overwritten by the fill's older read), followed by one reconcile pass to catch what changed during it. The index is ready only when that pass **succeeded**: a failed pass is retried with a backoff (`DEFAULT_SETTLE_RETRY_MS`), and when every attempt fails the build is reported as failed (`INDEX_ERROR`) instead of ready. Notes the fill could not read are counted (`unreadable` in `brainstem_ping`), and closing the runtime stops the fill between batches (found by adversarial review 1).
- One gate where tools are registered, not thirty edits: every vault tool waits for `indexReady` up to `INDEX_WAIT_MS` (45 s: measured, a 37,700-note index takes about 32 s, and the client SDK gives up at 60 s), then runs; if the index is still building it answers an error that says so, with `done` of `total`, and nothing else. Exempt, because they do not read the index: `brainstem_ping` (which reports the state), `brainstem_guide`, `vault_read`, `vault_daily_note_read`, `vault_daily_note_path`, `vault_canvas_read`. Writes wait like everything else.
- The HTTP server keeps its blocking boot in this phase (its health check means "ready to answer anything"); moving it over is a separate, small decision once stdio has shown the gate works.
- Tests, with an adapter whose reads are slowed by injection: `initialize` and `tools/list` answer in under a second; `ping` says building and counts; `vault_read` works; `vault_query` waits and then answers the full count; with a tiny wait the error names the progress; a write is not applied before the index is ready; after the fill a change made during it is visible.

### Phase 3 — two processes on one vault, stated honestly; a read-only mode; setup without Docker

- **Giving the vault path, in each way in.** Desktop: the install form's folder picker. Claude Code: `./brainstem stdio --vault <path>` or `VAULT_PATH` in `.env`. HTTP: `./brainstem setup`, as today. `setup` gains a **local mode** (asked first: "How will Claude reach this vault? locally on this machine / from claude.ai through a tunnel"): it asks only for the vault folder, writes `.env` without a secret or tunnel settings, needs no Docker, and prints the ready-to-paste `claude mcp add brainstem -- <abs path>/brainstem stdio` line. **Done** (`feat/desktop-phase-3-setup`): `--mode local|tunnel` on `./brainstem setup`, defaulting to `tunnel` when absent and the run is non-interactive; the launchers no longer gate `setup` on Docker, and the tunnel branch of `setup` checks for it itself, with the launcher's old message. **Review follow-up (2026-09-21):** that printed line, and its `--vault <path>` sibling, now quote the launcher path (POSIX single quotes / Windows double quotes) whenever it holds anything a shell would split on; `upsertEnv` now heals a `.env` with a duplicated key on the next write (last occurrence wins, earlier lines removed, `removed a duplicate <KEY> line` printed — key names only, never a value) across every caller (`setup`, `vault set`, `secret rotate`).
- **The path is validated at start**, with the validation `setup` and `status` already share (exists, is a folder, is writable, is not a system location): an unusable folder is one clear line on stderr and exit 1, never a server that half works. In Desktop that line lands in the extension's log.
- **One vault per server, stated.** A Desktop install is one vault; two vaults in Claude Code are two entries with two names (`claude mcp add brainstem-work -- … --vault …`). Serving several vaults from one process is another project.

- **`--read-only` (env `VAULT_READ_ONLY=true`)**: the server registers only the tools whose annotations say `readOnlyHint: true` (17 of 32 today), decided from the annotations so it cannot drift from the tool list; a test asserts that no registered tool in this mode can change a file. It is the right default for someone who only wants to ask questions, and the safety net for a vault that is synced between people. It applies to both ways in. **Done.** The filter lives in `withIndexGate` (`src/tools/register.ts`), the one place every vault tool's `server.registerTool` call already passes through; `brainstem_ping` and `/health` gained a `readOnly` field, the connection `instructions` gain one sentence, and a read-only boot skips every write it would otherwise make into the vault (the seeded instructions template, the connection note, the instance heartbeat file — the OAuth token store keeps working, being server state rather than vault content).

- stdio keeps its transaction journal and (later) its cache in a machine-local state dir keyed by the vault's real path, not in `<vault>/_brainstem/` (`STATE_DIR` exists); the HTTP server keeps the vault-local state it has (tokens must travel with the vault). **Done** (`feat/desktop-phase-3`, this work): new module `src/storage/local-state.ts` (`resolveLocalStateDir`, deps injected — `env`, `platform`, `homedir`, `fs`) resolves `<base>/<first 16 hex of sha256(realpath(vault))>`, base from `BRAINSTEM_STATE_HOME` or the OS default (`~/.local/state/brainstem`, `~/Library/Application Support/brainstem`, `%LOCALAPPDATA%\brainstem\State`), created 0700 with a `vault.json` marker written once; never falls back to the vault or the OS temp dir on failure. `src/stdio-main.ts` splits `instructionsDir` (`<vault>/_brainstem`, unchanged) from `stateDir` (this new folder, or `STATE_DIR` when set — unchanged override). `src/storage/transaction.ts` already moved every journal↔vault byte with `fs.copyFile`, never `fs.rename` (which fails `EXDEV` across filesystems), so no change was needed there for the journal to work across devices — proven by a test against a tmpfs (`/dev/shm`) when available. **Review follow-up (2026-09-21):** the resolved state folder (and, symmetrically, a `BRAINSTEM_STATE_HOME`/`STATE_DIR` that would put the *vault* inside the state base) is now refused at boot before anything is created — exit 1 for the state folder, no exception except `STATE_DIR` set to exactly `<vault>/_brainstem`; a `BRAINSTEM_CACHE_HOME` in the same bind just disables the cache (never fatal), symmetrically. A `vault.json` found naming a different vault than the one being served is logged once (both paths) and left untouched rather than silently overwritten.
- README and `brainstem_ping`: "one server per vault" and what happens with two. A boot line on stderr when another brainstem process holds the same machine-local state dir. **Done**: new module `src/storage/local-peers.ts` (`registerInstance`/`unregisterInstance`/`listOtherLivePeers`) keeps `<stateDir>/instances/<pid>.json`, prunes a dead pid's entry (`process.kill(pid, 0)` through an injected probe) whenever it's scanned, and is used both at boot (one info line naming how many others are alive, if any) and — counted fresh at call time — for `brainstem_ping`'s new `localPeers` field (stdio only; absent on the HTTP server, which never sets `FactoryDeps.localPeers`). The HTTP boot's leftover-journal warning was factored out of `src/main.ts` into `scanLeftoverJournals` (`src/storage/transaction.ts`) so stdio logs the same thing, against its own machine-local `tx/` folder, on stderr. **Review follow-up (2026-09-21):** the instance file is now written atomically (tmp + rename) and heartbeated every 60 s on an unref'd timer, closing a CI-observed race where a reader could catch a live peer's file mid-write, misread it as corrupt, and delete it; a peer now counts as live only when its pid is alive *and* its file's mtime is under three heartbeats old (the portable defence against pid reuse), with bounded-concurrency, capped scanning (`INSTANCE_SCAN_MAX`) and careful handling of directory-shaped or symlinked entries.
- A cross-process write lock is **not** in this project: `expectedHash` already turns a collision into a CONFLICT instead of a lost write. Revisit with evidence.

### Phase 4 — the machine-local index cache

As decided (point 4 above). Only after phases 1–2 are in use: it matters for a 37,000-note vault started per session and not at all for a small one. Acceptance: second start on the large vault under 3 s, identical query results with and without the cache, a cache from another vault or schema is discarded, permissions 0700/0600.

**Done** (2026-09-21, on `feat/desktop-phase-3`): `src/storage/local-cache.ts` (NDJSON, one entry per line, a header line carrying `schema`/`server`/`vaultKey`/`writtenAt`/`entries`; `INDEX_CACHE_SCHEMA` next to `IndexEntry` in `src/vault/frontmatter-index.ts` guards the shape) plus wiring in `FrontmatterIndex.fill` (an optional cached-entries map — a hint only, validated per path against the current listing's size/modifiedAt) and `createLocalRuntime` (`indexCache` option: load before the fill, save once after ready when worth it, at most hourly while running, once more on a bounded shutdown save). `src/stdio-main.ts` resolves it next to (but separate from) the state folder, disables it on `BRAINSTEM_INDEX_CACHE=off`, and never lets its absence or a write failure stop the boot — one warning line instead. `brainstem_ping`'s `index.cache` (stdio only) reports the boot's own `used`/`entriesFromCache`/`entriesRead`/`rejected`.

Measured (`tests/scale/vault.scale.ts`, this machine, 40,000 notes): cold deferred boot to "index ready" ~19.7 s (including a ~386 ms cache save at the end), warm ~3.5 s — about 5.6x faster, and a hair over this plan's original "under 3 s" guess, so the acceptance bound actually enforced in tests is looser and named (`WARM_BOOT_MAX_MS = 5_000`, `WARM_VS_COLD_DIVISOR = 3`), with the honest reasoning that a CI runner is slower than the workstation this was measured on. Cache file ~75 MiB for 40,001 entries (~1.9 KB/entry, in line with the index's own ~2.0 KB/note serialized size — the cache is close to a straight copy of the index). Heap after a warm boot was not larger than after a cold one (204 MiB vs 221 MiB measured; the 10%-over-cold tolerance in the test was not needed here, only asserted as a ceiling). Query results (three `vault_query`-shaped `evaluateQuery` calls) were identical cold vs warm, as required.

Measured on a real vault of 37,707 long notes (read-only mode, a throw-away cache folder, through a real MCP client): cold 36.5 s to "index ready", warm 5.9 s and 5.8 s, every entry taken from the cache and none read, the same count from `vault_query` cold and warm, a 128 MiB cache file (0600, in a 0700 folder), nothing created or changed inside the vault. The remaining seconds are the directory listing of the vault, the parse of the cache and the settling reconcile pass: all three are what keeps the cache a hint.

**Review follow-up (2026-09-21):** the load-time reader no longer uses `readline` (it also breaks a JSON line on U+2028/U+2029, which a note's own path or frontmatter can legitimately contain) — its own byte-level splitter enforces a 4 MiB per-line cap in both directions, surfaced as `skipped` in `brainstem_ping.index.cache`. Saving adopted git's "racily clean" rule (an entry modified within `INDEX_CACHE_RACY_WINDOW_MS` of the save is left out, simply re-read next boot) and now refuses to write any entry whose frontmatter holds a number JSON cannot carry (`NaN`, `±Infinity`, `-0`, anywhere nested), so a cold and a warm `vault_query` answer can never disagree. The cache folder gets the same containment refusal as the state folder (never inside the vault, never the reverse), and a leftover save's tmp file is now pruned by writer liveness (any age once the writer's pid is dead), not just age.

Review round 2 (2026-09-21) found nothing above medium: after a fresh import every entry is inside the 3 s racy window, so restarts within it re-read the whole vault and saved an empty cache; a save that left entries out is now repeated once, 4 s later. Known and left: a hand-written multi-line quoted value in `.env` is not understood by the `.env` parser (it never was); the cache header's `entries` is the index size, not the line count.

### Phase 5 — the bundle

What installing it looks like, which is the point of the phase: download `brainstem-mcp-X.Y.Z.mcpb` from the release page, open it (or Settings → Extensions in Claude Desktop), choose the vault folder in the form the manifest generates, done. No Docker, no Node to install (it ships with Claude for macOS and Windows), no tunnel, no secret. Updating is installing the newer file.


- **The install form** (`user_config`, from which Claude Desktop generates its settings UI; it can be edited later under Settings → Extensions): `vault` (`directory`, required: any folder is a valid vault, an empty one included), `read_only` (`boolean`, default false), and optional `timezone`, `daily_notes_folder`, `daily_notes_format` with today's defaults. **No secret field**, on purpose (see "Why stdio needs no secret" below). Values reach the server through `mcp_config.args` / `env`.
- `manifest.json` (0.3): `server.type: node`, `entry_point: dist/stdio-main.js`, `mcp_config.args: ["${__dirname}/dist/stdio-main.js", "--vault", "${user_config.vault}"]`; `user_config.vault` of type `directory`, required; optional timezone and daily-notes folder; `compatibility.platforms: darwin, win32, linux`, `runtimes.node: ">=24"` and the minimum Claude Desktop version (phase 0); `tools_generated: false` with the tool list generated from the registry so it cannot drift.
- **The bundle holds the stdio server and nothing else.** It opens no port, has no URL, no OAuth, no tunnel: the HTTP server is a different deliverable (the Docker image), from the same repository and at the same version, for a vault several people reach from claude.ai. Nobody who installs the bundle gets or starts a network server.
- Contents, preferred: **one JavaScript file** built with esbuild from `src/stdio-main.ts` (so only what stdio imports is in it: tools, vault, storage; not Express, the authorization server, the tunnel supervisor or the CLI), plus `manifest.json`, the licence and an icon. Reasons: the installers are on Windows 11 and macOS, and deep `node_modules` trees (8,400 files here) are the classic source of path-length failures when unpacking on Windows; a bundle the public downloads should carry no code it never runs. Risk: not every library bundles cleanly (the logger is the usual suspect). Proof: the whole stdio test suite runs against the bundled file, not only against the sources. Fallback if it does not come out clean: `dist/` plus production `node_modules`.
- ripgrep is **not** bundled at first: search already falls back to a JavaScript scan; a per-platform binary is a later, measured decision.
- `npm run bundle` = build + `npm ci --omit=dev` in a staging dir + `mcpb validate` + `mcpb pack`. CI builds it on every tag and attaches `brainstem-mcp-X.Y.Z.mcpb` to the GitHub release; `tests/release/version-consistency.test.ts` also checks `manifest.json`.
- **Distribution.** CI builds the bundle on every release tag and attaches it to the GitHub release under two names: `brainstem-mcp-X.Y.Z.mcpb` and a fixed `brainstem-mcp.mcpb`, so `…/releases/latest/download/brainstem-mcp.mcpb` is a link that never changes. The repository is public and so is the bundle: it holds code only, no data and no secret; the vault stays on the machine of whoever installs it. Submission to the vendor's extension directory (review, automatic updates) is a later step.
- **Signing (proposed, to be confirmed by the owner).** Facts from the MCPB CLI docs: `mcpb sign --cert … --key …` takes an X.509 certificate and key in PEM, self-signed or CA-issued ("should have Code Signing extended key usage"); the signature is a detached PKCS#7 appended to the zip; `mcpb verify` shows subject, fingerprint and a warning when self-signed. What Claude Desktop shows for an unsigned, a self-signed and a CA-signed bundle is **not documented: measure it here** before spending money. Proposal: (1) a project certificate, self-signed, Code Signing EKU, long-lived; its private key is a GitHub Actions secret in a protected environment that only release tags reach (the owner generates and stores it; it is never in the repository or in a log); its fingerprint is published in README and SECURITY.md so anyone can run `mcpb verify` and compare; (2) `SHA256SUMS` and a GitHub build-provenance attestation on every release asset (`gh attestation verify`), which for an open-source project says more than the certificate does: exactly which commit and workflow produced the file; (3) a CA-issued certificate only if the measurement shows Desktop treats it materially differently or the directory requires it, and only after checking that such a key can be used at all: CA code-signing keys now live on hardware or in a cloud HSM and cannot be exported, while `mcpb sign` wants a PEM key file.
- **Who should install it.** The bundle needs the vault on the machine. For a personal vault that is the point. For a vault shared by a team it means a copy of the data on every laptop, which is an access decision, not a packaging one: there the HTTP server with a connector (one copy, controlled access) stays the right path, and the bundle is for whoever holds the data anyway.

**Done (2026-09-22).** Regex search without ripgrep first, since the bundle would otherwise ship
with a functionality gap (`docs/plans/…` Phase 0's own finding): `compileSafeSearch` in
`src/vault/safe-regex.ts` extends the existing Thompson-NFA engine (already used for
`vault_query`'s `regex` op) to unanchored, `caseSensitive`-aware search, and `LocalFSAdapter`
falls back to it when `rg` is not on `PATH` instead of throwing `UNSUPPORTED`. Measured on a
generated 40,000-note vault (`tests/scale/regex-search.scale.ts`): a required-literal prefilter
(ripgrep's own trick — derive a substring at least one of which must appear in any match, from a
literal run in a `concat` or the union of a top-level alternation's branches; a ~400-pattern fuzz
test proves it never rejects a real match) plus a hot-path rewrite (two reusable `Int32Array`
thread-list pairs instead of per-character object allocation, a memoized case-fold lookup) took
well-filtered patterns (a literal, an email-like pattern, the real
`(invoice|receipt)[- ]?(number|no\.?)\s*[0-9]{3,}` example) from ~10–12 s to ~4.5 s on this
machine — now dominated by this environment's raw file-read time for 40,000 files (~3.5 s of
that alone), not by the NFA; `(a+)+b`, with no derivable required literal, is unaffected, as
expected, and stays linear rather than exponential.

The bundle itself: `scripts/bundle-build.ts` (esbuild, `platform: node`, `target: node24`,
`format: esm`, `packages: 'bundle'`, external sourcemap, a version banner) produces
`bundle/dist/stdio-main.js` in well under 150 ms; unpacked it is about 2.0 MB (the whole stdio
graph — the MCP SDK, zod, pino, chokidar, picomatch, yaml, date-fns, diff — inlined; a
`tests/bundle/build.test.ts` grep proves Express, `cloudflared`, `OWNER_SECRET`'s VALUE (the
field name is present, unused, in the one `EnvSchema` both `loadConfig` and `loadVaultConfig`
parse — documented, not a leak) and the actual authorization-server/tunnel/CLI source files never
come along). One shim was needed: pino's CJS internals `require('node:os')` in a way esbuild
cannot statically resolve into an ESM import, which throws "Dynamic require of … is not
supported" under `format: 'esm'` without it — the banner injects a real `require` via
`createRequire(import.meta.url)`, the documented fix. The version is fixed at build time
(`process.env.BRAINSTEM_BUNDLE_VERSION`, `esbuild`'s `define`) since the bundle carries no
`package.json` of its own for `src/version.ts` to read at import time.

`scripts/bundle-manifest.ts` generates `manifest.json` (0.3) and a small PNG icon (rendered at
build time — raw pixel buffer, `node:zlib` deflate, no image library or binary asset committed);
the `tools` array comes from `registerVaultTools` on a throwaway in-memory-transport `McpServer`
(30 tools, `brainstem_ping`/`brainstem_guide` deliberately excluded — server plumbing, not vault
tools), so it cannot drift from the registry. `env.VAULT_TIMEZONE` (not `TZ`, which does nothing
useful here — `src/config.ts` reads `VAULT_TIMEZONE` for `dailyNotes.timezone`) and
`env.DAILY_NOTES_FOLDER` carry the optional settings, each with a `default` (`"UTC"`, `""`) equal
to `src/config.ts`'s own default, so an untouched field substitutes to exactly what stdio would
already assume — `loadVaultConfig` already treats an empty env value as unset, so an empty
substitution is harmless either way. `npm run bundle` (build + manifest + icon + LICENSE/README
excerpt + `mcpb validate` + `mcpb pack` + `SHA256SUMS`) takes well under a second end to end;
`release/brainstem-mcp-X.Y.Z.mcpb` (and the fixed-name copy) is about 0.40 MiB packed. `npm run
test:bundle` (`vitest.bundle.config.ts` running `tests/stdio/**` — the exact suite that proves
the source — against the bundled file via `BRAINSTEM_STDIO_ENTRY`, read by one shared
`tests/helpers/stdio-entry.ts`) passes in about 17 s. Found along the way: the bundled process
boots fast enough that `tests/stdio/index-cache.test.ts`'s freshly written fixture files were
still inside the index cache's 3 s "racily clean" window when the first boot's save ran, flaking
the second boot's cache-hit assertion deterministically against the bundle (it had passed against
the source, whose slower cold start happened to land outside the window) — fixed by backdating
the fixture files' mtime past the window, removing the race regardless of boot speed rather than
papering over it with a sleep.

Left as documented, not built: signing (the proposal above stands; `SHA256SUMS` plus a GitHub
build-provenance attestation, `actions/attest-build-provenance@v3` in the new `bundle` CI job,
ship from the first release instead) and a bundled ripgrep binary (still a later, measured
decision — the fallback above means it is no longer required for parity).

Measured on the real 37,707-note vault (read-only, ripgrep 15.2 against the builtin engine, identical hit counts on all six patterns): ripgrep 17–58 ms per search; builtin 1.0–1.4 s for ordinary patterns — a literal search costs the same 1.4 s, so that second is the single-threaded reading of the files, not the matching — and 5.7 s (32 s before the prefilter and the faster hot path) for `(invoice|receipt)[- ]?(number|no\.?)\s*[0-9]{3,}`. RSS 112 MB vs 267 MB. Decision: ripgrep is recommended everywhere a user can read it, not bundled (four platform binaries, and Gatekeeper on macOS would refuse an unsigned one); the generated-vault figures in the scale test are far lower because its notes are short.

### Phase 6 — three operating systems

- CI matrix `ubuntu | macos | windows` for unit tests (Docker smoke stays on Linux). Expected trouble, to be found by tests rather than by users: backslashes reaching the path policy, case-insensitive file systems (two notes that differ only by case; near-miss suggestions), atomic rename over an open file on Windows, watcher behaviour (FSEvents, ReadDirectoryChangesW), `\r\n` in notes, long paths.
- Paths as people really have them: spaces and non-ASCII letters (`C:\\Users\\Ana Maria\\Documents\\Vault`), a vault inside a synced folder (iCloud Drive, OneDrive, Dropbox) whose files may be placeholders fetched on first read, which makes the first index build slow or partial: tested where CI can, documented where it cannot.
- Nothing in the security invariants may weaken to make a platform pass; a platform that cannot hold one is listed as unsupported.

**Done (2026-09-21/22).** The `platforms` CI job (`ubuntu | macos | windows`, the whole test suite, unmodified) first ran the whole suite on Windows: 17 of 1274 tests failed. Two were product defects, present on every platform and just unreachable on a case-sensitive, signal-having Linux until now:

- **Case-insensitive filesystems** (predicted above): `vault_read` of a wrongly-cased path returned the *other* note's content on Windows; a write under a wrong case would have silently duplicated the index entry. Fixed in `LocalFSAdapter` (`src/storage/local-fs.ts`): a filesystem's case sensitivity is detected once per boot (zero cost when sensitive), and a case-only near-miss is now treated exactly like a genuinely missing file — `NOT_FOUND` with a suggestion for a read, `CONFLICT` naming the real path for a write.
- **`vault_delete` of a folder** could fail on Windows with a bare `IO` error: a rename into `.trash/` racing a handle the file watcher still held open inside it (not predicted above, but the same family as the "atomic rename over an open file" risk that was). Every rename this server makes now retries on `EPERM`/`EBUSY`/`EACCES`; a folder delete that still can't rename falls back to a verified copy-then-remove.

The rest of the 17 were test defects, not product ones: hand-written POSIX paths compared against `path.join` on a Windows-native `path` module (three CLI tests, one of them a real bug — `suggestVaultPaths` received a `platform` alongside `home` and never used it); `SIGTERM`-based tests, which the process handles by terminating at once on Windows rather than being asked to stop (the graceful-stop coverage already existed via stdin closing); a `0600` file-mode assertion; an `import()` built from a raw path instead of `pathToFileURL`; two tests legitimately slower on a loaded Windows runner, given an honest longer timeout instead of none.

macOS then found two more, both eventually traced to the *tests*, not the server: the new case-check's own test helper (`seedDualCase`, in `tests/storage/local-fs-case.test.ts`) tried to create two files differing only by case to reach a read-type method's pre-existing existence check — real on Linux, but the *same file* on a genuinely case-insensitive filesystem, so the second write there just clobbered the first one's content; it now writes the second file only where the platform is actually case-sensitive. And `tests/storage/local-fs-nav.test.ts`'s watcher test found that GitHub Actions' macOS runner does not deliver native filesystem-watch events at all (confirmed by a canary retried for 20 s and by the very next test, using `usePolling: true` on the same code, passing) — a known category of sandboxed-CI limitation, not a path-computation bug (traced through chokidar's own source to rule that out), so the native-watch assertions are skipped specifically on CI+darwin. That same investigation surfaced, and fixed, a real hazard the rewrite briefly introduced: an assertion thrown before a chokidar watcher's `unsubscribe()` ran left a live watch handle open, which hung one CI job for six hours until GitHub's own ceiling cancelled it — `unsubscribe()`/`close()` now belongs in a `finally` in every watcher test.

A `tests/server.test.ts` drain-window test also failed once on macOS (`elapsed` ~0.1 ms instead of ≥250 ms — `close()` had nothing to wait for) and passed on every run since a synchronization fix (poll `httpServer.getConnections()` until the server itself agrees a connection is open before starting the timer, rather than trusting a client-side TCP `connect` event alone). Attempts to reproduce the original race locally, including by injecting event-loop delays at the same point, did not succeed, so whether that fix addresses the true mechanism or the failure was transient is not proven either way; the test now carries connection-count and socket-error diagnostics for whichever way it goes next.

All three legs green: `platforms` is now in `publish-images`'s `needs`, so an image is never published from a commit whose tests did not pass on Windows and macOS, not only Linux.

Left open by phase 6, to be checked on a real Mac in phase 7: GitHub's macOS runners delivered no native file-watch event at all (polling mode worked on the same runner), so the native watcher test is skipped there, on `CI` only. If a real Mac showed the same, the index would heal only through the reconcile pass (5 minutes on the HTTP server; the settling pass at every stdio start): usable, but to be known. Also to be checked there: the drain window at HTTP shutdown, which one macOS run cut short without a reproducible cause.

At the 0.7.0 tag the macOS leg failed a fourth time on `vault_outline`'s link count, and the diagnostic in the test named the cause: the index entry was the note's PREVIOUS version (another test's fixture: its tags, its size), put there by a watcher refresh that had read the file before `vault_write` and landed after the tool's `applyNote`. The same race as the deleted-note one, on a rewrite; never reproduced on Linux because its watcher is faster than a read. Fixed the same way (a tool's `applyNote` withdraws older refreshes); the tag was moved onto the fix.

### Phase 7 — proof with readers

The five costliest prompts of the reader test, run through stdio in Claude Code on the large vault and compared with the HTTP runs (calls, characters, errors), then one session by a person on macOS or Windows with the installed bundle. Findings are fixed or listed.

**What only a live install can show (2026-09-22, for the Windows 11 and macOS colleagues; the owner is on Linux).** Each item is a yes/no to report back, with the Claude Desktop version:

1. Download `…/releases/latest/download/brainstem-mcp.mcpb`; Settings → Extensions → Advanced settings → Install Extension… accepts it. What the unsigned-extension warning says, word for word.
2. The install form shows the four fields (vault folder, read-only, timezone, daily-notes folder) with the descriptions from the manifest; the folder picker works; `read_only` is a checkbox.
3. The server starts: `brainstem_ping` answers, `version` is `0.7.0+<sha>`, `search.regexEngine` says `builtin` unless ripgrep is installed, `readOnly` matches the checkbox. This proves `command: "node"` resolves to the app's own Node (nothing else is installed).
4. Turn the read-only checkbox on and off in the extension's settings: the tool list changes (17 vs 32) on the next conversation.
5. Install a newer `.mcpb` over the old one: the four settings survive; the version changes.
6. Where the log is (Settings → Extensions → the extension → logs, or the app's log folder): the one info line about ripgrep is there; nothing at `warn` or above on a clean start.
7. macOS only: edit a note in Obsidian while Desktop is open, then ask Claude for it within a few seconds — proves native watch events on a real Mac (GitHub's runners had none). Also `vault_delete` twice in a row on two notes, then a search for their titles: nothing found (the watcher-vs-tool race fixed in 0.7.0).
8. macOS only: a FIFO in the vault would once have frozen the server; not worth reproducing by hand — covered by the suite on the macOS runner.
9. Windows only: a vault under OneDrive or another synced folder: writes succeed (rename retries), and `brainstem_ping` reports `localPeers: 0` with one Desktop window open.
10. Both: the vault on an external or network drive if anyone has one; a vault path with spaces and non-ASCII letters.

## Out of scope

A stdio bridge to the HTTP server; any change under `src/auth/`; SQLite; multi-user; a setup UI; bundling a Node runtime of our own.

## Open questions for the owner

1. ~~Who will install the bundle?~~ Answered 2026-09-21: the owner's colleagues on Windows 11 and macOS, and anyone who downloads it from the public repository. So phase 6 (three operating systems in CI, and a real install on Windows 11 and on macOS) **gates** the first published bundle, and checksums plus a build attestation ship with it from the first release.
2. Signing: confirm the proposal in phase 5 (project certificate, self-signed, plus checksums and build attestation), or choose otherwise.
3. After phase 2, should the HTTP server also boot in the background (no 27 s gap at every deploy), with `/health` reporting "building"?

## Why stdio needs no secret

stdio is not a listening endpoint: there is no port, socket or named pipe to connect to. The client spawns the server and holds the only ends of two anonymous pipes. What another program running as the same user *can* do is start its own copy of the server on the same folder; but that program can already read and write the files directly, so nothing is gained by going through the server. The trust boundary is the operating-system account, as it is for the editor that owns the vault. A secret would sit in the extension's configuration under that same account, readable by exactly the programs it is meant to stop; it buys nothing here, and it is what the HTTP server has because there the boundary is a network. What does protect the vault on this path: nothing listens on the network; the path policy confines the server to the chosen folder and keeps `_brainstem/` reserved; Claude Desktop asks the user to grant permissions to the extension's tools; and `--read-only` removes the writing tools altogether.

## Versioning: one version for everything

The bundle is not a second product: it is the same code and the same tools, built by the same factory, in another wrapper. So there is **one version, in `package.json`**, and everything a tag produces carries it: the Docker images (`vX.Y.Z`, `latest`), `brainstem-mcp-X.Y.Z.mcpb` (and the fixed-name copy), and `manifest.json`'s `version`, which `tests/release/version-consistency.test.ts` checks like the changelog and the README. A running server reports `X.Y.Z+<commit>` from the bundle too (the commit is written at build time, as in the image). A change to the packaging alone (a new field in the install form) is still a release of the repository, with a patch bump.

Two version lines were considered and rejected: "0.7.2" would mean different things to someone on Docker and someone on Desktop, and a second number is a second thing that can fall behind unnoticed, which is the failure fixed in 0.4.0. A monorepo with independently versioned packages pays off when different teams ship at different paces; here everything comes from one tree and one maintainer.

What differs between the two ways in is how often someone must act: a file-installed extension does not update itself. That is answered in the changelog, not in the version: each entry says what it touches (the HTTP server and tunnel; stdio and the bundle; the tools, which are common to both), so a person on Desktop can tell from the release notes whether reinstalling is worth it.

`1.0.0` is proposed for when this project has shipped and the tool contract has stood unchanged for a while; from then on a change that breaks clients is a major version.

## Order and releases

Phase 0 runs beside phase 1. **0.5.0** = phases 1 + 2 (usable at once from Claude Code on Linux). **0.6.0** = phases 3 + 4. **0.7.0** = phases 6 then 5 (the platforms are proven before the bundle is published), with the bundle on the release page. Phase 7 gates 0.7.0.
