import type { OAuthMetadata } from '@modelcontextprotocol/server';

export const SCOPE = 'vault';

/**
 * Joins a path onto `publicUrl` without dropping a path prefix.
 * `new URL('/oauth/x', publicUrl)` treats the leading `/` as absolute and
 * discards any prefix `publicUrl` carries (e.g. `https://example.com/brain`);
 * this instead concatenates onto the URL's own href.
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
