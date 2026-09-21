import { randomBytes } from 'node:crypto';
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
