import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../../src/version.ts';
import { startHarness } from '../tools/harness.ts';

const STDIO_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');

interface StdioSession {
  client: Client;
  root: string;
  close(): Promise<void>;
}

async function startStdioSession(root?: string): Promise<StdioSession> {
  const vaultRoot = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-')));
  const client = new Client(
    { name: 'stdio-test', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_MAIN, '--vault', vaultRoot],
      // Piped (not the default 'inherit'): the server's own log lines go to its stderr, which
      // would otherwise print straight into the test run's own console.
      stderr: 'pipe',
    }),
  );
  return {
    client,
    root: vaultRoot,
    async close() {
      await client.close(); // ends the child's stdin — the same shutdown path a real client uses
      await fs.rm(vaultRoot, { recursive: true, force: true });
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
});

describe('stdio lifecycle (real child process)', () => {
  function spawnRaw(
    args: string[],
    envOverride?: Record<string, string | undefined>,
  ): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [STDIO_MAIN, ...args], {
      env: { ...process.env, ...envOverride },
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

  it('SIGTERM makes the process exit 0', async () => {
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
  }, 10_000);

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
    try {
      const started = Date.now();
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SLOW_CHILD_ENTRY, '--vault', root],
          env: { ...process.env, BRAINSTEM_TEST_SLOW_BATCH_MS: String(SLOW_BATCH_MS) },
          stderr: 'pipe',
        }),
      );
      const { tools } = await client.listTools();
      const bootAndListMs = Date.now() - started;
      expect(tools.length).toBeGreaterThan(0);
      // Never waited for the fill: well under half the time the (slowed) fill alone takes.
      expect(bootAndListMs).toBeLessThan(EXPECTED_FILL_MS / 2);

      const ping = await client.callTool({ name: 'brainstem_ping', arguments: {} });
      const body = ping.structuredContent as { index: { building: boolean; total: number } };
      expect(body.index.building).toBe(true);
      expect(body.index.total).toBe(NOTES);
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
