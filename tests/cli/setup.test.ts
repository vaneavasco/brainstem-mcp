import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSetup, type SetupDeps } from '../../src/cli/commands/setup.ts';
import { parseEnv } from '../../src/cli/env-file.ts';

const CWD = '/proj';
const EXAMPLE = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

function deps(
  files: Map<string, string>,
  answers: { confirm: boolean[]; select: string[] },
  platform: NodeJS.Platform = 'linux',
  printed: string[] = [],
  overrides: Partial<SetupDeps> = {},
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
      async select(_q, _choices, opts) {
        return (answers.select.shift() ?? opts?.default ?? 'quick') as never;
      },
      print(line) {
        printed.push(line);
      },
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
    dockerAvailable: async () => true,
    ...overrides,
  };
}

describe('runSetup — tunnel mode (unchanged behaviour)', () => {
  it('fills a fresh .env for quick mode on linux', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    // First answer picks the new "how will Claude reach this vault?" prompt; the rest is
    // the pre-existing tunnel-mode flow, unchanged.
    const answers = { confirm: [false], select: ['tunnel', 'quick'] };
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
    // .env.example ships VAULT_TIMEZONE empty; a fresh run fills it from the host.
    expect(env.get('VAULT_TIMEZONE')).toBe('Europe/Chisinau');
  });

  it('is idempotent and switches to cloudflare mode with a token', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }),
    );
    const first = parseEnv(files.get(path.join(CWD, '.env')) ?? '').get('OWNER_SECRET');
    await runSetup(
      {
        mode: 'tunnel',
        vault: '/home/u/Vault',
        tunnelToken: 'tok',
        publicUrl: 'https://brain.example.com',
      },
      deps(files, { confirm: [], select: [] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('OWNER_SECRET')).toBe(first);
    expect(env.get('TUNNEL_MODE')).toBe('cloudflare');
    expect(env.get('TUNNEL_TOKEN')).toBe('tok');
    expect(env.get('PUBLIC_URL')).toBe('https://brain.example.com');
    expect(env.get('PUBLIC_URL_FILE')).toBe('');
  });

  it('never prints the tunnel token value, even with --show-secret', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    const token = 'super-secret-tunnel-token';
    const printed: string[] = [];
    await runSetup(
      {
        mode: 'tunnel',
        vault: '/home/u/Vault',
        tunnelToken: token,
        publicUrl: 'https://brain.example.com',
        showSecret: true,
      },
      deps(files, { confirm: [], select: [] }, 'linux', printed),
    );
    expect(printed.some((line) => line.includes(token))).toBe(false);
    expect(printed.some((line) => line.includes('TUNNEL_TOKEN=****'))).toBe(true);
  });

  it('enables polling on win32 and skips HOST_UID', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: 'C:\\Users\\u\\Vault' },
      deps(files, { confirm: [false], select: ['tunnel', 'none'] }, 'win32'),
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
      runSetup(
        { mode: 'tunnel', vault: 'relative/path' },
        deps(files, { confirm: [false], select: ['quick'] }),
      ),
    ).rejects.toThrow(/absolute/);
    expect(files.get(path.join(CWD, '.env'))).toBeUndefined();
  });

  it('rejects an invalid --public-url in cloudflare mode', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await expect(
      runSetup(
        {
          mode: 'tunnel',
          vault: '/home/u/Vault',
          tunnelToken: 'tok',
          publicUrl: 'https://brain.example.com/x',
        },
        deps(files, { confirm: [], select: [] }),
      ),
    ).rejects.toThrow();
  });

  it('ends with the `./brainstem up` next step, and suppresses it for printNext: false', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    const printed: string[] = [];
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }, 'linux', printed),
    );
    // Every user-facing hint speaks the launcher's vocabulary, never `npm run`.
    expect(printed.join('\n')).not.toContain('npm run');
    expect(printed.at(-1)).toBe('Next: ./brainstem up');

    // `start` runs setup and then goes straight on to `up`, so telling the user
    // to run `./brainstem up` next would be wrong there.
    const files2 = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    const printed2: string[] = [];
    await runSetup(
      { vault: '/home/u/Vault', printNext: false },
      deps(files2, { confirm: [false], select: ['tunnel', 'quick'] }, 'linux', printed2),
    );
    expect(printed2.some((l) => l.startsWith('Next:'))).toBe(false);
  });

  it('does not overwrite an already-set value on a second run without --force', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }),
    );
    await runSetup(
      { vault: '/home/u/OtherVault' },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
  });

  it('overwrites an already-set value on a second run with --force', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { vault: '/home/u/Vault' },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }),
    );
    await runSetup(
      { vault: '/home/u/OtherVault', force: true },
      deps(files, { confirm: [false], select: ['tunnel', 'quick'] }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_PATH')).toBe('/home/u/OtherVault');
  });
});

describe('runSetup — local mode', () => {
  it('writes only VAULT_PATH, probing neither Docker nor generating a secret', async () => {
    const files = new Map<string, string>();
    const dockerAvailable = vi.fn(async () => true);
    const randomSecret = vi.fn(() => 'unused-secret');
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed, { dockerAvailable, randomSecret }),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect([...env.keys()]).toEqual(['VAULT_PATH']);
    expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
    expect(dockerAvailable).not.toHaveBeenCalled();
    expect(randomSecret).not.toHaveBeenCalled();
  });

  it('keeps every existing key (an install may switch modes later) and replaces VAULT_PATH', async () => {
    const existing =
      'OWNER_SECRET=abc\n' +
      'VAULT_PATH=/old/vault\n' +
      'TUNNEL_MODE=cloudflare\n' +
      'TUNNEL_TOKEN=tok\n' +
      'PUBLIC_URL=https://brain.example.com\n';
    const files = new Map<string, string>([[path.join(CWD, '.env'), existing]]);
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed),
    );
    const env = parseEnv(files.get(path.join(CWD, '.env')) ?? '');
    expect(env.get('VAULT_PATH')).toBe('/home/u/Vault');
    expect(env.get('OWNER_SECRET')).toBe('abc');
    expect(env.get('TUNNEL_MODE')).toBe('cloudflare');
    expect(env.get('TUNNEL_TOKEN')).toBe('tok');
    expect(env.get('PUBLIC_URL')).toBe('https://brain.example.com');
    // Says what it kept, but never the secret/token values themselves.
    expect(printed.some((l) => l.includes('abc'))).toBe(false);
    expect(printed.some((l) => l.includes('tok'))).toBe(false);
    expect(printed).toContain('kept OWNER_SECRET');
    expect(printed).toContain('kept TUNNEL_MODE');
    expect(printed).toContain('kept TUNNEL_TOKEN');
    expect(printed).toContain('kept PUBLIC_URL');
  });

  it("F2: the reviewer's duplicated VAULT_PATH case heals on local setup and is reported", async () => {
    const existing = 'VAULT_PATH=/old/first\nOTHER=1\nVAULT_PATH=/old/second\n';
    const files = new Map<string, string>([[path.join(CWD, '.env'), existing]]);
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed),
    );
    const envText = files.get(path.join(CWD, '.env')) ?? '';
    expect(envText.match(/^VAULT_PATH=/gm)).toHaveLength(1);
    expect(parseEnv(envText).get('VAULT_PATH')).toBe('/home/u/Vault');
    expect(envText).toContain('OTHER=1');
    expect(printed).toContain('removed a duplicate VAULT_PATH line');
  });

  it('refuses an unusable vault folder with the shared validation message, touching nothing', async () => {
    const files = new Map<string, string>();
    const dockerAvailable = vi.fn(async () => true);
    await expect(
      runSetup(
        { mode: 'local', vault: 'relative/path' },
        deps(files, { confirm: [], select: [] }, 'linux', [], { dockerAvailable }),
      ),
    ).rejects.toThrow(/absolute/);
    expect(files.get(path.join(CWD, '.env'))).toBeUndefined();
    expect(dockerAvailable).not.toHaveBeenCalled();
  });

  it('prints the ready-to-paste Claude Code line with the absolute launcher path, per platform', async () => {
    const filesLinux = new Map<string, string>();
    const printedLinux: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(filesLinux, { confirm: [], select: [] }, 'linux', printedLinux),
    );
    expect(printedLinux).toContain(
      'Claude Code: claude mcp add brainstem -- /proj/brainstem stdio',
    );
    expect(printedLinux.some((l) => l.includes('brainstem-work') && l.includes('--vault'))).toBe(
      true,
    );
    expect(printedLinux.some((l) => /Claude Desktop/.test(l) && /bundle/.test(l))).toBe(true);

    const filesWin = new Map<string, string>();
    const printedWin: string[] = [];
    await runSetup(
      { mode: 'local', vault: 'C:\\Users\\u\\Vault' },
      deps(filesWin, { confirm: [], select: [] }, 'win32', printedWin),
    );
    expect(printedWin).toContain(
      'Claude Code: claude mcp add brainstem -- \\proj\\brainstem.cmd stdio',
    );
  });

  it('never prints "Next: ./brainstem up" — there is no Docker step in local mode', async () => {
    const files = new Map<string, string>();
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed),
    );
    expect(printed.some((l) => l.startsWith('Next:'))).toBe(false);
  });

  it('single-quotes (POSIX) a launcher path that contains a space, escaping embedded quotes', async () => {
    const files = new Map<string, string>();
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed, { cwd: '/proj with space' }),
    );
    expect(printed).toContain(
      "Claude Code: claude mcp add brainstem -- '/proj with space/brainstem' stdio",
    );
  });

  it('single-quotes (POSIX) a launcher path that itself contains a single quote', async () => {
    const files = new Map<string, string>();
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', printed, { cwd: "/proj's" }),
    );
    expect(printed).toContain(
      "Claude Code: claude mcp add brainstem -- '/proj'\\''s/brainstem' stdio",
    );
  });

  it('double-quotes (Windows) a launcher path that contains a space', async () => {
    const files = new Map<string, string>();
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: 'C:\\Users\\u\\Vault' },
      deps(files, { confirm: [], select: [] }, 'win32', printed, {
        cwd: 'C:\\Users\\u with space',
      }),
    );
    expect(printed).toContain(
      'Claude Code: claude mcp add brainstem -- "C:\\Users\\u with space\\brainstem.cmd" stdio',
    );
  });

  it('double-quotes (Windows) a launcher path that contains a single quote', async () => {
    const files = new Map<string, string>();
    const printed: string[] = [];
    await runSetup(
      { mode: 'local', vault: 'C:\\Users\\u\\Vault' },
      deps(files, { confirm: [], select: [] }, 'win32', printed, { cwd: "C:\\Users\\u's" }),
    );
    expect(printed).toContain(
      'Claude Code: claude mcp add brainstem -- "C:\\Users\\u\'s\\brainstem.cmd" stdio',
    );
  });
});

describe('runSetup — mode selection and the tunnel-mode Docker check', () => {
  it('defaults to tunnel mode when nothing is scripted/answered (non-interactive io)', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    // No `mode` arg and an empty select queue: the fake io then falls back to whatever
    // `resolveMode` passed as `opts.default` — exactly what a real non-interactive io does.
    await expect(
      runSetup(
        { vault: '/home/u/Vault' },
        deps(files, { confirm: [false], select: [] }, 'linux', [], {
          dockerAvailable: async () => false,
        }),
      ),
    ).rejects.toThrow('Docker is required. Install Docker Desktop');
  });

  it('reports a missing Docker with the same message the launcher used to print, on linux/macOS', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await expect(
      runSetup(
        { mode: 'tunnel', vault: '/home/u/Vault' },
        deps(files, { confirm: [], select: [] }, 'linux', [], {
          dockerAvailable: async () => false,
        }),
      ),
    ).rejects.toThrow(
      'Docker is required. Install Docker Desktop (https://docs.docker.com/desktop/) or Docker Engine + Compose v2.',
    );
  });

  it('reports a missing Docker with the same message the launcher used to print, on win32', async () => {
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await expect(
      runSetup(
        { mode: 'tunnel', vault: 'C:\\Users\\u\\Vault' },
        deps(files, { confirm: [], select: [] }, 'win32', [], {
          dockerAvailable: async () => false,
        }),
      ),
    ).rejects.toThrow('Docker Desktop is required: https://docs.docker.com/desktop/');
  });

  it('never probes Docker for local mode, and always does for tunnel mode', async () => {
    const dockerAvailable = vi.fn(async () => true);
    const files = new Map<string, string>([[path.join(CWD, '.env.example'), EXAMPLE]]);
    await runSetup(
      { mode: 'local', vault: '/home/u/Vault' },
      deps(files, { confirm: [], select: [] }, 'linux', [], { dockerAvailable }),
    );
    expect(dockerAvailable).not.toHaveBeenCalled();

    await runSetup(
      { mode: 'tunnel', vault: '/home/u/Vault', force: true },
      deps(files, { confirm: [false], select: ['quick'] }, 'linux', [], { dockerAvailable }),
    );
    expect(dockerAvailable).toHaveBeenCalledTimes(1);
  });
});
