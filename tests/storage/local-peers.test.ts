import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listOtherLivePeers,
  registerInstance,
  unregisterInstance,
} from '../../src/storage/local-peers.ts';

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-local-peers-'));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function instancesFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(stateDir, 'instances'))).sort();
  } catch {
    return [];
  }
}

describe('registerInstance / unregisterInstance', () => {
  it('writes <stateDir>/instances/<pid>.json, mode 0600', async () => {
    await registerInstance(stateDir, {
      pid: 4242,
      startedAt: '2026-09-21T00:00:00.000Z',
      version: '0.6.0',
    });
    const file = path.join(stateDir, 'instances', '4242.json');
    const stat = await fs.stat(file);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(record).toEqual({ pid: 4242, startedAt: '2026-09-21T00:00:00.000Z', version: '0.6.0' });
  });

  it('removes its own file on unregister, best-effort when already gone', async () => {
    await registerInstance(stateDir, { pid: 111, startedAt: 't', version: 'v' });
    expect(await instancesFiles()).toEqual(['111.json']);
    await unregisterInstance(stateDir, 111);
    expect(await instancesFiles()).toEqual([]);
    await expect(unregisterInstance(stateDir, 111)).resolves.toBeUndefined(); // no throw twice
  });
});

describe('listOtherLivePeers', () => {
  it('returns [] when the instances folder does not exist yet', async () => {
    expect(await listOtherLivePeers(stateDir, process.pid)).toEqual([]);
  });

  it('excludes the caller’s own pid and returns other alive ones', async () => {
    await registerInstance(stateDir, { pid: process.pid, startedAt: 't1', version: 'v' });
    await registerInstance(stateDir, {
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
    await registerInstance(stateDir, { pid: deadPid, startedAt: 't', version: 'v' });
    expect(await instancesFiles()).toEqual([`${deadPid}.json`]);

    const others = await listOtherLivePeers(stateDir, process.pid, {
      isAlive: (pid) => pid !== deadPid,
    });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]); // the stale file was pruned
  });

  it('prunes a corrupt/unparsable instance file', async () => {
    await fs.mkdir(path.join(stateDir, 'instances'), { recursive: true });
    await fs.writeFile(path.join(stateDir, 'instances', '55.json'), 'not json{{{');
    const others = await listOtherLivePeers(stateDir, process.pid, { isAlive: () => true });
    expect(others).toEqual([]);
    expect(await instancesFiles()).toEqual([]);
  });

  it('is safe to call repeatedly (used both at boot and on every brainstem_ping)', async () => {
    await registerInstance(stateDir, { pid: process.pid, startedAt: 't', version: 'v' });
    await registerInstance(stateDir, { pid: 555, startedAt: 't', version: 'v' });
    const probe = { isAlive: (pid: number) => pid === process.pid || pid === 555 };
    expect((await listOtherLivePeers(stateDir, process.pid, probe)).length).toBe(1);
    expect((await listOtherLivePeers(stateDir, process.pid, probe)).length).toBe(1);
  });
});
