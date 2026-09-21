import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fresh, not-yet-created path for `BRAINSTEM_STATE_HOME` — every test that spawns a real stdio
 * child (`src/stdio-main.ts`) MUST set this in the child's env, or the server falls back to the
 * developer's real machine-local state folder (`~/.local/state/brainstem` and friends) and writes
 * into it. Synchronous and side-effect-free: the stdio server itself creates the folder (mode
 * 0700) the first time it needs it. Callers remove it afterward, typically alongside whatever
 * vault temp dir they already clean up:
 *
 *   const stateHome = testStateHome();
 *   const child = spawn(process.execPath, [STDIO_MAIN, '--vault', root], {
 *     env: { ...process.env, BRAINSTEM_STATE_HOME: stateHome },
 *   });
 *   // ...
 *   await fs.rm(stateHome, { recursive: true, force: true });
 */
export function testStateHome(): string {
  return path.join(
    os.tmpdir(),
    `brainstem-state-home-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
}

/** Same as `testStateHome`, for `BRAINSTEM_CACHE_HOME` (the machine-local index cache — see
 *  `src/storage/local-cache.ts`). A separate function, not the same path re-used: the state and
 *  cache folders are deliberately two different directories, under two different env vars, even
 *  though both are "machine-local, keyed by vault". */
export function testCacheHome(): string {
  return path.join(
    os.tmpdir(),
    `brainstem-cache-home-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
}

/**
 * Both machine-local homes a real stdio child needs, in one call, so no spawn site can set one
 * and forget the other: EVERY test that starts `src/stdio-main.ts` as a child process MUST spread
 * this into its env, or the server falls back to the developer's real
 * `~/.local/state/brainstem` and `~/.cache/brainstem` (or platform equivalents) and writes into
 * them.
 *
 *   const homes = testMachineHomeEnv();
 *   const child = spawn(process.execPath, [STDIO_MAIN, '--vault', root], {
 *     env: { ...process.env, ...homes },
 *   });
 *   // ...
 *   await removeMachineHomes(homes);
 */
export interface TestMachineHomeEnv {
  BRAINSTEM_STATE_HOME: string;
  BRAINSTEM_CACHE_HOME: string;
}

export function testMachineHomeEnv(): TestMachineHomeEnv {
  return { BRAINSTEM_STATE_HOME: testStateHome(), BRAINSTEM_CACHE_HOME: testCacheHome() };
}

/** Removes both folders a `testMachineHomeEnv()` may have created on disk; force+recursive, so it
 *  is safe to call even when the child never got far enough to create one of them (a vault-path
 *  failure exits before the cache folder is ever touched, say). */
export async function removeMachineHomes(homes: TestMachineHomeEnv): Promise<void> {
  await Promise.all([
    fs.rm(homes.BRAINSTEM_STATE_HOME, { recursive: true, force: true }),
    fs.rm(homes.BRAINSTEM_CACHE_HOME, { recursive: true, force: true }),
  ]);
}
