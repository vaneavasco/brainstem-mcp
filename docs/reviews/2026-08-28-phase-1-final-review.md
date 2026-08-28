# Phase 1 final whole-branch review — `phase-1-core-tools` (9a6c642..23534ca)

Reviewer: Fable (single agent, three passes: plan/spec/ledger → source + probes → verification/ops). No subagents dispatched. Read-only; working tree untouched (`git status` clean after review). Note: `main` is already fast-forwarded to 23534ca and pushed, so "merge" below means "fix wave on top of main".

Verification run: `npm run typecheck` clean · `npm run lint` clean (56 files) · `npm run build` clean · `npm test` **119 passed / 1 skipped** (ripgrep suite; `rg` absent on this machine) · `docker compose config` valid (user `1000:1000`, bind `./vault-dev:/vault`, pg host port 5433).

Probes executed in `os.tmpdir()` (Node 24 type-stripping against `src/*.ts`): 50 path-policy inputs, YAML/Zod error-message leakage, LocalFS symlink escapes through read/write/append/list/move/search/softDelete, `.trash`-as-symlink, folder soft-delete, stamped trash names, ancestor-is-file, ENAMETOOLONG, mergeFrontmatter over invalid YAML, CRLF edit, pathological glob, NFC/NFD round-trip, daily-note folder/format abuse, strftime token table.

---

## Strengths

- **Path policy is tight and well-reasoned.** All 50 probe inputs behaved correctly: `..` in every disguise (incl. backslash), POSIX/UNC/Windows-drive absolutes, `file:`/`http:` URIs, NUL/C0/DEL control chars, every dotfile segment (`.trash`, `.TRASH`, `..bar`, ` .obsidian` after trim), Obsidian-forbidden chars, >1024 chars. `allowInternal` is correctly scoped to a leading `.trash` segment only and still rejects `.trash/.hidden` and `.trash/../x`. Error text echoes only the path, never content.
- **`assertInsideRoot` + temp+rename is a coherent guard.** Read/write/append/list/move/search(JS) all refused a symlinked file and a symlinked directory planted outside the API; `list` and the JS search skip symlink dirents entirely (`isFile()/isDirectory()` are false for links); rename onto a symlink replaces the link rather than following it. `.tmp` files are dotfiles → invisible to list/search/watch.
- **No content leakage in error paths.** `yaml` first-line messages carry only position (`... at line 2, column 1:`), Zod 4 messages name the expected shape not the received value, `applyTextPatches` reports counts not text, `guarded/errorToResult` collapses unknowns to `INTERNAL` after logging.
- **Architecture is Phase-2-ready.** `createVaultServer` builds a fresh `McpServer` per request and awaits `resolveRuntime(ctx)`; no module-level state anywhere (index, analytics cache, settings, `now` all hang off `VaultRuntime`); `FrontmatterIndex` exposes `byteSize()/size()/remove()/close()` hooks a byte-bounded LRU needs; `close()` on the runtime detaches the watcher.
- **Adapter contract is storage-agnostic enough for Drive.** `Entry.size`/`modifiedAt` optional, `watch?` optional with `Caps.watch` gating in `attach()`, tools never mention `LocalFSAdapter`, `softDelete` semantics ("move into `.trash/`") match the Phase 3 outline, `search` takes `pathPrefix` rather than FS paths.
- **Tool surface is complete and disciplined.** 20 vault tools + ping, every one with `title`/description(20–600)/4 annotations/`outputSchema`, annotation table exactly matches spec §5, `tools/list` deterministic and `cacheHints` public; batch read budgets `MAX_RESULT_CHARS` across notes; `touch()` keeps the index coherent after every markdown mutation incl. folder move/delete.
- **Good engineering judgment in the deviations:** literal search (ReDoS), `yaml` over gray-matter (ADR 0004 cites the process-global memo cache), overlap-aware patch ambiguity, tz-aware daily notes with noon anchoring to dodge DST, canvas ids in Obsidian's 16-hex format, timestamped trash collisions.
- Docker stack is sane: multi-stage, non-root, ripgrep + curl healthcheck, `.dockerignore` excludes secrets/tests/docs/vault, compose healthcheck-gated Postgres, HOST_UID/HOST_GID mapping avoids the readonly-builtin trap.

---

## Issues

### Critical (Must Fix)

None. No input reached outside the vault root or into `.obsidian`/`.trash` through any tool argument.

### Important (Should Fix)

1. **`softDelete` moves files *outside the vault* when `.trash` is a symlink** — `src/storage/local-fs.ts:399-405`. `fromAbs` is checked with `assertInsideRoot` but the trash target `toAbs` is not. Probe: `ln -s /outside vault/.trash; softDelete('notes/a.md', true)` → file landed in `/outside/notes/a.md`. Same precondition as every other symlink check (attacker plants a link out-of-band), so it is defense-in-depth, but it is the *only* hole in an otherwise complete guard and it exfiltrates/mutates outside the root. This is the Task 6 deferred minor that was slated for the "final fix wave" and never landed. Fix: `await this.assertInsideRoot(toAbs)` after computing the target (before `mkdir`), and add a test with a symlinked `.trash`.

2. **`searchRipgrep` bypasses `assertInsideRoot` on `pathPrefix`** — `src/storage/local-fs.ts:410-421, 471`. `search()` normalizes the prefix but only the JS fallback (via `list()`) checks it resolves inside the root; the rg branch passes `this.abs(prefix)` straight to ripgrep. ripgrep follows a symlink given as an explicit root path (walkdir `follow_root_links` default), so `pathPrefix: 'linkdir'` with `linkdir → /home/user` would grep `*.md/*.txt/*.json/*.csv` outside the vault and return `../../…` paths via `rel()`. Not probed (no `rg` here) — reasoning-based, but the asymmetry with the JS path is certain. Fix: in `search()` do `const baseAbs = this.abs(prefix); await this.assertInsideRoot(baseAbs);` plus the same NOT_FOUND/"is a file" stat checks the JS path gets from `list()`, before dispatching to either implementation. Also add `--no-ignore` (rg honours in-vault `.gitignore`/`.ignore`, the JS path doesn't — divergent results between prod and tests).

3. **The production search path has never executed.** Docker ships `ripgrep` → `nativeSearch: true` → every `vault_search` in the acceptance environment takes `searchRipgrep`; that code is `skipIf`'d locally (rg absent), CI doesn't install rg, and `scripts/docker-smoke.sh` never calls `vault_search`. Plan exit checklist item "Ripgrep suite executed at least once locally" is unmet. Fix: `sudo apt-get install -y ripgrep` step in `.github/workflows/ci.yml` so the parity test runs; add a `vault_search` step to `docker-smoke.sh`; extend the rg suite with the symlink-prefix case from (2) and a `--`-prefixed query (spec §8.2 argv-injection intent — `--` separator is present in the argv but no test proves it).

4. **Result-size cap (spec §8.7, Global Constraint 120k chars) not enforced on three outputs.**
   - `vault_list` (`src/tools/manage.ts:37-47`): depth up to 50, unbounded entries. A 3k-note vault with `depth: 50` yields ~300k chars of text + structuredContent. Suggest `MAX_LIST_ENTRIES` (e.g. 1000) + `truncated: boolean` in the outputSchema.
   - `vault_search_frontmatter` (`src/tools/search.ts:61-75`): `exists: true` on `tags` returns every note. Suggest a hit cap + `truncated`.
   - `vault_search` match text (`src/storage/local-fs.ts:445, 492`): a match on a long line (a `.json`/`.canvas` text node, a one-line minified file) returns the whole line, ×50. Suggest a per-match window (e.g. 300 chars around the first occurrence).

5. **`DAILY_NOTES_FORMAT` / `DAILY_NOTES_FOLDER` are not validated at startup (config fail-closed)** — `src/config.ts:49-50` vs `:91-99` (timezone *is* validated). `DAILY_NOTES_FORMAT=YYYY-MM-DD` — the exact string Obsidian's Daily Notes plugin shows — passes config, then every daily tool fails at call time with `INVALID_INPUT: Use yyyy instead of YYYY` (probed). Likewise `DAILY_NOTES_FOLDER=.obsidian` or `journal/..` only fails on first call. Fix: in `main.ts` (or `createLocalRuntime`) render `resolveDailyNotePath(settings, now())` once and exit with a `ConfigError`-style message; optionally translate moment tokens `YYYY→yyyy`, `DD→dd` in `toDateFnsFormat` since users will paste Obsidian's setting.

6. **`ripgrep` `maxBuffer` failure mode** — `src/storage/local-fs.ts:475-479`. Output over 16 MiB (≈60k JSON match lines; a one-letter query on a large vault) rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which is not `code === 1`, so the tool returns `IO: Search failed` instead of the first 50 matches. Fix: `spawn` + read stdout lines, `kill()` after `limit` matches (or at minimum treat the maxBuffer error's partial `stdout` as the result). This also addresses the deferred "`--max-count`/stop early" minor.

### Minor (Nice to Have)

7. `src/storage/local-fs.ts:147-156` — `read()` has no size guard; a multi-hundred-MB file dropped in the vault is `readFile`'d and UTF-8-decoded before `clampText`. `stat.size` is already in hand: reject above a read cap (e.g. 8× `MAX_FILE_BYTES`) with `TOO_LARGE`. If you do, label analytics `failed[]` by error code rather than dumping everything into `encoding_issues` (`src/vault/analytics.ts:88-90`).
8. `src/tools/read.ts:33-49` — spec §4 says `vault_read` on oversized notes returns a windowed slice with `offset`/`hasMore`; implemented as head-truncation with `truncated/totalChars` only, so the tail of a >120k-char note is unreachable. Spec §9 assigns "result-size windowing" to Phase 4 — **plan/spec scheduling, not an implementation defect**; record it so it isn't lost.
9. `src/vault/analytics.ts:38` — `WIKILINK` target class `[^\]|#^]+` still spans newlines (Task 10 deferred → "final fix wave", not done): `[^\]|#^\n]+`. `:115` per-link `[...otherPaths].some(...)` — precompute a basename `Set` (same deferred item).
10. `src/storage/local-fs.ts:196, 303` — `failed[].path` reports the raw input while `missing[]` reports the normalized path (Task 5 deferred): use the normalized path when normalization succeeded. Also the accepted TOCTOU window (check → mkdir/writeFile/rename) is still undocumented in code; add the comment on `assertInsideRoot`.
11. `src/storage/path-policy.ts:29` + probe — NFC normalization of *input* means a file stored NFD on disk (`é.md`, e.g. synced from macOS/iCloud) is returned by `vault_list` but `vault_read` of that same string says `does not exist`. Options: on ENOENT retry the NFD form, or normalize `list()` output consistently and document. Relevant for Drive too (Drive preserves the uploader's form).
12. `src/storage/path-policy.ts:9,38` — `WINDOWS_DRIVE = /^[a-zA-Z]:/` fires before `FORBIDDEN_CHARS`, so `a:b` is rejected with "absolute paths are not allowed"; harmless but misleading — check forbidden chars first or anchor the drive regex to `^[a-zA-Z]:(\/|$)`.
13. `src/storage/local-fs.ts:128` — `assertInsideRoot` maps every non-ENOENT `realpath` error (ENOTDIR when an ancestor is a file, ENAMETOOLONG for a 300-char segment — both probed) to `IO: Could not resolve path.`; ENOTDIR → `INVALID_INPUT: <ancestor> is a file`, ENAMETOOLONG → `INVALID_PATH` would be actionable.
14. `src/storage/local-fs.ts:222-241` — `write(..., {mergeFrontmatter:true})` over a note whose existing YAML is invalid silently drops that frontmatter (read degrades to `{}`); either surface a warning in the tool text or refuse with `INVALID_INPUT` so the caller knows keys were not preserved.
15. `src/storage/local-fs.ts:366-371` — `move()` runs `mkdir(dirname(toAbs))` before `rename`; moving a folder into its own subtree fails (EINVAL → IO) but leaves the freshly created empty directory behind. Check `to.startsWith(from + '/')` up front.
16. `src/tools/write.ts:11-17, 63-66` — `decodeBase64Strict` decodes before any size check (bounded only by the 2 MB body limit; a length pre-check `cleaned.length > ceil(MAX_FILE_BYTES*4/3)+4 → TOO_LARGE` gives the actionable error the plan asks for); the success result echoes the raw `path` argument while every other tool echoes the normalized path.
17. `src/vault/canvas.ts:25` — `z.url()` accepts any scheme (`javascript:`, `file:`) for link nodes; restrict to `http(s)`/`obsidian:` if you don't want arbitrary schemes written into canvases Obsidian will render.
18. `src/tools/daily.ts:44-52` — existence check downloads the whole note (`adapter.read`) and turns a non-UTF-8 daily note into a tool error rather than `exists: true`. Fine on FS, expensive on Drive (Phase 3 note; see recommendations for an adapter `stat`).
19. `src/vault/daily-notes.ts:32` — `%j → DDD` works (probed: 240) but date-fns prints a console warning on every use; pass `useAdditionalDayOfYearTokens: true` to `format()` (Task 8 deferred).
20. `src/storage/local-fs.ts:212-219` — a crash between `writeFile(tmp)` and `rename` leaves an invisible `.name.hex.tmp`; consider sweeping `*.tmp` dotfiles on `create()`.
21. `tests/storage/local-fs-nav.test.ts:176`, `tests/vault/frontmatter-index.test.ts:92` — the 300 ms sleep stands in for chokidar's `ready`; flake risk is low (5 s poll deadlines, only first/last event asserted) but a slow CI runner could miss the `add`. Exposing readiness from `watch()` (or `awaitWriteFinish`-independent `ready` promise) would make them deterministic.
22. `docs/plans/README.md:10` — Phase 1 status still reads "Task 16 … remaining"; plan exit checklist boxes unticked. Update at merge. Deviations list is accurate.
23. Tool arg hygiene: `vault_search.query`, `vault_list.glob`, `vault_search_frontmatter.field` have no `.max()`; a 200 KB query hits E2BIG in `execFile` → `IO`. Add `.max(1000)`-style bounds.

---

## Ledger triage

**Rulings**
- T12 interim resolver in `main.ts` → **closed** (T15 wired `config.storage`; `main.ts:18-32`).
- Phase 0 carry-over `startServer(config, logger, resolveRuntime, listenPort?, opts?)` + error handlers after `/mcp` → **closed, verified** (`server.ts:12-18`, `app.ts:72-94`).
- Heroku deferred / Task 16 Docker stack → **closed** (stack present, `compose config` valid).
- main fast-forwarded per task → **note**: main == 23534ca already; findings above become a fix wave on main.
- Obsidian-forbidden characters rejected → **justified, keep** (also closes backslash-URI bypass; only side effect is the misleading `a:b` message, Minor 12).
- Overlap-aware `countOccurrences` → **verified** (`text-diff.ts:4-13`).
- `awaitWriteFinish: false` → **justified, keep** (temp+rename means our own writes are never observed partial; external in-place editors only cost extra refreshes).
- `attach()` refresh-vs-remove race **parked** → **keep parked** (rebuildable cache; revisit with per-tenant path serialization in Phase 2 when per-tenant runtimes exist).
- Bare-name `ConfigError` contract → **verified closed** (`config.ts:84-99`).
- HOST_UID/HOST_GID mapping → **verified, keep** (`compose.yaml:4`; `/app` stays node-owned but is read-only at runtime, fine).

**Phase 1 deferred minors**
- T2 binary blob of `path-policy.ts` at fc8661b → **keep deferred** (confirmed `file` = data; no history rewrite now that main is pushed).
- T5 TOCTOU comment; normalize `failed[].path` → **fix in wave** (Minor 10; two lines).
- T6 `softDelete` assertInsideRoot on trash target → **fix before merge** (upgraded to Important 1; probe showed escape).
- T6 rg `--max-count`/stop early → **fix in wave** with Important 6 (streaming) or defer to Phase 4 if streaming is judged too big.
- T7 detach outside try/finally; `equals` key-order sensitive; bare `{field}` semantics undocumented → **keep deferred** (test hygiene / doc); add a one-line JSDoc on `FrontmatterQuery`.
- T8 template/format errors → INVALID_INPUT → **closed** (96c6f46, verified by probe).
- T8 `%j`→`DDD` warning → **fix in wave** (Minor 19, one option flag).
- T8 `formatInVaultZone` exported → **closed** (used by `tools/daily.ts`).
- T9 normalized canvas `file` path → **closed** (96c6f46, `canvas.ts:107`).
- T10 WIKILINK newline; otherBasenames Set → **fix in wave** (Minor 9; promised for the final fix wave).
- T11 `Partial<VaultSettings>` vs nested partial → **closed** (implementation follows Step 5).
- T12 interim shutdown order → **closed** (`main.ts:40-42` closes server, then runtime).
- T13 `truncated` false-positive at exactly `limit` → **keep deferred to Phase 4** (needs a "hasMore" signal from the adapter alongside windowing).
- T13 redundant pre-normalize in `vault_list` → **keep** (harmless defense).
- T16 restart-policy note → **keep** (`unless-stopped` is fine for a dev stack).

**Carry-over Phase 0 deferred minors**
- zod `^4.4.3` vs `^4.2.0` → **closed/no action**.
- `@hono/node-server` peer warning → **no action** (transitive via the MCP express adapter; no warning observed in `npm ci` output of the Docker build per T16).
- `ALLOW_INSECURE_PUBLIC_URL` accepts any scheme → **Phase 2** (config hardening with auth).
- No non-leak tests for PORT/LOG_LEVEL/whitespace PUBLIC_URL → **Phase 2**.
- `key as (typeof REQUIRED)[number]` cast → **keep deferred** (still at `config.ts:63`).
- Logger depth-2 wildcard/cookie tests; bare `code` redact key → **Phase 4** / **accepted**.
- app.test `handler.close()` not called → **keep deferred** (also true of `tests/tools/harness.ts`; suites are green and exit cleanly).
- ping `era` assertion → **keep deferred** (trivial; fold into Phase 4 taxonomy pass).
- Live streaming exchange across `close()` → **Phase 4**.
- Timer not cleared in shutdown `.catch`; `throw error` after `process.exit` → **no action**.
- `httpServer.close()` error rejects before `handler.close()` → **keep deferred** (still present `server.ts:44-56`; `main.ts` hard timer covers).
- localhost Origin allowed in prod → **Phase 2 auth**.
- package.json init noise / unused `pino-pretty` → **keep deferred** (cleanup commit anytime).
- `ReturnType<typeof loadConfig>`; redaction depth; `err.message` never redacted → **Phase 4**.

---

## Recommendations (Phase 2/3 notes)

1. **Adapter contract additions to make now, while there is one implementer:** `write/append/writeBinary` should return `NoteMeta` (today `vault_write`/`vault_append` re-`read()` the whole note just for `size` — on Drive that is a second media download per write); add `stat(path): Promise<NoteMeta | null>` (used by `vault_daily_note_path`, `move`/`softDelete` existence checks, and a cheap read-size guard). Make `Match.line` optional or document `0` for backends without line numbers (Drive `fullText contains`).
2. **Per-tenant runtime resolution:** `createVaultServer` awaits the resolver before registering vault tools, so an unauthenticated request must be rejected by `requireBearerAuth` *before* the factory runs — keep `brainstem_ping` registration before the resolver call as it is now, or ping will also require auth. Build the `FrontmatterIndex` lazily/asynchronously in the LRU (first-request latency on a 10k-note vault is seconds); `byteSize()` counts UTF-16 chars of `JSON.stringify`, fine as an LRU weight but label it as an estimate.
3. **Concurrency:** `edit`, `append`, canvas mutations and `softDelete` are read-modify-write without serialization; two concurrent calls on one note lose an update. Acceptable for Phase 1; Phase 2 should add a per-(tenant,path) async mutex in the runtime (also closes the parked `attach()` race).
4. **Drive `search` semantics:** `pathPrefix` scoping, `caseSensitive`, and line numbers all differ on Drive; the tool description already says "literal substring" — plan to add a `Caps`-driven note in the description or a `precision` field in results so the model isn't misled.
5. **Unicode:** decide NFC vs NFD policy at the adapter boundary before Drive (Minor 11); Drive names should be compared in NFC on the path↔fileId map.
6. **Ops:** CI should install ripgrep so the parity suite runs (Important 3); consider a `develop.watch` section in compose for the dev loop, and a `.tmp` sweep at startup.

---

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The security boundary, tool surface, and architecture are sound and well-tested (119 green, no Critical findings, no leakage, Phase-2-ready runtime resolution), but two symlink-guard gaps (`softDelete` trash target — probe-confirmed escape — and the untested ripgrep prefix path), the unenforced 120k-char cap on `vault_list`/`vault_search_frontmatter`/search lines, and the never-executed production search path should land as a short fix wave (with `rg` in CI and in the smoke script) before Phase 1 is declared accepted.
