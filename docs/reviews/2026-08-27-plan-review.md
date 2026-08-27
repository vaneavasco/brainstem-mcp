# Review: `docs/implementation-plan.md` vs. starea ecosistemului la 2026-08-27

**Verdict scurt:** planul e solid ca produs (scope, tenancy, `drive.file`, fail-closed), dar partea de protocol + auth e scrisă pentru lumea MCP 2025. Între timp a apărut **spec-ul MCP 2026-07-28** (28 iul 2026) și **SDK TypeScript v2 (beta, 27 iul 2026)**, care schimbă exact zonele §2, §3/auth, §7, §8. Sunt 8 lucruri care trebuie schimbate înainte de Phase 0 și ~10 care merită adăugate. Restul (StorageAdapter, tool surface, milestones) rămâne în picioare cu ajustări mici.

---

## A. Critice — de corectat înainte de a scrie cod

### A1. Planul nu fixează versiunea de spec MCP; target-ul corect e **2026-07-28** (servit dual cu 2025-xx)
Ce s-a schimbat în 2026-07-28 și ne afectează direct:
- **Stateless core** (SEP-2575/2567): nu mai există `initialize`/`initialized` nici `Mcp-Session-Id`. Fiecare request poartă versiunea, `clientInfo` și `clientCapabilities` în `_meta`. Perfect pentru Heroku (restart de dyno, mai multe dyno-uri, fără sticky sessions) — dar indexul frontmatter per-tenant trebuie tratat explicit ca **cache reconstruibil**, nu ca stare de sesiune.
- **MRTR** (SEP-2322): elicitation/sampling nu mai sunt request-uri server→client pe SSE; serverul întoarce `resultType: "input_required"`, clientul reîncearcă cu `inputResponses` + `requestState` (opac, semnat de noi).
- **Header-based routing** (SEP-2243): `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` sunt obligatorii; mismatch header↔body ⇒ `400` + JSON-RPC `-32020`. Coduri renumerotate: `-32001→-32020`, `-32003→-32021`, `-32004→-32022`.
- **Cacheable lists** (SEP-2549): `tools/list` întoarce `ttlMs` + `cacheScope` — lista noastră e statică ⇒ TTL lung.
- **Deprecated**: Roots, Sampling, Logging (SEP-2577, fereastră 12 luni), transportul HTTP+SSE legacy, DCR (vezi A3). `GET`/`DELETE` pe endpoint ⇒ `405` pentru clienți moderni.
- **Extensions framework**: Tasks, MCP Apps, Enterprise Managed Auth sunt extensii — nu ne trebuie în v1.

Claude: azi documentația connectors listează auth spec 2025-03-26 / 2025-06-18 / 2025-11-25; blogul Anthropic zice că suportul 2026-07-28 „is being rolled out across Claude products soon”. ⇒ **Trebuie să servim ambele ere.** SDK v2 face asta by default (`createMcpHandler(factory)` cu `legacy: 'stateless'`).

**Acțiune:** §2 → „MCP spec 2026-07-28, cu compat 2025-06-18/2025-11-25 prin SDK legacy mode; `legacy: 'reject'` doar după ce Claude confirmă rollout-ul”.

### A2. `@modelcontextprotocol/sdk` (monolit v1) e în retragere; construim pe **SDK v2**
- v2.0.0 beta (27 iul 2026) sparge monolitul: `@modelcontextprotocol/server`, `/client`, `/core` (schemele Zod), adaptoare `/node`, `/express`, `/hono`, `/fastify`.
- API: `server.registerTool(name, { description, inputSchema: z.object(...), outputSchema, annotations }, handler)`; `ctx` în loc de `extra` (`ctx.mcpReq.signal`, `ctx.http?.req` = Web `Request`); `setRequestHandler('tools/call', ...)`; erori `ProtocolError` / `SdkError` / `SdkHttpError`; **Zod ≥ 4.2**; Node ≥ 20; ESM-first cu CJS build.
- HTTP: `createMcpHandler(factory)` construiește un server proaspăt per request (stateless). Transport Node: `NodeStreamableHTTPServerTransport` din `/node`.
- v1.x primește doar bugfix/security ~6 luni după GA v2. Există codemod: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`

**Acțiune:** §2 → „SDK v2 (pin exact la versiunea beta, upgrade săptămânal în Phase 0–1)”. Fallback dacă beta e prea instabil în Phase 0: v1.30 + codemod la finalul Phase 1. ADR obligatoriu. Aici cade și alegerea Express vs Hono: ambele au adaptor oficial; **Hono** e alegerea „2026” (Web-standard `Request`, aliniat cu `ctx.http.req`), Express e mai sigur pentru middleware OAuth matur — decizia rămâne a executorului, dar ADR-ul trebuie să menționeze adaptoarele v2.

### A3. Plane A e construit pe **DCR — deprecat formal**; standardul e **CIMD**
- Spec 2026-07-28: AS **SHOULD** suporta Client ID Metadata Documents; DCR e **MAY** + „deprecated, retained for backwards compatibility”.
- Claude (docs connectors/authentication): preferă CIMD sau `oauth_anthropic_creds` peste DCR; **DCR creează un client nou la fiecare conectare** ⇒ tabela `oauth_clients` crește nelimitat. Claude alege CIMD **doar** dacă metadata AS are **și** `client_id_metadata_document_supported: true` **și** `"none"` în `token_endpoint_auth_methods_supported`; altfel cade pe DCR.
- Claude Code se identifică prin CIMD (`https://claude.ai/oauth/claude-code-client-metadata`) cu redirect loopback pe port efemer ⇒ AS-ul nostru trebuie să accepte `http://localhost/callback` și `http://127.0.0.1/callback` **ignorând portul** (RFC 8252 §7.3).

**Acțiune:** §7 Plane A → „CIMD primar, DCR fallback (rate-limited, cu `application_type`), pre-registered client opțional (utilizatorul poate introduce client_id/secret în claude.ai)”. Cerințe CIMD pentru AS:
1. detectează `client_id` URL (https + path); fetch cu timeout/size-limit; **SSRF**: blochează IP private/loopback/link-local/metadata, nu urmează redirecturi cross-host, DNS pinning;
2. validează `client_id` din document == URL exact; document JSON cu `client_id`, `client_name`, `redirect_uris`;
3. `redirect_uri` din request ∈ `redirect_uris` (exact-match; loopback = port-agnostic);
4. cache după header-ele HTTP ale documentului;
5. ecranul de consimțământ afișează `client_name` **și hostname-ul redirect-ului** (warning suplimentar pentru loopback-only).
Test de acceptanță nou: conectare din **Claude Code** (`claude mcp add --transport http`) + din claude.ai (mobile/web).

### A4. Lipsește **Protected Resource Metadata (RFC 9728)** — MUST în spec, cerut explicit de Claude
Planul menționează doar `/.well-known/oauth-authorization-server`. Trebuie:
- `GET /.well-known/oauth-protected-resource` (+ varianta path-based `/.well-known/oauth-protected-resource/mcp` dacă endpoint-ul MCP e la `/mcp`) cu `resource` **exact** URL-ul introdus de utilizator în Claude, `authorization_servers: [PUBLIC_URL]` (Claude folosește doar prima intrare), `scopes_supported`, `bearer_methods_supported: ["header"]`.
- Request fără/ cu token invalid ⇒ **`401`** + `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. Claude **nu** onorează `WWW-Authenticate` pe `200` și nu tratează un tool error ca auth challenge.
- `403` + `error="insufficient_scope"` dacă introducem scope-uri granulare (opțional; recomand un singur scope `vault` în v1 pentru a evita step-up flow).
- **Nu** lista `offline_access` în PRM `scopes_supported` (Claude îl adaugă singur dacă AS metadata îl are).

### A5. Lipsesc **Resource Indicators (RFC 8707) + validarea audienței**
Claude trimite `resource=` în authorize și token. AS-ul nostru trebuie să lege tokenul de `resource`; RS-ul **MUST** valideze că tokenul a fost emis pentru el. Concret: `oauth_tokens` primește coloana `resource`/`aud`; middleware-ul respinge orice token cu `aud ≠ PUBLIC_URL(+path)`. Invariant de scris în §8: **tokenul Claude→noi nu părăsește niciodată serverul** (token passthrough interzis); tokenul Google e alt token, alt plan.

### A6. Hardening AS cerut de 2026-07-28 / Claude, absent din §7/§8
- `iss` în răspunsul de autorizare (RFC 9207) + `authorization_response_iss_parameter_supported: true` în metadata (SHOULD acum, MUST în revizia următoare).
- `code_challenge_methods_supported: ["S256"]` **obligatoriu** în metadata (clienții refuză flow-ul fără el).
- **Rotația refresh token-ului e MUST pentru clienți publici** (Claude via CIMD/DCR e client public): tokenul nou în același răspuns care îl invalidează pe cel vechi; păstrează o fereastră de grație scurtă pentru race-uri de rețea. Access token scurt (15–60 min). Refresh cu `invalid_grant` (cod RFC 6749, nu custom) când e mort.
- `/token` acceptă `application/x-www-form-urlencoded`; `/register` primește `application/json` — două body-parsere.
- Latență: Claude așteaptă ≤10 s pentru discovery/register/token și ≤30 s pentru refresh. Nicio muncă upstream (Google) în `/token`.
- `token_endpoint_auth_methods_supported: ["none"]`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`.
- Redirect URI Claude hosted: `https://claude.ai/api/mcp/auth_callback`. Egress Anthropic: `160.79.104.0/21` (nu ne trebuie allowlist pe Heroku public, dar nu pune WAF în fața AS-ului).

### A7. **Confused deputy**: suntem proxy OAuth către Google cu client_id static
Spec: „MCP proxy servers using static client IDs MUST obtain user consent for each dynamically registered client before forwarding to third-party authorization servers”. ⇒ `/oauth/authorize` **nu** poate redirecta automat la Google pe baza unui cookie de sesiune; întâi ecran de consimțământ al nostru (client_name, redirect host, ce primește: acces la vault-ul tău), apoi Google. De adăugat în §7 Plane B și în testele oauth.

### A8. Transport + Heroku: detalii care altfel pică în producție
- Middleware-ul trebuie să valideze `Origin` (⇒ `403`) și header-ele `Mcp-*` vs body (⇒ `400`/`-32020`) — SDK v2 face asta în `createMcpHandler`; testăm.
- SSE: adaugă `X-Accel-Buffering: no`; **Heroku**: 30 s până la primul byte, apoi **55 s rolling idle** ⇒ keep-alive comment `:\n` la ≤25 s pe orice stream deschis (SDK v1.30 are keep-alive timer; verificăm în v2).
- **Node `server.keepAliveTimeout` default e 5 s; Heroku cere ≥ 90 s** altfel H13/H18 intermitent. De pus explicit în `server.ts`.
- Limite Claude: rezultat tool ≤ ~150.000 caractere (claude.ai/Desktop), timeout tool 300 s. ⇒ `vault_read` pe note mari trebuie să pagineze/trunchieze explicit cu indicator; `vault_search` la 50 rezultate e OK.
- Heroku Router 2.0 face HTTP/2 spre client, HTTP/1.1 spre dyno — nimic de făcut.

---

## B. Importante — de adăugat/ajustat în plan

### B1. Repo-ul de referință a evoluat: **20 tool-uri, nu 17**, plus audit log
README-ul actual listează 20: cele 17 din plan + `vault_write_binary` (imagini/PDF din base64, allowlist media-type, cap 1 MB), `vault_analytics_summary`, `vault_analytics_findings` (frontmatter lipsă, wikilinks rupte, variante de tag-uri, encoding, fișiere mari). Recomand parity completă: `write_binary` e esențial pentru „second brain” de pe telefon (poze), analytics e ieftin peste indexul frontmatter existent.
Alte lucruri noi în referință de portat ca **comportament**: audit log JSONL (mutări întotdeauna, citiri opțional, token doar ca SHA-256, path în afara vault-ului), `test_search_argv_injection` (ripgrep argv), `test_forwarded_host` (nu deriva URL-uri din `X-Forwarded-Host`), `test_frontmatter_preservation`, `test_serialization_scale`. Pentru noi, multi-tenant: audit log → tabelă Postgres `audit_events(user_id, ts, op, path, sha_before, sha_after, request_id, client_name, status)` — e cerință de securitate pentru un SaaS, nu nice-to-have.

### B2. Tool annotations + structured output (lipsesc complet)
Claude docs: „All MCP tools must declare `readOnlyHint` și `destructiveHint`”. Claude le folosește pentru approval prompts (read tools trec fără aprobare). De adăugat la fiecare tool: `title`, `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }`. Pentru `vault_list`, `vault_search*`, `vault_batch_read`, analytics: `outputSchema` + `structuredContent` (plus textul JSON în `content` pentru compat). `ttlMs` pe `tools/list` (ex. 1 h, `cacheScope: "public"`).

### B3. Node **24 LTS**, nu 22
Heroku default = 24.x; 22 e Maintenance LTS (EOL 2027-04); 26 devine LTS în oct 2026. `engines.node: "24.x"`. Tooling 2026: Zod 4, Vitest 4, `tsc` pentru build de producție (type-stripping nativ doar pentru scripturi). Lint: Biome e default-ul greenfield 2026 (înlocuiește eslint+prettier, un singur binar); ESLint rămâne valid dacă vrem reguli type-aware. Nu e blocant — dar planul să nu mai zică „eslint + prettier” ca dat.

### B4. Heroku: planul de Postgres nu există, iar RAM-ul e mic
- „Heroku Postgres (mini)” ⇒ `heroku-postgresql:essential-0` ($5, 1 GB, **20 conexiuni**). Pool `pg` max 5, `statement_timeout`. Postgres 16/17/18.
- Basic dyno ($7) = Cedar, Common Runtime; Fir e doar Private Spaces (CNB, IPv6 `::`, OTel) — irelevant acum, dar `server.ts` să nu hardcodeze `0.0.0.0`.
- Basic = 512 MB RAM ⇒ LRU-ul indexului per tenant trebuie limitat **în bytes**, nu doar în număr de tenanți, și evacuat agresiv.

### B5. Google Drive — corecții concrete în §4
- **`keepRevisionForever=true` la fiecare scriere e o greșeală**: max **200** revizii pinned/fișier și contează la storage-ul utilizatorului. O daily note cu 10 append-uri/zi atinge capul în 20 zile. ⇒ nu pina implicit; bazează-te pe retenția default Drive (30 zile / 100 revizii). `Caps.revisions` rămâne `true` doar în sensul „există istoric”, nu „pin forever”.
- `'folderId' in parents` e **ne-recursiv**. Dar sub `drive.file` vedem oricum doar fișierele noastre ⇒ o singură listare paginată `files.list q="trashed=false" fields="files(id,name,mimeType,parents,modifiedTime,appProperties)"` întoarce tot vault-ul; reconstruim path-urile din lanțul `parents`. Mai ieftin decât tree-walk (`files.list` = 100 quota units, `files.get` = 5, `files.update` = 50; per-user 325k units/min).
- Quota model schimbat la **1 mai 2026** (quota units în loc de request-uri; proiectele noi intră direct pe modelul nou; egress 1 TB/zi).
- **Workspace Events API — Drive event subscriptions GA (18 mai 2026)** via Pub/Sub: calea reală spre `Caps.watch = true` pe Drive. Nu în v1 (Pub/Sub + posibil scope mai larg), dar de trecut în §10 ca înlocuitor al TTL re-scan.
- Refresh token Google: în Production nu expiră la 7 zile, dar există **cap de 50 refresh tokens per user per client** și expirare la 6 luni de inactivitate. ⇒ `prompt=consent` **doar** când nu avem refresh token stocat; altfel `prompt=select_account`/nimic. `invalid_grant` ⇒ re-auth flag (deja în plan).
- Verificare ID token cu `OAuth2Client.verifyIdToken` (→ `sub`, `email`) în loc de call la userinfo.
- Context: Google are acum **Drive MCP server oficial** (`drivemcp.googleapis.com`, dev preview mai 2026) și connectorul Google Drive al Anthropic a primit write actions (aug 2026). Nu înlocuiesc produsul nostru (fără semantică de vault/frontmatter/path policy), dar ADR-ul „why build” să le menționeze.

### B6. Tenancy în lume stateless (§7/§8)
- `TenantContext` derivă **per request** din bearer → `userId`; registry-ul de adaptoare e cache, nu stare; testele de izolare rulează cu request-uri concurente ale tenanților A și B pe aceeași instanță.
- Dacă folosim vreodată MRTR (`input_required`), `requestState` e HMAC-semnat și legat de `userId`.
- Rate limiting per tenant e **MUST** în spec („servers MUST rate limit tool invocations”) — lipsește; simplu token-bucket în memorie per userId e suficient în v1.

### B7. §8 checklist — adăugiri
8. PRM + 401 challenge corect; 9. audience (RFC 8707) validată, token passthrough interzis (test); 10. refresh rotation + `iss` + S256 advertised; 11. CIMD SSRF tests (IP privat, redirect, document > N KB, client_id mismatch); 12. consent screen obligatoriu înainte de Google (confused deputy); 13. `Origin` + header/body mismatch tests; 14. audit log în Postgres, fără conținut de notă; 15. rate limit per tenant; 16. conținutul notelor e **untrusted** (prompt injection) — nu îl reflectăm în descrierile de tool/erori; 17. `npm audit` + Dependabot/OSV.

### B8. Timeline
CIMD + PRM + RFC 8707 + rotation + consent + audit + 20 tool-uri + SDK v2 beta churn nu intră în 9 zile. Estimare realistă: Phase 0 → 1d (SDK v2 setup), Phase 2 → 3.5d, Phase 4 → 1.5d ⇒ **~11 dev-days**. Phase 2 accept devine: „conectare completă din claude.ai (web+mobile) **și** Claude Code; teste auth-bypass, tenant-isolation, audience, rotation verzi”.

---

## C. Nice-to-have (de notat în §10, nu de construit)
- **MCP Apps** (Claude le suportă din ian 2026): preview de notă / canvas interactiv în chat — Phase 2+.
- **Tasks extension**: nu ne trebuie (toate tool-urile < 5 s).
- **Server card** `/.well-known/mcp/server.json` (SEP-2127, draft) + publicare în MCP Registry — ieftin, ajută la onboarding, dar nu e stabil încă.
- Enterprise Managed Auth — doar dacă apare team vault.
- Roadmap MCP: DPoP / agent identity / Streamable-HTTP-over-stdio — urmărim, nu construim.
- Plugin `mcp-server-dev` (anthropics/claude-plugins-official) pentru Claude Code — util executorului în Phase 0.

---

## D. Ce rămâne valid fără modificări
§1 (produs, `drive.file` frozen, personal vaults), §4 `StorageAdapter` (cu corecția la revisions), §5 lista de tool-uri (extinsă la 20), §6 index (marcat drept cache), §10 deferred, §11 env vars (+ `MCP_PATH`/`RESOURCE_URL` dacă endpoint-ul nu e la root), §12 working agreements.

---

## E. Surse verificate (27 aug 2026)
- Spec 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/ · authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization · client-registration: …/basic/authorization/client-registration · security: …/basic/authorization/security-considerations · streamable-http: …/basic/transports/streamable-http · tools: …/server/tools · roadmap: https://blog.modelcontextprotocol.io/posts/mcp-roadmap/
- SDK TS v2: https://github.com/modelcontextprotocol/typescript-sdk/releases · https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md · …/docs/migration/support-2026-07-28.md
- Claude connectors: https://claude.com/docs/connectors/building/ · https://claude.com/docs/connectors/building/authentication · https://claude.com/docs/connectors/building/mcp · https://claude.com/blog/bringing-mcp-2026-07-28-to-claude
- Referință: https://github.com/jimprosser/obsidian-web-mcp (README + tests/)
- Node: https://devcenter.heroku.com/articles/nodejs-support · https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- Heroku: https://devcenter.heroku.com/articles/http-routing · https://devcenter.heroku.com/articles/generations · https://devcenter.heroku.com/articles/heroku-postgres-plans
- Google Drive: https://developers.google.com/workspace/drive/release-notes · …/api/guides/manage-revisions · …/api/guides/search-files · …/api/guides/limits · https://developers.google.com/workspace/events/guides/events-drive · https://developers.google.com/workspace/drive/api/guides/configure-mcp-server
