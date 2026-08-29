import { promises as dns } from 'node:dns';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../../logger.ts';
import type { ClientRecord, TokenStore } from '../store/types.ts';
import { assertPublicAddress, fetchClientMetadataDocument } from './net.ts';

export interface CimdResolver {
  resolveClient(clientId: string): Promise<ClientRecord>;
}

export interface CimdResolverOptions {
  allowedHosts: string[];
  store: TokenStore;
  now: () => number;
  logger: Logger;
  lookup?: (hostname: string) => Promise<string>;
  fetchDocument?: typeof fetchClientMetadataDocument;
}

const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 3_600_000;
const NEGATIVE_TTL_MS = 300_000;

const ClientMetadataDocument = z
  .object({
    client_id: z.string(),
    client_name: z.string().min(1).max(200),
    redirect_uris: z.array(z.url()).min(1),
    token_endpoint_auth_method: z.literal('none').optional(),
  })
  .loose();

function invalid(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidClient, message);
}

/**
 * Validates a `client_id` per the CIMD convention: an HTTPS URL with an
 * explicit path, no embedded credentials or fragment, and no dot segments —
 * and rejects anything that doesn't round-trip to the same string, which
 * also catches paths the URL parser silently normalized (e.g. `/a/../x`).
 */
export function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw invalid('client_id is not a URL');
  }
  if (url.protocol !== 'https:') throw invalid('client_id must be https');
  if (url.username || url.password) throw invalid('client_id must not carry credentials');
  if (url.hash) throw invalid('client_id must not carry a fragment');
  if (url.pathname === '/' || url.pathname === '') {
    throw invalid('client_id must have an explicit path');
  }
  if (url.pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw invalid('client_id must not contain dot segments');
  }
  if (url.href !== clientId) throw invalid('client_id must be in canonical form');
  return url;
}

/**
 * Shared-cache TTL per RFC 9111: `s-maxage` wins over `max-age`, which wins
 * over `Expires`; `no-store`/`private` disable caching entirely. Falls back
 * to a 1-hour default when the response carries no cache directives at all.
 */
export function cacheTtlMs(headers: Record<string, string>, now: number): number {
  const cacheControl = (headers['cache-control'] ?? '').toLowerCase();
  if (/\bno-store\b/.test(cacheControl) || /\bprivate\b/.test(cacheControl)) return 0;
  const sMaxAge = cacheControl.match(/\bs-maxage=(\d+)/);
  if (sMaxAge?.[1]) return Number(sMaxAge[1]) * 1000;
  const maxAge = cacheControl.match(/\bmax-age=(\d+)/);
  if (maxAge?.[1]) return Number(maxAge[1]) * 1000;
  if (headers.expires) {
    const expires = Date.parse(headers.expires);
    if (!Number.isNaN(expires)) return Math.max(0, expires - now);
  }
  return DEFAULT_TTL_MS;
}

async function defaultLookup(hostname: string): Promise<string> {
  const { address } = await dns.lookup(hostname, { verbatim: true });
  return address;
}

/**
 * Resolves, validates and caches Client ID Metadata Documents. `clientId`
 * must be an HTTPS URL whose host is in `allowedHosts`; the document is
 * fetched from a DNS-pinned, redirect-free connection to a verified public
 * IP (see `net.ts`), so an attacker cannot use CIMD fetches to probe
 * internal network addresses. Failures are negative-cached for 5 minutes to
 * bound retry traffic against a misbehaving or unreachable client.
 */
export function createCimdResolver(opts: CimdResolverOptions): CimdResolver {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchDocument = opts.fetchDocument ?? fetchClientMetadataDocument;
  const allowedHosts = new Set(opts.allowedHosts.map((host) => host.toLowerCase()));

  return {
    async resolveClient(clientId) {
      const url = validateClientIdUrl(clientId);
      const host = url.hostname.toLowerCase();
      if (!allowedHosts.has(host)) {
        opts.logger.warn({ host }, 'CIMD client host is not in CIMD_ALLOWED_HOSTS');
        throw invalid(`client host ${host} is not allowed`);
      }

      const now = opts.now();
      const cached = await opts.store.getClient(clientId);
      if (cached && cached.expiresAt > now) {
        if (cached.negative) throw invalid('client metadata could not be fetched recently');
        return cached;
      }

      try {
        const ip = await lookup(url.hostname);
        assertPublicAddress(ip);
        const res = await fetchDocument(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, ip });
        if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
        const contentType =
          (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        const isJson =
          contentType === 'application/json' ||
          /^application\/[a-z0-9.+-]+\+json$/.test(contentType);
        if (!isJson) throw new Error(`unexpected content-type ${contentType}`);
        const parsed = ClientMetadataDocument.safeParse(JSON.parse(res.body));
        if (!parsed.success) throw new Error('client metadata document has an invalid shape');
        if (parsed.data.client_id !== clientId) throw new Error('client_id mismatch');

        const ttl = cacheTtlMs(res.headers, now);
        const record: ClientRecord = {
          clientId,
          clientName: parsed.data.client_name,
          redirectUris: parsed.data.redirect_uris,
          fetchedAt: now,
          expiresAt: now + ttl,
        };
        if (ttl > 0) await opts.store.putClient(record);
        return record;
      } catch (error) {
        opts.logger.warn({ clientId, err: error }, 'CIMD fetch rejected');
        await opts.store.putClient({
          clientId,
          clientName: '',
          redirectUris: [],
          fetchedAt: now,
          expiresAt: now + NEGATIVE_TTL_MS,
          negative: true,
        });
        throw invalid('client metadata document is invalid or unreachable');
      }
    },
  };
}
