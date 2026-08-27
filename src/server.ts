import http from 'node:http';
import { createApp } from './app.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';

export interface RunningServer {
  httpServer: http.Server;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  logger: Logger,
  listenPort: number = config.port,
): Promise<RunningServer> {
  const { app, handler } = createApp(config, logger);
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
      await handler.close(); // abort in-flight MCP exchanges first so sockets can drain
      httpServer.closeIdleConnections(); // drop idle keep-alive sockets held by the Heroku router
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
