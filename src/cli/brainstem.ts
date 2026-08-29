import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { confirm, input, select } from '@inquirer/prompts';
import { Command } from 'commander';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import { COMMANDS, renderHelpText } from './catalog.ts';
import { runDoctor } from './commands/doctor.ts';
import { runDown } from './commands/down.ts';
import { runLogs } from './commands/logs.ts';
import { runRevokeAll } from './commands/revoke-all.ts';
import { runSecretRotate, runSecretShow } from './commands/secret.ts';
import { runSetup, type SetupDeps, type SetupIO } from './commands/setup.ts';
import { runStart } from './commands/start.ts';
import { runStatus } from './commands/status.ts';
import { runUp } from './commands/up.ts';
import { runUpdate } from './commands/update.ts';
import { runUrl } from './commands/url.ts';
import { createComposeRunner } from './docker.ts';
import { parseEnv } from './env-file.ts';
import { createSystemProbe } from './system.ts';
import type { VaultPathContext } from './vault-path.ts';

const NON_INTERACTIVE_MESSAGE =
  'pass --vault (and --tunnel-token/--public-url or the answers cannot be prompted)';

function createIO(): SetupIO {
  if (!process.stdin.isTTY) {
    const fail = (): never => {
      throw new Error(NON_INTERACTIVE_MESSAGE);
    };
    return {
      prompt: async () => fail(),
      confirm: async () => fail(),
      select: async () => fail(),
      print: (line) => console.log(line),
    };
  }
  return {
    prompt: (question, opts) =>
      input({ message: question, default: opts.default, validate: opts.validate }),
    confirm: (question, def) => confirm({ message: question, default: def }),
    select: (question, choices) => select({ message: question, choices }),
    print: (line) => console.log(line),
  };
}

async function readFile(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, 'utf8');
}

function createVaultCtx(repoDir: string): VaultPathContext {
  return {
    home: os.homedir(),
    repoDir,
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
      const probe = path.join(
        p,
        `.brainstem-write-test-${process.pid}-${randomBytes(4).toString('hex')}`,
      );
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

function buildSetupDeps(repoDir: string): SetupDeps {
  return {
    cwd: repoDir,
    io: createIO(),
    env: process.env,
    platform: process.platform,
    uid: process.platform === 'linux' ? process.getuid?.() : undefined,
    gid: process.platform === 'linux' ? process.getgid?.() : undefined,
    readFile,
    writeFile,
    vaultCtx: createVaultCtx(repoDir),
    randomSecret: () => randomBytes(32).toString('base64url'),
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Parses `.env` from `repoDir`, or `null` when the file doesn't exist yet. */
async function loadEnvMapOrNull(repoDir: string): Promise<Map<string, string> | null> {
  const text = await readFile(path.join(repoDir, '.env'));
  return text === null ? null : parseEnv(text);
}

async function loadEnvMap(repoDir: string): Promise<Map<string, string>> {
  const env = await loadEnvMapOrNull(repoDir);
  if (env === null) {
    throw new Error('.env not found — run `./brainstem setup` first');
  }
  return env;
}

function localPortOf(env: Map<string, string>): number {
  const port = Number(env.get('PORT'));
  return Number.isInteger(port) && port > 0 ? port : 3000;
}

function stateFileOf(env: Map<string, string>): string {
  const vaultPath = env.get('VAULT_PATH') ?? '';
  if (vaultPath === '') {
    throw new Error('VAULT_PATH is missing from .env — run ./brainstem setup');
  }
  return path.join(vaultPath, RESERVED_DIR, 'state.json');
}

async function runAction(fn: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** The catalog summary for `name` — `.description()`'s single source of truth. */
function summaryOf(name: string): string {
  const info = COMMANDS.find((c) => c.name === name);
  if (info === undefined) {
    throw new Error(`catalog.ts has no entry for "${name}"`);
  }
  return info.summary;
}

/**
 * Inherit-stdio process runner for `update`'s `npm ci` and its restart child.
 *
 * `shell: true` on Windows only: npm is `npm.cmd` there, and `CreateProcess`
 * cannot run a `.cmd` directly (ENOENT/EINVAL), which made `update` a no-op on
 * Windows. Every command and argument reaching this runner is a compile-time
 * constant (`npm ci --omit=dev`, `<node> src/cli/brainstem.ts up --build`), so
 * the shell adds no injection surface — but `process.execPath` routinely
 * contains a space (`C:\Program Files\nodejs\node.exe`), which cmd.exe would
 * split, so quote the command when it does.
 */
function createProcessRunner(cwd: string): (cmd: string, args: string[]) => Promise<number> {
  const shell = process.platform === 'win32';
  return (cmd, args) =>
    new Promise((resolve) => {
      const command = shell && /\s/.test(cmd) ? `"${cmd}"` : cmd;
      const child = spawn(command, args, { cwd, stdio: 'inherit', shell });
      child.on('error', (err) => {
        // Without this an unspawnable `npm`/`node` failed with an exit code and
        // no explanation at all.
        console.error(err.message);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
}

export function buildProgram(
  repoDir: string = path.resolve(import.meta.dirname, '..', '..'),
): Command {
  const program = new Command();
  program.name('brainstem').description('brainstem-mcp CLI: setup, run and manage your instance');
  program.addHelpText('after', `\n${renderHelpText()}\n`);
  program.showHelpAfterError();

  program
    .command('start')
    .description(summaryOf('start'))
    .option('--vault <path>', 'absolute path to your Obsidian vault (used on first run)')
    .option('--tunnel-token <token>', 'Cloudflare tunnel token (used on first run)')
    .option(
      '--public-url <url>',
      'public https URL for the Cloudflare tunnel (used on first run, with --tunnel-token)',
    )
    .option('--no-build', 'skip rebuilding the image before starting')
    .action(
      async (opts: {
        vault?: string;
        tunnelToken?: string;
        publicUrl?: string;
        build: boolean;
      }) => {
        const print = (line: string) => console.log(line);
        await runAction(() =>
          runStart({
            print,
            doctor: async ({ prerequisitesOnly }) =>
              runDoctor({
                probe: createSystemProbe(),
                // The full run needs `.env`; the prerequisites-only run is the
                // one that happens because there isn't one yet.
                env: prerequisitesOnly ? null : await loadEnvMapOrNull(repoDir),
                vaultCtx: createVaultCtx(repoDir),
                print,
                prerequisitesOnly,
              }),
            hasEnv: async () => (await loadEnvMapOrNull(repoDir)) !== null,
            setup: () =>
              runSetup(
                {
                  vault: opts.vault,
                  tunnelToken: opts.tunnelToken,
                  publicUrl: opts.publicUrl,
                  // `start` continues straight into `up`; setup's own
                  // "Next: ./brainstem up" would be a wrong instruction here.
                  printNext: false,
                },
                buildSetupDeps(repoDir),
              ),
            up: async () => {
              const env = await loadEnvMap(repoDir);
              return runUp(
                { build: opts.build },
                {
                  compose: createComposeRunner(repoDir),
                  env,
                  print,
                  fetchImpl: globalThis.fetch,
                  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                  localPort: localPortOf(env),
                },
              );
            },
          }),
        );
      },
    );

  program
    .command('setup')
    .description(summaryOf('setup'))
    .option('--vault <path>', 'absolute path to your Obsidian vault')
    .option('--tunnel-token <token>', 'Cloudflare tunnel token (stable URL)')
    .option(
      '--public-url <url>',
      'public https URL for the Cloudflare tunnel (with --tunnel-token)',
    )
    .option('--force', 'overwrite values that are already set')
    .option('--show-secret', 'print the owner secret instead of masking it')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await runSetup(
          {
            vault: opts.vault as string | undefined,
            tunnelToken: opts.tunnelToken as string | undefined,
            publicUrl: opts.publicUrl as string | undefined,
            force: opts.force as boolean | undefined,
            showSecret: opts.showSecret as boolean | undefined,
          },
          buildSetupDeps(repoDir),
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description(summaryOf('doctor'))
    .action(async () => {
      await runAction(async () => {
        const env = await loadEnvMapOrNull(repoDir);
        return runDoctor({
          probe: createSystemProbe(),
          env,
          vaultCtx: createVaultCtx(repoDir),
          print: (line) => console.log(line),
        });
      });
    });

  program
    .command('up')
    .description(summaryOf('up'))
    .option('--no-build', 'skip rebuilding the image before starting')
    .action(async (opts: { build: boolean }) => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runUp(
          { build: opts.build },
          {
            compose: createComposeRunner(repoDir),
            env,
            print: (line) => console.log(line),
            fetchImpl: globalThis.fetch,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            localPort: localPortOf(env),
          },
        );
      });
    });

  program
    .command('url')
    .description(summaryOf('url'))
    .action(async () => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runUrl({
          fetchImpl: globalThis.fetch,
          print: (line) => console.log(line),
          localPort: localPortOf(env),
        });
      });
    });

  program
    .command('status')
    .description(summaryOf('status'))
    .action(async () => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runStatus({
          env,
          vaultCtx: createVaultCtx(repoDir),
          compose: createComposeRunner(repoDir),
          fetchImpl: globalThis.fetch,
          print: (line) => console.log(line),
          localPort: localPortOf(env),
        });
      });
    });

  program
    .command('down')
    .description(summaryOf('down'))
    .action(async () => {
      await runAction(() =>
        runDown({ compose: createComposeRunner(repoDir), print: (line) => console.log(line) }),
      );
    });

  program
    .command('logs')
    .description(summaryOf('logs'))
    .argument('[service]', 'service to follow (app or tunnel); omit for all')
    .action(async (service?: string) => {
      await runAction(() => runLogs({ service }, { compose: createComposeRunner(repoDir) }));
    });

  program
    .command('revoke-all')
    .description(summaryOf('revoke-all'))
    .option(
      '--reset',
      'reset the auth state file (also clears clients/pending) instead of revoking in place',
    )
    .option('--yes', 'skip the confirmation prompt')
    .action(async (opts: { reset?: boolean; yes?: boolean }) => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runRevokeAll(
          { reset: opts.reset },
          {
            stateFile: stateFileOf(env),
            print: (line) => console.log(line),
            confirm: opts.yes
              ? async () => true
              : (question) => confirm({ message: question, default: false }),
          },
        );
      });
    });

  program
    .command('update')
    .description(summaryOf('update'))
    .action(async () => {
      await runAction(() =>
        runUpdate({
          exec: createSystemProbe().exec,
          cwd: repoDir,
          run: createProcessRunner(repoDir),
          print: (line) => console.log(line),
        }),
      );
    });

  const secret = program.command('secret').description(summaryOf('secret'));

  secret
    .command('show')
    .description('Print the current OWNER_SECRET')
    .action(async () => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runSecretShow({ env, print: (line) => console.log(line) });
      });
    });

  secret
    .command('rotate')
    .description('Generate a new OWNER_SECRET (the app must be restarted to pick it up)')
    .action(async () => {
      await runAction(async () => {
        const env = await loadEnvMap(repoDir);
        return runSecretRotate({
          envPath: path.join(repoDir, '.env'),
          stateFile: stateFileOf(env),
          readFile: async (p) => (await readFile(p)) ?? '',
          writeFile,
          randomSecret: () => randomBytes(32).toString('base64url'),
          print: (line) => console.log(line),
          confirm: (question) => confirm({ message: question, default: false }),
        });
      });
    });

  // The grouped catalog appended by `addHelpText('after', …)` is the command
  // list; commander's built-in "Commands:" block printed the same eleven names
  // and summaries directly above it, so `--help` listed everything twice.
  // Hiding it here — AFTER every `.command()` call — matters: commander copies
  // the help configuration into each subcommand as it is created, so doing this
  // earlier would blank out `brainstem help secret`'s show/rotate list too.
  // `help <command>` is unaffected either way: it resolves through
  // `_findCommand`, not through `visibleCommands`.
  program.configureHelp({ visibleCommands: () => [] });

  return program;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }
  await program.parseAsync(process.argv);
}
