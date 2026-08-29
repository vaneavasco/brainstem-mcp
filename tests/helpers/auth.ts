import path from 'node:path';
import { randomToken, sha256hex } from '../../src/auth/hash.ts';
import { type AuthDeps, createAuth } from '../../src/auth/mount.ts';
import { FileTokenStore } from '../../src/auth/store/file-store.ts';
import type { TokenRecord } from '../../src/auth/store/types.ts';
import type { Config } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';

export async function createTestAuth(
  config: Config,
  root: string,
  over: Parameters<typeof createAuth>[3] = {},
): Promise<{
  auth: AuthDeps;
  store: FileTokenStore;
  issueAccessToken(over?: Partial<TokenRecord>): Promise<string>;
}> {
  const store = await FileTokenStore.open(path.join(root, '_brainstem', 'state.json'));
  const auth = createAuth(config, createLogger('fatal'), store, over);
  return {
    auth,
    store,
    async issueAccessToken(o: Partial<TokenRecord> = {}): Promise<string> {
      const token = randomToken();
      await store.putToken(sha256hex(token), {
        kind: 'access',
        familyId: randomToken(8),
        clientId: 'https://claude.ai/oauth/test-client',
        clientName: 'Test',
        resource: config.mcpUrl.href,
        scope: 'vault',
        expiresAt: Date.now() + 3_600_000,
        ...o,
      });
      return token;
    },
  };
}
