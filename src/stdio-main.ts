import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type VaultPathContext, validateVaultPath } from './cli/vault-path.ts';
import { ConfigError, loadVaultConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { createVaultServer } from './mcp/factory.ts';
import {
  createInstructionsProvider,
  writeInstructionsTemplateIfMissing,
} from './vault/instructions.ts';
import { createLocalRuntime, type VaultRuntime } from './vault/runtime.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Resolves once what was written to `stream` has left the process. A pipe is written
 *  asynchronously on Windows, so answers still queued at `exit()` would be lost there. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0 || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('drain', resolve);
    stream.once('error', () => resolve());
    stream.once('close', () => resolve());
  });
}

/** `--vault <path>` from an argv array (e.g. `process.argv.slice(2)`); `undefined` when absent. */
export function parseVaultArg(argv: readonly string[]): string | undefined {
  const inline = argv.find((arg) => arg.startsWith('--vault='));
  if (inline !== undefined) {
    const value = inline.slice('--vault='.length);
    if (value === '') throw new Error('--vault requires a path');
    return value;
  }
  const i = argv.indexOf('--vault');
  if (i === -1) return undefined;
  const value = argv[i + 1];
  // `--vault --foo` must not become a folder named "--foo"
  if (value === undefined || value.startsWith('-')) throw new Error('--vault requires a path');
  return value;
}

/** What `validateVaultPath` needs from the machine; the code's own folder stands in for "the
 *  repository" (a vault that contains the running server is wrong whichever way it was installed). */
function vaultPathContext(): VaultPathContext {
  return {
    home: os.homedir(),
    repoDir: path.resolve(import.meta.dirname, '..'),
    platform: process.platform,
    async stat(p) {
      try {
        const s = await fs.stat(p);
        return { isDirectory: () => s.isDirectory() };
      } catch {
        return null;
      }
    },
    async probeWrite(p) {
      const probe = path.join(p, `.brainstem-write-test-${process.pid}-${Date.now()}`);
      try {
        await fs.writeFile(probe, '');
        await fs.rm(probe, { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface StdioMainOptions {
  /** Overrides `VAULT_PATH` — what `--vault <path>` resolves to. */
  vaultOverride?: string;
  env?: Record<string, string | undefined>;
  /** Where the process exits (mockable so a test can assert on the call instead of the process
   *  actually dying); defaults to the real `process.exit`. */
  exit?: (code: number) => void;
  /** Where stderr goes; defaults to the real `process.stderr`. Never anything writes to stdout on
   *  this path — that stream carries the JSON-RPC protocol and nothing else. */
  stderr?: NodeJS.WritableStream;
}

/**
 * Boots the stdio entrypoint: loads only what a vault runtime needs (`loadVaultConfig` — no
 * `PUBLIC_URL`, `OWNER_SECRET` or tunnel settings), builds the runtime with `deferIndex: true` (a
 * client that starts this process per session cannot wait out a large vault's index build), and
 * serves it over stdio with the exact factory (`createVaultServer`) the HTTP server uses, so both
 * ways in expose the same tools by construction. The owner's `_brainstem/instructions.md` reaches
 * this server the same way it reaches the HTTP one — by reusing `src/vault/instructions.ts`, not
 * copying it.
 *
 * stdout carries the protocol and nothing else: every log line goes to stderr
 * (`createLogger(level, stderr)`), and an unusable or missing vault path is reported there, as a
 * single line, before any byte reaches stdout.
 *
 * Resolves once the server is serving; the process then stays alive until stdin closes, or
 * SIGTERM/SIGINT arrives, at which point the runtime (watcher, reconcile timer) is closed and the
 * process exits 0 — or 1, on a config/vault error, before serving ever starts.
 */
export async function runStdioServer(opts: StdioMainOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const stderr = opts.stderr ?? process.stderr;
  const fail = (message: string): void => {
    stderr.write(`${message}\n`);
    exit(1);
  };

  let vaultConfig: ReturnType<typeof loadVaultConfig>;
  try {
    vaultConfig = loadVaultConfig(
      opts.vaultOverride !== undefined ? { ...env, VAULT_PATH: opts.vaultOverride } : env,
    );
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  // Before anything is created: a mistyped folder must be an error, not an empty vault that the
  // server quietly makes and then serves. Same rules as `./brainstem setup` (absolute, exists,
  // a folder, writable, not the filesystem root, not the home directory, not around this code).
  const verdict = await validateVaultPath(vaultConfig.vaultPath, vaultPathContext());
  if (!verdict.ok) return fail(`Unusable vault folder: ${verdict.error}`);
  if (vaultConfig.vaultPath.split(/[\\/]/).includes('_brainstem')) {
    return fail(`Unusable vault folder: "${vaultConfig.vaultPath}" is inside a _brainstem folder`);
  }

  const logger: Logger = createLogger(vaultConfig.logLevel, stderr);
  const stateDir = vaultConfig.stateDir ?? path.join(vaultConfig.vaultPath, '_brainstem');

  let runtime: VaultRuntime;
  try {
    runtime = await createLocalRuntime({
      vaultPath: vaultConfig.vaultPath,
      settings: vaultConfig.vaultSettings,
      watchPollMs: vaultConfig.watchPollMs,
      stateDir,
      maxBinaryBytes: vaultConfig.maxBinaryBytes,
      reconcileMs: vaultConfig.reconcileMs,
      deferIndex: true,
      onIndexError: (error) => logger.error({ err: error }, 'background index build failed'),
      onReconcileError: () => logger.warn('index reconcile failed; the next pass will retry'),
      onIndexOverBudget: (state) =>
        logger.warn(state, 'the vault index is over its size budget: nothing is dropped'),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  // Seeded once, from the same code the HTTP server uses (src/vault/instructions.ts), so a
  // reader who only ever uses stdio still gets the note explaining the feature in Obsidian.
  try {
    if (await writeInstructionsTemplateIfMissing(stateDir)) {
      logger.info(
        { file: path.join(stateDir, 'instructions.md') },
        'seeded owner instructions template',
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not seed the owner instructions template');
  }
  const instructions = createInstructionsProvider(stateDir);

  // Declared before the server so the transport's own error report can end the process too.
  let onTransportError: (error: Error) => void = () => {};
  const handle = serveStdio(
    (ctx) =>
      createVaultServer(ctx, {
        resolveRuntime: async () => runtime,
        logger,
        instructions: () => instructions.get(),
      }),
    { onerror: (error) => onTransportError(error) },
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      // Said before leaving: an exit code 1 with no line is the hardest failure to explain.
      logger.error({ signal, afterMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown did not finish in time');
      exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Order matters: the calls already running finish and are answered while the transport is
    // still open (a burst of writes followed by a disconnect used to leave nothing on disk);
    // only then is the transport closed, and the runtime last.
    runtime.calls
      .drain()
      .then(() => flushed(process.stdout))
      .then(() => handle.close())
      .then(() => runtime.close())
      .then(() => {
        clearTimeout(timer);
        exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        logger.error({ err: error }, 'shutdown failed');
        exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.stdin.on('end', () => shutdown('stdin-end'));
  // A client that dies without closing its end (SIGKILL, a crash) does not always produce an
  // 'end': when a response is then written, stdout fails with EPIPE, the SDK's transport closes
  // itself and PAUSES stdin, and 'end' never comes. Measured: the server stayed alive, holding
  // the vault's watcher, until someone killed it. So every sign that the other side is gone ends
  // this process: stdin closing, and stdout failing. `shutdown` is idempotent.
  onTransportError = (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    logger.warn({ code, message: error.message }, 'stdio transport error');
    // a broken pipe is the client going away; anything else is reported and survived
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET') {
      shutdown('transport-error');
    }
  };
  process.stdin.on('close', () => shutdown('stdin-close'));
  // The log goes to stderr. A client that closes that pipe too must not turn a clean stop into an
  // uncaught EPIPE (exit code 1, nothing closed): the log line is lost, the stop goes on.
  process.stderr.on('error', () => shutdown('stderr-error'));
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    logger.warn({ code: error.code }, 'stdout failed: the client is gone');
    shutdown('stdout-error');
  });

  logger.info(
    { vaultPath: vaultConfig.vaultPath, stateDir },
    'stdio server ready (index building in the background)',
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let vaultOverride: string | undefined;
  try {
    vaultOverride = parseVaultArg(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  runStdioServer({ vaultOverride }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
