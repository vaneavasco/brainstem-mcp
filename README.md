# brainstem-mcp

Multi-tenant remote MCP server that gives Claude (web, mobile, Desktop, Claude Code) read/write access to a personal markdown vault stored in the user's own Google Drive (or a local folder for self-hosting).

- Spec: `docs/implementation-plan.md` · Plans: `docs/plans/` · ADRs: `docs/adr/`
- Protocol: MCP 2026-07-28 (2025-era clients served via legacy stateless mode)
- Stack: Node 24, TypeScript, Express 5, `@modelcontextprotocol/server` 2.x, Postgres, Heroku

## Develop

```bash
cp .env.example .env
npm install
npm run dev          # http://localhost:3000/mcp
npm test             # vitest
npm run typecheck && npm run lint
```

## Deploy (Heroku)

See `docs/plans/2026-08-28-phase-0-scaffold.md` Task 6. `PUBLIC_URL` must be the exact https origin users will paste into Claude.
