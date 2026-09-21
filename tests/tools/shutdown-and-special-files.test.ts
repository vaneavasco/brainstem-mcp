import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

function textOf(result: unknown): string {
  return JSON.stringify(result);
}

describe('a server that is stopping', () => {
  it('refuses brainstem_ping and brainstem_guide like every other tool', async () => {
    await h.runtime.calls.drain(10, 10);
    for (const tool of ['brainstem_ping', 'brainstem_guide', 'vault_list']) {
      const result = await h.call(tool);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toContain('SHUTTING_DOWN');
    }
  });
});

describe.skipIf(process.platform === 'win32')('a FIFO inside the vault', () => {
  it('is refused at once by every read, instead of blocking a thread for ever', async () => {
    const root = h.runtime.paths.vaultRoot;
    await fs.writeFile(path.join(root, 'plain.md'), '# plain\n');
    execFileSync('mkfifo', [path.join(root, 'pipe.md')]);
    const started = performance.now();
    const read = await h.call('vault_read', { path: 'pipe.md' });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain('not a regular file');
    const batch = await h.call('vault_batch_read', { paths: ['pipe.md', 'plain.md'] });
    expect(textOf(batch)).toContain('# plain');
    expect(await h.runtime.adapter.hashOf('pipe.md')).toBeNull();
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 20_000);
});
