import type { SystemProbe } from '../system.ts';

export interface UpdateDeps {
  exec: SystemProbe['exec'];
  /** Inherit-stdio process runner, no shell, run in the repo directory. */
  run(cmd: string, args: string[]): Promise<number>;
  print(line: string): void;
}

const PULL_CONFLICT_MESSAGE = 'local changes or diverged history — run git status';

async function shortHead(exec: SystemProbe['exec']): Promise<string> {
  const result = await exec('git', ['rev-parse', '--short', 'HEAD']);
  return result.stdout.trim();
}

/**
 * `./brainstem update`: `git pull --ff-only`, `npm ci --omit=dev`, then
 * restarts in a child `node src/cli/brainstem.ts up --build` so the
 * freshly installed dependencies — not the ones already loaded in this
 * process — are what actually runs. A non-fast-forward pull (local changes
 * or diverged history) stops before touching anything else.
 */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const before = await shortHead(deps.exec);

  const pull = await deps.exec('git', ['pull', '--ff-only']);
  if (pull.code !== 0) {
    deps.print(PULL_CONFLICT_MESSAGE);
    return 1;
  }

  const after = await shortHead(deps.exec);
  deps.print(before === after ? 'already up to date' : `updated ${before} → ${after}`);

  const installCode = await deps.run('npm', ['ci', '--omit=dev']);
  if (installCode !== 0) return installCode;

  return deps.run('node', ['src/cli/brainstem.ts', 'up', '--build']);
}
