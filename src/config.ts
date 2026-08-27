import { z } from 'zod';

export type LegacyMode = 'stateless' | 'reject';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Config {
  publicUrl: URL;
  mcpUrl: URL;
  port: number;
  logLevel: LogLevel;
  legacyMode: LegacyMode;
  databaseUrl: string | undefined;
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

  return {
    publicUrl,
    mcpUrl,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    legacyMode: parsed.data.MCP_LEGACY_MODE,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
