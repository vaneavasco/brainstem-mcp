import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { sha256hex } from '../../src/auth/hash.ts';
import type { FileTokenStore } from '../../src/auth/store/file-store.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';
import { createTestAuth } from '../helpers/auth.ts';
import { baseEnv, TEST_OWNER_SECRET } from '../helpers/env.ts';

const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT = 'http://localhost:3118/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const config = loadConfig(baseEnv());

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

interface AppCtx {
  server: Server;
  base: string;
  root: string;
  runtime: VaultRuntime;
  store: FileTokenStore;
}

async function startApp(nowFn: () => number): Promise<AppCtx> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-token-'));
  const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  const { auth, store } = await createTestAuth(config, root, {
    now: nowFn,
    cimd: {
      resolveClient: async (id: string) =>
        id === CLIENT
          ? {
              clientId: CLIENT,
              clientName: 'Claude Code',
              redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
              fetchedAt: 0,
              expiresAt: 9e15,
            }
          : Promise.reject(new OAuthError(OAuthErrorCode.InvalidClient, 'nope')),
    },
  });
  const { app } = createApp(config, createLogger('fatal'), async () => runtime, auth);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, root, runtime, store };
}

async function stopApp(ctx: AppCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await ctx.runtime.close();
  await fs.rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

let ctx: AppCtx;
let base: string;
let store: FileTokenStore;
let now: number;

beforeEach(async () => {
  now = 1_700_000_000_000;
  ctx = await startApp(() => now);
  base = ctx.base;
  store = ctx.store;
});

afterEach(async () => {
  await stopApp(ctx);
});

const q = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: config.mcpUrl.href,
    scope: 'vault',
    state: 'xyz',
    ...over,
  }).toString();

const formOf = (html: string) => ({
  pending_id: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '',
  nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? '',
});

const consent = (body: Record<string, string>) =>
  fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

async function getCode(): Promise<string> {
  const html = await (await fetch(`${base}/oauth/authorize?${q()}`)).text();
  const form = formOf(html);
  const res = await consent({ ...form, action: 'approve', secret: TEST_OWNER_SECRET });
  return new URL(res.headers.get('location') ?? '').searchParams.get('code') as string;
}

const post = (body: Record<string, string>) =>
  fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

const exchange = async (code: string): Promise<Tokens> =>
  (await (
    await post({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    })
  ).json()) as Tokens;

describe('POST /oauth/token', () => {
  it('rejects JSON bodies with 415', async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('exchanges a code for access + refresh tokens bound to the resource', async () => {
    const code = await getCode();
    const res = await post({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: 'https://brainstem.example.com/mcp',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'vault' });
    const rec = await store.getToken(sha256hex(body.access_token as string));
    expect(rec).toMatchObject({
      kind: 'access',
      resource: 'https://brainstem.example.com/mcp',
      clientName: 'Claude Code',
    });
    expect((await store.getToken(sha256hex(body.refresh_token as string)))?.kind).toBe('refresh');
    // the code is single-use
    expect(
      (
        await post({
          grant_type: 'authorization_code',
          code,
          client_id: CLIENT,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
        })
      ).status,
    ).toBe(400);
  });

  it('rejects a wrong verifier, redirect_uri, client or resource with invalid_grant', async () => {
    const overrides: Record<string, string>[] = [
      { code_verifier: 'x'.repeat(43) },
      { redirect_uri: 'http://localhost:1/other' },
      { client_id: 'https://claude.ai/oauth/other' },
      { resource: 'https://other/mcp' },
    ];
    for (const over of overrides) {
      const code = await getCode();
      const res = await post({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        ...over,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
  });

  it('expires codes after 60 s', async () => {
    const code = await getCode();
    now += 61_000;
    expect(
      (
        await post({
          grant_type: 'authorization_code',
          code,
          client_id: CLIENT,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
        })
      ).status,
    ).toBe(400);
  });

  it('rotates refresh tokens with a grace window and revokes the family on reuse', async () => {
    const first = await exchange(await getCode());
    const second = (await (
      await post({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: CLIENT,
      })
    ).json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const firstFamily = (await store.getToken(sha256hex(first.refresh_token)))?.familyId;
    const secondFamily = (await store.getToken(sha256hex(second.refresh_token)))?.familyId;
    expect(secondFamily).toBe(firstFamily);
    // within grace: old refresh still works (network retry)
    now += 30_000;
    expect(
      (
        await post({
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: CLIENT,
        })
      ).status,
    ).toBe(200);
    // outside grace: reuse ⇒ whole family revoked
    now += 61_000;
    const reuse = await post({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: CLIENT,
    });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    expect(
      (
        await post({
          grant_type: 'refresh_token',
          refresh_token: second.refresh_token,
          client_id: CLIENT,
        })
      ).status,
    ).toBe(400);
    expect((await store.getToken(sha256hex(second.access_token)))?.revokedAt).toBeTypeOf('number');
  });

  it('expired or unknown refresh tokens answer invalid_grant', async () => {
    const t = await exchange(await getCode());
    now += 91 * 24 * 3600 * 1000;
    expect(
      (
        (await (
          await post({
            grant_type: 'refresh_token',
            refresh_token: t.refresh_token,
            client_id: CLIENT,
          })
        ).json()) as { error: string }
      ).error,
    ).toBe('invalid_grant');
    expect(
      (await post({ grant_type: 'refresh_token', refresh_token: 'nope', client_id: CLIENT }))
        .status,
    ).toBe(400);
    const unsupported = await post({ grant_type: 'client_credentials' });
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

describe('POST /oauth/revoke', () => {
  it('revokes the whole family and always answers 200', async () => {
    const t = await exchange(await getCode());
    expect(
      (
        await fetch(`${base}/oauth/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t.access_token }),
        })
      ).status,
    ).toBe(200);
    expect((await store.getToken(sha256hex(t.refresh_token)))?.revokedAt).toBeTypeOf('number');
    expect(
      (
        await fetch(`${base}/oauth/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: 'unknown' }),
        })
      ).status,
    ).toBe(200);
  });

  it('rejects JSON bodies with 415', async () => {
    const res = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });
});

// One OAuth bucket for the whole surface, mounted in `mountAuth` at the app root
// ahead of /mcp and /health — an unscoped `app.use(limiter)` would run for every
// request reaching it, including ones no OAuth route matches. These pin the fix:
// the bucket only ever gates /oauth/*, and its own 429 is RFC 6749-shaped, not the
// JSON-RPC one /mcp uses.
describe('OAuth rate limiting', () => {
  it('never rate-limits /health, even past the 30-request oauth bucket', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${base}/health`).then((r) => r.status)),
    );
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('rate-limits /oauth/token past capacity with an RFC 6749-shaped 429', async () => {
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 31; i++) {
      const res = await post({ grant_type: 'client_credentials' });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(statuses.indexOf(429)).toBe(30);
    expect(limited?.headers.get('cache-control')).toBe('no-store');
    expect(limited?.headers.get('pragma')).toBe('no-cache');
    expect(limited?.headers.get('retry-after')).toBe('1');
    const body = (await limited?.json()) as { error: string };
    expect(body.error).toBe('temporarily_unavailable');
  });
});
