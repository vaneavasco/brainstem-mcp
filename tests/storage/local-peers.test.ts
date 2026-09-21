import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTANCE_HEARTBEAT_MS, INSTANCE_STALE_MS } from '../../src/storage/limits.ts';
import {
  listOtherLivePeers,
  type RegisteredInstance,
  registerInstance,
  unregisterInstance,
} from '../../src/storage/local-peers.ts';

let stateDir: string;
// Every registerInstance() call in this file is tracked here and its heartbeat stopped in
// afterEach — the timer is unref'd (never keeps the process alive on its own) but a test run
// that never stops it would still pile up live intervals across dozens of tests.
let handles: RegisteredInstance[] = [];

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-local-peers-'));
  handles = [];
});

afterEach(async () => {
  for (const h of handles) h.stopHeartbeat();
  handles = [];
  await fs.rm(stateDir, { recursive: true, force: true });
});

/** Wraps `registerInstance` so every call in this file is tracked for heartbeat cleanup. */
async function register(
  info: Parameters<typeof registerInstance>[1],
  deps: Parameters<typeof registerInstance>[2] = {},
): Promise<RegisteredInstance> {
  const h = await registerInstance(stateDir, info, deps);
  handles.push(h);
  return h;
}

async function instancesFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(stateDir, 'instances'))).sort();
  } catch {
    return [];
  }
}

describe('registerInstance / unregisterInstance', () => {
  it('writes <stateDir>/instances/<pid>.json, mode 0600', async () => {
    await register({ pid: 4242, startedAt: '2026-09-21T00:00:00.000Z', version: '0.6.0' });
    const file = path.join(stateDir, 'instances', '4242.json');
    const stat = await fs.stat(file);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(record).toEqual({ pid: 4242, startedAt: '2026-09-21T00:00:00.000Z', version: '0.6.0' });
  });

  it('writes atomically: via a unique tmp name, renamed into place — no tmp file left behind', async () => {
    const writeCalls: string[] = [];
    const realWriteFile = fs.writeFile;
    await register(
      { pid: 4343, startedAt: 't', version: 'v' },
      {
        writeFile: (async (p: string, data: string, opts: unknown) => {
          writeCalls.push(String(p));
          return realWriteFile(p, data, opts as never);
        }) as typeof fs.writeFile,
      },
    );
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).not.toBe(path.join(stateDir, 'instances', '4343.json')); // via a tmp name
    expect(await instancesFiles()).toEqual(['4343.json']); // no leftover tmp file
  });

  it('removes its own file on unregister, best-effort when already gone', async () => {
    await register({ pid: 111, startedAt: 't', version: 'v' });
    expect(await instancesFiles()).toEqual(['111.json']);
    await unregisterInstance(stateDir, 111);
    expect(await instancesFiles()).toEqual([]);
    await expect(unregisterInstance(stateDir, 111)).resolves.toBeUndefined(); // no throw twice
  });

  it('F5: the heartbeat re-writes (touches) the instance file, refreshing its mtime', async () => {
    const handle = await register({ pid: 4444, startedAt: 't', version: 'v' }, { heartbeatMs: 30 });
    const file = path.join(stateDir, 'instances', '4444.json');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 250));
    handle.stopHeartbeat();
    const after = (await fs.stat(file)).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it('F5: stopHeartbeat() stops further touches', async () => {
    const handle = await register({ pid: 4545, startedAt: 't', version: 'v' }, { heartbeatMs: 30 });
    handle.stopHeartbeat();
    const file = path.join(stateDir, 'instances', '4545.json');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
    const after = (await fs.stat(file)).mtimeMs;
    expect(after).toBe(before);
  });
});

describe('listOtherLivePeers', () => {
  it('returns [] when the instances folder does not exist yet', async () => {
    expect(await listOtherLivePeers(stateDir, process.pid)).toEqual([]);
  });

  it('excludes the caller’s own pid and returns other alive ones', async () => {
    await register({ pid: process.pid, startedAt: 't1', version: 'v' });
    await register({
      pid: 999_999, // treated as alive via the injected probe below
      startedAt: 't2',
      version: 'v',
    });
    const others = await listOtherLivePeers(stateDir, process.pid, {
      isAlive: (pid) => pid === process.pid || pid === 999_999,
    });
    expect(others).toEqual([{ pid: 999_999, startedAt: 't2', version: 'v' }]);
  });

  it('prunes (deletes) an entry whose pid is not alive, and does not count it', async () => {
    const deadPid = 123_456;
    await register({ pid: deadPid, startedAt: 't', version: 'v' });
    expect(await instancesFiles()).toEqual([`${deadPid}.json`]);

    const others = await listOtherLivePeers(stateDir, process.pid, {
      isAlive: (pid) => pid !== deadPid,
    });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]); // the stale file was pruned
  });

  it('F5: pid alive but the file is older than INSTANCE_STALE_MS — not a peer, and pruned', async () => {
    const pid = 234_567;
    await register({ pid, startedAt: 't', version: 'v' });
    const file = path.join(stateDir, 'instances', `${pid}.json`);
    const old = new Date(Date.now() - INSTANCE_STALE_MS - 1000);
    await fs.utimes(file, old, old);

    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]);
  });

  it('F5: pid alive and the file is fresh — counted as a peer', async () => {
    const pid = 234_568;
    await register({ pid, startedAt: 't', version: 'v' });
    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([{ pid, startedAt: 't', version: 'v' }]);
  });

  it('F5: an unparseable entry YOUNGER than the heartbeat grace period is neither counted nor deleted', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    const file = path.join(stateDir, 'instances', '55.json');
    await fs.writeFile(file, 'not json{{{'); // fresh mtime — "just written"
    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual(['55.json']); // left alone, not pruned
  });

  it('F5: an unparseable entry OLDER than the heartbeat grace period is pruned', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    const file = path.join(stateDir, 'instances', '56.json');
    await fs.writeFile(file, 'not json{{{');
    const old = new Date(Date.now() - INSTANCE_HEARTBEAT_MS - 1000);
    await fs.utimes(file, old, old);
    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]);
  });

  it('F5: a directory named like an entry is left alone while young, removed once older than INSTANCE_STALE_MS', async () => {
    const dirLikeEntry = path.join(stateDir, 'instances', '999.json');
    await fs.mkdir(dirLikeEntry, { recursive: true });
    await fs.writeFile(path.join(dirLikeEntry, 'inner.txt'), 'hi');

    // Young: left alone.
    let others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toContain('999.json');

    // Old: removed (recursively — it's a directory, not a plain file).
    const old = new Date(Date.now() - INSTANCE_STALE_MS - 1000);
    await fs.utimes(dirLikeEntry, old, old);
    others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).not.toContain('999.json');
  });

  it('F5: a symlinked entry is unlinked once stale — its target is never touched', async () => {
    if (process.platform === 'win32') return; // symlink creation needs elevated rights on win32
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-peers-target-'));
    const targetFile = path.join(targetDir, 'real.json');
    await fs.writeFile(
      targetFile,
      JSON.stringify({ pid: process.pid, startedAt: 't', version: 'v' }),
    );
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    const linkPath = path.join(stateDir, 'instances', '111.json');
    await fs.symlink(targetFile, linkPath);
    const old = new Date(Date.now() - INSTANCE_STALE_MS - 1000);
    await fs.lutimes(linkPath, old, old);

    try {
      const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
      expect(others).toEqual([]);
      await expect(fs.lstat(linkPath)).rejects.toThrow(); // the symlink itself is gone
      await expect(fs.stat(targetFile)).resolves.toBeDefined(); // its target is untouched
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });

  it('F5: the mid-write race — a reader running alongside many concurrent registers never deletes a live, young, unparseable-looking file', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    // Simulates the exact symptom atomic writes are meant to prevent (a reader catching a
    // half-written file) as a second line of defense: even if a file DOES show up unparseable
    // and fresh, the young-grace-period rule alone must keep a concurrent scan from deleting it.
    const partialFile = path.join(stateDir, 'instances', '77.json');
    await fs.writeFile(partialFile, '{"pid": 77, "started'); // deliberately truncated JSON

    const scans = Array.from({ length: 200 }, () =>
      listOtherLivePeers(stateDir, process.pid, { isAlive: () => true }),
    );
    await Promise.all(scans);
    await expect(fs.stat(partialFile)).resolves.toBeDefined(); // never deleted — still young
  });

  it('F5: caps one scan at INSTANCE_SCAN_MAX entries and logs once when the cap is hit', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    const cap = 5;
    for (let i = 0; i < cap + 3; i += 1) {
      await fs.writeFile(
        path.join(stateDir, 'instances', `${1000 + i}.json`),
        JSON.stringify({ pid: 1000 + i, startedAt: 't', version: 'v' }),
      );
    }
    const capped: Array<{ dir: string; cap: number }> = [];
    const others = await listOtherLivePeers(stateDir, process.pid, {
      isAlive: () => true,
      scanMax: cap,
      onScanCapped: (info) => capped.push(info),
    });
    expect(others.length).toBeLessThanOrEqual(cap);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.cap).toBe(cap);
  });

  it('prunes a corrupt/unparsable instance file once it is no longer young', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    const file = path.join(stateDir, 'instances', '55.json');
    await fs.writeFile(file, 'not json{{{');
    const old = new Date(Date.now() - INSTANCE_HEARTBEAT_MS - 1000);
    await fs.utimes(file, old, old);
    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]);
  });

  it('is safe to call repeatedly (used both at boot and on every brainstem_ping)', async () => {
    await register({ pid: process.pid, startedAt: 't', version: 'v' });
    await register({ pid: 555, startedAt: 't', version: 'v' });
    const probe = { isAlive: (pid: number) => pid === process.pid || pid === 555 };
    expect((await listOtherLivePeers(stateDir, process.pid, probe)).length).toBe(1);
    expect((await listOtherLivePeers(stateDir, process.pid, probe)).length).toBe(1);
  });
});
