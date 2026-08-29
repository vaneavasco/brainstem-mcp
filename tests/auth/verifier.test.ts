import { OAuthError } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createTokenVerifier, LAST_USED_WRITE_INTERVAL_MS } from '../../src/auth/rs/verifier.ts';
import type { TokenRecord, TokenStore } from '../../src/auth/store/types.ts';
import { createLogger } from '../../src/logger.ts';

const MCP_URL = new URL('https://brainstem.example.com/mcp');

function tok(over: Partial<TokenRecord> = {}): TokenRecord {
  return {
    kind: 'access',
    familyId: 'fam1',
    clientId: 'https://claude.ai/oauth/test-client',
    clientName: 'Test Client',
    resource: MCP_URL.href,
    scope: 'vault',
    expiresAt: Date.now() + 3_600_000,
    ...over,
  };
}

function stubStore(
  rec: TokenRecord | undefined,
  updateToken: TokenStore['updateToken'] = async () => {},
): TokenStore {
  return {
    getToken: async () => rec,
    updateToken,
  } as unknown as TokenStore;
}

describe('createTokenVerifier', () => {
  it('resolves an AuthInfo matching the resource-server contract for a valid token', async () => {
    const rec = tok();
    const verifier = createTokenVerifier(stubStore(rec), MCP_URL, () => Date.now());
    const info = await verifier.verifyAccessToken('plaintext-token');
    expect(info.token).toBe('plaintext-token');
    expect(info.clientId).toBe(rec.clientId);
    expect(info.scopes).toEqual(['vault']);
    expect(info.resource?.href).toBe(MCP_URL.href);
    expect(info.extra?.userId).toBe('owner');
    expect(info.extra?.clientName).toBe(rec.clientName);
    // expiresAt on AuthInfo is seconds (rec.expiresAt is milliseconds).
    expect(info.expiresAt).toBe(Math.floor(rec.expiresAt / 1000));
  });

  it('resolves (never rejects) and never produces an unhandled rejection when the lastUsedAt write fails', async () => {
    const rec = tok();
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const store = stubStore(rec, async () => {
      throw new Error('disk full');
    });
    const verifier = createTokenVerifier(store, MCP_URL, () => Date.now(), logger);

    let unhandled: unknown;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // Must resolve, not reject, even though the background write fails.
      const info = await verifier.verifyAccessToken('plaintext-token');
      expect(info.clientId).toBe(rec.clientId);
      // Give the fire-and-forget write's rejection handler a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
    expect(unhandled).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'lastUsedAt write failed',
    );
  });

  it('writes lastUsedAt at most once per interval, not on every request', async () => {
    // The state file lives in a synced vault, so a write per /mcp call is a
    // sync event per call.
    const rec = tok({ expiresAt: 9_000_000_000 });
    let writes = 0;
    const store = {
      getToken: async () => rec,
      updateToken: async (_hash: string, patch: Partial<TokenRecord>) => {
        writes++;
        Object.assign(rec, patch);
      },
    } as unknown as TokenStore;
    let t = 1_000_000;
    const verifier = createTokenVerifier(store, MCP_URL, () => t);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    await verifier.verifyAccessToken('x');
    await settle();
    expect(writes).toBe(1); // first use: lastUsedAt was absent

    t += 60_000;
    await verifier.verifyAccessToken('x');
    await settle();
    expect(writes).toBe(1); // within the interval: no write

    t += LAST_USED_WRITE_INTERVAL_MS;
    await verifier.verifyAccessToken('x');
    await settle();
    expect(writes).toBe(2);
  });

  it('turns an unavailable store into a server_error, logged, not a bare 500', async () => {
    const logger = createLogger('fatal');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const store = {
      getToken: async () => {
        throw new Error('state file vanished');
      },
      updateToken: async () => {},
    } as unknown as TokenStore;
    const verifier = createTokenVerifier(store, MCP_URL, () => Date.now(), logger);

    const rejection = await verifier.verifyAccessToken('x').catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(OAuthError);
    expect((rejection as OAuthError).code).toBe('server_error');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'token store unavailable',
    );
  });

  it('rejects when the token is missing, wrong kind, revoked, expired or for another resource', async () => {
    const now = () => 10_000;
    await expect(
      createTokenVerifier(stubStore(undefined), MCP_URL, now).verifyAccessToken('x'),
    ).rejects.toThrow();
    await expect(
      createTokenVerifier(stubStore(tok({ kind: 'refresh' })), MCP_URL, now).verifyAccessToken('x'),
    ).rejects.toThrow();
    await expect(
      createTokenVerifier(stubStore(tok({ revokedAt: 1 })), MCP_URL, now).verifyAccessToken('x'),
    ).rejects.toThrow();
    await expect(
      createTokenVerifier(stubStore(tok({ expiresAt: 9_999 })), MCP_URL, now).verifyAccessToken(
        'x',
      ),
    ).rejects.toThrow();
    await expect(
      createTokenVerifier(
        stubStore(tok({ resource: 'https://other.example.com/mcp' })),
        MCP_URL,
        now,
      ).verifyAccessToken('x'),
    ).rejects.toThrow();
  });
});
