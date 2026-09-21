import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Several stdio servers on one vault, on one machine, are normal (every Claude Code session
 * starts its own). This tracks them at `<stateDir>/instances/<pid>.json` so each process can
 * tell the owner how many others are around — reads stay safe on their own, and a colliding
 * write becomes a CONFLICT (`expectedHash`) instead of a lost write; nothing here enforces that,
 * it only reports it.
 */

export interface InstanceRecord {
  pid: number;
  startedAt: string;
  version: string;
}

export interface PeerDeps {
  /** `process.kill(pid, 0)` by default — true if a process with that pid exists (whether or not
   *  we could signal it), false if it's gone. Injectable so tests can fake a dead pid without
   *  actually starting and killing a real process. */
  isAlive?(pid: number): boolean;
  readdir?: typeof fs.readdir;
  readFile?: typeof fs.readFile;
  rm?: typeof fs.rm;
  writeFile?: typeof fs.writeFile;
  mkdir?: typeof fs.mkdir;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function instancesDir(stateDir: string): string {
  return path.join(stateDir, 'instances');
}

function instanceFile(stateDir: string, pid: number): string {
  return path.join(instancesDir(stateDir), `${pid}.json`);
}

/** Writes this process's own `instances/<pid>.json` at boot (mode 0600). */
export async function registerInstance(
  stateDir: string,
  info: InstanceRecord,
  deps: PeerDeps = {},
): Promise<void> {
  const mkdir = deps.mkdir ?? fs.mkdir;
  const writeFile = deps.writeFile ?? fs.writeFile;
  await mkdir(instancesDir(stateDir), { recursive: true, mode: 0o700 });
  await writeFile(instanceFile(stateDir, info.pid), `${JSON.stringify(info, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Removes this process's own instance file, best-effort, on clean shutdown. */
export async function unregisterInstance(
  stateDir: string,
  pid: number,
  deps: PeerDeps = {},
): Promise<void> {
  const rm = deps.rm ?? fs.rm;
  try {
    await rm(instanceFile(stateDir, pid), { force: true });
  } catch {
    // best effort: a leftover file is pruned by the next boot's scan anyway
  }
}

function parseInstance(text: string): InstanceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof (parsed as Partial<InstanceRecord>).pid === 'number' &&
    typeof (parsed as Partial<InstanceRecord>).startedAt === 'string' &&
    typeof (parsed as Partial<InstanceRecord>).version === 'string'
  ) {
    return parsed as InstanceRecord;
  }
  return null;
}

/**
 * Reads `<stateDir>/instances/`, deletes (best-effort) any entry whose pid is not alive or whose
 * file is unreadable/corrupt, and returns the still-alive entries other than `selfPid` — the
 * live "local peers" of this stdio process on this vault, on this machine.
 *
 * Used both once at boot (to log a summary line) and on every `brainstem_ping` call, so the
 * count is never stale: two processes started minutes apart still see each other the moment
 * both are up, and a process that exited cleanly (or whose pid died) stops being counted the
 * next time either remaining process calls this.
 */
export async function listOtherLivePeers(
  stateDir: string,
  selfPid: number,
  deps: PeerDeps = {},
): Promise<InstanceRecord[]> {
  const dir = instancesDir(stateDir);
  const readdir = deps.readdir ?? fs.readdir;
  const readFile = deps.readFile ?? fs.readFile;
  const rm = deps.rm ?? fs.rm;
  const isAlive = deps.isAlive ?? defaultIsAlive;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const others: InstanceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    const pidFromName = Number.parseInt(entry.slice(0, -'.json'.length), 10);
    let record: InstanceRecord | null = null;
    try {
      record = parseInstance(await readFile(file, 'utf8'));
    } catch {
      record = null;
    }
    const pid = record?.pid ?? pidFromName;
    const stale = record === null || !Number.isInteger(pid) || !isAlive(pid);
    if (stale) {
      try {
        await rm(file, { force: true });
      } catch {
        // best effort — the next scan will try again
      }
      continue;
    }
    if (pid !== selfPid && record) others.push(record);
  }
  return others;
}
