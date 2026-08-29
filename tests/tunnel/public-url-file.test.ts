import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parsePublicUrlFile,
  waitForPublicUrl,
  watchPublicUrl,
} from '../../src/tunnel/public-url-file.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-public-url-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('parsePublicUrlFile', () => {
  it('parses the first line as a URL and ignores junk', () => {
    expect(parsePublicUrlFile('https://a-b.trycloudflare.com\n')).toBe(
      'https://a-b.trycloudflare.com',
    );
    expect(parsePublicUrlFile('')).toBeNull();
    expect(parsePublicUrlFile('nope')).toBeNull();
  });
});

describe('waitForPublicUrl', () => {
  it('resolves once the file appears and times out otherwise', async () => {
    const file = path.join(dir, 'public-url');
    setTimeout(() => {
      void fs.writeFile(file, 'https://x.trycloudflare.com\n');
    }, 150);
    await expect(waitForPublicUrl(file, { timeoutMs: 2_000, intervalMs: 50 })).resolves.toBe(
      'https://x.trycloudflare.com',
    );
    await expect(
      waitForPublicUrl(path.join(dir, 'missing'), { timeoutMs: 200, intervalMs: 50 }),
    ).rejects.toThrow(/did not come up/);
  });
});

describe('watchPublicUrl', () => {
  it('fires once when the content changes', async () => {
    const file = path.join(dir, 'public-url');
    await fs.writeFile(file, 'https://one.trycloudflare.com');
    const seen: string[] = [];
    const stop = watchPublicUrl(file, 'https://one.trycloudflare.com', (n) => seen.push(n), 50);
    await new Promise((r) => setTimeout(r, 120));
    await fs.writeFile(file, 'https://two.trycloudflare.com');
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(seen).toEqual(['https://two.trycloudflare.com']);
  });
});
