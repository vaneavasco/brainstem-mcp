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
