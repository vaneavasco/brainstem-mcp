import type { SystemProbe } from '../system.ts';

export interface UpdateDeps {
  exec: SystemProbe['exec'];
  /**
   * The repo directory. Passed explicitly to every `git` call: the CLI can be
   * invoked from anywhere (the `./brainstem` launcher, an npm script run in a
   * subdirectory), and a `git pull` in the wrong tree is worse than no update.
   */
  cwd: string;
  /** Inherit-stdio process runner, run in the repo directory. */
  run(cmd: string, args: string[]): Promise<number>;
  print(line: string): void;
}

/**
 * Deliberately generic: a `git pull --ff-only` fails on local changes, on
 * diverged history, on a dead network and outside a git checkout, and only
 * git's own stderr (printed just above this) can tell them apart.
 */
const PULL_FAILED_HINT =
  'git pull failed — see the message above (local changes, diverged history, no network, or not a git checkout)';

/** Surfaces git's own diagnosis, then the hint. Always exit code 1. */
function reportGitFailure(deps: UpdateDeps, stderr: string): number {
  const detail = stderr.trim();
  if (detail !== '') deps.print(detail);
  deps.print(PULL_FAILED_HINT);
  return 1;
}

async function shortHead(
  exec: SystemProbe['exec'],
  cwd: string,
): Promise<{ code: number; sha: string; stderr: string }> {
  const result = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  return { code: result.code, sha: result.stdout.trim(), stderr: result.stderr };
}

/**
 * `./brainstem update`: `git pull --ff-only`, `npm ci --omit=dev`, then
 * restarts in a child `<this node> src/cli/brainstem.ts up --build` so the
 * freshly installed dependencies — not the ones already loaded in this
 * process — are what actually runs. The child re-execs `process.execPath`
 * rather than a bare `node`, so the update runs under the same interpreter
 * the launcher picked, not whatever `node` happens to resolve to on PATH.
 * Any failing `git` step stops before touching anything else, printing git's
 * message verbatim.
 */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const before = await shortHead(deps.exec, deps.cwd);
  if (before.code !== 0) return reportGitFailure(deps, before.stderr);

  const pull = await deps.exec('git', ['pull', '--ff-only'], { cwd: deps.cwd });
  if (pull.code !== 0) return reportGitFailure(deps, pull.stderr);

  const after = await shortHead(deps.exec, deps.cwd);
  if (after.code !== 0) return reportGitFailure(deps, after.stderr);
  deps.print(
    before.sha === after.sha ? 'already up to date' : `updated ${before.sha} → ${after.sha}`,
  );

  const installCode = await deps.run('npm', ['ci', '--omit=dev']);
  if (installCode !== 0) return installCode;

  return deps.run(process.execPath, ['src/cli/brainstem.ts', 'up', '--build']);
}
