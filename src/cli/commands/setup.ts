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
  select<T extends string>(
    q: string,
    choices: Array<{ value: T; name: string }>,
    opts?: { default?: T },
  ): Promise<T>;
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
  /**
   * Probed only for tunnel mode (Docker + Cloudflare tunnel + OAuth): local
   * (stdio) mode needs no Docker at all, so it never calls this.
   */
  dockerAvailable(): Promise<boolean>;
}

/**
 * How Claude will reach this vault: `local` (stdio, this machine only — Claude
 * Code / Claude Desktop start the server themselves, no Docker, no secret, no
 * tunnel) or `tunnel` (today's Docker + Cloudflare tunnel + OAuth flow).
 */
export type SetupMode = 'local' | 'tunnel';

export interface SetupArgs {
  mode?: SetupMode;
  vault?: string;
  tunnelToken?: string;
  publicUrl?: string;
  force?: boolean;
  showSecret?: boolean;
  /**
   * Print the closing `Next: ./brainstem up` line (default `true`). `start`
   * passes `false`: it runs `up` itself the moment setup returns, so telling
   * the user to run it is wrong there. Local mode never prints it — there is
   * no Docker step to run next.
   */
  printNext?: boolean;
}

type TunnelMode = 'cloudflare' | 'quick' | 'none';

const OWNER_SECRET_KEY = 'OWNER_SECRET';
const TUNNEL_TOKEN_KEY = 'TUNNEL_TOKEN';
const VAULT_PATH_KEY = 'VAULT_PATH';

/**
 * Same wording the launchers (`brainstem`, `brainstem.cmd`) print when Docker
 * is missing. They used to gate every command, `setup` included, on Docker
 * before delegating to this CLI at all; they no longer do for `setup` (local
 * mode needs none), so the tunnel branch here checks first instead — the
 * same fail-fast a Docker-less user saw before, with the same message.
 */
function dockerRequiredMessage(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Docker Desktop is required: https://docs.docker.com/desktop/'
    : 'Docker is required. Install Docker Desktop (https://docs.docker.com/desktop/) or ' +
        'Docker Engine + Compose v2.';
}

/** Asks first, always: how will Claude reach this vault? */
async function resolveMode(args: SetupArgs, deps: SetupDeps): Promise<SetupMode> {
  if (args.mode !== undefined) return args.mode;
  return deps.io.select<SetupMode>(
    'How will Claude reach this vault?',
    [
      {
        value: 'local',
        name: 'Locally on this machine (Claude Code / Claude Desktop, over stdio)',
      },
      { value: 'tunnel', name: 'From claude.ai, through a tunnel' },
    ],
    // Non-interactive with no --mode: today's only mode, so existing scripts
    // and callers that predate --mode see no change in behaviour.
    { default: 'tunnel' },
  );
}

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

/** Absolute path to the launcher script for this platform, next to `.env`. */
function launcherPathOf(deps: SetupDeps): string {
  const mod = deps.platform === 'win32' ? pathWin32 : pathPosix;
  const name = deps.platform === 'win32' ? 'brainstem.cmd' : 'brainstem';
  return mod.join(deps.cwd, name);
}

/** A path is safe to paste unquoted into a shell command example only when every character is
 *  one of these; anything else (a space, an apostrophe, …) needs quoting. */
const SHELL_SAFE_PATH_CHARS = /^[A-Za-z0-9_./:\\-]+$/;

/**
 * Quotes a path for the `claude mcp add …` example line printed by local setup, so it can be
 * pasted as a single argument: POSIX single quotes, escaping an embedded `'` as `'\''` (closing
 * the quote, an escaped literal quote, reopening it); Windows double quotes, doubling an embedded
 * `"` (cmd.exe's own escape for a literal quote inside a quoted argument). A path with nothing
 * outside SHELL_SAFE_PATH_CHARS is returned unchanged — most vault paths never need this.
 */
export function quotePathForShellExample(p: string, platform: NodeJS.Platform): string {
  if (SHELL_SAFE_PATH_CHARS.test(p)) return p;
  if (platform === 'win32') return `"${p.replace(/"/g, '""')}"`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Local (stdio) mode: Claude Code / Claude Desktop start the server
 * themselves on this machine, over stdin/stdout — no Docker, no owner
 * secret, no tunnel. Asks only for the vault folder and writes `VAULT_PATH`
 * into `.env`; every other key an install may already carry (from a prior
 * tunnel-mode setup, since one install can be used both ways) is left
 * exactly as it was.
 */
async function runLocalSetup(args: SetupArgs, deps: SetupDeps, envPath: string): Promise<void> {
  const vaultPath = await resolveVaultPath(args, deps);

  const existingText = (await deps.readFile(envPath)) ?? '';
  const existingKeys = [...parseEnv(existingText).keys()].filter((k) => k !== VAULT_PATH_KEY);

  const { text, removedDuplicates } = upsertEnv(
    existingText,
    { [VAULT_PATH_KEY]: vaultPath },
    { onlyIfEmpty: false },
  );
  await deps.writeFile(envPath, text);

  deps.io.print(`set ${VAULT_PATH_KEY}=${vaultPath}`);
  for (const key of removedDuplicates) deps.io.print(`removed a duplicate ${key} line`);
  for (const key of existingKeys) deps.io.print(`kept ${key}`);

  deps.io.print(`Vault: ${vaultPath}`);
  deps.io.print(
    'Mode: local — Claude Code / Claude Desktop start the server themselves; ' +
      'no Docker, no owner secret, no tunnel.',
  );

  const launcherPath = quotePathForShellExample(launcherPathOf(deps), deps.platform);
  deps.io.print(`Claude Code: claude mcp add brainstem -- ${launcherPath} stdio`);
  deps.io.print(
    'A second vault is a second entry with its own name, e.g. ' +
      `claude mcp add brainstem-work -- ${launcherPath} stdio --vault <path>.`,
  );
  deps.io.print('Claude Desktop will use an installable bundle for this vault (coming soon).');
}

/**
 * Creates or updates `.env` from `.env.example` (or a pre-existing `.env`):
 * fills `OWNER_SECRET` and `VAULT_PATH` when empty, walks the tunnel-mode
 * questions (spec §5), and sets host-specific defaults. Every key except the
 * tunnel-mode set is left alone if already non-empty, unless `--force`.
 *
 * Asks first, always, how Claude will reach this vault; local mode is a
 * short, separate flow (`runLocalSetup`) that never touches Docker, the
 * owner secret or the tunnel questions below.
 */
export async function runSetup(args: SetupArgs, deps: SetupDeps): Promise<void> {
  const mode = await resolveMode(args, deps);
  const envPath = path.join(deps.cwd, '.env');

  if (mode === 'local') {
    await runLocalSetup(args, deps, envPath);
    return;
  }

  if (!(await deps.dockerAvailable())) {
    throw new Error(dockerRequiredMessage(deps.platform));
  }

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
    const value = finalEnv.get(key) ?? '';
    // TUNNEL_TOKEN is never printed, even with --show-secret: `--show-secret` only concerns
    // OWNER_SECRET. An empty token isn't a secret, so it's shown as-is (nothing to hide).
    if (key === TUNNEL_TOKEN_KEY) return value === '' ? `${key}=` : `${key}=****`;
    if (key === OWNER_SECRET_KEY && !args.showSecret) return key;
    return `${key}=${value}`;
  };
  for (const key of [...afterMain.changed, ...afterTunnel.changed]) {
    deps.io.print(`set ${describe(key)}`);
  }
  // Key names only — never a value, secret or not (`describe` above is for "set"/"kept" lines,
  // which do show values; this one never calls it).
  for (const key of [...afterMain.removedDuplicates, ...afterTunnel.removedDuplicates]) {
    deps.io.print(`removed a duplicate ${key} line`);
  }
  for (const key of [...afterMain.kept, ...afterTunnel.kept]) {
    deps.io.print(`kept ${describe(key)}`);
  }

  deps.io.print(`Vault: ${vaultPath}`);
  deps.io.print(`Tunnel mode: ${tunnel.mode}`);
  if (tunnel.mode === 'quick') {
    deps.io.print(
      'Note: the connector URL changes on every restart — see `_brainstem/connection.md` ' +
        'in your vault; for a stable URL rerun `./brainstem setup --tunnel-token …`.',
    );
  }
  if (args.printNext !== false) deps.io.print('Next: ./brainstem up');
}
