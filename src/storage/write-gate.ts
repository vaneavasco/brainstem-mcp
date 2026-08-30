import { VaultError } from './types.ts';

/**
 * Keyed async mutex. Every mutating adapter call for a set of vault paths runs inside
 * `withLock(paths, fn)`. Paths are deduped and sorted before acquisition so that two calls
 * touching the same paths in a different order (e.g. a move locking `[from, to]` vs another
 * call locking `[to, from]`) always acquire them in the same order and cannot deadlock.
 *
 * Single process, in-memory `Map<path, Promise<void>>` — this does not survive a restart and
 * is not shared across processes, which is fine for a single-user local server. Reads are not
 * locked.
 */
export class WriteGate {
  private readonly chains = new Map<string, Promise<void>>();

  async withLock<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(paths)].sort();
    const releases: (() => void)[] = [];
    for (const p of sorted) {
      await this.acquire(p, releases);
    }
    try {
      return await fn();
    } finally {
      // Release in reverse (LIFO) order — irrelevant for correctness since each key's chain is
      // independent, but keeps release symmetric with acquisition.
      for (let i = releases.length - 1; i >= 0; i -= 1) {
        releases[i]?.();
      }
    }
  }

  /** Waits for the current holder of `p` (if any), then installs this call as the new holder. */
  private async acquire(p: string, releases: (() => void)[]): Promise<void> {
    const prior = this.chains.get(p) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      p,
      prior.then(() => held),
    );
    releases.push(release);
    await prior;
  }
}

/**
 * Throws `VaultError('CONFLICT', …)` when `expected` is defined and does not match `current`.
 * `current` is the file's present content hash (`null` when the file does not exist).
 */
export function assertExpectedHash(
  path: string,
  current: string | null,
  expected: string | undefined,
): void {
  if (expected === undefined) return;
  if (current === expected) return;
  throw new VaultError(
    'CONFLICT',
    `${path} changed since it was read (expected ${expected.slice(0, 12)}…, current ${
      current ? `${current.slice(0, 12)}…` : 'missing'
    }). Re-read it and retry with the new hash.`,
    { path, currentHash: current },
  );
}
