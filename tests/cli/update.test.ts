import { describe, expect, it } from 'vitest';
import { runUpdate } from '../../src/cli/commands/update.ts';

describe('runUpdate', () => {
  it('pulls, installs and restarts in a child process', async () => {
    const ran: string[] = [];
    let sha = 'aaa1111';
    const code = await runUpdate({
      exec: async (cmd, args) => {
        const k = [cmd, ...args].join(' ');
        if (k === 'git rev-parse --short HEAD') return { code: 0, stdout: `${sha}\n`, stderr: '' };
        if (k === 'git pull --ff-only') {
          sha = 'bbb2222';
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      run: async (cmd, args) => {
        ran.push([cmd, ...args].join(' '));
        return 0;
      },
      print() {},
    });
    expect(code).toBe(0);
    expect(ran).toEqual(['npm ci --omit=dev', 'node src/cli/brainstem.ts up --build']);
  });

  it('refuses to update over local changes', async () => {
    const code = await runUpdate({
      exec: async (_cmd, args) => ({
        code: args[0] === 'pull' ? 1 : 0,
        stdout: 'abc1234\n',
        stderr: 'diverged',
      }),
      run: async () => 0,
      print() {},
    });
    expect(code).toBe(1);
  });
});
