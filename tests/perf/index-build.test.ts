import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateQuery } from '../../src/vault/query.ts';
import { createLocalRuntime, type VaultRuntime } from '../../src/vault/runtime.ts';

/**
 * Guard, not a benchmark: catches an accidental O(n²) regression in index build / graph
 * derivation / query evaluation before it reaches a real (much smaller) vault. The bounds below
 * are generous CI ceilings, not targets — the actual time is logged on every run so a slow
 * drift is visible long before it trips the guard. Spec §8: index+graph build for 5,000 notes
 * under budget on CI; vault_query under budget over the same set.
 *
 * Measured in isolation: ~1.1s build, ~2ms query. Run alongside the other 60+ test files
 * (`npx vitest run`, the default full-suite command), CPU contention from every other file's
 * parallel worker pushed the build to ~5.1s on a 16-core box with nothing else running on it —
 * so the bounds below carry real headroom over the isolated numbers rather than sitting right at
 * them, to keep this a signal for an actual regression rather than a coin flip on scheduler
 * noise from unrelated tests sharing the machine.
 */

const NOTE_COUNT = 5_000;
const TAG_POOL = Array.from({ length: 40 }, (_, i) => `tag-${i}`);

function noteName(i: number): string {
  return `note-${String(i).padStart(5, '0')}`;
}

/** Two "random" links and two "random" tags per note — deterministic scatter is enough to
 *  exercise realistic backlink/tag fan-out without making the guard's timing depend on the RNG. */
async function seedVault(dir: string): Promise<void> {
  const CHUNK = 200;
  for (let start = 0; start < NOTE_COUNT; start += CHUNK) {
    const end = Math.min(start + CHUNK, NOTE_COUNT);
    const writes: Promise<void>[] = [];
    for (let i = start; i < end; i++) {
      const link1 = noteName(Math.floor(Math.random() * NOTE_COUNT));
      const link2 = noteName(Math.floor(Math.random() * NOTE_COUNT));
      const tag1 = TAG_POOL[Math.floor(Math.random() * TAG_POOL.length)];
      const tag2 = TAG_POOL[Math.floor(Math.random() * TAG_POOL.length)];
      const content =
        `---\ntags:\n  - ${tag1}\n  - ${tag2}\n---\n\n` +
        `# ${noteName(i)}\n\nLinks to [[${link1}]] and [[${link2}]].\n`;
      writes.push(fs.writeFile(path.join(dir, `${noteName(i)}.md`), content));
    }
    await Promise.all(writes);
  }
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-perf-'));
  await seedVault(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('index build + graph derivation + query, perf guard', () => {
  it(`builds the index/graph for ${NOTE_COUNT} notes and evaluates a query within budget`, async () => {
    const start = performance.now();
    const runtime: VaultRuntime = await createLocalRuntime({
      vaultPath: dir,
      ripgrepPath: null,
      stateDir: path.join(dir, '_brainstem'),
    });
    try {
      const hubs = runtime.graph.hubs(10);
      const buildMs = performance.now() - start;
      console.log(
        `[perf] createLocalRuntime + first graph.hubs(10) over ${NOTE_COUNT} notes: ${buildMs.toFixed(1)}ms`,
      );
      expect(buildMs).toBeLessThan(15_000);
      expect(hubs.length).toBeGreaterThan(0);

      const queryStart = performance.now();
      const result = evaluateQuery(runtime.index.all(), runtime.graph, {
        tags: { any: [TAG_POOL[0] as string] },
        limit: 500,
      });
      const queryMs = performance.now() - queryStart;
      console.log(`[perf] evaluateQuery over ${NOTE_COUNT} entries: ${queryMs.toFixed(1)}ms`);
      expect(queryMs).toBeLessThan(1_000);
      expect(result.total).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
