import { createHash, timingSafeEqual } from 'node:crypto';
import { type Request, type Response, Router, urlencoded } from 'express';
import type { Config } from '../../config.ts';
import type { Logger } from '../../logger.ts';
import { randomToken, sha256hex } from '../hash.ts';
import { type AuthDeps, createRateLimiter } from '../mount.ts';
import type { TokenRecord, TokenStore } from '../store/types.ts';

export const ROTATION_GRACE_MS = 60_000;

const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 §4.6: `code_challenge === base64url(sha256(code_verifier))`. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!CODE_VERIFIER_RE.test(codeVerifier)) return false;
  const digest = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return (
    digest.length === codeChallenge.length &&
    timingSafeEqual(Buffer.from(digest), Buffer.from(codeChallenge))
  );
}

function strParam(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function noStore(res: Response): void {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

function invalidRequest(res: Response, description: string): void {
  res.status(400).json({ error: 'invalid_request', error_description: description });
}

function invalidGrant(res: Response): void {
  res.status(400).json({ error: 'invalid_grant' });
}

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type IssueBase = Pick<TokenRecord, 'familyId' | 'clientId' | 'clientName' | 'resource' | 'scope'>;

/** Mints a fresh access/refresh pair sharing `base`'s family and binding fields. */
async function issuePair(
  store: TokenStore,
  now: number,
  cfg: Config,
  base: IssueBase,
): Promise<TokenResponse> {
  const access = randomToken();
  const refresh = randomToken();
  await store.putToken(sha256hex(access), {
    ...base,
    kind: 'access',
    expiresAt: now + cfg.accessTokenTtlS * 1000,
  });
  await store.putToken(sha256hex(refresh), {
    ...base,
    kind: 'refresh',
    expiresAt: now + cfg.refreshTokenTtlS * 1000,
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: cfg.accessTokenTtlS,
    refresh_token: refresh,
    scope: base.scope,
  };
}

async function handleAuthorizationCode(
  req: Request,
  res: Response,
  config: Config,
  logger: Logger,
  auth: AuthDeps,
): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const code = strParam(body.code);
  const clientId = strParam(body.client_id);
  const redirectUri = strParam(body.redirect_uri);
  const codeVerifier = strParam(body.code_verifier);
  const resource = strParam(body.resource);
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    invalidRequest(res, 'code, client_id, redirect_uri and code_verifier are required');
    return;
  }

  const now = auth.now();
  const rec = await auth.store.consumeCode(sha256hex(code), now);
  if (
    !rec ||
    rec.clientId !== clientId ||
    rec.redirectUri !== redirectUri ||
    !verifyPkceS256(codeVerifier, rec.codeChallenge) ||
    (resource && resource !== rec.resource)
  ) {
    invalidGrant(res);
    return;
  }

  const familyId = randomToken(16);
  const pair = await issuePair(auth.store, now, config, {
    familyId,
    clientId: rec.clientId,
    clientName: rec.clientName,
    resource: rec.resource,
    scope: rec.scope,
  });
  logger.info({ clientName: rec.clientName, familyId }, 'oauth token issued');
  res.status(200).json(pair);
}

async function handleRefreshToken(
  req: Request,
  res: Response,
  config: Config,
  logger: Logger,
  auth: AuthDeps,
): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const refreshToken = strParam(body.refresh_token);
  const clientId = strParam(body.client_id);
  if (!refreshToken || !clientId) {
    invalidRequest(res, 'refresh_token and client_id are required');
    return;
  }

  const now = auth.now();
  const hash = sha256hex(refreshToken);
  const rec = await auth.store.getToken(hash);
  if (!rec) {
    invalidGrant(res);
    return;
  }
  if (
    rec.kind !== 'refresh' ||
    rec.revokedAt !== undefined ||
    rec.expiresAt <= now ||
    rec.clientId !== clientId
  ) {
    await auth.store.revokeFamily(rec.familyId, now);
    logger.warn({ familyId: rec.familyId }, 'oauth refresh token rejected; family revoked');
    invalidGrant(res);
    return;
  }

  if (rec.rotatedAt !== undefined && now - rec.rotatedAt > ROTATION_GRACE_MS) {
    await auth.store.revokeFamily(rec.familyId, now);
    logger.warn({ familyId: rec.familyId }, 'oauth refresh token reuse detected; family revoked');
    invalidGrant(res);
    return;
  }

  // First rotation wins: a retry inside the grace window must not push the
  // grace deadline further out each time it's hit.
  if (rec.rotatedAt === undefined) {
    await auth.store.updateToken(hash, { rotatedAt: now });
  }

  const pair = await issuePair(auth.store, now, config, {
    familyId: rec.familyId,
    clientId: rec.clientId,
    clientName: rec.clientName,
    resource: rec.resource,
    scope: rec.scope,
  });
  logger.info({ clientName: rec.clientName, familyId: rec.familyId }, 'oauth token rotated');
  res.status(200).json(pair);
}

export function createTokenRouter(config: Config, logger: Logger, auth: AuthDeps): Router {
  const router = Router();

  // A separate bucket from /oauth/authorize's and /mcp's.
  router.use(createRateLimiter({ capacity: 30, refillPerSec: 10, now: auth.now }));

  router.post(
    '/oauth/token',
    (req: Request, res: Response, next) => {
      noStore(res);
      if (!req.is('application/x-www-form-urlencoded')) {
        res.status(415).json({
          error: 'invalid_request',
          error_description: 'use application/x-www-form-urlencoded',
        });
        return;
      }
      next();
    },
    urlencoded({ extended: false, limit: '8kb' }),
    async (req: Request, res: Response) => {
      const grantType = strParam((req.body as Record<string, unknown>).grant_type);
      if (grantType === 'authorization_code') {
        await handleAuthorizationCode(req, res, config, logger, auth);
        return;
      }
      if (grantType === 'refresh_token') {
        await handleRefreshToken(req, res, config, logger, auth);
        return;
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    },
  );

  router.post(
    '/oauth/revoke',
    urlencoded({ extended: false, limit: '8kb' }),
    async (req: Request, res: Response) => {
      noStore(res);
      const token = strParam((req.body as Record<string, unknown>).token);
      if (token) {
        const rec = await auth.store.getToken(sha256hex(token));
        if (rec) await auth.store.revokeFamily(rec.familyId, auth.now());
      }
      res.status(200).end();
    },
  );

  return router;
}
