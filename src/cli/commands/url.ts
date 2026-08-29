import { fetchHealth } from '../health.ts';

export interface UrlDeps {
  fetchImpl: typeof fetch;
  print(l: string): void;
  localPort: number;
}

const REMOTE_TIMEOUT_MS = 10_000;

/**
 * Reads the local `/health` for `publicUrl`/`mcpUrl`, then — unless
 * `TUNNEL_MODE=none` — probes `<publicUrl>/health` through the tunnel to
 * confirm it's actually reachable from the outside.
 */
export async function runUrl(deps: UrlDeps): Promise<number> {
  const local = await fetchHealth(`http://localhost:${deps.localPort}/health`, deps.fetchImpl);
  if (!local) {
    deps.print('app is not running (./brainstem up)');
    return 1;
  }

  deps.print(`Connector URL: ${local.mcpUrl}`);
  deps.print(`Public URL: ${local.publicUrl}`);

  if (local.tunnelMode === 'none') {
    return 0;
  }

  try {
    const res = await deps.fetchImpl(`${local.publicUrl}/health`, {
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (res.ok) {
      deps.print('Remote check: ok (reachable through the tunnel)');
      return 0;
    }
    deps.print(`Remote check: failed (HTTP ${res.status})`);
    return 1;
  } catch (err) {
    deps.print(`Remote check: failed (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
}
