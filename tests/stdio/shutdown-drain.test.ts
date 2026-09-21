// Review round 2: a graceful stop (stdin ending, SIGTERM) used to exit without waiting for the
// tool calls already running, so a burst of writes followed by a disconnect left nothing on disk.
// And a broken stderr pipe took the process down through an uncaught exception (exit code 1).
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const STDIO_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');
const SLOW_ENTRY = path.resolve(import.meta.dirname, 'helpers', 'slow-child-entry.ts');
const WRITES = 30;

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Session {
  child: ChildProcess;
  root: string;
  stdout: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface StartOptions {
  /** Wait for the first answers before returning (false: the caller sends everything at once). */
  settle?: boolean;
  /** Notes written before the start, and a slowed index fill (one second per batch of 20). */
  slowNotes?: number;
}

async function start({ settle = true, slowNotes = 0 }: StartOptions = {}): Promise<Session> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-drain-'));
  roots.push(root);
  await Promise.all(
    Array.from({ length: slowNotes }, (_, i) => fs.writeFile(path.join(root, `s${i}.md`), '# s\n')),
  );
  const child = spawn(
    process.execPath,
    [slowNotes > 0 ? SLOW_ENTRY : STDIO_MAIN, '--vault', root],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(slowNotes > 0 ? { BRAINSTEM_TEST_SLOW_BATCH_MS: '1000' } : {}) },
    },
  );
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on('close', (code, signal) => resolve({ code, signal })), // 'close': stdout fully read
  );
  await until(() => err.includes('stdio server ready'));
  send(child, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'drain-test', version: '0' },
    },
  });
  send(child, { method: 'notifications/initialized' });
  if (!settle) return { child, root, stdout: () => out, exited };
  // the index of an empty vault is ready at once; ask, so the writes below are not left waiting
  send(child, { id: 2, method: 'tools/call', params: { name: 'vault_list', arguments: {} } });
  await until(() => out.includes('"id":2'));
  return { child, root, stdout: () => out, exited };
}

function send(child: ChildProcess, message: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function burst(child: ChildProcess): void {
  for (let i = 0; i < WRITES; i += 1) {
    send(child, {
      id: 100 + i,
      method: 'tools/call',
      params: { name: 'vault_write', arguments: { path: `notes/n${i}.md`, content: `# n${i}\n` } },
    });
  }
}

async function notesOnDisk(root: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(root, 'notes'))).length;
  } catch {
    return 0;
  }
}

describe('stdio shutdown waits for the calls already running', () => {
  it('stdin ending right after a burst of writes loses none of them, and answers them', async () => {
    const s = await start();
    burst(s.child);
    s.child.stdin?.end();
    expect(await s.exited).toEqual({ code: 0, signal: null });
    expect(await notesOnDisk(s.root)).toBe(WRITES);
    const answered = s
      .stdout()
      .split('\n')
      .filter((line) => /"id":1\d\d\b/.test(line)).length;
    expect(answered).toBe(WRITES);
  }, 30_000);

  it('a client that sends everything and closes the pipe at once is served in full', async () => {
    const s = await start({ settle: false });
    burst(s.child);
    s.child.stdin?.end();
    expect(await s.exited).toEqual({ code: 0, signal: null });
    expect(await notesOnDisk(s.root)).toBe(WRITES);
    expect(s.stdout()).toMatch(/"id":1\b/);
    expect(s.stdout()).toMatch(/"id":129\b/);
  }, 30_000);

  it('a call still waiting for the index when the server stops is answered, not dropped', async () => {
    const s = await start({ settle: false, slowNotes: 400 }); // a 20 s fill
    send(s.child, { id: 7, method: 'tools/call', params: { name: 'vault_list', arguments: {} } });
    const started = performance.now();
    s.child.stdin?.end();
    expect(await s.exited).toEqual({ code: 0, signal: null });
    expect(performance.now() - started).toBeLessThan(6_000);
    const answer = s
      .stdout()
      .split('\n')
      .find((line) => line.includes('"id":7'));
    expect(answer).toContain('SHUTTING_DOWN');
  }, 30_000);

  it('SIGTERM right after a burst of writes leaves no note half-written', async () => {
    const s = await start();
    burst(s.child);
    // the calls are in the pipe, not necessarily read yet: whatever was started must finish
    await until(() => s.stdout().includes('"id":100'));
    s.child.kill('SIGTERM');
    expect(await s.exited).toEqual({ code: 0, signal: null });
    const dir = path.join(s.root, 'notes');
    for (const name of await fs.readdir(dir)) {
      expect(name).toMatch(/^n\d+\.md$/); // no temp file left behind
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toMatch(/^# n\d+\n$/);
    }
  }, 30_000);

  it('a broken stderr pipe does not turn a clean stop into a crash', async () => {
    const s = await start();
    s.child.stderr?.destroy();
    s.child.kill('SIGTERM');
    expect(await s.exited).toEqual({ code: 0, signal: null });
  }, 30_000);
});
