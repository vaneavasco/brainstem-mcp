# Phase 1 final-review fix wave — report

Branch `phase-1-core-tools`, starting HEAD `23534ca`. Implements items A–G of the fix-wave brief
(`final-review-report.md`'s Important #1, #2, #3, #4, #5, #6 and the ruled-in deferred minors).
Nothing outside the listed items was touched. Four commits, one per group below.

Environment note: `rg` is not installed on this host by default. To actually exercise the
`describe.skipIf(!hasRipgrep())` ripgrep suite (rather than trust it by inspection), a static
`ripgrep 14.1.1` binary was downloaded from the upstream GitHub release into the session scratch
directory and prepended to `PATH` for verification runs only — nothing was installed into the
repo or system-wide, and no `.env`/config was changed. Every "with `rg`" command below shows this.

---

## Commit 1 — `71207fd` fix(storage): check soft-delete trash target and search prefix inside the vault root; stream ripgrep

**A. `softDelete` checks the trash target (Important #1).**
`src/storage/local-fs.ts`: `softDelete` now calls `await this.assertInsideRoot(toAbs)` right
after computing the (possibly stamped) trash target, before `fs.mkdir`. Previously only `fromAbs`
was checked, so a symlinked `.trash` could redirect the "deleted" file outside the vault.

- Test added: `tests/storage/local-fs-nav.test.ts` → `softDelete > refuses to trash into a
  symlinked .trash directory, leaving the file in place`. Creates an outside temp dir, symlinks
  `root/.trash` to it, asserts `softDelete` throws `INVALID_PATH`, the original file is untouched,
  and the outside directory stays empty.
- Verified red before the fix (`expected a VaultError`), green after.

**B. `search()` validates `pathPrefix` before dispatch (Important #2).**
`src/storage/local-fs.ts`: `search()` now does, once, before choosing the rg or JS path:
```ts
const prefixAbs = this.abs(prefix);
await this.assertInsideRoot(prefixAbs);
const st = await this.statOrNull(prefixAbs);
if (!st) throw new VaultError('NOT_FOUND', `${prefix || '/'} does not exist.`);
if (!st.isDirectory()) throw new VaultError('INVALID_INPUT', `${prefix} is a file, not a folder.`);
```
Also added `'--no-ignore'` to the ripgrep argv so in-vault `.gitignore`/`.ignore` files can't hide
notes from search (the JS fallback never honored them either — this makes the two consistent).

- Tests added (JS path, `tests/storage/local-fs-nav.test.ts`): `search (JS fallback) > validates
  pathPrefix before dispatching, refusing a symlink escape` — a symlinked folder → `INVALID_PATH`,
  a missing folder → `NOT_FOUND`, a file path (`board.canvas`) → `INVALID_INPUT`. (These already
  passed even before the fix, because the JS path goes through `list()`, which already validated
  the prefix — confirms the fix is closing the *rg-only* gap without changing JS behavior.)
- Tests added (rg suite, `describe.skipIf(!hasRipgrep())`): symlink-prefix → `INVALID_PATH`; a
  query beginning with `-` (`'-milk'`) is treated as a literal, not a flag; a `.gitignore` that
  would hide `02-areas/` is ignored (matches the JS fallback, which never honored `.gitignore`).

**C. Stream ripgrep and stop at the limit (Important #6).**
`searchRipgrep` rewritten from a buffered `execFileAsync` (`maxBuffer: 16 MiB`, entire process
runs to completion before any parsing) to `spawn(this.rg, args)` piped through
`readline.createInterface`. Each JSON line is parsed as before; once `out.length >= limit` the
readline interface is closed and the child is killed immediately, instead of buffering unbounded
output. The promise resolves when the child's `close` event fires with exit code 0 or 1 (rg's
"no matches" code), or when the result was cut short by our own `kill()`; any other exit code, or
an `error` event, rejects with `VaultError('IO', 'Search failed.')` — stderr is drained but never
surfaced (it can contain vault-relative paths). `execFileAsync` (and the `execFile`/`promisify`
import) are kept for `detectRipgrep`, which only ever runs `rg --version`. Added
`'--max-count', String(limit)` (per-file cap, harmless now that the global cap is enforced by the
stream) to the argv.

- Test added (rg suite): `stops reading once the limit is reached on a large result set` — writes
  200 files each containing the query, asserts a `limit: 5` search returns exactly 5 matches
  (would previously have parsed and discarded ~200 buffered matches after the whole process ran).

**Also (item G, local-fs.ts minors ruled into this wave):**
- Documented the accepted TOCTOU window in a comment above `assertInsideRoot` (check-then-write,
  not a lock; acceptable for the current single-user local-vault threat model, flagged for
  revisit if this adapter is ever used multi-tenant on a shared filesystem).
- `batchRead`/`batchFrontmatterUpdate` now report the *normalized* path in `failed[].path` when
  `normalizeVaultPath(raw)` succeeds, falling back to `String(raw)` only when the raw input itself
  doesn't normalize (a new `normalizedOrRaw` helper).
  - Tests added in `tests/storage/local-fs-core.test.ts`: `batchRead(['./bad.md'])` now reports
    `path: 'bad.md'` (previously `'./bad.md'`); `batchRead(['..'])` and a `..` entry in
    `batchFrontmatterUpdate` still fall back to the raw `'..'` since it can't be normalized.

**Commands + output (this commit, verified before committing):**
```
npm run typecheck            # clean
npm test                     # 123 passed | 5 skipped (rg absent, host default)
PATH=<rgbin>:$PATH npm test  # 128 passed, 0 skipped (rg 14.1.1 on PATH)
npm run lint:fix             # Checked 56 files. No fixes applied.
npm run build                # clean
```

---

## Commit 2 — `1028f7e` fix(tools): enforce result caps on list, frontmatter search and match text

**D. Result caps (Important #4).**
`src/storage/limits.ts`: added `MAX_LIST_ENTRIES = 2000`, `MAX_FRONTMATTER_HITS = 500`,
`MAX_MATCH_TEXT_CHARS = 400`.

- `LocalFSAdapter.search` (`src/storage/local-fs.ts`): both `searchJs` and `searchRipgrep` now
  window each match's `text` through a new `windowMatchText()` helper
  (`text.length > 400 ? text.slice(0, 400) + '…' : text`).
- `vault_list` (`src/tools/manage.ts`): slices `entries` to `MAX_LIST_ENTRIES` and returns
  `truncated: true` when the adapter returned more; `truncated: z.boolean()` added to
  `outputSchema`; description now says "Returns at most 2000 entries; narrow with
  path/glob/depth if truncated."
- `vault_search_frontmatter` (`src/tools/search.ts`): same pattern for `hits` /
  `MAX_FRONTMATTER_HITS`; description updated similarly.
- `okJson` (`src/tools/results.ts`): the text block (custom `text` or the default
  `JSON.stringify(structured)`) is now passed through `clampText(...).text` before being placed
  in `content[0].text`; `structuredContent` is left untouched (so a truncated text block never
  desyncs from the real data a client can read via `structuredContent`).

**Tests added:**
- `tests/tools/results.test.ts`: `okJson` clamps an oversized text block (both the default
  JSON-stringified case and a custom oversized `text` argument) while `structuredContent` stays
  intact.
- `tests/tools/search-manage.test.ts`:
  - `vault_search_frontmatter`'s existing normal-case test now also asserts `truncated: false`.
  - New: `caps hits at MAX_FRONTMATTER_HITS and sets truncated` — seeds 505 index entries
    directly via `h.runtime.index.upsert(...)` (fast, deterministic — avoids the flakiness of a
    file-watcher-driven index rebuild), asserts exactly 500 hits and `truncated: true`.
  - `vault_list`'s existing normal-case test now also asserts `truncated: false`.
  - New: `caps entries at MAX_LIST_ENTRIES and sets truncated` — writes 2005 tiny files directly
    to disk under the harness's vault root, asserts exactly 2000 entries and `truncated: true`.
- `tests/storage/local-fs-nav.test.ts`: `windows a long match line to avoid huge result payloads`
  (JS fallback) and the rg-suite equivalent — a 5000-char line's match `text` is capped at 401
  chars (400 + the `…` marker) in both search code paths.

**Commands + output:**
```
npm run typecheck            # clean
npm test                     # 133 passed, 0 skipped (rg on PATH for this run)
npm run lint:fix             # Checked 56 files. No fixes applied.
npm run build                # clean
```

---

## Commit 3 — `cd598d3` fix(config): validate daily-note folder/format at startup; accept moment-style YYYY/DD

**E. Daily-note settings validated at startup + moment-format compatibility (Important #5).**

`src/vault/daily-notes.ts`:
- `toDateFnsFormat`: when the format contains no `%` (i.e. it isn't a strftime pattern), it is now
  run through a narrow moment-token translation — `YYYY`→`yyyy`, `YY`→`yy`, `DD`→`dd`, applied in
  that order (longest-first, so a `YYYY` run isn't partially eaten by the `YY` pass) — before being
  handed to date-fns. This is documented in a code comment as a narrow compatibility shim (only
  these three tokens), specifically so Obsidian's own Daily Notes default (`"YYYY-MM-DD"`) is
  accepted without a translation error.
- `formatInVaultZone`'s single `format(...)` call site now passes
  `{ useAdditionalDayOfYearTokens: true }`, so the existing `%j` → `DDD` strftime translation no
  longer prints a `console.warn` from date-fns on every use.

`src/config.ts`: after `vaultSettings` is assembled, two new checks (both fail closed, both after
`VAULT_TIMEZONE` is already known-good):
```ts
try {
  normalizeVaultPath(vaultSettings.dailyNotes.folder);
} catch {
  throw new ConfigError([], ['DAILY_NOTES_FOLDER'],
    'DAILY_NOTES_FOLDER must be a vault-relative folder (no .., no hidden folders)');
}
try {
  resolveDailyNotePath(vaultSettings.dailyNotes, new Date());
} catch {
  throw new ConfigError([], ['DAILY_NOTES_FORMAT'],
    'DAILY_NOTES_FORMAT is not a valid date-fns/strftime pattern');
}
```
Imports added: `normalizeVaultPath` from `./storage/path-policy.ts`, `resolveDailyNotePath` from
`./vault/daily-notes.ts`.

**Deviation from the brief, verified empirically and documented in the commit message:** the
brief's suggested bad-format literal, `'YYYY-MM-DD ['`, does **not** actually throw in the
project's installed date-fns (`4.4.0`) — unbalanced brackets/quotes are treated as literal text to
end-of-string, not an error (confirmed by direct experimentation against
`node_modules/date-fns/format.js`, and by reading date-fns' own quote-handling regex/comments in
that file). Substituted `'YYYY-MM-DD [note]'`, which does throw
(`Format string contains an unescaped latin alphabet character`) because date-fns escapes literal
text with `'quotes'`, not moment's `[brackets]` — a realistic and even more on-point example of the
exact moment→date-fns incompatibility this task is about. Same fail-closed path, same assertions
(`invalid: ['DAILY_NOTES_FORMAT']`).

**Tests added:**
- `tests/vault/daily-notes.test.ts`:
  - `toDateFnsFormat('YYYY-MM-DD')` → `'yyyy-MM-dd'`; `toDateFnsFormat('YY/DD')` → `'yy/dd'`;
    confirms only these tokens are touched (`'YYYY-MM-DD HH:mm'` → `'yyyy-MM-dd HH:mm'`).
  - `resolveDailyNotePath` with `format: 'YYYY-MM-DD'` produces the same path as
    `format: 'yyyy-MM-dd'` (both → `'2026-08-28.md'`).
  - `formatInVaultZone(lateUtc, '%j', 'UTC')` no longer calls `console.warn` (spied and asserted).
- `tests/config.test.ts`:
  - `DAILY_NOTES_FORMAT: 'YYYY-MM-DD'` is accepted (`loadConfig` succeeds, raw value preserved on
    `cfg.vaultSettings.dailyNotes.format` — translation is a call-time concern, not a storage one).
  - `DAILY_NOTES_FORMAT: 'YYYY-MM-DD [note]'` → `ConfigError` with `invalid: ['DAILY_NOTES_FORMAT']`,
    `missing: []`.
  - `DAILY_NOTES_FOLDER: '../x'` and `'.obsidian'` → `ConfigError` with
    `invalid: ['DAILY_NOTES_FOLDER']` for both.

**Commands + output:**
```
npm run typecheck            # clean
npm test                     # 139 passed, 0 skipped (rg on PATH for this run)
npm run lint:fix             # Checked 56 files. Fixed 2 files (quote-style only, in the new tests).
npm run build                # clean
```

---

## Commit 4 — `40418e7` chore: ripgrep in CI and docker smoke; analytics minors; phase 1 docs

**F. Ripgrep actually runs somewhere (Important #3).**
- `.github/workflows/ci.yml`: added `- run: sudo apt-get update && sudo apt-get install -y ripgrep`
  before `npm run typecheck`/`npm test`, so the rg-suite parity test runs on every CI push/PR
  instead of being silently skipped (verified the resulting YAML parses correctly and the step
  order is as intended via a quick `yaml.parse` of the file).
- `scripts/docker-smoke.sh`: added `[4/5] vault_search finds the note`, calling
  `vault_search --tool-arg query=Smoke` against the note written in step 3 and grepping for
  `00-inbox/smoke.md` in the result; renumbered the file-on-disk check to `[5/5]`. Validated with
  `bash -n scripts/docker-smoke.sh` (no syntax errors); **not** executed against a real
  `docker compose up` stack, per instructions.

**G. Deferred minors (remaining part — analytics.ts, docs).**
`src/vault/analytics.ts`:
- `WIKILINK` regex's target character class now excludes `\n`
  (`[^\]|#^\n]+` instead of `[^\]|#^]+`), so a wikilink whose target spans a line break (e.g.
  `[[a\nb]]`, which Obsidian itself would never treat as one link) simply doesn't match at all,
  instead of being captured with an embedded newline and reported as a broken link.
- Precomputed `otherBasenames = new Set([...otherPaths].map(baseName))` once per `analyzeVault`
  call, replacing the previous `[...otherPaths].some((p) => baseName(p) === lower)` re-spread scan
  done on every single wikilink match.
- Test added in `tests/vault/analytics.test.ts`: `does not treat a wikilink target split across
  lines as a broken link` — a note containing `[[a\nb]]` produces no `broken_wikilinks` finding
  for that note (previously it did, with `detail: "a\nb"`).

Docs:
- `docs/plans/README.md`: Phase 1's status row now reads "complete 2026-08-28 — all 16 tasks plus
  the final-review fix wave"; added a new "Phase 1 — final fix wave (2026-08-28)" section
  summarizing what changed (per item A–F above) and listing every deferred Minor/Recommendation
  from the review as an explicit Phase 2/3/4 follow-up (nothing silently dropped).
- `docs/plans/2026-08-28-phase-1-core-tools-localfs.md`: ticked the exit-checklist items that now
  hold — `npm test` green (139 tests, re-verified with the full fix wave applied), the tool-surface
  test, the ripgrep suite (re-verified locally with a real `rg` binary *and* now runs in CI), and
  the parity-deviations record. Left two items unticked with an explanatory note each: the
  interactive MCP Inspector session (not re-run — `npx @modelcontextprotocol/inspector --version`
  hung fetching/starting in the fix-wave sandbox; the automated `tests/tools/*` suites and the
  updated `scripts/docker-smoke.sh` already cover the same call sequence) and an actual
  `docker compose up --build` run (intentionally not started, per the task's constraints).

**Commands + output:**
```
bash -n scripts/docker-smoke.sh   # OK, no output = no syntax errors
node -e "yaml.parse(ci.yml) ..."  # confirmed the new step lands before typecheck/lint/test
npm run typecheck                 # clean
npm test                          # 134 passed | 6 skipped (rg absent, host default)
PATH=<rgbin>:$PATH npm test       # 140 passed, 0 skipped
npm run lint:fix                  # Checked 56 files. No fixes applied.
npm run build                     # clean
```

---

## Final state

```
$ git log --oneline -5
40418e7 chore: ripgrep in CI and docker smoke; analytics minors; phase 1 docs
cd598d3 fix(config): validate daily-note folder/format at startup; accept moment-style YYYY/DD
1028f7e fix(tools): enforce result caps on list, frontmatter search and match text
71207fd fix(storage): check soft-delete trash target and search prefix inside the vault root; stream ripgrep
23534ca docs(docker): document postgres host port 5433; HOST_UID/HOST_GID user mapping

$ git status
nothing to commit, working tree clean
```

Full verification chain, run once more after all four commits:
- `npm run typecheck` — clean.
- `npm run lint:fix` — 56 files checked, no fixes needed.
- `npm run build` — clean.
- `npm test` without `rg` on `PATH` (this host's default): **134 passed, 6 skipped** (all six
  skips are in the `describe.skipIf(!hasRipgrep())` ripgrep suites in
  `tests/storage/local-fs-nav.test.ts` — expected on a machine without `rg`; CI now installs `rg`
  so this suite is no longer skipped there).
- `npm test` with a locally-downloaded `rg 14.1.1` prepended to `PATH` (verification only, nothing
  installed system-wide or committed): **140 passed, 0 skipped**.

Not done, and why: an actual `docker compose up`/`npm run docker:smoke` run against the real
compose stack (explicitly out of scope for this pass — "do NOT run docker compose up"), and a live
interactive MCP Inspector session against `npm run dev` (attempted once; `npx
@modelcontextprotocol/inspector --version` did not return within a reasonable time in this
sandbox and was killed rather than investigated further, since it is a manual/exploratory
verification step outside the TDD scope of this fix wave). Both are called out, unticked, in the
Phase 1 exit checklist with an explanation of what does cover the same ground automatically.

One judgment call worth flagging explicitly: the config test literal for an invalid
`DAILY_NOTES_FORMAT` was changed from the brief's `'YYYY-MM-DD ['` to `'YYYY-MM-DD [note]'`
because the former does not reproduce a failure against the actual installed date-fns version
(verified, not assumed) — see the Commit 3 section above for the full reasoning.
