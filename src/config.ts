import { z } from 'zod';
import { MAX_BINARY_BYTES } from './storage/limits.ts';
import { normalizeVaultPath } from './storage/path-policy.ts';
import { resolveDailyNotePath } from './vault/daily-notes.ts';

export type LegacyMode = 'stateless' | 'reject';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type TunnelMode = 'cloudflare' | 'quick' | 'none';

export type StorageConfig = { backend: 'localfs'; vaultPath: string } | { backend: 'drive' };

export interface VaultSettingsConfig {
  dailyNotes: { folder: string; format: string; template: string | null; timezone: string };
  requiredFrontmatter: string[];
}

export interface Config {
  publicUrl: URL;
  mcpUrl: URL;
  port: number;
  logLevel: LogLevel;
  legacyMode: LegacyMode;
  ownerSecret: string;
  cimdAllowedHosts: string[];
  accessTokenTtlS: number;
  refreshTokenTtlS: number;
  watchPollMs: number | null;
  publicUrlFile: string | null;
  stateDir: string | null;
  tunnelMode: TunnelMode;
  storage: StorageConfig;
  vaultSettings: VaultSettingsConfig;
  /** Cap for vault_write_binary (attachments); text writes stay at MAX_FILE_BYTES. */
  maxBinaryBytes: number;
}

export const OWNER_SECRET_MIN_BYTES = 32;

export function decodeOwnerSecretBytes(s: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return -1;
  return Buffer.from(s, 'base64url').length;
}

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[], hint?: string) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required env vars: ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid env vars: ${invalid.join(', ')}`);
    if (hint) parts.push(hint);
    super(`Configuration error — ${parts.join('; ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

const EnvSchema = z.object({
  PUBLIC_URL: z.url(),
  ALLOW_INSECURE_PUBLIC_URL: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MCP_LEGACY_MODE: z.enum(['stateless', 'reject']).default('stateless'),
  OWNER_SECRET: z.string().optional(),
  CIMD_ALLOWED_HOSTS: z.string().default('claude.ai,claude.com'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().min(60).max(86_400).default(3600),
  REFRESH_TOKEN_TTL_S: z.coerce
    .number()
    .int()
    .min(3600)
    .default(90 * 24 * 3600),
  VAULT_WATCH_POLL_MS: z.coerce.number().int().min(250).max(60_000).optional(),
  PUBLIC_URL_FILE: z.string().min(1).optional(),
  STATE_DIR: z.string().min(1).optional(),
  TUNNEL_MODE: z.enum(['cloudflare', 'quick', 'none']).default('none'),
  STORAGE_BACKEND: z.enum(['drive', 'localfs']).default('localfs'),
  VAULT_PATH: z.string().min(1).optional(),
  DAILY_NOTES_FOLDER: z.string().default(''),
  DAILY_NOTES_FORMAT: z.string().min(1).default('yyyy-MM-dd'),
  DAILY_NOTES_TEMPLATE: z.string().optional(),
  VAULT_TIMEZONE: z.string().min(1).default('UTC'),
  REQUIRED_FRONTMATTER: z.string().default(''),
  MAX_BINARY_BYTES: z.coerce.number().int().min(1).optional(),
});

const REQUIRED = ['PUBLIC_URL', 'OWNER_SECRET'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // .env templates ship empty keys (FOO=); treat an empty value as unset everywhere.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

  const missing = REQUIRED.filter((key) => !cleaned[key] || cleaned[key]?.trim() === '');
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].filter(
      (key) => !missing.includes(key as (typeof REQUIRED)[number]),
    );
    throw new ConfigError(
      missing,
      invalid,
      missing.length > 0 ? 'run `./brainstem setup` to generate .env' : undefined,
    );
  }
  if (missing.length > 0) {
    throw new ConfigError(missing, [], 'run `./brainstem setup` to generate .env');
  }

  const publicUrl = new URL(parsed.data.PUBLIC_URL);
  publicUrl.hash = '';
  publicUrl.search = '';
  // A path prefix (https://host/brain) only ever half-worked: the metadata
  // documents carry it, but the PRM well-known path, the tunnel target and
  // the compose wiring are all origin-shaped. Reject it instead of shipping
  // a URL that authenticates but doesn't route.
  if (publicUrl.pathname !== '/') {
    throw new ConfigError([], ['PUBLIC_URL'], 'PUBLIC_URL must be a bare origin (no path)');
  }
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
  if (publicUrl.protocol !== 'https:' && parsed.data.ALLOW_INSECURE_PUBLIC_URL !== 'true') {
    throw new ConfigError(
      [],
      ['PUBLIC_URL'],
      'PUBLIC_URL must be https unless ALLOW_INSECURE_PUBLIC_URL=true',
    );
  }
  const mcpUrl = new URL(publicUrl);
  mcpUrl.pathname = `${publicUrl.pathname === '/' ? '' : publicUrl.pathname}/mcp`;

  const d = parsed.data;

  const secretBytes = decodeOwnerSecretBytes(d.OWNER_SECRET as string);
  if (secretBytes < OWNER_SECRET_MIN_BYTES) {
    throw new ConfigError(
      [],
      ['OWNER_SECRET'],
      secretBytes === -1
        ? 'OWNER_SECRET must be base64url (run `./brainstem setup`)'
        : `OWNER_SECRET must decode to at least ${OWNER_SECRET_MIN_BYTES} bytes (run \`./brainstem setup\`)`,
    );
  }

  const cimdAllowedHosts = d.CIMD_ALLOWED_HOSTS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cimdAllowedHosts.some((h) => !/^[a-z0-9.-]+$/i.test(h))) {
    throw new ConfigError(
      [],
      ['CIMD_ALLOWED_HOSTS'],
      'CIMD_ALLOWED_HOSTS is a comma-separated list of hostnames',
    );
  }

  if (d.STORAGE_BACKEND === 'localfs' && !d.VAULT_PATH) {
    throw new ConfigError(
      ['VAULT_PATH'],
      [],
      'VAULT_PATH is required when STORAGE_BACKEND=localfs',
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: d.VAULT_TIMEZONE });
  } catch {
    throw new ConfigError(
      [],
      ['VAULT_TIMEZONE'],
      'VAULT_TIMEZONE must be a valid IANA timezone (e.g. Europe/Chisinau)',
    );
  }
  const storage: StorageConfig =
    d.STORAGE_BACKEND === 'localfs'
      ? { backend: 'localfs', vaultPath: d.VAULT_PATH as string }
      : { backend: 'drive' };
  const vaultSettings: VaultSettingsConfig = {
    dailyNotes: {
      folder: d.DAILY_NOTES_FOLDER,
      format: d.DAILY_NOTES_FORMAT,
      template: d.DAILY_NOTES_TEMPLATE ?? null,
      timezone: d.VAULT_TIMEZONE,
    },
    requiredFrontmatter: d.REQUIRED_FRONTMATTER.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  try {
    normalizeVaultPath(vaultSettings.dailyNotes.folder);
  } catch {
    throw new ConfigError(
      [],
      ['DAILY_NOTES_FOLDER'],
      'DAILY_NOTES_FOLDER must be a vault-relative folder (no .., no hidden folders)',
    );
  }
  try {
    resolveDailyNotePath(vaultSettings.dailyNotes, new Date());
  } catch {
    throw new ConfigError(
      [],
      ['DAILY_NOTES_FORMAT'],
      'DAILY_NOTES_FORMAT is not a valid date-fns/strftime pattern',
    );
  }

  return {
    publicUrl,
    mcpUrl,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    legacyMode: parsed.data.MCP_LEGACY_MODE,
    ownerSecret: d.OWNER_SECRET as string,
    cimdAllowedHosts,
    accessTokenTtlS: d.ACCESS_TOKEN_TTL_S,
    refreshTokenTtlS: d.REFRESH_TOKEN_TTL_S,
    watchPollMs: d.VAULT_WATCH_POLL_MS ?? null,
    publicUrlFile: d.PUBLIC_URL_FILE ?? null,
    stateDir: d.STATE_DIR ?? null,
    tunnelMode: d.TUNNEL_MODE,
    storage,
    vaultSettings,
    maxBinaryBytes: d.MAX_BINARY_BYTES ?? MAX_BINARY_BYTES,
  };
}
