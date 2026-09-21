import { describe, expect, it } from 'vitest';
import { tunnelUrlReader } from '../../src/cli/tunnel-url.ts';

const env = (o: Record<string, string>) => new Map(Object.entries(o));

describe('tunnelUrlReader', () => {
  it('maps the container path of the URL file onto the vault on the host', async () => {
    const seen: string[] = [];
    const read = tunnelUrlReader(
      env({ VAULT_PATH: '/home/u/vault', PUBLIC_URL_FILE: '/vault/_brainstem/public-url' }),
      async (p) => {
        seen.push(p);
        return 'https://alpha.trycloudflare.com\n';
      },
    );
    expect(await read()).toBe('https://alpha.trycloudflare.com');
    expect(seen).toEqual(['/home/u/vault/_brainstem/public-url']);
  });

  it('answers null while the file is missing, empty or not a bare https origin', async () => {
    const base = { VAULT_PATH: '/home/u/vault', PUBLIC_URL_FILE: '/vault/_brainstem/public-url' };
    const missing = tunnelUrlReader(env(base), async () => {
      throw new Error('ENOENT');
    });
    expect(await missing()).toBeNull();
    for (const text of ['', 'not a url', 'http://alpha.example', 'https://alpha.example/path']) {
      expect(await tunnelUrlReader(env(base), async () => text)()).toBeNull();
    }
  });

  it('never reads outside the vault', async () => {
    let read = false;
    const reader = tunnelUrlReader(
      env({ VAULT_PATH: '/home/u/vault', PUBLIC_URL_FILE: '/etc/passwd' }),
      async () => {
        read = true;
        return 'https://alpha.example';
      },
    );
    expect(await reader()).toBeNull();
    expect(read).toBe(false);
    expect(
      await tunnelUrlReader(
        env({ PUBLIC_URL_FILE: '/vault/x' }),
        async () => 'https://a.example',
      )(),
    ).toBeNull();
  });
});
