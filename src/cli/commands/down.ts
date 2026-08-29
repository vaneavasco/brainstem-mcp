import type { ComposeRunner } from '../docker.ts';

export interface DownDeps {
  compose: ComposeRunner;
  print(l: string): void;
}

/**
 * `docker compose --profile tunnel down`. The profile is always passed
 * (regardless of the current `TUNNEL_MODE`) so a tunnel container started
 * under a previous, different `TUNNEL_MODE` is removed too.
 */
export async function runDown(deps: DownDeps): Promise<number> {
  const result = await deps.compose.run(['--profile', 'tunnel', 'down']);
  if (result.code !== 0) {
    deps.print(`docker compose down exited with code ${result.code}`);
    return 1;
  }
  return 0;
}
