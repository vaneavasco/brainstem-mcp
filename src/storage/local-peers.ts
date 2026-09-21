import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  INSTANCE_HEARTBEAT_MS,
  INSTANCE_SCAN_CONCURRENCY,
  INSTANCE_SCAN_MAX,
  INSTANCE_STALE_MS,
} from './limits.ts';

/**
 * Several stdio servers on one vault, on one machine, are normal (every Claude Code session
 * starts its own). This tracks them at `<stateDir>/instances/<pid>.json` so each process can
 * tell the owner how many others are around — reads stay safe on their own, and a colliding
 * write becomes a CONFLICT (`expectedHash`) instead of a lost write; nothing here enforces that,
 * it only reports it.
 *
 * F5: an instance file is written atomically (a unique tmp name in the same dir, renamed into
 * place) and re-written (heartbeated) every `INSTANCE_HEARTBEAT_MS` so a live process's file
 * never looks stale; `listOtherLivePeers` treats an entry as a live peer only when its pid is
 * alive AND its file's mtime is younger than `INSTANCE_STALE_MS` — the portable defence against
 * pid reuse (a crashed server's pid picked up by an unrelated process stops counting once its
 * instance file ages out, instead of forever).
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
  rename?: typeof fs.rename;
  lstat?: typeof fs.lstat;
  unlink?: typeof fs.unlink;
  /** Epoch milliseconds "now" — defaults to `Date.now()`; injectable for deterministic staleness
   *  tests. */
  now?(): number;
  /** Overrides `INSTANCE_STALE_MS` (tests only). */
  staleMs?: number;
  /** Overrides `INSTANCE_HEARTBEAT_MS` — both the re-write interval in `registerInstance` and the
   *  young-unparseable grace period in `listOtherLivePeers` (tests only). */
  heartbeatMs?: number;
  /** Overrides `INSTANCE_SCAN_MAX` (tests only). */
  scanMax?: number;
  /** Overrides `INSTANCE_SCAN_CONCURRENCY` (tests only). */
  scanConcurrency?: number;
  /** Called at most once per `listOtherLivePeers` call, only when the directory held more
   *  entries than the scan cap. Logging only — a listener that throws is swallowed. */
  onScanCapped?(info: { dir: string; cap: number }): void;
}

/** Returned by `registerInstance`: stops the heartbeat timer. Call this during shutdown, before
 *  or alongside `unregisterInstance` — the timer is unref'd (never keeps the process alive on its
 *  own), but a long-lived process should still stop it once it's no longer needed. */
export interface RegisteredInstance {
  stopHeartbeat(): void;
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

function isTmpEntryName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.tmp');
}

/** Writes (or re-writes) `<stateDir>/instances/<pid>.json` atomically: a unique tmp name in the
 *  same directory, then a rename — a reader can only ever see the complete old content or the
 *  complete new content, never a half-written file. */
async function writeInstanceFileAtomic(
  stateDir: string,
  info: InstanceRecord,
  deps: PeerDeps,
): Promise<void> {
  const mkdir = deps.mkdir ?? fs.mkdir;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const rename = deps.rename ?? fs.rename;
  const dir = instancesDir(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${info.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, instanceFile(stateDir, info.pid));
}

/** Writes this process's own `instances/<pid>.json` at boot (mode 0600, atomically — see
 *  `writeInstanceFileAtomic`), then keeps re-writing it every `INSTANCE_HEARTBEAT_MS` on an
 *  unref'd timer so `listOtherLivePeers` never mistakes a live, merely-idle process for a stale
 *  one. Returns a handle to stop that timer (call it on shutdown). */
export async function registerInstance(
  stateDir: string,
  info: InstanceRecord,
  deps: PeerDeps = {},
): Promise<RegisteredInstance> {
  await writeInstanceFileAtomic(stateDir, info, deps);
  const heartbeatMs = deps.heartbeatMs ?? INSTANCE_HEARTBEAT_MS;
  const timer = setInterval(() => {
    void writeInstanceFileAtomic(stateDir, info, deps).catch(() => {
      // best effort — a transient failure just means this tick's touch is skipped; the next one
      // tries again, and a genuinely gone stateDir is the caller's problem to notice elsewhere
    });
  }, heartbeatMs);
  timer.unref();
  return { stopHeartbeat: () => clearInterval(timer) };
}

/** Removes this process's own instance file, best-effort, on clean shutdown. Does not stop any
 *  heartbeat timer — call `RegisteredInstance.stopHeartbeat()` for that (typically right before
 *  this, in the same shutdown sequence). */
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

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}

/**
 * Reads `<stateDir>/instances/`, prunes what's clearly no longer live, and returns the still-live
 * entries other than `selfPid` — the live "local peers" of this stdio process on this vault, on
 * this machine.
 *
 * F5 pruning rules, checked with bounded concurrency (`INSTANCE_SCAN_CONCURRENCY`) over at most
 * `INSTANCE_SCAN_MAX` entries (logged once, via `onScanCapped`, when the directory holds more):
 * - a tmp file (mid-write by some process's `registerInstance`/heartbeat) is never parsed and is
 *   removed only once older than `INSTANCE_STALE_MS` — younger, it's simply ignored;
 * - a directory or other non-regular entry is `lstat`-ed first (never followed if it's a
 *   symlink) and removed only once older than `INSTANCE_STALE_MS`: a directory recursively, a
 *   symlink by unlinking just the link, never touching whatever it points at;
 * - an entry that fails to parse as JSON — or parses but isn't shaped like an `InstanceRecord` —
 *   younger than `INSTANCE_HEARTBEAT_MS` is left alone (neither counted nor deleted: it may be
 *   mid-write by an older, non-atomic-writing version); at or past that age, it's pruned;
 * - a parseable entry is a live peer only when its pid is alive AND its file's mtime is younger
 *   than `INSTANCE_STALE_MS`; otherwise it's pruned (dead pid at any age; stale mtime even for an
 *   alive pid — a heartbeat that's merely running very late is not distinguishable from one that
 *   has stopped, and three heartbeats' worth of margin is already generous).
 *
 * Used both once at boot (to log a summary line) and on every `brainstem_ping` call, so the count
 * is never stale: two processes started minutes apart still see each other the moment both are
 * up, and a process that exited cleanly (or whose pid died) stops being counted the next time
 * either remaining process calls this.
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
  const lstat = deps.lstat ?? fs.lstat;
  const unlink = deps.unlink ?? fs.unlink;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const now = deps.now ?? ((): number => Date.now());
  const staleMs = deps.staleMs ?? INSTANCE_STALE_MS;
  const youngGraceMs = deps.heartbeatMs ?? INSTANCE_HEARTBEAT_MS;
  const scanMax = deps.scanMax ?? INSTANCE_SCAN_MAX;
  const scanConcurrency = deps.scanConcurrency ?? INSTANCE_SCAN_CONCURRENCY;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  if (entries.length > scanMax) {
    entries = entries.slice(0, scanMax);
    try {
      deps.onScanCapped?.({ dir, cap: scanMax });
    } catch {
      // logging must not break the scan
    }
  }

  const others: InstanceRecord[] = [];
  await mapWithConcurrency(entries, scanConcurrency, async (name) => {
    const full = path.join(dir, name);

    if (isTmpEntryName(name)) {
      try {
        const st = await lstat(full);
        if (now() - st.mtimeMs > staleMs) await rm(full, { force: true });
      } catch {
        // a race with the writer that owns it, or it's already gone
      }
      return;
    }

    if (!name.endsWith('.json')) return;
    const pidFromName = Number.parseInt(name.slice(0, -'.json'.length), 10);

    let lst: Awaited<ReturnType<typeof lstat>>;
    try {
      lst = await lstat(full);
    } catch {
      return; // gone by the time we looked
    }

    if (lst.isSymbolicLink()) {
      if (now() - lst.mtimeMs > staleMs) await unlink(full).catch(() => {});
      return;
    }
    if (!lst.isFile()) {
      // a directory (or another non-regular entry) named like an instance file
      if (now() - lst.mtimeMs > staleMs) {
        await rm(full, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }

    let record: InstanceRecord | null = null;
    try {
      record = parseInstance(await readFile(full, 'utf8'));
    } catch {
      record = null;
    }

    const ageMs = now() - lst.mtimeMs;
    if (record === null) {
      // Unparseable: possibly mid-write by an older, non-atomic-writing version. Young → leave
      // it alone entirely; old → it's had a full heartbeat interval to resolve itself and hasn't.
      if (ageMs > youngGraceMs) await rm(full, { force: true }).catch(() => {});
      return;
    }

    const pid = Number.isInteger(record.pid) ? record.pid : pidFromName;
    const alive = Number.isInteger(pid) && isAlive(pid);
    const stale = ageMs > staleMs;
    if (!alive || stale) {
      await rm(full, { force: true }).catch(() => {});
      return;
    }
    if (pid !== selfPid) others.push(record);
  });

  return others;
}
