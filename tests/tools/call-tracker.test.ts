import { describe, expect, it } from 'vitest';
import { CallTracker } from '../../src/tools/call-tracker.ts';

describe('CallTracker', () => {
  it('drain waits for every running call, including one that fails', async () => {
    const calls = new CallTracker();
    const release: (() => void)[] = [];
    const held = () => new Promise<void>((resolve) => release.push(resolve));
    const first = calls.run(held);
    const second = calls.run(async () => {
      await held();
      throw new Error('boom');
    });
    let drained = false;
    const drain = calls.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    release[0]?.();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    release[1]?.();
    await expect(second).rejects.toThrow('boom');
    await drain;
    expect(drained).toBe(true);
  });

  it('is open until a drain is asked for, closed from then on; an idle drain resolves', async () => {
    const calls = new CallTracker();
    expect(calls.closed).toBe(false);
    await calls.drain();
    expect(calls.closed).toBe(true);
  });

  it('a call arriving in the same turn as the drain is still run', async () => {
    const calls = new CallTracker();
    const drain = calls.drain();
    expect(calls.closed).toBe(false);
    let ran = false;
    await calls.run(async () => {
      ran = true;
    });
    await drain;
    expect(ran).toBe(true);
  });
});

describe('CallTracker under a client that never pauses', () => {
  it('stops admitting calls a bounded time after the drain began, however busy the client', async () => {
    const calls = new CallTracker();
    let stop = false;
    // a call every 20 ms: far inside the quiet period, so quiet alone would never close the door
    const pump = (async () => {
      while (!stop) {
        if (!calls.closed) await calls.run(() => new Promise((r) => setTimeout(r, 5)));
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const started = performance.now();
    await calls.drain(100, 400);
    const took = performance.now() - started;
    stop = true;
    await pump;
    expect(calls.closed).toBe(true);
    expect(took).toBeLessThan(1_500);
    expect(took).toBeGreaterThanOrEqual(380);
  });
});
