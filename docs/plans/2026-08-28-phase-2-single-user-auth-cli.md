# Phase 2′ — Single-user auth, state-in-vault, tunnel modes, CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make brainstem-mcp usable by its owner from claude.ai, Claude mobile and Claude Code against a Docker Compose stack on the owner's machine: OAuth 2.1 AS+RS with an owner secret, state in the vault's reserved `_brainstem/` folder, Cloudflare tunnel (named or quick), and a cross-platform TypeScript CLI (`setup`/`up`/`url`/`status`/`down`/`logs`/`revoke-all`/`secret`).

**Architecture:** Phase 0–1 code is reused unchanged except for four seams: path policy gains a reserved prefix, `LocalFSAdapter.watch` gains polling, `loadConfig` gains the new variables, and `createApp` gains an `auth` dependency that mounts the RS (`requireBearerAuth`, PRM) and our own AS (`/oauth/*`). The AS keeps every token as a SHA-256 hash in a JSON file (`FileTokenStore`) inside `<vault>/_brainstem/`. In quick-tunnel mode a supervisor writes the public URL to a file and the app restarts itself when it changes. The CLI drives `docker compose` and edits `.env`.

**Tech Stack:** Node 24 (native TS), Express 5.2, `@modelcontextprotocol/{server,express,node,core}` 2.0.0 (RS helpers only), Zod 4, Vitest 4, Biome 2, `commander` 15.0.0, `@inquirer/prompts` 8.7.0, `cloudflared` 2026.8.2, Docker Compose v5.

**Spec:** `docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md` (rev. 2). Read it first; every task below cites the section it implements.

## Global Constraints

- Pin `@modelcontextprotocol/*` at exactly `2.0.0`; pin `commander` at `15.0.0` and `@inquirer/prompts` at `8.7.0` (exact, no caret) — spec §5.
- Imports use `.ts` extensions (`rewriteRelativeImportExtensions`); `erasableSyntaxOnly` ⇒ no enums, no parameter properties, no namespaces.
- Biome: single quotes, semicolons, trailing commas, line width 100. Run `npm run lint:fix` before every commit; `npm run typecheck` must be clean.
- Secrets never reach logs: pino redaction already covers `token`, `code`, `authorization`; never log the owner secret or a candidate, never log token values (only hashes' first 8 chars if needed).
- Every persisted secret (authorization codes, access and refresh tokens) is stored **only** as `sha256(hex)` — spec §4.4.
- All URLs advertised by the AS are built from `config.publicUrl` — never from request headers.
- `_brainstem/` is a reserved vault prefix: rejected by `normalizeVaultPath`, skipped by list/search/index/watch — spec §4.10.
- Tests use `tests/helpers/env.ts` (`baseEnv()`) for any `loadConfig` call so the required `OWNER_SECRET` is present exactly once.
- Windows is a target for the CLI: `path.resolve`/`path.isAbsolute`, `spawn` without `shell`, `\n` line endings written explicitly.
- `main` is fast-forwarded after each task's review (project convention); one commit per task minimum.

---

## File structure

```
src/
  auth/
    hash.ts                  sha256hex(), randomToken()
    owner.ts                 OwnerAuth: constant-time secret check + global lockout
    store/types.ts           TokenStore interface + record types
    store/file-store.ts      FileTokenStore (JSON, atomic write, mtime reload, sweep)
    rs/verifier.ts           createTokenVerifier(): OAuthTokenVerifier (hash lookup, expiry, audience)
    as/metadata.ts           buildAuthorizationServerMetadata(publicUrl)
    as/cimd.ts               CIMD resolver: allowlist, safe fetch, validation, cache
    as/net.ts                assertPublicAddress(), fetchClientMetadataDocument()
    as/consent.ts            renderConsentPage(), renderErrorPage()
    as/authorize.ts          GET /oauth/authorize, POST /oauth/consent
    as/token.ts              POST /oauth/token, POST /oauth/revoke
    mount.ts                 createAuth(config, logger, store) + mountAuth(app, …)
    context.ts               createOwnerResolver(runtime)
  tunnel/
    public-url-file.ts       waitForPublicUrl(), watchPublicUrl()
    supervisor.ts            quick/named cloudflared supervisor (runs in the tunnel image)
    supervisor-main.ts       entrypoint for the tunnel container
  vault/
    connection-note.ts       writeConnectionNote(), writeInstanceFile()
  cli/
    brainstem.ts             commander entry
    env-file.ts              parse/upsert .env preserving comments
    vault-path.ts            validateVaultPath()
    docker.ts                ComposeRunner (spawn docker compose)
    commands/setup.ts, up.ts, url.ts, status.ts, down.ts, logs.ts, revoke-all.ts, secret.ts
tunnel/Dockerfile            node:24-slim + cloudflared 2026.8.2 + dist/tunnel/supervisor-main.js
compose.yaml                 app + tunnel (profile "tunnel"), no volumes, no postgres
tests/helpers/env.ts, tests/helpers/auth.ts, tests/auth/*.test.ts, tests/tunnel/*.test.ts, tests/cli/*.test.ts
```

---

### Task 1: Reserved `_brainstem/` prefix in path policy, list and watch

**Files:**
- Modify: `src/storage/path-policy.ts`
- Modify: `src/storage/local-fs.ts` (list walk at line ~358, watch `ignored` at line ~567)
- Test: `tests/storage/path-policy.test.ts`, `tests/storage/local-fs-nav.test.ts`

**Interfaces:**
- Produces: `export const RESERVED_DIR = '_brainstem'` and `export function isReservedPath(p: string): boolean` in `path-policy.ts`. `normalizeVaultPath` throws `INVALID_PATH` for any path whose first segment is `_brainstem` unless `opts.allowInternal === true`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage/path-policy.test.ts`:

```ts
import { isReservedPath, normalizeVaultPath, RESERVED_DIR } from '../../src/storage/path-policy.ts';

describe('reserved _brainstem prefix', () => {
  it('rejects the reserved folder and anything under it', () => {
    for (const p of ['_brainstem', '_brainstem/', '_brainstem/state.json', './_brainstem/x.md']) {
      expect(() => normalizeVaultPath(p)).toThrow(/reserved/);
    }
  });
  it('still accepts look-alikes that are not the reserved segment', () => {
    expect(normalizeVaultPath('_brainstem2/a.md')).toBe('_brainstem2/a.md');
    expect(normalizeVaultPath('notes/_brainstem/a.md')).toBe('notes/_brainstem/a.md');
  });
  it('allows the reserved folder for internal callers', () => {
    expect(normalizeVaultPath('_brainstem/state.json', { allowInternal: true })).toBe(
      '_brainstem/state.json',
    );
  });
  it('isReservedPath matches only the first segment', () => {
    expect(isReservedPath(RESERVED_DIR)).toBe(true);
    expect(isReservedPath('_brainstem/a')).toBe(true);
    expect(isReservedPath('a/_brainstem')).toBe(false);
  });
});
```

Append to `tests/storage/local-fs-nav.test.ts` (this file already creates an adapter over a temp dir; reuse its `mk`/`adapter` helpers — read the top of the file and follow the same pattern):

```ts
it('list() and watch() never expose the reserved _brainstem folder', async () => {
  await fs.mkdir(path.join(root, '_brainstem'), { recursive: true });
  await fs.writeFile(path.join(root, '_brainstem', 'state.json'), '{}');
  await fs.writeFile(path.join(root, 'visible.md'), '# v');
  const entries = await adapter.list('', { depth: Number.POSITIVE_INFINITY });
  expect(entries.map((e) => e.path)).toEqual(['visible.md']);
  const seen: string[] = [];
  const stop = adapter.watch((ev) => seen.push(ev.path));
  await new Promise((r) => setTimeout(r, 300));
  await fs.writeFile(path.join(root, '_brainstem', 'public-url'), 'https://x');
  await fs.writeFile(path.join(root, 'other.md'), '# o');
  await new Promise((r) => setTimeout(r, 700));
  stop();
  expect(seen).toContain('other.md');
  expect(seen.some((p) => p.startsWith('_brainstem'))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storage/path-policy.test.ts tests/storage/local-fs-nav.test.ts`
Expected: FAIL — `isReservedPath` is not exported; `_brainstem/state.json` currently normalizes fine; list returns `_brainstem`.

- [ ] **Step 3: Implement**

In `src/storage/path-policy.ts` add after `TRASH_DIR`:

```ts
/** Folder the server keeps its own state in. Never reachable through a tool. */
export const RESERVED_DIR = '_brainstem';

export function isReservedPath(p: string): boolean {
  return p === RESERVED_DIR || p.startsWith(`${RESERVED_DIR}/`);
}
```

In the segment loop of `normalizeVaultPath`, before `segments.push(raw)`:

```ts
    if (segments.length === 0 && raw === RESERVED_DIR && opts.allowInternal !== true) {
      reject(`${RESERVED_DIR}/ is reserved for the server`, trimmed);
    }
```

In `src/storage/local-fs.ts`: import `RESERVED_DIR` from `./path-policy.ts`; in `list()`'s walk replace `if (dirent.name.startsWith('.')) continue;` with

```ts
        if (dirent.name.startsWith('.')) continue;
        if (dir === '' && dirent.name === RESERVED_DIR) continue;
```

and in `watch()` replace the `ignored` option with

```ts
      ignored: (absPath: string) => {
        if (absPath === this.root) return false;
        if (path.basename(absPath).startsWith('.')) return true;
        return path.relative(this.root, absPath).split(path.sep)[0] === RESERVED_DIR;
      },
```

Also make `search()` skip it: in the JS fallback the walk goes through `list()` (already skipped); in the ripgrep branch add the argument `'--glob', `!${RESERVED_DIR}/**`` next to the existing `--no-ignore` flags.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/storage` then `npm run lint:fix && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/path-policy.ts src/storage/local-fs.ts tests/storage/path-policy.test.ts tests/storage/local-fs-nav.test.ts
git commit -m "feat(storage): reserve _brainstem/ for server state (path policy, list, search, watch)"
```

---

### Task 2: Config v2 — owner secret, tunnel/state variables, no database

**Files:**
- Modify: `src/config.ts`
- Create: `tests/helpers/env.ts`
- Modify: `tests/config.test.ts`, `tests/tools/harness.ts`, `tests/app.test.ts`, `tests/server.test.ts`, `tests/smoke.test.ts` (every `loadConfig({ PUBLIC_URL: … })` → `loadConfig(baseEnv({ … }))`)

**Interfaces:**
- Produces: `Config` gains `ownerSecret: string`, `cimdAllowedHosts: string[]`, `accessTokenTtlS: number`, `refreshTokenTtlS: number`, `watchPollMs: number | null`, `publicUrlFile: string | null`, `stateDir: string | null`, `tunnelMode: 'cloudflare' | 'quick' | 'none'`; loses `databaseUrl`. `STORAGE_BACKEND` defaults to `localfs`. `export const OWNER_SECRET_MIN_BYTES = 32`. `export function decodeOwnerSecretBytes(s: string): number` (base64url decoded length, `-1` if not base64url).
- `tests/helpers/env.ts`: `export const TEST_OWNER_SECRET = 'dGVzdC1vd25lci1zZWNyZXQtMzItYnl0ZXMtbG9uZy0hIQ'` (32 bytes base64url) and `export function baseEnv(over: Record<string, string> = {}): Record<string, string>` returning `{ PUBLIC_URL: 'https://brainstem.example.com', OWNER_SECRET: TEST_OWNER_SECRET, STORAGE_BACKEND: 'localfs', VAULT_PATH: '/tmp/unused', ...over }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/helpers/env.ts` as specified above. Replace the `base` constant in `tests/config.test.ts` with `const base = baseEnv();` (import it) and add:

```ts
describe('v2 variables', () => {
  it('requires OWNER_SECRET and rejects short or non-base64url values', () => {
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: '' }))).toThrow(/OWNER_SECRET/);
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: 'short' }))).toThrow(/at least 32 bytes/);
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: 'not base64url!!' }))).toThrow(/OWNER_SECRET/);
    expect(loadConfig(base).ownerSecret).toBe(TEST_OWNER_SECRET);
  });
  it('defaults the new knobs', () => {
    const cfg = loadConfig(base);
    expect(cfg.cimdAllowedHosts).toEqual(['claude.ai', 'claude.com']);
    expect(cfg.accessTokenTtlS).toBe(3600);
    expect(cfg.refreshTokenTtlS).toBe(90 * 24 * 3600);
    expect(cfg.watchPollMs).toBeNull();
    expect(cfg.publicUrlFile).toBeNull();
    expect(cfg.stateDir).toBeNull();
    expect(cfg.tunnelMode).toBe('none');
    expect(cfg.storage).toEqual({ backend: 'localfs', vaultPath: '/tmp/unused' });
    expect('databaseUrl' in cfg).toBe(false);
  });
  it('parses the knobs', () => {
    const cfg = loadConfig(
      baseEnv({
        CIMD_ALLOWED_HOSTS: ' claude.ai, example.org ',
        ACCESS_TOKEN_TTL_S: '600',
        REFRESH_TOKEN_TTL_S: '86400',
        VAULT_WATCH_POLL_MS: '2000',
        PUBLIC_URL_FILE: '/vault/_brainstem/public-url',
        STATE_DIR: '/tmp/state',
        TUNNEL_MODE: 'quick',
      }),
    );
    expect(cfg.cimdAllowedHosts).toEqual(['claude.ai', 'example.org']);
    expect(cfg.accessTokenTtlS).toBe(600);
    expect(cfg.refreshTokenTtlS).toBe(86400);
    expect(cfg.watchPollMs).toBe(2000);
    expect(cfg.publicUrlFile).toBe('/vault/_brainstem/public-url');
    expect(cfg.stateDir).toBe('/tmp/state');
    expect(cfg.tunnelMode).toBe('quick');
  });
  it('rejects nonsense knobs by name', () => {
    expect(() => loadConfig(baseEnv({ VAULT_WATCH_POLL_MS: '-5' }))).toThrow(/VAULT_WATCH_POLL_MS/);
    expect(() => loadConfig(baseEnv({ TUNNEL_MODE: 'ngrok' }))).toThrow(/TUNNEL_MODE/);
    expect(() => loadConfig(baseEnv({ CIMD_ALLOWED_HOSTS: 'https://claude.ai' }))).toThrow(
      /CIMD_ALLOWED_HOSTS/,
    );
  });
});
```

Remove the `expect(cfg.databaseUrl).toBeUndefined();` assertion from the first test. Update the "missing PUBLIC_URL" test's hint expectation to `expect(ce.message).toContain('npm run setup')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (unknown fields, no OWNER_SECRET validation).

- [ ] **Step 3: Implement**

In `src/config.ts`:

```ts
export type TunnelMode = 'cloudflare' | 'quick' | 'none';
export const OWNER_SECRET_MIN_BYTES = 32;

export function decodeOwnerSecretBytes(s: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return -1;
  return Buffer.from(s, 'base64url').length;
}
```

`Config`: remove `databaseUrl`; add `ownerSecret: string; cimdAllowedHosts: string[]; accessTokenTtlS: number; refreshTokenTtlS: number; watchPollMs: number | null; publicUrlFile: string | null; stateDir: string | null; tunnelMode: TunnelMode;`.

`EnvSchema`: remove `DATABASE_URL`; change `STORAGE_BACKEND` default to `'localfs'`; add

```ts
  OWNER_SECRET: z.string().optional(),
  CIMD_ALLOWED_HOSTS: z.string().default('claude.ai,claude.com'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().min(60).max(86_400).default(3600),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().min(3600).default(90 * 24 * 3600),
  VAULT_WATCH_POLL_MS: z.coerce.number().int().min(250).max(60_000).optional(),
  PUBLIC_URL_FILE: z.string().min(1).optional(),
  STATE_DIR: z.string().min(1).optional(),
  TUNNEL_MODE: z.enum(['cloudflare', 'quick', 'none']).default('none'),
```

Note `VAULT_WATCH_POLL_MS: ''` must count as unset: pre-process `env` with `const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''))` and parse `cleaned` (empty strings from `.env` templates behave like missing). Keep `REQUIRED = ['PUBLIC_URL', 'OWNER_SECRET']`. Missing-variable hint: `new ConfigError(missing, [], 'run `npm run setup` to generate .env')`.

After parsing, validate the secret:

```ts
  const secretBytes = decodeOwnerSecretBytes(d.OWNER_SECRET as string);
  if (secretBytes < OWNER_SECRET_MIN_BYTES) {
    throw new ConfigError(
      [],
      ['OWNER_SECRET'],
      secretBytes === -1
        ? 'OWNER_SECRET must be base64url (run `npm run setup`)'
        : `OWNER_SECRET must decode to at least ${OWNER_SECRET_MIN_BYTES} bytes (run \`npm run setup\`)`,
    );
  }
  const cimdAllowedHosts = d.CIMD_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean);
  if (cimdAllowedHosts.some((h) => !/^[a-z0-9.-]+$/i.test(h))) {
    throw new ConfigError([], ['CIMD_ALLOWED_HOSTS'], 'CIMD_ALLOWED_HOSTS is a comma-separated list of hostnames');
  }
```

Return the new fields (`watchPollMs: d.VAULT_WATCH_POLL_MS ?? null`, etc.). Update `tests/tools/harness.ts`, `tests/app.test.ts`, `tests/server.test.ts`, `tests/smoke.test.ts` to `loadConfig(baseEnv())` (search for `loadConfig(` in `tests/`). In `src/main.ts` delete the `STORAGE_BACKEND=drive` fatal branch's mention of Phase 3 — keep the guard but word it "only localfs is supported".

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run lint:fix && npm run typecheck`
Expected: all green (134+ tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/main.ts tests
git commit -m "feat(config): owner secret, tunnel/state knobs, CIMD allowlist; drop DATABASE_URL"
```

---

### Task 3: Watch polling option (Docker Desktop bind mounts)

**Files:**
- Modify: `src/storage/local-fs.ts` (`create` options + `watch`), `src/vault/runtime.ts` (`LocalRuntimeOptions.watchPollMs`), `src/main.ts`
- Test: `tests/storage/local-fs-nav.test.ts`

**Interfaces:**
- `LocalFSAdapter.create(root, { ripgrepPath?, watchPollMs? })`; `createLocalRuntime({ …, watchPollMs?: number | null })`.

- [ ] **Step 1: Write the failing test**

```ts
it('watch() honours watchPollMs by using chokidar polling', async () => {
  const polled = await LocalFSAdapter.create(root, { ripgrepPath: null, watchPollMs: 300 });
  const seen: string[] = [];
  const stop = polled.watch((ev) => seen.push(ev.path));
  await new Promise((r) => setTimeout(r, 400));
  await fs.writeFile(path.join(root, 'polled.md'), '# p');
  await new Promise((r) => setTimeout(r, 1200));
  stop();
  expect(seen).toContain('polled.md');
  expect(polled.caps().watch).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage/local-fs-nav.test.ts -t polling`
Expected: FAIL — TS error `watchPollMs` unknown option.

- [ ] **Step 3: Implement**

In `local-fs.ts`, extend the `create` options type with `watchPollMs?: number | null`, store it on the instance (`private readonly watchPollMs: number | null`), and pass to chokidar:

```ts
    const watcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      ignored: /* from Task 1 */,
      awaitWriteFinish: false,
      ...(this.watchPollMs ? { usePolling: true, interval: this.watchPollMs } : {}),
    });
```

In `runtime.ts` add `watchPollMs?: number | null` to `LocalRuntimeOptions` and forward it in `LocalFSAdapter.create(opts.vaultPath, { ripgrepPath: opts.ripgrepPath, watchPollMs: opts.watchPollMs ?? null })`. In `main.ts` pass `watchPollMs: config.watchPollMs`.

- [ ] **Step 4: Run tests, lint, typecheck** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/local-fs.ts src/vault/runtime.ts src/main.ts tests/storage/local-fs-nav.test.ts
git commit -m "feat(storage): optional polling watcher for Docker Desktop bind mounts"
```

---

### Task 4: Token store — types, hashing, `FileTokenStore`

**Files:**
- Create: `src/auth/hash.ts`, `src/auth/store/types.ts`, `src/auth/store/file-store.ts`
- Test: `tests/auth/file-store.test.ts`

**Interfaces (Produces — later tasks depend on these exact names):**

```ts
// src/auth/hash.ts
export function sha256hex(input: string): string;          // node:crypto, lowercase hex
export function randomToken(bytes = 32): string;           // base64url of randomBytes(bytes)

// src/auth/store/types.ts
export interface ClientRecord { clientId: string; clientName: string; redirectUris: string[]; fetchedAt: number; expiresAt: number; negative?: true }
export interface PendingRecord { id: string; clientId: string; clientName: string; redirectUri: string; codeChallenge: string; resource: string; scope: string; state: string; nonce: string; expiresAt: number }
export interface CodeRecord { pendingId: string; expiresAt: number; usedAt?: number }
export interface TokenRecord { kind: 'access' | 'refresh'; familyId: string; clientId: string; clientName: string; resource: string; scope: string; expiresAt: number; rotatedAt?: number; revokedAt?: number; lastUsedAt?: number }
export interface TokenStore {
  getClient(clientId: string): Promise<ClientRecord | undefined>;
  putClient(rec: ClientRecord): Promise<void>;
  putPending(rec: PendingRecord): Promise<void>;
  getPending(id: string): Promise<PendingRecord | undefined>;
  deletePending(id: string): Promise<void>;
  putCode(hash: string, rec: CodeRecord): Promise<void>;
  consumeCode(hash: string, now: number): Promise<CodeRecord | undefined>; // undefined if missing/used/expired; marks usedAt
  putToken(hash: string, rec: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | undefined>;
  updateToken(hash: string, patch: Partial<TokenRecord>): Promise<void>;
  revokeFamily(familyId: string, now: number): Promise<number>;   // returns count revoked
  revokeAll(now: number): Promise<number>;
  sweepExpired(now: number): Promise<void>;                        // drops expired pending/codes/tokens/negative clients
}
export class StoreCorruptError extends Error { readonly filePath: string }
```

`FileTokenStore`: `static async open(filePath: string): Promise<FileTokenStore>` (creates parent dir + empty doc if missing), implements `TokenStore`; every mutation goes through a private promise queue and writes `filePath + '.tmp'` then `fs.rename`; before each read it `stat`s the file and reloads when `mtimeMs` or `size` changed (external `revoke-all`). Document shape: `{ version: 1, clients: {}, pending: {}, codes: {}, tokens: {} }` validated with Zod (`z.record` of the record schemas, `.strict()` objects). Invalid JSON/shape/newer version ⇒ `StoreCorruptError`.

- [ ] **Step 1: Write the failing tests**

`tests/auth/file-store.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomToken, sha256hex } from '../../src/auth/hash.ts';
import { FileTokenStore, StoreCorruptError } from '../../src/auth/store/file-store.ts';
import type { TokenRecord } from '../../src/auth/store/types.ts';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-store-'));
  file = path.join(dir, '_brainstem', 'state.json');
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const tok = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  kind: 'access', familyId: 'fam1', clientId: 'https://claude.ai/c', clientName: 'Claude',
  resource: 'https://b.example.com/mcp', scope: 'vault', expiresAt: 2_000, ...over,
});

describe('hash helpers', () => {
  it('sha256hex is deterministic lowercase hex; randomToken is base64url of 32 bytes', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('FileTokenStore', () => {
  it('creates the file on open and round-trips records atomically', async () => {
    const store = await FileTokenStore.open(file);
    await store.putToken(sha256hex('t1'), tok());
    expect(await store.getToken(sha256hex('t1'))).toMatchObject({ kind: 'access', familyId: 'fam1' });
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number; tokens: Record<string, unknown> };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.tokens)).toEqual([sha256hex('t1')]);
    expect(await fs.readdir(path.dirname(file))).toEqual(['state.json']); // no leftover .tmp
  });

  it('consumeCode is single-use and expiry-aware', async () => {
    const store = await FileTokenStore.open(file);
    await store.putCode('h', { pendingId: 'p', expiresAt: 1_000 });
    expect(await store.consumeCode('h', 1_500)).toBeUndefined(); // expired
    await store.putCode('h2', { pendingId: 'p', expiresAt: 5_000 });
    expect(await store.consumeCode('h2', 1_000)).toMatchObject({ pendingId: 'p' });
    expect(await store.consumeCode('h2', 1_001)).toBeUndefined(); // used
  });

  it('revokeFamily and revokeAll stamp revokedAt; sweepExpired drops dead rows', async () => {
    const store = await FileTokenStore.open(file);
    await store.putToken('a', tok({ familyId: 'f1' }));
    await store.putToken('b', tok({ familyId: 'f1', kind: 'refresh', expiresAt: 9_000 }));
    await store.putToken('c', tok({ familyId: 'f2' }));
    expect(await store.revokeFamily('f1', 100)).toBe(2);
    expect((await store.getToken('a'))?.revokedAt).toBe(100);
    expect((await store.getToken('c'))?.revokedAt).toBeUndefined();
    await store.sweepExpired(2_500); // a (expired 2000) and c (expired 2000) gone, b stays (9000)
    expect(await store.getToken('a')).toBeUndefined();
    expect(await store.getToken('b')).toBeDefined();
    expect(await store.revokeAll(200)).toBe(1);
  });

  it('serialises concurrent mutations without losing writes', async () => {
    const store = await FileTokenStore.open(file);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.putToken(`h${i}`, tok())));
    const reopened = await FileTokenStore.open(file);
    let n = 0;
    for (let i = 0; i < 50; i++) if (await reopened.getToken(`h${i}`)) n++;
    expect(n).toBe(50);
  });

  it('reloads when another process changed the file', async () => {
    const a = await FileTokenStore.open(file);
    const b = await FileTokenStore.open(file);
    await a.putToken('x', tok());
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.getToken('x')).toBeDefined();
  });

  it('refuses a corrupt or newer file with StoreCorruptError naming the path', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    await expect(FileTokenStore.open(file)).rejects.toBeInstanceOf(StoreCorruptError);
    await fs.writeFile(file, JSON.stringify({ version: 2, clients: {}, pending: {}, codes: {}, tokens: {} }));
    await expect(FileTokenStore.open(file)).rejects.toThrow(file);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/auth/file-store.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/auth/hash.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
```

`src/auth/store/types.ts`: the interfaces above, plus

```ts
export class StoreCorruptError extends Error {
  readonly filePath: string;
  constructor(filePath: string, reason: string) {
    super(`Auth state file ${filePath} is unusable (${reason}). Fix it or run \`npm run revoke-all -- --reset\`.`);
    this.name = 'StoreCorruptError';
    this.filePath = filePath;
  }
}
```

`src/auth/store/file-store.ts` (core shape; fill the remaining methods the same way):

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type ClientRecord, type CodeRecord, type PendingRecord, StoreCorruptError, type TokenRecord, type TokenStore } from './types.ts';

const Client = z.object({ clientId: z.string(), clientName: z.string(), redirectUris: z.array(z.string()), fetchedAt: z.number(), expiresAt: z.number(), negative: z.literal(true).optional() }).strict();
const Pending = z.object({ id: z.string(), clientId: z.string(), clientName: z.string(), redirectUri: z.string(), codeChallenge: z.string(), resource: z.string(), scope: z.string(), state: z.string(), nonce: z.string(), expiresAt: z.number() }).strict();
const Code = z.object({ pendingId: z.string(), expiresAt: z.number(), usedAt: z.number().optional() }).strict();
const Token = z.object({ kind: z.enum(['access', 'refresh']), familyId: z.string(), clientId: z.string(), clientName: z.string(), resource: z.string(), scope: z.string(), expiresAt: z.number(), rotatedAt: z.number().optional(), revokedAt: z.number().optional(), lastUsedAt: z.number().optional() }).strict();
const Doc = z.object({ version: z.literal(1), clients: z.record(z.string(), Client), pending: z.record(z.string(), Pending), codes: z.record(z.string(), Code), tokens: z.record(z.string(), Token) }).strict();
type Doc = z.infer<typeof Doc>;

const EMPTY: Doc = { version: 1, clients: {}, pending: {}, codes: {}, tokens: {} };

export class FileTokenStore implements TokenStore {
  private doc: Doc;
  private stamp: { mtimeMs: number; size: number };
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly filePath: string, doc: Doc, stamp: { mtimeMs: number; size: number }) {
    this.doc = doc;
    this.stamp = stamp;
  }

  static async open(filePath: string): Promise<FileTokenStore> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let text: string | null = null;
    try { text = await fs.readFile(filePath, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (text === null) {
      await writeAtomic(filePath, EMPTY);
      const st = await fs.stat(filePath);
      return new FileTokenStore(filePath, structuredClone(EMPTY), { mtimeMs: st.mtimeMs, size: st.size });
    }
    const st = await fs.stat(filePath);
    return new FileTokenStore(filePath, parseDoc(filePath, text), { mtimeMs: st.mtimeMs, size: st.size });
  }

  private async reloadIfChanged(): Promise<void> {
    const st = await fs.stat(this.filePath).catch(() => null);
    if (!st) return;
    if (st.mtimeMs !== this.stamp.mtimeMs || st.size !== this.stamp.size) {
      this.doc = parseDoc(this.filePath, await fs.readFile(this.filePath, 'utf8'));
      this.stamp = { mtimeMs: st.mtimeMs, size: st.size };
    }
  }

  private mutate<T>(fn: (doc: Doc) => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.reloadIfChanged();
      const result = fn(this.doc);
      await writeAtomic(this.filePath, this.doc);
      const st = await fs.stat(this.filePath);
      this.stamp = { mtimeMs: st.mtimeMs, size: st.size };
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getClient(clientId: string) { await this.reloadIfChanged(); return this.doc.clients[clientId]; }
  putClient(rec: ClientRecord) { return this.mutate((d) => { d.clients[rec.clientId] = rec; }); }
  putPending(rec: PendingRecord) { return this.mutate((d) => { d.pending[rec.id] = rec; }); }
  async getPending(id: string) { await this.reloadIfChanged(); return this.doc.pending[id]; }
  deletePending(id: string) { return this.mutate((d) => { delete d.pending[id]; }); }
  putCode(hash: string, rec: CodeRecord) { return this.mutate((d) => { d.codes[hash] = rec; }); }
  consumeCode(hash: string, now: number) {
    return this.mutate((d) => {
      const rec = d.codes[hash];
      if (!rec || rec.usedAt !== undefined || rec.expiresAt <= now) return undefined;
      rec.usedAt = now;
      return { ...rec };
    });
  }
  putToken(hash: string, rec: TokenRecord) { return this.mutate((d) => { d.tokens[hash] = rec; }); }
  async getToken(hash: string) { await this.reloadIfChanged(); return this.doc.tokens[hash]; }
  updateToken(hash: string, patch: Partial<TokenRecord>) {
    return this.mutate((d) => { const t = d.tokens[hash]; if (t) Object.assign(t, patch); });
  }
  revokeFamily(familyId: string, now: number) {
    return this.mutate((d) => {
      let n = 0;
      for (const t of Object.values(d.tokens)) if (t.familyId === familyId && t.revokedAt === undefined) { t.revokedAt = now; n++; }
      return n;
    });
  }
  revokeAll(now: number) {
    return this.mutate((d) => {
      let n = 0;
      for (const t of Object.values(d.tokens)) if (t.revokedAt === undefined) { t.revokedAt = now; n++; }
      d.codes = {}; d.pending = {};
      return n;
    });
  }
  sweepExpired(now: number) {
    return this.mutate((d) => {
      for (const [k, v] of Object.entries(d.pending)) if (v.expiresAt <= now) delete d.pending[k];
      for (const [k, v] of Object.entries(d.codes)) if (v.expiresAt <= now || v.usedAt !== undefined) delete d.codes[k];
      for (const [k, v] of Object.entries(d.tokens)) if (v.expiresAt <= now) delete d.tokens[k];
      for (const [k, v] of Object.entries(d.clients)) if (v.negative && v.expiresAt <= now) delete d.clients[k];
    });
  }
}

function parseDoc(filePath: string, text: string): Doc {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new StoreCorruptError(filePath, 'not valid JSON'); }
  const parsed = Doc.safeParse(json);
  if (!parsed.success) {
    const v = (json as { version?: unknown })?.version;
    throw new StoreCorruptError(filePath, typeof v === 'number' && v > 1 ? `written by a newer version (${v})` : 'unexpected shape');
  }
  return parsed.data;
}

async function writeAtomic(filePath: string, doc: Doc): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}
```

(`revokeAll` also clears codes and pending — spec §5 `revoke-all`.) Note: the "reloads when another process changed the file" test relies on mtime/size changing; both stores write to the same path, so `b`'s next read sees a different stamp.

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/hash.ts src/auth/store tests/auth/file-store.test.ts
git commit -m "feat(auth): FileTokenStore — hashed OAuth state in a JSON file with atomic writes"
```

---

### Task 5: Owner authentication with global lockout

**Files:**
- Create: `src/auth/owner.ts`
- Test: `tests/auth/owner.test.ts`

**Interfaces:**
```ts
export interface OwnerAuthOptions { now?: () => number; maxAttempts?: number; windowMs?: number; lockoutMs?: number }
export type OwnerVerdict = { ok: true } | { ok: false; reason: 'invalid' | 'locked'; retryAfterS: number };
export interface OwnerAuth { verify(candidate: string): OwnerVerdict; isLocked(): boolean }
export function createOwnerAuth(secret: string, opts?: OwnerAuthOptions): OwnerAuth;
```
Defaults: 5 attempts per rolling 60 s, lockout 15 min. Comparison: `timingSafeEqual` on SHA-256 digests of both strings (equal length by construction, no early exit on length).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createOwnerAuth } from '../../src/auth/owner.ts';

describe('createOwnerAuth', () => {
  it('accepts the exact secret and rejects everything else', () => {
    const auth = createOwnerAuth('s3cret-s3cret-s3cret-s3cret-s3cret');
    expect(auth.verify('s3cret-s3cret-s3cret-s3cret-s3cret')).toEqual({ ok: true });
    expect(auth.verify('s3cret-s3cret-s3cret-s3cret-s3creT').ok).toBe(false);
    expect(auth.verify('').ok).toBe(false);
  });
  it('locks after 5 failures within a minute and unlocks after the lockout', () => {
    let t = 0;
    const auth = createOwnerAuth('right', { now: () => t });
    for (let i = 0; i < 4; i++) expect(auth.verify('wrong')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(auth.verify('wrong')).toMatchObject({ ok: false, reason: 'locked', retryAfterS: 900 }); // 5th failure trips the lock
    expect(auth.verify('right')).toMatchObject({ ok: false, reason: 'locked' });
    expect(auth.isLocked()).toBe(true);
    t = 15 * 60_000;
    expect(auth.verify('right')).toEqual({ ok: true });
  });
  it('forgets failures older than the window', () => {
    let t = 0;
    const auth = createOwnerAuth('right', { now: () => t });
    for (let i = 0; i < 4; i++) auth.verify('wrong');
    t = 61_000;
    auth.verify('wrong');
    expect(auth.verify('right')).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

export interface OwnerAuthOptions { now?: () => number; maxAttempts?: number; windowMs?: number; lockoutMs?: number }
export type OwnerVerdict = { ok: true } | { ok: false; reason: 'invalid' | 'locked'; retryAfterS: number };
export interface OwnerAuth { verify(candidate: string): OwnerVerdict; isLocked(): boolean }

export function createOwnerAuth(secret: string, opts: OwnerAuthOptions = {}): OwnerAuth {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 5;
  const windowMs = opts.windowMs ?? 60_000;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  let failures: number[] = [];
  let lockedUntil = 0;

  const isLocked = (): boolean => now() < lockedUntil;

  return {
    isLocked,
    verify(candidate) {
      const t = now();
      if (t < lockedUntil) return { ok: false, reason: 'locked', retryAfterS: Math.ceil((lockedUntil - t) / 1000) };
      const actual = createHash('sha256').update(candidate, 'utf8').digest();
      if (timingSafeEqual(actual, expected)) {
        failures = [];
        return { ok: true };
      }
      failures = failures.filter((f) => t - f < windowMs);
      failures.push(t);
      if (failures.length >= maxAttempts) {
        lockedUntil = t + lockoutMs;
        failures = [];
        return { ok: false, reason: 'locked', retryAfterS: Math.ceil(lockoutMs / 1000) };
      }
      return { ok: false, reason: 'invalid', retryAfterS: 0 };
    },
  };
}
```

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): owner secret verification with constant-time compare and global lockout"`

---

### Task 6: Resource server — verifier, PRM, AS metadata, protected `/mcp`

**Files:**
- Create: `src/auth/rs/verifier.ts`, `src/auth/as/metadata.ts`, `src/auth/mount.ts`, `tests/helpers/auth.ts`
- Modify: `src/app.ts` (`createApp(config, logger, resolveRuntime, auth)`), `tests/tools/harness.ts`, `tests/app.test.ts`, `tests/server.test.ts`, `tests/smoke.test.ts`, `src/server.ts`, `src/main.ts`
- Test: `tests/auth/oauth-rs.test.ts`

**Interfaces:**
```ts
// src/auth/rs/verifier.ts
export function createTokenVerifier(store: TokenStore, mcpUrl: URL, now: () => number): OAuthTokenVerifier;
// AuthInfo returned: { token, clientId, scopes: rec.scope.split(' '), expiresAt: Math.floor(rec.expiresAt/1000), resource: new URL(rec.resource), extra: { userId: 'owner', clientName } }
// src/auth/as/metadata.ts
export function buildAuthorizationServerMetadata(publicUrl: URL): OAuthMetadata;  // type from @modelcontextprotocol/core
// src/auth/mount.ts
export interface AuthDeps { store: TokenStore; verifier: OAuthTokenVerifier; ownerAuth: OwnerAuth; cimd: CimdResolver; now: () => number }
export function createAuth(config: Config, logger: Logger, store: TokenStore, over?: Partial<Pick<AuthDeps, 'cimd' | 'now'>>): AuthDeps;
export function mountAuth(app: Express, config: Config, logger: Logger, auth: AuthDeps): void; // metadata router + AS routers (AS routers come in Tasks 8–9; Task 6 mounts only the metadata router and exports the function)
// src/app.ts
export function createApp(config: Config, logger: Logger, resolveRuntime: RuntimeResolver, auth: AuthDeps): AppBundle;
// tests/helpers/auth.ts
export async function createTestAuth(config: Config, root: string): Promise<{ auth: AuthDeps; store: FileTokenStore; issueAccessToken(over?: Partial<TokenRecord>): Promise<string> }>;
```
`CimdResolver` is defined in Task 7; for Task 6 declare it in `src/auth/as/cimd.ts` as `export interface CimdResolver { resolveClient(clientId: string): Promise<ClientRecord> }` with a stub `createCimdResolver()` that throws `new Error('not implemented')` — Task 7 replaces it.

`issueAccessToken` writes a real random token's hash into the store with `resource = config.mcpUrl.href`, `expiresAt = Date.now() + 3600_000`, and returns the plaintext token. The harness passes it through the transport: `new StreamableHTTPClientTransport(url, { authProvider: { token: async () => accessToken } })`.

- [ ] **Step 1: Failing tests** — `tests/auth/oauth-rs.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';
import { createTestAuth } from '../helpers/auth.ts';
import { baseEnv } from '../helpers/env.ts';

const config = loadConfig(baseEnv());
let server: Server; let base: string; let runtime: VaultRuntime; let root: string;
let issue: (over?: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-rs-'));
  runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  const t = await createTestAuth(config, root);
  issue = t.issueAccessToken;
  const { app } = createApp(config, createLogger('fatal'), async () => runtime, t.auth);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });

const rpc = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

describe('resource server', () => {
  it('answers 401 with the RFC 9728 challenge and scope when there is no token', async () => {
    const res = await rpc({});
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www).toContain('Bearer');
    expect(www).toContain('resource_metadata="https://brainstem.example.com/.well-known/oauth-protected-resource/mcp"');
    expect(www).toContain('scope="vault"');
  });
  it('serves PRM at both well-known paths with resource = mcpUrl', async () => {
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const body = (await (await fetch(`${base}${p}`)).json()) as Record<string, unknown>;
      expect(body.resource).toBe('https://brainstem.example.com/mcp');
      expect(body.authorization_servers).toEqual(['https://brainstem.example.com/']);
      expect(body.scopes_supported).toEqual(['vault']);
    }
  });
  it('serves AS metadata with CIMD + none + S256 + iss and no registration_endpoint', async () => {
    const body = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: 'https://brainstem.example.com/',
      authorization_endpoint: 'https://brainstem.example.com/oauth/authorize',
      token_endpoint: 'https://brainstem.example.com/oauth/token',
      revocation_endpoint: 'https://brainstem.example.com/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      scopes_supported: ['vault'],
    });
    expect(body.registration_endpoint).toBeUndefined();
  });
  it('accepts a valid token and rejects expired, revoked, refresh-kind and wrong-audience tokens', async () => {
    const ok = await issue();
    expect((await rpc({ authorization: `Bearer ${ok}` })).status).toBe(200);
    const expired = await issue({ expiresAt: Date.now() - 1 });
    expect((await rpc({ authorization: `Bearer ${expired}` })).status).toBe(401);
    const revoked = await issue({ revokedAt: Date.now() });
    expect((await rpc({ authorization: `Bearer ${revoked}` })).status).toBe(401);
    const refresh = await issue({ kind: 'refresh' });
    expect((await rpc({ authorization: `Bearer ${refresh}` })).status).toBe(401);
    const other = await issue({ resource: 'https://other.example.com/mcp' });
    expect((await rpc({ authorization: `Bearer ${other}` })).status).toBe(401);
    expect((await rpc({ authorization: 'Bearer nope' })).status).toBe(401);
  });
  it('rate-limits a burst above 60 requests per second with 429', async () => {
    let t = 0;
    const { createRateLimiter } = await import('../../src/auth/mount.ts');
    const limiter = createRateLimiter({ capacity: 60, refillPerSec: 60, now: () => t });
    const statuses: number[] = [];
    const res = { setHeader() {}, status(c: number) { statuses.push(c); return this; }, json() { return this; } } as unknown as import('express').Response;
    for (let i = 0; i < 61; i++) limiter({} as import('express').Request, res, () => statuses.push(200));
    expect(statuses.filter((c) => c === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
    t = 1_000; // one second later the bucket is full again
    limiter({} as import('express').Request, res, () => statuses.push(200));
    expect(statuses.at(-1)).toBe(200);
  });
  it('stamps lastUsedAt on use', async () => {
    const t = await createTestAuth(config, root);
    const token = await t.issueAccessToken();
    // token issued into the same file; a second app instance is not needed: read via store
    await rpc({ authorization: `Bearer ${token}` });
    const { sha256hex } = await import('../../src/auth/hash.ts');
    expect((await t.store.getToken(sha256hex(token)))?.lastUsedAt).toBeTypeOf('number');
  });
});
```

- [ ] **Step 2: Run** → FAIL (`createApp` arity, modules missing).

- [ ] **Step 3: Implement**

`src/auth/rs/verifier.ts`:

```ts
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { sha256hex } from '../hash.ts';
import type { TokenStore } from '../store/types.ts';

export function createTokenVerifier(store: TokenStore, mcpUrl: URL, now: () => number): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const hash = sha256hex(token);
      const rec = await store.getToken(hash);
      const t = now();
      if (!rec || rec.kind !== 'access' || rec.revokedAt !== undefined || rec.expiresAt <= t || rec.resource !== mcpUrl.href) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid or expired access token');
      }
      void store.updateToken(hash, { lastUsedAt: t });
      return {
        token,
        clientId: rec.clientId,
        scopes: rec.scope.split(' ').filter(Boolean),
        expiresAt: Math.floor(rec.expiresAt / 1000),
        resource: new URL(rec.resource),
        extra: { userId: 'owner', clientName: rec.clientName },
      };
    },
  };
}
```

`src/auth/as/metadata.ts`:

```ts
import type { OAuthMetadata } from '@modelcontextprotocol/core';

export const SCOPE = 'vault';

export function buildAuthorizationServerMetadata(publicUrl: URL): OAuthMetadata {
  const u = (p: string): string => new URL(p, publicUrl).href;
  return {
    issuer: publicUrl.href,
    authorization_endpoint: u('/oauth/authorize'),
    token_endpoint: u('/oauth/token'),
    revocation_endpoint: u('/oauth/revoke'),
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
```

(`new URL('/oauth/authorize', publicUrl)` drops a path prefix; if `publicUrl.pathname !== '/'`, build with `${publicUrl.href.replace(/\/$/, '')}/oauth/authorize` instead — write a small `join(publicUrl, path)` helper and use it everywhere URLs are advertised.)

`src/auth/mount.ts`:

```ts
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Express, RequestHandler } from 'express';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { type CimdResolver, createCimdResolver } from './as/cimd.ts';
import { buildAuthorizationServerMetadata, SCOPE } from './as/metadata.ts';
import { createOwnerAuth, type OwnerAuth } from './owner.ts';
import { createTokenVerifier } from './rs/verifier.ts';
import type { TokenStore } from './store/types.ts';

export interface AuthDeps { store: TokenStore; verifier: OAuthTokenVerifier; ownerAuth: OwnerAuth; cimd: CimdResolver; now: () => number }

export function createAuth(config: Config, logger: Logger, store: TokenStore, over: Partial<Pick<AuthDeps, 'cimd' | 'now'>> = {}): AuthDeps {
  const now = over.now ?? Date.now;
  return {
    store,
    now,
    verifier: createTokenVerifier(store, config.mcpUrl, now),
    ownerAuth: createOwnerAuth(config.ownerSecret, { now }),
    cimd: over.cimd ?? createCimdResolver({ allowedHosts: config.cimdAllowedHosts, store, now, logger }),
  };
}

/** Global token bucket for /mcp (spec §7: 60 req/s). Single-user ⇒ one bucket, keyed by nothing. */
export function createRateLimiter(opts: { capacity: number; refillPerSec: number; now: () => number }): RequestHandler {
  let tokens = opts.capacity;
  let last = opts.now();
  return (_req, res, next) => {
    const t = opts.now();
    tokens = Math.min(opts.capacity, tokens + ((t - last) / 1000) * opts.refillPerSec);
    last = t;
    if (tokens < 1) {
      res.setHeader('Retry-After', '1');
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limited' }, id: null });
      return;
    }
    tokens -= 1;
    next();
  };
}

export function bearerGate(config: Config, auth: AuthDeps): RequestHandler {
  return requireBearerAuth({
    verifier: auth.verifier,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
}

export function mountAuth(app: Express, config: Config, logger: Logger, auth: AuthDeps): void {
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildAuthorizationServerMetadata(config.publicUrl),
      resourceServerUrl: config.mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: 'brainstem-mcp vault',
      dangerouslyAllowInsecureIssuerUrl: config.publicUrl.protocol !== 'https:',
    }),
  );
  // Tasks 8 and 9 add: app.use(createAuthorizeRouter(config, logger, auth)); app.use(createTokenRouter(config, logger, auth));
}
```

`src/app.ts`: add the `auth: AuthDeps` parameter; call `mountAuth(app, config, logger, auth)` right after `app.disable('x-powered-by')` (before `/health`); change the `/mcp` route to `app.all('/mcp', createRateLimiter({ capacity: 60, refillPerSec: 60, now: auth.now }), bearerGate(config, auth), (req, res) => { … })` (the limiter runs before token verification so a flood cannot cost hash lookups). Because `requireBearerAuth` sets `req.auth`, `toNodeHandler` forwards it as `ctx.authInfo` automatically. Update `src/server.ts` (`startServer(config, logger, resolveRuntime, auth, listenPort?, opts?)`) and `src/main.ts` (open `FileTokenStore` at `path.join(config.stateDir ?? path.join(config.storage.vaultPath, '_brainstem'), 'state.json')`, `createAuth`, pass through; on `StoreCorruptError` print the message and exit 1).

`tests/helpers/auth.ts`:

```ts
import path from 'node:path';
import { randomToken, sha256hex } from '../../src/auth/hash.ts';
import { type AuthDeps, createAuth } from '../../src/auth/mount.ts';
import { FileTokenStore } from '../../src/auth/store/file-store.ts';
import type { TokenRecord } from '../../src/auth/store/types.ts';
import type { Config } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';

export async function createTestAuth(config: Config, root: string, over: Parameters<typeof createAuth>[3] = {}) {
  const store = await FileTokenStore.open(path.join(root, '_brainstem', 'state.json'));
  const auth = createAuth(config, createLogger('fatal'), store, over);
  return {
    auth,
    store,
    async issueAccessToken(o: Partial<TokenRecord> = {}): Promise<string> {
      const token = randomToken();
      await store.putToken(sha256hex(token), {
        kind: 'access', familyId: randomToken(8), clientId: 'https://claude.ai/oauth/test-client', clientName: 'Test',
        resource: config.mcpUrl.href, scope: 'vault', expiresAt: Date.now() + 3_600_000, ...o,
      });
      return token;
    },
  };
}
```

Update `tests/tools/harness.ts`: after creating the runtime, `const t = await createTestAuth(config, root); const token = await t.issueAccessToken();` pass `t.auth` to `createApp` and `{ authProvider: { token: async () => token } }` as the transport's second argument; expose `auth: t` on the harness. Update `tests/app.test.ts` / `tests/server.test.ts` / `tests/smoke.test.ts` the same way (a bearer on every MCP call). `createCimdResolver` stub for now in `src/auth/as/cimd.ts`:

```ts
import type { Logger } from '../../logger.ts';
import type { ClientRecord, TokenStore } from '../store/types.ts';
export interface CimdResolver { resolveClient(clientId: string): Promise<ClientRecord> }
export interface CimdResolverOptions { allowedHosts: string[]; store: TokenStore; now: () => number; logger: Logger }
export function createCimdResolver(_opts: CimdResolverOptions): CimdResolver {
  return { async resolveClient() { throw new Error('CIMD resolver is implemented in Task 7'); } };
}
```

- [ ] **Step 4: Run the full suite** — `npm test && npm run lint:fix && npm run typecheck` → PASS (the existing legacy-client tests in `app.test.ts` must also send the bearer; `GET /mcp` for legacy SSE probes still returns 401 without a token — that is correct).

- [ ] **Step 5: Commit**

```bash
git add src/auth src/app.ts src/server.ts src/main.ts tests
git commit -m "feat(auth): protect /mcp with requireBearerAuth; serve PRM and AS metadata"
```

---

### Task 7: CIMD resolver — allowlist, safe fetch, validation, cache

**Files:**
- Create: `src/auth/as/net.ts`, replace stub in `src/auth/as/cimd.ts`
- Test: `tests/auth/cimd.test.ts`

**Interfaces:**
```ts
// net.ts
export function assertPublicAddress(ip: string): void;            // throws Error('special-use address') for RFC 6890 ranges (v4 + v6)
export interface FetchedDocument { status: number; headers: Record<string, string>; body: string }
export interface FetchDocumentOptions { timeoutMs: number; maxBytes: number; ip: string; allowInsecureHttp?: boolean }
export function fetchClientMetadataDocument(url: URL, opts: FetchDocumentOptions): Promise<FetchedDocument>;
// cimd.ts
export interface CimdResolverOptions { allowedHosts: string[]; store: TokenStore; now: () => number; logger: Logger; lookup?: (hostname: string) => Promise<string>; fetchDocument?: typeof fetchClientMetadataDocument }
export function createCimdResolver(opts: CimdResolverOptions): CimdResolver;   // resolveClient throws OAuthError(InvalidClient, …)
export function cacheTtlMs(headers: Record<string, string>, now: number): number;  // shared-cache semantics, default 3_600_000, 0 for no-store/private
export function validateClientIdUrl(clientId: string): URL;                    // https, explicit path, no creds/fragment/dot segments
```

`fetchClientMetadataDocument` uses `node:https` (`node:http` only when `allowInsecureHttp`) with `lookup: (_h, _o, cb) => cb(null, [{ address: opts.ip, family: opts.ip.includes(':') ? 6 : 4 }])`, `servername: url.hostname`, `headers: { accept: 'application/json', host: url.host }`, `timeout: opts.timeoutMs`; rejects any 3xx (no redirects), any status ≠ 200, `content-type` not `application/json` or `application/*+json`, and aborts when more than `maxBytes` arrive.

- [ ] **Step 1: Failing tests** — `tests/auth/cimd.test.ts` (uses a local `http` server with `allowInsecureHttp: true` and `ip: '127.0.0.1'`):

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPublicAddress, fetchClientMetadataDocument } from '../../src/auth/as/net.ts';
import { cacheTtlMs, createCimdResolver, validateClientIdUrl } from '../../src/auth/as/cimd.ts';
import { FileTokenStore } from '../../src/auth/store/file-store.ts';
import { createLogger } from '../../src/logger.ts';
import { promises as fs } from 'node:fs'; import os from 'node:os'; import path from 'node:path';

describe('assertPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1'])('rejects %s', (ip) => {
    expect(() => assertPublicAddress(ip)).toThrow(/special-use/);
  });
  it.each(['104.16.1.1', '2606:4700::1111'])('accepts %s', (ip) => { expect(() => assertPublicAddress(ip)).not.toThrow(); });
});

describe('validateClientIdUrl', () => {
  it('requires https with an explicit path and no credentials/fragment/dot segments', () => {
    expect(validateClientIdUrl('https://claude.ai/oauth/claude-code-client-metadata').pathname).toBe('/oauth/claude-code-client-metadata');
    for (const bad of ['http://claude.ai/x', 'https://claude.ai', 'https://claude.ai/', 'https://u:p@claude.ai/x', 'https://claude.ai/x#f', 'https://claude.ai/a/../x', 'not a url']) {
      expect(() => validateClientIdUrl(bad)).toThrow();
    }
  });
});

describe('cacheTtlMs', () => {
  it('prefers s-maxage, then max-age, then Expires; no-store/private disable caching', () => {
    expect(cacheTtlMs({ 'cache-control': 'public, max-age=60, s-maxage=120' }, 0)).toBe(120_000);
    expect(cacheTtlMs({ 'cache-control': 'max-age=60' }, 0)).toBe(60_000);
    expect(cacheTtlMs({ expires: new Date(30_000).toUTCString() }, 0)).toBe(30_000);
    expect(cacheTtlMs({ 'cache-control': 'no-store' }, 0)).toBe(0);
    expect(cacheTtlMs({ 'cache-control': 'private, max-age=60' }, 0)).toBe(0);
    expect(cacheTtlMs({}, 0)).toBe(3_600_000);
  });
});

describe('fetchClientMetadataDocument + resolver', () => {
  let server: http.Server; let port: number; let mode = 'ok';
  const doc = (clientId: string) => JSON.stringify({ client_id: clientId, client_name: 'Test Client', redirect_uris: ['http://localhost/callback', 'https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const clientId = `https://claude.ai${req.url}`;
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://evil.example/x' }); return res.end(); }
      if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
      if (mode === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(`{"pad":"${'x'.repeat(6000)}"}`); }
      if (mode === 'mismatch') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(doc('https://claude.ai/other')); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' }); res.end(doc(clientId));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const mk = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-cimd-'));
    const store = await FileTokenStore.open(path.join(dir, 'state.json'));
    let now = 1_000_000;
    const resolver = createCimdResolver({
      allowedHosts: ['claude.ai'], store, now: () => now, logger: createLogger('fatal'),
      lookup: async () => '127.0.0.1',
      fetchDocument: (url, o) => fetchClientMetadataDocument(new URL(`http://127.0.0.1:${port}${url.pathname}`), { ...o, allowInsecureHttp: true }),
    });
    return { resolver, store, tick: (ms: number) => { now += ms; } };
  };

  it('resolves, validates and caches an allowed client', async () => {
    mode = 'ok';
    const { resolver, store, tick } = await mk();
    const rec = await resolver.resolveClient('https://claude.ai/oauth/test-client');
    expect(rec).toMatchObject({ clientName: 'Test Client', redirectUris: expect.arrayContaining(['http://localhost/callback']) });
    expect((await store.getClient('https://claude.ai/oauth/test-client'))?.expiresAt).toBe(1_000_000 + 300_000);
    mode = 'html'; // cached copy must be used, so the html server is never consulted
    tick(1_000);
    expect((await resolver.resolveClient('https://claude.ai/oauth/test-client')).clientName).toBe('Test Client');
  });
  it('rejects hosts outside the allowlist without fetching', async () => {
    const { resolver } = await mk();
    await expect(resolver.resolveClient('https://evil.example/c')).rejects.toMatchObject({ code: 'invalid_client' });
  });
  it.each(['redirect', 'html', 'big', 'mismatch'])('rejects a %s document', async (m) => {
    mode = m;
    const { resolver } = await mk();
    await expect(resolver.resolveClient(`https://claude.ai/oauth/${m}`)).rejects.toMatchObject({ code: 'invalid_client' });
  });
  it('negative-caches a failure for 5 minutes', async () => {
    mode = 'html';
    const { resolver, store } = await mk();
    await expect(resolver.resolveClient('https://claude.ai/oauth/neg')).rejects.toBeDefined();
    expect((await store.getClient('https://claude.ai/oauth/neg'))?.negative).toBe(true);
    mode = 'ok';
    await expect(resolver.resolveClient('https://claude.ai/oauth/neg')).rejects.toBeDefined(); // still negative
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`src/auth/as/net.ts`:

```ts
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const V4_SPECIAL: Array<[number, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([cidr, bits]) => [v4ToInt(cidr as string), bits as number]);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0);
}

function v4IsSpecial(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_SPECIAL.some(([base, bits]) => bits === 0 || (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

export function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) {
    if (v4IsSpecial(ip)) throw new Error(`refusing special-use address ${ip}`);
    return;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return assertPublicAddress(mapped[1]);
    if (lower === '::' || lower === '::1' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff') || lower.startsWith('2001:db8') || lower.startsWith('64:ff9b')) {
      throw new Error(`refusing special-use address ${ip}`);
    }
    return;
  }
  throw new Error(`refusing special-use address ${ip}`);
}

export interface FetchedDocument { status: number; headers: Record<string, string>; body: string }
export interface FetchDocumentOptions { timeoutMs: number; maxBytes: number; ip: string; allowInsecureHttp?: boolean }

export function fetchClientMetadataDocument(url: URL, opts: FetchDocumentOptions): Promise<FetchedDocument> {
  const insecure = url.protocol === 'http:';
  if (insecure && !opts.allowInsecureHttp) return Promise.reject(new Error('client metadata must be served over https'));
  const mod = insecure ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', host: url.host, 'user-agent': 'brainstem-mcp' },
        servername: url.hostname,
        timeout: opts.timeoutMs,
        lookup: (_h, _o, cb) => (cb as (e: null, addrs: Array<{ address: string; family: number }>) => void)(null, [{ address: opts.ip, family: opts.ip.includes(':') ? 6 : 4 }]),
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) { req.destroy(new Error(`document larger than ${opts.maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout fetching client metadata')));
    req.on('error', reject);
    req.end();
  });
}
```

(`lookup` typing: cast through `unknown` if TypeScript complains about the callback overloads; keep the `family` numeric.)

`src/auth/as/cimd.ts`:

```ts
import { promises as dns } from 'node:dns';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../../logger.ts';
import type { ClientRecord, TokenStore } from '../store/types.ts';
import { assertPublicAddress, fetchClientMetadataDocument } from './net.ts';

export interface CimdResolver { resolveClient(clientId: string): Promise<ClientRecord> }
export interface CimdResolverOptions {
  allowedHosts: string[]; store: TokenStore; now: () => number; logger: Logger;
  lookup?: (hostname: string) => Promise<string>;
  fetchDocument?: typeof fetchClientMetadataDocument;
}

const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 3_600_000;
const NEGATIVE_TTL_MS = 300_000;

const Document = z.object({
  client_id: z.string(),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.url()).min(1),
  token_endpoint_auth_method: z.literal('none').optional(),
}).loose();

export function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try { url = new URL(clientId); } catch { throw invalid('client_id is not a URL'); }
  if (url.protocol !== 'https:') throw invalid('client_id must be https');
  if (url.username || url.password) throw invalid('client_id must not carry credentials');
  if (url.hash) throw invalid('client_id must not carry a fragment');
  if (url.pathname === '/' || url.pathname === '') throw invalid('client_id must have an explicit path');
  if (url.pathname.split('/').some((s) => s === '.' || s === '..')) throw invalid('client_id must not contain dot segments');
  if (url.href !== clientId) throw invalid('client_id must be in canonical form');
  return url;
}

export function cacheTtlMs(headers: Record<string, string>, now: number): number {
  const cc = (headers['cache-control'] ?? '').toLowerCase();
  if (/\bno-store\b/.test(cc) || /\bprivate\b/.test(cc)) return 0;
  const sMax = cc.match(/\bs-maxage=(\d+)/); if (sMax?.[1]) return Number(sMax[1]) * 1000;
  const max = cc.match(/\bmax-age=(\d+)/); if (max?.[1]) return Number(max[1]) * 1000;
  if (headers.expires) { const t = Date.parse(headers.expires); if (!Number.isNaN(t)) return Math.max(0, t - now); }
  return DEFAULT_TTL_MS;
}

function invalid(msg: string): OAuthError { return new OAuthError(OAuthErrorCode.InvalidClient, msg); }

async function defaultLookup(hostname: string): Promise<string> {
  const { address } = await dns.lookup(hostname, { verbatim: true });
  return address;
}

export function createCimdResolver(opts: CimdResolverOptions): CimdResolver {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchDocument = opts.fetchDocument ?? fetchClientMetadataDocument;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  return {
    async resolveClient(clientId) {
      const url = validateClientIdUrl(clientId);
      if (!allowed.has(url.hostname.toLowerCase())) {
        opts.logger.warn({ host: url.hostname }, 'CIMD client host not in CIMD_ALLOWED_HOSTS');
        throw invalid(`client host ${url.hostname} is not allowed`);
      }
      const now = opts.now();
      const cached = await opts.store.getClient(clientId);
      if (cached && cached.expiresAt > now) {
        if (cached.negative) throw invalid('client metadata could not be fetched recently');
        return cached;
      }
      try {
        const ip = await lookup(url.hostname);
        assertPublicAddress(ip);
        const res = await fetchDocument(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, ip });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const ct = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (ct !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(ct)) throw new Error(`content-type ${ct}`);
        const parsed = Document.safeParse(JSON.parse(res.body));
        if (!parsed.success) throw new Error('document shape');
        if (parsed.data.client_id !== clientId) throw new Error('client_id mismatch');
        const ttl = cacheTtlMs(res.headers, now);
        const rec: ClientRecord = { clientId, clientName: parsed.data.client_name, redirectUris: parsed.data.redirect_uris, fetchedAt: now, expiresAt: now + ttl };
        if (ttl > 0) await opts.store.putClient(rec);
        return rec;
      } catch (error) {
        opts.logger.warn({ clientId, err: error }, 'CIMD fetch rejected');
        await opts.store.putClient({ clientId, clientName: '', redirectUris: [], fetchedAt: now, expiresAt: now + NEGATIVE_TTL_MS, negative: true });
        throw invalid('client metadata document is invalid or unreachable');
      }
    },
  };
}
```

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): CIMD resolver with host allowlist, pinned safe fetch, strict validation and cache"`

---

### Task 8: `/oauth/authorize` and the consent + owner-secret page

**Files:**
- Create: `src/auth/as/consent.ts`, `src/auth/as/authorize.ts`
- Modify: `src/auth/mount.ts` (mount the router)
- Test: `tests/auth/oauth-authorize.test.ts`

**Interfaces:**
```ts
// consent.ts
export interface ConsentView { clientName: string; redirectHost: string; loopbackOnly: boolean; pendingId: string; nonce: string; error?: string; lockedForS?: number }
export function renderConsentPage(v: ConsentView): string;   // full HTML document, no external assets, form POST /oauth/consent
export function renderErrorPage(title: string, detail: string): string;
// authorize.ts
export function createAuthorizeRouter(config: Config, logger: Logger, auth: AuthDeps): Router;
export function matchesRedirectUri(candidate: string, registered: string[]): boolean;  // exact match; loopback hosts ignore port
export const PENDING_TTL_MS = 600_000; export const CODE_TTL_MS = 60_000;
```
Both routes set `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

Behaviour (spec §4.2 authorize/consent):
- `GET /oauth/authorize`: read query; if `client_id` invalid or `redirect_uri` unregistered ⇒ `400` HTML error page (never redirect). Otherwise, validation errors ⇒ `302 redirect_uri?error=…&error_description=…&state=…&iss=<issuer>`: `response_type !== 'code'` → `unsupported_response_type`; missing `code_challenge` or `code_challenge_method !== 'S256'` → `invalid_request`; `resource` present and ≠ `config.mcpUrl.href` → `invalid_target`; `scope` present and not ⊆ `{vault}` → `invalid_scope`; missing `state` → `invalid_request`. Success ⇒ store `PendingRecord` (`id = randomToken(16)`, `nonce = randomToken(16)`, `expiresAt = now + PENDING_TTL_MS`, `scope = 'vault'`, `resource = config.mcpUrl.href`) and `200` consent page.
- `POST /oauth/consent` (`express.urlencoded`): body `pending_id`, `nonce`, `action` (`approve`|`deny`), `secret`. Missing/expired pending or nonce mismatch ⇒ `400` error page and pending deleted. `deny` ⇒ delete pending, redirect `error=access_denied`. `approve` ⇒ `ownerAuth.verify(secret)`: locked ⇒ re-render with `lockedForS` (status 429); invalid ⇒ re-render with `error` (status 401); ok ⇒ `code = randomToken(32)`, `store.putCode(sha256hex(code), { pendingId, expiresAt: now + CODE_TTL_MS })`, redirect `302 redirect_uri?code=…&state=…&iss=…`. The pending row stays until the token exchange (Task 9 deletes it).
- `iss` is always `config.publicUrl.href`.

- [ ] **Step 1: Failing tests** — `tests/auth/oauth-authorize.test.ts`. Set up like Task 6 but pass a fake CIMD: `createTestAuth(config, root, { cimd: { resolveClient: async (id) => id === CLIENT ? { clientId: CLIENT, clientName: 'Claude Code', redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'], fetchedAt: 0, expiresAt: 9e15 } : Promise.reject(new OAuthError(OAuthErrorCode.InvalidClient, 'nope')) } })` with `CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata'`. Use `fetch(..., { redirect: 'manual' })`.

```ts
const q = (over: Record<string, string> = {}) => new URLSearchParams({
  response_type: 'code', client_id: CLIENT, redirect_uri: 'http://localhost:3118/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  resource: 'https://brainstem.example.com/mcp', scope: 'vault', state: 'xyz', ...over,
}).toString();
const authorize = (over?: Record<string, string>) => fetch(`${base}/oauth/authorize?${q(over)}`, { redirect: 'manual' });
const formOf = (html: string) => ({ pending_id: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '', nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? '' });
const consent = (body: Record<string, string>) => fetch(`${base}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

describe('GET /oauth/authorize', () => {
  it('renders the consent page with client name, redirect host, loopback warning and a nonce', async () => {
    const res = await authorize();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Claude Code');
    expect(html).toContain('localhost');
    expect(html).toMatch(/loopback|local process/i);
    expect(formOf(html).nonce).toHaveLength(22);
    expect(html).toContain('type="password"');
  });
  it('shows an error page (no redirect) for an unknown client or unregistered redirect', async () => {
    expect((await authorize({ client_id: 'https://evil.example/c' })).status).toBe(400);
    expect((await authorize({ redirect_uri: 'https://evil.example/cb' })).status).toBe(400);
  });
  it('redirects protocol errors back with state and iss', async () => {
    const res = await authorize({ code_challenge_method: 'plain' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin + loc.pathname).toBe('http://localhost:3118/callback');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe('https://brainstem.example.com/');
    expect(new URL((await authorize({ resource: 'https://other/mcp' })).headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
    expect(new URL((await authorize({ scope: 'vault admin' })).headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_scope');
  });
  it('ignores the loopback port but not the path', async () => {
    expect((await authorize({ redirect_uri: 'http://127.0.0.1:60000/callback' })).status).toBe(200);
    expect((await authorize({ redirect_uri: 'http://localhost:60000/other' })).status).toBe(400);
  });
});

describe('POST /oauth/consent', () => {
  it('approve with the right secret redirects with a code, state and iss', async () => {
    const form = formOf(await (await authorize()).text());
    const res = await consent({ ...form, action: 'approve', secret: TEST_OWNER_SECRET });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe('https://brainstem.example.com/');
  });
  it('deny redirects with access_denied', async () => {
    const form = formOf(await (await authorize()).text());
    const loc = new URL((await consent({ ...form, action: 'deny' })).headers.get('location') ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
  });
  it('rejects a bad nonce or replay with 400 and burns the pending row', async () => {
    const form = formOf(await (await authorize()).text());
    expect((await consent({ ...form, nonce: 'wrong', action: 'approve', secret: TEST_OWNER_SECRET })).status).toBe(400);
    expect((await consent({ ...form, action: 'approve', secret: TEST_OWNER_SECRET })).status).toBe(400); // burned
  });
  it('re-renders on a wrong secret and locks after repeated failures', async () => {
    const form = formOf(await (await authorize()).text());
    for (let i = 0; i < 4; i++) expect((await consent({ ...form, action: 'approve', secret: 'nope' })).status).toBe(401);
    const locked = await consent({ ...form, action: 'approve', secret: 'nope' });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toMatch(/locked/i);
  });
});
```

(The lockout test must run last or use a fresh `createTestAuth` — order the tests so, or build a dedicated app for it.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`src/auth/as/consent.ts` — plain template strings with an `esc()` HTML-escaper:

```ts
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string); }

const CSS = 'body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}.warn{background:#fff3cd;padding:.75rem;border-radius:.5rem}.err{color:#b00020}button{font:inherit;padding:.5rem 1rem}';

export function renderConsentPage(v: ConsentView): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>brainstem-mcp — connect ${esc(v.clientName)}</title><style>${CSS}</style></head><body>
<h1>Connect <strong>${esc(v.clientName)}</strong> to your vault?</h1>
<p>This client will be able to <strong>read and write every note</strong> in your vault.</p>
<p>After you approve, the browser returns to <code>${esc(v.redirectHost)}</code>.</p>
${v.loopbackOnly ? '<p class="warn">This client only registers a <strong>loopback</strong> address (localhost). Any local process could be listening there — approve only if you just started this connection yourself.</p>' : ''}
${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
${v.lockedForS ? `<p class="err">Too many wrong attempts. Locked for ${Math.ceil(v.lockedForS / 60)} more minutes.</p>` : ''}
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending_id" value="${esc(v.pendingId)}"><input type="hidden" name="nonce" value="${esc(v.nonce)}">
<label>Owner secret<br><input type="password" name="secret" autocomplete="current-password" required ${v.lockedForS ? 'disabled' : ''}></label>
<p><button name="action" value="approve" ${v.lockedForS ? 'disabled' : ''}>Approve</button> <button name="action" value="deny" formnovalidate>Deny</button></p>
</form></body></html>`;
}

export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>brainstem-mcp — ${esc(title)}</title><style>${CSS}</style></head><body><h1>${esc(title)}</h1><p class="err">${esc(detail)}</p><p>Close this tab and start the connection again from Claude.</p></body></html>`;
}
```

`src/auth/as/authorize.ts` — Router with `express.urlencoded({ extended: false, limit: '8kb' })` on the POST; helper `redirectError(res, redirectUri, error, description, state, iss)` that builds the URL with `URLSearchParams`; `matchesRedirectUri`:

```ts
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function matchesRedirectUri(candidate: string, registered: string[]): boolean {
  let c: URL; try { c = new URL(candidate); } catch { return false; }
  return registered.some((r) => {
    let u: URL; try { u = new URL(r); } catch { return false; }
    if (u.protocol !== c.protocol || u.pathname !== c.pathname || u.search !== c.search) return false;
    if (u.hostname !== c.hostname) return false;
    return LOOPBACK.has(c.hostname) && u.protocol === 'http:' ? true : u.port === c.port;
  });
}
```

Security headers via a small middleware `noStoreHtml(res)` applied to both routes. Query values are read with `typeof x === 'string' ? x : ''` (Express 5 `req.query` may hold arrays). `loopbackOnly = client.redirectUris.every((r) => LOOPBACK.has(new URL(r).hostname))`. Register in `mountAuth`: `app.use(createAuthorizeRouter(config, logger, auth));`.

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): /oauth/authorize with consent + owner-secret page (PKCE, resource, iss, CSRF nonce)"`

---

### Task 9: `/oauth/token` (code exchange, refresh rotation) and `/oauth/revoke`

**Files:**
- Create: `src/auth/as/token.ts`
- Modify: `src/auth/mount.ts`
- Test: `tests/auth/oauth-token.test.ts`

**Interfaces:**
```ts
export function createTokenRouter(config: Config, logger: Logger, auth: AuthDeps): Router;
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean; // base64url(sha256(verifier)) === challenge
export const ROTATION_GRACE_MS = 60_000;
```
Behaviour (spec §4.2 token/revoke):
- `POST /oauth/token`: content type must be `application/x-www-form-urlencoded` (else `415` JSON `{error:'invalid_request'}`); responses `Cache-Control: no-store`, `Pragma: no-cache`.
- `grant_type=authorization_code`: `code`, `client_id`, `redirect_uri`, `code_verifier` required; `store.consumeCode(sha256hex(code), now)` → `pending = store.getPending(rec.pendingId)`; mismatch of `client_id`/`redirect_uri`, missing pending, bad PKCE, or `resource` (if sent) ≠ `pending.resource` ⇒ `400 {error:'invalid_grant'}` and delete pending. Success ⇒ `familyId = randomToken(16)`; `access = randomToken()`, `refresh = randomToken()`; store both (`kind`, `familyId`, `clientId`, `clientName`, `resource`, `scope`, `expiresAt = now + ttl*1000`); delete pending; `200 { access_token, token_type: 'Bearer', expires_in: accessTokenTtlS, refresh_token, scope }`.
- `grant_type=refresh_token`: `refresh_token`, `client_id` required. Lookup; not found, `kind !== 'refresh'`, revoked, expired, or `clientId` mismatch ⇒ `400 invalid_grant` (and if the record exists and belongs to a family: `revokeFamily`). If `rotatedAt` set and `now - rotatedAt > ROTATION_GRACE_MS` ⇒ reuse detected ⇒ `revokeFamily`, `invalid_grant`. Otherwise issue a new pair in the same family, set `rotatedAt = now` on the old refresh (first rotation only — if already within grace, do not reset it), old access tokens of the family are left to expire. Response as above.
- Any other `grant_type` ⇒ `400 unsupported_grant_type`.
- `POST /oauth/revoke`: form field `token`; if found ⇒ `revokeFamily(rec.familyId, now)`; always `200` empty body.

- [ ] **Step 1: Failing tests** — `tests/auth/oauth-token.test.ts`. Build the app as in Task 8 with the fake CIMD and a controllable clock: `let now = 1_700_000_000_000; createTestAuth(config, root, { cimd, now: () => now })`. Helpers:

```ts
type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
const REDIRECT = 'http://localhost:3118/callback';
const post = (body: Record<string, string>) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
async function getCode(): Promise<string> {
  const html = await (await fetch(`${base}/oauth/authorize?${q()}`)).text();
  const form = formOf(html); // same helper as Task 8
  const res = await consent({ ...form, action: 'approve', secret: TEST_OWNER_SECRET });
  return new URL(res.headers.get('location') ?? '').searchParams.get('code') as string;
}
const exchange = async (code: string): Promise<Tokens> =>
  (await (await post({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER })).json()) as Tokens;
```

PKCE pair: `verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'`, `challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'` (RFC 7636 appendix B). `post(body)` sends form-urlencoded to `/oauth/token`.

```ts
describe('POST /oauth/token', () => {
  it('rejects JSON bodies with 415', async () => {
    const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(415);
  });
  it('exchanges a code for access + refresh tokens bound to the resource', async () => {
    const code = await getCode();
    const res = await post({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: 'https://brainstem.example.com/mcp' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'vault' });
    const rec = await store.getToken(sha256hex(body.access_token as string));
    expect(rec).toMatchObject({ kind: 'access', resource: 'https://brainstem.example.com/mcp', clientName: 'Claude Code' });
    expect((await store.getToken(sha256hex(body.refresh_token as string)))?.kind).toBe('refresh');
    // the code is single-use
    expect((await post({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER })).status).toBe(400);
  });
  it('rejects a wrong verifier, redirect_uri, client or resource with invalid_grant', async () => {
    for (const over of [{ code_verifier: 'x'.repeat(43) }, { redirect_uri: 'http://localhost:1/other' }, { client_id: 'https://claude.ai/oauth/other' }, { resource: 'https://other/mcp' }]) {
      const code = await getCode();
      const res = await post({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
  });
  it('expires codes after 60 s', async () => {
    const code = await getCode();
    now += 61_000;
    expect((await post({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER })).status).toBe(400);
  });
  it('rotates refresh tokens with a grace window and revokes the family on reuse', async () => {
    const first = await exchange(await getCode());
    const second = (await (await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT })).json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // within grace: old refresh still works (network retry)
    now += 30_000;
    expect((await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT })).status).toBe(200);
    // outside grace: reuse ⇒ whole family revoked
    now += 61_000;
    const reuse = await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await post({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: CLIENT })).status).toBe(400);
    expect((await store.getToken(sha256hex(second.access_token)))?.revokedAt).toBeTypeOf('number');
  });
  it('expired or unknown refresh tokens answer invalid_grant', async () => {
    const t = await exchange(await getCode());
    now += 91 * 24 * 3600 * 1000;
    expect(((await (await post({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT })).json()) as { error: string }).error).toBe('invalid_grant');
    expect((await post({ grant_type: 'refresh_token', refresh_token: 'nope', client_id: CLIENT })).status).toBe(400);
    expect((await post({ grant_type: 'client_credentials' })).status).toBe(400);
  });
});

describe('POST /oauth/revoke', () => {
  it('revokes the whole family and always answers 200', async () => {
    const t = await exchange(await getCode());
    expect((await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.access_token }) })).status).toBe(200);
    expect((await store.getToken(sha256hex(t.refresh_token)))?.revokedAt).toBeTypeOf('number');
    expect((await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'unknown' }) })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/auth/as/token.ts` following the behaviour list; PKCE:

```ts
import { createHash } from 'node:crypto';
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  const digest = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return digest.length === codeChallenge.length && timingSafeEqual(Buffer.from(digest), Buffer.from(codeChallenge));
}
```

Issue helper shared by both grants:

```ts
async function issuePair(store: TokenStore, now: number, cfg: Config, base: Pick<TokenRecord, 'familyId' | 'clientId' | 'clientName' | 'resource' | 'scope'>) {
  const access = randomToken(); const refresh = randomToken();
  await store.putToken(sha256hex(access), { ...base, kind: 'access', expiresAt: now + cfg.accessTokenTtlS * 1000 });
  await store.putToken(sha256hex(refresh), { ...base, kind: 'refresh', expiresAt: now + cfg.refreshTokenTtlS * 1000 });
  return { access_token: access, token_type: 'Bearer' as const, expires_in: cfg.accessTokenTtlS, refresh_token: refresh, scope: base.scope };
}
```

Content-type gate: `if (!req.is('application/x-www-form-urlencoded')) return res.status(415).json({ error: 'invalid_request', error_description: 'use application/x-www-form-urlencoded' })`. Mount in `mountAuth`: `app.use(createTokenRouter(config, logger, auth));`. Log one info line per issued/rotated token with `clientName` and `familyId` (never the token).

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): /oauth/token with PKCE, refresh rotation + family revocation; /oauth/revoke"`

---

### Task 10: End-to-end OAuth with the SDK client, and the owner runtime resolver

**Files:**
- Create: `src/auth/context.ts`, `tests/auth/e2e.test.ts`
- Modify: `src/main.ts` (use `createOwnerResolver(runtime)`)
- Test: `tests/auth/context.test.ts`

**Interfaces:**
```ts
export function createOwnerResolver(runtime: VaultRuntime): RuntimeResolver; // throws Error('unauthenticated request reached the tool layer') unless ctx.authInfo?.extra?.userId === 'owner'
```

- [ ] **Step 1: Failing tests**

`tests/auth/context.test.ts`:

```ts
it('returns the runtime for the owner and refuses anything else', async () => {
  const runtime = {} as VaultRuntime;
  const resolve = createOwnerResolver(runtime);
  await expect(resolve({ era: 'modern', authInfo: { token: 't', clientId: 'c', scopes: ['vault'], extra: { userId: 'owner' } } })).resolves.toBe(runtime);
  await expect(resolve({ era: 'modern' })).rejects.toThrow(/unauthenticated/);
  await expect(resolve({ era: 'modern', authInfo: { token: 't', clientId: 'c', scopes: [], extra: { userId: 'bob' } } })).rejects.toThrow();
});
```

`tests/auth/e2e.test.ts` — drive the SDK's `OAuthClientProvider` against the app (fake CIMD as in Task 8; the provider's `clientMetadataUrl` is `CLIENT`, `redirectUrl` `http://localhost:3118/callback`):

```ts
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';

class TestProvider implements OAuthClientProvider {
  clientMetadataUrl = CLIENT;
  authorizationUrl: URL | undefined;
  private t: StoredOAuthTokens | undefined; private verifier = '';
  get redirectUrl() { return 'http://localhost:3118/callback'; }
  get clientMetadata() { return { client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return { client_id: CLIENT }; }
  tokens() { return this.t; }
  saveTokens(t: StoredOAuthTokens) { this.t = t; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

it('completes discovery → CIMD → consent → code → token → tool call, then refreshes', async () => {
  const provider = new TestProvider();
  const url = new URL(`${base}/mcp`);
  let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client({ name: 'e2e', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const authz = provider.authorizationUrl as URL;
  expect(authz.searchParams.get('client_id')).toBe(CLIENT);
  expect(authz.searchParams.get('resource')).toBe('https://brainstem.example.com/mcp');
  expect(authz.searchParams.get('code_challenge_method')).toBe('S256');
  // the browser step: our server is reached at `base`, so rewrite the origin
  const local = new URL(authz.pathname + authz.search, base);
  const html = await (await fetch(local)).text();
  const form = { pending_id: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '', nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? '' };
  const cb = await fetch(`${base}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, action: 'approve', secret: TEST_OWNER_SECRET }) });
  const loc = new URL(cb.headers.get('location') ?? '');
  expect(loc.searchParams.get('iss')).toBe('https://brainstem.example.com/');
  await transport.finishAuth(loc.searchParams.get('code') as string);
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await client.connect(transport);
  const result = await client.callTool({ name: 'vault_list', arguments: {} });
  expect(result.isError).toBeFalsy();
  const before = provider.tokens()?.refresh_token;
  // force a refresh by expiring the access token server-side
  await store.updateToken(sha256hex(provider.tokens()?.access_token ?? ''), { expiresAt: Date.now() - 1 });
  const again = await client.callTool({ name: 'brainstem_ping', arguments: {} });
  expect(again.isError).toBeFalsy();
  expect(provider.tokens()?.refresh_token).not.toBe(before);
  await client.close();
});
```

The SDK validates the AS `issuer` against the discovered metadata URL; since the app is reached at `http://127.0.0.1:<port>` but advertises `https://brainstem.example.com`, pass `skipIssuerMetadataValidation: true` on the transport options in this test only, and note it in a comment. If the SDK rejects `resource` mismatch (server URL vs PRM), implement `validateResourceURL` on the provider to return `new URL('https://brainstem.example.com/mcp')`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/auth/context.ts`:

```ts
import type { RuntimeResolver, VaultRuntime } from '../vault/runtime.ts';

export function createOwnerResolver(runtime: VaultRuntime): RuntimeResolver {
  return async (ctx) => {
    if (ctx.authInfo?.extra?.userId !== 'owner') throw new Error('unauthenticated request reached the tool layer');
    return runtime;
  };
}
```

Use it in `src/main.ts` instead of `async () => runtime`. If the e2e test fails on the SDK side (e.g. the client refuses the http→https issuer mismatch even with the flag), adapt the harness to advertise `PUBLIC_URL=http://127.0.0.1:<port>` with `ALLOW_INSECURE_PUBLIC_URL=true` (config built after the port is known) — that mirrors `TUNNEL_MODE=none` exactly and needs no skip flags. Prefer that variant.

- [ ] **Step 4: Run full suite, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): owner runtime resolver; end-to-end OAuth test with the SDK client"`

---

### Task 11: Public-URL file, self-restart on change, connection note, instance file, `/health` fields

**Files:**
- Create: `src/tunnel/public-url-file.ts`, `src/vault/connection-note.ts`
- Modify: `src/main.ts`, `src/app.ts` (`/health`)
- Test: `tests/tunnel/public-url-file.test.ts`, `tests/vault/connection-note.test.ts`, `tests/app.test.ts` (health fields)

**Interfaces:**
```ts
// public-url-file.ts
export function parsePublicUrlFile(text: string): string | null;           // trimmed first line if it parses as an http(s) URL, else null
export function waitForPublicUrl(file: string, opts: { timeoutMs: number; intervalMs: number }): Promise<string>;  // rejects Error('tunnel did not come up…') on timeout
export function watchPublicUrl(file: string, current: string, onChange: (next: string) => void, intervalMs: number): () => void; // poll; fires once when content differs
// connection-note.ts
export interface ConnectionInfo { publicUrl: string; mcpUrl: string; tunnelMode: string; updatedAt: string }
export function renderConnectionNote(info: ConnectionInfo): string;
export async function writeConnectionNote(stateDir: string, info: ConnectionInfo): Promise<void>;   // <stateDir>/connection.md, atomic
export async function writeInstanceFile(stateDir: string, info: { hostname: string; startedAt: string; heartbeatAt: string }): Promise<{ otherHost: string | null }>; // returns other live host (heartbeat < 5 min, different hostname) before overwriting
```
`/health` adds `publicUrl`, `mcpUrl`, `tunnelMode`, `vault: { notes: runtime.index.size() }` — `createApp` needs the count: pass `health: () => ({ notes })` via a fifth optional argument `extras?: { notes?: () => number }`; simpler: `createApp(config, logger, resolveRuntime, auth, { notes: () => runtime.index.size() })` with a default `() => 0`.

`main.ts` flow:
1. `env = process.env`; if `env.PUBLIC_URL_FILE` set: `publicUrl = await waitForPublicUrl(file, { timeoutMs: 120_000, intervalMs: 1_000 })` (log every 10 s while waiting); `env = { ...env, PUBLIC_URL: publicUrl, ALLOW_INSECURE_PUBLIC_URL: publicUrl.startsWith('https:') ? 'false' : 'true' }`. Timeout ⇒ print `tunnel did not come up — run \`npm run logs tunnel\`` and exit 1.
2. `config = loadConfig(env)`; store at `stateDir = config.stateDir ?? path.join(vaultPath, '_brainstem')`.
3. runtime, auth, server as before; `await auth.store.sweepExpired(Date.now())` at boot and `setInterval(…, 600_000).unref()`. Also at boot: `readdir(stateDir)` and `logger.warn` for every file matching `/^state.*(conflict|conflicted)/i` (sync-conflict copies are ignored, never merged).
4. `writeConnectionNote(stateDir, …)`; `writeInstanceFile` → warn if `otherHost`; heartbeat every 60 s.
5. If `PUBLIC_URL_FILE`: `watchPublicUrl(file, publicUrl, () => { logger.warn('tunnel URL changed — restarting'); shutdown('tunnel-url-changed'); }, 5_000)`; shutdown exits 0 (Docker restarts).

- [ ] **Step 1: Failing tests**

```ts
// tests/tunnel/public-url-file.test.ts
it('parses the first line as a URL and ignores junk', () => {
  expect(parsePublicUrlFile('https://a-b.trycloudflare.com\n')).toBe('https://a-b.trycloudflare.com');
  expect(parsePublicUrlFile('')).toBeNull(); expect(parsePublicUrlFile('nope')).toBeNull();
});
it('waitForPublicUrl resolves once the file appears and times out otherwise', async () => {
  const file = path.join(dir, 'public-url');
  setTimeout(() => fs.writeFile(file, 'https://x.trycloudflare.com\n'), 150);
  await expect(waitForPublicUrl(file, { timeoutMs: 2_000, intervalMs: 50 })).resolves.toBe('https://x.trycloudflare.com');
  await expect(waitForPublicUrl(path.join(dir, 'missing'), { timeoutMs: 200, intervalMs: 50 })).rejects.toThrow(/did not come up/);
});
it('watchPublicUrl fires once when the content changes', async () => {
  const file = path.join(dir, 'public-url'); await fs.writeFile(file, 'https://one.trycloudflare.com');
  const seen: string[] = []; const stop = watchPublicUrl(file, 'https://one.trycloudflare.com', (n) => seen.push(n), 50);
  await new Promise((r) => setTimeout(r, 120)); await fs.writeFile(file, 'https://two.trycloudflare.com');
  await new Promise((r) => setTimeout(r, 200)); stop();
  expect(seen).toEqual(['https://two.trycloudflare.com']);
});
// tests/vault/connection-note.test.ts
it('renders the connector URL, the claude mcp add command and reconnect steps', () => {
  const md = renderConnectionNote({ publicUrl: 'https://x.trycloudflare.com', mcpUrl: 'https://x.trycloudflare.com/mcp', tunnelMode: 'quick', updatedAt: '2026-08-28T10:00:00Z' });
  expect(md).toContain('https://x.trycloudflare.com/mcp');
  expect(md).toContain('claude mcp add --transport http brainstem https://x.trycloudflare.com/mcp');
  expect(md).toMatch(/remove.*add/i);
  expect(md.startsWith('---\n')).toBe(true); // frontmatter with updatedAt + mode
});
it('writeInstanceFile reports another live host', async () => {
  await writeInstanceFile(dir, { hostname: 'laptop', startedAt: 'a', heartbeatAt: new Date().toISOString() });
  const r = await writeInstanceFile(dir, { hostname: 'desktop', startedAt: 'b', heartbeatAt: new Date().toISOString() });
  expect(r.otherHost).toBe('laptop');
  const stale = await writeInstanceFile(dir, { hostname: 'laptop', startedAt: 'c', heartbeatAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  expect(stale.otherHost).toBe('desktop'); // desktop's heartbeat is < 5 min old
});
```

Add to `tests/app.test.ts` health test: `expect(body).toMatchObject({ publicUrl: 'https://brainstem.example.com/', mcpUrl: 'https://brainstem.example.com/mcp', tunnelMode: 'none', vault: { notes: 0 } })`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** the two modules (poll with `setInterval(...).unref()`; atomic writes via `tmp + rename` like the store), extend `/health`, rewrite `main.ts` per the flow above (keep `shutdown` idempotent; `tunnel-url-changed` exits 0). The connection note body:

```markdown
---
type: brainstem-connection
mode: quick
updatedAt: 2026-08-28T10:00:00Z
---
# brainstem-mcp connection

**Connector URL:** `https://x.trycloudflare.com/mcp`

## claude.ai / Claude mobile
1. Settings → Connectors → *Add custom connector* → paste the URL above → Add.
2. Click *Connect*, type your owner secret (in `.env` on the machine that runs brainstem) → Approve.
3. If this URL changed (quick tunnel restart): *remove* the old connector first, then *add* the new URL.

## Claude Code
`claude mcp add --transport http brainstem https://x.trycloudflare.com/mcp` then `/mcp` → Authenticate.
(After a URL change: `claude mcp remove brainstem` and add again.)
```

- [ ] **Step 4: Run tests, lint, typecheck** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(tunnel): PUBLIC_URL_FILE wait/watch with self-restart; connection note + instance file; richer /health"`

---

### Task 12: Tunnel supervisor and image

**Files:**
- Create: `src/tunnel/supervisor.ts`, `src/tunnel/supervisor-main.ts`, `tunnel/Dockerfile`
- Test: `tests/tunnel/supervisor.test.ts`

**Interfaces:**
```ts
export function extractTunnelUrl(line: string): string | null;   // /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
export interface SupervisorOptions {
  mode: 'quick' | 'cloudflare'; token?: string; target: string; urlFile?: string;
  spawn: (cmd: string, args: string[]) => ChildLike; log: (msg: string) => void; sleep?: (ms: number) => Promise<void>;
}
export interface ChildLike { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; on(ev: 'exit', cb: (code: number | null) => void): unknown; kill(): void }
export function cloudflaredArgs(o: Pick<SupervisorOptions, 'mode' | 'token' | 'target'>): string[];
// quick: ['tunnel', '--no-autoupdate', '--url', target]  cloudflare: ['tunnel', '--no-autoupdate', 'run', '--token', token]
export async function runSupervisor(o: SupervisorOptions, signal: AbortSignal): Promise<void>; // restart loop with backoff 1s→30s; in quick mode writes urlFile atomically when a URL line appears
```
`supervisor-main.ts`: reads `TUNNEL_MODE`, `TUNNEL_TOKEN`, `TUNNEL_TARGET` (default `http://app:3000`), `PUBLIC_URL_FILE`; `mode=cloudflare` without token ⇒ exit 1 with message; wires `child_process.spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] })`; SIGTERM ⇒ abort + kill.

`tunnel/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ARG CLOUDFLARED_VERSION=2026.8.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared && cloudflared --version
WORKDIR /app
COPY --from=build /app/dist/tunnel ./dist/tunnel
USER node
CMD ["node", "dist/tunnel/supervisor-main.js"]
```

- [ ] **Step 1: Failing tests** (fake child via `PassThrough` streams + `EventEmitter`):

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; }
  exit(code: number) { this.stdout.end(); this.stderr.end(); this.emit('exit', code); }
}
const tick = () => new Promise((r) => setTimeout(r, 20));

it('extracts the quick tunnel URL from cloudflared output', () => {
  expect(extractTunnelUrl('2026-08-28T10:00:00Z INF |  https://abc-def-ghi.trycloudflare.com  |')).toBe('https://abc-def-ghi.trycloudflare.com');
  expect(extractTunnelUrl('INF Connection registered')).toBeNull();
});
it('builds the right cloudflared arguments per mode', () => {
  expect(cloudflaredArgs({ mode: 'quick', target: 'http://app:3000' })).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://app:3000']);
  expect(cloudflaredArgs({ mode: 'cloudflare', token: 'T', target: 'http://app:3000' })).toEqual(['tunnel', '--no-autoupdate', 'run', '--token', 'T']);
});
it('writes the URL file in quick mode and restarts cloudflared with backoff when it exits', async () => {
  const children: FakeChild[] = [];
  const sleeps: number[] = [];
  const ac = new AbortController();
  const run = runSupervisor({ mode: 'quick', target: 'http://app:3000', urlFile: file, log: () => {}, sleep: async (ms) => { sleeps.push(ms); }, spawn: () => { const c = new FakeChild(); children.push(c); return c; } }, ac.signal);
  await tick(); children[0]!.stderr.write('INF |  https://one.trycloudflare.com  |\n'); await tick();
  expect((await fs.readFile(file, 'utf8')).trim()).toBe('https://one.trycloudflare.com');
  children[0]!.exit(1); await tick(); await tick();
  expect(children).toHaveLength(2); expect(sleeps[0]).toBe(1_000);
  children[1]!.stderr.write('INF |  https://two.trycloudflare.com  |\n'); await tick();
  expect((await fs.readFile(file, 'utf8')).trim()).toBe('https://two.trycloudflare.com');
  ac.abort(); children[1]!.exit(0); await run;
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interfaces (backoff: `delay = Math.min(30_000, 1_000 * 2 ** attempt)`, reset to 0 after a child lived > 60 s; read `stdout`+`stderr` line-wise with `readline.createInterface`; write URL file via `tmp + rename`, only when the URL differs from the last written).
- [ ] **Step 4: Run tests, lint, typecheck; `docker build -f tunnel/Dockerfile -t brainstem-tunnel .`** — PASS / image builds and prints `cloudflared version 2026.8.2`.
- [ ] **Step 5: Commit** — `git commit -m "feat(tunnel): cloudflared supervisor (quick + named modes) and tunnel image"`

---

### Task 13: Compose v2, Dockerfile, env template, smoke script

**Files:**
- Modify: `compose.yaml`, `Dockerfile` (no change needed except comment), `.env.example`, `.dockerignore`, `.gitignore`, `scripts/docker-smoke.sh`, `package.json` scripts (`docker:*` kept for CI)

- [ ] **Step 1: Write `compose.yaml`**

```yaml
# Configuration comes from .env (created by `npm run setup`). Compose interpolates ${VAR} from it.
services:
  app:
    build: .
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
    ports:
      - "${PORT:-3000}:3000"
    environment:
      PUBLIC_URL: ${PUBLIC_URL:-}
      ALLOW_INSECURE_PUBLIC_URL: ${ALLOW_INSECURE_PUBLIC_URL:-false}
      PUBLIC_URL_FILE: ${PUBLIC_URL_FILE:-}
      TUNNEL_MODE: ${TUNNEL_MODE:-none}
      OWNER_SECRET: ${OWNER_SECRET:?run npm run setup}
      PORT: "3000"
      LOG_LEVEL: ${LOG_LEVEL:-info}
      MCP_LEGACY_MODE: ${MCP_LEGACY_MODE:-stateless}
      STORAGE_BACKEND: localfs
      VAULT_PATH: /vault
      VAULT_TIMEZONE: ${VAULT_TIMEZONE:-UTC}
      VAULT_WATCH_POLL_MS: ${VAULT_WATCH_POLL_MS:-}
      DAILY_NOTES_FOLDER: ${DAILY_NOTES_FOLDER:-}
      DAILY_NOTES_FORMAT: ${DAILY_NOTES_FORMAT:-yyyy-MM-dd}
      CIMD_ALLOWED_HOSTS: ${CIMD_ALLOWED_HOSTS:-claude.ai,claude.com}
      ACCESS_TOKEN_TTL_S: ${ACCESS_TOKEN_TTL_S:-3600}
      REFRESH_TOKEN_TTL_S: ${REFRESH_TOKEN_TTL_S:-7776000}
    volumes:
      - "${VAULT_PATH:?run npm run setup}:/vault"
    depends_on:
      tunnel:
        condition: service_started
        required: false
    restart: unless-stopped

  tunnel:
    build:
      context: .
      dockerfile: tunnel/Dockerfile
    profiles: ["tunnel"]
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
    environment:
      TUNNEL_MODE: ${TUNNEL_MODE:-quick}
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:-}
      TUNNEL_TARGET: http://app:3000
      PUBLIC_URL_FILE: /vault/_brainstem/public-url
    volumes:
      - "${VAULT_PATH:?run npm run setup}:/vault"
    restart: unless-stopped
```

In quick mode `.env` has `PUBLIC_URL_FILE=/vault/_brainstem/public-url` and no `PUBLIC_URL`; in cloudflare mode `PUBLIC_URL=https://…` and no file; in none mode `PUBLIC_URL=http://localhost:3000`, `ALLOW_INSECURE_PUBLIC_URL=true`. `VAULT_PATH` and `HOST_*` are host-side only (interpolation), never passed into the container as-is.

- [ ] **Step 2: `.env.example`**

```dotenv
# brainstem-mcp — created/completed by `npm run setup`. Never commit .env.
# --- required (setup fills these) ---
OWNER_SECRET=
VAULT_PATH=
# --- tunnel: cloudflare (stable URL, needs TUNNEL_TOKEN + PUBLIC_URL) | quick (random URL each start) | none (Claude Code only)
TUNNEL_MODE=quick
TUNNEL_TOKEN=
PUBLIC_URL=
PUBLIC_URL_FILE=/vault/_brainstem/public-url
ALLOW_INSECURE_PUBLIC_URL=false
# --- vault ---
VAULT_TIMEZONE=UTC
VAULT_WATCH_POLL_MS=
DAILY_NOTES_FOLDER=
DAILY_NOTES_FORMAT=yyyy-MM-dd
# --- server ---
PORT=3000
LOG_LEVEL=info
MCP_LEGACY_MODE=stateless
CIMD_ALLOWED_HOSTS=claude.ai,claude.com
ACCESS_TOKEN_TTL_S=3600
REFRESH_TOKEN_TTL_S=7776000
# --- host (Linux only; setup fills) ---
HOST_UID=
HOST_GID=
```

- [ ] **Step 3: Smoke script** — `scripts/docker-smoke.sh` now needs a bearer: add step 0 that inserts a token directly into `${VAULT_PATH}/_brainstem/state.json`:

```bash
VAULT="${VAULT_PATH:-./vault-dev}"
TOKEN=$(node -e '
const fs=require("fs"),c=require("crypto"),f=process.argv[1];
const t=c.randomBytes(32).toString("base64url");
const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{version:1,clients:{},pending:{},codes:{},tokens:{}};
d.tokens[c.createHash("sha256").update(t).digest("hex")]={kind:"access",familyId:"smoke",clientId:"https://claude.ai/oauth/smoke",clientName:"smoke",resource:process.argv[2],scope:"vault",expiresAt:Date.now()+3600000};
fs.mkdirSync(require("path").dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(d));console.log(t)' "$VAULT/_brainstem/state.json" "$BASE/mcp")
```

then pass `--header "Authorization: Bearer $TOKEN"` to every Inspector call (`npx @modelcontextprotocol/inspector --cli … --header "Authorization: Bearer …"`), assert step 1 `curl /mcp` without token is `401`, and finally assert `${VAULT_PATH}/_brainstem/connection.md` exists. `npm run docker:smoke` stays for CI (`TUNNEL_MODE=none`, `VAULT_PATH=./vault-dev`, `OWNER_SECRET` generated in the workflow step with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Add `_brainstem/` handling to `.gitignore` for `vault-dev/` (already ignored as a whole). Add `tunnel/` to Docker build context (it is; ensure `.dockerignore` does not exclude it).

- [ ] **Step 4: Verify**: `docker compose config` (with a temporary `.env` from setup values) prints without errors; `TUNNEL_MODE=none npm run docker:up && npm run docker:smoke && npm run docker:down`.
- [ ] **Step 5: Commit** — `git commit -m "build: compose v2 (app + tunnel, no postgres), env template, authenticated docker smoke"`

---

### Task 14: CLI foundation — env file, vault path, compose runner, `setup`

**Files:**
- Create: `src/cli/env-file.ts`, `src/cli/vault-path.ts`, `src/cli/docker.ts`, `src/cli/commands/setup.ts`, `src/cli/brainstem.ts`
- Modify: `package.json` (deps + scripts), `tsconfig.build.json` (nothing — `src/**` already compiled), Biome config (nothing)
- Test: `tests/cli/env-file.test.ts`, `tests/cli/vault-path.test.ts`, `tests/cli/setup.test.ts`

**Interfaces:**
```ts
// env-file.ts
export function parseEnv(text: string): Map<string, string>;                       // KEY=VALUE lines; strips surrounding quotes; ignores comments/blank
export function upsertEnv(text: string, values: Record<string, string>, opts?: { onlyIfEmpty?: boolean }): { text: string; changed: string[]; kept: string[] };
// keeps comments/order; replaces the value of an existing key (if onlyIfEmpty, only when current value is ''), appends missing keys at the end; always '\n' endings
// vault-path.ts
export interface VaultPathContext { home: string; repoDir: string; platform: NodeJS.Platform; stat(p: string): Promise<{ isDirectory(): boolean } | null>; probeWrite(p: string): Promise<boolean> }
export type VaultPathVerdict = { ok: true; path: string; warnings: string[] } | { ok: false; error: string };
export async function validateVaultPath(input: string, ctx: VaultPathContext): Promise<VaultPathVerdict>;
export function suggestVaultPaths(home: string, readdir: (p: string) => Promise<string[]>): Promise<string[]>; // ~/Obsidian*, ~/Documents/Obsidian*
// docker.ts
export interface ComposeRunner { run(args: string[], opts?: { capture?: boolean }): Promise<{ code: number; stdout: string }>; available(): Promise<boolean> }
export function createComposeRunner(cwd: string): ComposeRunner;  // spawn('docker', ['compose', ...args], { cwd, stdio: capture ? 'pipe' : 'inherit', shell: false })
// commands/setup.ts
export interface SetupIO { prompt(question: string, opts: { default?: string; validate?: (v: string) => Promise<string | true> }): Promise<string>; confirm(q: string, def: boolean): Promise<boolean>; select<T extends string>(q: string, choices: Array<{ value: T; name: string }>): Promise<T>; print(line: string): void }
export interface SetupDeps { cwd: string; io: SetupIO; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number | undefined; gid: number | undefined; readFile(p: string): Promise<string | null>; writeFile(p: string, text: string): Promise<void>; vaultCtx: VaultPathContext; randomSecret(): string; timezone(): string }
export async function runSetup(args: { vault?: string; tunnelToken?: string; publicUrl?: string; force?: boolean; showSecret?: boolean }, deps: SetupDeps): Promise<void>;
```
`randomSecret()` = `randomBytes(32).toString('base64url')`. Setup steps: load `.env` or `.env.example`; compute the values: `OWNER_SECRET` if empty; `VAULT_PATH` (arg or prompt with suggestions, validated); tunnel: if `--tunnel-token` or the user answers *yes* to "Do you have a Cloudflare tunnel token?": `TUNNEL_MODE=cloudflare`, `TUNNEL_TOKEN`, `PUBLIC_URL` (arg or prompt, must be `https://` without path), `PUBLIC_URL_FILE=`; else select between *quick* (`TUNNEL_MODE=quick`, `PUBLIC_URL_FILE=/vault/_brainstem/public-url`, `PUBLIC_URL=`) and *none* (`TUNNEL_MODE=none`, `PUBLIC_URL=http://localhost:3000`, `ALLOW_INSECURE_PUBLIC_URL=true`); `HOST_UID/HOST_GID` on linux; `VAULT_WATCH_POLL_MS=2000` when platform ≠ linux; `VAULT_TIMEZONE` from `Intl.DateTimeFormat().resolvedOptions().timeZone` if empty. Write with `onlyIfEmpty: !force` (tunnel keys are written unconditionally because they form one consistent set — pass them with `onlyIfEmpty: false`). Print changed/kept lists; in quick mode print the "URL changes on each restart" warning; print the secret only with `--show-secret`.

- [ ] **Step 1: Failing tests** (excerpts — write them all):

```ts
// env-file.test.ts
it('upsertEnv keeps comments and order, fills only empty keys, appends missing ones', () => {
  const src = '# header\nA=1\nB=\n# tail\n';
  const r = upsertEnv(src, { A: 'x', B: 'y', C: 'z' }, { onlyIfEmpty: true });
  expect(r.text).toBe('# header\nA=1\nB=y\n# tail\nC=z\n');
  expect(r.changed).toEqual(['B', 'C']); expect(r.kept).toEqual(['A']);
  expect(upsertEnv('A=1\r\n', { A: '2' }).text).toBe('A=2\n');
  expect(parseEnv('A="q v"\nB=\'s\'\n#C=1\n').get('A')).toBe('q v');
});
// vault-path.test.ts
it('rejects relative, missing, root, home, repo and read-only paths; warns without .obsidian', async () => {
  const ctx = { home: '/home/u', repoDir: '/home/u/Code/brainstem-mcp', platform: 'linux' as const,
    stat: async (p: string) => (['/home/u/Vault', '/home/u', '/', '/ro'].includes(p) || p === '/home/u/Vault/.obsidian' ? { isDirectory: () => true } : null),
    probeWrite: async (p: string) => p !== '/ro' };
  expect(await validateVaultPath('Vault', ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
  expect(await validateVaultPath('/nope', ctx)).toMatchObject({ ok: false });
  expect(await validateVaultPath('/', ctx)).toMatchObject({ ok: false }); expect(await validateVaultPath('/home/u', ctx)).toMatchObject({ ok: false });
  expect(await validateVaultPath('/home/u/Code', ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/repository/) });
  expect(await validateVaultPath('/ro', ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/writable/) });
  expect(await validateVaultPath('/home/u/Vault', ctx)).toEqual({ ok: true, path: '/home/u/Vault', warnings: [] });
});
it('accepts Windows drive paths on win32', async () => {
  const ctx = { home: 'C:\\Users\\u', repoDir: 'C:\\Users\\u\\Code\\brainstem-mcp', platform: 'win32' as const, stat: async () => ({ isDirectory: () => true }), probeWrite: async () => true };
  expect((await validateVaultPath('C:\\Users\\u\\Obsidian\\Vault', ctx)).ok).toBe(true);
});
// setup.test.ts — uses an in-memory file map and scripted IO answers
it('fills a fresh .env for quick mode on linux', async () => {
  const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
  const answers = { confirm: [false], select: ['quick'] };
  await runSetup({ vault: '/home/u/Vault' }, deps(files, answers));
  const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
  expect(env.get('OWNER_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
  expect(env.get('TUNNEL_MODE')).toBe('quick'); expect(env.get('PUBLIC_URL_FILE')).toBe('/vault/_brainstem/public-url'); expect(env.get('PUBLIC_URL')).toBe('');
  expect(env.get('HOST_UID')).toBe('1000'); expect(env.get('VAULT_WATCH_POLL_MS')).toBe('');
});
it('is idempotent and switches to cloudflare mode with a token', async () => {
  const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
  await runSetup({ vault: '/home/u/Vault' }, deps(files, { confirm: [false], select: ['quick'] }));
  const first = parseEnv(files.get(path.join(CWD, '.env')) ?? '').get('OWNER_SECRET');
  await runSetup({ vault: '/home/u/Vault', tunnelToken: 'tok', publicUrl: 'https://brain.example.com' }, deps(files, { confirm: [], select: [] }));
  const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
  expect(env.get('OWNER_SECRET')).toBe(first);
  expect(env.get('TUNNEL_MODE')).toBe('cloudflare'); expect(env.get('TUNNEL_TOKEN')).toBe('tok');
  expect(env.get('PUBLIC_URL')).toBe('https://brain.example.com'); expect(env.get('PUBLIC_URL_FILE')).toBe('');
});
it('enables polling on win32 and skips HOST_UID', async () => {
  const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
  await runSetup({ vault: 'C:\\Users\\u\\Vault' }, deps(files, { confirm: [false], select: ['none'] }, 'win32'));
  const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
  expect(env.get('VAULT_WATCH_POLL_MS')).toBe('2000'); expect(env.get('HOST_UID')).toBe('');
  expect(env.get('TUNNEL_MODE')).toBe('none'); expect(env.get('PUBLIC_URL')).toBe('http://localhost:3000');
  expect(env.get('ALLOW_INSECURE_PUBLIC_URL')).toBe('true');
});

// shared helper at the top of setup.test.ts
const CWD = '/proj';
const EXAMPLE = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
function deps(files: Map<string, string>, answers: { confirm: boolean[]; select: string[] }, platform: NodeJS.Platform = 'linux'): SetupDeps {
  return {
    cwd: CWD, env: {}, platform, uid: platform === 'linux' ? 1000 : undefined, gid: platform === 'linux' ? 1000 : undefined,
    io: {
      async prompt(_q, o) { return o.default ?? ''; },
      async confirm() { return answers.confirm.shift() ?? false; },
      async select() { return (answers.select.shift() ?? 'quick') as never; },
      print() {},
    },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, t) => { files.set(p, t); },
    vaultCtx: { home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u', repoDir: CWD, platform, stat: async () => ({ isDirectory: () => true }), probeWrite: async () => true },
    randomSecret: () => 'dGVzdC1vd25lci1zZWNyZXQtMzItYnl0ZXMtbG9uZy0hIQ',
    timezone: () => 'Europe/Chisinau',
  };
}
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `npm i -E commander@15.0.0 @inquirer/prompts@8.7.0`; `package.json` scripts:

```json
"brainstem": "node src/cli/brainstem.ts",
"setup": "node src/cli/brainstem.ts setup",
"up": "node src/cli/brainstem.ts up",
"url": "node src/cli/brainstem.ts url",
"status": "node src/cli/brainstem.ts status",
"down": "node src/cli/brainstem.ts down",
"logs": "node src/cli/brainstem.ts logs",
"revoke-all": "node src/cli/brainstem.ts revoke-all"
```

`brainstem.ts` builds the `Command` tree; the real `SetupIO` wraps `@inquirer/prompts` (`input`, `confirm`, `select`); when `!process.stdin.isTTY` and a value is missing, fail with "pass --vault (non-interactive)". Non-linux: skip `HOST_UID/GID`.

- [ ] **Step 4: Run tests, lint, typecheck; manual: `npm run setup -- --vault "$PWD/vault-dev"` then inspect `.env`** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): TypeScript CLI foundation and setup command (.env, vault path, tunnel mode)"`

---

### Task 15: CLI `up`, `url`, `status`, `down`, `logs`, `revoke-all`, `secret`

**Files:**
- Create: `src/cli/commands/{up,url,status,down,logs,revoke-all,secret}.ts`, `src/cli/health.ts`
- Modify: `src/cli/brainstem.ts`
- Test: `tests/cli/commands.test.ts`

**Interfaces:**
```ts
// health.ts
export interface HealthInfo { publicUrl: string; mcpUrl: string; tunnelMode: string; notes: number }
export async function fetchHealth(url: string, fetchImpl?: typeof fetch): Promise<HealthInfo | null>;     // null on any failure
export async function waitForHealth(url: string, timeoutMs: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Promise<HealthInfo | null>;
// commands/up.ts
export interface UpDeps { compose: ComposeRunner; env: Map<string, string>; print(l: string): void; fetchImpl: typeof fetch; sleep(ms: number): Promise<void>; localPort: number }
export async function runUp(args: { build?: boolean }, deps: UpDeps): Promise<number>;   // exit code
export function upSummary(h: HealthInfo, opts: { secretHint: string }): string[];        // the printed lines
// revoke-all.ts
export async function runRevokeAll(args: { reset?: boolean }, deps: { stateFile: string; print(l: string): void; confirm(q: string): Promise<boolean> }): Promise<number>; // uses FileTokenStore.open + revokeAll; --reset unlinks the file
```
`runUp`: `available()` false ⇒ print "Docker is not running or not installed" ⇒ 1; `compose.run(['--profile','tunnel','up','-d', ...(build ? ['--build'] : [])])` when `TUNNEL_MODE !== 'none'` else without the profile; `waitForHealth('http://localhost:<port>/health', 120_000)`; null ⇒ print last 20 lines of `compose logs --tail 20 tunnel app` ⇒ 1; else print `upSummary`: connector URL, `claude mcp add …`, secret hint (`npm run brainstem -- secret show`), quick-mode warning + pointer to `_brainstem/connection.md`, cloudflare-mode note "URL is stable". `runUrl`: health on localhost; then `GET <publicUrl>/health` through the tunnel; print both; exit 1 on failure. `runStatus`: `.env` summary (vault path exists/writable via `validateVaultPath`, tunnel mode), health, `compose ps --format json` parsed to `name/state`. `down`: `compose --profile tunnel down`. `logs [service]`: `compose logs -f [service]`. `secret show|rotate`: read/rotate `OWNER_SECRET` via `upsertEnv` (rotate asks to also revoke).

- [ ] **Step 1: Failing tests** — with a `FakeCompose` recording calls and a `fetchImpl` stub returning health JSON:

```ts
it('up starts the tunnel profile, waits for health and prints the connector URL', async () => {
  const compose = new FakeCompose();
  const lines: string[] = [];
  const code = await runUp({ build: true }, { compose, env: new Map([['TUNNEL_MODE', 'quick'], ['PORT', '3000']]), print: (l) => lines.push(l), fetchImpl: healthOk('https://x.trycloudflare.com'), sleep: async () => {}, localPort: 3000 });
  expect(code).toBe(0);
  expect(compose.calls[0]).toEqual(['--profile', 'tunnel', 'up', '-d', '--build']);
  expect(lines.join('\n')).toContain('https://x.trycloudflare.com/mcp');
  expect(lines.join('\n')).toContain('claude mcp add --transport http brainstem https://x.trycloudflare.com/mcp');
  expect(lines.join('\n')).toMatch(/changes on every restart/);
});
it('up without a tunnel skips the profile and does not warn about rotation', async () => {
  const compose = new FakeCompose(); const lines: string[] = [];
  const code = await runUp({}, { compose, env: new Map([['TUNNEL_MODE', 'none']]), print: (l) => lines.push(l), fetchImpl: healthOk('http://localhost:3000'), sleep: async () => {}, localPort: 3000 });
  expect(code).toBe(0);
  expect(compose.calls[0]).toEqual(['up', '-d']);
  expect(lines.join('\n')).not.toMatch(/changes on every restart/);
});
it('up reports a health timeout with the last log lines', async () => {
  const compose = new FakeCompose(); const lines: string[] = [];
  const failing: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
  const code = await runUp({}, { compose, env: new Map([['TUNNEL_MODE', 'quick']]), print: (l) => lines.push(l), fetchImpl: failing, sleep: async () => {}, localPort: 3000 });
  expect(code).toBe(1);
  expect(compose.calls).toContainEqual(['logs', '--tail', '20', 'tunnel', 'app']);
  expect(lines.join('\n')).toMatch(/did not become healthy/);
});
it('revoke-all empties tokens and --reset deletes the file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-cli-'));
  const file = path.join(dir, 'state.json');
  const store = await FileTokenStore.open(file);
  await store.putToken('h', { kind: 'access', familyId: 'f', clientId: 'c', clientName: 'n', resource: 'r', scope: 'vault', expiresAt: Date.now() + 1e6 });
  expect(await runRevokeAll({}, { stateFile: file, print() {}, confirm: async () => true })).toBe(0);
  expect((await (await FileTokenStore.open(file)).getToken('h'))?.revokedAt).toBeTypeOf('number');
  expect(await runRevokeAll({ reset: true }, { stateFile: file, print() {}, confirm: async () => true })).toBe(0);
  await expect(fs.access(file)).rejects.toBeDefined();
});

// helpers at the top of commands.test.ts
class FakeCompose implements ComposeRunner {
  calls: string[][] = [];
  async available() { return true; }
  async run(args: string[]) { this.calls.push(args); return { code: 0, stdout: '' }; }
}
const healthOk = (publicUrl: string): typeof fetch => async () =>
  new Response(JSON.stringify({ status: 'ok', publicUrl, mcpUrl: `${publicUrl}/mcp`, tunnelMode: publicUrl.includes('trycloudflare') ? 'quick' : 'none', vault: { notes: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
```

`runUp` prints `app did not become healthy within 120 s` before the log tail.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** commands and wire them in `brainstem.ts` (`program.command('up').option('--no-build')…`).
- [ ] **Step 4: Run tests, lint, typecheck; manual on Linux: `npm run setup` (quick), `npm run up`, `npm run url`, `npm run status`, `npm run down`.** PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): up/url/status/down/logs/revoke-all/secret commands"`

---

### Task 16: Docs, ADR, plan v2.0, acceptance

**Files:**
- Create: `README.md` (replace the scaffold README if any), `docs/adr/0005-single-user-state-in-vault-tunnel-modes.md`
- Modify: `docs/implementation-plan.md` (→ v2.0), `docs/plans/README.md` (status table + Phase 2′ row), `.github/workflows/ci.yml` (env for smoke: `OWNER_SECRET`, `TUNNEL_MODE=none`, `VAULT_PATH`)

- [ ] **Step 1: README.md** — sections: *What it is* (3 lines), *Requirements* (Docker Desktop/Engine, Node 24, git), *Install* (`git clone`, `npm install`, `npm run setup`, `npm run up`), *Connect* (claude.ai steps; Claude Code command; the owner secret), *Stable URL* (Cloudflare Zero Trust: create tunnel → copy token → public hostname → `http://app:3000` → `npm run setup -- --tunnel-token … --public-url https://…`), *Quick tunnel caveat* (URL changes on restart; `_brainstem/connection.md`), *Vault sync notes* (Obsidian Sync: enable "Sync all other types"; one machine at a time), *Commands* table, *Security model* (5 bullets), *Troubleshooting* (401 after restart = URL changed; Docker not running; locked out for 15 min).
- [ ] **Step 2: ADR 0005** — context (personal tool, owner decisions 2026-08-28), decision (single-user AS with owner secret; JSON state in `_brainstem/`; two tunnel modes; TS CLI), consequences (what is deferred and what it would take to add multi-tenant/Google/Drive), alternatives rejected (hosted IdPs, Better Auth, SQLite in a synced folder) with a pointer to `docs/reviews/2026-08-28-auth-consistency-review.md`.
- [ ] **Step 3: `docs/implementation-plan.md` v2.0** — Status line: `v2.0 — re-scoped 2026-08-28 to single-user self-hosted (spec: docs/superpowers/specs/2026-08-28-single-user-local-tunnel-design.md)`. §1 replaced by the spec's §1–2 (single user, Obsidian vault bind-mount, Docker, tunnel modes; non-goals list). §7 replaced by one paragraph pointing to the spec §4 and §7. §9: Phase 2′ (this plan) and Phase 3′ (hardening + README polish, 0.5 d); Phase 3 (Drive) and the old Phase 2 text moved verbatim under §10 *Deferred — multi-user product path* with the note "resume from plan v1.2 (git history) if the goal changes". §11 env table replaced by the `.env.example` keys. §13 risks: drop Heroku items, add "quick tunnel URL rotation" and "Docker Desktop inotify" with their mitigations.
- [ ] **Step 4: `docs/plans/README.md`** — row `2′ — Single-user auth + CLI + tunnel | 2026-08-28-phase-2-single-user-auth-cli.md | in progress | 16 tasks`, and a note that Phase 2/3/4 outlines below are the deferred multi-user path.
- [ ] **Step 5: Acceptance (manual, recorded at the bottom of this plan under "Acceptance log")**: (a) Linux quick mode: `setup` → `up` → Claude Code connects via the tunnel URL and lists tools; claude.ai web + phone connect, write a note, it appears in Obsidian; `docker compose restart tunnel` → app restarted, `connection.md` updated, reconnect works. (b) Cloudflare mode with a real token (if the owner has one by then; otherwise mark "pending token"). (c) Windows: `npm run setup` + `npm run up` on a Windows machine, edit a note in Obsidian, read it through Claude (polling watch). Record results with dates.
- [ ] **Step 6: Commit** — `git commit -m "docs: README, ADR 0005, implementation plan v2.0, Phase 2′ status"`

---

## Acceptance log

### Automated evidence (2026-08-28)

- **Unit/integration suites: 283 tests passing, 38 test files** (`npm test`, 2026-08-28). Covers `owner.test.ts` (constant-time compare, lockout), `file-store.test.ts` (atomic write, reload-on-mtime, sweep, concurrent mutations), `cimd.test.ts` (host allowlist, SSRF guard, cache semantics, `client_id` mismatch), `oauth-authorize.test.ts` / `oauth-token.test.ts` (authorize validation matrix, consent nonce/deny/wrong-secret, code exchange + PKCE, refresh rotation, grace window, family revocation, `invalid_grant`, revoke), `oauth-rs.test.ts` (401 shape, PRM, audience mismatch, expired tokens), `verifier.test.ts`, `context.test.ts` (owner-only runtime resolution).
- **End-to-end OAuth via the official SDK client** (`tests/auth/e2e.test.ts`) — the `@modelcontextprotocol` client with its OAuth provider completes the full authorize → consent → token → refresh flow against `createApp` (a local CIMD document served by the test) and then successfully calls `vault_list`.
- **Docker smoke, including the 401 gate and `connection.md`** (`scripts/docker-smoke.sh`, Task 13) — against the real `compose.yaml` stack: unauthenticated `POST /mcp` returns 401; `tools/list` shows all 20 `vault_*` tools; `vault_write` → `vault_read` → `vault_search` round-trip lands a file on the bind-mounted vault; `_brainstem/connection.md` exists after boot.
- **Quick tunnel came up live** with a real `*.trycloudflare.com` URL answering `/health` through the tunnel (Task 13, `TUNNEL_MODE=quick`, no token) — the supervisor's URL extraction and the app's `PUBLIC_URL_FILE` wait/watch were exercised against the actual `cloudflared` binary, not a mock.
- **Tunnel image built with `cloudflared 2026.8.2`** (Task 12, `tunnel/Dockerfile`, `CLOUDFLARED_VERSION` build arg) — `cloudflared --version` runs as an image-build check.

### Owner-run acceptance (pending)

- [ ] (a) Claude Code connects via the tunnel URL (`claude mcp add --transport http brainstem <url>/mcp`, CIMD + loopback redirect) and lists the vault tools, with the owner secret typed once at the consent page.
- [ ] (b) claude.ai web and the Claude mobile app both connect through the same tunnel URL and write a note that appears in the actual Obsidian vault.
- [ ] (c) `docker compose restart tunnel` in quick mode rotates the URL: the app detects the change, restarts itself, `_brainstem/connection.md` is rewritten with the new URL, and reconnecting the client (per the note's instructions) works.
- [ ] (d) `TUNNEL_MODE=cloudflare` with a real Cloudflare tunnel token: the URL survives `docker compose restart` (both services) unchanged, and previously issued tokens stay valid across the restart.
- [ ] (e) `npm run setup` and `npm run up` on a Windows machine, followed by editing a note directly in Obsidian and reading it back through Claude — confirms `VAULT_WATCH_POLL_MS` polling picks up bind-mount changes that native inotify would miss on Docker Desktop.
