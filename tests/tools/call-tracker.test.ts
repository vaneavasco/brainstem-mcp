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
