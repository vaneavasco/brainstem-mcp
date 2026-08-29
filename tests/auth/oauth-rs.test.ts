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
let server: Server;
let base: string;
let runtime: VaultRuntime;
let root: string;
let issue: (over?: Record<string, unknown>) => Promise<string>;
// Reused by every test in this file (including "stamps lastUsedAt on use"
// below): a second FileTokenStore pointed at the same state file would write
// to it concurrently and uncoordinated, racing the atomic tmp-file rename
// (see file-store.ts) against this store's own fire-and-forget lastUsedAt
// writes.
let testAuth: Awaited<ReturnType<typeof createTestAuth>>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-rs-'));
  runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  testAuth = await createTestAuth(config, root);
  issue = testAuth.issueAccessToken;
  const { app } = createApp(config, createLogger('fatal'), async () => runtime, testAuth.auth);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await runtime.close();
  // Bearer verification stamps lastUsedAt fire-and-forget (verifier.ts), so a
  // background write to _brainstem/state.json can still be in flight here;
  // retry on ENOTEMPTY instead of racing it.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// A raw request declaring the modern (2026-07-28) protocol version must carry
// the per-request `_meta` envelope (see tests/app.test.ts's "raw modern
// request" test) — orthogonal to bearer auth, but required for the handler
// to accept the request at all once past the auth gate.
const rpc = (headers: Record<string, string>) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
      ...headers,
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

describe('resource server', () => {
  it('answers 401 with the RFC 9728 challenge and scope when there is no token', async () => {
    const res = await rpc({});
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www).toContain('Bearer');
    expect(www).toContain(
      'resource_metadata="https://brainstem.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(www).toContain('scope="vault"');
  });
  it('serves PRM at both well-known paths with resource = mcpUrl', async () => {
    for (const p of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const body = (await (await fetch(`${base}${p}`)).json()) as Record<string, unknown>;
      expect(body.resource).toBe('https://brainstem.example.com/mcp');
      expect(body.authorization_servers).toEqual(['https://brainstem.example.com/']);
      expect(body.scopes_supported).toEqual(['vault']);
    }
  });
  it('serves AS metadata with CIMD + none + S256 + iss and no registration_endpoint', async () => {
    const body = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
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
    const res = {
      setHeader() {},
      status(c: number) {
        statuses.push(c);
        return this;
      },
      json() {
        return this;
      },
    } as unknown as import('express').Response;
    for (let i = 0; i < 61; i++)
      limiter({} as import('express').Request, res, () => statuses.push(200));
    expect(statuses.filter((c) => c === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
    t = 1_000; // one second later the bucket is full again
    limiter({} as import('express').Request, res, () => statuses.push(200));
    expect(statuses.at(-1)).toBe(200);
  });
  it('stamps lastUsedAt on use', async () => {
    // Reuse the file's shared store (see the comment on `testAuth` above)
    // rather than opening a second FileTokenStore against the same file.
    const token = await issue();
    await rpc({ authorization: `Bearer ${token}` });
    const { sha256hex } = await import('../../src/auth/hash.ts');
    const hash = sha256hex(token);
    // The verifier stamps lastUsedAt fire-and-forget (`void store.updateToken(...)`)
    // so the response can beat the disk write; poll briefly instead of assuming
    // it lands synchronously with the request.
    let lastUsedAt: number | undefined;
    for (let i = 0; i < 20 && lastUsedAt === undefined; i++) {
      lastUsedAt = (await testAuth.store.getToken(hash))?.lastUsedAt;
      if (lastUsedAt === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(lastUsedAt).toBeTypeOf('number');
  });
});
