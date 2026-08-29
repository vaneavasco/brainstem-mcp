import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startServer } from './server.ts';
import { createLocalRuntime } from './vault/runtime.ts';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  if (config.storage.backend !== 'localfs') {
    logger.fatal(
      'only STORAGE_BACKEND=localfs is supported. Set STORAGE_BACKEND=localfs and VAULT_PATH.',
    );
    process.exit(1);
  }
  const runtime = await createLocalRuntime({
    vaultPath: config.storage.vaultPath,
    settings: config.vaultSettings,
    watchPollMs: config.watchPollMs,
  });
  logger.info(
    { vaultPath: config.storage.vaultPath, indexed: runtime.index.size() },
    'vault runtime ready',
  );
  const running = await startServer(config, logger, async () => runtime);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 10_000);
    running
      .close()
      .then(() => runtime.close())
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
