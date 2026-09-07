import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVaultSet, runVaultShow, type VaultSetDeps } from '../../src/cli/commands/vault.ts';
import type { ComposeRunner } from '../../src/cli/docker.ts';
import { parseEnv } from '../../src/cli/env-file.ts';

const CWD = '/proj';
const ENV_PATH = path.join(CWD, '.env');
const OLD_VAULT = '/home/u/Vault';
const NEW_VAULT = '/home/u/Work';
const ENV_TEXT = ['OWNER_SECRET=keep-me', `VAULT_PATH=${OLD_VAULT}`, 'TUNNEL_MODE=quick', ''].join(
  '\n',
);
const RUNNING_PS = `${JSON.stringify({ Service: 'app', State: 'running' })}\n`;

class FakeCompose implements ComposeRunner {
  calls: string[][] = [];
  private readonly psOutput: string;
  private readonly isAvailable: boolean;
  constructor(psOutput = '', isAvailable = true) {
    this.psOutput = psOutput;
    this.isAvailable = isAvailable;
  }
  async available() {
    return this.isAvailable;
  }
  async run(args: string[]) {
    this.calls.push(args);
    if (args[0] === 'ps') return { code: 0, stdout: this.psOutput };
    return { code: 0, stdout: '' };
  }
}

interface Harness {
  files: Map<string, string>;
  events: string[];
  printed: string[];
  compose: FakeCompose;
  deps: VaultSetDeps;
}

function harness(
  over: { ps?: string; dockerAvailable?: boolean; downCode?: number } = {},
): Harness {
  const files = new Map<string, string>([[ENV_PATH, ENV_TEXT]]);
  const events: string[] = [];
  const printed: string[] = [];
  const compose = new FakeCompose(over.ps ?? '', over.dockerAvailable ?? true);
  const deps: VaultSetDeps = {
    envPath: ENV_PATH,
    vaultCtx: {
      home: '/home/u',
      repoDir: CWD,
      platform: 'linux',
      stat: async (p) => (p.endsWith('/.obsidian') ? null : { isDirectory: () => true }),
      probeWrite: async () => true,
    },
    compose,
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, text) => {
      if (p === ENV_PATH) events.push('write-env');
      files.set(p, text);
    },
    down: async () => {
      events.push('down');
      return over.downCode ?? 0;
    },
    up: async () => {
      events.push('up');
      return 0;
    },
    print: (line) => printed.push(line),
  };
  return { files, events, printed, compose, deps };
}

describe('runVaultShow', () => {
  it('prints the configured vault path', () => {
    const printed: string[] = [];
    const code = runVaultShow({
      env: new Map([['VAULT_PATH', OLD_VAULT]]),
      print: (l) => printed.push(l),
    });
    expect(code).toBe(0);
    expect(printed).toEqual([OLD_VAULT]);
  });

  it('fails with a setup hint when VAULT_PATH is not set', () => {
    const printed: string[] = [];
    const code = runVaultShow({ env: new Map(), print: (l) => printed.push(l) });
    expect(code).toBe(1);
    expect(printed.join('\n')).toContain('./brainstem setup');
  });
});

describe('runVaultSet', () => {
  it('rejects an invalid path without touching .env or Docker', async () => {
    const h = harness({ ps: RUNNING_PS });
    const code = await runVaultSet({ path: 'Work' }, h.deps);
    expect(code).toBe(1);
    expect(h.printed.join('\n')).toContain('absolute');
    expect(h.files.get(ENV_PATH)).toBe(ENV_TEXT);
    expect(h.events).toEqual([]);
    expect(h.compose.calls).toEqual([]);
  });

  it('is a no-op when the path is already the current vault', async () => {
    const h = harness({ ps: RUNNING_PS });
    const code = await runVaultSet({ path: OLD_VAULT }, h.deps);
    expect(code).toBe(0);
    expect(h.printed.join('\n')).toContain('already');
    expect(h.files.get(ENV_PATH)).toBe(ENV_TEXT);
    expect(h.events).toEqual([]);
  });

  it('rewrites only VAULT_PATH and leaves the other keys alone', async () => {
    const h = harness();
    const code = await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(code).toBe(0);
    const env = parseEnv(h.files.get(ENV_PATH) ?? '');
    expect(env.get('VAULT_PATH')).toBe(NEW_VAULT);
    expect(env.get('OWNER_SECRET')).toBe('keep-me');
    expect(env.get('TUNNEL_MODE')).toBe('quick');
  });

  it('pre-creates _brainstem/ in the new vault, as setup does', async () => {
    const h = harness();
    await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(h.files.has(path.join(NEW_VAULT, '_brainstem', '.gitkeep'))).toBe(true);
  });

  it('carries the auth state over so connected clients stay connected', async () => {
    const h = harness();
    h.files.set(path.join(OLD_VAULT, '_brainstem', 'state.json'), '{"tokens":"fresh"}');
    h.files.set(path.join(NEW_VAULT, '_brainstem', 'state.json'), '{"tokens":"stale"}');
    await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(h.files.get(path.join(NEW_VAULT, '_brainstem', 'state.json'))).toBe(
      '{"tokens":"fresh"}',
    );
    expect(h.printed.join('\n')).toContain('state.json');
  });

  it('leaves the new vault state alone when the old vault has none', async () => {
    const h = harness();
    h.files.set(path.join(NEW_VAULT, '_brainstem', 'state.json'), '{"tokens":"stale"}');
    await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(h.files.get(path.join(NEW_VAULT, '_brainstem', 'state.json'))).toBe(
      '{"tokens":"stale"}',
    );
  });

  it('stops the containers before rewriting .env and starts them after', async () => {
    const h = harness({ ps: RUNNING_PS });
    const code = await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(code).toBe(0);
    expect(h.events).toEqual(['down', 'write-env', 'up']);
  });

  it('aborts without touching .env when the containers refuse to stop', async () => {
    const h = harness({ ps: RUNNING_PS, downCode: 1 });
    const code = await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(code).toBe(1);
    expect(h.files.get(ENV_PATH)).toBe(ENV_TEXT);
    expect(h.events).toEqual(['down']);
  });

  it('only prints the next step when nothing is running', async () => {
    const h = harness({ ps: '' });
    await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(h.events).toEqual(['write-env']);
    expect(h.printed.join('\n')).toContain('./brainstem up');
  });

  it('treats an unavailable Docker as nothing running', async () => {
    const h = harness({ dockerAvailable: false });
    const code = await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(code).toBe(0);
    expect(h.events).toEqual(['write-env']);
    expect(h.compose.calls).toEqual([]);
  });

  it('warns when the new folder has no .obsidian directory', async () => {
    const h = harness();
    await runVaultSet({ path: NEW_VAULT }, h.deps);
    expect(h.printed.join('\n')).toContain('.obsidian');
  });
});
