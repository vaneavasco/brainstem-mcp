import { describe, expect, it } from 'vitest';
import { runStart } from '../../src/cli/commands/start.ts';

describe('runStart', () => {
  it('runs setup only when .env is missing, then up', async () => {
    const calls: string[] = [];
    const code = await runStart({
      doctor: async () => {
        calls.push('doctor');
        return 0;
      },
      hasEnv: async () => false,
      setup: async () => {
        calls.push('setup');
      },
      up: async () => {
        calls.push('up');
        return 0;
      },
      print() {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['doctor', 'setup', 'up']);

    const calls2: string[] = [];
    await runStart({
      doctor: async () => 0,
      hasEnv: async () => true,
      setup: async () => {
        calls2.push('setup');
      },
      up: async () => {
        calls2.push('up');
        return 0;
      },
      print() {},
    });
    expect(calls2).toEqual(['up']);
  });

  it('runs the full doctor once .env exists, prerequisites only on a first run', async () => {
    // A configured instance can be broken in every way doctor knows about —
    // bad OWNER_SECRET, a vault path that moved, a port taken by something
    // else. Only a first run, where `.env` does not exist yet, has to stop at
    // the machine-level checks.
    const seen: boolean[] = [];
    const doctor = async (opts: { prerequisitesOnly: boolean }) => {
      seen.push(opts.prerequisitesOnly);
      return 0;
    };
    await runStart({
      doctor,
      hasEnv: async () => false,
      setup: async () => {},
      up: async () => 0,
      print() {},
    });
    await runStart({
      doctor,
      hasEnv: async () => true,
      setup: async () => {
        throw new Error('must not run');
      },
      up: async () => 0,
      print() {},
    });
    expect(seen).toEqual([true, false]);
  });

  it('stops when prerequisites fail', async () => {
    const code = await runStart({
      doctor: async () => 1,
      hasEnv: async () => false,
      setup: async () => {
        throw new Error('must not run');
      },
      up: async () => 0,
      print() {},
    });
    expect(code).toBe(1);
  });
});
