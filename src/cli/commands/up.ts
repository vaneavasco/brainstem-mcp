import type { ComposeRunner } from '../docker.ts';
import { type HealthInfo, waitForHealth } from '../health.ts';

export interface UpDeps {
  compose: ComposeRunner;
  env: Map<string, string>;
  print(l: string): void;
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  localPort: number;
}

const HEALTH_TIMEOUT_MS = 120_000;

/** The lines `runUp` prints once the app answers healthy. */
export function upSummary(h: HealthInfo, opts: { secretHint: string }): string[] {
  const lines = [
    `Connector URL: ${h.mcpUrl}`,
    `claude mcp add --transport http brainstem ${h.mcpUrl}`,
    `Owner secret: ${opts.secretHint}`,
  ];
  if (h.tunnelMode === 'quick') {
    lines.push(
      'Note: this URL changes on every restart — see _brainstem/connection.md in your vault; ' +
        'for a stable URL run: npm run setup -- --tunnel-token <token> --public-url https://<host>',
    );
  } else if (h.tunnelMode === 'cloudflare') {
    lines.push('URL is stable (Cloudflare named tunnel)');
  }
  return lines;
}

/**
 * `docker compose up -d` (with `--profile tunnel` unless `TUNNEL_MODE=none`),
 * then waits for `/health` to answer before printing the connector summary.
 * A timeout dumps the last 20 lines of `app`/`tunnel` logs instead.
 */
export async function runUp(args: { build?: boolean }, deps: UpDeps): Promise<number> {
  if (!(await deps.compose.available())) {
    deps.print('Docker is not running or not installed');
    return 1;
  }

  const tunnelMode = deps.env.get('TUNNEL_MODE') ?? 'none';
  const upArgs = [
    ...(tunnelMode !== 'none' ? ['--profile', 'tunnel'] : []),
    'up',
    '-d',
    ...(args.build ? ['--build'] : []),
  ];
  await deps.compose.run(upArgs);

  const health = await waitForHealth(
    `http://localhost:${deps.localPort}/health`,
    HEALTH_TIMEOUT_MS,
    deps.fetchImpl,
    deps.sleep,
  );

  if (!health) {
    deps.print(`app did not become healthy within ${HEALTH_TIMEOUT_MS / 1000} s`);
    await deps.compose.run(['logs', '--tail', '20', 'tunnel', 'app']);
    return 1;
  }

  for (const line of upSummary(health, {
    secretHint: 'in .env (npm run brainstem -- secret show)',
  })) {
    deps.print(line);
  }
  return 0;
}
