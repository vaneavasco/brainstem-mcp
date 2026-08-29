import http from 'node:http';
import { type AppExtras, createApp } from './app.ts';
import type { AuthDeps } from './auth/mount.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { RuntimeResolver } from './vault/runtime.ts';

export interface RunningServer {
  httpServer: http.Server;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  logger: Logger,
  resolveRuntime: RuntimeResolver,
  auth: AuthDeps,
  listenPort: number = config.port,
  opts: { drainMs?: number; extras?: AppExtras } = {},
): Promise<RunningServer> {
  const drainMs = opts.drainMs ?? 7_000;
  const { app, handler } = createApp(config, logger, resolveRuntime, auth, opts.extras);
  const httpServer = http.createServer(app);

  // Heroku router keeps idle connections for 90 s; a shorter dyno-side timeout causes H13/H18.
  httpServer.keepAliveTimeout = 95_000;
  httpServer.headersTimeout = 100_000;
  // Long-lived SSE responses (subscriptions/listen) must not be cut by Node's 5-minute default.
  httpServer.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(listenPort, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: listenPort, publicUrl: config.publicUrl.href }, 'brainstem-mcp listening');

  httpServer.on('error', (error) => logger.error({ err: error }, 'http server error'));

  return {
    httpServer,
    async close() {
      // 1. Stop accepting; Node marks new responses `Connection: close` and closes idle sockets.
      const closing = new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      httpServer.closeIdleConnections(); // belt-and-braces for Node < 19; close() already does this
      // 2. Give in-flight exchanges up to drainMs to finish on their own.
      const drained = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), drainMs).unref()),
      ]);
      // 3. Abort what is still running (long-lived SSE streams) and force remaining sockets shut.
      await handler.close();
      if (!drained) httpServer.closeAllConnections();
      await closing;
    },
  };
}
