/**
 * Developer client — call a tool on the RUNNING brainstem server from the shell,
 * with no browser anywhere in the loop. Dev-only: `@modelcontextprotocol/client`
 * is a devDependency, and this file is never bundled into `dist/`.
 *
 *   npm run mcp:call -- --list
 *   npm run mcp:call -- brainstem_ping
 *   npm run mcp:call -- vault_list '{"depth":2}'
 *   npm run mcp:call -- vault_read '{"path":"Inbox/note.md"}'
 *   npm run mcp:call -- --reauth --list
 *
 * Flags (both `--flag value` and `--flag=value` work)
 *   --list              list the server's tools instead of calling one
 *   --url <mcpUrl>      default: PUBLIC_URL from .env (or, in TUNNEL_MODE=quick,
 *                       the URL the supervisor wrote to
 *                       <VAULT_PATH>/_brainstem/public-url), with /mcp appended
 *   --secret <s>        default: OWNER_SECRET from .env
 *   --token-file <p>    default: .brainstem-dev-tokens.json in the repo root (gitignored)
 *   --reauth            ignore the cached tokens and consent again
 *
 * `--url` must be the server's PUBLIC_URL — the origin its own metadata advertises,
 * i.e. the tunnel hostname when a tunnel is up. Pointing it at http://127.0.0.1:3000
 * while the server advertises a tunnel fails the SDK's RFC 9728 check ("Protected
 * resource … does not match expected …"), which is why the default comes from .env.
 *
 * How the login works: the SDK runs the real OAuth flow, but instead of opening a
 * browser this script fetches the authorize page itself, scrapes `pending_id` and
 * `nonce` out of the consent form, POSTs `/oauth/consent` with the owner secret and
 * `action=approve`, and hands the resulting 302's query string to
 * `transport.finishAuth()`. Tokens are cached — keyed by the issuer that minted
 * them — in the token file at mode 0600 and reused on the next run; refreshes are
 * the SDK's job from then on.
 *
 * The owner secret is only ever sent to the `--url` origin: the authorize URL comes
 * from discovered AS metadata, so it is checked against `--url` before anything is
 * fetched or posted (see `assertSameOrigin`).
 *
 * DEV SHORTCUT, deliberate: this identifies as the Claude Code client
 * (`clientMetadataUrl` = https://claude.ai/oauth/claude-code-client-metadata) so it
 * passes our AS's CIMD host allowlist without registering a client of its own. The
 * consent page will therefore say "Claude Code" — that is this script, not the CLI.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { parseEnv } from '../src/cli/env-file.ts';
import { parsePublicUrlFile } from '../src/tunnel/public-url-file.ts';

const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT_URI = 'http://localhost/callback';
const DEFAULT_TOKEN_FILE = '.brainstem-dev-tokens.json';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const VALUE_FLAGS = ['--url', '--secret', '--token-file'];
const BOOL_FLAGS = ['--list', '--reauth'];

export interface McpCallOptions {
  /** Full MCP endpoint URL, e.g. `http://127.0.0.1:3000/mcp`. */
  url: string;
  /** Owner secret, as typed into the consent page. */
  secret: string;
  /** Where the OAuth tokens are cached between runs. */
  tokenFile: string;
  /** Everything after the config flags: `--list`, `--reauth`, a tool name, JSON args. */
  args: string[];
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

/** What lands in the token file: the token set plus the issuer it is bound to. */
interface TokenCache {
  issuer: string;
  tokens: StoredOAuthTokens;
}

export interface ParsedArgs {
  values: Map<string, string>;
  bools: Set<string>;
  positional: string[];
  /** Set instead of throwing, so both entry points can report it their own way. */
  error?: string;
}

/**
 * One parser for both entry points. Accepts `--flag value` and `--flag=value`,
 * and refuses anything not in the two tables above rather than silently treating
 * a typo'd flag as a tool name.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    if (VALUE_FLAGS.includes(name)) {
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (value === undefined) {
        return { values, bools, positional, error: `${name} needs a value` };
      }
      values.set(name, value);
      continue;
    }
    if (BOOL_FLAGS.includes(name)) {
      if (eq !== -1) {
        return { values, bools, positional, error: `${name} takes no value` };
      }
      bools.add(name);
      continue;
    }
    return { values, bools, positional, error: `unknown option: ${name}` };
  }
  return { values, bools, positional };
}

/**
 * Guards the one place a secret leaves this process. `authorizationUrl` is built
 * from metadata the server itself served, so a compromised or misconfigured
 * `authorization_servers` entry could otherwise point the consent POST — owner
 * secret included — at a host the operator never named.
 */
export function assertSameOrigin(candidate: string | URL, expected: string | URL): void {
  const a = new URL(candidate).origin;
  const b = new URL(expected).origin;
  if (a !== b) {
    throw new Error(`refusing to send the owner secret to ${a} (not the --url origin ${b})`);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A token file inside the working tree must be gitignored — this writes a live
 * refresh token, and the default name is easy to override into something
 * committable. Files outside the repo are the caller's business.
 */
export function assertTokenFileIgnored(
  file: string,
  repoRoot: string = REPO_ROOT,
  warn: (line: string) => void = (line) => console.error(line),
): void {
  const resolved = path.resolve(file);
  if (!isInside(resolved, repoRoot)) return;
  const rel = path.relative(repoRoot, resolved);
  const res = spawnSync('git', ['check-ignore', '-q', resolved], { cwd: repoRoot });
  if (res.error || res.status === null || res.status > 1) {
    warn(`warning: could not run git check-ignore — not verifying that ${rel} is ignored`);
    return;
  }
  if (res.status === 1) {
    throw new Error(
      `refusing to write tokens to ${rel}: it is inside the repository and not gitignored`,
    );
  }
}

async function readTokenFile(file: string): Promise<TokenCache | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // No cache yet, or an unreadable/half-written one: just log in again.
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const cache = raw as TokenCache;
  if (typeof cache.issuer !== 'string' || cache.issuer === '') return undefined;
  if (!cache.tokens || typeof cache.tokens.access_token !== 'string') return undefined;
  return { issuer: cache.issuer, tokens: cache.tokens };
}

async function writeTokenFile(file: string, cache: TokenCache): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when writeFile creates the file; an existing one keeps
  // whatever mode it had, so re-assert it every time.
  await fs.chmod(file, 0o600);
}

/**
 * The SDK's OAuth client, wired for a terminal. Everything an interactive host
 * would keep in a keychain lives in one 0600 JSON file; the browser step is
 * replaced by `redirectToAuthorization` driving the consent form over fetch.
 */
export class DevOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl = CLAUDE_CODE_CIMD;
  /** `code` / `state` / `iss` scraped off the consent redirect, for `finishAuth`. */
  callbackParams: URLSearchParams | undefined;
  private cache: TokenCache | undefined;
  private verifier = '';
  private discovery: OAuthDiscoveryState | undefined;
  private readonly tokenFile: string;
  private readonly secret: string;
  private readonly serverUrl: string;

  // Explicit fields rather than constructor parameter properties:
  // `erasableSyntaxOnly` is on, because Node runs these .ts files directly.
  constructor(tokenFile: string, secret: string, serverUrl: string) {
    this.tokenFile = tokenFile;
    this.secret = secret;
    this.serverUrl = serverUrl;
  }

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata() {
    return {
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT_URI, 'http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    };
  }

  // Returning client information synchronously tells the SDK the client is
  // already known to the AS, so it skips Dynamic Client Registration and uses
  // the CIMD URL as the client_id — which is what our AS resolves server-side.
  clientInformation() {
    return { client_id: CLAUDE_CODE_CIMD };
  }

  // Our /oauth/authorize requires `state`; the SDK only sends it when the
  // provider implements this.
  state(): string {
    return crypto.randomUUID();
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  // In memory is durable enough here: authorize and callback happen inside one
  // process, one run. Without these two the SDK warns that it cannot do the
  // SEP-2352 callback-leg authorization-server binding check.
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  loadCache(cache: TokenCache | undefined): void {
    this.cache = cache;
  }

  /**
   * Tokens are handed back only to the authorization server that minted them.
   * With a `ctx` the SDK names the issuer it wants, so match it exactly; without
   * one (the transport's per-request bearer read) fall back to the origin we were
   * pointed at, so a token file left over from another deployment is never
   * replayed at a different host.
   */
  tokens(ctx?: { issuer: string }): StoredOAuthTokens | undefined {
    const cache = this.cache;
    if (!cache) return undefined;
    if (ctx?.issuer) return ctx.issuer === cache.issuer ? cache.tokens : undefined;
    let issuerOrigin: string;
    try {
      issuerOrigin = new URL(cache.issuer).origin;
    } catch {
      return undefined;
    }
    return issuerOrigin === new URL(this.serverUrl).origin ? cache.tokens : undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: { issuer: string }): Promise<void> {
    // The SDK stamps `issuer` itself; `ctx` is the documented fallback. With
    // neither there is nothing to bind the set to, so it stays in memory for
    // this run rather than being written as an unbound credential.
    const issuer = tokens.issuer ?? ctx?.issuer;
    if (!issuer) {
      this.cache = { issuer: new URL(this.serverUrl).origin, tokens };
      return;
    }
    this.cache = { issuer, tokens: { ...tokens, issuer } };
    await writeTokenFile(this.tokenFile, this.cache);
  }

  /** The browser step, headless: fetch the page, approve the form, keep the 302. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Before anything is fetched: this URL came from metadata, not from the operator.
    assertSameOrigin(authorizationUrl, this.serverUrl);

    const page = await fetch(authorizationUrl, { redirect: 'manual' });
    const html = await page.text();
    if (page.status !== 200) {
      throw new Error(`GET ${authorizationUrl.pathname} returned HTTP ${page.status}`);
    }
    const pendingId = html.match(/name="pending_id" value="([^"]+)"/)?.[1];
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    if (!pendingId || !nonce) {
      throw new Error('the authorize response carried no consent form (server too old?)');
    }

    const consentUrl = new URL('/oauth/consent', authorizationUrl);
    assertSameOrigin(consentUrl, this.serverUrl);
    const res = await fetch(consentUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        pending_id: pendingId,
        nonce,
        action: 'approve',
        secret: this.secret,
      }),
    });
    const location = res.headers.get('location');
    if (res.status === 401 || res.status === 429) {
      throw new Error(
        res.status === 401
          ? 'wrong owner secret — pass --secret or fix OWNER_SECRET in .env'
          : 'locked out after repeated wrong secrets — wait a few minutes',
      );
    }
    if (res.status !== 302 || !location) {
      throw new Error(`POST /oauth/consent returned HTTP ${res.status}`);
    }
    const callback = new URL(location);
    const error = callback.searchParams.get('error');
    if (error) {
      throw new Error(`authorization failed: ${error}`);
    }
    this.callbackParams = callback.searchParams;
  }
}

function toolText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/**
 * Connects (logging in first if the cached tokens are missing or rejected) and
 * runs one `--list` or one tool call. Returns the process exit code.
 */
export async function runMcpCall(opts: McpCallOptions): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const printErr = opts.printErr ?? ((line: string) => console.error(line));

  const parsed = parseArgs(opts.args);
  if (parsed.error) {
    printErr(parsed.error);
    return 1;
  }
  const list = parsed.bools.has('--list');
  const reauth = parsed.bools.has('--reauth');
  const toolName = parsed.positional[0];

  if (!list && !toolName) {
    printErr('usage: npm run mcp:call -- <tool> [json-args]   (or --list)');
    return 1;
  }

  let toolArgs: Record<string, unknown> = {};
  if (parsed.positional[1]) {
    try {
      const json: unknown = JSON.parse(parsed.positional[1]);
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('not a JSON object');
      }
      toolArgs = json as Record<string, unknown>;
    } catch (error) {
      printErr(`bad json-args: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const endpoint = new URL(opts.url);
  const provider = new DevOAuthProvider(opts.tokenFile, opts.secret, endpoint.href);
  try {
    assertTokenFileIgnored(opts.tokenFile, REPO_ROOT, printErr);
  } catch (error) {
    printErr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // `--reauth` only ignores the cache; the file is replaced by `saveTokens`
  // once the new login actually succeeds, so a failed re-auth leaves the
  // still-valid tokens on disk.
  provider.loadCache(reauth ? undefined : await readTokenFile(opts.tokenFile));

  const client = new Client(
    { name: 'brainstem-mcp-call', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  let transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      // No usable tokens: the SDK ran `auth()`, which called back into
      // `redirectToAuthorization` (where the consent already happened) and then
      // surfaced this. Redeem the code and reconnect on a fresh transport.
      if (!UnauthorizedError.isInstance(error)) throw error;
      if (!provider.callbackParams) throw error;
      await transport.finishAuth(provider.callbackParams);
      transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
      await client.connect(transport);
    }

    if (list) {
      const { tools } = await client.listTools();
      print(`${tools.length} tools at ${endpoint.href}`);
      for (const tool of tools) {
        print(`  ${tool.name}${tool.title ? ` — ${tool.title}` : ''}`);
      }
      return 0;
    }

    const result = await client.callTool({ name: toolName as string, arguments: toolArgs });
    const text = toolText(result);
    if (result.isError) {
      printErr(text || `${toolName} failed`);
      return 1;
    }
    print(
      result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent, null, 2)
        : text,
    );
    return 0;
  } catch (error) {
    printErr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Fills in `--url` / `--secret` / `--token-file` from `.env`, exactly the file the
 * running server was started with. In quick-tunnel mode the URL is whatever the
 * supervisor last wrote into the vault, not what `.env` says.
 */
export async function resolveOptions(
  argv: string[],
  repoRoot: string = REPO_ROOT,
): Promise<McpCallOptions> {
  const parsed = parseArgs(argv);
  if (parsed.error) throw new Error(parsed.error);

  let env = new Map<string, string>();
  try {
    env = parseEnv(await fs.readFile(path.join(repoRoot, '.env'), 'utf8'));
  } catch {
    // No .env (a checkout that never ran setup): --url and --secret must be given.
  }

  let base = parsed.values.get('--url');
  if (!base) {
    const vaultPath = env.get('VAULT_PATH');
    if (env.get('TUNNEL_MODE') === 'quick' && vaultPath) {
      try {
        const file = path.join(vaultPath, '_brainstem', 'public-url');
        base = parsePublicUrlFile(await fs.readFile(file, 'utf8')) ?? undefined;
      } catch {
        // Fall through to PUBLIC_URL below.
      }
    }
    base ??= env.get('PUBLIC_URL');
  }
  if (!base) {
    throw new Error('no server URL: pass --url, or set PUBLIC_URL in .env');
  }
  const url = new URL(base);
  // Accept an origin, a path prefix, or the endpoint itself — anything that
  // isn't already the MCP endpoint gets /mcp appended.
  if (!url.pathname.endsWith('/mcp')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/mcp`;
  }

  const secret = parsed.values.get('--secret') ?? env.get('OWNER_SECRET');
  if (!secret) {
    throw new Error('no owner secret: pass --secret, or set OWNER_SECRET in .env');
  }

  return {
    url: url.href,
    secret,
    tokenFile: path.resolve(repoRoot, parsed.values.get('--token-file') ?? DEFAULT_TOKEN_FILE),
    args: [...parsed.bools, ...parsed.positional],
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await runMcpCall(await resolveOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
