import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from '../../logger.ts';
import { sha256hex } from '../hash.ts';
import type { TokenStore } from '../store/types.ts';

export function createTokenVerifier(
  store: TokenStore,
  mcpUrl: URL,
  now: () => number,
  logger?: Logger,
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
      // Fire-and-forget: never block the response on this bookkeeping write,
      // but a rejected promise with no handler crashes the process under
      // Node's default --unhandled-rejections=throw, so catch and log instead.
      store
        .updateToken(hash, { lastUsedAt: t })
        .catch((err: unknown) => logger?.warn({ err }, 'lastUsedAt write failed'));
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
