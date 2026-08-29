import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import {
  buildOAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Express, RequestHandler, Response } from 'express';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { createAuthorizeRouter } from './as/authorize.ts';
import { type CimdResolver, createCimdResolver } from './as/cimd.ts';
import { buildAuthorizationServerMetadata, SCOPE } from './as/metadata.ts';
import { createTokenRouter } from './as/token.ts';
import { createOwnerAuth, type OwnerAuth } from './owner.ts';
import { createTokenVerifier } from './rs/verifier.ts';
import type { TokenStore } from './store/types.ts';

export interface AuthDeps {
  store: TokenStore;
  verifier: OAuthTokenVerifier;
  ownerAuth: OwnerAuth;
  cimd: CimdResolver;
  now: () => number;
}

export function createAuth(
  config: Config,
  logger: Logger,
  store: TokenStore,
  over: Partial<Pick<AuthDeps, 'cimd' | 'now'>> = {},
): AuthDeps {
  const now = over.now ?? Date.now;
  return {
    store,
    now,
    verifier: createTokenVerifier(store, config.mcpUrl, now, logger),
    ownerAuth: createOwnerAuth(config.ownerSecret, { now }),
    cimd:
      over.cimd ??
      createCimdResolver({ allowedHosts: config.cimdAllowedHosts, store, now, logger }),
  };
}

function jsonRpcRateLimited(res: Response): void {
  res
    .status(429)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limited' }, id: null });
}

/**
 * Global token bucket for /mcp (spec §7: 60 req/s). Single-user ⇒ one bucket, keyed by
 * nothing. `onLimited` lets callers shape the 429 body/headers for their own protocol
 * (defaults to the JSON-RPC shape /mcp expects); OAuth endpoints use `createOAuthRateLimiter`
 * below instead of passing this directly.
 */
export function createRateLimiter(opts: {
  capacity: number;
  refillPerSec: number;
  now: () => number;
  onLimited?: (res: Response) => void;
}): RequestHandler {
  let tokens = opts.capacity;
  let last = opts.now();
  return (_req, res, next) => {
    const t = opts.now();
    // Guard a backwards clock (system clock adjustment, a stubbed `now` in
    // tests) so it can never look like a huge elapsed interval and hand out
    // a burst of free tokens.
    tokens = Math.min(opts.capacity, tokens + (Math.max(0, t - last) / 1000) * opts.refillPerSec);
    last = t;
    if (tokens < 1) {
      res.setHeader('Retry-After', '1');
      (opts.onLimited ?? jsonRpcRateLimited)(res);
      return;
    }
    tokens -= 1;
    next();
  };
}

/**
 * The shape of an access token as this server mints it: `randomToken()` is 32
 * random bytes, i.e. exactly 43 base64url characters (`src/auth/hash.ts`).
 * A cheap pre-check only — it says nothing about whether the token is real,
 * unexpired or ours; `bearerGate` still decides that.
 */
const BEARER_SHAPE = /^Bearer [A-Za-z0-9_-]{43}$/;

/**
 * A second, much smaller bucket for `/mcp` requests that do not even *look*
 * authenticated, drawn BEFORE `bearerGate` (the main 60/60 bucket now sits
 * behind it). Without this an anonymous flood would drain the owner's bucket
 * and lock the real client out with 429s; with it, unauthenticated callers are
 * capped at their own 20 / 5-per-second allowance and real traffic skips this
 * middleware entirely.
 *
 * "Unauthenticated" is decided by `BEARER_SHAPE`, not by the mere presence of
 * an `Authorization` header: any header at all used to be enough to walk past
 * this bucket, so `Authorization: Bearer nope` on every request re-opened the
 * exact hole the bucket exists to close. A request whose header does not match
 * the shape a real token has cannot be from a legitimate client, so it belongs
 * in the small bucket. Well-shaped but invalid tokens still pass through here
 * and are rejected by the gate — as they must be, since only the gate can tell
 * a real token from a forged one.
 */
export function createUnauthLimiter(now: () => number): RequestHandler {
  const limiter = createRateLimiter({ capacity: 20, refillPerSec: 5, now });
  return (req, res, next) => {
    if (BEARER_SHAPE.test(req.headers.authorization ?? '')) return next();
    limiter(req, res, next);
  };
}

/**
 * The OAuth authorize/token/revoke endpoints share this bucket shape (spec-adjacent,
 * generous enough for interactive + CLI-retry use) and an RFC 6749 §5.2-shaped 429
 * body instead of /mcp's JSON-RPC one, with the same no-store caching as every other
 * OAuth response. Each call returns an independent bucket.
 */
export function createOAuthRateLimiter(now: () => number): RequestHandler {
  return createRateLimiter({
    capacity: 30,
    refillPerSec: 10,
    now,
    onLimited: (res) => {
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: 'rate limited',
      });
    },
  });
}

export function bearerGate(config: Config, auth: AuthDeps): RequestHandler {
  return requireBearerAuth({
    verifier: auth.verifier,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
}

export function mountAuth(app: Express, config: Config, logger: Logger, auth: AuthDeps): void {
  const metadataOptions = {
    oauthMetadata: buildAuthorizationServerMetadata(config.publicUrl),
    resourceServerUrl: config.mcpUrl,
    scopesSupported: [SCOPE],
    resourceName: 'brainstem-mcp vault',
    dangerouslyAllowInsecureIssuerUrl: config.publicUrl.protocol !== 'https:',
  };
  app.use(mcpAuthMetadataRouter(metadataOptions));
  // `mcpAuthMetadataRouter` only serves PRM at the resource's own path-suffixed
  // well-known route (`/.well-known/oauth-protected-resource/mcp`); some MCP
  // clients still probe the bare RFC 9728 path, so mirror the same document there.
  const protectedResourceMetadata = buildOAuthProtectedResourceMetadata(metadataOptions);
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.status(200).json(protectedResourceMetadata);
  });
  // One bucket for the whole OAuth surface (authorize/consent/token/revoke),
  // mounted once here rather than per router: separate buckets on routers that
  // every /oauth request passes through anyway only made the accounting
  // confusing. Path-scoped, so /mcp and /health never draw from it.
  app.use('/oauth', createOAuthRateLimiter(auth.now));
  app.use(createAuthorizeRouter(config, logger, auth));
  app.use(createTokenRouter(config, logger, auth));
}
