# Changelog

All notable changes to brainstem-mcp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Owner-editable instructions for Claude: `<vault>/_brainstem/instructions.md`
  (seeded at first start) is sent as the MCP server's `instructions` on every
  connection, on top of a fuller built-in guide to the vault tools.
- Prebuilt images on GHCR (`ghcr.io/vaneavasco/brainstem-mcp`,
  `…/brainstem-mcp-tunnel`; amd64 + arm64) for every commit on `main` and every
  release tag. `./brainstem up` pulls the image for the checked-out commit and
  only builds locally when nothing matches (`--build` forces a build,
  `--no-build` refuses one).
- `AGENTS.md` (+ `CLAUDE.md` importing it) for coding agents working on the
  repo, and `llms.txt` pointing LLMs at the right documents.

### Changed

- `./brainstem up` / `start` default to pulling the prebuilt image instead of
  building. `--no-build` keeps its meaning (never build) but now tries the
  registry first and only then reuses the last local build; new `--build`
  forces a local build.
- `./brainstem update` restarts with a plain `up`, so it runs the prebuilt image
  of the commit it just pulled instead of forcing a local rebuild.

## [0.1.0] — 2026-08-30

First public release. Beta: verified end-to-end on Linux with Claude Code and
claude.ai web; see *Status* in `README.md` for what is not yet verified.

### Added

- 21 vault tools over a local Obsidian vault (list, search with ripgrep, read,
  write, append, move, soft-delete to `.trash/`, frontmatter update, daily
  notes, canvas, analyze …), served over MCP Streamable HTTP with the
  official TypeScript SDK 2.0.
- Single-user OAuth 2.1 authorization server: Client ID Metadata Documents
  (host allowlist, SSRF-hardened fetch), PKCE, consent page gated by an
  owner secret with lockout, refresh-token rotation with family revocation,
  `/oauth/revoke`, Protected Resource Metadata, rate limiting.
- All server state as hashed JSON in the vault's reserved `_brainstem/`
  folder, so a synced vault carries the state to another machine.
- Cloudflare tunnel in two modes: `cloudflare` (named tunnel, stable URL,
  `TUNNEL_TOKEN`) and `quick` (trycloudflare.com URL, rotates on restart,
  written to `_brainstem/connection.md`); `none` for Claude Code only.
- Cross-platform launcher (`./brainstem`, `brainstem.cmd`) and TypeScript CLI:
  `start`, `setup`, `up`, `down`, `status`, `url`, `logs`, `secret`, `update`,
  `doctor`, `revoke-all`.
- Docker Compose deployment (app + tunnel), CI with unit/integration suites
  and a Docker smoke test, `npm run mcp:call` headless client for developers.

[Unreleased]: https://github.com/vaneavasco/brainstem-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vaneavasco/brainstem-mcp/releases/tag/v0.1.0
