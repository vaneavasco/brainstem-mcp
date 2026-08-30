import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Express, NextFunction, Request, Response } from 'express';
import type { AuthDeps } from './auth/mount.ts';
import { bearerGate, createRateLimiter, createUnauthLimiter, mountAuth } from './auth/mount.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { createVaultServer } from './mcp/factory.ts';
import type { RuntimeResolver } from './vault/runtime.ts';
import { SERVER_INFO } from './version.ts';

export interface AppBundle {
  app: Express;
  handler: McpHttpHandler;
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

interface BodyParserError {
  status?: unknown;
  type?: unknown;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return typeof err === 'object' && err !== null;
}

function errorStatus(err: unknown): number {
  return isBodyParserError(err) && typeof err.status === 'number' ? err.status : 500;
}

function errorType(err: unknown): string | undefined {
  return isBodyParserError(err) && typeof err.type === 'string' ? err.type : undefined;
}

function errorShape(type: string | undefined): { code: number; message: string } {
  switch (type) {
    case 'entity.parse.failed':
      return { code: -32700, message: 'Parse error' };
    case 'entity.too.large':
      return { code: -32600, message: 'Payload too large' };
    default:
      return { code: -32000, message: 'Internal error' };
  }
}

export interface AppExtras {
  notes?: () => number;
  /** Per-connection MCP `instructions`; see `FactoryDeps.instructions`. */
  instructions?: () => Promise<string>;
}

export function createApp(
  config: Config,
  logger: Logger,
  resolveRuntime: RuntimeResolver,
  auth: AuthDeps,
  extras: AppExtras = {},
): AppBundle {
  const handler = createMcpHandler(
    (ctx) => createVaultServer(ctx, { resolveRuntime, logger, instructions: extras.instructions }),
    {
      legacy: config.legacyMode,
      keepAliveMs: 15_000, // keeps SSE streams alive through proxies that drop idle connections
      onerror: (error) => logger.warn({ err: error }, 'mcp handler error'),
    },
  );

  const allowed = [config.publicUrl.hostname, ...LOCAL_HOSTNAMES];
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: allowed,
    allowedOrigins: allowed,
    jsonLimit: '2mb', // 1 MB note + base64/JSON overhead
  });
  app.set('trust proxy', 1); // cloudflared sits in front: only for req.secure, never for URL building
  app.disable('x-powered-by');

  mountAuth(app, config, logger, auth);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      publicUrl: config.publicUrl.href,
      mcpUrl: config.mcpUrl.href,
      tunnelMode: config.tunnelMode,
      vault: { notes: extras.notes?.() ?? 0 },
    });
  });

  const node = toNodeHandler(handler);
  // Order matters: the unauthenticated bucket first (so an anonymous flood is
  // capped before it can touch the owner's), then the bearer gate, then the
  // main 60/60 bucket — which only authenticated requests ever draw from.
  app.all(
    '/mcp',
    createUnauthLimiter(auth.now),
    bearerGate(config, auth),
    createRateLimiter({ capacity: 60, refillPerSec: 60, now: auth.now }),
    (req, res) => {
      res.setHeader('X-Accel-Buffering', 'no');
      void node(req, res, req.body);
    },
  );

  // Catch-all for unknown routes: keep every response on this server JSON-RPC shaped,
  // never Express's default HTML "Cannot GET /" page.
  app.use((_req, res) => {
    res
      .status(404)
      .json({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null });
  });

  // Terminal error handler (4-arity is what makes Express treat this as an error handler).
  // Body-parser failures (malformed JSON, oversized payloads) land here; never leak a
  // stack trace or a filesystem path to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = errorStatus(err);
    const type = errorType(err);
    const { code, message } = errorShape(type);
    logger.warn({ type, status }, 'request rejected');
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  });

  return { app, handler };
}
