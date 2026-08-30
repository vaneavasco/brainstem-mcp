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
 * Flags
 *   --list              list the server's tools instead of calling one
 *   --url <mcpUrl>      default: PUBLIC_URL from .env (or, in TUNNEL_MODE=quick,
 *                       the URL the supervisor wrote to
 *                       <VAULT_PATH>/_brainstem/public-url), with /mcp appended
 *   --secret <s>        default: OWNER_SECRET from .env
 *   --token-file <p>    default: .brainstem-dev-tokens.json in the repo root (gitignored)
 *   --reauth            throw away the cached tokens and consent again
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
 * `transport.finishAuth()`. Tokens (and the issuer the SDK stamps on them) are
 * cached in the token file at mode 0600 and reused on the next run; refreshes are
 * the SDK's job from then on.
 *
 * DEV SHORTCUT, deliberate: this identifies as the Claude Code client
 * (`clientMetadataUrl` = https://claude.ai/oauth/claude-code-client-metadata) so it
 * passes our AS's CIMD host allowlist without registering a client of its own. The
 * consent page will therefore say "Claude Code" — that is this script, not the CLI.
 */

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

async function readTokenFile(file: string): Promise<StoredOAuthTokens | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // No cache yet, or an unreadable/half-written one: just log in again.
    return undefined;
  }
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as StoredOAuthTokens).access_token === 'string'
  ) {
    return raw as StoredOAuthTokens;
  }
  return undefined;
}

async function writeTokenFile(file: string, tokens: StoredOAuthTokens): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when writeFile creates the file; an existing one keeps
  // whatever mode it had, so re-assert it every time.
  await fs.chmod(file, 0o600);
}

/**
 * The SDK's OAuth client, wired for a terminal. Everything an interactive host
 * would keep in a keychain lives in one 0600 JSON file; the browser step is
 * replaced by `redirectToAuthorization` driving the consent form over fetch.
 */
class DevOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl = CLAUDE_CODE_CIMD;
  /** `code` / `state` / `iss` scraped off the consent redirect, for `finishAuth`. */
  callbackParams: URLSearchParams | undefined;
  private stored: StoredOAuthTokens | undefined;
  private verifier = '';
  private discovery: OAuthDiscoveryState | undefined;
  private readonly tokenFile: string;
  private readonly secret: string;

  // Explicit fields rather than constructor parameter properties:
  // `erasableSyntaxOnly` is on, because Node runs these .ts files directly.
  constructor(tokenFile: string, secret: string) {
    this.tokenFile = tokenFile;
    this.secret = secret;
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

  loadTokens(tokens: StoredOAuthTokens | undefined): void {
    this.stored = tokens;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.stored;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: { issuer: string }): Promise<void> {
    // The SDK stamps `issuer` itself; the fallback keeps a cached file bound to
    // the AS that issued it even if a future SDK stops stamping it.
    this.stored = !tokens.issuer && ctx ? { ...tokens, issuer: ctx.issuer } : tokens;
    await writeTokenFile(this.tokenFile, this.stored);
  }

  /** The browser step, headless: fetch the page, approve the form, keep the 302. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
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

    const res = await fetch(new URL('/oauth/consent', authorizationUrl), {
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

  const flags = new Set(opts.args.filter((a) => a.startsWith('--')));
  const positional = opts.args.filter((a) => !a.startsWith('--'));
  const list = flags.has('--list');
  const toolName = positional[0];

  if (!list && !toolName) {
    printErr('usage: npm run mcp:call -- <tool> [json-args]   (or --list)');
    return 1;
  }

  let toolArgs: Record<string, unknown> = {};
  if (positional[1]) {
    try {
      const parsed: unknown = JSON.parse(positional[1]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      toolArgs = parsed as Record<string, unknown>;
    } catch (error) {
      printErr(`bad json-args: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (flags.has('--reauth')) {
    await fs.rm(opts.tokenFile, { force: true });
  }

  const provider = new DevOAuthProvider(opts.tokenFile, opts.secret);
  provider.loadTokens(flags.has('--reauth') ? undefined : await readTokenFile(opts.tokenFile));

  const endpoint = new URL(opts.url);
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

function flagValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** Strips `--url`/`--secret`/`--token-file` (and their values) from the argv tail. */
function stripValueFlags(argv: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i] as string)) {
      i += 1;
      continue;
    }
    out.push(argv[i] as string);
  }
  return out;
}

/**
 * Fills in `--url` / `--secret` / `--token-file` from `.env`, exactly the file the
 * running server was started with. In quick-tunnel mode the URL is whatever the
 * supervisor last wrote into the vault, not what `.env` says.
 */
export async function resolveOptions(argv: string[]): Promise<McpCallOptions> {
  const envFile = path.join(REPO_ROOT, '.env');
  let env = new Map<string, string>();
  try {
    env = parseEnv(await fs.readFile(envFile, 'utf8'));
  } catch {
    // No .env (a checkout that never ran setup): --url and --secret must be given.
  }

  let base = flagValue(argv, '--url');
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
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp';

  const secret = flagValue(argv, '--secret') ?? env.get('OWNER_SECRET');
  if (!secret) {
    throw new Error('no owner secret: pass --secret, or set OWNER_SECRET in .env');
  }

  const tokenFile = path.resolve(REPO_ROOT, flagValue(argv, '--token-file') ?? DEFAULT_TOKEN_FILE);

  return {
    url: url.href,
    secret,
    tokenFile,
    args: stripValueFlags(argv, ['--url', '--secret', '--token-file']),
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
