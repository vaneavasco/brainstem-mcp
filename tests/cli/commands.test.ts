import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTokenStore } from '../../src/auth/store/file-store.ts';
import { runDown } from '../../src/cli/commands/down.ts';
import { runLogs } from '../../src/cli/commands/logs.ts';
import { runRevokeAll } from '../../src/cli/commands/revoke-all.ts';
import { maskSecret, runSecretRotate, runSecretShow } from '../../src/cli/commands/secret.ts';
import { parseComposePs, runStatus } from '../../src/cli/commands/status.ts';
import { LOCAL_IMAGE_TAG, runUp, type UpDeps, upSummary } from '../../src/cli/commands/up.ts';
import { runUrl } from '../../src/cli/commands/url.ts';
import type { ComposeRunner } from '../../src/cli/docker.ts';
import type { VaultPathContext } from '../../src/cli/vault-path.ts';

class FakeCompose implements ComposeRunner {
  calls: string[][] = [];
  envs: (Record<string, string> | undefined)[] = [];
  /** Exit code `docker compose pull` answers with (0 = the registry had the image). */
  pullCode = 0;
  private readonly psOutput: string;
  constructor(psOutput = '') {
    this.psOutput = psOutput;
  }
  async available() {
    return true;
  }
  async run(args: string[], opts?: { capture?: boolean; env?: Record<string, string> }) {
    this.calls.push(args);
    this.envs.push(opts?.env);
    if (args[0] === 'ps') return { code: 0, stdout: this.psOutput };
    if (args.includes('pull')) return { code: this.pullCode, stdout: '' };
    return { code: 0, stdout: '' };
  }
}

const upDeps = (compose: ComposeRunner, over: Partial<UpDeps> = {}): UpDeps => ({
  compose,
  env: new Map([['TUNNEL_MODE', 'quick']]),
  print() {},
  fetchImpl: healthOk('https://x.trycloudflare.com'),
  sleep: async () => {},
  localPort: 3000,
  imageTag: async () => 'sha-abc1234',
  ...over,
});

const healthOk = (publicUrl: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        status: 'ok',
        publicUrl,
        mcpUrl: `${publicUrl}/mcp`,
        tunnelMode: publicUrl.includes('trycloudflare') ? 'quick' : 'none',
        vault: { notes: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

const vaultCtx = (): VaultPathContext => ({
  home: '/home/u',
  repoDir: '/proj',
  platform: 'linux',
  stat: async () => ({ isDirectory: () => true }),
  probeWrite: async () => true,
});

describe('runUp', () => {
  it('starts the tunnel profile, waits for health and prints the connector URL', async () => {
    const compose = new FakeCompose();
    const lines: string[] = [];
    const code = await runUp(
      { build: true },
      upDeps(compose, {
        env: new Map([
          ['TUNNEL_MODE', 'quick'],
          ['PORT', '3000'],
        ]),
        print: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(0);
    // --build never consults the registry and tags the local build `dev`.
    expect(compose.calls[0]).toEqual(['--profile', 'tunnel', 'up', '-d', '--build']);
    expect(compose.envs[0]).toEqual({ BRAINSTEM_IMAGE_TAG: LOCAL_IMAGE_TAG });
    expect(lines.join('\n')).toContain('https://x.trycloudflare.com/mcp');
    expect(lines.join('\n')).toContain(
      'claude mcp add --transport http brainstem https://x.trycloudflare.com/mcp',
    );
    expect(lines.join('\n')).toMatch(/changes on every restart/);
  });

  it('in quick mode only trusts a URL two consecutive health polls agree on', async () => {
    const compose = new FakeCompose();
    const lines: string[] = [];
    const sleeps: number[] = [];
    let call = 0;
    // The first poll can still see the URL of the *previous* tunnel (the app
    // boots, then restarts when the new URL lands): print the settled one.
    const fetchImpl: typeof fetch = (async () => {
      call++;
      const url = call === 1 ? 'https://a.trycloudflare.com' : 'https://b.trycloudflare.com';
      return new Response(
        JSON.stringify({
          status: 'ok',
          publicUrl: url,
          mcpUrl: `${url}/mcp`,
          tunnelMode: 'quick',
          vault: { notes: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const code = await runUp(
      {},
      upDeps(compose, {
        print: (l) => lines.push(l),
        fetchImpl,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('https://b.trycloudflare.com/mcp');
    expect(lines.join('\n')).not.toContain('https://a.trycloudflare.com');
    expect(sleeps).toContain(3_000);
  });

  it('without a tunnel skips the profile and does not warn about rotation', async () => {
    const compose = new FakeCompose();
    const lines: string[] = [];
    const code = await runUp(
      {},
      upDeps(compose, {
        env: new Map([['TUNNEL_MODE', 'none']]),
        print: (l) => lines.push(l),
        fetchImpl: healthOk('http://localhost:3000'),
      }),
    );
    expect(code).toBe(0);
    // Default: pull the image CI built for this commit, then start without --build.
    expect(compose.calls[0]).toEqual(['pull', '--quiet']);
    expect(compose.envs[0]).toEqual({ BRAINSTEM_IMAGE_TAG: 'sha-abc1234' });
    expect(compose.calls[1]).toEqual(['up', '-d']);
    expect(compose.envs[1]).toEqual({ BRAINSTEM_IMAGE_TAG: 'sha-abc1234' });
    expect(lines.join('\n')).not.toMatch(/changes on every restart/);
  });

  it('falls back to a local build when the registry has no image for this commit', async () => {
    const compose = new FakeCompose();
    compose.pullCode = 1;
    const lines: string[] = [];
    const code = await runUp({}, upDeps(compose, { print: (l) => lines.push(l) }));
    expect(code).toBe(0);
    expect(compose.calls[0]).toEqual(['--profile', 'tunnel', 'pull', '--quiet']);
    expect(compose.calls[1]).toEqual(['--profile', 'tunnel', 'up', '-d', '--build']);
    expect(compose.envs[1]).toEqual({ BRAINSTEM_IMAGE_TAG: LOCAL_IMAGE_TAG });
    expect(lines.join('\n')).toMatch(/no prebuilt image for sha-abc1234/);
  });

  it('builds locally without asking the registry when the tree is not a clean checkout', async () => {
    const compose = new FakeCompose();
    const lines: string[] = [];
    const code = await runUp(
      {},
      upDeps(compose, { imageTag: async () => null, print: (l) => lines.push(l) }),
    );
    expect(code).toBe(0);
    expect(compose.calls.some((c) => c.includes('pull'))).toBe(false);
    expect(compose.calls[0]).toEqual(['--profile', 'tunnel', 'up', '-d', '--build']);
    expect(lines.join('\n')).toMatch(/not a clean git checkout/);
  });

  it('with --no-build refuses to start when nothing prebuilt can be pulled', async () => {
    const compose = new FakeCompose();
    compose.pullCode = 1;
    const lines: string[] = [];
    const code = await runUp({ build: false }, upDeps(compose, { print: (l) => lines.push(l) }));
    expect(code).toBe(1);
    expect(compose.calls.some((c) => c.includes('up'))).toBe(false);
    expect(lines.join('\n')).toMatch(/run without --no-build/);

    const dirty = new FakeCompose();
    const code2 = await runUp({ build: false }, upDeps(dirty, { imageTag: async () => null }));
    expect(code2).toBe(1);
    expect(dirty.calls).toEqual([]);
  });

  it('reports a health timeout with the last log lines', async () => {
    const compose = new FakeCompose();
    const lines: string[] = [];
    const failing: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const code = await runUp(
      {},
      upDeps(compose, { print: (l) => lines.push(l), fetchImpl: failing }),
    );
    expect(code).toBe(1);
    expect(compose.calls).toContainEqual(['logs', '--tail', '20', 'tunnel', 'app']);
    expect(lines.join('\n')).toMatch(/did not become healthy/);
  });

  it('prints "URL is stable" for a cloudflare tunnel and omits the quick-mode warning', () => {
    const lines = upSummary(
      {
        publicUrl: 'https://brain.example.com',
        mcpUrl: 'https://brain.example.com/mcp',
        tunnelMode: 'cloudflare',
        notes: 0,
      },
      { secretHint: 'in .env' },
    );
    expect(lines.join('\n')).toMatch(/URL is stable/);
    expect(lines.join('\n')).not.toMatch(/changes on every restart/);
  });

  it('reports when docker itself is unavailable', async () => {
    const compose: ComposeRunner = {
      available: async () => false,
      run: async () => ({ code: 0, stdout: '' }),
    };
    const lines: string[] = [];
    const code = await runUp(
      {},
      upDeps(compose, {
        env: new Map(),
        print: (l) => lines.push(l),
        fetchImpl: healthOk('http://localhost:3000'),
      }),
    );
    expect(code).toBe(1);
    expect(lines).toContain('Docker is not running or not installed');
  });
});

describe('runUrl', () => {
  it('skips the remote probe entirely when TUNNEL_MODE is none', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          status: 'ok',
          publicUrl: 'http://localhost:3000',
          mcpUrl: 'http://localhost:3000/mcp',
          tunnelMode: 'none',
          vault: { notes: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const lines: string[] = [];
    const code = await runUrl({ fetchImpl, print: (l) => lines.push(l), localPort: 3000 });
    expect(code).toBe(0);
    expect(calls).toBe(1); // only the local /health call — no remote probe
    expect(lines.join('\n')).toContain('http://localhost:3000');
  });

  it('reports the app is not running when local health fails', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const lines: string[] = [];
    const code = await runUrl({ fetchImpl: failing, print: (l) => lines.push(l), localPort: 3000 });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/not running/);
  });

  it('reports a failed remote probe through the tunnel', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            publicUrl: 'https://x.trycloudflare.com',
            mcpUrl: 'https://x.trycloudflare.com/mcp',
            tunnelMode: 'quick',
            vault: { notes: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error('timeout');
    }) as typeof fetch;
    const lines: string[] = [];
    const code = await runUrl({ fetchImpl, print: (l) => lines.push(l), localPort: 3000 });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/Remote check: failed/);
  });
});

describe('runStatus', () => {
  it('parses `compose ps --format json` (one JSON object per line) into service/state', () => {
    const stdout = [
      '{"Name":"brainstem-app-1","Service":"app","State":"running"}',
      '{"Name":"brainstem-tunnel-1","Service":"tunnel","State":"exited"}',
      '',
    ].join('\n');
    const services = parseComposePs(stdout);
    expect(services.get('app')).toBe('running');
    expect(services.get('tunnel')).toBe('exited');
  });

  it('prints .env summary, health and container state without leaking secrets', async () => {
    const compose = new FakeCompose('{"Name":"brainstem-app-1","Service":"app","State":"running"}');
    const lines: string[] = [];
    const code = await runStatus({
      env: new Map([
        ['TUNNEL_MODE', 'quick'],
        ['VAULT_PATH', '/home/u/vault'],
        ['OWNER_SECRET', 'super-secret-value'],
      ]),
      vaultCtx: vaultCtx(),
      compose,
      fetchImpl: healthOk('http://localhost:3000'),
      print: (l) => lines.push(l),
      localPort: 3000,
    });
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Tunnel mode: quick');
    expect(output).toContain('/home/u/vault');
    expect(output).toContain('app: running');
    expect(output).not.toContain('super-secret-value');
  });
});

describe('runDown', () => {
  it('runs `compose --profile tunnel down`', async () => {
    const compose = new FakeCompose();
    const code = await runDown({ compose, print: () => {} });
    expect(code).toBe(0);
    expect(compose.calls[0]).toEqual(['--profile', 'tunnel', 'down']);
  });
});

describe('runLogs', () => {
  it('follows all services when none is given', async () => {
    const compose = new FakeCompose();
    await runLogs({}, { compose });
    expect(compose.calls[0]).toEqual(['logs', '-f']);
  });

  it('follows a single service when given', async () => {
    const compose = new FakeCompose();
    await runLogs({ service: 'tunnel' }, { compose });
    expect(compose.calls[0]).toEqual(['logs', '-f', 'tunnel']);
  });
});

describe('runRevokeAll', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-cli-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('empties tokens and --reset writes back an empty state file', async () => {
    const file = path.join(dir, 'state.json');
    const store = await FileTokenStore.open(file);
    await store.putToken('h', {
      kind: 'access',
      familyId: 'f',
      clientId: 'c',
      clientName: 'n',
      resource: 'r',
      scope: 'vault',
      expiresAt: Date.now() + 1e6,
    });
    expect(await runRevokeAll({}, { stateFile: file, print() {}, confirm: async () => true })).toBe(
      0,
    );
    expect((await (await FileTokenStore.open(file)).getToken('h'))?.revokedAt).toBeTypeOf('number');
    const lines: string[] = [];
    expect(
      await runRevokeAll(
        { reset: true },
        { stateFile: file, print: (l) => lines.push(l), confirm: async () => true },
      ),
    ).toBe(0);
    // The file must still exist and be the empty v1 document — a running app
    // notices the new mtime and reloads it; an unlinked file would leave the
    // app's in-memory copy (and every token in it) alive.
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      version: 1,
      clients: {},
      pending: {},
      codes: {},
      tokens: {},
    });
    expect(lines).toContain('state file reset — all clients must reconnect');
  });

  it('does nothing when the user declines to confirm', async () => {
    const file = path.join(dir, 'state.json');
    const lines: string[] = [];
    const code = await runRevokeAll(
      {},
      { stateFile: file, print: (l) => lines.push(l), confirm: async () => false },
    );
    expect(code).toBe(0);
    expect(lines).toContain('cancelled');
    await expect(fs.access(file)).rejects.toBeDefined();
  });

  it('--reset creates the empty state file when none exists yet', async () => {
    const file = path.join(dir, 'never-created.json');
    const code = await runRevokeAll(
      { reset: true },
      { stateFile: file, print() {}, confirm: async () => true },
    );
    expect(code).toBe(0);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 1, tokens: {} });
  });
});

describe('secret show/rotate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-cli-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prints OWNER_SECRET when set', () => {
    const lines: string[] = [];
    const code = runSecretShow({
      env: new Map([['OWNER_SECRET', 'the-secret-value']]),
      print: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toContain('the-secret-value');
  });

  it('fails when OWNER_SECRET is unset', () => {
    const lines: string[] = [];
    const code = runSecretShow({ env: new Map(), print: (l) => lines.push(l) });
    expect(code).toBe(1);
  });

  it('masks the middle of a secret', () => {
    expect(maskSecret('abcd1234efgh5678')).toBe('abcd********5678');
    expect(maskSecret('short')).toBe('*****');
  });

  it('rotates OWNER_SECRET in .env and offers to revoke all tokens', async () => {
    const envPath = path.join(dir, '.env');
    const stateFile = path.join(dir, 'state.json');
    const files = new Map<string, string>([[envPath, 'OWNER_SECRET=old-secret\n']]);
    const store = await FileTokenStore.open(stateFile);
    await store.putToken('h', {
      kind: 'access',
      familyId: 'f',
      clientId: 'c',
      clientName: 'n',
      resource: 'r',
      scope: 'vault',
      expiresAt: Date.now() + 1e6,
    });

    const lines: string[] = [];
    const code = await runSecretRotate({
      envPath,
      stateFile,
      readFile: async (p) => files.get(p) ?? '',
      writeFile: async (p, t) => {
        files.set(p, t);
      },
      randomSecret: () => 'new-secret-value',
      print: (l) => lines.push(l),
      confirm: async () => true,
    });

    expect(code).toBe(0);
    expect(files.get(envPath)).toContain('OWNER_SECRET=new-secret-value');
    expect((await (await FileTokenStore.open(stateFile)).getToken('h'))?.revokedAt).toBeTypeOf(
      'number',
    );
    expect(lines.join('\n')).not.toContain('new-secret-value');
    expect(lines.join('\n')).toMatch(/\.\/brainstem up/);
  });
});
