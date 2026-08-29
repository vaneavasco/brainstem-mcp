import { describe, expect, it } from 'vitest';
import { REMEDIES, runDoctor, runDoctorChecks } from '../../src/cli/commands/doctor.ts';
import { parseMajor, type SystemProbe } from '../../src/cli/system.ts';
import { TEST_OWNER_SECRET } from '../helpers/env.ts';

function probe(
  over: Partial<SystemProbe> & { results?: Record<string, { code: number; stdout?: string }> } = {},
): SystemProbe {
  const results = over.results ?? {};
  return {
    nodeVersion: () => '24.13.1',
    platform: 'linux',
    portFree: async () => true,
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      const r = results[key] ?? { code: 0, stdout: `${key} ok` };
      return { code: r.code, stdout: r.stdout ?? '', stderr: '' };
    },
    ...over,
  };
}
const goodEnv = () =>
  new Map([
    ['OWNER_SECRET', TEST_OWNER_SECRET],
    ['VAULT_PATH', '/home/u/Vault'],
    ['TUNNEL_MODE', 'quick'],
    ['PUBLIC_URL_FILE', '/vault/_brainstem/public-url'],
    ['PORT', '3000'],
  ]);
const vaultCtx = {
  home: '/home/u',
  repoDir: '/proj',
  platform: 'linux' as const,
  stat: async () => ({ isDirectory: () => true }),
  probeWrite: async () => true,
};

describe('parseMajor', () => {
  it('parses major versions', () => {
    expect(parseMajor('24.13.1')).toBe(24);
    expect(parseMajor('v22.0.0')).toBe(22);
    expect(parseMajor('nope')).toBe(0);
  });
});

describe('runDoctorChecks', () => {
  it('passes on a healthy machine with a valid .env', async () => {
    const checks = await runDoctorChecks({ probe: probe(), env: goodEnv(), vaultCtx, print() {} });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([
      'node',
      'docker',
      'docker-daemon',
      'compose',
      'env',
      'owner-secret',
      'vault-path',
      'tunnel-mode',
      'port',
    ]);
  });
  it('flags an old Node with the platform remedy', async () => {
    const checks = await runDoctorChecks({
      probe: probe({ nodeVersion: () => '20.1.0', platform: 'darwin' }),
      env: goodEnv(),
      vaultCtx,
      print() {},
    });
    const node = checks.find((c) => c.name === 'node');
    expect(node?.ok).toBe(false);
    expect(node?.remedy).toBe(REMEDIES.node.darwin);
  });
  it('distinguishes docker missing from docker not running', async () => {
    const missing = await runDoctorChecks({
      probe: probe({ results: { 'docker --version': { code: 127 } } }),
      env: goodEnv(),
      vaultCtx,
      print() {},
    });
    expect(missing.find((c) => c.name === 'docker')?.ok).toBe(false);
    const stopped = await runDoctorChecks({
      probe: probe({ results: { 'docker info': { code: 1 } } }),
      env: goodEnv(),
      vaultCtx,
      print() {},
    });
    expect(stopped.find((c) => c.name === 'docker')?.ok).toBe(true);
    expect(stopped.find((c) => c.name === 'docker-daemon')?.remedy).toMatch(
      /systemctl start docker/,
    );
  });
  it('reports a missing .env with the setup remedy and skips env-derived checks', async () => {
    const checks = await runDoctorChecks({ probe: probe(), env: null, vaultCtx, print() {} });
    expect(checks.find((c) => c.name === 'env')).toMatchObject({
      ok: false,
      remedy: './brainstem setup',
    });
    expect(checks.some((c) => c.name === 'owner-secret')).toBe(false);
  });
  it('validates the secret, vault path and tunnel-mode consistency without printing secrets', async () => {
    const env = goodEnv();
    env.set('OWNER_SECRET', 'short');
    env.set('TUNNEL_MODE', 'cloudflare');
    env.set('TUNNEL_TOKEN', 'tok-VALUE');
    const lines: string[] = [];
    const code = await runDoctor({ probe: probe(), env, vaultCtx, print: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/OWNER_SECRET/);
    expect(lines.join('\n')).not.toContain('short');
    expect(lines.join('\n')).toMatch(/PUBLIC_URL/);
    expect(lines.join('\n')).not.toContain('tok-VALUE');
  });
  it('treats a port used by our own app as fine', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'ok', name: 'brainstem-mcp' }), { status: 200 });
    const checks = await runDoctorChecks({
      probe: probe({ portFree: async () => false }),
      env: goodEnv(),
      vaultCtx,
      print() {},
      fetchImpl,
    });
    expect(checks.find((c) => c.name === 'port')).toMatchObject({ ok: true });
  });
  it('prerequisitesOnly returns exactly the four machine checks, even with no .env', async () => {
    const checks = await runDoctorChecks({
      probe: probe(),
      env: null,
      vaultCtx,
      print() {},
      prerequisitesOnly: true,
    });
    expect(checks.map((c) => c.name)).toEqual(['node', 'docker', 'docker-daemon', 'compose']);
  });
});
