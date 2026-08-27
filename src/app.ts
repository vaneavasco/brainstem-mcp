import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { createVaultServer } from './mcp/factory.ts';
import { SERVER_INFO } from './version.ts';

export interface AppBundle {
  app: Express;
  handler: McpHttpHandler;
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function createApp(config: Config, logger: Logger): AppBundle {
  const handler = createMcpHandler((ctx) => createVaultServer(ctx), {
    legacy: config.legacyMode,
    keepAliveMs: 15_000, // Heroku closes idle streams after 55 s
    onerror: (error) => logger.warn({ err: error }, 'mcp handler error'),
  });

  const allowed = [config.publicUrl.hostname, ...LOCAL_HOSTNAMES];
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: allowed,
    allowedOrigins: allowed,
    jsonLimit: '2mb', // 1 MB note + base64/JSON overhead
  });
  app.set('trust proxy', 1); // Heroku router: only for req.secure, never for URL building
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_INFO.name, version: SERVER_INFO.version });
  });

  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => {
    res.setHeader('X-Accel-Buffering', 'no');
    void node(req, res, req.body);
  });

  return { app, handler };
}
