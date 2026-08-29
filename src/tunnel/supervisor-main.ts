import { spawn } from 'node:child_process';
import { DEFAULT_PUBLIC_URL_FILE, runSupervisor, type SupervisorOptions } from './supervisor.ts';

const DEFAULT_TARGET = 'http://app:3000';

function log(msg: string): void {
  console.log(`[tunnel] ${msg}`);
}

async function main(): Promise<void> {
  const mode = process.env.TUNNEL_MODE;
  if (mode !== 'quick' && mode !== 'cloudflare') {
    console.error(
      `[tunnel] TUNNEL_MODE must be 'quick' or 'cloudflare', got: ${mode ?? '(unset)'}`,
    );
    process.exit(1);
  }

  const token = process.env.TUNNEL_TOKEN;
  if (mode === 'cloudflare' && !token) {
    console.error('[tunnel] TUNNEL_TOKEN is required when TUNNEL_MODE=cloudflare');
    process.exit(1);
  }

  const options: SupervisorOptions = {
    mode,
    token,
    target: process.env.TUNNEL_TARGET ?? DEFAULT_TARGET,
    urlFile: process.env.PUBLIC_URL_FILE ?? DEFAULT_PUBLIC_URL_FILE,
    log,
    spawn: (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  };

  const ac = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`received ${signal} — shutting down`);
    ac.abort();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  await runSupervisor(options, ac.signal);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[tunnel] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
