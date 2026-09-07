import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import { RESERVED_DIR } from '../../storage/path-policy.ts';
import type { ComposeRunner } from '../docker.ts';
import { parseEnv, upsertEnv } from '../env-file.ts';
import { samePath, type VaultPathContext, validateVaultPath } from '../vault-path.ts';
import { parseComposePs } from './status.ts';

const STATE_FILE = 'state.json';

export interface VaultShowDeps {
  env: Map<string, string>;
  print(l: string): void;
}

/** Prints the vault the instance is configured for (`VAULT_PATH` from `.env`). */
export function runVaultShow(deps: VaultShowDeps): number {
  const vaultPath = deps.env.get('VAULT_PATH') ?? '';
  if (vaultPath === '') {
    deps.print('VAULT_PATH is not set — run ./brainstem setup');
    return 1;
  }
  deps.print(vaultPath);
  return 0;
}

export interface VaultSetArgs {
  path: string;
}

export interface VaultSetDeps {
  envPath: string;
  vaultCtx: VaultPathContext;
  compose: ComposeRunner;
  readFile(p: string): Promise<string | null>;
  writeFile(p: string, text: string): Promise<void>;
  /** `./brainstem down` / `./brainstem up`, injected so the switch can be tested without Docker. */
  down(): Promise<number>;
  up(): Promise<number>;
  print(l: string): void;
}

async function containersRunning(compose: ComposeRunner): Promise<boolean> {
  if (!(await compose.available())) return false;
  const result = await compose.run(['ps', '--format', 'json'], { capture: true });
  return parseComposePs(result.stdout).size > 0;
}

/**
 * Points the instance at another vault: validates the folder like `setup`
 * does, rewrites ONLY `VAULT_PATH` in `.env` (unlike `setup --force`, which
 * also rotates the owner secret), pre-creates `_brainstem/` there, and
 * carries `_brainstem/state.json` over from the previous vault so the
 * clients already connected keep working — each vault has its own auth
 * state, and a client only ever holds the token the *last* vault issued.
 *
 * A running instance is stopped first (nothing may write the state file
 * while it is copied) and started again afterwards. Under `TUNNEL_MODE=quick`
 * that restart hands out a new public URL, as any restart does.
 */
export async function runVaultSet(args: VaultSetArgs, deps: VaultSetDeps): Promise<number> {
  const envText = await deps.readFile(deps.envPath);
  if (envText === null) {
    deps.print('.env not found — run `./brainstem setup` first');
    return 1;
  }

  const verdict = await validateVaultPath(args.path, deps.vaultCtx);
  if (!verdict.ok) {
    deps.print(verdict.error);
    return 1;
  }
  for (const warning of verdict.warnings) deps.print(`Warning: ${warning}`);

  const mod = deps.vaultCtx.platform === 'win32' ? pathWin32 : pathPosix;
  const current = parseEnv(envText).get('VAULT_PATH') ?? '';
  if (current !== '' && samePath(mod.normalize(current), verdict.path, deps.vaultCtx.platform)) {
    deps.print(`VAULT_PATH already points to ${verdict.path}`);
    return 0;
  }

  const wasRunning = await containersRunning(deps.compose);
  if (wasRunning) {
    deps.print('Stopping brainstem-mcp before switching vaults…');
    if ((await deps.down()) !== 0) {
      deps.print('could not stop the containers — VAULT_PATH left unchanged');
      return 1;
    }
  }

  const { text } = upsertEnv(envText, { VAULT_PATH: verdict.path }, { onlyIfEmpty: false });
  await deps.writeFile(deps.envPath, text);
  // Same reason as in setup: create the reserved folder as the host user so
  // Docker never has to, which could leave it root-owned and unwritable.
  await deps.writeFile(mod.join(verdict.path, RESERVED_DIR, '.gitkeep'), '');
  deps.print(`set VAULT_PATH=${verdict.path}`);

  if (current !== '') {
    const state = await deps.readFile(mod.join(current, RESERVED_DIR, STATE_FILE));
    if (state !== null) {
      await deps.writeFile(mod.join(verdict.path, RESERVED_DIR, STATE_FILE), state);
      deps.print(
        `copied ${RESERVED_DIR}/${STATE_FILE} from ${current} — connected clients stay connected`,
      );
    }
  }

  if (wasRunning) return deps.up();
  deps.print('Next: ./brainstem up');
  return 0;
}
