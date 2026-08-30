import { type Request, type Response, Router, urlencoded } from 'express';
import type { Config } from '../../config.ts';
import type { Logger } from '../../logger.ts';
import { randomToken, sha256hex } from '../hash.ts';
import type { AuthDeps } from '../mount.ts';
import type { ClientRecord, PendingRecord } from '../store/types.ts';
import { renderConsentPage, renderErrorPage } from './consent.ts';
import { SCOPE } from './metadata.ts';

export const PENDING_TTL_MS = 600_000;
export const CODE_TTL_MS = 60_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const CODE_CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Exact match on protocol/host/path/query; loopback hosts (`localhost`,
 * `127.0.0.1`, `[::1]`) ignore the port, since the CLI callback server binds
 * an ephemeral port each run. Anything else must match the port too. A
 * candidate carrying userinfo or a fragment is always rejected outright —
 * neither can legitimately appear in a redirect target and both are classic
 * open-redirect confusion vectors.
 */
export function matchesRedirectUri(candidate: string, registered: string[]): boolean {
  let c: URL;
  try {
    c = new URL(candidate);
  } catch {
    return false;
  }
  if (c.hash || c.username || c.password) return false;
  return registered.some((r) => {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return false;
    }
    if (u.protocol !== c.protocol || u.pathname !== c.pathname || u.search !== c.search) {
      return false;
    }
    if (u.hostname !== c.hostname) return false;
    return LOOPBACK.has(c.hostname) && u.protocol === 'http:' ? true : u.port === c.port;
  });
}

function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    return LOOPBACK.has(new URL(redirectUri).hostname);
  } catch {
    return false;
  }
}

function strParam(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function noStoreHtml(res: Response): void {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    // `same-origin`, not `no-referrer`: per the Fetch spec a form POST made under
    // `no-referrer` carries `Origin: null`, which the app-wide Origin validation rejects
    // (seen with a real browser on the consent form). Same-origin keeps the real origin on
    // our own POST and still sends no Referer to the client's redirect target.
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
}

function redirectError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state: string,
  iss: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', iss);
  res.redirect(302, url.href);
}

function redirectCode(
  res: Response,
  redirectUri: string,
  code: string,
  state: string,
  iss: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', iss);
  res.redirect(302, url.href);
}

export function createAuthorizeRouter(config: Config, logger: Logger, auth: AuthDeps): Router {
  const router = Router();
  const iss = config.publicUrl.href;

  router.get('/oauth/authorize', async (req: Request, res: Response) => {
    noStoreHtml(res);
    const query = req.query as Record<string, unknown>;
    const clientId = strParam(query.client_id);
    const redirectUri = strParam(query.redirect_uri);
    const responseType = strParam(query.response_type);
    const codeChallenge = strParam(query.code_challenge);
    const codeChallengeMethod = strParam(query.code_challenge_method);
    const resource = strParam(query.resource);
    const scope = strParam(query.scope);
    const state = strParam(query.state);

    let client: ClientRecord;
    try {
      client = await auth.cimd.resolveClient(clientId);
    } catch {
      logger.warn({ host: hostnameOf(clientId) }, 'oauth authorize: unknown or invalid client');
      res
        .status(400)
        .send(
          renderErrorPage(
            'Unknown client',
            'This application is not registered, or its metadata could not be verified.',
          ),
        );
      return;
    }

    if (!matchesRedirectUri(redirectUri, client.redirectUris)) {
      logger.warn(
        { clientName: client.clientName, host: hostnameOf(redirectUri) },
        'oauth authorize: redirect_uri not registered',
      );
      res
        .status(400)
        .send(
          renderErrorPage(
            'Unregistered redirect',
            'The redirect address for this request is not registered for this application.',
          ),
        );
      return;
    }

    if (responseType !== 'code') {
      redirectError(
        res,
        redirectUri,
        'unsupported_response_type',
        'response_type must be "code"',
        state,
        iss,
      );
      return;
    }
    if (
      !codeChallenge ||
      codeChallengeMethod !== 'S256' ||
      !CODE_CHALLENGE_RE.test(codeChallenge)
    ) {
      redirectError(
        res,
        redirectUri,
        'invalid_request',
        'a PKCE code_challenge with method S256 is required',
        state,
        iss,
      );
      return;
    }
    if (!resource) {
      // Spec §4.2: `resource` is optional for legacy clients and defaults to
      // our single MCP endpoint — worth a line, since a client that omits it
      // is also the client that will get an audience mismatch if we ever
      // serve more than one resource.
      logger.warn(
        { clientName: client.clientName },
        'oauth authorize: no resource parameter — defaulting to the vault MCP endpoint',
      );
    }
    if (resource && resource !== config.mcpUrl.href) {
      redirectError(
        res,
        redirectUri,
        'invalid_target',
        'resource must be the vault MCP endpoint',
        state,
        iss,
      );
      return;
    }
    const scopes = scope.split(' ').filter(Boolean);
    if (scope && !scopes.every((s) => s === SCOPE)) {
      redirectError(
        res,
        redirectUri,
        'invalid_scope',
        'only the "vault" scope is supported',
        state,
        iss,
      );
      return;
    }
    if (!state) {
      redirectError(res, redirectUri, 'invalid_request', 'state is required', state, iss);
      return;
    }

    const now = auth.now();
    const pending: PendingRecord = {
      id: randomToken(16),
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge,
      resource: config.mcpUrl.href,
      scope: SCOPE,
      state,
      nonce: randomToken(16),
      expiresAt: now + PENDING_TTL_MS,
      // Computed once here (from every registered redirect_uri, not just this
      // request's) and persisted, so a later re-render (wrong secret, lockout)
      // reads the same value back instead of re-resolving the client.
      loopbackOnly: client.redirectUris.every(isLoopbackRedirect),
    };
    await auth.store.putPending(pending);
    logger.info(
      { clientName: pending.clientName, redirectHost: hostnameOf(redirectUri) },
      'oauth pending authorization created',
    );

    res.status(200).send(
      renderConsentPage({
        clientName: pending.clientName,
        redirectHost: new URL(redirectUri).hostname,
        loopbackOnly: pending.loopbackOnly,
        pendingId: pending.id,
        nonce: pending.nonce,
      }),
    );
  });

  router.post(
    '/oauth/consent',
    urlencoded({ extended: false, limit: '8kb' }),
    async (req: Request, res: Response) => {
      noStoreHtml(res);
      const body = req.body as Record<string, unknown>;
      const pendingId = strParam(body.pending_id);
      const nonce = strParam(body.nonce);
      const action = strParam(body.action);
      const secret = strParam(body.secret);

      const now = auth.now();
      const pending = await auth.store.getPending(pendingId);
      if (!pending || pending.expiresAt <= now) {
        if (pending) await auth.store.deletePending(pendingId);
        res
          .status(400)
          .send(
            renderErrorPage(
              'Session expired',
              'This authorization request has expired or was already used. Go back to Claude and start again.',
            ),
          );
        return;
      }
      if (pending.nonce !== nonce) {
        await auth.store.deletePending(pendingId);
        res
          .status(400)
          .send(
            renderErrorPage(
              'Invalid request',
              'This authorization request could not be verified. Go back to Claude and start again.',
            ),
          );
        return;
      }

      if (action === 'deny') {
        await auth.store.deletePending(pendingId);
        redirectError(
          res,
          pending.redirectUri,
          'access_denied',
          'The owner denied the request.',
          pending.state,
          iss,
        );
        return;
      }

      if (action !== 'approve') {
        res.status(400).send(renderErrorPage('Invalid request', 'Unrecognized action.'));
        return;
      }

      const verdict = auth.ownerAuth.verify(secret);
      if (!verdict.ok) {
        const view = {
          clientName: pending.clientName,
          redirectHost: new URL(pending.redirectUri).hostname,
          loopbackOnly: pending.loopbackOnly,
          pendingId: pending.id,
          nonce: pending.nonce,
        };
        if (verdict.reason === 'locked') {
          logger.warn(
            { clientName: pending.clientName },
            'oauth consent: locked out after repeated failures',
          );
          res.set('Retry-After', String(verdict.retryAfterS));
          res.status(429).send(renderConsentPage({ ...view, lockedForS: verdict.retryAfterS }));
          return;
        }
        logger.warn({ clientName: pending.clientName }, 'oauth consent: wrong owner secret');
        res.status(401).send(renderConsentPage({ ...view, error: 'Incorrect secret. Try again.' }));
        return;
      }

      // The code is self-contained (carries its own copy of the pending
      // row's binding fields) so it stays checkable after the pending row is
      // gone; deleting the pending row here — rather than leaving it for the
      // token exchange — is what makes a replayed approve 400 instead of
      // silently minting a second code.
      const code = randomToken(32);
      await auth.store.putCode(sha256hex(code), {
        pendingId: pending.id,
        clientId: pending.clientId,
        clientName: pending.clientName,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scope: pending.scope,
        expiresAt: now + CODE_TTL_MS,
      });
      await auth.store.deletePending(pending.id);
      logger.info({ clientName: pending.clientName }, 'oauth authorization code issued');
      redirectCode(res, pending.redirectUri, code, pending.state, iss);
    },
  );

  return router;
}
