# ADR 0002 — Native TypeScript in dev, tsc build in prod

Date: 2026-08-28 · Status: accepted

## Context
Node 24 strips types natively for erasable syntax. Heroku runs `heroku-postbuild`.

## Decision
`erasableSyntaxOnly` + `rewriteRelativeImportExtensions` in tsconfig. Dev: `node --watch src/main.ts`. Prod: `tsc -p tsconfig.build.json` → `dist/`, Procfile `node dist/main.js`. No tsx/ts-node/bundler.

## Consequences
No enums, parameter properties, or namespaces in source. Imports use `.ts` extensions.
