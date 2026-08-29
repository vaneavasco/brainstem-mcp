import { decodeOwnerSecretBytes, OWNER_SECRET_MIN_BYTES } from '../../config.ts';
import { parseMajor, type SystemProbe } from '../system.ts';
import { type VaultPathContext, validateVaultPath } from '../vault-path.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

export interface DoctorDeps {
  probe: SystemProbe;
  /** Parsed `.env`, or `null` when the file is missing. */
  env: Map<string, string> | null;
  vaultCtx: VaultPathContext;
  print(line: string): void;
  /** Used for the port check's `/health` probe; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Run only the machine-level checks (node/docker/docker-daemon/compose) and
   * stop before anything `.env`-derived. `start` (Task 2) uses this so it can
   * run doctor's prerequisite checks before `.env` necessarily exists.
   */
  prerequisitesOnly?: boolean;
}

const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 3000;
const HEALTH_TIMEOUT_MS = 2000;
const DOCKER_DESKTOP_URL = 'https://docs.docker.com/desktop/';
const DOCKER_ENGINE_URL = 'https://docs.docker.com/engine/install/';
const TUNNEL_MODES = new Set(['cloudflare', 'quick', 'none']);

export const REMEDIES: {
  node: Record<'linux' | 'darwin' | 'win32', string>;
  docker: Record<'linux' | 'darwin' | 'win32', string>;
} = {
  node: {
    linux:
      'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs',
    darwin: 'brew install node@24',
    win32: 'winget install OpenJS.NodeJS.LTS',
  },
  docker: {
    linux: DOCKER_ENGINE_URL,
    darwin: DOCKER_DESKTOP_URL,
    win32: DOCKER_DESKTOP_URL,
  },
};

/** Narrows an arbitrary `NodeJS.Platform` to the three `REMEDIES` covers, defaulting to linux. */
function remedyPlatform(platform: NodeJS.Platform): 'linux' | 'darwin' | 'win32' {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

function check(name: string, ok: boolean, detail: string, remedy?: string): Check {
  return remedy === undefined ? { name, ok, detail } : { name, ok, detail, remedy };
}

function localPortOf(env: Map<string, string>): number {
  const port = Number(env.get('PORT'));
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

async function portCheck(
  env: Map<string, string>,
  probe: SystemProbe,
  fetchImpl: typeof fetch,
): Promise<Check> {
  const port = localPortOf(env);
  if (await probe.portFree(port)) {
    return check('port', true, `port ${port} is free`);
  }

  const ownApp = await isOurHealthEndpoint(port, fetchImpl);
  if (ownApp) {
    return check('port', true, `port ${port} in use by brainstem-mcp (already running)`);
  }
  return check(
    'port',
    false,
    `port ${port} is already in use`,
    'stop the other process or change PORT in .env',
  );
}

async function isOurHealthEndpoint(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return false;
    return (body as Record<string, unknown>).name === 'brainstem-mcp';
  } catch {
    return false;
  }
}

/** Validates `TUNNEL_MODE` and the env vars its value requires — never surfaces their values. */
function tunnelModeCheck(env: Map<string, string>): Check {
  const mode = env.get('TUNNEL_MODE') ?? '';
  if (!TUNNEL_MODES.has(mode)) {
    return check(
      'tunnel-mode',
      false,
      `TUNNEL_MODE must be one of cloudflare, quick, none (got "${mode}")`,
      './brainstem setup',
    );
  }

  const has = (key: string) => (env.get(key) ?? '') !== '';
  if (mode === 'cloudflare') {
    const missing = [
      has('TUNNEL_TOKEN') ? null : 'TUNNEL_TOKEN',
      has('PUBLIC_URL') ? null : 'PUBLIC_URL',
    ].filter((k): k is string => k !== null);
    if (missing.length > 0) {
      return check(
        'tunnel-mode',
        false,
        `TUNNEL_MODE=cloudflare requires ${missing.join(', ')}`,
        './brainstem setup',
      );
    }
    return check('tunnel-mode', true, 'TUNNEL_MODE=cloudflare (configured)');
  }
  if (mode === 'quick') {
    if (!has('PUBLIC_URL_FILE')) {
      return check(
        'tunnel-mode',
        false,
        'TUNNEL_MODE=quick requires PUBLIC_URL_FILE',
        './brainstem setup',
      );
    }
    return check('tunnel-mode', true, 'TUNNEL_MODE=quick (configured)');
  }
  // mode === 'none'
  if (!has('PUBLIC_URL')) {
    return check('tunnel-mode', false, 'TUNNEL_MODE=none requires PUBLIC_URL', './brainstem setup');
  }
  return check('tunnel-mode', true, 'TUNNEL_MODE=none (configured)');
}

/**
 * Runs the doctor checks and returns them in a fixed order (machine-level
 * checks first, then `.env`-derived ones), without printing anything. Stops
 * after the machine-level checks when `prerequisitesOnly` is set, or after
 * the `env` check when `.env` is missing — later checks all depend on it.
 */
export async function runDoctorChecks(deps: DoctorDeps): Promise<Check[]> {
  const { probe } = deps;
  const platform = remedyPlatform(probe.platform);
  const checks: Check[] = [];

  const nodeVersion = probe.nodeVersion();
  const nodeOk = parseMajor(nodeVersion) >= MIN_NODE_MAJOR;
  checks.push(
    check(
      'node',
      nodeOk,
      nodeOk ? `Node ${nodeVersion}` : `Node ${nodeVersion} — need >= ${MIN_NODE_MAJOR}`,
      nodeOk ? undefined : REMEDIES.node[platform],
    ),
  );

  const dockerVersion = await probe.exec('docker', ['--version']);
  const dockerOk = dockerVersion.code === 0;
  checks.push(
    check(
      'docker',
      dockerOk,
      dockerOk ? 'Docker installed' : 'Docker — not installed',
      dockerOk ? undefined : REMEDIES.docker[platform],
    ),
  );

  const dockerInfo = await probe.exec('docker', ['info']);
  const daemonOk = dockerInfo.code === 0;
  checks.push(
    check(
      'docker-daemon',
      daemonOk,
      daemonOk ? 'Docker daemon running' : 'Docker daemon — not running',
      daemonOk
        ? undefined
        : platform === 'linux'
          ? 'sudo systemctl start docker'
          : 'start Docker Desktop',
    ),
  );

  const composeVersion = await probe.exec('docker', ['compose', 'version']);
  const composeOk = composeVersion.code === 0;
  checks.push(
    check(
      'compose',
      composeOk,
      composeOk ? 'Docker Compose v2 available' : 'Docker Compose v2 — not available',
      composeOk ? undefined : REMEDIES.docker[platform],
    ),
  );

  if (deps.prerequisitesOnly) return checks;

  const envOk = deps.env !== null;
  checks.push(
    check(
      'env',
      envOk,
      envOk ? '.env present' : '.env — missing',
      envOk ? undefined : './brainstem setup',
    ),
  );
  const env = deps.env;
  if (env === null) return checks;

  const secretBytes = decodeOwnerSecretBytes(env.get('OWNER_SECRET') ?? '');
  const secretOk = secretBytes >= OWNER_SECRET_MIN_BYTES;
  checks.push(
    check(
      'owner-secret',
      secretOk,
      secretOk ? 'OWNER_SECRET is valid' : 'OWNER_SECRET does not decode to enough bytes',
      secretOk
        ? undefined
        : `OWNER_SECRET must decode to at least ${OWNER_SECRET_MIN_BYTES} bytes (run ./brainstem secret rotate)`,
    ),
  );

  const vaultPath = env.get('VAULT_PATH') ?? '';
  const verdict =
    vaultPath === ''
      ? { ok: false as const, error: 'VAULT_PATH is not set' }
      : await validateVaultPath(vaultPath, deps.vaultCtx);
  checks.push(
    check(
      'vault-path',
      verdict.ok,
      verdict.ok ? `VAULT_PATH ok (${verdict.path})` : `VAULT_PATH — ${verdict.error}`,
      verdict.ok ? undefined : './brainstem setup',
    ),
  );

  checks.push(tunnelModeCheck(env));

  checks.push(await portCheck(env, probe, deps.fetchImpl ?? globalThis.fetch));

  return checks;
}

/** Prints `✓`/`✗` lines (with indented `→ remedy` lines) and a summary; exit code 0 iff all pass. */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const checks = await runDoctorChecks(deps);
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      deps.print(`✓ ${c.detail}`);
    } else {
      failed++;
      deps.print(`✗ ${c.detail}`);
      if (c.remedy) deps.print(`    → ${c.remedy}`);
    }
  }
  deps.print(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
  return failed === 0 ? 0 : 1;
}
