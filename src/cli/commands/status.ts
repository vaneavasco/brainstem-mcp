import type { ComposeRunner } from '../docker.ts';
import { fetchHealth } from '../health.ts';
import { type VaultPathContext, validateVaultPath } from '../vault-path.ts';

export interface StatusDeps {
  env: Map<string, string>;
  vaultCtx: VaultPathContext;
  compose: ComposeRunner;
  fetchImpl: typeof fetch;
  print(l: string): void;
  localPort: number;
}

interface ComposePsRow {
  Name?: string;
  Service?: string;
  State?: string;
}

/**
 * Parses `docker compose ps --format json` output — one JSON object per
 * line (not a JSON array) — into `service -> state`. Malformed lines are
 * skipped rather than failing the whole command.
 */
export function parseComposePs(stdout: string): Map<string, string> {
  const services = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: ComposePsRow;
    try {
      row = JSON.parse(trimmed) as ComposePsRow;
    } catch {
      continue;
    }
    const service = row.Service ?? row.Name ?? 'unknown';
    services.set(service, row.State ?? 'unknown');
  }
  return services;
}

/**
 * Prints an `.env` summary (vault path verdict, tunnel mode — never the
 * secrets themselves), the local `/health` snapshot, and container state
 * from `compose ps`. Informational only: always exits 0.
 */
export async function runStatus(deps: StatusDeps): Promise<number> {
  const tunnelMode = deps.env.get('TUNNEL_MODE') ?? 'none';
  deps.print(`Tunnel mode: ${tunnelMode}`);

  const vaultPath = deps.env.get('VAULT_PATH') ?? '';
  if (vaultPath === '') {
    deps.print('Vault path: (not set — run npm run setup)');
  } else {
    const verdict = await validateVaultPath(vaultPath, deps.vaultCtx);
    deps.print(
      verdict.ok
        ? `Vault path: ${verdict.path} (ok)`
        : `Vault path: ${vaultPath} (${verdict.error})`,
    );
  }

  const health = await fetchHealth(`http://localhost:${deps.localPort}/health`, deps.fetchImpl);
  deps.print(
    health
      ? `Health: ok (publicUrl=${health.publicUrl}, notes=${health.notes})`
      : 'Health: not running (npm run up)',
  );

  if (!(await deps.compose.available())) {
    deps.print('Docker is not running or not installed');
    return 0;
  }

  const result = await deps.compose.run(['ps', '--format', 'json'], { capture: true });
  const services = parseComposePs(result.stdout);
  if (services.size === 0) {
    deps.print('Containers: none running');
  } else {
    deps.print('Containers:');
    for (const [service, state] of services) {
      deps.print(`  ${service}: ${state}`);
    }
  }

  return 0;
}
