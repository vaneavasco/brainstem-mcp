# Fix-later wave (2026-08-31)

Resolves the adjudicated "fix-later" list from the Phase 4 final review
(`2026-08-31-phase-4-final-review.md` §"Fix-later list"). Plan:
`../plans/2026-08-31-fix-later-wave.md`. One commit per task, TDD.

## Item → resolution

| Fix-later item | Resolution |
|---|---|
| nested-tag prefix rule duplicated (`graph.ts`/`query.ts`) | `src/vault/tags.ts`: `isTagOrDescendant` + `compareCaseInsensitive`, used by both — `refactor(vault): shared nested-tag rule…` |
| `tags()`/`notesWithTag()` O(T²) per call | Rollup buckets precomputed per rebuild (`rolledTagBuckets`, O(T·depth)) — `perf(graph): precompute tag rollup…` |
| `orphans()`/`hubs()` re-sort via `index.all()` per call | Entry paths cached per rebuild (`entryPaths`); no `index.all()` copy per call — same commit |
| case-sensitive tie-breaks in orphans/hubs vs case-insensitive in tags | All three (plus `notesWithTag`) share `compareCaseInsensitive` — same commit |
| `graph.ts` size + redundant `clampMatch` | Mentions machinery moved to `src/vault/mentions.ts` (tools/graph.ts 336→214 lines); one shared `clampMatchText` in `limits.ts` (replaces `windowMatchText` + `clampMatch`); the double clamp on adapter-windowed match text removed — `refactor(vault): one shared clampMatchText…` |
| CONFLICT message formatting in 3 places | `failedEntryMessage(error)` in `types.ts`, used by `batchFrontmatterUpdate` and both `vault_move` rewrite loops — `fix(storage): shared failed[] CONFLICT wording…` |
| `results.ts` CONFLICT branch assumes `details` | Verified safe (object spread of `undefined` is a no-op); pinned by a regression test: a details-less CONFLICT serializes as `{code}` alone |
| "0.0 MiB" cosmetic | `assertWithinSize` appends the MiB parenthetical only for limits ≥ 1 MiB — same commit |
| adapter methods could return post-write hashes (saves a read) | `write`/`append` → post-write `Note` (fresh stat, content from memory), `writeBinary` → hash, `edit` carries `note`, `batchFrontmatterUpdate` → `updatedNotes[]`; every write-type tool applies the returned note via `FrontmatterIndex.applyNote` instead of re-reading — `perf(storage): writes return the post-write note/hash…` |
| `touch()` no-op for non-md targets | `applyNote` tracks non-markdown paths as assets; `vault_write_binary` and the canvas tools register their target immediately (fresh attachment/canvas resolves without waiting for the watcher) — same commit, harness-pinned |
| `vault_move` handler ~170 lines inline | Planning + rewrite loops extracted to `src/tools/move.ts` (`planMove`/`applyLinkRewrites`, type-only import of `ToolContext` so the register.ts cycle stays disarmed); handler is now ~25 lines — `refactor(tools): vault_move planning…` |
| search/query Zod schema duplication | `QueryOpSchema`/`CondSchema`/`TagsFilterSchema` live in the `args.ts` leaf, imported by both tools — `refactor(tools): one CondSchema/TagsFilterSchema…` |
| sibling same-text heading paths in `listHeadingPaths` | Identical paths deduped (listed once — only the first is addressable); first-wins documented on `findSection` — `fix(vault): listHeadingPaths dedupes…` |
| NFA `MAX_SUBJECT_CHARS` off-by-a-surrogate at the cap | The cap counts code points (the unit the matcher consumes), with a cheap `length > 2×cap` pre-reject — `fix(vault): safe-regex subject cap counts code points…` |
| template placeholder grammar boundary | Non-grammar `{{…}}` blocks (space/digit-led names) are reported in `unresolved`, still left verbatim — `fix(vault): templates report non-grammar…` |
| perf-guard comment wording ("deterministic") + 2.92× margin | Seeding now actually deterministic (mulberry32, fixed seed); header states the ~3× margin explicitly as headroom, not target — `test(perf): deterministic seeding…` |
| coverage-breadth notes from Tasks 3/4 | The original task-scoped notes are no longer on disk (`.superpowers/` archives were not kept); discharged as the new breadth tests over the same surface: graph tie-breaks and rollup, `applyNote`, post-write results, immediate asset registration, regex code-point cap, template grammar edge, section dedupe |

## Re-adjudicated as documented, no code change

- **Final-segment heading ambiguity resolves in file order** — documented on
  `findSection` (now with an explicit "identical paths: first in file order
  wins" sentence). Returning an error instead would break legitimate lookups.
- **Astral `.` matches one code point** — correct behavior, now stated in the
  `safe-regex.ts` module doc as a deliberate divergence from non-`u` `RegExp`.
- **C1 residual regex cost** (~90 ms per 2048-char value, ~6 s over 2000
  notes, linear and bounded) — accepted for the single-user, owner-gated
  threat model, unchanged from the Phase 4 final review.

## Test state at close

763 tests (748 passed / 15 ripgrep-gated skips locally); typecheck, Biome and
the plain-Node boot smoke green on every task commit.
