# Phase 3′ — final whole-branch review and fix wave (2026-08-30)

Branch `phase-3-launcher`, range `aa0ed19..c258eac` (10 commits: 5 tasks + one fix wave). Plan: `docs/plans/2026-08-29-phase-3-launcher-and-hardening.md`. Same SDD process as Phase 2′. Final state: 337 tests passing + 7 ripgrep-gated; lint/typecheck clean; CI `verify` and `docker-smoke` jobs green.

## What the phase delivered

`git clone … && ./brainstem start` (Windows `.\brainstem start`) is the whole install: the launcher checks Node ≥ 24 and Docker, installs runtime dependencies when stale (identical `node` one-liner on both platforms; `BRAINSTEM_SKIP_INSTALL=1` opts out; an existing dev install is preserved), and delegates to the TypeScript CLI. New commands: `doctor` (checks with per-platform remedies), `start` (doctor → setup on first run → up), `update` (git pull --ff-only → npm ci → child `up --build`). One command catalog drives commander descriptions, the grouped help (`./brainstem help`, the user documentation) and a README consistency test. Hardening: `.env` quoting for `$`/quotes, unauthenticated `/mcp` bucket in front of the bearer gate (shape-checked), CIMD fetch overall deadline, compose env passthrough, CI docker-smoke job.

## Final review verdict and fix wave

"With fixes" — fixed in `3836221`, `75b188d`, `c258eac`: `update` now works on Windows (`shell` on win32, quoted `process.execPath`) and reports git's real stderr; every runtime message speaks `./brainstem …` (and `start` suppresses setup's `Next:` line); the launchers keep dev installs and no longer hide `npm ci` errors (`--loglevel=error`); README uses `.\brainstem` for Windows; the unauth bucket applies to malformed `Authorization` headers too; `start` runs the full doctor once `.env` exists; the help shows one grouped command list; the doctor no longer cascades three failures when Docker is missing; `.gitattributes` normalizes line endings.

## Fix-later (recorded, not blocking)

- `BEARER_SHAPE` in `src/auth/mount.ts` is case-sensitive on the scheme (`Bearer`); RFC 6750 clients sending `bearer` are throttled by the 20/5 bucket instead of the 60/60 one (never rejected). Add the `i` flag.
- Hiding commander's built-in command list also removed the `Did you mean …?` suggestion for unknown commands; scope the `visibleCommands` stub to help rendering.
- The M7 test uses 25 requests against a 20-token bucket (thin margin); use 40 like the neighbouring test.
- Launcher negative-PATH test passes by accident (PATH strips `dirname`); the launcher test requires a `docker` binary; non-TTY `start` cannot choose quick/none (no `--tunnel-mode` flag); `start` reads `.env` twice.
- Earlier fix-later items from Phase 2′ remain listed in `docs/reviews/2026-08-29-phase-2-final-review.md`.

## Owner-run acceptance (pending)

Windows: `.\brainstem start`, `.\brainstem update` (the `.cmd` was verified by reading only); macOS launcher; first run on a clean clone; plus the Phase 2′ items (Claude Code + claude.ai/phone via tunnel, cloudflare-token mode).
