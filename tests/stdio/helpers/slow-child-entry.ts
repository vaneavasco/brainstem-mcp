// Test-only child-process entry: runs the real, unmodified `runStdioServer` (src/stdio-main.ts)
// after wrapping `LocalFSAdapter.create` so every batch read it hands back is delayed — used to
// prove `initialize`/`tools/list` answer immediately on a large vault while the background index
// fill (deferIndex: true) is still slow. `createLocalRuntime` resolves its adapter factory lazily
// (`opts.createAdapter ?? LocalFSAdapter.create.bind(LocalFSAdapter)`), so reassigning the class's
// static `create` here — a mutable property, not exported per-call — is picked up the moment
// `runStdioServer` (called below, untouched) builds the runtime. No test hook of any kind lives in
// production code: this file is the hook, read only by whichever test spawns it, via
// BRAINSTEM_TEST_SLOW_BATCH_MS.

import { parseVaultArg, runStdioServer } from '../../../src/stdio-main.ts';
import { LocalFSAdapter } from '../../../src/storage/local-fs.ts';

const delayMs = Number(process.env.BRAINSTEM_TEST_SLOW_BATCH_MS ?? '0');
if (delayMs > 0) {
  const realCreate = LocalFSAdapter.create.bind(LocalFSAdapter);
  LocalFSAdapter.create = (async (...args: Parameters<typeof realCreate>) => {
    const adapter = await realCreate(...args);
    const batchRead = adapter.batchRead.bind(adapter);
    adapter.batchRead = async (paths: string[]) => {
      const result = await batchRead(paths);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result;
    };
    return adapter;
  }) as typeof LocalFSAdapter.create;
}

const vaultOverride = parseVaultArg(process.argv.slice(2));
await runStdioServer({ vaultOverride });
