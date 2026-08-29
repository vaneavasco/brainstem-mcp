import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repo root: this file lives at tests/cli/launcher.test.ts. */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? repoRoot,
      env: opts.env ?? process.env,
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(process.platform === 'win32')('./brainstem launcher (bash)', () => {
  it('has valid bash syntax', async () => {
    const { code, stderr } = await run('bash', ['-n', 'brainstem']);
    expect(code, stderr).toBe(0);
  });

  it('is marked executable', () => {
    const mode = statSync(path.join(repoRoot, 'brainstem')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('checks prerequisites and delegates to the real CLI, printing the help catalog', async () => {
    const { code, stdout, stderr } = await run('bash', ['./brainstem', 'help']);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Recommended flow');
    expect(stdout).toContain('start');
  }, 60_000);

  it('fails fast with a clear message when node is not on PATH', async () => {
    // Resolve bash's absolute path *before* stripping PATH, since spawn() needs to
    // locate the `bash` executable itself using the environment we hand the child.
    const bashPath = execFileSync('which', ['bash']).toString().trim();
    const { code, stderr } = await run(bashPath, ['./brainstem', 'help'], {
      env: { ...process.env, PATH: '/nonexistent' },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('Node.js 24 is required');
  });
});

describe('brainstem.cmd launcher (batch)', () => {
  it('is saved with CRLF endings and points at the TS entrypoint', async () => {
    const raw = await fs.readFile(path.join(repoRoot, 'brainstem.cmd'), 'utf8');
    expect(raw).toContain('\r\n');
    expect(raw).toContain('src\\cli\\brainstem.ts');
  });
});
