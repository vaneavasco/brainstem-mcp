import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSetup, type SetupDeps } from '../../src/cli/commands/setup.ts';
import { parseEnv } from '../../src/cli/env-file.ts';

const CWD = '/proj';
const EXAMPLE = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

function deps(
  files: Map<string, string>,
  answers: { confirm: boolean[]; select: string[] },
  platform: NodeJS.Platform = 'linux',
): SetupDeps {
  return {
    cwd: CWD,
    env: {},
    platform,
    uid: platform === 'linux' ? 1000 : undefined,
    gid: platform === 'linux' ? 1000 : undefined,
    io: {
      async prompt(_q, o) {
        return o.default ?? '';
      },
      async confirm() {
        return answers.confirm.shift() ?? false;
      },
      async select() {
        return (answers.select.shift() ?? 'quick') as never;
      },
      print() {},
    },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, t) => {
      files.set(p, t);
    },
    vaultCtx: {
      home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
      repoDir: CWD,
      platform,
      stat: async () => ({ isDirectory: () => true }),
      probeWrite: async () => true,
    },
    randomSecret: () => 'dGVzdC1vd25lci1zZWNyZXQtMzItYnl0ZXMtbG9uZy0hIQ',
    timezone: () => 'Europe/Chisinau',
  };
}

describe('runSetup', () => {
  it('fills a fresh .env for quick mode on linux', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    const answers = { confirm: [false], select: ['quick'] };
    await runSetup({ vault: '/home/u/Vault' }, deps(files, answers));
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    // deps().randomSecret() is a fixed stub (not real crypto) — assert it was used verbatim.
    expect(env.get('OWNER_SECRET')).toBe('dGVzdC1vd25lci1zZWNyZXQtMzItYnl0ZXMtbG9uZy0hIQ');
    expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
    expect(env.get('TUNNEL_MODE')).toBe('quick');
    expect(env.get('PUBLIC_URL_FILE')).toBe('/vault/_brainstem/public-url');
    expect(env.get('PUBLIC_URL')).toBe('');
    expect(env.get('HOST_UID')).toBe('1000');
    expect(env.get('VAULT_WATCH_POLL_MS')).toBe('');
  });

  it('is idempotent and switches to cloudflare mode with a token', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['quick'] }),
    );
    const first = parseEnv(files.get(path.join(CWD, '.env')) ?? '').get('OWNER_SECRET');
    await runSetup(
      { vault: '/home/u/Vault', tunnelToken: 'tok', publicUrl: 'https://brain.example.com' },
      deps(files, { confirm: [], select: [] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('OWNER_SECRET')).toBe(first);
    expect(env.get('TUNNEL_MODE')).toBe('cloudflare');
    expect(env.get('TUNNEL_TOKEN')).toBe('tok');
    expect(env.get('PUBLIC_URL')).toBe('https://brain.example.com');
    expect(env.get('PUBLIC_URL_FILE')).toBe('');
  });

  it('enables polling on win32 and skips HOST_UID', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: 'C:\\Users\\u\\Vault' },
      deps(files, { confirm: [false], select: ['none'] }, 'win32'),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_WATCH_POLL_MS')).toBe('2000');
    expect(env.get('HOST_UID')).toBe('');
    expect(env.get('TUNNEL_MODE')).toBe('none');
    expect(env.get('PUBLIC_URL')).toBe('http://localhost:3000');
    expect(env.get('ALLOW_INSECURE_PUBLIC_URL')).toBe('true');
  });

  it('rejects an invalid --vault without prompting', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await expect(
      runSetup({ vault: 'relative/path' }, deps(files, { confirm: [false], select: ['quick'] })),
    ).rejects.toThrow(/absolute/);
    expect(files.get(path.join(CWD, '.env'))).toBeUndefined();
  });

  it('rejects an invalid --public-url in cloudflare mode', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await expect(
      runSetup(
        { vault: '/home/u/Vault', tunnelToken: 'tok', publicUrl: 'https://brain.example.com/x' },
        deps(files, { confirm: [], select: [] }),
      ),
    ).rejects.toThrow();
  });

  it('does not overwrite an already-set value on a second run without --force', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['quick'] }),
    );
    await runSetup(
      { vault: '/home/u/OtherVault' },
      deps(files, { confirm: [false], select: ['quick'] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
  });

  it('overwrites an already-set value on a second run with --force', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['quick'] }),
    );
    await runSetup(
      { vault: '/home/u/OtherVault', force: true },
      deps(files, { confirm: [false], select: ['quick'] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_PATH')).toBe('/home/u/OtherVault');
  });
});
