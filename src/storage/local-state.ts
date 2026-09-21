import { randomBytes } from 'node:crypto';
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
  writeFile(p: string, data: string, opts?: { mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface LocalStateDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir(): string;
  fs: LocalStateFsDeps;
  now?(): Date;
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
 *  rewrites it, so `createdAt` really is when the folder was first used for this vault. Best
 *  effort: a failure here (an unwritable folder squeezed in between `mkdir` and this call, say)
 *  never fails vault resolution — the marker is a convenience, not load-bearing. */
async function writeVaultMarkerIfMissing(
  dir: string,
  vaultRealPath: string,
  deps: LocalStateDeps,
): Promise<void> {
  const mod = pathModule(deps.platform);
  const file = mod.join(dir, 'vault.json');
  try {
    await deps.fs.stat(file);
    return; // already there
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
 * Resolves (and creates, mode 0700) the machine-local state folder for the vault at `vaultPath`:
 * `<base>/<first 16 hex of sha256(realpath(vaultPath))>/`. Two spellings or symlinks of the same
 * vault (a relative path, a symlink, a different-cased drive letter on Windows) resolve to the
 * same folder because the hash is taken over the realpath, not the input string.
 *
 * Never falls back to the vault itself or to the OS temp dir when the base directory cannot be
 * created or is not writable — callers (the stdio entrypoint) must treat `ok: false` as fatal.
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

  const hash = sha256hex(vaultRealPath).slice(0, 16);
  const mod = pathModule(deps.platform);
  const dir = mod.join(base.dir, hash);

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
