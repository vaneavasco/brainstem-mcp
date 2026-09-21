# ADR 0008 — A local stdio server beside the HTTP one, and a Claude Desktop bundle

Date: 2026-09-21 · Status: accepted (implementation in progress; plan: `docs/plans/2026-09-21-claude-desktop-integration.md`)

## Context

ADR 0005 made this a single-user server reached over HTTP through a tunnel, with its own OAuth. Used for a day by its owner on their own machine, that path failed in ways that have nothing to do with the vault: a quick tunnel lost its hostname twice, each time forcing every client to be re-created with a new URL, and a connector's proxy served the previous tool list for hours after a release. A client that starts the server itself and speaks to it over stdin/stdout has none of these parts.

## Decision

**A second entrypoint, `./brainstem stdio`, serves the same tools over stdio**, built from the same factory (`createVaultServer`) through the SDK's `serveStdio`. It is an addition: the HTTP server, its OAuth and the tunnel stay as they are and remain the only way to reach a vault from claude.ai or from another machine.

**It has no authentication.** The process is started by, and runs as, the operating-system user who owns the vault's files; nothing it can do is beyond what that user can already do with a text editor. Everything that protects the vault from the *model* is unchanged: the path policy and the reserved `_brainstem/` folder, size limits, optimistic concurrency, the write gate, bounded results. A stdio bridge to the running HTTP server was considered and rejected for now: it needs a local trust path in the authorization server, which is a security change that deserves its own plan and adversarial review.

**The boot answers at once; the index is built in the background.** A client that starts the server per session cannot wait the 27 seconds a 37,000-note index takes. Tools that read the index wait for it for a bounded time and otherwise answer an error that states the progress; tools that only read a file work from the first second. No tool answers from a half-built index: a count that is quietly too low is the failure this project has spent three ADRs removing.

**State that must not travel stays off the vault.** For the stdio server the transaction journal, and later the index cache, live in a machine-local directory keyed by the vault's real path. This departs from ADR 0005's "everything the server persists lives under `<vault>/_brainstem/`" and keeps its reason: what must travel with the vault (OAuth token hashes, the owner's instructions) still does; what is re-derivable or machine-bound does not, because a vault may be in git or synced between machines, where a 100 MB cache would be rewritten, uploaded and conflicted, and where modification times cannot validate another machine's cache.

**One server per vault remains the design.** Two processes on one vault are tolerated: reads are safe, a colliding write becomes a CONFLICT through `expectedHash`, and each process's index heals through its watcher and reconcile. A cross-process write lock is not built until there is evidence it is needed.

**The Desktop bundle is packaging, not a third server**: an `.mcpb` whose entry point is the stdio server, with the vault folder as its one required setting, built and attached to the release by CI, its version checked against `package.json` like the rest.

## Consequences

- Two ways in must expose the same tools. They do by construction (one factory); a test compares the two tool lists.
- stdout is the protocol. Logging goes to stderr everywhere on this path, and a test reads stdout to prove it.
- The Node version Claude Desktop runs bundles on is not documented. It is measured before the build target is fixed; a CI job pinned to that version keeps it honest.
- macOS and Windows become supported platforms for the first time. The security invariants do not bend for a platform: one that cannot hold them is listed as unsupported.
- An index cache becomes worth building (it was not, for a server that restarts only on deploy); its design is recorded in the plan and deliberately excludes the vault as a location and SQLite as a dependency.

## Amendment (2026-09-21, phase 3 implementation)

"State that must not travel stays off the vault" above is implemented as two separate folders, not stated precisely enough in the original decision to avoid ambiguity: `src/stdio-main.ts` now resolves an `instructionsDir` (`<vault>/_brainstem`, vault content, unchanged) and a `stateDir` (the transaction journal, resolved by the new `src/storage/local-state.ts`, or `STATE_DIR` when explicitly set) separately, where before this phase both were one and the same directory. `resolveLocalStateDir` hashes the vault's *real* path (`fs.realpath`, first 16 hex of its SHA-256) so two spellings or symlinks of one vault share one folder, under `BRAINSTEM_STATE_HOME` or the OS default state directory; it never falls back to the vault or the OS temp dir on failure, which is instead a fatal, one-line stderr error at boot. `src/storage/transaction.ts` needed no change to work across a filesystem boundary: every journal↔vault byte already moved with `fs.copyFile` (never `fs.rename`, which fails `EXDEV` across devices), confirmed by a test that runs the journal against a tmpfs (`/dev/shm`) when available. "Two processes on one vault are tolerated" gained a concrete mechanism: `src/storage/local-peers.ts` tracks `<stateDir>/instances/<pid>.json`, prunes a dead pid on every scan, and backs both a one-line boot log and `brainstem_ping`'s new `localPeers` field (stdio only).

## Amendment (2026-09-21, phase 4 implementation)

The index cache promised above ("becomes worth building... deliberately excludes the vault as a location and SQLite as a dependency") is `src/storage/local-cache.ts`: a third machine-local folder, next to but separate from `stateDir` (own env var `BRAINSTEM_CACHE_HOME`, own OS-default cache directory, same `vaultKey` hashing exported from `local-state.ts` and reused rather than duplicated). It differs from the state folder in one deliberate way: a cache that cannot be created or written is never fatal — the server logs one warning line and runs without it, since (unlike the transaction journal) nothing it holds is load-bearing. `FrontmatterIndex.fill` takes the loaded cache as a hint: an entry is upserted without a disk read only when the current boot's own listing shows the same size and modified time the cache recorded; everything else — changed, new, or absent from the cache — is read exactly as before. `createLocalRuntime`'s `indexCache` option keeps the runtime itself free of path or environment logic. Measured on the 40,000-note scale vault: a cold deferred boot to "index ready" is ~19.7 s, a warm one ~3.5 s (about 5.6x faster, a cache file of ~75 MiB); see the plan's Phase 4 for the fuller numbers and the assertions built from them.
