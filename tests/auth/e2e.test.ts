import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  Client,
  type OAuthClientProvider,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { type McpHttpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createOwnerResolver } from '../../src/auth/context.ts';
import { sha256hex } from '../../src/auth/hash.ts';
import type { FileTokenStore } from '../../src/auth/store/file-store.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';
import { createTestAuth } from '../helpers/auth.ts';
import { baseEnv, TEST_OWNER_SECRET } from '../helpers/env.ts';

const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';

/**
 * Drives the SDK's real OAuth client machinery against our server. Only the
 * pieces the real Claude Code CLI would keep in memory: no persistence, one
 * pending code verifier/token set at a time — enough for one login + refresh.
 */
class TestProvider implements OAuthClientProvider {
  clientMetadataUrl = CLIENT;
  authorizationUrl: URL | undefined;
  private t: StoredOAuthTokens | undefined;
  private verifier = '';

  get redirectUrl(): string {
    return 'http://localhost:3118/callback';
  }

  get clientMetadata() {
    return {
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    };
  }

  // Returning client information synchronously (rather than undefined) tells
  // the SDK this client is already known to the AS, so it skips Dynamic
  // Client Registration and builds the authorization request directly with
  // client_id = CLIENT — the CIMD URL our AS resolves server-side.
  clientInformation() {
    return { client_id: CLIENT };
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.t;
  }

  saveTokens(t: StoredOAuthTokens): void {
    this.t = t;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  // Our /oauth/authorize requires `state` (CSRF protection is not optional
  // here); the SDK only sends it when the provider implements `state()`.
  state(): string {
    return crypto.randomUUID();
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface AppCtx {
  server: Server;
  handler: McpHttpHandler;
  base: string;
  root: string;
  runtime: VaultRuntime;
  store: FileTokenStore;
  config: Config;
}

async function startApp(): Promise<AppCtx> {
  // Pick the port first, then build PUBLIC_URL from it (mirrors TUNNEL_MODE=none)
  // so the app's issuer/resource — http://127.0.0.1:<port> — is exactly the
  // origin the SDK reaches it at. That makes the SDK's issuer check (RFC 8414
  // §3.3) and RFC 8707 resource check pass with no skip flags.
  const port = await freePort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-e2e-'));
  const config = loadConfig(
    baseEnv({ PUBLIC_URL: `http://127.0.0.1:${port}`, ALLOW_INSECURE_PUBLIC_URL: 'true' }),
  );
  const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  const { auth, store } = await createTestAuth(config, root, {
    cimd: {
      // The fake CIMD resolver from Task 8: resolves the SDK's client_id
      // (a CIMD URL) without ever making a real network request.
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
  const { app, handler } = createApp(
    config,
    createLogger('fatal'),
    createOwnerResolver(runtime),
    auth,
  );
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  return { server, handler, base: `http://127.0.0.1:${port}`, root, runtime, store, config };
}

async function stopApp(ctx: AppCtx): Promise<void> {
  await ctx.handler.close();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await ctx.runtime.close();
  await fs.rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

const formOf = (html: string) => ({
  pending_id: html.match(/name="pending_id" value="([^"]+)"/)?.[1] ?? '',
  nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? '',
});

describe('end-to-end OAuth with the SDK client', () => {
  let ctx: AppCtx;

  beforeAll(async () => {
    ctx = await startApp();
  });

  afterAll(async () => {
    await stopApp(ctx);
  });

  it('completes discovery → CIMD → consent → code → token → tool call, then refreshes', async () => {
    const { base, config, store } = ctx;
    const provider = new TestProvider();
    const url = new URL(`${base}/mcp`);
    let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const client = new Client(
      { name: 'e2e', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    // No tokens yet: the transport's 401 handler runs the SDK's `auth()`
    // orchestrator, which discovers metadata, has nothing to refresh, and
    // redirects — which surfaces here as UnauthorizedError.
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

    const authz = provider.authorizationUrl as URL;
    expect(authz).toBeInstanceOf(URL);
    expect(authz.searchParams.get('client_id')).toBe(CLIENT);
    expect(authz.searchParams.get('resource')).toBe(config.mcpUrl.href);
    expect(authz.searchParams.get('code_challenge_method')).toBe('S256');

    // The "browser step": our own server is reachable at `base` (PUBLIC_URL
    // for this harness), so fetching the captured URL as-is reaches it directly.
    const local = new URL(authz.pathname + authz.search, base);
    const html = await (await fetch(local)).text();
    const form = formOf(html);
    expect(form.pending_id).not.toBe('');
    const cb = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, action: 'approve', secret: TEST_OWNER_SECRET }),
    });
    const loc = new URL(cb.headers.get('location') ?? '');
    expect(loc.searchParams.get('iss')).toBe(config.publicUrl.href);
    expect(loc.searchParams.get('code')).toBeTruthy();

    // Preferred form: hand the whole callback URLSearchParams to finishAuth
    // so it validates `iss` (RFC 9207) before redeeming the code — our AS
    // advertises authorization_response_iss_parameter_supported: true, so the
    // code-only overload would be rejected with IssuerMismatchError here.
    await transport.finishAuth(loc.searchParams);

    transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await client.connect(transport);

    const result = await client.callTool({ name: 'vault_list', arguments: {} });
    expect(result.isError).toBeFalsy();

    const before = provider.tokens()?.refresh_token;
    // Force a refresh by expiring the access token server-side; the next
    // tool call should 401, silently refresh via the rotated refresh token,
    // and retry.
    await store.updateToken(sha256hex(provider.tokens()?.access_token ?? ''), {
      expiresAt: Date.now() - 1,
    });
    const again = await client.callTool({ name: 'brainstem_ping', arguments: {} });
    expect(again.isError).toBeFalsy();
    expect(provider.tokens()?.refresh_token).not.toBe(before);

    await client.close();
  });
});
