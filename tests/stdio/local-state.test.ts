// ADR 0008 amendment (2026-09-21): the stdio server's transaction journal — and, later, its index
// cache — live in a machine-local folder keyed by the vault's real path, never inside the vault.
// `_brainstem/instructions.md` is vault content and keeps travelling with the vault regardless.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import { removeMachineHomes, testMachineHomeEnv } from '../helpers/state-home.ts';
import { STDIO_ENTRY as STDIO_MAIN } from '../helpers/stdio-entry.ts';

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function localFolderFor(stateHome: string, vaultRealPath: string): string {
  return path.join(stateHome, sha256hex(vaultRealPath).slice(0, 16));
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function untilLocalPeers(client: Client, expected: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ping = await client.callTool({ name: 'brainstem_ping', arguments: {} });
    const peers = (structured(ping) as { localPeers?: number }).localPeers;
    if (peers === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for localPeers=${expected}; last saw ${peers}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Session {
  client: Client;
  root: string;
  stateHome: string;
  close(): Promise<void>;
}

async function start(env: Record<string, string> = {}): Promise<Session> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-ls-')));
  const homes = testMachineHomeEnv();
  const client = new Client(
    { name: 'local-state-test', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', root],
      env: { ...process.env, ...homes, ...env },
      stderr: 'pipe',
    }),
  );
  return {
    client,
    root,
    stateHome: homes.BRAINSTEM_STATE_HOME,
    async close() {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
      await removeMachineHomes(homes);
    },
  };
}

describe('the stdio server keeps its own working state on the machine, not in the vault', () => {
  it('journals a vault_transaction under the machine-local folder; the vault gets no _brainstem/tx, but instructions.md is still seeded there', async () => {
    const s = await start();
    try {
      const written = await s.client.callTool({
        name: 'vault_write',
        arguments: { path: 'a.md', content: '# A\n' },
      });
      expect(written.isError).toBeFalsy();

      const tx = await s.client.callTool({
        name: 'vault_transaction',
        arguments: { ops: [{ op: 'write', path: 'a.md', content: '# A2\n' }] },
      });
      expect(tx.isError).toBeFalsy();
      expect(structured(tx).applied).toBe(true);

      // No transaction journal ever touched the vault.
      await expect(fs.stat(path.join(s.root, '_brainstem', 'tx'))).rejects.toThrow();
      // The owner's instructions template IS still seeded, in the vault, as before this feature.
      const instrStat = await fs.stat(path.join(s.root, '_brainstem', 'instructions.md'));
      expect(instrStat.isFile()).toBe(true);

      // The machine-local folder is where the journal machinery actually ran: `tx/` was created
      // (by runTransaction's `fs.mkdir(journalDir, { recursive: true })`) and is now empty again
      // (the one committed transaction's own subfolder was removed after it settled).
      const localDir = localFolderFor(s.stateHome, s.root);
      const txEntries = await fs.readdir(path.join(localDir, 'tx'));
      expect(txEntries).toEqual([]);
      const marker = JSON.parse(await fs.readFile(path.join(localDir, 'vault.json'), 'utf8'));
      expect(marker.vaultPath).toBe(s.root);
    } finally {
      await s.close();
    }
  });

  it('STATE_DIR still overrides where the journal lives (today’s override keeps working)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-ls-override-'));
    const homes = testMachineHomeEnv();
    const overrideDir = path.join(root, '_brainstem'); // vault-local, exactly the pre-feature spot
    const client = new Client(
      { name: 'override-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [STDIO_MAIN, '--vault', root],
          env: { ...process.env, ...homes, STATE_DIR: overrideDir },
          stderr: 'pipe',
        }),
      );
      await client.callTool({ name: 'vault_write', arguments: { path: 'a.md', content: '# A\n' } });
      const tx = await client.callTool({
        name: 'vault_transaction',
        arguments: { ops: [{ op: 'write', path: 'a.md', content: '# A2\n' }] },
      });
      expect(tx.isError).toBeFalsy();
      // Ran under the override, not under BRAINSTEM_STATE_HOME.
      const txEntries = await fs.readdir(path.join(overrideDir, 'tx'));
      expect(txEntries).toEqual([]);
      const localHash = sha256hex(await fs.realpath(root)).slice(0, 16);
      await expect(fs.stat(path.join(homes.BRAINSTEM_STATE_HOME, localHash))).rejects.toThrow();
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
      await removeMachineHomes(homes);
    }
  });

  it('prunes a stale instances/<pid>.json of a dead pid at boot', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-ls-stale-')));
    const homes = testMachineHomeEnv();
    const localDir = localFolderFor(homes.BRAINSTEM_STATE_HOME, root);
    await fs.mkdir(path.join(localDir, 'instances'), { recursive: true });
    // Far past any real pid on Linux (pid_max is at most a few million) — if this ever collided
    // with a live process the assertion below would only be too strict, never silently wrong.
    const deadPid = 999_999_999;
    const staleFile = path.join(localDir, 'instances', `${deadPid}.json`);
    await fs.writeFile(
      staleFile,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), version: '0.0.0' }),
    );

    const client = new Client(
      { name: 'stale-prune-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [STDIO_MAIN, '--vault', root],
          env: { ...process.env, ...homes },
          stderr: 'pipe',
        }),
      );
      await expect(fs.stat(staleFile)).rejects.toThrow();
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
      await removeMachineHomes(homes);
    }
  });
});

describe('journals left inside the vault by an older session or by the HTTP server', () => {
  it('are reported at boot (only reported), although this server journals elsewhere', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-ls-old-')));
    const homes = testMachineHomeEnv();
    const old = path.join(root, '_brainstem', 'tx', 'tx-left-behind');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, 'manifest.json'), JSON.stringify({ state: 'applying' }));
    const client = new Client(
      { name: 'old-journal-test', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', root],
      env: { ...process.env, ...homes },
      stderr: 'pipe',
    });
    let err = '';
    transport.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    try {
      await client.connect(transport);
      await until(() => err.includes('stdio server ready'));
      expect(err).toContain('transaction journal left behind');
      expect(err).toContain('tx-left-behind');
      await expect(fs.stat(path.join(old, 'manifest.json'))).resolves.toBeDefined(); // untouched
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
      await removeMachineHomes(homes);
    }
  });
});

describe('several stdio processes on one vault, on one machine, are normal', () => {
  const cleanupChildren: Client[] = [];
  afterEach(async () => {
    while (cleanupChildren.length > 0) {
      await cleanupChildren
        .pop()
        ?.close()
        .catch(() => {});
    }
  });

  it('the second process logs a peers line, and both report localPeers correctly as they start and stop', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-ls-peers-')));
    const homes = testMachineHomeEnv();
    try {
      const transportA = new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_MAIN, '--vault', root],
        env: { ...process.env, ...homes },
        stderr: 'pipe',
      });
      let errA = '';
      transportA.stderr?.on('data', (d: Buffer) => {
        errA += d.toString();
      });
      const clientA = new Client(
        { name: 'peer-a', version: '0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await clientA.connect(transportA);
      cleanupChildren.push(clientA);
      const pingA1 = await clientA.callTool({ name: 'brainstem_ping', arguments: {} });
      expect(structured(pingA1).localPeers).toBe(0);
      // Let A's boot fully settle (past its own registerInstance + first peer scan) before
      // spawning B: starting a second stdio child within milliseconds of the first was found, by
      // hand, to occasionally make the MCP client SDK abandon and respawn its transport under
      // this test's tight timing — a client-side retry, not a vault-state issue (the respawned
      // process's own boot and shutdown behaved correctly either way) — so this avoids racing it.
      await until(() => errA.includes('stdio server ready'));

      const transportB = new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_MAIN, '--vault', root],
        env: { ...process.env, ...homes },
        stderr: 'pipe',
      });
      let errB = '';
      transportB.stderr?.on('data', (d: Buffer) => {
        errB += d.toString();
      });
      const clientB = new Client(
        { name: 'peer-b', version: '0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await clientB.connect(transportB);
      cleanupChildren.push(clientB);

      await untilLocalPeers(clientA, 1);
      await untilLocalPeers(clientB, 1);
      expect(errB).toContain('already running on this vault on this machine');
      expect(errB).toContain('CONFLICT');

      // A's shutdown (stdin closing) is asynchronous from clientA.close() resolving, so B's view
      // of the peers folder is polled until A's clean-shutdown removal of its own instance file
      // catches up.
      await clientA.close();
      cleanupChildren.splice(cleanupChildren.indexOf(clientA), 1);
      await untilLocalPeers(clientB, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await removeMachineHomes(homes);
    }
  }, 20_000);
});
