import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerResolver } from './auth/context.ts';
import { createAuth } from './auth/mount.ts';
import { FileTokenStore } from './auth/store/file-store.ts';
import { StoreCorruptError } from './auth/store/types.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startServer } from './server.ts';
import { waitForPublicUrl, watchPublicUrl } from './tunnel/public-url-file.ts';
import { writeConnectionNote, writeInstanceFile } from './vault/connection-note.ts';
import { createLocalRuntime } from './vault/runtime.ts';

const PUBLIC_URL_WAIT_TIMEOUT_MS = 120_000;
const PUBLIC_URL_WAIT_POLL_MS = 1_000;
const PUBLIC_URL_WAIT_LOG_MS = 10_000;
const PUBLIC_URL_WATCH_POLL_MS = 5_000;
const SWEEP_INTERVAL_MS = 600_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
// Obsidian Sync / Syncthing leave a sibling copy next to a file they can't
// merge (e.g. `state (conflict).json`, `state.sync-conflict-...json`) — we
// only ever read/write state.json itself, so a match here means a write
// raced a sync and needs the owner's attention, not ours.
const STATE_CONFLICT_RE = /^state.*(conflict|conflicted)/i;

async function main(): Promise<void> {
  // No Config yet (loadConfig needs env resolved first when PUBLIC_URL_FILE
  // is set), so this boot logger always runs at 'info' regardless of the
  // eventual LOG_LEVEL.
  const bootLogger = createLogger('info');

  let env: Record<string, string | undefined> = process.env;
  // Only a quick tunnel publishes its URL through a file: `cloudflare` mode's
  // URL is fixed by the token and `none` has none at all, so in those modes a
  // leftover `public-url` from an earlier quick run must never be read — it
  // would silently override PUBLIC_URL with a dead hostname.
  const publicUrlFile = env.TUNNEL_MODE === 'quick' ? env.PUBLIC_URL_FILE : undefined;
  if (env.PUBLIC_URL_FILE && !publicUrlFile) {
    bootLogger.warn(
      { file: env.PUBLIC_URL_FILE, tunnelMode: env.TUNNEL_MODE ?? '(unset)' },
      'PUBLIC_URL_FILE is only used when TUNNEL_MODE=quick — ignoring it',
    );
  }
  let currentPublicUrl: string | undefined;
  if (publicUrlFile) {
    bootLogger.info({ file: publicUrlFile }, 'waiting for tunnel public URL');
    const progress = setInterval(() => {
      bootLogger.info({ file: publicUrlFile }, 'still waiting for tunnel public URL');
    }, PUBLIC_URL_WAIT_LOG_MS);
    progress.unref();
    let publicUrl: string;
    try {
      publicUrl = await waitForPublicUrl(publicUrlFile, {
        timeoutMs: PUBLIC_URL_WAIT_TIMEOUT_MS,
        intervalMs: PUBLIC_URL_WAIT_POLL_MS,
      });
    } catch (error) {
      clearInterval(progress);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    clearInterval(progress);
    currentPublicUrl = publicUrl;
    env = {
      ...env,
      PUBLIC_URL: publicUrl,
      ALLOW_INSECURE_PUBLIC_URL: publicUrl.startsWith('https:') ? 'false' : 'true',
    };
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
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

  const stateDir = config.stateDir ?? path.join(config.storage.vaultPath, '_brainstem');

  const runtime = await createLocalRuntime({
    vaultPath: config.storage.vaultPath,
    settings: config.vaultSettings,
    watchPollMs: config.watchPollMs,
  });
  logger.info(
    { vaultPath: config.storage.vaultPath, indexed: runtime.index.size() },
    'vault runtime ready',
  );

  let store: FileTokenStore;
  try {
    store = await FileTokenStore.open(path.join(stateDir, 'state.json'));
  } catch (error) {
    if (error instanceof StoreCorruptError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  await store.sweepExpired(Date.now());
  const sweepTimer = setInterval(() => {
    void store.sweepExpired(Date.now()).catch((error: unknown) => {
      logger.error({ err: error }, 'sweepExpired failed');
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  try {
    for (const entry of await fs.readdir(stateDir)) {
      if (STATE_CONFLICT_RE.test(entry)) {
        logger.warn({ file: entry }, 'possible sync-conflict copy of state file — ignored');
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not scan state dir for sync-conflict copies');
  }

  const auth = createAuth(config, logger, store);
  const running = await startServer(
    config,
    logger,
    createOwnerResolver(runtime),
    auth,
    config.port,
    { extras: { notes: () => runtime.index.size() } },
  );

  await writeConnectionNote(stateDir, {
    publicUrl: config.publicUrl.href,
    mcpUrl: config.mcpUrl.href,
    tunnelMode: config.tunnelMode,
    updatedAt: new Date().toISOString(),
  });

  const hostname = os.hostname();
  const startedAt = new Date().toISOString();
  const { otherHost } = await writeInstanceFile(stateDir, {
    hostname,
    startedAt,
    heartbeatAt: startedAt,
  });
  if (otherHost) {
    logger.warn(
      { otherHost },
      'another brainstem-mcp instance looks live on this vault — two processes writing the same vault can race each other',
    );
  }
  const heartbeatTimer = setInterval(() => {
    void writeInstanceFile(stateDir, {
      hostname,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    }).catch((error: unknown) => {
      logger.error({ err: error }, 'instance heartbeat failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  let stopWatch: (() => void) | null = null;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);
    stopWatch?.();
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

  if (publicUrlFile && currentPublicUrl) {
    stopWatch = watchPublicUrl(
      publicUrlFile,
      currentPublicUrl,
      () => {
        logger.warn('tunnel URL changed — restarting');
        shutdown('tunnel-url-changed');
      },
      PUBLIC_URL_WATCH_POLL_MS,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
