# Security policy

brainstem-mcp is an OAuth 2.1 authorization server plus an MCP server that
exposes your Obsidian vault to Claude over a public tunnel. Security reports
are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for anything that could be exploited.

- Preferred: GitHub → *Security* tab → **Report a vulnerability** (private
  vulnerability reporting).
- Fallback: e-mail the maintainer at the address on the commits
  (`git log -1 --format=%ae`).

Include what you found, how to reproduce it, and the commit or tag you tested.
You should hear back within a week. Fixes ship as a new tag and a note in
`CHANGELOG.md`; you will be credited unless you prefer not to be.

## Supported versions

Only the latest tag on `main` is supported. `./brainstem update` moves you to
it.

## Scope

In scope: anything reachable through the public URL — `/mcp`, the `/oauth/*`
endpoints and consent page, the metadata documents, `/health` — and the CLI's
handling of `.env` and `_brainstem/state.json`.

Out of scope: vulnerabilities in Docker, cloudflared, Node.js or Claude itself
(report those upstream), and attacks that require the owner secret or the
host machine.

## Design notes for reviewers

`README.md` → *Security model* summarises the guarantees; the binding design is
`docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md`, and the
adversarial reviews that shaped the implementation are in `docs/reviews/`.
