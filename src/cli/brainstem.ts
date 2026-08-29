import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { confirm, input, select } from '@inquirer/prompts';
import { Command } from 'commander';
import { runSetup, type SetupDeps, type SetupIO } from './commands/setup.ts';
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

function notImplemented(name: string): void {
  console.error(`${name}: not implemented yet (Task 15)`);
  process.exitCode = 1;
}

export function buildProgram(repoDir: string): Command {
  const program = new Command();
  program.name('brainstem').description('brainstem-mcp CLI: setup, run and manage your instance');

  program
    .command('setup')
    .description('Create or update .env (owner secret, vault path, tunnel mode)')
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

  for (const name of ['up', 'url', 'status', 'down', 'logs', 'revoke-all']) {
    program.command(name).action(() => notImplemented(name));
  }

  return program;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const repoDir = path.resolve(import.meta.dirname, '..', '..');
  await buildProgram(repoDir).parseAsync(process.argv);
}
