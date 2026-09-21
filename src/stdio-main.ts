import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type VaultPathContext, validateVaultPath } from './cli/vault-path.ts';
import { ConfigError, loadVaultConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { createVaultServer } from './mcp/factory.ts';
import {
  createIndexCacheHandle,
  type LocalCacheEnvDeps,
  type LocalCacheFsDeps,
  resolveLocalCacheDir,
} from './storage/local-cache.ts';
import { listOtherLivePeers, registerInstance, unregisterInstance } from './storage/local-peers.ts';
import {
  type LocalStateDeps,
  pathsAreRelated,
  pathsEqual,
  realpathOrClosestAncestor,
  resolveLocalStateDir,
} from './storage/local-state.ts';
import { scanLeftoverJournals } from './storage/transaction.ts';
import {
  createInstructionsProvider,
  writeInstructionsTemplateIfMissing,
} from './vault/instructions.ts';
import { createLocalRuntime, type VaultRuntime } from './vault/runtime.ts';
import { SERVER_INFO } from './version.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** `LocalStateDeps` built from the real filesystem and OS — the only place `src/storage/
 *  local-state.ts`'s pure logic is wired to real I/O, so tests can inject their own instead. */
function localStateDeps(
  env: Record<string, string | undefined>,
  onVaultMismatch?: LocalStateDeps['onVaultMismatch'],
): LocalStateDeps {
  return {
    env,
    platform: process.platform,
    homedir: () => os.homedir(),
    fs: {
      mkdir: (p, opts) => fs.mkdir(p, opts),
      realpath: (p) => fs.realpath(p),
      stat: (p) => fs.stat(p),
      readFile: (p) => fs.readFile(p, 'utf8'),
      writeFile: (p, data, opts) => fs.writeFile(p, data, opts),
      rename: (a, b) => fs.rename(a, b),
    },
    onVaultMismatch,
  };
}

/** `LocalCacheEnvDeps & { fs }` built from the real filesystem and OS, mirroring
 *  `localStateDeps` above — the only place `src/storage/local-cache.ts`'s pure logic is wired to
 *  real I/O, so tests can inject their own instead. */
function localCacheDeps(
  env: Record<string, string | undefined>,
): LocalCacheEnvDeps & { fs: LocalCacheFsDeps } {
  return {
    env,
    platform: process.platform,
    homedir: () => os.homedir(),
    fs: { mkdir: (p, opts) => fs.mkdir(p, opts), realpath: (p) => fs.realpath(p) },
  };
}

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

/** `--read-only` from an argv array; `true` when present, `undefined` otherwise — there is no
 *  `--read-only=false` (leave the flag out to fall back to `VAULT_READ_ONLY`/its default). */
export function parseReadOnlyArg(argv: readonly string[]): boolean | undefined {
  return argv.includes('--read-only') ? true : undefined;
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
function vaultPathContext(readOnly: boolean): VaultPathContext {
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
      // A read-only server writes nothing, this probe file included, and serves a folder it has
      // no write permission on: there it must be able to list the folder, nothing more.
      if (readOnly) {
        try {
          await fs.access(p, fsConstants.R_OK | fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      }
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
  /** Overrides `VAULT_READ_ONLY` to true — what `--read-only` sets; the flag wins over the env
   *  (there is no `--read-only=false`: leave the flag out and, if set, the env decides). */
  readOnlyOverride?: boolean;
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
 * `VAULT_READ_ONLY=true`/`--read-only` (`readOnlyOverride`, which wins over the env) registers
 * only tools annotated `readOnlyHint: true` and skips seeding the instructions template below —
 * a read-only boot writes nothing into the vault.
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
    vaultConfig = loadVaultConfig({
      ...env,
      ...(opts.vaultOverride !== undefined ? { VAULT_PATH: opts.vaultOverride } : {}),
      ...(opts.readOnlyOverride ? { VAULT_READ_ONLY: 'true' } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  // Before anything is created: a mistyped folder must be an error, not an empty vault that the
  // server quietly makes and then serves. Same rules as `./brainstem setup` (absolute, exists,
  // a folder, writable, not the filesystem root, not the home directory, not around this code).
  const verdict = await validateVaultPath(
    vaultConfig.vaultPath,
    vaultPathContext(vaultConfig.readOnly),
  );
  if (!verdict.ok) {
    const error = vaultConfig.readOnly
      ? verdict.error.replace('is not writable', 'cannot be read')
      : verdict.error;
    return fail(`Unusable vault folder: ${error}`);
  }
  if (vaultConfig.vaultPath.split(/[\\/]/).includes('_brainstem')) {
    return fail(`Unusable vault folder: "${vaultConfig.vaultPath}" is inside a _brainstem folder`);
  }

  const logger: Logger = createLogger(vaultConfig.logLevel, stderr);

  // Resolved once, real I/O, and reused everywhere below that needs to compare a machine-local
  // folder against the vault (F1) — already known to exist and be a directory (validateVaultPath
  // just confirmed it), so this should not fail; if it somehow does, that is itself reason to
  // stop before anything is created.
  let vaultRealPath: string;
  try {
    vaultRealPath = await fs.realpath(vaultConfig.vaultPath);
  } catch (error) {
    return fail(
      `Unusable vault folder: could not resolve its real path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Two different folders, on purpose (ADR 0008 amendment, phase 3): `instructionsDir` is vault
  // content (the owner's `_brainstem/instructions.md`) and always travels with the vault, exactly
  // like the HTTP server's state dir. `stateDir` is this *process's* working state — the
  // transaction journal today, the index cache later — which must NOT travel: a vault may live in
  // git or in a folder synced between machines, where a journal of in-flight edits or a
  // machine-bound cache would be the wrong thing to sync, upload or merge. `STATE_DIR` (unchanged
  // from before this split) still overrides where that working state lives, e.g. for tests.
  const instructionsDir = path.join(vaultConfig.vaultPath, '_brainstem');
  let stateDir: string;
  if (vaultConfig.stateDir) {
    // F1: machine-local working state must never live inside the vault (every tool would then
    // list, read and search the server's own files) — except the one grandfathered spot,
    // `<vault>/_brainstem`, which IS vault content (see the comment above) and is how STATE_DIR
    // has always been used for local dev/tests. Any other STATE_DIR inside the vault is refused
    // exactly like an out-of-bounds BRAINSTEM_STATE_HOME below, before anything is created there.
    const stateDirReal = await realpathOrClosestAncestor(
      vaultConfig.stateDir,
      (p) => fs.realpath(p),
      path,
    );
    const reservedStateDir = path.join(vaultRealPath, '_brainstem');
    const reservedException = pathsEqual(stateDirReal, reservedStateDir, path, process.platform);
    if (
      !reservedException &&
      pathsAreRelated(stateDirReal, vaultRealPath, path, process.platform)
    ) {
      return fail(
        `Unusable STATE_DIR: "${vaultConfig.stateDir}" is inside (or equal to) the vault "${vaultRealPath}" ` +
          '— tools would list, read and search the server’s own working state. The only exception ' +
          `is STATE_DIR set to exactly "${reservedStateDir}".`,
      );
    }
    stateDir = vaultConfig.stateDir;
  } else {
    const resolved = await resolveLocalStateDir(
      vaultConfig.vaultPath,
      localStateDeps(env, (info) =>
        logger.warn(info, 'vault.json in the local state folder names a different vault'),
      ),
    );
    if (!resolved.ok) {
      return fail(`Could not set up the local state folder: ${resolved.error}`);
    }
    stateDir = resolved.dir;
  }

  // The machine-local index cache (ADR 0008 amendment, phase 4): read-only mode may use and
  // write it too — it lives outside the vault, so it writes nothing a read-only boot must avoid.
  // Disabled outright by BRAINSTEM_INDEX_CACHE=off; otherwise a folder that cannot be created or
  // written just means running without one, logged as a single warning line — unlike stateDir
  // above, this is never a reason to exit (the cache is a hint, never a source). F1's containment
  // check (never inside the vault, and never the vault inside the cache base — no exception here)
  // lives inside resolveLocalCacheDir itself; a refusal there is just another `ok:false`.
  let indexCacheHandle: ReturnType<typeof createIndexCacheHandle> | undefined;
  if (env.BRAINSTEM_INDEX_CACHE !== 'off') {
    try {
      const resolvedCache = await resolveLocalCacheDir(vaultRealPath, localCacheDeps(env));
      if (resolvedCache.ok) {
        indexCacheHandle = createIndexCacheHandle(
          resolvedCache.dir,
          resolvedCache.key,
          SERVER_INFO.version,
        );
      } else {
        logger.warn({ reason: resolvedCache.error }, 'running without an index cache');
      }
    } catch (error) {
      logger.warn({ err: error }, 'running without an index cache');
    }
  }

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
      indexCache: indexCacheHandle,
      onIndexCacheSaved: (info) => {
        logger.info(info, 'index cache saved');
        // F3: a debug-level line, not a warning — those paths just get read from disk next boot.
        if (info.racySkipped > 0) {
          logger.debug({ racySkipped: info.racySkipped }, 'index cache save: skipped racy entries');
        }
      },
      onIndexCacheSaveError: (reason) => logger.warn({ reason }, 'index cache save failed'),
      onIndexError: (error) => logger.error({ err: error }, 'background index build failed'),
      onReconcileError: () => logger.warn('index reconcile failed; the next pass will retry'),
      onIndexOverBudget: (state) =>
        logger.warn(state, 'the vault index is over its size budget: nothing is dropped'),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  // Seeded once, from the same code the HTTP server uses (src/vault/instructions.ts), into the
  // vault-local instructionsDir (never stateDir — that folder now lives outside the vault) so a
  // reader who only ever uses stdio still gets the note explaining the feature in Obsidian —
  // skipped in read-only mode, which must not write into the vault on its own either.
  if (!vaultConfig.readOnly) {
    try {
      if (await writeInstructionsTemplateIfMissing(instructionsDir)) {
        logger.info(
          { file: path.join(instructionsDir, 'instructions.md') },
          'seeded owner instructions template',
        );
      }
    } catch (error) {
      logger.warn({ err: error }, 'could not seed the owner instructions template');
    }
  }
  const instructions = createInstructionsProvider(instructionsDir);

  // A journal outlives its transaction only after a crash mid-apply or a failed cleanup (see
  // src/main.ts, which the HTTP server runs at boot the same way, sharing scanLeftoverJournals
  // against its own vault-local stateDir). Never replayed — just reported.
  try {
    // The vault's own `_brainstem/tx` is looked at too (only looked at): that is where a stdio
    // session older than 0.6, or the HTTP server, left its journals, and nobody else would say.
    const places = stateDir === instructionsDir ? [stateDir] : [stateDir, instructionsDir];
    const leftovers = (await Promise.all(places.map((dir) => scanLeftoverJournals(dir)))).flat();
    for (const leftover of leftovers) {
      logger.warn(
        {
          transaction: leftover.transaction,
          journal: leftover.journal,
          state: leftover.state,
          needsRestore: leftover.needsRestore,
        },
        `transaction journal left behind — ${leftover.message}; nothing was replayed`,
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not scan the transaction journal folder');
  }

  // Several stdio processes on one vault, on this machine, are normal (every Claude Code session
  // starts its own) — recorded here regardless of read-only mode, since this writes into the
  // machine-local stateDir, never into the vault. `registerInstance` runs before the scan below
  // so two processes booting at nearly the same moment still see each other; its heartbeat (F5)
  // keeps this process's own instance file from ever looking stale to another one's scan, and is
  // stopped on the way out, in `shutdown` below.
  const registered = await registerInstance(stateDir, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: SERVER_INFO.version,
  });
  const otherPeers = await listOtherLivePeers(stateDir, process.pid);
  if (otherPeers.length > 0) {
    logger.info(
      { count: otherPeers.length },
      `${otherPeers.length} other brainstem stdio ${otherPeers.length === 1 ? 'process is' : 'processes are'} ` +
        'already running on this vault on this machine — concurrent writes are protected by ' +
        'expectedHash (a collision is a CONFLICT, never a lost write), and each process keeps its ' +
        'own index fresh through the watcher and reconcile',
    );
  }

  // Declared before the server so the transport's own error report can end the process too.
  let onTransportError: (error: Error) => void = () => {};
  const handle = serveStdio(
    (ctx) =>
      createVaultServer(ctx, {
        resolveRuntime: async () => runtime,
        logger,
        instructions: () => instructions.get(),
        readOnly: vaultConfig.readOnly,
        localPeers: () => listOtherLivePeers(stateDir, process.pid).then((peers) => peers.length),
      }),
    { onerror: (error) => onTransportError(error) },
  );

  // 'transport-error', 'stdin-close' and 'stdout-error' are exactly the signs (see onTransportError
  // and the stdin 'close' listener below) that the other end of the pipes is already gone, not a
  // deliberate stop — the index-cache save on the way out (VaultRuntime.close()) reads this to
  // skip a large save nobody is left to benefit from. SIGTERM/SIGINT/stdin-end are an orderly
  // stop (a supervisor, or the client closing its side properly) and always attempt it.
  const DEAD_CLIENT_SHUTDOWN_REASONS = new Set(['transport-error', 'stdin-close', 'stdout-error']);

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
    const closeReason = DEAD_CLIENT_SHUTDOWN_REASONS.has(signal) ? 'client-dead' : 'normal';
    // Stopped up front, synchronously: once shutdown has started, nothing should touch the
    // instance file again behind unregisterInstance's back (a heartbeat tick racing the removal
    // below could otherwise re-create it a moment after it was deleted).
    registered.stopHeartbeat();
    // Order matters: the calls already running finish and are answered while the transport is
    // still open (a burst of writes followed by a disconnect used to leave nothing on disk);
    // only then is the transport closed, and the runtime last. The instance file is removed
    // best-effort, in parallel with runtime.close() — its own failure must never hold up the
    // rest of the shutdown (a stale file is pruned by the next boot's scan anyway).
    runtime.calls
      .drain()
      .then(() => flushed(process.stdout))
      .then(() => handle.close())
      .then(() =>
        Promise.all([
          runtime.close({ reason: closeReason }),
          unregisterInstance(stateDir, process.pid).catch(() => {}),
        ]),
      )
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
  const readOnlyOverride = parseReadOnlyArg(process.argv.slice(2));
  runStdioServer({ vaultOverride, readOnlyOverride }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
