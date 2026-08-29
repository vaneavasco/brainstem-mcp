# Phase 2′ — final whole-branch review and fix wave (2026-08-29)

Branch `phase-2-single-user`, range `3671878..5f5b63a` (28 commits, 16 tasks + one fix wave). Plan: `docs/plans/2026-08-28-phase-2-single-user-auth-cli.md`. Spec: `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md`. Executed with subagent-driven development: fresh implementer per task, spec+quality review per task, scoped re-review per fix round, whole-branch review at the end. Final state: 294 tests passing + 7 ripgrep-gated (301/301 with `rg` on PATH), lint/typecheck clean, Docker smoke passing, quick tunnel observed live.

## Final review verdict

"With fixes" — the security core (bearer gate with audience binding, PKCE + single-use self-contained codes, refresh rotation with family revocation, CIMD SSRF guard, consent CSRF/XSS/open-redirect handling, hashed state, reserved `_brainstem/` policy) was found correct with no unauthenticated path to `/mcp` and no secret leakage. Three behaviour bugs blocked the merge and were fixed in one wave (`1d91434`, `2601510`, `5f5b63a`):

| # | Finding | Fix |
|---|---|---|
| C1 | `revoke-all --reset` unlinked `state.json`; the running app treated a failed `stat` as "unchanged" and later recreated the file with every token | `--reset` writes the empty v1 document atomically; `reloadIfChanged` treats ENOENT as "file removed" and resets the in-memory doc |
| C2 | double-quoted `.env` values are escape-expanded by Compose's dotenv parser (Windows paths with spaces) | values with spaces/`#` are single-quoted (literal in compose-go and Node); escaped double quotes only when the value contains `'` |
| C3 | a stale `public-url` file made the app boot with the previous tunnel URL and `up` print it | supervisor removes the file before every quick-mode spawn; `up` requires two matching `/health` polls 3 s apart; `PUBLIC_URL_FILE` ignored unless `TUNNEL_MODE=quick` |
| I1 | `lastUsedAt` written on every `/mcp` call into a synced folder | written at most every 5 min; heartbeat 5 min, freshness window 15 min |
| I2 | unauthenticated `/oauth/authorize` could bloat pending rows | live pending rows capped at 16 (oldest evicted) |
| I3 | ripgrep search branch had no `_brainstem` exclusion test | test added inside the ripgrep-gated suite (runs in CI) |
| I4 | a corrupt store at runtime produced silent 500s | mapped to a logged `OAuthError(server_error)` |
| I5 | docs dated 2026-08-28 for work that landed 2026-08-29 | corrected |
| I6 | `PUBLIC_URL` with a path prefix half-worked | rejected at config time (bare origin required) |

Also in the wave: Cloudflare token passed to `cloudflared` via `TUNNEL_TOKEN` env (not argv), one OAuth rate-limiter bucket mounted once, compose `TUNNEL_MODE` default `quick` for both services, Docker `HEALTHCHECK --start-period=130s`, warn when `resource` is defaulted, docs staleness (plan §3/§4, plans README, `package.json` description).

## Fix-later (recorded, not blocking)

- `.env` double-quote fallback (values with `'` **and** `\`/`"`) is read differently by Node `--env-file` (dev only) than by Compose; emit the single-quote form with `'\''` splicing and quote values containing `$` too.
- `up`'s URL-settle loop is bounded at ~10 × 120 s, not 120 s total.
- `docker-smoke` CI job (GitHub runners have Docker); the smoke seeder accumulates `smoke` tokens on repeated local runs.
- Rate limiter runs before auth on `/mcp` (unauthenticated callers can drain the owner's bucket); CIMD fetch timeout is idle-based (add an overall deadline); compose `environment:` drops `DAILY_NOTES_TEMPLATE`, `REQUIRED_FRONTMATTER`, `STATE_DIR` (document or pass through).
- `writeAtomic` leaves an orphan tmp on rename failure and exists in three copies (dedupe into one helper); `brainstem.ts` `isMain` check is fragile on Windows (drive-letter case/symlinks).
- RFC 6749 §10.5: a replayed authorization code should revoke the tokens it minted (needs `familyId` on `CodeRecord`); heartbeat writes discard `otherHost`; `--public-url` without `--tunnel-token` should be an error; `CIMD_ALLOWED_HOSTS=","` should be rejected; bare PRM shim lacks `cors`/405; add `64:ff9b:1::/48` and `5f00::/16` to the IPv6 special-use table; test matrix for `unsupported_response_type` / missing `state` / array query params; assert `state` on the e2e authorization URL; fixed-sleep watcher tests are the main CI flakiness risk.
- Spec deviations recorded in `docs/plans/README.md`: `--reset` writes an empty file instead of deleting; heartbeat 5 min (spec said 60 s); e2e stubs the CIMD resolver (fetch path covered by `tests/auth/cimd.test.ts`).

## Owner-run acceptance (pending)

See the Acceptance log at the end of the phase plan: Claude Code via the tunnel URL; claude.ai web + phone writing a note that appears in Obsidian; `docker compose restart tunnel` ⇒ new URL ⇒ self-restart + `connection.md`; cloudflare-token mode; Windows `setup`/`up` with polling watch.
