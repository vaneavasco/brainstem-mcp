import type { ComposeRunner } from '../docker.ts';

export interface LogsDeps {
  compose: ComposeRunner;
}

/** `docker compose logs -f [service]`, streaming directly to the terminal. */
export async function runLogs(args: { service?: string }, deps: LogsDeps): Promise<number> {
  const result = await deps.compose.run(['logs', '-f', ...(args.service ? [args.service] : [])]);
  return result.code === 0 ? 0 : 1;
}
