import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { sha256hex } from '../hash.ts';
import type { TokenStore } from '../store/types.ts';

export function createTokenVerifier(
  store: TokenStore,
  mcpUrl: URL,
  now: () => number,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const hash = sha256hex(token);
      const rec = await store.getToken(hash);
      const t = now();
      if (
        rec?.kind !== 'access' ||
        rec.revokedAt !== undefined ||
        rec.expiresAt <= t ||
        rec.resource !== mcpUrl.href
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid or expired access token');
      }
      void store.updateToken(hash, { lastUsedAt: t });
      return {
        token,
        clientId: rec.clientId,
        scopes: rec.scope.split(' ').filter(Boolean),
        expiresAt: Math.floor(rec.expiresAt / 1000),
        resource: new URL(rec.resource),
        extra: { userId: 'owner', clientName: rec.clientName },
      };
    },
  };
}
