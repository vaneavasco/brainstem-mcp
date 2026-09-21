import { execFileSync, spawn } from 'node:child_process';
import {
  promises as fs,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
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

describe.skipIf(process.platform === 'win32')(
  'commands that need only Node skip the Docker check',
  () => {
    /** A PATH containing symlinks to `node` and the handful of coreutils the launcher's own
     *  prelude needs (`dirname`, for `SCRIPT_DIR`) but nothing else — in particular no `docker` —
     *  without touching the real PATH or requiring Docker to actually be absent on this machine. */
    function nodeOnlyPath(): string {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'brainstem-node-only-'));
      for (const bin of ['node', 'dirname']) {
        const real = execFileSync('which', [bin]).toString().trim();
        symlinkSync(real, path.join(dir, bin));
      }
      return dir;
    }

    it('--version never reaches the Docker check', async () => {
      const dir = nodeOnlyPath();
      try {
        const { code, stdout, stderr } = await run(resolveBash(), ['./brainstem', '--version'], {
          env: { ...process.env, PATH: dir, BRAINSTEM_SKIP_INSTALL: '1' },
        });
        expect(code, stderr).toBe(0);
        expect(stdout.trim().length).toBeGreaterThan(0);
        expect(stderr).not.toContain('Docker');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('help, -h and no-args never reach the Docker check', async () => {
      const dir = nodeOnlyPath();
      try {
        for (const args of [['help'], ['-h'], []]) {
          const { code, stdout, stderr } = await run(resolveBash(), ['./brainstem', ...args], {
            env: { ...process.env, PATH: dir, BRAINSTEM_SKIP_INSTALL: '1' },
          });
          expect(code, `${args.join(' ')} — ${stderr}`).toBe(0);
          expect(stdout).toContain('Recommended flow');
          expect(stderr).not.toContain('Docker');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('stdio never reaches the Docker check: it fails on the vault it was given instead', async () => {
      const dir = nodeOnlyPath();
      try {
        // `--vault` wins over any `.env` next to the launcher, so this never starts a server on
        // the developer's own vault (the command reads the install's `.env` for vault settings).
        const missing = path.join(dir, 'no-such-vault');
        const { code, stderr } = await run(
          resolveBash(),
          ['./brainstem', 'stdio', '--vault', missing],
          { env: { ...process.env, PATH: dir, BRAINSTEM_SKIP_INSTALL: '1' } },
        );
        expect(code).toBe(1);
        expect(stderr).not.toContain('Docker is required');
        expect(stderr).toContain('no-such-vault');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('every other command still requires Docker', async () => {
      const dir = nodeOnlyPath();
      try {
        const { code, stderr } = await run(resolveBash(), ['./brainstem', 'status'], {
          env: { ...process.env, PATH: dir, BRAINSTEM_SKIP_INSTALL: '1' },
        });
        expect(code).toBe(1);
        expect(stderr).toContain('Docker is required');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

describe('brainstem.cmd launcher (batch)', () => {
  it('is saved with CRLF endings and points at the TS entrypoint', async () => {
    const raw = await fs.readFile(path.join(repoRoot, 'brainstem.cmd'), 'utf8');
    expect(raw).toContain('\r\n');
    expect(raw).toContain('src\\cli\\brainstem.ts');
  });

  /**
   * stdout carries the MCP protocol on the `stdio` path (ADR 0008): every line this launcher can
   * print with `echo` before `node src\cli\brainstem.ts` ever runs — including the ones on
   * branches `stdio` itself does not take (docker missing, say) — must go to stderr, exactly like
   * the bash launcher (`brainstem`) already does for every one of its own `echo` lines. A bare
   * `echo` here would otherwise land on stdout ahead of the first JSON-RPC byte a real client
   * reads, on any machine where the check it guards happens to trip.
   */
  it('every echo before the CLI is delegated to writes to stderr, not stdout', async () => {
    const raw = await fs.readFile(path.join(repoRoot, 'brainstem.cmd'), 'utf8');
    const lines = raw.split(/\r\n/).filter((l) => l.length > 0);
    const delegateLine = lines.findIndex((l) => l.includes('node src\\cli\\brainstem.ts'));
    expect(delegateLine).toBeGreaterThan(0);
    const beforeDelegate = lines.slice(0, delegateLine);
    const echoLines = beforeDelegate.filter(
      (l) => /\becho\b/i.test(l) && !/^@echo off/i.test(l.trim()),
    );
    expect(echoLines.length).toBeGreaterThan(0); // the assertion below must not vacuously pass
    for (const line of echoLines) {
      expect(line, line).toMatch(/(1>&2|>&2)/);
    }
  });

  /** `%1` keeps any quotes the caller passed (`brainstem.cmd "stdio"` would compare against the
   *  literal text `"stdio"`, never matching `stdio`); `%~1` strips them, like the bash launcher's
   *  plain `$1` does implicitly through `case`. */
  it('compares the first argument with %~1 (quote-stripped), never bare %1, for the command dispatch', async () => {
    const raw = await fs.readFile(path.join(repoRoot, 'brainstem.cmd'), 'utf8');
    const lines = raw.split(/\r\n/).filter((l) => l.length > 0);
    const dispatchLines = lines.filter((l) => /^if\s+(\/I\s+)?"%~?1"==/i.test(l.trim()));
    // stdio, --help, -h, help, --version, -V and the no-args case: 7 comparisons.
    expect(dispatchLines.length).toBeGreaterThanOrEqual(7);
    for (const line of dispatchLines) {
      expect(line, line).toContain('%~1');
      expect(line, line).not.toMatch(/"%1"==/);
    }
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
