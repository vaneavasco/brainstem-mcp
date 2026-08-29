import { EventEmitter } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChildLike,
  cloudflaredArgs,
  extractTunnelUrl,
  runSupervisor,
} from '../../src/tunnel/supervisor.ts';

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
  }
  exit(code: number): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`expected children[${index}] to exist`);
  return value;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-tunnel-supervisor-'));
  file = path.join(dir, 'public-url');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('extractTunnelUrl', () => {
  it('extracts the quick tunnel URL from cloudflared output', () => {
    expect(
      extractTunnelUrl('2026-08-28T10:00:00Z INF |  https://abc-def-ghi.trycloudflare.com  |'),
    ).toBe('https://abc-def-ghi.trycloudflare.com');
    expect(extractTunnelUrl('INF Connection registered')).toBeNull();
  });
});

describe('cloudflaredArgs', () => {
  it('builds the right cloudflared arguments per mode', () => {
    expect(cloudflaredArgs({ mode: 'quick', target: 'http://app:3000' })).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://app:3000',
    ]);
    expect(cloudflaredArgs({ mode: 'cloudflare', token: 'T', target: 'http://app:3000' })).toEqual([
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token',
      'T',
    ]);
  });
});

describe('runSupervisor', () => {
  it('writes the URL file in quick mode and restarts cloudflared with backoff when it exits', async () => {
    const children: FakeChild[] = [];
    const sleeps: number[] = [];
    const ac = new AbortController();
    const run = runSupervisor(
      {
        mode: 'quick',
        target: 'http://app:3000',
        urlFile: file,
        log: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        spawn: () => {
          const c = new FakeChild();
          children.push(c);
          return c;
        },
      },
      ac.signal,
    );

    await tick();
    at(children, 0).stderr.write('INF |  https://one.trycloudflare.com  |\n');
    await tick();
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('https://one.trycloudflare.com');

    at(children, 0).exit(1);
    await tick();
    await tick();
    expect(children).toHaveLength(2);
    expect(sleeps[0]).toBe(1_000);

    at(children, 1).stderr.write('INF |  https://two.trycloudflare.com  |\n');
    await tick();
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('https://two.trycloudflare.com');

    ac.abort();
    at(children, 1).exit(0);
    await run;
  });

  it('removes a stale public-url file before every quick-mode spawn', async () => {
    await fs.writeFile(file, 'https://stale.trycloudflare.com\n');
    const children: FakeChild[] = [];
    const existedAtSpawn: boolean[] = [];
    const ac = new AbortController();
    const run = runSupervisor(
      {
        mode: 'quick',
        target: 'http://app:3000',
        urlFile: file,
        log: () => {},
        sleep: async () => {},
        spawn: () => {
          existedAtSpawn.push(existsSync(file));
          const c = new FakeChild();
          children.push(c);
          return c;
        },
      },
      ac.signal,
    );

    await tick();
    // The previous run's URL is gone before cloudflared starts, so the app
    // waits for the new one instead of booting on a URL nothing serves.
    expect(existedAtSpawn).toEqual([false]);

    at(children, 0).stderr.write('INF |  https://one.trycloudflare.com  |\n');
    await tick();
    expect(existsSync(file)).toBe(true);

    // A restart within the same supervisor also yields a brand-new hostname.
    at(children, 0).exit(1);
    await tick();
    await tick();
    expect(existedAtSpawn).toEqual([false, false]);

    ac.abort();
    at(children, 1).exit(0);
    await run;
  });

  it('does not write a URL file in cloudflare mode', async () => {
    const children: FakeChild[] = [];
    const ac = new AbortController();
    const run = runSupervisor(
      {
        mode: 'cloudflare',
        token: 'T',
        target: 'http://app:3000',
        urlFile: file,
        log: () => {},
        sleep: async () => {},
        spawn: () => {
          const c = new FakeChild();
          children.push(c);
          return c;
        },
      },
      ac.signal,
    );

    await tick();
    at(children, 0).stderr.write('INF |  https://should-not-be-used.trycloudflare.com  |\n');
    await tick();
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow();

    ac.abort();
    at(children, 0).exit(0);
    await run;
  });

  it('resets the backoff after a child has lived more than 60s', async () => {
    const children: FakeChild[] = [];
    const sleeps: number[] = [];
    const ac = new AbortController();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const run = runSupervisor(
        {
          mode: 'quick',
          target: 'http://app:3000',
          urlFile: file,
          log: () => {},
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          spawn: () => {
            const c = new FakeChild();
            children.push(c);
            return c;
          },
        },
        ac.signal,
      );

      await tick();
      at(children, 0).exit(1);
      await tick();
      expect(sleeps).toEqual([1_000]);

      nowSpy.mockReturnValue(61_000);
      at(children, 1).exit(1);
      await tick();
      // Second child lived > 60s, so attempt resets to 0 -> next delay is 1_000 again.
      expect(sleeps).toEqual([1_000, 1_000]);

      ac.abort();
      at(children, 2).exit(0);
      await run;
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('kills the running child and stops the loop on abort', async () => {
    const children: FakeChild[] = [];
    const ac = new AbortController();
    const run = runSupervisor(
      {
        mode: 'quick',
        target: 'http://app:3000',
        urlFile: file,
        log: () => {},
        sleep: async () => {},
        spawn: () => {
          const c = new FakeChild();
          children.push(c);
          return c;
        },
      },
      ac.signal,
    );

    await tick();
    ac.abort();
    await tick();
    expect(at(children, 0).killed).toBe(true);

    at(children, 0).exit(0);
    await run;
    expect(children).toHaveLength(1);
  });

  it('stops promptly on abort even while waiting out a backoff delay', async () => {
    const children: FakeChild[] = [];
    const ac = new AbortController();
    const run = runSupervisor(
      {
        mode: 'quick',
        target: 'http://app:3000',
        urlFile: file,
        log: () => {},
        // Never resolves on its own — proves abort short-circuits the wait
        // rather than blocking runSupervisor for the full backoff delay.
        sleep: () => new Promise<void>(() => {}),
        spawn: () => {
          const c = new FakeChild();
          children.push(c);
          return c;
        },
      },
      ac.signal,
    );

    await tick();
    at(children, 0).exit(1);
    await tick();
    expect(children).toHaveLength(1);

    ac.abort();
    await run;
    expect(children).toHaveLength(1);
  });
});
