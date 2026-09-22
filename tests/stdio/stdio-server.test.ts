import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../../src/version.ts';
import { testMachineHomeEnv } from '../helpers/state-home.ts';
import { STDIO_ENTRY as STDIO_MAIN } from '../helpers/stdio-entry.ts';
import { startHarness } from '../tools/harness.ts';

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface StdioSession {
  client: Client;
  root: string;
  stateHome: string;
  /** `keepRoot: true` ends the client (and so the child process) without removing the vault
   *  folder — for a test that boots a second session against the same, now-edited, vault. */
  close(opts?: { keepRoot?: boolean }): Promise<void>;
}

async function startStdioSession(
  root?: string,
  env?: Record<string, string>,
  /** Extra CLI args after `--vault <root>`, e.g. `['--read-only']`. */
  extraArgs: string[] = [],
): Promise<StdioSession> {
  const vaultRoot = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-')));
  // Every real stdio child MUST get its own BRAINSTEM_STATE_HOME and BRAINSTEM_CACHE_HOME —
  // otherwise it falls back to the developer's real ~/.local/state/brainstem and
  // ~/.cache/brainstem and writes into them.
  const homes = testMachineHomeEnv();
  const client = new Client(
    { name: 'stdio-test', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', vaultRoot, ...extraArgs],
      env: {
        ...(process.env as Record<string, string>),
        ...homes,
        ...env,
      },
      // Piped (not the default 'inherit'): the server's own log lines go to its stderr, which
      // would otherwise print straight into the test run's own console.
      stderr: 'pipe',
    }),
  );
  return {
    client,
    root: vaultRoot,
    stateHome: homes.BRAINSTEM_STATE_HOME,
    async close(opts) {
      await client.close(); // ends the child's stdin — the same shutdown path a real client uses
      if (!opts?.keepRoot) await fs.rm(vaultRoot, { recursive: true, force: true });
      await fs.rm(homes.BRAINSTEM_STATE_HOME, { recursive: true, force: true });
      await fs.rm(homes.BRAINSTEM_CACHE_HOME, { recursive: true, force: true });
    },
  };
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('the stdio entrypoint (src/stdio-main.ts)', () => {
  it('exposes the exact same tools as the HTTP harness: names, input/output schemas, annotations', async () => {
    const http = await startHarness();
    cleanups.push(() => http.close());
    const stdio = await startStdioSession();
    cleanups.push(() => stdio.close());

    const normalize = (tools: { name: string; [k: string]: unknown }[]) =>
      tools
        .map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const httpTools = normalize((await http.client.listTools()).tools);
    const stdioTools = normalize((await stdio.client.listTools()).tools);
    expect(stdioTools).toEqual(httpTools);
    expect(stdioTools.length).toBeGreaterThan(0);
  });

  it('listPrompts over stdio returns the five novice prompts on a writable vault', async () => {
    const stdio = await startStdioSession();
    cleanups.push(() => stdio.close());
    const { prompts } = await stdio.client.listPrompts();
    expect(prompts).toHaveLength(5);
  });

  it('brainstem_guide includes the "vault without owner instructions" section until the owner writes one, and drops it once they have', async () => {
    const first = await startStdioSession();
    const root = first.root;
    const before = await first.client.callTool({ name: 'brainstem_guide', arguments: {} });
    expect((before.content[0] as { text: string }).text).toContain(
      '## Vault without owner instructions',
    );
    await first.close({ keepRoot: true });

    await fs.mkdir(path.join(root, '_brainstem'), { recursive: true });
    await fs.writeFile(
      path.join(root, '_brainstem', 'instructions.md'),
      '- Widgets live in widgets/.\n',
    );

    const second = await startStdioSession(root);
    const after = await second.client.callTool({ name: 'brainstem_guide', arguments: {} });
    const afterText = (after.content[0] as { text: string }).text;
    expect(afterText).not.toContain('## Vault without owner instructions');
    expect(afterText).toContain('Widgets live in widgets/.');
    await second.close();
  }, 30_000);

  it('reads, writes with expectedHash, and rejects a stale hash with CONFLICT', async () => {
    const stdio = await startStdioSession();
    cleanups.push(() => stdio.close());

    const written = await stdio.client.callTool({
      name: 'vault_write',
      arguments: { path: 'note.md', content: '# Note\nfirst version' },
    });
    expect(written.isError).toBeFalsy();

    const read = await stdio.client.callTool({
      name: 'vault_read',
      arguments: { path: 'note.md' },
    });
    expect(read.isError).toBeFalsy();
    const hash = structured(read).hash as string;
    expect(typeof hash).toBe('string');

    const updated = await stdio.client.callTool({
      name: 'vault_write',
      arguments: { path: 'note.md', content: '# Note\nsecond version', expectedHash: hash },
    });
    expect(updated.isError).toBeFalsy();

    const stale = await stdio.client.callTool({
      name: 'vault_write',
      arguments: { path: 'note.md', content: '# Note\nthird version', expectedHash: hash },
    });
    expect(stale.isError).toBe(true);
    const text = stale.content[0] as { text: string };
    expect(text.text).toContain('CONFLICT');
  });

  it('brainstem_ping reports the same version as SERVER_INFO.version', async () => {
    const stdio = await startStdioSession();
    cleanups.push(() => stdio.close());
    const ping = await stdio.client.callTool({ name: 'brainstem_ping', arguments: {} });
    expect(ping.isError).toBeFalsy();
    expect(structured(ping).version).toBe(SERVER_INFO.version);
    expect(structured(ping).server).toBe(SERVER_INFO.name);
  });

  it('brainstem_ping.search.regexEngine and the initialize instructions agree on whether ripgrep is available', async () => {
    const stdio = await startStdioSession();
    cleanups.push(() => stdio.close());
    const ping = await stdio.client.callTool({ name: 'brainstem_ping', arguments: {} });
    const engine = (structured(ping).search as { regexEngine: string }).regexEngine;
    expect(engine).toBe(hasRipgrep() ? 'ripgrep' : 'builtin');
    const instructions = stdio.client.getInstructions() ?? '';
    if (engine === 'builtin') {
      expect(instructions).toContain('ripgrep is not installed');
    } else {
      expect(instructions).not.toContain('ripgrep is not installed');
    }
  });
});

describe('a wrong optional setting from the install form never stops the server', () => {
  it('starts with VAULT_TIMEZONE=EEST, serves, and says so in brainstem_ping', async () => {
    const session = await startStdioSession(undefined, { VAULT_TIMEZONE: 'EEST' });
    try {
      const ping = await session.client.callTool({ name: 'brainstem_ping', arguments: {} });
      const body = structured(ping) as { configWarnings?: string[] };
      expect(body.configWarnings).toHaveLength(1);
      expect(body.configWarnings?.[0]).toMatch(/VAULT_TIMEZONE/);
      const list = await session.client.listTools();
      expect(list.tools.length).toBeGreaterThan(20);
    } finally {
      await session.close();
    }
  });
});

describe('read-only mode (--read-only and VAULT_READ_ONLY=true, over a real stdio child)', () => {
  // Three real child processes, each a full spawn + MCP handshake: honest 60s rather than raising
  // the suite's default 15s, which a loaded (or just slower — the Windows CI runner) machine can
  // clear on its own.
  it('--read-only and VAULT_READ_ONLY=true both produce the same reduced tool list', async () => {
    const full = await startStdioSession();
    cleanups.push(() => full.close());
    const { tools: fullTools } = await full.client.listTools();
    const expectedNames = fullTools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(expectedNames.length).toBeGreaterThan(0);
    expect(expectedNames.length).toBeLessThan(fullTools.length);

    const viaEnv = await startStdioSession(undefined, { VAULT_READ_ONLY: 'true' });
    cleanups.push(() => viaEnv.close());
    const { tools: envTools } = await viaEnv.client.listTools();
    expect(envTools.map((t) => t.name).sort()).toEqual(expectedNames);

    const viaFlag = await startStdioSession(undefined, undefined, ['--read-only']);
    cleanups.push(() => viaFlag.close());
    const { tools: flagTools } = await viaFlag.client.listTools();
    expect(flagTools.map((t) => t.name).sort()).toEqual(expectedNames);
  }, 60_000);

  it('the CLI flag wins over the env: --read-only alongside VAULT_READ_ONLY=false still reduces the list', async () => {
    const session = await startStdioSession(undefined, { VAULT_READ_ONLY: 'false' }, [
      '--read-only',
    ]);
    cleanups.push(() => session.close());
    const ping = await session.client.callTool({ name: 'brainstem_ping', arguments: {} });
    expect(structured(ping).readOnly).toBe(true);
  });
});

describe('stdio lifecycle (real child process)', () => {
  const spawnedHomes: string[] = [];
  afterEach(async () => {
    while (spawnedHomes.length > 0) {
      const dir = spawnedHomes.pop() as string;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  function spawnRaw(
    args: string[],
    envOverride?: Record<string, string | undefined>,
  ): ChildProcessWithoutNullStreams {
    const homes = testMachineHomeEnv();
    spawnedHomes.push(homes.BRAINSTEM_STATE_HOME, homes.BRAINSTEM_CACHE_HOME);
    return spawn(process.execPath, [STDIO_MAIN, ...args], {
      env: { ...process.env, ...homes, ...envOverride },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function collect(stream: NodeJS.ReadableStream): { text: () => string } {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
    });
    return { text: () => buf };
  }

  /** Polls `collected.text()` until `predicate` matches, or throws past `timeoutMs`. Loading
   *  src/stdio-main.ts cold (no cache: zod, pino, the MCP SDK, …) takes a variable few hundred
   *  ms, so lifecycle tests wait for the real "ready" line instead of a fixed sleep. */
  async function waitForText(
    collected: { text: () => string },
    predicate: (text: string) => boolean,
    timeoutMs = 8000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(collected.text())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for output; got so far: ${collected.text()}`);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  const READY_MARKER = 'stdio server ready';

  /** Every path under `root`, files and folders, relative and sorted — used to prove a read-only
   *  boot creates nothing (including `_brainstem/`, which a normal boot seeds). */
  async function recursiveListing(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
        out.push(entry.isDirectory() ? `${relPath}/` : relPath);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      }
    }
    await walk(root, '');
    return out.sort();
  }

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a folder without write permission is served in read-only mode, and refused otherwise',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-nowrite-'));
      await fs.writeFile(path.join(root, 'existing.md'), '# hi\n');
      await fs.chmod(root, 0o555);
      try {
        const readOnly = spawnRaw(['--vault', root, '--read-only']);
        const err = collect(readOnly.stderr);
        await waitForText(err, (t) => t.includes(READY_MARKER));
        readOnly.stdin.end();
        await new Promise((resolve) => readOnly.once('close', resolve));

        const writable = spawnRaw(['--vault', root]);
        const refused = collect(writable.stderr);
        const code = await new Promise((resolve) => writable.once('close', resolve));
        expect(code).toBe(1);
        expect(refused.text()).toContain('is not writable');
      } finally {
        await fs.chmod(root, 0o755);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('a read-only boot creates nothing inside the vault folder (no _brainstem/ either)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-readonly-boot-'));
    await fs.writeFile(path.join(root, 'existing.md'), '# hi\n');
    try {
      const before = await recursiveListing(root);
      const child = spawnRaw(['--vault', root, '--read-only']);
      const out = collect(child.stdout);
      const err = collect(child.stderr);
      await waitForText(err, (t) => t.includes(READY_MARKER));

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'readonly-boot-test', version: '0.0.0' },
          },
        })}\n`,
      );
      await waitForText(out, (t) => t.includes('"id":1'));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'vault_read', arguments: { path: 'existing.md' } },
        })}\n`,
      );
      await waitForText(out, (t) => t.includes('"id":2'));

      child.stdin.end();
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));

      const after = await recursiveListing(root);
      expect(after).toEqual(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('closing stdin makes the process exit 0 within 5 s', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-lifecycle-'));
    try {
      const child = spawnRaw(['--vault', root]);
      const err = collect(child.stderr);
      const exited = new Promise<number | null>((resolve) =>
        child.on('exit', (code) => resolve(code)),
      );
      await waitForText(err, (t) => t.includes(READY_MARKER));
      child.stdin.end();
      const code = await exited;
      expect(code).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  // Signals don't exist on Windows the way this test needs them to: SIGTERM terminates the
  // process at once there instead of asking it to stop gracefully, so this would be testing
  // Node's own default signal handling, not ours. The graceful stop on Windows is the client
  // closing stdin — the "closing stdin…" test right above, which does run there.
  it.skipIf(process.platform === 'win32')(
    'SIGTERM makes the process exit 0',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-lifecycle-'));
      try {
        const child = spawnRaw(['--vault', root]);
        const err = collect(child.stderr);
        const exited = new Promise<number | null>((resolve) =>
          child.on('exit', (code) => resolve(code)),
        );
        await waitForText(err, (t) => t.includes(READY_MARKER));
        child.kill('SIGTERM');
        const code = await exited;
        expect(code).toBe(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it('a missing vault (no --vault, no VAULT_PATH) exits 1 with a one-line stderr message and empty stdout', async () => {
    const { VAULT_PATH: _unused, ...envWithoutVault } = process.env;
    const child = spawnRaw([], { ...envWithoutVault, VAULT_PATH: undefined });
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(1);
    expect(out.text()).toBe('');
    const lines = err
      .text()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('VAULT_PATH');
  }, 10_000);

  it('a vault folder that does not exist is refused and NOT created', async () => {
    // Found by hand: a mistyped --vault made the server create the folder, seed _brainstem/ in it
    // and serve an empty vault without a word. A person who mistypes the path must be told.
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-missing-'));
    const missing = path.join(parent, 'no-such-vault');
    try {
      const child = spawn(process.execPath, [STDIO_MAIN, '--vault', missing], {
        env: { ...process.env, ...testMachineHomeEnv() },
        stdio: 'pipe',
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('no-such-vault');
      expect(err.trim().split('\n')).toHaveLength(1);
      await expect(fs.stat(missing)).rejects.toThrow(); // nothing was created
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses a relative path, the filesystem root and the home directory as a vault', async () => {
    for (const bad of ['relative/vault', path.parse(os.tmpdir()).root, os.homedir()]) {
      const child = spawn(process.execPath, [STDIO_MAIN, '--vault', bad], {
        env: { ...process.env, ...testMachineHomeEnv() },
        stdio: 'pipe',
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code, bad).toBe(1);
      expect(out, bad).toBe('');
    }
  });

  it('an unusable vault path (a file, not a directory) exits 1 with one line on stderr, before any stdout byte', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-unusable-'));
    const filePath = path.join(dir, 'not-a-directory');
    await fs.writeFile(filePath, 'x');
    try {
      const child = spawnRaw(['--vault', filePath]);
      const out = collect(child.stdout);
      const err = collect(child.stderr);
      const code = await new Promise<number | null>((resolve) =>
        child.on('exit', (c) => resolve(c)),
      );
      expect(code).toBe(1);
      expect(out.text()).toBe('');
      const lines = err
        .text()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('stdout carries only newline-delimited JSON-RPC: every non-empty line parses with jsonrpc "2.0"', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-purity-'));
    try {
      const child = spawnRaw(['--vault', root]);
      const out = collect(child.stdout);
      const err = collect(child.stderr);
      await waitForText(err, (t) => t.includes(READY_MARKER));

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'purity-test', version: '0.0.0' },
          },
        })}\n`,
      );
      await waitForText(out, (t) => t.includes('"id":1'));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'brainstem_ping', arguments: {} },
        })}\n`,
      );
      await waitForText(out, (t) => t.includes('"id":2'));
      child.stdin.end();
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));

      const lines = out
        .text()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(line);
        }, line).not.toThrow();
        expect((parsed as { jsonrpc?: string }).jsonrpc, line).toBe('2.0');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('a boot that does not make the client wait (deferIndex end to end)', () => {
  const SLOW_CHILD_ENTRY = path.resolve(import.meta.dirname, 'helpers', 'slow-child-entry.ts');
  const NOTES = 300;
  // 15 batches of 20 notes: a fill of ~15s, deliberately far past the cold-start cost of loading
  // this process's own dependencies (zod, pino, the MCP SDK — measured ~1s on its own in this
  // environment) so the comparison below is never close, however slow that fixed cost is here.
  const SLOW_BATCH_MS = 1000;
  const EXPECTED_FILL_MS = Math.ceil(NOTES / 20) * SLOW_BATCH_MS;

  it('initialize + tools/list finish in a small fraction of the fill time, while ping still says building', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-e2e-'));
    for (let i = 0; i < NOTES; i += 1) {
      await fs.writeFile(path.join(root, `n${i}.md`), `---\nn: ${i}\n---\nbody ${i}`);
    }
    const client = new Client(
      { name: 'stdio-e2e', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const homes = testMachineHomeEnv();
    try {
      const started = Date.now();
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SLOW_CHILD_ENTRY, '--vault', root],
          env: {
            ...process.env,
            BRAINSTEM_TEST_SLOW_BATCH_MS: String(SLOW_BATCH_MS),
            ...homes,
          },
          stderr: 'pipe',
        }),
      );
      const { tools } = await client.listTools();
      const bootAndListMs = Date.now() - started;
      expect(tools.length).toBeGreaterThan(0);
      // Never waited for the fill: well under half the time the (slowed) fill alone takes.
      expect(bootAndListMs).toBeLessThan(EXPECTED_FILL_MS / 2);

      // `total` is known once the fill has listed the vault, which a loaded runner can take
      // longer to do than the handshake above (seen: 0 on macOS and Windows, once each), so it is
      // polled; `building` must be true on the very first answer, and that is the point.
      let body = (await client.callTool({ name: 'brainstem_ping', arguments: {} }))
        .structuredContent as { index: { building: boolean; total: number } };
      expect(body.index.building).toBe(true);
      const deadline = Date.now() + 10_000;
      while (body.index.total === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        body = (await client.callTool({ name: 'brainstem_ping', arguments: {} }))
          .structuredContent as { index: { building: boolean; total: number } };
      }
      expect(body.index.total).toBe(NOTES);
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(homes.BRAINSTEM_STATE_HOME, { recursive: true, force: true });
      await fs.rm(homes.BRAINSTEM_CACHE_HOME, { recursive: true, force: true });
    }
  }, 30_000);

  it('honours the vault settings it is given: a daily note goes to its folder, not to the root', async () => {
    const session = await startStdioSession(undefined, {
      DAILY_NOTES_FOLDER: 'Daily',
      VAULT_TIMEZONE: 'Europe/Bucharest',
    });
    try {
      const where = await session.client.callTool({ name: 'vault_daily_note_path', arguments: {} });
      expect((where.structuredContent as { path: string }).path).toMatch(
        /^Daily\/\d{4}-\d{2}-\d{2}\.md$/,
      );
      const appended = await session.client.callTool({
        name: 'vault_daily_note_append',
        arguments: { content: '- alpha' },
      });
      expect(appended.isError).toBeFalsy();
      expect(await fs.readdir(path.join(session.root, 'Daily'))).toHaveLength(1);
      expect((await fs.readdir(session.root)).filter((f) => f.endsWith('.md'))).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
