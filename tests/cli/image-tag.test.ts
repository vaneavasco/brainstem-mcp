import { describe, expect, it } from 'vitest';
import { resolveImageTag } from '../../src/cli/image-tag.ts';

type Exec = Parameters<typeof resolveImageTag>[0];

function fakeExec(answers: Record<string, { code: number; stdout: string }>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const a = answers[key];
    if (!a) return { code: 1, stdout: '', stderr: `unexpected: ${key}` };
    return { ...a, stderr: '' };
  };
}

describe('resolveImageTag', () => {
  it('maps a clean checkout to the sha-<7> tag CI publishes', async () => {
    const tag = await resolveImageTag(
      fakeExec({
        'git rev-parse --short=7 HEAD': { code: 0, stdout: 'abc1234\n' },
        'git status --porcelain': { code: 0, stdout: '' },
      }),
      '/repo',
    );
    expect(tag).toBe('sha-abc1234');
  });

  it('returns null for a dirty tree — a prebuilt image would not contain the local edits', async () => {
    const tag = await resolveImageTag(
      fakeExec({
        'git rev-parse --short=7 HEAD': { code: 0, stdout: 'abc1234\n' },
        'git status --porcelain': { code: 0, stdout: ' M src/app.ts\n' },
      }),
      '/repo',
    );
    expect(tag).toBeNull();
  });

  it('returns null outside a git checkout or when git is missing', async () => {
    expect(await resolveImageTag(fakeExec({}), '/repo')).toBeNull();
    const throwing: Exec = async () => {
      throw new Error('spawn git ENOENT');
    };
    expect(await resolveImageTag(throwing, '/repo')).toBeNull();
  });

  it('runs git in the repo directory, not the caller cwd', async () => {
    const cwds: (string | undefined)[] = [];
    await resolveImageTag(async (_c, _a, opts) => {
      cwds.push(opts?.cwd);
      return { code: 0, stdout: 'abc1234\n', stderr: '' };
    }, '/repo');
    expect(cwds).toEqual(['/repo', '/repo']);
  });
});
