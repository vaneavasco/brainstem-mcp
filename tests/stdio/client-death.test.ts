// FINDING 1 (review21): a client that dies with calls in flight left the stdio server orphaned.
// Cause: on a stdout write error (EPIPE and friends) the SDK's StdioServerTransport closes itself
// and pauses stdin — so stdin's own 'end' event never fires — and src/stdio-main.ts listened only
// for 'end' plus the process signals. These tests reproduce both routes to that dead end: the
// process on the other side of the pipes dying outright (SIGKILL), and the client's reader dying
// while its writer stays open (a crashed reader, stdin never closed).
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testStateHome } from '../helpers/state-home.ts';

const STDIO_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');
const BUSY_RELAY = path.resolve(import.meta.dirname, 'helpers', 'busy-relay.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls (never a fixed sleep) until `pid` is gone, up to `timeoutMs`; returns whether it's gone. */
async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

async function waitForText(
  read: () => string,
  predicate: (text: string) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(read())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for output; got: ${read()}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const cleanupPids: number[] = [];
const cleanupRoots: string[] = [];
const cleanupChildren: ChildProcess[] = [];
const cleanupStateHomes: string[] = [];

afterEach(async () => {
  for (const child of cleanupChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  for (const pid of cleanupPids.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  for (const root of cleanupRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  for (const dir of cleanupStateHomes.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('a client that dies with calls in flight does not orphan the server', () => {
  /**
   * Whether the SIGKILL actually lands while the server is mid-write (the EPIPE route) or lands
   * in a gap where stdin's own 'end' would have fired anyway is a race — the adversarial review
   * measured roughly half of individual runs orphaning the unpatched server. A single run is not
   * a reliable regression check either way, so this repeats the reproduction several times and
   * requires zero orphans across all of them (the fix removes the race entirely: every trigger —
   * stdout error, stdin close, stdin end — now leads to the same idempotent shutdown).
   */
  it('SIGKILLing the client process makes the server process exit on its own, every time', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-clientdeath-'));
    cleanupRoots.push(root);
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(root, `n${i}.md`), `---\nn: ${i}\n---\nbody ${i}`);
    }

    const ATTEMPTS = 8;
    let orphaned = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const stateHome = testStateHome();
      cleanupStateHomes.push(stateHome);
      const relay = spawn(process.execPath, [BUSY_RELAY, STDIO_MAIN, root], {
        env: { ...process.env, BRAINSTEM_STATE_HOME: stateHome },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      cleanupChildren.push(relay);

      const serverPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('relay never reported CHILD_PID')), 8000);
        relay.stdout.on('data', (d: Buffer) => {
          const m = /CHILD_PID (\d+)/.exec(d.toString());
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
      });
      cleanupPids.push(serverPid);
      expect(isAlive(serverPid)).toBe(true);

      // Let several tool calls actually get in flight before the client dies mid-conversation;
      // stagger the delay so the kill lands at a different point in the request/response cycle
      // each attempt (the same trick review21/t13-clientdeath.ts uses).
      await new Promise((r) => setTimeout(r, 300 + attempt * 40));
      relay.kill('SIGKILL');

      const gone = await waitUntilGone(serverPid, 2500);
      if (!gone) {
        orphaned += 1;
        process.kill(serverPid, 'SIGKILL'); // clean up this attempt before the next one
      }
    }
    expect(orphaned, `${orphaned} of ${ATTEMPTS} attempts left the server orphaned`).toBe(0);
  }, 60_000);

  /**
   * The deterministic half of the reproduction (review21/t11-pipe.ts, "stdout reader gone, stdin
   * open"): destroying only the client's *read* side reliably triggers the EPIPE the moment the
   * server next tries to answer — no signal-delivery race involved — and, unpatched, the server
   * stayed alive even 5 s later with stdin never closed at all.
   */
  it('a crashed reader (stdout destroyed, stdin left open) exits the server within 5 s', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-brokenreader-'));
    cleanupRoots.push(root);
    const stateHome = testStateHome();
    cleanupStateHomes.push(stateHome);

    const child = spawn(process.execPath, [STDIO_MAIN, '--vault', root], {
      env: { ...process.env, BRAINSTEM_STATE_HOME: stateHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanupChildren.push(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error('child has no pid');

    let stderrText = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrText += d.toString();
    });
    await waitForText(
      () => stderrText,
      (t) => t.includes('stdio server ready'),
    );

    const gotResponse = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'broken-reader', version: '0' },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    await gotResponse;

    // Simulate a crashed reader on the client side: the server's stdout is no longer read...
    child.stdout.destroy();
    await new Promise((r) => setTimeout(r, 200));
    // ...yet the client keeps writing for a while (a busy client does not always notice at once);
    // stdin is deliberately never closed — the point is that the EPIPE alone must be enough.
    for (let i = 0; i < 5; i += 1) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: { name: 'vault_list', arguments: {} },
        })}\n`,
      );
    }

    const gone = await waitUntilGone(pid, 5000);
    expect(gone).toBe(true);
  }, 10_000);
});

describe('stopping while the index is still being built', () => {
  const SLOW_CHILD_ENTRY = path.resolve(import.meta.dirname, 'helpers', 'slow-child-entry.ts');

  async function startSlow(): Promise<{
    child: ReturnType<typeof spawn>;
    root: string;
    stateHome: string;
    err: () => string;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-stdio-stop-'));
    const stateHome = testStateHome();
    await Promise.all(
      Array.from({ length: 400 }, (_, i) => fs.writeFile(path.join(root, `n${i}.md`), `# n${i}\n`)),
    );
    // 20 batches x 1 s: the fill would take 20 s if nothing stopped it
    const child = spawn(process.execPath, [SLOW_CHILD_ENTRY, '--vault', root], {
      stdio: 'pipe',
      env: {
        ...process.env,
        BRAINSTEM_TEST_SLOW_BATCH_MS: '1000',
        BRAINSTEM_STATE_HOME: stateHome,
      },
    });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    await waitForText(
      () => err,
      (t) => t.includes('stdio server ready'),
    );
    return { child, root, stateHome, err: () => err };
  }

  for (const how of ['SIGTERM', 'stdin end'] as const) {
    it(`${how} during the fill exits 0 within 3 s`, async () => {
      const { child, root, stateHome, err } = await startSlow();
      try {
        const started = Date.now();
        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        if (how === 'SIGTERM') child.kill('SIGTERM');
        else child.stdin?.end();
        const code = await exited;
        expect(code, err()).toBe(0);
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(err()).not.toContain('shutdown did not finish in time');
      } finally {
        child.kill('SIGKILL');
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(stateHome, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
