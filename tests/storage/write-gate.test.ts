import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import { assertExpectedHash, WriteGate } from '../../src/storage/write-gate.ts';

/** Rejects if `promise` has not settled within `ms` — guards against a real deadlock hanging CI. */
function withTimeoutGuard<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms — possible deadlock`)), ms);
    }),
  ]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('WriteGate', () => {
  it('serialises two locks on the same path in request order', async () => {
    const gate = new WriteGate();
    const events: string[] = [];
    const first = deferred<void>();

    const a = gate.withLock(['a'], async () => {
      events.push('a-enter');
      await first.promise;
      events.push('a-exit');
    });
    // Give `a` a chance to actually acquire the lock before `b` requests it.
    await new Promise((r) => setTimeout(r, 10));

    const b = gate.withLock(['a'], async () => {
      events.push('b-enter');
      events.push('b-exit');
    });

    // b must not have entered yet — a still holds the lock.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['a-enter']);

    first.resolve();
    await withTimeoutGuard(Promise.all([a, b]));
    expect(events).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('locks paths in sorted order regardless of the order requested, so cross-order acquisition never deadlocks', async () => {
    const gate = new WriteGate();
    const order: string[] = [];

    const run1 = gate.withLock(['b', 'a'], async () => {
      order.push('run1');
      await new Promise((r) => setTimeout(r, 20));
    });
    const run2 = gate.withLock(['a', 'b'], async () => {
      order.push('run2');
      await new Promise((r) => setTimeout(r, 20));
    });

    await withTimeoutGuard(Promise.all([run1, run2]));
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['run1', 'run2']));
  });

  it('dedupes repeated paths in a single call', async () => {
    const gate = new WriteGate();
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
    };
    await withTimeoutGuard(
      Promise.all([gate.withLock(['x', 'x'], run), gate.withLock(['x'], run)]),
    );
    expect(maxConcurrent).toBe(1);
  });

  it('releases the lock even when fn throws, so a later caller is not blocked forever', async () => {
    const gate = new WriteGate();
    await expect(
      gate.withLock(['p'], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    let ran = false;
    await withTimeoutGuard(
      gate.withLock(['p'], async () => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
  });

  it('allows unrelated paths to run fully concurrently', async () => {
    const gate = new WriteGate();
    const events: string[] = [];
    const gate1 = deferred<void>();

    const p1 = gate.withLock(['one'], async () => {
      events.push('one-enter');
      await gate1.promise;
      events.push('one-exit');
    });
    await new Promise((r) => setTimeout(r, 10));

    const p2 = gate.withLock(['two'], async () => {
      events.push('two-enter');
      events.push('two-exit');
    });
    await withTimeoutGuard(p2);
    expect(events).toEqual(['one-enter', 'two-enter', 'two-exit']);
    gate1.resolve();
    await withTimeoutGuard(p1);
  });

  it('prunes a path from its internal map once its lock chain is fully released', async () => {
    const gate = new WriteGate();
    expect(gate.pendingCount).toBe(0);
    await withTimeoutGuard(gate.withLock(['solo'], async () => {}));
    expect(gate.pendingCount).toBe(0);

    // Multiple distinct keys, all released — none should linger.
    await withTimeoutGuard(
      Promise.all([
        gate.withLock(['a'], async () => {}),
        gate.withLock(['b', 'c'], async () => {}),
      ]),
    );
    expect(gate.pendingCount).toBe(0);
  });

  it('keeps a path entry only while a later caller is still queued behind an earlier one', async () => {
    const gate = new WriteGate();
    const first = deferred<void>();

    const p1 = gate.withLock(['q'], async () => {
      await first.promise;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.pendingCount).toBe(1); // the first holder's own chain entry

    const p2 = gate.withLock(['q'], async () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.pendingCount).toBe(1); // still one entry — the second caller's chained promise

    first.resolve();
    await withTimeoutGuard(Promise.all([p1, p2]));
    expect(gate.pendingCount).toBe(0); // fully drained once both releases have run
  });
});

describe('assertExpectedHash', () => {
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  it('passes when expected is undefined (no concurrency check requested)', () => {
    expect(() => assertExpectedHash('note.md', hashA, undefined)).not.toThrow();
    expect(() => assertExpectedHash('note.md', null, undefined)).not.toThrow();
  });

  it('passes when the current hash matches expected', () => {
    expect(() => assertExpectedHash('note.md', hashA, hashA)).not.toThrow();
  });

  it('throws CONFLICT with details.currentHash when the current hash differs', () => {
    try {
      assertExpectedHash('note.md', hashB, hashA);
      throw new Error('expected assertExpectedHash to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      const e = error as VaultError;
      expect(e.code).toBe('CONFLICT');
      expect(e.message).toContain('note.md');
      expect(e.message).toContain(hashA.slice(0, 12));
      expect(e.message).toContain(hashB.slice(0, 12));
      expect(e.details).toEqual({ path: 'note.md', currentHash: hashB });
    }
  });

  it('throws CONFLICT with currentHash null when the file is missing', () => {
    try {
      assertExpectedHash('note.md', null, hashA);
      throw new Error('expected assertExpectedHash to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      const e = error as VaultError;
      expect(e.code).toBe('CONFLICT');
      expect(e.message).toContain('missing');
      expect(e.details).toEqual({ path: 'note.md', currentHash: null });
    }
  });
});
