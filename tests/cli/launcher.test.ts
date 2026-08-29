import { execFileSync, spawn } from 'node:child_process';
import {
  promises as fs,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repo root: this file lives at tests/cli/launcher.test.ts. */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * The dependency-staleness check, byte-identical to the `node -e` one-liner embedded in
 * both `brainstem` and `brainstem.cmd` — keep all three in sync. Exits 1 ("stale or
 * missing") when `package-lock.json` is newer than `node_modules/.package-lock.json`,
 * or when the marker is missing entirely (a fresh checkout with no `node_modules`);
 * exits 0 ("fresh") otherwise. No `>`/`<` comparison operators or arrow functions are
 * used, on purpose: `brainstem.cmd` embeds this same text inside a double-quoted `node
 * -e` argument, and cmd.exe's redirection metacharacters (`<`, `>`) are NOT reliably
 * neutralized by surrounding double quotes the way they would be in a POSIX shell.
 */
const STALENESS_CHECK =
  "function s(p){try{return require('fs').statSync(p).mtimeMs}catch(e){return -1}};" +
  "process.exit(Math.sign(s('package-lock.json')-s('node_modules/.package-lock.json'))===1?1:0)";

/** Resolves an absolute path to `bash`, independent of `$SHELL` (which may not be bash). */
function resolveBash(): string {
  try {
    const found = execFileSync('which', ['bash']).toString().trim();
    if (found !== '') return found;
  } catch {
    // `which` itself may not exist on a minimal system — fall through to the fallback.
  }
  return '/bin/bash';
}

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
    const { code, stderr } = await run('bash', ['-n', './brainstem']);
    expect(code, stderr).toBe(0);
  });

  it('is marked executable', () => {
    const mode = statSync(path.join(repoRoot, 'brainstem')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('checks prerequisites and delegates to the real CLI, printing the help catalog', async () => {
    // BRAINSTEM_SKIP_INSTALL=1: never let this spawn run `npm ci --omit=dev` mid-suite
    // (it would strip devDependencies out from under the rest of the test run).
    const { code, stdout, stderr } = await run('bash', ['./brainstem', 'help'], {
      env: { ...process.env, BRAINSTEM_SKIP_INSTALL: '1' },
    });
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Recommended flow');
    expect(stdout).toContain('start');
  }, 60_000);

  it('fails fast with a clear message when node is not on PATH', async () => {
    // Resolve bash's absolute path *before* stripping PATH, since spawn() needs to
    // locate the `bash` executable itself using the environment we hand the child.
    const bashPath = resolveBash();
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

/**
 * Structural assertions on the launcher *text*: actually exercising the install
 * branch would run `npm ci` mid-suite and rewrite this very `node_modules`, so
 * both launchers are read rather than run. Keep the two scripts in agreement —
 * whatever is asserted here has to hold for `brainstem` and `brainstem.cmd`.
 */
describe('launcher dependency install', () => {
  const launchers = ['brainstem', 'brainstem.cmd'];

  it('keeps a developer install intact: `npm ci` without --omit=dev when vitest is present', async () => {
    for (const name of launchers) {
      const raw = await fs.readFile(path.join(repoRoot, name), 'utf8');
      // A dev checkout is detected by node_modules/.bin/vitest: `npm ci --omit=dev`
      // there would silently delete every devDependency out from under the owner.
      expect(raw, name).toMatch(/\.bin[\\/]vitest/);
      expect(raw, name).toMatch(/npm ci --no-audit --no-fund/);
      expect(raw, name).toMatch(/npm ci --omit=dev/);
    }
  });

  it('does not hide install failures behind --silent', async () => {
    for (const name of launchers) {
      const raw = await fs.readFile(path.join(repoRoot, name), 'utf8');
      expect(raw, name).not.toContain('--silent');
      expect(raw, name).toContain('--loglevel=error');
    }
  });

  it('documents BRAINSTEM_SKIP_INSTALL and the dev-install behaviour in the README', async () => {
    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('BRAINSTEM_SKIP_INSTALL');
    expect(readme).toContain('--omit=dev');
  });
});

describe('dependency-staleness check (node one-liner shared by both launchers)', () => {
  /**
   * Runs STALENESS_CHECK in a scratch directory laid out like the repo root
   * (`package-lock.json` + `node_modules/.package-lock.json`), with each file's mtime
   * controlled independently. `null` means "don't create that file". Returns the
   * process's exit code — never touches the real repo's lockfile or node_modules.
   */
  function exitCodeFor(lockMtime: number | null, markerMtime: number | null): number {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'brainstem-staleness-'));
    try {
      if (lockMtime !== null) {
        const p = path.join(dir, 'package-lock.json');
        writeFileSync(p, '{}');
        utimesSync(p, new Date(lockMtime), new Date(lockMtime));
      }
      if (markerMtime !== null) {
        const nm = path.join(dir, 'node_modules');
        mkdirSync(nm, { recursive: true });
        const p = path.join(nm, '.package-lock.json');
        writeFileSync(p, '{}');
        utimesSync(p, new Date(markerMtime), new Date(markerMtime));
      }
      try {
        execFileSync('node', ['-e', STALENESS_CHECK], { cwd: dir, stdio: 'pipe' });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is stale (exit 1) when the lockfile is newer than the marker', () => {
    expect(exitCodeFor(2_000_000, 1_000_000)).toBe(1);
  });

  it('is fresh (exit 0) when the marker is newer than the lockfile', () => {
    expect(exitCodeFor(1_000_000, 2_000_000)).toBe(0);
  });

  it('is fresh (exit 0) when the mtimes are exactly equal (not strictly newer)', () => {
    expect(exitCodeFor(1_000_000, 1_000_000)).toBe(0);
  });

  it('is stale (exit 1) when the marker is missing (fresh checkout, no node_modules)', () => {
    expect(exitCodeFor(1_000_000, null)).toBe(1);
  });

  it('is fresh (exit 0) when neither file exists', () => {
    expect(exitCodeFor(null, null)).toBe(0);
  });
});
