// F1: the stdio server's machine-local state and index-cache folders must never end up inside
// the vault (every tool would then list, read and search the server's own working files), and
// the reverse — a vault nested inside the machine-local base — is refused/disabled the same way.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const STDIO_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');

interface RunResult {
  code: number | null;
  stderr: string;
}

/** Spawns `src/stdio-main.ts` directly (no MCP client) and waits for it to exit — for the exit-1
 *  cases below, where a real client would never get past the handshake anyway. */
async function runToExit(
  env: Record<string, string | undefined>,
  root: string,
): Promise<RunResult> {
  const child = spawn(process.execPath, [STDIO_MAIN, '--vault', root], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', (c) => resolve(c));
  });
  return { code, stderr };
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

async function freshDirs(): Promise<{ root: string; base: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-vault-')));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-base-'));
  cleanup.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  return { root, base };
}

/** Every entry under `root`, recursively, relative to it — used to assert a rejected
 *  machine-local folder never got created inside the vault. */
async function everythingUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out;
}

describe('F1: BRAINSTEM_STATE_HOME must never resolve inside the vault', () => {
  it('exits 1, names BRAINSTEM_STATE_HOME, and creates nothing inside the vault', async () => {
    const { root } = await freshDirs();
    const stateHome = path.join(root, 'state-home'); // inside the vault, on purpose
    const result = await runToExit(
      { BRAINSTEM_STATE_HOME: stateHome, BRAINSTEM_CACHE_HOME: path.join(os.tmpdir(), 'unused') },
      root,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BRAINSTEM_STATE_HOME');
    expect(result.stderr).toContain('inside');
    expect(await everythingUnder(root)).toEqual([]);
  }, 20_000);

  it('(reverse) exits 1 when the vault itself resolves inside the state base', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-base-'));
    const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'vault-')));
    cleanup.push(async () => {
      await fs.rm(base, { recursive: true, force: true });
    });
    const result = await runToExit(
      { BRAINSTEM_STATE_HOME: base, BRAINSTEM_CACHE_HOME: path.join(os.tmpdir(), 'unused') },
      root,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BRAINSTEM_STATE_HOME');
  }, 20_000);
});

describe('F1: STATE_DIR — the exception is exactly <vault>/_brainstem, nothing else inside the vault', () => {
  it('refuses a STATE_DIR inside the vault that is not exactly _brainstem', async () => {
    const { root } = await freshDirs();
    const stateDir = path.join(root, '_brainstem', 'not-the-reserved-spot');
    const result = await runToExit(
      { STATE_DIR: stateDir, BRAINSTEM_CACHE_HOME: path.join(os.tmpdir(), 'unused') },
      root,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('STATE_DIR');
    expect(result.stderr).toContain('_brainstem');
    expect(await everythingUnder(root)).toEqual([]);
  }, 20_000);

  it('still allows STATE_DIR set to exactly <vault>/_brainstem', async () => {
    const { root } = await freshDirs();
    const stateDir = path.join(root, '_brainstem');
    const client = new Client(
      { name: 'f1-exception-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_MAIN, '--vault', root],
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          BRAINSTEM_CACHE_HOME: path.join(os.tmpdir(), 'unused-f1-cache'),
        },
        stderr: 'pipe',
      }),
    );
    cleanup.push(() => client.close());
    const ping = await client.callTool({ name: 'brainstem_ping', arguments: {} });
    expect(ping.isError).toBeFalsy();
  }, 20_000);
});

describe('F1: BRAINSTEM_CACHE_HOME inside the vault disables the cache but never fails the boot', () => {
  it('warns once and runs without a cache; creates nothing inside the vault', async () => {
    const { root } = await freshDirs();
    const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-state-'));
    cleanup.push(async () => {
      await fs.rm(stateHome, { recursive: true, force: true });
    });
    const cacheHome = path.join(root, 'cache-home'); // inside the vault, on purpose

    const client = new Client(
      { name: 'f1-cache-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', root],
      env: { ...process.env, BRAINSTEM_STATE_HOME: stateHome, BRAINSTEM_CACHE_HOME: cacheHome },
      stderr: 'pipe',
    });
    let err = '';
    transport.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    await until(() => err.includes('stdio server ready'));

    expect(err).toContain('running without an index cache');
    expect(err).toContain('BRAINSTEM_CACHE_HOME');
    const ping = await client.callTool({ name: 'brainstem_ping', arguments: {} });
    expect(ping.isError).toBeFalsy();
    // Nothing under cache-home/ was ever created inside the vault (the folder itself may or may
    // not exist depending on how far resolution got, but it must hold nothing).
    await expect(fs.readdir(cacheHome).catch(() => [])).resolves.toEqual([]);
  }, 20_000);

  it('(reverse) disables the cache when the vault resolves inside the cache base', async () => {
    const cacheBase = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-cbase-'));
    const root = await fs.realpath(await fs.mkdtemp(path.join(cacheBase, 'vault-')));
    const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-f1-state-'));
    cleanup.push(async () => {
      await fs.rm(cacheBase, { recursive: true, force: true });
      await fs.rm(stateHome, { recursive: true, force: true });
    });

    const client = new Client(
      { name: 'f1-cache-reverse-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', root],
      env: { ...process.env, BRAINSTEM_STATE_HOME: stateHome, BRAINSTEM_CACHE_HOME: cacheBase },
      stderr: 'pipe',
    });
    let err = '';
    transport.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    await until(() => err.includes('stdio server ready'));
    expect(err).toContain('running without an index cache');
  }, 20_000);
});
