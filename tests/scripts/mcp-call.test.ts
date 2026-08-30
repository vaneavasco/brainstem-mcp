import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type McpHttpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSameOrigin,
  assertTokenFileIgnored,
  DevOAuthProvider,
  parseArgs,
  resolveOptions,
  runMcpCall,
} from '../../scripts/mcp-call.ts';
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

  it('persists the tokens to a 0600 file, keyed by the issuer that minted them', async () => {
    const stat = await fs.stat(tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8')) as {
      issuer: string;
      tokens: Record<string, unknown>;
    };
    expect(saved.issuer).toBe(`${ctx.base}/`);
    expect(typeof saved.tokens.access_token).toBe('string');
    expect(typeof saved.tokens.refresh_token).toBe('string');
    expect(saved.tokens.issuer).toBe(`${ctx.base}/`);
  });

  it('ignores a token file bound to a different issuer', async () => {
    const foreign = path.join(ctx.root, 'foreign-tokens.json');
    const mine = JSON.parse(await fs.readFile(tokenFile, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(
      foreign,
      JSON.stringify({ ...mine, issuer: 'https://someone-elses-server.example/' }),
      { mode: 0o600 },
    );
    const before = authorizeHits;
    out.length = 0;
    const code = await runMcpCall({
      url: `${ctx.base}/mcp`,
      secret: TEST_OWNER_SECRET,
      tokenFile: foreign,
      args: ['--list'],
      print: (line) => out.push(line),
      printErr: (line) => err.push(line),
    });
    expect(code).toBe(0);
    // The foreign token set was never sent: it had to log in again.
    expect(authorizeHits).toBe(before + 1);
  });

  it('reuses the cached tokens on the next run — no second consent', async () => {
    const hitsBefore = authorizeHits;
    out.length = 0;
    const code = await call(['brainstem_ping']);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const printed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(printed.server).toBe('brainstem-mcp');
    expect(printed.era).toBeTruthy();
    expect(authorizeHits).toBe(hitsBefore);
  });

  it('parses JSON arguments for the tool call', async () => {
    const hitsBefore = authorizeHits;
    out.length = 0;
    const code = await call(['vault_list', '{"depth":1}']);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('entries');
    expect(authorizeHits).toBe(hitsBefore);
  });

  it('--reauth ignores the cache, consents again and rewrites the file', async () => {
    const before = (
      JSON.parse(await fs.readFile(tokenFile, 'utf8')) as { tokens: { access_token: string } }
    ).tokens.access_token;
    const hitsBefore = authorizeHits;
    out.length = 0;
    const code = await call(['--reauth', '--list']);
    expect(code).toBe(0);
    expect(authorizeHits).toBe(hitsBefore + 1);
    const after = (
      JSON.parse(await fs.readFile(tokenFile, 'utf8')) as { tokens: { access_token: string } }
    ).tokens.access_token;
    expect(after).not.toBe(before);
  });

  it('rejects an unknown option instead of treating it as a tool name', async () => {
    err.length = 0;
    expect(await call(['--nope'])).toBe(1);
    expect(err.join('\n')).toBe('unknown option: --nope');
  });

  it('rejects json-args that are not a JSON object', async () => {
    err.length = 0;
    expect(await call(['vault_list', '{not json'])).toBe(1);
    expect(err.join('\n')).toMatch(/^bad json-args: /);
    err.length = 0;
    expect(await call(['vault_list', '[1,2]'])).toBe(1);
    expect(err.join('\n')).toBe('bad json-args: not a JSON object');
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

describe('assertSameOrigin', () => {
  it('passes when the authorize URL is on the --url origin', () => {
    expect(() =>
      assertSameOrigin('https://vault.example/oauth/authorize?x=1', 'https://vault.example/mcp'),
    ).not.toThrow();
    // Port and scheme are part of the origin; a bare path difference is not.
    expect(() =>
      assertSameOrigin('http://127.0.0.1:3000/oauth/consent', 'http://127.0.0.1:3000/mcp'),
    ).not.toThrow();
  });

  it('refuses to send the owner secret anywhere else', () => {
    expect(() =>
      assertSameOrigin('https://evil.example/oauth/authorize', 'https://vault.example/mcp'),
    ).toThrow(/refusing to send the owner secret to https:\/\/evil\.example/);
    expect(() =>
      assertSameOrigin('https://vault.example:8443/oauth/authorize', 'https://vault.example/mcp'),
    ).toThrow(/refusing to send the owner secret/);
    expect(() =>
      assertSameOrigin('http://vault.example/oauth/authorize', 'https://vault.example/mcp'),
    ).toThrow(/refusing to send the owner secret/);
  });
});

describe('DevOAuthProvider.redirectToAuthorization', () => {
  it('throws before touching the network when the authorize URL is off-origin', async () => {
    // The authorize URL is built from discovered AS metadata, so an AS that
    // advertises someone else's host must not get the owner secret. Nothing is
    // fetched here: unreachable.invalid would fail loudly if the guard ran late.
    const provider = new DevOAuthProvider(
      path.join(os.tmpdir(), 'never-written.json'),
      'the-owner-secret',
      'https://vault.example/mcp',
    );
    await expect(
      provider.redirectToAuthorization(new URL('https://evil.unreachable.invalid/oauth/authorize')),
    ).rejects.toThrow(/refusing to send the owner secret to https:\/\/evil\.unreachable\.invalid/);
    expect(provider.callbackParams).toBeUndefined();
  });
});

describe('assertTokenFileIgnored', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);

  it('accepts a path outside the repository without asking git', () => {
    expect(() =>
      assertTokenFileIgnored('/tmp/somewhere/tokens.json', repoRoot, warn),
    ).not.toThrow();
  });

  it('accepts a gitignored path inside the repository', () => {
    expect(() =>
      assertTokenFileIgnored(path.join(repoRoot, '.brainstem-dev-tokens.json'), repoRoot, warn),
    ).not.toThrow();
    expect(() =>
      assertTokenFileIgnored(path.join(repoRoot, 'src', 'my-dev-tokens.json'), repoRoot, warn),
    ).not.toThrow();
  });

  it('refuses a committable path inside the repository', () => {
    expect(() =>
      assertTokenFileIgnored(path.join(repoRoot, 'src', 'tokens.json'), repoRoot, warn),
    ).toThrow(/not gitignored/);
  });

  it('warns and continues when git cannot answer', () => {
    warnings.length = 0;
    const notARepo = os.tmpdir();
    // `repoRoot` here is a directory git knows nothing about, so check-ignore
    // exits 128 — treated as "cannot verify", never as "safe" or "unsafe".
    expect(() =>
      assertTokenFileIgnored(path.join(notARepo, 'tokens.json'), notARepo, warn),
    ).not.toThrow();
    expect(warnings.join('\n')).toMatch(/could not run git check-ignore/);
  });
});

describe('parseArgs', () => {
  it('accepts --flag value and --flag=value alike', () => {
    const a = parseArgs(['--url', 'https://a.example/mcp', '--list']);
    expect(a.values.get('--url')).toBe('https://a.example/mcp');
    expect(a.bools.has('--list')).toBe(true);
    const b = parseArgs(['--url=https://a.example/mcp', '--reauth', 'brainstem_ping']);
    expect(b.values.get('--url')).toBe('https://a.example/mcp');
    expect(b.bools.has('--reauth')).toBe(true);
    expect(b.positional).toEqual(['brainstem_ping']);
  });

  it('reports unknown options, missing values and valued booleans', () => {
    expect(parseArgs(['--nope']).error).toBe('unknown option: --nope');
    expect(parseArgs(['--url']).error).toBe('--url needs a value');
    expect(parseArgs(['--list=yes']).error).toBe('--list takes no value');
  });

  it('keeps a JSON argument that starts with a brace as a positional', () => {
    const parsed = parseArgs(['vault_list', '{"depth":1}']);
    expect(parsed.error).toBeUndefined();
    expect(parsed.positional).toEqual(['vault_list', '{"depth":1}']);
  });
});

describe('resolveOptions', () => {
  let repoRoot: string;
  let vault: string;

  beforeAll(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-resolve-'));
    vault = path.join(repoRoot, 'vault');
    await fs.mkdir(path.join(vault, '_brainstem'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const writeEnv = (lines: string[]) =>
    fs.writeFile(path.join(repoRoot, '.env'), `${lines.join('\n')}\n`);

  it('defaults the URL and the secret from .env, and appends /mcp', async () => {
    await writeEnv(['PUBLIC_URL=https://vault.example', 'OWNER_SECRET=s3cret']);
    const opts = await resolveOptions([], repoRoot);
    expect(opts.url).toBe('https://vault.example/mcp');
    expect(opts.secret).toBe('s3cret');
    expect(opts.tokenFile).toBe(path.join(repoRoot, '.brainstem-dev-tokens.json'));
    expect(opts.args).toEqual([]);
  });

  it('appends /mcp to any path that is not already the endpoint', async () => {
    await writeEnv(['PUBLIC_URL=https://vault.example', 'OWNER_SECRET=s3cret']);
    expect((await resolveOptions(['--url=https://a.example'], repoRoot)).url).toBe(
      'https://a.example/mcp',
    );
    expect((await resolveOptions(['--url=https://a.example/'], repoRoot)).url).toBe(
      'https://a.example/mcp',
    );
    expect((await resolveOptions(['--url=https://a.example/mcp'], repoRoot)).url).toBe(
      'https://a.example/mcp',
    );
    // A path prefix is kept, not clobbered — the old check only handled "/".
    expect((await resolveOptions(['--url=https://a.example/brain'], repoRoot)).url).toBe(
      'https://a.example/brain/mcp',
    );
  });

  it('prefers the quick-tunnel URL file over a stale PUBLIC_URL', async () => {
    await writeEnv([
      'PUBLIC_URL=https://stale.example',
      'OWNER_SECRET=s3cret',
      'TUNNEL_MODE=quick',
      `VAULT_PATH=${vault}`,
    ]);
    await fs.writeFile(path.join(vault, '_brainstem', 'public-url'), 'https://fresh.example\n');
    expect((await resolveOptions([], repoRoot)).url).toBe('https://fresh.example/mcp');

    // No file yet (tunnel still coming up): fall back to PUBLIC_URL.
    await fs.rm(path.join(vault, '_brainstem', 'public-url'));
    expect((await resolveOptions([], repoRoot)).url).toBe('https://stale.example/mcp');
  });

  it('takes --flag=value overrides and passes the rest through as args', async () => {
    await writeEnv(['PUBLIC_URL=https://vault.example', 'OWNER_SECRET=s3cret']);
    const opts = await resolveOptions(
      ['--url=https://other.example/mcp', '--secret=override', '--token-file=t.json', '--list'],
      repoRoot,
    );
    expect(opts.url).toBe('https://other.example/mcp');
    expect(opts.secret).toBe('override');
    expect(opts.tokenFile).toBe(path.join(repoRoot, 't.json'));
    expect(opts.args).toEqual(['--list']);

    const call = await resolveOptions(['vault_list', '{"depth":1}'], repoRoot);
    expect(call.args).toEqual(['vault_list', '{"depth":1}']);
  });

  it('rejects unknown options and missing configuration', async () => {
    await writeEnv(['PUBLIC_URL=https://vault.example', 'OWNER_SECRET=s3cret']);
    await expect(resolveOptions(['--nope'], repoRoot)).rejects.toThrow('unknown option: --nope');
    await expect(resolveOptions(['--secret'], repoRoot)).rejects.toThrow('--secret needs a value');

    await writeEnv(['OWNER_SECRET=s3cret']);
    await expect(resolveOptions([], repoRoot)).rejects.toThrow(/no server URL/);
    await writeEnv(['PUBLIC_URL=https://vault.example']);
    await expect(resolveOptions([], repoRoot)).rejects.toThrow(/no owner secret/);
  });
});
