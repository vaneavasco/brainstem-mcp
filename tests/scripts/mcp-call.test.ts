import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type McpHttpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMcpCall } from '../../scripts/mcp-call.ts';
import { createApp } from '../../src/app.ts';
import { createOwnerResolver } from '../../src/auth/context.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';
import { createTestAuth } from '../helpers/auth.ts';
import { baseEnv, TEST_OWNER_SECRET } from '../helpers/env.ts';

const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';

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
}

/**
 * Same harness as tests/auth/e2e.test.ts: the port is picked first so
 * PUBLIC_URL is exactly the origin the script reaches, which keeps the SDK's
 * issuer (RFC 8414) and resource (RFC 8707) checks passing with no skip flags.
 * `resolveClient` is the fake CIMD resolver, doubling as the authorize counter
 * — it runs once per GET /oauth/authorize and nowhere else.
 */
let authorizeHits = 0;

async function startApp(): Promise<AppCtx> {
  const port = await freePort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-mcpcall-'));
  const config = loadConfig(
    baseEnv({ PUBLIC_URL: `http://127.0.0.1:${port}`, ALLOW_INSECURE_PUBLIC_URL: 'true' }),
  );
  const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
  const { auth } = await createTestAuth(config, root, {
    cimd: {
      resolveClient: async (id: string) => {
        if (id !== CLIENT) throw new OAuthError(OAuthErrorCode.InvalidClient, 'nope');
        authorizeHits += 1;
        return {
          clientId: CLIENT,
          clientName: 'Claude Code',
          redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
          fetchedAt: 0,
          expiresAt: 9e15,
        };
      },
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
  return { server, handler, base: `http://127.0.0.1:${port}`, root, runtime };
}

async function stopApp(ctx: AppCtx): Promise<void> {
  await ctx.handler.close();
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await ctx.runtime.close();
  await fs.rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

describe('npm run mcp:call', () => {
  let ctx: AppCtx;
  let tokenFile: string;
  const out: string[] = [];
  const err: string[] = [];

  const call = (args: string[]) =>
    runMcpCall({
      url: `${ctx.base}/mcp`,
      secret: TEST_OWNER_SECRET,
      tokenFile,
      args,
      print: (line) => out.push(line),
      printErr: (line) => err.push(line),
    });

  beforeAll(async () => {
    ctx = await startApp();
    tokenFile = path.join(ctx.root, 'dev-tokens.json');
  });

  afterAll(async () => {
    await stopApp(ctx);
  });

  it('logs in headlessly (no browser) and lists the tools', async () => {
    expect(authorizeHits).toBe(0);
    const code = await call(['--list']);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('brainstem_ping');
    // One consent round-trip: the fake resolver saw exactly one authorize.
    expect(authorizeHits).toBe(1);
  });

  it('persists the tokens to a 0600 file, stamped with the issuer', async () => {
    const stat = await fs.stat(tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8')) as Record<string, unknown>;
    expect(typeof saved.access_token).toBe('string');
    expect(typeof saved.refresh_token).toBe('string');
    expect(saved.issuer).toBe(`${ctx.base}/`);
  });

  it('reuses the cached tokens on the next run — no second consent', async () => {
    out.length = 0;
    const code = await call(['brainstem_ping']);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const printed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(printed.server).toBe('brainstem-mcp');
    expect(printed.era).toBeTruthy();
    expect(authorizeHits).toBe(1);
  });

  it('parses JSON arguments for the tool call', async () => {
    out.length = 0;
    const code = await call(['vault_list', '{"depth":1}']);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('entries');
    expect(authorizeHits).toBe(1);
  });

  it('--reauth discards the cached tokens and consents again', async () => {
    out.length = 0;
    const code = await call(['--reauth', '--list']);
    expect(code).toBe(0);
    expect(authorizeHits).toBe(2);
  });

  it('exits 1 with the error text for an unknown tool', async () => {
    out.length = 0;
    err.length = 0;
    const code = await call(['no_such_tool']);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/no_such_tool|not found|unknown/i);
  });

  it('exits 1 when no tool is named', async () => {
    err.length = 0;
    expect(await call([])).toBe(1);
    expect(err.join('\n')).toMatch(/tool/i);
  });

  it('exits 1 on a wrong owner secret instead of hanging on a browser', async () => {
    err.length = 0;
    const code = await runMcpCall({
      url: `${ctx.base}/mcp`,
      secret: 'wrong-secret',
      tokenFile: path.join(ctx.root, 'other-tokens.json'),
      args: ['--list'],
      print: (line) => out.push(line),
      printErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/secret/i);
  });
});
