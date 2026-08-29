import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import {
  buildOAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Express, RequestHandler } from 'express';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { type CimdResolver, createCimdResolver } from './as/cimd.ts';
import { buildAuthorizationServerMetadata, SCOPE } from './as/metadata.ts';
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

/** Global token bucket for /mcp (spec §7: 60 req/s). Single-user ⇒ one bucket, keyed by nothing. */
export function createRateLimiter(opts: {
  capacity: number;
  refillPerSec: number;
  now: () => number;
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
      res
        .status(429)
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limited' }, id: null });
      return;
    }
    tokens -= 1;
    next();
  };
}

export function bearerGate(config: Config, auth: AuthDeps): RequestHandler {
  return requireBearerAuth({
    verifier: auth.verifier,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
}

// `logger` and `auth` are unused for now — Tasks 8/9 wire the `/oauth/*`
// routers here, which need both.
export function mountAuth(app: Express, config: Config, _logger: Logger, _auth: AuthDeps): void {
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
  // Tasks 8 and 9 add: app.use(createAuthorizeRouter(config, logger, auth)); app.use(createTokenRouter(config, logger, auth));
}
