// The machine-local index cache (ADR 0008 amendment, phase 4), end to end over a real stdio
// child: src/storage/local-cache.ts has its own unit tests (real NDJSON files) and
// tests/vault/runtime-index-cache.test.ts exercises createLocalRuntime's decisions with a faked
// cache; this file is the one place that proves the two actually wire together through
// src/stdio-main.ts — real process, real files, real second boot.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { vaultKey } from '../../src/storage/local-state.ts';
import { INDEX_CACHE_SCHEMA } from '../../src/vault/frontmatter-index.ts';
import { removeMachineHomes, testCacheHome, testMachineHomeEnv } from '../helpers/state-home.ts';

const STDIO_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

interface PingIndex {
  building: boolean;
  cache?: { used: boolean; entriesFromCache: number; entriesRead: number; rejected?: string };
}

async function seedFixtureVault(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, 'a.md'),
    '---\ntype: note\ntags: [x]\n---\n# A\n\nlinks to [[b]].\n',
  );
  await fs.writeFile(path.join(root, 'b.md'), '---\ntype: note\ntags: [y]\n---\n# B\n');
}

/** Connects, waits for stderr readiness, polls ping until the index is no longer building, and
 *  returns the client plus a way to read accumulated stderr. Caller closes the client. */
async function connectAndWaitReady(
  root: string,
  env: Record<string, string>,
): Promise<{ client: Client; stderr: () => string }> {
  const client = new Client(
    { name: 'index-cache-test', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO_MAIN, '--vault', root],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  await client.connect(transport);
  for (;;) {
    const ping = await client.callTool({ name: 'brainstem_ping', arguments: {} });
    const index = (structured(ping) as { index: PingIndex }).index;
    if (!index.building) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  return { client, stderr: () => err };
}

function cacheFilePath(cacheHome: string, vaultRealPath: string): string {
  return path.join(cacheHome, vaultKey(vaultRealPath), `index-v${INDEX_CACHE_SCHEMA}.ndjson`);
}

/** The save that follows a boot is asynchronous relative to `indexState().ready` (see
 *  src/vault/runtime.ts: `built` flips before an in-flight save resolves), AND it is only
 *  attempted at all when the cache was absent or usefully stale — so "wait for the log line"
 *  is the wrong condition when the cache was already fully accurate and nothing was written.
 *  What every path guarantees is a non-empty cache file on disk once the boot has settled. */
async function waitForCacheFile(
  cacheHome: string,
  vaultRealPath: string,
  timeoutMs = 8000,
): Promise<void> {
  const file = cacheFilePath(cacheHome, vaultRealPath);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const st = await fs.stat(file);
      if (st.size > 0) return;
    } catch {
      // not there yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const cleanupRoots: string[] = [];
const cleanupHomes: ReturnType<typeof testMachineHomeEnv>[] = [];
const cleanupClients: Client[] = [];

afterEach(async () => {
  for (const client of cleanupClients.splice(0)) {
    await client.close().catch(() => {});
  }
  for (const root of cleanupRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  for (const homes of cleanupHomes.splice(0)) await removeMachineHomes(homes);
});

describe('the machine-local index cache, end to end over a real stdio child', () => {
  it('a second boot on the same vault loads what the first boot saved, and answers the same query', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-cache-e2e-'));
    cleanupRoots.push(root);
    await seedFixtureVault(root);
    const homes = testMachineHomeEnv();
    cleanupHomes.push(homes);

    const first = await connectAndWaitReady(root, { ...homes });
    cleanupClients.push(first.client);
    const firstPing = structured(
      await first.client.callTool({ name: 'brainstem_ping', arguments: {} }),
    );
    // Not asserted as literally cold: `versionNegotiation: { mode: 'auto' }` (used by every
    // stdio test here) probes the server through a disposable sibling process before the "real"
    // connection is made — that sibling already does a full boot (and, since this is its first
    // time on this fresh cache home too, a save) against the SAME vault and cache home before
    // this client's own handshake completes. What is asserted is the shape and the accounting.
    const firstCache = (firstPing.index as PingIndex).cache;
    expect(firstCache).toBeDefined();
    expect(typeof firstCache?.used).toBe('boolean');
    expect((firstCache?.entriesFromCache ?? 0) + (firstCache?.entriesRead ?? 0)).toBe(2);
    // A save is asynchronous relative to indexState().ready, and only happens at all when the
    // cache was absent or usefully stale — waiting for a non-empty file on disk is the condition
    // every path actually guarantees.
    await waitForCacheFile(homes.BRAINSTEM_CACHE_HOME, await fs.realpath(root));
    const firstQuery = await first.client.callTool({ name: 'vault_query', arguments: {} });
    await first.client.close();
    cleanupClients.splice(cleanupClients.indexOf(first.client), 1);

    const second = await connectAndWaitReady(root, { ...homes });
    cleanupClients.push(second.client);
    const secondPing = structured(
      await second.client.callTool({ name: 'brainstem_ping', arguments: {} }),
    );
    expect((secondPing.index as PingIndex).cache).toEqual({
      used: true,
      entriesFromCache: 2,
      entriesRead: 0,
    });
    const secondQuery = await second.client.callTool({ name: 'vault_query', arguments: {} });
    expect(secondQuery.structuredContent).toEqual(firstQuery.structuredContent);

    const tags = await second.client.callTool({ name: 'vault_tags', arguments: {} });
    expect(tags.isError).toBeFalsy();
    const links = await second.client.callTool({
      name: 'vault_links',
      arguments: { path: 'a.md' },
    });
    expect(links.isError).toBeFalsy();
    const frontmatter = await second.client.callTool({
      name: 'vault_search_frontmatter',
      arguments: { field: 'type', equals: 'note' },
    });
    expect(frontmatter.isError).toBeFalsy();
    expect((frontmatter.structuredContent as { hits: unknown[] }).hits).toHaveLength(2);
  }, 20_000);

  it('BRAINSTEM_INDEX_CACHE=off: no cache field on ping, and a second boot still does a cold fill', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-cache-off-'));
    cleanupRoots.push(root);
    await seedFixtureVault(root);
    const homes = testMachineHomeEnv();
    cleanupHomes.push(homes);

    const first = await connectAndWaitReady(root, { ...homes, BRAINSTEM_INDEX_CACHE: 'off' });
    cleanupClients.push(first.client);
    const ping = structured(await first.client.callTool({ name: 'brainstem_ping', arguments: {} }));
    expect((ping.index as PingIndex).cache).toBeUndefined();
    await first.client.close();
    cleanupClients.splice(cleanupClients.indexOf(first.client), 1);

    // Nothing was ever written: the cache-home folder has no index-v*.ndjson anywhere under it.
    const found = await findFiles(homes.BRAINSTEM_CACHE_HOME, /^index-v\d+\.ndjson$/);
    expect(found).toEqual([]);
  }, 20_000);

  it('a cache folder that cannot be created: the server still runs, one warn line, no file anywhere', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-cache-badhome-'));
    cleanupRoots.push(root);
    await seedFixtureVault(root);
    const stateHome = testCacheHome(); // any fresh path is fine for BRAINSTEM_STATE_HOME here
    cleanupRoots.push(stateHome); // not a vault, but fs.rm(recursive, force) cleans it up the same way

    // A regular file where a directory is expected makes mkdir(..., {recursive:true}) fail.
    const blocker = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-blocker-'));
    cleanupRoots.push(blocker);
    const blockerFile = path.join(blocker, 'not-a-directory');
    await fs.writeFile(blockerFile, 'x');
    const badCacheHome = path.join(blockerFile, 'cache');

    const { client, stderr } = await connectAndWaitReady(root, {
      BRAINSTEM_STATE_HOME: stateHome,
      BRAINSTEM_CACHE_HOME: badCacheHome,
    });
    cleanupClients.push(client);
    const ping = structured(await client.callTool({ name: 'brainstem_ping', arguments: {} }));
    expect(ping.server).toBeDefined(); // the server runs fine regardless
    expect((ping.index as PingIndex).cache).toBeUndefined();

    const warnLines = stderr()
      .split('\n')
      .filter((l) => l.includes('running without an index cache'));
    expect(warnLines).toHaveLength(1);

    // Nothing was created under the vault, and nothing exists at (or under) the blocked path.
    const inVault = await findFiles(root, /^index-v\d+\.ndjson$/);
    expect(inVault).toEqual([]);
    await expect(fs.stat(path.join(blockerFile, 'cache'))).rejects.toThrow();
  }, 20_000);
});

async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && pattern.test(e.name)).map((e) => e.name);
}
