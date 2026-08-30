import type { SystemProbe } from './system.ts';

/**
 * The image tag CI publishes for the commit that is checked out: `sha-<7>`
 * (see `publish-images` in `.github/workflows/ci.yml`, `type=sha,format=short`).
 *
 * `null` means "nothing prebuilt can match what is on disk": not a git
 * checkout, git missing, or a dirty working tree — a developer's local edits
 * are exactly what a registry image would not contain, so `up` builds instead.
 */
export async function resolveImageTag(
  exec: SystemProbe['exec'],
  cwd: string,
): Promise<string | null> {
  try {
    const head = await exec('git', ['rev-parse', '--short=7', 'HEAD'], { cwd });
    if (head.code !== 0) return null;
    const sha = head.stdout.trim();
    if (!/^[0-9a-f]{7,}$/.test(sha)) return null;
    const status = await exec('git', ['status', '--porcelain'], { cwd });
    if (status.code !== 0 || status.stdout.trim() !== '') return null;
    return `sha-${sha.slice(0, 7)}`;
  } catch {
    return null;
  }
}
