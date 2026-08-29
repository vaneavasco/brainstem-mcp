import { describe, expect, it } from 'vitest';
import { runUpdate } from '../../src/cli/commands/update.ts';

describe('runUpdate', () => {
  it('pulls, installs and restarts in a child process', async () => {
    const ran: string[][] = [];
    const gitCwds: (string | undefined)[] = [];
    let sha = 'aaa1111';
    const code = await runUpdate({
      cwd: '/repo',
      exec: async (cmd, args, opts) => {
        gitCwds.push(opts?.cwd);
        const k = [cmd, ...args].join(' ');
        if (k === 'git rev-parse --short HEAD') return { code: 0, stdout: `${sha}\n`, stderr: '' };
        if (k === 'git pull --ff-only') {
          sha = 'bbb2222';
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      run: async (cmd, args) => {
        ran.push([cmd, ...args]);
        return 0;
      },
      print() {},
    });
    expect(code).toBe(0);
    expect(ran[0]).toEqual(['npm', 'ci', '--omit=dev']);
    // The restart re-execs *this* interpreter, not whatever `node` PATH resolves
    // to — `./brainstem` may well have been started by a different install.
    expect(ran[1]?.[0]).toBe(process.execPath);
    expect(ran[1]?.slice(1)).toEqual(['src/cli/brainstem.ts', 'up', '--build']);
    // Every git call is anchored to the repo, never to whatever directory the
    // CLI happened to be started from.
    expect(gitCwds).toEqual(['/repo', '/repo', '/repo']);
  });

  it('refuses to update over local changes', async () => {
    const code = await runUpdate({
      cwd: '/repo',
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

  it("prints git's own stderr before the hint, whatever the pull failed on", async () => {
    const lines: string[] = [];
    const code = await runUpdate({
      cwd: '/repo',
      exec: async (_cmd, args) => ({
        code: args[0] === 'pull' ? 1 : 0,
        stdout: 'abc1234\n',
        stderr: args[0] === 'pull' ? 'fatal: Could not resolve host: github.com\n' : '',
      }),
      run: async () => {
        throw new Error('must not run');
      },
      print: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    // The real cause has to survive: "local changes or diverged history" is a
    // lie when the machine is simply offline.
    expect(lines[0]).toBe('fatal: Could not resolve host: github.com');
    expect(lines[1]).toMatch(/git pull failed/);
  });

  it('reports a failing git rev-parse instead of pretending HEAD is empty', async () => {
    const lines: string[] = [];
    const code = await runUpdate({
      cwd: '/repo',
      exec: async () => ({
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      }),
      run: async () => {
        throw new Error('must not run');
      },
      print: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain('not a git repository');
    expect(lines[1]).toMatch(/not a git checkout/);
  });
});
