import { describe, expect, it } from 'vitest';
import { createOwnerResolver } from '../../src/auth/context.ts';
import type { VaultRuntime } from '../../src/vault/runtime.ts';

describe('createOwnerResolver', () => {
  it('returns the runtime for the owner and refuses anything else', async () => {
    const runtime = {} as VaultRuntime;
    const resolve = createOwnerResolver(runtime);
    await expect(
      resolve({
        era: 'modern',
        authInfo: { token: 't', clientId: 'c', scopes: ['vault'], extra: { userId: 'owner' } },
      }),
    ).resolves.toBe(runtime);
    await expect(resolve({ era: 'modern' })).rejects.toThrow(/unauthenticated/);
    await expect(
      resolve({
        era: 'modern',
        authInfo: { token: 't', clientId: 'c', scopes: [], extra: { userId: 'bob' } },
      }),
    ).rejects.toThrow();
  });
});
