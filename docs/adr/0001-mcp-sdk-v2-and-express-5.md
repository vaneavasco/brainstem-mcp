# ADR 0001 — MCP TypeScript SDK v2 + Express 5

Date: 2026-08-28 · Status: accepted

## Context
The v1 monolith `@modelcontextprotocol/sdk` is being retired (bugfix-only ~6 months after v2 GA). v2 (2.0.0, 2026-07-27) implements MCP 2026-07-28 (stateless core, MRTR, header routing, cache hints) and serves 2025-era clients through `legacy: 'stateless'`. Claude's 2026-07-28 rollout is in progress, so both eras must work.

## Decision
Use `@modelcontextprotocol/server` + `/express` + `/node` 2.0.0, pinned exactly, with `createMcpHandler(factory, { legacy: 'stateless' })`. HTTP framework: Express 5.2.x (owner decision 2026-08-27); the official adapter provides `createMcpExpressApp`, `requireBearerAuth`, `mcpAuthMetadataRouter`.

## Consequences
- One fresh `McpServer` per request; all in-memory structures are caches.
- Weekly SDK bumps through Phase 1 with changelog review; a breaking bump is a stop-and-ADR event.
- Fallback if v2 proves unusable: `@modelcontextprotocol/sdk` 1.30 + `npx @modelcontextprotocol/codemod v1-to-v2` later.
