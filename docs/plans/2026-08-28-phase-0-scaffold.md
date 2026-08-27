# Phase 0 — Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Express 5 + MCP SDK v2 server that serves one `brainstem_ping` tool over Streamable HTTP at `/mcp` to both 2026-07-28 and 2025-era clients, with fail-closed config, redacting logger, CI, and a Heroku app + Postgres provisioned.

**Architecture:** `src/main.ts` boots `startServer()`; `src/app.ts` builds the Express app with `createMcpExpressApp` and mounts `createMcpHandler(factory)` via `toNodeHandler`; `src/mcp/factory.ts` builds a fresh `McpServer` per request (stateless — no sessions, no shared mutable state). Config and logging are standalone modules with their own tests. Everything is ESM TypeScript run natively by Node 24 in dev (`node src/main.ts`) and compiled with `tsc` for production.

**Tech Stack:** Node 24.x, TypeScript (strict, `erasableSyntaxOnly`), Express 5.2.x, `@modelcontextprotocol/server|express|node|core` 2.0.0 (exact pins), `@modelcontextprotocol/client` 2.0.0 (tests), Zod 4, pino, Vitest 4, Biome, GitHub Actions, Heroku (Basic dyno, Postgres essential-0).

**Spec:** `docs/implementation-plan.md` §0, §2, §3, §9 (Phase 0), §11, §13.

## Global Constraints

- Node `24.x` (`engines.node`, `.node-version`); npm 11.
- `@modelcontextprotocol/*` pinned **exactly** to `2.0.0` (no caret). Bumps are deliberate (§12).
- Express `^5.2.1`; Zod `^4.2.0`; TypeScript strict; ESM only (`"type": "module"`).
- MCP endpoint is exactly `/mcp`; `PUBLIC_URL` is the only source of advertised URLs — never `Host`/`X-Forwarded-*`.
- Legacy posture default `legacy: 'stateless'` (serves 2025-era clients); `'reject'` only via `MCP_LEGACY_MODE=reject`.
- `server.keepAliveTimeout = 95_000` (Heroku router holds idle connections 90 s); SSE keep-alive every 15 s (Heroku 55 s rolling idle).
- Logs never contain tokens, secrets, or note content (pino `redact`).
- Every task ends with typecheck + lint + tests green and a commit. Commit message style: Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`).
- Tests live in `tests/`, mirror `src/` paths, use Vitest (`describe/it/expect`), no network beyond `127.0.0.1`.

---

### Task 1: Repository scaffold (toolchain, configs, dependencies, smoke test)

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `biome.json`, `.gitignore`, `.node-version`, `.env.example`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `start`, `typecheck`, `lint`, `lint:fix`, `test`, `heroku-postbuild` used by every later task and by CI.

- [ ] **Step 1: Initialize package.json**

Run from repo root `/home/vanea/Code/brainstem-mcp`:

```bash
npm init -y >/dev/null
npm pkg set name=brainstem-mcp version=0.1.0 private=true type=module license=MIT
npm pkg set description="Multi-tenant MCP vault server (Google Drive / local FS) for Claude"
npm pkg set engines.node="24.x"
npm pkg set scripts.dev="node --watch --env-file-if-exists=.env src/main.ts"
npm pkg set scripts.build="tsc -p tsconfig.build.json"
npm pkg set scripts.start="node dist/main.js"
npm pkg set scripts.typecheck="tsc -p tsconfig.json --noEmit"
npm pkg set scripts.lint="biome check ."
npm pkg set scripts.lint:fix="biome check --write ."
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.heroku-postbuild="npm run build"
npm pkg delete scripts.main main
```

- [ ] **Step 2: Install dependencies (SDK pinned exactly)**

```bash
npm install --save-exact @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/express@2.0.0 @modelcontextprotocol/node@2.0.0 @modelcontextprotocol/core@2.0.0
npm install express@^5.2.1 zod@^4.2.0 pino@^10
npm install --save-dev --save-exact @modelcontextprotocol/client@2.0.0
npm install --save-dev typescript@^7 @types/node@^24 @types/express@^5 vitest@^4 @biomejs/biome@^2 pino-pretty
```

Expected: `node_modules/@modelcontextprotocol/{server,express,node,core,client}` present; `package.json` shows `"@modelcontextprotocol/server": "2.0.0"` (no caret).

- [ ] **Step 3: Write tsconfig.json (typecheck: src + tests) and tsconfig.build.json (emit: src only)**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Why: `erasableSyntaxOnly` guarantees every file runs directly under Node 24's native type stripping (`node src/main.ts` in dev — no tsx/ts-node), while `rewriteRelativeImportExtensions` lets source import `./x.ts` and have `tsc` emit `./x.js` for production.

- [ ] **Step 4: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
```

- [ ] **Step 5: Generate and adjust biome.json**

```bash
npx @biomejs/biome init
```

Then replace the generated `biome.json` content with (keep the `$schema` line Biome generated):

```json
{
  "$schema": "<keep generated value>",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["src/**", "tests/**", "*.ts", "*.json"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" } }
}
```

- [ ] **Step 6: Write .gitignore, .node-version, .env.example**

`.gitignore`:
```
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
*.log
.DS_Store
```

`.node-version`:
```
24
```

`.env.example`:
```
# Local development values — copy to .env (never commit .env)
PUBLIC_URL=http://localhost:3000
ALLOW_INSECURE_PUBLIC_URL=true
PORT=3000
LOG_LEVEL=debug
MCP_LEGACY_MODE=stateless
# DATABASE_URL=postgres://user:pass@localhost:5432/brainstem
```

- [ ] **Step 7: Write the smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests under vitest', () => {
    const answer: number = 40 + 2;
    expect(answer).toBe(42);
  });
});
```

- [ ] **Step 8: Verify the toolchain end to end**

```bash
mkdir -p src && printf 'export const placeholder = true;\n' > src/placeholder.ts
npm run typecheck && npm run lint:fix && npm test
```
Expected: typecheck exits 0; Biome reports "Checked N files" with no errors; Vitest "1 passed".

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Node 24 + TypeScript + Vitest + Biome toolchain with pinned MCP SDK v2"
```

---

### Task 2: Fail-closed configuration module

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`
- Delete: `src/placeholder.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LegacyMode = 'stateless' | 'reject';
  export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  export interface Config {
    publicUrl: URL;        // no trailing slash, https unless ALLOW_INSECURE_PUBLIC_URL=true
    mcpUrl: URL;           // `${publicUrl}/mcp` — the RFC 8707 resource identifier
    port: number;
    logLevel: LogLevel;
    legacyMode: LegacyMode;
    databaseUrl: string | undefined;   // optional until Phase 2 makes it required
  }
  export class ConfigError extends Error { readonly missing: string[]; readonly invalid: string[] }
  export function loadConfig(env?: Record<string, string | undefined>): Config
  ```

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const base = { PUBLIC_URL: 'https://brainstem.example.com' };

describe('loadConfig', () => {
  it('parses a minimal valid environment with defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.publicUrl.href).toBe('https://brainstem.example.com/');
    expect(cfg.mcpUrl.href).toBe('https://brainstem.example.com/mcp');
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.legacyMode).toBe('stateless');
    expect(cfg.databaseUrl).toBeUndefined();
  });

  it('strips a trailing slash and preserves a path prefix in mcpUrl', () => {
    const cfg = loadConfig({ PUBLIC_URL: 'https://example.com/brain/' });
    expect(cfg.mcpUrl.href).toBe('https://example.com/brain/mcp');
  });

  it('fails closed when PUBLIC_URL is missing and names the variable without leaking values', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: '8080' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.missing).toEqual(['PUBLIC_URL']);
    expect(ce.message).toContain('PUBLIC_URL');
    expect(ce.message).not.toContain('8080');
  });

  it('rejects a non-https PUBLIC_URL unless explicitly allowed', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'http://localhost:3000' })).toThrow(ConfigError);
    const cfg = loadConfig({ PUBLIC_URL: 'http://localhost:3000', ALLOW_INSECURE_PUBLIC_URL: 'true' });
    expect(cfg.mcpUrl.href).toBe('http://localhost:3000/mcp');
  });

  it('rejects invalid PORT, LOG_LEVEL and MCP_LEGACY_MODE values', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MCP_LEGACY_MODE: 'sessions' })).toThrow(ConfigError);
  });

  it('accepts legacy mode reject and a database url', () => {
    const cfg = loadConfig({ ...base, MCP_LEGACY_MODE: 'reject', DATABASE_URL: 'postgres://u:p@h/db' });
    expect(cfg.legacyMode).toBe('reject');
    expect(cfg.databaseUrl).toBe('postgres://u:p@h/db');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.ts'`.

- [ ] **Step 3: Implement src/config.ts**

```ts
import { z } from 'zod';

export type LegacyMode = 'stateless' | 'reject';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Config {
  publicUrl: URL;
  mcpUrl: URL;
  port: number;
  logLevel: LogLevel;
  legacyMode: LegacyMode;
  databaseUrl: string | undefined;
}

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required env vars: ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid env vars: ${invalid.join(', ')}`);
    super(`Configuration error — ${parts.join('; ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

const EnvSchema = z.object({
  PUBLIC_URL: z.url(),
  ALLOW_INSECURE_PUBLIC_URL: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MCP_LEGACY_MODE: z.enum(['stateless', 'reject']).default('stateless'),
  DATABASE_URL: z.string().min(1).optional(),
});

const REQUIRED = ['PUBLIC_URL'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED.filter((key) => !env[key] || env[key]?.trim() === '');
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].filter(
      (key) => !missing.includes(key as (typeof REQUIRED)[number]),
    );
    throw new ConfigError(missing, invalid);
  }
  if (missing.length > 0) throw new ConfigError(missing, []);

  const publicUrl = new URL(parsed.data.PUBLIC_URL);
  publicUrl.hash = '';
  publicUrl.search = '';
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
  if (publicUrl.protocol !== 'https:' && parsed.data.ALLOW_INSECURE_PUBLIC_URL !== 'true') {
    throw new ConfigError([], ['PUBLIC_URL (must be https unless ALLOW_INSECURE_PUBLIC_URL=true)']);
  }
  const mcpUrl = new URL(`${publicUrl.origin}${publicUrl.pathname}/mcp`);

  return {
    publicUrl,
    mcpUrl,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    legacyMode: parsed.data.MCP_LEGACY_MODE,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
```

Note on the first test: `new URL('https://brainstem.example.com')` serializes `href` with a trailing slash (`/`) even when `pathname` is `''` — the test asserts on that WHATWG behavior deliberately; `mcpUrl` has no double slash because we build it from `origin + pathname + '/mcp'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rm src/placeholder.ts && npx vitest run tests/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint:fix && npm test
git add -A
git commit -m "feat(config): fail-closed environment parsing with PUBLIC_URL-derived MCP resource URL"
```

---

### Task 3: Redacting structured logger

**Files:**
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

**Interfaces:**
- Consumes: `LogLevel` from `src/config.ts`.
- Produces:
  ```ts
  import type { Logger } from 'pino';
  export type { Logger };
  export function createLogger(level: LogLevel, destination?: NodeJS.WritableStream): Logger
  ```

- [ ] **Step 1: Write the failing test**

`tests/logger.test.ts`:
```ts
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

function collect(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').trim().split('\n') };
}

describe('createLogger', () => {
  it('emits JSON lines at or above the configured level', () => {
    const sink = collect();
    const log = createLogger('info', sink.stream);
    log.debug('hidden');
    log.info({ requestId: 'r1' }, 'visible');
    const entries = sink.lines().map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 30, msg: 'visible', requestId: 'r1' });
  });

  it('redacts tokens, secrets and authorization headers anywhere in the payload', () => {
    const sink = collect();
    const log = createLogger('info', sink.stream);
    log.info(
      {
        token: 'tok-secret',
        access_token: 'acc-secret',
        refresh_token: 'ref-secret',
        req: { headers: { authorization: 'Bearer abc123' } },
        nested: { refresh_token: 'deep-secret', client_secret: 'cs-secret' },
      },
      'auth event',
    );
    const raw = sink.lines().join('\n');
    for (const secret of ['tok-secret', 'acc-secret', 'ref-secret', 'abc123', 'deep-secret', 'cs-secret']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL — `Cannot find module '../src/logger.ts'`.

- [ ] **Step 3: Implement src/logger.ts**

```ts
import pino, { type Logger } from 'pino';
import type { LogLevel } from './config.ts';

export type { Logger };

const SECRET_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'code',
  'code_verifier',
  'authorization',
  'refresh_token_enc',
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SECRET_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `req.headers.${key}`, `res.headers.${key}`);
  }
  paths.push('req.headers.cookie', 'res.headers["set-cookie"]');
  return paths;
}

export function createLogger(level: LogLevel, destination?: NodeJS.WritableStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/logger.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint:fix && npm test
git add -A
git commit -m "feat(logger): pino logger with secret redaction"
```

---

### Task 4: MCP server factory + Express app serving `/mcp` to both protocol eras

**Files:**
- Create: `src/version.ts`, `src/mcp/factory.ts`, `src/app.ts`
- Test: `tests/app.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`), `Logger` (`src/logger.ts`).
- Produces:
  ```ts
  // src/version.ts
  export const SERVER_INFO: { name: 'brainstem-mcp'; version: string };
  // src/mcp/factory.ts
  export function createVaultServer(ctx: McpRequestContext): McpServer;   // fresh instance per request
  // src/app.ts
  export interface AppBundle { app: express.Express; handler: McpHttpHandler }
  export function createApp(config: Config, logger: Logger): AppBundle;
  ```
  Later phases replace the body of `createVaultServer` (tools + tenant context) but keep its signature; `createApp` gains auth middleware in Phase 2.

- [ ] **Step 1: Write the failing tests**

`tests/app.test.ts`:
```ts
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';

const config = loadConfig({ PUBLIC_URL: 'https://brainstem.example.com' });
const logger = createLogger('fatal');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app } = createApp(config, logger);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('GET /health', () => {
  it('reports ok with server identity and no secrets', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', name: 'brainstem-mcp' });
    expect(typeof body.version).toBe('string');
  });
});

describe('/mcp with a 2026-07-28 (modern) client', () => {
  it('lists brainstem_ping with annotations and calls it', async () => {
    const client = new Client(
      { name: 'test-modern', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      const ping = tools.find((t) => t.name === 'brainstem_ping');
      expect(ping).toBeDefined();
      expect(ping?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const result = await client.callTool({ name: 'brainstem_ping', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ server: 'brainstem-mcp' });
    } finally {
      await client.close();
    }
  });

  it('advertises tools/list cache hints (ttlMs 1h, public) on a raw modern request', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ttlMs?: number; cacheScope?: string } };
    expect(body.result.ttlMs).toBe(3_600_000);
    expect(body.result.cacheScope).toBe('public');
  });

  it('rejects a modern request whose Mcp-Method header disagrees with the body', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'prompts/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });
});

describe('/mcp with a 2025-era (legacy) client', () => {
  it('completes the initialize handshake statelessly and calls the tool', async () => {
    const client = new Client({ name: 'test-legacy', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('brainstem_ping');
      const result = await client.callTool({ name: 'brainstem_ping', arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('answers legacy GET (standalone SSE) and DELETE with 405', async () => {
    const get = await fetch(`${baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(del.status).toBe(405);
  });
});

describe('transport hardening', () => {
  it('rejects a browser Origin that is not allowed with 403', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unexpected Host header with 403', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { host: 'attacker.example' } });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/app.test.ts`
Expected: FAIL — `Cannot find module '../src/app.ts'`.

- [ ] **Step 3: Implement src/version.ts**

```ts
import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

// Works from both src/ (dev) and dist/ (prod): package.json is one level above either directory.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

export const SERVER_INFO = { name: 'brainstem-mcp' as const, version: pkg.version };
```

- [ ] **Step 4: Implement src/mcp/factory.ts**

```ts
import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SERVER_INFO } from '../version.ts';

const PingOutput = z.object({
  server: z.string(),
  version: z.string(),
  era: z.enum(['legacy', 'modern']),
  now: z.string(),
});

/**
 * Builds a fresh McpServer for one request. Stateless by design (MCP 2026-07-28):
 * nothing created here may outlive the request.
 */
export function createVaultServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'brainstem-mcp gives Claude read/write access to a personal markdown vault. Phase 0 exposes only a ping tool.',
    cacheHints: {
      'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    },
  });

  server.registerTool(
    'brainstem_ping',
    {
      title: 'Ping',
      description: 'Health check. Returns server name, version, protocol era and current time.',
      outputSchema: PingOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const out = {
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        era: ctx.era,
        now: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  return server;
}
```

If `tsc` rejects the `cacheHints` key shape, open `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`, search `cacheHints?:`, and match the declared type exactly (the option is documented as "keyed by operation"; the cacheable operations are `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`).

- [ ] **Step 5: Implement src/app.ts**

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { createVaultServer } from './mcp/factory.ts';
import { SERVER_INFO } from './version.ts';

export interface AppBundle {
  app: Express;
  handler: McpHttpHandler;
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function createApp(config: Config, logger: Logger): AppBundle {
  const handler = createMcpHandler((ctx) => createVaultServer(ctx), {
    legacy: config.legacyMode,
    keepAliveMs: 15_000, // Heroku closes idle streams after 55 s
    onerror: (error) => logger.warn({ err: error }, 'mcp handler error'),
  });

  const allowed = [config.publicUrl.hostname, ...LOCAL_HOSTNAMES];
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: allowed,
    allowedOrigins: allowed,
    jsonLimit: '2mb', // 1 MB note + base64/JSON overhead
  });
  app.set('trust proxy', 1); // Heroku router: only for req.secure, never for URL building
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_INFO.name, version: SERVER_INFO.version });
  });

  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => {
    res.setHeader('X-Accel-Buffering', 'no');
    void node(req, res, req.body);
  });

  return { app, handler };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/app.test.ts`
Expected: PASS (8 tests). If the Host-header test fails with 200, `createMcpExpressApp` only applies host validation for localhost binds — add explicitly after `createMcpExpressApp(...)`:
```ts
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
app.use(hostHeaderValidation(allowed));
app.use(originValidation(allowed));
```
and re-run. If the `-32020` test fails with a different negative code, print `body.error` and compare with the SDK's `ProtocolErrorCode.HeaderMismatch` export — the assertion must target `HeaderMismatch`; import the constant instead of the literal if they differ.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint:fix && npm test
git add -A
git commit -m "feat(mcp): stateless Express app serving brainstem_ping over Streamable HTTP to modern and legacy clients"
```

---

### Task 5: Process entry point with Heroku-safe timeouts and graceful shutdown

**Files:**
- Create: `src/server.ts`, `src/main.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `createApp`, `loadConfig`, `createLogger`.
- Produces:
  ```ts
  export interface RunningServer { httpServer: http.Server; close(): Promise<void> }
  export function startServer(config: Config, logger: Logger, listenPort?: number): Promise<RunningServer>
  ```

- [ ] **Step 1: Write the failing test**

`tests/server.test.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { startServer } from '../src/server.ts';

describe('startServer', () => {
  it('listens with Heroku-compatible keep-alive settings and closes cleanly', async () => {
    const config = loadConfig({ PUBLIC_URL: 'https://brainstem.example.com' });
    const running = await startServer(config, createLogger('fatal'), 0);
    try {
      const { port } = running.httpServer.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      expect(running.httpServer.keepAliveTimeout).toBe(95_000);
      expect(running.httpServer.headersTimeout).toBeGreaterThan(95_000);
      expect(running.httpServer.requestTimeout).toBe(0);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }
    expect(running.httpServer.listening).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server.ts'`.

- [ ] **Step 3: Implement src/server.ts**

```ts
import http from 'node:http';
import { createApp } from './app.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';

export interface RunningServer {
  httpServer: http.Server;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  logger: Logger,
  listenPort: number = config.port,
): Promise<RunningServer> {
  const { app, handler } = createApp(config, logger);
  const httpServer = http.createServer(app);

  // Heroku router keeps idle connections for 90 s; a shorter dyno-side timeout causes H13/H18.
  httpServer.keepAliveTimeout = 95_000;
  httpServer.headersTimeout = 100_000;
  // Long-lived SSE responses (subscriptions/listen) must not be cut by Node's 5-minute default.
  httpServer.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(listenPort, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: listenPort, publicUrl: config.publicUrl.href }, 'brainstem-mcp listening');

  return {
    httpServer,
    async close() {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      await handler.close();
    },
  };
}
```

- [ ] **Step 4: Implement src/main.ts**

```ts
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startServer } from './server.ts';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  const running = await startServer(config, logger);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 10_000);
    running
      .close()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
```

- [ ] **Step 5: Run the test to verify it passes, then smoke-run dev mode**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS.

Run: `cp .env.example .env && (npm run dev & sleep 3; curl -s localhost:3000/health; kill %1)`
Expected: `{"status":"ok","name":"brainstem-mcp","version":"0.1.0"}` and a JSON log line `brainstem-mcp listening`.

- [ ] **Step 6: Typecheck, lint, build, commit**

```bash
npm run typecheck && npm run lint:fix && npm test && npm run build && node dist/main.js --help >/dev/null 2>&1; ls dist/main.js
git add -A
git commit -m "feat(server): entry point with Heroku keep-alive timeouts and graceful shutdown"
```

---

### Task 6: Heroku deployment files and first deploy

**Files:**
- Create: `Procfile`, `app.json`
- Modify: `README.md` (deploy section)

**Interfaces:**
- Produces: a live `PUBLIC_URL` used by every later acceptance test.

- [ ] **Step 1: Write Procfile**

```
web: node dist/main.js
```

- [ ] **Step 2: Write app.json**

```json
{
  "name": "brainstem-mcp",
  "description": "Multi-tenant MCP vault server (Google Drive / local FS) for Claude",
  "repository": "https://github.com/vaneavasco/brainstem-mcp",
  "keywords": ["mcp", "model-context-protocol", "notes", "obsidian", "google-drive"],
  "buildpacks": [{ "url": "heroku/nodejs" }],
  "formation": { "web": { "quantity": 1, "size": "basic" } },
  "addons": [{ "plan": "heroku-postgresql:essential-0" }],
  "env": {
    "PUBLIC_URL": {
      "description": "Public https origin of this app, e.g. https://brainstem-mcp-abc123.herokuapp.com (no trailing slash)",
      "required": true
    },
    "LOG_LEVEL": { "value": "info", "required": false },
    "MCP_LEGACY_MODE": { "value": "stateless", "required": false }
  }
}
```

- [ ] **Step 3: Provision the Heroku app (needs `heroku login` — run by Vanea if the CLI is not authenticated)**

```bash
heroku create brainstem-mcp --region eu
heroku addons:create heroku-postgresql:essential-0 -a brainstem-mcp
heroku info -a brainstem-mcp -s | grep web_url        # new apps get a random suffix in the domain
heroku config:set PUBLIC_URL=<web_url without trailing slash> LOG_LEVEL=info -a brainstem-mcp
heroku config:get DATABASE_URL -a brainstem-mcp >/dev/null && echo "postgres attached"
```

If the name `brainstem-mcp` is taken, use `brainstem-vault` and keep `PUBLIC_URL` as the single source of truth.

- [ ] **Step 4: Deploy and verify**

```bash
git remote add heroku https://git.heroku.com/brainstem-mcp.git   # or `heroku git:remote -a brainstem-mcp`
git push heroku main
heroku ps:scale web=1:basic -a brainstem-mcp
curl -s "$(heroku config:get PUBLIC_URL -a brainstem-mcp)/health"
heroku logs -n 50 -a brainstem-mcp | grep -E "listening|H1[0-9]|error" || true
```
Expected: `{"status":"ok","name":"brainstem-mcp","version":"0.1.0"}`; no `H12/H13/H18` lines.

- [ ] **Step 5: MCP Inspector acceptance (Phase 0 exit criterion)**

```bash
npx @modelcontextprotocol/inspector
```
In the Inspector UI: transport **Streamable HTTP**, URL `<PUBLIC_URL>/mcp`, Connect → Tools → `brainstem_ping` → Run. Repeat against `http://localhost:3000/mcp` with `npm run dev`. Record the Inspector version and the negotiated protocol version shown in the UI in `docs/plans/README.md` under Phase 0 status.

- [ ] **Step 6: Commit**

```bash
git add Procfile app.json
git commit -m "chore(heroku): Procfile and app.json for Basic dyno + Postgres essential-0"
git push origin main
```

---

### Task 7: CI, README skeleton and ADRs

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `docs/adr/0001-mcp-sdk-v2-and-express-5.md`, `docs/adr/0002-native-typescript-and-tsc-build.md`, `docs/adr/0003-biome.md`

- [ ] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run build
```

- [ ] **Step 2: Write README.md**

```markdown
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
```

- [ ] **Step 3: Write the three ADRs**

`docs/adr/0001-mcp-sdk-v2-and-express-5.md`:
```markdown
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
```

`docs/adr/0002-native-typescript-and-tsc-build.md`:
```markdown
# ADR 0002 — Native TypeScript in dev, tsc build in prod

Date: 2026-08-28 · Status: accepted

## Context
Node 24 strips types natively for erasable syntax. Heroku runs `heroku-postbuild`.

## Decision
`erasableSyntaxOnly` + `rewriteRelativeImportExtensions` in tsconfig. Dev: `node --watch src/main.ts`. Prod: `tsc -p tsconfig.build.json` → `dist/`, Procfile `node dist/main.js`. No tsx/ts-node/bundler.

## Consequences
No enums, parameter properties, or namespaces in source. Imports use `.ts` extensions.
```

`docs/adr/0003-biome.md`:
```markdown
# ADR 0003 — Biome for lint + format

Date: 2026-08-28 · Status: accepted

## Context
The plan allowed eslint+prettier or Biome.

## Decision
Biome 2 (single binary, one config). Revisit only if a type-aware rule becomes necessary.
```

- [ ] **Step 4: Verify CI locally and commit**

```bash
npm run typecheck && npm run lint && npm test && npm audit --omit=dev --audit-level=high && npm run build
git add -A
git commit -m "chore: CI workflow, README, ADRs 0001-0003"
git push origin main
```
Expected: GitHub Actions run on `main` is green (check `gh run list --limit 1`).

---

## Phase 0 exit checklist

- [ ] `npm test` green: config (6), logger (2), app (8), server (1), smoke (1).
- [ ] MCP Inspector connects locally **and** to the Heroku URL; `brainstem_ping` returns `structuredContent`.
- [ ] Raw modern request shows `ttlMs: 3600000`, `cacheScope: "public"` on `tools/list`.
- [ ] Legacy client (default `Client`) completes `initialize` and calls the tool; `GET/DELETE /mcp` → 405.
- [ ] Heroku app on Basic dyno with `heroku-postgresql:essential-0` attached; `/health` 200; no H12/H13/H18 in logs.
- [ ] CI green on `main`.
