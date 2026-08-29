import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';
import { createTestAuth } from '../helpers/auth.ts';
import { baseEnv, TEST_OWNER_SECRET } from '../helpers/env.ts';

const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';
const config = loadConfig(baseEnv());

interface AppCtx {
  server: Server;
  base: string;
  root: string;
  runtime: VaultRuntime;
}

// A fresh app/auth instance per suite: the resource owner lockout is process-wide
// state on `ownerAuth`, so a test that trips it must never share an instance with
// tests that expect a clean slate.
async function startApp(): Promise<AppCtx> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-authorize-'));
  const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  const { auth } = await createTestAuth(config, root, {
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
  return { server, base, root, runtime };
}

async function stopApp(ctx: AppCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await ctx.runtime.close();
  await fs.rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

const q = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: 'http://localhost:3118/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: 'https://brainstem.example.com/mcp',
    scope: 'vault',
    state: 'xyz',
    ...over,
  }).toString();

const authorizeAt = (base: string, over?: Record<string, string>) =>
  fetch(`${base}/oauth/authorize?${q(over)}`, { redirect: 'manual' });

const formOf = (html: string) => ({
  pending_id: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '',
  nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? '',
});

const consentAt = (base: string, body: Record<string, string>) =>
  fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

describe('oauth authorize + consent', () => {
  let ctx: AppCtx;
  let base: string;

  beforeAll(async () => {
    ctx = await startApp();
    base = ctx.base;
  });
  afterAll(async () => {
    await stopApp(ctx);
  });

  const authorize = (over?: Record<string, string>) => authorizeAt(base, over);
  const consent = (body: Record<string, string>) => consentAt(base, body);

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
      expect(
        new URL(
          (await authorize({ resource: 'https://other/mcp' })).headers.get('location') ?? '',
        ).searchParams.get('error'),
      ).toBe('invalid_target');
      expect(
        new URL(
          (await authorize({ scope: 'vault admin' })).headers.get('location') ?? '',
        ).searchParams.get('error'),
      ).toBe('invalid_scope');
    });
    it('ignores the loopback port but not the path', async () => {
      expect((await authorize({ redirect_uri: 'http://127.0.0.1:60000/callback' })).status).toBe(
        200,
      );
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
      const loc = new URL(
        (await consent({ ...form, action: 'deny' })).headers.get('location') ?? '',
      );
      expect(loc.searchParams.get('error')).toBe('access_denied');
    });
    it('rejects a bad nonce or replay with 400 and burns the pending row', async () => {
      const form = formOf(await (await authorize()).text());
      expect(
        (await consent({ ...form, nonce: 'wrong', action: 'approve', secret: TEST_OWNER_SECRET }))
          .status,
      ).toBe(400);
      expect(
        (await consent({ ...form, action: 'approve', secret: TEST_OWNER_SECRET })).status,
      ).toBe(400); // burned
    });
  });
});

// Isolated from the suite above: repeated wrong secrets trip the global owner
// lockout, which must not poison the other consent tests.
describe('POST /oauth/consent lockout', () => {
  let ctx: AppCtx;
  let base: string;

  beforeAll(async () => {
    ctx = await startApp();
    base = ctx.base;
  });
  afterAll(async () => {
    await stopApp(ctx);
  });

  it('re-renders on a wrong secret and locks after repeated failures', async () => {
    const form = formOf(await (await authorizeAt(base)).text());
    for (let i = 0; i < 4; i++) {
      expect((await consentAt(base, { ...form, action: 'approve', secret: 'nope' })).status).toBe(
        401,
      );
    }
    const locked = await consentAt(base, { ...form, action: 'approve', secret: 'nope' });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toMatch(/locked/i);
  });
});
