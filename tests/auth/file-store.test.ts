import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomToken, sha256hex } from '../../src/auth/hash.ts';
import { FileTokenStore, StoreCorruptError } from '../../src/auth/store/file-store.ts';
import type { TokenRecord } from '../../src/auth/store/types.ts';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-store-'));
  file = path.join(dir, '_brainstem', 'state.json');
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const tok = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  kind: 'access',
  familyId: 'fam1',
  clientId: 'https://claude.ai/c',
  clientName: 'Claude',
  resource: 'https://b.example.com/mcp',
  scope: 'vault',
  expiresAt: 2_000,
  ...over,
});

describe('hash helpers', () => {
  it('sha256hex is deterministic lowercase hex; randomToken is base64url of 32 bytes', () => {
    expect(sha256hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('FileTokenStore', () => {
  it('creates the file on open and round-trips records atomically', async () => {
    const store = await FileTokenStore.open(file);
    await store.putToken(sha256hex('t1'), tok());
    expect(await store.getToken(sha256hex('t1'))).toMatchObject({
      kind: 'access',
      familyId: 'fam1',
    });
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
      version: number;
      tokens: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.tokens)).toEqual([sha256hex('t1')]);
    expect(await fs.readdir(path.dirname(file))).toEqual(['state.json']); // no leftover .tmp
  });

  it('consumeCode is single-use and expiry-aware', async () => {
    const store = await FileTokenStore.open(file);
    await store.putCode('h', { pendingId: 'p', expiresAt: 1_000 });
    expect(await store.consumeCode('h', 1_500)).toBeUndefined(); // expired
    await store.putCode('h2', { pendingId: 'p', expiresAt: 5_000 });
    expect(await store.consumeCode('h2', 1_000)).toMatchObject({ pendingId: 'p' });
    expect(await store.consumeCode('h2', 1_001)).toBeUndefined(); // used
  });

  it('revokeFamily and revokeAll stamp revokedAt; sweepExpired drops dead rows', async () => {
    const store = await FileTokenStore.open(file);
    await store.putToken('a', tok({ familyId: 'f1' }));
    await store.putToken('b', tok({ familyId: 'f1', kind: 'refresh', expiresAt: 9_000 }));
    await store.putToken('c', tok({ familyId: 'f2' }));
    expect(await store.revokeFamily('f1', 100)).toBe(2);
    expect((await store.getToken('a'))?.revokedAt).toBe(100);
    expect((await store.getToken('c'))?.revokedAt).toBeUndefined();
    await store.sweepExpired(2_500); // a (expired 2000) and c (expired 2000) gone, b stays (9000)
    expect(await store.getToken('a')).toBeUndefined();
    expect(await store.getToken('b')).toBeDefined();
    expect(await store.revokeAll(200)).toBe(1);
  });

  it('serialises concurrent mutations without losing writes', async () => {
    const store = await FileTokenStore.open(file);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.putToken(`h${i}`, tok())));
    const reopened = await FileTokenStore.open(file);
    let n = 0;
    for (let i = 0; i < 50; i++) if (await reopened.getToken(`h${i}`)) n++;
    expect(n).toBe(50);
  });

  it('reloads when another process changed the file', async () => {
    const a = await FileTokenStore.open(file);
    const b = await FileTokenStore.open(file);
    await a.putToken('x', tok());
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.getToken('x')).toBeDefined();
  });

  it('rolls back in-memory state when a write fails, and stays usable afterward', async () => {
    const store = await FileTokenStore.open(file);
    await store.putToken('good', tok());
    const stateDir = path.dirname(file);
    await fs.rm(stateDir, { recursive: true, force: true }); // next write will fail (ENOENT)
    await expect(store.putToken('bad', tok())).rejects.toThrow();
    expect(await store.getToken('bad')).toBeUndefined(); // rolled back, not just unpersisted
    await fs.mkdir(stateDir, { recursive: true }); // conditions recover
    await store.putToken('again', tok()); // the queue isn't wedged by the earlier failure
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { tokens: Record<string, unknown> };
    expect(Object.keys(raw.tokens).sort()).toEqual(['again', 'good']);
  });

  it('refuses a corrupt or newer file with StoreCorruptError naming the path', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    await expect(FileTokenStore.open(file)).rejects.toBeInstanceOf(StoreCorruptError);
    await fs.writeFile(
      file,
      JSON.stringify({ version: 2, clients: {}, pending: {}, codes: {}, tokens: {} }),
    );
    await expect(FileTokenStore.open(file)).rejects.toThrow(file);
  });
});
