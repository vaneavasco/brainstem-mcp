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

The `.env.example` defaults `STORAGE_BACKEND=localfs` with `VAULT_PATH=./vault-dev` so `npm run dev` runs against a local vault out of the box (the directory is created automatically and is gitignored). `STORAGE_BACKEND=drive` (Google Drive) lands in Phase 3; until then `main.ts` refuses to start with that backend.

## Run with Docker (local acceptance environment)

```bash
mkdir -p vault-dev
npm run docker:up        # builds the image, starts app (:3000) + postgres (:5432)
npm run docker:smoke     # health, tools/list, write→read, file visible in ./vault-dev
npm run docker:logs
npm run docker:down
```

The vault is the bind-mounted `./vault-dev` folder — open it in Obsidian to see notes Claude writes. Postgres is idle until Phase 2 (auth).

## Tools

Every tool is `vault_`-prefixed, ported name-for-name from the reference repo (`docs/implementation-plan.md` §5), plus a `brainstem_ping` health-check tool. All tools carry `title`, a description, and full annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`).

| Group | Tools | readOnly | destructive | idempotent |
|---|---|---|---|---|
| Read & search | `vault_read`, `vault_batch_read`, `vault_search`, `vault_search_frontmatter`, `vault_list`, `vault_canvas_read`, `vault_daily_note_path`, `vault_daily_note_read`, `vault_analytics_summary`, `vault_analytics_findings` | true | false | true |
| Overwrite | `vault_write`, `vault_write_binary`, `vault_batch_frontmatter_update`, `vault_canvas_add_node`, `vault_canvas_add_edge` | false | true | true |
| Append / partial edit | `vault_edit`, `vault_append`, `vault_daily_note_append` | false | false | false |
| Move / delete | `vault_move`, `vault_delete` | false | true | false |

`vault_delete` only soft-deletes (moves to `.trash/`) and requires `confirm=true`. `vault_edit` applies ordered exact-text patches and supports `dryRun=true` for a unified-diff preview. See `tests/tools/surface.test.ts` for the full tool-surface contract (names, annotations, description-length bounds, deterministic `tools/list` ordering).

## Environment variables

In addition to the Phase 0 vars (`PUBLIC_URL`, `ALLOW_INSECURE_PUBLIC_URL`, `PORT`, `LOG_LEVEL`, `MCP_LEGACY_MODE`, `DATABASE_URL`):

| Var | Default | Notes |
|---|---|---|
| `STORAGE_BACKEND` | `drive` | `drive` \| `localfs`. `drive` is not implemented yet (Phase 3) — the server exits with an explanatory message. |
| `VAULT_PATH` | — | Required when `STORAGE_BACKEND=localfs`; root directory for the local vault. |
| `DAILY_NOTES_FOLDER` | `''` (vault root) | Folder daily notes are stored under. |
| `DAILY_NOTES_FORMAT` | `yyyy-MM-dd` | `date-fns` format string (strftime-style `%Y-%m-%d` tokens are also accepted). |
| `DAILY_NOTES_TEMPLATE` | unset | Optional template content used when a daily note is created via `vault_daily_note_append`. |
| `VAULT_TIMEZONE` | `UTC` | IANA timezone used to resolve "today" for daily notes; validated with `Intl.DateTimeFormat` at startup. |
| `REQUIRED_FRONTMATTER` | `''` | Comma-separated frontmatter keys checked by `vault_analytics_summary`/`_findings`. |

## Deploy (Heroku)

See `docs/plans/2026-08-28-phase-0-scaffold.md` Task 6. `PUBLIC_URL` must be the exact https origin users will paste into Claude. Heroku deploy for Phase 1 is deferred by owner decision (2026-08-28); the Phase 1 acceptance environment is the local Docker Compose stack (Task 16).
