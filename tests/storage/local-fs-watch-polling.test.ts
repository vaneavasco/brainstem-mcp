import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';

// This file mocks chokidar to assert exactly which options LocalFSAdapter#watch() passes to it —
// on a native filesystem, chokidar's inotify backend still delivers events with or without
// `usePolling`, so an event-delivery test alone (see local-fs-nav.test.ts) cannot catch the
// polling options being dropped. Mocking is isolated to this file so every other storage test
// keeps exercising the real chokidar. vitest hoists `vi.mock` above all imports in this file
// (including the one above), so the real chokidar module is never loaded here.
const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));

vi.mock('chokidar', () => ({
  watch: watchMock,
}));

function stubWatcher() {
  return { on: vi.fn().mockReturnThis(), close: vi.fn(async () => {}) };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-watch-poll-'));
  watchMock.mockReset();
  watchMock.mockReturnValue(stubWatcher());
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('watch() chokidar wiring', () => {
  it('passes usePolling/interval/binaryInterval to chokidar when watchPollMs is set', async () => {
    const adapter = await LocalFSAdapter.create(root, { ripgrepPath: null, watchPollMs: 300 });
    const stop = adapter.watch(() => {});
    expect(watchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ usePolling: true, interval: 300, binaryInterval: 300 }),
    );
    stop();
  });

  it('omits usePolling/interval/binaryInterval from chokidar options when watchPollMs is not set', async () => {
    const adapter = await LocalFSAdapter.create(root, { ripgrepPath: null });
    const stop = adapter.watch(() => {});
    const call = watchMock.mock.calls[0];
    if (call === undefined) throw new Error('expected chokidar watch() to have been called');
    const options = call[1] as Record<string, unknown>;
    expect(options.usePolling).toBeUndefined();
    expect(options.interval).toBeUndefined();
    expect(options.binaryInterval).toBeUndefined();
    stop();
  });
});
