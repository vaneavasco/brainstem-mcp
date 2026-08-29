import { spawn } from 'node:child_process';
import net from 'node:net';

/** Thin wrapper over the bits of the OS `doctor` needs to probe — swappable in tests. */
export interface SystemProbe {
  /** `process.versions.node`, e.g. `'24.13.1'`. */
  nodeVersion(): string;
  /**
   * Runs `cmd` with `args` (no shell) — in `opts.cwd` when given, otherwise the
   * process's own directory; never rejects: a missing binary resolves `{ code: 127 }`.
   */
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Probes whether `port` can be bound on `127.0.0.1`. */
  portFree(port: number): Promise<boolean>;
  platform: NodeJS.Platform;
}

/** Real `SystemProbe` backed by `node:child_process` and `node:net`. */
export function createSystemProbe(): SystemProbe {
  return {
    nodeVersion: () => process.versions.node,
    platform: process.platform,
    exec(cmd, args, opts) {
      return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const done = (result: { code: number; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const child = spawn(cmd, args, { stdio: 'pipe', shell: false, cwd: opts?.cwd });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1;
          done({ code, stdout: '', stderr: code === 127 ? '' : String(err.message) });
        });
        child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
      });
    },
    portFree(port) {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err: NodeJS.ErrnoException) => {
          resolve(err.code !== 'EADDRINUSE');
        });
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(true));
        });
      });
    },
  };
}

/** `'24.13.1'` → `24`; `'v22.0.0'` → `22`; anything without a leading number → `0`. */
export function parseMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}
