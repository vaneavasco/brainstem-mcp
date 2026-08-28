import { z } from 'zod';

export type LegacyMode = 'stateless' | 'reject';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

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
  databaseUrl: string | undefined;
  storage: StorageConfig;
  vaultSettings: VaultSettingsConfig;
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
  DATABASE_URL: z.string().min(1).optional(),
  STORAGE_BACKEND: z.enum(['drive', 'localfs']).default('drive'),
  VAULT_PATH: z.string().min(1).optional(),
  DAILY_NOTES_FOLDER: z.string().default(''),
  DAILY_NOTES_FORMAT: z.string().min(1).default('yyyy-MM-dd'),
  DAILY_NOTES_TEMPLATE: z.string().optional(),
  VAULT_TIMEZONE: z.string().min(1).default('UTC'),
  REQUIRED_FRONTMATTER: z.string().default(''),
});

const REQUIRED = ['PUBLIC_URL'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED.filter((key) => !env[key] || env[key]?.trim() === '');
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].filter(
      (key) => !missing.includes(key as (typeof REQUIRED)[number]),
    );
    throw new ConfigError(missing, invalid);
  }
  if (missing.length > 0) throw new ConfigError(missing, []);

  const publicUrl = new URL(parsed.data.PUBLIC_URL);
  publicUrl.hash = '';
  publicUrl.search = '';
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

  return {
    publicUrl,
    mcpUrl,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    legacyMode: parsed.data.MCP_LEGACY_MODE,
    databaseUrl: parsed.data.DATABASE_URL,
    storage,
    vaultSettings,
  };
}
