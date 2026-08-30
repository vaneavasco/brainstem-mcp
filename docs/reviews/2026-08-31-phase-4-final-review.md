# Phase 4 — final whole-branch review and fix wave (2026-08-31)

**Range reviewed:** `1d04e08..40e530c` (21 commits, 70 files, +9529/−295) — the whole `phase-4-vault-graph` branch after all 12 plan tasks passed task-scoped adversarial reviews. **Fix wave:** `0bce9dc` (+ controller polish in the follow-up commit). **Verdict:** ready — every Critical/Important finding fixed and re-verified; residuals below.

## What the final review confirmed (adversarial, with live probes)

- **Locking is airtight.** Every mutating adapter call in `src/tools` and `src/vault` sits inside a `locked()` scope; no lock is ever acquired while another is held; `WriteGate.withLock` sorts + dedupes, so no ordering deadlock is constructible. No lost-update window was found.
- **Hash provenance correct everywhere**, including the transaction's simulated hashes (byte-matched against disk for write+merge, edit, append, frontmatter_update).
- **Path policy held** against every escape probe (`../`, absolute, `_brainstem/`, `.obsidian/`) across the new surfaces: transaction op paths, template targets, canvas file nodes, search `paths`.

## Findings fixed in the wave (`0bce9dc`)

| # | Finding | Fix |
|---|---|---|
| C1 | **ReDoS**: `where` `op:'regex'` used JS `RegExp` (backtracking) — `(a+)+$` took 15.5 s at 28 chars, unbounded beyond; blocks the whole event loop | New linear-time Thompson NFA (`src/vault/safe-regex.ts`): full-match, reduced syntax, states ≤ 5000, subject ≤ 2048, pattern ≤ 200; classic catastrophic patterns now < 2 ms. Re-review ran a 125k-case differential fuzz vs `RegExp`: 0 mismatches |
| C2 | One unparseable `.canvas` made every `vault_move` report failure **after** moving and rewriting (partial application presented as clean failure) | Canvas rewrite loop uses the same try/catch → `failed[]` as note rewrites; regression test with a `{}` canvas |
| C3 | `ExpectedHashArg` import cycle **armed**: the next module-scope use compiles, passes vitest/tsc/biome, and fails to boot under plain Node (TDZ) | `src/tools/args.ts` leaf module (re-exported from `register.ts`); `tx.ts` lazy workaround removed; **CI boot smoke** added (`node -e "import('./src/tools/register.ts')…"`) — the one gate that catches this class |
| I1 | Single-asset `vault_move` didn't rewrite links by default (folder moves did) | `isAsset` added to the default |
| I2 | `vault_delete` never called `index.removeAsset` (stale graph until the watcher caught up) | Mirrors the note branch for single assets and folder contents |
| M1–M6, R3 | ADR/spec journal-surfacing claim (boot log, not connection.md); invalid-YAML fallback documented; new inner paths added to the folder-move lock set; canvas rewrites pass `expectedHash`; self-anchors excluded from `orphans()`/`hubs()`; README says exactly 30 tools; **every** `VaultError` result now carries `structuredContent {code, ...details}` | all landed |
| T6a/b, T9a/b | Tests-only pins: asset + `.canvas` inside a moved folder; `findUnlinkedMentions` width 200; adapter search ceiling clamps at `MAX_SEARCH_SCAN` | added |

Controller polish (this commit): CHANGELOG regex claim made honest (linear-time, not "cannot hang"); `searchScanAndFilter` filters scanned entries in chunks through one `evaluateQuery` call per ≤ `MAX_QUERY_ROWS` entries instead of recompiling the pattern per file.

## Residual risks, accepted (single-user, owner-gated threat model)

- **C1 residual (quantified):** a crafted `where` regex within the caps can still cost ~90 ms per 2048-char value — ~6 s over 2000 notes. Linear, self-inflicted, bounded; pre-fix it was exponential and unbounded. Mitigation if ever needed: per-`CharSet` ASCII bitmap (~10–30×) or a compile-time work budget.
- **Folder-move race with a brand-new unindexed file** created in the same instant (ADR 0006): loud failure modes, single process.
- Chokidar timing flake in `tests/storage/local-fs-nav.test.ts` (pre-existing; passes in isolation).

## Fix-later list (adjudicated “stays parked”)

`tags()`/`notesWithTag()` re-derive nested membership per call (O(T²) in tag keys); `orphans()`/`hubs()` re-sort via `index.all()` per call; case-sensitive tie-breaks in orphans/hubs vs case-insensitive in tags; `graph.ts` size + redundant `clampMatch`; CONFLICT message formatting in 3 places; `vault_move` handler ~170 lines inline; adapter methods could return post-write hashes (saves a read); `results.ts` CONFLICT branch assumes `details`; nested-tag prefix rule duplicated (`graph.ts`/`query.ts`); search/query Zod schema duplication (typed, documented); sibling same-text heading paths not disambiguated in `listHeadingPaths`; final-segment heading ambiguity resolves in file order (documented); template placeholder grammar boundary (space/digit-led names absent from `unresolved`); `touch()` no-op for non-md targets (watcher covers); "0.0 MiB" cosmetic; perf-guard comment wording ("deterministic") and 2.92× margin; NFA `MAX_SUBJECT_CHARS` counts UTF-16 units while matching iterates code points (off-by-a-surrogate at the cap); astral `.` matches one code point (documented divergence); coverage-breadth notes from Tasks 3/4.

## Test state at close

730 passed / 15 rg-gated skips locally (no `rg` on the host); the full suite ran green with ripgrep 13 in a `node:24-slim` container (only two environment-bound tests need the host); CI `verify` + `docker-smoke` (30 tools) + `publish-images` green on every task merge. Live MCP acceptance runs on the published `sha-` image before `v0.3.0` is tagged; results go in the plan's Acceptance log.
