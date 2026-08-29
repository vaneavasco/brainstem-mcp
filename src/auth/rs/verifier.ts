import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from '../../logger.ts';
import { sha256hex } from '../hash.ts';
import type { TokenRecord, TokenStore } from '../store/types.ts';

/**
 * How stale `lastUsedAt` may get before a verification refreshes it. Every
 * write goes to the state file in the (synced) vault, so writing on every
 * /mcp request would turn normal use into a stream of sync events; 5 minutes
 * keeps the field useful for "when did this client last talk to us" without
 * that churn.
 */
export const LAST_USED_WRITE_INTERVAL_MS = 300_000;

export function createTokenVerifier(
  store: TokenStore,
  mcpUrl: URL,
  now: () => number,
  logger?: Logger,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const hash = sha256hex(token);
      let rec: TokenRecord | undefined;
      try {
        rec = await store.getToken(hash);
      } catch (err: unknown) {
        if (err instanceof OAuthError) throw err;
        // A corrupt or unreadable state file is our problem, not the client's:
        // say so as a proper OAuth error (503-ish `server_error`) instead of
        // letting a raw throw surface as an opaque 500 with no log line.
        logger?.error({ err }, 'token store unavailable');
        throw new OAuthError(OAuthErrorCode.ServerError, 'token store unavailable');
      }
      const t = now();
      if (
        rec?.kind !== 'access' ||
        rec.revokedAt !== undefined ||
        rec.expiresAt <= t ||
        rec.resource !== mcpUrl.href
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid or expired access token');
      }
      // Fire-and-forget, and only when the recorded value is actually stale:
      // never block the response on this bookkeeping write, and never write it
      // on every request (see LAST_USED_WRITE_INTERVAL_MS). A rejected promise
      // with no handler crashes the process under Node's default
      // --unhandled-rejections=throw, so catch and log instead.
      if (rec.lastUsedAt === undefined || t - rec.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
        store
          .updateToken(hash, { lastUsedAt: t })
          .catch((err: unknown) => logger?.warn({ err }, 'lastUsedAt write failed'));
      }
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
