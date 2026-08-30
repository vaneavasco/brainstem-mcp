import { spawn } from 'node:child_process';

export interface ComposeRunOptions {
  capture?: boolean;
  /**
   * Extra variables for compose's `${VAR}` interpolation — they take
   * precedence over `.env`. `up` uses it for `BRAINSTEM_IMAGE_TAG`.
   */
  env?: Record<string, string>;
}

export interface ComposeRunner {
  run(args: string[], opts?: ComposeRunOptions): Promise<{ code: number; stdout: string }>;
  available(): Promise<boolean>;
}

/**
 * Wraps `docker compose` in `cwd` (where `compose.yaml`/`.env` live). With
 * `capture`, stdout is buffered and returned instead of inherited — used by
 * commands (Task 15's `status`/`url`) that need to parse the output rather
 * than just stream it to the terminal.
 */
export function createComposeRunner(cwd: string): ComposeRunner {
  return {
    run(args, opts) {
      const capture = opts?.capture ?? false;
      return new Promise((resolve, reject) => {
        const child = spawn('docker', ['compose', ...args], {
          cwd,
          env: opts?.env ? { ...process.env, ...opts.env } : process.env,
          stdio: capture ? 'pipe' : 'inherit',
          shell: false,
        });
        let stdout = '';
        if (capture) {
          child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
        }
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
      });
    },
    async available() {
      try {
        const result = await this.run(['version'], { capture: true });
        return result.code === 0;
      } catch {
        return false;
      }
    },
  };
}
