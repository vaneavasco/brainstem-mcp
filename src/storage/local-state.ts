import { randomBytes } from 'node:crypto';
import type { PlatformPath } from 'node:path';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import { sha256hex } from '../auth/hash.ts';

/**
 * Where the stdio server keeps state that must NOT travel with the vault (the transaction
 * journal today; the index cache in phase 4) — a vault may live in git or in a folder synced
 * across machines, and neither wants a machine-bound cache or a journal of in-flight edits.
 * The HTTP server is unaffected: it keeps everything under `<vault>/_brainstem/` (tokens, the
 * owner's instructions) because that state is meant to travel with the vault.
 *
 * Deps are injected (`env`, `platform`, `homedir`, `fs`) so path resolution is testable per
 * platform without touching the real filesystem or `$HOME`.
 */

export interface LocalStateFsDeps {
  mkdir(p: string, opts: { recursive: true; mode?: number }): Promise<string | undefined>;
  realpath(p: string): Promise<string>;
  /** Only used to check whether `vault.json` already exists — never reads its contents. Any
   *  settled promise means "exists"; any rejection means "does not exist (or unreadable)". */
  stat(p: string): Promise<unknown>;
  /** Reads `vault.json` when it already exists, to check it still names this vault (see
   *  `LocalStateDeps.onVaultMismatch`) — never used to decide whether to write it. */
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string, opts?: { mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface LocalStateDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir(): string;
  fs: LocalStateFsDeps;
  now?(): Date;
  /** Called at most once, when `<dir>/vault.json` already exists and its `vaultPath` names a
   *  different vault than the one being resolved now (the same machine-local folder was reused —
   *  possible only via a manual `BRAINSTEM_STATE_HOME`/`STATE_DIR`, since the default folder is
   *  keyed by the vault's own hash). The file is only ever read here, never rewritten: whoever is
   *  right, silently overwriting the marker would just hide the mix-up. Logging is the caller's
   *  job (`src/stdio-main.ts`); this module stays logger-agnostic. */
  onVaultMismatch?(info: { file: string; recorded: string; actual: string }): void;
}

export type LocalStateResult =
  | { ok: true; dir: string; vaultRealPath: string }
  | { ok: false; error: string };

function pathModule(platform: NodeJS.Platform): typeof pathPosix | typeof pathWin32 {
  return platform === 'win32' ? pathWin32 : pathPosix;
}

/** `~/Library/Application Support/brainstem` (macOS), `%LOCALAPPDATA%\brainstem\State` (or
 *  `~/AppData/Local/brainstem/State` when that env var is unset — Windows), otherwise
 *  `$XDG_STATE_HOME/brainstem` or `~/.local/state/brainstem` (Linux and everything else). */
function defaultBaseDir(deps: Pick<LocalStateDeps, 'platform' | 'env' | 'homedir'>): string {
  const mod = pathModule(deps.platform);
  const home = deps.homedir();
  if (deps.platform === 'darwin') {
    return mod.join(home, 'Library', 'Application Support', 'brainstem');
  }
  if (deps.platform === 'win32') {
    const localAppData = deps.env.LOCALAPPDATA;
    return localAppData
      ? mod.join(localAppData, 'brainstem', 'State')
      : mod.join(home, 'AppData', 'Local', 'brainstem', 'State');
  }
  const xdgStateHome = deps.env.XDG_STATE_HOME;
  return xdgStateHome
    ? mod.join(xdgStateHome, 'brainstem')
    : mod.join(home, '.local', 'state', 'brainstem');
}

/** The 16-hex key every per-vault machine-local folder is named after: the first 16 hex
 *  characters of the SHA-256 of the vault's *real* (symlink-resolved) path. Shared by the state
 *  folder (this module) and the index cache folder (`src/storage/local-cache.ts`) so the two
 *  never drift apart on how a vault is identified — exported here, reused there, never
 *  recomputed with different logic. */
export function vaultKey(vaultRealPath: string): string {
  return sha256hex(vaultRealPath).slice(0, 16);
}

/** The base directory every vault's local-state folder lives under: `BRAINSTEM_STATE_HOME` when
 *  set (must be absolute), otherwise the per-platform default above. Exported on its own so
 *  `./brainstem doctor`/`status` can show it without resolving a vault. */
export function resolveBaseStateDir(
  deps: Pick<LocalStateDeps, 'platform' | 'env' | 'homedir'>,
): { ok: true; dir: string } | { ok: false; error: string } {
  const override = deps.env.BRAINSTEM_STATE_HOME;
  if (override !== undefined && override !== '') {
    const mod = pathModule(deps.platform);
    if (!mod.isAbsolute(override)) {
      return {
        ok: false,
        error: `BRAINSTEM_STATE_HOME must be an absolute path, got "${override}"`,
      };
    }
    return { ok: true, dir: override };
  }
  return { ok: true, dir: defaultBaseDir(deps) };
}

/** Writes `<dir>/vault.json` once (atomic tmp+rename, 0600) so a person looking at the local
 *  state folder can tell which vault it belongs to. A no-op once the file exists — this never
 *  rewrites it, so `createdAt` really is when the folder was first used for this vault; when the
 *  existing file names a *different* vault (F7 — only reachable through a manual override, the
 *  default folder is keyed by the vault's own hash), `onVaultMismatch` is told, once, and the
 *  file is still left exactly as it was. Best effort otherwise: a failure writing it (an
 *  unwritable folder squeezed in between `mkdir` and this call, say) never fails vault resolution
 *  — the marker is a convenience, not load-bearing. */
async function writeVaultMarkerIfMissing(
  dir: string,
  vaultRealPath: string,
  deps: LocalStateDeps,
): Promise<void> {
  const mod = pathModule(deps.platform);
  const file = mod.join(dir, 'vault.json');
  try {
    await deps.fs.stat(file);
    try {
      const recorded = (JSON.parse(await deps.fs.readFile(file)) as { vaultPath?: unknown })
        .vaultPath;
      if (typeof recorded === 'string' && recorded !== vaultRealPath) {
        deps.onVaultMismatch?.({ file, recorded, actual: vaultRealPath });
      }
    } catch {
      // unreadable or not JSON — nothing to compare, and never a reason to fail resolution
    }
    return; // already there — never rewritten either way
  } catch {
    // fall through and create it
  }
  const now = deps.now ?? ((): Date => new Date());
  const body = `${JSON.stringify({ vaultPath: vaultRealPath, createdAt: now().toISOString() }, null, 2)}\n`;
  const tmp = mod.join(dir, `.vault.json.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await deps.fs.writeFile(tmp, body, { mode: 0o600 });
    await deps.fs.rename(tmp, file);
  } catch {
    // best effort, see above
  }
}

/**
 * Resolves the realpath of as much of `p` as exists yet, and appends whatever doesn't (a
 * machine-local folder is often resolved before it has ever been created). Equivalent to Python's
 * non-strict `realpath`: walk up to the nearest existing ancestor, resolve that, then rejoin the
 * missing tail verbatim — nothing below a path that does not exist yet can be a symlink, so the
 * tail needs no resolving. Exported for `src/storage/local-cache.ts` and `src/stdio-main.ts` (the
 * override branch), which face the identical problem.
 */
export async function realpathOrClosestAncestor(
  p: string,
  realpath: (p: string) => Promise<string>,
  mod: PlatformPath,
): Promise<string> {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? mod.join(real, ...tail) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const parent = mod.dirname(current);
      if (parent === current) throw error; // reached the root and it still doesn't resolve
      tail.unshift(mod.basename(current));
      current = parent;
    }
  }
}

function normalizeForCompare(p: string, mod: PlatformPath, platform: NodeJS.Platform): string {
  const n = mod.normalize(p);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** Exact match once both sides are normalized/case-folded for the platform. */
export function pathsEqual(
  a: string,
  b: string,
  mod: PlatformPath,
  platform: NodeJS.Platform,
): boolean {
  return normalizeForCompare(a, mod, platform) === normalizeForCompare(b, mod, platform);
}

function isInsideOrEqual(
  child: string,
  parent: string,
  mod: PlatformPath,
  platform: NodeJS.Platform,
): boolean {
  const c = normalizeForCompare(child, mod, platform);
  const p = normalizeForCompare(parent, mod, platform);
  if (c === p) return true;
  const withSep = p.endsWith(mod.sep) ? p : p + mod.sep;
  return c.startsWith(withSep);
}

/** True when `a` and `b` are the same folder, or either is inside the other — the containment
 *  check F1 needs both ways: a machine-local folder placed inside the vault, and (the "reverse")
 *  a vault placed inside a machine-local base directory. */
export function pathsAreRelated(
  a: string,
  b: string,
  mod: PlatformPath,
  platform: NodeJS.Platform,
): boolean {
  return isInsideOrEqual(a, b, mod, platform) || isInsideOrEqual(b, a, mod, platform);
}

/**
 * Resolves (and creates, mode 0700) the machine-local state folder for the vault at `vaultPath`:
 * `<base>/<first 16 hex of sha256(realpath(vaultPath))>/`. Two spellings or symlinks of the same
 * vault (a relative path, a symlink, a different-cased drive letter on Windows) resolve to the
 * same folder because the hash is taken over the realpath, not the input string.
 *
 * Never falls back to the vault itself or to the OS temp dir when the base directory cannot be
 * created or is not writable — callers (the stdio entrypoint) must treat `ok: false` as fatal.
 *
 * F1: refuses (before creating anything) a resolved folder that is inside, equal to, or an
 * ancestor of the vault — tools would otherwise list, read and search the server's own working
 * state. There is no exception here (unlike the stdio entrypoint's `STATE_DIR` override branch,
 * which allows exactly `<vault>/_brainstem`): this is the default, hash-keyed folder, which has no
 * legitimate reason to ever land inside a vault.
 */
export async function resolveLocalStateDir(
  vaultPath: string,
  deps: LocalStateDeps,
): Promise<LocalStateResult> {
  const base = resolveBaseStateDir(deps);
  if (!base.ok) return base;

  let vaultRealPath: string;
  try {
    vaultRealPath = await deps.fs.realpath(vaultPath);
  } catch (error) {
    return {
      ok: false,
      error: `could not resolve the vault path "${vaultPath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const hash = vaultKey(vaultRealPath);
  const mod = pathModule(deps.platform);
  const dir = mod.join(base.dir, hash);

  // Checked against the BASE, not the per-vault hashed folder: `dir` is always `base.dir/hash`,
  // a fixed descendant of `base.dir`, so this single check against the base covers both
  // directions at once — the base (and therefore `dir`) landing inside the vault, and the
  // "reverse", the vault landing inside the base (e.g. BRAINSTEM_STATE_HOME pointed at the
  // vault's own parent folder) — a case `dir` alone, being a sibling of the vault under a shared
  // base, would miss entirely.
  const baseReal = await realpathOrClosestAncestor(base.dir, deps.fs.realpath, mod);
  if (pathsAreRelated(baseReal, vaultRealPath, mod, deps.platform)) {
    return {
      ok: false,
      error:
        `the machine-local state folder "${dir}" is inside (or equal to) the vault "${vaultRealPath}" ` +
        '— tools would list, read and search the server’s own working state; set ' +
        'BRAINSTEM_STATE_HOME to a folder outside the vault',
    };
  }

  try {
    await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      error:
        `could not create the local state folder "${dir}" — set BRAINSTEM_STATE_HOME to a ` +
        `writable path to override where it lives: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }

  await writeVaultMarkerIfMissing(dir, vaultRealPath, deps);

  return { ok: true, dir, vaultRealPath };
}
