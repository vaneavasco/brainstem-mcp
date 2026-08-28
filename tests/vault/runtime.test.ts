import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalRuntime, DEFAULT_VAULT_SETTINGS } from '../../src/vault/runtime.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-runtime-'));
  await fs.writeFile(path.join(root, 'seed.md'), '---\ntype: seed\n---\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createLocalRuntime', () => {
  it('builds adapter + index with defaults and closes cleanly', async () => {
    const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
    expect(runtime.adapter.capabilities().watch).toBe(true);
    expect(runtime.index.get('seed.md')?.frontmatter).toEqual({ type: 'seed' });
    expect(runtime.settings).toEqual(DEFAULT_VAULT_SETTINGS);
    expect(runtime.settings.dailyNotes.format).toBe('yyyy-MM-dd');
    expect(runtime.now()).toBeInstanceOf(Date);
    expect(runtime.caches).toEqual({});
    await runtime.close();
  });

  it('applies partial settings overrides deeply', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      settings: {
        dailyNotes: { folder: 'journal', timezone: 'Europe/Chisinau' } as never,
        requiredFrontmatter: ['type'],
      },
    });
    expect(runtime.settings.dailyNotes).toEqual({
      folder: 'journal',
      format: 'yyyy-MM-dd',
      template: null,
      timezone: 'Europe/Chisinau',
    });
    expect(runtime.settings.requiredFrontmatter).toEqual(['type']);
    await runtime.close();
  });
});
