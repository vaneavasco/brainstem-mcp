import pino, { type Logger } from 'pino';
import type { LogLevel } from './config.ts';

export type { Logger };

const SECRET_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'code',
  'code_verifier',
  'authorization',
  'refresh_token_enc',
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SECRET_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `req.headers.${key}`, `res.headers.${key}`);
  }
  paths.push('req.headers.cookie', 'res.headers["set-cookie"]');
  return paths;
}

export function createLogger(level: LogLevel, destination?: NodeJS.WritableStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
