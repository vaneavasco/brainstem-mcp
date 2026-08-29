import path from 'node:path';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import { RESERVED_DIR } from '../../storage/path-policy.ts';
import { parseEnv, upsertEnv } from '../env-file.ts';
import { suggestVaultPaths, type VaultPathContext, validateVaultPath } from '../vault-path.ts';

export interface SetupIO {
  prompt(
    question: string,
    opts: { default?: string; validate?: (v: string) => Promise<string | true> },
  ): Promise<string>;
  confirm(q: string, def: boolean): Promise<boolean>;
  select<T extends string>(q: string, choices: Array<{ value: T; name: string }>): Promise<T>;
  print(line: string): void;
}

export interface SetupDeps {
  cwd: string;
  io: SetupIO;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number | undefined;
  gid: number | undefined;
  readFile(p: string): Promise<string | null>;
  writeFile(p: string, text: string): Promise<void>;
  vaultCtx: VaultPathContext;
  randomSecret(): string;
  timezone(): string;
}

export interface SetupArgs {
  vault?: string;
  tunnelToken?: string;
  publicUrl?: string;
  force?: boolean;
  showSecret?: boolean;
}

type TunnelMode = 'cloudflare' | 'quick' | 'none';

const OWNER_SECRET_KEY = 'OWNER_SECRET';

/** `https://` only, no path/query/fragment (bare origin). */
function isBarePublicUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' && (u.pathname === '' || u.pathname === '/') && !u.search && !u.hash
    );
  } catch {
    return false;
  }
}

async function resolveVaultPath(args: SetupArgs, deps: SetupDeps): Promise<string> {
  if (args.vault !== undefined) {
    const verdict = await validateVaultPath(args.vault, deps.vaultCtx);
    if (!verdict.ok) throw new Error(verdict.error);
    for (const w of verdict.warnings) deps.io.print(`warning: ${w}`);
    return verdict.path;
  }

  const suggestions = await suggestVaultPaths(deps.vaultCtx.home, async (p) => {
    const { promises: fs } = await import('node:fs');
    return fs.readdir(p);
  }).catch(() => [] as string[]);

  const answer = await deps.io.prompt('Path to your Obsidian vault', {
    default: suggestions[0],
    validate: async (v) => {
      const verdict = await validateVaultPath(v, deps.vaultCtx);
      return verdict.ok ? true : verdict.error;
    },
  });
  const verdict = await validateVaultPath(answer, deps.vaultCtx);
  if (!verdict.ok) throw new Error(verdict.error);
  for (const w of verdict.warnings) deps.io.print(`warning: ${w}`);
  return verdict.path;
}

async function resolveTunnel(
  args: SetupArgs,
  deps: SetupDeps,
): Promise<{ mode: TunnelMode; values: Record<string, string> }> {
  const useCloudflare = args.tunnelToken
    ? true
    : await deps.io.confirm(
        'Do you have a Cloudflare tunnel token? (stable URL, recommended)',
        false,
      );

  if (useCloudflare) {
    const token =
      args.tunnelToken ??
      (await deps.io.prompt('Cloudflare tunnel token', {
        validate: async (v) => (v.trim() !== '' ? true : 'a Cloudflare tunnel token is required'),
      }));

    let publicUrl = args.publicUrl;
    if (publicUrl !== undefined) {
      if (!isBarePublicUrl(publicUrl)) {
        throw new Error('--public-url must be an https:// URL with no path, query, or fragment');
      }
    } else {
      publicUrl = await deps.io.prompt('Public URL for the tunnel (https://..., no path)', {
        validate: async (v) =>
          isBarePublicUrl(v) ? true : 'must be an https:// URL with no path, query, or fragment',
      });
    }

    return {
      mode: 'cloudflare',
      values: {
        TUNNEL_MODE: 'cloudflare',
        TUNNEL_TOKEN: token,
        PUBLIC_URL: publicUrl,
        PUBLIC_URL_FILE: '',
        ALLOW_INSECURE_PUBLIC_URL: 'false',
      },
    };
  }

  const choice = await deps.io.select<'quick' | 'none'>('Tunnel mode', [
    { value: 'quick', name: 'Quick tunnel — random URL each start, no account needed' },
    { value: 'none', name: 'None — Claude Code / localhost only' },
  ]);

  if (choice === 'quick') {
    return {
      mode: 'quick',
      values: {
        TUNNEL_MODE: 'quick',
        TUNNEL_TOKEN: '',
        PUBLIC_URL: '',
        PUBLIC_URL_FILE: '/vault/_brainstem/public-url',
        ALLOW_INSECURE_PUBLIC_URL: 'false',
      },
    };
  }

  return {
    mode: 'none',
    values: {
      TUNNEL_MODE: 'none',
      TUNNEL_TOKEN: '',
      PUBLIC_URL: 'http://localhost:3000',
      PUBLIC_URL_FILE: '',
      ALLOW_INSECURE_PUBLIC_URL: 'true',
    },
  };
}

/**
 * Creates or updates `.env` from `.env.example` (or a pre-existing `.env`):
 * fills `OWNER_SECRET` and `VAULT_PATH` when empty, walks the tunnel-mode
 * questions (spec §5), and sets host-specific defaults. Every key except the
 * tunnel-mode set is left alone if already non-empty, unless `--force`.
 */
export async function runSetup(args: SetupArgs, deps: SetupDeps): Promise<void> {
  const envPath = path.join(deps.cwd, '.env');
  const examplePath = path.join(deps.cwd, '.env.example');

  const existing = await deps.readFile(envPath);
  const templateText = existing ?? (await deps.readFile(examplePath));
  if (templateText === null) {
    throw new Error(`no .env or .env.example found in ${deps.cwd}`);
  }

  const vaultPath = await resolveVaultPath(args, deps);
  const tunnel = await resolveTunnel(args, deps);

  const values: Record<string, string> = {
    [OWNER_SECRET_KEY]: deps.randomSecret(),
    VAULT_PATH: vaultPath,
    VAULT_TIMEZONE: deps.timezone(),
  };
  if (deps.platform === 'linux') {
    values.HOST_UID = deps.uid !== undefined ? String(deps.uid) : '';
    values.HOST_GID = deps.gid !== undefined ? String(deps.gid) : '';
  } else {
    values.VAULT_WATCH_POLL_MS = '2000';
  }

  const force = args.force ?? false;
  const afterMain = upsertEnv(templateText, values, { onlyIfEmpty: !force });
  const afterTunnel = upsertEnv(afterMain.text, tunnel.values, { onlyIfEmpty: false });

  await deps.writeFile(envPath, afterTunnel.text);

  // Pre-create <vault>/_brainstem (owned by the host user running setup) so
  // Docker never has to create it itself — which, depending on how the
  // container starts, could leave it owned by root and unwritable by the
  // HOST_UID-mapped app user.
  const vaultPathMod = deps.platform === 'win32' ? pathWin32 : pathPosix;
  await deps.writeFile(vaultPathMod.join(vaultPath, RESERVED_DIR, '.gitkeep'), '');

  const finalEnv = parseEnv(afterTunnel.text);
  const describe = (key: string): string => {
    if (key === OWNER_SECRET_KEY && !args.showSecret) return key;
    return `${key}=${finalEnv.get(key) ?? ''}`;
  };
  for (const key of [...afterMain.changed, ...afterTunnel.changed]) {
    deps.io.print(`set ${describe(key)}`);
  }
  for (const key of [...afterMain.kept, ...afterTunnel.kept]) {
    deps.io.print(`kept ${describe(key)}`);
  }

  deps.io.print(`Vault: ${vaultPath}`);
  deps.io.print(`Tunnel mode: ${tunnel.mode}`);
  if (tunnel.mode === 'quick') {
    deps.io.print(
      'Note: the connector URL changes on every restart — see `_brainstem/connection.md` ' +
        'in your vault; for a stable URL rerun `npm run setup -- --tunnel-token …`.',
    );
  }
  deps.io.print('Next: npm run up');
}
