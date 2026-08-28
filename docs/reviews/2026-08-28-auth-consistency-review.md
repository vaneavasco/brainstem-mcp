# Auth / account model — live consistency check (2026-08-28)

**Question asked by the owner:** is the account/auth design in `docs/implementation-plan.md` §7 still the right shape, and is it consistent with the real August-2026 ecosystem? Everything below was fetched live on 2026-08-28 (not recalled); the plan was bumped to v1.2 with the corrections listed at the end.

## Verdict

The two-plane design (we are OAuth 2.1 AS + RS towards Claude; Google is the IdP and Drive authority behind us) is confirmed by every source. Three factual corrections, one logical inconsistency in Plane B, and four account-model gaps were found and folded into the plan. Build-vs-delegate was re-evaluated; the self-built AS stays.

## Confirmed (plan ↔ source)

| Plan element | 2026 state | Source |
|---|---|---|
| CIMD primary, DCR fallback | CIMD **SHOULD**; DCR **MAY**, "deprecated and retained for backwards compatibility"; pre-registration SHOULD | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration |
| CIMD selection rule in Claude | "Claude selects CIMD only when your authorization server metadata advertises both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported` … If either is missing, Claude falls back to DCR." | https://claude.com/docs/connectors/building/authentication |
| PRM + 401 + `resource` | PRM **MUST**; `resource` **MUST** on authorize and token; audience validation **MUST**; Claude honours the challenge only on a 401 | spec authorization page; Claude docs |
| `iss` (RFC 9207) | still **SHOULD**, "expected to upgrade … to MUST" in a future revision | spec |
| Refresh rotation | **MUST** for public clients | spec |
| Consent per client (confused deputy) | "MCP proxy servers using static client IDs **MUST** obtain user consent for each dynamically registered client before forwarding to third-party authorization servers" | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations |
| Claude Code client | CIMD document `https://claude.ai/oauth/claude-code-client-metadata`: `redirect_uris: ["http://localhost/callback","http://127.0.0.1/callback"]`, `token_endpoint_auth_method: "none"`; ephemeral port must be ignored | fetched document; https://code.claude.com/docs/en/mcp |
| Hosted redirect / limits | `https://claude.ai/api/mcp/auth_callback`; 10 s for discovery/registration/token, 30 s for refresh; egress `160.79.104.0/21`; `invalid_grant` triggers re-auth; proactive refresh 5 min before expiry | Claude docs |
| Scopes | `drive.file`, `openid`, `email` are non-sensitive → Production without verification (brand verification only for a logo) | https://developers.google.com/workspace/drive/api/guides/api-specific-auth |
| Identity | "Always use the `sub` field … the `sub` value is never changed" | Google OIDC docs |
| SDK v2 | Authorization-server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) were removed; frozen copy in `@modelcontextprotocol/server-legacy` (pre-CIMD). RS half remains: `requireBearerAuth`, `OAuthTokenVerifier`, `mcpAuthMetadataRouter` in `@modelcontextprotocol/express`. Docs: "Use a dedicated identity provider for new servers; this page only covers the resource-server half." | `node_modules/@modelcontextprotocol/server/dist/index.d.mts`; SDK docs |
| Enterprise Managed Authorization | optional extension, framed for enterprise; not applicable to personal accounts | spec extensions |

## Corrections applied (plan v1.2)

1. **Google refresh-token cap is 100 per Google Account per OAuth client, not 50** ("creating a new refresh token automatically invalidates the oldest refresh token without warning"). https://developers.google.com/identity/protocols/oauth2#expiration
2. **Client secret is shown once at creation; OAuth clients unused for 6 months are auto-deleted** (Google Auth Platform changes effective 2025-06). https://developers.googleblog.com/usability-and-safety-updates-to-google-auth-platform/
3. **Claude still lists only the 2025 spec revisions** (2025-03-26 / 06-18 / 11-25); 2026-07-28 is "being rolled out". `legacy: 'stateless'` stays mandatory. Claude also **rejects connector hostnames without a public IPv4 A record** → claude.ai/mobile acceptance needs a public URL; Claude Code and Inspector work on `http://localhost`. https://claude.com/docs/connectors/building/mcp
4. **Plane B logical fix:** "`prompt=consent` only when we have no stored refresh token for the user" is undecidable before the callback (we don't know `sub` yet). Replaced with the two-step flow: `select_account` first; `consent&login_hint=<sub>` only if the callback shows no stored token and none returned.
5. **Re-auth UX:** on Google `invalid_grant`, additionally revoke the user's Plane A token families so Claude's next refresh fails with `invalid_grant` and Claude prompts to reconnect (Claude never re-runs OAuth while its token is valid).
6. **Account lifecycle:** `POST /oauth/revoke` (RFC 7009) in Phase 2; minimal `/account` page (grants, revoke, delete account incl. Google token revocation) in Phase 4; `users.email_verified`, `oauth_tokens.last_used_at`.
7. **Consent CSRF:** the consent `POST` is bound to the `oauth_pending` row through a stored `nonce`; "no cookie shortcut" clarified as "never skip consent", not "no per-flow state".
8. **Stricter CIMD fetch rules** (borrowed from `@better-auth/cimd`'s validator): 5 KB cap, no redirects at all, every RFC 6890 range rejected, shared-cache semantics, explicit path required, port significant.
9. Google redirect `http://localhost:3000/oauth/google/callback` registered alongside the public one (localhost is exempt from Google's HTTPS rule) so the real Google flow also runs against the Compose stack.

## Build vs. delegate (re-checked)

| Option | CIMD | Google login | Drive refresh-token custody | Why not |
|---|---|---|---|---|
| WorkOS AuthKit + Pipes | yes | yes | yes (separate product) | external SaaS even for local dev; Pipes pricing unpublished |
| Scalekit MCP Auth + Agent Actions | yes | generic | yes (separate vault) | external SaaS; 5k calls free then $99/mo |
| Descope | yes | unconfirmed | "Connections" (Drive unnamed) | external SaaS |
| Auth0 Token Vault | unconfirmed | unconfirmed | yes (verified for Calendar) | paid add-on; CIMD unverified |
| Clerk / Stytch | yes / not found | — | no Drive path | Plane B not covered |
| Cloudflare `workers-oauth-provider` | yes | — | no | Workers-only |
| Ory Hydra | **no** (ory/hydra#4061) | — | no | — |
| Better Auth `mcp()` + `@better-auth/cimd` (self-hosted) | yes | yes | in `account` table; encryption/refresh API unverified | plugin pins `legacy: "reject"` (Claude isn't there), Next.js-centric, session-cookie consent must be forced per client, large dependency on the security core |

Decision: keep the self-built AS (3.5 d, already designed fail-closed); every hosted option contradicts the "everything local with Docker Compose" decision and moves the user's Drive token to a vendor. Better Auth would save ~1–1.5 d against three unknowns on exactly the §8 checklist items.

## Not changed on purpose

- Opaque Plane A tokens with a DB hash lookup per request (instant revocation, no JWKS) — fine at this scale.
- Single scope `vault`; no Enterprise Managed Authorization; no password login; no `client_credentials`.
- Loopback port-agnostic redirect matching: the MCP spec is silent on ports; RFC 8252 §7.3 and Claude Code's behaviour require it. The spec's extra rules (display the redirect hostname, warn on loopback-only) were already in the plan.

## Sources

- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization · …/authorization/client-registration · …/authorization/security-considerations · https://blog.modelcontextprotocol.io/posts/mcp-roadmap/
- https://claude.com/docs/connectors/building/authentication · …/mcp · …/troubleshooting · https://code.claude.com/docs/en/mcp · https://claude.ai/oauth/claude-code-client-metadata
- https://developers.google.com/identity/protocols/oauth2/web-server · …/oauth2#expiration · https://developers.google.com/identity/openid-connect/openid-connect · https://developers.google.com/workspace/drive/api/guides/api-specific-auth · https://support.google.com/cloud/answer/13463073
- https://better-auth.com/docs/plugins/mcp · https://better-auth.com/docs/plugins/cimd · https://workos.com/docs/authkit/mcp · https://docs.scalekit.com/guides/mcp/overview/ · https://docs.descope.com/mcp · https://clerk.com/changelog/2026-08-06-client-id-metadata-documents · https://github.com/ory/hydra/issues/4061
