import type { OAuthMetadata } from '@modelcontextprotocol/server';

export const SCOPE = 'vault';

/**
 * Appends an endpoint path to `publicUrl`'s href, collapsing the trailing
 * slash `URL` always carries on a bare origin (`https://example.com/` +
 * `/oauth/token`). `loadConfig` rejects a `PUBLIC_URL` with a path, so this
 * is plain concatenation, not prefix preservation.
 */
export function join(publicUrl: URL, path: string): string {
  return `${publicUrl.href.replace(/\/$/, '')}${path}`;
}

export function buildAuthorizationServerMetadata(publicUrl: URL): OAuthMetadata {
  return {
    issuer: publicUrl.href,
    authorization_endpoint: join(publicUrl, '/oauth/authorize'),
    token_endpoint: join(publicUrl, '/oauth/token'),
    revocation_endpoint: join(publicUrl, '/oauth/revoke'),
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
