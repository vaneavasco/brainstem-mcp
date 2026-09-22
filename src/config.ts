import { z } from 'zod';
import { DEFAULT_RECONCILE_MS, MAX_BINARY_BYTES, MIN_RECONCILE_MS } from './storage/limits.ts';
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
  /** How often FrontmatterIndex.reconcile() runs in the background (ms); 0 disables it. */
  reconcileMs: number;
  publicUrlFile: string | null;
  stateDir: string | null;
  tunnelMode: TunnelMode;
  storage: StorageConfig;
  vaultSettings: VaultSettingsConfig;
  /** Cap for vault_write_binary (attachments); text writes stay at MAX_FILE_BYTES. */
  maxBinaryBytes: number;
  /** When true, only tools whose annotations declare `readOnlyHint: true` are registered — see
   *  `src/tools/register.ts`. Applies to both ways in (HTTP and stdio). */
  readOnly: boolean;
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
  // Optional at the schema level: loadConfig enforces its requiredness separately (see
  // REQUIRED below), and loadVaultConfig — which parses this same schema for a subset of keys —
  // never reads or requires it at all.
  PUBLIC_URL: z.url().optional(),
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
  VAULT_RECONCILE_MS: z.coerce
    .number()
    .int()
    .refine((ms) => ms === 0 || ms >= MIN_RECONCILE_MS, {
      message: `must be 0 (off) or at least ${MIN_RECONCILE_MS} ms: every pass lists the whole vault`,
    })
    .default(DEFAULT_RECONCILE_MS),
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
  // Claude Desktop substitutes a boolean from the install form into env, and nothing documents
  // its spelling: every usual one is read (true/false, 1/0, yes/no, on/off, any case); an empty
  // string is "not set". A server that refuses to start over "True" would be the installer's
  // first experience of it.
  VAULT_READ_ONLY: z
    .string()
    .default('false')
    .transform((raw, ctx) => {
      const v = raw.trim().toLowerCase();
      if (v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
      if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
      ctx.addIssue({ code: 'custom', message: 'VAULT_READ_ONLY must be true or false' });
      return z.NEVER;
    }),
});

const REQUIRED = ['PUBLIC_URL', 'OWNER_SECRET'] as const;

/** The parsed-env fields `buildVaultSettings` needs — a subset of `z.infer<typeof EnvSchema>`
 *  that both `loadConfig` and `loadVaultConfig` satisfy, since both parse the same `EnvSchema`. */
interface VaultSettingsFields {
  DAILY_NOTES_FOLDER: string;
  DAILY_NOTES_FORMAT: string;
  DAILY_NOTES_TEMPLATE?: string;
  VAULT_TIMEZONE: string;
  REQUIRED_FRONTMATTER: string;
}

/**
 * Validates and builds the daily-notes / timezone / required-frontmatter settings shared by
 * `loadConfig` and `loadVaultConfig` — the one place either of them checks a timezone with
 * `Intl.DateTimeFormat`, a folder with `normalizeVaultPath`, or a date format with
 * `resolveDailyNotePath`, so the two validate a vault's settings identically and cannot drift
 * apart on that logic.
 */
function buildVaultSettings(
  d: VaultSettingsFields,
  /** Lenient: an invalid OPTIONAL value falls back to its default and is reported in `warnings`
   *  instead of throwing. The stdio server uses this, because its values come from an install
   *  form typed by a person (a colleague wrote "EEST" and the server refused to start, which the
   *  client showed as a connection error). The HTTP server stays strict: its `.env` is written by
   *  `setup`, which validates. */
  lenient = false,
): { vaultSettings: VaultSettingsConfig; warnings: string[] } {
  const warnings: string[] = [];
  const bad = (key: string, message: string): undefined => {
    if (!lenient) throw new ConfigError([], [key], message);
    warnings.push(message);
  };
  let timezone = d.VAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    bad(
      'VAULT_TIMEZONE',
      `VAULT_TIMEZONE must be a valid IANA timezone (e.g. Europe/Berlin); "${timezone}" is not, using UTC`,
    );
    timezone = 'UTC';
  }
  let folder = d.DAILY_NOTES_FOLDER;
  try {
    // kept normalized ("Daily\\Notes" typed on Windows, a trailing slash): the tools compare this
    // string with note paths, which are always normalized
    folder = folder.trim() === '' ? '' : normalizeVaultPath(folder);
  } catch {
    bad(
      'DAILY_NOTES_FOLDER',
      `DAILY_NOTES_FOLDER must be a vault-relative folder (no .., no hidden folders); "${folder}" is not, using the vault root`,
    );
    folder = '';
  }
  let format = d.DAILY_NOTES_FORMAT;
  const dailyNotes = (fmt: string) => ({
    folder,
    format: fmt,
    template: d.DAILY_NOTES_TEMPLATE ?? null,
    timezone,
  });
  try {
    resolveDailyNotePath(dailyNotes(format), new Date());
  } catch {
    bad(
      'DAILY_NOTES_FORMAT',
      `DAILY_NOTES_FORMAT is not a valid date-fns/strftime pattern; "${format}" is not, using yyyy-MM-dd`,
    );
    format = 'yyyy-MM-dd';
  }
  const vaultSettings: VaultSettingsConfig = {
    dailyNotes: dailyNotes(format),
    requiredFrontmatter: d.REQUIRED_FRONTMATTER.split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  };
  return { vaultSettings, warnings };
}

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

  // Guaranteed defined here: the `missing` check above already required it.
  const publicUrl = new URL(parsed.data.PUBLIC_URL as string);
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
  const storage: StorageConfig =
    d.STORAGE_BACKEND === 'localfs'
      ? { backend: 'localfs', vaultPath: d.VAULT_PATH as string }
      : { backend: 'drive' };
  const vaultSettings = buildVaultSettings(d).vaultSettings;

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
    reconcileMs: d.VAULT_RECONCILE_MS,
    publicUrlFile: d.PUBLIC_URL_FILE ?? null,
    stateDir: d.STATE_DIR ?? null,
    tunnelMode: d.TUNNEL_MODE,
    storage,
    vaultSettings,
    maxBinaryBytes: d.MAX_BINARY_BYTES ?? MAX_BINARY_BYTES,
    readOnly: d.VAULT_READ_ONLY,
  };
}

/** What a vault runtime needs — nothing about HTTP, OAuth or the tunnel. */
export interface VaultConfig {
  vaultPath: string;
  vaultSettings: VaultSettingsConfig;
  watchPollMs: number | null;
  maxBinaryBytes: number;
  /** How often FrontmatterIndex.reconcile() runs in the background (ms); 0 disables it. */
  reconcileMs: number;
  logLevel: LogLevel;
  stateDir: string | null;
  /** When true, only tools whose annotations declare `readOnlyHint: true` are registered — see
   *  `src/tools/register.ts`. Applies to both ways in (HTTP and stdio). */
  readOnly: boolean;
  /** Optional settings that were invalid and fell back to their default (lenient parsing; see
   *  `buildVaultSettings`). Empty when everything was accepted as given. */
  warnings: string[];
}

/** The env keys `loadVaultConfig` reads. Everything else (`PUBLIC_URL`, `OWNER_SECRET`, tunnel
 *  settings, …) is left out of the object handed to `EnvSchema.safeParse` below, so a value that
 *  happens to be malformed there (a leftover `.env` sourced into the same shell, say) can never
 *  make vault loading fail over a field it does not use. */
const VAULT_ENV_KEYS: ReadonlySet<string> = new Set([
  'VAULT_PATH',
  'DAILY_NOTES_FOLDER',
  'DAILY_NOTES_FORMAT',
  'DAILY_NOTES_TEMPLATE',
  'VAULT_TIMEZONE',
  'REQUIRED_FRONTMATTER',
  'VAULT_WATCH_POLL_MS',
  'VAULT_RECONCILE_MS',
  'MAX_BINARY_BYTES',
  'LOG_LEVEL',
  'STATE_DIR',
  'VAULT_READ_ONLY',
]);

/**
 * The subset of configuration a vault runtime needs (see `VaultConfig`) — carved out of
 * `loadConfig` for the stdio entrypoint, which is neither an HTTP server, an OAuth authorization
 * server nor a tunnel client: `PUBLIC_URL`, `OWNER_SECRET` and every tunnel setting are neither
 * read nor required here, and `STORAGE_BACKEND` does not apply (a stdio session always opens a
 * local vault directory, given by `VAULT_PATH` or `--vault`).
 *
 * Parses the very same `EnvSchema` `loadConfig` does (so a knob like `VAULT_RECONCILE_MS`'s
 * bounds is validated identically for both) and shares `buildVaultSettings` for the daily-notes /
 * timezone logic, so the two paths cannot drift apart on what a valid vault configuration is.
 */
export function loadVaultConfig(
  env: Record<string, string | undefined> = process.env,
): VaultConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([key, v]) => v !== '' && VAULT_ENV_KEYS.has(key)),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError([], invalid);
  }
  const d = parsed.data;
  if (!d.VAULT_PATH) {
    throw new ConfigError(['VAULT_PATH'], [], 'pass --vault <path>, or set VAULT_PATH');
  }
  const { vaultSettings, warnings } = buildVaultSettings(d, true);
  return {
    vaultPath: d.VAULT_PATH,
    vaultSettings,
    watchPollMs: d.VAULT_WATCH_POLL_MS ?? null,
    maxBinaryBytes: d.MAX_BINARY_BYTES ?? MAX_BINARY_BYTES,
    reconcileMs: d.VAULT_RECONCILE_MS,
    logLevel: d.LOG_LEVEL,
    stateDir: d.STATE_DIR ?? null,
    readOnly: d.VAULT_READ_ONLY,
    warnings,
  };
}
